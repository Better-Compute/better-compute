import type { KubernetesNodePoolSpec, ProviderResourceState } from '@better-compute/core';
import { tagFor } from '../ids.js';
import { checkName, fail, invalid, resourceState } from './common.js';
import type { DoksNodePool } from './types.js';

// DOKS node pools: the spec checks, the create body, the state its nodes add up to, and what may
// change in place (the size and the autoscaling bounds).

const sizePattern = /^[a-z0-9][a-z0-9._-]{0,62}$/;
/** DOKS caps a node pool well below this; it only keeps a typo from reaching the API. */
const maxNodes = 512;
const taintEffects = ['NoSchedule', 'PreferNoSchedule', 'NoExecute'] as const;

/**
 * The tag a node pool asked for as Spot carries from its create on. DigitalOcean may not honour
 * the (preview) `spot` field; when the create's answer was lost, or another creator got there
 * first, the pool is only checked later, and this tag tells a pool made on-demand for Spot (to be
 * deleted) from an on-demand pool a spec later asks to be Spot (immutable, never deleted). Tenant
 * labels cannot forge it: vps reserves the `better-compute-` keys.
 */
export const spotRequestedTag = tagFor('better-compute-spot', 'true');

/** Whether the pool was asked for as Spot (it carries the tag) and DigitalOcean made it on-demand. */
export function spotUnhonoured(pool: DoksNodePool): boolean {
  return (
    pool.spot !== true && (pool.tags ?? []).some((tag) => tag.toLowerCase() === spotRequestedTag)
  );
}

const isCount = (value: unknown, min: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= maxNodes;

/** Validates a node pool spec as far as DOKS can take it (GPU and Spot sizes are checked on create). */
export function checkNodePoolSpec(spec: KubernetesNodePoolSpec): void {
  checkName(spec.name, 'The node pool name');
  if (typeof spec.machineType !== 'string' || !sizePattern.test(spec.machineType))
    throw invalid(`${JSON.stringify(spec.machineType)} is not a DigitalOcean size slug`, 'size');
  if (spec.autoscaling) {
    const { minNodes, maxNodes: max } = spec.autoscaling;
    if (!isCount(minNodes, 0) || !isCount(max, 1) || minNodes > max)
      throw invalid(
        `autoscaling needs whole numbers 0 <= minNodes <= maxNodes <= ${maxNodes}, maxNodes at least 1`,
        'autoscaling',
      );
    if (!isCount(spec.nodeCount, 0))
      throw invalid(`nodeCount must be a whole number from 0 to ${maxNodes}`, 'nodeCount');
  } else if (!isCount(spec.nodeCount, 1))
    throw invalid(
      `nodeCount must be a whole number from 1 to ${maxNodes} (a DOKS node pool without autoscaling has at least one node)`,
      'nodeCount',
    );
  if (spec.diskGiB !== undefined || spec.diskType !== undefined)
    throw fail(
      'UNSUPPORTED',
      'DOKS nodes take the disk of their size: diskGiB and diskType cannot be set',
      'disk',
    );
  if (spec.zones !== undefined && spec.zones.length > 0)
    throw fail('UNSUPPORTED', 'DOKS node pools are regional: zones cannot be chosen', 'zones');
  if (spec.accelerators) {
    const { type, count } = spec.accelerators;
    if (typeof type !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,62}$/i.test(type))
      throw invalid(`${JSON.stringify(type)} is not an accelerator type`, 'accelerators');
    if (!Number.isInteger(count) || count < 1 || count > 16)
      throw invalid('accelerators.count must be a whole number from 1 to 16', 'accelerators');
  }
  for (const taint of spec.taints ?? []) {
    if (!(taintEffects as readonly string[]).includes(taint.effect))
      throw invalid(
        `The taint effect ${JSON.stringify(taint.effect)} is not NoSchedule, PreferNoSchedule or NoExecute`,
        'taint',
      );
    if (typeof taint.key !== 'string' || !taint.key) throw invalid('A taint needs a key', 'taint');
  }
}

/** The node count a create asks for: with autoscaling, `nodeCount` within the bounds. */
function initialCount(spec: KubernetesNodePoolSpec): number {
  if (!spec.autoscaling) return spec.nodeCount;
  return Math.min(Math.max(spec.nodeCount, spec.autoscaling.minNodes), spec.autoscaling.maxNodes);
}

