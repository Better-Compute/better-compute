import {
  ComputeError,
  draftId,
  newId,
  type AdmissionPlan,
  type KubernetesVersions,
  type MethodContext,
  type SqlTx,
} from '@better-compute/core';
import { readAccount, zoneRegion } from '@better-compute/vps';
import { canonical, sha256Hex } from './input.js';
import { credentialSubject, renderKubeconfig } from './kubeconfig.js';
import { maxNodePoolsPerCluster } from './parse.js';
import { parsePoolSubstrate } from './substrate-policy.js';
import {
  accountKubernetes,
  clusterColumns,
  clusterView,
  clusterViewOf,
  clustersWork,
  json,
  nodePoolView,
  poolKubernetes,
  providerClusterName,
  publish,
  readCluster,
  readNodePool,
  readNodePools,
  regionOf,
  requireCluster,
  type ClusterRow,
  type KubernetesDeps,
  type NodePoolRow,
} from './store.js';
import type {
  ClusterRef,
  CreateClusterInput,
  CreateNodePoolInput,
  CredentialsInput,
  KubernetesClusterView,
  KubernetesKubeconfig,
  KubernetesNodePoolView,
  ListClustersInput,
  NodePoolInput,
  NodePoolRef,
  UpdateClusterInput,
  UpdateNodePoolInput,
  VersionsInput,
} from './types.js';

// The `kubernetesClusters` and `kubernetesNodePools` handlers. They record what the tenant wants and wake the
// `kubernetes.clusters` reconciler; only `credentials` and `versions` call the provider, outside any transaction.

const code = (error: unknown): string | undefined => (error as { code?: string } | undefined)?.code;
const uniqueViolation = (error: unknown) => code(error) === '23505';

const requestHash = (input: CreateClusterInput) => {
  const { tenantId: _tenant, idempotencyKey: _key, ...request } = input;
  return sha256Hex(canonical(request));
};

const nodePoolHash = (input: CreateNodePoolInput) => {
  const { tenantId: _tenant, idempotencyKey: _key, ...request } = input;
  return sha256Hex(canonical(request));
};

/** What a create resolves before anything is written: the account, the region, and the network if any. */
interface Admitted {
  accountId: string;
  region: string;
  networkId?: string;
  subnetId?: string;
}

/** Node pool zones must be zones of the cluster's region (and of the account, when it configures zones). */
function assertZones(
  pools: readonly Pick<NodePoolInput, 'name' | 'zones'>[],
  region: string,
  accountZones: readonly string[],
): void {
  for (const pool of pools)
    for (const zone of pool.zones ?? []) {
      if (zoneRegion(zone) !== region || zone === region)
        throw new ComputeError(
          'INVALID_INPUT',
          `Node pool ${pool.name}: zone ${zone} is not a zone of the cluster's region ${region}`,
          undefined,
          { field: 'zones' },
        );
      if (accountZones.length > 0 && !accountZones.includes(zone))
        throw new ComputeError(
          'INVALID_INPUT',
          `Node pool ${pool.name}: zone ${zone} is not one of the provider account's zones`,
          undefined,
          { field: 'zones', zones: [...accountZones] },
        );
    }
}

/**
 * The tenant network the nodes use: the tenant's, on the pool's account, provisioned (it was `ready` once) and not
 * being deleted, with a `ready` subnet in the cluster's region (the first by name when there are several).
 */
