import {
  ComputeError,
  type Clock,
  type EventPublisher,
  type Json,
  type Logger,
  type ModuleContext,
  type ProviderImpl,
  type ProviderKubernetes,
  type SecretResolver,
  type SqlTx,
} from '@better-compute/core';
import {
  readAccount,
  visibleVpsPool,
  zoneRegion,
  type ClientDeps,
  type ProviderAccount,
  type ProviderClients,
} from '@better-compute/vps';
import type {
  KubernetesClusterState,
  KubernetesClusterView,
  KubernetesMode,
  KubernetesNodePoolState,
  KubernetesNodePoolView,
  KubernetesReleaseChannel,
  KubernetesTaint,
} from './types.js';

// Rows, views, events and the provider lookup shared by the API and the reconciler.

/** The work kind of the cluster reconciler: a cluster id, `all` (the 30 s sweep) or `refresh` (5 min). */
export const clustersWork = 'kubernetes.clusters';

/** What the handlers and the reconciler need beyond a transaction. */
export interface KubernetesDeps {
  clock: Clock;
  events: EventPublisher;
  work: ModuleContext['work'];
  authz: ModuleContext['authz'];
  log: Logger;
  secrets: SecretResolver;
  clients: ProviderClients;
  /** The IAM root tenant: its provider accounts are the platform's (ruling F1). */
  rootTenantId?: string;
  /** The host's workload issuer: provider accounts' identity (`ClientDeps.workload`). */
  workload?: ClientDeps['workload'];
  /** `kubernetes({ maxClustersPerTenant })`. */
  maxClustersPerTenant: number;
}

export interface ClusterRow {
  id: string;
  tenant_id: string;
  project_id: string | null;
  pool_id: string;
  provider_account_id: string;
  network_id: string | null;
  subnet_id: string | null;
  name: string;
  description: string | null;
  mode: KubernetesMode;
  location: string;
  region: string;
  release_channel: KubernetesReleaseChannel;
  requested_version: string | null;
  authorized_networks: string[] | string;
  private_nodes: boolean;
  provider_name: string;
  provider_id: string | null;
  state: KubernetesClusterState;
  desired_state: 'present' | 'deleted';
  message: string | null;
  endpoint: string | null;
  kubernetes_version: string | null;
  node_version: string | null;
  created_by: string;
  request_hash: string;
  version: string | number;
  created_at: Date | string;
  provisioned_at: Date | string | null;
  ready_at: Date | string | null;
  deleted_at: Date | string | null;
  /** (kubernetes/0002) A cluster that existed before: read, never created, changed or deleted. */
  adopted: boolean;
  /** (kubernetes/0002) The pool whose substrate this cluster is. */
  substrate_pool_id: string | null;
  /**
   * (kubernetes/0005) What the row claims, unique among live rows: the cluster's provider-global id once the provider
   * reported it, `account:<account>/<adopted id>` until then (adopted rows), NULL for a created cluster not read yet.
   */
  claim_key: string | null;
  /** (kubernetes/0005) When the substrate first held the in-cluster claim. */
  claimed_at: Date | string | null;
}

export interface NodePoolRow {
  id: string;
  cluster_id: string;
  tenant_id: string;
  name: string;
  machine_type: string;
  node_count: number;
  autoscaling_min: number | null;
  autoscaling_max: number | null;
  disk_gib: number | null;
  disk_type: string | null;
  spot: boolean;
  accelerator_type: string | null;
  accelerator_count: number | null;
  zones: string[] | string;
  labels: Record<string, string> | string;
  taints: KubernetesTaint[] | string;
  initial: boolean;
  state: KubernetesNodePoolState;
  desired_state: 'present' | 'deleted';
  message: string | null;
  request_hash: string | null;
  version: string | number;
  created_at: Date | string;
  updated_at: Date | string;
}

export const clusterColumns = `id, tenant_id, project_id, pool_id, provider_account_id, network_id, subnet_id, name,
  description, mode, location, region, release_channel, requested_version, authorized_networks, private_nodes,
  provider_name, provider_id, state, desired_state, message, endpoint, kubernetes_version, node_version, created_by,
  encode(request_hash, 'hex') AS request_hash, version, created_at, provisioned_at, ready_at, deleted_at, adopted,
  substrate_pool_id, claim_key, claimed_at`;
export const nodePoolColumns = `id, cluster_id, tenant_id, name, machine_type, node_count, autoscaling_min,
  autoscaling_max, disk_gib, disk_type, spot, accelerator_type, accelerator_count, zones, labels, taints, initial,
  state, desired_state, message, encode(request_hash, 'hex') AS request_hash, version, created_at, updated_at`;

export const json = <T>(value: T | string): T =>
  typeof value === 'string' ? (JSON.parse(value) as T) : value;
const ms = (value: Date | string) => new Date(value).getTime();