/** A node pool of `POST /kubernetes/clusters` (`node_pools`) or of `POST …/node_pools`. */
export function nodePoolBody(
  spec: KubernetesNodePoolSpec,
  tags: readonly string[],
): Record<string, unknown> {
  return {
    name: spec.name,
    size: spec.machineType,
    count: initialCount(spec),
    tags: spec.spot ? [...tags, spotRequestedTag] : [...tags],
    ...(spec.labels ? { labels: { ...spec.labels } } : {}),
    ...(spec.taints?.length
      ? {
          taints: spec.taints.map((taint) => ({
            key: taint.key,
            ...(taint.value !== undefined ? { value: taint.value } : {}),
            effect: taint.effect,
          })),
        }
      : {}),
    ...(spec.autoscaling
      ? {
          auto_scale: true,
          min_nodes: spec.autoscaling.minNodes,
          max_nodes: spec.autoscaling.maxNodes,
        }
      : { auto_scale: false }),
    // Spot capacity (a DO preview): the field is not in DO's published spec yet, unverified.
    ...(spec.spot ? { spot: true } : {}),
  };
}

/**
 * A node pool's state, by its nodes: `ready` once every node runs and there are as many as the
 * pool's count (the autoscaler's, with autoscaling), `pending` while none runs yet, `updating`
 * while nodes come or go.
 */
export function nodePoolState(id: string, pool: DoksNodePool): ProviderResourceState {
  const nodes = pool.nodes ?? [];
  const running = nodes.filter((node) => node.status?.state === 'running').length;
  const settled = running === nodes.length && nodes.length === pool.count;
  const outputs: Record<string, string> = { nodes: String(running) };
  if (settled) return resourceState(id, 'ready', { outputs });
  if (running === 0 && nodes.every((node) => node.status?.state === 'provisioning'))
    return resourceState(id, 'pending', { outputs });
  return resourceState(id, 'updating', { outputs });
}

function immutable(id: string, what: string, actual: unknown, desired: unknown) {
  return fail(
    'INVALID_STATE',
    `Node pool ${id} exists with ${what} ${JSON.stringify(actual)}, not ${JSON.stringify(desired)}; ` +
      'only nodeCount and autoscaling change in place (create a new node pool)',
    'immutable',
    { field: what },
  );
}

const sortedEntries = (record: Readonly<Record<string, string>> | null | undefined): string =>
  JSON.stringify(Object.entries(record ?? {}).sort(([a], [b]) => a.localeCompare(b)));

const taintsKey = (taints: readonly { key: string; value?: string; effect: string }[]): string =>
  JSON.stringify(
    taints
      .map((taint) => [taint.key, taint.value ?? '', taint.effect])
      .sort((a, b) => a.join('\u0000').localeCompare(b.join('\u0000'))),
  );

/** Refuses a difference that cannot change in place: the size, Spot, the labels and the taints. */
export function checkNodePoolImmutable(
  id: string,
  spec: KubernetesNodePoolSpec,
  pool: DoksNodePool,
): void {
  if (pool.size !== spec.machineType)
    throw immutable(id, 'machineType', pool.size, spec.machineType);
  if ((pool.spot === true) !== (spec.spot === true))
    throw immutable(id, 'spot', pool.spot === true, spec.spot === true);
  if (sortedEntries(pool.labels) !== sortedEntries(spec.labels))
    throw immutable(id, 'labels', pool.labels ?? {}, spec.labels ?? {});
  if (taintsKey(pool.taints ?? []) !== taintsKey(spec.taints ?? []))
    throw immutable(id, 'taints', pool.taints ?? [], spec.taints ?? []);
}

/** The pool's own tags, without the ones DOKS adds (`k8s`, `k8s-worker`, `k8s:<uuid>`). */
export function ownPoolTags(pool: DoksNodePool): string[] {
  return (pool.tags ?? []).filter(
    (tag) => tag !== 'k8s' && tag !== 'k8s-worker' && !tag.startsWith('k8s:'),
  );
}

/**
 * The `PUT …/node_pools/{id}` a pool needs, or undefined when it is as wanted. Only the size and
 * the autoscaling bounds change; with autoscaling the autoscaler owns the count (it is only kept
 * within the bounds). The PUT carries the pool's name, tags, labels and taints as they are, so a
 * field it leaves out is never cleared.
 */
export function nodePoolUpdate(
  spec: KubernetesNodePoolSpec,
  pool: DoksNodePool,
): Record<string, unknown> | undefined {
  const scaling = spec.autoscaling;
  const autoscaled = pool.auto_scale === true;
  const boundsDiffer =
    autoscaled !== (scaling !== undefined) ||
    (scaling !== undefined &&
      (pool.min_nodes !== scaling.minNodes || pool.max_nodes !== scaling.maxNodes));
  const count = scaling
    ? Math.min(Math.max(pool.count, scaling.minNodes), scaling.maxNodes)
    : spec.nodeCount;
  if (!boundsDiffer && count === pool.count) return undefined;
  return {
    name: pool.name,
    count,
    tags: ownPoolTags(pool),
    labels: { ...(pool.labels ?? {}) },
    taints: [...(pool.taints ?? [])],
    ...(scaling
      ? { auto_scale: true, min_nodes: scaling.minNodes, max_nodes: scaling.maxNodes }
      : { auto_scale: false }),
  };
}
