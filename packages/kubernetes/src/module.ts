import {
  ComputeError,
  defineMethod,
  defineModule,
  describedBy,
  type ComputeModule,
  type Finding,
  type KubernetesVersions,
  type MethodContext,
  type MethodDefinition,
  type ModuleContext,
  type ProviderDefinition,
  type SecretResolver,
} from '@better-compute/core';
import { budgetAdmissionCheck, offerAdmissionCheck } from '@better-compute/capacity';
import { describeCreateCluster } from './describe.js';
import {
  parseTenantVaultPaths,
  poolBillingMode,
  ProviderClients,
  type TenantVaultPaths,
} from '@better-compute/vps';
import {
  clearStagedCluster,
  createCluster,
  createNodePool,
  deleteCluster,
  deleteNodePool,
  getCluster,
  issueCredentials,
  listClusters,
  listNodePools,
  markDeleted,
  prepareCreateCluster,
  providerVersions,
  updateCluster,
  updateNodePool,
} from './clusters.js';
import { kubernetesMigrations } from './migrations.js';
import {
  kubernetesSchemas,
  maxCredentialTtlSeconds,
  minCredentialTtlSeconds,
  parseClusterRef,
  parseCreateCluster,
  parseCreateNodePool,
  parseCredentials,
  parseListClusters,
  parseNodePoolRef,
  parseSubstrateRef,
  parseUpdateCluster,
  parseUpdateNodePool,
  parseVersions,
} from './parse.js';
import { clustersReconciler } from './reconciler.js';
import { clustersWork, type KubernetesDeps } from './store.js';
import { substratePolicyValidator } from './substrate-policy.js';
import {
  getSubstrate,
  substratesReconciler,
  substratesWork,
  type SubstrateDeps,
  type SubstrateOptions,
  type SubstrateView,
} from './substrates.js';
import type {
  ClusterRef,
  SubstrateRef,
  CreateClusterInput,
  CreateNodePoolInput,
  CredentialsInput,
  KubernetesClusterView,
  KubernetesKubeconfig,
  KubernetesNodePoolView,
  ListClustersInput,
  NodePoolRef,
  UpdateClusterInput,
  UpdateNodePoolInput,
  VersionsInput,
} from './types.js';
import { meterClusters } from './usage.js';

export interface KubernetesOptions {
  /**
   * The provider definitions the host passes to `vps({ providers })`: this module builds its own clients from the
   * same accounts (it never registers the providers again).
   */
  providers?: readonly ProviderDefinition[];
  /** Resolves accounts' SecretRefs; default: the host's secret broker (`ctx.secrets`). */
  secrets?: SecretResolver;
  /** As `vps({ tenantVaultPaths })`: which `vault://` refs tenants' accounts resolve. */
  tenantVaultPaths?: TenantVaultPaths;
  /** The default lifetime of a `credentials` token, 600 to 86400 seconds (default 3600). */
  credentialTtlSeconds?: number;
  /** Clusters (not deleted) a tenant may have (default 10). */
  maxClustersPerTenant?: number;
  /** An ended hour of `kubernetes.cluster.hours` is written only this long after it ended (default 5 minutes). */
  meterGraceMs?: number;
  /** The IAM resource-type prefix when the host does not name it (`ComputeOptions.typePrefix`, default `compute-`). */
  typePrefix?: string;
  /**
   * Pool substrates (`policy.substrate`): the agent that runs bcd on a substrate's cluster, provider-kubernetes'
   * `kubernetesSubstrateAgent({ image, gatewayUrl, pins, … })`. Without it a pool with a substrate stays in
   * `error` (nothing is created at the provider).
   */
  substrate?: SubstrateOptions;
}

