import {
  ComputeError,
  type KubernetesClusterSpec,
  type ProviderResourceState,
} from '@better-compute/core';
import type { GcpConfig } from '../config.js';
import { labels as managedLabels, labelValue } from '../ids.js';
import {
  checkLocation,
  checkName,
  invalid,
  lastSegment,
  resourceState,
  type GkeCluster,
} from './client.js';
import { checkNodePoolSpec, nodePoolBody } from './node-pools.js';

// GKE clusters: the create body, the status mapping, and what may change in place.

const channels = ['rapid', 'regular', 'stable', 'extended'] as const;
const versionPattern = /^(\d+)\.(\d+)(?:\.(\d+)(?:-gke\.(\d+))?)?$/;
const labelKeyPattern = /^[a-z][a-z0-9_-]{0,62}$/;
const cidrPattern = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;

/** A Kubernetes version as numbers: `1.33` → [1, 33], `1.33.2-gke.1100` → [1, 33, 2, 1100]. */
export function parseVersion(value: string): number[] | undefined {
  const match = versionPattern.exec(value);
  if (!match) return undefined;
  return match
    .slice(1)
    .filter((part) => part !== undefined)
    .map(Number);
}

/**
 * Compares the desired version with the actual one over the parts the desired one names: 0 when
 * the actual satisfies it (`1.33` is satisfied by `1.33.2-gke.1100`), negative when the desired is
 * older (a downgrade), positive when it is newer.
 */
