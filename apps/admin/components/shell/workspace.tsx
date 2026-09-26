'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { DAY, HOUR, MINUTE } from '@/lib/data/core';
import { useLiveAvailable } from './connection';

// The workspace: the controls in the top bar that every page and widget reads. One clock (live or paused),
// one time range, one site scope and the density preference. Modules never call Date.now(): they take `now`
// from here, so pausing freezes the whole panel and the server render matches the first client render.

export type RangeKey = '1h' | '6h' | '24h' | '7d' | '30d';
export type Density = 'comfortable' | 'compact';

export const RANGES: Record<RangeKey, { label: string; ms: number; step: number; points: number }> = {
  '1h': { label: 'Last hour', ms: HOUR, step: MINUTE, points: 60 },
  '6h': { label: 'Last 6 hours', ms: 6 * HOUR, step: 5 * MINUTE, points: 72 },
  '24h': { label: 'Last 24 hours', ms: DAY, step: 20 * MINUTE, points: 72 },
  '7d': { label: 'Last 7 days', ms: 7 * DAY, step: 2 * HOUR, points: 84 },
  '30d': { label: 'Last 30 days', ms: 30 * DAY, step: 8 * HOUR, points: 90 },
};

export interface Workspace {
  /** The workspace clock, ms since epoch. Ticks every `tickMs` while live. */
  now: number;
  live: boolean;
  setLive(live: boolean): void;
  range: RangeKey;
  setRange(range: RangeKey): void;
  /** The range's length, sample step and sample count, for series. */
  window: { from: number; to: number; step: number; points: number };
  /** Site scope; undefined = every site. */
  siteId: string | undefined;
  setSiteId(siteId: string | undefined): void;
  density: Density;
  setDensity(density: Density): void;
  /**
   * Where the data comes from: 'live' when the operator chose the API (`dataSource`) and it answers
   * (Settings → Connection); modules with a live source read the API through `api` in lib/api.ts, the rest
   * stay simulated. Time travel only replays the simulation.
   */
  source: 'simulated' | 'live';
  /** The operator's choice; `source` falls back to 'simulated' while the API is unavailable. */
  dataSource: 'simulated' | 'live';
  setDataSource(source: 'simulated' | 'live'): void;
  /** The wall clock (always ticking), for "how far behind live am I". */
  wallNow: number;
  /** Time travel: pause the whole panel at `t` (clamped to the past). `setLive(true)` returns to live. */
  travelTo(t: number): void;
}

const WorkspaceContext = createContext<Omit<Workspace, 'now' | 'wallNow' | 'window'> | null>(null);
const STORAGE_KEY = 'bc-admin:workspace';
const TICK_MS = 2_000;

function load(): Partial<{ range: RangeKey; siteId: string; density: Density; dataSource: 'simulated' | 'live' }> {
  try {
    return JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}');
  } catch {
    return {};
  }
}

export function WorkspaceProvider({ initialNow, children }: { initialNow: number; children: ReactNode }) {
  const [now, setNow] = useState(initialNow);
  const [wallNow, setWallNow] = useState(initialNow);
  const [live, setLiveState] = useState(true);
  const [range, setRange] = useState<RangeKey>('24h');
  const [siteId, setSiteId] = useState<string | undefined>(undefined);
  const [density, setDensity] = useState<Density>('comfortable');
  const [dataSource, setDataSource] = useState<'simulated' | 'live'>('simulated');
  const liveAvailable = useLiveAvailable();
  const source = dataSource === 'live' && liveAvailable ? 'live' : 'simulated';
  const [hydrated, setHydrated] = useState(false);

  // Saved preferences, then the URL (?site=fra1&range=7d&at=<ms>) wins: links reproduce a view, including a
  // moment in the past.
  useEffect(() => {
    const saved = load();
    const params = new URLSearchParams(window.location.search);
    const urlRange = params.get('range');
    const urlSite = params.get('site');
    const urlAt = Number(params.get('at'));
    const nextRange = urlRange && urlRange in RANGES ? (urlRange as RangeKey) : saved.range;
    if (nextRange && nextRange in RANGES) setRange(nextRange);
    if (urlSite || saved.siteId) setSiteId(urlSite === 'all' ? undefined : (urlSite ?? saved.siteId));
    if (saved.density) setDensity(saved.density);
    if (saved.dataSource === 'live') setDataSource('live');
    // Only a link pauses on load; a reload without ?at= is always live.
    if (Number.isFinite(urlAt) && urlAt > 0 && urlAt < Date.now()) {
      setLiveState(false);
      setNow(urlAt);
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ range, siteId, density, dataSource }));
    } catch {
      // Private windows: preferences just don't persist.
    }
  }, [hydrated, range, siteId, density, dataSource]);

  // Keep the URL shareable: scope, range and (when paused) the moment, without a navigation.
  useEffect(() => {
    if (!hydrated) return;
    const url = new URL(window.location.href);
    const set = (key: string, value: string | undefined) => (value ? url.searchParams.set(key, value) : url.searchParams.delete(key));
    set('site', siteId);
    set('range', range === '24h' ? undefined : range);
    set('at', live ? undefined : String(now));
    if (url.href !== window.location.href) window.history.replaceState(window.history.state, '', url.href);
  }, [hydrated, siteId, range, live, now]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setWallNow(Date.now());
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (live) setNow(wallNow);
  }, [live, wallNow]);

  const setLive = useCallback((next: boolean) => {
    setLiveState(next);
    if (next) {
      const t = Date.now();
      setWallNow(t);
      setNow(t);
    }
  }, []);

  const travelTo = useCallback((t: number) => {
    setLiveState(false);
    setNow(Math.min(Math.floor(t), Date.now()));
  }, []);

  useEffect(() => {
    document.documentElement.dataset.density = density;
  }, [density]);

  // The clock lives in a store, not in the settings context: a tick re-renders only components that read the
  // clock, and useLive/useNow with a bucket re-render only when their bucket changes.
  const [clock] = useState(() => createClockStore(initialNow));
  useEffect(() => clock.set(now, wallNow), [clock, now, wallNow]);

  const settings = useMemo<WorkspaceSettings>(
    () => ({ live, setLive, range, setRange, siteId, setSiteId, density, setDensity, source, dataSource, setDataSource, travelTo }),
    [live, setLive, range, siteId, density, travelTo, source, dataSource],
  );

  return (
    <ClockContext.Provider value={clock}>
      <WorkspaceContext.Provider value={settings}>{children}</WorkspaceContext.Provider>
    </ClockContext.Provider>
  );
}

