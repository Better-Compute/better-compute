/**
 * Provisioning for better-compute (PLAN.md §11): `defineStep` and `defineProfile`, the workflow
 * engine (`provisionModule()`, the Workflow reconciler, `ctx.workflows`), the built-in wait steps,
 * stored profiles, and the `profiles` and `workflows` API groups. The step, profile and workflow
 * contracts are declared in `@better-compute/core` and re-exported here.
 */
export { defineStep, stepRelays, type RelayingStepDefinition, type StepInputWithRelays } from './step.js';
export { defineProfile } from './profile.js';
export * from './module.js';
export * from './expand.js';
export {
  StepNotReady,
  abortWorkflow,
  advanceWorkflow,
  commandKey,
  pauseWorkflow,
  reconcileWorkflows,
  resumeWorkflow,
  retryWorkflow,
  siteAgentFor,
  startWorkflow,
  stepNotReady,
  workflowPollMs,
  workflowWorkKind,
  type AdvanceOptions,
  type AdvanceResult,
  type EngineContext,
  type EngineOptions,
  type ProfileSource,
  type StartWorkflowInput,
} from './engine.js';
export { builtinSteps, waitAgentJoined, waitGenerationObserved } from './builtin-steps.js';
export { builtinProfileTenant, createProfile, deleteProfile, profileSource, updateProfile } from './profiles.js';
export { provisionMigrations } from './migrations.js';
export * from './images.js';
export * from './command-step.js';
export * from './remediation.js';
export * from './renderers.js';
export * from './config-units.js';
export type * from './api.js';
export { provisionApi } from './api.js';

export type {
  ProfileDocument,
  ProfileStep,
  StepContext,
  StepDefinition,
  StepInput,
  StepState,
  Workflow,
  WorkflowEngine,
  WorkflowState,
  WorkflowStep,
} from '@better-compute/core';
