/**
 * better-compute: the control plane factory, configuration, errors and the extension helpers
 * (PLAN.md §4.4). This entry loads only `@better-compute/server` and `@better-compute/core`;
 * everything else is a subpath (`better-compute/postgres`, `better-compute/metal`, …) that an
 * application imports and passes in.
 */
export { betterCompute, configOptions, defineConfig } from '@better-compute/server';
export type {
  BetterCompute,
  ComputeApi,
  ComputeConfigContext,
  ComputeConfigFactory,
  ComputeOptions,
  SelfCheckReport,
  WorkerRole,
} from '@better-compute/server';
export {
  ComputeError,
  defineAttestor,
  defineDriver,
  defineModule,
  definePlugin,
  defineSchedulerPlugin,
  defineSink,
  field,
  manifest,
} from '@better-compute/core';
export type {
  ApiGroups,
  AttestorVerifier,
  AttestorVerifierInput,
  AuditSink,
  ComputeErrorBody,
  ComputeModule,
  ComputePlugin,
  ConfigManifest,
  DriverContext,
  DriverDefinition,
  DriverInput,
  DriverKinds,
  ErrorCode,
  EventSink,
  Field,
  FieldShape,
  Manifest,
  MethodContext,
  MethodDefinition,
  ModuleContext,
  SchedulerPlugin,
  SchedulerPluginInput,
  SecretRef,
  Sink,
  UsageSink,
} from '@better-compute/core';
