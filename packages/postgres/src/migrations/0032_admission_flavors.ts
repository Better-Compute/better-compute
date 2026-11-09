import type { Migration } from '@better-compute/core';

/**
 * (U-02, admission for every caller) Flavor allowlists. `pool_offers.flavors` names the flavors a tenant may create
 * (and attach machines of) on the offered pool; `quota_usage.flavors` names the flavors that may consume one quota
 * row. NULL allows every flavor, as before. Tenant-level (cross-pool) quota rows need no column: they are
 * `quota_usage` rows whose `pool_id` is `*`.
 *
 * Safe on a populated table: `ADD COLUMN` with no default is a catalog change only.
 */
export const admissionFlavorsMigration: Migration = {
  name: 'core/0032_admission_flavors',
  sql: `
ALTER TABLE pool_offers ADD COLUMN flavors text[];
ALTER TABLE quota_usage ADD COLUMN flavors text[];
`,
};
