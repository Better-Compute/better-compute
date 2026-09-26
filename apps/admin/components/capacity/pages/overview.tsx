'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { RiAddLine, RiArrowRightUpLine, RiBarChartBoxLine, RiCalendarScheduleLine, RiFileTextLine, RiLightbulbFlashLine, RiLineChartLine, RiTimerLine } from 'react-icons/ri';
import { HourDrawer } from '../hour-drawer';
import { Holders, UpcomingList } from '../upcoming';
import { InsightList } from '../insights';
import { ButtonLink } from '@/components/base/buttons/button';
import { Legend, Sparkline, StackedBar, TimeSeriesChart } from '@/components/ui/charts';
import { EmptyState, Grid, PageHeader, Panel } from '@/components/ui/panel';
import { Mono, Tag } from '@/components/ui/signal';
import { Stat } from '@/components/ui/stat';
import { fmtDuration, fmtMoney, fmtNum, fmtPct, fmtRelative, fmtStamp } from '@/lib/data/format';
import { reservationGpus } from '@/lib/data/capacity';
import { DAY, HOUR, useHourWindow, usePoolRows, useTenantName, useTimelines } from '../data';
import { SourceNotice } from '../source-notice';
import { CapacityHeatmap, HeatmapTable } from '../heatmap';
import { byModel, costOf, fleetSeries, fleetTotals, heatMatrix, pressure, quotaCells, runway, type PoolRow } from '../model';
import { HeatLegend, planHref, Segmented, StateTag, utcDay } from '../ui';
import { Term } from '../term';

const SPANS = {
  '3d': { back: 24, ahead: 72, label: '−1d / +3d' },
  '7d': { back: 48, ahead: 168, label: '−2d / +7d' },
  '14d': { back: 168, ahead: 168, label: '−7d / +7d' },
} as const;
type SpanKey = keyof typeof SPANS;

/**
 * Per pool: the last 14 days of daily booked share, its trend in points per week, and when the trend would reach
 * 95%. Planning signal for "order hardware now or later".
 */
