import { describe, expect, it } from 'vitest';
import type {
  CallContext,
  Logger,
  ProviderFirewallSpec,
  ProviderNetworks,
  ProviderSubnetSpec,
} from '@better-compute/core';
import {
  awsConfig,
  awsProvider,
  awsIamPolicyCommand,
  iamPolicy,
  type AwsCompute,
  type AwsConfig,
} from '@better-compute/provider-aws';
import { AwsEmulator } from './support/aws-emulator/index.js';
import { Ec2Emulator } from './support/aws-emulator/ec2.js';
import { VpcEmulator } from './support/aws-emulator/vpc.js';

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/** An emulated platform account in us-east-1 with EC2 and VPC, and its provider client. */
async function world(
  overrides: Partial<AwsConfig> = {},
  options: { wrapFetch?: (inner: typeof fetch) => typeof fetch } = {},
) {
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
  const provider = awsProvider({
    fetch: options.wrapFetch ? options.wrapFetch(emu.fetch) : emu.fetch,
    credentials: emu.ambient,
  });
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
    // Tagged before its route changes, so the IAM policy can scope route edits to it.
    expect(vpc.mainRouteTable(made.id).tags.get('better-compute:network')).toBe('bc-net-1');
    expect(vpc.defaultNacl(made.id).tags.get('better-compute:network')).toBe('bc-net-1');
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
      {
        network: 'bc-net-1',
        name: 'bc-sub-1',
        region: 'us-east-1',
        cidr: '10.64.1.0/24',
        zone: 'us-east-1a',
      },
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

  it('deleteNetwork right after ensureNetwork waits for the new VPC and deletes it', async () => {
    const { networks, vpc, call } = await world();
    // Tag-filtered reads do not show the new VPC yet.
    vpc.tagLagReads = 5;
    expect((await networks.ensureNetwork({ name: 'bc-net-1' }, call())).state).toBe('pending');
    const made = vpc.vpcByName('bc-net-1')!;
    const gone = await networks.deleteNetwork('bc-net-1', call());
    expect(gone.state).toBe('deleted');
    expect(vpc.vpcs.has(made.id)).toBe(false);
  });

  it('deleteNetwork finds a VPC the tag read hides, even after it got its gateway', async () => {
    const { networks, vpc, call, settle } = await world();
    await settle(() => networks.ensureNetwork({ name: 'bc-net-1' }, call()));
    const made = vpc.vpcByName('bc-net-1')!;
    made.tagHiddenReads = 5;
    let result = await networks.deleteNetwork('bc-net-1', call());
    for (let n = 0; n < 5 && result.state === 'pending'; n++)
      result = await networks.deleteNetwork('bc-net-1', call());
    expect(result.state).toBe('deleted');
    expect(vpc.vpcs.has(made.id)).toBe(false);
    expect(vpc.igws.size).toBe(0);
  });

  it('a just-created VPC no read shows yet is waited for, then given up after the window', async () => {
    const { networks, vpc, emu, call } = await world();
    vpc.tagLagReads = 100;
    await networks.ensureNetwork({ name: 'bc-net-1' }, call());
    const made = vpc.vpcByName('bc-net-1')!;
    // Gone by hand (or never shown): a read by id finds nothing either.
    vpc.vpcs.delete(made.id);
    const waiting = await networks.deleteNetwork('bc-net-1', call());
    expect(waiting).toMatchObject({ state: 'pending', id: made.id });
    emu.clock.advance(121_000);
    expect((await networks.deleteNetwork('bc-net-1', call())).state).toBe('deleted');
  });

  it('a CreateVpc whose answer was lost is found again by range, not made twice', async () => {
    let lose = 1;
    const { networks, vpc, emu, call, settle } = await world(
      {},
      {
        wrapFetch: (inner) => async (input, init) => {
          const response = await inner(input, init);
          if (String(init?.body ?? '').includes('Action=CreateVpc') && lose-- > 0)
            throw new TypeError('fetch failed: socket hang up');
          return response;
        },
      },
    );
    vpc.tagLagReads = 5;
    await expect(networks.ensureNetwork({ name: 'bc-net-1' }, call())).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
    expect(vpc.vpcs.size).toBe(1);
    // Another tenant network on the same range is never taken for this one.
    await settle(() => networks.ensureNetwork({ name: 'bc-net-2' }, call()));
    expect((await settle(() => networks.ensureNetwork({ name: 'bc-net-1' }, call()))).state).toBe(
      'ready',
    );
    expect(emu.calls('CreateVpc')).toHaveLength(2);
    expect(vpc.vpcs.size).toBe(2);
  });

  it('of two VPCs with the same network tag, the one with the gateway is used', async () => {
    const { networks, vpc, emu, call, settle } = await world();
    await settle(() => networks.ensureNetwork({ name: 'bc-net-1' }, call()));
    const first = vpc.vpcByName('bc-net-1')!;
    // A duplicate with a lower id (another process inside the tag lag), still empty.
    const { vpc: duplicate, subnet } = vpc.addForeignVpc('10.64.0.0/16');
    vpc.subnets.delete(subnet.id);
    duplicate.tags.set('better-compute:network', 'bc-net-1');
    duplicate.tags.set('better-compute:managed', 'true');
    vpc.vpcs.delete(duplicate.id);
    const lower = { ...duplicate, id: 'vpc-00000000000000001' };
    vpc.vpcs.set(lower.id, lower);
    for (const owned of [
      ...vpc.routeTables.values(),
      ...vpc.nacls.values(),
      ...vpc.groups.values(),
    ])
      if (owned.vpcId === duplicate.id) owned.vpcId = lower.id;
    const ensured = await networks.ensureNetwork({ name: 'bc-net-1' }, call());
    expect(ensured).toMatchObject({ state: 'ready', id: first.id });
    expect(emu.calls('CreateInternetGateway')).toHaveLength(1);
  });

  it('ensureNetwork rides out the tag lag without making a second VPC', async () => {
    const { networks, vpc, emu, call, settle } = await world();
    vpc.tagLagReads = 3;
    expect((await settle(() => networks.ensureNetwork({ name: 'bc-net-1' }, call()))).state).toBe(
      'ready',
    );
    expect(emu.calls('CreateVpc')).toHaveLength(1);
    expect(vpc.vpcs.size).toBe(1);
  });

  it('a delete blocked by a subnet in use leaves the gateway and route alone', async () => {
    const { networks, vpc, ec2, emu, call, settle } = await world();
    await settle(() => networks.ensureNetwork({ name: 'bc-net-1' }, call()));
    const made = vpc.vpcByName('bc-net-1')!;
    await networks.ensureSubnet(
      {
        network: 'bc-net-1',
        name: 'bc-sub-1',
        region: 'us-east-1',
        cidr: '10.64.1.0/24',
        zone: 'us-east-1a',
      },
      call(),
    );
    const subnet = [...vpc.subnets.values()][0]!;
    const instance = ec2.addInstance();
    instance.subnetId = subnet.id;
    instance.vpcId = made.id;
    const before = emu.requests.length;
    expect((await networks.deleteNetwork('bc-net-1', call())).state).toBe('pending');
    // The machine still running there keeps its internet gateway.
    const igw = [...vpc.igws.values()][0]!;
    expect(igw.vpcId).toBe(made.id);
    const ops = emu.requests.slice(before).map((r) => r.operation);
    expect(ops).not.toContain('DetachInternetGateway');
    expect(ops).not.toContain('DeleteVpc');
    instance.state = 'terminated';
    expect((await networks.deleteNetwork('bc-net-1', call())).state).toBe('deleted');
    // In order: subnets, then groups, then the gateway, then the VPC.
    const order = emu.requests
      .map((r) => r.operation)
      .filter((op) =>
        ['DeleteSubnet', 'DeleteSecurityGroup', 'DetachInternetGateway', 'DeleteVpc'].includes(op),
      );
    const last = (op: string) => order.lastIndexOf(op);
    expect(last('DeleteSubnet')).toBeLessThan(last('DetachInternetGateway'));
    expect(last('DetachInternetGateway')).toBeLessThan(last('DeleteVpc'));
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

  it('deleteSubnet never deletes a subnet it did not make', async () => {
    const { networks, vpc, emu, call } = await withNetwork();
    // Tagged with the subnet key by someone else: in an adopted VPC, and one without the
    // managed tag or the network tag.
    const { subnet: foreign } = vpc.addForeignVpc();
    foreign.tags.set('better-compute:subnet', 'bc-sub-1');
    const { subnet: half } = vpc.addForeignVpc('172.30.0.0/16');
    half.tags.set('better-compute:subnet', 'bc-sub-1');
    half.tags.set('better-compute:managed', 'true');
    expect((await networks.deleteSubnet('us-east-1', 'bc-sub-1', call())).state).toBe('deleted');
    expect(vpc.subnets.has(foreign.id)).toBe(true);
    expect(vpc.subnets.has(half.id)).toBe(true);
    expect(emu.calls('DeleteSubnet')).toHaveLength(0);
  });

  it('waits for its network before making a subnet', async () => {
    const { networks, call } = await world();
    expect(await networks.ensureSubnet(subnet(), call())).toMatchObject({
      state: 'pending',
      message: expect.stringMatching(/Waiting for network/),
    });
  });
});

describe('networks: firewall', () => {
  const tagA = 'bc-0123456789abcdef';
  const tagB = 'bc-fedcba9876543210';
  const rule = (overrides: Partial<ProviderFirewallSpec> = {}): ProviderFirewallSpec => ({
    network: 'bc-net-1',
    name: 'bc-fw-1',
    direction: 'ingress',
    action: 'allow',
    priority: 1000,
    rules: [{ protocol: 'tcp', ports: ['22', '8000-8080'] }],
    sources: ['203.0.113.0/24'],
    ...overrides,
  });

  async function withNetwork() {
    const w = await world();
    await w.settle(() => w.networks.ensureNetwork({ name: 'bc-net-1' }, w.call()));
    const vpcId = w.vpc.vpcByName('bc-net-1')!.id;
    const group = (name: string) =>
      [...w.vpc.groups.values()].find((g) => g.vpcId === vpcId && g.name === name);
    const rulesOf = (firewall: string) =>
      [...w.vpc.rules.values()]
        .filter((r) => r.tags.has(`better-compute:firewall:${firewall}`))
        .map((r) => ({
          group: w.vpc.groups.get(r.groupId)!.name,
          egress: r.egress,
          protocol: r.protocol,
          from: r.from,
          to: r.to,
          cidr: r.cidrIpv4 ?? r.cidrIpv6,
        }))
        .sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
    return { ...w, vpcId, group, rulesOf };
  }

  it('targeted allow rules land on the per-instance security group, tagged by firewall', async () => {
    const { networks, call, group, rulesOf, vpc } = await withNetwork();
    const ready = await networks.ensureFirewall(rule({ targetTags: [tagA] }), call());
    expect(ready.state).toBe('ready');
    const sg = group(tagA)!;
    expect(Object.fromEntries(sg.tags)).toMatchObject({
      'better-compute:tag': tagA,
      'better-compute:network': 'bc-net-1',
      'better-compute:managed': 'true',
    });
    expect(rulesOf('bc-fw-1')).toEqual([
      { group: tagA, egress: false, protocol: 'tcp', from: 22, to: 22, cidr: '203.0.113.0/24' },
      { group: tagA, egress: false, protocol: 'tcp', from: 8000, to: 8080, cidr: '203.0.113.0/24' },
    ]);
    const tagged = [...vpc.rules.values()].filter((r) =>
      r.tags.has('better-compute:firewall:bc-fw-1'),
    );
    expect(tagged.every((r) => r.tags.get('better-compute:network') === 'bc-net-1')).toBe(true);
  });

  it('untargeted allow rules land on the network security group', async () => {
    const { networks, call, rulesOf, group } = await withNetwork();
    await networks.ensureFirewall(
      rule({ rules: [{ protocol: 'all' }], sources: undefined }),
      call(),
    );
    expect(group('bc-net-bc-net-1')).toBeDefined();
    expect(rulesOf('bc-fw-1')).toEqual([
      {
        group: 'bc-net-bc-net-1',
        egress: false,
        protocol: '-1',
        from: -1,
        to: -1,
        cidr: '0.0.0.0/0',
      },
    ]);
  });

  it('a changed rule revokes what it no longer wants by rule id and keeps the rest', async () => {
    const { networks, call, rulesOf, emu } = await withNetwork();
    await networks.ensureFirewall(rule({ targetTags: [tagA] }), call());
    const authorized = emu.calls('AuthorizeSecurityGroupIngress').length;
    await networks.ensureFirewall(
      rule({ targetTags: [tagA], rules: [{ protocol: 'tcp', ports: ['22', '443'] }] }),
      call(),
    );
    expect(rulesOf('bc-fw-1').map((r) => `${r.from}-${r.to}`)).toEqual(['22-22', '443-443']);
    const revoke = emu.calls('RevokeSecurityGroupIngress');
    expect(revoke).toHaveLength(1);
    expect(revoke[0]!.params.get('SecurityGroupRuleId.1')).toMatch(/^sgr-/);
    const added = emu.calls('AuthorizeSecurityGroupIngress').slice(authorized);
    expect(added).toHaveLength(1);
    expect(added[0]!.params.get('IpPermissions.1.FromPort')).toBe('443');
    expect(added[0]!.params.has('IpPermissions.2.FromPort')).toBe(false);
  });

  it('retargeting moves the rules between groups, and a disabled rule has none', async () => {
    const { networks, call, rulesOf } = await withNetwork();
    await networks.ensureFirewall(rule({ targetTags: [tagA] }), call());
    await networks.ensureFirewall(rule({ targetTags: [tagB] }), call());
    expect(new Set(rulesOf('bc-fw-1').map((r) => r.group))).toEqual(new Set([tagB]));
    await networks.ensureFirewall(rule({ targetTags: [tagB], disabled: true }), call());
    expect(rulesOf('bc-fw-1')).toEqual([]);
  });

  it('egress, IPv6 and ICMP rules', async () => {
    const { networks, call, rulesOf } = await withNetwork();
    await networks.ensureFirewall(
      rule({
        direction: 'egress',
        sources: undefined,
        destinations: ['2001:db8::/32', '198.51.100.0/24'],
        rules: [{ protocol: 'icmp' }, { protocol: 'udp' }],
      }),
      call(),
    );
    expect(rulesOf('bc-fw-1')).toEqual([
      {
        group: 'bc-net-bc-net-1',
        egress: true,
        protocol: 'icmp',
        from: -1,
        to: -1,
        cidr: '198.51.100.0/24',
      },
      {
        group: 'bc-net-bc-net-1',
        egress: true,
        protocol: 'icmp',
        from: -1,
        to: -1,
        cidr: '2001:db8::/32',
      },
      {
        group: 'bc-net-bc-net-1',
        egress: true,
        protocol: 'udp',
        from: 0,
        to: 65535,
        cidr: '198.51.100.0/24',
      },
      {
        group: 'bc-net-bc-net-1',
        egress: true,
        protocol: 'udp',
        from: 0,
        to: 65535,
        cidr: '2001:db8::/32',
      },
    ]);
  });

  it('two firewalls wanting the same rule share it; the last one out revokes it', async () => {
    const { networks, call, vpc } = await withNetwork();
    await networks.ensureFirewall(rule({ name: 'bc-fw-a', targetTags: [tagA] }), call());
    await networks.ensureFirewall(rule({ name: 'bc-fw-b', targetTags: [tagA] }), call());
    const shared = [...vpc.rules.values()].filter((r) =>
      r.tags.has('better-compute:firewall:bc-fw-a'),
    );
    expect(shared).toHaveLength(2);
    expect(shared.every((r) => r.tags.has('better-compute:firewall:bc-fw-b'))).toBe(true);
    expect((await networks.deleteFirewall('bc-fw-a', call())).state).toBe('deleted');
    expect(shared.every((r) => vpc.rules.has(r.id))).toBe(true);
    expect(shared.some((r) => r.tags.has('better-compute:firewall:bc-fw-a'))).toBe(false);
    expect((await networks.deleteFirewall('bc-fw-b', call())).state).toBe('deleted');
    expect(shared.some((r) => vpc.rules.has(r.id))).toBe(false);
  });

  it('never revokes a rule better-compute did not make', async () => {
    const { networks, call, vpc, emu } = await withNetwork();
    await networks.ensureFirewall(rule({ targetTags: [tagA], disabled: true }), call());
    const sg = [...vpc.groups.values()].find((g) => g.name === tagA)!;
    vpc.rules.set('sgr-0000000000000beef', {
      id: 'sgr-0000000000000beef',
      groupId: sg.id,
      egress: false,
      protocol: 'tcp',
      from: 22,
      to: 22,
      cidrIpv4: '203.0.113.0/24',
      tags: new Map(),
    });
    await networks.ensureFirewall(rule({ targetTags: [tagA] }), call());
    expect(
      vpc.rules.get('sgr-0000000000000beef')!.tags.get('better-compute:firewall:bc-fw-1'),
    ).toBe('true');
    await networks.deleteFirewall('bc-fw-1', call());
    expect(vpc.rules.get('sgr-0000000000000beef')!.tags.size).toBe(0);
    const revoked = emu
      .calls('RevokeSecurityGroupIngress')
      .map((r) => r.params.get('SecurityGroupRuleId.1'));
    expect(revoked).not.toContain('sgr-0000000000000beef');
  });

  it('refuses a targeted deny and a rule that filters the other side', async () => {
    const { networks, call } = await withNetwork();
    expect(
      await networks.ensureFirewall(rule({ action: 'deny', targetTags: [tagA] }), call()),
    ).toMatchObject({
      state: 'error',
      message: expect.stringMatching(/network-wide/),
    });
    expect(
      await networks.ensureFirewall(rule({ destinations: ['10.64.0.0/16'] }), call()),
    ).toMatchObject({
      state: 'error',
    });
    await expect(
      networks.ensureFirewall(rule({ targetTags: ['Not A Tag'] }), call()),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(
      networks.ensureFirewall(rule({ rules: [{ protocol: 'tcp', ports: ['80-22'] }] }), call()),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('network-wide deny compiles to NACL entries in priority order', async () => {
    const { networks, call, vpc, vpcId } = await withNetwork();
    const deny = (overrides: Partial<ProviderFirewallSpec>) =>
      rule({
        action: 'deny',
        rules: [{ protocol: 'tcp', ports: ['22'] }],
        sources: ['0.0.0.0/0'],
        ...overrides,
      });
    expect(
      (await networks.ensureFirewall(deny({ name: 'bc-deny-late', priority: 500 }), call())).state,
    ).toBe('ready');
    await networks.ensureFirewall(
      deny({ name: 'bc-deny-early', priority: 100, rules: [{ protocol: 'all' }] }),
      call(),
    );
    // Same priority as the first: the next free number.
    await networks.ensureFirewall(
      deny({ name: 'bc-deny-same', priority: 509, rules: [{ protocol: 'udp', ports: ['53'] }] }),
      call(),
    );
    const acl = vpc.defaultNacl(vpcId);
    expect(
      acl.entries.map((e) => [e.number, e.egress, e.protocol, e.action, e.from, e.to]),
    ).toEqual([
      [110, false, '-1', 'deny', undefined, undefined],
      [150, false, '6', 'deny', 22, 22],
      [151, false, '17', 'deny', 53, 53],
      [32766, false, '-1', 'allow', undefined, undefined],
      [32766, true, '-1', 'allow', undefined, undefined],
    ]);
    expect(acl.tags.get('better-compute:deny:ingress:150')).toBe('bc-deny-late');
    expect(acl.tags.get('better-compute:deny:ingress:110')).toBe('bc-deny-early');
    expect(acl.tags.get('better-compute:deny:ingress:151')).toBe('bc-deny-same');
    // Ensuring again changes nothing; a changed deny replaces only its own entries.
    await networks.ensureFirewall(deny({ name: 'bc-deny-late', priority: 500 }), call());
    expect(acl.entries).toHaveLength(5);
    await networks.ensureFirewall(
      deny({ name: 'bc-deny-late', priority: 500, rules: [{ protocol: 'tcp', ports: ['23'] }] }),
      call(),
    );
    expect(acl.entries.find((e) => e.number === 150)).toMatchObject({ from: 23, to: 23 });
    // Delete removes the entry and its owner tag.
    expect((await networks.deleteFirewall('bc-deny-late', call())).state).toBe('deleted');
    expect(acl.entries.some((e) => e.number === 150)).toBe(false);
    expect(acl.tags.has('better-compute:deny:ingress:150')).toBe(false);
    expect(acl.tags.get('better-compute:deny:ingress:110')).toBe('bc-deny-early');
  });

  it('repairs an owner tag whose entry is gone, and reports a full ACL', async () => {
    const { networks, call, vpc, vpcId } = await withNetwork();
    const deny = rule({
      action: 'deny',
      name: 'bc-deny-1',
      priority: 0,
      rules: [{ protocol: 'all' }],
    });
    await networks.ensureFirewall(deny, call());
    const acl = vpc.defaultNacl(vpcId);
    acl.entries = acl.entries.filter((e) => e.number !== 100);
    expect((await networks.ensureFirewall(deny, call())).state).toBe('ready');
    expect(acl.entries.some((e) => e.number === 100 && e.action === 'deny')).toBe(true);
    vpc.naclEntryLimit = 2;
    const full = await networks.ensureFirewall(
      rule({ action: 'deny', name: 'bc-deny-2', priority: 10, rules: [{ protocol: 'all' }] }),
      call(),
    );
    expect(full).toMatchObject({
      state: 'error',
      message: expect.stringMatching(/NetworkAclEntryLimitExceeded/),
    });
    expect([...acl.tags.keys()].filter((k) => k.startsWith('better-compute:deny:'))).toEqual([
      'better-compute:deny:ingress:100',
    ]);
  });

  it('a deny on an adopted VPC is an error, never an ACL edit', async () => {
    const { networks, call, vpc, emu } = await withNetwork();
    const { vpc: foreign } = vpc.addForeignVpc();
    const denied = await networks.ensureFirewall(
      rule({ network: foreign.id, action: 'deny', rules: [{ protocol: 'all' }] }),
      call(),
    );
    expect(denied).toMatchObject({ state: 'error', message: expect.stringMatching(/adopted/) });
    expect(emu.calls('CreateNetworkAclEntry').length).toBe(2);
  });
});

describe('networks: machines', () => {
  const tagA = 'bc-0123456789abcdef';
  const tagB = 'bc-fedcba9876543210';

  async function onNetwork(overrides: Partial<AwsConfig> = {}) {
    const w = await world(overrides);
    await w.settle(() => w.networks.ensureNetwork({ name: 'bc-net-1' }, w.call()));
    const subnet = await w.networks.ensureSubnet(
      {
        network: 'bc-net-1',
        name: 'bc-sub-1',
        region: 'us-east-1',
        cidr: '10.64.1.0/24',
        zone: 'us-east-1a',
      },
      w.call(),
    );
    const vpcId = w.vpc.vpcByName('bc-net-1')!.id;
    const groupId = (name: string) =>
      [...w.vpc.groups.values()].find((g) => g.vpcId === vpcId && g.name === name)?.id;
    const create = (
      key: string,
      network: Record<string, unknown> = {},
      offerId = 'us-east-1a/t3.micro',
    ) =>
      w.impl.create(
        {
          offerId,
          image: 'ubuntu-24.04',
          userData: '#cloud-config\n',
          name: `vm-${key}`,
          network: { network: 'bc-net-1', subnet: 'bc-sub-1', tags: [tagA], ...network },
        },
        w.call(key),
      );
    return { ...w, subnetId: subnet.id, vpcId, groupId, create };
  }

  it('create launches into the network subnet with the network and tag groups', async () => {
    const { create, emu, ec2, subnetId, vpcId, groupId } = await onNetwork();
    const machine = await create('ins_1');
    const run = emu.calls('RunInstances')[0]!.params;
    expect(run.get('NetworkInterface.1.SubnetId')).toBe(subnetId);
    expect([
      run.get('NetworkInterface.1.SecurityGroupId.1'),
      run.get('NetworkInterface.1.SecurityGroupId.2'),
    ]).toEqual([groupId('bc-net-bc-net-1'), groupId(tagA)]);
    expect(run.has('SecurityGroupId.1')).toBe(false);
    const instance = ec2.instances.get(machine.id)!;
    expect(instance.vpcId).toBe(vpcId);
    expect(instance.groups.map((g) => g.name)).toEqual(['bc-net-bc-net-1', tagA]);
  });

  it('create refuses a subnet in another zone than the offer, and a network that is not there', async () => {
    const { create } = await onNetwork();
    await expect(create('ins_2', {}, 'us-east-1b/t3.micro')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      details: { reason: 'subnet-zone' },
    });
    await expect(create('ins_3', { network: 'bc-net-9' })).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    await expect(create('ins_4', { subnet: 'bc-sub-9' })).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
  });

  it('setTags swaps the better-compute groups and keeps every other group', async () => {
    const { create, networks, ec2, vpc, vpcId, groupId, call, emu } = await onNetwork();
    const machine = await create('ins_1');
    const instance = ec2.instances.get(machine.id)!;
    // A group the tenant added by hand, named like ours but not tagged as ours.
    vpc.groups.set('sg-0000000000000c0de', {
      id: 'sg-0000000000000c0de',
      vpcId,
      name: 'bc-mine',
      description: 'hand made',
      tags: new Map(),
    });
    instance.groups.push({ id: 'sg-0000000000000c0de', name: 'bc-mine' });
    await networks.setTags(machine.id, [tagB], call('ins_1'), 'ins_1');
    expect(instance.groups.map((g) => g.id)).toEqual([
      'sg-0000000000000c0de',
      groupId('bc-net-bc-net-1'),
      groupId(tagB),
    ]);
    // Current already: no write.
    const writes = emu.calls('ModifyInstanceAttribute').length;
    await networks.setTags(machine.id, [tagB], call('ins_1'), 'ins_1');
    expect(emu.calls('ModifyInstanceAttribute')).toHaveLength(writes);
  });

  it('setTags touches only machines of the instance', async () => {
    const { create, networks, ec2, call } = await onNetwork();
    const machine = await create('ins_1');
    await expect(networks.setTags(machine.id, [tagB], call(), 'ins_other')).rejects.toMatchObject({
      code: 'INVALID_STATE',
      details: { reason: 'notOwned' },
    });
    const foreign = ec2.addInstance();
    await expect(networks.setTags(foreign.id, [tagB], call())).rejects.toMatchObject({
      code: 'INVALID_STATE',
      details: { reason: 'notAttached' },
    });
    await expect(networks.setTags(machine.id, ['nope'], call())).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(networks.setTags('i-0000000000000dead', [tagB], call())).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('setTags refuses more groups than an interface takes', async () => {
    const { create, networks, call } = await onNetwork({ securityGroupsPerInterface: 2 });
    const machine = await create('ins_1');
    await expect(networks.setTags(machine.id, [tagA, tagB], call(), 'ins_1')).rejects.toMatchObject(
      {
        code: 'QUOTA_EXCEEDED',
        details: { reason: 'security-groups-per-interface', limit: 2 },
      },
    );
  });

  it('setTags on a multi-interface machine changes its primary interface, tagged at launch', async () => {
    const { create, networks, ec2, emu, groupId, call } = await onNetwork();
    const machine = await create('ins_1');
    const instance = ec2.instances.get(machine.id)!;
    // RunInstances tagged the interface with the ownership tag the IAM condition checks.
    expect(instance.eniTags.get('better-compute:instance')).toBe('ins_1');
    instance.interfaces = 2;
    await networks.setTags(machine.id, [tagB], call('ins_1'), 'ins_1');
    expect(emu.calls('ModifyNetworkInterfaceAttribute')).toHaveLength(1);
    expect(emu.calls('ModifyInstanceAttribute')).toHaveLength(0);
    expect(instance.groups.map((g) => g.id)).toEqual([groupId('bc-net-bc-net-1'), groupId(tagB)]);
    // Already carries the tag: no tag write on the interface.
    expect(
      emu.calls('CreateTags').filter((r) => r.params.get('ResourceId.1')?.startsWith('eni-')),
    ).toHaveLength(0);
  });

  it('setTags tags the primary interface of a claimed multi-interface machine before changing it', async () => {
    const { networks, ec2, emu, vpcId, subnetId, groupId, call } = await onNetwork();
    const claimed = ec2.addInstance({ tags: { 'better-compute:instance': 'ins_9' } });
    claimed.vpcId = vpcId;
    claimed.subnetId = subnetId;
    claimed.groups = [];
    claimed.interfaces = 2;
    await networks.setTags(claimed.id, [tagB], call('ins_9'), 'ins_9');
    expect(claimed.eniTags.get('better-compute:instance')).toBe('ins_9');
    const ops = emu.requests.map((r) => r.operation);
    expect(ops.lastIndexOf('CreateTags')).toBeLessThan(
      ops.lastIndexOf('ModifyNetworkInterfaceAttribute'),
    );
    expect(claimed.groups.map((g) => g.id)).toEqual([groupId('bc-net-bc-net-1'), groupId(tagB)]);
  });

  it('setTags checks the interface limit before it creates any group', async () => {
    const { create, networks, call, vpc } = await onNetwork({ securityGroupsPerInterface: 2 });
    const machine = await create('ins_1');
    const before = vpc.groups.size;
    await expect(
      networks.setTags(machine.id, [tagA, tagB, 'bc-1111111111111111'], call(), 'ins_1'),
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    expect(vpc.groups.size).toBe(before);
  });

  it('refuses a tag that would take a network group name (bc-net-…)', async () => {
    const { create, networks, call } = await onNetwork();
    const machine = await create('ins_1');
    await expect(
      networks.setTags(machine.id, ['bc-net-bc-net-1'], call(), 'ins_1'),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT', details: { reason: 'tag' } });
    await expect(
      networks.ensureFirewall(
        {
          network: 'bc-net-1',
          name: 'bc-fw-x',
          direction: 'ingress',
          action: 'allow',
          priority: 1000,
          rules: [{ protocol: 'tcp', ports: ['22'] }],
          targetTags: ['bc-net-bc-net-1'],
        },
        call(),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT', details: { reason: 'tag' } });
  });

  it('deleting an instance eventually removes its tag group; groups in use or targeted stay', async () => {
    const { create, networks, ec2, emu, call, groupId } = await onNetwork();
    const gone = await create('ins_1');
    const kept = await create('ins_2', { tags: [tagB] });
    // A firewall targets a third tag no machine carries: its group stays for the next one.
    const targeted = 'bc-2222222222222222';
    await networks.ensureFirewall(
      {
        network: 'bc-net-1',
        name: 'bc-fw-t',
        direction: 'ingress',
        action: 'allow',
        priority: 1000,
        rules: [{ protocol: 'tcp', ports: ['22'] }],
        targetTags: [targeted],
      },
      call(),
    );
    ec2.instances.get(gone.id)!.state = 'terminated';
    const sweep = async () => {
      emu.clock.advance(11 * 60_000);
      expect((await networks.ensureNetwork({ name: 'bc-net-1' }, call())).state).toBe('ready');
    };
    await sweep();
    // Seen unused once: not deleted yet (an instance being launched may not show yet).
    expect(groupId(tagA)).toBeDefined();
    await sweep();
    expect(groupId(tagA)).toBeUndefined();
    expect(groupId(tagB)).toBeDefined();
    expect(groupId(targeted)).toBeDefined();
    expect(groupId('bc-net-bc-net-1')).toBeDefined();
    expect(ec2.instances.get(kept.id)!.groups.map((g) => g.id)).toContain(groupId(tagB));
  });

  it('a tag group that is in use again by the second look is kept', async () => {
    const { create, networks, ec2, emu, call, groupId } = await onNetwork();
    const first = await create('ins_1');
    ec2.instances.get(first.id)!.state = 'terminated';
    emu.clock.advance(11 * 60_000);
    await networks.ensureNetwork({ name: 'bc-net-1' }, call());
    // Another machine took the tag meanwhile.
    await create('ins_3');
    emu.clock.advance(11 * 60_000);
    await networks.ensureNetwork({ name: 'bc-net-1' }, call());
    emu.clock.advance(11 * 60_000);
    await networks.ensureNetwork({ name: 'bc-net-1' }, call());
    expect(groupId(tagA)).toBeDefined();
  });

  it('tag groups of an adopted VPC are swept by setTags too', async () => {
    const w = await world();
    const { vpc: foreign, subnet } = w.vpc.addForeignVpc();
    const machine = w.ec2.addInstance({ tags: { 'better-compute:instance': 'ins_1' } });
    machine.vpcId = foreign.id;
    machine.subnetId = subnet.id;
    machine.groups = [];
    await w.networks.setTags(machine.id, [tagA], w.call('ins_1'), 'ins_1');
    const tagGroup = () =>
      [...w.vpc.groups.values()].find((g) => g.vpcId === foreign.id && g.name === tagA);
    expect(tagGroup()).toBeDefined();
    await w.networks.setTags(machine.id, [tagB], w.call('ins_1'), 'ins_1');
    for (let n = 0; n < 2; n++) {
      w.emu.clock.advance(11 * 60_000);
      await w.networks.setTags(machine.id, [tagB], w.call('ins_1'), 'ins_1');
    }
    expect(tagGroup()).toBeUndefined();
  });

  it('a firewall rule targeting a tag reaches the machine that carries it', async () => {
    const { create, networks, call, vpc, ec2 } = await onNetwork();
    const machine = await create('ins_1');
    await networks.ensureFirewall(
      {
        network: 'bc-net-1',
        name: 'bc-fw-ssh',
        direction: 'ingress',
        action: 'allow',
        priority: 1000,
        rules: [{ protocol: 'tcp', ports: ['22'] }],
        targetTags: [tagA],
      },
      call(),
    );
    const groups = new Set(ec2.instances.get(machine.id)!.groups.map((g) => g.id));
    const rules = [...vpc.rules.values()].filter((r) =>
      r.tags.has('better-compute:firewall:bc-fw-ssh'),
    );
    expect(rules).toHaveLength(1);
    expect(groups.has(rules[0]!.groupId)).toBe(true);
  });

  it('maps zones to regions, Local Zones included', async () => {
    const { impl } = await world();
    expect(impl.zoneRegion('us-east-1a')).toBe('us-east-1');
    expect(impl.zoneRegion('us-west-2-lax-1a')).toBe('us-west-2');
    expect(impl.zoneRegion('us-gov-west-1b')).toBe('us-gov-west-1');
    expect(impl.zoneRegion('not-a-zone')).toBe('not-a-zone');
  });

  it('network deletion waits on its security groups while machines use them', async () => {
    const { create, networks, ec2, call, vpc } = await onNetwork();
    const machine = await create('ins_1');
    const blocked = await networks.deleteNetwork('bc-net-1', call());
    expect(blocked.state).toBe('pending');
    ec2.instances.get(machine.id)!.state = 'terminated';
    expect((await networks.deleteNetwork('bc-net-1', call())).state).toBe('deleted');
    expect(vpc.groups.size).toBe(0);
  });
});

describe('networks: IAM policy', () => {
  it('adds the network statements only when asked, ABAC-scoped where AWS allows', () => {
    expect(iamPolicy().Statement.some((s) => s.Sid.startsWith('Network'))).toBe(false);
    const policy = iamPolicy({ networks: true, region: 'us-east-1', account: '222222222222' });
    const bySid = new Map(policy.Statement.map((s) => [s.Sid, s]));
    expect(bySid.get('NetworkCreateTagged')).toMatchObject({
      Condition: { StringEquals: { 'aws:RequestTag/better-compute:managed': 'true' } },
    });
    expect(bySid.get('NetworkManageOwned')).toMatchObject({
      Action: expect.arrayContaining(['ec2:DeleteVpc', 'ec2:RevokeSecurityGroupIngress']),
      Resource: expect.arrayContaining(['arn:aws:ec2:us-east-1:222222222222:vpc/*']),
      Condition: { StringEquals: { 'ec2:ResourceTag/better-compute:managed': 'true' } },
    });
    expect(bySid.get('NetworkMachineGroups')).toMatchObject({
      Condition: { Null: { 'ec2:ResourceTag/better-compute:instance': 'false' } },
    });
    expect(bySid.get('NetworkAclTags')).toMatchObject({
      Condition: {
        'ForAllValues:StringLike': {
          'aws:TagKeys': ['better-compute:network', 'better-compute:deny:*'],
        },
      },
    });
    // Routes and ACL entries change only on tables and ACLs of a better-compute network.
    const routes = bySid.get('NetworkRoutes')!;
    expect(routes).toMatchObject({
      Action: ['ec2:CreateRoute', 'ec2:ReplaceRoute'],
      Resource: 'arn:aws:ec2:us-east-1:222222222222:route-table/*',
      Condition: { Null: { 'ec2:ResourceTag/better-compute:network': 'false' } },
    });
    expect(bySid.get('NetworkAclEntries')).toMatchObject({
      Action: ['ec2:CreateNetworkAclEntry', 'ec2:DeleteNetworkAclEntry'],
      Resource: 'arn:aws:ec2:us-east-1:222222222222:network-acl/*',
      Condition: { Null: { 'ec2:ResourceTag/better-compute:network': 'false' } },
    });
    expect(bySid.get('NetworkRouteGateways')).toMatchObject({
      Resource: 'arn:aws:ec2:us-east-1:222222222222:internet-gateway/*',
      Condition: { StringEquals: { 'ec2:ResourceTag/better-compute:managed': 'true' } },
    });
    expect(bySid.has('NetworkRoutesAndAcls')).toBe(false);
    for (const statement of policy.Statement)
      if (
        [statement.Action]
          .flat()
          .some((a) =>
            [
              'ec2:CreateRoute',
              'ec2:ReplaceRoute',
              'ec2:CreateNetworkAclEntry',
              'ec2:DeleteNetworkAclEntry',
            ].includes(a),
          )
      )
        expect(statement.Condition, statement.Sid).toBeDefined();
    // Every action the networks module calls is in the policy.
    const actions = new Set(policy.Statement.flatMap((s) => [s.Action].flat()));
    for (const action of [
      'CreateVpc',
      'DescribeVpcs',
      'ModifyVpcAttribute',
      'AssociateVpcCidrBlock',
      'CreateInternetGateway',
      'AttachInternetGateway',
      'CreateRoute',
      'ReplaceRoute',
      'CreateSubnet',
      'ModifySubnetAttribute',
      'CreateVpcEndpoint',
      'DeleteVpcEndpoints',
      'CreateSecurityGroup',
      'DescribeSecurityGroupRules',
      'AuthorizeSecurityGroupIngress',
      'RevokeSecurityGroupEgress',
      'CreateNetworkAclEntry',
      'DeleteNetworkAclEntry',
      'ModifyInstanceAttribute',
      'ModifyNetworkInterfaceAttribute',
      'DeleteSubnet',
      'DeleteSecurityGroup',
      'DetachInternetGateway',
      'DeleteInternetGateway',
      'DeleteVpc',
    ])
      expect(actions.has(`ec2:${action}`), action).toBe(true);
  });
});

describe('networks: IAM policy against the calls the code makes', () => {
  /** `arn:aws:ec2:us-east-1:222222222222:route-table/*` → `route-table`. */
  const arnType = (arn: string) => arn.slice(arn.lastIndexOf(':') + 1).split('/')[0]!;
  const idTypes: [string, string][] = [
    ['rtb-', 'route-table'],
    ['acl-', 'network-acl'],
    ['eni-', 'network-interface'],
    ['igw-', 'internet-gateway'],
    ['vpce-', 'vpc-endpoint'],
    ['sgr-', 'security-group-rule'],
    ['sg-', 'security-group'],
    ['subnet-', 'subnet'],
    ['vpc-', 'vpc'],
    ['i-', 'instance'],
  ];

  it('every tag the code writes is allowed, and every tag a condition checks is written', async () => {
    const w = await world();
    await w.settle(() => w.networks.ensureNetwork({ name: 'bc-net-1' }, w.call()));
    await w.settle(() =>
      w.networks.ensureSubnet(
        {
          network: 'bc-net-1',
          name: 'bc-sub-1',
          region: 'us-east-1',
          cidr: '10.64.1.0/24',
          zone: 'us-east-1a',
          privateGoogleAccess: true,
        },
        w.call(),
      ),
    );
    const base = {
      network: 'bc-net-1',
      direction: 'ingress',
      priority: 1000,
      rules: [{ protocol: 'tcp', ports: ['22'] }],
    } as const;
    await w.networks.ensureFirewall(
      { ...base, name: 'bc-fw-a', action: 'allow', targetTags: ['bc-0123456789abcdef'] },
      w.call(),
    );
    await w.networks.ensureFirewall({ ...base, name: 'bc-fw-d', action: 'deny' }, w.call());
    const machine = await w.impl.create(
      {
        offerId: 'us-east-1a/t3.micro',
        image: 'ubuntu-24.04',
        userData: '#cloud-config\n',
        name: 'vm-ins_1',
        network: { network: 'bc-net-1', subnet: 'bc-sub-1', tags: ['bc-0123456789abcdef'] },
      },
      w.call('ins_1'),
    );
    w.ec2.instances.get(machine.id)!.interfaces = 2;
    await w.networks.setTags(machine.id, ['bc-fedcba9876543210'], w.call('ins_1'), 'ins_1');

    const policy = iamPolicy({ networks: true, region: 'us-east-1', account: '222222222222' });
    const allows = (action: string, type: string) =>
      policy.Statement.filter(
        (s) =>
          [s.Action].flat().includes(action) &&
          [s.Resource].flat().some((r) => r === '*' || arnType(r) === type),
      );
    // What the code tags, and with which keys: tag-on-create specs and CreateTags by id.
    const written = new Map<string, Set<string>>();
    const write = (type: string, key: string) =>
      written.set(type, (written.get(type) ?? new Set()).add(key));
    for (const request of w.emu.requests) {
      const p = request.params;
      for (let n = 1; p.has(`TagSpecification.${n}.ResourceType`); n++) {
        const type = p.get(`TagSpecification.${n}.ResourceType`)!;
        // The create itself, and tagging on create, are allowed for that resource type.
        expect(
          allows(`ec2:${request.operation}`, type).length,
          `${request.operation} ${type}`,
        ).toBeGreaterThan(0);
        const onCreate = allows('ec2:CreateTags', type).filter((s) =>
          [s.Condition?.StringEquals?.['ec2:CreateAction'] ?? []]
            .flat()
            .includes(request.operation),
        );
        expect(onCreate.length, `CreateTags on ${request.operation} of ${type}`).toBeGreaterThan(0);
        for (let m = 1; p.has(`TagSpecification.${n}.Tag.${m}.Key`); m++)
          write(type, p.get(`TagSpecification.${n}.Tag.${m}.Key`)!);
      }
      if (request.operation === 'CreateTags') {
        const id = p.get('ResourceId.1')!;
        const type = idTypes.find(([prefix]) => id.startsWith(prefix))![1];
        expect(allows('ec2:CreateTags', type).length, `CreateTags on ${type}`).toBeGreaterThan(0);
        for (let m = 1; p.has(`Tag.${m}.Key`); m++) write(type, p.get(`Tag.${m}.Key`)!);
      }
    }
    expect([...written.keys()]).toEqual(
      expect.arrayContaining(['network-interface', 'route-table', 'network-acl']),
    );
    // Every resource-tag condition on a resource type the code writes names a tag it writes there.
    for (const statement of policy.Statement) {
      const keys = [
        ...Object.keys(statement.Condition?.Null ?? {}),
        ...Object.keys(statement.Condition?.StringEquals ?? {}),
      ]
        .filter((k) => k.startsWith('ec2:ResourceTag/'))
        .map((k) => k.slice('ec2:ResourceTag/'.length));
      for (const resource of [statement.Resource].flat()) {
        const type = arnType(resource);
        if (!written.has(type)) continue;
        for (const key of keys)
          expect(written.get(type)!.has(key), `${statement.Sid}: ${key} on ${type}`).toBe(true);
      }
    }
  });
});

describe('networks: aws iam-policy --phases', () => {
  const run = async (phases?: string) => {
    const out: string[] = [];
    await awsIamPolicyCommand().run({
      flags: phases === undefined ? {} : { phases },
      io: { out: (message: string) => out.push(message) },
      note() {},
      path: (value: string) => value,
    });
    return JSON.parse(out.join('\n'));
  };

  it('A2 adds the network statements; unknown phases are refused', async () => {
    expect(await run()).toEqual(iamPolicy());
    expect(await run('a1, A2')).toEqual(iamPolicy({ networks: true }));
    await expect(run('A9')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('networks: a rule that changes action', () => {
  it('moves between security group rules and ACL entries without leaving the old ones', async () => {
    const w = await world();
    await w.settle(() => w.networks.ensureNetwork({ name: 'bc-net-1' }, w.call()));
    const acl = w.vpc.defaultNacl(w.vpc.vpcByName('bc-net-1')!.id);
    const spec: ProviderFirewallSpec = {
      network: 'bc-net-1',
      name: 'bc-fw-1',
      direction: 'ingress',
      action: 'allow',
      priority: 1000,
      rules: [{ protocol: 'tcp', ports: ['22'] }],
      sources: ['0.0.0.0/0'],
    };
    const ruleCount = () =>
      [...w.vpc.rules.values()].filter((r) => r.tags.has('better-compute:firewall:bc-fw-1')).length;
    const denies = () => acl.entries.filter((e) => e.action === 'deny').length;
    await w.networks.ensureFirewall(spec, w.call());
    expect([ruleCount(), denies()]).toEqual([1, 0]);
    await w.networks.ensureFirewall({ ...spec, action: 'deny' }, w.call());
    expect([ruleCount(), denies()]).toEqual([0, 1]);
    await w.networks.ensureFirewall(spec, w.call());
    expect([ruleCount(), denies()]).toEqual([1, 0]);
    expect([...acl.tags.keys()].some((k) => k.startsWith('better-compute:deny:'))).toBe(false);
  });
});

describe('networks: EFA self rule (AWS A10)', () => {
  const groupOf = (w: Awaited<ReturnType<typeof world>>, network: string) =>
    [...w.vpc.groups.values()].find(
      (g) => g.name === `bc-net-${network}` && g.vpcId === w.vpc.vpcByName(network)!.id,
    );
  const selfRules = (w: Awaited<ReturnType<typeof world>>, groupId: string) =>
    [...w.vpc.rules.values()].filter(
      (r) => r.groupId === groupId && r.referencedGroupId === groupId,
    );

  it("efa auto gives the network's group all traffic from and to itself, tagged as EFA's", async () => {
    const w = await world({ efa: 'auto' });
    const ready = await w.settle(() => w.networks.ensureNetwork({ name: 'bc-net-1' }, w.call()));
    expect(ready.state).toBe('ready');
    const group = groupOf(w, 'bc-net-1')!;
    expect(group).toBeDefined();
    const rules = selfRules(w, group.id);
    expect(rules.map((r) => [r.egress, r.protocol]).sort()).toEqual([
      [false, '-1'],
      [true, '-1'],
    ]);
    for (const rule of rules) {
      expect(rule.tags.get('better-compute:efa')).toBe('true');
      expect(rule.tags.get('better-compute:network')).toBe('bc-net-1');
      expect([...rule.tags.keys()].some((k) => k.startsWith('better-compute:firewall:'))).toBe(
        false,
      );
    }
    // Ensuring again authorizes nothing.
    const before =
      w.emu.calls('AuthorizeSecurityGroupIngress').length +
      w.emu.calls('AuthorizeSecurityGroupEgress').length;
    await w.networks.ensureNetwork({ name: 'bc-net-1' }, w.call());
    expect(
      w.emu.calls('AuthorizeSecurityGroupIngress').length +
        w.emu.calls('AuthorizeSecurityGroupEgress').length,
    ).toBe(before);
  });

  it('firewall changes on the network never revoke the self rule', async () => {
    const w = await world({ efa: 'auto' });
    await w.settle(() => w.networks.ensureNetwork({ name: 'bc-net-1' }, w.call()));
    const spec: ProviderFirewallSpec = {
      network: 'bc-net-1',
      name: 'bc-fw-1',
      direction: 'ingress',
      action: 'allow',
      priority: 1000,
      rules: [{ protocol: 'all' }],
      sources: ['10.64.0.0/16'],
    };
    await w.networks.ensureFirewall(spec, w.call());
    await w.networks.ensureFirewall({ ...spec, disabled: true }, w.call());
    await w.networks.ensureFirewall({ ...spec, action: 'deny' }, w.call());
    await w.networks.deleteFirewall('bc-fw-1', w.call());
    expect(selfRules(w, groupOf(w, 'bc-net-1')!.id)).toHaveLength(2);
  });

  it('efa off revokes the self rule it made, and makes none', async () => {
    const auto = await world({ efa: 'auto' });
    await auto.settle(() => auto.networks.ensureNetwork({ name: 'bc-net-1' }, auto.call()));
    const group = groupOf(auto, 'bc-net-1')!;
    // The same account, now configured efa off.
    const provider = awsProvider({ fetch: auto.emu.fetch, credentials: auto.emu.ambient });
    const off = (await provider.create(
      awsConfig.parse({ region: 'us-east-1', zones: ['us-east-1a', 'us-east-1b'] }) as AwsConfig,
      {
        clock: auto.emu.clock,
        log: quiet,
        secrets: { resolve: async () => '' },
        account: { id: 'pa_platform', tenantId: 'root', platform: true },
      },
    )) as AwsCompute;
    const ready = await auto.settle(() =>
      off.networks!.ensureNetwork({ name: 'bc-net-1' }, auto.call()),
    );
    expect(ready.state).toBe('ready');
    expect(selfRules(auto, group.id)).toHaveLength(0);

    const plain = await world();
    await plain.settle(() => plain.networks.ensureNetwork({ name: 'bc-net-1' }, plain.call()));
    expect([...plain.vpc.rules.values()].some((r) => r.referencedGroupId)).toBe(false);
  });

  it('a group referenced only by itself is still deleted with its network', async () => {
    const w = await world({ efa: 'auto' });
    await w.settle(() => w.networks.ensureNetwork({ name: 'bc-net-1' }, w.call()));
    const deleted = await w.settle(() => w.networks.deleteNetwork('bc-net-1', w.call()));
    expect(deleted.state).toBe('deleted');
    expect([...w.vpc.groups.values()].some((g) => g.name === 'bc-net-bc-net-1')).toBe(false);
  });
});
