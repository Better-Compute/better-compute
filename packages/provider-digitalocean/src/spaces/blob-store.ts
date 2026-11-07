import {
  ComputeError,
  isSecretRef,
  systemClock,
  type BlobStore,
  type Clock,
  type Logger,
  type SecretRef,
  type SecretResolver,
} from '@better-compute/core';
import { readCappedBytes } from './capped.js';
import {
  checkBucketName,
  checkObjectKey,
  spacesClient,
  xmlEscape,
  xmlValue,
  type SpacesClient,
} from './s3.js';

// The operator's BlobStore on a Spaces bucket (DO-D19): daemon downloads, log bundles and images,
// and the presign source for custom image imports. The host builds it and passes it to
// `betterCompute({ blobStore })`. Keys are stored under `prefix`. A stream longer than one part is
// sent as a multipart upload, so no body is ever held whole in memory beyond one part.

/** S3's smallest part (except the last). */
const minPartBytes = 5 * 1024 * 1024;
/** S3's largest part count. */
const maxParts = 10_000;
const defaultPartBytes = 16 * 1024 * 1024;

export interface SpacesBlobStoreOptions {
  /** The Spaces region slug (`nyc3`). */
  region: string;
  /** An existing bucket the key pair can read and write. */
  bucket: string;
  /** The Spaces access key id, as a secret reference. */
  accessKey: SecretRef;
  /** The Spaces secret key, as a secret reference. */
  secretKey: SecretRef;
  /** Resolves both references, on first use. */
  secrets: SecretResolver;
  /** Every key is stored under this prefix (no leading `/`), e.g. `better-compute/`. */
  prefix?: string;
  /** Size of each multipart part; at least 5 MiB. Default 16 MiB. */
  partSizeBytes?: number;
  fetch?: typeof fetch;
  /** Default `https://<region>.digitaloceanspaces.com`. A code-level option. */
  endpoint?: string;
  clock?: Clock;
  log?: Logger;
}

function invalid(message: string, reason: string): ComputeError {
  return new ComputeError('INVALID_CONFIG', message, undefined, {
    provider: 'digitalocean',
    service: 'spaces',
    reason,
  });
}

/** Reads up to `size` bytes from `reader` (fewer only at the end of the stream). */
async function readPart(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  carry: { rest: Uint8Array | undefined },
  size: number,
): Promise<Uint8Array> {
  const out = new Uint8Array(size);
  let filled = 0;
  while (filled < size) {
    let chunk = carry.rest;
    carry.rest = undefined;
    if (!chunk) {
      const { done, value } = await reader.read();
      if (done) break;
      chunk = value;
    }
    const take = Math.min(chunk.length, size - filled);
    out.set(chunk.subarray(0, take), filled);
    filled += take;
    if (take < chunk.length) carry.rest = chunk.subarray(take);
  }
  return filled === size ? out : out.subarray(0, filled);
}

