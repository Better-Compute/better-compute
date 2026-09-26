'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { RiArrowLeftLine, RiBuilding2Line, RiEditLine } from 'react-icons/ri';
import { ButtonLink } from '@/components/base/buttons/button';
import { EntityLink } from '@/components/shell/peek';
import { Legend, Meter, Sparkline, TimeSeriesChart } from '@/components/ui/charts';
import { DataTable, type Column } from '@/components/ui/data-table';
import { EmptyState, Grid, PageHeader, Panel } from '@/components/ui/panel';
import { Tag } from '@/components/ui/signal';
import { Stat } from '@/components/ui/stat';
import { fmtMoney, fmtNum, fmtPct } from '@/lib/data/format';
import { holdsDevices, reservationGpus, type CapacitySnapshot } from '@/lib/data/capacity';
import { DAY, HOUR, useCapacity, useHourWindow, usePoolRows } from '../data';
import { costOf, quotaCells, rollup } from '../model';
import { QuotaEditor, type QuotaTarget } from '../quota-editor';
import { ReservationDrawer } from '../reservation-drawer';
import { ReservationsTable } from '../reservations-table';
import { SourceNotice } from '../source-notice';
import { utcDay } from '../ui';

// Capacity by tenant: who uses what, against which ceilings, at what cost, and what they have booked ahead.

export interface TenantRow {
  id: string;
  name: string;
  projects: string[];
  gpusNow: number;
  active: number;
  pending: number;
  upcoming: number;
  pools: number;
  /** The fullest GPU quota, 0..1. */
  quotaPeak: number;
  spend30: number;
  daily: number[];
}

export function tenantRows(snapshot: CapacitySnapshot, inScope: ReadonlySet<string>): TenantRow[] {
  const from = snapshot.now - 30 * DAY;
  return snapshot.tenants.map((tenant) => {
    const own = snapshot.reservations.filter((r) => r.tenantId === tenant.id && inScope.has(r.poolId));
    const active = own.filter((r) => r.state === 'active' || r.state === 'binding');
    const daily = new Array<number>(30).fill(0);
    let spend30 = 0;
    for (const window of snapshot.usage) {
      if (window.tags.tenantId !== tenant.id || window.windowStart < from || !inScope.has(window.tags.poolId ?? '')) continue;
      const cost = costOf(window, snapshot.prices);
      spend30 += cost;
      daily[Math.min(29, Math.floor((window.windowStart - from) / DAY))]! += cost;
    }
    const gpuQuotas = quotaCells(snapshot.quotas.filter((q) => q.tenantId === tenant.id && q.resource === 'gpu' && inScope.has(q.poolId)));
    return {
      id: tenant.id,
      name: tenant.name,
      projects: tenant.projects,
      gpusNow: active.reduce((sum, r) => sum + reservationGpus(r), 0),
      active: active.length,
      pending: own.filter((r) => r.state === 'pending' || r.state === 'awaiting-confirmation').length,
      upcoming: own.filter((r) => r.state === 'placed' && r.during && r.during.start < snapshot.now + DAY).length,
      pools: new Set(snapshot.offers.filter((offer) => offer.tenantId === tenant.id && inScope.has(offer.poolId)).map((offer) => offer.poolId)).size,
      quotaPeak: Math.max(0, ...gpuQuotas.map((cell) => cell.ratio)),
      spend30,
      daily,
    };
  });
}

