import {
  ComputeError,
  type Finding,
  type ModuleContext,
  type SqlExecutor,
} from '@better-compute/core';
import { instanceWork } from './instances.js';
import type { RuntimeTraits } from './runtime.js';

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
 * `selfCheck` (doctor) for hosted VPS: pools whose runtime this deployment does not run, container
 * pools not marked single-tenant, pools without an IP range, and adopted hosts without capacity rows
 * (no inventory yet, or `vps.hosts` not running).
 */
export async function vpsSelfCheck(
  sql: SqlExecutor,
  runtimes: ReadonlyMap<string, RuntimeTraits>,
  defaultRuntime: string,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const { rows: pools } = await sql.query<{
    id: string;
    runtime: string | null;
    single_tenant: boolean;
    has_range: boolean;
  }>(
    `SELECT p.id, p.policy->>'runtime' AS runtime,
            COALESCE(p.policy->>'singleTenant', 'false') = 'true' AS single_tenant,
            EXISTS (SELECT 1 FROM ip_pools i WHERE i.pool_id = p.id) AS has_range
       FROM pools p WHERE p.class = 'vps-host' AND p.archived_at IS NULL ORDER BY p.id`,
  );
  const unknown = pools.filter((pool) => !runtimes.has(pool.runtime ?? defaultRuntime));
  if (unknown.length)
    findings.push({
      check: 'vps.pools.runtime',
      severity: 'error',
      message: `${unknown.length} vps-host pool(s) run a runtime this deployment does not list: ${unknown
        .slice(0, 5)
        .map((pool) => `${pool.id} (${pool.runtime})`)
        .join(', ')}`,
      fix: 'Add the runtime to vps({ runtimes }) (with vps({ runtimeTraits }) for bcx runtimes) or change policy.runtime',
      count: unknown.length,
    });
  const shared = pools.filter((pool) => {
    const traits = runtimes.get(pool.runtime ?? defaultRuntime);
    return traits && !traits.multiTenant && !pool.single_tenant;
  });
  if (shared.length)
    findings.push({
      check: 'vps.pools.single-tenant',
      severity: 'error',
      message: `${shared.length} container pool(s) are not marked single-tenant and cannot run instances`,
      fix: 'Set policy.singleTenant: true on pools that run a container runtime (§13)',
      count: shared.length,
    });
  const rangeless = pools.filter((pool) => !pool.has_range);
  if (rangeless.length)
    findings.push({
      check: 'vps.pools.ipam',
      severity: 'warning',
      message: `${rangeless.length} vps-host pool(s) have no IP range: their instances get no address`,
      fix: 'Give each vps-host pool a range with setIpPool({ poolId, cidr, gateway })',
      count: rangeless.length,
    });
  const { rows } = await sql.query<{ count: string | number }>(
    `SELECT count(*) AS count FROM nodes n JOIN pools p ON p.id = n.pool_id AND p.class = 'vps-host'
      WHERE n.provision_state IN ('adopted', 'deployed') AND n.trust <> 'tenant-controlled'
        AND n.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM node_resources r WHERE r.node_id = n.id AND r.resource = 'vcpu')`,
  );
  const hostless = Number(rows[0]?.count ?? 0);
  if (hostless > 0)
    findings.push({
      check: 'vps.hosts.capacity',
      severity: 'warning',
      message: `${hostless} adopted VPS host(s) have no vCPU/memory/disk capacity yet`,
      fix: 'Check that the hosts reported inventory and that a worker runs the vps.hosts reconciler',
      count: hostless,
    });
  return findings;
}

/**
 * Wakes the Instance reconciler for instances on hosts Liveness declared `lost`, which no report
 * will ever mention again: they turn `lost` (and are recreated where the pool's
 * `recreateOnHostLoss` says so), and deletions there finish. Returns how many were woken.
 */
export async function wakeInstancesOnLostHosts(
  sql: SqlExecutor,
  work: ModuleContext['work'],
): Promise<number> {
  const { rows } = await sql.query<{ id: string }>(
    `SELECT i.id FROM instances i JOIN nodes n ON n.id = i.node_id
      WHERE n.connectivity = 'lost' AND NOT i.draft AND i.state NOT IN ('lost', 'deleted', 'error')
      ORDER BY i.id LIMIT 1000`,
  );
  if (rows.length === 0) return 0;
  await sql.transaction(async (tx) => {
    for (const row of rows) await work.enqueue(tx, instanceWork, row.id);
  });
  return rows.length;
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
