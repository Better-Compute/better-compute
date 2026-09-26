'use client';

import { memo, useMemo, useRef, useState } from 'react';
import { useWidth } from '@/components/ui/charts';
import { Led } from '@/components/ui/signal';
import { fmtDuration, fmtNum, fmtStamp } from '@/lib/data/format';
import { reservationGpus, type CapacityNode, type Reservation, type ReservationState } from '@/lib/data/capacity';
import { cx } from '@/utils/cx';
import { atomSpan, packLanes, stateStyle } from './model';
import { HoverCard, HoverRow, timeTicks } from './ui';

// The booking schedule of one pool. With atom data (the sim, or allocations joined in live mode) each row is a
// node and a bar's height is the GPUs it holds on that node, so the chart is an exact occupancy map; without
// it, bars are packed into lanes. Hovering a gang member rings every node of the gang.

const LABEL_W = 112;
const AXIS_H = 28;

type BarStyle = { fill: string; stroke?: string; opacity?: number; dash?: string };

export const barStyle: Record<ReservationState, BarStyle> = {
  active: { fill: 'var(--color-signal-fill)' },
  releasing: { fill: 'var(--color-signal-fill)', opacity: 0.7 },
  binding: { fill: 'var(--color-signal-fill)', opacity: 0.5, stroke: 'var(--color-signal-fill)' },
  placed: { fill: 'var(--color-signal-soft)', stroke: 'var(--color-signal-fill)' },
  pending: { fill: 'transparent', stroke: 'var(--color-signal-fill)', dash: '3 2' },
  'awaiting-confirmation': { fill: 'transparent', stroke: 'var(--color-signal-fill)', dash: '1 2' },
  released: { fill: 'var(--color-text-tertiary)', opacity: 0.32 },
  expired: { fill: 'var(--color-text-tertiary)', opacity: 0.22 },
  cancelled: { fill: 'var(--color-hatch)', stroke: 'var(--color-separator-border-strong)', dash: '2 2' },
  failed: { fill: 'color-mix(in srgb, var(--color-red-500) 18%, transparent)', stroke: 'var(--color-red-500)' },
  denied: { fill: 'transparent', stroke: 'var(--color-red-500)', dash: '2 2' },
  draft: { fill: 'transparent', stroke: 'var(--color-separator-border-strong)', dash: '2 2' },
};

export const GANTT_LEGEND: ReservationState[] = ['active', 'binding', 'placed', 'released', 'cancelled', 'failed'];

export function GanttLegend({ className }: { className?: string }) {
  return (
    <div className={cx('flex flex-wrap items-center gap-x-3 gap-y-1', className)}>
      {GANTT_LEGEND.map((state) => {
        const style = barStyle[state];
        return (
          <span key={state} className="inline-flex items-center gap-1.5 font-mono text-[11px] text-text-secondary">
            <svg width="16" height="10" aria-hidden>
              <rect x="0.5" y="0.5" width="15" height="9" fill={style.fill} fillOpacity={style.opacity ?? 1} stroke={style.stroke ?? 'none'} strokeDasharray={style.dash} />
            </svg>
            {stateStyle[state].label}
          </span>
        );
      })}
    </div>
  );
}

interface Bar {
  reservation: Reservation;
  row: number;
  y0: number;
  y1: number;
  x0: number;
  x1: number;
}

