// A private, minimal SigV4 signer. It mirrors the interface A0 Task 2 gives aws-core (signRequest,
// presignUrl, canonicalRequest) so that, once aws-core ships it, these imports move there and this
// file goes away. It is not exported from the package.
import { createHash, createHmac } from 'node:crypto';
import { ComputeError } from '@better-compute/core';

export interface AwsCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
  readonly expiresAt?: number;
}

export interface SigningInput {
  method: string;
  url: URL;
  /** Headers to sign besides `host` (derived from `url`). */
  headers: Readonly<Record<string, string>>;
  body?: Uint8Array | string;
  /** Signing name (`s3`, `kms`, `rds-db`, …). */
  service: string;
  region: string;
  credentials: AwsCredentials;
  /** Epoch ms. */
  now: number;
  /** S3: send x-amz-content-sha256 (the payload hash, or UNSIGNED-PAYLOAD). */
  contentSha256Header?: boolean;
  unsignedPayload?: boolean;
  /** Double-encode path segments (every service but S3). Default true. */
  normalizePath?: boolean;
}

export interface PresignInput extends Omit<SigningInput, 'body' | 'contentSha256Header'> {
  /** 1..604800. */
  expiresInSeconds: number;
}

const algorithm = 'AWS4-HMAC-SHA256';
export const emptySha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** RFC 3986 percent-encoding: only `A-Za-z0-9-._~` stays literal. */
export function encodeRfc3986(text: string): string {
  return encodeURIComponent(text).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: Uint8Array | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/** `20150830T123600Z`. */
export function amzDate(now: number): string {
  return new Date(now).toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function canonicalPath(url: URL, normalize: boolean): string {
  const segments = url.pathname.split('/');
  if (!normalize)
    // S3: the key's own encoding, once. Decode what the URL encoded and re-encode it strictly.
    return segments.map((segment) => encodeRfc3986(safeDecode(segment))).join('/') || '/';
  // Other services: remove dot segments and empty segments, then encode the wire form again.
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') out.pop();
    else out.push(encodeRfc3986(segment));
  }
  const trailing = url.pathname.length > 1 && url.pathname.endsWith('/') && out.length > 0;
  return `/${out.join('/')}${trailing ? '/' : ''}`;
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    throw new ComputeError('INVALID_INPUT', 'request path is not valid percent-encoding');
  }
}

function canonicalQuery(url: URL): string {
  const pairs: [string, string][] = [];
  for (const [key, value] of url.searchParams) pairs.push([encodeRfc3986(key), encodeRfc3986(value)]);
  pairs.sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  return pairs.map(([key, value]) => `${key}=${value}`).join('&');
}

function canonicalHeaders(input: { url: URL; headers: Readonly<Record<string, string>> }): {
  block: string;
  signed: string;
} {
  const merged = new Map<string, string[]>();
  merged.set('host', [input.url.host]);
  for (const [name, value] of Object.entries(input.headers)) {
    const key = name.toLowerCase();
    if (key === 'host' || key === 'authorization') continue;
    const list = merged.get(key) ?? [];
    list.push(value.trim().replace(/\s+/g, ' '));
    merged.set(key, list);
  }
  const names = [...merged.keys()].sort();
  return {
    block: names.map((name) => `${name}:${merged.get(name)!.join(',')}\n`).join(''),
    signed: names.join(';'),
  };
}

function scope(now: number, region: string, service: string): string {
  return `${amzDate(now).slice(0, 8)}/${region}/${service}/aws4_request`;
}

const signingKeys = new Map<string, Buffer>();

function signingKey(secret: string, date: string, region: string, service: string): Buffer {
  const cacheKey = `${sha256Hex(secret)}/${date}/${region}/${service}`;
  const cached = signingKeys.get(cacheKey);
  if (cached) return cached;
  const key = hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), service), 'aws4_request');
  if (signingKeys.size >= 64) signingKeys.delete(signingKeys.keys().next().value!);
  signingKeys.set(cacheKey, key);
  return key;
}

