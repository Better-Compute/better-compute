import {
  ComputeError,
  defineMethod,
  defineModule,
  describedBy,
  type ComputeModule,
  type MethodContext,
  type MethodDefinition,
  type ModuleContext,
  type ProviderDefinition,
  type SecretBroker,
} from '@better-compute/core';
import { budgetAdmissionCheck, offerAdmissionCheck } from '@better-compute/capacity';
import {
  parseTenantVaultPaths,
  poolBillingMode,
  ProviderClients,
  type TenantVaultPaths,
} from '@better-compute/vps';
import { cloudResourcesMigrations } from './migrations.js';
import {
  cloudResourcesSchemas,
  kindPattern,
  parseCreate,
  parseKinds,
  parseList,
  parseRef,
  parseUpdate,
} from './parse.js';
import { resourcesReconciler } from './reconciler.js';
import {
  clearStaged,
  createResource,
  deleteResource,
  getResource,
  listKinds,
  listResources,
  markDeleted,
  prepareCreate,
  updateResource,
} from './resources.js';
import { resourcesWork, type CloudResourcesDeps } from './store.js';
import type {
  CloudResourceKindView,
  CloudResourceView,
  CreateResourceInput,
  KindsInput,
  ListResourcesInput,
  ResourceRef,
  UpdateResourceInput,
} from './types.js';

export interface CloudResourcesOptions {
  /**
   * The provider definitions the host passes to `vps({ providers })`: this module builds its own clients from the
   * same accounts (it never registers the providers again).
   */
  providers?: readonly ProviderDefinition[];
  /**
   * Resolves accounts' SecretRefs and seals secret outputs (`put`); default: the host's secret broker
   * (`ctx.secrets`). Without one, kinds that return secrets are refused.
   */
  secrets?: SecretBroker;
  /** As `vps({ tenantVaultPaths })`: which `vault://` refs tenants' accounts resolve. */
  tenantVaultPaths?: TenantVaultPaths;
  /** Resources of one kind (not deleted) a tenant may have (default 20). */
  maxPerKind?: number;
  /** Per-kind overrides of `maxPerKind` (`{ 'do.database.pg': 5 }`). */
  quotas?: Readonly<Record<string, number>>;
}

/** The API group of the cloud-resources module. */
export type CloudResourcesApi = {
  /** Managed data and platform services on a provider account: databases, apps, functions and the like. */
  cloudResources: {
    kinds: MethodDefinition<KindsInput, { items: CloudResourceKindView[] }>;
    create: MethodDefinition<CreateResourceInput, CloudResourceView>;
    list: MethodDefinition<ListResourcesInput, { items: CloudResourceView[] }>;
    get: MethodDefinition<ResourceRef, CloudResourceView>;
    update: MethodDefinition<UpdateResourceInput, CloudResourceView>;
    delete: MethodDefinition<ResourceRef, CloudResourceView>;
  };
};

function tenantResource<I extends { tenantId: string }>(input: I) {
  return { type: 'tenant', id: input.tenantId };
}
function resourceRef<I extends { resourceId: string }>(input: I) {
  return { type: 'cloud-resource', id: input.resourceId };
}

/**
 * `cloudResources.create` after the decision: the offer's own refusals (suspended, regions) always, and the
 * tenant's budget unless the pool's billing mode is `none`.
 */
async function resourceBudgetCheck(
  context: MethodContext,
  input: { tenantId: string; poolId: string },
): Promise<void> {
  const mode = await poolBillingMode(context, input.poolId);
  if (mode === undefined || mode === 'none')
    return offerAdmissionCheck(context, input.tenantId, input.poolId);
  return budgetAdmissionCheck(context, input.tenantId, input.poolId);
}

function positiveInteger(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new ComputeError(
      'INVALID_CONFIG',
      `cloudResources({ ${what} }) must be a positive integer`,
    );
  return value;
}

/**
 * The cloud-resources module: the long tail of a provider's managed services (databases, vector databases, apps,
 * functions, add-ons, …) on the provider accounts vps manages, platform-hosted (a root account's pool offered to
 * tenants) or BYO (the tenant's own account). One table, one reconciler and one API group serve every kind a
 * provider lists through `ProviderImpl.resources`; IAM decides on `cloud-resource/{id}` with its kind and family as
 * attributes, and secret outputs are sealed and returned as SecretRefs only.
 */
