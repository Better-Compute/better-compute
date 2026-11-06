import { describe, expect, it } from 'vitest';
import type { CallContext, Logger, ProviderContext } from '@better-compute/core';
import { ec2Client, jsonClient } from '@better-compute/aws-core';
import {
  accountCredentials,
  AwsCompute,
  awsConfig,
  instanceTypeCache,
  zoneCache,
  type AwsConfig,
} from '@better-compute/provider-aws';
import { AwsEmulator } from './support/aws-emulator/index.js';
import { Ec2Emulator } from './support/aws-emulator/ec2.js';
import {
  CapacityEmulator,
  PricingEmulator,
  ServiceQuotasEmulator,
} from './support/aws-emulator/capacity.js';

// AWS A3, capacity markets: On-Demand Capacity Reservations and Capacity Blocks as
// ExternalReservations and reservation offers, launches into them, Spot, quota headroom and
// pricing, against the in-process EC2 emulator.

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const HOUR = 3_600_000;

function world(overrides: Partial<AwsConfig> = {}, logs: unknown[][] = []) {
  const emu = new AwsEmulator();
  const ec2emu = new Ec2Emulator(emu);
  const capacity = new CapacityEmulator(emu, ec2emu);
  const quotas = new ServiceQuotasEmulator(emu);
  const pricing = new PricingEmulator(emu);
  const config = {
    ...(awsConfig.parse({ region: 'us-east-1', zones: ['us-east-1a', 'us-east-1b'] }) as AwsConfig),
    ...overrides,
  };
  const log: Logger = {
    ...quiet,
    warn: (...args: unknown[]) => void logs.push(['warn', ...args]),
    info: (...args: unknown[]) => void logs.push(['info', ...args]),
  };
  const context: ProviderContext = {
    clock: emu.clock,
    log,
    secrets: { resolve: async () => '' },
    account: { id: 'pa_platform', tenantId: 'root', platform: true },
  };
  const options = { fetch: emu.fetch, credentials: emu.ambient };
  const account = accountCredentials(config, context, options);
  const ec2 = ec2Client({
    region: config.region,
    credentials: account.source,
    fetch: emu.fetch,
    clock: emu.clock,
  });
  const compute = new AwsCompute(config, context, options, {
    ec2,
    quotas: jsonClient({
      service: 'servicequotas',
      region: config.region,
      credentials: account.source,
      fetch: emu.fetch,
      clock: emu.clock,
      jsonVersion: '1.1',
      targetPrefix: 'ServiceQuotasV20190624',
    }),
    pricing: jsonClient({
      service: 'pricing',
      region: config.region,
      credentials: account.source,
      fetch: emu.fetch,
      clock: emu.clock,
      jsonVersion: '1.1',
      targetPrefix: 'AWSPriceListService',
    }),
    account,
    types: instanceTypeCache(ec2, { clock: emu.clock }),
    zones: zoneCache(ec2, { clock: emu.clock }),
  });
  const call = (key = 'ins_1'): CallContext => ({
    idempotencyKey: key,
    signal: new AbortController().signal,
    clock: emu.clock,
    secrets: context.secrets,
    log,
  });
  return { emu, ec2emu, capacity, quotas, pricing, compute, config, call, logs };
}

