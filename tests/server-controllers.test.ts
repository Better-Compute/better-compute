import { afterEach, describe, expect, it } from 'vitest';
import { create, fromJson, type JsonValue } from '@bufbuild/protobuf';
import {
  defineModule,
  isComputeError,
  newId,
  shardOf,
  type DeviceAssignment,
  type ModuleContext,
} from '@better-compute/core';
import {
  CommandBodySchema,
  DiagNvmlResultSchema,
  NodeSpecSchema,
  decodeMessage,
  encodeCommandResult,
  protocolRegistry,
  unpackCommandPayload,
} from '@better-compute/protocol';
import {
  acceptanceCondition,
  markAcceptanceRequested,
  nodesModuleName,
  reconcileLifecycle,
  reconcileNode,
  reconcileNodeSpec,
  requestAcceptance,
  unreachableCondition,
} from '@better-compute/server';
import { closeFixtures, computeFixture, type ComputeFixture } from '@better-compute/testing';
import { recordingNotifier, sibling } from './support/runtime.js';

// The node controllers (PLAN.md §3.3 step 7, §7.3, §7.5, §8.4, §11.1): NodeLifecycle's acceptance,
// NodeSpec's generations and Liveness's transitions, stepped under the sim clock through
// compute.jobs and the reconciler functions, with the runtime's own command queue, work queue,
// CommandSweeper and outbox.

afterEach(closeFixtures);

const SITE = 'site_a';
const METAL = 'pool_metal';
const PROVIDER = 'pool_cloud';
const BARE = 'pool_bare';
const DCGM = 'pool_dcgm';
const VPS = 'pool_vps';
const VPS_KEPT = 'pool_vps_kept';
const GATEWAY = 'gw_1';

/** The contribution the test module's `nodeSpec()` hook returns. */
const contribution: { assignments: DeviceAssignment[]; driver: string } = {
  assignments: [],
  driver: '550',
};
const specModule = defineModule({
  name: 'spec-test',
  async nodeSpec() {
    return {
      host: { config: { 'nvidia-driver': { version: contribution.driver } } },
      devices: { assignments: contribution.assignments },
    };
  },
});

async function setup() {
  contribution.assignments = [];
  contribution.driver = '550';
  const fixture = await computeFixture({ clock: 'sim', modules: [specModule] });
  const { database, tenants } = fixture;
  await database.query(
    `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ($1, $2, 'shared', 'eu-1', 1)`,
    [SITE, tenants.root.id],
  );
  const pool = (id: string, klass: string, policy: object) =>
    database.query(
      `INSERT INTO pools (id, owner_tenant_id, site_id, class, gpu_model, sharing, agent, policy, version)
       VALUES ($1, $2, $3, $4, 'H100', 'exclusive', 'bcd', $5, 1)`,
      [id, tenants.root.id, SITE, klass, JSON.stringify(policy)],
    );
  await pool(METAL, 'metal-host', { acceptance: [{ kind: 'diag.nvml' }], lostAfter: '10m' });
  await pool(PROVIDER, 'provider', { acceptance: [], lostAfter: '10m' });
  await pool(BARE, 'metal-host', {});
  await pool(DCGM, 'metal-host', { acceptance: [{ kind: 'diag.dcgm' }] });
  await pool(VPS, 'vps-host', { acceptance: [], lostAfter: '10m' });
  await pool(VPS_KEPT, 'vps-host', { acceptance: [] });
  await gatewayLease(fixture, GATEWAY, 20_000);
  return fixture;
}

