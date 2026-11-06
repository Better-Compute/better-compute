import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ComputeError } from '@better-compute/core';
import {
  canonicalRequest,
  presignUrl,
  signRequest,
  signingKeyCacheSize,
  type SigningInput,
} from '@better-compute/aws-core';

const root = fileURLToPath(new URL('./fixtures/aws-sigv4/', import.meta.url));
const credentials = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
};
// The suite's own fixed date: input data, not the wall clock.
const suiteNow = Date.UTC(2015, 7, 30, 12, 36, 0);

function cases(dir = root, prefix = ''): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (!statSync(path).isDirectory()) continue;
    if (existsSync(join(path, `${entry}.req`))) found.push(`${prefix}${entry}`);
    else found.push(...cases(path, `${prefix}${entry}/`));
  }
  return found.sort();
}

function load(name: string): { input: SigningInput; creq?: string; authz: string } {
  const base = name.split('/').pop()!;
  const file = (ext: string) => join(root, name, `${base}.${ext}`);
  const raw = readFileSync(file('req'), 'utf8').replace(/\r\n/g, '\n');
  const [head, ...rest] = raw.split('\n\n');
  const [requestLine, ...headerLines] = head!.split('\n');
  const [method, target] = requestLine!.split(' ');
  const headers: Record<string, string> = {};
  let host = '';
  for (const line of headerLines) {
    const colon = line.indexOf(':');
    const key = line.slice(0, colon);
    const value = line.slice(colon + 1);
    if (key.toLowerCase() === 'host') {
      host = value.trim();
      continue;
    }
    headers[key] = headers[key] === undefined ? value : `${headers[key]},${value}`;
  }
  return {
    input: {
      method: method!,
      url: new URL(`https://${host}${target}`),
      headers,
      body: rest.join('\n\n'),
      service: 'service',
      region: 'us-east-1',
      credentials,
      now: suiteNow,
    },
    creq: existsSync(file('creq')) ? readFileSync(file('creq'), 'utf8') : undefined,
    authz: readFileSync(file('authz'), 'utf8').trim(),
  };
}

