/**
 * Hardware inventory for better-compute (PLAN.md §10.1): GPU naming (`normalizeGpuProduct`, the
 * versioned `gpuModels` table), section verification and snapshot digests, diffs, devices and
 * atoms, GFD-style labels, `hardware_key`, the v0.1 conditions, and the always-on
 * `inventoryModule`.
 */
export * from './gpu-models.js';
export * from './conditions.js';
export * from './sections.js';
export * from './devices.js';
export * from './labels.js';
export * from './hardware-key.js';
export * from './diff.js';
export * from './store.js';
export * from './health.js';
export * from './image-cache.js';
export * from './hygiene.js';
export * from './pressure.js';
export * from './module.js';

/** NodeInventory v1 and its sections, as the daemon reports them (`agent/v1/inventory.proto`). */
export type {
  BmcSection,
  CpuSection,
  DisksSection,
  Gpu,
  GpusSection,
  InventorySection,
  InventorySectionContent,
  InventorySectionName,
  MemorySection,
  NicsSection,
  NodeInventory,
  OsSection,
  SystemSection,
} from '@better-compute/protocol';
