import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import type { SqlExecutor } from '@better-compute/core';
import {
  baseMigrations,
  defaultPartitionRows,
  detachHistoryPartition,
  dropEmptyHistoryPartitions,
  ensureHistoryPartitions,
  historyPartitions,
  pruneInventorySnapshots,
  pruneUsageWindows,
  runRetention,
  setSimClock,
  useSimClock,
} from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';

// core/0018: the history tables are range-partitioned by UTC month (PLAN.md §8.3, §8.6 #8, v0.4).

const month = (ms: number) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
const addMonths = (ms: number, n: number) => {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1);
};
const DAY = 86_400_000;

async function partitionNames(
  db: SqlExecutor,
  table: 'audit_events' | 'inventory_snapshots' | 'usage_windows',
) {
  return (await historyPartitions(db, table)).map((p) => p.name);
}
async function audit(db: SqlExecutor, id: string) {
  await db.query(
    `INSERT INTO audit_events (id, tenant_id, action, resource_type, resource_id) VALUES ($1, 't', 'a', 'node', 'n')`,
    [id],
  );
}
async function partitionOf(db: SqlExecutor, table: string, where: string, params: unknown[]) {
  const { rows } = await db.query<{ part: string }>(
    `SELECT tableoid::regclass::text AS part FROM ${table} WHERE ${where}`,
    params,
  );
  return rows.map((row) => row.part);
}
async function fixtures(db: SqlExecutor) {
  await db.query(
    `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site_a', 't', 'shared', 'eu', 1)`,
  );
  await db.query(
    `INSERT INTO pools (id, owner_tenant_id, site_id, class, sharing, agent, policy, version) VALUES ('pool_a', 't', 'site_a', 'gpu', 'exclusive', 'bcd', '{}', 1)`,
  );
  for (const node of ['node_a', 'node_b'])
    await db.query(
      `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance, cordoned,
         connectivity, trust, generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
       VALUES ($1, 'site_a', 'pool_a', 't', 'host', 'adopted', false, false, 'connected', 'platform', 1, 1, 1, 0, 0, 1)`,
      [node],
    );
}
async function snapshot(db: SqlExecutor, id: string, node: string, at: number) {
  await db.query(
    `INSERT INTO inventory_snapshots (id, node_id, sha256, section_hashes, sections, collected_at)
     VALUES ($1, $2, '\\x00', '{}', '{}', $3::timestamptz)`,
    [id, node, new Date(at).toISOString()],
  );
}

