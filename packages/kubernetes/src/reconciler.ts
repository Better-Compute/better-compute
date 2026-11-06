import {
  ComputeError,
  isComputeError,
  type CallContext,
  type KubernetesClusterSpec,
  type KubernetesNodePoolSpec,
  type ModuleContext,
  type ProviderKubernetes,
  type ProviderResourceState,
  type Reconciler,
  type SqlExecutor,
  type SqlTx,
} from '@better-compute/core';
import {
  providerResourceName,
  readAccount,
  zoneRegion,
  type ProviderAccount,
} from '@better-compute/vps';
import {
  accountKubernetes,
  clustersWork,
  json,
  publish,
  readCluster,
  readNodePools,
  type ClusterRow,
  type KubernetesDeps,
  type NodePoolRow,
} from './store.js';
import type { KubernetesClusterState, KubernetesNodePoolState } from './types.js';

// The `kubernetes.clusters` reconciler: converges each cluster at the provider through `ProviderImpl.kubernetes`.
// Rows are read in one transaction, the provider is called with none open, and each result is written in its own
// short transaction guarded by the row version it was decided on (a change made meanwhile wakes the reconciler
// again instead of being overwritten).

/** How soon a provider operation in flight is looked at again. */
export const clusterPollMs = 10_000;
/** How soon a rate-limited or unavailable provider is tried again. */
export const clusterRetryMs = 30_000;
/** The label every provider-side cluster carries: the cluster id (for cost attribution and support). */
export const clusterLabel = 'better-compute-cluster';

const transientCodes = ['RATE_LIMITED', 'UNAVAILABLE', 'TIMEOUT'];
const text = (error: unknown) => String((error as Error)?.message ?? error).slice(0, 500);

interface Snapshot {
  cluster: ClusterRow;
  /** Node pools that are not deleted (being deleted included). */
  pools: NodePoolRow[];
  account: ProviderAccount | undefined;
  network?: { network: string; subnet?: string };
}

async function loadSnapshot(tx: SqlTx, clusterId: string): Promise<Snapshot | undefined> {
  const cluster = await readCluster(tx, { clusterId });
  if (!cluster) return undefined;
  const snapshot: Snapshot = {
    cluster,
    pools: await readNodePools(tx, [clusterId]),
    account: await readAccount(tx, cluster.provider_account_id),
  };
  if (cluster.network_id !== null) {
    const { rows } = await tx.query<{ id: string; external_name: string | null }>(
      `SELECT id, external_name FROM networks WHERE id = $1`,
      [cluster.network_id],
    );
    if (rows[0])
      snapshot.network = {
        network: providerResourceName(rows[0].id, rows[0].external_name),
        ...(cluster.subnet_id !== null ? { subnet: providerResourceName(cluster.subnet_id) } : {}),
      };
  }
  return snapshot;
}

/** The provider spec of a node pool row. */
export function nodePoolSpec(row: NodePoolRow): KubernetesNodePoolSpec {
  const zones = json(row.zones);
  const labels = json(row.labels);
  const taints = json(row.taints);
  return {
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
    ...(row.spot ? { spot: true } : {}),
    ...(row.accelerator_type !== null && row.accelerator_count !== null
      ? { accelerators: { type: row.accelerator_type, count: Number(row.accelerator_count) } }
      : {}),
    ...(zones.length > 0 ? { zones } : {}),
    ...(Object.keys(labels).length > 0 ? { labels } : {}),
    ...(taints.length > 0 ? { taints } : {}),
  };
}

/**
 * The provider spec of a cluster. Its node pools go in `initialNodePools` only while the provider was never asked
 * (no `provider_id`): GKE creates a standard cluster with its pools; later ones go through `ensureNodePool`.
 */
export function clusterSpec(snapshot: Snapshot): KubernetesClusterSpec {
  const { cluster } = snapshot;
  const initial =
    cluster.mode === 'standard' && cluster.provider_id === null
      ? snapshot.pools.filter((pool) => pool.desired_state === 'present').map(nodePoolSpec)
      : [];
  return {
    name: cluster.provider_name,
    location: cluster.location,
    mode: cluster.mode,
    releaseChannel: cluster.release_channel,
    ...(cluster.requested_version !== null ? { version: cluster.requested_version } : {}),
    ...(snapshot.network ? { network: snapshot.network } : {}),
    authorizedNetworks: json(cluster.authorized_networks),
    privateNodes: cluster.private_nodes,
    ...(initial.length > 0 ? { initialNodePools: initial } : {}),
    labels: { [clusterLabel]: cluster.id },
  };
}

