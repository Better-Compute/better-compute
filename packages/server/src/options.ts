import { createHash, createPublicKey } from 'node:crypto';
import {
  ComputeError,
  computeResourceTypes,
  newId,
  type AttestorVerifier,
  type AuditSink,
  type BlobStore,
  type CapacityPort,
  type CertificateAuthority,
  type Clock,
  type ComputeModule,
  type ComputePlugin,
  type DriverDefinition,
  type EventSink,
  type IamPort,
  type InventoryPort,
  type Logger,
  type Notifier,
  type ProviderDefinition,
  type SchedulerOptions,
  type PoolPolicyValidator,
  type SchedulerPlugin,
  type SecretStore,
  type SinkOptions,
  type SqlExecutor,
  type WorkloadIssuerPort,
} from '@better-compute/core';
import type { CapacityModuleOptions } from '@better-compute/capacity';
import { localSealedSecretStore, type CommandSigningAuthority } from '@better-compute/pki';
import type { DownloadsOptions } from './downloads.js';
import { guardIamPort, withRootTenant, type IamGuardMode } from './iam-guard.js';
import { sourceAddressResolver, type SourceAddressResolver } from './proxy.js';
import { pkiAllocationBindingCheck } from './join/allocation-binding.js';
import { joinAttestorsValidator } from './join/pool-policy.js';
import type { JoinCrypto, JoinTrustBundle } from './join/crypto.js';
import { createCommandSigner, type CommandSigner } from './runtime/command-signing.js';
import type { TunnelsOptions } from './tunnels/module.js';
import type { WorkloadIdentityOptions } from './join/workload-broker.js';
import { anchoredClock } from './runtime/clock.js';
import type { ReconcileRun } from './runtime/reconcilers.js';
import { withCommitHooks, type CommitHook } from './runtime/commit-hooks.js';

/** Worker roles `start({ roles })` runs (PLAN.md §8.1); `api` and `gateway` processes run none. */
export const workerRoles = ['controllers', 'scheduler', 'sinks', 'iam'] as const;
export type WorkerRole = (typeof workerRoles)[number];

/**
 * A host-provided IAM job (better-iam's `dispatchAuditHooks`, `auth.dispatchOutbox`,
 * `billing.checkBudgets`, `billing.closePeriod`, `sweepExpired`) that the `iam` worker role runs
 * every `everyMs` under its own `singleton:iam:<name>` lease (PLAN.md §8.1, §12.1), so exactly one
 * process of the IAM host family runs each. `compute.jobs['iam:<name>'].tick()` runs it once.
 */
export interface IamJob {
  name: string;
  everyMs: number;
  run(): Promise<void>;
}

/** Tuning of the worker runtime (PLAN.md §8.4, §8.5); the defaults suit production. */
export interface WorkerOptions {
  /** This process's worker id and lease owner (default `wkr_<ulid>`). */
  id?: string;
  /** Keys a reconciler claims per pass (default 32). */
  batchSize?: number;
  /** Keys one reconciler runs at once in `start()` loops (default 4); `jobs.*.tick()` runs one at a time. */
  concurrency?: number;
  /** How long the `start()` loops wait when there was nothing to do (default 1000 ms). */
  pollMs?: number;
  /** How long a claimed key stays claimed before another worker may take it (default 60 s). */
  claimTtlMs?: number;
  /** Level-trigger resync: owned keys are re-enqueued every `resyncMs` plus up to `resyncMs` of jitter (default 5 min). */
  resyncMs?: number;
  /**
   * Observers of the runtime's work, for metrics and spans (§14: `reconcile_duration_seconds`,
   * `commands_swept_total`). Called after each reconciler run and each CommandSweeper pass; never
   * awaited, and a throw is ignored, so they cannot affect the work.
   */
  observe?: WorkerObserver;
}

/** `WorkerOptions.observe`. */
export interface WorkerObserver {
  onRun?(run: ReconcileRun): void;
  onSweep?(swept: { expired: number; failed: number }): void;
}

/** The worker settings the runtime runs with. */
export interface WorkerSettings {
  id: string;
  batchSize: number;
  concurrency: number;
  pollMs: number;
  claimTtlMs: number;
  resyncMs: number;
  /** `shard:<n>` and `singleton:<job>` leases: 15 s, renewed every 5 s. */
  leaseTtlMs: number;
  renewMs: number;
  /** A worker is live while its heartbeat is younger than this (30 s). */
  liveWorkerMs: number;
  /** SYNC_AGAIN brings a key back after this long (1 s). */
  syncAgainMs: number;
  /** Failure back-off doubles from 1 s up to this (5 min). */
  maxBackoffMs: number;
  /** The CommandSweeper's period (5 s). */
  sweepMs: number;
  observe?: WorkerObserver;
}

/**
 * Options of `betterCompute()` (PLAN.md §8.2). `gateway` and the serving/internal CAs are accepted
 * and typed for hosts; the server itself does not read them.
 */
export interface ComputeOptions<
  M extends readonly ComputeModule[] = [],
  P extends readonly ComputePlugin[] = [],
