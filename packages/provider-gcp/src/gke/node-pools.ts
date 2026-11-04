import {
  ComputeError,
  type KubernetesNodePoolSpec,
  type ProviderResourceState,
} from '@better-compute/core';
import { checkName, invalid, resourceState, type GkeNodePool } from './client.js';

// GKE node pools of a standard cluster: the create body, the status mapping, and what may change
// in place (the size and the autoscaling bounds).

const cloudPlatformScope = 'https://www.googleapis.com/auth/cloud-platform';
const machineTypePattern = /^[a-z][-a-z0-9]{0,62}$/;
const zonePattern = /^[a-z]+-[a-z]+[0-9]+-[a-z]$/;
const maxNodesPerZone = 1000;

const taintEffects = {
  NoSchedule: 'NO_SCHEDULE',
  PreferNoSchedule: 'PREFER_NO_SCHEDULE',
  NoExecute: 'NO_EXECUTE',
} as const;

const isCount = (value: unknown, min: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= maxNodesPerZone;

/** Validates a node pool spec. */
export function checkNodePoolSpec(spec: KubernetesNodePoolSpec): void {
  checkName(spec.name, 'The node pool name');
  if (typeof spec.machineType !== 'string' || !machineTypePattern.test(spec.machineType))
    throw invalid(`${JSON.stringify(spec.machineType)} is not a machine type`);
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
    !(Number.isInteger(spec.diskGiB) && spec.diskGiB >= 10 && spec.diskGiB <= 65536)
  )
    throw invalid('diskGiB must be a whole number from 10 to 65536');
  if (spec.diskType !== undefined && !/^[a-z][-a-z0-9]{0,62}$/.test(spec.diskType))
    throw invalid(`${JSON.stringify(spec.diskType)} is not a disk type`);
  if (spec.accelerators) {
    const { type, count } = spec.accelerators;
    if (typeof type !== 'string' || !/^[a-z][-a-z0-9]{0,62}$/.test(type))
      throw invalid(`${JSON.stringify(type)} is not an accelerator type`);
    if (!Number.isInteger(count) || count < 1 || count > 16)
      throw invalid('accelerators.count must be a whole number from 1 to 16');
  }
  for (const zone of spec.zones ?? [])
    if (typeof zone !== 'string' || !zonePattern.test(zone))
      throw invalid(`${JSON.stringify(zone)} is not a GCP zone`);
  for (const taint of spec.taints ?? [])
    if (!(taint.effect in taintEffects))
      throw invalid(
        `The taint effect ${JSON.stringify(taint.effect)} is not NoSchedule, PreferNoSchedule or NoExecute`,
      );
}

function autoscalingOf(spec: KubernetesNodePoolSpec) {
  return spec.autoscaling
    ? {
        enabled: true,
        minNodeCount: spec.autoscaling.minNodes,
        maxNodeCount: spec.autoscaling.maxNodes,
      }
    : { enabled: false };
}

/** The `nodePool` of a `nodePools.create` request (and of a cluster's `nodePools`). */
export function nodePoolBody(spec: KubernetesNodePoolSpec): Record<string, unknown> {
  return {
    name: spec.name,
    initialNodeCount: spec.nodeCount,
    autoscaling: autoscalingOf(spec),
    config: {
      machineType: spec.machineType,
      ...(spec.diskGiB !== undefined ? { diskSizeGb: spec.diskGiB } : {}),
      ...(spec.diskType !== undefined ? { diskType: spec.diskType } : {}),
      ...(spec.spot ? { spot: true } : {}),
      ...(spec.accelerators
        ? {
            accelerators: [
              {
                acceleratorType: spec.accelerators.type,
                acceleratorCount: spec.accelerators.count,
                gpuDriverInstallationConfig: { gpuDriverVersion: 'DEFAULT' },
              },
            ],
          }
        : {}),
      ...(spec.labels ? { labels: { ...spec.labels } } : {}),
      ...(spec.taints?.length
        ? {
            taints: spec.taints.map((taint) => ({
              key: taint.key,
              ...(taint.value !== undefined ? { value: taint.value } : {}),
              effect: taintEffects[taint.effect],
            })),
          }
        : {}),
      shieldedInstanceConfig: { enableSecureBoot: true, enableIntegrityMonitoring: true },
      workloadMetadataConfig: { mode: 'GKE_METADATA' },
      oauthScopes: [cloudPlatformScope],
    },
    ...(spec.zones?.length ? { locations: [...spec.zones] } : {}),
    management: { autoUpgrade: true, autoRepair: true },
  };
}

