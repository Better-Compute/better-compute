/**
 * The better-compute control plane: `betterCompute()`, the operation envelope, the method → action
 * registry, the module host and the HTTP transports (PLAN.md §8, §9). It never imports the
 * injected modules, the store or the IAM bridge; they arrive through options (P10).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ComputeError,
  newId,
  type AuthzAttributes,
  type AuthzRow,
  type ComputeModule,
  type ComputePlugin,
  type Credential,
  type DriverDefinition,
  type ModuleContext,
} from '@better-compute/core';
import { capacityModule } from '@better-compute/capacity';
import { inventoryModule } from '@better-compute/inventory';
import { sealedSecretsMigration } from '@better-compute/pki';
import { coreGroups, type ComputeApi, type ComputeCaches } from './api.js';
import { createModuleContext } from './context.js';
import { createHttp } from './http.js';
import { createGatewayServices, type GatewayServices } from './join/index.js';
import { createNodesModule } from './nodes-module.js';
import { createOperations } from './operations.js';
import { resolveOptions, workerRoles, type ComputeOptions, type WorkerRole } from './options.js';
import { createRegistry, type Registry } from './registry.js';
import {
  builtinCommandKinds,
  createRuntime,
  type EventSubscriptions,
  type Job,
} from './runtime/index.js';
import { createSelfCheck, type SelfCheckReport } from './self-check.js';
import { createSiteBootModule } from './site-boot-module.js';
import { createTenancyModule, createTenantGate } from './tenancy/tenancy.js';
import { createAuditSinksModule } from './audit-sinks-module.js';
import { tunnelsModule } from './tunnels/module.js';
import { serverInfo } from './version.js';

export type * from './api.js';
export { configOptions, defineConfig } from './define.js';
export type { ComputeConfigContext, ComputeConfigFactory } from './define.js';
export { maxBodyBytes } from './http.js';
export { workerRoles } from './options.js';
export type {
  ComputeOptions,
  IamJob,
  WorkerObserver,
  WorkerOptions,
  WorkerRole,
} from './options.js';
export type { ReconcileRun } from './runtime/reconcilers.js';
export {
  anchoredClock,
  assignShards,
  builtinCommandKinds,
  builtinJobNames,
  clockSkewThresholdMs,
  commandOwner,
  eventPattern,
  isAnchoredClock,
  leaseNames,
  pokeMessage,
  shardOwner,
} from './runtime/index.js';
export type {
  AnchoredClock,
  EventHandler,
  EventSubscriptions,
  GatewayPokes,
  Job,
} from './runtime/index.js';
export type {
  RegisteredMethod,
  Registry,
  RegistryProblem,
  RegistryProblemKind,
} from './registry.js';
export type { SelfCheckReport } from './self-check.js';
export { validateNoInput } from './system.js';
export type { CallerIdentity, NoInput, SystemApi, WhoAmI } from './system.js';
export { serverVersion, wellKnownJoinKeys } from './version.js';
export type { ServerInfo, WellKnownJoinKeys } from './version.js';
export * from './join/index.js';
export { commandTrustBundle, createCommandSigner } from './runtime/command-signing.js';
export type { CommandSigner, CommandSignerOptions } from './runtime/command-signing.js';
export * from './controllers/index.js';
export * from './nodes-module.js';
export * from './site-boot-module.js';
export * from './audit-sinks-module.js';
export { bcdArtifact, type DownloadsOptions } from './downloads.js';
export { supportBundleKey, type SupportBundlesOptions } from './api/commands.js';
export { siteBootLeaseName, siteBootTtlSeconds, tickSiteBoot } from './controllers/site-boot.js';
export {
  applyTenantStates,
  createTenantGate,
  tearDownTenant,
  tenancyModuleName,
  tenancyWorkKind,
  tenantStateHandler,
  tenantStatesMigration,
  type IamTenantStatus,
  type TenantEventLike,
  type TenantGate,
  type TenantState,
  type TenantStateHandlerOptions,
} from './tenancy/tenancy.js';
export type { SiteBootState } from './controllers/site-boot.js';
export * from './tunnels/index.js';

/** One `authz_projection` row as the resolver reads it (PLAN.md §12.4). */
export interface AuthzProjectionRow extends AuthzRow {
  /** In-flight `extend` values the resolver reports instead of the stored ones. */
  pending?: AuthzAttributes;
}

