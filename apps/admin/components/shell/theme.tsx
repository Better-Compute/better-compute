'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { THEME_KEY } from '@/lib/theme-script';

// Dark or light, kept in localStorage 'theme'. The root layout's inline <head> script applies it before the
// first paint (server-rendered, so React never renders a <script> on the client); this provider keeps the
// class and the choice in sync afterwards. Replaces next-themes, whose provider renders its own script.

type Mode = 'dark' | 'light';

interface ThemeApi {
  theme: Mode | undefined;
  resolvedTheme: Mode | undefined;
  setTheme(mode: string): void;
}

const ThemeContext = createContext<ThemeApi>({ theme: undefined, resolvedTheme: undefined, setTheme: () => {} });

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Mode | undefined>(undefined);

  useEffect(() => {
    setThemeState(document.documentElement.classList.contains('dark') ? 'dark' : 'light');
    const onStorage = (event: StorageEvent) => {
      if (event.key === THEME_KEY && (event.newValue === 'dark' || event.newValue === 'light')) apply(event.newValue);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const apply = (mode: Mode) => {
    document.documentElement.classList.toggle('dark', mode === 'dark');
    document.documentElement.style.colorScheme = mode;
    setThemeState(mode);
  };

  const setTheme = useCallback((mode: string) => {
    const next: Mode = mode === 'light' ? 'light' : 'dark';
    try {
      window.localStorage.setItem(THEME_KEY, next);
    } catch {
      // The choice lasts for this page only.
    }
    apply(next);
  }, []);

  const value = useMemo(() => ({ theme, resolvedTheme: theme, setTheme }), [theme, setTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** Same shape as next-themes' useTheme (theme, resolvedTheme, setTheme). */
export function useTheme(): ThemeApi {
  return useContext(ThemeContext);
}