/** What one provider call came to: its state, or `undefined` when the provider was busy (try later). */
type Outcome = {
  state: ProviderResourceState['state'];
  message?: string;
  result?: ProviderResourceState;
};

/**
 * One step of one cluster. Returns the next wake-up, or undefined when settled (an `error` waits for the next
 * change or the periodic refresh).
 */
export async function reconcileCluster(
  deps: KubernetesDeps,
  sql: SqlExecutor,
  clusterId: string,
  signal: AbortSignal,
): Promise<number | undefined> {
  const snapshot = await sql.transaction((tx) => loadSnapshot(tx, clusterId));
  if (!snapshot || snapshot.cluster.state === 'deleted') return undefined;
  const worker = new ClusterWorker(deps, sql, snapshot, signal);
  if (snapshot.cluster.desired_state === 'deleted' && snapshot.cluster.provider_id === null)
    // The provider was never asked for it (or never answered): nothing to delete there.
    return worker.finish();
  const kubernetes = await worker.providerKubernetes();
  if (!kubernetes) return undefined;
  return snapshot.cluster.desired_state === 'deleted'
    ? worker.teardown(kubernetes)
    : worker.converge(kubernetes);
}

class ClusterWorker {
  #inFlight = false;
  #backoff = false;
  #again = false;

  constructor(
    private readonly deps: KubernetesDeps,
    private readonly sql: SqlExecutor,
    private readonly snapshot: Snapshot,
    private readonly signal: AbortSignal,
  ) {}

