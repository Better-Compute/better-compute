import {
  ComputeError,
  isComputeError,
  systemClock,
  type CallContext,
  type KubernetesClusterSpec,
  type KubernetesCredentials,
  type KubernetesNodePoolSpec,
  type Logger,
  type ProviderContext,
  type ProviderDefinition,
  type ProviderKubernetes,
  type ProviderResourceState,
} from '@better-compute/core';
import { check, checkEqual, ConformanceFailure, type ConformanceCase } from '@better-compute/core/conformance';

// kubernetesProviderConformanceCases: what the kubernetes module's cluster and pool substrate reconcilers need of
// any `ProviderImpl.kubernetes` (GKE, EKS, DOKS, a fake), as behavioural cases shaped like vps'
// providerConformanceCases. Run them from any test runner against an emulator, a record/replay transport or a live
// account. Nothing here is provider-specific: a provider's vocabulary (location, machine types, accelerators) comes
// from the subject.

/** A node pool shape the provider accepts, without its name. */
export type KubernetesConformanceShape = Omit<KubernetesNodePoolSpec, 'name'>;

/** What the cases run against: a provider, an account config, and what the provider calls things. */
export interface KubernetesProviderConformanceSubject {
  provider: ProviderDefinition;
  /** Account config, validated by the provider's manifest. */
  config: unknown;
  /** Context overrides (secrets for the account's SecretRefs, a clock, a logger, the account). */
  context?: Partial<ProviderContext>;
  /** A cluster location the account serves (a region). */
  location: string;
  /** A CPU node pool (the cluster's first one). */
  nodePool: KubernetesConformanceShape;
  /** A GPU node pool, as a pool substrate's GPU flavor asks for one. */
  gpuNodePool: KubernetesConformanceShape;
  /** Moves the provider's own operations along between two polls (an emulator's settle or clock); default none. */
  advance?: () => void | Promise<void>;
  /**
   * `false` when a fixed-size node pool needs at least one node (DOKS): `nodeCount: 0` must then be refused as
   * INVALID_INPUT, never half-applied.
   */
  zeroNodes?: boolean;
  /** `false` when the provider has no Spot (preemptible) node pools: that step is skipped. */
  spot?: boolean;
  /** Polls of a transition before it counts as stuck (default 30). */
  polls?: number;
  /** Cluster names start with this (default `bc-k-conf`); concurrent runs need distinct ones. */
  prefix?: string;
  /** A cluster id of the provider's form that names no cluster (getCluster's undefined). Skipped without. */
  missingCluster?: string;
  /** An existing cluster the subject did not create: `getCluster` must read it, as a substrate's adopt does. */
  adoptable?: string;
  /** Whether the cluster's own API accepts a minted credential (the emulator's check). Skipped without. */
  accepts?: (credentials: KubernetesCredentials) => boolean | Promise<boolean>;
}

/** The pool substrate's node pool label (`@better-compute/kubernetes` substratePoolLabel). */
const substrateLabel = 'better-compute.dev/substrate-pool';
const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const resourceStates: readonly ProviderResourceState['state'][] = [
  'pending',
  'ready',
  'updating',
  'deleting',
  'deleted',
  'error',
];

interface Client {
  k8s: ProviderKubernetes;
  call: (key: string) => CallContext;
  clock: ProviderContext['clock'];
}

async function client(subject: KubernetesProviderConformanceSubject): Promise<Client> {
  const context: ProviderContext = {
    clock: subject.context?.clock ?? systemClock,
    log: subject.context?.log ?? quiet,
    secrets: subject.context?.secrets ?? {
      resolve: async () => {
        throw new ComputeError('INVALID_CONFIG', 'The conformance subject gave no secret resolver');
      },
    },
    ...(subject.context?.account ? { account: subject.context.account } : {}),
  };
  const parsed = await subject.provider.config['~standard'].validate(subject.config);
  if ('issues' in parsed && parsed.issues)
    throw new ComputeError('INVALID_CONFIG', `The subject's config does not validate: ${parsed.issues[0]?.message}`);
  const impl = await subject.provider.create((parsed as { value: unknown }).value, context);
  check(impl.kubernetes !== undefined, 'ProviderImpl.kubernetes exists');
  const call = (key: string): CallContext => ({
    idempotencyKey: key,
    signal: new AbortController().signal,
    clock: context.clock,
    secrets: context.secrets,
    log: context.log,
  });
  return { k8s: impl.kubernetes, call, clock: context.clock };
}