async function gatewayLease(fixture: ComputeFixture, id: string, ttlMs: number) {
  await fixture.database.query(
    `INSERT INTO leases (name, owner, epoch, expires_at)
     VALUES ($1, $2, 1, compute_now() + make_interval(secs => $3))
     ON CONFLICT (name) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
    [`gateway:${id}`, id, ttlMs / 1000],
  );
}

interface NodeOptions {
  pool?: string | null;
  role?: string;
  state?: string;
  connectivity?: string;
  gateway?: string | null;
  reasons?: string[];
  generation?: number;
}

/** A node row and its session, last seen now (a Hello through `gateway` when connected). */
async function seedNode(fixture: ComputeFixture, options: NodeOptions = {}): Promise<string> {
  const id = newId('node');
  const connectivity = options.connectivity ?? 'connected';
  await fixture.database.query(
    `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance,
       cordoned, connectivity, trust, no_schedule_reasons, generation, observed_generation,
       next_cmd_seq, identity_gen, shard, version)
     VALUES ($1, $2, $3, $4, $5, $6, false, false, $7, 'platform', $8, $9, 0, 1, 1, $10, 1)`,
    [
      id,
      SITE,
      options.pool === undefined ? METAL : options.pool,
      fixture.tenants.root.id,
      options.role ?? 'host',
      options.state ?? 'adopting',
      connectivity,
      options.reasons ?? [],
      options.generation ?? 0,
      shardOf(id),
    ],
  );
  const gateway =
    options.gateway === undefined
      ? connectivity === 'connected'
        ? GATEWAY
        : null
      : options.gateway;
  await fixture.database.query(
    `INSERT INTO node_sessions (node_id, gateway_id, session_epoch, last_seen, connected_at,
       disconnected_at)
     VALUES ($1, $2, 1, compute_now(), compute_now(), CASE WHEN $2::text IS NULL THEN compute_now() END)`,
    [id, gateway],
  );
  return id;
}

async function gpus(fixture: ComputeFixture, nodeId: string, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index++) {
    const id = `GPU-${nodeId.slice(-8)}-000${index}`;
    ids.push(id);
    await fixture.database.query(
      `INSERT INTO devices (id, node_id, class, bookable, healthy, attributes)
       VALUES ($1, $2, 'gpu', true, true, '{"gpuModel":"H100"}')`,
      [id, nodeId],
    );
  }
  return ids.sort();
}

async function node(fixture: ComputeFixture, id: string) {
  const { rows } = await fixture.database.query<{
    provision_state: string;
    connectivity: string;
    no_schedule_reasons: string[];
    generation: number;
    spec: JsonValue | null;
  }>(
    'SELECT provision_state, connectivity, no_schedule_reasons, generation, spec FROM nodes WHERE id = $1',
    [id],
  );
  return rows[0]!;
}

async function condition(fixture: ComputeFixture, nodeId: string, type: string) {
  const { rows } = await fixture.database.query<{ status: string; reason: string | null }>(
    'SELECT status, reason FROM node_conditions WHERE node_id = $1 AND type = $2',
    [nodeId, type],
  );
  return rows[0];
}

async function commands(fixture: ComputeFixture, nodeId: string) {
  const { rows } = await fixture.database.query<{
    id: string;
    kind: string;
    state: string;
    idempotency_key: string;
    not_after: Date;
    body: Uint8Array;
  }>(
    'SELECT id, kind, state, idempotency_key, not_after, body FROM commands WHERE node_id = $1 ORDER BY seq',
    [nodeId],
  );
  return rows;
}

async function settle(
  fixture: ComputeFixture,
  commandId: string,
  state: 'succeeded' | 'failed',
  result?: { passed: boolean; failing?: string },
) {
  const bytes =
    result &&
    encodeCommandResult(
      'diag.nvml',
      create(DiagNvmlResultSchema, {
        passed: result.passed,
        gpuCount: 2,
        checks: result.failing ? [{ name: result.failing, passed: false, message: 'short' }] : [],
      }),
    );
  await fixture.database.query(
    `UPDATE commands SET state = $2, reason = $3, result = $4 WHERE id = $1`,
    [commandId, state, state === 'failed' ? 'nvml-init' : null, bytes ?? null],
  );
}

async function topics(fixture: ComputeFixture) {
  const { rows } = await fixture.database.query<{ topic: string }>(
    'SELECT topic FROM outbox ORDER BY seq',
  );
  return rows.map((row) => row.topic);
}

const context = (fixture: ComputeFixture): ModuleContext => fixture.compute.context;

describe('NodeLifecycle', () => {
  it('registers the node controllers first, as reconcilers the runtime steps', async () => {
    const fixture = await setup();
    expect(fixture.compute.registry.modules[0]).toBe(nodesModuleName);
    expect(Object.keys(fixture.compute.jobs)).toEqual(
      expect.arrayContaining(['node', 'nodespec', 'liveness']),
    );
  });

  it('runs diag.nvml on a connected adopting node, then adopts it at generation 1', async () => {
    const fixture = await setup();
    const id = await seedNode(fixture, { connectivity: 'disconnected' });
    const uuids = await gpus(fixture, id, 2);
    expect(await reconcileLifecycle(context(fixture), id)).toBe('DONE');
    expect(await commands(fixture, id)).toEqual([]);

    // Hello: the gateway marks the node connected and enqueues the node reconciler.
    await fixture.database.query(`UPDATE nodes SET connectivity = 'connected' WHERE id = $1`, [id]);
    await fixture.database.transaction((tx) => context(fixture).work.enqueue(tx, 'node', id));
    expect(await fixture.compute.jobs.node!.tick()).toBe(1);
    const [command, ...more] = await commands(fixture, id);
    expect(more).toEqual([]);
    expect(command).toMatchObject({
      kind: 'diag.nvml',
      state: 'pending',
      idempotency_key: `acceptance:${id}:1:diag.nvml`,
      not_after: new Date(fixture.clock.now() + 10 * 60_000),
    });
    const body = decodeMessage(CommandBodySchema, new Uint8Array(command!.body));
    const payload = unpackCommandPayload('diag.nvml', body.payload);
    expect(payload.gpuUuids).toEqual(uuids);
    expect(payload.expectedGpuCount).toBe(2);
    expect(await condition(fixture, id, acceptanceCondition)).toEqual({
      status: 'unknown',
      reason: 'Running',
    });
    // Waiting on the command: nothing new.
    await reconcileLifecycle(context(fixture), id);
    expect(await commands(fixture, id)).toHaveLength(1);

    await settle(fixture, command!.id, 'succeeded', { passed: true });
    await reconcileLifecycle(context(fixture), id);
    expect(await node(fixture, id)).toMatchObject({ provision_state: 'adopted', generation: 0 });
    expect(await condition(fixture, id, acceptanceCondition)).toEqual({
      status: 'false',
      reason: 'Passed',
    });
    expect(await fixture.compute.jobs.nodespec!.tick()).toBe(1);
    const adopted = await node(fixture, id);
    expect(adopted.generation).toBe(1);
    expect(() =>
      fromJson(NodeSpecSchema, adopted.spec!, { registry: protocolRegistry }),
    ).not.toThrow();
    expect(await topics(fixture)).toEqual(
      expect.arrayContaining(['node.acceptance.started', 'node.adopted']),
    );
    expect(fixture.iam.calls).toEqual([]);
  });

  it('keeps a failed node adopting with AcceptanceFailed and NoSchedule until asked again', async () => {
    const fixture = await setup();
    const id = await seedNode(fixture, { reasons: ['taint:operator'] });
    await reconcileLifecycle(context(fixture), id);
    const [first] = await commands(fixture, id);
    await settle(fixture, first!.id, 'failed');
    await reconcileLifecycle(context(fixture), id);
    expect(await node(fixture, id)).toMatchObject({
      provision_state: 'adopting',
      no_schedule_reasons: ['AcceptanceFailed', 'taint:operator'],
    });
    expect(await condition(fixture, id, acceptanceCondition)).toEqual({
      status: 'true',
      reason: 'diag.nvml:failed',
    });
    expect(await topics(fixture)).toContain('node.acceptance.failed');
    // Sticky: no retry on its own.
    await reconcileLifecycle(context(fixture), id);
    expect(await commands(fixture, id)).toHaveLength(1);

    // nodes.adopt: the method applies the verb, then asks for a new attempt.
    await fixture.database.transaction((tx) =>
      markAcceptanceRequested(tx, context(fixture).work, id),
    );
    await reconcileLifecycle(context(fixture), id);
    const second = (await commands(fixture, id))[1]!;
    expect(second.idempotency_key).toBe(`acceptance:${id}:2:diag.nvml`);
    await settle(fixture, second.id, 'succeeded', { passed: true });
    await reconcileLifecycle(context(fixture), id);
    expect(await node(fixture, id)).toMatchObject({
      provision_state: 'adopted',
      no_schedule_reasons: ['taint:operator'],
    });
  });

  it('fails on a result that did not pass, and on a command the sweeper expired', async () => {
    const fixture = await setup();
    const failing = await seedNode(fixture);
    await reconcileLifecycle(context(fixture), failing);
    await settle(fixture, (await commands(fixture, failing))[0]!.id, 'succeeded', {
      passed: false,
      failing: 'gpu.count',
    });
    await reconcileLifecycle(context(fixture), failing);
    expect(await condition(fixture, failing, acceptanceCondition)).toEqual({
      status: 'true',
      reason: 'diag.nvml:gpu.count',
    });

    const silent = await seedNode(fixture);
    await reconcileLifecycle(context(fixture), silent);
    await fixture.advance(10 * 60_000);
    expect(await fixture.compute.jobs['command-sweeper']!.tick()).toBe(1);
    // The sweeper wakes the node reconciler.
    await fixture.compute.jobs.node!.tick();
    expect((await commands(fixture, silent))[0]!.state).toBe('expired');
    expect(await condition(fixture, silent, acceptanceCondition)).toEqual({
      status: 'true',
      reason: 'Expired',
    });
    expect(await node(fixture, silent)).toMatchObject({ provision_state: 'adopting' });
  });

  it('adopts site agents and pools without checks at once; an unknown check kind fails', async () => {
    const fixture = await setup();
    const site = await seedNode(fixture, {
      pool: null,
      role: 'site',
      connectivity: 'disconnected',
    });
    const bare = await seedNode(fixture, { pool: BARE, connectivity: 'disconnected' });
    const dcgm = await seedNode(fixture, { pool: DCGM });
    for (const id of [site, bare, dcgm]) await reconcileLifecycle(context(fixture), id);
    expect(await node(fixture, site)).toMatchObject({ provision_state: 'adopted' });
    expect(await node(fixture, bare)).toMatchObject({ provision_state: 'adopted' });
    expect(await condition(fixture, bare, acceptanceCondition)).toEqual({
      status: 'false',
      reason: 'NoChecks',
    });
    expect(await node(fixture, dcgm)).toMatchObject({
      provision_state: 'adopting',
      no_schedule_reasons: ['AcceptanceFailed'],
    });
    expect(await condition(fixture, dcgm, acceptanceCondition)).toEqual({
      status: 'true',
      reason: 'UnsupportedCheck',
    });
  });

  it('re-runs acceptance through the provision state table (INVALID_STATE on illegal moves)', async () => {
    const fixture = await setup();
    const adopted = await seedNode(fixture, { state: 'adopted' });
    const deployed = await seedNode(fixture, { state: 'deployed' });
    const request = (id: string) =>
      fixture.database.transaction((tx) => requestAcceptance(tx, context(fixture).work, id));
    expect(await request(adopted)).toEqual({ provisionState: 'adopting' });
    const illegal = await request(deployed).catch((error: unknown) => error);
    expect(isComputeError(illegal, 'INVALID_STATE')).toBe(true);
    const missing = await request('node_01jz0000000000000000000000').catch(
      (error: unknown) => error,
    );
    expect(isComputeError(missing, 'NOT_FOUND')).toBe(true);
    await reconcileLifecycle(context(fixture), adopted);
    expect(await commands(fixture, adopted)).toHaveLength(1);
  });
});

describe('NodeSpec', () => {
  async function allocation(fixture: ComputeFixture, nodeId: string, deviceIds: string[]) {
    const reservation = newId('rsv');
    const allocationId = newId('alloc');
    await fixture.database.query(
      `INSERT INTO reservations (id, tenant_id, pool_id, state, request, request_hash,
         owner_identity_id, idempotency_key, version)
       VALUES ($1, $2, $3, 'placed', '{"binding":"hold"}', '\\x00', 'identity-acme', $1, 1)`,
      [reservation, fixture.tenants.acme.id, METAL],
    );
    await fixture.database.query(
      `INSERT INTO allocations (id, tenant_id, pool_id, node_id, owner_kind, owner_id, atoms, during,
         version)
       VALUES ($1, $2, $3, $4, 'reservation', $5, $6, tstzrange(compute_now(), compute_now() + interval '8 hours'), 1)`,
      [allocationId, fixture.tenants.acme.id, METAL, nodeId, reservation, deviceIds],
    );
    return { reservation, allocationId };
  }

  it("renders the modules' contributions and bumps the generation only when the spec changes", async () => {
    const fixture = await setup();
    const id = await seedNode(fixture, { state: 'adopted' });
    const uuids = await gpus(fixture, id, 2);
    const { reservation, allocationId } = await allocation(fixture, id, uuids);
    contribution.assignments = [{ allocationId, deviceIds: [...uuids].reverse() }];
    const modules = fixture.compute.registry.modules;
    expect(modules).toContain('spec-test');

    await fixture.database.transaction((tx) => context(fixture).desired.invalidate(tx, id));
    expect(await fixture.compute.jobs.nodespec!.tick()).toBe(1);
    const first = await node(fixture, id);
    expect(first.generation).toBe(1);
    expect(first.spec).toEqual({
      host: { units: [{ unit: 'nvidia-driver', configJson: '{"version":"550"}' }] },
      devices: {
        assignments: [
          {
            allocationId,
            reservationId: reservation,
            binding: 'BINDING_HOLD',
            devices: uuids.map((uuid) => ({ id: uuid, deviceClass: 'gpu' })),
            env: [`BCD_ALLOCATION_ID=${allocationId}`],
          },
        ],
      },
    });
    const wire = fromJson(NodeSpecSchema, first.spec!, { registry: protocolRegistry });
    expect(wire.devices?.assignments[0]?.devices.map((device) => device.id)).toEqual(uuids);

    // Same contributions: no new generation.
    await fixture.database.transaction((tx) => context(fixture).desired.invalidate(tx, id));
    await fixture.compute.jobs.nodespec!.tick();
    expect((await node(fixture, id)).generation).toBe(1);

    contribution.driver = '560';
    await fixture.database.transaction((tx) => context(fixture).desired.invalidate(tx, id));
    await fixture.compute.jobs.nodespec!.tick();
    expect((await node(fixture, id)).generation).toBe(2);
  });

  it("pokes the node's gateway after a new generation commits", async () => {
    const fixture = await setup();
    const notifier = recordingNotifier();
    const compute = await sibling(fixture, { notifier, modules: [specModule] });
    const id = await seedNode(fixture, { state: 'adopted' });
    await fixture.database.transaction((tx) => compute.context.desired.invalidate(tx, id));
    expect(await compute.jobs.nodespec!.tick()).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(notifier.published).toEqual([
      { channel: `gw:${GATEWAY}`, message: JSON.stringify({ nodeIds: [id] }) },
    ]);
    // The same spec again: no new generation, no poke.
    await fixture.database.transaction((tx) => compute.context.desired.invalidate(tx, id));
    await compute.jobs.nodespec!.tick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(notifier.published).toHaveLength(1);
    await compute.stop();
  });

  it('writes no spec before a node is first adopted', async () => {
    const fixture = await setup();
    const id = await seedNode(fixture);
    const modules = [specModule];
    expect(await reconcileNodeSpec(context(fixture), id, modules)).toBeUndefined();
    expect(await node(fixture, id)).toMatchObject({ generation: 0, spec: null });
  });
});

describe('Drain', () => {
  it('waits for the node’s allocations to end, then ends the drain and keeps the node cordoned', async () => {
    const fixture = await setup();
    const id = await seedNode(fixture, { state: 'adopted', reasons: ['draining', 'taint:x'] });
    await fixture.database.query('UPDATE nodes SET cordoned = true WHERE id = $1', [id]);
    const [gpu] = await gpus(fixture, id, 1);
    await fixture.database.query(
      `INSERT INTO allocations (id, tenant_id, pool_id, node_id, owner_kind, owner_id, atoms, during,
         version)
       VALUES ('alloc_drain', $1, $2, $3, 'reservation', 'rsv_drain', $4,
         tstzrange(compute_now(), compute_now() + interval '1 hour'), 1)`,
      [fixture.tenants.acme.id, METAL, id, [gpu]],
    );
    await fixture.database.transaction((tx) => context(fixture).work.enqueue(tx, 'drain', id));
    expect(await fixture.compute.jobs.drain!.tick()).toBe(1);
    // Still draining; it looks again when the allocation ends (P6: nothing is released).
    expect((await node(fixture, id)).no_schedule_reasons).toEqual(['draining', 'taint:x']);
    expect(await fixture.compute.jobs.drain!.tick()).toBe(0);
    await fixture.advance(60 * 60_000);
    expect(await fixture.compute.jobs.drain!.tick()).toBe(1);
    const drained = await fixture.database.query<{
      cordoned: boolean;
      no_schedule_reasons: string[];
    }>('SELECT cordoned, no_schedule_reasons FROM nodes WHERE id = $1', [id]);
    expect(drained.rows[0]).toEqual({ cordoned: true, no_schedule_reasons: ['taint:x'] });
    expect(await topics(fixture)).toContain('node.drained');
    expect(fixture.iam.calls).toEqual([]);
  });
});

describe('Liveness', () => {
  /** Steps the clock in 5 s ticks of the Liveness sweep (the controller's own period). */
  async function run(fixture: ComputeFixture, ms: number) {
    for (let elapsed = 0; elapsed < ms; elapsed += 5_000) {
      await fixture.advance(5_000);
      await fixture.compute.jobs.liveness!.tick();
    }
  }
  const at = (fixture: ComputeFixture, id: string) =>
    node(fixture, id).then((row) => row.connectivity);

  async function bookings(fixture: ComputeFixture, nodeId: string) {
    const { rows } = await fixture.database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM device_bookings b JOIN devices d ON d.id = b.device_id
        WHERE d.node_id = $1 AND upper(b.during) > compute_now()`,
      [nodeId],
    );
    return Number(rows[0]!.count);
  }

  it('disconnects the nodes of a dead gateway and marks them unreachable after 40 s + 120 s', async () => {
    const fixture = await setup();
    const id = await seedNode(fixture, { state: 'adopted', reasons: ['taint:operator'] });
    const [gpu] = await gpus(fixture, id, 1);
    await fixture.database.query(
      `INSERT INTO device_bookings (device_id, allocation_id, during)
       VALUES ($1, 'alloc_x', tstzrange(compute_now(), compute_now() + interval '1 day'))`,
      [gpu],
    );
    await fixture.compute.jobs.liveness!.tick();
    await run(fixture, 15_000);
    expect(await at(fixture, id)).toBe('connected');
    await run(fixture, 10_000); // t = 25 s: the gateway lease (20 s) has expired
    expect(await at(fixture, id)).toBe('disconnected');
    await run(fixture, 130_000); // t = 155 s < 0 + 40 s + 120 s
    expect(await at(fixture, id)).toBe('disconnected');
    await run(fixture, 10_000); // t = 165 s
    expect(await node(fixture, id)).toMatchObject({
      connectivity: 'unreachable',
      no_schedule_reasons: ['taint:operator', 'unreachable'],
    });
    expect(await condition(fixture, id, unreachableCondition)).toEqual({
      status: 'true',
      reason: 'GatewayLost',
    });
    // P6: nothing released.
    expect(await bookings(fixture, id)).toBe(1);
    expect(await topics(fixture)).toEqual(
      expect.arrayContaining(['node.disconnected', 'node.unreachable']),
    );
    expect(fixture.iam.calls).toEqual([]);
  });

  it('marks a closed session unreachable 40 s after the node was last seen', async () => {
    const fixture = await setup();
    const id = await seedNode(fixture, { state: 'adopted', connectivity: 'disconnected' });
    await fixture.compute.jobs.liveness!.tick();
    await run(fixture, 35_000);
    expect(await at(fixture, id)).toBe('disconnected');
    await run(fixture, 10_000);
    expect(await at(fixture, id)).toBe('unreachable');
    expect(await condition(fixture, id, unreachableCondition)).toEqual({
      status: 'true',
      reason: 'HeartbeatTimeout',
    });

    // Hello through another gateway: connected again; the node reconciler clears the leftovers.
    await gatewayLease(fixture, 'gw_2', 20_000);
    await fixture.database.query(
      `UPDATE node_sessions SET gateway_id = 'gw_2', last_seen = compute_now(), disconnected_at = NULL
        WHERE node_id = $1`,
      [id],
    );
    await fixture.database.query(`UPDATE nodes SET connectivity = 'connected' WHERE id = $1`, [id]);
    await reconcileNode(context(fixture), id);
    expect(await node(fixture, id)).toMatchObject({
      connectivity: 'connected',
      no_schedule_reasons: [],
    });
    expect(await condition(fixture, id, unreachableCondition)).toEqual({
      status: 'false',
      reason: 'Connected',
    });
  });

  it('holds timeouts back for 5 min after the controller was down for more than 20 s', async () => {
    const fixture = await setup();
    const id = await seedNode(fixture, { state: 'adopted', connectivity: 'disconnected' });
    await fixture.compute.jobs.liveness!.tick();
    await fixture.advance(60_000); // no sweep for a minute
    await fixture.compute.jobs.liveness!.tick();
    expect(await at(fixture, id)).toBe('disconnected');
    await run(fixture, 290_000); // t = 350 s < 60 s + 300 s
    expect(await at(fixture, id)).toBe('disconnected');
    await run(fixture, 15_000); // t = 365 s
    expect(await at(fixture, id)).toBe('unreachable');
  });

  it("declares provider and vps-host nodes lost after the pool's lostAfter, never a metal node", async () => {
    const fixture = await setup();
    const down = { state: 'adopted', connectivity: 'disconnected' };
    const cloud = await seedNode(fixture, { pool: PROVIDER, ...down });
    const metal = await seedNode(fixture, down);
    const host = await seedNode(fixture, { pool: VPS, ...down });
    const kept = await seedNode(fixture, { pool: VPS_KEPT, ...down });
    await fixture.compute.jobs.liveness!.tick();
    await run(fixture, 45_000);
    for (const id of [cloud, metal, host, kept]) expect(await at(fixture, id)).toBe('unreachable');
    await run(fixture, 10 * 60_000);
    expect(await at(fixture, cloud)).toBe('lost');
    expect(await at(fixture, metal)).toBe('unreachable');
    // A VPS host is lost only when its pool opts in with lostAfter.
    expect(await at(fixture, host)).toBe('lost');
    expect(await at(fixture, kept)).toBe('unreachable');
    expect(await topics(fixture)).toContain('node.lost');
  });

  it('never times a node out from the event-driven node reconciler', async () => {
    const fixture = await setup();
    const id = await seedNode(fixture, { state: 'adopted', connectivity: 'disconnected' });
    await fixture.advance(10 * 60_000);
    await reconcileNode(context(fixture), id);
    expect(await at(fixture, id)).toBe('disconnected');
  });
});
