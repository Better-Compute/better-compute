import type { Migration } from '@better-compute/core';

/**
 * A command remembers a fingerprint of the request that queued it, so a retry with the same idempotency key
 * is told apart from a different request reusing the key: the kind alone was compared, and a second request
 * with another payload was answered with the first command as if it had been queued.
 *
 * Nullable: commands from before this, and callers that pass no fingerprint, compare by kind as before.
 * `ADD COLUMN` with no default is a catalog change; nothing is rewritten or scanned.
 */
export const commandRequestHashMigration: Migration = {
  name: 'core/0061_command_request_hash',
  sql: `
ALTER TABLE commands ADD COLUMN request_hash bytea;
`,
};
