import type { Migration } from '@better-compute/core';
import { vpsProviderBootstrapsMigration } from './bootstraps.js';
import {
  vpsIdentityRebindMigration,
  vpsSandboxExpiringMigration,
  vpsSandboxExtendingMigration,
  vpsSandboxesMigration,
  vpsTemplateEnvMigration,
  vpsTemplateNetworkMigration,
  vpsWarmClaimsMigration,
  vpsWarmSecretVersionsMigration,
} from './sandboxes.js';
import {
  vpsHostCertValidityMigration,
  vpsHostCertificatesMigration,
  vpsSandboxMetricIndexesMigration,
  vpsSandboxSnapshotsMigration,
  vpsSnapshotAgentMigration,
  vpsSnapshotFixesMigration,
} from './snapshots.js';

/**
 * The VPS tables (PLAN.md §3.6, §8.3 "v0.3 tables"): flavors per pool, provider accounts, instances
 * and pool IPAM. Instances follow the reservations pattern: the row is written as a draft in the
 * admission's first transaction (idempotency scoped to tenant + owner identity) and admitted in
 * the second. Every timestamp default is `compute_now()` (P9).
 */
export const vpsBaseMigration: Migration = {
  name: 'vps/0001_instances',
  sql: `
CREATE TABLE flavors (
  id text PRIMARY KEY,
  pool_id text NOT NULL REFERENCES pools,
  name text NOT NULL,
  vcpu int NOT NULL CHECK (vcpu > 0),
  memory_gib int NOT NULL CHECK (memory_gib > 0),
  disk_gib int NOT NULL CHECK (disk_gib > 0),
  gpus int NOT NULL DEFAULT 0 CHECK (gpus >= 0),
  -- Provider pools: the provider offer this flavor creates.
  offer_id text,
  archived bool NOT NULL DEFAULT false,
  version bigint NOT NULL,
  UNIQUE (pool_id, name)
);

-- A provider account is data validated by its provider's manifest; secrets are SecretRefs only.
CREATE TABLE provider_accounts (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  provider text NOT NULL,
  name text NOT NULL,
  config jsonb NOT NULL,
  version bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT compute_now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE instances (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  pool_id text NOT NULL REFERENCES pools,
  project_id text,
  flavor_id text NOT NULL REFERENCES flavors,
  -- The flavor as admitted: {"name", "vcpu", "memoryGiB", "diskGiB", "gpus"}.
  flavor jsonb NOT NULL,
  image_id text NOT NULL,
  -- The resolved image: {"url", "sha256", "format", "verified"}; provider pools keep the ref only.
  image jsonb,
  ssh_keys text[] NOT NULL DEFAULT '{}',
  user_data text,
  runtime text NOT NULL,
  -- Admission drafts are invisible to reads until the handler admits them.
  draft bool NOT NULL DEFAULT true,
  state text NOT NULL,
  desired_state text NOT NULL CHECK (desired_state IN ('running', 'stopped', 'deleted')),
  node_id text REFERENCES nodes,
  allocation_id text,
  provider_account_id text REFERENCES provider_accounts,
  external_id text,
  addresses text[] NOT NULL DEFAULT '{}',
  -- What the host runtime or the provider last reported.
  reported_state text,
  reported_at timestamptz,
  -- Quota charged outside placement (provider pools), refunded when the instance is deleted.
  quota_charged jsonb,
  owner_identity_id text NOT NULL,
  agent_id text,
  delegation_id text,
  idempotency_key text NOT NULL,
  request_hash bytea NOT NULL,
  conditions jsonb NOT NULL DEFAULT '[]',
  version bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT compute_now(),
  UNIQUE (tenant_id, owner_identity_id, idempotency_key)
);
CREATE INDEX instances_node ON instances (node_id) WHERE state <> 'deleted';
CREATE INDEX instances_tenant ON instances (tenant_id, state) WHERE NOT draft;

-- IPAM (§3.6 network ipam: 'pool'): one IPv4 range per hosted pool, one lease per instance.
CREATE TABLE ip_pools (
  pool_id text PRIMARY KEY REFERENCES pools,
  cidr cidr NOT NULL,
  gateway inet NOT NULL,
  first_host inet NOT NULL,
  last_host inet NOT NULL,
  CHECK (family(cidr) = 4 AND first_host <= last_host AND first_host << cidr AND last_host << cidr)
);
CREATE TABLE ip_leases (
  pool_id text NOT NULL REFERENCES ip_pools,
  address inet NOT NULL,
  instance_id text NOT NULL UNIQUE,
  PRIMARY KEY (pool_id, address)
);
`,
};

/**
 * Hosted instances' user data reaches the host only as a `secret://` ref it fetches through the
 * broker (§6 "Secrets"): vps seals the rendered cloud-config at admission and deletes it with the
 * instance. `user_data_sealed` tells a ref vps made from one the tenant brought.
 */
export const vpsSealedUserDataMigration: Migration = {
  name: 'vps/0002_sealed_user_data',
  sql: `ALTER TABLE instances ADD COLUMN user_data_sealed bool NOT NULL DEFAULT false;`,
};

/**
 * (v1.1 §3.8) A flavor's `placement` ({numaAffine, pinned, hugepages}) and, per instance, where on
 * its host it landed (`host_placement`: cpus, mems, hugepageSizeBytes, pinned), which the next
 * placement on that host reads to keep pinned CPUs exclusive.
 */
export const vpsPlacementMigration: Migration = {
  name: 'vps/0018_placement',
  sql: `ALTER TABLE flavors ADD COLUMN placement jsonb;
ALTER TABLE instances ADD COLUMN host_placement jsonb;`,
};

/** The VPS module's migrations, in ledger order. */
export const vpsMigrations: readonly Migration[] = Object.freeze([
  vpsBaseMigration,
  vpsSealedUserDataMigration,
  vpsProviderBootstrapsMigration,
  vpsSandboxesMigration,
  vpsSandboxSnapshotsMigration,
  vpsWarmClaimsMigration,
  vpsTemplateEnvMigration,
  vpsTemplateNetworkMigration,
  vpsSnapshotFixesMigration,
  vpsSandboxMetricIndexesMigration,
  vpsHostCertificatesMigration,
  vpsHostCertValidityMigration,
  vpsSandboxExpiringMigration,
  vpsSandboxExtendingMigration,
  vpsSnapshotAgentMigration,
  vpsWarmSecretVersionsMigration,
  vpsIdentityRebindMigration,
  vpsPlacementMigration,
]);
