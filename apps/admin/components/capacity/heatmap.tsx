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

export const CapacityHeatmap = memo(function CapacityHeatmap({
  matrix,
  now,
  rowHeight = 22,
  onSelect,
  compact,
}: {
  matrix: HeatMatrix;
  now: number;
  rowHeight?: number;
  onSelect?(poolId: string, t: number): void;
  /** Hide the right-hand summary column (small widgets). */
  compact?: boolean;
}) {
  const [ref, width] = useWidth<HTMLDivElement>(720);
  const [hover, setHover] = useState<{ row: number; col: number; x: number; y: number } | null>(null);
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
      onPointerMove={(event) => {
        const box = event.currentTarget.getBoundingClientRect();
        const x = event.clientX - box.left;
        const y = event.clientY - box.top;
        const col = Math.floor((x - labelW) / cellW);
        const row = Math.floor((y - HEADER_H) / rowHeight);
        if (col < 0 || col >= matrix.columns || row < 0 || row >= matrix.rows.length) return setHover(null);
        setHover({ row, col, x, y });
      }}
      onPointerLeave={() => setHover(null)}
      onClick={() => {
        if (hover && hovered && onSelect) onSelect(hovered.row.id, matrix.from + hover.col * matrix.step);
      }}
    >
      <svg
        width={width}
        height={height}
        className={cx('block', onSelect && 'cursor-pointer')}
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
      {hover && hovered && bucket && (
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