export async function clusterNetwork(
  tx: SqlTx,
  input: { tenantId: string; accountId: string; networkId: string; region: string },
): Promise<{ networkId: string; subnetId: string }> {
  const { rows } = await tx.query<{
    id: string;
    provider_account_id: string;
    state: string;
    desired_state: string;
    provisioned_at: Date | string | null;
  }>(
    `SELECT id, provider_account_id, state, desired_state, provisioned_at FROM networks
      WHERE id = $1 AND tenant_id = $2 FOR SHARE`,
    [input.networkId, input.tenantId],
  );
  const network = rows[0];
  if (!network || network.state === 'deleted')
    throw new ComputeError(
      'INVALID_INPUT',
      `Network ${input.networkId} not found in this tenant`,
      undefined,
      {
        field: 'networkId',
      },
    );
  if (network.provider_account_id !== input.accountId)
    throw new ComputeError(
      'INVALID_INPUT',
      `Network ${network.id} is on provider account ${network.provider_account_id}, not the pool's ${input.accountId}`,
      undefined,
      { field: 'networkId' },
    );
  if (network.desired_state !== 'present' || network.state === 'deleting')
    throw new ComputeError('INVALID_STATE', `Network ${network.id} is being deleted`);
  if (network.provisioned_at === null)
    throw new ComputeError(
      'INVALID_STATE',
      `Network ${network.id} has not been provisioned yet; retry once it is ready`,
      undefined,
      { networkId: network.id, hint: 'retry once the network is ready' },
    );
  const subnets = await tx.query<{ id: string }>(
    `SELECT id FROM network_subnets
      WHERE network_id = $1 AND region = $2 AND desired_state = 'present' AND state = 'ready'
      ORDER BY name FOR SHARE`,
    [network.id, input.region],
  );
  const subnet = subnets.rows[0];
  if (!subnet)
    throw new ComputeError(
      'INVALID_INPUT',
      `Network ${network.id} has no ready subnet in ${input.region}; add one (networks.addSubnet) first`,
      undefined,
      { field: 'networkId', region: input.region },
    );
  return { networkId: network.id, subnetId: subnet.id };
}

async function assertNameFree(tx: SqlTx, tenantId: string, name: string): Promise<void> {
  const taken = await tx.query(
    `SELECT 1 FROM kubernetes_clusters WHERE tenant_id = $1 AND name = $2 AND state <> 'deleted'`,
    [tenantId, name],
  );
  if (taken.rows.length > 0) throw new ComputeError('CONFLICT', `Cluster ${name} already exists`);
}

