import { describe, expect, it } from 'vitest';
import type {
  CallContext,
  Logger,
  ProviderFilesystems,
  ProviderFilesystemSpec,
  ProviderNetworks,
} from '@better-compute/core';
import {
  awsConfig,
  awsProvider,
  efsMountOptions,
  iamPolicy,
  lustreMountOptions,
  packUserData,
  type AwsCompute,
  type AwsConfig,
} from '@better-compute/provider-aws';
import { AwsEmulator } from './support/aws-emulator/index.js';
import { Ec2Emulator } from './support/aws-emulator/ec2.js';
import { VpcEmulator } from './support/aws-emulator/vpc.js';
import { EfsEmulator } from './support/aws-emulator/efs.js';
import { FsxEmulator } from './support/aws-emulator/fsx.js';

// AWS A10 shared filesystems (sub-plan 2026-11-05): EFS (nfs) and FSx for Lustre (lustre) on a
// better-compute network, behind the filesystem's own bc-fs:<name> group, and the mounts a created
// machine performs from its user data.

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };

async function world(
  overrides: Partial<AwsConfig> = {},
  options: { wrapFetch?: (inner: typeof fetch) => typeof fetch } = {},
) {
  const emu = new AwsEmulator();
  const ec2 = new Ec2Emulator(emu);
  const vpc = new VpcEmulator(emu, ec2);
  const efs = new EfsEmulator(emu, vpc);
  const fsx = new FsxEmulator(emu, vpc);
  const provider = awsProvider({
    fetch: options.wrapFetch ? options.wrapFetch(emu.fetch) : emu.fetch,
    credentials: emu.ambient,
    rateLimit: { perSecond: 1_000_000, burst: 1_000_000 },
  });
  const config = {
    ...(awsConfig.parse({ region: 'us-east-1', zones: ['us-east-1a', 'us-east-1b'] }) as AwsConfig),
    ...overrides,
  };
  const impl = (await provider.create(config, {
    clock: emu.clock,
    log: quiet,
    secrets: { resolve: async () => '' },
    account: { id: 'pa_platform', tenantId: 'root', platform: true },
  })) as AwsCompute;
  const call = (key = 'k'): CallContext => ({
    idempotencyKey: key,
    signal: new AbortController().signal,
    clock: emu.clock,
    secrets: { resolve: async () => '' },
    log: quiet,
  });
  const networks = impl.networks as ProviderNetworks;
  const filesystems = impl.filesystems as ProviderFilesystems;
  const settle = async <T extends { state: string }>(ensure: () => Promise<T>) => {
    let result = await ensure();
    for (let n = 0; n < 12 && (result.state === 'pending' || result.state === 'deleting'); n++)
      result = await ensure();
    return result;
  };
  /** A network with a subnet in each of `zones`. */
  const network = async (name = 'bc-net-1', zones = ['us-east-1a', 'us-east-1b']) => {
    await settle(() => networks.ensureNetwork({ name }, call()));
    let n = 1;
    for (const zone of zones) {
      const index = n++;
      await settle(() =>
        networks.ensureSubnet(
          {
            network: name,
            name: `bc-sub-${zone.slice(-1)}`,
            region: 'us-east-1',
            cidr: `10.64.${index}.0/24`,
            zone,
          },
          call(),
        ),
      );
    }
  };
  return { emu, ec2, vpc, efs, fsx, impl, networks, filesystems, call, settle, network };
}

type World = Awaited<ReturnType<typeof world>>;

const nfs: ProviderFilesystemSpec = { name: 'bc-fs-1', kind: 'nfs', network: 'bc-net-1' };
const lustre: ProviderFilesystemSpec = { name: 'bc-fs-2', kind: 'lustre', network: 'bc-net-1' };

const fsGroup = (w: World, name: string) =>
  [...w.vpc.groups.values()].find((g) => g.name === `bc-fs:${name}`);
