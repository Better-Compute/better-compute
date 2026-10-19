import { ComputeError, type SqlTx } from '@better-compute/core';
import { historyTables } from './migrations/0018_partitioned_history.js';

// Partitioned history (PLAN.md §8.3, §8.6 #8; core/0018): `audit_events`, `inventory_snapshots` and
// `usage_windows` are range-partitioned by UTC month, with a DEFAULT partition that catches anything
// no month partition covers. Upkeep keeps the next months created ahead (moving any stray rows out
// of the default partition as it goes), prunes history nothing reads any more, and drops month
// partitions that pruning emptied. Audit rows are never pruned here: sealed checkpoints are verified
// against the rows `audit_events` holds, so archiving a month is an operator step
// (`detachHistoryPartition`), not a timer.

export type HistoryTable = (typeof historyTables)[number]['table'];

export interface HistoryPartition {
  table: HistoryTable;
  name: string;
  /** Inclusive lower bound (UTC month start); absent for the default partition. */
  from?: Date;
  /** Exclusive upper bound; absent for the default partition. */
  to?: Date;
  isDefault: boolean;
}

const tableNames = new Set<string>(historyTables.map((entry) => entry.table));
const monthName = /_p(\d{4})(\d{2})$/;

function checkTable(table: string): asserts table is HistoryTable {
  if (!tableNames.has(table))
    throw new ComputeError('INVALID_INPUT', `${table} is not a partitioned history table`);
}

/** The partitions of one history table (or all three), oldest month first, the default partition last. */
export async function historyPartitions(
  tx: SqlTx,
  table?: HistoryTable,
): Promise<HistoryPartition[]> {
  if (table !== undefined) checkTable(table);
  const { rows } = await tx.query<{ parent: string; name: string; bound: string }>(
    `SELECT p.relname AS parent, c.relname AS name, pg_get_expr(c.relpartbound, c.oid) AS bound
       FROM pg_inherits i
       JOIN pg_class c ON c.oid = i.inhrelid
       JOIN pg_class p ON p.oid = i.inhparent
      WHERE p.relname = ANY($1::text[]) AND p.relnamespace = current_schema()::regnamespace
      ORDER BY p.relname, c.relname`,
    [table ? [table] : [...tableNames]],
  );
  const partitions: HistoryPartition[] = [];
  for (const row of rows) {
    const parent = row.parent as HistoryTable;
    if (row.bound === 'DEFAULT') {
      partitions.push({ table: parent, name: row.name, isDefault: true });
      continue;
    }
    const month = monthName.exec(row.name);
    // Only partitions this module created carry the _pYYYYMM name; others are an operator's own.
    if (!month) continue;
    const year = Number(month[1]);
    const index = Number(month[2]) - 1;
    partitions.push({
      table: parent,
      name: row.name,
      from: new Date(Date.UTC(year, index, 1)),
      to: new Date(Date.UTC(year, index + 1, 1)),
      isDefault: false,
    });
  }
  return partitions.sort(
    (a, b) =>
      a.table.localeCompare(b.table) ||
      Number(a.isDefault) - Number(b.isDefault) ||
      (a.from?.getTime() ?? 0) - (b.from?.getTime() ?? 0),
  );
}

/**
 * Creates the month partitions from the current month (on `compute_now()`) through `monthsAhead`
 * months ahead for every history table, moving rows of those months out of the default partition.
 * Idempotent; returns the partitions it created.
 */
export async function ensureHistoryPartitions(
  tx: SqlTx,
  options: { monthsAhead?: number } = {},
): Promise<string[]> {
  const ahead = options.monthsAhead ?? 2;
  if (!Number.isSafeInteger(ahead) || ahead < 0 || ahead > 24)
    throw new ComputeError('INVALID_INPUT', 'monthsAhead must be 0..24');
  const { rows } = await tx.query<{ created: string | null }>(
    `SELECT compute_history_partition(t.parent::regclass,
              (date_trunc('month', compute_now() AT TIME ZONE 'UTC') + make_interval(months => m)) AT TIME ZONE 'UTC') AS created
       FROM unnest($1::text[]) WITH ORDINALITY AS t(parent, ord), generate_series(0, $2::int) AS m
      ORDER BY t.ord, m`,
    [historyTables.map((entry) => entry.table), ahead],
  );
  return rows.flatMap((row) => (row.created ? [row.created] : []));
}

