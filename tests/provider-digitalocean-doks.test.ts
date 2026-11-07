import { once } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  isComputeError,
  manualClock,
  type CallContext,
  type ComputeError,
  type KubernetesClusterSpec,
  type KubernetesNodePoolSpec,
  type Logger,
  type ProviderKubernetes,
} from '@better-compute/core';
import {
  deploymentTag,
  digitaloceanProvider,
  httpsKubeTransport,
  tagFor,
  type DoCompute,
  type DoConfig,
  type DoProviderOptions,
} from '@better-compute/provider-digitalocean';
import { createServingCa, generateP256KeyPair, privateKeyPem, toPem } from '@better-compute/pki';
import { seedDroplet } from './support/do-emulator/droplets.js';
import { DoEmulator, type Json } from './support/do-emulator/index.js';
import { seedVpc } from './support/do-emulator/vpcs.js';
import { doAccount, freshBudgets, platformAccount, secrets } from './support/do-harness.js';
import { DoksEmulator, doksCaData, doksCaPem } from './support/doks-emulator.js';

// provider-digitalocean managed Kubernetes (DOKS) against the DOKS emulator: the contract wiring,
// versions, clusters, node pools (CPU, GPU, Spot GPU, autoscaling), credentials minted through a
// cluster's own Kubernetes API, upgrades and deletes.

const t0 = Date.parse('2026-11-01T10:00:00Z');

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
  doks: DoksEmulator;
  impl: DoCompute;
  k8s: ProviderKubernetes;
  logs: Captured[];
  ctx: () => CallContext;
}

async function setup(
  config: Record<string, unknown> = { ...doAccount, regions: ['nyc3', 'tor1'] },
  options: DoProviderOptions = {},
  doks = new DoksEmulator(new DoEmulator({ now: () => t0 })),
): Promise<Setup> {
  const logs: Captured[] = [];
  const log = capturingLog(logs);
  const provider = digitaloceanProvider({
    fetch: doks.fetch,
    kubeTransport: doks.kube.transport,
    ...options,
  });
  const parsed = await provider.config['~standard'].validate(config);
  if ('issues' in parsed && parsed.issues) throw new Error(parsed.issues[0]!.message);
  const impl = (await provider.create((parsed as { value: DoConfig }).value, {
    clock: manualClock(t0),
    secrets,
    log,
    account: platformAccount,
  })) as DoCompute;
  const ctx = (): CallContext => ({
    idempotencyKey: 'k1',
    signal: new AbortController().signal,
    clock: manualClock(t0),
    secrets,
    log,
  });
  return { doks, impl, k8s: impl.kubernetes!, logs, ctx };
}

