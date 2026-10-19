import { afterEach, describe, expect, it } from 'vitest';
import { meterCatalog, defaultMeterGpuModels, type ExternalMachine } from '@better-compute/core';
import { closeFixtures } from '@better-compute/testing';
import {
  meterLinesFor,
  meterNetworks,
  type BillableShape,
  type BillingMode,
} from '@better-compute/vps';
import { fakeGceProvider, gceWorld, type FakeGce, type GceWorld } from './support/vps-gce.js';

// Platform compute billing, phase 4 (D9): tenant networks and public IPs (Task 12), then disks and snapshots
// (Task 13). Networks and snapshots are `vps.ancillary-usage` sources; a public address and a disk are lines
// of the instance's own interval, metered by `vps.provider-usage` under the instance source.

const HOUR = 3_600_000;
const grace = 5 * 60_000;
const settle = grace + 60_000;
const usageJob = 'vps.provider-usage';
const ancillaryJob = 'vps.ancillary-usage';

const base: BillableShape = {
  vcpu: 4,
  memoryGiB: 16,
  spot: false,
  reserved: false,
  granted: false,
};

async function moveTo(world: GceWorld, at: number): Promise<void> {
  const now = world.fixture.clock.now();
  if (at > now) await world.fixture.advance(at - now);
}

const nextHour = (world: GceWorld) => (Math.floor(world.fixture.clock.now() / HOUR) + 1) * HOUR;

/** One `vps.instances` pass after `ms` of sim time; returns the time it ran at. */
async function step(world: GceWorld, ms = 1_000): Promise<number> {
  const at = await world.fixture.advance(ms);
  await world.tick('vps.instances', 1);
  return at;
}

const viewOf = (world: GceWorld, instanceId: string) =>
  world.api.instances.get(world.acme, { tenantId: world.acmeTenant, instanceId });

async function createVm(world: GceWorld, key = 'vm-1') {
  return world.api.instances.create(world.acme, {
    tenantId: world.acmeTenant,
    poolId: world.poolId,
    flavor: 'a2.highgpu.1g',
    imageId: 'debian-12',
    idempotencyKey: key,
  });
}

/** A created VM observed running exactly at a top of the hour; returns that hour and the provider machine. */
async function runningAtHour(world: GceWorld, key = 'vm-1') {
  const created = await createVm(world, key);
  const h0 = nextHour(world);
  await moveTo(world, h0 - 1_000);
  await step(world, 1_000);
  const view = await viewOf(world, created.id);
  expect(view.state).toBe('running');
  const machine = world.cloud.machines.get(view.externalId as string)!;
  return { created, h0, machine };
}

interface WindowView {
  kind: string;
  sourceId: string;
  tenantId: string;
  identityId: string | null;
  key: string;
  meter: string;
  quantity: number;
  start: number;
  end: number;
  tags: Record<string, string>;
}

async function windowsOf(world: GceWorld, kind: string, sourceId?: string): Promise<WindowView[]> {
  const { rows } = await world.fixture.database.query<{
    source_kind: string;
    source_id: string;
    tenant_id: string;
    identity_id: string | null;
    idempotency_key: string;
    meter: string;
    quantity: string;
    start_ms: number;
    end_ms: number;
    tags: Record<string, string> | string;
  }>(
    `SELECT source_kind, source_id, tenant_id, identity_id, idempotency_key, meter, quantity::text,
            (extract(epoch FROM window_start) * 1000)::float8 AS start_ms,
            (extract(epoch FROM window_end) * 1000)::float8 AS end_ms, tags
       FROM usage_windows
      WHERE source_kind = $1 AND ($2::text IS NULL OR source_id = $2)
      ORDER BY window_start, meter, source_id`,
    [kind, sourceId ?? null],
  );
  return rows.map((row) => ({
    kind: row.source_kind,
    sourceId: row.source_id,
    tenantId: row.tenant_id,
    identityId: row.identity_id,
    key: row.idempotency_key,
    meter: row.meter,
    quantity: Number(row.quantity),
    start: Number(row.start_ms),
    end: Number(row.end_ms),
    tags: typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags,
  }));
}