describe('a fresh schema', () => {
  let db: SqlExecutor;
  beforeAll(async () => {
    db = pglite({ analyzeEveryMs: 0 });
    await db.migrate();
  });
  afterAll(() => db.close());

  it('partitions the three history tables by month, with the time column in the primary key', async () => {
    const { rows } = await db.query<{ table: string; key: string; pk: string }>(
      `SELECT c.relname AS table, pg_get_partkeydef(c.oid) AS key, pg_get_constraintdef(k.oid) AS pk
         FROM pg_class c JOIN pg_constraint k ON k.conrelid = c.oid AND k.contype = 'p'
        WHERE c.relkind = 'p' ORDER BY 1`,
    );
    expect(rows).toEqual([
      { table: 'audit_events', key: 'RANGE (occurred_at)', pk: 'PRIMARY KEY (id, occurred_at)' },
      {
        table: 'inventory_snapshots',
        key: 'RANGE (collected_at)',
        pk: 'PRIMARY KEY (id, collected_at)',
      },
      {
        table: 'usage_windows',
        key: 'RANGE (window_start)',
        pk: 'PRIMARY KEY (idempotency_key, window_start)',
      },
    ]);
  });

  it('creates this month and the next, plus a default partition', async () => {
    const now = Date.now();
    for (const table of ['audit_events', 'inventory_snapshots', 'usage_windows'] as const)
      expect(await partitionNames(db, table)).toEqual([
        `${table}_p${month(now)}`,
        `${table}_p${month(addMonths(now, 1))}`,
        `${table}_default`,
      ]);
    const [current] = await historyPartitions(db, 'audit_events');
    expect(current).toMatchObject({
      from: new Date(addMonths(now, 0)),
      to: new Date(addMonths(now, 1)),
      isDefault: false,
    });
  });

  it('routes rows to their month and keeps the indexes and constraints of the table', async () => {
    await audit(db, 'aud_now');
    expect(await partitionOf(db, 'audit_events', 'id = $1', ['aud_now'])).toEqual([
      `audit_events_p${month(Date.now())}`,
    ]);
    const { rows } = await db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename IN ('audit_events', 'inventory_snapshots', 'usage_windows') ORDER BY 1`,
    );
    expect(rows.map((r) => r.indexname)).toEqual([
      'audit_events_commit',
      'audit_events_pkey',
      'audit_events_resource',
      'audit_events_tenant',
      'audit_events_tenant_commit',
      'inventory_snapshots_node',
      'inventory_snapshots_node_id',
      'inventory_snapshots_pkey',
      'inventory_snapshots_sha',
      'usage_windows_allocation_id_window_start_meter_key',
      'usage_windows_pkey',
      'usage_windows_tenant',
      'usage_windows_unrecorded',
    ]);
    // The partitions carry the CHECKs and foreign keys too.
    await expect(
      db.query(
        `INSERT INTO usage_windows (idempotency_key, allocation_id, tenant_id, meter, quantity, window_start, window_end)
         VALUES ('k', 'no-such-allocation', 't', 'm', 1, compute_now(), compute_now() + interval '1 hour')`,
      ),
    ).rejects.toThrow(/foreign key/);
    await expect(
      db.query(
        `INSERT INTO inventory_snapshots (id, node_id, sha256, section_hashes, sections, collected_at) VALUES ('i', 'no-node', '\\x00', '{}', '{}', compute_now())`,
      ),
    ).rejects.toThrow(/foreign key/);
  });

  it('creates months ahead idempotently', async () => {
    const created = await ensureHistoryPartitions(db);
    const ahead = month(addMonths(Date.now(), 2));
    expect(created).toEqual([
      `audit_events_p${ahead}`,
      `inventory_snapshots_p${ahead}`,
      `usage_windows_p${ahead}`,
    ]);
    expect(await ensureHistoryPartitions(db)).toEqual([]);
    await expect(ensureHistoryPartitions(db, { monthsAhead: -1 })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('refuses tables that are not partitioned history', async () => {
    await expect(historyPartitions(db, 'nodes' as never)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(
      db.query(`SELECT compute_history_partition('nodes', compute_now())`),
    ).rejects.toThrow(/not a partitioned table/);
  });
});

describe('the default partition', () => {
  let db: SqlExecutor;
  const FAR = Date.UTC(2031, 4, 10);
  beforeAll(async () => {
    db = pglite({ analyzeEveryMs: 0 });
    await db.migrate();
    await audit(db, 'aud_before');
    await useSimClock(db, FAR);
  });
  afterAll(() => db.close());

  it('catches rows no month covers, and creating the month moves them out', async () => {
    await audit(db, 'aud_far_1');
    await audit(db, 'aud_far_2');
    expect(await defaultPartitionRows(db, 'audit_events')).toBe(2);
    const { rows: before } = await db.query<{ id: string; seq: string; txid: string }>(
      `SELECT id, seq::text, txid::text FROM audit_events ORDER BY audit_events.txid, audit_events.seq`,
    );
    const created = await db.transaction((tx) => ensureHistoryPartitions(tx, { monthsAhead: 0 }));
    expect(created).toEqual([
      'audit_events_p203105',
      'inventory_snapshots_p203105',
      'usage_windows_p203105',
    ]);
    expect(await defaultPartitionRows(db, 'audit_events')).toBe(0);
    expect(await partitionOf(db, 'audit_events', 'id LIKE $1', ['aud_far%'])).toEqual([
      'audit_events_p203105',
      'audit_events_p203105',
    ]);
    // Moving keeps every value, the commit cursor included.
    const { rows: after } = await db.query<{ id: string; seq: string; txid: string }>(
      `SELECT id, seq::text, txid::text FROM audit_events ORDER BY audit_events.txid, audit_events.seq`,
    );
    expect(after).toEqual(before);
    // The sequence carries on across partitions.
    await audit(db, 'aud_far_3');
    const { rows } = await db.query<{ seq: string }>(
      `SELECT seq::text FROM audit_events WHERE id = 'aud_far_3'`,
    );
    expect(BigInt(rows[0]!.seq)).toBeGreaterThan(BigInt(before.at(-1)!.seq));
  });

  it('keeps month boundaries on UTC midnight', async () => {
    await setSimClock(db, Date.UTC(2031, 5, 30, 23, 59, 59));
    await audit(db, 'aud_june_end');
    await setSimClock(db, Date.UTC(2031, 6, 1, 0, 0, 0));
    await audit(db, 'aud_july_start');
    await db.transaction((tx) => ensureHistoryPartitions(tx, { monthsAhead: 0 }));
    await setSimClock(db, Date.UTC(2031, 6, 1, 0, 0, 1));
    await db.query(
      `SELECT compute_history_partition('audit_events', timestamptz '2031-06-15 12:00:00+00')`,
    );
    expect(
      await partitionOf(
        db,
        'audit_events',
        `id IN ('aud_june_end', 'aud_july_start') ORDER BY occurred_at`,
        [],
      ),
    ).toEqual(['audit_events_p203106', 'audit_events_p203107']);
    const parts = await historyPartitions(db, 'audit_events');
    const june = parts.find((p) => p.name === 'audit_events_p203106')!;
    expect([june.from!.toISOString(), june.to!.toISOString()]).toEqual([
      '2031-06-01T00:00:00.000Z',
      '2031-07-01T00:00:00.000Z',
    ]);
  });
});

describe('pruning and dropping', () => {
  let db: SqlExecutor;
  const T0 = Date.UTC(2030, 0, 15);
  beforeAll(async () => {
    db = pglite({ analyzeEveryMs: 0 });
    await db.migrate();
    await useSimClock(db, T0);
    await fixtures(db);
    for (const m of [0, 1, 2, 3, 4, 5, 6, 7, 8])
      await db.query(`SELECT compute_history_partition('inventory_snapshots', $1::timestamptz)`, [
        new Date(addMonths(T0, m)).toISOString(),
      ]);
    // node_a: January (superseded), February (superseded but applied), March (superseded), April (newest).
    await snapshot(db, 'inv_a1', 'node_a', T0);
    await snapshot(db, 'inv_a2', 'node_a', T0 + 31 * DAY);
    await snapshot(db, 'inv_a3', 'node_a', T0 + 60 * DAY);
    await snapshot(db, 'inv_a4', 'node_a', T0 + 90 * DAY);
    // node_b: one old snapshot, its only one.
    await snapshot(db, 'inv_b1', 'node_b', T0 + 1 * DAY);
    await db.query(
      `INSERT INTO node_inventory (node_id, applied_snapshot_id) VALUES ('node_a', 'inv_a2')`,
    );
  });
  afterAll(() => db.close());

  it('prunes superseded inventory snapshots, never a node newest or applied one', async () => {
    await setSimClock(db, T0 + 250 * DAY);
    await expect(pruneInventorySnapshots(db, { olderThanDays: 0 })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(await pruneInventorySnapshots(db, { olderThanDays: 180, batch: 1 })).toBe(1);
    expect(await pruneInventorySnapshots(db, { olderThanDays: 180 })).toBe(1);
    expect(await pruneInventorySnapshots(db, { olderThanDays: 180 })).toBe(0);
    const { rows } = await db.query<{ id: string }>(
      'SELECT id FROM inventory_snapshots ORDER BY id',
    );
    expect(rows.map((r) => r.id)).toEqual(['inv_a2', 'inv_a4', 'inv_b1']);
  });

  it('drops only emptied month partitions past the horizon', async () => {
    // Horizon: late April 2030. January holds inv_b1 (node_b's only snapshot), February the applied
    // inv_a2, April ends after the horizon; March was emptied, and the months the migration created
    // (real time, long before the sim clock) never held anything.
    const dropped = await db.transaction((tx) =>
      dropEmptyHistoryPartitions(tx, 'inventory_snapshots', { olderThanDays: 150 }),
    );
    const real = Date.now();
    expect(dropped).toEqual([
      `inventory_snapshots_p${month(real)}`,
      `inventory_snapshots_p${month(addMonths(real, 1))}`,
      'inventory_snapshots_p203003',
    ]);
    const names = await partitionNames(db, 'inventory_snapshots');
    expect(names).toContain('inventory_snapshots_p203001');
    expect(names).toContain('inventory_snapshots_p203002');
    expect(names).toContain('inventory_snapshots_p203004');
    expect(names).not.toContain('inventory_snapshots_p203003');
    await expect(
      dropEmptyHistoryPartitions(db, 'audit_events' as never, { olderThanDays: 30 }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('prunes recorded usage windows of long-ended allocations only', async () => {
    const at = (ms: number) => new Date(ms).toISOString();
    const now = T0 + 250 * DAY;
    await db.query(
      `INSERT INTO allocations (id, tenant_id, pool_id, node_id, owner_kind, owner_id, during, released_at, version)
       VALUES ('alloc_old', 't', 'pool_a', 'node_a', 'reservation', 'rsv_1', tstzrange($1::timestamptz, $2::timestamptz), $2::timestamptz, 1),
              ('alloc_live', 't', 'pool_a', 'node_b', 'reservation', 'rsv_2', tstzrange($1::timestamptz, $3::timestamptz), NULL, 1)`,
      [at(T0), at(T0 + 10 * DAY), at(now + 10 * DAY)],
    );
    const window = (key: string, allocation: string, start: number, recorded: boolean) =>
      db.query(
        `INSERT INTO usage_windows (idempotency_key, allocation_id, tenant_id, meter, quantity, window_start, window_end, recorded_at)
         VALUES ($1, $2, 't', 'gpu.h100.hours', 1, $3, $4, CASE WHEN $5::bool THEN compute_now() END)`,
        [key, allocation, at(start), at(start + 3_600_000), recorded],
      );
    await window('cmp:alloc_old:1', 'alloc_old', T0, true);
    await window('cmp:alloc_old:2', 'alloc_old', T0 + DAY, false); // never recorded: stays
    await window('cmp:alloc_live:1', 'alloc_live', T0, true); // allocation still live: stays
    await expect(pruneUsageWindows(db, { olderThanDays: 3 })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(await pruneUsageWindows(db, { olderThanDays: 30 })).toBe(1);
    const { rows } = await db.query<{ idempotency_key: string }>(
      'SELECT idempotency_key FROM usage_windows ORDER BY 1',
    );
    expect(rows.map((r) => r.idempotency_key)).toEqual(['cmp:alloc_live:1', 'cmp:alloc_old:2']);
  });

  it('detaches a past month for archival, never the default or the current month', async () => {
    await audit(db, 'aud_now');
    await db.query(`SELECT compute_history_partition('audit_events', $1::timestamptz)`, [
      new Date(T0).toISOString(),
    ]);
    await db.query(
      `INSERT INTO audit_events (id, tenant_id, occurred_at, action, resource_type, resource_id) VALUES ('aud_jan', 't', $1, 'a', 'node', 'n')`,
      [new Date(T0).toISOString()],
    );
    await expect(
      detachHistoryPartition(db, 'audit_events', 'audit_events_default'),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      detachHistoryPartition(db, 'audit_events', 'audit_events_p199901'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const current = `audit_events_p${month(T0 + 250 * DAY)}`;
    await db.query(`SELECT compute_history_partition('audit_events', compute_now())`);
    await expect(detachHistoryPartition(db, 'audit_events', current)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    await db.transaction((tx) =>
      detachHistoryPartition(tx, 'audit_events', 'audit_events_p203001'),
    );
    const { rows } = await db.query<{ id: string }>('SELECT id FROM audit_events ORDER BY id');
    expect(rows.map((r) => r.id)).toEqual(['aud_now']);
    const { rows: archived } = await db.query<{ id: string; partition: boolean }>(
      `SELECT a.id, c.relispartition AS partition FROM audit_events_p203001 a, pg_class c WHERE c.relname = 'audit_events_p203001'`,
    );
    expect(archived).toEqual([{ id: 'aud_jan', partition: false }]);
  });

  it('runs as part of the retention pass', async () => {
    const pass = await runRetention(db, { history: { monthsAhead: 1, usageOlderThanDays: 30 } });
    expect(pass).toMatchObject({ inventorySnapshots: 0, usageWindows: 0 });
    expect(pass.partitionsCreated).toBeGreaterThan(0);
    expect(
      await runRetention(db, { history: { monthsAhead: 1, inventoryOlderThanDays: false } }),
    ).toMatchObject({
      partitionsCreated: 0,
      inventorySnapshots: 0,
      partitionsDropped: 0,
    });
  });
});

describe('upgrading a database with history (core/0017 → core/0018)', () => {
  let raw: PGlite;
  beforeAll(async () => {
    raw = await PGlite.create({ extensions: { btree_gist } });
    await raw.exec("SET TimeZone TO 'UTC'");
    for (const migration of baseMigrations.slice(0, -1)) {
      expect(typeof migration.sql).toBe('string');
      await raw.exec(migration.sql as string);
    }
    expect(baseMigrations.at(-1)!.name).toBe('core/0018_partitioned_history');
  });
  afterAll(() => raw.close());

  it('moves every row into its month, values and commit order intact', async () => {
    const now = Date.now();
    const lastMonth = addMonths(now, -1) + 5 * DAY;
    const longAgo = Date.UTC(2020, 1, 1);
    await raw.exec(`
      INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site_a', 't', 'shared', 'eu', 1);
      INSERT INTO pools (id, owner_tenant_id, site_id, class, sharing, agent, policy, version) VALUES ('pool_a', 't', 'site_a', 'gpu', 'exclusive', 'bcd', '{}', 1);
      INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance, cordoned, connectivity, trust,
        generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
        VALUES ('node_a', 'site_a', 'pool_a', 't', 'host', 'adopted', false, false, 'connected', 'platform', 1, 1, 1, 0, 0, 1);
      INSERT INTO allocations (id, tenant_id, pool_id, node_id, owner_kind, owner_id, during, version)
        VALUES ('alloc_1', 't', 'pool_a', 'node_a', 'reservation', 'rsv_1', tstzrange(now() - interval '2 hours', now() + interval '1 hour'), 1);
    `);
    await raw.query(
      `INSERT INTO audit_events (id, tenant_id, occurred_at, action, resource_type, resource_id, details)
       VALUES ('aud_1', 't', $1, 'a', 'node', 'n', '{"x": 1}'), ('aud_2', 't', $2, 'a', 'node', 'n', NULL), ('aud_3', 't', $3, 'a', 'node', 'n', NULL)`,
      [new Date(longAgo), new Date(lastMonth), new Date(now)],
    );
    await raw.query(
      `INSERT INTO inventory_snapshots (id, node_id, sha256, section_hashes, sections, collected_at) VALUES ('inv_1', 'node_a', '\\x01', '{}', '{}', $1)`,
      [new Date(lastMonth)],
    );
    await raw.query(
      `INSERT INTO usage_windows (idempotency_key, allocation_id, tenant_id, meter, quantity, window_start, window_end)
       VALUES ('cmp:alloc_1:1', 'alloc_1', 't', 'gpu.h100.hours', 8, $1, $2)`,
      [new Date(now - 2 * 3_600_000), new Date(now - 3_600_000)],
    );
    const auditRows = async () =>
      (
        await raw.query<Record<string, unknown>>(
          `SELECT id, occurred_at, details, txid::text, seq::text FROM audit_events ORDER BY txid, seq`,
        )
      ).rows;
    const before = await auditRows();

    await raw.exec(baseMigrations.at(-1)!.sql as string);

    expect(await auditRows()).toEqual(before);
    const parts = (
      await raw.query<{ id: string; part: string }>(
        `SELECT id, tableoid::regclass::text AS part FROM audit_events ORDER BY id`,
      )
    ).rows;
    expect(parts).toEqual([
      { id: 'aud_1', part: 'audit_events_default' }, // older than a year: the default partition keeps it
      { id: 'aud_2', part: `audit_events_p${month(lastMonth)}` },
      { id: 'aud_3', part: `audit_events_p${month(now)}` },
    ]);
    expect(
      (await raw.query(`SELECT tableoid::regclass::text AS part FROM inventory_snapshots`)).rows,
    ).toEqual([{ part: `inventory_snapshots_p${month(lastMonth)}` }]);
    expect((await raw.query(`SELECT quantity::text FROM usage_windows`)).rows).toEqual([
      { quantity: '8' },
    ]);
    // The old tables are gone; the audit sequence survived them and keeps counting.
    expect((await raw.query(`SELECT to_regclass('audit_events_v1') AS t`)).rows).toEqual([
      { t: null },
    ]);
    await raw.exec(
      `INSERT INTO audit_events (id, tenant_id, action, resource_type, resource_id) VALUES ('aud_4', 't', 'a', 'node', 'n')`,
    );
    const { rows } = await raw.query<{ seq: string }>(
      `SELECT seq::text FROM audit_events WHERE id = 'aud_4'`,
    );
    expect(BigInt(rows[0]!.seq)).toBe(BigInt(before.at(-1)!.seq as string) + 1n);
  });
});
