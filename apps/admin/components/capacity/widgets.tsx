'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
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
import { byModel, costOf, dailySpend, fleetSeries, fleetTotals, heatMatrix, pressure, quotaCells, rollup } from './model';
import { Segmented } from './ui';

// Dashboard widgets of the capacity module. Each renders only its body (the shell's WidgetFrame draws the title
// bar, menu and resize handle) and adapts to its grid size: 12 columns, 80 px rows.

const bodyHeight = (h: number) => h * 80 - 48;

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
  const cols = size.w >= 10 ? 'grid-cols-5' : size.w >= 6 ? 'grid-cols-3' : 'grid-cols-2';
  return (
    <div className={cx('grid gap-x-5 gap-y-3', cols)}>
      <Stat size="sm" label="GPUs allocated" value={fmtPct(totals.utilization, 0)} unit={`${fmtNum(totals.allocated)}/${fmtNum(totals.allocatable)}`} trend={size.h >= 2 ? trend : undefined} />
      <Stat size="sm" label="Free now" value={fmtNum(totals.freeNow)} unit="GPUs" tone="neutral" />
      <Stat size="sm" label="Booked later" value={fmtNum(totals.reserved)} unit="atoms" tone="neutral" />
      {size.w >= 6 && <Stat size="sm" label="Pending" value={fmtNum(totals.pending)} tone="neutral" />}
      {size.w >= 10 && <Stat size="sm" label="Spend, 24 h" value={fmtMoney(spend, { short: true })} tone="neutral" />}
    </div>
  );
}

export function CapacityHeatmapWidget({ size }: WidgetProps) {
  const router = useRouter();
  const { snapshot, rows } = usePoolRows();
  const back = size.w >= 8 ? 24 : 12;
  const ahead = size.w >= 8 ? 96 : 48;
  const { from, to } = useHourWindow(back, ahead);
  const gpuRows = useMemo(() => rows.filter((row) => row.unit === 'gpu'), [rows]);
  const timelines = useTimelines(
    gpuRows.map((row) => row.id),
    from,
    to,
  );
  const matrix = useMemo(() => heatMatrix(gpuRows, timelines, from, HOUR, (to - from) / HOUR), [gpuRows, timelines, from, to]);
  if (!matrix.rows.length) return <EmptyState title="No GPU pools in scope" />;
  const rowHeight = Math.max(12, Math.min(24, Math.floor((bodyHeight(size.h) - 30) / matrix.rows.length)));
  return <CapacityHeatmap matrix={matrix} now={snapshot.now} rowHeight={rowHeight} compact={size.w < 8} onSelect={(poolId) => router.push(`/pools/${poolId}`)} />;
}

