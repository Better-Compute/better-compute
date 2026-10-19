import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultMeterGpuModels,
  meterCatalog,
  canonicalGpuModel,
  type ExternalMachine,
  type PoolPolicy,
} from '@better-compute/core';
import { betterCompute } from '@better-compute/server';
import { createComputeIamBridge, flushUsageWindows } from '@better-compute/iam';
import { closeFixtures } from '@better-compute/testing';
import {
  billingModeOf,
  closeOpenInterval,
  meterLinesFor,
  poolBillingMode,
  vps,
  type BillableShape,
  type BillingMode,
} from '@better-compute/vps';
import { closeIamFixtures, iamFixture } from './support/iam.js';
import {
  fakeGceProvider,
  gceVm,
  gceWorld,
  plainProvider,
  type FakeGce,
  type GceWorld,
} from './support/vps-gce.js';

const base: BillableShape = {
  vcpu: 4,
  memoryGiB: 16,
  spot: false,
  reserved: false,
  granted: false,
};
const lines = (shape: Partial<BillableShape>, mode: BillingMode = 'metered') =>
  meterLinesFor({ ...base, ...shape }, mode, 'running');

describe('rules', () => {
  it('composes vcpu, memory and the instance line', () => {
    expect(lines({})).toEqual([
      { meter: 'vm.vcpu.hours', perHour: 4 },
      { meter: 'vm.memory.gib.hours', perHour: 16 },
      { meter: 'vm.instance.hours', perHour: 1 },
    ]);
  });

  it('spot GPU: vm.gpu.h100.spot.hours x 8', () => {
    const out = lines({ gpus: { model: 'H100', count: 8 }, spot: true });
    expect(out).toContainEqual({ meter: 'vm.gpu.h100.spot.hours', perHour: 8 });
    expect(out).not.toContainEqual(expect.objectContaining({ meter: 'vm.gpu.h100.hours' }));
  });

  it('on-demand GPU uses the plain model meter', () => {
    expect(lines({ gpus: { model: 'H100', count: 2 } })).toContainEqual({
      meter: 'vm.gpu.h100.hours',
      perHour: 2,
    });
  });

  it('reserved: vm.reserved.* with no .spot, and the instance line stays unprefixed', () => {
    const out = lines({ reserved: true, spot: true, gpus: { model: 'A100', count: 1 } });
    expect(out).toEqual([
      { meter: 'vm.reserved.vcpu.hours', perHour: 4 },
      { meter: 'vm.reserved.memory.gib.hours', perHour: 16 },
      { meter: 'vm.reserved.gpu.a100.hours', perHour: 1 },
      { meter: 'vm.instance.hours', perHour: 1 },
    ]);
    expect(out.some((line) => line.meter.includes('spot'))).toBe(false);
  });

  it('granted: only vm.grant.usage.hours', () => {
    expect(lines({ granted: true, reserved: true, gpus: { model: 'H100', count: 8 } })).toEqual([
      { meter: 'vm.grant.usage.hours', perHour: 1 },
    ]);
  });

  it('flavor meter replaces composition', () => {
    expect(
      lines({
        flavorMeter: 'flavor.a3-highgpu-8g.us-central1.hours',
        gpus: { model: 'H100', count: 8 },
      }),
    ).toEqual([{ meter: 'flavor.a3-highgpu-8g.us-central1.hours', perHour: 1 }]);
  });

  it('granted wins over a flavor meter', () => {
    expect(lines({ granted: true, flavorMeter: 'flavor.x.hours' })).toEqual([
      { meter: 'vm.grant.usage.hours', perHour: 1 },
    ]);
  });

  it('an unknown or malformed GPU model maps to other, never a dead letter', () => {
    expect(lines({ gpus: { model: 'MI300X', count: 1 } })).toContainEqual({
      meter: 'vm.gpu.other.hours',
      perHour: 1,
    });
    expect(lines({ gpus: { model: 'weird model!', count: 1 }, spot: true })).toContainEqual({
      meter: 'vm.gpu.other.spot.hours',
      perHour: 1,
    });
    expect(lines({ gpus: { model: 'other', count: 1 }, reserved: true })).toContainEqual({
      meter: 'vm.reserved.gpu.other.hours',
      perHour: 1,
    });
  });

  it('model names are case-insensitive; an operator catalog can widen the known models', () => {
    expect(lines({ gpus: { model: 'h100', count: 1 } })).toContainEqual({
      meter: 'vm.gpu.h100.hours',
      perHour: 1,
    });
    const out = meterLinesFor(
      { ...base, gpus: { model: 'MI300X', count: 1 } },
      'metered',
      'running',
      {
        gpuModels: ['MI300X'],
      },
    );
    expect(out).toContainEqual({ meter: 'vm.gpu.mi300x.hours', perHour: 1 });
  });

  it('none returns nothing, platform-fee returns the managed line', () => {
    expect(lines({ gpus: { model: 'H100', count: 8 } }, 'none')).toEqual([]);
    expect(lines({ granted: true }, 'none')).toEqual([]);
    expect(lines({ gpus: { model: 'H100', count: 8 } }, 'platform-fee')).toEqual([
      { meter: 'vm.managed.hours', perHour: 1 },
    ]);
  });

  it('stopped returns no lines without disks', () => {
    for (const mode of ['metered', 'platform-fee', 'none'] as const)
      expect(meterLinesFor(base, mode, 'stopped')).toEqual([]);
  });

  it('a public address adds one ip.public.hours line, a disk one disk line (Tasks 12, 13)', () => {
    expect(lines({ publicIp: true })).toEqual([
      ...lines({}),
      { meter: 'ip.public.hours', perHour: 1 },
    ]);
    expect(lines({ disks: [{ type: 'pd-ssd', sizeGiB: 100 }] })).toEqual([
      ...lines({}),
      { meter: 'disk.pd-ssd.gib.hours', perHour: 100 },
    ]);
  });

  it('every meterLinesFor output is in meterCatalog', () => {
    const flavorMeter = 'flavor.a3-highgpu-8g.us-central1.hours';
    const known = new Set(
      meterCatalog({ gpuModels: defaultMeterGpuModels, flavorMeters: [flavorMeter] }).map(
        (meter) => meter.key,
      ),
    );
    const gpuChoices = [
      undefined,
      { model: 'H100', count: 8 },
      { model: 'l40s', count: 1 },
      { model: 'MI300X', count: 2 },
      { model: 'other', count: 1 },
    ];
    // Task 13: every priced disk type, an unheard-of one (metered as pd-balanced) and a zero-size one.
    const diskChoices = [
      undefined,
      [{ type: 'pd-balanced', sizeGiB: 100 }],
      [
        { type: 'hyperdisk-balanced', sizeGiB: 100 },
        { type: 'pd-standard', sizeGiB: 20 },
        { type: 'pd-ssd', sizeGiB: 20 },
        { type: 'local-ssd', sizeGiB: 375 },
        { type: 'pd-extreme', sizeGiB: 10 },
        { type: 'pd-balanced', sizeGiB: 0 },
      ],
    ];
    let checked = 0;
    for (const mode of ['metered', 'platform-fee', 'none'] as const)
      for (const phase of ['running', 'stopped'] as const)
        for (const gpus of gpuChoices)
          for (const spot of [false, true])
            for (const reserved of [false, true])
              for (const granted of [false, true])
                for (const meter of [undefined, flavorMeter])
                  for (const publicIp of [false, true])
                    for (const disks of diskChoices) {
                      const shape: BillableShape = {
                        ...base,
                        gpus,
                        spot,
                        reserved,
                        granted,
                        flavorMeter: meter,
                        publicIp,
                        disks,
                      };
                      for (const line of meterLinesFor(shape, mode, phase)) {
                        checked += 1;
                        expect(known.has(line.meter), line.meter).toBe(true);
                        expect(line.perHour).toBeGreaterThan(0);
                      }
                    }
    expect(checked).toBeGreaterThan(100);
  });
});

describe('canonicalGpuModel', () => {
  it('maps provider GPU strings to the catalog family', () => {
    const cases: Record<string, string> = {
      'nvidia-h100-80gb': 'h100',
      'nvidia-h100-mega-80gb': 'h100',
      'nvidia-tesla-a100': 'a100',
      'nvidia-a100-80gb': 'a100',
      'nvidia-l4': 'l4',
      'nvidia-l40s': 'l40s',
      'nvidia-b200': 'b200',
      'nvidia-h200-141gb': 'h200',
      'NVIDIA H100 80GB HBM3': 'h100',
      H100: 'h100',
      l40s: 'l40s',
      'RTX-PRO-6000': 'rtx-pro-6000',
    };
    for (const [raw, family] of Object.entries(cases))
      expect(canonicalGpuModel(raw), raw).toBe(family);
  });

  it('an unknown or empty model is other', () => {
    for (const raw of ['amd-mi300x', 'nvidia-tesla-k80', '', '   ', 'weird model!', 'other'])
      expect(canonicalGpuModel(raw), raw).toBe('other');
  });

  it('matches the longest family token: l40s is not l4 or l40, gb200 is not b200', () => {
    expect(canonicalGpuModel('nvidia-l40s')).toBe('l40s');
    expect(canonicalGpuModel('nvidia-l40')).toBe('l40');
    expect(canonicalGpuModel('nvidia-l4')).toBe('l4');
    expect(canonicalGpuModel('nvidia-gb200')).toBe('gb200');
    expect(canonicalGpuModel('nvidia-b200')).toBe('b200');
    expect(canonicalGpuModel('nvidia-gh200-96gb')).toBe('gh200');
    // A token, never a substring: "h1000" is no H100.
    expect(canonicalGpuModel('acme-h1000')).toBe('other');
  });

  it('an operator catalog widens the families it knows', () => {
    expect(canonicalGpuModel('amd-mi300x', ['MI300X'])).toBe('mi300x');
    expect(canonicalGpuModel('nvidia-h100-80gb', ['MI300X'])).toBe('other');
  });

  it('meterLinesFor meters a provider GPU string on its catalog meter, which the catalog defines', () => {
    const out = lines({ gpus: { model: 'nvidia-h100-80gb', count: 8 }, spot: true });
    expect(out).toContainEqual({ meter: 'vm.gpu.h100.spot.hours', perHour: 8 });
    const known = new Set(
      meterCatalog({ gpuModels: defaultMeterGpuModels }).map((meter) => meter.key),
    );
    for (const raw of [
      'nvidia-tesla-a100',
      'nvidia-l40s',
      'nvidia-l4',
      'nvidia-b200',
      'nvidia-gb200',
    ])
      for (const line of lines({ gpus: { model: raw, count: 1 } }))
        expect(known.has(line.meter), `${raw}: ${line.meter}`).toBe(true);
    // GB200 is no default provider-VM model: it is metered as other, never as B200.
    expect(lines({ gpus: { model: 'nvidia-gb200', count: 1 } })).toContainEqual({
      meter: 'vm.gpu.other.hours',
      perHour: 1,
    });
  });
});

