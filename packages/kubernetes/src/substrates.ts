import {
  ComputeError,
  isComputeError,
  newId,
  type CallContext,
  type Json,
  type KubernetesCredentials,
  type ModuleContext,
  type PkiPort,
  type ProviderKubernetes,
  type Reconciler,
  type SqlExecutor,
  type SqlTx,
} from '@better-compute/core';
import { endNodeReservations } from '@better-compute/capacity';
import { readAccount, zoneRegion } from '@better-compute/vps';
import { clusterNetwork, markDeleted, reopen } from './clusters.js';
import { canonical, sha256Hex } from './input.js';
import {
  accountKubernetes,
  clustersWork,
  json,
  providerClusterName,
  publish as publishCluster,
  regionOf,
  type ClusterRow,
  type KubernetesDeps,
  type NodePoolRow,
  clusterColumns,
  nodePoolColumns,
} from './store.js';
import {
  parsePoolSubstrate,
  substrateIdentity,
  type PoolSubstrate,
  type SubstrateCreate,
  type SubstrateFlavor,
} from './substrate-policy.js';

// The pool substrate (`policy.substrate`, PLAN.md D25 generalised from the DigitalOcean program's P5): a pool whose
// machines are the nodes of a managed Kubernetes cluster on any provider that implements `ProviderImpl.kubernetes`.
// The `kubernetes.substrates` reconciler (key: the pool id)
//   1. records the substrate and the cluster: a created cluster is an ordinary `kubernetes_clusters` row (with one
//      node pool row per flavor) that the `kubernetes.clusters` reconciler converges; an adopted one is a row marked
//      `adopted` that is read, never changed or deleted;
//   2. once the cluster is ready, mints a short-lived credential (`ProviderKubernetes.credentials`, held in memory
//      for this run only, never stored, logged or published), lists the substrate's Nodes, and server-side applies
//      bcd (the injected `SubstrateAgent`: provider-kubernetes' DaemonSet, device plugin only);
//   3. keeps a hosted `kubernetes` join token (and its Secret) only while Nodes outnumber the pool's joined nodes,
//      with exactly that many uses; once every node joined, the token is revoked and the Secret deleted.
// Rows are read in one transaction, the provider and the cluster API are called with none open, and each result is
// written in its own short transaction guarded by the row version it was decided on.

export const substratesWork = 'kubernetes.substrates';
/** The Node label every substrate node pool carries (the DaemonSet's node selector): the pool id. */
export const substratePoolLabel = 'better-compute.dev/substrate-pool';
/** `spot` on the Nodes of Spot flavors. */
export const substrateCapacityLabel = 'better-compute.dev/capacity';
/** The Kubernetes service account the substrate's own credentials are minted for (role admin). */
export const substrateSubject = 'bc-substrate';
/** Credentials the substrate mints live this long (the TokenRequest floor): one run needs seconds. */
export const substrateCredentialTtlSeconds = 600;
/** How soon a substrate still converging (or whose nodes are still joining) is looked at again. */
export const substratePollMs = 10_000;
/** How soon a busy provider or cluster API is tried again. */
export const substrateRetryMs = 30_000;
/** A ready substrate re-applies bcd's manifests at least this often (drift repair). */
export const substrateReapplyMs = 5 * 60_000;
/** The identity a substrate's cluster rows are created by. */
export const substrateCreator = 'system:kubernetes-substrate';

const transientCodes = ['RATE_LIMITED', 'UNAVAILABLE', 'TIMEOUT'];
const text = (error: unknown) => String((error as Error)?.message ?? error).slice(0, 500);

// --- the agent the host injects (provider-kubernetes' kubernetesSubstrateAgent satisfies it) ---------------------

/** A Kubernetes object the agent renders. */
export interface SubstrateObject {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  [field: string]: unknown;
}
export type SubstrateObjectRef = Pick<SubstrateObject, 'apiVersion' | 'kind'> & {
  metadata: { name: string; namespace?: string };
};
export interface SubstrateNode {
  name: string;
  labels: Record<string, string>;
  ready: boolean;
  unschedulable: boolean;
  /** `metadata.uid`: a later Node of the same name (EKS reuses IP-based names) is another Node. */
  uid?: string;
}
/** An object's metadata as `get` reads it (never a Secret's data). */
export interface SubstrateObjectMeta {
  metadata: { name: string; namespace?: string; labels: Record<string, string> };
}
/** One cluster's API with one short-lived credential. */
export interface SubstrateClusterApi {
  /** The object's metadata, or undefined when it does not exist. */
  get(object: SubstrateObjectRef): Promise<SubstrateObjectMeta | undefined>;
  apply(object: SubstrateObject): Promise<void>;
  remove(object: SubstrateObjectRef): Promise<void>;
  nodes(labelSelector?: string): Promise<SubstrateNode[]>;
}
/**
 * What runs bcd on a substrate's cluster (`kubernetes({ substrate: { agent } })`): provider-kubernetes'
 * `kubernetesSubstrateAgent(...)`. The module never imports a provider package (PLAN.md §4.3); the host hands it in.
 */
export interface SubstrateAgent {
  /** Namespace, join-token Secret (only with `joinToken`), config and DaemonSet, in apply order. */
  manifests(input: {
    siteId: string;
    joinToken?: string;
    nodeSelector?: Readonly<Record<string, string>>;
  }): SubstrateObject[];
  readonly tokenSecret: SubstrateObjectRef;
  connect(
    access: Pick<KubernetesCredentials, 'server' | 'certificateAuthorityData' | 'token'>,
    options: { signal: AbortSignal },
  ): SubstrateClusterApi;
}

export interface SubstrateOptions {
  agent: SubstrateAgent;
  /** The hosted join token's lifetime, 60 to 86400 seconds (default 3600). */
  tokenTtlSeconds?: number;
}

/** The substrate part of the module's deps. */
export interface SubstrateDeps extends KubernetesDeps {
  substrate?: SubstrateOptions;
  pki?: PkiPort;
  /** Node specs to rebuild when a removed node's reservations end (`ctx.desired`). */
  desired?: ModuleContext['desired'];
  /** Maps a pool node to its Kubernetes Node by the OS hostname bcd reports (`ctx.inventory`). */
  inventory?: ModuleContext['inventory'];
}

// --- rows ----------------------------------------------------------------------------------------------------------

export type SubstrateState =
  | 'pending'
  | 'provisioning'
  | 'ready'
  | 'updating'
  | 'error'
  | 'deleting'
  | 'deleted';

export interface SubstrateRow {
  pool_id: string;
  tenant_id: string;
  provider_account_id: string;
  mode: 'create' | 'adopt';
  adopt_id: string | null;
  identity: string;
  cluster_id: string | null;
  create_spec: Record<string, Json> | string | null;
  state: SubstrateState;
  desired_state: 'present' | 'deleted';
  message: string | null;
  join_token_id: string | null;
  token_applied: boolean;
  manifests_sha256: string | null;
  applied_at: Date | string | null;
  nodes_listed: number | null;
  nodes_joined: number | null;
  pool_version: string | number | null;
  /** `upgrades: 'drain'`: the version being drained for (or pushed after a drain, until the cluster runs it). */
  upgrade_version: string | null;
  upgrade_since: Date | string | null;
  version: string | number;
}

const substrateColumns = `pool_id, tenant_id, provider_account_id, mode, adopt_id, identity, cluster_id, create_spec,
  state, desired_state, message, join_token_id, token_applied, manifests_sha256, applied_at, nodes_listed,
  nodes_joined, pool_version, upgrade_version, upgrade_since, version`;

interface PoolRow {
  id: string;
  owner_tenant_id: string;
  site_id: string;
  class: string;
  agent: string;
  policy: Record<string, unknown> | string;
  archived: boolean;
  version: string | number;
}

/** The view `kubernetes.substrate.*` events and tests read. */
export interface SubstrateView {
  poolId: string;
  tenantId: string;
  providerAccountId: string;
  mode: 'create' | 'adopt';
  clusterId?: string;
  state: SubstrateState;
  message?: string;
  nodesListed?: number;
  nodesJoined?: number;
  /** `upgrades: 'drain'`: the version drained for, and since when, until the cluster runs it. */
  upgrade?: { version: string; since: number };
}

export function substrateView(row: SubstrateRow): SubstrateView {
  return {
    poolId: row.pool_id,
    tenantId: row.tenant_id,
    providerAccountId: row.provider_account_id,
    mode: row.mode,
    ...(row.cluster_id !== null ? { clusterId: row.cluster_id } : {}),
    state: row.state,
    ...(row.message !== null ? { message: row.message } : {}),
    ...(row.nodes_listed !== null ? { nodesListed: Number(row.nodes_listed) } : {}),
    ...(row.nodes_joined !== null ? { nodesJoined: Number(row.nodes_joined) } : {}),
    ...(row.upgrade_version !== null && row.upgrade_since !== null
      ? { upgrade: { version: row.upgrade_version, since: new Date(row.upgrade_since).getTime() } }
      : {}),
  };
}

