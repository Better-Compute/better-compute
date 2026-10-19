import { afterEach, describe, expect, it } from 'vitest';
import type { ExternalReservation } from '@better-compute/core';
import { closeFixtures } from '@better-compute/testing';
import { vps, type BillableShape } from '@better-compute/vps';
import { gceWorld, type GceWorld } from './support/vps-gce.js';

// Platform compute billing, phase 3 (commitments): reserved-rate meters for instances admitted against a provider
// reservation (D8, Task 9), reservation grants with grant-aware admission (D7, Task 10) and grant billing by committed
// slot-hours (Task 11). The fake GCE of tests/support/vps-gce.ts has no reservation listing, so each test seeds the
// reservation row the vps.reservations worker would have written and binds it through the API.

const HOUR = 3_600_000;
const MINUTE = 60_000;
/** The default meter grace (5 minutes) and a moment past it: an ended hour is written only then. */
const settle = 6 * MINUTE;
const RSV = 'us-central1-a/rsv-a';
const OFFER = 'us-central1-a/a2-highgpu-1g@rsv-a';
const FLAVOR = 'rsv-rsv-a';

afterEach(closeFixtures);

function reservation(extra: Partial<ExternalReservation> = {}): ExternalReservation {
  return {
    id: RSV,
    name: 'rsv-a',
    zone: 'us-central1-a',
    region: 'us-central1',
    state: 'ready',
    machineType: 'a2-highgpu-1g',
    vcpu: 12,
    memoryGiB: 85,
    gpus: { model: 'nvidia-a100-40gb', count: 1 },
    total: 4,
    inUse: 0,
    specificOnly: true,
    shared: false,
    offerId: OFFER,
    ...extra,
  };
}

/** Writes the row a `vps.reservations` scan would (observed now), and binds it to the world's pool. */
async function seedReservation(world: GceWorld, extra: Partial<ExternalReservation> = {}) {
  const value = reservation(extra);
  await world.fixture.database.query(
    `INSERT INTO provider_reservations (account_id, reservation_id, reservation, total, in_use, observed_at)
     VALUES ($1, $2, $3::jsonb, $4, $5, compute_now())`,
    [world.accountId, value.id, JSON.stringify(value), value.total, value.inUse],
  );
  return world.api.providerAccounts.bindReservation(world.root, {
    tenantId: world.rootTenant,
    accountId: world.accountId,
    reservationId: RSV,
    poolId: world.poolId,
    idempotencyKey: 'bind-rsv-a',
  }) as Promise<{ poolId: string; flavorId: string }>;
}

async function createIn(
  world: GceWorld,
  who: 'acme' | 'other',
  key: string,
  flavor = FLAVOR,
): Promise<{ id: string }> {
  const tenant = world.fixture.tenants[who];
  return world.api.instances.create(
    { token: tenant.token },
    {
      tenantId: tenant.id,
      poolId: world.poolId,
      flavor,
      imageId: 'debian-12',
      idempotencyKey: key,
    },
  );
}

/** One `vps.instances` pass after `ms` of sim time; returns the time it ran at. */
async function step(world: GceWorld, ms = 1_000): Promise<number> {
  const at = await world.fixture.advance(ms);
  await world.tick('vps.instances', 1);
  return at;
}

async function moveTo(world: GceWorld, at: number): Promise<void> {
  const now = world.fixture.clock.now();
  if (at > now) await world.fixture.advance(at - now);
}

const nextHour = (world: GceWorld) => (Math.floor(world.fixture.clock.now() / HOUR) + 1) * HOUR;

interface IntervalView {
  phase: string;
  shape: BillableShape;
  started: number;
  ended: number | null;
}

