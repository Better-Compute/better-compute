import { ComputeError } from '@better-compute/core';

/**
 * FleetConfig v1 (PLAN.md §9.2 `fleet`, mirroring better-iam's `TenantConfig`): a tenant's platform
 * configuration as code. Everything is keyed by name; references (a pool's site, an offer's pool, a
 * flavor's pool) are names in the same document or objects fleet already manages. Secrets are refs
 * only (`secret://…`), never values.
 */
export interface FleetConfig {
  version: 1;
  sites?: FleetSite[];
  providerAccounts?: FleetProviderAccount[];
  pools?: FleetPool[];
  flavors?: FleetFlavor[];
  /** (v0.5, PLAN §3.7) The tenant's sandbox templates, by name. */
  sandboxTemplates?: FleetSandboxTemplate[];
  /**
   * (D25, `@better-compute/kubernetes`) The tenant's managed Kubernetes clusters, by name, with their
   * node pools. A pool substrate's cluster (`policy.substrate`) is the pool's, never listed here.
   */
  kubernetesClusters?: FleetKubernetesCluster[];
}

export type FleetKubernetesTaint = {
  key: string;
  value?: string;
  effect: 'NoSchedule' | 'PreferNoSchedule' | 'NoExecute';
};

/**
 * A node pool of a `standard` cluster. `nodeCount` and `autoscaling` change in place; every other
 * field is fixed once the node pool exists (a change is blocked: add a node pool under another name).
 */
export interface FleetKubernetesNodePool {
  /** Unique in its cluster; also the provider-side name. */
  name: string;
  machineType: string;
  /** Nodes per zone; with `autoscaling`, the initial count. */
  nodeCount: number;
  autoscaling?: { minNodes: number; maxNodes: number };
  diskGiB?: number;
  diskType?: string;
  spot?: boolean;
  accelerators?: { type: string; count: number };
  zones?: string[];
  labels?: Record<string, string>;
  taints?: FleetKubernetesTaint[];
}

/**
 * A managed Kubernetes cluster on a provider pool. `releaseChannel`, `version`, `authorizedNetworks`
 * and `description` change in place (`kubernetesClusters.update`); `pool`, `mode`, `location`,
 * `privateNodes`, `networkId` and `projectId` are fixed once created (a change is blocked).
 */
export interface FleetKubernetesCluster {
  /** Unique among the tenant's clusters; 1-40 lower-case letters, digits or '-'. */
  name: string;
  /** A pool name in this document, or the id (`pool_…`) of a pool offered to the tenant. */
  pool: string;
  /** Default `standard`. */
  mode?: 'standard' | 'autopilot';
  /** A region (regional cluster) or a zone (zonal cluster) of the pool's provider account. */
  location: string;
  /** Default `regular`. */
  releaseChannel?: 'rapid' | 'regular' | 'stable' | 'extended';
  /** A minor (`1.33`) or full version; absent: the channel's default (and never compared). */
  version?: string;
  /** A tenant network (`net_…`) the nodes use. */
  networkId?: string;
  projectId?: string;
  /** CIDRs that may reach the control plane; default none (any address, still authenticated). */
  authorizedNetworks?: string[];
  privateNodes?: boolean;
  description?: string;
  /**
   * `standard`: up to 10 node pools, at least one to create the cluster (a live one may have none
   * left). `autopilot`: none (the provider runs the nodes).
   */
  nodePools?: FleetKubernetesNodePool[];
}

/**
 * A sandbox template. `pool` and `runtime` are fixed once created (a change is blocked: create a
 * new template); the rest updates in place. Only the fields listed are compared, so defaults the
 * server filled in (TTL bounds) are not drift.
 */
