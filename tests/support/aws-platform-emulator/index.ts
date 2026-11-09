// An in-memory AWS emulator for the @better-compute/aws platform-service tests. It checks every
// request's SigV4 signature (header or query authentication) against the keys it knows, routes by
// the credential scope's service, and lets tests inject failures. Service fakes live beside it.
import { createHash, createHmac } from 'node:crypto';
import { manualClock, type ManualClock } from '@better-compute/core';
import { canonicalRequest, presignUrl } from '@better-compute/aws-core';
import type { CredentialSource } from '../../../packages/aws/src/internal/transport.js';

export type EmuProtocol = 'json' | 'query' | 'rest-xml';

export interface EmuRequest {
  service: string;
  operation: string;
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: Uint8Array;
  /** Query-authenticated (presigned). */
  presigned: boolean;
  accessKeyId: string;
}

export interface ServiceHandler {
  protocol: EmuProtocol;
  /** The operation name for routing and failure injection (json/query are derived when absent). */
  operation?(request: Omit<EmuRequest, 'operation'>): string;
  handle(request: EmuRequest): Promise<Response> | Response;
}

export const testAccessKeyId = 'AKIATESTKEY0000000001';
export const testSecret = 'testsecret';

export class EmuError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amzn-requestid': 'req-emu' },
  });
}

export function xmlResponse(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/xml', ...headers } });
}

