// Pure view models over a CapacitySnapshot: numbers only, no React. Every page and widget of the capacity module
// reads through these, so a figure means the same thing everywhere (and the rollup semantics stay the API's:
// `available` is conservative, "free now" is allocatable − allocated).

import { earliestFit } from '@better-compute/console-kit';
import {
  DAY,
  HOUR,
  holdsDevices,
  liveStates,
  rowFree,
  reservationGpus,
  type AdminPool,
  type CapacityRow,
  type CapacitySnapshot,
  type CapacityTimeline,
  type QuotaRow,
  type Reservation,
  type ReservationState,
  type UsageWindow,
} from '@/lib/data/capacity';
import { poolById } from '@/lib/data/topology';

export interface PoolRow {
  pool: AdminPool;
  id: string;
  name: string;
  short: string;
  siteId: string;
  /** GPU pools book GPUs; CPU/sandbox pools book vCPUs. */
  unit: 'gpu' | 'vcpu';
  row: CapacityRow;
  total: number;
  allocatable: number;
  allocated: number;
  reserved: number;
  /** The API's conservative `available` (an atom booked now and later counts twice). */
  available: number;
  /** allocatable − allocated: free at this moment. */
  freeNow: number;
  unavailable: number;
  utilization: number;
  active: number;
  pending: number;
  startingSoon: number;
  endingSoon: number;
  tenants: number;
  price: number;
}

export const unitLabel = (unit: 'gpu' | 'vcpu', count = 2) => (unit === 'gpu' ? (count === 1 ? 'GPU' : 'GPUs') : count === 1 ? 'vCPU' : 'vCPUs');

export function poolRows(snapshot: CapacitySnapshot, scope: { siteId?: string } = {}): PoolRow[] {
  const bySummary = new Map(snapshot.summary.pools.map((entry) => [entry.poolId, entry]));
  const soon = snapshot.now + 6 * HOUR;
  const counts = new Map<string, { active: number; pending: number; startingSoon: number; endingSoon: number }>();
  for (const reservation of snapshot.reservations) {
    const entry = counts.get(reservation.poolId) ?? { active: 0, pending: 0, startingSoon: 0, endingSoon: 0 };
    if (reservation.state === 'active' || reservation.state === 'binding') entry.active += 1;
    if (reservation.state === 'pending' || reservation.state === 'awaiting-confirmation') entry.pending += 1;
    if (reservation.state === 'placed' && reservation.during && reservation.during.start <= soon) entry.startingSoon += 1;
    if ((reservation.state === 'active' || reservation.state === 'binding') && reservation.during && reservation.during.end <= soon) entry.endingSoon += 1;
    counts.set(reservation.poolId, entry);
  }
  const tenants = new Map<string, Set<string>>();
  for (const offer of snapshot.offers) {
    const set = tenants.get(offer.poolId) ?? new Set<string>();
    set.add(offer.tenantId);
    tenants.set(offer.poolId, set);
  }
  return snapshot.pools
    .filter((pool) => !scope.siteId || pool.siteId === scope.siteId)
    .flatMap((pool) => {
      const summary = bySummary.get(pool.id);
      const gpuRow = summary?.capacity.find((row) => row.resource === 'gpu');
      const row = gpuRow ?? summary?.capacity.find((row) => row.resource === 'vcpu');
      if (!row) return [];
      const topo = poolById(pool.id);
      const unavailable = (row.provisioning ?? 0) + (row.unhealthy ?? 0) + (row.maintenance ?? 0) + (row.unreachable ?? 0);
      const count = counts.get(pool.id) ?? { active: 0, pending: 0, startingSoon: 0, endingSoon: 0 };
      const { freeNow, utilization } = rowFree(row);
      return [
        {
          pool,
          id: pool.id,
          name: topo?.name ?? pool.id,
          short: topo?.short ?? pool.gpuModel ?? '',
          siteId: pool.siteId,
          unit: gpuRow ? 'gpu' : 'vcpu',
          row,
          total: row.total,
          allocatable: row.allocatable,
          // In use on schedulable nodes, so allocated + free + out of service add up to the total in every bar.
          // The API's own `allocated` (which also counts bookings on broken nodes) stays on `row`.
          allocated: row.allocatable - freeNow,
          reserved: row.reserved,
          available: row.available,
          freeNow,
          unavailable: Math.max(unavailable, row.total - row.allocatable),
          utilization,
          ...count,
          tenants: tenants.get(pool.id)?.size ?? 0,
          price: topo?.price ?? 0,
        } satisfies PoolRow,
      ];
    });
}

