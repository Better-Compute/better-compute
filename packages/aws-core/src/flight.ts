import { ComputeError, isComputeError } from '@better-compute/core';

// Work several callers share (a credential refresh, an identity check) must not live or die by the
// first caller's AbortSignal: when that caller gives up, the others, which are healthy, would be
// rejected with someone else's cancellation. A shared flight runs on its own signal and timeout,
// and each waiter leaves on its own signal only.

/** The caller's own cancellation: its ComputeError reason, or UNAVAILABLE `aborted`. */
function cancelled(signal: AbortSignal): ComputeError {
  const reason: unknown = signal.reason;
  if (isComputeError(reason)) return reason;
  return new ComputeError('UNAVAILABLE', 'the AWS request was cancelled', undefined, {
    provider: 'aws',
    reason: 'aborted',
  });
}

export interface SharedFlightOptions {
  /** How long one flight may take before every waiter gets UNAVAILABLE `timeout` (default 60 s). */
  timeoutMs?: number;
  /** What the flight does, for the timeout message (never a secret). */
  what?: string;
}

/** Joins the flight in progress, or starts one with `start`; resolves or rejects for this caller only. */
export type SharedFlight<T> = (
  start: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
) => Promise<T>;

/**
 * A single-flight whose work does not depend on any one caller. `start` receives the flight's own
 * signal: it aborts on the flight's timeout, or once every waiter has left. A waiter whose signal
 * aborts is rejected with its own cancellation; the others keep waiting for the result. After a
 * flight settles (or is abandoned), the next caller starts a new one.
 */
export function sharedFlight<T>(options: SharedFlightOptions = {}): SharedFlight<T> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const what = options.what ?? 'the shared AWS request';
  let flight: { promise: Promise<T>; controller: AbortController; waiters: number } | undefined;
  return (start, signal) => {
    if (signal.aborted) return Promise.reject(cancelled(signal));
    if (!flight) {
      const controller = new AbortController();
      const mine = { controller, waiters: 0, promise: undefined as unknown as Promise<T> };
      mine.promise = new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          const error = new ComputeError('UNAVAILABLE', `${what} timed out`, undefined, {
            provider: 'aws',
            reason: 'timeout',
          });
          // Rejected here too: work that ignores its signal must not hold its waiters.
          controller.abort(error);
          reject(error);
        }, timeoutMs);
        (timer as { unref?: () => void }).unref?.();
        let work: Promise<T>;
        try {
          work = start(controller.signal);
        } catch (error) {
          work = Promise.reject(error);
        }
        work.then(resolve, reject).finally(() => {
          clearTimeout(timer);
          if (flight === mine) flight = undefined;
        });
      });
      // A flight every waiter left settles with nobody listening.
      mine.promise.catch(() => undefined);
      flight = mine;
    }
    const joined = flight;
    joined.waiters += 1;
    return new Promise<T>((resolve, reject) => {
      let left = false;
      const leave = (): boolean => {
        if (left) return false;
        left = true;
        signal.removeEventListener('abort', onAbort);
        joined.waiters -= 1;
        return true;
      };
      const onAbort = (): void => {
        if (!leave()) return;
        // Nobody waits any more: the work is cancelled and the next caller starts afresh.
        if (joined.waiters === 0) {
          if (flight === joined) flight = undefined;
          joined.controller.abort();
        }
        reject(cancelled(signal));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      joined.promise.then(
        (value) => {
          if (leave()) resolve(value);
        },
        (error: unknown) => {
          if (leave()) reject(error);
        },
      );
    });
  };
}
