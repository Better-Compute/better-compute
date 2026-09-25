import type { PlacementContext, PlacementRequest, SqlTx, TimeRange } from '@better-compute/core';
import { planGangs } from './gang.js';
import { planPlacement, type NodePlan } from './pipeline.js';
import { loadNodeViews, type PoolRow } from './store.js';

// Spot reservations (PLAN.md §10.5, v0.5). A spot reservation is placed like any other, billed at
// the spot meter, and may be preempted: when a non-spot request would otherwise go pending, the
// placer plans it as if spot bookings were free, and the spot reservations holding the atoms it
// needs get a notice. Started ones are cut back to end at the notice deadline and then released
// through the normal end path; not-started ones are released and re-queued. Never a silent revoke.

/** The default notice a preempted spot reservation gets before its atoms are taken. */
export const defaultSpotNoticeMs = 2 * 60_000;

/** A live allocation of a spot reservation. */
export interface SpotAllocation {
  allocationId: string;
  reservationId: string;
  nodeId: string;
  atoms: string[];
  during: TimeRange;
}

/** Live allocations of spot reservations in a pool that overlap `during`. */
export async function readSpotAllocations(
  tx: SqlTx,
  poolId: string,
  during: TimeRange,
): Promise<SpotAllocation[]> {
  const { rows } = await tx.query<{
    id: string;
    owner_id: string;
    node_id: string;
    atoms: string[];
    start_ms: number;
    end_ms: number;
  }>(
    `SELECT a.id, a.owner_id, a.node_id, a.atoms,
            (extract(epoch FROM lower(a.during)) * 1000)::float8 AS start_ms,
            (extract(epoch FROM upper(a.during)) * 1000)::float8 AS end_ms
       FROM allocations a JOIN reservations r ON r.id = a.owner_id AND a.owner_kind = 'reservation'
      WHERE a.pool_id = $1 AND a.released_at IS NULL
        AND a.during && tstzrange($2::timestamptz, $3::timestamptz)
        AND r.state IN ('placed', 'binding', 'active') AND (r.request->>'spot')::boolean IS TRUE
      ORDER BY a.id`,
    [poolId, new Date(during.start).toISOString(), new Date(during.end).toISOString()],
  );
  return rows.map((row) => ({
    allocationId: row.id,
    reservationId: row.owner_id,
    nodeId: row.node_id,
    atoms: row.atoms,
    during: { start: Number(row.start_ms), end: Number(row.end_ms) },
  }));
}

/** What a preemption takes: the nodes the request lands on and the spot reservations to preempt. */
export interface PreemptionPlan {
  nodeIds: string[];
  victims: string[];
}

function victimsOf(members: readonly NodePlan[], spot: readonly SpotAllocation[]): Set<string> {
  const victims = new Set<string>();
  for (const member of members) {
    const atoms = new Set(member.atoms);
    for (const allocation of spot)
      if (allocation.nodeId === member.nodeId && allocation.atoms.some((atom) => atoms.has(atom)))
        victims.add(allocation.reservationId);
  }
  return victims;
}

/**
 * Plans `request` as if the bookings of `spot` were free, and picks the plan that preempts the fewest
 * spot reservations (then the best score). `undefined` when nothing fits even so, or when the best
 * plan needs no preemption (the pending had another cause, e.g. a lost race).
 */
export async function planPreemption(
  tx: SqlTx,
  pool: PoolRow,
  request: PlacementRequest,
  spot: readonly SpotAllocation[],
  context: Pick<PlacementContext, 'plugins' | 'weights'>,
): Promise<PreemptionPlan | undefined> {
  if (spot.length === 0) return undefined;
  const views = await loadNodeViews(tx, pool, request.during, {
    ignoreAllocations: spot.map((allocation) => allocation.allocationId),
  });
  const { ranked } = planPlacement(request, views, pool, {
    plugins: context.plugins,
    weights: context.weights,
  });
  const options: NodePlan[][] =
    request.gang === undefined
      ? ranked.map((plan) => [plan])
      : planGangs(ranked, views, request.gang).gangs.map((gang) => gang.members);
  let best: { members: NodePlan[]; victims: Set<string> } | undefined;
  for (const members of options.slice(0, 64)) {
    const victims = victimsOf(members, spot);
    if (!best || victims.size < best.victims.size) best = { members, victims };
    if (victims.size === 0) break;
  }
  if (!best || best.victims.size === 0) return undefined;
  return {
    nodeIds: best.members.map((member) => member.nodeId),
    victims: [...best.victims].sort(),
  };
}

/**
 * Cuts an allocation back to end at `end` (the notice deadline): bookings and the allocation row.
 * The atoms are free from `end` on; the allocation is released through the normal path then.
 */
export async function truncateAllocation(
  tx: SqlTx,
  allocationId: string,
  end: number,
): Promise<void> {
  const at = new Date(end).toISOString();
  await tx.query(
    `UPDATE device_bookings SET during = tstzrange(lower(during), $2::timestamptz)
      WHERE allocation_id = $1 AND upper(during) > $2::timestamptz AND lower(during) < $2::timestamptz`,
    [allocationId, at],
  );
  await tx.query(
    `UPDATE allocations SET during = tstzrange(lower(during), $2::timestamptz), version = version + 1
      WHERE id = $1 AND upper(during) > $2::timestamptz AND lower(during) < $2::timestamptz`,
    [allocationId, at],
  );
}
