import { describe, expect, it } from 'vitest';
import { isComputeError, manualClock, type BlobStore, type ComputeError } from '@better-compute/core';
import { spacesBlobStore } from '@better-compute/provider-digitalocean';
import { SpacesEmulator } from './support/spaces-emulator.js';

// spacesBlobStore: the operator's BlobStore on a Spaces bucket (daemon downloads, log bundles,
// images). Single PUTs, multipart for large streams, presigned URLs, and keys under a prefix.

const t0 = Date.parse('2026-11-05T10:00:00Z');
const mib = 1024 * 1024;

const secrets = {
  resolve: async (ref: string): Promise<string> => {
    if (ref === 'secret://spaces/access') return 'SPACESKEY';
    if (ref === 'secret://spaces/secret') return 'spaces-secret';
    throw new Error('no such secret');
  },
};

function setup(options: { prefix?: string; partSizeBytes?: number; now?: number } = {}) {
  const clock = manualClock(options.now ?? t0);
  const emu = new SpacesEmulator({ now: () => clock.now() });
  emu.seedBucket('bc-ops');
  const store: BlobStore = spacesBlobStore({
    region: 'nyc3',
    bucket: 'bc-ops',
    accessKey: 'secret://spaces/access',
    secretKey: 'secret://spaces/secret',
    secrets,
    fetch: emu.fetch,
    clock,
    ...(options.prefix !== undefined ? { prefix: options.prefix } : {}),
    ...(options.partSizeBytes !== undefined ? { partSizeBytes: options.partSizeBytes } : {}),
  });
  return { emu, store, clock };
}

async function bytes(stream: ReadableStream<Uint8Array> | undefined): Promise<Uint8Array> {
  if (!stream) throw new Error('no stream');
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function streamOf(total: number, chunk = 1 * mib): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= total) return controller.close();
      const size = Math.min(chunk, total - sent);
      const part = new Uint8Array(size);
      for (let i = 0; i < size; i++) part[i] = (sent + i) % 251;
      sent += size;
      controller.enqueue(part);
    },
  });
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

