'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { RiAddLine, RiArrowRightUpLine } from 'react-icons/ri';
import { ButtonLink } from '@/components/base/buttons/button';
import { EntityLink } from '@/components/shell/peek';
import { Sparkline, StackedBar } from '@/components/ui/charts';
import { EmptyState, KeyValue, Panel } from '@/components/ui/panel';
import { Tag } from '@/components/ui/signal';
import { Stat } from '@/components/ui/stat';
import { fmtDuration, fmtMoney, fmtNum, fmtPct, fmtRelative, fmtStamp } from '@/lib/data/format';
import { reservationGpus } from '@/lib/data/capacity';
import { cx } from '@/utils/cx';
import { DAY, useCapacity, useHourWindow, usePoolRows, useTenantName, useTimeline } from './data';
import { GanttLegend, ReservationGantt } from './gantt';
import { costOf, quotaCells, reservationSpend } from './model';
import { StateTag } from './ui';

// Peeks: compact views of one capacity entity in the shell's side sheet, opened from any <EntityLink>.

export function PoolPeek({ id }: { id: string }) {
  const { snapshot, rows } = usePoolRows();
  const tenantName = useTenantName();
  const row = rows.find((entry) => entry.id === id) ?? undefined;
  const { hour, to } = useHourWindow(0, 72);
  const timeline = useTimeline(row?.unit === 'gpu' ? id : undefined, hour, to);
  const holders = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of snapshot.reservations)
      if (r.poolId === id && (r.state === 'active' || r.state === 'binding')) map.set(r.tenantId, (map.get(r.tenantId) ?? 0) + reservationGpus(r));
    return [...map].sort((a, b) => b[1] - a[1]).slice(0, 5);
  }, [snapshot, id]);
  if (!row) return <EmptyState title={`No pool ${id} in scope`} />;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-caption-1-regular text-text-secondary">
        {row.pool.gpuModel} · {row.siteId} · {row.pool.class}
        {row.pool.sharing !== 'exclusive' ? ` · ${row.pool.sharing}` : ''}
      </p>
      <div className="grid grid-cols-3 gap-3">
        <Stat size="sm" label="Allocated" value={fmtPct(row.utilization, 0)} unit={`${fmtNum(row.allocated)}/${fmtNum(row.allocatable)}`} />
        <Stat size="sm" label="Free now" value={fmtNum(row.freeNow)} tone="neutral" />
        <Stat size="sm" label="Pending" value={fmtNum(row.pending)} tone="neutral" />
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
      {timeline && (
        <div>
          <span className="font-mono text-[10px] text-text-tertiary">share booked, next 72 h</span>
          <Sparkline values={timeline.buckets.map((b) => (timeline.allocatable ? b.booked / timeline.allocatable : 0))} height={36} max={1} min={0} />
        </div>
      )}
      {holders.length > 0 && (
        <Panel title="Holding GPUs now" flush>
          <ul>
            {holders.map(([tenantId, gpus]) => (
              <li key={tenantId} className="flex items-center justify-between border-b border-separator-border px-3 py-1.5 last:border-0">
                <EntityLink kind="tenant" id={tenantId} href={`/quotas?tenant=${tenantId}`}>
                  {tenantName(tenantId)}
                </EntityLink>
                <span className="font-mono text-[12px] tabular-nums">{fmtNum(gpus)} GPUs</span>
              </li>
            ))}
          </ul>
        </Panel>
      )}
      <div className="flex flex-wrap gap-2">
        <ButtonLink href={`/pools/${id}`} size="small" variant="secondary" trailingIcon={RiArrowRightUpLine}>
          Open pool
        </ButtonLink>
        <ButtonLink href={`/pools/${id}?tab=schedule`} size="small" variant="secondary">
          Schedule
        </ButtonLink>
        {row.unit === 'gpu' && (
          <ButtonLink href={`/reservations/new?pool=${id}`} size="small" leadingIcon={RiAddLine}>
            Book
          </ButtonLink>
        )}
      </div>
    </div>
  );
}