const netGroup = (w: World) => [...w.vpc.groups.values()].find((g) => g.name === 'bc-net-bc-net-1')!;
const ingress = (w: World, groupId: string) =>
  [...w.vpc.rules.values()]
    .filter((r) => r.groupId === groupId && !r.egress)
    .map((r) => [r.protocol, r.from, r.to, r.referencedGroupId ?? r.cidrIpv4])
    .sort();

describe('filesystems: EFS (nfs)', () => {
  it('declares nfs and lustre', async () => {
    const w = await world();
    expect(w.filesystems.kinds).toEqual(['nfs', 'lustre']);
  });

  it('makes an encrypted elastic file system with a mount target per zone behind its own group', async () => {
    const w = await world();
    await w.network();
    const ready = await w.settle(() => w.filesystems.ensureFilesystem(nfs, w.call()));
    expect(ready.state).toBe('ready');
    const [fs] = [...w.efs.fileSystems.values()];
    expect(fs).toMatchObject({
      creationToken: 'bc-fs-1',
      encrypted: true,
      throughputMode: 'elastic',
      performanceMode: 'generalPurpose',
    });
    expect(Object.fromEntries(fs!.tags)).toMatchObject({
      'better-compute:managed': 'true',
      'better-compute:filesystem': 'bc-fs-1',
      'better-compute:network': 'bc-net-1',
    });
    expect(ready).toMatchObject({
      id: fs!.id,
      outputs: { fileSystemId: fs!.id },
      mount: {
        fstype: 'nfs4',
        source: `${fs!.id}.efs.us-east-1.amazonaws.com:/`,
        options: efsMountOptions,
      },
      // EFS bills its metered size: the emulator's empty file system, 6144 bytes.
      sizeGiB: Math.round((6144 / 2 ** 30) * 1e6) / 1e6,
    });
    // The size follows what EFS meters.
    fs!.sizeBytes = 3 * 2 ** 30;
    expect((await w.filesystems.ensureFilesystem(nfs, w.call())).sizeGiB).toBe(3);
    const group = fsGroup(w, 'bc-fs-1')!;
    const targets = [...w.efs.mountTargets.values()];
    expect(targets.map((t) => t.zone).sort()).toEqual(['us-east-1a', 'us-east-1b']);
    for (const target of targets) expect(target.groupIds).toEqual([group.id]);
    // NFS from the network's machines only, tagged for the filesystem and for no firewall.
    expect(ingress(w, group.id)).toEqual([['tcp', 2049, 2049, netGroup(w).id]]);
    for (const rule of [...w.vpc.rules.values()].filter((r) => r.groupId === group.id && !r.egress)) {
      expect(rule.tags.get('better-compute:filesystem')).toBe('bc-fs-1');
      expect([...rule.tags.keys()].some((k) => k.startsWith('better-compute:firewall:'))).toBe(false);
    }
  });

  it('is idempotent, and a zone that gains a subnet later gets its mount target', async () => {
    const w = await world();
    await w.network('bc-net-1', ['us-east-1a']);
    await w.settle(() => w.filesystems.ensureFilesystem(nfs, w.call()));
    const posts = () =>
      w.emu.requests.filter(
        (r) =>
          (r.service === 'elasticfilesystem' && r.method !== 'GET') ||
          /^(Create|Authorize|Revoke|Delete)/.test(r.operation),
      ).length;
    const before = posts();
    expect((await w.filesystems.ensureFilesystem(nfs, w.call())).state).toBe('ready');
    expect(posts()).toBe(before);
    await w.settle(() =>
      w.networks.ensureSubnet(
        { network: 'bc-net-1', name: 'bc-sub-b', region: 'us-east-1', cidr: '10.64.9.0/24', zone: 'us-east-1b' },
        w.call(),
      ),
    );
    expect((await w.filesystems.ensureFilesystem(nfs, w.call())).state).toBe('pending');
    expect((await w.settle(() => w.filesystems.ensureFilesystem(nfs, w.call()))).state).toBe('ready');
    expect([...w.efs.mountTargets.values()].map((t) => t.zone).sort()).toEqual([
      'us-east-1a',
      'us-east-1b',
    ]);
  });

  it('a CreateFileSystem whose answer was lost is found again by its token, never made twice', async () => {
    let lose = 1;
    const w = await world(
      {},
      {
        wrapFetch: (inner) => async (input, init) => {
          const response = await inner(input, init);
          const url = String(input instanceof Request ? input.url : input);
          if (init?.method === 'POST' && url.endsWith('/2015-02-01/file-systems') && lose-- > 0)
            throw new TypeError('fetch failed: socket hang up');
          return response;
        },
      },
    );
    await w.network();
    await expect(w.filesystems.ensureFilesystem(nfs, w.call())).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
    expect((await w.settle(() => w.filesystems.ensureFilesystem(nfs, w.call()))).state).toBe('ready');
    expect(w.efs.fileSystems.size).toBe(1);
  });

  it('waits for the network and its subnets; an adopted VPC is an error', async () => {
    const w = await world();
    expect((await w.filesystems.ensureFilesystem(nfs, w.call())).state).toBe('pending');
    await w.settle(() => w.networks.ensureNetwork({ name: 'bc-net-1' }, w.call()));
    const noSubnet = await w.filesystems.ensureFilesystem(nfs, w.call());
    expect(noSubnet).toMatchObject({ state: 'pending', message: expect.stringContaining('subnet') });
    const { vpc: adopted } = w.vpc.addForeignVpc();
    const state = await w.filesystems.ensureFilesystem({ ...nfs, network: adopted.id }, w.call());
    expect(state).toMatchObject({ state: 'error', message: expect.stringMatching(/adopted/) });
    expect(w.efs.fileSystems.size).toBe(0);
  });

  it('never adopts or deletes a file system better-compute did not make', async () => {
    const w = await world();
    await w.network();
    w.efs.fileSystems.set('fs-0000000000000000f', {
      id: 'fs-0000000000000000f',
      creationToken: 'bc-fs-1',
      lifeCycleState: 'available',
      encrypted: false,
      performanceMode: 'generalPurpose',
      throughputMode: 'bursting',
      tags: new Map(),
      reads: 0,
    });
    await expect(w.filesystems.ensureFilesystem(nfs, w.call())).rejects.toMatchObject({
      code: 'INVALID_STATE',
      details: { reason: 'filesystem-foreign' },
    });
    await expect(w.filesystems.deleteFilesystem('bc-fs-1', w.call())).rejects.toMatchObject({
      code: 'INVALID_STATE',
      details: { reason: 'filesystem-foreign' },
    });
    expect(w.efs.fileSystems.get('fs-0000000000000000f')?.lifeCycleState).toBe('available');
  });

  it('deletes mount targets, the file system and its group; the network waits for it', async () => {
    const w = await world();
    await w.network();
    await w.settle(() => w.filesystems.ensureFilesystem(nfs, w.call()));
    // The filesystem's group names the network's group: the network cannot go first.
    for (const subnet of ['us-east-1a', 'us-east-1b'])
      await w.networks.deleteSubnet('us-east-1', `bc-sub-${subnet.slice(-1)}`, w.call());
    expect((await w.networks.deleteNetwork('bc-net-1', w.call())).state).not.toBe('deleted');
    const deleted = await w.settle(() => w.filesystems.deleteFilesystem('bc-fs-1', w.call()));
    expect(deleted.state).toBe('deleted');
    expect(w.efs.fileSystems.size).toBe(0);
    expect(w.efs.mountTargets.size).toBe(0);
    expect(fsGroup(w, 'bc-fs-1')).toBeUndefined();
    expect((await w.filesystems.deleteFilesystem('bc-fs-1', w.call())).state).toBe('deleted');
  });

  it('firewall changes never touch the filesystem group', async () => {
    const w = await world();
    await w.network();
    await w.settle(() => w.filesystems.ensureFilesystem(nfs, w.call()));
    const spec = {
      network: 'bc-net-1',
      name: 'bc-fw-1',
      direction: 'ingress',
      action: 'allow',
      priority: 1000,
      rules: [{ protocol: 'tcp', ports: ['2049'] }],
      sources: ['10.64.0.0/16'],
    } as const;
    await w.networks.ensureFirewall(spec, w.call());
    await w.networks.deleteFirewall('bc-fw-1', w.call());
    expect(ingress(w, fsGroup(w, 'bc-fs-1')!.id)).toEqual([['tcp', 2049, 2049, netGroup(w).id]]);
  });
});

