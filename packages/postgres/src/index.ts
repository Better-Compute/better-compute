/**
 * PostgreSQL storage for better-compute: the `postgres()` executor, the adapter-owned base schema
 * and its migrations, the sim-clock helpers and a Kysely dialect. PGlite lives in `./pglite` and
 * store conformance in `./conformance`, so this entry never loads either.
 */
export { postgres, type PostgresOptions } from './node-postgres.js';
export { sqlState } from './executor.js';
export { baseMigrations, baseSchemaVersion, baseTables } from './migrations/index.js';
export { computeNowMode, restoreSystemClock, setSimClock, useSimClock } from './clock.js';
export { kyselyDialect } from './kysely.js';
export {
  expireJoinRequests,
  loadCursor,
  pruneAttestationUses,
  pruneBehindCursors,
  pruneSettledCommands,
  pruneUncursoredAuthzChanges,
  saveCursor,
  settledCommandStates,
  type CursorStream,
  type PruneOptions,
} from './retention.js';
export {
  defaultPartitionRows,
  detachHistoryPartition,
  dropEmptyHistoryPartitions,
  ensureHistoryPartitions,
  historyPartitions,
  pruneInventorySnapshots,
  pruneUsageWindows,
  type HistoryPartition,
  type HistoryPruneOptions,
  type HistoryTable,
} from './history.js';
export { historyTables } from './migrations/0018_partitioned_history.js';
export {
  retentionFindings,
  retentionModule,
  retentionWorkKind,
  runRetention,
  type RetentionModuleOptions,
  type RetentionPass,
} from './retention-module.js';
