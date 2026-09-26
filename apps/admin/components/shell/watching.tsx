'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef } from 'react';
import { RiEyeLine, RiEyeOffLine } from 'react-icons/ri';
import { watchFor, type WatchState } from '@/lib/modules';
import type { WidgetProps } from '@/lib/modules';
import { useFeedback } from '@/components/ui/feedback';
import { EmptyState } from '@/components/ui/panel';
import { Tag } from '@/components/ui/signal';
import { EntityLink } from './peek';
import { useWatched } from './pins';
import { useLive, useWorkspaceSettings } from './workspace';

// The watch list: entities the operator asked to keep an eye on (from a peek's Watch button), described by
// their module's `watch` function, with a toast when one changes state while the clock is live.

export interface Watched {
  key: string;
  kind: string;
  id: string;
  state: WatchState | null;
}

const split = (key: string) => {
  const at = key.indexOf(':');
  return { kind: key.slice(0, at), id: key.slice(at + 1) };
};

/** The watched entities with their state now (10 s buckets). */
export function useWatchedStates(): Watched[] {
  const { values } = useWatched();
  const { source } = useWorkspaceSettings();
  return useLive(
    (now) =>
      values.map((key) => {
        const { kind, id } = split(key);
        let state: WatchState | null = null;
        try {
          state = watchFor(kind)?.(id, now, { source }) ?? null;
        } catch {
          state = null;
        }
        return { key, kind, id, state };
      }),
    { bucketMs: 10_000, deps: [values, source] },
  );
}

/** A Watch / Unwatch toggle for an entity, when some module can describe that kind. */
export function WatchButton({ kind, id }: { kind: string; id: string }) {
  const watched = useWatched();
  if (!watchFor(kind)) return null;
  const key = `${kind}:${id}`;
  const on = watched.has(key);
  return (
    <button
      type="button"
      onClick={() => watched.toggle(key)}
      aria-pressed={on}
      className={
        on
          ? 'inline-flex h-8 items-center gap-1.5 border border-signal-fill/60 bg-signal-soft px-2 font-mono text-[11px] text-signal'
          : 'inline-flex h-8 items-center gap-1.5 border border-separator-border px-2 font-mono text-[11px] text-text-secondary hover:text-text-primary'
      }
    >
      {on ? <RiEyeLine className="size-3.5" aria-hidden /> : <RiEyeOffLine className="size-3.5" aria-hidden />}
      {on ? 'watching' : 'watch'}
    </button>
  );
}

/** Toasts when a watched entity changes status while live; the first reading is the baseline. */
export function WatchWatcher() {
  const router = useRouter();
  const { live } = useWorkspaceSettings();
  const { toast } = useFeedback();
  const states = useWatchedStates();
  const last = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    for (const { key, state } of states) {
      const signature = state ? state.status : 'gone';
      const before = last.current.get(key);
      last.current.set(key, signature);
      if (!live || before === undefined || before === signature) continue;
      toast({
        title: state ? `${state.label}: ${state.status === 'crit' ? 'failed' : state.status === 'warn' ? 'needs attention' : state.status}` : `${key} is gone`,
        detail: state?.summary,
        status: state?.status ?? 'off',
        timeout: 10_000,
        ...(state ? { action: { label: 'open', onAction: () => router.push(state.href) } } : {}),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [states]);
  return null;
}

/** The Watching widget: every watched entity with its state, most urgent first. */
export function WatchingWidget(_: WidgetProps) {
  const states = useWatchedStates();
  const watched = useWatched();
  const rank = { crit: 0, warn: 1, pending: 2, live: 3, ok: 4, off: 5 } as const;
  const sorted = useMemo(
    () => [...states].sort((a, b) => (a.state ? rank[a.state.status] : -1) - (b.state ? rank[b.state.status] : -1)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [states],
  );
  if (!sorted.length)
    return (
      <EmptyState icon={RiEyeLine} title="Nothing watched yet">
        Open any node, pool, reservation or site (click its id) and press Watch. It shows here, and you get a toast when it changes.
      </EmptyState>
    );
  return (
    <ul className="h-full overflow-y-auto">
      {sorted.map(({ key, kind, id, state }) => (
        <li key={key} className="group grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 border-b border-separator-border/70 px-3 py-2 last:border-0">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[10px] tracking-wide text-text-tertiary uppercase">{kind}</span>
              <EntityLink kind={kind} id={id} href={state?.href}>
                {state?.label ?? id}
              </EntityLink>
            </div>
            <div className="truncate text-caption-1-regular text-text-secondary">{state ? state.summary : 'no longer exists'}</div>
          </div>
          <Tag status={state?.status ?? 'off'}>{state ? (state.status === 'crit' ? 'failed' : state.status === 'warn' ? 'attention' : state.status) : 'gone'}</Tag>
          <button type="button" onClick={() => watched.remove([key])} aria-label={`Stop watching ${id}`} className="text-text-tertiary opacity-0 group-hover:opacity-100 hover:text-text-primary focus:opacity-100">
            <RiEyeOffLine className="size-4" aria-hidden />
          </button>
        </li>
      ))}
    </ul>
  );
}