/** QUOTA_EXCEEDED when the tenant already has `maxClustersPerTenant` clusters that are not deleted. */
async function assertAllowance(deps: KubernetesDeps, tx: SqlTx, tenantId: string): Promise<void> {
  const live = await tx.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM kubernetes_clusters WHERE tenant_id = $1 AND state <> 'deleted'`,
    [tenantId],
  );
  if (Number(live.rows[0]!.count) >= deps.maxClustersPerTenant)
    throw new ComputeError(
      'QUOTA_EXCEEDED',
      `A tenant has at most ${deps.maxClustersPerTenant} Kubernetes clusters that are not deleted`,
      undefined,
      { limit: deps.maxClustersPerTenant },
    );
}

/** The checks of a create that read the provider pool, the location and the network (both transactions). */
async function admit(
  deps: KubernetesDeps,
  tx: SqlTx,
  input: CreateClusterInput,
): Promise<Admitted> {
  const provider = await poolKubernetes(deps, tx, input.tenantId, input.poolId);
  const region = regionOf(provider, input.location);
  if (provider.kubernetes.regionalOnly === true && input.location !== region)
    throw new ComputeError(
      'INVALID_INPUT',
      `Clusters on this provider are regional: location must be the region ${region}, not the zone ${input.location} (node pools take zones)`,
      undefined,
      { field: 'location', region },
    );
  assertZones(input.nodePools, region, provider.zones);
  const admitted: Admitted = { accountId: provider.account.id, region };
  if (input.networkId !== undefined)
    Object.assign(
      admitted,
      await clusterNetwork(tx, {
        tenantId: input.tenantId,
        accountId: provider.account.id,
        networkId: input.networkId,
        region,
      }),
    );
  return admitted;
}

const authzRow = (
  clusterId: string,
  input: CreateClusterInput,
  accountId: string,
  ownerId: string,
) => ({
  type: 'kubernetes-cluster',
  id: clusterId,
  tenantId: input.tenantId,
  attributes: {
    providerAccountId: accountId,
    poolId: input.poolId,
    mode: input.mode,
    location: input.location,
    ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
  },
  parentType: 'tenant',
  parentId: input.tenantId,
  ownerId,
});

/**
 * `kubernetesClusters.create` transaction 1: the idempotency lookup, the pool, provider, location and network
 * checks, and the authz projection row the decision reads (`kubernetes-cluster/<id>`, the id derived from tenant,
 * caller and key). A key already used replays.
 */
export async function prepareCreateCluster(
  deps: KubernetesDeps,
  context: MethodContext,
  input: CreateClusterInput,
  tx: SqlTx,
): Promise<AdmissionPlan<KubernetesClusterView>> {
  const caller = context.caller;
  if (!caller) throw new ComputeError('UNAUTHENTICATED', 'A caller is required');
  const clusterId = await draftId('kcl', input.tenantId, caller.identityId, input.idempotencyKey);
  const existing = await readCluster(tx, { clusterId, tenantId: input.tenantId });
  if (existing) {
    if (existing.request_hash !== (await requestHash(input)))
      throw new ComputeError('CONFLICT', 'This idempotency key was used for a different request');
    return { status: 'replay', result: await clusterViewOf(tx, clusterId) };
  }
  // Refusals come before anything is staged, so a refused request leaves no projection row behind.
  const { accountId } = await admit(deps, tx, input);
  await assertNameFree(tx, input.tenantId, input.name);
  await assertAllowance(deps, tx, input.tenantId);
  await context.authz.upsert(tx, authzRow(clusterId, input, accountId, caller.identityId));
  return { status: 'decide', resource: { type: 'kubernetes-cluster', id: clusterId } };
}

/** `kubernetesClusters.create` refused or abandoned: the projection row staged for a cluster never created goes. */
export async function clearStagedCluster(
  context: MethodContext,
  input: CreateClusterInput,
  tx: SqlTx,
): Promise<void> {
  if (!context.caller) return;
  const clusterId = await draftId(
    'kcl',
    input.tenantId,
    context.caller.identityId,
    input.idempotencyKey,
  );
  if (!(await readCluster(tx, { clusterId })))
    await context.authz.remove(tx, {
      type: 'kubernetes-cluster',
      id: clusterId,
      tenantId: input.tenantId,
    });
}

async function insertNodePool(
  tx: SqlTx,
  row: {
    id: string;
    clusterId: string;
    tenantId: string;
    pool: NodePoolInput;
    initial: boolean;
    createdBy: string;
    idempotencyKey?: string;
    requestHash?: string;
  },
): Promise<void> {
  const { pool } = row;
  await tx.query(
    `INSERT INTO kubernetes_node_pools (id, cluster_id, tenant_id, name, machine_type, node_count, autoscaling_min,
                                        autoscaling_max, disk_gib, disk_type, spot, accelerator_type,
                                        accelerator_count, zones, labels, taints, initial, state, desired_state,
                                        created_by, idempotency_key, request_hash, version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15::jsonb, $16::jsonb, $17,
             'pending', 'present', $18, $19, decode($20, 'hex'), 1)`,
    [
      row.id,
      row.clusterId,
      row.tenantId,
      pool.name,
      pool.machineType,
      pool.nodeCount,
      pool.autoscaling?.minNodes ?? null,
      pool.autoscaling?.maxNodes ?? null,
      pool.diskGiB ?? null,
      pool.diskType ?? null,
      pool.spot === true,
      pool.accelerators?.type ?? null,
      pool.accelerators?.count ?? null,
      JSON.stringify(pool.zones ?? []),
      JSON.stringify(pool.labels ?? {}),
      JSON.stringify(pool.taints ?? []),
      row.initial,
      row.createdBy,
      row.idempotencyKey ?? null,
      row.requestHash ?? null,
    ],
  );
}

/**
 * `kubernetesClusters.create` (transaction 2): records the cluster `pending` with its node pools and wakes the
 * reconciler. A retry with the same key returns the cluster; another request under the key is CONFLICT.
 */
export async function createCluster(
  deps: KubernetesDeps,
  context: MethodContext,
  input: CreateClusterInput,
): Promise<KubernetesClusterView> {
  const tx = context.sql;
  const caller = context.caller;
  if (!caller) throw new ComputeError('UNAUTHENTICATED', 'A caller is required');
  const clusterId = await draftId('kcl', input.tenantId, caller.identityId, input.idempotencyKey);
  const hash = await requestHash(input);
  const existing = await readCluster(tx, { clusterId, tenantId: input.tenantId });
  if (existing) {
    if (existing.request_hash !== hash)
      throw new ComputeError('CONFLICT', 'This idempotency key was used for a different request');
    return clusterViewOf(tx, clusterId);
  }
  const admitted = await admit(deps, tx, input);
  await assertNameFree(tx, input.tenantId, input.name);
  // Concurrent creates of one tenant count one after the other.
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext('better-compute:kubernetes:' || $1))`, [
    input.tenantId,
  ]);
  await assertAllowance(deps, tx, input.tenantId);
  try {
    await tx.query(
      `INSERT INTO kubernetes_clusters (id, tenant_id, project_id, pool_id, provider_account_id, network_id, subnet_id,
                                        name, description, mode, location, region, release_channel, requested_version,
                                        authorized_networks, private_nodes, provider_name, state, desired_state,
                                        created_by, idempotency_key, request_hash, version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16, $17, 'pending', 'present',
               $18, $19, decode($20, 'hex'), 1)`,
      [
        clusterId,
        input.tenantId,
        input.projectId ?? null,
        input.poolId,
        admitted.accountId,
        admitted.networkId ?? null,
        admitted.subnetId ?? null,
        input.name,
        input.description ?? null,
        input.mode,
        input.location,
        admitted.region,
        input.releaseChannel,
        input.version ?? null,
        JSON.stringify(input.authorizedNetworks),
        input.privateNodes,
        providerClusterName(clusterId),
        caller.identityId,
        input.idempotencyKey,
        hash,
      ],
    );
  } catch (error) {
    if (uniqueViolation(error)) {
      const constraint = (error as { constraint?: string }).constraint ?? '';
      if (constraint.includes('name'))
        throw new ComputeError('CONFLICT', `Cluster ${input.name} already exists`);
      throw new ComputeError(
        'CONFLICT',
        'This idempotency key is already being used by a concurrent request',
      );
    }
    throw error;
  }
  for (const pool of input.nodePools)
    await insertNodePool(tx, {
      id: newId('knp'),
      clusterId,
      tenantId: input.tenantId,
      pool,
      initial: true,
      createdBy: caller.identityId,
    });
  await deps.authz.upsert(tx, authzRow(clusterId, input, admitted.accountId, caller.identityId));
  await deps.work.enqueue(tx, clustersWork, clusterId);
  await publish(
    deps,
    tx,
    { id: clusterId, tenant_id: input.tenantId },
    'kubernetes.cluster.created',
    {
      poolId: input.poolId,
      providerAccountId: admitted.accountId,
      name: input.name,
      mode: input.mode,
      location: input.location,
    },
  );
  return clusterViewOf(tx, clusterId);
}

