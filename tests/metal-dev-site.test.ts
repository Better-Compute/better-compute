import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentRole } from '@better-compute/protocol';
import { createDevStack, type DevStack } from '@better-compute/testing';

// Site agents on the dev stack (PLAN.md §3.3 step 0): `siteTokens.create` mints a role-site token,
// the agent joins through the real gateway's Join RPC and JoinService, gets a `site` certificate, and
// holds a session as a site-role FakeDaemon: the base for running metal on FakeDaemons.

let stack: DevStack;

beforeAll(async () => {
  stack = await createDevStack();
}, 60_000);
afterAll(() => stack?.close());

const until = async <T>(read: () => Promise<T | undefined>, timeoutMs = 30_000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

describe('joinSite', () => {
  it('enrolls site agents with role site on the site, no pool, a site certificate and a live session', async () => {
    const { siteId } = await stack.createPool({ key: 'site-agents' });
    const agents = await stack.joinSite({ siteId, count: 2 });
    expect(agents).toHaveLength(2);
    for (const agent of agents) {
      const node = await until(async () => {
        const { rows } = await stack.database.query<{ role: string; site_id: string; pool_id: string | null }>(
          `SELECT n.role, n.site_id, n.pool_id FROM nodes n JOIN node_sessions s ON s.node_id = n.id
            WHERE n.id = $1 AND s.connected_at IS NOT NULL AND (s.disconnected_at IS NULL OR s.connected_at > s.disconnected_at)`,
          [agent],
        );
        return rows[0];
      });
      expect(node).toEqual({ role: 'site', site_id: siteId, pool_id: null });
      const certs = await stack.database.query<{ role: string }>('SELECT role FROM node_certs WHERE node_id = $1 AND revoked_at IS NULL', [agent]);
      expect(certs.rows.map((row) => row.role)).toEqual(['site']);
      expect(stack.daemons.get(agent)!.role).toBe(AgentRole.SITE);
    }
    // The token was single-purpose: role site, this site, used up.
    const { rows } = await stack.database.query<{ role: string; uses_left: number }>(
      `SELECT role, uses_left FROM join_tokens WHERE site_id = $1 AND role = 'site'`,
      [siteId],
    );
    expect(rows).toEqual([{ role: 'site', uses_left: 0 }]);
  }, 60_000);
});
