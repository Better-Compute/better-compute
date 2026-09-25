'use client';

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { createComputeClient } from 'better-compute/client';
import {
  createConsoleResources,
  createStore,
  watchEvents,
  type ComputeEventMessage,
  type ComputeRequester,
  type ConsoleResources,
  type WatchStatus,
  type WritableStore,
} from '@better-compute/console-kit';

// The console's client-side state: one compute client on this origin (the IAM cookie authenticates it), one set of
// console-kit stores for the signed-in tenant, and the live event stream keeping them current.

export interface ConsoleContextValue {
  api: ComputeRequester;
  tenantId: string;
  root: boolean;
  origin: string;
  resources: ConsoleResources;
  /** The event stream's state, for the "live" badge. */
  connection: WritableStore<WatchStatus>;
  listeners: Set<(event: ComputeEventMessage) => void>;
  /** Every event, for detail pages (`detail.applyEvent`); returns an unsubscribe. */
  onEvent(handler: (event: ComputeEventMessage) => void): () => void;
}

const ConsoleContext = createContext<ConsoleContextValue | null>(null);

export function useConsole(): ConsoleContextValue {
  const value = useContext(ConsoleContext);
  if (!value) throw new Error('useConsole() outside <ConsoleProvider>');
  return value;
}

/** Refreshes a detail page when an event about its item arrives. */
export function useDetailEvents(detail: { applyEvent(event: ComputeEventMessage): Promise<void> }) {
  const { onEvent } = useConsole();
  useEffect(() => onEvent((event) => void detail.applyEvent(event)), [onEvent, detail]);
}

/** "Live" while the event stream is open. */
export function LiveBadge() {
  const { connection } = useConsole();
  const status = useSyncExternalStore(connection.subscribe, connection.get, connection.get);
  return (
    <span className={status === 'open' ? 'ok' : 'muted'} title={`Event stream: ${status}`}>
      {status === 'open' ? '● live' : '○ polling'}
    </span>
  );
}

export function ConsoleProvider({
  tenantId,
  root,
  origin,
  children,
}: {
  tenantId: string;
  root: boolean;
  origin: string;
  children: ReactNode;
}) {
  const value = useMemo<ConsoleContextValue>(() => {
    const api = createComputeClient({
      baseURL: origin,
      credentials: 'same-origin',
      onUnauthenticated: () => {
        if (typeof window !== 'undefined')
          window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname)}`);
      },
    }) as unknown as ComputeRequester;
    const listeners = new Set<(event: ComputeEventMessage) => void>();
    return {
      api,
      tenantId,
      root,
      origin,
      resources: createConsoleResources(api, { tenantId }),
      connection: createStore<WatchStatus>('connecting'),
      listeners,
      onEvent(handler) {
        listeners.add(handler);
        return () => listeners.delete(handler);
      },
    };
  }, [tenantId, root, origin]);

  useEffect(() => {
    // Live updates: `/api/compute/watch` routes each event to the stores (and to open detail pages). While the
    // stream is down, the stores a page has loaded are refreshed every 20 s instead.
    let live: WatchStatus = 'connecting';
    const watcher = watchEvents({
      url: `${origin}/api/compute/watch`,
      headers: () => ({ 'x-better-compute': '1' }),
      onEvent(event) {
        void value.resources.applyEvent(event);
        for (const handler of value.listeners) handler(event);
      },
      onStatus(status) {
        live = status;
        value.connection.set(status);
      },
    });
    const timer = setInterval(() => {
      if (live === 'open' || document.visibilityState !== 'visible') return;
      const { nodes, pools, reservations, instances, capacity } = value.resources;
      for (const store of [nodes, pools, reservations, instances, capacity])
        if (store.get().status === 'ready') void store.refresh();
    }, 20_000);
    return () => {
      clearInterval(timer);
      watcher.stop();
    };
  }, [value, origin]);

  return <ConsoleContext.Provider value={value}>{children}</ConsoleContext.Provider>;
}
