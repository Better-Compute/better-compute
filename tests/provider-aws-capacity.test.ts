import { describe, expect, it } from 'vitest';
import type { CallContext, Logger, ProviderContext } from '@better-compute/core';
import { ec2Client } from '@better-compute/aws-core';
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
import { CapacityEmulator } from './support/aws-emulator/capacity.js';

// AWS A3, capacity markets: On-Demand Capacity Reservations and Capacity Blocks as
// ExternalReservations and reservation offers, launches into them, Spot, quota headroom and
// pricing, against the in-process EC2 emulator.

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const HOUR = 3_600_000;

function world(overrides: Partial<AwsConfig> = {}, logs: unknown[][] = []) {
  const emu = new AwsEmulator();
  const ec2emu = new Ec2Emulator(emu);
  const capacity = new CapacityEmulator(emu, ec2emu);
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
  return { emu, ec2emu, capacity, compute, config, call, logs };
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
