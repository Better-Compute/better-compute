'use client';

import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { createComputeClient } from 'better-compute/client';
import {
  createConsoleResources,
  type ComputeRequester,
  type ConsoleResources,
} from '@better-compute/console-kit';

// The console's client-side state: one compute client on this origin (the IAM cookie authenticates it), one set of
// console-kit stores for the signed-in tenant, and the live event stream keeping them current.

export interface ConsoleContextValue {
  api: ComputeRequester;
  tenantId: string;
  root: boolean;
  origin: string;
  resources: ConsoleResources;
}

const ConsoleContext = createContext<ConsoleContextValue | null>(null);

export function useConsole(): ConsoleContextValue {
  const value = useContext(ConsoleContext);
  if (!value) throw new Error('useConsole() outside <ConsoleProvider>');
  return value;
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
    return { api, tenantId, root, origin, resources: createConsoleResources(api, { tenantId }) };
  }, [tenantId, root, origin]);

  useEffect(() => {
    // Until the events module's `/watch` is mounted here, refresh the stores a page has loaded every 20 s while
    // the tab is visible (console-kit's `watchEvents` + `applyEvent` replace this once it is).
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      const { nodes, pools, reservations, instances, capacity } = value.resources;
      for (const store of [nodes, pools, reservations, instances, capacity])
        if (store.get().status === 'ready') void store.refresh();
    }, 20_000);
    return () => clearInterval(timer);
  }, [value]);

  return <ConsoleContext.Provider value={value}>{children}</ConsoleContext.Provider>;
}
