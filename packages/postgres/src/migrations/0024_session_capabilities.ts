import type { Migration } from '@better-compute/core';

/**
 * What the daemon of the current session can do (`Hello.capabilities`, PLAN.md §7.6), written by the
 * gateway on Hello. First reader: `tunnels.open` refuses instance tcp/ssh tunnels unless the node
 * advertises `tunnel.instance-dial` (it dials the instance's address, not the host's loopback;
 * security review, asked by [402c97]). Additive.
 */
export const sessionCapabilitiesMigration: Migration = {
  name: 'core/0024_session_capabilities',
  sql: `ALTER TABLE node_sessions ADD COLUMN capabilities text[] NOT NULL DEFAULT '{}';`,
};
