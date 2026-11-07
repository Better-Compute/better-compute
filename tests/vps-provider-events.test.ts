import { afterEach, describe, expect, it } from 'vitest';
import {
  manifest,
  type ProviderEvent,
  type ProviderImpl,
  type ProviderDefinition,
} from '@better-compute/core';
import { closeFixtures } from '@better-compute/testing';
import {
  defineProvider,
  eventDetails,
  instanceWork,
  interruptionCondition,
  maintenanceCondition,
  rebalanceCondition,
  providerEventsWork,
  reservationsWork,
} from '@better-compute/vps';
import { workRows } from './support/runtime.js';
import { fakeGceProvider, gceWorld, type FakeGce, type GceWorld } from './support/vps-gce.js';

// The `vps.provider-events` worker (AWS A4, AD12): accounts whose client has `pollEvents` are polled
// every 15 s; events wake reconcilers early and never write machine state. An interruption warning
// marks the instance, taints the node its machine backs and gives that node's reservations the spot
// notice. Duplicate ids are processed once, and a batch is acked only after its transaction commits.

afterEach(closeFixtures);

interface Intake {
  /** Delivered by every poll until acked (SQS semantics). */
  pending: ProviderEvent[];
  acked: string[];
  polls: number;
  /** The next ack throws (a lost delete: the batch comes again). */
  failAck?: boolean;
  /** Queue messages each poll reports reading (`received`), one entry per poll; absent: omitted. */
  received?: number[];
  /** The waitMs of each poll. */
  waits?: number[];
}

function eventsProvider(cloud: FakeGce, intake: Intake): ProviderDefinition {
  const inner = fakeGceProvider(cloud, 'fake-events');
  return defineProvider({
    id: 'fake-events',
    version: '1.0.0',
    provides: ['vps'],
    config: manifest({}) as never,
    create: async (config, context) => {
      const impl = (await inner.create(config, context)) as ProviderImpl;
      return {
        ...impl,
        async pollEvents(_context: unknown, options: { waitMs: number }) {
          intake.polls += 1;
          (intake.waits ??= []).push(options.waitMs);
          const events = [...intake.pending];
          const received = intake.received?.shift();
          return {
            events,
            ...(received !== undefined ? { received } : {}),
            async ack() {
              if (intake.failAck) {
                intake.failAck = false;
                throw new Error('emulated lost delete');
              }
              const ids = new Set(events.map((event) => event.id));
              intake.pending = intake.pending.filter((event) => !ids.has(event.id));
              intake.acked.push(...ids);
            },
          };
        },
      };
    },
  });
}

interface EventsWorld extends GceWorld {
  intake: Intake;
  events2: FakeGce;
  eventsAccountId: string;
  eventsPoolId: string;
  /** An instance created through the events account (its machine exists in `events2`). */
  instance(key: string): Promise<{ id: string; machineId: string }>;
  poll(): Promise<void>;
}

async function eventsWorld(): Promise<EventsWorld> {
  const events2: FakeGce = { machines: new Map(), requests: [] };
  const intake: Intake = { pending: [], acked: [], polls: 0 };
  const world = await gceWorld({ providers: [eventsProvider(events2, intake)] });
  const { api, root } = world;
  const account = await api.providerAccounts.create(root, {
    tenantId: world.rootTenant,
    provider: 'fake-events',
    name: 'events-main',
    config: {},
  });
  const site = await api.sites.create(root, {
    tenantId: world.rootTenant,
    kind: 'shared',
    region: 'us-central1',
    idempotencyKey: 'events-site',
  });
  const pool = await api.pools.create(root, {
    tenantId: world.rootTenant,
    siteId: site.id,
    class: 'provider',
    providerAccountId: account.id,
    idempotencyKey: 'events-pool',
  });
  await api.pools.offer(root, {
    tenantId: world.rootTenant,
    poolId: pool.id,
    toTenantId: world.acmeTenant,
    quota: { vcpu: 512, memoryGiB: 4096, diskGiB: 1000, gpu: 16 },
  });
  await api.flavors.create(root, {
    tenantId: world.rootTenant,
    poolId: pool.id,
    name: 'spot.small',
    vcpu: 12,
    memoryGiB: 85,
    diskGiB: 100,
    gpus: 1,
    offerId: 'us-central1-a/a2-highgpu-1g',
  });
  return {
    ...world,
    intake,
    events2,
    eventsAccountId: account.id,
    eventsPoolId: pool.id,
    async instance(key) {
      const created = await api.instances.create(world.acme, {
        tenantId: world.acmeTenant,
        poolId: pool.id,
        flavor: 'spot.small',
        imageId: 'debian-12',
        idempotencyKey: key,
      });
      await world.fixture.advance(1_000);
      await world.tick('vps.instances', 1);
      const machineId = `us-central1-a/${created.id.replaceAll('_', '-')}`;
      expect(events2.machines.has(machineId)).toBe(true);
      return { id: created.id, machineId };
    },
    async poll() {
      await world.tick(providerEventsWork);
    },
  };
}

