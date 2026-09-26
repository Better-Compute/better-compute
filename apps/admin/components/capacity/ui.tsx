'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { SegmentedControl, SegmentedControlItem } from '@/components/base/segmented-control/segmented-control';
import { Tag } from '@/components/ui/signal';
import { fmtStamp } from '@/lib/data/format';
import type { ReservationState } from '@/lib/data/capacity';
import { cx } from '@/utils/cx';
import { stateStyle } from './model';

// Small pieces the capacity pages share. Anything generally useful moves to components/ui via the shell's owner.

/** Next to mutation controls: why they won't act right now (useCapacityActions().readOnly). */
export function ReadOnlyHint({ reason }: { reason: 'past' | 'signed-out' | undefined }) {
  if (reason === 'past') return <Tag status="warn">viewing the past: read-only</Tag>;
  if (reason === 'signed-out')
    return (
      <Link href="/signin" className="font-mono text-[11px] text-text-secondary hover:text-text-primary hover:underline">
        read-only · <span className="text-signal">sign in</span> to change
      </Link>
    );
  return null;
}

/** A single-choice segmented toggle over string ids. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: T;
  onChange(value: NoInfer<T>): void;
  options: readonly { id: NoInfer<T>; label: ReactNode }[];
  label: string;
  className?: string;
}) {
  return (
    <SegmentedControl
      aria-label={label}
      selectedKeys={new Set([value])}
      onSelectionChange={(keys) => {
        const [first] = [...keys];
        if (first !== undefined) onChange(String(first) as T);
      }}
      className={cx('shrink-0', className)}
    >
      {options.map((option) => (
        <SegmentedControlItem key={option.id} id={option.id} className="px-2 py-0.5 font-mono text-[12px]">
          {option.label}
        </SegmentedControlItem>
      ))}
    </SegmentedControl>
  );
}

export function StateTag({ state, className }: { state: ReservationState; className?: string }) {
  const style = stateStyle[state];
  return (
    <Tag status={style.status === 'warn' ? 'warn' : style.status} className={className}>
      {style.label}
    </Tag>
  );
}

/** A floating readout for chart hovers, positioned inside a relative container. */
export function HoverCard({
  x,
  y,
  containerWidth,
  children,
  className,
}: {
  x: number;
  y: number;
  containerWidth: number;
  children: ReactNode;
  className?: string;
}) {
  const flip = x > containerWidth - 260;
  return (
    <div
      role="status"
      className={cx(
        'pointer-events-none absolute z-20 min-w-44 max-w-72 border border-separator-border bg-surface-raised px-2.5 py-2 shadow-dropdown',
        className,
      )}
      style={{ top: Math.max(0, y), ...(flip ? { right: containerWidth - x + 12 } : { left: x + 12 }) }}
    >
      {children}
    </div>
  );
}

/** One label/value line inside a HoverCard. */
export function HoverRow({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 text-caption-1-regular">
      <span className="text-text-secondary">{label}</span>
      <span className="font-mono tabular-nums text-text-primary">{value}</span>
    </div>
  );
}

/** The planner, prefilled with a pool, a window (start in ms, whole hours) and optionally the shape. */
export const planHref = (poolId: string, start?: number, end?: number, shape?: { gpus?: number; nodes?: number }) =>
  `/reservations/new?pool=${encodeURIComponent(poolId)}${start !== undefined ? `&start=${start}` : ''}${start !== undefined && end !== undefined ? `&hours=${Math.max(1, Math.round((end - start) / 3_600_000))}` : ''}${shape?.gpus ? `&gpus=${shape.gpus}` : ''}${shape?.nodes && shape.nodes > 1 ? `&nodes=${shape.nodes}` : ''}`;

export const utcDay = (t: number) => {
  const date = new Date(t);
  return `${date.toLocaleString('en', { month: 'short', timeZone: 'UTC' })} ${date.getUTCDate()}`;
};

export const windowLabel = (start: number, end: number) =>
  Math.floor(start / 86_400_000) === Math.floor((end - 1) / 86_400_000)
    ? `${fmtStamp(start)}–${new Date(end).toISOString().slice(11, 16)}`
    : `${fmtStamp(start)} → ${fmtStamp(end)}`;

/**
 * Tick marks for a time axis of `width` px over [from, to): day boundaries always, hours in between when there
 * is room. Returns x positions in px.
 */
export function timeTicks(from: number, to: number, width: number) {
  const span = to - from || 1;
  const pxPerHour = (width / span) * 3_600_000;
  const hourStep = pxPerHour > 60 ? 1 : pxPerHour > 24 ? 3 : pxPerHour > 10 ? 6 : pxPerHour > 4 ? 12 : 24;
  const ticks: { t: number; x: number; day: boolean; label: string }[] = [];
  const first = Math.ceil(from / 3_600_000) * 3_600_000;
  for (let t = first; t < to; t += 3_600_000) {
    const hour = new Date(t).getUTCHours();
    const day = hour === 0;
    if (!day && hour % hourStep !== 0) continue;
    if (day && hourStep === 24 && pxPerHour * 24 < 44 && new Date(t).getUTCDate() % 2 === 0) continue;
    ticks.push({ t, x: ((t - from) / span) * width, day, label: day ? utcDay(t) : `${String(hour).padStart(2, '0')}:00` });
  }
  return ticks;
}

/** The amber heat scale in 6 bins (one hue, light → dark), for ratios in [0, 1]. */
export const HEAT_BINS = [
  { max: 0.2, label: '<20%', alpha: 0.07 },
  { max: 0.4, label: '20–40', alpha: 0.2 },
  { max: 0.6, label: '40–60', alpha: 0.38 },
  { max: 0.8, label: '60–80', alpha: 0.58 },
  { max: 0.95, label: '80–95', alpha: 0.8 },
  { max: Infinity, label: 'full', alpha: 1 },
] as const;

export const heatAlpha = (ratio: number) => (HEAT_BINS.find((bin) => ratio < bin.max) ?? HEAT_BINS[5]).alpha;

export function HeatLegend({ className }: { className?: string }) {
  return (
    <div className={cx('flex items-center gap-2 font-mono text-[10px] text-text-tertiary', className)} role="img" aria-label="Share of GPUs booked: 6 bins from under 20% to full">
      <span>booked 0%</span>
      <span className="flex gap-px">
        {HEAT_BINS.map((bin) => (
          <span
            key={bin.label}
            title={bin.label}
            className="block h-2.5 w-6"
            style={{ background: `color-mix(in srgb, var(--color-signal-fill) ${bin.alpha * 100}%, var(--color-background-secondary-default))` }}
          />
        ))}
      </span>
      <span>full</span>
    </div>
  );
}

export const heatFill = (ratio: number) =>
  `color-mix(in srgb, var(--color-signal-fill) ${Math.round(heatAlpha(ratio) * 100)}%, var(--color-background-secondary-default))`;
