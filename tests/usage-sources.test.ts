import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import type { IamPort, SqlExecutor, UsageEvent, UsageResult } from '@better-compute/core';
import {
  baseMigrations,
  pruneUsageWindows,
  setSimClock,
  useSimClock,
} from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import {
  capacityMigrations,
  meterAllocation,
  meterReservations,
  meterSource,
  sourceUsageKey,
} from '@better-compute/capacity';
import { flushUsageWindows, recordUsageIsolated, type UsageInputLike } from '@better-compute/iam';

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

describe('allocation windows after core/0031', () => {
  it('are source_kind allocation with no source_id, and their unique key still holds', async () => {
    await runAllocationScenario();
    const { rows } = await db.query<{
      source_kind: string;
      source_id: string | null;
      count: number;
    }>(`SELECT source_kind, source_id, count(*)::int AS count FROM usage_windows GROUP BY 1, 2`);
    expect(rows).toEqual([{ source_kind: 'allocation', source_id: null, count: 21 }]);
    // (allocation_id, window_start, meter) is still unique for allocations, whatever the key.
    await expect(
      db.query(
        `INSERT INTO usage_windows (idempotency_key, allocation_id, tenant_id, meter, quantity, window_start, window_end)
         VALUES ('cmp:other', 'alloc_rsv_a', 'acme', 'gpu.h100.hours', 1, $1, $2)`,
        [iso(T0), iso(T0 + HOUR)],
      ),
    ).rejects.toThrow(/unique|duplicate/i);
  });
});

async function sourceRows() {
  const { rows } = await db.query<{
    idempotency_key: string;
    allocation_id: string | null;
    source_kind: string;
    source_id: string | null;
    tenant_id: string;
    identity_id: string | null;
    meter: string;
    quantity: string;
    start_ms: number;
    end_ms: number;
    tags: Record<string, string>;
  }>(
    `SELECT idempotency_key, allocation_id, source_kind, source_id, tenant_id, identity_id, meter, quantity::text,
            tags, (extract(epoch FROM window_start) * 1000)::float8 AS start_ms,
            (extract(epoch FROM window_end) * 1000)::float8 AS end_ms
       FROM usage_windows ORDER BY window_start, idempotency_key`,
  );
  return rows.map((row) => ({
    ...row,
    quantity: Number(row.quantity),
    start_ms: Number(row.start_ms),
    end_ms: Number(row.end_ms),
  }));
}

