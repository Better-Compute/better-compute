'use client';

import { useMemo, useState } from 'react';
import { cx } from '@/utils/cx';
import { Led } from '@/components/ui/signal';
import type { FleetNode } from '@/lib/data/fleet';
import { poolById, siteById } from '@/lib/data/topology';
import { fmtPct } from '@/lib/data/format';
import { nodeStatus, nodeStatusLabel } from './ui';

const RACK_U = 42;

type Colour = 'util' | 'temp' | 'status';

/**
 * Rack elevations: every rack as a 42U column, servers drawn at their units (U1 at the bottom, like the real
 * thing). Fill is the node's GPU load on the amber ramp (CPU load for hosts), hatched when it takes no new work,
 * with a red edge when it is broken. Nodes outside the current filter are dimmed, not removed, so the rack still
 * reads as a rack. Click a server to open it.
 */
export function RackView({
  nodes,
  visible,
  activeId,
  onOpen,
}: {
  nodes: readonly FleetNode[];
  /** Ids that pass the page's filters. */
  visible: ReadonlySet<string>;
  activeId?: string;
  onOpen(node: FleetNode): void;
}) {
  const [colour, setColour] = useState<Colour>('util');
  const [unitPx, setUnitPx] = useState(9);
  const sites = useMemo(() => {
    const bySite = new Map<string, Map<string, FleetNode[]>>();
    for (const node of nodes) {
      const key = node.rack;
      const racks = bySite.get(node.siteId) ?? new Map<string, FleetNode[]>();
      racks.set(key, [...(racks.get(key) ?? []), node]);
      bySite.set(node.siteId, racks);
    }
    return [...bySite].map(([siteId, racks]) => ({
      siteId,
      racks: [...racks]
        .sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }))
        .map(([key, members]) => ({ key, rack: key, poolId: members[0]!.poolId!, members })),
    }));
  }, [nodes]);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3 text-caption-1-regular text-text-secondary">
        <span className="font-mono text-[11px] tracking-wide text-text-tertiary uppercase">Fill</span>
        {(['util', 'temp', 'status'] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            onClick={() => setColour(mode)}
            aria-pressed={colour === mode}
            className={cx('h-6 border px-2 font-mono text-[11px]', colour === mode ? 'border-signal-fill/60 bg-signal-soft text-text-primary' : 'border-separator-border hover:text-text-primary')}
          >
            {mode === 'util' ? 'load' : mode === 'temp' ? 'hottest GPU' : 'status only'}
          </button>
        ))}
        <span className="ml-4 font-mono text-[11px] tracking-wide text-text-tertiary uppercase">Scale</span>
        <input type="range" min={6} max={16} value={unitPx} onChange={(event) => setUnitPx(Number(event.target.value))} aria-label="Rack unit height" className="w-24 accent-[var(--color-signal-fill)]" />
        <span className="ml-auto flex items-center gap-3">
          <Key className="bg-[color-mix(in_srgb,var(--color-signal-fill)_85%,var(--color-surface-sunken))]" label="busy" />
          <Key className="bg-background-secondary-default" label="idle" />
          <Key className="hatch border border-separator-border-strong" label="no new work" />
          <Key className="border-2 border-red-500" label="broken" />
          <Key className="border border-dashed border-signal-fill" label="provisioning" />
        </span>
      </div>
      {sites.map(({ siteId, racks }) => {
        const site = siteById(siteId);
        return (
          <section key={siteId} className="flex flex-col gap-2">
            <h3 className="flex items-baseline gap-2">
              <span className="font-mono text-[13px] font-medium text-text-primary">{site?.name ?? siteId}</span>
              <span className="font-mono text-[11px] text-text-tertiary">
                {racks.length} racks · {racks.reduce((sum, rack) => sum + rack.members.length, 0)} servers · {site?.provider}
              </span>
            </h3>
            <div className="flex gap-3 overflow-x-auto pb-2">
              {racks.map((rack) => (
                <Rack key={rack.key} name={rack.rack} poolId={rack.poolId} members={rack.members} visible={visible} activeId={activeId} onOpen={onOpen} colour={colour} unitPx={unitPx} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function Key({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[11px]">
      <span className={cx('inline-block size-2.5', className)} />
      {label}
    </span>
  );
}

function load(node: FleetNode): number {
  const live = node.gpus.filter((gpu) => gpu.telemetry);
  if (live.length) return live.reduce((sum, gpu) => sum + gpu.telemetry!.utilization, 0) / live.length;
  return node.cpu.utilization ?? 0;
}
function hottest(node: FleetNode): number {
  return node.gpus.reduce((max, gpu) => Math.max(max, gpu.telemetry?.temperatureC ?? 0), 0);
}

function Rack({
  name,
  poolId,
  members,
  visible,
  activeId,
  onOpen,
  colour,
  unitPx,
}: {
  name: string;
  poolId: string;
  members: FleetNode[];
  visible: ReadonlySet<string>;
  activeId?: string;
  onOpen(node: FleetNode): void;
  colour: Colour;
  unitPx: number;
}) {
  const pool = poolById(poolId);
  const height = RACK_U * unitPx;
  const kw = members.reduce((sum, node) => sum + node.gpus.reduce((s, gpu) => s + (gpu.telemetry?.powerW ?? 0), 0), 0) / 1000;
  return (
    <figure className="flex shrink-0 flex-col items-stretch gap-1">
      <figcaption className="flex items-baseline justify-between gap-2 px-0.5">
        <span className="font-mono text-[11px] font-medium text-text-primary">{name}</span>
        <span className="font-mono text-[10px] text-text-tertiary">{pool?.short}</span>
      </figcaption>
      <div className="flex border border-separator-border-strong bg-surface-sunken">
        {/* The rail: U numbers every 6 units, rail holes as hairlines. */}
        <div className="relative w-5 shrink-0 border-r border-separator-border" style={{ height }}>
          {Array.from({ length: RACK_U / 6 + 1 }, (_, i) => i * 6).map((u) =>
            u === 0 ? null : (
              <span key={u} className="absolute right-0.5 font-mono text-[8px] leading-none text-text-tertiary" style={{ bottom: (u - 1) * unitPx }}>
                {u}
              </span>
            ),
          )}
        </div>
        <div className="relative w-36" style={{ height }}>
          {Array.from({ length: RACK_U }, (_, i) => (
            <span key={i} className="absolute inset-x-0 border-t border-separator-border/40" style={{ bottom: i * unitPx }} />
          ))}
          {members.map((node) => {
            const bottom = (node.unit - node.heightU) * unitPx;
            const status = nodeStatus(node);
            const shown = visible.has(node.id);
            const value = colour === 'temp' ? Math.max(0, (hottest(node) - 30) / 55) : load(node);
            const quiet = node.cordoned || node.maintenance || node.provisionState === 'rescue' || node.provisionState === 'retiring';
            const fill =
              colour !== 'status' && !quiet && node.connectivity === 'connected' && value > 0.02
                ? `color-mix(in srgb, var(--color-signal-fill) ${Math.round(20 + value * 80)}%, var(--color-surface-sunken))`
                : undefined;
            return (
              <button
                key={node.id}
                type="button"
                onClick={() => onOpen(node)}
                title={`${node.hostname} · ${nodeStatusLabel(node)}\n${pool?.short ?? ''} · ${colour === 'temp' ? `${hottest(node)}°C hottest` : `${fmtPct(load(node), 0)} load`}`}
                className={cx(
                  'absolute inset-x-0.5 flex items-center gap-1 overflow-hidden px-1 text-left outline-none transition-[opacity,background-color] duration-300',
                  'focus-visible:ring-2 focus-visible:ring-border-focus-ring',
                  !fill && !quiet && 'bg-background-secondary-default',
                  quiet && 'hatch',
                  status === 'crit' ? 'border-2 border-red-500' : status === 'pending' ? 'border border-dashed border-signal-fill' : 'border border-separator-border-strong',
                  node.id === activeId && 'ring-2 ring-text-primary',
                  !shown && 'opacity-20',
                )}
                style={{ bottom: bottom + 1, height: node.heightU * unitPx - 2, ...(fill ? { background: fill } : {}) }}
              >
                {node.heightU * unitPx >= 14 && (
                  <>
                    <Led status={status} className="size-1.5" />
                    <span className={cx('truncate font-mono text-[9px] leading-none', fill && value > 0.55 ? 'text-neutral-950' : 'text-text-secondary')}>
                      {node.hostname.split('-').slice(-1)[0]}
                    </span>
                  </>
                )}
              </button>
            );
          })}
        </div>
      </div>
      <span className="px-0.5 text-right font-mono text-[10px] text-text-tertiary">{kw ? `${kw.toFixed(1)} kW` : '—'}</span>
    </figure>
  );
}