/** `kubernetesSubstrates.get`: a pool's substrate, for the pool owner (never its token id or a credential). */
export async function getSubstrate(
  sql: Pick<SqlExecutor, 'query'>,
  input: { tenantId: string; poolId: string },
): Promise<SubstrateView> {
  const { rows } = await sql.query<SubstrateRow>(
    `SELECT ${substrateColumns} FROM kubernetes_pool_substrates WHERE pool_id = $1 AND tenant_id = $2`,
    [input.poolId, input.tenantId],
  );
  if (!rows[0]) throw new ComputeError('NOT_FOUND', `Pool ${input.poolId} has no substrate`);
  return substrateView(rows[0]);
}

export async function readSubstrate(
  tx: SqlTx,
  poolId: string,
  options: { lock?: boolean } = {},
): Promise<SubstrateRow | undefined> {
  const { rows } = await tx.query<SubstrateRow>(
    `SELECT ${substrateColumns} FROM kubernetes_pool_substrates WHERE pool_id = $1${options.lock ? ' FOR UPDATE' : ''}`,
    [poolId],
  );
  return rows[0];
}

async function publishSubstrate(
  deps: Pick<KubernetesDeps, 'events'>,
  tx: SqlTx,
  row: Pick<SubstrateRow, 'pool_id' | 'tenant_id'>,
  type: string,
  data: Record<string, Json> = {},
): Promise<void> {
  await deps.events.publish(tx, {
    type,
    tenantId: row.tenant_id,
    subject: `pool/${row.pool_id}`,
    data: { poolId: row.pool_id, ...data },
  });
}

/** The cluster row name of a substrate (`pool-` and the pool id's body; a GKE-style resource name). */
export function substrateClusterName(poolId: string): string {
  const body = poolId.slice(poolId.indexOf('_') + 1).toLowerCase().replace(/[^a-z0-9]/g, '');
  return `pool-${body.slice(0, 30)}`;
}

/**
 * The provider name of a flavor's node pool in an ADOPTED cluster: `bc-<the pool id's last 6 characters>-<flavor>`.
 * ProviderKubernetes cannot list a cluster's node pools, and `ensureNodePool` / `deleteNodePool` address a pool by
 * name, so a flavor named like one of the tenant's own pools (`default-pool`) would resize it and, on teardown,
 * delete it. The prefix keeps the substrate's pools apart from anything it did not create. A created cluster is the
 * substrate's own: its node pools are named as the flavors are.
 */
export function substrateNodePoolName(poolId: string, flavor: string): string {
  const body = poolId.slice(poolId.indexOf('_') + 1).toLowerCase().replace(/[^a-z0-9]/g, '');
  return `bc-${body.slice(-6).padStart(6, '0')}-${flavor}`;
}

/** The node pool name of a flavor: prefixed in an adopted cluster (`substrateNodePoolName`). */
const nodePoolNameOf = (mode: 'create' | 'adopt', poolId: string, flavor: SubstrateFlavor): string =>
  mode === 'adopt' ? substrateNodePoolName(poolId, flavor.name) : flavor.name;

/** The labels of a flavor's node pool: the substrate label, and `capacity: spot` for Spot. */
export function flavorLabels(poolId: string, flavor: SubstrateFlavor): Record<string, string> {
  return { [substratePoolLabel]: poolId, ...(flavor.spot ? { [substrateCapacityLabel]: 'spot' } : {}) };
}

const createSpecOf = (create: SubstrateCreate): Record<string, Json> => ({
  releaseChannel: create.releaseChannel,
  ...(create.version !== undefined ? { version: create.version } : {}),
  authorizedNetworks: [...create.authorizedNetworks].sort(),
});

// --- establishing ---------------------------------------------------------------------------------------------------

/** Why a substrate cannot be established now: written to its row as `error`. */
class Refused extends Error {}

async function insertFlavorPool(
  tx: SqlTx,
  input: {
    clusterId: string;
    tenantId: string;
    poolId: string;
    flavor: SubstrateFlavor;
    initial: boolean;
    mode: 'create' | 'adopt';
  },
): Promise<string> {
  const { flavor } = input;
  const id = newId('knp');
  await tx.query(
    `INSERT INTO kubernetes_node_pools (id, cluster_id, tenant_id, name, machine_type, node_count, autoscaling_min,
                                        autoscaling_max, disk_gib, disk_type, spot, accelerator_type,
                                        accelerator_count, zones, labels, taints, initial, state, desired_state,
                                        created_by, substrate_pool_id, version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, $10, $11, $12, $13::jsonb, $14::jsonb, '[]'::jsonb, $15,
             'pending', 'present', $16, $17, 1)`,
    [
      id,
      input.clusterId,
      input.tenantId,
      nodePoolNameOf(input.mode, input.poolId, flavor),
      flavor.machineType,
      flavor.nodes,
      flavor.autoscaling?.minNodes ?? null,
      flavor.autoscaling?.maxNodes ?? null,
      flavor.diskGiB ?? null,
      flavor.spot,
      flavor.gpus?.type ?? null,
      flavor.gpus?.count ?? null,
      JSON.stringify(flavor.zones ?? []),
      JSON.stringify(flavorLabels(input.poolId, flavor)),
      input.initial,
      substrateCreator,
      input.poolId,
    ],
  );
  return id;
}

/**
 * Records the cluster of a substrate (the caller holds the substrate row, or is inserting it): checks the pool, the
 * account (the pool owner's), that its provider has managed Kubernetes and the location; then inserts the cluster
 * row and its node pools and wakes the cluster reconciler. Throws `Refused` with what to fix.
 */
async function establishCluster(
  deps: SubstrateDeps,
  tx: SqlTx,
  pool: PoolRow,
  substrate: PoolSubstrate,
): Promise<{ clusterId: string; createSpec: Record<string, Json> | null }> {
  if (pool.agent !== 'bcd')
    throw new Refused(`Pool ${pool.id} runs no daemon (agent ${pool.agent}); a substrate pool runs bcd`);
  if (!deps.substrate) throw new Refused('kubernetes({ substrate }) is not configured: no agent runs bcd on the cluster');
  if (!deps.pki) throw new Refused('The control plane mints no join tokens (no ctx.pki)');
  const account = await readAccount(tx, substrate.account, pool.owner_tenant_id);
  if (!account) throw new Refused(`Provider account ${substrate.account} not found among the pool owner's accounts`);
  let provider;
  try {
    provider = await accountKubernetes(deps, account);
  } catch (error) {
    throw new Refused(text(error));
  }
  if ('adopt' in substrate.cluster)
    return establishAdopted(deps, tx, pool, substrate, account, provider, substrate.cluster.adopt);
  const create = substrate.cluster.create;
  let region: string;
  try {
    region = regionOf(provider, create.location);
  } catch (error) {
    throw new Refused(text(error));
  }
  const clusterId = newId('kcl');
  const name = substrateClusterName(pool.id);
  const taken = await tx.query(
    `SELECT 1 FROM kubernetes_clusters WHERE tenant_id = $1 AND name = $2 AND state <> 'deleted'`,
    [pool.owner_tenant_id, name],
  );
  if (taken.rows.length > 0) throw new Refused(`A cluster named ${name} already exists in the pool owner's tenant`);
  let network: { networkId: string; subnetId: string } | undefined;
  if (create.networkId !== undefined)
    try {
      network = await clusterNetwork(tx, {
        tenantId: pool.owner_tenant_id,
        accountId: account.id,
        networkId: create.networkId,
        region,
      });
    } catch (error) {
      if (!isComputeError(error)) throw error;
      throw new Refused(text(error));
    }
  await tx.query(
    `INSERT INTO kubernetes_clusters (id, tenant_id, project_id, pool_id, provider_account_id, network_id, subnet_id,
                                      name, description, mode, location, region, release_channel, requested_version,
                                      authorized_networks, private_nodes, provider_name, state, desired_state,
                                      created_by, idempotency_key, request_hash, version, substrate_pool_id)
     VALUES ($1, $2, NULL, $3, $4, $17, $18, $5, $6, 'standard', $7, $8, $9, $10, $11::jsonb, $12, $13, 'pending',
             'present', $14, $15, decode($16, 'hex'), 1, $3)`,
    [
      clusterId,
      pool.owner_tenant_id,
      pool.id,
      account.id,
      name,
      `The substrate of pool ${pool.id}`,
      create.location,
      region,
      create.releaseChannel,
      create.version ?? null,
      JSON.stringify(create.authorizedNetworks),
      create.privateNodes,
      providerClusterName(clusterId),
      substrateCreator,
      `substrate:${clusterId}`,
      await sha256Hex(substrateIdentity(substrate)),
      network?.networkId ?? null,
      network?.subnetId ?? null,
    ],
  );
  for (const flavor of substrate.flavors)
    await insertFlavorPool(tx, {
      clusterId,
      tenantId: pool.owner_tenant_id,
      poolId: pool.id,
      flavor,
      initial: true,
      mode: 'create',
    });
  await deps.authz.upsert(tx, {
    type: 'kubernetes-cluster',
    id: clusterId,
    tenantId: pool.owner_tenant_id,
    attributes: { providerAccountId: account.id, poolId: pool.id, mode: 'standard', location: create.location },
    parentType: 'tenant',
    parentId: pool.owner_tenant_id,
  });
  await deps.work.enqueue(tx, clustersWork, clusterId);
  await publishCluster(deps, tx, { id: clusterId, tenant_id: pool.owner_tenant_id }, 'kubernetes.cluster.created', {
    poolId: pool.id,
    providerAccountId: account.id,
    name,
    mode: 'standard',
    location: create.location,
    substrate: true,
  });
  return { clusterId, createSpec: createSpecOf(create) };
}

