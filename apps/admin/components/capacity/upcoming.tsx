'use client';

import { useMemo } from 'react';
import { EntityLink } from '@/components/shell/peek';
import { EmptyState } from '@/components/ui/panel';
import { Tag } from '@/components/ui/signal';
import { fmtNum, fmtRelative } from '@/lib/data/format';
import { HOUR, reservationGpus } from '@/lib/data/capacity';
import { usePoolRows, useTenantName } from './data';

// Two small building blocks the capacity pages and widgets share: what starts or ends soon, and who holds GPUs now.

export interface UpcomingEvent {
  t: number;
  kind: 'starts' | 'ends';
  id: string;
  tenantId: string;
  poolId: string;
  gpus: number;
}

export function useUpcoming(options: { poolId?: string; hours?: number; show?: 'both' | 'starts' | 'ends'; minGpus?: number } = {}) {
  const { snapshot, rows } = usePoolRows();
  const inScope = useMemo(() => new Set(rows.map((row) => row.id)), [rows]);
  const { poolId, hours = 6, show = 'both', minGpus = 1 } = options;
  const events = useMemo(() => {
    const until = snapshot.now + hours * HOUR;
    const list: UpcomingEvent[] = [];
    for (const r of snapshot.reservations) {
      if (!r.during || (poolId ? r.poolId !== poolId : !inScope.has(r.poolId))) continue;
      const gpus = reservationGpus(r);
      if (gpus < minGpus) continue;
      if (show !== 'ends' && r.state === 'placed' && r.during.start > snapshot.now && r.during.start <= until) list.push({ t: r.during.start, kind: 'starts', id: r.id, tenantId: r.tenantId, poolId: r.poolId, gpus });
      if (show !== 'starts' && (r.state === 'active' || r.state === 'binding') && r.during.end > snapshot.now && r.during.end <= until) list.push({ t: r.during.end, kind: 'ends', id: r.id, tenantId: r.tenantId, poolId: r.poolId, gpus });
    }
    return list.sort((a, b) => a.t - b.t);
  }, [snapshot, inScope, poolId, hours, show, minGpus]);
  return { events, now: snapshot.now };
}

export function UpcomingList({ poolId, hours = 6, show, minGpus, limit = 40, showPool = !poolId }: { poolId?: string; hours?: number; show?: 'both' | 'starts' | 'ends'; minGpus?: number; limit?: number; showPool?: boolean }) {
  const { events, now } = useUpcoming({ ...(poolId ? { poolId } : {}), hours, ...(show ? { show } : {}), ...(minGpus ? { minGpus } : {}) });
  const tenantName = useTenantName();
  if (!events.length) return <EmptyState title={`Nothing starts or ends in the next ${hours} hours`} className="py-6" />;
  return (
    <ul>
      {events.slice(0, limit).map((event) => (
        <li key={`${event.id}:${event.kind}`} className="flex items-center gap-2 border-b border-separator-border px-3 py-1.5 last:border-0">
          <span className="w-14 shrink-0 font-mono text-[11px] tabular-nums text-text-tertiary">{fmtRelative(event.t, now)}</span>
          <Tag status={event.kind === 'starts' ? 'pending' : 'ok'} led={event.kind === 'starts'} className="w-14 justify-center">
            {event.kind}
          </Tag>
          <EntityLink kind="reservation" id={event.id} href={`/reservations?id=${event.id}`} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate text-caption-1-regular text-text-secondary">
            {tenantName(event.tenantId)}
            {showPool && <span className="font-mono text-[10px] text-text-tertiary"> · {event.poolId}</span>}
          </span>
          <span className="shrink-0 font-mono text-[12px] tabular-nums">{event.gpus} GPU</span>
        </li>
      ))}
      {events.length > limit && <li className="px-3 py-1.5 font-mono text-[11px] text-text-tertiary">and {events.length - limit} more</li>}
    </ul>
  );
}

/** Tenants holding GPUs now (optionally in one pool), largest first, with a bar each. */
export function Holders({ poolId, limit = 8 }: { poolId?: string; limit?: number }) {
  const { snapshot, rows } = usePoolRows();
  const tenantName = useTenantName();
  const inScope = useMemo(() => new Set(rows.map((row) => row.id)), [rows]);
  const list = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of snapshot.reservations) {
      if ((poolId ? r.poolId !== poolId : !inScope.has(r.poolId)) || (r.state !== 'active' && r.state !== 'binding')) continue;
      map.set(r.tenantId, (map.get(r.tenantId) ?? 0) + reservationGpus(r));
    }
    return [...map].sort((a, b) => b[1] - a[1]);
  }, [snapshot, inScope, poolId]);
  if (!list.length) return <EmptyState title="Nobody holds GPUs here now" className="py-6" />;
  return (
    <ul className="flex flex-col gap-2">
      {list.slice(0, limit).map(([tenantId, gpus]) => (
        <li key={tenantId} className="grid grid-cols-[9rem_1fr_4rem] items-center gap-3">
          <EntityLink kind="tenant" id={tenantId} href={`/capacity/tenants/${tenantId}`} className="truncate font-sans text-caption-1-medium">
            {tenantName(tenantId)}
          </EntityLink>
          <div className="h-2 bg-background-secondary-default">
            <div className="h-full bg-signal-fill" style={{ width: `${(gpus / (list[0]?.[1] || 1)) * 100}%` }} />
          </div>
          <span className="text-right font-mono text-[12px] tabular-nums">{fmtNum(gpus)}</span>
        </li>
      ))}
    </ul>
  );
}
