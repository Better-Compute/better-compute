import { createHash } from 'node:crypto';
import { clip } from '@better-compute/capacity';
import type { CreateClusterInput, NodePoolInput } from './types.js';

// What a person asked to confirm an agent's `kubernetesClusters.create` reads (§3.4 step 7,
// `MethodAdmission.describe`). The envelope (and a composite such as fleet.apply) binds an approval
// to this text (review 14 M1), and the cluster's decided resource id does not depend on its spec, so
// the text carries everything that changes what is created and what it costs: where, which mode,
// which node pools with which machines, counts, autoscaling and accelerators. Caller text is clipped;
// the digest of the whole request (but its idempotency key) makes any clipped difference count too.

/** A JSON text with object keys sorted: the same request always digests the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null)
    return `{${Object.keys(value)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/** One node pool: name, machine type and count, then what else changes its cost. */
function describeNodePool(pool: NodePoolInput): string {
  const parts = [`${clip(pool.name)} ${clip(pool.machineType)} x${pool.nodeCount}`];
  if (pool.autoscaling)
    parts.push(`autoscaling ${pool.autoscaling.minNodes}..${pool.autoscaling.maxNodes}`);
  if (pool.accelerators)
    parts.push(`${pool.accelerators.count}x ${clip(pool.accelerators.type)} per node`);
  if (pool.spot) parts.push('spot');
  if (pool.diskGiB !== undefined || pool.diskType !== undefined)
    parts.push(
      `disk ${pool.diskGiB !== undefined ? `${pool.diskGiB} GiB` : 'default size'}${
        pool.diskType !== undefined ? ` ${clip(pool.diskType)}` : ''
      }`,
    );
  if (pool.zones?.length) parts.push(`zones ${pool.zones.map((zone) => clip(zone)).join(',')}`);
  return parts.join(' ');
}

/** `kubernetesClusters.create`: the cluster's place and mode, its node pools, and a request digest. */
export function describeCreateCluster(input: CreateClusterInput): string {
  const parts = [
    `${clip(input.name)} on pool ${clip(input.poolId)}`,
    `${input.mode} in ${clip(input.location)}`,
    `release channel ${input.releaseChannel}${input.version !== undefined ? ` version ${clip(input.version)}` : ''}`,
    input.privateNodes ? 'private nodes' : 'public nodes',
    input.authorizedNetworks.length
      ? `API reachable from ${input.authorizedNetworks.length} authorized network(s)`
      : 'no authorized networks',
  ];
  if (input.networkId !== undefined) parts.push(`network ${clip(input.networkId, 128)}`);
  if (input.projectId !== undefined) parts.push(`project ${clip(input.projectId)}`);
  parts.push(
    input.nodePools.length
      ? `node pools: ${input.nodePools.map(describeNodePool).join(', ')}`
      : 'no node pools',
  );
  const { idempotencyKey: _key, ...request } = input;
  const digest = createHash('sha256').update(canonical(request)).digest('hex').slice(0, 16);
  return `kubernetesClusters.create: ${parts.join('; ')} (request sha256 ${digest})`;
}
