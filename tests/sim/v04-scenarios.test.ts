import { afterEach, describe, expect, it } from 'vitest';
import {
  assertInvariants,
  createControlPlaneSim,
  summarize,
  type ControlPlaneSim,
} from '@better-compute/testing';
import { manualClock } from '@better-compute/core';
import {
  buildReleaseManifest,
  createReleaseSigningKey,
  releaseArtifact,
  signReleaseManifest,
  spkiPin,
} from '@better-compute/pki';
import { provisionModule } from '@better-compute/provision';
import { rolloutModule } from '@better-compute/rollout';

// PLAN.md §15 v0.4 sim scenarios on the real control plane and three real gateways under the fleet simulator:
// - kill 1 of 3 gateways → reconnect in <60 s with 0 unreachable marks and 0 duplicate executions;
// - a zombie gateway (partitioned from the database) self-fences in <20 s;
// - a database failover and a 10-minute site partition release nothing;
// - an XID storm trips the remediation circuit breaker (one faulty node is rebooted; a storm is left alone);
// - a bad daemon build halts its canary (a good one rolls out through every wave).
// Times are simulated. The invariants (I1 bookings, I2 executions, I5 no release on disconnect, I8 billing) are
// checked at the end of each.

const MIN = 60_000;

let rig: ControlPlaneSim | undefined;
afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

const nodeIds = (rig: ControlPlaneSim) => rig.nodes.map((node) => node.nodeId);

/** `node.unreachable` events published since `since` (simulated ms). */
async function unreachableMarks(rig: ControlPlaneSim, since: number) {
  const { rows } = await rig.database.query<{ node_id: string; time: string }>(
    `SELECT payload->'data'->>'nodeId' AS node_id, payload->>'time' AS time FROM outbox
      WHERE topic = 'node.unreachable'`,
  );
  return rows.filter((row) => Date.parse(row.time) >= since).map((row) => row.node_id);
}

async function connectivity(rig: ControlPlaneSim) {
  const { rows } = await rig.database.query<{ connectivity: string; count: number }>(
    `SELECT connectivity, count(*)::int AS count FROM nodes GROUP BY connectivity ORDER BY connectivity`,
  );
  return Object.fromEntries(rows.map((row) => [row.connectivity, Number(row.count)]));
}

async function commandStates(rig: ControlPlaneSim, ids: readonly string[]) {
  const { rows } = await rig.database.query<{ state: string }>(
    'SELECT state FROM commands WHERE id = ANY($1::text[])',
    [ids],
  );
  return rows.map((row) => row.state);
}

async function runCommands(rig: ControlPlaneSim, kind: string, tag: string) {
  const ids: string[] = [];
  for (const nodeId of nodeIds(rig)) {
    const command = await rig.api(() =>
      rig.compute.api.commands.run({ token: rig.tenants.root.token }, {
        tenantId: rig.tenants.root.id,
        nodeId,
        kind,
        ...(kind === 'inventory.refresh' ? { payload: { sections: ['gpus'] } } : {}),
        idempotencyKey: `${tag}-${nodeId}`,
      } as never),
    );
    ids.push(command.id);
  }
  return ids;
}

/** Books `count` half-nodes for acme (two hours, so they outlive the scenario) and waits until all are active. */
async function activeReservations(rig: ControlPlaneSim, count: number) {
  const ids: string[] = [];
  for (let index = 0; index < count; index++) {
    const reservation = await rig.api(() =>
      rig.compute.api.reservations.create({ token: rig.tenants.acme.token }, {
        tenantId: rig.tenants.acme.id,
        poolId: rig.poolId,
        devices: [{ class: 'gpu', count: 4 }],
        duration: '2h',
        idempotencyKey: `scenario-${index}`,
      } as never),
    );
    ids.push(reservation.id);
  }
  for (let waited = 0; waited < 3 * MIN; waited += 5_000) {
    if ((await reservationStates(rig, ids)).every((state) => state === 'active')) break;
    await rig.run(5_000);
  }
  expect(await reservationStates(rig, ids)).toEqual(ids.map(() => 'active'));
  return ids;
}

async function reservationStates(rig: ControlPlaneSim, ids: readonly string[]) {
  const { rows } = await rig.database.query<{ id: string; state: string }>(
    'SELECT id, state FROM reservations WHERE id = ANY($1::text[])',
    [ids],
  );
  const byId = new Map(rows.map((row) => [row.id, row.state]));
  return ids.map((id) => byId.get(id));
}

