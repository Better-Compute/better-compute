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

/** The capacity module's migrations, in ledger order. */
export const capacityMigrations: readonly Migration[] = Object.freeze([deviceLinksMigration]);
