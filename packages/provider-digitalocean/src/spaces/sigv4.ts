import { createHash, createHmac } from 'node:crypto';
import { ComputeError } from '@better-compute/core';

// AWS Signature Version 4, as Spaces (S3-compatible) checks it: header signing for API calls and
// query-string presigning for time-limited URLs. One file on node:crypto, no dependency (DO-D19);
// tests/provider-digitalocean-sigv4.test.ts holds AWS's published vectors.
//
// The secret key is used only as the HMAC seed: no returned header, URL or error carries it.

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

/** The sha256 of an empty payload. */
export const emptyPayloadHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
/** The payload hash S3 accepts over TLS when the body is not hashed up front. */
export const unsignedPayload = 'UNSIGNED-PAYLOAD';

/** The longest presigned URL S3 allows: seven days. */
export const maxPresignSeconds = 604_800;

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

const hmac = (key: Uint8Array | string, data: string): Buffer =>
  createHmac('sha256', key).update(data, 'utf8').digest();

/** RFC 3986 encoding of one URI component, as SigV4 wants it (`~` kept, `*!'()` escaped). */
export function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** An object key as an S3 path: each `/`-separated segment encoded, the slashes kept. */
export function encodeS3Key(key: string): string {
  return key.split('/').map(uriEncode).join('/');
}

function amzDate(now: number): { date: string; stamp: string } {
  const iso = new Date(now).toISOString(); // 2013-05-24T00:00:00.000Z
  const stamp = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
  return { date: stamp.slice(0, 8), stamp };
}

/**
 * The canonical query: every parameter decoded from the URL, re-encoded the SigV4 way and sorted
 * by encoded key, then value. A parameter given without `=` (`?lifecycle`) signs as `lifecycle=`.
 */
function canonicalQuery(url: URL, extra: readonly [string, string][] = []): string {
  const pairs: [string, string][] = [];
  for (const [key, value] of url.searchParams) pairs.push([uriEncode(key), uriEncode(value)]);
  for (const [key, value] of extra) pairs.push([uriEncode(key), uriEncode(value)]);
  pairs.sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  return pairs.map(([key, value]) => `${key}=${value}`).join('&');
}

/**
 * The canonical path: the URL's pathname as already encoded (S3 does not normalize or double-
 * encode). Callers build paths with `encodeS3Key`; `new URL` leaves `%XX` escapes alone.
 */
function canonicalPath(url: URL): string {
  return url.pathname || '/';
}

const hostOf = (url: URL): string => url.host;

function canonicalHeaders(headers: Readonly<Record<string, string>>): {
  canonical: string;
  signed: string;
} {
  const entries = Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, ' ')] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    canonical: entries.map(([name, value]) => `${name}:${value}\n`).join(''),
    signed: entries.map(([name]) => name).join(';'),
  };
}

function signingKey(secret: string, date: string, region: string, service: string): Buffer {
  const kDate = hmac(`AWS4${secret}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

function signature(
  credentials: SigV4Credentials,
  scope: { date: string; region: string; service: string },
  stamp: string,
  canonicalRequest: string,
): string {
  const credentialScope = `${scope.date}/${scope.region}/${scope.service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    stamp,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');
  return createHmac(
    'sha256',
    signingKey(credentials.secretAccessKey, scope.date, scope.region, scope.service),
  )
    .update(stringToSign, 'utf8')
    .digest('hex');
}

export interface SigV4Request {
  method: string;
  url: URL;
  /** Headers to sign and send (names in any case). `host` and `x-amz-date` are added. */
  headers: Readonly<Record<string, string>>;
  /** The body; its sha256 is the payload hash. Give this or `payloadHash`. */
  payload?: Uint8Array;
  /** A precomputed payload hash, or `UNSIGNED-PAYLOAD`. */
  payloadHash?: string;
  credentials: SigV4Credentials;
  region: string;
  service: string;
  /** Epoch ms of the signature. */
  now: number;
  /** Send and sign `x-amz-content-sha256` (S3 requires it). Default true. */
  sendPayloadHash?: boolean;
}

/** The request's headers with `host`, `x-amz-date`, `x-amz-content-sha256` and `authorization` set. */
export function signSigV4(request: SigV4Request): { headers: Record<string, string> } {
  const { date, stamp } = amzDate(request.now);
  const payloadHash =
    request.payloadHash ?? (request.payload ? sha256Hex(request.payload) : emptyPayloadHash);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) headers[name.toLowerCase()] = value;
  headers.host = hostOf(request.url);
  headers['x-amz-date'] = stamp;
  if (request.sendPayloadHash !== false) headers['x-amz-content-sha256'] = payloadHash;
  const { canonical, signed } = canonicalHeaders(headers);
  const canonicalRequest = [
    request.method.toUpperCase(),
    canonicalPath(request.url),
    canonicalQuery(request.url),
    canonical,
    signed,
    payloadHash,
  ].join('\n');
  const sig = signature(
    request.credentials,
    { date, region: request.region, service: request.service },
    stamp,
    canonicalRequest,
  );
  const credential = `${request.credentials.accessKeyId}/${date}/${request.region}/${request.service}/aws4_request`;
  // `host` is set by fetch itself; it is signed but not returned for sending.
  const { host: _host, ...send } = headers;
  return {
    headers: {
      ...send,
      authorization: `AWS4-HMAC-SHA256 Credential=${credential}, SignedHeaders=${signed}, Signature=${sig}`,
    },
  };
}

export interface SigV4Presign {
  method: string;
  url: URL;
  credentials: SigV4Credentials;
  region: string;
  service: string;
  now: number;
  /** 1 .. 604 800 whole seconds. */
  expiresInSeconds: number;
}

/** A presigned URL (`X-Amz-*` query parameters, signed header `host`, unsigned payload). */
export function presignSigV4(request: SigV4Presign): URL {
  const expires = request.expiresInSeconds;
  if (!Number.isInteger(expires) || expires < 1 || expires > maxPresignSeconds)
    throw new ComputeError(
      'INVALID_INPUT',
      `A presigned URL expires in 1 to ${maxPresignSeconds} whole seconds`,
      undefined,
      { provider: 'digitalocean', reason: 'presignExpiry' },
    );
  const { date, stamp } = amzDate(request.now);
  const credential = `${request.credentials.accessKeyId}/${date}/${request.region}/${request.service}/aws4_request`;
  const params: [string, string][] = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', credential],
    ['X-Amz-Date', stamp],
    ['X-Amz-Expires', String(expires)],
    ['X-Amz-SignedHeaders', 'host'],
  ];
  const canonicalRequest = [
    request.method.toUpperCase(),
    canonicalPath(request.url),
    canonicalQuery(request.url, params),
    `host:${hostOf(request.url)}\n`,
    'host',
    unsignedPayload,
  ].join('\n');
  const sig = signature(
    request.credentials,
    { date, region: request.region, service: request.service },
    stamp,
    canonicalRequest,
  );
  const url = new URL(request.url);
  for (const [key, value] of params) url.searchParams.set(key, value);
  url.searchParams.set('X-Amz-Signature', sig);
  return url;
}
