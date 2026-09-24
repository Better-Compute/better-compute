import { ComputeError } from './errors.js';

/**
 * Business time for TypeScript code (P9). Production uses the server's clock anchored to
 * `compute_now()`; tests pass `manualClock`. Never read `Date.now()` for business decisions.
 */
export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
}

/** The wall clock. Suitable for ids and logs, not for anything compared with database time. */
export const systemClock: Clock = { now: () => Date.now() };

/** A clock that moves only when told to: the simulator's time source. */
export interface ManualClock extends Clock {
  /** Moves time forward by `ms` and returns the new time. */
  advance(ms: number): number;
  /** Jumps to `ms`; time never moves backwards. */
  set(ms: number): void;
}

function checkTime(ms: number, name: string): void {
  if (!Number.isFinite(ms) || ms < 0)
    throw new ComputeError(
      'INVALID_INPUT',
      `${name} must be a non-negative number of milliseconds`,
    );
}

/** A manual clock starting at `start` (milliseconds since the epoch, default 0). */
export function manualClock(start = 0): ManualClock {
  checkTime(start, 'start');
  let current = start;
  return {
    now: () => current,
    advance(ms) {
      checkTime(ms, 'advance');
      current += ms;
      return current;
    },
    set(ms) {
      checkTime(ms, 'set');
      if (ms < current)
        throw new ComputeError('INVALID_INPUT', 'A manual clock never moves backwards');
      current = ms;
    },
  };
}
