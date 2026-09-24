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
]);
