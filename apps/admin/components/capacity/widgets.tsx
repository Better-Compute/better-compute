'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, type ComponentType } from 'react';
import { earliestFit } from '@better-compute/console-kit';
import { Sparkline, StackedBar } from '@/components/ui/charts';
import { EmptyState } from '@/components/ui/panel';
import { Mono, Tag } from '@/components/ui/signal';
import { Stat } from '@/components/ui/stat';
import type { WidgetProps } from '@/lib/modules';
import { fmtDuration, fmtMoney, fmtNum, fmtPct, fmtRelative } from '@/lib/data/format';
import { reservationGpus } from '@/lib/data/capacity';
import { cx } from '@/utils/cx';
import { DAY, HOUR, useHourWindow, usePoolRows, useTenantName, useTimelines } from './data';
import { CapacityHeatmap } from './heatmap';
import { InsightList } from './insights';
import { SpotList } from './spot';
import { UpcomingList } from './upcoming';
import { byModel, costOf, dailySpend, fleetSeries, fleetTotals, heatMatrix, pressure, quotaCells, rollup } from './model';
import { planHref, Segmented } from './ui';

// Dashboard widgets of the capacity module. Each renders only its body (the shell's WidgetFrame draws the title
// bar, menu and resize handle) and adapts to its grid size: 12 columns, 80 px rows.

/** Usable body height inside the frame's title bar and our padding. */
const bodyHeight = (h: number) => h * 80 - 48 - 24;

/** The frame body is flush; widgets bring their own padding (as the Overview's do). */
export function padded(Component: ComponentType<WidgetProps>): ComponentType<WidgetProps> {
  function Padded(props: WidgetProps) {
    return (
      <div className="h-full overflow-y-auto p-3">
        <Component {...props} />
      </div>
    );
  }
  Padded.displayName = `Padded(${Component.name})`;
  return Padded;
}

export function CapacityKpisWidget({ size }: WidgetProps) {
  const { snapshot, rows } = usePoolRows();
  const totals = useMemo(() => fleetTotals(rows), [rows]);
  const { from, to, hour } = useHourWindow(24, 0);
  const timelines = useTimelines(
    rows.filter((row) => row.unit === 'gpu').map((row) => row.id),
    from,
    to + HOUR,
  );
  const series = useMemo(() => fleetSeries([...timelines.values()]), [timelines]);
  const trend = series.booked.map((booked, index) => (series.allocatable[index] ? booked / series.allocatable[index]! : 0));
  const spend = useMemo(() => snapshot.usage.filter((w) => w.windowStart >= hour - DAY).reduce((total, w) => total + costOf(w, snapshot.prices), 0), [snapshot, hour]);
  const count = size.w >= 10 ? 5 : size.w >= 6 ? 4 : 2;
  const cards = [
    { label: 'GPUs allocated', value: fmtPct(totals.utilization, 0), unit: `${fmtNum(totals.allocated)}/${fmtNum(totals.allocatable)}`, trend: size.h >= 2 ? trend : undefined },
    { label: 'Free now', value: fmtNum(totals.freeNow), unit: 'GPUs', tone: 'neutral' as const, hint: `${fmtNum(totals.unavailable)} out of service` },
    { label: 'Waiting', value: fmtNum(totals.pending), unit: 'pending', tone: 'neutral' as const },
    { label: 'Booked later', value: fmtNum(totals.reserved), unit: 'atoms', tone: 'neutral' as const },
    { label: 'Spend, 24 h', value: fmtMoney(spend, { short: true }), tone: 'neutral' as const, hint: 'at list price' },
  ];
  return (
    <div className="grid h-full divide-x divide-separator-border" style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}>
      {cards.slice(0, count).map((card) => (
        <Stat key={card.label} className="justify-center px-3 py-2" size="sm" {...card} />
      ))}
    </div>
  );
}

const HEAT_WINDOWS: Record<string, [number, number]> = { '12/48': [12, 48], '24/72': [24, 72], '24/96': [24, 96], '48/168': [48, 168], '168/168': [168, 168] };

