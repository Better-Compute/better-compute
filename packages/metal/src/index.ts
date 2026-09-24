/**
 * Bare metal for better-compute (PLAN.md §3.5, §11): the driver kinds `power` … `firmware`, merged
 * into `DriverKinds` of `@better-compute/core` by importing this package; the `metal` verbs; and
 * `metal()`, whose lifecycle arrives in v0.2.
 */
export * from './kinds.js';
export * from './verbs.js';
export * from './module.js';

export type { PowerAction, PowerState, WipeMode } from '@better-compute/core';
