import type { Migration } from '@better-compute/core';

/**
 * (billing, D16) Offer budget policies over the API, and `suspend`.
 *
 * - `pool_offers.suspended_at`: set when the offer's `onBudgetExceeded: 'suspend'` fires (or an operator suspends the
 *   offer); while set, the tenant's new work on the pool is refused with `SPEND_LIMIT_REACHED`. Only
 *   `pools.updateOffer({ suspended: false })` clears it.
 * - The `on_budget_exceeded` CHECK (core/0003, auto-named) is widened to include `suspend`. `pool_offers` holds one
 *   row per (pool, tenant), so replacing the constraint rescans a handful of rows.
 */
export const offerSuspensionMigration: Migration = {
  name: 'core/0030_offer_suspension',
  sql: `
ALTER TABLE pool_offers ADD COLUMN suspended_at timestamptz;
ALTER TABLE pool_offers DROP CONSTRAINT pool_offers_on_budget_exceeded_check;
ALTER TABLE pool_offers
  ADD CONSTRAINT pool_offers_on_budget_exceeded_check
    CHECK (on_budget_exceeded IN ('notify', 'stop-new', 'drain', 'suspend'));
`,
};