async function intervals(world: GceWorld, instanceId: string): Promise<IntervalView[]> {
  const { rows } = await world.fixture.database.query<{
    phase: string;
    shape: BillableShape | string;
    started: number;
    ended: number | null;
  }>(
    `SELECT phase, shape, (extract(epoch FROM started_at) * 1000)::float8 AS started,
            (extract(epoch FROM ended_at) * 1000)::float8 AS ended
       FROM instance_usage_intervals WHERE instance_id = $1 ORDER BY started_at, id`,
    [instanceId],
  );
  return rows.map((row) => ({
    phase: row.phase,
    shape: typeof row.shape === 'string' ? JSON.parse(row.shape) : row.shape,
    started: Number(row.started),
    ended: row.ended === null ? null : Number(row.ended),
  }));
}

interface WindowView {
  sourceKind: string;
  sourceId: string;
  tenantId: string;
  meter: string;
  quantity: number;
  start: number;
  key: string;
  tags: Record<string, string>;
}

async function windows(world: GceWorld, sourceKind?: string): Promise<WindowView[]> {
  const { rows } = await world.fixture.database.query<{
    source_kind: string;
    source_id: string;
    tenant_id: string;
    meter: string;
    quantity: string;
    start_ms: number;
    idempotency_key: string;
    tags: Record<string, string> | string;
  }>(
    `SELECT source_kind, source_id, tenant_id, meter, quantity::text, idempotency_key, tags,
            (extract(epoch FROM window_start) * 1000)::float8 AS start_ms
       FROM usage_windows WHERE ($1::text IS NULL OR source_kind = $1)
      ORDER BY window_start, meter, source_id`,
    [sourceKind ?? null],
  );
  return rows.map((row) => ({
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    tenantId: row.tenant_id,
    meter: row.meter,
    quantity: Number(row.quantity),
    start: Number(row.start_ms),
    key: row.idempotency_key,
    tags: typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags,
  }));
}

const sum = (list: readonly WindowView[], meter: string) =>
  Math.round(
    list.filter((item) => item.meter === meter).reduce((total, item) => total + item.quantity, 0) *
      1e6,
  ) / 1e6;

/** Runs `vps.provider-usage` (its periodic key is due after any move of 5 minutes or more). */
async function meterInstances(world: GceWorld): Promise<void> {
  await world.tick('vps.provider-usage', 2);
}

// --- Task 9: reserved-rate metering (D8) -----------------------------------------------------------

describe('reserved', () => {
  it('an instance admitted against a reservation meters vm.reserved.* lines', async () => {
    const world = await gceWorld();
    await seedReservation(world);
    const created = await createIn(world, 'acme', 'vm-rsv');
    const plain = await createIn(world, 'acme', 'vm-plain', 'a2.highgpu.1g');
    const h0 = nextHour(world);
    await moveTo(world, h0 - 1_000);
    await step(world, 1_000);
    const [open] = await intervals(world, created.id);
    expect(open).toMatchObject({ phase: 'running', started: h0 });
    expect(open!.shape).toMatchObject({ reserved: true, granted: false });
    expect((await intervals(world, plain.id))[0]!.shape).toMatchObject({ reserved: false });

    await moveTo(world, h0 + 2 * HOUR + settle);
    await meterInstances(world);
    const rows = await windows(world, 'instance');
    const reserved = rows.filter((row) => row.sourceId === created.id);
    expect(new Set(reserved.map((row) => row.meter))).toEqual(
      new Set([
        'vm.reserved.vcpu.hours',
        'vm.reserved.memory.gib.hours',
        'vm.reserved.gpu.a100.hours',
        'vm.instance.hours',
      ]),
    );
    expect(sum(reserved, 'vm.reserved.vcpu.hours')).toBe(24);
    expect(sum(reserved, 'vm.reserved.gpu.a100.hours')).toBe(2);
    // The on-demand instance next to it keeps the plain meters: no reserved line, no on-demand line crossed over.
    const onDemand = rows.filter((row) => row.sourceId === plain.id);
    expect(onDemand.some((row) => row.meter.startsWith('vm.reserved.'))).toBe(false);
    expect(sum(onDemand, 'vm.vcpu.hours')).toBe(24);
    expect(reserved.some((row) => row.meter === 'vm.vcpu.hours')).toBe(false);
  });

  it('binding or unbinding does not change running intervals', async () => {
    const world = await gceWorld();
    await seedReservation(world);
    const created = await createIn(world, 'acme', 'vm-rsv');
    const t1 = await step(world);
    expect(await intervals(world, created.id)).toMatchObject([
      { phase: 'running', started: t1, ended: null, shape: { reserved: true } },
    ]);
    // Unbinding archives the flavor the instance uses; its interval and shape stay as they opened.
    await world.api.providerAccounts.unbindReservation(world.root, {
      tenantId: world.rootTenant,
      accountId: world.accountId,
      reservationId: RSV,
    });
    await step(world, 60_000);
    await step(world, 60_000);
    expect(await intervals(world, created.id)).toMatchObject([
      { phase: 'running', started: t1, ended: null, shape: { reserved: true } },
    ]);
    // Binding it again (a new flavor) changes nothing for the running instance either.
    await world.api.providerAccounts.bindReservation(world.root, {
      tenantId: world.rootTenant,
      accountId: world.accountId,
      reservationId: RSV,
      poolId: world.poolId,
      flavorName: 'rsv-again',
      idempotencyKey: 'bind-again',
    });
    await step(world, 60_000);
    expect(await intervals(world, created.id)).toHaveLength(1);
    // An instance created on a plain flavor after the binding is not reserved: the shape follows admission only.
    const plain = await createIn(world, 'acme', 'vm-plain', 'a2.highgpu.1g');
    await step(world);
    expect((await intervals(world, plain.id))[0]!.shape).toMatchObject({ reserved: false });
  });
});

