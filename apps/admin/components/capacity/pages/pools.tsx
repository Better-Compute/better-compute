'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { RiLayoutGridLine, RiScales2Line, RiServerLine } from 'react-icons/ri';
import { Button, ButtonLink } from '@/components/base/buttons/button';
import { Sparkline, StackedBar } from '@/components/ui/charts';
import { DataTable, type Column } from '@/components/ui/data-table';
import { PageHeader, Panel } from '@/components/ui/panel';
import { Led, Mono, Tag } from '@/components/ui/signal';
import { fmtMoney, fmtNum, fmtPct } from '@/lib/data/format';
import { siteById } from '@/lib/data/topology';
import { useHourWindow, usePoolRows, useTimelines } from '../data';
import { SourceNotice } from '../source-notice';
import { fleetTotals, type PoolRow } from '../model';
import { Segmented } from '../ui';

export const classLabel: Record<string, string> = {
  'metal-host': 'metal host',
  'metal-dedicated': 'dedicated metal',
  'vps-host': 'VPS host',
  provider: 'provider',
};

type View = 'table' | 'cards';

/** Every pool the operator owns or is offered, with its capacity now and its booking curve ahead. */
export function PoolsPage() {
  const router = useRouter();
  const { snapshot, rows } = usePoolRows();
  const [view, setView] = useState<View>('table');
  const { from, to } = useHourWindow(0, 72);
  const timelines = useTimelines(
    rows.filter((row) => row.unit === 'gpu').map((row) => row.id),
    from,
    to,
  );
  const totals = useMemo(() => fleetTotals(rows), [rows]);
  const curve = (row: PoolRow) => {
    const timeline = timelines.get(row.id);
    return timeline ? timeline.buckets.map((bucket) => (timeline.allocatable ? bucket.booked / timeline.allocatable : 0)) : [];
  };

  const columns: Column<PoolRow>[] = [
    {
      id: 'pool',
      header: 'Pool',
      pinned: true,
      value: (row) => `${row.name} ${row.id}`,
      cell: (row) => (
        <div className="min-w-0">
          <Link href={`/pools/${row.id}`} className="block truncate text-body-medium text-text-primary hover:underline" onClick={(event) => event.stopPropagation()}>
            {row.name}
          </Link>
          <Mono dim className="text-[11px]">
            {row.id}
          </Mono>
        </div>
      ),
      width: 220,
    },
    { id: 'site', header: 'Site', value: (row) => row.siteId, cell: (row) => <span className="font-mono text-[12px]">{row.siteId}</span>, width: 70 },
    { id: 'model', header: 'Model', value: (row) => row.short, cell: (row) => <span className="font-mono text-[12px]">{row.short}</span>, width: 110 },
    {
      id: 'class',
      header: 'Class',
      value: (row) => row.pool.class,
      cell: (row) => (
        <Tag status="ok" led={false}>
          {classLabel[row.pool.class]}
          {row.pool.sharing !== 'exclusive' ? ` · ${row.pool.sharing}` : ''}
        </Tag>
      ),
      width: 150,
    },
    {
      id: 'utilization',
      header: 'Allocated',
      align: 'right',
      value: (row) => row.utilization,
      cell: (row) => (
        <div className="flex items-center justify-end gap-2">
          <div className="w-24">
            <StackedBar
              height={6}
              total={row.total}
              parts={[
                { label: 'allocated', value: row.allocated, tone: 'signal' },
                { label: 'free', value: row.freeNow, tone: 'muted' },
                { label: 'out of service', value: row.unavailable, tone: 'hatch' },
              ]}
            />
          </div>
          <span className="w-10 font-mono text-[12px] tabular-nums">{fmtPct(row.utilization, 0)}</span>
        </div>
      ),
      width: 160,
    },
    {
      id: 'free',
      header: 'Free now',
      align: 'right',
      value: (row) => row.freeNow,
      cell: (row) => (
        <span className="font-mono text-[12px] tabular-nums">
          {fmtNum(row.freeNow)} <span className="text-text-tertiary">{row.unit === 'gpu' ? 'GPU' : 'vCPU'}</span>
        </span>
      ),
      width: 110,
    },
    {
      id: 'ahead',
      header: 'Next 72 h',
      value: (row) => Math.max(0, ...curve(row)),
      cell: (row) =>
        row.unit === 'gpu' ? (
          <div className="w-28">
            <Sparkline values={curve(row)} height={20} max={1} min={0} />
          </div>
        ) : (
          <span className="font-mono text-[11px] text-text-tertiary">instances</span>
        ),
      width: 130,
    },
    { id: 'reserved', header: 'Booked later', align: 'right', value: (row) => row.reserved, cell: (row) => <span className="font-mono text-[12px] tabular-nums">{fmtNum(row.reserved)}</span>, defaultHidden: true },
    { id: 'unavailable', header: 'Out of service', align: 'right', value: (row) => row.unavailable, cell: (row) => <span className="font-mono text-[12px] tabular-nums">{fmtNum(row.unavailable)}</span>, defaultHidden: true },
    {
      id: 'active',
      header: 'Active',
      align: 'right',
      value: (row) => row.active,
      cell: (row) => <span className="font-mono text-[12px] tabular-nums">{fmtNum(row.active)}</span>,
      width: 70,
    },
    {
      id: 'pending',
      header: 'Pending',
      align: 'right',
      value: (row) => row.pending,
      cell: (row) => (row.pending ? <Tag status="pending">{row.pending}</Tag> : <span className="font-mono text-[12px] text-text-tertiary">0</span>),
      width: 80,
    },
    { id: 'tenants', header: 'Tenants', align: 'right', value: (row) => row.tenants, cell: (row) => <span className="font-mono text-[12px] tabular-nums">{row.tenants}</span>, width: 70 },
    {
      id: 'price',
      header: 'List price',
      align: 'right',
      value: (row) => row.price,
      cell: (row) => (
        <span className="font-mono text-[12px] tabular-nums">
          {fmtMoney(row.price, { cents: true })}
          <span className="text-text-tertiary">/{row.unit === 'gpu' ? 'GPU·h' : 'vCPU·h'}</span>
        </span>
      ),
      defaultHidden: true,
    },
  ];

  return (
    <>
      <SourceNotice />
      <PageHeader
        icon={RiServerLine}
        title="Pools"
        description="Scheduling domains: one site, one GPU model, one policy. Allocated is booked now; free now is schedulable and unbooked at this moment; the curve is the share booked over the next 72 hours."
        meta={
          <>
            <Tag status="ok" led={false}>
              {rows.length} pools · {fmtNum(totals.gpus)} GPUs
            </Tag>
            <Tag status="ok" led={false}>
              {fmtPct(totals.utilization, 0)} allocated
            </Tag>
          </>
        }
        actions={
          <>
            <ButtonLink href="/flavors" size="small" variant="secondary" leadingIcon={RiLayoutGridLine}>
              Flavors
            </ButtonLink>
            <Segmented
              label="View"
              value={view}
              onChange={setView}
              options={[
                { id: 'table', label: 'Table' },
                { id: 'cards', label: 'Cards' },
              ]}
            />
          </>
        }
      />
      {view === 'table' ? (
        <DataTable
          rows={rows}
          columns={columns}
          rowId={(row) => row.id}
          onRowClick={(row) => router.push(`/pools/${row.id}`)}
          facets={[
            { id: 'site', label: 'Site', value: (row) => row.siteId, labels: Object.fromEntries(snapshot.sites.map((site) => [site.id, site.name])) },
            { id: 'class', label: 'Class', value: (row) => row.pool.class, labels: classLabel },
            { id: 'unit', label: 'Kind', value: (row) => row.unit, labels: { gpu: 'GPU pools', vcpu: 'CPU & sandbox pools' } },
          ]}
          searchPlaceholder="Search pools"
          initialSort={{ id: 'utilization', dir: 'desc' }}
          exportName="pools"
          viewKey="capacity.pools"
          bulkActions={(selected, clear) => (
            <Button
              size="xs"
              variant="secondary"
              leadingIcon={RiScales2Line}
              disabled={selected.length < 2}
              onClick={() => {
                router.push(`/pools/compare?ids=${selected.slice(0, 4).map((row) => row.id).join(',')}`);
                clear();
              }}
            >
              {selected.length < 2 ? 'Select 2–4 to compare' : `Compare ${Math.min(4, selected.length)}`}
            </Button>
          )}
        />
      ) : (
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
          {rows.map((row) => (
            <Link key={row.id} href={`/pools/${row.id}`} className="group block outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring">
              <Panel
                title={row.name}
                meta={row.id}
                className="h-full transition-colors group-hover:border-separator-border-strong"
                actions={<Led status={row.pending ? 'pending' : row.utilization > 0.9 ? 'warn' : 'ok'} />}
              >
                <div className="mb-2 flex items-baseline justify-between">
                  <span className="font-mono text-[24px] leading-8 tabular-nums">{fmtPct(row.utilization, 0)}</span>
                  <span className="font-mono text-[11px] text-text-tertiary">
                    {siteById(row.siteId)?.city} · {row.short} · {classLabel[row.pool.class]}
                  </span>
                </div>
                <StackedBar
                  height={8}
                  total={row.total}
                  parts={[
                    { label: 'allocated', value: row.allocated, tone: 'signal' },
                    { label: 'free', value: row.freeNow, tone: 'muted' },
                    { label: 'out of service', value: row.unavailable, tone: 'hatch' },
                  ]}
                />
                <div className="mt-2 grid grid-cols-3 gap-2 font-mono text-[11px] text-text-secondary">
                  <span>
                    <span className="block text-text-tertiary">allocated</span>
                    {fmtNum(row.allocated)}
                  </span>
                  <span>
                    <span className="block text-text-tertiary">free now</span>
                    {fmtNum(row.freeNow)}
                  </span>
                  <span>
                    <span className="block text-text-tertiary">pending</span>
                    {row.pending}
                  </span>
                </div>
                {row.unit === 'gpu' && (
                  <div className="mt-3">
                    <span className="font-mono text-[10px] text-text-tertiary">booked, next 72 h</span>
                    <Sparkline values={curve(row)} height={28} max={1} min={0} />
                  </div>
                )}
              </Panel>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
