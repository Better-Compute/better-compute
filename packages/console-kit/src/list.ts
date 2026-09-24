import { createStore, type Store } from './store.js';

// A paginated list as the server's list recipe returns it (`{ items, cursor? }`, PLAN.md §9.2):
// first page, "load more", refresh, and in-place item updates from the event stream, with stale
// responses dropped (a refresh supersedes loads in flight).

export interface Page<T> {
  items: T[];
  /** Present when more rows may follow. */
  cursor?: string;
}

export type ListStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface ListState<T> {
  items: readonly T[];
  status: ListStatus;
  /** A next page exists. */
  hasMore: boolean;
  /** The last load's error (the items shown stay the last good ones). */
  error?: unknown;
  /** Epoch ms of the last successful load. */
  loadedAt?: number;
}

export interface ListResource<T> extends Store<ListState<T>> {
  /** Loads the first page again (the first call loads it for the first time). */
  refresh(): Promise<void>;
  /** Appends the next page; a no-op without one or while loading. */
  loadMore(): Promise<void>;
  /** Inserts or replaces an item by key (e.g. from `get` after an event). */
  upsert(item: T): void;
  /** Removes an item by key. */
  remove(key: string): void;
  /** The item with this key, if loaded. */
  find(key: string): T | undefined;
}

export interface ListOptions<T> {
  load(cursor: string | undefined, signal: AbortSignal): Promise<Page<T>>;
  key(item: T): string;
  /** Where upserted items that were not loaded go (default `start`: newest first). */
  insert?: 'start' | 'end';
  now?: () => number;
}

export function createListResource<T>(options: ListOptions<T>): ListResource<T> {
  const store = createStore<ListState<T>>({ items: [], status: 'idle', hasMore: false });
  let cursor: string | undefined;
  let generation = 0;
  let inflight: AbortController | undefined;
  let loadingMore: Promise<void> | undefined;
  const now = options.now ?? Date.now;

  const run = async (append: boolean): Promise<void> => {
    const mine = ++generation;
    inflight?.abort();
    const controller = new AbortController();
    inflight = controller;
    store.set((state) => ({ ...state, status: 'loading' }));
    try {
      const page = await options.load(append ? cursor : undefined, controller.signal);
      if (mine !== generation) return;
      cursor = page.cursor;
      store.set((state) => {
        const items = append ? merge(state.items, page.items) : dedupe(page.items);
        return { items, status: 'ready', hasMore: page.cursor !== undefined, loadedAt: now() };
      });
    } catch (error) {
      if (mine !== generation) return;
      store.set((state) => ({ ...state, status: 'error', error }));
    }
  };

  const dedupe = (items: readonly T[]) => {
    const seen = new Set<string>();
    return items.filter((item) => {
      const key = options.key(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  const merge = (current: readonly T[], next: readonly T[]) => dedupe([...current, ...next]);

  return {
    get: store.get,
    subscribe: store.subscribe,
    refresh: () => {
      loadingMore = undefined;
      return run(false);
    },
    loadMore() {
      const state = store.get();
      if (!state.hasMore) return Promise.resolve();
      return (loadingMore ??= run(true).finally(() => (loadingMore = undefined)));
    },
    upsert(item) {
      const key = options.key(item);
      store.set((state) => {
        const index = state.items.findIndex((existing) => options.key(existing) === key);
        const items = [...state.items];
        if (index >= 0) items[index] = item;
        else if ((options.insert ?? 'start') === 'start') items.unshift(item);
        else items.push(item);
        return { ...state, items };
      });
    },
    remove(key) {
      store.set((state) =>
        state.items.some((item) => options.key(item) === key)
          ? { ...state, items: state.items.filter((item) => options.key(item) !== key) }
          : state,
      );
    },
    find: (key) => store.get().items.find((item) => options.key(item) === key),
  };
}

export type ValueStatus = ListStatus;

export interface ValueState<V> {
  value?: V;
  status: ValueStatus;
  error?: unknown;
  loadedAt?: number;
}

export interface ValueResource<V> extends Store<ValueState<V>> {
  refresh(): Promise<void>;
}

/** One value (a summary, a detail view) with the same refresh semantics as a list. */
export function createValueResource<V>(options: {
  load(signal: AbortSignal): Promise<V>;
  now?: () => number;
}): ValueResource<V> {
  const store = createStore<ValueState<V>>({ status: 'idle' });
  let generation = 0;
  let inflight: AbortController | undefined;
  const now = options.now ?? Date.now;
  return {
    get: store.get,
    subscribe: store.subscribe,
    async refresh() {
      const mine = ++generation;
      inflight?.abort();
      const controller = new AbortController();
      inflight = controller;
      store.set((state) => ({ ...state, status: 'loading' }));
      try {
        const value = await options.load(controller.signal);
        if (mine !== generation) return;
        store.set({ value, status: 'ready', loadedAt: now() });
      } catch (error) {
        if (mine !== generation) return;
        store.set((state) => ({ ...state, status: 'error', error }));
      }
    },
  };
}
