import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ComputeError,
  createIdGenerator,
  type PlacementContext,
  type PlacementRequest,
  type SqlExecutor,
  type SqlTx,
} from '@better-compute/core';
import { setSimClock, useSimClock } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import {
  capacityMigrations,
  chargeQuota,
  commitPlansBulk,
  createCapacityPort,
  dedicatedTaint,
  extendAllocation,
  inlinePlacer,
  isSchedulable,
  loadNodeViews,
  mayBeSchedulable,
  mayBeSchedulableSql,
  parseSelector,
  placeFromIndex,
  PoolIndex,
  quotaDemand,
  readAllocation,
  readOwnerAllocations,
  readPool,
  readPoolCapacity,
  readQuotas,
  rebuildPoolRollup,
  refundQuota,
  releaseAllocation,
  schedulableSql,
  schedulableSqlTolerating,
  setQuota,
  writeDeviceLinks,
  type PlacementObservation,
} from '@better-compute/capacity';

// The SQL half of capacity on PGlite with the base schema: the InlinePlacer's guarded statements,
// release/extend, quotas and rollups (PLAN.md §10.2–§10.5), on the sim clock.

const T0 = Date.UTC(2026, 8, 24, 12);
const HOUR = 3_600_000;
let db: SqlExecutor;

beforeAll(async () => {
  db = pglite();
  await db.migrate([...capacityMigrations]);
});
afterAll(async () => {
  await db.close();
});

const tables = [
  'capacity_device_links',
  'pool_capacity_rollup',
  'device_bookings',
  'allocations',
  'node_resources',
  'node_labels',
  'devices',
  'quota_usage',
  'nodes',
  'pool_offers',
  'pools',
  'sites',
];
beforeEach(async () => {
  for (const table of tables) await db.query(`DELETE FROM ${table}`);
  await useSimClock(db, T0);
  await db.query(
    `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site_1', 'root', 'shared', 'eu', 1)`,
  );
  await pool('pool_1');
});

async function pool(id: string, owner = 'root'): Promise<void> {
  await db.query(
    `INSERT INTO pools (id, owner_tenant_id, site_id, class, gpu_model, sharing, agent, policy, version)
     VALUES ($1, $2, 'site_1', 'metal-host', 'H100', 'exclusive', 'bcd', '{}', 1)`,
    [id, owner],
  );
}

interface NodeSeed {
  gpus?: number;
  poolId?: string;
  cordoned?: boolean;
  connectivity?: string;
  provisionState?: string;
  noSchedule?: string[];
  vcpu?: { allocatable: number; ratio?: number };
}

async function addNode(id: string, seed: NodeSeed = {}): Promise<string[]> {
  await db.query(
    `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance,
                        cordoned, connectivity, trust, no_schedule_reasons, generation,
                        observed_generation, next_cmd_seq, identity_gen, shard, version)
     VALUES ($1, 'site_1', $2, 'root', 'host', $3, false, $4, $5, 'platform', $6::text[], 1, 1, 1, 1, 0, 1)`,
    [
      id,
      seed.poolId ?? 'pool_1',
      seed.provisionState ?? 'adopted',
      seed.cordoned ?? false,
      seed.connectivity ?? 'connected',
      seed.noSchedule ?? [],
    ],
  );
  const ids = Array.from({ length: seed.gpus ?? 8 }, (_, index) => `${id}-gpu${index}`);
  for (const [index, deviceId] of ids.entries())
    await db.query(
      `INSERT INTO devices (id, node_id, class, bookable, healthy, attributes)
       VALUES ($1, $2, 'gpu', true, true, $3::jsonb)`,
      [
        deviceId,
        id,
        JSON.stringify({ gpuModel: 'H100', vramGiB: 80, numaNode: index < 4 ? 0 : 1 }),
      ],
    );
  if (seed.vcpu)
    await db.query(
      `INSERT INTO node_resources (node_id, resource, allocatable, ratio, allocated) VALUES ($1, 'vcpu', $2, $3, 0)`,
      [id, seed.vcpu.allocatable, seed.vcpu.ratio ?? 1],
    );
  return ids;
}

let sequence = 0;
function context(overrides: Partial<PlacementContext> = {}): PlacementContext {
  return {
    clock: { now: () => T0 } as PlacementContext['clock'],
    random: () => 0,
    plugins: [],
    weights: {},
    topN: 1,
    ...overrides,
  };
}
function request(count: number, extra: Partial<PlacementRequest> = {}): PlacementRequest {
  return {
    tenantId: 'acme',
    poolId: 'pool_1',
    reservationId: `rsv_${++sequence}`,
    devices: [{ class: 'gpu', count }],
    during: { start: T0, end: T0 + HOUR },
    ...extra,
  };
}

