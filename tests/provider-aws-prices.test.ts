import { describe, expect, it } from 'vitest';
import {
  isComputeError,
  type CallContext,
  type Logger,
  type MeterSpec,
  type ProviderListPrice,
} from '@better-compute/core';
import {
  awsConfig,
  awsProvider,
  memoryWeightPerGib,
  type AwsConfig,
} from '@better-compute/provider-aws';
import { offerPlacement, proposePrices } from '../packages/vps/src/proposals.js';
import { AwsEmulator } from './support/aws-emulator/index.js';
import { instanceProduct, PricingEmulator } from './support/aws-emulator/pricing.js';

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const DAY = 86_400_000;

async function world(region = 'us-east-1') {
  const emu = new AwsEmulator();
  const pricing = new PricingEmulator(emu);
  const provider = awsProvider({ fetch: emu.fetch, credentials: emu.ambient });
  const config = awsConfig.parse({ region, zones: [`${region}a`] }) as AwsConfig;
  const impl = await provider.create(config, {
    clock: emu.clock,
    log: quiet,
    secrets: { resolve: async () => '' },
    account: { id: 'pa_platform', tenantId: 'root', platform: true },
  });
  const call = (signal = new AbortController().signal): CallContext => ({
    idempotencyKey: 'prices',
    signal,
    clock: emu.clock,
    secrets: { resolve: async () => '' },
    log: quiet,
  });
  return { emu, pricing, impl, call };
}

function catalog(pricing: PricingEmulator) {
  pricing.products.push(
    instanceProduct('M7I-L', 'm7i.large', { vcpu: 2, memoryGiB: 8 }, '0.1008000000'),
    instanceProduct('M7I-XL', 'm7i.xlarge', { vcpu: 4, memoryGiB: 16 }, '0.2016000000'),
    instanceProduct('M7A-L', 'm7a.large', { vcpu: 2, memoryGiB: 8 }, '0.1159200000'),
    instanceProduct('C7I-L', 'c7i.large', { vcpu: 2, memoryGiB: 4 }, '0.0893000000'),
    instanceProduct('P5', 'p5.48xlarge', { vcpu: 192, memoryGiB: 2048, gpu: 8 }, '98.3200000000'),
    // a T4 is no GPU the meter catalog names: its family is not priced at all
    instanceProduct('G4DN', 'g4dn.xlarge', { vcpu: 4, memoryGiB: 16, gpu: 1 }, '0.5260000000'),
    // Windows and another region never match the account's query
    instanceProduct('M7I-WIN', 'm7i.large', { vcpu: 2, memoryGiB: 8 }, '0.1928', 'us-east-1', {
      operatingSystem: 'Windows',
    }),
    instanceProduct('M7I-EU', 'm7i.large', { vcpu: 2, memoryGiB: 8 }, '0.1092', 'eu-west-1'),
    {
      sku: 'GP3',
      productFamily: 'Storage',
      attributes: {
        regionCode: 'us-east-1',
        volumeApiName: 'gp3',
        usagetype: 'EBS:VolumeUsage.gp3',
      },
      price: '0.0800000000',
      unit: 'GB-Mo',
    },
    {
      sku: 'IP-INUSE',
      productFamily: 'IP Address',
      attributes: { regionCode: 'us-east-1', usagetype: 'USE1-PublicIPv4:InUseAddress' },
      price: '0.0050000000',
      unit: 'Hrs',
    },
    {
      sku: 'IP-IDLE',
      productFamily: 'IP Address',
      attributes: { regionCode: 'us-east-1', usagetype: 'USE1-PublicIPv4:IdleAddress' },
      price: '0.0050000000',
      unit: 'Hrs',
    },
  );
}

const find = (prices: ProviderListPrice[], match: Partial<ProviderListPrice>) =>
  prices.filter((price) =>
    Object.entries(match).every(([key, value]) => price[key as keyof ProviderListPrice] === value),
  );

