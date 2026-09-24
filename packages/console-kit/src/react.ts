import type { Permissions, PermissionCheck } from './actions.js';
import type { Detail, DetailOutcome, DetailState } from './detail.js';
import type { ListResource } from './list.js';
import type { Store } from './store.js';

// React bindings without a React dependency: pass your app's React and get hooks over the
// console-kit stores. `useSyncExternalStore` is exactly what `Store` (`subscribe` + `get`) is
// shaped for, so the hooks are one line each and tear-free under concurrent rendering.
//
//   import * as React from 'react';
//   export const { useStore, useList, usePermission } = bindReact(React);

/** The React APIs the hooks use (React 18+ provides them). */
export interface ReactLike {
  useSyncExternalStore<T>(
    subscribe: (listener: () => void) => () => void,
    getSnapshot: () => T,
    getServerSnapshot?: () => T,
  ): T;
  useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  useState<T>(initial: T | (() => T)): [T, (value: T) => void];
}

export interface ConsoleHooks {
  /** The store's current value; re-renders when it changes. */
  useStore<S>(store: Store<S>): S;
  /** A list's state, loading it on first use. */
  useList<T>(list: ListResource<T>): ReturnType<ListResource<T>['get']>;
  /**
   * Whether the caller may do it: `undefined` while IAM answers (render disabled), then true or
   * false. A failed check stays `undefined`, never "denied".
   */
  usePermission(permissions: Permissions, check: PermissionCheck | undefined): boolean | undefined;
  /** A detail page's state, loading it on first use. */
  useDetail(detail: Detail): DetailState;
  /**
   * Runs one of a detail page's actions: `run(input)` resolves with the outcome; `pending` while
   * it runs; `outcome` (done or confirmation-required) or `error` afterwards.
   */
  useAction(
    detail: Detail,
    path: string,
  ): {
    run(input?: Record<string, unknown>): Promise<DetailOutcome | undefined>;
    pending: boolean;
    outcome?: DetailOutcome;
    error?: unknown;
  };
}

export function bindReact(react: ReactLike): ConsoleHooks {
  const useStore = <S>(store: Store<S>): S =>
    // The same snapshot on the server: SSR renders the store's current value.
    react.useSyncExternalStore(store.subscribe, store.get, store.get);
  return {
    useStore,
    useList(list) {
      const state = useStore(list);
      react.useEffect(() => {
        if (list.get().status === 'idle') void list.refresh();
      }, [list]);
      return state;
    },
    usePermission(permissions, check) {
      // Re-render when any answer arrives; the answer itself comes from peek.
      useStore(permissions);
      const cached = check ? permissions.peek(check) : undefined;
      const key = check ? `${check.action}|${check.resource.type}|${check.resource.id}` : '';
      react.useEffect(() => {
        if (check && permissions.peek(check) === undefined)
          void permissions.can(check).catch(() => undefined);
      }, [permissions, key]);
      return cached;
    },
    useDetail(detail) {
      const state = useStore(detail);
      react.useEffect(() => {
        if (detail.get().status === 'idle') void detail.refresh();
      }, [detail]);
      return state;
    },
    useAction(detail, path) {
      const [state, setState] = react.useState<{
        pending: boolean;
        outcome?: DetailOutcome;
        error?: unknown;
      }>({ pending: false });
      return {
        ...state,
        async run(input) {
          setState({ pending: true });
          try {
            const outcome = await detail.run(path, input);
            setState({ pending: false, outcome });
            return outcome;
          } catch (error) {
            setState({ pending: false, error });
            return undefined;
          }
        },
      };
    },
  };
}
