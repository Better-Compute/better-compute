import type { NodeDriverBindings } from '@better-compute/core';

/** Per-concern driver bindings that nodes of a pool inherit (`pool.policy.hardwareProfile`). */
export interface HardwareProfile {
  description?: string;
  /** e.g. `{ power: 'redfish', management: 'redfish', boot: 'ipxe', deploy: 'image-stream' }`. */
  drivers: NodeDriverBindings;
}
