import type { Migration } from '@better-compute/core';

/**
 * `pools.archive` (PLAN.md §9.2, v0.2): an archived pool is unoffered, refuses new reservations and
 * instances and is skipped by placement, while live bookings run out. NULL means active. Additive.
 */
export const poolArchiveMigration: Migration = {
  name: 'core/0006_pool_archive',
  sql: `ALTER TABLE pools ADD COLUMN archived_at timestamptz;`,
};