export function ReservationPeek({ id }: { id: string }) {
  const snapshot = useCapacity();
  const tenantName = useTenantName();
  const r = snapshot.reservations.find((entry) => entry.id === id);
  const spend = useMemo(() => (r ? reservationSpend(r, snapshot.usage, snapshot.prices) : 0), [r, snapshot]);
  if (!r) return <EmptyState title={`No reservation ${id}`}>It may be a draft, or outside the loaded window.</EmptyState>;
  const progress = r.during ? Math.min(1, Math.max(0, (snapshot.now - r.during.start) / (r.during.end - r.during.start))) : 0;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <StateTag state={r.state} />
        {r.request.spot && <Tag status="ok" led={false}>spot</Tag>}
        {r.request.gang && <Tag status="ok" led={false}>gang ×{r.request.gang.size}</Tag>}
      </div>
      <KeyValue
        columns={2}
        items={[
          { label: 'Tenant', value: <EntityLink kind="tenant" id={r.tenantId} href={`/quotas?tenant=${r.tenantId}`}>{tenantName(r.tenantId)}</EntityLink> },
          { label: 'Pool', value: <EntityLink kind="pool" id={r.poolId} href={`/pools/${r.poolId}`} /> },
          { label: 'GPUs', value: fmtNum(reservationGpus(r)), mono: true },
          { label: 'Spend so far', value: fmtMoney(spend, { cents: true }), mono: true },
          ...(r.during
            ? [
                { label: 'Start', value: `${fmtStamp(r.during.start)} UTC`, mono: true },
                { label: 'Length', value: fmtDuration(r.during.end - r.during.start), mono: true },
              ]
            : []),
        ]}
      />
      {r.during && (
        <div>
          <div className="h-1.5 bg-background-secondary-default">
            <div className={cx('h-full', r.state === 'active' ? 'bg-signal-fill' : 'bg-text-tertiary/50')} style={{ width: `${progress * 100}%` }} />
          </div>
          <p className="mt-1 font-mono text-[11px] text-text-secondary">
            {snapshot.now < r.during.start ? `starts ${fmtRelative(r.during.start, snapshot.now)}` : snapshot.now < r.during.end ? `ends ${fmtRelative(r.during.end, snapshot.now)}` : `ended ${fmtRelative(r.during.end, snapshot.now)}`}
          </p>
        </div>
      )}
      {(r.nodeIds?.length ?? 0) > 0 && (
        <div className="flex flex-wrap gap-2">
          {r.nodeIds!.map((nodeId) => (
            <EntityLink key={nodeId} kind="node" id={nodeId} href={`/nodes/${nodeId}`} />
          ))}
        </div>
      )}
      <ButtonLink href={`/reservations?id=${r.id}`} size="small" variant="secondary" trailingIcon={RiArrowRightUpLine}>
        Open with actions
      </ButtonLink>
    </div>
  );
}

