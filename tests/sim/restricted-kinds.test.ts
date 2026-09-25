import { afterEach, describe, expect, it } from 'vitest';
import { isComputeError } from '@better-compute/core';
import {
  assertInvariants,
  createControlPlaneSim,
  type ControlPlaneSim,
} from '@better-compute/testing';

// A certificate's allowed kinds (PLAN.md §3.3, §13: an attestor may restrict what a node's certificate allows)
// under the fleet simulator: a node admitted with `diag.*` and `inventory.*` passes acceptance and runs those,
// while any other kind is refused before it is queued, and the node never executes it.

let rig: ControlPlaneSim | undefined;
afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

describe('restricted command kinds', () => {
  it('runs allowed kinds on a restricted node and refuses the rest at enqueue', async () => {
    rig = await createControlPlaneSim({
      seed: 'restricted-kinds',
      nodes: 3,
      restricted: { count: 1, allowedKinds: ['diag.*', 'inventory.*'] },
    });
    await rig.run(3 * 60_000);
    const restricted = rig.nodes.at(-1)!.nodeId;
    const certs = await rig.database.query<{ allowed_kinds: string[] | null }>(
      'SELECT allowed_kinds FROM node_certs WHERE node_id = $1',
      [restricted],
    );
    expect(certs.rows[0]?.allowed_kinds).toEqual(['diag.*', 'inventory.*']);
    const node = await rig.database.query<{ provision_state: string }>(
      'SELECT provision_state FROM nodes WHERE id = $1',
      [restricted],
    );
    expect(node.rows[0]?.provision_state).toBe('adopted');

    const root = { token: rig.tenants.root.token };
    const run = (nodeId: string, kind: string, key: string) =>
      rig!.api(() =>
        rig!.compute.api.commands.run(root, {
          tenantId: rig!.tenants.root.id,
          nodeId,
          kind,
          ...(kind === 'inventory.refresh' ? { payload: { sections: ['gpus'] } } : {}),
          idempotencyKey: key,
        } as never),
      );
    const allowed = await run(restricted, 'inventory.refresh', 'allowed');
    await expect(run(restricted, 'logs.collect', 'refused')).rejects.toSatisfy((error: unknown) =>
      isComputeError(error),
    );
    // An unrestricted node takes the same kind.
    const other = await run(rig.nodes[0]!.nodeId, 'logs.collect', 'other');
    await rig.run(60_000);
    const states = await rig.database.query<{ id: string; state: string }>(
      'SELECT id, state FROM commands WHERE id = ANY($1::text[])',
      [[allowed.id, other.id]],
    );
    const stateOf = new Map(states.rows.map((row) => [row.id, row.state]));
    expect(stateOf.get(allowed.id)).toBe('succeeded');
    // Queued and executed (its outcome is the fake's business): never refused for its kind.
    expect(['succeeded', 'failed']).toContain(stateOf.get(other.id));
    const leaked = await rig.database.query(
      `SELECT 1 FROM commands WHERE node_id = $1 AND kind NOT LIKE 'diag.%' AND kind NOT LIKE 'inventory.%'`,
      [restricted],
    );
    expect(leaked.rowCount).toBe(0);
    assertInvariants(await rig.invariants());
  }, 300_000);
});
