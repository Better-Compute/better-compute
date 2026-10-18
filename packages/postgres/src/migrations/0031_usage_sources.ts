import type { Migration } from '@better-compute/core';

/**
 * (billing, D2) Usage windows from typed sources: an allocation (as before), a provider instance, a reservation
 * grant, a network, a snapshot, or a pass-through cost. The one `iam.usage` flush records them all.
 *
 * - `allocation_id` becomes nullable; `source_kind` (default `allocation`) and `source_id` name the source. Legacy
 *   rows keep `source_id` NULL (their source is `allocation_id`); there is no backfill, and allocation windows keep
 *   their unique key `(allocation_id, window_start, meter)` and their idempotency keys.
 * - `usage_windows_source` makes `(source_kind, source_id, window_start, meter)` unique. It has no WHERE clause:
 *   legacy rows have `source_id` NULL, and NULLs never collide.
 * - `voided_at`/`void_reason`: a voided window is never flushed (root voids, later).
 * - `cost_micros`: a reported cost (pass-through), sent to better-iam as `cost` in currency units.
 *
 * Safe on a populated, partitioned table: `DROP NOT NULL` and `ADD COLUMN` with a constant default (or none)
 * change the catalog only, so no partition is rewritten. The CHECKs scan each partition once, and the index is
 * built per partition through the parent.
 */
export const usageSourcesMigration: Migration = {
  name: 'core/0031_usage_sources',
  sql: `
ALTER TABLE usage_windows ALTER COLUMN allocation_id DROP NOT NULL;
ALTER TABLE usage_windows ADD COLUMN source_kind text NOT NULL DEFAULT 'allocation'
  CHECK (source_kind IN ('allocation', 'instance', 'grant', 'network', 'snapshot', 'cost'));
ALTER TABLE usage_windows ADD COLUMN source_id text;
ALTER TABLE usage_windows ADD COLUMN voided_at timestamptz;
ALTER TABLE usage_windows ADD COLUMN void_reason text;
ALTER TABLE usage_windows ADD COLUMN cost_micros bigint;
ALTER TABLE usage_windows ADD CONSTRAINT usage_windows_source_ck
  CHECK ((source_kind = 'allocation' AND allocation_id IS NOT NULL)
      OR (source_kind <> 'allocation' AND source_id IS NOT NULL));
CREATE UNIQUE INDEX usage_windows_source ON usage_windows (source_kind, source_id, window_start, meter);
`,
};