/** A location in a provider cluster id (`…/locations/<l>/…`, GKE's `<l>/<name>`), else the account's first. */
function adoptedLocation(adoptId: string, provider: { zones: string[]; regions: string[] }): string {
  const found =
    /\/locations\/([a-z][a-z0-9-]{1,62})\//.exec(adoptId)?.[1] ??
    /^([a-z][a-z0-9-]{1,62})\/[^/]+$/.exec(adoptId)?.[1];
  return found ?? provider.regions[0] ?? provider.zones[0] ?? 'unknown';
}

/**
 * `cluster: { adopt }`: an `adopted` cluster row for the provider's cluster (the cluster reconciler reads it with
 * `getCluster`, never creates, changes or deletes it) and a node pool row per flavor (created in it under a name of
 * its own, `substrateNodePoolName`, and deleted with the substrate). One substrate per adopted cluster.
 */
async function establishAdopted(
  deps: SubstrateDeps,
  tx: SqlTx,
  pool: PoolRow,
  substrate: PoolSubstrate,
  account: { id: string },
  provider: { zones: string[]; regions: string[] },
  adoptId: string,
): Promise<{ clusterId: string; createSpec: null }> {
  const { rows: taken } = await tx.query<{ substrate_pool_id: string | null }>(
    `SELECT substrate_pool_id FROM kubernetes_clusters
      WHERE provider_account_id = $1 AND provider_id = $2 AND state <> 'deleted' LIMIT 1`,
    [account.id, adoptId],
  );
  if (taken[0])
    throw new Refused(
      taken[0].substrate_pool_id !== null
        ? `Cluster ${adoptId} is already pool ${taken[0].substrate_pool_id}'s substrate`
        : `Cluster ${adoptId} is managed by better-compute already (kubernetesClusters)`,
    );
  const name = substrateClusterName(pool.id);
  const named = await tx.query(
    `SELECT 1 FROM kubernetes_clusters WHERE tenant_id = $1 AND name = $2 AND state <> 'deleted'`,
    [pool.owner_tenant_id, name],
  );
  if (named.rows.length > 0) throw new Refused(`A cluster named ${name} already exists in the pool owner's tenant`);
  const clusterId = newId('kcl');
  const location = adoptedLocation(adoptId, provider);
  const region = /-[a-z]$/.test(location) ? zoneRegion(location) : location;
  await tx.query(
    `INSERT INTO kubernetes_clusters (id, tenant_id, project_id, pool_id, provider_account_id, network_id, subnet_id,
                                      name, description, mode, location, region, release_channel, requested_version,
                                      authorized_networks, private_nodes, provider_name, provider_id, state,
                                      desired_state, created_by, idempotency_key, request_hash, version, adopted,
                                      substrate_pool_id)
     VALUES ($1, $2, NULL, $3, $4, NULL, NULL, $5, $6, 'standard', $7, $8, 'regular', NULL, '[]'::jsonb, false, $9,
             $10, 'pending', 'present', $11, $12, decode($13, 'hex'), 1, true, $3)`,
    [
      clusterId,
      pool.owner_tenant_id,
      pool.id,
      account.id,
      name,
      `Adopted by the substrate of pool ${pool.id}`,
      location,
      region,
      (adoptId.split('/').pop() ?? adoptId).slice(0, 63),
      adoptId,
      substrateCreator,
      `substrate:${clusterId}`,
      await sha256Hex(substrateIdentity(substrate)),
    ],
  );
  for (const flavor of substrate.flavors)
    await insertFlavorPool(tx, {
      clusterId,
      tenantId: pool.owner_tenant_id,
      poolId: pool.id,
      flavor,
      initial: false,
      mode: 'adopt',
    });
  await deps.authz.upsert(tx, {
    type: 'kubernetes-cluster',
    id: clusterId,
    tenantId: pool.owner_tenant_id,
    attributes: { providerAccountId: account.id, poolId: pool.id, mode: 'standard', location },
    parentType: 'tenant',
    parentId: pool.owner_tenant_id,
  });
  await deps.work.enqueue(tx, clustersWork, clusterId);
  await publishCluster(deps, tx, { id: clusterId, tenant_id: pool.owner_tenant_id }, 'kubernetes.cluster.created', {
    poolId: pool.id,
    providerAccountId: account.id,
    name,
    mode: 'standard',
    location,
    substrate: true,
    adopted: true,
  });
  return { clusterId, createSpec: null };
}

// --- converging the rows: flavors and create settings ----------------------------------------------------------------

const sameZones = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join();

/**
 * Makes the substrate's node pool rows match its flavors: new flavors get a node pool, removed ones are deleted,
 * node counts and autoscaling change in place. A flavor whose shape changed (machine type, GPUs, Spot, disk, zones)
 * cannot change in place: it is reported, and nothing is done to it.
 */
async function syncFlavors(
  deps: SubstrateDeps,
  tx: SqlTx,
  row: SubstrateRow,
  substrate: PoolSubstrate,
): Promise<string[]> {
  const clusterId = row.cluster_id!;
  const { rows: pools } = await tx.query<NodePoolRow>(
    `SELECT ${nodePoolColumns} FROM kubernetes_node_pools
      WHERE cluster_id = $1 AND substrate_pool_id = $2 AND state <> 'deleted' ORDER BY name FOR UPDATE`,
    [clusterId, row.pool_id],
  );
  const problems: string[] = [];
  let changed = false;
  const nameOf = (flavor: SubstrateFlavor) => nodePoolNameOf(row.mode, row.pool_id, flavor);
  for (const flavor of substrate.flavors) {
    const name = nameOf(flavor);
    const live = pools.find((pool) => pool.name === name && pool.desired_state === 'present');
    const leaving = pools.find((pool) => pool.name === name && pool.desired_state === 'deleted');
    if (!live) {
      if (leaving) continue; // re-added while its old node pool is still being deleted: next run
      await insertFlavorPool(tx, {
        clusterId,
        tenantId: row.tenant_id,
        poolId: row.pool_id,
        flavor,
        initial: false,
        mode: row.mode,
      });
      await publishCluster(deps, tx, { id: clusterId, tenant_id: row.tenant_id }, 'kubernetes.nodepool.created', {
        name,
        substratePoolId: row.pool_id,
      });
      changed = true;
      continue;
    }
    const differs: string[] = [];
    if (live.machine_type !== flavor.machineType) differs.push('machineType');
    if ((live.accelerator_type ?? null) !== (flavor.gpus?.type ?? null) || (live.accelerator_count === null ? null : Number(live.accelerator_count)) !== (flavor.gpus?.count ?? null))
      differs.push('gpus');
    if (live.spot !== flavor.spot) differs.push('spot');
    if ((live.disk_gib === null ? null : Number(live.disk_gib)) !== (flavor.diskGiB ?? null)) differs.push('diskGiB');
    if (!sameZones(json(live.zones), flavor.zones ?? [])) differs.push('zones');
    if (differs.length > 0) {
      problems.push(
        `flavor ${flavor.name}: ${differs.join(', ')} cannot change in place; add the new shape under another name and remove this one`,
      );
      continue;
    }
    const min = flavor.autoscaling?.minNodes ?? null;
    const max = flavor.autoscaling?.maxNodes ?? null;
    if (
      Number(live.node_count) !== flavor.nodes ||
      (live.autoscaling_min === null ? null : Number(live.autoscaling_min)) !== min ||
      (live.autoscaling_max === null ? null : Number(live.autoscaling_max)) !== max
    ) {
      await tx.query(
        `UPDATE kubernetes_node_pools
            SET node_count = $2, autoscaling_min = $3, autoscaling_max = $4, message = NULL, version = version + 1,
                updated_at = compute_now(),
                state = CASE WHEN state IN ('ready', 'error', 'updating') THEN 'updating' ELSE state END
          WHERE id = $1`,
        [live.id, flavor.nodes, min, max],
      );
      changed = true;
    }
  }
  for (const pool of pools) {
    if (pool.desired_state !== 'present') continue;
    if (substrate.flavors.some((flavor) => nameOf(flavor) === pool.name)) continue;
    await tx.query(
      `UPDATE kubernetes_node_pools
          SET desired_state = 'deleted', state = 'deleting', message = NULL, version = version + 1,
              updated_at = compute_now()
        WHERE id = $1`,
      [pool.id],
    );
    changed = true;
  }
  if (changed) await reopen(deps, tx, clusterId);
  return problems;
}