const sum = (list: readonly WindowView[], meter: string) =>
  Math.round(
    list.filter((item) => item.meter === meter).reduce((total, item) => total + item.quantity, 0) *
      1e6,
  ) / 1e6;

/** The pass of `job` after `advanceMs` of sim time. */
async function meter(world: GceWorld, job: string, advanceMs = 0): Promise<void> {
  if (advanceMs > 0) await world.fixture.advance(advanceMs);
  await world.tick(job, 2);
}

/** A tenant network row, as `networks.*` and the `vps.networks` reconciler leave it. */
async function insertNetwork(
  world: GceWorld,
  fields: {
    id: string;
    state: 'pending' | 'ready' | 'deleting' | 'deleted' | 'error';
    provisionedAt: number | null;
    tenantId?: string;
    poolId?: string;
    accountId?: string;
    projectId?: string;
  },
): Promise<void> {
  await world.fixture.database.query(
    `INSERT INTO networks (id, tenant_id, project_id, pool_id, provider_account_id, name, state, desired_state,
                           provisioned_at, created_by, idempotency_key, request_hash, version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'present',
             CASE WHEN $8::float8 IS NULL THEN NULL ELSE to_timestamp($8::float8 / 1000) END,
             'usr_x', $1, '\\x00', 1)`,
    [
      fields.id,
      fields.tenantId ?? world.acmeTenant,
      fields.projectId ?? null,
      fields.poolId ?? world.poolId,
      fields.accountId ?? world.accountId,
      fields.id,
      fields.state,
      fields.provisionedAt,
    ],
  );
}