describe('meterSource', () => {
  beforeEach(fleet);

  it('builds D2 keys: cmp:<kind>:<id>:<windowStartMs>[:<meter>]', () => {
    expect(sourceUsageKey('instance', 'vm_1', T0)).toBe(`cmp:instance:vm_1:${T0}`);
    expect(sourceUsageKey('grant', 'grt_1', T0, 'vm.gpu.h100.hours')).toBe(
      `cmp:grant:grt_1:${T0}:vm.gpu.h100.hours`,
    );
  });

  it('meterSource writes hourly windows with D2 keys and is idempotent', async () => {
    const input = {
      sourceKind: 'instance' as const,
      sourceId: 'vm_1',
      tenantId: 'acme',
      identityId: 'usr_alice',
      lines: [
        { meter: 'vm.vcpu.hours', perHour: 8 },
        { meter: 'vm.memory.gib.hours', perHour: 32 },
        { meter: 'vm.gpu.h100.hours', perHour: 0 },
      ],
      from: T0 + 30 * MIN,
      to: T0 + 3 * HOUR,
      tags: {
        region: 'us-central1',
        pool: 'pool_u',
        provider: 'gcp',
        flavor: 'n2-standard-8',
        source: 'instance',
        // Not a D19 key: never written.
        agent: 'agt_1',
        project: '',
      },
    };
    // Only whole ended hours: at 2h10m the hours [0,1) and [1,2) are final, [2,3) is still open.
    const now1 = T0 + 2 * HOUR + 10 * MIN;
    expect(await db.transaction((tx) => meterSource(tx, input, now1))).toBe(4);
    expect(await db.transaction((tx) => meterSource(tx, input, now1))).toBe(0);
    const tags = {
      region: 'us-central1',
      pool: 'pool_u',
      provider: 'gcp',
      flavor: 'n2-standard-8',
      source: 'instance',
    };
    expect(await sourceRows()).toEqual([
      {
        idempotency_key: `cmp:instance:vm_1:${T0}:vm.memory.gib.hours`,
        allocation_id: null,
        source_kind: 'instance',
        source_id: 'vm_1',
        tenant_id: 'acme',
        identity_id: 'usr_alice',
        meter: 'vm.memory.gib.hours',
        quantity: 16,
        start_ms: T0,
        end_ms: T0 + HOUR,
        tags,
      },
      expect.objectContaining({
        idempotency_key: `cmp:instance:vm_1:${T0}:vm.vcpu.hours`,
        quantity: 4,
        tags,
      }),
      expect.objectContaining({
        idempotency_key: `cmp:instance:vm_1:${T0 + HOUR}:vm.memory.gib.hours`,
        quantity: 32,
      }),
      expect.objectContaining({
        idempotency_key: `cmp:instance:vm_1:${T0 + HOUR}:vm.vcpu.hours`,
        quantity: 8,
      }),
    ]);
    // Once the hour closes, the last window is written, once; a longer span repeats nothing.
    const now2 = T0 + 4 * HOUR;
    expect(await db.transaction((tx) => meterSource(tx, input, now2))).toBe(2);
    expect(await db.transaction((tx) => meterSource(tx, { ...input, from: T0 }, now2))).toBe(0);
    const rows = await sourceRows();
    expect(rows).toHaveLength(6);
    expect(rows.filter((row) => row.meter === 'vm.vcpu.hours').map((row) => row.quantity)).toEqual([
      4, 8, 8,
    ]);
    // The same span under another kind is another source.
    expect(
      await db.transaction((tx) =>
        meterSource(tx, { ...input, sourceKind: 'grant', lines: input.lines.slice(0, 1) }, now2),
      ),
    ).toBe(3);
  });

  it('month split', async () => {
    const midnight = Date.UTC(2026, 9, 1);
    const written = await db.transaction((tx) =>
      meterSource(
        tx,
        {
          sourceKind: 'network',
          sourceId: 'net_1',
          tenantId: 'acme',
          lines: [{ meter: 'net.egress.gib', perHour: 1 }],
          from: midnight - 30 * MIN,
          to: midnight + 30 * MIN,
          tags: { region: 'eu-central', source: 'network' },
        },
        midnight + 2 * HOUR,
      ),
    );
    expect(written).toBe(2);
    expect(
      (await sourceRows()).map((row) => [
        row.idempotency_key,
        row.start_ms,
        row.quantity,
        row.identity_id,
      ]),
    ).toEqual([
      [`cmp:network:net_1:${midnight - HOUR}:net.egress.gib`, midnight - HOUR, 0.5, null],
      [`cmp:network:net_1:${midnight}:net.egress.gib`, midnight, 0.5, null],
    ]);
  });

  it('refuses windows that break the source constraint', async () => {
    await expect(
      db.query(
        `INSERT INTO usage_windows (idempotency_key, source_kind, tenant_id, meter, quantity, window_start, window_end)
         VALUES ('cmp:instance:x:1', 'instance', 'acme', 'm', 1, $1, $2)`,
        [iso(T0), iso(T0 + HOUR)],
      ),
    ).rejects.toThrow(/usage_windows_source_ck/);
    await expect(
      db.query(
        `INSERT INTO usage_windows (idempotency_key, tenant_id, meter, quantity, window_start, window_end)
         VALUES ('cmp:x:1', 'acme', 'm', 1, $1, $2)`,
        [iso(T0), iso(T0 + HOUR)],
      ),
    ).rejects.toThrow(/usage_windows_source_ck/);
    await expect(
      db.query(
        `INSERT INTO usage_windows (idempotency_key, source_kind, source_id, tenant_id, meter, quantity, window_start,
                                    window_end)
         VALUES ('cmp:address:x:1', 'address', 'x', 'acme', 'm', 1, $1, $2)`,
        [iso(T0), iso(T0 + HOUR)],
      ),
    ).rejects.toThrow(/check constraint/);
  });
});