describe('filesystems: FSx for Lustre', () => {
  it('refuses sizes and options Lustre or EFS cannot take, before any call', async () => {
    const w = await world();
    const before = w.emu.requests.length;
    for (const [spec, reason] of [
      [{ ...lustre, sizeGiB: 1000 }, 'filesystem-size'],
      [{ ...lustre, sizeGiB: 3600 }, 'filesystem-size'],
      [{ ...lustre, zone: 'us-west-2a' }, 'filesystem-zone'],
      [{ ...nfs, sizeGiB: 1200 }, 'filesystem-options'],
      [{ ...nfs, name: 'Bad_Name' }, 'filesystem-name'],
      [{ ...nfs, kind: 'ontap' }, 'filesystem-kind'],
    ] as [ProviderFilesystemSpec, string][])
      await expect(w.filesystems.ensureFilesystem(spec, w.call())).rejects.toMatchObject({
        code: 'INVALID_INPUT',
        details: { reason },
      });
    expect(w.emu.requests.length).toBe(before);
  });

  it('makes a SCRATCH_2 file system in the first zone, reachable from the network and itself', async () => {
    const w = await world();
    await w.network();
    const ready = await w.settle(() => w.filesystems.ensureFilesystem(lustre, w.call()));
    expect(ready.state).toBe('ready');
    const [fs] = [...w.fsx.fileSystems.values()];
    expect(fs).toMatchObject({ capacity: 1200, deploymentType: 'SCRATCH_2', token: 'bc-fs-2' });
    expect(fs!.subnetIds).toHaveLength(1);
    expect(w.vpc.subnets.get(fs!.subnetIds[0]!)!.zone).toBe('us-east-1a');
    const group = fsGroup(w, 'bc-fs-2')!;
    expect(fs!.groupIds).toEqual([group.id]);
    expect(ready.mount).toEqual({
      fstype: 'lustre',
      source: `${fs!.id}.fsx.us-east-1.amazonaws.com@tcp:/${fs!.mountName}`,
      options: lustreMountOptions,
    });
    // FSx bills its provisioned capacity.
    expect(ready.sizeGiB).toBe(1200);
    const net = netGroup(w).id;
    expect(ingress(w, group.id)).toEqual(
      [
        ['tcp', 988, 988, net],
        ['tcp', 988, 988, group.id],
        ['tcp', 1018, 1023, net],
        ['tcp', 1018, 1023, group.id],
      ].sort(),
    );
    // Found again by its tag across pages: nothing more is created.
    w.fsx.pageSize = 1;
    w.fsx.fileSystems.set('fs-00000000000000aaa', { ...fs!, id: 'fs-00000000000000aaa', token: 'x', tags: new Map() });
    const creates = w.emu.calls('CreateFileSystem').length;
    expect((await w.filesystems.ensureFilesystem(lustre, w.call())).state).toBe('ready');
    expect(w.emu.calls('CreateFileSystem')).toHaveLength(creates);
  });

  it('persistent is PERSISTENT_2 at 125 MB/s/TiB with the account key, and its delete skips the backup', async () => {
    const w = await world({ kmsKeyId: 'arn:aws:kms:us-east-1:222222222222:key/abc' });
    await w.network();
    const spec = { ...lustre, deployment: 'persistent', sizeGiB: 2400, zone: 'us-east-1b' } as const;
    expect((await w.settle(() => w.filesystems.ensureFilesystem(spec, w.call()))).state).toBe('ready');
    const [fs] = [...w.fsx.fileSystems.values()];
    expect(fs).toMatchObject({
      capacity: 2400,
      deploymentType: 'PERSISTENT_2',
      perUnitStorageThroughput: 125,
      kmsKeyId: 'arn:aws:kms:us-east-1:222222222222:key/abc',
    });
    expect(w.vpc.subnets.get(fs!.subnetIds[0]!)!.zone).toBe('us-east-1b');
    const id = fs!.id;
    expect((await w.settle(() => w.filesystems.deleteFilesystem('bc-fs-2', w.call()))).state).toBe(
      'deleted',
    );
    const request = w.emu.calls('DeleteFileSystem')[0]!;
    expect(JSON.parse(request.body)).toEqual({
      FileSystemId: id,
      LustreConfiguration: { SkipFinalBackup: true },
    });
    expect(w.fsx.fileSystems.size).toBe(0);
    expect(fsGroup(w, 'bc-fs-2')).toBeUndefined();
  });

  it('a scratch delete sends no backup option', async () => {
    const w = await world();
    await w.network();
    await w.settle(() => w.filesystems.ensureFilesystem(lustre, w.call()));
    await w.settle(() => w.filesystems.deleteFilesystem('bc-fs-2', w.call()));
    expect(Object.keys(JSON.parse(w.emu.calls('DeleteFileSystem')[0]!.body))).toEqual(['FileSystemId']);
  });
});