export function TenantPeek({ id }: { id: string }) {
  const snapshot = useCapacity();
  const tenant = snapshot.tenants.find((entry) => entry.id === id);
  const stats = useMemo(() => {
    const own = snapshot.reservations.filter((r) => r.tenantId === id);
    const active = own.filter((r) => r.state === 'active' || r.state === 'binding');
    const spend = snapshot.usage.filter((w) => w.tags.tenantId === id).reduce((total, w) => total + costOf(w, snapshot.prices), 0);
    const daily = new Array<number>(30).fill(0);
    const from = snapshot.now - 30 * DAY;
    for (const w of snapshot.usage) if (w.tags.tenantId === id && w.windowStart >= from) daily[Math.min(29, Math.floor((w.windowStart - from) / DAY))]! += costOf(w, snapshot.prices);
    return {
      gpus: active.reduce((total, r) => total + reservationGpus(r), 0),
      active: active.length,
      pending: own.filter((r) => r.state === 'pending' || r.state === 'awaiting-confirmation').length,
      upcoming: own.filter((r) => r.state === 'placed' && r.during && r.during.start < snapshot.now + DAY).length,
      spend,
      daily,
      quotas: quotaCells(snapshot.quotas.filter((q) => q.tenantId === id && q.resource === 'gpu')).sort((a, b) => b.ratio - a.ratio),
    };
  }, [snapshot, id]);
  if (!tenant) return <EmptyState title={`No tenant ${id}`} />;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-3 gap-3">
        <Stat size="sm" label="GPUs now" value={fmtNum(stats.gpus)} />
        <Stat size="sm" label="Active · pending" value={`${stats.active} · ${stats.pending}`} tone="neutral" />
        <Stat size="sm" label="Spend 30 d" value={fmtMoney(stats.spend, { short: true })} tone="neutral" />
      </div>
      <Sparkline values={stats.daily} height={32} />
      <Panel title="GPU quotas" flush>
        <ul>
          {stats.quotas.map((cell) => (
            <li key={cell.poolId} className="grid grid-cols-[1fr_6rem_4rem] items-center gap-2 border-b border-separator-border px-3 py-1.5 last:border-0">
              <EntityLink kind="pool" id={cell.poolId} href={`/pools/${cell.poolId}`} />
              <div className="h-1 bg-background-secondary-default">
                <div className="h-full" style={{ width: `${cell.ratio * 100}%`, background: cell.level === 'full' ? 'var(--color-red-500)' : cell.level === 'warning' ? 'var(--color-signal-fill)' : 'var(--color-text-tertiary)' }} />
              </div>
              <span className="text-right font-mono text-[11px] tabular-nums">
                {fmtNum(cell.used)}/{fmtNum(cell.max)}
              </span>
            </li>
          ))}
        </ul>
      </Panel>
      <p className="font-mono text-[11px] text-text-tertiary">projects: {tenant.projects.join(', ')}</p>
      <div className="flex flex-wrap gap-2">
        <ButtonLink href={`/quotas?tenant=${id}`} size="small" variant="secondary">
          Quotas
        </ButtonLink>
        <ButtonLink href={`/reservations`} size="small" variant="secondary">
          Reservations
        </ButtonLink>
        <ButtonLink href={`/usage`} size="small" variant="secondary">
          Usage
        </ButtonLink>
      </div>
    </div>
  );
}

/**
 * One node's bookings as a per-GPU schedule (rows are the node's GPUs) plus the list: for the fleet's node views,
 * so a node page and /reservations name the same reservations.
 */
export function NodeBookings({ nodeId, backHours = 24, aheadHours = 72 }: { nodeId: string; backHours?: number; aheadHours?: number }) {
  const snapshot = useCapacity();
  const tenantName = useTenantName();
  const { from, to } = useHourWindow(backHours, aheadHours);
  const node = snapshot.nodes.find((entry) => entry.id === nodeId);
  const bookings = useMemo(
    () => snapshot.reservations.filter((r) => r.nodeIds?.includes(nodeId) && r.during && r.during.end > from && r.during.start < to).sort((a, b) => a.during!.start - b.during!.start),
    [snapshot, nodeId, from, to],
  );
  if (!node) return <EmptyState title="No GPU bookings for this node">It has no GPUs, or it is not in a GPU pool.</EmptyState>;
  return (
    <div className="flex flex-col gap-3">
      <ReservationGantt reservations={bookings} nodes={[node]} from={from} to={to} now={snapshot.now} tenantName={tenantName} gpusPerNode={node.gpus} maxHeight={200} />
      <GanttLegend />
      <ul>
        {bookings.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-2 border-b border-separator-border py-1.5 last:border-0">
            <EntityLink kind="reservation" id={r.id} href={`/reservations?id=${r.id}`} />
            <StateTag state={r.state} />
            <span className="text-caption-1-regular text-text-secondary">{tenantName(r.tenantId)}</span>
            <span className="ml-auto font-mono text-[11px] tabular-nums text-text-secondary">
              {(r.atoms ?? []).filter((atom) => atom.startsWith(`${nodeId}/`)).length} GPU · {fmtStamp(r.during!.start)} → {fmtStamp(r.during!.end)}
            </span>
          </li>
        ))}
        {!bookings.length && <li className="py-2 text-caption-1-regular text-text-tertiary">No bookings in this window.</li>}
      </ul>
      <Link href={`/pools/${node.poolId}?tab=schedule`} className="font-mono text-[11px] text-signal hover:underline">
        the whole pool's schedule →
      </Link>
    </div>
  );
}