  get #cluster() {
    return this.snapshot.cluster;
  }

  #next(): number | undefined {
    const now = this.deps.clock.now();
    if (this.#backoff) return now + clusterRetryMs;
    if (this.#again) return now;
    return this.#inFlight ? now + clusterPollMs : undefined;
  }

  #call(idempotencyKey: string): CallContext {
    return {
      idempotencyKey,
      signal: this.signal,
      clock: this.deps.clock,
      secrets: this.deps.secrets,
      log: this.deps.log,
    };
  }

  /** The account's client when its provider still provides managed Kubernetes; otherwise the cluster is in error. */
  async providerKubernetes(): Promise<ProviderKubernetes | undefined> {
    const { account } = this.snapshot;
    try {
      if (!account)
        throw new ComputeError(
          'NOT_FOUND',
          `Provider account ${this.#cluster.provider_account_id} not found`,
        );
      return (await accountKubernetes(this.deps, account)).kubernetes;
    } catch (error) {
      await this.#setCluster({ state: 'error', message: text(error) });
      return undefined;
    }
  }

  /** Runs a provider call; a throw is an `error` outcome unless the provider is only busy (then: later). */
  async #attempt(op: () => Promise<ProviderResourceState>): Promise<Outcome | undefined> {
    try {
      const result = await op();
      return {
        state: result.state,
        ...(result.message ? { message: result.message.slice(0, 500) } : {}),
        result,
      };
    } catch (error) {
      if (this.signal.aborted || (isComputeError(error) && transientCodes.includes(error.code))) {
        this.deps.log.warn('kubernetes: provider busy, retrying', {
          clusterId: this.#cluster.id,
          error: text(error),
        });
        this.#backoff = true;
        return undefined;
      }
      return { state: 'error', message: text(error) };
    }
  }

  /**
   * Writes the cluster's state and what the provider reported (guarded by the version this run read) and publishes
   * the transition: `ready` the first time, `updated` when it is ready again after a change or on another version,
   * `error` when it goes to error or its message changes.
   */
  async #setCluster(update: {
    state: KubernetesClusterState;
    message?: string;
    result?: ProviderResourceState;
  }): Promise<void> {
    const cluster = this.#cluster;
    const outputs = update.result?.outputs ?? {};
    const providerId = update.result?.id;
    const written = await this.sql.transaction(async (tx) => {
      const { rows } = await tx.query<{ kubernetes_version: string | null }>(
        `UPDATE kubernetes_clusters
            SET state = $3, message = $4,
                provider_id = coalesce($5, provider_id),
                endpoint = coalesce($6, endpoint),
                kubernetes_version = coalesce($7, kubernetes_version),
                node_version = coalesce($8, node_version),
                provisioned_at = CASE WHEN $5::text IS NOT NULL THEN coalesce(provisioned_at, compute_now())
                                      ELSE provisioned_at END,
                ready_at = CASE WHEN $3 = 'ready' THEN coalesce(ready_at, compute_now()) ELSE ready_at END
          WHERE id = $1 AND version = $2
          RETURNING kubernetes_version`,
        [
          cluster.id,
          cluster.version,
          update.state,
          update.message ?? null,
          providerId ?? null,
          outputs.endpoint ?? null,
          outputs.version ?? null,
          outputs.nodeVersion ?? null,
        ],
      );
      if (rows.length === 0) return false;
      const version = rows[0]!.kubernetes_version;
      if (update.state === 'ready') {
        if (cluster.ready_at === null)
          await publish(this.deps, tx, cluster, 'kubernetes.cluster.ready', {
            ...(cluster.endpoint !== null || outputs.endpoint
              ? { endpoint: outputs.endpoint ?? cluster.endpoint! }
              : {}),
            ...(version !== null ? { version } : {}),
          });
        else if (cluster.state !== 'ready' || version !== cluster.kubernetes_version)
          await publish(this.deps, tx, cluster, 'kubernetes.cluster.updated', {
            ...(version !== null ? { version } : {}),
            ...(cluster.kubernetes_version !== null && version !== cluster.kubernetes_version
              ? { previousVersion: cluster.kubernetes_version }
              : {}),
          });
      } else if (
        update.state === 'error' &&
        (cluster.state !== 'error' || cluster.message !== (update.message ?? null))
      )
        await publish(this.deps, tx, cluster, 'kubernetes.cluster.error', {
          message: update.message ?? '',
        });
      return true;
    });
    if (written) {
      cluster.state = update.state;
      cluster.message = update.message ?? null;
      return;
    }
    await this.#changedMeanwhile();
  }

  /** A write guarded by the version found a newer one (a change through the API): converge again at once. */
  async #changedMeanwhile(): Promise<void> {
    const { rows } = await this.sql.transaction((tx) =>
      tx.query<{ version: string | number }>(
        `SELECT version FROM kubernetes_clusters WHERE id = $1`,
        [this.#cluster.id],
      ),
    );
    if (rows[0] && Number(rows[0].version) !== Number(this.#cluster.version)) this.#again = true;
  }

  async #setPool(
    pool: NodePoolRow,
    state: KubernetesNodePoolState,
    message?: string,
  ): Promise<void> {
    const written = await this.sql.transaction(async (tx) => {
      const { rows } = await tx.query(
        `UPDATE kubernetes_node_pools SET state = $3, message = $4, updated_at = compute_now()
          WHERE id = $1 AND version = $2 AND (state IS DISTINCT FROM $3 OR message IS DISTINCT FROM $4)
          RETURNING id`,
        [pool.id, pool.version, state, message ?? null],
      );
      if (rows.length === 0) return false;
      const data = { nodePoolId: pool.id, name: pool.name };
      if (state === 'ready' && pool.state !== 'ready')
        await publish(this.deps, tx, this.#cluster, 'kubernetes.nodepool.ready', data);
      else if (state === 'deleted')
        await publish(this.deps, tx, this.#cluster, 'kubernetes.nodepool.deleted', data);
      else if (state === 'error')
        await publish(this.deps, tx, this.#cluster, 'kubernetes.nodepool.error', {
          ...data,
          message: message ?? '',
        });
      return true;
    });
    if (written) {
      pool.state = state;
      pool.message = message ?? null;
      return;
    }
    const { rows } = await this.sql.transaction((tx) =>
      tx.query<{ version: string | number }>(
        `SELECT version FROM kubernetes_node_pools WHERE id = $1`,
        [pool.id],
      ),
    );
    if (rows[0] && Number(rows[0].version) !== Number(pool.version)) this.#again = true;
  }

  /** The state a cluster still converging shows: `provisioning` until it was ready once, then `updating`. */
  #converging(): KubernetesClusterState {
    return this.#cluster.ready_at === null ? 'provisioning' : 'updating';
  }

  /**
   * An adopted cluster (a pool substrate's `cluster: { adopt }`) as the provider has it: read, never created or
   * changed. Gone at the provider is an error (the substrate cannot fix it).
   */
  async #readAdopted(kubernetes: ProviderKubernetes): Promise<ProviderResourceState> {
    const cluster = this.#cluster;
    const found = await kubernetes.getCluster(cluster.provider_id!, this.#call(cluster.id));
    if (!found)
      throw new ComputeError(
        'NOT_FOUND',
        `The adopted cluster ${cluster.provider_id} does not exist at the provider`,
      );
    const location = found.outputs?.location;
    if (location && location !== cluster.location)
      await this.sql.transaction((tx) =>
        tx.query(`UPDATE kubernetes_clusters SET location = $2, region = $3 WHERE id = $1`, [
          cluster.id,
          location,
          zoneRegion(location),
        ]),
      );
    return found;
  }

  async converge(kubernetes: ProviderKubernetes): Promise<number | undefined> {
    const cluster = this.#cluster;
    const ensured = await this.#attempt(() =>
      cluster.adopted
        ? this.#readAdopted(kubernetes)
        : kubernetes.ensureCluster(clusterSpec(this.snapshot), this.#call(cluster.id)),
    );
    if (!ensured) return this.#next();
    if (ensured.state === 'error') {
      await this.#setCluster({
        state: 'error',
        message: ensured.message ?? 'The provider refused the cluster',
      });
      return this.#next();
    }
    const result = ensured.result!;
    if (ensured.state !== 'ready') {
      // Created or changing at the provider: node pools wait for the control plane.
      this.#inFlight = true;
      await this.#setCluster({ state: this.#converging(), result });
      return this.#next();
    }

    const problems: string[] = [];
    let waiting = false;
    if (cluster.mode === 'standard') {
      for (const pool of this.snapshot.pools) {
        if (pool.desired_state !== 'deleted') continue;
        const gone = await this.#attempt(() =>
          kubernetes.deleteNodePool(result.id, pool.name, this.#call(pool.id)),
        );
        if (!gone) {
          waiting = true;
          continue;
        }
        if (gone.state === 'deleted') await this.#setPool(pool, 'deleted');
        else if (gone.state === 'error') {
          await this.#setPool(pool, 'error', gone.message);
          problems.push(`node pool ${pool.name}: ${gone.message ?? 'the provider refused it'}`);
        } else {
          this.#inFlight = true;
          waiting = true;
          await this.#setPool(pool, 'deleting');
        }
      }
      for (const pool of this.snapshot.pools) {
        if (pool.desired_state !== 'present') continue;
        const ensuredPool = await this.#attempt(() =>
          kubernetes.ensureNodePool(result.id, nodePoolSpec(pool), this.#call(pool.id)),
        );
        if (!ensuredPool) {
          waiting = true;
          continue;
        }
        if (ensuredPool.state === 'ready') await this.#setPool(pool, 'ready');
        else if (ensuredPool.state === 'error') {
          await this.#setPool(pool, 'error', ensuredPool.message);
          problems.push(
            `node pool ${pool.name}: ${ensuredPool.message ?? 'the provider refused it'}`,
          );
        } else {
          this.#inFlight = true;
          waiting = true;
          await this.#setPool(
            pool,
            pool.state === 'ready' || pool.state === 'updating' ? 'updating' : 'pending',
          );
        }
      }
    }
    if (problems.length > 0)
      await this.#setCluster({
        state: 'error',
        message: problems.join('; ').slice(0, 500),
        result,
      });
    else if (waiting || this.#backoff || this.#again)
      await this.#setCluster({ state: this.#converging(), result });
    else await this.#setCluster({ state: 'ready', result });
    return this.#next();
  }

  /**
   * An adopted cluster is never deleted: only the node pools better-compute created in it are, then the row is
   * `deleted`.
   */
  async #releaseAdopted(kubernetes: ProviderKubernetes): Promise<number | undefined> {
    const cluster = this.#cluster;
    const problems: string[] = [];
    let waiting = false;
    for (const pool of this.snapshot.pools) {
      if (pool.state === 'deleted') continue;
      const gone = await this.#attempt(() =>
        kubernetes.deleteNodePool(cluster.provider_id!, pool.name, this.#call(pool.id)),
      );
      if (!gone) {
        waiting = true;
        continue;
      }
      if (gone.state === 'deleted') await this.#setPool(pool, 'deleted');
      else if (gone.state === 'error') {
        await this.#setPool(pool, 'error', gone.message);
        problems.push(`node pool ${pool.name}: ${gone.message ?? 'the provider refused it'}`);
      } else {
        this.#inFlight = true;
        waiting = true;
        await this.#setPool(pool, 'deleting');
      }
    }
    if (problems.length > 0) {
      await this.#setCluster({ state: 'error', message: problems.join('; ').slice(0, 500) });
      return this.#next();
    }
    if (waiting || this.#backoff) {
      await this.#setCluster({ state: 'deleting' });
      return this.#next();
    }
    return this.finish();
  }

  /** Deletes the cluster at the provider (its node pools go with it), then records it `deleted`. */
  async teardown(kubernetes: ProviderKubernetes): Promise<number | undefined> {
    const cluster = this.#cluster;
    if (cluster.adopted) return this.#releaseAdopted(kubernetes);
    const gone = await this.#attempt(() =>
      kubernetes.deleteCluster(cluster.provider_id!, this.#call(cluster.id)),
    );
    if (!gone) return this.#next();
    if (gone.state === 'error') {
      await this.#setCluster({
        state: 'error',
        message: gone.message ?? 'The provider refused to delete the cluster',
      });
      return this.#next();
    }
    if (gone.state !== 'deleted') {
      this.#inFlight = true;
      await this.#setCluster({ state: 'deleting' });
      return this.#next();
    }
    return this.finish();
  }

  /** The cluster is gone at the provider: it and its node pools are `deleted`, and its authz row goes. */
  async finish(): Promise<number | undefined> {
    const cluster = this.#cluster;
    const done = await this.sql.transaction(async (tx) => {
      const { rows } = await tx.query(
        `UPDATE kubernetes_clusters SET state = 'deleted', message = NULL, deleted_at = compute_now()
          WHERE id = $1 AND version = $2 AND state <> 'deleted' RETURNING id`,
        [cluster.id, cluster.version],
      );
      if (rows.length === 0) return false;
      const pools = await tx.query<{ id: string; name: string }>(
        `UPDATE kubernetes_node_pools SET state = 'deleted', message = NULL, updated_at = compute_now()
          WHERE cluster_id = $1 AND state <> 'deleted' RETURNING id, name`,
        [cluster.id],
      );
      for (const pool of pools.rows)
        await publish(this.deps, tx, cluster, 'kubernetes.nodepool.deleted', {
          nodePoolId: pool.id,
          name: pool.name,
        });
      await this.deps.authz.remove(tx, {
        type: 'kubernetes-cluster',
        id: cluster.id,
        tenantId: cluster.tenant_id,
      });
      await publish(this.deps, tx, cluster, 'kubernetes.cluster.deleted');
      return true;
    });
    if (!done) await this.#changedMeanwhile();
    return this.#next();
  }
}