export async function getCluster(tx: SqlTx, ref: ClusterRef): Promise<KubernetesClusterView> {
  const row = await requireCluster(tx, ref);
  return clusterView(row, await readNodePools(tx, [row.id]));
}

export async function listClusters(
  tx: SqlTx,
  input: ListClustersInput,
): Promise<{ items: KubernetesClusterView[] }> {
  const { rows } = await tx.query<ClusterRow>(
    `SELECT ${clusterColumns} FROM kubernetes_clusters
      WHERE tenant_id = $1 AND ($2::text IS NULL OR pool_id = $2) AND ($3::text IS NULL OR project_id = $3)
        AND ($4 OR state <> 'deleted')
      ORDER BY created_at, id LIMIT 500`,
    [input.tenantId, input.poolId ?? null, input.projectId ?? null, input.includeDeleted === true],
  );
  const pools = await readNodePools(
    tx,
    rows.map((row) => row.id),
  );
  return {
    items: rows.map((row) =>
      clusterView(
        row,
        pools.filter((pool) => pool.cluster_id === row.id),
      ),
    ),
  };
}

/** A cluster accepting changes: locked, and neither being deleted nor deleted. */
/**
 * A pool substrate's cluster is the pool's (`policy.substrate`): its node pools follow the pool's flavors and it goes
 * with the pool. `what` names the refused change; `kubernetesClusters.update` is allowed on a created one (an
 * operator upgrade; a version change only when its pool does not drain before upgrades, `assertNoDrainBypass`), never
 * on an adopted one, which better-compute does not change.
 */
function assertNotSubstrate(row: ClusterRow, what: 'update' | 'delete' | 'nodePools'): void {
  if (row.adopted && what === 'update')
    throw new ComputeError(
      'INVALID_STATE',
      `Cluster ${row.id} was adopted by pool ${row.substrate_pool_id}'s substrate; better-compute does not change it`,
    );
  if (row.substrate_pool_id !== null && what !== 'update')
    throw new ComputeError(
      'INVALID_STATE',
      `Cluster ${row.id} is pool ${row.substrate_pool_id}'s substrate: change policy.substrate (flavors), or archive the pool to remove it`,
      undefined,
      { poolId: row.substrate_pool_id },
    );
}

