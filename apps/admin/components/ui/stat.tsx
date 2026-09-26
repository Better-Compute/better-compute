import type { ReactNode } from 'react';
import { RiArrowDownSLine, RiArrowUpSLine } from 'react-icons/ri';
import { cx } from '@/utils/cx';
import { fmtDelta } from '@/lib/data/format';
import { Sparkline, type Tone } from './charts';

/**
 * A KPI readout: mono caption, big tabular value with its unit, an optional delta against the previous period
 * and a trend sparkline. `goodWhen` says which direction of the delta is good (it only changes the arrow's ink:
 * the instrument theme never paints good news green).
 */
export function Stat({
  label,
  value,
  unit,
  delta,
  goodWhen = 'up',
  trend,
  tone = 'signal',
  hint,
  className,
  size = 'md',
}: {
  label: ReactNode;
  value: ReactNode;
  unit?: ReactNode;
  /** Ratio change, e.g. 0.034 for +3.4%. */
  delta?: number;
  goodWhen?: 'up' | 'down';
  trend?: number[];
  tone?: Tone;
  hint?: ReactNode;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  const bad = delta !== undefined && delta !== 0 && (goodWhen === 'up' ? delta < 0 : delta > 0);
  return (
    <div className={cx('flex min-w-0 flex-col gap-1', className)}>
      <span className="truncate font-mono text-[11px] tracking-wide text-text-tertiary uppercase">{label}</span>
      <div className="flex items-baseline gap-1.5">
        <span
          className={cx(
            'font-mono font-medium tracking-tight text-text-primary tabular-nums',
            size === 'sm' && 'text-[18px] leading-6',
            size === 'md' && 'text-[24px] leading-8',
            size === 'lg' && 'text-[32px] leading-10',
          )}
        >
          {value}
        </span>
        {unit && <span className="font-mono text-[12px] text-text-tertiary">{unit}</span>}
        {delta !== undefined && (
          <span
            className={cx(
              'ml-auto inline-flex items-center font-mono text-[11px] tabular-nums',
              bad ? 'text-signal' : 'text-text-secondary',
            )}
          >
            {delta > 0 ? <RiArrowUpSLine className="size-3.5" aria-hidden /> : delta < 0 ? <RiArrowDownSLine className="size-3.5" aria-hidden /> : null}
            {fmtDelta(delta)}
          </span>
        )}
      </div>
      {trend && trend.length > 1 && <Sparkline values={trend} tone={tone} height={26} />}
      {hint && <span className="truncate text-caption-1-regular text-text-tertiary">{hint}</span>}
    </div>
  );
}
