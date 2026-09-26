'use client';

import { useMemo } from 'react';
import { Button as AriaButton, Dialog, DialogTrigger, Popover } from 'react-aria-components';
import { RiHistoryLine, RiPauseFill, RiPlayFill, RiSkipForwardFill } from 'react-icons/ri';
import { attention, DAY, fmtClock, fmtDuration, fmtStamp, HOUR, MINUTE, pulseSeries } from '@/lib/data';
import { Led } from '@/components/ui/signal';
import { cx } from '@/utils/cx';
import { useScope, useWorkspace } from './workspace';

const SPAN = 7 * DAY;
const STEPS = [
  { label: '−1d', ms: -DAY },
  { label: '−1h', ms: -HOUR },
  { label: '−15m', ms: -15 * MINUTE },
  { label: '+15m', ms: 15 * MINUTE },
  { label: '+1h', ms: HOUR },
];

/**
 * The clock in the top bar, and time travel: every view derives from the workspace clock, so scrubbing it back
 * shows the whole panel as it was — for incident review, or to see what a pool looked like before a change.
 */
export function TimeMachine() {
  const { now, wallNow, live, setLive, travelTo } = useWorkspace();
  const scope = useScope();
  const start = Math.floor((wallNow - SPAN) / HOUR) * HOUR;
  const behind = wallNow - now;
  // Context for the scrubber: GPU utilization over the week, and when critical items opened.
  const hourBucket = Math.floor(wallNow / (10 * MINUTE));
  const context = useMemo(() => {
    const end = hourBucket * 10 * MINUTE;
    const series = pulseSeries(end, 84, 2 * HOUR, scope);
    const marks = new Map<string, number>();
    for (let t = end - SPAN; t <= end; t += 3 * HOUR)
      for (const item of attention(t, scope)) if (item.severity === 'critical' && item.at >= end - SPAN) marks.set(item.id, item.at);
    return { series, marks: [...marks.values()] };
  }, [hourBucket, scope]);

  const x = (t: number) => ((t - start) / (wallNow - start)) * 100;
  const points = context.series.map((p) => `${x(p.t).toFixed(2)},${(30 - p.gpuUtilization * 28).toFixed(2)}`).join(' ');
  const step = (ms: number) => {
    const target = now + ms;
    if (target >= wallNow - 30_000) setLive(true);
    else travelTo(Math.max(start, target));
  };

  return (
    <DialogTrigger>
      <AriaButton
        aria-label={live ? 'Clock: live. Open time travel' : `Clock: ${fmtDuration(behind)} in the past. Open time travel`}
        className={cx(
          'flex h-8 items-center gap-2 border px-2 font-mono text-[12px] tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring',
          live ? 'border-separator-border text-text-primary hover:border-separator-border-strong' : 'border-signal-fill/60 bg-signal-soft text-signal',
        )}
      >
        <Led status={live ? 'live' : 'pending'} />
        <span suppressHydrationWarning>{fmtClock(now)}</span>
        <span className="text-text-tertiary">UTC</span>
        {!live && <span className="hidden xl:inline">−{fmtDuration(behind).split(' ')[0]}</span>}
        <RiHistoryLine className="size-3.5 text-text-tertiary" aria-hidden />
      </AriaButton>
      <Popover placement="bottom end" offset={6} className="w-[520px] max-w-[calc(100vw-2rem)] border border-separator-border bg-surface-raised shadow-dropdown outline-none entering:animate-[pop-in_120ms_ease-out]">
        <Dialog aria-label="Time travel" className="outline-none">
          <div className="flex items-center gap-2 border-b border-separator-border px-3 py-2">
            <RiHistoryLine className="size-4 text-text-tertiary" aria-hidden />
            <span className="font-mono text-[11px] tracking-wide text-text-secondary uppercase">Time travel</span>
            <span className="ml-auto font-mono text-[11px] text-text-tertiary" suppressHydrationWarning>
              {live ? 'live' : `${fmtDuration(behind)} behind live`}
            </span>
          </div>
          <div className="px-3 pt-3 pb-2">
            <div className="mb-2 flex items-baseline justify-between">
              <span className="font-mono text-[18px] text-text-primary tabular-nums" suppressHydrationWarning>
                {fmtStamp(now)}:{new Date(now).toISOString().slice(17, 19)} <span className="text-[12px] text-text-tertiary">UTC</span>
              </span>
              <button
                type="button"
                onClick={() => (live ? travelTo(now) : setLive(true))}
                className={cx('inline-flex h-7 items-center gap-1.5 border px-2 font-mono text-[11px]', live ? 'border-separator-border text-text-secondary hover:text-text-primary' : 'border-signal-fill bg-signal-fill text-neutral-950')}
              >
                {live ? <RiPauseFill className="size-3.5" aria-hidden /> : <RiSkipForwardFill className="size-3.5" aria-hidden />}
                {live ? 'Pause here' : 'Return to live'}
              </button>
            </div>
            <div className="relative h-[34px] border border-separator-border bg-surface-sunken">
              <svg viewBox="0 0 100 32" preserveAspectRatio="none" className="absolute inset-0 h-full w-full" aria-hidden>
                <polyline points={points} fill="none" stroke="var(--color-signal-fill)" strokeWidth="0.6" vectorEffect="non-scaling-stroke" opacity="0.8" />
                {context.marks.map((t) => (
                  <line key={t} x1={x(t)} x2={x(t)} y1="22" y2="32" stroke="var(--color-red-500)" strokeWidth="1" vectorEffect="non-scaling-stroke" opacity="0.6" />
                ))}
                {Array.from({ length: 7 }, (_, i) => wallNow - (i + 1) * DAY).map((t) => (
                  <line key={t} x1={x(t)} x2={x(t)} y1="0" y2="32" stroke="var(--color-separator-border-strong)" strokeWidth="1" vectorEffect="non-scaling-stroke" strokeDasharray="2 2" />
                ))}
              </svg>
              <span aria-hidden className="pointer-events-none absolute inset-y-0 w-0.5 bg-text-primary" style={{ left: `calc(${x(now)}% - 1px)` }} />
              <input
                type="range"
                aria-label="Viewing time"
                min={start}
                max={wallNow}
                step={MINUTE}
                value={now}
                onChange={(event) => {
                  const t = Number(event.target.value);
                  if (t >= wallNow - MINUTE) setLive(true);
                  else travelTo(t);
                }}
                className="absolute inset-0 h-full w-full cursor-ew-resize opacity-0"
              />
            </div>
            <div className="mt-1 flex justify-between font-mono text-[10px] text-text-tertiary">
              <span>7 days ago</span>
              <span className="flex items-center gap-3">
                <span className="inline-flex items-center gap-1"><span className="inline-block h-px w-3 bg-signal-fill" />GPU util</span>
                <span className="inline-flex items-center gap-1"><span className="inline-block h-2.5 w-px bg-red-500" />critical opened</span>
              </span>
              <span>now</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1 border-t border-separator-border px-3 py-2">
            {STEPS.map((s) => (
              <button key={s.label} type="button" onClick={() => step(s.ms)} disabled={s.ms > 0 && live} className="h-7 border border-separator-border px-2 font-mono text-[11px] text-text-secondary hover:border-separator-border-strong hover:text-text-primary disabled:opacity-40">
                {s.label}
              </button>
            ))}
            <span className="ml-auto font-mono text-[10px] text-text-tertiary">
              <kbd>,</kbd> <kbd>.</kbd> ±5 min · shift ±1 h · <kbd>p</kbd> {live ? 'pause' : 'live'}
            </span>
          </div>
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}

/** Shown under the top bar while the panel is in the past. */
export function TimeTravelBanner() {
  const { live, now, wallNow, setLive } = useWorkspace();
  if (live) return null;
  return (
    <div role="status" className="flex h-8 shrink-0 items-center gap-3 border-b border-signal-fill/40 bg-signal-soft px-4 font-mono text-[12px] text-signal">
      <RiHistoryLine className="size-4" aria-hidden />
      <span className="truncate" suppressHydrationWarning>
        Viewing {fmtStamp(now)} UTC — {fmtDuration(wallNow - now)} ago. Every page shows the fleet as it was then.
      </span>
      <button type="button" onClick={() => setLive(true)} className="ml-auto inline-flex shrink-0 items-center gap-1 hover:underline">
        <RiPlayFill className="size-3.5" aria-hidden />
        return to live
      </button>
    </div>
  );
}
