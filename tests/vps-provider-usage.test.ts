import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultMeterGpuModels,
  meterCatalog,
  canonicalGpuModel,
  type ExternalMachine,
  type PoolPolicy,
} from '@better-compute/core';
import { betterCompute } from '@better-compute/server';
import { closeFixtures } from '@better-compute/testing';
import {
  billingModeOf,
  meterLinesFor,
  vps,
  type BillableShape,
  type BillingMode,
} from '@better-compute/vps';
import {
  fakeGceProvider,
  gceVm,
  gceWorld,
  plainProvider,
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

  it('stopped returns no lines yet', () => {
    for (const mode of ['metered', 'platform-fee', 'none'] as const)
      expect(meterLinesFor(base, mode, 'stopped')).toEqual([]);
  });

  it('publicIp and disks produce no lines yet', () => {
    expect(lines({ publicIp: true, disks: [{ type: 'pd-ssd', sizeGiB: 100 }] })).toEqual(lines({}));
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
    let checked = 0;
    for (const mode of ['metered', 'platform-fee', 'none'] as const)
      for (const phase of ['running', 'stopped'] as const)
        for (const gpus of gpuChoices)
          for (const spot of [false, true])
            for (const reserved of [false, true])
              for (const granted of [false, true])
                for (const meter of [undefined, flavorMeter])
                  for (const publicIp of [false, true]) {
                    const shape: BillableShape = {
                      ...base,
                      gpus,
                      spot,
                      reserved,
                      granted,
                      flavorMeter: meter,
                      publicIp,
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