export function cloudResources(
  options: CloudResourcesOptions = {},
): ComputeModule<'cloud-resources', CloudResourcesApi> {
  const providers = new Map<string, ProviderDefinition>();
  for (const provider of options.providers ?? []) {
    if (provider?.extension !== 'provider')
      throw new ComputeError(
        'INVALID_CONFIG',
        'cloudResources({ providers }) takes defineProvider() definitions',
      );
    if (providers.has(provider.id))
      throw new ComputeError('INVALID_CONFIG', `Provider ${provider.id} is listed twice`);
    providers.set(provider.id, provider);
  }
  const tenantVaultPaths =
    options.tenantVaultPaths !== undefined
      ? parseTenantVaultPaths(options.tenantVaultPaths)
      : undefined;
  const maxPerKind = positiveInteger(options.maxPerKind ?? 20, 'maxPerKind');
  const quotas = new Map<string, number>();
  for (const [kind, limit] of Object.entries(options.quotas ?? {})) {
    if (!kindPattern.test(kind))
      throw new ComputeError('INVALID_CONFIG', `cloudResources({ quotas }): ${kind} is not a kind`);
    quotas.set(kind, positiveInteger(limit, `quotas['${kind}']`));
  }
  const clients = new ProviderClients(providers, tenantVaultPaths);

  const depsOf = (context: ModuleContext): CloudResourcesDeps => {
    const rootTenantId = (context.iam as ModuleContext['iam'] | undefined)?.rootTenantId;
    const workload = context.pki?.workload;
    const secrets = options.secrets ?? context.secrets;
    return {
      clock: context.clock,
      events: context.events,
      work: context.work,
      authz: context.authz,
      log: context.log,
      ...(secrets ? { secrets } : {}),
      clients,
      quotaOf: (kind) => quotas.get(kind) ?? maxPerKind,
      ...(rootTenantId !== undefined ? { rootTenantId } : {}),
      ...(workload ? { workload } : {}),
    };
  };

  const api = (): CloudResourcesApi => ({
    cloudResources: {
      kinds: defineMethod({
        action: 'compute:cloud-resources:read',
        kind: 'read',
        resource: tenantResource,
        validate: describedBy(cloudResourcesSchemas.kinds, parseKinds),
        handler: (context, input) => listKinds(depsOf(context), context.sql, input),
      }),
      create: defineMethod({
        action: 'compute:cloud-resources:create',
        kind: 'mutation',
        // The envelope decides on the resource `prepare` returns, with its kind and family.
        resource: (input: CreateResourceInput) => ({
          type: 'cloud-resource',
          id: `draft:${input.idempotencyKey}`,
        }),
        validate: describedBy(cloudResourcesSchemas.create, parseCreate),
        admission: {
          prepare: (context, input, tx) => prepareCreate(depsOf(context), context, input, tx),
          denied: (context, input, tx) => clearStaged(context, input, tx),
          // Transaction 2 threw (CONFLICT on the name, QUOTA_EXCEEDED): the staged projection row goes.
          abandoned: (context, input, tx) => clearStaged(context, input, tx),
          check: (context, input) => resourceBudgetCheck(context, input),
        },
        handler: (context, input) => createResource(depsOf(context), context, input),
      }),
      list: defineMethod({
        action: 'compute:cloud-resources:read',
        kind: 'read',
        resource: tenantResource,
        validate: describedBy(cloudResourcesSchemas.list, parseList),
        handler: (context, input) => listResources(context.sql, input),
      }),
      get: defineMethod({
        action: 'compute:cloud-resources:read',
        kind: 'read',
        resource: resourceRef,
        validate: describedBy(cloudResourcesSchemas.ref, parseRef),
        handler: (context, input) => getResource(context.sql, input),
      }),
      update: defineMethod({
        action: 'compute:cloud-resources:update',
        kind: 'mutation',
        resource: resourceRef,
        validate: describedBy(cloudResourcesSchemas.update, parseUpdate),
        handler: (context, input) => updateResource(depsOf(context), context.sql, input),
      }),
      delete: defineMethod({
        action: 'compute:cloud-resources:delete',
        kind: 'mutation',
        resource: resourceRef,
        validate: describedBy(cloudResourcesSchemas.ref, parseRef),
        handler: (context, input) => deleteResource(depsOf(context), context.sql, input),
      }),
    },
  });

  return defineModule({
    name: 'cloud-resources',
    requires: ['vps'],
    migrations: [...cloudResourcesMigrations],
    api,
    reconcilers: [resourcesReconciler(depsOf)],
    selfCheck: async (context) => {
      // Resources whose provider account has no provider this module knows: the reconciler cannot reach them.
      const { rows } = await context.sql.query<{ provider: string; resources: string }>(
        `SELECT provider, count(*)::text AS resources FROM cloud_resources
          WHERE state NOT IN ('deleted', 'released') GROUP BY provider ORDER BY provider`,
      );
      return rows
        .filter((row) => !providers.has(row.provider))
        .map((row) => ({
          check: 'cloud-resources.provider-missing',
          severity: 'error' as const,
          message: `${row.resources} cloud resource(s) are on ${row.provider} accounts, but cloudResources({ providers }) does not list ${row.provider}`,
          fix: `Pass the ${row.provider} provider definition to cloudResources({ providers }), as to vps({ providers })`,
          count: Number(row.resources),
        }));
    },
    // §12.8: a deleted tenant's resources are deleted at the provider; DONE once all are gone.
    async tenantDeleted(context, tenantId) {
      const deps = depsOf(context);
      return context.sql.transaction(async (tx) => {
        const { rows } = await tx.query<{
          id: string;
          tenant_id: string;
          kind: string;
          desired_state: string;
        }>(
          `SELECT id, tenant_id, kind, desired_state FROM cloud_resources
            WHERE tenant_id = $1 AND state NOT IN ('deleted', 'released') ORDER BY id FOR UPDATE`,
          [tenantId],
        );
        for (const row of rows) {
          if (row.desired_state === 'present') await markDeleted(deps, tx, row, 'tenant-deleted');
          await deps.work.enqueue(tx, resourcesWork, row.id);
        }
        return rows.length > 0 ? 'SYNC_AGAIN' : 'DONE';
      });
    },
  });
}