async function enqueueAll(
  context: ModuleContext,
  tx: SqlTx,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  if (typeof context.work.enqueueMany === 'function')
    await context.work.enqueueMany(tx, clustersWork, ids);
  else for (const id of ids) await context.work.enqueue(tx, clustersWork, id);
}

/**
 * The `kubernetes.clusters` reconciler (key: a cluster id). `all` (every 30 s) queues the clusters still
 * converging or being deleted; `refresh` (every 5 minutes) queues the settled ones, `ready` and `error`, so an
 * error is retried and what changed at the provider (a release-channel upgrade, a pool deleted by hand) is seen.
 */
export function clustersReconciler(depsOf: (context: ModuleContext) => KubernetesDeps): Reconciler {
  return {
    name: clustersWork,
    shardBy: 'none',
    periodic: [
      { key: 'all', every: '30s' },
      { key: 'refresh', every: '5m' },
    ],
    async run(context, key) {
      if (key === 'all' || key === 'refresh') {
        await context.sql.transaction(async (tx) => {
          const { rows } = await tx.query<{ id: string }>(
            key === 'all'
              ? `SELECT id FROM kubernetes_clusters
                  WHERE state IN ('pending', 'provisioning', 'updating', 'deleting')
                     OR (desired_state = 'deleted' AND state <> 'deleted')
                  ORDER BY id`
              : `SELECT id FROM kubernetes_clusters WHERE state IN ('ready', 'error') ORDER BY id`,
          );
          await enqueueAll(
            context,
            tx,
            rows.map((row) => row.id),
          );
        });
        return 'DONE';
      }
      const next = await reconcileCluster(depsOf(context), context.sql, key, context.signal);
      if (next !== undefined)
        await context.sql.transaction((tx) =>
          context.work.enqueue(tx, clustersWork, key, { notBefore: next }),
        );
      return 'DONE';
    },
  };
}