describe('networks (D9)', () => {
  afterEach(closeFixtures);

  it('a provisioned network bills vpc hours until deleted', async () => {
    const world = await gceWorld();
    const h0 = nextHour(world);
    await moveTo(world, h0);
    await insertNetwork(world, { id: 'net_a', state: 'ready', provisionedAt: h0 });

    // Three whole hours later (and past the grace): the three ended hours are written, once.
    await moveTo(world, h0 + 3 * HOUR + settle);
    await meter(world, ancillaryJob);
    let rows = await windowsOf(world, 'network', 'net_a');
    expect(rows.map((row) => [row.start, row.meter, row.quantity])).toEqual([
      [h0, 'network.vpc.hours', 1],
      [h0 + HOUR, 'network.vpc.hours', 1],
      [h0 + 2 * HOUR, 'network.vpc.hours', 1],
    ]);
    expect(rows[0]).toMatchObject({
      kind: 'network',
      tenantId: world.acmeTenant,
      identityId: null,
      key: `cmp:network:net_a:${h0}:network.vpc.hours`,
      end: h0 + HOUR,
      tags: { pool: world.poolId, provider: 'fake-gce', source: 'network' },
    });

    // A repeated pass writes nothing more.
    const before = JSON.stringify(rows);
    await meter(world, ancillaryJob, 60_000);
    expect(JSON.stringify(await windowsOf(world, 'network', 'net_a'))).toBe(before);

    // Deleted half way through the fourth hour: its half hour is written once the hour is over, and no more.
    await moveTo(world, h0 + 3 * HOUR + 30 * 60_000);
    await world.fixture.database.query(`UPDATE networks SET state = 'deleted' WHERE id = 'net_a'`);
    await meter(world, ancillaryJob);
    expect(await windowsOf(world, 'network', 'net_a')).toHaveLength(3);
    await moveTo(world, h0 + 8 * HOUR);
    await meter(world, ancillaryJob);
    rows = await windowsOf(world, 'network', 'net_a');
    expect(rows.map((row) => [row.start, row.quantity])).toEqual([
      [h0, 1],
      [h0 + HOUR, 1],
      [h0 + 2 * HOUR, 1],
      [h0 + 3 * HOUR, 0.5],
    ]);
    await meter(world, ancillaryJob, 5 * HOUR);
    expect(await windowsOf(world, 'network', 'net_a')).toHaveLength(4);
  });

  it('a never-provisioned network bills nothing', async () => {
    const world = await gceWorld();
    const h0 = nextHour(world);
    await moveTo(world, h0);
    await insertNetwork(world, { id: 'net_pending', state: 'pending', provisionedAt: null });
    await insertNetwork(world, { id: 'net_error', state: 'error', provisionedAt: null });
    await meter(world, ancillaryJob, 6 * HOUR);
    expect(await windowsOf(world, 'network')).toEqual([]);
  });

  it('a network that is being deleted still bills; one stuck in error after provisioning too', async () => {
    const world = await gceWorld();
    const h0 = nextHour(world);
    await moveTo(world, h0);
    await insertNetwork(world, { id: 'net_del', state: 'deleting', provisionedAt: h0 });
    await insertNetwork(world, { id: 'net_err', state: 'error', provisionedAt: h0 });
    await moveTo(world, h0 + HOUR + settle);
    await meter(world, ancillaryJob);
    const rows = await windowsOf(world, 'network');
    expect(
      sum(
        rows.filter((row) => row.sourceId === 'net_del'),
        'network.vpc.hours',
      ),
    ).toBe(1);
    expect(
      sum(
        rows.filter((row) => row.sourceId === 'net_err'),
        'network.vpc.hours',
      ),
    ).toBe(1);
  });

  it('the first partial hour bills its share', async () => {
    const world = await gceWorld();
    const h0 = nextHour(world);
    await moveTo(world, h0 + 45 * 60_000);
    await insertNetwork(world, { id: 'net_p', state: 'ready', provisionedAt: h0 + 45 * 60_000 });
    await moveTo(world, h0 + HOUR + settle);
    await meter(world, ancillaryJob);
    expect(
      (await windowsOf(world, 'network', 'net_p')).map((row) => [row.start, row.quantity]),
    ).toEqual([[h0, 0.25]]);
  });

  it('BYO networks bill nothing', async () => {
    const byo: FakeGce = { machines: new Map(), requests: [] };
    const world = await gceWorld({ providers: [fakeGceProvider(byo, 'fake-gce-byo')] });
    const account = await world.api.providerAccounts.create(world.acme, {
      tenantId: world.acmeTenant,
      provider: 'fake-gce-byo',
      name: 'acme-gcp',
      config: {},
    });
    const site = await world.api.sites.create(world.acme, {
      tenantId: world.acmeTenant,
      kind: 'custom',
      region: 'us-central1',
      idempotencyKey: 'acme-site',
    });
    const pool = await world.api.pools.create(world.acme, {
      tenantId: world.acmeTenant,
      siteId: site.id,
      class: 'provider',
      providerAccountId: account.id,
      ownerQuota: { vcpu: 100, memoryGiB: 1000, diskGiB: 10_000, gpu: 8 },
      idempotencyKey: 'acme-pool',
    });
    const h0 = nextHour(world);
    await moveTo(world, h0);
    await insertNetwork(world, {
      id: 'net_byo',
      state: 'ready',
      provisionedAt: h0,
      poolId: pool.id,
      accountId: account.id,
    });
    await insertNetwork(world, { id: 'net_root', state: 'ready', provisionedAt: h0 });
    await moveTo(world, h0 + 2 * HOUR + settle);
    await meter(world, ancillaryJob);
    const rows = await windowsOf(world, 'network');
    // Only the platform's own pool bills; the tenant's cloud account pays its provider directly.
    expect(new Set(rows.map((row) => row.sourceId))).toEqual(new Set(['net_root']));
    expect(sum(rows, 'network.vpc.hours')).toBe(2);
    // The watermark moved on: switching the pool's mode later does not bill the hours before it.
    const { rows: marks } = await world.fixture.database.query<{ id: string; caught_up: boolean }>(
      `SELECT id, metered_until >= to_timestamp($1::float8 / 1000) AS caught_up FROM networks ORDER BY id`,
      [h0 + 2 * HOUR],
    );
    expect(marks).toEqual([
      { id: 'net_byo', caught_up: true },
      { id: 'net_root', caught_up: true },
    ]);
  });

  it('pool billing mode none or platform-fee bills no network hours', async () => {
    const world = await gceWorld();
    const h0 = nextHour(world);
    await moveTo(world, h0);
    await insertNetwork(world, { id: 'net_m', state: 'ready', provisionedAt: h0 });
    await world.fixture.database.query(
      `UPDATE pools SET policy = policy || '{"billing":{"mode":"none"}}'::jsonb WHERE id = $1`,
      [world.poolId],
    );
    await moveTo(world, h0 + 2 * HOUR + settle);
    await meter(world, ancillaryJob);
    expect(await windowsOf(world, 'network')).toEqual([]);
    await world.fixture.database.query(
      `UPDATE pools SET policy = policy || '{"billing":{"mode":"platform-fee"}}'::jsonb WHERE id = $1`,
      [world.poolId],
    );
    await meter(world, ancillaryJob, 2 * HOUR);
    expect(await windowsOf(world, 'network')).toEqual([]);
  });

  it('without a known root tenant a provider pool is not known to be the platform’s: nothing bills', async () => {
    const world = await gceWorld();
    const h0 = nextHour(world);
    await moveTo(world, h0);
    await insertNetwork(world, { id: 'net_x', state: 'ready', provisionedAt: h0 });
    await moveTo(world, h0 + 2 * HOUR + settle);
    const now = world.fixture.clock.now();
    // Fail closed (B8): no root tenant means every provider pool reads as a tenant's own (BYO).
    await world.fixture.database.transaction((tx) => meterNetworks(tx, now, {}));
    expect(await windowsOf(world, 'network')).toEqual([]);
    await world.fixture.database.transaction((tx) =>
      meterNetworks(tx, now, { rootTenantId: world.rootTenant }),
    );
    // The watermark moved with the first call: the hours it skipped stay skipped.
    expect(await windowsOf(world, 'network')).toEqual([]);
  });
});

