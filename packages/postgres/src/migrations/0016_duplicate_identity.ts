import type { Migration } from '@better-compute/core';

/**
 * The duplicate-identity quarantine (PLAN.md §7.2): a second live Hello with another boot_id wins
 * and raises DuplicateIdentity; more than 3 alternations in 10 minutes quarantine the certificate.
 * The gateway's Hello transaction counts alternations in the session row it already locks: it sets
 * `duplicate_since` and `duplicate_hellos = 1` when the window is unset or older than 10 minutes,
 * else adds one. Gateway-owned; additive.
 */
export const duplicateIdentityMigration: Migration = {
  name: 'core/0016_duplicate_identity',
  sql: `
ALTER TABLE node_sessions
  ADD COLUMN duplicate_hellos integer NOT NULL DEFAULT 0 CHECK (duplicate_hellos >= 0),
  ADD COLUMN duplicate_since timestamptz;
`,
};
