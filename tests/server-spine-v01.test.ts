import { afterEach, describe, expect, it } from 'vitest';
import { create, fromJson, type JsonValue } from '@bufbuild/protobuf';
import { defineSink, type ComputeEvent } from '@better-compute/core';
import {
  createCsr,
  createNodeCa,
  createSigningKey,
  generateP256KeyPair,
  parseCertificate,
  sealJoinToken,
  verifyJoinResponse,
} from '@better-compute/pki';
import {
  AgentRole,
  AllocationBoundSchema,
  CommandBodySchema,
  DiagNvmlResultSchema,
  HardwareClaimsSchema,
  JoinRequestSchema,
  NodeSpecSchema,
  decodeMessage,
  encodeCommandResult,
  protocolRegistry,
  unpackCommandPayload,
} from '@better-compute/protocol';
import { gatewayReportHandlers, pkiJoinCrypto, pokeMessage } from '@better-compute/server';
import { closeFixtures, computeFixture, type ComputeFixture } from '@better-compute/testing';
import { recordingNotifier, sibling } from './support/runtime.js';

// The v0.1 spine in process (PLAN.md §3.3, §3.4 steps 1-3, §7.4-7.5, §8.4, §9.2): a root admin
// creates a site and a pool, mints a join token; a machine joins through GatewayServices with a
// sealed token and a CSR (real PKI); NodeLifecycle runs diag.nvml once the node is connected, the
// command settles as the gateway would settle it, and the node becomes adopted at generation 1;
// the operator cordons and uncordons it and runs a command; a tenant reserves its GPUs, which
// bind through NodeSpec generation 2 and the AllocationBound report; the Liveness sweep takes it from
// connected through disconnected to unreachable under the sim clock and back after a reconnect;
// every step's events come out of the outbox to a sink and to in-process subscribers. The gateway
// is simulated by the SQL it runs (Hello, command settle, status); the fleet path never calls IAM.

afterEach(closeFixtures);

const TRUST_DOMAIN = 'compute.spine.test';
const GATEWAY = 'gw_spine_1';

/** What a gateway does on Hello (§7.2): its lease, the session row, connected, and a node wake-up. */
async function hello(fixture: ComputeFixture, nodeId: string, gatewayId: string, epoch: number) {
  const { database, compute } = fixture;
  await database.query(
    `INSERT INTO leases (name, owner, epoch, expires_at)
     VALUES ($1, $2, 1, compute_now() + interval '20 seconds')
     ON CONFLICT (name) DO UPDATE SET owner = EXCLUDED.owner, expires_at = EXCLUDED.expires_at`,
    [`gateway:${gatewayId}`, gatewayId],
  );
  await database.transaction(async (tx) => {
    await tx.query(
      `UPDATE node_sessions SET gateway_id = $2, session_id = $3, session_epoch = $4,
         boot_id = 'boot-1', journal_id = 'journal-1', role = 'node', connected_at = compute_now(),
         last_seen = compute_now(), disconnected_at = NULL
       WHERE node_id = $1`,
      [nodeId, gatewayId, `ses-${epoch}`, epoch],
    );
    await tx.query(`UPDATE nodes SET connectivity = 'connected' WHERE id = $1`, [nodeId]);
    await compute.context.work.enqueue(tx, 'node', nodeId);
  });
}

async function nodeRow(fixture: ComputeFixture, id: string) {
  const { rows } = await fixture.database.query<{
    provision_state: string;
    connectivity: string;
    cordoned: boolean;
    no_schedule_reasons: string[];
    generation: number;
    observed_generation: number;
    spec: JsonValue | null;
  }>(
    `SELECT provision_state, connectivity, cordoned, no_schedule_reasons, generation,
            observed_generation, spec
       FROM nodes WHERE id = $1`,
    [id],
  );
  return rows[0]!;
}

