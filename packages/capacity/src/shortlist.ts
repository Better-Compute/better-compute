import type {
  NodeView,
  PlacementContext,
  PlacementRequest,
  SchedulerPlugin,
  SqlTx,
} from '@better-compute/core';
import { schedulableSql } from './eligibility.js';
import { defaultScorerWeights, planPlacement, type PlacementPlan } from './pipeline.js';
import { loadNodeViews, type PoolRow } from './store.js';

// The placement shortlist (§10.3, the v0.1 placements/s gate): instead of loading every node and
// device of a pool, SQL counts the free and bookable atoms of the requested classes per schedulable
// node that fits, and only the best `shortlistSize` by the count-derived part of the built-in score
// are loaded and planned. The shortcut is exact: it is taken only when nothing outside the shortlist
// could rank among the top N, and otherwise the caller plans the whole pool.

/** Nodes loaded and planned per shortlist (at least 8 × topN). */
export const shortlistSize = 48;

interface Candidate {
  nodeId: string;
  /** The score from binpack, fragmentation and spread (+ topology when it is constant). */
  partial: number;
}

/** Whether the shortlist can decide this request exactly (no selectors, no plugin scorers). */
export function shortlistable(
  request: PlacementRequest,
  plugins: readonly SchedulerPlugin[],
): boolean {
  if (request.gang !== undefined) return false;
  if (request.devices.some((device) => device.selector !== undefined)) return false;
  return plugins.every((plugin) => (plugin.scorers ?? []).length === 0);
}

const iso = (ms: number) => new Date(ms).toISOString();

async function candidates(
  tx: SqlTx,
  pool: Pick<PoolRow, 'id'>,
  request: PlacementRequest,
  excluded: readonly string[],
): Promise<{ nodeId: string; free: number; total: number }[]> {
  const want = new Map<string, number>();
  for (const device of request.devices)
    want.set(device.class, (want.get(device.class) ?? 0) + device.count);
  const scalars = Object.fromEntries(
    Object.entries(request.resources ?? {}).filter(([, amount]) => amount > 0),
  );
  const scalarsOk = `NOT EXISTS (
      SELECT 1 FROM jsonb_each_text($3::jsonb) s
       WHERE NOT EXISTS (
         SELECT 1 FROM node_resources nr
          WHERE nr.node_id = n.id AND nr.resource = s.key
            AND nr.allocated + s.value::numeric <= floor(nr.allocatable * nr.ratio)))`;
  // Three single-table-driven statements rather than one: their plans stay sane without statistics.
  const nodes = await tx.query<{ node_id: string }>(
    `SELECT n.id AS node_id FROM nodes n JOIN pools p ON p.id = n.pool_id
      WHERE n.pool_id = $1 AND ${schedulableSql} AND NOT (n.id = ANY($2::text[])) AND ${scalarsOk}`,
    [pool.id, [...excluded], JSON.stringify(scalars)],
  );
  if (want.size === 0) return nodes.rows.map((row) => ({ nodeId: row.node_id, free: 0, total: 0 }));
  const classes = [...want.keys()];
  const counts = await tx.query<{
    node_id: string;
    class: string;
    total: number | string;
    healthy: number | string;
  }>(
    `SELECT d.node_id, d.class, count(*) AS total, count(*) FILTER (WHERE d.healthy) AS healthy
       FROM devices d JOIN nodes n ON n.id = d.node_id
      WHERE n.pool_id = $1 AND d.bookable AND d.class = ANY($2::text[])
      GROUP BY d.node_id, d.class`,
    [pool.id, classes],
  );
  const busy = await tx.query<{ node_id: string; class: string; busy: number | string }>(
    `SELECT d.node_id, d.class, count(DISTINCT d.id) AS busy
       FROM device_bookings b JOIN devices d ON d.id = b.device_id JOIN nodes n ON n.id = d.node_id
      WHERE n.pool_id = $1 AND b.during && tstzrange($3::timestamptz, $4::timestamptz)
        AND d.bookable AND d.healthy AND d.class = ANY($2::text[])
      GROUP BY d.node_id, d.class`,
    [pool.id, classes, iso(request.during.start), iso(request.during.end)],
  );
  const key = (nodeId: string, deviceClass: string) => `${nodeId}\u0000${deviceClass}`;
  const busyBy = new Map(busy.rows.map((row) => [key(row.node_id, row.class), Number(row.busy)]));
  const perNode = new Map<string, Map<string, { total: number; free: number }>>();
  for (const row of counts.rows) {
    const byClass = perNode.get(row.node_id) ?? new Map<string, { total: number; free: number }>();
    byClass.set(row.class, {
      total: Number(row.total),
      free: Number(row.healthy) - (busyBy.get(key(row.node_id, row.class)) ?? 0),
    });
    perNode.set(row.node_id, byClass);
  }
  const fits: { nodeId: string; free: number; total: number }[] = [];
  nodes: for (const { node_id: nodeId } of nodes.rows) {
    const byClass = perNode.get(nodeId);
    if (!byClass) continue;
    let free = 0;
    let total = 0;
    for (const [deviceClass, count] of want) {
      const entry = byClass.get(deviceClass);
      if (!entry || entry.free < count) continue nodes;
      free += entry.free;
      total += entry.total;
    }
    fits.push({ nodeId, free, total });
  }
  return fits;
}

