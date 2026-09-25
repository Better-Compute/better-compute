import { describe, expect, it } from 'vitest';
import { Lane } from '@better-compute/protocol';
import {
  assertInvariants,
  createFleetSim,
  fakeGpuReset,
  isTerminal,
  type FleetSim,
} from '@better-compute/testing';

// The v0.1 exit test tests/sim/faults-1k (PLAN.md §16): 1,000 FakeDaemons in the deterministic fleet simulator.
// Under chaos with a steady workload, and in three targeted fleet-wide scenarios: a gateway kill mid-command runs
// nothing twice; a journal loss fails in-flight non-retry-safe commands instead of replaying them; node.reboot
// completes on rejoin. I1, I2, I5 and I8 hold throughout.

const MIN = 60_000;
const NODES = 1_000;

/** Advances the sim in 30 s steps, yielding to the event loop between them (the test runner's RPC needs it). */
async function run(sim: FleetSim, ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 30_000) {
    await sim.run(Math.min(30_000, left));
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function fleet(seed: string, extra: Partial<Parameters<typeof createFleetSim>[0]> = {}): FleetSim {
  return createFleetSim({
    seed,
    nodes: NODES,
    logFrames: false,
    daemon: { kinds: { 'gpu.reset': fakeGpuReset }, rebootDurationMs: 20_000 },
    up: { latencyMs: 5, jitterMs: 20, drop: 0.0002, dropMode: 'reset', duplicate: 0.005 },
    down: {
      latencyMs: 5,
      jitterMs: 20,
      drop: 0.0002,
      dropMode: 'reset',
      duplicate: 0.005,
      reorder: 0.001,
    },
    ...extra,
  });
}

describe('faults at 1k nodes', () => {
  it('chaos with a steady workload keeps I1, I2, I5 and I8, and everything settles', async () => {
    const sim = fleet('faults-1k', {
      chaos: {
        everyMs: 1_000,
        crash: 0.3,
        reboot: 0.1,
        journalLoss: 0.05,
        partition: 0.3,
        isolate: 0.1,
        halfOpen: 0.1,
        reset: 0.2,
        stall: 0.2,
        gatewayKill: 0.005,
      },
    });
    const stub = sim.stub!;
    await sim.start();
    const rng = sim.rng.fork('workload');
    const stop = sim.every(1_000, (now) => {
      for (let i = 0; i < 10; i++) {
        const nodeId = rng.pick(sim.nodeIds);
        const draw = rng.next();
        if (draw < 0.5) stub.enqueue(nodeId, 'diag.nvml', { expectedGpuCount: 8 });
        else if (draw < 0.7) stub.enqueue(nodeId, 'inventory.refresh', { sections: ['gpus'] });
        else if (draw < 0.95) {
          const gpu = stub.freeGpus(nodeId)[0];
          if (gpu) stub.enqueue(nodeId, 'gpu.reset', { gpuUuids: [gpu] });
        } else stub.enqueue(nodeId, 'node.reboot', { reason: 'workload', delayMs: 500 });
      }
      for (let i = 0; i < 3; i++) {
        const nodeId = rng.pick(sim.nodeIds);
        const free = stub.freeGpus(nodeId);
        if (free.length >= 2)
          stub.book({ nodeId, deviceIds: free.slice(0, 2), durationMs: rng.range(MIN, 5 * MIN) });
      }
      const active = [...stub.allocations.values()].filter((a) => a.state === 'active');
      if (active.length > 0 && rng.chance(0.5))
        stub.release(rng.pick(active).allocationId, 'release');
      void now;
    });
    await run(sim, 6 * MIN);
    stop();
    sim.quiesce();
    await run(sim, 16 * MIN);
    stub.flushUsage();

    assertInvariants(sim.invariants({ flushedUpTo: sim.scheduler.now() }));
    const log = (event: string) => sim.log.find(event, 'sim').length;
    expect(log('crash')).toBeGreaterThan(30);
    expect(log('journal-loss')).toBeGreaterThan(3);
    expect(log('gateway.kill')).toBeGreaterThan(0);
    const commands = [...stub.commands.values()];
    expect(commands.length).toBeGreaterThan(3_000);
    expect(commands.filter((c) => !isTerminal(c.state))).toEqual([]);
    for (const daemon of sim.daemons) {
      expect(daemon.state).toBe('running');
      expect(stub.nodes.get(daemon.nodeId)!.connectivity).toBe('connected');
      expect(daemon.appliedGeneration).toBe(stub.nodes.get(daemon.nodeId)!.generation);
    }
  }, 600_000);

  it('a gateway kill mid-command, a journal loss and reboots, each across the fleet', async () => {
    const sim = fleet('faults-1k-targeted', {
      daemon: {
        kinds: { 'gpu.reset': fakeGpuReset },
        rebootDurationMs: 20_000,
        workers: { [Lane.CONTROL]: 1 },
      },
    });
    const stub = sim.stub!;
    await sim.start();
    await run(sim, MIN);

    // Every node runs a 2 s diag.nvml; the gateway dies while they run and is back 10 s later.
    const diags = sim.nodeIds.map((nodeId) => stub.enqueue(nodeId, 'diag.nvml'));
    await sim.run(500);
    expect(diags.filter((c) => c.state === 'running').length).toBeGreaterThan(NODES * 0.9);
    sim.killGateway(10_000);
    await run(sim, 2 * MIN);
    expect(diags.map((c) => c.state)).toEqual(diags.map(() => 'succeeded'));
    for (const [index, command] of diags.entries())
      expect(sim.daemons[index]!.executions.get(command.id)).toBe(1);

    // 100 nodes lose their journal with a gpu.reset running and another queued behind it (one control worker).
    const lossy = sim.nodeIds.slice(0, 100);
    const resets = lossy.map((nodeId) => {
      const [g0, g1] = stub.gpus(nodeId);
      return [
        stub.enqueue(nodeId, 'gpu.reset', { gpuUuids: [g0!] }),
        stub.enqueue(nodeId, 'gpu.reset', { gpuUuids: [g1!] }),
      ] as const;
    });
    await sim.run(500);
    for (const nodeId of lossy) sim.loseJournal(nodeId, 5_000);
    await run(sim, MIN);
    for (const [index, [running, queued]] of resets.entries()) {
      expect(running).toMatchObject({ state: 'failed', errorCode: 'journal-lost' });
      expect(queued).toMatchObject({ state: 'failed', errorCode: 'journal-lost' });
      const daemon = sim.daemon(lossy[index]!);
      expect(daemon.executions.get(running.id)).toBe(1);
      expect(daemon.executions.get(queued.id)).toBeUndefined();
    }

    // 200 nodes reboot through node.reboot: each completes as succeeded(rebooted) on rejoin, once.
    const rebooting = sim.nodeIds.slice(300, 500);
    const boots = rebooting.map((nodeId) => sim.daemon(nodeId).bootId);
    const reboots = rebooting.map((nodeId) =>
      stub.enqueue(nodeId, 'node.reboot', { delayMs: 1_000 }),
    );
    await run(sim, 2 * MIN);
    for (const [index, command] of reboots.entries()) {
      expect(command).toMatchObject({ state: 'succeeded', rebooted: true });
      const daemon = sim.daemon(rebooting[index]!);
      expect(daemon.bootId).not.toBe(boots[index]);
      expect(daemon.executions.get(command.id)).toBe(1);
    }

    sim.quiesce();
    await run(sim, 5 * MIN);
    stub.flushUsage();
    assertInvariants(sim.invariants({ flushedUpTo: sim.scheduler.now() }));
  }, 600_000);
});
