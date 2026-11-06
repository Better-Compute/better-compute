import { randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  isComputeError,
  maskedValue,
  type CallContext,
  type ComputeError,
  type Logger,
  type ProviderContext,
} from '@better-compute/core';
import { ec2Client, parseXml } from '@better-compute/aws-core';
import {
  accountCredentials,
  AwsCompute,
  awsConfig,
  awsProvider,
  machineState,
  packUserData,
  gpuModel,
  instanceTypeCache,
  parseInstanceTypes,
  zoneCache,
  clientToken,
  offerId,
  parseInstanceId,
  parseOfferId,
  tagValue,
  validateAwsConfig,
  type AwsConfig,
} from '@better-compute/provider-aws';
import { AwsEmulator } from './support/aws-emulator/index.js';
import { Ec2Emulator } from './support/aws-emulator/ec2.js';

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const signal = new AbortController().signal;

/** An emulated platform account in us-east-1 and its EC2 client, built without the provider wrapper. */
function directWorld(overrides: Partial<AwsConfig> = {}) {
  const emu = new AwsEmulator();
  const ec2emu = new Ec2Emulator(emu);
  const config = {
    ...(awsConfig.parse({ region: 'us-east-1', zones: ['us-east-1a', 'us-east-1b'] }) as AwsConfig),
    ...overrides,
  };
  const context: ProviderContext = {
    clock: emu.clock,
    log: quiet,
    secrets: { resolve: async () => '' },
    account: { id: 'pa_platform', tenantId: 'root', platform: true },
  };
  const options = { fetch: emu.fetch, credentials: emu.ambient };
  const account = accountCredentials(config, context, options);
  const ec2 = ec2Client({ region: config.region, credentials: account.source, fetch: emu.fetch, clock: emu.clock });
  const compute = new AwsCompute(config, context, options, {
    ec2,
    account,
    types: instanceTypeCache(ec2, { clock: emu.clock }),
    zones: zoneCache(ec2, { clock: emu.clock }),
  });
  return { emu, ec2emu, compute, ec2, config };
}

const base = (overrides: Partial<AwsConfig> = {}): AwsConfig => ({
  ...(awsConfig.parse({ region: 'us-east-1', zones: ['us-east-1a'] }) as AwsConfig),
  ...overrides,
});