describe('capacity reservations', () => {
  it('maps ODCRs and capacity blocks to ExternalReservation', async () => {
    const w = world();
    const now = w.emu.now();
    w.capacity.add({ id: 'cr-0aaaaaaaaaaaaaaa1', total: 4, usedElsewhere: 1, match: 'open' });
    w.capacity.add({
      id: 'cr-0bbbbbbbbbbbbbbb2',
      type: 'g6.xlarge',
      zone: 'us-east-1b',
      state: 'scheduled',
      reservationType: 'capacity-block',
      total: 2,
      start: now + 24 * HOUR,
      end: now + 48 * HOUR,
    });
    w.capacity.add({ id: 'cr-0ccccccccccccccc3', state: 'pending', type: 'm7i.large' });
    // Gone, foreign-platform, dedicated and out-of-zone reservations are never reported.
    w.capacity.add({ id: 'cr-0ddddddddddddddd4', state: 'expired' });
    w.capacity.add({ id: 'cr-0eeeeeeeeeeeeeee5', state: 'cancelled' });
    w.capacity.add({ id: 'cr-0fffffffffffffff6', platform: 'Windows' });
    w.capacity.add({ id: 'cr-0aaaaaaaaaaaaaab7', tenancy: 'dedicated' });
    w.capacity.add({ id: 'cr-0aaaaaaaaaaaaaab8', zone: 'us-east-1c' });
    w.capacity.add({ id: 'cr-0aaaaaaaaaaaaaab9', state: 'some-new-state' });

    const reservations = await w.compute.listReservations(w.call());
    // Sorted by id; gone, foreign-platform, dedicated, out-of-zone and unknown-state ones are left out.
    expect(reservations.map((r) => [r.id, r.state])).toEqual([
      ['cb:cr-0bbbbbbbbbbbbbbb2', 'scheduled'],
      ['cr-0aaaaaaaaaaaaaaa1', 'ready'],
      ['cr-0ccccccccccccccc3', 'creating'],
    ]);
    expect(reservations[1]).toEqual({
      id: 'cr-0aaaaaaaaaaaaaaa1',
      name: 'cr-0aaaaaaaaaaaaaaa1',
      zone: 'us-east-1a',
      region: 'us-east-1',
      state: 'ready',
      machineType: 'p5.48xlarge',
      vcpu: 192,
      memoryGiB: 2048,
      gpus: { model: 'H100', count: 8 },
      localSsdGiB: 30_400,
      total: 4,
      inUse: 1,
      specificOnly: false,
      shared: false,
      offerId: 'us-east-1a/p5.48xlarge@cr-0aaaaaaaaaaaaaaa1',
    });
    expect(reservations[0]).toMatchObject({
      id: 'cb:cr-0bbbbbbbbbbbbbbb2',
      name: 'cb-cr-0bbbbbbbbbbbbbbb2',
      zone: 'us-east-1b',
      machineType: 'g6.xlarge',
      total: 2,
      inUse: 0,
      specificOnly: true,
      startsAt: now + 24 * HOUR,
      endsAt: now + 48 * HOUR,
      offerId: 'us-east-1b/g6.xlarge@cr-0bbbbbbbbbbbbbbb2',
    });
    // Paged reads (page size 2) all arrive.
    expect(w.emu.calls('DescribeCapacityReservations').length).toBeGreaterThan(1);
  });

  it('shared ODCRs are marked shared', async () => {
    const w = world();
    w.capacity.add({ id: 'cr-0aaaaaaaaaaaaaaa1' });
    // Shared through RAM by another account: EC2 names the zone by zone id; the owner's AZ name
    // differs, so the zone comes from the id as this account sees it.
    w.capacity.add({
      id: 'cr-0bbbbbbbbbbbbbbb2',
      ownerId: '333333333333',
      zone: 'us-east-1c',
      zoneId: 'use1-az2',
    });
    const reservations = await w.compute.listReservations(w.call());
    expect(reservations.map((r) => [r.id, r.shared, r.zone])).toEqual([
      ['cr-0aaaaaaaaaaaaaaa1', false, 'us-east-1a'],
      ['cr-0bbbbbbbbbbbbbbb2', true, 'us-east-1b'],
    ]);
  });

  it('ready reservations are offered with their free slots', async () => {
    const w = world();
    w.capacity.add({ id: 'cr-0aaaaaaaaaaaaaaa1', total: 3, usedElsewhere: 1 });
    w.capacity.add({
      id: 'cr-0bbbbbbbbbbbbbbb2',
      type: 'g6.xlarge',
      reservationType: 'capacity-block',
      total: 1,
      usedElsewhere: 1,
    });
    w.capacity.add({ id: 'cr-0ccccccccccccccc3', state: 'scheduled' });
    const offers = await w.compute.listOffers({});
    const reserved = offers.filter((offer) => offer.id.includes('@'));
    expect(reserved).toEqual([
      expect.objectContaining({
        id: 'us-east-1a/g6.xlarge@cr-0bbbbbbbbbbbbbbb2',
        market: 'capacity-block',
        count: 0,
        available: false,
        gpus: { model: 'L4', count: 1 },
      }),
      expect.objectContaining({
        id: 'us-east-1a/p5.48xlarge@cr-0aaaaaaaaaaaaaaa1',
        market: 'reserved',
        count: 2,
        available: true,
        vcpu: 192,
      }),
    ]);
    // Query filters apply to reservation offers too.
    const l4 = await w.compute.listOffers({ gpuModel: 'L4' });
    expect(l4.filter((offer) => offer.id.includes('@')).map((offer) => offer.id)).toEqual([
      'us-east-1a/g6.xlarge@cr-0bbbbbbbbbbbbbbb2',
    ]);
  });

  it('an account that may not read reservations still lists on-demand offers', async () => {
    const logs: unknown[][] = [];
    const w = world({}, logs);
    w.emu.failNext('DescribeCapacityReservations', 'UnauthorizedOperation', 403);
    const offers = await w.compute.listOffers({});
    expect(offers.length).toBeGreaterThan(0);
    expect(offers.some((offer) => offer.id.includes('@'))).toBe(false);
    expect(
      logs.some(([level, message]) => level === 'warn' && String(message).includes('reservations')),
    ).toBe(true);
  });
});

