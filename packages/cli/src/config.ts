import { access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ComputeError,
  type ComputeModule,
  type ComputePlugin,
  type SqlExecutor,
} from '@better-compute/core';
import {
  betterCompute,
  configOptions,
  type BetterCompute,
  type ComputeConfigContext,
  type ComputeConfigFactory,
  type ComputeOptions,
} from '@better-compute/server';
import { retentionModule } from '@better-compute/postgres';
import { CliError } from './errors.js';
import type { CommandSpec } from './framework.js';
import type { HostExport } from './host/config.js';
import { unconfiguredIam } from './iam.js';

/** Configuration file names the CLI looks for, in this order, in the working directory and then each parent. */
export const configFileNames = [
  'better-compute.config.mjs',
  'better-compute.config.js',
  'better-compute.config.ts',
  'better-compute.config.mts',
] as const;

/** How messages name the configuration files. */
const configFilePattern = 'better-compute.config.{mjs,js,ts,mts}';

/** What `source` says for a deployment described by environment variables alone. */
export const envConfigSource = 'BETTER_COMPUTE_DATABASE_URL';

/** Options of a deployment with any modules and plugins. */
export type AnyComputeOptions = ComputeOptions<readonly ComputeModule[], readonly ComputePlugin[]>;
/** A control plane with any modules and plugins. */
export type AnyCompute = BetterCompute<readonly ComputeModule[], readonly ComputePlugin[]>;

/** A configuration module's default export: options, or a (possibly async) factory of them (`defineConfig`). */
export type ConfigExport = AnyComputeOptions | ComputeConfigFactory;

/**
 * Settings the CLI reads from the configuration module's named `cli` export: defaults for the flags
 * of commands that load the configuration or act as a token (`'*'` applies to every such command
 * that has the flag), used when neither the flag nor its environment variable is set.
 */
export interface CliSettings {
  defaults?: Record<string, Record<string, string | number | boolean>>;
}

/**
 * The shape of `better-compute.config.{ts,mjs}`: the default export configures the deployment,
 * `commands` adds project commands to the CLI (`defineCommand`), and `cli` sets flag defaults.
 */
export interface ConfigModule {
  default?: ConfigExport;
  /** What `serve` runs around the control plane: extra routes, the gateway role (`defineHost`). */
  host?: HostExport;
  commands?: readonly CommandSpec<any>[];
  cli?: CliSettings;
}

export interface ResolvedConfigPath {
  path: string;
  source: 'flag' | 'env' | 'discovered';
}