export function spacesBlobStore(options: SpacesBlobStoreOptions): BlobStore {
  checkBucketName(options.bucket);
  if (!isSecretRef(options.accessKey) || !isSecretRef(options.secretKey))
    throw invalid(
      'spacesBlobStore takes the access key and secret key as secret references',
      'secretRef',
    );
  const prefix = options.prefix ?? '';
  if (prefix.startsWith('/') || /[\u0000-\u001f\u007f]/.test(prefix))
    throw invalid('A blob prefix does not start with "/" and has no control characters', 'prefix');
  const partSize = options.partSizeBytes ?? defaultPartBytes;
  if (!Number.isSafeInteger(partSize) || partSize < minPartBytes)
    throw invalid(`A multipart part is at least ${minPartBytes} bytes`, 'partSize');

  const bucket = options.bucket;
  const { accessKey, secretKey, secrets } = options;
  const s3: SpacesClient = spacesClient({
    fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
    region: options.region,
    ...(options.endpoint !== undefined ? { endpoint: options.endpoint } : {}),
    credentials: async () => ({
      accessKeyId: await secrets.resolve(accessKey),
      secretAccessKey: await secrets.resolve(secretKey),
    }),
    clock: options.clock ?? systemClock,
    ...(options.log ? { log: options.log } : {}),
  });

  const full = (key: string): string => {
    const value = `${prefix}${key}`;
    checkObjectKey(value);
    return value;
  };
  const typeHeader = (contentType?: string): Record<string, string> =>
    contentType ? { 'content-type': contentType } : {};

  async function putMultipart(
    key: string,
    first: Uint8Array,
    reader: ReadableStreamDefaultReader<Uint8Array>,
    carry: { rest: Uint8Array | undefined },
    contentType?: string,
  ): Promise<void> {
    const started = await s3.request('POST', bucket, key, {
      query: { uploads: '' },
      headers: typeHeader(contentType),
    });
    const uploadId = xmlValue(await started.text(), 'UploadId');
    if (!uploadId)
      throw new ComputeError('PROVIDER_ERROR', 'Spaces started an upload without an id', undefined, {
        provider: 'digitalocean',
        service: 'spaces',
        reason: 'badBody',
      });
    const etags: string[] = [];
    try {
      let part: Uint8Array = first;
      for (;;) {
        if (etags.length >= maxParts)
          throw new ComputeError('PAYLOAD_TOO_LARGE', 'The blob needs more than 10000 parts', undefined, {
            provider: 'digitalocean',
            service: 'spaces',
            reason: 'tooManyParts',
          });
        const sent = await s3.request('PUT', bucket, key, {
          query: { partNumber: String(etags.length + 1), uploadId },
          body: part,
        });
        const etag = sent.headers.get('etag');
        await sent.body?.cancel();
        // Completion lists every part's ETag: without one the upload cannot be completed.
        if (!etag)
          throw new ComputeError('PROVIDER_ERROR', 'Spaces stored a part without an ETag', undefined, {
            provider: 'digitalocean',
            service: 'spaces',
            reason: 'noEtag',
          });
        etags.push(etag);
        part = await readPart(reader, carry, partSize);
        if (part.length === 0) break;
      }
      const manifest = `<CompleteMultipartUpload>${etags
        .map((etag, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${xmlEscape(etag)}</ETag></Part>`)
        .join('')}</CompleteMultipartUpload>`;
      const done = await s3.request('POST', bucket, key, {
        query: { uploadId },
        headers: { 'content-type': 'application/xml' },
        body: new TextEncoder().encode(manifest),
      });
      // S3 can answer 200 with an error body when completion fails late.
      const text = await done.text();
      if (/<Error>/.test(text))
        throw new ComputeError('UNAVAILABLE', `Spaces could not complete the upload of ${key}`, undefined, {
          provider: 'digitalocean',
          service: 'spaces',
          s3Code: xmlValue(text, 'Code'),
        });
    } catch (error) {
      await s3
        .request('DELETE', bucket, key, { query: { uploadId }, allow: [404] })
        .catch(() => undefined);
      await reader.cancel().catch(() => undefined);
      throw error;
    }
  }

  /**
   * Refuses a 404 that is not a missing object: only NoSuchKey means "no blob", a missing bucket
   * (NoSuchBucket, or anything else) is a broken deployment.
   */
  async function requireNoSuchKey(response: Response): Promise<void> {
    const text = new TextDecoder().decode(await readCappedBytes(response, 64 * 1024));
    if (xmlValue(text, 'Code') !== 'NoSuchKey')
      throw new ComputeError('NOT_FOUND', `Spaces bucket ${bucket} not found`, undefined, {
        provider: 'digitalocean',
        service: 'spaces',
        status: 404,
        reason: 'noSuchBucket',
      });
  }

  return {
    async get(key) {
      const response = await s3.request('GET', bucket, full(key), { allow: [404] });
      if (response.status === 404) {
        await requireNoSuchKey(response);
        return undefined;
      }
      return response.body ?? new ReadableStream({ start: (c) => c.close() });
    },

    async put(key, body, putOptions) {
      const target = full(key);
      if (body instanceof Uint8Array) {
        const sent = await s3.request('PUT', bucket, target, {
          body,
          headers: typeHeader(putOptions?.contentType),
        });
        await sent.body?.cancel();
        return;
      }
      const reader = body.getReader();
      const carry: { rest: Uint8Array | undefined } = { rest: undefined };
      const first = await readPart(reader, carry, partSize);
      // One part's worth or less: a single PUT.
      const next = first.length < partSize ? undefined : await readPart(reader, carry, 1);
      if (!next || next.length === 0) {
        const sent = await s3.request('PUT', bucket, target, {
          body: first,
          headers: typeHeader(putOptions?.contentType),
        });
        await sent.body?.cancel();
        return;
      }
      carry.rest = carry.rest ? concat(next, carry.rest) : next;
      await putMultipart(target, first, reader, carry, putOptions?.contentType);
    },

    async delete(key) {
      const response = await s3.request('DELETE', bucket, full(key), { allow: [404] });
      // A missing object is deleted already; a missing bucket is not "done".
      if (response.status === 404) await requireNoSuchKey(response);
      else await response.body?.cancel();
    },

    async presign(key, presignOptions) {
      return s3.presign(
        presignOptions.method,
        bucket,
        full(key),
        presignOptions.expiresInSeconds,
      );
    },
  };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
