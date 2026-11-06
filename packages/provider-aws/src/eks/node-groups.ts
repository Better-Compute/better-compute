import {
  ComputeError,
  type KubernetesNodePoolSpec,
  type ProviderResourceState,
} from '@better-compute/core';
import { tags as managedTags } from '../ids.js';
import type { InstanceTypeInfo } from '../shapes.js';
import {
  checkName,
  invalid,
  issueMessage,
  nodegroupNamePattern,
  resourceState,
  type EksNodegroup,
} from './client.js';

// EKS managed node groups of a standard cluster: the CreateNodegroup body, the status mapping, and
// what may change in place (the size and the scaling bounds).
//
// A node pool's counts are per zone (as on GKE); a node group's are totals, so they are the pool's
// times its zones (the distinct Availability Zones of its subnets), which the group carries as a
// tag. GPU instance types get the NVIDIA AL2023 AMI and the taint `nvidia.com/gpu=:NoSchedule`
// (GKE taints its GPU pools the same way); Graviton types the arm64 AMI; Inferentia and Trainium
// the Neuron AMI. With `autoscaling`, the bounds are the group's min and max size and a cluster
// autoscaler in the cluster owns its desired size.

const machineTypePattern = /^[a-z][a-z0-9-]*\.[a-z0-9-]+$/;
const zonePattern = /^[a-z]{2}(?:-gov)?-[a-z]+-\d{1,2}(?:[a-z]|-[a-z]{2,10}-\d{1,2}[a-z])$/;
const acceleratorPattern = /^[a-z][-a-z0-9]{0,62}$/;
const maxNodesPerZone = 1000;
const maxTaints = 50;

/** The tags better-compute keeps on its node groups. */
export const nodegroupTags = {
  managed: managedTags.managed,
  zones: 'better-compute:zones',
  accelerators: 'better-compute:accelerators',
} as const;

/** The taint EKS GPU node groups carry, as GKE's GPU node pools do. */
export const gpuTaint = { key: 'nvidia.com/gpu', effect: 'NoSchedule' } as const;
/** The taint Neuron (Inferentia, Trainium) node groups carry, so only Neuron workloads land there. */
export const neuronTaint = { key: 'aws.amazon.com/neuron', effect: 'NoSchedule' } as const;

const taintEffects = {
  NoSchedule: 'NO_SCHEDULE',
  PreferNoSchedule: 'PREFER_NO_SCHEDULE',
  NoExecute: 'NO_EXECUTE',
} as const;

