import type { FleetConfig, FleetFlavor, FleetSandboxTemplate } from './config.js';

/** A document's template volumes in the API's form (by volume name). */
function apiVolumes(volumes: NonNullable<FleetSandboxTemplate['volumes']>) {
  return volumes.map((volume) => ({
    name: volume.volume,
    mountPath: volume.mountPath,
    readOnly: volume.readOnly === true,
  }));
}
import {
  planKubernetes,
  resolveSubstrateAccount,
  substrateAccount,
  substrateIdentity,
} from './kubernetes.js';
import type { FleetState, NamedKind } from './state.js';

/** One planned change, for people. */
export interface FleetChange {
  kind:
    | 'site'
    | 'providerAccount'
    | 'pool'
    | 'ownerQuota'
    | 'offer'
    | 'flavor'
    | 'sandboxTemplate'
    | 'kubernetesCluster'
    | 'kubernetesNodePool';
  /**
   * The item's name; offers are `<pool> -> <tenant>`, quotas `<pool>:<resource>`, flavors
   * `<pool>/<name>`, node pools `<cluster>/<name>`.
   */
  name: string;
  action: 'create' | 'update' | 'delete' | 'unchanged';
  /** For updates: the fields that differ. */
  fields?: string[];
  /** Why this change cannot be applied (immutable fields, unknown references). */
  blocked?: string;
  /**
   * Planned without a call: it needs an object this plan creates first (a cluster on a new pool).
   * The next apply makes it; until then the fleet reports it as drift.
   */
  deferred?: true;
  note?: string;
}

/** One planned API call: what `fleet.apply` checks, then invokes, in order. */
export interface FleetCall {
  path: `${string}/${string}`;
  input: Record<string, unknown>;
  /** A created object's name, recorded in `fleet_names`. */
  names?: { kind: NamedKind; name: string; id: string };
  /** A deleted object's name mapping, removed from `fleet_names`. */
  forgets?: { kind: NamedKind; id: string };
}

export interface FleetPlan {
  tenantId: string;
  prune: boolean;
  changes: FleetChange[];
  calls: FleetCall[];
  summary: Record<FleetChange['action'], number>;
  /** Some change cannot be applied; `apply` refuses the whole plan. */
  blocked: boolean;
}

export interface PlanOptions {
  prune: boolean;
  /** The id a create with this idempotency key will get (draftId for the current caller). */
  idFor(kind: NamedKind, idempotencyKey: string): Promise<string>;
}

/** Canonical JSON (sorted keys): how values and whole plans are compared. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(',')}}`;
}

const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

/** The idempotency key fleet uses for a create: stable per tenant, kind and name. */
export const fleetKey = (tenantId: string, kind: NamedKind, name: string) =>
  `fleet:${tenantId}:${kind}:${name}`.slice(0, 128);

/**
 * Plans `desired` against `state`: which objects to create, update or (with `prune`) delete, as
 * both human-readable changes and the exact API calls `apply` makes. Pure apart from `idFor`.
 */