export interface FleetTotals {
  gpus: number;
  allocatable: number;
  allocated: number;
  reserved: number;
  freeNow: number;
  unavailable: number;
  utilization: number;
  active: number;
  pending: number;
  pools: number;
  vcpus: { total: number; allocated: number };
}

export function fleetTotals(rows: readonly PoolRow[]): FleetTotals {
  const gpu = rows.filter((row) => row.unit === 'gpu');
  const sum = (list: readonly PoolRow[], pick: (row: PoolRow) => number) => list.reduce((total, row) => total + pick(row), 0);
  const allocatable = sum(gpu, (row) => row.allocatable);
  const allocated = sum(gpu, (row) => row.allocated);
  const cpu = rows.filter((row) => row.unit === 'vcpu');
  return {
    gpus: sum(gpu, (row) => row.total),
    allocatable,
    allocated,
    reserved: sum(gpu, (row) => row.reserved),
    freeNow: sum(gpu, (row) => row.freeNow),
    unavailable: sum(gpu, (row) => row.unavailable),
    utilization: allocatable ? allocated / allocatable : 0,
    active: sum(rows, (row) => row.active),
    pending: sum(rows, (row) => row.pending),
    pools: rows.length,
    vcpus: { total: sum(cpu, (row) => row.allocatable), allocated: sum(cpu, (row) => row.allocated) },
  };
}

/** GPUs by model across GPU pools, largest first. */
export function byModel(rows: readonly PoolRow[]) {
  const models = new Map<string, { short: string; total: number; allocatable: number; allocated: number; reserved: number; freeNow: number; pools: number; price: number }>();
  for (const row of rows) {
    if (row.unit !== 'gpu') continue;
    const key = row.short.replace(/\s+MIG$/, ' MIG');
    const entry = models.get(key) ?? { short: key, total: 0, allocatable: 0, allocated: 0, reserved: 0, freeNow: 0, pools: 0, price: row.price };
    entry.total += row.total;
    entry.allocatable += row.allocatable;
    entry.allocated += row.allocated;
    entry.reserved += row.reserved;
    entry.freeNow += row.freeNow;
    entry.pools += 1;
    models.set(key, entry);
  }
  return [...models.values()].sort((a, b) => b.total - a.total);
}

// --- Time -------------------------------------------------------------------------------------------------

/** Hourly booked ratio per pool, for the heatmap: rows × columns. */
export interface HeatMatrix {
  from: number;
  step: number;
  columns: number;
  rows: { row: PoolRow; timeline: CapacityTimeline; ratios: number[] }[];
}

export function heatMatrix(rows: readonly PoolRow[], timelines: ReadonlyMap<string, CapacityTimeline>, from: number, step: number, columns: number): HeatMatrix {
  return {
    from,
    step,
    columns,
    rows: rows
      .filter((row) => row.unit === 'gpu' && timelines.has(row.id))
      .map((row) => {
        const timeline = timelines.get(row.id)!;
        const ratios = timeline.buckets.map((bucket) => (timeline.allocatable > 0 ? Math.min(1, bucket.booked / timeline.allocatable) : 1));
        return { row, timeline, ratios };
      }),
  };
}

/** Fleet-wide booked/allocatable series over the timelines (the forecast chart). */
export function fleetSeries(timelines: readonly CapacityTimeline[]) {
  const first = timelines[0];
  if (!first) return { times: [] as number[], booked: [] as number[], allocatable: [] as number[] };
  const times = first.buckets.map((bucket) => bucket.start);
  const booked = times.map((_, index) => timelines.reduce((total, timeline) => total + (timeline.buckets[index]?.booked ?? 0), 0));
  const allocatable = times.map(() => timelines.reduce((total, timeline) => total + timeline.allocatable, 0));
  return { times, booked, allocatable };
}