/**
 * A version change made directly on a created substrate cluster whose pool has `upgrades: 'drain'` would upgrade at
 * once, around the drain (no `substrate-upgrade` NoSchedule, no wait for bookings): refused, pointing to the pool
 * policy, where the substrate drains before it pushes the version. A policy that cannot be read refuses too (fail
 * closed).
 */
async function assertNoDrainBypass(tx: SqlTx, row: ClusterRow): Promise<void> {
  const { rows } = await tx.query<{ policy: Record<string, unknown> | string | null }>(
    `SELECT policy FROM pools WHERE id = $1`,
    [row.substrate_pool_id],
  );
  let drain = true;
  try {
    const policy = rows[0]?.policy;
    const substrate = policy ? parsePoolSubstrate(json(policy) as Record<string, unknown>) : undefined;
    drain = substrate?.upgrades === 'drain';
  } catch {
    drain = true;
  }
  if (drain)
    throw new ComputeError(
      'INVALID_STATE',
      `Cluster ${row.id} is pool ${row.substrate_pool_id}'s substrate with upgrades: 'drain': change policy.substrate.cluster.create.version, and the substrate drains the pool's nodes before it upgrades`,
      undefined,
      { poolId: row.substrate_pool_id },
    );
}

async function openCluster(tx: SqlTx, ref: ClusterRef): Promise<ClusterRow> {
  const row = await requireCluster(tx, ref, { lock: true });
  if (row.desired_state === 'deleted' || row.state === 'deleting' || row.state === 'deleted')
    throw new ComputeError('INVALID_STATE', `Cluster ${row.id} is being deleted`);
  return row;
}

/** The cluster converges again: a settled one (`ready`, `error`) becomes `updating`; its version is bumped. */
export async function reopen(
  deps: Pick<KubernetesDeps, 'work'>,
  tx: SqlTx,
  clusterId: string,
): Promise<void> {
  await tx.query(
    `UPDATE kubernetes_clusters
        SET version = version + 1,
            state = CASE WHEN state IN ('ready', 'error') THEN 'updating' ELSE state END,
            message = CASE WHEN state IN ('ready', 'error') THEN NULL ELSE message END
      WHERE id = $1`,
    [clusterId],
  );
  await deps.work.enqueue(tx, clustersWork, clusterId);
}

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().every((value, index) => value === [...b].sort()[index]);

/**
 * `kubernetesClusters.update`: the control-plane version, release channel and authorized networks change in place
 * at the provider (the cluster goes `updating` until the reconciler has them); the description is ours alone.
 */
export async function updateCluster(
  deps: KubernetesDeps,
  tx: SqlTx,
  input: UpdateClusterInput,
): Promise<KubernetesClusterView> {
  const row = await openCluster(tx, input);
  assertNotSubstrate(row, 'update');
  if (row.substrate_pool_id !== null && input.version !== undefined && input.version !== row.requested_version)
    await assertNoDrainBypass(tx, row);
  const networks = json(row.authorized_networks);
  const providerChange =
    (input.version !== undefined && input.version !== row.requested_version) ||
    (input.releaseChannel !== undefined && input.releaseChannel !== row.release_channel) ||
    (input.authorizedNetworks !== undefined && !sameList(input.authorizedNetworks, networks));
  // A settled cluster (ready, error) converges again when the provider has something to change.
  await tx.query(
    `UPDATE kubernetes_clusters
        SET requested_version = $2, release_channel = $3, authorized_networks = $4::jsonb, description = $5,
            version = version + 1,
            state = CASE WHEN $6 AND state IN ('ready', 'error') THEN 'updating' ELSE state END,
            message = CASE WHEN $6 AND state IN ('ready', 'error') THEN NULL ELSE message END
      WHERE id = $1`,
    [
      row.id,
      input.version ?? row.requested_version,
      input.releaseChannel ?? row.release_channel,
      JSON.stringify(input.authorizedNetworks ?? networks),
      input.description !== undefined ? input.description : row.description,
      providerChange,
    ],
  );
  if (providerChange) await deps.work.enqueue(tx, clustersWork, row.id);
  return clusterViewOf(tx, row.id);
}

/**
 * `kubernetesClusters.delete`: the cluster and its node pools are marked for deletion and the reconciler deletes
 * the cluster at the provider (its node pools go with it). Idempotent.
 */
