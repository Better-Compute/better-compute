import { afterEach, describe, expect, it } from 'vitest';
import {
  assertInvariants,
  createControlPlaneSim,
  summarize,
  type ControlPlaneSim,
} from '@better-compute/testing';

// The v0.4 exit in simulation (PLAN.md §7, §15, §16 "gateway-kill recovery"): three real gateways behind the
// fleet simulator, the real control plane behind them. A gateway dies mid-command: its nodes re-home to the
// others, nothing runs twice (I2), and bookings and billing stay whole (I1, I8). A stalled gateway comes back as
// a zombie holding sessions its nodes have left: the session epoch fences its routing and liveness writes.

const MIN = 60_000;

let rig: ControlPlaneSim | undefined;
afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

async function sessionRows(rig: ControlPlaneSim, nodeIds: readonly string[]) {
  const { rows } = await rig.database.query<{
    node_id: string;
    gateway_id: string | null;
    session_epoch: number;
  }>(
    'SELECT node_id, gateway_id, session_epoch FROM node_sessions WHERE node_id = ANY($1::text[])',
    [nodeIds],
  );
  return new Map(rows.map((row) => [row.node_id, row]));
}

async function runCommands(
  rig: ControlPlaneSim,
  nodeIds: readonly string[],
  kind: string,
  tag: string,
) {
  const ids: string[] = [];
  for (const nodeId of nodeIds) {
    const command = await rig.api(() =>
      rig.compute.api.commands.run({ token: rig.tenants.root.token }, {
        tenantId: rig.tenants.root.id,
        nodeId,
        kind,
        ...(kind === 'inventory.refresh' ? { payload: { sections: ['gpus'] } } : {}),
        idempotencyKey: `${tag}-${nodeId}`,
      } as never),
    );
    ids.push(command.id);
  }
  return ids;
}

async function states(rig: ControlPlaneSim, ids: readonly string[]) {
  const { rows } = await rig.database.query<{ state: string }>(
    'SELECT state FROM commands WHERE id = ANY($1::text[])',
    [ids],
  );
  return rows.map((row) => row.state);
}

describe('three gateways under the fleet simulator', () => {
  it('re-homes a killed gateway’s nodes mid-command with no duplicate execution', async () => {
    rig = await createControlPlaneSim({ seed: 'multi-gateway-kill', nodes: 9, gateways: 3 });
    await rig.run(3 * MIN);
    const homes = rig.nodes.map(({ nodeId }) => rig!.homeOf(nodeId));
    expect(homes.every((home) => home !== undefined)).toBe(true);
    expect(new Set(homes).size).toBe(3);
    const adopted = await rig.database.query(
      `SELECT 1 FROM nodes WHERE provision_state = 'adopted' AND observed_generation >= 1`,
    );
    expect(adopted.rowCount).toBe(9);

    // Every node starts a 2-second diag.nvml; gateway 0 dies once they are running.
    const commands = await runCommands(
      rig,
      rig.nodes.map((node) => node.nodeId),
      'diag.nvml',
      'kill',
    );
    await rig.run(1_000);
    const killedId = rig.gateways[0]!.id;
    const moved = rig.killGateway(0);
    expect(moved.length).toBeGreaterThan(0);
    const killedAt = rig.sim.scheduler.now();
    const rehomed = new Map<string, number>();
    while (rehomed.size < moved.length && rig.sim.scheduler.now() - killedAt < 2 * MIN) {
      await rig.run(250);
      for (const nodeId of moved) {
        const home = rig.homeOf(nodeId);
        if (!rehomed.has(nodeId) && home !== undefined && home !== 0)
          rehomed.set(nodeId, rig.sim.scheduler.now() - killedAt);
      }
    }
    expect(rehomed.size).toBe(moved.length);
    const rehome = summarize([...rehomed.values()]);
    expect(rehome.p99).toBeLessThan(60_000);

    await rig.run(2 * MIN);
    expect(
      (await states(rig, commands)).every((state) => state === 'succeeded' || state === 'failed'),
    ).toBe(true);
    const sessions = await sessionRows(rig, moved);
    for (const nodeId of moved) expect(sessions.get(nodeId)!.gateway_id).not.toBe(killedId);
    // Nothing ran twice, no booking overlaps, connectivity never released anything.
    assertInvariants(await rig.invariants());
    console.log(`re-home after a gateway kill: ${JSON.stringify(rehome)} (${moved.length} nodes)`);
  }, 600_000);

  it('fences a zombie gateway that resumes with sessions its nodes have left', async () => {
    rig = await createControlPlaneSim({ seed: 'multi-gateway-zombie', nodes: 9, gateways: 3 });
    await rig.run(3 * MIN);
    const zombieId = rig.gateways[1]!.id;
    const stranded = rig.nodes
      .map((node) => node.nodeId)
      .filter((nodeId) => rig!.homeOf(nodeId) === 1);
    expect(stranded.length).toBeGreaterThan(0);

    // Gateway 1 pauses; its nodes lose their connection while it still believes it holds the sessions.
    rig.stallGateway(1, true);
    for (const nodeId of stranded) rig.sim.halfOpen(nodeId, 'agent');
    await rig.run(30_000);
    const after = await sessionRows(rig, stranded);
    for (const nodeId of stranded) {
      expect(rig.homeOf(nodeId) === 0 || rig.homeOf(nodeId) === 2).toBe(true);
      expect(after.get(nodeId)!.gateway_id).not.toBe(zombieId);
    }
    expect(rig.gateways[1]!.sessions().some((session) => stranded.includes(session.nodeId))).toBe(
      true,
    );

    // The zombie resumes: its lease, dispatch and liveness jobs run against sessions that are gone.
    rig.stallGateway(1, false);
    const commands = await runCommands(rig, stranded, 'inventory.refresh', 'zombie');
    await rig.run(2 * MIN);
    const fenced = await sessionRows(rig, stranded);
    for (const nodeId of stranded) {
      expect(fenced.get(nodeId)!.gateway_id).not.toBe(zombieId);
      expect(Number(fenced.get(nodeId)!.session_epoch)).toBeGreaterThanOrEqual(
        Number(after.get(nodeId)!.session_epoch),
      );
    }
    // The zombie routed nothing: every command reached its node through the node's live session.
    expect(await states(rig, commands)).toEqual(commands.map(() => 'succeeded'));
    assertInvariants(await rig.invariants());
  }, 600_000);
});