describe('spacesBlobStore', () => {
  it('puts, gets and deletes a blob under the prefix', async () => {
    const { emu, store } = setup({ prefix: 'bc/' });
    await store.put('logs/n1.tar.zst', new TextEncoder().encode('bundle'), {
      contentType: 'application/zstd',
    });
    const stored = emu.buckets.get('bc-ops')!.objects.get('bc/logs/n1.tar.zst');
    expect(stored?.contentType).toBe('application/zstd');
    expect(new TextDecoder().decode(await bytes(await store.get('logs/n1.tar.zst')))).toBe(
      'bundle',
    );
    await store.delete('logs/n1.tar.zst');
    expect(await store.get('logs/n1.tar.zst')).toBeUndefined();
    // Deleting what is gone is not an error.
    await store.delete('logs/n1.tar.zst');
  });

  it('puts a short stream with one request', async () => {
    const { emu, store } = setup();
    await store.put('small', streamOf(3 * mib));
    expect(emu.buckets.get('bc-ops')!.objects.get('small')!.body.length).toBe(3 * mib);
    expect(emu.requests.filter((r) => r.method === 'PUT')).toHaveLength(1);
  });

  it('puts a long stream as a multipart upload', async () => {
    const { emu, store } = setup({ partSizeBytes: 5 * mib });
    await store.put('images/big.raw', streamOf(12 * mib));
    const object = emu.buckets.get('bc-ops')!.objects.get('images/big.raw')!;
    expect(object.body.length).toBe(12 * mib);
    expect(object.body[7 * mib]).toBe((7 * mib) % 251);
    const parts = emu.requests.filter((r) => r.method === 'PUT' && r.url.searchParams.has('partNumber'));
    expect(parts.map((r) => r.bodyBytes)).toEqual([5 * mib, 5 * mib, 2 * mib]);
    expect(emu.uploads.size).toBe(0);
  });

  it('aborts the multipart upload when a part fails', async () => {
    const { emu, store } = setup({ partSizeBytes: 5 * mib });
    emu.failNext('PUT /bc-ops/images/big.raw', 500, 'InternalError');
    // The first PUT is a part (the stream is longer than one part).
    const error = await failure(store.put('images/big.raw', streamOf(11 * mib)));
    expect(error.code).toBe('UNAVAILABLE');
    expect(emu.uploads.size).toBe(0);
    expect(emu.requests.some((r) => r.method === 'DELETE' && r.url.searchParams.has('uploadId'))).toBe(
      true,
    );
    expect(emu.buckets.get('bc-ops')!.objects.has('images/big.raw')).toBe(false);
  });

  it('aborts the multipart upload when a part comes back without an ETag', async () => {
    const emu = new SpacesEmulator({ now: () => t0 });
    emu.seedBucket('bc-ops');
    // Part 2 is stored, but its answer loses the ETag.
    const noEtagOnPart2: typeof fetch = async (input, init) => {
      const response = await emu.fetch(input, init);
      const url = new URL(String(input));
      return init?.method === 'PUT' && url.searchParams.get('partNumber') === '2'
        ? new Response(null, { status: 200 })
        : response;
    };
    const store = spacesBlobStore({
      region: 'nyc3',
      bucket: 'bc-ops',
      accessKey: 'secret://spaces/access',
      secretKey: 'secret://spaces/secret',
      secrets,
      fetch: noEtagOnPart2,
      clock: manualClock(t0),
      partSizeBytes: 5 * mib,
    });
    const error = await failure(store.put('images/big.raw', streamOf(11 * mib)));
    expect(error.code).toBe('PROVIDER_ERROR');
    expect(error.details?.reason).toBe('noEtag');
    expect(emu.uploads.size).toBe(0);
    // No completion was sent with an empty ETag.
    const completions = emu.requests.filter(
      (r) => r.method === 'POST' && r.url.searchParams.has('uploadId'),
    );
    expect(completions).toHaveLength(0);
  });

  it('presigns GET and PUT URLs that work until they expire', async () => {
    const { emu, store, clock } = setup({ prefix: 'bc/' });
    const put = await store.presign!('uploads/x', { method: 'PUT', expiresInSeconds: 600 });
    expect(put).toMatch(/^https:\/\/nyc3\.digitaloceanspaces\.com\/bc-ops\/bc\/uploads\/x\?/);
    expect(put).not.toContain('spaces-secret');
    const uploaded = await emu.fetch(put, {
      method: 'PUT',
      body: new TextEncoder().encode('from node'),
    });
    expect(uploaded.status).toBe(200);
    const get = await store.presign!('uploads/x', { method: 'GET', expiresInSeconds: 60 });
    expect(await (await emu.fetch(get)).text()).toBe('from node');
    clock.advance(61_000);
    expect((await emu.fetch(get)).status).toBe(403);
  });

  it('throws for a missing bucket rather than answering "no blob"', async () => {
    const { emu, store } = setup();
    emu.buckets.delete('bc-ops');
    expect((await failure(store.get('k'))).code).toBe('NOT_FOUND');
  });

  it('never reports a delete done when the bucket is missing', async () => {
    const { emu, store } = setup();
    // A missing object is deleted already (S3 answers 204; some answer 404 NoSuchKey).
    await store.delete('never-written');
    emu.failNext('DELETE /bc-ops/', 404, 'NoSuchKey');
    await store.delete('never-written');
    emu.buckets.delete('bc-ops');
    const refused = await failure(store.delete('k'));
    expect([refused.code, refused.details?.reason]).toEqual(['NOT_FOUND', 'noSuchBucket']);
  });

  it('refuses a bad configuration when it is built', () => {
    const base = {
      region: 'nyc3',
      bucket: 'bc-ops',
      accessKey: 'secret://spaces/access' as const,
      secretKey: 'secret://spaces/secret' as const,
      secrets,
    };
    expect(() => spacesBlobStore({ ...base, bucket: 'BC' })).toThrow(/bucket/);
    expect(() => spacesBlobStore({ ...base, prefix: '/abs' })).toThrow(/prefix/);
    expect(() => spacesBlobStore({ ...base, partSizeBytes: 1024 })).toThrow(/part/);
    expect(() =>
      spacesBlobStore({ ...base, accessKey: 'plain' as unknown as 'secret://x' }),
    ).toThrow(/secret reference/);
  });
});
