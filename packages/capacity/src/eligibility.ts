import type { Connectivity, NodeRole, NodeTrust, ProvisionState } from '@better-compute/core';

/** The node columns schedulability depends on (PLAN.md §10.2). */
export interface EligibilityNode {
  role: NodeRole;
  provisionState: ProvisionState;
  maintenance: boolean;
  cordoned: boolean;
  connectivity: Connectivity;
  noScheduleReasons: readonly string[];
  trust: NodeTrust;
  ownerTenantId: string;
  /**
   * The spec generation the node last converged (§3.3 step 7: schedulable from 1 on). Views that do
   * not carry it (hand-built `NodeView`s) are not held back by it.
   */
  observedGeneration?: number;
}

/** The pool columns schedulability depends on. */
export interface EligibilityPool {
  ownerTenantId: string;
}

/**
 * Where a node's capacity is reported. `schedulable` counts as allocatable; the next four are the
 * §10.2 buckets; `excluded` is capacity that never counts toward this pool (not a host, a
 * tenant-controlled node, or a tenant-owned node in another tenant's pool).
 */
export type CapacityBucket =
  | 'schedulable'
  | 'provisioning'
  | 'unhealthy'
  | 'maintenance'
  | 'unreachable'
  | 'excluded';

export const capacityBuckets: readonly CapacityBucket[] = [
  'schedulable',
  'provisioning',
  'unhealthy',
  'maintenance',
  'unreachable',
  'excluded',
];

/** Provision states whose capacity can be booked. */
export const schedulableProvisionStates: readonly ProvisionState[] = ['adopted', 'deployed'];

/**
 * The operator taint that dedicates a node to one tenant (§10.6 `dedicated=<tenant>`, set with
 * `nodes.taint`): stored in `no_schedule_reasons` as `taint:dedicated=<tenantId>`, it keeps every
 * other tenant's work off the node and is tolerated by that tenant's.
 */
export const dedicatedTaintPrefix = 'taint:dedicated=';

/** The `no_schedule_reasons` entry that dedicates a node to `tenantId`. */
export function dedicatedTaint(tenantId: string): string {
  return `${dedicatedTaintPrefix}${tenantId}`;
}

/**
 * The NoSchedule reasons that keep `tenantId`'s work off a node: all of them, except a
 * `dedicated=<tenantId>` taint. Without a tenant (rollups, generic checks) every reason counts.
 */
export function blockingReasons(reasons: readonly string[], tenantId?: string): readonly string[] {
  if (tenantId === undefined || reasons.length === 0) return reasons;
  const tolerated = dedicatedTaint(tenantId);
  return reasons.filter((reason) => reason !== tolerated);
}

/**
 * The tenant a node is dedicated to when its only NoSchedule reasons are `dedicated=<tenant>` taints
 * for that one tenant; `undefined` otherwise (no reasons, other reasons, or several tenants).
 */
export function dedicatedTenant(
  node: Pick<EligibilityNode, 'noScheduleReasons'>,
): string | undefined {
  let tenant: string | undefined;
  for (const reason of node.noScheduleReasons) {
    if (!reason.startsWith(dedicatedTaintPrefix)) return undefined;
    const named = reason.slice(dedicatedTaintPrefix.length);
    if (tenant !== undefined && tenant !== named) return undefined;
    tenant = named;
  }
  return tenant;
}

/**
 * Whether any tenant could place on the node: schedulable, or blocked by nothing but a dedication.
 * Loaders read devices and bookings for these; the pipeline then decides per request tenant.
 */
export function mayBeSchedulable(node: EligibilityNode, pool: EligibilityPool): boolean {
  return isSchedulable(node, pool, dedicatedTenant(node));
}

/**
 * Why a node is not schedulable, or `undefined` when it is. Checks run in bucket order. With
 * `tenantId` (placement), a `dedicated=<tenantId>` taint does not count against the node.
 */
