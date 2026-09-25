import {
  defineModule,
  type ComputeModule,
  type Duration,
  type Finding,
  type ReconcileContext,
} from '@better-compute/core';
import { historyTables } from './migrations/0018_partitioned_history.js';
import {
  dropEmptyHistoryPartitions,
  ensureHistoryPartitions,
  pruneInventorySnapshots,
  pruneUsageWindows,
} from './history.js';
import {
  expireJoinRequests,
  pruneAttestationUses,
  pruneBehindCursors,
  pruneSettledCommands,
  pruneUncursoredAuthzChanges,
} from './retention.js';

// The base schema's housekeeping as a module (PLAN.md §8.4 GC): one singleton reconciler on a period,
// each pass in its own short transactions and bounded batches, so it never holds long locks. The
// server cannot import the store adapter, so hosts register it next to their modules:
//
//   betterCompute({ database, modules: [retentionModule(), ...] })

export interface RetentionModuleOptions {
  /** How often a pass runs (default 5 minutes). */
  every?: Duration;
  /** Outbox and authz_changes rows stay at least this long after every cursor passed them (default one hour). */
  minAgeSeconds?: number;
  /** Rows per statement (default 5,000); a pass repeats a statement until it deletes fewer. */
  batch?: number;
  /** Most statements per job in one pass (default 20), so a backlog drains over several passes. */
  maxRounds?: number;
  /**
   * authz_changes rows older than this go while no reader saved an authz_changes cursor (default one
   * day, at least one hour; `false` keeps them). The IAM projection tails reload on start.
   */
  authzChangesMaxAgeSeconds?: number | false;
  /** Settled commands last updated this long ago go (default 30 days; `false` keeps them). */
  commandsOlderThanDays?: number | false;
  /** Partitioned history upkeep (core/0018). Audit rows are never pruned by the pass. */
  history?: {
    /** Month partitions kept created ahead of the current month (default 2). */
    monthsAhead?: number;
    /** Superseded inventory snapshots older than this go (default 180 days); `false` keeps them all. */
    inventoryOlderThanDays?: number | false;
    /** Recorded usage windows of allocations that ended this long ago go (at least 7; default: kept). */
    usageOlderThanDays?: number;
  };
}

export interface RetentionPass {
  outbox: number;
  /** Behind every cursor, or past the age floor while the stream has no cursor. */
  authzChanges: number;
  commands: number;
  attestationUses: number;
  joinRequestsExpired: number;
  /** History month partitions created ahead. */
  partitionsCreated: number;
  inventorySnapshots: number;
  usageWindows: number;
  /** Emptied, past month partitions dropped. */
  partitionsDropped: number;
}

export const retentionWorkKind = 'core.retention';

/** One retention pass (what the reconciler runs), for hosts that schedule it themselves. */
export async function runRetention(
  sql: ReconcileContext['sql'],
  options: RetentionModuleOptions = {},
): Promise<RetentionPass> {
  const batch = options.batch ?? 5000;
  const maxRounds = options.maxRounds ?? 20;
  const drain = async (step: () => Promise<number>) => {
    let total = 0;
    for (let round = 0; round < maxRounds; round++) {
      const n = await step();
      total += n;
      if (n < batch) break;
    }
    return total;
  };
  const prune = { minAgeSeconds: options.minAgeSeconds ?? 3600, batch };
  const history = options.history ?? {};
  const inventoryDays =
    history.inventoryOlderThanDays === false ? undefined : (history.inventoryOlderThanDays ?? 180);
  const usageDays = history.usageOlderThanDays;
  const created = await sql.transaction((tx) =>
    ensureHistoryPartitions(tx, { monthsAhead: history.monthsAhead ?? 2 }),
  );
  const pass: RetentionPass = {
    outbox: await drain(() => sql.transaction((tx) => pruneBehindCursors(tx, 'outbox', prune))),
    authzChanges:
      (await drain(() => sql.transaction((tx) => pruneBehindCursors(tx, 'authz_changes', prune)))) +
      (options.authzChangesMaxAgeSeconds === false
        ? 0
        : await drain(() =>
            sql.transaction((tx) =>
              pruneUncursoredAuthzChanges(tx, {
                olderThanSeconds: options.authzChangesMaxAgeSeconds || 86_400,
                batch,
              }),
            ),
          )),
    commands:
      options.commandsOlderThanDays === false
        ? 0
        : await drain(() =>
            sql.transaction((tx) =>
              pruneSettledCommands(tx, { olderThanDays: options.commandsOlderThanDays || 30, batch }),
            ),
          ),
    attestationUses: await drain(() =>
      sql.transaction((tx) => pruneAttestationUses(tx, { batch })),
    ),
    joinRequestsExpired: await drain(() =>
      sql.transaction((tx) => expireJoinRequests(tx, { batch })),
    ),
    partitionsCreated: created.length,
    inventorySnapshots:
      inventoryDays === undefined
        ? 0
        : await drain(() =>
            sql.transaction((tx) =>
              pruneInventorySnapshots(tx, { olderThanDays: inventoryDays, batch }),
            ),
          ),
    usageWindows:
      usageDays === undefined
        ? 0
        : await drain(() =>
            sql.transaction((tx) => pruneUsageWindows(tx, { olderThanDays: usageDays, batch })),
          ),
    partitionsDropped: 0,
  };
  // Each drop detaches under a brief exclusive lock on the parent: one short transaction per table.
  if (inventoryDays !== undefined)
    pass.partitionsDropped += (
      await sql.transaction((tx) =>
        dropEmptyHistoryPartitions(tx, 'inventory_snapshots', { olderThanDays: inventoryDays }),
      )
    ).length;
  if (usageDays !== undefined)
    pass.partitionsDropped += (
      await sql.transaction((tx) =>
        dropEmptyHistoryPartitions(tx, 'usage_windows', { olderThanDays: usageDays }),
      )
    ).length;
  return pass;
}

