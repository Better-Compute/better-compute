import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SqlExecutor } from '@better-compute/core';
import { setSimClock, useSimClock } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import {
  capacityMigrations,
  capacityModule,
  gpuMeter,
  hourlyWindows,
  meterAllocation,
  meterReservations,
  usageKey,
} from '@better-compute/capacity';

// Usage metering (PLAN.md §12.7, D14): hourly `usage_windows` per allocation, billed on reserved
// time from `active` to release, final-only and idempotent.

const T0 = Date.UTC(2026, 8, 24, 12);
const MIN = 60_000;
const HOUR = 60 * MIN;
let db: SqlExecutor;

beforeAll(async () => {
  db = pglite();
  await db.migrate([...capacityMigrations]);
});
afterAll(async () => {
  await db.close();
});

const iso = (ms: number) => new Date(ms).toISOString();

beforeEach(async () => {
  for (const table of [
    'usage_windows',
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
    `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site_u', 'root', 'shared', 'eu-central', 1)`,
  );
  await db.query(
    `INSERT INTO pools (id, owner_tenant_id, site_id, class, gpu_model, sharing, agent, policy, version)
     VALUES ('pool_u', 'root', 'site_u', 'metal-host', 'H100', 'exclusive', 'bcd', '{}', 1)`,
  );
  await db.query(
    `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance, cordoned, connectivity,
                        trust, generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
     VALUES ('node_u', 'site_u', 'pool_u', 'root', 'host', 'adopted', false, false, 'connected', 'platform', 1, 1, 1, 1, 0, 1)`,
  );
  for (let index = 0; index < 4; index++)
    await db.query(
      `INSERT INTO devices (id, node_id, class, bookable, healthy, attributes) VALUES ($1, 'node_u', 'gpu', true, true, '{}')`,
      [`g${index}`],
    );
});

interface Seed {
  id: string;
  gpus: number;
  start: number;
  end: number;
  boundAt?: number;
  releasedAt?: number;
  delegated?: boolean;
  projectId?: string;
}

async function seed(entry: Seed): Promise<void> {
  await db.query(
    `INSERT INTO reservations (id, tenant_id, pool_id, project_id, state, request, request_hash, owner_identity_id,
                               agent_id, delegation_id, idempotency_key, version)
     VALUES ($1, 'acme', 'pool_u', $2, 'active', '{}', '\\x00', 'usr_alice', $3, $4, $1, 1)`,
    [
      entry.id,
      entry.projectId ?? null,
      entry.delegated ? 'agt_7' : null,
      entry.delegated ? 'dlg_7' : null,
    ],
  );
  await db.query(
    `INSERT INTO allocations (id, tenant_id, pool_id, node_id, owner_kind, owner_id, atoms, resources, during,
                              bound_at, released_at, version)
     VALUES ($1, 'acme', 'pool_u', 'node_u', 'reservation', $2, $3::text[], '{}',
             tstzrange($4::timestamptz, $5::timestamptz), $6::timestamptz, $7::timestamptz, 1)`,
    [
      `alloc_${entry.id}`,
      entry.id,
      Array.from({ length: entry.gpus }, (_, index) => `g${index}`),
      iso(entry.start),
      iso(entry.end),
      entry.boundAt === undefined ? null : iso(entry.boundAt),
      entry.releasedAt === undefined ? null : iso(entry.releasedAt),
    ],
  );
}

async function windows() {
  const { rows } = await db.query<{
    idempotency_key: string;
    identity_id: string | null;
    meter: string;
    quantity: string;
    start_ms: number;
    tags: Record<string, string>;
  }>(
    `SELECT idempotency_key, identity_id, meter, quantity::text, tags,
            (extract(epoch FROM window_start) * 1000)::float8 AS start_ms
       FROM usage_windows ORDER BY window_start, idempotency_key`,
  );
  return rows.map((row) => ({ ...row, quantity: Number(row.quantity) }));
}

describe('hourlyWindows and keys', () => {
  it('splits an interval into hour-aligned windows with the used fraction', () => {
    expect(hourlyWindows(T0 + 30 * MIN, T0 + 2 * HOUR + 15 * MIN)).toEqual([
      { start: T0, end: T0 + HOUR, fraction: 0.5 },
      { start: T0 + HOUR, end: T0 + 2 * HOUR, fraction: 1 },
      { start: T0 + 2 * HOUR, end: T0 + 3 * HOUR, fraction: 0.25 },
    ]);
    expect(hourlyWindows(T0, T0)).toEqual([]);
    expect(hourlyWindows(T0 + HOUR, T0)).toEqual([]);
    expect(usageKey('alloc_1', T0)).toBe(`cmp:alloc_1:${T0}`);
    expect(usageKey('alloc_1', T0, 'vps.memory.gib.hours')).toBe(
      `cmp:alloc_1:${T0}:vps.memory.gib.hours`,
    );
    expect(gpuMeter('H100')).toBe('gpu.h100.hours');
    expect(gpuMeter(undefined)).toBe('gpu.other.hours');
  });
});

describe('meterReservations', () => {
  it('bills closed hours from active, then the partial last hour once released, exactly once', async () => {
    await seed({
      id: 'rsv_a',
      gpus: 2,
      start: T0,
      end: T0 + 8 * HOUR,
      boundAt: T0 + 10 * MIN,
      projectId: 'prj_1',
    });
    const now1 = T0 + 2 * HOUR + 10 * MIN;
    await setSimClock(db, now1);
    expect(await db.transaction((tx) => meterReservations(tx, now1))).toEqual({
      allocations: 1,
      windows: 2,
    });
    expect(await windows()).toEqual([
      {
        idempotency_key: `cmp:alloc_rsv_a:${T0}`,
        identity_id: 'usr_alice',
        meter: 'gpu.h100.hours',
        quantity: Number(((2 * 50) / 60).toFixed(6)),
        start_ms: T0,
        tags: { region: 'eu-central', pool: 'pool_u', gpuModel: 'H100', project: 'prj_1' },
      },
      expect.objectContaining({ quantity: 2, start_ms: T0 + HOUR }),
    ]);
    // Repeating the pass writes nothing new.
    expect((await db.transaction((tx) => meterReservations(tx, now1))).windows).toBe(0);

    // Released at 2h40m: the open hour becomes final at 40/60.
    await db.query(`UPDATE allocations SET released_at = $1::timestamptz`, [
      iso(T0 + 2 * HOUR + 40 * MIN),
    ]);
    const now2 = T0 + 2 * HOUR + 45 * MIN;
    await setSimClock(db, now2);
    expect((await db.transaction((tx) => meterReservations(tx, now2))).windows).toBe(1);
    const all = await windows();
    expect(all.map((row) => row.quantity)).toEqual([
      Number((100 / 60).toFixed(6)),
      2,
      Number((80 / 60).toFixed(6)),
    ]);
    expect(all.reduce((sum, row) => sum + row.quantity, 0)).toBeCloseTo(
      (2 * (2 * 60 + 30)) / 60,
      4,
    );
    const later = T0 + 10 * HOUR;
    await setSimClock(db, later);
    expect((await db.transaction((tx) => meterReservations(tx, later))).windows).toBe(0);
  });

  it('bills until the booked end when never released, and nothing for allocations that never went active', async () => {
    await seed({ id: 'rsv_b', gpus: 1, start: T0, end: T0 + 90 * MIN, boundAt: T0 });
    await seed({ id: 'rsv_c', gpus: 4, start: T0, end: T0 + 5 * HOUR });
    const now = T0 + 3 * HOUR;
    await setSimClock(db, now);
    await db.transaction((tx) => meterReservations(tx, now));
    const all = await windows();
    expect(all.map((row) => [row.idempotency_key, row.quantity])).toEqual([
      [`cmp:alloc_rsv_b:${T0}`, 1],
      [`cmp:alloc_rsv_b:${T0 + HOUR}`, 0.5],
    ]);
  });

  it('bills delegated work to the person with an agent tag', async () => {
    await seed({ id: 'rsv_d', gpus: 1, start: T0, end: T0 + HOUR, boundAt: T0, delegated: true });
    const now = T0 + 2 * HOUR;
    await setSimClock(db, now);
    await db.transaction((tx) => meterReservations(tx, now));
    expect(await windows()).toEqual([
      expect.objectContaining({
        identity_id: 'usr_alice',
        tags: expect.objectContaining({ agent: 'agt_7' }),
      }),
    ]);
  });

  it('skips allocations that ended before the lookback', async () => {
    await seed({ id: 'rsv_e', gpus: 1, start: T0, end: T0 + HOUR, boundAt: T0 });
    const now = T0 + 72 * HOUR;
    await setSimClock(db, now);
    expect(await db.transaction((tx) => meterReservations(tx, now))).toEqual({
      allocations: 0,
      windows: 0,
    });
  });

  it('runs as the capacity.usage periodic job', async () => {
    const module = capacityModule();
    const usage = module.reconcilers!.find((reconciler) => reconciler.name === 'capacity.usage')!;
    expect(usage.periodic).toEqual([{ key: 'all', every: '5m' }]);
    await seed({ id: 'rsv_f', gpus: 3, start: T0, end: T0 + HOUR, boundAt: T0 });
    const now = T0 + HOUR;
    await setSimClock(db, now);
    await usage.run(
      { sql: db, clock: { now: () => now }, signal: new AbortController().signal } as never,
      'all',
    );
    expect((await windows()).map((row) => row.quantity)).toEqual([3]);
  });
});

describe('meterAllocation', () => {
  it('writes one key per extra meter and skips zero lines', async () => {
    await seed({ id: 'rsv_g', gpus: 0, start: T0, end: T0 + HOUR });
    const written = await db.transaction((tx) =>
      meterAllocation(
        tx,
        {
          allocationId: 'alloc_rsv_g',
          tenantId: 'acme',
          lines: [
            { meter: 'vps.vcpu.hours', perHour: 4 },
            { meter: 'vps.memory.gib.hours', perHour: 16 },
            { meter: 'gpu.l40s.hours', perHour: 0 },
          ],
          tags: { pool: 'pool_u', project: '' },
          from: T0,
          to: T0 + HOUR,
        },
        T0 + HOUR,
      ),
    );
    expect(written).toBe(2);
    expect(
      (await windows()).map((row) => [
        row.idempotency_key,
        row.meter,
        row.quantity,
        row.identity_id,
        row.tags,
      ]),
    ).toEqual([
      [`cmp:alloc_rsv_g:${T0}`, 'vps.vcpu.hours', 4, null, { pool: 'pool_u' }],
      [
        `cmp:alloc_rsv_g:${T0}:vps.memory.gib.hours`,
        'vps.memory.gib.hours',
        16,
        null,
        { pool: 'pool_u' },
      ],
    ]);
  });
});
