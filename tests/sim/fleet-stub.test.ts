import { describe, expect, it } from 'vitest';
import { Lane } from '@better-compute/protocol';
import {
  GatewayStub,
  assertInvariants,
  checkI1,
  checkI5,
  createFleetSim,
  fakeGpuReset,
  isTerminal,
  type FleetSim,
  type FleetSimOptions,
  type GatewayPort,
} from '@better-compute/testing';

// The deterministic fleet simulator (PLAN.md §15) with the in-memory gateway stub: FakeDaemons over
// faulty links, chaos (crashes, reboots, journal loss, partitions, half-open links, resets, stalls,
// gateway kills), and the invariant checkers I1, I2, I5 and I8. The real gateway session core
// replaces the stub through `GatewayPort`.

const MIN = 60_000;

/** Commands and bookings at a steady rate, from the sim's own seeded stream. */
function workload(sim: FleetSim): () => void {
  const stub = sim.stub!;
  const rng = sim.rng.fork('workload');
  return sim.every(2_000, (now) => {
    for (let i = 0; i < 3; i++) {
      const nodeId = rng.pick(sim.nodeIds);
      const draw = rng.next();
      if (draw < 0.45) stub.enqueue(nodeId, 'diag.nvml', { expectedGpuCount: 8 });
      else if (draw < 0.65) stub.enqueue(nodeId, 'inventory.refresh', { sections: ['gpus'] });
      else if (draw < 0.8)
        stub.enqueue(nodeId, 'logs.collect', {
          uploadUrl: `https://objects.example/${nodeId}/${now}`,
        });
      else if (draw < 0.96) {
        const gpu = stub.freeGpus(nodeId)[0];
        if (gpu) stub.enqueue(nodeId, 'gpu.reset', { gpuUuids: [gpu] });
      } else stub.enqueue(nodeId, 'node.reboot', { reason: 'workload', delayMs: 500 });
    }
    const nodeId = rng.pick(sim.nodeIds);
    const free = stub.freeGpus(nodeId);
    if (free.length >= 2 && rng.chance(0.7))
      stub.book({
        nodeId,
        deviceIds: free.slice(0, rng.range(1, 2)),
        durationMs: rng.range(30_000, 5 * MIN),
      });
    const active = [...stub.allocations.values()].filter((a) => a.state === 'active');
    if (active.length > 0 && rng.chance(0.3))
      stub.release(rng.pick(active).allocationId, 'release');
  });
}

const chaotic = (seed: string, nodes = 100): FleetSimOptions => ({
  seed,
  nodes,
  daemon: { kinds: { 'gpu.reset': fakeGpuReset } },
  up: { latencyMs: 5, jitterMs: 20, drop: 0.0005, dropMode: 'reset', duplicate: 0.01 },
  down: {
    latencyMs: 5,
    jitterMs: 20,
    drop: 0.0005,
    dropMode: 'reset',
    duplicate: 0.01,
    reorder: 0.002,
  },
  chaos: {
    everyMs: 5_000,
    crash: 0.3,
    reboot: 0.1,
    journalLoss: 0.05,
    partition: 0.3,
    isolate: 0.1,
    halfOpen: 0.1,
    reset: 0.2,
    stall: 0.2,
    gatewayKill: 0.02,
  },
});

/** Stops the workload and chaos, heals everything and lets the sweeper and replays settle. */
async function settle(sim: FleetSim, stopWorkload: () => void): Promise<void> {
  stopWorkload();
  sim.quiesce();
  await sim.run(16 * MIN);
}