describe('the iam.usage flush over sources', () => {
  beforeEach(async () => {
    await fleet();
    await db.query('DELETE FROM usage_dead_letters');
  });

  const recorder = (sent: UsageEvent[]): Pick<IamPort, 'recordUsage'> => ({
    async recordUsage(events) {
      sent.push(...events);
      return events.map(
        (event): UsageResult => ({ idempotencyKey: event.idempotencyKey, status: 'recorded' }),
      );
    },
  });

  it('the flush records instance-source windows and skips voided ones', async () => {
    const now = T0 + 3 * HOUR;
    await setSimClock(db, now);
    await db.transaction((tx) =>
      meterSource(
        tx,
        {
          sourceKind: 'instance',
          sourceId: 'vm_1',
          tenantId: 'acme',
          identityId: 'usr_alice',
          lines: [{ meter: 'vm.instance.hours', perHour: 1 }],
          from: T0,
          to: T0 + 2 * HOUR,
          tags: { provider: 'gcp', source: 'instance' },
        },
        now,
      ),
    );
    await db.query(
      `UPDATE usage_windows SET voided_at = compute_now(), void_reason = 'test' WHERE window_start = $1`,
      [iso(T0 + HOUR)],
    );
    const sent: UsageEvent[] = [];
    expect(await flushUsageWindows(db, recorder(sent))).toEqual({
      sent: 1,
      deadLettered: 0,
      more: false,
    });
    expect(sent).toEqual([
      {
        tenantId: 'acme',
        identityId: 'usr_alice',
        meter: 'vm.instance.hours',
        quantity: 1,
        occurredAt: T0,
        tags: { provider: 'gcp', source: 'instance' },
        idempotencyKey: `cmp:instance:vm_1:${T0}:vm.instance.hours`,
      },
    ]);
    const { rows } = await db.query<{ start_ms: number; outcome: string | null }>(
      `SELECT (extract(epoch FROM window_start) * 1000)::float8 AS start_ms, outcome FROM usage_windows
        ORDER BY window_start`,
    );
    expect(rows.map((row) => [Number(row.start_ms), row.outcome])).toEqual([
      [T0, 'recorded'],
      [T0 + HOUR, null],
    ]);
    // The voided window stays out of every later pass.
    expect(await flushUsageWindows(db, recorder([]))).toEqual({
      sent: 0,
      deadLettered: 0,
      more: false,
    });
  });

  it('sends a window with cost_micros with its cost in currency units', async () => {
    const now = T0 + 3 * HOUR;
    await setSimClock(db, now);
    await db.query(
      `INSERT INTO usage_windows (idempotency_key, source_kind, source_id, tenant_id, meter, quantity, cost_micros,
                                  window_start, window_end, tags)
       VALUES ($1, 'cost', 'gcp:2026-09', 'acme', 'provider.cost', 1, 12345678, $2, $3, '{"provider":"gcp"}')`,
      [`cmp:cost:gcp:2026-09:${T0}`, iso(T0), iso(T0 + HOUR)],
    );
    const sent: UsageEvent[] = [];
    await flushUsageWindows(db, recorder(sent));
    expect(sent).toEqual([
      expect.objectContaining({ meter: 'provider.cost', quantity: 1, cost: 12.345678 }),
    ]);
  });

  it('the bridges hand UsageEvent.cost to better-iam as cost', async () => {
    const inputs: UsageInputLike[] = [];
    const billing = {
      async recordMany(events: UsageInputLike[]) {
        inputs.push(...events);
        return events.map(() => ({ duplicate: false }));
      },
      async record(event: UsageInputLike) {
        inputs.push(event);
        return { duplicate: false };
      },
    };
    const base = { tenantId: 'acme', quantity: 1, occurredAt: T0, tags: {} };
    await recordUsageIsolated(billing, [
      { ...base, meter: 'provider.cost', cost: 2.5, idempotencyKey: 'k1' },
      { ...base, meter: 'vm.instance.hours', idempotencyKey: 'k2' },
    ]);
    expect(inputs[0]).toMatchObject({ meter: 'provider.cost', cost: 2.5 });
    expect('cost' in inputs[1]!).toBe(false);
  });
});

