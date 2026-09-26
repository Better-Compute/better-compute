'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { RiAddLine, RiArrowLeftLine, RiEditLine, RiServerLine } from 'react-icons/ri';
import { timelineView } from '@better-compute/console-kit';
import { ButtonLink } from '@/components/base/buttons/button';
import { Tab, TabList, TabPanel, Tabs } from '@/components/base/tabs/tabs';
import { Meter } from '@/components/ui/charts';
import { EmptyState, Grid, KeyValue, PageHeader, Panel } from '@/components/ui/panel';
import { Mono, Tag } from '@/components/ui/signal';
import { Stat } from '@/components/ui/stat';
import { fmtDuration, fmtGiB, fmtNum, fmtPct } from '@/lib/data/format';
import { poolById, siteById } from '@/lib/data/topology';
import { DAY, HOUR, type CapacityTimeline, type Reservation } from '@/lib/data/capacity';
import { cx } from '@/utils/cx';
import { useHourWindow, usePoolRows, useTenantName, useTimeline } from '../data';
import { GanttLegend, ReservationGantt } from '../gantt';
import { pressure, quotaCells } from '../model';
import { QuotaEditor, type QuotaTarget } from '../quota-editor';
import { GpuRack } from '../rack';
import { ReservationDrawer } from '../reservation-drawer';
import { ReservationsTable } from '../reservations-table';
import { heatFill, HeatLegend, Segmented, utcDay } from '../ui';
import { FlavorList } from './flavors';
import { classLabel } from './pools';

const SCHEDULE = {
  '24h': { back: 6, ahead: 18 },
  '3d': { back: 24, ahead: 48 },
  '7d': { back: 48, ahead: 120 },
  '14d': { back: 96, ahead: 240 },
} as const;
type ScheduleKey = keyof typeof SCHEDULE;

