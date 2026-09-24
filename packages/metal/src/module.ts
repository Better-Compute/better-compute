import { notImplemented, type ComputeModule, type NodeDriverBindings } from '@better-compute/core';

/** Per-concern driver bindings that nodes of a pool inherit (`pool.policy.hardwareProfile`). */
export interface HardwareProfile {
  description?: string;
  /** e.g. `{ power: 'redfish', management: 'redfish', boot: 'ipxe', deploy: 'image-stream' }`. */
  drivers: NodeDriverBindings;
}

/** Options of `metal()`. */
export interface MetalOptions {
  /** Hardware profiles by name. */
  hardwareProfiles?: Record<string, HardwareProfile>;
}

/**
 * The bare-metal module: enrollment, inspection, commissioning, deploy, release and rescue through
 * the `metal` API group, built on the provision workflow engine (§3.5, §11.1). Injected by the
 * application (`betterCompute({ modules: [metal({ hardwareProfiles })] })`); the server never
 * imports it.
 *
 * @throws `NOT_IMPLEMENTED` until v0.2.
 */
export function metal(options?: MetalOptions): ComputeModule<'metal'> {
  throw notImplemented('bare-metal provisioning', 'v0.2');
}
