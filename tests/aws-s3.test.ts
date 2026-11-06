import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { ComputeError, manualClock, type AuditRecord } from '@better-compute/core';
import { s3AuditSink, s3BlobStore, s3SnapshotStore, type S3StoreOptions } from '@better-compute/aws';
import { AwsEmulator, recordingLogger } from './support/aws-platform-emulator/index.js';
import { s3Fake } from './support/aws-platform-emulator/s3.js';

const MiB = 1024 * 1024;

function s3World(options: Partial<S3StoreOptions> = {}) {
  const emu = new AwsEmulator();
  const s3 = s3Fake(emu);
  s3.createBucket('bc-blobs');
  s3.createBucket('bc.dotted');
  const log = recordingLogger();
  const base = {
    region: 'us-east-1',
    credentials: emu.credentials,
    fetch: emu.fetch,
    endpoint: 'http://emu.local',
    clock: emu.clock,
    log,
  };
  const store = s3BlobStore({ ...base, bucket: 'bc-blobs', prefix: 'downloads', ...options });
  return { emu, s3, store, log, base };
}

async function text(stream: ReadableStream<Uint8Array> | undefined): Promise<string | undefined> {
  return stream ? new Response(stream).text() : undefined;
}

function streamOf(bytes: Uint8Array, chunk = 1_000_000): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.subarray(offset, offset + chunk));
      offset += chunk;
    },
  });
}