/**
 * The authorization projection as the store holds it: one primary-key read (`type` with or
 * without the IAM prefix). The IAM bridge keeps the memory-resident copy its resolver reads.
 */
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
  /**
   * Consumed by `createGateway` (dependency inversion): JoinService's `join` and `renew` (keys from
   * `pki.join`), and the secret broker (v0.2).
   */
  gatewayServices: GatewayServices;
  /**
   * Checks the method → action registry against the merged catalog and §9.2 (`INVALID_CONFIG`),
   * migrates the store (its base schema, then every module's and plugin's migrations), anchors the
   * default clock, then awaits each module's `start()` in registration order. Idempotent.
   */
  initialize(): Promise<void>;
  /**
   * Runs the worker roles (all by default) on timers under their leases: `controllers`
   * (reconcilers over the shards this worker holds, the CommandSweeper), `sinks` (OutboxDispatch),
   * `iam` (`iamJobs`); `scheduler` arrives in v0.4. Also tails the outbox for `events.subscribe`.
   * Calling it again adds roles.
   */
  start(options?: { roles?: WorkerRole[] }): Promise<void>;
  /** Stops the loops, releases leases, leaves the worker table, then stops modules in reverse. */
  stop(): Promise<void>;
  /**
   * One deterministic pass per call, without timers (tests and the simulator): each reconciler by
   * name, `command-sweeper`, `outbox-dispatch`, `event-subscribers` and `iam:<name>`.
   */
  jobs: Readonly<Record<string, Job>>;
  /** In-process subscribers of committed events (`reservation.*`, `*`), fed by the outbox tail. */
  events: EventSubscriptions;
  /**
   * The module context the runtime serves (store, clock, leases, work queue, commands, events,
   * authz, …): hosts pass its ports on, e.g. `createGateway({ work: compute.context.work, events:
   * compute.context.events })`.
   */
  context: ModuleContext;
  registry: Registry;
  /** Drops cached authentications and read decisions; the IAM bridge calls it on inbox events. */
  caches: ComputeCaches;
  /**
   * The envelope's tenant gate (§12.8): `invalidate()` makes this process reload suspended and deleted tenants
   * before its next call (`tenantStateHandler` does it after a change; other processes refresh every 5 s).
   */
  tenants: { invalidate(): void };
  /** The authorization projection: one primary-key read (the IAM bridge keeps the memory copy). */
  authz: AuthzProjection;
  /** Reports configuration and storage problems; only reads. */
  selfCheck(): Promise<SelfCheckReport>;
  endpoint: ComputeEndpoint;
}

/**
 * Builds the control plane. Synchronous and side-effect free, like `betterIam()`: it validates the
 * options (`INVALID_CONFIG`), registers `system` and the server's own groups, the built-in node
 * controllers, the always-on `inventory` and `capacity` modules, then `modules` and `plugins`, and
 * touches neither the store nor IAM until called.
 *
 * ```ts
 * const compute = betterCompute({ database: postgres({ url }), secret, baseURL,
 *   iam: bridge.embedded(iam, { rootTenantId }), modules: [metal()], plugins: [acme()],
 *   pki: { join: pkiJoinCrypto({ trustDomain, nodeCa, signingKey, encryptionKey }) } });
 * await compute.initialize();
 * ```
 */
export function betterCompute<
  const M extends readonly ComputeModule[] = [],
  const P extends readonly ComputePlugin[] = [],