async function releasedAllocations(rig: ControlPlaneSim) {
  const { rows } = await rig.database.query<{ id: string }>(
    'SELECT id FROM allocations WHERE released_at IS NOT NULL',
  );
  return rows.map((row) => row.id);
}

describe('§15 v0.4 scenarios', () => {
  it('kill 1 of 3 gateways: every node reconnects in <60 s, 0 unreachable marks, 0 duplicate executions', async () => {
    rig = await createControlPlaneSim({ seed: 'v04-gateway-kill', nodes: 9, gateways: 3 });
    await rig.run(3 * MIN);
    expect(await connectivity(rig)).toEqual({ connected: 9 });

    const commands = await runCommands(rig, 'diag.nvml', 'kill');
    await rig.run(1_000);
    const killedAt = rig.sim.scheduler.now();
    const moved = rig.killGateway(0);
    expect(moved.length).toBeGreaterThan(0);
    const reconnected = new Map<string, number>();
    const seen = new Set<string>();
    while (rig.sim.scheduler.now() - killedAt < 3 * MIN) {
      await rig.run(1_000);
      for (const nodeId of moved) {
        const home = rig.homeOf(nodeId);
        if (!reconnected.has(nodeId) && home !== undefined && home !== 0)
          reconnected.set(nodeId, rig.sim.scheduler.now() - killedAt);
      }
      // Sampled every simulated second: no node is ever marked unreachable.
      for (const [state] of Object.entries(await connectivity(rig))) seen.add(state);
    }
    expect(reconnected.size).toBe(moved.length);
    const latency = summarize([...reconnected.values()]);
    expect(latency.max).toBeLessThan(60_000);
    expect(seen.has('unreachable')).toBe(false);
    expect(await unreachableMarks(rig, killedAt)).toEqual([]);
    expect(
      (await commandStates(rig, commands)).every(
        (state) => state === 'succeeded' || state === 'failed',
      ),
    ).toBe(true);
    assertInvariants(await rig.invariants());
    console.log(`gateway kill: reconnect ${JSON.stringify(latency)} (${moved.length} nodes)`);
  }, 600_000);

  it('a zombie gateway partitioned from the database self-fences in <20 s; its nodes move', async () => {
    rig = await createControlPlaneSim({ seed: 'v04-zombie', nodes: 9, gateways: 3 });
    await rig.run(3 * MIN);
    const zombie = rig.gateways[1]!;
    const stranded = nodeIds(rig).filter((nodeId) => rig!.homeOf(nodeId) === 1);
    expect(stranded.length).toBeGreaterThan(0);
    expect(zombie.status().leaseEpoch).not.toBeNull();

    const cutAt = rig.sim.scheduler.now();
    rig.cutGatewayDatabase(1, true);
    let fencedAfter: number | undefined;
    while (rig.sim.scheduler.now() - cutAt < MIN) {
      await rig.run(1_000);
      if (
        fencedAfter === undefined &&
        zombie.status().leaseEpoch === null &&
        zombie.sessions().length === 0
      )
        fencedAfter = rig.sim.scheduler.now() - cutAt;
    }
    expect(fencedAfter).toBeDefined();
    expect(fencedAfter!).toBeLessThan(20_000);
    expect(rig.outageErrors).toBeGreaterThan(0);
    // Its nodes are served by the other two while it stays cut off.
    for (const nodeId of stranded) expect([0, 2]).toContain(rig.homeOf(nodeId));

    // Healed, it takes its lease again and serves new dials; nothing ran twice meanwhile.
    rig.cutGatewayDatabase(1, false);
    await rig.run(MIN);
    expect(zombie.status().leaseEpoch).not.toBeNull();
    const commands = await runCommands(rig, 'inventory.refresh', 'after-zombie');
    await rig.run(MIN);
    expect(await commandStates(rig, commands)).toEqual(commands.map(() => 'succeeded'));
    assertInvariants(await rig.invariants());
    console.log(
      `zombie gateway self-fenced after ${fencedAfter} ms (${stranded.length} nodes moved)`,
    );
  }, 600_000);

  it('a database failover releases nothing, and everything resumes after it', async () => {
    rig = await createControlPlaneSim({ seed: 'v04-db-failover', nodes: 8, gateways: 3 });
    await rig.run(3 * MIN);
    const reservations = await activeReservations(rig, 6);
    const before = await releasedAllocations(rig);

    // The primary goes away for a minute: every process loses the database at once.
    const downAt = rig.sim.scheduler.now();
    rig.failDatabase(true);
    await rig.run(MIN);
    rig.failDatabase(false);
    expect(rig.outageErrors).toBeGreaterThan(0);
    await rig.run(3 * MIN);

    expect(await reservationStates(rig, reservations)).toEqual(reservations.map(() => 'active'));
    expect(await releasedAllocations(rig)).toEqual(before);
    expect(await connectivity(rig)).toEqual({ connected: 8 });
    const commands = await runCommands(rig, 'inventory.refresh', 'after-failover');
    await rig.run(MIN);
    expect(await commandStates(rig, commands)).toEqual(commands.map(() => 'succeeded'));
    assertInvariants(await rig.invariants());
    console.log(
      `database failover: ${rig.outageErrors} loop failures, ${(await unreachableMarks(rig, downAt)).length} unreachable marks`,
    );
  }, 600_000);

  it('an XID storm trips the breaker: one faulty node is remediated, a storm is not', async () => {
    rig = await createControlPlaneSim({
      seed: 'v04-xid-storm',
      nodes: 20,
      gateways: 3,
      modules: [provisionModule()],
    });
    await rig.run(3 * MIN);
    const ids = nodeIds(rig);
    const xid = (index: number) =>
      rig!.sim.daemon(ids[index]!).injectXid(rig!.nodes[index]!.hardware.gpuUuids[0]!, 79);
    const workflows = async (nodes: readonly string[]) => {
      const { rows } = await rig!.database.query<{ node_id: string; state: string }>(
        `SELECT node_id, state FROM workflows WHERE owner = 'health' AND node_id = ANY($1::text[])`,
        [nodes],
      );
      return rows;
    };
    const events = async (type: string) => {
      const { rows } = await rig!.database.query<{ node_id: string }>(
        `SELECT payload->'data'->>'nodeId' AS node_id FROM outbox WHERE topic = $1`,
        [type],
      );
      return rows.map((row) => row.node_id);
    };

    // One node (5% of the pool) faults: it is fenced from scheduling and rebooted, which clears the fault.
    xid(0);
    await rig.run(2 * MIN);
    expect(await events('node.remediation.started')).toEqual([ids[0]]);
    await rig.run(5 * MIN);
    expect((await workflows([ids[0]!])).map((row) => row.state)).toEqual(['succeeded']);
    expect(await events('node.remediation.succeeded')).toEqual([ids[0]]);

    // A storm: 6 more nodes (30%) report XID 79 at once. Rebooting them all would take out a third of the pool
    // for what is more likely a shared cause, so the breaker holds remediation for the pool.
    const storm = ids.slice(1, 7);
    for (let index = 1; index < 7; index++) xid(index);
    await rig.run(5 * MIN);
    expect(await workflows(storm)).toEqual([]);
    expect(new Set(await events('pool.remediation.paused')).size).toBeGreaterThan(0);
    const { rows: fenced } = await rig.database.query<{ id: string }>(
      `SELECT DISTINCT node_id AS id FROM node_conditions WHERE type = 'Xid79' AND status = 'true'`,
    );
    expect(fenced.map((row) => row.id).sort()).toEqual([...storm].sort());
    // Held back, not escalated: no node was put into maintenance.
    const { rows: maintenance } = await rig.database.query('SELECT 1 FROM nodes WHERE maintenance');
    expect(maintenance).toHaveLength(0);
    assertInvariants(await rig.invariants());
  }, 600_000);

  it('a bad daemon build halts its canary; a good one goes through every wave', async () => {
    const key = createReleaseSigningKey();
    const release = (version: string, sequence: number) =>
      signReleaseManifest(
        buildReleaseManifest({
          product: 'bcd',
          version,
          sequence,
          signers: [key],
          clock: manualClock(Date.UTC(2026, 0, 1)),
          artifacts: [
            releaseArtifact(
              `bcd_${version}_linux_amd64`,
              new TextEncoder().encode(`bcd ${version}`),
              'linux-amd64',
            ),
          ],
        }),
        [key],
      );
    rig = await createControlPlaneSim({
      seed: 'v04-canary',
      nodes: 20,
      gateways: 3,
      // Every daemon self-updates; the 0.3.0 build crashes on start and bcd falls back to its old slot.
      daemon: { selfUpdate: { badVersions: ['0.3.0'] } },
      modules: [
        rolloutModule({
          release: { pins: [spkiPin(key.publicKey)] },
          downloadsUrl: 'https://compute.sim.test/api/compute/downloads',
          every: '10s',
        }),
      ],
    });
    await rig.run(3 * MIN);
    const root = { token: rig.tenants.root.token };
    const api = rig.compute.api as unknown as Record<
      string,
      Record<string, (credential: unknown, input: unknown) => Promise<Record<string, unknown>>>
    >;
    for (const [version, sequence] of [
      ['0.2.0', 1],
      ['0.3.0', 2],
    ] as const)
      await rig.api(() =>
        api.releases!.register!(root, {
          tenantId: rig!.tenants.root.id,
          manifest: release(version, sequence),
        }),
      );
    const versions = async () => {
      const { rows } = await rig!.database.query<{ daemon_version: string; count: number }>(
        `SELECT daemon_version, count(*)::int AS count FROM node_sessions GROUP BY daemon_version ORDER BY 1`,
      );
      return Object.fromEntries(rows.map((row) => [row.daemon_version, Number(row.count)]));
    };
    const rollout = (version: string) =>
      rig!.api(() =>
        api.rollouts!.create!(root, {
          tenantId: rig!.tenants.root.id,
          version,
          waves: [5, 50, 100],
          soakSeconds: 60,
          upgradeTimeoutSeconds: 120,
          idempotencyKey: `rollout-${version}`,
        }),
      );
    const state = async (id: string) =>
      (await rig!.api(() =>
        api.rollouts!.get!(root, { tenantId: rig!.tenants.root.id, rolloutId: id }),
      )) as {
        state: string;
        wave: number;
        reason?: string;
        nodes: Record<string, number>;
      };
    const until = async (
      id: string,
      done: (rollout: Awaited<ReturnType<typeof state>>) => boolean,
    ) => {
      for (let waited = 0; waited < 30 * MIN; waited += 10_000) {
        if (done(await state(id))) break;
        await rig!.run(10_000);
      }
      return state(id);
    };
    expect(await versions()).toEqual({ '0.1.0': 20 });

    // A good build: canary (1 node), then half, then all, each wave soaking before the next.
    const good = await rollout('0.2.0');
    const finished = await until(good.id as string, (r) => r.state !== 'running');
    expect(finished.state).toBe('completed');
    expect(finished.nodes.succeeded).toBe(20);
    expect(await versions()).toEqual({ '0.2.0': 20 });

    // A bad build: the canary node's new slot crashes and it comes back on 0.2.0; the wave misses its
    // deadline, the failure gate pauses the rollout, and no node outside the canary is touched.
    const bad = await rollout('0.3.0');
    const halted = await until(bad.id as string, (r) => r.state !== 'running');
    expect(halted.state).toBe('paused');
    expect(halted.wave).toBe(0);
    expect(halted.reason).toMatch(/failure gate/);
    expect(halted.nodes.failed).toBe(1);
    expect(halted.nodes.upgrading ?? 0).toBe(0);
    expect(halted.nodes.succeeded ?? 0).toBe(0);
    await rig.run(2 * MIN);
    expect(await versions()).toEqual({ '0.2.0': 20 });
    assertInvariants(await rig.invariants());
  }, 600_000);

  it('a 10-minute site partition releases nothing; the nodes come back', async () => {
    rig = await createControlPlaneSim({ seed: 'v04-site-partition', nodes: 8, gateways: 3 });
    await rig.run(3 * MIN);
    const reservations = await activeReservations(rig, 6);
    const before = await releasedAllocations(rig);

    // The whole site drops off the network: links cut and dials refused for ten minutes.
    for (const nodeId of nodeIds(rig)) rig.sim.isolate(nodeId, 10 * MIN);
    await rig.run(10 * MIN);
    // They were given up on (unreachable) without anything being released.
    expect((await connectivity(rig)).connected ?? 0).toBe(0);
    expect(await reservationStates(rig, reservations)).toEqual(reservations.map(() => 'active'));
    expect(await releasedAllocations(rig)).toEqual(before);

    await rig.run(3 * MIN);
    expect(await connectivity(rig)).toEqual({ connected: 8 });
    expect(await reservationStates(rig, reservations)).toEqual(reservations.map(() => 'active'));
    expect(await releasedAllocations(rig)).toEqual(before);
    assertInvariants(await rig.invariants());
  }, 600_000);
});