describe('retention over sources', () => {
  beforeEach(fleet);

  it('prunes recorded or voided source windows that ended long ago, never pending ones', async () => {
    const meter = (sourceId: string) =>
      db.transaction((tx) =>
        meterSource(
          tx,
          {
            sourceKind: 'snapshot',
            sourceId,
            tenantId: 'acme',
            lines: [{ meter: 'vm.snapshot.gib.hours', perHour: 10 }],
            from: T0,
            to: T0 + HOUR,
            tags: {},
          },
          T0 + HOUR,
        ),
      );
    for (const id of ['snap_recorded', 'snap_voided', 'snap_pending', 'snap_recent'])
      await meter(id);
    await db.query(
      `UPDATE usage_windows SET recorded_at = $1::timestamptz, outcome = 'recorded'
        WHERE source_id IN ('snap_recorded', 'snap_recent')`,
      [iso(T0 + HOUR)],
    );
    await db.query(
      `UPDATE usage_windows SET voided_at = $1::timestamptz, void_reason = 'test' WHERE source_id = 'snap_voided'`,
      [iso(T0 + HOUR)],
    );
    await db.query(
      `UPDATE usage_windows SET window_start = window_start + interval '20 days',
                                window_end = window_end + interval '20 days' WHERE source_id = 'snap_recent'`,
    );
    await setSimClock(db, T0 + 30 * 86_400_000);
    expect(await db.transaction((tx) => pruneUsageWindows(tx, { olderThanDays: 14 }))).toBe(2);
    const { rows } = await db.query<{ source_id: string }>(
      'SELECT source_id FROM usage_windows ORDER BY 1',
    );
    expect(rows.map((row) => row.source_id)).toEqual(['snap_pending', 'snap_recent']);
  });
});