export function escapeXml(text: string): string {
  return text.replace(/[<>&'"]/g, (c) => `&${{ '<': 'lt', '>': 'gt', '&': 'amp', "'": 'apos', '"': 'quot' }[c]};`);
}

function errorResponse(protocol: EmuProtocol, code: string, message: string, status: number, date: number): Response {
  const headers = { date: new Date(date).toUTCString() };
  if (protocol === 'json')
    return new Response(JSON.stringify({ __type: `com.amazonaws.emu#${code}`, message }), {
      status,
      headers: { ...headers, 'content-type': 'application/x-amz-json-1.1' },
    });
  if (protocol === 'query')
    return new Response(
      `<ErrorResponse><Error><Type>Sender</Type><Code>${escapeXml(code)}</Code><Message>${escapeXml(message)}</Message></Error><RequestId>req-emu</RequestId></ErrorResponse>`,
      { status, headers: { ...headers, 'content-type': 'text/xml' } },
    );
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${escapeXml(code)}</Code><Message>${escapeXml(message)}</Message><RequestId>req-emu</RequestId></Error>`,
    { status, headers: { ...headers, 'content-type': 'application/xml' } },
  );
}

function hmac(key: Uint8Array | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function parseAmzDate(text: string): number {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(text);
  if (!match) return Number.NaN;
  const [, y, mo, d, h, mi, s] = match.map(Number) as number[];
  return Date.UTC(y!, mo! - 1, d!, h!, mi!, s!);
}

export class AwsEmulator {
  readonly clock: ManualClock;
  readonly requests: EmuRequest[] = [];
  /** Every request the emulator refused at authentication. */
  readonly refused: { reason: string }[] = [];
  readonly keys = new Map<string, string>([[testAccessKeyId, testSecret]]);
  /** Moves the emulator's own notion of now relative to `clock` (clock-skew tests). */
  skewMs = 0;
  private readonly handlers = new Map<string, ServiceHandler>();
  private readonly failures: { operation: string; code: string; status: number; times: number }[] = [];

  constructor(start = Date.UTC(2026, 9, 1, 12, 0, 0)) {
    this.clock = manualClock(start);
  }

  /** A credential source with the test key. */
  readonly credentials: CredentialSource = {
    kind: 'test',
    credentials: async () => ({ accessKeyId: testAccessKeyId, secretAccessKey: testSecret }),
  };

  get now(): number {
    return this.clock.now() + this.skewMs;
  }

  register(service: string, handler: ServiceHandler): void {
    this.handlers.set(service, handler);
  }

  failNext(operation: string, code: string, status = 400, times = 1): void {
    this.failures.push({ operation, code, status, times });
  }

  /** Requests of one operation. */
  calls(operation: string): EmuRequest[] {
    return this.requests.filter((request) => request.operation === operation);
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const request = new Request(input as RequestInfo, init as RequestInit);
    const url = new URL(request.url);
    const body = new Uint8Array(await request.arrayBuffer());
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => (headers[key] = value));
    const auth = this.authenticate(request.method, url, headers, body);
    if ('error' in auth) {
      this.refused.push({ reason: auth.error.code });
      const handler = auth.service ? this.handlers.get(auth.service) : undefined;
      return errorResponse(handler?.protocol ?? 'rest-xml', auth.error.code, auth.error.message, auth.error.status, this.now);
    }
    const handler = this.handlers.get(auth.service);
    if (!handler) return errorResponse('rest-xml', 'UnknownService', `no fake for ${auth.service}`, 400, this.now);
    const base = { service: auth.service, method: request.method, url, headers, body, presigned: auth.presigned, accessKeyId: auth.accessKeyId };
    const operation = handler.operation?.(base) ?? this.defaultOperation(handler.protocol, headers, body);
    const emuRequest: EmuRequest = { ...base, operation };
    this.requests.push(emuRequest);
    const failure = this.failures.find((entry) => entry.operation === operation);
    if (failure) {
      failure.times -= 1;
      if (failure.times <= 0) this.failures.splice(this.failures.indexOf(failure), 1);
      return errorResponse(handler.protocol, failure.code, `injected ${failure.code}`, failure.status, this.now);
    }
    try {
      return await handler.handle(emuRequest);
    } catch (error) {
      if (error instanceof EmuError) return errorResponse(handler.protocol, error.code, error.message, error.status, this.now);
      throw error;
    }
  };

  private defaultOperation(protocol: EmuProtocol, headers: Record<string, string>, body: Uint8Array): string {
    if (protocol === 'json') return (headers['x-amz-target'] ?? '').split('.').at(-1) ?? '';
    if (protocol === 'query') return new URLSearchParams(Buffer.from(body).toString('utf8')).get('Action') ?? '';
    return '';
  }

  /** Checks a header-authenticated or presigned request; returns the service or why it is refused. */
  authenticate(
    method: string,
    url: URL,
    headers: Record<string, string>,
    body: Uint8Array,
  ): { service: string; presigned: boolean; accessKeyId: string } | { error: EmuError; service?: string } {
    const presigned = url.searchParams.has('X-Amz-Signature');
    let credential: string;
    let signedHeaders: string;
    let signature: string;
    let date: number;
    let checkUrl = url;
    let payloadHash: string | undefined;
    let expiresInSeconds = 0;
    if (presigned) {
      credential = url.searchParams.get('X-Amz-Credential') ?? '';
      signedHeaders = url.searchParams.get('X-Amz-SignedHeaders') ?? '';
      signature = url.searchParams.get('X-Amz-Signature') ?? '';
      date = parseAmzDate(url.searchParams.get('X-Amz-Date') ?? '');
      const expires = Number(url.searchParams.get('X-Amz-Expires'));
      if (!Number.isFinite(date) || !(Number.isInteger(expires) && expires >= 1 && expires <= 604_800))
        return { error: new EmuError('AuthorizationQueryParametersError', 'bad query auth', 400) };
      expiresInSeconds = expires;
      if (this.now > date + expires * 1000)
        return { error: new EmuError('AccessDenied', 'Request has expired', 403), service: credential.split('/')[3] };
      checkUrl = new URL(url);
      checkUrl.searchParams.delete('X-Amz-Signature');
    } else {
      const match = /^AWS4-HMAC-SHA256 Credential=([^,]+), SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(
        headers.authorization ?? '',
      );
      if (!match) return { error: new EmuError('MissingAuthenticationToken', 'missing or malformed authorization', 403) };
      [, credential, signedHeaders, signature] = match as unknown as [string, string, string, string];
      date = parseAmzDate(headers['x-amz-date'] ?? '');
      payloadHash = headers['x-amz-content-sha256'];
    }
    const [accessKeyId, day, region, service, terminator] = credential.split('/');
    // S3 presigns UNSIGNED-PAYLOAD; other services (rds-db) sign the empty body's hash.
    if (presigned && service === 's3') payloadHash = 'UNSIGNED-PAYLOAD';
    const secret = this.keys.get(accessKeyId ?? '');
    if (!secret || terminator !== 'aws4_request' || !service || !region || !day)
      return { error: new EmuError('InvalidClientTokenId', 'unknown access key', 403), service };
    if (!presigned && (!Number.isFinite(date) || Math.abs(date - this.now) > 15 * 60_000))
      return { error: new EmuError('RequestTimeTooSkewed', 'request time too skewed', 403), service };
    if (presigned && date > this.now + 15 * 60_000)
      return { error: new EmuError('AccessDenied', 'request not yet valid', 403), service };
    const bodyHash = createHash('sha256').update(body).digest('hex');
    if (payloadHash !== undefined && payloadHash !== 'UNSIGNED-PAYLOAD' && payloadHash !== bodyHash)
      return { error: new EmuError('XAmzContentSHA256Mismatch', 'payload hash mismatch', 400), service };
    const signed: Record<string, string> = {};
    for (const name of signedHeaders.split(';')) if (name !== 'host') signed[name] = headers[name] ?? '';
    if (!signedHeaders.split(';').includes('host'))
      return { error: new EmuError('SignatureDoesNotMatch', 'host is not signed', 403), service };
    if (presigned) {
      // Query authentication is checked by presigning the same request again with the signer and
      // comparing signatures: the URL without its X-Amz-* parameters, at the URL's own time.
      const bare = new URL(url);
      const token = bare.searchParams.get('X-Amz-Security-Token') ?? undefined;
      for (const name of [...bare.searchParams.keys()])
        if (name.toLowerCase().startsWith('x-amz-')) bare.searchParams.delete(name);
      let again: string;
      try {
        again = presignUrl({
          method,
          url: bare,
          headers: signed,
          service,
          region,
          credentials: { accessKeyId: accessKeyId!, secretAccessKey: secret, ...(token ? { sessionToken: token } : {}) },
          now: date,
          expiresInSeconds,
          unsignedPayload: payloadHash === 'UNSIGNED-PAYLOAD',
          normalizePath: service !== 's3',
        });
      } catch {
        return { error: new EmuError('SignatureDoesNotMatch', 'signature mismatch', 403), service };
      }
      if (new URL(again).searchParams.get('X-Amz-Signature') !== signature)
        return { error: new EmuError('SignatureDoesNotMatch', 'signature mismatch', 403), service };
      return { service, presigned, accessKeyId: accessKeyId! };
    }
    const { canonical } = canonicalRequest({
      method,
      url: checkUrl,
      headers: signed,
      body,
      service,
      region,
      credentials: { accessKeyId: accessKeyId!, secretAccessKey: secret },
      now: date,
      unsignedPayload: payloadHash === 'UNSIGNED-PAYLOAD',
      normalizePath: service !== 's3',
    });
    const amz = new Date(date).toISOString().replace(/[:-]|\.\d{3}/g, '');
    const stringToSign = ['AWS4-HMAC-SHA256', amz, `${day}/${region}/${service}/aws4_request`, createHash('sha256').update(canonical).digest('hex')].join('\n');
    const key = hmac(hmac(hmac(hmac(`AWS4${secret}`, day), region), service), 'aws4_request');
    const expected = createHmac('sha256', key).update(stringToSign).digest('hex');
    if (expected !== signature) return { error: new EmuError('SignatureDoesNotMatch', 'signature mismatch', 403), service };
    return { service, presigned, accessKeyId: accessKeyId! };
  }
}

/** A logger that records everything (for never-logs-secrets sweeps). */
export function recordingLogger() {
  const entries: { level: string; message: string; fields?: Record<string, unknown> }[] = [];
  const at = (level: string) => (message: string, fields?: Record<string, unknown>) => {
    entries.push({ level, message, ...(fields ? { fields } : {}) });
  };
  return {
    entries,
    text: () => JSON.stringify(entries),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
  };
}