/** The NoSchedule reason on a pool's nodes while an `upgrades: 'drain'` upgrade drains them (until it is done). */
export const substrateUpgradeReason = 'substrate-upgrade';
/** How often a drain before an upgrade looks again for the bookings it waits on. */
export const substrateUpgradeRecheckMs = 60_000;

/** Bookings on the pool's nodes that have not ended. */
async function liveBookings(sql: Pick<SqlTx, 'query'>, poolId: string): Promise<number> {
  const { rows } = await sql.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM allocations a JOIN nodes n ON n.id = a.node_id
      WHERE n.pool_id = $1 AND a.released_at IS NULL
        AND (upper_inf(a.during) OR upper(a.during) > compute_now())`,
    [poolId],
  );
  return Number(rows[0]?.count ?? 0);
}

/** Whether a cluster runs `version` (`1.34` runs as `1.34.2-gke.1100`). */
function runsVersion(actual: string | null, version: string): boolean {
  if (actual === null) return false;
  return actual === version || actual.startsWith(`${version}.`) || actual.startsWith(`${version}-`);
}

/**
 * Pushes a changed release channel, version or authorized networks to the created cluster (an upgrade). With
 * `upgrades: 'drain'`, a version bump waits: the pool's nodes go NoSchedule `substrate-upgrade` (no new bookings),
 * and the version is pushed once their bookings ended, or once the drain took `drainTimeout`; the other settings
 * are pushed at once meanwhile. Returns what was pushed, and the drain still waiting.
 */
async function syncCreateSpec(
  deps: SubstrateDeps,
  tx: SqlTx,
  row: SubstrateRow,
  substrate: PoolSubstrate,
  create: SubstrateCreate,
): Promise<{ pushed?: Record<string, Json>; drain?: { version: string; bookings: number } }> {
  const wanted = createSpecOf(create);
  const pushed = row.create_spec === null ? null : json(row.create_spec);
  if (pushed !== null && canonical(pushed) === canonical(wanted)) return {};
  let target = wanted;
  let drain: { version: string; bookings: number } | undefined;
  const bump =
    substrate.upgrades === 'drain' &&
    create.version !== undefined &&
    pushed !== null &&
    pushed.version !== create.version;
  if (bump) {
    const version = create.version!;
    let since =
      row.upgrade_version === version && row.upgrade_since !== null ? new Date(row.upgrade_since).getTime() : undefined;
    await tx.query(
      `UPDATE nodes SET no_schedule_reasons = array_append(no_schedule_reasons, $2), version = version + 1
        WHERE pool_id = $1 AND provision_state NOT IN ('retiring', 'retired') AND NOT ($2 = ANY(no_schedule_reasons))`,
      [row.pool_id, substrateUpgradeReason],
    );
    const bookings = await liveBookings(tx, row.pool_id);
    if (since === undefined) {
      since = deps.clock.now();
      await tx.query(
        `UPDATE kubernetes_pool_substrates SET upgrade_version = $2, upgrade_since = compute_now(),
                version = version + 1 WHERE pool_id = $1`,
        [row.pool_id, version],
      );
      await publishSubstrate(deps, tx, row, 'kubernetes.substrate.draining', { version, bookings });
    }
    const timedOut = substrate.drainTimeoutMs !== undefined && deps.clock.now() - since >= substrate.drainTimeoutMs;
    if (bookings > 0 && !timedOut) {
      // Hold the version; push the rest.
      target = { ...wanted };
      delete target.version;
      if (pushed.version !== undefined) target.version = pushed.version;
      drain = { version, bookings };
    } else
      await publishSubstrate(deps, tx, row, 'kubernetes.substrate.upgrading', { version, drained: bookings === 0 });
  }
  if (pushed !== null && canonical(pushed) === canonical(target)) return { ...(drain ? { drain } : {}) };
  await tx.query(
    `UPDATE kubernetes_clusters
        SET requested_version = $2, release_channel = $3, authorized_networks = $4::jsonb
      WHERE id = $1 AND desired_state = 'present'`,
    [
      row.cluster_id,
      typeof target.version === 'string' ? target.version : null,
      target.releaseChannel,
      JSON.stringify(target.authorizedNetworks),
    ],
  );
  await reopen(deps, tx, row.cluster_id!);
  return { pushed: target, ...(drain ? { drain } : {}) };
}

/**
 * Lifts a drain's `substrate-upgrade` once the cluster runs the version it drained for, or once that version is no
 * longer the one wanted (the policy changed back, or `upgrades` is `surge` again).
 */
async function finishUpgrade(
  tx: SqlTx,
  row: SubstrateRow,
  wantedVersion: string | undefined,
  cluster: ClusterRow | undefined,
): Promise<void> {
  if (row.upgrade_version === null) return;
  const done =
    wantedVersion !== row.upgrade_version ||
    (cluster !== undefined && cluster.state === 'ready' && runsVersion(cluster.kubernetes_version, row.upgrade_version));
  if (!done) return;
  await tx.query(
    `UPDATE nodes SET no_schedule_reasons = array_remove(no_schedule_reasons, $2), version = version + 1
      WHERE pool_id = $1 AND $2 = ANY(no_schedule_reasons)`,
    [row.pool_id, substrateUpgradeReason],
  );
  await tx.query(
    `UPDATE kubernetes_pool_substrates SET upgrade_version = NULL, upgrade_since = NULL, version = version + 1
      WHERE pool_id = $1`,
    [row.pool_id],
  );
  row.upgrade_version = null;
  row.upgrade_since = null;
  row.version = Number(row.version) + 1;
}

// --- the reconcile step -------------------------------------------------------------------------------------------

interface Plan {
  row: SubstrateRow;
  pool: PoolRow;
  substrate: PoolSubstrate;
  cluster?: ClusterRow;
  /** An `upgrades: 'drain'` version bump still waiting for bookings to end. */
  drain?: { version: string; bookings: number };
}

/** Writes the substrate's state (guarded by the version decided on) and publishes the transitions. */
async function setState(
  deps: SubstrateDeps,
  sql: SqlExecutor,
  row: SubstrateRow,
  update: {
    state: SubstrateState;
    message?: string | null;
    fields?: Partial<
      Pick<SubstrateRow, 'manifests_sha256' | 'nodes_listed' | 'nodes_joined' | 'join_token_id' | 'token_applied'>
    > & { applied?: boolean };
  },
): Promise<boolean> {
  return sql.transaction(async (tx) => {
    const fields = update.fields ?? {};
    const { rows } = await tx.query<{ pool_id: string }>(
      `UPDATE kubernetes_pool_substrates
          SET state = $3, message = $4, updated_at = compute_now(),
              manifests_sha256 = CASE WHEN $5 THEN $6 ELSE manifests_sha256 END,
              applied_at = CASE WHEN $5 THEN compute_now() ELSE applied_at END,
              nodes_listed = coalesce($7, nodes_listed),
              nodes_joined = coalesce($8, nodes_joined),
              join_token_id = CASE WHEN $9 THEN $10 ELSE join_token_id END,
              token_applied = coalesce($11, token_applied)
        WHERE pool_id = $1 AND version = $2
        RETURNING pool_id`,
      [
        row.pool_id,
        row.version,
        update.state,
        update.message ?? null,
        fields.applied === true,
        fields.manifests_sha256 ?? null,
        fields.nodes_listed ?? null,
        fields.nodes_joined ?? null,
        'join_token_id' in fields,
        fields.join_token_id ?? null,
        fields.token_applied ?? null,
      ],
    );
    if (rows.length === 0) return false;
    if (update.state === 'ready' && row.state !== 'ready')
      await publishSubstrate(deps, tx, row, 'kubernetes.substrate.ready', {
        clusterId: row.cluster_id ?? '',
        nodes: fields.nodes_listed ?? row.nodes_listed ?? 0,
      });
    else if (update.state === 'error' && (row.state !== 'error' || row.message !== (update.message ?? null)))
      await publishSubstrate(deps, tx, row, 'kubernetes.substrate.error', { message: update.message ?? '' });
    row.state = update.state;
    row.message = update.message ?? null;
    return true;
  });
}

/** Reads the pool and its substrate row, and records or re-records the substrate (one transaction). */
async function prepare(
  deps: SubstrateDeps,
  sql: SqlExecutor,
  poolId: string,
): Promise<{ plan?: Plan; teardown?: SubstrateRow; again?: boolean }> {
  return sql.transaction(async (tx) => {
    const { rows } = await tx.query<PoolRow>(
      `SELECT id, owner_tenant_id, site_id, class, agent, policy, version, archived_at IS NOT NULL AS archived
         FROM pools WHERE id = $1`,
      [poolId],
    );
    const pool = rows[0];
    let row = await readSubstrate(tx, poolId, { lock: true });
    let substrate: PoolSubstrate | undefined;
    let parseError: string | undefined;
    let drain: Plan['drain'];
    if (pool) {
      try {
        substrate = parsePoolSubstrate(json(pool.policy));
      } catch (error) {
        parseError = text(error);
      }
    }
    const wanted = pool !== undefined && !pool.archived && (substrate !== undefined || parseError !== undefined);
    if (!wanted) return row && row.state !== 'deleted' ? { teardown: row } : {};
    if (parseError !== undefined || !substrate) {
      if (row && row.state !== 'deleted' && (row.state !== 'error' || row.message !== parseError)) {
        await tx.query(
          `UPDATE kubernetes_pool_substrates SET state = 'error', message = $2, updated_at = compute_now(),
                  version = version + 1 WHERE pool_id = $1`,
          [poolId, parseError],
        );
        await publishSubstrate(deps, tx, row, 'kubernetes.substrate.error', { message: parseError ?? '' });
      }
      return {};
    }
    const identity = substrateIdentity(substrate);
    if (row && row.desired_state === 'deleted' && row.state !== 'deleted')
      // Removed and added again while the old one is still being torn down: finish that first.
      return { teardown: row };
    if (!row || row.state === 'deleted') {
      const fresh = {
        mode: 'create' in substrate.cluster ? 'create' : 'adopt',
        adopt: 'adopt' in substrate.cluster ? substrate.cluster.adopt : null,
      };
      if (row)
        await tx.query(
          `UPDATE kubernetes_pool_substrates
              SET tenant_id = $2, provider_account_id = $3, mode = $4, adopt_id = $5, identity = $6, cluster_id = NULL,
                  create_spec = NULL, state = 'pending', desired_state = 'present', message = NULL,
                  join_token_id = NULL, token_applied = false, manifests_sha256 = NULL, applied_at = NULL,
                  nodes_listed = NULL, nodes_joined = NULL, upgrade_version = NULL, upgrade_since = NULL,
                  deleted_at = NULL, updated_at = compute_now(),
                  version = version + 1
            WHERE pool_id = $1`,
          [poolId, pool!.owner_tenant_id, substrate.account, fresh.mode, fresh.adopt, identity],
        );
      else
        await tx.query(
          `INSERT INTO kubernetes_pool_substrates (pool_id, tenant_id, provider_account_id, mode, adopt_id, identity,
                                                   state, desired_state, version)
           VALUES ($1, $2, $3, $4, $5, $6, 'pending', 'present', 1)`,
          [poolId, pool!.owner_tenant_id, substrate.account, fresh.mode, fresh.adopt, identity],
        );
      row = (await readSubstrate(tx, poolId, { lock: true }))!;
      await publishSubstrate(deps, tx, row, 'kubernetes.substrate.created', {
        providerAccountId: substrate.account,
        mode: row.mode,
      });
    } else if (row.identity !== identity) {
      const message =
        "The substrate's account or cluster changed; it is never moved in place. Archive the pool (which tears the substrate down) and create another";
      if (row.state !== 'error' || row.message !== message) {
        await tx.query(
          `UPDATE kubernetes_pool_substrates SET state = 'error', message = $2, updated_at = compute_now(),
                  version = version + 1 WHERE pool_id = $1`,
          [poolId, message],
        );
        await publishSubstrate(deps, tx, row, 'kubernetes.substrate.error', { message });
      }
      return {};
    }
    if (row.cluster_id === null) {
      try {
        const established = await establishCluster(deps, tx, pool!, substrate);
        await tx.query(
          `UPDATE kubernetes_pool_substrates
              SET cluster_id = $2, create_spec = $3::jsonb, state = 'provisioning', message = NULL,
                  updated_at = compute_now(), version = version + 1
            WHERE pool_id = $1`,
          [poolId, established.clusterId, established.createSpec ? JSON.stringify(established.createSpec) : null],
        );
      } catch (error) {
        if (!(error instanceof Refused)) throw error;
        if (row.state !== 'error' || row.message !== error.message) {
          await tx.query(
            `UPDATE kubernetes_pool_substrates SET state = 'error', message = $2, updated_at = compute_now(),
                    version = version + 1 WHERE pool_id = $1`,
            [poolId, error.message.slice(0, 500)],
          );
          await publishSubstrate(deps, tx, row, 'kubernetes.substrate.error', { message: error.message.slice(0, 500) });
        }
        return {};
      }
      row = (await readSubstrate(tx, poolId, { lock: true }))!;
    } else {
      const problems = await syncFlavors(deps, tx, row, substrate);
      if ('create' in substrate.cluster) {
        const synced = await syncCreateSpec(deps, tx, row, substrate, substrate.cluster.create);
        drain = synced.drain;
        if (synced.pushed)
          await tx.query(
            `UPDATE kubernetes_pool_substrates SET create_spec = $2::jsonb, version = version + 1 WHERE pool_id = $1`,
            [poolId, JSON.stringify(synced.pushed)],
          );
      }
      if (problems.length > 0) {
        const message = problems.join('; ').slice(0, 500);
        if (row.state !== 'error' || row.message !== message) {
          await tx.query(
            `UPDATE kubernetes_pool_substrates SET state = 'error', message = $2, updated_at = compute_now(),
                    version = version + 1 WHERE pool_id = $1`,
            [poolId, message],
          );
          await publishSubstrate(deps, tx, row, 'kubernetes.substrate.error', { message });
        }
        return {};
      }
      row = (await readSubstrate(tx, poolId, { lock: true }))!;
    }
    if (row.pool_version === null || Number(row.pool_version) !== Number(pool!.version)) {
      await tx.query(`UPDATE kubernetes_pool_substrates SET pool_version = $2 WHERE pool_id = $1`, [
        poolId,
        pool!.version,
      ]);
      row.pool_version = pool!.version;
    }
    const { rows: clusters } = await tx.query<ClusterRow>(
      `SELECT ${clusterColumns} FROM kubernetes_clusters WHERE id = $1`,
      [row.cluster_id],
    );
    if (!drain)
      await finishUpgrade(
        tx,
        row,
        'create' in substrate.cluster && substrate.upgrades === 'drain' ? substrate.cluster.create.version : undefined,
        clusters[0],
      );
    return {
      plan: { row, pool: pool!, substrate, ...(clusters[0] ? { cluster: clusters[0] } : {}), ...(drain ? { drain } : {}) },
    };
  });
}

/**
 * The pool's nodes whose bcd joined and is connected now, or joined and has not connected yet (not retired, not left
 * over from a substrate torn down). One that connected and went away does not count, so a Node replaced by a surge
 * upgrade, a scale-down or a Spot reclaim leaves room for the replacement's token; a bcd pod that only restarted
 * joins again without spending a use.
 */
async function joinedNodes(sql: SqlExecutor, poolId: string): Promise<number> {
  const { rows } = await sql.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM nodes n LEFT JOIN node_sessions s ON s.node_id = n.id
      WHERE n.pool_id = $1 AND n.provision_state NOT IN ('retiring', 'retired')
        AND (n.connectivity = 'connected' OR s.connected_at IS NULL)
        AND NOT ($2 = ANY(n.no_schedule_reasons)) AND NOT ($3 = ANY(n.no_schedule_reasons))`,
    [poolId, substrateTeardownReason, substrateNodeRemovedReason],
  );
  return Number(rows[0]?.count ?? 0);
}

