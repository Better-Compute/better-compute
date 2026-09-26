'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMemo } from 'react';
import { RiArrowLeftLine, RiCloseLine, RiScales2Line } from 'react-icons/ri';
import { ButtonLink } from '@/components/base/buttons/button';
import { Sparkline, StackedBar } from '@/components/ui/charts';
import { Select } from '@/components/ui/overlay';
import { EmptyState, PageHeader, Panel } from '@/components/ui/panel';
import { Tag } from '@/components/ui/signal';
import { fmtMoney, fmtNum, fmtPct } from '@/lib/data/format';
import { reservationGpus } from '@/lib/data/capacity';
import { cx } from '@/utils/cx';
import { useCapacity, useHourWindow, usePoolRows, useTenantName, useTimelines } from '../data';
import { runway, type PoolRow } from '../model';
import { SourceNotice } from '../source-notice';
import { heatFill } from '../ui';

// Pools side by side: the same measures in aligned columns and small multiples (one hue per chart, no legend to
// decode), so "which pool should this workload go to" or "which pool needs hardware" is a glance.

const MAX = 4;

export function ComparePage() {
  const router = useRouter();
  const search = useSearchParams();
  const snapshot = useCapacity();
  const { rows } = usePoolRows();
  const tenantName = useTenantName();
  const ids = useMemo(() => (search.get('ids') ?? '').split(',').filter(Boolean).slice(0, MAX), [search]);
  const chosen = ids.map((id) => rows.find((row) => row.id === id)).filter((row): row is PoolRow => Boolean(row));
  const setIds = (next: string[]) => router.replace(`/pools/compare?ids=${next.slice(0, MAX).join(',')}`, { scroll: false });
  const ahead = useHourWindow(0, 7 * 24);
  const past = useHourWindow(14 * 24, 0);
  const aheadTimelines = useTimelines(
    chosen.map((row) => row.id),
    ahead.hour,
    ahead.to,
  );
  const pastTimelines = useTimelines(
    chosen.map((row) => row.id),
    past.from,
    past.hour,
  );

  const facts = useMemo(
    () =>
      chosen.map((row) => {
        const holders = new Map<string, number>();
        for (const r of snapshot.reservations)
          if (r.poolId === row.id && (r.state === 'active' || r.state === 'binding')) holders.set(r.tenantId, (holders.get(r.tenantId) ?? 0) + reservationGpus(r));
        const future = aheadTimelines.get(row.id);
        const history = pastTimelines.get(row.id);
        return {
          row,
          top: [...holders].sort((a, b) => b[1] - a[1]).slice(0, 3),
          ahead: future ? future.buckets.map((b) => (future.allocatable ? Math.min(1, b.booked / future.allocatable) : 0)) : [],
          trend: history ? runway(history) : undefined,
        };
      }),
    [chosen, snapshot.reservations, aheadTimelines, pastTimelines],
  );

  const addable = rows.filter((row) => !ids.includes(row.id));
  const measures: { label: string; value(fact: (typeof facts)[number]): React.ReactNode; best?: (values: number[]) => number; number?(fact: (typeof facts)[number]): number }[] = [
    { label: 'Model · site', value: (f) => `${f.row.short} · ${f.row.siteId}` },
    { label: 'Class · sharing', value: (f) => `${f.row.pool.class} · ${f.row.pool.sharing}` },
    { label: 'Schedulable', value: (f) => `${fmtNum(f.row.allocatable)} / ${fmtNum(f.row.total)}`, number: (f) => f.row.allocatable, best: (v) => Math.max(...v) },
    { label: 'Allocated now', value: (f) => fmtPct(f.row.utilization, 0), number: (f) => f.row.utilization },
    { label: 'Free now', value: (f) => fmtNum(f.row.freeNow), number: (f) => f.row.freeNow, best: (v) => Math.max(...v) },
    { label: 'Pending', value: (f) => fmtNum(f.row.pending), number: (f) => f.row.pending },
    { label: 'List price', value: (f) => `${fmtMoney(f.row.price, { cents: true })}/${f.row.unit === 'gpu' ? 'GPU·h' : 'vCPU·h'}`, number: (f) => f.row.price, best: (v) => Math.min(...v) },
    { label: 'Trend (14 d)', value: (f) => (f.trend ? `${f.trend.slopePerWeek >= 0 ? '+' : '−'}${Math.abs(f.trend.slopePerWeek * 100).toFixed(1)} pt/wk` : '—') },
    { label: '95% booked in', value: (f) => (f.trend?.daysToCeiling === undefined ? 'not at trend' : f.trend.daysToCeiling === 0 ? 'already' : `${Math.round(f.trend.daysToCeiling)} d`) },
  ];

  return (
    <>
      <SourceNotice />
      <PageHeader
        icon={RiScales2Line}
        title="Compare pools"
        description="Up to four pools, measure by measure. The best value in a row is marked; the strips are each pool's share booked hour by hour for the next 7 days, on one scale."
        actions={
          <>
            {chosen.length < MAX && addable.length > 0 && (
              <Select
                label="Add a pool"
                value=""
                onChange={(id) => id && setIds([...ids, id])}
                options={[{ id: '', label: 'Add a pool…' }, ...addable.map((row) => ({ id: row.id, label: row.name, description: `${row.short} · ${row.siteId}` }))]}
                className="w-56"
              />
            )}
            <ButtonLink href="/pools" size="small" variant="secondary" leadingIcon={RiArrowLeftLine}>
              Pools
            </ButtonLink>
          </>
        }
      />
      {chosen.length < 2 ? (
        <EmptyState icon={RiScales2Line} title="Pick at least two pools">
          Select pools in the Pools table and choose Compare, or add them with the menu above.
        </EmptyState>
      ) : (
        <Panel flush bodyClassName="overflow-x-auto">
          <table className="w-full table-fixed text-body-regular">
            <colgroup>
              <col className="w-40" />
              {facts.map((f) => (
                <col key={f.row.id} />
              ))}
            </colgroup>
            <thead>
              <tr className="border-b border-separator-border">
                <th className="px-3 py-2" />
                {facts.map((f) => (
                  <th key={f.row.id} className="px-3 py-2 text-left font-normal">
                    <div className="flex items-start gap-2">
                      <Link href={`/pools/${f.row.id}`} className="min-w-0 flex-1 truncate text-body-medium text-text-primary hover:underline">
                        {f.row.name}
                      </Link>
                      <button type="button" aria-label={`Remove ${f.row.name}`} className="text-text-tertiary hover:text-text-primary" onClick={() => setIds(ids.filter((id) => id !== f.row.id))}>
                        <RiCloseLine className="size-4" aria-hidden />
                      </button>
                    </div>
                    <div className="mt-2">
                      <StackedBar
                        height={6}
                        total={f.row.total}
                        parts={[
                          { label: 'allocated', value: f.row.allocated, tone: 'signal' },
                          { label: 'free', value: f.row.freeNow, tone: 'muted' },
                          { label: 'out of service', value: f.row.unavailable, tone: 'hatch' },
                        ]}
                      />
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {measures.map((measure) => {
                const numbers = measure.number ? facts.map((f) => measure.number!(f)) : [];
                const best = measure.best && numbers.length ? measure.best(numbers) : undefined;
                return (
                  <tr key={measure.label} className="border-b border-separator-border">
                    <th scope="row" className="px-3 py-2 text-left font-mono text-[11px] font-normal tracking-wide text-text-tertiary uppercase">
                      {measure.label}
                    </th>
                    {facts.map((f, index) => (
                      <td key={f.row.id} className={cx('px-3 py-2 font-mono text-[12px] tabular-nums', best !== undefined && numbers[index] === best && 'text-signal')}>
                        {measure.value(f)}
                      </td>
                    ))}
                  </tr>
                );
              })}
              <tr className="border-b border-separator-border">
                <th scope="row" className="px-3 py-2 text-left font-mono text-[11px] font-normal tracking-wide text-text-tertiary uppercase">
                  Booked, next 7 d
                </th>
                {facts.map((f) => (
                  <td key={f.row.id} className="px-3 py-2">
                    <div className="flex h-5 w-full">
                      {f.ahead.map((ratio, index) => (
                        <span key={index} className="h-full flex-1" style={{ background: heatFill(ratio) }} />
                      ))}
                    </div>
                  </td>
                ))}
              </tr>
              <tr className="border-b border-separator-border">
                <th scope="row" className="px-3 py-2 text-left font-mono text-[11px] font-normal tracking-wide text-text-tertiary uppercase">
                  Daily, last 14 d
                </th>
                {facts.map((f) => (
                  <td key={f.row.id} className="px-3 py-2">
                    <Sparkline values={f.trend?.daily ?? []} height={24} max={1} min={0} />
                  </td>
                ))}
              </tr>
              <tr>
                <th scope="row" className="px-3 py-2 text-left align-top font-mono text-[11px] font-normal tracking-wide text-text-tertiary uppercase">
                  Top holders
                </th>
                {facts.map((f) => (
                  <td key={f.row.id} className="px-3 py-2 align-top">
                    <ul className="flex flex-col gap-1">
                      {f.top.map(([tenantId, gpus]) => (
                        <li key={tenantId} className="flex justify-between gap-2 text-caption-1-regular">
                          <span className="truncate">{tenantName(tenantId)}</span>
                          <span className="font-mono tabular-nums">{fmtNum(gpus)}</span>
                        </li>
                      ))}
                      {!f.top.length && <Tag status="off">nobody</Tag>}
                    </ul>
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </Panel>
      )}
    </>
  );
}