/** The API groups of the kubernetes module. */
export type KubernetesApi = {
  /** Managed Kubernetes clusters on a provider account; the provider runs the control plane. */
  kubernetesClusters: {
    create: MethodDefinition<CreateClusterInput, KubernetesClusterView>;
    list: MethodDefinition<ListClustersInput, { items: KubernetesClusterView[] }>;
    get: MethodDefinition<ClusterRef, KubernetesClusterView>;
    update: MethodDefinition<UpdateClusterInput, KubernetesClusterView>;
    delete: MethodDefinition<ClusterRef, KubernetesClusterView>;
    credentials: MethodDefinition<CredentialsInput, KubernetesKubeconfig>;
    versions: MethodDefinition<VersionsInput, KubernetesVersions>;
  };
  /** Node pools of `standard` clusters. */
  kubernetesNodePools: {
    create: MethodDefinition<CreateNodePoolInput, KubernetesNodePoolView>;
    list: MethodDefinition<ClusterRef, { items: KubernetesNodePoolView[] }>;
    update: MethodDefinition<UpdateNodePoolInput, KubernetesNodePoolView>;
    delete: MethodDefinition<NodePoolRef, KubernetesNodePoolView>;
  };
  /** Pool substrates (`policy.substrate`): the managed cluster behind a pool, as the substrate reconciler sees it. */
  kubernetesSubstrates: {
    get: MethodDefinition<SubstrateRef, SubstrateView>;
  };
};

const noSecrets: SecretResolver = {
  resolve: async () => {
    throw new ComputeError(
      'INVALID_CONFIG',
      'No secret resolver: pass kubernetes({ secrets }) or run a secret broker',
    );
  },
};

function tenantResource<I extends { tenantId: string }>(input: I) {
  return { type: 'tenant', id: input.tenantId };
}
function clusterResource<I extends { clusterId: string }>(input: I) {
  return { type: 'kubernetes-cluster', id: input.clusterId };
}

/**
 * `kubernetesClusters.create` after the decision: the offer's own refusals (suspended, regions) always, and the
 * tenant's budget unless the pool's billing mode is `none` (a cluster bills `kubernetes.cluster.hours` in the
 * `metered` and `platform-fee` modes).
 */
async function clusterBudgetCheck(
  context: MethodContext,
  input: { tenantId: string; poolId: string },
): Promise<void> {
  const mode = await poolBillingMode(context, input.poolId);
  if (mode === undefined || mode === 'none')
    return offerAdmissionCheck(context, input.tenantId, input.poolId);
  return budgetAdmissionCheck(context, input.tenantId, input.poolId);
}

/**
 * The kubernetes module: managed Kubernetes clusters (GKE Standard and Autopilot, later DOKS) on the provider
 * accounts vps manages, platform-hosted (a root account's pool offered to tenants) or BYO (the tenant's own
 * account). The provider runs the control plane; better-compute records what the tenant wants, converges it
 * through `ProviderImpl.kubernetes`, issues short-lived kubeconfigs, and meters cluster hours.
 */