>(options: ComputeOptions<M, P>): BetterCompute<M, P> {
  const resolved = resolveOptions(options);
  const runtime = createRuntime(resolved);
  // The envelope's §12.8 tenant gate, loaded and refreshed by the tenancy module.
  const tenantGate = createTenantGate({
    sql: resolved.database,
    rootTenantId: resolved.rootTenantId ?? '',
    onError: (error) =>
      resolved.log.warn('Reloading suspended tenants failed; retrying', {
        error: error instanceof Error ? error.message : String(error),
      }),
  });
  // The built-ins first: the node controllers, then the two always-on modules (P10's exception).
  const modules: readonly ComputeModule[] = [
    createNodesModule({
      modules: () => hosted,
      // A new spec generation wakes the node's gateway to push DesiredState (best effort).
      specChanged: (tx, nodeId) => runtime.pokes.pokeNodes(tx, [nodeId]),
      // Signed intent: every new spec generation is signed like commands (the gateway relays it).
      ...(resolved.commandSigner ? { signer: resolved.commandSigner } : {}),
    }),
    createSiteBootModule(),
    inventoryModule,
    capacityModule(resolved.capacity),
    // §12.8 tenants: suspended/deleted states, the teardown of deleted tenants (every module's tenantDeleted).
    createTenancyModule({ modules: () => hosted, gate: tenantGate }),
    // The default secret store's table (`sealed_secrets`, owned by pki's migration).
    ...(resolved.sealedSecrets ? [{ name: 'pki', migrations: [sealedSecretsMigration] }] : []),
    ...(options.tunnels ? [tunnelsModule(options.tunnels)] : []),
    // Audit sinks (`sinks.audit` and modules' AuditSink extensions): committed audit rows, in order.
    ...(resolved.auditSinks.length ? [createAuditSinksModule(resolved.auditSinks)] : []),
    ...(options.modules ?? []),
  ];
  const plugins: readonly ComputePlugin[] = [...(options.plugins ?? [])];
  let context: ModuleContext | undefined;
  let selfCheck: (() => Promise<SelfCheckReport>) | undefined;

  const registry: Registry = createRegistry({
    core: coreGroups(resolved, {
      info: () => serverInfo(resolved.basePath),
      selfCheck: () => selfCheck!(),
      // Read at call time, once the registry exists.
      drivers: () =>
        registry.extensions.filter(
          (extension): extension is DriverDefinition =>
            (extension as { extension?: unknown }).extension === 'driver',
        ),
    }),
    commandKinds: builtinCommandKinds,
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
    context: (view) =>
      (context = createModuleContext(resolved, view, runtime.ports(view), [
        ...modules,
        ...plugins,
      ])),
  });
  const moduleContext = context!;
  const hosted: readonly ComputeModule[] = [...modules, ...plugins];
  runtime.bind({ context: moduleContext, registry, modules: hosted });
  selfCheck = createSelfCheck({
    database: resolved.database,
    registry,
    // The runtime reports like a module: ClockSkew.
    modules: [...hosted, { name: 'runtime', selfCheck: async () => runtime.findings() }],
    context: moduleContext,
  });
  const operations = createOperations(resolved, moduleContext, registry, tenantGate);
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
  /** Modules whose `start()` ran, in order; `stop()` stops them in reverse. */
  const started: ComputeModule[] = [];
  const stopModules = async () => {
    const failures: unknown[] = [];
    while (started.length) {
      const module = started.pop()!;
      try {
        await module.stop?.();
      } catch (error) {
        failures.push(error);
        resolved.log.error(`Module ${module.name} failed to stop`, {
          module: module.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return failures;
  };
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
      await runtime.initialize();
      try {
        for (const module of hosted) {
          if (typeof module.start !== 'function') continue;
          await module.start(moduleContext);
          started.push(module);
        }
      } catch (error) {
        await stopModules();
        throw error;
      }
      initialized = true;
    })().catch((error: unknown) => {
      initializing = undefined;
      throw error;
    }));

  return {
    api: Object.freeze(api) as ComputeApi<M, P>,
    handler: http.handler,
    nodeHandler: http.nodeHandler,
    gatewayServices: createGatewayServices({
      database: resolved.database,
      clock: resolved.clock,
      work: moduleContext.work,
      events: moduleContext.events,
      ...(resolved.join ? { pki: { join: resolved.join } } : {}),
      attestors: registry.extensions,
      authz: moduleContext.authz,
      log: resolved.log,
      // `security.join.refused` lands in the root tenant unless a verified token names another.
      rootTenantId: resolved.rootTenantId,
      // The secret broker (SecretRequest → JWE) over the same stores as `ctx.secrets`.
      secrets: resolved.secretStores,
      // Signed intent: command-signing roots in JoinResponse.trust and (signed) Welcome.trust.
      ...(resolved.trustBundle ? { trustBundle: resolved.trustBundle } : {}),
      // v0.5 workload identity: WorkloadTokenRequest → the instance's JWT sealed to its one-time key.
      ...(options.workloadIdentity ? { workloadIdentity: options.workloadIdentity } : {}),
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
      await runtime.start(roles as WorkerRole[]);
    },
    async stop() {
      await runtime.stop();
      const failures = await stopModules();
      if (initialized) {
        initialized = false;
        initializing = undefined;
      }
      if (failures.length) throw failures[0];
    },
    jobs: runtime.jobs,
    events: runtime.events,
    context: moduleContext,
    registry,
    caches: operations.caches,
    tenants: Object.freeze({ invalidate: () => tenantGate.invalidate() }),
    authz: Object.freeze({
      get: (type: string, id: string, tenantId: string) => runtime.authzRow(type, id, tenantId),
    }),
    selfCheck,
    endpoint: Object.freeze({
      origin: resolved.origin,
      basePath: resolved.basePath,
      secure: resolved.baseURL.protocol === 'https:',
    }),
  };
}
