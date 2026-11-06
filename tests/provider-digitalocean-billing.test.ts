import { beforeEach, describe, expect, it } from 'vitest';
import { manualClock } from '@better-compute/core';
import { pricesOfSizes, type DoSize } from '@better-compute/provider-digitalocean';
import { DoEmulator } from './support/do-emulator/index.js';
import { build, ctx, freshBudgets } from './support/do-harness.js';

// DigitalOcean P9 billing: list prices (whole Droplet sizes, D-ops-1).

beforeEach(freshBudgets);

describe('listPrices', () => {
  it('lists one on-demand instance price per size and configured region, in micros per hour', async () => {
    const emu = new DoEmulator();
    const compute = await build(emu, { token: 'secret://do/t', regions: ['nyc3', 'tor1'] });
    const prices = await compute.listPrices({}, ctx());
    const s1 = prices.filter((price) => price.sku === 's-1vcpu-1gb');
    expect(s1).toEqual([
      {
        resource: 'instance',
        region: 'nyc3',
        offerId: 'nyc3/s-1vcpu-1gb',
        spot: false,
        unitPriceMicros: 7_440,
        unit: 'hour',
        currency: 'USD',
        sku: 's-1vcpu-1gb',
      },
      expect.objectContaining({ region: 'tor1', offerId: 'tor1/s-1vcpu-1gb' }),
    ]);
    // Only the account's regions: atl1 sizes are not listed; the 8-GPU size is one price, not per GPU.
    expect(prices.some((price) => price.region === 'atl1')).toBe(false);
    expect(prices.find((price) => price.sku === 'gpu-h100x8-640gb')).toMatchObject({
      region: 'tor1',
      unitPriceMicros: 23_920_000,
    });
    // No vCPU, memory or GPU parts are derived from a size price.
    expect(new Set(prices.map((price) => price.resource))).toEqual(new Set(['instance']));
  });

  it('narrows to the regions asked, and shares the offers catalog (one read for both)', async () => {
    const emu = new DoEmulator();
    const compute = await build(emu, { token: 'secret://do/t', regions: ['nyc3', 'tor1'] });
    await compute.listOffers({});
    const before = emu.requests.length;
    const prices = await compute.listPrices({ regions: ['tor1', 'sfo3'] }, ctx());
    expect(emu.requests.length).toBe(before);
    expect(new Set(prices.map((price) => price.region))).toEqual(new Set(['tor1']));
  });

  it('skips a size whose price is missing, zero or not a number (fail closed)', () => {
    const size = (slug: string, price: unknown): DoSize =>
      ({
        slug,
        memory: 1024,
        vcpus: 1,
        disk: 25,
        price_hourly: price,
        regions: ['nyc3'],
        available: true,
      }) as DoSize;
    const prices = pricesOfSizes(
      [size('a', 0), size('b', -1), size('c', 'x'), size('d', Number.NaN), size('e', 0.5)],
      ['nyc3'],
    );
    expect(prices.map((price) => price.sku)).toEqual(['e']);
    expect(prices[0]!.unitPriceMicros).toBe(500_000);
  });

  it('is UNAVAILABLE, not an empty list, when the sizes cannot be read', async () => {
    const emu = new DoEmulator();
    const compute = await build(emu, undefined, {}, { clock: manualClock(1_000_000) });
    emu.failNext({ method: 'GET', path: /^\/sizes$/ }, 503, {
      id: 'service_unavailable',
      message: 'x',
    });
    await expect(compute.listPrices({}, ctx())).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
});
