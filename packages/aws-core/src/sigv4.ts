import { createHash, createHmac } from 'node:crypto';
import { ComputeError } from '@better-compute/core';
import type { AwsCredentials } from './credentials.js';

/** What `signRequest` signs. */
export interface SigningInput {
  method: string;
  url: URL;
  /** Headers to sign besides `host`, which is derived from `url`. */
  headers: Readonly<Record<string, string>>;
  /** The request body; '' when absent. */
  body?: Uint8Array | string;
  /** The service's signing name. */
  service: string;
  /** The signing region. */
  region: string;
  credentials: AwsCredentials;
  /** Epoch ms of the signature. */
  now: number;
  /** S3: add `x-amz-content-sha256` (the payload hash, or `UNSIGNED-PAYLOAD` with `unsignedPayload`). */
  contentSha256Header?: boolean;
  unsignedPayload?: boolean;
  /** RFC 3986 path normalization and double encoding; false for S3. Default true. */
  normalizePath?: boolean;
}

export interface PresignInput extends Omit<SigningInput, 'body' | 'contentSha256Header'> {
  /** 1..604800. */
  expiresInSeconds: number;
}

const algorithm = 'AWS4-HMAC-SHA256';
const unsigned = 'UNSIGNED-PAYLOAD';

const sha256Hex = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
const hmac = (key: Uint8Array | string, data: string) =>
  createHmac('sha256', key).update(data).digest();

/** RFC 3986: only `A-Za-z0-9-._~` stay literal. */
function uriEncode(text: string): string {
  return encodeURIComponent(text).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** `20150830T123600Z`. */
function amzDate(now: number): string {
  if (!Number.isFinite(now))
    throw new ComputeError('INVALID_INPUT', 'signing time is not a number');
  return new Date(now)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

/** Decodes a percent-encoded segment, keeping malformed escapes as they are. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function canonicalPath(url: URL, normalize: boolean): string {
  const raw = url.pathname === '' ? '/' : url.pathname;
  if (!normalize) {
    // S3: the path as sent, each segment encoded once.
    return raw
      .split('/')
      .map((segment) => uriEncode(decodeSegment(segment)))
      .join('/');
  }
  // RFC 3986 normalization: remove empty and dot segments.
  const out: string[] = [];
  for (const segment of raw.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') out.pop();
    else out.push(segment);
  }
  const trailing = raw.length > 1 && raw.endsWith('/') && out.length > 0 ? '/' : '';
  // WHATWG URL already percent-encodes the path once; signing encodes it again (double encoding).
  return `/${out.map((segment) => uriEncode(segment)).join('/')}${trailing}`;
}

function canonicalQuery(url: URL): string {
  const pairs: [string, string][] = [];
  const search = url.search.startsWith('?') ? url.search.slice(1) : url.search;
  if (search === '') return '';
  for (const part of search.split('&')) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    const key = eq === -1 ? part : part.slice(0, eq);
    const value = eq === -1 ? '' : part.slice(eq + 1);
    pairs.push([
      uriEncode(decodeSegment(key.replace(/\+/g, ' '))),
      uriEncode(decodeSegment(value.replace(/\+/g, ' '))),
    ]);
  }
  pairs.sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  return pairs.map(([key, value]) => `${key}=${value}`).join('&');
}

/** Lower-cased names; values trimmed with inner runs of whitespace collapsed; repeats joined by ','. */
function canonicalHeaders(headers: Readonly<Record<string, string>>): Map<string, string> {
  const merged = new Map<string, string[]>();
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase().trim();
    if (/[\r\n]/.test(value) || /[\r\n:]/.test(key))
      throw new ComputeError('INVALID_INPUT', `header ${key} has a line break`);
    const trimmed = value.trim().replace(/\s+/g, ' ');
    const list = merged.get(key) ?? [];
    list.push(trimmed);
    merged.set(key, list);
  }
  return new Map([...merged].map(([key, values]) => [key, values.join(',')]));
}

function hostOf(url: URL): string {
  return url.host;
}

/** Signing keys keyed by `secret|date|region|service`; at most 64 kept. */
const signingKeys = new Map<string, Buffer>();
const keyCacheLimit = 64;

function signingKey(secret: string, date: string, region: string, service: string): Buffer {
  const id = `${sha256Hex(secret)}|${date}|${region}|${service}`;
  const cached = signingKeys.get(id);
  if (cached) return cached;
  const dateKey = hmac(`AWS4${secret}`, date);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, service);
  const key = hmac(serviceKey, 'aws4_request');
  if (signingKeys.size >= keyCacheLimit) {
    const oldest = signingKeys.keys().next().value;
    if (oldest !== undefined) signingKeys.delete(oldest);
  }
  signingKeys.set(id, key);
  return key;
}

function checkScope(input: { service: string; region: string }): void {
  if (!/^[a-z0-9-]{1,64}$/.test(input.service))
    throw new ComputeError('INVALID_INPUT', 'malformed signing service name');
  if (!/^[a-z0-9-]{1,64}$/.test(input.region))
    throw new ComputeError('INVALID_INPUT', 'malformed signing region');
}

interface Prepared {
  canonical: string;
  signedHeaders: string;
  payloadHash: string;
  amz: string;
  scope: string;
}

