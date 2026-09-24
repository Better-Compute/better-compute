import { afterEach, describe, expect, it } from 'vitest';
import { xidStatusHandler } from '@better-compute/gateway';
import { ConditionStatus, InstanceObservedState, type StatusReport } from '@better-compute/protocol';
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