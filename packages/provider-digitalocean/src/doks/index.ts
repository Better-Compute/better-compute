import {
  isComputeError,
  type CallContext,
  type ComputeError,
  type KubernetesClusterSpec,
  type KubernetesCredentialRequest,
  type KubernetesCredentials,
  type KubernetesNodePoolSpec,
  type KubernetesVersions,
  type Logger,
  type ProviderKubernetes,
  type ProviderResourceState,
} from '@better-compute/core';
import type { DoClient } from '../client/http.js';
import type { DoSize, DoVpc } from '../compute/types.js';
import type { DoConfig } from '../config.js';
import { deploymentTag } from '../ids.js';
import { accountVpcs, networkOfVpc, vpcForNetwork, vpcLookup } from '../networks/vpcs.js';
import {
  autoUpgradeOf,
  checkClusterSpec,
  clusterState,
  clusterTags,
  clusterUpdate,
  firewallOf,
  immutable,
  isOwned,
  outputsOf,
  ownershipTags,
  ownTags,
  pluginsOff,
} from './clusters.js';
import {
  checkName,
  checkRegion,
  clusterNotFound,
  fail,
  invalid,
  nodePoolId,
  parseClusterId,
  resourceState,
} from './common.js';
import {
  checkNodePoolImmutable,
  checkNodePoolSpec,
  nodePoolBody,
  nodePoolState,
  nodePoolUpdate,
} from './node-pools.js';
import { checkCredentialRequest, mintCredentials } from './credentials.js';
import { httpsKubeTransport, type KubeTransport } from './transport.js';
import type { DoksAssociatedResources, DoksCluster, DoksNodePool, DoksVersion } from './types.js';
import {
  byNewest,
  compareDoksVersion,
  pickVersion,
  readOptions,
  readVersions,
  versionGap,
} from './versions.js';

export { kubernetesTag } from './clusters.js';
export { accessNamespace, adminCredentialSeconds, clusterRoles } from './credentials.js';
export { parseClusterId as parseDoksClusterId } from './common.js';
export { compareDoksVersion, parseDoksVersion } from './versions.js';
export {
  httpsKubeTransport,
  type KubeRequest,
  type KubeResponse,
  type KubeTransport,
} from './transport.js';
export type * from './types.js';

// Managed Kubernetes on DigitalOcean Kubernetes (DOKS), over API v2.
//
// Like the networks, every ensure*/delete* call is non-blocking: it reads the resource, starts at
// most one change, and answers `pending`, `updating` or `deleting` while DOKS works. DOKS has no
// operations: the cluster's and its nodes' own states say when a change is done. A cluster is
// found by its name (unique in an account); only clusters carrying this deployment's ownership
// tags are ever changed or deleted. Nothing is persisted beyond a name → uuid cache: after a
// restart a call re-reads the resources.

export interface DoKubernetesOptions {
  client: DoClient;
  config: DoConfig;
  /** Trust-domain string: hashed into the deployment tag the clusters carry. */
  deployment: string;
  kubeTransport?: KubeTransport;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Oldest first: by `created_at`, then by id. */
function oldestFirst(a: DoksCluster, b: DoksCluster): number {
  const at = (cluster: DoksCluster) => Date.parse(cluster.created_at ?? '') || 0;
  return at(a) - at(b) || a.id.localeCompare(b.id);
}

/** UNSUPPORTED: DigitalOcean did not make a pool asked for as Spot a Spot one. */
function spotUnverified(): ComputeError {
  return fail(
    'UNSUPPORTED',
    'DigitalOcean made a node pool asked for as Spot an on-demand one (the Spot field is a preview): it was deleted, and no Spot pool is created until the provider restarts',
    'spotUnverified',
  );
}

export class DoKubernetes implements ProviderKubernetes {
  readonly #client: DoClient;
  readonly #config: DoConfig;
  readonly #deploymentTag: string;
  readonly #transport: KubeTransport;
  /** Cluster name → uuid, so a call reads one cluster instead of listing them all. */
  readonly #names = new Map<string, string>();
  /**
   * Set once DigitalOcean made a pool asked for as Spot on-demand (the `spot` field is not in
   * its published spec): from then on this process creates no Spot pool, so an unhonoured field
   * costs at most one short-lived on-demand pool, never a loop of them.
   */
  #spotDropped = false;
  /** The ids of clusters and pools made on-demand instead of Spot, deleted until they are gone. */
  readonly #unverifiedSpot = new Set<string>();