export async function planFleet(
  desired: FleetConfig,
  state: FleetState,
  options: PlanOptions,
): Promise<FleetPlan> {
  const tenantId = state.tenantId;
  const changes: FleetChange[] = [];
  const creates: FleetCall[] = [];
  const updates: FleetCall[] = [];
  const deletes: FleetCall[] = [];
  const add = (change: FleetChange) => changes.push(change);

  // Provider accounts.
  const accountIds = new Map(state.providerAccounts.map((account) => [account.name, account.id]));
  const wantedAccounts = new Set<string>();
  for (const account of desired.providerAccounts ?? []) {
    wantedAccounts.add(account.name);
    const current = state.providerAccounts.find((item) => item.name === account.name);
    if (!current) {
      const key = fleetKey(tenantId, 'providerAccount', account.name);
      const id = await options.idFor('providerAccount', key);
      accountIds.set(account.name, id);
      add({ kind: 'providerAccount', name: account.name, action: 'create' });
      creates.push({
        path: 'providerAccounts/create',
        input: {
          tenantId,
          provider: account.provider,
          name: account.name,
          config: account.config,
          idempotencyKey: key,
        },
        names: { kind: 'providerAccount', name: account.name, id },
      });
    } else if (current.provider !== account.provider)
      add({
        kind: 'providerAccount',
        name: account.name,
        action: 'update',
        fields: ['provider'],
        blocked: 'the provider of an account cannot change; create a new account',
      });
    // Stored configs carry the provider manifest's defaults, so only the listed fields are compared.
    else if (
      Object.entries(account.config).some(([field, value]) => !same(current.config[field], value))
    ) {
      add({ kind: 'providerAccount', name: account.name, action: 'update', fields: ['config'] });
      updates.push({
        path: 'providerAccounts/update',
        input: { tenantId, accountId: current.id, config: account.config },
      });
    } else add({ kind: 'providerAccount', name: account.name, action: 'unchanged' });
  }

  // Sites: created, never changed (sites.update does not exist) and never pruned.
  const siteIds = new Map(state.sites.map((site) => [site.name, site.id]));
  const wantedSites = new Set<string>();
  for (const site of desired.sites ?? []) {
    wantedSites.add(site.name);
    const current = state.sites.find((item) => item.name === site.name);
    if (!current) {
      const key = fleetKey(tenantId, 'site', site.name);
      const id = await options.idFor('site', key);
      siteIds.set(site.name, id);
      add({ kind: 'site', name: site.name, action: 'create' });
      creates.push({
        path: 'sites/create',
        input: {
          tenantId,
          kind: site.kind,
          region: site.region,
          ...(site.iamRegion ? { iamRegion: site.iamRegion } : {}),
          idempotencyKey: key,
        },
        names: { kind: 'site', name: site.name, id },
      });
      continue;
    }
    const fields = (['kind', 'region', 'iamRegion'] as const).filter(
      (field) => (current[field] ?? null) !== (site[field] ?? null),
    );
    add(
      fields.length
        ? {
            kind: 'site',
            name: site.name,
            action: 'update',
            fields,
            blocked: 'sites cannot change; create a new site',
          }
        : { kind: 'site', name: site.name, action: 'unchanged' },
    );
  }
  if (options.prune)
    for (const site of state.sites)
      if (!wantedSites.has(site.name))
        add({ kind: 'site', name: site.name, action: 'unchanged', note: 'sites are never pruned' });

  // Pools, owner quotas and offers.
  const poolIds = new Map(state.pools.map((pool) => [pool.name, pool.id]));
  const knownAccounts = new Set(accountIds.values());
  const wantedPools = new Set<string>();
  const createdPools = new Set<string>();
  /** The provider account each wanted pool's substrate runs on (after name resolution). */
  const substrateAccounts = new Map<string, string>();
  const offerCalls: FleetCall[] = [];
  const unoffers: FleetCall[] = [];
  for (const pool of desired.pools ?? []) {
    wantedPools.add(pool.name);
    const siteId = siteIds.get(pool.site);
    const accountId =
      pool.providerAccount === undefined ? undefined : accountIds.get(pool.providerAccount);
    const current = state.pools.find((item) => item.name === pool.name);
    if (!siteId) {
      add({
        kind: 'pool',
        name: pool.name,
        action: current ? 'update' : 'create',
        blocked: `unknown site ${pool.site}`,
      });
      continue;
    }
    if (pool.providerAccount !== undefined && !accountId) {
      add({
        kind: 'pool',
        name: pool.name,
        action: current ? 'update' : 'create',
        blocked: `unknown provider account ${pool.providerAccount}`,
      });
      continue;
    }
    // (D25) A substrate may name its provider account by its document name.
    const resolved = resolveSubstrateAccount(pool.policy, accountIds);
    const policy = resolved.policy ?? {};
    const runsOn = substrateAccount(policy);
    // An id is taken only for an account of the tenant or one this plan creates: the substrate
    // reconciler reads the account as the pool owner's, so any other id could never converge.
    const unknownAccount =
      resolved.unknown ??
      (runsOn !== undefined && !knownAccounts.has(runsOn) ? runsOn : undefined);
    if (unknownAccount !== undefined) {
      add({
        kind: 'pool',
        name: pool.name,
        action: current ? 'update' : 'create',
        blocked: `unknown provider account ${unknownAccount} (policy.substrate.account)`,
      });
      continue;
    }
    if (runsOn !== undefined) substrateAccounts.set(pool.name, runsOn);
    let poolId: string;
    if (!current) {
      const key = fleetKey(tenantId, 'pool', pool.name);
      poolId = await options.idFor('pool', key);
      poolIds.set(pool.name, poolId);
      createdPools.add(pool.name);
      add({ kind: 'pool', name: pool.name, action: 'create' });
      creates.push({
        path: 'pools/create',
        input: {
          tenantId,
          siteId,
          class: pool.class,
          ...(pool.gpuModel ? { gpuModel: pool.gpuModel } : {}),
          ...(pool.sharing ? { sharing: pool.sharing } : {}),
          ...(pool.agent ? { agent: pool.agent } : {}),
          policy,
          ...(pool.ownerQuota ? { ownerQuota: pool.ownerQuota } : {}),
          ...(accountId ? { providerAccountId: accountId } : {}),
          idempotencyKey: key,
        },
        names: { kind: 'pool', name: pool.name, id: poolId },
      });
    } else {
      poolId = current.id;
      const immutable: string[] = [];
      if (current.siteId !== siteId) immutable.push('site');
      if (current.class !== pool.class) immutable.push('class');
      if (pool.sharing !== undefined && current.sharing !== pool.sharing) immutable.push('sharing');
      if (pool.agent !== undefined && current.agent !== pool.agent) immutable.push('agent');
      if ((current.providerAccountId ?? null) !== (accountId ?? null))
        immutable.push('providerAccount');
      // A substrate is never moved to another account or cluster in place (K-D8).
      const identity = substrateIdentity(current.policy);
      const wantedIdentity = substrateIdentity(policy);
      if (identity !== undefined && wantedIdentity !== undefined && identity !== wantedIdentity)
        immutable.push('policy.substrate (account, cluster)');
      const mutable: string[] = [];
      const update: Record<string, unknown> = { tenantId, poolId };
      if (!same(current.policy, policy)) {
        mutable.push('policy');
        update.policy = policy;
      }
      if (pool.gpuModel !== undefined && current.gpuModel !== pool.gpuModel) {
        mutable.push('gpuModel');
        update.gpuModel = pool.gpuModel;
      }
      if (immutable.length)
        add({
          kind: 'pool',
          name: pool.name,
          action: 'update',
          fields: [...immutable, ...mutable],
          blocked: `${immutable.join(', ')} cannot change; create a new pool`,
        });
      else if (mutable.length) {
        add({ kind: 'pool', name: pool.name, action: 'update', fields: mutable });
        updates.push({ path: 'pools/update', input: update });
      } else add({ kind: 'pool', name: pool.name, action: 'unchanged' });

      for (const [resource, max] of Object.entries(pool.ownerQuota ?? {})) {
        const name = `${pool.name}:${resource}`;
        if (current.ownerQuota[resource] === max)
          add({ kind: 'ownerQuota', name, action: 'unchanged' });
        else {
          add({
            kind: 'ownerQuota',
            name,
            action: current.ownerQuota[resource] === undefined ? 'create' : 'update',
            fields: ['max'],
          });
          updates.push({ path: 'quotas/set', input: { tenantId, poolId, resource, max } });
        }
      }
    }

    const currentOffers = current?.offers ?? [];
    const wantedTenants = new Set<string>();
    for (const offer of pool.offers ?? []) {
      wantedTenants.add(offer.tenant);
      const name = `${pool.name} -> ${offer.tenant}`;
      if (offer.tenant === tenantId) {
        add({
          kind: 'offer',
          name,
          action: 'create',
          blocked: 'a pool is not offered to its owner; use ownerQuota',
        });
        continue;
      }
      const existing = currentOffers.find((item) => item.tenant === offer.tenant);
      const input = {
        tenantId,
        poolId,
        toTenantId: offer.tenant,
        quota: offer.quota,
        includeDescendants: offer.includeDescendants ?? false,
        ...(offer.priority !== undefined ? { priority: offer.priority } : {}),
      };
      if (!existing) {
        add({ kind: 'offer', name, action: 'create' });
        offerCalls.push({ path: 'pools/offer', input });
        continue;
      }
      const fields: string[] = [];
      if (Object.entries(offer.quota).some(([resource, max]) => existing.quota[resource] !== max))
        fields.push('quota');
      if ((existing.includeDescendants ?? false) !== (offer.includeDescendants ?? false))
        fields.push('includeDescendants');
      if ((existing.priority ?? 0) !== (offer.priority ?? 0)) fields.push('priority');
      if (fields.length) {
        add({ kind: 'offer', name, action: 'update', fields });
        offerCalls.push({ path: 'pools/offer', input });
      } else add({ kind: 'offer', name, action: 'unchanged' });
    }
    if (options.prune)
      for (const offer of currentOffers)
        if (!wantedTenants.has(offer.tenant)) {
          add({ kind: 'offer', name: `${pool.name} -> ${offer.tenant}`, action: 'delete' });
          unoffers.push({
            path: 'pools/unoffer',
            input: { tenantId, poolId, toTenantId: offer.tenant },
          });
        }
  }

  // Flavors (vps).
  const flavorCalls: FleetCall[] = [];
  const flavorDeletes: FleetCall[] = [];
  const wantedFlavors = new Set<string>();
  const vpsMissing = state.missing.includes('flavors');
  for (const flavor of desired.flavors ?? []) {
    const name = `${flavor.pool}/${flavor.name}`;
    wantedFlavors.add(name);
    const poolId = poolIds.get(flavor.pool);
    if (vpsMissing) {
      add({
        kind: 'flavor',
        name,
        action: 'create',
        blocked: 'this deployment does not run the vps module',
      });
      continue;
    }
    if (!poolId) {
      add({ kind: 'flavor', name, action: 'create', blocked: `unknown pool ${flavor.pool}` });
      continue;
    }
    const input = {
      tenantId,
      poolId,
      name: flavor.name,
      vcpu: flavor.vcpu,
      memoryGiB: flavor.memoryGiB,
      diskGiB: flavor.diskGiB,
      ...(flavor.gpus !== undefined ? { gpus: flavor.gpus } : {}),
      ...(flavor.offerId !== undefined ? { offerId: flavor.offerId } : {}),
      ...(flavor.placement !== undefined ? { placement: flavor.placement } : {}),
    };
    const current = state.flavors.find(
      (item) => item.poolId === poolId && item.name === flavor.name,
    );
    if (!current) {
      add({ kind: 'flavor', name, action: 'create' });
      flavorCalls.push({ path: 'flavors/create', input });
      continue;
    }
    const fields: string[] = (['vcpu', 'memoryGiB', 'diskGiB', 'gpus', 'offerId'] as const).filter(
      (field) =>
        (current[field] ?? (field === 'gpus' ? 0 : null)) !==
        (flavor[field] ?? (field === 'gpus' ? 0 : null)),
    );
    // Placement by value, flags in a fixed order (the store drops false flags).
    const placementOf = (value: FleetFlavor['placement']) =>
      JSON.stringify([value?.numaAffine === true, value?.pinned === true, value?.hugepages ?? null]);
    if (placementOf(current.placement) !== placementOf(flavor.placement)) fields.push('placement');
    if (fields.length) {
      add({ kind: 'flavor', name, action: 'update', fields });
      flavorCalls.push({ path: 'flavors/update', input });
    } else add({ kind: 'flavor', name, action: 'unchanged' });
  }

  // Sandbox templates (vps, v0.5): after flavors (a template names one), before flavor deletes.
  const templateCalls: FleetCall[] = [];
  const templateDeletes: FleetCall[] = [];
  const wantedTemplates = new Set<string>();
  const sandboxesMissing = state.missing.includes('sandbox_templates');
  for (const template of desired.sandboxTemplates ?? []) {
    wantedTemplates.add(template.name);
    const current = state.sandboxTemplates.find((item) => item.name === template.name);
    if (sandboxesMissing) {
      add({
        kind: 'sandboxTemplate',
        name: template.name,
        action: 'create',
        blocked: 'this deployment does not run sandboxes (vps v0.5)',
      });
      continue;
    }
    // A pool of this document by name, or an offered pool by id.
    const poolId =
      poolIds.get(template.pool) ?? (template.pool.startsWith('pool_') ? template.pool : undefined);
    if (!poolId) {
      add({
        kind: 'sandboxTemplate',
        name: template.name,
        action: current ? 'update' : 'create',
        blocked: `unknown pool ${template.pool}`,
      });
      continue;
    }
    if (!current) {
      add({ kind: 'sandboxTemplate', name: template.name, action: 'create' });
      templateCalls.push({
        path: 'sandboxTemplates/create',
        input: {
          tenantId,
          name: template.name,
          poolId,
          flavor: template.flavor,
          imageId: template.imageId,
          ...(template.runtime !== undefined ? { runtime: template.runtime } : {}),
          ...(template.userData !== undefined ? { userData: template.userData } : {}),
          ...(template.defaultTtlSeconds !== undefined
            ? { defaultTtlSeconds: template.defaultTtlSeconds }
            : {}),
          ...(template.maxTtlSeconds !== undefined
            ? { maxTtlSeconds: template.maxTtlSeconds }
            : {}),
          ...(template.warm !== undefined ? { warm: template.warm } : {}),
          ...(template.env !== undefined ? { env: template.env } : {}),
          ...(template.network !== undefined ? { network: template.network } : {}),
          ...(template.volumes !== undefined ? { volumes: apiVolumes(template.volumes) } : {}),
        },
      });
      continue;
    }
    const immutable: string[] = [];
    if (current.poolId !== poolId) immutable.push('pool');
    if (template.runtime !== undefined && current.runtime !== template.runtime)
      immutable.push('runtime');
    // Only the listed fields are compared (the server fills in TTL bounds and warm sizes).
    const update: Record<string, unknown> = { tenantId, templateId: current.id };
    const mutable: string[] = [];
    for (const field of [
      'flavor',
      'imageId',
      'userData',
      'defaultTtlSeconds',
      'maxTtlSeconds',
      'network',
    ] as const)
      if (template[field] !== undefined && current[field] !== template[field]) {
        mutable.push(field);
        update[field] = template[field];
      }
    // env is replaced as a whole map by update.
    if (template.env !== undefined && !same(current.env ?? {}, template.env)) {
      mutable.push('env');
      update.env = template.env;
    }
    if (template.warm !== undefined) {
      const warm = { min: template.warm.min, max: template.warm.max ?? template.warm.min };
      if (!same(current.warm, warm)) {
        mutable.push('warm');
        update.warm = template.warm;
      }
    }
    // Volumes by value, in order (the attach order is the guest's disk order).
    if (
      template.volumes !== undefined &&
      !same(apiVolumes(current.volumes ?? []), apiVolumes(template.volumes))
    ) {
      mutable.push('volumes');
      update.volumes = apiVolumes(template.volumes);
    }
    if (immutable.length)
      add({
        kind: 'sandboxTemplate',
        name: template.name,
        action: 'update',
        fields: [...immutable, ...mutable],
        blocked: `${immutable.join(', ')} cannot change; create a new template`,
      });
    else if (mutable.length) {
      add({ kind: 'sandboxTemplate', name: template.name, action: 'update', fields: mutable });
      templateCalls.push({ path: 'sandboxTemplates/update', input: update });
    } else add({ kind: 'sandboxTemplate', name: template.name, action: 'unchanged' });
  }

  // Kubernetes clusters (D25): after the pools they live on; their deletes before pools are archived.
  const archivedPools = new Map(
    options.prune
      ? state.pools.filter((pool) => !wantedPools.has(pool.name)).map((pool) => [pool.id, pool.name])
      : [],
  );
  const kubernetes = planKubernetes(desired, state, {
    prune: options.prune,
    poolIds,
    createdPools,
    archivedPools,
    add,
  });

  // Deletes (prune), children first.
  if (options.prune) {
    if (!sandboxesMissing)
      for (const template of state.sandboxTemplates)
        if (!wantedTemplates.has(template.name)) {
          add({
            kind: 'sandboxTemplate',
            name: template.name,
            action: 'delete',
            note: 'its warm instances are deleted; running sandboxes keep their TTL',
          });
          templateDeletes.push({
            path: 'sandboxTemplates/delete',
            input: { tenantId, templateId: template.id },
          });
        }
    for (const flavor of state.flavors)
      if (!wantedFlavors.has(`${flavor.pool}/${flavor.name}`) && !vpsMissing) {
        add({ kind: 'flavor', name: `${flavor.pool}/${flavor.name}`, action: 'delete' });
        flavorDeletes.push({
          path: 'flavors/delete',
          input: { tenantId, poolId: flavor.poolId, name: flavor.name },
        });
      }
    for (const pool of state.pools)
      if (!wantedPools.has(pool.name)) {
        // A cluster the document keeps on it blocks the archive (planKubernetes blocks the cluster).
        const inUse = kubernetes.poolsInUse.get(pool.name);
        if (inUse !== undefined) {
          add({ kind: 'pool', name: pool.name, action: 'delete', blocked: inUse });
          continue;
        }
        add({
          kind: 'pool',
          name: pool.name,
          action: 'delete',
          note:
            substrateIdentity(pool.policy) !== undefined
              ? 'archived: running reservations keep their bookings; its substrate is torn down'
              : 'archived: running reservations keep their bookings',
        });
        deletes.push({
          path: 'pools/archive',
          input: { tenantId, poolId: pool.id },
          forgets: { kind: 'pool', id: pool.id },
        });
      }
    for (const account of state.providerAccounts)
      if (!wantedAccounts.has(account.name)) {
        // Pools archived in this same plan release the account (archived pools do not pin it).
        const user = state.pools.find(
          (pool) => pool.providerAccountId === account.id && wantedPools.has(pool.name),
        );
        if (user) {
          add({
            kind: 'providerAccount',
            name: account.name,
            action: 'unchanged',
            note: `kept: pool ${user.name} uses it`,
          });
          continue;
        }
        // A substrate the document keeps, or a cluster that is not gone yet (deleting ones too:
        // the provider still has them), pins the account; a later apply deletes it.
        const substrateUser = [...substrateAccounts].find(([, id]) => id === account.id)?.[0];
        const cluster =
          state.kubernetesClusters.find((item) => item.providerAccountId === account.id)?.name ??
          state.substrateClusters.find((item) => item.providerAccountId === account.id)?.name;
        if (substrateUser !== undefined || cluster !== undefined) {
          add({
            kind: 'providerAccount',
            name: account.name,
            action: 'unchanged',
            note:
              substrateUser !== undefined
                ? `kept: the substrate of pool ${substrateUser} uses it`
                : `kept: cluster ${cluster} uses it until it is deleted; apply again then`,
          });
          continue;
        }
        // Another tenant's cluster on a pool offered to it runs on this account too; which one is
        // not this tenant's to know, so the note names none.
        if (state.pinnedAccounts.includes(account.id)) {
          add({
            kind: 'providerAccount',
            name: account.name,
            action: 'unchanged',
            note: 'kept: a Kubernetes cluster still runs on it',
          });
          continue;
        }
        add({ kind: 'providerAccount', name: account.name, action: 'delete' });
        deletes.push({
          path: 'providerAccounts/delete',
          input: { tenantId, accountId: account.id },
          forgets: { kind: 'providerAccount', id: account.id },
        });
      }
  }

  const calls = [
    ...creates.filter((call) => call.path === 'providerAccounts/create'),
    ...updates.filter((call) => call.path === 'providerAccounts/update'),
    ...creates.filter((call) => call.path === 'sites/create'),
    ...creates.filter((call) => call.path === 'pools/create'),
    ...updates.filter((call) => call.path === 'pools/update' || call.path === 'quotas/set'),
    ...offerCalls,
    ...flavorCalls,
    ...templateCalls,
    ...kubernetes.writes,
    ...templateDeletes,
    ...flavorDeletes,
    ...kubernetes.deletes,
    ...unoffers,
    ...deletes.filter((call) => call.path === 'pools/archive'),
    ...deletes.filter((call) => call.path === 'providerAccounts/delete'),
  ];
  const summary = { create: 0, update: 0, delete: 0, unchanged: 0 };
  for (const change of changes) summary[change.action]++;
  return {
    tenantId,
    prune: options.prune,
    changes,
    calls,
    summary,
    blocked: changes.some((change) => change.blocked),
  };
}