describe('config & ids', () => {
  it('config parses with defaults', () => {
    const config = awsConfig.parse({ region: 'us-east-1', zones: ['us-east-1a'] });
    expect(config).toMatchObject({
      region: 'us-east-1',
      zones: ['us-east-1a'],
      rootVolumeGiB: 100,
      rootVolumeType: 'gp3',
      metadataHopLimit: 1,
      associatePublicIp: true,
    });
    expect(() => awsConfig.parse({ region: 'us-east-1', zones: [] })).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    );
    expect(() => awsConfig.parse({ region: 'us-east-1', zones: ['us-east-1a'], rootVolumeGiB: 4 })).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    );
  });

  it('semantic validation refuses foreign zones and bad regions', () => {
    let error: unknown;
    try {
      validateAwsConfig(base({ zones: ['us-west-2a'] }));
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: 'INVALID_CONFIG' });
    expect((error as Error).message).toContain('us-west-2a');
    expect(() => validateAwsConfig(base({ region: 'us-east-1.evil' }))).toThrow(
      expect.objectContaining({ code: 'INVALID_CONFIG' }),
    );
    expect(() => validateAwsConfig(base({ zones: ['us-east-1a', 'us-east-10a'] }))).toThrow(
      expect.objectContaining({ code: 'INVALID_CONFIG' }),
    );
    expect(() => validateAwsConfig(base({ region: 'us-west-2', zones: ['us-west-2-lax-1a', 'us-west-2b'] }))).not.toThrow();
    expect(() => validateAwsConfig(base({ discoverTag: 'novalue' }))).toThrow(
      expect.objectContaining({ code: 'INVALID_CONFIG' }),
    );
  });

  it('config refuses a malformed assumeRoleArn', () => {
    for (const assumeRoleArn of [
      'arn:aws:iam::12345:role/x',
      'arn:aws:s3:::bucket',
      'arn:aws:iam::222222222222:user/x',
      'not-an-arn',
      'arn:aws-cn:iam::222222222222:role/x',
    ])
      expect(() => validateAwsConfig(base({ assumeRoleArn }))).toThrow(
        expect.objectContaining({ code: 'INVALID_CONFIG' }),
      );
    expect(() =>
      validateAwsConfig(base({ assumeRoleArn: 'arn:aws:iam::222222222222:role/path/better-compute' })),
    ).not.toThrow();
    expect(() =>
      validateAwsConfig(
        base({ region: 'cn-north-1', zones: ['cn-north-1a'], assumeRoleArn: 'arn:aws-cn:iam::222222222222:role/x' }),
      ),
    ).not.toThrow();
  });

  it('config redacts nothing but credentials', () => {
    const config = {
      ...base(),
      credentials: 'secret://aws/key',
      assumeRoleArn: 'arn:aws:iam::222222222222:role/x',
      subnetId: 'subnet-0123456789abcdef0',
    };
    const redacted = awsConfig.redact(config);
    expect(redacted.credentials).toBe(maskedValue);
    expect(redacted.assumeRoleArn).toBe(config.assumeRoleArn);
    expect(redacted.subnetId).toBe(config.subnetId);
    expect('externalId' in awsConfig.fields).toBe(false);
  });

  it('offer ids round-trip', () => {
    for (const id of [
      'us-east-1a/p5.48xlarge',
      'us-east-1a/p5.48xlarge@cr-0123456789abcdef0',
      'us-east-1b/g6.xlarge:spot',
      'us-west-2-lax-1a/m7i.large',
    ])
      expect(offerId(parseOfferId(id))).toBe(id);
    expect(parseOfferId('us-east-1b/g6.xlarge:spot')).toEqual({
      zone: 'us-east-1b',
      instanceType: 'g6.xlarge',
      market: 'spot',
    });
    for (const bad of ['us-east-1a/', 'a/b@x', 'us-east-1a/p5.48xlarge@cr-xyz', 'us-east-1a/../x', ''])
      expect(() => parseOfferId(bad)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });

  it('client token is stable and 64 hex chars', () => {
    expect(clientToken('ins_test1')).toMatch(/^[0-9a-f]{64}$/);
    expect(clientToken('ins_test1')).toBe(clientToken('ins_test1'));
    expect(clientToken('ins_test1')).not.toBe(clientToken('ins_test2'));
  });

  it('instance ids are validated', () => {
    expect(parseInstanceId('i-0abc12345678def01')).toBe('i-0abc12345678def01');
    for (const bad of ['i-xyz', 'vol-0abc12345678def01', 'i-0abc12345678def01 ', ''])
      expect(() => parseInstanceId(bad)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });

  it('tag values keep only what EC2 accepts', () => {
    expect(tagValue('web-1 <script>')).toBe('web-1 script');
    expect(tagValue('x'.repeat(300))).toHaveLength(256);
  });
});

