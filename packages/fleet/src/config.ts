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

/** Validates a FleetConfig document; rejects unknown fields, duplicates and dangling references. */
export function validateFleetConfig(value: unknown): FleetConfig {
  const input = record(value, 'config');
  only(
    input,
    ['version', 'sites', 'providerAccounts', 'pools', 'flavors', 'sandboxTemplates'],
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
        if (!Array.isArray(template.volumes) || template.volumes.length > 24)
          fail(`${path}.volumes`, 'must list at most 24 volumes');
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
  const config: FleetConfig = { version: 1 };
  if (sites.length) config.sites = sites;
  if (providerAccounts.length) config.providerAccounts = providerAccounts;
  if (pools.length) config.pools = pools;
  if (flavors.length) config.flavors = flavors;
  if (sandboxTemplates.length) config.sandboxTemplates = sandboxTemplates;
  return config;
}
