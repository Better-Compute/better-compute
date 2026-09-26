'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import {
  activity,
  attention,
  controlPlane,
  fleetPulse,
  fmtClock,
  fmtDuration,
  fmtMoney,
  fmtNum,
  fmtPct,
  fmtRelative,
  noise,
  floorTo,
  MINUTE,
  poolNodeId,
  pulseSeries,
  sites,
  type PoolPulse,
} from '@/lib/data';
import type { WidgetProps } from '@/lib/modules';
import { useLive, useWorkspace } from '@/components/shell/workspace';
import { Gauge, Legend, Sparkline, StackedBar, TimeSeriesChart } from '@/components/ui/charts';
import { Stat } from '@/components/ui/stat';
import { Led, SeverityIcon, Tag, type Status } from '@/components/ui/signal';
import { cx } from '@/utils/cx';

/** Fleet KPIs with trends over the workspace range. */
export function KpiStrip({ size }: WidgetProps) {
  const { window: range } = useWorkspace();
  const pulse = useLive((now, scope) => fleetPulse(now, scope));
  const series = useLive((now, scope) => pulseSeries(now, 36, range.step * 2, scope), { bucketMs: 30_000, deps: [range.step] });
  const prev = series[0];
  const delta = (current: number, before?: number) => (before ? (current - before) / before : undefined);
  const cards = [
    {
      label: 'Nodes ready',
      value: fmtNum(pulse.nodes.ready),
      unit: `/ ${fmtNum(pulse.nodes.total)}`,
      hint: `${pulse.nodes.degraded} degraded · ${pulse.nodes.offline} offline · ${pulse.nodes.provisioning} provisioning`,
      trend: undefined as number[] | undefined,
    },
    {
      label: 'GPU utilization',
      value: fmtPct(pulse.gpuUtilization),
      delta: delta(pulse.gpuUtilization, prev?.gpuUtilization),
      trend: series.map((p) => p.gpuUtilization),
    },
    {
      label: 'GPUs allocated',
      value: fmtNum(pulse.gpus.allocated),
      unit: `/ ${fmtNum(pulse.gpus.total)}`,
      delta: delta(pulse.gpus.allocated, prev?.gpusAllocated),
      trend: series.map((p) => p.gpusAllocated),
    },
    {
      label: 'GPUs free now',
      value: fmtNum(pulse.gpus.available),
      hint: `${fmtNum(pulse.gpus.reserved)} held for reservations`,
      goodWhen: 'up' as const,
    },
    {
      label: 'CPU utilization',
      value: fmtPct(pulse.cpuUtilization),
      trend: series.map((p) => p.cpuUtilization),
      tone: 'neutral' as const,
    },
    {
      label: 'Sandboxes live',
      value: fmtNum(pulse.sandboxesLive),
      delta: delta(pulse.sandboxesLive, prev?.sandboxesLive),
      trend: series.map((p) => p.sandboxesLive),
      tone: 'neutral' as const,
    },
    {
      label: 'IT power',
      value: fmtNum(pulse.powerKw / 1000, { decimals: 2 }),
      unit: 'MW',
      trend: series.map((p) => p.powerKw),
      tone: 'neutral' as const,
    },
  ];
  const count = size.w >= 12 ? 7 : size.w >= 8 ? 5 : size.w >= 6 ? 4 : 2;
  return (
    <div className="grid h-full divide-x divide-separator-border" style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}>
      {cards.slice(0, count).map((card) => (
        <Stat key={card.label} className="justify-center px-3 py-2" size="sm" {...card} />
      ))}
    </div>
  );
}

