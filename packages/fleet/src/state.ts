import type { Migration, SqlTx } from '@better-compute/core';
import type {
  FleetConfig,
  FleetFlavor,
  FleetKubernetesCluster,
  FleetKubernetesNodePool,
  FleetPool,
  FleetProviderAccount,
  FleetSandboxTemplate,
  FleetSite,
} from './config.js';

/** Names fleet gave the objects it manages (pools and sites have no name column of their own). */
export const fleetNamesMigration: Migration = {
  name: 'fleet/0001_names',
  sql: `
CREATE TABLE fleet_names (
  tenant_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('site', 'pool', 'providerAccount')),
  name text NOT NULL,
  object_id text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT compute_now(),
  PRIMARY KEY (tenant_id, kind, name),
  UNIQUE (tenant_id, kind, object_id)
);
`,
};

export type NamedKind = 'site' | 'pool' | 'providerAccount';

/** The tenant's current platform objects, with ids, in FleetConfig terms. */
export interface FleetState {
  tenantId: string;
  sites: (FleetSite & { id: string })[];
  providerAccounts: (FleetProviderAccount & { id: string })[];
  pools: (Required<Pick<FleetPool, 'ownerQuota' | 'policy' | 'offers'>> &
    FleetPool & { id: string; siteId: string; providerAccountId?: string })[];
  flavors: (FleetFlavor & { poolId: string })[];
  /** Every field filled in (runtime, TTL bounds, warm, network); `userData` and `env` only when set. */
  sandboxTemplates: (Required<Omit<FleetSandboxTemplate, 'userData' | 'env' | 'volumes'>> &
    Pick<FleetSandboxTemplate, 'userData' | 'env' | 'volumes'> & {
      id: string;
      poolId: string;
      warm: { min: number; max: number };
    })[];
  /**
   * (D25) The tenant's managed clusters that are not deleted, every field filled in. A pool substrate's
   * cluster (and an adopted one) belongs to its pool and is in `substrateClusters` instead.
   */
  kubernetesClusters: FleetStateCluster[];
  /** Live clusters of pool substrates, by row name: their names are taken. */
  substrateClusters: { name: string; poolId: string }[];
  /** How many clusters of each name the tenant ever had (deleted ones too): fleet's create keys count them. */
  clusterIncarnations: Record<string, number>;
  /** Tables of modules this deployment does not run (vps: flavors, provider accounts, sandbox templates; kubernetes). */
  missing: string[];
}

export type FleetStateNodePool = FleetKubernetesNodePool & {
  id: string;
  /** Being deleted (`kubernetesNodePools.delete`): its name is still taken. */
  deleting: boolean;
  /** Node pools of this name the cluster ever had (deleted ones too). */
  incarnations: number;
};

export type FleetStateCluster = Required<
  Pick<FleetKubernetesCluster, 'mode' | 'releaseChannel' | 'authorizedNetworks'>
> &
  Omit<FleetKubernetesCluster, 'nodePools'> & {
    id: string;
    poolId: string;
    privateNodes: boolean;
    state: string;
    /** Being deleted (`kubernetesClusters.delete`): its name is still taken until it is gone. */
    deleting: boolean;
    nodePools: FleetStateNodePool[];
    /** Node pools of names no longer live, with how many of each the cluster ever had. */
    nodePoolIncarnations: Record<string, number>;
  };

const parse = (value: unknown) => (typeof value === 'string' ? JSON.parse(value) : value);

async function tableExists(tx: SqlTx, table: string): Promise<boolean> {
  const { rows } = await tx.query<{ found: string | null }>(
    'SELECT to_regclass($1)::text AS found',
    [table],
  );
  return Boolean(rows[0]?.found);
}

