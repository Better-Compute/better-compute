import type { Migration } from '@better-compute/core';

/**
 * Device quarantines (PLAN.md §10.1, v0.2 Health). A quarantined device is `healthy = false` and
 * leaves placement, but, unlike a node taint in `no_schedule_reasons`, the rest of the node stays
 * schedulable. Inventory never marks a quarantined device healthy again; the row is removed when its
 * source clears it (inventory findings) or an operator does (XID quarantines, RMA). Additive.
 */
export const deviceHealthMigration: Migration = {
  name: 'core/0007_device_health',
  sql: `
CREATE TABLE device_health (
  device_id text NOT NULL,
  node_id text NOT NULL REFERENCES nodes,
  -- The condition behind it: Xid48, RowRemapFailed, EccUncorrectable, NvlinkDegraded, …
  reason text NOT NULL,
  -- 'inventory' rows follow the latest inventory; 'xid' and 'operator' rows stay until cleared.
  source text NOT NULL CHECK (source IN ('inventory', 'xid', 'operator')),
  message text,
  since timestamptz NOT NULL DEFAULT compute_now(),
  PRIMARY KEY (device_id, reason)
);
CREATE INDEX device_health_node ON device_health (node_id);
`,
};

/** The tables `core/0007_device_health` creates. */
export const deviceHealthTables = ['device_health'] as const;
