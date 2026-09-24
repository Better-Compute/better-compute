import type { Migration } from '@better-compute/core';

/**
 * Commit order for audit events (PLAN.md §13, v0.4 Merkle audit checkpoints). Like `outbox` and
 * `authz_changes`, readers page by `(txid, seq)` below `pg_snapshot_xmin`, so a long transaction
 * can never land behind a checkpoint: `occurred_at` is the transaction's start time and cannot
 * give that guarantee. Rows written before this migration get txid 0 and sort first. Additive only.
 */
export const auditCommitOrderMigration: Migration = {
  name: 'core/0005_audit_commit_order',
  sql: `
ALTER TABLE audit_events ADD COLUMN txid xid8 NOT NULL DEFAULT '0'::xid8;
ALTER TABLE audit_events ALTER COLUMN txid SET DEFAULT pg_current_xact_id();
ALTER TABLE audit_events ADD COLUMN seq bigserial;
CREATE INDEX audit_events_commit ON audit_events (txid, seq);
CREATE INDEX audit_events_tenant_commit ON audit_events (tenant_id, txid, seq);
`,
};
