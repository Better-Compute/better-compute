/**
 * A minimal observable value: `subscribe` + `get` is exactly what React's `useSyncExternalStore`
 * (and Solid/Svelte/Vue adapters) need, so view models stay framework-free.
 */
export interface Store<S> {
  get(): S;
  subscribe(listener: () => void): () => void;
}

export interface WritableStore<S> extends Store<S> {
  set(next: S | ((current: S) => S)): void;
}

export function createStore<S>(initial: S): WritableStore<S> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(next) {
      const value = typeof next === 'function' ? (next as (current: S) => S)(state) : next;
      if (Object.is(value, state)) return;
      state = value;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