> {
  /** The compute store: `postgres({ url })` or `pglite()` from `@better-compute/postgres`. */
  database: SqlExecutor;
  /** A deployment secret of at least 32 characters (local CAs and sealed secrets, from v0.1). */
  secret: string;
  /** The API's public origin, e.g. `https://compute.example.com`; cookie requests must come from it. */
  baseURL: string;
  /** Where the handler is mounted (default `/api/compute`). */
  basePath?: string;
  /** All compute sees of better-iam: `bridge.embedded(iam, …)` (v0.1). Fleet paths never call it (P7). */
  iam: IamPort;
  /**
   * The IAM root (platform) tenant. Its callers pass the tenant pre-check for any tenant (IAM then
   * decides `ROOT_OVERRIDE`), and fleet-scoped methods (`compute-fleet/global`) are decided in it.
   * May be left out when `iam.rootTenantId` names it; when both are given they must agree.
   */
  rootTenantId?: string;
  /** The IAM resource type prefix, the same as the IAM bridge's (default `compute-`). */
  typePrefix?: string;
  /** Injected modules (`metal()`, `vps()`, `provisionModule()`), registered after the built-ins. */
  modules?: M;
  /** Third-party modules mounted under `plugins/{id}` with actions `compute:<id>:*`. */
  plugins?: P;
  drivers?: DriverDefinition[];
  providers?: ProviderDefinition[];
  /** Placement plugins, scorer weights and top-N of the built-in capacity module's placer. */
  scheduler?: SchedulerOptions;
  /**
   * The built-in capacity module (placement attempts, rollup and usage periods, and a seeded
   * `random` in the simulator); `scheduler` fills its plugins, weights and top-N.
   */
  capacity?: Omit<CapacityModuleOptions, 'plugins' | 'weights' | 'topN'>;
  attestors?: AttestorVerifier[];
  pki?: {
    nodeCa?: CertificateAuthority;
    servingCa?: CertificateAuthority;
    internalCa?: CertificateAuthority;
    /**
     * JoinService's keys and node CA (`pkiJoinCrypto({ trustDomain, nodeCa, signingKey,
     * encryptionKey })`); without them `gatewayServices.join` and `renew` are `INVALID_CONFIG`.
     * Their public halves (`publicKeys()`) are served in `/.well-known/better-compute` as `join`.
     */
    join?: JoinCrypto;
    /**
     * The control plane as an OIDC issuer for workload identity federation (pki `workloadIssuer`).
     * The host serves its discovery document and JWKS, unauthenticated, at
     * `GET {basePath}/workload/.well-known/openid-configuration` and `GET {basePath}/workload/jwks.json`
     * (cacheable for 5 minutes), names the issuer in `/.well-known/better-compute` as `workload`, and
     * hands it to modules as `context.pki.workload`. Its `issuer` URL must be
     * `<public origin>{basePath}/workload`: Google fetches discovery from `<issuer>/.well-known/…`.
     * The public origin is `baseURL`'s, or `workloadIssuerOrigin` when set; the host refuses any
     * other (`INVALID_CONFIG`, `reason: 'workloadIssuerUrl'`), and an issuer URL equal to
     * `workloadIdentity.issuer`'s, whose discovery would be served at the same path.
     */
    workloadIssuer?: WorkloadIssuerPort & { discovery(): object };
    /**
     * The public origin the workload issuer is reached at when it is not `baseURL`'s (a tunnel, an
     * API host split from the one cookies come from), e.g. `https://compute-public.example.com`:
     * https (http only for localhost and 127.0.0.1), with no path, query or fragment.
     */
    workloadIssuerOrigin?: string;
    /**
     * Signed intent (v0.2, §13): the command-signing root (pki `createCommandSigningAuthority`, or
     * the PKI bundle's `commandSigning`). Every command is then signed by a 24 h worker key it
     * certifies, and JoinResponse/Welcome carry its root so daemons can require signatures for
     * destructive kinds.
     */
    commandSigning?: Pick<CommandSigningAuthority, 'certificate' | 'issueWorkerKey'>;
    /**
     * Roots still trusted during a rotation (the old root while daemons move to the new one), and
     * the trust bundle's lowest version (default 1). The published version follows the content
     * on its own: a changed bundle takes the next one. Set it explicitly to the version
     * `approvers.setSignatures` were signed for.
     */
    commandSigningRoots?: readonly Uint8Array[];
    trustVersion?: number | bigint;
    /**
     * (v1.0, §13) The destructive-batch quorum, published in the trust bundle (needs
     * `commandSigning`; a change needs `setSignatures` for daemons that already hold keys). `keys` are the operators' P-256
     * approver public keys (SPKI DER), held off the control plane. A batch needs `threshold`
     * distinct approvals, or the first `tiers` entry whose `maxScopeSize` covers it. Tiers are
     * ascending by `maxScopeSize` with non-decreasing thresholds, none above `threshold`.
     * `unbatchedDestructivePerHour` is break-glass only (default 0).
     */
    approvers?: {
      keys: readonly Uint8Array[];
      threshold: number;
      tiers?: readonly { maxScopeSize: number; threshold: number }[];
      unbatchedDestructivePerHour?: number;
      /**
       * (review #6 H1) The CURRENT approvers' signatures over this quorum at `epoch`
       * (`better-compute batch sign-approvers --epoch N`, `sig` as base64url or bytes). A daemon
       * holding approver keys takes a quorum change only with k of them, for a higher epoch. Needs
       * `epoch`: the one they were signed for.
       */
      setSignatures?: readonly { kid: string; sig: string | Uint8Array }[];
      /**
       * (review #7 M1) The epoch of this set (default 1): raise it with every change of the set.
       * Signatures sign it rather than the bundle version, so they stay valid while the set is current.
       */
      epoch?: number | bigint;
    };
  };
  secrets?: SecretStore[];
  /**
   * v0.3 tunnels and break-glass SSH (`tunnels.open`, `nodes.issueSshCert`): pki's exec ticket
   * issuer (its JWKS also goes to the gateway's `tunnels.jwks`), the SSH CA and the re-authorizer.
   * Without it neither method is registered.
   */
  tunnels?: TunnelsOptions;
  /**
   * v0.5 workload identity (§12.2): pki's workload issuer (the host serves its discovery document and
   * JWKS) and the audiences instances may ask for. Turns on `GatewayServices.workloadToken`, which
   * mints tokens only for live instances in pools with `policy.workloadIdentity`.
   */
  workloadIdentity?: WorkloadIdentityOptions;
  notifier?: Notifier;
  sinks?: SinkOptions;
  downloads?: { dir?: string; blob?: BlobStore };
  /**
   * Where `commands.run` `logs.collect` bundles go: the daemon gets a presigned PUT for
   * `support-bundles/{nodeId}/{key}.bundle` (the blob store needs `presign`), and the command shows
   * that `bundleKey`. Without it `logs.collect` has no upload destination.
   */
  supportBundles?: { blob: BlobStore; maxBytes?: number };
  /**
   * Reports (`warn`) or refuses (`throw`) an IamPort call made while a compute transaction is open
   * (§8.1: never allowed). Default `BETTER_COMPUTE_IAM_GUARD` (`warn` or `throw`), else `off`;
   * `computeFixture` defaults it to `throw`.
   */
  iamGuard?: IamGuardMode;
  /**
   * The gateway daemons dial. `url` (https) and `serverName` (the TLS name when it differs from the
   * URL's host) are published in `/.well-known/better-compute` as `gateway`, with `servingCaPin`
   * computed from `pki.servingCa`, so `bcd join --server <control plane>` can configure itself (PLAN
   * §6 Install). The pins then rest on the control plane's TLS (trust on first use); user data that
   * carries the pins stays stronger.
   */
  gateway?: {
    url?: string;
    serverName?: string;
    publicUrls?: Record<string, string>;
    maxStreams?: number;
  };
  /**
   * Business time (P9). Default: the process clock anchored to `compute_now()`, re-sampled at every
   * lease renewal (ClockSkew beyond 1 s). Tests pass the sim clock.
   */
  clock?: Clock;
  /** Accept the IAM session cookie on same-origin requests (a console on one origin); default false. */
  acceptIamCookie?: boolean;
  /**
   * Load balancers or reverse proxies in front of the server (addresses or CIDR ranges). When the
   * socket peer is one of them, the caller's address (`request.sourceIp` for IAM) is read from
   * X-Forwarded-For, right to left, skipping these proxies; otherwise the peer is the caller and
   * forwarding headers are ignored. Default: none trusted.
   */
  trustedProxies?: string[];
  /** Where modules and the server log (`ModuleContext.log`); default: warnings and errors as JSON on stderr. */
  log?: Logger;
  /** IAM jobs the `iam` worker role runs under singleton leases (compute is the IAM host family). */
  iamJobs?: IamJob[];
  /** Worker runtime tuning. */
  worker?: WorkerOptions;
  /**
   * Ports the built-in modules back (`ctx.capacity`, `ctx.inventory`). Given here, they replace the
   * defaults: inventory reads the latest snapshot; capacity books through the capacity module's
   * quota and placer (`createCapacityPort`).
   */
  ports?: { capacity?: CapacityPort; inventory?: InventoryPort };
}