/** The NoSchedule reason on a pool node whose Kubernetes Node is gone (scale-down, Spot reclaim, repair). */
export const substrateNodeRemovedReason = 'substrate-node-removed';

/**
 * Pool nodes whose Kubernetes Node is gone. A pool node maps to its Node by the OS hostname bcd reports (inventory
 * `os.hostname`, the Node name on every managed provider). One that is not connected and whose hostname is absent from
 * the cluster's FULL Node list (not only the substrate's selection: a relabelled Node is not gone) gets NoSchedule
 * `substrate-node-removed`, and its reservations end properly (`endNodeReservations`: bound ones released with their
 * quota refunded once, Spot ones as `preempted`; unbound ones placed again elsewhere). A node with the reason that is
 * connected again under a listed Node loses it. Nodes with no reported hostname are never touched (fail closed).
 * Returns false when the Node list could not be read (nothing changed).
 */
async function removeGoneNodes(
  deps: SubstrateDeps,
  sql: SqlExecutor,
  row: SubstrateRow,
  api: SubstrateClusterApi,
  selected: { nodes: SubstrateNode[]; full: boolean },
  signal: AbortSignal,
): Promise<boolean> {
  if (!deps.inventory || !deps.desired) return true;
  const { rows: candidates } = await sql.query<{ id: string; connectivity: string; removed: boolean }>(
    `SELECT n.id, n.connectivity, ($2 = ANY(n.no_schedule_reasons)) AS removed FROM nodes n
      WHERE n.pool_id = $1 AND n.provision_state NOT IN ('retiring', 'retired')
        AND NOT ($3 = ANY(n.no_schedule_reasons))
        AND (n.connectivity <> 'connected' OR $2 = ANY(n.no_schedule_reasons))
      ORDER BY n.id LIMIT 500`,
    [row.pool_id, substrateNodeRemovedReason, substrateTeardownReason],
  );
  if (candidates.length === 0) return true;
  const hostnames = new Map<string, string>();
  for (const candidate of candidates) {
    const snapshot = await deps.inventory.get(candidate.id);
    const os = snapshot?.sections.os;
    const hostname =
      typeof os === 'object' && os !== null && !Array.isArray(os) ? (os as Record<string, Json>).hostname : undefined;
    if (typeof hostname === 'string' && hostname.length > 0) hostnames.set(candidate.id, hostname);
  }
  if (hostnames.size === 0) return true;
  let names: Set<string>;
  if (selected.full) names = new Set(selected.nodes.map((node) => node.name));
  else {
    const listed = await attempt(deps, row.pool_id, signal, () => api.nodes());
    if (!listed || 'error' in listed) return false;
    names = new Set(listed.value.map((node) => node.name));
  }
  for (const candidate of candidates) {
    const hostname = hostnames.get(candidate.id);
    if (hostname === undefined) continue;
    const gone = !names.has(hostname);
    if (candidate.removed && !gone && candidate.connectivity === 'connected') {
      await sql.query(
        `UPDATE nodes SET no_schedule_reasons = array_remove(no_schedule_reasons, $2), version = version + 1
          WHERE id = $1 AND $2 = ANY(no_schedule_reasons)`,
        [candidate.id, substrateNodeRemovedReason],
      );
      continue;
    }
    if (candidate.removed || !gone) continue;
    await sql.transaction(async (tx) => {
      // Re-read: one that reconnected meanwhile is not gone. Capacity's lock order (reservations, quota, then
      // nodes) is kept: the reservations end first, the node row is written last.
      const { rows: still } = await tx.query<{ id: string }>(
        `SELECT id FROM nodes WHERE id = $1 AND connectivity <> 'connected' AND NOT ($2 = ANY(no_schedule_reasons))`,
        [candidate.id, substrateNodeRemovedReason],
      );
      if (still.length === 0) return;
      const ended = await endNodeReservations(
        {
          clock: deps.clock,
          events: deps.events,
          work: deps.work,
          desired: deps.desired!,
        },
        tx,
        candidate.id,
        'node-removed',
      );
      await tx.query(
        `UPDATE nodes SET no_schedule_reasons = array_append(no_schedule_reasons, $2), version = version + 1
          WHERE id = $1 AND NOT ($2 = ANY(no_schedule_reasons))`,
        [candidate.id, substrateNodeRemovedReason],
      );
      await publishSubstrate(deps, tx, row, 'kubernetes.substrate.node-removed', {
        nodeId: candidate.id,
        kubernetesNode: hostname,
        released: ended.released.length,
        requeued: ended.requeued.length,
      });
    });
  }
  return true;
}