describe('offers', () => {
  it('parses vcpu, memory, gpus, arch, metal and EFA', async () => {
    const { ec2 } = directWorld();
    const doc = await ec2.call('DescribeInstanceTypes', { InstanceType: ['p5.48xlarge'] }, { signal });
    const [p5] = parseInstanceTypes(doc.items('instanceTypeSet'));
    expect(p5).toEqual({
      type: 'p5.48xlarge',
      vcpu: 192,
      memoryGiB: 2048,
      arch: ['x86_64'],
      gpus: { model: 'H100', count: 8 },
      bareMetal: false,
      instanceStorageGiB: 30_400,
      efa: true,
      maxEfaInterfaces: 32,
    });
    const doc2 = await ec2.call('DescribeInstanceTypes', { InstanceType: ['m7g.large', 'c7i.metal-24xl'] }, { signal });
    const parsed = parseInstanceTypes(doc2.items('instanceTypeSet'));
    expect(parsed.map((t) => [t.type, t.arch, t.bareMetal])).toEqual([
      ['m7g.large', ['arm64'], false],
      ['c7i.metal-24xl', ['x86_64'], true],
    ]);
    expect(gpuModel('NVIDIA', 'T4g')).toBe('T4');
    expect(gpuModel('NVIDIA', 'A10G')).toBe('A10G');
    expect(gpuModel('AMD', 'Radeon Pro V520')).toBe('other');
    expect(gpuModel('NVIDIA', 'Mystery')).toBe('other');
    expect(parseInstanceTypes(parseXml('<x><instanceTypeSet><item><vCpuInfo/></item></instanceTypeSet></x>').items('instanceTypeSet'))).toEqual([]);
  });

  it('lists offers in configured zones only', async () => {
    const { compute } = directWorld({ zones: ['us-east-1a', 'us-east-1b'] });
    const offers = await compute.listOffers({});
    const ids = offers.map((offer) => offer.id);
    expect(ids).toContain('us-east-1a/p5.48xlarge');
    expect(ids).not.toContain('us-east-1b/p5.48xlarge');
    expect(ids.some((id) => id.startsWith('us-east-1c/'))).toBe(false);
    expect(offers.find((offer) => offer.id === 'us-east-1b/m7i.large')).toEqual({
      id: 'us-east-1b/m7i.large',
      kind: 'vps',
      region: 'us-east-1',
      vcpu: 2,
      memoryGiB: 8,
      diskGiB: 100,
      available: true,
    });
  });

  it('filters by gpu model and count', async () => {
    const { compute } = directWorld();
    expect((await compute.listOffers({ gpuModel: 'H100', minGpus: 8 })).map((o) => o.id)).toEqual(['us-east-1a/p5.48xlarge']);
    expect((await compute.listOffers({ gpuModel: 'L4' })).map((o) => o.id)).toEqual(['us-east-1a/g6.xlarge', 'us-east-1b/g6.xlarge']);
    expect((await compute.listOffers({ minVcpu: 100 })).map((o) => o.id)).toEqual(['us-east-1a/p5.48xlarge']);
    expect((await compute.listOffers({ minMemoryGiB: 16 })).every((o) => o.memoryGiB >= 16)).toBe(true);
  });

  it('skips bare metal', async () => {
    const { compute } = directWorld();
    expect((await compute.listOffers({})).some((o) => o.id.includes('metal'))).toBe(false);
    expect(await compute.listOffers({ kind: 'metal' })).toEqual([]);
  });

  it('another region yields nothing', async () => {
    const { compute, emu } = directWorld();
    expect(await compute.listOffers({ region: 'eu-west-1' })).toEqual([]);
    expect(emu.calls('DescribeInstanceTypeOfferings')).toHaveLength(0);
  });

  it('caches instance types for a day', async () => {
    const { compute, emu } = directWorld();
    await compute.listOffers({});
    const first = emu.calls('DescribeInstanceTypes').length;
    expect(first).toBeGreaterThan(0);
    await compute.listOffers({});
    expect(emu.calls('DescribeInstanceTypes')).toHaveLength(first);
    emu.clock.advance(25 * 3_600_000);
    await compute.listOffers({});
    expect(emu.calls('DescribeInstanceTypes').length).toBeGreaterThan(first);
    // Offerings are paged (the emulator's page size is 2) and cached for an hour.
    const offeringCalls = emu.calls('DescribeInstanceTypeOfferings').length;
    await compute.listOffers({});
    expect(emu.calls('DescribeInstanceTypeOfferings')).toHaveLength(offeringCalls);
  });

  it('zone ids resolve from DescribeAvailabilityZones', async () => {
    const { ec2, emu } = directWorld();
    const zones = zoneCache(ec2, { clock: emu.clock });
    expect(await zones.zoneId('us-east-1a', signal)).toBe('use1-az1');
    expect(await zones.zoneId('us-east-1c', signal)).toBe('use1-az4');
    expect(await zones.zoneId('us-east-1z', signal)).toBeUndefined();
    expect(emu.calls('DescribeAvailabilityZones')).toHaveLength(1);
  });
});

