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
import {
  adoptResource,
  checkAdopt,
  discoverResources,
  prepareAdopt,
  releaseResource,
} from './adopt.js';
import { cloudResourcesMigrations } from './migrations.js';
import {
  cloudResourcesSchemas,
  kindPattern,
  parseAdopt,
  parseCreate,
  parseDiscover,
  parseCatalog,
  parseKinds,
  parseList,
  parseRef,
  parseSignals,
  parseUpdate,
} from './parse.js';
import { resourcesReconciler } from './reconciler.js';
import { listCatalog } from './catalog.js';
import { listSignals } from './signals.js';
import { meterResources, resourceHoursMeter, usageSourceAccepted } from './usage.js';

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
import type { CloudResourcesDeps } from './store.js';
import type {
  AdoptResourceInput,
  CatalogEntryView,
  CatalogInput,
  CloudResourceKindView,
  CloudResourceView,
  CreateResourceInput,
  DiscoveredResourceView,
  DiscoverInput,
  KindsInput,
  ListResourcesInput,
  ResourceRef,
  ResourceSignalView,
  SignalsInput,
  UpdateResourceInput,
} from './types.js';

/** At most this many of a deleted tenant's resources are marked for deletion per `tenantDeleted` call. */
const tenantTeardownBatch = 100;

/** A meter key as better-iam takes it (core's meter catalog pattern). */
const meterKeyPattern = /^[a-z][a-z0-9._-]{0,63}$/;

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
  /**
   * The kinds' own meters to write usage for (`['do.database.pg.node.hours']`), at the rates providers report.
   * Each must be defined in IAM billing first: the default catalog has only `cloud.resource.hours`, which every
   * resource bills. Default: none.
   */
  kindMeters?: readonly string[];
  /** An ended hour is written only this long after it ended (default 5 minutes). */
  meterGraceMs?: number;
}

