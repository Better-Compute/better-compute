import {
  ComputeError,
  systemClock,
  type Clock,
  type ErrorCode,
  type Logger,
} from '@better-compute/core';
import type { TokenSource } from './auth.js';

// A Compute Engine REST v1 client over plain fetch. Paths are relative to the project
// (`/zones/z/instances`); every call carries a fresh-enough bearer token. Errors are mapped to
// ComputeError codes and always carry `details: { provider: 'gcp', status, reason }`.

export interface GceClient {
  /** `path` is relative to the project, or starts with `/projects/<project>/` to name another. */
  request<T>(
    method: 'GET' | 'POST' | 'DELETE' | 'PATCH',
    path: string,
    options: { body?: unknown; query?: Record<string, string>; signal: AbortSignal },
  ): Promise<T>;
  /** Every element of a list response's `field` array, following `nextPageToken`. */
  pages<T>(
    path: string,
    field: string,
    options: { query?: Record<string, string>; signal: AbortSignal },
  ): AsyncIterable<T>;
  /** Every element of `field` in each scope of an aggregatedList response, following pages. */
  aggregated<T>(
    path: string,
    field: string,
    options: { query?: Record<string, string>; signal: AbortSignal },
  ): AsyncIterable<T>;
}

export interface GceClientOptions {
  fetch: typeof fetch;
  endpoint: string;
  projectId: string;
  tokens: TokenSource;
  /** Business time for token expiry (default: the system clock). */
  clock?: Clock;
  log?: Logger;
}

interface GceErrorBody {
  error?: { code?: number; message?: string; errors?: { reason?: string; message?: string }[] };
}

const defaultRetryAfterMs = 10_000;