async function failure(promise: Promise<unknown>): Promise<ComputeError> {
  try {
    await promise;
  } catch (error) {
    if (isComputeError(error)) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

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

const cpuPool: KubernetesNodePoolSpec = {
  name: 'general',
  machineType: 's-2vcpu-4gb',
  nodeCount: 2,
  labels: { workload: 'general' },
  taints: [{ key: 'dedicated', value: 'bc', effect: 'NoSchedule' }],
};

const standard: KubernetesClusterSpec = {
  name: 'bc-k-one',
  location: 'nyc3',
  mode: 'standard',
  releaseChannel: 'regular',
  authorizedNetworks: ['203.0.113.0/24'],
  privateNodes: false,
  initialNodePools: [cpuPool],
  labels: { 'better-compute-cluster': 'kc_one' },
  description: 'tenant cluster',
};

/**
 * A fetch over the emulator that loses DigitalOcean's answer to the next request matching (path
 * `/v2`-relative): the change is made, the caller gets `status` instead (503: the answer never
 * came; 409: another creator got there first).
 */
function losing(
  doks: DoksEmulator,
  method: string,
  path: RegExp,
  status = 503,
): NonNullable<DoProviderOptions['fetch']> {
  let armed = true;
  return async (input, init) => {
    const response = await doks.fetch(input, init);
    const url = new URL(typeof input === 'object' && 'url' in input ? input.url : String(input));
    const hit =
      (init?.method ?? 'GET').toUpperCase() === method &&
      path.test(url.pathname.replace(/^\/v2/, ''));
    if (!armed || !hit) return response;
    armed = false;
    const id = status === 409 ? 'conflict' : 'service_unavailable';
    return new Response(JSON.stringify({ id, message: 'answer lost' }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
}

async function readyCluster(s: Setup, spec: KubernetesClusterSpec = standard): Promise<string> {
  const { last } = await settle(() => s.k8s.ensureCluster(spec, s.ctx()), 'ready');
  return last.id;
}

beforeEach(() => freshBudgets());

describe('doks contract', () => {
  it('is offered with the kubernetes capability', async () => {
    const provider = digitaloceanProvider();
    expect(provider.capabilities).toContain('kubernetes');
    const s = await setup();
    expect(s.k8s).toBeDefined();
  });

  it('lists the versions: newest first is the default, and no release channels', async () => {
    const s = await setup();
    const versions = await s.k8s.versions('nyc3', s.ctx());
    expect(versions).toEqual({
      defaultVersion: '1.34.1-do.0',
      validVersions: ['1.34.1-do.0', '1.33.5-do.1', '1.33.4-do.0', '1.32.9-do.2'],
      channels: {},
    });
    const request = s.doks.do.requests.at(-1)!;
    expect(request.url.pathname).toBe('/v2/kubernetes/options');
  });

  it('refuses the versions of a region the account does not work in', async () => {
    const s = await setup();
    const error = await failure(s.k8s.versions('sfo3', s.ctx()));
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.details).toMatchObject({ provider: 'digitalocean', reason: 'region' });
  });
});

const ours = [tagFor('better-compute-kubernetes', 'true'), deploymentTag('default')];

function posted(s: Setup, path: string, method = 'POST'): Json[] {
  return s.doks.do.requests
    .filter((r) => r.method === method && r.url.pathname === `/v2${path}`)
    .map((r) => r.body as Json);
}

function mutations(s: Setup): string[] {
  return s.doks.do.requests
    .filter((r) => r.method !== 'GET')
    .map((r) => `${r.method} ${r.url.pathname.replace('/v2', '')}`);
}

describe('doks clusters', () => {
  it('creates a standard cluster: pending until it runs, then ready with outputs', async () => {
    const s = await setup();
    const first = await s.k8s.ensureCluster(standard, s.ctx());
    expect(first.state).toBe('pending');
    const [body] = posted(s, '/kubernetes/clusters');
    expect(body).toEqual({
      name: 'bc-k-one',
      region: 'nyc3',
      version: '1.34.1-do.0',
      tags: [...ours, 'better-compute-cluster:kc_one'],
      node_pools: [
        {
          name: 'general',
          size: 's-2vcpu-4gb',
          count: 2,
          tags: ours,
          labels: { workload: 'general' },
          taints: [{ key: 'dedicated', value: 'bc', effect: 'NoSchedule' }],
          auto_scale: false,
        },
      ],
      auto_upgrade: true,
      surge_upgrade: true,
      ha: false,
      control_plane_firewall: { enabled: true, allowed_addresses: ['203.0.113.0/24'] },
      nvidia_gpu_device_plugin: { enabled: false },
      amd_gpu_device_plugin: { enabled: false },
      amd_gpu_device_metrics_exporter_plugin: { enabled: false },
    });
    const { last } = await settle(() => s.k8s.ensureCluster(standard, s.ctx()), 'ready');
    expect(last.id).toBe(first.id);
    expect(last.outputs).toEqual({
      endpoint: `https://${first.id}.k8s.ondigitalocean.com`,
      location: 'nyc3',
      version: '1.34.1-do.0',
      nodeVersion: '1.34.1-do.0',
    });
    // Ready and as wanted: nothing more is sent.
    const before = mutations(s).length;
    expect((await s.k8s.ensureCluster(standard, s.ctx())).state).toBe('ready');
    expect(mutations(s)).toHaveLength(before);
    expect(await s.k8s.getCluster(first.id, s.ctx())).toMatchObject({
      id: first.id,
      state: 'ready',
    });
    expect(s.logs.some((entry) => entry.message === 'doks.cluster.create')).toBe(true);
  });

  it('pins a version by its minor or its slug, and refuses one DOKS does not offer', async () => {
    const s = await setup();
    await s.k8s.ensureCluster({ ...standard, version: '1.33' }, s.ctx());
    await s.k8s.ensureCluster({ ...standard, name: 'bc-k-two', version: '1.32.9-do.2' }, s.ctx());
    expect(posted(s, '/kubernetes/clusters').map((b) => b.version)).toEqual([
      '1.33.5-do.1',
      '1.32.9-do.2',
    ]);
    const error = await failure(
      s.k8s.ensureCluster({ ...standard, name: 'bc-k-three', version: '1.29' }, s.ctx()),
    );
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.details).toMatchObject({ reason: 'version' });
  });

  it("joins the spec network's VPC in the region, or the account VPC", async () => {
    const s = await setup({ ...doAccount, regions: ['nyc3', 'tor1'], vpc: 'acct-vpc' });
    const subnet = seedVpc(s.doks.do.state, {
      name: 'bc-sub-1',
      region: 'nyc3',
      description: 'bc:network=net1',
    });
    const account = seedVpc(s.doks.do.state, { name: 'acct-vpc', region: 'nyc3' });
    await s.k8s.ensureCluster({ ...standard, network: { network: 'net1' } }, s.ctx());
    await s.k8s.ensureCluster({ ...standard, name: 'bc-k-two' }, s.ctx());
    expect(posted(s, '/kubernetes/clusters').map((b) => b.vpc_uuid)).toEqual([
      subnet.id,
      account.id,
    ]);
    // The network cannot change in place.
    await settle(
      () => s.k8s.ensureCluster({ ...standard, network: { network: 'net1' } }, s.ctx()),
      'ready',
    );
    seedVpc(s.doks.do.state, { name: 'bc-sub-2', region: 'nyc3', description: 'bc:network=net2' });
    const moved = await failure(
      s.k8s.ensureCluster({ ...standard, network: { network: 'net2' } }, s.ctx()),
    );
    expect(moved.code).toBe('INVALID_STATE');
    expect(moved.details).toMatchObject({ reason: 'immutable', field: 'network' });
  });

  it('refuses what DOKS does not have, malformed specs and ids', async () => {
    const s = await setup();
    const cases: [Partial<KubernetesClusterSpec>, string, string][] = [
      [{ mode: 'autopilot', initialNodePools: [] }, 'UNSUPPORTED', 'autopilot'],
      [{ privateNodes: true }, 'UNSUPPORTED', 'privateNodes'],
      [{ initialNodePools: [] }, 'INVALID_INPUT', 'initialNodePools'],
      [{ name: 'Bad_Name' }, 'INVALID_INPUT', 'name'],
      [{ location: 'sfo3' }, 'INVALID_INPUT', 'region'],
      [{ authorizedNetworks: ['10.0.0.0/33'] }, 'INVALID_INPUT', 'cidr'],
      [{ version: 'latest' }, 'INVALID_INPUT', 'version'],
      [{ labels: { 'bad key!': 'x' } }, 'INVALID_INPUT', 'label'],
      // DOKS's own tag namespace (k8s, k8s:<uuid>, k8s-worker) is never a label's.
      [{ labels: { k8s: 'x' } }, 'INVALID_INPUT', 'label'],
      [{ labels: { K8S: '0d0c5000-0000-4000-8000-000000000009' } }, 'INVALID_INPUT', 'label'],
      [{ labels: { 'k8s-worker': 'x' } }, 'INVALID_INPUT', 'label'],
      [{ initialNodePools: [{ ...cpuPool, zones: ['nyc3-a'] }] }, 'UNSUPPORTED', 'zones'],
      [{ initialNodePools: [{ ...cpuPool, diskGiB: 100 }] }, 'UNSUPPORTED', 'disk'],
      [{ initialNodePools: [cpuPool, cpuPool] }, 'INVALID_INPUT', 'nodePool'],
    ];
    for (const [change, code, reason] of cases) {
      const error = await failure(s.k8s.ensureCluster({ ...standard, ...change }, s.ctx()));
      expect([error.code, error.details?.reason]).toEqual([code, reason]);
    }
    expect(mutations(s)).toEqual([]);
    for (const id of ['bc-k-one', 'nyc3/bc-k-one', '']) {
      const error = await failure(s.k8s.getCluster(id, s.ctx()));
      expect(error.code).toBe('INVALID_INPUT');
    }
  });

  it('changes auto-upgrade and the control-plane firewall in place, and keeps the device plugins off', async () => {
    const s = await setup();
    const id = await readyCluster(s);
    const changed = { ...standard, releaseChannel: 'extended' as const, authorizedNetworks: [] };
    expect((await s.k8s.ensureCluster(changed, s.ctx())).state).toBe('updating');
    const [put] = posted(s, `/kubernetes/clusters/${id}`, 'PUT');
    expect(put).toEqual({
      name: 'bc-k-one',
      tags: [...ours, 'better-compute-cluster:kc_one'],
      auto_upgrade: false,
      control_plane_firewall: { enabled: false, allowed_addresses: [] },
    });
    expect((await s.k8s.ensureCluster(changed, s.ctx())).state).toBe('ready');
    // Someone turned DOKS's NVIDIA plugin on: it goes off again (DO-D18).
    s.doks.clusters.get(id)!.nvidia_gpu_device_plugin = { enabled: true };
    expect((await s.k8s.ensureCluster(changed, s.ctx())).state).toBe('updating');
    expect(posted(s, `/kubernetes/clusters/${id}`, 'PUT').at(-1)).toMatchObject({
      nvidia_gpu_device_plugin: { enabled: false },
      amd_gpu_device_plugin: { enabled: false },
      amd_gpu_device_metrics_exporter_plugin: { enabled: false },
    });
    expect(s.doks.clusters.get(id)!.nvidia_gpu_device_plugin).toEqual({ enabled: false });
  });

  it("applies a label change to an existing cluster's tags, keeping tags it does not name", async () => {
    const s = await setup();
    const id = await readyCluster(s);
    // Someone else's tag on the cluster.
    s.doks.clusters.get(id)!.tags.push('team:web');
    const relabelled = {
      ...standard,
      labels: { 'better-compute-cluster': 'kc_two', tier: 'gold' },
    };
    expect((await s.k8s.ensureCluster(relabelled, s.ctx())).state).toBe('updating');
    expect(posted(s, `/kubernetes/clusters/${id}`, 'PUT').at(-1)).toEqual({
      name: 'bc-k-one',
      tags: [...ours, 'team:web', 'better-compute-cluster:kc_two', 'tier:gold'],
    });
    expect(s.doks.clusters.get(id)!.tags).toEqual([
      'k8s',
      `k8s:${id}`,
      ...ours,
      'team:web',
      'better-compute-cluster:kc_two',
      'tier:gold',
    ]);
    // As wanted now: nothing more is sent. A label taken out stays (it may not be ours alone).
    const puts = posted(s, `/kubernetes/clusters/${id}`, 'PUT').length;
    expect((await s.k8s.ensureCluster(relabelled, s.ctx())).state).toBe('ready');
    expect(
      (
        await s.k8s.ensureCluster(
          { ...standard, labels: { 'better-compute-cluster': 'kc_two' } },
          s.ctx(),
        )
      ).state,
    ).toBe('ready');
    expect(posted(s, `/kubernetes/clusters/${id}`, 'PUT')).toHaveLength(puts);
  });

  it('refuses a region change with INVALID_STATE', async () => {
    const s = await setup();
    await readyCluster(s);
    const error = await failure(s.k8s.ensureCluster({ ...standard, location: 'tor1' }, s.ctx()));
    expect(error.code).toBe('INVALID_STATE');
    expect(error.details).toMatchObject({ reason: 'immutable', field: 'location' });
  });

  it('never touches a cluster of that name it does not own', async () => {
    const s = await setup();
    const foreign = s.doks.seedCluster({ name: 'bc-k-one', region: 'nyc3', tags: ['team:web'] });
    const other = s.doks.seedCluster({
      name: 'bc-k-two',
      region: 'nyc3',
      tags: [tagFor('better-compute-kubernetes', 'true'), deploymentTag('another')],
    });
    for (const spec of [standard, { ...standard, name: 'bc-k-two' }]) {
      const error = await failure(s.k8s.ensureCluster(spec, s.ctx()));
      expect(error.code).toBe('CONFLICT');
      expect(error.details).toMatchObject({ reason: 'notOwned' });
    }
    expect(mutations(s)).toEqual([]);
    // Reading one is harmless (an adopted cluster is read the same way).
    expect(await s.k8s.getCluster(foreign.id, s.ctx())).toMatchObject({ state: 'ready' });
    expect(await s.k8s.getCluster(other.id, s.ctx())).toMatchObject({ state: 'ready' });
  });

  it('finds its cluster again after a restart, and a racing create is not an error', async () => {
    const s = await setup();
    const id = await readyCluster(s);
    const again = await setup(undefined, {}, s.doks);
    expect(await again.k8s.ensureCluster(standard, again.ctx())).toMatchObject({
      id,
      state: 'ready',
    });
    // Another creator got there between the lookup and the create.
    const fresh = await setup(undefined, {}, s.doks);
    s.doks.do.beforeAction('POST /kubernetes/clusters', () => {
      s.doks.seedCluster({ name: 'bc-k-race', region: 'nyc3', tags: ours });
    });
    const raced = await fresh.k8s.ensureCluster({ ...standard, name: 'bc-k-race' }, fresh.ctx());
    expect(raced).toMatchObject({ id: s.doks.byName('bc-k-race')[0]!.id, state: 'ready' });
    expect(s.doks.byName('bc-k-race')).toHaveLength(1);
  });

  it('keeps the oldest of duplicate clusters and deletes the others, one by one', async () => {
    const s = await setup();
    s.doks.uniqueNames = false;
    const older = s.doks.seedCluster({
      name: 'bc-k-one',
      region: 'nyc3',
      tags: ours,
      created_at: '2026-10-01T00:00:00Z',
    });
    // A racing create's duplicate: its nodes are still coming up.
    s.doks.transitionReads = 100;
    const newer = s.doks.seedCluster({
      name: 'bc-k-one',
      region: 'nyc3',
      tags: ours,
      created_at: '2026-10-02T00:00:00Z',
    });
    s.doks.transitionReads = 1;
    for (const pool of newer.node_pools as Json[])
      for (const node of pool.nodes as Json[]) node.status = { state: 'provisioning' };
    const state = await s.k8s.ensureCluster(standard, s.ctx());
    expect(state.id).toBe(older.id);
    // The survivor is then brought to the spec (a PUT); only the duplicate is deleted.
    expect(mutations(s).filter((m) => m.startsWith('DELETE'))).toEqual([
      `DELETE /kubernetes/clusters/${newer.id}`,
    ]);
    expect(s.logs.some((entry) => entry.message === 'doks.cluster.reap')).toBe(true);
  });

  it('never reaps a duplicate whose nodes run, nor a cluster of that name in another region', async () => {
    const s = await setup();
    s.doks.uniqueNames = false;
    // Ours in tor1 only: the spec's nyc3 finds it immutable, and nothing is deleted.
    const tor = s.doks.seedCluster({
      name: 'bc-k-one',
      region: 'tor1',
      tags: ours,
      created_at: '2026-10-01T00:00:00Z',
    });
    const moved = await failure(s.k8s.ensureCluster(standard, s.ctx()));
    expect([moved.code, moved.details?.reason, moved.details?.field]).toEqual([
      'INVALID_STATE',
      'immutable',
      'location',
    ]);
    // With one in nyc3 too (newer than the tor1 one), each region keeps its own: no reaping.
    const nyc = s.doks.seedCluster({
      name: 'bc-k-one',
      region: 'nyc3',
      tags: ours,
      created_at: '2026-10-02T00:00:00Z',
    });
    expect((await s.k8s.ensureCluster(standard, s.ctx())).id).toBe(nyc.id);
    expect((await s.k8s.ensureCluster({ ...standard, location: 'tor1' }, s.ctx())).id).toBe(tor.id);
    expect(mutations(s).filter((m) => m.startsWith('DELETE'))).toEqual([]);
    // A same-region duplicate whose nodes run has workloads: CONFLICT and a log, never a delete.
    s.doks.seedCluster({
      name: 'bc-k-one',
      region: 'nyc3',
      tags: ours,
      created_at: '2026-10-03T00:00:00Z',
    });
    const fresh = await setup(undefined, {}, s.doks);
    const busy = await failure(fresh.k8s.ensureCluster(standard, fresh.ctx()));
    expect([busy.code, busy.details?.reason]).toEqual(['CONFLICT', 'duplicate']);
    expect(mutations(s).filter((m) => m.startsWith('DELETE'))).toEqual([]);
    expect(fresh.logs.some((entry) => entry.message === 'doks.cluster.reapRefused')).toBe(true);
  });

  it('maps the cluster states', async () => {
    const s = await setup();
    const id = await readyCluster(s);
    s.doks.setStatus(id, 'degraded', 'coredns is unhealthy');
    expect(await s.k8s.getCluster(id, s.ctx())).toMatchObject({
      state: 'ready',
      message: 'coredns is unhealthy',
    });
    s.doks.setStatus(id, 'error', 'control plane failed');
    expect(await s.k8s.ensureCluster(standard, s.ctx())).toMatchObject({
      state: 'error',
      message: 'control plane failed',
    });
    expect(await s.k8s.getCluster('0d0c5000-0000-4000-8000-999999999999', s.ctx())).toBeUndefined();
  });
});

describe('doks node pools', () => {
  const gpuPool: KubernetesNodePoolSpec = {
    name: 'gpu',
    machineType: 'gpu-h100x1-80gb',
    nodeCount: 1,
    accelerators: { type: 'nvidia-h100', count: 1 },
    taints: [{ key: 'nvidia.com/gpu', effect: 'NoSchedule' }],
  };
  const torCluster: KubernetesClusterSpec = { ...standard, name: 'bc-k-tor', location: 'tor1' };
  const poolPath = (s: Setup, cluster: string, name: string): string =>
    `/kubernetes/clusters/${cluster}/node_pools/${
      s.doks.clusters.get(cluster)!.node_pools.find((p: Json) => p.name === name).id
    }`;

  it('creates, resizes, autoscales and deletes a node pool', async () => {
    const s = await setup();
    const cluster = await readyCluster(s);
    const extra: KubernetesNodePoolSpec = {
      name: 'extra',
      machineType: 's-1vcpu-1gb',
      nodeCount: 1,
    };
    const created = await s.k8s.ensureNodePool(cluster, extra, s.ctx());
    expect(created).toMatchObject({ id: `${cluster}/extra`, state: 'pending' });
    expect(posted(s, `/kubernetes/clusters/${cluster}/node_pools`)).toEqual([
      { name: 'extra', size: 's-1vcpu-1gb', count: 1, tags: ours, auto_scale: false },
    ]);
    const { last } = await settle(() => s.k8s.ensureNodePool(cluster, extra, s.ctx()), 'ready');
    expect(last.outputs).toEqual({ nodes: '1' });

    // A resize, in place.
    const path = poolPath(s, cluster, 'extra');
    const bigger = { ...extra, nodeCount: 3 };
    expect((await s.k8s.ensureNodePool(cluster, bigger, s.ctx())).state).toBe('updating');
    expect(posted(s, path, 'PUT')).toEqual([
      { name: 'extra', count: 3, tags: ours, labels: {}, taints: [], auto_scale: false },
    ]);
    const resized = await settle(() => s.k8s.ensureNodePool(cluster, bigger, s.ctx()), 'ready');
    expect(resized.last.outputs).toEqual({ nodes: '3' });

    // Autoscaling: the bounds change in place, the autoscaler owns the count.
    const scaled = { ...bigger, autoscaling: { minNodes: 1, maxNodes: 4 } };
    expect((await s.k8s.ensureNodePool(cluster, scaled, s.ctx())).state).toBe('updating');
    expect(posted(s, path, 'PUT').at(-1)).toMatchObject({
      count: 3,
      auto_scale: true,
      min_nodes: 1,
      max_nodes: 4,
    });
    await settle(() => s.k8s.ensureNodePool(cluster, scaled, s.ctx()), 'ready');
    const puts = posted(s, path, 'PUT').length;
    // The DO autoscaler scales the pool down: its nodes go away, nothing is sent back.
    s.doks.transitionReads = 2;
    s.doks.autoscale(cluster, 'extra', 1);
    const { states } = await settle(() => s.k8s.ensureNodePool(cluster, scaled, s.ctx()), 'ready');
    expect(states[0]).toBe('updating');
    expect(posted(s, path, 'PUT')).toHaveLength(puts);
    s.doks.transitionReads = 1;

    // Back to a fixed size.
    await s.k8s.ensureNodePool(cluster, { ...extra, nodeCount: 2 }, s.ctx());
    expect(posted(s, path, 'PUT').at(-1)).toMatchObject({ count: 2, auto_scale: false });

    // Deleted: deleting until it is gone.
    const gone = await settle(() => s.k8s.deleteNodePool(cluster, 'extra', s.ctx()), 'deleted');
    expect(gone.states).toEqual(['deleting', 'deleted']);
    expect(mutations(s).filter((m) => m.startsWith('DELETE'))).toEqual([`DELETE ${path}`]);
  });

  it('creates GPU pools whose size carries the accelerators, and refuses a mismatch', async () => {
    const s = await setup();
    const cluster = await readyCluster(s, torCluster);
    const { last } = await settle(() => s.k8s.ensureNodePool(cluster, gpuPool, s.ctx()), 'ready');
    expect(last.id).toBe(`${cluster}/gpu`);
    expect(posted(s, `/kubernetes/clusters/${cluster}/node_pools`).at(-1)).toMatchObject({
      size: 'gpu-h100x1-80gb',
      taints: [{ key: 'nvidia.com/gpu', effect: 'NoSchedule' }],
    });
    // The inventory's model name works too, and a GPU size needs no accelerators.
    await s.k8s.ensureNodePool(
      cluster,
      {
        ...gpuPool,
        name: 'gpu8',
        machineType: 'gpu-h100x8-640gb',
        accelerators: { type: 'H100', count: 8 },
      },
      s.ctx(),
    );
    await s.k8s.ensureNodePool(
      cluster,
      { name: 'l40s', machineType: 'gpu-l40sx1-48gb', nodeCount: 1 },
      s.ctx(),
    );
    const mismatches: KubernetesNodePoolSpec[] = [
      { ...gpuPool, name: 'two', accelerators: { type: 'nvidia-h100', count: 2 } },
      { ...gpuPool, name: 'model', accelerators: { type: 'nvidia-l40s', count: 1 } },
      { ...cpuPool, name: 'cpu', accelerators: { type: 'nvidia-h100', count: 1 } },
      { ...gpuPool, name: 'nosize', machineType: 'gpu-nonexistent' },
    ];
    for (const spec of mismatches) {
      const error = await failure(s.k8s.ensureNodePool(cluster, spec, s.ctx()));
      expect([spec.name, error.code, error.details?.reason]).toEqual([
        spec.name,
        'INVALID_INPUT',
        spec.name === 'nosize' ? 'size' : 'accelerators',
      ]);
    }
    expect(posted(s, `/kubernetes/clusters/${cluster}/node_pools`)).toHaveLength(3);
  });

  it("adds a GPU pool only once the cluster's own GPU device plugins are off (DO-D18)", async () => {
    const s = await setup();
    // An adopted cluster from before DOKS 1.37: NVIDIA's and AMD's device plugins are on.
    const adopted = s.doks.seedCluster({ name: 'team-cluster', region: 'tor1' });
    const refused = await failure(s.k8s.ensureNodePool(adopted.id, gpuPool, s.ctx()));
    expect([refused.code, refused.details?.reason]).toEqual(['INVALID_STATE', 'devicePluginOn']);
    expect(refused.details?.field).toBe('nvidia_gpu_device_plugin, amd_gpu_device_plugin');
    expect(refused.message).toContain('nvidia_gpu_device_plugin');
    // Someone else's cluster is never changed; a CPU pool needs no check.
    expect(mutations(s)).toEqual([]);
    await settle(() => s.k8s.ensureNodePool(adopted.id, cpuPool, s.ctx()), 'ready');
    // Once its operator turns them off, the GPU pool is added.
    adopted.nvidia_gpu_device_plugin = { enabled: false };
    adopted.amd_gpu_device_plugin = { enabled: false };
    await settle(() => s.k8s.ensureNodePool(adopted.id, gpuPool, s.ctx()), 'ready');

    // On a cluster of ours whose plugins came back on, they are turned off first.
    const cluster = await readyCluster(s, { ...standard, name: 'bc-k-tor', location: 'tor1' });
    const mine = s.doks.clusters.get(cluster)!;
    mine.nvidia_gpu_device_plugin = { enabled: true };
    const before = mutations(s).length;
    expect((await s.k8s.ensureNodePool(cluster, gpuPool, s.ctx())).state).toBe('pending');
    expect(mutations(s).slice(before)).toEqual([`PUT /kubernetes/clusters/${cluster}`]);
    expect(posted(s, `/kubernetes/clusters/${cluster}`, 'PUT').at(-1)).toMatchObject({
      name: 'bc-k-tor',
      nvidia_gpu_device_plugin: { enabled: false },
      amd_gpu_device_plugin: { enabled: false },
    });
    expect(mine.tags).toEqual(expect.arrayContaining(ours));
    await settle(() => s.k8s.ensureNodePool(cluster, gpuPool, s.ctx()), 'ready');
    expect(posted(s, `/kubernetes/clusters/${cluster}/node_pools`)).toHaveLength(1);
  });

  it('creates Spot GPU pools only when the account allows Spot and previews', async () => {
    const spot = { ...gpuPool, name: 'spot', spot: true };
    const plain = await setup();
    const cluster = await readyCluster(plain, torCluster);
    const refused = await failure(plain.k8s.ensureNodePool(cluster, spot, plain.ctx()));
    expect([refused.code, refused.details?.reason]).toEqual(['UNSUPPORTED', 'spotDisabled']);
    const noPreview = await setup(
      { ...doAccount, regions: ['nyc3', 'tor1'], allowSpot: true },
      {},
      plain.doks,
    );
    expect(
      (await failure(noPreview.k8s.ensureNodePool(cluster, spot, noPreview.ctx()))).details,
    ).toMatchObject({ reason: 'spotDisabled' });
    const s = await setup(
      { ...doAccount, regions: ['nyc3', 'tor1'], allowSpot: true, previews: true },
      {},
      plain.doks,
    );
    const cpuSpot = await failure(
      s.k8s.ensureNodePool(cluster, { ...cpuPool, name: 'cpuspot', spot: true }, s.ctx()),
    );
    expect([cpuSpot.code, cpuSpot.details?.reason]).toEqual(['INVALID_INPUT', 'spot']);
    await settle(() => s.k8s.ensureNodePool(cluster, spot, s.ctx()), 'ready');
    expect(posted(s, `/kubernetes/clusters/${cluster}/node_pools`).at(-1)).toMatchObject({
      name: 'spot',
      spot: true,
    });
    // Spot cannot be switched in place.
    const switched = await failure(
      s.k8s.ensureNodePool(cluster, { ...spot, spot: false }, s.ctx()),
    );
    expect(switched.details).toMatchObject({ reason: 'immutable', field: 'spot' });
  });

  const spotAccount = { ...doAccount, regions: ['nyc3', 'tor1'], allowSpot: true, previews: true };

  it('deletes a Spot pool DigitalOcean made on-demand, and creates no more Spot pools', async () => {
    const s = await setup(spotAccount);
    const cluster = await readyCluster(s, torCluster);
    s.doks.ignoresSpot = true;
    const spot = { ...gpuPool, name: 'spot', spot: true };
    const dropped = await failure(s.k8s.ensureNodePool(cluster, spot, s.ctx()));
    expect([dropped.code, dropped.details?.reason]).toEqual(['UNSUPPORTED', 'spotUnverified']);
    // The on-demand pool it got is deleted by its id at once.
    const made = s.doks.clusters.get(cluster)!.node_pools.find((p: Json) => p.name === 'spot');
    expect(made.spot).toBeUndefined();
    const path = `/kubernetes/clusters/${cluster}/node_pools/${made.id}`;
    expect(mutations(s).filter((m) => m.startsWith('DELETE'))).toEqual([`DELETE ${path}`]);
    // While it goes, the answer stays UNSUPPORTED (never immutable `spot`, never a second pool).
    const again = await failure(s.k8s.ensureNodePool(cluster, spot, s.ctx()));
    expect([again.code, again.details?.reason]).toEqual(['UNSUPPORTED', 'spotUnverified']);
    await settle(() => s.k8s.getCluster(cluster, s.ctx()), 'ready');
    expect(s.doks.clusters.get(cluster)!.node_pools.map((p: Json) => p.name)).toEqual(['general']);
    // Gone: no other Spot pool is created, here or on another cluster.
    const creates = posted(s, `/kubernetes/clusters/${cluster}/node_pools`).length;
    const later = await failure(s.k8s.ensureNodePool(cluster, spot, s.ctx()));
    expect([later.code, later.details?.reason]).toEqual(['UNSUPPORTED', 'spotUnverified']);
    expect(posted(s, `/kubernetes/clusters/${cluster}/node_pools`)).toHaveLength(creates);
    // On-demand pools are unaffected.
    await settle(() => s.k8s.ensureNodePool(cluster, { ...gpuPool, name: 'od' }, s.ctx()), 'ready');
    expect(s.logs.some((entry) => entry.message === 'doks.nodePool.spotUnverified')).toBe(true);
  });

  it('retries the delete of a pool DigitalOcean made on-demand when it failed', async () => {
    const s = await setup(spotAccount);
    const cluster = await readyCluster(s, torCluster);
    s.doks.ignoresSpot = true;
    const spot = { ...gpuPool, name: 'spot', spot: true };
    s.doks.do.failNext(
      { method: 'DELETE', path: new RegExp(`^/kubernetes/clusters/${cluster}/node_pools/`) },
      503,
      { id: 'service_unavailable', message: 'try again' },
    );
    expect((await failure(s.k8s.ensureNodePool(cluster, spot, s.ctx()))).code).toBe('UNAVAILABLE');
    const made = s.doks.clusters.get(cluster)!.node_pools.find((p: Json) => p.name === 'spot');
    expect(made.nodes.every((node: Json) => node.status.state !== 'deleting')).toBe(true);
    const retried = await failure(s.k8s.ensureNodePool(cluster, spot, s.ctx()));
    expect([retried.code, retried.details?.reason]).toEqual(['UNSUPPORTED', 'spotUnverified']);
    expect(made.nodes.every((node: Json) => node.status.state === 'deleting')).toBe(true);
  });

  it('deletes a new cluster whose initial Spot pool DigitalOcean made on-demand', async () => {
    const s = await setup(spotAccount);
    s.doks.ignoresSpot = true;
    const spec: KubernetesClusterSpec = {
      ...torCluster,
      initialNodePools: [cpuPool, { ...gpuPool, name: 'spot', spot: true }],
    };
    const dropped = await failure(s.k8s.ensureCluster(spec, s.ctx()));
    expect([dropped.code, dropped.details?.reason]).toEqual(['UNSUPPORTED', 'spotUnverified']);
    const [made] = s.doks.byName('bc-k-tor');
    expect(made!.status.state).toBe('deleting');
    expect(mutations(s)).toEqual([
      'POST /kubernetes/clusters',
      `DELETE /kubernetes/clusters/${made!.id}`,
    ]);
    // Once it is gone, a create with a Spot pool is refused before anything is sent.
    await settle(
      () => s.k8s.getCluster(made!.id, s.ctx()).then((x) => x ?? { state: 'gone' }),
      'gone',
    );
    const later = await failure(s.k8s.ensureCluster(spec, s.ctx()));
    expect([later.code, later.details?.reason]).toEqual(['UNSUPPORTED', 'spotUnverified']);
    expect(posted(s, '/kubernetes/clusters')).toHaveLength(1);
  });

  it('deletes a pool made on-demand for Spot whose create answer was lost, or that raced', async () => {
    for (const status of [503, 409]) {
      freshBudgets();
      const doks = new DoksEmulator(new DoEmulator({ now: () => t0 }));
      const lossy = losing(doks, 'POST', /^\/kubernetes\/clusters\/[^/]+\/node_pools$/, status);
      const s = await setup(spotAccount, { fetch: lossy }, doks);
      const cluster = await readyCluster(s, torCluster);
      s.doks.ignoresSpot = true;
      const spot = { ...gpuPool, name: 'spot', spot: true };
      const lost = await failure(s.k8s.ensureNodePool(cluster, spot, s.ctx()));
      const made = s.doks.clusters.get(cluster)!.node_pools.find((p: Json) => p.name === 'spot');
      expect(made.spot).toBeUndefined();
      // A lost answer is UNAVAILABLE; a race finds the pool and checks it there and then.
      if (status === 503) {
        expect(lost.code).toBe('UNAVAILABLE');
        expect(mutations(s).filter((m) => m.startsWith('DELETE'))).toEqual([]);
        const retried = await failure(s.k8s.ensureNodePool(cluster, spot, s.ctx()));
        expect([retried.code, retried.details?.reason]).toEqual(['UNSUPPORTED', 'spotUnverified']);
      } else expect([lost.code, lost.details?.reason]).toEqual(['UNSUPPORTED', 'spotUnverified']);
      expect(mutations(s).filter((m) => m.startsWith('DELETE'))).toEqual([
        `DELETE ${poolPath(s, cluster, 'spot')}`,
      ]);
      expect(posted(s, `/kubernetes/clusters/${cluster}/node_pools`)).toHaveLength(1);
    }
  });

  it('never deletes an on-demand pool it made as one when the spec later asks for Spot', async () => {
    const s = await setup(spotAccount);
    const cluster = await readyCluster(s, torCluster);
    await settle(() => s.k8s.ensureNodePool(cluster, gpuPool, s.ctx()), 'ready');
    const error = await failure(s.k8s.ensureNodePool(cluster, { ...gpuPool, spot: true }, s.ctx()));
    expect(error.details).toMatchObject({ reason: 'immutable', field: 'spot' });
    expect(mutations(s).filter((m) => m.startsWith('DELETE'))).toEqual([]);
  });

  it('deletes a new cluster made with an on-demand pool for Spot when its create answer was lost', async () => {
    const doks = new DoksEmulator(new DoEmulator({ now: () => t0 }));
    const s = await setup(
      spotAccount,
      { fetch: losing(doks, 'POST', /^\/kubernetes\/clusters$/) },
      doks,
    );
    s.doks.ignoresSpot = true;
    const spec: KubernetesClusterSpec = {
      ...torCluster,
      initialNodePools: [cpuPool, { ...gpuPool, name: 'spot', spot: true }],
    };
    expect((await failure(s.k8s.ensureCluster(spec, s.ctx()))).code).toBe('UNAVAILABLE');
    const [made] = s.doks.byName('bc-k-tor');
    const retried = await failure(s.k8s.ensureCluster(spec, s.ctx()));
    expect([retried.code, retried.details?.reason]).toEqual(['UNSUPPORTED', 'spotUnverified']);
    expect(mutations(s)).toEqual([
      'POST /kubernetes/clusters',
      `DELETE /kubernetes/clusters/${made!.id}`,
    ]);
  });

  it('keeps the worker Droplets of its pools out of discovery, claims and deletes', async () => {
    const s = await setup();
    const cluster = await readyCluster(s);
    await settle(() => s.k8s.ensureNodePool(cluster, cpuPool, s.ctx()), 'ready');
    const hand = seedDroplet(s.doks.do.state, { tags: [] });
    const workers = s.doks.clusters
      .get(cluster)!
      .node_pools.flatMap((p: Json) => p.nodes.map((n: Json) => n.droplet_id as string));
    expect(workers).toHaveLength(2);
    for (const id of workers)
      expect(s.doks.do.state.droplets.get(Number(id))!.tags).toEqual([
        'k8s',
        `k8s:${cluster}`,
        'k8s-worker',
        ...ours,
      ]);
    const found: string[] = [];
    for await (const machine of s.impl.discover!(s.ctx())) found.push(machine.id);
    expect(found).toEqual([String(hand.id)]);
    const before = mutations(s).length;
    for (const id of workers) {
      const claim = await failure(s.impl.claim!(id, 'inst_1', s.ctx(), { managed: true }));
      expect([claim.code, claim.details?.reason]).toEqual(['INVALID_STATE', 'kubernetesNode']);
      expect((await failure(s.impl.delete!(id, s.ctx()))).code).toBe('INVALID_STATE');
    }
    expect(mutations(s)).toHaveLength(before);
    // Its workers go with the pool.
    await settle(() => s.k8s.deleteNodePool(cluster, 'general', s.ctx()), 'deleted');
    for (const id of workers) expect(s.doks.do.state.droplets.has(Number(id))).toBe(false);
  });

  it("never takes a vps Droplet for a worker: DOKS's tag keys are no label's, and k8s:<value> needs a uuid", async () => {
    const s = await setup();
    const request = {
      offerId: 'nyc3/s-2vcpu-4gb',
      image: 'ubuntu-24-04-x64',
      userData: '#cloud-config\n',
      name: 'inst_1',
      sshKeys: [
        'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICbbzkHhLXTIyRDUgXLAC0pVt8MQajr4BGKVoF5MJ71Z test@bc',
      ],
      labels: { team: 'web' },
    };
    const drops = (): number => posted(s, '/droplets').length;
    // DOKS's own tag keys are refused as labels, in any case, before anything is sent.
    for (const key of ['k8s', 'K8S', 'k8s-worker']) {
      const error = await failure(s.impl.create({ ...request, labels: { [key]: 'yes' } }, s.ctx()));
      expect([error.code, error.details?.reason]).toEqual(['INVALID_INPUT', 'label']);
    }
    expect(drops()).toBe(0);
    // A Droplet that carries `k8s:yes` anyway (tagged before that refusal, or by hand) is still
    // this instance's: a retried create finds it instead of posting a second one, and it deletes.
    const first = await s.impl.create(request, s.ctx());
    const droplet = s.doks.do.state.droplets.get(Number(first.id))!;
    droplet.tags.push('k8s:yes', 'k8s-worker:x');
    const retried = await s.impl.create(request, s.ctx());
    expect(retried.id).toBe(first.id);
    expect(drops()).toBe(1);
    await s.impl.delete!(first.id, s.ctx());
    expect(posted(s, `/droplets/${first.id}`, 'DELETE')).toHaveLength(1);
  });

  it('refuses differences that cannot change in place with INVALID_STATE', async () => {
    const s = await setup();
    const cluster = await readyCluster(s);
    const changes: [Partial<KubernetesNodePoolSpec>, string][] = [
      [{ machineType: 's-1vcpu-1gb' }, 'machineType'],
      [{ labels: { workload: 'batch' } }, 'labels'],
      [{ taints: [] }, 'taints'],
    ];
    for (const [change, field] of changes) {
      const error = await failure(
        s.k8s.ensureNodePool(cluster, { ...cpuPool, ...change }, s.ctx()),
      );
      expect([error.code, error.details?.field]).toEqual(['INVALID_STATE', field]);
    }
  });

  it('refuses a pool on a cluster that does not exist, and malformed pools', async () => {
    const s = await setup();
    const missing = '0d0c5000-0000-4000-8000-999999999999';
    expect((await failure(s.k8s.ensureNodePool(missing, cpuPool, s.ctx()))).code).toBe('NOT_FOUND');
    expect(await s.k8s.deleteNodePool(missing, 'general', s.ctx())).toMatchObject({
      id: `${missing}/general`,
      state: 'deleted',
    });
    const cluster = await readyCluster(s);
    for (const spec of [
      { ...cpuPool, name: 'Bad' },
      { ...cpuPool, nodeCount: 0 },
      { ...cpuPool, autoscaling: { minNodes: 3, maxNodes: 2 } },
      { ...cpuPool, machineType: 'S 2' },
      { ...cpuPool, taints: [{ key: 'a', effect: 'Never' as 'NoSchedule' }] },
    ])
      expect((await failure(s.k8s.ensureNodePool(cluster, spec, s.ctx()))).code).toBe(
        'INVALID_INPUT',
      );
    expect((await failure(s.k8s.ensureNodePool('nope', cpuPool, s.ctx()))).code).toBe(
      'INVALID_INPUT',
    );
    expect(await s.k8s.deleteNodePool(cluster, 'never-made', s.ctx())).toMatchObject({
      state: 'deleted',
    });
  });

  it('adds pools to a cluster it does not own, but never changes or deletes a pool not its own', async () => {
    const s = await setup();
    const adopted = s.doks.seedCluster({
      name: 'team-cluster',
      region: 'nyc3',
      nodePool: { name: 'team', size: 's-2vcpu-4gb', count: 1 },
    });
    const team = { name: 'team', machineType: 's-2vcpu-4gb', nodeCount: 5 };
    const conflict = await failure(s.k8s.ensureNodePool(adopted.id, team, s.ctx()));
    expect([conflict.code, conflict.details?.reason]).toEqual(['CONFLICT', 'notOwned']);
    const refused = await failure(s.k8s.deleteNodePool(adopted.id, 'team', s.ctx()));
    expect([refused.code, refused.details?.reason]).toEqual(['INVALID_STATE', 'notOwned']);
    // A pool with this deployment's tag but the managed tag instead of the kubernetes one.
    const half = s.doks.seedCluster({
      name: 'half-cluster',
      region: 'nyc3',
      nodePool: {
        name: 'half',
        size: 's-2vcpu-4gb',
        count: 1,
        tags: [deploymentTag('default'), 'better-compute-managed:true'],
      },
    });
    const halfPool = { name: 'half', machineType: 's-2vcpu-4gb', nodeCount: 3 };
    const unchanged = await failure(s.k8s.ensureNodePool(half.id, halfPool, s.ctx()));
    expect([unchanged.code, unchanged.details?.reason]).toEqual(['CONFLICT', 'notOwned']);
    const kept = await failure(s.k8s.deleteNodePool(half.id, 'half', s.ctx()));
    expect([kept.code, kept.details?.reason]).toEqual(['INVALID_STATE', 'notOwned']);
    expect(mutations(s)).toEqual([]);
    const mine = { name: 'bc-extra', machineType: 's-2vcpu-4gb', nodeCount: 1 };
    await settle(() => s.k8s.ensureNodePool(adopted.id, mine, s.ctx()), 'ready');
    await settle(() => s.k8s.deleteNodePool(adopted.id, 'bc-extra', s.ctx()), 'deleted');
    expect(s.doks.clusters.get(adopted.id)!.node_pools.map((p: Json) => p.name)).toEqual(['team']);
  });
});

describe('doks credentials', () => {
  async function withCluster(): Promise<Setup & { cluster: string }> {
    const s = await setup();
    const cluster = await readyCluster(s);
    return { ...s, cluster };
  }

  it('creates the namespace, service account and binding, and mints a bound token', async () => {
    const s = await withCluster();
    const credentials = await s.k8s.credentials(
      s.cluster,
      { subject: 'bc-u-alice', role: 'edit', ttlSeconds: 3600 },
      s.ctx(),
    );
    const server = `https://${s.cluster}.k8s.ondigitalocean.com`;
    expect(credentials).toEqual({
      server,
      certificateAuthorityData: doksCaData,
      token: 'doks-sa-token-1',
      expiresAt: t0 + 3600 * 1000,
    });
    // One service account per subject and role: bc-u-alice-e is alice's edit account.
    expect(s.doks.kube.routes()).toEqual([
      // The access guard and better-compute:edit come first, before any subject exists.
      'POST /apis/rbac.authorization.k8s.io/v1/clusterroles',
      'POST /apis/rbac.authorization.k8s.io/v1/clusterroles',
      'POST /apis/admissionregistration.k8s.io/v1/validatingadmissionpolicies',
      'POST /apis/admissionregistration.k8s.io/v1/validatingadmissionpolicybindings',
      'POST /api/v1/namespaces',
      'POST /api/v1/namespaces/bc-access/serviceaccounts',
      'GET /apis/rbac.authorization.k8s.io/v1/clusterrolebindings/bc-access:bc-u-alice-e',
      'POST /apis/rbac.authorization.k8s.io/v1/clusterrolebindings',
      'POST /api/v1/namespaces/bc-access/serviceaccounts/bc-u-alice-e/token',
    ]);
    expect(s.doks.kube.calls[5]!.body).toMatchObject({
      metadata: {
        name: 'bc-u-alice-e',
        labels: {
          'app.kubernetes.io/managed-by': 'better-compute',
          'better-compute.io/role': 'edit',
        },
        annotations: { 'better-compute.io/subject': 'bc-u-alice' },
      },
    });
    // Each call trusts the cluster's CA only and carries DO's short-lived admin token for it.
    expect(s.doks.credentialExpiries).toEqual([300]);
    for (const call of s.doks.kube.calls) {
      expect(call.caPem).toBe(doksCaPem);
      expect(s.doks.adminTokens.get(call.token)?.cluster).toBe(s.cluster);
      expect(call.url.startsWith(`${server}/`)).toBe(true);
    }
    expect(s.doks.kube.bindings.get('bc-access:bc-u-alice-e')).toMatchObject({
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'better-compute:edit' },
      subjects: [{ kind: 'ServiceAccount', name: 'bc-u-alice-e', namespace: 'bc-access' }],
      metadata: { labels: { 'app.kubernetes.io/managed-by': 'better-compute' } },
    });
    expect(s.doks.kube.calls.at(-1)!.body).toEqual({
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
    expect(again.token).toBe('doks-sa-token-2');
    expect(s.doks.kube.routes().filter((r) => r.startsWith('DELETE'))).toHaveLength(0);
    expect(s.doks.kube.routes().filter((r) => r.endsWith('/clusterrolebindings'))).toHaveLength(1);
  });

  it("binds each role to its own service account, so a token never gets another mint's role", async () => {
    const s = await withCluster();
    const request = { subject: 'bc-u-bob', role: 'view' as const, ttlSeconds: 3600 };
    await s.k8s.credentials(s.cluster, request, s.ctx());
    // An admin mint for the same subject, even one that runs alongside, never re-scopes the view
    // account: it gets an account (and binding) of its own.
    await Promise.all([
      s.k8s.credentials(s.cluster, { ...request, role: 'admin' }, s.ctx()),
      s.k8s.credentials(s.cluster, request, s.ctx()),
    ]);
    const role = (name: string) => s.doks.kube.bindings.get(`bc-access:${name}`)!.roleRef.name;
    expect(role('bc-u-bob-v')).toBe('view');
    expect(role('bc-u-bob-a')).toBe('cluster-admin');
    expect(s.doks.kube.routes().filter((r) => r.startsWith('DELETE'))).toEqual([]);
    const minted = s.doks.kube.calls
      .filter((call) => call.url.endsWith('/token'))
      .map((call) => new URL(call.url).pathname.split('/')[6]);
    expect(minted.sort()).toEqual(['bc-u-bob-a', 'bc-u-bob-v', 'bc-u-bob-v']);
  });

  it('replaces a binding of its account that grants another role (roleRef is immutable)', async () => {
    const s = await withCluster();
    const request = { subject: 'bc-u-bob', role: 'view' as const, ttlSeconds: 3600 };
    await s.k8s.credentials(s.cluster, request, s.ctx());
    // Someone re-pointed the view account's binding at cluster-admin.
    s.doks.kube.bindings.get('bc-access:bc-u-bob-v')!.roleRef.name = 'cluster-admin';
    s.doks.kube.calls = [];
    await s.k8s.credentials(s.cluster, request, s.ctx());
    expect(s.doks.kube.routes()).toEqual([
      'POST /api/v1/namespaces',
      'POST /api/v1/namespaces/bc-access/serviceaccounts',
      'GET /apis/rbac.authorization.k8s.io/v1/clusterrolebindings/bc-access:bc-u-bob-v',
      'DELETE /apis/rbac.authorization.k8s.io/v1/clusterrolebindings/bc-access:bc-u-bob-v',
      'POST /apis/rbac.authorization.k8s.io/v1/clusterrolebindings',
      'POST /api/v1/namespaces/bc-access/serviceaccounts/bc-u-bob-v/token',
    ]);
    expect(s.doks.kube.bindings.get('bc-access:bc-u-bob-v')!.roleRef.name).toBe('view');
  });

  it('an edit subject cannot reach an admin subject (impersonation, tokens, pods, exec)', async () => {
    const s = await withCluster();
    const server = `https://${s.cluster}.k8s.ondigitalocean.com`;
    const mint = (subject: string, role: 'view' | 'edit' | 'admin') =>
      s.k8s.credentials(s.cluster, { subject, role, ttlSeconds: 600 }, s.ctx());
    const admin = await mint('bc-u-root', 'admin');
    const edit = await mint('bc-u-alice', 'edit');
    const view = await mint('bc-u-vic', 'view');
    const can = (token: string, verb: string, resource: string, namespace?: string, group = '') =>
      s.doks.kube.can(server, token, { verb, resource, group, ...(namespace ? { namespace } : {}) });
    expect(can(edit.token, 'create', 'deployments', 'default', 'apps')).toBe(true);
    for (const namespace of ['bc-access', 'kube-system']) {
      expect(can(edit.token, 'create', 'pods', namespace)).toBe(false);
      expect(can(edit.token, 'create', 'pods/exec', namespace)).toBe(false);
      expect(can(edit.token, 'create', 'serviceaccounts/token', namespace)).toBe(false);
      expect(can(edit.token, 'impersonate', 'serviceaccounts', namespace)).toBe(false);
      expect(can(admin.token, 'create', 'pods', namespace)).toBe(true);
    }
    expect(can(view.token, 'get', 'pods', 'default')).toBe(true);
    expect(can(view.token, 'create', 'pods', 'default')).toBe(false);
    // Written once per cluster by this process.
    const guardWrites = () =>
      s.doks.kube.routes().filter((route) => route.includes('admissionregistration')).length;
    expect(guardWrites()).toBe(2);
    await mint('bc-u-bob', 'edit');
    expect(guardWrites()).toBe(2);
    // Before Kubernetes 1.30: no credentials.
    const t = await withCluster();
    t.doks.kube.noAdmissionApi = true;
    const error = await failure(
      t.k8s.credentials(t.cluster, { subject: 'bc-u-alice', role: 'view', ttlSeconds: 600 }, t.ctx()),
    );
    expect(error.code).toBe('INVALID_STATE');
    expect(error.message).toMatch(/1\.30/);
  });

  it('revokeCredentials removes every role of the subject, and bc-access once empty', async () => {
    const s = await withCluster();
    const server = `https://${s.cluster}.k8s.ondigitalocean.com`;
    const root = await s.k8s.credentials(
      s.cluster,
      { subject: 'bc-u-root', role: 'admin', ttlSeconds: 600 },
      s.ctx(),
    );
    await s.k8s.credentials(s.cluster, { subject: 'bc-u-root', role: 'view', ttlSeconds: 600 }, s.ctx());
    await s.k8s.credentials(s.cluster, { subject: 'bc-u-bob', role: 'view', ttlSeconds: 600 }, s.ctx());
    const store = s.doks.kube.clusters.find(server)!;
    await s.k8s.revokeCredentials!(s.cluster, 'bc-u-root', s.ctx());
    expect(store.subjectObjects()).toEqual([
      'ClusterRoleBinding/bc-access:bc-u-bob-v',
      'Namespace/bc-access',
      'ServiceAccount/bc-access/bc-u-bob-v',
    ]);
    expect(s.doks.kube.can(server, root.token, { verb: 'get', resource: 'pods', namespace: 'default' })).toBe(
      false,
    );
    await s.k8s.revokeCredentials!(s.cluster, 'bc-u-bob', s.ctx());
    expect(store.subjectObjects()).toEqual([]);
    await s.k8s.revokeCredentials!(s.cluster, 'bc-u-bob', s.ctx());
    await s.k8s.revokeCredentials!('0d0c5000-0000-4000-8000-999999999999', 'bc-u-bob', s.ctx());
    s.doks.kube.failWith = 503;
    expect((await failure(s.k8s.revokeCredentials!(s.cluster, 'bc-u-bob', s.ctx()))).code).toBe(
      'UNAVAILABLE',
    );
  });

  it('names the account of a long subject by a hash, distinct per role and from short ones', async () => {
    const s = await withCluster();
    const long = `bc-u-${'a'.repeat(58)}`;
    const short = `bc-u-${'a'.repeat(55)}`;
    for (const subject of [long, `${long.slice(0, 62)}b`, short])
      for (const role of ['view', 'admin'] as const)
        await s.k8s.credentials(s.cluster, { subject, role, ttlSeconds: 600 }, s.ctx());
    const names = [...s.doks.kube.serviceAccounts].map((key) => key.split('/')[1]!);
    expect(new Set(names).size).toBe(6);
    for (const name of names) expect(name).toMatch(/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/);
    expect(names).toContain(`${short}-v`);
    // Hashed names are always 63 characters, plain ones at most 62: the two never meet.
    expect(names.filter((name) => name.length === 63)).toHaveLength(4);
  });

  it('validates the subject, role and ttl before calling anything', async () => {
    const s = await withCluster();
    const before = s.doks.do.requests.length;
    for (const request of [
      { subject: 'Bob', role: 'view', ttlSeconds: 3600 },
      { subject: 'bc-u-', role: 'view', ttlSeconds: 3600 },
      { subject: `bc-${'a'.repeat(61)}`, role: 'view', ttlSeconds: 3600 },
      { subject: 'bc-u-bob', role: 'owner', ttlSeconds: 3600 },
      { subject: 'bc-u-bob', role: 'view', ttlSeconds: 599 },
      { subject: 'bc-u-bob', role: 'view', ttlSeconds: 86_401 },
      { subject: 'bc-u-bob', role: 'view', ttlSeconds: 1000.5 },
    ]) {
      const error = await failure(s.k8s.credentials(s.cluster, request as never, s.ctx()));
      expect(error.code).toBe('INVALID_INPUT');
    }
    expect(s.doks.kube.calls).toHaveLength(0);
    expect(s.doks.do.requests).toHaveLength(before);
  });

  it('maps Kubernetes API failures, an absent cluster and one not running yet', async () => {
    const s = await withCluster();
    const request = { subject: 'bc-u-carol', role: 'view' as const, ttlSeconds: 3600 };
    s.doks.kube.failWith = 403;
    expect((await failure(s.k8s.credentials(s.cluster, request, s.ctx()))).code).toBe(
      'ACCESS_DENIED',
    );
    s.doks.kube.failWith = 503;
    expect((await failure(s.k8s.credentials(s.cluster, request, s.ctx()))).code).toBe(
      'UNAVAILABLE',
    );
    s.doks.kube.failWith = undefined;
    s.doks.kube.unreachable = true;
    expect((await failure(s.k8s.credentials(s.cluster, request, s.ctx()))).code).toBe(
      'UNAVAILABLE',
    );
    s.doks.kube.unreachable = false;
    const missing = '0d0c5000-0000-4000-8000-999999999999';
    expect((await failure(s.k8s.credentials(missing, request, s.ctx()))).code).toBe('NOT_FOUND');
    s.doks.transitionReads = 3;
    const pending = await s.k8s.ensureCluster({ ...standard, name: 'bc-k-new' }, s.ctx());
    const early = await failure(s.k8s.credentials(pending.id, request, s.ctx()));
    expect([early.code, early.details?.reason]).toEqual(['INVALID_STATE', 'notReady']);
  });

  it('refuses DO credentials that name another endpoint or carry no token', async () => {
    const s = await withCluster();
    const request = { subject: 'bc-u-dan', role: 'view' as const, ttlSeconds: 3600 };
    const path = new RegExp(`^/kubernetes/clusters/${s.cluster}/credentials$`);
    s.doks.do.failNext({ method: 'GET', path }, 200, {
      server: 'https://attacker.example.com',
      certificate_authority_data: doksCaData,
      token: 'doks-admin-elsewhere',
    });
    const elsewhere = await failure(s.k8s.credentials(s.cluster, request, s.ctx()));
    expect([elsewhere.code, elsewhere.details?.reason]).toEqual(['PROVIDER_ERROR', 'endpoint']);
    s.doks.do.failNext({ method: 'GET', path }, 200, {
      server: `https://${s.cluster}.k8s.ondigitalocean.com`,
      certificate_authority_data: doksCaData,
      client_certificate_data: 'Y2VydA==',
      client_key_data: 'a2V5',
      token: null,
    });
    const tokenless = await failure(s.k8s.credentials(s.cluster, request, s.ctx()));
    expect([tokenless.code, tokenless.details?.reason]).toEqual(['PROVIDER_ERROR', 'noToken']);
    expect(s.doks.kube.calls).toHaveLength(0);
  });

  it('mints on a cluster it does not own (an adopted one)', async () => {
    const s = await setup();
    const adopted = s.doks.seedCluster({ name: 'team-cluster', region: 'nyc3' });
    const minted = await s.k8s.credentials(
      adopted.id,
      { subject: 'bc-u-erin', role: 'view', ttlSeconds: 600 },
      s.ctx(),
    );
    expect(minted.server).toBe(adopted.endpoint);
  });

  it('never logs or reports a token', async () => {
    const s = await withCluster();
    const minted = await s.k8s.credentials(
      s.cluster,
      { subject: 'bc-u-dave', role: 'admin', ttlSeconds: 3600 },
      s.ctx(),
    );
    s.doks.kube.failWith = 401;
    const failed = await failure(
      s.k8s.credentials(
        s.cluster,
        { subject: 'bc-u-dave', role: 'admin', ttlSeconds: 3600 },
        s.ctx(),
      ),
    );
    expect(failed.code).toBe('ACCESS_DENIED');
    const secretsSeen = [minted.token, 'do-token', ...s.doks.adminTokens.keys()];
    expect(secretsSeen.length).toBeGreaterThan(2);
    const state = JSON.stringify(await s.k8s.getCluster(s.cluster, s.ctx()));
    const logged = JSON.stringify(s.logs);
    expect(s.logs.some((entry) => entry.message === 'doks.credentials')).toBe(true);
    for (const token of secretsSeen) {
      expect(logged).not.toContain(token);
      expect(state).not.toContain(token);
      expect(failed.message).not.toContain(token);
      expect(JSON.stringify(failed.details ?? {})).not.toContain(token);
    }
  });
});

describe('doks upgrades and deletes', () => {
  it('upgrades the control plane in place, and a minor is satisfied by a patch', async () => {
    const s = await setup();
    const pinned = { ...standard, version: '1.33' };
    const id = await readyCluster(s, pinned);
    expect(s.doks.clusters.get(id)!.version).toBe('1.33.5-do.1');
    const raised = { ...standard, version: '1.34' };
    expect((await s.k8s.ensureCluster(raised, s.ctx())).state).toBe('updating');
    expect(posted(s, `/kubernetes/clusters/${id}/upgrade`)).toEqual([{ version: '1.34.1-do.0' }]);
    const { last } = await settle(() => s.k8s.ensureCluster(raised, s.ctx()), 'ready');
    expect(last.outputs).toMatchObject({ version: '1.34.1-do.0', nodeVersion: '1.34.1-do.0' });
    const before = mutations(s).length;
    expect((await s.k8s.ensureCluster(raised, s.ctx())).state).toBe('ready');
    expect(mutations(s)).toHaveLength(before);
    expect(s.logs.some((entry) => entry.message === 'doks.cluster.upgrade')).toBe(true);
  });

  it('steps through the upgrades DOKS offers, and refuses what it cannot reach', async () => {
    const s = await setup();
    s.doks.versions = [{ slug: '1.35.0-do.0', kubernetes_version: '1.35.0' }, ...s.doks.versions];
    const id = await readyCluster(s, { ...standard, version: '1.33.4' });
    const target = { ...standard, version: '1.36' };
    // The newest offered upgrade that does not pass the wanted version.
    await settle(() => s.k8s.ensureCluster({ ...standard, version: '1.34.1' }, s.ctx()), 'ready');
    expect(posted(s, `/kubernetes/clusters/${id}/upgrade`)).toEqual([{ version: '1.34.1-do.0' }]);
    expect((await s.k8s.ensureCluster(target, s.ctx())).state).toBe('updating');
    await settle(() => s.k8s.getCluster(id, s.ctx()), 'ready');
    expect(s.doks.clusters.get(id)!.version).toBe('1.35.0-do.0');
    const stuck = await failure(s.k8s.ensureCluster(target, s.ctx()));
    expect([stuck.code, stuck.details?.reason]).toEqual(['INVALID_STATE', 'versionUnavailable']);
  });

  it('refuses a downgrade', async () => {
    const s = await setup();
    await readyCluster(s);
    const error = await failure(s.k8s.ensureCluster({ ...standard, version: '1.33' }, s.ctx()));
    expect([error.code, error.details?.reason]).toEqual(['INVALID_STATE', 'downgrade']);
  });

  it('takes a patch DOKS auto-upgraded past a pinned slug as satisfied, and still applies changes', async () => {
    const s = await setup();
    const pinned = { ...standard, version: '1.33.4-do.0' };
    const id = await readyCluster(s, pinned);
    expect(s.doks.clusters.get(id)!.version).toBe('1.33.4-do.0');
    // The regular channel auto-upgrades: DOKS moved the patch on its own.
    s.doks.clusters.get(id)!.version = '1.33.5-do.1';
    expect((await s.k8s.ensureCluster(pinned, s.ctx())).state).toBe('ready');
    const firewalled = { ...pinned, authorizedNetworks: ['198.51.100.0/24'] };
    expect((await s.k8s.ensureCluster(firewalled, s.ctx())).state).toBe('updating');
    expect(posted(s, `/kubernetes/clusters/${id}`, 'PUT').at(-1)).toMatchObject({
      control_plane_firewall: { enabled: true, allowed_addresses: ['198.51.100.0/24'] },
    });
    expect(s.doks.clusters.get(id)!.control_plane_firewall.allowed_addresses).toEqual([
      '198.51.100.0/24',
    ]);
    // A full version without the slug is satisfied the same way; never an upgrade or downgrade.
    expect((await s.k8s.ensureCluster({ ...firewalled, version: '1.33.4' }, s.ctx())).state).toBe(
      'ready',
    );
    expect(posted(s, `/kubernetes/clusters/${id}/upgrade`)).toEqual([]);
    // An older minor is still a downgrade.
    const older = await failure(
      s.k8s.ensureCluster({ ...firewalled, version: '1.32.9-do.2' }, s.ctx()),
    );
    expect([older.code, older.details?.reason]).toEqual(['INVALID_STATE', 'downgrade']);
  });

  it('deletes its cluster by id, keeping what the cluster made for its workloads', async () => {
    const s = await setup();
    const id = await readyCluster(s);
    s.doks.associated.set(id, {
      load_balancers: [{ id: 'lb-1', name: 'web' }],
      volumes: [
        { id: 'vol-1', name: 'pvc-1' },
        { id: 'vol-2', name: 'pvc-2' },
      ],
      volume_snapshots: [],
    });
    const first = await s.k8s.deleteCluster(id, s.ctx());
    expect(first.state).toBe('deleting');
    expect(first.message).toContain('1 load balancer');
    expect(first.message).toContain('2 volumes');
    const { states } = await settle(() => s.k8s.deleteCluster(id, s.ctx()), 'deleted');
    expect(states).toEqual(['deleted']);
    // One plain delete: never /dangerous, never a bulk call.
    expect(mutations(s).filter((m) => m.startsWith('DELETE'))).toEqual([
      `DELETE /kubernetes/clusters/${id}`,
    ]);
    expect(await s.k8s.getCluster(id, s.ctx())).toBeUndefined();
    // The same spec again makes a new cluster.
    const again = await s.k8s.ensureCluster(standard, s.ctx());
    expect(again.state).toBe('pending');
    expect(again.id).not.toBe(id);
  });

  it('deletes even when the associated-resources listing fails', async () => {
    const s = await setup();
    const id = await readyCluster(s);
    const listing = (cluster: string) =>
      new RegExp(`^/kubernetes/clusters/${cluster}/destroy_with_associated_resources$`);
    s.doks.do.failNext({ method: 'GET', path: listing(id) }, 503, {
      id: 'service_unavailable',
      message: 'try again',
    });
    expect(await s.k8s.deleteCluster(id, s.ctx())).toEqual({ id, state: 'deleting' });
    expect(mutations(s).filter((m) => m.startsWith('DELETE'))).toEqual([
      `DELETE /kubernetes/clusters/${id}`,
    ]);
    expect(
      s.logs.find((entry) => entry.message === 'doks.cluster.associatedUnread')?.fields,
    ).toMatchObject({ cluster: id, error: 'UNAVAILABLE' });

    // The cluster went between the read and the listing: deleted, not an error.
    const other = await readyCluster(s, { ...standard, name: 'bc-k-two' });
    const missing = {
      id: 'not_found',
      message: 'The resource you were accessing could not be found.',
    };
    s.doks.do.failNext({ method: 'GET', path: listing(other) }, 404, missing);
    s.doks.do.failNext(
      { method: 'DELETE', path: new RegExp(`^/kubernetes/clusters/${other}$`) },
      404,
      missing,
    );
    expect(await s.k8s.deleteCluster(other, s.ctx())).toEqual({ id: other, state: 'deleted' });
  });

  it('answers deleting while DOKS deletes, and deleted for a cluster that is gone', async () => {
    const s = await setup();
    const id = await readyCluster(s);
    s.doks.transitionReads = 3;
    expect((await s.k8s.deleteCluster(id, s.ctx())).state).toBe('deleting');
    expect((await s.k8s.deleteCluster(id, s.ctx())).state).toBe('deleting');
    expect((await s.k8s.ensureCluster(standard, s.ctx())).state).toBe('deleting');
    expect(mutations(s).filter((m) => m.startsWith('DELETE'))).toHaveLength(1);
    const missing = '0d0c5000-0000-4000-8000-999999999999';
    expect(await s.k8s.deleteCluster(missing, s.ctx())).toEqual({ id: missing, state: 'deleted' });
  });

  it("never deletes a cluster that is not this deployment's", async () => {
    const s = await setup();
    const adopted = s.doks.seedCluster({ name: 'team-cluster', region: 'nyc3' });
    const other = s.doks.seedCluster({
      name: 'bc-k-other',
      region: 'nyc3',
      tags: [tagFor('better-compute-kubernetes', 'true'), deploymentTag('another')],
    });
    // This deployment's tag without the kubernetes tag (the managed one instead) is not ours.
    const managedOnly = s.doks.seedCluster({
      name: 'bc-k-managed',
      region: 'nyc3',
      tags: [deploymentTag('test'), 'better-compute-managed:true'],
    });
    const half = await setup(undefined, { deployment: 'test' }, s.doks);
    for (const [k8s, cluster] of [
      [s, adopted],
      [s, other],
      [half, managedOnly],
    ] as const) {
      const error = await failure(k8s.k8s.deleteCluster(cluster.id, k8s.ctx()));
      expect([error.code, error.details?.reason]).toEqual(['INVALID_STATE', 'notOwned']);
    }
    expect(mutations(s)).toEqual([]);
    expect(s.doks.clusters.size).toBe(3);
  });
});

describe('doks https transport', () => {
  const token = 'doks-admin-transport-secret';

  async function server(
    dnsName: string,
    answer: (request: IncomingMessage, response: ServerResponse) => void,
  ) {
    const ca = createServingCa();
    const key = generateP256KeyPair();
    const issued = await ca.issue(key.publicKey, {
      usage: 'server',
      dnsSans: [dnsName],
      ttlSeconds: 3600,
    });
    const seen: { authorization?: string; method?: string; url?: string; body: string }[] = [];
    const https = createHttpsServer(
      { key: privateKeyPem(key.privateKey), cert: toPem(issued.certificate) },
      (request, response) => {
        let body = '';
        request.on('data', (chunk) => (body += String(chunk)));
        request.on('end', () => {
          seen.push({
            authorization: request.headers.authorization,
            method: request.method,
            url: request.url,
            body,
          });
          answer(request, response);
        });
      },
    );
    https.listen(0, 'localhost');
    await once(https, 'listening');
    const { port } = https.address() as AddressInfo;
    return { caPem: toPem(ca.certificate), port, seen, close: () => https.close() };
  }

  const json = (status: number, payload: unknown) => (_: unknown, response: ServerResponse) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(payload));
  };

  async function rejection(promise: Promise<unknown>): Promise<Error> {
    try {
      await promise;
    } catch (error) {
      return error as Error;
    }
    throw new Error('expected the request to be rejected');
  }

  it("reaches the cluster's API trusting its CA, and resolves any HTTP status", async () => {
    const api = await server('localhost', json(201, { kind: 'Namespace' }));
    try {
      const answer = await httpsKubeTransport({
        url: `https://localhost:${api.port}/api/v1/namespaces`,
        method: 'POST',
        body: { kind: 'Namespace' },
        caPem: api.caPem,
        token,
        signal: new AbortController().signal,
      });
      expect(answer).toEqual({ status: 201, body: { kind: 'Namespace' } });
      expect(api.seen).toEqual([
        {
          authorization: `Bearer ${token}`,
          method: 'POST',
          url: '/api/v1/namespaces',
          body: '{"kind":"Namespace"}',
        },
      ]);
    } finally {
      api.close();
    }
  });

  it('refuses another CA, a name the certificate does not carry, no CA, plain http and a huge answer', async () => {
    const api = await server('localhost', json(200, { ok: true }));
    const elsewhere = await server('kube.example.test', json(200, { ok: true }));
    const huge = await server('localhost', (_, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(`"${'x'.repeat((1 << 20) + 1024)}"`);
    });
    const other = toPem(createServingCa().certificate);
    const call = (url: string, caPem: string) =>
      httpsKubeTransport({
        url,
        method: 'GET',
        caPem,
        token,
        signal: new AbortController().signal,
      });
    try {
      const errors = [
        // Signed by a CA the request does not trust (the public roots are never added).
        await rejection(call(`https://localhost:${api.port}/api`, other)),
        // The right CA, but the certificate names another host.
        await rejection(call(`https://localhost:${elsewhere.port}/api`, elsewhere.caPem)),
        // No CA at all would mean Node's public roots: refused before connecting.
        await rejection(call(`https://localhost:${api.port}/api`, '')),
        await rejection(call(`http://localhost:${api.port}/api`, api.caPem)),
        await rejection(call(`https://localhost:${huge.port}/api`, huge.caPem)),
      ];
      expect(errors.map((error) => error.message)).toEqual([
        expect.stringMatching(/self.signed|unable to (verify|get)|certificate/i),
        expect.stringMatching(/altnames|does not match|hostname/i),
        'The Kubernetes API is reached only with its own CA certificate',
        'The Kubernetes API is only reached over https',
        'The Kubernetes API answer is too large',
      ]);
      // No request refused by TLS or before connecting reached a handler.
      expect(api.seen).toHaveLength(0);
      expect(elsewhere.seen).toHaveLength(0);
      for (const error of errors) {
        expect(error.message).not.toContain(token);
        expect(String(error.stack)).not.toContain(token);
      }
    } finally {
      api.close();
      elsewhere.close();
      huge.close();
    }
  });
});
