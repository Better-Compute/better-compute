import type { ProvisionVerb } from '@better-compute/core';

/**
 * The methods of the `metal` API group (§9.2). All are authorized as `compute:nodes:provision`
 * (`enroll` on the pool, the others on the node), except `power` (`compute:nodes:power`).
 */
export const metalVerbs = [
  'enroll',
  'manage',
  'inspect',
  'provide',
  'deploy',
  'undeploy',
  'rescue',
  'abort',
  'recover',
  'retire',
  'power',
] as const;
export type MetalVerb = (typeof metalVerbs)[number];

/**
 * The verb of core's `provisionStateTable` each method applies. `enroll` creates the node in
 * `enrolling`, an initial state; `undeploy` is `release` (wipe, then `ready`); `power` changes only
 * the power axis, which is separate from the provision state.
 */
export const metalVerbTransitions: Readonly<Record<MetalVerb, ProvisionVerb | null>> =
  Object.freeze({
    enroll: null,
    manage: 'manage',
    inspect: 'inspect',
    provide: 'provide',
    deploy: 'deploy',
    undeploy: 'release',
    rescue: 'rescue',
    abort: 'abort',
    recover: 'recover',
    retire: 'retire',
    power: null,
  });
