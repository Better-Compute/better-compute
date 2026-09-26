import type { ProvisionVerb } from '@better-compute/core';

/**
 * The methods of the `metal` API group (§9.2). All are authorized as `compute:nodes:provision`
 * (`enroll` and `bulk` on the pool, the others on the node), except `power` (`compute:nodes:power`).
 */
export const metalVerbs = [
  'enroll',
  'manage',
  'inspect',
  'provide',
  'deploy',
  'undeploy',
  'rescue',
  'unrescue',
  'abort',
  'recover',
  'retire',
  'power',
  // (v1.0 §13) Another verb on many nodes of one pool, as one destructive-command batch.
  'bulk',
  // (v1.0) Binds the PXE MAC of a machine enrolled without MACs (PXE discovery proposes it).
  'confirmMac',
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
    // Applied by the metal reconciler once the unrescue workflow brought the OS back.
    unrescue: 'unrescue',
    abort: 'abort',
    recover: 'recover',
    retire: 'retire',
    power: null,
    // Applies the verb it names to each node.
    bulk: null,
    // Changes only the node's MACs.
    confirmMac: null,
  });