/** Days × hours of one pool's bookings (console-kit's timelineView), the week at a glance. */
function BookingCalendar({ timeline, now }: { timeline: CapacityTimeline; now: number }) {
  const view = useMemo(() => timelineView(timeline), [timeline]);
  const [hover, setHover] = useState<{ day: string; hour: number; booked: number; free: number } | null>(null);
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-[4.5rem_repeat(24,minmax(0,1fr))] gap-[2px] font-mono text-[10px] text-text-tertiary">
        <span />
        {Array.from({ length: 24 }, (_, hour) => (
          <span key={hour} className="text-center">
            {hour % 3 === 0 ? String(hour).padStart(2, '0') : ''}
          </span>
        ))}
        {view.days.map((day) =>
          [
            <span key={`${day.day}-label`} className="self-center text-text-secondary">
              {utcDay(day.buckets[0]!.start)}
            </span>,
            ...Array.from({ length: 24 }, (_, hour) => {
              const bucket = day.buckets.find((entry) => new Date(entry.start).getUTCHours() === hour);
              const current = bucket && bucket.start <= now && bucket.end > now;
              return (
                <span
                  key={`${day.day}-${hour}`}
                  onPointerEnter={() => bucket && setHover({ day: day.day, hour, booked: bucket.booked, free: bucket.free })}
                  onPointerLeave={() => setHover(null)}
                  className={cx('h-5', current && 'outline-2 outline-offset-[-1px] outline-text-primary', !bucket && 'bg-transparent')}
                  style={bucket ? { background: heatFill(bucket.ratio) } : undefined}
                />
              );
            }),
          ],
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <HeatLegend />
        <span className="font-mono text-[11px] text-text-secondary">
          {hover
            ? `${hover.day} ${String(hover.hour).padStart(2, '0')}:00 UTC · ${fmtNum(hover.booked)} booked · ${fmtNum(hover.free)} free`
            : `peak ${fmtNum(view.peak.booked)} of ${fmtNum(view.allocatable)} GPUs`}
        </span>
      </div>
    </div>
  );
}

export function PoolDetailPage({ poolId }: { poolId: string }) {
  const search = useSearchParams();
  const { snapshot, rows } = usePoolRows();
  const tenantName = useTenantName();
  const row = rows.find((entry) => entry.id === poolId) ?? undefined;
  const [tab, setTab] = useState<string>(search.get('tab') ?? 'now');
  const [schedule, setSchedule] = useState<ScheduleKey>('3d');
  const [open, setOpen] = useState<Reservation | undefined>();
  const [quotaTarget, setQuotaTarget] = useState<QuotaTarget | undefined>();
  const week = useHourWindow(0, 24 * 7);
  const scheduleWindow = useHourWindow(SCHEDULE[schedule].back, SCHEDULE[schedule].ahead);
  const calendarTimeline = useTimeline(row?.unit === 'gpu' ? poolId : undefined, Math.floor(week.from / DAY) * DAY, Math.floor(week.from / DAY) * DAY + 7 * DAY);
  const pressureTimeline = useTimeline(row?.unit === 'gpu' ? poolId : undefined, week.from, week.to);

  const reservations = useMemo(() => snapshot.reservations.filter((entry) => entry.poolId === poolId), [snapshot, poolId]);
  const nodes = useMemo(() => snapshot.nodes.filter((node) => node.poolId === poolId), [snapshot, poolId]);
  const offers = useMemo(() => snapshot.offers.filter((offer) => offer.poolId === poolId), [snapshot, poolId]);
  const cells = useMemo(() => quotaCells(snapshot.quotas.filter((q) => q.poolId === poolId)), [snapshot, poolId]);
  const flavors = useMemo(() => snapshot.flavors.filter((flavor) => flavor.poolId === poolId), [snapshot, poolId]);
  const capacity = snapshot.summary.pools.find((entry) => entry.poolId === poolId)?.capacity ?? [];

  if (!row)
    return (
      <EmptyState
        icon={RiServerLine}
        title={`No pool ${poolId}`}
        action={
          <ButtonLink href="/pools" size="small" variant="secondary" leadingIcon={RiArrowLeftLine}>
            All pools
          </ButtonLink>
        }
      >
        It may be outside the site scope in the top bar, archived, or not offered to this tenant.
      </EmptyState>
    );

  const fit = row.unit === 'gpu' && pressureTimeline ? pressure(row, pressureTimeline, snapshot.now, 8, DAY) : undefined;
  const policy = row.pool.policy;
  const site = siteById(row.siteId);

  return (
    <>
      <PageHeader
        icon={RiServerLine}
        title={row.name}
        description={`${row.pool.gpuModel} · ${site?.name ?? row.siteId} · ${classLabel[row.pool.class]}${row.pool.sharing !== 'exclusive' ? ` · ${row.pool.sharing} sharing` : ''}${row.pool.providerAccountId ? ` · provider ${row.pool.providerAccountId}` : ''}`}
        meta={
          <>
            <Mono dim>{row.id}</Mono>
            <Tag status="ok" led={false}>
              v{row.pool.version}
            </Tag>
            <Tag status="ok" led={false}>
              agent {row.pool.agent}
            </Tag>
            {row.pool.owned ? <Tag status="ok" led={false}>owned</Tag> : <Tag status="pending">offered to us</Tag>}
            {policy.kubernetes && <Tag status="ok" led={false}>kubernetes · {policy.kubernetes.gpuApi ?? 'device-plugin'}</Tag>}
          </>
        }
        actions={
          <>
            <ButtonLink href="/pools" size="small" variant="secondary" leadingIcon={RiArrowLeftLine}>
              Pools
            </ButtonLink>
            {row.unit === 'gpu' && (
              <ButtonLink href={`/reservations/new?pool=${row.id}`} size="small" leadingIcon={RiAddLine}>
                Book in this pool
              </ButtonLink>
            )}
          </>
        }
      />

      <Grid>
        <Panel className="col-span-12" bodyClassName="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 xl:grid-cols-6">
          <Stat label="Allocated now" value={fmtPct(row.utilization, 0)} unit={`${fmtNum(row.allocated)} / ${fmtNum(row.allocatable)}`} />
          <Stat label="Free now" value={fmtNum(row.freeNow)} unit={row.unit === 'gpu' ? 'GPUs' : 'vCPUs'} tone="neutral" />
          <Stat label="Booked later" value={fmtNum(row.reserved)} unit="atoms" hint="counted even if also in use now" tone="neutral" />
          <Stat label="Out of service" value={fmtNum(row.unavailable)} hint={`${fmtNum(row.row.provisioning ?? 0)} provisioning · ${fmtNum(row.row.maintenance ?? 0)} maintenance`} tone="neutral" />
          <Stat label="Active · pending" value={`${row.active} · ${row.pending}`} hint={`${row.startingSoon} start, ${row.endingSoon} end in 6 h`} tone="neutral" />
          <Stat
            label="Next 8 GPUs × 24 h"
            value={row.unit !== 'gpu' ? '—' : fit?.start === undefined ? '> 7 d' : fit.waitMs! < HOUR ? 'now' : `in ${fmtDuration(fit.waitMs!)}`}
            hint="from the booking timeline"
            tone="neutral"
          />
        </Panel>
      </Grid>

      <Tabs selectedKey={tab} onSelectionChange={(key) => setTab(String(key))} className="mt-4">
        <TabList aria-label="Pool sections">
          <Tab id="now">Now</Tab>
          {row.unit === 'gpu' && <Tab id="schedule">Schedule</Tab>}
          <Tab id="reservations" count={reservations.filter((entry) => entry.state === 'active' || entry.state === 'placed' || entry.state === 'pending').length}>
            Reservations
          </Tab>
          <Tab id="tenants" count={offers.length}>
            Tenants & quotas
          </Tab>
          <Tab id="policy">Policy</Tab>
          {flavors.length > 0 && (
            <Tab id="flavors" count={flavors.length}>
              Flavors
            </Tab>
          )}
        </TabList>

        <TabPanel id="now">
          <Grid>
            {row.unit === 'gpu' && (
              <Panel className="col-span-12 xl:col-span-8" title="GPUs by rack" meta={`${nodes.length} nodes · ${fmtNum(row.total)} GPUs`}>
                <GpuRack snapshot={snapshot} poolId={poolId} tenantName={tenantName} onSelectReservation={setOpen} />
              </Panel>
            )}
            <Panel className={cx('col-span-12', row.unit === 'gpu' && 'xl:col-span-4')} title="Resources" meta="capacity.byPool">
              <ul className="flex flex-col gap-4">
                {capacity.map((entry) => {
                  const format = (value: number) => (entry.resource === 'memoryGiB' ? fmtGiB(value) : fmtNum(value));
                  return (
                    <li key={entry.resource}>
                      <Meter
                        value={entry.allocated}
                        max={entry.allocatable}
                        label={entry.resource}
                        detail={`${format(entry.allocated)} / ${format(entry.allocatable)}`}
                      />
                      <div className="mt-1 flex justify-between font-mono text-[10px] text-text-tertiary">
                        <span>booked later {format(entry.reserved)}</span>
                        <span>unbooked {format(entry.available)}</span>
                        <span>total {format(entry.total)}</span>
                      </div>
                    </li>
                  );
                })}
              </ul>
              <p className="mt-4 text-caption-1-regular text-text-tertiary">
                “Unbooked” is the API's conservative <code className="font-mono">available</code>: allocatable − allocated − booked later, where an
                atom booked now and later counts twice.
              </p>
            </Panel>
            {row.unit === 'gpu' && calendarTimeline && (
              <Panel className="col-span-12" title="This week, hour by hour" meta="UTC">
                <BookingCalendar timeline={calendarTimeline} now={snapshot.now} />
              </Panel>
            )}
          </Grid>
        </TabPanel>

        {row.unit === 'gpu' && (
          <TabPanel id="schedule">
            <Panel
              title="Schedule"
              meta={`${nodes.length} nodes · rows are nodes, bar height is GPUs held`}
              actions={
                <Segmented
                  label="Schedule span"
                  value={schedule}
                  onChange={setSchedule}
                  options={(Object.keys(SCHEDULE) as ScheduleKey[]).map((id) => ({ id, label: id }))}
                />
              }
            >
              <ReservationGantt
                reservations={reservations}
                nodes={nodes}
                from={scheduleWindow.from}
                to={scheduleWindow.to}
                now={snapshot.now}
                selectedId={open?.id}
                onSelect={setOpen}
                tenantName={tenantName}
                gpusPerNode={nodes[0]?.gpus ?? 8}
                maxHeight={620}
              />
              <GanttLegend className="mt-3" />
            </Panel>
          </TabPanel>
        )}

        <TabPanel id="reservations">
          <ReservationsTable reservations={reservations} onOpen={setOpen} activeId={open?.id} hidePool />
        </TabPanel>

        <TabPanel id="tenants">
          <Panel title="Who may book this pool" meta="pools.offer · quotas.get" flush>
            <table className="w-full text-body-regular">
              <thead>
                <tr className="border-b border-separator-border font-mono text-[11px] tracking-wide text-text-tertiary uppercase">
                  <th className="px-3 py-2 text-left font-normal">Tenant</th>
                  <th className="px-3 py-2 text-left font-normal">Priority</th>
                  {[...new Set(cells.map((cell) => cell.resource))].map((resource) => (
                    <th key={resource} className="px-3 py-2 text-left font-normal">
                      {resource}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {offers.map((offer) => (
                  <tr key={offer.tenantId} className="border-b border-separator-border last:border-0">
                    <td className="px-3 py-2">
                      <Link href={`/quotas?tenant=${offer.tenantId}`} className="text-body-medium hover:underline">
                        {tenantName(offer.tenantId)}
                      </Link>
                      {offer.tenantId === snapshot.tenantId && <span className="ml-2 font-mono text-[11px] text-text-tertiary">owner</span>}
                      {offer.includeDescendants && <span className="ml-2 font-mono text-[11px] text-text-tertiary">+ sub-tenants</span>}
                    </td>
                    <td className="px-3 py-2 font-mono text-[12px]">{offer.priority ?? '—'}</td>
                    {[...new Set(cells.map((cell) => cell.resource))].map((resource) => {
                      const cell = cells.find((entry) => entry.tenantId === offer.tenantId && entry.resource === resource);
                      return (
                        <td key={resource} className="min-w-44 px-3 py-2">
                          {cell ? (
                            <button
                              type="button"
                              className="group flex w-full items-center gap-2 text-left"
                              onClick={() => setQuotaTarget({ tenantId: offer.tenantId, poolId, resource })}
                              aria-label={`Edit ${tenantName(offer.tenantId)} ${resource} quota`}
                            >
                              <Meter value={cell.used} max={cell.max} compact className="flex-1" detail={`${fmtNum(cell.used)}/${fmtNum(cell.max)}`} label=" " />
                              <RiEditLine className="size-3.5 shrink-0 text-text-tertiary opacity-0 group-hover:opacity-100" aria-hidden />
                            </button>
                          ) : (
                            <span className="text-text-tertiary">—</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </TabPanel>

        <TabPanel id="policy">
          <Grid>
            <Panel className="col-span-12 lg:col-span-7" title="Policy" meta="pools.update replaces it whole">
              <KeyValue
                columns={2}
                items={[
                  { label: 'Sharing', value: row.pool.sharing, mono: true },
                  { label: 'Placer', value: poolById(row.id)?.placer ?? 'inline', mono: true },
                  { label: 'Disruption budget', value: fmtPct(policy.disruptionBudget ?? 0.05, 0), mono: true },
                  { label: 'Max pending', value: policy.maxPending ?? '—', mono: true },
                  { label: 'Per-GPU share', value: policy.perGpu ? `${policy.perGpu.vcpu ?? '—'} vCPU · ${policy.perGpu.memoryGiB ?? '—'} GiB` : 'node ÷ GPUs', mono: true },
                  { label: 'Host reserve', value: policy.hostReserve ? `${policy.hostReserve.vcpu ?? 2} vCPU · ${policy.hostReserve.memoryGiB ?? 8} GiB` : '2 vCPU · 8 GiB (default)', mono: true },
                  { label: 'Overcommit', value: policy.overcommit ? Object.entries(policy.overcommit).map(([k, v]) => `${k} ×${v}`).join(' · ') : 'none', mono: true },
                  { label: 'Join attestors', value: policy.joinAttestors?.join(', ') ?? 'any', mono: true },
                  { label: 'Budget check', value: policy.admission?.budgetCheck ?? 'none', mono: true },
                  { label: 'MIG layout', value: policy.migLayout ?? '—', mono: true },
                  { label: 'Hugepages', value: policy.hugepages ? `${policy.hugepages.count} × ${policy.hugepages.size}${policy.hugepages.perNuma ? ' per NUMA' : ''}` : '—', mono: true },
                  { label: 'GPU settings', value: policy.gpu ? `${policy.gpu.powerLimitWatts ?? '—'} W · ECC ${policy.gpu.ecc ? 'on' : 'off'}` : '—', mono: true },
                  { label: 'Runtime', value: policy.runtime ?? '—', mono: true },
                  { label: 'Kubernetes', value: policy.kubernetes ? `${policy.kubernetes.apiServer ?? 'in-cluster'} · ${policy.kubernetes.gpuApi ?? 'device-plugin'}` : '—', mono: true },
                ]}
              />
            </Panel>
            <Panel className="col-span-12 lg:col-span-5" title="As stored" meta="JSON">
              <pre className="max-h-[420px] overflow-auto bg-surface-sunken p-3 font-mono text-[11px] leading-5 text-text-secondary">{JSON.stringify(policy, null, 2)}</pre>
            </Panel>
          </Grid>
        </TabPanel>

        {flavors.length > 0 && (
          <TabPanel id="flavors">
            <FlavorList poolId={poolId} />
          </TabPanel>
        )}
      </Tabs>

      <ReservationDrawer reservation={open} onClose={() => setOpen(undefined)} />
      <QuotaEditor target={quotaTarget} onClose={() => setQuotaTarget(undefined)} />
    </>
  );
}