describe('filesystems: mounts in user data', () => {
  const decode = (base64: string) => Buffer.from(base64, 'base64').toString('utf8');
  const efsMount = {
    fstype: 'nfs4',
    source: 'fs-0123456789abcdef0.efs.us-east-1.amazonaws.com:/',
    path: '/mnt/shared',
    options: efsMountOptions,
  } as const;
  const lustreMount = {
    fstype: 'lustre',
    source: 'fs-0123456789abcdef1.fsx.us-east-1.amazonaws.com@tcp:/abcdefgh',
    path: '/scratch',
    options: lustreMountOptions,
  } as const;

  it('packs a shell part that mounts each filesystem, beside the tenant part', () => {
    const packed = packUserData('#!/bin/sh\necho hi\n', undefined, [efsMount, lustreMount]);
    const text = decode(packed.base64);
    expect(text).toMatch(/^Content-Type: multipart\/mixed; boundary="bc-[0-9a-f]{32}"/);
    expect(text.match(/Content-Type: text\/x-shellscript/g)).toHaveLength(2);
    // The mounts come first, so the tenant's script finds them.
    expect(text.indexOf('# better-compute: filesystem mounts')).toBeLessThan(text.indexOf('echo hi'));
    expect(text).toContain("mkdir -p '/mnt/shared'");
    expect(text).toContain(
      `'fs-0123456789abcdef0.efs.us-east-1.amazonaws.com:/ /mnt/shared nfs4 ${efsMountOptions},nofail 0 0'`,
    );
    expect(text).toContain('nfs-utils');
    expect(text).toContain('lustre-client');
    expect(text).toContain(`/scratch lustre ${lustreMountOptions},nofail 0 0`);
    // The same input packs to the same bytes.
    expect(packUserData('#!/bin/sh\necho hi\n', undefined, [efsMount, lustreMount])).toEqual(packed);
  });

  it('ssh keys alone pack exactly as before', () => {
    const keys = ['ssh-ed25519 AAAA test'];
    expect(packUserData('#cloud-config\n', keys, [])).toEqual(packUserData('#cloud-config\n', keys));
  });

  it('refuses mounts it did not render: other sources, unsafe paths or options, duplicates', () => {
    for (const mount of [
      { ...efsMount, source: 'evil.example.com:/' },
      { ...efsMount, source: 'fs-0123456789abcdef0.efs.us-east-1.amazonaws.com:/;reboot' },
      { ...lustreMount, source: 'fs-0123456789abcdef0.efs.us-east-1.amazonaws.com:/' },
      { ...efsMount, path: 'relative' },
      { ...efsMount, path: '/mnt/../etc' },
      { ...efsMount, path: '/etc/cron.d' },
      { ...efsMount, path: '/' },
      { ...efsMount, path: "/mnt/a'b" },
      { ...efsMount, options: 'rw;reboot' },
      { ...efsMount, fstype: 'ext4' },
    ])
      expect(() => packUserData('', undefined, [mount as never])).toThrow(
        expect.objectContaining({ code: 'INVALID_INPUT', details: expect.objectContaining({ reason: 'mount' }) }),
      );
    expect(() => packUserData('', undefined, [efsMount, efsMount])).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    );
  });

  it('create on a network passes the mounts into RunInstances user data', async () => {
    const w = await world();
    await w.network();
    const ready = await w.settle(() => w.filesystems.ensureFilesystem(nfs, w.call()));
    await w.impl.create(
      {
        offerId: 'us-east-1a/t3.micro',
        image: 'ubuntu-24.04',
        userData: '#cloud-config\n',
        name: 'vm-ins_1',
        network: { network: 'bc-net-1' },
        mounts: [{ ...ready.mount!, path: '/mnt/data' }],
      },
      w.call('ins_1'),
    );
    const userData = decode(w.emu.calls('RunInstances')[0]!.params.get('UserData')!);
    expect(userData).toContain(`${ready.mount!.source} /mnt/data nfs4`);
  });
});

