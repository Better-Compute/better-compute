'use client';

import { useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { cx } from '@/utils/cx';

// Hand-built SVG charts in the instrument style: hairline axes, mono tick labels, amber for the series that
// matters (booked, live), graphite for context, hatching for "not schedulable". No chart library: they stay
// small, theme through CSS variables and read the same in light and dark.

export type Tone = 'signal' | 'neutral' | 'muted' | 'crit';

export const toneColor: Record<Tone, string> = {
  signal: 'var(--color-signal-fill)',
  neutral: 'var(--color-text-secondary)',
  muted: 'var(--color-separator-border-strong)',
  crit: 'var(--color-red-500)',
};

/** Measures an element's width (for SVGs that fill their container). */
export function useWidth<T extends HTMLElement>(fallback = 320) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(40, Math.floor(entry.contentRect.width)));
    });
    observer.observe(element);
    setWidth(Math.max(40, Math.floor(element.getBoundingClientRect().width)));
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

function path(values: number[], width: number, height: number, max: number, min = 0) {
  const span = max - min || 1;
  const dx = values.length > 1 ? width / (values.length - 1) : 0;
  return values
    .map((value, i) => `${i ? 'L' : 'M'}${(i * dx).toFixed(1)},${(height - ((value - min) / span) * height).toFixed(1)}`)
    .join('');
}

/** A tiny trend line; the last point is marked. */
export function Sparkline({
  values,
  height = 28,
  tone = 'signal',
  area = true,
  max,
  min,
  className,
}: {
  values: number[];
  height?: number;
  tone?: Tone;
  area?: boolean;
  max?: number;
  min?: number;
  className?: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>(120);
  const gradient = useId();
  const hi = max ?? Math.max(...values, 0) * 1.08;
  const lo = min ?? Math.min(...values, 0);
  const line = values.length ? path(values, width, height - 2, hi, lo) : '';
  const last = values.at(-1) ?? 0;
  const lastY = height - 2 - ((last - lo) / (hi - lo || 1)) * (height - 2);
  return (
    <div ref={ref} className={cx('w-full', className)} style={{ height }}>
      <svg width={width} height={height} className="block overflow-visible" aria-hidden>
        <defs>
          <linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor={toneColor[tone]} stopOpacity="0.28" />
            <stop offset="1" stopColor={toneColor[tone]} stopOpacity="0" />
          </linearGradient>
        </defs>
        {area && line && <path d={`${line}L${width},${height}L0,${height}Z`} fill={`url(#${gradient})`} />}
        <path d={line} fill="none" stroke={toneColor[tone]} strokeWidth="1.5" strokeLinejoin="round" />
        {values.length > 0 && <circle cx={width} cy={lastY + 1} r="2.5" fill={toneColor[tone]} />}
      </svg>
    </div>
  );
}

export interface Part {
  label: string;
  value: number;
  /** 'signal' booked/live, 'neutral' context, 'muted' free, 'hatch' unschedulable, 'crit' failed. */
  tone: Tone | 'hatch';
}

/** One horizontal bar split into parts that add up to `total`. */
export function StackedBar({
  parts,
  total,
  height = 10,
  className,
  title,
}: {
  parts: Part[];
  total?: number;
  height?: number;
  className?: string;
  title?: string;
}) {
  const sum = total ?? parts.reduce((s, part) => s + part.value, 0);
  return (
    <div
      className={cx('flex w-full overflow-hidden bg-background-secondary-default', className)}
      style={{ height }}
      role="img"
      aria-label={title ?? parts.map((part) => `${part.label} ${part.value}`).join(', ')}
    >
      {parts.map((part) =>
        part.value > 0 ? (
          <span
            key={part.label}
            title={`${part.label}: ${part.value}`}
            className={cx('h-full shrink-0 transition-[width] duration-500 ease-out', part.tone === 'hatch' && 'hatch')}
            style={{
              width: `${(part.value / (sum || 1)) * 100}%`,
              background: part.tone === 'hatch' ? undefined : toneColor[part.tone],
            }}
          />
        ) : null,
      )}
    </div>
  );
}

/** A labelled usage meter: value of max, amber once past `warnAt`, red when full. */
export function Meter({
  value,
  max,
  warnAt = 0.8,
  label,
  detail,
  className,
  compact,
}: {
  value: number;
  max: number;
  warnAt?: number;
  label?: ReactNode;
  detail?: ReactNode;
  className?: string;
  compact?: boolean;
}) {
  const ratio = max > 0 ? Math.min(1, value / max) : 0;
  const tone: Tone = ratio >= 1 ? 'crit' : ratio >= warnAt ? 'signal' : 'neutral';
  return (
    <div className={cx('flex flex-col gap-1', className)}>
      {(label || detail) && (
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-caption-1-medium text-text-secondary">{label}</span>
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-text-tertiary">{detail}</span>
        </div>
      )}
      <div className={cx('w-full bg-background-secondary-default', compact ? 'h-1' : 'h-1.5')}>
        <div
          className="h-full transition-[width] duration-500 ease-out"
          style={{ width: `${ratio * 100}%`, background: toneColor[tone] }}
        />
      </div>
    </div>
  );
}

/** A ring gauge for one ratio; the center shows the value. */
export function Gauge({
  ratio,
  size = 84,
  label,
  tone,
  children,
}: {
  ratio: number;
  size?: number;
  label?: string;
  tone?: Tone;
  children?: ReactNode;
}) {
  const stroke = 6;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  // 270° sweep, open at the bottom like a dial.
  const sweep = 0.75;
  const color = toneColor[tone ?? (ratio >= 0.95 ? 'crit' : 'signal')];
  return (
    <div className="relative grid place-items-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-[225deg]" aria-hidden>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--color-background-secondary-default)"
          strokeWidth={stroke}
          strokeDasharray={`${c * sweep} ${c}`}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeDasharray={`${c * sweep * Math.min(1, Math.max(0, ratio))} ${c}`}
          className="transition-[stroke-dasharray] duration-700 ease-out"
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">
        <div>
          {children ?? <span className="font-mono text-[15px] font-medium tabular-nums">{Math.round(ratio * 100)}%</span>}
          {label && <div className="font-mono text-[10px] tracking-wide text-text-tertiary uppercase">{label}</div>}
        </div>
      </div>
    </div>
  );
}

