import { afterEach, describe, expect, it } from 'vitest';
import { xidStatusHandler } from '@better-compute/gateway';
import { ConditionStatus, InstanceObservedState, SectionState, type StatusReport } from '@better-compute/protocol';
import { agentFrame, gatewayFixture, type GatewayFixture } from './support/gateway.js';

// Status-driven health (§10.1) and session versions for Rollout (§6, v0.4) at the gateway.

let f: GatewayFixture;
afterEach(() => f.close());

const status = (generation: number, conditions: { type: string; deviceId?: string; message?: string }[]) =>
  agentFrame({
    case: 'status',
    value: {
      observedGeneration: BigInt(generation),
      appliedGeneration: BigInt(generation),
      conditions: conditions.map((condition) => ({ ...condition, status: ConditionStatus.TRUE })),
    },
  });

async function gpu(nodeId: string, id: string) {
  await f.db.query(
    `INSERT INTO devices (id, node_id, class, bookable, healthy, attributes) VALUES ($1, $2, 'gpu', true, true, '{}'::jsonb)`,
    [id, nodeId],
  );
}

describe('session versions', () => {
  it('stores Hello.daemon_version and proto_max on the session row', async () => {
    f = await gatewayFixture();
    const node = await f.addNode();
    await f.connect(node);
    expect(await f.session(node)).toMatchObject({ daemon_version: '0.1.0', proto_max: 1 });
  });

  it('records the trust version from Hello and from a status report that applied a newer bundle (§13)', async () => {
    f = await gatewayFixture();
    const node = await f.addNode();
    const trust = async () =>
      Number((await f.db.query<{ trust_version: string }>('SELECT trust_version FROM node_sessions WHERE node_id = $1', [node])).rows[0]!.trust_version);
    const { handle } = await f.connect(node, { trustVersion: 3n });
    expect(await trust()).toBe(3);

    // 0 is "unchanged"; a newer bundle is acked mid-session; an older number never lowers it.
    const report = (version: bigint) =>
      agentFrame({ case: 'status', value: { observedGeneration: 1n, appliedGeneration: 1n, trustVersion: version } });
    await handle.receive(report(0n));
    await f.gateway.jobs.status.tick();
    expect(await trust()).toBe(3);
    await handle.receive(report(5n));
    await f.gateway.jobs.status.tick();
    expect(await trust()).toBe(5);
    await handle.receive(report(4n));
    await f.gateway.jobs.status.tick();
    expect(await trust()).toBe(5);

    // A reconnect reports what the daemon holds now, even an older bundle (a restored disk).
    await f.connect(node, { trustVersion: 2n, bootId: 'boot-restored' });
    expect(await trust()).toBe(2);
  });

  it('records the approver set a daemon holds, NULL for none, and never pairs an old set with a newer version', async () => {
    f = await gatewayFixture();
    const node = await f.addNode();
    const held = async () =>
      (
        await f.db.query<{ trust_version: string; approver_set_epoch: string | null; approver_set_sha256: Uint8Array | null }>(
          'SELECT trust_version, approver_set_epoch, approver_set_sha256 FROM node_sessions WHERE node_id = $1',
          [node],
        )
      ).rows[0]!;
    const setA = new Uint8Array(32).fill(0xa);
    const setB = new Uint8Array(32).fill(0xb);
    // No set held: both NULL, so "no quorum" differs from any digest.
    await f.connect(node, { trustVersion: 3n });
    expect(await held()).toMatchObject({ approver_set_epoch: null, approver_set_sha256: null });
    const { handle } = await f.connect(node, { bootId: 'boot-2', trustVersion: 3n, approverSetEpoch: 1n, approverSetSha256: setA });
    expect(Number((await held()).approver_set_epoch)).toBe(1);
    expect(Buffer.from((await held()).approver_set_sha256!).equals(Buffer.from(setA))).toBe(true);

    const report = (version: bigint, epoch: bigint, digest: Uint8Array) =>
      agentFrame({
        case: 'status',
        value: { observedGeneration: 1n, appliedGeneration: 1n, trustVersion: version, approverSetEpoch: epoch, approverSetSha256: digest },
      });
    // A newer bundle with a new set: both move.
    await handle.receive(report(5n, 2n, setB));
    await f.gateway.jobs.status.tick();
    expect(Number((await held()).trust_version)).toBe(5);
    expect(Number((await held()).approver_set_epoch)).toBe(2);
    // A late report from an older bundle changes neither.
    await handle.receive(report(4n, 1n, setA));
    await f.gateway.jobs.status.tick();
    expect(Number((await held()).approver_set_epoch)).toBe(2);
    expect(Buffer.from((await held()).approver_set_sha256!).equals(Buffer.from(setB))).toBe(true);
  });

  it('stores Hello.capabilities as-is from each Hello, dropping malformed names', async () => {
    f = await gatewayFixture();
    const node = await f.addNode();
    const capabilities = async () =>
      (await f.db.query<{ capabilities: string[] }>('SELECT capabilities FROM node_sessions WHERE node_id = $1', [node])).rows[0]!
        .capabilities;
    await f.connect(node, {
      capabilities: ['tunnel.instance-dial', 'Bad Name', 'tunnel.instance-dial', 'x'.repeat(65), 'logs.collect'],
    });
    expect(await capabilities()).toEqual(['logs.collect', 'tunnel.instance-dial']);
    // A daemon that stops advertising a capability loses it at its next Hello.
    await f.connect(node, { bootId: 'boot-2' });
    expect(await capabilities()).toEqual([]);
  });
});

