/**
 * Provisioning for better-compute (PLAN.md §11): `defineStep` and `defineProfile`, which are
 * implemented, and `provisionModule()`, whose workflow engine arrives in v0.2. The step, profile
 * and workflow contracts are declared in `@better-compute/core` and re-exported here.
 */
export { defineStep } from './step.js';
export { defineProfile } from './profile.js';
export { provisionModule } from './module.js';

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