type WorkspaceSettings = Omit<Workspace, 'now' | 'wallNow' | 'window'>;

interface ClockStore {
  get(): { now: number; wallNow: number };
  set(now: number, wallNow: number): void;
  subscribe(listener: () => void): () => void;
}

function createClockStore(initial: number): ClockStore {
  let snapshot = { now: initial, wallNow: initial };
  const listeners = new Set<() => void>();
  return {
    get: () => snapshot,
    set(now, wallNow) {
      if (now === snapshot.now && wallNow === snapshot.wallNow) return;
      snapshot = { now, wallNow };
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const ClockContext = createContext<ClockStore | null>(null);

function useClockStore(): ClockStore {
  const clock = useContext(ClockContext);
  if (!clock) throw new Error('workspace hooks outside <WorkspaceProvider>');
  return clock;
}

/** Everything but the clock: scope, range, density, source, and the setters. Never re-renders on a tick. */
export function useWorkspaceSettings(): WorkspaceSettings {
  const settings = useContext(WorkspaceContext);
  if (!settings) throw new Error('useWorkspaceSettings() outside <WorkspaceProvider>');
  return settings as WorkspaceSettings;
}

/** The workspace clock, floored to `bucketMs` (0 = every tick); re-renders only when that value changes. */
export function useNow(bucketMs = 0): number {
  const clock = useClockStore();
  const read = () => (bucketMs ? Math.floor(clock.get().now / bucketMs) * bucketMs : clock.get().now);
  return useSyncExternalStore(clock.subscribe, read, read);
}

/** Reads the clock on demand without subscribing: for event handlers (keyboard steps, callbacks). */
export function useClockGetter(): () => { now: number; wallNow: number } {
  return useClockStore().get;
}

/** The wall clock (always ticking), floored to `bucketMs`. */
export function useWallNow(bucketMs = 0): number {
  const clock = useClockStore();
  const read = () => (bucketMs ? Math.floor(clock.get().wallNow / bucketMs) * bucketMs : clock.get().wallNow);
  return useSyncExternalStore(clock.subscribe, read, read);
}

/**
 * Settings plus the clock (now, wallNow, the range window). Re-renders on every tick; prefer
 * useWorkspaceSettings + useNow(bucket) / useLive in anything heavy.
 */
export function useWorkspace(): Workspace {
  const settings = useWorkspaceSettings();
  const clock = useClockStore();
  const { now, wallNow } = useSyncExternalStore(clock.subscribe, clock.get, clock.get);
  const window_ = useMemo(() => {
    const spec = RANGES[settings.range];
    return { from: now - spec.ms, to: now, step: spec.step, points: spec.points };
  }, [now, settings.range]);
  return useMemo(() => ({ ...settings, now, wallNow, window: window_ }), [settings, now, wallNow, window_]);
}

/** The scope object the data generators take. */
export function useScope(): { siteId?: string } {
  const { siteId } = useWorkspaceSettings();
  return useMemo(() => (siteId ? { siteId } : {}), [siteId]);
}

/**
 * Derive data from the workspace clock: `useLive((now, scope) => fleetPulse(now, scope), { bucketMs: 10_000 })`.
 * The component re-renders only when the bucketed time or the scope changes (every tick without a bucket).
 */
export function useLive<T>(
  derive: (now: number, scope: { siteId?: string }) => T,
  options: { bucketMs?: number; deps?: unknown[] } = {},
): T {
  const at = useNow(options.bucketMs ?? 0);
  const scope = useScope();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const compute = useCallback(derive, options.deps ?? []);
  return useMemo(() => compute(at, scope), [compute, at, scope]);
}