describe('xidStatusHandler', () => {
  it('quarantines the GPU, makes the node NoSchedule and queues health for a known XID', async () => {
    f = await gatewayFixture({ reports: { status: xidStatusHandler } });
    const node = await f.addNode();
    await gpu(node, 'GPU-a');
    await gpu(node, 'GPU-b');
    const { handle } = await f.connect(node);
    await handle.receive(status(1, [{ type: 'Xid79', deviceId: 'GPU-a', message: 'fell off the bus' }, { type: 'DriverMismatch' }]));
    await f.gateway.jobs.status.tick();

    const { rows: devices } = await f.db.query('SELECT id, healthy FROM devices WHERE node_id = $1 ORDER BY id', [node]);
    expect(devices).toEqual([
      { id: 'GPU-a', healthy: false },
      { id: 'GPU-b', healthy: true },
    ]);
    const { rows: nodes } = await f.db.query('SELECT no_schedule_reasons, observed_generation FROM nodes WHERE id = $1', [node]);
    expect(nodes[0]).toMatchObject({ no_schedule_reasons: ['Xid79'], observed_generation: 1 });
    const { rows: work } = await f.db.query(`SELECT key FROM work_queue WHERE kind = 'health'`);
    expect(work).toEqual([{ key: node }]);

    // The same condition in the next report changes nothing.
    await handle.receive(status(2, [{ type: 'Xid79', deviceId: 'GPU-a' }]));
    await f.gateway.jobs.status.tick();
    const { rows: health } = await f.db.query('SELECT device_id FROM device_health');
    expect(health).toEqual([{ device_id: 'GPU-a' }]);
  });

  it('records host pressure from the same status report (§10.1), publishing each change once', async () => {
    f = await gatewayFixture({ reports: { status: xidStatusHandler } });
    const node = await f.addNode();
    const { handle } = await f.connect(node);
    const pressured = (generation: number, pressure: Record<string, number>) =>
      agentFrame({
        case: 'status',
        value: {
          observedGeneration: BigInt(generation),
          appliedGeneration: BigInt(generation),
          pressure: { cpuSomeAvg10: 1, memorySomeAvg10: 0, ioSomeAvg10: 2, stealPct: 0, ...pressure },
        },
      });
    const conditions = async () =>
      (
        await f.db.query<{ type: string; status: string }>(
          `SELECT type, status FROM node_conditions WHERE node_id = $1 AND type LIKE '%Pressure' ORDER BY type`,
          [node],
        )
      ).rows;
    await handle.receive(pressured(1, { memorySomeAvg10: 35 }));
    await f.gateway.jobs.status.tick();
    expect(await conditions()).toEqual([{ type: 'MemoryPressure', status: 'true' }]);
    expect(await f.outbox('node.condition.changed')).toHaveLength(1);

    // Unchanged pressure writes and publishes nothing more; settling clears it.
    await handle.receive(pressured(2, { memorySomeAvg10: 35 }));
    await f.gateway.jobs.status.tick();
    expect(await f.outbox('node.condition.changed')).toHaveLength(1);
    await handle.receive(pressured(3, { memorySomeAvg10: 1 }));
    await f.gateway.jobs.status.tick();
    expect(await conditions()).toEqual([{ type: 'MemoryPressure', status: 'false' }]);
    expect(await f.outbox('node.condition.changed')).toHaveLength(2);
  });

  it('follows the host units’ conditions (FabricManagerDown, MPSDown): written on a change, NoSchedule while true', async () => {
    f = await gatewayFixture({ reports: { status: xidStatusHandler } });
    const node = await f.addNode();
    const { handle } = await f.connect(node);
    const state = async () => ({
      conditions: (
        await f.db.query<{ type: string; status: string }>(
          `SELECT type, status FROM node_conditions WHERE node_id = $1 AND type IN ('FabricManagerDown', 'MPSDown') ORDER BY type`,
          [node],
        )
      ).rows,
      reasons: (await f.db.query<{ no_schedule_reasons: string[] }>('SELECT no_schedule_reasons FROM nodes WHERE id = $1', [node]))
        .rows[0]!.no_schedule_reasons,
    });
    const report = async (generation: number, types: string[]) => {
      await handle.receive(status(generation, types.map((type) => ({ type, message: `${type} here` }))));
      await f.gateway.jobs.status.tick();
    };
    await report(1, ['FabricManagerDown', 'SomethingElse']);
    expect(await state()).toEqual({ conditions: [{ type: 'FabricManagerDown', status: 'true' }], reasons: ['FabricManagerDown'] });
    expect(await f.outbox('node.condition.changed')).toHaveLength(1);
    // Repeated: nothing written, nothing published.
    await report(2, ['FabricManagerDown']);
    expect(await f.outbox('node.condition.changed')).toHaveLength(1);
    // Fabric Manager back, MPS down.
    await report(3, ['MPSDown']);
    expect(await state()).toEqual({
      conditions: [
        { type: 'FabricManagerDown', status: 'false' },
        { type: 'MPSDown', status: 'true' },
      ],
      reasons: ['MPSDown'],
    });
    expect(await f.outbox('node.condition.changed')).toHaveLength(3);
    await report(4, []);
    expect((await state()).reasons).toEqual([]);

    // An externally managed host (bcd as a DaemonSet): a condition, never NoSchedule.
    await handle.receive(
      agentFrame({
        case: 'status',
        value: {
          observedGeneration: 5n,
          appliedGeneration: 5n,
          sections: [{ section: 'host', generation: 5n, state: SectionState.UNSUPPORTED, reason: 'HostManagedExternally', message: 'managed outside bcd' }],
        },
      }),
    );
    await f.gateway.jobs.status.tick();
    expect((await f.db.query<{ status: string }>(`SELECT status FROM node_conditions WHERE node_id = $1 AND type = 'HostManagedExternally'`, [node])).rows).toEqual([
      { status: 'true' },
    ]);
    expect((await state()).reasons).toEqual([]);
    // A unit waiting for a reboot, and the kube manager's conditions: recorded, not NoSchedule.
    await report(6, ['RebootRequired', 'ForeignGpuExposure', 'PodResourcesUnavailable']);
    expect(
      (
        await f.db.query<{ type: string }>(
          `SELECT type FROM node_conditions WHERE node_id = $1 AND status = 'true' AND type IN ('ForeignGpuExposure', 'PodResourcesUnavailable') ORDER BY type`,
          [node],
        )
      ).rows.map((row) => row.type),
    ).toEqual(['ForeignGpuExposure', 'PodResourcesUnavailable']);
    expect((await f.db.query<{ status: string }>(`SELECT status FROM node_conditions WHERE node_id = $1 AND type = 'RebootRequired'`, [node])).rows).toEqual([
      { status: 'true' },
    ]);
    expect((await state()).reasons).toEqual([]);

    // A tenant-controlled node's reports are advisory: the condition, never a NoSchedule reason.
    await f.db.query(`UPDATE nodes SET trust = 'tenant-controlled' WHERE id = $1`, [node]);
    await report(7, ['FabricManagerDown']);
    expect(await state()).toMatchObject({ reasons: [] });
    expect((await state()).conditions).toContainEqual({ type: 'FabricManagerDown', status: 'true' });
  });

  it('ignores XIDs without a policy and conditions without a device', async () => {
    f = await gatewayFixture({ reports: { status: xidStatusHandler } });
    const node = await f.addNode();
    await gpu(node, 'GPU-a');
    const { handle } = await f.connect(node);
    await handle.receive(status(1, [{ type: 'Xid13', deviceId: 'GPU-a' }, { type: 'Xid79' }]));
    await f.gateway.jobs.status.tick();
    const { rows } = await f.db.query('SELECT healthy FROM devices WHERE id = $1', ['GPU-a']);
    expect(rows).toEqual([{ healthy: true }]);
    expect((await f.db.query(`SELECT 1 FROM work_queue WHERE kind = 'health'`)).rowCount).toBe(0);
  });

  it('never lets a failing status handler hold back observed_generation', async () => {
    f = await gatewayFixture({
      reports: {
        status: async (tx) => {
          await tx.query(`UPDATE nodes SET cordoned = true`);
          throw new Error('health store down');
        },
      },
    });
    const node = await f.addNode();
    const { handle } = await f.connect(node);
    await handle.receive(status(4, []));
    await f.gateway.jobs.status.tick();
    const { rows } = await f.db.query('SELECT observed_generation, cordoned FROM nodes WHERE id = $1', [node]);
    expect(rows).toEqual([{ observed_generation: 4, cordoned: false }]);
    expect((await f.outbox('node.report-failed'))[0]!.payload.data).toMatchObject({ report: 'status', error: 'health store down' });
  });
});

