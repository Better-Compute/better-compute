import { describe, expect, it } from 'vitest';
import {
  assertRegion,
  endpointFor,
  formatArn,
  parseArn,
  partitionOf,
  signingRegionFor,
} from '@better-compute/aws-core';

describe('aws-core endpoints', () => {
  it('accepts real regions', () => {
    for (const region of [
      'us-east-1',
      'eu-central-2',
      'ap-southeast-5',
      'us-gov-west-1',
      'cn-northwest-1',
      'il-central-1',
      'mx-central-1',
    ])
      expect(assertRegion(region)).toBe(region);
  });

  it('refuses host injection', () => {
    for (const region of [
      'us-east-1.evil.com',
      'us-east-1/',
      'US-EAST-1',
      'us-east-1@x',
      '',
      'us-east-1 ',
      'xx-east-1',
    ])
      expect(() => assertRegion(region)).toThrow(
        expect.objectContaining({ code: 'INVALID_CONFIG' }),
      );
  });

  it('knows the partition of a region', () => {
    expect(partitionOf('us-east-1')).toEqual({ partition: 'aws', dnsSuffix: 'amazonaws.com' });
    expect(partitionOf('cn-north-1')).toEqual({
      partition: 'aws-cn',
      dnsSuffix: 'amazonaws.com.cn',
    });
    expect(partitionOf('us-gov-east-1').partition).toBe('aws-us-gov');
  });

  it('builds regional and global endpoints', () => {
    expect(endpointFor('ec2', 'us-east-1').host).toBe('ec2.us-east-1.amazonaws.com');
    expect(endpointFor('ec2', 'us-east-1').protocol).toBe('https:');
    expect(endpointFor('ec2', 'cn-north-1').host.endsWith('.amazonaws.com.cn')).toBe(true);
    expect(endpointFor('sts', 'eu-west-1').host).toBe('sts.eu-west-1.amazonaws.com');
    expect(endpointFor('iam', 'eu-west-1').host).toBe('iam.amazonaws.com');
    expect(endpointFor('iam', 'cn-north-1').host).toBe('iam.cn-north-1.amazonaws.com.cn');
    expect(endpointFor('iam', 'us-gov-east-1').host).toBe('iam.us-gov.amazonaws.com');
    expect(endpointFor('pricing', 'eu-west-1').host).toBe('api.pricing.us-east-1.amazonaws.com');
    expect(endpointFor('ce', 'eu-west-1').host).toBe('ce.us-east-1.amazonaws.com');
    expect(endpointFor('organizations', 'eu-west-1').host).toBe(
      'organizations.us-east-1.amazonaws.com',
    );
    expect(signingRegionFor('iam', 'us-gov-east-1')).toBe('us-gov-west-1');
    expect(signingRegionFor('iam', 'cn-northwest-1')).toBe('cn-north-1');
    expect(signingRegionFor('iam', 'eu-west-1')).toBe('us-east-1');
    expect(signingRegionFor('ec2', 'eu-west-1')).toBe('eu-west-1');
    expect(signingRegionFor('sts', 'eu-west-1')).toBe('eu-west-1');
  });

  it('builds FIPS and dual-stack endpoints', () => {
    expect(endpointFor('ec2', 'us-east-1', { fips: true }).host).toBe(
      'ec2-fips.us-east-1.amazonaws.com',
    );
    expect(endpointFor('ec2', 'us-east-1', { dualStack: true }).host).toBe('ec2.us-east-1.api.aws');
    expect(endpointFor('sqs', 'us-east-1', { dualStack: true }).host).toBe(
      'sqs.dualstack.us-east-1.amazonaws.com',
    );
  });

  it('override wins but only as a URL', () => {
    expect(endpointFor('ec2', 'us-east-1', { override: 'http://localhost:4566' }).href).toBe(
      'http://localhost:4566/',
    );
    for (const override of ['nope', 'ftp://x', 'http://user:pass@host/'])
      expect(() => endpointFor('ec2', 'us-east-1', { override })).toThrow(
        expect.objectContaining({ code: 'INVALID_CONFIG' }),
      );
    expect(() => endpointFor('ec2', 'us-east-1.evil.com')).toThrow(
      expect.objectContaining({ code: 'INVALID_CONFIG' }),
    );
  });

  it('parses and formats ARNs in every partition', () => {
    for (const text of [
      'arn:aws:iam::222222222222:role/path/to/role',
      'arn:aws-cn:ec2:cn-north-1:333333333333:instance/i-0abc12345678def01',
      'arn:aws-us-gov:s3:::bucket/key:with:colons',
    ]) {
      const arn = parseArn(text);
      expect(formatArn(arn)).toBe(text);
    }
    expect(parseArn('arn:aws:iam::222222222222:role/x')).toEqual({
      partition: 'aws',
      service: 'iam',
      region: '',
      account: '222222222222',
      resource: 'role/x',
    });
    for (const bad of [
      'arn:aws:iam',
      'arn:evil:iam::222222222222:role/x',
      'arn:aws:iam::22222:role/x',
      'nope',
      'arn:aws:iam::222222222222:',
    ])
      expect(() => parseArn(bad)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });
});
