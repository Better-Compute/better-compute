import { capacityAt, DAY, HOUR, reservationGpus, sharedCapacitySource, type CapacitySnapshot, type CapacityTimeline } from '@/lib/data/capacity';
import type { WatchState } from '@/lib/modules';
import { liveState, liveTimeline } from './live';
import { poolRows, quotaCells } from './model';

// Watch-list describers for capacity entities: one line of state per watched pool, reservation or tenant. The
// shell polls them at `now` and toasts when a status changes, so summaries only change when something happened.

type Context = { source?: 'simulated' | 'live' } | undefined;

function source(now: number, context: Context): { snapshot?: CapacitySnapshot; timeline(poolId: string, from: number, to: number): CapacityTimeline | undefined } {
  if (context?.source === 'live') {
    const state = liveState();
    const tenantId = state.tenantId ?? state.snapshot?.tenantId ?? '';
    return { snapshot: state.snapshot, timeline: (poolId, from, to) => liveTimeline(tenantId, poolId, from, to, 60) };
  }
  const snapshot = capacityAt(now);
  const sim = sharedCapacitySource();
  return { snapshot, timeline: (poolId, from, to) => sim.timelineSync(poolId, { from, to }) };
}

const clock = (t: number) => new Date(t).toISOString().slice(11, 16);
const pct = (ratio: number) => `${Math.round(ratio * 100)}%`;

export function watchPool(id: string, now: number, context: Context): WatchState | null {
  const { snapshot, timeline } = source(now, context);
  if (!snapshot) return null;
  const row = poolRows(snapshot).find((entry) => entry.id === id);
  if (!row) return { label: id, status: 'off', summary: 'not visible to this tenant', href: `/pools/${id}` };
  const outShare = row.total ? row.unavailable / row.total : 0;
  const hour = Math.floor(snapshot.now / HOUR) * HOUR;
  const next = row.unit === 'gpu' ? timeline(id, hour, hour + DAY) : undefined;
  const fullAt = next?.buckets.find((bucket) => bucket.start >= hour && bucket.free <= 0);
  const unit = row.unit === 'gpu' ? 'free' : 'vCPU free';
  const summary = `${pct(row.utilization)} booked · ${row.freeNow} ${unit} · ${row.pending} waiting${fullAt ? ` · full at ${clock(fullAt.start)}` : ''}`;
  return {
    label: row.name,
    status: outShare > 0.25 ? 'crit' : fullAt ? 'warn' : row.pending > 0 ? 'pending' : 'ok',
    summary: outShare > 0.25 ? `${pct(outShare)} out of service · ${summary}` : summary,
    href: `/pools/${id}`,
  };
}

export function watchReservation(id: string, now: number, context: Context): WatchState | null {
  const { snapshot } = source(now, context);
  if (!snapshot) return null;
  const r = snapshot.reservations.find((entry) => entry.id === id);
  const href = `/reservations?id=${id}`;
  if (!r) return { label: id, status: 'off', summary: 'gone (outside the loaded window, or deleted)', href };
  const label = `${id} · ${reservationGpus(r)} GPU`;
  const notice = r.conditions.find((condition) => condition.type === 'PreemptionNotice');
  switch (r.state) {
    case 'active':
    case 'binding':
    case 'releasing':
      if (notice) return { label, status: 'warn', summary: `preemption notice · until ${clock(r.during!.end)}`, href };
      return { label, status: 'live', summary: `${r.state} until ${clock(r.during!.end)} UTC`, href };
    case 'placed':
      return { label, status: 'pending', summary: `placed · starts ${clock(r.during!.start)} UTC`, href };
    case 'pending':
    case 'awaiting-confirmation':
      return { label, status: 'pending', summary: r.state === 'pending' ? 'waiting for capacity' : 'waiting for a confirmation', href };
    case 'failed':
    case 'denied':
      return { label, status: 'crit', summary: `${r.state}${r.conditions[0]?.reason ? `: ${r.conditions[0].reason}` : ''}`, href };
    default:
      return { label, status: 'off', summary: `${r.state}${r.during ? ` at ${clock(r.during.end)} UTC` : ''}`, href };
  }
}

export function watchTenant(id: string, now: number, context: Context): WatchState | null {
  const { snapshot } = source(now, context);
  if (!snapshot) return null;
  const tenant = snapshot.tenants.find((entry) => entry.id === id);
  const href = `/capacity/tenants/${id}`;
  if (!tenant) return { label: id, status: 'off', summary: 'no such tenant here', href };
  const gpuQuotas = quotaCells(snapshot.quotas.filter((q) => q.tenantId === id && q.resource === 'gpu'));
  const fullest = gpuQuotas.sort((a, b) => b.ratio - a.ratio)[0];
  const own = snapshot.reservations.filter((r) => r.tenantId === id);
  const gpus = own.filter((r) => r.state === 'active' || r.state === 'binding').reduce((sum, r) => sum + reservationGpus(r), 0);
  const pending = own.filter((r) => r.state === 'pending' || r.state === 'awaiting-confirmation').length;
  const ratio = fullest?.ratio ?? 0;
  return {
    label: tenant.name,
    status: fullest?.level === 'full' ? 'crit' : ratio >= 0.9 ? 'warn' : pending ? 'pending' : 'ok',
    summary: `${gpus} GPUs now · ${pending} waiting${fullest ? ` · fullest quota ${pct(ratio)} (${fullest.poolId})` : ''}`,
    href,
  };
}
