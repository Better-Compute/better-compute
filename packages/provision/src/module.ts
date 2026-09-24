import {
  defineModule,
  type ComputeModule,
  type ModuleContext,
  type ProfileDocument,
  type ReconcileContext,
  type Reconciler,
  type StepDefinition,
  type WorkflowEngine,
} from '@better-compute/core';
import { provisionApi, type ProvisionApi } from './api.js';
import { builtinSteps } from './builtin-steps.js';
import {
  abortWorkflow,
  reconcileWorkflows,
  startWorkflow,
  workflowWorkKind,
  type EngineContext,
  type EngineOptions,
} from './engine.js';
import { stepRegistry } from './expand.js';
import { provisionMigrations } from './migrations.js';
import { profileSource } from './profiles.js';
import {
  defaultRemediationPolicy,
  healthWorkKind,
  reconcileHealth,
  remediationProfiles,
  remediationSteps,
  type RemediationPolicy,
} from './remediation.js';

export interface ProvisionOptions {
  /** Steps profiles may `use`, besides the built-ins (`wait.agentJoined`, `wait.generationObserved`). */
  steps?: readonly StepDefinition[];
  /** Profiles every tenant can start, besides stored ones (read-only; `profiles.list` shows them). */
  profiles?: readonly ProfileDocument[];
  /** Leave out the built-in steps. */
  builtinSteps?: false;
  /**
   * Modules whose steps (`extensions` of kind `step`) and `profiles` the engine should know, e.g.
   * `provisionModule({ modules: [metalModule] })`.
   */
  modules?: readonly Pick<ComputeModule, 'extensions' | 'profiles'>[];
  /**
   * Health remediation (§10.1): the `health` reconciler with its reboot and GPU-reset workflows,
   * on by default. `false` leaves it out; an object tunes the budget and the circuit breaker.
   */
  remediation?: false | Partial<RemediationPolicy>;
}

/** The provision module, plus the `WorkflowEngine` the host puts on `ModuleContext.workflows`. */
export interface ProvisionModule extends ComputeModule<'provision', ProvisionApi> {
  /** The engine behind `ctx.workflows` (`start` in the caller's transaction, `abort`). */
  workflowEngine(context: Pick<ModuleContext, 'work' | 'events' | 'commands'>): WorkflowEngine;
  /** What the engine resolves steps and profiles with. */
  readonly engineOptions: EngineOptions;
}

/**
 * The provision module (PLAN.md §11.2): the workflow engine and its tables, the Workflow
 * reconciler (sharded by node), and the `profiles` and `workflows` API groups. Injected by the
 * application; the server never imports it.
 *
 * ```ts
 * const provision = provisionModule({ steps: [renderAutoinstallIso], profiles: [ubuntuGpuHost] });
 * const compute = betterCompute({ modules: [provision, metal()], ... });
 * ```
 */
export function provisionModule(options: ProvisionOptions = {}): ProvisionModule {
  const fromModules = (options.modules ?? []).flatMap((module) =>
    (module.extensions ?? []).filter((extension): extension is StepDefinition => extension.extension === 'step'),
  );
  const remediation = options.remediation === false ? undefined : { ...defaultRemediationPolicy, ...options.remediation };
  const steps = stepRegistry([
    ...(options.builtinSteps === false ? [] : builtinSteps),
    ...(remediation ? remediationSteps : []),
    ...fromModules,
    ...(options.steps ?? []),
  ]);
  const moduleProfiles = [
    ...(remediation ? remediationProfiles : []),
    ...(options.modules ?? []).flatMap((module) => module.profiles ?? []),
    ...(options.profiles ?? []),
  ];
  const engineOptions: EngineOptions = { steps, profiles: profileSource(moduleProfiles) };

  const reconciler: Reconciler = {
    name: workflowWorkKind,
    shardBy: 'node',
    run: (context: ReconcileContext, key: string) =>
      reconcileWorkflows(context, { ...engineOptions, signal: context.signal, stepContext: context }, key),
  };

  const module = defineModule({
    name: 'provision',
    migrations: [...provisionMigrations],
    extensions: steps.list(),
    profiles: moduleProfiles,
    reconcilers: remediation
      ? [
          reconciler,
          {
            name: healthWorkKind,
            shardBy: 'node' as const,
            async run(context: ReconcileContext, nodeId: string) {
              await reconcileHealth(context, nodeId, remediation);
              return 'DONE' as const;
            },
          },
        ]
      : [reconciler],
    api: (context: ModuleContext) => provisionApi(context, { ...engineOptions, moduleProfiles }),
  });

  return Object.freeze({
    ...module,
    engineOptions,
    workflowEngine(context: EngineContext): WorkflowEngine {
      return {
        start: (tx, input) => startWorkflow(context, engineOptions, tx, input),
        abort: (tx, workflowId) => abortWorkflow(context, tx, workflowId),
      };
    },
  }) as ProvisionModule;
}
