/**
 * Hardware inventory for better-compute (PLAN.md §10.1): GPU naming (`normalizeGpuProduct`, the
 * versioned `gpuModels` table), node condition types, and the always-on `inventoryModule`.
 * Section hashing, diffs, labels and the Inventory controller arrive in v0.1.
 */
export * from './gpu-models.js';
export * from './conditions.js';
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