describe('the migration runs on a populated partitioned table', () => {
  const sources = baseMigrations.findIndex(
    (migration) => migration.name === 'core/0031_usage_sources',
  );
  let raw: PGlite;
  beforeAll(async () => {
    raw = await PGlite.create({ extensions: { btree_gist } });
    await raw.exec("SET TimeZone TO 'UTC'");
  });
  afterAll(() => raw.close());

  it('keeps every row and every partition file, and later months still attach', async () => {
    expect(sources).toBeGreaterThan(0);
    for (const migration of baseMigrations.slice(0, sources))
      await raw.exec(migration.sql as string);
    await raw.exec(`
      INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site_a', 't', 'shared', 'eu', 1);
      INSERT INTO pools (id, owner_tenant_id, site_id, class, sharing, agent, policy, version)
        VALUES ('pool_a', 't', 'site_a', 'gpu', 'exclusive', 'bcd', '{}', 1);
      INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance, cordoned,
        connectivity, trust, generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
        VALUES ('node_a', 'site_a', 'pool_a', 't', 'host', 'adopted', false, false, 'connected', 'platform', 1, 1, 1, 0, 0, 1);
      INSERT INTO allocations (id, tenant_id, pool_id, node_id, owner_kind, owner_id, during, version)
        VALUES ('alloc_1', 't', 'pool_a', 'node_a', 'reservation', 'rsv_1',
                tstzrange('2026-07-01', '2026-10-01'), 1);
    `);
    // Three monthly partitions, populated, plus rows the default partition holds.
    const months = [Date.UTC(2026, 6, 1), Date.UTC(2026, 7, 1), Date.UTC(2026, 8, 1)];
    for (const month of months)
      await raw.query(`SELECT compute_history_partition('usage_windows', $1::timestamptz)`, [
        iso(month),
      ]);
    for (const month of [...months, Date.UTC(2030, 0, 1)])
      await raw.query(
        `INSERT INTO usage_windows (idempotency_key, allocation_id, tenant_id, meter, quantity, window_start,
                                    window_end, recorded_at, outcome)
         SELECT 'cmp:alloc_1:' || h || ':' || $2, 'alloc_1', 't', 'gpu.h100.hours', 1,
                $1::timestamptz + make_interval(hours => h), $1::timestamptz + make_interval(hours => h + 1),
                CASE WHEN h % 2 = 0 THEN $1::timestamptz END, CASE WHEN h % 2 = 0 THEN 'recorded' END
           FROM generate_series(0, 99) h`,
        [iso(month), String(month)],
      );
    const counts = async () =>
      (
        await raw.query<{ part: string; count: number }>(
          `SELECT tableoid::regclass::text AS part, count(*)::int AS count FROM usage_windows GROUP BY 1 ORDER BY 1`,
        )
      ).rows;
    const files = async () =>
      (
        await raw.query<{ relname: string; relfilenode: number }>(
          `SELECT c.relname, c.relfilenode FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
            WHERE i.inhparent = 'usage_windows'::regclass ORDER BY 1`,
        )
      ).rows;
    const before = await counts();
    expect(before).toEqual([
      { part: 'usage_windows_default', count: 100 },
      { part: 'usage_windows_p202607', count: 100 },
      { part: 'usage_windows_p202608', count: 100 },
      { part: 'usage_windows_p202609', count: 100 },
    ]);
    const filesBefore = await files();

    await raw.exec(baseMigrations[sources]!.sql as string);

    expect(await counts()).toEqual(before);
    // No partition was rewritten: every partition keeps its storage file.
    expect(await files()).toEqual(filesBefore);
    expect(
      (
        await raw.query(
          `SELECT source_kind, source_id, voided_at, void_reason, cost_micros, count(*)::int AS count
             FROM usage_windows GROUP BY 1, 2, 3, 4, 5`,
        )
      ).rows,
    ).toEqual([
      {
        source_kind: 'allocation',
        source_id: null,
        voided_at: null,
        void_reason: null,
        cost_micros: null,
        count: 400,
      },
    ]);
    // Every partition (the three seeded months, the months core/0018 made, the default) has the new unique index.
    expect(filesBefore.length).toBeGreaterThanOrEqual(4);
    expect(
      (
        await raw.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM pg_inherits i JOIN pg_index x ON x.indexrelid = i.inhrelid
            WHERE i.inhparent = 'usage_windows_source'::regclass AND x.indisunique`,
        )
      ).rows,
    ).toEqual([{ count: filesBefore.length }]);
    // A source window lands in the default partition; creating its month moves it there, columns intact.
    await raw.query(
      `INSERT INTO usage_windows (idempotency_key, source_kind, source_id, tenant_id, meter, quantity, window_start,
                                  window_end, cost_micros)
       VALUES ('cmp:cost:c1:1', 'cost', 'c1', 't', 'provider.cost', 1, '2031-03-01T05:00Z', '2031-03-01T06:00Z', 7)`,
    );
    await raw.query(`SELECT compute_history_partition('usage_windows', '2031-03-01T00:00Z')`);
    expect(
      (
        await raw.query(
          `SELECT tableoid::regclass::text AS part, source_kind, source_id, allocation_id, cost_micros::int AS cost
             FROM usage_windows WHERE idempotency_key = 'cmp:cost:c1:1'`,
        )
      ).rows,
    ).toEqual([
      {
        part: 'usage_windows_p203103',
        source_kind: 'cost',
        source_id: 'c1',
        allocation_id: null,
        cost: 7,
      },
    ]);
    await expect(
      raw.query(
        `INSERT INTO usage_windows (idempotency_key, source_kind, source_id, tenant_id, meter, quantity, window_start,
                                    window_end)
         VALUES ('cmp:cost:c1:2', 'cost', 'c1', 't', 'provider.cost', 1, '2031-03-01T05:00Z', '2031-03-01T06:00Z')`,
      ),
    ).rejects.toThrow(/duplicate key/); // keys differ: the source index refused it
  });
});
