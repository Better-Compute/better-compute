import { describe, expect, it } from 'vitest';
import type { CallContext, Logger, ProviderNetworks, ProviderSubnetSpec } from '@better-compute/core';
import { awsConfig, awsProvider, type AwsCompute, type AwsConfig } from '@better-compute/provider-aws';
import { AwsEmulator } from './support/aws-emulator/index.js';
import { Ec2Emulator } from './support/aws-emulator/ec2.js';
import { VpcEmulator } from './support/aws-emulator/vpc.js';

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/** An emulated platform account in us-east-1 with EC2 and VPC, and its provider client. */
async function world(overrides: Partial<AwsConfig> = {}) {
  const emu = new AwsEmulator();
  const ec2 = new Ec2Emulator(emu);
  const vpc = new VpcEmulator(emu, ec2);
  const logs: { level: string; message: string; fields?: unknown }[] = [];
  const log: Logger = {
    debug: (message, fields) => logs.push({ level: 'debug', message, fields }),
    info: (message, fields) => logs.push({ level: 'info', message, fields }),
    warn: (message, fields) => logs.push({ level: 'warn', message, fields }),
    error: (message, fields) => logs.push({ level: 'error', message, fields }),
  };
  const provider = awsProvider({ fetch: emu.fetch, credentials: emu.ambient });
  const config = {
    ...(awsConfig.parse({ region: 'us-east-1', zones: ['us-east-1a', 'us-east-1b'] }) as AwsConfig),
    ...overrides,
  };
  const impl = (await provider.create(config, {
    clock: emu.clock,
    log,
    secrets: { resolve: async () => '' },
    account: { id: 'pa_platform', tenantId: 'root', platform: true },
  })) as AwsCompute;
  const call = (key = 'net_1'): CallContext => ({
    idempotencyKey: key,
    signal: new AbortController().signal,
    clock: emu.clock,
    secrets: { resolve: async () => '' },
    log: quiet,
  });
  const networks = impl.networks as ProviderNetworks;
  /** Calls `ensure` until it is no longer pending (at most 10 times). */
  const settle = async (ensure: () => Promise<{ state: string; message?: string }>) => {
    let result = await ensure();
    for (let n = 0; n < 10 && result.state === 'pending'; n++) result = await ensure();
    return result;
  };
  return { emu, ec2, vpc, impl, networks, call, settle, logs };
}

