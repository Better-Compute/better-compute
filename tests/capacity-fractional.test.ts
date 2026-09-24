import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PlacementRequest, SqlExecutor } from '@better-compute/core';
import { setSimClock, useSimClock } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import {
  assertSharingFits,
  bookPartitionChange,
  capacityMigrations,
  gpuFraction,
  gpuFractionSql,
  gpuSlices,
  inlinePlacer,
  meterReservations,
  parseCreatePool,
  parseSelector,
  releasePartitionChange,
  wholeGpus,
} from '@better-compute/capacity';

// Fractional GPUs (PLAN.md §10.4 point 2, §10.6, v0.5): time-slice/MPS slots and MIG instances are
// the atoms; partitioned parents are never booked; a partition change books the whole family; usage
// bills each atom's share of a GPU hour.

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

async function device(
  id: string,
  deviceClass: string,
  bookable: boolean,
  attributes: object,
  parentId?: string,
) {
  await db.query(
    `INSERT INTO devices (id, node_id, parent_id, class, bookable, healthy, attributes)
     VALUES ($1, 'node_f', $2, $3, $4, true, $5::jsonb)`,
    [id, parentId ?? null, deviceClass, bookable, JSON.stringify(attributes)],
  );
}

beforeEach(async () => {
  for (const table of [
    'usage_windows',
    'pool_capacity_rollup',
    'device_bookings',
    'allocations',
    'reservations',
    'devices',
    'nodes',
    'pools',
    'sites',
  ])
    await db.query(`DELETE FROM ${table}`);
  await useSimClock(db, T0);
  await db.query(
    `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site_f', 'root', 'shared', 'eu', 1)`,
  );
  await db.query(
    `INSERT INTO pools (id, owner_tenant_id, site_id, class, gpu_model, sharing, agent, policy, version)
     VALUES ('pool_f', 'root', 'site_f', 'metal-host', 'H100', 'timeslice', 'bcd', '{}', 1)`,
  );
  await db.query(
    `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance, cordoned, connectivity,
                        trust, generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
     VALUES ('node_f', 'site_f', 'pool_f', 'root', 'host', 'adopted', false, false, 'connected', 'platform', 1, 1, 1, 1, 0, 1)`,
  );
  // A time-sliced GPU: an unbookable parent and four slots.
  await device('GPU-TS', 'gpu', false, { gpuModel: 'H100' });
  for (let k = 0; k < 4; k++)
    await device(
      `GPU-TS/s${k}`,
      'gpu.slot',
      true,
      { gpuModel: 'H100', sharing: 'timeslice', slot: k, slots: 4 },
      'GPU-TS',
    );
  // A MIG GPU: an unbookable parent and two instances.
  await device('GPU-MIG', 'gpu', false, { gpuModel: 'H100' });
  await device(
    'GPU-MIG/gi1/ci0',
    'gpu.mig',
    true,
    { gpuModel: 'H100', migProfile: '3g.40gb' },
    'GPU-MIG',
  );
  await device(
    'GPU-MIG/gi2/ci0',
    'gpu.mig',
    true,
    { gpuModel: 'H100', migProfile: '4g.40gb' },
    'GPU-MIG',
  );
});

const placer = inlinePlacer();
const context = { clock: { now: () => T0 }, random: () => 0, plugins: [], weights: {}, topN: 1 };
let sequence = 0;
const place = (devices: PlacementRequest['devices'], during = { start: T0, end: T0 + HOUR }) =>
  db.transaction((tx) =>
    placer.place(
      tx,
      { tenantId: 'acme', poolId: 'pool_f', reservationId: `rsv_${++sequence}`, devices, during },
      context,
    ),
  );
const booked = async () =>
  (
    await db.query<{ device_id: string }>(
      `SELECT device_id FROM device_bookings ORDER BY device_id`,
    )
  ).rows.map((row) => row.device_id);

describe('placing fractional atoms', () => {
  it('books slots and MIG instances, never a partitioned parent', async () => {
    const slots = await place([{ class: 'gpu.slot', count: 3 }]);
    expect(slots).toMatchObject({ status: 'placed' });
    const mig = await place([
      { class: 'gpu.mig', count: 1, selector: parseSelector('migProfile in (4g.40gb)') },
    ]);
    expect(mig).toMatchObject({ status: 'placed', allocations: [{ atoms: ['GPU-MIG/gi2/ci0'] }] });
    expect(await booked()).toEqual(['GPU-MIG/gi2/ci0', 'GPU-TS/s0', 'GPU-TS/s1', 'GPU-TS/s2']);
    expect(await place([{ class: 'gpu', count: 1 }])).toMatchObject({ status: 'pending' });
    expect(await place([{ class: 'gpu.slot', count: 2 }])).toMatchObject({ status: 'pending' });
  });
});