export interface FleetSandboxTemplate {
  name: string;
  /** A pool name in this document, or the id (`pool_…`) of a pool offered to the tenant. */
  pool: string;
  /** A flavor name of that pool. */
  flavor: string;
  imageId: string;
  /** Must be the pool's runtime (default: the pool's). */
  runtime?: string;
  /** Cloud-init user data, or a `secret://<tenant>/<id>` ref to it. */
  userData?: string;
  defaultTtlSeconds?: number;
  maxTtlSeconds?: number;
  warm?: { min: number; max?: number };
  /** Environment variables as `secret://<tenant>/<id>` refs only (written to /etc/sandbox/env). */
  env?: Record<string, string>;
  /** What the sandbox's NICs may reach (default egress). */
  network?: 'egress' | 'private' | 'none';
  /**
   * (v1.1, agent memory) Persistent volumes every sandbox mounts, by volume name, in order. Fleet
   * never creates or deletes volumes (they hold data): they must exist (`sandboxVolumes.create`).
   */
  volumes?: { volume: string; mountPath: string; readOnly?: boolean }[];
}

export interface FleetSite {
  name: string;
  kind: 'shared' | 'dedicated' | 'custom';
  region: string;
  iamRegion?: string;
}

export interface FleetProviderAccount {
  name: string;
  provider: string;
  /** Provider configuration; secret fields hold `secret://` refs. */
  config: Record<string, unknown>;
}

export interface FleetOffer {
  /** The tenant the pool is offered to. */
  tenant: string;
  /** Per-resource maxima for that tenant, e.g. `{ gpu: 16 }`. */
  quota: Record<string, number>;
  includeDescendants?: boolean;
  priority?: number;
}

export interface FleetPool {
  name: string;
  /** A site name. */
  site: string;
  class: string;
  gpuModel?: string;
  sharing?: string;
  agent?: 'bcd' | 'none';
  policy?: Record<string, unknown>;
  /** The owner's own quota per resource (default: unlimited GPUs). */
  ownerQuota?: Record<string, number>;
  /** Provider pools: a provider account name. */
  providerAccount?: string;
  offers?: FleetOffer[];
}

export interface FleetFlavor {
  /** A pool name. */
  pool: string;
  name: string;
  vcpu: number;
  memoryGiB: number;
  diskGiB: number;
  gpus?: number;
  offerId?: string;
  /** (v1.1 §3.8) Where its guests live on the host; sandbox templates inherit it. */
  placement?: { numaAffine?: boolean; pinned?: boolean; hugepages?: '2Mi' | '1Gi' };
}

const namePattern = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const tenantPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const maxItems = 1000;

function fail(path: string, message: string): never {
  throw new ComputeError('INVALID_INPUT', `${path} ${message}`, undefined, { path });
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    fail(path, 'must be an object');
  return value as Record<string, unknown>;
}

function only(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  for (const key of Object.keys(value))
    if (!keys.includes(key)) fail(`${path}.${key}`, 'is not a known field');
}

function string(value: unknown, path: string, pattern?: RegExp): string {
  if (typeof value !== 'string' || !value || value.length > 256)
    fail(path, 'must be a non-empty string');
  if (pattern && !pattern.test(value)) fail(path, 'is not in the expected form');
  return value;
}

function int(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    fail(path, `must be an integer from ${min} to ${max}`);
  return value;
}

function quota(value: unknown, path: string): Record<string, number> {
  const map = record(value, path);
  const out: Record<string, number> = {};
  for (const [resource, max] of Object.entries(map)) {
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(resource))
      fail(`${path}.${resource}`, 'is not a resource name');
    out[resource] = int(max, `${path}.${resource}`, 0, Number.MAX_SAFE_INTEGER);
  }
  return out;
}

function list<T>(
  value: unknown,
  path: string,
  item: (entry: unknown, path: string) => T,
  key: (item: T) => string,
): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems)
    fail(path, `must be an array of at most ${maxItems} items`);
  const items = value.map((entry, index) => item(entry, `${path}[${index}]`));
  const seen = new Set<string>();
  for (const [index, entry] of items.entries()) {
    const name = key(entry);
    if (seen.has(name)) fail(`${path}[${index}]`, `repeats ${JSON.stringify(name)}`);
    seen.add(name);
  }
  return items;
}

