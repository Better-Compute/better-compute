import { beforeEach, describe, expect, it } from 'vitest';
import { isComputeError, type ComputeError } from '@better-compute/core';
import {
  labels,
  spotPriceOf,
  spotShape,
  tagFor,
  type DoSize,
} from '@better-compute/provider-digitalocean';
import { DoEmulator } from './support/do-emulator/index.js';
import { build, ctx, doAccount, freshBudgets } from './support/do-harness.js';

// provider-digitalocean P3: Spot GPU offers and creates (DO-D14). The wire shape is unverified
// (spot.ts); these tests pin what the provider does with it.

const testKey =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICbbzkHhLXTIyRDUgXLAC0pVt8MQajr4BGKVoF5MJ71Z test@bc';
const t0 = Date.parse('2026-11-05T10:00:00Z');

async function failure(promise: Promise<unknown>): Promise<ComputeError> {
  try {
    await promise;
  } catch (error) {
    if (isComputeError(error)) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

/** An emulator whose H100 size reports a Spot price. */
function spotEmulator(price = 1.25): DoEmulator {
  const emu = new DoEmulator({ now: () => t0 });
  const h100 = emu.state.sizes.find((s) => s.slug === 'gpu-h100x1-80gb')!;
  h100[spotShape.sizePriceField] = price;
  return emu;
}

const spotRequest = (over: Record<string, unknown> = {}) => ({
  offerId: 'tor1/gpu-h100x1-80gb@spot',
  image: 'gpu-h100x1-base',
  userData: '#cloud-config\n',
  name: 'inst_1',
  sshKeys: [testKey],
  ...over,
});
// Spot is a DigitalOcean preview whose wire shape is unverified: it needs previews as well.
const spotAccount = { ...doAccount, regions: ['tor1'], allowSpot: true, previews: true };
const spotTag = tagFor(labels.capacity, 'spot');
const dropletPosts = (emu: DoEmulator) =>
  emu.requests.filter((r) => r.method === 'POST' && r.url.pathname === '/v2/droplets');

beforeEach(freshBudgets);

describe('spot offers', () => {
  it('reads the Spot price from the size, positive numbers only', () => {
    const size = (extra: Record<string, unknown>) => ({ slug: 'x', ...extra }) as unknown as DoSize;
    expect(spotPriceOf(size({ spot_price_hourly: 1.5 }))).toBe(1.5);
    for (const bad of [0, -1, '1.5', null, Number.NaN])
      expect(spotPriceOf(size({ spot_price_hourly: bad }))).toBeUndefined();
    expect(spotPriceOf(size({}))).toBeUndefined();
    expect(spotShape.verified).toBe(false);
  });

  it('a size with a Spot price gets a second, @spot offer only with allowSpot', async () => {
    const compute = await build(spotEmulator(1.25), spotAccount);
    const offers = await compute.listOffers({ gpuModel: 'H100', minGpus: 1 });
    const onDemand = offers.find((o) => o.id === 'tor1/gpu-h100x1-80gb')!;
    const spot = offers.find((o) => o.id === 'tor1/gpu-h100x1-80gb@spot')!;
    expect(spot).toEqual({ ...onDemand, id: 'tor1/gpu-h100x1-80gb@spot', pricePerHour: 1.25 });
    // Sizes without a Spot price have no Spot offer.
    expect(offers.filter((o) => o.id.endsWith('@spot'))).toHaveLength(1);

    freshBudgets();
    const off = await build(spotEmulator(), { ...spotAccount, allowSpot: false });
    expect((await off.listOffers({})).some((o) => o.id.endsWith('@spot'))).toBe(false);
  });

  it('while the wire shape is unverified, Spot offers need previews too', async () => {
    const compute = await build(spotEmulator(1.25), { ...spotAccount, previews: false });
    expect((await compute.listOffers({})).some((o) => o.id.endsWith('@spot'))).toBe(false);
  });

  it('a catalog with no Spot member yields no Spot offer even with allowSpot', async () => {
    const compute = await build(new DoEmulator({ now: () => t0 }), spotAccount);
    expect((await compute.listOffers({})).some((o) => o.id.endsWith('@spot'))).toBe(false);
  });
});

describe('spot creates', () => {
  it('a Spot create sends the Spot member and tags the Droplet; it reads back as @spot', async () => {
    const emu = spotEmulator();
    const compute = await build(emu, spotAccount);
    const machine = await compute.create(spotRequest(), ctx('k'));
    const body = dropletPosts(emu)[0]!.body as Record<string, unknown>;
    expect(body).toMatchObject({
      size: 'gpu-h100x1-80gb',
      region: 'tor1',
      ...spotShape.createBody,
    });
    expect(body.tags).toContain(spotTag);
    expect(machine.offerId).toBe('tor1/gpu-h100x1-80gb@spot');
    expect((await compute.get(machine.id, ctx('k')))!.offerId).toBe('tor1/gpu-h100x1-80gb@spot');
    // A retry finds the same Droplet.
    expect((await compute.create(spotRequest(), ctx('k'))).id).toBe(machine.id);
    expect(dropletPosts(emu)).toHaveLength(1);
  });

  it('an on-demand create sends no Spot member and reads back without @spot', async () => {
    const emu = spotEmulator();
    const compute = await build(emu, spotAccount);
    const machine = await compute.create(spotRequest({ offerId: 'tor1/gpu-h100x1-80gb' }), ctx());
    const body = dropletPosts(emu)[0]!.body as Record<string, unknown>;
    expect(body).not.toHaveProperty('capacity_type');
    expect(body.tags).not.toContain(spotTag);
    expect(machine.offerId).toBe('tor1/gpu-h100x1-80gb');
  });

  it('a tenant label cannot forge the Spot tag', async () => {
    const emu = spotEmulator();
    const compute = await build(emu, spotAccount);
    const machine = await compute.create(
      spotRequest({ offerId: 'tor1/gpu-h100x1-80gb', labels: { [labels.capacity]: 'spot' } }),
      ctx(),
    );
    expect((dropletPosts(emu)[0]!.body as { tags: string[] }).tags).not.toContain(spotTag);
    expect(machine.offerId).toBe('tor1/gpu-h100x1-80gb');
  });

  it('is refused without allowSpot, and for a size the catalog shows without Spot', async () => {
    const emu = spotEmulator();
    const off = await build(emu, { ...spotAccount, allowSpot: false });
    const refused = await failure(off.create(spotRequest(), ctx()));
    expect([refused.code, refused.details?.reason]).toEqual(['UNSUPPORTED', 'spot']);

    freshBudgets();
    const on = await build(emu, spotAccount);
    await on.listOffers({}); // caches the catalog
    const before = emu.requests.length;
    const noSpot = await failure(
      on.create(
        spotRequest({ offerId: 'tor1/gpu-l40sx1-48gb@spot', image: 'ubuntu-24-04-x64' }),
        ctx(),
      ),
    );
    expect([noSpot.code, noSpot.details?.reason]).toEqual(['INVALID_INPUT', 'spot']);
    expect(emu.requests).toHaveLength(before);
  });

  it('without a cached catalog, a Spot create loads it and refuses a size without a Spot price', async () => {
    const emu = spotEmulator();
    const compute = await build(emu, spotAccount);
    const refused = await failure(
      compute.create(
        spotRequest({ offerId: 'tor1/gpu-l40sx1-48gb@spot', image: 'ubuntu-24-04-x64' }),
        ctx(),
      ),
    );
    expect([refused.code, refused.details?.reason]).toEqual(['INVALID_INPUT', 'spot']);
    expect(dropletPosts(emu)).toHaveLength(0);
    // A size with a Spot price goes through on the same uncached path.
    freshBudgets();
    const fresh = await build(spotEmulator(), spotAccount);
    await fresh.create(spotRequest(), ctx('ok'));
  });

  it('while the wire shape is unverified, a Spot create needs previews: no POST', async () => {
    const emu = spotEmulator();
    const compute = await build(emu, { ...spotAccount, previews: false });
    const refused = await failure(compute.create(spotRequest(), ctx()));
    expect([refused.code, refused.details?.reason]).toEqual(['UNSUPPORTED', 'spotPreview']);
    expect(emu.requests).toHaveLength(0);
  });
});
