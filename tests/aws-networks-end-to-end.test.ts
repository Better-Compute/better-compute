import { afterEach, describe, expect, it } from 'vitest';
import { awsProvider } from '@better-compute/provider-aws';
import { closeFixtures, computeFixture } from '@better-compute/testing';
import { networkTag, providerResourceName, vps } from '@better-compute/vps';
import { AwsEmulator } from './support/aws-emulator/index.js';
import { Ec2Emulator } from './support/aws-emulator/ec2.js';
import { VpcEmulator } from './support/aws-emulator/vpc.js';

// Tenant networks on AWS (A2) end to end: vps networks, subnets and firewall rules converge through
// provider-aws onto the VPC emulator. Subnets are zone-scoped, the network has its own range, and a
// targeted deny is refused at the API because AWS denies only network-wide.

afterEach(closeFixtures);

type Api = any;

async function world() {
  const emu = new AwsEmulator();
  const ec2 = new Ec2Emulator(emu);
  const vpc = new VpcEmulator(emu, ec2);
  const aws = awsProvider({ fetch: emu.fetch, credentials: emu.ambient });
  const fixture = await computeFixture({ clock: 'sim', modules: [vps({ providers: [aws] })] });
  emu.follow(fixture.clock);
  const { compute, tenants, iam } = fixture;
  (iam as { rootTenantId?: string }).rootTenantId = tenants.root.id;
  iam.allow({ token: tenants.root.token });
  iam.allow({ token: tenants.acme.token });
  const api = compute.api as Api;
  const root = { token: tenants.root.token };
  const acme = { token: tenants.acme.token };
  const account = await api.providerAccounts.create(root, {
    tenantId: tenants.root.id,
    provider: 'aws',
    name: 'aws-use1',
    config: { region: 'us-east-1', zones: ['us-east-1a', 'us-east-1b'] },
  });
  const site = await api.sites.create(root, {
    tenantId: tenants.root.id,
    kind: 'shared',
    region: 'us-east-1',
    idempotencyKey: 'aws-site',
  });
  const pool = await api.pools.create(root, {
    tenantId: tenants.root.id,
    siteId: site.id,
    class: 'provider',
    providerAccountId: account.id,
    idempotencyKey: 'aws-pool',
  });
  await api.pools.offer(root, {
    tenantId: tenants.root.id,
    poolId: pool.id,
    toTenantId: tenants.acme.id,
    quota: { vcpu: 2000, memoryGiB: 20_000, diskGiB: 10_000, gpu: 64 },
  });
  await api.flavors.create(root, {
    tenantId: tenants.root.id,
    poolId: pool.id,
    name: 'm7i.large',
    vcpu: 2,
    memoryGiB: 8,
    diskGiB: 100,
    offerId: 'us-east-1a/m7i.large',
  });
  const tick = async (job: string, advanceMs = 5_000) => {
    await fixture.advance(advanceMs);
    for (let round = 0; round < 2; round++) await compute.jobs[job]!.tick();
  };
  return { emu, ec2, vpc, fixture, api, acme, acmeTenant: tenants.acme.id, poolId: pool.id, tick };
}