export function nodePoolView(row: NodePoolRow): KubernetesNodePoolView {
  return {
    id: row.id,
    clusterId: row.cluster_id,
    name: row.name,
    machineType: row.machine_type,
    nodeCount: Number(row.node_count),
    ...(row.autoscaling_min !== null && row.autoscaling_max !== null
      ? {
          autoscaling: {
            minNodes: Number(row.autoscaling_min),
            maxNodes: Number(row.autoscaling_max),
          },
        }
      : {}),
    ...(row.disk_gib !== null ? { diskGiB: Number(row.disk_gib) } : {}),
    ...(row.disk_type !== null ? { diskType: row.disk_type } : {}),
    spot: row.spot,
    ...(row.accelerator_type !== null && row.accelerator_count !== null
      ? { accelerators: { type: row.accelerator_type, count: Number(row.accelerator_count) } }
      : {}),
    zones: json(row.zones),
    labels: json(row.labels),
    taints: json(row.taints),
    state: row.state,
    ...(row.message !== null ? { message: row.message } : {}),
    version: Number(row.version),
    createdAt: ms(row.created_at),
    updatedAt: ms(row.updated_at),
  };
}

export function clusterView(row: ClusterRow, pools: readonly NodePoolRow[]): KubernetesClusterView {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    ...(row.project_id !== null ? { projectId: row.project_id } : {}),
    poolId: row.pool_id,
    providerAccountId: row.provider_account_id,
    ...(row.network_id !== null ? { networkId: row.network_id } : {}),
    ...(row.subnet_id !== null ? { subnetId: row.subnet_id } : {}),
    name: row.name,
    ...(row.description !== null ? { description: row.description } : {}),
    mode: row.mode,
    location: row.location,
    region: row.region,
    releaseChannel: row.release_channel,
    ...(row.requested_version !== null ? { requestedVersion: row.requested_version } : {}),
    authorizedNetworks: json(row.authorized_networks),
    privateNodes: row.private_nodes,
    providerName: row.provider_name,
    state: row.state,
    ...(row.message !== null ? { message: row.message } : {}),
    ...(row.endpoint !== null ? { endpoint: row.endpoint } : {}),
    ...(row.kubernetes_version !== null ? { kubernetesVersion: row.kubernetes_version } : {}),
    ...(row.node_version !== null ? { nodeVersion: row.node_version } : {}),
    nodePools: pools.filter((pool) => pool.state !== 'deleted').map(nodePoolView),
    version: Number(row.version),
    createdAt: ms(row.created_at),
    ...(row.ready_at !== null ? { readyAt: ms(row.ready_at) } : {}),
    ...(row.deleted_at !== null ? { deletedAt: ms(row.deleted_at) } : {}),
    ...(row.adopted ? { adopted: true as const } : {}),
    ...(row.substrate_pool_id !== null ? { substratePoolId: row.substrate_pool_id } : {}),
  };
}

export async function readCluster(
  tx: SqlTx,
  ref: { clusterId: string; tenantId?: string },
  options: { lock?: boolean } = {},
): Promise<ClusterRow | undefined> {
  const { rows } = await tx.query<ClusterRow>(
    `SELECT ${clusterColumns} FROM kubernetes_clusters
      WHERE id = $1 AND ($2::text IS NULL OR tenant_id = $2)${options.lock ? ' FOR UPDATE' : ''}`,
    [ref.clusterId, ref.tenantId ?? null],
  );
  return rows[0];
}

/** The tenant's cluster, or NOT_FOUND (another tenant's cluster is not found either). */
export async function requireCluster(
  tx: SqlTx,
  ref: { clusterId: string; tenantId: string },
  options: { lock?: boolean } = {},
): Promise<ClusterRow> {
  const row = await readCluster(tx, ref, options);
  if (!row) throw new ComputeError('NOT_FOUND', `Cluster ${ref.clusterId} not found`);
  return row;
}

/** Node pools of the clusters; deleted ones only with `includeDeleted`. */
export async function readNodePools(
  tx: SqlTx,
  clusterIds: readonly string[],
  options: { includeDeleted?: boolean } = {},
): Promise<NodePoolRow[]> {
  if (clusterIds.length === 0) return [];
  const { rows } = await tx.query<NodePoolRow>(
    `SELECT ${nodePoolColumns} FROM kubernetes_node_pools
      WHERE cluster_id = ANY($1::text[]) AND ($2 OR state <> 'deleted')
      ORDER BY cluster_id, created_at, name`,
    [clusterIds, options.includeDeleted === true],
  );
  return rows;
}

export async function readNodePool(
  tx: SqlTx,
  clusterId: string,
  nodePoolId: string,
  options: { lock?: boolean } = {},
): Promise<NodePoolRow | undefined> {
  const { rows } = await tx.query<NodePoolRow>(
    `SELECT ${nodePoolColumns} FROM kubernetes_node_pools WHERE id = $1 AND cluster_id = $2${
      options.lock ? ' FOR UPDATE' : ''
    }`,
    [nodePoolId, clusterId],
  );
  return rows[0];
}

