import {
  ComputeError,
  type KubernetesClusterSpec,
  type ProviderResourceState,
} from '@better-compute/core';
import { labels as managedLabels, tagFor } from '../ids.js';
import { checkName, checkRegion, fail, invalid, resourceState } from './common.js';
import { checkNodePoolSpec } from './node-pools.js';
import type { DoksCluster } from './types.js';
import { parseDoksVersion } from './versions.js';

// DOKS clusters: the spec checks, the create body, the status mapping, ownership, and what may
// change in place (auto-upgrade, the control-plane firewall, the device plugins).

const channels = ['rapid', 'regular', 'stable', 'extended'] as const;
const cidrPattern = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/;
const labelKeyPattern = /^[a-z0-9_-]{1,64}$/;
/**
 * DOKS's own tag keys: `k8s`, `k8s:<cluster uuid>` (membership) and `k8s-worker`. A label with one
 * of them would collide with (or forge) the tags DOKS manages, and DOKS strips them on a PUT.
 */
const doksTagKeys = new Set(['k8s', 'k8s-worker']);

/**
 * The tag that marks a DOKS cluster (and its node pools) as better-compute's. It is deliberately
 * not `better-compute-managed:true`: DOKS puts a pool's tags on its worker Droplets, and a Droplet
 * with the managed tag is one the Droplet code may delete.
 */
export const kubernetesTag = tagFor('better-compute-kubernetes', 'true');

/**
 * Label keys a cluster never carries as tags: the ones that make a Droplet a vps instance or put
 * it up for auto-attach (worker Droplets may inherit the tags), and the ownership keys.
 */
const reservedLabelKeys = new Set<string>([
  managedLabels.managed,
  managedLabels.instance,
  managedLabels.tenant,
  managedLabels.pool,
  managedLabels.owner,
  managedLabels.deployment,
  managedLabels.key,
  'better-compute-kubernetes',
]);

/** The ownership tags of this deployment's clusters and node pools. */
export function ownershipTags(deploymentTag: string): string[] {
  return [kubernetesTag, deploymentTag];
}

const lower = (tags: readonly string[] | undefined): Set<string> =>
  new Set((tags ?? []).map((tag) => tag.toLowerCase()));

/** Whether a cluster (or node pool) is this deployment's: both ownership tags. */
export function isOwned(tags: readonly string[] | undefined, deploymentTag: string): boolean {
  const have = lower(tags);
  return ownershipTags(deploymentTag).every((tag) => have.has(tag.toLowerCase()));
}

function checkCidr(value: unknown): string {
  const match = typeof value === 'string' ? cidrPattern.exec(value) : null;
  if (
    !match ||
    match.slice(1, 5).some((octet) => Number(octet) > 255) ||
    (match[5] !== undefined && Number(match[5]) > 32)
  )
    throw invalid(`${JSON.stringify(value)} is not an IPv4 address or CIDR block`, 'cidr');
  return value as string;
}