describe('public IPs (D9)', () => {
  afterEach(closeFixtures);

  const publicNic = (address: string): Partial<ExternalMachine> => ({
    networks: [{ network: 'default', address: '10.128.0.2', publicAddress: address }],
    addresses: ['10.128.0.2', address],
  });

  const intervalsOf = async (world: GceWorld, instanceId: string) => {
    const { rows } = await world.fixture.database.query<{
      phase: string;
      shape: BillableShape | string;
      started: number;
      ended: number | null;
    }>(
      `SELECT phase, shape, (extract(epoch FROM started_at) * 1000)::float8 AS started,
              (extract(epoch FROM ended_at) * 1000)::float8 AS ended
         FROM instance_usage_intervals WHERE instance_id = $1 ORDER BY started_at`,
      [instanceId],
    );
    return rows.map((row) => ({
      phase: row.phase,
      shape: (typeof row.shape === 'string' ? JSON.parse(row.shape) : row.shape) as BillableShape,
      started: Number(row.started),
      ended: row.ended === null ? null : Number(row.ended),
    }));
  };

  it('a VM with a public IP bills ip.public.hours while running', async () => {
    const world = await gceWorld();
    const { created, h0, machine } = await runningAtHour(world);
    expect((await intervalsOf(world, created.id))[0]!.shape.publicIp).toBeUndefined();

    // The public address appears at h0+1h: the interval closes there and a new one opens with `publicIp`.
    Object.assign(machine, publicNic('34.120.0.9'));
    await moveTo(world, h0 + HOUR - 1_000);
    await step(world, 1_000);
    // It disappears at h0+3h: closed again, the address bills no longer.
    delete machine.networks;
    machine.addresses = ['10.128.0.2'];
    await moveTo(world, h0 + 3 * HOUR - 1_000);
    await step(world, 1_000);

    const list = await intervalsOf(world, created.id);
    expect(list.map((item) => [item.started, item.ended, item.shape.publicIp ?? false])).toEqual([
      [h0, h0 + HOUR, false],
      [h0 + HOUR, h0 + 3 * HOUR, true],
      [h0 + 3 * HOUR, null, false],
    ]);

    await moveTo(world, h0 + 5 * HOUR + settle);
    await meter(world, usageJob);
    const rows = await windowsOf(world, 'instance', created.id);
    expect(
      rows.filter((row) => row.meter === 'ip.public.hours').map((row) => [row.start, row.quantity]),
    ).toEqual([
      [h0 + HOUR, 1],
      [h0 + 2 * HOUR, 1],
    ]);
    // The instance's own source: the same key shape as its compute lines.
    expect(rows.find((row) => row.meter === 'ip.public.hours')!.key).toBe(
      `cmp:instance:${created.id}:${h0 + HOUR}:ip.public.hours`,
    );
    expect(sum(rows, 'vm.instance.hours')).toBe(5);
  });

  it('an address that is not public bills nothing; one found only in the address list does', async () => {
    const world = await gceWorld();
    const { created, h0, machine } = await runningAtHour(world);
    // Private, loopback, link-local and carrier-grade-NAT addresses are not public.
    Object.assign(machine, {
      networks: undefined,
      addresses: ['10.1.2.3', '172.16.0.4', '192.168.0.5', '169.254.1.1', '100.64.0.1', 'fd00::1'],
    });
    await moveTo(world, h0 + HOUR - 1_000);
    await step(world, 1_000);
    expect((await intervalsOf(world, created.id)).every((item) => !item.shape.publicIp)).toBe(true);
    // A provider with no per-interface detail: a public IPv4 among `addresses` counts.
    machine.addresses = ['10.1.2.3', '203.0.113.7'];
    await moveTo(world, h0 + 2 * HOUR - 1_000);
    await step(world, 1_000);
    const list = await intervalsOf(world, created.id);
    expect(list.at(-1)!.shape.publicIp).toBe(true);
  });

  it('a stopped VM has no public-IP line even when its address is still listed', async () => {
    const world = await gceWorld();
    const { created, h0, machine } = await runningAtHour(world);
    Object.assign(machine, publicNic('34.120.0.9'));
    await moveTo(world, h0 + HOUR - 1_000);
    await step(world, 1_000);
    await world.api.instances.stop(world.acme, {
      tenantId: world.acmeTenant,
      instanceId: created.id,
    });
    await moveTo(world, h0 + 2 * HOUR - 1_000);
    await step(world, 1_000);
    expect((await viewOf(world, created.id)).state).toBe('stopped');
    await moveTo(world, h0 + 4 * HOUR + settle);
    await meter(world, usageJob);
    const rows = await windowsOf(world, 'instance', created.id);
    expect(sum(rows, 'ip.public.hours')).toBe(1);
  });

  it('platform-fee and none modes never bill the address; granted and flavor-meter VMs still do', () => {
    const shape: BillableShape = { ...base, publicIp: true };
    const ip = { meter: 'ip.public.hours', perHour: 1 };
    expect(meterLinesFor(shape, 'platform-fee', 'running')).toEqual([
      { meter: 'vm.managed.hours', perHour: 1 },
    ]);
    expect(meterLinesFor(shape, 'none', 'running')).toEqual([]);
    expect(meterLinesFor(shape, 'metered', 'running')).toContainEqual(ip);
    // A grant covers the VM, not its address; a flavor meter replaces the composed compute lines only.
    expect(meterLinesFor({ ...shape, granted: true }, 'metered', 'running')).toEqual([
      { meter: 'vm.grant.usage.hours', perHour: 1 },
      ip,
    ]);
    expect(
      meterLinesFor({ ...shape, flavorMeter: 'flavor.x.hours' }, 'metered', 'running'),
    ).toEqual([{ meter: 'flavor.x.hours', perHour: 1 }, ip]);
    // Stopped: the address is released with the machine's power; no line.
    expect(meterLinesFor(shape, 'metered', 'stopped')).toEqual([]);
    // No address: no line.
    expect(meterLinesFor({ ...shape, publicIp: false }, 'metered', 'running')).not.toContainEqual(
      ip,
    );
  });

  it('every ancillary meter the rules emit is in meterCatalog', () => {
    const known = new Set(
      meterCatalog({ gpuModels: defaultMeterGpuModels, flavorMeters: ['flavor.x.hours'] }).map(
        (item) => item.key,
      ),
    );
    for (const key of ['network.vpc.hours', 'ip.public.hours'])
      expect(known.has(key), key).toBe(true);
    for (const mode of ['metered', 'platform-fee', 'none'] as BillingMode[])
      for (const phase of ['running', 'stopped'] as const)
        for (const granted of [false, true])
          for (const flavorMeter of [undefined, 'flavor.x.hours'])
            for (const line of meterLinesFor(
              { ...base, publicIp: true, granted, ...(flavorMeter ? { flavorMeter } : {}) },
              mode,
              phase,
            ))
              expect(known.has(line.meter), line.meter).toBe(true);
  });
});