/** The validated options the server runs with. */
export interface ResolvedOptions {
  /** The store with after-commit hooks (`afterCommit`); everything the server runs goes through it. */
  database: SqlExecutor;
  iam: IamPort;
  rootTenantId: string;
  typePrefix: string;
  baseURL: URL;
  /** The one origin cookie requests may come from. */
  origin: string;
  basePath: string;
  acceptIamCookie: boolean;
  /** The caller's address from the socket peer and, behind `trustedProxies`, X-Forwarded-For. */
  sourceAddress: SourceAddressResolver;
  clock: Clock;
  log: Logger;
  notifier?: Notifier;
  eventSinks: readonly EventSink[];
  /** Where `GET {basePath}/downloads/bcd/{version}/{os}-{arch}` finds the daemon binaries. */
  downloads?: DownloadsOptions;
  /** Where `logs.collect` uploads support bundles (a blob store that presigns). */
  supportBundles?: { blob: BlobStore; maxBytes?: number };
  /** `sinks.audit` plus the audit sinks modules list: the built-in audit-sinks module delivers to them. */
  auditSinks: readonly AuditSink[];
  iamJobs: readonly IamJob[];
  worker: WorkerSettings;
  ports: { capacity?: CapacityPort; inventory?: InventoryPort };
  /** The built-in capacity module's options: `capacity` plus the `scheduler`'s placement options. */
  capacity: CapacityModuleOptions;
  /** JoinService's keys and node CA, when configured. */
  join?: JoinCrypto;
  /** `pki.workloadIssuer`: served below `{basePath}/workload` and exposed as `context.pki.workload`. */
  workloadIssuer?: WorkloadIssuerPort & { discovery(): object };
  /** The well-known document's `gateway` section: `gateway.url` plus the serving CA to pin. */
  wellKnownGateway?: { url: string; serverName?: string; servingCa?: CertificateAuthority };
  /** Signs every command (`pki.commandSigning`); absent: commands go unsigned (v0.1). */
  commandSigner?: CommandSigner;
  /** The command-signing roots and version daemons get (JoinResponse.trust, Welcome.trust). */
  trustBundle?: JoinTrustBundle;
  /**
   * The secret stores behind `ctx.secrets` and the `secrets` group: `secrets`, or by default
   * `sealed_secrets` in the compute database under the deployment secret (`sealedSecrets`).
   */
  secretStores: readonly SecretStore[];
  /** Whether the default sealed store is in use, so its migration (`pki/0001_sealed_secrets`) runs. */
  sealedSecrets: boolean;
  /** Runs `hook` once the current transaction of `database` commits (best effort). */
  afterCommit(hook: CommitHook): void;
  /** Whether the caller runs inside a transaction of `database`. */
  inTransaction(): boolean;
}

const tenantIdPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const basePathPattern = /^(?:\/[A-Za-z0-9_-]+)+$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const invalid = (message: string) => new ComputeError('INVALID_CONFIG', message);

/** Checks a port object; its methods may live on a prototype (executors are class instances). */
function requireMethods(value: unknown, name: string, methods: readonly string[]): void {
  if (typeof value !== 'object' || value === null) throw invalid(`${name} is required`);
  for (const method of methods)
    if (typeof (value as Record<string, unknown>)[method] !== 'function')
      throw invalid(`${name} must implement ${method}()`);
}

const badWorkloadIssuer = (message: string) =>
  new ComputeError('INVALID_CONFIG', message, undefined, { reason: 'workloadIssuerUrl' });

/** A URL string, parsed; undefined when it is not one. */
function parseUrl(value: unknown): URL | undefined {
  try {
    return typeof value === 'string' ? new URL(value) : undefined;
  } catch {
    return undefined;
  }
}

/** https, or http for localhost and 127.0.0.1 only. */
const secureOrLocal = (url: URL) =>
  url.protocol === 'https:' ||
  (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1'));

/** `pki.workloadIssuerOrigin`: an origin alone (no path, query, fragment or credentials). */
function workloadIssuerOrigin(value: unknown): string {
  const parsed = parseUrl(value);
  if (
    !parsed ||
    !secureOrLocal(parsed) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== '/'
  )
    throw badWorkloadIssuer(
      'pki.workloadIssuerOrigin must be an origin, e.g. https://compute.example.com (http only for localhost)',
    );
  return parsed.origin;
}

/**
 * `pki.workloadIssuer` must be reachable where Google looks for it: `<issuer>/.well-known/openid-configuration`
 * is served below `{basePath}/workload` on the API's public origin, so the issuer is exactly
 * `<origin>{basePath}/workload`. The origin is `baseURL`'s (W1b) unless `pki.workloadIssuerOrigin`
 * names another; the scheme must be https (http only for localhost and 127.0.0.1).
 */
function checkWorkloadIssuer(issuer: unknown, basePath: string, origin: string): void {
  requireMethods(issuer, 'pki.workloadIssuer', ['mint', 'jwks', 'discovery']);
  const parsed = parseUrl((issuer as Partial<WorkloadIssuerPort>).issuer);
  if (!parsed) throw badWorkloadIssuer('pki.workloadIssuer.issuer must be an absolute URL');
  if (!secureOrLocal(parsed))
    throw badWorkloadIssuer(
      'pki.workloadIssuer.issuer must be an https URL (http only for localhost)',
    );
  if (parsed.pathname !== `${basePath}/workload`)
    throw badWorkloadIssuer(`pki.workloadIssuer.issuer must be served at ${basePath}/workload`);
  if (parsed.origin !== origin)
    throw badWorkloadIssuer(
      `pki.workloadIssuer.issuer must be on the API's public origin ${origin} (baseURL, or pki.workloadIssuerOrigin when the issuer is reached elsewhere)`,
    );
}

/** Two issuers publishing discovery at one URL: `pki.workloadIssuer` and v0.5 `workloadIdentity.issuer`. */
function checkDistinctIssuers(workload: unknown, v05: unknown): void {
  const ours = (workload as { issuer?: unknown } | undefined)?.issuer;
  const theirs = (v05 as { issuer?: { issuer?: unknown } } | undefined)?.issuer?.issuer;
  if (typeof ours !== 'string' || typeof theirs !== 'string') return;
  const trim = (url: string) => url.replace(/\/+$/, '');
  if (trim(ours) === trim(theirs))
    throw badWorkloadIssuer(
      'pki.workloadIssuer and workloadIdentity.issuer must be different issuers: both would publish discovery at the same URL',
    );
}

/** Writes warnings and errors as JSON lines on stderr; debug and info are dropped. */
export const defaultLogger: Logger = {
  debug() {},
  info() {},
  warn(message, fields) {
    console.error(JSON.stringify({ level: 'warn', message, ...fields }));
  },
  error(message, fields) {
    console.error(JSON.stringify({ level: 'error', message, ...fields }));
  },
};

/** Validates the options that P0 acts on; throws `INVALID_CONFIG`. */
export function resolveOptions(options: ComputeOptions<any, any>): ResolvedOptions {
  if (!isRecord(options)) throw invalid('betterCompute() takes an options object');
  requireMethods(options.database, 'database', ['query', 'transaction', 'migrate']);
  requireMethods(options.iam, 'iam', ['authenticate', 'require', 'authorize']);
  if (typeof options.secret !== 'string' || options.secret.length < 32)
    throw invalid('secret must be a string of at least 32 characters');
  const iamRoot: unknown = (options.iam as { rootTenantId?: unknown }).rootTenantId;
  const rootTenantId: unknown = options.rootTenantId ?? iamRoot;
  if (typeof rootTenantId !== 'string' || !tenantIdPattern.test(rootTenantId))
    throw invalid('rootTenantId must be the IAM root tenant id (or iam.rootTenantId must name it)');
  if (iamRoot !== undefined && iamRoot !== rootTenantId)
    throw invalid('rootTenantId and iam.rootTenantId name different tenants');

  let baseURL: URL;
  try {
    baseURL = new URL(String(options.baseURL));
  } catch {
    throw invalid('baseURL must be an absolute HTTP(S) URL');
  }
  if (
    !['http:', 'https:'].includes(baseURL.protocol) ||
    baseURL.username ||
    baseURL.password ||
    baseURL.search ||
    baseURL.hash
  )
    throw invalid('baseURL must be an HTTP(S) URL without credentials, query or fragment');

  const basePath = options.basePath ?? '/api/compute';
  if (typeof basePath !== 'string' || !basePathPattern.test(basePath))
    throw invalid('basePath must be an absolute path without a trailing slash, e.g. /api/compute');

  const typePrefix = options.typePrefix ?? 'compute-';
  if (typeof typePrefix !== 'string') throw invalid('typePrefix must be a string');
  computeResourceTypes(typePrefix); // throws INVALID_CONFIG for a malformed prefix

  if (options.acceptIamCookie !== undefined && typeof options.acceptIamCookie !== 'boolean')
    throw invalid('acceptIamCookie must be a boolean');
  if (options.trustedProxies !== undefined && !Array.isArray(options.trustedProxies))
    throw invalid('trustedProxies must be an array of addresses or CIDR ranges');
  const sourceAddress = sourceAddressResolver(options.trustedProxies ?? []);
  if (options.clock !== undefined) requireMethods(options.clock, 'clock', ['now']);
  if (options.log !== undefined)
    requireMethods(options.log, 'log', ['debug', 'info', 'warn', 'error']);
  for (const list of [
    'modules',
    'plugins',
    'drivers',
    'providers',
    'attestors',
    'secrets',
    'iamJobs',
  ] as const)
    if (options[list] !== undefined && !Array.isArray(options[list]))
      throw invalid(`${list} must be an array`);
  if (options.notifier !== undefined)
    requireMethods(options.notifier, 'notifier', ['publish', 'subscribe']);
  // Extensions the modules and plugins list run like the options' own: event sinks and audit
  // sinks are delivered to, scheduler plugins join the placer (the registry refuses duplicates).
  const listed = [...(options.modules ?? []), ...(options.plugins ?? [])].flatMap(
    (module) => ((module as { extensions?: unknown[] }).extensions ?? []) as unknown[],
  );
  const sinksOf = <K extends 'events' | 'usage' | 'audit'>(kind: K) =>
    listed.filter(
      (extension) =>
        isRecord(extension) && extension.extension === 'sink' && extension.kind === kind,
    );
  if ((options.sinks?.usage?.length ?? 0) > 0 || sinksOf('usage').length > 0)
    throw invalid(
      'Usage sinks are not supported yet: usage windows go to IAM billing through the IAM bridge (§12.7)',
    );
  const eventSinks = [...(options.sinks?.events ?? []), ...(sinksOf('events') as EventSink[])];
  const auditSinks = [...(options.sinks?.audit ?? []), ...(sinksOf('audit') as AuditSink[])];
  for (const sink of auditSinks) {
    requireMethods(sink, 'sinks.audit[]', ['write']);
    if (typeof sink.id !== 'string' || !sink.id)
      throw invalid('sinks.audit[].id must be a non-empty string');
  }
  if (new Set(auditSinks.map((sink) => sink.id)).size !== auditSinks.length)
    throw invalid('An audit sink is listed twice');
  const schedulerPlugins = listed.filter(
    (extension) => isRecord(extension) && extension.extension === 'scheduler',
  ) as SchedulerPlugin[];
  const sinkIds = new Set<string>();
  for (const sink of eventSinks) {
    requireMethods(sink, 'sinks.events[]', ['deliver']);
    // Each sink's outbox cursor is stored under its id.
    if (typeof sink.id !== 'string' || !sink.id)
      throw invalid('sinks.events[].id must be a non-empty string');
    if (sinkIds.has(sink.id)) throw invalid(`Event sink ${sink.id} is listed twice`);
    sinkIds.add(sink.id);
  }
  const downloads = resolveDownloads(options.downloads);
  const bundles = options.supportBundles;
  if (bundles !== undefined) {
    if (!isRecord(bundles)) throw invalid('supportBundles must be an object');
    requireMethods(bundles.blob, 'supportBundles.blob', ['get', 'presign']);
    if (
      bundles.maxBytes !== undefined &&
      !(Number.isSafeInteger(bundles.maxBytes) && bundles.maxBytes > 0)
    )
      throw invalid('supportBundles.maxBytes must be a positive integer');
  }
  const ports = resolvePorts(options.ports);
  const capacity = resolveCapacity(options.capacity, options.scheduler, schedulerPlugins);
  // Pool policy checks the modules own (provision's host units): pools.create/update run them.
  const policyValidators = listed.filter(
    (extension) =>
      isRecord(extension) &&
      extension.extension === 'pool-policy' &&
      typeof extension.validate === 'function',
  ) as PoolPolicyValidator[];
  // PoolPolicy.joinAttestors names attestors JoinService runs: join-token and every registered one.
  const attestorIds = new Set([
    'join-token',
    ...[...(options.attestors ?? []), ...listed].flatMap((extension) =>
      isRecord(extension) && extension.extension === 'attestor' && typeof extension.id === 'string'
        ? [extension.id]
        : [],
    ),
  ]);
  capacity.policyValidators = [
    ...(capacity.policyValidators ?? []),
    ...policyValidators,
    joinAttestorsValidator(attestorIds),
  ];
  const join = options.pki?.join;
  if (join !== undefined) {
    requireMethods(join, 'pki.join', [
      'openSealedToken',
      'inspectCsr',
      'inspectCertificate',
      'verifyNodeSignature',
      'sign',
    ]);
    requireMethods(join.nodeCa, 'pki.join.nodeCa', ['certificates', 'sign']);
    if (join.publicKeys !== undefined && typeof join.publicKeys !== 'function')
      throw invalid('pki.join.publicKeys must be a function');
  }
  const workloadIssuer = options.pki?.workloadIssuer;
  if (workloadIssuer !== undefined) {
    const issuerOrigin =
      options.pki?.workloadIssuerOrigin !== undefined
        ? workloadIssuerOrigin(options.pki.workloadIssuerOrigin)
        : baseURL.origin;
    checkWorkloadIssuer(workloadIssuer, basePath, issuerOrigin);
    checkDistinctIssuers(workloadIssuer, options.workloadIdentity);
  }
  const log = options.log ?? defaultLogger;
  const hooks = withCommitHooks(options.database, log);
  const configuredStores = options.secrets ?? [];
  if (!Array.isArray(configuredStores)) throw invalid('secrets must be a list of secret stores');
  for (const store of configuredStores) {
    requireMethods(store, 'secrets[]', ['put', 'resolve', 'delete']);
    if (!Array.isArray(store.schemes) || !store.schemes.length)
      throw invalid(`secret store ${String(store.id)} serves no scheme`);
  }
  const secretStores: readonly SecretStore[] = configuredStores.length
    ? configuredStores
    : [localSealedSecretStore({ sql: hooks.database, keys: options.secret })];
  const clock = options.clock ?? anchoredClock();
  const worker = resolveWorker(options.worker);
  const signing = resolveCommandSigning(options.pki, worker.id, clock);
  // Signed intent on: bindings count only once the node's own signature over them verifies (P14).
  if (capacity.attestedBindings === undefined && signing.commandSigner)
    capacity.attestedBindings = pkiAllocationBindingCheck({ now: () => clock.now() });

  const guardMode = options.iamGuard ?? envIamGuard();
  if (!['off', 'warn', 'throw'].includes(guardMode))
    throw invalid('iamGuard must be off, warn or throw');
  const wellKnownGateway = resolveWellKnownGateway(options.gateway, options.pki?.servingCa);

  return {
    database: hooks.database,
    iam: guardIamPort(
      withRootTenant(options.iam, rootTenantId),
      hooks.inTransaction,
      guardMode,
      log,
    ),
    rootTenantId,
    typePrefix,
    baseURL,
    origin: baseURL.origin,
    basePath,
    acceptIamCookie: options.acceptIamCookie ?? false,
    sourceAddress,
    clock,
    log,
    ...(options.notifier ? { notifier: options.notifier } : {}),
    eventSinks,
    auditSinks,
    ...(downloads ? { downloads } : {}),
    ...(bundles ? { supportBundles: bundles } : {}),
    iamJobs: resolveIamJobs(options.iamJobs ?? []),
    worker,
    ports,
    capacity,
    ...(join ? { join } : {}),
    ...(workloadIssuer ? { workloadIssuer } : {}),
    ...(wellKnownGateway ? { wellKnownGateway } : {}),
    ...signing,
    secretStores,
    sealedSecrets: configuredStores.length === 0,
    afterCommit: hooks.afterCommit,
    inTransaction: hooks.inTransaction,
  };
}

/** `pki.commandSigning` → the worker's command signer and the trust bundle daemons get. */
function resolveCommandSigning(
  pki: ComputeOptions<any, any>['pki'],
  workerId: string,
  clock: Clock,
): { commandSigner?: CommandSigner; trustBundle?: JoinTrustBundle } {
  const authority = pki?.commandSigning;
  if (authority === undefined) {
    if (
      pki?.commandSigningRoots !== undefined ||
      pki?.trustVersion !== undefined ||
      pki?.approvers !== undefined
    )
      throw invalid(
        'pki.commandSigningRoots, pki.trustVersion and pki.approvers need pki.commandSigning',
      );
    return {};
  }
  requireMethods(authority, 'pki.commandSigning', ['issueWorkerKey']);
  if (!(authority.certificate instanceof Uint8Array))
    throw invalid('pki.commandSigning.certificate must be the root certificate (DER)');
  const extra = pki?.commandSigningRoots ?? [];
  if (!Array.isArray(extra) || !extra.every((root) => root instanceof Uint8Array))
    throw invalid('pki.commandSigningRoots must be DER certificates');
  const version = pki?.trustVersion ?? 1;
  if (
    !(typeof version === 'bigint' || (typeof version === 'number' && Number.isInteger(version))) ||
    BigInt(version) < 1n
  )
    throw invalid('pki.trustVersion must be a whole number of at least 1');
  const commandSigner = createCommandSigner({ authority, workerId, clock, additionalRoots: extra });
  return {
    commandSigner,
    trustBundle: {
      version: BigInt(version),
      commandSigningRoots: [...commandSigner.roots],
      ...resolveApprovers(pki?.approvers),
    },
  };
}

/** `pki.approvers` → the trust bundle's quorum fields (kid = base64url SHA-256 of the SPKI). */
function resolveApprovers(
  approvers: NonNullable<ComputeOptions['pki']>['approvers'],
): Partial<JoinTrustBundle> {
  if (approvers === undefined) return {};
  if (!isRecord(approvers)) throw invalid('pki.approvers must be an object');
  const {
    keys,
    threshold,
    tiers = [],
    unbatchedDestructivePerHour = 0,
    setSignatures = [],
    epoch,
  } = approvers;
  if (!Array.isArray(keys) || keys.length === 0 || !keys.every((key) => key instanceof Uint8Array))
    throw invalid('pki.approvers.keys must be approver public keys (SPKI DER)');
  const approverKeys = keys.map((spkiDer) => {
    let kid: string;
    try {
      const key = createPublicKey({ key: Buffer.from(spkiDer), format: 'der', type: 'spki' });
      if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1')
        throw new Error('not P-256');
      kid = createHash('sha256').update(spkiDer).digest('base64url');
    } catch {
      throw invalid('pki.approvers.keys must be P-256 public keys (SPKI DER)');
    }
    return { kid, spkiDer: new Uint8Array(spkiDer) };
  });
  const distinct = new Set(approverKeys.map((key) => key.kid)).size;
  if (distinct !== approverKeys.length) throw invalid('pki.approvers.keys has duplicates');
  const within = (value: unknown, what: string) => {
    if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > distinct)
      throw invalid(`${what} must be a whole number from 1 to the number of approver keys`);
    return value as number;
  };
  within(threshold, 'pki.approvers.threshold');
  if (!Array.isArray(tiers)) throw invalid('pki.approvers.tiers must be an array');
  const quorumTiers = tiers.map((tier, index) => {
    if (
      !isRecord(tier) ||
      !Number.isInteger(tier.maxScopeSize) ||
      (tier.maxScopeSize as number) < 1
    )
      throw invalid(`pki.approvers.tiers[${index}].maxScopeSize must be a whole number ≥ 1`);
    return {
      maxScopeSize: tier.maxScopeSize as number,
      threshold: within(tier.threshold, `pki.approvers.tiers[${index}].threshold`),
    };
  });
  // Review #6 L3: a larger batch never needs fewer approvals than a smaller one, so padding a
  // scope can never move it into a cheaper tier.
  quorumTiers.forEach((tier, index) => {
    const previous = quorumTiers[index - 1];
    if (previous && tier.maxScopeSize <= previous.maxScopeSize)
      throw invalid('pki.approvers.tiers must have ascending maxScopeSize');
    if (previous && tier.threshold < previous.threshold)
      throw invalid('pki.approvers.tiers thresholds must not decrease as maxScopeSize grows');
    if (tier.threshold > threshold)
      throw invalid(
        `pki.approvers.tiers[${index}].threshold must not exceed pki.approvers.threshold (batches above every tier)`,
      );
  });
  if (!Number.isInteger(unbatchedDestructivePerHour) || unbatchedDestructivePerHour < 0)
    throw invalid('pki.approvers.unbatchedDestructivePerHour must be a whole number ≥ 0');
  if (!Array.isArray(setSignatures)) throw invalid('pki.approvers.setSignatures must be an array');
  const approverSetSignatures = setSignatures.map((signature, index) => {
    const sig =
      isRecord(signature) && typeof signature.sig === 'string'
        ? new Uint8Array(Buffer.from(signature.sig, 'base64url'))
        : isRecord(signature) && signature.sig instanceof Uint8Array
          ? new Uint8Array(signature.sig)
          : undefined;
    // P-256 r ‖ s is 64 bytes.
    if (!isRecord(signature) || typeof signature.kid !== 'string' || !signature.kid || sig?.length !== 64)
      throw invalid(`pki.approvers.setSignatures[${index}] must be { kid, sig } (a 64-byte P-256 signature)`);
    return { kid: signature.kid, sig };
  });
  // Review #7 M1: the set's own epoch, which the signatures sign (not the bundle version): they stay valid on every
  // later version, so a daemon that missed one bundle still takes the set.
  if (
    epoch !== undefined &&
    !((typeof epoch === 'bigint' && epoch >= 1n) || (typeof epoch === 'number' && Number.isInteger(epoch) && epoch >= 1))
  )
    throw invalid('pki.approvers.epoch must be a whole number of at least 1');
  if (approverSetSignatures.length && epoch === undefined)
    throw invalid('pki.approvers.setSignatures need pki.approvers.epoch: the epoch they were signed for');
  return {
    approverKeys,
    approverThreshold: threshold,
    quorumTiers,
    unbatchedDestructivePerHour,
    approverSetEpoch: BigInt(epoch ?? 1),
    ...(approverSetSignatures.length ? { approverSetSignatures } : {}),
  };
}

