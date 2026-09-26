'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { RiArrowRightSLine } from 'react-icons/ri';
import { activity, attentionGroup, capacityTotals, controlPlane, fleetPulse, fmtClock, fmtDuration, fmtMoney, fmtNum, fmtPct, fmtRelative, nodeStates, pulseSeries, sites, type AttentionItem, type NodeState } from '@/lib/data';
import { collectAttention, type WidgetProps } from '@/lib/modules';
import { useCapacityTotals } from '@/components/capacity/data';
import { useFleetSummary } from '@/components/fleet/summary';
import { RANGES, useLive, useNow, useWorkspaceSettings } from '@/components/shell/workspace';
import { useFeedback } from '@/components/ui/feedback';
import { useAcks } from '@/components/shell/pins';
import { EntityLink, usePeek } from '@/components/shell/peek';
import { Gauge, Legend, Sparkline, StackedBar, TimeSeriesChart, useWidth } from '@/components/ui/charts';
import { Stat } from '@/components/ui/stat';
import { Led, SeverityIcon, Tag, type Status } from '@/components/ui/signal';
import { cx } from '@/utils/cx';
import { useAttentionItems } from '@/components/shell/use-attention';

/** Fleet KPIs with trends over the workspace range. */
export function KpiStrip({ size }: WidgetProps) {
  const { range: rangeKey, source } = useWorkspaceSettings();
  const range = RANGES[rangeKey];
  const live = source === 'live';
  const pulse = useLive((now, scope) => fleetPulse(now, scope), { bucketMs: 10_000 });
  // Node counts and GPU numbers come from the fleet and capacity modules (live API or simulation, whichever the
  // workspace reads), so they match /nodes and /capacity exactly.
  const fleet = useFleetSummary();
  const capacity = useCapacityTotals();
  const series = useLive((now, scope) => pulseSeries(now, 36, range.step * 2, scope), { bucketMs: 30_000, deps: [range.step] });
  // Trends are shapes over the range; the delta compares the range's ends of the same series. The trend history
  // only exists in the simulation, so live mode shows the numbers without it.
  const trendDelta = (values: number[]) => (!live && values.length > 1 && values[0] ? (values.at(-1)! - values[0]) / values[0] : undefined);
  const trend = (values: number[]) => (live ? undefined : values);
  const simHint = live ? 'simulated (no live source)' : undefined;
  const gpuUtil = series.map((p) => p.gpuUtilization);
  const gpuAlloc = series.map((p) => p.gpusAllocated);
  const nodes = fleet.nodes;
  const cards = [
    {
      label: 'Nodes ready',
      value: fleet.unavailable ? '—' : fmtNum(nodes.ready),
      unit: fleet.unavailable ? undefined : `/ ${fmtNum(nodes.total)}`,
      hint: fleet.unavailable ? 'the nodes API did not answer' : `${nodes.degraded} degraded · ${nodes.offline} offline · ${nodes.provisioning} provisioning`,
      trend: undefined as number[] | undefined,
    },
    {
      label: 'GPU utilization',
      value: fmtPct(capacity.gpus.utilization),
      delta: trendDelta(gpuUtil),
      trend: trend(gpuUtil),
    },
    {
      label: 'GPUs allocated',
      value: fmtNum(capacity.gpus.allocated),
      unit: `/ ${fmtNum(capacity.gpus.allocatable)}`,
      delta: trendDelta(gpuAlloc),
      trend: trend(gpuAlloc),
    },
    {
      label: 'GPUs free now',
      value: fmtNum(capacity.gpus.freeNow),
      hint: `${fmtNum(capacity.gpus.reserved)} booked ahead · ${fmtNum(capacity.gpus.unschedulable)} unschedulable`,
      goodWhen: 'up' as const,
    },
    {
      label: 'CPU utilization',
      value: fmtPct(pulse.cpuUtilization),
      trend: series.map((p) => p.cpuUtilization),
      tone: 'neutral' as const,
      hint: simHint,
    },
    {
      label: 'Sandboxes live',
      value: fmtNum(pulse.sandboxesLive),
      delta: trendDelta(series.map((p) => p.sandboxesLive)),
      trend: series.map((p) => p.sandboxesLive),
      tone: 'neutral' as const,
      hint: simHint,
    },
    {
      label: 'IT power',
      value: fmtNum(pulse.powerKw / 1000, { decimals: 2 }),
      unit: 'MW',
      trend: series.map((p) => p.powerKw),
      tone: 'neutral' as const,
      hint: simHint,
    },
  ];
  // As many cards as fit at ~150 px each (the grid unit says nothing on a phone, where every widget is 1 column).
  const [ref, width] = useWidth<HTMLDivElement>(size.w * 100);
  const count = Math.max(2, Math.min(cards.length, Math.floor(width / 150)));
  return (
    <div ref={ref} className="grid h-full divide-x divide-separator-border" style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}>
      {cards.slice(0, count).map((card) => (
        <Stat key={card.label} className="justify-center px-3 py-2" size="sm" {...card} />
      ))}
    </div>
  );
}