describe('partition changes (the atom rule)', () => {
  it('book the whole family only when nothing of the GPU is booked, and block new atoms meanwhile', async () => {
    expect(await place([{ class: 'gpu.slot', count: 1 }])).toMatchObject({ status: 'placed' });
    const early = await db.transaction((tx) =>
      bookPartitionChange(tx, {
        gpuId: 'GPU-TS',
        during: { start: T0 + 30 * 60_000, end: T0 + 2 * HOUR },
      }),
    );
    expect(early).toEqual({ status: 'conflict', freeFrom: T0 + HOUR });
    expect(await booked()).toEqual(['GPU-TS/s0']); // all-or-nothing

    const window = { start: T0 + HOUR, end: T0 + 2 * HOUR };
    const change = await db.transaction((tx) =>
      bookPartitionChange(tx, { gpuId: 'GPU-TS', during: window }),
    );
    expect(change).toMatchObject({
      status: 'booked',
      atoms: ['GPU-TS', 'GPU-TS/s0', 'GPU-TS/s1', 'GPU-TS/s2', 'GPU-TS/s3'],
    });
    expect(await place([{ class: 'gpu.slot', count: 1 }], window)).toMatchObject({
      status: 'pending',
    });
    // The other GPU's family is untouched.
    expect(await place([{ class: 'gpu.mig', count: 1 }], window)).toMatchObject({
      status: 'placed',
    });

    if (change.status !== 'booked') return;
    expect(await db.transaction((tx) => releasePartitionChange(tx, change.bookingId))).toBe(5);
    expect(await db.transaction((tx) => releasePartitionChange(tx, change.bookingId))).toBe(0);
    expect(await place([{ class: 'gpu.slot', count: 1 }], window)).toMatchObject({
      status: 'placed',
    });
    await expect(
      db.transaction((tx) => bookPartitionChange(tx, { gpuId: 'GPU-NONE', during: window })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      db.transaction((tx) => releasePartitionChange(tx, 'alloc_x')),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });
});

describe('fractional metering', () => {
  it('agrees in SQL and TypeScript on every atom kind', async () => {
    await device(
      'GPU-MPS/s0',
      'gpu.slot',
      true,
      { sharing: 'mps', slots: 10, mpsUnits: 10 },
      'GPU-TS',
    );
    await device('GPU-X', 'gpu', true, {});
    await device('GPU-MIG/gi3/ci0', 'gpu.mig', true, { migProfile: 'weird' }, 'GPU-MIG');
    const { rows } = await db.query<{
      id: string;
      class: string;
      attributes: Record<string, string | number | boolean>;
      f: string;
    }>(
      `SELECT d.id, d.class, d.attributes, (${gpuFractionSql('d')})::text AS f FROM devices d ORDER BY d.id`,
    );
    for (const row of rows)
      expect(Number(row.f), row.id).toBeCloseTo(gpuFraction(row.class, row.attributes), 9);
    expect(gpuFraction('gpu.slot', { slots: 4 })).toBe(0.25);
    expect(gpuFraction('gpu.slot', { mpsUnits: 10, slots: 10 })).toBe(0.1);
    expect(gpuFraction('gpu.mig', { migProfile: '3g.40gb' })).toBeCloseTo(3 / 7, 12);
    expect(gpuFraction('nic.vf', {})).toBe(0);
  });

  it('bills slots and MIG instances as their share of a GPU hour', async () => {
    await db.query(
      `INSERT INTO reservations (id, tenant_id, pool_id, state, request, request_hash, owner_identity_id, idempotency_key, version)
       VALUES ('rsv_m', 'acme', 'pool_f', 'active', '{}', '\\x00', 'usr_alice', 'k', 1)`,
    );
    await db.query(
      `INSERT INTO allocations (id, tenant_id, pool_id, node_id, owner_kind, owner_id, atoms, during, bound_at, version)
       VALUES ('alloc_m', 'acme', 'pool_f', 'node_f', 'reservation', 'rsv_m', ARRAY['GPU-TS/s0', 'GPU-TS/s1', 'GPU-MIG/gi1/ci0'],
               tstzrange($1::timestamptz, $2::timestamptz), $1::timestamptz, 1)`,
      [new Date(T0).toISOString(), new Date(T0 + HOUR).toISOString()],
    );
    await setSimClock(db, T0 + HOUR);
    await db.transaction((tx) => meterReservations(tx, T0 + HOUR));
    const { rows } = await db.query<{ meter: string; quantity: string }>(
      `SELECT meter, quantity::text FROM usage_windows`,
    );
    expect(rows.map((row) => row.meter)).toEqual(['gpu.h100.hours']);
    expect(Number(rows[0]!.quantity)).toBeCloseTo(0.5 + 3 / 7, 5);
  });
});

describe('sharing rules at admission', () => {
  it('match device classes to the pool sharing mode, and count whole GPUs apart from slices', () => {
    expect(() => assertSharingFits([{ class: 'gpu.slot', count: 1 }], 'timeslice')).not.toThrow();
    expect(() => assertSharingFits([{ class: 'gpu.slot', count: 1 }], 'mps')).not.toThrow();
    expect(() => assertSharingFits([{ class: 'gpu.slot', count: 1 }], 'exclusive')).toThrow(
      /timeslice or mps/,
    );
    expect(() => assertSharingFits([{ class: 'gpu.mig', count: 1 }], 'timeslice')).toThrow(
      /mig pools/,
    );
    expect(() =>
      assertSharingFits([{ class: 'gpu', count: 1, sharing: 'mps' }], 'timeslice'),
    ).toThrow(/shares GPUs as timeslice/);
    expect(() => assertSharingFits([{ class: 'gpu', count: 1 }], 'mig')).not.toThrow();
    const devices = [
      { class: 'gpu' as const, count: 2 },
      { class: 'gpu.slot' as const, count: 3 },
      { class: 'gpu.mig' as const, count: 1 },
    ];
    expect([wholeGpus(devices), gpuSlices(devices)]).toEqual([2, 4]);
  });

  it('accepts shared pools', () => {
    for (const sharing of ['mig', 'timeslice', 'mps'])
      expect(
        parseCreatePool({
          tenantId: 'root',
          siteId: 'site_01jz00000000000000000000aa',
          class: 'metal-host',
          sharing,
        }).sharing,
      ).toBe(sharing);
  });
});