describe('provider-aws list prices (Price List Query API)', () => {
  it("splits each family's instance price into vCPU and GiB prices, exact for its shapes", async () => {
    const { pricing, impl, call } = await world();
    catalog(pricing);
    const prices = await impl.listPrices!({}, call());
    const [vcpu] = find(prices, { resource: 'vcpu', machineFamily: 'm7i' });
    const [memory] = find(prices, { resource: 'memory', machineFamily: 'm7i' });
    expect(vcpu).toMatchObject({
      region: 'us-east-1',
      spot: false,
      unit: 'hour',
      currency: 'USD',
      sku: 'M7I-L',
    });
    expect(memory).toMatchObject({ unit: 'gib-hour', sku: 'M7I-L' });
    // Exact for m7i.large and m7i.xlarge; a GiB weighs memoryWeightPerGib of a vCPU.
    expect(2 * vcpu!.unitPriceMicros + 8 * memory!.unitPriceMicros).toBe(100_800);
    expect(4 * vcpu!.unitPriceMicros + 16 * memory!.unitPriceMicros).toBe(201_600);
    expect(memory!.unitPriceMicros / vcpu!.unitPriceMicros).toBeCloseTo(memoryWeightPerGib, 3);
    const [c7iVcpu] = find(prices, { resource: 'vcpu', machineFamily: 'c7i' });
    const [c7iMemory] = find(prices, { resource: 'memory', machineFamily: 'c7i' });
    expect(2 * c7iVcpu!.unitPriceMicros + 4 * c7iMemory!.unitPriceMicros).toBe(89_300);
    // one vCPU and one memory row per family and region; Windows and eu-west-1 are not read
    expect(find(prices, { resource: 'vcpu', machineFamily: 'm7i' })).toHaveLength(1);
    expect(prices.every((price) => price.region === 'us-east-1')).toBe(true);
    expect(find(prices, { machineFamily: 'g4dn' })).toEqual([]);
    expect(prices.every((price) => Number.isSafeInteger(price.unitPriceMicros))).toBe(true);
  });

  it("prices a GPU type's GPUs above the region's general-purpose vCPU and GiB rate", async () => {
    const { pricing, impl, call } = await world();
    catalog(pricing);
    const prices = await impl.listPrices!({}, call());
    const [gpu] = find(prices, { resource: 'gpu', gpuModel: 'h100' });
    const [vcpu] = find(prices, { resource: 'vcpu', machineFamily: 'p5' });
    const [memory] = find(prices, { resource: 'memory', machineFamily: 'p5' });
    const [m7iVcpu] = find(prices, { resource: 'vcpu', machineFamily: 'm7i' });
    // m7i is the cheapest general-purpose family (m7a costs more): its rates stand for p5's vCPUs and memory
    expect(vcpu!.unitPriceMicros).toBe(m7iVcpu!.unitPriceMicros);
    expect(gpu).toMatchObject({ unit: 'hour', sku: 'P5', spot: false });
    expect(
      192 * vcpu!.unitPriceMicros + 2048 * memory!.unitPriceMicros + 8 * gpu!.unitPriceMicros,
    ).toBe(98_320_000);
  });

  it('EBS volumes per GiB-hour (730 hours a month) and an in-use public IPv4 address', async () => {
    const { pricing, impl, call } = await world();
    catalog(pricing);
    const prices = await impl.listPrices!({}, call());
    expect(find(prices, { resource: 'disk' })).toEqual([
      expect.objectContaining({
        diskType: 'gp3',
        unitPriceMicros: 110,
        unit: 'gib-hour',
        sku: 'GP3',
      }),
    ]);
    expect(find(prices, { resource: 'ip' })).toEqual([
      expect.objectContaining({ unitPriceMicros: 5_000, unit: 'hour', sku: 'IP-INUSE' }),
    ]);
  });

  it('reads a region once a day, the account region by default, and only valid regions', async () => {
    const { emu, pricing, impl, call } = await world();
    catalog(pricing);
    await impl.listPrices!({}, call());
    const reads = pricing.queries.length;
    expect(reads).toBe(3);
    for (const query of pricing.queries) {
      expect(query).toMatchObject({
        ServiceCode: 'AmazonEC2',
        FormatVersion: 'aws_v1',
        MaxResults: 100,
      });
      expect(query.Filters).toContainEqual({
        Type: 'TERM_MATCH',
        Field: 'regionCode',
        Value: 'us-east-1',
      });
    }
    await impl.listPrices!({ regions: ['us-east-1'] }, call());
    expect(pricing.queries.length).toBe(reads);
    const eu = await impl.listPrices!({ regions: ['eu-west-1'] }, call());
    expect(eu.map((price) => price.region)).toEqual(['eu-west-1', 'eu-west-1']);
    emu.clock.advance(DAY);
    await impl.listPrices!({}, call());
    expect(pricing.queries.length).toBe(2 * reads + 3);
    const bad = await impl.listPrices!({ regions: ['mars-1'] }, call()).catch((error) => error);
    expect(isComputeError(bad, 'INVALID_INPUT')).toBe(true);
    const partition = await impl.listPrices!({ regions: ['cn-north-1'] }, call()).catch(
      (error) => error,
    );
    expect(isComputeError(partition, 'INVALID_INPUT')).toBe(true);
  });

  it('pages through NextToken; an unreadable price list is UNAVAILABLE and not kept', async () => {
    const { pricing, impl, call } = await world();
    catalog(pricing);
    pricing.pageSize = 2;
    pricing.rawNext = '{"PriceList":["{not json"]}';
    const failed = await impl.listPrices!({}, call()).catch((error) => error);
    expect(isComputeError(failed, 'UNAVAILABLE')).toBe(true);
    const prices = await impl.listPrices!({}, call());
    expect(find(prices, { resource: 'vcpu' }).length).toBe(4);
    expect(pricing.queries.some((query) => query.NextToken !== undefined)).toBe(true);
  });

  it('is absent outside the commercial partition', async () => {
    const { impl } = await world('us-gov-west-1');
    expect(impl.listPrices).toBeUndefined();
  });
});