/** Reads what `tenantId` owns now. Objects fleet never named are named by their id. */
export async function readFleetState(tx: SqlTx, tenantId: string): Promise<FleetState> {
  const names = new Map<string, string>();
  for (const row of (
    await tx.query<{ kind: string; name: string; object_id: string }>(
      'SELECT kind, name, object_id FROM fleet_names WHERE tenant_id = $1',
      [tenantId],
    )
  ).rows)
    names.set(`${row.kind}:${row.object_id}`, row.name);
  const nameOf = (kind: NamedKind, id: string) => names.get(`${kind}:${id}`) ?? id;
  const missing: string[] = [];

  const sites = (
    await tx.query<{
      id: string;
      kind: FleetSite['kind'];
      region: string;
      iam_region: string | null;
    }>('SELECT id, kind, region, iam_region FROM sites WHERE owner_tenant_id = $1 ORDER BY id', [
      tenantId,
    ])
  ).rows.map((row) => ({
    id: row.id,
    name: nameOf('site', row.id),
    kind: row.kind,
    region: row.region,
    ...(row.iam_region ? { iamRegion: row.iam_region } : {}),
  }));
  const siteName = new Map(sites.map((site) => [site.id, site.name]));

  let providerAccounts: FleetState['providerAccounts'] = [];
  if (await tableExists(tx, 'provider_accounts'))
    providerAccounts = (
      await tx.query<{ id: string; provider: string; name: string; config: unknown }>(
        'SELECT id, provider, name, config FROM provider_accounts WHERE tenant_id = $1 ORDER BY id',
        [tenantId],
      )
    ).rows.map((row) => ({
      id: row.id,
      name: row.name,
      provider: row.provider,
      config: (parse(row.config) ?? {}) as Record<string, unknown>,
    }));
  else missing.push('provider_accounts');
  const accountName = new Map(providerAccounts.map((account) => [account.id, account.name]));

  const archived =
    (
      await tx.query(
        `SELECT 1 FROM information_schema.columns WHERE table_name = 'pools' AND column_name = 'archived_at'`,
      )
    ).rows.length > 0;
  const poolRows = (
    await tx.query<{
      id: string;
      site_id: string;
      class: string;
      gpu_model: string | null;
      sharing: string;
      agent: 'bcd' | 'none';
      policy: unknown;
      provider_account_id?: string | null;
    }>(
      `SELECT * FROM pools WHERE owner_tenant_id = $1 ${archived ? 'AND archived_at IS NULL' : ''} ORDER BY id`,
      [tenantId],
    )
  ).rows;
  const poolIds = poolRows.map((row) => row.id);
  const quotas = (
    await tx.query<{ tenant_id: string; pool_id: string; resource: string; max: string | number }>(
      'SELECT tenant_id, pool_id, resource, max FROM quota_usage WHERE pool_id = ANY($1::text[])',
      [poolIds],
    )
  ).rows;
  const offers = (
    await tx.query<{
      pool_id: string;
      tenant_id: string;
      include_descendants: boolean;
      priority?: number | null;
    }>('SELECT * FROM pool_offers WHERE pool_id = ANY($1::text[]) AND tenant_id <> $2', [
      poolIds,
      tenantId,
    ])
  ).rows;
  const quotaOf = (poolId: string, tenant: string) =>
    Object.fromEntries(
      quotas
        .filter((row) => row.pool_id === poolId && row.tenant_id === tenant)
        .sort((a, b) => a.resource.localeCompare(b.resource))
        .map((row) => [row.resource, Number(row.max)]),
    );
  const pools: FleetState['pools'] = poolRows.map((row) => {
    const pool: FleetState['pools'][number] = {
      id: row.id,
      siteId: row.site_id,
      name: nameOf('pool', row.id),
      site: siteName.get(row.site_id) ?? row.site_id,
      class: row.class,
      sharing: row.sharing,
      agent: row.agent,
      policy: (parse(row.policy) ?? {}) as Record<string, unknown>,
      ownerQuota: quotaOf(row.id, tenantId),
      offers: offers
        .filter((offer) => offer.pool_id === row.id)
        .sort((a, b) => a.tenant_id.localeCompare(b.tenant_id))
        .map((offer) => ({
          tenant: offer.tenant_id,
          quota: quotaOf(row.id, offer.tenant_id),
          includeDescendants: offer.include_descendants,
          ...(offer.priority !== undefined && offer.priority !== null && offer.priority !== 0
            ? { priority: offer.priority }
            : {}),
        })),
    };
    if (row.gpu_model) pool.gpuModel = row.gpu_model;
    if (row.provider_account_id) {
      pool.providerAccountId = row.provider_account_id;
      pool.providerAccount = accountName.get(row.provider_account_id) ?? row.provider_account_id;
    }
    return pool;
  });
  const poolName = new Map(pools.map((pool) => [pool.id, pool.name]));

  let flavors: FleetState['flavors'] = [];
  if (await tableExists(tx, 'flavors'))
    flavors = (
      await tx.query<{
        pool_id: string;
        name: string;
        vcpu: number;
        memory_gib: number;
        disk_gib: number;
        gpus: number | null;
        offer_id: string | null;
        placement: FleetFlavor['placement'] | string | null;
      }>(
        // `placement` through to_jsonb: absent before vps/0018, so older schemas still read.
        `SELECT pool_id, name, vcpu, memory_gib, disk_gib, gpus, offer_id,
                to_jsonb(f)->'placement' AS placement
           FROM flavors f
          WHERE pool_id = ANY($1::text[]) AND NOT archived ORDER BY pool_id, name`,
        [poolIds],
      )
    ).rows.map((row) => {
      const placement =
        typeof row.placement === 'string' ? JSON.parse(row.placement) : row.placement;
      return {
        poolId: row.pool_id,
        pool: poolName.get(row.pool_id) ?? row.pool_id,
        name: row.name,
        vcpu: Number(row.vcpu),
        memoryGiB: Number(row.memory_gib),
        diskGiB: Number(row.disk_gib),
        ...(row.gpus ? { gpus: Number(row.gpus) } : {}),
        ...(row.offer_id ? { offerId: row.offer_id } : {}),
        ...(placement && typeof placement === 'object' && Object.keys(placement).length
          ? { placement }
          : {}),
      };
    });
  else missing.push('flavors');

  let sandboxTemplates: FleetState['sandboxTemplates'] = [];
  if (await tableExists(tx, 'sandbox_templates'))
    sandboxTemplates = (
      await tx.query<{
        id: string;
        name: string;
        pool_id: string;
        flavor: string;
        image_id: string;
        runtime: string;
        user_data: string | null;
        default_ttl_seconds: number;
        max_ttl_seconds: number;
        warm_min: number;
        warm_max: number;
        env: unknown;
        network: 'egress' | 'private' | 'none';
        volumes: unknown;
      }>(
        // `volumes` through to_jsonb: absent before the agent-memory migration.
        `SELECT id, name, pool_id, flavor, image_id, runtime, user_data, default_ttl_seconds,
                max_ttl_seconds, warm_min, warm_max, env, network, to_jsonb(t)->'volumes' AS volumes
           FROM sandbox_templates t WHERE tenant_id = $1 AND NOT deleted ORDER BY name`,
        [tenantId],
      )
    ).rows.map((row) => ({
      id: row.id,
      poolId: row.pool_id,
      name: row.name,
      // Offered pools are not the tenant's, so they are named by id.
      pool: poolName.get(row.pool_id) ?? row.pool_id,
      flavor: row.flavor,
      imageId: row.image_id,
      runtime: row.runtime,
      ...(row.user_data !== null ? { userData: row.user_data } : {}),
      defaultTtlSeconds: Number(row.default_ttl_seconds),
      maxTtlSeconds: Number(row.max_ttl_seconds),
      warm: { min: Number(row.warm_min), max: Number(row.warm_max) },
      network: row.network,
      ...(Object.keys((parse(row.env) ?? {}) as object).length
        ? { env: parse(row.env) as Record<string, string> }
        : {}),
      ...templateVolumes(parse(row.volumes)),
    }));
  else missing.push('sandbox_templates');
  // A template names its volumes by id; the document names them by volume name.
  if (sandboxTemplates.some((template) => template.volumes?.length)) {
    const ids = sandboxTemplates.flatMap((template) => template.volumes ?? []).map((v) => v.volume);
    const { rows } = await tx.query<{ id: string; name: string }>(
      `SELECT id, name FROM sandbox_volumes WHERE id = ANY($1::text[])`,
      [ids],
    );
    const names = new Map(rows.map((row) => [row.id, row.name]));
    for (const template of sandboxTemplates)
      for (const volume of template.volumes ?? []) volume.volume = names.get(volume.volume) ?? volume.volume;
  }

  let kubernetesClusters: FleetState['kubernetesClusters'] = [];
  let substrateClusters: FleetState['substrateClusters'] = [];
  let clusterIncarnations: FleetState['clusterIncarnations'] = {};
  if (await tableExists(tx, 'kubernetes_clusters'))
    ({ kubernetesClusters, substrateClusters, clusterIncarnations } = await readClusters(
      tx,
      tenantId,
      poolName,
    ));
  else missing.push('kubernetes_clusters');

  return {
    tenantId,
    sites,
    providerAccounts,
    pools,
    flavors,
    sandboxTemplates,
    kubernetesClusters,
    substrateClusters,
    clusterIncarnations,
    missing,
  };
}

