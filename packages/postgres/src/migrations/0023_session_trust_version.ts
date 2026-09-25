import type { Migration } from '@better-compute/core';

/**
 * The trust bundle version each daemon has applied (PLAN.md §13 "command/spec signing ... rotated via
 * the `Welcome` trust bundle: new key first, switch after 100% ack"; asked by [f85da7] for [402c97]'s
 * command-root switch). The gateway writes `Hello.trust_version` / `StatusReport.trust_version`
 * (c85e68d); `pki rotate-command-root --stage switch` waits for `min(trust_version)` over connected
 * sessions. Additive.
 */
export const sessionTrustVersionMigration: Migration = {
  name: 'core/0023_session_trust_version',
  sql: `ALTER TABLE node_sessions ADD COLUMN trust_version bigint NOT NULL DEFAULT 0 CHECK (trust_version >= 0);`,
};