describe('fleet sim against the gateway stub', () => {
  it('100 daemons under drops, partitions, crashes, reboots and journal loss keep I1, I2, I5 and I8', async () => {
    const sim = createFleetSim(chaotic('fleet-100'));
    const stub = sim.stub!;
    await sim.start();
    const stop = workload(sim);
    await sim.run(20 * MIN);
    await settle(sim, stop);
    stub.flushUsage();

    assertInvariants(sim.invariants({ flushedUpTo: sim.scheduler.now() }));

    // The chaos really happened.
    const log = (event: string) => sim.log.find(event, 'sim').length;
    expect(log('crash')).toBeGreaterThan(10);
    expect(log('reboot')).toBeGreaterThan(3);
    expect(log('journal-loss')).toBeGreaterThan(1);
    expect(log('gateway.kill')).toBeGreaterThan(0);
    expect(sim.facts.journalLosses.length).toBeGreaterThan(1);
    const commands = [...stub.commands.values()];
    expect(commands.length).toBeGreaterThan(1_000);
    expect(
      commands.some((c) => c.errorCode === 'journal-lost' || c.errorCode === 'interrupted'),
    ).toBe(true);
    expect(commands.some((c) => c.rebooted)).toBe(true);

    // Liveness after the quiet period: everything terminal, every node back and converged.
    expect(commands.filter((c) => !isTerminal(c.state))).toEqual([]);
    for (const daemon of sim.daemons) {
      expect(daemon.state).toBe('running');
      expect(daemon.welcomed).toBe(true);
      const node = stub.nodes.get(daemon.nodeId)!;
      expect(node.connectivity).toBe('connected');
      expect(daemon.appliedGeneration).toBe(node.generation);
      const wanted = [...stub.allocations.values()]
        .filter((a) => a.nodeId === daemon.nodeId && a.state === 'active')
        .map((a) => a.allocationId)
        .sort();
      expect(daemon.boundAllocations()).toEqual(wanted);
    }
    // Only protocol noise the faults themselves cause (a duplicated Hello).
    expect(stub.problems.filter((p) => !p.includes('second Hello'))).toEqual([]);
  });

  it('is reproducible: the same seed gives the same event log, another seed does not', async () => {
    const run = async (seed: string) => {
      const sim = createFleetSim(chaotic(seed));
      await sim.start();
      const stop = workload(sim);
      await sim.run(4 * MIN);
      stop();
      return { digest: sim.digest(), lines: sim.log.lines(), size: sim.log.size };
    };
    const first = await run('repro');
    const again = await run('repro');
    expect(first.size).toBeGreaterThan(5_000);
    expect(again.digest).toBe(first.digest);
    expect(again.lines).toEqual(first.lines);
    expect((await run('repro-2')).digest).not.toBe(first.digest);
  });

  it('an async gateway port stays deterministic (the stub behind awaits gives the same log)', async () => {
    const run = async (async: boolean) => {
      const sim = createFleetSim({
        seed: 'port',
        nodes: 10,
        ...(async
          ? {
              gateway: ({ scheduler, log }) => {
                const stub = new GatewayStub({ scheduler, log });
                const port: GatewayPort & { stub: GatewayStub } = {
                  stub,
                  async accept(conn, peer) {
                    await Promise.resolve();
                    stub.accept(conn, peer);
                  },
                  async tick(now) {
                    await new Promise<void>((resolve) => setImmediate(resolve));
                    stub.tick(now);
                  },
                  facts: () => stub.facts(),
                };
                return port;
              },
            }
          : {}),
      });
      await sim.start();
      const stub = sim.stub ?? (sim.gateway as unknown as { stub: GatewayStub }).stub;
      sim.every(3_000, () => stub.enqueue(sim.nodeIds[0]!, 'diag.nvml'));
      await sim.run(2 * MIN);
      return sim.digest();
    };
    expect(await run(true)).toBe(await run(false));
  });
});

