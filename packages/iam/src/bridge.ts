// `createComputeIamBridge` (PLAN.md §12.1): one object that wires compute into better-iam in embedded mode.
//
//   const bridge = createComputeIamBridge({ modules: [metal()], rootTenantId });
//   const iam = betterIam({ ..., plugins: [bridge.plugin()], resolveResource: bridge.resolveResource() });
//   const compute = betterCompute({ ..., modules: [...bridge.modules], iam: bridge.embedded(iam) });
//   await compute.initialize();   // the iam module's start() binds the projection and the inbox

import {
  ComputeError,
  defineModule,
  type ComputeModule,
  type Finding,
  type ModuleContext,
  type Reconciler,
  type SqlExecutor,
} from '@better-compute/core';
import { buildComputeCatalog, type ComputeCatalog, type ComputeCatalogOptions } from './catalog.js';
import {
  embeddedIam,
  type EmbeddedIam,
  type EmbeddedIamHost,
  type EmbeddedIamOptions,
} from './embedded.js';
import { createFlagCache, type FlagCache } from './flags.js';
import { iamJobReconcilers, type IamJobReconcilerOptions, type IamJobsHost } from './jobs.js';
import { sqlInbox, type InboxWriter } from './inbox.js';
import { computeIamPlugin, type ComputeIamPlugin, type ComputeIamPluginOptions } from './plugin.js';
import {
  createAuthzProjection,
  sqlProjectionSource,
  type AuthzProjection,
  type AuthzProjectionOptions,
} from './projection.js';
import { computeResolver, type ResourceResolver } from './resolver.js';
import {
  drainIamInbox,
  flushUsageWindows,
  reconcileIamIdentities,
  successorLookup,
  successorsMigration,
  type IamEventHandlers,
  type IdentityState,
} from './worker.js';

export interface ComputeIamBridgeOptions extends ComputeCatalogOptions {
  /** The IAM root tenant; also taken from `embedded(iam, { rootTenantId })`. */
  rootTenantId?: string;
  projection?: Omit<AuthzProjectionOptions, 'source'>;
  /** Compute's reactions to IAM events; `setHandlers` replaces them later (the server wires its own). */
  handlers?: IamEventHandlers;
}

/** An IAM host as the bridge's embedded mode reads it: the port's surface plus its store. */
export type BridgeIamHost = EmbeddedIamHost & {
  store?: { get(collection: string, id: string): Promise<Record<string, unknown> | undefined> };
};

export interface BridgeEmbeddedOptions extends EmbeddedIamOptions {
  /** Run better-iam's scheduler jobs as singleton reconcilers of the iam module. */
  runIamJobs?: boolean | IamJobReconcilerOptions;
}

/** The `iam` module: projection and inbox lifecycle, IamInbox, IamReconcile and the usage sink. */
export type IamModule = ComputeModule<'iam'> & {
  start(context: Pick<ModuleContext, 'sql'>): Promise<void>;
  stop(): Promise<void>;
};

export interface ComputeIamBridge {
  readonly catalog: ComputeCatalog;
  readonly typePrefix: string;
  readonly projection: AuthzProjection;
  /** Created by `embedded()`; invalidated by `feature:*` and authz events. */
  readonly flags: FlagCache | undefined;
  /** Whether `bind` (or the module's `start`) ran. */
  readonly bound: boolean;
  /** Compute's IAM plugin for `betterIam({ plugins })`; the inbox defaults to `localInbox()`. */
  plugin(
    options?: Partial<Omit<ComputeIamPluginOptions, keyof ComputeCatalogOptions>>,
  ): ComputeIamPlugin;
  /** Writes `iam_inbox` through the bound store; rejects until bound, so events spill meanwhile. */
  localInbox(): InboxWriter;
  /** better-iam's `resolveResource`; other types go to `hostFallback`. */
  resolveResource(hostFallback?: ResourceResolver): ResourceResolver;
  /**
   * The IamPort over an embedded better-iam. `runIamJobs` adds better-iam's scheduler jobs to the iam
   * module (worker role `iam`): required when compute's processes are the only IAM hosts (§12.1).
   */
  embedded(iam: BridgeIamHost, options?: BridgeEmbeddedOptions): EmbeddedIam;
  /** Pass to `betterCompute({ modules })`. */
  readonly modules: readonly [IamModule];
  readonly plugins: readonly ComputeModule[];
  /** Binds the projection and inbox to the store, loads the projection and starts tailing. */
  bind(context: Pick<ModuleContext, 'sql'>): Promise<void>;
  stop(): Promise<void>;
  setHandlers(handlers: IamEventHandlers): void;
}