export interface Series {
  id: string;
  label: string;
  values: number[];
  tone: Tone;
  area?: boolean;
  dashed?: boolean;
}

/**
 * A time-series chart with a y grid, UTC time ticks and a hover crosshair that reads every series at once.
 * `times` and each series' `values` are the same length.
 */
export function TimeSeriesChart({
  times,
  series,
  height = 180,
  yMax,
  yFormat = (v) => String(Math.round(v)),
  xFormat = (t) => new Date(t).toISOString().slice(11, 16),
  className,
  markers,
}: {
  times: number[];
  series: Series[];
  height?: number;
  yMax?: number;
  yFormat?: (value: number) => string;
  xFormat?: (t: number) => string;
  className?: string;
  /** Vertical rules (now, a deploy, an incident). */
  markers?: { t: number; label: string; tone?: Tone }[];
}) {
  const [ref, width] = useWidth<HTMLDivElement>(480);
  const [hover, setHover] = useState<number | null>(null);
  const gradientBase = useId();
  const padLeft = 40;
  const padBottom = 20;
  const padTop = 8;
  const w = Math.max(10, width - padLeft);
  const h = Math.max(10, height - padBottom - padTop);
  const max = useMemo(() => {
    const top = yMax ?? Math.max(...series.flatMap((s) => s.values), 0);
    if (yMax !== undefined) return yMax;
    const magnitude = 10 ** Math.floor(Math.log10(top || 1));
    return Math.ceil((top * 1.1) / magnitude) * magnitude || 1;
  }, [series, yMax]);
  const n = times.length;
  const x = (i: number) => padLeft + (n > 1 ? (i / (n - 1)) * w : 0);
  const y = (v: number) => padTop + h - (v / max) * h;
  const ticksY = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const tickEvery = Math.max(1, Math.round(n / Math.max(2, Math.floor(w / 90))));
  const t0 = times[0] ?? 0;
  const t1 = times[n - 1] ?? 1;
  const xOfTime = (t: number) => padLeft + ((t - t0) / (t1 - t0 || 1)) * w;

  return (
    <div
      ref={ref}
      className={cx('relative w-full select-none', className)}
      style={{ height }}
      onPointerMove={(event) => {
        const box = event.currentTarget.getBoundingClientRect();
        const px = event.clientX - box.left - padLeft;
        if (px < 0 || n < 2) return setHover(null);
        setHover(Math.max(0, Math.min(n - 1, Math.round((px / w) * (n - 1)))));
      }}
      onPointerLeave={() => setHover(null)}
    >
      <svg width={width} height={height} className="block" role="img" aria-label={series.map((s) => s.label).join(', ')}>
        <defs>
          {series.map((s) => (
            <linearGradient key={s.id} id={`${gradientBase}-${s.id}`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor={toneColor[s.tone]} stopOpacity="0.22" />
              <stop offset="1" stopColor={toneColor[s.tone]} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>
        {ticksY.map((v) => (
          <g key={v}>
            <line x1={padLeft} x2={padLeft + w} y1={y(v)} y2={y(v)} stroke="var(--color-separator-border)" strokeDasharray={v ? '2 3' : undefined} />
            <text x={padLeft - 6} y={y(v) + 3} textAnchor="end" className="fill-text-tertiary font-mono text-[10px]">
              {yFormat(v)}
            </text>
          </g>
        ))}
        {times.map((t, i) =>
          i % tickEvery === 0 && i < n - tickEvery / 2 ? (
            <text key={t} x={x(i)} y={height - 5} textAnchor="middle" className="fill-text-tertiary font-mono text-[10px]">
              {xFormat(t)}
            </text>
          ) : null,
        )}
        {markers?.map((marker) =>
          marker.t >= t0 && marker.t <= t1 ? (
            <g key={`${marker.t}-${marker.label}`}>
              <line x1={xOfTime(marker.t)} x2={xOfTime(marker.t)} y1={padTop} y2={padTop + h} stroke={toneColor[marker.tone ?? 'neutral']} strokeDasharray="3 3" />
              <text x={xOfTime(marker.t) + 4} y={padTop + 10} className="fill-text-tertiary font-mono text-[10px]">
                {marker.label}
              </text>
            </g>
          ) : null,
        )}
        {series.map((s) => {
          const d = s.values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
          return (
            <g key={s.id}>
              {s.area && d && <path d={`${d}L${x(n - 1)},${padTop + h}L${padLeft},${padTop + h}Z`} fill={`url(#${gradientBase}-${s.id})`} />}
              <path d={d} fill="none" stroke={toneColor[s.tone]} strokeWidth={1.5} strokeDasharray={s.dashed ? '4 3' : undefined} strokeLinejoin="round" />
            </g>
          );
        })}
        {hover !== null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={padTop} y2={padTop + h} stroke="var(--color-text-tertiary)" />
            {series.map((s) => (
              <circle key={s.id} cx={x(hover)} cy={y(s.values[hover] ?? 0)} r="3" fill="var(--color-surface-raised)" stroke={toneColor[s.tone]} strokeWidth="1.5" />
            ))}
          </g>
        )}
      </svg>
      {hover !== null && times[hover] !== undefined && (
        <div
          className="pointer-events-none absolute top-1 z-10 min-w-36 border border-separator-border bg-surface-raised px-2.5 py-2 shadow-dropdown"
          style={x(hover) > width / 2 ? { right: width - x(hover) + 10 } : { left: x(hover) + 10 }}
        >
          <div className="mb-1 font-mono text-[10px] text-text-tertiary">
            {new Date(times[hover]!).toISOString().replace('T', ' ').slice(0, 16)} UTC
          </div>
          {series.map((s) => (
            <div key={s.id} className="flex items-center justify-between gap-4 text-caption-1-regular">
              <span className="flex items-center gap-1.5 text-text-secondary">
                <span className="inline-block h-0.5 w-3" style={{ background: toneColor[s.tone] }} />
                {s.label}
              </span>
              <span className="font-mono tabular-nums text-text-primary">{yFormat(s.values[hover] ?? 0)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** A small legend row for charts. */
export function Legend({ items, className }: { items: { label: string; tone: Tone | 'hatch' }[]; className?: string }) {
  return (
    <div className={cx('flex flex-wrap items-center gap-x-3 gap-y-1', className)}>
      {items.map((item) => (
        <span key={item.label} className="inline-flex items-center gap-1.5 font-mono text-[11px] text-text-secondary">
          <span
            className={cx('inline-block size-2.5', item.tone === 'hatch' && 'hatch border border-separator-border')}
            style={item.tone === 'hatch' ? undefined : { background: toneColor[item.tone] }}
          />
          {item.label}
        </span>
      ))}
    </div>
  );
}