describe('vps proposals from AWS list prices', () => {
  const meter = (key: string): MeterSpec => ({ key }) as unknown as MeterSpec;

  it('AWS offer ids name their region and family', () => {
    expect(offerPlacement('us-east-1a/m7i.large')).toEqual({ region: 'us-east-1', family: 'm7i' });
    expect(offerPlacement('us-west-2-lax-1a/c7i.xlarge')).toEqual({
      region: 'us-west-2',
      family: 'c7i',
    });
    // a Spot offer is not priced from on-demand list prices
    expect(offerPlacement('us-east-1a/c7i.xlarge:spot')).toBeUndefined();
    expect(offerPlacement('eu-west-1b/m7i-flex.large@cr-0123456789abcdef0')).toEqual({
      region: 'eu-west-1',
      family: 'm7i-flex',
    });
    expect(offerPlacement('us-central1-a/n2-standard-4')).toEqual({
      region: 'us-central1',
      family: 'n2',
    });
  });

  it('prices the base meters from a general-purpose family and an AWS flavor exactly', async () => {
    const { pricing, impl, call } = await world();
    catalog(pricing);
    const prices = await impl.listPrices!({}, call());
    const result = proposePrices({
      catalog: [
        meter('vm.vcpu.hours'),
        meter('vm.memory.gib.hours'),
        meter('flavor.m7i.large.hours'),
      ],
      prices,
      flavors: [
        {
          meter: 'flavor.m7i.large.hours',
          vcpu: 2,
          memoryGiB: 8,
          gpus: 0,
          offerId: 'us-east-1a/m7i.large',
        },
      ],
      marginPct: 0,
      region: 'us-east-1',
      currency: 'USD',
    });
    expect(result.unpriced).toEqual([]);
    const byMeter = Object.fromEntries(
      result.proposals.map((proposal) => [proposal.meter, proposal]),
    );
    expect(byMeter['vm.vcpu.hours']!.basis).toEqual([
      { sku: 'M7I-L', unitPriceMicros: expect.any(Number) },
    ]);
    expect(byMeter['flavor.m7i.large.hours']!.spec).toEqual({
      model: 'per-unit',
      unitAmountMicros: 100_800,
    });
  });
});