// --- what the substrate owns on a cluster ----------------------------------------------------------------------------

/**
 * Every object the substrate applies carries `better-compute.dev/substrate-pool: <pool id>`: what it owns. On an
 * adopted cluster an object of the same name that exists without that label (a `bcd-system` Namespace or a `bcd`
 * DaemonSet the tenant installed themselves) is never taken over (apply is a forced server-side apply), and teardown
 * deletes only objects carrying the label, so a Namespace the substrate did not create is never deleted.
 */
function owned(poolId: string, objects: readonly SubstrateObject[]): SubstrateObject[] {
  return objects.map((object) => ({
    ...object,
    metadata: { ...object.metadata, labels: { ...(object.metadata.labels ?? {}), [substratePoolLabel]: poolId } },
  }));
}

const describeObject = (object: SubstrateObjectRef) =>
  `${object.kind} ${object.metadata.namespace ? `${object.metadata.namespace}/` : ''}${object.metadata.name}`;
const refOf = (object: SubstrateObjectRef): SubstrateObjectRef => ({
  apiVersion: object.apiVersion,
  kind: object.kind,
  metadata: {
    name: object.metadata.name,
    ...(object.metadata.namespace !== undefined ? { namespace: object.metadata.namespace } : {}),
  },
});

/** Objects in `objects` that exist on the cluster and are not this substrate's (by its label). */
async function foreignObjects(
  api: SubstrateClusterApi,
  poolId: string,
  objects: readonly SubstrateObjectRef[],
): Promise<string[]> {
  const foreign: string[] = [];
  for (const object of objects) {
    const found = await api.get(refOf(object));
    if (found && found.metadata.labels[substratePoolLabel] !== poolId) foreign.push(describeObject(object));
  }
  return foreign;
}

/** Deletes an object only when it carries the substrate's label; one that is gone (or not ours) is left alone. */
async function removeOwned(api: SubstrateClusterApi, poolId: string, object: SubstrateObjectRef): Promise<boolean> {
  const found = await api.get(refOf(object));
  if (!found || found.metadata.labels[substratePoolLabel] !== poolId) return false;
  await api.remove(refOf(object));
  return true;
}

/** Whether a token id is still usable for `uses` more joins and lives past the next few runs. */
async function tokenLive(sql: SqlExecutor, tokenId: string, uses: number): Promise<boolean> {
  const { rows } = await sql.query<{ ok: boolean }>(
    `SELECT (revoked_at IS NULL AND uses_left >= $2 AND expires_at > compute_now() + interval '2 minutes') AS ok
       FROM join_tokens WHERE id = $1`,
    [tokenId, uses],
  );
  return rows[0]?.ok === true;
}

async function revokeToken(tx: SqlTx, tokenId: string | null): Promise<void> {
  if (tokenId === null) return;
  await tx.query(`UPDATE join_tokens SET revoked_at = compute_now() WHERE id = $1 AND revoked_at IS NULL`, [tokenId]);
}

/** One step of one pool's substrate. Returns the next wake-up, or undefined when settled. */
export async function reconcileSubstrate(
  deps: SubstrateDeps,
  sql: SqlExecutor,
  poolId: string,
  signal: AbortSignal,
): Promise<number | undefined> {
  const prepared = await prepare(deps, sql, poolId);
  const now = () => deps.clock.now();
  if (prepared.teardown) return teardown(deps, sql, prepared.teardown, signal);
  const plan = prepared.plan;
  if (!plan) return undefined;
  const { row, cluster } = plan;
  if (!cluster) return now() + substratePollMs;
  if (cluster.state === 'error') {
    await setState(deps, sql, row, { state: 'error', message: `cluster: ${cluster.message ?? 'in error'}` });
    return undefined;
  }
  if (cluster.provider_id === null || !['ready', 'updating'].includes(cluster.state)) {
    await setState(deps, sql, row, { state: row.state === 'ready' ? 'updating' : 'provisioning' });
    return now() + substratePollMs;
  }
  return applyBcd(deps, sql, plan, cluster, signal);
}

/** Runs a call against the provider or the cluster API; a transient failure is `undefined` (try later). */
async function attempt<T>(
  deps: SubstrateDeps,
  poolId: string,
  signal: AbortSignal,
  op: () => Promise<T>,
): Promise<{ value: T } | { error: string } | undefined> {
  try {
    return { value: await op() };
  } catch (error) {
    if (signal.aborted || (isComputeError(error) && transientCodes.includes(error.code))) {
      deps.log.warn('kubernetes: substrate cluster busy, retrying', { poolId, error: text(error) });
      return undefined;
    }
    return { error: text(error) };
  }
}

/**
 * The cluster is up: mint a credential, list the substrate's Nodes, keep the hosted join token and its Secret only
 * while Nodes outnumber joined nodes, and server-side apply bcd. The credential lives in this function only.
 */
