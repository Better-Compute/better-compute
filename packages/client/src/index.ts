import type { Credential } from '@better-compute/core';

export * from './tunnel.js';

/** HTTP errors keep the server's stable code without exposing raw response bodies. */
export class ComputeClientError extends Error {
  /** Machine-readable context from the server, such as `confirmationId` for `CONFIRMATION_REQUIRED`. */
  details?: Record<string, unknown>;
  constructor(
    readonly code: string,
    message: string,
    /** The HTTP status; `0` when the client refused before sending anything. */
    readonly status: number,
    /** For `RATE_LIMITED` and retryable conflicts: how long to wait before retrying. */
    readonly retryAfterMs?: number,
    /** The request's `X-Request-Id`, for support tickets and log lookups. */
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ComputeClientError';
  }
}

export interface ComputeClientOptions {
  /** The API's origin. Defaults to the current page's origin in a browser. */
  baseURL?: string;
  /** Where the API is mounted (default `/api/compute`). */
  basePath?: string;
  /**
   * The bearer token, read at every request and never stored: an IAM token (`biam_…`) or a session
   * JWT whose audience includes compute. Other shapes fail with `INVALID_TOKEN` before any request.
   */
  token?: string | (() => string | undefined | Promise<string | undefined>);
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  fetch?: typeof globalThis.fetch;
  /**
   * `omit` by default: compute authenticates bearer tokens. A same-origin console that relies on
   * the IAM cookie (the server's `acceptIamCookie`) uses `same-origin`.
   */
  credentials?: 'omit' | 'same-origin' | 'include';
  /**
   * Send an `X-Request-Id` on every request (the server echoes it and passes it to IAM) and expose
   * it as `ComputeClientError.requestId`. `true` generates one per request; a function supplies one.
   */
  requestId?: boolean | (() => string);
  /**
   * Retry a `RATE_LIMITED` response once after the server's `retryAfterMs`, when that wait is at
   * most `maxWaitMs` (five seconds by default). Off by default. Aborting the call's `signal` during
   * the wait rejects at once without a second request.
   */
  retryRateLimited?: boolean | { maxWaitMs?: number };
  /** Called once per `UNAUTHENTICATED` response, after the error is raised (send people to sign in). */
  onUnauthenticated?: (error: ComputeClientError) => void;
}

export interface ComputeCallOptions {
  signal?: AbortSignal;
  headers?: HeadersInit;
}

type AnyMethod = (...args: never[]) => unknown;
/** The input of a method that takes none. */
type NoInput = Record<string, never>;
/** Whether a server parameter is the caller's credential (`{ headers?, token? }`), which the client supplies. */
type IsCredential<T> = [NonNullable<T>] extends [object]
  ? Exclude<keyof NonNullable<T>, keyof Credential> extends never
    ? true
    : false
  : false;
/**
 * A server method `(credential, input)` becomes `(input, options?)`; `input` stays optional when
 * the server's is, as for methods without required fields (`client.system.version()`).
 */
type ClientArguments<T extends AnyMethod, P extends unknown[] = Parameters<T>> =
  Required<P> extends [infer First, infer Input, ...unknown[]]
    ? IsCredential<First> extends true
      ? [First] extends P
        ? [input?: Input, options?: ComputeCallOptions]
        : [input: Input, options?: ComputeCallOptions]
      : [input: First, options?: ComputeCallOptions]
    : Required<P> extends [infer First]
      ? IsCredential<First> extends true
        ? [input?: NoInput, options?: ComputeCallOptions]
        : [] extends P
          ? [input?: First, options?: ComputeCallOptions]
          : [input: First, options?: ComputeCallOptions]
      : [input?: NoInput, options?: ComputeCallOptions];
type ClientMethod<T extends AnyMethod> = (
  ...args: ClientArguments<T>
) => Promise<Awaited<ReturnType<T>>>;

/** API groups as the client exposes them; `plugins` is typed separately. */
export type ClientGroups<Api> = {
  [Group in keyof Api as Group extends 'plugins' ? never : Group]: {
    [Method in keyof Api[Group] as Api[Group][Method] extends AnyMethod
      ? Method
      : never]: Api[Group][Method] extends AnyMethod ? ClientMethod<Api[Group][Method]> : never;
  };
};
type ClientPlugins<Api> = Api extends { plugins: infer Plugins }
  ? { plugins: { [Id in keyof Plugins]: ClientGroups<Plugins[Id]> } }
  : {};

export interface ClientTransport {
  /** Calls any route below the base path (`system/version`, `plugins/acme/widgets/poke`). */
  $request<Output = unknown>(
    path: string,
    input?: unknown,
    options?: ComputeCallOptions,
  ): Promise<Output>;
}

/** The client of a `betterCompute()` instance: its groups, `plugins[id]` and `$request`. */
export type ComputeClient<T extends { api: unknown }> = ClientGroups<T['api']> &
  ClientPlugins<T['api']> &
  ClientTransport;