describe('billingModeOf', () => {
  const root = 'root';
  const pool = (
    over: Partial<{ ownerTenantId: string; class: string; policy: PoolPolicy }> = {},
  ) => ({
    ownerTenantId: root,
    class: 'provider',
    policy: {} as PoolPolicy,
    ...over,
  });

  it('an explicit policy mode wins', () => {
    expect(
      billingModeOf(pool({ policy: { billing: { mode: 'none' } } }), { tenantId: 'sub' }, root),
    ).toBe('none');
    expect(
      billingModeOf(pool({ policy: { billing: { mode: 'metered' } } }), { tenantId: 'sub' }, root),
    ).toBe('metered');
  });

  it('BYO pool owned by a sub-tenant is platform-fee even when its account did not resolve (fail closed)', () => {
    expect(billingModeOf(pool({ ownerTenantId: 'sub' }), undefined, root)).toBe('platform-fee');
  });

  it('BYO pool owned by a sub-tenant with its own account is platform-fee', () => {
    expect(billingModeOf(pool({ ownerTenantId: 'sub' }), { tenantId: 'sub' }, root)).toBe(
      'platform-fee',
    );
  });

  it('a root-owned provider pool is metered, with or without a resolved account (root pays itself)', () => {
    expect(billingModeOf(pool(), { tenantId: root }, root)).toBe('metered');
    expect(billingModeOf(pool(), undefined, root)).toBe('metered');
  });

  it('a non-provider pool is metered whoever owns it', () => {
    expect(billingModeOf(pool({ class: 'vps-host', ownerTenantId: 'sub' }), undefined, root)).toBe(
      'metered',
    );
  });

  it('an explicit mode wins over the BYO default', () => {
    expect(
      billingModeOf(
        pool({ ownerTenantId: 'sub', policy: { billing: { mode: 'metered' } } }),
        undefined,
        root,
      ),
    ).toBe('metered');
  });
});

// --- Task 6: lifecycle usage intervals (D3) -------------------------------------------------------
// Provider instances record exact running/stopped intervals in the same transactions as their
// lifecycle changes; the vps.provider-usage reconciler (Task 7) turns them into usage windows.

interface IntervalView {
  instanceId: string;
  tenantId: string;
  projectId: string | null;
  identityId: string | null;
  poolId: string;
  region: string | null;
  provider: string;
  phase: 'running' | 'stopped';
  mode: BillingMode;
  shape: BillableShape;
  started: number;
  ended: number | null;
  meteredUntil: number;
}

async function intervals(world: GceWorld, instanceId?: string): Promise<IntervalView[]> {
  const { rows } = await world.fixture.database.query<{
    instance_id: string;
    tenant_id: string;
    project_id: string | null;
    identity_id: string | null;
    pool_id: string;
    region: string | null;
    provider: string;
    phase: 'running' | 'stopped';
    mode: BillingMode;
    shape: BillableShape | string;
    started: number;
    ended: number | null;
    metered_until: number;
  }>(
    `SELECT instance_id, tenant_id, project_id, identity_id, pool_id, region, provider, phase, mode, shape,
            (extract(epoch FROM started_at) * 1000)::float8 AS started,
            (extract(epoch FROM ended_at) * 1000)::float8 AS ended,
            (extract(epoch FROM metered_until) * 1000)::float8 AS metered_until
       FROM instance_usage_intervals WHERE ($1::text IS NULL OR instance_id = $1)
      ORDER BY started_at, id`,
    [instanceId ?? null],
  );
  return rows.map((row) => ({
    instanceId: row.instance_id,
    tenantId: row.tenant_id,
    projectId: row.project_id,
    identityId: row.identity_id,
    poolId: row.pool_id,
    region: row.region,
    provider: row.provider,
    phase: row.phase,
    mode: row.mode,
    shape: typeof row.shape === 'string' ? JSON.parse(row.shape) : row.shape,
    started: Number(row.started),
    ended: row.ended === null ? null : Number(row.ended),
    meteredUntil: Number(row.metered_until),
  }));
}

/** No two intervals of one instance overlap, and every closed one ends at or after its start. */
function assertNoOverlap(list: readonly IntervalView[]) {
  const byInstance = new Map<string, IntervalView[]>();
  for (const item of list)
    byInstance.set(item.instanceId, [...(byInstance.get(item.instanceId) ?? []), item]);
  for (const items of byInstance.values()) {
    const sorted = [...items].sort((a, b) => a.started - b.started);
    for (let index = 0; index < sorted.length; index++) {
      const item = sorted[index]!;
      if (item.ended !== null) expect(item.ended).toBeGreaterThanOrEqual(item.started);
      const next = sorted[index + 1];
      if (next) {
        expect(item.ended).not.toBeNull();
        expect(next.started).toBeGreaterThanOrEqual(item.ended!);
      }
    }
  }
}

const LEGACY_VM = 'us-central1-a/legacy';

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

/** Keeps the fake VM reporting `running` (a power-off that has not happened yet) until released. */
function holdRunning(world: GceWorld, externalId: string): () => void {
  const machine = world.cloud.machines.get(externalId)!;
  let state = machine.state;
  let held = true;
  Object.defineProperty(machine, 'state', {
    enumerable: true,
    configurable: true,
    get: () => state,
    set: (value: typeof state) => {
      if (!held || value === 'running') state = value;
    },
  });
  return () => {
    held = false;
  };
}

async function legacyAttachWorld(machine: Partial<ExternalMachine> = {}) {
  const world = await gceWorld({ discovery: { every: '1m' } });
  world.cloud.machines.set(LEGACY_VM, gceVm('legacy', machine));
  await world.discover(0);
  return world;
}

const attachLegacy = (world: GceWorld, tenantId: string, ownerIdentityId: string, key: string) =>
  world.api.instances.attach(world.root, {
    tenantId,
    poolId: world.poolId,
    externalId: LEGACY_VM,
    ownerIdentityId,
    idempotencyKey: key,
  });