async function applyBcd(
  deps: SubstrateDeps,
  sql: SqlExecutor,
  plan: Plan,
  cluster: ClusterRow,
  signal: AbortSignal,
): Promise<number | undefined> {
  const { row, pool, substrate } = plan;
  const agent = deps.substrate!.agent;
  const retry = () => deps.clock.now() + substrateRetryMs;
  let kubernetes: ProviderKubernetes;
  try {
    const account = await sql.transaction((tx) => readAccount(tx, row.provider_account_id, row.tenant_id));
    if (!account) throw new ComputeError('NOT_FOUND', `Provider account ${row.provider_account_id} not found`);
    kubernetes = (await accountKubernetes(deps, account)).kubernetes;
  } catch (error) {
    await setState(deps, sql, row, { state: 'error', message: text(error) });
    return undefined;
  }
  const call: CallContext = {
    idempotencyKey: `substrate:${row.pool_id}`,
    signal,
    clock: deps.clock,
    secrets: deps.secrets,
    log: deps.log,
  };
  const minted = await attempt(deps, row.pool_id, signal, () =>
    kubernetes.credentials(
      cluster.provider_id!,
      { subject: substrateSubject, role: 'admin', ttlSeconds: substrateCredentialTtlSeconds },
      call,
    ),
  );
  if (!minted) return retry();
  if ('error' in minted) {
    await setState(deps, sql, row, { state: 'error', message: `credentials: ${minted.error}` });
    return undefined;
  }
  const api = agent.connect(minted.value, { signal });
  const selector = substrate.flavors.length > 0 ? { [substratePoolLabel]: row.pool_id } : undefined;
  const listed = await attempt(deps, row.pool_id, signal, () =>
    api.nodes(selector ? `${substratePoolLabel}=${row.pool_id}` : undefined),
  );
  if (!listed) return retry();
  if ('error' in listed) {
    await setState(deps, sql, row, { state: 'error', message: `nodes: ${listed.error}` });
    return undefined;
  }
  const nodes = listed.value;
  // Nodes gone from the cluster first: their bookings end, and they no longer count as joined.
  if (!(await removeGoneNodes(deps, sql, row, api, { nodes, full: selector === undefined }, signal)))
    deps.log.warn('kubernetes: substrate could not list every Node; removed nodes are checked next time', {
      poolId: row.pool_id,
    });
  const joined = await joinedNodes(sql, row.pool_id);
  const gap = Math.max(0, nodes.length - joined);

  // The join token: only while nodes are still to join, with exactly that many uses.
  let joinToken: string | undefined;
  let tokenId = row.join_token_id;
  let revoke = false;
  if (gap > 0) {
    const usable = tokenId !== null && row.token_applied && (await tokenLive(sql, tokenId, 1));
    if (!usable) {
      const ttlSeconds = deps.substrate!.tokenTtlSeconds ?? 3600;
      const issued = await sql.transaction(async (tx) => {
        await revokeToken(tx, row.join_token_id);
        const token = await deps.pki!.issueJoinToken(tx, {
          tenantId: pool.owner_tenant_id,
          role: 'node',
          poolId: pool.id,
          ttlSeconds,
          maxUses: Math.min(gap, 10_000),
          hosted: 'kubernetes',
        });
        const { rows } = await tx.query(
          `UPDATE kubernetes_pool_substrates SET join_token_id = $3, token_applied = false, version = version + 1
            WHERE pool_id = $1 AND version = $2 RETURNING pool_id`,
          [row.pool_id, row.version, token.id],
        );
        if (rows.length === 0) throw new ComputeError('CONFLICT', 'The substrate changed meanwhile');
        await publishSubstrate(deps, tx, row, 'kubernetes.substrate.token-issued', {
          tokenId: token.id,
          maxUses: Math.min(gap, 10_000),
          ttlSeconds,
        });
        return token;
      }).catch((error: unknown) => {
        if (isComputeError(error, 'CONFLICT')) return undefined;
        throw error;
      });
      if (!issued) return deps.clock.now();
      row.version = Number(row.version) + 1;
      row.join_token_id = issued.id;
      row.token_applied = false;
      joinToken = issued.token;
      tokenId = issued.id;
    }
  } else if (tokenId !== null) revoke = true;

  const manifests = owned(
    row.pool_id,
    agent.manifests({ siteId: pool.site_id, ...(selector ? { nodeSelector: selector } : {}) }),
  );
  const hash = await sha256Hex(canonical(manifests));
  const appliedAt = row.applied_at === null ? 0 : new Date(row.applied_at).getTime();
  const due =
    joinToken !== undefined ||
    hash !== row.manifests_sha256 ||
    deps.clock.now() - appliedAt >= substrateReapplyMs;
  if (due) {
    const objects = joinToken !== undefined
      ? owned(
          row.pool_id,
          agent.manifests({ siteId: pool.site_id, joinToken, ...(selector ? { nodeSelector: selector } : {}) }),
        )
      : manifests;
    if (cluster.adopted) {
      // Never take over what the tenant runs on their own cluster.
      const foreign = await attempt(deps, row.pool_id, signal, () =>
        foreignObjects(api, row.pool_id, joinToken !== undefined ? objects : [...objects, agent.tokenSecret]),
      );
      if (!foreign) return retry();
      if ('error' in foreign) {
        await setState(deps, sql, row, { state: 'error', message: `apply: ${foreign.error}` });
        return undefined;
      }
      if (foreign.value.length > 0) {
        await setState(deps, sql, row, {
          state: 'error',
          message: `The adopted cluster already has ${foreign.value.join(', ')}, not made by this substrate: better-compute never takes over or deletes objects it did not create. Remove them (or install bcd under another namespace) and the substrate applies bcd`.slice(
            0,
            500,
          ),
        });
        return undefined;
      }
    }
    for (const object of objects) {
      const applied = await attempt(deps, row.pool_id, signal, () => api.apply(object));
      if (!applied) return retry();
      if ('error' in applied) {
        await setState(deps, sql, row, { state: 'error', message: `apply: ${applied.error}` });
        return undefined;
      }
    }
  }
  if (revoke) {
    const removed = await attempt(deps, row.pool_id, signal, () => removeOwned(api, row.pool_id, agent.tokenSecret));
    if (!removed) return retry();
    if ('error' in removed) {
      await setState(deps, sql, row, { state: 'error', message: `token Secret: ${removed.error}` });
      return undefined;
    }
    await sql.transaction(async (tx) => {
      await revokeToken(tx, tokenId);
      await publishSubstrate(deps, tx, row, 'kubernetes.substrate.token-revoked', {
        tokenId: tokenId!,
        reason: 'every node joined',
      });
    });
  }
  const drain = plan.drain;
  const written = await setState(deps, sql, row, {
    state: drain ? 'updating' : 'ready',
    message: drain
      ? `Draining before the upgrade to ${drain.version}: waiting for ${drain.bookings} booking(s) on the pool's nodes to end (no new bookings meanwhile)`
      : null,
    fields: {
      ...(due ? { applied: true, manifests_sha256: hash } : {}),
      nodes_listed: nodes.length,
      nodes_joined: Math.min(joined, nodes.length),
      ...(revoke ? { join_token_id: null, token_applied: false } : {}),
      ...(joinToken !== undefined ? { token_applied: true } : {}),
    },
  });
  if (!written) return deps.clock.now();
  // Nodes still joining, or the cluster still converging (a resize, an upgrade): look again soon. A drain looks
  // again for its bookings now and then; a drained upgrade until the cluster runs the version. Otherwise the
  // periodic refresh comes back.
  if (gap > 0 || cluster.state !== 'ready') return deps.clock.now() + substratePollMs;
  if (drain) return deps.clock.now() + substrateUpgradeRecheckMs;
  return row.upgrade_version !== null ? deps.clock.now() + substratePollMs : undefined;
}

/** The NoSchedule reason on a pool's nodes once its substrate is being torn down. */
export const substrateTeardownReason = 'substrate-teardown';
/** How often a teardown that could not remove bcd from an adopted cluster tries again. */
export const substrateTeardownRetryMs = 2 * 60_000;
/** How often a teardown waiting for bookings to end looks again. */
export const substrateDrainRecheckMs = 5 * 60_000;

/**
 * The pool was archived or its substrate removed: tear down what the substrate made, with drain semantics.
 *   1. The substrate goes `deleting`, its join token is revoked and the pool's nodes are cordoned (NoSchedule
 *      `substrate-teardown`); nothing new lands on them.
 *   2. It waits until the pool's nodes hold no live booking: nothing is force-released (an archived pool's
 *      reservations keep their bookings until they end).
 *   3. bcd's objects leave the cluster (DaemonSet, ConfigMap, token Secret, Namespace), then the cluster row is
 *      deleted: a created cluster at the provider, an adopted one only its substrate node pools (never the cluster).
 *   4. Once the cluster row is `deleted`, the substrate is.
 */