// --- Kubernetes (the kubernetes module's own rules, so a document fails before it is planned) ------

/** Cluster and node pool names: GKE's rule (1-40 lower-case letters, digits and '-', a letter first). */
const kubernetesName = /^[a-z]([-a-z0-9]{0,38}[a-z0-9])?$/;
const kubernetesLocation = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;
const kubernetesVersion = /^[0-9]{1,3}\.[0-9]{1,3}(\.[0-9]{1,3})?(-[a-z0-9.]{1,40})?$/;
/**
 * Machine and accelerator types: GCE (`e2-standard-4`), DigitalOcean (`s-2vcpu-4gb`) and EC2
 * (`m5.large`). Deliberately the widest form any provider lane's kubernetes module takes, never
 * narrower: an exported document must always validate, and the module checks the call again.
 */
const machineType = /^[a-z0-9][a-z0-9.-]{0,62}$/;
const diskType = /^[a-z][a-z0-9-]{1,40}$/;
const labelKey =
  /^([a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?\/)?[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/;
const labelValue = /^([A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?)?$/;
const poolRef = /^(pool_[0-9a-z]{26,52}|[a-z0-9][a-z0-9._-]{0,62})$/;
const typedId = (prefix: string) => new RegExp(`^${prefix}_[0-9a-z]{26,52}$`);
const maxNodePools = 10;

function flag(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, 'must be true or false');
  return value as boolean;
}

function oneOf<const T extends string>(value: unknown, options: readonly T[], path: string): T {
  if (typeof value !== 'string' || !(options as readonly string[]).includes(value))
    fail(path, `must be ${options.slice(0, -1).join(', ')} or ${options.at(-1)}`);
  return value as T;
}

function strings(
  value: unknown,
  path: string,
  max: number,
  check: (item: unknown, at: string) => string,
) {
  if (!Array.isArray(value) || value.length > max) fail(path, `must list at most ${max} items`);
  return [...new Set((value as unknown[]).map((item, index) => check(item, `${path}[${index}]`)))];
}

function cidr(value: unknown, path: string): string {
  const match =
    typeof value === 'string'
      ? /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(value)
      : null;
  const octets = match?.slice(1, 5).map(Number) ?? [];
  const prefix = Number(match?.[5]);
  if (!match || octets.some((octet) => octet > 255) || prefix > 32)
    fail(path, 'must be an IPv4 CIDR such as 203.0.113.0/24');
  const address = ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  if ((address & ~mask) >>> 0 !== 0) fail(path, 'has host bits set: write its network address');
  return value as string;
}

function nodePool(raw: unknown, path: string): FleetKubernetesNodePool {
  const input = record(raw, path);
  only(
    input,
    [
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
    ],
    path,
  );
  const result: FleetKubernetesNodePool = {
    name: string(input.name, `${path}.name`, kubernetesName),
    machineType: string(input.machineType, `${path}.machineType`, machineType),
    nodeCount: int(input.nodeCount, `${path}.nodeCount`, 0, 1000),
  };
  if (input.autoscaling !== undefined) {
    const at = `${path}.autoscaling`;
    const scaling = record(input.autoscaling, at);
    only(scaling, ['minNodes', 'maxNodes'], at);
    const minNodes = int(scaling.minNodes, `${at}.minNodes`, 0, 1000);
    const maxNodes = int(scaling.maxNodes, `${at}.maxNodes`, 1, 1000);
    if (minNodes > maxNodes) fail(`${at}.minNodes`, 'must not exceed maxNodes');
    result.autoscaling = { minNodes, maxNodes };
  }
  if (input.diskGiB !== undefined)
    result.diskGiB = int(input.diskGiB, `${path}.diskGiB`, 10, 65_536);
  if (input.diskType !== undefined)
    result.diskType = string(input.diskType, `${path}.diskType`, diskType);
  if (input.spot !== undefined && flag(input.spot, `${path}.spot`)) result.spot = true;
  if (input.accelerators !== undefined) {
    const at = `${path}.accelerators`;
    const accelerators = record(input.accelerators, at);
    only(accelerators, ['type', 'count'], at);
    result.accelerators = {
      type: string(accelerators.type, `${at}.type`, machineType),
      count: int(accelerators.count, `${at}.count`, 1, 16),
    };
  }
  if (input.zones !== undefined) {
    const zones = strings(input.zones, `${path}.zones`, 10, (zone, at) =>
      string(zone, at, kubernetesLocation),
    );
    if (zones.length) result.zones = zones;
  }
  if (input.labels !== undefined) {
    const at = `${path}.labels`;
    const labels = record(input.labels, at);
    if (Object.keys(labels).length > 32) fail(at, 'has at most 32 labels');
    for (const [key, value] of Object.entries(labels)) {
      if (key.length > 317 || !labelKey.test(key))
        fail(`${at}.${key}`, 'is not a Kubernetes label key');
      if (typeof value !== 'string' || !labelValue.test(value))
        fail(`${at}.${key}`, 'must be a Kubernetes label value (at most 63 characters)');
    }
    if (Object.keys(labels).length) result.labels = { ...(labels as Record<string, string>) };
  }
  if (input.taints !== undefined) {
    const at = `${path}.taints`;
    if (!Array.isArray(input.taints) || input.taints.length > 32)
      fail(at, 'must list at most 32 taints');
    const taints = (input.taints as unknown[]).map((entry, index) => {
      const taintPath = `${at}[${index}]`;
      const taint = record(entry, taintPath);
      only(taint, ['key', 'value', 'effect'], taintPath);
      const item: FleetKubernetesTaint = {
        key: string(taint.key, `${taintPath}.key`, labelKey),
        effect: oneOf(
          taint.effect,
          ['NoSchedule', 'PreferNoSchedule', 'NoExecute'],
          `${taintPath}.effect`,
        ),
      };
      if (taint.value !== undefined) {
        if (typeof taint.value !== 'string' || !labelValue.test(taint.value))
          fail(`${taintPath}.value`, 'must be a Kubernetes label value');
        item.value = taint.value;
      }
      return {
        key: item.key,
        ...(item.value !== undefined ? { value: item.value } : {}),
        effect: item.effect,
      };
    });
    if (taints.length) result.taints = taints;
  }
  return result;
}

function kubernetesCluster(raw: unknown, path: string): FleetKubernetesCluster {
  const input = record(raw, path);
  only(
    input,
    [
      'name',
      'pool',
      'mode',
      'location',
      'releaseChannel',
      'version',
      'networkId',
      'projectId',
      'authorizedNetworks',
      'privateNodes',
      'description',
      'nodePools',
    ],
    path,
  );
  const result: FleetKubernetesCluster = {
    name: string(input.name, `${path}.name`, kubernetesName),
    pool: string(input.pool, `${path}.pool`, poolRef),
    location: string(input.location, `${path}.location`, kubernetesLocation),
  };
  if (input.mode !== undefined)
    result.mode = oneOf(input.mode, ['standard', 'autopilot'], `${path}.mode`);
  if (input.releaseChannel !== undefined)
    result.releaseChannel = oneOf(
      input.releaseChannel,
      ['rapid', 'regular', 'stable', 'extended'],
      `${path}.releaseChannel`,
    );
  if (input.version !== undefined)
    result.version = string(input.version, `${path}.version`, kubernetesVersion);
  if (input.description !== undefined) {
    if (
      typeof input.description !== 'string' ||
      input.description.length > 256 ||
      /[\u0000-\u001f]/.test(input.description)
    )
      fail(`${path}.description`, 'must be text of at most 256 characters');
    result.description = input.description;
  }
  if (input.authorizedNetworks !== undefined) {
    const networks = strings(input.authorizedNetworks, `${path}.authorizedNetworks`, 50, cidr);
    if (networks.length) result.authorizedNetworks = networks;
  }
  if (input.privateNodes !== undefined && flag(input.privateNodes, `${path}.privateNodes`))
    result.privateNodes = true;
  if (input.networkId !== undefined)
    result.networkId = string(input.networkId, `${path}.networkId`, typedId('net'));
  if (input.projectId !== undefined)
    result.projectId = string(input.projectId, `${path}.projectId`, typedId('prj'));
  const pools = list(input.nodePools, `${path}.nodePools`, nodePool, (pool) => pool.name);
  if (pools.length > maxNodePools)
    fail(`${path}.nodePools`, `lists at most ${maxNodePools} node pools`);
  // A standard cluster may run with no node pools (its last one deleted), so the document may say
  // so; only creating one takes at least one, which the plan checks (it knows what exists).
  if ((result.mode ?? 'standard') === 'standard') result.nodePools = pools;
  else if (pools.length)
    fail(
      `${path}.nodePools`,
      'must be empty for an autopilot cluster (the provider runs its nodes)',
    );
  return result;
}

/** Validates a FleetConfig document; rejects unknown fields, duplicates and dangling references. */
export function validateFleetConfig(value: unknown): FleetConfig {
  const input = record(value, 'config');
  only(
    input,
    [
      'version',
      'sites',
      'providerAccounts',
      'pools',
      'flavors',
      'sandboxTemplates',
      'kubernetesClusters',
    ],
    'config',
  );
  if (input.version !== 1) fail('config.version', 'must be 1');
  const sites = list(
    input.sites,
    'sites',
    (raw, path) => {
      const site = record(raw, path);
      only(site, ['name', 'kind', 'region', 'iamRegion'], path);
      if (!['shared', 'dedicated', 'custom'].includes(site.kind as string))
        fail(`${path}.kind`, 'must be shared, dedicated or custom');
      const result: FleetSite = {
        name: string(site.name, `${path}.name`, namePattern),
        kind: site.kind as FleetSite['kind'],
        region: string(site.region, `${path}.region`, /^[a-z0-9-]{1,64}$/),
      };
      if (site.iamRegion !== undefined)
        result.iamRegion = string(site.iamRegion, `${path}.iamRegion`, /^[a-z0-9-]{1,64}$/);
      return result;
    },
    (site) => site.name,
  );
  const providerAccounts = list(
    input.providerAccounts,
    'providerAccounts',
    (raw, path) => {
      const account = record(raw, path);
      only(account, ['name', 'provider', 'config'], path);
      return {
        name: string(account.name, `${path}.name`, namePattern),
        provider: string(account.provider, `${path}.provider`, /^[a-z][a-z0-9-]{0,63}$/),
        config: record(account.config ?? {}, `${path}.config`),
      };
    },
    (account) => account.name,
  );
  const pools = list(
    input.pools,
    'pools',
    (raw, path) => {
      const pool = record(raw, path);
      only(
        pool,
        [
          'name',
          'site',
          'class',
          'gpuModel',
          'sharing',
          'agent',
          'policy',
          'ownerQuota',
          'providerAccount',
          'offers',
        ],
        path,
      );
      const result: FleetPool = {
        name: string(pool.name, `${path}.name`, namePattern),
        site: string(pool.site, `${path}.site`, namePattern),
        class: string(pool.class, `${path}.class`, /^[a-z][a-z0-9-]{0,31}$/),
      };
      if (pool.gpuModel !== undefined)
        result.gpuModel = string(pool.gpuModel, `${path}.gpuModel`, /^[A-Za-z0-9-]{1,32}$/);
      if (pool.sharing !== undefined) result.sharing = string(pool.sharing, `${path}.sharing`);
      if (pool.agent !== undefined) {
        if (pool.agent !== 'bcd' && pool.agent !== 'none')
          fail(`${path}.agent`, 'must be bcd or none');
        result.agent = pool.agent;
      }
      if (pool.policy !== undefined) result.policy = record(pool.policy, `${path}.policy`);
      if (pool.ownerQuota !== undefined)
        result.ownerQuota = quota(pool.ownerQuota, `${path}.ownerQuota`);
      if (pool.providerAccount !== undefined)
        result.providerAccount = string(
          pool.providerAccount,
          `${path}.providerAccount`,
          namePattern,
        );
      const offers = list(
        pool.offers,
        `${path}.offers`,
        (rawOffer, offerPath) => {
          const offer = record(rawOffer, offerPath);
          only(offer, ['tenant', 'quota', 'includeDescendants', 'priority'], offerPath);
          const item: FleetOffer = {
            tenant: string(offer.tenant, `${offerPath}.tenant`, tenantPattern),
            quota: quota(offer.quota ?? {}, `${offerPath}.quota`),
          };
          if (offer.includeDescendants !== undefined) {
            if (typeof offer.includeDescendants !== 'boolean')
              fail(`${offerPath}.includeDescendants`, 'must be true or false');
            item.includeDescendants = offer.includeDescendants;
          }
          if (offer.priority !== undefined)
            item.priority = int(offer.priority, `${offerPath}.priority`, -1000, 1000);
          return item;
        },
        (offer) => offer.tenant,
      );
      if (offers.length) result.offers = offers;
      return result;
    },
    (pool) => pool.name,
  );
  const flavors = list(
    input.flavors,
    'flavors',
    (raw, path) => {
      const flavor = record(raw, path);
      only(
        flavor,
        ['pool', 'name', 'vcpu', 'memoryGiB', 'diskGiB', 'gpus', 'offerId', 'placement'],
        path,
      );
      const result: FleetFlavor = {
        pool: string(flavor.pool, `${path}.pool`, namePattern),
        name: string(flavor.name, `${path}.name`, namePattern),
        vcpu: int(flavor.vcpu, `${path}.vcpu`, 1, 1024),
        memoryGiB: int(flavor.memoryGiB, `${path}.memoryGiB`, 1, 65_536),
        diskGiB: int(flavor.diskGiB, `${path}.diskGiB`, 1, 1_048_576),
      };
      if (flavor.gpus !== undefined) result.gpus = int(flavor.gpus, `${path}.gpus`, 0, 64);
      if (flavor.offerId !== undefined) result.offerId = string(flavor.offerId, `${path}.offerId`);
      if (flavor.placement !== undefined) {
        const at = `${path}.placement`;
        const placement = record(flavor.placement, at);
        only(placement, ['numaAffine', 'pinned', 'hugepages'], at);
        const wanted: NonNullable<FleetFlavor['placement']> = {};
        for (const key of ['numaAffine', 'pinned'] as const) {
          if (placement[key] === undefined) continue;
          if (typeof placement[key] !== 'boolean') fail(`${at}.${key}`, 'must be a boolean');
          if (placement[key]) wanted[key] = true;
        }
        if (placement.hugepages !== undefined) {
          if (placement.hugepages !== '2Mi' && placement.hugepages !== '1Gi')
            fail(`${at}.hugepages`, 'must be 2Mi or 1Gi');
          wanted.hugepages = placement.hugepages;
        }
        if (Object.keys(wanted).length) result.placement = wanted;
      }
      return result;
    },
    (flavor) => `${flavor.pool}/${flavor.name}`,
  );
  const sandboxTemplates = list(
    input.sandboxTemplates,
    'sandboxTemplates',
    (raw, path) => {
      const template = record(raw, path);
      only(
        template,
        [
          'name',
          'pool',
          'flavor',
          'imageId',
          'runtime',
          'userData',
          'defaultTtlSeconds',
          'maxTtlSeconds',
          'warm',
          'env',
          'network',
          'volumes',
        ],
        path,
      );
      const result: FleetSandboxTemplate = {
        name: string(template.name, `${path}.name`, namePattern),
        pool: string(
          template.pool,
          `${path}.pool`,
          /^(pool_[0-9a-z]{26,52}|[a-z0-9][a-z0-9._-]{0,62})$/,
        ),
        flavor: string(template.flavor, `${path}.flavor`, namePattern),
        imageId: string(
          template.imageId,
          `${path}.imageId`,
          /^[A-Za-z0-9][A-Za-z0-9._@:/-]{0,199}$/,
        ),
      };
      if (template.runtime !== undefined)
        result.runtime = string(template.runtime, `${path}.runtime`, /^[a-z][a-z0-9-]{0,63}$/);
      if (template.userData !== undefined) {
        if (typeof template.userData !== 'string' || template.userData.length > 32_768)
          fail(`${path}.userData`, 'must be a string of at most 32 KiB');
        result.userData = template.userData;
      }
      for (const field of ['defaultTtlSeconds', 'maxTtlSeconds'] as const)
        if (template[field] !== undefined)
          result[field] = int(template[field], `${path}.${field}`, 60, 30 * 24 * 3600);
      if (template.warm !== undefined) {
        const warm = record(template.warm, `${path}.warm`);
        only(warm, ['min', 'max'], `${path}.warm`);
        result.warm = { min: int(warm.min, `${path}.warm.min`, 0, 64) };
        if (warm.max !== undefined) result.warm.max = int(warm.max, `${path}.warm.max`, 0, 64);
      }
      if (template.env !== undefined) {
        const env = record(template.env, `${path}.env`);
        result.env = {};
        for (const [name, ref] of Object.entries(env)) {
          if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(name))
            fail(`${path}.env.${name}`, 'is not a variable name (A-Z, 0-9, _)');
          // Values are references, never secrets: the document is safe to commit.
          result.env[name] = string(ref, `${path}.env.${name}`, /^secret:\/\/[^/\s]+\/[^/\s]+$/);
        }
      }
      if (template.network !== undefined) {
        if (!['egress', 'private', 'none'].includes(template.network as string))
          fail(`${path}.network`, 'must be egress, private or none');
        result.network = template.network as FleetSandboxTemplate['network'];
      }
      if (template.volumes !== undefined) {
        // vps's maxTemplateVolumes (fleet does not depend on vps).
        if (!Array.isArray(template.volumes) || template.volumes.length > 8)
          fail(`${path}.volumes`, 'must list at most 8 volumes');
        result.volumes = template.volumes.map((raw, index) => {
          const at = `${path}.volumes[${index}]`;
          const volume = record(raw, at);
          only(volume, ['volume', 'mountPath', 'readOnly'], at);
          const entry: NonNullable<FleetSandboxTemplate['volumes']>[number] = {
            volume: string(volume.volume, `${at}.volume`, namePattern),
            mountPath: string(volume.mountPath, `${at}.mountPath`, /^\/[A-Za-z0-9._/-]{0,254}$/),
          };
          if (volume.readOnly !== undefined) {
            if (typeof volume.readOnly !== 'boolean') fail(`${at}.readOnly`, 'must be a boolean');
            if (volume.readOnly) entry.readOnly = true;
          }
          return entry;
        });
      }
      return result;
    },
    (template) => template.name,
  );
  const kubernetesClusters = list(
    input.kubernetesClusters,
    'kubernetesClusters',
    kubernetesCluster,
    (cluster) => cluster.name,
  );
  const config: FleetConfig = { version: 1 };
  if (sites.length) config.sites = sites;
  if (providerAccounts.length) config.providerAccounts = providerAccounts;
  if (pools.length) config.pools = pools;
  if (flavors.length) config.flavors = flavors;
  if (sandboxTemplates.length) config.sandboxTemplates = sandboxTemplates;
  if (kubernetesClusters.length) config.kubernetesClusters = kubernetesClusters;
  return config;
}
