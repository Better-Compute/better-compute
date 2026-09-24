import type { Migration } from '@better-compute/core';

/**
 * The v0.2 server groups (PLAN.md §3.3, §6, §9.2). Additive only.
 * - `join_requests`: the approval queue behind `joinRequests` and the `discovery` attestor. JoinService
 *   writes a `pending` row and commits without spending the token. An operator approves or rejects it.
 *   The retried Join (same CSR) consumes an `approved` row in its own transaction, so an approval is
 *   single-use. At most one pending request per machine: by `hardware_key`, or by `(site, mac)` when
 *   the key is unknown (placeholder DMI).
 * - `node_certs.allowed_kinds`: the command kinds a certificate may receive (exact kinds or `prefix.*`
 *   globs; NULL = no restriction), written from `AttestationResult.allowedKinds` (ramdisk certs).
 * - `nodes.deleted_at`: `nodes.delete` tombstones nodes that audit rows, certs and snapshots reference.
 * - `secret_refs`: what the API knows about a secret it stored: the ref, a version bumped by every
 *   `secrets.put`, and never the value (that stays sealed in the SecretStore).
 */
export const v02ServerMigration: Migration = {
  name: 'core/0010_v02_server',
  sql: `
CREATE TABLE join_requests (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  site_id text NOT NULL REFERENCES sites,
  -- NULL until an approval assigns one (discovery of an unknown machine names only its site).
  pool_id text REFERENCES pools,
  -- The attestor that asked: discovery, provisioned, x509pop, ... (free text; plugins add more).
  attestor text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'approved', 'rejected', 'expired', 'consumed')),
  claims jsonb NOT NULL DEFAULT '{}',
  hardware_key bytea,
  mac text,
  ip text,
  workflow_id text,
  -- The site agent that vouched (DiscoveryAssertion), at its boot-lease epoch.
  vouched_by text,
  boot_lease_epoch bigint,
  csr_sha256 bytea NOT NULL CHECK (length(csr_sha256) = 32),
  -- The node the join resumes (a known machine), or the one it created once consumed.
  node_id text,
  reason text,
  created_at timestamptz NOT NULL DEFAULT compute_now(),
  expires_at timestamptz NOT NULL,
  decided_at timestamptz,
  decided_by text,
  consumed_at timestamptz,
  version bigint NOT NULL DEFAULT 1,
  CHECK (hardware_key IS NOT NULL OR mac IS NOT NULL),
  CHECK ((state IN ('pending', 'expired')) = (decided_at IS NULL)),
  CHECK ((state = 'consumed') = (consumed_at IS NOT NULL))
);
CREATE UNIQUE INDEX join_requests_pending_key ON join_requests (tenant_id, hardware_key)
  WHERE state = 'pending' AND hardware_key IS NOT NULL;
CREATE UNIQUE INDEX join_requests_pending_mac ON join_requests (site_id, mac)
  WHERE state = 'pending' AND hardware_key IS NULL;
CREATE INDEX join_requests_tenant_state ON join_requests (tenant_id, site_id, state, id);
CREATE INDEX join_requests_expiry ON join_requests (expires_at) WHERE state IN ('pending', 'approved');

ALTER TABLE node_certs ADD COLUMN allowed_kinds text[];

ALTER TABLE nodes ADD COLUMN deleted_at timestamptz;

CREATE TABLE secret_refs (
  ref text PRIMARY KEY CHECK (ref ~ '^[a-z][a-z0-9+.-]*://'),
  tenant_id text NOT NULL,
  name text NOT NULL,
  version bigint NOT NULL CHECK (version >= 1),
  -- The SecretStore that holds the value (its id).
  store text NOT NULL,
  -- The idempotency key of the put that wrote this version: a retry replays instead of bumping.
  last_idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT compute_now(),
  updated_at timestamptz NOT NULL DEFAULT compute_now(),
  UNIQUE (tenant_id, name)
);
`,
};

/** The tables `core/0010_v02_server` creates. */
export const v02ServerTables = ['join_requests', 'secret_refs'] as const;