const PULSE_METRICS = {
  utilization: { label: 'Utilization', format: (v: number) => `${Math.round(v * 100)}%` },
  gpus: { label: 'GPUs allocated', format: (v: number) => fmtNum(v, { short: true }) },
  sandboxes: { label: 'Sandboxes live', format: (v: number) => fmtNum(v, { short: true }) },
  power: { label: 'IT power (kW)', format: (v: number) => fmtNum(v, { short: true }) },
} as const;

/** A fleet metric over the workspace range: utilization (GPU vs CPU), GPUs allocated, sandboxes or power. */
export function PulseChart({ size, settings }: WidgetProps) {
  const { range: key } = useWorkspaceSettings();
  const range = RANGES[key];
  const metric = (String(settings.metric) in PULSE_METRICS ? settings.metric : 'utilization') as keyof typeof PULSE_METRICS;
  const series = useLive((now, scope) => pulseSeries(now, range.points, range.step, scope), {
    bucketMs: Math.min(range.step, 60_000),
    deps: [range.points, range.step],
  });
  const times = series.map((p) => p.t);
  const long = key === '7d' || key === '30d';
  const lines =
    metric === 'utilization'
      ? [
          { id: 'gpu', label: 'GPU', values: series.map((p) => p.gpuUtilization), tone: 'signal' as const, area: true },
          ...(settings.compare !== false ? [{ id: 'cpu', label: 'CPU', values: series.map((p) => p.cpuUtilization), tone: 'neutral' as const, dashed: true }] : []),
        ]
      : [
          {
            id: metric,
            label: PULSE_METRICS[metric].label,
            values: series.map((p) => (metric === 'gpus' ? p.gpusAllocated : metric === 'sandboxes' ? p.sandboxesLive : p.powerKw)),
            tone: 'signal' as const,
            area: true,
          },
        ];
  const main = lines[0]!.values;
  const format = PULSE_METRICS[metric].format;
  return (
    <div className="flex h-full flex-col gap-2 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Legend items={lines.map((l) => ({ label: metric === 'utilization' ? `${l.label} utilization` : l.label, tone: l.tone }))} />
        <span className="font-mono text-[11px] text-text-tertiary">
          peak {format(Math.max(...main))} · low {format(Math.min(...main))}
        </span>
      </div>
      <TimeSeriesChart
        className="min-h-0 flex-1"
        height={Math.max(120, size.h * 80 - 110)}
        times={times}
        yMax={metric === 'utilization' ? 1 : undefined}
        yFormat={format}
        xFormat={(t) => (long ? new Date(t).toISOString().slice(5, 10) : fmtClock(t, false))}
        series={lines}
      />
    </div>
  );
}

