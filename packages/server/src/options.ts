import {
  ComputeError,
  computeResourceTypes,
  systemClock,
  type AttestorVerifier,
  type BlobStore,
  type CertificateAuthority,
  type Clock,
  type ComputeModule,
  type ComputePlugin,
  type DriverDefinition,
  type IamPort,
  type Logger,
  type Notifier,
  type ProviderDefinition,
  type SchedulerOptions,
  type SecretStore,
  type SinkOptions,
  type SqlExecutor,
} from '@better-compute/core';

/** Worker roles `start({ roles })` runs (PLAN.md §8.1); `api` and `gateway` processes run none. */
export const workerRoles = ['controllers', 'scheduler', 'sinks', 'iam'] as const;
export type WorkerRole = (typeof workerRoles)[number];

/**
 * Options of `betterCompute()` (PLAN.md §8.2). Fields for later phases are accepted and typed now;
 * P0 validates and registers them but runs nothing with them yet.
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
   */
  rootTenantId: string;
  /** The IAM resource type prefix, the same as the IAM bridge's (default `compute-`). */
  typePrefix?: string;
  /** Injected modules (`metal()`, `vps()`, `provisionModule()`), registered after the built-ins. */
  modules?: M;
  /** Third-party modules mounted under `plugins/{id}` with actions `compute:<id>:*`. */
  plugins?: P;
  drivers?: DriverDefinition[];
  providers?: ProviderDefinition[];
  scheduler?: SchedulerOptions;
  attestors?: AttestorVerifier[];
  pki?: {
    nodeCa?: CertificateAuthority;
    servingCa?: CertificateAuthority;
    internalCa?: CertificateAuthority;
  };
  secrets?: SecretStore[];
  notifier?: Notifier;
  sinks?: SinkOptions;
  downloads?: { dir?: string; blob?: BlobStore };
  gateway?: { publicUrls: Record<string, string>; maxStreams?: number };
  /** Business time (P9). Default: the system clock until the db-anchored clock lands in v0.1. */
  clock?: Clock;
  /** Accept the IAM session cookie on same-origin requests (a console on one origin); default false. */
  acceptIamCookie?: boolean;
  /** Where modules and the server log (`ModuleContext.log`); default: warnings and errors as JSON on stderr. */
  log?: Logger;
}

/** The validated options the server runs with. */
export interface ResolvedOptions {
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
  if (typeof options.rootTenantId !== 'string' || !tenantIdPattern.test(options.rootTenantId))
    throw invalid('rootTenantId must be the IAM root tenant id');

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
  ] as const)
    if (options[list] !== undefined && !Array.isArray(options[list]))
      throw invalid(`${list} must be an array`);

  return {
    database: options.database,
    iam: options.iam,
    rootTenantId: options.rootTenantId,
    typePrefix,
    baseURL,
    origin: baseURL.origin,
    basePath,
    acceptIamCookie: options.acceptIamCookie ?? false,
    clock: options.clock ?? systemClock,
    log: options.log ?? defaultLogger,
  };
}