export async function deleteCluster(
  deps: KubernetesDeps,
  tx: SqlTx,
  ref: ClusterRef,
): Promise<KubernetesClusterView> {
  const row = await requireCluster(tx, ref, { lock: true });
  if (row.desired_state === 'deleted') return clusterViewOf(tx, row.id);
  assertNotSubstrate(row, 'delete');
  await markDeleted(tx, row.id);
  await deps.work.enqueue(tx, clustersWork, row.id);
  await publish(deps, tx, row, 'kubernetes.cluster.deleting');
  return clusterViewOf(tx, row.id);
}

/** Marks a cluster and its node pools for deletion (the caller holds the cluster row). */
export async function markDeleted(tx: SqlTx, clusterId: string): Promise<void> {
  await tx.query(
    `UPDATE kubernetes_node_pools
        SET desired_state = 'deleted', state = CASE WHEN state = 'deleted' THEN state ELSE 'deleting' END,
            version = version + 1, updated_at = compute_now()
      WHERE cluster_id = $1 AND desired_state <> 'deleted'`,
    [clusterId],
  );
  await tx.query(
    `UPDATE kubernetes_clusters SET desired_state = 'deleted', state = 'deleting', message = NULL, version = version + 1
      WHERE id = $1`,
    [clusterId],
  );
}

// --- credentials and versions (provider calls, no transaction open) -------------------------------

export interface CredentialOptions {
  /** `kubernetes({ credentialTtlSeconds })`. */
  ttlSeconds: number;
  /** The IAM resource-type prefix, when the context does not name it. */
  typePrefix: string;
}

const callContext = (deps: KubernetesDeps, idempotencyKey: string, signal?: AbortSignal) => ({
  idempotencyKey,
  signal: signal ?? new AbortController().signal,
  clock: deps.clock,
  secrets: deps.secrets,
  log: deps.log,
});

/**
 * `kubernetesClusters.credentials` (declared `transaction: 'manual'`): the envelope decided
 * `compute:kubernetes:connect` on the cluster; `edit` also needs `compute:kubernetes:update` and `admin`
 * `compute:kubernetes:delete` on it, decided here with the caller's own credential. The provider mints a token for
 * the caller's subject outside any transaction; the token is rendered into the kubeconfig and never stored, logged
 * or published. An adopted cluster (a pool substrate's `cluster: { adopt }`) gets none (INVALID_STATE).
 */
export async function issueCredentials(
  deps: KubernetesDeps,
  context: MethodContext,
  input: CredentialsInput,
  options: CredentialOptions,
): Promise<KubernetesKubeconfig> {
  const caller = context.caller;
  if (!caller) throw new ComputeError('UNAUTHENTICATED', 'A caller is required');
  if (input.role !== 'view') {
    if (!context.credential)
      throw new ComputeError(
        'ACCESS_DENIED',
        `A ${input.role} credential is decided on the caller's own credential`,
        undefined,
        { reason: 'credential-required' },
      );
    const prefix = context.typePrefix ?? options.typePrefix;
    await context.iam.require(context.credential, {
      tenantId: input.tenantId,
      action: input.role === 'edit' ? 'compute:kubernetes:update' : 'compute:kubernetes:delete',
      resource: { type: `${prefix}kubernetes-cluster`, id: input.clusterId },
    });
  }
  const { cluster, account } = await context.sql.transaction(async (tx) => {
    const row = await requireCluster(tx, input);
    return {
      cluster: row,
      account: await readAccount(tx, row.provider_account_id),
    };
  });
  // An adopted cluster is not better-compute's: a credential's service account and binding (cluster-admin for
  // `admin`) would stay there after the substrate is torn down, and teardown revokes only its own identity. The
  // tenant reaches its own cluster with the provider's credentials.
  if (cluster.adopted)
    throw new ComputeError(
      'INVALID_STATE',
      `Cluster ${cluster.id} was adopted by pool ${cluster.substrate_pool_id}'s substrate; better-compute issues no credentials for a cluster it does not own: use the provider's own`,
      undefined,
      { poolId: cluster.substrate_pool_id, reason: 'adopted' },
    );
  const usable =
    cluster.desired_state === 'present' &&
    cluster.provider_id !== null &&
    (cluster.state === 'ready' || (cluster.state === 'updating' && cluster.ready_at !== null));
  if (!usable)
    throw new ComputeError(
      'INVALID_STATE',
      `Cluster ${cluster.id} is ${cluster.desired_state === 'deleted' ? 'being deleted' : cluster.state}; credentials are issued once it is ready`,
      undefined,
      { state: cluster.state, hint: 'retry once the cluster is ready' },
    );
  if (!account)
    throw new ComputeError(
      'INVALID_STATE',
      `Provider account ${cluster.provider_account_id} of cluster ${cluster.id} not found`,
    );
  const provider = await accountKubernetes(deps, account);
  const subject = credentialSubject(caller.identityId, input.role);
  const ttlSeconds = input.ttlSeconds ?? options.ttlSeconds;
  const issued = await provider.kubernetes.credentials(
    cluster.provider_id!,
    { subject, role: input.role, ttlSeconds },
    callContext(deps, `${cluster.id}:${subject}`, context.signal),
  );
  const kubeconfig = renderKubeconfig(cluster.name, subject, issued);
  await context.sql.transaction((tx) =>
    publish(deps, tx, cluster, 'kubernetes.cluster.credentials-issued', {
      role: input.role,
      subject,
      identityId: caller.identityId,
      ttlSeconds,
      expiresAt: issued.expiresAt,
    }),
  );
  return { kubeconfig, expiresAt: issued.expiresAt, role: input.role };
}