/** The operator's queue: what needs a person, most severe first. */
export function AttentionQueue({ settings }: WidgetProps) {
  const items = useAttentionItems();
  const acks = useAcks();
  const { toast } = useFeedback();
  const now = useNow(10_000);
  const open = items.filter((item) => !acks.has(item.id));
  const ack = (id: string, title: string) => {
    acks.add([id]);
    toast({ title: 'Acknowledged', detail: title, status: 'ok', action: { label: 'undo', onAction: () => acks.remove([id]) } });
  };
  const ackMany = (members: AttentionItem[]) => {
    const ids = members.map((m) => m.id);
    acks.add(ids);
    toast({ title: `Acknowledged ${ids.length} items`, detail: attentionGroup(members[0]!), status: 'ok', action: { label: 'undo', onAction: () => acks.remove(ids) } });
  };
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  // Same-kind items collapse into one row (in the order of their most severe member); `grouped: false` lists all.
  const groups: [string, AttentionItem[]][] = [];
  for (const item of open) {
    const key = settings.grouped === false ? item.id : attentionGroup(item);
    const found = groups.find(([k]) => k === key);
    if (found) found[1].push(item);
    else groups.push([key, [item]]);
  }
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-separator-border px-3 py-1.5 font-mono text-[11px] text-text-tertiary">
        <span className="text-red-500">{open.filter((i) => i.severity === 'critical').length} critical</span>
        <span className="text-signal">{open.filter((i) => i.severity === 'warning').length} warning</span>
        <span>{open.filter((i) => i.severity === 'info').length} info</span>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto">
        {groups.map(([key, members]) =>
          members.length === 1 ? (
            <AttentionRow key={members[0]!.id} item={members[0]!} now={now} onAck={ack} />
          ) : (
            <li key={key} className="border-b border-separator-border/70 last:border-0">
              <div className="group flex gap-2.5 px-3 py-2.5">
                <SeverityIcon severity={members[0]!.severity} className="mt-0.5" />
                <button type="button" onClick={() => toggle(key)} aria-expanded={expanded.has(key)} className="min-w-0 flex-1 text-left">
                  <span className="flex items-center gap-2">
                    <RiArrowRightSLine className={cx('size-4 shrink-0 text-text-tertiary transition-transform', expanded.has(key) && 'rotate-90')} aria-hidden />
                    <span className="truncate text-body-medium text-text-primary">{key}</span>
                    <span className="shrink-0 border border-separator-border px-1 font-mono text-[10px] text-text-secondary">×{members.length}</span>
                  </span>
                  <span className="mt-0.5 block truncate pl-6 font-mono text-[10px] text-text-tertiary">
                    {members.slice(0, 4).map((m) => m.subject.split('/').pop()).join(' · ')}
                    {members.length > 4 ? ` · +${members.length - 4}` : ''} · newest <span suppressHydrationWarning>{fmtRelative(Math.max(...members.map((m) => m.at)), now)}</span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => ackMany(members)}
                  className="h-6 shrink-0 self-start px-1.5 font-mono text-[10px] text-text-tertiary opacity-0 group-hover:opacity-100 hover:text-text-primary focus:opacity-100"
                >
                  ack all
                </button>
              </div>
              {expanded.has(key) && (
                <ul className="border-t border-separator-border/60 bg-surface-sunken/40 pl-4">
                  {members.map((item) => (
                    <AttentionRow key={item.id} item={item} now={now} onAck={ack} />
                  ))}
                </ul>
              )}
            </li>
          ),
        )}
        {open.length === 0 && <li className="px-3 py-10 text-center text-caption-1-regular text-text-tertiary">Quiet. Nothing needs you.</li>}
      </ul>
    </div>
  );
}