/** A node pool's state as its status says. */
export function nodePoolState(id: string, pool: GkeNodePool): ProviderResourceState {
  const outputs: Record<string, string> = pool.version ? { version: pool.version } : {};
  switch (pool.status) {
    case 'RUNNING':
      return resourceState(id, 'ready', { outputs });
    case 'RUNNING_WITH_ERROR':
      // Serving, but some of its nodes failed: ready, with GKE's message.
      return resourceState(id, 'ready', {
        outputs,
        message: pool.statusMessage || `Node pool ${pool.name} is running with errors`,
      });
    case 'RECONCILING':
      return resourceState(id, 'updating', { outputs });
    case 'STOPPING':
      return resourceState(id, 'deleting');
    case 'ERROR':
      return resourceState(id, 'error', {
        message: pool.statusMessage || `Node pool ${pool.name} is in error`,
      });
    default: // PROVISIONING, STATUS_UNSPECIFIED
      return resourceState(id, 'pending');
  }
}

function immutable(id: string, what: string, actual: unknown, desired: unknown): ComputeError {
  return new ComputeError(
    'INVALID_STATE',
    `Node pool ${id} exists with ${what} ${JSON.stringify(actual)}, not ${JSON.stringify(desired)}; ` +
      'only nodeCount and autoscaling change in place (create a new pool)',
    undefined,
    { provider: 'gcp', reason: 'immutable', field: what },
  );
}

const sortedJson = (values: readonly string[]): string => JSON.stringify([...values].sort());

/**
 * Refuses a difference that cannot change in place. Labels and taints are compared as "at least
 * these" (GKE may add its own, such as the GPU taint); disk fields only when the spec names them.
 */
export function checkNodePoolImmutable(
  id: string,
  spec: KubernetesNodePoolSpec,
  pool: GkeNodePool,
): void {
  const config = pool.config ?? {};
  if (config.machineType !== undefined && config.machineType !== spec.machineType)
    throw immutable(id, 'machineType', config.machineType, spec.machineType);
  if (
    spec.diskGiB !== undefined &&
    config.diskSizeGb !== undefined &&
    config.diskSizeGb !== spec.diskGiB
  )
    throw immutable(id, 'diskGiB', config.diskSizeGb, spec.diskGiB);
  if (
    spec.diskType !== undefined &&
    config.diskType !== undefined &&
    config.diskType !== spec.diskType
  )
    throw immutable(id, 'diskType', config.diskType, spec.diskType);
  if ((config.spot === true) !== (spec.spot === true))
    throw immutable(id, 'spot', config.spot === true, spec.spot === true);
  const accelerator = config.accelerators?.[0];
  const actualAccelerator = accelerator
    ? { type: accelerator.acceleratorType, count: Number(accelerator.acceleratorCount ?? 0) }
    : undefined;
  const desiredAccelerator = spec.accelerators
    ? { type: spec.accelerators.type, count: spec.accelerators.count }
    : undefined;
  if (JSON.stringify(actualAccelerator) !== JSON.stringify(desiredAccelerator))
    throw immutable(id, 'accelerators', actualAccelerator ?? null, desiredAccelerator ?? null);
  if (spec.zones?.length && pool.locations && sortedJson(pool.locations) !== sortedJson(spec.zones))
    throw immutable(id, 'zones', pool.locations, spec.zones);
  for (const [key, value] of Object.entries(spec.labels ?? {}))
    if (config.labels?.[key] !== value)
      throw immutable(id, `label ${key}`, config.labels?.[key] ?? null, value);
  for (const taint of spec.taints ?? []) {
    const effect = taintEffects[taint.effect];
    if (
      !(config.taints ?? []).some(
        (t) =>
          t.key === taint.key && (t.value ?? '') === (taint.value ?? '') && t.effect === effect,
      )
    )
      throw immutable(id, `taint ${taint.key}`, null, taint);
  }
}

/** `setAutoscaling`'s body when the pool's autoscaling differs from the spec's; else undefined. */
export function autoscalingChange(
  spec: KubernetesNodePoolSpec,
  pool: GkeNodePool,
): { autoscaling: Record<string, unknown> } | undefined {
  const desired = autoscalingOf(spec);
  const actual = pool.autoscaling ?? {};
  const same = desired.enabled
    ? actual.enabled === true &&
      actual.minNodeCount === desired.minNodeCount &&
      actual.maxNodeCount === desired.maxNodeCount
    : actual.enabled !== true;
  return same ? undefined : { autoscaling: desired };
}

/**
 * The zone and name of each managed instance group of a pool, from `instanceGroupUrls`. The URLs
 * are only parsed, never fetched: the bearer token goes to the provider's own endpoint.
 */
export function instanceGroupsOf(
  pool: GkeNodePool,
): { project: string; zone: string; name: string }[] {
  const groups: { project: string; zone: string; name: string }[] = [];
  for (const url of pool.instanceGroupUrls ?? []) {
    const match =
      /\/projects\/([a-z][-a-z0-9.:]{0,62})\/zones\/([a-z]+-[a-z]+[0-9]+-[a-z])\/(?:instanceGroupManagers|instanceGroups)\/([a-z][-a-z0-9]{0,62})$/.exec(
        url,
      );
    if (match) groups.push({ project: match[1]!, zone: match[2]!, name: match[3]! });
  }
  return groups;
}