describe('networks: VPC', () => {
  it('declares zone-scoped subnets and network-wide denies', async () => {
    const { networks } = await world();
    expect(networks.subnetScope).toBe('zone');
    expect(networks.denyRules).toBe('network-wide');
  });

  it('creates a VPC with an internet gateway and a default route', async () => {
    const { networks, vpc, call, settle } = await world();
    const ready = await settle(() => networks.ensureNetwork({ name: 'bc-net-1' }, call()));
    expect(ready.state).toBe('ready');
    const made = vpc.vpcByName('bc-net-1')!;
    expect(made.cidrs.map((block) => block.cidr)).toEqual(['10.64.0.0/16']);
    expect(Object.fromEntries(made.tags)).toMatchObject({
      'better-compute:network': 'bc-net-1',
      'better-compute:managed': 'true',
      Name: 'bc-net-1',
    });
    expect(made.dnsSupport).toBe(true);
    expect(made.dnsHostnames).toBe(true);
    const igw = [...vpc.igws.values()].find((gateway) => gateway.vpcId === made.id)!;
    expect(igw.tags.get('better-compute:network')).toBe('bc-net-1');
    expect(vpc.mainRouteTable(made.id).routes).toContainEqual({
      destination: '0.0.0.0/0',
      gatewayId: igw.id,
    });
    // The default ACL's allow-all moves to the end, so deny entries can come before it.
    const entries = vpc.defaultNacl(made.id).entries.map((entry) => [entry.number, entry.egress]);
    expect(entries).toEqual([
      [32766, false],
      [32766, true],
    ]);
    expect(ready.id).toBe(made.id);
  });

  it('is idempotent: ensuring again creates nothing', async () => {
    const { networks, emu, call, settle } = await world();
    await settle(() => networks.ensureNetwork({ name: 'bc-net-1' }, call()));
    const before = emu.requests.length;
    expect((await networks.ensureNetwork({ name: 'bc-net-1' }, call())).state).toBe('ready');
    const writes = emu.requests.slice(before).filter((r) => !r.operation.startsWith('Describe'));
    expect(writes.map((r) => r.operation)).toEqual([]);
    expect(emu.calls('CreateVpc')).toHaveLength(1);
  });

  it('answers pending while the VPC is pending, then finishes', async () => {
    const { networks, vpc, call, settle } = await world();
    vpc.pendingVpcReads = 1;
    expect((await networks.ensureNetwork({ name: 'bc-net-1' }, call())).state).toBe('pending');
    expect((await networks.ensureNetwork({ name: 'bc-net-1' }, call())).state).toBe('pending');
    expect((await networks.ensureNetwork({ name: 'bc-net-1' }, call())).state).toBe('ready');
  });

  it('uses the network cidr and refuses a public or oversized one', async () => {
    const { networks, vpc, call, settle } = await world();
    await settle(() => networks.ensureNetwork({ name: 'bc-net-2', cidr: '172.20.0.0/16' }, call()));
    expect(vpc.vpcByName('bc-net-2')!.cidrs[0]!.cidr).toBe('172.20.0.0/16');
    await expect(
      networks.ensureNetwork({ name: 'bc-net-3', cidr: '8.8.0.0/16' }, call()),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      networks.ensureNetwork({ name: 'bc-net-3', cidr: '10.0.0.0/8' }, call()),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('refuses a name that is neither a better-compute name nor a VPC id', async () => {
    const { networks, call } = await world();
    await expect(networks.ensureNetwork({ name: 'Bad Name' }, call())).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('reattaches its own detached gateway instead of making another', async () => {
    const { networks, vpc, emu, call, settle } = await world();
    await settle(() => networks.ensureNetwork({ name: 'bc-net-1' }, call()));
    const igw = [...vpc.igws.values()][0]!;
    expect(igw.vpcId).toBeDefined();
    delete igw.vpcId;
    expect((await networks.ensureNetwork({ name: 'bc-net-1' }, call())).state).toBe('ready');
    expect(emu.calls('CreateInternetGateway')).toHaveLength(1);
    expect(igw.vpcId).toBe(vpc.vpcByName('bc-net-1')!.id);
  });

  it('deletes the gateway and the VPC, and waits on what still uses it', async () => {
    const { networks, vpc, ec2, call, settle } = await world();
    await settle(() => networks.ensureNetwork({ name: 'bc-net-1' }, call()));
    const made = vpc.vpcByName('bc-net-1')!;
    // A subnet with a running instance in it blocks the delete.
    await networks.ensureSubnet(
      { network: 'bc-net-1', name: 'bc-sub-1', region: 'us-east-1', cidr: '10.64.1.0/24', zone: 'us-east-1a' },
      call(),
    );
    const subnet = [...vpc.subnets.values()][0]!;
    const instance = ec2.addInstance();
    instance.subnetId = subnet.id;
    instance.vpcId = made.id;
    const blocked = await networks.deleteNetwork('bc-net-1', call());
    expect(blocked.state).toBe('pending');
    expect(blocked.message).toMatch(/DependencyViolation|in use/);
    expect(vpc.vpcs.has(made.id)).toBe(true);
    instance.state = 'terminated';
    expect((await networks.deleteNetwork('bc-net-1', call())).state).toBe('deleted');
    expect(vpc.vpcs.has(made.id)).toBe(false);
    expect(vpc.igws.size).toBe(0);
    expect((await networks.deleteNetwork('bc-net-1', call())).state).toBe('deleted');
  });

  it('never deletes a VPC it did not make', async () => {
    const { networks, vpc, emu, call, settle } = await world();
    const { vpc: foreign } = vpc.addForeignVpc();
    expect((await networks.deleteNetwork(foreign.id, call())).state).toBe('deleted');
    expect(vpc.vpcs.has(foreign.id)).toBe(true);
    expect(emu.calls('DeleteVpc')).toHaveLength(0);
  });
});

describe('networks: subnets', () => {
  const subnet = (overrides: Record<string, unknown> = {}) =>
    ({
      network: 'bc-net-1',
      name: 'bc-sub-1',
      region: 'us-east-1',
      cidr: '10.64.1.0/24',
      zone: 'us-east-1b',
      ...overrides,
    }) as ProviderSubnetSpec;

  async function withNetwork(overrides: Partial<AwsConfig> = {}) {
    const w = await world(overrides);
    await w.settle(() => w.networks.ensureNetwork({ name: 'bc-net-1' }, w.call()));
    return w;
  }

  it('zone-scoped subnet lands in its AZ and adds a secondary CIDR when needed', async () => {
    const { networks, vpc, emu, call, settle } = await withNetwork();
    const ready = await networks.ensureSubnet(subnet(), call());
    expect(ready.state).toBe('ready');
    const made = vpc.subnets.get(ready.id)!;
    expect(made).toMatchObject({ cidr: '10.64.1.0/24', zone: 'us-east-1b', mapPublicIp: true });
    expect(Object.fromEntries(made.tags)).toMatchObject({
      'better-compute:network': 'bc-net-1',
      'better-compute:subnet': 'bc-sub-1',
      'better-compute:managed': 'true',
      Name: 'bc-sub-1',
    });
    // Outside 10.64.0.0/16: the subnet's /16 becomes a secondary range of the VPC first.
    const second = subnet({ name: 'bc-sub-2', cidr: '10.65.2.0/24', zone: 'us-east-1a' });
    expect((await networks.ensureSubnet(second, call())).state).toBe('pending');
    expect(emu.calls('AssociateVpcCidrBlock')[0]!.params.get('CidrBlock')).toBe('10.65.0.0/16');
    expect((await settle(() => networks.ensureSubnet(second, call()))).state).toBe('ready');
    expect(vpc.vpcByName('bc-net-1')!.cidrs.map((b) => b.cidr)).toEqual([
      '10.64.0.0/16',
      '10.65.0.0/16',
    ]);
    expect(emu.calls('AssociateVpcCidrBlock')).toHaveLength(1);
    // Ensuring again only reads.
    const before = emu.requests.length;
    expect((await networks.ensureSubnet(subnet(), call())).state).toBe('ready');
    expect(emu.requests.slice(before).every((r) => r.operation.startsWith('Describe'))).toBe(true);
  });

  it('waits while a new range is still associating', async () => {
    const { networks, vpc, call } = await withNetwork();
    vpc.associating = 2;
    const spec = subnet({ cidr: '10.70.0.0/24' });
    expect((await networks.ensureSubnet(spec, call())).state).toBe('pending');
    expect((await networks.ensureSubnet(spec, call())).state).toBe('pending');
    expect((await networks.ensureSubnet(spec, call())).state).toBe('ready');
  });

  it('uses the range itself when its /16 overlaps a VPC range', async () => {
    const { networks, emu, call, settle } = await world();
    await settle(() => networks.ensureNetwork({ name: 'bc-net-1', cidr: '10.64.0.0/20' }, call()));
    const spec = subnet({ cidr: '10.64.128.0/24' });
    expect((await settle(() => networks.ensureSubnet(spec, call()))).state).toBe('ready');
    expect(emu.calls('AssociateVpcCidrBlock')[0]!.params.get('CidrBlock')).toBe('10.64.128.0/24');
  });

  it('refuses a subnet without a zone, outside the account, or of a size or range AWS does not take', async () => {
    const { networks, call } = await withNetwork();
    const refused = (spec: Record<string, unknown>, reason: string) =>
      expect(networks.ensureSubnet(subnet(spec), call())).rejects.toMatchObject({
        code: 'INVALID_INPUT',
        details: { reason },
      });
    await refused({ zone: undefined }, 'zone-required');
    await refused({ zone: 'us-east-1c' }, 'zone');
    await refused({ region: 'us-west-2' }, 'region');
    await refused({ cidr: '10.64.1.0/29' }, 'cidr-size');
    await refused({ cidr: '9.9.9.0/24' }, 'cidr-range');
    await refused({ cidr: '10.64.1.7/24' }, 'cidr');
  });

  it('reports a subnet that exists with another range, and a range someone else holds', async () => {
    const { networks, vpc, call } = await withNetwork();
    await networks.ensureSubnet(subnet(), call());
    const moved = await networks.ensureSubnet(subnet({ cidr: '10.64.9.0/24' }), call());
    expect(moved).toMatchObject({
      state: 'error',
      message: expect.stringMatching(/exists as 10\.64\.1\.0\/24/),
    });
    const vpcId = vpc.vpcByName('bc-net-1')!.id;
    vpc.subnets.set('subnet-00000000000000f00', {
      id: 'subnet-00000000000000f00',
      vpcId,
      cidr: '10.64.5.0/24',
      zone: 'us-east-1a',
      mapPublicIp: false,
      tags: new Map(),
    });
    const taken = await networks.ensureSubnet(
      subnet({ name: 'bc-sub-5', cidr: '10.64.5.0/24' }),
      call(),
    );
    expect(taken).toMatchObject({ state: 'error', message: expect.stringMatching(/did not make/) });
  });

  it('keeps public IPs off when the account says so', async () => {
    const { networks, vpc, call } = await withNetwork({ associatePublicIp: false });
    const ready = await networks.ensureSubnet(subnet(), call());
    expect(vpc.subnets.get(ready.id)!.mapPublicIp).toBe(false);
  });

  it('private service access adds S3 and DynamoDB gateway endpoints once', async () => {
    const { networks, vpc, emu, call } = await withNetwork();
    await networks.ensureSubnet(subnet({ privateGoogleAccess: true }), call());
    await networks.ensureSubnet(
      subnet({ name: 'bc-sub-2', cidr: '10.64.2.0/24', privateGoogleAccess: true }),
      call(),
    );
    const vpcId = vpc.vpcByName('bc-net-1')!.id;
    const endpoints = [...vpc.endpoints.values()];
    expect(endpoints.map((e) => e.service).sort()).toEqual([
      'com.amazonaws.us-east-1.dynamodb',
      'com.amazonaws.us-east-1.s3',
    ]);
    expect(endpoints.every((e) => e.routeTableIds[0] === vpc.mainRouteTable(vpcId).id)).toBe(true);
    expect(endpoints.every((e) => e.tags.get('better-compute:network') === 'bc-net-1')).toBe(true);
    expect(emu.calls('CreateVpcEndpoint')).toHaveLength(2);
    // The network's delete removes them before the VPC.
    await networks.deleteSubnet('us-east-1', 'bc-sub-1', call());
    await networks.deleteSubnet('us-east-1', 'bc-sub-2', call());
    expect((await networks.deleteNetwork('bc-net-1', call())).state).toBe('deleted');
    expect(vpc.endpoints.size).toBe(0);
    const order = emu.requests.map((r) => r.operation);
    expect(order.indexOf('DeleteVpcEndpoints')).toBeLessThan(order.indexOf('DeleteVpc'));
  });

  it('deleteSubnet waits while an instance uses it, then deletes it', async () => {
    const { networks, vpc, ec2, call } = await withNetwork();
    const ready = await networks.ensureSubnet(subnet(), call());
    const instance = ec2.addInstance();
    instance.subnetId = ready.id;
    const blocked = await networks.deleteSubnet('us-east-1', 'bc-sub-1', call());
    expect(blocked).toMatchObject({ state: 'pending', message: expect.stringMatching(/in use/) });
    instance.state = 'terminated';
    expect((await networks.deleteSubnet('us-east-1', 'bc-sub-1', call())).state).toBe('deleted');
    expect(vpc.subnets.has(ready.id)).toBe(false);
    expect((await networks.deleteSubnet('us-east-1', 'bc-sub-1', call())).state).toBe('deleted');
    expect((await networks.deleteSubnet('us-west-2', 'bc-sub-1', call())).state).toBe('deleted');
  });

  it('waits for its network before making a subnet', async () => {
    const { networks, call } = await world();
    expect(await networks.ensureSubnet(subnet(), call())).toMatchObject({
      state: 'pending',
      message: expect.stringMatching(/Waiting for network/),
    });
  });
});