/**
 * A metal-host pool whose one node is the platform's machine us-central1-a/spot-host, joined
 * through a provider bootstrap of the events account.
 */
async function spotNode(world: EventsWorld): Promise<{ nodeId: string; hostsPoolId: string }> {
  const { api, root } = world;
  const db = world.fixture.database;
  const site = await api.sites.create(root, {
    tenantId: world.rootTenant,
    kind: 'shared',
    region: 'us-central1',
    idempotencyKey: 'host-site',
  });
  const hosts = await api.pools.create(root, {
    tenantId: world.rootTenant,
    siteId: site.id,
    class: 'metal-host',
    gpuModel: 'H100',
    idempotencyKey: 'host-pool',
  });
  await api.pools.offer(root, {
    tenantId: world.rootTenant,
    poolId: hosts.id,
    toTenantId: world.acmeTenant,
    quota: { gpu: 8 },
  });
  const nodeId = 'node_01jz00000000000000000000sp';
  await db.query(
    `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance, cordoned,
       connectivity, trust, generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
     VALUES ($1, $2, $3, $4, 'host', 'adopted', false, false, 'connected', 'platform', 1, 1, 1, 1, 0, 1)`,
    [nodeId, site.id, hosts.id, world.rootTenant],
  );
  for (let index = 0; index < 4; index++)
    await db.query(
      `INSERT INTO devices (id, node_id, class, bookable, healthy, attributes)
       VALUES ($1, $2, 'gpu', true, true, '{"gpuModel":"H100","vramGiB":80}')`,
      [`GPU-sp-${index}`, nodeId],
    );
  await db.query(
    `INSERT INTO provider_bootstraps (id, tenant_id, account_id, pool_id, machine_id, state, node_id,
       owner_identity_id, idempotency_key, request_hash, version)
     VALUES ('pbs_test', $1, $2, $3, 'us-central1-a/spot-host', 'joined', $4, 'usr_root', 'b-1', 'h', 1)`,
    [world.rootTenant, world.eventsAccountId, world.eventsPoolId, nodeId],
  );
  return { nodeId, hostsPoolId: hosts.id };
}

const nodeTaints = async (world: GceWorld, nodeId: string) =>
  (
    await world.fixture.database.query<{ no_schedule_reasons: string[] }>(
      `SELECT no_schedule_reasons FROM nodes WHERE id = $1`,
      [nodeId],
    )
  ).rows[0]!.no_schedule_reasons;

async function instanceRow(world: GceWorld, id: string) {
  const { rows } = await world.fixture.database.query<{
    state: string;
    reported_state: string | null;
    conditions: { type: string; reason: string; message: string }[];
  }>(`SELECT state, reported_state, conditions FROM instances WHERE id = $1`, [id]);
  return rows[0]!;
}

const dueKeys = async (world: GceWorld, kind: string) => {
  const now = world.fixture.clock.now();
  return (await workRows(world.fixture.database, kind))
    .filter((row) => row.not_before.getTime() <= now)
    .map((row) => row.key);
};