export function CapacityHeatmapWidget({ size, settings, editing }: WidgetProps) {
  const router = useRouter();
  const { snapshot, rows } = usePoolRows();
  const chosen = HEAT_WINDOWS[String(settings.window)];
  const [back, ahead] = chosen ?? (size.w >= 8 ? [24, 96] : [12, 48]);
  const { from, to } = useHourWindow(back, ahead);
  const model = String(settings.model ?? 'all');
  const sort = String(settings.sort ?? 'pool');
  const gpuRows = useMemo(() => {
    const list = rows.filter((row) => row.unit === 'gpu' && (model === 'all' || row.short === model));
    return sort === 'utilization' ? [...list].sort((a, b) => b.utilization - a.utilization) : sort === 'free' ? [...list].sort((a, b) => b.freeNow - a.freeNow) : list;
  }, [rows, model, sort]);
  const timelines = useTimelines(
    gpuRows.map((row) => row.id),
    from,
    to,
  );
  const matrix = useMemo(() => heatMatrix(gpuRows, timelines, from, HOUR, (to - from) / HOUR), [gpuRows, timelines, from, to]);
  if (!matrix.rows.length) return <EmptyState title="No GPU pools in scope" />;
  const rowHeight = Math.max(12, Math.min(24, Math.floor((bodyHeight(size.h) - 30) / matrix.rows.length)));
  return (
    <CapacityHeatmap
      matrix={matrix}
      now={snapshot.now}
      rowHeight={rowHeight}
      compact={size.w < 8}
      onSelect={(poolId) => router.push(`/pools/${poolId}`)}
      onRange={editing ? undefined : (poolId, start, end) => router.push(planHref(poolId, start, end))}
    />
  );
}

