'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { RiArrowRightLine, RiEyeOffLine } from 'react-icons/ri';
import { useScope } from '@/components/shell/workspace';
import { EmptyState } from '@/components/ui/panel';
import { SeverityIcon } from '@/components/ui/signal';
import { capacityInsights, type CapacityInsight } from '@/lib/data/capacity';
import { cx } from '@/utils/cx';
import { useCapacity } from './data';

// Capacity insights as a list: what to know, why, and the one click that helps. Snoozing is per browser (for a
// shift, 8 hours) and only hides the item here; the condition itself stays until the data changes.

const SNOOZE_KEY = 'bc-admin:capacity-snoozed';
const SNOOZE_MS = 8 * 3_600_000;

function readSnoozed(): Record<string, number> {
  try {
    return JSON.parse(window.localStorage.getItem(SNOOZE_KEY) ?? '{}');
  } catch {
    return {};
  }
}

export function useInsights() {
  const snapshot = useCapacity();
  const scope = useScope();
  const all = useMemo(() => capacityInsights(snapshot.now, scope), [snapshot, scope]);
  const [snoozed, setSnoozed] = useState<Record<string, number>>({});
  useEffect(() => setSnoozed(readSnoozed()), []);
  const snooze = useCallback(
    (id: string) => {
      const next = { ...readSnoozed(), [id]: snapshot.now + SNOOZE_MS };
      try {
        window.localStorage.setItem(SNOOZE_KEY, JSON.stringify(next));
      } catch {
        // Private windows: the snooze lasts for this page only.
      }
      setSnoozed(next);
    },
    [snapshot.now],
  );
  const visible = useMemo(() => all.filter((insight) => !(snoozed[insight.id] && snoozed[insight.id]! > snapshot.now)), [all, snoozed, snapshot.now]);
  return { all, visible, snoozedCount: all.length - visible.length, snooze, unsnoozeAll: () => {
    try {
      window.localStorage.removeItem(SNOOZE_KEY);
    } catch {
      // ignore
    }
    setSnoozed({});
  } };
}

export function InsightRow({ insight, onSnooze, compact }: { insight: CapacityInsight; onSnooze?(): void; compact?: boolean }) {
  return (
    <li className="group flex gap-3 border-b border-separator-border px-3 py-2 last:border-0">
      <SeverityIcon severity={insight.severity} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <Link href={insight.href} className="block text-body-medium text-text-primary hover:underline">
          {insight.title}
        </Link>
        {!compact && <p className="mt-0.5 text-caption-1-regular text-text-secondary">{insight.detail}</p>}
        {insight.action && !compact && (
          <Link href={insight.action.href} className="mt-1 inline-flex items-center gap-1 font-mono text-[11px] text-signal hover:underline">
            {insight.action.label} <RiArrowRightLine className="size-3" aria-hidden />
          </Link>
        )}
      </div>
      {onSnooze && (
        <button
          type="button"
          onClick={onSnooze}
          title="Snooze for 8 hours (this browser)"
          aria-label={`Snooze: ${insight.title}`}
          className="grid size-7 shrink-0 place-items-center text-text-tertiary opacity-0 outline-none group-hover:opacity-100 hover:text-text-primary focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-border-focus-ring"
        >
          <RiEyeOffLine className="size-4" aria-hidden />
        </button>
      )}
    </li>
  );
}

export function InsightList({ limit, compact, className }: { limit?: number; compact?: boolean; className?: string }) {
  const { visible, snoozedCount, snooze, unsnoozeAll } = useInsights();
  const [expanded, setExpanded] = useState(false);
  if (!visible.length)
    return (
      <EmptyState title="Nothing needs you in capacity" className="py-6">
        {snoozedCount ? (
          <button type="button" className="font-mono text-[11px] text-signal hover:underline" onClick={unsnoozeAll}>
            show {snoozedCount} snoozed
          </button>
        ) : (
          'Pools have room, pending work has a window and quotas have headroom.'
        )}
      </EmptyState>
    );
  const shown = limit && !expanded ? visible.slice(0, limit) : visible;
  return (
    <div className={className}>
      <ul>
        {shown.map((insight) => (
          <InsightRow key={insight.id} insight={insight} compact={compact} onSnooze={() => snooze(insight.id)} />
        ))}
      </ul>
      {(visible.length > shown.length || expanded || snoozedCount > 0) && (
        <div className={cx('flex items-center gap-3 px-3 py-2 font-mono text-[11px]')}>
          {limit && visible.length > limit && (
            <button type="button" className="text-signal hover:underline" onClick={() => setExpanded((value) => !value)}>
              {expanded ? 'show fewer' : `show all ${visible.length}`}
            </button>
          )}
          {snoozedCount > 0 && (
            <button type="button" className="text-text-tertiary hover:text-text-primary" onClick={unsnoozeAll}>
              {snoozedCount} snoozed · show
            </button>
          )}
        </div>
      )}
    </div>
  );
}