const createRequest = (offerId: string) => ({
  offerId,
  image: 'ami-0123456789abcdef0',
  userData: '#!/bin/sh\ntrue\n',
  name: 'vm-1',
});

describe('launches into reservations', () => {
  it('reservation offers set the capacity reservation target', async () => {
    const w = world();
    w.capacity.add({ id: 'cr-0aaaaaaaaaaaaaaa1', type: 'm7i.large', total: 1 });
    const machine = await w.compute.create(
      createRequest('us-east-1a/m7i.large@cr-0aaaaaaaaaaaaaaa1'),
      w.call('ins_1'),
    );
    const run = w.emu.calls('RunInstances')[0]!.params;
    expect(
      run.get('CapacityReservationSpecification.CapacityReservationTarget.CapacityReservationId'),
    ).toBe('cr-0aaaaaaaaaaaaaaa1');
    expect(run.get('InstanceMarketOptions.MarketType')).toBeNull();
    expect(machine).toMatchObject({
      reservation: 'cr-0aaaaaaaaaaaaaaa1',
      market: 'reserved',
      offerId: 'us-east-1a/m7i.large@cr-0aaaaaaaaaaaaaaa1',
    });
    // A retried create is the same launch (same ClientToken and parameters).
    await w.compute.create(
      createRequest('us-east-1a/m7i.large@cr-0aaaaaaaaaaaaaaa1'),
      w.call('ins_1'),
    );
    expect(w.ec2emu.instances.size).toBe(1);
    // The reservation is full now: EC2 refuses, and that is CAPACITY_UNAVAILABLE.
    await expect(
      w.compute.create(createRequest('us-east-1a/m7i.large@cr-0aaaaaaaaaaaaaaa1'), w.call('ins_2')),
    ).rejects.toMatchObject({ code: 'CAPACITY_UNAVAILABLE' });
  });

  it('capacity block launches set the market type', async () => {
    const w = world();
    w.capacity.add({
      id: 'cr-0bbbbbbbbbbbbbbb2',
      type: 'p5.48xlarge',
      reservationType: 'capacity-block',
      total: 1,
      end: w.emu.now() + 24 * HOUR,
    });
    const machine = await w.compute.create(
      createRequest('us-east-1a/p5.48xlarge@cr-0bbbbbbbbbbbbbbb2'),
      w.call('ins_1'),
    );
    const run = w.emu.calls('RunInstances')[0]!.params;
    expect(run.get('InstanceMarketOptions.MarketType')).toBe('capacity-block');
    expect(
      run.get('CapacityReservationSpecification.CapacityReservationTarget.CapacityReservationId'),
    ).toBe('cr-0bbbbbbbbbbbbbbb2');
    expect(machine).toMatchObject({
      reservation: 'cb:cr-0bbbbbbbbbbbbbbb2',
      market: 'capacity-block',
    });
    const read = await w.compute.get(machine.id, w.call('ins_1'));
    expect(read).toMatchObject({
      reservation: 'cb:cr-0bbbbbbbbbbbbbbb2',
      market: 'capacity-block',
    });
  });

  it('refuses a reservation it cannot launch into, before RunInstances', async () => {
    const w = world();
    w.capacity.add({ id: 'cr-0aaaaaaaaaaaaaaa1', type: 'm7i.large', state: 'scheduled' });
    w.capacity.add({ id: 'cr-0bbbbbbbbbbbbbbb2', type: 'm7i.large', platform: 'Windows' });
    w.capacity.add({ id: 'cr-0ccccccccccccccc3', type: 'g6.xlarge' });
    const attempt = (offer: string) => w.compute.create(createRequest(offer), w.call('ins_x'));
    await expect(attempt('us-east-1a/m7i.large@cr-0aaaaaaaaaaaaaaa1')).rejects.toMatchObject({
      code: 'CAPACITY_UNAVAILABLE',
      details: { reason: 'reservation-not-active' },
    });
    await expect(attempt('us-east-1a/m7i.large@cr-0bbbbbbbbbbbbbbb2')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      details: { reason: 'capacity-reservation' },
    });
    // The offer names another type than the reservation holds.
    await expect(attempt('us-east-1a/m7i.large@cr-0ccccccccccccccc3')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      details: { reason: 'capacity-reservation' },
    });
    await expect(attempt('us-east-1a/m7i.large@cr-0ddddddddddddddd4')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      details: { reason: 'capacity-reservation' },
    });
    await expect(attempt('us-east-1a/m7i.large@cr-0ccccccccccccccc3:spot')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(w.emu.calls('RunInstances')).toHaveLength(0);
  });
});

