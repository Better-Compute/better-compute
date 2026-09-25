import {
  defineModule,
  type AuditRecord,
  type AuditSink,
  type ComputeModule,
  type Json,
  type Logger,
  type Migration,
  type ReconcileContext,
  type SqlExecutor,
} from '@better-compute/core';

// Audit sinks (`sinks.audit`, and `AuditSink`s a module lists in `extensions`): every committed
// `audit_events` row, in commit order, to each sink (a SIEM, an archive). Hosted like SiteBoot: a
// singleton reconciler ticks every few seconds and gives each sink the rows after its own cursor.
// At least once: a batch delivered before its cursor was saved (or before the holder died) is
// delivered again, and records carry ids for deduplication. One failing sink backs off without
// holding the others back.

export const auditSinksModuleName = 'audit-sinks';
/** The singleton reconciler and its one periodic key. */
export const auditSinksReconciler = { name: 'audit-sinks', key: 'tick', every: '5s' } as const;

/** Module-owned cursors: `outbox_cursors` only knows the outbox and authz_changes streams. */
export const auditSinkCursorsMigration: Migration = {
  name: 'audit-sinks/0001_cursors',
  sql: `
CREATE TABLE audit_sink_cursors (
  sink_id text PRIMARY KEY,
  txid xid8 NOT NULL,
  seq bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT compute_now()
);`,
};

/** Rows of transactions that committed before every open one, after the cursor, in commit order. */
const readAudit = `SELECT a.id, a.tenant_id, a.occurred_at, a.action, a.resource_type, a.resource_id,
       a.admission, a.details, a.txid::text AS txid_text, a.seq::text AS seq_text
  FROM audit_events a
 WHERE a.txid < pg_snapshot_xmin(pg_current_snapshot()) AND (a.txid, a.seq) > ($1::xid8, $2::bigint)
 ORDER BY a.txid, a.seq LIMIT $3`;

/** Forward only: a late save by a holder that lost the singleton never moves a cursor back. */
const saveCursor = `INSERT INTO audit_sink_cursors (sink_id, txid, seq) VALUES ($1, $2::xid8, $3::bigint)
  ON CONFLICT (sink_id) DO UPDATE SET txid = EXCLUDED.txid, seq = EXCLUDED.seq, updated_at = compute_now()
  WHERE (audit_sink_cursors.txid, audit_sink_cursors.seq) < (EXCLUDED.txid, EXCLUDED.seq)`;

interface AuditRow {
  id: string;
  tenant_id: string;
  occurred_at: Date | string;
  action: string;
  resource_type: string;
  resource_id: string;
  admission: unknown;
  details: unknown;
  txid_text: string;
  seq_text: string;
}

const parsed = (value: unknown) => (typeof value === 'string' ? JSON.parse(value) : value);

function toRecord(row: AuditRow): AuditRecord {
  const record: AuditRecord = {
    id: row.id,
    tenantId: row.tenant_id,
    time: new Date(row.occurred_at).getTime(),
    action: row.action,
    resource: { type: row.resource_type, id: row.resource_id },
  };
  const admission = parsed(row.admission);
  if (admission !== null && admission !== undefined) record.admission = admission;
  const details = parsed(row.details);
  if (details !== null && details !== undefined)
    record.details = details as Record<string, Json>;
  return record;
}

export interface AuditSinksOptions {
  /** Records per delivery (default 500). */
  batchSize?: number;
}

/**
 * One pass: each sink not backing off gets the next batches after its cursor (until one comes back
 * short, so a pass drains a backlog). Returns how many records were delivered in total.
 */
export function createAuditSinkPass(
  sinks: readonly AuditSink[],
  options: AuditSinksOptions & { log?: Logger; now?: () => number } = {},
) {
  const batchSize = options.batchSize ?? 500;
  const now = options.now ?? Date.now;
  const backoff = new Map<string, { failures: number; retryAt: number }>();
  return async (sql: SqlExecutor): Promise<number> => {
    let delivered = 0;
    for (const sink of sinks) {
      const state = backoff.get(sink.id);
      if (state && now() < state.retryAt) continue;
      const { rows: stored } = await sql.query<{ txid_text: string; seq_text: string }>(
        'SELECT txid::text AS txid_text, seq::text AS seq_text FROM audit_sink_cursors WHERE sink_id = $1',
        [sink.id],
      );
      let cursor = { txid: stored[0]?.txid_text ?? '0', seq: stored[0]?.seq_text ?? '0' };
      for (;;) {
        const { rows } = await sql.query<AuditRow>(readAudit, [cursor.txid, cursor.seq, batchSize]);
        if (!rows.length) break;
        try {
          await sink.write(rows.map(toRecord));
        } catch (error) {
          const failures = (state?.failures ?? 0) + 1;
          backoff.set(sink.id, {
            failures,
            retryAt: now() + Math.min(1000 * 2 ** (failures - 1), 300_000),
          });
          options.log?.warn('An audit sink failed; retrying with back-off', {
            sink: sink.id,
            attempts: failures,
            error: error instanceof Error ? error.message : String(error),
          });
          break;
        }
        backoff.delete(sink.id);
        const last = rows.at(-1)!;
        cursor = { txid: last.txid_text, seq: last.seq_text };
        await sql.query(saveCursor, [sink.id, cursor.txid, cursor.seq]);
        delivered += rows.length;
        if (rows.length < batchSize) break;
      }
    }
    return delivered;
  };
}

/** The built-in audit-sinks module; the server registers it only when there are audit sinks. */
export function createAuditSinksModule(
  sinks: readonly AuditSink[],
  options: AuditSinksOptions = {},
): ComputeModule<typeof auditSinksModuleName> {
  let pass: ReturnType<typeof createAuditSinkPass> | undefined;
  return Object.freeze(
    defineModule<typeof auditSinksModuleName>({
      name: auditSinksModuleName,
      migrations: [auditSinkCursorsMigration],
      reconcilers: [
        {
          name: auditSinksReconciler.name,
          shardBy: 'none',
          periodic: [{ key: auditSinksReconciler.key, every: auditSinksReconciler.every }],
          async run(context: ReconcileContext, key: string) {
            if (key !== auditSinksReconciler.key) return 'DONE';
            pass ??= createAuditSinkPass(sinks, {
              ...options,
              log: context.log,
              now: () => context.clock.now(),
            });
            await pass(context.sql);
            return 'DONE';
          },
        },
      ],
    }),
  );
}
