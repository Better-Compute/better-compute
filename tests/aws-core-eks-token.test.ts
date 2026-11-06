import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isComputeError, manualClock } from '@better-compute/core';
import {
  eksToken,
  eksTokenTtlSeconds,
  mapAwsError,
  type CredentialSource,
} from '@better-compute/aws-core';

// aws-core eksToken: the bearer token EKS's authenticator takes, a presigned STS GetCallerIdentity
// URL signed with the x-k8s-aws-id header naming the cluster.

const keys = { accessKeyId: 'AKIATESTEKS000000001', secretAccessKey: 'eks-secret' };
const source = (sessionToken?: string): CredentialSource => ({
  kind: 'test',
  credentials: async () => ({ ...keys, ...(sessionToken ? { sessionToken } : {}) }),
});
const now = Date.UTC(2026, 10, 5, 12, 0, 0);
const decode = (token: string): URL => {
  expect(token.startsWith('k8s-aws-v1.')).toBe(true);
  const encoded = token.slice('k8s-aws-v1.'.length);
  expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, no padding
  return new URL(Buffer.from(encoded, 'base64url').toString('utf8'));
};

describe('aws-core eksToken', () => {
  it('token is a presigned GetCallerIdentity with the cluster header', async () => {
    const token = await eksToken({
      cluster: 'bc-k-one',
      credentials: source('session-tok'),
      region: 'us-west-2',
      clock: manualClock(now),
      signal: new AbortController().signal,
    });
    const url = decode(token);
    expect(url.origin).toBe('https://sts.us-west-2.amazonaws.com');
    expect(url.pathname).toBe('/');
    expect(url.searchParams.get('Action')).toBe('GetCallerIdentity');
    expect(url.searchParams.get('Version')).toBe('2011-06-15');
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(url.searchParams.get('X-Amz-Credential')).toBe(
      `${keys.accessKeyId}/20261105/us-west-2/sts/aws4_request`,
    );
    expect(url.searchParams.get('X-Amz-Date')).toBe('20261105T120000Z');
    expect(url.searchParams.get('X-Amz-Expires')).toBe(String(eksTokenTtlSeconds));
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host;x-k8s-aws-id');
    expect(url.searchParams.get('X-Amz-Security-Token')).toBe('session-tok');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    // The secret never travels.
    expect(token).not.toContain(keys.secretAccessKey);
    expect(url.toString()).not.toContain(keys.secretAccessKey);
  });

  it('carries a SigV4 signature STS can verify (empty-payload hash, cluster header signed)', async () => {
    const token = await eksToken({
      cluster: 'bc-k-one',
      credentials: source(),
      region: 'us-east-1',
      clock: manualClock(now),
      signal: new AbortController().signal,
    });
    const url = decode(token);
    const signature = url.searchParams.get('X-Amz-Signature')!;
    const enc = (text: string) =>
      encodeURIComponent(text).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      );
    const query = [...url.searchParams.entries()]
      .filter(([key]) => key !== 'X-Amz-Signature')
      .map(([key, value]) => [enc(key), enc(value)] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => `${key}=${value}`)
      .join('&');
    const sha = (data: string) => createHash('sha256').update(data).digest('hex');
    const canonical = [
      'GET',
      '/',
      query,
      `host:${url.host}\nx-k8s-aws-id:bc-k-one\n`,
      'host;x-k8s-aws-id',
      sha(''),
    ].join('\n');
    const toSign = [
      'AWS4-HMAC-SHA256',
      '20261105T120000Z',
      '20261105/us-east-1/sts/aws4_request',
      sha(canonical),
    ].join('\n');
    const hmac = (key: Buffer | string, data: string) =>
      createHmac('sha256', key).update(data).digest();
    const key = hmac(
      hmac(hmac(hmac(`AWS4${keys.secretAccessKey}`, '20261105'), 'us-east-1'), 'sts'),
      'aws4_request',
    );
    expect(createHmac('sha256', key).update(toSign).digest('hex')).toBe(signature);
  });

  it('signs the cluster name: another cluster gets another signature', async () => {
    const base = {
      credentials: source(),
      region: 'us-east-1',
      clock: manualClock(now),
      signal: new AbortController().signal,
    };
    const one = decode(await eksToken({ ...base, cluster: 'one' }));
    const two = decode(await eksToken({ ...base, cluster: 'two' }));
    expect(one.searchParams.get('X-Amz-Signature')).not.toBe(
      two.searchParams.get('X-Amz-Signature'),
    );
    expect(one.searchParams.has('X-Amz-Security-Token')).toBe(false);
  });

  it('uses the partition of the region', async () => {
    const url = decode(
      await eksToken({
        cluster: 'c',
        credentials: source(),
        region: 'cn-north-1',
        clock: manualClock(now),
        signal: new AbortController().signal,
      }),
    );
    expect(url.host).toBe('sts.cn-north-1.amazonaws.com.cn');
  });

  it('refuses a malformed cluster name or region', async () => {
    const signal = new AbortController().signal;
    for (const cluster of ['', 'a b', 'x'.repeat(101), 'a/b', 'a\nb']) {
      const error = await eksToken({ cluster, credentials: source(), region: 'us-east-1', signal }).catch(
        (e: unknown) => e,
      );
      expect(isComputeError(error, 'INVALID_INPUT')).toBe(true);
    }
    const bad = await eksToken({
      cluster: 'ok',
      credentials: source(),
      region: 'evil.example.com',
      signal,
    }).catch((e: unknown) => e);
    expect(isComputeError(bad, 'INVALID_CONFIG')).toBe(true);
  });
});

describe('aws-core EKS error codes', () => {
  it('maps the EKS rest-json errors', () => {
    const cases: [string, string][] = [
      ['InvalidParameterException', 'INVALID_INPUT'],
      ['UnsupportedAvailabilityZoneException', 'INVALID_INPUT'],
      ['InvalidRequestException', 'INVALID_STATE'],
      ['ResourceInUseException', 'INVALID_STATE'],
      ['ResourceNotFoundException', 'NOT_FOUND'],
      ['ResourceLimitExceededException', 'QUOTA_EXCEEDED'],
      ['ServerException', 'UNAVAILABLE'],
      ['ServiceUnavailableException', 'UNAVAILABLE'],
    ];
    for (const [code, expected] of cases)
      expect(mapAwsError({ status: 400, code, service: 'eks' }).code).toBe(expected);
  });
});
