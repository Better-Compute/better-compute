import { describe, expect, it } from 'vitest';
import { maskedValue, type Logger, type ProviderContext } from '@better-compute/core';
import { ec2Client, parseXml } from '@better-compute/aws-core';
import {
  accountCredentials,
  AwsCompute,
  awsConfig,
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
