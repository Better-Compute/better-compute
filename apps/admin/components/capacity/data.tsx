'use client';

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useClockGetter, useNow, useScope, useWallNow, useWorkspaceSettings } from '@/components/shell/workspace';
import { useFeedback } from '@/components/ui/feedback';
import {
  capacityAt,
  capacityTotalsFrom,
  sharedCapacitySource,
  type CapacityTotals,
  type TimelineLookup,
  DAY,
  HOUR,
  type CapacitySnapshot,
  type CapacitySource,
  type CapacityTimeline,
  type PlacementRequest,
  type SimCapacitySource,
} from '@/lib/data/capacity';
import { useConnection } from '@/components/shell/connection';
import { emptySnapshot, liveSource, liveState, liveSubscribe, liveTimeline, liveVersion, loadLive } from './live';
import { poolRows, type PoolRow } from './model';

// The capacity module's data hooks, in two modes behind one API:
// - simulated (default): the shared simulated source, driven by the workspace clock (pause and time travel
//   freeze or replay every capacity view), recomputed at most every 15 s of workspace time or after a mutation;
// - live (workspace.source === 'live'): the compute API through the admin's proxy (live.ts), refreshed every
//   15 s at the wall clock; time travel does not apply to live data.

/** The shared simulated source (lib/data/capacity.ts), with its clock set to `now`. */
export function capacitySource(now?: number): SimCapacitySource {
  if (now !== undefined) capacityAt(now);
  return sharedCapacitySource();
}

/** Which source the capacity views read, and for which tenant (live). */
function useMode() {
  const { source } = useWorkspaceSettings();
  const { status } = useConnection();
  const tenantId = status?.tenantId ?? undefined;
  return { live: source === 'live' && Boolean(tenantId), tenantId: tenantId ?? '' };
}

const useLiveStore = () => useSyncExternalStore(liveSubscribe, liveVersion, liveVersion);

/** Live mode's status for banners: loading, the last error, when data last arrived. */
export function useCapacityStatus(): { mode: 'simulated' | 'live'; loading: boolean; error?: string; loadedAt?: number } {
  const { live } = useMode();
  useLiveStore();
  const state = liveState();
  return live ? { mode: 'live', loading: state.loading, ...(state.error ? { error: state.error } : {}), ...(state.loadedAt ? { loadedAt: state.loadedAt } : {}) } : { mode: 'simulated', loading: false };
}

// A revision counter all capacity views subscribe to: mutations bump it and every view re-derives.
let revision = 0;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
function bump() {
  revision += 1;
  listeners.forEach((listener) => listener());
}
const useRevision = () => useSyncExternalStore(subscribe, () => revision, () => revision);

const BUCKET = 15_000;

const LIVE_REFRESH = 15_000;

/** The capacity snapshot: simulated at the workspace clock, or the latest live answer. */
export function useCapacity(): CapacitySnapshot {
  // Bucketed clocks: a capacity view re-renders when its 15 s bucket turns, not on every 2 s tick.
  const at = useNow(BUCKET);
  const wallNow = useWallNow(BUCKET);
  const { live, tenantId } = useMode();
  const rev = useRevision();
  useLiveStore();
  const simulated = useMemo(() => (live ? undefined : capacityAt(at)), [at, rev, live]);
  const empty = useMemo(() => emptySnapshot(wallNow, tenantId), [wallNow, tenantId]);
  useEffect(() => {
    if (!live) return;
    void loadLive(tenantId);
    const timer = window.setInterval(() => void loadLive(tenantId), LIVE_REFRESH);
    return () => window.clearInterval(timer);
  }, [live, tenantId]);
  if (!live) return simulated!;
  return liveState().snapshot ?? empty;
}

/** Pool rows in the workspace's site scope. */
export function usePoolRows(): { snapshot: CapacitySnapshot; rows: PoolRow[] } {
  const snapshot = useCapacity();
  const scope = useScope();
  const rows = useMemo(() => poolRows(snapshot, scope), [snapshot, scope]);
  return { snapshot, rows };
}

/** One pool's timeline for [from, to) (hourly unless `stepMinutes`), recomputed with the snapshot. */
export function useTimeline(poolId: string | undefined, from: number, to: number, stepMinutes = 60): CapacityTimeline | undefined {
  const map = useTimelines(poolId ? [poolId] : [], from, to, stepMinutes);
  return poolId ? map.get(poolId) : undefined;
}

