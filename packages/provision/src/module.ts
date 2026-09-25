import {
  defineModule,
  type CommandKindSpec,
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
import { driverInvokeKind, stepRegistry } from './expand.js';
import { provisionMigrations } from './migrations.js';
import type { ImageSignatureVerifier } from './images.js';
import { profileSource } from './profiles.js';
import { userDataStep, type UserDataOptions } from './renderers.js';
import { builtinConfigUnits, provisionNodeSpec, type ConfigUnitDefinition } from './config-units.js';
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
  /** User data rendering (`userdata.render`): templates and where the installed bcd joins. */
  userData?: UserDataOptions;
  /** Config units besides the built-ins (nvidia-driver, container-toolkit, mig-layout, fabric-manager, sysctl). */
  configUnits?: readonly ConfigUnitDefinition[];
  /** How `images.register` checks signatures (default: Ed25519/P-256 keys in `image_signers`). */
  imageVerifier?: ImageSignatureVerifier;
}

/**
 * `driver.invoke` (§5.1, §5.5): one driver operation of a driver the agent hosts (built into bcd,
 * or a bcx plugin), sent by the engine for profile steps that name a driver operation. Driver
 * operations include power and deploy, so the kind is destructive (always signed) and never
 * retried blindly; each step's own timeout overrides `notAfter`.
 */
export const driverInvokeCommandKind: CommandKindSpec = Object.freeze({
  kind: driverInvokeKind,
  lane: 'provision',
  retrySafe: false,
  destructive: true,
  timeout: '10m',
  roles: ['node', 'site', 'ramdisk'],
  payload: Object.freeze({ kind: 'message', typeName: 'bettercompute.agent.v1.DriverInvokeRequest' }),
} satisfies CommandKindSpec);

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
    userDataStep(options.userData),
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

  // The engine resolves every step and profile, but provision registers only its own: the modules
  // passed in register theirs themselves, and the registry refuses an extension registered twice.
  const borrowed = new Set<unknown>(fromModules);
  const borrowedProfiles = new Set<unknown>((options.modules ?? []).flatMap((module) => module.profiles ?? []));
  const module = defineModule({
    name: 'provision',
    migrations: [...provisionMigrations],
    extensions: steps.list().filter((step) => !borrowed.has(step)),
    profiles: moduleProfiles.filter((profile) => !borrowedProfiles.has(profile)),
    nodeSpec: provisionNodeSpec(
      [...builtinConfigUnits, ...(options.configUnits ?? [])],
      options.imageVerifier ? { verifier: options.imageVerifier } : undefined,
    ),
    commandKinds: [driverInvokeCommandKind],
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
    api: (context: ModuleContext) =>
      provisionApi(context, { ...engineOptions, moduleProfiles, ...(options.imageVerifier ? { imageVerifier: options.imageVerifier } : {}) }),
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
