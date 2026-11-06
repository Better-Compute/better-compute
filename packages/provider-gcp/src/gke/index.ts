import {
  ComputeError,
  isComputeError,
  type CallContext,
  type Clock,
  type KubernetesClusterSpec,
  type KubernetesCredentialRequest,
  type KubernetesCredentials,
  type KubernetesNodePoolSpec,
  type KubernetesVersions,
  type ProviderKubernetes,
  type ProviderResourceState,
} from '@better-compute/core';
import type { TokenSource } from '@better-compute/gcp-common';
import type { GceClient } from '../client.js';
import type { GcpConfig } from '../config.js';
import {
  checkName,
  clusterId,
  isBusy,
  operationMessage,
  Operations,
  parseClusterId,
  resourceState,
  type GkeClient,
  type GkeCluster,
  type GkeNodePool,
  type GkeOperation,
  type OperationKind,
} from './client.js';
import {
  checkClusterSpec,
  checkImmutable,
  clusterBody,
  clusterState,
  nextClusterUpdate,
} from './clusters.js';
import { checkCredentialRequest, forgetCredentials, mintCredentials } from './credentials.js';
import {
  autoscalingChange,
  checkNodePoolImmutable,
  checkNodePoolSpec,
  instanceGroupsOf,
  nodePoolBody,
  nodePoolState,
} from './node-pools.js';
import { httpsKubeTransport, type KubeTransport } from './transport.js';
import { readVersions } from './versions.js';

export {
  GkeClient,
  parseClusterId,
  type GkeCluster,
  type GkeNodePool,
  type GkeOperation,
} from './client.js';
export { compareVersion, parseVersion } from './clusters.js';
export {
  accessGuard,
  accessManifests,
  accessNamespace,
  clusterRoles,
  guardedNamespaces,
} from './credentials.js';
export {
  httpsKubeTransport,
  type KubeRequest,
  type KubeResponse,
  type KubeTransport,
} from './transport.js';

// Managed Kubernetes on Google Kubernetes Engine (Standard and Autopilot), over the GKE REST v1 API.
//
// Like the networks, every ensure*/delete* call is non-blocking: it polls the operation this
// process started for the resource (if any), re-reads the resource, and starts at most one
// operation, answering `pending`, `updating` or `deleting` while it runs. GKE runs one operation
// per cluster at a time; a call refused for that answers the same in-progress state, never an
// error. Nothing is persisted: after a restart a call re-reads the resource.

export interface GcpKubernetesOptions {
  /** The GKE REST client (container.googleapis.com/v1). */
  client: GkeClient;
  /** The Compute Engine client: node pool sizes are read from their managed instance groups. */
  compute: GceClient;
  config: GcpConfig;
  /** The account's token source: its access token is the bearer on the clusters' Kubernetes API. */
  tokens: TokenSource;
  clock: Clock;
  kubeTransport?: KubeTransport;
}

const inProgress: Record<OperationKind, ProviderResourceState['state']> = {
  create: 'pending',
  update: 'updating',
  delete: 'deleting',
};

export class GcpKubernetes implements ProviderKubernetes {
  readonly #client: GkeClient;
  readonly #compute: GceClient;
  readonly #config: GcpConfig;
  readonly #tokens: TokenSource;
  readonly #clock: Clock;
  readonly #transport: KubeTransport;
  readonly #operations: Operations;
  /** Clusters (id, endpoint and CA) this process put the access guard and better-compute:edit on. */
  readonly #guarded = new Set<string>();

  constructor(options: GcpKubernetesOptions) {
    this.#client = options.client;
    this.#compute = options.compute;
    this.#config = options.config;
    this.#tokens = options.tokens;
    this.#clock = options.clock;
    this.#transport = options.kubeTransport ?? httpsKubeTransport;
    this.#operations = new Operations(options.client);
  }

  // -------------------------------------------------------------------------------- plumbing

