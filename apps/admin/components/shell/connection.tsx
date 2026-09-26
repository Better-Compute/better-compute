'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { ConnectionStatus } from '@/lib/api';

// One shared probe of the compute API (every 30 s, and on demand): the status bar, Settings and any module that
// offers a live view read it from here.

const ConnectionContext = createContext<{ status: ConnectionStatus | null; refresh(): void }>({ status: null, refresh: () => {} });

export function ConnectionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const refresh = useCallback(() => {
    fetch('/api/upstream/status', { cache: 'no-store' })
      .then((response) => response.json() as Promise<ConnectionStatus>)
      .then((next) => setStatus({ ...next, checkedAt: Date.now() }))
      .catch((error: unknown) => setStatus({ configured: false, error: { code: 'NETWORK', message: String(error) }, checkedAt: Date.now() }));
  }, []);
  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 30_000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  return <ConnectionContext.Provider value={{ status, refresh }}>{children}</ConnectionContext.Provider>;
}

/** `{ status, refresh }`: status is null until the first probe answers. */
export function useConnection() {
  return useContext(ConnectionContext);
}

/** True when a compute API is configured and answering. */
export function useLiveAvailable(): boolean {
  const { status } = useConnection();
  return Boolean(status?.configured && status.ok);
}
