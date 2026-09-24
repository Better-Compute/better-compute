/**
 * The better-compute control plane: `betterCompute()`, the operation envelope, the method → action
 * registry, the module host and the HTTP transports (PLAN.md §8, §9). It never imports the
 * injected modules, the store or the IAM bridge; they arrive through options (P10).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ComputeError,
  newId,
  notImplemented,
  type ComputeModule,
  type ComputePlugin,
  type Credential,
  type ModuleContext,
} from '@better-compute/core';
import { inventoryModule } from '@better-compute/inventory';
import type {
  JoinRequest,
  JoinResponse,
  RenewRequest,
  RenewResponse,
  SecretRequest,
  SecretResponse,
} from '@better-compute/protocol';
import type { ComputeApi } from './api.js';
import { createModuleContext } from './context.js';
import { createHttp } from './http.js';
import { createOperations } from './operations.js';
import { resolveOptions, workerRoles, type ComputeOptions, type WorkerRole } from './options.js';
import { createRegistry, type Registry } from './registry.js';
import { createSelfCheck, type SelfCheckReport } from './self-check.js';
import { systemApi } from './system.js';
import { serverInfo } from './version.js';

export type { ApiMethod, CallableApi, ComputeApi, CoreApi, CoreGroups, PluginsApi } from './api.js';
export { configOptions, defineConfig } from './define.js';
export type { ComputeConfigContext, ComputeConfigFactory } from './define.js';
export { maxBodyBytes } from './http.js';
export { workerRoles } from './options.js';
export type { ComputeOptions, WorkerRole } from './options.js';
export type {
  RegisteredMethod,
  Registry,
  RegistryProblem,
  RegistryProblemKind,
} from './registry.js';
export type { SelfCheckReport } from './self-check.js';
export { validateNoInput } from './system.js';
export type { CallerIdentity, NoInput, SystemApi, WhoAmI } from './system.js';
export { serverVersion } from './version.js';
export type { ServerInfo } from './version.js';

/** One deterministic step of a background job; returns how many items it processed. */
export interface Job {
  tick(): Promise<number>;
}

/**
 * What `createGateway` (v0.1) consumes from the API process: JoinService, certificate renewal with
 * proof of possession, and the secret broker (v0.2). DRAFT until v0.1; every method answers
 * `NOT_IMPLEMENTED` in P0.
 */
export interface GatewayServices {
  join(request: JoinRequest): Promise<JoinResponse>;
  renew(request: RenewRequest): Promise<RenewResponse>;
  secret(request: SecretRequest): Promise<SecretResponse>;
}

/** One `authz_projection` row as the resolver reads it (PLAN.md §12.4). */
export interface AuthzProjectionRow {
  type: string;
  id: string;
  tenantId: string;
  attributes: Record<string, string | number | boolean>;
  parentType?: string;
  parentId?: string;
  ownerId?: string;
  /** In-flight `extend` values the resolver reports instead of the stored ones. */
  pending?: Record<string, string | number | boolean>;
}

/** The memory-resident authorization projection behind the IAM resolver. Arrives in v0.1. */
export interface AuthzProjection {
  get(type: string, id: string, tenantId: string): Promise<AuthzProjectionRow | undefined>;
}

/** Where the handler is mounted, for framework integrations. */
export interface ComputeEndpoint {
  origin: string;
  basePath: string;
  secure: boolean;
}

/** A configured control plane (PLAN.md §8.2). */
export interface BetterCompute<
  M extends readonly ComputeModule[] = [],
  P extends readonly ComputePlugin[] = [],
