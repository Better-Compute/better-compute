import type { Migration } from '@better-compute/core';

/**
 * Join tokens for bcd hosted by someone else's platform (PLAN.md §3.8, [595a2f] decision (A)): `kubernetes`
 * marks a token a bcd DaemonSet joins a customer cluster's nodes with. JoinService lands such a join at trust
 * `tenant-controlled` unless the token's pool has `policy.kubernetes.platformOperated`: the token decides,
 * never the node, and it only ever lowers trust. NULL for every other token. Additive; asked by [d320b8].
 */
export const joinTokenHostedMigration: Migration = {
  name: 'core/0027_join_token_hosted',
  sql: `ALTER TABLE join_tokens ADD COLUMN hosted text CHECK (hosted IN ('kubernetes'));`,
};
