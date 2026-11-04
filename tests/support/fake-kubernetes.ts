import {
  ComputeError,
  type CallContext,
  type KubernetesClusterSpec,
  type KubernetesCredentialRequest,
  type KubernetesNodePoolSpec,
  type ProviderDefinition,
  type ProviderKubernetes,
  type ProviderResourceState,
} from '@better-compute/core';
import { defineProvider } from '@better-compute/vps';

// An in-memory managed Kubernetes provider for the kubernetes module's tests (the GKE side lives in provider-gcp):
// clusters and node pools whose operations stay pending for `delayTicks` calls, version upgrades in place, minted
// tokens, and a log of every call.

export const defaultVersion = '1.33.5-gke.1000';

export interface FakeNodePool {
  spec: KubernetesNodePoolSpec;
  ready: boolean;
  op?: string;
}

export interface FakeCluster {
  id: string;
  spec: KubernetesClusterSpec;
  version: string;
  endpoint: string;
  ready: boolean;
  op?: string;
  pools: Map<string, FakeNodePool>;
}

export interface FakeKubernetes {
  clusters: Map<string, FakeCluster>;
  /** Every call, in order: `ensureCluster bc-k-…`, `ensureNodePool gpu`, `credentials bc-u-…-view`, … */
  calls: string[];
  /** Every spec ensureCluster received, in order. */
  specs: KubernetesClusterSpec[];
  /** Each create, update or delete answers in-flight this many times before it completes. */
  delayTicks: number;
  /** Operations that answer `error` (`ensureCluster <name>`, `ensureNodePool <pool>`, `deleteCluster <name>`). */
  refuse: Set<string>;
  /** The next call throws this. */
  failNext?: ComputeError;
  /** Every credential request, and the tokens minted. */
  credentials: { cluster: string; request: KubernetesCredentialRequest }[];
  tokens: string[];
  reset(): void;
}

export function fakeKubernetes(): FakeKubernetes {
  return {
    clusters: new Map(),
    calls: [],
    specs: [],
    delayTicks: 1,
    refuse: new Set(),
    credentials: [],
    tokens: [],
    reset() {
      this.clusters.clear();
      this.calls.length = 0;
      this.specs.length = 0;
      this.delayTicks = 1;
      this.refuse.clear();
      delete this.failNext;
      this.credentials.length = 0;
      this.tokens.length = 0;
    },
  };
}

const progress = new WeakMap<FakeKubernetes, Map<string, number>>();

/** Whether operation `op` is still in flight: it answers so `delayTicks` times, then completes. */
function inFlight(cloud: FakeKubernetes, op: string): boolean {
  let ops = progress.get(cloud);
  if (!ops) progress.set(cloud, (ops = new Map()));
  const left = ops.get(op);
  if (left === undefined) {
    if (cloud.delayTicks <= 0) return false;
    ops.set(op, cloud.delayTicks - 1);
    return true;
  }
  if (left <= 0) {
    ops.delete(op);
    return false;
  }
  ops.set(op, left - 1);
  return true;
}

function begin(cloud: FakeKubernetes, label: string): void {
  cloud.calls.push(label);
  const failure = cloud.failNext;
  if (failure) {
    delete cloud.failNext;
    throw failure;
  }
}

const fullVersion = (requested: string) =>
  /-gke\./.test(requested) || requested.split('.').length === 3
    ? requested
    : `${requested}.1-gke.100`;
const sameList = (a: readonly string[] = [], b: readonly string[] = []) =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join();

