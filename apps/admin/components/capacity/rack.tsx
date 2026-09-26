'use client';

import { memo, useMemo, useRef, useState } from 'react';
import { Led } from '@/components/ui/signal';
import { fmtRelative, fmtStamp } from '@/lib/data/format';
import { poolById, poolNodePlacement } from '@/lib/data/topology';
import type { CapacitySnapshot, Reservation } from '@/lib/data/capacity';
import { cx } from '@/utils/cx';
import { atomStates, type AtomState } from './model';
import { HoverCard, HoverRow } from './ui';

// Every GPU of a pool as one cell, nodes laid out as trays in their physical racks (topology's placement).
// Amber fill: allocated now. Amber outline: free now, booked later. Graphite: free. Hatched: out of service.

const cellClass: Record<AtomState, string> = {
  allocated: 'bg-signal-fill',
  reserved: 'border border-signal-fill bg-signal-soft',
  free: 'bg-background-secondary-default',
  unavailable: 'hatch border border-separator-border',
};

const LEGEND: { state: AtomState; label: string }[] = [
  { state: 'allocated', label: 'allocated now' },
  { state: 'reserved', label: 'free, booked later' },
  { state: 'free', label: 'free' },
  { state: 'unavailable', label: 'out of service' },
];

export function RackLegend({ className }: { className?: string }) {
  return (
    <div className={cx('flex flex-wrap items-center gap-x-3 gap-y-1', className)}>
      {LEGEND.map((item) => (
        <span key={item.state} className="inline-flex items-center gap-1.5 font-mono text-[11px] text-text-secondary">
          <span className={cx('inline-block h-2.5 w-3.5', cellClass[item.state])} />
          {item.label}
        </span>
      ))}
    </div>
  );
}

