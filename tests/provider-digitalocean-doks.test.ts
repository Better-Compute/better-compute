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
  tagFor,
  type DoCompute,
  type DoConfig,
  type DoProviderOptions,
} from '@better-compute/provider-digitalocean';
import { DoEmulator, type Json } from './support/do-emulator/index.js';
import { seedVpc } from './support/do-emulator/vpcs.js';
import { doAccount, freshBudgets, platformAccount, secrets } from './support/do-harness.js';
import { DoksEmulator } from './support/doks-emulator.js';

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
    const newer = s.doks.seedCluster({
      name: 'bc-k-one',
      region: 'nyc3',
      tags: ours,
      created_at: '2026-10-02T00:00:00Z',
    });
    const state = await s.k8s.ensureCluster(standard, s.ctx());
    expect(state.id).toBe(older.id);
    // The survivor is then brought to the spec (a PUT); only the duplicate is deleted.
    expect(mutations(s).filter((m) => m.startsWith('DELETE'))).toEqual([
      `DELETE /kubernetes/clusters/${newer.id}`,
    ]);
    expect(s.logs.some((entry) => entry.message === 'doks.cluster.reap')).toBe(true);
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