function checkState(state: ProviderResourceState | undefined, what: string): asserts state is ProviderResourceState {
  check(state !== undefined, `${what}: expected a state`);
  check(typeof state.id === 'string' && state.id.length > 0, `${what}: id must be a non-empty string`);
  check(resourceStates.includes(state.state), `${what}: state ${String(state.state)} is not in the contract`);
  for (const [key, value] of Object.entries(state.outputs ?? {}))
    check(typeof value === 'string', `${what}: output ${key} must be a string`);
}

/** Calls `step` until its state is one of `until`, advancing the provider between calls. */
async function settle(
  subject: KubernetesProviderConformanceSubject,
  what: string,
  step: () => Promise<ProviderResourceState | undefined>,
  until: readonly (ProviderResourceState['state'] | 'absent')[],
): Promise<ProviderResourceState | undefined> {
  const seen: string[] = [];
  for (let poll = 0; poll < (subject.polls ?? 30); poll++) {
    const state = await step();
    if (state !== undefined) checkState(state, what);
    const now = state?.state ?? 'absent';
    seen.push(now);
    if (until.includes(now)) return state;
    check(now !== 'error', `${what}: went error (${state?.message ?? 'no message'})`);
    await subject.advance?.();
  }
  throw new ConformanceFailure(`${what}: never ${until.join(' or ')} (${seen.join(', ')})`);
}

function names(subject: KubernetesProviderConformanceSubject, name: string) {
  const cluster = `${subject.prefix ?? 'bc-k-conf'}-${name}`;
  return {
    cluster,
    spec: (extra: Partial<KubernetesClusterSpec> = {}): KubernetesClusterSpec => ({
      name: cluster,
      location: subject.location,
      mode: 'standard',
      releaseChannel: 'regular',
      authorizedNetworks: [],
      privateNodes: false,
      initialNodePools: [{ name: 'system', ...subject.nodePool }],
      labels: { 'better-compute-conformance': name },
      ...extra,
    }),
  };
}

async function readyCluster(subject: KubernetesProviderConformanceSubject, c: Client, spec: KubernetesClusterSpec) {
  const state = await settle(subject, `ensureCluster ${spec.name}`, () => c.k8s.ensureCluster(spec, c.call(spec.name)), [
    'ready',
  ]);
  return state!;
}

async function deleted(subject: KubernetesProviderConformanceSubject, c: Client, id: string): Promise<void> {
  await settle(subject, `deleteCluster ${id}`, () => c.k8s.deleteCluster(id, c.call(`delete-${id}`)), ['deleted']);
}

async function cleanUp(subject: KubernetesProviderConformanceSubject, c: Client, id: string | undefined) {
  if (id === undefined) return;
  try {
    await deleted(subject, c, id);
  } catch (error) {
    if (!isComputeError(error, 'NOT_FOUND')) throw error;
  }
}