function prepare(
  input: SigningInput,
  extraHeaders: Readonly<Record<string, string>>,
  query?: URL,
): Prepared {
  checkScope(input);
  const amz = amzDate(input.now);
  const date = amz.slice(0, 8);
  const payloadHash = input.unsignedPayload ? unsigned : sha256Hex(input.body ?? '');
  const headers = canonicalHeaders({ host: hostOf(input.url), ...input.headers, ...extraHeaders });
  const names = [...headers.keys()].sort();
  const signedHeaders = names.join(';');
  const canonical = [
    input.method.toUpperCase(),
    canonicalPath(input.url, input.normalizePath !== false),
    canonicalQuery(query ?? input.url),
    names.map((name) => `${name}:${headers.get(name)}\n`).join(''),
    signedHeaders,
    payloadHash,
  ].join('\n');
  return {
    canonical,
    signedHeaders,
    payloadHash,
    amz,
    scope: `${date}/${input.region}/${input.service}/aws4_request`,
  };
}

function signature(input: SigningInput, prepared: Prepared): string {
  const stringToSign = [
    algorithm,
    prepared.amz,
    prepared.scope,
    sha256Hex(prepared.canonical),
  ].join('\n');
  const key = signingKey(
    input.credentials.secretAccessKey,
    prepared.amz.slice(0, 8),
    input.region,
    input.service,
  );
  return createHmac('sha256', key).update(stringToSign).digest('hex');
}

/** The headers the signed request carries besides the caller's own. */
function signedExtras(input: SigningInput, payloadHash: string): Record<string, string> {
  const extras: Record<string, string> = { 'x-amz-date': amzDate(input.now) };
  if (input.credentials.sessionToken)
    extras['x-amz-security-token'] = input.credentials.sessionToken;
  if (input.contentSha256Header) extras['x-amz-content-sha256'] = payloadHash;
  return extras;
}

/** Exposed for tests: the canonical request and string-to-sign inputs. */
export function canonicalRequest(input: SigningInput): {
  canonical: string;
  signedHeaders: string;
  payloadHash: string;
} {
  const payloadHash = input.unsignedPayload ? unsigned : sha256Hex(input.body ?? '');
  const extras = signedExtras(input, payloadHash);
  // A caller-provided x-amz-date wins (the AWS suite passes its own).
  const hasDate = Object.keys(input.headers).some((name) => name.toLowerCase() === 'x-amz-date');
  if (hasDate) delete extras['x-amz-date'];
  const { canonical, signedHeaders } = prepare(input, extras);
  return { canonical, signedHeaders, payloadHash };
}

/**
 * Signs a request with SigV4. Returns the headers to add: `authorization`, `x-amz-date`, and
 * `x-amz-security-token` / `x-amz-content-sha256` when they apply.
 */
export function signRequest(input: SigningInput): Record<string, string> {
  const payloadHash = input.unsignedPayload ? unsigned : sha256Hex(input.body ?? '');
  const extras = signedExtras(input, payloadHash);
  const hasDate = Object.keys(input.headers).some((name) => name.toLowerCase() === 'x-amz-date');
  if (hasDate) delete extras['x-amz-date'];
  const prepared = prepare(input, extras);
  const authorization =
    `${algorithm} Credential=${input.credentials.accessKeyId}/${prepared.scope}, ` +
    `SignedHeaders=${prepared.signedHeaders}, Signature=${signature(input, prepared)}`;
  return { ...extras, authorization };
}

/**
 * A presigned URL: the query carries `X-Amz-Algorithm`, `X-Amz-Credential`, `X-Amz-Date`,
 * `X-Amz-Expires`, `X-Amz-SignedHeaders`, `X-Amz-Security-Token` (session credentials) and
 * `X-Amz-Signature`. The payload is `UNSIGNED-PAYLOAD` unless the caller says otherwise.
 */
export function presignUrl(input: PresignInput): string {
  if (
    !Number.isInteger(input.expiresInSeconds) ||
    input.expiresInSeconds < 1 ||
    input.expiresInSeconds > 604_800
  )
    throw new ComputeError('INVALID_INPUT', 'a presigned URL expires in 1 to 604800 seconds');
  checkScope(input);
  const amz = amzDate(input.now);
  const url = new URL(input.url.toString());
  for (const name of [...url.searchParams.keys()])
    if (name.toLowerCase().startsWith('x-amz-'))
      throw new ComputeError('INVALID_INPUT', 'a URL to presign already carries X-Amz- parameters');
  const headerNames = [
    ...new Set(['host', ...Object.keys(input.headers).map((name) => name.toLowerCase().trim())]),
  ].sort();
  const scope = `${amz.slice(0, 8)}/${input.region}/${input.service}/aws4_request`;
  url.searchParams.append('X-Amz-Algorithm', algorithm);
  url.searchParams.append('X-Amz-Credential', `${input.credentials.accessKeyId}/${scope}`);
  url.searchParams.append('X-Amz-Date', amz);
  url.searchParams.append('X-Amz-Expires', String(input.expiresInSeconds));
  if (input.credentials.sessionToken)
    url.searchParams.append('X-Amz-Security-Token', input.credentials.sessionToken);
  url.searchParams.append('X-Amz-SignedHeaders', headerNames.join(';'));
  const signing: SigningInput = {
    ...input,
    url,
    unsignedPayload: input.unsignedPayload ?? true,
  };
  const prepared = prepare(signing, {});
  const query = canonicalQuery(url);
  return `${url.origin}${url.pathname}?${query}&X-Amz-Signature=${signature(signing, prepared)}`;
}

/** Exposed for tests: how many signing keys are cached. */
export function signingKeyCacheSize(): number {
  return signingKeys.size;
}