const jobNamePattern = /^[a-z][a-z0-9._-]{0,63}$/;
const workerIdPattern = /^[A-Za-z0-9._:-]{1,128}$/;

function resolveIamJobs(jobs: readonly IamJob[]): IamJob[] {
  const names = new Set<string>();
  return jobs.map((job) => {
    if (!isRecord(job) || typeof job.name !== 'string' || !jobNamePattern.test(job.name))
      throw invalid('iamJobs[].name must match /^[a-z][a-z0-9._-]{0,63}$/');
    if (names.has(job.name)) throw invalid(`IAM job ${job.name} is listed twice`);
    names.add(job.name);
    if (!Number.isSafeInteger(job.everyMs) || job.everyMs < 100)
      throw invalid(`IAM job ${job.name}: everyMs is a whole number of milliseconds, at least 100`);
    if (typeof job.run !== 'function') throw invalid(`IAM job ${job.name} has no run function`);
    return Object.freeze({ name: job.name, everyMs: job.everyMs, run: job.run });
  });
}

function resolveWorker(options: WorkerOptions | undefined): WorkerSettings {
  if (options !== undefined && !isRecord(options)) throw invalid('worker must be an object');
  const whole = (name: keyof WorkerOptions, fallback: number, min: number, max: number) => {
    const value = options?.[name];
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
      throw invalid(`worker.${name} must be a whole number from ${min} to ${max}`);
    return value;
  };
  const id = options?.id ?? newId('wkr');
  if (typeof id !== 'string' || !workerIdPattern.test(id))
    throw invalid('worker.id must be 1-128 characters of [A-Za-z0-9._:-]');
  const observe = options?.observe;
  if (observe !== undefined) {
    if (!isRecord(observe)) throw invalid('worker.observe must be an object');
    for (const hook of ['onRun', 'onSweep'] as const)
      if (observe[hook] !== undefined && typeof observe[hook] !== 'function')
        throw invalid(`worker.observe.${hook} must be a function`);
  }
  return {
    ...(observe ? { observe } : {}),
    id,
    batchSize: whole('batchSize', 32, 1, 1000),
    concurrency: whole('concurrency', 4, 1, 64),
    pollMs: whole('pollMs', 1000, 10, 60_000),
    claimTtlMs: whole('claimTtlMs', 60_000, 1000, 3_600_000),
    resyncMs: whole('resyncMs', 300_000, 1000, 86_400_000),
    leaseTtlMs: 15_000,
    renewMs: 5_000,
    liveWorkerMs: 30_000,
    syncAgainMs: 1_000,
    maxBackoffMs: 300_000,
    sweepMs: 5_000,
  };
}