/** The API group of the cloud-resources module. */
export type CloudResourcesApi = {
  /** Managed data and platform services on a provider account: databases, apps, functions and the like. */
  cloudResources: {
    kinds: MethodDefinition<KindsInput, { items: CloudResourceKindView[] }>;
    /** The installable applications (1-Click apps) the pool's provider lists; installed through other surfaces. */
    catalog: MethodDefinition<CatalogInput, { items: CatalogEntryView[] }>;
    /**
     * Read-only signals the pool's provider raises about resources (Managed Agents asking for a human, failed runs):
     * a tenant's own resources, or everything on its own account.
     */
    signals: MethodDefinition<SignalsInput, { items: ResourceSignalView[] }>;
    create: MethodDefinition<CreateResourceInput, CloudResourceView>;
    list: MethodDefinition<ListResourcesInput, { items: CloudResourceView[] }>;
    get: MethodDefinition<ResourceRef, CloudResourceView>;
    update: MethodDefinition<UpdateResourceInput, CloudResourceView>;
    delete: MethodDefinition<ResourceRef, CloudResourceView>;
    /** The kind's resources on the tenant's own account, managed or not. */
    discover: MethodDefinition<DiscoverInput, { items: DiscoveredResourceView[] }>;
    /** Takes over an unmanaged resource of the tenant's own account. */
    adopt: MethodDefinition<AdoptResourceInput, CloudResourceView>;
    /** Lets a resource go: it keeps running at the provider, unmanaged. */
    release: MethodDefinition<ResourceRef, CloudResourceView>;
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
  const kindMeters = new Set<string>();
  for (const meter of options.kindMeters ?? []) {
    if (typeof meter !== 'string' || !meterKeyPattern.test(meter) || meter === resourceHoursMeter)
      throw new ComputeError(
        'INVALID_CONFIG',
        `cloudResources({ kindMeters }): ${JSON.stringify(meter)} is not a kind meter key`,
      );
    kindMeters.add(meter);
  }
  if (
    options.meterGraceMs !== undefined &&
    !(Number.isSafeInteger(options.meterGraceMs) && options.meterGraceMs >= 0)
  )
    throw new ComputeError(
      'INVALID_CONFIG',
      'cloudResources({ meterGraceMs }) must be a non-negative integer',
    );
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
      // The provider is listed with no transaction open.
      catalog: defineMethod({
        action: 'compute:cloud-resources:read',
        kind: 'read',
        resource: tenantResource,
        transaction: 'manual',
        validate: describedBy(cloudResourcesSchemas.catalog, parseCatalog),
        handler: (context, input) => listCatalog(depsOf(context), context, input),
      }),
      // The provider is listed with no transaction open.
      signals: defineMethod({
        action: 'compute:cloud-resources:read',
        kind: 'read',
        resource: tenantResource,
        transaction: 'manual',
        validate: describedBy(cloudResourcesSchemas.signals, parseSignals),
        handler: (context, input) => listSignals(depsOf(context), context, input),
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
      // The provider is listed with no transaction open.
      discover: defineMethod({
        action: 'compute:cloud-resources:read',
        kind: 'read',
        resource: tenantResource,
        transaction: 'manual',
        validate: describedBy(cloudResourcesSchemas.discover, parseDiscover),
        handler: (context, input) => discoverResources(depsOf(context), context, input),
      }),
      adopt: defineMethod({
        action: 'compute:cloud-resources:create',
        kind: 'mutation',
        resource: (input: AdoptResourceInput) => ({
          type: 'cloud-resource',
          id: `draft:${input.idempotencyKey}`,
        }),
        validate: describedBy(cloudResourcesSchemas.adopt, parseAdopt),
        admission: {
          prepare: (context, input, tx) => prepareAdopt(depsOf(context), context, input, tx),
          denied: (context, input, tx) => clearStaged(context, input, tx),
          abandoned: (context, input, tx) => clearStaged(context, input, tx),
          // The provider is asked, with no transaction open, whether the resource exists and is free to take.
          check: (context, input) => checkAdopt(depsOf(context), context, input),
        },
        handler: (context, input) => adoptResource(depsOf(context), context, input),
      }),
      release: defineMethod({
        action: 'compute:cloud-resources:delete',
        kind: 'mutation',
        resource: resourceRef,
        validate: describedBy(cloudResourcesSchemas.ref, parseRef),
        handler: (context, input) => releaseResource(depsOf(context), context.sql, input),
      }),
    },
  });

  return defineModule({
    name: 'cloud-resources',
    requires: ['vps'],
    migrations: [...cloudResourcesMigrations],
    api,
    reconcilers: [
      resourcesReconciler(depsOf),
      {
        // cloud.resource.hours (and the kind meters named in kindMeters) for resources that exist at the provider.
        name: 'cloud.resources.usage',
        shardBy: 'none',
        periodic: [{ key: 'all', every: '5m' }],
        async run(context) {
          const rootTenantId = (context.iam as ModuleContext['iam'] | undefined)?.rootTenantId;
          await context.sql.transaction((tx) =>
            meterResources(tx, context.clock.now(), {
              rootTenantId,
              meterGraceMs: options.meterGraceMs,
              kindMeters,
            }),
          );
          return 'DONE';
        },
      },
    ],
    selfCheck: async (context) => {
      // Resources whose provider account has no provider this module knows: the reconciler cannot reach them.
      const { rows } = await context.sql.query<{ provider: string; resources: string }>(
        `SELECT provider, count(*)::text AS resources FROM cloud_resources
          WHERE state NOT IN ('deleted', 'released') GROUP BY provider ORDER BY provider`,
      );
      const findings = [];
      if (!(await usageSourceAccepted(context.sql)))
        findings.push({
          check: 'cloud-resources.usage-source',
          severity: 'error' as const,
          message:
            "usage_windows refuses 'cloud-resource' windows: a migration that ran after cloud-resources/0002 replaced the source kind CHECK without it, so cloud.resources.usage fails",
          fix: "Add 'cloud-resource' back to usage_windows_source_kind_ck (NOT VALID), and have that migration append to the CHECK instead of replacing it",
        });
      return findings.concat(
        rows
          .filter((row) => !providers.has(row.provider))
          .map((row) => ({
            check: 'cloud-resources.provider-missing',
            severity: 'error' as const,
            message: `${row.resources} cloud resource(s) are on ${row.provider} accounts, but cloudResources({ providers }) does not list ${row.provider}`,
            fix: `Pass the ${row.provider} provider definition to cloudResources({ providers }), as to vps({ providers })`,
            count: Number(row.resources),
          })),
      );
    },
    // §12.8: a deleted tenant's resources are deleted at the provider; DONE once all are gone. At most
    // `tenantTeardownBatch` are marked per call (a short transaction against the reconciler), SYNC_AGAIN meanwhile;
    // the reconciler's 30 s sweep already wakes the ones being deleted.
    async tenantDeleted(context, tenantId) {
      const deps = depsOf(context);
      return context.sql.transaction(async (tx) => {
        const { rows } = await tx.query<{ id: string; tenant_id: string; kind: string }>(
          `SELECT id, tenant_id, kind FROM cloud_resources
            WHERE tenant_id = $1 AND desired_state = 'present' AND state NOT IN ('deleted', 'released')
            ORDER BY id LIMIT $2 FOR UPDATE`,
          [tenantId, tenantTeardownBatch],
        );
        for (const row of rows) await markDeleted(deps, tx, row, 'tenant-deleted');
        const live = await tx.query(
          `SELECT 1 FROM cloud_resources
            WHERE tenant_id = $1 AND state NOT IN ('deleted', 'released') LIMIT 1`,
          [tenantId],
        );
        return live.rows.length > 0 ? 'SYNC_AGAIN' : 'DONE';
      });
    },
  });
}