// --- Task 10: reservation grants, API and admission (D7) --------------------------------------------

interface GrantView {
  id: string;
  accountId: string;
  reservationId: string;
  tenantId: string;
  projectId?: string;
  poolId?: string;
  slots: number;
  startsAt: number;
  endsAt: number;
  state: string;
  meteredUntil: number;
  createdAt: number;
}

const DAY = 24 * HOUR;
const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => 'allowed',
    (error: { code?: string }) => error?.code ?? String(error),
  );

/** A world whose reservation (4 slots by default) is bound, offered to acme and to other. */
async function grantWorld(extra: Partial<ExternalReservation> = {}) {
  const world = await gceWorld();
  const { other } = world.fixture.tenants;
  world.fixture.iam.allow({ token: other.token });
  await world.api.pools.offer(world.root, {
    tenantId: world.rootTenant,
    poolId: world.poolId,
    toTenantId: other.id,
    quota: { vcpu: 512, memoryGiB: 4096, diskGiB: 1000, gpu: 16 },
  });
  await seedReservation(world, extra);
  return world;
}

function grant(
  world: GceWorld,
  input: { to: 'acme' | 'other'; slots: number; key: string } & Partial<{
    startsAt: number;
    endsAt: number;
    projectId: string;
  }>,
): Promise<GrantView> {
  const now = world.fixture.clock.now();
  return world.api.reservationGrants.create(world.root, {
    tenantId: world.rootTenant,
    accountId: world.accountId,
    reservationId: RSV,
    grantTenantId: world.fixture.tenants[input.to].id,
    slots: input.slots,
    startsAt: input.startsAt ?? now,
    endsAt: input.endsAt ?? now + 30 * DAY,
    ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
    idempotencyKey: input.key,
  });
}

const endGrant = (world: GceWorld, grantId: string): Promise<GrantView> =>
  world.api.reservationGrants.end(world.root, {
    tenantId: world.rootTenant,
    accountId: world.accountId,
    grantId,
  });

const grantOf = async (world: GceWorld, instanceId: string) =>
  (
    await world.fixture.database.query<{
      reservation_grant_id: string | null;
      provider_reservation: string | null;
    }>(`SELECT reservation_grant_id, provider_reservation FROM instances WHERE id = $1`, [
      instanceId,
    ])
  ).rows[0]!;

