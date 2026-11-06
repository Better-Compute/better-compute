import { ComputeError, type BlobStore } from '@better-compute/core';
import { parseXml } from '@better-compute/aws-core';
import { transportFor, type AwsServiceOptions } from './common.js';
import { encodeRfc3986 } from './internal/sigv4.js';
import { assertRegion, type Transport } from './internal/transport.js';

export interface S3Location {
  bucket: string;
  /** Key prefix (no leading or trailing `/`). */
  prefix?: string;
}

export interface S3StoreOptions extends AwsServiceOptions, S3Location {
  sse?: { kind: 'aws:kms'; keyId?: string } | { kind: 'AES256' };
  /** Bodies up to this size go in one PUT (default 64 MiB); larger ones use multipart with `partBytes` parts (default 16 MiB). */
  singlePutBytes?: number;
  partBytes?: number;
  /** Force path-style URLs (buckets with dots; tests). Default: virtual-hosted unless the bucket has a dot. */
  pathStyle?: boolean;
}

const MiB = 1024 * 1024;
const minPartBytes = 5 * MiB;
const maxPartBytes = 5 * 1024 * MiB;
const maxParts = 10_000;
const maxPresignSeconds = 7 * 24 * 3600;
/**
 * The slowest upload rate an S3 PUT or UploadPart is given time for: the time to headers of an
 * upload is `timeoutMs` plus the body at this rate (a 16 MiB part: 64 s more).
 */
const minUploadBytesPerSecond = 256 * 1024;

/** The time-to-headers budget of a request that sends `bytes` (internal; exported for tests). */
export function uploadTimeoutMs(baseMs: number, bytes: number): number {
  return baseMs + Math.ceil((bytes / minUploadBytesPerSecond) * 1000);
}

/** S3 operations behind the BlobStore, SnapshotStore and audit sink (internal). */
export interface S3Access {
  readonly bucket: string;
  readonly transport: Transport;
  /** `${prefix}/${key}` after validating `key`. */
  fullKey(key: string): string;
  url(fullKey: string, query?: Readonly<Record<string, string>>): URL;
  sseHeaders(): Record<string, string>;
  request(input: {
    method: 'GET' | 'PUT' | 'POST' | 'DELETE' | 'HEAD';
    key: string;
    operation: string;
    query?: Readonly<Record<string, string>>;
    headers?: Readonly<Record<string, string>>;
    body?: Uint8Array | string;
    accept?: readonly number[];
  }): Promise<Response>;
  presign(
    fullKey: string,
    input: { method: 'GET' | 'PUT'; expiresInSeconds: number; headers?: Readonly<Record<string, string>>; at?: number },
  ): Promise<string>;
}

const bucketPattern = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

/** Validates an object key: non-empty, ≤ 1024 bytes, no leading `/`, no `.`/`..` segments, no control characters. */
export function checkObjectKey(key: string): string {
  if (
    typeof key !== 'string' ||
    key.length === 0 ||
    Buffer.byteLength(key) > 1024 ||
    key.startsWith('/') ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/.test(key) ||
    key.split('/').some((segment) => segment === '..' || segment === '.' || segment === '')
  )
    throw new ComputeError('INVALID_INPUT', 'unsafe object key');
  return key;
}

