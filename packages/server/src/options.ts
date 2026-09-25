import {
  ComputeError,
  computeResourceTypes,
  newId,
  type AttestorVerifier,
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
  type SecretStore,
  type SinkOptions,
  type SqlExecutor,
} from '@better-compute/core';
import type { CapacityModuleOptions } from '@better-compute/capacity';
import { localSealedSecretStore } from '@better-compute/pki';
import type { JoinCrypto } from './join/crypto.js';
import type { TunnelsOptions } from './tunnels/module.js';
import { anchoredClock } from './runtime/clock.js';
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
}

/**
 * Options of `betterCompute()` (PLAN.md §8.2). Fields for later phases (`secrets`, `downloads`,
 * `gateway`, the other CAs) are accepted and typed now; nothing runs with them until their phase.
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
  };
  secrets?: SecretStore[];
  /**
   * v0.3 tunnels and break-glass SSH (`tunnels.open`, `nodes.issueSshCert`): pki's exec ticket
   * issuer (its JWKS also goes to the gateway's `tunnels.jwks`), the SSH CA and the re-authorizer.
   * Without it neither method is registered.
   */
  tunnels?: TunnelsOptions;
  notifier?: Notifier;
  sinks?: SinkOptions;
  downloads?: { dir?: string; blob?: BlobStore };
  gateway?: { publicUrls: Record<string, string>; maxStreams?: number };
  /**
   * Business time (P9). Default: the process clock anchored to `compute_now()`, re-sampled at every
   * lease renewal (ClockSkew beyond 1 s). Tests pass the sim clock.
   */
  clock?: Clock;
  /** Accept the IAM session cookie on same-origin requests (a console on one origin); default false. */
  acceptIamCookie?: boolean;
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
  clock: Clock;
  log: Logger;
  notifier?: Notifier;
  eventSinks: readonly EventSink[];
  iamJobs: readonly IamJob[];
  worker: WorkerSettings;
  ports: { capacity?: CapacityPort; inventory?: InventoryPort };
  /** The built-in capacity module's options: `capacity` plus the `scheduler`'s placement options. */
  capacity: CapacityModuleOptions;
  /** JoinService's keys and node CA, when configured. */
  join?: JoinCrypto;
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
  const eventSinks = [...(options.sinks?.events ?? [])];
  const sinkIds = new Set<string>();
  for (const sink of eventSinks) {
    requireMethods(sink, 'sinks.events[]', ['deliver']);
    // Each sink's outbox cursor is stored under its id.
    if (typeof sink.id !== 'string' || !sink.id)
      throw invalid('sinks.events[].id must be a non-empty string');
    if (sinkIds.has(sink.id)) throw invalid(`Event sink ${sink.id} is listed twice`);
    sinkIds.add(sink.id);
  }
  const ports = resolvePorts(options.ports);
  const capacity = resolveCapacity(options.capacity, options.scheduler);
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

  return {
    database: hooks.database,
    iam: options.iam,
    rootTenantId,
    typePrefix,
    baseURL,
    origin: baseURL.origin,
    basePath,
    acceptIamCookie: options.acceptIamCookie ?? false,
    clock: options.clock ?? anchoredClock(),
    log,
    ...(options.notifier ? { notifier: options.notifier } : {}),
    eventSinks,
    iamJobs: resolveIamJobs(options.iamJobs ?? []),
    worker: resolveWorker(options.worker),
    ports,
    capacity,
    ...(join ? { join } : {}),
    secretStores,
    sealedSecrets: configuredStores.length === 0,
    afterCommit: hooks.afterCommit,
    inTransaction: hooks.inTransaction,
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
  return {
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
  if (scheduler?.plugins) resolved.plugins = scheduler.plugins;
  if (scheduler?.weights) resolved.weights = scheduler.weights;
  if (scheduler?.topN !== undefined) resolved.topN = scheduler.topN;
  return resolved;
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
