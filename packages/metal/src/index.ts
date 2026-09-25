/**
 * Bare metal for better-compute (PLAN.md §3.5, §11): the driver kinds `power` … `firmware`, merged
 * into `DriverKinds` of `@better-compute/core` by importing this package; the `metal` verbs and
 * API group; the metal reconciler, steps, profiles and command kinds; and `metal()`.
 */
export * from './kinds.js';
export * from './verbs.js';
export * from './module.js';
export * from './api.js';
export * from './commands.js';
export * from './migrations.js';
export * from './profiles.js';
export * from './reconcile.js';
export * from './steps.js';
export * from './http-proxy.js';
export * from './results.js';
export * from './attestation.js';
export * from './tenant-root.js';
export * from './findings.js';
export * from './tenancy.js';
export { applyProvisionVerb, readMetalNode, resolveDriverBindings, type MetalNodeRow } from './store.js';

export type { PowerAction, PowerState, WipeMode } from '@better-compute/core';
