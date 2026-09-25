import type { Migration } from '@better-compute/core';

/**
 * Partitioned history (PLAN.md §8.3 "History tables are partitioned", §8.6 #8, v0.4). The three
 * append-mostly history tables become range-partitioned by month (UTC) on their time column:
 *
 * - `audit_events` on `occurred_at`;
 * - `inventory_snapshots` on `collected_at`;
 * - `usage_windows` on `window_start`.
 *
 * Each gets a DEFAULT partition, so an insert never fails for want of a partition (sim clocks,
 * skewed rows). `compute_history_partition(parent, at)` creates the month partition holding `at`,
 * first moving any rows of that month out of the default partition, and returns its name (NULL when
 * it already existed). The retention module keeps the next months created ahead.
 *
 * Primary keys gain the partition column, as Postgres requires: `(id, occurred_at)`,
 * `(id, collected_at)` and `(idempotency_key, window_start)`. Ids are unique on their own (ULIDs;
 * usage keys embed their window start), so nothing that was unique stops being so. No foreign key
 * points at these tables. Rows are copied with every value intact, `txid`/`seq` included, so sealed
 * audit checkpoints still verify; `audit_events.seq` keeps its sequence.
 */
export const partitionedHistoryMigration: Migration = {
  name: 'core/0018_partitioned_history',
  sql: `
CREATE FUNCTION compute_history_partition(parent regclass, at timestamptz) RETURNS text
LANGUAGE plpgsql AS $fn$
DECLARE
  lo timestamptz := date_trunc('month', at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  hi timestamptz := (date_trunc('month', at AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC';
  part text := (SELECT relname FROM pg_class WHERE oid = parent) || '_p' || to_char(lo AT TIME ZONE 'UTC', 'YYYYMM');
  col text;
  deflt regclass;
BEGIN
  -- One creator at a time (the retention pass is a singleton; migrations and tools may race it).
  PERFORM pg_advisory_xact_lock(hashtext('compute_history_partition'));
  IF to_regclass(part) IS NOT NULL THEN
    RETURN NULL;
  END IF;
  SELECT a.attname INTO col
    FROM pg_partitioned_table p JOIN pg_attribute a ON a.attrelid = p.partrelid AND a.attnum = p.partattrs[0]
   WHERE p.partrelid = parent;
  IF col IS NULL THEN
    RAISE EXCEPTION '% is not a partitioned table', parent;
  END IF;
  SELECT c.oid INTO deflt
    FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
   WHERE i.inhparent = parent AND pg_get_expr(c.relpartbound, c.oid) = 'DEFAULT';
  EXECUTE format('CREATE TABLE %I (LIKE %s INCLUDING DEFAULTS INCLUDING CONSTRAINTS)', part, parent);
  -- Attaching fails while the default partition holds rows of the new range: move them first.
  IF deflt IS NOT NULL THEN
    EXECUTE format(
      'WITH moved AS (DELETE FROM %s WHERE %I >= $1 AND %I < $2 RETURNING *) INSERT INTO %I SELECT * FROM moved',
      deflt, col, col, part) USING lo, hi;
  END IF;
  EXECUTE format('ALTER TABLE %s ATTACH PARTITION %I FOR VALUES FROM (%L) TO (%L)', parent, part, lo, hi);
  RETURN part;
END
$fn$;

-- audit_events → partitioned by occurred_at.
ALTER TABLE audit_events RENAME TO audit_events_v1;
ALTER TABLE audit_events_v1 RENAME CONSTRAINT audit_events_pkey TO audit_events_v1_pkey;
DROP INDEX audit_events_tenant, audit_events_resource, audit_events_commit, audit_events_tenant_commit;
ALTER SEQUENCE audit_events_seq_seq OWNED BY NONE;
CREATE TABLE audit_events (
  id text NOT NULL,
  tenant_id text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT compute_now(),
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  admission jsonb,
  details jsonb,
  txid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  seq bigint NOT NULL DEFAULT nextval('audit_events_seq_seq'),
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);
ALTER SEQUENCE audit_events_seq_seq OWNED BY audit_events.seq;
CREATE TABLE audit_events_default PARTITION OF audit_events DEFAULT;
CREATE INDEX audit_events_tenant ON audit_events (tenant_id, occurred_at);
CREATE INDEX audit_events_resource ON audit_events (resource_type, resource_id, occurred_at);
CREATE INDEX audit_events_commit ON audit_events (txid, seq);
CREATE INDEX audit_events_tenant_commit ON audit_events (tenant_id, txid, seq);

-- inventory_snapshots → partitioned by collected_at.
ALTER TABLE inventory_snapshots RENAME TO inventory_snapshots_v1;
ALTER TABLE inventory_snapshots_v1 RENAME CONSTRAINT inventory_snapshots_pkey TO inventory_snapshots_v1_pkey;
DROP INDEX inventory_snapshots_node, inventory_snapshots_sha;
CREATE TABLE inventory_snapshots (
  id text NOT NULL,
  node_id text NOT NULL REFERENCES nodes,
  sha256 bytea NOT NULL,
  section_hashes jsonb NOT NULL,
  sections jsonb NOT NULL,
  boot_id text,
  collected_at timestamptz NOT NULL,
  PRIMARY KEY (id, collected_at)
) PARTITION BY RANGE (collected_at);
CREATE TABLE inventory_snapshots_default PARTITION OF inventory_snapshots DEFAULT;
CREATE INDEX inventory_snapshots_node ON inventory_snapshots (node_id, collected_at);
CREATE INDEX inventory_snapshots_sha ON inventory_snapshots (node_id, sha256);
-- inventory.history pages and inventory.diff read a node's snapshots by id.
CREATE INDEX inventory_snapshots_node_id ON inventory_snapshots (node_id, id);

-- usage_windows → partitioned by window_start.
ALTER TABLE usage_windows RENAME TO usage_windows_v1;
ALTER TABLE usage_windows_v1 RENAME CONSTRAINT usage_windows_pkey TO usage_windows_v1_pkey;
ALTER TABLE usage_windows_v1 RENAME CONSTRAINT usage_windows_allocation_id_window_start_meter_key TO usage_windows_v1_natural_key;
DROP INDEX usage_windows_unrecorded, usage_windows_tenant;
CREATE TABLE usage_windows (
  -- cmp:<allocId>:<windowStartMs>
  idempotency_key text NOT NULL,
  allocation_id text NOT NULL REFERENCES allocations,
  tenant_id text NOT NULL,
  identity_id text,
  meter text NOT NULL,
  quantity numeric NOT NULL CHECK (quantity >= 0),
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  tags jsonb NOT NULL DEFAULT '{}',
  recorded_at timestamptz,
  outcome text CHECK (outcome IN ('recorded', 'duplicate', 'reattributed', 'dead-lettered')),
  CHECK (window_end > window_start),
  PRIMARY KEY (idempotency_key, window_start),
  UNIQUE (allocation_id, window_start, meter)
) PARTITION BY RANGE (window_start);
CREATE TABLE usage_windows_default PARTITION OF usage_windows DEFAULT;
CREATE INDEX usage_windows_unrecorded ON usage_windows (window_end) WHERE recorded_at IS NULL;
CREATE INDEX usage_windows_tenant ON usage_windows (tenant_id, window_start, idempotency_key);

-- Month partitions for the rows already there (at most a year back; older rows stay in the default
-- partition) through next month, then the rows themselves.
SELECT compute_history_partition(t.parent, m AT TIME ZONE 'UTC')
  FROM (VALUES
          ('audit_events'::regclass, (SELECT min(occurred_at) FROM audit_events_v1)),
          ('inventory_snapshots'::regclass, (SELECT min(collected_at) FROM inventory_snapshots_v1)),
          ('usage_windows'::regclass, (SELECT min(window_start) FROM usage_windows_v1))) AS t(parent, oldest),
       generate_series(
         date_trunc('month', greatest(coalesce(t.oldest, compute_now()), compute_now() - interval '12 months') AT TIME ZONE 'UTC'),
         date_trunc('month', compute_now() AT TIME ZONE 'UTC') + interval '1 month',
         interval '1 month') AS m;

INSERT INTO audit_events (id, tenant_id, occurred_at, action, resource_type, resource_id, admission, details, txid, seq)
  SELECT id, tenant_id, occurred_at, action, resource_type, resource_id, admission, details, txid, seq FROM audit_events_v1;
INSERT INTO inventory_snapshots (id, node_id, sha256, section_hashes, sections, boot_id, collected_at)
  SELECT id, node_id, sha256, section_hashes, sections, boot_id, collected_at FROM inventory_snapshots_v1;
INSERT INTO usage_windows (idempotency_key, allocation_id, tenant_id, identity_id, meter, quantity, window_start,
                           window_end, tags, recorded_at, outcome)
  SELECT idempotency_key, allocation_id, tenant_id, identity_id, meter, quantity, window_start,
         window_end, tags, recorded_at, outcome FROM usage_windows_v1;
DROP TABLE audit_events_v1, inventory_snapshots_v1, usage_windows_v1;
`,
};

/** The history tables `core/0018_partitioned_history` partitions, with their partition column. */
export const historyTables = Object.freeze([
  { table: 'audit_events', column: 'occurred_at' },
  { table: 'inventory_snapshots', column: 'collected_at' },
  { table: 'usage_windows', column: 'window_start' },
] as const);
