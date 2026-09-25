import type { Migration } from '@better-compute/core';

/**
 * GPU interconnect per node pair (PLAN.md §10.3 `topology`), materialized from the inventory
 * `gpus` section's topology matrix by `writeDeviceLinks`, so the placer never parses snapshots.
 * Rows are stored once per unordered pair (`a < b`). A rebuildable cache: no foreign keys to
 * `devices`, whose rows the inventory controller replaces.
 */
export const deviceLinksMigration: Migration = {
  name: 'capacity/0001_device_links',
  sql: `
CREATE TABLE capacity_device_links (
  node_id text NOT NULL REFERENCES nodes,
  a text NOT NULL,
  b text NOT NULL,
  link text NOT NULL CHECK (link IN ('NV', 'PIX', 'PXB', 'PHB', 'NODE', 'SYS')),
  PRIMARY KEY (node_id, a, b),
  CHECK (a < b)
);
`,
};

/**
 * Healthy GPUs of a node lease at the start of each usage window (§12.7 billing for `binding:
 * 'node'`): the usage job snapshots them when it first sees a window open, and the window bills
 * that many GPUs, so a GPU that fails mid-lease stops billing from the next window.
 */
export const leaseHealthMigration: Migration = {
  name: 'capacity/0002_lease_health',
  sql: `
CREATE TABLE capacity_lease_health (
  allocation_id text NOT NULL REFERENCES allocations ON DELETE CASCADE,
  window_start timestamptz NOT NULL,
  healthy_gpus numeric NOT NULL CHECK (healthy_gpus >= 0),
  PRIMARY KEY (allocation_id, window_start)
);
`,
};

/** The capacity module's migrations, in ledger order. */
export const capacityMigrations: readonly Migration[] = Object.freeze([
  deviceLinksMigration,
  leaseHealthMigration,
]);
