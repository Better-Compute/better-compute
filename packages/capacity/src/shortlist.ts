import type {
  NodeView,
  PlacementContext,
  PlacementRequest,
  SchedulerPlugin,
  SqlTx,
} from '@better-compute/core';
import { dedicatedTaint, schedulableSqlTolerating } from './eligibility.js';
import { defaultScorerWeights, planPlacement, type PlacementPlan } from './pipeline.js';
import { loadNodeViews, type PoolRow } from './store.js';

// The placement shortlist (§10.3, the v0.1 placements/s gate): instead of loading every node and
// device of a pool, SQL counts the free and bookable atoms of the requested classes per schedulable
// node that fits, and only the best `shortlistSize` by the count-derived part of the built-in score
// are loaded and planned. The shortcut is exact: it is taken only when nothing outside the shortlist
// could rank among the top N, and otherwise the caller plans the whole pool.

/** Nodes loaded and planned per shortlist (at least 8 × topN). */
export const shortlistSize = 48;

/** A node and the count-derived part of its built-in score. */
export interface Candidate {
  nodeId: string;
  /** The score from binpack, fragmentation and spread (+ topology when it is constant). */
  partial: number;
}

/**
 * The count-derived part of the built-in score for one request: binpack, fragmentation, spread,
 * topology when it is constant (≤1 GPU) and the image-cached bonus, summed in `planPlacement`'s order
 * so that ties compare exactly.
 */
export function partialScorer(
  request: PlacementRequest,
  weights: Readonly<Record<string, number>> = {},
  imageCached?: ReadonlySet<string>,
): (row: CandidateCounts) => number {
  const merged = { ...defaultScorerWeights, ...weights };
  const w = (id: string) => merged[id] ?? 0;
  const needed = request.devices.reduce((sum, device) => sum + device.count, 0);
  const topologyConstant = gpusOf(request) <= 1;
  return (row) => {
    const freeAfter = Math.max(0, row.free - needed);
    const binpack = row.total > 0 ? 1 - freeAfter / row.total : 0;
    const fragmentation = freeAfter === 0 ? 1 : (freeAfter & (freeAfter - 1)) === 0 ? 0.5 : 0;
    let partial = 0;
    partial += w('binpack') * binpack;
    if (topologyConstant) partial += w('topology') * 1;
    partial += w('fragmentation') * fragmentation;
    partial += w('spread') * (1 - binpack);
    if (request.imageId !== undefined)
      partial += w('image-cached') * (imageCached?.has(row.nodeId) ? 1 : 0);
    return partial;
  };
}

function gpusOf(request: PlacementRequest): number {
  return request.devices
    .filter((device) => device.class.startsWith('gpu'))
    .reduce((sum, device) => sum + device.count, 0);
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
): Promise<CandidateCounts[]> {
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
  // Every requested node label, with exactly that value (only when the request names some).
  const labels = Object.keys(request.nodeLabels ?? {}).length > 0;
  const labelsOk = `NOT EXISTS (
      SELECT 1 FROM jsonb_each_text($5::jsonb) l
       WHERE NOT EXISTS (
         SELECT 1 FROM node_labels nl WHERE nl.node_id = n.id AND nl.key = l.key
                                        AND (l.value = '*' OR nl.value = l.value)))`;
  // Three single-table-driven statements rather than one: their plans stay sane without statistics.
  const nodes = await tx.query<{ node_id: string }>(
    `SELECT n.id AS node_id FROM nodes n JOIN pools p ON p.id = n.pool_id
      WHERE n.pool_id = $1 AND ${schedulableSqlTolerating('$4::text[]')}
        AND NOT (n.id = ANY($2::text[])) AND ${scalarsOk}${labels ? ` AND ${labelsOk}` : ''}`,
    [
      pool.id,
      [...excluded],
      JSON.stringify(scalars),
      [dedicatedTaint(request.tenantId)],
      ...(labels ? [JSON.stringify(request.nodeLabels)] : []),
    ],
  );
  if (want.size === 0) return nodes.rows.map((row) => ({ nodeId: row.node_id, free: 0, total: 0 }));
  const classes = [...want.keys()];
  // Bookable and healthy counts per node and class, kept by trigger (capacity/0003_device_counts):
  // one table, no join, no aggregate; rows of other pools' nodes are ignored below. At 10k nodes on
  // PGlite this took an inline placement from ~128 to ~85 ms (the device aggregate it replaces
  // scanned every device of the pool).
  const counts = await tx.query<{
    node_id: string;
    class: string;
    total: number | string;
    healthy: number | string;
  }>(
    `SELECT node_id, class, bookable AS total, healthy FROM capacity_device_counts
      WHERE class = ANY($1::text[]) AND bookable > 0`,
    [classes],
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
  imageCached?: ReadonlySet<string>,
): Promise<{ plan: PlacementPlan; views: NodeView[] } | undefined> {
  return shortlistPlan(pool, request, excluded, context, {
    counts: () => candidates(tx, pool, request, excluded),
    views: (nodeIds) => loadNodeViews(tx, pool, request.during, { onlyNodes: nodeIds }),
    linked: () => linkedNodes(tx, pool),
    ...(imageCached ? { imageCached } : {}),
  });
}

/** Free and bookable atoms of the requested classes on one fitting, schedulable node. */
export interface CandidateCounts {
  nodeId: string;
  free: number;
  total: number;
}

/** Where a shortlist's inputs come from: SQL (the inline placer) or a `PoolIndex` (batches). */
export interface ShortlistSource {
  /** Every schedulable, not excluded node whose scalars and free atoms fit the request. */
  counts?(): Promise<CandidateCounts[]> | CandidateCounts[];
  /**
   * Instead of `counts`: every fitting schedulable node already scored with `partialScorer` and
   * sorted best first (`before`), excluded nodes included (they are skipped here).
   */
  ranked?(): readonly Candidate[];
  /** Placement views of these nodes for the request's window. */
  views(nodeIds: readonly string[]): Promise<NodeView[]> | NodeView[];
  /** Nodes with at least one GPU link row. */
  linked(): Promise<ReadonlySet<string>> | ReadonlySet<string>;
  /** Nodes caching `request.imageId` (the `image-cached` score, a known per-node bonus). */
  imageCached?: ReadonlySet<string>;
}

/** Best first by partial score, ties by node id (the ranking's own tie-break). */
export function before(a: Candidate, b: Candidate): boolean {
  return a.partial > b.partial || (a.partial === b.partial && a.nodeId < b.nodeId);
}

/**
 * The best `size` candidates, sorted, without sorting them all: a bounded insertion that rejects
 * most candidates with one comparison against the current last (10k nodes: ~10k comparisons).
 */
function topCandidates<T extends Candidate>(candidates: readonly T[], size: number): T[] {
  const top: T[] = [];
  for (const candidate of candidates) {
    if (top.length === size && !before(candidate, top[size - 1]!)) continue;
    let low = 0;
    let high = top.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (before(top[middle]!, candidate)) low = middle + 1;
      else high = middle;
    }
    top.splice(low, 0, candidate);
    if (top.length > size) top.pop();
  }
  return top;
}