async function linkedNodes(tx: SqlTx, pool: Pick<PoolRow, 'id'>): Promise<Set<string>> {
  const { rows } = await tx.query<{ node_id: string }>(
    `SELECT n.id AS node_id FROM nodes n
      WHERE n.pool_id = $1 AND EXISTS (SELECT 1 FROM capacity_device_links l WHERE l.node_id = n.id)`,
    [pool.id],
  );
  return new Set(rows.map((row) => row.node_id));
}

/**
 * Plans `request` from a shortlist of the pool, or answers `undefined` when the shortlist cannot
 * decide exactly (then plan the whole pool). The plan's `ranked` holds the true top candidates;
 * `rejected` covers only the shortlisted nodes.
 */
export async function planFromShortlist(
  tx: SqlTx,
  pool: PoolRow,
  request: PlacementRequest,
  excluded: readonly string[],
  context: Pick<PlacementContext, 'plugins' | 'weights' | 'topN'>,
): Promise<{ plan: PlacementPlan; views: NodeView[] } | undefined> {
  const weights = { ...defaultScorerWeights, ...context.weights };
  const needed = request.devices.reduce((sum, device) => sum + device.count, 0);
  const gpus = request.devices
    .filter((device) => device.class.startsWith('gpu'))
    .reduce((sum, device) => sum + device.count, 0);
  const topologyConstant = gpus <= 1;
  const w = (id: string) => weights[id] ?? 0;
  const rows = await candidates(tx, pool, request, excluded);
  if (rows.length === 0) return undefined;
  const scored: Candidate[] = rows.map((row) => {
    const freeAfter = Math.max(0, row.free - needed);
    const binpack = row.total > 0 ? 1 - freeAfter / row.total : 0;
    const fragmentation = freeAfter === 0 ? 1 : (freeAfter & (freeAfter - 1)) === 0 ? 0.5 : 0;
    // Summed in `planPlacement`'s order (binpack, topology, fragmentation, spread), so ties are exact.
    let partial = 0;
    partial += w('binpack') * binpack;
    if (topologyConstant) partial += w('topology') * 1;
    partial += w('fragmentation') * fragmentation;
    partial += w('spread') * (1 - binpack);
    return { nodeId: row.nodeId, partial };
  });
  scored.sort(
    (a, b) => b.partial - a.partial || (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0),
  );
  const size = Math.max(shortlistSize, 8 * Math.max(1, context.topN ?? 5));
  const shortlist = scored.slice(0, size);
  const views = await loadNodeViews(tx, pool, request.during, {
    onlyNodes: shortlist.map((candidate) => candidate.nodeId),
  });
  const plan = planPlacement({ ...request, excludeNodes: [...excluded] }, views, pool, {
    plugins: context.plugins,
    weights: context.weights,
  });
  if (plan.ranked.length === 0) return undefined;
  if (scored.length <= size) return { plan, views };
  const window = Math.max(1, Math.floor(context.topN ?? 5));
  const last = plan.ranked[window - 1];
  if (!last) return undefined;
  // A node outside scores at most its partial plus the best topology it could have. It displaces
  // `last` if it could beat it, or tie it with a lower id (ranking ties break on node id).
  // Whole GPUs on a node without a single link row are all unknown to each other: topology is
  // exactly 0.5 there. (Fractional atoms on one parent count as NV, so they keep the bound.)
  const extra = topologyConstant ? 0 : Math.max(0, w('topology'));
  const wholeGpus = request.devices.every(
    (device) => device.class === 'gpu' || !device.class.startsWith('gpu'),
  );
  const linked = extra > 0 && wholeGpus ? await linkedNodes(tx, pool) : undefined;
  const epsilon = 1e-9;
  for (const candidate of scored.slice(size)) {
    if (candidate.partial + extra < last.score - epsilon) break; // sorted: the rest score lower
    const best =
      candidate.partial + (linked && !linked.has(candidate.nodeId) ? w('topology') * 0.5 : extra);
    if (best < last.score - epsilon) continue;
    if (best > last.score + epsilon || candidate.nodeId < last.nodeId) return undefined;
  }
  return { plan, views };
}