/** Timelines of several pools over the same range (live: those loaded so far; the rest arrive and re-render). */
export function useTimelines(poolIds: readonly string[], from: number, to: number, stepMinutes = 60): Map<string, CapacityTimeline> {
  const snapshot = useCapacity();
  const { live, tenantId } = useMode();
  const liveVer = useLiveStore();
  const key = poolIds.join(',');
  return useMemo(
    () => {
      if (live) {
        const out = new Map<string, CapacityTimeline>();
        for (const poolId of poolIds) {
          const timeline = liveTimeline(tenantId, poolId, from, to, stepMinutes);
          if (timeline) out.set(poolId, timeline);
        }
        return out;
      }
      const source = capacitySource(snapshot.now);
      return new Map(poolIds.map((poolId) => [poolId, source.timelineSync(poolId, { from, to, stepMinutes })]));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, from, to, stepMinutes, snapshot, live, tenantId, live ? liveVer : 0],
  );
}

/**
 * A synchronous timeline lookup for pure derivations (insights): the simulation answers at once; live answers
 * what is cached and starts loading the rest (the component re-renders when it arrives).
 */
export function useTimelineLookup(): TimelineLookup {
  const snapshot = useCapacity();
  const { live, tenantId } = useMode();
  const liveVer = useLiveStore();
  return useMemo<TimelineLookup>(
    () =>
      live
        ? (poolId, range) => liveTimeline(tenantId, poolId, range.from, range.to, range.stepMinutes ?? 60)
        : (poolId, range) => capacitySource(snapshot.now).timelineSync(poolId, range),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [live, tenantId, snapshot, live ? liveVer : 0],
  );
}

/**
 * GPU totals as /capacity shows them, from whichever source the workspace reads (for the Overview and other
 * modules' KPIs, so they agree with the capacity pages in live mode too).
 */
export function useCapacityTotals(): CapacityTotals {
  const snapshot = useCapacity();
  const scope = useScope();
  return useMemo(() => capacityTotalsFrom(snapshot, scope), [snapshot, scope]);
}

/** A window around now, aligned to the hour so ticking doesn't reshuffle columns. */
export function useHourWindow(backHours: number, aheadHours: number) {
  const now = useNow(HOUR);
  const wallNow = useWallNow(HOUR);
  const { live } = useMode();
  // Live data is always "now": time travel replays only the simulation.
  const hour = live ? wallNow : now;
  return useMemo(() => ({ from: hour - backHours * HOUR, to: hour + aheadHours * HOUR, hour }), [hour, backHours, aheadHours]);
}

export type ActionState = { busy: boolean; error?: string; done?: string };

/**
 * Mutations with busy/error state. Destructive ones go through the shell's confirm dialog (with the exact API
 * call and an audit reason); every result is toasted; every success bumps the revision so all views update.
 * Nothing mutates while the workspace clock is in the past (time travel): the past is read-only.
 */