async function rejection(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** The ProviderKubernetes contract (core extension.ts) as conformance cases. */
export function kubernetesProviderConformanceCases(): ConformanceCase<KubernetesProviderConformanceSubject>[] {
  return [
    {
      name: 'the definition declares kubernetes and its client implements ProviderKubernetes',
      async run(subject) {
        check(subject.provider.extension === 'provider', 'the definition comes from defineProvider');
        check(
          (subject.provider.capabilities as readonly string[] | undefined)?.includes('kubernetes') === true,
          'capabilities include kubernetes',
        );
        const { k8s } = await client(subject);
        for (const method of [
          'ensureCluster',
          'getCluster',
          'deleteCluster',
          'ensureNodePool',
          'deleteNodePool',
          'credentials',
          'versions',
        ] as const)
          check(typeof k8s[method] === 'function', `ProviderKubernetes.${method} is a function`);
      },
    },
    {
      name: 'versions names a default among the valid versions of the location',
      async run(subject) {
        const c = await client(subject);
        const versions = await c.k8s.versions(subject.location, c.call('versions'));
        check(typeof versions.defaultVersion === 'string' && versions.defaultVersion !== '', 'a default version');
        check(Array.isArray(versions.validVersions) && versions.validVersions.length > 0, 'valid versions');
        for (const [channel, entry] of Object.entries(versions.channels ?? {}))
          check(
            typeof entry?.defaultVersion === 'string' && Array.isArray(entry.validVersions),
            `channel ${channel} has a default and valid versions`,
          );
      },
    },
    {
      name: 'ensureCluster creates once, settles ready with the outputs the module reads, and is idempotent',
      async run(subject) {
        const c = await client(subject);
        const { spec } = names(subject, 'create');
        let id: string | undefined;
        try {
          const first = await c.k8s.ensureCluster(spec(), c.call('create'));
          checkState(first, 'ensureCluster');
          id = first.id;
          check(['pending', 'updating', 'ready'].includes(first.state), `a new cluster is pending, not ${first.state}`);
          const ready = await readyCluster(subject, c, spec());
          checkEqual(ready.id, id, 'a repeated ensureCluster names the same cluster');
          const outputs = ready.outputs ?? {};
          check(/^https:\/\/[^/\s]+$/.test(outputs.endpoint ?? ''), `outputs.endpoint is https://<host> (${outputs.endpoint})`);
          for (const key of ['version', 'location', 'nodeVersion'])
            check(typeof outputs[key] === 'string' && outputs[key] !== '', `outputs.${key} is set once ready`);
          const read = await c.k8s.getCluster(id, c.call('get'));
          checkState(read, 'getCluster');
          checkEqual(read.id, id, 'getCluster names the cluster');
          checkEqual(read.state, 'ready', 'getCluster of a ready cluster');
          const again = await c.k8s.ensureCluster(spec(), c.call('create-again'));
          checkEqual([again.id, again.state], [id, 'ready'], 'ensureCluster of a ready cluster changes nothing');
          if (subject.missingCluster !== undefined)
            check(
              (await c.k8s.getCluster(subject.missingCluster, c.call('get-missing'))) === undefined,
              'getCluster of an unknown cluster is undefined',
            );
        } finally {
          await cleanUp(subject, c, id);
        }
      },
    },
    {
      name: 'a cluster never changes mode in place (INVALID_STATE, or UNSUPPORTED without that mode)',
      async run(subject) {
        const c = await client(subject);
        const { spec } = names(subject, 'mode');
        let id: string | undefined;
        try {
          id = (await readyCluster(subject, c, spec())).id;
          const { initialNodePools: _, ...rest } = spec();
          const error = await rejection(() => c.k8s.ensureCluster({ ...rest, mode: 'autopilot' }, c.call('mode')));
          // A provider without an autopilot mode (DOKS) refuses the mode itself.
          check(
            isComputeError(error, 'INVALID_STATE') || isComputeError(error, 'UNSUPPORTED'),
            `a mode change is INVALID_STATE (or UNSUPPORTED), not ${String(error)}`,
          );
          const after = await c.k8s.getCluster(id, c.call('mode-after'));
          checkEqual(after?.state, 'ready', 'a refused mode change leaves the cluster as it was');
        } finally {
          await cleanUp(subject, c, id);
        }
      },
    },
    {
      name: 'a labelled GPU node pool settles ready, resizes in place, and never changes shape',
      async run(subject) {
        const c = await client(subject);
        const { spec } = names(subject, 'pools');
        let id: string | undefined;
        try {
          id = (await readyCluster(subject, c, spec())).id;
          const cluster = id;
          const gpu: KubernetesNodePoolSpec = {
            name: 'bc-conf-gpu',
            ...subject.gpuNodePool,
            nodeCount: 1,
            labels: { ...(subject.gpuNodePool.labels ?? {}), [substrateLabel]: 'pool_conformance' },
          };
          const created = await settle(subject, 'ensureNodePool', () => c.k8s.ensureNodePool(cluster, gpu, c.call('gpu')), [
            'ready',
          ]);
          const again = await c.k8s.ensureNodePool(cluster, gpu, c.call('gpu-again'));
          checkEqual([again.id, again.state], [created!.id, 'ready'], 'ensureNodePool of a ready pool changes nothing');
          await settle(
            subject,
            'ensureNodePool resize',
            () => c.k8s.ensureNodePool(cluster, { ...gpu, nodeCount: 2 }, c.call('gpu-resize')),
            ['ready'],
          );
          const shape = await rejection(() =>
            c.k8s.ensureNodePool(cluster, { ...gpu, machineType: subject.nodePool.machineType }, c.call('gpu-shape')),
          );
          check(
            isComputeError(shape, 'INVALID_STATE'),
            `a machine type change of a node pool is INVALID_STATE, not ${String(shape)}`,
          );
          // A flavor scaled to nothing keeps its pool (`nodes: 0` is a valid substrate flavor).
          if (subject.zeroNodes !== false)
            await settle(
              subject,
              'ensureNodePool to zero nodes',
              () => c.k8s.ensureNodePool(cluster, { ...gpu, nodeCount: 0 }, c.call('gpu-zero')),
              ['ready'],
            );
          else {
            const zero = await rejection(() => c.k8s.ensureNodePool(cluster, { ...gpu, nodeCount: 0 }, c.call('gpu-zero')));
            check(isComputeError(zero, 'INVALID_INPUT'), `a refused empty pool is INVALID_INPUT, not ${String(zero)}`);
          }
          // A Spot GPU pool, as a substrate's Spot flavor asks for one.
          if (subject.spot !== false) {
            const spot: KubernetesNodePoolSpec = {
              ...gpu,
              name: 'bc-conf-spot',
              spot: true,
              labels: { ...gpu.labels, 'better-compute.dev/capacity': 'spot' },
            };
            await settle(subject, 'ensureNodePool spot', () => c.k8s.ensureNodePool(cluster, spot, c.call('spot')), [
              'ready',
            ]);
            await settle(subject, 'deleteNodePool spot', () => c.k8s.deleteNodePool(cluster, spot.name, c.call('spot-delete')), [
              'deleted',
            ]);
          }
          // The pool goes, and a second delete counts as deleted.
          await settle(subject, 'deleteNodePool', () => c.k8s.deleteNodePool(cluster, gpu.name, c.call('gpu-delete')), [
            'deleted',
          ]);
          const twice = await c.k8s.deleteNodePool(cluster, gpu.name, c.call('gpu-delete-again'));
          checkEqual(twice.state, 'deleted', 'deleting a deleted node pool');
        } finally {
          await cleanUp(subject, c, id);
        }
      },
    },
    {
      name: "credentials mint a bound token for the cluster's endpoint, and outputs never carry one",
      async run(subject) {
        const c = await client(subject);
        const { spec } = names(subject, 'creds');
        let id: string | undefined;
        try {
          const ready = await readyCluster(subject, c, spec());
          id = ready.id;
          const before = c.clock.now();
          const minted = await c.k8s.credentials(
            id,
            { subject: 'bc-substrate', role: 'admin', ttlSeconds: 600 },
            c.call('credentials'),
          );
          checkEqual(minted.server, ready.outputs?.endpoint, "the credential's server is the cluster endpoint");
          check(
            Buffer.from(minted.certificateAuthorityData, 'base64').toString('utf8').includes('BEGIN CERTIFICATE'),
            'certificateAuthorityData is a base64 PEM certificate',
          );
          check(typeof minted.token === 'string' && minted.token.length > 0, 'a token');
          check(
            minted.expiresAt > before && minted.expiresAt <= before + 600_000 + 60_000,
            `expiresAt is within the TTL (${minted.expiresAt - before} ms)`,
          );
          if (subject.accepts) check(await subject.accepts(minted), "the cluster's API accepts the credential");
          const read = JSON.stringify(await c.k8s.getCluster(id, c.call('get')));
          check(!read.includes(minted.token), 'getCluster never carries the token');
          const view = await c.k8s.credentials(id, { subject: 'bc-substrate', role: 'view', ttlSeconds: 600 }, c.call('view'));
          check(view.token !== minted.token, 'every request mints its own token');
        } finally {
          await cleanUp(subject, c, id);
        }
      },
    },
    {
      name: 'deleteCluster removes the cluster; deleting again counts as deleted',
      async run(subject) {
        const c = await client(subject);
        const { spec } = names(subject, 'delete');
        const { id } = await readyCluster(subject, c, spec());
        await deleted(subject, c, id);
        const after = await c.k8s.getCluster(id, c.call('get-after'));
        check(after === undefined || after.state === 'deleted', `getCluster after delete finds nothing live (${after?.state})`);
        const again = await c.k8s.deleteCluster(id, c.call('delete-again'));
        checkEqual(again.state, 'deleted', 'deleting a deleted cluster');
      },
    },
    {
      name: 'getCluster reads a cluster better-compute did not create (adopt), and a node pool can be added to it',
      async run(subject) {
        const id = subject.adoptable;
        if (id === undefined) return;
        const c = await client(subject);
        const read = await c.k8s.getCluster(id, c.call('adopt'));
        checkState(read, 'getCluster of an adoptable cluster');
        checkEqual(read.state, 'ready', 'the adoptable cluster reads ready');
        check(/^https:\/\//.test(read.outputs?.endpoint ?? ''), 'an adoptable cluster has an endpoint');
        const pool: KubernetesNodePoolSpec = {
          name: 'bc-conf-adopt',
          ...subject.gpuNodePool,
          nodeCount: 1,
          labels: { [substrateLabel]: 'pool_conformance' },
        };
        await settle(subject, 'ensureNodePool on an adopted cluster', () => c.k8s.ensureNodePool(id, pool, c.call('adopt-pool')), [
          'ready',
        ]);
        await settle(subject, 'deleteNodePool on an adopted cluster', () => c.k8s.deleteNodePool(id, pool.name, c.call('adopt-pool-delete')), [
          'deleted',
        ]);
        const after = await c.k8s.getCluster(id, c.call('adopt-after'));
        checkEqual(after?.state, 'ready', 'the adopted cluster stays');
      },
    },
  ];
}
