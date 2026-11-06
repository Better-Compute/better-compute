import {
  isComputeError,
  type CallContext,
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
import type { DoVpc } from '../compute/types.js';
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
import { checkRegion, fail, invalid, parseClusterId, resourceState } from './common.js';
import { nodePoolBody } from './node-pools.js';
import { httpsKubeTransport, type KubeTransport } from './transport.js';
import type { DoksCluster } from './types.js';
import { byNewest, pickVersion, readOptions, readVersions } from './versions.js';

export { kubernetesTag } from './clusters.js';
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

export class DoKubernetes implements ProviderKubernetes {
  readonly #client: DoClient;
  readonly #config: DoConfig;
  readonly #deploymentTag: string;
  readonly #transport: KubeTransport;
  /** Cluster name → uuid, so a call reads one cluster instead of listing them all. */
  readonly #names = new Map<string, string>();

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

  /** Deletes one of this deployment's clusters by its id (never a bulk or a dangerous delete). */
  async #deleteOwned(cluster: DoksCluster, signal: AbortSignal): Promise<void> {
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
    } catch (error) {
      if (!isComputeError(error, 'NOT_FOUND')) throw error;
    }
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
    await this.#checkImmutable(spec, found, signal);
    if (state !== 'running' && state !== 'degraded') return clusterState(id, found);
    const update = clusterUpdate(spec, found);
    if (!update) return clusterState(id, found);
    log.info('doks.cluster.update', { cluster: id, fields: Object.keys(update) });
    await this.#client.request('PUT', `/kubernetes/clusters/${id}`, {
      body: { name: found.name, tags: ownTags(found), ...update },
      signal,
      budget: 'mutate',
    });
    return resourceState(id, 'updating', { outputs: outputsOf(found) });
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

  deleteCluster(_cluster: string, _context: CallContext): Promise<ProviderResourceState> {
    return Promise.resolve(this.#notYet());
  }

  #notYet(): never {
    throw fail('UNSUPPORTED', 'This DOKS call is not supported yet', 'notYet');
  }

  // -------------------------------------------------------------------------------- node pools

  ensureNodePool(
    _cluster: string,
    _spec: KubernetesNodePoolSpec,
    _context: CallContext,
  ): Promise<ProviderResourceState> {
    return Promise.resolve(this.#notYet());
  }

  deleteNodePool(
    _cluster: string,
    _name: string,
    _context: CallContext,
  ): Promise<ProviderResourceState> {
    return Promise.resolve(this.#notYet());
  }

  // ------------------------------------------------------------------------------ credentials

  credentials(
    _cluster: string,
    _request: KubernetesCredentialRequest,
    _context: CallContext,
  ): Promise<KubernetesCredentials> {
    void this.#transport;
    return Promise.resolve(this.#notYet());
  }

  // --------------------------------------------------------------------------------- versions

  async versions(location: string, context: CallContext): Promise<KubernetesVersions> {
    checkRegion(location, this.#config.regions);
    return readVersions(this.#client, context.signal);
  }
}
