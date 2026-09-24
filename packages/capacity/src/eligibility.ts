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

/** Why a node is not schedulable, or `undefined` when it is. Checks run in bucket order. */
export function ineligibility(
  node: EligibilityNode,
  pool: EligibilityPool,
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
  if (node.noScheduleReasons.length > 0)
    return { bucket: 'unhealthy', reason: `NoSchedule: ${node.noScheduleReasons.join(', ')}` };
  return undefined;
}

/** Schedulable ⇔ every §10.2 condition holds. */
export function isSchedulable(node: EligibilityNode, pool: EligibilityPool): boolean {
  return ineligibility(node, pool) === undefined;
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