/** GPU and CPU utilization over the workspace range, with GPUs allocated. */
export function PulseChart({ size }: WidgetProps) {
  const { window: range, range: key } = useWorkspace();
  const series = useLive((now, scope) => pulseSeries(now, range.points, range.step, scope), {
    bucketMs: Math.min(range.step, 60_000),
    deps: [range.points, range.step],
  });
  const times = series.map((p) => p.t);
  const long = key === '7d' || key === '30d';
  return (
    <div className="flex h-full flex-col gap-2 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Legend
          items={[
            { label: 'GPU utilization', tone: 'signal' },
            { label: 'CPU utilization', tone: 'neutral' },
          ]}
        />
        <span className="font-mono text-[11px] text-text-tertiary">
          peak {fmtPct(Math.max(...series.map((p) => p.gpuUtilization)))} · low {fmtPct(Math.min(...series.map((p) => p.gpuUtilization)))}
        </span>
      </div>
      <TimeSeriesChart
        className="min-h-0 flex-1"
        height={Math.max(120, size.h * 80 - 110)}
        times={times}
        yMax={1}
        yFormat={(v) => `${Math.round(v * 100)}%`}
        xFormat={(t) => (long ? new Date(t).toISOString().slice(5, 10) : fmtClock(t, false))}
        series={[
          { id: 'gpu', label: 'GPU', values: series.map((p) => p.gpuUtilization), tone: 'signal', area: true },
          { id: 'cpu', label: 'CPU', values: series.map((p) => p.cpuUtilization), tone: 'neutral', dashed: true },
        ]}
      />
    </div>
  );
}

/** The operator's queue: what needs a person, most severe first. */
export function AttentionQueue() {
  const items = useLive((now, scope) => attention(now, scope), { bucketMs: 10_000 });
  const { now } = useWorkspace();
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const open = items.filter((item) => !dismissed.has(item.id));
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-separator-border px-3 py-1.5 font-mono text-[11px] text-text-tertiary">
        <span className="text-red-500">{open.filter((i) => i.severity === 'critical').length} critical</span>
        <span className="text-signal">{open.filter((i) => i.severity === 'warning').length} warning</span>
        <span>{open.filter((i) => i.severity === 'info').length} info</span>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto">
        {open.map((item) => (
          <li key={item.id} className="group flex gap-2.5 border-b border-separator-border/70 px-3 py-2.5 last:border-0">
            <SeverityIcon severity={item.severity} className="mt-0.5" />
            <Link href={item.href} className="min-w-0 flex-1">
              <span className="block truncate text-body-medium text-text-primary group-hover:underline">{item.title}</span>
              <span className="line-clamp-2 text-caption-1-regular text-text-secondary">{item.detail}</span>
              <span className="mt-1 flex items-center gap-2 font-mono text-[10px] text-text-tertiary">
                <span>{item.source}</span>·<span suppressHydrationWarning>{fmtRelative(item.at, now)}</span>·<span className="truncate">{item.subject}</span>
              </span>
            </Link>
            <button
              type="button"
              onClick={() => setDismissed((d) => new Set(d).add(item.id))}
              className="h-6 shrink-0 self-start px-1.5 font-mono text-[10px] text-text-tertiary opacity-0 group-hover:opacity-100 hover:text-text-primary focus:opacity-100"
            >
              ack
            </button>
          </li>
        ))}
        {open.length === 0 && <li className="px-3 py-10 text-center text-caption-1-regular text-text-tertiary">Quiet. Nothing needs you.</li>}
      </ul>
    </div>
  );
}

type NodeState = 'busy' | 'idle' | 'degraded' | 'offline' | 'provisioning';

function nodeStates(pulse: PoolPulse, t: number): { id: string; state: NodeState; load: number }[] {
  const { pool, nodes } = pulse;
  const bucket = floorTo(t, 20 * MINUTE) / MINUTE;
  const ranked = Array.from({ length: pool.nodes }, (_, i) => ({ i, r: noise(`${pool.id}:${i}:fault`, bucket) }))
    .sort((a, b) => a.r - b.r)
    .map((entry) => entry.i);
  const states = new Array<NodeState>(pool.nodes).fill('idle');
  let k = 0;
  for (let n = 0; n < nodes.offline; n++) states[ranked[k++]!] = 'offline';
  for (let n = 0; n < nodes.provisioning; n++) states[ranked[k++]!] = 'provisioning';
  for (let n = 0; n < nodes.degraded; n++) states[ranked[k++]!] = 'degraded';
  return states.map((state, i) => {
    const load = Math.min(1, Math.max(0, pulse.utilization + (noise(`${pool.id}:${i}:load`, Math.floor(t / (5 * MINUTE))) - 0.5) * 0.9));
    return {
      id: poolNodeId(pool, i),
      state: state === 'idle' && load > 0.15 ? 'busy' : state,
      load,
    };
  });
}

const cellStyle: Record<NodeState, string> = {
  busy: '',
  idle: 'bg-background-secondary-default',
  degraded: 'border border-signal-fill bg-transparent',
  offline: 'bg-red-500',
  provisioning: 'hatch border border-separator-border-strong',
};