function RunwayPanel({ rows }: { rows: PoolRow[] }) {
  const { from, hour } = useHourWindow(14 * 24, 0);
  const timelines = useTimelines(
    rows.map((row) => row.id),
    from,
    hour,
  );
  const list = useMemo(
    () =>
      rows
        .map((row) => {
          const timeline = timelines.get(row.id);
          return { row, ...(timeline ? runway(timeline) : { daily: [] as number[], slopePerWeek: 0, current: 0, daysToCeiling: undefined }) };
        })
        .sort((a, b) => (a.daysToCeiling ?? Infinity) - (b.daysToCeiling ?? Infinity) || b.slopePerWeek - a.slopePerWeek),
    [rows, timelines],
  );
  return (
    <Panel className="col-span-12 lg:col-span-6" title="Runway" icon={RiLineChartLine} meta="14-day trend → 95% booked" flush>
      <table className="w-full text-body-regular">
        <thead>
          <tr className="border-b border-separator-border font-mono text-[11px] tracking-wide text-text-tertiary uppercase">
            <th className="px-3 py-2 text-left font-normal">Pool</th>
            <th className="px-3 py-2 text-left font-normal">Daily booked, 14 d</th>
            <th className="px-3 py-2 text-right font-normal">Trend</th>
            <th className="px-3 py-2 text-right font-normal">95% in</th>
          </tr>
        </thead>
        <tbody>
          {list.map(({ row, daily, slopePerWeek, daysToCeiling }) => (
            <tr key={row.id} className="border-b border-separator-border last:border-0">
              <td className="px-3 py-1.5">
                <Link href={`/pools/${row.id}`} className="text-caption-1-medium hover:underline">
                  {row.name}
                </Link>
              </td>
              <td className="w-32 px-3 py-1.5">
                <Sparkline values={daily} height={18} max={1} min={0} area={false} />
              </td>
              <td className="px-3 py-1.5 text-right font-mono text-[12px] tabular-nums">
                <span className={slopePerWeek > 0.02 ? 'text-signal' : 'text-text-secondary'}>
                  {slopePerWeek >= 0 ? '+' : '−'}
                  {Math.abs(slopePerWeek * 100).toFixed(1)} pt/wk
                </span>
              </td>
              <td className="px-3 py-1.5 text-right">
                {daysToCeiling === undefined ? (
                  <span className="font-mono text-[11px] text-text-tertiary">not at this trend</span>
                ) : daysToCeiling === 0 ? (
                  <Tag status="crit">already</Tag>
                ) : (
                  <Tag status={daysToCeiling < 30 ? 'warn' : 'ok'} led={daysToCeiling < 30}>
                    {Math.round(daysToCeiling)} d
                  </Tag>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="px-3 py-2 font-mono text-[10px] text-text-tertiary">least-squares line through daily averages; extrapolates the recent weeks, not a promise</p>
    </Panel>
  );
}

/** Capacity: what exists, what is booked now and ahead, where it is tight, and what's next. */
export function CapacityOverviewPage() {
  const router = useRouter();
  const { snapshot, rows } = usePoolRows();
  const tenantName = useTenantName();
  const [span, setSpan] = useState<SpanKey>('7d');
  const [heatView, setHeatView] = useState<'chart' | 'table'>('chart');
  const [cell, setCell] = useState<{ poolId: string; t: number } | undefined>();
  const { from, to, hour } = useHourWindow(SPANS[span].back, SPANS[span].ahead);
  const gpuRows = useMemo(() => rows.filter((row) => row.unit === 'gpu'), [rows]);
  const timelines = useTimelines(
    gpuRows.map((row) => row.id),
    from,
    to,
  );
  const matrix = useMemo(() => heatMatrix(gpuRows, timelines, from, HOUR, (to - from) / HOUR), [gpuRows, timelines, from, to]);
  const totals = useMemo(() => fleetTotals(rows), [rows]);
  const series = useMemo(() => fleetSeries([...timelines.values()]), [timelines]);
  const models = useMemo(() => byModel(rows), [rows]);

  const ahead = useMemo(() => {
    let peak = { ratio: 0, t: hour };
    series.times.forEach((t, index) => {
      if (t < hour) return;
      const ratio = series.allocatable[index] ? series.booked[index]! / series.allocatable[index]! : 0;
      if (ratio > peak.ratio) peak = { ratio, t };
    });
    return peak;
  }, [series, hour]);

  const pressures = useMemo(
    () =>
      gpuRows
        // Live timelines arrive one by one: pools without one yet are left out until it does.
        .flatMap((row) => {
          const timeline = timelines.get(row.id);
          return timeline ? [{ row, ...pressure(row, timeline, snapshot.now, 8, DAY) }] : [];
        })
        .sort((a, b) => (b.waitMs ?? Infinity) - (a.waitMs ?? Infinity)),
    [gpuRows, timelines, snapshot.now],
  );

  const poolIds = useMemo(() => new Set(rows.map((row) => row.id)), [rows]);
  const alerts = useMemo(
    () =>
      quotaCells(snapshot.quotas)
        .filter((cell) => cell.level !== 'ok' && poolIds.has(cell.poolId) && cell.tenantId !== snapshot.tenantId)
        .sort((a, b) => b.ratio - a.ratio)
        .slice(0, 8),
    [snapshot, poolIds],
  );

  const spend30 = useMemo(
    () => snapshot.usage.filter((window) => poolIds.has(window.tags.poolId ?? '')).reduce((total, window) => total + costOf(window, snapshot.prices), 0),
    [snapshot, poolIds],
  );
  const upcoming24 = useMemo(
    () => snapshot.reservations.filter((r) => r.state === 'placed' && r.during && r.during.start < snapshot.now + DAY && poolIds.has(r.poolId)).length,
    [snapshot, poolIds],
  );

  return (
    <>
      <SourceNotice />
      <PageHeader
        icon={RiBarChartBoxLine}
        title="Capacity"
        description={`${fmtNum(totals.allocated)} of ${fmtNum(totals.allocatable)} schedulable GPUs are allocated (${fmtPct(totals.utilization, 0)}) and ${fmtNum(totals.freeNow)} are free right now. Bookings peak at ${fmtPct(ahead.ratio, 0)} ${ahead.t <= snapshot.now ? 'this hour' : `${fmtRelative(ahead.t, snapshot.now)} (${fmtStamp(ahead.t)} UTC)`}.`}
        meta={
          <>
            <Tag status={snapshot.source === 'sim' ? 'pending' : 'live'}>{snapshot.source === 'sim' ? 'simulated' : 'live'}</Tag>
            <Tag status="ok" led={false}>
              {totals.pools} pools · {fmtNum(totals.gpus)} GPUs · {fmtNum(totals.vcpus.total)} vCPUs
            </Tag>
            {totals.pending > 0 && <Tag status="pending">{totals.pending} waiting for capacity</Tag>}
          </>
        }
        actions={
          <>
            <ButtonLink href="/capacity/report" size="small" variant="secondary" leadingIcon={RiFileTextLine}>
              Report
            </ButtonLink>
            <ButtonLink href="/reservations/new" size="small" leadingIcon={RiAddLine}>
              Plan a reservation
            </ButtonLink>
          </>
        }
      />

      <Grid>
        <Panel className="col-span-12" bodyClassName="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 xl:grid-cols-6">
          <Stat label={<Term id="schedulable">Schedulable GPUs</Term>} value={fmtNum(totals.allocatable)} unit={`/ ${fmtNum(totals.gpus)}`} hint={`${fmtNum(totals.unavailable)} out of service`} />
          <Stat label={<Term id="allocated">Allocated now</Term>} value={fmtPct(totals.utilization, 0)} unit={`${fmtNum(totals.allocated)} GPUs`} trend={series.booked.slice(0, Math.max(2, series.times.findIndex((t) => t >= hour) + 1))} />
          <Stat label={<Term id="freeNow">Free now</Term>} value={fmtNum(totals.freeNow)} unit="GPUs" hint={`${fmtNum(totals.reserved)} of them booked later`} tone="neutral" />
          <Stat label="Starting in 24 h" value={fmtNum(upcoming24)} unit="reservations" hint={`peak ${fmtPct(ahead.ratio, 0)} ${ahead.t <= snapshot.now ? 'this hour' : fmtRelative(ahead.t, snapshot.now)}`} />
          <Stat label={<Term id="pending">Waiting</Term>} value={fmtNum(totals.pending)} unit="pending" hint="need capacity or a confirmation" tone="neutral" />
          <Stat label={<Term id="spend">Spend, 30 days</Term>} value={fmtMoney(spend30, { short: true })} hint="estimated at list price" tone="neutral" />
        </Panel>

        <Panel className="col-span-12" title="Insights" icon={RiLightbulbFlashLine} flush>
          <InsightList limit={4} />
        </Panel>

        <Panel
          className="col-span-12"
          title="Bookings by pool and hour"
          icon={RiCalendarScheduleLine}
          meta={`${fmtStamp(from)} → ${fmtStamp(to)} UTC`}
        >
          {/* Controls live in the body, where they can wrap on a phone; a panel header can't. */}
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <Segmented
              label="Heatmap span"
              value={span}
              onChange={setSpan}
              options={(Object.keys(SPANS) as SpanKey[]).map((id) => ({ id, label: SPANS[id].label }))}
            />
            <Segmented
              label="Show as"
              value={heatView}
              onChange={setHeatView}
              options={[
                { id: 'chart', label: 'Chart' },
                { id: 'table', label: 'Table' },
              ]}
            />
          </div>
          {matrix.rows.length && heatView === 'table' ? (
            <HeatmapTable matrix={matrix} now={snapshot.now} />
          ) : matrix.rows.length ? (
            <>
              <CapacityHeatmap
                matrix={matrix}
                now={snapshot.now}
                onSelect={(poolId, t) => setCell({ poolId, t })}
                onRange={(poolId, start, end) => router.push(planHref(poolId, start, end))}
              />
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <HeatLegend />
                <span className="font-mono text-[10px] text-text-tertiary">left of NOW: history · right: the reservation book · click a cell for who holds it · drag along a row to plan a reservation there</span>
              </div>
            </>
          ) : (
            <EmptyState title="No GPU pools in this scope" />
          )}
        </Panel>

        <Panel className="col-span-12 xl:col-span-8" title="Fleet bookings vs schedulable GPUs" meta="hourly">
          <TimeSeriesChart
            times={series.times}
            height={220}
            series={[
              { id: 'booked', label: 'Booked GPUs', values: series.booked, tone: 'signal', area: true },
              { id: 'allocatable', label: 'Schedulable', values: series.allocatable, tone: 'neutral', dashed: true },
            ]}
            yMax={Math.max(1, ...series.allocatable) * 1.12}
            xFormat={(t) => `${utcDay(t)} ${new Date(t).toISOString().slice(11, 13)}h`}
            markers={[{ t: snapshot.now, label: 'now', tone: 'neutral' }]}
          />
          <Legend
            className="mt-2"
            items={[
              { label: 'booked GPUs', tone: 'signal' },
              { label: 'schedulable GPUs (dashed)', tone: 'neutral' },
            ]}
          />
        </Panel>

        <Panel className="col-span-12 xl:col-span-4" title="By GPU model" meta={`${models.length} models`}>
          <ul className="flex flex-col gap-3">
            {models.map((model) => (
              <li key={model.short}>
                <div className="mb-1 flex items-baseline justify-between gap-2">
                  <span className="font-mono text-[12px] text-text-primary">{model.short}</span>
                  <span className="font-mono text-[11px] tabular-nums text-text-tertiary">
                    {fmtNum(model.allocated)} / {fmtNum(model.allocatable)} · {fmtNum(model.freeNow)} free
                  </span>
                </div>
                <StackedBar
                  height={8}
                  total={model.total}
                  parts={[
                    { label: 'allocated', value: model.allocated, tone: 'signal' },
                    { label: 'free', value: model.freeNow, tone: 'muted' },
                    { label: 'out of service', value: model.total - model.allocatable, tone: 'hatch' },
                  ]}
                />
              </li>
            ))}
          </ul>
          <Legend
            className="mt-4"
            items={[
              { label: 'allocated', tone: 'signal' },
              { label: 'free', tone: 'muted' },
              { label: 'out of service', tone: 'hatch' },
            ]}
          />
        </Panel>

        <Panel className="col-span-12 lg:col-span-6" title="Where it is tight" icon={RiTimerLine} meta="earliest 8 GPUs for 24 h" flush>
          <table className="w-full text-body-regular">
            <thead>
              <tr className="border-b border-separator-border font-mono text-[11px] tracking-wide text-text-tertiary uppercase">
                <th className="px-3 py-2 text-left font-normal">Pool</th>
                <th className="px-3 py-2 text-right font-normal">Free now</th>
                <th className="px-3 py-2 text-right font-normal">Next 8×24h</th>
              </tr>
            </thead>
            <tbody>
              {pressures.map(({ row, start, waitMs }) => (
                <tr key={row.id} className="border-b border-separator-border last:border-0 hover:bg-background-secondary-default">
                  <td className="px-3 py-1.5">
                    <Link href={`/pools/${row.id}`} className="font-mono text-[12px] text-text-primary hover:underline">
                      {row.name}
                    </Link>
                    <span className="ml-2 font-mono text-[11px] text-text-tertiary">{row.short}</span>
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums">{fmtNum(row.freeNow)}</td>
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                    {start === undefined ? (
                      <Tag status="crit">none in 7 d</Tag>
                    ) : waitMs! < HOUR ? (
                      <Tag status="ok">now</Tag>
                    ) : (
                      <Tag status={waitMs! > DAY ? 'warn' : 'ok'} led={waitMs! > DAY}>
                        in {fmtDuration(waitMs!)}
                      </Tag>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <RunwayPanel rows={gpuRows} />

        <Panel className="col-span-12 lg:col-span-6" title="Next 6 hours" meta="starts and ends" flush bodyClassName="max-h-[340px] overflow-y-auto">
          <UpcomingList hours={6} />
        </Panel>

        <Panel
          className="col-span-12 lg:col-span-6"
          title="Tenants near quota"
          meta={`${alerts.length} at ≥80%`}
          actions={
            <Link href="/quotas" className="inline-flex items-center gap-1 font-mono text-[11px] text-signal hover:underline">
              quotas <RiArrowRightUpLine className="size-3.5" aria-hidden />
            </Link>
          }
        >
          {alerts.length ? (
            <ul className="flex flex-col gap-2.5">
              {alerts.map((cell) => (
                <li key={`${cell.tenantId}:${cell.poolId}:${cell.resource}`} className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1">
                  <span className="truncate text-caption-1-medium text-text-primary">
                    {tenantName(cell.tenantId)} <span className="font-mono text-[11px] text-text-tertiary">· {cell.poolId} · {cell.resource}</span>
                  </span>
                  <span className="font-mono text-[11px] tabular-nums text-text-secondary">
                    {fmtNum(cell.used)} / {fmtNum(cell.max)}
                  </span>
                  <div className="col-span-2 h-1.5 bg-background-secondary-default">
                    <div className="h-full" style={{ width: `${cell.ratio * 100}%`, background: cell.level === 'full' ? 'var(--color-red-500)' : 'var(--color-signal-fill)' }} />
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="Every tenant is under 80% of its quota" />
          )}
        </Panel>

        <Panel className="col-span-12 lg:col-span-6" title="Who holds GPUs now">
          <Holders limit={12} />
          <p className="mt-3 text-caption-1-regular text-text-tertiary">
            GPUs of active reservations. <StateTag state="active" className="ml-1" />
          </p>
        </Panel>
      </Grid>
      <HourDrawer target={cell} onClose={() => setCell(undefined)} />
    </>
  );
}
