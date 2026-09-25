import type { Migration } from '@better-compute/core';

/**
 * The `images` inventory section (agent/v1 `NodeInventory.images`, PLAN.md §10.3): stored section
 * bytes may now name it. The check is replaced whole, so it still lists every section exactly.
 */
export const inventoryImagesMigration: Migration = {
  name: 'core/0015_inventory_images',
  sql: `
ALTER TABLE node_inventory_sections DROP CONSTRAINT node_inventory_sections_section_check;
ALTER TABLE node_inventory_sections ADD CONSTRAINT node_inventory_sections_section_check
  CHECK (section IN ('system', 'cpu', 'memory', 'disks', 'nics', 'gpus', 'bmc', 'os', 'images'));
`,
};
