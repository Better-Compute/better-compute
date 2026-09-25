import type { Migration } from '@better-compute/core';

/**
 * The approver set each daemon enforces (PLAN.md §13; review 10 M5, asked by [f85da7]): the gateway writes
 * `Hello.approver_set_epoch`/`approver_set_sha256` (18/19) and `StatusReport` 10/11 next to `trust_version`
 * (core/0023), and `doctor` reads them to find daemons on another set than the published one. Both NULL until a
 * daemon reports them (one without the quorum, or from before it). No length check on the digest: a session write
 * never fails over what a daemon reported (write NULL for an empty one). Additive.
 */
export const sessionApproverSetMigration: Migration = {
  name: 'core/0026_session_approver_set',
  sql: `
ALTER TABLE node_sessions ADD COLUMN approver_set_epoch numeric(20, 0) CHECK (approver_set_epoch >= 0);
ALTER TABLE node_sessions ADD COLUMN approver_set_sha256 bytea;
`,
};