/** Validates a cluster spec (the node pools only when `forCreate`). */
export function checkClusterSpec(
  spec: KubernetesClusterSpec,
  regions: readonly string[],
  forCreate: boolean,
): void {
  checkName(spec.name, 'The cluster name');
  checkRegion(spec.location, regions);
  if (spec.mode === 'autopilot')
    throw fail(
      'UNSUPPORTED',
      'DOKS has no autopilot mode: a DOKS cluster is standard, with node pools',
      'autopilot',
    );
  if (spec.mode !== 'standard')
    throw invalid(`The cluster mode ${JSON.stringify(spec.mode)} is not standard`, 'mode');
  if (!channels.includes(spec.releaseChannel))
    throw invalid(
      `The release channel ${JSON.stringify(spec.releaseChannel)} is not one of ${channels.join(', ')}`,
      'releaseChannel',
    );
  if (spec.version !== undefined && !parseDoksVersion(spec.version))
    throw invalid(
      `${JSON.stringify(spec.version)} is not a DOKS version (1.33, 1.33.5 or 1.33.5-do.1)`,
      'version',
    );
  if (!Array.isArray(spec.authorizedNetworks))
    throw invalid('authorizedNetworks must be a list of CIDR blocks', 'cidr');
  spec.authorizedNetworks.forEach(checkCidr);
  if (spec.privateNodes)
    throw fail(
      'UNSUPPORTED',
      'DOKS worker nodes without public addresses need a VPC NAT gateway, which is not supported yet',
      'privateNodes',
    );
  for (const key of Object.keys(spec.labels ?? {})) {
    if (!labelKeyPattern.test(key.toLowerCase()))
      throw invalid(
        `The label key ${JSON.stringify(key)} cannot be a DigitalOcean tag key ([a-z0-9_-], at most 64)`,
        'label',
      );
    if (doksTagKeys.has(key.toLowerCase()))
      throw invalid(
        `The label key ${JSON.stringify(key)} is DOKS's own tag key (k8s, k8s-worker)`,
        'label',
      );
  }
  if (!forCreate) return;
  const pools = spec.initialNodePools ?? [];
  if (pools.length === 0)
    throw invalid(
      'A DOKS cluster is created with at least one node pool (initialNodePools)',
      'initialNodePools',
    );
  const names = new Set<string>();
  for (const pool of pools) {
    checkNodePoolSpec(pool);
    if (names.has(pool.name)) throw invalid(`Node pool ${pool.name} is listed twice`, 'nodePool');
    names.add(pool.name);
  }
}

/** The tags of the spec's labels (reserved keys dropped). */
function labelTags(spec: KubernetesClusterSpec): string[] {
  const tags: string[] = [];
  for (const [key, value] of Object.entries(spec.labels ?? {})) {
    if (reservedLabelKeys.has(key.toLowerCase())) continue;
    tags.push(tagFor(key, value));
  }
  return tags;
}

/** The tags a new cluster carries: ownership, then the spec's labels (reserved keys dropped). */
export function clusterTags(spec: KubernetesClusterSpec, deploymentTag: string): string[] {
  return [...new Set([...ownershipTags(deploymentTag), ...labelTags(spec)])];
}

const tagKey = (tag: string): string => tag.slice(0, Math.max(tag.indexOf(':'), 0)).toLowerCase();

/**
 * The cluster's own tags with the spec's labels applied, or undefined when they already are: a
 * label's tag is added, or replaces the tag of the same key with another value. A tag no label
 * names is kept (it may be someone else's), so a label taken out of the spec stays on the cluster.
 */
export function reconciledTags(
  spec: KubernetesClusterSpec,
  cluster: DoksCluster,
): string[] | undefined {
  const own = ownTags(cluster);
  const wanted = labelTags(spec);
  const keys = new Set(wanted.map(tagKey));
  const have = new Set(own.map((tag) => tag.toLowerCase()));
  const stale = own.filter((tag) => keys.has(tagKey(tag)) && !wanted.includes(tag.toLowerCase()));
  const missing = wanted.filter((tag) => !have.has(tag));
  if (stale.length === 0 && missing.length === 0) return undefined;
  return [...own.filter((tag) => !stale.includes(tag)), ...missing];
}

/** DOKS has no release channels: `extended` keeps a cluster on its version, the rest auto-upgrade. */
export function autoUpgradeOf(spec: KubernetesClusterSpec): boolean {
  return spec.releaseChannel !== 'extended';
}

export function firewallOf(cidrs: readonly string[]): {
  enabled: boolean;
  allowed_addresses: string[];
} {
  return { enabled: cidrs.length > 0, allowed_addresses: [...cidrs].sort() };
}

/**
 * DO-D18: the bcd DaemonSet's own device plugin advertises the GPUs (compute books them), so DOKS's
 * device plugins and AMD's metrics exporter stay off.
 */
export const pluginsOff = {
  nvidia_gpu_device_plugin: { enabled: false },
  amd_gpu_device_plugin: { enabled: false },
  amd_gpu_device_metrics_exporter_plugin: { enabled: false },
} as const;

