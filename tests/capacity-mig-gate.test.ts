import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MethodContext, ModuleContext, SqlExecutor, SqlTx } from '@better-compute/core';
import { setSimClock, useSimClock } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import { provisionMigrations } from '@better-compute/provision';
import {
  capacityMigrations,
  capacityModule,
  grantedMigLayout,
  inlinePlacer,
  freezeMigLayouts,
  parseSelector,
  stepMigGate,
  type CapacityApi,
} from '@better-compute/capacity';

// The MIG layout gate (PLAN.md §10.4 point 2, §10.6): a pool's new `policy.migLayout` reaches a node
// only once every GPU family on it is idle, held by partition bookings from the end of its last
// booking; the bookings are released once the node converged the spec that carried the layout.

const T0 = Date.UTC(2026, 8, 24, 12);
const MIN = 60_000;
const HOUR = 60 * MIN;
const POOL = 'pool_01jz00000000000000000000mg';
const NODE = 'node_01jz00000000000000000000mg';

let db: SqlExecutor;
let now = T0;
const recorded = {
  invalidated: [] as string[],
  events: [] as { type: string; data: unknown }[],
  work: [] as { kind: string; key: string }[],
};
const context = {
  clock: { now: () => now },
  desired: {
    async invalidate(_tx: SqlTx, nodeId: string) {
      recorded.invalidated.push(nodeId);
    },
  },
  events: {
    async publish(_tx: SqlTx, event: { type: string; data: unknown }) {
      recorded.events.push({ type: event.type, data: event.data });
    },
  },
  work: {
    async enqueue(_tx: SqlTx, kind: string, key: string) {
      recorded.work.push({ kind, key });
    },
  },
  authz: { async upsert() {}, async remove() {}, async setPending() {} },
};
const step = () => db.transaction((tx) => stepMigGate(tx, context as never, NODE));
const advance = async (ms: number) => {
  now += ms;
  await setSimClock(db, now);
};
const place = (profile: string, start: number, end: number) =>
  db.transaction((tx) =>
    inlinePlacer().place(
      tx,
      {
        tenantId: 'root',
        poolId: POOL,
        reservationId: `rsv_${start}_${profile}`,
        devices: [
          { class: 'gpu.mig', count: 1, selector: parseSelector(`migProfile in (${profile})`) },
        ],
        during: { start, end },
      },
      { clock: { now: () => now }, random: () => 0, plugins: [], weights: {}, topN: 1 },
    ),
  );
const partitionBookings = async () =>
  (
    await db.query<{ allocation_id: string; n: string }>(
      `SELECT allocation_id, count(*)::text AS n FROM device_bookings
        WHERE allocation_id LIKE 'partition:%' GROUP BY allocation_id ORDER BY allocation_id`,
    )
  ).rows;

beforeAll(async () => {
  db = pglite();
  await db.migrate([...capacityMigrations, ...provisionMigrations]);
  await useSimClock(db, T0);
  await db.query(
    `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site_m', 'root', 'shared', 'eu', 1)`,
  );
  await db.query(
    `INSERT INTO pools (id, owner_tenant_id, site_id, class, gpu_model, sharing, agent, policy, version)
     VALUES ($1, 'root', 'site_m', 'metal-host', 'H100', 'mig', 'bcd', '{"migLayout": "mixed:3g.40gb+4g.40gb"}', 1)`,
    [POOL],
  );
  await db.query(
    `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance, cordoned,
                        connectivity, trust, generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
     VALUES ($1, 'site_m', $2, 'root', 'host', 'adopted', false, false, 'connected', 'platform', 3, 3, 1, 1, 0, 1)`,
    [NODE, POOL],
  );
  for (const gpu of ['GPU-0', 'GPU-1']) {
    await db.query(
      `INSERT INTO devices (id, node_id, class, bookable, healthy, attributes)
       VALUES ($1, $2, 'gpu', false, true, '{"gpuModel": "H100"}')`,
      [gpu, NODE],
    );
    for (const [instance, profile] of [
      ['gi1/ci0', '3g.40gb'],
      ['gi2/ci0', '4g.40gb'],
    ] as const)
      await db.query(
        `INSERT INTO devices (id, node_id, parent_id, class, bookable, healthy, attributes)
         VALUES ($1, $2, $3, 'gpu.mig', true, true, $4::jsonb)`,
        [
          `${gpu}/${instance}`,
          NODE,
          gpu,
          JSON.stringify({ gpuModel: 'H100', migProfile: profile }),
        ],
      );
  }
  // The node was deployed with a profile whose host config takes the MIG layout from the pool.
  await db.query(
    `INSERT INTO workflows (id, tenant_id, node_id, profile_id, profile_version, state, work_key,
                            finished_at, profile_document)
     VALUES ('wf_01jz00000000000000000000mg', 'root', $1, 'prf_mig', 1, 'succeeded', $1,
             compute_now(), '{"hostConfig": {"mig-layout": {"from": "pool"}}}')`,
    [NODE],
  );
});
afterAll(() => db.close());

