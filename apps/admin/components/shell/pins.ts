'use client';

import { useCallback, useSyncExternalStore } from 'react';

// Small persisted string sets shared across components (and tabs): pinned pages, acknowledged attention items.

function createLocalSet(key: string) {
  const event = `bc-admin:${key}-changed`;
  const empty: string[] = [];
  let cache: { raw: string | null; value: string[] } = { raw: null, value: empty };
  const read = (): string[] => {
    try {
      const raw = window.localStorage.getItem(`bc-admin:${key}`);
      if (raw !== cache.raw) cache = { raw, value: raw ? (JSON.parse(raw) as string[]) : empty };
      return cache.value;
    } catch {
      return empty;
    }
  };
  const write = (next: string[]) => {
    try {
      window.localStorage.setItem(`bc-admin:${key}`, JSON.stringify(next));
    } catch {
      // not persisted (private window)
    }
    window.dispatchEvent(new Event(event));
  };
  const subscribe = (callback: () => void) => {
    window.addEventListener(event, callback);
    window.addEventListener('storage', callback);
    return () => {
      window.removeEventListener(event, callback);
      window.removeEventListener('storage', callback);
    };
  };
  return function useLocalSet() {
    const values = useSyncExternalStore(subscribe, read, () => empty);
    const toggle = useCallback((value: string) => {
      const current = read();
      write(current.includes(value) ? current.filter((v) => v !== value) : [...current, value]);
    }, []);
    const add = useCallback((more: string[]) => write([...new Set([...read(), ...more])].slice(-500)), []);
    const remove = useCallback((less: string[]) => write(read().filter((v) => !less.includes(v))), []);
    return { values, toggle, add, remove, has: (value: string) => values.includes(value) };
  };
}

const usePinSet = createLocalSet('pins');
/** Pinned pages: the operator's own shortlist at the top of the sidebar. */
export function usePins() {
  const { values, toggle, has } = usePinSet();
  return { pins: values, toggle, isPinned: has };
}

/** Acknowledged attention items (by id), shared by the bell, the widget and the Attention page. */
export const useAcks = createLocalSet('acks');

/** Sidebar sections the operator folded away. */
export const useFoldedGroups = createLocalSet('nav-folded');

const VISITS_KEY = 'bc-admin:visits';

/** Remember a visited page (path + query), newest first, at most 12. */
export function recordVisit(href: string) {
  try {
    const visits = JSON.parse(window.localStorage.getItem(VISITS_KEY) ?? '[]') as string[];
    window.localStorage.setItem(VISITS_KEY, JSON.stringify([href, ...visits.filter((v) => v !== href)].slice(0, 12)));
  } catch {
    // Recent pages are a convenience.
  }
}

export function readVisits(): string[] {
  try {
    return JSON.parse(window.localStorage.getItem(VISITS_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
}