export function createComputeIamBridge(options: ComputeIamBridgeOptions = {}): ComputeIamBridge {
  const catalog = buildComputeCatalog(options);
  const projection = createAuthzProjection(options.projection);
  let rootTenantId = options.rootTenantId;
  let handlers: IamEventHandlers = options.handlers ?? {};
  let sql: SqlExecutor | undefined;
  let flags: FlagCache | undefined;
  let host: BridgeIamHost | undefined;
  const plugins: ComputeIamPlugin[] = [];

  const requireSql = (): SqlExecutor => {
    if (!sql) throw new ComputeError('INVALID_STATE', 'The IAM bridge is not bound to a store yet');
    return sql;
  };

  const readIdentity = async (tenantId: string, identityId: string): Promise<IdentityState> => {
    if (!host?.store)
      throw new ComputeError(
        'INVALID_STATE',
        'IamReconcile needs an embedded IAM host with a store',
      );
    const identity = await host.store.get('identities', identityId);
    if (!identity || identity.tenantId !== tenantId) return { status: 'missing' };
    const status = identity.status;
    const kind = identity.kind;
    const state: IdentityState = {
      status:
        status === 'active' || status === 'disabled' || status === 'deleted' ? status : 'missing',
    };
    if (kind === 'user' || kind === 'service' || kind === 'agent') state.kind = kind;
    return state;
  };

  const reconciler = (
    name: string,
    periodic: NonNullable<Reconciler['periodic']>,
    run: (store: SqlExecutor) => Promise<boolean>,
  ): Reconciler => ({
    name,
    shardBy: 'none',
    periodic,
    run: async (context) => ((await run(context.sql)) ? 'SYNC_AGAIN' : 'DONE'),
  });

  const selfCheck = async (): Promise<Finding[]> => {
    const findings: Finding[] = [];
    if (!projection.ready)
      findings.push({
        check: 'iam.projection',
        severity: 'error',
        message: 'The authz projection is not loaded, so every compute decision is denied',
        fix: 'Start the iam module (compute.initialize()) or call bridge.bind(context)',
      });
    for (const plugin of plugins) {
      const stats = plugin.stats();
      if (stats.pending > 0 || stats.dropped > 0)
        findings.push({
          check: 'iam.inbox-spill',
          severity: stats.dropped > 0 ? 'error' : 'warning',
          message: `${stats.pending} IAM events are spilled in memory and ${stats.dropped} were dropped`,
          fix: 'Check that the compute database is reachable from the IAM host; IamReconcile covers dropped events',
          count: stats.pending + stats.dropped,
        });
    }
    if (sql) {
      const { rows } = await sql.query<{ backlog: string }>(
        'SELECT count(*)::text AS backlog FROM iam_inbox WHERE processed_at IS NULL',
      );
      const backlog = Number(rows[0]?.backlog ?? 0);
      if (backlog > 10_000)
        findings.push({
          check: 'iam.inbox-backlog',
          severity: 'warning',
          message: `${backlog} IAM events wait in iam_inbox`,
          fix: 'Run a worker with the iam.inbox reconciler',
          count: backlog,
        });
    }
    return findings;
  };

  const module: IamModule = {
    ...defineModule({
      name: 'iam',
      migrations: [successorsMigration],
      reconcilers: [
        // The plugin writes iam_inbox directly (possibly from another IAM host), so nothing enqueues the
        // drain edge-triggered: it polls.
        reconciler('iam.inbox', [{ key: 'inbox', every: '2s' }], async (store) => {
          const drained = await drainIamInbox(store, { handlers, ...(flags ? { flags } : {}) });
          return drained.more;
        }),
        reconciler('iam.reconcile', [{ key: 'identities', every: '5m' }], async (store) => {
          if (!host?.store) return false;
          await reconcileIamIdentities(store, { readIdentity, handlers });
          return false;
        }),
        reconciler('iam.usage', [{ key: 'usage', every: '1h' }], async (store) => {
          if (!port) return false;
          return (await flushUsageWindows(store, port)).more;
        }),
      ],
      selfCheck,
    }),
    start: (context) => bridge.bind(context),
    stop: () => bridge.stop(),
  };

  let port: EmbeddedIam | undefined;

  const bridge: ComputeIamBridge = {
    catalog,
    typePrefix: catalog.typePrefix,
    projection,
    get flags() {
      return flags;
    },
    get bound() {
      return sql !== undefined;
    },
    plugin(pluginOptions = {}) {
      const plugin = computeIamPlugin({
        ...pluginOptions,
        catalog,
        inbox: pluginOptions.inbox ?? bridge.localInbox(),
      });
      plugins.push(plugin);
      return plugin;
    },
    localInbox: () => ({
      put: async (events) => sqlInbox(requireSql()).put(events),
    }),
    resolveResource: (hostFallback) =>
      computeResolver(projection, {
        typePrefix: catalog.typePrefix,
        rootTenantId: () => rootTenantId,
        ...(hostFallback ? { hostFallback } : {}),
      }),
    embedded(iam, embeddedOptions = {}) {
      if (port) throw new ComputeError('INVALID_STATE', 'bridge.embedded() was already called');
      host = iam;
      rootTenantId = embeddedOptions.rootTenantId ?? rootTenantId;
      flags =
        embeddedOptions.flags ??
        createFlagCache({
          isEnabled: (tenantId, key) => iam.features.isEnabled(tenantId, key),
          ...(embeddedOptions.clock ? { clock: embeddedOptions.clock } : {}),
          ...(embeddedOptions.flagTtlMs === undefined ? {} : { ttlMs: embeddedOptions.flagTtlMs }),
        });
      const { runIamJobs, ...portOptions } = embeddedOptions;
      if (runIamJobs) {
        const jobsHost = iam as unknown as Partial<IamJobsHost>;
        if (
          typeof jobsHost.events?.dispatch !== 'function' ||
          typeof jobsHost.auth?.dispatchOutbox !== 'function' ||
          typeof jobsHost.billing?.checkBudgets !== 'function' ||
          typeof jobsHost.billing?.closePeriod !== 'function' ||
          typeof jobsHost.sweepExpired !== 'function'
        )
          throw new ComputeError(
            'INVALID_CONFIG',
            'runIamJobs needs a betterIam() instance (events, auth, billing, sweepExpired)',
          );
        module.reconcilers!.push(
          ...iamJobReconcilers(jobsHost as IamJobsHost, runIamJobs === true ? {} : runIamJobs),
        );
      }
      port = embeddedIam(iam, {
        ...portOptions,
        ...(rootTenantId === undefined ? {} : { rootTenantId }),
        flags,
        successorOf:
          embeddedOptions.successorOf ??
          ((tenantId, identityId) =>
            sql ? successorLookup(sql)(tenantId, identityId) : Promise.resolve(undefined)),
      });
      return port;
    },
    modules: [module],
    plugins: [],
    async bind(context) {
      if (sql === context.sql && projection.ready) return;
      sql = context.sql;
      projection.stop();
      projection.setSource(sqlProjectionSource(context.sql));
      await projection.start();
      await Promise.all(plugins.map((plugin) => plugin.flush()));
    },
    async stop() {
      projection.stop();
    },
    setHandlers(next) {
      handlers = next;
    },
  };
  return bridge;
}