describe('grants', () => {
  it('root grants 2 of 4 slots to A for a month', async () => {
    const world = await grantWorld();
    const now = world.fixture.clock.now();
    const created = await grant(world, { to: 'acme', slots: 2, key: 'g-1' });
    expect(created).toMatchObject({
      accountId: world.accountId,
      reservationId: RSV,
      tenantId: world.acmeTenant,
      poolId: world.poolId,
      slots: 2,
      startsAt: now,
      endsAt: now + 30 * DAY,
      state: 'active',
      meteredUntil: now,
    });
    expect(created.id).toMatch(/^rgrant_/);
    // A retry replays; another request under the key is a CONFLICT.
    expect(await grant(world, { to: 'acme', slots: 2, key: 'g-1' })).toEqual(created);
    expect(await codeOf(grant(world, { to: 'acme', slots: 1, key: 'g-1' }))).toBe('CONFLICT');
    // Root reads it; A reads it in its own tenant.
    expect(
      await world.api.reservationGrants.get(world.root, {
        tenantId: world.rootTenant,
        grantId: created.id,
      }),
    ).toEqual(created);
    expect(
      await world.api.reservationGrants.get(world.acme, {
        tenantId: world.acmeTenant,
        grantId: created.id,
      }),
    ).toEqual(created);
    // The 2 left are all that can still be granted over that term.
    const refused = await grant(world, { to: 'other', slots: 3, key: 'g-2' }).catch(
      (error: unknown) => error,
    );
    expect(refused).toMatchObject({
      code: 'CAPACITY_UNAVAILABLE',
      details: { total: 4, granted: 2 },
    });
    await grant(world, { to: 'other', slots: 2, key: 'g-3' });
    // A term that does not overlap is free again.
    await grant(world, {
      to: 'other',
      slots: 4,
      key: 'g-4',
      startsAt: now + 31 * DAY,
      endsAt: now + 40 * DAY,
    });
    const events = await world.events('reservation-grant.created');
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      type: 'reservation-grant.created',
      tenantId: world.acmeTenant,
      data: { grantId: created.id, slots: 2, startsAt: now, endsAt: now + 30 * DAY },
    });
  });

  it('refuses grants the reservation or the pool cannot carry', async () => {
    const world = await grantWorld();
    const now = world.fixture.clock.now();
    // More than 5 minutes in the past, an empty term, no slots.
    expect(
      await codeOf(grant(world, { to: 'acme', slots: 1, key: 'p', startsAt: now - 6 * MINUTE })),
    ).toBe('INVALID_INPUT');
    expect(
      await codeOf(grant(world, { to: 'acme', slots: 1, key: 'q', startsAt: now - 4 * MINUTE })),
    ).toBe('allowed');
    expect(await codeOf(grant(world, { to: 'acme', slots: 1, key: 'e', endsAt: now }))).toBe(
      'INVALID_INPUT',
    );
    expect(await codeOf(grant(world, { to: 'acme', slots: 0, key: 'z' }))).toBe('INVALID_INPUT');
    // A pool not offered to the grantee.
    await world.api.pools.unoffer(world.root, {
      tenantId: world.rootTenant,
      poolId: world.poolId,
      toTenantId: world.fixture.tenants.other.id,
    });
    expect(await codeOf(grant(world, { to: 'other', slots: 1, key: 'o' }))).toBe('INVALID_INPUT');
    // An unbound reservation.
    await world.api.providerAccounts.unbindReservation(world.root, {
      tenantId: world.rootTenant,
      accountId: world.accountId,
      reservationId: RSV,
    });
    expect(await codeOf(grant(world, { to: 'acme', slots: 1, key: 'u' }))).toBe('INVALID_STATE');
  });

  it('over-granting is refused by the database', async () => {
    const world = await grantWorld();
    const outcomes = await Promise.allSettled([
      grant(world, { to: 'acme', slots: 3, key: 'race-a' }),
      grant(world, { to: 'other', slots: 2, key: 'race-b' }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const refused = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
    );
    expect(refused).toHaveLength(1);
    expect(refused[0]!.reason).toMatchObject({ code: 'CAPACITY_UNAVAILABLE' });
    const { rows } = await world.fixture.database.query<{ granted: string }>(
      `SELECT coalesce(sum(slots), 0)::text AS granted FROM reservation_grants`,
    );
    expect(Number(rows[0]!.granted)).toBeLessThanOrEqual(4);
  });

  it('A is admitted into its grant first', async () => {
    const world = await grantWorld();
    const g = await grant(world, { to: 'acme', slots: 2, key: 'g' });
    const first = await createIn(world, 'acme', 'a-1');
    const second = await createIn(world, 'acme', 'a-2');
    expect(await grantOf(world, first.id)).toEqual({
      reservation_grant_id: g.id,
      provider_reservation: RSV,
    });
    expect((await grantOf(world, second.id)).reservation_grant_id).toBe(g.id);
  });

  it("B cannot take A's granted slots", async () => {
    const world = await grantWorld();
    await grant(world, { to: 'acme', slots: 2, key: 'g' });
    // A is idle: its 2 slots stay reserved for it.
    const b1 = await createIn(world, 'other', 'b-1');
    await createIn(world, 'other', 'b-2');
    expect(await grantOf(world, b1.id)).toEqual({
      reservation_grant_id: null,
      provider_reservation: RSV,
    });
    const refused = await createIn(world, 'other', 'b-3').catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: 'CAPACITY_UNAVAILABLE' });
    // A still gets both of its slots.
    await createIn(world, 'acme', 'a-1');
    await createIn(world, 'acme', 'a-2');
  });

  it('A beyond its grant falls back to outside slots', async () => {
    const world = await grantWorld();
    const g = await grant(world, { to: 'acme', slots: 2, key: 'g' });
    const inside = [await createIn(world, 'acme', 'a-1'), await createIn(world, 'acme', 'a-2')];
    const outside = [await createIn(world, 'acme', 'a-3'), await createIn(world, 'acme', 'a-4')];
    for (const created of inside)
      expect((await grantOf(world, created.id)).reservation_grant_id).toBe(g.id);
    for (const created of outside)
      expect(await grantOf(world, created.id)).toEqual({
        reservation_grant_id: null,
        provider_reservation: RSV,
      });
    // All 4 slots are taken: a fifth is refused, for A as for B.
    expect(await codeOf(createIn(world, 'acme', 'a-5'))).toBe('CAPACITY_UNAVAILABLE');
    expect(await codeOf(createIn(world, 'other', 'b-1'))).toBe('CAPACITY_UNAVAILABLE');
    // A grant slot freed by a delete goes back to the grant, not to outsiders.
    await world.api.instances.delete(world.acme, {
      tenantId: world.acmeTenant,
      instanceId: inside[0]!.id,
    });
    await step(world);
    expect(await codeOf(createIn(world, 'other', 'b-2'))).toBe('CAPACITY_UNAVAILABLE');
    const back = await createIn(world, 'acme', 'a-6');
    expect((await grantOf(world, back.id)).reservation_grant_id).toBe(g.id);
  });

  it('a project grant serves only that project', async () => {
    const world = await grantWorld();
    await grant(world, {
      to: 'acme',
      slots: 1,
      key: 'g',
      projectId: 'prj_01jz0000000000000000000000',
    });
    // An instance with no project is not in the project's grant, and the slot stays the project's.
    const created = await createIn(world, 'acme', 'a-1');
    expect((await grantOf(world, created.id)).reservation_grant_id).toBeNull();
    await createIn(world, 'acme', 'a-2');
    await createIn(world, 'acme', 'a-3');
    expect(await codeOf(createIn(world, 'acme', 'a-4'))).toBe('CAPACITY_UNAVAILABLE');
  });

  it('a tenant cannot create a grant and sees only its own', async () => {
    const world = await grantWorld();
    const { acme, other } = world.fixture.tenants;
    const now = world.fixture.clock.now();
    const attempt = (tenantId: string) =>
      world.api.reservationGrants.create(world.acme, {
        tenantId,
        accountId: world.accountId,
        reservationId: RSV,
        grantTenantId: acme.id,
        slots: 1,
        startsAt: now,
        endsAt: now + DAY,
        idempotencyKey: `self-${tenantId}`,
      });
    expect(await codeOf(attempt(acme.id))).toBe('ACCESS_DENIED');
    expect(await codeOf(attempt(world.rootTenant))).toBe('ACCESS_DENIED');
    expect((await world.fixture.database.query(`SELECT 1 FROM reservation_grants`)).rows).toEqual(
      [],
    );

    const mine = await grant(world, { to: 'acme', slots: 1, key: 'g-a' });
    const theirs = await grant(world, { to: 'other', slots: 1, key: 'g-b' });
    const listed = (await world.api.reservationGrants.list(world.acme, {
      tenantId: acme.id,
    })) as { items: GrantView[] };
    expect(listed.items.map((item) => item.id)).toEqual([mine.id]);
    expect(
      await codeOf(world.api.reservationGrants.list(world.acme, { tenantId: acme.id, all: true })),
    ).toBe('ACCESS_DENIED');
    expect(
      await codeOf(
        world.api.reservationGrants.get(world.acme, { tenantId: acme.id, grantId: theirs.id }),
      ),
    ).toBe('NOT_FOUND');
    // Root sees every grant with all; without it, its own tenant's (none).
    const all = (await world.api.reservationGrants.list(world.root, {
      tenantId: world.rootTenant,
      all: true,
    })) as { items: GrantView[] };
    expect(new Set(all.items.map((item) => item.id))).toEqual(new Set([mine.id, theirs.id]));
    const own = (await world.api.reservationGrants.list(world.root, {
      tenantId: world.rootTenant,
    })) as { items: GrantView[] };
    expect(own.items).toEqual([]);
    // Nor can a tenant end a grant, its own included.
    for (const grantId of [mine.id, theirs.id])
      expect(
        await codeOf(
          world.api.reservationGrants.end(
            { token: other.token },
            { tenantId: world.rootTenant, accountId: world.accountId, grantId },
          ),
        ),
      ).toBe('ACCESS_DENIED');
  });

  it('ending a grant mid-term', async () => {
    const world = await grantWorld();
    const g = await grant(world, { to: 'acme', slots: 2, key: 'g' });
    await world.fixture.advance(3 * HOUR);
    const now = world.fixture.clock.now();
    const ended = await endGrant(world, g.id);
    expect(ended).toMatchObject({ id: g.id, startsAt: g.startsAt, endsAt: now, state: 'ended' });
    // Ending again changes nothing, later too: an end never moves.
    await world.fixture.advance(HOUR);
    expect(await endGrant(world, g.id)).toEqual(ended);
    // A's slots are free for anyone again.
    for (const key of ['b-1', 'b-2', 'b-3', 'b-4']) await createIn(world, 'other', key);
    expect((await world.events('reservation-grant.')).map((event) => event.type)).toEqual([
      'reservation-grant.created',
      'reservation-grant.active',
      'reservation-grant.ended',
    ]);
  });

  it('ending a grant before it starts cancels it', async () => {
    const world = await grantWorld();
    const now = world.fixture.clock.now();
    const term = { startsAt: now + DAY, endsAt: now + 2 * DAY };
    const g = await grant(world, { to: 'acme', slots: 4, key: 'g', ...term });
    expect(g.state).toBe('scheduled');
    // Until it starts, its slots are anyone's.
    await createIn(world, 'other', 'b-1');
    expect(await endGrant(world, g.id)).toMatchObject({ state: 'cancelled', ...term });
    // Its term can be granted again.
    await grant(world, { to: 'other', slots: 4, key: 'g-2', ...term });
  });
});

