// What-if scenarios over the capacity book: take nodes out, add nodes, or add a burst of demand, and compare every
// pool against the baseline over the next week. Pure functions over the timelines and the snapshot; the page
// renders them. A scenario is plain JSON, so it round-trips through the URL for sharing.

import { earliestFit } from '@better-compute/console-kit';
import { DAY, HOUR, liveStates, type CapacityNode, type CapacitySnapshot, type CapacityTimeline, type Reservation } from '@/lib/data/capacity';

export type Change =
  | { id: string; kind: 'maintenance'; poolId: string; nodes: number; startHours: number; hours: number }
  | { id: string; kind: 'expand'; poolId: string; nodes: number; startHours: number }
  | { id: string; kind: 'burst'; poolId: string; gpus: number; startHours: number; hours: number };

export type ChangeKind = Change['kind'];

export const KIND_LABEL: Record<ChangeKind, string> = {
  maintenance: 'Take nodes out',
  expand: 'Add nodes',
  burst: 'Demand burst',
};

export interface PoolOutcome {
  poolId: string;
  /** Hours with no GPU free, over the horizon. */
  hoursFull: number;
  /** The highest share booked (demand ÷ schedulable, may exceed 1 under a burst). */
  peak: number;
  minFree: number;
  /** When 8 GPUs (or a whole node) are next free for 24 h, ms from the horizon start; undefined if never. */
  earliest8x24?: number;
  /** GPU-hours booked on capacity the scenario removes: those reservations must move or be preempted. */
  displacedGpuHours: number;
  /** GPU-hours of extra demand that find no free GPU. */
  unmetGpuHours: number;
  free: number[];
  booked: number[];
  allocatable: number[];
}

export interface Outcome {
  from: number;
  hours: number;
  pools: Map<string, PoolOutcome>;
}

/** Applies the changes to hourly timelines starting at `from` (whole hours), for `hours` hours. */
export function evaluate(
  timelines: ReadonlyMap<string, CapacityTimeline>,
  gpusPerNode: ReadonlyMap<string, number>,
  changes: readonly Change[],
  from: number,
  hours: number,
): Outcome {
  const pools = new Map<string, PoolOutcome>();
  for (const [poolId, timeline] of timelines) {
    const perNode = gpusPerNode.get(poolId) ?? 8;
    const booked = Array.from({ length: hours }, (_, index) => timeline.buckets[index]?.booked ?? 0);
    const allocatable = Array.from({ length: hours }, () => timeline.allocatable);
    const burst = new Array<number>(hours).fill(0);
    for (const change of changes) {
      if (change.poolId !== poolId) continue;
      const start = Math.max(0, change.startHours);
      const end = change.kind === 'expand' ? hours : Math.min(hours, start + change.hours);
      for (let index = start; index < end; index += 1) {
        if (change.kind === 'maintenance') allocatable[index] = Math.max(0, allocatable[index]! - change.nodes * perNode);
        else if (change.kind === 'expand') allocatable[index] = allocatable[index]! + change.nodes * perNode;
        else burst[index]! += change.gpus;
      }
    }
    let displaced = 0;
    let unmet = 0;
    const free: number[] = [];
    const bookedOut: number[] = [];
    for (let index = 0; index < hours; index += 1) {
      const capacity = allocatable[index]!;
      const kept = Math.min(booked[index]!, capacity);
      displaced += booked[index]! - kept;
      const room = capacity - kept;
      const served = Math.min(burst[index]!, room);
      unmet += burst[index]! - served;
      free.push(room - served);
      bookedOut.push(booked[index]! + burst[index]!);
    }
    const adjusted: CapacityTimeline = {
      poolId,
      allocatable: timeline.allocatable,
      buckets: free.map((value, index) => ({ start: from + index * HOUR, end: from + (index + 1) * HOUR, booked: bookedOut[index]!, free: value })),
    };
    const fit = earliestFit(adjusted, Math.min(8, perNode), DAY, { notBefore: from });
    pools.set(poolId, {
      poolId,
      hoursFull: free.filter((value) => value <= 0).length,
      peak: Math.max(0, ...bookedOut.map((value, index) => (allocatable[index]! > 0 ? value / allocatable[index]! : value > 0 ? 1 : 0))),
      minFree: Math.min(...free),
      ...(fit !== undefined ? { earliest8x24: fit - from } : {}),
      displacedGpuHours: displaced,
      unmetGpuHours: unmet,
      free,
      booked: bookedOut,
      allocatable,
    });
  }
  return { from, hours, pools };
}