export const ReservationGantt = memo(function ReservationGantt({
  reservations,
  nodes,
  from,
  to,
  now,
  selectedId,
  onSelect,
  tenantName,
  maxHeight = 520,
  gpusPerNode = 8,
}: {
  reservations: readonly Reservation[];
  nodes?: readonly CapacityNode[];
  from: number;
  to: number;
  now: number;
  selectedId?: string;
  onSelect?(reservation: Reservation): void;
  tenantName(id: string): string;
  maxHeight?: number;
  gpusPerNode?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>(800);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ bar: Bar; x: number; y: number } | null>(null);
  const plotW = Math.max(40, width - LABEL_W);
  const xOf = (t: number) => LABEL_W + ((Math.min(Math.max(t, from), to) - from) / (to - from)) * plotW;
  const byNode = Boolean(nodes && nodes.length && reservations.some((reservation) => reservation.atoms?.length));
  const gpuPx = gpusPerNode > 4 ? 3 : 5;
  const rowH = byNode ? gpusPerNode * gpuPx + 6 : 16;

  const { bars, rows } = useMemo(() => {
    const visible = reservations.filter((reservation) => reservation.during && reservation.during.end > from && reservation.during.start < to);
    const list: Bar[] = [];
    if (byNode && nodes) {
      const index = new Map(nodes.map((node, row) => [node.id, row]));
      for (const reservation of visible) {
        for (const nodeId of reservation.nodeIds ?? []) {
          const row = index.get(nodeId);
          const span = atomSpan(reservation, nodeId);
          if (row === undefined || !span) continue;
          list.push({
            reservation,
            row,
            y0: row * rowH + 3 + span[0] * gpuPx,
            y1: row * rowH + 3 + (span[1] + 1) * gpuPx - 0.5,
            x0: xOf(reservation.during!.start),
            x1: xOf(reservation.during!.end),
          });
        }
      }
      return { bars: list, rows: nodes.map((node) => ({ id: node.id, label: node.id.split('-').slice(-2).join('-'), health: node.health })) };
    }
    const { lanes, laneOf } = packLanes(visible);
    for (const reservation of visible) {
      const row = laneOf.get(reservation.id) ?? 0;
      list.push({ reservation, row, y0: row * rowH + 2, y1: row * rowH + rowH - 2, x0: xOf(reservation.during!.start), x1: xOf(reservation.during!.end) });
    }
    return { bars: list, rows: Array.from({ length: lanes }, (_, lane) => ({ id: String(lane), label: `lane ${lane + 1}`, health: 'ok' as const })) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reservations, nodes, from, to, plotW, byNode, rowH, gpuPx]);

  const ticks = useMemo(() => timeTicks(from, to, plotW), [from, to, plotW]);
  const bodyH = rows.length * rowH;
  const focus = hover?.bar.reservation.id ?? selectedId;
  const nowX = xOf(now);

  return (
    <div ref={ref} className="relative w-full select-none" onPointerLeave={() => setHover(null)}>
      <svg width={width} height={AXIS_H} className="block" aria-hidden>
        {ticks.map((tick) => (
          <g key={tick.t}>
            <line x1={LABEL_W + tick.x} x2={LABEL_W + tick.x} y1={tick.day ? 2 : AXIS_H - 8} y2={AXIS_H} stroke="var(--color-separator-border)" />
            <text x={LABEL_W + tick.x + 3} y={tick.day ? 12 : AXIS_H - 9} className={cx('font-mono text-[10px]', tick.day ? 'fill-text-secondary' : 'fill-text-tertiary')}>
              {tick.label}
            </text>
          </g>
        ))}
        {now > from && now < to && (
          <text x={nowX} y={AXIS_H - 1} textAnchor="middle" className="fill-text-primary font-mono text-[8px] font-semibold">
            NOW
          </text>
        )}
      </svg>
      <div ref={scrollRef} className="overflow-y-auto border-t border-separator-border" style={{ maxHeight }}>
        <svg
          width={width}
          height={Math.max(bodyH, 24)}
          className="block"
          role="img"
          aria-label={`${bars.length} bookings between ${fmtStamp(from)} and ${fmtStamp(to)} UTC`}
        >
          {rows.map((row, index) => (
            <g key={row.id}>
              {index % 2 === 1 && <rect x={0} y={index * rowH} width={width} height={rowH} fill="var(--color-surface-sunken)" opacity={0.5} />}
              <text x={14} y={index * rowH + rowH / 2 + 4} className="fill-text-secondary font-mono text-[10px]">
                {row.label}
              </text>
              {row.health !== 'ok' && <circle cx={5} cy={index * rowH + rowH / 2} r={3} fill="var(--color-red-500)" />}
            </g>
          ))}
          {ticks.filter((tick) => tick.day).map((tick) => (
            <line key={tick.t} x1={LABEL_W + tick.x} x2={LABEL_W + tick.x} y1={0} y2={bodyH} stroke="var(--color-separator-border)" />
          ))}
          {bars.map((bar, index) => {
            const style = barStyle[bar.reservation.state];
            const w = Math.max(2, bar.x1 - bar.x0 - 1);
            const focused = focus === bar.reservation.id;
            return (
              <rect
                key={`${bar.reservation.id}:${bar.row}:${index}`}
                x={bar.x0}
                y={bar.y0}
                width={w}
                height={Math.max(2, bar.y1 - bar.y0)}
                fill={style.fill}
                fillOpacity={style.opacity ?? 1}
                stroke={focused ? 'var(--color-text-primary)' : style.stroke ?? 'none'}
                strokeWidth={focused ? 1.5 : 1}
                strokeDasharray={focused ? undefined : style.dash}
                className={onSelect ? 'cursor-pointer' : undefined}
                onPointerEnter={(event) => {
                  const box = ref.current!.getBoundingClientRect();
                  setHover({ bar, x: event.clientX - box.left, y: event.clientY - box.top });
                }}
                onClick={() => onSelect?.(bar.reservation)}
              />
            );
          })}
          {now > from && now < to && <line x1={nowX} x2={nowX} y1={0} y2={bodyH} stroke="var(--color-text-primary)" strokeWidth={1.5} pointerEvents="none" />}
        </svg>
      </div>
      {hover && (
        <HoverCard x={hover.x} y={hover.y + 14} containerWidth={width}>
          <div className="mb-1 flex items-center gap-2">
            <Led status={stateStyle[hover.bar.reservation.state].status === 'warn' ? 'warn' : stateStyle[hover.bar.reservation.state].status} />
            <span className="font-mono text-[12px] text-text-primary">{hover.bar.reservation.id}</span>
            <span className="ml-auto font-mono text-[10px] text-text-tertiary">{stateStyle[hover.bar.reservation.state].label}</span>
          </div>
          <HoverRow label="Tenant" value={tenantName(hover.bar.reservation.tenantId)} />
          {hover.bar.reservation.projectId && <HoverRow label="Project" value={hover.bar.reservation.projectId} />}
          <HoverRow
            label="GPUs"
            value={`${fmtNum(reservationGpus(hover.bar.reservation))}${hover.bar.reservation.request.gang ? ` · gang ×${hover.bar.reservation.request.gang.size}` : ''}${hover.bar.reservation.request.spot ? ' · spot' : ''}`}
          />
          <HoverRow label="Start" value={`${fmtStamp(hover.bar.reservation.during!.start)} UTC`} />
          <HoverRow label="Length" value={fmtDuration(hover.bar.reservation.during!.end - hover.bar.reservation.during!.start)} />
        </HoverCard>
      )}
    </div>
  );
});