/** `kubernetesClusters.versions` (declared `transaction: 'manual'`): the provider's versions in a location. */
export async function providerVersions(
  deps: KubernetesDeps,
  context: MethodContext,
  input: VersionsInput,
): Promise<KubernetesVersions> {
  const provider = await context.sql.transaction(async (tx) => {
    const found = await poolKubernetes(deps, tx, input.tenantId, input.poolId);
    regionOf(found, input.location);
    return found;
  });
  return provider.kubernetes.versions(
    input.location,
    callContext(deps, `versions:${input.location}`, context.signal),
  );
}

// --- node pools --------------------------------------------------------------------------------

/**
 * `kubernetesNodePools.create`: a node pool of a `standard` cluster that is not being deleted, recorded `pending`;
 * the cluster goes `updating` until the reconciler has it. With an `idempotencyKey` (scoped to tenant, caller and
 * cluster) a retry returns the node pool; another request under the key is CONFLICT.
 */
export async function createNodePool(
  deps: KubernetesDeps,
  context: MethodContext,
  input: CreateNodePoolInput,
): Promise<KubernetesNodePoolView> {
  const tx = context.sql;
  const caller = context.caller;
  if (!caller) throw new ComputeError('UNAUTHENTICATED', 'A caller is required');
  const cluster = await openCluster(tx, input);
  assertNotSubstrate(cluster, 'nodePools');
  if (cluster.mode !== 'standard')
    throw new ComputeError(
      'INVALID_STATE',
      `Cluster ${cluster.id} is autopilot: the provider runs its nodes, and it has no node pools`,
    );
  let nodePoolId: string = newId('knp');
  let hash: string | undefined;
  if (input.idempotencyKey !== undefined) {
    nodePoolId = await draftId(
      'knp',
      input.tenantId,
      caller.identityId,
      `${cluster.id}/${input.idempotencyKey}`,
    );
    hash = await nodePoolHash(input);
    const existing = await readNodePool(tx, cluster.id, nodePoolId);
    if (existing) {
      if (existing.request_hash !== hash)
        throw new ComputeError('CONFLICT', 'This idempotency key was used for a different request');
      return nodePoolView(existing);
    }
  }
  const account = await readAccount(tx, cluster.provider_account_id);
  const accountZones = Array.isArray(account?.config.zones)
    ? account!.config.zones.filter((zone): zone is string => typeof zone === 'string')
    : [];
  assertZones([input], cluster.region, accountZones);
  const live = await readNodePools(tx, [cluster.id]);
  if (live.some((pool) => pool.name === input.name))
    throw new ComputeError('CONFLICT', `Node pool ${input.name} already exists`);
  if (live.length >= maxNodePoolsPerCluster)
    throw new ComputeError(
      'QUOTA_EXCEEDED',
      `A cluster has at most ${maxNodePoolsPerCluster} node pools that are not deleted`,
      undefined,
      { limit: maxNodePoolsPerCluster },
    );
  const { tenantId: _tenant, clusterId: _cluster, idempotencyKey, ...pool } = input;
  try {
    await insertNodePool(tx, {
      id: nodePoolId,
      clusterId: cluster.id,
      tenantId: input.tenantId,
      pool,
      initial: false,
      createdBy: caller.identityId,
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      ...(hash !== undefined ? { requestHash: hash } : {}),
    });
  } catch (error) {
    if (uniqueViolation(error))
      throw new ComputeError('CONFLICT', `Node pool ${input.name} already exists`);
    throw error;
  }
  await reopen(deps, tx, cluster.id);
  await publish(deps, tx, cluster, 'kubernetes.nodepool.created', {
    nodePoolId,
    name: input.name,
  });
  return nodePoolView((await readNodePool(tx, cluster.id, nodePoolId))!);
}