export function ineligibility(
  node: EligibilityNode,
  pool: EligibilityPool,
  tenantId?: string,
): { bucket: Exclude<CapacityBucket, 'schedulable'>; reason: string } | undefined {
  if (node.role !== 'host') return { bucket: 'excluded', reason: `role ${node.role}` };
  if (node.trust === 'tenant-controlled')
    return { bucket: 'excluded', reason: 'tenant-controlled nodes add no capacity' };
  if (node.trust === 'tenant-owned' && node.ownerTenantId !== pool.ownerTenantId)
    return { bucket: 'excluded', reason: "tenant-owned node outside its owner's pool" };
  if (node.maintenance) return { bucket: 'maintenance', reason: 'in maintenance' };
  if (node.cordoned) return { bucket: 'maintenance', reason: 'cordoned' };
  if (!schedulableProvisionStates.includes(node.provisionState))
    return { bucket: 'provisioning', reason: `provision state ${node.provisionState}` };
  if (node.observedGeneration !== undefined && node.observedGeneration < 1)
    return { bucket: 'provisioning', reason: 'awaiting its first converged spec' };
  if (node.connectivity !== 'connected')
    return { bucket: 'unreachable', reason: `connectivity ${node.connectivity}` };
  const blocking = blockingReasons(node.noScheduleReasons, tenantId);
  if (blocking.length > 0)
    return { bucket: 'unhealthy', reason: `NoSchedule: ${blocking.join(', ')}` };
  return undefined;
}

/** Schedulable ⇔ every §10.2 condition holds (for `tenantId`'s work, when given). */
export function isSchedulable(
  node: EligibilityNode,
  pool: EligibilityPool,
  tenantId?: string,
): boolean {
  return ineligibility(node, pool, tenantId) === undefined;
}

/** The bucket a node's capacity is reported in. */
export function nodeBucket(node: EligibilityNode, pool: EligibilityPool): CapacityBucket {
  return ineligibility(node, pool)?.bucket ?? 'schedulable';
}

/**
 * The SQL twin of `isSchedulable` over `nodes n JOIN pools p`, for placers that lock candidates
 * (`FOR SHARE OF n`). Kept next to the TypeScript predicate so the two cannot drift apart unseen;
 * `tests/capacity-eligibility.test.ts` checks them against each other.
 */
export const schedulableSql = `n.role = 'host' AND NOT n.maintenance AND NOT n.cordoned
   AND n.connectivity = 'connected' AND n.provision_state IN ('adopted', 'deployed')
   AND n.observed_generation >= 1
   AND cardinality(n.no_schedule_reasons) = 0
   AND (n.trust = 'platform' OR (n.trust = 'tenant-owned' AND p.owner_tenant_id = n.owner_tenant_id))`;

/**
 * `schedulableSql` for placement, tolerating the reasons in `tolerated` (an SQL `text[]`
 * expression, e.g. `$3::text[]` bound to `[dedicatedTaint(tenantId)]`): the node's
 * `no_schedule_reasons` must all be among them.
 */
export function schedulableSqlTolerating(tolerated: string): string {
  return schedulableSql.replace(
    'cardinality(n.no_schedule_reasons) = 0',
    `n.no_schedule_reasons <@ ${tolerated}`,
  );
}

/**
 * The SQL twin of `mayBeSchedulable`: schedulable for some tenant (blocked by nothing but
 * dedications). For edges that wake pending work, so a node dedicated to a tenant wakes that
 * tenant's reservations too.
 */
export const mayBeSchedulableSql = schedulableSql.replace(
  'cardinality(n.no_schedule_reasons) = 0',
  // No reason, or every reason is one and the same dedication (two tenants' block everyone).
  `(cardinality(n.no_schedule_reasons) = 0
     OR (n.no_schedule_reasons <@ ARRAY[n.no_schedule_reasons[1]]
         AND n.no_schedule_reasons[1] LIKE '${dedicatedTaintPrefix}%'))`,
);