/** The exact shortlist over any source; see `planFromShortlist`. */
export async function shortlistPlan(
  pool: PoolRow,
  request: PlacementRequest,
  excluded: readonly string[],
  context: Pick<PlacementContext, 'plugins' | 'weights' | 'topN'>,
  source: ShortlistSource,
): Promise<{ plan: PlacementPlan; views: NodeView[] } | undefined> {
  const weights = { ...defaultScorerWeights, ...context.weights };
  const topologyConstant = gpusOf(request) <= 1;
  const w = (id: string) => weights[id] ?? 0;
  const size = Math.max(shortlistSize, 8 * Math.max(1, context.topN ?? 5));

  // The shortlist, and the candidates outside it (sorted when the source ranks, else in any order).
  let shortlist: Candidate[];
  let outside: Iterable<Candidate>;
  let sorted: boolean;
  // `onlyNodes` narrows the candidates before the shortlist is cut, so the allowed nodes are never
  // crowded out of it by better-scoring ones the request may not use.
  const only = request.onlyNodes ? new Set(request.onlyNodes) : undefined;
  if (source.ranked) {
    const ordered = source.ranked();
    const skip = new Set(excluded);
    const allowed = (nodeId: string) => !skip.has(nodeId) && (!only || only.has(nodeId));
    shortlist = [];
    let next = 0;
    for (; next < ordered.length && shortlist.length < size; next++)
      if (allowed(ordered[next]!.nodeId)) shortlist.push(ordered[next]!);
    const from = next;
    outside = (function* () {
      for (let at = from; at < ordered.length; at++)
        if (allowed(ordered[at]!.nodeId)) yield ordered[at]!;
    })();
    sorted = true;
  } else {
    const rows = (await source.counts!()).filter((row) => !only || only.has(row.nodeId));
    const scoreOf = partialScorer(request, context.weights, source.imageCached);
    const scored = rows.map((row) => ({ nodeId: row.nodeId, partial: scoreOf(row) }));
    shortlist = topCandidates(scored, size);
    const inShortlist = new Set(shortlist.map((candidate) => candidate.nodeId));
    outside = scored.filter((candidate) => !inShortlist.has(candidate.nodeId));
    sorted = false;
  }
  if (shortlist.length === 0) return undefined;
  const views = await source.views(shortlist.map((candidate) => candidate.nodeId));
  const plan = planPlacement({ ...request, excludeNodes: [...excluded] }, views, pool, {
    plugins: context.plugins,
    weights: context.weights,
    ...(source.imageCached ? { imageCached: source.imageCached } : {}),
  });
  if (plan.ranked.length === 0) return undefined;
  const window = Math.max(1, Math.floor(context.topN ?? 5));
  const last = plan.ranked[window - 1];
  // A node outside scores at most its partial plus the best topology it could have. It displaces
  // `last` if it could beat it, or tie it with a lower id (ranking ties break on node id).
  // Whole GPUs on a node without a single link row are all unknown to each other: topology is
  // exactly 0.5 there. (Fractional atoms on one parent count as NV, so they keep the bound.)
  const extra = topologyConstant ? 0 : Math.max(0, w('topology'));
  const wholeGpus = request.devices.every(
    (device) => device.class === 'gpu' || !device.class.startsWith('gpu'),
  );
  const epsilon = 1e-9;
  let linked: ReadonlySet<string> | undefined;
  let checked = false;
  for (const candidate of outside) {
    // Candidates exist outside: the plan must hold the full top N, and beat them all.
    if (!last) return undefined;
    if (candidate.partial + extra < last.score - epsilon) {
      if (sorted) break; // the rest score lower still
      continue;
    }
    if (!checked) {
      linked = extra > 0 && wholeGpus ? await source.linked() : undefined;
      checked = true;
    }
    const best =
      candidate.partial + (linked && !linked.has(candidate.nodeId) ? w('topology') * 0.5 : extra);
    if (best < last.score - epsilon) continue;
    if (best > last.score + epsilon || candidate.nodeId < last.nodeId) return undefined;
  }
  return { plan, views };
}