export const GpuRack = memo(function GpuRack({
  snapshot,
  poolId,
  onSelectReservation,
  tenantName,
  highlight,
}: {
  snapshot: CapacitySnapshot;
  poolId: string;
  onSelectReservation?(reservation: Reservation): void;
  tenantName(id: string): string;
  /** A reservation id to emphasise (its cells ring). */
  highlight?: string;
}) {
  const nodes = useMemo(() => atomStates(snapshot, poolId), [snapshot, poolId]);
  const pool = poolById(poolId);
  const containerRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ node: number; atom: number; x: number; y: number } | null>(null);
  const racks = useMemo(() => {
    const groups = new Map<string, typeof nodes>();
    nodes.forEach((entry, index) => {
      const rack = pool ? poolNodePlacement(pool, index).rack : `R${Math.floor(index / 8) + 1}`;
      groups.set(rack, [...(groups.get(rack) ?? []), entry]);
    });
    return [...groups];
  }, [nodes, pool]);
  const hoverKey = hover ? nodes[hover.node]?.atoms[hover.atom] : undefined;
  const focusId = hoverKey?.holder?.id ?? highlight;
  // Roving tabindex: one GPU is in the tab order; arrows move along a node (←/→) and between nodes (↑/↓),
  // Home/End jump to the node's first/last GPU. Cells are addressed as `node:gpu`.
  const [cursor, setCursor] = useState<{ node: number; atom: number }>({ node: 0, atom: 0 });
  const cells = useRef(new Map<string, HTMLButtonElement>());
  const move = (node: number, atom: number, key: string) => {
    let next = { node, atom };
    if (key === 'ArrowRight') next = { node, atom: Math.min(nodes[node]!.atoms.length - 1, atom + 1) };
    else if (key === 'ArrowLeft') next = { node, atom: Math.max(0, atom - 1) };
    else if (key === 'ArrowDown') next = { node: Math.min(nodes.length - 1, node + 1), atom };
    else if (key === 'ArrowUp') next = { node: Math.max(0, node - 1), atom };
    else if (key === 'Home') next = { node, atom: 0 };
    else if (key === 'End') next = { node, atom: nodes[node]!.atoms.length - 1 };
    else return false;
    next.atom = Math.min(next.atom, nodes[next.node]!.atoms.length - 1);
    setCursor(next);
    cells.current.get(`${next.node}:${next.atom}`)?.focus();
    return true;
  };

  if (!nodes.length) return <p className="text-caption-1-regular text-text-tertiary">This pool has no GPU nodes.</p>;

  return (
    <div
      ref={containerRef}
      className="relative"
      role="group"
      aria-label={`${nodes.length} nodes, one cell per GPU. Arrow keys move between GPUs and nodes; Enter opens the holding reservation.`}
      onPointerLeave={() => setHover(null)}
    >
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(188px, 1fr))' }}>
        {racks.map(([rack, members]) => (
          <div key={rack} className="border border-separator-border bg-surface-sunken p-1.5">
            <div className="mb-1 flex items-center justify-between font-mono text-[10px] text-text-tertiary">
              <span>{rack}</span>
              <span>
                {members.reduce((total, entry) => total + entry.atoms.filter((atom) => atom.state === 'allocated').length, 0)}/
                {members.reduce((total, entry) => total + entry.atoms.length, 0)}
              </span>
            </div>
            <div className="flex flex-col gap-1">
              {members.map((entry) => {
                const nodeIndex = nodes.indexOf(entry);
                return (
                  <div key={entry.node.id} className="flex items-center gap-1.5 border border-separator-border bg-surface-raised px-1.5 py-1">
                    <Led status={entry.node.health === 'ok' ? 'ok' : entry.node.health === 'provisioning' ? 'pending' : 'crit'} className="size-1.5" />
                    <span className="w-9 shrink-0 font-mono text-[10px] text-text-tertiary">{entry.node.id.slice(-3)}</span>
                    <div className="grid flex-1 gap-[2px]" style={{ gridTemplateColumns: `repeat(${entry.atoms.length}, minmax(0, 1fr))` }}>
                      {entry.atoms.map((atom) => (
                        <button
                          key={atom.id}
                          ref={(element) => {
                            const key = `${nodeIndex}:${atom.index}`;
                            if (element) cells.current.set(key, element);
                            else cells.current.delete(key);
                          }}
                          type="button"
                          tabIndex={cursor.node === nodeIndex && cursor.atom === atom.index ? 0 : -1}
                          onKeyDown={(event) => {
                            if (move(nodeIndex, atom.index, event.key)) event.preventDefault();
                          }}
                          aria-label={`${atom.id}: ${atom.state}${atom.holder ? `, held by ${atom.holder.id} (${tenantName(atom.holder.tenantId)})` : ''}${atom.next ? `, next booking ${atom.next.id}` : ''}`}
                          className={cx(
                            'h-3.5 min-w-0 outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring',
                            cellClass[atom.state],
                            focusId && atom.holder?.id === focusId && 'ring-1 ring-text-primary ring-offset-1 ring-offset-surface-raised',
                            (atom.holder || atom.next) && onSelectReservation && 'cursor-pointer',
                          )}
                          onPointerEnter={(event) => {
                            const box = containerRef.current!.getBoundingClientRect();
                            const cell = event.currentTarget.getBoundingClientRect();
                            setHover({ node: nodeIndex, atom: atom.index, x: cell.right - box.left, y: cell.bottom - box.top });
                          }}
                          onFocus={(event) => {
                            setCursor({ node: nodeIndex, atom: atom.index });
                            const box = containerRef.current!.getBoundingClientRect();
                            const cell = event.currentTarget.getBoundingClientRect();
                            setHover({ node: nodeIndex, atom: atom.index, x: cell.right - box.left, y: cell.bottom - box.top });
                          }}
                          onClick={() => {
                            const target = atom.holder ?? atom.next;
                            if (target) onSelectReservation?.(target);
                          }}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <RackLegend className="mt-3" />
      {hover && hoverKey && (
        <HoverCard x={hover.x} y={hover.y + 4} containerWidth={containerRef.current?.clientWidth ?? 800}>
          <div className="mb-1 font-mono text-[11px] text-text-primary">{hoverKey.id}</div>
          <HoverRow label="State" value={hoverKey.state} />
          {hoverKey.holder && (
            <>
              <HoverRow label="Held by" value={hoverKey.holder.id} />
              <HoverRow label="Tenant" value={tenantName(hoverKey.holder.tenantId)} />
              <HoverRow label="Until" value={`${fmtStamp(hoverKey.holder.during!.end)} (${fmtRelative(hoverKey.holder.during!.end, snapshot.now)})`} />
            </>
          )}
          {hoverKey.next && (
            <HoverRow label="Next booking" value={`${fmtRelative(hoverKey.next.during!.start, snapshot.now)} · ${tenantName(hoverKey.next.tenantId)}`} />
          )}
        </HoverCard>
      )}
    </div>
  );
});