describe('filesystems: aws iam-policy --phases A10', () => {
  const sid = (name: string) =>
    iamPolicy({ ml: true, region: 'us-east-1', account: '222222222222' }).Statement.find(
      (statement) => statement.Sid === name,
    );

  it('creates only tagged managed, changes and deletes only managed file systems', () => {
    expect(sid('FilesystemRead')).toMatchObject({
      Action: ['elasticfilesystem:DescribeFileSystems', 'elasticfilesystem:DescribeMountTargets', 'fsx:DescribeFileSystems'],
      Resource: '*',
    });
    expect(sid('FilesystemCreate')).toEqual({
      Sid: 'FilesystemCreate',
      Effect: 'Allow',
      Action: ['elasticfilesystem:CreateFileSystem', 'fsx:CreateFileSystem'],
      Resource: [
        'arn:aws:elasticfilesystem:us-east-1:222222222222:file-system/*',
        'arn:aws:fsx:us-east-1:222222222222:file-system/*',
      ],
      Condition: { StringEquals: { 'aws:RequestTag/better-compute:managed': 'true' } },
    });
    expect(sid('FilesystemManageOwned')).toEqual({
      Sid: 'FilesystemManageOwned',
      Effect: 'Allow',
      Action: [
        'elasticfilesystem:CreateMountTarget',
        'elasticfilesystem:DeleteMountTarget',
        'elasticfilesystem:DeleteFileSystem',
        'fsx:DeleteFileSystem',
      ],
      Resource: [
        'arn:aws:elasticfilesystem:us-east-1:222222222222:file-system/*',
        'arn:aws:fsx:us-east-1:222222222222:file-system/*',
      ],
      Condition: { StringEquals: { 'aws:ResourceTag/better-compute:managed': 'true' } },
    });
    // Tags only as part of a create, never on an existing file system.
    expect(sid('FilesystemTagOnCreate')).toMatchObject({
      Action: 'elasticfilesystem:TagResource',
      Condition: { StringEquals: { 'elasticfilesystem:CreateAction': 'CreateFileSystem' } },
    });
    // EC2 describes have no resource-level permissions: Resource '*' or they never match.
    expect(sid('FilesystemEc2Read')).toEqual({
      Sid: 'FilesystemEc2Read',
      Effect: 'Allow',
      Action: ['ec2:DescribeSubnets', 'ec2:DescribeNetworkInterfaces', 'ec2:DescribeSecurityGroups'],
      Resource: '*',
    });
    // CreateMountTarget needs the caller's ec2:CreateNetworkInterface (as EFS documents), in this
    // account and region only, with no aws:CalledVia (EFS is not among the services that set it).
    expect(sid('FilesystemMountTargetInterfaces')).toEqual({
      Sid: 'FilesystemMountTargetInterfaces',
      Effect: 'Allow',
      Action: ['ec2:CreateNetworkInterface', 'ec2:DeleteNetworkInterface'],
      Resource: [
        'arn:aws:ec2:us-east-1:222222222222:network-interface/*',
        'arn:aws:ec2:us-east-1:222222222222:subnet/*',
        'arn:aws:ec2:us-east-1:222222222222:security-group/*',
      ],
    });
    expect(JSON.stringify(iamPolicy({ ml: true }))).not.toContain('aws:CalledVia');
    // A fresh account's first EFS or FSx create makes the service-linked role.
    expect(sid('FilesystemServiceRoles')).toEqual({
      Sid: 'FilesystemServiceRoles',
      Effect: 'Allow',
      Action: 'iam:CreateServiceLinkedRole',
      Resource: [
        'arn:aws:iam::222222222222:role/aws-service-role/elasticfilesystem.amazonaws.com/*',
        'arn:aws:iam::222222222222:role/aws-service-role/fsx.amazonaws.com/*',
      ],
      Condition: {
        StringEquals: {
          'iam:AWSServiceName': ['elasticfilesystem.amazonaws.com', 'fsx.amazonaws.com'],
        },
      },
    });
    // Describes never sit in a statement scoped to resource ARNs.
    for (const statement of iamPolicy({ ml: true, region: 'us-east-1', account: '222222222222' })
      .Statement)
      if (statement.Resource !== '*')
        for (const action of [statement.Action].flat())
          expect(action, statement.Sid).not.toMatch(/^ec2:Describe/);
    expect(JSON.stringify(iamPolicy())).not.toContain('elasticfilesystem');
  });

  it('every EFS and FSx call the provider makes is an action the policy names', async () => {
    const w = await world();
    await w.network();
    await w.settle(() => w.filesystems.ensureFilesystem(nfs, w.call()));
    await w.settle(() => w.filesystems.ensureFilesystem(lustre, w.call()));
    await w.settle(() => w.filesystems.deleteFilesystem('bc-fs-1', w.call()));
    await w.settle(() => w.filesystems.deleteFilesystem('bc-fs-2', w.call()));
    const actions = new Set(
      iamPolicy({ ml: true }).Statement.flatMap((statement) => [statement.Action].flat()),
    );
    const efsActions: Record<string, string> = {
      'POST /2015-02-01/file-systems': 'CreateFileSystem',
      'GET /2015-02-01/file-systems': 'DescribeFileSystems',
      'POST /2015-02-01/mount-targets': 'CreateMountTarget',
      'GET /2015-02-01/mount-targets': 'DescribeMountTargets',
    };
    for (const request of w.emu.requests) {
      if (request.service === 'fsx') expect(actions, request.operation).toContain(`fsx:${request.operation}`);
      if (request.service !== 'elasticfilesystem') continue;
      const action =
        efsActions[request.operation] ??
        (request.operation.startsWith('DELETE /2015-02-01/mount-targets/')
          ? 'DeleteMountTarget'
          : request.operation.startsWith('DELETE /2015-02-01/file-systems/')
            ? 'DeleteFileSystem'
            : request.operation);
      expect(actions, request.operation).toContain(`elasticfilesystem:${action}`);
    }
  });
});