  #findCluster(
    location: string,
    name: string,
    signal: AbortSignal,
  ): Promise<GkeCluster | undefined> {
    return this.#client.find<GkeCluster>(
      location,
      `clusters/${name}`,
      signal,
      `Reading GKE cluster ${location}/${name}`,
    );
  }

  #findPool(
    location: string,
    cluster: string,
    pool: string,
    signal: AbortSignal,
  ): Promise<GkeNodePool | undefined> {
    return this.#client.find<GkeNodePool>(
      location,
      `clusters/${cluster}/nodePools/${pool}`,
      signal,
      `Reading GKE node pool ${location}/${cluster}/${pool}`,
    );
  }

  /**
   * Starts one mutation and remembers its operation. A refusal because another operation runs on
   * the cluster answers `busy` (the state to report); other failures throw.
   */
  async #mutate(
    memory: string,
    kind: OperationKind,
    id: string,
    location: string,
    request: { method: 'POST' | 'PUT' | 'DELETE'; path: string; body?: unknown; what: string },
    signal: AbortSignal,
    busy: ProviderResourceState['state'] = inProgress[kind],
  ): Promise<ProviderResourceState> {
    let operation: GkeOperation;
    try {
      operation = await this.#client.request<GkeOperation>(request.method, location, request.path, {
        ...(request.body !== undefined ? { body: request.body } : {}),
        signal,
        what: request.what,
      });
    } catch (error) {
      if (isBusy(error, request.what)) return resourceState(id, busy, { message: error.message });
      throw error;
    }
    this.#operations.remember(memory, location, kind, operation);
    if (operation.status === 'DONE' && operation.error && (operation.error.code ?? 1) !== 0)
      return resourceState(id, 'error', { message: operationMessage(operation) });
    return resourceState(id, inProgress[kind]);
  }

  // ---------------------------------------------------------------------------------- clusters

  async ensureCluster(
    spec: KubernetesClusterSpec,
    context: CallContext,
  ): Promise<ProviderResourceState> {
    checkClusterSpec(spec, false);
    const { signal } = context;
    const id = clusterId(spec.location, spec.name);
    const memory = `cluster:${id}`;
    const polled = await this.#operations.poll(memory, signal);
    if (polled && 'running' in polled) return resourceState(id, inProgress[polled.running]);
    if (polled && 'failed' in polled) return resourceState(id, 'error', { message: polled.failed });

    const found = await this.#findCluster(spec.location, spec.name, signal);
    if (!found) return this.#createCluster(id, memory, spec, context);
    if (found.status === 'STOPPING') return clusterState(id, spec.location, found);
    checkImmutable(id, spec, found, this.#config);
    if (found.status !== 'RUNNING') return clusterState(id, spec.location, found);
    const update = nextClusterUpdate(id, spec, found);
    if (!update) return clusterState(id, spec.location, found);
    context.log.info('gke.cluster.update', { cluster: id, fields: Object.keys(update) });
    return this.#mutate(
      memory,
      'update',
      id,
      spec.location,
      {
        method: 'PUT',
        path: `clusters/${spec.name}`,
        body: { update },
        what: `Updating GKE cluster ${id}`,
      },
      signal,
    );
  }

  async #createCluster(
    id: string,
    memory: string,
    spec: KubernetesClusterSpec,
    context: CallContext,
  ): Promise<ProviderResourceState> {
    checkClusterSpec(spec, true);
    context.log.info('gke.cluster.create', { cluster: id, mode: spec.mode });
    try {
      return await this.#mutate(
        memory,
        'create',
        id,
        spec.location,
        {
          method: 'POST',
          path: 'clusters',
          body: { cluster: clusterBody(spec, this.#config) },
          what: `Creating GKE cluster ${id}`,
        },
        context.signal,
      );
    } catch (error) {
      // Created meanwhile (a retry, or another creator): what is there is the answer.
      if (!isComputeError(error, 'CONFLICT')) throw error;
      const found = await this.#findCluster(spec.location, spec.name, context.signal);
      return found ? clusterState(id, spec.location, found) : resourceState(id, 'pending');
    }
  }

  async getCluster(
    cluster: string,
    context: CallContext,
  ): Promise<ProviderResourceState | undefined> {
    const { location, name } = parseClusterId(cluster);
    const found = await this.#findCluster(location, name, context.signal);
    return found ? clusterState(cluster, location, found) : undefined;
  }

  async deleteCluster(cluster: string, context: CallContext): Promise<ProviderResourceState> {
    const { location, name } = parseClusterId(cluster);
    const { signal } = context;
    const memory = `cluster:${cluster}:delete`;
    const polled = await this.#operations.poll(memory, signal);
    if (polled && 'running' in polled) return resourceState(cluster, 'deleting');
    if (polled && 'failed' in polled)
      return resourceState(cluster, 'error', { message: polled.failed });
    const found = await this.#findCluster(location, name, signal);
    if (!found) {
      this.#operations.forget(`cluster:${cluster}`);
      return resourceState(cluster, 'deleted');
    }
    if (found.status === 'STOPPING') return resourceState(cluster, 'deleting');
    context.log.info('gke.cluster.delete', { cluster });
    try {
      return await this.#mutate(
        memory,
        'delete',
        cluster,
        location,
        { method: 'DELETE', path: `clusters/${name}`, what: `Deleting GKE cluster ${cluster}` },
        signal,
        'updating',
      );
    } catch (error) {
      if (isComputeError(error, 'NOT_FOUND')) return resourceState(cluster, 'deleted');
      throw error;
    }
  }

  // -------------------------------------------------------------------------------- node pools

  /** The cluster a node pool call names; NOT_FOUND when absent, UNSUPPORTED on autopilot. */
  async #standardCluster(cluster: string, signal: AbortSignal): Promise<GkeCluster | undefined> {
    const { location, name } = parseClusterId(cluster);
    const found = await this.#findCluster(location, name, signal);
    if (found?.autopilot?.enabled === true)
      throw new ComputeError(
        'UNSUPPORTED',
        `Cluster ${cluster} is an autopilot cluster: GKE runs its nodes, it has no node pools`,
        undefined,
        { provider: 'gcp', reason: 'autopilot' },
      );
    return found;
  }

  async ensureNodePool(
    cluster: string,
    spec: KubernetesNodePoolSpec,
    context: CallContext,
  ): Promise<ProviderResourceState> {
    const { location, name: clusterName } = parseClusterId(cluster);
    checkNodePoolSpec(spec);
    const { signal } = context;
    const id = `${cluster}/${spec.name}`;
    const parent = await this.#standardCluster(cluster, signal);
    if (!parent)
      throw new ComputeError('NOT_FOUND', `GKE cluster ${cluster} does not exist`, undefined, {
        provider: 'gcp',
        status: 404,
        reason: 'clusterNotFound',
      });
    const memory = `pool:${id}`;
    const polled = await this.#operations.poll(memory, signal);
    if (polled && 'running' in polled) return resourceState(id, inProgress[polled.running]);
    if (polled && 'failed' in polled) return resourceState(id, 'error', { message: polled.failed });

    const base = `clusters/${clusterName}/nodePools`;
    const pool = await this.#findPool(location, clusterName, spec.name, signal);
    if (!pool) {
      if (parent.status === 'STOPPING')
        throw new ComputeError(
          'INVALID_STATE',
          `GKE cluster ${cluster} is being deleted`,
          undefined,
          {
            provider: 'gcp',
            reason: 'clusterDeleting',
          },
        );
      context.log.info('gke.nodePool.create', { nodePool: id });
      try {
        return await this.#mutate(
          memory,
          'create',
          id,
          location,
          {
            method: 'POST',
            path: base,
            body: { nodePool: nodePoolBody(spec) },
            what: `Creating GKE node pool ${id}`,
          },
          signal,
        );
      } catch (error) {
        if (!isComputeError(error, 'CONFLICT')) throw error;
        const found = await this.#findPool(location, clusterName, spec.name, signal);
        return found ? nodePoolState(id, found) : resourceState(id, 'pending');
      }
    }
    if (pool.status === 'STOPPING') return nodePoolState(id, pool);
    checkNodePoolImmutable(id, spec, pool);
    if (pool.status !== 'RUNNING' && pool.status !== 'RUNNING_WITH_ERROR')
      return nodePoolState(id, pool);

    const autoscaling = autoscalingChange(spec, pool);
    if (autoscaling) {
      context.log.info('gke.nodePool.autoscaling', { nodePool: id });
      return this.#mutate(
        memory,
        'update',
        id,
        location,
        {
          method: 'POST',
          path: `${base}/${spec.name}:setAutoscaling`,
          body: autoscaling,
          what: `Setting the autoscaling of GKE node pool ${id}`,
        },
        signal,
      );
    }
    // With autoscaling, the autoscaler owns the size; nodeCount was only the initial one.
    if (!spec.autoscaling && !(await this.#sized(pool, spec.nodeCount, signal))) {
      context.log.info('gke.nodePool.resize', { nodePool: id, nodeCount: spec.nodeCount });
      return this.#mutate(
        memory,
        'update',
        id,
        location,
        {
          method: 'POST',
          path: `${base}/${spec.name}:setSize`,
          body: { nodeCount: spec.nodeCount },
          what: `Resizing GKE node pool ${id}`,
        },
        signal,
      );
    }
    return nodePoolState(id, pool);
  }

  /**
   * Whether every zone of the pool runs `nodeCount` nodes. A node pool does not report its size:
   * it is the target size of its managed instance groups (one per zone). When they cannot be read
   * (no instance groups yet, or no compute read permission), the pool's initial count is used.
   */
  async #sized(pool: GkeNodePool, nodeCount: number, signal: AbortSignal): Promise<boolean> {
    const groups = instanceGroupsOf(pool);
    if (!groups.length) return (pool.initialNodeCount ?? nodeCount) === nodeCount;
    for (const group of groups) {
      let targetSize: number | undefined;
      try {
        const manager = await this.#compute.request<{ targetSize?: number }>(
          'GET',
          `/projects/${group.project}/zones/${group.zone}/instanceGroupManagers/${group.name}`,
          { signal },
        );
        targetSize = manager.targetSize;
      } catch (error) {
        if (!isComputeError(error, 'NOT_FOUND') && !isComputeError(error, 'ACCESS_DENIED'))
          throw error;
        return (pool.initialNodeCount ?? nodeCount) === nodeCount;
      }
      if ((targetSize ?? 0) !== nodeCount) return false;
    }
    return true;
  }

  async deleteNodePool(
    cluster: string,
    name: string,
    context: CallContext,
  ): Promise<ProviderResourceState> {
    const { location, name: clusterName } = parseClusterId(cluster);
    checkName(name, 'The node pool name');
    const { signal } = context;
    const id = `${cluster}/${name}`;
    const memory = `pool:${id}:delete`;
    const polled = await this.#operations.poll(memory, signal);
    if (polled && 'running' in polled) return resourceState(id, 'deleting');
    if (polled && 'failed' in polled) return resourceState(id, 'error', { message: polled.failed });
    const parent = await this.#standardCluster(cluster, signal);
    const pool = parent ? await this.#findPool(location, clusterName, name, signal) : undefined;
    if (!pool) {
      this.#operations.forget(`pool:${id}`);
      return resourceState(id, 'deleted');
    }
    if (pool.status === 'STOPPING') return resourceState(id, 'deleting');
    context.log.info('gke.nodePool.delete', { nodePool: id });
    try {
      return await this.#mutate(
        memory,
        'delete',
        id,
        location,
        {
          method: 'DELETE',
          path: `clusters/${clusterName}/nodePools/${name}`,
          what: `Deleting GKE node pool ${id}`,
        },
        signal,
        'updating',
      );
    } catch (error) {
      if (isComputeError(error, 'NOT_FOUND')) return resourceState(id, 'deleted');
      throw error;
    }
  }

  // ------------------------------------------------------------------------------ credentials

  async credentials(
    cluster: string,
    request: KubernetesCredentialRequest,
    context: CallContext,
  ): Promise<KubernetesCredentials> {
    const { location, name } = parseClusterId(cluster);
    checkCredentialRequest(request);
    const found = await this.#findCluster(location, name, context.signal);
    if (!found)
      throw new ComputeError('NOT_FOUND', `GKE cluster ${cluster} does not exist`, undefined, {
        provider: 'gcp',
        status: 404,
        reason: 'clusterNotFound',
      });
    const googleToken = await this.#tokens.token({ signal: context.signal, clock: this.#clock });
    // A cluster recreated under the same name has another CA: its guard is written again.
    const key = `${cluster}|${found.endpoint ?? ''}|${found.masterAuth?.clusterCaCertificate ?? ''}`;
    let credentials: KubernetesCredentials;
    try {
      credentials = await mintCredentials({
        id: cluster,
        cluster: found,
        request,
        googleToken,
        transport: this.#transport,
        signal: context.signal,
        clock: this.#clock,
        guarded: this.#guarded.has(key),
      });
    } catch (error) {
      this.#guarded.delete(key);
      throw error;
    }
    this.#guarded.add(key);
    context.log.info('gke.credentials', {
      cluster,
      subject: request.subject,
      role: request.role,
      expiresAt: credentials.expiresAt,
    });
    return credentials;
  }

  /**
   * Removes the service account and binding `credentials` made for `subject` (and `bc-access` once
   * empty). A cluster that is gone has nothing left to remove.
   */
  async forgetCredentials(cluster: string, subject: string, context: CallContext): Promise<void> {
    const { location, name } = parseClusterId(cluster);
    const found = await this.#findCluster(location, name, context.signal);
    if (!found) return;
    const googleToken = await this.#tokens.token({ signal: context.signal, clock: this.#clock });
    await forgetCredentials({
      id: cluster,
      cluster: found,
      subject,
      googleToken,
      transport: this.#transport,
      signal: context.signal,
    });
    context.log.info('gke.credentials.forget', { cluster, subject });
  }

  // --------------------------------------------------------------------------------- versions

  versions(location: string, context: CallContext): Promise<KubernetesVersions> {
    return readVersions(this.#client, location, context.signal);
  }
}
