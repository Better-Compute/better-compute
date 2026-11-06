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

describe('instance topology', () => {
  async function running(w: ReturnType<typeof world>, offer: string, key: string) {
    const machine = await w.compute.create(request(offer), w.call(key));
    w.ec2emu.tick();
    return machine.id;
  }

  it('labels a running EFA machine with its network nodes, read once an hour', async () => {
    const w = world();
    const id = await running(w, 'us-east-1a/p5.48xlarge', 'ins_1');
    w.placement.topology.set(id, [
      'nn-1111111111111111a',
      'nn-2222222222222222b',
      'nn-3333333333333333c',
    ]);
    const machine = await w.compute.get(id, w.call());
    expect(machine?.labels).toMatchObject({
      'topology.aws/network-node-1': 'nn-1111111111111111a',
      'topology.aws/network-node-2': 'nn-2222222222222222b',
      'topology.aws/network-node-3': 'nn-3333333333333333c',
      'topology.aws/zone-id': 'use1-az1',
    });
    await w.compute.get(id, w.call());
    const reads = () =>
      w.placement.calls.filter((c) => c.action === 'DescribeInstanceTopology').length;
    expect(reads()).toBe(1);
    w.emu.clock.advance(3_600_001);
    await w.compute.get(id, w.call());
    expect(reads()).toBe(2);
  });

  it('never reads topology for a machine type without EFA, or one not running', async () => {
    const w = world();
    const small = await running(w, 'us-east-1a/m7i.large', 'ins_1');
    const pending = await w.compute.create(request('us-east-1a/p5.48xlarge'), w.call('ins_2'));
    w.placement.topology.set(pending.id, ['nn-1', 'nn-2', 'nn-3']);
    expect((await w.compute.get(small, w.call()))?.labels).not.toHaveProperty(
      'topology.aws/network-node-1',
    );
    const seen = await w.compute.get(pending.id, w.call());
    expect(seen?.state).toBe('pending');
    expect(seen?.labels).not.toHaveProperty('topology.aws/network-node-1');
    expect(w.placement.calls.filter((c) => c.action === 'DescribeInstanceTopology')).toHaveLength(
      0,
    );
  });

  it('a tag never poses as topology, and an unreadable topology only warns once', async () => {
    const logs: unknown[][] = [];
    const w = world({}, logs);
    const id = await running(w, 'us-east-1a/p5.48xlarge', 'ins_1');
    w.ec2emu.instances.get(id)!.tags.set('topology.aws/network-node-1', 'nn-forged');
    w.placement.failNext.set('DescribeInstanceTopology', 'UnauthorizedOperation');
    const machine = await w.compute.get(id, w.call());
    expect(machine?.state).toBe('running');
    expect(machine?.labels).not.toHaveProperty('topology.aws/network-node-1');
    w.placement.failNext.set('DescribeInstanceTopology', 'UnauthorizedOperation');
    w.emu.clock.advance(3_600_001);
    await w.compute.get(id, w.call());
    expect(logs.filter(([level]) => level === 'warn')).toHaveLength(1);
    expect(JSON.stringify(logs)).not.toContain('nn-forged');
  });

  it('drops node ids that are not EC2 node ids', async () => {
    const w = world();
    const id = await running(w, 'us-east-1a/p5.48xlarge', 'ins_1');
    w.placement.topology.set(id, ['nn-1111111111111111a', 'bad id with spaces', 'nn-3']);
    const machine = await w.compute.get(id, w.call());
    expect(machine?.labels).not.toHaveProperty('topology.aws/network-node-1');
  });
});

describe('EFA', () => {
  const subnet = 'subnet-0123456789abcdef0';
  const interfaces = (params: URLSearchParams) => {
    const out: Record<string, string>[] = [];
    for (let n = 1; params.has(`NetworkInterface.${n}.DeviceIndex`); n++) {
      const entry: Record<string, string> = {};
      for (const [key, value] of params)
        if (key.startsWith(`NetworkInterface.${n}.`))
          entry[key.slice(`NetworkInterface.${n}.`.length)] = value;
      out.push(entry);
    }
    return out;
  };

  it('auto launches an EFA type with one EFA interface per network card', async () => {
    const w = world({ efa: 'auto', subnetId: subnet, securityGroupIds: ['sg-0123456789abcdef0'] });
    await w.compute.create(request('us-east-1a/p5.48xlarge'), w.call());
    const sent = interfaces(w.runs()[0]!.params);
    expect(sent).toHaveLength(32);
    expect(sent[0]).toMatchObject({
      DeviceIndex: '0',
      NetworkCardIndex: '0',
      InterfaceType: 'efa',
      SubnetId: subnet,
      'SecurityGroupId.1': 'sg-0123456789abcdef0',
      DeleteOnTermination: 'true',
    });
    expect(sent[31]).toMatchObject({
      DeviceIndex: '1',
      NetworkCardIndex: '31',
      InterfaceType: 'efa',
    });
    // EC2 refuses a public address with more than one interface.
    expect(sent.some((entry) => entry.AssociatePublicIpAddress === 'true')).toBe(false);
  });

  it('a single-card EFA type keeps its public address', async () => {
    const w = world({ efa: 'auto', subnetId: subnet });
    w.ec2emu.types.set('hpc7g.16xlarge', {
      type: 'hpc7g.16xlarge',
      vcpu: 64,
      memoryMiB: 131_072,
      arch: ['arm64'],
      efa: 1,
      networkCards: 1,
    });
    w.ec2emu.offerings.get('us-east-1a')!.add('hpc7g.16xlarge');
    await w.compute.create(request('us-east-1a/hpc7g.16xlarge'), w.call());
    expect(interfaces(w.runs()[0]!.params)).toEqual([
      expect.objectContaining({ InterfaceType: 'efa', AssociatePublicIpAddress: 'true' }),
    ]);
  });

  it('off (the default) and types without EFA launch as before', async () => {
    const off = world({ subnetId: subnet });
    expect(off.config.efa).toBe('off');
    await off.compute.create(request('us-east-1a/p5.48xlarge'), off.call());
    expect(interfaces(off.runs()[0]!.params)).toEqual([
      expect.not.objectContaining({ InterfaceType: 'efa' }),
    ]);
    const plain = world({ efa: 'auto', subnetId: subnet });
    await plain.compute.create(request('us-east-1a/m7i.large'), plain.call());
    expect(interfaces(plain.runs()[0]!.params)).toHaveLength(1);
    expect(interfaces(plain.runs()[0]!.params)[0]).not.toHaveProperty('InterfaceType');
  });

  it('auto refuses an EFA launch without a subnet rather than launching without EFA', async () => {
    const w = world({ efa: 'auto' });
    await expect(
      w.compute.create(request('us-east-1a/p5.48xlarge'), w.call()),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG', details: { reason: 'efa-subnet' } });
    expect(w.runs()).toHaveLength(0);
  });

  it('the config takes off or auto only', () => {
    expect(() =>
      awsConfig.parse({ region: 'us-east-1', zones: ['us-east-1a'], efa: 'always' }),
    ).toThrow();
  });
});