describe('intervals', () => {
  afterEach(closeFixtures);

  it('a created VM opens running at the first observed running and closes at observed stopped', async () => {
    const world = await gceWorld();
    const created = await createVm(world);
    // Admitted, not observed yet: nothing to bill.
    expect(await intervals(world)).toEqual([]);
    const t1 = await step(world);
    expect((await viewOf(world, created.id)).state).toBe('running');
    const [open] = await intervals(world, created.id);
    expect(open).toEqual({
      instanceId: created.id,
      tenantId: world.acmeTenant,
      projectId: null,
      identityId: world.fixture.tenants.acme.caller.identityId,
      poolId: world.poolId,
      region: 'us-central1',
      provider: 'fake-gce',
      phase: 'running',
      mode: 'metered',
      shape: {
        vcpu: 12,
        memoryGiB: 85,
        gpus: { model: 'a100', count: 1 },
        spot: false,
        reserved: false,
        granted: false,
        // The flavor's 100 GiB boot disk (D9).
        disks: [{ type: 'pd-balanced', sizeGiB: 100 }],
      },
      started: t1,
      ended: null,
      meteredUntil: t1,
    });
    // Steady polls of a VM that keeps running add nothing.
    await step(world, 60_000);
    await step(world, 60_000);
    expect(await intervals(world, created.id)).toHaveLength(1);

    await world.api.instances.stop(world.acme, {
      tenantId: world.acmeTenant,
      instanceId: created.id,
    });
    const t2 = await step(world, 5_000);
    expect((await viewOf(world, created.id)).state).toBe('stopped');
    const list = await intervals(world, created.id);
    expect(list.map(({ phase, started, ended }) => ({ phase, started, ended }))).toEqual([
      { phase: 'running', started: t1, ended: t2 },
      { phase: 'stopped', started: t2, ended: null },
    ]);
    assertNoOverlap(list);

    // Deleted: the stopped interval closes when the machine is gone.
    await world.api.instances.delete(world.acme, {
      tenantId: world.acmeTenant,
      instanceId: created.id,
    });
    const t3 = await step(world, 5_000);
    expect((await viewOf(world, created.id)).state).toBe('deleted');
    const after = await intervals(world, created.id);
    expect(after.at(-1)).toMatchObject({ phase: 'stopped', started: t2, ended: t3 });
    expect(after.every((item) => item.ended !== null)).toBe(true);
  });

  describe('interval edges', () => {
    it('a running → lost → recovered flap leaves the lost span unbilled', async () => {
      const world = await gceWorld();
      const created = await createVm(world);
      const t1 = await step(world);
      const externalId = (await viewOf(world, created.id)).externalId as string;
      const machine = world.cloud.machines.get(externalId)!;
      world.cloud.machines.delete(externalId);
      const t2 = await step(world, 60_000);
      expect((await viewOf(world, created.id)).state).toBe('lost');
      expect(await intervals(world, created.id)).toMatchObject([
        { phase: 'running', started: t1, ended: t2 },
      ]);
      // It comes back; a wake polls it again and it recovers.
      world.cloud.machines.set(externalId, machine);
      await world.api.instances.start(world.acme, {
        tenantId: world.acmeTenant,
        instanceId: created.id,
      });
      const t3 = await step(world, 300_000);
      expect((await viewOf(world, created.id)).state).toBe('running');
      const list = await intervals(world, created.id);
      expect(list.map(({ phase, started, ended }) => ({ phase, started, ended }))).toEqual([
        { phase: 'running', started: t1, ended: t2 },
        { phase: 'running', started: t3, ended: null },
      ]);
      assertNoOverlap(list);
    });

    it('a restart mid-interval creates no duplicate, and the database refuses an overlapping insert', async () => {
      const world = await gceWorld();
      const created = await createVm(world);
      const t1 = await step(world);
      const polls = () =>
        world.cloud.requests.filter((request) => request.startsWith('get')).length;
      const before = polls();
      // A second control plane over the same database (a restarted process): a fresh vps module.
      const restarted = betterCompute({
        database: world.fixture.database,
        iam: world.fixture.iam,
        secret: 'better-compute-provider-usage-restart-0123456789',
        baseURL: 'https://compute.example.test',
        rootTenantId: world.rootTenant,
        clock: world.fixture.clock,
        modules: [vps({ providers: [fakeGceProvider(world.cloud), plainProvider] })],
      });
      await restarted.initialize();
      try {
        for (let round = 0; round < 3; round++) {
          await world.fixture.advance(60_000);
          await restarted.jobs['vps.instances']!.tick();
        }
      } finally {
        await restarted.stop();
      }
      // The restarted module polled the VM, saw it running, and kept the one open interval.
      expect(polls()).toBeGreaterThan(before);
      expect(await intervals(world, created.id)).toMatchObject([
        { phase: 'running', started: t1, ended: null },
      ]);
      // The database itself refuses a second interval overlapping the open one.
      await expect(
        world.fixture.database.query(
          `INSERT INTO instance_usage_intervals (id, instance_id, tenant_id, pool_id, provider, phase, mode,
                                                 shape, started_at, ended_at, metered_until)
           SELECT 'ivl_dup', instance_id, tenant_id, pool_id, provider, 'running', mode, shape,
                  started_at + interval '1 minute', started_at + interval '2 minutes',
                  started_at + interval '1 minute'
             FROM instance_usage_intervals WHERE instance_id = $1`,
          [created.id],
        ),
      ).rejects.toMatchObject({ code: '23P01' });
    });

    it('a requested stop while the provider still reports running keeps billing until the observed stop', async () => {
      const world = await gceWorld();
      const created = await createVm(world);
      const t1 = await step(world);
      const externalId = (await viewOf(world, created.id)).externalId as string;
      const release = holdRunning(world, externalId);
      await world.api.instances.stop(world.acme, {
        tenantId: world.acmeTenant,
        instanceId: created.id,
      });
      await step(world, 1_000);
      await step(world, 30_000);
      expect(world.cloud.requests.filter((request) => request.startsWith('power'))).toHaveLength(2);
      expect((await viewOf(world, created.id)).state).toBe('running');
      expect(await intervals(world, created.id)).toMatchObject([
        { phase: 'running', started: t1, ended: null },
      ]);
      release();
      const t2 = await step(world, 30_000);
      expect((await viewOf(world, created.id)).state).toBe('stopped');
      const list = await intervals(world, created.id);
      expect(list.map(({ phase, started, ended }) => ({ phase, started, ended }))).toEqual([
        { phase: 'running', started: t1, ended: t2 },
        { phase: 'stopped', started: t2, ended: null },
      ]);
    });

    it('attach to A, then detach, then attach to B gives two intervals with the right tenants and no overlap', async () => {
      const world = await legacyAttachWorld();
      const { acme, other } = world.fixture.tenants;
      world.fixture.iam.allow({ token: other.token });
      await world.api.pools.offer(world.root, {
        tenantId: world.rootTenant,
        poolId: world.poolId,
        toTenantId: other.id,
        quota: { vcpu: 512, memoryGiB: 4096, diskGiB: 1000, gpu: 16 },
      });
      const a = await attachLegacy(world, acme.id, acme.caller.identityId, 'attach-a');
      const tA = await step(world);
      expect((await viewOf(world, a.id)).state).toBe('running');
      await world.api.instances.detach(world.acme, { tenantId: acme.id, instanceId: a.id });
      const tD = await step(world, 5_000);
      expect((await viewOf(world, a.id)).state).toBe('deleted');
      const b = await attachLegacy(world, other.id, other.caller.identityId, 'attach-b');
      const tB = await step(world, 5_000);
      const list = await intervals(world);
      expect(
        list.map(({ instanceId, tenantId, identityId, phase, started, ended }) => ({
          instanceId,
          tenantId,
          identityId,
          phase,
          started,
          ended,
        })),
      ).toEqual([
        {
          instanceId: a.id,
          tenantId: acme.id,
          identityId: acme.caller.identityId,
          phase: 'running',
          started: tA,
          ended: tD,
        },
        {
          instanceId: b.id,
          tenantId: other.id,
          identityId: other.caller.identityId,
          phase: 'running',
          started: tB,
          ended: null,
        },
      ]);
      // The same machine is never billed twice at once.
      expect(list[1]!.started).toBeGreaterThanOrEqual(list[0]!.ended!);
      // The attached shape: the machine's own, with its GPU model.
      expect(list[0]!.shape).toEqual({
        vcpu: 208,
        memoryGiB: 1872,
        gpus: { model: 'h100', count: 8 },
        spot: false,
        reserved: false,
        granted: false,
        // An attached machine reports no disks and has no flavor disk: nothing to bill yet.
        disks: [],
      });
      // No interval starts before its instance was attached.
      const { rows } = await world.fixture.database.query<{ early: number }>(
        `SELECT count(*)::int AS early FROM instance_usage_intervals u JOIN instances i ON i.id = u.instance_id
          WHERE u.started_at < i.attached_at`,
      );
      expect(rows[0]!.early).toBe(0);
    });
  });

  it('attached billing none opens no interval', async () => {
    const world = await legacyAttachWorld();
    const { acme } = world.fixture.tenants;
    const a = await attachLegacy(world, acme.id, acme.caller.identityId, 'attach-none');
    // Task 8 writes it from instances.attach({ billing: 'none' }).
    await world.fixture.database.query(`UPDATE instances SET billing = 'none' WHERE id = $1`, [
      a.id,
    ]);
    await step(world);
    expect((await viewOf(world, a.id)).state).toBe('running');
    await world.api.instances.stop(world.acme, { tenantId: acme.id, instanceId: a.id });
    await step(world, 5_000);
    expect((await viewOf(world, a.id)).state).toBe('stopped');
    expect(await intervals(world)).toEqual([]);
  });

  describe('GPU model (ruling F6-4)', () => {
    it('an observation without gpus keeps the open interval and its model (no split)', async () => {
      const world = await gceWorld();
      const created = await createVm(world);
      const t1 = await step(world);
      const externalId = (await viewOf(world, created.id)).externalId as string;
      delete world.cloud.machines.get(externalId)!.gpus;
      await step(world, 60_000);
      await step(world, 60_000);
      const list = await intervals(world, created.id);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ phase: 'running', started: t1, ended: null });
      expect(list[0]!.shape.gpus).toEqual({ model: 'a100', count: 1 });
      // A stop and start keep the model too, though the machine still reports no GPUs.
      await world.api.instances.stop(world.acme, {
        tenantId: world.acmeTenant,
        instanceId: created.id,
      });
      await step(world, 5_000);
      await world.api.instances.start(world.acme, {
        tenantId: world.acmeTenant,
        instanceId: created.id,
      });
      await step(world, 5_000);
      const after = await intervals(world, created.id);
      expect(after.map((item) => item.phase)).toEqual(['running', 'stopped', 'running']);
      expect(after.map((item) => item.shape.gpus?.model)).toEqual(['a100', 'a100', 'a100']);
    });

    it("without a reported model the pool's gpu_model names it, normalised", async () => {
      const world = await gceWorld();
      await world.fixture.database.query(
        `UPDATE pools SET gpu_model = 'nvidia-l40s' WHERE id = $1`,
        [world.poolId],
      );
      const created = await createVm(world);
      // The provider's machine reports no GPUs.
      const name = created.id.replaceAll('_', '-');
      world.cloud.machines.set(`us-central1-a/${name}`, {
        ...gceVm(name, { vcpu: 12, memoryGiB: 85 }),
        gpus: undefined,
      });
      await step(world);
      const [open] = await intervals(world, created.id);
      expect(open!.shape.gpus).toEqual({ model: 'l40s', count: 1 });
    });
  });

  it('stopped phase opens for disks only', async () => {
    const world = await legacyAttachWorld({ state: 'stopped' });
    const { acme } = world.fixture.tenants;
    const a = await attachLegacy(world, acme.id, acme.caller.identityId, 'attach-stopped');
    const t1 = await step(world);
    expect((await viewOf(world, a.id)).state).toBe('stopped');
    const [stopped] = await intervals(world, a.id);
    expect(stopped).toMatchObject({ phase: 'stopped', started: t1, ended: null, mode: 'metered' });
    // Task 13 meters the stopped phase's disks; it has no compute lines.
    expect(meterLinesFor(stopped!.shape, stopped!.mode, 'stopped')).toEqual([]);
    await world.api.instances.start(world.acme, { tenantId: acme.id, instanceId: a.id });
    const t2 = await step(world, 5_000);
    expect((await viewOf(world, a.id)).state).toBe('running');
    const list = await intervals(world, a.id);
    expect(list.map(({ phase, started, ended }) => ({ phase, started, ended }))).toEqual([
      { phase: 'stopped', started: t1, ended: t2 },
      { phase: 'running', started: t2, ended: null },
    ]);
  });
});

