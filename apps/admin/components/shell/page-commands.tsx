'use client';

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CommandDef } from '@/lib/modules';

// Page-scoped commands: a page registers the actions that make sense where the operator is ("Cordon n-fra1-…",
// "Export this table", "Cancel selected reservations"). They show first in ⌘K under "This page" while the page
// is mounted, then disappear. Modules' global commands stay in their descriptor.

interface Registry {
  commands: CommandDef[];
  register(owner: symbol, commands: CommandDef[]): void;
  unregister(owner: symbol): void;
}

const PageCommandsContext = createContext<Registry | null>(null);

export function PageCommandsProvider({ children }: { children: ReactNode }) {
  const [owners, setOwners] = useState<Map<symbol, CommandDef[]>>(new Map());
  const value = useMemo<Registry>(
    () => ({
      commands: [...owners.values()].flat(),
      register: (owner, commands) => setOwners((current) => new Map(current).set(owner, commands)),
      unregister: (owner) =>
        setOwners((current) => {
          const next = new Map(current);
          next.delete(owner);
          return next;
        }),
    }),
    [owners],
  );
  return <PageCommandsContext.Provider value={value}>{children}</PageCommandsContext.Provider>;
}

/**
 * `usePageCommands([{ id, label, group: 'This page', run }])` while a page (or a drawer) is mounted.
 * Pass a stable array (useMemo) or it re-registers every render.
 */
export function usePageCommands(commands: CommandDef[]) {
  const registry = useContext(PageCommandsContext);
  const owner = useRef(Symbol('page-commands'));
  useEffect(() => {
    if (!registry) return;
    const id = owner.current;
    registry.register(id, commands);
    return () => registry.unregister(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commands]);
}

export function useRegisteredPageCommands(): CommandDef[] {
  return useContext(PageCommandsContext)?.commands ?? [];
}
