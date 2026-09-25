import type { NodeDriverBindings } from '@better-compute/core';
import type { RaidVolume } from './kinds.js';

/** Per-concern driver bindings that nodes of a pool inherit (`pool.policy.hardwareProfile`). */
export interface HardwareProfile {
  description?: string;
  /** e.g. `{ power: 'redfish', management: 'redfish', boot: 'ipxe', deploy: 'image-stream' }`. */
  drivers: NodeDriverBindings;
  /**
   * BIOS settings every machine of the profile must have (Redfish attribute names and values).
   * Commissioning applies them (`bios.apply`, effective on the next boot) and checks them after
   * (`bios.verify`). DRAFT until v0.5.
   */
  bios?: Readonly<Record<string, string>>;
  /** The RAID layout commissioning builds (`raid.apply`, before the wipe). DRAFT until v0.5. */
  raid?: { volumes: readonly RaidVolume[] };
}
