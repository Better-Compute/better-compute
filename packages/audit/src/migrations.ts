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

/**
 * Archived months (`audit_events` is partitioned by UTC month, core/0018): each checkpoint records the span of
 * `occurred_at` it sealed, and `audit_archives` lists the months an operator archived (detached) after they were
 * sealed. Verification reports a checkpoint wholly inside archived months as archived instead of recomputing a
 * root over rows that are no longer attached.
 */
export const archivesMigration: Migration = {
  name: 'audit/0002_archives',
  sql: `
ALTER TABLE audit_checkpoints ADD COLUMN occurred_from timestamptz, ADD COLUMN occurred_to timestamptz;
UPDATE audit_checkpoints c SET (occurred_from, occurred_to) = (
  SELECT min(e.occurred_at), max(e.occurred_at) FROM audit_events e
   WHERE e.tenant_id = c.tenant_id
     AND (e.txid, e.seq) > (c.from_txid, c.from_seq) AND (e.txid, e.seq) <= (c.to_txid, c.to_seq));
CREATE TABLE audit_archives (
  -- The first day of an archived UTC month.
  month date PRIMARY KEY CHECK (extract(day FROM month) = 1),
  partition text,
  archived_by text,
  archived_at timestamptz NOT NULL DEFAULT compute_now()
);
`,
};

export const auditMigrations: readonly Migration[] = [checkpointsMigration, archivesMigration];