describe('the MIG layout gate', () => {
  it('holds a new pool layout until every GPU of the node is idle, then grants and releases', async () => {
    // A tenant holds a 3g instance on GPU-0 for two hours.
    expect(await place('3g.40gb', T0, T0 + 2 * HOUR)).toMatchObject({ status: 'placed' });
    expect(await grantedMigLayout(db, NODE)).toBeUndefined();

    // The owner changes the pool's layout: the node keeps the old one, the new one waits.
    const api = capacityModule().api!(context as unknown as ModuleContext) as CapacityApi;
    const update = api.pools.update as unknown as {
      validate(raw: unknown): unknown;
      handler(context: MethodContext, input: unknown): Promise<unknown>;
    };
    await db.transaction((tx) =>
      update.handler(
        { ...context, sql: tx, caller: { tenantId: 'root' } } as unknown as MethodContext,
        update.validate({ tenantId: 'root', poolId: POOL, policy: { migLayout: 'all-1g.10gb' } }),
      ),
    );
    expect(await grantedMigLayout(db, NODE)).toBe('mixed:3g.40gb+4g.40gb');
    expect(recorded.work).toContainEqual({ kind: 'capacity.mig', key: NODE });

    // Both GPU families are held from the end of the last booking, T0+2h: nothing lands past it.
    expect(await step()).toBe(T0 + 2 * HOUR);
    expect(await partitionBookings()).toEqual([
      { allocation_id: `partition:GPU-0:${T0 + 2 * HOUR}`, n: '3' },
      { allocation_id: `partition:GPU-1:${T0 + 2 * HOUR}`, n: '3' },
    ]);
    expect(await place('4g.40gb', T0 + 3 * HOUR, T0 + 4 * HOUR)).toMatchObject({
      status: 'pending',
    });
    // …but idle time before it can still be booked.
    expect(await place('4g.40gb', T0 + 30 * MIN, T0 + HOUR)).toMatchObject({ status: 'placed' });
    expect(recorded.invalidated).toEqual([]);
    expect(await step()).toBe(T0 + 2 * HOUR); // not yet

    // At T0+2h the GPUs are idle: the node's spec may carry the new layout.
    await advance(2 * HOUR);
    await step();
    expect(await grantedMigLayout(db, NODE)).toBe('all-1g.10gb');
    expect(recorded.invalidated).toEqual([NODE]);

    // Held until the node converged a newer spec (generation 3 → 4, observed).
    await advance(MIN);
    await step();
    expect(await partitionBookings()).toHaveLength(2);
    await db.query(`UPDATE nodes SET generation = 4 WHERE id = $1`, [NODE]);
    await step();
    expect(await partitionBookings()).toHaveLength(2);
    await db.query(`UPDATE nodes SET observed_generation = 4 WHERE id = $1`, [NODE]);
    expect(await step()).toBeUndefined();
    expect(await partitionBookings()).toEqual([]);
    expect(recorded.events.map((event) => event.type)).toEqual([
      'pool.updated',
      'node.mig.scheduled',
      'node.mig.granted',
      'node.mig.applied',
    ]);
  });

  it('reports stuck changes, unusable dedications and count drift to doctor (selfCheck)', async () => {
    const check = () =>
      capacityModule().selfCheck!({ ...context, sql: db } as unknown as ModuleContext);
    const checks = async () => (await check()).map((finding) => [finding.check, finding.count]);
    const before = await checks();
    expect(before.filter(([name]) => name !== 'capacity.reservations.stale')).toEqual([]);

    await db.query(
      `UPDATE nodes SET no_schedule_reasons = ARRAY['taint:dedicated=beta'] WHERE id = $1`,
      [NODE],
    );
    await db.query(
      `UPDATE capacity_mig_layouts SET pending_layout = 'all-7g.80gb', updated_at = compute_now() - interval '25 hours' WHERE node_id = $1`,
      [NODE],
    );
    await db.query(
      `UPDATE capacity_device_counts SET bookable = bookable + 1 WHERE node_id = $1 AND class = 'gpu.mig'`,
      [NODE],
    );
    expect(await checks()).toEqual(
      expect.arrayContaining([
        ['capacity.mig.stuck', 1],
        ['capacity.dedicated.unoffered', 1],
        ['capacity.device_counts.drift', 1],
      ]),
    );
    // Offered to beta (or dedicated to the owner), the dedication is usable again.
    await db.query(`INSERT INTO pool_offers (pool_id, tenant_id) VALUES ($1, 'beta')`, [POOL]);
    expect((await checks()).map(([name]) => name)).not.toContain('capacity.dedicated.unoffered');
    await db.query(
      `UPDATE capacity_device_counts SET bookable = bookable - 1 WHERE node_id = $1 AND class = 'gpu.mig'`,
      [NODE],
    );
    await db.query(`UPDATE capacity_mig_layouts SET pending_layout = NULL WHERE node_id = $1`, [
      NODE,
    ]);
    await db.query(`UPDATE nodes SET no_schedule_reasons = '{}' WHERE id = $1`, [NODE]);
  });

  it('holds a granted change until the node converges, however long that takes', async () => {
    recorded.events = [];
    await db.query(`UPDATE pools SET policy = '{"migLayout": "all-1g.10gb"}' WHERE id = $1`, [
      POOL,
    ]);
    await db.transaction((tx) =>
      freezeMigLayouts(tx, context.work, POOL, 'all-1g.10gb', 'all-2g.20gb'),
    );
    await step(); // idle now: books and grants in one step
    expect(await grantedMigLayout(db, NODE)).toBe('all-2g.20gb');
    expect(await partitionBookings()).toHaveLength(2);
    // A NodeSpec backlog: no newer generation for an hour. The holds stay (no timer releases them).
    await advance(HOUR);
    expect(await step()).toBe(now + 30_000);
    expect(await partitionBookings()).toHaveLength(2);
    await db.query(
      `UPDATE nodes SET generation = generation + 1, observed_generation = generation + 1 WHERE id = $1`,
      [NODE],
    );
    expect(await step()).toBeUndefined();
    expect(await partitionBookings()).toEqual([]);
  });

  it('releases at the grant when the node’s spec does not take its layout from the pool', async () => {
    recorded.events = [];
    await db.query(
      `UPDATE workflows SET profile_document = '{"hostConfig": {"mig-layout": {"layout": "all-7g.80gb"}}}'
        WHERE node_id = $1`,
      [NODE],
    );
    await db.transaction((tx) =>
      freezeMigLayouts(tx, context.work, POOL, 'all-2g.20gb', 'all-3g.40gb'),
    );
    expect(await step()).toBeUndefined(); // books, grants and releases in one step
    expect(await grantedMigLayout(db, NODE)).toBe('all-3g.40gb');
    expect(await partitionBookings()).toEqual([]);
    expect(recorded.events.map((event) => event.type)).toEqual([
      'node.mig.scheduled',
      'node.mig.granted',
      'node.mig.applied',
    ]);
  });
});
