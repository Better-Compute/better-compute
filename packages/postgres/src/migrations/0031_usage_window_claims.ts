import type { Migration } from '@better-compute/core';

/**
 * (billing, D18) A usage flush claims its batch before sending it to better-iam: `claimed_at` is set by a short
 * committed statement, and `usage.void` refuses a window claimed within the claim TTL (10 minutes), so root is never
 * told a window was voided while the flush was billing it. A claim older than the TTL belongs to a dead sender: the
 * next flush takes it over (better-iam knows the idempotency key, so a resend is a duplicate).
 *
 * It is a separate column because `recorded_at` means "handed to the sink" and retention prunes recorded rows.
 *
 * Safe on a populated, partitioned table: `ADD COLUMN` with no default is a catalog change, so no partition is
 * rewritten and nothing is scanned.
 */
export const usageWindowClaimsMigration: Migration = {
  name: 'core/0031_usage_window_claims',
  sql: `
ALTER TABLE usage_windows ADD COLUMN claimed_at timestamptz;
`,
};