/** Rows in a table's default partition: rows no month partition covers (sim clocks, far-off times). */
export async function defaultPartitionRows(tx: SqlTx, table: HistoryTable): Promise<number> {
  checkTable(table);
  const { rows } = await tx.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${table}_default`,
  );
  return Number(rows[0]!.n);
}

export interface HistoryPruneOptions {
  /** Rows older than this many days (default 180 for inventory; usage is kept unless set). */
  olderThanDays?: number;
  /** Rows per statement (default 5,000). */
  batch?: number;
}

function days(value: number | undefined, fallback: number, minimum: number): number {
  const result = value ?? fallback;
  if (!(result >= minimum) || !Number.isFinite(result))
    throw new ComputeError('INVALID_INPUT', `olderThanDays must be at least ${minimum}`);
  return result;
}
function batchOf(value: number | undefined): number {
  const batch = value ?? 5000;
  if (!Number.isSafeInteger(batch) || batch < 1)
    throw new ComputeError('INVALID_INPUT', 'batch must be positive');
  return batch;
}

/**
 * Deletes up to `batch` inventory snapshots older than `olderThanDays` that a newer snapshot of the
 * same node superseded. A node's newest snapshot and the one its inventory is applied from
 * (`node_inventory.applied_snapshot_id`) always stay, however old: they are current state.
 */
export async function pruneInventorySnapshots(
  tx: SqlTx,
  options: HistoryPruneOptions = {},
): Promise<number> {
  const olderThan = days(options.olderThanDays, 180, 1);
  const { rowCount } = await tx.query(
    `DELETE FROM inventory_snapshots d USING (
       SELECT s.id, s.collected_at FROM inventory_snapshots s
        WHERE s.collected_at < compute_now() - $1::float8 * interval '1 day'
          AND NOT EXISTS (SELECT 1 FROM node_inventory ni WHERE ni.applied_snapshot_id = s.id)
          AND EXISTS (SELECT 1 FROM inventory_snapshots n
                       WHERE n.node_id = s.node_id AND (n.collected_at, n.id) > (s.collected_at, s.id))
        ORDER BY s.collected_at, s.id LIMIT $2) doomed
      WHERE d.id = doomed.id AND d.collected_at = doomed.collected_at`,
    [olderThan, batchOf(options.batch)],
  );
  return rowCount ?? 0;
}

/**
 * Deletes up to `batch` usage windows the sink recorded (or that were voided), of allocations that ended more
 * than `olderThanDays` ago (at least 7: the metering pass re-derives the windows of allocations live or
 * ended within its 48 h lookback, and must find them still there). Windows of other sources (core/0029) go
 * once they ended that long ago: their reconcilers keep a watermark and never re-derive old hours.
 * Unrecorded, unvoided windows always stay, and so does a window with an open dead letter (FW-14).
 */
export async function pruneUsageWindows(
  tx: SqlTx,
  options: HistoryPruneOptions & { olderThanDays: number },
): Promise<number> {
  const olderThan = days(options.olderThanDays, Number.NaN, 7);
  const { rowCount } = await tx.query(
    `DELETE FROM usage_windows d USING (
       SELECT u.idempotency_key, u.window_start FROM usage_windows u
         LEFT JOIN allocations a ON a.id = u.allocation_id
        WHERE (u.recorded_at IS NOT NULL OR u.voided_at IS NOT NULL)
          AND u.window_end < compute_now() - $1::float8 * interval '1 day'
          AND (u.allocation_id IS NULL
               OR COALESCE(a.released_at, upper(a.during)) < compute_now() - $1::float8 * interval '1 day')
          -- A window with an open dead letter waits for root (retry, void or an invoice item).
          AND NOT EXISTS (SELECT 1 FROM usage_dead_letters l
                           WHERE l.idempotency_key = u.idempotency_key AND l.resolved_at IS NULL)
        ORDER BY u.window_start, u.idempotency_key LIMIT $2) doomed
      WHERE d.idempotency_key = doomed.idempotency_key AND d.window_start = doomed.window_start`,
    [olderThan, batchOf(options.batch)],
  );
  return rowCount ?? 0;
}

/**
 * Drops the month partitions of `table` that are empty and ended more than `olderThanDays` ago (the
 * default partition and current or future months never). Returns the dropped names.
 */
export async function dropEmptyHistoryPartitions(
  tx: SqlTx,
  table: Exclude<HistoryTable, 'audit_events'>,
  options: { olderThanDays: number },
): Promise<string[]> {
  checkTable(table);
  if ((table as string) === 'audit_events')
    throw new ComputeError(
      'INVALID_INPUT',
      'audit partitions are archived with detachHistoryPartition',
    );
  const olderThan = days(options.olderThanDays, Number.NaN, 1);
  const { rows: clock } = await tx.query<{ now: Date }>('SELECT compute_now() AS now');
  const horizon = clock[0]!.now.getTime() - olderThan * 86_400_000;
  const dropped: string[] = [];
  for (const partition of await historyPartitions(tx, table)) {
    if (partition.isDefault || partition.to!.getTime() > horizon) continue;
    const { rows } = await tx.query<{ empty: boolean }>(
      `SELECT NOT EXISTS (SELECT 1 FROM ${partition.name}) AS empty`,
    );
    if (!rows[0]!.empty) continue;
    await tx.query(`ALTER TABLE ${table} DETACH PARTITION ${partition.name}`);
    await tx.query(`DROP TABLE ${partition.name}`);
    dropped.push(partition.name);
  }
  return dropped;
}

/**
 * Detaches one month partition, leaving it as a standalone table of the same name to export and drop
 * (an operator's archival step, e.g. for audit months past their retention). Its rows leave every
 * read at once, including audit verification: for `audit_events`, run `markAuditArchived(sql, { month })`
 * from @better-compute/audit first, so verify reports that month's checkpoints as archived rather than
 * failed. Refuses the default partition and the current or a future month.
 */
export async function detachHistoryPartition(
  tx: SqlTx,
  table: HistoryTable,
  name: string,
): Promise<void> {
  checkTable(table);
  const partition = (await historyPartitions(tx, table)).find((entry) => entry.name === name);
  if (!partition)
    throw new ComputeError('NOT_FOUND', `${name} is not a month partition of ${table}`);
  if (partition.isDefault)
    throw new ComputeError('INVALID_INPUT', 'the default partition stays attached');
  const { rows } = await tx.query<{ now: Date }>('SELECT compute_now() AS now');
  if (partition.to!.getTime() > rows[0]!.now.getTime())
    throw new ComputeError('INVALID_STATE', `${name} is the current or a future month`);
  await tx.query(`ALTER TABLE ${table} DETACH PARTITION ${partition.name}`);
}
