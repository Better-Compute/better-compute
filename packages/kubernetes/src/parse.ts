import { strictObject, type InputSchema } from '@better-compute/core';
import { bool, fail, id, int, key, object, optional, tenant } from './input.js';
import type {
  ClusterRef,
  CreateClusterInput,
  CreateNodePoolInput,
  CredentialsInput,
  KubernetesMode,
  KubernetesRole,
  KubernetesTaint,
  ListClustersInput,
  NodePoolInput,
  NodePoolRef,
  UpdateClusterInput,
  UpdateNodePoolInput,
  VersionsInput,
} from './types.js';

// Input parsing and the JSON Schemas the generated reference shows, for both groups.

/** At most this many node pools in `kubernetesClusters.create`, and live node pools per cluster. */
export const maxNodePoolsPerCluster = 10;
/** At most this many `authorizedNetworks`. */
export const maxAuthorizedNetworks = 50;
/** Credential lifetimes: the TokenRequest API's floor, and a day. */
export const minCredentialTtlSeconds = 600;
export const maxCredentialTtlSeconds = 86_400;

export const modes = ['standard', 'autopilot'] as const;
export const releaseChannels = ['rapid', 'regular', 'stable', 'extended'] as const;
export const roles = ['view', 'edit', 'admin'] as const;
const taintEffects = ['NoSchedule', 'PreferNoSchedule', 'NoExecute'] as const;

