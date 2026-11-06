import { describe, expect, it } from 'vitest';
import { maskedValue } from '@better-compute/core';
import {
  awsConfig,
  clientToken,
  offerId,
  parseInstanceId,
  parseOfferId,
  tagValue,
  validateAwsConfig,
  type AwsConfig,
} from '@better-compute/provider-aws';

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