/** The ComputeError for a failed GCE HTTP response. */
export function mapGceError(
  status: number,
  body: unknown,
  headers: Pick<Headers, 'get'>,
  what = 'Compute Engine request',
): ComputeError {
  const error = (body as GceErrorBody | undefined)?.error;
  const reason = error?.errors?.[0]?.reason ?? 'unknown';
  const message = `${what}: ${error?.message ?? `HTTP ${status}`}`;
  const details: Record<string, unknown> = { provider: 'gcp', status, reason };
  let code: ErrorCode;
  if (status === 404) code = 'NOT_FOUND';
  else if (status === 409 && reason === 'alreadyExists') code = 'CONFLICT';
  // GCE answers 400 for this in practice; the documented status is 409.
  else if ((status === 409 || status === 400) && reason === 'resourceInUseByAnotherResource')
    code = 'INVALID_STATE';
  else if (
    status === 429 ||
    (status === 403 && (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded'))
  ) {
    code = 'RATE_LIMITED';
    const seconds = Number(headers.get('retry-after'));
    details.retryAfterMs =
      headers.get('retry-after') !== null && Number.isFinite(seconds) && seconds >= 0
        ? seconds * 1000
        : defaultRetryAfterMs;
  } else if (status === 403 && reason === 'quotaExceeded') code = 'QUOTA_EXCEEDED';
  else if (status === 403) code = 'ACCESS_DENIED';
  else if (status === 400) code = 'INVALID_INPUT';
  else if (status >= 500) code = 'UNAVAILABLE';
  else code = 'PROVIDER_ERROR';
  return new ComputeError(code, message, undefined, details);
}

/** The error of a finished (`DONE`) operation that carries one, else undefined. */
export function operationFailure(
  operation: {
    error?: { errors?: { code?: string; message?: string }[] };
    httpErrorStatusCode?: number;
    httpErrorMessage?: string;
  },
  what = 'Compute Engine operation',
): ComputeError | undefined {
  const first = operation.error?.errors?.[0];
  if (!operation.error) return undefined;
  const reason = first?.code ?? 'unknown';
  const status = operation.httpErrorStatusCode ?? 200;
  const message = `${what}: ${first?.message ?? operation.httpErrorMessage ?? reason}`;
  const details = { provider: 'gcp', status, reason };
  if (reason.startsWith('ZONE_RESOURCE_POOL_EXHAUSTED'))
    return new ComputeError('CAPACITY_UNAVAILABLE', message, undefined, details);
  if (reason === 'QUOTA_EXCEEDED' || reason.startsWith('QUOTA_EXCEEDED'))
    return new ComputeError('QUOTA_EXCEEDED', message, undefined, details);
  if (reason === 'RESOURCE_ALREADY_EXISTS')
    return new ComputeError('CONFLICT', message, undefined, details);
  if (reason === 'RESOURCE_NOT_FOUND')
    return new ComputeError('NOT_FOUND', message, undefined, details);
  if (reason === 'RESOURCE_IN_USE_BY_ANOTHER_RESOURCE')
    return new ComputeError('INVALID_STATE', message, undefined, details);
  return new ComputeError('PROVIDER_ERROR', message, undefined, details);
}

export function gceClient(options: GceClientOptions): GceClient {
  const endpoint = options.endpoint.replace(/\/+$/, '');
  const clock = options.clock ?? systemClock;
  const base = `${endpoint}/projects/${options.projectId}`;

  async function request<T>(
    method: 'GET' | 'POST' | 'DELETE' | 'PATCH',
    path: string,
    opts: { body?: unknown; query?: Record<string, string>; signal: AbortSignal },
  ): Promise<T> {
    const token = await options.tokens.token({ signal: opts.signal, clock });
    // A path that starts with /projects/ names another project (a shared template, say).
    const url = new URL(path.startsWith('/projects/') ? `${endpoint}${path}` : `${base}${path}`);
    for (const [key, value] of Object.entries(opts.query ?? {})) url.searchParams.set(key, value);
    const what = `${method} ${path}`;
    let response: Response;
    try {
      response = await options.fetch(url.toString(), {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        signal: opts.signal,
      });
    } catch (error) {
      if (opts.signal.aborted) throw error;
      options.log?.warn('gce.unreachable', { method, path });
      throw new ComputeError('UNAVAILABLE', `Compute Engine unreachable: ${what}`, undefined, {
        provider: 'gcp',
        status: 0,
        reason: 'network',
      });
    }
    options.log?.debug('gce.request', { method, path, status: response.status });
    const text = await response.text();
    let payload: unknown;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = undefined;
    }
    if (response.ok) return (payload ?? {}) as T;
    throw mapGceError(response.status, payload, response.headers, what);
  }

  async function* pages<T>(
    path: string,
    field: string,
    opts: { query?: Record<string, string>; signal: AbortSignal },
  ): AsyncIterable<T> {
    let pageToken: string | undefined;
    do {
      const page: Record<string, unknown> = await request<Record<string, unknown>>('GET', path, {
        query: { ...opts.query, ...(pageToken ? { pageToken } : {}) },
        signal: opts.signal,
      });
      for (const item of (page[field] as T[] | undefined) ?? []) yield item;
      pageToken =
        typeof page.nextPageToken === 'string' && page.nextPageToken
          ? page.nextPageToken
          : undefined;
    } while (pageToken);
  }

  async function* aggregated<T>(
    path: string,
    field: string,
    opts: { query?: Record<string, string>; signal: AbortSignal },
  ): AsyncIterable<T> {
    let pageToken: string | undefined;
    do {
      const page: Record<string, unknown> = await request<Record<string, unknown>>('GET', path, {
        query: { ...opts.query, ...(pageToken ? { pageToken } : {}) },
        signal: opts.signal,
      });
      const scopes = (page.items ?? {}) as Record<string, Record<string, unknown>>;
      for (const scope of Object.values(scopes))
        for (const item of (scope[field] as T[] | undefined) ?? []) yield item;
      pageToken =
        typeof page.nextPageToken === 'string' && page.nextPageToken
          ? page.nextPageToken
          : undefined;
    } while (pageToken);
  }

  return { request, pages, aggregated };
}

/** A Compute Engine `Operation` (the members this provider reads). */
export interface GceOperation {
  name: string;
  status: 'PENDING' | 'RUNNING' | 'DONE';
  selfLink?: string;
  zone?: string;
  region?: string;
  error?: { errors?: { code?: string; message?: string }[] };
  httpErrorStatusCode?: number;
  httpErrorMessage?: string;
}

/** The project-relative path of an operation (`/zones/z/operations/op`), from its selfLink. */
export function operationPath(operation: GceOperation): string {
  const link = operation.selfLink
    ? /\/projects\/[^/]+(\/.+?)(?:\?.*)?$/.exec(operation.selfLink)
    : null;
  if (link) return link[1]!;
  if (operation.zone)
    return `/zones/${operation.zone.split('/').pop()}/operations/${operation.name}`;
  if (operation.region)
    return `/regions/${operation.region.split('/').pop()}/operations/${operation.name}`;
  return `/global/operations/${operation.name}`;
}

/** Throws the operation's error when it is finished and failed; returns the operation otherwise. */
export function settled(operation: GceOperation, what?: string): GceOperation {
  if (operation.status === 'DONE') {
    const failure = operationFailure(operation, what);
    if (failure) throw failure;
  }
  return operation;
}

/** Reads an operation once. */
export async function getOperation(
  client: GceClient,
  operation: GceOperation,
  signal: AbortSignal,
): Promise<GceOperation> {
  return client.request<GceOperation>('GET', operationPath(operation), { signal });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Polls an operation until it is DONE, at most `maxMs / pollMs` reads apart by `pollMs`, and throws
 * the operation's error if it failed. For in-call waits of at most 20 seconds; anything longer
 * belongs to the reconciler. Returns the last state read (not DONE if the wait ran out).
 */
export async function waitForOperation(
  client: GceClient,
  operation: GceOperation,
  options: { signal: AbortSignal; pollMs: number; maxMs: number; what?: string },
): Promise<GceOperation> {
  let current = settled(operation, options.what);
  const reads = Math.max(1, Math.ceil(options.maxMs / Math.max(1, options.pollMs)));
  for (let read = 0; current.status !== 'DONE' && read < reads; read++) {
    if (read > 0) await sleep(options.pollMs, options.signal);
    current = settled(await getOperation(client, current, options.signal), options.what);
  }
  return current;
}
