import { afterEach, describe, expect, it } from 'vitest';
import { createDevStack, DEV_ROOT_TOKEN, type DevStack } from '@better-compute/testing';

// The `better-compute dev` stack in one process (PLAN.md §14 "Dev", §3.3): simulated machines join through
// the gateway's Join RPC with sealed tokens, open Session streams, pass diag.nvml, and are adopted by the real
// runtime loops on the wall clock; a reservation then binds on them through NodeSpec and AllocationBound.

let stack: DevStack | undefined;
afterEach(async () => {
  await stack?.close();
  stack = undefined;
});

describe('createDevStack', () => {
  it('joins simulated machines end to end and adopts them', { timeout: 60_000 }, async () => {
    stack = await createDevStack();
    const { poolId } = await stack.createPool();
    const nodes = await stack.join({ poolId, count: 3, seed: 'dev-test' });
    expect(nodes).toHaveLength(3);
    expect(new Set(nodes).size).toBe(3);
    await stack.waitFor(nodes, { timeoutMs: 45_000 });

    const api = stack.compute.api as any;
    const listed = await api.nodes.list(stack.root, { tenantId: stack.rootTenantId });
    expect(listed.items.map((node: { id: string }) => node.id).sort()).toEqual([...nodes].sort());
    for (const node of listed.items)
      expect(node).toMatchObject({ provisionState: 'adopted', connectivity: 'connected' });
    // Each machine reported its 8 GPUs through inventory.
    const { rows } = await stack.database.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM devices WHERE node_id = ANY($1) AND class = 'gpu'`,
      [nodes],
    );
    expect(rows[0]!.count).toBe(24);
    expect(
      stack.gateway
        .sessions()
        .map((session) => session.nodeId)
        .sort(),
    ).toEqual([...nodes].sort());
    expect(stack.pins.joinEncryptionJwk).toMatchObject({ kty: 'EC', crv: 'P-256' });
    expect(stack.pins.joinEncryptionJwk).not.toHaveProperty('d');

    // Place → active: the booking binds through NodeSpec, the daemon writes its CDI spec and reports
    // AllocationBound through the gateway's report hook.
    await api.pools.offer(stack.root, {
      tenantId: stack.rootTenantId,
      poolId,
      toTenantId: stack.rootTenantId,
      quota: { gpu: 16 },
    });
    const reservation = await api.reservations.create(stack.root, {
      tenantId: stack.rootTenantId,
      poolId,
      devices: [{ class: 'gpu', count: 4 }],
      duration: '1h',
      idempotencyKey: 'dev-test-reservation',
    });
    // Placed inline, or pending until the reservation reconciler places it.
    expect(['pending', 'placed']).toContain(reservation.state);
    const deadline = Date.now() + 20_000;
    let active: any;
    for (;;) {
      active = await api.reservations.get(stack.root, {
        tenantId: stack.rootTenantId,
        reservationId: reservation.id,
      });
      if (active.state === 'active' || Date.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(active).toMatchObject({ state: 'active' });
    expect(active.binding.cdiDevices).toHaveLength(4);
    // The bound node's daemon wrote the allocation's CDI spec and env file.
    expect(stack.daemons.get(active.binding.nodeId)!.files.size).toBeGreaterThan(0);
  });

  it('serves the root token over the HTTP handler', async () => {
    stack = await createDevStack();
    const { origin, basePath } = stack.compute.endpoint;
    const response = await stack.compute.handler(
      new Request(`${origin}${basePath}/system/whoami`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${DEV_ROOT_TOKEN}`,
          'content-type': 'application/json',
          'x-better-compute': '1',
        },
        body: '{}',
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { tenantId: stack.rootTenantId } });
  });
});
