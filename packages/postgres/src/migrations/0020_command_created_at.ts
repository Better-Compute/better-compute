import type { Migration } from '@better-compute/core';

/**
 * Command latency (PLAN.md §14 `command_latency_seconds`; asked by [31c64a]): `commands.created_at`
 * is when the command was enqueued, so `updated_at - created_at` of a settled command is its
 * end-to-end latency. Existing rows take their earliest known time (`not_before` defaults to the
 * enqueue time). `commands_settled` serves "terminal commands settled since T". Additive.
 */
export const commandCreatedAtMigration: Migration = {
  name: 'core/0020_command_created_at',
  sql: `
ALTER TABLE commands ADD COLUMN created_at timestamptz;
UPDATE commands SET created_at = LEAST(not_before, updated_at);
ALTER TABLE commands ALTER COLUMN created_at SET DEFAULT compute_now(), ALTER COLUMN created_at SET NOT NULL;
CREATE INDEX commands_settled ON commands (updated_at)
  WHERE state IN ('succeeded', 'failed', 'rejected', 'expired', 'cancelled');
`,
};
