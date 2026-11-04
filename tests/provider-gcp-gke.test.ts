import { describe, expect, it } from 'vitest';
import {
  isComputeError,
  manualClock,
  type CallContext,
  type KubernetesClusterSpec,
  type KubernetesNodePoolSpec,
  type Logger,
  type ProviderImpl,
  type ProviderKubernetes,
} from '@better-compute/core';
import {
  gcpProvider,
  type GcpConfig,
  type GcpProviderOptions,
  type KubeRequest,
  type KubeTransport,
} from '@better-compute/provider-gcp';
import type { Json } from './support/gce-emulator.js';
import { platformAccount, secrets } from './support/gcp-harness.js';
import { emulatedCaData, emulatedCaPem, GkeEmulator } from './support/gke-emulator.js';

// provider-gcp managed Kubernetes (GKE) against the GKE emulator: clusters (Standard and
// Autopilot), in-place updates, node pools, versions and credentials minted through a fake
// Kubernetes API.

interface Captured {
  level: string;
  message: string;
  fields?: Record<string, unknown>;
}

function capturingLog(entries: Captured[]): Logger {
  const at =
    (level: string) =>
    (message: string, fields?: Record<string, unknown>): void => {
      entries.push({ level, message, ...(fields ? { fields } : {}) });
    };
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

interface Setup {
  gke: GkeEmulator;
  impl: ProviderImpl;
  k8s: ProviderKubernetes;
  logs: Captured[];
  ctx: () => CallContext;
}

async function setup(
  options: GcpProviderOptions = {},
  config: Record<string, unknown> = { projectId: 'p', zones: ['us-central1-a'] },
  gke = new GkeEmulator(),
): Promise<Setup> {
  const logs: Captured[] = [];
  const log = capturingLog(logs);
  const provider = gcpProvider({ fetch: gke.fetch, ...options });
  const parsed = await provider.config['~standard'].validate(config);
  if ('issues' in parsed && parsed.issues) throw new Error(parsed.issues[0]!.message);
  const impl = await provider.create((parsed as { value: GcpConfig }).value, {
    clock: manualClock(1_000_000),
    secrets,
    log,
    account: platformAccount,
  });
  const ctx = (): CallContext => ({
    idempotencyKey: 'k1',
    signal: new AbortController().signal,
    clock: manualClock(1_000_000),
    secrets,
    log,
  });
  return { gke, impl, k8s: impl.kubernetes!, logs, ctx };
}

const pool: KubernetesNodePoolSpec = {
  name: 'default',
  machineType: 'e2-standard-4',
  nodeCount: 1,
  diskGiB: 100,
  diskType: 'pd-balanced',
  labels: { workload: 'general' },
  taints: [{ key: 'dedicated', value: 'bc', effect: 'NoSchedule' }],
};

const standard: KubernetesClusterSpec = {
  name: 'bc-k-one',
  location: 'us-central1',
  mode: 'standard',
  releaseChannel: 'regular',
  authorizedNetworks: ['203.0.113.0/24'],
  privateNodes: false,
  initialNodePools: [pool],
  labels: { 'better-compute-tenant': 'T_Acme' },
  description: 'tenant cluster',
};

const autopilot: KubernetesClusterSpec = {
  name: 'bc-k-auto',
  location: 'europe-west4',
  mode: 'autopilot',
  releaseChannel: 'rapid',
  authorizedNetworks: [],
  privateNodes: true,
};

async function settle<T extends { state: string }>(
  call: () => Promise<T>,
  until: string,
  max = 10,
): Promise<{ last: T; states: string[] }> {
  const states: string[] = [];
  for (let i = 0; i < max; i++) {
    const last = await call();
    states.push(last.state);
    if (last.state === until) return { last, states };
  }
  throw new Error(`never ${until}: ${states.join(', ')}`);
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

async function readyCluster(s: Setup, spec: KubernetesClusterSpec = standard): Promise<string> {
  const { last } = await settle(() => s.k8s.ensureCluster(spec, s.ctx()), 'ready');
  return last.id;
}

describe('gke clusters', () => {
  it('is offered with the kubernetes capability', async () => {
    const provider = gcpProvider();
    expect(provider.capabilities).toContain('kubernetes');
    const s = await setup();
    expect(s.k8s).toBeDefined();
  });

  it('creates a standard cluster: pending until the operation is done, then ready with outputs', async () => {
    const s = await setup();
    const first = await s.k8s.ensureCluster(standard, s.ctx());
    expect(first).toEqual({ id: 'us-central1/bc-k-one', state: 'pending' });
    const second = await s.k8s.ensureCluster(standard, s.ctx());
    expect(second).toEqual({
      id: 'us-central1/bc-k-one',
      state: 'ready',
      outputs: {
        endpoint: 'https://34.118.0.10',
        location: 'us-central1',
        version: '1.33.5-gke.1000',
        nodeVersion: '1.33.5-gke.1000',
      },
    });
    // Again: nothing more is created or updated.
    expect((await s.k8s.ensureCluster(standard, s.ctx())).state).toBe('ready');
    const creates = s.gke.calls('POST', '/clusters');
    expect(creates).toHaveLength(1);
    expect(s.gke.calls('PUT', /\/clusters\//)).toHaveLength(0);
    expect(creates[0]!.url.origin + creates[0]!.url.pathname).toBe(
      'https://container.googleapis.com/v1/projects/p/locations/us-central1/clusters',
    );
    const cluster = creates[0]!.body!.cluster as Json;
    expect(cluster).toEqual({
      name: 'bc-k-one',
      description: 'tenant cluster',
      resourceLabels: { 'better-compute-tenant': 't_acme', 'better-compute-managed': 'true' },
      releaseChannel: { channel: 'REGULAR' },
      network: 'default',
      ipAllocationPolicy: { useIpAliases: true },
      privateClusterConfig: { enablePrivateNodes: false },
      masterAuthorizedNetworksConfig: {
        enabled: true,
        cidrBlocks: [{ cidrBlock: '203.0.113.0/24' }],
      },
      shieldedNodes: { enabled: true },
      legacyAbac: { enabled: false },
      workloadIdentityConfig: { workloadPool: 'p.svc.id.goog' },
      nodePools: [
        {
          name: 'default',
          initialNodeCount: 1,
          autoscaling: { enabled: false },
          config: {
            machineType: 'e2-standard-4',
            diskSizeGb: 100,
            diskType: 'pd-balanced',
            labels: { workload: 'general' },
            taints: [{ key: 'dedicated', value: 'bc', effect: 'NO_SCHEDULE' }],
            shieldedInstanceConfig: { enableSecureBoot: true, enableIntegrityMonitoring: true },
            workloadMetadataConfig: { mode: 'GKE_METADATA' },
            oauthScopes: ['https://www.googleapis.com/auth/cloud-platform'],
          },
          management: { autoUpgrade: true, autoRepair: true },
        },
      ],
    });
  });

  it('uses the spec network, or the account network and subnet, and a pinned version', async () => {
    const s = await setup(
      {},
      { projectId: 'p', zones: ['us-central1-a'], network: 'shared', subnet: 'gke-sub' },
    );
    await s.k8s.ensureCluster({ ...standard, version: '1.32' }, s.ctx());
    await s.k8s.ensureCluster(
      { ...standard, name: 'bc-k-two', network: { network: 'tenant-net', subnet: 'tenant-sub' } },
      s.ctx(),
    );
    const [first, second] = s.gke.calls('POST', '/clusters').map((r) => r.body!.cluster as Json);
    expect(first).toMatchObject({
      network: 'shared',
      subnetwork: 'gke-sub',
      initialClusterVersion: '1.32',
    });
    expect(second).toMatchObject({ network: 'tenant-net', subnetwork: 'tenant-sub' });
    expect(second!.initialClusterVersion).toBeUndefined();
  });

  it('creates an autopilot cluster without node pools; ensureNodePool is UNSUPPORTED there', async () => {
    const s = await setup();
    const id = await readyCluster(s, autopilot);
    expect(id).toBe('europe-west4/bc-k-auto');
    const cluster = s.gke.calls('POST', '/clusters')[0]!.body!.cluster as Json;
    expect(cluster.autopilot).toEqual({ enabled: true });
    expect(cluster.nodePools).toBeUndefined();
    expect(cluster.workloadIdentityConfig).toBeUndefined();
    expect(cluster.privateClusterConfig).toEqual({ enablePrivateNodes: true });
    expect(cluster.masterAuthorizedNetworksConfig).toEqual({ enabled: false });
    expect(cluster.releaseChannel).toEqual({ channel: 'RAPID' });
    const error = await rejection(s.k8s.ensureNodePool(id, pool, s.ctx()));
    expect(isComputeError(error, 'UNSUPPORTED')).toBe(true);
    expect(s.gke.calls('POST', '/nodePools')).toHaveLength(0);
  });

  it('refuses a standard cluster without initial node pools, and an autopilot one with some', async () => {
    const s = await setup();
    for (const spec of [
      { ...standard, initialNodePools: [] },
      { ...standard, initialNodePools: undefined },
      { ...autopilot, initialNodePools: [pool] },
    ]) {
      const error = await rejection(s.k8s.ensureCluster(spec, s.ctx()));
      expect(isComputeError(error, 'INVALID_INPUT')).toBe(true);
    }
    expect(s.gke.calls('POST', '/clusters')).toHaveLength(0);
  });

  it('refuses malformed specs and ids', async () => {
    const s = await setup();
    for (const spec of [
      { ...standard, name: 'Bad_Name' },
      { ...standard, location: 'mars' },
      { ...standard, version: 'latest' },
      { ...standard, authorizedNetworks: ['10.0.0.0/33'] },
      { ...standard, releaseChannel: 'nightly' as never },
    ]) {
      const error = await rejection(s.k8s.ensureCluster(spec, s.ctx()));
      expect(isComputeError(error, 'INVALID_INPUT')).toBe(true);
    }
    expect(
      isComputeError(await rejection(s.k8s.getCluster('bc-k-one', s.ctx())), 'INVALID_INPUT'),
    ).toBe(true);
  });

  it('upgrades the control plane in place, one update per call, and a minor is satisfied by a patch', async () => {
    const s = await setup();
    const id = await readyCluster(s, { ...standard, version: '1.32' });
    expect((await s.k8s.getCluster(id, s.ctx()))!.outputs!.version).toBe('1.32.9-gke.1100');
    const upgrade = { ...standard, version: '1.33', authorizedNetworks: ['198.51.100.0/24'] };
    const { last, states } = await settle(() => s.k8s.ensureCluster(upgrade, s.ctx()), 'ready');
    expect(states).toEqual(['updating', 'updating', 'ready']);
    expect(last.outputs!.version).toBe('1.33.5-gke.1000');
    const puts = s.gke.calls('PUT', '/clusters/bc-k-one').map((r) => r.body!.update as Json);
    expect(puts).toEqual([
      { desiredMasterVersion: '1.33' },
      {
        desiredMasterAuthorizedNetworksConfig: {
          enabled: true,
          cidrBlocks: [{ cidrBlock: '198.51.100.0/24' }],
        },
      },
    ]);
    // Satisfied now: no more updates.
    expect((await s.k8s.ensureCluster(upgrade, s.ctx())).state).toBe('ready');
    // Opening the endpoint to everyone disables the authorized networks.
    await settle(
      () => s.k8s.ensureCluster({ ...upgrade, authorizedNetworks: [] }, s.ctx()),
      'ready',
    );
    expect(s.gke.calls('PUT', '/clusters/bc-k-one').at(-1)!.body!.update).toEqual({
      desiredMasterAuthorizedNetworksConfig: { enabled: false },
    });
    expect(s.gke.calls('PUT', '/clusters/bc-k-one')).toHaveLength(3);
  });

  it('changes the release channel in place', async () => {
    const s = await setup();
    const id = await readyCluster(s);
    await settle(
      () => s.k8s.ensureCluster({ ...standard, releaseChannel: 'stable' }, s.ctx()),
      'ready',
    );
    expect(s.gke.calls('PUT', '/clusters/bc-k-one').map((r) => r.body!.update)).toEqual([
      { desiredReleaseChannel: { channel: 'STABLE' } },
    ]);
    expect(s.gke.clusters.get(id)!.releaseChannel).toEqual({ channel: 'STABLE' });
  });

  it('refuses a downgrade and differences that cannot change in place with INVALID_STATE', async () => {
    const s = await setup();
    await readyCluster(s);
    for (const spec of [
      { ...standard, version: '1.32' },
      { ...standard, version: '1.33.4-gke.900' },
      { ...standard, mode: 'autopilot' as const, initialNodePools: undefined },
      { ...standard, privateNodes: true },
      { ...standard, network: { network: 'other' } },
    ]) {
      const error = await rejection(s.k8s.ensureCluster(spec, s.ctx()));
      expect(isComputeError(error, 'INVALID_STATE')).toBe(true);
    }
    expect(s.gke.calls('PUT', /\/clusters\//)).toHaveLength(0);
  });

  it('answers updating, not an error, while another operation runs on the cluster', async () => {
    const s = await setup();
    const id = await readyCluster(s);
    const foreign = s.gke.occupy(id);
    const state = await s.k8s.ensureCluster({ ...standard, version: '1.34' }, s.ctx());
    expect(state).toMatchObject({ id, state: 'updating' });
    expect(state.message).toContain(foreign);
    // A node pool and a delete wait the same way.
    expect(
      await s.k8s.ensureNodePool(
        id,
        { ...pool, name: 'gpu', machineType: 'g2-standard-4' },
        s.ctx(),
      ),
    ).toMatchObject({ state: 'pending' });
    expect(await s.k8s.deleteCluster(id, s.ctx())).toMatchObject({ state: 'updating' });
    s.gke.finishOperations();
    const { last } = await settle(
      () => s.k8s.ensureCluster({ ...standard, version: '1.34' }, s.ctx()),
      'ready',
    );
    expect(last.outputs!.version).toBe('1.34.1-gke.1200');
  });

  it('reports a failed operation as error with its message', async () => {
    const s = await setup();
    s.gke.failNextOperation = { message: 'Insufficient regional quota to satisfy request' };
    expect((await s.k8s.ensureCluster(standard, s.ctx())).state).toBe('pending');
    expect(await s.k8s.ensureCluster(standard, s.ctx())).toEqual({
      id: 'us-central1/bc-k-one',
      state: 'error',
      message: 'Insufficient regional quota to satisfy request',
    });
    // The cluster GKE left behind is in ERROR: reported, not re-created.
    expect(await s.k8s.ensureCluster(standard, s.ctx())).toMatchObject({
      state: 'error',
      message: 'Insufficient regional quota to satisfy request',
    });
    expect(s.gke.calls('POST', '/clusters')).toHaveLength(1);
  });

  it('re-reads after a restart, and a create that already exists is not an error', async () => {
    const gke = new GkeEmulator();
    const s1 = await setup({}, undefined, gke);
    expect((await s1.k8s.ensureCluster(standard, s1.ctx())).state).toBe('pending');
    // A new process knows no operation: the cluster's status says where it is.
    const s2 = await setup({}, undefined, gke);
    expect((await s2.k8s.ensureCluster(standard, s2.ctx())).state).toBe('pending');
    gke.finishOperations();
    expect((await s2.k8s.ensureCluster(standard, s2.ctx())).state).toBe('ready');
    expect(gke.calls('POST', '/clusters')).toHaveLength(1);
  });

  it('deletes a cluster: deleting until it is gone, then deleted', async () => {
    const s = await setup();
    const id = await readyCluster(s);
    expect(await s.k8s.deleteCluster(id, s.ctx())).toEqual({ id, state: 'deleting' });
    expect(await s.k8s.getCluster(id, s.ctx())).toEqual({ id, state: 'deleting' });
    expect(await s.k8s.deleteCluster(id, s.ctx())).toEqual({ id, state: 'deleted' });
    expect(await s.k8s.deleteCluster(id, s.ctx())).toEqual({ id, state: 'deleted' });
    expect(s.gke.calls('DELETE', '/clusters/bc-k-one')).toHaveLength(1);
    expect(await s.k8s.getCluster(id, s.ctx())).toBeUndefined();
  });

  it('getCluster is undefined for a cluster that does not exist', async () => {
    const s = await setup();
    expect(await s.k8s.getCluster('us-central1/bc-k-none', s.ctx())).toBeUndefined();
    expect(await s.k8s.deleteCluster('us-central1/bc-k-none', s.ctx())).toEqual({
      id: 'us-central1/bc-k-none',
      state: 'deleted',
    });
  });

  it('lists the versions of a location', async () => {
    const s = await setup();
    const versions = await s.k8s.versions('us-central1', s.ctx());
    expect(versions.defaultVersion).toBe('1.33.5-gke.1000');
    expect(versions.validVersions).toContain('1.34.1-gke.1200');
    expect(versions.channels.rapid).toEqual({
      defaultVersion: '1.34.1-gke.1200',
      validVersions: ['1.34.1-gke.1200', '1.33.5-gke.1000'],
    });
    expect(Object.keys(versions.channels).sort()).toEqual([
      'extended',
      'rapid',
      'regular',
      'stable',
    ]);
    expect(s.gke.calls('GET', '/locations/us-central1/serverConfig')).toHaveLength(1);
    expect(
      isComputeError(await rejection(s.k8s.versions('nowhere', s.ctx())), 'INVALID_INPUT'),
    ).toBe(true);
  });
});

describe('gke node pools', () => {
  const gpu: KubernetesNodePoolSpec = {
    name: 'gpu',
    machineType: 'g2-standard-4',
    nodeCount: 1,
    spot: true,
    accelerators: { type: 'nvidia-l4', count: 1 },
    zones: ['us-central1-a', 'us-central1-b'],
  };

  it('creates, resizes, autoscales and deletes a node pool', async () => {
    const s = await setup();
    const cluster = await readyCluster(s);
    const id = `${cluster}/gpu`;
    const { states } = await settle(() => s.k8s.ensureNodePool(cluster, gpu, s.ctx()), 'ready');
    expect(states).toEqual(['pending', 'ready']);
    const creates = s.gke.calls('POST', '/clusters/bc-k-one/nodePools');
    expect(creates).toHaveLength(1);
    expect(creates[0]!.body!.nodePool).toEqual({
      name: 'gpu',
      initialNodeCount: 1,
      autoscaling: { enabled: false },
      config: {
        machineType: 'g2-standard-4',
        spot: true,
        accelerators: [
          {
            acceleratorType: 'nvidia-l4',
            acceleratorCount: 1,
            gpuDriverInstallationConfig: { gpuDriverVersion: 'DEFAULT' },
          },
        ],
        shieldedInstanceConfig: { enableSecureBoot: true, enableIntegrityMonitoring: true },
        workloadMetadataConfig: { mode: 'GKE_METADATA' },
        oauthScopes: ['https://www.googleapis.com/auth/cloud-platform'],
      },
      locations: ['us-central1-a', 'us-central1-b'],
      management: { autoUpgrade: true, autoRepair: true },
    });
    expect(await s.k8s.ensureNodePool(cluster, gpu, s.ctx())).toEqual({
      id,
      state: 'ready',
      outputs: { version: '1.33.5-gke.1000' },
    });

    // Resize: one setSize, then ready; the size is read from the instance groups.
    const resized = await settle(
      () => s.k8s.ensureNodePool(cluster, { ...gpu, nodeCount: 3 }, s.ctx()),
      'ready',
    );
    expect(resized.states).toEqual(['updating', 'ready']);
    expect(s.gke.calls('POST', '/nodePools/gpu:setSize').map((r) => r.body)).toEqual([
      { nodeCount: 3 },
    ]);
    expect([...s.gke.instanceGroupSizes.values()]).toEqual([1, 3, 3]);
    expect((await s.k8s.ensureNodePool(cluster, { ...gpu, nodeCount: 3 }, s.ctx())).state).toBe(
      'ready',
    );
    expect(s.gke.calls('POST', '/nodePools/gpu:setSize')).toHaveLength(1);

    // Autoscaling: one setAutoscaling; the autoscaler then owns the size (no setSize).
    const scaled = { ...gpu, nodeCount: 1, autoscaling: { minNodes: 0, maxNodes: 4 } };
    await settle(() => s.k8s.ensureNodePool(cluster, scaled, s.ctx()), 'ready');
    expect(s.gke.calls('POST', '/nodePools/gpu:setAutoscaling').map((r) => r.body)).toEqual([
      { autoscaling: { enabled: true, minNodeCount: 0, maxNodeCount: 4 } },
    ]);
    expect((await s.k8s.ensureNodePool(cluster, scaled, s.ctx())).state).toBe('ready');
    expect(s.gke.calls('POST', '/nodePools/gpu:setSize')).toHaveLength(1);
    expect(s.gke.calls('POST', '/nodePools/gpu:setAutoscaling')).toHaveLength(1);

    // Only size and autoscaling change in place.
    for (const spec of [
      { ...scaled, machineType: 'g2-standard-8' },
      { ...scaled, spot: false },
      { ...scaled, accelerators: { type: 'nvidia-l4', count: 2 } },
      { ...scaled, zones: ['us-central1-a'] },
    ]) {
      const error = await rejection(s.k8s.ensureNodePool(cluster, spec, s.ctx()));
      expect(isComputeError(error, 'INVALID_STATE')).toBe(true);
    }

    // Delete: deleting until gone, then deleted.
    expect(await s.k8s.deleteNodePool(cluster, 'gpu', s.ctx())).toEqual({ id, state: 'deleting' });
    expect(await s.k8s.deleteNodePool(cluster, 'gpu', s.ctx())).toEqual({ id, state: 'deleted' });
    expect(await s.k8s.deleteNodePool(cluster, 'gpu', s.ctx())).toEqual({ id, state: 'deleted' });
    expect(s.gke.calls('DELETE', '/nodePools/gpu')).toHaveLength(1);
  });

  it('refuses a pool on a cluster that does not exist, and malformed pools', async () => {
    const s = await setup();
    expect(
      isComputeError(
        await rejection(s.k8s.ensureNodePool('us-central1/bc-k-none', gpu, s.ctx())),
        'NOT_FOUND',
      ),
    ).toBe(true);
    const cluster = await readyCluster(s);
    for (const spec of [
      { ...gpu, name: 'GPU' },
      { ...gpu, nodeCount: -1 },
      { ...gpu, autoscaling: { minNodes: 3, maxNodes: 2 } },
      { ...gpu, zones: ['us-central1'] },
      { ...gpu, taints: [{ key: 'a', effect: 'Sometimes' as never }] },
    ]) {
      const error = await rejection(s.k8s.ensureNodePool(cluster, spec, s.ctx()));
      expect(isComputeError(error, 'INVALID_INPUT')).toBe(true);
    }
    expect(await s.k8s.deleteNodePool('us-central1/bc-k-none', 'gpu', s.ctx())).toMatchObject({
      state: 'deleted',
    });
  });
});

// ------------------------------------------------------------------------------- credentials

class FakeKube {
  calls: KubeRequest[] = [];
  namespaces = new Set<string>();
  serviceAccounts = new Set<string>();
  bindings = new Map<string, Json>();
  issued: string[] = [];
  /** Answers every request with this status (an error body) instead. */
  failWith?: number;
  /** Throws instead of answering (a network failure). */
  unreachable = false;

  transport: KubeTransport = async (request) => {
    this.calls.push(request);
    if (this.unreachable) throw new Error('connect ECONNREFUSED');
    if (this.failWith)
      return {
        status: this.failWith,
        body: { kind: 'Status', message: 'forbidden', reason: 'Forbidden' },
      };
    const path = new URL(request.url).pathname;
    const body = request.body as Json | undefined;
    const ok = (status: number, payload: unknown) => ({ status, body: payload });
    const exists = { kind: 'Status', reason: 'AlreadyExists', message: 'already exists' };
    const missing = { kind: 'Status', reason: 'NotFound', message: 'not found' };
    let m: RegExpExecArray | null;
    if (request.method === 'POST' && path === '/api/v1/namespaces') {
      if (this.namespaces.has(body!.metadata.name)) return ok(409, exists);
      this.namespaces.add(body!.metadata.name);
      return ok(201, body);
    }
    if (
      (m = /^\/api\/v1\/namespaces\/([^/]+)\/serviceaccounts$/.exec(path)) &&
      request.method === 'POST'
    ) {
      if (!this.namespaces.has(m[1]!)) return ok(404, missing);
      const key = `${m[1]}/${body!.metadata.name}`;
      if (this.serviceAccounts.has(key)) return ok(409, exists);
      this.serviceAccounts.add(key);
      return ok(201, body);
    }
    if ((m = /^\/api\/v1\/namespaces\/([^/]+)\/serviceaccounts\/([^/]+)\/token$/.exec(path))) {
      if (!this.serviceAccounts.has(`${m[1]}/${m[2]}`)) return ok(404, missing);
      const token = `kube-sa-token-${this.issued.length + 1}`;
      this.issued.push(token);
      const ttl = body!.spec.expirationSeconds as number;
      return ok(201, {
        ...body,
        status: { token, expirationTimestamp: new Date(1_000_000 + ttl * 1000).toISOString() },
      });
    }
    const bindings = '/apis/rbac.authorization.k8s.io/v1/clusterrolebindings';
    if (path === bindings && request.method === 'POST') {
      if (this.bindings.has(body!.metadata.name)) return ok(409, exists);
      this.bindings.set(body!.metadata.name, body!);
      return ok(201, body);
    }
    if (path.startsWith(`${bindings}/`)) {
      const name = decodeURIComponent(path.slice(bindings.length + 1));
      const found = this.bindings.get(name);
      if (!found) return ok(404, missing);
      if (request.method === 'GET') return ok(200, found);
      if (request.method === 'DELETE') {
        this.bindings.delete(name);
        return ok(200, { kind: 'Status', status: 'Success' });
      }
    }
    return ok(404, missing);
  };

  routes(): string[] {
    return this.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`);
  }
}

describe('gke credentials', () => {
  async function withKube(): Promise<Setup & { kube: FakeKube; cluster: string }> {
    const kube = new FakeKube();
    const s = await setup({ kubeTransport: kube.transport });
    const cluster = await readyCluster(s);
    return { ...s, kube, cluster };
  }

  it('creates the namespace, service account and binding, and mints a bound token', async () => {
    const s = await withKube();
    const credentials = await s.k8s.credentials(
      s.cluster,
      { subject: 'bc-u-alice', role: 'edit', ttlSeconds: 3600 },
      s.ctx(),
    );
    expect(credentials).toEqual({
      server: 'https://34.118.0.10',
      certificateAuthorityData: emulatedCaData,
      token: 'kube-sa-token-1',
      expiresAt: 1_000_000 + 3600 * 1000,
    });
    expect(s.kube.routes()).toEqual([
      'POST /api/v1/namespaces',
      'POST /api/v1/namespaces/bc-access/serviceaccounts',
      'GET /apis/rbac.authorization.k8s.io/v1/clusterrolebindings/bc-access:bc-u-alice',
      'POST /apis/rbac.authorization.k8s.io/v1/clusterrolebindings',
      'POST /api/v1/namespaces/bc-access/serviceaccounts/bc-u-alice/token',
    ]);
    // Every call trusts the cluster's CA only and carries the account's own Google token.
    for (const call of s.kube.calls) {
      expect(call.caPem).toBe(emulatedCaPem);
      expect(s.gke.gce.mintedTokens).toContain(call.token);
      expect(call.url.startsWith('https://34.118.0.10/')).toBe(true);
    }
    expect(s.kube.bindings.get('bc-access:bc-u-alice')).toMatchObject({
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'edit' },
      subjects: [{ kind: 'ServiceAccount', name: 'bc-u-alice', namespace: 'bc-access' }],
      metadata: { labels: { 'app.kubernetes.io/managed-by': 'better-compute' } },
    });
    expect(s.kube.calls.at(-1)!.body).toEqual({
      apiVersion: 'authentication.k8s.io/v1',
      kind: 'TokenRequest',
      spec: { expirationSeconds: 3600 },
    });

    // Again with the same role: everything is reused, a new token is minted.
    const again = await s.k8s.credentials(
      s.cluster,
      { subject: 'bc-u-alice', role: 'edit', ttlSeconds: 600 },
      s.ctx(),
    );
    expect(again.token).toBe('kube-sa-token-2');
    expect(s.kube.routes().filter((r) => r.startsWith('DELETE'))).toHaveLength(0);
    expect(s.kube.routes().filter((r) => r.endsWith('/clusterrolebindings'))).toHaveLength(1);
  });

  it('recreates the binding when the role changes (roleRef is immutable)', async () => {
    const s = await withKube();
    const request = { subject: 'bc-u-bob', role: 'view' as const, ttlSeconds: 3600 };
    await s.k8s.credentials(s.cluster, request, s.ctx());
    expect(s.kube.bindings.get('bc-access:bc-u-bob')!.roleRef.name).toBe('view');
    s.kube.calls = [];
    await s.k8s.credentials(s.cluster, { ...request, role: 'admin' }, s.ctx());
    expect(s.kube.routes()).toEqual([
      'POST /api/v1/namespaces',
      'POST /api/v1/namespaces/bc-access/serviceaccounts',
      'GET /apis/rbac.authorization.k8s.io/v1/clusterrolebindings/bc-access:bc-u-bob',
      'DELETE /apis/rbac.authorization.k8s.io/v1/clusterrolebindings/bc-access:bc-u-bob',
      'POST /apis/rbac.authorization.k8s.io/v1/clusterrolebindings',
      'POST /api/v1/namespaces/bc-access/serviceaccounts/bc-u-bob/token',
    ]);
    expect(s.kube.bindings.get('bc-access:bc-u-bob')!.roleRef.name).toBe('cluster-admin');
  });

  it('validates the subject, role and ttl before calling anything', async () => {
    const s = await withKube();
    for (const request of [
      { subject: 'Bob', role: 'view', ttlSeconds: 3600 },
      { subject: 'bc-u-', role: 'view', ttlSeconds: 3600 },
      { subject: `bc-${'a'.repeat(61)}`, role: 'view', ttlSeconds: 3600 },
      { subject: 'bc-u-bob', role: 'owner', ttlSeconds: 3600 },
      { subject: 'bc-u-bob', role: 'view', ttlSeconds: 599 },
      { subject: 'bc-u-bob', role: 'view', ttlSeconds: 86_401 },
      { subject: 'bc-u-bob', role: 'view', ttlSeconds: 1000.5 },
    ]) {
      const error = await rejection(s.k8s.credentials(s.cluster, request as never, s.ctx()));
      expect(isComputeError(error, 'INVALID_INPUT')).toBe(true);
    }
    expect(s.kube.calls).toHaveLength(0);
  });

  it('maps Kubernetes API failures and an absent cluster', async () => {
    const s = await withKube();
    const request = { subject: 'bc-u-carol', role: 'view' as const, ttlSeconds: 3600 };
    s.kube.failWith = 403;
    expect(
      isComputeError(
        await rejection(s.k8s.credentials(s.cluster, request, s.ctx())),
        'ACCESS_DENIED',
      ),
    ).toBe(true);
    s.kube.failWith = 503;
    expect(
      isComputeError(
        await rejection(s.k8s.credentials(s.cluster, request, s.ctx())),
        'UNAVAILABLE',
      ),
    ).toBe(true);
    s.kube.failWith = undefined;
    s.kube.unreachable = true;
    const unreachable = await rejection(s.k8s.credentials(s.cluster, request, s.ctx()));
    expect(isComputeError(unreachable, 'UNAVAILABLE')).toBe(true);
    expect(
      isComputeError(
        await rejection(s.k8s.credentials('us-central1/bc-k-none', request, s.ctx())),
        'NOT_FOUND',
      ),
    ).toBe(true);
  });

  it('never logs or reports a token', async () => {
    const s = await withKube();
    const minted = await s.k8s.credentials(
      s.cluster,
      { subject: 'bc-u-dave', role: 'admin', ttlSeconds: 3600 },
      s.ctx(),
    );
    s.kube.failWith = 401;
    const failure = await rejection(
      s.k8s.credentials(
        s.cluster,
        { subject: 'bc-u-dave', role: 'admin', ttlSeconds: 3600 },
        s.ctx(),
      ),
    );
    expect(isComputeError(failure, 'ACCESS_DENIED')).toBe(true);
    const secretsSeen = [minted.token, ...s.gke.gce.mintedTokens];
    expect(secretsSeen.length).toBeGreaterThan(1);
    const logged = JSON.stringify(s.logs);
    expect(s.logs.some((entry) => entry.message === 'gke.credentials')).toBe(true);
    for (const token of secretsSeen) {
      expect(logged).not.toContain(token);
      expect(String((failure as Error).message)).not.toContain(token);
      expect(JSON.stringify((failure as { details?: unknown }).details ?? {})).not.toContain(token);
    }
  });
});