function AttentionRow({ item, now, onAck }: { item: AttentionItem; now: number; onAck(id: string, title: string): void }) {
  return (
    <li className="group flex gap-2.5 border-b border-separator-border/70 px-3 py-2.5 last:border-0">
      <SeverityIcon severity={item.severity} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <Link href={item.href} className="block">
          <span className="block truncate text-body-medium text-text-primary group-hover:underline">{item.title}</span>
          <span className="line-clamp-2 text-caption-1-regular text-text-secondary">{item.detail}</span>
        </Link>
        <span className="mt-1 flex items-center gap-2 font-mono text-[10px] text-text-tertiary">
          <span>{item.source}</span>·<span suppressHydrationWarning>{fmtRelative(item.at, now)}</span>·
          <SubjectLink subject={item.subject} />
        </span>
        {item.action && (
          <Link
            href={item.action.href}
            className="mt-1.5 inline-flex h-6 items-center border border-signal-fill/50 px-2 font-mono text-[11px] text-signal hover:bg-signal-soft"
          >
            {item.action.label} →
          </Link>
        )}
      </div>
      <button
        type="button"
        onClick={() => onAck(item.id, item.title)}
        className="h-6 shrink-0 self-start px-1.5 font-mono text-[10px] text-text-tertiary opacity-0 group-hover:opacity-100 hover:text-text-primary focus:opacity-100"
      >
        ack
      </button>
    </li>
  );
}

const cellStyle: Record<NodeState, string> = {
  busy: '',
  idle: 'bg-background-secondary-default',
  degraded: 'border border-signal-fill bg-transparent',
  offline: 'bg-red-500',
  provisioning: 'hatch border border-separator-border-strong',
};

/** `node/n-fra1-h100-017` as a peekable link (plain text when no module renders that kind). */
export function SubjectLink({ subject }: { subject: string }) {
  const [kind, ...rest] = subject.split('/');
  const id = rest.join('/');
  const peek = usePeek();
  if (!kind || !id || !peek.canPeek(kind)) return <span className="truncate">{subject}</span>;
  return (
    <span className="truncate" onClick={(event) => event.stopPropagation()}>
      <EntityLink kind={kind} id={id} className="text-[10px] text-text-tertiary">
        {subject}
      </EntityLink>
    </span>
  );
}

/** Every node in scope as one cell, grouped by pool: amber by load, red offline, hatched provisioning. */
export function FleetWall({ settings }: WidgetProps) {
  const pulse = useLive((now, scope) => fleetPulse(now, scope), { bucketMs: 10_000 });
  const now = useNow(10_000);
  const peek = usePeek();
  const [hover, setHover] = useState<{ id: string; state: NodeState; load: number; pool: string } | null>(null);
  const kind = String(settings.kind ?? 'all');
  const walls = useMemo(
    () => pulse.pools.filter((p) => kind === 'all' || p.pool.kind === kind).map((p) => ({ pulse: p, nodes: nodeStates(p, now) })),
    [pulse, now, kind],
  );
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
                  onClick={(event) => {
                    if (!peek.canPeek('node') || event.metaKey || event.ctrlKey || event.shiftKey) return;
                    event.preventDefault();
                    peek.open('node', node.id);
                  }}
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
  const peek = usePeek();
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
              <button type="button" onClick={() => peek.open('component', component.id)} className="block max-w-full truncate text-left text-body-medium text-text-primary hover:underline">
                {component.name}
              </button>
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
  const { siteId, setSiteId } = useWorkspaceSettings();
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
                <td className="px-3 py-1.5" onClick={(event) => event.stopPropagation()}>
                  <EntityLink kind="site" id={row.site.id} /> <span className="text-text-tertiary">{row.site.city}</span>
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
export function ActivityWidget({ settings }: WidgetProps) {
  const all = useLive((now, scope) => activity(now, 60, scope), { bucketMs: 5_000 });
  const floor = String(settings.severity ?? 'info');
  const events = all.filter((e) => floor === 'info' || (floor === 'warning' ? e.severity !== 'info' : e.severity === 'critical'));
  const now = useNow(5_000);
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
