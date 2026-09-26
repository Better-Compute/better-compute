'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  from: fromProp,
  to: toProp,
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
  // Local zoom/pan over the window the page chose; a new window from the page resets it.
  const [view, setView] = useState<{ from: number; to: number } | null>(null);
  useEffect(() => setView(null), [fromProp, toProp]);
  const from = view?.from ?? fromProp;
  const to = view?.to ?? toProp;
  const plotW = Math.max(40, width - LABEL_W);
  const viewRef = useRef({ from, to, plotW });
  viewRef.current = { from, to, plotW };

  /** Zoom by `factor` around time `anchor` (1 h to 60 d spans). */
  const zoom = useCallback((factor: number, anchor?: number) => {
    const { from: f, to: t } = viewRef.current;
    const span = t - f;
    const next = Math.min(60 * 86_400_000, Math.max(3_600_000, span * factor));
    const at = anchor ?? f + span / 2;
    const nextFrom = at - ((at - f) / span) * next;
    setView({ from: nextFrom, to: nextFrom + next });
  }, []);
  const pan = useCallback((ms: number) => {
    const { from: f, to: t } = viewRef.current;
    setView({ from: f + ms, to: t + ms });
  }, []);

  // Ctrl/⌘ + wheel zooms around the cursor; Shift + wheel (or a horizontal wheel) pans. Native listener: React's
  // wheel handlers are passive and can't stop the page from zooming or scrolling.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      const { from: f, to: t, plotW: w } = viewRef.current;
      const box = element.getBoundingClientRect();
      const x = event.clientX - box.left - LABEL_W;
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        zoom(Math.exp(event.deltaY * 0.0025), f + (Math.max(0, Math.min(w, x)) / w) * (t - f));
      } else if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        event.preventDefault();
        pan(((event.shiftKey ? event.deltaY : event.deltaX) / w) * (t - f));
      }
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [zoom, pan]);

  // Drag on empty space pans.
  const drag = useRef<{ x: number; from: number; to: number } | null>(null);
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

  // Keyboard: bars are focusable; ←/→ move along the row by time, ↑/↓ to the nearest bar in the next row,
  // Enter/Space open. Each bar's DOM node is kept by its index.
  const barNodes = useRef(new Map<number, SVGRectElement>());
  const byRow = useMemo(() => {
    const map = new Map<number, number[]>();
    bars.forEach((bar, index) => map.set(bar.row, [...(map.get(bar.row) ?? []), index]));
    for (const list of map.values()) list.sort((a, b) => bars[a]!.x0 - bars[b]!.x0);
    return map;
  }, [bars]);
  const rowOrder = useMemo(() => [...byRow.keys()].sort((a, b) => a - b), [byRow]);
  const moveFocus = (index: number, key: string) => {
    const bar = bars[index]!;
    let target: number | undefined;
    if (key === 'ArrowRight' || key === 'ArrowLeft') {
      const list = byRow.get(bar.row)!;
      const at = list.indexOf(index);
      target = list[at + (key === 'ArrowRight' ? 1 : -1)];
    } else {
      const at = rowOrder.indexOf(bar.row);
      const row = rowOrder[at + (key === 'ArrowDown' ? 1 : -1)];
      if (row !== undefined) {
        const center = (bar.x0 + bar.x1) / 2;
        target = byRow.get(row)!.reduce((best, candidate) => (Math.abs((bars[candidate]!.x0 + bars[candidate]!.x1) / 2 - center) < Math.abs((bars[best]!.x0 + bars[best]!.x1) / 2 - center) ? candidate : best));
      }
    }
    if (target !== undefined) barNodes.current.get(target)?.focus();
  };
  const showFor = (bar: Bar, element: Element) => {
    const box = ref.current!.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    setHover({ bar, x: rect.left + rect.width / 2 - box.left, y: rect.bottom - box.top });
  };
  const zoomed = view !== null;
  // Roving tabindex: one bar is in the tab order (the last focused, else the selected, else the first).
  const [active, setActive] = useState<string | undefined>();
  const tabbable = useMemo(() => {
    const byKey = (id?: string) => (id ? bars.findIndex((bar) => bar.reservation.id === id) : -1);
    const found = byKey(active);
    if (found >= 0) return found;
    const selected = byKey(selectedId);
    return selected >= 0 ? selected : 0;
  }, [bars, active, selectedId]);

  return (
    <div ref={ref} className="relative w-full select-none" onPointerLeave={() => setHover(null)}>
      <div className="absolute top-0 right-0 z-10 flex items-center gap-1 bg-surface-raised/90 pl-1">
        <button type="button" aria-label="Zoom out" onClick={() => zoom(1.5)} className="grid size-6 place-items-center font-mono text-[13px] text-text-secondary hover:bg-background-secondary-default hover:text-text-primary">
          −
        </button>
        <button type="button" aria-label="Zoom in" onClick={() => zoom(1 / 1.5)} className="grid size-6 place-items-center font-mono text-[13px] text-text-secondary hover:bg-background-secondary-default hover:text-text-primary">
          +
        </button>
        {zoomed && (
          <button type="button" onClick={() => setView(null)} className="h-6 px-1.5 font-mono text-[10px] text-signal hover:underline">
            reset
          </button>
        )}
      </div>
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
          className={cx('block', drag.current ? 'cursor-grabbing' : 'cursor-grab')}
          role="group"
          aria-label={`${bars.length} bookings between ${fmtStamp(from)} and ${fmtStamp(to)} UTC. Arrow keys move between bookings; Enter opens one.`}
          onPointerDown={(event) => {
            if (event.button !== 0 || (event.target as Element).tagName === 'rect' && (event.target as Element).getAttribute('data-bar')) return;
            drag.current = { x: event.clientX, from, to };
            try {
              event.currentTarget.setPointerCapture(event.pointerId);
            } catch {
              // Synthetic or released pointers can't be captured; panning still works inside the chart.
            }
          }}
          onPointerMove={(event) => {
            if (!drag.current) return;
            const span = drag.current.to - drag.current.from;
            const shift = -((event.clientX - drag.current.x) / plotW) * span;
            setView({ from: drag.current.from + shift, to: drag.current.to + shift });
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
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
                ref={(node) => {
                  if (node) barNodes.current.set(index, node);
                  else barNodes.current.delete(index);
                }}
                data-bar="1"
                tabIndex={index === tabbable ? 0 : -1}
                role="button"
                aria-label={`${bar.reservation.id}, ${stateStyle[bar.reservation.state].label}, ${tenantName(bar.reservation.tenantId)}, ${reservationGpus(bar.reservation)} GPUs from ${fmtStamp(bar.reservation.during!.start)} UTC`}
                x={bar.x0}
                y={bar.y0}
                width={w}
                height={Math.max(2, bar.y1 - bar.y0)}
                fill={style.fill}
                fillOpacity={style.opacity ?? 1}
                stroke={focused ? 'var(--color-text-primary)' : style.stroke ?? 'none'}
                strokeWidth={focused ? 1.5 : 1}
                strokeDasharray={focused ? undefined : style.dash}
                className={cx('outline-none focus-visible:stroke-[var(--color-border-focus-ring)]', onSelect ? 'cursor-pointer' : undefined)}
                onPointerEnter={(event) => {
                  const box = ref.current!.getBoundingClientRect();
                  setHover({ bar, x: event.clientX - box.left, y: event.clientY - box.top });
                }}
                onFocus={(event) => {
                  setActive(bar.reservation.id);
                  showFor(bar, event.currentTarget);
                }}
                onBlur={() => setHover(null)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelect?.(bar.reservation);
                  } else if (event.key.startsWith('Arrow')) {
                    event.preventDefault();
                    moveFocus(index, event.key);
                  }
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
