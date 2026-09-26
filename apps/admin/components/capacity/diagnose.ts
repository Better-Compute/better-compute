// "Why is this reservation still waiting?" as a list of checks an operator would run by hand: quota, whether the
// shape can ever fit this pool, whether enough of those nodes are in service, whether the window has the GPUs, and
// whether the free GPUs sit together on enough nodes. Pure over the snapshot and the pool's timeline; the drawer
// renders it. Node-level checks need the node list (the simulation has it; live mode falls back to the timeline).

import { earliestFit } from '@better-compute/console-kit';
import { DAY, durationMs, HOUR, liveStates, reservationGpus, type CapacitySnapshot, type CapacityTimeline, type Condition, type Reservation } from '@/lib/data/capacity';

export type CheckId = 'confirmation' | 'quota' | 'shape' | 'service' | 'capacity' | 'fragmentation';
export type Verdict = 'ok' | 'blocks' | 'unknown';

export interface WaitCheck {
  id: CheckId;
  verdict: Verdict;
  label: string;
  detail: string;
  /** A blocking check's cause in a few words, for one-line lists. */
  short?: string;
}

export interface Blocker {
  reservation: Reservation;
  /** GPUs it holds in this pool during the window. */
  gpus: number;
  /** Its GPU-hours inside the window. */
  gpuHours: number;
}

export interface WaitDiagnosis {
  window: { start: number; end: number };
  needed: { gpus: number; perNode: number; nodes: number };
  checks: WaitCheck[];
  /** The first check that blocks, if any. */
  cause?: WaitCheck;
  /** Pool-wide earliest window for the same size and length from its wanted start (the placer decides per node). */
  fitsAt?: number;
  /** The placer's own last word, when it reported the reservation unschedulable. */
  placer?: Condition;
  /** What is booked on the pool during the window, biggest first. */
  blockers: Blocker[];
}

const ORDER: CheckId[] = ['confirmation', 'quota', 'shape', 'service', 'capacity', 'fragmentation'];

