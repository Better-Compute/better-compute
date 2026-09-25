import type { Migration } from '@better-compute/core';

/**
 * Break-glass SSH certificates (PLAN.md §13, v0.3): every issuance, for revocation (the KRL each
 * node's NodeSpec carries) and audit. `nodes.issueSshCert` inserts, `nodes.revokeSshCert` sets
 * `revoked_at`, and a GC deletes rows past `expires_at`. Requested by [0b2be8]. Additive only.
 */
export const sshCertificatesMigration: Migration = {
  name: 'core/0014_ssh_certificates',
  sql: `
CREATE TABLE ssh_certificates (
  -- uint64 as decimal (AccessSpec.sshRevokedSerials are decimal strings).
  serial text PRIMARY KEY CHECK (serial ~ '^[0-9]{1,20}$'),
  node_id text NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  tenant_id text NOT NULL,
  identity_id text NOT NULL,
  -- <account>@<nodeId>
  principal text NOT NULL,
  key_id text NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT compute_now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by text,
  revoke_reason text
);
CREATE INDEX ssh_certificates_node_revoked ON ssh_certificates (node_id, expires_at) WHERE revoked_at IS NOT NULL;
CREATE INDEX ssh_certificates_expires ON ssh_certificates (expires_at);
`,
};

/** The tables `core/0014_ssh_certificates` creates. */
export const sshCertificatesTables = ['ssh_certificates'] as const;
