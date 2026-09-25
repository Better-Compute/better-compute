import { afterEach, describe, expect, it } from 'vitest';
import {
  assertInvariants,
  createControlPlaneSim,
  type ControlPlaneSim,
} from '@better-compute/testing';

// PLAN.md §15 I4: "no liveness false positives, including under gateway clock skew". Gateways flush heartbeat ages,
// never their own timestamps (§7.5), so a gateway whose clock is off by more than the 40 s lease TTL must not make
// a live node look dead. Two of three real gateways run 90 s ahead and 90 s behind; the database and the daemons
// keep sim time. Nodes join, hold sessions, run commands, and re-home onto the skewed gateways when the one with the
// right time dies.

const MIN = 60_000;

let rig: ControlPlaneSim | undefined;
afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

async function connectivity(r: ControlPlaneSim) {
  const { rows } = await r.database.query<{ connectivity: string; count: number }>(
    `SELECT connectivity, count(*)::int AS count FROM nodes GROUP BY connectivity ORDER BY connectivity`,
  );
  return Object.fromEntries(rows.map((row) => [row.connectivity, Number(row.count)]));
}

async function unreachableMarks(r: ControlPlaneSim) {
  const { rows } = await r.database.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM outbox WHERE topic = 'node.unreachable'`,
  );
  return Number(rows[0]?.count ?? 0);
}

describe('gateway clock skew (§15 I4)', () => {
  it('marks no live node unreachable when gateways run 90 s ahead and behind', async () => {
    rig = await createControlPlaneSim({
      seed: 'clock-skew',
      nodes: 9,
      gateways: 3,
      gatewayClockSkewMs: [90_000, -90_000, 0],
    });
    const r = rig;
    const seen = new Set<string>();
    const watch = async (ms: number) => {
      for (let waited = 0; waited < ms; waited += 1_000) {
        await r.run(1_000);
        for (const state of Object.keys(await connectivity(r))) seen.add(state);
      }
    };
    await watch(3 * MIN);
    expect(await connectivity(r)).toEqual({ connected: 9 });
    // Every gateway, skewed or not, holds sessions.
    const homes = new Set(r.nodes.map(({ nodeId }) => r.homeOf(nodeId)));
    expect(homes.size).toBe(3);

    // Commands dispatch and settle through all of them.
    const ids: string[] = [];
    for (const { nodeId } of r.nodes) {
      const command = await r.api(() =>
        r.compute.api.commands.run({ token: r.tenants.root.token }, {
          tenantId: r.tenants.root.id,
          nodeId,
          kind: 'diag.nvml',
          idempotencyKey: `skew-${nodeId}`,
        } as never),
      );
      ids.push(command.id);
    }
    await watch(MIN);
    const { rows } = await r.database.query<{ state: string }>(
      'SELECT state FROM commands WHERE id = ANY($1::text[])',
      [ids],
    );
    expect(rows.map((row) => row.state)).toEqual(ids.map(() => 'succeeded'));

    // The gateway with the right time dies: its nodes move onto the skewed ones.
    const moved = r.killGateway(2);
    expect(moved.length).toBeGreaterThan(0);
    await watch(3 * MIN);
    expect(await connectivity(r)).toEqual({ connected: 9 });
    expect(moved.every((nodeId) => [0, 1].includes(r.homeOf(nodeId)!))).toBe(true);

    expect(seen.has('unreachable')).toBe(false);
    expect(await unreachableMarks(r)).toBe(0);
    assertInvariants(await r.invariants());
  }, 600_000);
});