export function kubernetes(
  options: KubernetesOptions = {},
): ComputeModule<'kubernetes', KubernetesApi> {
  const providers = new Map<string, ProviderDefinition>();
  for (const provider of options.providers ?? []) {
    if (provider?.extension !== 'provider')
      throw new ComputeError(
        'INVALID_CONFIG',
        'kubernetes({ providers }) takes defineProvider() definitions',
      );
    if (providers.has(provider.id))
      throw new ComputeError('INVALID_CONFIG', `Provider ${provider.id} is listed twice`);
    providers.set(provider.id, provider);
  }
  const tenantVaultPaths =
    options.tenantVaultPaths !== undefined
      ? parseTenantVaultPaths(options.tenantVaultPaths)
      : undefined;
  const ttl = options.credentialTtlSeconds ?? 3600;
  if (!Number.isSafeInteger(ttl) || ttl < minCredentialTtlSeconds || ttl > maxCredentialTtlSeconds)
    throw new ComputeError(
      'INVALID_CONFIG',
      `kubernetes({ credentialTtlSeconds }) must be an integer from ${minCredentialTtlSeconds} to ${maxCredentialTtlSeconds}`,
    );
  const maxClustersPerTenant = options.maxClustersPerTenant ?? 10;
  if (!Number.isSafeInteger(maxClustersPerTenant) || maxClustersPerTenant < 1)
    throw new ComputeError(
      'INVALID_CONFIG',
      'kubernetes({ maxClustersPerTenant }) must be a positive integer',
    );
  const typePrefix = options.typePrefix ?? 'compute-';
  const clients = new ProviderClients(providers, tenantVaultPaths);
  const substrate = options.substrate;
  if (substrate !== undefined) {
    if (typeof substrate?.agent?.manifests !== 'function' || typeof substrate.agent.connect !== 'function')
      throw new ComputeError(
        'INVALID_CONFIG',
        'kubernetes({ substrate: { agent } }) takes a substrate agent (provider-kubernetes kubernetesSubstrateAgent)',
      );
    const tokenTtl = substrate.tokenTtlSeconds ?? 3600;
    if (!Number.isSafeInteger(tokenTtl) || tokenTtl < 60 || tokenTtl > 86_400)
      throw new ComputeError(
        'INVALID_CONFIG',
        'kubernetes({ substrate: { tokenTtlSeconds } }) must be an integer from 60 to 86400',
      );
  }

  const depsOf = (context: ModuleContext): KubernetesDeps => {
    const rootTenantId = (context.iam as ModuleContext['iam'] | undefined)?.rootTenantId;
    const workload = context.pki?.workload;
    return {
      clock: context.clock,
      events: context.events,
      work: context.work,
      authz: context.authz,
      log: context.log,
      secrets: options.secrets ?? context.secrets ?? noSecrets,
      clients,
      maxClustersPerTenant,
      ...(rootTenantId !== undefined ? { rootTenantId } : {}),
      ...(workload ? { workload } : {}),
    };
  };
  const substrateDepsOf = (context: ModuleContext): SubstrateDeps => ({
    ...depsOf(context),
    ...(substrate ? { substrate } : {}),
    ...(context.pki ? { pki: context.pki } : {}),
    ...(context.desired ? { desired: context.desired } : {}),
    ...(context.inventory ? { inventory: context.inventory } : {}),
  });
  const credentialOptions = { ttlSeconds: ttl, typePrefix };

  const api = (): KubernetesApi => ({
    kubernetesClusters: {
      create: defineMethod({
        action: 'compute:kubernetes:create',
        kind: 'mutation',
        // The envelope decides on the cluster `prepare` returns.
        resource: (input: CreateClusterInput) => ({
          type: 'kubernetes-cluster',
          id: `draft:${input.idempotencyKey}`,
        }),
        validate: describedBy(kubernetesSchemas.createCluster, parseCreateCluster),
        admission: {
          prepare: (context, input, tx) =>
            prepareCreateCluster(depsOf(context), context, input, tx),
          denied: (context, input, tx) => clearStagedCluster(context, input, tx),
          // Transaction 2 threw (CONFLICT on the name, QUOTA_EXCEEDED): the staged projection row goes.
          abandoned: (context, input, tx) => clearStagedCluster(context, input, tx),
          // What an approval binds to (review 14 M1): the decided id does not carry the spec.
          describe: (input) => describeCreateCluster(input),
          check: (context, input) => clusterBudgetCheck(context, input),
          // Both hooks only clear the staged projection row: fleet.apply may compose the create.
          composable: true,
        },
        handler: (context, input) => createCluster(depsOf(context), context, input),
      }),
      list: defineMethod({
        action: 'compute:kubernetes:read',
        kind: 'read',
        resource: tenantResource,
        validate: describedBy(kubernetesSchemas.listClusters, parseListClusters),
        handler: (context, input) => listClusters(context.sql, input),
      }),
      get: defineMethod({
        action: 'compute:kubernetes:read',
        kind: 'read',
        resource: clusterResource,
        validate: describedBy(kubernetesSchemas.cluster, parseClusterRef),
        handler: (context, input) => getCluster(context.sql, input),
      }),
      update: defineMethod({
        action: 'compute:kubernetes:update',
        kind: 'mutation',
        resource: clusterResource,
        validate: describedBy(kubernetesSchemas.updateCluster, parseUpdateCluster),
        handler: (context, input) => updateCluster(depsOf(context), context.sql, input),
      }),
      delete: defineMethod({
        action: 'compute:kubernetes:delete',
        kind: 'mutation',
        resource: clusterResource,
        validate: describedBy(kubernetesSchemas.cluster, parseClusterRef),
        handler: (context, input) => deleteCluster(depsOf(context), context.sql, input),
      }),
      // The provider mints the token and IAM decides edit/admin: no transaction is held open across either.
      credentials: defineMethod({
        action: 'compute:kubernetes:connect',
        kind: 'mutation',
        resource: clusterResource,
        transaction: 'manual',
        validate: describedBy(kubernetesSchemas.credentials, parseCredentials),
        handler: (context, input) =>
          issueCredentials(depsOf(context), context, input, credentialOptions),
      }),
      versions: defineMethod({
        action: 'compute:kubernetes:read',
        kind: 'read',
        resource: tenantResource,
        transaction: 'manual',
        validate: describedBy(kubernetesSchemas.versions, parseVersions),
        handler: (context, input) => providerVersions(depsOf(context), context, input),
      }),
    },
    kubernetesNodePools: {
      create: defineMethod({
        action: 'compute:kubernetes:update',
        kind: 'mutation',
        resource: clusterResource,
        validate: describedBy(kubernetesSchemas.createNodePool, parseCreateNodePool),
        handler: (context, input) => createNodePool(depsOf(context), context, input),
      }),
      list: defineMethod({
        action: 'compute:kubernetes:read',
        kind: 'read',
        resource: clusterResource,
        validate: describedBy(kubernetesSchemas.cluster, parseClusterRef),
        handler: (context, input) => listNodePools(context.sql, input),
      }),
      update: defineMethod({
        action: 'compute:kubernetes:update',
        kind: 'mutation',
        resource: clusterResource,
        validate: describedBy(kubernetesSchemas.updateNodePool, parseUpdateNodePool),
        handler: (context, input) => updateNodePool(depsOf(context), context.sql, input),
      }),
      delete: defineMethod({
        action: 'compute:kubernetes:update',
        kind: 'mutation',
        resource: clusterResource,
        validate: describedBy(kubernetesSchemas.nodePool, parseNodePoolRef),
        handler: (context, input) => deleteNodePool(depsOf(context), context.sql, input),
      }),
    },
    kubernetesSubstrates: {
      get: defineMethod({
        action: 'compute:kubernetes:read',
        kind: 'read',
        resource: tenantResource,
        validate: describedBy(kubernetesSchemas.substrate, parseSubstrateRef),
        handler: (context, input) => getSubstrate(context.sql, input),
      }),
    },
  });

  return defineModule({
    name: 'kubernetes',
    requires: ['vps'],
    migrations: [...kubernetesMigrations],
    // pools.create/update refuse a policy.substrate the substrate reconciler could not converge.
    extensions: [substratePolicyValidator],
    api,
    reconcilers: [
      // Clusters and node pools converged through the provider.
      clustersReconciler(depsOf),
      // Pool substrates: the cluster behind a pool, and bcd on it.
      substratesReconciler(substrateDepsOf),
      {
        // kubernetes.cluster.hours for clusters that exist at the provider.
        name: 'kubernetes.usage',
        shardBy: 'none',
        periodic: [{ key: 'all', every: '5m' }],
        async run(context) {
          const rootTenantId = (context.iam as ModuleContext['iam'] | undefined)?.rootTenantId;
          await context.sql.transaction((tx) =>
            meterClusters(tx, context.clock.now(), {
              rootTenantId,
              meterGraceMs: options.meterGraceMs,
            }),
          );
          return 'DONE';
        },
      },
    ],
    selfCheck: async (context) => {
      // Clusters whose provider account has no provider this module knows: the reconciler cannot reach them.
      const { rows } = await context.sql.query<{ provider: string; clusters: string }>(
        `SELECT a.provider, count(*)::text AS clusters FROM kubernetes_clusters k
           JOIN provider_accounts a ON a.id = k.provider_account_id
          WHERE k.state <> 'deleted' GROUP BY a.provider ORDER BY a.provider`,
      );
      const findings: Finding[] = rows
        .filter((row) => !providers.has(row.provider))
        .map((row) => ({
          check: 'kubernetes.provider-missing',
          severity: 'error' as const,
          message: `${row.clusters} Kubernetes cluster(s) are on ${row.provider} accounts, but kubernetes({ providers }) does not list ${row.provider}`,
          fix: `Pass the ${row.provider} provider definition to kubernetes({ providers }), as to vps({ providers })`,
          count: Number(row.clusters),
        }));
      // Pool substrates: pools that declare one while the module has no agent to run bcd with.
      if (substrate === undefined) {
        const { rows: declared } = await context.sql.query<{ pools: string }>(
          `SELECT count(*)::text AS pools FROM pools WHERE archived_at IS NULL AND policy ? 'substrate'`,
        );
        const pools = Number(declared[0]?.pools ?? 0);
        if (pools > 0)
          findings.push({
            check: 'kubernetes.substrate-agent-missing',
            severity: 'error',
            message: `${pools} pool(s) declare policy.substrate, but kubernetes({ substrate }) is not configured: their clusters are never created and no bcd joins`,
            fix: 'Pass kubernetes({ substrate: { agent: kubernetesSubstrateAgent({ image, gatewayUrl, pins, … }) } }) from @better-compute/provider-kubernetes',
            count: pools,
          });
      }
      // Substrates in error (the message is on the substrate; the pools are named here).
      const { rows: failing } = await context.sql.query<{ pool_id: string }>(
        `SELECT pool_id FROM kubernetes_pool_substrates WHERE state = 'error' ORDER BY pool_id LIMIT 101`,
      );
      if (failing.length > 0) {
        const shown = failing.slice(0, 5).map((row) => row.pool_id);
        const count = failing.length > 100 ? '100+' : String(failing.length);
        findings.push({
          check: 'kubernetes.substrate-error',
          severity: 'warning',
          message: `${count} pool substrate(s) are in error: ${shown.join(', ')}${failing.length > shown.length ? ', …' : ''}`,
          fix: 'Read the substrate message (kubernetes.substrate.error events); fix policy.substrate, the provider account or the cluster, or archive the pool',
          count: Math.min(failing.length, 100),
        });
      }
      // Torn-down substrates whose adopted cluster keeps the substrate's credential identity (the provider cannot
      // revoke credentials): a cluster-admin service account better-compute no longer manages.
      const { rows: left } = await context.sql.query<{ pool_id: string }>(
        `SELECT pool_id FROM kubernetes_pool_substrates WHERE state = 'deleted' AND message IS NOT NULL
          ORDER BY pool_id LIMIT 101`,
      );
      if (left.length > 0) {
        const shown = left.slice(0, 5).map((row) => row.pool_id);
        findings.push({
          check: 'kubernetes.substrate-credentials-left',
          severity: 'warning',
          message: `${left.length > 100 ? '100+' : left.length} torn-down substrate(s) left the service account bc-substrate (cluster-admin) on their adopted cluster: ${shown.join(', ')}${left.length > shown.length ? ', …' : ''}`,
          fix: 'Delete ServiceAccount bc-access/bc-substrate and ClusterRoleBinding bc-access:bc-substrate on each adopted cluster (kubernetesSubstrates.get names it), or use a provider whose kubernetes driver implements revokeCredentials',
          count: Math.min(left.length, 100),
        });
      }
      return findings;
    },
    // §12.8: a deleted tenant's clusters are deleted at the provider; DONE once all are gone. A pool substrate's
    // cluster goes through its substrate (capacity's part of the teardown archives the pool): marked deleted here, the
    // substrate's teardown would skip removing bcd, and an adopted cluster (never deleted) would keep bcd's privileged
    // DaemonSet, its token Secret and the substrate's credential identity. The substrate is woken instead.
    async tenantDeleted(context, tenantId) {
      const deps = depsOf(context);
      return context.sql.transaction(async (tx) => {
        const { rows } = await tx.query<{
          id: string;
          tenant_id: string;
          desired_state: string;
          substrate_pool_id: string | null;
        }>(
          `SELECT id, tenant_id, desired_state, substrate_pool_id FROM kubernetes_clusters
            WHERE tenant_id = $1 AND state <> 'deleted' ORDER BY id FOR UPDATE`,
          [tenantId],
        );
        for (const row of rows) {
          if (row.substrate_pool_id !== null) {
            await deps.work.enqueue(tx, substratesWork, row.substrate_pool_id);
            continue;
          }
          if (row.desired_state !== 'deleted') {
            await markDeleted(tx, row.id);
            await deps.events.publish(tx, {
              type: 'kubernetes.cluster.deleting',
              tenantId: row.tenant_id,
              subject: `kubernetes-cluster/${row.id}`,
              data: { clusterId: row.id, reason: 'tenant-deleted' },
            });
          }
          await deps.work.enqueue(tx, clustersWork, row.id);
        }
        // Substrates still tearing down (their cluster may be gone already: the nodes are retired after it).
        const { rows: substrates } = await tx.query<{ pool_id: string }>(
          `SELECT pool_id FROM kubernetes_pool_substrates WHERE tenant_id = $1 AND state <> 'deleted' ORDER BY pool_id`,
          [tenantId],
        );
        for (const substrate of substrates) await deps.work.enqueue(tx, substratesWork, substrate.pool_id);
        return rows.length > 0 || substrates.length > 0 ? 'SYNC_AGAIN' : 'DONE';
      });
    },
  });
}
