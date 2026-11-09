import {
  ComputeError,
  type KubernetesClusterSpec,
  type ProviderResourceState,
} from '@better-compute/core';
import { tags as managedTags, tagValue } from '../ids.js';
import {
  checkName,
  invalid,
  issueMessage,
  resourceState,
  type EksCluster,
} from './client.js';
import { checkNodePoolSpec } from './node-groups.js';

// EKS clusters: the CreateCluster body, the status mapping, and what may change in place.
//
// `standard` is a cluster whose nodes are managed node groups (`ensureNodePool`); `autopilot` is
// EKS Auto Mode (EKS runs the compute, block storage and load balancing; no node groups). Release
// channels map to EKS's support policy: `extended` keeps a version in extended support, the others
// are STANDARD (EKS has no rapid/regular/stable channels; the control plane is upgraded only when
// `version` asks). Authentication is through access entries only (`API`): no aws-auth ConfigMap.

const channels = ['rapid', 'regular', 'stable', 'extended'] as const;
const versionPattern = /^(\d+)\.(\d+)(?:\.(\d+))?$/;
const cidrPattern = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;
const subnetPattern = /^subnet-[0-9a-f]{8,17}$/;
const vpcPattern = /^vpc-[0-9a-f]{8,17}$/;

/** Tags better-compute keeps on its clusters besides the spec's labels. */
export const clusterTags = {
  managed: managedTags.managed,
  privateNodes: 'better-compute:private-nodes',
  description: 'better-compute:description',
} as const;

/** EKS takes a minor version: `1.33` and `1.33.4` both mean [1, 33]. */
export function minorOf(value: string): [number, number] | undefined {
  const match = versionPattern.exec(value);
  return match ? [Number(match[1]), Number(match[2])] : undefined;
}

/** desired minus actual, by minor: 0 when the cluster runs the minor asked for. */
export function compareMinor(desired: string, actual: string): number {
  const want = minorOf(desired);
  const have = minorOf(actual);
  if (!want || !have) return 0;
  return want[0] - have[0] || want[1] - have[1];
}

function checkCidr(value: unknown): string {
  const match = typeof value === 'string' ? cidrPattern.exec(value) : null;
  if (!match || match.slice(1, 5).some((octet) => Number(octet) > 255) || Number(match[5]) > 32)
    throw invalid(`${JSON.stringify(value)} is not an IPv4 CIDR block`);
  return value as string;
}

/** The subnets a `network.subnet` names: one subnet id, or several separated by commas. */
export function subnetsOf(text: string): string[] {
  const subnets = [...new Set(text.split(',').map((part) => part.trim()))];
  for (const subnet of subnets)
    if (!subnetPattern.test(subnet)) throw invalid(`${JSON.stringify(subnet)} is not a subnet id`);
  return subnets;
}

/** Validates a cluster spec; `region` is the account's (EKS clusters are regional). */
export function checkClusterSpec(spec: KubernetesClusterSpec, region: string, forCreate: boolean): void {
  checkName(spec.name, 'The cluster name');
  if (spec.location !== region)
    throw invalid(
      `EKS clusters are regional and this account is ${region}: the location must be ${region}, not ${JSON.stringify(spec.location)}`,
    );
  if (spec.mode !== 'standard' && spec.mode !== 'autopilot')
    throw invalid(`The cluster mode ${JSON.stringify(spec.mode)} is not standard or autopilot`);
  if (!channels.includes(spec.releaseChannel))
    throw invalid(
      `The release channel ${JSON.stringify(spec.releaseChannel)} is not one of ${channels.join(', ')}`,
    );
  if (spec.version !== undefined && !minorOf(spec.version))
    throw invalid(`${JSON.stringify(spec.version)} is not an EKS version (1.33)`);
  if (!Array.isArray(spec.authorizedNetworks))
    throw invalid('authorizedNetworks must be a list of CIDR blocks');
  if (spec.authorizedNetworks.length > 40)
    throw invalid('EKS takes at most 40 authorized networks (publicAccessCidrs)');
  spec.authorizedNetworks.forEach(checkCidr);
  if (spec.network) {
    if (!vpcPattern.test(spec.network.network))
      throw invalid(`${JSON.stringify(spec.network.network)} is not a VPC id`);
    if (spec.network.subnet !== undefined) subnetsOf(spec.network.subnet);
  }
  if (!forCreate) return;
  const pools = spec.initialNodePools ?? [];
  if (spec.mode === 'standard') {
    const names = new Set<string>();
    for (const pool of pools) {
      checkNodePoolSpec(pool);
      if (names.has(pool.name)) throw invalid(`Node pool ${pool.name} is listed twice`);
      names.add(pool.name);
    }
  } else if (pools.length > 0)
    throw invalid('An autopilot (EKS Auto Mode) cluster has no node pools: EKS runs its nodes');
}

