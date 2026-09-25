import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EventPublisher, SqlExecutor } from '@better-compute/core';
import { pglite } from '@better-compute/postgres/pglite';
import { setSimClock, useSimClock } from '@better-compute/postgres';
import { createDevStack } from '@better-compute/testing';
import {
  evaluateHygiene,
  evaluatePressure,
  hostPressureStatusHandler,
  hygieneReconciler,
  inventoryHygieneReconciler,
  inventoryModule,
  parseVersion,
  recordHostPressure,
  runHygiene,
} from '@better-compute/inventory';

// §10.1 conditions no single inventory report raises: the hygiene sweep (DriverMismatch,
// CertExpiring, DaemonOutdated) and host pressure from StatusReport.pressure (v0.3).

let db: SqlExecutor;
const published: { type: string; subject: string; data: Record<string, unknown> }[] = [];
const events: EventPublisher = {
  async publish(_tx, event) {
    published.push({ type: event.type, subject: event.subject, data: event.data as Record<string, unknown> });
  },
};
const HOUR = 3_600_000;
let snapshots = 0;
let now = Date.UTC(2026, 8, 25, 12);

async function addNode(id: string, pool: string) {
  await db.query(
    `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance, cordoned,
       connectivity, trust, generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
     VALUES ($1, 'site_a', $2, 'ten_a', 'host', 'adopted', false, false, 'connected', 'platform', 1, 1, 1, 0, 0, 1)`,
    [id, pool],
  );
}
const node = async (id: string) =>
  (
    await db.query<{ no_schedule_reasons: string[]; conditions: Record<string, string> | null }>(
      `SELECT n.no_schedule_reasons, (SELECT jsonb_object_agg(type, status) FROM node_conditions WHERE node_id = n.id) AS conditions
         FROM nodes n WHERE n.id = $1`,
      [id],
    )
  ).rows[0]!;
/** A converged spec with an nvidia-driver unit (the stored proto JSON shape) and a GPU driver in the applied snapshot. */
async function driverFacts(id: string, branch: string, driverVersion: string) {
  const spec = { host: { units: [{ unit: 'nvidia-driver', configJson: JSON.stringify({ branch }) }] }, devices: {} };
  await db.query(`UPDATE nodes SET spec = $2::jsonb WHERE id = $1`, [id, JSON.stringify(spec)]);
  const snapshot = `inv_${id.slice(5)}_${++snapshots}`;
  await db.query(
    `INSERT INTO inventory_snapshots (id, node_id, sha256, section_hashes, sections, collected_at)
     VALUES ($1, $2, '\\x00', '{}', $3::jsonb, compute_now())`,
    [snapshot, id, JSON.stringify({ gpus: { driverVersion, gpus: [] } })],
  );
  await db.query(
    `INSERT INTO node_inventory (node_id, applied_snapshot_id) VALUES ($1, $2)
     ON CONFLICT (node_id) DO UPDATE SET applied_snapshot_id = EXCLUDED.applied_snapshot_id`,
    [id, snapshot],
  );
}
async function cert(id: string, serial: string, fromMs: number, toMs: number, role = 'node') {
  await db.query(
    `INSERT INTO node_certs (serial, node_id, role, identity_gen, spki_sha256, der, not_before, not_after)
     VALUES ($1, $2, $3, 0, '\\x00', '\\x00', $4, $5)`,
    [serial, id, role, new Date(fromMs), new Date(toMs)],
  );
}
async function session(id: string, daemonVersion: string | null, protoMax: number | null) {
  await db.query(
    `INSERT INTO node_sessions (node_id, session_epoch, daemon_version, proto_max, connected_at) VALUES ($1, 1, $2, $3, compute_now())
     ON CONFLICT (node_id) DO UPDATE SET daemon_version = EXCLUDED.daemon_version, proto_max = EXCLUDED.proto_max`,
    [id, daemonVersion, protoMax],
  );
}

beforeAll(async () => {
  db = pglite({ analyzeEveryMs: 0 });
  await db.migrate();
  await useSimClock(db, now);
  await db.query(`INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site_a', 'ten_a', 'shared', 'eu', 1)`);
  await db.query(
    `INSERT INTO pools (id, owner_tenant_id, site_id, class, sharing, agent, policy, version)
     VALUES ('pool_gpu', 'ten_a', 'site_a', 'metal-host', 'exclusive', 'bcd', '{}', 1),
            ('pool_vps', 'ten_a', 'site_a', 'vps-host', 'exclusive', 'bcd', '{}', 1)`,
  );
});
afterAll(() => db.close());

