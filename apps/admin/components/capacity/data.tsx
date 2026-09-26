'use client';

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useScope, useWorkspace } from '@/components/shell/workspace';
import { useFeedback } from '@/components/ui/feedback';
import {
  createSimCapacitySource,
  DAY,
  HOUR,
  type CapacitySnapshot,
  type CapacityTimeline,
  type PlacementRequest,
  type SimCapacitySource,
} from '@/lib/data/capacity';
import { poolRows, type PoolRow } from './model';

// The capacity module's data hooks. One simulated source per browser tab, driven by the workspace clock (so the
// top bar's pause freezes every capacity view), recomputed at most every 15 s of workspace time or after a
// mutation. A live source plugs in behind the same hooks once the shell's API adapter lands.

const clock = { now: 0 };
let sim: SimCapacitySource | undefined;

export function capacitySource(): SimCapacitySource {
  sim ??= createSimCapacitySource({ now: () => clock.now || Date.now() });
  return sim;
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

/** The capacity snapshot at the workspace clock. */
export function useCapacity(): CapacitySnapshot {
  const { now } = useWorkspace();
  const rev = useRevision();
  const at = Math.floor(now / BUCKET) * BUCKET;
  return useMemo(() => {
    clock.now = at;
    return capacitySource().snapshot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at, rev]);
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
  const snapshot = useCapacity();
  return useMemo(
    () => (poolId ? capacitySource().timelineSync(poolId, { from, to, stepMinutes }) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [poolId, from, to, stepMinutes, snapshot],
  );
}

/** Timelines of several pools over the same range. */
export function useTimelines(poolIds: readonly string[], from: number, to: number, stepMinutes = 60): Map<string, CapacityTimeline> {
  const snapshot = useCapacity();
  const key = poolIds.join(',');
  return useMemo(
    () => new Map(poolIds.map((poolId) => [poolId, capacitySource().timelineSync(poolId, { from, to, stepMinutes })])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, from, to, stepMinutes, snapshot],
  );
}

/** A window around now, aligned to the hour so ticking doesn't reshuffle columns. */
export function useHourWindow(backHours: number, aheadHours: number) {
  const { now } = useWorkspace();
  const hour = Math.floor(now / HOUR) * HOUR;
  return useMemo(() => ({ from: hour - backHours * HOUR, to: hour + aheadHours * HOUR, hour }), [hour, backHours, aheadHours]);
}

export type ActionState = { busy: boolean; error?: string; done?: string };

/**
 * Mutations with busy/error state. Destructive ones go through the shell's confirm dialog (with the exact API
 * call and an audit reason); every result is toasted; every success bumps the revision so all views update.
 * Nothing mutates while the workspace clock is in the past (time travel): the past is read-only.
 */
export function useCapacityActions() {
  const { now, live, setLive } = useWorkspace();
  const { toast, confirmWithReason } = useFeedback();
  const [state, setState] = useState<ActionState>({ busy: false });
  const run = useCallback(
    async <T,>(label: string, action: (source: SimCapacitySource) => Promise<T>, quiet = false): Promise<T | undefined> => {
      if (!live) {
        const error = 'Viewing the past: return to live to change anything.';
        setState({ busy: false, error });
        toast({ title: 'Read-only while time-travelling', detail: error, status: 'warn', action: { label: 'Go live', onAction: () => setLive(true) } });
        return undefined;
      }
      clock.now = now;
      setState({ busy: true });
      try {
        const result = await action(capacitySource());
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
    [now, live, setLive, toast],
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
  const [preview, setPreview] = useState<Awaited<ReturnType<SimCapacitySource['preview']>>>();
  const key = request ? JSON.stringify(request) : '';
  useEffect(() => {
    if (!request) {
      setPreview(undefined);
      return;
    }
    let current = true;
    clock.now = snapshot.now;
    void capacitySource()
      .preview(request)
      .then((result) => current && setPreview(result));
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
