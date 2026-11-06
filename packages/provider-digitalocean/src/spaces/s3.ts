import { ComputeError, type Clock, type ErrorCode, type Logger } from '@better-compute/core';
import {
  emptyPayloadHash,
  encodeS3Key,
  presignSigV4,
  sha256Hex,
  signSigV4,
  uriEncode,
  type SigV4Credentials,
} from './sigv4.js';

// A small S3 client for DigitalOcean Spaces: path-style requests to
// `https://<region>.digitaloceanspaces.com/<bucket>/<key>`, signed with SigV4 (region = the Spaces
// region slug, service `s3`). It speaks only the calls the BlobStore and the bucket kind need.
// The credentials are resolved on first use and live only in this closure: no log line, error
// message or error detail carries them.

/** A Spaces region slug (`nyc3`, `ams3`, `sgp1`). */
export const spacesRegionPattern = /^[a-z]{3}[0-9]$/;
/** A Spaces bucket name: 3–63 of lower-case letters, digits and dashes, starting and ending alphanumeric. */
export const spacesBucketPattern = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
/** The most bytes an S3 error body is read for its code. */
const maxErrorBody = 64 * 1024;

export interface SpacesClientOptions {
  fetch: typeof fetch;
  region: string;
  /** Default `https://<region>.digitaloceanspaces.com`. A code-level option, never tenant config. */
  endpoint?: string;
  /** Resolves the Spaces key pair; called once, on first use (a failure is not remembered). */
  credentials: () => Promise<SigV4Credentials>;
  clock: Clock;
  log?: Logger;
}

export interface SpacesRequestOptions {
  query?: Readonly<Record<string, string>>;
  headers?: Readonly<Record<string, string>>;
  /** A body that is hashed into the signature. */
  body?: Uint8Array;
  signal?: AbortSignal;
  /** Non-2xx statuses that are returned rather than thrown (a `HEAD` answering 404). */
  allow?: readonly number[];
}

export interface SpacesClient {
  readonly region: string;
  /** The (unsigned) URL of a bucket or an object. */
  url(bucket: string, key?: string): URL;
  /** A signed request; a failure is thrown as a mapped ComputeError unless its status is in `allow`. */
  request(
    method: 'GET' | 'HEAD' | 'PUT' | 'POST' | 'DELETE',
    bucket: string,
    key: string | undefined,
    options?: SpacesRequestOptions,
  ): Promise<Response>;
  /** A presigned URL for `GET` or `PUT` of an object. */
  presign(
    method: 'GET' | 'PUT',
    bucket: string,
    key: string,
    expiresInSeconds: number,
  ): Promise<string>;
}

function spacesError(
  code: ErrorCode,
  message: string,
  details: Record<string, unknown> = {},
): ComputeError {
  return new ComputeError(code, message, undefined, {
    provider: 'digitalocean',
    service: 'spaces',
    ...details,
  });
}

/** Refuses a bucket name Spaces would not take (before any request). */
export function checkBucketName(bucket: string): void {
  if (!spacesBucketPattern.test(bucket))
    throw spacesError(
      'INVALID_INPUT',
      `${JSON.stringify(bucket)} is not a Spaces bucket name: 3 to 63 lower-case letters, digits and dashes`,
      { reason: 'bucketName' },
    );
}

/**
 * Refuses an object key that would not address one object as given: empty, over 1024 bytes,
 * control characters, or a `.`/`..` segment (URL parsing would collapse it into another key).
 */
export function checkObjectKey(key: string): void {
  const bytes = new TextEncoder().encode(key).length;
  // eslint-disable-next-line no-control-regex
  const bad = /[\u0000-\u001f\u007f]/.test(key);
  const segments = key.split('/');
  if (
    bytes === 0 ||
    bytes > 1024 ||
    bad ||
    key.startsWith('/') ||
    segments.some((s) => s === '.' || s === '..')
  )
    throw spacesError(
      'INVALID_INPUT',
      'An object key is 1 to 1024 bytes, does not start with "/", and has no control characters or "."/".." segments',
      { reason: 'objectKey' },
    );
}

const decodeEntities = (text: string): string =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');

/**
 * Every text value of `<tag>` in an S3 XML body, entity-decoded. S3's answers are flat enough for
 * this (no CDATA, no attributes on the elements read); nested elements come back as raw text.
 */
export function xmlValues(xml: string, tag: string): string[] {
  const out: string[] = [];
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  for (const match of xml.matchAll(pattern)) out.push(decodeEntities(match[1] ?? ''));
  return out;
}

/** The first text value of `<tag>`, or undefined. */
export function xmlValue(xml: string, tag: string): string | undefined {
  return xmlValues(xml, tag)[0];
}

/** Escapes text for an XML body. */
export function xmlEscape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function readCapped(response: Response, cap: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < cap) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const all = new Uint8Array(Math.min(size, cap));
  let offset = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.length, all.length - offset);
    all.set(chunk.subarray(0, take), offset);
    offset += take;
    if (offset >= all.length) break;
  }
  return new TextDecoder().decode(all);
}