export async function listNodePools(
  tx: SqlTx,
  ref: ClusterRef,
): Promise<{ items: KubernetesNodePoolView[] }> {
  const cluster = await requireCluster(tx, ref);
  return { items: (await readNodePools(tx, [cluster.id])).map(nodePoolView) };
}

async function requireNodePool(
  tx: SqlTx,
  clusterId: string,
  nodePoolId: string,
): Promise<NodePoolRow> {
  const row = await readNodePool(tx, clusterId, nodePoolId, { lock: true });
  if (!row || row.state === 'deleted')
    throw new ComputeError('NOT_FOUND', `Node pool ${nodePoolId} not found`);
  return row;
}

/** `kubernetesNodePools.update`: resizes in place (`nodeCount`, `autoscaling`; `autoscaling: null` turns it off). */
export async function updateNodePool(
  deps: KubernetesDeps,
  tx: SqlTx,
  input: UpdateNodePoolInput,
): Promise<KubernetesNodePoolView> {
  const cluster = await openCluster(tx, input);
  assertNotSubstrate(cluster, 'nodePools');
  const row = await requireNodePool(tx, cluster.id, input.nodePoolId);
  if (row.desired_state === 'deleted')
    throw new ComputeError('INVALID_STATE', `Node pool ${row.id} is being deleted`);
  const autoscaling =
    input.autoscaling === undefined
      ? row.autoscaling_min !== null && row.autoscaling_max !== null
        ? { minNodes: Number(row.autoscaling_min), maxNodes: Number(row.autoscaling_max) }
        : null
      : input.autoscaling;
  const nodeCount = input.nodeCount ?? Number(row.node_count);
  if (
    autoscaling !== null &&
    input.nodeCount !== undefined &&
    (nodeCount < autoscaling.minNodes || nodeCount > autoscaling.maxNodes)
  )
    throw new ComputeError(
      'INVALID_INPUT',
      `nodeCount ${nodeCount} is outside the autoscaling bounds ${autoscaling.minNodes}-${autoscaling.maxNodes}`,
      undefined,
      { field: 'nodeCount' },
    );
  await tx.query(
    `UPDATE kubernetes_node_pools
        SET node_count = $2, autoscaling_min = $3, autoscaling_max = $4, message = NULL, version = version + 1,
            updated_at = compute_now(),
            state = CASE WHEN state IN ('ready', 'error', 'updating') THEN 'updating' ELSE state END
      WHERE id = $1`,
    [row.id, nodeCount, autoscaling?.minNodes ?? null, autoscaling?.maxNodes ?? null],
  );
  await reopen(deps, tx, cluster.id);
  return nodePoolView((await readNodePool(tx, cluster.id, row.id))!);
}

/** `kubernetesNodePools.delete`: marks the node pool for deletion; the reconciler deletes it. Idempotent. */
export async function deleteNodePool(
  deps: KubernetesDeps,
  tx: SqlTx,
  ref: NodePoolRef,
): Promise<KubernetesNodePoolView> {
  const cluster = await requireCluster(tx, ref, { lock: true });
  assertNotSubstrate(cluster, 'nodePools');
  const row = await readNodePool(tx, cluster.id, ref.nodePoolId, { lock: true });
  if (!row) throw new ComputeError('NOT_FOUND', `Node pool ${ref.nodePoolId} not found`);
  if (row.desired_state === 'deleted') return nodePoolView(row);
  await tx.query(
    `UPDATE kubernetes_node_pools
        SET desired_state = 'deleted', state = 'deleting', message = NULL, version = version + 1,
            updated_at = compute_now()
      WHERE id = $1`,
    [row.id],
  );
  await reopen(deps, tx, cluster.id);
  return nodePoolView((await readNodePool(tx, cluster.id, row.id))!);
}
