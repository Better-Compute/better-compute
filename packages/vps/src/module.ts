import {
  ComputeError,
  defineMethod,
  defineModule,
  type ComputeModule,
  type Instance,
  type MethodDefinition,
  type ModuleContext,
  type Offer,
  type OfferQuery,
  type ProviderDefinition,
  type SecretResolver,
} from '@better-compute/core';
import {
  createAccount,
  deleteAccount,
  listAccounts,
  parseCreateAccount,
  ProviderClients,
  readAccount,
  updateAccount,
  type CreateAccountInput,
  type ProviderAccount,
} from './accounts.js';
import {
  createFlavor,
  deleteFlavor,
  parseFlavorInput,
  readFlavors,
  updateFlavor,
  type FlavorInput,
  type FlavorRecord,
} from './flavors.js';
import { id, int, name, object, optional, tenant } from './input.js';
import {
  completeCreateInstance,
  deleteInstance,
  denyCreateInstance,
  instanceView,
  instanceWork,
  listInstances,
  parseCreateInstance,
  parseInstanceRef,
  parseListInstances,
  parseResize,
  prepareCreateInstance,
  readInstance,
  resizeInstance,
  setPower,
  type CreateInstanceInput,
  type ImageResolver,
  type InstanceDeps,
  type InstanceRef,
  type ListInstancesInput,
} from './instances.js';
import { instanceSpecs, reconcileInstance } from './lifecycle.js';
import { vpsMigrations } from './migrations.js';
import { meterInstances } from './usage.js';

/** Options of `vps()`. */
export interface VpsOptions {
  /** Runtime driver ids hosted pools run, e.g. `['libvirt-kvm', 'cloud-hypervisor']`; the first is the default. */
  runtimes?: readonly string[];
  /** Provider definitions accounts may use (`provider-hetzner`, …). */
  providers?: readonly ProviderDefinition[];
  /** Resolves images for tenants; required for hosted pools (§3.6: compute checks visibility itself). */
  images?: ImageResolver;
  /** Resolves provider credentials; defaults to the host's secret broker. */
  secrets?: SecretResolver;
}

type PoolInput = { tenantId: string; poolId: string };
type FlavorRef = PoolInput & { name: string };
type AccountRef = { tenantId: string; accountId: string };

/** A provider account as the API shows it: the config holds SecretRefs only, never values. */
export type ProviderAccountView = ProviderAccount;

export type VpsApi = {
  instances: {
    create: MethodDefinition<CreateInstanceInput, Instance>;
    list: MethodDefinition<ListInstancesInput, { items: Instance[]; cursor?: string }>;
    get: MethodDefinition<InstanceRef, Instance>;
    start: MethodDefinition<InstanceRef, Instance>;
    stop: MethodDefinition<InstanceRef, Instance>;
    resize: MethodDefinition<InstanceRef & { flavor: string }, Instance>;
    delete: MethodDefinition<InstanceRef, Instance>;
  };
  flavors: {
    list: MethodDefinition<PoolInput, { items: FlavorRecord[] }>;
    create: MethodDefinition<FlavorInput, FlavorRecord>;
    update: MethodDefinition<FlavorInput, FlavorRecord>;
    delete: MethodDefinition<FlavorRef, { deleted: boolean; archived: boolean }>;
  };
  providerAccounts: {
    create: MethodDefinition<CreateAccountInput, ProviderAccountView>;
    list: MethodDefinition<{ tenantId: string }, { items: ProviderAccountView[] }>;
    get: MethodDefinition<AccountRef, ProviderAccountView>;
    offers: MethodDefinition<AccountRef & { query: OfferQuery }, { items: Offer[] }>;
    update: MethodDefinition<AccountRef & { config: unknown }, ProviderAccountView>;
    delete: MethodDefinition<AccountRef, { deleted: true }>;
  };
};