export function compareVersion(desired: string, actual: string): number {
  const want = parseVersion(desired) ?? [];
  const have = parseVersion(actual) ?? [];
  for (let i = 0; i < want.length; i++) {
    const difference = want[i]! - (have[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function checkCidr(value: unknown): string {
  const match = typeof value === 'string' ? cidrPattern.exec(value) : null;
  if (!match || match.slice(1, 5).some((octet) => Number(octet) > 255) || Number(match[5]) > 32)
    throw invalid(`${JSON.stringify(value)} is not an IPv4 CIDR block`);
  return value as string;
}

/** Validates a cluster spec (the node pools only when `forCreate`). */
export function checkClusterSpec(spec: KubernetesClusterSpec, forCreate: boolean): void {
  checkName(spec.name, 'The cluster name');
  checkLocation(spec.location);
  if (spec.mode !== 'standard' && spec.mode !== 'autopilot')
    throw invalid(`The cluster mode ${JSON.stringify(spec.mode)} is not standard or autopilot`);
  if (!channels.includes(spec.releaseChannel))
    throw invalid(
      `The release channel ${JSON.stringify(spec.releaseChannel)} is not one of ${channels.join(', ')}`,
    );
  if (spec.version !== undefined && !parseVersion(spec.version))
    throw invalid(`${JSON.stringify(spec.version)} is not a GKE version (1.33 or 1.33.2-gke.1100)`);
  if (!Array.isArray(spec.authorizedNetworks))
    throw invalid('authorizedNetworks must be a list of CIDR blocks');
  spec.authorizedNetworks.forEach(checkCidr);
  for (const key of Object.keys(spec.labels ?? {}))
    if (!labelKeyPattern.test(key.toLowerCase()))
      throw invalid(`The label key ${JSON.stringify(key)} is not a GCP label key`);
  if (!forCreate) return;
  const pools = spec.initialNodePools ?? [];
  if (spec.mode === 'standard') {
    if (pools.length === 0)
      throw invalid(`A standard cluster is created with at least one node pool (initialNodePools)`);
    const names = new Set<string>();
    for (const pool of pools) {
      checkNodePoolSpec(pool);
      if (names.has(pool.name)) throw invalid(`Node pool ${pool.name} is listed twice`);
      names.add(pool.name);
    }
  } else if (pools.length > 0)
    throw invalid('An autopilot cluster has no node pools: the provider runs its nodes');
}

/** The network and subnet the cluster uses: the spec's, else the account's. */
function networkOf(
  spec: KubernetesClusterSpec,
  config: GcpConfig,
): { network: string; subnet?: string } {
  if (spec.network) return spec.network;
  return {
    network: config.network ?? 'default',
    ...(config.subnet ? { subnet: config.subnet } : {}),
  };
}

function authorizedNetworksConfig(cidrs: readonly string[]) {
  return cidrs.length
    ? { enabled: true, cidrBlocks: cidrs.map((cidrBlock) => ({ cidrBlock })) }
    : { enabled: false };
}

/** The `cluster` of a `clusters.create` request. */
export function clusterBody(
  spec: KubernetesClusterSpec,
  config: GcpConfig,
): Record<string, unknown> {
  const { network, subnet } = networkOf(spec, config);
  const resourceLabels: Record<string, string> = {};
  for (const [key, value] of Object.entries(spec.labels ?? {}))
    resourceLabels[key.toLowerCase()] = labelValue(value);
  resourceLabels[managedLabels.managed] = 'true';
  const autopilot = spec.mode === 'autopilot';
  return {
    name: spec.name,
    ...(spec.description !== undefined ? { description: spec.description } : {}),
    resourceLabels,
    releaseChannel: { channel: spec.releaseChannel.toUpperCase() },
    ...(spec.version !== undefined ? { initialClusterVersion: spec.version } : {}),
    network,
    ...(subnet !== undefined ? { subnetwork: subnet } : {}),
    ipAllocationPolicy: { useIpAliases: true },
    privateClusterConfig: { enablePrivateNodes: spec.privateNodes === true },
    masterAuthorizedNetworksConfig: authorizedNetworksConfig(spec.authorizedNetworks),
    shieldedNodes: { enabled: true },
    legacyAbac: { enabled: false },
    ...(autopilot
      ? { autopilot: { enabled: true } }
      : {
          workloadIdentityConfig: { workloadPool: `${config.projectId}.svc.id.goog` },
          nodePools: (spec.initialNodePools ?? []).map(nodePoolBody),
        }),
  };
}

/** The ready outputs of a cluster (plain values, never secrets). */
function outputsOf(cluster: GkeCluster, location: string): Record<string, string> {
  if (!cluster.endpoint) return {};
  return {
    endpoint: `https://${cluster.endpoint}`,
    location: cluster.location ?? location,
    ...(cluster.currentMasterVersion ? { version: cluster.currentMasterVersion } : {}),
    ...(cluster.currentNodeVersion ? { nodeVersion: cluster.currentNodeVersion } : {}),
    // The provider-global id: one cluster reached through two accounts of a project is one cluster.
    ...(typeof cluster.selfLink === 'string' && cluster.selfLink.length > 0 ? { globalId: cluster.selfLink } : {}),
  };
}

/** A cluster's state as its status says. */
export function clusterState(
  id: string,
  location: string,
  cluster: GkeCluster,
): ProviderResourceState {
  const outputs = outputsOf(cluster, location);
  const message = cluster.statusMessage || cluster.conditions?.find((c) => c.message)?.message;
  switch (cluster.status) {
    case 'RUNNING':
      return resourceState(id, 'ready', { outputs });
    case 'RECONCILING':
      return resourceState(id, 'updating', { outputs });
    case 'STOPPING':
      return resourceState(id, 'deleting');
    case 'ERROR':
    case 'DEGRADED':
      return resourceState(id, 'error', {
        outputs,
        message: message ?? `Cluster ${cluster.name} is ${cluster.status}`,
      });
    default: // PROVISIONING, STATUS_UNSPECIFIED
      return resourceState(id, 'pending');
  }
}

function privateNodesOf(cluster: GkeCluster): boolean {
  return (
    cluster.privateClusterConfig?.enablePrivateNodes ??
    cluster.networkConfig?.defaultEnablePrivateNodes ??
    false
  );
}

function immutable(id: string, what: string, actual: unknown, desired: unknown): ComputeError {
  return new ComputeError(
    'INVALID_STATE',
    `Cluster ${id} exists with ${what} ${JSON.stringify(actual)}, not ${JSON.stringify(desired)}; ` +
      'that cannot change in place (create a new cluster)',
    undefined,
    { provider: 'gcp', reason: 'immutable', field: what },
  );
}

/** Refuses a difference that cannot change in place: mode, location, network, private nodes. */
export function checkImmutable(
  id: string,
  spec: KubernetesClusterSpec,
  cluster: GkeCluster,
  config: GcpConfig,
): void {
  const mode = cluster.autopilot?.enabled === true ? 'autopilot' : 'standard';
  if (mode !== spec.mode) throw immutable(id, 'mode', mode, spec.mode);
  if (cluster.location && cluster.location !== spec.location)
    throw immutable(id, 'location', cluster.location, spec.location);
  const { network, subnet } = networkOf(spec, config);
  if (cluster.network && lastSegment(cluster.network) !== lastSegment(network))
    throw immutable(id, 'network', lastSegment(cluster.network), lastSegment(network));
  if (
    subnet !== undefined &&
    cluster.subnetwork &&
    lastSegment(cluster.subnetwork) !== lastSegment(subnet)
  )
    throw immutable(id, 'subnet', lastSegment(cluster.subnetwork), lastSegment(subnet));
  const privateNodes = privateNodesOf(cluster);
  if (privateNodes !== (spec.privateNodes === true))
    throw immutable(id, 'privateNodes', privateNodes, spec.privateNodes === true);
}

const sorted = (values: readonly string[]): string[] => [...values].sort();

/**
 * The one in-place update a running cluster needs next (`clusters.update`'s `update`), or
 * undefined when it is as wanted. GKE takes one change per update: the release channel, then the
 * control-plane version, then the authorized networks. A version older than the running one is
 * INVALID_STATE (GKE never downgrades a control plane).
 */
export function nextClusterUpdate(
  id: string,
  spec: KubernetesClusterSpec,
  cluster: GkeCluster,
): Record<string, unknown> | undefined {
  const channel = spec.releaseChannel.toUpperCase();
  if ((cluster.releaseChannel?.channel ?? 'UNSPECIFIED') !== channel)
    return { desiredReleaseChannel: { channel } };
  if (spec.version !== undefined && cluster.currentMasterVersion) {
    const difference = compareVersion(spec.version, cluster.currentMasterVersion);
    if (difference < 0)
      throw new ComputeError(
        'INVALID_STATE',
        `Cluster ${id} runs ${cluster.currentMasterVersion}: ${spec.version} would be a downgrade, which GKE does not do`,
        undefined,
        { provider: 'gcp', reason: 'downgrade' },
      );
    if (difference > 0) return { desiredMasterVersion: spec.version };
  }
  const actual = cluster.masterAuthorizedNetworksConfig;
  const actualEnabled = actual?.enabled === true;
  const actualCidrs = actualEnabled
    ? sorted((actual?.cidrBlocks ?? []).map((block) => block.cidrBlock ?? ''))
    : [];
  const desiredCidrs = sorted(spec.authorizedNetworks);
  if (
    actualEnabled !== desiredCidrs.length > 0 ||
    JSON.stringify(actualCidrs) !== JSON.stringify(desiredCidrs)
  )
    return {
      desiredMasterAuthorizedNetworksConfig: authorizedNetworksConfig(spec.authorizedNetworks),
    };
  return undefined;
}