const isCount = (value: unknown, min: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= maxNodesPerZone;

/** Validates a node pool spec. */
export function checkNodePoolSpec(spec: KubernetesNodePoolSpec): void {
  checkName(spec.name, 'The node pool name', nodegroupNamePattern);
  if (typeof spec.machineType !== 'string' || !machineTypePattern.test(spec.machineType))
    throw invalid(`${JSON.stringify(spec.machineType)} is not an EC2 instance type (m7i.large)`);
  if (!isCount(spec.nodeCount, 0))
    throw invalid(`nodeCount must be a whole number from 0 to ${maxNodesPerZone}`);
  if (spec.autoscaling) {
    const { minNodes, maxNodes } = spec.autoscaling;
    if (!isCount(minNodes, 0) || !isCount(maxNodes, 1) || minNodes > maxNodes)
      throw invalid(
        `autoscaling needs whole numbers 0 <= minNodes <= maxNodes <= ${maxNodesPerZone}, maxNodes at least 1`,
      );
  }
  if (
    spec.diskGiB !== undefined &&
    !(Number.isInteger(spec.diskGiB) && spec.diskGiB >= 10 && spec.diskGiB <= 16384)
  )
    throw invalid('diskGiB must be a whole number from 10 to 16384');
  if (spec.diskType !== undefined)
    throw invalid(
      'EKS managed node groups take no diskType (the AMI decides the root volume type; a launch template would): leave it out',
    );
  if (spec.accelerators) {
    const { type, count } = spec.accelerators;
    if (typeof type !== 'string' || !acceleratorPattern.test(type))
      throw invalid(`${JSON.stringify(type)} is not an accelerator type`);
    if (!Number.isInteger(count) || count < 1 || count > 16)
      throw invalid('accelerators.count must be a whole number from 1 to 16');
  }
  for (const zone of spec.zones ?? [])
    if (typeof zone !== 'string' || !zonePattern.test(zone))
      throw invalid(`${JSON.stringify(zone)} is not an AWS Availability Zone`);
  if ((spec.taints?.length ?? 0) > maxTaints)
    throw invalid(`EKS node groups take at most ${maxTaints} taints`);
  for (const taint of spec.taints ?? [])
    if (!(taint.effect in taintEffects))
      throw invalid(
        `The taint effect ${JSON.stringify(taint.effect)} is not NoSchedule, PreferNoSchedule or NoExecute`,
      );
}

const neuronPattern = /^(inf|trn)\d/;

/** Whether the type is a GPU type (NVIDIA): from DescribeInstanceTypes when known. */
export const isGpuType = (info: InstanceTypeInfo | undefined): boolean => (info?.gpus?.count ?? 0) > 0;

/** The AL2023 EKS AMI type for an instance type. */
export function amiTypeOf(machineType: string, info: InstanceTypeInfo | undefined): string {
  if (neuronPattern.test(machineType)) return 'AL2023_x86_64_NEURON';
  const arm = info ? !info.arch.includes('x86_64') && info.arch.includes('arm64') : false;
  if (isGpuType(info)) return arm ? 'AL2023_ARM_64_NVIDIA' : 'AL2023_x86_64_NVIDIA';
  return arm ? 'AL2023_ARM_64_STANDARD' : 'AL2023_x86_64_STANDARD';
}

/**
 * Checks `accelerators` against what the instance type has: EKS cannot attach accelerators, the
 * type brings them. NVIDIA types (`nvidia-<model>`) must have that many GPUs of that model; Neuron
 * types take `aws-neuron`.
 */
export function checkAccelerators(spec: KubernetesNodePoolSpec, info: InstanceTypeInfo | undefined): void {
  const wanted = spec.accelerators;
  if (!wanted) return;
  if (neuronPattern.test(spec.machineType)) {
    if (wanted.type !== 'aws-neuron')
      throw invalid(`${spec.machineType} is a Neuron type: its accelerators are aws-neuron`);
    return;
  }
  // Unread (no ec2:DescribeInstanceTypes, or a type EC2 does not know): the AMI and the GPU taint
  // would silently be the CPU ones, so a GPU pool is refused rather than made unusable.
  if (!info)
    throw new ComputeError(
      'INVALID_STATE',
      `Cannot verify that ${spec.machineType} has ${wanted.count} ${wanted.type}: grant ec2:DescribeInstanceTypes (and check the instance type)`,
      undefined,
      { provider: 'aws', service: 'eks', reason: 'instanceTypeUnknown' },
    );
  if (!info.gpus || info.gpus.count === 0)
    throw invalid(`${spec.machineType} has no GPUs: pick a GPU instance type for accelerators`);
  if (info.gpus.count !== wanted.count)
    throw invalid(
      `${spec.machineType} has ${info.gpus.count} GPUs, not ${wanted.count}: on EKS the instance type decides the count`,
    );
  if (info.gpus.model !== 'other' && wanted.type !== `nvidia-${info.gpus.model.toLowerCase()}`)
    throw invalid(
      `${spec.machineType} has ${info.gpus.model} GPUs: accelerators.type is nvidia-${info.gpus.model.toLowerCase()}`,
    );
}

/** The group's total min, max and desired size for `zones` zones. */
export function scalingOf(
  spec: KubernetesNodePoolSpec,
  zones: number,
): { minSize: number; maxSize: number; desiredSize: number } {
  const desired = spec.nodeCount * zones;
  if (!spec.autoscaling) return { minSize: desired, maxSize: Math.max(desired, 1), desiredSize: desired };
  const minSize = spec.autoscaling.minNodes * zones;
  const maxSize = spec.autoscaling.maxNodes * zones;
  return { minSize, maxSize, desiredSize: Math.min(Math.max(desired, minSize), maxSize) };
}

function taintsOf(spec: KubernetesNodePoolSpec, accelerator: typeof gpuTaint | typeof neuronTaint | undefined) {
  const taints = (spec.taints ?? []).map((taint) => ({
    key: taint.key,
    ...(taint.value !== undefined ? { value: taint.value } : {}),
    effect: taintEffects[taint.effect],
  }));
  if (accelerator && !taints.some((taint) => taint.key === accelerator.key))
    taints.push({ key: accelerator.key, effect: taintEffects[accelerator.effect] });
  return taints;
}

/** The body of `CreateNodegroup`. */
export function nodegroupBody(
  spec: KubernetesNodePoolSpec,
  options: {
    subnets: readonly string[];
    zones: number;
    nodeRole: string;
    info: InstanceTypeInfo | undefined;
    clientRequestToken: string;
  },
): Record<string, unknown> {
  const amiType = amiTypeOf(spec.machineType, options.info);
  const taints = taintsOf(
    spec,
    amiType.endsWith('_NVIDIA') ? gpuTaint : amiType.endsWith('_NEURON') ? neuronTaint : undefined,
  );
  const tags: Record<string, string> = {
    [nodegroupTags.managed]: 'true',
    [nodegroupTags.zones]: String(options.zones),
  };
  if (spec.accelerators)
    tags[nodegroupTags.accelerators] = `${spec.accelerators.type}x${spec.accelerators.count}`;
  return {
    nodegroupName: spec.name,
    scalingConfig: scalingOf(spec, options.zones),
    instanceTypes: [spec.machineType],
    amiType,
    capacityType: spec.spot ? 'SPOT' : 'ON_DEMAND',
    subnets: [...options.subnets],
    nodeRole: options.nodeRole,
    ...(spec.diskGiB !== undefined ? { diskSize: spec.diskGiB } : {}),
    ...(spec.labels && Object.keys(spec.labels).length ? { labels: { ...spec.labels } } : {}),
    ...(taints.length ? { taints } : {}),
    updateConfig: { maxUnavailable: 1 },
    tags,
    clientRequestToken: options.clientRequestToken,
  };
}

/** A node group's state as its status says. */
export function nodegroupState(id: string, group: EksNodegroup): ProviderResourceState {
  const outputs: Record<string, string> = {
    ...(group.version ? { version: group.version } : {}),
    ...(group.releaseVersion ? { releaseVersion: group.releaseVersion } : {}),
  };
  switch (group.status) {
    case 'ACTIVE':
      return resourceState(id, 'ready', { outputs });
    case 'DEGRADED':
      // Serving, but some of its nodes failed: ready, with EKS's words.
      return resourceState(id, 'ready', {
        outputs,
        message: issueMessage(group.health) ?? `Node group ${group.nodegroupName} is degraded`,
      });
    case 'UPDATING':
      return resourceState(id, 'updating', { outputs });
    case 'DELETING':
      return resourceState(id, 'deleting');
    case 'CREATE_FAILED':
    case 'DELETE_FAILED':
      return resourceState(id, 'error', {
        message: issueMessage(group.health) ?? `Node group ${group.nodegroupName} is ${group.status}`,
      });
    default: // CREATING
      return resourceState(id, 'pending');
  }
}

function immutable(id: string, what: string, actual: unknown, desired: unknown): ComputeError {
  return new ComputeError(
    'INVALID_STATE',
    `Node pool ${id} exists with ${what} ${JSON.stringify(actual)}, not ${JSON.stringify(desired)}; ` +
      'only nodeCount and autoscaling change in place (create a new pool)',
    undefined,
    { provider: 'aws', service: 'eks', reason: 'immutable', field: what },
  );
}

const sortedJson = (values: readonly string[]): string => JSON.stringify([...values].sort());

/**
 * Refuses a difference that cannot change in place. Labels and taints are compared as "at least
 * these" (EKS and the driver add their own, such as the GPU taint); the disk only when the spec
 * names it; the subnets only when the spec names zones (`subnets` is what they resolve to).
 */
export function checkNodegroupImmutable(
  id: string,
  spec: KubernetesNodePoolSpec,
  group: EksNodegroup,
  subnets: readonly string[] | undefined,
): void {
  const type = group.instanceTypes?.[0];
  if (type !== undefined && type !== spec.machineType)
    throw immutable(id, 'machineType', type, spec.machineType);
  if (spec.diskGiB !== undefined && group.diskSize !== undefined && group.diskSize !== spec.diskGiB)
    throw immutable(id, 'diskGiB', group.diskSize, spec.diskGiB);
  const spot = group.capacityType === 'SPOT';
  if (spot !== (spec.spot === true)) throw immutable(id, 'spot', spot, spec.spot === true);
  const recorded = group.tags?.[nodegroupTags.accelerators] ?? null;
  const desired = spec.accelerators ? `${spec.accelerators.type}x${spec.accelerators.count}` : null;
  if (recorded !== desired) throw immutable(id, 'accelerators', recorded, desired);
  if (subnets && group.subnets && sortedJson(group.subnets) !== sortedJson(subnets))
    throw immutable(id, 'zones', group.subnets, subnets);
  for (const [key, value] of Object.entries(spec.labels ?? {}))
    if (group.labels?.[key] !== value)
      throw immutable(id, `label ${key}`, group.labels?.[key] ?? null, value);
  for (const taint of spec.taints ?? []) {
    const effect = taintEffects[taint.effect];
    if (
      !(group.taints ?? []).some(
        (t) => t.key === taint.key && (t.value ?? '') === (taint.value ?? '') && t.effect === effect,
      )
    )
      throw immutable(id, `taint ${taint.key}`, null, taint);
  }
}

/** The zones a group spans, as it recorded them (1 when it carries no record). */
export function zonesOf(group: EksNodegroup): number {
  const value = Number(group.tags?.[nodegroupTags.zones]);
  return Number.isInteger(value) && value >= 1 && value <= 64 ? value : 1;
}

/**
 * `UpdateNodegroupConfig`'s `scalingConfig` when the group's size or bounds differ from the spec's;
 * else undefined. With autoscaling only the bounds count (the autoscaler owns the desired size,
 * which is kept, clamped into the new bounds).
 */
export function scalingChange(
  spec: KubernetesNodePoolSpec,
  group: EksNodegroup,
): { minSize: number; maxSize: number; desiredSize: number } | undefined {
  const zones = zonesOf(group);
  const want = scalingOf(spec, zones);
  const have = group.scalingConfig ?? {};
  if (spec.autoscaling) {
    if (have.minSize === want.minSize && have.maxSize === want.maxSize) return undefined;
    const current = have.desiredSize ?? want.desiredSize;
    return { ...want, desiredSize: Math.min(Math.max(current, want.minSize), want.maxSize) };
  }
  if (
    have.minSize === want.minSize &&
    have.maxSize === want.maxSize &&
    have.desiredSize === want.desiredSize
  )
    return undefined;
  return want;
}
