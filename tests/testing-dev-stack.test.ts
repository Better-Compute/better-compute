import { afterEach, describe, expect, it } from 'vitest';
import { create } from '@bufbuild/protobuf';
import { TunnelFrameSchema } from '@better-compute/protocol';
import {
  attachDevFleet,
  createDevJoinKeys,
  createDevStack,
  DEV_ROOT_TOKEN,
  type DevStack,
} from '@better-compute/testing';

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

  it('does not adopt a machine that fails diag.nvml acceptance', { timeout: 60_000 }, async () => {
    stack = await createDevStack();
    // HGX boards have 8 GPUs; acceptance checks the count, not just what the machine reports.
    const { poolId } = await stack.createPool({ expectGpuCount: 8 });
    const [good] = await stack.join({ poolId, seed: 'dev-good' });
    const [bad] = await stack.join({ poolId, variant: 'hgx-h100-gpu-missing', seed: 'dev-bad' });
    await stack.waitFor([good!], { timeoutMs: 45_000 });
    // The healthy machine is adopted; the one with a GPU gone ran diag.nvml and did not pass.
    const deadline = Date.now() + 30_000;
    let diag: { state: string }[] = [];
    while (Date.now() < deadline) {
      diag = (
        await stack.database.query<{ state: string }>(
          `SELECT state FROM commands WHERE node_id = $1 AND kind = 'diag.nvml'`,
          [bad],
        )
      ).rows;
      if (diag.some((row) => !['pending', 'dispatched', 'accepted', 'running'].includes(row.state)))
        break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(diag.length).toBeGreaterThan(0);
    const { rows } = await stack.database.query<{ provision_state: string }>(
      'SELECT provision_state FROM nodes WHERE id = $1',
      [bad],
    );
    expect(rows[0]!.provision_state).not.toBe('adopted');
  });

  it(
    'drops a node within 5 s of nodes.revokeIdentity, and keeps it out',
    { timeout: 60_000 },
    async () => {
      stack = await createDevStack();
      const { poolId } = await stack.createPool();
      const [nodeId] = await stack.join({ poolId, seed: 'dev-revoke' });
      await stack.waitFor([nodeId!], { timeoutMs: 45_000 });
      const connected = () =>
        stack!.gateway.sessions().some((session) => session.nodeId === nodeId);
      expect(connected()).toBe(true);
      const api = stack.compute.api as any;
      const revokedAt = Date.now();
      await api.nodes.revokeIdentity(stack.root, {
        tenantId: stack.rootTenantId,
        nodeId,
        reason: 'key-compromise',
      });
      // The revocation feed carries node_certs.revoked_at to the gateway, which closes the session.
      while (connected() && Date.now() - revokedAt < 5_000)
        await new Promise((resolve) => setTimeout(resolve, 25));
      expect(connected()).toBe(false);
      expect(Date.now() - revokedAt).toBeLessThan(5_000);
      // The daemon redials; the revoked certificate is refused at every open.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(connected()).toBe(false);
    },
  );

  it(
    'opens a console tunnel to a simulated node and echoes through it',
    { timeout: 60_000 },
    async () => {
      stack = await createDevStack();
      const { poolId } = await stack.createPool();
      const [nodeId] = await stack.join({ poolId, seed: 'dev-tunnel' });
      await stack.waitFor([nodeId!], { timeoutMs: 45_000 });
      const api = stack.compute.api as any;
      // tunnels.open: the decision, and a single-use ticket for this node (sid = tunnelId).
      const opened = await api.tunnels.open(stack.root, {
        tenantId: stack.rootTenantId,
        nodeId,
        op: 'console',
      });
      expect(opened).toMatchObject({ nodeId, op: 'console', path: `tunnels/${opened.ticket}` });
      const gatewayId = stack.gateway.id;
      // The api's relay: the gateway's control API, then the node's Tunnel stream (the daemon re-verifies).
      const tunnel = await stack.tunnelRelay!.open({
        ticket: opened.ticket,
        nodeId: nodeId!,
        tunnelId: opened.tunnelId,
        gatewayId,
      });
      const decoder = new TextDecoder();
      let text = '';
      const reading = (async () => {
        for await (const frame of tunnel.frames) {
          if (frame.body.case === 'data') text += decoder.decode(frame.body.value);
          if (frame.body.case === 'closed') break;
        }
      })();
      const until = async (needle: string) => {
        const deadline = Date.now() + 15_000;
        while (!text.includes(needle) && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 20));
        expect(text).toContain(needle);
      };
      // The shell's banner, sent with `opened` in one tick, is held until the gateway's 200 (aa3f948).
      await until(`fake console on ${nodeId}`);
      tunnel.send(
        create(TunnelFrameSchema, {
          tunnelId: opened.tunnelId,
          body: { case: 'data', value: new TextEncoder().encode('hello\r') },
        }),
      );
      await until('echo: hello');
      tunnel.send(
        create(TunnelFrameSchema, {
          tunnelId: opened.tunnelId,
          body: { case: 'data', value: new TextEncoder().encode('exit\r') },
        }),
      );
      await Promise.race([reading, new Promise((resolve) => setTimeout(resolve, 5_000))]);
      tunnel.close();
      expect(stack.daemons.get(nodeId!)!.tunnelOutcomes).toContainEqual(
        expect.objectContaining({ opened: true, tunnelId: opened.tunnelId }),
      );
    },
  );

  it('attaches a fleet only with insecureHeaderAuth: true', async () => {
    stack = await createDevStack();
    await expect(
      attachDevFleet({
        compute: stack.compute,
        database: stack.database,
        keys: createDevJoinKeys(),
        root: stack.root,
        rootTenantId: stack.rootTenantId,
      } as unknown as Parameters<typeof attachDevFleet>[0]),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
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