/** Cluster and node pool names: GKE's rule (1-40 lower-case letters, digits and '-', a letter first). */
const resourceName = /^[a-z]([-a-z0-9]{0,38}[a-z0-9])?$/;
/** A zone (`us-central1-a`) or a region (`us-central1`). */
const locationName = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;
const versionPattern = /^[0-9]{1,3}\.[0-9]{1,3}(\.[0-9]{1,3})?(-[a-z0-9.]{1,40})?$/;
export const machineTypePattern = /^[a-z0-9][a-z0-9-]{0,62}$/;
const diskTypePattern = /^[a-z][a-z0-9-]{1,40}$/;
export const acceleratorPattern = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** A Kubernetes label key: an optional DNS-subdomain prefix and `/`, then a name of at most 63 characters. */
const labelKeyPattern =
  /^([a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?\/)?[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/;
const labelValuePattern = /^([A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?)?$/;
const maxLabels = 32;
const maxTaints = 32;
const maxZones = 10;

export function resource(value: unknown, what = 'name'): string {
  if (typeof value !== 'string' || !resourceName.test(value))
    fail(
      `${what} must be 1-40 lower-case letters, digits or '-', start with a letter and not end with '-'`,
    );
  return value;
}

export function location(value: unknown, what = 'location'): string {
  if (typeof value !== 'string' || !locationName.test(value))
    fail(`${what} must be a region (us-central1) or a zone (us-central1-a)`);
  return value;
}

function description(value: unknown): string {
  if (typeof value !== 'string' || value.length > 256 || /[\u0000-\u001f]/.test(value))
    return fail('description must be text of at most 256 characters');
  return value;
}

export function oneOf<T extends string>(value: unknown, options: readonly T[], what: string): T {
  if (typeof value !== 'string' || !(options as readonly string[]).includes(value))
    fail(`${what} must be one of ${options.join(', ')}`);
  return value as T;
}

export function kubernetesVersion(value: unknown): string {
  if (typeof value !== 'string' || !versionPattern.test(value))
    fail('version must be a Kubernetes version such as 1.33 or 1.33.2-gke.1000');
  return value;
}

/** `a.b.c.d/n` with the host bits zero. */
export function ipv4Cidr(value: unknown, what: string): string {
  const match =
    typeof value === 'string'
      ? /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(value)
      : null;
  if (!match) return fail(`${what} must be an IPv4 CIDR such as 203.0.113.0/24`);
  const octets = match.slice(1, 5).map(Number);
  const prefix = Number(match[5]);
  if (octets.some((octet) => octet > 255) || prefix > 32)
    return fail(`${what} must be an IPv4 CIDR such as 203.0.113.0/24`);
  const address = ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  if ((address & ~mask) >>> 0 !== 0)
    return fail(`${what} has host bits set: write it as its network address`);
  return value as string;
}

export function authorizedNetworks(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > maxAuthorizedNetworks)
    return fail(`authorizedNetworks must list at most ${maxAuthorizedNetworks} IPv4 CIDRs`);
  return [...new Set(value.map((entry, index) => ipv4Cidr(entry, `authorizedNetworks[${index}]`)))];
}

export function autoscaling(value: unknown, what: string): { minNodes: number; maxNodes: number } {
  const input = object(value, ['minNodes', 'maxNodes']);
  const minNodes = int(input.minNodes, `${what}.minNodes`, 0, 1000);
  const maxNodes = int(input.maxNodes, `${what}.maxNodes`, 1, 1000);
  if (minNodes > maxNodes) fail(`${what}.minNodes must not exceed ${what}.maxNodes`);
  return { minNodes, maxNodes };
}

function labels(value: unknown, what: string): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return fail(`${what} must be an object of label keys to values`);
  const entries = Object.entries(value);
  if (entries.length > maxLabels) fail(`${what} has at most ${maxLabels} labels`);
  for (const [labelKey, labelValue] of entries) {
    if (labelKey.length > 317 || !labelKeyPattern.test(labelKey))
      fail(`${what}: ${JSON.stringify(labelKey)} is not a Kubernetes label key`);
    if (typeof labelValue !== 'string' || !labelValuePattern.test(labelValue))
      fail(`${what}.${labelKey} must be a Kubernetes label value (at most 63 characters)`);
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function taints(value: unknown, what: string): KubernetesTaint[] {
  if (!Array.isArray(value) || value.length > maxTaints)
    return fail(`${what} must list at most ${maxTaints} taints`);
  return value.map((entry, index) => {
    const item = object(entry, ['key', 'value', 'effect']);
    if (typeof item.key !== 'string' || item.key.length > 317 || !labelKeyPattern.test(item.key))
      fail(`${what}[${index}].key must be a Kubernetes label key`);
    const taint: KubernetesTaint = {
      key: item.key as string,
      effect: oneOf(item.effect, taintEffects, `${what}[${index}].effect`),
    };
    if (item.value !== undefined) {
      if (typeof item.value !== 'string' || !labelValuePattern.test(item.value))
        fail(`${what}[${index}].value must be a Kubernetes label value`);
      taint.value = item.value as string;
    }
    return taint;
  });
}

export function zones(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || value.length > maxZones)
    return fail(`${what} must list at most ${maxZones} zones`);
  return [...new Set(value.map((entry, index) => location(entry, `${what}[${index}]`)))];
}

const nodePoolFields = [
  'name',
  'machineType',
  'nodeCount',
  'autoscaling',
  'diskGiB',
  'diskType',
  'spot',
  'accelerators',
  'zones',
  'labels',
  'taints',
];

/** The node pool fields of `input` (prefix `what` names them in messages). */
function nodePoolOf(input: Record<string, unknown>, what: string): NodePoolInput {
  const field = (name: string) => (what ? `${what}.${name}` : name);
  if (typeof input.machineType !== 'string' || !machineTypePattern.test(input.machineType))
    fail(`${field('machineType')} must be a provider machine type such as e2-standard-4`);
  const pool: NodePoolInput = {
    name: resource(input.name, field('name')),
    machineType: input.machineType as string,
    nodeCount: int(input.nodeCount, field('nodeCount'), 0, 1000),
  };
  if (input.autoscaling !== undefined)
    pool.autoscaling = autoscaling(input.autoscaling, field('autoscaling'));
  if (input.diskGiB !== undefined) pool.diskGiB = int(input.diskGiB, field('diskGiB'), 10, 65_536);
  if (input.diskType !== undefined) {
    if (typeof input.diskType !== 'string' || !diskTypePattern.test(input.diskType))
      fail(`${field('diskType')} must be a provider disk type such as pd-balanced`);
    pool.diskType = input.diskType as string;
  }
  if (input.spot !== undefined) pool.spot = bool(input.spot, field('spot'));
  if (input.accelerators !== undefined) {
    const accelerators = object(input.accelerators, ['type', 'count']);
    if (typeof accelerators.type !== 'string' || !acceleratorPattern.test(accelerators.type))
      fail(`${field('accelerators.type')} must be a provider accelerator type such as nvidia-l4`);
    pool.accelerators = {
      type: accelerators.type as string,
      count: int(accelerators.count, field('accelerators.count'), 1, 16),
    };
  }
  if (input.zones !== undefined) {
    const list = zones(input.zones, field('zones'));
    if (list.length > 0) pool.zones = list;
  }
  if (input.labels !== undefined) {
    const map = labels(input.labels, field('labels'));
    if (Object.keys(map).length > 0) pool.labels = map;
  }
  if (input.taints !== undefined) {
    const list = taints(input.taints, field('taints'));
    if (list.length > 0) pool.taints = list;
  }
  return pool;
}

export function parseCreateCluster(raw: unknown): CreateClusterInput {
  const input = object(raw, [
    'tenantId',
    'projectId',
    'poolId',
    'name',
    'mode',
    'location',
    'releaseChannel',
    'version',
    'networkId',
    'authorizedNetworks',
    'privateNodes',
    'description',
    'nodePools',
    'idempotencyKey',
  ]);
  const mode: KubernetesMode = oneOf(input.mode, modes, 'mode');
  const out: CreateClusterInput = {
    tenantId: tenant(input.tenantId),
    poolId: id(input.poolId, 'pool', 'poolId'),
    name: resource(input.name),
    mode,
    location: location(input.location),
    releaseChannel:
      input.releaseChannel === undefined
        ? 'regular'
        : oneOf(input.releaseChannel, releaseChannels, 'releaseChannel'),
    authorizedNetworks:
      input.authorizedNetworks === undefined ? [] : authorizedNetworks(input.authorizedNetworks),
    privateNodes:
      input.privateNodes === undefined ? false : bool(input.privateNodes, 'privateNodes'),
    nodePools: [],
    idempotencyKey: key(input.idempotencyKey),
  };
  const projectId = optional(input.projectId, (value) => id(value, 'prj', 'projectId'));
  if (projectId !== undefined) out.projectId = projectId;
  const version = optional(input.version, kubernetesVersion);
  if (version !== undefined) out.version = version;
  const networkId = optional(input.networkId, (value) => id(value, 'net', 'networkId'));
  if (networkId !== undefined) out.networkId = networkId;
  const text = optional(input.description, description);
  if (text !== undefined) out.description = text;
  if (input.nodePools !== undefined) {
    if (!Array.isArray(input.nodePools)) fail('nodePools must be a list of node pools');
    out.nodePools = input.nodePools.map((entry, index) =>
      nodePoolOf(object(entry, nodePoolFields), `nodePools[${index}]`),
    );
  }
  if (mode === 'autopilot' && out.nodePools.length > 0)
    fail('An autopilot cluster takes no nodePools: the provider runs its nodes');
  if (mode === 'standard' && out.nodePools.length === 0)
    fail('A standard cluster needs at least one node pool in nodePools');
  if (out.nodePools.length > maxNodePoolsPerCluster)
    fail(`nodePools lists at most ${maxNodePoolsPerCluster} node pools`);
  const names = new Set<string>();
  for (const pool of out.nodePools) {
    if (names.has(pool.name)) fail(`nodePools names ${pool.name} twice`);
    names.add(pool.name);
  }
  return out;
}

export function parseClusterRef(raw: unknown): ClusterRef {
  const input = object(raw, ['tenantId', 'clusterId']);
  return { tenantId: tenant(input.tenantId), clusterId: id(input.clusterId, 'kcl', 'clusterId') };
}

export function parseListClusters(raw: unknown): ListClustersInput {
  const input = object(raw, ['tenantId', 'poolId', 'projectId', 'includeDeleted']);
  const out: ListClustersInput = { tenantId: tenant(input.tenantId) };
  const poolId = optional(input.poolId, (value) => id(value, 'pool', 'poolId'));
  if (poolId !== undefined) out.poolId = poolId;
  const projectId = optional(input.projectId, (value) => id(value, 'prj', 'projectId'));
  if (projectId !== undefined) out.projectId = projectId;
  if (input.includeDeleted !== undefined)
    out.includeDeleted = bool(input.includeDeleted, 'includeDeleted');
  return out;
}

export function parseUpdateCluster(raw: unknown): UpdateClusterInput {
  const input = object(raw, [
    'tenantId',
    'clusterId',
    'version',
    'releaseChannel',
    'authorizedNetworks',
    'description',
  ]);
  const out: UpdateClusterInput = {
    tenantId: tenant(input.tenantId),
    clusterId: id(input.clusterId, 'kcl', 'clusterId'),
  };
  if (input.version !== undefined) out.version = kubernetesVersion(input.version);
  if (input.releaseChannel !== undefined)
    out.releaseChannel = oneOf(input.releaseChannel, releaseChannels, 'releaseChannel');
  if (input.authorizedNetworks !== undefined)
    out.authorizedNetworks = authorizedNetworks(input.authorizedNetworks);
  if (input.description !== undefined) out.description = description(input.description);
  if (Object.keys(out).length === 2)
    fail('Name what to change: version, releaseChannel, authorizedNetworks or description');
  return out;
}

export function parseCredentials(raw: unknown): CredentialsInput {
  const input = object(raw, ['tenantId', 'clusterId', 'role', 'ttlSeconds']);
  const out: CredentialsInput = {
    tenantId: tenant(input.tenantId),
    clusterId: id(input.clusterId, 'kcl', 'clusterId'),
    role: input.role === undefined ? 'view' : oneOf<KubernetesRole>(input.role, roles, 'role'),
  };
  if (input.ttlSeconds !== undefined)
    out.ttlSeconds = int(
      input.ttlSeconds,
      'ttlSeconds',
      minCredentialTtlSeconds,
      maxCredentialTtlSeconds,
    );
  return out;
}

export function parseVersions(raw: unknown): VersionsInput {
  const input = object(raw, ['tenantId', 'poolId', 'location']);
  return {
    tenantId: tenant(input.tenantId),
    poolId: id(input.poolId, 'pool', 'poolId'),
    location: location(input.location),
  };
}

export function parseCreateNodePool(raw: unknown): CreateNodePoolInput {
  const input = object(raw, ['tenantId', 'clusterId', 'idempotencyKey', ...nodePoolFields]);
  const out: CreateNodePoolInput = {
    tenantId: tenant(input.tenantId),
    clusterId: id(input.clusterId, 'kcl', 'clusterId'),
    ...nodePoolOf(input, ''),
  };
  const idempotencyKey = optional(input.idempotencyKey, (value) => key(value));
  if (idempotencyKey !== undefined) out.idempotencyKey = idempotencyKey;
  return out;
}

export function parseNodePoolRef(raw: unknown): NodePoolRef {
  const input = object(raw, ['tenantId', 'clusterId', 'nodePoolId']);
  return {
    tenantId: tenant(input.tenantId),
    clusterId: id(input.clusterId, 'kcl', 'clusterId'),
    nodePoolId: id(input.nodePoolId, 'knp', 'nodePoolId'),
  };
}

export function parseUpdateNodePool(raw: unknown): UpdateNodePoolInput {
  const input = object(raw, ['tenantId', 'clusterId', 'nodePoolId', 'nodeCount', 'autoscaling']);
  const out: UpdateNodePoolInput = {
    tenantId: tenant(input.tenantId),
    clusterId: id(input.clusterId, 'kcl', 'clusterId'),
    nodePoolId: id(input.nodePoolId, 'knp', 'nodePoolId'),
  };
  if (input.nodeCount !== undefined) out.nodeCount = int(input.nodeCount, 'nodeCount', 0, 1000);
  if (input.autoscaling !== undefined)
    out.autoscaling =
      input.autoscaling === null ? null : autoscaling(input.autoscaling, 'autoscaling');
  if (out.nodeCount === undefined && out.autoscaling === undefined)
    fail('Name what to change: nodeCount or autoscaling');
  return out;
}

// --- JSON Schemas ------------------------------------------------------------------------------

const idOf = (prefix: string, text: string): InputSchema => ({
  type: 'string',
  pattern: `^${prefix}_[0-9a-hjkmnp-tv-z]{26,52}$`,
  maxLength: prefix.length + 53,
  description: text,
});
const tenantIdSchema: InputSchema = {
  type: 'string',
  pattern: '^[A-Za-z0-9._:-]{1,128}$',
  maxLength: 128,
  description: 'The tenant the call acts in',
};
const clusterIdSchema = idOf('kcl', 'The cluster');
const nameSchema = (text: string): InputSchema => ({
  type: 'string',
  pattern: resourceName.source,
  maxLength: 40,
  description: text,
});
const locationSchema = (text: string): InputSchema => ({
  type: 'string',
  pattern: locationName.source,
  maxLength: 40,
  description: text,
});
const versionSchema: InputSchema = {
  type: 'string',
  pattern: versionPattern.source,
  maxLength: 64,
  description: 'A Kubernetes minor (1.33) or full version; the provider must offer it',
};
const authorizedNetworksSchema: InputSchema = {
  type: 'array',
  maxItems: maxAuthorizedNetworks,
  items: { type: 'string', description: 'An IPv4 CIDR, e.g. 203.0.113.0/24' },
  description:
    'CIDRs that may reach the control-plane endpoint; empty: any address (requests are still authenticated)',
};
const autoscalingSchema = (nullable: boolean): InputSchema => ({
  ...strictObject(
    {
      minNodes: {
        type: 'integer',
        minimum: 0,
        maximum: 1000,
        description: 'Fewest nodes per zone',
      },
      maxNodes: { type: 'integer', minimum: 1, maximum: 1000, description: 'Most nodes per zone' },
    },
    ['minNodes', 'maxNodes'],
  ),
  ...(nullable ? { type: ['object', 'null'] } : {}),
  description: nullable
    ? 'Autoscaling bounds per zone; null turns autoscaling off'
    : 'Autoscaling bounds per zone; nodeCount is then the initial count',
});
const nodePoolProperties: Record<string, InputSchema> = {
  name: nameSchema('The node pool name, unique in the cluster, e.g. gpu'),
  machineType: {
    type: 'string',
    pattern: machineTypePattern.source,
    maxLength: 63,
    description: 'The provider machine type, e.g. e2-standard-4 or g2-standard-8',
  },
  nodeCount: {
    type: 'integer',
    minimum: 0,
    maximum: 1000,
    description: 'Nodes per zone of the pool; with autoscaling, the initial count',
  },
  autoscaling: autoscalingSchema(false),
  diskGiB: {
    type: 'integer',
    minimum: 10,
    maximum: 65_536,
    description: 'Boot disk size per node',
  },
  diskType: {
    type: 'string',
    pattern: diskTypePattern.source,
    description: 'The provider boot disk type, e.g. pd-balanced',
  },
  spot: { type: 'boolean', default: false, description: 'Spot (preemptible) nodes' },
  accelerators: strictObject(
    {
      type: {
        type: 'string',
        pattern: acceleratorPattern.source,
        description: 'The provider accelerator type, e.g. nvidia-l4',
      },
      count: { type: 'integer', minimum: 1, maximum: 16, description: 'GPUs per node' },
    },
    ['type', 'count'],
  ),
  zones: {
    type: 'array',
    maxItems: maxZones,
    items: { type: 'string', description: 'A zone of the cluster’s region' },
    description: 'Zones of the cluster’s region the pool runs in; absent: the provider’s default',
  },
  labels: {
    type: 'object',
    additionalProperties: { type: 'string', maxLength: 63 },
    description: 'Kubernetes labels of the pool’s nodes (at most 32)',
  },
  taints: {
    type: 'array',
    maxItems: maxTaints,
    items: strictObject(
      {
        key: { type: 'string', description: 'A Kubernetes label key' },
        value: { type: 'string', maxLength: 63, description: 'A Kubernetes label value' },
        effect: { enum: [...taintEffects], description: 'The taint effect' },
      },
      ['key', 'effect'],
    ),
    description: 'Kubernetes taints of the pool’s nodes',
  },
};
const nodePoolRequired = ['name', 'machineType', 'nodeCount'];

export const kubernetesSchemas = {
  createCluster: strictObject(
    {
      tenantId: tenantIdSchema,
      projectId: idOf('prj', 'The project the cluster belongs to'),
      poolId: idOf(
        'pool',
        'A provider pool owned by or offered to the tenant, whose account provides managed Kubernetes',
      ),
      name: nameSchema('The cluster name, unique in the tenant, e.g. training'),
      mode: {
        enum: [...modes],
        description:
          'standard: node pools you manage; autopilot: the provider runs the nodes (no node pools)',
      },
      location: locationSchema(
        'A region (regional cluster) or a zone (zonal cluster) of the account’s configured zones',
      ),
      releaseChannel: {
        enum: [...releaseChannels],
        default: 'regular',
        description: 'The provider release channel; it upgrades the cluster within the channel',
      },
      version: versionSchema,
      networkId: idOf(
        'net',
        'A tenant network on the same pool’s account, with a subnet in the cluster’s region',
      ),
      authorizedNetworks: authorizedNetworksSchema,
      privateNodes: {
        type: 'boolean',
        default: false,
        description: 'Nodes get no public addresses (egress then needs a NAT on the network)',
      },
      description: { type: 'string', maxLength: 256, description: 'What the cluster is for' },
      nodePools: {
        type: 'array',
        maxItems: maxNodePoolsPerCluster,
        items: strictObject(nodePoolProperties, nodePoolRequired),
        description: 'standard: 1 to 10 node pools created with the cluster; autopilot: none',
      },
      idempotencyKey: {
        type: 'string',
        pattern: '^[A-Za-z0-9._:-]{1,128}$',
        maxLength: 128,
        description: 'Scoped to (tenant, caller identity): a retry with the same key replays',
      },
    },
    ['tenantId', 'poolId', 'name', 'mode', 'location', 'idempotencyKey'],
  ),
  listClusters: strictObject(
    {
      tenantId: tenantIdSchema,
      poolId: idOf('pool', 'Only this pool’s clusters'),
      projectId: idOf('prj', 'Only this project’s clusters'),
      includeDeleted: { type: 'boolean', default: false, description: 'Include deleted clusters' },
    },
    ['tenantId'],
  ),
  cluster: strictObject({ tenantId: tenantIdSchema, clusterId: clusterIdSchema }, [
    'tenantId',
    'clusterId',
  ]),
  updateCluster: strictObject(
    {
      tenantId: tenantIdSchema,
      clusterId: clusterIdSchema,
      version: versionSchema,
      releaseChannel: { enum: [...releaseChannels], description: 'The new release channel' },
      authorizedNetworks: authorizedNetworksSchema,
      description: { type: 'string', maxLength: 256, description: 'The new description' },
    },
    ['tenantId', 'clusterId'],
  ),
  credentials: strictObject(
    {
      tenantId: tenantIdSchema,
      clusterId: clusterIdSchema,
      role: {
        enum: [...roles],
        default: 'view',
        description:
          'The Kubernetes role of the credential: view (kubernetes:connect), edit (also kubernetes:update), admin (also kubernetes:delete)',
      },
      ttlSeconds: {
        type: 'integer',
        minimum: minCredentialTtlSeconds,
        maximum: maxCredentialTtlSeconds,
        description: 'How long the token lasts; default 3600 (the module option)',
      },
    },
    ['tenantId', 'clusterId'],
  ),
  versions: strictObject(
    {
      tenantId: tenantIdSchema,
      poolId: idOf('pool', 'A provider pool visible to the tenant'),
      location: locationSchema('A region or zone of the pool account’s configured zones'),
    },
    ['tenantId', 'poolId', 'location'],
  ),
  createNodePool: strictObject(
    {
      tenantId: tenantIdSchema,
      clusterId: clusterIdSchema,
      ...nodePoolProperties,
      idempotencyKey: {
        type: 'string',
        pattern: '^[A-Za-z0-9._:-]{1,128}$',
        maxLength: 128,
        description:
          'Optional, scoped to (tenant, caller identity, cluster): a retry with the same key replays',
      },
    },
    ['tenantId', 'clusterId', ...nodePoolRequired],
  ),
  nodePool: strictObject(
    {
      tenantId: tenantIdSchema,
      clusterId: clusterIdSchema,
      nodePoolId: idOf('knp', 'The node pool'),
    },
    ['tenantId', 'clusterId', 'nodePoolId'],
  ),
  updateNodePool: strictObject(
    {
      tenantId: tenantIdSchema,
      clusterId: clusterIdSchema,
      nodePoolId: idOf('knp', 'The node pool'),
      nodeCount: {
        type: 'integer',
        minimum: 0,
        maximum: 1000,
        description: 'Nodes per zone (with autoscaling: within its bounds)',
      },
      autoscaling: autoscalingSchema(true),
    },
    ['tenantId', 'clusterId', 'nodePoolId'],
  ),
} satisfies Record<string, InputSchema>;