  constructor(options: DoKubernetesOptions) {
    this.#client = options.client;
    this.#config = options.config;
    this.#deploymentTag = deploymentTag(options.deployment);
    this.#transport = options.kubeTransport ?? httpsKubeTransport;
  }

  // -------------------------------------------------------------------------------- plumbing

  async #read(id: string, signal: AbortSignal): Promise<DoksCluster | undefined> {
    try {
      const reply = await this.#client.request<{ kubernetes_cluster?: DoksCluster }>(
        'GET',
        `/kubernetes/clusters/${id}`,
        { signal, budget: 'observe' },
      );
      const cluster = reply.kubernetes_cluster;
      return cluster && cluster.status?.state !== 'deleted' ? cluster : undefined;
    } catch (error) {
      if (isComputeError(error, 'NOT_FOUND')) return undefined;
      throw error;
    }
  }

  async #named(name: string, signal: AbortSignal): Promise<DoksCluster[]> {
    const found: DoksCluster[] = [];
    for await (const cluster of this.#client.pages<DoksCluster>(
      '/kubernetes/clusters',
      'kubernetes_clusters',
      { signal, budget: 'observe' },
    ))
      if (cluster.name === name && cluster.status?.state !== 'deleted') found.push(cluster);
    return found;
  }

  #owned(cluster: { tags?: string[] }): boolean {
    return isOwned(cluster.tags, this.#deploymentTag);
  }

  /**
   * Deletes one of this deployment's clusters by its id (never a bulk or a dangerous delete).
   * False when it was already gone.
   */
  async #deleteOwned(cluster: DoksCluster, signal: AbortSignal): Promise<boolean> {
    if (!this.#owned(cluster))
      throw fail(
        'INVALID_STATE',
        `DOKS cluster ${cluster.id} is not this deployment's`,
        'notOwned',
      );
    try {
      await this.#client.request('DELETE', `/kubernetes/clusters/${cluster.id}`, {
        signal,
        budget: 'mutate',
      });
      return true;
    } catch (error) {
      if (!isComputeError(error, 'NOT_FOUND')) throw error;
      return false;
    }
  }

  /**
   * Deletes a cluster or pool DigitalOcean made on-demand though it was asked for Spot, and
   * answers UNSUPPORTED (`spotUnverified`). A delete that fails is thrown as it is, and the id is
   * kept: the next call for it deletes again, so an on-demand GPU pool is never left billing.
   */
  async #dropUnverified(
    id: string,
    path: string,
    what: string,
    context: CallContext,
  ): Promise<ComputeError> {
    this.#spotDropped = true;
    this.#unverifiedSpot.add(id);
    context.log.warn(`doks.${what}.spotUnverified`, { [what]: id });
    try {
      await this.#client.request('DELETE', path, { signal: context.signal, budget: 'mutate' });
    } catch (error) {
      if (!isComputeError(error, 'NOT_FOUND')) throw error;
    }
    return spotUnverified();
  }

  /**
   * This deployment's cluster named `name`, or undefined when there is none. One of that name
   * that is not this deployment's is CONFLICT (never adopted, never touched). Duplicates of ours
   * (DO-D4: two creates raced) keep the oldest; the others are deleted one by one.
   */
  async #find(name: string, signal: AbortSignal, log: Logger): Promise<DoksCluster | undefined> {
    const cached = this.#names.get(name);
    if (cached) {
      const found = await this.#read(cached, signal);
      if (found && found.name === name && this.#owned(found)) return found;
      this.#names.delete(name);
    }
    const named = await this.#named(name, signal);
    if (named.length === 0) return undefined;
    const owned = named.filter((cluster) => this.#owned(cluster)).sort(oldestFirst);
    if (owned.length === 0)
      throw fail(
        'CONFLICT',
        `A DOKS cluster named ${name} exists that this deployment does not own`,
        'notOwned',
      );
    const live = owned.filter((cluster) => cluster.status?.state !== 'deleting');
    const [keep, ...extra] = live.length > 0 ? live : owned;
    for (const duplicate of extra) {
      log.warn('doks.cluster.reap', { cluster: duplicate.id, kept: keep!.id, name });
      await this.#deleteOwned(duplicate, signal);
    }
    this.#names.set(name, keep!.id);
    return keep;
  }

  /** The `vpc_uuid` of a create: the spec network's VPC in the region, else the account's VPC. */
  async #vpcFor(spec: KubernetesClusterSpec, signal: AbortSignal): Promise<string | undefined> {
    if (spec.network)
      return (await vpcForNetwork(this.#client, spec.network, spec.location, signal)).id;
    const wanted = this.#config.vpc;
    if (wanted === undefined) return undefined;
    if (uuidPattern.test(wanted)) return wanted;
    const vpc = (await accountVpcs(this.#client, signal, { fresh: true })).find(
      (candidate) => candidate.name === wanted,
    );
    if (!vpc) throw fail('INVALID_CONFIG', `the account's VPC ${wanted} does not exist`, 'vpc');
    if (vpc.region !== spec.location)
      throw fail(
        'INVALID_CONFIG',
        `the account's VPC ${wanted} is in ${vpc.region}, not in ${spec.location}`,
        'vpc',
      );
    return vpc.id;
  }

  /** Refuses a difference that cannot change in place: the region and the network. */
  async #checkImmutable(
    spec: KubernetesClusterSpec,
    cluster: DoksCluster,
    signal: AbortSignal,
  ): Promise<void> {
    if (cluster.region !== spec.location)
      throw immutable(cluster.id, 'location', cluster.region, spec.location);
    const wanted = spec.network ?? (this.#config.vpc ? { vpc: this.#config.vpc } : undefined);
    if (!wanted || !cluster.vpc_uuid) return;
    const vpc: DoVpc | undefined = await vpcLookup(this.#client, signal)(cluster.vpc_uuid);
    const actual = vpc?.name ?? cluster.vpc_uuid;
    if ('network' in wanted) {
      const matches =
        vpc !== undefined &&
        networkOfVpc(vpc) === wanted.network &&
        (wanted.subnet === undefined || vpc.name === wanted.subnet);
      if (!matches) throw immutable(cluster.id, 'network', actual, wanted.subnet ?? wanted.network);
    } else if (wanted.vpc !== cluster.vpc_uuid && wanted.vpc !== vpc?.name)
      throw immutable(cluster.id, 'network', actual, wanted.vpc);
  }

  // ---------------------------------------------------------------------------------- clusters

  async ensureCluster(
    spec: KubernetesClusterSpec,
    context: CallContext,
  ): Promise<ProviderResourceState> {
    checkClusterSpec(spec, this.#config.regions, false);
    const { signal, log } = context;
    const found = await this.#find(spec.name, signal, log);
    if (!found) return this.#createCluster(spec, context);
    const { id } = found;
    const state = found.status?.state;
    if (state === 'deleting') return clusterState(id, found);
    if (this.#unverifiedSpot.has(id))
      throw await this.#dropUnverified(id, `/kubernetes/clusters/${id}`, 'cluster', context);
    await this.#checkImmutable(spec, found, signal);
    if (state !== 'running' && state !== 'degraded') return clusterState(id, found);
    // A newer patch of the pinned minor (DOKS auto-upgraded it) satisfies the pin.
    const upgrade = spec.version !== undefined ? versionGap(spec.version, found.version) : 0;
    if (upgrade < 0)
      throw fail(
        'INVALID_STATE',
        `Cluster ${id} runs ${found.version}: ${spec.version} would be a downgrade, which DOKS does not do`,
        'downgrade',
      );
    const update = clusterUpdate(spec, found);
    if (update) {
      log.info('doks.cluster.update', { cluster: id, fields: Object.keys(update) });
      await this.#client.request('PUT', `/kubernetes/clusters/${id}`, {
        body: { name: found.name, tags: ownTags(found), ...update },
        signal,
        budget: 'mutate',
      });
      return resourceState(id, 'updating', { outputs: outputsOf(found) });
    }
    if (upgrade > 0) return this.#upgrade(found, spec.version!, context);
    return clusterState(id, found);
  }

  /**
   * One step of a control-plane upgrade (P5 task 7): to the newest version DOKS offers this
   * cluster that does not pass the wanted one. DOKS upgrades a minor at a time, so a far target
   * takes several steps; one it offers no way towards is INVALID_STATE. A surge upgrade replaces
   * the nodes, so bcd pods restart and drain as on any node loss.
   */
  async #upgrade(
    cluster: DoksCluster,
    wanted: string,
    context: CallContext,
  ): Promise<ProviderResourceState> {
    const { signal, log } = context;
    const offered = await this.#client.request<{ available_upgrade_versions?: DoksVersion[] }>(
      'GET',
      `/kubernetes/clusters/${cluster.id}/upgrades`,
      { signal, budget: 'observe' },
    );
    const target = byNewest(offered.available_upgrade_versions ?? []).find(
      (version) =>
        compareDoksVersion(wanted, version.slug) >= 0 &&
        compareDoksVersion(version.slug, cluster.version) > 0,
    );
    if (!target)
      throw fail(
        'INVALID_STATE',
        `Cluster ${cluster.id} runs ${cluster.version}: DOKS offers it no upgrade towards ${wanted}`,
        'versionUnavailable',
      );
    log.info('doks.cluster.upgrade', {
      cluster: cluster.id,
      from: cluster.version,
      to: target.slug,
    });
    await this.#client.request('POST', `/kubernetes/clusters/${cluster.id}/upgrade`, {
      body: { version: target.slug },
      signal,
      budget: 'mutate',
    });
    return resourceState(cluster.id, 'updating', { outputs: outputsOf(cluster) });
  }

  async #createCluster(
    spec: KubernetesClusterSpec,
    context: CallContext,
  ): Promise<ProviderResourceState> {
    const { signal, log } = context;
    checkClusterSpec(spec, this.#config.regions, true);
    const versions = (await readOptions(this.#client, signal)).versions ?? [];
    const version =
      spec.version !== undefined ? pickVersion(versions, spec.version) : byNewest(versions)[0];
    if (!version)
      throw invalid(
        spec.version !== undefined
          ? `DOKS offers no version ${spec.version}`
          : 'DigitalOcean lists no Kubernetes versions',
        'version',
      );
    for (const pool of spec.initialNodePools ?? []) await this.#checkCapacity(pool, signal);
    const vpc = await this.#vpcFor(spec, signal);
    const owned = ownershipTags(this.#deploymentTag);
    const body = {
      name: spec.name,
      region: spec.location,
      version: version.slug,
      ...(vpc !== undefined ? { vpc_uuid: vpc } : {}),
      tags: clusterTags(spec, this.#deploymentTag),
      node_pools: (spec.initialNodePools ?? []).map((pool) => nodePoolBody(pool, owned)),
      auto_upgrade: autoUpgradeOf(spec),
      // Nodes are replaced one surge at a time: bcd pods restart and drain as on any node loss.
      surge_upgrade: true,
      ha: false,
      control_plane_firewall: firewallOf(spec.authorizedNetworks),
      ...pluginsOff,
    };
    log.info('doks.cluster.create', { cluster: spec.name, region: spec.location });
    let created: DoksCluster | undefined;
    try {
      created = (
        await this.#client.request<{ kubernetes_cluster?: DoksCluster }>(
          'POST',
          '/kubernetes/clusters',
          { body, signal, budget: 'mutate' },
        )
      ).kubernetes_cluster;
    } catch (error) {
      // Created meanwhile (a retry, or another creator): what is there is the answer.
      if (!isComputeError(error, 'CONFLICT')) throw error;
      const found = await this.#find(spec.name, signal, log);
      if (!found) throw error;
      return clusterState(found.id, found);
    }
    if (!created?.id)
      throw fail('PROVIDER_ERROR', 'DigitalOcean created a cluster without an id', 'noId');
    this.#names.set(spec.name, created.id);
    // Every pool asked for as Spot must have come back Spot; else the new cluster goes again.
    const dropped = (spec.initialNodePools ?? []).some(
      (pool) =>
        pool.spot === true &&
        created.node_pools?.find((made) => made.name === pool.name)?.spot !== true,
    );
    if (dropped)
      throw await this.#dropUnverified(
        created.id,
        `/kubernetes/clusters/${created.id}`,
        'cluster',
        context,
      );
    return clusterState(created.id, created);
  }

  async getCluster(
    cluster: string,
    context: CallContext,
  ): Promise<ProviderResourceState | undefined> {
    const id = parseClusterId(cluster);
    const found = await this.#read(id, context.signal);
    return found ? clusterState(id, found) : undefined;
  }

  /**
   * Deletes one of this deployment's clusters (P5 task 7). A cluster without both ownership tags
   * (an adopted one, another deployment's) is INVALID_STATE and never deleted (DO-D16). The delete
   * is DOKS's plain one: the load balancers and volumes the cluster's workloads made are kept
   * (they carry no tag of ours, so a selective delete would name none, and `/dangerous` would take
   * tenant data); the answer says how many stay.
   */
  async deleteCluster(cluster: string, context: CallContext): Promise<ProviderResourceState> {
    const id = parseClusterId(cluster);
    const { signal, log } = context;
    const found = await this.#read(id, signal);
    if (!found) {
      for (const [name, uuid] of this.#names) if (uuid === id) this.#names.delete(name);
      return resourceState(id, 'deleted');
    }
    if (!this.#owned(found))
      throw fail(
        'INVALID_STATE',
        `DOKS cluster ${id} is not this deployment's: it is never deleted`,
        'notOwned',
      );
    if (found.status?.state === 'deleting') return resourceState(id, 'deleting');
    const kept = await this.#associated(id, signal, log);
    log.info('doks.cluster.delete', { cluster: id, ...kept });
    if (!(await this.#deleteOwned(found, signal))) {
      for (const [name, uuid] of this.#names) if (uuid === id) this.#names.delete(name);
      return resourceState(id, 'deleted');
    }
    const parts = [
      [kept.loadBalancers, 'load balancer'],
      [kept.volumes, 'volume'],
      [kept.snapshots, 'volume snapshot'],
    ] as const;
    const left = parts
      .filter(([count]) => count > 0)
      .map(([count, what]) => `${count} ${what}${count === 1 ? '' : 's'}`);
    return resourceState(id, 'deleting', {
      ...(left.length > 0
        ? { message: `Kept ${left.join(', ')} the cluster's workloads made` }
        : {}),
    });
  }

  /**
   * How many load balancers, volumes and snapshots of the cluster's own a plain delete keeps. Only
   * a count for the answer's message: any failure to list them (a token that may not, DO busy,
   * the cluster gone meanwhile) counts none and is logged by its code, and the delete goes on.
   */
  async #associated(
    id: string,
    signal: AbortSignal,
    log: Logger,
  ): Promise<{ loadBalancers: number; volumes: number; snapshots: number }> {
    try {
      const listed = await this.#client.request<DoksAssociatedResources>(
        'GET',
        `/kubernetes/clusters/${id}/destroy_with_associated_resources`,
        { signal, budget: 'observe' },
      );
      return {
        loadBalancers: listed.load_balancers?.length ?? 0,
        volumes: listed.volumes?.length ?? 0,
        snapshots: listed.volume_snapshots?.length ?? 0,
      };
    } catch (error) {
      if (signal.aborted) throw error;
      log.warn('doks.cluster.associatedUnread', {
        cluster: id,
        error: isComputeError(error) ? error.code : 'unknown',
      });
      return { loadBalancers: 0, volumes: 0, snapshots: 0 };
    }
  }

  // -------------------------------------------------------------------------------- node pools

  /**
   * Spot and GPU sizes, checked before a create: Spot only with the account's `allowSpot` and
   * `previews` (Spot GPU is a DO preview, DO-D14/DO-D23) and only on GPU sizes; `accelerators`
   * must be what the size carries (DO sizes come with their GPUs).
   */
  async #checkCapacity(spec: KubernetesNodePoolSpec, signal: AbortSignal): Promise<void> {
    if (spec.spot && this.#spotDropped) throw spotUnverified();
    if (spec.spot && !(this.#config.allowSpot && this.#config.previews))
      throw fail(
        'UNSUPPORTED',
        `Node pool ${spec.name}: Spot node pools need the account's allowSpot and previews (Spot GPU is a DigitalOcean preview)`,
        'spotDisabled',
      );
    if (!spec.accelerators && !spec.spot && !spec.machineType.startsWith('gpu-')) return;
    let size: DoSize | undefined;
    for await (const candidate of this.#client.pages<DoSize>('/sizes', 'sizes', {
      signal,
      budget: 'observe',
    }))
      if (candidate.slug === spec.machineType) {
        size = candidate;
        break;
      }
    if (!size) throw invalid(`DigitalOcean has no size ${spec.machineType}`, 'size');
    const gpu = size.gpu_info;
    if (spec.spot && !gpu)
      throw invalid(`Node pool ${spec.name}: Spot node pools are GPU sizes only`, 'spot');
    if (!spec.accelerators) return;
    const model = (gpu?.model ?? '').toLowerCase();
    const wanted = spec.accelerators.type.toLowerCase().replaceAll('-', '_');
    const sameModel = wanted === model || wanted === model.replace(/^(nvidia|amd)_/, '');
    if (!gpu || !sameModel || gpu.count !== spec.accelerators.count)
      throw invalid(
        `Size ${size.slug} carries ${gpu ? `${gpu.count} ${gpu.model}` : 'no GPUs'}, not ${spec.accelerators.count} ${spec.accelerators.type}`,
        'accelerators',
      );
  }

  /** The cluster a node pool call names, and the pool of that name in it. */
  async #pool(
    cluster: string,
    name: string,
    signal: AbortSignal,
  ): Promise<{ parent?: DoksCluster; pool?: DoksNodePool }> {
    const parent = await this.#read(cluster, signal);
    return parent
      ? { parent, pool: (parent.node_pools ?? []).find((pool) => pool.name === name) }
      : {};
  }

  #notOwnedPool(id: string) {
    return fail(
      'CONFLICT',
      `Node pool ${id} exists and is not this deployment's: it is never changed`,
      'notOwned',
    );
  }

  /**
   * A node pool of a cluster. A cluster that is not this deployment's (an adopted one) may get
   * pools of ours; a pool that is not ours is never changed (CONFLICT).
   */
  async ensureNodePool(
    cluster: string,
    spec: KubernetesNodePoolSpec,
    context: CallContext,
  ): Promise<ProviderResourceState> {
    const clusterId = parseClusterId(cluster);
    checkNodePoolSpec(spec);
    const { signal, log } = context;
    const id = nodePoolId(clusterId, spec.name);
    const { parent, pool } = await this.#pool(clusterId, spec.name, signal);
    if (!parent) throw clusterNotFound(clusterId);
    const serving = parent.status?.state === 'running' || parent.status?.state === 'degraded';
    if (!pool) {
      if (parent.status?.state === 'deleting')
        throw fail(
          'INVALID_STATE',
          `DOKS cluster ${clusterId} is being deleted`,
          'clusterDeleting',
        );
      // A pool is added once the control plane serves (not while it provisions or upgrades).
      if (!serving) return resourceState(id, 'pending');
      await this.#checkCapacity(spec, signal);
      log.info('doks.nodePool.create', { nodePool: id, size: spec.machineType });
      try {
        const created = (
          await this.#client.request<{ node_pool?: DoksNodePool }>(
            'POST',
            `/kubernetes/clusters/${clusterId}/node_pools`,
            {
              body: nodePoolBody(spec, ownershipTags(this.#deploymentTag)),
              signal,
              budget: 'mutate',
            },
          )
        ).node_pool;
        if (spec.spot) {
          // DigitalOcean must have honoured `spot`: an on-demand GPU pool is deleted at once.
          const made = created ?? (await this.#pool(clusterId, spec.name, signal)).pool;
          if (!made) throw spotUnverified();
          if (made.spot !== true)
            throw await this.#dropUnverified(
              made.id,
              `/kubernetes/clusters/${clusterId}/node_pools/${made.id}`,
              'nodePool',
              context,
            );
        }
        return created ? nodePoolState(id, created) : resourceState(id, 'pending');
      } catch (error) {
        // Created meanwhile: what is there is the answer, if it is ours.
        if (!isComputeError(error, 'CONFLICT')) throw error;
        const again = (await this.#pool(clusterId, spec.name, signal)).pool;
        if (!again) throw error;
        if (!this.#owned(again)) throw this.#notOwnedPool(id);
        return nodePoolState(id, again);
      }
    }
    if (!this.#owned(pool)) throw this.#notOwnedPool(id);
    if (this.#unverifiedSpot.has(pool.id))
      throw await this.#dropUnverified(
        pool.id,
        `/kubernetes/clusters/${clusterId}/node_pools/${pool.id}`,
        'nodePool',
        context,
      );
    checkNodePoolImmutable(id, spec, pool);
    if (!serving) return nodePoolState(id, pool);
    const update = nodePoolUpdate(spec, pool);
    if (!update) return nodePoolState(id, pool);
    log.info('doks.nodePool.update', { nodePool: id, count: update.count });
    await this.#client.request('PUT', `/kubernetes/clusters/${clusterId}/node_pools/${pool.id}`, {
      body: update,
      signal,
      budget: 'mutate',
    });
    return resourceState(id, 'updating');
  }

  /** Deletes one of this deployment's node pools (a pool that is not ours is INVALID_STATE). */
  async deleteNodePool(
    cluster: string,
    name: string,
    context: CallContext,
  ): Promise<ProviderResourceState> {
    const clusterId = parseClusterId(cluster);
    checkName(name, 'The node pool name');
    const { signal, log } = context;
    const id = nodePoolId(clusterId, name);
    const { pool } = await this.#pool(clusterId, name, signal);
    if (!pool) return resourceState(id, 'deleted');
    if (!this.#owned(pool))
      throw fail(
        'INVALID_STATE',
        `Node pool ${id} is not this deployment's: it is never deleted`,
        'notOwned',
      );
    const nodes = pool.nodes ?? [];
    if (nodes.length > 0 && nodes.every((node) => node.status?.state === 'deleting'))
      return resourceState(id, 'deleting');
    log.info('doks.nodePool.delete', { nodePool: id });
    try {
      await this.#client.request(
        'DELETE',
        `/kubernetes/clusters/${clusterId}/node_pools/${pool.id}`,
        { signal, budget: 'mutate' },
      );
    } catch (error) {
      if (isComputeError(error, 'NOT_FOUND')) return resourceState(id, 'deleted');
      throw error;
    }
    return resourceState(id, 'deleting');
  }

  // ------------------------------------------------------------------------------ credentials

  /**
   * A bound token for one principal. Any cluster the token can read is served (an adopted one
   * too): the credential only reaches the cluster's own API, trusting its CA alone.
   */
  async credentials(
    cluster: string,
    request: KubernetesCredentialRequest,
    context: CallContext,
  ): Promise<KubernetesCredentials> {
    const id = parseClusterId(cluster);
    checkCredentialRequest(request);
    const found = await this.#read(id, context.signal);
    if (!found) throw clusterNotFound(id);
    const credentials = await mintCredentials({
      id,
      cluster: found,
      request,
      client: this.#client,
      transport: this.#transport,
      signal: context.signal,
      clock: this.#client.clock,
    });
    context.log.info('doks.credentials', {
      cluster: id,
      subject: request.subject,
      role: request.role,
      expiresAt: credentials.expiresAt,
    });
    return credentials;
  }

  // --------------------------------------------------------------------------------- versions

  async versions(location: string, context: CallContext): Promise<KubernetesVersions> {
    checkRegion(location, this.#config.regions);
    return readVersions(this.#client, context.signal);
  }
}