/** The ready outputs of a cluster (plain values, never secrets). */
export function outputsOf(cluster: DoksCluster): Record<string, string> {
  if (!cluster.endpoint) return {};
  return {
    endpoint: cluster.endpoint,
    location: cluster.region,
    version: cluster.version,
    // DOKS node pools run the control plane's version.
    nodeVersion: cluster.version,
  };
}

/** A cluster's state as its status says. */
export function clusterState(id: string, cluster: DoksCluster): ProviderResourceState {
  const outputs = outputsOf(cluster);
  const message = cluster.status?.message;
  switch (cluster.status?.state) {
    case 'running':
      return resourceState(id, 'ready', { outputs });
    case 'degraded':
      // Serving, but some of its parts are unhealthy: ready, with DO's message.
      return resourceState(id, 'ready', {
        outputs,
        message: message || `Cluster ${cluster.name} is degraded`,
      });
    case 'upgrading':
      return resourceState(id, 'updating', { outputs });
    case 'deleting':
      return resourceState(id, 'deleting');
    case 'deleted':
      return resourceState(id, 'deleted');
    case 'error':
    case 'invalid':
      return resourceState(id, 'error', {
        outputs,
        message: message || `Cluster ${cluster.name} is in ${cluster.status.state}`,
      });
    default: // provisioning
      return resourceState(id, 'pending');
  }
}

export function immutable(
  id: string,
  what: string,
  actual: unknown,
  desired: unknown,
): ComputeError {
  return fail(
    'INVALID_STATE',
    `Cluster ${id} exists with ${what} ${JSON.stringify(actual)}, not ${JSON.stringify(desired)}; ` +
      'that cannot change in place (create a new cluster)',
    'immutable',
    { field: what },
  );
}

/**
 * The cluster's GPU device plugins that are on (by their field names): each would advertise the
 * GPUs of a GPU pool next to bcd's device plugin, outside compute's booking (DO-D18).
 */
export function gpuDevicePluginsOn(cluster: DoksCluster): string[] {
  return (['nvidia_gpu_device_plugin', 'amd_gpu_device_plugin'] as const).filter(
    (field) => cluster[field]?.enabled === true,
  );
}

const pluginOn = (cluster: DoksCluster): boolean =>
  cluster.nvidia_gpu_device_plugin?.enabled === true ||
  cluster.amd_gpu_device_plugin?.enabled === true ||
  cluster.amd_gpu_device_metrics_exporter_plugin?.enabled === true;

/**
 * The fields of the `PUT /kubernetes/clusters/{id}` a running cluster needs, or undefined when it
 * is as wanted: auto-upgrade (the release channel), the control-plane firewall (authorized
 * networks), the device plugins (off) and the labels' tags. DOKS takes them in one update.
 */
export function clusterUpdate(
  spec: KubernetesClusterSpec,
  cluster: DoksCluster,
): Record<string, unknown> | undefined {
  const update: Record<string, unknown> = {};
  const autoUpgrade = autoUpgradeOf(spec);
  if ((cluster.auto_upgrade === true) !== autoUpgrade) update.auto_upgrade = autoUpgrade;
  const desired = firewallOf(spec.authorizedNetworks);
  const actual = cluster.control_plane_firewall;
  const actualEnabled = actual?.enabled === true;
  const actualCidrs = actualEnabled ? [...(actual?.allowed_addresses ?? [])].sort() : [];
  if (
    actualEnabled !== desired.enabled ||
    JSON.stringify(actualCidrs) !== JSON.stringify(desired.allowed_addresses)
  )
    update.control_plane_firewall = desired;
  if (pluginOn(cluster)) Object.assign(update, pluginsOff);
  const tags = reconciledTags(spec, cluster);
  if (tags) update.tags = tags;
  return Object.keys(update).length > 0 ? update : undefined;
}

/** The cluster's own tags, without the ones DOKS adds (`k8s`, `k8s:<uuid>`), for a PUT. */
export function ownTags(cluster: DoksCluster): string[] {
  return (cluster.tags ?? []).filter((tag) => tag !== 'k8s' && !tag.startsWith('k8s:'));
}
