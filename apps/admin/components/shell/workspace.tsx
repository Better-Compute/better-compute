'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { DAY, HOUR, MINUTE } from '@/lib/data/core';

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
  /** Where the data comes from. Only the simulation exists today; live mode arrives with the API adapter. */
  source: 'simulated' | 'live';
}

const WorkspaceContext = createContext<Workspace | null>(null);
const STORAGE_KEY = 'bc-admin:workspace';
const TICK_MS = 2_000;

function load(): Partial<{ range: RangeKey; siteId: string; density: Density; live: boolean }> {
  try {
    return JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}');
  } catch {
    return {};
  }
}

export function WorkspaceProvider({ initialNow, children }: { initialNow: number; children: ReactNode }) {
  const [now, setNow] = useState(initialNow);
  const [live, setLive] = useState(true);
  const [range, setRange] = useState<RangeKey>('24h');
  const [siteId, setSiteId] = useState<string | undefined>(undefined);
  const [density, setDensity] = useState<Density>('comfortable');
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const saved = load();
    if (saved.range && saved.range in RANGES) setRange(saved.range);
    if (saved.siteId) setSiteId(saved.siteId);
    if (saved.density) setDensity(saved.density);
    if (saved.live === false) setLive(false);
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ range, siteId, density, live }));
    } catch {
      // Private windows: preferences just don't persist.
    }
  }, [hydrated, range, siteId, density, live]);

  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, [live]);

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
      source: 'simulated',
    }),
    [now, live, range, window_, siteId, density],
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