/** Segments a JavaScript object or `await` would trip over; never routes. */
const reserved = new Set([
  'then',
  'catch',
  'finally',
  'toJSON',
  'constructor',
  'prototype',
  '__proto__',
]);
const requestIdPattern = /^[A-Za-z0-9._:-]{1,128}$/;

function routeSegment(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_-]*$/.test(value) && !reserved.has(value);
}

/**
 * The bearer shapes the server can accept: an opaque token (`biam_…`) or a session JWT (three
 * base64url segments, at most 4096 characters). Anything else never reaches an `Authorization` header.
 */
function bearerToken(value: string): boolean {
  if (/^[A-Za-z0-9_-]{16,512}$/.test(value)) return true;
  return (
    value.length <= 4096 &&
    /^[A-Za-z0-9_-]{2,1024}\.[A-Za-z0-9_-]{2,3072}\.[A-Za-z0-9_-]{2,1024}$/.test(value)
  );
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A typed client, inferred from the server with a type-only import. Browser-safe.
 *
 * ```ts
 * import type { compute } from './compute.server';
 * const client = createComputeClient<typeof compute>({ baseURL, token: () => session.getToken() });
 * const { version } = await client.system.version();
 * await client.plugins['acme-autoinstall'].isos.render({ tenantId, nodeId });
 * ```
 */
export function createComputeClient<T extends { api: unknown }>(
  options: ComputeClientOptions = {},
): ComputeClient<T> {
  const origin =
    options.baseURL ??
    (typeof location === 'object' && location !== null ? location.origin : undefined);
  if (!origin)
    throw new ComputeClientError('INVALID_CONFIG', 'baseURL is required outside a browser', 0);
  let base: URL;
  try {
    base = new URL(origin);
  } catch {
    throw new ComputeClientError('INVALID_CONFIG', 'baseURL must be an absolute HTTP(S) URL', 0);
  }
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new ComputeClientError(
      'INVALID_CONFIG',
      'baseURL must be an HTTP(S) URL without credentials, query or fragment',
      0,
    );
  const basePath = options.basePath ?? '/api/compute';
  if (!/^(?:\/[A-Za-z0-9_-]+)+$/.test(basePath))
    throw new ComputeClientError(
      'INVALID_CONFIG',
      'basePath must be an absolute path without a trailing slash',
      0,
    );
  const fetcher = options.fetch ?? globalThis.fetch?.bind(globalThis);
  if (!fetcher)
    throw new ComputeClientError('INVALID_CONFIG', 'A Fetch implementation is required', 0);
  const credentials = options.credentials ?? 'omit';
  if (!['omit', 'same-origin', 'include'].includes(credentials))
    throw new ComputeClientError(
      'INVALID_CONFIG',
      'credentials must be omit, same-origin or include',
      0,
    );
  const retryWait =
    options.retryRateLimited === true
      ? 5_000
      : isRecord(options.retryRateLimited)
        ? (options.retryRateLimited.maxWaitMs ?? 5_000)
        : 0;

  const nextRequestId = (): string | undefined => {
    if (typeof options.requestId === 'function') return options.requestId();
    if (options.requestId === true)
      return typeof globalThis.crypto?.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    return undefined;
  };
  const aborted = (signal: AbortSignal): unknown =>
    signal.reason ??
    (typeof DOMException === 'function'
      ? new DOMException('This operation was aborted', 'AbortError')
      : Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
  const sleep = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (!signal) return void setTimeout(resolve, ms);
      if (signal.aborted) return reject(aborted(signal));
      const onAbort = () => {
        clearTimeout(timer);
        reject(aborted(signal));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal.addEventListener('abort', onAbort, { once: true });
    });

  const attempt = async <Output>(
    path: string,
    input: unknown,
    callOptions: ComputeCallOptions,
  ): Promise<Output> => {
    if (!path || !path.split('/').every(routeSegment))
      throw new ComputeClientError(
        'INVALID_PATH',
        'Routes must use plain relative path segments',
        0,
      );
    const configured =
      typeof options.headers === 'function' ? await options.headers() : options.headers;
    const headers = new Headers(configured);
    new Headers(callOptions.headers).forEach((value, key) => headers.set(key, value));
    // Invariant: the server's CSRF boundary requires both.
    headers.set('content-type', 'application/json');
    headers.set('x-better-compute', '1');
    const requestId = nextRequestId();
    if (requestId !== undefined) {
      if (typeof requestId !== 'string' || !requestIdPattern.test(requestId))
        throw new ComputeClientError('INVALID_CONFIG', 'requestId must be a short plain token', 0);
      headers.set('x-request-id', requestId);
    }
    const token = typeof options.token === 'function' ? await options.token() : options.token;
    if (token !== undefined) {
      if (typeof token !== 'string' || !bearerToken(token))
        throw new ComputeClientError('INVALID_TOKEN', 'Invalid bearer token format', 0);
      headers.set('authorization', `Bearer ${token}`);
    }
    let body: string;
    try {
      body = JSON.stringify(input ?? {});
    } catch {
      throw new ComputeClientError('INVALID_INPUT', 'Request input must be serializable JSON', 0);
    }
    const response = await fetcher(new URL(`${basePath}/${path}`, base.origin), {
      method: 'POST',
      headers,
      body,
      credentials,
      redirect: 'error',
      cache: 'no-store',
      signal: callOptions.signal,
    });
    const echoed = response.headers.get('x-request-id');
    const seenId = requestId ?? (echoed && requestIdPattern.test(echoed) ? echoed : undefined);
    const fail = (
      code: string,
      message: string,
      retryAfterMs?: number,
      details?: Record<string, unknown>,
    ): ComputeClientError => {
      const error = new ComputeClientError(code, message, response.status, retryAfterMs, seenId);
      if (details) error.details = details;
      if (code === 'UNAUTHENTICATED' && options.onUnauthenticated) {
        try {
          options.onUnauthenticated(error);
        } catch {
          /* A hook that throws never changes what the caller sees. */
        }
      }
      return error;
    };
    let envelope: unknown;
    try {
      envelope = await response.json();
    } catch {
      throw fail('INVALID_RESPONSE', 'The compute server returned an invalid response');
    }
    if (!isRecord(envelope))
      throw fail('INVALID_RESPONSE', 'The compute server returned an invalid response');
    if (Object.hasOwn(envelope, 'error')) {
      const error = envelope.error;
      if (isRecord(error) && typeof error.code === 'string' && typeof error.message === 'string') {
        const header = Number(response.headers.get('retry-after'));
        const retryAfterMs =
          typeof error.retryAfterMs === 'number'
            ? error.retryAfterMs
            : Number.isFinite(header) && header > 0
              ? header * 1000
              : undefined;
        throw fail(
          error.code,
          error.message,
          retryAfterMs,
          isRecord(error.details) ? error.details : undefined,
        );
      }
      throw fail('INVALID_RESPONSE', 'The compute server returned an invalid error response');
    }
    if (!response.ok) throw fail('HTTP_ERROR', 'The compute server rejected the request');
    if (!Object.hasOwn(envelope, 'data'))
      throw fail('INVALID_RESPONSE', 'The compute server returned an invalid response');
    return envelope.data as Output;
  };

  const request = async <Output>(
    path: string,
    input: unknown = {},
    callOptions: ComputeCallOptions = {},
  ): Promise<Output> => {
    try {
      return await attempt<Output>(path, input, callOptions);
    } catch (error) {
      if (
        error instanceof ComputeClientError &&
        error.code === 'RATE_LIMITED' &&
        retryWait > 0 &&
        error.retryAfterMs !== undefined &&
        error.retryAfterMs <= retryWait
      ) {
        await sleep(error.retryAfterMs, callOptions.signal);
        return attempt<Output>(path, input, callOptions);
      }
      throw error;
    }
  };

  /** `prefix.method(input?, options?)` for every plain segment. */
  const methods = new Map<string, object>();
  const group = (prefix: string): object => {
    let proxy = methods.get(prefix);
    if (!proxy) {
      proxy = new Proxy(Object.create(null) as object, {
        get(_target, method: string | symbol) {
          if (typeof method !== 'string' || !routeSegment(method)) return undefined;
          return (input?: unknown, callOptions?: ComputeCallOptions) =>
            request(`${prefix}/${method}`, input ?? {}, callOptions);
        },
      });
      methods.set(prefix, proxy);
    }
    return proxy;
  };
  /** `plugins[id][group][method]`. */
  const pluginGroups = new Map<string, object>();
  const plugins = new Proxy(Object.create(null) as object, {
    get(_target, id: string | symbol) {
      if (typeof id !== 'string' || !routeSegment(id)) return undefined;
      let proxy = pluginGroups.get(id);
      if (!proxy) {
        proxy = new Proxy(Object.create(null) as object, {
          get(_inner, name: string | symbol) {
            if (typeof name !== 'string' || !routeSegment(name)) return undefined;
            return group(`plugins/${id}/${name}`);
          },
        });
        pluginGroups.set(id, proxy);
      }
      return proxy;
    },
  });

  const transport: ClientTransport = { $request: request };
  return new Proxy(transport, {
    get(target, key: string | symbol) {
      if (key === Symbol.toStringTag) return 'BetterComputeClient';
      if (typeof key !== 'string' || reserved.has(key)) return undefined;
      if (key === '$request') return target.$request;
      if (key === 'plugins') return plugins;
      if (!routeSegment(key)) return undefined;
      return group(key);
    },
  }) as ComputeClient<T>;
}
