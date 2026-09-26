'use client';

import { useMemo, useRef, useState } from 'react';
import { usePageCommands } from '@/components/shell/page-commands';
import { RiDownloadLine, RiMoneyDollarCircleLine, RiRefreshLine } from 'react-icons/ri';
import { usageCsv } from '@better-compute/console-kit';
import { Button } from '@/components/base/buttons/button';
import { useWidth } from '@/components/ui/charts';
import { Grid, PageHeader, Panel } from '@/components/ui/panel';
import { Tag } from '@/components/ui/signal';
import { Stat } from '@/components/ui/stat';
import { fmtMoney, fmtNum, fmtPct } from '@/lib/data/format';
import type { UsageWindow } from '@/lib/data/capacity';
import { cx } from '@/utils/cx';
import { DAY, useCapacity, usePoolRows, useTenantName } from '../data';
import { dailySpend, rollup } from '../model';
import { HoverCard, HoverRow, Segmented, utcDay } from '../ui';

const RANGES = { '7d': 7, '14d': 14, '30d': 30 } as const;
type RangeKey = keyof typeof RANGES;
type GroupKey = 'tenant' | 'project' | 'pool' | 'meter' | 'identity';

/** Daily columns, one series (cost), hover readout and the busiest day labelled. */
function SpendColumns({ times, values, secondary }: { times: number[]; values: number[]; secondary: number[] }) {
  const [ref, width] = useWidth<HTMLDivElement>(700);
  const [hover, setHover] = useState<number | null>(null);
  const height = 200;
  const padL = 48;
  const padB = 20;
  const plotW = Math.max(40, width - padL);
  const plotH = height - padB - 8;
  const max = Math.max(1, ...values) * 1.1;
  const magnitude = 10 ** Math.floor(Math.log10(max));
  const top = Math.ceil(max / magnitude) * magnitude;
  const slot = plotW / Math.max(1, values.length);
  const barW = Math.min(24, slot - 2);
  const peak = values.indexOf(Math.max(...values));
  return (
    <div ref={ref} className="relative" style={{ height }} onPointerLeave={() => setHover(null)}>
      <svg width={width} height={height} className="block" role="img" aria-label="Estimated spend per day">
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={padL} x2={width} y1={8 + plotH - f * plotH} y2={8 + plotH - f * plotH} stroke="var(--color-separator-border)" />
            <text x={padL - 6} y={8 + plotH - f * plotH + 3} textAnchor="end" className="fill-text-tertiary font-mono text-[10px]">
              {fmtMoney(top * f, { short: true })}
            </text>
          </g>
        ))}
        {values.map((value, index) => {
          const h = (value / top) * plotH;
          const x = padL + index * slot + (slot - barW) / 2;
          return (
            <g key={times[index]} onPointerEnter={() => setHover(index)}>
              <rect x={padL + index * slot} y={0} width={slot} height={height} fill="transparent" />
              <path
                d={`M${x},${8 + plotH}V${8 + plotH - h + Math.min(3, h)}q0,-3 3,-3h${barW - 6}q3,0 3,3V${8 + plotH}Z`}
                fill="var(--color-signal-fill)"
                opacity={hover === null || hover === index ? 1 : 0.45}
              />
              {(index % Math.ceil(values.length / 10) === 0 || index === values.length - 1) && (
                <text x={x + barW / 2} y={height - 5} textAnchor="middle" className="fill-text-tertiary font-mono text-[10px]">
                  {utcDay(times[index]!)}
                </text>
              )}
              {index === peak && hover === null && (
                <text x={x + barW / 2} y={8 + plotH - h - 4} textAnchor="middle" className="fill-text-secondary font-mono text-[10px]">
                  {fmtMoney(value, { short: true })}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {hover !== null && (
        <HoverCard x={padL + hover * slot + slot / 2} y={10} containerWidth={width}>
          <div className="mb-1 font-mono text-[10px] text-text-tertiary">{utcDay(times[hover]!)} (UTC day)</div>
          <HoverRow label="Estimated spend" value={fmtMoney(values[hover]!)} />
          <HoverRow label="GPU-hours" value={fmtNum(secondary[hover]!)} />
        </HoverCard>
      )}
    </div>
  );
}

/** ⌘K "This page" commands; the latest handlers are read through a ref so the list registers once. */
function UsageCommands(handlers: { onRange(range: RangeKey): void; onGroup(group: GroupKey): void; onExport(): void; onResetPrices(): void }) {
  const ref = useRef(handlers);
  ref.current = handlers;
  usePageCommands(
    useMemo(
      () => [
        { id: 'usage.export', label: 'Export these usage windows as CSV', group: 'This page', icon: RiDownloadLine, run: () => ref.current.onExport() },
        ...(Object.keys(RANGES) as RangeKey[]).map((range) => ({ id: `usage.range.${range}`, label: `Usage over the last ${range}`, group: 'This page', run: () => ref.current.onRange(range) })),
        ...(['tenant', 'project', 'pool', 'meter', 'identity'] as GroupKey[]).map((group) => ({ id: `usage.group.${group}`, label: `Break spend down by ${group === 'identity' ? 'person' : group}`, group: 'This page', run: () => ref.current.onGroup(group) })),
        { id: 'usage.prices', label: 'Back to list prices', group: 'This page', icon: RiRefreshLine, run: () => ref.current.onResetPrices() },
      ],
      [],
    ),
  );
  return null;
}

/** Usage windows (usage.list) summed and priced: where the money goes, by tenant, project, pool, meter or person. */
export function UsagePage() {
  const snapshot = useCapacity();
  const { rows } = usePoolRows();
  const tenantName = useTenantName();
  const [range, setRange] = useState<RangeKey>('30d');
  const [group, setGroup] = useState<GroupKey>('tenant');
  const [overrides, setOverrides] = useState<Record<string, number>>({});
  const prices = useMemo(() => ({ ...snapshot.prices, ...overrides }), [snapshot.prices, overrides]);
  const inScope = useMemo(() => new Set(rows.map((row) => row.id)), [rows]);
  const from = snapshot.now - RANGES[range] * DAY;
  const windows = useMemo(
    () => snapshot.usage.filter((window) => window.windowStart >= Math.floor(from / DAY) * DAY && inScope.has(window.tags.poolId ?? '')),
    [snapshot.usage, from, inScope],
  );
  const days = useMemo(() => dailySpend(windows, prices, from, snapshot.now), [windows, prices, from, snapshot.now]);
  const identityName = useMemo(() => {
    const names = new Map(snapshot.identities.map((identity) => [identity.id, identity.name]));
    return (id: string) => names.get(id) ?? id;
  }, [snapshot.identities]);

  const keyOf: Record<GroupKey, (window: UsageWindow) => string> = {
    tenant: (w) => w.tags.tenantId ?? '(none)',
    project: (w) => `${w.tags.tenantId ?? ''}/${w.tags.project || '(none)'}`,
    pool: (w) => w.tags.poolId ?? '(none)',
    meter: (w) => w.meter,
    identity: (w) => w.identityId ?? '(none)',
  };
  const labelOf: Record<GroupKey, (key: string) => string> = {
    tenant: tenantName,
    project: (key) => `${tenantName(key.split('/')[0]!)} · ${key.split('/')[1]}`,
    pool: (key) => key,
    meter: (key) => key,
    identity: identityName,
  };
  const breakdown = useMemo(() => rollup(windows, keyOf[group], prices), [windows, group, prices]); // eslint-disable-line react-hooks/exhaustive-deps
  const meters = useMemo(() => rollup(windows, (w) => w.meter, prices), [windows, prices]);
  const total = breakdown.reduce((sum, entry) => sum + entry.cost, 0);
  const gpuHours = windows.filter((w) => w.meter.startsWith('gpu.')).reduce((sum, w) => sum + w.quantity, 0);
  const spotCost = windows.filter((w) => w.tags.spot === 'true').reduce((sum, w) => sum + w.quantity * (prices[w.meter] ?? 0), 0);
  const deadLettered = windows.filter((w) => w.outcome === 'dead-lettered').length;
  const half = Math.floor(days.cost.length / 2);
  const firstHalf = days.cost.slice(0, half).reduce((a, b) => a + b, 0);
  const secondHalf = days.cost.slice(half).reduce((a, b) => a + b, 0);
  const trend = firstHalf ? (secondHalf - firstHalf) / firstHalf : 0;

  const exportCsv = () => {
    const csv = usageCsv(windows);
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `usage-${new Date(from).toISOString().slice(0, 10)}-${new Date(snapshot.now).toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <UsageCommands onRange={setRange} onGroup={setGroup} onExport={exportCsv} onResetPrices={() => setOverrides({})} />
      <PageHeader
        icon={RiMoneyDollarCircleLine}
        title="Usage & spend"
        description="The usage windows compute hands to IAM billing, priced at list (IAM billing holds the real prices and invoices). Edit a unit price below to see what a price change would do."
        meta={
          <>
            <Tag status="ok" led={false}>
              {fmtNum(windows.length)} windows
            </Tag>
            {deadLettered > 0 && <Tag status="crit">{deadLettered} dead-lettered</Tag>}
            {Object.keys(overrides).length > 0 && <Tag status="warn">what-if prices</Tag>}
          </>
        }
        actions={
          <>
            <Segmented label="Range" value={range} onChange={(value) => setRange(value as RangeKey)} options={(Object.keys(RANGES) as RangeKey[]).map((id) => ({ id, label: id }))} />
            <Button size="small" variant="secondary" leadingIcon={RiDownloadLine} onClick={exportCsv}>
              CSV
            </Button>
          </>
        }
      />
      <Grid>
        <Panel className="col-span-12" bodyClassName="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 xl:grid-cols-6">
          <Stat label="Estimated spend" value={fmtMoney(total, { short: true })} delta={trend} goodWhen="up" hint={`second half vs first half of ${range}`} />
          <Stat label="Per day" value={fmtMoney(total / RANGES[range], { short: true })} trend={days.cost} />
          <Stat label="GPU-hours" value={fmtNum(gpuHours, { short: true })} trend={days.gpuHours} tone="neutral" />
          <Stat label="Spot share" value={fmtPct(total ? spotCost / total : 0, 0)} hint="of spend, at 40% of list" tone="neutral" />
          <Stat label="Top tenant" value={breakdown[0] && group === 'tenant' ? labelOf.tenant(breakdown[0].key) : tenantName(rollup(windows, keyOf.tenant, prices)[0]?.key ?? '')} hint="by spend" tone="neutral" size="sm" />
          <Stat label="Dead-lettered" value={fmtNum(deadLettered)} hint={deadLettered ? 'billing refused them: a person must look' : 'none'} tone="neutral" />
        </Panel>

        <Panel className="col-span-12" title="Spend per day" meta="UTC days · estimated">
          <SpendColumns times={days.times} values={days.cost} secondary={days.gpuHours} />
        </Panel>

        <Panel
          className="col-span-12 xl:col-span-7"
          title="Breakdown"
          meta={`${breakdown.length} ${group === 'identity' ? 'people' : `${group}s`}`}
          actions={
            <Segmented
              label="Group by"
              value={group}
              onChange={(value) => setGroup(value as GroupKey)}
              options={[
                { id: 'tenant', label: 'tenant' },
                { id: 'project', label: 'project' },
                { id: 'pool', label: 'pool' },
                { id: 'meter', label: 'meter' },
                { id: 'identity', label: 'person' },
              ]}
            />
          }
          flush
        >
          <ul className="max-h-[440px] overflow-y-auto">
            {breakdown.map((entry) => (
              <li key={entry.key} className="grid grid-cols-[minmax(0,14rem)_1fr_5.5rem_4rem] items-center gap-3 border-b border-separator-border px-3 py-1.5 last:border-0">
                <span className="truncate text-caption-1-medium text-text-primary" title={entry.key}>
                  {labelOf[group](entry.key)}
                </span>
                <div className="h-2 bg-background-secondary-default">
                  <div className="h-full bg-signal-fill" style={{ width: `${(entry.cost / (breakdown[0]?.cost || 1)) * 100}%` }} />
                </div>
                <span className="text-right font-mono text-[12px] tabular-nums">{fmtMoney(entry.cost, { short: true })}</span>
                <span className="text-right font-mono text-[11px] tabular-nums text-text-tertiary">{fmtPct(total ? entry.cost / total : 0, 0)}</span>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel
          className="col-span-12 xl:col-span-5"
          title="Meters and unit prices"
          meta="edit a price to model a change"
          actions={
            Object.keys(overrides).length > 0 && (
              <Button size="xs" variant="ghost" leadingIcon={RiRefreshLine} onClick={() => setOverrides({})}>
                list prices
              </Button>
            )
          }
          flush
        >
          <table className="w-full text-body-regular">
            <thead>
              <tr className="border-b border-separator-border font-mono text-[11px] tracking-wide text-text-tertiary uppercase">
                <th className="px-3 py-2 text-left font-normal">Meter</th>
                <th className="px-3 py-2 text-right font-normal">Quantity</th>
                <th className="px-3 py-2 text-right font-normal">$/unit</th>
                <th className="px-3 py-2 text-right font-normal">Spend</th>
              </tr>
            </thead>
            <tbody>
              {meters.map((entry) => (
                <tr key={entry.key} className="border-b border-separator-border last:border-0">
                  <td className="px-3 py-1.5 font-mono text-[12px]">{entry.key}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-[12px] tabular-nums">{fmtNum(entry.quantity, { short: true })}</td>
                  <td className="px-3 py-1.5 text-right">
                    <input
                      type="number"
                      step={0.001}
                      min={0}
                      value={prices[entry.key] ?? 0}
                      onChange={(event) => setOverrides((current) => ({ ...current, [entry.key]: Math.max(0, Number(event.target.value) || 0) }))}
                      className={cx(
                        'h-7 w-20 border bg-background-primary-default px-1.5 text-right font-mono text-[12px] tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring',
                        entry.key in overrides ? 'border-signal-fill' : 'border-border-button-default',
                      )}
                      aria-label={`Unit price of ${entry.key}`}
                    />
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-[12px] tabular-nums">{fmtMoney(entry.cost, { short: true })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </Grid>
    </>
  );
}
