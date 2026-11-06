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
  type DoCompute,
  type DoConfig,
  type DoProviderOptions,
} from '@better-compute/provider-digitalocean';
import { DoEmulator, type Json } from './support/do-emulator/index.js';
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

// Kept for later tasks.
void standard;
void readyCluster;
void deploymentTag;
void ({} as Json);
