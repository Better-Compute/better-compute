import type { Migration } from '@better-compute/core';

/**
 * What the v0.1 server runtime asked for (PLAN.md §8.4). Additive only.
 * - `outbox_cursors`: durable sink and reader cursors, `(txid, seq)` per name, per stream
 *   (`outbox` or `authz_changes`); retention prunes only behind every cursor of a stream.
 * - `work_queue.attempts`: consecutive failures of a key, for back-off.
 * - `commands.owner`: the module a command belongs to (NULL: derived from the idempotency-key prefix).
 * - `created_at` on `outbox` and `authz_changes`, so retention can keep a minimum age.
 * - Indexes for tenant-scoped event reads, usage listings and join-token listings.
 */
export const runtimeMigration: Migration = {
  name: 'core/0009_runtime',
  sql: `
CREATE TABLE outbox_cursors (
  name text PRIMARY KEY,
  stream text NOT NULL DEFAULT 'outbox' CHECK (stream IN ('outbox', 'authz_changes')),
  txid xid8 NOT NULL,
  seq bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT compute_now()
);
CREATE INDEX outbox_cursors_stream ON outbox_cursors (stream, txid, seq);

ALTER TABLE work_queue ADD COLUMN attempts int NOT NULL DEFAULT 0 CHECK (attempts >= 0);
ALTER TABLE commands ADD COLUMN owner text;
ALTER TABLE outbox ADD COLUMN created_at timestamptz NOT NULL DEFAULT compute_now();
ALTER TABLE authz_changes ADD COLUMN created_at timestamptz NOT NULL DEFAULT compute_now();

CREATE INDEX outbox_tenant_cursor ON outbox ((payload->>'tenantId'), txid, seq);
CREATE INDEX usage_windows_tenant ON usage_windows (tenant_id, window_start, idempotency_key);
CREATE INDEX join_tokens_tenant_pool ON join_tokens (tenant_id, pool_id, id);
`,
};

/** The tables `core/0009_runtime` creates. */
export const runtimeTables = ['outbox_cursors'] as const;