function signature(input: SigningInput, canonical: string): string {
  const date = amzDate(input.now);
  const stringToSign = [
    algorithm,
    date,
    scope(input.now, input.region, input.service),
    sha256Hex(canonical),
  ].join('\n');
  const key = signingKey(input.credentials.secretAccessKey, date.slice(0, 8), input.region, input.service);
  return createHmac('sha256', key).update(stringToSign, 'utf8').digest('hex');
}

/** The canonical request (exposed for tests and the emulator). */
export function canonicalRequest(input: SigningInput): {
  canonical: string;
  signedHeaders: string;
  payloadHash: string;
} {
  const payloadHash = input.unsignedPayload ? 'UNSIGNED-PAYLOAD' : sha256Hex(input.body ?? '');
  const headers = canonicalHeaders(input);
  const canonical = [
    input.method.toUpperCase(),
    canonicalPath(input.url, input.normalizePath ?? true),
    canonicalQuery(input.url),
    headers.block,
    headers.signed,
    payloadHash,
  ].join('\n');
  return { canonical, signedHeaders: headers.signed, payloadHash };
}

/** Headers to add to the request: authorization, x-amz-date, [x-amz-security-token], [x-amz-content-sha256]. */
export function signRequest(input: SigningInput): Record<string, string> {
  const added: Record<string, string> = { 'x-amz-date': amzDate(input.now) };
  if (input.credentials.sessionToken) added['x-amz-security-token'] = input.credentials.sessionToken;
  if (input.contentSha256Header)
    added['x-amz-content-sha256'] = input.unsignedPayload
      ? 'UNSIGNED-PAYLOAD'
      : sha256Hex(input.body ?? '');
  const withAdded: SigningInput = { ...input, headers: { ...input.headers, ...added } };
  const { canonical, signedHeaders } = canonicalRequest(withAdded);
  added.authorization = `${algorithm} Credential=${input.credentials.accessKeyId}/${scope(
    input.now,
    input.region,
    input.service,
  )}, SignedHeaders=${signedHeaders}, Signature=${signature(withAdded, canonical)}`;
  return added;
}

/** A query-authenticated URL (X-Amz-Algorithm/Credential/Date/Expires/SignedHeaders/[Security-Token]/Signature). */
export function presignUrl(input: PresignInput): string {
  if (
    !Number.isInteger(input.expiresInSeconds) ||
    input.expiresInSeconds < 1 ||
    input.expiresInSeconds > 604_800
  )
    throw new ComputeError('INVALID_INPUT', 'a presigned URL lasts between 1 second and 7 days');
  const url = new URL(input.url);
  for (const key of url.searchParams.keys())
    if (/^x-amz-(algorithm|credential|date|expires|signedheaders|signature|security-token)$/i.test(key))
      throw new ComputeError('INVALID_INPUT', 'the URL already carries query authentication');
  const headers = canonicalHeaders({ url, headers: input.headers });
  url.searchParams.set('X-Amz-Algorithm', algorithm);
  url.searchParams.set(
    'X-Amz-Credential',
    `${input.credentials.accessKeyId}/${scope(input.now, input.region, input.service)}`,
  );
  url.searchParams.set('X-Amz-Date', amzDate(input.now));
  url.searchParams.set('X-Amz-Expires', String(input.expiresInSeconds));
  if (input.credentials.sessionToken)
    url.searchParams.set('X-Amz-Security-Token', input.credentials.sessionToken);
  url.searchParams.set('X-Amz-SignedHeaders', headers.signed);
  const signing: SigningInput = { ...input, url, body: '' };
  const { canonical } = canonicalRequest(signing);
  const sig = signature(signing, canonical);
  // URLSearchParams encodes spaces as '+'; AWS wants RFC 3986 everywhere.
  const query = [...url.searchParams]
    .map(([key, value]) => `${encodeRfc3986(key)}=${encodeRfc3986(value)}`)
    .join('&');
  return `${url.origin}${url.pathname}?${query}&X-Amz-Signature=${sig}`;
}
