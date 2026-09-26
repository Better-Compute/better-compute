'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { RiCloseLine, RiHistoryLine } from 'react-icons/ri';
import { activity, attention, capacityTotals, fleetPulse, fmtDuration, fmtNum, fmtPct, fmtStamp, HOUR, MINUTE } from '@/lib/data';
import { useScope, useWorkspace } from '@/components/shell/workspace';
import { SeverityIcon } from '@/components/ui/signal';
import { cx } from '@/utils/cx';

const KEY = 'bc-admin:last-seen';
/** Away for less than this is not "away". */
const MIN_AWAY = 30 * MINUTE;
/** Looking back further than a week is history, not a digest. */
const MAX_AWAY = 7 * 24 * HOUR;

/**
 * "Since you were away": what changed between the operator's last visit and now, in one strip — node health,
 * GPU use, critical items that opened, notable events — with a replay of that moment through time travel.
 */
export function SinceAway() {
  const { wallNow, travelTo } = useWorkspace();
  const scope = useScope();
  const [since, setSince] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState(false);

  // Read the last visit once, then keep stamping "seen" while the panel is open and live.
  useEffect(() => {
    try {
      const last = Number(window.localStorage.getItem(KEY));
      const away = Date.now() - last;
      if (last && away >= MIN_AWAY && away <= MAX_AWAY) setSince(last);
    } catch {
      // No memory of the last visit; no digest.
    }
  }, []);
  useEffect(() => {
    const stamp = () => {
      try {
        window.localStorage.setItem(KEY, String(Date.now()));
      } catch {
        // not persisted
      }
    };
    stamp();
    const timer = window.setInterval(stamp, MINUTE);
    window.addEventListener('beforeunload', stamp);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('beforeunload', stamp);
    };
  }, []);

  const digest = useMemo(() => {
    if (!since) return null;
    const now = Math.floor(wallNow / MINUTE) * MINUTE;
    const before = fleetPulse(since, scope);
    const after = fleetPulse(now, scope);
    const gpuBefore = capacityTotals(since, scope).gpus;
    const gpuAfter = capacityTotals(now, scope).gpus;
    const opened = attention(now, scope).filter((item) => item.at > since && item.severity !== 'info');
    const events = activity(now, 400, scope).filter((event) => event.at > since);
    return {
      now,
      away: now - since,
      offline: { before: before.nodes.offline, after: after.nodes.offline },
      ready: { before: before.nodes.ready, after: after.nodes.ready },
      util: { before: gpuBefore.utilization, after: gpuAfter.utilization },
      free: { before: gpuBefore.freeNow, after: gpuAfter.freeNow },
      opened,
      critical: events.filter((event) => event.severity === 'critical').slice(0, 3),
      events: events.length,
    };
    // Computed once per visit (not per tick): it describes the gap, not the present.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [since, scope]);

  if (!digest || dismissed) return null;

  const change = (before: number, after: number, format: (v: number) => string, worseWhenUp = false) => {
    const diff = after - before;
    return (
      <span className="font-mono tabular-nums">
        {format(before)} → <span className="text-text-primary">{format(after)}</span>
        {diff !== 0 && (
          <span className={cx('ml-1 text-[11px]', (worseWhenUp ? diff > 0 : diff < 0) ? 'text-signal' : 'text-text-tertiary')}>
            ({diff > 0 ? '+' : '−'}
            {format(Math.abs(diff))})
          </span>
        )}
      </span>
    );
  };

  return (
    <section aria-label="Since you were away" className="mb-4 border border-separator-border bg-surface-raised">
      <header className="flex items-center gap-2 border-b border-separator-border px-3 py-2">
        <RiHistoryLine className="size-4 text-signal" aria-hidden />
        <h2 className="font-mono text-[12px] font-medium tracking-wide text-text-secondary uppercase">Since you were away</h2>
        <span className="font-mono text-[11px] text-text-tertiary">
          {fmtDuration(digest.away)} · since {fmtStamp(since!)} UTC · {fmtNum(digest.events)}
          {digest.events >= 400 ? '+' : ''} events
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => travelTo(since!)}
            className="h-7 border border-separator-border px-2 font-mono text-[11px] text-text-secondary hover:border-signal-fill hover:text-signal"
            title="Time-travel the whole panel to your last visit"
          >
            replay that moment
          </button>
          <button type="button" onClick={() => setDismissed(true)} aria-label="Dismiss" className="grid size-7 place-items-center text-text-tertiary hover:text-text-primary">
            <RiCloseLine className="size-4" aria-hidden />
          </button>
        </div>
      </header>
      <div className="grid gap-x-6 gap-y-3 px-3 py-3 text-body-regular text-text-secondary sm:grid-cols-2 xl:grid-cols-4">
        <div>
          <div className="font-mono text-[10px] tracking-wide text-text-tertiary uppercase">Nodes ready</div>
          {change(digest.ready.before, digest.ready.after, (v) => fmtNum(v))}
          <div className="text-caption-1-regular text-text-tertiary">offline {change(digest.offline.before, digest.offline.after, (v) => fmtNum(v), true)}</div>
        </div>
        <div>
          <div className="font-mono text-[10px] tracking-wide text-text-tertiary uppercase">GPU utilization</div>
          {change(digest.util.before, digest.util.after, (v) => fmtPct(v, 0))}
          <div className="text-caption-1-regular text-text-tertiary">free {change(digest.free.before, digest.free.after, (v) => fmtNum(v))}</div>
        </div>
        <div className="min-w-0">
          <div className="font-mono text-[10px] tracking-wide text-text-tertiary uppercase">Opened while away</div>
          {digest.opened.length === 0 ? (
            <span className="text-caption-1-regular">nothing new needs you</span>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {digest.opened.slice(0, 3).map((item) => (
                <li key={item.id} className="flex min-w-0 items-center gap-1.5">
                  <SeverityIcon severity={item.severity} className="size-3.5" />
                  <Link href={item.href} className="truncate text-caption-1-regular text-text-primary hover:underline">
                    {item.title}
                  </Link>
                </li>
              ))}
              {digest.opened.length > 3 && (
                <Link href="/attention" className="font-mono text-[11px] text-signal hover:underline">
                  +{digest.opened.length - 3} more
                </Link>
              )}
            </ul>
          )}
        </div>
        <div className="min-w-0">
          <div className="font-mono text-[10px] tracking-wide text-text-tertiary uppercase">Critical events</div>
          {digest.critical.length === 0 ? (
            <span className="text-caption-1-regular">none</span>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {digest.critical.map((event) => (
                <li key={event.id} className="truncate text-caption-1-regular">
                  <span className="mr-1.5 font-mono text-[10px] text-text-tertiary">{fmtStamp(event.at).slice(-5)}</span>
                  <Link href={event.href ?? '/activity'} className="text-text-primary hover:underline">
                    {event.message}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
