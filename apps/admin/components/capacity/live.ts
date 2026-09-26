'use client';

import { api } from '@/lib/api';
import { createLiveCapacitySource, type CapacitySnapshot, type CapacitySource, type CapacityTimeline } from '@/lib/data/capacity';

// Live mode for capacity: one CapacitySource over the admin's API proxy, a snapshot store refreshed every 15 s
// while some view reads it, and a timeline cache filled on demand (capacity.timeline answers at most 7 days per
// call, which the source chunks). Views subscribe with useSyncExternalStore through the hooks in data.tsx.

export interface LiveState {
  snapshot?: CapacitySnapshot;
  error?: string;
  loading: boolean;
  loadedAt?: number;
  tenantId?: string;
}

let state: LiveState = { loading: false };
let source: CapacitySource | undefined;
let sourceTenant: string | undefined;
let inflight: Promise<void> | undefined;
const timelines = new Map<string, { value?: CapacityTimeline; at: number; error?: string; pending?: boolean }>();
const listeners = new Set<() => void>();
let version = 0;

const emit = () => {
  version += 1;
  listeners.forEach((listener) => listener());
};
const set = (patch: Partial<LiveState>) => {
  state = { ...state, ...patch };
  emit();
};

export const liveSubscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
export const liveVersion = () => version;
export const liveState = () => state;

/** The live source for a tenant (recreated when the tenant changes). */
export function liveSource(tenantId: string): CapacitySource {
  if (!source || sourceTenant !== tenantId) {
    source = createLiveCapacitySource((path, body, options) => api.$request(path, body, options), { tenantId });
    sourceTenant = tenantId;
    timelines.clear();
    state = { loading: false, tenantId };
  }
  return source;
}

/**
 * Load (or reload) the snapshot; concurrent callers share one request. `fresh` (after a mutation) waits for any
 * load already in flight, which may have started before the change, and then loads again. An answer for a tenant
 * that is no longer current is dropped.
 */
export async function loadLive(tenantId: string, options: { fresh?: boolean } = {}): Promise<void> {
  if (options.fresh && inflight) await inflight;
  const current = liveSource(tenantId);
  inflight ??= (async () => {
    set({ loading: true });
    try {
      const snapshot = await current.load();
      if (sourceTenant !== tenantId) return;
      set({ snapshot, loading: false, error: undefined, loadedAt: Date.now(), tenantId });
    } catch (error) {
      if (sourceTenant !== tenantId) return;
      set({ loading: false, error: error instanceof Error ? error.message : String(error) });
    } finally {
      inflight = undefined;
    }
  })();
  return inflight;
}

/** After a mutation: reload the snapshot and forget cached timelines (bookings changed). */
export async function refreshLive(tenantId: string): Promise<void> {
  timelines.clear();
  await loadLive(tenantId, { fresh: true });
}

const TIMELINE_TTL = 60_000;

/**
 * A cached timeline (possibly stale), or undefined before the first answer. A miss or a stale entry starts one
 * fetch; its answer notifies the subscribers. Failed fetches are retried after the TTL.
 */
export function liveTimeline(tenantId: string, poolId: string, from: number, to: number, stepMinutes: number): CapacityTimeline | undefined {
  const key = `${tenantId}:${poolId}:${from}:${to}:${stepMinutes}`;
  const entry = timelines.get(key);
  const fresh = entry && Date.now() - entry.at < TIMELINE_TTL;
  if (!fresh && !entry?.pending) {
    timelines.set(key, { value: entry?.value, at: entry?.at ?? 0, pending: true });
    void liveSource(tenantId)
      .timeline(poolId, { from, to, stepMinutes })
      // A tenant switch cleared the cache meanwhile: drop the old tenant's answer.
      .then((value) => sourceTenant === tenantId && timelines.set(key, { value, at: Date.now() }))
      .catch((error: unknown) => sourceTenant === tenantId && timelines.set(key, { value: entry?.value, at: Date.now(), error: String(error) }))
      .finally(emit);
  }
  return entry?.value;
}

/** The last fetch error of a timeline with no value yet (so a view can say "couldn't load" instead of "loading"). */
export function liveTimelineError(tenantId: string, poolId: string, from: number, to: number, stepMinutes: number): string | undefined {
  const entry = timelines.get(`${tenantId}:${poolId}:${from}:${to}:${stepMinutes}`);
  return entry && !entry.value ? entry.error : undefined;
}

/** An empty snapshot for the moment before the first live load answers. */
export function emptySnapshot(now: number, tenantId = ''): CapacitySnapshot {
  return {
    now,
    tenantId,
    pools: [],
    summary: { pools: [], byGpuModel: {} },
    reservations: [],
    quotas: [],
    usage: [],
    flavors: [],
    offers: [],
    tenants: [],
    identities: [],
    sites: [],
    prices: {},
    nodesByPool: {},
    nodes: [],
    source: 'live',
  };
}