export function useCapacityActions() {
  const { live: clockLive, setLive } = useWorkspaceSettings();
  const clock = useClockGetter();
  const mode = useMode();
  // Live data ignores time travel, so it can always be changed; the simulation's past is read-only.
  const live = clockLive || mode.live;
  const { toast, confirmWithReason } = useFeedback();
  const [state, setState] = useState<ActionState>({ busy: false });
  const run = useCallback(
    async <T,>(label: string, action: (source: CapacitySource) => Promise<T>, quiet = false): Promise<T | undefined> => {
      if (!live) {
        const error = 'Viewing the past: return to live to change anything.';
        setState({ busy: false, error });
        toast({ title: 'Read-only while time-travelling', detail: error, status: 'warn', action: { label: 'Go live', onAction: () => setLive(true) } });
        return undefined;
      }
      setState({ busy: true });
      try {
        const result = await action(mode.live ? liveSource(mode.tenantId) : capacitySource(clock().now));
        if (mode.live) await loadLive(mode.tenantId);
        bump();
        setState({ busy: false, done: label });
        if (!quiet) toast({ title: label, status: 'ok' });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setState({ busy: false, error: message });
        toast({ title: 'That did not work', detail: message, status: 'crit' });
        return undefined;
      }
    },
    [clock, live, setLive, toast, mode.live, mode.tenantId],
  );
  const confirmed = useCallback(
    async (options: Parameters<typeof confirmWithReason>[0]) => (live ? (await confirmWithReason({ ...options, reason: { placeholder: 'Why (kept in the audit log)' } })) !== null : true),
    [confirmWithReason, live],
  );
  return {
    state,
    live,
    reset: () => setState({ busy: false }),
    release: async (id: string, gpus?: number) =>
      (await confirmed({
        title: `Release ${id} now?`,
        body: `Its bookings end at compute_now()${gpus ? ` and ${gpus} GPUs go back to the pool` : ''}; the workload loses its devices. Quota is refunded.`,
        confirmLabel: 'Release',
        danger: true,
        method: `reservations.release { reservationId: "${id}" }`,
      }))
        ? run(`Released ${id}`, (source) => source.release(id))
        : undefined,
    cancel: async (id: string) =>
      (await confirmed({
        title: `Cancel ${id}?`,
        body: 'It has not started: its bookings are released and its quota refunded.',
        confirmLabel: 'Cancel reservation',
        danger: true,
        method: `reservations.cancel { reservationId: "${id}" }`,
      }))
        ? run(`Cancelled ${id}`, (source) => source.cancel(id))
        : undefined,
    /** Many at once: one confirmation for the batch. */
    bulk: async (kind: 'release' | 'cancel', ids: string[]) => {
      if (!ids.length) return;
      const ok = await confirmed({
        title: `${kind === 'release' ? 'Release' : 'Cancel'} ${ids.length} reservation${ids.length === 1 ? '' : 's'}?`,
        body: ids.slice(0, 6).join(', ') + (ids.length > 6 ? ` and ${ids.length - 6} more` : ''),
        confirmLabel: kind === 'release' ? 'Release all' : 'Cancel all',
        danger: true,
        method: `reservations.${kind} × ${ids.length}`,
      });
      if (!ok) return;
      await run(`${kind === 'release' ? 'Released' : 'Cancelled'} ${ids.length} reservations`, async (source) => {
        for (const id of ids) await (kind === 'release' ? source.release(id) : source.cancel(id));
      });
    },
    extend: (id: string, byMs: number) => run(`Extended ${id} by ${Math.round(byMs / HOUR)} h`, (source) => source.extend(id, byMs)),
    /** Quiet: the caller toasts with the new reservation's id and state. */
    create: (request: PlacementRequest) => run('Reservation created', (source) => source.create(request), true),
    setQuota: async (row: { tenantId?: string; poolId: string; resource: string; max: number; current?: number }) =>
      (await confirmed({
        title: `Set ${row.resource} quota to ${row.max}?`,
        body: `${row.tenantId ?? 'tenant'} in ${row.poolId}${row.current !== undefined ? `: ${row.current} → ${row.max}` : ''}. Takes effect on the next admission; nothing running is evicted.`,
        confirmLabel: 'Set quota',
        danger: row.current !== undefined && row.max < row.current,
        method: `quotas.set { tenantId: "${row.tenantId}", poolId: "${row.poolId}", resource: "${row.resource}", max: ${row.max} }`,
      }))
        ? run(`Quota set: ${row.poolId} ${row.resource} = ${row.max}`, (source) => source.setQuota(row))
        : undefined,
  };
}

/** A read-only preview of a placement request (no booking). */
export function usePreview(request: PlacementRequest | undefined) {
  const snapshot = useCapacity();
  const mode = useMode();
  const [preview, setPreview] = useState<Awaited<ReturnType<CapacitySource['preview']>>>();
  const key = request ? JSON.stringify(request) : '';
  useEffect(() => {
    if (!request) {
      setPreview(undefined);
      return;
    }
    let current = true;
    const source = mode.live ? liveSource(mode.tenantId) : capacitySource(snapshot.now);
    void source
      .preview(request)
      .then((result) => current && setPreview(result))
      .catch((error: unknown) => current && setPreview({ fits: false, candidates: [], reason: error instanceof Error ? error.message : String(error) }));
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, snapshot]);
  return preview;
}

export { DAY, HOUR };

/** Tenant display name from the snapshot. */
export function useTenantName() {
  const snapshot = useCapacity();
  return useMemo(() => {
    const names = new Map(snapshot.tenants.map((tenant) => [tenant.id, tenant.name]));
    return (id: string) => names.get(id) ?? id;
  }, [snapshot]);
}
