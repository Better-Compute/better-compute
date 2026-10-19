import { describe, expect, it } from 'vitest';
import { manualClock } from '@better-compute/core';
import { gcpProvider } from '@better-compute/provider-gcp';
import { GceEmulator, type Json } from './support/gce-emulator.js';
import { build, ctx, gcpAccount, platformAccount, secrets } from './support/gcp-harness.js';

// provider-gcp list prices (platform compute billing, D14): the Cloud Billing Catalog's Compute Engine SKUs
// (`services/6F81-5844-456A/skus`) as ProviderListPrice, read through the emulator's catalog section.

interface SkuInput {
  id: string;
  description: string;
  group: string;
  usageType?: string;
  regions?: string[];
  /** `{ units, nanos }` of the first tier. */
  price: { units: string; nanos: number };
  usageUnit?: string;
  currency?: string;
  family?: string;
  /** Replaces the tiers: the catalog does not promise an order. */
  tiers?: { start: number; units: string; nanos: number }[];
}

function sku(input: SkuInput): Json {
  return {
    name: `services/6F81-5844-456A/skus/${input.id}`,
    skuId: input.id,
    description: input.description,
    category: {
      serviceDisplayName: 'Compute Engine',
      resourceFamily: 'Compute',
      resourceGroup: input.group,
      usageType: input.usageType ?? 'OnDemand',
    },
    serviceRegions: input.regions ?? ['us-central1'],
    pricingInfo: [
      {
        pricingExpression: {
          usageUnit: input.usageUnit ?? 'h',
          tieredRates: input.tiers
            ? input.tiers.map((tier) => ({
                startUsageAmount: tier.start,
                unitPrice: {
                  currencyCode: input.currency ?? 'USD',
                  units: tier.units,
                  nanos: tier.nanos,
                },
              }))
            : [
                {
                  startUsageAmount: 0,
                  unitPrice: { currencyCode: input.currency ?? 'USD', ...input.price },
                },
                // A later tier the reader must not use.
                {
                  startUsageAmount: 1000,
                  unitPrice: { currencyCode: 'USD', units: '9', nanos: 0 },
                },
              ],
        },
      },
    ],
  };
}

const cpu = (id: string, family: string, nanos: number, extra: Partial<SkuInput> = {}) =>
  sku({
    id,
    description: `${family} Instance Core running in Americas`,
    group: 'CPU',
    price: { units: '0', nanos },
    ...extra,
  });
const ram = (id: string, family: string, nanos: number, extra: Partial<SkuInput> = {}) =>
  sku({
    id,
    description: `${family} Instance Ram running in Americas`,
    group: 'RAM',
    price: { units: '0', nanos },
    usageUnit: 'GiBy.h',
    ...extra,
  });

const standard = (): Json[] => [
  cpu('cpu-n2', 'N2', 31_611_000),
  ram('ram-n2', 'N2', 4_237_000),
  sku({
    id: 'gpu-h100',
    description: 'Nvidia H100 80GB GPU running in Americas',
    group: 'GPU',
    price: { units: '6', nanos: 880_000_000 },
  }),
];

async function pricesOf(emu: GceEmulator, regions?: string[]) {
  const impl = await build(emu);
  return impl.listPrices!(regions ? { regions } : {}, ctx());
}