interface ClusterRow {
  id: string;
  pool_id: string;
  project_id: string | null;
  network_id: string | null;
  name: string;
  description: string | null;
  mode: 'standard' | 'autopilot';
  location: string;
  release_channel: NonNullable<FleetKubernetesCluster['releaseChannel']>;
  requested_version: string | null;
  authorized_networks: unknown;
  private_nodes: boolean;
  state: string;
  desired_state: string;
  substrate_pool_id: string | null;
  adopted: boolean | null;
}

interface NodePoolRow {
  id: string;
  cluster_id: string;
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
  zones: unknown;
  labels: unknown;
  taints: unknown;
  desired_state: string;
}

/** The kubernetes module's clusters and node pools of `tenantId`, in document terms. */
async function readClusters(
  tx: SqlTx,
  tenantId: string,
  poolName: Map<string, string>,
): Promise<Pick<FleetState, 'kubernetesClusters' | 'substrateClusters' | 'clusterIncarnations'>> {
  // substrate_pool_id and adopted through to_jsonb: absent before kubernetes/0002.
  const rows = (
    await tx.query<ClusterRow>(
      `SELECT id, pool_id, project_id, network_id, name, description, mode, location, release_channel,
              requested_version, authorized_networks, private_nodes, state, desired_state,
              to_jsonb(k)->>'substrate_pool_id' AS substrate_pool_id,
              coalesce((to_jsonb(k)->>'adopted')::bool, false) AS adopted
         FROM kubernetes_clusters k WHERE tenant_id = $1 AND state <> 'deleted' ORDER BY name`,
      [tenantId],
    )
  ).rows;
  const clusterIncarnations: Record<string, number> = {};
  for (const row of (
    await tx.query<{ name: string; count: string | number }>(
      'SELECT name, count(*) AS count FROM kubernetes_clusters WHERE tenant_id = $1 GROUP BY name',
      [tenantId],
    )
  ).rows)
    clusterIncarnations[row.name] = Number(row.count);
  const substrateClusters = rows
    .filter((row) => row.substrate_pool_id !== null || row.adopted)
    .map((row) => ({ name: row.name, poolId: row.substrate_pool_id ?? row.pool_id }));
  const owned = rows.filter((row) => row.substrate_pool_id === null && !row.adopted);
  const clusterIds = owned.map((row) => row.id);
  const nodePools = (
    await tx.query<NodePoolRow>(
      `SELECT id, cluster_id, name, machine_type, node_count, autoscaling_min, autoscaling_max, disk_gib,
              disk_type, spot, accelerator_type, accelerator_count, zones, labels, taints, desired_state
         FROM kubernetes_node_pools
        WHERE cluster_id = ANY($1::text[]) AND state <> 'deleted'
        ORDER BY cluster_id, created_at, name`,
      [clusterIds],
    )
  ).rows;
  const counts = (
    await tx.query<{ cluster_id: string; name: string; count: string | number }>(
      `SELECT cluster_id, name, count(*) AS count FROM kubernetes_node_pools
        WHERE cluster_id = ANY($1::text[]) GROUP BY cluster_id, name`,
      [clusterIds],
    )
  ).rows;
  const countOf = (clusterId: string, name: string) =>
    Number(counts.find((row) => row.cluster_id === clusterId && row.name === name)?.count ?? 0);
  const kubernetesClusters = owned.map((row): FleetStateCluster => {
    const pools = nodePools
      .filter((pool) => pool.cluster_id === row.id)
      .map((pool) => nodePoolOf(pool, countOf(row.id, pool.name)));
    const live = new Set(pools.map((pool) => pool.name));
    return {
      id: row.id,
      poolId: row.pool_id,
      name: row.name,
      // Offered pools are not the tenant's, so they are named by id.
      pool: poolName.get(row.pool_id) ?? row.pool_id,
      mode: row.mode,
      location: row.location,
      releaseChannel: row.release_channel,
      ...(row.requested_version !== null ? { version: row.requested_version } : {}),
      ...(row.network_id !== null ? { networkId: row.network_id } : {}),
      ...(row.project_id !== null ? { projectId: row.project_id } : {}),
      authorizedNetworks: (parse(row.authorized_networks) ?? []) as string[],
      privateNodes: row.private_nodes,
      ...(row.description !== null ? { description: row.description } : {}),
      nodePools: pools,
      nodePoolIncarnations: Object.fromEntries(
        counts
          .filter((count) => count.cluster_id === row.id && !live.has(count.name))
          .map((count) => [count.name, Number(count.count)]),
      ),
      state: row.state,
      deleting: row.desired_state === 'deleted',
    };
  });
  return { kubernetesClusters, substrateClusters, clusterIncarnations };
}