describe('S3 BlobStore', () => {
  it('matches the S3 documentation presign example', async () => {
    const store = s3BlobStore({
      region: 'us-east-1',
      bucket: 'examplebucket',
      endpoint: 'https://s3.amazonaws.com',
      clock: manualClock(Date.UTC(2013, 4, 24)),
      credentials: {
        kind: 'test',
        credentials: async () => ({ accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' }),
      },
    });
    const url = await store.presign!('test.txt', { method: 'GET', expiresInSeconds: 86_400 });
    expect(url.startsWith('https://examplebucket.s3.amazonaws.com/test.txt?')).toBe(true);
    expect(url.endsWith('X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404')).toBe(true);
  });

  it('put and get round-trip a small object with SSE-KMS headers', async () => {
    const { store, s3, emu } = s3World({ sse: { kind: 'aws:kms', keyId: 'alias/bc-s3' } });
    await store.put('bcd/1.2.3/bcd-linux-amd64', new TextEncoder().encode('daemon bytes'), { contentType: 'application/octet-stream' });
    const object = s3.object('bc-blobs', 'downloads/bcd/1.2.3/bcd-linux-amd64')!;
    expect(object.headers).toMatchObject({
      'x-amz-server-side-encryption': 'aws:kms',
      'x-amz-server-side-encryption-aws-kms-key-id': 'alias/bc-s3',
      'content-type': 'application/octet-stream',
    });
    expect(await text(await store.get('bcd/1.2.3/bcd-linux-amd64'))).toBe('daemon bytes');
    const put = emu.calls('PutObject')[0]!;
    expect(put.headers['x-amz-content-sha256']).toMatch(/^[0-9a-f]{64}$/);
    await store.put('stream.txt', streamOf(new TextEncoder().encode('streamed'), 3));
    expect(await text(await store.get('stream.txt'))).toBe('streamed');
  });

  it('large bodies use multipart and complete in order', async () => {
    const { store, s3, emu } = s3World({ singlePutBytes: 5 * MiB, partBytes: 5 * MiB, sse: { kind: 'AES256' } });
    const body = new Uint8Array(12 * MiB + 17);
    for (let i = 0; i < body.length; i += 4096) body[i] = (i / 4096) % 251;
    await store.put('big.bin', streamOf(body));
    expect(emu.calls('CreateMultipartUpload')).toHaveLength(1);
    expect(emu.calls('CreateMultipartUpload')[0]!.headers['x-amz-server-side-encryption']).toBe('AES256');
    expect(emu.calls('UploadPart').map((r) => r.url.searchParams.get('partNumber'))).toEqual(['1', '2', '3']);
    expect(emu.calls('UploadPart').map((r) => r.body.length)).toEqual([5 * MiB, 5 * MiB, 2 * MiB + 17]);
    expect(emu.calls('CompleteMultipartUpload')).toHaveLength(1);
    expect(Buffer.compare(s3.object('bc-blobs', 'downloads/big.bin')!.body, Buffer.from(body))).toBe(0);
    expect(s3.uploads.size).toBe(0);
  });

  it('aborts the multipart upload when a part fails', async () => {
    const { store, s3, emu } = s3World({ singlePutBytes: 5 * MiB, partBytes: 5 * MiB });
    emu.failNext('UploadPart', 'InternalError', 500);
    const error = await store.put('big.bin', new Uint8Array(11 * MiB)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ComputeError);
    expect((error as ComputeError).code).toBe('UNAVAILABLE');
    expect(emu.calls('AbortMultipartUpload')).toHaveLength(1);
    expect(s3.aborted).toHaveLength(1);
    expect(s3.uploads.size).toBe(0);
    expect(s3.object('bc-blobs', 'downloads/big.bin')).toBeUndefined();
  });

  it('get of a missing key is undefined and delete of one succeeds', async () => {
    const { store } = s3World();
    expect(await store.get('nope')).toBeUndefined();
    await expect(store.delete('nope')).resolves.toBeUndefined();
    await store.put('x', new Uint8Array([1]));
    await store.delete('x');
    expect(await store.get('x')).toBeUndefined();
  });

  it('refuses unsafe keys', async () => {
    const { store, emu } = s3World();
    for (const key of ['../escape', 'a/../../b', '/abs', 'a//b', 'ctl\u0000x', 'new\nline', '', 'a/./b'])
      await expect(store.put(key, new Uint8Array([1]))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(emu.requests).toHaveLength(0);
    expect(() => s3BlobStore({ region: 'us-east-1', credentials: emu.credentials, bucket: 'Bad_Bucket' })).toThrow(ComputeError);
  });

  it('virtual-hosted style unless the bucket has a dot', async () => {
    const { emu, base } = s3World();
    await s3BlobStore({ ...base, bucket: 'bc-blobs' }).put('a.txt', new Uint8Array([1]));
    await s3BlobStore({ ...base, bucket: 'bc.dotted' }).put('a.txt', new Uint8Array([1]));
    await s3BlobStore({ ...base, bucket: 'bc-blobs', pathStyle: true }).put('b.txt', new Uint8Array([1]));
    const [virtual, dotted, forced] = emu.calls('PutObject');
    expect(virtual!.url.host).toBe('bc-blobs.emu.local');
    expect(virtual!.url.pathname).toBe('/a.txt');
    expect(dotted!.url.host).toBe('emu.local');
    expect(dotted!.url.pathname).toBe('/bc.dotted/a.txt');
    expect(forced!.url.pathname).toBe('/bc-blobs/b.txt');
    const real = s3BlobStore({ region: 'eu-west-1', credentials: emu.credentials, bucket: 'bc-blobs', clock: emu.clock });
    expect(new URL(await real.presign!('k', { method: 'GET', expiresInSeconds: 60 })).host).toBe('bc-blobs.s3.eu-west-1.amazonaws.com');
  });

  it('presigned URLs work against the emulator, expire, and never appear in logs', async () => {
    const { store, emu, log } = s3World();
    const put = await store.presign!('bundles/b1.tar.gz', { method: 'PUT', expiresInSeconds: 600 });
    const uploaded = await emu.fetch(put, { method: 'PUT', body: new TextEncoder().encode('bundle') });
    expect(uploaded.status).toBe(200);
    const get = await store.presign!('bundles/b1.tar.gz', { method: 'GET', expiresInSeconds: 600 });
    expect(await (await emu.fetch(get)).text()).toBe('bundle');
    emu.clock.advance(601_000);
    expect((await emu.fetch(get)).status).toBe(403);
    await expect(store.presign!('x', { method: 'GET', expiresInSeconds: 604_801 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const signature = new URL(get).searchParams.get('X-Amz-Signature')!;
    expect(log.text()).not.toContain(signature);
    expect(log.text()).not.toContain('X-Amz-');
  });
});

describe('S3 SnapshotStore', () => {
  function snapshotWorld() {
    const world = s3World();
    const store = s3SnapshotStore({ ...world.base, bucket: 'bc-blobs', prefix: 'snapshots', sse: { kind: 'aws:kms', keyId: 'alias/bc-snap' } });
    return { ...world, snapshots: store };
  }
  const ids = { tenantId: 'acme', sandboxId: 'sbx_1', snapshotId: 'snap_1' };

  it('presign returns a stable s3 url and a presigned upload', async () => {
    const { snapshots, emu, s3 } = snapshotWorld();
    const first = await snapshots.presign(ids);
    expect(first.url).toBe('s3://bc-blobs/snapshots/acme/sbx_1/snap_1');
    expect(first.uploadHeaders).toEqual({ 'x-amz-server-side-encryption': 'aws:kms', 'x-amz-server-side-encryption-aws-kms-key-id': 'alias/bc-snap' });
    expect(new URL(first.uploadUrl).searchParams.get('X-Amz-SignedHeaders')).toBe(
      'host;x-amz-server-side-encryption;x-amz-server-side-encryption-aws-kms-key-id',
    );
    const uploaded = await emu.fetch(first.uploadUrl, { method: 'PUT', headers: first.uploadHeaders, body: new TextEncoder().encode('disk+memory') });
    expect(uploaded.status).toBe(200);
    expect(s3.object('bc-blobs', 'snapshots/acme/sbx_1/snap_1')!.headers['x-amz-server-side-encryption']).toBe('aws:kms');
    // Without the signed SSE headers the upload is refused.
    expect((await emu.fetch(first.uploadUrl, { method: 'PUT', body: new Uint8Array([1]) })).status).toBe(403);
    emu.clock.advance(10_000);
    expect((await snapshots.presign(ids)).url).toBe(first.url);
    await expect(snapshots.presign({ ...ids, tenantId: '../x' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it("downloadUrl refuses another tenant's snapshot", async () => {
    const { snapshots, emu } = snapshotWorld();
    const { url } = await snapshots.presign(ids);
    await expect(snapshots.downloadUrl!({ tenantId: 'other', snapshotId: 'snap_1', url })).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    await expect(snapshots.downloadUrl!({ tenantId: 'acme', snapshotId: 'snap_2', url })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(snapshots.downloadUrl!({ tenantId: 'acme', snapshotId: 'snap_1', url: 's3://elsewhere/snapshots/acme/sbx_1/snap_1' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(snapshots.delete!({ tenantId: 'other', snapshotId: 'snap_1', url })).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    expect(emu.calls('DeleteObject')).toHaveLength(0);
  });

  it('restore after 8 days gets a fresh download URL', async () => {
    const { snapshots, emu } = snapshotWorld();
    const presigned = await snapshots.presign(ids);
    await emu.fetch(presigned.uploadUrl, { method: 'PUT', headers: presigned.uploadHeaders, body: new TextEncoder().encode('state') });
    const early = await snapshots.downloadUrl!({ tenantId: 'acme', snapshotId: 'snap_1', url: presigned.url });
    emu.clock.advance(8 * 24 * 3600_000);
    expect((await emu.fetch(early)).status).toBe(403);
    const fresh = await snapshots.downloadUrl!({ tenantId: 'acme', snapshotId: 'snap_1', url: presigned.url });
    expect(fresh).not.toBe(early);
    const response = await emu.fetch(fresh);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('state');
    // Stable within the window, so the host's desired spec does not churn.
    emu.clock.advance(60_000);
    expect(await snapshots.downloadUrl!({ tenantId: 'acme', snapshotId: 'snap_1', url: presigned.url })).toBe(fresh);
    await snapshots.delete!({ tenantId: 'acme', snapshotId: 'snap_1', url: presigned.url });
    expect((await emu.fetch(fresh)).status).toBe(404);
  });
});

describe('S3 audit sink', () => {
  const records = (n: number, time = Date.UTC(2026, 9, 3, 23, 59)): AuditRecord[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `aud_${String(i).padStart(4, '0')}`,
      tenantId: 'acme',
      time: time + i * 1000,
      action: 'instances.create',
      resource: { type: 'instance', id: `ins_${i}` },
    }));

  it('writes one gzipped JSONL object per batch under a date partition', async () => {
    const { base, s3, emu } = s3World();
    const sink = s3AuditSink({ ...base, bucket: 'bc-blobs', prefix: 'audit' });
    expect(sink).toMatchObject({ extension: 'sink', kind: 'audit', id: 's3-audit' });
    const batch = records(3);
    await sink.write(batch);
    const object = s3.object('bc-blobs', 'audit/year=2026/month=10/day=03/aud_0000_aud_0002_3.jsonl.gz')!;
    expect(object).toBeDefined();
    const lines = gunzipSync(object.body).toString('utf8').trimEnd().split('\n');
    expect(lines.map((line) => JSON.parse(line))).toEqual(batch);
    expect(object.headers['x-amz-checksum-sha256']).toBe(createHash('sha256').update(object.body).digest('base64'));
    expect(emu.calls('PutObject')).toHaveLength(1);
  });

  it('the same batch writes the same key', async () => {
    const { base, s3 } = s3World();
    const sink = s3AuditSink({ ...base, bucket: 'bc-blobs', prefix: 'audit' });
    await sink.write(records(2));
    await sink.write(records(2));
    expect([...s3.buckets.get('bc-blobs')!.keys()]).toEqual(['audit/year=2026/month=10/day=03/aud_0000_aud_0001_2.jsonl.gz']);
    const odd = records(1).map((record) => ({ ...record, id: 'weird/../id' }));
    await sink.write(odd);
    await sink.write(odd);
    expect(s3.buckets.get('bc-blobs')!.size).toBe(2);
  });

  it('object lock headers are set', async () => {
    const { base, s3, emu } = s3World();
    const sink = s3AuditSink({ ...base, bucket: 'bc-blobs', objectLock: { mode: 'COMPLIANCE', retainDays: 400 }, sse: { kind: 'aws:kms' } });
    await sink.write(records(1));
    const [object] = [...s3.buckets.get('bc-blobs')!.values()];
    expect(object!.headers).toMatchObject({
      'x-amz-object-lock-mode': 'COMPLIANCE',
      'x-amz-object-lock-retain-until-date': new Date(emu.clock.now() + 400 * 24 * 3600_000).toISOString(),
      'x-amz-server-side-encryption': 'aws:kms',
    });
    expect(() => s3AuditSink({ ...base, bucket: 'bc-blobs', objectLock: { mode: 'COMPLIANCE', retainDays: 0 } })).toThrow(ComputeError);
  });

  it('empty batches write nothing and S3 errors throw', async () => {
    const { base, emu } = s3World();
    const sink = s3AuditSink({ ...base, bucket: 'bc-blobs' });
    await sink.write([]);
    expect(emu.requests).toHaveLength(0);
    emu.failNext('PutObject', 'SlowDown', 503);
    await expect(sink.write(records(1))).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });
});