/**
 * Pressure per pool: when N GPUs on one node are next free for D (console-kit's earliestFit over the
 * timeline, which counts whole-pool GPUs; the placer decides per node, so this is a lower bound).
 */
export function pressure(row: PoolRow, timeline: CapacityTimeline, now: number, gpus = 8, durationMs = DAY) {
  const start = earliestFit(timeline, Math.min(gpus, row.allocatable), durationMs, { notBefore: Math.floor(now / HOUR) * HOUR });
  return { start, waitMs: start === undefined ? undefined : Math.max(0, start - now) };
}

// --- Reservations -------------------------------------------------------------------------------------------

export type StateTone = 'live' | 'pending' | 'ok' | 'off' | 'crit' | 'warn';

/** How a state reads everywhere: LED/tag status and the Gantt bar style. */
export const stateStyle: Record<ReservationState, { status: StateTone; label: string; order: number }> = {
  draft: { status: 'off', label: 'draft', order: 9 },
  denied: { status: 'crit', label: 'denied', order: 8 },
  'awaiting-confirmation': { status: 'pending', label: 'awaiting confirmation', order: 1 },
  pending: { status: 'pending', label: 'pending', order: 2 },
  placed: { status: 'pending', label: 'placed', order: 3 },
  binding: { status: 'warn', label: 'binding', order: 4 },
  active: { status: 'live', label: 'active', order: 5 },
  releasing: { status: 'warn', label: 'releasing', order: 6 },
  released: { status: 'ok', label: 'released', order: 7 },
  expired: { status: 'ok', label: 'expired', order: 7 },
  cancelled: { status: 'off', label: 'cancelled', order: 8 },
  failed: { status: 'crit', label: 'failed', order: 8 },
};

/** Reservations whose window overlaps [from, to), live first. */
export function inWindow(reservations: readonly Reservation[], from: number, to: number) {
  return reservations.filter((reservation) => {
    if (!reservation.during) return reservation.state === 'pending' || reservation.state === 'awaiting-confirmation';
    return reservation.during.end > from && reservation.during.start < to;
  });
}

/**
 * Lane packing for a Gantt without atom data: greedy interval partitioning (first lane whose last bar ended),
 * sorted by start. Returns lane index per reservation id.
 */
export function packLanes(reservations: readonly Reservation[]): { lanes: number; laneOf: Map<string, number> } {
  const sorted = reservations.filter((entry) => entry.during).sort((a, b) => a.during!.start - b.during!.start);
  const ends: number[] = [];
  const laneOf = new Map<string, number>();
  for (const reservation of sorted) {
    let lane = ends.findIndex((end) => end <= reservation.during!.start);
    if (lane === -1) {
      lane = ends.length;
      ends.push(0);
    }
    ends[lane] = reservation.during!.end;
    laneOf.set(reservation.id, lane);
  }
  return { lanes: ends.length, laneOf };
}

/** GPU index range of a reservation on one node, from its atoms (`<node>/gpu<i>`). */
export function atomSpan(reservation: Reservation, nodeId: string): [number, number] | undefined {
  const indices = (reservation.atoms ?? [])
    .filter((atom) => atom.startsWith(`${nodeId}/gpu`))
    .map((atom) => Number(atom.slice(nodeId.length + 4)));
  if (!indices.length) return undefined;
  return [Math.min(...indices), Math.max(...indices)];
}

/** Per-atom state now, for the rack view: allocated, booked later, free, or out of service. */
export type AtomState = 'allocated' | 'reserved' | 'free' | 'unavailable';

