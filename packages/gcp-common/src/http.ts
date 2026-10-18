import {
  ComputeError,
  systemClock,
  type Clock,
  type ErrorCode,
  type Logger,
} from '@better-compute/core';
import type { TokenSource } from './auth.js';

// The REST client every Google Cloud integration shares: plain fetch, a bearer token from a
// TokenSource, and failures mapped to ComputeError codes. Every error carries
// `details: { provider: 'gcp', status, reason }`. A bearer token is only ever put in the
// authorization header; it is never logged and never put in an error message.

export interface GoogleRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Absolute. */
  url: string;
  /** Appended to the URL; an array value repeats the key (`fields=a&fields=b`). */
  query?: Record<string, string | readonly string[]>;
  /** JSON-encoded when present. */
  body?: unknown;
  signal: AbortSignal;
  /** The error-message prefix; default `${method} ${pathname}`. */
  what?: string;
}

export interface GoogleClientOptions {
  fetch: typeof fetch;
  tokens: TokenSource;
  /** Business time for token expiry (default: the system clock). */
  clock?: Clock;
  log?: Logger;
  /** Billed and rate-limited as this project: sent as `x-goog-user-project`. */
  quotaProject?: string;
}

export interface GoogleClient {
  request<T>(request: GoogleRequest): Promise<T>;
}

/** How long a rate-limited or not-ready caller is told to wait when Google gives no hint. */
export const defaultRetryAfterMs = 10_000;

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The first `google.rpc.<type>` entry of an error's `details`. */
function detail(details: unknown, type: 'ErrorInfo' | 'RetryInfo'): Json | undefined {
  if (!Array.isArray(details)) return undefined;
  return details.find(
    (entry): entry is Json =>
      isRecord(entry) && typeof entry['@type'] === 'string' && entry['@type'].endsWith(`.${type}`),
  );
}

/** A protobuf Duration string (`"12s"`, `"0.5s"`) in milliseconds, rounded up. */
function durationMs(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^(\d+(?:\.\d+)?)s$/.exec(value);
  if (!match) return undefined;
  // Round through microseconds so 0.1s is 100ms, not 100.00000000000001.
  return Math.ceil(Math.round(Number(match[1]) * 1e6) / 1e3);
}

const quotaReasons: ReadonlySet<string> = new Set(['QUOTA_EXCEEDED', 'RESOURCE_QUOTA_EXCEEDED']);
const rateLimitReasons: ReadonlySet<string> = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'RATE_LIMIT_EXCEEDED',
]);

/**
 * The ComputeError for a failed Google API response. `body` is the parsed JSON, or undefined when
 * the response was not JSON (a proxy's HTML page). It reads the google.rpc.Status form first
 * (`error.status`, and `error.details[]` for ErrorInfo and RetryInfo), then the legacy Compute
 * Engine form (`error.errors[0].reason`), then the HTTP status. The legacy branches follow
 * `mapGceError` in provider-gcp, so a Compute Engine failure maps the same way through either.
 */
export function mapGoogleError(
  status: number,
  body: unknown,
  headers: Pick<Headers, 'get'>,
  what: string,
): ComputeError {
  const error = isRecord(body) && isRecord(body.error) ? body.error : undefined;
  const rpcStatus = typeof error?.status === 'string' ? error.status : undefined;
  const errorInfo = detail(error?.details, 'ErrorInfo');
  const legacy = Array.isArray(error?.errors) ? (error.errors[0] as unknown) : undefined;
  const reason =
    (typeof errorInfo?.reason === 'string' ? errorInfo.reason : undefined) ??
    (isRecord(legacy) && typeof legacy.reason === 'string' ? legacy.reason : undefined) ??
    rpcStatus ??
    'unknown';
  const message = `${what}: ${typeof error?.message === 'string' ? error.message : `HTTP ${status}`}`;
  const details: Record<string, unknown> = { provider: 'gcp', status, reason };

  const retryAfter = (): number => {
    const hinted = durationMs(detail(error?.details, 'RetryInfo')?.retryDelay);
    if (hinted !== undefined) return hinted;
    const header = headers.get('retry-after');
    const seconds = Number(header);
    return header !== null && Number.isFinite(seconds) && seconds >= 0
      ? seconds * 1000
      : defaultRetryAfterMs;
  };

  let code: ErrorCode;
  if (status === 404) code = 'NOT_FOUND';
  // GCE answers 400 for this in practice; the documented status is 409.
  else if ((status === 409 || status === 400) && reason === 'resourceInUseByAnotherResource')
    code = 'INVALID_STATE';
  else if (status === 409)
    code = 'CONFLICT'; // ALREADY_EXISTS, ABORTED, alreadyExists
  else if (status === 401) code = 'UNAUTHENTICATED';
  else if (status === 403 && reason === 'SERVICE_DISABLED') {
    // The API is not enabled on the project: a configuration fix, with a link to make it.
    code = 'INVALID_CONFIG';
    const metadata = errorInfo?.metadata;
    if (isRecord(metadata) && typeof metadata.activationUrl === 'string')
      details.activationUrl = metadata.activationUrl;
  } else if (
    ((status === 403 || status === 429) && quotaReasons.has(reason)) ||
    (status === 403 && reason === 'quotaExceeded')
  )
    code = 'QUOTA_EXCEEDED';
  else if (status === 429 || (status === 403 && rateLimitReasons.has(reason))) {
    code = 'RATE_LIMITED';
    details.retryAfterMs = retryAfter();
  } else if (status === 400 && reason === 'resourceNotReady') {
    // The resource is mid-transition (a VM stopping or starting): the same call succeeds later.
    code = 'UNAVAILABLE';
    details.retryAfterMs = defaultRetryAfterMs;
  } else if (status === 403)
    code = 'ACCESS_DENIED'; // PERMISSION_DENIED, VPC Service Controls
  else if (status === 400)
    code = rpcStatus === 'FAILED_PRECONDITION' ? 'INVALID_STATE' : 'INVALID_INPUT';
  else if (status === 501) code = 'UNSUPPORTED';
  else if (status >= 500) code = 'UNAVAILABLE';
  else code = 'PROVIDER_ERROR';
  return new ComputeError(code, message, undefined, details);
}

export function googleClient(options: GoogleClientOptions): GoogleClient {
  const clock = options.clock ?? systemClock;

  async function request<T>(req: GoogleRequest): Promise<T> {
    const token = await options.tokens.token({ signal: req.signal, clock });
    const url = new URL(req.url);
    for (const [key, value] of Object.entries(req.query ?? {}))
      for (const item of typeof value === 'string' ? [value] : value)
        url.searchParams.append(key, item);
    const what = req.what ?? `${req.method} ${url.pathname}`;
    // Logged without the query string, which can carry identifiers a log should not.
    const where = { method: req.method, host: url.host, path: url.pathname };
    let response: Response;
    try {
      response = await options.fetch(url.toString(), {
        method: req.method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(req.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(options.quotaProject ? { 'x-goog-user-project': options.quotaProject } : {}),
        },
        ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
        signal: req.signal,
      });
    } catch (error) {
      if (req.signal.aborted) throw error;
      options.log?.warn('google.unreachable', where);
      throw new ComputeError('UNAVAILABLE', `Google API unreachable: ${what}`, undefined, {
        provider: 'gcp',
        status: 0,
        reason: 'network',
      });
    }
    options.log?.debug('google.request', { ...where, status: response.status });
    const text = await response.text();
    let payload: unknown;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = undefined;
    }
    if (response.ok) return (payload ?? {}) as T;
    throw mapGoogleError(response.status, payload, response.headers, what);
  }

  return { request };
}