export function PoolsWidget({ size, settings }: WidgetProps) {
  const { rows } = usePoolRows();
  const kind = String(settings.kind ?? 'all');
  const sort = String(settings.sort ?? 'utilization');
  const sorted = useMemo(
    () =>
      rows
        .filter((row) => kind === 'all' || row.unit === kind)
        .sort((a, b) => (sort === 'free' ? b.freeNow / (b.allocatable || 1) - a.freeNow / (a.allocatable || 1) : sort === 'name' ? a.name.localeCompare(b.name) : b.utilization - a.utilization)),
    [rows, kind, sort],
  );
  const fit = Math.max(2, Math.floor(bodyHeight(size.h) / 34));
  return (
    <ul className="flex flex-col gap-2">
      {sorted.slice(0, fit).map((row) => (
        <li key={row.id}>
          <Link href={`/pools/${row.id}`} className="group block">
            <div className="mb-1 flex items-baseline justify-between gap-2">
              <span className="truncate text-caption-1-medium text-text-primary group-hover:underline">
                {row.name} <span className="font-mono text-[10px] text-text-tertiary">{row.siteId}</span>
              </span>
              <span className="shrink-0 font-mono text-[11px] tabular-nums text-text-secondary">
                {fmtPct(row.utilization, 0)} · {fmtNum(row.freeNow)} free
              </span>
            </div>
            <StackedBar
              height={6}
              total={row.total}
              parts={[
                { label: 'allocated', value: row.allocated, tone: 'signal' },
                { label: 'free', value: row.freeNow, tone: 'muted' },
                { label: 'out of service', value: row.unavailable, tone: 'hatch' },
              ]}
            />
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function ModelsWidget() {
  const { rows } = usePoolRows();
  const models = useMemo(() => byModel(rows), [rows]);
  return (
    <table className="w-full">
      <tbody>
        {models.map((model) => (
          <tr key={model.short} className="border-b border-separator-border last:border-0">
            <td className="py-1.5 pr-2 font-mono text-[12px]">{model.short}</td>
            <td className="w-full py-1.5">
              <StackedBar
                height={6}
                total={model.total}
                parts={[
                  { label: 'allocated', value: model.allocated, tone: 'signal' },
                  { label: 'free', value: model.freeNow, tone: 'muted' },
                  { label: 'out of service', value: model.total - model.allocatable, tone: 'hatch' },
                ]}
              />
            </td>
            <td className="py-1.5 pl-2 text-right font-mono text-[11px] whitespace-nowrap tabular-nums text-text-secondary">
              {fmtNum(model.freeNow)} / {fmtNum(model.total)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function UpcomingWidget({ size, settings }: WidgetProps) {
  const show = String(settings.show ?? 'both') as 'both' | 'starts' | 'ends';
  return (
    <div className="-m-3">
      <UpcomingList hours={Number(settings.horizon ?? 12)} show={show} minGpus={Number(settings.minGpus ?? 1)} limit={Math.max(3, Math.floor(bodyHeight(size.h) / 30))} />
    </div>
  );
}
export function QuotaAlertsWidget({ size, settings }: WidgetProps) {
  const { snapshot, rows } = usePoolRows();
  const tenantName = useTenantName();
  const inScope = useMemo(() => new Set(rows.map((row) => row.id)), [rows]);
  const threshold = Number(settings.threshold ?? 80) / 100;
  const resource = String(settings.resource ?? 'all');
  const alerts = useMemo(
    () =>
      quotaCells(snapshot.quotas, threshold)
        .filter((cell) => cell.level !== 'ok' && cell.tenantId !== snapshot.tenantId && inScope.has(cell.poolId) && (resource === 'all' || cell.resource === resource))
        .sort((a, b) => b.ratio - a.ratio),
    [snapshot, inScope, threshold, resource],
  );
  if (!alerts.length) return <EmptyState title={`Every tenant is under ${Math.round(threshold * 100)}%`} />;
  const fit = Math.max(2, Math.floor(bodyHeight(size.h) / 36));
  return (
    <ul className="flex flex-col gap-2">
      {alerts.slice(0, fit).map((cell) => (
        <li key={`${cell.tenantId}:${cell.poolId}:${cell.resource}`}>
          <Link href={`/quotas?tenant=${cell.tenantId}&resource=${cell.resource}`} className="group block">
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-caption-1-medium group-hover:underline">{tenantName(cell.tenantId)}</span>
              <span className="font-mono text-[11px] tabular-nums text-text-secondary">
                {fmtNum(cell.used)}/{fmtNum(cell.max)} {cell.resource}
              </span>
            </div>
            <div className="mt-1 h-1 bg-background-secondary-default">
              <div className="h-full" style={{ width: `${cell.ratio * 100}%`, background: cell.level === 'full' ? 'var(--color-red-500)' : 'var(--color-signal-fill)' }} />
            </div>
            <span className="font-mono text-[10px] text-text-tertiary">{cell.poolId}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function SpendWidget({ size, settings }: WidgetProps) {
  const { snapshot, rows } = usePoolRows();
  const tenantName = useTenantName();
  const inScope = useMemo(() => new Set(rows.map((row) => row.id)), [rows]);
  const daysBack = Number(settings.days ?? 30);
  const group = String(settings.group ?? 'tenant');
  const from = snapshot.now - daysBack * DAY;
  const windows = useMemo(() => snapshot.usage.filter((w) => w.windowStart >= from && inScope.has(w.tags.poolId ?? '')), [snapshot.usage, from, inScope]);
  const days = useMemo(() => dailySpend(windows, snapshot.prices, from, snapshot.now), [windows, snapshot.prices, from, snapshot.now]);
  const tenants = useMemo(
    () => rollup(windows, (w) => (group === 'project' ? w.tags.project || '(none)' : group === 'pool' ? w.tags.poolId ?? '' : group === 'meter' ? w.meter : w.tags.tenantId ?? ''), snapshot.prices),
    [windows, snapshot.prices, group],
  );
  const label = (key: string) => (group === 'tenant' ? tenantName(key) : key);
  const total = tenants.reduce((sum, entry) => sum + entry.cost, 0);
  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-end justify-between gap-3">
        <Stat label={`${daysBack}-day spend`} value={fmtMoney(total, { short: true })} hint="estimated at list" />
        <div className="w-1/2">
          <Sparkline values={days.cost} height={40} />
        </div>
      </div>
      {size.h >= 3 && (
        <ul className="flex flex-col gap-1.5">
          {tenants.slice(0, Math.max(2, size.h * 2 - 3)).map((entry) => (
            <li key={entry.key} className="grid grid-cols-[8rem_1fr_4.5rem] items-center gap-2">
              <span className="truncate text-caption-1-regular">{label(entry.key)}</span>
              <div className="h-1.5 bg-background-secondary-default">
                <div className="h-full bg-signal-fill" style={{ width: `${(entry.cost / (tenants[0]?.cost || 1)) * 100}%` }} />
              </div>
              <span className="text-right font-mono text-[11px] tabular-nums">{fmtMoney(entry.cost, { short: true })}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Capacity insights, most severe first; compact below 4 rows. */
export function InsightsWidget({ size }: WidgetProps) {
  return (
    <div className="-m-3">
      <InsightList compact={size.h < 4} limit={Math.max(2, Math.floor(bodyHeight(size.h) / (size.h < 4 ? 36 : 64)))} />
    </div>
  );
}

/** Spot work per pool: GPUs on spot now, preemption notices, 30-day savings. */
export function SpotWidget({ size }: WidgetProps) {
  return (
    <div className="-m-3">
      <SpotList limit={Math.max(2, Math.floor(bodyHeight(size.h) / 30) - 1)} />
    </div>
  );
}

const FINDER_GPUS = ['1', '8', '16', '32', '64'] as const;
const FINDER_DURATIONS = { '4h': 4 * HOUR, '1d': DAY, '3d': 3 * DAY, '7d': 7 * DAY } as const;

/** "Where can I get N GPUs for D?" across every pool, answered from the timelines. */
export function FinderWidget({ size, settings }: WidgetProps) {
  const { snapshot, rows } = usePoolRows();
  const [gpus, setGpus] = useState<(typeof FINDER_GPUS)[number]>((String(settings.gpus ?? '8') as (typeof FINDER_GPUS)[number]) ?? '8');
  const [duration, setDuration] = useState<keyof typeof FINDER_DURATIONS>((String(settings.duration ?? '1d') as keyof typeof FINDER_DURATIONS) ?? '1d');
  // The instance's settings are the defaults; the chips change them for this view only.
  useEffect(() => setGpus(String(settings.gpus ?? '8') as (typeof FINDER_GPUS)[number]), [settings.gpus]);
  useEffect(() => setDuration(String(settings.duration ?? '1d') as keyof typeof FINDER_DURATIONS), [settings.duration]);
  const { hour, to } = useHourWindow(0, 7 * 24);
  const model = String(settings.model ?? 'all');
  const gpuRows = useMemo(() => rows.filter((row) => row.unit === 'gpu' && (model === 'all' || row.short === model)), [rows, model]);
  const timelines = useTimelines(
    gpuRows.map((row) => row.id),
    hour,
    to,
  );
  const results = useMemo(
    () =>
      gpuRows
        .map((row) => {
          const timeline = timelines.get(row.id);
          const start = timeline ? earliestFit(timeline, Number(gpus), FINDER_DURATIONS[duration], { notBefore: hour }) : undefined;
          return { row, start };
        })
        .sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity) || a.row.price - b.row.price),
    [gpuRows, timelines, gpus, duration, hour],
  );
  const fit = Math.max(2, Math.floor((bodyHeight(size.h) - 40) / 28));
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented label="GPUs" value={gpus} onChange={(value) => setGpus(value as typeof gpus)} options={FINDER_GPUS.map((id) => ({ id, label: id }))} />
        <Segmented label="For" value={duration} onChange={(value) => setDuration(value as keyof typeof FINDER_DURATIONS)} options={(Object.keys(FINDER_DURATIONS) as (keyof typeof FINDER_DURATIONS)[]).map((id) => ({ id, label: id }))} />
      </div>
      <ul>
        {results.slice(0, fit).map(({ row, start }) => (
          <li key={row.id} className="flex items-center gap-2 border-b border-separator-border py-1 last:border-0">
            <Link href={`/reservations/new?pool=${row.id}`} className="min-w-0 flex-1 truncate text-caption-1-regular hover:underline">
              {row.name} <span className="font-mono text-[10px] text-text-tertiary">{row.short} · {row.siteId}</span>
            </Link>
            <span className="font-mono text-[11px] tabular-nums text-text-tertiary">{fmtMoney(row.price * Number(gpus) * (FINDER_DURATIONS[duration] / HOUR), { short: true })}</span>
            {start === undefined ? <Tag status="off">&gt; 7 d</Tag> : start <= snapshot.now + HOUR ? <Tag status="live">now</Tag> : <Tag status="ok" led={false}>{fmtRelative(start, snapshot.now)}</Tag>}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PressureWidget({ size, settings }: WidgetProps) {
  const { snapshot, rows } = usePoolRows();
  const { hour, to } = useHourWindow(0, 7 * 24);
  const gpus = Number(settings.gpus ?? 8);
  const hours = Number(settings.hours ?? 24);
  const gpuRows = useMemo(() => rows.filter((row) => row.unit === 'gpu'), [rows]);
  const timelines = useTimelines(
    gpuRows.map((row) => row.id),
    hour,
    to,
  );
  const list = useMemo(
    () =>
      gpuRows
        .flatMap((row) => {
          const timeline = timelines.get(row.id);
          return timeline ? [{ row, ...pressure(row, timeline, snapshot.now, gpus, hours * HOUR) }] : [];
        })
        .sort((a, b) => (b.waitMs ?? Infinity) - (a.waitMs ?? Infinity)),
    [gpuRows, timelines, snapshot.now, gpus, hours],
  );
  const fit = Math.max(2, Math.floor(bodyHeight(size.h) / 28));
  return (
    <ul>
      {list.slice(0, fit).map(({ row, start, waitMs }) => (
        <li key={row.id} className="flex items-center gap-2 border-b border-separator-border py-1 last:border-0">
          <Link href={`/pools/${row.id}`} className="min-w-0 flex-1 truncate text-caption-1-regular hover:underline">
            {row.name}
          </Link>
          <Mono dim className="text-[11px]">
            {fmtNum(row.freeNow)} free
          </Mono>
          {start === undefined ? <Tag status="crit">none 7 d</Tag> : waitMs! < HOUR ? <Tag status="ok">{gpus}×{hours}h now</Tag> : <Tag status={waitMs! > DAY ? 'warn' : 'ok'}>in {fmtDuration(waitMs!)}</Tag>}
        </li>
      ))}
    </ul>
  );
}