/** The cluster's tags: the spec's labels (as AWS tag values), the managed tag, private nodes. */
export function clusterTagsOf(spec: KubernetesClusterSpec): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(spec.labels ?? {})) {
    const tagKey = Array.from(key.replace(/[^\p{L}\p{N} _.:/=+\-@]/gu, '')).slice(0, 128).join('');
    if (tagKey && !tagKey.toLowerCase().startsWith('aws:')) out[tagKey] = tagValue(value);
  }
  out[clusterTags.managed] = 'true';
  out[clusterTags.privateNodes] = spec.privateNodes === true ? 'true' : 'false';
  if (spec.description) out[clusterTags.description] = tagValue(spec.description);
  return out;
}

const publicCidrsOf = (spec: KubernetesClusterSpec): string[] =>
  spec.authorizedNetworks.length ? [...spec.authorizedNetworks] : ['0.0.0.0/0'];

/** The body of `CreateCluster`. */
export function clusterBody(
  spec: KubernetesClusterSpec,
  options: {
    roleArn: string;
    subnetIds: readonly string[];
    securityGroupIds?: readonly string[];
    nodeRoleArn?: string;
    clientRequestToken: string;
  },
): Record<string, unknown> {
  const autoMode = spec.mode === 'autopilot';
  return {
    name: spec.name,
    ...(spec.version !== undefined ? { version: minorOf(spec.version)!.join('.') } : {}),
    roleArn: options.roleArn,
    resourcesVpcConfig: {
      subnetIds: [...options.subnetIds],
      ...(options.securityGroupIds?.length
        ? { securityGroupIds: [...options.securityGroupIds] }
        : {}),
      endpointPublicAccess: true,
      endpointPrivateAccess: true,
      publicAccessCidrs: publicCidrsOf(spec),
    },
    // Access entries only, and the creator (this account's principal) as cluster admin: the driver
    // mints per-subject credentials through it. No aws-auth ConfigMap is ever read or written.
    accessConfig: { authenticationMode: 'API', bootstrapClusterCreatorAdminPermissions: true },
    upgradePolicy: { supportType: spec.releaseChannel === 'extended' ? 'EXTENDED' : 'STANDARD' },
    ...(autoMode
      ? {
          computeConfig: {
            enabled: true,
            nodePools: ['general-purpose', 'system'],
            nodeRoleArn: options.nodeRoleArn,
          },
          kubernetesNetworkConfig: { elasticLoadBalancing: { enabled: true } },
          storageConfig: { blockStorage: { enabled: true } },
          bootstrapSelfManagedAddons: false,
        }
      : {}),
    tags: clusterTagsOf(spec),
    clientRequestToken: options.clientRequestToken,
  };
}

/** The ready outputs of a cluster (plain values, never secrets). */
function outputsOf(cluster: EksCluster, region: string): Record<string, string> {
  if (!cluster.endpoint) return {};
  return {
    endpoint: cluster.endpoint,
    location: region,
    ...(cluster.version ? { version: cluster.version, nodeVersion: cluster.version } : {}),
    ...(cluster.platformVersion ? { platformVersion: cluster.platformVersion } : {}),
    // The ARN is also the provider-global id: one cluster reached through two accounts' credentials is one cluster.
    ...(cluster.arn ? { arn: cluster.arn, globalId: cluster.arn } : {}),
  };
}

