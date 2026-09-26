// Server-side only: failure counters for sign-in, in memory (one admin process). better-iam sees every attempt
// as coming from this server's address, so its own per-IP limits can't tell operators apart; these can.

interface Window {
  failures: number;
  resetAt: number;
}

export class Throttle {
  private readonly windows = new Map<string, Window>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** True while `key` has used up its failures for the current window. */
  blocked(key: string, now = Date.now()): boolean {
    const window = this.windows.get(key);
    if (!window) return false;
    if (window.resetAt <= now) {
      this.windows.delete(key);
      return false;
    }
    return window.failures >= this.limit;
  }

  fail(key: string, now = Date.now()) {
    if (this.windows.size > 10_000) for (const [k, w] of this.windows) if (w.resetAt <= now) this.windows.delete(k);
    const window = this.windows.get(key);
    if (!window || window.resetAt <= now) this.windows.set(key, { failures: 1, resetAt: now + this.windowMs });
    else window.failures++;
  }

  clear(key: string) {
    this.windows.delete(key);
  }
}

/** Password attempts per organization + email: 10 failures, then wait out the 15 minutes. */
export const signInThrottle = new Throttle(10, 15 * 60_000);
/** Codes per MFA challenge: 5 wrong codes and the challenge is spent (it expires in 5 minutes anyway). */
export const challengeThrottle = new Throttle(5, 5 * 60_000);
/** Challenges that already signed someone in (hash → expiry): one use each. */
export const usedChallenges = new Map<string, number>();
