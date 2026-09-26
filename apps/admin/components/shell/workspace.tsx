'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
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

const WorkspaceContext = createContext<Workspace | null>(null);
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

  const window_ = useMemo(() => {
    const spec = RANGES[range];
    return { from: now - spec.ms, to: now, step: spec.step, points: spec.points };
  }, [now, range]);

  const value = useMemo<Workspace>(
    () => ({
      now,
      live,
      setLive,
      range,
      setRange,
      window: window_,
      siteId,
      setSiteId,
      density,
      setDensity,
      source,
      dataSource,
      setDataSource,
      wallNow,
      travelTo,
    }),
    [now, live, setLive, range, window_, siteId, density, wallNow, travelTo, source, dataSource],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): Workspace {
  const workspace = useContext(WorkspaceContext);
  if (!workspace) throw new Error('useWorkspace() outside <WorkspaceProvider>');
  return workspace;
}

/** The scope object the data generators take. */
export function useScope(): { siteId?: string } {
  const { siteId } = useWorkspace();
  return useMemo(() => (siteId ? { siteId } : {}), [siteId]);
}

/**
 * Derive data from the workspace clock: `useLive((now, scope) => fleetPulse(now, scope))`. Recomputed on each
 * tick and when the scope changes; pass `bucketMs` to recompute less often (heavy series).
 */
export function useLive<T>(
  derive: (now: number, scope: { siteId?: string }) => T,
  options: { bucketMs?: number; deps?: unknown[] } = {},
): T {
  const { now } = useWorkspace();
  const scope = useScope();
  const at = options.bucketMs ? Math.floor(now / options.bucketMs) * options.bucketMs : now;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const compute = useCallback(derive, options.deps ?? []);
  return useMemo(() => compute(at, scope), [compute, at, scope]);
}