function tenantResource<I extends { tenantId: string }>(input: I) {
  return { type: 'tenant', id: input.tenantId };
}
function poolResource<I extends { poolId: string }>(input: I) {
  return { type: 'pool', id: input.poolId };
}
function instanceResource<I extends { instanceId: string }>(input: I) {
  return { type: 'instance', id: input.instanceId };
}
function accountResource<I extends { accountId: string }>(input: I) {
  return { type: 'provider-account', id: input.accountId };
}

function parsePool(raw: unknown): PoolInput {
  const input = object(raw, ['tenantId', 'poolId']);
  return { tenantId: tenant(input.tenantId), poolId: id(input.poolId, 'pool', 'poolId') };
}
function parseAccountRef(
  raw: unknown,
  extra: readonly string[] = [],
): AccountRef & Record<string, unknown> {
  const input = object(raw, ['tenantId', 'accountId', ...extra]);
  return {
    ...input,
    tenantId: tenant(input.tenantId),
    accountId: id(input.accountId, 'pacct', 'accountId'),
  };
}
function parseOfferQuery(raw: unknown): OfferQuery {
  if (raw === undefined) return {};
  const input = object(raw, ['kind', 'region', 'gpuModel', 'minGpus', 'minVcpu', 'minMemoryGiB']);
  const query: OfferQuery = {};
  if (input.kind !== undefined) {
    if (input.kind !== 'metal' && input.kind !== 'vps')
      throw new ComputeError('INVALID_INPUT', 'kind must be metal or vps');
    query.kind = input.kind;
  }
  if (input.region !== undefined) query.region = name(input.region, 'region');
  if (input.gpuModel !== undefined) {
    if (typeof input.gpuModel !== 'string' || !/^[A-Za-z0-9-]{1,32}$/.test(input.gpuModel))
      throw new ComputeError('INVALID_INPUT', 'gpuModel is invalid');
    query.gpuModel = input.gpuModel;
  }
  const minGpus = optional(input.minGpus, (value) => int(value, 'minGpus', 0, 64));
  if (minGpus !== undefined) query.minGpus = minGpus;
  const minVcpu = optional(input.minVcpu, (value) => int(value, 'minVcpu', 0, 1024));
  if (minVcpu !== undefined) query.minVcpu = minVcpu;
  const minMemoryGiB = optional(input.minMemoryGiB, (value) =>
    int(value, 'minMemoryGiB', 0, 16_384),
  );
  if (minMemoryGiB !== undefined) query.minMemoryGiB = minMemoryGiB;
  return query;
}

const noSecrets: SecretResolver = {
  resolve: async () => {
    throw new ComputeError(
      'INVALID_CONFIG',
      'No secret resolver: pass vps({ secrets }) or run a secret broker',
    );
  },
};

/**
 * The VPS module (§3.6): instances on hosted pools (placed through capacity, converged by the node's
 * runtime) and on provider pools (driven through `ProviderImpl`), flavors, provider accounts and
 * pool IPAM. Injected by the application; the server never imports it.
 *
 * ```ts
 * betterCompute({ modules: [vps({ runtimes: ['libvirt-kvm'], providers: [hetznerCloud], images })] });
 * ```
 */