/** A configured control plane, with the options it was built from. */
export interface Deployment {
  compute: AnyCompute;
  options: AnyComputeOptions;
  /** The configuration file, or `BETTER_COMPUTE_DATABASE_URL` in environment-only mode. */
  source: string;
  /** Closes the deployment's database. */
  close(): Promise<void>;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** The nearest configuration file in `cwd` or one of its parents, like Prettier and ESLint find theirs. */
export async function findConfigFile(cwd: string): Promise<string | undefined> {
  let directory = resolve(cwd);
  for (;;) {
    for (const name of configFileNames) {
      const candidate = join(directory, name);
      if (await exists(candidate)) return candidate;
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/** `--config`, else `BETTER_COMPUTE_CONFIG`, else the nearest configuration file; undefined when there is none. */
export async function resolveConfigPath(
  flag: string | undefined,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<ResolvedConfigPath | undefined> {
  if (flag) return { path: resolve(cwd, flag), source: 'flag' };
  if (env.BETTER_COMPUTE_CONFIG)
    return { path: resolve(cwd, env.BETTER_COMPUTE_CONFIG), source: 'env' };
  const found = await findConfigFile(cwd);
  return found ? { path: found, source: 'discovered' } : undefined;
}

/** Imports a trusted configuration module (it is executable code), with readable errors for the usual mistakes. */
export async function importConfigModule(path: string): Promise<ConfigModule> {
  if (!(await exists(path)))
    throw new CliError(
      'CONFIG_NOT_FOUND',
      `Configuration ${path} does not exist`,
      'Run better-compute init to create one, pass --config PATH, or set BETTER_COMPUTE_CONFIG.',
    );
  try {
    return (await import(pathToFileURL(path).href)) as ConfigModule;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ERR_UNKNOWN_FILE_EXTENSION' && /\.[cm]?ts$/.test(path))
      throw new CliError(
        'CONFIG_LOAD_FAILED',
        `Node.js ${process.versions.node} cannot load the TypeScript configuration ${path}`,
        'Use Node.js 22.18 or later (type stripping is on by default there), or rename it to .mjs.',
      );
    throw error;
  }
}

/**
 * The options plus the store's own housekeeping, which the server cannot register itself (it never
 * imports the store): `retentionModule()` from @better-compute/postgres (the periodic `core.retention`
 * pass that prunes the outbox and authz changes behind their cursors, spent attestation uses and expired
 * join requests), unless the configuration registers a `retention` module already.
 */
export function withHostModules(options: AnyComputeOptions): AnyComputeOptions {
  const modules = options.modules ?? [];
  if (modules.some((module) => module.name === 'retention')) return options;
  return { ...options, modules: [...modules, retentionModule()] };
}

/** Builds the control plane for `options`; the database is closed again when the options are invalid. */
export function createDeployment(given: AnyComputeOptions, source: string): Deployment {
  let compute: AnyCompute;
  let options = given;
  try {
    options = withHostModules(given);
    compute = betterCompute(options);
  } catch (error) {
    // The executors connect lazily, but a pool may exist already; nothing will use it.
    void Promise.resolve()
      .then(() => given?.database?.close?.())
      .catch(() => undefined);
    throw error;
  }
  return { compute, options, source, close: () => options.database.close() };
}

/** Creates the deployment a module's default export describes (calling a factory with `context`). */
export async function instantiate(
  module: ConfigModule,
  source: string,
  context: ComputeConfigContext,
): Promise<Deployment> {
  const exported = module.default;
  if (!exported || (typeof exported !== 'object' && typeof exported !== 'function'))
    throw new ComputeError(
      'INVALID_CONFIG',
      `${source} must export default defineConfig(options) or defineConfig(factory)`,
    );
  const options = await configOptions(exported as ComputeConfigFactory, context);
  if (!options || typeof options !== 'object')
    throw new ComputeError(
      'INVALID_CONFIG',
      `The configuration factory in ${source} returned no options`,
    );
  return createDeployment(options, source);
}

/**
 * Loads a configuration file and creates its deployment: the same resolution the CLI uses, for
 * scripts and tests that want `better-compute.config.ts` without the command line. Without a file,
 * `BETTER_COMPUTE_DATABASE_URL` describes the deployment. Call `close()` when done.
 */
export async function loadConfig(
  options: { config?: string; cwd?: string; env?: NodeJS.ProcessEnv; command?: string } = {},
): Promise<Deployment> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const located = await resolveConfigPath(options.config, env, cwd);
  if (!located) {
    if (env.BETTER_COMPUTE_DATABASE_URL)
      return createDeployment(await configFromEnv(env, cwd), envConfigSource);
    throw new CliError(
      'CONFIG_NOT_FOUND',
      `No ${configFilePattern} in ${cwd} or its parents`,
      'Run better-compute init, pass --config PATH, set BETTER_COMPUTE_CONFIG, or set BETTER_COMPUTE_DATABASE_URL and BETTER_COMPUTE_SECRET.',
    );
  }
  return instantiate(await importConfigModule(located.path), located.path, {
    env,
    cwd,
    ...(options.command ? { command: options.command } : {}),
  });
}

/** Whether `error`, or an error it wraps, says that `specifier` itself could not be found. */
function moduleNotFound(error: unknown, specifier: string): boolean {
  for (let current = error, depth = 0; current && depth < 5; depth++) {
    const { code, message, cause } = current as {
      code?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (
      (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') &&
      String(message).includes(`'${specifier}'`)
    )
      return true;
    current = cause;
  }
  return false;
}

/**
 * Imports an optional peer dependency, failing with `MISSING_DEPENDENCY` and an install hint when
 * it is not installed. `feature` names what needs it (`A pglite: database`).
 */
export async function importOptional<T = unknown>(specifier: string, feature: string): Promise<T> {
  try {
    return (await import(specifier)) as T;
  } catch (error) {
    if (moduleNotFound(error, specifier))
      throw new CliError(
        'MISSING_DEPENDENCY',
        `${feature} needs ${specifier}, which is not installed`,
        `Install it next to better-compute (npm install ${specifier}).`,
      );
    throw error;
  }
}

/**
 * Deployment options from environment variables alone (twelve-factor style), for containers and
 * CI jobs that have no configuration file:
 *
 * - `BETTER_COMPUTE_DATABASE_URL` (required): `postgres://…`, `pglite:DIR` (PGlite files in a
 *   directory, relative to `cwd`) or `pglite:memory`. PGlite needs the optional peer
 *   `@electric-sql/pglite`.
 * - `BETTER_COMPUTE_SECRET` (required): at least 32 characters.
 * - `BETTER_COMPUTE_BASE_URL` (default `http://localhost:3000`).
 *
 * P0 has no IAM bridge, so the deployment uses `unconfiguredIam()`: only public methods answer
 * until v0.1 wires in embedded better-iam.
 */
export async function configFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Promise<AnyComputeOptions> {
  const url = env.BETTER_COMPUTE_DATABASE_URL;
  if (!url)
    throw new CliError(
      'MISSING_ENV',
      'Set BETTER_COMPUTE_DATABASE_URL',
      'postgres://… for PostgreSQL, pglite:DIR or pglite:memory for PGlite.',
    );
  const secret = env.BETTER_COMPUTE_SECRET;
  if (!secret)
    throw new CliError(
      'MISSING_ENV',
      'Set BETTER_COMPUTE_SECRET',
      'At least 32 random characters, the same for every process of the deployment.',
    );
  let database: SqlExecutor;
  if (/^postgres(?:ql)?:\/\//i.test(url)) {
    const { postgres } = await import('@better-compute/postgres');
    database = postgres({ url });
  } else if (/^pglite:/i.test(url)) {
    const location = url.slice('pglite:'.length).replace(/^\/\//, '');
    if (!location)
      throw new ComputeError(
        'INVALID_CONFIG',
        'BETTER_COMPUTE_DATABASE_URL pglite: needs a directory (pglite:./data) or pglite:memory',
      );
    // The executor loads PGlite only on its first statement; failing here names the fix.
    await importOptional('@electric-sql/pglite', 'A pglite: database');
    const { pglite } = await import('@better-compute/postgres/pglite');
    database = location === 'memory' ? pglite() : pglite({ dataDir: resolve(cwd, location) });
  } else
    throw new ComputeError(
      'INVALID_CONFIG',
      'BETTER_COMPUTE_DATABASE_URL must be postgres://…, pglite:DIR or pglite:memory',
    );
  return {
    database,
    secret,
    baseURL: env.BETTER_COMPUTE_BASE_URL ?? 'http://localhost:3000',
    // Without IAM no caller authenticates, so the root tenant is never consulted.
    rootTenantId: 'root',
    iam: unconfiguredIam(),
  };
}