export function s3Access(options: S3StoreOptions): S3Access {
  if (typeof options.bucket !== 'string' || !bucketPattern.test(options.bucket) || options.bucket.includes('..'))
    throw new ComputeError('INVALID_CONFIG', 'not an S3 bucket name');
  const prefix = options.prefix ?? '';
  if (prefix !== '') checkObjectKey(prefix);
  const region = assertRegion(options.region);
  const transport = transportFor(options);
  const pathStyle = options.pathStyle ?? options.bucket.includes('.');
  const base = options.endpoint
    ? new URL(new URL(options.endpoint).origin)
    : new URL(`https://s3.${region}.${region.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com'}`);
  const sse = options.sse;
  if (sse && sse.kind !== 'aws:kms' && sse.kind !== 'AES256')
    throw new ComputeError('INVALID_CONFIG', 'sse.kind is aws:kms or AES256');

  const encodeKey = (key: string) => key.split('/').map(encodeRfc3986).join('/');
  function url(fullKey: string, query: Readonly<Record<string, string>> = {}): URL {
    const target = pathStyle
      ? new URL(`${base.origin}/${options.bucket}/${encodeKey(fullKey)}`)
      : new URL(`${base.protocol}//${options.bucket}.${base.host}/${encodeKey(fullKey)}`);
    for (const [name, value] of Object.entries(query)) target.searchParams.set(name, value);
    return target;
  }
  return {
    bucket: options.bucket,
    transport,
    fullKey: (key) => (prefix ? `${prefix}/${checkObjectKey(key)}` : checkObjectKey(key)),
    url,
    sseHeaders() {
      if (!sse) return {};
      if (sse.kind === 'AES256') return { 'x-amz-server-side-encryption': 'AES256' };
      return {
        'x-amz-server-side-encryption': 'aws:kms',
        ...(sse.keyId ? { 'x-amz-server-side-encryption-aws-kms-key-id': sse.keyId } : {}),
      };
    },
    request(input) {
      const bytes = input.body === undefined ? 0 : typeof input.body === 'string' ? Buffer.byteLength(input.body) : input.body.length;
      return transport.send({
        method: input.method,
        url: url(input.key, input.query),
        headers: input.headers,
        body: input.body,
        service: 's3',
        operation: input.operation,
        protocol: 'rest-xml',
        s3: true,
        accept: input.accept,
        ...(bytes > 0 ? { timeoutMs: uploadTimeoutMs(transport.timeoutMs, bytes) } : {}),
      });
    },
    presign(fullKey, input) {
      if (!Number.isInteger(input.expiresInSeconds) || input.expiresInSeconds < 1 || input.expiresInSeconds > maxPresignSeconds)
        throw new ComputeError('INVALID_INPUT', 'a presigned S3 URL lasts between 1 second and 7 days');
      return transport.presign({
        method: input.method,
        url: url(fullKey),
        service: 's3',
        expiresInSeconds: input.expiresInSeconds,
        headers: input.headers,
        s3: true,
        ...(input.at !== undefined ? { at: input.at } : {}),
      });
    },
  };
}

/** Reads a body in pieces of an exact size (the last piece may be shorter). */
function byteReader(body: Uint8Array | ReadableStream<Uint8Array>) {
  if (body instanceof Uint8Array) {
    let offset = 0;
    return {
      async read(max: number): Promise<Uint8Array> {
        const piece = body.subarray(offset, offset + max);
        offset += piece.length;
        return piece;
      },
      async cancel() {},
    };
  }
  const reader = body.getReader();
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let done = false;
  return {
    async read(max: number): Promise<Uint8Array> {
      while (!done && pendingBytes < max) {
        const next = await reader.read();
        if (next.done) done = true;
        else if (next.value.length > 0) {
          pending.push(next.value);
          pendingBytes += next.value.length;
        }
      }
      const all = pending.length === 1 ? pending[0]! : Buffer.concat(pending);
      const piece = all.subarray(0, max);
      const rest = all.subarray(piece.length);
      pending = rest.length > 0 ? [rest] : [];
      pendingBytes = rest.length;
      return piece;
    },
    async cancel() {
      await reader.cancel().catch(() => undefined);
    },
  };
}