export function vps(options: VpsOptions = {}): ComputeModule<'vps', VpsApi> {
  const runtimes = options.runtimes ?? ['libvirt-kvm'];
  if (runtimes.length === 0 || !runtimes.every((runtime) => /^[a-z][a-z0-9-]{0,63}$/.test(runtime)))
    throw new ComputeError('INVALID_CONFIG', 'vps({ runtimes }) must list runtime driver ids');
  const providers = new Map<string, ProviderDefinition>();
  for (const provider of options.providers ?? []) {
    if (provider?.extension !== 'provider')
      throw new ComputeError(
        'INVALID_CONFIG',
        'vps({ providers }) takes defineProvider() definitions',
      );
    if (providers.has(provider.id))
      throw new ComputeError('INVALID_CONFIG', `Provider ${provider.id} is listed twice`);
    providers.set(provider.id, provider);
  }
  const clients = new ProviderClients(providers);

  const depsOf = (context: ModuleContext): InstanceDeps => {
    const deps: InstanceDeps = {
      clock: context.clock,
      events: context.events,
      work: context.work,
      authz: context.authz,
      desired: context.desired,
      capacity: context.capacity,
      log: context.log,
      secrets: options.secrets ?? context.secrets ?? noSecrets,
      clients,
      runtime: runtimes[0]!,
    };
    if (options.images) deps.images = options.images;
    return deps;
  };

  const api = (): VpsApi => ({
    instances: {
      create: defineMethod<CreateInstanceInput, Instance>({
        action: 'compute:instances:create',
        kind: 'mutation',
        // The envelope decides on the draft `prepare` returns.
        resource: (input) => ({ type: 'instance', id: `draft:${input.idempotencyKey}` }),
        validate: parseCreateInstance,
        admission: {
          prepare: (context, input, tx) =>
            prepareCreateInstance(depsOf(context), context, input, tx),
          denied: (context, input, tx) => denyCreateInstance(context, input, tx),
        },
        handler: (context, input) => completeCreateInstance(depsOf(context), context, input),
      }),
      list: defineMethod({
        action: 'compute:instances:read',
        kind: 'read',
        resource: tenantResource,
        validate: parseListInstances,
        handler: (context, input) => listInstances(context.sql, input, context.caller?.identityId),
      }),
      get: defineMethod({
        action: 'compute:instances:read',
        kind: 'read',
        resource: instanceResource,
        validate: parseInstanceRef,
        handler: async (context, input) => {
          const row = await readInstance(context.sql, input.instanceId, {
            tenantId: input.tenantId,
          });
          if (!row || row.draft)
            throw new ComputeError('NOT_FOUND', `Instance ${input.instanceId} not found`);
          return instanceView(row);
        },
      }),
      start: defineMethod({
        action: 'compute:instances:update',
        kind: 'mutation',
        resource: instanceResource,
        validate: parseInstanceRef,
        handler: (context, input) => setPower(depsOf(context), context.sql, input, 'running'),
      }),
      stop: defineMethod({
        action: 'compute:instances:update',
        kind: 'mutation',
        resource: instanceResource,
        validate: parseInstanceRef,
        handler: (context, input) => setPower(depsOf(context), context.sql, input, 'stopped'),
      }),
      resize: defineMethod({
        action: 'compute:instances:update',
        kind: 'mutation',
        resource: instanceResource,
        validate: parseResize,
        handler: (context, input) => resizeInstance(depsOf(context), context.sql, input),
      }),
      delete: defineMethod({
        action: 'compute:instances:delete',
        kind: 'mutation',
        resource: instanceResource,
        validate: parseInstanceRef,
        handler: (context, input) => deleteInstance(depsOf(context), context.sql, input),
      }),
    },
    flavors: {
      list: defineMethod({
        action: 'compute:flavors:read',
        kind: 'read',
        resource: poolResource,
        validate: parsePool,
        handler: async (context, input) => {
          const visible = await context.sql.query(
            `SELECT 1 FROM pools p WHERE p.id = $1 AND (p.owner_tenant_id = $2
               OR EXISTS (SELECT 1 FROM pool_offers o WHERE o.pool_id = p.id AND o.tenant_id = $2))`,
            [input.poolId, input.tenantId],
          );
          if (visible.rows.length === 0)
            throw new ComputeError('NOT_FOUND', `Pool ${input.poolId} not found`);
          return { items: await readFlavors(context.sql, input.poolId) };
        },
      }),
      create: defineMethod({
        action: 'compute:flavors:manage',
        kind: 'mutation',
        resource: poolResource,
        validate: parseFlavorInput,
        handler: (context, input) => createFlavor(context.sql, input),
      }),
      update: defineMethod({
        action: 'compute:flavors:manage',
        kind: 'mutation',
        resource: poolResource,
        validate: parseFlavorInput,
        handler: (context, input) => updateFlavor(context.sql, input),
      }),
      delete: defineMethod({
        action: 'compute:flavors:manage',
        kind: 'mutation',
        resource: poolResource,
        validate: (raw) => {
          const input = object(raw, ['tenantId', 'poolId', 'name']);
          return {
            tenantId: tenant(input.tenantId),
            poolId: id(input.poolId, 'pool', 'poolId'),
            name: name(input.name),
          };
        },
        handler: (context, input) => deleteFlavor(context.sql, input),
      }),
    },
    providerAccounts: {
      create: defineMethod({
        action: 'compute:providers:manage',
        kind: 'mutation',
        resource: tenantResource,
        validate: parseCreateAccount,
        handler: async (context, input) => {
          const account = await createAccount(context.sql, providers, input);
          await context.authz.upsert(context.sql, {
            type: 'provider-account',
            id: account.id,
            tenantId: account.tenantId,
            attributes: { provider: account.provider },
          });
          return account;
        },
      }),
      list: defineMethod({
        action: 'compute:providers:read',
        kind: 'read',
        resource: tenantResource,
        validate: (raw) => ({ tenantId: tenant(object(raw, ['tenantId']).tenantId) }),
        handler: async (context, input) => ({
          items: await listAccounts(context.sql, input.tenantId),
        }),
      }),
      get: defineMethod({
        action: 'compute:providers:read',
        kind: 'read',
        resource: accountResource,
        validate: (raw) => parseAccountRef(raw) as AccountRef,
        handler: async (context, input) => {
          const account = await readAccount(context.sql, input.accountId, input.tenantId);
          if (!account)
            throw new ComputeError('NOT_FOUND', `Provider account ${input.accountId} not found`);
          return account;
        },
      }),
      offers: defineMethod({
        action: 'compute:providers:read',
        kind: 'read',
        resource: accountResource,
        validate: (raw) => {
          const input = parseAccountRef(raw, ['query']);
          return {
            tenantId: input.tenantId,
            accountId: input.accountId,
            query: parseOfferQuery(input.query),
          };
        },
        handler: async (context, input) => {
          const account = await readAccount(context.sql, input.accountId, input.tenantId);
          if (!account)
            throw new ComputeError('NOT_FOUND', `Provider account ${input.accountId} not found`);
          const client = await clients.client(account, depsOf(context));
          return { items: await client.listOffers(input.query) };
        },
      }),
      update: defineMethod({
        action: 'compute:providers:manage',
        kind: 'mutation',
        resource: accountResource,
        validate: (raw) => {
          const input = parseAccountRef(raw, ['config']);
          return { tenantId: input.tenantId, accountId: input.accountId, config: input.config };
        },
        handler: (context, input) => updateAccount(context.sql, providers, input),
      }),
      delete: defineMethod({
        action: 'compute:providers:manage',
        kind: 'mutation',
        resource: accountResource,
        validate: (raw) => parseAccountRef(raw) as AccountRef,
        handler: async (context, input) => {
          await deleteAccount(context.sql, input);
          await context.authz.remove(context.sql, {
            type: 'provider-account',
            id: input.accountId,
          });
          return { deleted: true as const };
        },
      }),
    },
  });

  return defineModule({
    name: 'vps',
    requires: ['capacity'],
    migrations: [...vpsMigrations],
    extensions: [...providers.values()],
    api,
    reconcilers: [
      {
        name: instanceWork,
        shardBy: 'none',
        async run(context, key) {
          const next = await reconcileInstance(depsOf(context), context.sql, key, context.signal);
          if (next !== undefined)
            await context.sql.transaction((tx) =>
              context.work.enqueue(tx, instanceWork, key, { notBefore: next }),
            );
          return 'DONE';
        },
      },
      {
        // §12.7: vps.vcpu.hours, vps.memory.gib.hours (and GPU hours) for hosted instances.
        name: 'vps.usage',
        shardBy: 'none',
        periodic: [{ key: 'all', every: '5m' }],
        async run(context) {
          await context.sql.transaction((tx) => meterInstances(tx, context.clock.now()));
          return 'DONE';
        },
      },
    ],
    async nodeSpec(context, node) {
      const instances = await instanceSpecs(context.sql, node.id);
      return instances.length > 0 ? { instances } : {};
    },
  });
}