async function teardown(
  deps: SubstrateDeps,
  sql: SqlExecutor,
  current: SubstrateRow,
  signal: AbortSignal,
): Promise<number | undefined> {
  const poll = () => deps.clock.now() + substratePollMs;
  let row = current;
  if (row.desired_state !== 'deleted') {
    const marked = await sql.transaction(async (tx) => {
      const locked = await readSubstrate(tx, row.pool_id, { lock: true });
      if (!locked || Number(locked.version) !== Number(row.version)) return undefined;
      await revokeToken(tx, locked.join_token_id);
      await tx.query(
        `UPDATE nodes SET cordoned = true, version = version + 1,
                no_schedule_reasons = array_append(no_schedule_reasons, $2)
          WHERE pool_id = $1 AND NOT ($2 = ANY(no_schedule_reasons))`,
        [row.pool_id, substrateTeardownReason],
      );
      await tx.query(
        `UPDATE kubernetes_pool_substrates
            SET desired_state = 'deleted', state = 'deleting', message = NULL, join_token_id = NULL,
                token_applied = false, updated_at = compute_now(), version = version + 1
          WHERE pool_id = $1`,
        [row.pool_id],
      );
      await publishSubstrate(deps, tx, locked, 'kubernetes.substrate.deleting', {
        ...(locked.cluster_id !== null ? { clusterId: locked.cluster_id } : {}),
      });
      return (await readSubstrate(tx, row.pool_id, { lock: true }))!;
    });
    if (!marked) return deps.clock.now();
    row = marked;
  }
  // Drain semantics: wait for the bookings on the pool's nodes to end.
  const bookings = await liveBookings(sql, row.pool_id);
  if (bookings > 0) {
    const message = `Waiting for ${bookings} booking(s) on the pool's nodes to end before the cluster is torn down`;
    if (row.message !== message) await setState(deps, sql, row, { state: 'deleting', message });
    return deps.clock.now() + substrateDrainRecheckMs;
  }
  const cluster =
    row.cluster_id === null
      ? undefined
      : (
          await sql.query<ClusterRow>(`SELECT ${clusterColumns} FROM kubernetes_clusters WHERE id = $1`, [
            row.cluster_id,
          ])
        ).rows[0];
  if (cluster && cluster.desired_state !== 'deleted') {
    // bcd leaves the cluster first (what matters on an adopted one, which stays).
    if (cluster.provider_id !== null && deps.substrate && ['ready', 'updating', 'error'].includes(cluster.state)) {
      const removed = await removeBcd(deps, sql, row, cluster, signal);
      if (removed === 'retry') return deps.clock.now() + substrateRetryMs;
      if (removed !== 'done') {
        const message = `bcd could not be removed from the adopted cluster (it stays on its nodes until it is): ${removed.error}`.slice(
          0,
          500,
        );
        if (row.message !== message) await setState(deps, sql, row, { state: 'deleting', message });
        return deps.clock.now() + substrateTeardownRetryMs;
      }
    }
    await sql.transaction(async (tx) => {
      const { rows } = await tx.query<{ desired_state: string }>(
        `SELECT desired_state FROM kubernetes_clusters WHERE id = $1 FOR UPDATE`,
        [cluster.id],
      );
      if (rows[0]?.desired_state === 'deleted') return;
      await markDeleted(tx, cluster.id);
      await deps.work.enqueue(tx, clustersWork, cluster.id);
      await publishCluster(deps, tx, cluster, 'kubernetes.cluster.deleting', {
        reason: 'substrate-removed',
        ...(cluster.adopted ? { adopted: true } : {}),
      });
    });
    return poll();
  }
  if (cluster && cluster.state !== 'deleted') return poll();
  await sql.transaction(async (tx) => {
    const { rows } = await tx.query(
      `UPDATE kubernetes_pool_substrates
          SET state = 'deleted', message = NULL, deleted_at = compute_now(), updated_at = compute_now(),
              version = version + 1
        WHERE pool_id = $1 AND state <> 'deleted' RETURNING pool_id`,
      [row.pool_id],
    );
    if (rows.length > 0)
      await publishSubstrate(deps, tx, row, 'kubernetes.substrate.deleted', {
        ...(row.cluster_id !== null ? { clusterId: row.cluster_id } : {}),
      });
  });
  return undefined;
}

/**
 * Deletes bcd's objects from the cluster, only those carrying the substrate's label (`owned`): the DaemonSet first,
 * the Namespace last. On a created cluster (deleted next anyway) one that cannot be reached is left as it is. On an
 * ADOPTED cluster, which stays, teardown fails closed: a credential, an account or a delete that fails is an error
 * teardown retries, since bcd left running there keeps a privileged DaemonSet on the tenant's nodes; only a cluster
 * the provider no longer has counts as nothing to delete.
 */
async function removeBcd(
  deps: SubstrateDeps,
  sql: SqlExecutor,
  row: SubstrateRow,
  cluster: ClusterRow,
  signal: AbortSignal,
): Promise<'done' | 'retry' | { error: string }> {
  const agent = deps.substrate!.agent;
  const failed = (error: string): 'done' | { error: string } => {
    if (!cluster.adopted) {
      deps.log.warn('kubernetes: substrate teardown could not remove bcd; the cluster is deleted next', {
        poolId: row.pool_id,
        error,
      });
      return 'done';
    }
    return { error };
  };
  let kubernetes: ProviderKubernetes;
  try {
    const account = await sql.transaction((tx) => readAccount(tx, row.provider_account_id, row.tenant_id));
    if (!account) return failed(`Provider account ${row.provider_account_id} not found`);
    kubernetes = (await accountKubernetes(deps, account)).kubernetes;
  } catch (error) {
    return failed(text(error));
  }
  const call: CallContext = {
    idempotencyKey: `substrate:${row.pool_id}:teardown`,
    signal,
    clock: deps.clock,
    secrets: deps.secrets,
    log: deps.log,
  };
  const minted = await attempt(deps, row.pool_id, signal, () =>
    kubernetes.credentials(
      cluster.provider_id!,
      { subject: substrateSubject, role: 'admin', ttlSeconds: substrateCredentialTtlSeconds },
      call,
    ),
  );
  if (!minted) return 'retry';
  if ('error' in minted) {
    if (cluster.adopted) {
      // Gone at the provider: nothing is left to delete. Anything else: keep trying.
      const found = await attempt(deps, row.pool_id, signal, () => kubernetes.getCluster(cluster.provider_id!, call));
      if (!found) return 'retry';
      if (!('error' in found) && found.value === undefined) return 'done';
    }
    return failed(`credentials: ${minted.error}`);
  }
  const api = agent.connect(minted.value, { signal });
  const objects = [...agent.manifests({ siteId: 'site_teardown' }), agent.tokenSecret];
  // DaemonSet first, the Namespace last (it takes anything left in it).
  const order = (kind: string) => (kind === 'DaemonSet' ? 0 : kind === 'Namespace' ? 2 : 1);
  for (const object of objects.sort((a, b) => order(a.kind) - order(b.kind))) {
    const removed = await attempt(deps, row.pool_id, signal, () => removeOwned(api, row.pool_id, object));
    if (!removed) return 'retry';
    if ('error' in removed) {
      const outcome = failed(`${describeObject(object)}: ${removed.error}`);
      if (outcome !== 'done') return outcome;
    }
  }
  return 'done';
}

async function enqueueAll(context: ModuleContext, tx: SqlTx, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  if (typeof context.work.enqueueMany === 'function') await context.work.enqueueMany(tx, substratesWork, ids);
  else for (const id of ids) await context.work.enqueue(tx, substratesWork, id);
}

/**
 * The `kubernetes.substrates` reconciler (key: a pool id). `all` (every 30 s) queues pools whose policy has a
 * substrate and that have no settled row, and every substrate being torn down; `refresh` (every 2 minutes) queues
 * the settled ones (ready, error), so drift is repaired, an error retried and new Nodes get a token.
 */
export function substratesReconciler(depsOf: (context: ModuleContext) => SubstrateDeps): Reconciler {
  return {
    name: substratesWork,
    shardBy: 'none',
    periodic: [
      { key: 'all', every: '30s' },
      { key: 'refresh', every: '2m' },
    ],
    async run(context, key) {
      if (key === 'all' || key === 'refresh') {
        await context.sql.transaction(async (tx) => {
          const { rows } = await tx.query<{ id: string }>(
            key === 'all'
              ? `SELECT p.id FROM pools p
                   LEFT JOIN kubernetes_pool_substrates s ON s.pool_id = p.id
                  WHERE (p.policy ? 'substrate' AND p.archived_at IS NULL
                         AND (s.pool_id IS NULL OR s.state NOT IN ('ready', 'error')
                              OR s.pool_version IS DISTINCT FROM p.version))
                     OR (s.state IS NOT NULL AND s.state <> 'deleted'
                         AND (s.desired_state = 'deleted' OR p.archived_at IS NOT NULL OR NOT p.policy ? 'substrate'))
                  ORDER BY p.id`
              : `SELECT pool_id AS id FROM kubernetes_pool_substrates WHERE state IN ('ready', 'error') ORDER BY pool_id`,
          );
          await enqueueAll(
            context,
            tx,
            rows.map((row) => row.id),
          );
        });
        return 'DONE';
      }
      const next = await reconcileSubstrate(depsOf(context), context.sql, key, context.signal);
      if (next !== undefined)
        await context.sql.transaction((tx) => context.work.enqueue(tx, substratesWork, key, { notBefore: next }));
      return 'DONE';
    },
  };
}