// --- Task 7: the vps.provider-usage reconciler (metering) ------------------------------------------
// Intervals become hourly `instance` usage windows: whole ended hours only, the watermark
// (`metered_until`) advancing in the same transaction, and every interval of one instance that touches an
// hour summed into that hour's single window (the window key has no interval in it).

describe('metering', () => {
  afterEach(async () => {
    await closeFixtures();
    await closeIamFixtures();
  });

  const HOUR = 3_600_000;
  const usageJob = 'vps.provider-usage';
  /** The default meter grace (5 minutes) and a moment past it: an ended hour is written only then. */
  const grace = 5 * 60_000;
  const settle = grace + 60_000;

  interface WindowView {
    key: string;
    instanceId: string;
    tenantId: string;
    identityId: string | null;
    meter: string;
    quantity: number;
    start: number;
    end: number;
    tags: Record<string, string>;
    outcome: string | null;
  }

  async function windows(world: GceWorld): Promise<WindowView[]> {
    const { rows } = await world.fixture.database.query<{
      idempotency_key: string;
      source_id: string;
      tenant_id: string;
      identity_id: string | null;
      meter: string;
      quantity: string;
      start_ms: number;
      end_ms: number;
      tags: Record<string, string> | string;
      outcome: string | null;
    }>(
      `SELECT idempotency_key, source_id, tenant_id, identity_id, meter, quantity::text,
              (extract(epoch FROM window_start) * 1000)::float8 AS start_ms,
              (extract(epoch FROM window_end) * 1000)::float8 AS end_ms, tags, outcome
         FROM usage_windows WHERE source_kind = 'instance' ORDER BY window_start, meter, source_id`,
    );
    return rows.map((row) => ({
      key: row.idempotency_key,
      instanceId: row.source_id,
      tenantId: row.tenant_id,
      identityId: row.identity_id,
      meter: row.meter,
      quantity: Number(row.quantity),
      start: Number(row.start_ms),
      end: Number(row.end_ms),
      tags: typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags,
      outcome: row.outcome,
    }));
  }

  const sum = (list: readonly WindowView[], meter: string) =>
    Math.round(
      list
        .filter((item) => item.meter === meter)
        .reduce((total, item) => total + item.quantity, 0) * 1e6,
    ) / 1e6;

  const hoursOf = (list: readonly WindowView[]) =>
    list.filter((row) => row.meter === 'vm.instance.hours').map((row) => [row.start, row.quantity]);

  /** Moves the sim clock by `advanceMs` and runs the reconciler (its periodic key is due again by then). */
  async function meter(world: GceWorld, advanceMs = 5 * 60_000): Promise<void> {
    if (advanceMs > 0) await world.fixture.advance(advanceMs);
    await world.tick(usageJob, 2);
  }

  /** Moves the sim clock to `at` (never backwards). */
  async function moveTo(world: GceWorld, at: number): Promise<void> {
    const now = world.fixture.clock.now();
    if (at > now) await world.fixture.advance(at - now);
  }

  /** The next top of the hour after the clock. */
  const nextHour = (world: GceWorld) => (Math.floor(world.fixture.clock.now() / HOUR) + 1) * HOUR;

  /** A created VM observed running exactly at a top of the hour; returns that hour. */
  async function runningAtHour(world: GceWorld, key = 'vm-1') {
    const created = await createVm(world, key);
    const h0 = nextHour(world);
    await moveTo(world, h0 - 1_000);
    await step(world, 1_000);
    expect((await viewOf(world, created.id)).state).toBe('running');
    expect((await intervals(world, created.id))[0]!.started).toBe(h0);
    return { created, h0 };
  }

  const meteredUntil = async (world: GceWorld, instanceId: string) =>
    (await intervals(world, instanceId)).map((item) => item.meteredUntil);

  it('a 2h30m run writes 2 whole hours now and the half hour when it closes', async () => {
    const world = await gceWorld();
    const { created, h0 } = await runningAtHour(world);
    await moveTo(world, h0 + 150 * 60_000 - 5_000);
    await meter(world, 0);
    // 2h30m in: the two ended hours are written, the third is still open.
    let rows = await windows(world);
    expect(hoursOf(rows)).toEqual([
      [h0, 1],
      [h0 + HOUR, 1],
    ]);
    expect(await meteredUntil(world, created.id)).toEqual([h0 + 2 * HOUR]);

    // The run closes at exactly 2h30m. Its last half hour is still inside an open hour.
    await world.api.instances.stop(world.acme, {
      tenantId: world.acmeTenant,
      instanceId: created.id,
    });
    const closed = await step(world, 5_000);
    expect(closed).toBe(h0 + 150 * 60_000);
    await meter(world, 0);
    expect(hoursOf(await windows(world))).toHaveLength(2);

    // Once that hour has ended, the half hour is written and the interval is fully metered.
    await moveTo(world, h0 + 3 * HOUR + settle);
    await meter(world, 0);
    rows = await windows(world);
    expect(hoursOf(rows)).toEqual([
      [h0, 1],
      [h0 + HOUR, 1],
      [h0 + 2 * HOUR, 0.5],
    ]);
    const [running] = await intervals(world, created.id);
    expect(running).toMatchObject({ phase: 'running', ended: closed, meteredUntil: closed });

    // A later pass re-derives nothing: the running interval's windows and watermark stay as they are. (The stopped
    // interval that followed now bills its disk, which is new work, not a re-derivation.)
    const compute = (list: readonly WindowView[]) =>
      JSON.stringify(list.filter((row) => !row.meter.startsWith('disk.') || row.start < closed));
    const before = compute(rows);
    await meter(world, HOUR);
    expect(compute(await windows(world))).toBe(before);
    expect((await intervals(world, created.id))[0]!.meteredUntil).toBe(closed);
  });

  it('vcpu/memory/gpu/instance lines match the shape', async () => {
    // An 8×H100 a3-highgpu-8g: 208 vCPU, 1872 GiB, billed per whole hour.
    const world = await legacyAttachWorld();
    const { acme } = world.fixture.tenants;
    const a = await attachLegacy(world, acme.id, acme.caller.identityId, 'attach-a3');
    const h0 = nextHour(world);
    await moveTo(world, h0 - 1_000);
    await step(world, 1_000);
    expect((await intervals(world, a.id))[0]).toMatchObject({ started: h0, phase: 'running' });
    await moveTo(world, h0 + 3 * HOUR + settle);
    await meter(world, 0);
    const rows = await windows(world);
    expect(rows).toHaveLength(12);
    for (const hour of [0, 1, 2]) {
      const start = h0 + hour * HOUR;
      const at = rows.filter((row) => row.start === start);
      expect(at.map((row) => [row.meter, row.quantity])).toEqual([
        ['vm.gpu.h100.hours', 8],
        ['vm.instance.hours', 1],
        ['vm.memory.gib.hours', 1872],
        ['vm.vcpu.hours', 208],
      ]);
      expect(at.every((row) => row.end === start + HOUR)).toBe(true);
    }
    // Every key is the instance, the hour and the meter (ruling M5).
    for (const row of rows) expect(row.key).toBe(`cmp:instance:${a.id}:${row.start}:${row.meter}`);
  });

  it('usage is attributed to the issued tenant and owner', async () => {
    const world = await gceWorld();
    const { created, h0 } = await runningAtHour(world);
    // An instance with a project carries it as a tag.
    await world.fixture.database.query(
      `UPDATE instance_usage_intervals SET project_id = 'proj_blue' WHERE instance_id = $1`,
      [created.id],
    );
    await moveTo(world, h0 + HOUR + settle);
    await meter(world, 0);
    const rows = await windows(world);
    expect(rows.length).toBeGreaterThan(0);
    const { acme } = world.fixture.tenants;
    for (const row of rows) {
      expect(row.tenantId).toBe(world.acmeTenant);
      expect(row.identityId).toBe(acme.caller.identityId);
      expect(row.instanceId).toBe(created.id);
      expect(row.tags).toEqual({
        region: 'us-central1',
        pool: world.poolId,
        project: 'proj_blue',
        provider: 'fake-gce',
        gpuModel: 'a100',
        flavor: 'a2.highgpu.1g',
        source: 'instance',
      });
      // The tags never name the instance.
      expect(JSON.stringify(row.tags)).not.toContain(created.id);
    }
    expect(new Set(rows.map((row) => row.meter))).toEqual(
      new Set([
        'vm.vcpu.hours',
        'vm.memory.gib.hours',
        'vm.gpu.a100.hours',
        'vm.instance.hours',
        'disk.pd-balanced.gib.hours',
      ]),
    );
  });

  it('I8 conservation: the instance hours written equal the hours the intervals ran, restarts inside one hour included', async () => {
    const world = await gceWorld();
    const { created, h0 } = await runningAtHour(world);
    const toggle = async (action: 'stop' | 'start', at: number) => {
      await moveTo(world, at - 1_000);
      await world.api.instances[action](world.acme, {
        tenantId: world.acmeTenant,
        instanceId: created.id,
      });
      await step(world, 1_000);
    };
    // Hour 0: running 0-20m, stopped 20-40m, running 40-50m, stopped from 50m: two intervals share the hour.
    await toggle('stop', h0 + 20 * 60_000);
    await toggle('start', h0 + 40 * 60_000);
    await toggle('stop', h0 + 50 * 60_000);
    // Running 2h10m to 3h40m: both its ends are partial hours.
    await toggle('start', h0 + 130 * 60_000);
    // Metering mid-way (some hours ended, an interval open) must not matter.
    await moveTo(world, h0 + 160 * 60_000);
    await meter(world, 0);
    await toggle('stop', h0 + 220 * 60_000);
    await moveTo(world, h0 + 5 * HOUR + settle);
    await meter(world, 0);
    const list = await intervals(world, created.id);
    assertNoOverlap(list);
    const ranHours = list
      .filter((item) => item.phase === 'running')
      .reduce((total, item) => total + (item.ended! - item.started) / HOUR, 0);
    expect(ranHours).toBeCloseTo(30 / 60 + 90 / 60, 9);
    const rows = await windows(world);
    expect(sum(rows, 'vm.instance.hours')).toBeCloseTo(ranHours, 9);
    expect(sum(rows, 'vm.vcpu.hours')).toBeCloseTo(12 * ranHours, 6);
    expect(sum(rows, 'vm.memory.gib.hours')).toBeCloseTo(85 * ranHours, 6);
    expect(sum(rows, 'vm.gpu.a100.hours')).toBeCloseTo(ranHours, 6);
    // Both running intervals of hour 0 landed in its one window.
    expect(
      rows.find((row) => row.start === h0 && row.meter === 'vm.instance.hours')!.quantity,
    ).toBeCloseTo(0.5, 9);
    // One window per instance, hour and meter: the unique keys held.
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
  });

  it('a stopped interval with no known disk is advanced without windows; the running one is metered', async () => {
    const world = await legacyAttachWorld({ state: 'stopped' });
    const { acme } = world.fixture.tenants;
    const a = await attachLegacy(world, acme.id, acme.caller.identityId, 'attach-stopped-meter');
    const t1 = await step(world);
    expect((await intervals(world, a.id))[0]).toMatchObject({ phase: 'stopped', started: t1 });
    await moveTo(world, t1 + 4 * HOUR);
    await meter(world, 0);
    // An attached machine reports no disk and has no flavor disk (D9): a stopped VM has nothing else to bill.
    expect(await windows(world)).toEqual([]);
    expect((await intervals(world, a.id))[0]!.meteredUntil).toBeGreaterThan(t1);
    // Starting it closes the stopped interval and opens a metered running one.
    await world.api.instances.start(world.acme, { tenantId: acme.id, instanceId: a.id });
    const t2 = await step(world, 5_000);
    const settled = (Math.floor(t2 / HOUR) + 2) * HOUR;
    await moveTo(world, settled + settle);
    await meter(world, 0);
    const list = await intervals(world, a.id);
    expect(list.map((item) => [item.phase, item.meteredUntil])).toEqual([
      ['stopped', t2],
      ['running', settled],
    ]);
    expect((await windows(world)).length).toBeGreaterThan(0);
  });

  it('a stopped interval whose machine reports disks bills them', async () => {
    const world = await legacyAttachWorld({
      state: 'stopped',
      disks: [{ type: 'pd-ssd', sizeGiB: 200, boot: true }],
    });
    const { acme } = world.fixture.tenants;
    const a = await attachLegacy(world, acme.id, acme.caller.identityId, 'attach-stopped-disks');
    const t1 = await step(world);
    expect((await intervals(world, a.id))[0]).toMatchObject({
      phase: 'stopped',
      shape: { disks: [{ type: 'pd-ssd', sizeGiB: 200 }] },
    });
    const h1 = (Math.floor(t1 / HOUR) + 1) * HOUR;
    await moveTo(world, h1 + 2 * HOUR + settle);
    await meter(world, 0);
    const rows = await windows(world);
    // The part hour the interval opened in, then two whole hours.
    expect(rows.map((row) => [row.meter, row.start])).toEqual([
      ['disk.pd-ssd.gib.hours', h1 - HOUR],
      ['disk.pd-ssd.gib.hours', h1],
      ['disk.pd-ssd.gib.hours', h1 + HOUR],
    ]);
    expect(rows[0]!.quantity).toBeCloseTo((200 * (h1 - t1)) / HOUR, 4);
    expect(rows.slice(1).map((row) => row.quantity)).toEqual([200, 200]);
  });

  it('a zero-length interval writes nothing and is metered; the others still run', async () => {
    const world = await gceWorld();
    const { created, h0 } = await runningAtHour(world);
    // A second VM whose interval opened and closed at the same instant.
    const other = await createVm(world, 'vm-2');
    await step(world, 1_000);
    const [zero] = await intervals(world, other.id);
    await world.fixture.database.query(
      `UPDATE instance_usage_intervals SET ended_at = started_at WHERE instance_id = $1`,
      [other.id],
    );
    await moveTo(world, h0 + 2 * HOUR + settle);
    await meter(world, 0);
    const rows = await windows(world);
    expect(rows.filter((row) => row.instanceId === other.id)).toEqual([]);
    expect(rows.filter((row) => row.instanceId === created.id).length).toBeGreaterThan(0);
    const [done] = await intervals(world, other.id);
    expect(done).toMatchObject({ ended: zero!.started, meteredUntil: zero!.started });
  });

  it('a mode none interval writes nothing and is metered', async () => {
    const world = await gceWorld();
    const { created, h0 } = await runningAtHour(world);
    await world.fixture.database.query(
      `UPDATE instance_usage_intervals SET mode = 'none' WHERE instance_id = $1`,
      [created.id],
    );
    await moveTo(world, h0 + 3 * HOUR + settle);
    await meter(world, 0);
    expect(await windows(world)).toEqual([]);
    expect(await meteredUntil(world, created.id)).toEqual([h0 + 3 * HOUR]);
  });

  it('a stopped mode none interval is advanced too: nothing of it is ever billed', async () => {
    const world = await legacyAttachWorld({ state: 'stopped' });
    const { acme } = world.fixture.tenants;
    const a = await attachLegacy(world, acme.id, acme.caller.identityId, 'attach-stopped-none');
    const t1 = await step(world);
    await world.fixture.database.query(
      `UPDATE instance_usage_intervals SET mode = 'none' WHERE instance_id = $1`,
      [a.id],
    );
    await moveTo(world, t1 + 3 * HOUR + settle);
    await meter(world, 0);
    expect(await windows(world)).toEqual([]);
    const cutoff = Math.floor((world.fixture.clock.now() - grace) / HOUR) * HOUR;
    expect(await meteredUntil(world, a.id)).toEqual([cutoff]);
    // Due no more: the next pass selects nothing and changes nothing.
    await meter(world, 10 * 60_000);
    expect(await meteredUntil(world, a.id)).toEqual([cutoff]);
  });

  it('an hour younger than the grace is not written yet (F7-1)', async () => {
    const world = await gceWorld();
    const { created, h0 } = await runningAtHour(world);
    await moveTo(world, h0 + HOUR + 2 * 60_000);
    await meter(world, 0);
    expect(await windows(world)).toEqual([]);
    expect(await meteredUntil(world, created.id)).toEqual([h0]);
    // Once the grace has passed (the periodic key is due again in 5 minutes), the hour is written.
    await meter(world);
    expect(world.fixture.clock.now()).toBeGreaterThanOrEqual(h0 + HOUR + grace);
    expect(hoursOf(await windows(world))).toEqual([[h0, 1]]);
    expect(await meteredUntil(world, created.id)).toEqual([h0 + HOUR]);
  });

  it('the grace is configurable: billing.meterGraceMs', async () => {
    const world = await gceWorld({ billing: { meterGraceMs: 0 } });
    const { h0 } = await runningAtHour(world);
    await moveTo(world, h0 + HOUR + 1_000);
    await meter(world, 0);
    expect(hoursOf(await windows(world))).toEqual([[h0, 1]]);
    // From 0 to an hour, finite (FW-10).
    for (const meterGraceMs of [-1, 3_600_001, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => vps({ billing: { meterGraceMs } })).toThrow(/meterGraceMs/);
    expect(() => vps({ billing: { meterGraceMs: 3_600_000 } })).not.toThrow();
  });

  it('a close stamped inside an hour the pass already wrote leaves interval and windows consistent (F7-1, I8)', async () => {
    const world = await gceWorld();
    const { created, h0 } = await runningAtHour(world);
    await moveTo(world, h0 + 2 * HOUR + settle);
    await meter(world, 0);
    expect(hoursOf(await windows(world))).toEqual([
      [h0, 1],
      [h0 + HOUR, 1],
    ]);
    expect(await meteredUntil(world, created.id)).toEqual([h0 + 2 * HOUR]);
    // A lifecycle close whose timestamp is inside hour 1, committed after that hour was written.
    await world.fixture.database.transaction((tx) =>
      closeOpenInterval(tx, created.id, h0 + 2 * HOUR - 1_000),
    );
    const [closed] = await intervals(world, created.id);
    expect(closed).toMatchObject({ ended: h0 + 2 * HOUR, meteredUntil: h0 + 2 * HOUR });
    // Later passes add nothing: the interval is fully metered and not billed beyond what was written.
    await moveTo(world, h0 + 4 * HOUR);
    await meter(world, 0);
    const rows = await windows(world);
    expect(hoursOf(rows)).toHaveLength(2);
    const ran = (closed!.ended! - closed!.started) / HOUR;
    expect(sum(rows, 'vm.instance.hours')).toBeCloseTo(ran, 9);
  });

  it('a platform-fee interval is one managed line per hour', async () => {
    const world = await gceWorld();
    const { created, h0 } = await runningAtHour(world);
    await world.fixture.database.query(
      `UPDATE instance_usage_intervals SET mode = 'platform-fee' WHERE instance_id = $1`,
      [created.id],
    );
    await moveTo(world, h0 + 2 * HOUR + settle);
    await meter(world, 0);
    expect((await windows(world)).map((row) => [row.meter, row.quantity])).toEqual([
      ['vm.managed.hours', 1],
      ['vm.managed.hours', 1],
    ]);
  });

  it('the operator catalog names the GPU model: a non-default model meters on a meter the catalog has', async () => {
    const gpuModels = ['H100', 'MI300X'];
    const world = await gceWorld({ discovery: { every: '1m' }, billing: { gpuModels } });
    world.cloud.machines.set(
      LEGACY_VM,
      gceVm('legacy', { gpus: { model: 'amd-mi300x', count: 8 } }),
    );
    await world.discover(0);
    const { acme } = world.fixture.tenants;
    const a = await attachLegacy(world, acme.id, acme.caller.identityId, 'attach-mi300x');
    await step(world);
    expect((await intervals(world, a.id))[0]!.shape.gpus).toEqual({ model: 'mi300x', count: 8 });
    await moveTo(world, nextHour(world) + 2 * HOUR + settle);
    await meter(world, 0);
    const rows = await windows(world);
    expect(rows.length).toBeGreaterThan(0);
    const catalog = new Set(meterCatalog({ gpuModels }).map((item) => item.key));
    expect(rows.some((row) => row.meter === 'vm.gpu.mi300x.hours')).toBe(true);
    expect(rows.some((row) => row.meter === 'vm.gpu.other.hours')).toBe(false);
    for (const row of rows) expect(catalog.has(row.meter), row.meter).toBe(true);
    expect(rows[0]!.tags.gpuModel).toBe('mi300x');
  });

  it('is a singleton periodic reconciler', () => {
    const reconciler = vps({ providers: [] }).reconcilers!.find((item) => item.name === usageJob)!;
    expect(reconciler).toMatchObject({
      shardBy: 'none',
      periodic: [{ key: 'all', every: '5m' }],
    });
  });

  it('flushed through iam.usage as recorded', async () => {
    const world = await gceWorld();
    const { h0 } = await runningAtHour(world);
    await moveTo(world, h0 + 2 * HOUR + settle);
    await meter(world, 0);
    // Two hours of vcpu, memory, gpu, instance and the 100 GiB boot disk.
    expect((await windows(world)).length).toBe(10);

    // An embedded better-iam with the compute catalog, defined by a service credential (as setup does).
    const bridge = createComputeIamBridge();
    const f = await iamFixture({
      plugins: [bridge.plugin()],
      resolveResource: bridge.resolveResource(),
    });
    const port = bridge.embedded(f.iam, {
      rootTenantId: f.rootTenantId,
      serviceCredential: f.rootCredential,
    });
    await port.ensureMeters!(meterCatalog({ gpuModels: defaultMeterGpuModels }));
    // The windows belong to compute's fixture tenant; better-iam knows its own organization.
    await world.fixture.database.query(
      `UPDATE usage_windows SET tenant_id = $1, identity_id = $2 WHERE source_kind = 'instance'`,
      [f.tenantId, f.ownerId],
    );
    expect(await flushUsageWindows(world.fixture.database, port)).toMatchObject({
      sent: 10,
      deadLettered: 0,
    });
    expect((await windows(world)).every((row) => row.outcome === 'recorded')).toBe(true);
    // A second flush has nothing left to send.
    expect(await flushUsageWindows(world.fixture.database, port)).toMatchObject({ sent: 0 });
  }, 60_000);

  // --- Task 8: pool billing modes, attach billing, flavor meters (D5, D6) -------------------------------
  // The API knobs the metering above already honours: `policy.billing.mode` on a pool, `billing: 'none'` on
  // attach, and `billing.meter` on a flavor. All three are root's: a tenant must not choose what it pays.

  describe('modes', () => {
    const OFFER = 'us-central1-a/a2-highgpu-1g';
    const codeOf = (promise: Promise<unknown>) =>
      promise.then(
        () => 'allowed',
        (error: { code?: string }) => error?.code ?? String(error),
      );

    /** Acme with its own provider account, site, pool and flavor, in a cloud of its own (BYO). */
    async function byoWorld(options: { discovery?: { every: string } } = {}) {
      const byo: FakeGce = { machines: new Map(), requests: [] };
      const world = await gceWorld({
        ...options,
        providers: [fakeGceProvider(byo, 'fake-gce-byo')],
      });
      const tenantId = world.acmeTenant;
      const account = await world.api.providerAccounts.create(world.acme, {
        tenantId,
        provider: 'fake-gce-byo',
        name: 'acme-gcp',
        config: {},
      });
      const site = await world.api.sites.create(world.acme, {
        tenantId,
        kind: 'custom',
        region: 'us-central1',
        idempotencyKey: 'acme-site',
      });
      const pool = await world.api.pools.create(world.acme, {
        tenantId,
        siteId: site.id,
        class: 'provider',
        providerAccountId: account.id,
        ownerQuota: { vcpu: 100, memoryGiB: 1000, diskGiB: 10_000, gpu: 8 },
        idempotencyKey: 'acme-pool',
      });
      await world.api.flavors.create(world.acme, {
        tenantId,
        poolId: pool.id,
        name: 'a2.byo',
        vcpu: 12,
        memoryGiB: 85,
        diskGiB: 100,
        gpus: 1,
        offerId: OFFER,
      });
      return { world, byo, account, site, pool };
    }

    /** A root-created flavor on the shared pool, optionally with a whole-shape meter. */
    const rootFlavor = (world: GceWorld, name: string, meterKey?: string) =>
      world.api.flavors.create(world.root, {
        tenantId: world.rootTenant,
        poolId: world.poolId,
        name,
        vcpu: 12,
        memoryGiB: 85,
        diskGiB: 100,
        gpus: 1,
        offerId: OFFER,
        ...(meterKey === undefined ? {} : { billing: { meter: meterKey } }),
      });

    const createFrom = (world: GceWorld, flavor: string, key: string) =>
      world.api.instances.create(world.acme, {
        tenantId: world.acmeTenant,
        poolId: world.poolId,
        flavor,
        imageId: 'debian-12',
        idempotencyKey: key,
      });

    /** A VM running from a top of the hour, with three whole hours metered. */
    async function meterThreeHours(world: GceWorld, created: { id: string }, h0: number) {
      await moveTo(world, h0 + 3 * HOUR + settle);
      await meter(world, 0);
      return windows(world).then((rows) => rows.filter((row) => row.instanceId === created.id));
    }

    /** An IAM port that can define meters: records what it is asked to ensure. */
    function ensuring(world: GceWorld) {
      const asked: string[][] = [];
      Object.assign(world.fixture.iam, {
        ensureMeters: async (meters: readonly { key: string }[]) => {
          asked.push(meters.map((item) => item.key));
          return { created: meters.map((item) => item.key), existing: [] as string[] };
        },
      });
      return asked;
    }

    it('BYO pools bill a platform fee only', async () => {
      const { world, byo, pool } = await byoWorld();
      expect(pool.policy).toEqual({});
      const created = await world.api.instances.create(world.acme, {
        tenantId: world.acmeTenant,
        poolId: pool.id,
        flavor: 'a2.byo',
        imageId: 'debian-12',
        idempotencyKey: 'byo-vm',
      });
      const h0 = nextHour(world);
      await moveTo(world, h0 - 1_000);
      await step(world, 1_000);
      expect((await viewOf(world, created.id)).state).toBe('running');
      expect(byo.requests.some((request) => request.startsWith('create'))).toBe(true);
      expect((await intervals(world, created.id))[0]).toMatchObject({ mode: 'platform-fee' });
      const rows = await meterThreeHours(world, created, h0);
      expect(rows.map((row) => [row.meter, row.quantity])).toEqual([
        ['vm.managed.hours', 1],
        ['vm.managed.hours', 1],
        ['vm.managed.hours', 1],
      ]);
      expect(
        rows.some((row) => row.meter.startsWith('vm.') && row.meter !== 'vm.managed.hours'),
      ).toBe(false);
    });

    it('policy.billing none bills nothing', async () => {
      const world = await gceWorld();
      const updated = await world.api.pools.update(world.root, {
        tenantId: world.rootTenant,
        poolId: world.poolId,
        policy: { billing: { mode: 'none' } },
      });
      expect(updated.policy).toEqual({ billing: { mode: 'none' } });
      const { created, h0 } = await runningAtHour(world);
      expect((await intervals(world, created.id))[0]).toMatchObject({ mode: 'none' });
      expect(await meterThreeHours(world, created, h0)).toEqual([]);
      expect(await meteredUntil(world, created.id)).toEqual([h0 + 3 * HOUR]);
    });

    it('policy.billing platform-fee on a root pool bills the managed line', async () => {
      const world = await gceWorld();
      await world.api.pools.update(world.root, {
        tenantId: world.rootTenant,
        poolId: world.poolId,
        policy: { billing: { mode: 'platform-fee' } },
      });
      const { created, h0 } = await runningAtHour(world);
      const rows = await meterThreeHours(world, created, h0);
      expect(new Set(rows.map((row) => row.meter))).toEqual(new Set(['vm.managed.hours']));
    });

    it('a pool policy takes only a known billing mode', async () => {
      const world = await gceWorld();
      for (const policy of [
        { billing: { mode: 'free' } },
        { billing: 'none' },
        { billing: {} },
        { billing: { mode: 'none', extra: 1 } },
      ])
        expect(
          await codeOf(
            world.api.pools.update(world.root, {
              tenantId: world.rootTenant,
              poolId: world.poolId,
              policy,
            }),
          ),
        ).toBe('INVALID_INPUT');
    });

    it('a tenant cannot set policy.billing on a pool it creates or updates', async () => {
      const { world, site, account, pool } = await byoWorld();
      const create = (billing: unknown, key: string) =>
        world.api.pools.create(world.acme, {
          tenantId: world.acmeTenant,
          siteId: site.id,
          class: 'provider',
          providerAccountId: account.id,
          policy: { billing },
          idempotencyKey: key,
        });
      expect(await codeOf(create({ mode: 'none' }, 'p-none'))).toBe('ACCESS_DENIED');
      expect(await codeOf(create({ mode: 'metered' }, 'p-metered'))).toBe('ACCESS_DENIED');
      const update = (policy: PoolPolicy) =>
        world.api.pools.update(world.acme, {
          tenantId: world.acmeTenant,
          poolId: pool.id,
          policy,
        });
      expect(await codeOf(update({ billing: { mode: 'none' } }))).toBe('ACCESS_DENIED');
      // A policy without billing is still the tenant's to change, and nothing was written by the refusals.
      expect(await codeOf(update({ singleTenant: false }))).toBe('allowed');
      const { rows } = await world.fixture.database.query<{ policy: PoolPolicy }>(
        `SELECT policy FROM pools WHERE owner_tenant_id = $1 AND id = $2`,
        [world.acmeTenant, pool.id],
      );
      expect(rows[0]!.policy).toEqual({ singleTenant: false });
    });

    it('a tenant cannot drop or change a billing mode the platform set on its pool', async () => {
      const { world, pool } = await byoWorld();
      // The platform configures the tenant's pool (a root caller acting in the tenant).
      await world.api.pools.update(world.root, {
        tenantId: world.acmeTenant,
        poolId: pool.id,
        policy: { billing: { mode: 'none' } },
      });
      const update = (policy: PoolPolicy) =>
        world.api.pools.update(world.acme, { tenantId: world.acmeTenant, poolId: pool.id, policy });
      expect(await codeOf(update({}))).toBe('ACCESS_DENIED');
      expect(await codeOf(update({ billing: { mode: 'metered' } }))).toBe('ACCESS_DENIED');
      // Resending what is there changes nothing, so it is allowed.
      expect(await codeOf(update({ billing: { mode: 'none' }, singleTenant: false }))).toBe(
        'allowed',
      );
    });

    it('root attaches with billing none and nothing is metered', async () => {
      const world = await legacyAttachWorld();
      const { acme } = world.fixture.tenants;
      const a = await world.api.instances.attach(world.root, {
        tenantId: acme.id,
        poolId: world.poolId,
        externalId: LEGACY_VM,
        ownerIdentityId: acme.caller.identityId,
        billing: 'none',
        idempotencyKey: 'attach-root-none',
      });
      const { rows } = await world.fixture.database.query<{ billing: string | null }>(
        `SELECT billing FROM instances WHERE id = $1`,
        [a.id],
      );
      expect(rows[0]!.billing).toBe('none');
      const h0 = nextHour(world);
      await moveTo(world, h0 - 1_000);
      await step(world, 1_000);
      expect((await viewOf(world, a.id)).state).toBe('running');
      expect(await intervals(world)).toEqual([]);
      await moveTo(world, h0 + 3 * HOUR + settle);
      await meter(world, 0);
      expect(await windows(world)).toEqual([]);
    });

    it('attach without billing is metered by the pool; billing metered is stored as given', async () => {
      const world = await legacyAttachWorld();
      const { acme } = world.fixture.tenants;
      const a = await world.api.instances.attach(world.root, {
        tenantId: acme.id,
        poolId: world.poolId,
        externalId: LEGACY_VM,
        ownerIdentityId: acme.caller.identityId,
        billing: 'metered',
        idempotencyKey: 'attach-root-metered',
      });
      const { rows } = await world.fixture.database.query<{ billing: string | null }>(
        `SELECT billing FROM instances WHERE id = $1`,
        [a.id],
      );
      expect(rows[0]!.billing).toBe('metered');
      await step(world);
      expect((await intervals(world, a.id))[0]).toMatchObject({
        mode: 'metered',
        phase: 'running',
      });
      // The same key with another billing is a different request.
      expect(
        await codeOf(
          world.api.instances.attach(world.root, {
            tenantId: acme.id,
            poolId: world.poolId,
            externalId: LEGACY_VM,
            ownerIdentityId: acme.caller.identityId,
            billing: 'none',
            idempotencyKey: 'attach-root-metered',
          }),
        ),
      ).toBe('CONFLICT');
    });

    it('a tenant cannot attach with billing none', async () => {
      const { world, byo, pool } = await byoWorld({ discovery: { every: '1m' } });
      byo.machines.set(
        LEGACY_VM,
        gceVm('legacy', { vcpu: 12, memoryGiB: 85, gpus: { model: 'nvidia-a100-40gb', count: 1 } }),
      );
      await world.discover(0);
      const attach = (billing: 'none' | 'metered' | undefined, key: string) =>
        world.api.instances.attach(world.acme, {
          tenantId: world.acmeTenant,
          poolId: pool.id,
          externalId: LEGACY_VM,
          ...(billing === undefined ? {} : { billing }),
          idempotencyKey: key,
        });
      const denied = await attach('none', 'tenant-none').then(
        () => undefined,
        (error: { code?: string; message?: string }) => error,
      );
      expect(denied?.code).toBe('ACCESS_DENIED');
      expect(denied?.message).toMatch(/billing/);
      // Nothing was written: the machine is still free, and the tenant may attach it metered.
      const { rows } = await world.fixture.database.query(
        `SELECT 1 FROM instances WHERE origin = 'attached'`,
      );
      expect(rows).toHaveLength(0);
      expect(await codeOf(attach('metered', 'tenant-metered'))).toBe('allowed');
    });

    it('attach takes only metered or none', async () => {
      const world = await legacyAttachWorld();
      const { acme } = world.fixture.tenants;
      expect(
        await codeOf(
          world.api.instances.attach(world.root, {
            tenantId: acme.id,
            poolId: world.poolId,
            externalId: LEGACY_VM,
            billing: 'platform-fee',
            idempotencyKey: 'attach-bad-billing',
          }),
        ),
      ).toBe('INVALID_INPUT');
    });

    it('a flavor meter replaces composed lines', async () => {
      const world = await gceWorld();
      const asked = ensuring(world);
      const key = 'flavor.a2-1g.us-central1.hours';
      const flavor = await rootFlavor(world, 'a2.metered', key);
      expect(flavor.billing).toEqual({ meter: key });
      expect(asked).toEqual([[key]]);
      const created = await createFrom(world, 'a2.metered', 'metered-vm');
      const h0 = nextHour(world);
      await moveTo(world, h0 - 1_000);
      await step(world, 1_000);
      expect((await viewOf(world, created.id)).state).toBe('running');
      // The meter is in the instance's flavor snapshot (ruling F6-3).
      const snapshot = await world.fixture.database.query<{ billing: unknown }>(
        `SELECT flavor->'billing' AS billing FROM instances WHERE id = $1`,
        [created.id],
      );
      expect(snapshot.rows[0]!.billing).toEqual({ meter: key });
      const rows = await meterThreeHours(world, created, h0);
      // A flavor meter replaces the composed compute lines only: the boot disk is still its own line (D9).
      expect(rows.map((row) => [row.meter, row.quantity])).toEqual([
        ['disk.pd-balanced.gib.hours', 100],
        [key, 1],
        ['disk.pd-balanced.gib.hours', 100],
        [key, 1],
        ['disk.pd-balanced.gib.hours', 100],
        [key, 1],
      ]);
      expect(rows.some((row) => row.meter.startsWith('vm.'))).toBe(false);
    });

    it('flavors accept only well-formed flavor meters, and only from root', async () => {
      const world = await gceWorld();
      ensuring(world);
      for (const bad of [
        'vm.vcpu.hours',
        'flavor.hours',
        'flavor..hours',
        'flavor.A2.hours',
        'flavor.a2.minutes',
        `flavor.${'a'.repeat(52)}.hours`,
      ])
        expect(await codeOf(rootFlavor(world, 'bad', bad)), bad).toBe('INVALID_INPUT');
      expect(await codeOf(rootFlavor(world, 'longest', `flavor.${'a'.repeat(51)}.hours`))).toBe(
        'allowed',
      );
      // A tenant would otherwise define meters on the platform's billing tenant.
      const { world: byo, pool } = await byoWorld();
      ensuring(byo);
      expect(
        await codeOf(
          byo.api.flavors.create(byo.acme, {
            tenantId: byo.acmeTenant,
            poolId: pool.id,
            name: 'sneaky',
            vcpu: 1,
            memoryGiB: 1,
            diskGiB: 1,
            offerId: OFFER,
            billing: { meter: 'flavor.sneaky.hours' },
          }),
        ),
      ).toBe('ACCESS_DENIED');
    });

    it('a flavor meter is accepted when the port cannot define meters (billing.meters.missing reports it)', async () => {
      const world = await gceWorld();
      const flavor = await rootFlavor(world, 'a2.noport', 'flavor.noport.hours');
      expect(flavor.billing).toEqual({ meter: 'flavor.noport.hours' });
    });

    it('flavors.update sets, keeps and clears the meter', async () => {
      const world = await gceWorld();
      const asked = ensuring(world);
      const shape = {
        tenantId: world.rootTenant,
        poolId: world.poolId,
        name: 'a2.update',
        vcpu: 12,
        memoryGiB: 85,
        diskGiB: 100,
        gpus: 1,
        offerId: OFFER,
      };
      await world.api.flavors.create(world.root, shape);
      const set = await world.api.flavors.update(world.root, {
        ...shape,
        billing: { meter: 'flavor.u1.hours' },
      });
      expect(set.billing).toEqual({ meter: 'flavor.u1.hours' });
      expect(asked).toEqual([['flavor.u1.hours']]);
      // Omitted: kept.
      expect((await world.api.flavors.update(world.root, shape)).billing).toEqual({
        meter: 'flavor.u1.hours',
      });
      // An empty billing object clears it.
      const cleared = await world.api.flavors.update(world.root, { ...shape, billing: {} });
      expect(cleared.billing).toBeUndefined();
      const listed = await world.api.flavors.list(world.root, {
        tenantId: world.rootTenant,
        poolId: world.poolId,
      });
      expect(
        listed.items.find((item: { name: string }) => item.name === 'a2.update').billing,
      ).toBeUndefined();
    });

    it('a tenant cannot add, change or clear the meter root set on its flavor; resending it is fine (F8-1)', async () => {
      const { world, pool } = await byoWorld();
      ensuring(world);
      const shape = {
        tenantId: world.acmeTenant,
        poolId: pool.id,
        name: 'a2.byo',
        vcpu: 12,
        memoryGiB: 85,
        diskGiB: 100,
        gpus: 1,
        offerId: OFFER,
      };
      const meterOf = async () => {
        const { rows } = await world.fixture.database.query<{ meter: string | null }>(
          `SELECT billing->>'meter' AS meter FROM flavors WHERE pool_id = $1 AND name = 'a2.byo'`,
          [pool.id],
        );
        return rows[0]!.meter;
      };
      const asTenant = (billing?: { meter?: string }) =>
        codeOf(
          world.api.flavors.update(world.acme, {
            ...shape,
            ...(billing === undefined ? {} : { billing }),
          }),
        );
      // Before root sets anything, an empty billing is no change.
      expect(await asTenant({})).toBe('allowed');
      // Root (acting in the tenant) sets the meter.
      await world.api.flavors.update(world.root, {
        ...shape,
        billing: { meter: 'flavor.byo.hours' },
      });
      expect(await meterOf()).toBe('flavor.byo.hours');
      // The tenant may not clear or change it, and nothing is written.
      expect(await asTenant({})).toBe('ACCESS_DENIED');
      expect(await asTenant({ meter: 'flavor.other.hours' })).toBe('ACCESS_DENIED');
      expect(await meterOf()).toBe('flavor.byo.hours');
      // Resending it unchanged, or omitting billing, is allowed and keeps it.
      expect(await asTenant({ meter: 'flavor.byo.hours' })).toBe('allowed');
      expect(await asTenant()).toBe('allowed');
      expect(await meterOf()).toBe('flavor.byo.hours');
      // Root may clear it.
      await world.api.flavors.update(world.root, { ...shape, billing: {} });
      expect(await meterOf()).toBeNull();
    });

    it('billing.syncMeters includes the flavor meters', async () => {
      const world = await gceWorld();
      const asked = ensuring(world);
      await rootFlavor(world, 'a2.sync', 'flavor.sync.hours');
      asked.length = 0;
      await world.api.billing.syncMeters(world.root, {});
      expect(asked).toHaveLength(1);
      expect(asked[0]).toContain('flavor.sync.hours');
      expect(asked[0]).toContain('vm.instance.hours');
    });

    it('an instance keeps the meter of the flavor it was admitted with (snapshot wins over the live flavor)', async () => {
      const world = await gceWorld();
      ensuring(world);
      await rootFlavor(world, 'a2.snap', 'flavor.first.hours');
      const created = await createFrom(world, 'a2.snap', 'snap-vm');
      const t1 = await step(world);
      // Root re-prices the flavor and then removes its meter; the running VM is unaffected.
      const shape = {
        tenantId: world.rootTenant,
        poolId: world.poolId,
        name: 'a2.snap',
        vcpu: 12,
        memoryGiB: 85,
        diskGiB: 100,
        gpus: 1,
        offerId: OFFER,
      };
      await world.api.flavors.update(world.root, {
        ...shape,
        billing: { meter: 'flavor.second.hours' },
      });
      await world.api.instances.stop(world.acme, {
        tenantId: world.acmeTenant,
        instanceId: created.id,
      });
      await step(world, 5_000);
      await world.api.instances.start(world.acme, {
        tenantId: world.acmeTenant,
        instanceId: created.id,
      });
      await step(world, 5_000);
      const list = await intervals(world, created.id);
      expect(
        list.filter((item) => item.phase === 'running').map((item) => item.shape.flavorMeter),
      ).toEqual(['flavor.first.hours', 'flavor.first.hours']);
      expect(list[0]!.started).toBe(t1);
    });

    it('a flavor given a meter later does not change instances admitted without one', async () => {
      const world = await gceWorld();
      ensuring(world);
      const created = await createFrom(world, 'a2.highgpu.1g', 'plain-vm');
      await step(world);
      const { rows } = await world.fixture.database.query<{ has: boolean }>(
        `SELECT flavor ? 'billing' AS has FROM instances WHERE id = $1`,
        [created.id],
      );
      expect(rows[0]!.has).toBe(true);
      await world.api.flavors.update(world.root, {
        tenantId: world.rootTenant,
        poolId: world.poolId,
        name: 'a2.highgpu.1g',
        vcpu: 12,
        memoryGiB: 85,
        diskGiB: 100,
        gpus: 1,
        offerId: OFFER,
        billing: { meter: 'flavor.late.hours' },
      });
      await world.api.instances.stop(world.acme, {
        tenantId: world.acmeTenant,
        instanceId: created.id,
      });
      await step(world, 5_000);
      await world.api.instances.start(world.acme, {
        tenantId: world.acmeTenant,
        instanceId: created.id,
      });
      await step(world, 5_000);
      const running = (await intervals(world, created.id)).filter(
        (item) => item.phase === 'running',
      );
      expect(running).toHaveLength(2);
      for (const item of running) expect(item.shape.flavorMeter).toBeUndefined();
    });

    it('a row admitted before snapshots carried billing still reads the live flavor meter', async () => {
      const world = await gceWorld();
      ensuring(world);
      const shape = {
        tenantId: world.rootTenant,
        poolId: world.poolId,
        name: 'a2.legacy',
        vcpu: 12,
        memoryGiB: 85,
        diskGiB: 100,
        gpus: 1,
        offerId: OFFER,
      };
      await world.api.flavors.create(world.root, {
        ...shape,
        billing: { meter: 'flavor.admitted.hours' },
      });
      const created = await createFrom(world, 'a2.legacy', 'legacy-vm');
      // As if admitted by the code before Task 8: the snapshot has no billing key at all.
      await world.fixture.database.query(
        `UPDATE instances SET flavor = flavor - 'billing' WHERE id = $1`,
        [created.id],
      );
      await world.api.flavors.update(world.root, {
        ...shape,
        billing: { meter: 'flavor.live.hours' },
      });
      await step(world);
      const [open] = await intervals(world, created.id);
      expect(open!.shape.flavorMeter).toBe('flavor.live.hours');
    });
  });
});

describe('admission resolves the billing mode as metering does (FW-15)', () => {
  it("a pool's account counts only when it is the pool owner's", async () => {
    const world = await gceWorld();
    // A root pool whose account row names another tenant (never through the API): metering ignores that account
    // (ruling R1), so the pool is root's and metered; admission must say the same.
    const byo = await world.api.providerAccounts.create(world.acme, {
      tenantId: world.acmeTenant,
      provider: 'fake-gce',
      name: 'acme-own',
      config: {},
    });
    await world.fixture.database.query(`UPDATE pools SET provider_account_id = $2 WHERE id = $1`, [
      world.poolId,
      byo.id,
    ]);
    const context = {
      sql: world.fixture.database,
      iam: { rootTenantId: world.rootTenant },
    } as unknown as Parameters<typeof poolBillingMode>[0];
    expect(await poolBillingMode(context, world.poolId)).toBe('metered');
  });
});