/** The capacity module's options: `capacity`, then the scheduler's plugins, weights and top-N. */
function resolveCapacity(
  capacity: ComputeOptions['capacity'],
  scheduler: SchedulerOptions | undefined,
  listed: readonly SchedulerPlugin[] = [],
): CapacityModuleOptions {
  if (capacity !== undefined && !isRecord(capacity as unknown))
    throw invalid('capacity must be an object');
  if (scheduler !== undefined && !isRecord(scheduler as unknown))
    throw invalid('scheduler must be an object');
  if (capacity?.random !== undefined && typeof capacity.random !== 'function')
    throw invalid('capacity.random must be a function returning [0, 1)');
  if (scheduler?.plugins !== undefined && !Array.isArray(scheduler.plugins))
    throw invalid('scheduler.plugins must be an array');
  const resolved: CapacityModuleOptions = { ...capacity };
  const plugins = [...(scheduler?.plugins ?? []), ...listed];
  if (plugins.length) resolved.plugins = plugins;
  if (scheduler?.weights) resolved.weights = scheduler.weights;
  if (scheduler?.topN !== undefined) resolved.topN = scheduler.topN;
  return resolved;
}

/** `gateway.url` (+ `serverName`) and `pki.servingCa` → the well-known `gateway` section. */
function resolveWellKnownGateway(
  gateway: ComputeOptions['gateway'],
  servingCa: CertificateAuthority | undefined,
): ResolvedOptions['wellKnownGateway'] {
  if (gateway === undefined) return undefined;
  if (!isRecord(gateway)) throw invalid('gateway must be an object');
  if (gateway.url === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(gateway.url);
  } catch {
    throw invalid('gateway.url must be an absolute https URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw invalid('gateway.url must be an https URL without credentials, query or fragment');
  if (
    gateway.serverName !== undefined &&
    (typeof gateway.serverName !== 'string' ||
      !/^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(gateway.serverName))
  )
    throw invalid('gateway.serverName must be a DNS name');
  return {
    url: url.href.replace(/\/$/, ''),
    ...(gateway.serverName ? { serverName: gateway.serverName } : {}),
    ...(servingCa ? { servingCa } : {}),
  };
}

/** `BETTER_COMPUTE_IAM_GUARD=warn|throw` turns the guard on for a whole run (tests, `dev`). */
function envIamGuard(): IamGuardMode {
  const value = typeof process === 'object' ? process.env?.BETTER_COMPUTE_IAM_GUARD : undefined;
  return value === 'warn' || value === 'throw' ? value : 'off';
}

function resolveDownloads(downloads: ComputeOptions['downloads']): DownloadsOptions | undefined {
  if (downloads === undefined) return undefined;
  if (!isRecord(downloads)) throw invalid('downloads must be an object');
  if (downloads.dir !== undefined && (typeof downloads.dir !== 'string' || !downloads.dir))
    throw invalid('downloads.dir must be a directory path');
  if (downloads.blob !== undefined) requireMethods(downloads.blob, 'downloads.blob', ['get']);
  if (downloads.dir === undefined && downloads.blob === undefined)
    throw invalid('downloads needs dir or blob');
  return {
    ...(downloads.dir !== undefined ? { dir: downloads.dir } : {}),
    ...(downloads.blob !== undefined ? { blob: downloads.blob } : {}),
  };
}

function resolvePorts(ports: ComputeOptions['ports']): ResolvedOptions['ports'] {
  if (ports === undefined) return {};
  if (!isRecord(ports)) throw invalid('ports must be an object');
  if (ports.capacity !== undefined)
    requireMethods(ports.capacity, 'ports.capacity', ['reserve', 'release']);
  if (ports.inventory !== undefined) requireMethods(ports.inventory, 'ports.inventory', ['get']);
  return {
    ...(ports.capacity ? { capacity: ports.capacity } : {}),
    ...(ports.inventory ? { inventory: ports.inventory } : {}),
  };
}
