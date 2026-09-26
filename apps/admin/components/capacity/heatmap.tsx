'use client';

import { memo, useMemo, useState } from 'react';
import { useWidth } from '@/components/ui/charts';
import { fmtNum, fmtPct, fmtStamp } from '@/lib/data/format';
import { cx } from '@/utils/cx';
import type { HeatMatrix } from './model';
import { heatFill, HoverCard, HoverRow, timeTicks } from './ui';

// Pools × hours, colored by the share of allocatable GPUs booked (one amber scale). Left of the "now" rule is
// history (what was booked), right of it the book of future reservations. A row click opens the pool; the
// cell under the pointer is read out with its exact numbers.

const LABEL_W = 148;
const SUMMARY_W = 64;
const HEADER_H = 26;

/**
 * The heatmap's table twin: per pool and UTC day, the peak share booked and the fewest GPUs free. Every value the
 * chart encodes in color is readable here as text.
 */
export function HeatmapTable({ matrix, now }: { matrix: HeatMatrix; now: number }) {
  const days = useMemo(() => {
    const list: number[] = [];
    for (let index = 0; index < matrix.columns; index += 1) {
      const day = Math.floor((matrix.from + index * matrix.step) / 86_400_000) * 86_400_000;
      if (list.at(-1) !== day) list.push(day);
    }
    return list;
  }, [matrix]);
  const today = Math.floor(now / 86_400_000) * 86_400_000;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-body-regular">
        <caption className="sr-only">Peak share of GPUs booked and fewest free GPUs, per pool and UTC day</caption>
        <thead>
          <tr className="border-b border-separator-border font-mono text-[11px] text-text-tertiary">
            <th className="px-2 py-1.5 text-left font-normal">Pool</th>
            {days.map((day) => (
              <th key={day} className={cx('px-2 py-1.5 text-right font-normal', day === today && 'text-text-primary')}>
                {new Date(day).toLocaleString('en', { month: 'short', day: 'numeric', timeZone: 'UTC' })}
                {day === today ? ' · today' : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {matrix.rows.map((entry) => (
            <tr key={entry.row.id} className="border-b border-separator-border last:border-0">
              <th scope="row" className="px-2 py-1.5 text-left font-mono text-[12px] font-normal whitespace-nowrap">
                {entry.row.short} · {entry.row.siteId}
              </th>
              {days.map((day) => {
                const buckets = entry.timeline.buckets.filter((bucket) => bucket.start >= day && bucket.start < day + 86_400_000);
                const peak = Math.max(0, ...buckets.map((bucket) => (entry.timeline.allocatable ? bucket.booked / entry.timeline.allocatable : 0)));
                const minFree = Math.min(...buckets.map((bucket) => bucket.free));
                return (
                  <td key={day} className="px-2 py-1.5 text-right font-mono text-[12px] tabular-nums whitespace-nowrap">
                    <span className={cx(peak >= 0.95 ? 'text-signal' : 'text-text-primary')}>{fmtPct(peak, 0)}</span>
                    <span className="text-text-tertiary"> · {Number.isFinite(minFree) ? fmtNum(minFree) : '—'} free</span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const CapacityHeatmap = memo(function CapacityHeatmap({
  matrix,
  now,
  rowHeight = 22,
  onSelect,
  onRange,
  compact,
}: {
  matrix: HeatMatrix;
  now: number;
  rowHeight?: number;
  onSelect?(poolId: string, t: number): void;
  /** Dragging across a row selects [start, end) of that pool (e.g. to plan a reservation there). */
  onRange?(poolId: string, start: number, end: number): void;
  /** Hide the right-hand summary column (small widgets). */
  compact?: boolean;
}) {
  const [ref, width] = useWidth<HTMLDivElement>(720);
  const [hover, setHover] = useState<{ row: number; col: number; x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<{ row: number; c0: number; c1: number } | null>(null);
  // Phones: short labels and no summary column, so the hours keep most of the width.
  compact = compact || width < 640;
  const summaryW = compact ? 0 : SUMMARY_W;
  const labelW = compact ? 104 : LABEL_W;
  const plotW = Math.max(40, width - labelW - summaryW);
  const cellW = plotW / Math.max(1, matrix.columns);
  const height = HEADER_H + matrix.rows.length * rowHeight + 4;
  const to = matrix.from + matrix.columns * matrix.step;
  const ticks = useMemo(() => timeTicks(matrix.from, to, plotW), [matrix.from, to, plotW]);
  const nowX = labelW + ((now - matrix.from) / (to - matrix.from)) * plotW;

  const cells = useMemo(
    () =>
      matrix.rows.map((entry, rowIndex) => (
        <g key={entry.row.id} transform={`translate(${labelW},${HEADER_H + rowIndex * rowHeight})`}>
          {entry.ratios.map((ratio, col) => (
            <rect
              key={col}
              x={col * cellW}
              y={1}
              width={Math.max(0.5, cellW - (cellW > 4 ? 1 : 0))}
              height={rowHeight - 2}
              fill={entry.timeline.allocatable > 0 ? heatFill(ratio) : 'var(--color-hatch)'}
            />
          ))}
        </g>
      )),
    [matrix, cellW, rowHeight, labelW],
  );

  const hovered = hover ? matrix.rows[hover.row] : undefined;
  const bucket = hovered && hover ? hovered.timeline.buckets[hover.col] : undefined;

  return (
    <div
      ref={ref}
      className="relative w-full select-none"
      style={{ height }}
      onPointerDown={(event) => {
        if (!hover || event.button !== 0) return;
        setDrag({ row: hover.row, c0: hover.col, c1: hover.col });
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // Synthetic or already-released pointers can't be captured; the drag still works inside the chart.
        }
      }}
      onPointerMove={(event) => {
        const box = event.currentTarget.getBoundingClientRect();
        const x = event.clientX - box.left;
        const y = event.clientY - box.top;
        const col = Math.floor((x - labelW) / cellW);
        const row = Math.floor((y - HEADER_H) / rowHeight);
        if (drag) {
          setDrag({ ...drag, c1: Math.max(0, Math.min(matrix.columns - 1, col)) });
          return setHover({ row: drag.row, col: Math.max(0, Math.min(matrix.columns - 1, col)), x, y });
        }
        if (col < 0 || col >= matrix.columns || row < 0 || row >= matrix.rows.length) return setHover(null);
        setHover({ row, col, x, y });
      }}
      onPointerUp={() => {
        if (!drag) return;
        const entry = matrix.rows[drag.row];
        const [a, b] = drag.c0 <= drag.c1 ? [drag.c0, drag.c1] : [drag.c1, drag.c0];
        setDrag(null);
        if (!entry) return;
        if (b > a && onRange) onRange(entry.row.id, matrix.from + a * matrix.step, matrix.from + (b + 1) * matrix.step);
        else onSelect?.(entry.row.id, matrix.from + a * matrix.step);
      }}
      onPointerCancel={() => setDrag(null)}
      onPointerLeave={() => !drag && setHover(null)}
    >
      <svg
        width={width}
        height={height}
        className={cx('block', onRange ? 'cursor-crosshair touch-none' : onSelect && 'cursor-pointer')}
        role="img"
        aria-label={`Share of GPUs booked per pool, hourly from ${fmtStamp(matrix.from)} to ${fmtStamp(to)} UTC`}
      >
        {ticks.map((tick) => (
          <g key={tick.t}>
            <line
              x1={labelW + tick.x}
              x2={labelW + tick.x}
              y1={tick.day ? 4 : HEADER_H - 6}
              y2={tick.day ? height : HEADER_H}
              stroke="var(--color-separator-border)"
            />
            {(tick.day || cellW * 6 > 40) && (
              <text x={labelW + tick.x + 3} y={tick.day ? 13 : HEADER_H - 8} className={cx('font-mono text-[10px]', tick.day ? 'fill-text-secondary' : 'fill-text-tertiary')}>
                {tick.label}
              </text>
            )}
          </g>
        ))}
        {matrix.rows.map((entry, rowIndex) => (
          <g key={entry.row.id}>
            <text
              x={0}
              y={HEADER_H + rowIndex * rowHeight + rowHeight / 2 + 4}
              className={cx('font-mono text-[11px]', hover?.row === rowIndex ? 'fill-text-primary' : 'fill-text-secondary')}
            >
              {compact ? entry.row.short : `${entry.row.short} · ${entry.row.siteId}`}
            </text>
            {!compact && (
              <text
                x={width - 2}
                y={HEADER_H + rowIndex * rowHeight + rowHeight / 2 + 4}
                textAnchor="end"
                className="fill-text-primary font-mono text-[11px] tabular-nums"
              >
                {fmtPct(entry.row.utilization, 0)}
              </text>
            )}
          </g>
        ))}
        {cells}
        {hover && (
          <g pointerEvents="none">
            <rect x={labelW} y={HEADER_H + hover.row * rowHeight} width={plotW} height={rowHeight} fill="none" stroke="var(--color-text-tertiary)" strokeWidth={1} />
            <rect x={labelW + hover.col * cellW - 0.5} y={HEADER_H} width={cellW} height={matrix.rows.length * rowHeight} fill="none" stroke="var(--color-text-tertiary)" strokeWidth={1} />
          </g>
        )}
        {drag && (
          <rect
            pointerEvents="none"
            x={labelW + Math.min(drag.c0, drag.c1) * cellW}
            y={HEADER_H + drag.row * rowHeight}
            width={(Math.abs(drag.c1 - drag.c0) + 1) * cellW}
            height={rowHeight}
            fill="var(--color-signal-soft)"
            stroke="var(--color-text-primary)"
            strokeWidth={1.5}
          />
        )}
        {nowX >= labelW && nowX <= labelW + plotW && (
          <g pointerEvents="none">
            <line x1={nowX} x2={nowX} y1={HEADER_H - 4} y2={height} stroke="var(--color-text-primary)" strokeWidth={1.5} />
            <rect x={nowX - 14} y={HEADER_H - 12} width={28} height={10} fill="var(--color-text-primary)" />
            <text x={nowX} y={HEADER_H - 4} textAnchor="middle" className="fill-background-full font-mono text-[8px] font-semibold">
              NOW
            </text>
          </g>
        )}
      </svg>
      {drag && (
        <HoverCard x={hover?.x ?? 0} y={(hover?.y ?? 0) + 12} containerWidth={width}>
          <div className="font-mono text-[12px] text-text-primary">{matrix.rows[drag.row]?.row.name}</div>
          <div className="font-mono text-[11px] text-text-secondary">
            {fmtStamp(matrix.from + Math.min(drag.c0, drag.c1) * matrix.step)} UTC · {Math.abs(drag.c1 - drag.c0) + 1} h
          </div>
          <div className="mt-1 font-mono text-[10px] text-text-tertiary">release to plan a reservation here</div>
        </HoverCard>
      )}
      {!drag && hover && hovered && bucket && (
        <HoverCard x={hover.x} y={hover.y + 12} containerWidth={width}>
          <div className="mb-1 flex items-baseline justify-between gap-3">
            <span className="font-mono text-[12px] text-text-primary">{hovered.row.name}</span>
            <span className="font-mono text-[10px] text-text-tertiary">{bucket.start > now ? 'booked ahead' : bucket.end <= now ? 'history' : 'now'}</span>
          </div>
          <div className="mb-1.5 font-mono text-[10px] text-text-tertiary">
            {fmtStamp(bucket.start)}–{new Date(bucket.end).toISOString().slice(11, 16)} UTC
          </div>
          <HoverRow label="Booked" value={`${fmtNum(bucket.booked)} / ${fmtNum(hovered.timeline.allocatable)}`} />
          <HoverRow label="Free" value={fmtNum(bucket.free)} />
          <HoverRow label="Share booked" value={fmtPct(hovered.ratios[hover.col] ?? 0, 0)} />
        </HoverCard>
      )}
    </div>
  );
});
