import {
  ComputeError,
  isComputeError,
  systemClock,
  type Clock,
  type Logger,
} from '@better-compute/core';
import type { CredentialSource } from './credentials.js';
import { endpointFor, signingRegionFor, type AwsService } from './endpoints.js';
import { mapAwsError, parseAwsError } from './errors.js';
import { serializeAwsQuery, serializeEc2Query, type QueryParams } from './query.js';
import { redactAws } from './redact.js';
import { signRequest } from './sigv4.js';
import { parseXml, type XmlElement } from './xml.js';

// The protocol clients every AWS integration shares: plain fetch, SigV4, and AWS errors mapped to
// ComputeError. No retry loops besides exactly one for clock skew and one for an expired session
// token; the reconciler that called owns backoff.

export interface ServiceClientOptions {
  service: AwsService;
  region: string;
  credentials: CredentialSource;
  fetch?: typeof fetch;
  clock?: Clock;
  log?: Logger;
  /** Host option only (tests, VPC endpoints); never taken from account config. */
  endpoint?: string;
  fips?: boolean;
  /** Default 20 per second, burst 40. */
  rateLimit?: { perSecond: number; burst: number };
  /** Default 20 000. */
  timeoutMs?: number;
  /** How the limiter waits (tests); default a timer that honors the signal. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface RequestOptions {
  signal: AbortSignal;
}

export interface QueryClient {
  /**
   * Calls `action` and returns the parsed response: the EC2 `<ActionResponse>` root, or the
   * awsQuery `<ActionResult>` element (the root when there is none).
   */
  call(action: string, params: QueryParams, options: RequestOptions): Promise<XmlElement>;
}

export interface JsonClient {
  call<T = unknown>(
    operation: string,
    body: Readonly<Record<string, unknown>>,
    options: RequestOptions,
  ): Promise<T>;
}

export interface RestResponse {
  status: number;
  headers: Headers;
  body: Uint8Array;
}

export interface RestClient {
  request(
    method: 'GET' | 'PUT' | 'POST' | 'DELETE' | 'HEAD',
    path: string,
    options: RequestOptions & {
      query?: Readonly<Record<string, string>>;
      headers?: Readonly<Record<string, string>>;
      body?: Uint8Array | string;
      unsignedPayload?: boolean;
      protocol: 'rest-json' | 'rest-xml';
    },
  ): Promise<RestResponse>;
}

const ec2Version = '2016-11-15';

function abortError(signal: AbortSignal): ComputeError {
  const reason: unknown = signal.reason;
  if (isComputeError(reason)) return reason;
  return new ComputeError('UNAVAILABLE', 'the AWS request was cancelled', undefined, {
    provider: 'aws',
    reason: 'aborted',
  });
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError(signal));
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * A token bucket on business time. A caller that finds it empty reserves the next token (the
 * bucket goes negative) and waits for it, so waits stay fair and never re-check a clock that a
 * test does not move.
 */
class Limiter {
  #tokens: number;
  #last: number;
  constructor(
    private readonly perSecond: number,
    private readonly burst: number,
    private readonly clock: Clock,
    private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>,
  ) {
    if (!(perSecond > 0) || !(burst >= 1))
      throw new ComputeError(
        'INVALID_CONFIG',
        'an AWS rate limit needs perSecond > 0 and burst >= 1',
      );
    this.#tokens = burst;
    this.#last = clock.now();
  }