/** A cluster's state as its status says. */
export function clusterState(id: string, region: string, cluster: EksCluster): ProviderResourceState {
  const outputs = outputsOf(cluster, region);
  switch (cluster.status) {
    case 'ACTIVE':
      return resourceState(id, 'ready', { outputs });
    case 'UPDATING':
      return resourceState(id, 'updating', { outputs });
    case 'DELETING':
      return resourceState(id, 'deleting');
    case 'FAILED':
      return resourceState(id, 'error', {
        outputs,
        message: issueMessage(cluster.health) ?? `Cluster ${cluster.name} failed`,
      });
    default: // CREATING, PENDING
      return resourceState(id, 'pending');
  }
}

function immutable(id: string, what: string, actual: unknown, desired: unknown): ComputeError {
  return new ComputeError(
    'INVALID_STATE',
    `Cluster ${id} exists with ${what} ${JSON.stringify(actual)}, not ${JSON.stringify(desired)}; ` +
      'that cannot change in place (create a new cluster)',
    undefined,
    { provider: 'aws', service: 'eks', reason: 'immutable', field: what },
  );
}

const sorted = (values: readonly string[]): string[] => [...values].sort();

/** Refuses a difference that cannot change in place: mode, VPC, subnets, private nodes. */
export function checkImmutable(id: string, spec: KubernetesClusterSpec, cluster: EksCluster): void {
  const mode = cluster.computeConfig?.enabled === true ? 'autopilot' : 'standard';
  if (mode !== spec.mode) throw immutable(id, 'mode', mode, spec.mode);
  const vpc = cluster.resourcesVpcConfig?.vpcId;
  if (spec.network && vpc && vpc !== spec.network.network)
    throw immutable(id, 'network', vpc, spec.network.network);
  if (spec.network?.subnet !== undefined && cluster.resourcesVpcConfig?.subnetIds) {
    const want = sorted(subnetsOf(spec.network.subnet));
    const have = sorted(cluster.resourcesVpcConfig.subnetIds);
    if (JSON.stringify(want) !== JSON.stringify(have)) throw immutable(id, 'subnet', have, want);
  }
  const recorded = cluster.tags?.[clusterTags.privateNodes];
  if (recorded !== undefined && (recorded === 'true') !== (spec.privateNodes === true))
    throw immutable(id, 'privateNodes', recorded === 'true', spec.privateNodes === true);
}

/** One in-place change, as the EKS call that makes it. */
export type ClusterChange =
  | { kind: 'version'; body: { version: string } }
  | { kind: 'config'; body: Record<string, unknown> };

/**
 * The one in-place change an ACTIVE cluster needs next, or undefined when it is as wanted. EKS
 * runs one update at a time: the support policy, then the control-plane version (one minor per
 * update, as EKS upgrades), then the public access CIDRs. A version older than the running one is
 * INVALID_STATE (EKS never downgrades a control plane).
 */
export function nextClusterChange(
  id: string,
  spec: KubernetesClusterSpec,
  cluster: EksCluster,
): ClusterChange | undefined {
  const supportType = spec.releaseChannel === 'extended' ? 'EXTENDED' : 'STANDARD';
  if ((cluster.upgradePolicy?.supportType ?? 'STANDARD') !== supportType)
    return { kind: 'config', body: { upgradePolicy: { supportType } } };
  if (spec.version !== undefined && cluster.version) {
    const difference = compareMinor(spec.version, cluster.version);
    if (difference < 0)
      throw new ComputeError(
        'INVALID_STATE',
        `Cluster ${id} runs ${cluster.version}: ${spec.version} would be a downgrade, which EKS does not do`,
        undefined,
        { provider: 'aws', service: 'eks', reason: 'downgrade' },
      );
    if (difference > 0) {
      const [major, minor] = minorOf(cluster.version)!;
      const want = minorOf(spec.version)!;
      // EKS moves one minor at a time; a jump of several takes several updates.
      const next = want[0] === major ? `${major}.${minor + 1}` : want.join('.');
      return { kind: 'version', body: { version: next } };
    }
  }
  const actual = sorted(cluster.resourcesVpcConfig?.publicAccessCidrs ?? ['0.0.0.0/0']);
  const desired = sorted(publicCidrsOf(spec));
  if (JSON.stringify(actual) !== JSON.stringify(desired))
    return {
      kind: 'config',
      body: {
        resourcesVpcConfig: {
          endpointPublicAccess: true,
          endpointPrivateAccess: true,
          publicAccessCidrs: desired,
        },
      },
    };
  return undefined;
}
