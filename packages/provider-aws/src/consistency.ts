import type { Clock } from '@better-compute/core';

// EC2 reads are eventually consistent: a resource that was just made (by this process, by another
// replica, or by this deployment before a restart) can read NotFound by id for a while. Who made it
// is therefore never the only test of "may still be lagging": a miss is final only once the id has
// been missing for the whole consistency window as this process saw it, or is known to be gone.

/** How long a first miss, and a resource known to be gone, are remembered. */
export const goneMemoMs = 24 * 3_600_000;

/** One account's bookkeeping of by-id reads that missed (instances, volumes, snapshots, groups). */
export class ReadConsistency {
  /** id → when a by-id read first missed it (or when this client made it, if that is earlier). */
  readonly #missing = new Map<string, number>();
  /** id → when this process learned it is gone (deleted it, saw it deleted, or missed it for the window). */
  readonly #gone = new Map<string, number>();
  readonly #window: () => number;

  constructor(
    private readonly clock: Clock,
    windowMs: number | (() => number) = 120_000,
  ) {
    this.#window = typeof windowMs === 'function' ? windowMs : () => windowMs;
  }

  /** How long EC2 may not show what was just made or written. */
  get windowMs(): number {
    return this.#window();
  }

  /** Whether `at` (a time something was made or written) is inside the consistency window. */
  recent(at: number | undefined): boolean {
    return at !== undefined && this.clock.now() - at < this.windowMs;
  }

  /** A by-id read found `id`: a later miss starts a new window. */
  seen(id: string): void {
    this.#missing.delete(id);
  }

  /** `id` is known to be gone: a later by-id miss is final at once. */
  gone(id: string): void {
    const now = this.clock.now();
    for (const [key, at] of this.#gone) if (now - at >= goneMemoMs) this.#gone.delete(key);
    this.#gone.set(id, now);
    this.#missing.delete(id);
  }

  /**
   * Whether a by-id NotFound of `id` may still be eventual consistency rather than gone. `made` is
   * when this client made it, if it did and still remembers. True when made inside the window, or
   * first missed by this process less than the window ago (the first miss starts that window: the
   * resource may be another process's). Known gone, or missed for the whole window: false, and
   * remembered so.
   */
  mayLag(id: string, made?: number): boolean {
    const now = this.clock.now();
    const first = this.#missing.get(id);
    if (made !== undefined) {
      // The window of a resource made here starts when it was made, not at its first miss.
      if (first === undefined || made < first) this.#missing.set(id, made);
      if (now - made < this.windowMs) return true;
    }
    if (this.#gone.has(id)) return false;
    for (const [key, at] of this.#missing) if (now - at >= goneMemoMs) this.#missing.delete(key);
    const since = this.#missing.get(id);
    if (since === undefined) {
      this.#missing.set(id, now);
      return true;
    }
    if (now - since < this.windowMs) return true;
    this.gone(id);
    return false;
  }
}