describe('listPrices', () => {
  it('maps CPU, RAM and H100 GPU SKUs for us-central1', async () => {
    const emu = new GceEmulator();
    emu.skus = standard();
    const prices = await pricesOf(emu, ['us-central1']);
    expect(prices).toEqual([
      {
        resource: 'vcpu',
        region: 'us-central1',
        machineFamily: 'n2',
        spot: false,
        unitPriceMicros: 31_611,
        unit: 'hour',
        currency: 'USD',
        sku: 'cpu-n2',
      },
      {
        resource: 'memory',
        region: 'us-central1',
        machineFamily: 'n2',
        spot: false,
        unitPriceMicros: 4_237,
        unit: 'gib-hour',
        currency: 'USD',
        sku: 'ram-n2',
      },
      {
        resource: 'gpu',
        region: 'us-central1',
        gpuModel: 'h100',
        spot: false,
        unitPriceMicros: 6_880_000,
        unit: 'hour',
        currency: 'USD',
        sku: 'gpu-h100',
      },
    ]);
  });

  it('filters by region and emits a price per region of a multi-region SKU', async () => {
    const emu = new GceEmulator();
    emu.skus = [
      cpu('cpu-e2', 'E2', 21_811_000, { regions: ['us-central1', 'europe-west4'] }),
      cpu('cpu-e2-asia', 'E2', 25_000_000, { regions: ['asia-east1'] }),
    ];
    const some = await pricesOf(emu, ['europe-west4']);
    expect(some.map((price) => [price.sku, price.region])).toEqual([['cpu-e2', 'europe-west4']]);
    const all = await pricesOf(emu);
    expect(all.map((price) => [price.sku, price.region])).toEqual([
      ['cpu-e2', 'us-central1'],
      ['cpu-e2', 'europe-west4'],
      ['cpu-e2-asia', 'asia-east1'],
    ]);
  });

  it('maps disks and addresses, converting monthly storage to GiB-hours', async () => {
    const emu = new GceEmulator();
    emu.skus = [
      sku({
        id: 'ssd',
        description: 'SSD backed PD Capacity in Iowa',
        group: 'SSD',
        usageUnit: 'GiBy.mo',
        price: { units: '0', nanos: 170_000_000 },
      }),
      sku({
        id: 'std',
        description: 'Storage PD Capacity in Iowa',
        group: 'PDStandard',
        usageUnit: 'GiBy.mo',
        price: { units: '0', nanos: 40_000_000 },
      }),
      sku({
        id: 'bal',
        description: 'Balanced PD Capacity in Iowa',
        group: 'SSD',
        usageUnit: 'GiBy.mo',
        price: { units: '0', nanos: 100_000_000 },
      }),
      sku({
        id: 'regional',
        description: 'Regional SSD backed PD Capacity in Iowa',
        group: 'SSD',
        usageUnit: 'GiBy.mo',
        price: { units: '0', nanos: 340_000_000 },
      }),
      sku({
        id: 'ip',
        description: 'External IP Charge on a Standard VM',
        group: 'IpAddress',
        price: { units: '0', nanos: 5_000_000 },
      }),
      // Egress is billed by pass-through at its real cost: never listed (ruling F18-2).
      sku({
        id: 'egress',
        description: 'Network Internet Egress from Americas to Americas',
        group: 'PremiumInternetEgress',
        usageUnit: 'GiBy',
        regions: ['us-central1'],
        price: { units: '0', nanos: 120_000_000 },
      }),
      // Same resource group as the SSD PD, and not a pd-ssd (ruling F18-1e).
      sku({
        id: 'extreme',
        description: 'Extreme PD Capacity in Iowa',
        group: 'SSD',
        usageUnit: 'GiBy.mo',
        price: { units: '0', nanos: 125_000_000 },
      }),
    ];
    const byResource = Object.fromEntries((await pricesOf(emu)).map((price) => [price.sku, price]));
    expect(Object.keys(byResource).sort()).toEqual(['bal', 'extreme', 'ip', 'ssd', 'std']);
    expect(byResource.extreme).toMatchObject({ diskType: 'pd-extreme' });
    expect(Object.values(byResource).filter((price) => price.diskType === 'pd-ssd')).toHaveLength(
      1,
    );
    expect(byResource.ssd).toMatchObject({
      resource: 'disk',
      diskType: 'pd-ssd',
      unit: 'gib-hour',
      unitPriceMicros: Math.round(170_000 / 730),
    });
    expect(byResource.std).toMatchObject({ diskType: 'pd-standard', unitPriceMicros: 55 });
    expect(byResource.bal).toMatchObject({ diskType: 'pd-balanced' });
    expect(byResource.ip).toMatchObject({ resource: 'ip', unit: 'hour', unitPriceMicros: 5_000 });
  });

  it('spot SKUs are flagged', async () => {
    const emu = new GceEmulator();
    emu.skus = [
      cpu('cpu-od', 'N2', 31_611_000),
      sku({
        id: 'cpu-spot',
        description: 'Spot Preemptible N2 Instance Core running in Americas',
        group: 'CPU',
        usageType: 'Preemptible',
        price: { units: '0', nanos: 7_000_000 },
      }),
      sku({
        id: 'gpu-spot',
        description: 'Spot Preemptible Nvidia H100 80GB GPU running in Americas',
        group: 'GPU',
        usageType: 'Preemptible',
        price: { units: '2', nanos: 250_000_000 },
      }),
    ];
    const prices = await pricesOf(emu);
    expect(prices.map((price) => [price.sku, price.spot])).toEqual([
      ['cpu-od', false],
      ['cpu-spot', true],
      ['gpu-spot', true],
    ]);
    // The family is the instance family, not the "Spot Preemptible" prefix.
    expect(prices.find((price) => price.sku === 'cpu-spot')).toMatchObject({
      machineFamily: 'n2',
      unitPriceMicros: 7_000,
    });
    expect(prices.find((price) => price.sku === 'gpu-spot')).toMatchObject({ gpuModel: 'h100' });
  });

  it('commitment SKUs are skipped', async () => {
    const emu = new GceEmulator();
    emu.skus = [
      cpu('cpu-od', 'N2', 31_611_000),
      cpu('cpu-1y', 'N2', 19_000_000, { usageType: 'Commit1Yr' }),
      cpu('cpu-3y', 'N2', 14_000_000, { usageType: 'Commit3Yr' }),
      cpu('cpu-weird', 'N2', 1_000_000, { usageType: 'DWS' }),
    ];
    expect((await pricesOf(emu)).map((price) => price.sku)).toEqual(['cpu-od']);
  });

  it('skips what it cannot price: unknown GPUs, other units, other resource groups', async () => {
    const emu = new GceEmulator();
    emu.skus = [
      cpu('cpu-od', 'N2', 31_611_000),
      sku({
        id: 't4',
        description: 'Nvidia T4 GPU running in Americas',
        group: 'GPU',
        price: { units: '0', nanos: 350_000_000 },
      }),
      cpu('cpu-weekly', 'N2', 1_000_000, { usageUnit: 'wk' }),
      sku({
        id: 'lic',
        description: 'Licensing Fee for Windows',
        group: 'License',
        price: { units: '0', nanos: 4_000_000 },
      }),
      cpu('cpu-custom', 'N2', 40_000_000, {}),
    ];
    emu.skus[4]!.description = 'N2 Custom Instance Core running in Americas';
    expect((await pricesOf(emu)).map((price) => price.sku)).toEqual(['cpu-od']);
  });

  it('skips GPU variants: an H100 Mega is not an H100 (F18-1a)', async () => {
    const emu = new GceEmulator();
    emu.skus = [
      sku({
        id: 'h100',
        description: 'Nvidia H100 80GB GPU running in Americas',
        group: 'GPU',
        price: { units: '6', nanos: 880_000_000 },
      }),
      sku({
        id: 'h100-mega',
        description: 'Nvidia H100 80GB Mega GPU running in Americas',
        group: 'GPU',
        price: { units: '11', nanos: 0 },
      }),
      sku({
        id: 'l4-vws',
        description: 'Nvidia L4 Virtual Workstation GPU running in Americas',
        group: 'GPU',
        price: { units: '1', nanos: 0 },
      }),
    ];
    expect((await pricesOf(emu)).map((price) => price.sku)).toEqual(['h100']);
    // Alone, the variant leaves nothing (an H100 price that is not one is no price).
    emu.skus = [emu.skus[1]!];
    const alone = await build(emu);
    // An empty result is also not cached: the next call reads again.
    const reads = () =>
      emu.requests.filter((request) => request.url.hostname === 'cloudbilling.googleapis.com');
    expect(await alone.listPrices!({}, ctx())).toEqual([]);
    const first = reads().length;
    expect(await alone.listPrices!({}, ctx())).toEqual([]);
    expect(reads().length).toBeGreaterThan(first);
  });

  it('drops rows whose duplicates disagree on the price, keeps agreeing ones once (F18-1b)', async () => {
    const emu = new GceEmulator();
    emu.skus = [
      cpu('n2-a', 'N2', 31_611_000),
      cpu('n2-b', 'N2', 99_000_000),
      cpu('e2-a', 'E2', 21_811_000),
      cpu('e2-b', 'E2', 21_811_000),
      // Another region or another currency is another key.
      cpu('n2-eu', 'N2', 35_000_000, { regions: ['europe-west4'] }),
      cpu('n2-eur', 'N2', 99_000_000, { currency: 'EUR' }),
    ];
    const prices = await pricesOf(emu);
    expect(prices.map((price) => price.sku).sort()).toEqual(['e2-a', 'n2-eu', 'n2-eur']);
  });

  it('a machine family looks like one: compute, memory-optimized and micro are none (F18-1c)', async () => {
    const emu = new GceEmulator();
    emu.skus = [
      sku({
        id: 'a',
        description: 'Compute optimized Core running in Americas',
        group: 'CPU',
        price: { units: '0', nanos: 31_000_000 },
      }),
      sku({
        id: 'b',
        description: 'Memory-optimized Instance Core running in Americas',
        group: 'CPU',
        price: { units: '0', nanos: 31_000_000 },
      }),
      sku({
        id: 'c',
        description: 'Micro Instance with burstable CPU running in Americas',
        group: 'CPU',
        price: { units: '0', nanos: 5_000_000 },
      }),
      cpu('d', 'C3D', 30_000_000),
      cpu('e', 'N2', 31_611_000),
    ];
    const prices = await pricesOf(emu);
    expect(prices.map((price) => [price.sku, price.machineFamily])).toEqual([
      ['d', 'c3d'],
      ['e', 'n2'],
    ]);
  });

  it('reads the tier that starts at 0 whatever the order, and skips a free one (F18-1d)', async () => {
    const emu = new GceEmulator();
    emu.skus = [
      sku({
        id: 'unordered',
        description: 'N2 Instance Core running in Americas',
        group: 'CPU',
        price: { units: '0', nanos: 0 },
        tiers: [
          { start: 1000, units: '9', nanos: 0 },
          { start: 0, units: '0', nanos: 31_611_000 },
          { start: 500, units: '8', nanos: 0 },
        ],
      }),
      sku({
        id: 'free-first',
        description: 'E2 Instance Core running in Americas',
        group: 'CPU',
        price: { units: '0', nanos: 0 },
        tiers: [
          { start: 0, units: '0', nanos: 0 },
          { start: 100, units: '0', nanos: 21_811_000 },
        ],
      }),
      sku({
        id: 'no-zero-tier',
        description: 'N1 Instance Core running in Americas',
        group: 'CPU',
        price: { units: '0', nanos: 0 },
        tiers: [{ start: 100, units: '0', nanos: 24_000_000 }],
      }),
    ];
    const prices = await pricesOf(emu);
    expect(prices.map((price) => [price.sku, price.unitPriceMicros])).toEqual([
      ['unordered', 31_611],
    ]);
  });

  it('a 200 that is not a SKU list is UNAVAILABLE, never an empty catalog (F18-1f)', async () => {
    const emu = new GceEmulator();
    emu.skus = [cpu('c1', 'N2', 31_611_000)];
    const garbled = (body: string) => async (input: any, init?: RequestInit) => {
      const url = new URL(typeof input === 'object' && 'url' in input ? input.url : String(input));
      if (url.hostname === 'cloudbilling.googleapis.com')
        return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
      return emu.fetch(input, init);
    };
    for (const body of ['<html>maintenance</html>', '[1,2]', '{"skus":"none"}']) {
      const impl = await build(emu, undefined, { fetch: garbled(body) as typeof fetch });
      await expect(impl.listPrices!({}, ctx()), body).rejects.toMatchObject({
        code: 'UNAVAILABLE',
      });
    }
  });

  it('pages and caches', async () => {
    const emu = new GceEmulator();
    emu.skuPageSize = 2;
    emu.skus = [
      cpu('c1', 'N2', 31_611_000),
      ram('r1', 'N2', 4_237_000),
      cpu('c2', 'E2', 21_811_000),
      ram('r2', 'E2', 2_923_000),
      cpu('c3', 'N1', 24_000_000),
    ];
    const impl = await build(emu);
    const first = await impl.listPrices!({}, ctx());
    expect(first.map((price) => price.sku)).toEqual(['c1', 'r1', 'c2', 'r2', 'c3']);
    const catalogReads = () =>
      emu.requests.filter((request) => request.url.hostname === 'cloudbilling.googleapis.com');
    expect(catalogReads()).toHaveLength(3);
    expect(catalogReads()[0]!.url.searchParams.get('pageToken')).toBeNull();
    expect(catalogReads()[1]!.url.searchParams.get('pageToken')).toBeTruthy();
    // Served from the cache, whatever the regions asked.
    await impl.listPrices!({ regions: ['us-central1'] }, ctx());
    await impl.listPrices!({}, ctx());
    expect(catalogReads()).toHaveLength(3);
  });

  it('refreshes after 24 hours', async () => {
    const emu = new GceEmulator();
    emu.skus = [cpu('c1', 'N2', 31_611_000)];
    const clock = manualClock(1_000_000);
    const provider = gcpProvider({ fetch: emu.fetch });
    const parsed: any = await provider.config['~standard'].validate(gcpAccount);
    const impl = await provider.create(parsed.value, {
      clock,
      secrets,
      log: { debug() {}, info() {}, warn() {}, error() {} },
      account: platformAccount,
    });
    const call = () => ({ ...ctx(), clock });
    await impl.listPrices!({}, call());
    clock.advance(24 * 3_600_000 - 1);
    await impl.listPrices!({}, call());
    const reads = () =>
      emu.requests.filter((request) => request.url.hostname === 'cloudbilling.googleapis.com');
    expect(reads()).toHaveLength(1);
    clock.advance(2);
    emu.skus = [cpu('c1', 'N2', 40_000_000)];
    const refreshed = await impl.listPrices!({}, call());
    expect(reads()).toHaveLength(2);
    expect(refreshed[0]!.unitPriceMicros).toBe(40_000);
  });

  it('sends the account bearer token and maps a refusal', async () => {
    const emu = new GceEmulator();
    emu.skus = [cpu('c1', 'N2', 31_611_000)];
    const impl = await build(emu);
    await impl.listPrices!({}, ctx());
    const request = emu.requests.find((r) => r.url.hostname === 'cloudbilling.googleapis.com')!;
    expect(request.path).toContain('/v1/services/6F81-5844-456A/skus');
    expect(request.headers.get('authorization')).toMatch(/^Bearer ya29\./);

    const denied = new GceEmulator();
    denied.catalogFailure = { status: 403, reason: 'forbidden' };
    const refused = await build(denied);
    await expect(refused.listPrices!({}, ctx())).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  });
});