  async take(signal: AbortSignal): Promise<void> {
    const now = this.clock.now();
    this.#tokens = Math.min(
      this.burst,
      this.#tokens + ((now - this.#last) / 1000) * this.perSecond,
    );
    this.#last = now;
    this.#tokens -= 1;
    if (this.#tokens >= 0) return;
    await this.sleep(Math.ceil((-this.#tokens / this.perSecond) * 1000), signal);
  }
}

interface WireRequest {
  operation: string;
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string | Uint8Array;
  protocol: 'ec2' | 'query' | 'json' | 'rest-json' | 'rest-xml';
  s3?: boolean;
  unsignedPayload?: boolean;
}

interface WireResponse {
  status: number;
  headers: Headers;
  body: Uint8Array;
}

const skewCodes: ReadonlySet<string> = new Set(['RequestTimeTooSkewed', 'RequestExpired']);
const expiredTokenCodes: ReadonlySet<string> = new Set(['ExpiredToken', 'ExpiredTokenException']);

/** The shared transport: limiter, credentials, signing, timeout, and the two retries. */
class Transport {
  readonly clock: Clock;
  readonly endpoint: URL;
  readonly signingRegion: string;
  readonly #fetch: typeof fetch;
  readonly #limiter: Limiter;
  readonly #timeoutMs: number;
  #skewMs = 0;

  constructor(readonly options: ServiceClientOptions) {
    this.clock = options.clock ?? systemClock;
    this.endpoint = endpointFor(options.service, options.region, {
      fips: options.fips,
      ...(options.endpoint !== undefined ? { override: options.endpoint } : {}),
    });
    this.signingRegion = signingRegionFor(options.service, options.region);
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    const rate = options.rateLimit ?? { perSecond: 20, burst: 40 };
    this.#limiter = new Limiter(
      rate.perSecond,
      rate.burst,
      this.clock,
      options.sleep ?? defaultSleep,
    );
    this.#timeoutMs = options.timeoutMs ?? 20_000;
  }

  /** The signing name: what the service is called in credential scopes. */
  get signingName(): string {
    return this.options.service === 'monitoring' ? 'monitoring' : this.options.service;
  }

  async send(request: WireRequest, signal: AbortSignal): Promise<WireResponse> {
    await this.#limiter.take(signal);
    let skewRetried = false;
    let tokenRetried = false;
    for (;;) {
      const response = await this.#once(request, signal);
      if (response.status < 300 && response.status >= 200) return response;
      const text = new TextDecoder().decode(response.body);
      const parsed = parseAwsError(request.protocol, response.status, response.headers, text);
      const code = parsed.code ?? '';
      const skewed =
        skewCodes.has(code) ||
        (code === 'InvalidSignatureException' && /expired/i.test(parsed.message ?? ''));
      if (skewed && !skewRetried) {
        const serverDate = Date.parse(response.headers.get('date') ?? '');
        if (Number.isFinite(serverDate)) {
          skewRetried = true;
          this.#skewMs = serverDate - this.clock.now();
          continue;
        }
      }
      if (expiredTokenCodes.has(code) && !tokenRetried && this.options.credentials.invalidate) {
        tokenRetried = true;
        this.options.credentials.invalidate();
        continue;
      }
      throw mapAwsError({ ...parsed, service: this.options.service });
    }
  }

  async #once(request: WireRequest, signal: AbortSignal): Promise<WireResponse> {
    if (signal.aborted) throw abortError(signal);
    const credentials = await this.options.credentials.credentials({ signal, clock: this.clock });
    const headers = { ...request.headers };
    const signed = signRequest({
      method: request.method,
      url: request.url,
      headers,
      body: request.body,
      service: this.signingName,
      region: this.signingRegion,
      credentials,
      now: this.clock.now() + this.#skewMs,
      contentSha256Header: request.s3,
      unsignedPayload: request.unsignedPayload,
      normalizePath: !request.s3,
    });
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.#timeoutMs);
    const onAbort = () => controller.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    const started = Date.now();
    try {
      const response = await this.#fetch(request.url, {
        method: request.method,
        headers: { ...headers, ...signed },
        body:
          request.method === 'GET' || request.method === 'HEAD'
            ? undefined
            : (request.body as BodyInit),
        signal: controller.signal,
        redirect: 'manual',
      });
      const body = new Uint8Array(await response.arrayBuffer());
      this.options.log?.debug('aws request', {
        service: this.options.service,
        operation: request.operation,
        status: response.status,
        requestId:
          response.headers.get('x-amzn-requestid') ??
          response.headers.get('x-amz-request-id') ??
          undefined,
        ms: Date.now() - started,
      });
      return { status: response.status, headers: response.headers, body };
    } catch (error) {
      if (isComputeError(error)) throw error;
      if (signal.aborted) throw abortError(signal);
      const reason = timedOut ? 'timeout' : 'network';
      throw new ComputeError(
        'UNAVAILABLE',
        `AWS ${this.options.service} ${request.operation}: ${timedOut ? 'timed out' : 'network failure'}`,
        undefined,
        { provider: 'aws', service: this.options.service, reason },
      );
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }
}

