import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultMeterGpuModels,
  meterCatalog,
  meterDiskTypes,
  type ExternalMachine,
} from '@better-compute/core';
import { closeFixtures } from '@better-compute/testing';
import {
  disksOf as disksOfRecord,
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

// --- Task 13: disks and snapshots (D9) -------------------------------------------------------------

describe('disks', () => {
  afterEach(closeFixtures);

  const intervalsOfVm = async (world: GceWorld, instanceId: string) => {
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

  const hours = (rows: readonly WindowView[], meterKey: string) =>
    rows.filter((row) => row.meter === meterKey).map((row) => [row.start, row.quantity]);

  const stopAt = async (world: GceWorld, instanceId: string, at: number) => {
    await moveTo(world, at - 1_000);
    await world.api.instances.stop(world.acme, { tenantId: world.acmeTenant, instanceId });
    await step(world, 1_000);
    expect((await viewOf(world, instanceId)).state).toBe('stopped');
  };

  it('a 100 GiB boot disk bills 100 GiB-hours per hour running and stopped', async () => {
    const world = await gceWorld();
    const { created, h0 } = await runningAtHour(world);
    // The flavor's 100 GiB disk, as pd-balanced, is on the interval from the start.
    expect((await intervalsOfVm(world, created.id))[0]!.shape.disks).toEqual([
      { type: 'pd-balanced', sizeGiB: 100 },
    ]);
    await stopAt(world, created.id, h0 + 2 * HOUR);
    expect((await intervalsOfVm(world, created.id)).map((item) => item.phase)).toEqual([
      'running',
      'stopped',
    ]);

    await moveTo(world, h0 + 5 * HOUR + settle);
    await meter(world, usageJob);
    const rows = await windowsOf(world, 'instance', created.id);
    // Two running hours, then three stopped: the disk bills in all five; compute only in the running two.
    expect(hours(rows, 'disk.pd-balanced.gib.hours')).toEqual([
      [h0, 100],
      [h0 + HOUR, 100],
      [h0 + 2 * HOUR, 100],
      [h0 + 3 * HOUR, 100],
      [h0 + 4 * HOUR, 100],
    ]);
    expect(hours(rows, 'vm.instance.hours')).toEqual([
      [h0, 1],
      [h0 + HOUR, 1],
    ]);
    // Under the instance source, with the instance's key shape.
    expect(rows.find((row) => row.meter === 'disk.pd-balanced.gib.hours')!.key).toBe(
      `cmp:instance:${created.id}:${h0}:disk.pd-balanced.gib.hours`,
    );
  });

  it('the hour holding a stop is one window: the running and stopped parts sum', async () => {
    const world = await gceWorld();
    const { created, h0 } = await runningAtHour(world);
    await stopAt(world, created.id, h0 + 90 * 60_000);
    await moveTo(world, h0 + 4 * HOUR + settle);
    await meter(world, usageJob);
    await meter(world, usageJob, HOUR);
    const rows = await windowsOf(world, 'instance', created.id);
    expect(hours(rows, 'disk.pd-balanced.gib.hours').slice(0, 3)).toEqual([
      [h0, 100],
      [h0 + HOUR, 100],
      [h0 + 2 * HOUR, 100],
    ]);
    expect(hours(rows, 'vm.instance.hours')).toEqual([
      [h0, 1],
      [h0 + HOUR, 0.5],
    ]);
  });

  it('hyperdisk machine family bills hyperdisk-balanced', async () => {
    const world = await gceWorld();
    const { created, h0, machine } = await runningAtHour(world);
    // The provider marks the machine's family as Hyperdisk-only (a4, c4, ...): its boot disk meters as hyperdisk.
    machine.bootDiskType = 'hyperdisk-balanced';
    await moveTo(world, h0 + HOUR - 1_000);
    await step(world, 1_000);
    expect((await intervalsOfVm(world, created.id)).map((item) => item.shape.disks)).toEqual([
      [{ type: 'pd-balanced', sizeGiB: 100 }],
      [{ type: 'hyperdisk-balanced', sizeGiB: 100 }],
    ]);
    await moveTo(world, h0 + 3 * HOUR + settle);
    await meter(world, usageJob);
    const rows = await windowsOf(world, 'instance', created.id);
    expect(hours(rows, 'disk.pd-balanced.gib.hours')).toEqual([[h0, 100]]);
    expect(hours(rows, 'disk.hyperdisk-balanced.gib.hours')).toEqual([
      [h0 + HOUR, 100],
      [h0 + 2 * HOUR, 100],
    ]);
  });

  it('disks the provider reports replace the flavor boot disk, one line per type', async () => {
    const world = await gceWorld();
    const { created, h0, machine } = await runningAtHour(world);
    machine.disks = [
      { type: 'pd-ssd', sizeGiB: 50, boot: true },
      { type: 'pd-ssd', sizeGiB: 150 },
      { type: 'local-ssd', sizeGiB: 375 },
    ];
    await moveTo(world, h0 + HOUR - 1_000);
    await step(world, 1_000);
    await moveTo(world, h0 + 2 * HOUR + settle);
    await meter(world, usageJob);
    const rows = await windowsOf(world, 'instance', created.id);
    expect(hours(rows, 'disk.pd-ssd.gib.hours')).toEqual([[h0 + HOUR, 200]]);
    expect(hours(rows, 'disk.local-ssd.gib.hours')).toEqual([[h0 + HOUR, 375]]);
    expect(hours(rows, 'disk.pd-balanced.gib.hours')).toEqual([[h0, 100]]);
  });

  it('an unknown disk type meters as pd-balanced and raises DiskTypeUnknown until it is gone', async () => {
    const world = await gceWorld();
    const { created, h0, machine } = await runningAtHour(world);
    const conditions = async () => {
      const { rows } = await world.fixture.database.query<{
        conditions: { type: string; status: string; message?: string }[] | string;
      }>(`SELECT conditions FROM instances WHERE id = $1`, [created.id]);
      const raw = rows[0]!.conditions;
      return (typeof raw === 'string' ? JSON.parse(raw) : raw).filter(
        (entry: { type: string }) => entry.type === 'DiskTypeUnknown',
      );
    };
    expect(await conditions()).toEqual([]);

    machine.disks = [{ type: 'pd-extreme', sizeGiB: 80, boot: true }];
    await moveTo(world, h0 + HOUR - 1_000);
    await step(world, 1_000);
    expect(await conditions()).toMatchObject([
      { type: 'DiskTypeUnknown', status: 'true', message: expect.stringContaining('pd-extreme') },
    ]);
    expect((await intervalsOfVm(world, created.id)).at(-1)!.shape.disks).toEqual([
      { type: 'pd-balanced', sizeGiB: 80 },
    ]);

    // The provider reports a priced type again: the condition clears.
    machine.disks = [{ type: 'pd-standard', sizeGiB: 80, boot: true }];
    await moveTo(world, h0 + 2 * HOUR - 1_000);
    await step(world, 1_000);
    expect(await conditions()).toEqual([]);

    await moveTo(world, h0 + 3 * HOUR + settle);
    await meter(world, usageJob);
    const rows = await windowsOf(world, 'instance', created.id);
    expect(hours(rows, 'disk.pd-balanced.gib.hours')).toEqual([
      [h0, 100],
      [h0 + HOUR, 80],
    ]);
    expect(hours(rows, 'disk.pd-standard.gib.hours')).toEqual([[h0 + 2 * HOUR, 80]]);
  });

  it('a deleted VM stops disk billing', async () => {
    const world = await gceWorld();
    const { created, h0 } = await runningAtHour(world);
    await stopAt(world, created.id, h0 + HOUR);
    await moveTo(world, h0 + 3 * HOUR - 1_000);
    await world.api.instances.delete(world.acme, {
      tenantId: world.acmeTenant,
      instanceId: created.id,
    });
    await step(world, 1_000);
    expect((await viewOf(world, created.id)).state).toBe('deleted');
    const list = await intervalsOfVm(world, created.id);
    expect(list.every((item) => item.ended !== null)).toBe(true);
    expect(list.at(-1)!.ended).toBe(h0 + 3 * HOUR);

    await moveTo(world, h0 + 10 * HOUR);
    await meter(world, usageJob);
    const rows = await windowsOf(world, 'instance', created.id);
    expect(hours(rows, 'disk.pd-balanced.gib.hours')).toEqual([
      [h0, 100],
      [h0 + HOUR, 100],
      [h0 + 2 * HOUR, 100],
    ]);
  });

  it('a stopped interval from before disks were captured is billed with derived disks (F7-3)', async () => {
    const world = await gceWorld();
    const { created, h0 } = await runningAtHour(world);
    await stopAt(world, created.id, h0 + HOUR);
    // Strip the disks, as an interval opened before this task would have them.
    await world.fixture.database.query(
      `UPDATE instance_usage_intervals SET shape = shape - 'disks' WHERE instance_id = $1`,
      [created.id],
    );
    await moveTo(world, h0 + 4 * HOUR + settle);
    await meter(world, usageJob);
    const rows = await windowsOf(world, 'instance', created.id);
    // Derived as at open: the flavor's 100 GiB boot disk, for the stripped running hour and the stopped backlog.
    expect(hours(rows, 'disk.pd-balanced.gib.hours')).toEqual([
      [h0, 100],
      [h0 + HOUR, 100],
      [h0 + 2 * HOUR, 100],
      [h0 + 3 * HOUR, 100],
    ]);
    // The watermark moved: the backlog is not derived again.
    const { rows: marks } = await world.fixture.database.query<{ behind: boolean }>(
      `SELECT metered_until < to_timestamp($2::float8 / 1000) AS behind
         FROM instance_usage_intervals WHERE instance_id = $1 AND phase = 'stopped'`,
      [created.id, h0 + 4 * HOUR],
    );
    expect(marks).toEqual([{ behind: false }]);
  });

  it('modes: platform-fee and none bill no disks; a grant or flavor meter does not cover them', () => {
    const disks = [
      { type: 'pd-balanced', sizeGiB: 100 },
      { type: 'pd-balanced', sizeGiB: 20 },
      { type: 'hyperdisk-balanced', sizeGiB: 500 },
      { type: 'mystery', sizeGiB: 10 },
      { type: 'pd-ssd', sizeGiB: 0 },
    ];
    const shape: BillableShape = { ...base, disks };
    const diskLines = [
      { meter: 'disk.pd-balanced.gib.hours', perHour: 130 },
      { meter: 'disk.hyperdisk-balanced.gib.hours', perHour: 500 },
    ];
    expect(meterLinesFor(shape, 'metered', 'stopped')).toEqual(diskLines);
    expect(meterLinesFor(shape, 'metered', 'running').slice(-2)).toEqual(diskLines);
    expect(meterLinesFor(shape, 'platform-fee', 'stopped')).toEqual([]);
    expect(meterLinesFor(shape, 'none', 'stopped')).toEqual([]);
    expect(meterLinesFor(shape, 'platform-fee', 'running')).toEqual([
      { meter: 'vm.managed.hours', perHour: 1 },
    ]);
    expect(meterLinesFor({ ...shape, granted: true }, 'metered', 'running')).toEqual([
      { meter: 'vm.grant.usage.hours', perHour: 1 },
      ...diskLines,
    ]);
    expect(
      meterLinesFor({ ...shape, flavorMeter: 'flavor.x.hours' }, 'metered', 'stopped'),
    ).toEqual(diskLines);
    expect(meterLinesFor(base, 'metered', 'stopped')).toEqual([]);
  });

  it('disksOf: the machine record wins; else the flavor disk by family type', () => {
    expect(disksOfRecord(undefined, 100)).toEqual({
      disks: [{ type: 'pd-balanced', sizeGiB: 100 }],
      unknownTypes: [],
    });
    expect(disksOfRecord({ bootDiskType: 'hyperdisk-balanced' }, 100).disks).toEqual([
      { type: 'hyperdisk-balanced', sizeGiB: 100 },
    ]);
    expect(disksOfRecord({ bootDiskType: 'weird' }, 100)).toEqual({
      disks: [{ type: 'pd-balanced', sizeGiB: 100 }],
      unknownTypes: ['weird'],
    });
    expect(
      disksOfRecord({ disks: [{ type: 'pd-ssd', sizeGiB: 30 }], bootDiskType: 'x' }, 100),
    ).toEqual({ disks: [{ type: 'pd-ssd', sizeGiB: 30 }], unknownTypes: [] });
    // No flavor disk (an attached VM) and nothing reported: nothing to bill.
    expect(disksOfRecord(undefined, 0).disks).toEqual([]);
    expect(disksOfRecord({ disks: [{ type: 'pd-ssd', sizeGiB: 0 }] }, 0).disks).toEqual([]);
  });

  it('every disk meter is in meterCatalog', () => {
    const known = new Set(
      meterCatalog({ gpuModels: defaultMeterGpuModels }).map((item) => item.key),
    );
    for (const type of meterDiskTypes) expect(known.has(`disk.${type}.gib.hours`), type).toBe(true);
    for (const type of [...meterDiskTypes, 'unheard-of'])
      for (const mode of ['metered', 'platform-fee', 'none'] as BillingMode[])
        for (const phase of ['running', 'stopped'] as const)
          for (const line of meterLinesFor(
            { ...base, disks: [{ type, sizeGiB: 10 }] },
            mode,
            phase,
          ))
            expect(known.has(line.meter), line.meter).toBe(true);
  });
});

describe('snapshots', () => {
  afterEach(closeFixtures);

  const GiB = 2 ** 30;

  /** A sandbox snapshot row, as the settle pass leaves it (the sandbox itself is out of this test's way). */
  async function insertSnapshot(
    world: GceWorld,
    fields: {
      id: string;
      instanceId: string;
      state: 'pending' | 'ready' | 'failed' | 'deleted';
      readyAt: number | null;
      sizeBytes: number | null;
      tenantId?: string;
    },
  ): Promise<void> {
    await world.fixture.database.transaction(async (tx) => {
      // The sandbox row it names is not what is under test.
      await tx.query(`SET LOCAL session_replication_role = replica`);
      await tx.query(
        `INSERT INTO sandbox_snapshots (id, tenant_id, sandbox_id, template_id, instance_id, node_id, runtime,
                                        include_memory, state, command_id, url, size_bytes, owner_identity_id,
                                        ready_at, version)
         VALUES ($1, $2, 'sbx_x', 'tpl_x', $3, 'node_x', 'qemu', false, $4, 'cmd_x', 'https://objects/x', $5,
                 'usr_x', CASE WHEN $6::float8 IS NULL THEN NULL ELSE to_timestamp($6::float8 / 1000) END, 1)`,
        [
          fields.id,
          fields.tenantId ?? world.acmeTenant,
          fields.instanceId,
          fields.state,
          fields.sizeBytes,
          fields.readyAt,
        ],
      );
    });
  }

  const quantities = (rows: readonly WindowView[], sourceId: string) =>
    rows.filter((row) => row.sourceId === sourceId).map((row) => [row.start, row.quantity]);

  it('snapshots bill by size', async () => {
    const world = await gceWorld();
    const created = await createVm(world);
    const h0 = nextHour(world);
    await moveTo(world, h0);
    await insertSnapshot(world, {
      id: 'snap_a',
      instanceId: created.id,
      state: 'ready',
      readyAt: h0,
      sizeBytes: 3 * GiB,
    });
    await insertSnapshot(world, {
      id: 'snap_b',
      instanceId: created.id,
      state: 'ready',
      readyAt: h0,
      sizeBytes: 1.5 * GiB,
    });
    await moveTo(world, h0 + 2 * HOUR + settle);
    await meter(world, ancillaryJob);
    const rows = await windowsOf(world, 'snapshot');
    expect(quantities(rows, 'snap_a')).toEqual([
      [h0, 3],
      [h0 + HOUR, 3],
    ]);
    expect(quantities(rows, 'snap_b')).toEqual([
      [h0, 1.5],
      [h0 + HOUR, 1.5],
    ]);
    expect(rows[0]).toMatchObject({
      kind: 'snapshot',
      tenantId: world.acmeTenant,
      identityId: null,
      meter: 'snapshot.gib.hours',
      tags: { pool: world.poolId, source: 'snapshot' },
    });
    expect(rows.find((row) => row.sourceId === 'snap_a')!.key).toBe(
      `cmp:snapshot:snap_a:${h0}:snapshot.gib.hours`,
    );
    // A repeated pass writes nothing more.
    const before = JSON.stringify(rows);
    await meter(world, ancillaryJob, 60_000);
    expect(JSON.stringify(await windowsOf(world, 'snapshot'))).toBe(before);
  });

  it('a snapshot bills from ready until it is deleted, not before, and never when it failed', async () => {
    const world = await gceWorld();
    const created = await createVm(world);
    const h0 = nextHour(world);
    await moveTo(world, h0);
    // Pending (upload not settled) and failed ones never bill, whatever their size.
    await insertSnapshot(world, {
      id: 'snap_pending',
      instanceId: created.id,
      state: 'pending',
      readyAt: null,
      sizeBytes: null,
    });
    await insertSnapshot(world, {
      id: 'snap_failed',
      instanceId: created.id,
      state: 'failed',
      readyAt: null,
      sizeBytes: GiB,
    });
    await insertSnapshot(world, {
      id: 'snap_c',
      instanceId: created.id,
      state: 'ready',
      readyAt: h0 + 30 * 60_000,
      sizeBytes: 2 * GiB,
    });
    // Deleted at 2h15m: the half hour it was ready in, one whole hour and a quarter hour are all it owes.
    await moveTo(world, h0 + 2 * HOUR + 15 * 60_000);
    await world.fixture.database.query(
      `UPDATE sandbox_snapshots SET state = 'deleted' WHERE id IN ('snap_c', 'snap_pending')`,
    );
    await moveTo(world, h0 + 6 * HOUR);
    await meter(world, ancillaryJob);
    await meter(world, ancillaryJob, HOUR);
    const rows = await windowsOf(world, 'snapshot');
    expect(new Set(rows.map((row) => row.sourceId))).toEqual(new Set(['snap_c']));
    expect(rows.map((row) => [row.start, row.quantity])).toEqual([
      [h0, 1],
      [h0 + HOUR, 2],
      [h0 + 2 * HOUR, 0.5],
    ]);
  });

  it('a snapshot with no size bills nothing; a pool in mode none bills none', async () => {
    const world = await gceWorld();
    const created = await createVm(world);
    const h0 = nextHour(world);
    await moveTo(world, h0);
    await insertSnapshot(world, {
      id: 'snap_empty',
      instanceId: created.id,
      state: 'ready',
      readyAt: h0,
      sizeBytes: 0,
    });
    await moveTo(world, h0 + 2 * HOUR + settle);
    await meter(world, ancillaryJob);
    expect(await windowsOf(world, 'snapshot')).toEqual([]);

    await insertSnapshot(world, {
      id: 'snap_free',
      instanceId: created.id,
      state: 'ready',
      readyAt: h0 + 2 * HOUR,
      sizeBytes: GiB,
    });
    await world.fixture.database.query(
      `UPDATE pools SET policy = policy || '{"billing":{"mode":"none"}}'::jsonb WHERE id = $1`,
      [world.poolId],
    );
    await moveTo(world, h0 + 4 * HOUR + settle);
    await meter(world, ancillaryJob);
    expect(await windowsOf(world, 'snapshot')).toEqual([]);
  });

  it('every snapshot and network meter is in meterCatalog', () => {
    const known = new Set(
      meterCatalog({ gpuModels: defaultMeterGpuModels }).map((item) => item.key),
    );
    for (const key of ['snapshot.gib.hours', 'network.vpc.hours'])
      expect(known.has(key), key).toBe(true);
  });
});
