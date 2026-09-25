import { defineModule, type ComputeModule, type Duration, type ReconcileContext } from '@better-compute/core';
import { expireJoinRequests, pruneAttestationUses, pruneBehindCursors } from './retention.js';

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
}

export interface RetentionPass {
  outbox: number;
  authzChanges: number;
  attestationUses: number;
  joinRequestsExpired: number;
}

export const retentionWorkKind = 'core.retention';

/** One retention pass (what the reconciler runs), for hosts that schedule it themselves. */
export async function runRetention(sql: ReconcileContext['sql'], options: RetentionModuleOptions = {}): Promise<RetentionPass> {
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
  return {
    outbox: await drain(() => sql.transaction((tx) => pruneBehindCursors(tx, 'outbox', prune))),
    authzChanges: await drain(() => sql.transaction((tx) => pruneBehindCursors(tx, 'authz_changes', prune))),
    attestationUses: await drain(() => sql.transaction((tx) => pruneAttestationUses(tx, { batch }))),
    joinRequestsExpired: await drain(() => sql.transaction((tx) => expireJoinRequests(tx, { batch }))),
  };
}

/** The retention module: a singleton pass every `every` (outbox, authz_changes, attestation uses, join requests). */
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
          if (Object.values(pass).some((n) => n > 0)) context.log?.info?.('retention pass', { ...pass });
          return 'DONE';
        },
      },
    ],
  });
}
