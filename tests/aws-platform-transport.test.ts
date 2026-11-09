import { readFileSync } from 'node:fs';
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

  it('matches the S3 documentation presign example (tests/fixtures/aws-sigv4/s3-presign-example.json)', () => {
    const vector = JSON.parse(readFileSync(new URL('./fixtures/aws-sigv4/s3-presign-example.json', import.meta.url), 'utf8'));
    const url = presignUrl({
      method: vector.request.method,
      url: new URL(vector.request.url),
      headers: {},
      service: vector.request.service,
      region: vector.request.region,
      credentials: vector.credentials,
      now: Date.parse(vector.request.time),
      expiresInSeconds: vector.request.expiresInSeconds,
      unsignedPayload: true,
      normalizePath: false,
    });
    expect(url).toContain(`X-Amz-Credential=${vector.expected.credential}`);
    expect(url).toContain(`X-Amz-Expires=${vector.request.expiresInSeconds}`);
    expect(url.endsWith(`X-Amz-Signature=${vector.expected.signature}`)).toBe(true);
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

  /** A JSON service that accepts one access key id and answers `code` to any other. */
  function keyed(code: string, accepts: string, aheadMs = 0) {
    const seen: string[] = [];
    const fetchImpl = (async (_url: unknown, init: { headers: Record<string, string> }) => {
      const auth = init.headers.authorization ?? '';
      seen.push(/Credential=([A-Z0-9]+)/.exec(auth)?.[1] ?? '');
      const ok = auth.includes(accepts);
      return new Response(ok ? '{}' : JSON.stringify({ __type: code, message: 'no' }), {
        status: ok ? 200 : 400,
        headers: { date: new Date(Date.now() + aheadMs).toUTCString() },
      });
    }) as unknown as typeof fetch;
    return { seen, fetchImpl };
  }
  /** Credentials that change after each invalidate (a refreshed session, a rotated secret). */
  function generations(prefix: string) {
    const state = { generation: 1, invalidated: 0 };
    const source = {
      kind: 'test',
      credentials: async () => ({ accessKeyId: `${prefix}${state.generation}XXXXXXXXXXXX`, secretAccessKey: 's' }),
      invalidate: () => {
        state.invalidated += 1;
        state.generation += 1;
      },
    };
    return { state, source };
  }
  const ping = (credentials: Parameters<typeof createTransport>[0]['credentials'], fetchImpl: typeof fetch) =>
    jsonClient(createTransport({ region: 'us-east-1', credentials, fetch: fetchImpl, endpoint: 'http://emu' }), {
      hostPrefix: 'kms',
      jsonVersion: '1.1',
      targetPrefix: 'TrentService',
    }).call('Ping', {});

  it('RequestExpired with a right clock reads the credentials again (an expired session)', async () => {
    const { state, source } = generations('ASIAGEN');
    const { seen, fetchImpl } = keyed('RequestExpired', 'ASIAGEN2');
    await expect(ping(source, fetchImpl)).resolves.toEqual({});
    expect(seen).toEqual(['ASIAGEN1XXXXXXXXXXXX', 'ASIAGEN2XXXXXXXXXXXX']);
    expect(state.invalidated).toBe(1);
    // With a clock that is off too: one correction, one re-read, then it stops.
    const never = generations('ASIAGEN');
    const refused = keyed('RequestExpired', 'ASIANEVER', 20 * 60_000);
    const error = await ping(never.source, refused.fetchImpl).catch((e: unknown) => e as ComputeError);
    expect((error as ComputeError).code).toBe('UNAUTHENTICATED');
    expect(refused.seen).toHaveLength(3);
    expect(never.state.invalidated).toBe(1);
  });

  it('a refused key is read again once and retried only when it changed', async () => {
    const rotated = generations('AKIAKEY');
    const accepted = keyed('UnrecognizedClientException', 'AKIAKEY2');
    await expect(ping(rotated.source, accepted.fetchImpl)).resolves.toEqual({});
    expect(accepted.seen).toHaveLength(2);
    // The same key again: not sent twice.
    const fixed = { kind: 'test', credentials: async () => ({ accessKeyId: 'AKIAFIXEDXXXXXXXXXXX', secretAccessKey: 's' }), invalidate() {} };
    const refused = keyed('UnrecognizedClientException', 'AKIANEVER');
    const error = await ping(fixed, refused.fetchImpl).catch((e: unknown) => e as ComputeError);
    expect((error as ComputeError).code).toBe('UNAUTHENTICATED');
    expect(refused.seen).toHaveLength(1);
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

  it('signs with the aws-core signer and redacts with its patterns, plus the platform fields', async () => {
    const core = await import('@better-compute/aws-core');
    expect(signRequest).toBe(core.signRequest);
    expect(presignUrl).toBe(core.presignUrl);
    // What only aws-core's patterns cover (other key id prefixes, a signed header line), and what
    // only the platform services answer with.
    const text = redactAws(
      'AROAABCDEFGHIJKLMNOP authorization: AWS4-HMAC-SHA256 Credential=AKIAABCDEFGHIJKLMNOP/x, Signature=abcdef0123456789\n' +
        '<SecretAccessKey>xmlsecret</SecretAccessKey> "SecretString":"value1" "Plaintext":"value2" "SecretBinary":"value3"',
    );
    for (const leaked of ['ABCDEFGHIJKLMNOP', 'abcdef0123456789', 'xmlsecret', 'value1', 'value2', 'value3'])
      expect(text).not.toContain(leaked);
  });

  it('never follows a redirect with its signed headers', async () => {
    const seen: (string | undefined)[] = [];
    const redirecting = (async (_url: unknown, init: RequestInit) => {
      seen.push(init.redirect);
      return new Response('', { status: 307, headers: { location: 'https://elsewhere.example/' } });
    }) as unknown as typeof fetch;
    const kms = jsonClient(
      createTransport({
        region: 'us-east-1',
        credentials: { kind: 'test', credentials: async () => suiteCredentials },
        fetch: redirecting,
        endpoint: 'http://emu',
      }),
      { hostPrefix: 'kms', jsonVersion: '1.1', targetPrefix: 'TrentService' },
    );
    const error = await kms.call('Ping', {}).catch((e: unknown) => e as ComputeError);
    expect(error).toBeInstanceOf(ComputeError);
    expect(seen).toEqual(['manual']);
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
