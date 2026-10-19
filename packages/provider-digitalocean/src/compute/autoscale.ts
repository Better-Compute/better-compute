import type { DoClient } from '../client/http.js';
import { untilAborted } from './abort.js';
import type { DoAutoscaleMember, DoAutoscalePool } from './types.js';

// Which Droplets belong to a DO autoscale pool. DO scales those on its own, so discovery marks
// them and a claim refuses them (DO-D15). The pools and their members are two list calls per pool
// (`GET /droplets/autoscale`, then `/members` of each), so a claim reuses what it read for a
// minute; a discover pass always reads afresh and refreshes what claims reuse.

/** How long a claim goes by the membership it already holds. */
const membershipTtlMs = 60_000;
/** A load that no caller waits for any more still ends. */
const loadTimeoutMs = 60_000;

/** The pool each member Droplet belongs to: Droplet id to pool id. */
export type PoolMembers = ReadonlyMap<number, string>;

interface CacheEntry {
  loadedAt: number;
  members: Promise<PoolMembers>;
}

/** Per client, so a test (or a second account) never sees another's membership. */
const caches = new WeakMap<DoClient, CacheEntry>();

async function load(client: DoClient, signal: AbortSignal): Promise<PoolMembers> {
  const members = new Map<number, string>();
  const pools: DoAutoscalePool[] = [];
  for await (const pool of client.pages<DoAutoscalePool>('/droplets/autoscale', 'autoscale_pools', {
    signal,
    budget: 'sweep',
  }))
    pools.push(pool);
  for (const pool of pools)
    for await (const member of client.pages<DoAutoscaleMember>(
      `/droplets/autoscale/${encodeURIComponent(pool.id)}/members`,
      'droplets',
      { signal, budget: 'sweep' },
    ))
      members.set(member.droplet_id, pool.id);
  return members;
}

/**
 * The autoscale pool membership. With `fresh` it is read now; otherwise a read from the last
 * minute is reused. Concurrent callers share one load, which runs on its own signal: one
 * caller's abort cancels only that caller's wait. A failed load is dropped so the next call
 * retries.
 */
export function poolMembers(
  client: DoClient,
  signal: AbortSignal,
  options: { fresh?: boolean } = {},
): Promise<PoolMembers> {
  const now = client.clock.now();
  const cached = caches.get(client);
  if (!options.fresh && cached && now - cached.loadedAt < membershipTtlMs)
    return untilAborted(cached.members, signal);
  const entry: CacheEntry = {
    loadedAt: now,
    members: load(client, AbortSignal.timeout(loadTimeoutMs)),
  };
  caches.set(client, entry);
  entry.members.catch(() => {
    if (caches.get(client) === entry) caches.delete(client);
  });
  return untilAborted(entry.members, signal);
}
