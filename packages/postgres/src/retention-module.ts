import {
  defineModule,
  type ComputeModule,
  type Duration,
  type ReconcileContext,
} from '@better-compute/core';
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
 * The retention module: a singleton pass every `every` (outbox, authz_changes, settled commands,
 * attestation uses, join requests, and history partitions: created ahead, inventory/usage pruned,
 * emptied months dropped).
 */
export function retentionModule(options: RetentionModuleOptions = {}): ComputeModule<'retention'> {
  return defineModule({
    name: 'retention',
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
