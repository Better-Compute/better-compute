import { createHash } from 'node:crypto';
import { ComputeError, type Clock } from '@better-compute/core';

// DigitalOcean allows 250 requests a minute and 5000 an hour per token, over sliding windows. The
// budget keeps this process under both, and keeps the cheap, deferrable traffic (sweeps and
// polls) from starving the calls that change something.

/** What a request is for: `mutate` changes something, `observe` polls one thing, `sweep` lists. */
export type BudgetClass = 'mutate' | 'observe' | 'sweep';

/**
 * The most of a window each class may spend. `mutate` may spend whatever is left, so the caps of
 * the other two (20% + 30%) keep at least half of every window free for it.
 */
export const budgetShares: Readonly<Record<BudgetClass, number>> = {
  sweep: 0.2,
  observe: 0.3,
  mutate: 1,
};

interface Spend {
  at: number;
  cls: BudgetClass;
}

interface Window {
  ms: number;
  capacity: number;
  spends: Spend[];
}

/** The share of a window that sweep and observe leave to mutate. */
const mutateReserve = 1 - budgetShares.sweep - budgetShares.observe;

/** How long a re-seed without a usable `ratelimit-reset` holds. */
const defaultSeedMs = 1000;

/** What the API last said was left of a token's hour (`RateBudget.reported`). `resetAt` is epoch ms. */
export interface ReportedRateLimit {
  limit: number;
  remaining: number;
  resetAt?: number;
}

export class RateBudget {
  readonly #clock: Clock;
  readonly #minute: Window;
  readonly #hour: Window;
  /** What the API last said was left this hour (of its own limit), until its `ratelimit-reset`. */
  #seeded: { remaining: number; limit: number; until: number } | undefined;
  /** What the API's answers last said, for a gauge: the lowest count of the newest window. */
  #reported: ReportedRateLimit | undefined;

  constructor(options: { perMinute: number; perHour: number; clock: Clock }) {
    this.#clock = options.clock;
    this.#minute = { ms: 60_000, capacity: options.perMinute, spends: [] };
    this.#hour = { ms: 3_600_000, capacity: options.perHour, spends: [] };
  }

  /** Throws RATE_LIMITED (retryAfterMs) when `cls` may not spend now. Shares: mutate >= 50%, observe 30%, sweep <= 20% of each window. */
  take(cls: BudgetClass): void {
    const now = this.#clock.now();
    let wait = 0;
    for (const window of [this.#minute, this.#hour]) {
      window.spends = window.spends.filter((spend) => spend.at + window.ms > now);
      // The window is full: it frees up when its oldest spend expires.
      if (window.spends.length >= window.capacity)
        wait = Math.max(wait, window.spends[0]!.at + window.ms - now);
      // The class has spent its share.
      const own = window.spends.filter((spend) => spend.cls === cls);
      const cap = Math.max(1, Math.floor(budgetShares[cls] * window.capacity));
      if (cls !== 'mutate' && own.length >= cap)
        wait = Math.max(wait, own[0]!.at + window.ms - now);
    }
    // The API's own count of this hour, when it is higher than ours. Nothing may spend what is
    // not left, and sweep and observe leave the mutate reserve alone.
    const seeded = this.#seeded;
    if (seeded && seeded.until > now) {
      const reserve = Math.ceil(seeded.limit * mutateReserve);
      if (seeded.remaining <= 0 || (cls !== 'mutate' && seeded.remaining < reserve))
        wait = Math.max(wait, seeded.until - now);
    }
    if (wait > 0)
      throw new ComputeError(
        'RATE_LIMITED',
        'DigitalOcean request budget spent; retry later',
        undefined,
        { provider: 'digitalocean', reason: 'budget', retryAfterMs: wait },
      );
    this.#minute.spends.push({ at: now, cls });
    this.#hour.spends.push({ at: now, cls });
  }

  /** Re-seeds from ratelimit-limit / ratelimit-remaining / ratelimit-reset (epoch seconds). */
  observe(headers: Pick<Headers, 'get'>): void {
    const rawRemaining = headers.get('ratelimit-remaining');
    const remaining = rawRemaining === null ? NaN : Number(rawRemaining);
    if (!Number.isFinite(remaining)) return;
    const now = this.#clock.now();
    const rawLimit = headers.get('ratelimit-limit');
    const reported = rawLimit === null || rawLimit === '' ? NaN : Number(rawLimit);
    const limit = Number.isFinite(reported) && reported > 0 ? reported : this.#hour.capacity;
    this.#report(limit, remaining, headers.get('ratelimit-reset'), now);
    // The count is shared by every process using the token, so it can only add to ours.
    if (limit - remaining <= this.#hour.spends.length) {
      this.#seeded = undefined;
      return;
    }
    const rawReset = headers.get('ratelimit-reset');
    const reset = rawReset === null || rawReset === '' ? NaN : Number(rawReset) * 1000;
    this.#seeded = {
      remaining,
      limit,
      until: Number.isFinite(reset) && reset > now ? reset : now + defaultSeedMs,
    };
  }

  /**
   * What the API last said was left of the token's hour, or undefined before any answer and once its reset has
   * passed. The count is the token's own (every process using it), so it is a gauge of the account, not of this
   * process. Answers to parallel requests arrive out of order: within one window the lowest count stands.
   */
  reported(): ReportedRateLimit | undefined {
    const reported = this.#reported;
    if (!reported) return undefined;
    if (reported.resetAt !== undefined && reported.resetAt <= this.#clock.now()) return undefined;
    return { ...reported };
  }

  #report(limit: number, remaining: number, rawReset: string | null, now: number): void {
    const reset = rawReset === null || rawReset === '' ? NaN : Number(rawReset) * 1000;
    const resetAt = Number.isFinite(reset) && reset > now ? reset : undefined;
    const kept = Math.max(0, Math.min(Math.floor(remaining), limit));
    const last = this.#reported;
    if (last && resetAt !== undefined && last.resetAt === resetAt && last.limit === limit) {
      last.remaining = Math.min(last.remaining, kept);
      return;
    }
    this.#reported = { limit, remaining: kept, ...(resetAt !== undefined ? { resetAt } : {}) };
  }
}

/** The key a token's budget is shared under, without keeping the token: sha256, 16 hex digits. */
export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

const budgets = new Map<string, RateBudget>();

/** Forgets every shared budget. For tests, which would otherwise carry spends from one test into the next. */
export function resetBudgets(): void {
  budgets.clear();
}

/** The process-wide budget of a token (keyed by `tokenHash`): every client of one token shares it. */
export function budgetFor(
  tokenHash: string,
  options: ConstructorParameters<typeof RateBudget>[0],
): RateBudget {
  let budget = budgets.get(tokenHash);
  if (!budget) {
    budget = new RateBudget(options);
    budgets.set(tokenHash, budget);
  }
  return budget;
}