export function atomStates(snapshot: CapacitySnapshot, poolId: string) {
  const nodes = snapshot.nodes.filter((node) => node.poolId === poolId);
  const now = snapshot.now;
  const holder = new Map<string, Reservation>();
  const later = new Map<string, Reservation>();
  for (const reservation of snapshot.reservations) {
    if (reservation.poolId !== poolId || !reservation.during || !liveStates.has(reservation.state)) continue;
    for (const atom of reservation.atoms ?? []) {
      if (reservation.during.start <= now && reservation.during.end > now) holder.set(atom, reservation);
      else if (reservation.during.start > now) {
        const current = later.get(atom);
        if (!current || current.during!.start > reservation.during.start) later.set(atom, reservation);
      }
    }
  }
  return nodes.map((node) => ({
    node,
    atoms: Array.from({ length: node.gpus }, (_, index) => {
      const id = `${node.id}/gpu${index}`;
      const now_ = holder.get(id);
      const next = later.get(id);
      const state: AtomState = node.health !== 'ok' ? 'unavailable' : now_ ? 'allocated' : next ? 'reserved' : 'free';
      return { id, index, state, holder: now_, next };
    }),
  }));
}

// --- Money ---------------------------------------------------------------------------------------------------

export const costOf = (window: UsageWindow, prices: Readonly<Record<string, number>>) => window.quantity * (prices[window.meter] ?? 0);

/** Spend so far of a reservation, from its usage windows. */
export function reservationSpend(reservation: Reservation, usage: readonly UsageWindow[], prices: Readonly<Record<string, number>>) {
  const allocationId = `alc_${reservation.id.slice(4)}`;
  return usage.filter((window) => window.allocationId === allocationId).reduce((total, window) => total + costOf(window, prices), 0);
}

/** Sums usage per key, largest first. */
export function rollup<K extends string>(usage: readonly UsageWindow[], key: (window: UsageWindow) => K, prices: Readonly<Record<string, number>>) {
  const map = new Map<K, { key: K; quantity: number; cost: number; windows: number }>();
  for (const window of usage) {
    const k = key(window);
    const entry = map.get(k) ?? { key: k, quantity: 0, cost: 0, windows: 0 };
    entry.quantity += window.quantity;
    entry.cost += costOf(window, prices);
    entry.windows += 1;
    map.set(k, entry);
  }
  return [...map.values()].sort((a, b) => b.cost - a.cost || b.quantity - a.quantity);
}

/** Daily totals (UTC days) of cost and GPU-hours for [from, to). */
export function dailySpend(usage: readonly UsageWindow[], prices: Readonly<Record<string, number>>, from: number, to: number) {
  const start = Math.floor(from / DAY) * DAY;
  const days = Math.max(1, Math.ceil((to - start) / DAY));
  const cost = new Array<number>(days).fill(0);
  const gpuHours = new Array<number>(days).fill(0);
  for (const window of usage) {
    const index = Math.floor((window.windowStart - start) / DAY);
    if (index < 0 || index >= days) continue;
    cost[index]! += costOf(window, prices);
    if (window.meter.startsWith('gpu.')) gpuHours[index]! += window.quantity;
  }
  return { times: Array.from({ length: days }, (_, index) => start + index * DAY), cost, gpuHours };
}

// --- Quotas ---------------------------------------------------------------------------------------------------

export interface QuotaCell {
  tenantId: string;
  poolId: string;
  resource: string;
  max: number;
  used: number;
  ratio: number;
  level: 'ok' | 'warning' | 'full';
}

export function quotaCells(quotas: readonly QuotaRow[], warnAt = 0.8): QuotaCell[] {
  return quotas.map((row) => {
    const ratio = row.max > 0 ? Math.min(1, row.used / row.max) : row.used > 0 ? 1 : 0;
    const available = row.available ?? Math.max(0, row.max - row.used);
    return {
      tenantId: row.tenantId ?? '',
      poolId: row.poolId,
      resource: row.resource,
      max: row.max,
      used: row.used,
      ratio,
      level: row.max > 0 && available <= 0 ? 'full' : ratio >= warnAt ? 'warning' : 'ok',
    };
  });
}

/** Whether a state still holds (or will hold) devices: the "live" filter of lists. */
export const isLive = (state: ReservationState) => liveStates.has(state);
export { holdsDevices, reservationGpus };
