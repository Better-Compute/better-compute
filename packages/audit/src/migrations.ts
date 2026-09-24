import type { Migration } from '@better-compute/core';

/**
 * Signed per-tenant Merkle checkpoints over `audit_events`. Each checkpoint covers the tenant's rows committed
 * in one global range of the (txid, seq) commit cursor and links to the tenant's previous checkpoint by hash,
 * so an altered, inserted or removed row, and a removed checkpoint, are all detectable.
 */
export const checkpointsMigration: Migration = {
  name: 'audit/0001_checkpoints',
  sql: `
CREATE TABLE audit_checkpoints (
  tenant_id text NOT NULL,
  -- 1, 2, 3, … per tenant; a gap means a removed checkpoint.
  sequence bigint NOT NULL CHECK (sequence > 0),
  -- The global commit-cursor range (from, to] the checkpoint covers.
  from_txid xid8 NOT NULL,
  from_seq bigint NOT NULL,
  to_txid xid8 NOT NULL,
  to_seq bigint NOT NULL,
  size int NOT NULL CHECK (size > 0),
  -- base64url RFC 6962 root.
  root text NOT NULL,
  first_event_id text NOT NULL,
  last_event_id text NOT NULL,
  -- The exact signed bytes (canonical JSON) and the signature { kid, sig, chain }.
  body text NOT NULL,
  signature jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT compute_now(),
  PRIMARY KEY (tenant_id, sequence)
);
CREATE TABLE audit_checkpoint_cursor (
  name text PRIMARY KEY,
  txid xid8 NOT NULL,
  seq bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT compute_now()
);
`,
};

export const auditMigrations: readonly Migration[] = [checkpointsMigration];