describe('vps.provider-events', () => {
  it('state change enqueues a reconcile without writing state', async () => {
    const world = await eventsWorld();
    const vm = await world.instance('vm-1');
    // Drain whatever the create left due, so the event's wake is what we see.
    await world.fixture.database.query(`DELETE FROM work_queue WHERE kind = $1`, [instanceWork]);
    const before = await instanceRow(world, vm.id);
    const at = world.fixture.clock.now();
    world.intake.pending.push(
      { id: 'e-1', kind: 'machine-changed', machineId: vm.machineId, at, details: { state: 'stopped' } },
      { id: 'e-2', kind: 'machine-changed', machineId: 'us-central1-a/unknown', at },
    );
    await world.poll();
    expect(world.intake.polls).toBeGreaterThanOrEqual(1);
    expect(world.intake.acked.sort()).toEqual(['e-1', 'e-2']);
    expect(await dueKeys(world, instanceWork)).toEqual([vm.id]);
    // No state from the event: the instance is as the last provider read left it.
    expect(await instanceRow(world, vm.id)).toEqual(before);
    // The fake-gce account has no pollEvents, so only the events account is polled.
    const { rows } = await world.fixture.database.query<{ account_id: string }>(
      `SELECT DISTINCT account_id FROM provider_event_seen ORDER BY account_id`,
    );
    expect(rows.map((row) => row.account_id)).toEqual([world.eventsAccountId]);
  });

  it('interruption taints the backing node and drains reservations', async () => {
    const world = await eventsWorld();
    const { api, fixture } = world;
    const { nodeId, hostsPoolId } = await spotNode(world);
    const reservation = await api.reservations.create(world.acme, {
      tenantId: world.acmeTenant,
      poolId: hostsPoolId,
      devices: [{ class: 'gpu', count: 2 }],
      duration: '4h',
      idempotencyKey: 'r-1',
    });
    expect(reservation.state).toBe('placed');
    // And a VM of the account, interrupted in the same batch.
    const vm = await world.instance('vm-1');
    const db = fixture.database;
    void db;
    
    const now = fixture.clock.now();
    const deadline = now + 120_000;
    world.intake.pending.push(
      { id: 'spot-host', kind: 'interruption-warning', machineId: 'us-central1-a/spot-host', at: now, deadline },
      { id: 'spot-vm', kind: 'interruption-warning', machineId: vm.machineId, at: now, deadline, details: { action: 'terminate' } },
    );
    await world.poll();

    const { rows: nodes } = await db.query<{ no_schedule_reasons: string[] }>(
      `SELECT no_schedule_reasons FROM nodes WHERE id = $1`,
      [nodeId],
    );
    expect(nodes[0]!.no_schedule_reasons).toContain('taint:fake-events.spot/interruption');
    const after = await api.reservations.get(world.acme, {
      tenantId: world.acmeTenant,
      reservationId: reservation.id,
    });
    expect(after.during.end).toBe(deadline);
    expect(after.conditions).toContainEqual(
      expect.objectContaining({ type: 'Preempted', reason: 'ProviderInterruption' }),
    );
    const row = await instanceRow(world, vm.id);
    expect(row.conditions).toContainEqual(
      expect.objectContaining({ type: interruptionCondition, reason: 'SpotInterruption' }),
    );
    const tainted = await world.events('node.tainted');
    expect(tainted).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          nodeId,
          added: ['fake-events.spot/interruption'],
          deadline,
          reservations: [reservation.id],
        }),
      }),
    ]);
    const interrupted = await world.events('instance.interruption');
    expect(interrupted).toEqual([
      expect.objectContaining({
        tenantId: world.acmeTenant,
        data: expect.objectContaining({
          instanceId: vm.id,
          accountId: world.eventsAccountId,
          machineId: vm.machineId,
          deadline,
          details: { action: 'terminate' },
        }),
      }),
    ]);
    expect(await world.events('reservation.preempting')).toHaveLength(1);
  });

  it('a stopped Spot machine that runs again loses its interruption condition and taint', async () => {
    // instance-action stop or hibernate: the instance id survives and runs again later, and the
    // node rejoins. A running state change after the deadline clears what the warning set.
    const world = await eventsWorld();
    const { nodeId } = await spotNode(world);
    const vm = await world.instance('vm-1');
    const now = world.fixture.clock.now();
    const deadline = now + 120_000;
    world.intake.pending.push(
      { id: 'w-host', kind: 'interruption-warning', machineId: 'us-central1-a/spot-host', at: now, deadline, details: { action: 'stop' } },
      { id: 'w-vm', kind: 'interruption-warning', machineId: vm.machineId, at: now, deadline, details: { action: 'hibernate' } },
      { id: 'r-vm', kind: 'rebalance-recommended', machineId: vm.machineId, at: now },
    );
    await world.poll();
    expect(await nodeTaints(world, nodeId)).toContain('taint:fake-events.spot/interruption');
    const types = async () => (await instanceRow(world, vm.id)).conditions.map((c) => c.type);
    expect(await types()).toEqual(expect.arrayContaining([interruptionCondition, rebalanceCondition]));

    // A running change from before the deadline (delivered out of order) clears nothing.
    world.intake.pending.push(
      { id: 's-early', kind: 'machine-changed', machineId: vm.machineId, at: now + 1_000, details: { state: 'running' } },
      { id: 's-early-host', kind: 'machine-changed', machineId: 'us-central1-a/spot-host', at: now + 1_000, details: { state: 'running' } },
    );
    await world.fixture.advance(15_000);
    await world.poll();
    expect(await types()).toContain(interruptionCondition);
    expect(await nodeTaints(world, nodeId)).toContain('taint:fake-events.spot/interruption');

    // Stopped at the deadline, then running again later.
    await world.fixture.advance(10 * 60_000);
    const back = world.fixture.clock.now();
    world.intake.pending.push(
      { id: 's-stopped', kind: 'machine-changed', machineId: vm.machineId, at: deadline, details: { state: 'stopped' } },
      { id: 's-vm', kind: 'machine-changed', machineId: vm.machineId, at: back, details: { state: 'running' } },
      { id: 's-host', kind: 'machine-changed', machineId: 'us-central1-a/spot-host', at: back, details: { state: 'running' } },
    );
    await world.poll();
    expect(await types()).not.toContain(interruptionCondition);
    expect(await types()).not.toContain(rebalanceCondition);
    expect(await nodeTaints(world, nodeId)).not.toContain('taint:fake-events.spot/interruption');
    expect((await world.events('node.tainted')).map((event) => event.data)).toEqual([
      expect.objectContaining({ nodeId, added: ['fake-events.spot/interruption'], removed: [] }),
      expect.objectContaining({ nodeId, added: [], removed: ['fake-events.spot/interruption'], reason: 'interruption-over' }),
    ]);
    // A later running change finds nothing to clear and publishes nothing.
    world.intake.pending.push({ id: 's-again', kind: 'machine-changed', machineId: 'us-central1-a/spot-host', at: back + 60_000, details: { state: 'running' } });
    await world.fixture.advance(15_000);
    await world.poll();
    expect(await world.events('node.tainted')).toHaveLength(2);
  });

  it('interruption marks clear from polling when the running event never arrives', async () => {
    // EventBridge lost the running state change (or it went to the DLQ, or came too late): the
    // instance reconcile reads the machine running past the deadline and clears the marks, and the
    // node clears once its session is seen after the deadline.
    const world = await eventsWorld();
    const { nodeId } = await spotNode(world);
    const vm = await world.instance('vm-1');
    const db = world.fixture.database;
    const now = world.fixture.clock.now();
    const deadline = now + 120_000;
    world.intake.pending.push(
      { id: 'w-host', kind: 'interruption-warning', machineId: 'us-central1-a/spot-host', at: now, deadline, details: { action: 'stop' } },
      { id: 'w-vm', kind: 'interruption-warning', machineId: vm.machineId, at: now, deadline, details: { action: 'hibernate' } },
    );
    await world.poll();
    const types = async () => (await instanceRow(world, vm.id)).conditions.map((c) => c.type);
    expect(await types()).toContain(interruptionCondition);
    expect(await nodeTaints(world, nodeId)).toContain('taint:fake-events.spot/interruption');
    await db.query(
      `INSERT INTO node_sessions (node_id, session_epoch, last_seen, connected_at) VALUES ($1, 1, compute_now(), compute_now())`,
      [nodeId],
    );

    // Inside the grace after the deadline, running reads clear nothing (the stop may still be on its way).
    await world.fixture.advance(5 * 60_000);
    await db.query(`UPDATE node_sessions SET last_seen = compute_now() WHERE node_id = $1`, [nodeId]);
    await world.tick('vps.instances', 1);
    await world.poll();
    expect(await types()).toContain(interruptionCondition);
    expect(await nodeTaints(world, nodeId)).toContain('taint:fake-events.spot/interruption');

    // Well past the deadline and its grace, the machine reads running: the marks come off.
    await world.fixture.advance(10 * 60_000);
    await world.tick('vps.instances', 1);
    expect(await types()).not.toContain(interruptionCondition);
    // The node's session was last seen inside the grace: still tainted until it is seen later.
    await world.poll();
    expect(await nodeTaints(world, nodeId)).toContain('taint:fake-events.spot/interruption');
    await db.query(`UPDATE node_sessions SET last_seen = compute_now() WHERE node_id = $1`, [nodeId]);
    await world.fixture.advance(15_000);
    await world.poll();
    expect(await nodeTaints(world, nodeId)).not.toContain('taint:fake-events.spot/interruption');
    expect((await world.events('node.tainted')).map((event) => event.data)).toEqual([
      expect.objectContaining({ nodeId, added: ['fake-events.spot/interruption'], removed: [] }),
      expect.objectContaining({ nodeId, added: [], removed: ['fake-events.spot/interruption'], reason: 'interruption-over' }),
    ]);
    const { rows } = await db.query(`SELECT machine_id FROM provider_interruptions`);
    expect(rows).toEqual([]);
  });

  it('a disconnected node keeps its interruption taint', async () => {
    const world = await eventsWorld();
    const { nodeId } = await spotNode(world);
    const db = world.fixture.database;
    const now = world.fixture.clock.now();
    world.intake.pending.push({
      id: 'w-host',
      kind: 'interruption-warning',
      machineId: 'us-central1-a/spot-host',
      at: now,
      deadline: now + 120_000,
    });
    await world.poll();
    await world.fixture.advance(30 * 60_000);
    await db.query(
      `INSERT INTO node_sessions (node_id, session_epoch, last_seen) VALUES ($1, 1, compute_now())`,
      [nodeId],
    );
    await db.query(`UPDATE nodes SET connectivity = 'disconnected' WHERE id = $1`, [nodeId]);
    await world.poll();
    expect(await nodeTaints(world, nodeId)).toContain('taint:fake-events.spot/interruption');
  });

  it('a rebalance recommendation that no interruption follows expires', async () => {
    const world = await eventsWorld();
    const vm = await world.instance('vm-1');
    const types = async () => (await instanceRow(world, vm.id)).conditions.map((c) => c.type);
    world.intake.pending.push({ id: 'r-1', kind: 'rebalance-recommended', machineId: vm.machineId, at: world.fixture.clock.now() });
    await world.poll();
    expect(await types()).toContain(rebalanceCondition);
    // A later recommendation renews it.
    await world.fixture.advance(3 * 3_600_000);
    world.intake.pending.push({ id: 'r-2', kind: 'rebalance-recommended', machineId: vm.machineId, at: world.fixture.clock.now() });
    await world.poll();
    await world.fixture.advance(3 * 3_600_000);
    await world.tick('vps.instances', 1);
    expect(await types()).toContain(rebalanceCondition);
    await world.fixture.advance(1.5 * 3_600_000);
    await world.tick('vps.instances', 1);
    expect(await types()).not.toContain(rebalanceCondition);
  });

  it('duplicate event ids are processed once', async () => {
    const world = await eventsWorld();
    const vm = await world.instance('vm-1');
    const at = world.fixture.clock.now();
    const warning: ProviderEvent = {
      id: 'dup-1',
      kind: 'interruption-warning',
      machineId: vm.machineId,
      at,
      deadline: at + 120_000,
    };
    // The first ack is lost: the batch comes again on the next run.
    world.intake.failAck = true;
    world.intake.pending.push(warning, { ...warning });
    await world.poll();
    expect(world.intake.pending).toHaveLength(2);
    await world.fixture.advance(15_000);
    await world.poll();
    expect(world.intake.pending).toEqual([]);
    expect(await world.events('instance.interruption')).toHaveLength(1);
    const { rows } = await world.fixture.database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM provider_event_seen WHERE event_id = 'dup-1'`,
    );
    expect(rows[0]!.count).toBe('1');
    // Seen ids are pruned after a day.
    await world.fixture.advance(86_400_000 + 60_000);
    await world.tick(providerEventsWork, 1);
    const { rows: left } = await world.fixture.database.query(
      `SELECT 1 FROM provider_event_seen WHERE event_id = 'dup-1'`,
    );
    expect(left).toEqual([]);
  });

  it('maintenance sets and clears its condition; reservation changes wake the scan', async () => {
    const world = await eventsWorld();
    const vm = await world.instance('vm-1');
    const at = world.fixture.clock.now();
    world.intake.pending.push(
      {
        id: 'm-1',
        kind: 'maintenance-scheduled',
        machineId: vm.machineId,
        at,
        deadline: at + 86_400_000,
        details: { code: 'system-reboot', status: 'scheduled' },
      },
      { id: 'cr-1', kind: 'reservation-changed', reservationId: 'cr-0123456789abcdef0', at },
    );
    await world.poll();
    expect((await instanceRow(world, vm.id)).conditions).toContainEqual(
      expect.objectContaining({ type: maintenanceCondition, reason: 'system-reboot' }),
    );
    expect(await dueKeys(world, reservationsWork)).toContain(world.eventsAccountId);
    world.intake.pending.push({
      id: 'm-1/completed',
      kind: 'maintenance-scheduled',
      machineId: vm.machineId,
      at,
      details: { code: 'system-reboot', status: 'completed' },
    });
    await world.fixture.advance(15_000);
    await world.poll();
    expect(
      (await instanceRow(world, vm.id)).conditions.map((condition) => condition.type),
    ).not.toContain(maintenanceCondition);
    expect((await world.events('instance.maintenance')).map((event) => event.data.details.status)).toEqual([
      'scheduled',
      'completed',
    ]);
  });

  it('polling alone still converges with intake disabled', async () => {
    const world = await gceWorld({ discovery: { every: '1m' } });
    const created = await world.api.instances.create(world.acme, {
      tenantId: world.acmeTenant,
      poolId: world.poolId,
      flavor: 'a2.highgpu.1g',
      imageId: 'debian-12',
      idempotencyKey: 'vm-1',
    });
    await world.fixture.advance(1_000);
    await world.tick('vps.instances', 1);
    const machine = [...world.cloud.machines.values()][0]!;
    world.cloud.machines.get(machine.id)!.state = 'stopped';
    // No account polls events: the worker enqueues nothing, and the lifecycle poll still sees the stop.
    await world.tick(providerEventsWork);
    expect(
      (await workRows(world.fixture.database, providerEventsWork)).map((row) => row.key),
    ).toEqual(['all']);
    for (let round = 0; round < 5; round++) {
      await world.fixture.advance(60_000);
      await world.tick('vps.instances', 1);
    }
    // The poll saw the out-of-band stop and converged back to the desired running state.
    expect(world.cloud.requests).toContain(`power ${machine.id} on`);
    expect(world.cloud.machines.get(machine.id)!.state).toBe('running');
  });

  it('handles every event of a large batch before it acks', async () => {
    // One AWS Health message can name hundreds of instances: none is dropped, each chunk of the
    // batch commits in its own transaction, and the batch is acked only after the last one.
    const world = await eventsWorld();
    const vm = await world.instance('vm-1');
    await world.fixture.database.query(`DELETE FROM work_queue WHERE kind = $1`, [instanceWork]);
    const at = world.fixture.clock.now();
    for (let index = 0; index < 150; index++)
      world.intake.pending.push({
        id: `h-1/m-${index}`,
        kind: 'maintenance-scheduled',
        machineId: index === 120 ? vm.machineId : `us-central1-a/other-${index}`,
        at,
        deadline: at + 86_400_000,
        details: { code: 'system-reboot', status: 'scheduled' },
      });
    world.intake.pending.push({ id: 'late-wake', kind: 'machine-changed', machineId: vm.machineId, at });
    await world.poll();
    expect(world.intake.acked).toHaveLength(151);
    expect(world.intake.pending).toEqual([]);
    const { rows } = await world.fixture.database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM provider_event_seen WHERE account_id = $1`,
      [world.eventsAccountId],
    );
    expect(rows[0]!.count).toBe('151');
    expect((await instanceRow(world, vm.id)).conditions).toContainEqual(
      expect.objectContaining({ type: maintenanceCondition }),
    );
    expect(await dueKeys(world, instanceWork)).toEqual([vm.id]);
  });

  it('polls again while the queue returns full batches of messages, mapped or not', async () => {
    const world = await eventsWorld();
    // Ten messages that all mapped to nothing (forged or unknown) still mean more may wait.
    world.intake.received = [10, 10, 3];
    await world.poll();
    expect(world.intake.polls).toBe(3);
    // A short long poll by default: polling runs on one replica, a few accounts at a time, so an
    // idle queue must not hold a lane 10 s (with many accounts the Spot warning would be over).
    expect(world.intake.waits).toEqual([2_000, 2_000, 2_000]);
    // A batch of many events from one message does not keep a drained queue polling.
    world.intake.polls = 0;
    world.intake.received = [1, 0];
    const at = world.fixture.clock.now();
    for (let index = 0; index < 20; index++)
      world.intake.pending.push({
        id: `h-2/m-${index}`,
        kind: 'maintenance-scheduled',
        machineId: `us-central1-a/other-${index}`,
        at,
      });
    await world.fixture.advance(15_000);
    await world.poll();
    expect(world.intake.polls).toBe(1);
  });

  it('drops an event older than the seen-id retention', async () => {
    // A redelivery after an outage or a DLQ redrive can come back after its id was pruned: an event
    // older than the retention (less a margin) is dropped, not processed a second time.
    const world = await eventsWorld();
    const vm = await world.instance('vm-1');
    const now = world.fixture.clock.now();
    world.intake.pending.push({
      id: 'old-maintenance',
      kind: 'maintenance-scheduled',
      machineId: vm.machineId,
      at: now - 25 * 3_600_000,
      deadline: now + 86_400_000,
      details: { code: 'system-reboot', status: 'scheduled' },
    });
    await world.poll();
    expect(world.intake.acked).toEqual(['old-maintenance']);
    expect((await instanceRow(world, vm.id)).conditions.map((c) => c.type)).not.toContain(
      maintenanceCondition,
    );
    expect(await world.events('instance.maintenance')).toEqual([]);
  });

  it('an interruption whose deadline passed only wakes the reconcile', async () => {
    // The machine is already reclaimed (or stopped and back): no condition, no taint, no cut.
    const world = await eventsWorld();
    const vm = await world.instance('vm-1');
    await world.fixture.database.query(`DELETE FROM work_queue WHERE kind = $1`, [instanceWork]);
    const now = world.fixture.clock.now();
    world.intake.pending.push({
      id: 'late-spot',
      kind: 'interruption-warning',
      machineId: vm.machineId,
      at: now - 300_000,
      deadline: now - 180_000,
      details: { action: 'stop' },
    });
    await world.poll();
    expect(world.intake.acked).toEqual(['late-spot']);
    expect((await instanceRow(world, vm.id)).conditions.map((c) => c.type)).not.toContain(
      interruptionCondition,
    );
    expect(await world.events('instance.interruption')).toEqual([]);
    expect(await dueKeys(world, instanceWork)).toEqual([vm.id]);
  });

  it('an id that keeps coming stays seen past the retention', async () => {
    // The no-queue scan re-emits a still-scheduled event every 5 minutes with the same id: it is
    // processed once, not again each day after the prune.
    const world = await eventsWorld();
    const vm = await world.instance('vm-1');
    const scheduled = (): ProviderEvent => ({
      id: `status/${vm.machineId}/instance-event-0123456789abcdef0/scheduled`,
      kind: 'maintenance-scheduled',
      machineId: vm.machineId,
      at: world.fixture.clock.now(),
      deadline: world.fixture.clock.now() + 7 * 86_400_000,
      details: { code: 'system-reboot', status: 'scheduled' },
    });
    for (let hour = 0; hour < 30; hour += 6) {
      world.intake.pending.push(scheduled());
      await world.poll();
      await world.fixture.advance(6 * 3_600_000);
    }
    await world.tick(providerEventsWork, 1);
    world.intake.pending.push(scheduled());
    await world.poll();
    expect(await world.events('instance.maintenance')).toHaveLength(1);
  });

  it('event details reach tenants only as short printable facts', () => {
    expect(
      eventDetails({
        action: 'terminate',
        long: 'x'.repeat(200),
        'bad key!': 'v',
        control: 'a\nb',
        a1: '1',
        a2: '2',
        a3: '3',
        a4: '4',
        a5: '5',
        a6: '6',
        a7: '7',
        a8: '8',
      }),
    ).toEqual({ action: 'terminate', a1: '1', a2: '2', a3: '3', a4: '4', a5: '5', a6: '6', a7: '7' });
    expect(eventDetails(undefined)).toBeUndefined();
  });
});
