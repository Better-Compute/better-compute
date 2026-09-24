import type { Migration } from '@better-compute/core';

/**
 * v0.1 additions to the base schema. Additive only: new nullable or defaulted columns and new
 * tables, so every v0.1 writer of the 0002 columns keeps working.
 *
 * - Columns the P0 contracts already name (`Node.adapter/drivers/power/failedFrom`,
 *   `Reservation.leaseExpiresAt/conditions`, `Offering.priority/allowedRegions/onBudgetExceeded`,
 *   `Pool.providerAccountId`), and `commands.attempt/result/updated_at` for the gateway and the
 *   CommandSweeper (§7.4).
 * - Inventory ingest (§10.1): `node_inventory` holds the hashes a node last reported, and
 *   `node_inventory_sections` the latest verified bytes of each section, so sections that arrive in
 *   separate frames assemble into one snapshot.
 */
export const v01Migration: Migration = {
  name: 'core/0003_v01',
  sql: `
ALTER TABLE nodes
  ADD COLUMN adapter text NOT NULL DEFAULT 'bcd/v1',
  ADD COLUMN drivers jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN power text NOT NULL DEFAULT 'unknown' CHECK (power IN ('on', 'off', 'unknown')),
  ADD COLUMN failed_from text,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT compute_now();

ALTER TABLE reservations
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN conditions jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT compute_now();
-- The lease reaper (§10.5) scans renewable reservations by deadline.
CREATE INDEX reservations_lease ON reservations (lease_expires_at) WHERE lease_expires_at IS NOT NULL;

ALTER TABLE pool_offers
  ADD COLUMN priority int NOT NULL DEFAULT 0,
  ADD COLUMN allowed_regions text[],
  ADD COLUMN on_budget_exceeded text CHECK (on_budget_exceeded IN ('notify', 'stop-new', 'drain'));

-- No foreign key: provider_accounts arrives with v0.3.
ALTER TABLE pools ADD COLUMN provider_account_id text;

ALTER TABLE commands
  -- Dispatches of this command so far; BUSY and resume re-dispatch it (§7.4).
  ADD COLUMN attempt int NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  -- The kind's serialized result message from the terminal CommandUpdate.
  ADD COLUMN result bytea,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT compute_now();

-- Inventory ingest (§10.1). Hello and every 10th heartbeat replace reported_hashes; the gateway
-- then requests the sections whose stored sha256 differs, and the Inventory reconciler turns a
-- complete set into an inventory_snapshots row once applied_digest no longer matches.
CREATE TABLE node_inventory (
  node_id text PRIMARY KEY REFERENCES nodes,
  -- {"<section>": "<hex sha256>"}, as the node last reported them.
  reported_hashes jsonb NOT NULL DEFAULT '{}',
  reported_at timestamptz NOT NULL DEFAULT compute_now(),
  boot_id text,
  -- inventoryDigest() of the snapshot last applied to devices, labels and conditions.
  applied_digest text,
  applied_snapshot_id text,
  applied_at timestamptz
);
CREATE TABLE node_inventory_sections (
  node_id text REFERENCES nodes,
  section text CHECK (section IN ('system', 'cpu', 'memory', 'disks', 'nics', 'gpus', 'bmc', 'os')),
  -- Lowercase hex, verified over content before the row is written.
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  content bytea NOT NULL,
  received_at timestamptz NOT NULL DEFAULT compute_now(),
  PRIMARY KEY (node_id, section)
);
CREATE INDEX inventory_snapshots_sha ON inventory_snapshots (node_id, sha256);
`,
};

/** The tables `core/0003_v01` creates. */
export const v01Tables = ['node_inventory', 'node_inventory_sections'] as const;