export function diagnoseWait(reservation: Reservation, snapshot: CapacitySnapshot, timeline?: CapacityTimeline): WaitDiagnosis {
  const device = reservation.request.devices[0];
  const nodesWanted = reservation.request.gang?.size ?? 1;
  const gpus = reservationGpus(reservation);
  const length = durationMs(reservation.request.duration) || (reservation.during ? reservation.during.end - reservation.during.start : 0) || DAY;
  // A pending reservation has no window yet: its request says when it wants to start (or as soon as possible).
  const start = Math.max(snapshot.now, reservation.during?.start ?? reservation.request.start ?? snapshot.now);
  const end = start + length;
  const poolNodes = snapshot.nodes.filter((node) => node.poolId === reservation.poolId);
  const wholeNode = device?.class === 'node';
  const largest = Math.max(0, ...poolNodes.map((node) => node.gpus));
  const perNode = wholeNode ? largest || 8 : device?.count ?? 1;
  const checks: WaitCheck[] = [];

  // An agent's delegation said "ask a person": nothing is placed until someone confirms, whatever the capacity.
  if (reservation.state === 'awaiting-confirmation')
    checks.push({
      id: 'confirmation',
      verdict: 'blocks',
      label: 'Confirmation',
      detail: 'The booking agent may not book this on its own; a person on the tenant must confirm it.',
      short: 'needs a person to confirm (delegated deny)',
    });

  // Quota: the tenant's GPU headroom in this pool.
  const quota = snapshot.quotas.find(
    (row) => row.poolId === reservation.poolId && row.resource === 'gpu' && (row.tenantId ?? snapshot.tenantId) === reservation.tenantId,
  );
  if (!quota) checks.push({ id: 'quota', verdict: 'unknown', label: 'Quota', detail: 'No GPU quota row for this tenant in this pool.' });
  else {
    const headroom = quota.available ?? Math.max(0, quota.max - quota.used);
    checks.push(
      headroom >= gpus
        ? { id: 'quota', verdict: 'ok', label: 'Quota', detail: `${headroom} of ${quota.max} GPUs left; it needs ${gpus}.` }
        : {
            id: 'quota',
            verdict: 'blocks',
            label: 'Quota',
            detail: `Only ${headroom} of ${quota.max} GPUs left (${quota.used} in use); it needs ${gpus}.`,
            short: `quota: ${headroom} of ${gpus} GPUs left`,
          },
    );
  }

  // The rest are node-level when the node list is known.
  const blockers = new Map<string, Blocker>();
  const busy = new Map<string, Set<string>>();
  for (const other of snapshot.reservations) {
    if (other.id === reservation.id || other.poolId !== reservation.poolId || !other.during || !liveStates.has(other.state)) continue;
    const overlap = Math.min(end, other.during.end) - Math.max(start, other.during.start);
    if (overlap <= 0) continue;
    const held = reservationGpus(other);
    blockers.set(other.id, { reservation: other, gpus: held, gpuHours: (held * overlap) / HOUR });
    for (const atom of other.atoms ?? []) {
      const nodeId = atom.slice(0, atom.lastIndexOf('/'));
      if (!busy.has(nodeId)) busy.set(nodeId, new Set());
      busy.get(nodeId)!.add(atom);
    }
  }

  if (poolNodes.length) {
    const bigEnough = poolNodes.filter((node) => node.gpus >= perNode);
    const inService = bigEnough.filter((node) => node.health === 'ok');
    if (bigEnough.length < nodesWanted)
      checks.push({
        id: 'shape',
        verdict: 'blocks',
        label: 'Shape',
        detail:
          largest < perNode
            ? `It asks ${perNode} GPUs per node; the largest node here has ${largest}.`
            : `It asks for ${nodesWanted} nodes with ${perNode} GPUs; this pool has ${bigEnough.length}.`,
        short: largest < perNode ? `can't fit: ${perNode}/node, nodes have ${largest}` : `can't fit: ${nodesWanted} nodes, pool has ${bigEnough.length}`,
      });
    else checks.push({ id: 'shape', verdict: 'ok', label: 'Shape', detail: `${bigEnough.length} nodes can take ${perNode} GPUs each; it needs ${nodesWanted}.` });

    const out = bigEnough.length - inService.length;
    if (bigEnough.length >= nodesWanted)
      checks.push(
        inService.length >= nodesWanted
          ? { id: 'service', verdict: 'ok', label: 'In service', detail: `${inService.length} of ${bigEnough.length} suitable nodes are schedulable.` }
          : {
              id: 'service',
              verdict: 'blocks',
              label: 'In service',
              detail: `${out} of ${bigEnough.length} suitable nodes are out of service; ${inService.length} left for ${nodesWanted} needed.`,
              short: `${out} suitable node${out === 1 ? '' : 's'} out of service`,
            },
      );

    // Free GPUs per in-service node across the whole window (a GPU busy at any moment counts as busy).
    const free = inService.map((node) => node.gpus - (busy.get(node.id)?.size ?? 0));
    const total = free.reduce((sum, value) => sum + value, 0);
    const fitting = free.filter((value) => value >= perNode).length;
    checks.push(
      total >= gpus
        ? { id: 'capacity', verdict: 'ok', label: 'Capacity', detail: `${total} GPUs stay free for the whole window; it needs ${gpus}.` }
        : { id: 'capacity', verdict: 'blocks', label: 'Capacity', detail: `Only ${total} GPUs stay free for the whole window; it needs ${gpus}.`, short: `${total} of ${gpus} GPUs free over the window` },
    );
    if (total >= gpus)
      checks.push(
        fitting >= nodesWanted
          ? { id: 'fragmentation', verdict: 'ok', label: 'Together', detail: `${fitting} nodes have ${perNode} GPUs free together.` }
          : {
              id: 'fragmentation',
              verdict: 'blocks',
              label: 'Together',
              detail: `The free GPUs are scattered: ${fitting} node${fitting === 1 ? '' : 's'} ${fitting === 1 ? 'has' : 'have'} ${perNode} free together, and it needs ${nodesWanted}.`,
              short: `free GPUs scattered: ${fitting} of ${nodesWanted} nodes fit`,
            },
      );
  } else {
    // Live without the node list: the pool-wide timeline is all there is.
    const inWindow = timeline?.buckets.filter((bucket) => bucket.end > start && bucket.start < end) ?? [];
    if (!inWindow.length) checks.push({ id: 'capacity', verdict: 'unknown', label: 'Capacity', detail: 'No timeline for the window yet.' });
    else {
      const least = Math.min(...inWindow.map((bucket) => bucket.free));
      checks.push(
        least >= gpus
          ? { id: 'capacity', verdict: 'ok', label: 'Capacity', detail: `At least ${least} GPUs free every hour of the window; it needs ${gpus}. Per-node fit isn't visible here.` }
          : { id: 'capacity', verdict: 'blocks', label: 'Capacity', detail: `The tightest hour has ${least} GPUs free; it needs ${gpus}.`, short: `${least} of ${gpus} GPUs free at the tightest hour` },
      );
    }
  }

  checks.sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
  const fitsAt = timeline ? earliestFit(timeline, gpus, length, { notBefore: start }) : undefined;
  const placer = reservation.conditions.filter((condition) => condition.type === 'Unschedulable').at(-1);
  return {
    window: { start, end },
    ...(placer ? { placer } : {}),
    needed: { gpus, perNode, nodes: nodesWanted },
    checks,
    ...(checks.find((check) => check.verdict === 'blocks') ? { cause: checks.find((check) => check.verdict === 'blocks')! } : {}),
    ...(fitsAt !== undefined ? { fitsAt } : {}),
    blockers: [...blockers.values()].sort((a, b) => b.gpuHours - a.gpuHours || a.reservation.id.localeCompare(b.reservation.id)),
  };
}