> {
  /** Every method, `(credential, input)`, through the same envelope as HTTP; drives client inference. */
  api: ComputeApi<M, P>;
  /** The fetch transport: `app.all('/api/compute/*', (c) => compute.handler(c.req.raw))`. */
  handler(request: Request): Promise<Response>;
  /** The Node.js transport: `createServer(compute.nodeHandler)`. */
  nodeHandler(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** Consumed by `createGateway` (dependency inversion); v0.1. */
  gatewayServices: GatewayServices;
  /**
   * Checks the method → action registry against the merged catalog and §9.2 (`INVALID_CONFIG`), then
   * migrates the store: its base schema, then every module's and plugin's migrations. Idempotent.
   */
  initialize(): Promise<void>;
  /** Starts the worker roles (all by default). P0 has no worker runtimes yet: it only validates. */
  start(options?: { roles?: WorkerRole[] }): Promise<void>;
  stop(): Promise<void>;
  /** Deterministic stepping of background jobs in tests; empty in P0. */
  jobs: Readonly<Record<string, Job>>;
  registry: Registry;
  /** The authorization projection (v0.1). */
  authz: AuthzProjection;
  /** Reports configuration and storage problems; only reads. */
  selfCheck(): Promise<SelfCheckReport>;
  endpoint: ComputeEndpoint;
}

/**
 * Builds the control plane. Synchronous and side-effect free, like `betterIam()`: it validates the
 * options (`INVALID_CONFIG`), registers `system`, the built-in `inventory` module, then `modules`
 * and `plugins`, and touches neither the store nor IAM until called.
 *
 * ```ts
 * const compute = betterCompute({ database: postgres({ url }), secret, baseURL, rootTenantId,
 *   iam: bridge.embedded(iam, { rootTenantId }), modules: [metal()], plugins: [acme()] });
 * await compute.initialize();
 * ```
 */
export function betterCompute<
  const M extends readonly ComputeModule[] = [],
  const P extends readonly ComputePlugin[] = [],
>(options: ComputeOptions<M, P>): BetterCompute<M, P> {
  const resolved = resolveOptions(options);
  const modules: readonly ComputeModule[] = [inventoryModule, ...(options.modules ?? [])];
  const plugins: readonly ComputePlugin[] = [...(options.plugins ?? [])];
  let context: ModuleContext | undefined;
  let selfCheck: (() => Promise<SelfCheckReport>) | undefined;

  const registry = createRegistry({
    core: systemApi({
      info: () => serverInfo(resolved.basePath),
      selfCheck: () => selfCheck!(),
    }),
    modules,
    plugins,
    extensions: [
      ...(options.drivers ?? []),
      ...(options.providers ?? []),
      ...(options.attestors ?? []),
      ...(options.scheduler?.plugins ?? []),
      ...(options.sinks?.usage ?? []),
      ...(options.sinks?.events ?? []),
      ...(options.sinks?.audit ?? []),
    ],
    context: (view) => (context = createModuleContext(resolved, view)),
  });
  const moduleContext = context!;
  selfCheck = createSelfCheck({
    database: resolved.database,
    registry,
    modules: [...modules, ...plugins],
    context: moduleContext,
  });
  const operations = createOperations(resolved, moduleContext);
  const http = createHttp({ options: resolved, registry, operations });

  const api: Record<string, unknown> = {};
  const pluginApis: Record<string, Record<string, Record<string, unknown>>> = {};
  for (const id of registry.plugins) pluginApis[id] = {};
  for (const entry of registry.methods) {
    const target: Record<string, Record<string, unknown>> = entry.plugin
      ? pluginApis[entry.plugin]!
      : (api as Record<string, Record<string, unknown>>);
    const group = (target[entry.group] ??= {});
    group[entry.method] = (credential?: Credential, input?: unknown) =>
      operations.call(entry, credential, input, { requestId: newId('req') });
  }
  for (const target of [api, ...Object.values(pluginApis)])
    for (const group of Object.values(target)) Object.freeze(group);
  for (const plugin of Object.values(pluginApis)) Object.freeze(plugin);
  api.plugins = Object.freeze(pluginApis);

  let initializing: Promise<void> | undefined;
  let initialized = false;
  const initialize = (): Promise<void> =>
    (initializing ??= (async () => {
      const fatal = registry.problems().filter((problem) => problem.kind !== 'undeclared');
      if (fatal.length)
        throw new ComputeError(
          'INVALID_CONFIG',
          `The method → action registry is inconsistent: ${fatal.map((problem) => problem.message).join('; ')}`,
          undefined,
          { problems: fatal },
        );
      await resolved.database.migrate(registry.migrations);
      initialized = true;
    })().catch((error: unknown) => {
      initializing = undefined;
      throw error;
    }));

  return {
    api: Object.freeze(api) as ComputeApi<M, P>,
    handler: http.handler,
    nodeHandler: http.nodeHandler,
    gatewayServices: Object.freeze({
      join: () => Promise.reject(notImplemented('JoinService', 'v0.1')),
      renew: () => Promise.reject(notImplemented('Certificate renewal', 'v0.1')),
      secret: () => Promise.reject(notImplemented('The secret broker', 'v0.2')),
    }),
    initialize,
    async start(startOptions = {}) {
      const roles: unknown = startOptions.roles ?? workerRoles;
      if (
        !Array.isArray(roles) ||
        roles.some((role) => !(workerRoles as readonly unknown[]).includes(role))
      )
        throw new ComputeError('INVALID_CONFIG', `roles must be among ${workerRoles.join(', ')}`);
      if (!initialized) throw new ComputeError('INVALID_STATE', 'Call initialize() before start()');
    },
    async stop() {},
    jobs: Object.freeze({}),
    registry,
    authz: Object.freeze({
      get: () => Promise.reject(notImplemented('The authz projection', 'v0.1')),
    }),
    selfCheck,
    endpoint: Object.freeze({
      origin: resolved.origin,
      basePath: resolved.basePath,
      secure: resolved.baseURL.protocol === 'https:',
    }),
  };
}