export function TenantsPage() {
  const router = useRouter();
  const { snapshot, rows } = usePoolRows();
  const inScope = useMemo(() => new Set(rows.map((row) => row.id)), [rows]);
  const list = useMemo(() => tenantRows(snapshot, inScope), [snapshot, inScope]);
  const columns: Column<TenantRow>[] = [
    {
      id: 'name',
      header: 'Tenant',
      pinned: true,
      value: (row) => row.name,
      cell: (row) => (
        <div className="min-w-0">
          <Link href={`/capacity/tenants/${row.id}`} className="block truncate text-body-medium hover:underline" onClick={(event) => event.stopPropagation()}>
            {row.name}
          </Link>
          <span className="font-mono text-[11px] text-text-tertiary">{row.id}</span>
        </div>
      ),
      width: 200,
    },
    { id: 'gpus', header: 'GPUs now', align: 'right', value: (row) => row.gpusNow, cell: (row) => <span className="font-mono text-[12px] tabular-nums">{fmtNum(row.gpusNow)}</span>, width: 90 },
    { id: 'active', header: 'Active', align: 'right', value: (row) => row.active, cell: (row) => <span className="font-mono text-[12px] tabular-nums">{row.active}</span>, width: 70 },
    { id: 'upcoming', header: 'Start < 24 h', align: 'right', value: (row) => row.upcoming, cell: (row) => <span className="font-mono text-[12px] tabular-nums">{row.upcoming}</span>, width: 100 },
    {
      id: 'pending',
      header: 'Pending',
      align: 'right',
      value: (row) => row.pending,
      cell: (row) => (row.pending ? <Tag status="pending">{row.pending}</Tag> : <span className="font-mono text-[12px] text-text-tertiary">0</span>),
      width: 80,
    },
    {
      id: 'quota',
      header: 'Fullest GPU quota',
      value: (row) => row.quotaPeak,
      cell: (row) => (
        <div className="flex items-center gap-2">
          <div className="h-1.5 w-20 bg-background-secondary-default">
            <div className="h-full" style={{ width: `${row.quotaPeak * 100}%`, background: row.quotaPeak >= 1 ? 'var(--color-red-500)' : row.quotaPeak >= 0.8 ? 'var(--color-signal-fill)' : 'var(--color-text-tertiary)' }} />
          </div>
          <span className="font-mono text-[12px] tabular-nums">{fmtPct(row.quotaPeak, 0)}</span>
        </div>
      ),
      width: 150,
    },
    { id: 'pools', header: 'Pools', align: 'right', value: (row) => row.pools, cell: (row) => <span className="font-mono text-[12px] tabular-nums">{row.pools}</span>, width: 60 },
    {
      id: 'spend',
      header: 'Spend, 30 d',
      align: 'right',
      value: (row) => row.spend30,
      cell: (row) => (
        <div className="flex items-center justify-end gap-2">
          <div className="w-20">
            <Sparkline values={row.daily} height={18} area={false} />
          </div>
          <span className="w-16 font-mono text-[12px] tabular-nums">{fmtMoney(row.spend30, { short: true })}</span>
        </div>
      ),
      width: 170,
    },
  ];
  return (
    <>
      <SourceNotice />
      <PageHeader
        icon={RiBuilding2Line}
        title="Tenants"
        description="Every organization that books capacity: what it holds now, what it waits for, how close it runs to its ceilings and what it spends. Open one for its quotas, bookings ahead and spend."
      />
      <DataTable
        rows={list}
        columns={columns}
        rowId={(row) => row.id}
        onRowClick={(row) => router.push(`/capacity/tenants/${row.id}`)}
        searchPlaceholder="Search tenants"
        initialSort={{ id: 'gpus', dir: 'desc' }}
        exportName="tenants-capacity"
        viewKey="capacity.tenants"
      />
    </>
  );
}

