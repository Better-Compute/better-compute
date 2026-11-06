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
        async pollEvents() {
          intake.polls += 1;
          const events = [...intake.pending];
          return {
            events,
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
    world.intake.pending.push(
      { id: 'e-1', kind: 'machine-changed', machineId: vm.machineId, at: 1, details: { state: 'stopped' } },
      { id: 'e-2', kind: 'machine-changed', machineId: 'us-central1-a/unknown', at: 1 },
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
    const { api, root, fixture } = world;
    const db = fixture.database;
    // A metal-host pool whose one node is the platform's machine us-central1-a/spot-host, joined
    // through a provider bootstrap of the events account.
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
    const reservation = await api.reservations.create(world.acme, {
      tenantId: world.acmeTenant,
      poolId: hosts.id,
      devices: [{ class: 'gpu', count: 2 }],
      duration: '4h',
      idempotencyKey: 'r-1',
    });
    expect(reservation.state).toBe('placed');
    // And a VM of the account, interrupted in the same batch.
    const vm = await world.instance('vm-1');

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