describe('evaluateHygiene', () => {
  const base = { converged: true, want_branch: null, driver: null, daemon_version: null, proto_max: null, cert_from: null, cert_to: null, now: new Date(now) };
  it('flags a driver of another branch only once the node converged on its spec', () => {
    expect(evaluateHygiene({ ...base, want_branch: '580', driver: '550.90.07' }).DriverMismatch).toMatchObject({ status: true });
    expect(evaluateHygiene({ ...base, want_branch: '580', driver: '580.65.06' }).DriverMismatch.status).toBe(false);
    expect(evaluateHygiene({ ...base, converged: false, want_branch: '580', driver: '550.90.07' }).DriverMismatch.status).toBe(false);
    expect(evaluateHygiene({ ...base, driver: '550.90.07' }).DriverMismatch.status).toBe(false); // no desired branch
  });

  it('flags a certificate in the last tenth of its life (at least an hour), and an expired one', () => {
    const at = (fromH: number, toH: number) => ({ ...base, cert_from: new Date(now + fromH * HOUR), cert_to: new Date(now + toH * HOUR) });
    expect(evaluateHygiene(at(-20, 4)).CertExpiring.status).toBe(false); // 4 h of 24 left
    expect(evaluateHygiene(at(-22, 2)).CertExpiring.status).toBe(true); // 2 h of 24 < 2.4 h
    expect(evaluateHygiene(at(-1, 0.5)).CertExpiring.status).toBe(true); // short-lived: the one-hour floor
    expect(evaluateHygiene(at(-25, -1)).CertExpiring).toEqual({ status: true, reason: 'certificate expired' });
  });

  it('flags an older protocol, or a version below the minimum', () => {
    expect(evaluateHygiene({ ...base, proto_max: 1 }, { protocolMax: 2 }).DaemonOutdated).toMatchObject({ status: true, reason: 'protocol 1 < 2' });
    expect(evaluateHygiene({ ...base, proto_max: 1, daemon_version: '0.3.9' }, { minDaemonVersion: '0.4.0' }).DaemonOutdated.status).toBe(true);
    expect(evaluateHygiene({ ...base, proto_max: 1, daemon_version: 'v0.4.0-rc.1' }, { minDaemonVersion: '0.4.0' }).DaemonOutdated.status).toBe(false);
    expect(evaluateHygiene({ ...base, daemon_version: 'dev' }, { minDaemonVersion: '0.4.0' }).DaemonOutdated.status).toBe(false);
    expect(parseVersion('1.2.3+abc')).toEqual([1, 2, 3]);
  });
});

describe('runHygiene', () => {
  const A = 'node_hyg000000000000000000000001';
  const B = 'node_hyg000000000000000000000002';
  const C = 'node_hyg000000000000000000000003';

  it('raises each condition with a NoSchedule taint and an event, writes nothing the second time, and clears', async () => {
    for (const id of [A, B, C]) await addNode(id, 'pool_gpu');
    await driverFacts(A, '580', '550.90.07');
    await cert(B, 'b-1', now - 22 * HOUR, now + 2 * HOUR);
    await cert(B, 'b-ramdisk', now - HOUR, now + 10 * HOUR, 'ramdisk'); // ramdisk certs do not count
    await session(C, '0.3.1', 1);
    await db.query(`UPDATE nodes SET no_schedule_reasons = '{maintenance.manual}' WHERE id = $1`, [A]);

    const first = await runHygiene(db, { events, minDaemonVersion: '0.4.0', batch: 1 });
    expect(first).toEqual({ checked: 3, raised: 3, cleared: 0 });
    expect((await node(A)).no_schedule_reasons).toEqual(['DriverMismatch', 'maintenance.manual']);
    expect((await node(B)).no_schedule_reasons).toEqual(['CertExpiring']);
    expect((await node(C)).no_schedule_reasons).toEqual(['DaemonOutdated']);
    expect(published.map((event) => `${event.subject}:${event.data.condition}:${event.data.status}`).sort()).toEqual([
      `node/${A}:DriverMismatch:true`,
      `node/${B}:CertExpiring:true`,
      `node/${C}:DaemonOutdated:true`,
    ]);

    published.length = 0;
    expect(await runHygiene(db, { events, minDaemonVersion: '0.4.0' })).toEqual({ checked: 3, raised: 0, cleared: 0 });
    expect(published).toEqual([]);

    // Fixed: the driver converged, the node renewed, the daemon upgraded.
    await driverFacts(A, '580', '580.65.06');
    await cert(B, 'b-2', now, now + 24 * HOUR);
    await session(C, '0.4.2', 1);
    expect(await runHygiene(db, { events, minDaemonVersion: '0.4.0' })).toEqual({ checked: 3, raised: 0, cleared: 3 });
    expect((await node(A)).no_schedule_reasons).toEqual(['maintenance.manual']);
    expect((await node(B)).no_schedule_reasons).toEqual([]);
    expect((await node(C)).conditions).toMatchObject({ DaemonOutdated: 'false' });
  });

  it('runs as the inventory module periodic reconciler', async () => {
    expect(inventoryModule.reconcilers).toContain(inventoryHygieneReconciler);
    expect(inventoryHygieneReconciler).toMatchObject({ name: 'inventory.hygiene', shardBy: 'none', periodic: [{ key: 'all', every: '5m' }] });
    now += 23 * HOUR; // b-2 is now in its last hour
    await setSimClock(db, now);
    published.length = 0;
    expect(await hygieneReconciler({ every: '1m' }).run({ sql: db, events } as never, 'all')).toBe('DONE');
    expect(published.map((event) => event.data.condition)).toEqual(['CertExpiring']);
  });
});

