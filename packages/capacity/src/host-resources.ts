import type { SqlExecutor } from '@better-compute/core';

// Host resources on every host (PLAN.md §3.8, v1.1): a host's CPU, memory and hugepages are bookable
// with its GPUs, not only a VPS host's flavors. From each host's applied inventory:
//   vcpu       = logical CPUs − policy.hostReserve.vcpu (default 2), × policy.overcommit.vcpu
//   memoryGiB  = installed memory − the hugepage pools − policy.hostReserve.memoryGiB (default 8)
//   hugepages2Mi / hugepages1Gi = the pages in each pool (never overcommitted)
// vps keeps writing vcpu/memoryGiB/diskGiB for `vps-host` pools with its own reserve (vps.hosts);
// hugepage rows are written here for every host. A `tenant-controlled` node's inventory is advisory
// and never adds capacity (§10.1). Rows are written only when they change.

/** The work kind (periodic key `all`) that keeps these rows in step with inventory. */
export const nodeResourcesWork = 'capacity.hosts';

export const defaultNodeReserve = Object.freeze({ vcpu: 2, memoryGiB: 8 });

export type NodeResourceName = 'vcpu' | 'memoryGiB' | 'hugepages2Mi' | 'hugepages1Gi';

export interface NodeResourceRow {
  nodeId: string;
  resource: NodeResourceName;
  allocatable: number;
  ratio: number;
}

/** A whole number from the pool policy at `path`, else `fallback`. */
const policyNumber = (path: string, fallback: number) =>
  `CASE WHEN jsonb_typeof(h.policy #> '{${path}}') = 'number'
        THEN GREATEST(0, floor((h.policy #>> '{${path}}')::numeric))::bigint ELSE ${fallback} END`;

const ratio = (resource: string) => `CASE WHEN jsonb_typeof(h.policy->'overcommit'->'${resource}') = 'number'
      THEN LEAST(100, GREATEST(0.1, (h.policy->'overcommit'->>'${resource}')::numeric)) ELSE 1 END`;

const changedRows = `
WITH h AS (
  SELECT n.id AS node_id, s.sections, p.policy, p.class
    FROM nodes n
    JOIN pools p ON p.id = n.pool_id
    JOIN node_inventory ni ON ni.node_id = n.id
    JOIN inventory_snapshots s ON s.id = ni.applied_snapshot_id
   WHERE n.trust <> 'tenant-controlled' AND n.deleted_at IS NULL
     AND ($1::text IS NULL OR n.id = $1)
), pools_hp AS (
  SELECT h.node_id,
         COALESCE((e->>'pageSizeBytes')::numeric, 0) AS size,
         COALESCE((e->>'total')::numeric, 0) AS total
    FROM h, jsonb_array_elements(
      CASE WHEN jsonb_typeof(h.sections->'memory'->'hugepages') = 'array'
           THEN h.sections->'memory'->'hugepages' ELSE '[]'::jsonb END) e
), hp AS (
  SELECT h.node_id,
         COALESCE(sum(ph.size * ph.total), 0) AS bytes,
         COALESCE(sum(ph.total) FILTER (WHERE ph.size = 2097152), 0) AS pages_2mi,
         COALESCE(sum(ph.total) FILTER (WHERE ph.size = 1073741824), 0) AS pages_1gi
    FROM h LEFT JOIN pools_hp ph ON ph.node_id = h.node_id
   GROUP BY h.node_id
), wanted AS (
  SELECT h.node_id, 'vcpu' AS resource,
         GREATEST(0, COALESCE((h.sections->'cpu'->>'threads')::bigint, 0)
                     - ${policyNumber('hostReserve,vcpu', defaultNodeReserve.vcpu)}) AS allocatable,
         ${ratio('vcpu')} AS ratio
    FROM h WHERE h.class <> 'vps-host'
  UNION ALL
  SELECT h.node_id, 'memoryGiB',
         GREATEST(0, floor((COALESCE((h.sections->'memory'->>'totalBytes')::numeric, 0) - hp.bytes)
                           / 1073741824)::bigint
                     - ${policyNumber('hostReserve,memoryGiB', defaultNodeReserve.memoryGiB)}),
         ${ratio('memoryGiB')}
    FROM h JOIN hp ON hp.node_id = h.node_id WHERE h.class <> 'vps-host'
  UNION ALL
  SELECT h.node_id, 'hugepages2Mi', floor(hp.pages_2mi)::bigint, 1
    FROM h JOIN hp ON hp.node_id = h.node_id WHERE hp.pages_2mi > 0
  UNION ALL
  SELECT h.node_id, 'hugepages1Gi', floor(hp.pages_1gi)::bigint, 1
    FROM h JOIN hp ON hp.node_id = h.node_id WHERE hp.pages_1gi > 0
)
SELECT w.node_id, w.resource, w.allocatable::text AS allocatable, w.ratio::text AS ratio
  FROM wanted w
  LEFT JOIN node_resources r ON r.node_id = w.node_id AND r.resource = w.resource
 WHERE r.node_id IS NULL OR r.ratio <> w.ratio
    OR r.allocatable <> GREATEST(w.allocatable, ceil(r.allocated / w.ratio)::bigint)
 ORDER BY w.node_id, w.resource`;

// An allocatable below what is already allocated is kept at ceil(allocated / ratio), so a shrinking
// host never breaks the node_resources CHECK.
const upsert = `INSERT INTO node_resources (node_id, resource, allocatable, ratio, allocated)
  VALUES ($1, $2, $3, $4, 0)
  ON CONFLICT (node_id, resource) DO UPDATE
    SET allocatable = GREATEST(EXCLUDED.allocatable, ceil(node_resources.allocated / EXCLUDED.ratio)::bigint),
        ratio = EXCLUDED.ratio`;

/** The rows the hosts' inventory implies that are missing or stale (all hosts, or one). */
export async function staleNodeResources(
  sql: Pick<SqlExecutor, 'query'>,
  options: { nodeId?: string } = {},
): Promise<NodeResourceRow[]> {
  const { rows } = await sql.query<{
    node_id: string;
    resource: NodeResourceName;
    allocatable: string;
    ratio: string;
  }>(changedRows, [options.nodeId ?? null]);
  return rows.map((row) => ({
    nodeId: row.node_id,
    resource: row.resource,
    allocatable: Number(row.allocatable),
    ratio: Number(row.ratio),
  }));
}

/**
 * Brings the rows in step; returns how many were written. One transaction per host, locking its
 * node row first (capacity's lock order: nodes → node_resources).
 */
export async function syncNodeResources(
  sql: SqlExecutor,
  options: { nodeId?: string } = {},
): Promise<number> {
  const stale = await staleNodeResources(sql, options);
  const byNode = new Map<string, NodeResourceRow[]>();
  for (const row of stale) byNode.set(row.nodeId, [...(byNode.get(row.nodeId) ?? []), row]);
  let written = 0;
  for (const [nodeId, rows] of byNode)
    written += await sql.transaction(async (tx) => {
      const node = await tx.query('SELECT 1 FROM nodes WHERE id = $1 FOR NO KEY UPDATE', [nodeId]);
      if (node.rows.length === 0) return 0;
      for (const row of rows) await tx.query(upsert, [nodeId, row.resource, row.allocatable, row.ratio]);
      return rows.length;
    });
  return written;
}
