import { describe, expect, it } from 'vitest';
import { meterCatalog, type ProviderListPrice } from '@better-compute/core';
import { proposePrices } from '../packages/vps/src/proposals.js';

// Price proposals from whole-instance list prices (DigitalOcean P9, D-ops-1): a provider that prices a machine
// shape as one (a Droplet size) lists `resource: 'instance'` prices naming the offer; a flavor meter whose flavors
// all use that offer is proposed at the instance price plus the margin. Nothing else is derived from them.

const S2 = 'flavor.s-2vcpu-4gb.nyc3.hours';
const GPU = 'flavor.gpu-h100x1.nyc3.hours';
const MIXED = 'flavor.mixed.hours';
const catalog = meterCatalog({ gpuModels: ['h100'], flavorMeters: [S2, GPU, MIXED] });

const instance = (
  offerId: string,
  unitPriceMicros: number,
  extra: Partial<ProviderListPrice> = {},
): ProviderListPrice => ({
  resource: 'instance',
  region: offerId.split('/')[0]!,
  offerId,
  spot: false,
  unitPriceMicros,
  unit: 'hour',
  currency: 'USD',
  sku: offerId.split('/')[1]!,
  ...extra,
});

const prices: ProviderListPrice[] = [
  instance('nyc3/s-2vcpu-4gb', 35_714),
  instance('sfo3/s-2vcpu-4gb', 30_000),
  instance('nyc3/gpu-h100x1-80gb', 3_390_000),
  instance('nyc3/gpu-h100x1-80gb', 1_000_000, { spot: true, sku: 'gpu-h100x1-80gb-spot' }),
  instance('nyc3/s-1vcpu-1gb', 7_440, { currency: 'EUR' }),
];

const flavors = [
  { meter: S2, vcpu: 2, memoryGiB: 4, gpus: 0, offerId: 'nyc3/s-2vcpu-4gb' },
  {
    meter: GPU,
    vcpu: 20,
    memoryGiB: 240,
    gpus: 1,
    gpuModel: 'h100',
    offerId: 'nyc3/gpu-h100x1-80gb',
  },
  { meter: MIXED, vcpu: 2, memoryGiB: 4, gpus: 0, offerId: 'nyc3/s-2vcpu-4gb' },
  { meter: MIXED, vcpu: 2, memoryGiB: 4, gpus: 0, offerId: 'sfo3/s-2vcpu-4gb' },
];

describe('proposals from instance prices', () => {
  const result = proposePrices({ catalog, prices, flavors, marginPct: 20, currency: 'USD' });
  const byMeter = Object.fromEntries(result.proposals.map((p) => [p.meter, p]));

  it('prices a flavor meter at its offer’s on-demand instance price plus the margin', () => {
    expect(byMeter[S2]).toEqual({
      meter: S2,
      spec: { model: 'per-unit', unitAmountMicros: 42_857 },
      basis: [{ sku: 's-2vcpu-4gb', unitPriceMicros: 35_714 }],
    });
    // The whole GPU Droplet is one price: no GPU SKU is added on top of it.
    expect(byMeter[GPU]).toEqual({
      meter: GPU,
      spec: { model: 'per-unit', unitAmountMicros: 4_068_000 },
      basis: [{ sku: 'gpu-h100x1-80gb', unitPriceMicros: 3_390_000 }],
    });
  });

  it('leaves unpriced a flavor meter whose flavors disagree on the offer', () => {
    expect(byMeter[MIXED]).toBeUndefined();
    expect(result.unpriced).toContain(MIXED);
  });

  it('derives no vCPU, memory or GPU price from instance prices', () => {
    expect(result.unpriced).toEqual(
      expect.arrayContaining(['vm.vcpu.hours', 'vm.memory.gib.hours', 'vm.gpu.h100.hours']),
    );
  });

  it('never uses an instance price in another currency, or of another region when one is asked', () => {
    const eur = proposePrices({
      catalog,
      prices,
      flavors: [{ meter: S2, vcpu: 1, memoryGiB: 1, gpus: 0, offerId: 'nyc3/s-1vcpu-1gb' }],
      marginPct: 0,
      currency: 'USD',
    });
    expect(eur.unpriced).toContain(S2);
    const sfo = proposePrices({
      catalog,
      prices,
      flavors,
      marginPct: 0,
      currency: 'USD',
      region: 'sfo3',
    });
    expect(sfo.unpriced).toContain(S2);
  });

  it('refuses an instance price that two listings disagree on (one meter, one price)', () => {
    const twice = proposePrices({
      catalog,
      prices: [...prices, instance('nyc3/s-2vcpu-4gb', 40_000, { sku: 'other' })],
      flavors,
      marginPct: 0,
      currency: 'USD',
    });
    expect(twice.unpriced).toContain(S2);
  });
});