/** An emulated platform account through the provider definition. */
async function providerWorld(overrides: Record<string, unknown> = {}, options: Record<string, unknown> = {}) {
  const emu = new AwsEmulator();
  const ec2emu = new Ec2Emulator(emu);
  const records: string[] = [];
  const log: Logger = {
    debug: (m, f) => records.push(`${m} ${JSON.stringify(f ?? {})}`),
    info: (m, f) => records.push(`${m} ${JSON.stringify(f ?? {})}`),
    warn: (m, f) => records.push(`${m} ${JSON.stringify(f ?? {})}`),
    error: (m, f) => records.push(`${m} ${JSON.stringify(f ?? {})}`),
  };
  const provider = awsProvider({ fetch: emu.fetch, credentials: emu.ambient, ...options });
  const config = awsConfig.parse({ region: 'us-east-1', zones: ['us-east-1a', 'us-east-1b'], ...overrides }) as AwsConfig;
  const impl = (await provider.create(config, {
    clock: emu.clock,
    log,
    secrets: { resolve: async () => '' },
    account: { id: 'pa_platform', tenantId: 'root', platform: true },
  })) as AwsCompute;
  const call = (key = 'ins_test1'): CallContext => ({
    idempotencyKey: key,
    signal: new AbortController().signal,
    clock: emu.clock,
    secrets: { resolve: async () => '' },
    log,
  });
  const create = (key = 'ins_test1', request: Partial<Parameters<AwsCompute['create']>[0]> = {}) =>
    impl.create(
      { offerId: 'us-east-1a/t3.micro', image: 'ubuntu-24.04', userData: '#cloud-config\n', name: `vm-${key}`, ...request },
      call(key),
    );
  return { emu, ec2emu, provider, impl, call, create, records, config };
}

async function rejection(run: () => Promise<unknown>): Promise<ComputeError> {
  try {
    await run();
  } catch (error) {
    expect(isComputeError(error)).toBe(true);
    return error as ComputeError;
  }
  throw new Error('expected a failure');
}

