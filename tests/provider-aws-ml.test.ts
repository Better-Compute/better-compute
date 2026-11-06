import { describe, expect, it } from 'vitest';
import type { CallContext, Logger, ProviderContext, ProviderPlacement } from '@better-compute/core';
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
import { PlacementEmulator } from './support/aws-emulator/placement.js';

// AWS A10, the ML fabric: placement groups, instance topology, EFA, Neuron and Graviton, against
// the in-process EC2 emulator.

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };

function world(overrides: Partial<AwsConfig> = {}, logs: unknown[][] = []) {
  const emu = new AwsEmulator();
  const ec2emu = new Ec2Emulator(emu);
  const capacity = new CapacityEmulator(emu, ec2emu);
  const placement = new PlacementEmulator(emu, ec2emu);
  const config = {
    ...(awsConfig.parse({ region: 'us-east-1', zones: ['us-east-1a', 'us-east-1b'] }) as AwsConfig),
    ...overrides,
  };
  const log: Logger = {
    ...quiet,
    warn: (...args: unknown[]) => void logs.push(['warn', ...args]),
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
  const runs = () => emu.requests.filter((request) => request.operation === 'RunInstances');
  return { emu, ec2emu, capacity, placement, compute, config, call, logs, runs };
}

const request = (offerId: string, placement?: ProviderPlacement) => ({
  offerId,
  image: 'ami-0123456789abcdef0',
  userData: '#!/bin/sh\ntrue\n',
  name: 'vm-1',
  ...(placement ? { placement } : {}),
});

describe('placement groups', () => {
  it('makes a managed cluster group once and launches every machine into it', async () => {
    const w = world();
    const placement = { group: 'bc-pg-0123abcd', strategy: 'cluster' } as const;
    const first = await w.compute.create(
      request('us-east-1a/p5.48xlarge', placement),
      w.call('ins_1'),
    );
    const second = await w.compute.create(
      request('us-east-1a/p5.48xlarge', placement),
      w.call('ins_2'),
    );

    const creates = w.placement.calls.filter((c) => c.action === 'CreatePlacementGroup');
    expect(creates).toHaveLength(1);
    expect(creates[0]!.params.get('Strategy')).toBe('cluster');
    expect(creates[0]!.params.has('PartitionCount')).toBe(false);
    const group = w.placement.groups.get('bc-pg-0123abcd')!;
    expect(group.tags.get('better-compute:managed')).toBe('true');
    expect(w.placement.members.get(first.id)).toEqual({ group: 'bc-pg-0123abcd' });
    expect(w.placement.members.get(second.id)).toEqual({ group: 'bc-pg-0123abcd' });
    expect(w.runs()[0]!.params.get('Placement.GroupName')).toBe('bc-pg-0123abcd');
    expect(w.runs()[0]!.params.get('Placement.AvailabilityZone')).toBe('us-east-1a');
    // The second launch trusts the group it made a moment ago: one read in all.
    expect(w.placement.calls.filter((c) => c.action === 'DescribePlacementGroups')).toHaveLength(1);
  });

  it('a partition group gets seven partitions and a launch may name one', async () => {
    const w = world();
    const machine = await w.compute.create(
      request('us-east-1a/m7i.large', { group: 'bc-pg-part', strategy: 'partition', partition: 3 }),
      w.call(),
    );
    expect(w.placement.groups.get('bc-pg-part')).toMatchObject({
      strategy: 'partition',
      partitionCount: 7,
    });
    expect(w.placement.members.get(machine.id)).toEqual({ group: 'bc-pg-part', partition: 3 });
  });

  it('a retried create repeats the same launch', async () => {
    const w = world();
    const placement = { group: 'bc-pg-retry', strategy: 'spread' } as const;
    const first = await w.compute.create(
      request('us-east-1a/m7i.large', placement),
      w.call('ins_9'),
    );
    const again = await w.compute.create(
      request('us-east-1a/m7i.large', placement),
      w.call('ins_9'),
    );
    expect(again.id).toBe(first.id);
    expect(w.ec2emu.instances.size).toBe(1);
  });

  it('refuses a group better-compute did not make', async () => {
    const w = world();
    w.placement.add({ name: 'bc-pg-theirs', strategy: 'cluster' });
    await expect(
      w.compute.create(
        request('us-east-1a/m7i.large', { group: 'bc-pg-theirs', strategy: 'cluster' }),
        w.call(),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT', details: { reason: 'placement-group-foreign' } });
    expect(w.runs()).toHaveLength(0);
  });

  it('refuses a group whose strategy differs from the one asked for', async () => {
    const w = world();
    w.placement.add({
      name: 'bc-pg-spread',
      strategy: 'spread',
      tags: new Map([['better-compute:managed', 'true']]),
    });
    await expect(
      w.compute.create(
        request('us-east-1a/m7i.large', { group: 'bc-pg-spread', strategy: 'cluster' }),
        w.call(),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT', details: { reason: 'placement-strategy' } });
    expect(w.runs()).toHaveLength(0);
  });

  it('a group EC2 does not show yet is found after its Duplicate', async () => {
    const w = world();
    w.placement.add({
      name: 'bc-pg-lag',
      strategy: 'cluster',
      tags: new Map([['better-compute:managed', 'true']]),
      hiddenReads: 1,
    });
    const machine = await w.compute.create(
      request('us-east-1a/m7i.large', { group: 'bc-pg-lag', strategy: 'cluster' }),
      w.call(),
    );
    expect(w.placement.members.get(machine.id)).toEqual({ group: 'bc-pg-lag' });
  });

  it('is unavailable while a duplicate group stays out of sight, and never launches blind', async () => {
    const w = world();
    w.placement.add({
      name: 'bc-pg-hidden',
      strategy: 'cluster',
      tags: new Map([['better-compute:managed', 'true']]),
      hiddenReads: 10,
    });
    await expect(
      w.compute.create(
        request('us-east-1a/m7i.large', { group: 'bc-pg-hidden', strategy: 'cluster' }),
        w.call(),
      ),
    ).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      details: { reason: 'placement-group-propagating' },
    });
    expect(w.runs()).toHaveLength(0);
  });

  it('refuses a deleting group until it is gone', async () => {
    const w = world();
    w.placement.add({
      name: 'bc-pg-going',
      strategy: 'cluster',
      state: 'deleting',
      tags: new Map([['better-compute:managed', 'true']]),
    });
    await expect(
      w.compute.create(
        request('us-east-1a/m7i.large', { group: 'bc-pg-going', strategy: 'cluster' }),
        w.call(),
      ),
    ).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      details: { reason: 'placement-group-deleting' },
    });
  });

  it.each([
    [{ group: '', strategy: 'cluster' }, 'placement-group'],
    [{ group: 'bad name', strategy: 'cluster' }, 'placement-group'],
    [{ group: 'x'.repeat(256), strategy: 'cluster' }, 'placement-group'],
    [{ group: 'bc-pg-a', strategy: 'mesh' }, 'placement-strategy'],
    [{ group: 'bc-pg-a', strategy: 'cluster', partition: 1 }, 'placement-partition'],
    [{ group: 'bc-pg-a', strategy: 'partition', partition: 0 }, 'placement-partition'],
    [{ group: 'bc-pg-a', strategy: 'partition', partition: 8 }, 'placement-partition'],
    [{ group: 'bc-pg-a', strategy: 'partition', partition: 1.5 }, 'placement-partition'],
  ])('refuses placement %j before any call', async (placement, reason) => {
    const w = world();
    await expect(
      w.compute.create(
        request('us-east-1a/m7i.large', placement as unknown as ProviderPlacement),
        w.call(),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT', details: { reason } });
    expect(w.placement.calls).toHaveLength(0);
    expect(w.runs()).toHaveLength(0);
  });

  it('refuses placement with a reservation offer', async () => {
    const w = world();
    w.capacity.add({ id: 'cr-0aaaaaaaaaaaaaaa1', total: 2, type: 'm7i.large' });
    await expect(
      w.compute.create(
        request('us-east-1a/m7i.large@cr-0aaaaaaaaaaaaaaa1', {
          group: 'bc-pg-a',
          strategy: 'cluster',
        }),
        w.call(),
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      details: { reason: 'placement-reservation' },
    });
    expect(w.runs()).toHaveLength(0);
  });
});