/**
 * `doctor` findings for what retention keeps healthy (§14): month partitions missing for this or the
 * next month (the pass is not running), recent rows stranded in a default partition, and durable
 * cursors that stopped moving (their stream can no longer be pruned behind them).
 */
export async function retentionFindings(sql: ReconcileContext['sql'], options: { staleCursorSeconds?: number } = {}): Promise<Finding[]> {
  const findings: Finding[] = [];
  const { rows: missing } = await sql.query<{ name: string }>(
    `SELECT t.parent || '_p' || to_char(m AT TIME ZONE 'UTC', 'YYYYMM') AS name
       FROM unnest($1::text[]) AS t(parent),
            generate_series(date_trunc('month', compute_now() AT TIME ZONE 'UTC'),
                            date_trunc('month', compute_now() AT TIME ZONE 'UTC') + interval '1 month', interval '1 month') AS m
      WHERE to_regclass(t.parent || '_p' || to_char(m AT TIME ZONE 'UTC', 'YYYYMM')) IS NULL
      ORDER BY 1`,
    [historyTables.map((entry) => entry.table)],
  );
  if (missing.length)
    findings.push({
      check: 'history-partitions',
      severity: 'warning',
      message: `History partitions for this or next month are missing: ${missing.map((row) => row.name).join(', ')}`,
      fix: 'Register retentionModule() on a worker (it creates months ahead), or run ensureHistoryPartitions',
      count: missing.length,
    });
  let stranded = 0;
  for (const { table, column } of historyTables) {
    const { rows } = await sql.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${table}_default WHERE ${column} >= compute_now() - interval '13 months'`,
    );
    stranded += Number(rows[0]!.n);
  }
  if (stranded)
    findings.push({
      check: 'history-default-partition',
      severity: 'warning',
      message: `${stranded} recent history rows sit in default partitions`,
      fix: 'Let the retention pass create their months (ensureHistoryPartitions moves them out)',
      count: stranded,
    });
  const { rows: stale } = await sql.query<{ name: string }>(
    `SELECT name FROM outbox_cursors WHERE updated_at < compute_now() - make_interval(secs => $1) ORDER BY name`,
    [options.staleCursorSeconds ?? 86_400],
  );
  if (stale.length)
    findings.push({
      check: 'retention-cursors',
      severity: 'warning',
      message: `Durable cursors have not moved for a day: ${stale.map((row) => row.name).join(', ')}; their streams are not pruned behind them`,
      fix: 'Revive the sink or reader that owns each cursor, or delete its outbox_cursors row if it is gone for good',
      count: stale.length,
    });
  return findings;
}

/**
 * The retention module: a singleton pass every `every` (outbox, authz_changes, settled commands,
 * attestation uses, join requests, and history partitions: created ahead, inventory/usage pruned,
 * emptied months dropped).
 */
export function retentionModule(options: RetentionModuleOptions = {}): ComputeModule<'retention'> {
  return defineModule({
    name: 'retention',
    selfCheck: (context) => retentionFindings(context.sql),
    reconcilers: [
      {
        name: retentionWorkKind,
        shardBy: 'none',
        periodic: [{ key: 'pass', every: options.every ?? '5m' }],
        async run(context: ReconcileContext) {
          const pass = await runRetention(context.sql, options);
          if (Object.values(pass).some((n) => n > 0))
            context.log?.info?.('retention pass', { ...pass });
          return 'DONE';
        },
      },
    ],
  });
}