describe('compute', () => {
  it('create sends a hardened RunInstances', async () => {
    const { emu, create } = await providerWorld();
    const machine = await create('ins_test1', { labels: { team: 'ml', managed: 'false' } });
    expect(machine.id).toMatch(/^i-[0-9a-f]{17}$/);
    expect(machine.state).toBe('pending');
    expect(machine.offerId).toBe('us-east-1a/t3.micro');
    expect(machine.labels?.['topology.aws/zone-id']).toBe('use1-az1');
    const [run] = emu.calls('RunInstances');
    const p = run!.params;
    expect(p.get('MetadataOptions.HttpTokens')).toBe('required');
    expect(p.get('MetadataOptions.HttpPutResponseHopLimit')).toBe('1');
    expect(p.get('MetadataOptions.InstanceMetadataTags')).toBe('disabled');
    expect(p.get('BlockDeviceMapping.1.DeviceName')).toBe('/dev/sda1');
    expect(p.get('BlockDeviceMapping.1.Ebs.Encrypted')).toBe('true');
    expect(p.get('BlockDeviceMapping.1.Ebs.VolumeSize')).toBe('100');
    expect(p.get('BlockDeviceMapping.1.Ebs.VolumeType')).toBe('gp3');
    expect(p.get('InstanceInitiatedShutdownBehavior')).toBe('stop');
    expect(p.get('ClientToken')).toBe(clientToken('ins_test1'));
    expect(p.get('ImageId')).toBe(
      'resolve:ssm:/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id',
    );
    const specs = [1, 2].map((n) => {
      const out: Record<string, string> = {};
      for (let m = 1; p.has(`TagSpecification.${n}.Tag.${m}.Key`); m++)
        out[p.get(`TagSpecification.${n}.Tag.${m}.Key`)!] = p.get(`TagSpecification.${n}.Tag.${m}.Value`)!;
      return [p.get(`TagSpecification.${n}.ResourceType`), out] as const;
    });
    expect(specs.map(([type]) => type)).toEqual(['instance', 'volume']);
    for (const [, tagged] of specs)
      expect(tagged).toEqual({
        Name: 'vm-ins_test1',
        'better-compute:managed': 'true',
        'better-compute:instance': 'ins_test1',
        'better-compute:team': 'ml',
      });
  });

  it('arm64 types get arm64 images', async () => {
    const { emu, create } = await providerWorld();
    await create('ins_arm', { offerId: 'us-east-1a/m7g.large', image: 'al2023' });
    const [run] = emu.calls('RunInstances');
    expect(run!.params.get('ImageId')).toBe('resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64');
    expect(run!.params.get('BlockDeviceMapping.1.DeviceName')).toBe('/dev/xvda');
  });

  it('raw images: an AMI reads its root device, an SSM parameter omits the mapping', async () => {
    const { emu, create, records } = await providerWorld();
    await create('ins_ami', { image: 'ami-0123456789abcdef0' });
    expect(emu.calls('RunInstances')[0]!.params.get('BlockDeviceMapping.1.DeviceName')).toBe('/dev/xvda');
    await create('ins_ssm', { image: 'resolve:ssm:/my/team/ami' });
    expect(emu.calls('RunInstances')[1]!.params.has('BlockDeviceMapping.1.DeviceName')).toBe(false);
    expect(records.some((line) => line.includes('unknown root device'))).toBe(true);
    expect((await rejection(() => create('ins_bad', { image: 'windows-11' }))).code).toBe('INVALID_INPUT');
    expect((await rejection(() => create('ins_gone', { image: 'ami-00000000000000001' }))).code).toBe('INVALID_INPUT');
  });

  it('create is idempotent by client token', async () => {
    const { ec2emu, create } = await providerWorld();
    const first = await create('ins_same');
    const second = await create('ins_same');
    expect(second.id).toBe(first.id);
    expect(ec2emu.instances.size).toBe(1);
  });

  it('IdempotentParameterMismatch is CONFLICT', async () => {
    const { create } = await providerWorld();
    await create('ins_same');
    const error = await rejection(() => create('ins_same', { offerId: 'us-east-1b/t3.micro' }));
    expect(error.code).toBe('CONFLICT');
  });

  it('create refuses zones outside config', async () => {
    const { create } = await providerWorld();
    const error = await rejection(() => create('ins_z', { offerId: 'us-east-1c/t3.micro' }));
    expect(error.code).toBe('INVALID_INPUT');
  });

  it('reservation and spot offers are UNSUPPORTED until A3', async () => {
    const { create, emu } = await providerWorld();
    for (const offerId of ['us-east-1a/p5.48xlarge@cr-0123456789abcdef0', 'us-east-1a/t3.micro:spot']) {
      const error = await rejection(() => create('ins_a3', { offerId }));
      expect(error.code).toBe('UNSUPPORTED');
      expect(error.details?.reason).toBe('phase-a3');
    }
    expect(emu.calls('RunInstances')).toHaveLength(0);
  });

  it('user data packing is deterministic', () => {
    const keys = ['ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITEST test@host'];
    const big = `#cloud-config\nwrite_files:\n${'  - content: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'.repeat(400)}`;
    for (const payload of ['#cloud-config\n', big]) {
      const a = packUserData(payload, keys);
      const b = packUserData(payload, keys);
      expect(a).toEqual(b);
    }
    const gz = Buffer.from(packUserData(big, keys).base64, 'base64');
    expect([...gz.subarray(0, 2)]).toEqual([0x1f, 0x8b]);
    expect(gz.readUInt32LE(4)).toBe(0);
    expect(gz[9]).toBe(0xff);
    const text = Buffer.from(packUserData('#cloud-config\n', keys).base64, 'base64').toString('utf8');
    const boundary = /boundary="([^"]+)"/.exec(text)![1]!;
    expect(boundary).toMatch(/^bc-[0-9a-f]{32}$/);
    expect(Buffer.from(packUserData('#cloud-config\nx: 1\n', keys).base64, 'base64').toString()).not.toContain(boundary);
  });

  it('gzips user data over 16 KiB and refuses user data that stays too large', () => {
    const big = `#!/bin/sh\n${'echo hello world\n'.repeat(2000)}`;
    const packed = packUserData(big);
    expect(packed.gzipped).toBe(true);
    expect(gunzipSync(Buffer.from(packed.base64, 'base64')).toString('utf8')).toBe(big);
    expect(packUserData('#cloud-config\n').gzipped).toBe(false);
    const random = randomBytes(40 * 1024).toString('base64');
    let error: unknown;
    try {
      packUserData(random);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: 'INVALID_INPUT', details: { reason: 'user-data-too-large' } });
  });

  it('ssh keys are delivered as a cloud-config part', () => {
    const text = Buffer.from(
      packUserData('#!/bin/sh\necho hi\n', ['ssh-ed25519 AAAA key1', 'ssh-rsa BBBB key2']).base64,
      'base64',
    ).toString('utf8');
    expect(text).toContain('Content-Type: multipart/mixed');
    expect(text).toContain('ssh_authorized_keys:\n  - "ssh-ed25519 AAAA key1"\n  - "ssh-rsa BBBB key2"');
    expect(text).toContain('Content-Type: text/x-shellscript');
    expect(text).toContain('#!/bin/sh\necho hi\n');
    expect(() => packUserData('', ['ssh-ed25519 AAAA\nruncmd: [evil]'])).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    );
    expect(Buffer.from(packUserData('#cloud-config\n').base64, 'base64').toString()).toBe('#cloud-config\n');
  });

  it('get finds a just-created instance through its client token', async () => {
    const { emu, ec2emu, create, impl, call } = await providerWorld();
    ec2emu.newInstanceNotFound = { byId: 1, byToken: 0 };
    const machine = await create('ins_ec');
    const got = await impl.get(machine.id, call('ins_ec'));
    expect(got?.state).toBe('pending');
    expect(got?.offerId).toBe('us-east-1a/t3.micro');
    expect(emu.calls('DescribeInstances').some((r) => r.params.get('Filter.1.Name') === 'client-token')).toBe(true);
  });

  it('get reports pending inside the consistency window', async () => {
    const { emu, ec2emu, create, impl, call } = await providerWorld();
    ec2emu.newInstanceNotFound = { byId: 3, byToken: 3 };
    const machine = await create('ins_window');
    emu.clock.advance(60_000);
    expect(await impl.get(machine.id, call('ins_window'))).toEqual({ id: machine.id, state: 'pending', addresses: [] });
    emu.clock.advance(61_000);
    expect(await impl.get(machine.id, call('ins_window'))).toBeUndefined();
    expect(await impl.get('i-0000000000000dead', call('other'))).toBeUndefined();
    expect(await impl.get('not-an-id', call('other'))).toBeUndefined();
  });

  it('async stockout surfaces through get', async () => {
    const { ec2emu, create, impl, call } = await providerWorld();
    const machine = await create('ins_stockout');
    ec2emu.asyncFailure(machine.id, 'Server.InsufficientInstanceCapacity');
    const error = await rejection(() => impl.get(machine.id, call('ins_stockout')));
    expect(error.code).toBe('CAPACITY_UNAVAILABLE');
    ec2emu.asyncFailure(machine.id, 'Client.VolumeLimitExceeded');
    expect((await rejection(() => impl.get(machine.id, call('ins_stockout')))).code).toBe('QUOTA_EXCEEDED');
    ec2emu.asyncFailure(machine.id, 'Server.InternalError');
    expect((await impl.get(machine.id, call('ins_stockout')))?.state).toBe('error');
    ec2emu.asyncFailure(machine.id, 'Client.UserInitiatedShutdown');
    expect((await impl.get(machine.id, call('ins_stockout')))?.state).toBe('deleted');
  });

  it.each([
    ['pending', 'pending'],
    ['running', 'running'],
    ['stopping', 'stopped'],
    ['stopped', 'stopped'],
    ['shutting-down', 'deleting'],
    ['terminated', 'deleted'],
    ['rebooting', 'unknown'],
    [undefined, 'unknown'],
  ] as const)('maps states: %s', (state, expected) => {
    expect(machineState(state)).toBe(expected);
  });

  it('get maps addresses, networks, tags and claimedBy', async () => {
    const { ec2emu, impl, call } = await providerWorld();
    const foreign = ec2emu.addInstance({ tags: { Name: 'db', 'better-compute:instance': 'ins_x' } });
    foreign.groups.push({ id: 'sg-0000000000000000b', name: 'bc-0123456789abcdef' });
    const machine = await impl.get(foreign.id, call());
    expect(machine).toMatchObject({
      id: foreign.id,
      name: 'db',
      state: 'running',
      zone: 'us-east-1a',
      machineType: 't3.micro',
      vcpu: 2,
      memoryGiB: 1,
      claimedBy: 'ins_x',
      addresses: [foreign.privateIp, foreign.publicIp],
      networks: [
        {
          network: 'vpc-0000000000000000a',
          subnet: 'subnet-0000000000000000a',
          address: foreign.privateIp,
          publicAddress: foreign.publicIp,
          tags: ['bc-0123456789abcdef'],
        },
      ],
    });
  });

  it('delete refuses unmanaged instances', async () => {
    const { ec2emu, impl, call, emu } = await providerWorld();
    const foreign = ec2emu.addInstance();
    const error = await rejection(() => impl.delete(foreign.id, call()));
    expect(error).toMatchObject({ code: 'INVALID_STATE', details: { reason: 'not-managed' } });
    expect(emu.calls('TerminateInstances')).toHaveLength(0);
  });

  it('delete treats missing instances as deleted', async () => {
    const { impl, call, create, ec2emu } = await providerWorld();
    await impl.delete('i-0000000000000dead', call());
    const machine = await create('ins_del');
    await impl.delete(machine.id, call('ins_del'));
    expect(ec2emu.instances.get(machine.id)!.state).toBe('shutting-down');
    await impl.delete(machine.id, call('ins_del'));
    ec2emu.tick();
    await impl.delete(machine.id, call('ins_del'));
  });

  it('delete reports termination protection as INVALID_STATE', async () => {
    const { impl, call, create, ec2emu } = await providerWorld();
    const machine = await create('ins_protected');
    ec2emu.disableApiTermination(machine.id);
    const error = await rejection(() => impl.delete(machine.id, call('ins_protected')));
    expect(error).toMatchObject({ code: 'INVALID_STATE', details: { reason: 'termination-protected' } });
  });

  it('a tenant account is refused when the provider builds its client (F1)', async () => {
    const emu = new AwsEmulator();
    const provider = awsProvider({ fetch: emu.fetch, credentials: emu.ambient });
    const config = awsConfig.parse({ region: 'us-east-1', zones: ['us-east-1a'] }) as AwsConfig;
    const tenant = { clock: emu.clock, log: quiet, secrets: { resolve: async () => '' } };
    await expect(
      Promise.resolve().then(() =>
        provider.create(config, { ...tenant, account: { id: 'pa_t', tenantId: 't_1', platform: false } }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    await expect(
      Promise.resolve().then(() => provider.create({ ...config, zones: ['eu-west-1a'] }, tenant)),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  });
});
