import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  canonicalGpuModel,
  defaultMeterGpuModels,
  manualClock,
  meterCatalog,
  type Credential,
  type PriceSpecInput,
  type SqlExecutor,
} from '@better-compute/core';
import { createEmbeddedTestIam, type EmbeddedTestIam } from '@better-compute/iam/testing';
import { useSimClock } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import { gcpProvider } from '@better-compute/provider-gcp';
import { betterCompute, type BetterCompute } from '@better-compute/server';
import { vps } from '@better-compute/vps';
import { GceEmulator } from './support/gce-emulator.js';

// The root-only `billing` API group (platform compute billing, D13): meters and prices on the IAM root tenant,
// decided on `compute:billing:*` @ fleet. Everything runs against a REAL better-iam (embedded, with compute's
// plugin and resolver), as tests/root-issued-compute-iam.test.ts does: the root administrator (MFA) is let through
// by ROOT_OVERRIDE, a tenant administrator is turned away before any IAM decision, and a root-tenant member holds
// only what its policy grants on the fleet.

// A model the bridge's own catalog does not name, so its VM meters are missing until syncMeters creates them.
const MODEL = 'zz9';

let t: EmbeddedTestIam;
let compute: BetterCompute<any, any>;
let database: SqlExecutor;
let api: any;
let root: Credential;
let R: string;
let A: string;
let B: string;
let acmeAdmin: Credential;
let reader: Credential;
// Hides the billing members from the port while set: the "port without the member" case.
let hidden = false;
// The provider behind the proposals and estimates: Compute Engine over the emulator (SKUs in its catalog section).
const emu = new GceEmulator();
emu.validTokens.add('host-token');
// How many times the port was asked to quote.
let quoted = 0;
const billingMembers = new Set<PropertyKey>([
  'ensureMeters',
  'listMeters',
  'setPrice',
  'listPrices',
  'quote',
  'spend',
]);

const clock = manualClock(Math.floor(Date.now() / 1000) * 1000);
const period = new Date(clock.now()).toISOString().slice(0, 7);
const perUnit = (unitAmountMicros: number): PriceSpecInput => ({
  model: 'per-unit',
  unitAmountMicros,
});
const outcome = (promise: Promise<unknown>): Promise<string> =>
  promise.then(
    () => 'allowed',
    (error: { code?: string }) => error?.code ?? String(error),
  );
const failure = (promise: Promise<unknown>): Promise<{ code?: string; message: string }> =>
  promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (error) => error,
  );

beforeAll(async () => {
  t = await createEmbeddedTestIam({ now: () => Date.now() });
  database = pglite();
  const port = new Proxy(t.port, {
    get: (target, key) => {
      if (hidden && billingMembers.has(key)) return undefined;
      if (key === 'quote' && typeof target.quote === 'function')
        return (...args: Parameters<NonNullable<typeof target.quote>>) => {
          quoted += 1;
          return target.quote!(...args);
        };
      return Reflect.get(target, key);
    },
  });
  compute = betterCompute({
    database,
    iam: port,
    secret: 'better-compute-vps-pricing-secret-0123456789',
    baseURL: 'http://127.0.0.1:3000',
    clock,
    modules: [
      ...t.bridge.modules,
      vps({
        billing: { gpuModels: [...defaultMeterGpuModels, MODEL] },
        providers: [
          gcpProvider({ fetch: emu.fetch, tokenSource: { token: async () => 'host-token' } }),
        ],
      }),
    ],
  } as any);
  await compute.initialize();
  await useSimClock(database, clock.now());
  api = compute.api;
  root = t.root.credential;
  R = t.root.tenantId;
  A = t.acme.tenantId;
  B = t.other.tenantId;

  const admin = await t.acme.member('admin');
  await t.acme.grant(admin.identityId, {
    version: 1,
    statements: [{ effect: 'allow', actions: ['compute:*'], resources: ['*'] }],
  });
  acmeAdmin = await t.acme.signIn('admin');

  // A member of the root tenant that holds only `compute:billing:read` on the fleet.
  const member = await t.iam.api.identities.create(root, {
    tenantId: R,
    email: 'biller@root.test',
    name: 'Biller',
    password: 'a strong root biller password',
  });
  const policy = await t.iam.api.policies.create(root, {
    tenantId: R,
    name: 'billing-read',
    document: {
      version: 1,
      statements: [
        { effect: 'allow', actions: ['compute:billing:read'], resources: ['compute-fleet/global'] },
      ],
    },
  });
  const role = await t.iam.api.roles.create(root, {
    tenantId: R,
    name: 'billing-read',
    policyIds: [policy.id],
  });
  await t.iam.api.bindings.create(root, {
    tenantId: R,
    roleId: role.id,
    subjectType: 'identity',
    subjectId: member.id,
  });
  const signedIn = await t.iam.api.auth.signIn({
    tenantId: R,
    email: 'biller@root.test',
    password: 'a strong root biller password',
  });
  if (!('token' in signedIn)) throw new Error('Unexpected MFA for a root member');
  reader = { token: signedIn.token };
}, 120_000);

