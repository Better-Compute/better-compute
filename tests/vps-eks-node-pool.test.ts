import { afterEach, describe, expect, it } from 'vitest';
import { awsProvider } from '@better-compute/provider-aws';
import { closeFixtures, computeFixture } from '@better-compute/testing';
import { vps } from '@better-compute/vps';
import { AwsEmulator } from './support/aws-emulator/index.js';
import { Ec2Emulator, type EmuInstance } from './support/aws-emulator/ec2.js';
import { emulatedEksCaData } from './support/eks-emulator.js';

// (AWS A9) A provider pool whose policy names an EKS cluster (`policy.kubernetes.eks`, as
// providerAccounts.clusters lists it): every EC2 machine vps launches for the pool carries nodeadm's
// NodeConfig as the first part of its user data, so an AL2023 EKS AMI joins the cluster at boot. The
// tenant's SSH keys and user data stay parts of the same (single-level) multipart, which nodeadm and
// cloud-init both read.

afterEach(closeFixtures);

type Api = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const ZONE = 'us-east-1a';
const ENDPOINT = 'https://ABCDEF0123456789ABCDEF0123456789.gr7.us-east-1.eks.amazonaws.com';
const SSH_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEksNodePoolTestKey0000000000000000000 alice@laptop';

const eksNodes = 'arn:aws:iam::111111111111:instance-profile/eks-nodes';

async function world(
  policy?: Record<string, unknown>,
  accountConfig: Record<string, unknown> = { eksNodeInstanceProfile: eksNodes },
) {
  const emu = new AwsEmulator();
  const ec2 = new Ec2Emulator(emu);
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
    config: { region: 'us-east-1', zones: [ZONE], ...accountConfig },
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
    ...(policy ? { policy } : {}),
    idempotencyKey: 'aws-pool',
  });
  await api.pools.offer(root, {
    tenantId: tenants.root.id,
    poolId: pool.id,
    toTenantId: tenants.acme.id,
    quota: { vcpu: 64, memoryGiB: 256, diskGiB: 1000, gpu: 4 },
  });
  // The owner's own quota on its pool.
  await api.pools.offer(root, {
    tenantId: tenants.root.id,
    poolId: pool.id,
    toTenantId: tenants.root.id,
    quota: { vcpu: 64, memoryGiB: 256, diskGiB: 1000, gpu: 4 },
  });
  await api.flavors.create(root, {
    tenantId: tenants.root.id,
    poolId: pool.id,
    name: 'm7i.large',
    vcpu: 2,
    memoryGiB: 8,
    diskGiB: 100,
    offerId: `${ZONE}/m7i.large`,
  });
  // The pool owner (the cluster's operator) launches its nodes; `as: 'acme'` is a tenant it is offered to.
  const launch = async (extra: Record<string, unknown> = {}, as: 'root' | 'acme' = 'root') => {
    const caller = as === 'root' ? root : acme;
    const tenantId = as === 'root' ? tenants.root.id : tenants.acme.id;
    const created = await api.instances.create(caller, {
      tenantId,
      poolId: pool.id,
      flavor: 'm7i.large',
      imageId: 'eks-al2023-1.33',
      sshKeys: [SSH_KEY],
      idempotencyKey: 'node-1',
      ...extra,
    });
    for (let round = 0; round < 4; round++) {
      await fixture.advance(15_000);
      await compute.jobs['vps.instances']!.tick();
      ec2.tick();
    }
    const vm = [...ec2.instances.values()].find(
      (instance: EmuInstance) => instance.tags.get('better-compute:instance') === created.id,
    );
    const view = await api.instances.get(caller, { tenantId, instanceId: created.id });
    return { created, vm, view };
  };
  const createPool = (policy: Record<string, unknown>, kind: string) =>
    api.sites
      .create(root, { tenantId: tenants.root.id, kind, region: 'us-east-1', idempotencyKey: `site-${kind}` })
      .then((site: { id: string }) =>
        api.pools.create(root, {
          tenantId: tenants.root.id,
          siteId: site.id,
          class: 'provider',
          providerAccountId: account.id,
          policy,
          idempotencyKey: `pool-${kind}`,
        }),
      );
  return { emu, ec2, api, launch, createPool };
}

const eksPolicy = {
  kubernetes: {
    platformOperated: true,
    eks: {
      name: 'training',
      apiServerEndpoint: ENDPOINT,
      certificateAuthority: emulatedEksCaData,
      cidr: '172.20.0.0/16',
    },
    labels: { 'better-compute.dev/pool': 'gpu' },
    taints: ['nvidia.com/gpu=:NoSchedule'],
  },
};

/** The parts of a single-level MIME multipart: content type and body. */
function parts(text: string): { type: string; body: string }[] {
  const boundary = /boundary="([^"]+)"/.exec(text)?.[1];
  if (!boundary) throw new Error('not a multipart');
  return text
    .split(`--${boundary}`)
    .slice(1, -1)
    .map((chunk) => {
      const [headers, ...body] = chunk.replace(/^\n/, '').split('\n\n');
      return {
        type: /Content-Type: ([^;\n]+)/.exec(headers!)?.[1] ?? '',
        body: body.join('\n\n'),
      };
    });
}

