// `auditModule()`: the hourly checkpoint job and a doctor check for rows left unsealed too long.

import {
  defineModule,
  type ComputeModule,
  type Duration,
  type Finding,
} from '@better-compute/core';
import type { SigningKey } from '@better-compute/pki';
import { checkpointAudit } from './checkpoints.js';
import { auditMigrations } from './migrations.js';

export interface AuditModuleOptions {
  /** The audit signing key (the PKI bundle's `auditSigning`). */
  signer: SigningKey;
  /** Checkpoint cadence. Default `1h` (§13: hourly). */
  every?: Duration;
  /** Rows per pass. Default 50 000. */
  limit?: number;
}

export function auditModule(options: AuditModuleOptions): ComputeModule<'audit'> {
  const selfCheck = async (
    context: Parameters<NonNullable<ComputeModule['selfCheck']>>[0],
  ): Promise<Finding[]> => {
    const { rows } = await context.sql.query<{ stale: string }>(
      `SELECT count(*)::text AS stale FROM audit_events e
        WHERE (e.txid, e.seq) > coalesce(
                (SELECT (c.txid, c.seq) FROM audit_checkpoint_cursor c WHERE c.name = 'audit'),
                ('0'::xid8, 0::bigint))
          AND e.occurred_at < compute_now() - interval '3 hours'`,
    );
    const stale = Number(rows[0]?.stale ?? 0);
    return stale > 0
      ? [
          {
            check: 'audit.checkpoints',
            severity: 'warning',
            message: `${stale} audit events older than 3 hours are not sealed by a checkpoint`,
            fix: 'Run a worker with the audit.checkpoint reconciler',
            count: stale,
          },
        ]
      : [];
  };
  return defineModule({
    name: 'audit',
    migrations: [...auditMigrations],
    reconcilers: [
      {
        name: 'audit.checkpoint',
        shardBy: 'none',
        periodic: [{ key: 'checkpoint', every: options.every ?? '1h' }],
        run: async (context) =>
          (
            await checkpointAudit(context.sql, {
              signer: options.signer,
              ...(options.limit ? { limit: options.limit } : {}),
            })
          ).more
            ? 'SYNC_AGAIN'
            : 'DONE',
      },
    ],
    selfCheck,
  });
}
