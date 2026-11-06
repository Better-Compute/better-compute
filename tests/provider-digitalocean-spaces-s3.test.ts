import { describe, expect, it } from 'vitest';
import { isComputeError, manualClock, type ComputeError } from '@better-compute/core';
import {
  checkObjectKey,
  mapS3Error,
  spacesClient,
  xmlValue,
  xmlValues,
} from '@better-compute/provider-digitalocean';
import { SpacesEmulator } from './support/spaces-emulator.js';

// The Spaces S3 client: path-style URLs, signed requests the emulator verifies, error mapping and
// the input checks that keep one key addressing one object.

const t0 = Date.parse('2026-11-05T10:00:00Z');
const creds = { accessKeyId: 'SPACESKEY', secretAccessKey: 'spaces-secret' };

function client(emu: SpacesEmulator, credentials = async () => creds) {
  return spacesClient({ fetch: emu.fetch, region: 'nyc3', credentials, clock: manualClock(t0) });
}

async function failure(promise: Promise<unknown>): Promise<ComputeError> {
  try {
    await promise;
  } catch (error) {
    if (isComputeError(error)) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

describe('spacesClient', () => {
  it('signs requests the emulator accepts, path-style on the region host', async () => {
    const emu = new SpacesEmulator({ now: () => t0 });
    emu.seedBucket('bc-ops');
    const s3 = client(emu);
    await s3.request('PUT', 'bc-ops', 'a b/c+d.txt', {
      body: new TextEncoder().encode('hello'),
      headers: { 'content-type': 'text/plain' },
    });
    expect(emu.buckets.get('bc-ops')!.objects.get('a b/c+d.txt')?.contentType).toBe('text/plain');
    expect(emu.requests[0]!.url.toString()).toBe(
      'https://nyc3.digitaloceanspaces.com/bc-ops/a%20b/c%2Bd.txt',
    );
    const got = await s3.request('GET', 'bc-ops', 'a b/c+d.txt');
    expect(await got.text()).toBe('hello');
  });

  it('maps S3 errors to ComputeErrors without leaking the keys', async () => {
    const emu = new SpacesEmulator({ now: () => t0 });
    emu.seedBucket('bc-ops');
    const bad = client(emu, async () => ({ ...creds, secretAccessKey: 'wrong-secret' }));
    const denied = await failure(bad.request('GET', 'bc-ops', 'k'));
    expect(denied.code).toBe('INVALID_CONFIG');
    expect(denied.details).toMatchObject({
      provider: 'digitalocean',
      service: 'spaces',
      reason: 'spacesKeys',
      s3Code: 'SignatureDoesNotMatch',
    });
    expect(JSON.stringify({ m: denied.message, d: denied.details })).not.toMatch(
      /wrong-secret|spaces-secret/,
    );
    const missing = await failure(client(emu).request('GET', 'bc-ops', 'nope'));
    expect(missing.code).toBe('NOT_FOUND');
    expect(missing.details?.reason).toBe('noSuchKey');
  });

  it('allows a status the caller expects', async () => {
    const emu = new SpacesEmulator({ now: () => t0 });
    const response = await client(emu).request('HEAD', 'bc-absent', undefined, { allow: [404] });
    expect(response.status).toBe(404);
  });

  it('does not remember a failed credential resolution', async () => {
    const emu = new SpacesEmulator({ now: () => t0 });
    emu.seedBucket('bc-ops');
    let calls = 0;
    const s3 = client(emu, async () => {
      calls += 1;
      if (calls === 1) throw new Error('vault down');
      return creds;
    });
    await expect(s3.request('HEAD', 'bc-ops', undefined)).rejects.toThrow('vault down');
    await s3.request('HEAD', 'bc-ops', undefined);
    await s3.request('HEAD', 'bc-ops', undefined);
    expect(calls).toBe(2);
  });

  it('maps a network failure to UNAVAILABLE', async () => {
    const s3 = spacesClient({
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
      region: 'nyc3',
      credentials: async () => creds,
      clock: manualClock(t0),
    });
    const error = await failure(s3.request('GET', 'bc-ops', 'k'));
    expect(error.code).toBe('UNAVAILABLE');
    expect(error.details?.reason).toBe('network');
  });

  it('refuses bad regions, bucket names and keys before any request', async () => {
    const emu = new SpacesEmulator({ now: () => t0 });
    expect(() =>
      spacesClient({
        fetch: emu.fetch,
        region: 'NYC3',
        credentials: async () => creds,
        clock: manualClock(t0),
      }),
    ).toThrow(/region/);
    const s3 = client(emu);
    expect((await failure(s3.request('GET', 'Bad_Bucket', 'k'))).details?.reason).toBe(
      'bucketName',
    );
    for (const key of ['', '/abs', 'a/../b', 'a/./b', 'tab\tkey', 'x'.repeat(1025)])
      expect(() => checkObjectKey(key), key).toThrow(/object key/i);
    expect(emu.requests).toHaveLength(0);
  });
});

describe('S3 XML and errors', () => {
  it('reads flat values and decodes entities', () => {
    const body =
      '<R><Key>a&amp;b</Key><Key>c&lt;d&#47;</Key><Code>NoSuchKey</Code></R>';
    expect(xmlValues(body, 'Key')).toEqual(['a&b', 'c<d/']);
    expect(xmlValue(body, 'Code')).toBe('NoSuchKey');
    expect(xmlValue(body, 'Missing')).toBeUndefined();
  });

  it('maps the codes the kinds rely on', () => {
    const h = new Headers();
    const err = (status: number, code: string) =>
      mapS3Error(status, `<Error><Code>${code}</Code></Error>`, h, 'PUT b');
    expect(err(409, 'BucketAlreadyExists').details?.reason).toBe('bucketNameTaken');
    expect(err(409, 'BucketAlreadyOwnedByYou').details?.reason).toBe('bucketOwned');
    expect(err(409, 'BucketNotEmpty').code).toBe('INVALID_STATE');
    expect(err(503, 'SlowDown').code).toBe('RATE_LIMITED');
    expect(err(500, 'InternalError').code).toBe('UNAVAILABLE');
    expect(mapS3Error(403, '', h, 'GET b').code).toBe('ACCESS_DENIED');
  });
});