export function PoolsWidget({ size }: WidgetProps) {
  const { rows } = usePoolRows();
  const sorted = useMemo(() => [...rows].sort((a, b) => b.utilization - a.utilization), [rows]);
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

export function UpcomingWidget({ size }: WidgetProps) {
  const { snapshot, rows } = usePoolRows();
  const tenantName = useTenantName();
  const inScope = useMemo(() => new Set(rows.map((row) => row.id)), [rows]);
  const events = useMemo(() => {
    const until = snapshot.now + 12 * HOUR;
    const list: { t: number; kind: 'starts' | 'ends'; id: string; tenantId: string; gpus: number; poolId: string }[] = [];
    for (const r of snapshot.reservations) {
      if (!r.during || !inScope.has(r.poolId)) continue;
      if (r.state === 'placed' && r.during.start > snapshot.now && r.during.start < until) list.push({ t: r.during.start, kind: 'starts', id: r.id, tenantId: r.tenantId, gpus: reservationGpus(r), poolId: r.poolId });
      if (r.state === 'active' && r.during.end > snapshot.now && r.during.end < until) list.push({ t: r.during.end, kind: 'ends', id: r.id, tenantId: r.tenantId, gpus: reservationGpus(r), poolId: r.poolId });
    }
    return list.sort((a, b) => a.t - b.t);
  }, [snapshot, inScope]);
  const fit = Math.max(3, Math.floor(bodyHeight(size.h) / 28));
  if (!events.length) return <EmptyState title="Nothing starts or ends in 12 h" />;
  return (
    <ul>
      {events.slice(0, fit).map((event) => (
        <li key={`${event.id}:${event.kind}`} className="flex items-center gap-2 border-b border-separator-border py-1 last:border-0">
          <span className="w-12 shrink-0 font-mono text-[11px] tabular-nums text-text-tertiary">{fmtRelative(event.t, snapshot.now)}</span>
          <Tag status={event.kind === 'starts' ? 'pending' : 'ok'} led={event.kind === 'starts'}>
            {event.kind}
          </Tag>
          <Link href={`/reservations?id=${event.id}`} className="min-w-0 flex-1 truncate text-caption-1-regular hover:underline">
            {tenantName(event.tenantId)} <span className="font-mono text-[10px] text-text-tertiary">{event.poolId}</span>
          </Link>
          <span className="font-mono text-[11px] tabular-nums">{event.gpus}</span>
        </li>
      ))}
    </ul>
  );
}

export function QuotaAlertsWidget({ size }: WidgetProps) {
  const { snapshot, rows } = usePoolRows();
  const tenantName = useTenantName();
  const inScope = useMemo(() => new Set(rows.map((row) => row.id)), [rows]);
  const alerts = useMemo(
    () => quotaCells(snapshot.quotas).filter((cell) => cell.level !== 'ok' && cell.tenantId !== snapshot.tenantId && inScope.has(cell.poolId)).sort((a, b) => b.ratio - a.ratio),
    [snapshot, inScope],
  );
  if (!alerts.length) return <EmptyState title="Every tenant has headroom" />;
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

export function SpendWidget({ size }: WidgetProps) {
  const { snapshot, rows } = usePoolRows();
  const tenantName = useTenantName();
  const inScope = useMemo(() => new Set(rows.map((row) => row.id)), [rows]);
  const from = snapshot.now - 30 * DAY;
  const windows = useMemo(() => snapshot.usage.filter((w) => w.windowStart >= from && inScope.has(w.tags.poolId ?? '')), [snapshot.usage, from, inScope]);
  const days = useMemo(() => dailySpend(windows, snapshot.prices, from, snapshot.now), [windows, snapshot.prices, from, snapshot.now]);
  const tenants = useMemo(() => rollup(windows, (w) => w.tags.tenantId ?? '', snapshot.prices), [windows, snapshot.prices]);
  const total = tenants.reduce((sum, entry) => sum + entry.cost, 0);
  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-end justify-between gap-3">
        <Stat label="30-day spend" value={fmtMoney(total, { short: true })} hint="estimated at list" />
        <div className="w-1/2">
          <Sparkline values={days.cost} height={40} />
        </div>
      </div>
      {size.h >= 3 && (
        <ul className="flex flex-col gap-1.5">
          {tenants.slice(0, Math.max(2, size.h * 2 - 3)).map((entry) => (
            <li key={entry.key} className="grid grid-cols-[8rem_1fr_4.5rem] items-center gap-2">
              <span className="truncate text-caption-1-regular">{tenantName(entry.key)}</span>
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

const FINDER_GPUS = ['1', '8', '16', '32', '64'] as const;
const FINDER_DURATIONS = { '4h': 4 * HOUR, '1d': DAY, '3d': 3 * DAY, '7d': 7 * DAY } as const;

/** "Where can I get N GPUs for D?" across every pool, answered from the timelines. */
export function FinderWidget({ size }: WidgetProps) {
  const { snapshot, rows } = usePoolRows();
  const [gpus, setGpus] = useState<(typeof FINDER_GPUS)[number]>('8');
  const [duration, setDuration] = useState<keyof typeof FINDER_DURATIONS>('1d');
  const { hour, to } = useHourWindow(0, 7 * 24);
  const gpuRows = useMemo(() => rows.filter((row) => row.unit === 'gpu'), [rows]);
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

export function PressureWidget({ size }: WidgetProps) {
  const { snapshot, rows } = usePoolRows();
  const { hour, to } = useHourWindow(0, 7 * 24);
  const gpuRows = useMemo(() => rows.filter((row) => row.unit === 'gpu'), [rows]);
  const timelines = useTimelines(
    gpuRows.map((row) => row.id),
    hour,
    to,
  );
  const list = useMemo(
    () => gpuRows.map((row) => ({ row, ...pressure(row, timelines.get(row.id)!, snapshot.now, 8, DAY) })).sort((a, b) => (b.waitMs ?? Infinity) - (a.waitMs ?? Infinity)),
    [gpuRows, timelines, snapshot.now],
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
          {start === undefined ? <Tag status="crit">none 7 d</Tag> : waitMs! < HOUR ? <Tag status="ok">8×24h now</Tag> : <Tag status={waitMs! > DAY ? 'warn' : 'ok'}>in {fmtDuration(waitMs!)}</Tag>}
        </li>
      ))}
    </ul>
  );
}