/** Every node in scope as one cell, grouped by pool: amber by load, red offline, hatched provisioning. */
export function FleetWall() {
  const pulse = useLive((now, scope) => fleetPulse(now, scope), { bucketMs: 10_000 });
  const { now } = useWorkspace();
  const [hover, setHover] = useState<{ id: string; state: NodeState; load: number; pool: string } | null>(null);
  const walls = useMemo(() => pulse.pools.map((p) => ({ pulse: p, nodes: nodeStates(p, now) })), [pulse, now]);
  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-separator-border px-3 py-1.5">
        <Legend items={[{ label: 'busy', tone: 'signal' }, { label: 'idle', tone: 'muted' }, { label: 'offline', tone: 'crit' }, { label: 'provisioning', tone: 'hatch' }]} />
        <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-text-secondary">
          <span className="inline-block size-2.5 border border-signal-fill" />
          degraded
        </span>
        <span className="ml-auto truncate font-mono text-[11px] text-text-tertiary">
          {hover ? `${hover.id} · ${hover.state} · ${fmtPct(hover.load, 0)} load` : `${fmtNum(pulse.nodes.total)} nodes · hover a cell`}
        </span>
      </div>
      <div className="grid min-h-0 flex-1 auto-rows-min gap-x-4 gap-y-3 overflow-y-auto p-3 sm:grid-cols-2">
        {walls.map(({ pulse: p, nodes }) => (
          <div key={p.pool.id} className="min-w-0">
            <div className="mb-1 flex items-baseline justify-between gap-2">
              <Link href={`/pools/${p.pool.id}`} className="truncate font-mono text-[11px] text-text-secondary hover:text-text-primary">
                {p.pool.short} · {p.pool.siteId}
              </Link>
              <span className="font-mono text-[10px] text-text-tertiary tabular-nums">
                {p.nodes.ready}/{p.pool.nodes}
              </span>
            </div>
            <div className="flex flex-wrap gap-[2px]" onPointerLeave={() => setHover(null)}>
              {nodes.map((node) => (
                <Link
                  key={node.id}
                  href={`/nodes/${node.id}`}
                  aria-label={`${node.id}: ${node.state}`}
                  onPointerEnter={() => setHover({ ...node, pool: p.pool.id })}
                  className={cx('size-[9px] shrink-0', cellStyle[node.state])}
                  style={node.state === 'busy' ? { background: `color-mix(in srgb, var(--color-signal-fill) ${Math.round(35 + node.load * 65)}%, var(--color-background-secondary-default))` } : undefined}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const healthStatus: Record<string, Status> = { ok: 'ok', degraded: 'warn', down: 'crit' };

/** The control plane's own components: status, latency trend, throughput. */
export function ControlPlaneWidget() {
  const components = useLive((now) => controlPlane(now), { bucketMs: 10_000 });
  const degraded = components.filter((c) => c.status !== 'ok').length;
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-separator-border px-3 py-1.5">
        <Led status={degraded ? 'warn' : 'live'} />
        <span className="font-mono text-[11px] text-text-secondary">
          {degraded ? `${degraded} degraded of ${components.length}` : `all ${components.length} components nominal`}
        </span>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto">
        {components.map((component) => (
          <li key={component.id} className="grid grid-cols-[auto_minmax(0,1fr)_72px_auto] items-center gap-3 border-b border-separator-border/70 px-3 py-2 last:border-0">
            <Led status={healthStatus[component.status]!} label={component.status} />
            <div className="min-w-0">
              <div className="truncate text-body-medium text-text-primary">{component.name}</div>
              <div className="truncate font-mono text-[10px] text-text-tertiary">{component.detail}</div>
            </div>
            <Sparkline values={component.series} height={22} tone={component.status === 'ok' ? 'neutral' : 'signal'} area={false} />
            <div className="text-right font-mono text-[11px] tabular-nums">
              <div className={component.status === 'ok' ? 'text-text-primary' : 'text-signal'}>{fmtDuration(component.latencyMs)}</div>
              <div className="text-[10px] text-text-tertiary">
                {fmtNum(component.rate, { short: true })} {component.rateUnit}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Sites on a map (equirectangular, EU + US), sized by nodes and lit by GPU utilization, with a table. */
export function SitesWidget({ size }: WidgetProps) {
  const pulse = useLive((now) => fleetPulse(now), { bucketMs: 10_000 });
  const { siteId, setSiteId } = useWorkspace();
  const bySite = sites.map((site) => {
    const pools = pulse.pools.filter((p) => p.pool.siteId === site.id);
    const gpu = pools.filter((p) => p.unit === 'gpu');
    const allocatable = gpu.reduce((s, p) => s + p.total - p.unhealthy, 0);
    return {
      site,
      nodes: pools.reduce((s, p) => s + p.pool.nodes, 0),
      ready: pools.reduce((s, p) => s + p.nodes.ready, 0),
      offline: pools.reduce((s, p) => s + p.nodes.offline, 0),
      gpus: gpu.reduce((s, p) => s + p.total, 0),
      util: allocatable ? gpu.reduce((s, p) => s + p.allocated, 0) / allocatable : 0,
      powerKw: pools.reduce((s, p) => s + p.powerKw, 0),
    };
  });
  // Longitude −130..30, latitude 25..65.
  const W = 400;
  const H = 150;
  const px = (lon: number) => ((lon + 130) / 160) * W;
  const py = (lat: number) => ((65 - lat) / 40) * H;
  const wide = size.w >= 6;
  return (
    <div className={cx('grid h-full min-h-0', wide ? 'grid-rows-[minmax(0,1fr)_auto]' : 'grid-rows-1')}>
      <div className="relative min-h-0 border-b border-separator-border bg-surface-sunken">
        <svg viewBox={`0 0 ${W} ${H}`} className="h-full w-full" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Sites map">
          <defs>
            <pattern id="map-grid" width="10" height="10" patternUnits="userSpaceOnUse">
              <circle cx="1" cy="1" r="0.6" fill="var(--color-separator-border-strong)" />
            </pattern>
          </defs>
          <rect width={W} height={H} fill="url(#map-grid)" />
          <line x1={px(-30)} x2={px(-30)} y1="6" y2={H - 6} stroke="var(--color-separator-border)" strokeDasharray="2 4" />
          <text x={px(-100)} y={H - 8} className="fill-text-tertiary font-mono text-[7px]">NORTH AMERICA</text>
          <text x={px(0)} y={H - 8} className="fill-text-tertiary font-mono text-[7px]">EUROPE</text>
          {bySite.map(({ site, nodes, util, offline }) => {
            const r = 3 + Math.sqrt(nodes) * 0.9;
            const active = !siteId || siteId === site.id;
            return (
              <g key={site.id} className="cursor-pointer" onClick={() => setSiteId(siteId === site.id ? undefined : site.id)} opacity={active ? 1 : 0.35}>
                <circle cx={px(site.lon)} cy={py(site.lat)} r={r + 4} fill="var(--color-signal-soft)" />
                <circle cx={px(site.lon)} cy={py(site.lat)} r={r} fill={`color-mix(in srgb, var(--color-signal-fill) ${Math.round(util * 100)}%, var(--color-surface-raised))`} stroke="var(--color-signal-fill)" strokeWidth="0.8" />
                {offline > 0 && <circle cx={px(site.lon) + r} cy={py(site.lat) - r} r="2.2" fill="var(--color-red-500)" />}
                <text x={px(site.lon)} y={py(site.lat) - r - 4} textAnchor="middle" className="fill-text-primary font-mono text-[8px]">
                  {site.id}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      {wide && (
        <table className="w-full text-left">
          <thead>
            <tr className="font-mono text-[10px] tracking-wide text-text-tertiary uppercase">
              <th className="px-3 py-1.5 font-medium">Site</th>
              <th className="px-2 py-1.5 text-right font-medium">Nodes</th>
              <th className="px-2 py-1.5 text-right font-medium">GPUs</th>
              <th className="w-[30%] px-2 py-1.5 font-medium">GPU util</th>
              <th className="px-3 py-1.5 text-right font-medium">kW</th>
            </tr>
          </thead>
          <tbody>
            {bySite.map((row) => (
              <tr
                key={row.site.id}
                onClick={() => setSiteId(siteId === row.site.id ? undefined : row.site.id)}
                className={cx('cursor-pointer border-t border-separator-border/70 text-caption-1-regular hover:bg-background-secondary-default/60', siteId === row.site.id && 'bg-signal-soft')}
              >
                <td className="px-3 py-1.5">
                  <span className="font-mono text-text-primary">{row.site.id}</span> <span className="text-text-tertiary">{row.site.city}</span>
                </td>
                <td className="px-2 py-1.5 text-right font-mono tabular-nums">
                  {row.ready}
                  <span className="text-text-tertiary">/{row.nodes}</span>
                </td>
                <td className="px-2 py-1.5 text-right font-mono tabular-nums">{row.gpus || '—'}</td>
                <td className="px-2 py-1.5">
                  {row.gpus ? (
                    <div className="flex items-center gap-2">
                      <StackedBar height={6} parts={[{ label: 'allocated', value: row.util, tone: 'signal' }, { label: 'free', value: 1 - row.util, tone: 'muted' }]} />
                      <span className="w-9 text-right font-mono text-[10px] tabular-nums">{fmtPct(row.util, 0)}</span>
                    </div>
                  ) : (
                    <span className="text-text-tertiary">CPU only</span>
                  )}
                </td>
                <td className="px-3 py-1.5 text-right font-mono tabular-nums">{fmtNum(row.powerKw)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const typeStatus = (severity: string): Status => (severity === 'critical' ? 'crit' : severity === 'warning' ? 'warn' : 'ok');

/** The live event stream (newest first), filterable by kind. */
export function ActivityWidget() {
  const events = useLive((now, scope) => activity(now, 40, scope), { bucketMs: 5_000 });
  const { now } = useWorkspace();
  const [kind, setKind] = useState<string | null>(null);
  const kinds = [...new Set(events.map((e) => e.type.split('.')[0]!))];
  const shown = kind ? events.filter((e) => e.type.startsWith(`${kind}.`)) : events;
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 overflow-x-auto border-b border-separator-border px-2 py-1">
        {[null, ...kinds].map((k) => (
          <button
            key={k ?? 'all'}
            type="button"
            onClick={() => setKind(k)}
            className={cx('h-6 shrink-0 px-2 font-mono text-[11px]', kind === k ? 'bg-background-secondary-default text-text-primary' : 'text-text-tertiary hover:text-text-primary')}
          >
            {k ?? 'all'}
          </button>
        ))}
      </div>
      <ol className="min-h-0 flex-1 overflow-y-auto">
        {shown.map((event, index) => (
          <li
            key={event.id}
            className={cx(
              'grid grid-cols-[52px_auto_minmax(0,1fr)] items-start gap-2 border-b border-separator-border/60 px-3 py-1.5',
              index === 0 && 'motion-safe:animate-[row-in_400ms_ease-out]',
            )}
          >
            <time className="pt-0.5 font-mono text-[10px] text-text-tertiary tabular-nums" suppressHydrationWarning>
              {fmtClock(event.at)}
            </time>
            <Led status={typeStatus(event.severity)} className="mt-1.5" />
            <div className="min-w-0">
              <Link href={event.href ?? '#'} className="block truncate text-caption-1-regular text-text-primary hover:underline">
                {event.message}
              </Link>
              <span className="font-mono text-[10px] text-text-tertiary">
                {event.type} · {event.actor} · <span suppressHydrationWarning>{fmtRelative(event.at, now)}</span>
              </span>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Power draw and the run-rate it implies. */
export function PowerWidget() {
  const pulse = useLive((now, scope) => fleetPulse(now, scope), { bucketMs: 10_000 });
  const capacityKw = pulse.pools.reduce((s, p) => s + p.pool.nodes * (p.unit === 'gpu' ? 1.6 + p.pool.gpusPerNode * 0.68 : 0.9), 0);
  const ratio = pulse.powerKw / capacityKw;
  const perHour = pulse.powerKw * 0.14;
  return (
    <div className="flex h-full items-center gap-4 p-3">
      <Gauge ratio={ratio} label="of budget" size={96} />
      <div className="flex min-w-0 flex-col gap-2">
        <Stat label="Draw" value={fmtNum(pulse.powerKw)} unit="kW" size="sm" />
        <Stat label="Energy run-rate" value={fmtMoney(perHour)} unit="/ h" size="sm" hint={`${fmtMoney(perHour * 24 * 30, { short: true })} / month at $0.14/kWh`} />
      </div>
    </div>
  );
}

/** A compact health tag, exported for modules that want the same wording. */
export function HealthTag({ status }: { status: 'ok' | 'degraded' | 'down' }) {
  return <Tag status={healthStatus[status]}>{status}</Tag>;
}
