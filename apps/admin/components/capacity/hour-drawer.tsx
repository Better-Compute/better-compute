'use client';

import { useMemo } from 'react';
import { RiAddLine, RiArrowRightUpLine } from 'react-icons/ri';
import { ButtonLink } from '@/components/base/buttons/button';
import { EntityLink } from '@/components/shell/peek';
import { StackedBar } from '@/components/ui/charts';
import { Drawer } from '@/components/ui/overlay';
import { EmptyState } from '@/components/ui/panel';
import { fmtNum, fmtPct, fmtStamp } from '@/lib/data/format';
import { HOUR, holdsDevices, reservationGpus } from '@/lib/data/capacity';
import { useCapacity, usePoolRows, useTenantName, useTimeline } from './data';
import { planHref, StateTag } from './ui';

/**
 * One pool at one hour: who holds its GPUs, by tenant and by reservation, what starts or ends within the hour,
 * and the way on (the pool's schedule, or planning a booking right then).
 */
export function HourDrawer({ target, onClose }: { target?: { poolId: string; t: number }; onClose(): void }) {
  const snapshot = useCapacity();
  const { rows } = usePoolRows();
  const tenantName = useTenantName();
  const start = target ? Math.floor(target.t / HOUR) * HOUR : 0;
  const end = start + HOUR;
  const row = rows.find((entry) => entry.id === target?.poolId);
  const timeline = useTimeline(target?.poolId, start, end);
  const bucket = timeline?.buckets[0];

  const holding = useMemo(
    () =>
      target
        ? snapshot.reservations
            .filter((r) => r.poolId === target.poolId && r.during && holdsDevices(r.state) && r.during.start < end && r.during.end > start)
            .sort((a, b) => reservationGpus(b) - reservationGpus(a))
        : [],
    [snapshot.reservations, target, start, end],
  );
  const byTenant = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of holding) map.set(r.tenantId, (map.get(r.tenantId) ?? 0) + reservationGpus(r));
    return [...map].sort((a, b) => b[1] - a[1]);
  }, [holding]);
  const starting = holding.filter((r) => r.during!.start >= start);
  const ending = holding.filter((r) => r.during!.end <= end);

  if (!target) return null;
  const allocatable = timeline?.allocatable ?? row?.allocatable ?? 0;
  const booked = bucket?.booked ?? 0;
  const past = end <= snapshot.now;
  return (
    <Drawer
      open={Boolean(target)}
      onOpenChange={(open) => !open && onClose()}
      title={`${row?.name ?? target.poolId} · ${fmtStamp(start)} UTC`}
      subtitle={past ? 'what was booked in that hour' : start > snapshot.now ? 'what is booked for that hour' : 'this hour'}
      width={560}
    >
      <div className="flex flex-col gap-5">
        <div>
          <div className="mb-1 flex items-baseline justify-between font-mono text-[12px]">
            <span>
              {fmtNum(booked)} of {fmtNum(allocatable)} GPUs booked
            </span>
            <span className="text-text-tertiary">{fmtPct(allocatable ? booked / allocatable : 0, 0)}</span>
          </div>
          <StackedBar
            height={10}
            total={Math.max(allocatable, booked)}
            parts={byTenant.map(([tenantId, gpus], index) => ({ label: tenantName(tenantId), value: gpus, tone: index === 0 ? 'signal' : 'neutral' }))}
          />
          <ul className="mt-2 flex flex-col gap-1">
            {byTenant.map(([tenantId, gpus]) => (
              <li key={tenantId} className="flex items-center justify-between text-caption-1-regular">
                <EntityLink kind="tenant" id={tenantId} href={`/capacity/tenants/${tenantId}`} className="font-sans">
                  {tenantName(tenantId)}
                </EntityLink>
                <span className="font-mono text-[12px] tabular-nums">{fmtNum(gpus)} GPU</span>
              </li>
            ))}
          </ul>
        </div>

        {(starting.length > 0 || ending.length > 0) && (
          <p className="font-mono text-[11px] text-text-secondary">
            within the hour: {starting.length} starting, {ending.length} ending
          </p>
        )}

        <section>
          <h3 className="mb-2 font-mono text-[11px] tracking-wide text-text-tertiary uppercase">Reservations ({holding.length})</h3>
          {holding.length ? (
            <ul className="border border-separator-border">
              {holding.slice(0, 40).map((r) => (
                <li key={r.id} className="flex items-center gap-2 border-b border-separator-border px-3 py-1.5 last:border-0">
                  <EntityLink kind="reservation" id={r.id} href={`/reservations?id=${r.id}`} />
                  <StateTag state={r.state} />
                  <span className="min-w-0 flex-1 truncate text-caption-1-regular text-text-secondary">{tenantName(r.tenantId)}</span>
                  <span className="font-mono text-[12px] tabular-nums">{reservationGpus(r)} GPU</span>
                </li>
              ))}
              {holding.length > 40 && <li className="px-3 py-1.5 font-mono text-[11px] text-text-tertiary">and {holding.length - 40} more</li>}
            </ul>
          ) : (
            <EmptyState title="Nothing booked in this hour" />
          )}
        </section>

        <div className="flex flex-wrap gap-2">
          <ButtonLink href={`/pools/${target.poolId}?tab=schedule`} size="small" variant="secondary" trailingIcon={RiArrowRightUpLine}>
            Pool schedule
          </ButtonLink>
          {!past && row?.unit === 'gpu' && (
            <ButtonLink href={planHref(target.poolId, Math.max(start, snapshot.now), end + 3 * HOUR)} size="small" leadingIcon={RiAddLine}>
              Plan a booking then
            </ButtonLink>
          )}
        </div>
      </div>
    </Drawer>
  );
}
