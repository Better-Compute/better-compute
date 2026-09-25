import { afterEach, describe, expect, it } from 'vitest';
import { signBatchApproval } from '@better-compute/pki';
import { assertInvariants, createControlPlaneSim, type ControlPlaneSim } from '@better-compute/testing';

// PLAN.md §13, the v1.0 destructive-batch quorum, on the real control plane and two gateways under the
// fleet simulator, with every daemon enforcing signed intent and the quorum (as bcd does):
// - an unbatched destructive command is refused at enqueue (no unbatched allowance);
// - batch members are held, never dispatched before an approval, across a gateway kill and redials;
// - an approval releases them; each leaf runs exactly once, also after a daemon restart;
// - cancel and expiry end the held members, which never run;
// - a command outside the scope, and a batch over nodes the tenant does not own, are refused.
// Times are simulated.

const MIN = 60_000;

let rig: ControlPlaneSim | undefined;
afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

describe('§13 destructive-batch quorum under the simulator', () => {
  it('holds, releases once, and ends batches; nothing destructive runs unapproved', { timeout: 600_000 }, async () => {
    rig = await createControlPlaneSim({ seed: 'v10-quorum', nodes: 4, gateways: 2, approvers: { count: 2, threshold: 1 } });
    const sim = rig;
    await sim.run(3 * MIN);
    const root = { token: sim.tenants.root.token };
    const tenantId = sim.tenants.root.id;
    const api = sim.compute.api as any;
    const nodes = sim.nodes.map((node) => node.nodeId);
    let key = 0;
    const reboot = (nodeId: string, batchId?: string) =>
      sim.api(() =>
        api.commands.run(root, { tenantId, nodeId, kind: 'node.reboot', idempotencyKey: `quorum-${++key}`, ...(batchId ? { batchId } : {}) }),
      ) as Promise<{ id: string }>;
    const createBatch = (subjects: string[], extra: Record<string, unknown> = {}) =>
      sim.api(() =>
        api.commandBatches.create(root, {
          tenantId,
          reason: 'reboot rack 7',
          scope: subjects.map((subject) => ({ subject, kind: 'node.reboot' })),
          idempotencyKey: `quorum-batch-${++key}`,
          ...extra,
        }),
      ) as Promise<{ batchId: string; state: string; requiredApprovals: number }>;
    const approve = async (batchId: string) => {
      const view = await sim.api(() => api.commandBatches.get(root, { tenantId, batchId }));
      const sig = signBatchApproval(
        {
          batchId: view.batchId,
          scopeRoot: new Uint8Array(Buffer.from(view.scopeRoot, 'hex')),
          scopeSize: view.scopeSize,
          notAfter: view.notAfter,
          trustDomain: view.trustDomain,
        },
        sim.approvers!.keys[0]!.privateKey,
      );
      await sim.api(() => api.commandBatches.approve(root, { tenantId, batchId, signature: { kid: sig.kid, sig: Buffer.from(sig.sig).toString('base64url') } }));
    };
    const state = async (id: string) =>
      (await sim.database.query<{ state: string }>('SELECT state FROM commands WHERE id = $1', [id])).rows[0]!.state;
    const ran = (nodeId: string, id: string) => sim.sim.daemon(nodeId).executions.get(id) ?? 0;

    // No unbatched allowance: a destructive command without a batch never enters the queue.
    await expect(reboot(nodes[0]!)).rejects.toMatchObject({ code: 'INVALID_STATE', details: { reason: 'batch-required' } });

    // A batch over two nodes: its members are held, through a gateway kill and the redials it causes.
    const a = await createBatch([nodes[0]!, nodes[1]!]);
    expect(a).toMatchObject({ state: 'pending', requiredApprovals: 1 });
    const held = [await reboot(nodes[0]!, a.batchId), await reboot(nodes[1]!, a.batchId)];
    // Outside the scope: refused, even under a valid batch.
    await expect(reboot(nodes[2]!, a.batchId)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await sim.run(MIN);
    sim.killGateway(0);
    await sim.run(30_000);
    sim.reviveGateway(0);
    await sim.run(2 * MIN);
    for (const [index, command] of held.entries()) {
      expect(await state(command.id)).toBe('pending');
      expect(ran(nodes[index]!, command.id)).toBe(0);
    }

    // One approval (threshold 1) releases both; each runs once, and not again after a daemon restart.
    const boots = held.map((_, index) => sim.sim.daemon(nodes[index]!).bootId);
    await approve(a.batchId);
    for (let waited = 0; waited < 5 * MIN; waited += 10_000) {
      if ((await Promise.all(held.map((command) => state(command.id)))).every((s) => s === 'succeeded')) break;
      await sim.run(10_000);
    }
    for (const [index, command] of held.entries()) {
      expect(await state(command.id)).toBe('succeeded');
      expect(ran(nodes[index]!, command.id)).toBe(1);
      expect(sim.sim.daemon(nodes[index]!).bootId).not.toBe(boots[index]);
    }
    sim.sim.crash(nodes[0]!, 5_000);
    await sim.run(2 * MIN);
    expect(ran(nodes[0]!, held[0]!.id)).toBe(1);

    // Cancel: the held member ends cancelled and never runs; the batch admits nothing more.
    const c = await createBatch([nodes[2]!, nodes[3]!]);
    const cancelled = await reboot(nodes[2]!, c.batchId);
    await sim.api(() => api.commandBatches.cancel(root, { tenantId, batchId: c.batchId }));
    await sim.run(MIN);
    expect(await state(cancelled.id)).toBe('cancelled');
    expect(ran(nodes[2]!, cancelled.id)).toBe(0);
    await expect(reboot(nodes[3]!, c.batchId)).rejects.toMatchObject({ code: 'INVALID_STATE' });

    // Expiry: a batch nobody approves in time ends its held member, which never runs.
    const d = await createBatch([nodes[3]!], { notAfterSeconds: 120 });
    const expiring = await reboot(nodes[3]!, d.batchId);
    await sim.run(6 * MIN);
    expect(['cancelled', 'expired']).toContain(await state(expiring.id));
    expect(ran(nodes[3]!, expiring.id)).toBe(0);

    // A batch over another tenant's nodes cannot be made.
    await expect(
      sim.api(() =>
        api.commandBatches.create(
          { token: sim.tenants.acme.token },
          { tenantId: sim.tenants.acme.id, reason: 'x', scope: [{ subject: nodes[0], kind: 'node.reboot' }], idempotencyKey: 'quorum-foreign' },
        ),
      ),
    ).rejects.toMatchObject({ code: expect.stringMatching(/NOT_FOUND|ACCESS_DENIED|INVALID_INPUT/) });

    // Across everything: no destructive command ran without its batch's approval.
    for (const nodeId of nodes)
      for (const [id] of sim.sim.daemon(nodeId).executions)
        if (![held[0]!.id, held[1]!.id].includes(id)) {
          const { rows } = await sim.database.query<{ kind: string }>('SELECT kind FROM commands WHERE id = $1', [id]);
          expect(rows[0]?.kind, `${id} ran on ${nodeId}`).not.toBe('node.reboot');
        }
    assertInvariants(await sim.invariants());
  });
});
