// The flag cache (PLAN.md §12.1, §12.5): one `features.isEnabled(tenantId, key)` per (tenant, key) on a
// miss, never one per admission. `feature:*` inbox events invalidate it; the TTL is only a backstop.

import { ComputeError, systemClock, type Clock } from '@better-compute/core';

export interface FlagCacheOptions {
  isEnabled(tenantId: string, key: string): Promise<boolean>;
  clock?: Clock;
  /** Default 5 minutes. */
  ttlMs?: number;
  /** The oldest entries go beyond this. Default 10 000. */
  maxEntries?: number;
}

export interface FlagCache {
  get(tenantId: string, key: string): Promise<boolean>;
  /** Drops every entry, or those of one tenant and/or one key. */
  invalidate(filter?: { tenantId?: string; key?: string }): void;
  readonly size: number;
  /** Lookups that went to IAM, since creation. */
  readonly misses: number;
}

interface Entry {
  tenantId: string;
  key: string;
  value: boolean;
  expiresAt: number;
}

export function createFlagCache(options: FlagCacheOptions): FlagCache {
  const clock = options.clock ?? systemClock;
  const ttlMs = options.ttlMs ?? 300_000;
  const maxEntries = options.maxEntries ?? 10_000;
  if (!(ttlMs > 0) || !Number.isInteger(maxEntries) || maxEntries < 1)
    throw new ComputeError('INVALID_CONFIG', 'Flag cache ttlMs and maxEntries must be positive');
  const entries = new Map<string, Entry>();
  const inflight = new Map<string, Promise<boolean>>();
  // Bumped by every invalidation, so a lookup that started before it cannot store a stale value.
  let generation = 0;
  let misses = 0;
  const cacheKey = (tenantId: string, key: string) => `${tenantId}\u0000${key}`;

  return {
    get size() {
      return entries.size;
    },
    get misses() {
      return misses;
    },
    async get(tenantId, key) {
      const id = cacheKey(tenantId, key);
      const entry = entries.get(id);
      if (entry && entry.expiresAt > clock.now()) return entry.value;
      const running = inflight.get(id);
      if (running) return running;
      const started = generation;
      misses++;
      let lookup: Promise<boolean> | undefined;
      lookup = (async () => {
        try {
          // Deferred, so even a synchronous throw settles after `lookup` is assigned.
          const value = await Promise.resolve().then(() => options.isEnabled(tenantId, key));
          if (generation === started) {
            entries.delete(id);
            entries.set(id, { tenantId, key, value, expiresAt: clock.now() + ttlMs });
            while (entries.size > maxEntries) entries.delete(entries.keys().next().value!);
          }
          return value;
        } finally {
          if (inflight.get(id) === lookup) inflight.delete(id);
        }
      })();
      inflight.set(id, lookup);
      return lookup;
    },
    invalidate(filter = {}) {
      generation++;
      // Lookups already running may predate the change: later callers start fresh ones.
      inflight.clear();
      if (filter.tenantId === undefined && filter.key === undefined) {
        entries.clear();
        return;
      }
      for (const [id, entry] of entries)
        if (
          (filter.tenantId === undefined || entry.tenantId === filter.tenantId) &&
          (filter.key === undefined || entry.key === filter.key)
        )
          entries.delete(id);
    },
  };
}