describe('host pressure through a real gateway', () => {
  it('a FakeDaemon reporting PSI raises the condition via the status report hook', { timeout: 60_000 }, async () => {
    const stack = await createDevStack({ reports: { status: hostPressureStatusHandler() } });
    try {
      const { poolId } = await stack.createPool();
      const [nodeId] = await stack.join({ poolId, count: 1, seed: 'pressure' });
      await stack.waitFor([nodeId!], { timeoutMs: 45_000 });
      stack.daemons.get(nodeId!)!.setPressure({ cpuSomeAvg10: 2, memorySomeAvg10: 42, ioSomeAvg10: 1, stealPct: 0 });
      const deadline = Date.now() + 15_000;
      let status: string | undefined;
      while (Date.now() < deadline) {
        const { rows } = await stack.database.query<{ status: string }>(
          `SELECT status FROM node_conditions WHERE node_id = $1 AND type = 'MemoryPressure'`,
          [nodeId],
        );
        status = rows[0]?.status;
        if (status === 'true') break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(status).toBe('true');
    } finally {
      await stack.close();
    }
  });
});

describe('host pressure', () => {
  const quiet = { cpuSomeAvg10: 1, memorySomeAvg10: 0, ioSomeAvg10: 2, stealPct: 0 };
  it('raises at the threshold and clears below half of it', () => {
    const raised = new Set<'CpuPressure'>(['CpuPressure']);
    expect(evaluatePressure({ ...quiet, cpuSomeAvg10: 55 }, new Set()).get('CpuPressure')?.status).toBe(true);
    expect(evaluatePressure({ ...quiet, stealPct: 25 }, new Set()).get('CpuPressure')?.status).toBe(true);
    expect(evaluatePressure({ ...quiet, cpuSomeAvg10: 40 }, new Set()).get('CpuPressure')?.status).toBe(false);
    expect(evaluatePressure({ ...quiet, cpuSomeAvg10: 40 }, raised).get('CpuPressure')?.status).toBe(true); // hysteresis
    expect(evaluatePressure({ ...quiet, cpuSomeAvg10: 20 }, raised).get('CpuPressure')?.status).toBe(false);
  });

  it('takes a VPS host out of scheduling, only alerts elsewhere, and writes nothing while nothing changes', async () => {
    const vps = 'node_hyg000000000000000000000004';
    const gpu = 'node_hyg000000000000000000000005';
    await addNode(vps, 'pool_vps');
    await addNode(gpu, 'pool_gpu');
    const handler = hostPressureStatusHandler({ events });
    published.length = 0;
    const report = { pressure: { ...quiet, memorySomeAvg10: 35, ioSomeAvg10: 60 } };
    expect(await db.transaction((tx) => handler(tx, { nodeId: vps }, report))).toBe(2);
    expect(await db.transaction((tx) => handler(tx, { nodeId: gpu }, report))).toBe(2);
    expect((await node(vps)).no_schedule_reasons).toEqual(['DiskPressure', 'MemoryPressure']);
    expect((await node(gpu)).no_schedule_reasons).toEqual([]);
    expect((await node(gpu)).conditions).toMatchObject({ DiskPressure: 'true', MemoryPressure: 'true' });
    expect(published.filter((event) => event.subject === `node/${gpu}`).every((event) => event.data.noSchedule === false)).toBe(true);
    // The same report again: nothing to do.
    expect(await db.transaction((tx) => handler(tx, { nodeId: vps }, report))).toBe(0);
    expect(await db.transaction((tx) => handler(tx, { nodeId: vps }, {}))).toBe(0);
    // Memory settles below half its threshold, io stays in the band: only MemoryPressure clears.
    expect(await db.transaction((tx) => recordHostPressure(tx, vps, { ...quiet, memorySomeAvg10: 5, ioSomeAvg10: 30 }))).toEqual([
      { type: 'MemoryPressure', status: false },
    ]);
    expect((await node(vps)).no_schedule_reasons).toEqual(['DiskPressure']);
  });

  it("ignores a tenant-controlled node's pressure (the lessee writes it)", async () => {
    const leased = 'node_hyg000000000000000000000006';
    await addNode(leased, 'pool_vps');
    await db.query(`UPDATE nodes SET trust = 'tenant-controlled' WHERE id = $1`, [leased]);
    expect(await db.transaction((tx) => recordHostPressure(tx, leased, { ...quiet, memorySomeAvg10: 35, ioSomeAvg10: 60 }))).toEqual([]);
    expect(await node(leased)).toMatchObject({ no_schedule_reasons: [] });
  });
});