const profiles = {
  instanceProfile: 'arn:aws:iam::111111111111:instance-profile/tenant-machines',
  eksNodeInstanceProfile: eksNodes,
};
const profileOf = (w: { emu: AwsEmulator }) =>
  w.emu.calls('RunInstances').at(-1)?.params.get('IamInstanceProfile.Arn') ?? undefined;

describe('vps on a provider pool that joins an EKS cluster', () => {
  it("launches EKS nodes with the account's eksNodeInstanceProfile, never its instanceProfile", async () => {
    const w = await world(eksPolicy, profiles);
    const { vm, view } = await w.launch();
    expect(vm, JSON.stringify(view)).toBeDefined();
    expect(profileOf(w)).toBe(profiles.eksNodeInstanceProfile);
  });

  it('never gives the EKS node profile to an instance of a pool without policy.kubernetes.eks', async () => {
    // The same account: its other pools launch with instanceProfile only (the node role would let
    // the instance's tenant register a Node in the operator's cluster).
    const w = await world(undefined, profiles);
    const { vm } = await w.launch({ imageId: 'ubuntu-24.04' }, 'acme');
    expect(vm).toBeDefined();
    expect(profileOf(w)).toBe(profiles.instanceProfile);
    const bare = await world(undefined, { eksNodeInstanceProfile: profiles.eksNodeInstanceProfile });
    await bare.launch({ imageId: 'ubuntu-24.04' });
    expect(bare.emu.calls('RunInstances')).toHaveLength(1);
    expect(profileOf(bare)).toBeUndefined();
  });

  it('fails an EKS node launch closed when the account has no eksNodeInstanceProfile', async () => {
    const w = await world(eksPolicy, { instanceProfile: profiles.instanceProfile });
    const { vm, view } = await w.launch();
    expect(vm).toBeUndefined();
    expect(w.emu.calls('RunInstances')).toHaveLength(0);
    expect(JSON.stringify(view)).toMatch(/eksNodeInstanceProfile/);
  });

  it('refuses an EKS pool on a platform site unless the platform operates the cluster', async () => {
    const w = await world();
    const { platformOperated: _, ...kubernetes } = eksPolicy.kubernetes;
    await expect(w.createPool({ kubernetes }, 'shared')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringMatching(/platformOperated/),
    });
  });

  it('never launches a node of the cluster for a tenant the pool is offered to', async () => {
    // Its user data and SSH keys would give that tenant root on a node of the operator's cluster.
    const w = await world(eksPolicy);
    const { vm, view } = await w.launch({}, 'acme');
    expect(vm).toBeUndefined();
    expect(w.emu.calls('RunInstances')).toHaveLength(0);
    expect(JSON.stringify(view)).toMatch(/pool owner/);
  });

  it('launches every machine with the NodeConfig first, keys and user data in the same multipart', async () => {
    const w = await world(eksPolicy);
    const { vm, view } = await w.launch({ userData: '#!/bin/sh\necho tenant-script\n' });
    expect(vm, JSON.stringify(view)).toBeDefined();
    const text = Buffer.from(vm!.userData!, 'base64').toString('utf8');
    const found = parts(text);
    expect(found.map((part) => part.type)).toEqual([
      'application/node.eks.aws',
      'text/x-shellscript',
      'text/cloud-config',
    ]);
    expect(found[0]!.body).toContain('kind: NodeConfig');
    expect(found[0]!.body).toContain(`apiServerEndpoint: "${ENDPOINT}"`);
    expect(found[0]!.body).toContain('"--register-with-taints=nvidia.com/gpu=:NoSchedule"');
    expect(found[0]!.body).toContain('"--node-labels=better-compute.dev/pool=gpu"');
    expect(found[2]!.body).toContain(SSH_KEY);
    expect(found[1]!.body).toContain('echo tenant-script');
    // One level: nodeadm does not read nested multiparts.
    expect(found.some((part) => part.type.startsWith('multipart/'))).toBe(false);
    expect(vm!.imageId).toBeDefined();
  });

  it('keeps the rendered cloud-config (keys) after the NodeConfig when the tenant brings none', async () => {
    const w = await world(eksPolicy);
    const { vm } = await w.launch();
    const found = parts(Buffer.from(vm!.userData!, 'base64').toString('utf8'));
    // The rendered cloud-config (hostname, keys), then the keys part the provider always adds.
    expect(found.map((part) => part.type)).toEqual([
      'application/node.eks.aws',
      'text/cloud-config',
      'text/cloud-config',
    ]);
    expect(found[1]!.body).toContain(SSH_KEY);
  });

  it('leaves the user data of a pool without policy.kubernetes.eks as it was', async () => {
    const w = await world();
    const { vm } = await w.launch({ imageId: 'ubuntu-24.04' });
    const text = Buffer.from(vm!.userData!, 'base64').toString('utf8');
    expect(text).not.toContain('node.eks.aws');
  });

  it('fails the launch of a tenant multipart on an EKS pool instead of nesting it', async () => {
    const w = await world(eksPolicy);
    const { vm, view } = await w.launch({
      userData: 'MIME-Version: 1.0\nContent-Type: multipart/mixed; boundary="x"\n\n--x\nContent-Type: text/x-shellscript\n\n#!/bin/sh\n--x--\n',
    });
    expect(vm).toBeUndefined();
    expect(w.emu.calls('RunInstances')).toHaveLength(0);
    expect(JSON.stringify(view)).toMatch(/multipart/);
  });
});