function parseBody(body: Uint8Array, service: string, operation: string): XmlElement {
  try {
    return parseXml(new TextDecoder().decode(body));
  } catch (error) {
    if (isComputeError(error)) throw error;
    throw new ComputeError(
      'PROVIDER_ERROR',
      redactAws(`AWS ${service} ${operation}: unreadable response`),
    );
  }
}

const actionPattern = /^[A-Za-z][A-Za-z0-9]{0,127}$/;

function checkAction(action: string): void {
  if (!actionPattern.test(action))
    throw new ComputeError('INVALID_INPUT', 'malformed AWS operation name');
}

function formClient(
  options: ServiceClientOptions,
  version: string,
  flavour: 'ec2' | 'query',
): QueryClient {
  const transport = new Transport(options);
  return {
    async call(action, params, { signal }) {
      checkAction(action);
      const body =
        flavour === 'ec2'
          ? serializeEc2Query(action, version, params)
          : serializeAwsQuery(action, version, params);
      const response = await transport.send(
        {
          operation: action,
          method: 'POST',
          url: transport.endpoint,
          headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
          body,
          protocol: flavour,
        },
        signal,
      );
      const doc = parseBody(response.body, options.service, action);
      return flavour === 'query' ? (doc.child(`${action}Result`) ?? doc) : doc;
    },
  };
}

/** The EC2 protocol (service `ec2`, version 2016-11-15). */
export function ec2Client(options: Omit<ServiceClientOptions, 'service'>): QueryClient {
  return formClient({ ...options, service: 'ec2' }, ec2Version, 'ec2');
}

/** The awsQuery protocol (STS, IAM, SNS, …). */
export function queryClient(options: ServiceClientOptions & { version: string }): QueryClient {
  return formClient(options, options.version, 'query');
}

/** The JSON 1.0/1.1 protocol: `X-Amz-Target: <targetPrefix>.<operation>`. */
export function jsonClient(
  options: ServiceClientOptions & { jsonVersion: '1.0' | '1.1'; targetPrefix: string },
): JsonClient {
  const transport = new Transport(options);
  if (!/^[A-Za-z0-9_.]{1,128}$/.test(options.targetPrefix))
    throw new ComputeError('INVALID_CONFIG', 'malformed AWS JSON target prefix');
  return {
    async call<T>(
      operation: string,
      body: Readonly<Record<string, unknown>>,
      { signal }: RequestOptions,
    ) {
      checkAction(operation);
      const response = await transport.send(
        {
          operation,
          method: 'POST',
          url: transport.endpoint,
          headers: {
            'content-type': `application/x-amz-json-${options.jsonVersion}`,
            'x-amz-target': `${options.targetPrefix}.${operation}`,
          },
          body: JSON.stringify(body),
          protocol: 'json',
        },
        signal,
      );
      const text = new TextDecoder().decode(response.body);
      if (text.trim() === '') return {} as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new ComputeError(
          'PROVIDER_ERROR',
          `AWS ${options.service} ${operation}: unreadable response`,
        );
      }
    },
  };
}

/** rest-json and rest-xml (S3 with `s3: true`: no path normalization, x-amz-content-sha256). */
export function restClient(options: ServiceClientOptions & { s3?: boolean }): RestClient {
  const transport = new Transport(options);
  return {
    async request(method, path, request) {
      if (!path.startsWith('/') || /[\r\n#?]/.test(path))
        throw new ComputeError(
          'INVALID_INPUT',
          'a REST path starts with / and has no query or fragment',
        );
      const url = new URL(transport.endpoint.toString());
      url.pathname = `${url.pathname.replace(/\/$/, '')}${path}`;
      for (const [key, value] of Object.entries(request.query ?? {}))
        url.searchParams.append(key, value);
      const response = await transport.send(
        {
          operation: `${method} ${path.split('/')[1] ?? ''}`,
          method,
          url,
          headers: { ...(request.headers ?? {}) },
          body: request.body ?? '',
          protocol: request.protocol,
          s3: options.s3,
          unsignedPayload: request.unsignedPayload,
        },
        request.signal,
      );
      return response;
    },
  };
}
