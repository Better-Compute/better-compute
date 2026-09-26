'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { fmtClock, fmtStamp } from '@/lib/data';
import { Led } from '@/components/ui/signal';
import { BrandMark } from './sidebar';
import { useAttentionItems } from './use-attention';
import { useNow, useWorkspaceSettings } from './workspace';

// Wall display: the panel on a NOC screen. No sidebar, top bar or status bar; a slim strip with the clock and
// what is failing; the Overview's dashboards rotate on their own. Entered with ?kiosk=1 or the palette,
// left with Escape (or the strip's exit button).

interface Kiosk {
  on: boolean;
  /** Seconds per dashboard; 0 = don't rotate. */
  rotateSeconds: number;
  enter(): void;
  exit(): void;
}

const KioskContext = createContext<Kiosk>({ on: false, rotateSeconds: 0, enter: () => {}, exit: () => {} });
export const KIOSK_EVENT = 'bc-admin:kiosk';

export function KioskProvider({ children }: { children: ReactNode }) {
  const [on, setOn] = useState(false);
  const [rotateSeconds, setRotate] = useState(45);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('kiosk') === '1') setOn(true);
    const rotate = Number(params.get('rotate'));
    if (Number.isFinite(rotate) && rotate >= 0) setRotate(rotate);
  }, []);

  const setUrl = (value: boolean) => {
    const url = new URL(window.location.href);
    if (value) url.searchParams.set('kiosk', '1');
    else url.searchParams.delete('kiosk');
    window.history.replaceState(window.history.state, '', url.href);
  };
  const enter = useCallback(() => {
    setOn(true);
    setUrl(true);
    document.documentElement.requestFullscreen?.().catch(() => {});
  }, []);
  const exit = useCallback(() => {
    setOn(false);
    setUrl(false);
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  }, []);

  useEffect(() => {
    const onEvent = () => enter();
    window.addEventListener(KIOSK_EVENT, onEvent);
    return () => window.removeEventListener(KIOSK_EVENT, onEvent);
  }, [enter]);
  useEffect(() => {
    if (!on) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') exit();
    };
    window.addEventListener('keydown', onKey);
    document.documentElement.dataset.kiosk = '1';
    return () => {
      window.removeEventListener('keydown', onKey);
      delete document.documentElement.dataset.kiosk;
    };
  }, [on, exit]);

  const value = useMemo(() => ({ on, rotateSeconds, enter, exit }), [on, rotateSeconds, enter, exit]);
  return <KioskContext.Provider value={value}>{children}</KioskContext.Provider>;
}

export function useKiosk(): Kiosk {
  return useContext(KioskContext);
}

/** The wall display's only chrome: brand, the moment, and how many things are failing. */
export function KioskStrip() {
  const { exit, rotateSeconds } = useKiosk();
  const { source, live } = useWorkspaceSettings();
  const now = useNow(1_000);
  const items = useAttentionItems();
  const critical = items.filter((i) => i.severity === 'critical').length;
  const warning = items.filter((i) => i.severity === 'warning').length;
  return (
    <header className="flex h-14 shrink-0 items-center gap-4 border-b border-separator-border bg-surface-sunken px-6">
      <BrandMark className="size-8" />
      <span className="font-mono text-[14px] font-medium tracking-wide text-text-primary uppercase">Better Compute</span>
      <span className="font-mono text-[12px] text-text-tertiary uppercase">{source === 'live' ? 'live api' : 'simulated'}</span>
      <span className="flex-1" />
      <span className={critical ? 'flex items-center gap-2 font-mono text-[16px] text-red-500' : 'flex items-center gap-2 font-mono text-[16px] text-text-secondary'}>
        <Led status={critical ? 'crit' : 'ok'} className="size-3" />
        {critical} critical
      </span>
      <span className={warning ? 'font-mono text-[16px] text-signal' : 'font-mono text-[16px] text-text-secondary'}>{warning} warning</span>
      <span className="font-mono text-[22px] text-text-primary tabular-nums" suppressHydrationWarning>
        {fmtClock(now)}
        <span className="ml-1 text-[12px] text-text-tertiary">UTC</span>
      </span>
      {!live && (
        <span className="font-mono text-[12px] text-signal" suppressHydrationWarning>
          viewing {fmtStamp(now)}
        </span>
      )}
      <button type="button" onClick={exit} className="font-mono text-[11px] text-text-tertiary hover:text-text-primary" title={`Rotates every ${rotateSeconds}s · Esc exits`}>
        exit wall display
      </button>
    </header>
  );
}