describe('aws-core SigV4', () => {
  it('vendors the expected suite cases', () => {
    expect(cases().length).toBeGreaterThanOrEqual(10);
  });

  it.each(cases())('matches the AWS test suite: %s', (name) => {
    const { input, creq, authz } = load(name);
    if (creq !== undefined) expect(canonicalRequest(input).canonical).toBe(creq);
    expect(signRequest(input).authorization).toBe(authz);
  });

  it('adds x-amz-security-token for session credentials', () => {
    const { input, authz } = load('post-sts-token/post-sts-header-before');
    const token = input.headers['X-Amz-Security-Token']!;
    const { 'X-Amz-Security-Token': _token, ...headers } = input.headers;
    const signed = signRequest({
      ...input,
      headers,
      credentials: { ...credentials, sessionToken: token },
    });
    expect(signed['x-amz-security-token']).toBe(token);
    expect(signed.authorization).toBe(authz);
  });

  it('signs the documented IAM ListUsers example', () => {
    const signed = signRequest({
      method: 'GET',
      url: new URL('https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08'),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
      service: 'iam',
      region: 'us-east-1',
      credentials,
      now: suiteNow,
    });
    expect(signed['x-amz-date']).toBe('20150830T123600Z');
    expect(signed.authorization).toContain(
      'Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7',
    );
  });

  const s3Credentials = {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  };
  const s3Now = Date.UTC(2013, 4, 24);

  it('signs the documented S3 GET example with x-amz-content-sha256', () => {
    const signed = signRequest({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      headers: { Range: 'bytes=0-9' },
      service: 's3',
      region: 'us-east-1',
      credentials: s3Credentials,
      now: s3Now,
      contentSha256Header: true,
      normalizePath: false,
    });
    expect(signed['x-amz-content-sha256']).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(signed.authorization).toContain(
      'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });

  it('S3 mode does not double-encode or normalize the path', () => {
    const input: SigningInput = {
      method: 'PUT',
      url: new URL('https://bucket.s3.amazonaws.com/a%20b//c'),
      headers: {},
      body: 'x',
      service: 's3',
      region: 'us-east-1',
      credentials: s3Credentials,
      now: s3Now,
      contentSha256Header: true,
      normalizePath: false,
    };
    expect(canonicalRequest(input).canonical.split('\n')[1]).toBe('/a%20b//c');
    expect(signRequest(input)['x-amz-content-sha256']).toMatch(/^[0-9a-f]{64}$/);
    expect(signRequest({ ...input, unsignedPayload: true })['x-amz-content-sha256']).toBe(
      'UNSIGNED-PAYLOAD',
    );
    // Other services normalize and encode the wire path again.
    expect(
      canonicalRequest({ ...input, normalizePath: true, service: 'service' }).canonical.split(
        '\n',
      )[1],
    ).toBe('/a%2520b/c');
  });

  it('presigned URL carries the query auth fields and expires bound', () => {
    const url = presignUrl({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      headers: {},
      service: 's3',
      region: 'us-east-1',
      credentials: s3Credentials,
      now: s3Now,
      expiresInSeconds: 86_400,
      normalizePath: false,
    });
    // The documented S3 presigned-URL example.
    expect(url).toContain(
      'X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    );
    const short = new URL(
      presignUrl({
        method: 'GET',
        url: new URL('https://sts.us-east-1.amazonaws.com/?Action=GetCallerIdentity'),
        headers: {},
        service: 'sts',
        region: 'us-east-1',
        credentials: { ...s3Credentials, sessionToken: 'tok' },
        now: s3Now,
        expiresInSeconds: 900,
      }),
    );
    for (const name of [
      'X-Amz-Algorithm',
      'X-Amz-Credential',
      'X-Amz-Date',
      'X-Amz-SignedHeaders',
      'X-Amz-Security-Token',
      'X-Amz-Signature',
    ])
      expect(short.searchParams.get(name)).toBeTruthy();
    expect(short.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(short.searchParams.has('authorization')).toBe(false);
    for (const bad of [0, 604_801, 1.5])
      expect(() =>
        presignUrl({
          method: 'GET',
          url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
          headers: {},
          service: 's3',
          region: 'us-east-1',
          credentials: s3Credentials,
          now: s3Now,
          expiresInSeconds: bad,
        }),
      ).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });

  it('signing-key cache is keyed by date, region and service', () => {
    const sign = (region: string, now: number) =>
      signRequest({
        method: 'GET',
        url: new URL('https://example.amazonaws.com/'),
        headers: {},
        service: 'cachetest',
        region,
        credentials: { accessKeyId: 'AKIDCACHE', secretAccessKey: `secret-${Math.random()}` },
        now,
      });
    const secret = { accessKeyId: 'AKIDCACHE', secretAccessKey: 'cache-secret' };
    const input = (region: string, now: number): SigningInput => ({
      method: 'GET',
      url: new URL('https://example.amazonaws.com/'),
      headers: {},
      service: 'cachetest',
      region,
      credentials: secret,
      now,
    });
    signRequest(input('us-east-1', suiteNow));
    const after = signingKeyCacheSize();
    signRequest(input('us-east-1', suiteNow + 60_000));
    expect(signingKeyCacheSize()).toBe(after);
    signRequest(input('us-west-2', suiteNow));
    signRequest(input('us-east-1', suiteNow + 86_400_000));
    expect(signingKeyCacheSize()).toBeGreaterThanOrEqual(Math.min(after + 2, 64));
    // The cache is bounded.
    for (let i = 0; i < 80; i++) sign('us-east-1', suiteNow);
    expect(signingKeyCacheSize()).toBeLessThanOrEqual(64);
  });

  it('refuses header values with line breaks', () => {
    expect(() =>
      signRequest({
        method: 'GET',
        url: new URL('https://example.amazonaws.com/'),
        headers: { 'x-evil': 'a\r\nb: c' },
        service: 'service',
        region: 'us-east-1',
        credentials,
        now: suiteNow,
      }),
    ).toThrow(ComputeError);
  });
});