function nodePoolOf(pool: NodePoolRow, incarnations: number): FleetStateNodePool {
  const zones = (parse(pool.zones) ?? []) as string[];
  const labels = (parse(pool.labels) ?? {}) as Record<string, string>;
  const taints = (parse(pool.taints) ?? []) as NonNullable<FleetKubernetesNodePool['taints']>;
  return {
    id: pool.id,
    name: pool.name,
    machineType: pool.machine_type,
    nodeCount: Number(pool.node_count),
    ...(pool.autoscaling_min !== null && pool.autoscaling_max !== null
      ? {
          autoscaling: {
            minNodes: Number(pool.autoscaling_min),
            maxNodes: Number(pool.autoscaling_max),
          },
        }
      : {}),
    ...(pool.disk_gib !== null ? { diskGiB: Number(pool.disk_gib) } : {}),
    ...(pool.disk_type !== null ? { diskType: pool.disk_type } : {}),
    ...(pool.spot ? { spot: true } : {}),
    ...(pool.accelerator_type !== null
      ? {
          accelerators: { type: pool.accelerator_type, count: Number(pool.accelerator_count ?? 1) },
        }
      : {}),
    ...(zones.length ? { zones } : {}),
    ...(Object.keys(labels).length ? { labels } : {}),
    ...(taints.length
      ? {
          taints: taints.map((taint) => ({
            key: taint.key,
            ...(taint.value !== undefined ? { value: taint.value } : {}),
            effect: taint.effect,
          })),
        }
      : {}),
    deleting: pool.desired_state === 'deleted',
    incarnations,
  };
}