const ids = createIdGenerator({ now: () => T0 });
const placer = inlinePlacer({ ids });
const place = (req: PlacementRequest, ctx = context()) =>
  db.transaction((tx) => placer.place(tx, req, ctx));

async function bookings(): Promise<{ device_id: string; allocation_id: string }[]> {
  return (
    await db.query<{ device_id: string; allocation_id: string }>(
      'SELECT device_id, allocation_id FROM device_bookings ORDER BY device_id',
    )
  ).rows;
}

describe('inlinePlacer', () => {
  it('books atoms, writes the allocation and moves the rollup in one transaction', async () => {
    await addNode('node_a');
    await rebuildPoolRollup(db, { id: 'pool_1', ownerTenantId: 'root' });
    const outcome = await place(request(4));
    expect(outcome.status).toBe('placed');
    if (outcome.status !== 'placed') return;
    const [allocation] = outcome.allocations;
    expect(allocation).toMatchObject({
      nodeId: 'node_a',
      poolId: 'pool_1',
      owner: { kind: 'reservation' },
    });
    expect(allocation!.atoms).toHaveLength(4);
    expect((await bookings()).map((row) => row.device_id)).toEqual(
      allocation!.atoms.slice().sort(),
    );
    expect(await readAllocation(db, allocation!.id)).toMatchObject({
      during: { start: T0, end: T0 + HOUR },
      released: false,
    });
    const [gpu] = await readPoolCapacity(db, 'pool_1');
    expect(gpu).toMatchObject({
      resource: 'gpu',
      total: 8,
      allocatable: 8,
      allocated: 4,
      available: 4,
    });
  });

  it('never double-books: 12 sequential requests fill 16 GPUs exactly, then go pending', async () => {
    await addNode('node_a');
    await addNode('node_b');
    const outcomes = [];
    for (let index = 0; index < 12; index++)
      outcomes.push(
        await place(request(index % 3 === 0 ? 2 : 1), context({ random: Math.random, topN: 5 })),
      );
    const placed = outcomes.filter((outcome) => outcome.status === 'placed').length;
    expect(placed).toBe(12);
    const booked = await bookings();
    expect(new Set(booked.map((row) => row.device_id)).size).toBe(booked.length);
    expect(booked).toHaveLength(16);
    const full = await place(request(1));
    expect(full).toEqual({
      status: 'pending',
      reason: 'no node fits (2 nodes): 2 × fits: 0 of 1 gpu free',
    });
  });

  it('places into free time: the same atoms serve back-to-back intervals', async () => {
    await addNode('node_a', { gpus: 2 });
    expect((await place(request(2))).status).toBe('placed');
    expect((await place(request(2))).status).toBe('pending');
    const later = await place(request(2, { during: { start: T0 + HOUR, end: T0 + 2 * HOUR } }));
    expect(later.status).toBe('placed');
    expect((await readPoolCapacity(db, 'pool_1'))[0]).toMatchObject({ allocated: 2, reserved: 2 });
  });

  it('replans around a booking that bypassed the planner, and around a node taint', async () => {
    await addNode('node_a', { gpus: 2 });
    await addNode('node_b', { gpus: 2 });
    // A lock-ignoring writer books node_a between the snapshot and the commit.
    let raced = false;
    const sneaky = inlinePlacer({ ids });
    const outcome = await db.transaction(async (tx) => {
      const intercept: SqlTx = {
        async query(text, params) {
          if (!raced && text.startsWith('SAVEPOINT capacity_place_')) {
            raced = true;
            await tx.query(
              `INSERT INTO device_bookings (device_id, allocation_id, during)
               VALUES ('node_a-gpu0', 'alloc_intruder', tstzrange($1::timestamptz, $2::timestamptz))`,
              [new Date(T0).toISOString(), new Date(T0 + HOUR).toISOString()],
            );
          }
          return tx.query(text, params);
        },
      };
      return sneaky.place(intercept, request(2), context());
    });
    expect(raced).toBe(true);
    expect(outcome.status).toBe('placed');
    if (outcome.status === 'placed') expect(outcome.allocations[0]!.nodeId).toBe('node_b');
    const intruder = (await bookings()).filter((row) => row.allocation_id === 'alloc_intruder');
    expect(intruder).toHaveLength(1);
  });

  it('answers pending with the conflict trail after maxAttempts lost races', async () => {
    await addNode('node_a', { gpus: 1 });
    await addNode('node_b', { gpus: 1 });
    const flaky = inlinePlacer({ ids, maxAttempts: 2 });
    const outcome = await db.transaction(async (tx) => {
      const intercept: SqlTx = {
        async query(text, params) {
          if (text.includes('FOR SHARE OF n'))
            await tx.query(`UPDATE nodes SET cordoned = true WHERE id = $1`, [params![0]]);
          return tx.query(text, params);
        },
      };
      return flaky.place(intercept, request(1), context());
    });
    expect(outcome.status).toBe('pending');
    if (outcome.status === 'pending')
      expect(outcome.reason).toBe(
        'Unschedulable after 2 conflicting attempts: node_a is no longer schedulable; node_b is no longer schedulable',
      );
    expect(await bookings()).toEqual([]);
  });

  it('refuses unhealthy atoms and unschedulable nodes that the snapshot missed', async () => {
    await addNode('node_a', { gpus: 1 });
    const outcome = await db.transaction(async (tx) => {
      const intercept: SqlTx = {
        async query(text, params) {
          if (text.includes('AND healthy AND bookable FOR SHARE'))
            await tx.query(`UPDATE devices SET healthy = false WHERE id = 'node_a-gpu0'`);
          return tx.query(text, params);
        },
      };
      return placer.place(intercept, request(1), context());
    });
    expect(outcome).toMatchObject({ status: 'pending' });
    expect(await bookings()).toEqual([]);
  });

  it('claims scalars with the guarded update', async () => {
    await addNode('node_a', { gpus: 1, vcpu: { allocatable: 16, ratio: 2 } });
    const first = await place(request(0, { devices: [], resources: { vcpu: 24 } }));
    expect(first.status).toBe('placed');
    const second = await place(request(0, { devices: [], resources: { vcpu: 16 } }));
    expect(second).toMatchObject({
      status: 'pending',
      reason: expect.stringMatching(/vcpu: 16 requested, 8 free/),
    });
    const { rows } = await db.query<{ allocated: string }>(`SELECT allocated FROM node_resources`);
    expect(Number(rows[0]!.allocated)).toBe(24);
  });

  it('validates requests and the pool before placing', async () => {
    await expect(place(request(0, { devices: [] }))).rejects.toThrow(/at least one device/);
    await expect(place(request(0))).rejects.toThrow(/positive integer/);
    await expect(place(request(1, { instanceId: 'inst_1' }))).rejects.toThrow(/exactly one/);
    await expect(place(request(1, { during: { start: T0, end: T0 } }))).rejects.toThrow(
      /non-empty/,
    );
    await expect(place(request(1, { poolId: 'pool_missing' }))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(() => inlinePlacer({ maxAttempts: 0 })).toThrow(ComputeError);
  });

  it('runs scheduler admission hooks when an admission context is present', async () => {
    await addNode('node_a', { gpus: 1 });
    const admission = {
      tenantId: 'acme',
      identityId: 'id_1',
      identityKind: 'user' as const,
      sessionId: 's',
      sessionKind: 'user' as const,
      action: 'compute:reservations:create',
      resource: { type: 'reservation', id: 'rsv_x' },
      decidedAt: T0,
    };
    const refuse = {
      id: 'nope',
      extension: 'scheduler' as const,
      async admit() {
        throw new ComputeError('ACCESS_DENIED', 'Scheduler policy refuses');
      },
    };
    await expect(place(request(1), context({ plugins: [refuse], admission }))).rejects.toThrow(
      /refuses/,
    );
    expect((await place(request(1), context({ plugins: [refuse] }))).status).toBe('placed');

    // The CapacityPort other modules book through (vps instances): the request's own booking
    // passes its admission and is refused; a later retry by the module passes none.
    await setQuota(db, 'acme', 'pool_1', 'gpu', 8);
    const port = createCapacityPort(
      { clock: { now: () => T0 } },
      { plugins: [refuse], random: () => 0 },
    );
    const instance: PlacementRequest = {
      tenantId: 'acme',
      poolId: 'pool_1',
      instanceId: 'inst_1',
      devices: [{ class: 'gpu', count: 1 }],
      during: { start: T0, end: T0 + HOUR },
    };
    await expect(db.transaction((tx) => port.reserve(tx, instance, { admission }))).rejects.toThrow(
      /refuses/,
    );
    expect((await readQuotas(db, 'acme', 'pool_1'))[0]!.used).toBe(0);
    await setQuota(db, 'acme', 'pool_1', 'gpu', 8);
    const node = await addNode('node_b', { gpus: 1 });
    expect(node).toHaveLength(1);
    expect((await db.transaction((tx) => port.reserve(tx, instance))).status).toBe('placed');
  });

  it('prefers NVLink-complete sets from capacity_device_links', async () => {
    const gpus = await addNode('node_a', { gpus: 4 });
    await writeDeviceLinks(db, 'node_a', [
      { a: gpus[0]!, b: gpus[3]!, link: 'NV' },
      { a: gpus[0]!, b: gpus[1]!, link: 'SYS' },
      { a: gpus[0]!, b: gpus[2]!, link: 'SYS' },
      { a: gpus[1]!, b: gpus[2]!, link: 'NV' },
      { a: gpus[1]!, b: gpus[3]!, link: 'SYS' },
      { a: gpus[2]!, b: gpus[3]!, link: 'SYS' },
      { a: gpus[3]!, b: gpus[0]!, link: 'PIX' },
    ]);
    const outcome = await place(request(2, { topology: 'nvlink-all' }));
    expect(outcome.status).toBe('placed');
    if (outcome.status === 'placed')
      expect(outcome.allocations[0]!.atoms).toEqual([gpus[0], gpus[3]]);
    const second = await place(request(2, { topology: 'nvlink-all' }));
    if (second.status === 'placed')
      expect(second.allocations[0]!.atoms).toEqual([gpus[1], gpus[2]]);
    expect((await place(request(2, { topology: 'nvlink-all' }))).status).toBe('pending');
    await expect(
      writeDeviceLinks(db, 'node_a', [{ a: 'x', b: 'y', link: 'QPI' as never }]),
    ).rejects.toThrow(/Unknown GPU link/);
  });
});

describe('release and extend', () => {
  it('releases at compute_now(): truncates the current booking, deletes future ones, is idempotent', async () => {
    await addNode('node_a', { gpus: 2, vcpu: { allocatable: 8 } });
    const now = await place(request(1, { resources: { vcpu: 4 } }));
    const later = await place(request(1, { during: { start: T0 + 2 * HOUR, end: T0 + 3 * HOUR } }));
    if (now.status !== 'placed' || later.status !== 'placed') throw new Error('not placed');
    await setSimClock(db, T0 + 10 * 60_000);

    expect(await db.transaction((tx) => releaseAllocation(tx, now.allocations[0]!.id))).toBe(true);
    expect(await db.transaction((tx) => releaseAllocation(tx, now.allocations[0]!.id))).toBe(false);
    expect(await db.transaction((tx) => releaseAllocation(tx, later.allocations[0]!.id))).toBe(
      true,
    );

    const { rows } = await db.query<{ allocation_id: string; end_ms: number }>(
      `SELECT allocation_id, (extract(epoch FROM upper(during)) * 1000)::float8 AS end_ms FROM device_bookings`,
    );
    expect(rows).toEqual([{ allocation_id: now.allocations[0]!.id, end_ms: T0 + 10 * 60_000 }]);
    expect(await readAllocation(db, now.allocations[0]!.id)).toMatchObject({
      released: true,
      during: { start: T0, end: T0 + 10 * 60_000 },
    });
    expect(await readOwnerAllocations(db, now.allocations[0]!.owner)).toEqual([]);
    const vcpu = await db.query<{ allocated: string }>(`SELECT allocated FROM node_resources`);
    expect(Number(vcpu.rows[0]!.allocated)).toBe(0);
    expect((await readPoolCapacity(db, 'pool_1'))[0]).toMatchObject({ allocated: 0, reserved: 0 });
    // Freed time is bookable again right away.
    expect(
      (await place(request(2, { during: { start: T0 + 10 * 60_000, end: T0 + HOUR } }))).status,
    ).toBe('placed');
    await expect(
      db.transaction((tx) => releaseAllocation(tx, 'alloc_missing')),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('extends until the EXCLUDE constraint objects, then reports the reachable end', async () => {
    await addNode('node_a', { gpus: 1 });
    const first = await place(request(1));
    const blocker = await place(
      request(1, { during: { start: T0 + 3 * HOUR, end: T0 + 4 * HOUR } }),
    );
    if (first.status !== 'placed' || blocker.status !== 'placed') throw new Error('not placed');
    const id = first.allocations[0]!.id;

    expect(await db.transaction((tx) => extendAllocation(tx, id, T0 + 2 * HOUR))).toEqual({
      status: 'extended',
      during: { start: T0, end: T0 + 2 * HOUR },
    });
    expect(await db.transaction((tx) => extendAllocation(tx, id, T0 + 5 * HOUR))).toEqual({
      status: 'conflict',
      availableUntil: T0 + 3 * HOUR,
    });
    expect((await readAllocation(db, id))!.during.end).toBe(T0 + 2 * HOUR);
    await expect(db.transaction((tx) => extendAllocation(tx, id, T0 + HOUR))).rejects.toMatchObject(
      {
        code: 'INVALID_INPUT',
      },
    );
    await db.transaction((tx) => releaseAllocation(tx, id));
    await expect(
      db.transaction((tx) => extendAllocation(tx, id, T0 + 9 * HOUR)),
    ).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
  });
});

describe('quotas', () => {
  it('charges all-or-nothing, refuses past max with details, and never refunds below 0', async () => {
    await setQuota(db, 'acme', 'pool_1', 'gpu', 8);
    await setQuota(db, 'acme', 'pool_1', 'vcpu', 10);
    const demand = quotaDemand({ devices: [{ class: 'gpu', count: 6 }], resources: { vcpu: 4 } });
    await db.transaction((tx) => chargeQuota(tx, 'acme', 'pool_1', demand));

    const error = await db
      .transaction(async (tx) => {
        await chargeQuota(tx, 'acme', 'pool_1', demand);
      })
      .catch((failure: unknown) => failure);
    expect(error).toMatchObject({
      code: 'QUOTA_EXCEEDED',
      details: { resource: 'gpu', requested: 6, max: 8, used: 6 },
    });
    // The failed charge was all-or-nothing, and the caller's transaction survives it.
    await db.transaction(async (tx) => {
      await chargeQuota(tx, 'acme', 'pool_1', { gpu: 6, vcpu: 1 }).catch(() => undefined);
      await tx.query('SELECT 1');
    });
    expect((await readQuotas(db, 'acme')).map((row) => [row.resource, row.used])).toEqual([
      ['gpu', 6],
      ['vcpu', 4],
    ]);
    await expect(
      db.transaction((tx) => chargeQuota(tx, 'acme', 'pool_2', { gpu: 1 })),
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED', details: { max: 0 } });

    await db.transaction((tx) => refundQuota(tx, 'acme', 'pool_1', demand));
    await db.transaction((tx) => refundQuota(tx, 'acme', 'pool_1', demand));
    expect((await readQuotas(db, 'acme', 'pool_1')).every((row) => row.used === 0)).toBe(true);
  });

  it('never lowers max below what is in use', async () => {
    await setQuota(db, 'acme', 'pool_1', 'gpu', 8);
    await db.transaction((tx) => chargeQuota(tx, 'acme', 'pool_1', { gpu: 5 }));
    expect(await setQuota(db, 'acme', 'pool_1', 'gpu', 2)).toBe(5);
    await expect(setQuota(db, 'acme', 'pool_1', 'gpu', -1)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });
});

describe('rollups and eligibility SQL', () => {
  it('rebuilds buckets from nodes, devices, bookings and scalars', async () => {
    await addNode('node_ok', { vcpu: { allocatable: 32, ratio: 2 } });
    await addNode('node_cordoned', { cordoned: true });
    await addNode('node_new', { provisionState: 'adopting' });
    await addNode('node_gone', { connectivity: 'unreachable' });
    await addNode('node_tainted', { noSchedule: ['GpuCountMismatch'] });
    await db.query(`UPDATE devices SET healthy = false WHERE id = 'node_ok-gpu7'`);
    expect((await place(request(2))).status).toBe('placed');
    expect(
      (await place(request(1, { during: { start: T0 + HOUR, end: T0 + 2 * HOUR } }))).status,
    ).toBe('placed');

    const rows = await rebuildPoolRollup(db, { id: 'pool_1', ownerTenantId: 'root' });
    expect(rows.map(({ updatedAt: _updatedAt, ...rest }) => rest)).toEqual([
      {
        poolId: 'pool_1',
        resource: 'gpu',
        total: 40,
        allocatable: 7,
        allocated: 2,
        reserved: 1,
        available: 4,
        provisioning: 8,
        unhealthy: 9,
        maintenance: 8,
        unreachable: 8,
      },
      {
        poolId: 'pool_1',
        resource: 'vcpu',
        total: 64,
        allocatable: 64,
        allocated: 0,
        reserved: 0,
        available: 64,
        provisioning: 0,
        unhealthy: 0,
        maintenance: 0,
        unreachable: 0,
      },
    ]);
  });

  it('keeps schedulableSql and isSchedulable in agreement', async () => {
    await addNode('n1');
    await addNode('n2', { cordoned: true, gpus: 0 });
    await addNode('n3', { connectivity: 'lost', gpus: 0 });
    await addNode('n4', { provisionState: 'deployed', gpus: 0 });
    await addNode('n5', { noSchedule: ['x'], gpus: 0 });
    await db.query(
      `UPDATE nodes SET trust = 'tenant-owned', owner_tenant_id = 'other' WHERE id = 'n1'`,
    );
    await addNode('n6', { gpus: 0 });
    await db.query(`UPDATE nodes SET role = 'dedicated' WHERE id = 'n6'`);
    await addNode('n7', { gpus: 0 });
    await db.query(`UPDATE nodes SET trust = 'tenant-owned' WHERE id = 'n7'`);

    const { rows } = await db.query<{ id: string }>(
      `SELECT n.id FROM nodes n JOIN pools p ON p.id = n.pool_id WHERE ${schedulableSql} ORDER BY n.id`,
    );
    const views = await loadNodeViews(
      db,
      { id: 'pool_1', ownerTenantId: 'root' },
      { start: T0, end: T0 + HOUR },
    );
    const fromTs = views
      .filter((view) => isSchedulable(view, { ownerTenantId: 'root' }))
      .map((view) => view.id);
    expect(rows.map((row) => row.id)).toEqual(fromTs);
    expect(fromTs).toEqual(['n4', 'n7']);

    // Dedications (§10.6 dedicated=<tenant>): tolerated by that tenant only, never with another reason.
    await addNode('n8', { noSchedule: [dedicatedTaint('acme')], gpus: 0 });
    await addNode('n9', { noSchedule: [dedicatedTaint('acme'), 'x'], gpus: 0 });
    await addNode('n10', { noSchedule: [dedicatedTaint('beta')], gpus: 0 });
    await addNode('n11', { noSchedule: [dedicatedTaint('acme'), dedicatedTaint('beta')], gpus: 0 });
    const all = await loadNodeViews(
      db,
      { id: 'pool_1', ownerTenantId: 'root' },
      { start: T0, end: T0 + HOUR },
    );
    for (const tenant of ['acme', 'beta', 'gamma']) {
      const sql = await db.query<{ id: string }>(
        `SELECT n.id FROM nodes n JOIN pools p ON p.id = n.pool_id
          WHERE ${schedulableSqlTolerating('$1::text[]')} ORDER BY n.id`,
        [[dedicatedTaint(tenant)]],
      );
      const ts = all
        .filter((view) => isSchedulable(view, { ownerTenantId: 'root' }, tenant))
        .map((view) => view.id);
      expect(
        sql.rows.map((row) => row.id),
        tenant,
      ).toEqual(ts);
    }
    const forTenant = (tenant: string) =>
      all.filter((view) => isSchedulable(view, { ownerTenantId: 'root' }, tenant)).map((v) => v.id);
    expect(forTenant('acme')).toEqual(['n4', 'n7', 'n8']);
    expect(forTenant('beta')).toEqual(['n10', 'n4', 'n7']);
    expect(forTenant('gamma')).toEqual(['n4', 'n7']);
    // Generic checks (rollups) still see a dedication as NoSchedule.
    expect(
      all.filter((view) => isSchedulable(view, { ownerTenantId: 'root' })).map((v) => v.id),
    ).toEqual(['n4', 'n7']);
    // Schedulable for someone (wake-up edges): one dedication counts, a dedication plus anything
    // else or two tenants' do not; the SQL twin agrees.
    const some = await db.query<{ id: string }>(
      `SELECT n.id FROM nodes n JOIN pools p ON p.id = n.pool_id WHERE ${mayBeSchedulableSql} ORDER BY n.id`,
    );
    const someTs = all
      .filter((view) => mayBeSchedulable(view, { ownerTenantId: 'root' }))
      .map((view) => view.id);
    expect(some.rows.map((row) => row.id)).toEqual(someTs);
    expect(someTs).toEqual(['n10', 'n4', 'n7', 'n8']);
  });

  it('reports each placement to onPlacement: outcome, lost races, refusals; a throwing observer changes nothing', async () => {
    await addNode('node_a', { gpus: 2 });
    const seen: PlacementObservation[] = [];
    const observer = (observation: PlacementObservation) => {
      seen.push(observation);
      throw new Error('a broken metrics sink');
    };
    const observedPlacer = inlinePlacer({ ids, onPlacement: observer });
    const run = (req: PlacementRequest, ctx = context()) =>
      db.transaction((tx) => observedPlacer.place(tx, req, ctx));
    expect((await run(request(1))).status).toBe('placed');
    // A stale index plans a GPU that was booked since: the guarded commit loses, then it replans.
    const lost = await db.transaction(async (tx) => {
      const index = await PoolIndex.load(tx, (await readPool(tx, 'pool_1'))!, T0);
      await observedPlacer.place(tx, request(1), context());
      return placeFromIndex(tx, index, request(1), context(), { ids, onPlacement: observer });
    });
    expect(lost.status).toBe('pending'); // both GPUs are taken
    const refuse = {
      id: 'nope',
      extension: 'scheduler' as const,
      async admit() {
        throw new ComputeError('ACCESS_DENIED', 'Scheduler policy refuses');
      },
    };
    const admission = {
      tenantId: 'acme',
      identityId: 'id_1',
      identityKind: 'user' as const,
      sessionId: 's',
      sessionKind: 'user' as const,
      action: 'compute:reservations:create',
      resource: { type: 'reservation', id: 'rsv_x' },
      decidedAt: T0,
    };
    await expect(run(request(1), context({ plugins: [refuse], admission }))).rejects.toThrow(
      /refuses/,
    );
    expect(seen.map(({ placer, outcome, conflicts }) => [placer, outcome, conflicts])).toEqual([
      ['inline', 'placed', 0],
      ['inline', 'placed', 0],
      ['batch', 'pending', 1],
      ['inline', 'refused', 0],
    ]);
    expect(seen.every((entry) => entry.seconds >= 0)).toBe(true);
  });

  it('places only on nodes carrying every requested label, on every placement path', async () => {
    await addNode('node_a', { gpus: 2 });
    await addNode('node_b', { gpus: 8 });
    await db.query(
      `INSERT INTO node_labels (node_id, key, value, source)
       VALUES ('node_a', 'bc.dev/driver.kata', '3.2', 'inventory'), ('node_b', 'bc.dev/driver.kata', '3.1', 'inventory')`,
    );
    const kata = { 'bc.dev/driver.kata': '3.2' };
    // The shortlist, and the whole pool (a selector declines the shortlist): node_b would win binpack.
    expect(await place(request(1, { nodeLabels: kata }))).toMatchObject({
      status: 'placed',
      allocations: [{ nodeId: 'node_a' }],
    });
    expect(
      await place(
        request(1, {
          nodeLabels: kata,
          devices: [{ class: 'gpu', count: 1, selector: parseSelector('vramGiB >= 80') }],
        }),
      ),
    ).toMatchObject({ status: 'placed', allocations: [{ nodeId: 'node_a' }] });
    const refused = await place(request(1, { nodeLabels: kata }));
    expect(refused).toMatchObject({
      status: 'pending',
      reason: expect.stringMatching(/needs label bc\.dev\/driver\.kata=3\.2/),
    });
    // The pool index ranks per label set.
    await db.transaction(async (tx) => {
      const index = await PoolIndex.load(tx, (await readPool(tx, 'pool_1'))!, T0);
      expect(
        index
          .ranked(request(1, { nodeLabels: { 'bc.dev/driver.kata': '3.1' } }))
          .map((c) => c.nodeId),
      ).toEqual(['node_b']);
      expect(index.ranked(request(1, { nodeLabels: { 'bc.dev/driver.gvisor': '1' } }))).toEqual([]);
      // `*`: the label with any value (a driver whatever its version).
      expect(
        index
          .ranked(request(1, { nodeLabels: { 'bc.dev/driver.kata': '*' } }))
          .map((c) => c.nodeId),
      ).toEqual(['node_b']);
      expect(index.ranked(request(1, { nodeLabels: { 'bc.dev/driver.gvisor': '*' } }))).toEqual([]);
      expect(index.ranked(request(1)).map((c) => c.nodeId)).toEqual(['node_b']);
    });
  });

  it('places on a node dedicated to a tenant only for that tenant, on every placement path', async () => {
    const dedicated = await addNode('node_d', { gpus: 2, noSchedule: [dedicatedTaint('acme')] });
    await setQuota(db, 'beta', 'pool_1', 'gpu', 8);
    // Inline, whole-pool and shortlist planning.
    expect(await place(request(1, { tenantId: 'beta' }))).toMatchObject({ status: 'pending' });
    expect(
      await place(
        request(1, {
          tenantId: 'beta',
          devices: [{ class: 'gpu', count: 1, selector: parseSelector('vramGiB >= 80') }],
        }),
      ),
    ).toMatchObject({ status: 'pending' });
    expect(await place(request(1))).toMatchObject({
      status: 'placed',
      allocations: [{ nodeId: 'node_d' }],
    });
    // The pool index: its ranking is per tenant once a node is dedicated.
    const outcome = await db.transaction(async (tx) => {
      const pool = (await readPool(tx, 'pool_1'))!;
      const index = await PoolIndex.load(tx, pool, T0);
      expect(index.ranked(request(1, { tenantId: 'beta' }))).toEqual([]);
      expect(index.ranked(request(1)).map((entry) => entry.nodeId)).toEqual(['node_d']);
      const beta = await placeFromIndex(tx, index, request(1, { tenantId: 'beta' }), context());
      const acme = await placeFromIndex(tx, index, request(1), context());
      // A bulk commit of a plan for the wrong tenant is refused at the lock.
      const bulk = await commitPlansBulk(tx, pool, [
        {
          request: request(1, {
            tenantId: 'beta',
            during: { start: T0 + 2 * HOUR, end: T0 + 3 * HOUR },
          }),
          plan: { nodeId: 'node_d', atoms: [dedicated[0]!], resources: {}, score: 1, scores: {} },
        },
      ]);
      return { beta, acme, bulk };
    });
    expect(outcome.beta.status).toBe('pending');
    expect(outcome.acme).toMatchObject({ status: 'placed', allocations: [{ nodeId: 'node_d' }] });
    expect([...outcome.bulk.failed.values()]).toEqual(['node_d is no longer schedulable']);
  });

  it('re-checks requested node labels at commit (a label gone since the plan)', async () => {
    const devices = await addNode('node_l', { gpus: 1 });
    // The plan wanted a label the node no longer carries (its daemon was downgraded, say).
    const bulk = await db.transaction(async (tx) =>
      commitPlansBulk(tx, (await readPool(tx, 'pool_1'))!, [
        {
          request: request(1, { nodeLabels: { 'bc.dev/cap.instance.network-policy': '*' } }),
          plan: { nodeId: 'node_l', atoms: [devices[0]!], resources: {}, score: 1, scores: {} },
        },
      ]),
    );
    expect([...bulk.failed.values()]).toEqual([
      expect.stringContaining('bc.dev/cap.instance.network-policy'),
    ]);
    expect(await bookings()).toEqual([]);
    // Inline: nothing carries the label, so nothing is placed.
    expect(
      await place(request(1, { nodeLabels: { 'bc.dev/cap.instance.network-policy': '*' } })),
    ).toMatchObject({ status: 'pending' });
  });
});

describe('onlyNodes', () => {
  it('places only on the named nodes, inline and from the pool index', async () => {
    await addNode('node_a', { gpus: 2 });
    await addNode('node_b', { gpus: 2 });
    await addNode('node_c', { gpus: 2 });
    expect(await place(request(1, { onlyNodes: ['node_c'] }))).toMatchObject({
      status: 'placed',
      allocations: [{ nodeId: 'node_c' }],
    });
    const indexed = await db.transaction(async (tx) => {
      const index = await PoolIndex.load(tx, (await readPool(tx, 'pool_1'))!, T0);
      return placeFromIndex(tx, index, request(1, { onlyNodes: ['node_b'] }), context());
    });
    expect(indexed).toMatchObject({ status: 'placed', allocations: [{ nodeId: 'node_b' }] });
    // Named nodes that cannot take it: pending, never elsewhere.
    expect(await place(request(3, { onlyNodes: ['node_a'] }))).toMatchObject({ status: 'pending' });
  });
});

describe('archived pools', () => {
  it('take no new placements', async () => {
    await addNode('node_a', { gpus: 1 });
    await db.query(`UPDATE pools SET archived_at = compute_now() WHERE id = 'pool_1'`);
    expect(await place(request(1))).toEqual({ status: 'pending', reason: 'the pool is archived' });
    expect(await bookings()).toEqual([]);
    await db.query(`UPDATE pools SET archived_at = NULL WHERE id = 'pool_1'`);
  });
});
