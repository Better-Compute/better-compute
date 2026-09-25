import type { Migration } from '@better-compute/core';
import { migLayoutsMigration } from './mig.js';

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

/**
 * Bookable and bookable-and-healthy devices per node and class (§10.6: reads never aggregate
 * devices), for the placement shortlist. A row trigger on `devices` keeps it exact: every change
 * of `node_id`, `class`, `bookable` or `healthy` takes the old row out of its key and puts the new
 * row into its own, so a repartition that flips a parent and its children in one transaction nets
 * out. Rows are upserted and may reach 0, never deleted, so concurrent device transactions on one
 * node never race a DELETE against an INSERT. Lock order: the counts row after its `devices` row.
 */
export const deviceCountsMigration: Migration = {
  name: 'capacity/0003_device_counts',
  sql: `
CREATE TABLE capacity_device_counts (
  node_id text NOT NULL,
  class text NOT NULL,
  bookable integer NOT NULL DEFAULT 0 CHECK (bookable >= 0),
  healthy integer NOT NULL DEFAULT 0 CHECK (healthy >= 0 AND healthy <= bookable),
  PRIMARY KEY (node_id, class)
);
CREATE FUNCTION capacity_device_counts_apply() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.bookable THEN
    UPDATE capacity_device_counts
       SET bookable = bookable - 1, healthy = healthy - CASE WHEN OLD.healthy THEN 1 ELSE 0 END
     WHERE node_id = OLD.node_id AND class = OLD.class;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.bookable THEN
    INSERT INTO capacity_device_counts AS c (node_id, class, bookable, healthy)
    VALUES (NEW.node_id, NEW.class, 1, CASE WHEN NEW.healthy THEN 1 ELSE 0 END)
    ON CONFLICT (node_id, class) DO UPDATE
      SET bookable = c.bookable + 1, healthy = c.healthy + EXCLUDED.healthy;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER capacity_device_counts
  AFTER INSERT OR DELETE OR UPDATE OF node_id, class, bookable, healthy ON devices
  FOR EACH ROW EXECUTE FUNCTION capacity_device_counts_apply();
INSERT INTO capacity_device_counts (node_id, class, bookable, healthy)
  SELECT node_id, class, count(*), count(*) FILTER (WHERE healthy)
    FROM devices WHERE bookable GROUP BY node_id, class;
`,
};

/**
 * The `reservations.extend` being decided on a reservation (§10.5): the authz projection holds one
 * pending value per resource, so only the request holding this row may stage it. Its own table, not
 * a column on core's `reservations`; gone with the reservation.
 */
export const extendHoldsMigration: Migration = {
  name: 'capacity/0005_extend_holds',
  sql: `
CREATE TABLE capacity_extend_holds (
  reservation_id text PRIMARY KEY REFERENCES reservations ON DELETE CASCADE,
  request_id text NOT NULL,
  held_at timestamptz NOT NULL
);
`,
};

/** The capacity module's migrations, in ledger order. */
export const capacityMigrations: readonly Migration[] = Object.freeze([
  deviceLinksMigration,
  leaseHealthMigration,
  deviceCountsMigration,
  migLayoutsMigration,
  extendHoldsMigration,
]);
