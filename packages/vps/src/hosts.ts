import { ComputeError, type SqlExecutor } from '@better-compute/core';

// Host capacity (PLAN.md §10.2): a VPS host's scalar resources come from its inventory.
//   allocatable = capacity − systemReserved, per resource; available = allocatable × ratio − allocated
// `vcpu` is the logical CPU count (`cpu.threads`), `memoryGiB` the installed memory, `diskGiB` the
// non-removable disks; `ratio` is the pool's `policy.overcommit[resource]` (default 1, clamped to
// 0.1…100). Nodes of `vps-host` pools only, from their applied snapshot; a `tenant-controlled` node's
// inventory is advisory and never adds capacity (§10.1). Rows are written only when they change.

/** The work kind (periodic key `all`) that keeps `node_resources` in step with host inventory. */
export const hostResourcesWork = 'vps.hosts';

/** What a host keeps for itself: hypervisor, daemon, page cache, the OS disk (§10.2 systemReserved). */
export interface HostReserve {
  vcpu: number;
  memoryGiB: number;
  diskGiB: number;
}

/** Default reserve per host. */
export const defaultHostReserve: Readonly<HostReserve> = Object.freeze({
  vcpu: 2,
  memoryGiB: 8,
  diskGiB: 100,
});

export const hostResourceNames = ['diskGiB', 'memoryGiB', 'vcpu'] as const;

/** A scalar row a host should have and how it differs from the stored one. */
export interface HostResourceRow {
  nodeId: string;
  resource: (typeof hostResourceNames)[number];
  allocatable: number;
  ratio: number;
}

const ratio = (
  resource: string,
) => `CASE WHEN jsonb_typeof(h.policy->'overcommit'->'${resource}') = 'number'
      THEN LEAST(100, GREATEST(0.1, (h.policy->'overcommit'->>'${resource}')::numeric)) ELSE 1 END`;

/**
 * The rows that differ from what the hosts' inventory implies (all hosts, or one). An allocatable
 * below what is already allocated is kept at `ceil(allocated / ratio)`, so a shrinking host never
 * breaks the `node_resources` CHECK; such a row does not count as different.
 */
const changedRows = `
WITH h AS (
  SELECT n.id AS node_id, s.sections, p.policy
    FROM nodes n
    JOIN pools p ON p.id = n.pool_id AND p.class = 'vps-host'
    JOIN node_inventory ni ON ni.node_id = n.id
    JOIN inventory_snapshots s ON s.id = ni.applied_snapshot_id
   WHERE n.trust <> 'tenant-controlled' AND n.deleted_at IS NULL
     AND ($1::text IS NULL OR n.id = $1)
), wanted AS (
  SELECT h.node_id, 'vcpu' AS resource,
         GREATEST(0, COALESCE((h.sections->'cpu'->>'threads')::bigint, 0) - $2::bigint) AS allocatable,
         ${ratio('vcpu')} AS ratio
    FROM h
  UNION ALL
  SELECT h.node_id, 'memoryGiB',
         GREATEST(0, floor(COALESCE((h.sections->'memory'->>'totalBytes')::numeric, 0) / 1073741824)::bigint - $3::bigint),
         ${ratio('memoryGiB')}
    FROM h
  UNION ALL
  SELECT h.node_id, 'diskGiB',
         GREATEST(0, floor(COALESCE((
           SELECT sum((d->>'sizeBytes')::numeric)
             FROM jsonb_array_elements(COALESCE(h.sections->'disks'->'disks', '[]'::jsonb)) d
            WHERE COALESCE((d->>'removable')::boolean, false) = false), 0) / 1073741824)::bigint - $4::bigint),
         ${ratio('diskGiB')}
    FROM h
)
SELECT w.node_id, w.resource, w.allocatable::text AS allocatable, w.ratio::text AS ratio
  FROM wanted w
  LEFT JOIN node_resources r ON r.node_id = w.node_id AND r.resource = w.resource
 WHERE r.node_id IS NULL OR r.ratio <> w.ratio
    OR r.allocatable <> GREATEST(w.allocatable, ceil(r.allocated / w.ratio)::bigint)
 ORDER BY w.node_id, w.resource`;

const upsert = `INSERT INTO node_resources (node_id, resource, allocatable, ratio, allocated)
  VALUES ($1, $2, $3, $4, 0)
  ON CONFLICT (node_id, resource) DO UPDATE
    SET allocatable = GREATEST(EXCLUDED.allocatable, ceil(node_resources.allocated / EXCLUDED.ratio)::bigint),
        ratio = EXCLUDED.ratio`;

function checkReserve(reserve: HostReserve): HostReserve {
  for (const resource of hostResourceNames) {
    const value = reserve[resource];
    if (!Number.isSafeInteger(value) || value < 0)
      throw new ComputeError(
        'INVALID_CONFIG',
        `vps({ hostReserve }).${resource} must be a whole number ≥ 0`,
      );
  }
  return reserve;
}

/** Validates a partial reserve over the defaults. */
export function hostReserve(partial: Partial<HostReserve> = {}): HostReserve {
  return checkReserve({ ...defaultHostReserve, ...partial });
}

/** The `node_resources` rows the hosts' inventory implies that are missing or stale. */
export async function staleHostResources(
  sql: SqlExecutor,
  options: { nodeId?: string; reserve?: HostReserve } = {},
): Promise<HostResourceRow[]> {
  const reserve = options.reserve ?? defaultHostReserve;
  const { rows } = await sql.query<{
    node_id: string;
    resource: HostResourceRow['resource'];
    allocatable: string;
    ratio: string;
  }>(changedRows, [options.nodeId ?? null, reserve.vcpu, reserve.memoryGiB, reserve.diskGiB]);
  return rows.map((row) => ({
    nodeId: row.node_id,
    resource: row.resource,
    allocatable: Number(row.allocatable),
    ratio: Number(row.ratio),
  }));
}

/**
 * Brings `node_resources` in step with host inventory; returns the rows written. Each host is one
 * transaction that locks its node row first (capacity's lock order: nodes → node_resources), so it
 * serializes with the placer's `FOR SHARE` instead of deadlocking with it.
 */
export async function syncHostResources(
  sql: SqlExecutor,
  options: { nodeId?: string; reserve?: HostReserve } = {},
): Promise<number> {
  const stale = await staleHostResources(sql, options);
  const byNode = new Map<string, HostResourceRow[]>();
  for (const row of stale) byNode.set(row.nodeId, [...(byNode.get(row.nodeId) ?? []), row]);
  let written = 0;
  for (const [nodeId, rows] of byNode)
    written += await sql.transaction(async (tx) => {
      const node = await tx.query(`SELECT 1 FROM nodes WHERE id = $1 FOR NO KEY UPDATE`, [nodeId]);
      if (node.rows.length === 0) return 0;
      for (const row of rows)
        await tx.query(upsert, [nodeId, row.resource, row.allocatable, row.ratio]);
      return rows.length;
    });
  return written;
}