describe('composed status handlers', () => {
  it('runs every handler in its own savepoint: one failing never blocks the others', async () => {
    const seen: StatusReport[] = [];
    f = await gatewayFixture({
      reports: {
        status: [
          async function brokenHealth(tx) {
            await tx.query(`UPDATE nodes SET cordoned = true`);
            throw new Error('boom');
          },
          async function instances(_tx, _context, report) {
            seen.push(report);
          },
        ],
      },
    });
    const node = await f.addNode();
    const { handle } = await f.connect(node);
    await handle.receive(
      agentFrame({
        case: 'status',
        value: {
          observedGeneration: 3n,
          instances: [{ instanceId: 'inst_1', state: InstanceObservedState.RUNNING, addresses: ['10.0.0.5/24'], runtime: 'libvirt-kvm' }],
          instancesComplete: true,
        },
      }),
    );
    await f.gateway.jobs.status.tick();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.instances).toMatchObject([{ instanceId: 'inst_1', state: InstanceObservedState.RUNNING }]);
    expect(seen[0]!.instancesComplete).toBe(true);
    const { rows } = await f.db.query('SELECT cordoned, observed_generation FROM nodes WHERE id = $1', [node]);
    expect(rows).toEqual([{ cordoned: false, observed_generation: 3 }]);
    expect((await f.outbox('node.report-failed'))[0]!.payload.data).toMatchObject({ handler: 'brokenHealth', error: 'boom' });
  });
});