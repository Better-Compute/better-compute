import type { Migration } from '@better-compute/core';

// The metal module's table (PLAN.md §3.5, §11.1): what the control plane knows about a machine's
// BMC and boot, and which workflow drives its current provision state.

export const metalMigrations: readonly Migration[] = Object.freeze([
  {
    name: 'metal/0001_nodes',
    sql: `
CREATE TABLE metal_nodes (
  node_id text PRIMARY KEY REFERENCES nodes,
  tenant_id text NOT NULL,
  bmc_driver text NOT NULL,
  bmc_address text NOT NULL,
  -- A secret:// (or vault://, env://) reference; never a value. NULL once destroyed (retired).
  bmc_credentials text,
  -- Hex SHA-256 of the BMC certificate's SPKI, when pinned.
  bmc_tls_spki_sha256 text CHECK (bmc_tls_spki_sha256 ~ '^[0-9a-f]{64}$'),
  -- PXE MACs, lower-case colon form, and the SMBIOS product UUID once known.
  macs text[] NOT NULL DEFAULT '{}',
  product_uuid text,
  arch text NOT NULL DEFAULT 'x86_64' CHECK (arch IN ('x86_64', 'arm64')),
  uefi bool NOT NULL DEFAULT true,
  hardware_profile text,
  -- The provision state the current workflow serves, and that workflow.
  phase text,
  workflow_id text,
  -- deploy: the tenant profile to run; release: the wipe mode.
  deploy_profile_id text,
  deploy_profile_version int,
  release_wipe text NOT NULL DEFAULT 'quick' CHECK (release_wipe IN ('none', 'quick', 'secure-erase', 'crypto-erase')),
  last_error jsonb,
  created_at timestamptz NOT NULL DEFAULT compute_now(),
  updated_at timestamptz NOT NULL DEFAULT compute_now(),
  version bigint NOT NULL DEFAULT 1
);
CREATE INDEX metal_nodes_tenant ON metal_nodes (tenant_id);
`,
  },
  {
    name: 'metal/0002_addresses',
    sql: `
-- The machine's own IP addresses (from Redfish inspection or the operator). site.httpProxy may only
-- reach these, so a step cannot turn the site agent into a proxy for anything on its network.
ALTER TABLE metal_nodes ADD COLUMN addresses text[] NOT NULL DEFAULT '{}';
`,
  },
  {
    name: 'metal/0003_tenant_root',
    sql: `
-- Dedicated-root leases (PLAN.md §10.5 binding 'node', §13 tenant-root bare metal, v0.5): the
-- capacity allocation the node is leased under, and whether tenant code may have run on it since the
-- lease began (then only the tenant-root teardown returns it to ready).
ALTER TABLE metal_nodes ADD COLUMN lease_allocation_id text;
ALTER TABLE metal_nodes ADD COLUMN tenant_root bool NOT NULL DEFAULT false;
CREATE UNIQUE INDEX metal_nodes_lease ON metal_nodes (lease_allocation_id) WHERE lease_allocation_id IS NOT NULL;
`,
  },
  {
    name: 'metal/0004_bmc_credentials',
    sql: `
-- BMC credential rotation (PLAN.md §3.5, §13), two-phase: a new version starts pending, and becomes
-- current only after the site agent applied it and logged in with it (a node-signed result). The old
-- version stays current until then. Only refs are stored; values live sealed in the SecretStore.
-- A failed version keeps its ref: the BMC may hold it if the result was lost after the change.
CREATE TABLE bmc_credential_versions (
  node_id text NOT NULL REFERENCES nodes,
  version int NOT NULL CHECK (version >= 1),
  ref text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'current', 'superseded', 'failed')),
  error jsonb,
  created_at timestamptz NOT NULL DEFAULT compute_now(),
  verified_at timestamptz,
  -- When a superseded version's secret was deleted from the store (never while a command names it).
  purged_at timestamptz,
  PRIMARY KEY (node_id, version)
);
CREATE UNIQUE INDEX bmc_credential_versions_current ON bmc_credential_versions (node_id) WHERE state = 'current';
CREATE UNIQUE INDEX bmc_credential_versions_pending ON bmc_credential_versions (node_id) WHERE state = 'pending';
`,
  },
  {
    name: 'metal/0005_batch',
    sql: `
-- The destructive-command batch (PLAN.md §13 quorum) a bulk verb (metal.bulk) put the node under: the
-- reconciler starts every workflow of the verb's chain under it, and clears it once the node rests.
ALTER TABLE metal_nodes ADD COLUMN batch_id text;
`,
  },
]);
