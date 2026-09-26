'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';
import { RiAddLine, RiCalendarEventLine, RiHourglassLine } from 'react-icons/ri';
import { earliestFit } from '@better-compute/console-kit';
import { ButtonLink } from '@/components/base/buttons/button';
import { usePageCommands } from '@/components/shell/page-commands';
import { Select } from '@/components/ui/overlay';
import { EmptyState, PageHeader, Panel } from '@/components/ui/panel';
import { Mono, Tag } from '@/components/ui/signal';
import { fmtDuration, fmtNum, fmtRelative } from '@/lib/data/format';
import { durationMs, reservationGpus, reservationStates, type Reservation, type ReservationState } from '@/lib/data/capacity';
import { cx } from '@/utils/cx';
import { HOUR, useHourWindow, usePoolRows, useTenantName, useTimelines } from '../data';
import { SourceNotice } from '../source-notice';
import { GanttLegend, ReservationGantt } from '../gantt';
import { stateStyle } from '../model';
import { ReservationDrawer } from '../reservation-drawer';
import { ReservationsTable } from '../reservations-table';
import { Segmented } from '../ui';

type View = 'table' | 'timeline';
const WINDOWS = { '24h': [6, 18], '3d': [24, 48], '7d': [48, 120] } as const;
type WindowKey = keyof typeof WINDOWS;