/** A stored template's volumes ({ volumeId, mountPath, readOnly }) in document form, ids for now. */
function templateVolumes(value: unknown): Pick<FleetSandboxTemplate, 'volumes'> {
  if (!Array.isArray(value) || value.length === 0) return {};
  return {
    volumes: value.map((entry: { volumeId: string; mountPath: string; readOnly?: boolean }) => ({
      volume: entry.volumeId,
      mountPath: entry.mountPath,
      ...(entry.readOnly ? { readOnly: true } : {}),
    })),
  };
}

/** The current state as a FleetConfig document (`fleet.export`). */
export function exportFleetConfig(state: FleetState): FleetConfig {
  const config: FleetConfig = { version: 1 };
  if (state.sites.length) config.sites = state.sites.map(({ id: _id, ...site }) => site);
  if (state.providerAccounts.length)
    config.providerAccounts = state.providerAccounts.map(({ id: _id, ...account }) => account);
  if (state.pools.length)
    config.pools = state.pools.map(
      ({ id: _id, siteId: _site, providerAccountId: _account, offers, ...pool }) => ({
        ...pool,
        ...(offers.length ? { offers } : {}),
      }),
    );
  if (state.flavors.length)
    config.flavors = state.flavors.map(({ poolId: _pool, ...flavor }) => flavor);
  if (state.sandboxTemplates.length)
    config.sandboxTemplates = state.sandboxTemplates.map(
      ({ id: _id, poolId: _pool, ...template }) => template,
    );
  // Clusters on their way out are not part of the fleet any more.
  const clusters = state.kubernetesClusters.filter((cluster) => !cluster.deleting);
  if (clusters.length) config.kubernetesClusters = clusters.map(exportCluster);
  if (config.pools) {
    // A substrate names its account by id; the document names the tenant's accounts by name.
    const accountName = new Map(state.providerAccounts.map((account) => [account.id, account.name]));
    config.pools = config.pools.map((pool) => {
      const substrate = pool.policy?.substrate as Record<string, unknown> | undefined;
      const name =
        typeof substrate?.account === 'string' ? accountName.get(substrate.account) : undefined;
      return name === undefined
        ? pool
        : { ...pool, policy: { ...pool.policy, substrate: { ...substrate, account: name } } };
    });
  }
  return config;
}

/** A stored cluster in document form: defaults spelled out, empty and false fields left out. */
function exportCluster(cluster: FleetStateCluster): FleetKubernetesCluster {
  const out: FleetKubernetesCluster = {
    name: cluster.name,
    pool: cluster.pool,
    mode: cluster.mode,
    location: cluster.location,
    releaseChannel: cluster.releaseChannel,
  };
  if (cluster.version !== undefined) out.version = cluster.version;
  if (cluster.networkId !== undefined) out.networkId = cluster.networkId;
  if (cluster.projectId !== undefined) out.projectId = cluster.projectId;
  if (cluster.authorizedNetworks.length) out.authorizedNetworks = cluster.authorizedNetworks;
  if (cluster.privateNodes) out.privateNodes = true;
  if (cluster.description !== undefined) out.description = cluster.description;
  if (cluster.mode === 'standard')
    out.nodePools = cluster.nodePools
      .filter((pool) => !pool.deleting)
      .map(({ id: _id, deleting: _deleting, incarnations: _count, ...pool }) => pool);
  return out;
}