/**
 * For "take N nodes out" over a window: the N schedulable nodes whose GPUs are least booked in the window, and
 * the reservations that touch them (which would have to move). Picking these is what an operator would do by hand.
 */
export function leastDisruptiveNodes(snapshot: CapacitySnapshot, poolId: string, count: number, start: number, end: number, pinned: readonly string[] = []) {
  // Pinned nodes (e.g. already cordoned for this plan) stay in the plan whatever their health now.
  const nodes = snapshot.nodes.filter((node) => node.poolId === poolId && (node.health === 'ok' || pinned.includes(node.id)));
  const load = new Map<string, { gpuHours: number; reservations: Set<string> }>(nodes.map((node) => [node.id, { gpuHours: 0, reservations: new Set() }]));
  const touching = new Map<string, Reservation>();
  for (const reservation of snapshot.reservations) {
    if (reservation.poolId !== poolId || !reservation.during || !liveStates.has(reservation.state)) continue;
    const overlap = Math.min(end, reservation.during.end) - Math.max(start, reservation.during.start);
    if (overlap <= 0) continue;
    for (const atom of reservation.atoms ?? []) {
      const nodeId = atom.slice(0, atom.lastIndexOf('/'));
      const entry = load.get(nodeId);
      if (!entry) continue;
      entry.gpuHours += overlap / HOUR;
      entry.reservations.add(reservation.id);
      touching.set(reservation.id, reservation);
    }
  }
  const chosen = [...nodes]
    .sort((a, b) => Number(pinned.includes(b.id)) - Number(pinned.includes(a.id)) || load.get(a.id)!.gpuHours - load.get(b.id)!.gpuHours || a.id.localeCompare(b.id))
    .slice(0, count);
  const affected = new Set(chosen.flatMap((node) => [...load.get(node.id)!.reservations]));
  return {
    nodes: chosen as CapacityNode[],
    gpuHours: chosen.reduce((sum, node) => sum + load.get(node.id)!.gpuHours, 0),
    reservations: [...affected].map((id) => touching.get(id)!).sort((a, b) => a.during!.start - b.during!.start),
  };
}

let counter = 0;
export const newId = () => `c${Date.now().toString(36)}${(counter++).toString(36)}`;

/** URL-safe encoding of a change list (short keys). */
export function encodeScenario(changes: readonly Change[]): string {
  const compact = changes.map((change) =>
    change.kind === 'burst'
      ? ['b', change.poolId, change.gpus, change.startHours, change.hours]
      : change.kind === 'expand'
        ? ['e', change.poolId, change.nodes, change.startHours]
        : ['m', change.poolId, change.nodes, change.startHours, change.hours],
  );
  return btoa(JSON.stringify(compact)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeScenario(text: string | null | undefined): Change[] {
  if (!text) return [];
  try {
    const raw = JSON.parse(atob(text.replace(/-/g, '+').replace(/_/g, '/'))) as unknown[];
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((entry, index): Change[] => {
      if (!Array.isArray(entry) || typeof entry[1] !== 'string') return [];
      const num = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : fallback);
      const id = `u${index}`;
      if (entry[0] === 'b') return [{ id, kind: 'burst', poolId: entry[1], gpus: num(entry[2], 8), startHours: num(entry[3], 0), hours: num(entry[4], 24) }];
      if (entry[0] === 'e') return [{ id, kind: 'expand', poolId: entry[1], nodes: num(entry[2], 1), startHours: num(entry[3], 0) }];
      if (entry[0] === 'm') return [{ id, kind: 'maintenance', poolId: entry[1], nodes: num(entry[2], 1), startHours: num(entry[3], 0), hours: num(entry[4], 8) }];
      return [];
    });
  } catch {
    return [];
  }
}