afterAll(async () => {
  await compute?.stop();
  await t?.close();
  await database?.close();
});

describe('billing: meters and prices', () => {
  it('root lists meters and sees missing ones', async () => {
    const listed = await api.billing.meters(root, {});
    const keys = listed.catalog.map((meter: { key: string }) => meter.key);
    expect(listed.catalog).toEqual(meterCatalog({ gpuModels: [...defaultMeterGpuModels, MODEL] }));
    // The bridge syncs its own catalog at start; the extra model's VM meters are not in it.
    expect(listed.missing).toContain(`vm.gpu.${MODEL}.hours`);
    expect(listed.missing).toContain(`vm.reserved.gpu.${MODEL}.hours`);
    expect(listed.missing).not.toContain('gpu.h100.hours');
    for (const key of listed.missing) expect(keys).toContain(key);

    const synced = await api.billing.syncMeters(root, {});
    expect(synced.created).toEqual(listed.missing);
    expect(synced.existing.length + synced.created.length).toBe(keys.length);

    expect((await api.billing.meters(root, {})).missing).toEqual([]);
    // Idempotent: the second sync creates nothing.
    expect(await api.billing.syncMeters(root, {})).toMatchObject({ created: [] });
  });

  it('root sets a list price and a negotiated price for tenant A', async () => {
    const result = await api.billing.setPrices(root, {
      prices: [
        { meter: 'gpu.h100.hours', effectiveFrom: period, spec: perUnit(4_000_000) },
        {
          meter: 'gpu.h100.hours',
          targetTenantId: A,
          effectiveFrom: period,
          spec: perUnit(3_000_000),
        },
      ],
    });
    expect(result.failed).toEqual([]);
    expect(result.applied).toHaveLength(2);

    const all = await api.billing.prices(root, { meter: 'gpu.h100.hours' });
    expect(all).toHaveLength(2);
    const negotiated = await api.billing.prices(root, {
      meter: 'gpu.h100.hours',
      targetTenantId: A,
    });
    expect(negotiated).toEqual([
      {
        meter: 'gpu.h100.hours',
        targetTenantId: A,
        effectiveFrom: period,
        spec: perUnit(3_000_000),
      },
    ]);
    const list = (await api.billing.prices(root, { meter: 'gpu.h100.hours' })).find(
      (price: { targetTenantId?: string }) => price.targetTenantId === R,
    );
    expect(list).toMatchObject({ spec: perUnit(4_000_000) });
    // Without a meter, every rate-card meter's prices.
    expect((await api.billing.prices(root, {})).length).toBeGreaterThanOrEqual(2);
  });

  it('setPrices answers the prices it applied and the ones better-iam refused', async () => {
    const result = await api.billing.setPrices(root, {
      prices: [
        { meter: 'gpu.h200.hours', effectiveFrom: period, spec: perUnit(5_000_000) },
        {
          meter: 'gpu.h200.hours',
          targetTenantId: 'ten_does_not_exist',
          effectiveFrom: period,
          spec: perUnit(1_000_000),
        },
        {
          meter: 'gpu.b200.hours',
          targetTenantId: B,
          effectiveFrom: period,
          spec: perUnit(7_000_000),
        },
      ],
    });
    expect(result.applied.map((price: { meter: string }) => price.meter)).toEqual([
      'gpu.h200.hours',
      'gpu.b200.hours',
    ]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({
      index: 1,
      meter: 'gpu.h200.hours',
      targetTenantId: 'ten_does_not_exist',
    });
    expect(typeof result.failed[0].code).toBe('string');
    expect(typeof result.failed[0].message).toBe('string');
  });

  it('setPrices refuses an unknown meter and applies nothing', async () => {
    const before = (await api.billing.prices(root, { meter: 'gpu.l4.hours' })).length;
    expect(
      await outcome(
        api.billing.setPrices(root, {
          prices: [
            { meter: 'gpu.l4.hours', effectiveFrom: period, spec: perUnit(1_000_000) },
            { meter: 'not.in.the.catalog', effectiveFrom: period, spec: perUnit(1_000_000) },
          ],
        }),
      ),
    ).toBe('INVALID_INPUT');
    expect((await api.billing.prices(root, { meter: 'gpu.l4.hours' })).length).toBe(before);
  });

  it('setPrices takes at most 100 prices and well-formed ones', async () => {
    const price = { meter: 'gpu.l4.hours', effectiveFrom: period, spec: perUnit(1_000_000) };
    expect(
      await outcome(
        api.billing.setPrices(root, { prices: Array.from({ length: 101 }, () => price) }),
      ),
    ).toBe('INVALID_INPUT');
    expect(await outcome(api.billing.setPrices(root, { prices: [] }))).toBe('INVALID_INPUT');
    expect(
      await outcome(
        api.billing.setPrices(root, { prices: [{ ...price, effectiveFrom: '2026-13' }] }),
      ),
    ).toBe('INVALID_INPUT');
    expect(
      await outcome(
        api.billing.setPrices(root, { prices: [{ ...price, spec: { model: 'flat' } }] }),
      ),
    ).toBe('INVALID_INPUT');
    expect(
      await outcome(api.billing.setPrices(root, { prices: [{ ...price, spec: perUnit(-1) }] })),
    ).toBe('INVALID_INPUT');
    expect(
      await outcome(api.billing.setPrices(root, { prices: [{ ...price, extra: true }] })),
    ).toBe('INVALID_INPUT');
    expect(await outcome(api.billing.prices(root, { meter: 'Not A Meter' }))).toBe('INVALID_INPUT');
  });

  it('a tenant admin is denied on every billing method', async () => {
    const price = { meter: 'gpu.h100.hours', effectiveFrom: period, spec: perUnit(1) };
    for (const credential of [acmeAdmin]) {
      expect(await outcome(api.billing.meters(credential, {}))).toBe('ACCESS_DENIED');
      expect(await outcome(api.billing.syncMeters(credential, {}))).toBe('ACCESS_DENIED');
      expect(await outcome(api.billing.prices(credential, {}))).toBe('ACCESS_DENIED');
      expect(await outcome(api.billing.setPrices(credential, { prices: [price] }))).toBe(
        'ACCESS_DENIED',
      );
    }
    // Nothing leaked through: the list price root set earlier is unchanged.
    const list = (await api.billing.prices(root, { meter: 'gpu.h100.hours' })).find(
      (entry: { targetTenantId?: string }) => entry.targetTenantId === R,
    );
    expect(list.spec).toEqual(perUnit(4_000_000));
  });

  it('a root member holds only the billing actions its policy grants', async () => {
    expect(await outcome(api.billing.meters(reader, {}))).toBe('allowed');
    expect(await outcome(api.billing.prices(reader, {}))).toBe('allowed');
    expect(await outcome(api.billing.syncMeters(reader, {}))).toBe('ACCESS_DENIED');
    expect(
      await outcome(
        api.billing.setPrices(reader, {
          prices: [{ meter: 'gpu.h100.hours', effectiveFrom: period, spec: perUnit(1) }],
        }),
      ),
    ).toBe('ACCESS_DENIED');
  });

  it('UNSUPPORTED without the port member, naming the fix', async () => {
    hidden = true;
    try {
      const calls = {
        meters: () => api.billing.meters(root, {}),
        syncMeters: () => api.billing.syncMeters(root, {}),
        prices: () => api.billing.prices(root, {}),
        setPrices: () =>
          api.billing.setPrices(root, {
            prices: [{ meter: 'gpu.h100.hours', effectiveFrom: period, spec: perUnit(1) }],
          }),
      };
      for (const [name, call] of Object.entries(calls)) {
        const error = await failure(call());
        expect(error.code, name).toBe('UNSUPPORTED');
        expect(error.message, name).toContain('serviceCredential');
        expect(error.message, name).toContain('iam:billing:manage');
      }
    } finally {
      hidden = false;
    }
  });
});

// --- Price proposals and tenant estimates (platform compute billing, D14, D15) -----------------------------
// Proposals: provider list prices (here Compute Engine's catalog through the emulator) plus a margin, as prices root
// can publish with `setPrices`; they apply nothing. Estimates: the flavor's hourly price for the caller's tenant,
// priced by the real better-iam `quote` (so a negotiated price shows) on `meterLinesFor` of the flavor's shape.

describe('proposals', () => {
  const ZONE = 'us-central1-a';
  const REGION = 'us-central1';
  const ID_NONE = `pacct_${'0'.repeat(26)}`;

  interface Sku {
    id: string;
    description: string;
    group: string;
    nanos: number;
    units?: string;
    usageUnit?: string;
    usageType?: string;
    regions?: string[];
    currency?: string;
  }
  const sku = (input: Sku) => ({
    skuId: input.id,
    description: input.description,
    category: {
      resourceGroup: input.group,
      usageType: input.usageType ?? 'OnDemand',
    },
    serviceRegions: input.regions ?? [REGION],
    pricingInfo: [
      {
        pricingExpression: {
          usageUnit: input.usageUnit ?? 'h',
          tieredRates: [
            {
              startUsageAmount: 0,
              unitPrice: {
                currencyCode: input.currency ?? 'USD',
                units: input.units ?? '0',
                nanos: input.nanos,
              },
            },
          ],
        },
      },
    ],
  });
  const cpu = (id: string, family: string, nanos: number, extra: Partial<Sku> = {}) =>
    sku({
      id,
      description: `${family} Instance Core running in Americas`,
      group: 'CPU',
      nanos,
      ...extra,
    });
  const ram = (id: string, family: string, nanos: number, extra: Partial<Sku> = {}) =>
    sku({
      id,
      description: `${family} Instance Ram running in Americas`,
      group: 'RAM',
      nanos,
      usageUnit: 'GiBy.h',
      ...extra,
    });

  let accountId: string;
  let poolId: string;
  let gpuPoolId: string;
  const N2_METER = 'flavor.n2-standard-4.us-central1.hours';
  const A3_METER = 'flavor.a3-highgpu-8g.us-central1.hours';
  const WEIRD_METER = 'flavor.weird.hours';
  const GB_METER = 'flavor.a4-highgpu-4g.us-central1.hours';
  const OLD_METER = 'flavor.n2-standard-8.us-central1.hours';

  const propose = (extra: Record<string, unknown> = {}, who: Credential = root) =>
    api.billing.proposePrices(who, {
      accountId,
      marginPct: 20,
      region: REGION,
      effectiveFrom: period,
      ...extra,
    });
  const byMeter = (result: { proposals: { meter: string }[] }): Record<string, any> =>
    Object.fromEntries(result.proposals.map((proposal) => [proposal.meter, proposal]));

  beforeAll(async () => {
    emu.skus = [
      cpu('cpu-e2', 'E2', 21_811_000),
      ram('ram-e2', 'E2', 2_923_000),
      cpu('cpu-n2', 'N2', 31_611_000),
      ram('ram-n2', 'N2', 4_237_000),
      cpu('cpu-a3', 'A3', 33_000_000),
      ram('ram-a3', 'A3', 4_400_000),
      // The cheapest family overall, but in another region.
      cpu('cpu-e2-asia', 'E2', 19_000_000, { regions: ['asia-east1'] }),
      ram('ram-e2-asia', 'E2', 2_500_000, { regions: ['asia-east1'] }),
      // Another currency is never mixed in.
      cpu('cpu-e2-eur', 'E2', 1_000_000, { currency: 'EUR' }),
      sku({
        id: 'gpu-h100',
        description: 'Nvidia H100 80GB GPU running in Americas',
        group: 'GPU',
        units: '6',
        nanos: 880_000_000,
      }),
      sku({
        id: 'gpu-h100-spot',
        description: 'Spot Preemptible Nvidia H100 80GB GPU running in Americas',
        group: 'GPU',
        usageType: 'Preemptible',
        units: '2',
        nanos: 250_000_000,
      }),
      sku({
        id: 'ip',
        description: 'External IP Charge on a Standard VM',
        group: 'IpAddress',
        nanos: 5_000_000,
      }),
      sku({
        id: 'ssd',
        description: 'SSD backed PD Capacity in Iowa',
        group: 'SSD',
        usageUnit: 'GiBy.mo',
        nanos: 170_000_000,
      }),
      cpu('cpu-n2-1y', 'N2', 10_000_000, { usageType: 'Commit1Yr' }),
      // A GPU this deployment's models do not name (see the gpuModels test), with its machine family.
      sku({
        id: 'gpu-gb200',
        description: 'Nvidia GB200 GPU running in Americas',
        group: 'GPU',
        units: '9',
        nanos: 0,
      }),
      cpu('cpu-a4', 'A4', 40_000_000),
      ram('ram-a4', 'A4', 5_000_000),
    ];
    const account = await api.providerAccounts.create(root, {
      tenantId: R,
      provider: 'gcp',
      name: 'gcp-prices',
      config: { projectId: 'p', zones: [ZONE] },
    });
    accountId = account.id;
    const site = await api.sites.create(root, {
      tenantId: R,
      kind: 'shared',
      region: REGION,
      idempotencyKey: 'prices-site',
    });
    const pool = await api.pools.create(root, {
      tenantId: R,
      siteId: site.id,
      class: 'provider',
      providerAccountId: accountId,
      idempotencyKey: 'prices-pool',
    });
    poolId = pool.id;
    const gpuPool = await api.pools.create(root, {
      tenantId: R,
      siteId: site.id,
      class: 'provider',
      gpuModel: 'H100',
      providerAccountId: accountId,
      idempotencyKey: 'prices-gpu-pool',
    });
    gpuPoolId = gpuPool.id;
    for (const id of [poolId, gpuPoolId])
      await api.pools.offer(root, {
        tenantId: R,
        poolId: id,
        toTenantId: A,
        quota: { vcpu: 500, memoryGiB: 4_000, diskGiB: 2_000, gpu: 16 },
      });
    const flavor = (pool: string, name: string, shape: Record<string, unknown>) =>
      api.flavors.create(root, { tenantId: R, poolId: pool, name, diskGiB: 100, ...shape });
    await flavor(poolId, 'plain.4', { vcpu: 4, memoryGiB: 16, offerId: `${ZONE}/n2-standard-4` });
    await flavor(poolId, 'n2.metered', {
      vcpu: 4,
      memoryGiB: 16,
      offerId: `${ZONE}/n2-standard-4`,
      billing: { meter: N2_METER },
    });
    await flavor(poolId, 'weird.1', {
      vcpu: 2,
      memoryGiB: 8,
      offerId: `${ZONE}/zz9-standard-2`,
      billing: { meter: WEIRD_METER },
    });
    const gbPool = await api.pools.create(root, {
      tenantId: R,
      siteId: site.id,
      class: 'provider',
      gpuModel: 'GB200',
      providerAccountId: accountId,
      idempotencyKey: 'prices-gb200-pool',
    });
    await flavor(gbPool.id, 'a4.4g', {
      vcpu: 8,
      memoryGiB: 64,
      gpus: 4,
      offerId: `${ZONE}/a4-highgpu-4g`,
      billing: { meter: GB_METER },
    });
    await flavor(poolId, 'old.8', {
      vcpu: 8,
      memoryGiB: 32,
      offerId: `${ZONE}/n2-standard-8`,
      billing: { meter: OLD_METER },
    });
    await flavor(gpuPoolId, 'a3.8g', {
      vcpu: 208,
      memoryGiB: 1_872,
      gpus: 8,
      offerId: `${ZONE}/a3-highgpu-8g`,
      billing: { meter: A3_METER },
    });
  }, 60_000);

  it('proposals apply the margin to provider list prices', async () => {
    const result = await propose();
    const proposals = byMeter(result);
    // The region's cheapest general-purpose family (E2: 21,811 + 4 x 2,923 beats N2's), plus 20%.
    expect(proposals['vm.vcpu.hours']).toEqual({
      meter: 'vm.vcpu.hours',
      spec: perUnit(26_173),
      basis: [{ sku: 'cpu-e2', unitPriceMicros: 21_811 }],
    });
    expect(proposals['vm.memory.gib.hours']).toEqual({
      meter: 'vm.memory.gib.hours',
      spec: perUnit(3_508),
      basis: [{ sku: 'ram-e2', unitPriceMicros: 2_923 }],
    });
    // GPUs use the GPU SKU, on demand and Spot apart.
    expect(proposals['vm.gpu.h100.hours']).toEqual({
      meter: 'vm.gpu.h100.hours',
      spec: perUnit(8_256_000),
      basis: [{ sku: 'gpu-h100', unitPriceMicros: 6_880_000 }],
    });
    expect(proposals['vm.gpu.h100.spot.hours'].spec).toEqual(perUnit(2_700_000));
    // Ancillaries take the matching SKU (monthly storage as GiB-hours).
    expect(proposals['ip.public.hours'].spec).toEqual(perUnit(6_000));
    expect(proposals['disk.pd-ssd.gib.hours']).toEqual({
      meter: 'disk.pd-ssd.gib.hours',
      spec: perUnit(280),
      basis: [{ sku: 'ssd', unitPriceMicros: 233 }],
    });
    // Nothing a provider list cannot price, and nothing that is not a provider meter.
    for (const meter of [
      'vm.instance.hours',
      'vm.reserved.vcpu.hours',
      'vm.managed.hours',
      'vm.grant.slot.hours',
      'network.vpc.hours',
      'snapshot.gib.hours',
      'vm.gpu.a100.hours',
      'vm.gpu.other.hours',
      'disk.pd-standard.gib.hours',
      WEIRD_METER,
    ])
      expect(result.unpriced, meter).toContain(meter);
    expect(result.unpriced).not.toContain('vm.vcpu.hours');
    for (const meter of result.unpriced as string[])
      expect(meter).toMatch(/^(vm|disk|ip|network|snapshot|flavor)\./);
    expect(proposals['gpu.h100.hours']).toBeUndefined();
  });

  it('proposals compose a flavor meter from its family, and take the cheapest region without one', async () => {
    const proposals = byMeter(await propose());
    // 4 vCPU and 16 GiB at N2's SKUs, plus 20%.
    expect(proposals[N2_METER]).toEqual({
      meter: N2_METER,
      spec: perUnit(233_083),
      basis: [
        { sku: 'cpu-n2', unitPriceMicros: 31_611 },
        { sku: 'ram-n2', unitPriceMicros: 4_237 },
      ],
    });
    // 208 vCPU, 1,872 GiB and 8 H100s of the GPU pool at A3's SKUs, plus 20%.
    expect(proposals[A3_METER].spec).toEqual(perUnit(84_168_960));
    expect(proposals[A3_METER].basis.map((item: { sku: string }) => item.sku)).toEqual([
      'cpu-a3',
      'ram-a3',
      'gpu-h100',
    ]);

    // No region: the cheapest family of any region (E2 in asia-east1), the EUR price still ignored.
    const anywhere = byMeter(await propose({ region: undefined, marginPct: 0 }));
    expect(anywhere['vm.vcpu.hours']).toMatchObject({
      spec: perUnit(19_000),
      basis: [{ sku: 'cpu-e2-asia', unitPriceMicros: 19_000 }],
    });
    // The flavor meter is the offer's own region whatever the call names.
    expect(anywhere[N2_METER].spec).toEqual(perUnit(194_236));
  });

  it('proposals never set prices', async () => {
    const before = await api.billing.prices(root, {});
    const result = await propose({ marginPct: 35.5 });
    expect(result.proposals.length).toBeGreaterThan(5);
    expect(await api.billing.prices(root, {})).toEqual(before);
    // Publishing is root's separate step.
    const vcpu = byMeter(result)['ip.public.hours'];
    const applied = await api.billing.setPrices(root, {
      prices: [{ meter: vcpu.meter, effectiveFrom: period, spec: vcpu.spec }],
    });
    expect(applied.failed).toEqual([]);
    expect((await api.billing.prices(root, { meter: 'ip.public.hours' }))[0].spec).toEqual(
      vcpu.spec,
    );
  });

  it('proposals are root-only, validated, and read the platform’s accounts only', async () => {
    expect(await outcome(propose({}, acmeAdmin))).toBe('ACCESS_DENIED');
    expect(await outcome(propose({}, reader))).toBe('allowed');
    expect(await outcome(propose({ accountId: ID_NONE }))).toBe('NOT_FOUND');
    for (const bad of [
      { marginPct: -1 },
      { marginPct: 1001 },
      { marginPct: 'lots' },
      { effectiveFrom: '2026-13' },
      { region: 'Not A Region' },
      { accountId: 'acct_1' },
      { extra: true },
    ])
      expect(await outcome(propose(bad)), JSON.stringify(bad)).toBe('INVALID_INPUT');
    // No port member is needed: proposals read the provider and compute's own flavors.
    hidden = true;
    try {
      expect(await outcome(propose())).toBe('allowed');
    } finally {
      hidden = false;
    }
  });

  it('proposals name their currency, use the deployment gpuModels and skip archived flavors (F19-2)', async () => {
    expect((await propose()).currency).toBe('USD');
    // A GB200 pool: the provider lists a GB200 SKU, but this deployment's models (the default ones and zz9) name
    // no GB200, so the flavor's GPU is other here, exactly as metering names it, and it has no price.
    expect(canonicalGpuModel('GB200')).toBe('gb200');
    expect(canonicalGpuModel('GB200', [...defaultMeterGpuModels, MODEL])).toBe('other');
    const result = await propose();
    expect(byMeter(result)[GB_METER]).toBeUndefined();
    expect(result.unpriced).toContain(GB_METER);
    // Archived flavors are not proposed from.
    expect(byMeter(result)[OLD_METER]).toBeDefined();
    await database.query("UPDATE flavors SET archived = true WHERE name = 'old.8'");
    const after = await propose();
    expect(byMeter(after)[OLD_METER]).toBeUndefined();
    expect(after.unpriced).toContain(OLD_METER);
  });

  describe('estimates', () => {
    const flavorsOf = async (who: Credential, tenantId: string): Promise<Record<string, any>> => {
      const { items } = await api.flavors.list(who, { tenantId, poolId });
      return Object.fromEntries(items.map((item: { name: string }) => [item.name, item]));
    };

    beforeAll(async () => {
      // The list prices, and a negotiated vCPU price for tenant A.
      const result = await api.billing.setPrices(root, {
        prices: [
          { meter: 'vm.vcpu.hours', effectiveFrom: period, spec: perUnit(30_000) },
          {
            meter: 'vm.vcpu.hours',
            targetTenantId: A,
            effectiveFrom: period,
            spec: perUnit(20_000),
          },
          { meter: 'vm.memory.gib.hours', effectiveFrom: period, spec: perUnit(5_000) },
          { meter: 'vm.instance.hours', effectiveFrom: period, spec: perUnit(1_000) },
        ],
      });
      expect(result.failed).toEqual([]);
    });

    it('a tenant sees its negotiated estimate on flavors.list', async () => {
      const acme = await flavorsOf(acmeAdmin, A);
      // 4 vCPU at A's 20,000, 16 GiB at the list 5,000 and the instance line at 1,000.
      expect(acme['plain.4'].estimate).toEqual({
        perHourMicros: 161_000,
        currency: 'USD',
        lines: [
          { meter: 'vm.vcpu.hours', quantity: 4, amountMicros: 80_000 },
          { meter: 'vm.memory.gib.hours', quantity: 16, amountMicros: 80_000 },
          { meter: 'vm.instance.hours', quantity: 1, amountMicros: 1_000 },
        ],
      });
      // Root pays the list price on its own pool.
      const rootView = await flavorsOf(root, R);
      expect(rootView['plain.4'].estimate.perHourMicros).toBe(4 * 30_000 + 80_000 + 1_000);
      // A flavor billed on a whole-shape meter with no price: its line, and no total.
      expect(acme['n2.metered'].estimate).toEqual({
        perHourMicros: null,
        currency: 'USD',
        lines: [{ meter: N2_METER, quantity: 1, amountMicros: null }],
      });
    });

    it('instances.estimate prices a flavor for a principal that may only read flavors, and creates nothing', async () => {
      // Tenant A's viewer holds flavors:read and nothing else.
      const member = await t.acme.member('viewer');
      await t.acme.grant(member.identityId, {
        version: 1,
        statements: [{ effect: 'allow', actions: ['compute:flavors:read'], resources: ['*'] }],
      });
      const viewer = await t.acme.signIn('viewer');
      const scalar = async (text: string) =>
        Number((await database.query<{ n: string }>(text)).rows[0]!.n);
      const footprint = async () => ({
        instances: await scalar(`SELECT count(*) AS n FROM instances`),
        quota: await scalar(`SELECT coalesce(sum(used), 0) AS n FROM quota_usage`),
        projection: await scalar(`SELECT count(*) AS n FROM authz_projection`),
        changes: await scalar(`SELECT count(*) AS n FROM authz_changes`),
        audit: await scalar(`SELECT count(*) AS n FROM audit_events`),
      });
      const input = { tenantId: A, poolId, flavor: 'plain.4' };
      const before = await footprint();
      const requests = emu.requests.length;

      const answer = await api.instances.estimate(viewer, input);
      expect(Object.keys(answer)).toEqual(['estimate']);
      expect(answer.estimate).toEqual({
        perHourMicros: 161_000,
        currency: 'USD',
        lines: [
          { meter: 'vm.vcpu.hours', quantity: 4, amountMicros: 80_000 },
          { meter: 'vm.memory.gib.hours', quantity: 16, amountMicros: 80_000 },
          { meter: 'vm.instance.hours', quantity: 1, amountMicros: 1_000 },
        ],
      });
      // The same figure flavors.list shows.
      expect((await flavorsOf(viewer, A))['plain.4'].estimate).toEqual(answer.estimate);
      // A member without flavors:read may not estimate; the flavor and the input are checked.
      expect(await outcome(api.instances.estimate(reader, input))).toBe('ACCESS_DENIED');
      expect(await outcome(api.instances.estimate(viewer, { ...input, flavor: 'nope.1' }))).toBe(
        'NOT_FOUND',
      );
      expect(await outcome(api.instances.estimate(viewer, { ...input, extra: 1 }))).toBe(
        'INVALID_INPUT',
      );
      // No instance, draft, quota charge, authz projection (or its change feed) or mutation audit row; no provider call.
      expect(await footprint()).toEqual(before);
      expect(emu.requests.length).toBe(requests);
      // The viewer may not create: refused, and still no instance, draft, quota charge or projection row left.
      expect(
        await outcome(
          api.instances.create(viewer, {
            ...input,
            imageId: 'debian-12',
            idempotencyKey: 'view-1',
          }),
        ),
      ).toBe('ACCESS_DENIED');
      expect(await footprint()).toMatchObject({
        instances: before.instances,
        quota: before.quota,
        projection: before.projection,
      });
    });

    it('instances.create no longer takes dryRun', async () => {
      expect(
        await outcome(
          api.instances.create(acmeAdmin, {
            tenantId: A,
            poolId,
            flavor: 'plain.4',
            imageId: 'debian-12',
            idempotencyKey: 'no-dry-run',
            dryRun: true,
          }),
        ),
      ).toBe('INVALID_INPUT');
    });

    it('no quote port → no estimate field', async () => {
      hidden = true;
      try {
        const acme = await flavorsOf(acmeAdmin, A);
        expect(Object.keys(acme).length).toBeGreaterThan(2);
        for (const flavor of Object.values(acme)) expect(flavor).not.toHaveProperty('estimate');
        expect(
          await api.instances.estimate(acmeAdmin, { tenantId: A, poolId, flavor: 'plain.4' }),
        ).toEqual({});
      } finally {
        hidden = false;
      }
    });

    it('estimates are cached five minutes per tenant and pool', async () => {
      const asked = quoted;
      await flavorsOf(acmeAdmin, A);
      expect(quoted).toBe(asked);
      // A new negotiated price shows only after the cache expires.
      await api.billing.setPrices(root, {
        prices: [
          {
            meter: 'vm.vcpu.hours',
            targetTenantId: A,
            effectiveFrom: period,
            spec: perUnit(10_000),
          },
        ],
      });
      expect((await flavorsOf(acmeAdmin, A))['plain.4'].estimate.perHourMicros).toBe(161_000);
      expect(quoted).toBe(asked);
      clock.set(clock.now() + 5 * 60_000 + 1_000);
      expect((await flavorsOf(acmeAdmin, A))['plain.4'].estimate.perHourMicros).toBe(121_000);
      expect(quoted).toBeGreaterThan(asked);
    });
  });
});