/** Every reservation: counts by state, a filterable table or a per-pool timeline, and why pending ones wait. */
export function ReservationsPage() {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const { snapshot, rows } = usePoolRows();
  const tenantName = useTenantName();
  const [view, setView] = useState<View>((search.get('view') as View) ?? 'table');
  const [states, setStates] = useState<Set<ReservationState>>(new Set());
  const gpuPools = rows.filter((row) => row.unit === 'gpu');
  const [poolId, setPoolId] = useState<string>(search.get('pool') ?? gpuPools[0]?.id ?? '');
  const [span, setSpan] = useState<WindowKey>('3d');
  const window_ = useHourWindow(WINDOWS[span][0], WINDOWS[span][1]);

  const openId = search.get('id') ?? undefined;
  const setOpenId = useCallback(
    (id?: string) => {
      const params = new URLSearchParams(search.toString());
      if (id) params.set('id', id);
      else params.delete('id');
      router.replace(`${pathname}${params.size ? `?${params}` : ''}`, { scroll: false });
    },
    [router, pathname, search],
  );

  const inScope = useMemo(() => new Set(rows.map((row) => row.id)), [rows]);
  const all = useMemo(() => snapshot.reservations.filter((r) => inScope.has(r.poolId)), [snapshot, inScope]);
  const counts = useMemo(() => {
    const map = new Map<ReservationState, number>();
    for (const r of all) map.set(r.state, (map.get(r.state) ?? 0) + 1);
    return map;
  }, [all]);
  const filtered = useMemo(() => (states.size ? all.filter((r) => states.has(r.state)) : all), [all, states]);
  const open = openId ? all.find((r) => r.id === openId) : undefined;

  const pending = useMemo(() => all.filter((r) => r.state === 'pending' || r.state === 'awaiting-confirmation'), [all]);
  const pendingPools = useMemo(() => [...new Set(pending.map((r) => r.poolId))], [pending]);
  const pendingTimelines = useTimelines(pendingPools, window_.hour, window_.hour + 7 * 24 * HOUR);

  usePageCommands(
    useMemo(
      () => [
        { id: 'rsv.view.table', label: 'Reservations as a table', group: 'This page', run: () => setView('table') },
        { id: 'rsv.view.timeline', label: 'Reservations as a timeline (Gantt)', group: 'This page', run: () => setView('timeline') },
        ...(['pending', 'active', 'placed', 'failed'] as ReservationState[]).map((state) => ({
          id: `rsv.only.${state}`,
          label: `Only ${stateStyle[state].label} reservations`,
          group: 'This page',
          run: () => setStates(new Set([state])),
        })),
        { id: 'rsv.all', label: 'All reservations (clear the state filter)', group: 'This page', run: () => setStates(new Set()) },
      ],
      [],
    ),
  );

  const toggle = (state: ReservationState) =>
    setStates((current) => {
      const next = new Set(current);
      if (next.has(state)) next.delete(state);
      else next.add(state);
      return next;
    });

  return (
    <>
      <SourceNotice />
      <PageHeader
        icon={RiCalendarEventLine}
        title="Reservations"
        description="Booked device windows in every pool: who holds what, when it starts and ends, and what is stuck. Select rows to release or cancel in bulk."
        actions={
          <>
            <Segmented
              label="View"
              value={view}
              onChange={(value) => setView(value as View)}
              options={[
                { id: 'table', label: 'Table' },
                { id: 'timeline', label: 'Timeline' },
              ]}
            />
            <ButtonLink href="/reservations/new" size="small" leadingIcon={RiAddLine}>
              New reservation
            </ButtonLink>
          </>
        }
      >
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by state">
          {reservationStates
            .filter((state) => counts.get(state))
            .map((state) => {
              const on = states.has(state);
              return (
                <button
                  key={state}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(state)}
                  className={cx(
                    'inline-flex h-7 items-center gap-2 border px-2 font-mono text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring',
                    on ? 'border-signal-fill bg-signal-soft text-text-primary' : 'border-separator-border text-text-secondary hover:border-separator-border-strong',
                  )}
                >
                  {stateStyle[state].label}
                  <span className="tabular-nums text-text-primary">{fmtNum(counts.get(state) ?? 0)}</span>
                </button>
              );
            })}
          {states.size > 0 && (
            <button type="button" onClick={() => setStates(new Set())} className="px-2 font-mono text-[11px] text-text-tertiary hover:text-text-primary">
              clear
            </button>
          )}
        </div>
      </PageHeader>

      {pending.length > 0 && (
        <Panel title="Waiting for capacity" icon={RiHourglassLine} meta={`${pending.length} pending`} className="mb-3" flush>
          <ul className="max-h-60 overflow-y-auto">
            {pending.slice(0, 30).map((r) => {
              const timeline = pendingTimelines.get(r.poolId);
              const perNode = r.request.devices[0]?.count ?? 1;
              const fit = timeline ? earliestFit(timeline, reservationGpus(r), durationMs(r.request.duration), { notBefore: snapshot.now }) : undefined;
              return (
                <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-separator-border px-3 py-1.5 last:border-0">
                  <button type="button" onClick={() => setOpenId(r.id)} className="hover:underline">
                    <Mono>{r.id}</Mono>
                  </button>
                  <Tag status="pending">{stateStyle[r.state].label}</Tag>
                  <span className="text-caption-1-regular text-text-secondary">
                    {tenantName(r.tenantId)} wants {fmtNum(reservationGpus(r))} GPUs ({perNode}/node) for {r.request.duration} in{' '}
                    <Link href={`/pools/${r.poolId}`} className="font-mono hover:underline">
                      {r.poolId}
                    </Link>
                  </span>
                  <span className="ml-auto font-mono text-[11px] text-text-secondary">
                    {r.state === 'awaiting-confirmation'
                      ? 'needs a person to confirm (delegated deny)'
                      : fit === undefined
                        ? 'no window in the next 7 days'
                        : fit <= snapshot.now + HOUR
                          ? 'fits now: the placer retries on the next wake'
                          : `pool-wide window ${fmtRelative(fit, snapshot.now)}`}
                  </span>
                </li>
              );
            })}
          </ul>
        </Panel>
      )}

      {view === 'table' ? (
        <ReservationsTable reservations={filtered} onOpen={(r) => setOpenId(r.id)} activeId={openId} />
      ) : (
        <Panel
          title="Timeline"
          meta={poolId ? 'rows are nodes' : undefined}
        >
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Select
              label="Pool"
              value={poolId}
              onChange={setPoolId}
              options={gpuPools.map((row) => ({ id: row.id, label: row.name, description: `${row.short} · ${row.siteId}` }))}
              className="w-56 max-w-full"
            />
            <Segmented label="Window" value={span} onChange={(value) => setSpan(value as WindowKey)} options={(Object.keys(WINDOWS) as WindowKey[]).map((id) => ({ id, label: id }))} />
          </div>
          {poolId ? (
            <>
              <ReservationGantt
                reservations={filtered.filter((r) => r.poolId === poolId)}
                nodes={snapshot.nodes.filter((node) => node.poolId === poolId)}
                from={window_.from}
                to={window_.to}
                now={snapshot.now}
                selectedId={openId}
                onSelect={(r: Reservation) => setOpenId(r.id)}
                tenantName={tenantName}
                gpusPerNode={snapshot.nodes.find((node) => node.poolId === poolId)?.gpus ?? 8}
                maxHeight={640}
              />
              <GanttLegend className="mt-3" />
            </>
          ) : (
            <EmptyState title="No GPU pool in scope" />
          )}
        </Panel>
      )}

      <p className="mt-3 font-mono text-[11px] text-text-tertiary">
        {fmtNum(filtered.length)} of {fmtNum(all.length)} reservations · longest active{' '}
        {fmtDuration(Math.max(0, ...all.filter((r) => r.state === 'active' && r.during).map((r) => r.during!.end - r.during!.start)))}
      </p>

      <ReservationDrawer reservation={open} onClose={() => setOpenId(undefined)} />
    </>
  );
}
