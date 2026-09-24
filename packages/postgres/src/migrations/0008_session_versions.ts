import type { Migration } from '@better-compute/core';

/**
 * What the daemon last announced in Hello (PLAN.md §6, v0.4 Rollout): its version, which marks a
 * node upgraded, and the highest protocol version it speaks, for the UPGRADE_REQUIRED path. Both
 * are written by the gateway on Hello. Additive.
 */
export const sessionVersionsMigration: Migration = {
  name: 'core/0008_session_versions',
  sql: `
ALTER TABLE node_sessions
  ADD COLUMN daemon_version text,
  ADD COLUMN proto_max integer CHECK (proto_max > 0);
`,
};