describe('tenant networks on AWS through vps', () => {
  it('converges a VPC with its own range, a zone-scoped subnet and a targeted rule', async () => {
    const w = await world();
    const network = await w.api.networks.create(w.acme, {
      tenantId: w.acmeTenant,
      poolId: w.poolId,
      name: 'prod',
      cidr: '10.80.0.0/16',
      idempotencyKey: 'net-prod',
    });
    expect(network).toMatchObject({ cidr: '10.80.0.0/16' });
    const withSubnet = await w.api.networks.addSubnet(w.acme, {
      tenantId: w.acmeTenant,
      networkId: network.id,
      name: 'app',
      region: 'us-east-1',
      zone: 'us-east-1a',
      cidr: '10.80.1.0/24',
    });
    const subnet = withSubnet.subnets[0];
    expect(subnet).toMatchObject({ region: 'us-east-1', zone: 'us-east-1a' });
    const view = () =>
      w.api.networks.get(w.acme, { tenantId: w.acmeTenant, networkId: network.id });
    const converge = async () => {
      let current = await view();
      for (let round = 0; round < 8 && current.state !== 'ready'; round++) {
        await w.tick('vps.networks');
        current = await view();
      }
      return current;
    };
    expect(await converge()).toMatchObject({ state: 'ready' });
    const made = w.vpc.vpcByName(providerResourceName(network.id))!;
    expect(made.cidrs[0]!.cidr).toBe('10.80.0.0/16');
    const madeSubnet = [...w.vpc.subnets.values()].find(
      (s) => s.tags.get('better-compute:subnet') === providerResourceName(subnet.id),
    );
    expect(madeSubnet).toMatchObject({ vpcId: made.id, zone: 'us-east-1a', cidr: '10.80.1.0/24' });

    // A subnet in another zone does not take the flavor's us-east-1a machines.
    const withOther = await w.api.networks.addSubnet(w.acme, {
      tenantId: w.acmeTenant,
      networkId: network.id,
      name: 'other',
      region: 'us-east-1',
      zone: 'us-east-1b',
      cidr: '10.80.2.0/24',
    });
    const other = withOther.subnets.find((s: { name: string }) => s.name === 'other');
    expect(await converge()).toMatchObject({ state: 'ready' });
    const vmInput = {
      tenantId: w.acmeTenant,
      poolId: w.poolId,
      flavor: 'm7i.large',
      imageId: 'ubuntu-24.04',
      sshKeys: [],
      networkId: network.id,
    };
    await expect(
      w.api.instances.create(w.acme, {
        ...vmInput,
        subnetId: other.id,
        idempotencyKey: 'net-vm-b',
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringMatching(/zone us-east-1b/),
    });

    // Without a subnet, the network's only subnet in the offer's zone.
    const created = await w.api.instances.create(w.acme, { ...vmInput, idempotencyKey: 'net-vm' });
    expect(created).toMatchObject({ subnetId: subnet.id });
    for (let round = 0; round < 8; round++) {
      w.ec2.tick();
      await w.tick('vps.instances');
      const current = await w.api.instances.get(w.acme, {
        tenantId: w.acmeTenant,
        instanceId: created.id,
      });
      if (current.state === 'running') break;
    }
    const vm = [...w.ec2.instances.values()].find(
      (instance) => instance.tags.get('better-compute:instance') === created.id,
    )!;
    expect(vm.subnetId).toBe(madeSubnet!.id);
    expect(vm.groups.map((g) => g.name)).toContain(networkTag(created.id));

    const rule = await w.api.firewallRules.create(w.acme, {
      tenantId: w.acmeTenant,
      networkId: network.id,
      name: 'ssh',
      direction: 'ingress',
      rules: [{ protocol: 'tcp', ports: ['22'] }],
      sources: ['0.0.0.0/0'],
      targets: { instanceIds: [created.id] },
    });
    for (let round = 0; round < 8; round++) {
      await w.tick('vps.networks');
      const rules = await w.api.firewallRules.list(w.acme, {
        tenantId: w.acmeTenant,
        networkId: network.id,
      });
      if (rules.items.find((item: { id: string }) => item.id === rule.id)?.state === 'ready') break;
    }
    const sgRules = [...w.vpc.rules.values()].filter((r) =>
      r.tags.has(`better-compute:firewall:${providerResourceName(rule.id)}`),
    );
    expect(sgRules).toHaveLength(1);
    expect(vm.groups.map((g) => g.id)).toContain(sgRules[0]!.groupId);
  });

  it('subnets need a zone of the account in their region', async () => {
    const w = await world();
    const network = await w.api.networks.create(w.acme, {
      tenantId: w.acmeTenant,
      poolId: w.poolId,
      name: 'prod',
      idempotencyKey: 'net-prod',
    });
    const add = (extra: Record<string, unknown>) =>
      w.api.networks.addSubnet(w.acme, {
        tenantId: w.acmeTenant,
        networkId: network.id,
        name: 'app',
        region: 'us-east-1',
        cidr: '10.64.1.0/24',
        ...extra,
      });
    await expect(add({})).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringMatching(/zone/),
    });
    await expect(add({ zone: 'us-east-1c' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(add({ zone: 'us-east-1a', region: 'us-west-2' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(add({ zone: 'us-east-1b' })).resolves.toMatchObject({
      subnets: [expect.objectContaining({ zone: 'us-east-1b' })],
    });
  });

  it('refuses a targeted deny up front; a network-wide deny becomes ACL entries', async () => {
    const w = await world();
    const network = await w.api.networks.create(w.acme, {
      tenantId: w.acmeTenant,
      poolId: w.poolId,
      name: 'prod',
      idempotencyKey: 'net-prod',
    });
    const deny = (extra: Record<string, unknown>) =>
      w.api.firewallRules.create(w.acme, {
        tenantId: w.acmeTenant,
        networkId: network.id,
        name: 'no-telnet',
        direction: 'ingress',
        action: 'deny',
        rules: [{ protocol: 'tcp', ports: ['23'] }],
        sources: ['0.0.0.0/0'],
        ...extra,
      });
    await expect(
      deny({ targets: { instanceIds: ['inst_01jz0000000000000000000a01'] } }),
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    });
    const rule = await deny({});
    for (let round = 0; round < 8; round++) {
      await w.tick('vps.networks');
      const rules = await w.api.firewallRules.list(w.acme, {
        tenantId: w.acmeTenant,
        networkId: network.id,
      });
      if (rules.items.find((item: { id: string }) => item.id === rule.id)?.state === 'ready') break;
    }
    const made = w.vpc.vpcByName(providerResourceName(network.id))!;
    const acl = w.vpc.defaultNacl(made.id);
    expect(acl.entries).toContainEqual(
      expect.objectContaining({
        number: 200,
        egress: false,
        action: 'deny',
        protocol: '6',
        from: 23,
        to: 23,
      }),
    );
  });
});