export function TenantDetailPage({ tenantId }: { tenantId: string }) {
  const snapshot = useCapacity();
  const { rows } = usePoolRows();
  const inScope = useMemo(() => new Set(rows.map((row) => row.id)), [rows]);
  const tenant = snapshot.tenants.find((entry) => entry.id === tenantId);
  const row = useMemo(() => tenantRows(snapshot, inScope).find((entry) => entry.id === tenantId), [snapshot, inScope, tenantId]);
  const [open, setOpen] = useState<string | undefined>();
  const [quotaTarget, setQuotaTarget] = useState<QuotaTarget | undefined>();
  const { hour, to } = useHourWindow(0, 7 * 24);

  const reservations = useMemo(() => snapshot.reservations.filter((r) => r.tenantId === tenantId && inScope.has(r.poolId)), [snapshot, tenantId, inScope]);
  const quotas = useMemo(() => quotaCells(snapshot.quotas.filter((q) => q.tenantId === tenantId && inScope.has(q.poolId))), [snapshot, tenantId, inScope]);
  const usage = useMemo(() => snapshot.usage.filter((w) => w.tags.tenantId === tenantId && inScope.has(w.tags.poolId ?? '')), [snapshot, tenantId, inScope]);
  const byProject = useMemo(() => rollup(usage, (w) => w.tags.project || '(none)', snapshot.prices), [usage, snapshot.prices]);
  const byMeter = useMemo(() => rollup(usage, (w) => w.meter, snapshot.prices), [usage, snapshot.prices]);

  // GPUs this tenant has booked per hour ahead, against its total GPU quota.
  const forecast = useMemo(() => {
    const hours = Math.round((to - hour) / HOUR);
    const booked = new Array<number>(hours).fill(0);
    for (const r of reservations) {
      if (!r.during || !holdsDevices(r.state)) continue;
      const gpus = reservationGpus(r);
      const first = Math.max(0, Math.floor((r.during.start - hour) / HOUR));
      const last = Math.min(hours - 1, Math.ceil((r.during.end - hour) / HOUR) - 1);
      for (let index = first; index <= last; index += 1) booked[index]! += gpus;
    }
    const ceiling = quotas.filter((cell) => cell.resource === 'gpu').reduce((sum, cell) => sum + cell.max, 0);
    return { times: booked.map((_, index) => hour + index * HOUR), booked, ceiling: booked.map(() => ceiling) };
  }, [reservations, quotas, hour, to]);

  const openReservation = open ? reservations.find((r) => r.id === open) : undefined;

  if (!tenant || !row)
    return (
      <EmptyState
        icon={RiBuilding2Line}
        title={`No tenant ${tenantId}`}
        action={
          <ButtonLink href="/capacity/tenants" size="small" variant="secondary" leadingIcon={RiArrowLeftLine}>
            All tenants
          </ButtonLink>
        }
      />
    );

  const resources = [...new Set(quotas.map((cell) => cell.resource))];
  return (
    <>
      <SourceNotice />
      <PageHeader
        icon={RiBuilding2Line}
        title={tenant.name}
        description={`${fmtNum(row.gpusNow)} GPUs held now in ${row.active} reservation${row.active === 1 ? '' : 's'}; ${row.upcoming} start within 24 h${row.pending ? `, ${row.pending} waiting` : ''}. Projects: ${tenant.projects.join(', ')}.`}
        meta={
          <>
            <Tag status="ok" led={false}>
              {tenant.id}
            </Tag>
            <Tag status="ok" led={false}>
              {row.pools} pools
            </Tag>
            {row.quotaPeak >= 0.8 && <Tag status={row.quotaPeak >= 1 ? 'crit' : 'warn'}>quota {fmtPct(row.quotaPeak, 0)}</Tag>}
          </>
        }
        actions={
          <ButtonLink href="/capacity/tenants" size="small" variant="secondary" leadingIcon={RiArrowLeftLine}>
            Tenants
          </ButtonLink>
        }
      />
      <Grid>
        <Panel className="col-span-12" bodyClassName="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
          <Stat label="GPUs now" value={fmtNum(row.gpusNow)} />
          <Stat label="Active · pending" value={`${row.active} · ${row.pending}`} tone="neutral" />
          <Stat label="Fullest GPU quota" value={fmtPct(row.quotaPeak, 0)} tone="neutral" />
          <Stat label="Spend, 30 d" value={fmtMoney(row.spend30, { short: true })} trend={row.daily} />
        </Panel>

        <Panel className="col-span-12 xl:col-span-8" title="Booked ahead vs quota" meta="GPUs per hour, next 7 days">
          <TimeSeriesChart
            times={forecast.times}
            height={200}
            series={[
              { id: 'booked', label: 'Booked GPUs', values: forecast.booked, tone: 'signal', area: true },
              { id: 'quota', label: 'GPU quota (all pools)', values: forecast.ceiling, tone: 'neutral', dashed: true },
            ]}
            yMax={Math.max(1, ...forecast.ceiling, ...forecast.booked) * 1.1}
            xFormat={(t) => `${utcDay(t)} ${new Date(t).toISOString().slice(11, 13)}h`}
          />
          <Legend
            className="mt-2"
            items={[
              { label: 'booked GPUs', tone: 'signal' },
              { label: 'GPU quota, all pools (dashed)', tone: 'neutral' },
            ]}
          />
        </Panel>

        <Panel className="col-span-12 xl:col-span-4" title="Quotas" meta="click to change" flush>
          <ul>
            {[...new Set(quotas.map((cell) => cell.poolId))].map((poolId) => (
              <li key={poolId} className="border-b border-separator-border px-3 py-2 last:border-0">
                <EntityLink kind="pool" id={poolId} href={`/pools/${poolId}`} />
                <div className="mt-1.5 flex flex-col gap-1.5">
                  {resources.map((resource) => {
                    const cell = quotas.find((entry) => entry.poolId === poolId && entry.resource === resource);
                    if (!cell) return null;
                    return (
                      <button key={resource} type="button" className="group flex items-center gap-2 text-left" onClick={() => setQuotaTarget({ tenantId, poolId, resource })}>
                        <Meter value={cell.used} max={cell.max} compact className="flex-1" label={resource} detail={`${fmtNum(cell.used)} / ${fmtNum(cell.max)}`} />
                        <RiEditLine className="size-3.5 shrink-0 text-text-tertiary opacity-0 group-hover:opacity-100" aria-hidden />
                      </button>
                    );
                  })}
                </div>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel className="col-span-12 lg:col-span-6" title="Spend by project" meta="30 days" flush>
          <ul>
            {byProject.map((entry) => (
              <li key={entry.key} className="grid grid-cols-[8rem_1fr_5rem] items-center gap-3 border-b border-separator-border px-3 py-1.5 last:border-0">
                <span className="truncate font-mono text-[12px]">{entry.key}</span>
                <div className="h-2 bg-background-secondary-default">
                  <div className="h-full bg-signal-fill" style={{ width: `${(entry.cost / (byProject[0]?.cost || 1)) * 100}%` }} />
                </div>
                <span className="text-right font-mono text-[12px] tabular-nums">{fmtMoney(entry.cost, { short: true })}</span>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel className="col-span-12 lg:col-span-6" title="Spend by meter" meta="30 days" flush>
          <ul>
            {byMeter.map((entry) => (
              <li key={entry.key} className="grid grid-cols-[1fr_6rem_5rem] items-center gap-3 border-b border-separator-border px-3 py-1.5 last:border-0">
                <span className="truncate font-mono text-[12px]">{entry.key}</span>
                <span className="text-right font-mono text-[11px] tabular-nums text-text-tertiary">{fmtNum(entry.quantity, { short: true })}</span>
                <span className="text-right font-mono text-[12px] tabular-nums">{fmtMoney(entry.cost, { short: true })}</span>
              </li>
            ))}
          </ul>
        </Panel>

        <div className="col-span-12">
          <ReservationsTable reservations={reservations} onOpen={(r) => setOpen(r.id)} activeId={open} maxHeight={520} />
        </div>
      </Grid>
      <ReservationDrawer reservation={openReservation} onClose={() => setOpen(undefined)} />
      <QuotaEditor target={quotaTarget} onClose={() => setQuotaTarget(undefined)} />
    </>
  );
}
