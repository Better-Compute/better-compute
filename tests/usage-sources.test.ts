import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SqlExecutor } from '@better-compute/core';
import { setSimClock, useSimClock } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import { capacityMigrations, meterAllocation, meterReservations } from '@better-compute/capacity';

// Generalized usage sources (D2, core/0031): every source writes `usage_windows` that the one `iam.usage` flush
// records, and allocation windows keep their keys and amounts (B8).

const T0 = Date.UTC(2026, 8, 24, 12);
const MIN = 60_000;
const HOUR = 60 * MIN;
const iso = (ms: number) => new Date(ms).toISOString();
const goldenPath = new URL('./fixtures/usage-allocation-golden.json', import.meta.url);

let db: SqlExecutor;

beforeAll(async () => {
  db = pglite();
  await db.migrate([...capacityMigrations]);
});
afterAll(async () => {
  await db.close();
});

async function fleet(): Promise<void> {
  for (const table of [
    'usage_windows',
    'capacity_lease_health',
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
  const devices: [string, string, boolean, Record<string, unknown>][] = [
    ['g0', 'gpu', true, {}],
    ['g1', 'gpu', true, {}],
    ['g2', 'gpu', true, {}],
    ['g3', 'gpu', false, {}],
    ['m0', 'gpu.mig', true, { migProfile: '3g.40gb' }],
    ['s0', 'gpu.slot', true, { slots: 4 }],
    ['s1', 'gpu.slot', true, { mpsUnits: 25 }],
  ];
  for (const [id, cls, healthy, attributes] of devices)
    await db.query(
      `INSERT INTO devices (id, node_id, class, bookable, healthy, attributes) VALUES ($1, 'node_u', $2, true, $3, $4::jsonb)`,
      [id, cls, healthy, JSON.stringify(attributes)],
    );
}

interface Seed {
  id: string;
  atoms: string[];
  start: number;
  end: number;
  boundAt?: number;
  releasedAt?: number;
  delegated?: boolean;
  projectId?: string;
  request?: Record<string, unknown>;
}

async function seed(entry: Seed): Promise<void> {
  await db.query(
    `INSERT INTO reservations (id, tenant_id, pool_id, project_id, state, request, request_hash, owner_identity_id,
                               agent_id, delegation_id, idempotency_key, version)
     VALUES ($1, 'acme', 'pool_u', $2, 'active', $5::jsonb, '\\x00', 'usr_alice', $3, $4, $1, 1)`,
    [
      entry.id,
      entry.projectId ?? null,
      entry.delegated ? 'agt_7' : null,
      entry.delegated ? 'dlg_7' : null,
      JSON.stringify(entry.request ?? {}),
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
      entry.atoms,
      iso(entry.start),
      iso(entry.end),
      entry.boundAt === undefined ? null : iso(entry.boundAt),
      entry.releasedAt === undefined ? null : iso(entry.releasedAt),
    ],
  );
}

interface GoldenRow {
  key: string;
  allocationId: string;
  tenantId: string;
  identityId: string | null;
  meter: string;
  quantity: string;
  start: number;
  end: number;
  tags: Record<string, string>;
}

async function allocationRows(): Promise<GoldenRow[]> {
  const { rows } = await db.query<{
    idempotency_key: string;
    allocation_id: string;
    tenant_id: string;
    identity_id: string | null;
    meter: string;
    quantity: string;
    start_ms: number;
    end_ms: number;
    tags: Record<string, string>;
  }>(
    `SELECT idempotency_key, allocation_id, tenant_id, identity_id, meter, quantity::text, tags,
            (extract(epoch FROM window_start) * 1000)::float8 AS start_ms,
            (extract(epoch FROM window_end) * 1000)::float8 AS end_ms
       FROM usage_windows ORDER BY idempotency_key`,
  );
  return rows.map((row) => ({
    key: row.idempotency_key,
    allocationId: row.allocation_id,
    tenantId: row.tenant_id,
    identityId: row.identity_id,
    meter: row.meter,
    quantity: row.quantity,
    start: Number(row.start_ms),
    end: Number(row.end_ms),
    tags: row.tags,
  }));
}

/**
 * Every shape of allocation metering there is: a reservation released mid-hour, spot MIG and slot atoms, a node
 * lease whose unhealthy GPU heals between windows, delegated work, and a direct multi-line `meterAllocation` with
 * per-window lines. Passes run at several times, as the `capacity.usage` job does.
 */
async function runAllocationScenario(): Promise<{ written: number[] }> {
  await fleet();
  await seed({
    id: 'rsv_a',
    atoms: ['g0', 'g1'],
    start: T0,
    end: T0 + 8 * HOUR,
    boundAt: T0 + 10 * MIN,
    releasedAt: T0 + 2 * HOUR + 40 * MIN,
    projectId: 'prj_1',
  });
  await seed({
    id: 'rsv_s',
    atoms: ['m0', 's0', 's1'],
    start: T0,
    end: T0 + 3 * HOUR,
    boundAt: T0 + 5 * MIN,
    request: { spot: true },
  });
  await seed({
    id: 'rsv_n',
    atoms: ['g2', 'g3'],
    start: T0,
    end: T0 + 4 * HOUR,
    boundAt: T0,
    request: { binding: 'node' },
  });
  await seed({
    id: 'rsv_d',
    atoms: ['g0'],
    start: T0 + 4 * HOUR,
    end: T0 + 5 * HOUR + 20 * MIN,
    boundAt: T0 + 4 * HOUR,
    delegated: true,
  });
  await seed({ id: 'rsv_v', atoms: [], start: T0, end: T0 + 3 * HOUR });
  const written: number[] = [];
  const pass = async (now: number) => {
    await setSimClock(db, now);
    written.push((await db.transaction((tx) => meterReservations(tx, now))).windows);
  };
  await pass(T0 + MIN);
  await pass(T0 + HOUR + 2 * MIN);
  await db.query(`UPDATE devices SET healthy = true WHERE id = 'g3'`);
  await pass(T0 + 2 * HOUR + 3 * MIN);
  await pass(T0 + 2 * HOUR + 45 * MIN);
  await pass(T0 + 5 * HOUR);
  await pass(T0 + 7 * HOUR);
  await pass(T0 + 7 * HOUR);
  // A vps-style allocation: several meters, one changing per window.
  written.push(
    await db.transaction((tx) =>
      meterAllocation(
        tx,
        {
          allocationId: 'alloc_rsv_v',
          tenantId: 'acme',
          identityId: 'usr_bob',
          lines: [
            { meter: 'vps.vcpu.hours', perHour: 4 },
            { meter: 'vps.memory.gib.hours', perHour: 16 },
          ],
          linesAt: (start) => [
            { meter: 'vps.vcpu.hours', perHour: start === T0 + HOUR ? 2 : 4 },
            { meter: 'vps.memory.gib.hours', perHour: 16 },
            { meter: 'gpu.l40s.hours', perHour: start === T0 ? 0 : 1 },
          ],
          tags: { region: 'eu-central', pool: 'pool_u', project: '', agent: 'agt_9' },
          from: T0 + 20 * MIN,
          to: T0 + 2 * HOUR + 50 * MIN,
        },
        T0 + 2 * HOUR + 10 * MIN,
      ),
    ),
  );
  return { written };
}

describe('allocation windows keep their keys and amounts', () => {
  // The fixture was written by this scenario on f37b1e97, before core/0031 and meterSource existed.
  it('matches the golden fixture captured before usage sources', async () => {
    const { written } = await runAllocationScenario();
    const rows = await allocationRows();
    const golden = JSON.parse(readFileSync(goldenPath, 'utf8')) as {
      written: number[];
      rows: GoldenRow[];
    };
    expect(written).toEqual(golden.written);
    expect(rows).toEqual(golden.rows);
    expect(rows.length).toBeGreaterThan(20);
  });
});