describe('protocol scenarios (§15)', () => {
  async function small(options: Partial<FleetSimOptions> = {}) {
    const sim = createFleetSim({
      seed: 'scenario',
      nodes: 3,
      startSpreadMs: 0,
      daemon: { kinds: { 'gpu.reset': fakeGpuReset } },
      ...options,
    });
    await sim.start();
    await sim.run(1_000);
    return { sim, stub: sim.stub!, nodeId: sim.nodeIds[0]!, daemon: sim.daemons[0]! };
  }

  it('gateway kill mid-command: reconnect with a new epoch, the result arrives once, nothing runs twice', async () => {
    const { sim, stub, nodeId, daemon } = await small();
    const command = stub.enqueue(nodeId, 'diag.nvml');
    await sim.run(500);
    expect(command.state).toBe('running');
    const epoch = stub.nodes.get(nodeId)!.epoch;
    sim.killGateway(10_000);
    await sim.run(60_000);
    expect(command.state).toBe('succeeded');
    expect(stub.nodes.get(nodeId)!.epoch).toBeGreaterThan(epoch);
    expect(daemon.executions.get(command.id)).toBe(1);
    expect(daemon.journal.command(command.id)?.resultAcked).toBe(true);
    assertInvariants(sim.invariants());
  });

  it('journal loss: in-flight non-retry-safe commands fail journal-lost and are never replayed', async () => {
    const { sim, stub, nodeId, daemon } = await small({
      daemon: { kinds: { 'gpu.reset': fakeGpuReset }, workers: { [Lane.CONTROL]: 1 } },
    });
    const [g0, g1] = stub.gpus(nodeId);
    const running = stub.enqueue(nodeId, 'gpu.reset', { gpuUuids: [g0!] });
    const queued = stub.enqueue(nodeId, 'gpu.reset', { gpuUuids: [g1!] });
    const retrySafe = stub.enqueue(nodeId, 'diag.nvml');
    await sim.run(500);
    expect([running.state, queued.state, retrySafe.state]).toEqual(['running', 'acked', 'acked']);
    sim.loseJournal(nodeId, 5_000);
    await sim.run(30_000);
    expect(running).toMatchObject({ state: 'failed', errorCode: 'journal-lost' });
    expect(queued).toMatchObject({ state: 'failed', errorCode: 'journal-lost' });
    expect(retrySafe.state).toBe('succeeded');
    expect(daemon.executions.get(running.id)).toBe(1);
    expect(daemon.executions.get(queued.id)).toBeUndefined();
    expect(daemon.executions.get(retrySafe.id)).toBe(1);
    assertInvariants(sim.invariants());
  });

  it('a control plane that replays after a journal loss is caught (I2)', async () => {
    const { sim, stub, nodeId, daemon } = await small({ stub: { skipJournalLostRule: true } });
    const reset = stub.enqueue(nodeId, 'gpu.reset', { gpuUuids: [stub.gpus(nodeId)[0]!] });
    await sim.run(500);
    sim.loseJournal(nodeId, 5_000);
    await sim.run(30_000);
    expect(daemon.executions.get(reset.id)).toBe(2);
    const violations = sim.invariants().filter((v) => v.invariant === 'I2');
    expect(new Set(violations.map((v) => v.subject))).toEqual(new Set([reset.id]));
    const messages = violations.map((v) => v.message).join('\n');
    expect(messages).toMatch(/not retry-safe\) started 2 times/);
    expect(messages).toMatch(/was in flight when journal jrn_\w+ was lost and replayed in jrn_/);
    expect(messages).toMatch(/control plane recorded it succeeded/);
  });

  it('daemon killed between side effect and ack: the result is replayed from the journal, not re-run', async () => {
    const { sim, stub, nodeId, daemon } = await small();
    const command = stub.enqueue(nodeId, 'diag.nvml');
    // Drop the terminal update on the wire, then crash before any Ack.
    sim.link(nodeId)!.control.intercept('a->b', (frame) => {
      const msg = (frame as { msg: { case?: string; value?: { state?: number } } }).msg;
      return msg.case === 'update' && msg.value?.state === 5 ? 'drop' : undefined;
    });
    await sim.run(2_500);
    expect(command.state).toBe('running');
    sim.crash(nodeId, 3_000);
    await sim.run(10_000);
    expect(command.state).toBe('succeeded');
    expect(daemon.executions.get(command.id)).toBe(1);
  });

  it('node.reboot completes on rejoin (SUCCEEDED{rebooted}) and is never replayed', async () => {
    const { sim, stub, nodeId, daemon } = await small({ daemon: { rebootDurationMs: 20_000 } });
    const boot = daemon.bootId;
    const command = stub.enqueue(nodeId, 'node.reboot', { delayMs: 1_000 });
    await sim.run(40_000);
    expect(command).toMatchObject({ state: 'succeeded', rebooted: true });
    expect(daemon.bootId).not.toBe(boot);
    expect(daemon.executions.get(command.id)).toBe(1);
    assertInvariants(sim.invariants());
  });

  it('BUSY sends a command back to pending with back-off until a credit frees', async () => {
    const { sim, stub, nodeId, daemon } = await small({
      stub: { grantCredits: { [Lane.CONTROL]: 1 } },
    });
    const commands = Array.from({ length: 4 }, () => stub.enqueue(nodeId, 'diag.nvml'));
    await sim.run(60_000);
    expect(commands.map((c) => c.state)).toEqual([
      'succeeded',
      'succeeded',
      'succeeded',
      'succeeded',
    ]);
    expect(commands.some((c) => c.busyCount > 0)).toBe(true);
    for (const c of commands) expect(daemon.executions.get(c.id)).toBe(1);
    expect(sim.log.find('command.busy').length).toBeGreaterThan(0);
  });

  it('a patch against a missed generation is answered with a full spec', async () => {
    const { sim, stub, nodeId, daemon } = await small({ stub: { specMode: 'patch' } });
    const [g0, g1] = stub.gpus(nodeId);
    sim
      .link(nodeId)!
      .control.intercept('b->a', (frame) =>
        (frame as { msg: { case?: string } }).msg.case === 'desired' &&
        stub.nodes.get(nodeId)!.generation === 1
          ? 'drop'
          : undefined,
      );
    stub.book({ nodeId, deviceIds: [g0!] });
    stub.book({ nodeId, deviceIds: [g1!] });
    await sim.run(1_000);
    expect(sim.log.find('spec.requested').length).toBe(1);
    expect(daemon.appliedGeneration).toBe(2);
    expect(daemon.boundAllocations()).toHaveLength(2);
  });

  it('disconnects release nothing (I5), and a gateway that does is caught', async () => {
    const good = await small();
    good.stub.book({ nodeId: good.nodeId, deviceIds: good.stub.gpus(good.nodeId).slice(0, 2) });
    await good.sim.run(1_000);
    expect(good.daemon.boundAllocations()).toHaveLength(1);
    good.sim.isolate(good.nodeId);
    await good.sim.run(5 * MIN);
    expect(good.stub.nodes.get(good.nodeId)!.connectivity).toBe('unreachable');
    expect([...good.stub.allocations.values()].map((a) => a.state)).toEqual(['active']);
    expect(good.daemon.boundAllocations()).toHaveLength(1);
    assertInvariants(good.sim.invariants());

    const bad = await small({ stub: { releaseOnDisconnect: true } });
    bad.stub.book({ nodeId: bad.nodeId, deviceIds: bad.stub.gpus(bad.nodeId).slice(0, 2) });
    bad.sim.isolate(bad.nodeId);
    await bad.sim.run(2 * MIN);
    const facts = bad.sim.gatewayFacts()!;
    const violations = checkI5({ releases: facts.releases, connectivity: facts.connectivity });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.message).toMatch(/while node .* was disconnected/);
  });

  it('a placer that ignores exclusion is caught (I1), and the daemon refuses the overlap on the node', async () => {
    const { sim, stub, nodeId, daemon } = await small();
    const [g0] = stub.gpus(nodeId);
    expect(stub.book({ nodeId, deviceIds: [g0!] })).toBeDefined();
    expect(stub.book({ nodeId, deviceIds: [g0!] })).toBeUndefined();
    const forced = stub.book({ nodeId, deviceIds: [g0!], force: true })!;
    await sim.run(1_000);
    expect(daemon.boundAllocations()).toHaveLength(1);
    expect(stub.nodes.get(nodeId)!.allocationFailures.get(forced.allocationId)).toBe('overlap');
    const facts = sim.gatewayFacts()!;
    const violations = checkI1({ bookings: facts.bookings, bindings: sim.facts.bindings });
    expect(violations.map((v) => v.subject)).toEqual([forced.allocationId]);
    expect(violations[0]!.message).toMatch(/is booked by/);
  });
});