// --- Task 11: grant billing -------------------------------------------------------------------------

describe('billing', () => {
  const SLOT = 'vm.grant.slot.hours';
  const USAGE = 'vm.grant.usage.hours';

  /** Runs `vps.grants` (its periodic key is due after any move of 5 minutes or more). */
  const settleGrants = (world: GceWorld) => world.tick('vps.grants', 2);

  const stateOf = async (world: GceWorld, grantId: string) =>
    (
      (await world.api.reservationGrants.get(world.root, {
        tenantId: world.rootTenant,
        grantId,
      })) as GrantView
    ).state;

  /** Creates an instance and observes it running at `at` (never before the clock). */
  async function runningAt(world: GceWorld, key: string, at: number) {
    const created = await createIn(world, 'acme', key);
    await moveTo(world, at - 1_000);
    await step(world, 1_000);
    return created;
  }

  it('is a singleton periodic reconciler', () => {
    expect(
      vps({ providers: [] }).reconcilers!.find((item) => item.name === 'vps.grants'),
    ).toMatchObject({ shardBy: 'none', periodic: [{ key: 'all', every: '5m' }] });
  });

  it('a 2-slot grant bills 2 slot-hours every hour, used or not', async () => {
    const world = await grantWorld();
    const h0 = nextHour(world);
    // Granted ahead of its term: scheduled until h0.
    const g = await grant(world, {
      to: 'acme',
      slots: 2,
      key: 'g',
      startsAt: h0,
      endsAt: h0 + 30 * DAY,
    });
    expect(g.state).toBe('scheduled');
    await moveTo(world, h0 + MINUTE);
    await settleGrants(world);
    expect(await stateOf(world, g.id)).toBe('active');
    // Hour 1: idle. Hour 2: one instance. Hour 3: two.
    await runningAt(world, 'a-1', h0 + HOUR);
    await runningAt(world, 'a-2', h0 + 2 * HOUR);
    await moveTo(world, h0 + 3 * HOUR + MINUTE);
    await settleGrants(world);
    const rows = await windows(world, 'grant');
    expect(rows.map((row) => [row.start, row.meter, row.quantity])).toEqual([
      [h0, SLOT, 2],
      [h0 + HOUR, SLOT, 2],
      [h0 + 2 * HOUR, SLOT, 2],
    ]);
    expect(sum(rows, SLOT)).toBe(6);
    for (const row of rows) {
      expect(row.key).toBe(`cmp:grant:${g.id}:${row.start}:${SLOT}`);
      expect(row.sourceId).toBe(g.id);
      expect(row.tenantId).toBe(world.acmeTenant);
      expect(row.tags).toEqual({
        region: 'us-central1',
        pool: world.poolId,
        provider: 'fake-gce',
        source: 'grant',
      });
    }
    // The watermark moved with what was written; another pass adds nothing.
    const after = (await world.api.reservationGrants.get(world.root, {
      tenantId: world.rootTenant,
      grantId: g.id,
    })) as GrantView;
    expect(after.meteredUntil).toBe(h0 + 3 * HOUR);
    await world.fixture.advance(10 * MINUTE);
    await settleGrants(world);
    expect(await windows(world, 'grant')).toHaveLength(3);
    expect((await world.events('reservation-grant.')).map((event) => event.type)).toEqual([
      'reservation-grant.created',
      'reservation-grant.active',
    ]);
  });

  it('instances inside a grant record no compute meters', async () => {
    const world = await grantWorld();
    const h0 = nextHour(world);
    await grant(world, { to: 'acme', slots: 2, key: 'g' });
    const created = await runningAt(world, 'a-1', h0);
    expect((await intervals(world, created.id))[0]!.shape).toMatchObject({
      reserved: true,
      granted: true,
    });
    await moveTo(world, h0 + 2 * HOUR + settle);
    await meterInstances(world);
    const rows = (await windows(world, 'instance')).filter((row) => row.sourceId === created.id);
    expect(rows.map((row) => [row.start, row.meter, row.quantity])).toEqual([
      [h0, USAGE, 1],
      [h0 + HOUR, USAGE, 1],
    ]);
  });

  it('an instance outside the grant (overflow) meters vm.reserved.*', async () => {
    const world = await grantWorld();
    const h0 = nextHour(world);
    await grant(world, { to: 'acme', slots: 1, key: 'g' });
    const inside = await createIn(world, 'acme', 'a-1');
    const overflow = await createIn(world, 'acme', 'a-2');
    expect((await grantOf(world, overflow.id)).reservation_grant_id).toBeNull();
    await moveTo(world, h0 - 1_000);
    await step(world, 1_000);
    await moveTo(world, h0 + HOUR + settle);
    await meterInstances(world);
    const rows = await windows(world, 'instance');
    expect(
      rows.filter((row) => row.sourceId === inside.id).map((row) => [row.meter, row.quantity]),
    ).toEqual([[USAGE, 1]]);
    expect(
      rows.filter((row) => row.sourceId === overflow.id).map((row) => [row.meter, row.quantity]),
    ).toEqual([
      ['vm.instance.hours', 1],
      ['vm.reserved.gpu.a100.hours', 1],
      ['vm.reserved.memory.gib.hours', 85],
      ['vm.reserved.vcpu.hours', 12],
    ]);
  });

  it('an ended grant stops billing at ends_at', async () => {
    const world = await grantWorld();
    const h0 = nextHour(world);
    await moveTo(world, h0);
    const g = await grant(world, { to: 'acme', slots: 2, key: 'g' });
    expect(g.startsAt).toBe(h0);
    const created = await runningAt(world, 'a-1', h0 + 2_000);
    await moveTo(world, h0 + 90 * MINUTE);
    const ended = await endGrant(world, g.id);
    expect(ended).toMatchObject({ state: 'ended', endsAt: h0 + 90 * MINUTE });
    // The instance leaves the grant at its end: the grant's usage line before, compute meters after.
    const list = await intervals(world, created.id);
    expect(list.map((item) => [item.shape.granted, item.started, item.ended])).toEqual([
      [true, h0 + 2_000, h0 + 90 * MINUTE],
      [false, h0 + 90 * MINUTE, null],
    ]);

    await moveTo(world, h0 + 4 * HOUR + settle);
    await settleGrants(world);
    await meterInstances(world);
    const slots = await windows(world, 'grant');
    expect(slots.map((row) => [row.start, row.quantity])).toEqual([
      [h0, 2],
      [h0 + HOUR, 1],
    ]);
    const used = (await windows(world, 'instance')).filter((row) => row.sourceId === created.id);
    expect(sum(used, USAGE)).toBeCloseTo(1.5 - 2_000 / HOUR, 5);
    // From 1:30 on the instance is billed at the reserved rate, and never also as granted.
    expect(sum(used, 'vm.reserved.vcpu.hours')).toBe(12 * 2.5);
    expect(
      used.filter((row) => row.start >= h0 + 2 * HOUR).every((row) => row.meter !== USAGE),
    ).toBe(true);
    // Nothing more is ever billed for the grant.
    await world.fixture.advance(DAY);
    await settleGrants(world);
    expect(await windows(world, 'grant')).toHaveLength(2);
  });

  it('a grant whose term passes is ended by the reconciler, and its instances leave it', async () => {
    const world = await grantWorld();
    const h0 = nextHour(world);
    await moveTo(world, h0);
    const g = await grant(world, { to: 'acme', slots: 1, key: 'g', endsAt: h0 + 2 * HOUR });
    const created = await runningAt(world, 'a-1', h0 + 2_000);
    await moveTo(world, h0 + 2 * HOUR + 3 * MINUTE);
    await settleGrants(world);
    expect(await stateOf(world, g.id)).toBe('ended');
    expect(
      (await intervals(world, created.id)).map((item) => [item.shape.granted, item.started]),
    ).toEqual([
      [true, h0 + 2_000],
      [false, h0 + 2 * HOUR],
    ]);
    expect(sum(await windows(world, 'grant'), SLOT)).toBe(2);
    expect((await world.events('reservation-grant.')).map((event) => event.type)).toEqual([
      'reservation-grant.created',
      'reservation-grant.active',
      'reservation-grant.ended',
    ]);
  });
});
