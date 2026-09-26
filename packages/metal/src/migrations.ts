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
  {
    name: 'metal/0006_bmc_driver_options',
    sql: `
-- Per-BMC driver options set at enrollment (bmc.driverOptions, e.g. bcx-ipmi { "cipherSuite": 3 }): sent on
-- every BMC operation as BmcOperationRequest.driver_options_json. Never credentials.
ALTER TABLE metal_nodes ADD COLUMN bmc_driver_options jsonb CHECK (bmc_driver_options IS NULL OR jsonb_typeof(bmc_driver_options) = 'object');
`,
  },
  {
    name: 'metal/0007_discovered',
    sql: `
-- PXE discovery (discovery.ts): the machines a site agent saw PXE-booting with no live boot entry
-- (StatusReport.discovered), as its last report listed them, replaced whole on each change.
-- matched_node_id: the enrolled machine whose MACs this entry filled.
CREATE TABLE metal_discovered (
  agent_node_id text NOT NULL REFERENCES nodes ON DELETE CASCADE,
  site_id text NOT NULL,
  mac text NOT NULL CHECK (mac ~ '^[0-9a-f]{2}(:[0-9a-f]{2}){5}$'),
  product_uuid text CHECK (product_uuid ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  arch text NOT NULL DEFAULT '',
  first_seen timestamptz,
  last_seen timestamptz,
  count bigint NOT NULL DEFAULT 0,
  relay text,
  matched_node_id text,
  PRIMARY KEY (agent_node_id, mac)
);
CREATE INDEX metal_discovered_site ON metal_discovered (site_id);
CREATE INDEX metal_discovered_uuid ON metal_discovered (product_uuid) WHERE product_uuid IS NOT NULL;
-- The digest of each agent's last stored list, so an unchanged report writes nothing.
CREATE TABLE metal_discovery_reports (
  agent_node_id text PRIMARY KEY REFERENCES nodes ON DELETE CASCADE,
  sha256 bytea NOT NULL,
  reported_at timestamptz NOT NULL DEFAULT compute_now()
);
`,
  },
  {
    name: 'metal/0008_mac_source',
    sql: `
-- Where the PXE MACs came from (review 2, LOW 6): the operator (enroll, metal.confirmMac), out-of-band
-- inspection, or PXE discovery on a pool that trusts its provisioning network. discovered_mac: a MAC PXE
-- discovery found for a machine without MACs, awaiting metal.confirmMac; never booted until confirmed.
ALTER TABLE metal_nodes ADD COLUMN mac_source text NOT NULL DEFAULT 'operator'
  CHECK (mac_source IN ('operator', 'inspection', 'discovered'));
ALTER TABLE metal_nodes ADD COLUMN discovered_mac text CHECK (discovered_mac ~ '^[0-9a-f]{2}(:[0-9a-f]{2}){5}$');
ALTER TABLE metal_nodes ADD COLUMN discovered_mac_at timestamptz;
`,
  },
]);