export async function clusterViewOf(tx: SqlTx, clusterId: string): Promise<KubernetesClusterView> {
  const row = (await readCluster(tx, { clusterId }))!;
  return clusterView(row, await readNodePools(tx, [clusterId]));
}

/** Publishes a `kubernetes.cluster.*` or `kubernetes.nodepool.*` event (subject: the cluster), never a secret. */
export async function publish(
  deps: Pick<KubernetesDeps, 'events'>,
  tx: SqlTx,
  cluster: { id: string; tenant_id: string },
  type: string,
  data: Record<string, Json> = {},
): Promise<void> {
  await deps.events.publish(tx, {
    type,
    tenantId: cluster.tenant_id,
    subject: `kubernetes-cluster/${cluster.id}`,
    data: { clusterId: cluster.id, ...data },
  });
}

/**
 * The provider-side cluster name: `bc-k-` and 24 characters of the id's body (lower-case base32, so a GKE name: at
 * most 40 characters, a letter first, no trailing `-`). Ids derive from a sha256, so names do not collide.
 */
export function providerClusterName(clusterId: string): string {
  const body = clusterId.slice(clusterId.indexOf('_') + 1).toLowerCase();
  return `bc-k-${body.replace(/[^a-z0-9]/g, '').slice(0, 24)}`;
}

/** A provider pool's account, its zones and regions, and its client's `kubernetes`. */
export interface KubernetesProvider {
  account: ProviderAccount;
  zones: string[];
  regions: string[];
  kubernetes: ProviderKubernetes;
  client: ProviderImpl;
}

const clientDeps = (deps: KubernetesDeps): ClientDeps => ({
  clock: deps.clock,
  secrets: deps.secrets,
  log: deps.log,
  ...(deps.rootTenantId !== undefined ? { rootTenantId: deps.rootTenantId } : {}),
  ...(deps.workload ? { workload: deps.workload } : {}),
});

/** The account's client when its provider implements `kubernetes`; otherwise UNSUPPORTED. */
export async function accountKubernetes(
  deps: KubernetesDeps,
  account: ProviderAccount,
): Promise<KubernetesProvider> {
  const client = await deps.clients.client(account, clientDeps(deps));
  if (typeof client.kubernetes !== 'object' || client.kubernetes === null)
    throw new ComputeError(
      'UNSUPPORTED',
      `Provider ${account.provider} does not provide managed Kubernetes`,
    );
  const strings = (value: Json | undefined) =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
  return {
    account,
    // GCP configures zones; providers without zones (DigitalOcean) configure regions; an AWS account is one
    // region (`region`) with zones.
    zones: strings(account.config.zones),
    regions: [
      ...strings(account.config.regions),
      ...(typeof account.config.region === 'string' ? [account.config.region] : []),
    ],
    kubernetes: client.kubernetes,
    client,
  };
}

/**
 * The pool's account and its managed Kubernetes, for a pool the tenant owns or is offered: NOT_FOUND for a pool it
 * cannot see; UNSUPPORTED for a pool that is not a provider pool or whose provider has no `kubernetes`.
 */
export async function poolKubernetes(
  deps: KubernetesDeps,
  tx: SqlTx,
  tenantId: string,
  poolId: string,
): Promise<KubernetesProvider> {
  const pool = await visibleVpsPool(tx, tenantId, poolId);
  if (pool.class !== 'provider' || pool.providerAccountId === undefined)
    throw new ComputeError(
      'UNSUPPORTED',
      `Pool ${poolId} is not a provider pool; managed Kubernetes clusters live on provider accounts`,
    );
  // R1: only an account of the pool's owner tenant.
  const account = await readAccount(tx, pool.providerAccountId, pool.ownerTenantId);
  if (!account) throw new ComputeError('UNSUPPORTED', `Pool ${poolId} has no provider account`);
  return accountKubernetes(deps, account);
}

/**
 * The region of a location the account allows: a configured zone (zonal cluster; its region), or a region of the
 * configured zones or a configured region (regional cluster). INVALID_INPUT otherwise, with the allowed locations.
 */
export function regionOf(
  provider: Pick<KubernetesProvider, 'zones' | 'regions' | 'account'>,
  location: string,
): string {
  const regions = [...new Set([...provider.zones.map(zoneRegion), ...provider.regions])];
  if (regions.length === 0)
    throw new ComputeError(
      'INVALID_STATE',
      `Provider account ${provider.account.id} configures no zones or regions, so no cluster location is allowed`,
    );
  if (provider.zones.includes(location)) return zoneRegion(location);
  if (regions.includes(location)) return location;
  throw new ComputeError(
    'INVALID_INPUT',
    `location ${location} is not a zone or region of the provider account`,
    undefined,
    { field: 'location', zones: provider.zones, regions },
  );
}