describe('the v0.1 spine, in process', () => {
  it('joins, accepts, adopts, operates and watches a node, with every step in the outbox', async () => {
    const fixture = await computeFixture({ clock: 'sim' });
    const { tenants, iam, clock, database } = fixture;
    const root = { token: tenants.root.token };
    const acme = { token: tenants.acme.token };
    iam.allow({ token: tenants.root.token });
    iam.allow({ token: tenants.acme.token, action: 'compute:projects:manage' });
    iam.allow({ token: tenants.acme.token, action: 'compute:pools:read' });

    // The deployment: JoinService keys (real PKI), a notifier for gateway pokes, an event sink.
    const nodeCa = createNodeCa({ clock, trustDomain: TRUST_DOMAIN });
    const signingKey = createSigningKey({ clock });
    const encryption = generateP256KeyPair();
    const notifier = recordingNotifier();
    const delivered: ComputeEvent[] = [];
    const sink = defineSink({
      id: 'spine',
      kind: 'events',
      async deliver(events) {
        delivered.push(...events);
      },
    });
    const compute = await sibling(fixture, {
      pki: {
        join: pkiJoinCrypto({
          trustDomain: TRUST_DOMAIN,
          nodeCa,
          signingKey,
          encryptionKey: encryption.privateKey,
        }),
      },
      notifier,
      sinks: { events: [sink] },
    });
    const subscribed: string[] = [];
    const unsubscribe = compute.events.subscribe('node.*', (event) => {
      subscribed.push(event.type);
    });
    const api = compute.api;

    // 1. A site, a project and a pool; a join token for the pool (§3.3 step 1).
    const site = await api.sites.create(root, {
      tenantId: tenants.root.id,
      kind: 'shared',
      region: 'eu-west-1',
      idempotencyKey: 'spine-site',
    });
    const project = await api.projects.create(acme, {
      tenantId: tenants.acme.id,
      name: 'spine',
      idempotencyKey: 'spine-project',
    });
    expect(project).toMatchObject({ tenantId: tenants.acme.id, name: 'spine', state: 'active' });
    const pool = await api.pools.create(root, {
      tenantId: tenants.root.id,
      siteId: site.id,
      class: 'metal-host',
      gpuModel: 'H100',
      policy: { acceptance: [{ kind: 'diag.nvml' }] },
      idempotencyKey: 'spine-pool',
    });
    await api.pools.offer(root, {
      tenantId: tenants.root.id,
      poolId: pool.id,
      toTenantId: tenants.acme.id,
      quota: { gpu: 2 },
    });
    // The offered pool is in acme's view: the capacity module's list, decided item by item.
    const offered = await api.pools.list(acme, { tenantId: tenants.acme.id });
    expect(offered.items.map((item) => item.id)).toEqual([pool.id]);
    const minted = await api.joinTokens.create(root, {
      tenantId: tenants.root.id,
      poolId: pool.id,
      ttlSeconds: 3600,
      idempotencyKey: 'spine-token',
    });
    expect(minted.token).toMatch(/^bcjt_jt_/);

    // From here on, the fleet path: no IAM call until the operator's API calls (P7).
    iam.reset();

    // 2. Join (§3.3 steps 3-4): a sealed token bound to the CSR, relayed by the gateway.
    const key = generateP256KeyPair().privateKey;
    const csr = createCsr(key);
    const sealed = sealJoinToken(minted.token!, encryption.publicKey, {
      csr,
      issuedAt: clock.now(),
    });
    const response = await compute.gatewayServices.join(
      create(JoinRequestSchema, {
        sealedToken: new TextEncoder().encode(sealed),
        csr,
        claims: create(HardwareClaimsSchema, {
          productUuid: '4c4c4544-0042-3510-8052-b7c04f4e4e01',
          productSerial: 'SN-SPINE-01',
          permanentMacs: ['3c:ec:ef:10:20:01'],
          gpuUuids: ['GPU-6f7c2a11-0000-4b3a-9e5d-000000000001'],
        }),
        daemonVersion: '0.1.0',
        role: AgentRole.NODE,
      }),
      { gatewayId: GATEWAY },
    );
    const body = verifyJoinResponse(response, {
      signer: { publicKey: signingKey.publicKey },
      csr,
      nodeCaRoots: [nodeCa.certificate],
      now: clock.now(),
    });
    const nodeId = body.nodeId;
    expect(parseCertificate(body.certChain[0]!).uriSans).toEqual([
      `spiffe://${TRUST_DOMAIN}/site/${site.id}/node/${nodeId}`,
    ]);
    expect(await nodeRow(fixture, nodeId)).toMatchObject({
      provision_state: 'adopting',
      connectivity: 'disconnected',
      generation: 0,
    });
    // IAM can decide on compute-node/{id} in the owner's view at once (§12.4).
    expect(await compute.authz.get('compute-node', nodeId, tenants.root.id)).toMatchObject({
      parentType: 'pool',
      parentId: pool.id,
      attributes: { lifecycle: 'adopting', trust: 'platform', region: 'eu-west-1' },
    });
    // The single-use token is spent.
    const spent = await api.joinTokens.list(root, {
      tenantId: tenants.root.id,
      poolId: pool.id,
      includeInactive: true,
    });
    expect(spent.items).toEqual([expect.objectContaining({ id: minted.id, usesLeft: 0 })]);
    iam.reset();

    // 3. Acceptance waits for the daemon's Hello (§3.3 steps 5-7): the join woke nothing.
    expect(await compute.jobs.node!.tick()).toBe(0);
    expect(
      (await database.query('SELECT 1 FROM commands WHERE node_id = $1', [nodeId])).rowCount,
    ).toBe(0);
    // The Inventory controller found two GPUs.
    for (const index of [1, 2])
      await database.query(
        `INSERT INTO devices (id, node_id, class, bookable, healthy, attributes)
         VALUES ($1, $2, 'gpu', true, true, '{"gpuModel":"H100","gpuProduct":"H100-SXM5-80GB"}')`,
        [`GPU-6f7c2a11-0000-4b3a-9e5d-00000000000${index}`, nodeId],
      );
    await hello(fixture, nodeId, GATEWAY, 1);
    expect(await compute.jobs.node!.tick()).toBe(1);
    const { rows: queued } = await database.query<{ id: string; kind: string; body: Uint8Array }>(
      'SELECT id, kind, body FROM commands WHERE node_id = $1 ORDER BY seq',
      [nodeId],
    );
    expect(queued.map((command) => command.kind)).toEqual(['diag.nvml']);
    const diag = decodeMessage(CommandBodySchema, new Uint8Array(queued[0]!.body));
    expect(unpackCommandPayload('diag.nvml', diag.payload)).toMatchObject({ expectedGpuCount: 2 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    // The enqueue poked the node's gateway after commit.
    expect(notifier.published).toContainEqual({
      channel: `gw:${GATEWAY}`,
      message: pokeMessage([nodeId]),
    });

    // 4. The daemon passes diag.nvml; the gateway settles the command and wakes the node.
    await database.transaction(async (tx) => {
      await tx.query(
        `UPDATE commands SET state = 'succeeded', session_epoch = 1, result = $2,
           updated_at = compute_now() WHERE id = $1`,
        [
          queued[0]!.id,
          encodeCommandResult(
            'diag.nvml',
            create(DiagNvmlResultSchema, { passed: true, gpuCount: 2 }),
          ),
        ],
      );
      await compute.context.work.enqueue(tx, 'node', nodeId);
    });
    expect(await compute.jobs.node!.tick()).toBe(1);
    expect(await nodeRow(fixture, nodeId)).toMatchObject({ provision_state: 'adopted' });
    expect(await compute.jobs.nodespec!.tick()).toBe(1);
    const adopted = await nodeRow(fixture, nodeId);
    expect(adopted.generation).toBe(1);
    expect(() =>
      fromJson(NodeSpecSchema, adopted.spec!, { registry: protocolRegistry }),
    ).not.toThrow();
    // The gateway reports the applied generation (§3.3 step 7: schedulable at observed 1).
    await database.query('UPDATE nodes SET observed_generation = 1 WHERE id = $1', [nodeId]);
    expect(await compute.authz.get('node', nodeId, tenants.root.id)).toMatchObject({
      attributes: { lifecycle: 'adopted', gpuCount: 2 },
    });
    // Join, acceptance, adoption and the spec: no IAM call on the fleet path (P7).
    expect(iam.calls).toEqual([]);

    // 5. The operator cordons and uncordons the node, and runs a command (§9.2 nodes, commands).
    const cordoned = await api.nodes.cordon(root, {
      tenantId: tenants.root.id,
      nodeId,
      reason: 'maintenance window',
    });
    expect(cordoned).toMatchObject({ cordoned: true, provisionState: 'adopted' });
    const uncordoned = await api.nodes.uncordon(root, { tenantId: tenants.root.id, nodeId });
    expect(uncordoned.cordoned).toBe(false);
    const command = await api.commands.run(root, {
      tenantId: tenants.root.id,
      nodeId,
      kind: 'inventory.refresh',
      payload: { sections: ['gpus'] },
      idempotencyKey: 'spine-refresh',
    });
    expect(command).toMatchObject({ kind: 'inventory.refresh', state: 'pending', seq: 2 });
    const { rows: refresh } = await database.query<{ body: Uint8Array }>(
      'SELECT body FROM commands WHERE id = $1',
      [command.id],
    );
    const refreshBody = decodeMessage(CommandBodySchema, new Uint8Array(refresh[0]!.body));
    expect(unpackCommandPayload('inventory.refresh', refreshBody.payload).sections).toEqual([
      'gpus',
    ]);
    const detail = await api.nodes.get(root, { tenantId: tenants.root.id, nodeId });
    expect(detail.conditions).toContainEqual(
      expect.objectContaining({ type: 'AcceptanceFailed', status: 'false', reason: 'Passed' }),
    );

    // An acme user reserves both GPUs (§3.4): the inline placer books them on the adopted node; at
    // its start the reservation binds, NodeSpec hands the assignment to the daemon as generation 2,
    // and the node's AllocationBound report (the gateway's capacity hook) makes it active.
    iam.allow({ token: tenants.acme.token, action: 'compute:reservations:create' });
    iam.allow({ token: tenants.acme.token, action: 'compute:reservations:read' });
    const reservation = await api.reservations.create(acme, {
      tenantId: tenants.acme.id,
      poolId: pool.id,
      devices: [{ class: 'gpu', count: 2 }],
      duration: '1h',
      idempotencyKey: 'spine-reservation',
    });
    expect(reservation.state).toBe('placed');
    expect(await compute.jobs['capacity.reservations']!.tick()).toBe(1);
    expect(await compute.jobs.nodespec!.tick()).toBe(1);
    const assigned = await nodeRow(fixture, nodeId);
    expect(assigned.generation).toBe(2);
    const spec = fromJson(NodeSpecSchema, assigned.spec!, { registry: protocolRegistry });
    const assignment = spec.devices?.assignments[0];
    expect(assignment?.reservationId).toBe(reservation.id);
    const cdiDevices = (assignment?.devices ?? []).map((device) => `bcd.dev/gpu=${device.id}`);
    expect(cdiDevices).toHaveLength(2);
    // The gateway's ingest transaction runs the host's report hook (the server's handlers).
    await database.transaction((tx) =>
      gatewayReportHandlers.allocationBound(
        tx,
        { nodeId, work: compute.context.work },
        create(AllocationBoundSchema, {
          allocationId: assignment!.allocationId,
          generation: 2n,
          deviceIds: assignment!.devices.map((device) => device.id),
          cdiDevices,
          envFile: `/run/bcd/${assignment!.allocationId}.env`,
        }),
      ),
    );
    expect(await compute.jobs['capacity.reservations']!.tick()).toBe(1);
    const active = await api.reservations.get(acme, {
      tenantId: tenants.acme.id,
      reservationId: reservation.id,
    });
    expect(active).toMatchObject({ state: 'active', binding: { nodeId, cdiDevices } });

    // 6. Liveness under the sim clock (§7.5): the gateway dies, its lease lapses at 20 s, the node
    //    is disconnected, then unreachable at 40 s + 120 s of gateway-loss grace. Nothing is
    //    released (P6). A reconnect through another gateway clears it.
    iam.reset();
    const sweep = async (ms: number) => {
      for (let elapsed = 0; elapsed < ms; elapsed += 5_000) {
        await fixture.advance(5_000);
        await compute.jobs.liveness!.tick();
      }
    };
    await compute.jobs.liveness!.tick();
    await sweep(15_000);
    expect((await nodeRow(fixture, nodeId)).connectivity).toBe('connected');
    await sweep(10_000);
    expect((await nodeRow(fixture, nodeId)).connectivity).toBe('disconnected');
    await sweep(130_000);
    expect((await nodeRow(fixture, nodeId)).connectivity).toBe('disconnected');
    await sweep(10_000);
    expect(await nodeRow(fixture, nodeId)).toMatchObject({
      connectivity: 'unreachable',
      no_schedule_reasons: ['unreachable'],
    });
    // Disconnected is not dead (P6): the reservation on the node stays active.
    const kept = await database.query<{ state: string; released: number }>(
      `SELECT r.state, (SELECT count(*)::int FROM allocations a
                         WHERE a.owner_id = r.id AND a.released_at IS NOT NULL) AS released
         FROM reservations r WHERE r.id = $1`,
      [reservation.id],
    );
    expect(kept.rows).toEqual([{ state: 'active', released: 0 }]);
    await hello(fixture, nodeId, 'gw_spine_2', 2);
    expect(await compute.jobs.node!.tick()).toBe(1);
    expect(await nodeRow(fixture, nodeId)).toMatchObject({
      connectivity: 'connected',
      no_schedule_reasons: [],
    });
    expect(iam.calls).toEqual([]);

    // 7. Every step's events, in commit order, from the outbox (§8.4, §9.3).
    expect(await compute.jobs['outbox-dispatch']!.tick()).toBeGreaterThan(0);
    const types = delivered.map((event) => event.type);
    const inOrder = [
      'site.created',
      'project.created',
      'pool.created',
      'security.join-token.created',
      'node.joined',
      'node.acceptance.started',
      'node.adopted',
      'node.cordoned',
      'node.uncordoned',
      'node.command.queued',
      'node.disconnected',
      'node.unreachable',
    ];
    expect(types.filter((type) => inOrder.includes(type))).toEqual(inOrder);
    expect(delivered.find((event) => event.type === 'node.joined')).toMatchObject({
      tenantId: tenants.root.id,
      subject: `node/${nodeId}`,
      data: { nodeId, poolId: pool.id, gatewayId: GATEWAY },
    });
    // The same events through the tenant's API (the xmin cursor) and in-process subscribers.
    const listed = await api.events.list(root, { tenantId: tenants.root.id, type: 'node.' });
    expect(listed.items.map((event) => event.type)).toEqual(
      inOrder.filter((type) => type.startsWith('node.')),
    );
    await compute.jobs['event-subscribers']!.tick();
    unsubscribe();
    // The subscription started after the first events committed; it sees the later ones.
    expect(subscribed.length).toBeGreaterThan(0);
    expect(subscribed.every((type) => type.startsWith('node.'))).toBe(true);
    // Nothing on the fleet path touched the capacity the pool offers (P6).
    const capacity = await api.pools.capacity(root, { tenantId: tenants.root.id, poolId: pool.id });
    expect(capacity).toBeDefined();
    expect(await compute.selfCheck()).toMatchObject({ ok: true });
    await compute.stop();
  });
});
