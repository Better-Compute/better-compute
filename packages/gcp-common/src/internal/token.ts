import { ComputeError, type Clock } from '@better-compute/core';
import type { TokenSource } from '../auth.js';
import { detail, isRecord } from './rpc.js';

// The machinery under the token sources in auth.ts, kept out of the package's public surface
// (index.ts names its exports one by one and exports only the TokenContext type from here). A
// token is only ever returned to the caller; it is never logged, and never put in an error message.

export type TokenContext = Parameters<TokenSource['token']>[0];

/** A token with its expiry (epoch ms on the context clock). */
export interface Minted {
  token: string;
  expiresAt: number;
}

export const expiring = Symbol('bc.gcp.expiring');
/** A source that knows when its tokens expire (the ones this package builds). */
export interface ExpiringTokenSource extends TokenSource {
  [expiring](context: TokenContext): Promise<Minted>;
}

/** How long a token of unknown lifetime (a custom source) is trusted. */
export const unknownLifetimeMs = 300_000;

export function authError(
  message: string,
  status: number,
  reason: string,
  extra: Record<string, unknown> = {},
): ComputeError {
  return new ComputeError('UNAUTHENTICATED', message, undefined, {
    provider: 'gcp',
    status,
    reason,
    ...extra,
  });
}

/**
 * The reason (and activation link) of a failed token request's `error`: an OAuth error code
 * (`"invalid_grant"`), or a google.rpc.Status object (IAM Credentials), read the way mapGoogleError
 * reads it: ErrorInfo reason, then `error.status`.
 */
function failureOf(error: unknown): { reason: string; extra: Record<string, unknown> } {
  if (typeof error === 'string') return { reason: error, extra: {} };
  if (!isRecord(error)) return { reason: 'token_request_failed', extra: {} };
  const info = detail(error.details, 'ErrorInfo');
  const reason =
    (typeof info?.reason === 'string' ? info.reason : undefined) ??
    (typeof error.status === 'string' ? error.status : undefined) ??
    'token_request_failed';
  const metadata = info?.metadata;
  const extra: Record<string, unknown> = {};
  if (isRecord(metadata) && typeof metadata.activationUrl === 'string')
    extra.activationUrl = metadata.activationUrl;
  return { reason, extra };
}

/**
 * One token-endpoint request, returning the JSON body of a success. A refusal is UNAUTHENTICATED for
 * a 4xx and UNAVAILABLE for a 5xx (whatever the body says; the body only supplies `details.reason`),
 * an unreachable endpoint is UNAVAILABLE with reason `network`, and an abort rethrows the abort.
 */
export async function call(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new ComputeError('UNAVAILABLE', 'Google token endpoint unreachable', undefined, {
      provider: 'gcp',
      status: 0,
      reason: 'network',
    });
  }
  const text = await response.text();
  let payload: Record<string, unknown> = {};
  try {
    payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    // A non-JSON body is reported by status below.
  }
  if (response.ok) return payload;
  const { reason, extra } = failureOf(payload.error);
  if (response.status >= 500)
    throw new ComputeError(
      'UNAVAILABLE',
      `Google token endpoint answered ${response.status}`,
      undefined,
      { provider: 'gcp', status: response.status, reason, ...extra },
    );
  throw authError(
    `Google refused the token request (${response.status} ${reason})`,
    response.status,
    reason,
    extra,
  );
}

/** The expiry (epoch ms) of an OAuth-style reply: `now` plus `expires_in` seconds, else a default. */
export function lifetimeMs(payload: Record<string, unknown>, now: number): number {
  const seconds = Number(payload.expires_in);
  return now + (Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : unknownLifetimeMs);
}

/** One mint in progress, shared by every caller that asked while it ran. */
interface Flight {
  promise: Promise<Minted>;
  controller: AbortController;
  waiters: number;
}

/**
 * Wraps a minting function with a cache that refreshes `skewMs` before expiry (one flight at a
 * time). The flight runs under its own AbortController, not under any caller's signal: each caller
 * waits on the shared flight and stops waiting, with its own abort reason, when its own signal
 * aborts. The flight itself is aborted only when every caller has gone.
 */
export function cacheMinted(
  mint: (context: TokenContext) => Promise<Minted>,
  skewMs: number,
): ExpiringTokenSource {
  let current: Minted | undefined;
  let flight: Flight | undefined;

  const start = (context: TokenContext): Flight => {
    const controller = new AbortController();
    const started: Flight = {
      controller,
      waiters: 0,
      promise: mint({ ...context, signal: controller.signal })
        .then((minted) => (current = minted))
        .finally(() => {
          if (flight === started) flight = undefined;
        }),
    };
    return started;
  };

  const wait = (joined: Flight, signal: AbortSignal): Promise<Minted> => {
    joined.waiters++;
    return new Promise<Minted>((resolve, reject) => {
      let left = false;
      const leave = (): void => {
        if (left) return;
        left = true;
        signal.removeEventListener('abort', onAbort);
        joined.waiters--;
      };
      const onAbort = (): void => {
        leave();
        if (joined.waiters === 0) {
          // Nobody is waiting any more: stop the mint, and let the next caller start a new one.
          if (flight === joined) flight = undefined;
          joined.controller.abort(signal.reason);
        }
        reject(signal.reason);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      joined.promise.then(
        (minted) => {
          leave();
          resolve(minted);
        },
        (error: unknown) => {
          leave();
          reject(error);
        },
      );
    });
  };

  const fresh = async (context: TokenContext): Promise<Minted> => {
    if (current && context.clock.now() < current.expiresAt - skewMs) return current;
    context.signal.throwIfAborted();
    flight ??= start(context);
    return wait(flight, context.signal);
  };

  return {
    async token(context) {
      return (await fresh(context)).token;
    },
    [expiring]: fresh,
  };
}