/** The ComputeError for a failed Spaces (S3) response. `what` names the call, never a credential. */
export function mapS3Error(
  status: number,
  body: string,
  headers: Pick<Headers, 'get'>,
  what: string,
): ComputeError {
  const s3Code = xmlValue(body, 'Code');
  const text = xmlValue(body, 'Message') ?? s3Code ?? `HTTP ${status}`;
  const requestId = xmlValue(body, 'RequestId') ?? headers.get('x-amz-request-id') ?? undefined;
  const details: Record<string, unknown> = { status };
  if (s3Code) details.s3Code = s3Code;
  if (requestId) details.requestId = requestId;
  let code: ErrorCode;
  switch (s3Code) {
    case 'InvalidAccessKeyId':
    case 'SignatureDoesNotMatch':
      code = 'INVALID_CONFIG';
      details.reason = 'spacesKeys';
      break;
    case 'AccessDenied':
      code = 'ACCESS_DENIED';
      details.reason = 'spacesAccess';
      break;
    case 'NoSuchBucket':
    case 'NoSuchKey':
    case 'NoSuchUpload':
      code = 'NOT_FOUND';
      details.reason = s3Code.charAt(0).toLowerCase() + s3Code.slice(1);
      break;
    case 'BucketAlreadyExists':
      code = 'CONFLICT';
      details.reason = 'bucketNameTaken';
      break;
    case 'BucketAlreadyOwnedByYou':
      code = 'CONFLICT';
      details.reason = 'bucketOwned';
      break;
    case 'BucketNotEmpty':
      code = 'INVALID_STATE';
      details.reason = 'bucketNotEmpty';
      break;
    case 'TooManyBuckets':
      code = 'QUOTA_EXCEEDED';
      details.reason = 'bucketLimit';
      break;
    case 'SlowDown':
      code = 'RATE_LIMITED';
      details.reason = 'slowDown';
      details.retryAfterMs = 1000;
      break;
    case 'EntityTooLarge':
      code = 'PAYLOAD_TOO_LARGE';
      break;
    case 'PermanentRedirect':
    case 'TemporaryRedirect':
      code = 'INVALID_CONFIG';
      details.reason = 'bucketRegion';
      break;
    default:
      if (status >= 300 && status < 400) {
        // A redirect is never followed (only the configured endpoint is reached): the bucket
        // lives behind another endpoint, usually another region's.
        code = 'INVALID_CONFIG';
        details.reason = 'bucketRegion';
      } else if (status === 403) {
        code = 'ACCESS_DENIED';
        details.reason = 'spacesAccess';
      } else if (status === 404) code = 'NOT_FOUND';
      else if (status === 409) code = 'CONFLICT';
      else if (status === 429) {
        code = 'RATE_LIMITED';
        details.retryAfterMs = 1000;
      } else if (status >= 500) code = 'UNAVAILABLE';
      else if (status === 400) code = 'INVALID_INPUT';
      else code = 'PROVIDER_ERROR';
  }
  return spacesError(code, `Spaces ${what}: ${text}`, details);
}

export function spacesClient(options: SpacesClientOptions): SpacesClient {
  if (!spacesRegionPattern.test(options.region))
    throw spacesError(
      'INVALID_CONFIG',
      `${JSON.stringify(options.region)} is not a Spaces region slug`,
      {
        reason: 'region',
      },
    );
  const region = options.region;
  const endpoint = (options.endpoint ?? `https://${region}.digitaloceanspaces.com`).replace(
    /\/+$/,
    '',
  );

  let pending: Promise<SigV4Credentials> | undefined;
  function credentials(): Promise<SigV4Credentials> {
    pending ??= options.credentials().catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
    return pending;
  }

  function url(bucket: string, key?: string): URL {
    checkBucketName(bucket);
    if (key !== undefined) checkObjectKey(key);
    return new URL(`${endpoint}/${uriEncode(bucket)}${key === undefined ? '' : `/${encodeS3Key(key)}`}`);
  }

  async function request(
    method: 'GET' | 'HEAD' | 'PUT' | 'POST' | 'DELETE',
    bucket: string,
    key: string | undefined,
    opts: SpacesRequestOptions = {},
  ): Promise<Response> {
    const target = url(bucket, key);
    for (const [name, value] of Object.entries(opts.query ?? {}))
      target.searchParams.set(name, value);
    const what = `${method} ${bucket}${key === undefined ? '' : `/${key}`}`;
    const creds = await credentials();
    const payloadHash = opts.body ? sha256Hex(opts.body) : emptyPayloadHash;
    const signed = signSigV4({
      method,
      url: target,
      headers: opts.headers ?? {},
      payloadHash,
      credentials: creds,
      region,
      service: 's3',
      now: options.clock.now(),
    });
    let response: Response;
    try {
      response = await options.fetch(target.toString(), {
        method,
        headers: signed.headers,
        // A redirect would carry signed headers to whatever host Spaces names: never follow one.
        redirect: 'manual',
        ...(opts.body ? { body: opts.body as BodyInit } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
    } catch (error) {
      if (opts.signal?.aborted) throw error;
      options.log?.warn('spaces.unreachable', { method, bucket });
      throw spacesError('UNAVAILABLE', `Spaces unreachable: ${what}`, {
        status: 0,
        reason: 'network',
      });
    }
    options.log?.debug('spaces.request', { method, bucket, status: response.status });
    if (response.ok || opts.allow?.includes(response.status)) return response;
    const body = method === 'HEAD' ? '' : await readCapped(response, maxErrorBody);
    throw mapS3Error(response.status, body, response.headers, what);
  }

  async function presign(
    method: 'GET' | 'PUT',
    bucket: string,
    key: string,
    expiresInSeconds: number,
  ): Promise<string> {
    const creds = await credentials();
    return presignSigV4({
      method,
      url: url(bucket, key),
      credentials: creds,
      region,
      service: 's3',
      now: options.clock.now(),
      expiresInSeconds,
    }).toString();
  }

  return { region, url, request, presign };
}