export function fakeProviderKubernetes(cloud: FakeKubernetes): ProviderKubernetes {
  let endpoints = 0;
  const cluster = (id: string): FakeCluster => {
    const found = cloud.clusters.get(id);
    if (!found) throw new ComputeError('NOT_FOUND', `Cluster ${id} not found`);
    return found;
  };
  return {
    async ensureCluster(spec): Promise<ProviderResourceState> {
      begin(cloud, `ensureCluster ${spec.name}`);
      cloud.specs.push(structuredClone(spec));
      const id = `projects/fake/locations/${spec.location}/clusters/${spec.name}`;
      if (cloud.refuse.has(`ensureCluster ${spec.name}`))
        return { id, state: 'error', message: 'the provider said no' };
      let found = cloud.clusters.get(id);
      if (!found) {
        if (spec.mode === 'standard' && !(spec.initialNodePools?.length ?? 0))
          throw new ComputeError('INVALID_INPUT', 'A standard cluster is created with node pools');
        found = {
          id,
          spec,
          version: fullVersion(spec.version ?? defaultVersion),
          endpoint: `https://34.118.0.${++endpoints}`,
          ready: false,
          op: `create ${id}`,
          pools: new Map(
            (spec.initialNodePools ?? []).map((pool) => [pool.name, { spec: pool, ready: true }]),
          ),
        };
        cloud.clusters.set(id, found);
      } else {
        if (
          found.spec.mode !== spec.mode ||
          found.spec.privateNodes !== spec.privateNodes ||
          JSON.stringify(found.spec.network) !== JSON.stringify(spec.network)
        )
          throw new ComputeError(
            'INVALID_STATE',
            `Cluster ${spec.name} cannot change that in place`,
          );
        if (spec.version !== undefined && !found.version.startsWith(spec.version)) {
          found.version = fullVersion(spec.version);
          found.op = `upgrade ${id} ${found.version}`;
        }
        if (
          found.spec.releaseChannel !== spec.releaseChannel ||
          !sameList(found.spec.authorizedNetworks, spec.authorizedNetworks)
        )
          found.op ??= `patch ${id} ${spec.releaseChannel} ${spec.authorizedNetworks.join(',')}`;
        found.spec = {
          ...spec,
          ...(found.spec.initialNodePools ? { initialNodePools: found.spec.initialNodePools } : {}),
        };
      }
      if (found.op && inFlight(cloud, found.op))
        return { id, state: found.ready ? 'updating' : 'pending' };
      delete found.op;
      found.ready = true;
      return {
        id,
        state: 'ready',
        outputs: {
          endpoint: found.endpoint,
          version: found.version,
          nodeVersion: found.version,
          location: spec.location,
        },
      };
    },
    async getCluster(id) {
      cloud.calls.push(`getCluster ${id}`);
      const found = cloud.clusters.get(id);
      return found ? { id, state: found.ready ? 'ready' : 'pending' } : undefined;
    },
    async deleteCluster(id) {
      begin(cloud, `deleteCluster ${id}`);
      const found = cloud.clusters.get(id);
      if (!found) return { id, state: 'deleted' };
      if (cloud.refuse.has(`deleteCluster ${found.spec.name}`))
        return { id, state: 'error', message: 'the provider said no' };
      if (inFlight(cloud, `delete ${id}`)) return { id, state: 'deleting' };
      cloud.clusters.delete(id);
      return { id, state: 'deleted' };
    },
    async ensureNodePool(id, spec) {
      begin(cloud, `ensureNodePool ${spec.name}`);
      const found = cluster(id);
      if (!found.ready) throw new ComputeError('INVALID_STATE', `Cluster ${id} is not ready`);
      if (cloud.refuse.has(`ensureNodePool ${spec.name}`))
        return { id: spec.name, state: 'error', message: 'the provider said no' };
      let pool = found.pools.get(spec.name);
      if (!pool) {
        pool = { spec, ready: false, op: `createPool ${id}/${spec.name}` };
        found.pools.set(spec.name, pool);
      } else {
        if (pool.spec.machineType !== spec.machineType)
          throw new ComputeError(
            'INVALID_STATE',
            `Node pool ${spec.name}: machineType is immutable`,
          );
        if (
          pool.spec.nodeCount !== spec.nodeCount ||
          JSON.stringify(pool.spec.autoscaling) !== JSON.stringify(spec.autoscaling)
        )
          pool.op ??= `resizePool ${id}/${spec.name} ${spec.nodeCount}`;
        pool.spec = spec;
      }
      if (pool.op && inFlight(cloud, pool.op))
        return { id: spec.name, state: pool.ready ? 'updating' : 'pending' };
      delete pool.op;
      pool.ready = true;
      return { id: spec.name, state: 'ready' };
    },
    async deleteNodePool(id, name) {
      begin(cloud, `deleteNodePool ${name}`);
      const found = cluster(id);
      if (!found.pools.has(name)) return { id: name, state: 'deleted' };
      if (inFlight(cloud, `deletePool ${id}/${name}`)) return { id: name, state: 'deleting' };
      found.pools.delete(name);
      return { id: name, state: 'deleted' };
    },
    async credentials(id, request, call: CallContext) {
      begin(cloud, `credentials ${request.subject}`);
      const found = cluster(id);
      if (!found.ready) throw new ComputeError('INVALID_STATE', `Cluster ${id} is not ready`);
      const token = `fake-token-${request.subject}-${cloud.tokens.length + 1}`;
      cloud.tokens.push(token);
      cloud.credentials.push({ cluster: id, request });
      return {
        server: found.endpoint,
        certificateAuthorityData: 'LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0t',
        token,
        expiresAt: call.clock.now() + request.ttlSeconds * 1000,
      };
    },
    async versions(location) {
      begin(cloud, `versions ${location}`);
      return {
        defaultVersion,
        validVersions: [defaultVersion, '1.34.1-gke.100'],
        channels: { regular: { defaultVersion, validVersions: [defaultVersion] } },
      };
    },
  };
}

/** Passes any config through (the accounts here carry `zones`). */
const anyConfig = {
  '~standard': { version: 1, vendor: 'test', validate: (value: unknown) => ({ value }) },
};

/** A provider whose accounts provide managed Kubernetes from `cloud` (a GKE stand-in). */
export function fakeKubernetesProvider(cloud: FakeKubernetes, id = 'fake-gke'): ProviderDefinition {
  return defineProvider({
    id,
    version: '1.0.0',
    provides: ['vps'],
    config: anyConfig as never,
    create: () => ({
      async listOffers() {
        return [];
      },
      async create() {
        throw new ComputeError('UNSUPPORTED', 'unused');
      },
      async get() {
        return undefined;
      },
      async delete() {},
      kubernetes: fakeProviderKubernetes(cloud),
    }),
  });
}

/** A provider without managed Kubernetes (a Hetzner stand-in). */
export const noKubernetesProvider: ProviderDefinition = defineProvider({
  id: 'fake-plain',
  version: '1.0.0',
  provides: ['vps'],
  config: anyConfig as never,
  create: () => ({
    async listOffers() {
      return [];
    },
    async create() {
      throw new ComputeError('UNSUPPORTED', 'unused');
    },
    async get() {
      return undefined;
    },
    async delete() {},
  }),
});
