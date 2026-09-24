import type { Migration } from '@better-compute/core';

/**
 * Cancelling a command after dispatch (PLAN.md §7.4 "Cancel"). The api sets `cancel_requested_at`
 * when a caller cancels an in-flight command (a pending one goes straight to `cancelled`); the
 * gateway re-sends `Cancel{id, reason}` to the live session on every dispatch tick and after every
 * reconnect until the daemon reports a terminal state. Additive only.
 */
export const commandCancelMigration: Migration = {
  name: 'core/0004_command_cancel',
  sql: `
ALTER TABLE commands
  ADD COLUMN cancel_requested_at timestamptz,
  ADD COLUMN cancel_reason text;
CREATE INDEX commands_cancel_pending ON commands (node_id)
  WHERE cancel_requested_at IS NOT NULL AND state IN ('dispatched', 'acked', 'running');
`,
};
