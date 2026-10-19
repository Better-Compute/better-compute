import { afterEach, describe, expect, it } from 'vitest';
import type { ExternalReservation } from '@better-compute/core';
import { closeFixtures } from '@better-compute/testing';
import type { BillableShape } from '@better-compute/vps';
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
