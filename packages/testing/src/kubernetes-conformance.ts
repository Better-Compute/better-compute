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

/** One thing a credential might do on its cluster: `verb` on `resource` of `group` ('' the core group) in `namespace`. */
export interface KubernetesAccessCheck {
  verb: string;
  resource: string;
  group?: string;
  /** Absent for a cluster-scoped resource. */
  namespace?: string;
}

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
  /**
   * Whether a minted credential may do `check` on its cluster now (the emulator's RBAC and admission policies, or a
   * SubjectAccessReview against a live cluster). The role cases are skipped without.
   */
  can?: (credentials: KubernetesCredentials, check: KubernetesAccessCheck) => boolean | Promise<boolean>;
  /**
   * `false` when the location offers a single minor version on purpose: the upgrade case is then skipped. Otherwise a
   * location with fewer than two minors fails that case (it would test nothing).
   */
  upgrade?: boolean;
  /**
   * `true` when the driver must implement `revokeCredentials` (a pool substrate's adopt teardown fails closed on it):
   * a driver without it then fails the revoke case instead of skipping it.
   */
  revoke?: boolean;
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
      name: 'raising the version upgrades the control plane in place (outputs.version runs it)',
      async run(subject) {
        const c = await client(subject);
        const versions = await c.k8s.versions(subject.location, c.call('versions'));
        const minors = [
          ...new Set(versions.validVersions.map((version) => /^(\d+\.\d+)/.exec(version)?.[1]).filter((v) => v !== undefined)),
        ].sort((a, b) => {
          const [x, y] = [a.split('.').map(Number), b.split('.').map(Number)];
          return y[0]! - x[0]! || y[1]! - x[1]!;
        });
        if (minors.length < 2) {
          if (subject.upgrade === false) return;
          throw new ConformanceFailure(
            `${subject.location} offers ${minors.length} minor version(s): an upgrade needs two (set upgrade: false to skip this case)`,
          );
        }
        const [newer, older] = [minors[0]!, minors[1]!];
        const runs = (actual: string | undefined, version: string) =>
          actual !== undefined && (actual === version || actual.startsWith(`${version}.`) || actual.startsWith(`${version}-`));
        const { spec } = names(subject, 'upgrade');
        let id: string | undefined;
        try {
          const created = await readyCluster(subject, c, spec({ version: older }));
          id = created.id;
          check(runs(created.outputs?.version, older), `created on ${older}, runs ${created.outputs?.version}`);
          const upgraded = await settle(
            subject,
            'ensureCluster upgrade',
            async () => {
              const state = await c.k8s.ensureCluster(spec({ version: newer }), c.call('upgrade'));
              return state.state === 'ready' && !runs(state.outputs?.version, newer) ? { ...state, state: 'updating' } : state;
            },
            ['ready'],
          );
          checkEqual(upgraded!.id, id, 'an upgrade keeps the cluster');
          check(runs(upgraded!.outputs?.version, newer), `upgraded to ${newer}, runs ${upgraded!.outputs?.version}`);
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
          // More GPUs per node than the pool has: never a ready answer for the pool that is there.
          const more = gpu.accelerators && { ...gpu.accelerators, count: gpu.accelerators.count * 2 };
          if (more) {
            const accelerators = await rejection(() =>
              c.k8s.ensureNodePool(cluster, { ...gpu, accelerators: more }, c.call('gpu-accelerators')),
            );
            check(
              isComputeError(accelerators, 'INVALID_STATE'),
              `an accelerator change of a node pool is INVALID_STATE, not ${String(accelerators)}`,
            );
          }
          if (subject.spot !== false) {
            const flipped = await rejection(() => c.k8s.ensureNodePool(cluster, { ...gpu, spot: true }, c.call('gpu-spot-flip')));
            check(isComputeError(flipped, 'INVALID_STATE'), `a Spot flip of a node pool is INVALID_STATE, not ${String(flipped)}`);
          }
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
          // A bad request is refused before anything is minted, and the refusal carries no token.
          for (const [request, what] of [
            [{ subject: 'Bad_Subject', role: 'view', ttlSeconds: 600 }, 'a subject that is no DNS-1123 label'],
            [{ subject: 'bc-substrate', role: 'view', ttlSeconds: 60 }, 'ttlSeconds below 600'],
            [{ subject: 'bc-substrate', role: 'view', ttlSeconds: 100_000 }, 'ttlSeconds above 86400'],
          ] as const) {
            const refused = await rejection(() => c.k8s.credentials(id!, request, c.call('bad-request')));
            check(isComputeError(refused, 'INVALID_INPUT'), `${what} is INVALID_INPUT, not ${String(refused)}`);
            const said = `${String(refused)} ${JSON.stringify((refused as { details?: unknown }).details ?? {})}`;
            check(!said.includes(minted.token) && !said.includes(view.token), `refusing ${what} names no token`);
          }
          if (subject.missingCluster !== undefined) {
            const missing = await rejection(() =>
              c.k8s.credentials(subject.missingCluster!, { subject: 'bc-substrate', role: 'view', ttlSeconds: 600 }, c.call('creds-missing')),
            );
            check(isComputeError(missing, 'NOT_FOUND'), `credentials on an unknown cluster are NOT_FOUND, not ${String(missing)}`);
          }
        } finally {
          await cleanUp(subject, c, id);
        }
      },
    },
    {
      name: 'a credential carries its role: view only reads, edit never reaches bc-access or kube-system',
      async run(subject) {
        if (!subject.can) return;
        const c = await client(subject);
        const { spec } = names(subject, 'roles');
        let id: string | undefined;
        try {
          id = (await readyCluster(subject, c, spec())).id;
          const mint = (name: string, role: 'view' | 'edit' | 'admin') =>
            c.k8s.credentials(id!, { subject: name, role, ttlSeconds: 600 }, c.call(`roles-${name}`));
          const admin = await mint('bc-conf-admin', 'admin');
          const view = await mint('bc-conf-viewer', 'view');
          const edit = await mint('bc-conf-editor', 'edit');
          const can = (credentials: KubernetesCredentials, verb: string, resource: string, namespace?: string, group = '') =>
            subject.can!(credentials, { verb, resource, group, ...(namespace !== undefined ? { namespace } : {}) });
          check(await can(admin, 'create', 'pods', 'default'), 'an admin credential creates pods');
          check(await can(view, 'get', 'pods', 'default'), 'a view credential reads pods');
          check(!(await can(view, 'create', 'pods', 'default')), 'a view credential cannot create pods');
          check(!(await can(view, 'get', 'secrets', 'default')), 'a view credential cannot read secrets');
          check(await can(edit, 'create', 'deployments', 'default', 'apps'), 'an edit credential creates deployments');
          // Every subject's service account lives in bc-access: an edit subject that could run a pod, mint a token or
          // impersonate there would act as an admin subject's account.
          for (const namespace of ['bc-access', 'kube-system']) {
            check(!(await can(edit, 'create', 'pods', namespace)), `an edit credential cannot create pods in ${namespace}`);
            check(!(await can(edit, 'create', 'pods/exec', namespace)), `an edit credential cannot exec in ${namespace}`);
            check(
              !(await can(edit, 'create', 'serviceaccounts/token', namespace)),
              `an edit credential cannot mint service account tokens in ${namespace}`,
            );
            check(
              !(await can(edit, 'impersonate', 'serviceaccounts', namespace)),
              `an edit credential cannot impersonate service accounts in ${namespace}`,
            );
            check(await can(admin, 'create', 'pods', namespace), `an admin credential creates pods in ${namespace}`);
          }
        } finally {
          await cleanUp(subject, c, id);
        }
      },
    },
    {
      name: 'revokeCredentials removes the access of a subject only, and is idempotent',
      async run(subject) {
        const c = await client(subject);
        if (!c.k8s.revokeCredentials) {
          if (subject.revoke) throw new ConformanceFailure('the driver implements revokeCredentials');
          return;
        }
        if (!subject.can) return;
        const { spec } = names(subject, 'forget');
        let id: string | undefined;
        try {
          id = (await readyCluster(subject, c, spec())).id;
          const minted = await c.k8s.credentials(id, { subject: 'bc-conf-forget', role: 'admin', ttlSeconds: 600 }, c.call('forget'));
          // Another subject on the same cluster: revoking one must leave it (and bc-access, where it lives) alone.
          const kept = await c.k8s.credentials(id, { subject: 'bc-conf-keep', role: 'view', ttlSeconds: 600 }, c.call('keep'));
          const reads = (credentials: KubernetesCredentials) =>
            subject.can!(credentials, { verb: 'get', resource: 'pods', namespace: 'default' });
          check(await reads(minted), 'the credential works before revokeCredentials');
          await c.k8s.revokeCredentials(id, 'bc-conf-forget', c.call('forget-1'));
          check(!(await reads(minted)), 'the credential stops working once its subject is revoked');
          check(await reads(kept), "another subject's credential still works once one subject is revoked");
          await c.k8s.revokeCredentials(id, 'bc-conf-forget', c.call('forget-2'));
          if (subject.missingCluster !== undefined)
            await c.k8s.revokeCredentials(subject.missingCluster, 'bc-conf-forget', c.call('forget-missing'));
        } finally {
          await cleanUp(subject, c, id);
        }
      },
    },
    {
      name: 'node pool calls on an unknown cluster are NOT_FOUND',
      async run(subject) {
        if (subject.missingCluster === undefined) return;
        const c = await client(subject);
        const pool: KubernetesNodePoolSpec = { name: 'bc-conf-missing', ...subject.nodePool };
        const error = await rejection(() => c.k8s.ensureNodePool(subject.missingCluster!, pool, c.call('missing-pool')));
        check(isComputeError(error, 'NOT_FOUND'), `ensureNodePool on an unknown cluster is NOT_FOUND, not ${String(error)}`);
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
