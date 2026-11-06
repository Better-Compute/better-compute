import { describe, expect, it } from 'vitest';
import { ComputeError } from '@better-compute/core';
import { presignUrl, signRequest } from '../packages/aws/src/internal/sigv4.js';
import {
  createTransport,
  jsonClient,
  mapAwsError,
  redactAws,
  serviceEndpoint,
} from '../packages/aws/src/internal/transport.js';
import { AwsEmulator, EmuError, jsonResponse, recordingLogger } from './support/aws-platform-emulator/index.js';

const suiteCredentials = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
};

describe('internal SigV4', () => {
  it('matches the AWS test suite: get-vanilla', () => {
    const signed = signRequest({
      method: 'GET',
      url: new URL('https://example.amazonaws.com/'),
      headers: {},
      service: 'service',
      region: 'us-east-1',
      credentials: suiteCredentials,
      now: Date.UTC(2015, 7, 30, 12, 36, 0),
    });
    expect(signed.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
  });

  it('matches the S3 documentation presign example', () => {
    const url = presignUrl({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      headers: {},
      service: 's3',
      region: 'us-east-1',
      credentials: { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
      now: Date.UTC(2013, 4, 24),
      expiresInSeconds: 86_400,
      unsignedPayload: true,
      normalizePath: false,
    });
    expect(url).toContain('X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request');
    expect(url).toContain('X-Amz-Expires=86400');
    expect(url.endsWith('X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404')).toBe(true);
  });

  it('presigned URLs are bounded to 7 days', () => {
    expect(() =>
      presignUrl({
        method: 'GET',
        url: new URL('https://b.s3.amazonaws.com/k'),
        headers: {},
        service: 's3',
        region: 'us-east-1',
        credentials: suiteCredentials,
        now: 0,
        expiresInSeconds: 604_801,
      }),
    ).toThrow(ComputeError);
  });
});

describe('internal transport', () => {
  it('refuses host injection through the region', () => {
    for (const region of ['us-east-1.evil.com', 'us-east-1/', 'US-EAST-1', 'us-east-1@x'])
      expect(() => serviceEndpoint('kms', region)).toThrow(/region/);
    expect(serviceEndpoint('kms', 'cn-north-1').host).toBe('kms.cn-north-1.amazonaws.com.cn');
    expect(() => serviceEndpoint('kms', 'us-east-1', 'nope')).toThrow(ComputeError);
  });

  it('signs JSON requests the emulator accepts and maps JSON errors', async () => {
    const emu = new AwsEmulator();
    emu.register('kms', {
      protocol: 'json',
      handle: (request) => {
        if (request.operation === 'Boom') throw new EmuError('ThrottlingException', 'slow down');
        return jsonResponse({ ok: true });
      },
    });
    const kms = jsonClient(createTransport({ region: 'us-east-1', credentials: emu.credentials, fetch: emu.fetch, endpoint: 'http://emu', clock: emu.clock }), {
      hostPrefix: 'kms',
      jsonVersion: '1.1',
      targetPrefix: 'TrentService',
    });
    await expect(kms.call('Ping', {})).resolves.toEqual({ ok: true });
    const error = await kms.call('Boom', {}).catch((e: unknown) => e as ComputeError);
    expect(error).toBeInstanceOf(ComputeError);
    expect((error as ComputeError).code).toBe('RATE_LIMITED');
    expect((error as ComputeError).details?.code).toBe('ThrottlingException');
  });

  it('retries once on clock skew with the server offset', async () => {
    const emu = new AwsEmulator();
    emu.register('kms', { protocol: 'json', handle: () => jsonResponse({}) });
    emu.skewMs = 20 * 60_000;
    const kms = jsonClient(createTransport({ region: 'us-east-1', credentials: emu.credentials, fetch: emu.fetch, endpoint: 'http://emu', clock: emu.clock }), {
      hostPrefix: 'kms',
      jsonVersion: '1.1',
      targetPrefix: 'TrentService',
    });
    await expect(kms.call('Ping', {})).resolves.toEqual({});
    expect(emu.refused).toHaveLength(1);
    expect(emu.requests).toHaveLength(1);
  });

  it('maps codes and redacts messages', () => {
    expect(mapAwsError({ status: 400, code: 'ResourceNotFoundException', service: 'secretsmanager' }).code).toBe('NOT_FOUND');
    expect(mapAwsError({ status: 503, service: 's3' }).code).toBe('UNAVAILABLE');
    expect(mapAwsError({ status: 400, code: 'Weird', service: 's3' }).code).toBe('PROVIDER_ERROR');
    const text = redactAws(
      'AKIAABCDEFGHIJKLMNOP ASIAABCDEFGHIJKLMNOP X-Amz-Signature=abc123 X-Amz-Security-Token=tok&x=1 Signature=0123456789abcdef0123 "SecretAccessKey":"s3cr3t" "SecretString":"value"',
    );
    for (const leaked of ['ABCDEFGHIJKLMNOP', 'abc123', 'tok', '0123456789abcdef0123', 's3cr3t', 'value'])
      expect(text).not.toContain(leaked);
  });

  it('logs only request metadata', async () => {
    const emu = new AwsEmulator();
    emu.register('kms', { protocol: 'json', handle: () => jsonResponse({ Plaintext: 'c2VjcmV0' }) });
    const log = recordingLogger();
    const kms = jsonClient(createTransport({ region: 'us-east-1', credentials: emu.credentials, fetch: emu.fetch, endpoint: 'http://emu', clock: emu.clock, log }), {
      hostPrefix: 'kms',
      jsonVersion: '1.1',
      targetPrefix: 'TrentService',
    });
    await kms.call('Decrypt', { CiphertextBlob: 'x' });
    expect(log.entries).toHaveLength(1);
    expect(log.text()).not.toContain('c2VjcmV0');
    expect(log.text()).not.toContain('testsecret');
    expect(log.text()).not.toContain('Signature=');
  });
});