/** S3 as a `BlobStore`: streaming GET, single or multipart PUT (aborted on failure), presigned URLs. */
export function s3BlobStore(options: S3StoreOptions): BlobStore {
  const s3 = s3Access(options);
  const singlePutBytes = options.singlePutBytes ?? 64 * MiB;
  const partBytes = options.partBytes ?? 16 * MiB;
  if (!Number.isInteger(partBytes) || partBytes < minPartBytes || partBytes > maxPartBytes)
    throw new ComputeError('INVALID_CONFIG', 'partBytes is between 5 MiB and 5 GiB');
  if (!Number.isInteger(singlePutBytes) || singlePutBytes < 0 || singlePutBytes > maxPartBytes)
    throw new ComputeError('INVALID_CONFIG', 'singlePutBytes is at most 5 GiB');

  async function multipart(fullKey: string, first: Uint8Array, rest: ReturnType<typeof byteReader>, contentType?: string) {
    const created = await s3.request({
      method: 'POST',
      key: fullKey,
      operation: 'CreateMultipartUpload',
      query: { uploads: '' },
      headers: { ...s3.sseHeaders(), ...(contentType ? { 'content-type': contentType } : {}) },
    });
    const uploadId = parseXml(await created.text()).textOf('UploadId');
    if (!uploadId) throw new ComputeError('PROVIDER_ERROR', 'S3 CreateMultipartUpload returned no UploadId');
    const parts: { number: number; etag: string }[] = [];
    try {
      let pending: Uint8Array = first;
      for (;;) {
        while (pending.length >= partBytes) {
          await uploadPart(pending.subarray(0, partBytes));
          pending = pending.subarray(partBytes);
        }
        const more = await rest.read(partBytes);
        if (more.length === 0) {
          if (pending.length > 0 || parts.length === 0) await uploadPart(pending);
          break;
        }
        pending = pending.length === 0 ? more : Buffer.concat([pending, more]);
      }
      const xml = `<CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${parts
        .map((part) => `<Part><PartNumber>${part.number}</PartNumber><ETag>${escapeXml(part.etag)}</ETag></Part>`)
        .join('')}</CompleteMultipartUpload>`;
      const completed = await s3.request({
        method: 'POST',
        key: fullKey,
        operation: 'CompleteMultipartUpload',
        query: { uploadId },
        headers: { 'content-type': 'application/xml' },
        body: xml,
      });
      // CompleteMultipartUpload can answer 200 with an <Error> body.
      const root = parseXml(await completed.text());
      if (root.name === 'Error')
        throw new ComputeError('UNAVAILABLE', `S3 CompleteMultipartUpload failed: ${root.textOf('Code') ?? 'error'}`);
    } catch (error) {
      await rest.cancel();
      await s3
        .request({ method: 'DELETE', key: fullKey, operation: 'AbortMultipartUpload', query: { uploadId }, accept: [404] })
        .then((response) => response.body?.cancel())
        .catch(() => undefined);
      throw error;
    }

    async function uploadPart(bytes: Uint8Array): Promise<void> {
      const number = parts.length + 1;
      if (number > maxParts) throw new ComputeError('PAYLOAD_TOO_LARGE', 'the object needs more than 10,000 parts');
      const response = await s3.request({
        method: 'PUT',
        key: fullKey,
        operation: 'UploadPart',
        query: { partNumber: String(number), uploadId: uploadId! },
        body: bytes,
      });
      await response.body?.cancel();
      const etag = response.headers.get('etag');
      if (!etag) throw new ComputeError('PROVIDER_ERROR', 'S3 UploadPart returned no ETag');
      parts.push({ number, etag });
    }
  }

  return {
    async get(key) {
      const response = await s3.request({ method: 'GET', key: s3.fullKey(key), operation: 'GetObject', accept: [404] });
      if (response.status === 404) {
        await response.body?.cancel();
        return undefined;
      }
      return response.body ?? new Response(new Uint8Array()).body!;
    },

    async put(key, body, putOptions) {
      const fullKey = s3.fullKey(key);
      const reader = byteReader(body);
      const first = await reader.read(singlePutBytes + 1);
      if (first.length <= singlePutBytes) {
        const response = await s3.request({
          method: 'PUT',
          key: fullKey,
          operation: 'PutObject',
          headers: { ...s3.sseHeaders(), ...(putOptions?.contentType ? { 'content-type': putOptions.contentType } : {}) },
          body: first,
        });
        await response.body?.cancel();
        return;
      }
      await multipart(fullKey, first, reader, putOptions?.contentType);
    },

    async delete(key) {
      const response = await s3.request({ method: 'DELETE', key: s3.fullKey(key), operation: 'DeleteObject', accept: [404] });
      await response.body?.cancel();
    },

    async presign(key, presignOptions) {
      if (presignOptions.method !== 'GET' && presignOptions.method !== 'PUT')
        throw new ComputeError('INVALID_INPUT', 'presign is for GET or PUT');
      // A presigned PUT carries no SSE headers (the uploader would have to send them): the bucket's
      // default encryption applies. s3SnapshotStore returns the headers it signs instead.
      return s3.presign(s3.fullKey(key), presignOptions);
    },
  };
}

function escapeXml(text: string): string {
  return text.replace(/[<>&'"]/g, (c) => `&${{ '<': 'lt', '>': 'gt', '&': 'amp', "'": 'apos', '"': 'quot' }[c]};`);
}