describe('spot', () => {
  it('spot offers are listed only when the account enables spot', async () => {
    const off = world();
    expect((await off.compute.listOffers({})).some((offer) => offer.id.endsWith(':spot'))).toBe(
      false,
    );
    const on = world({ spot: true });
    const offers = await on.compute.listOffers({ gpuModel: 'L4' });
    expect(offers.map((offer) => [offer.id, offer.market ?? 'on-demand'])).toEqual([
      ['us-east-1a/g6.xlarge', 'on-demand'],
      ['us-east-1a/g6.xlarge:spot', 'spot'],
      ['us-east-1b/g6.xlarge', 'on-demand'],
      ['us-east-1b/g6.xlarge:spot', 'spot'],
    ]);
  });

  it('a spot create is a one-time spot request that terminates on interruption', async () => {
    const w = world({ spot: true });
    const machine = await w.compute.create(createRequest('us-east-1a/t3.micro:spot'), w.call());
    const run = w.emu.calls('RunInstances')[0]!.params;
    expect(run.get('InstanceMarketOptions.MarketType')).toBe('spot');
    expect(run.get('InstanceMarketOptions.SpotOptions.SpotInstanceType')).toBe('one-time');
    expect(run.get('InstanceMarketOptions.SpotOptions.InstanceInterruptionBehavior')).toBe(
      'terminate',
    );
    expect(run.get('InstanceInitiatedShutdownBehavior')).toBe('terminate');
    expect(machine).toMatchObject({ market: 'spot', offerId: 'us-east-1a/t3.micro:spot' });
  });

  it('a spot create on an account without spot is refused', async () => {
    const w = world();
    await expect(
      w.compute.create(createRequest('us-east-1a/t3.micro:spot'), w.call()),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT', details: { reason: 'spot-disabled' } });
    expect(w.emu.calls('RunInstances')).toHaveLength(0);
  });

  it('spot termination surfaces as an interruption', async () => {
    const w = world({ spot: true });
    const machine = await w.compute.create(createRequest('us-east-1a/t3.micro:spot'), w.call());
    w.ec2emu.tick();
    const reclaimedAt = w.emu.now();
    w.emu.clock.advance(60_000);
    w.ec2emu.asyncFailure(machine.id, 'Server.SpotInstanceTermination');
    w.ec2emu.instances.get(machine.id)!.transitionReason =
      `Service initiated (${new Date(reclaimedAt).toISOString().slice(0, 19).replace('T', ' ')} GMT)`;
    const read = await w.compute.get(machine.id, w.call());
    expect(read).toMatchObject({
      state: 'deleted',
      market: 'spot',
      interruption: { kind: 'spot', at: reclaimedAt, action: 'terminate' },
    });
    // An on-demand termination is no interruption.
    const plain = await w.compute.create(createRequest('us-east-1a/t3.micro'), w.call('ins_2'));
    w.ec2emu.asyncFailure(plain.id, 'Client.UserInitiatedShutdown');
    expect((await w.compute.get(plain.id, w.call('ins_2')))?.interruption).toBeUndefined();
  });
});

describe('quotas', () => {
  it('quota headroom limits offer count', async () => {
    const w = world({ spot: true });
    // Standard on-demand: 10 vCPUs, 4 in use (two running m7i.large; a stopped one counts nothing).
    w.quotas.quotas.set('L-1216C47A', 10);
    w.ec2emu.addInstance({ type: 'm7i.large' });
    w.ec2emu.addInstance({ type: 'm7i.large', state: 'pending' });
    w.ec2emu.addInstance({ type: 'm7i.large', state: 'stopped' });
    // G and VT on-demand: none at all. P: the quota does not exist here (count unknown).
    w.quotas.quotas.set('L-DB2E81BA', 0);
    // Standard Spot: 4 vCPUs, one t3.micro Spot Instance running.
    w.quotas.quotas.set('L-34B43A08', 4);
    w.ec2emu.addInstance({ type: 't3.micro' }).lifecycle = 'spot';
    const offers = await w.compute.listOffers({});
    const byId = new Map(offers.map((offer) => [offer.id, offer]));
    expect(byId.get('us-east-1a/m7i.large')).toMatchObject({ count: 3, available: true });
    expect(byId.get('us-east-1a/t3.micro')).toMatchObject({ count: 3, available: true });
    expect(byId.get('us-east-1a/g6.xlarge')).toMatchObject({ count: 0, available: false });
    expect(byId.get('us-east-1a/p5.48xlarge')?.count).toBeUndefined();
    expect(byId.get('us-east-1a/p5.48xlarge')?.available).toBe(true);
    expect(byId.get('us-east-1a/t3.micro:spot')).toMatchObject({ count: 1, available: true });
    expect(byId.get('us-east-1a/m7i.large:spot')).toMatchObject({ count: 1, available: true });
    // Graviton is a standard family too.
    expect(byId.get('us-east-1a/m7g.large')).toMatchObject({ count: 3 });

    // Usage and limits are cached for 5 minutes.
    const reads = () => [
      w.emu.calls('GetServiceQuota').length,
      w.emu.calls('DescribeInstances').length,
    ];
    const before = reads();
    await w.compute.listOffers({});
    expect(reads()).toEqual(before);
    w.emu.clock.advance(6 * 60_000);
    w.ec2emu.addInstance({ type: 'm7i.large' });
    const later = new Map((await w.compute.listOffers({})).map((offer) => [offer.id, offer]));
    expect(later.get('us-east-1a/m7i.large')).toMatchObject({ count: 2 });
  });

  it('an unreadable quota leaves count unset', async () => {
    const logs: unknown[][] = [];
    const w = world({}, logs);
    w.emu.failNext('GetServiceQuota', 'AccessDeniedException', 400, 20);
    const offers = await w.compute.listOffers({});
    expect(offers.length).toBeGreaterThan(0);
    expect(
      offers
        .filter((offer) => !offer.id.includes('@'))
        .every((offer) => offer.count === undefined && offer.available),
    ).toBe(true);
    expect(
      logs.some(([level, message]) => level === 'warn' && String(message).includes('quotas')),
    ).toBe(true);
  });

  it('quotas: false reads no quota', async () => {
    const w = world({ quotas: false });
    w.quotas.quotas.set('L-1216C47A', 0);
    const offers = await w.compute.listOffers({});
    expect(offers.find((offer) => offer.id === 'us-east-1a/m7i.large')?.count).toBeUndefined();
    expect(w.emu.calls('GetServiceQuota')).toHaveLength(0);
  });
});

describe('quota errors', () => {
  it('a quota code the region does not have is unknown, not a warning', async () => {
    const logs: unknown[][] = [];
    const w = world({}, logs);
    // Only the standard code exists; G/VT and P answer NoSuchResourceException.
    w.quotas.quotas.set('L-1216C47A', 10);
    const offers = await w.compute.listOffers({});
    expect(offers.find((offer) => offer.id === 'us-east-1a/m7i.large')?.count).toBe(5);
    expect(offers.find((offer) => offer.id === 'us-east-1a/g6.xlarge')?.count).toBeUndefined();
    expect(logs.filter(([level]) => level === 'warn')).toEqual([]);
  });
});

describe('pricing', () => {
  const priced = async (w: ReturnType<typeof world>) =>
    new Map(
      (await w.compute.listOffers({})).map((offer) => [
        offer.id,
        offer.pricePerHour === undefined ? undefined : [offer.pricePerHour, offer.currency],
      ]),
    );

  it('is off by default', async () => {
    const w = world({ spot: true });
    const prices = await priced(w);
    expect([...prices.values()].every((price) => price === undefined)).toBe(true);
    expect(w.emu.calls('GetProducts')).toHaveLength(0);
    expect(w.emu.calls('DescribeSpotPriceHistory')).toHaveLength(0);
  });

  it('on-demand prices come from the Price List, cached for a day', async () => {
    const w = world({ spot: true, pricing: 'on-demand' });
    const prices = await priced(w);
    expect(prices.get('us-east-1a/m7i.large')).toEqual([0.1008, 'USD']);
    expect(prices.get('us-east-1b/g6.xlarge')).toEqual([0.8048, 'USD']);
    // Spot prices only with pricing: all.
    expect(prices.get('us-east-1a/t3.micro:spot')).toBeUndefined();
    // A type the Price List does not know stays unpriced.
    expect(prices.get('us-east-1a/c7i.metal-24xl')).toBeUndefined();
    const filters = JSON.parse(w.emu.calls('GetProducts')[0]!.body).Filters;
    expect(filters).toEqual(
      expect.arrayContaining([
        { Type: 'TERM_MATCH', Field: 'regionCode', Value: 'us-east-1' },
        { Type: 'TERM_MATCH', Field: 'operatingSystem', Value: 'Linux' },
        { Type: 'TERM_MATCH', Field: 'tenancy', Value: 'Shared' },
        { Type: 'TERM_MATCH', Field: 'preInstalledSw', Value: 'NA' },
        { Type: 'TERM_MATCH', Field: 'capacitystatus', Value: 'Used' },
      ]),
    );
    // Paged (page size 2), then cached.
    const pages = w.emu.calls('GetProducts').length;
    expect(pages).toBeGreaterThan(1);
    await priced(w);
    expect(w.emu.calls('GetProducts')).toHaveLength(pages);
    w.emu.clock.advance(25 * HOUR);
    await priced(w);
    expect(w.emu.calls('GetProducts').length).toBeGreaterThan(pages);
  });

  it('spot prices are the latest per zone and type', async () => {
    const w = world({ spot: true, pricing: 'all' });
    const prices = await priced(w);
    expect(prices.get('us-east-1a/t3.micro:spot')).toEqual([0.0035, 'USD']);
    expect(prices.get('us-east-1b/t3.micro:spot')).toEqual([0.0037, 'USD']);
    expect(prices.get('us-east-1a/g6.xlarge:spot')).toEqual([0.3121, 'USD']);
    expect(prices.get('us-east-1b/g6.xlarge:spot')).toBeUndefined();
    expect(prices.get('us-east-1a/t3.micro')).toEqual([0.0104, 'USD']);
    const history = w.emu.calls('DescribeSpotPriceHistory')[0]!.params;
    expect(history.get('ProductDescription.1')).toBe('Linux/UNIX');
    expect(history.get('StartTime')).toBe(new Date(w.emu.now()).toISOString());
  });

  it('pricing failure leaves price unset', async () => {
    const logs: unknown[][] = [];
    const w = world({ spot: true, pricing: 'all' }, logs);
    w.emu.failNext('GetProducts', 'ThrottlingException', 400);
    w.emu.failNext('DescribeSpotPriceHistory', 'RequestLimitExceeded', 503);
    const offers = await w.compute.listOffers({});
    expect(offers.length).toBeGreaterThan(0);
    expect(offers.every((offer) => offer.pricePerHour === undefined)).toBe(true);
    expect(logs.filter(([level]) => level === 'warn').length).toBeGreaterThan(0);
    // A failure is retried after a short while, not a day.
    w.emu.clock.advance(11 * 60_000);
    const later = await w.compute.listOffers({});
    expect(later.find((offer) => offer.id === 'us-east-1a/m7i.large')?.pricePerHour).toBe(0.1008);
  });
});

describe('purchases', () => {
  const DAY = 24 * HOUR;
  const offerings = (w: ReturnType<typeof world>) => {
    const start = w.emu.now() + 2 * DAY;
    w.capacity.blockOfferings.push(
      {
        id: 'cb-0aaaaaaaaaaaaaaa1',
        type: 'p5.48xlarge',
        zone: 'us-east-1a',
        count: 2,
        start,
        hours: 24,
        upfrontFee: 2_359.68,
      },
      {
        id: 'cb-0bbbbbbbbbbbbbbb2',
        type: 'p5.48xlarge',
        zone: 'us-east-1c',
        count: 2,
        start,
        hours: 24,
        upfrontFee: 2_000,
      },
      {
        id: 'cb-0ccccccccccccccc3',
        type: 'p5.48xlarge',
        zone: 'us-east-1a',
        count: 2,
        start: start + DAY,
        hours: 24,
        upfrontFee: 2_100,
      },
    );
    return start;
  };

  it('lists Capacity Block offerings and ODCRs to create, in the account zones', async () => {
    const w = world();
    const start = offerings(w);
    const found = await w.compute.listReservationOfferings(
      { instanceType: 'p5.48xlarge', count: 2, durationHours: 24 },
      w.call(),
    );
    expect(found).toEqual([
      {
        id: 'odcr:us-east-1a/p5.48xlarge/2/24',
        instanceType: 'p5.48xlarge',
        zone: 'us-east-1a',
        count: 2,
        startsAt: w.emu.now(),
        endsAt: w.emu.now() + DAY,
        upfrontPrice: 0,
        currency: 'USD',
      },
      {
        // Self-describing: the purchase re-finds the offering and never pays more than this.
        id: `cb:us-east-1a/p5.48xlarge/2/24/${start / 1000}/235968/cb-0aaaaaaaaaaaaaaa1`,
        instanceType: 'p5.48xlarge',
        zone: 'us-east-1a',
        count: 2,
        startsAt: start,
        endsAt: start + DAY,
        upfrontPrice: 2_359.68,
        currency: 'USD',
      },
      expect.objectContaining({
        id: expect.stringMatching(/\/cb-0ccccccccccccccc3$/),
        startsAt: start + DAY,
      }),
    ]);
    // A start window that excludes now offers no ODCR; it narrows the blocks too.
    const later = await w.compute.listReservationOfferings(
      { instanceType: 'p5.48xlarge', count: 2, durationHours: 24, earliestStart: start + DAY / 2 },
      w.call(),
    );
    expect(later.map((offering) => offering.id.split('/').pop())).toEqual(['cb-0ccccccccccccccc3']);
    await expect(
      w.compute.listReservationOfferings(
        { instanceType: 'p5.48xlarge', count: 0, durationHours: 24 },
        w.call(),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  const blockId = (
    w: ReturnType<typeof world>,
    start: number,
    id: string,
    cents: number,
    extra = 0,
  ) => `cb:us-east-1a/p5.48xlarge/2/24/${(start + extra) / 1000}/${cents}/${id}`;

  it('allowPurchases=false refuses, before any EC2 call', async () => {
    const w = world();
    const start = offerings(w);
    await expect(
      w.compute.purchaseReservation(
        blockId(w, start, 'cb-0aaaaaaaaaaaaaaa1', 235968),
        w.call('buy-1'),
      ),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED', details: { reason: 'purchases-disabled' } });
    expect(w.emu.calls('PurchaseCapacityBlock')).toHaveLength(0);
  });

  it('buying a Capacity Block is idempotent by key', async () => {
    const w = world({ allowPurchases: true });
    const start = offerings(w);
    const id = blockId(w, start, 'cb-0aaaaaaaaaaaaaaa1', 235968);
    const bought = await w.compute.purchaseReservation(id, w.call('buy-1'));
    expect(bought).toMatchObject({
      id: expect.stringMatching(/^cb:cr-/),
      state: 'scheduled',
      machineType: 'p5.48xlarge',
      zone: 'us-east-1a',
      total: 2,
      startsAt: start,
      endsAt: start + DAY,
      specificOnly: true,
      shared: false,
    });
    const purchase = w.emu.calls('PurchaseCapacityBlock')[0]!.params;
    expect(purchase.get('InstancePlatform')).toBe('Linux/UNIX');
    expect(purchase.get('TagSpecification.1.ResourceType')).toBe('capacity-reservation');
    // A retry with the same key finds the block it bought (by its purchase tag): no second buy.
    const again = await w.compute.purchaseReservation(id, w.call('buy-1'));
    expect(again.id).toBe(bought.id);
    expect(w.capacity.purchases).toHaveLength(1);
    // Another key is another purchase.
    await w.compute.purchaseReservation(
      blockId(w, start, 'cb-0ccccccccccccccc3', 210000, DAY),
      w.call('buy-2'),
    );
    expect(w.capacity.purchases).toHaveLength(2);
  });

  it('a block whose price rose or that is gone is not bought', async () => {
    const w = world({ allowPurchases: true });
    const start = offerings(w);
    // Confirmed at 2 000.00; it now costs 2 359.68.
    await expect(
      w.compute.purchaseReservation(
        blockId(w, start, 'cb-0aaaaaaaaaaaaaaa1', 200000),
        w.call('k1'),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT', details: { reason: 'price-changed' } });
    // Sold to someone else.
    w.capacity.blockOfferings.splice(0, 1);
    await expect(
      w.compute.purchaseReservation(
        blockId(w, start, 'cb-0aaaaaaaaaaaaaaa1', 235968),
        w.call('k2'),
      ),
    ).rejects.toMatchObject({ code: 'CAPACITY_UNAVAILABLE', details: { reason: 'offering-gone' } });
    expect(w.emu.calls('PurchaseCapacityBlock')).toHaveLength(0);
  });

  it('creating an ODCR is idempotent by ClientToken', async () => {
    const w = world({ allowPurchases: true });
    const created = await w.compute.purchaseReservation(
      'odcr:us-east-1a/m7i.large/3/48',
      w.call('buy-odcr'),
    );
    expect(created).toMatchObject({
      id: expect.stringMatching(/^cr-/),
      state: 'creating',
      machineType: 'm7i.large',
      total: 3,
      specificOnly: true,
    });
    const params = w.emu.calls('CreateCapacityReservation')[0]!.params;
    expect(params.get('InstanceMatchCriteria')).toBe('targeted');
    expect(params.get('EndDateType')).toBe('limited');
    expect(params.get('EndDate')).toBe(new Date(w.emu.now() + 48 * HOUR).toISOString());
    expect(params.get('Tenancy')).toBe('default');
    expect(params.get('ClientToken')).toMatch(/^[0-9a-f]{64}$/);
    const again = await w.compute.purchaseReservation(
      'odcr:us-east-1a/m7i.large/3/48',
      w.call('buy-odcr'),
    );
    expect(again.id).toBe(created.id);
    expect(w.capacity.reservations.size).toBe(1);
  });

  it('refuses malformed, foreign-zone and tenant-account purchases', async () => {
    const w = world({ allowPurchases: true });
    offerings(w);
    const start = offerings(w);
    for (const id of [
      'odcr:us-east-1c/m7i.large/1/24',
      'odcr:us-east-1a/m7i.large/0/24',
      'nope',
      'cb:',
      'cb:cb-0aaaaaaaaaaaaaaa1',
      'odcr:us-east-1a/m7i.large/1/24/x',
      `cb:us-east-1c/p5.48xlarge/2/24/${start / 1000}/200000/cb-0bbbbbbbbbbbbbbb2`,
    ])
      await expect(w.compute.purchaseReservation(id, w.call('k'))).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
    // A tenant's own AWS account is never spent from (purchases are the platform's).
    const tenant = world({ allowPurchases: true });
    (tenant.compute.context as { account?: unknown }).account = {
      id: 'pa_tenant',
      tenantId: 'acme',
      platform: false,
    };
    await expect(
      tenant.compute.purchaseReservation('odcr:us-east-1a/m7i.large/1/24', tenant.call('k')),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED', details: { reason: 'not-platform-account' } });
    expect(w.emu.calls('PurchaseCapacityBlock')).toHaveLength(0);
    expect(w.emu.calls('CreateCapacityReservation')).toHaveLength(0);
  });
});
