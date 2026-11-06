import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { s3BlobStore } from '@better-compute/aws';
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

  // Published vectors, independent of the emulator (which checks with this signer's own
  // canonicalRequest): POST bodies, and S3 header auth with key encoding.
  it('matches the AWS test suite: post-vanilla and post-x-www-form-urlencoded', () => {
    const base = { method: 'POST', url: new URL('https://example.amazonaws.com/'), service: 'service', region: 'us-east-1', credentials: suiteCredentials, now: Date.UTC(2015, 7, 30, 12, 36, 0) };
    expect(signRequest({ ...base, headers: {} }).authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b',
    );
    expect(signRequest({ ...base, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'Param1=value1' }).authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=ff11897932ad3f4e8b18135d722051e5ac45fc38421b1da7b9d196a0fe09473a',
    );
  });

  it('matches the S3 documentation header-auth examples (GET with Range, PUT of test$file.text)', () => {
    const s3Credentials = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };
    const base = { service: 's3', region: 'us-east-1', credentials: s3Credentials, now: Date.UTC(2013, 4, 24), contentSha256Header: true, normalizePath: false };
    const get = signRequest({ ...base, method: 'GET', url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'), headers: { range: 'bytes=0-9' } });
    expect(get.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
    const put = signRequest({
      ...base,
      method: 'PUT',
      url: new URL('https://examplebucket.s3.amazonaws.com/test$file.text'),
      headers: { date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' },
      body: 'Welcome to Amazon S3.',
    });
    expect(put['x-amz-content-sha256']).toBe('44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072');
    expect(put.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class, Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd',
    );
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

describe('transport timeouts (review: time to headers only)', () => {
  // A real HTTP server and the platform fetch: the fetch spec errors a response body when the
  // request's signal fires, which the in-memory emulator cannot show.
  async function slowServer(handler: (request: IncomingMessage, response: ServerResponse) => void) {
    const server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
      endpoint: `http://127.0.0.1:${port}`,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }
  const credentials = { kind: 'test', credentials: async () => ({ accessKeyId: 'AKIATESTKEY0000000001', secretAccessKey: 'x' }) };

  it('a GET whose body streams for longer than timeoutMs still reads the whole body', async () => {
    const server = await slowServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      let sent = 0;
      const tick = setInterval(() => {
        response.write('chunk;');
        if (++sent === 6) {
          clearInterval(tick);
          response.end();
        }
      }, 100);
    });
    try {
      const store = s3BlobStore({ region: 'us-east-1', credentials, endpoint: server.endpoint, bucket: 'bc-blobs', pathStyle: true, timeoutMs: 200 });
      const body = await store.get('big');
      expect(await new Response(body).text()).toBe('chunk;'.repeat(6));
    } finally {
      await server.close();
    }
  });

  it('a response whose headers take longer than timeoutMs is UNAVAILABLE (timeout)', async () => {
    const server = await slowServer((_request, response) => {
      setTimeout(() => response.writeHead(200).end('late'), 600);
    });
    try {
      const transport = createTransport({ region: 'us-east-1', credentials, endpoint: server.endpoint, timeoutMs: 100 });
      const error = await transport
        .send({ method: 'GET', url: new URL(`${server.endpoint}/x`), service: 's3', operation: 'GetObject', protocol: 'rest-xml', s3: true })
        .catch((e: unknown) => e as ComputeError);
      expect(error).toMatchObject({ code: 'UNAVAILABLE', details: { reason: 'timeout' } });
    } finally {
      await server.close();
    }
  });

  it('S3 uploads get a timeout scaled to the body size', async () => {
    const server = await slowServer((request, response) => {
      request.resume();
      request.on('end', () => setTimeout(() => response.writeHead(200, { etag: '"e"' }).end(), 300));
    });
    try {
      const store = s3BlobStore({ region: 'us-east-1', credentials, endpoint: server.endpoint, bucket: 'bc-blobs', pathStyle: true, timeoutMs: 100 });
      await expect(store.put('object', new Uint8Array(1024 * 1024))).resolves.toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it('refuses a timeoutMs that is not a positive integer', () => {
    for (const timeoutMs of [0, -1, 1.5, Number.NaN])
      expect(() => createTransport({ region: 'us-east-1', credentials, timeoutMs })).toThrow(/timeoutMs/);
  });
});
