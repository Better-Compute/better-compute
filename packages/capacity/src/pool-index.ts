import type {
  Atom,
  Device,
  NodeView,
  PlacementRequest,
  ScalarResource,
  SqlTx,
  TimeRange,
} from '@better-compute/core';
import { dedicatedTenant, mayBeSchedulable } from './eligibility.js';
import { missingNodeLabel } from './pipeline.js';
import { before, partialScorer, type Candidate, type CandidateCounts } from './shortlist.js';
import {
  readDeviceLinks,
  readDevices,
  readNodeLabels,
  readNodeResources,
  readPoolNodes,
  type NodeRow,
  type PoolRow,
} from './store.js';

function wantOf(request: PlacementRequest): Map<string, number> {
  const want = new Map<string, number>();
  for (const device of request.devices)
    want.set(device.class, (want.get(device.class) ?? 0) + device.count);
  return want;
}

/** The first position in a best-first list where `entry` belongs. */
function lowerBound(sorted: readonly Candidate[], entry: Candidate): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (before(sorted[middle]!, entry)) low = middle + 1;
    else high = middle;
  }
  return low;
}

// The in-memory index of the v0.4 pool-lease placer (PLAN.md §10.3): one pool's nodes, devices,
// scalars and booking intervals, loaded once per batch by the worker holding the pool. Placement views
// for any window are derived from it without touching the database. The worker records every
// allocation it commits. Bookings made elsewhere meanwhile (inline instance placements, releases) are
// not seen until the next batch; the guarded commit statements catch a stale view, and the placer
// replans without that node.

/**
 * Keeps each pool's index between batches of the worker that owns it (§10.3: "rebuilt when the lease
 * is acquired"): reused while younger than `maxAgeMs` (default 5 s) and while the pool row is
 * unchanged. Drop a pool's entry when a batch fails, since its transaction's records never
 * happened. Changes made by others in the meantime are caught by the guarded commits, and picked up
 * at the next rebuild.
 */
export class PoolIndexCache {
  private readonly entries = new Map<string, { index: PoolIndex; at: number; version: number }>();
  constructor(private readonly maxAgeMs = 5_000) {}

  /**
   * Takes a pool's index out of the cache (loading it when missing, too old or the pool changed).
   * Call `keep()` once the batch's transaction committed; until then no other batch sees it, and a
   * batch that fails simply never gives it back.
   */
  async checkout(
    tx: SqlTx,
    pool: PoolRow,
    now: number,
  ): Promise<{ index: PoolIndex; keep(): void }> {
    const hit = this.entries.get(pool.id);
    this.entries.delete(pool.id);
    const fresh =
      hit && now - hit.at < this.maxAgeMs && now >= hit.at && hit.version === pool.version;
    const entry = fresh
      ? hit
      : { index: await PoolIndex.load(tx, pool, now), at: now, version: pool.version };
    return { index: entry.index, keep: () => this.entries.set(pool.id, entry) };
  }
}

/** What the counts need of a device: known for booked devices from the start, for others once hydrated. */
type AtomMeta = Pick<Device, 'nodeId' | 'class' | 'bookable' | 'healthy'>;

export class PoolIndex {
  private constructor(
    readonly pool: PoolRow,
    private readonly nodes: NodeRow[],
    /** Bookable and healthy atoms per node and class (`capacity_device_counts`). */
    private readonly classCounts: Map<string, Map<string, { bookable: number; healthy: number }>>,
    private readonly meta: Map<string, AtomMeta>,
    private readonly labels: Map<string, Record<string, string>>,
    private readonly resources: Map<string, Record<string, ScalarResource>>,
    private readonly linkedIds: ReadonlySet<string>,
    /** Booking intervals per device, `[start, end)` in epoch ms. */
    private readonly bookings: Map<string, [number, number][]>,
  ) {
    for (const deviceId of bookings.keys()) this.markBooked(deviceId);
    this.schedulable = nodes.filter((node) => mayBeSchedulable(node, pool));
    this.schedulableIds = new Set(this.schedulable.map((node) => node.id));
    this.nodeById = new Map(nodes.map((node) => [node.id, node]));
    for (const node of this.schedulable) {
      const tenant = dedicatedTenant(node);
      if (tenant !== undefined) this.dedicatedTo.set(node.id, tenant);
    }
  }

  private readonly nodeById: Map<string, NodeRow>;

  /**
   * The nodes any tenant may place on, as loaded (node columns only change through a rebuild):
   * schedulable ones, and those dedicated to one tenant (`dedicatedTo`, schedulable for it alone).
   */
  private readonly schedulable: NodeRow[];
  private readonly schedulableIds: Set<string>;
  private readonly dedicatedTo = new Map<string, string>();

  /** Devices with at least one booking, per node: the only ones a window can make busy. */
  private readonly bookedByNode = new Map<string, Set<string>>();
  /** Full devices and links of the nodes a view was asked for (see `hydrate`). */
  private readonly devices = new Map<string, Device[]>();
  private readonly links = new Map<string, NonNullable<NodeView['links']>>();

  private markBooked(deviceId: string): void {
    const device = this.meta.get(deviceId);
    if (!device) return;
    const set = this.bookedByNode.get(device.nodeId) ?? new Set<string>();
    set.add(deviceId);
    this.bookedByNode.set(device.nodeId, set);
  }

  /**
   * Loads a pool: every node, and for schedulable ones their scalars, per-class atom counts, link
   * presence, and the bookings ending after `from` with their devices. Full device rows (with
   * attributes) and link matrices wait for a view that needs them: at 10k nodes the pool's 80k
   * devices cost ~600 ms to read on PGlite, while a shortlist views a handful of nodes.
   */
  static async load(tx: SqlTx, pool: PoolRow, from: number): Promise<PoolIndex> {
    const nodes = await readPoolNodes(tx, pool.id);
    const live = nodes.filter((node) => mayBeSchedulable(node, pool)).map((node) => node.id);
    const classCounts = new Map<string, Map<string, { bookable: number; healthy: number }>>();
    const meta = new Map<string, AtomMeta>();
    const bookings = new Map<string, [number, number][]>();
    const linked = new Set<string>();
    if (live.length > 0) {
      const counts = await tx.query<{
        node_id: string;
        class: string;
        bookable: number | string;
        healthy: number | string;
      }>(
        `SELECT node_id, class, bookable, healthy FROM capacity_device_counts
          WHERE node_id = ANY($1::text[]) AND bookable > 0`,
        [live],
      );
      for (const row of counts.rows) {
        const byClass = classCounts.get(row.node_id) ?? new Map();
        byClass.set(row.class, { bookable: Number(row.bookable), healthy: Number(row.healthy) });
        classCounts.set(row.node_id, byClass);
      }
      const { rows } = await tx.query<{
        device_id: string;
        node_id: string;
        class: string;
        bookable: boolean;
        healthy: boolean;
        start_ms: number;
        end_ms: number;
      }>(
        `SELECT b.device_id, d.node_id, d.class, d.bookable, d.healthy,
                (extract(epoch FROM lower(b.during)) * 1000)::float8 AS start_ms,
                (extract(epoch FROM upper(b.during)) * 1000)::float8 AS end_ms
           FROM device_bookings b JOIN devices d ON d.id = b.device_id
          WHERE d.node_id = ANY($1::text[]) AND upper(b.during) > $2::timestamptz`,
        [live, new Date(from).toISOString()],
      );
      for (const row of rows) {
        meta.set(row.device_id, {
          nodeId: row.node_id,
          class: row.class as Device['class'],
          bookable: row.bookable,
          healthy: row.healthy,
        });
        bookings.set(row.device_id, [
          ...(bookings.get(row.device_id) ?? []),
          [Number(row.start_ms), Number(row.end_ms)],
        ]);
      }
      const links = await tx.query<{ node_id: string }>(
        `SELECT DISTINCT node_id FROM capacity_device_links WHERE node_id = ANY($1::text[])`,
        [live],
      );
      for (const row of links.rows) linked.add(row.node_id);
    }
    return new PoolIndex(
      pool,
      nodes,
      classCounts,
      meta,
      await readNodeLabels(
        tx,
        nodes.map((node) => node.id),
      ),
      await readNodeResources(tx, live),
      linked,
      bookings,
    );
  }

  /**
   * Reads the full devices and links of these nodes (default: every schedulable one) unless already
   * held. They are read later than the counts, so they may be fresher; the guarded commit settles
   * any difference, as it does for bookings made elsewhere.
   */
  private async hydrate(tx: SqlTx, nodeIds?: readonly string[]): Promise<void> {
    const missing = (nodeIds ?? this.schedulable.map((node) => node.id)).filter(
      (id) => this.schedulableIds.has(id) && !this.devices.has(id),
    );
    if (missing.length === 0) return;
    for (const id of missing) this.devices.set(id, []);
    for (const device of await readDevices(tx, missing)) {
      this.devices.get(device.nodeId)!.push(device);
      this.meta.set(device.id, device);
    }
    for (const [nodeId, links] of await readDeviceLinks(tx, missing)) this.links.set(nodeId, links);
  }

  private busy(deviceId: string, during: TimeRange): boolean {
    for (const [start, end] of this.bookings.get(deviceId) ?? [])
      if (start < during.end && during.start < end) return true;
    return false;
  }

  /** Nodes with at least one GPU link row. */
  linked(): ReadonlySet<string> {
    return this.linkedIds;
  }

  /**
   * Shortlist inputs for a request (see `ShortlistSource.counts`): every schedulable node, not
   * excluded, whose scalars fit and whose free atoms cover each requested class, with its free and
   * bookable counts over the requested classes.
   */
  counts(request: PlacementRequest, excluded: readonly string[]): CandidateCounts[] {
    const want = wantOf(request);
    const skip = new Set(excluded);
    const out: CandidateCounts[] = [];
    for (const node of this.schedulable) {
      if (skip.has(node.id)) continue;
      const counts = this.countsFor(node.id, request, want);
      if (counts) out.push(counts);
    }
    return out;
  }

  /** One schedulable node's counts for a request, or `undefined` when it does not fit. */
  private countsFor(
    nodeId: string,
    request: PlacementRequest,
    want: ReadonlyMap<string, number>,
  ): CandidateCounts | undefined {
    const dedicated = this.dedicatedTo.get(nodeId);
    if (dedicated !== undefined && dedicated !== request.tenantId) return undefined;
    if (
      request.nodeLabels &&
      missingNodeLabel(request.nodeLabels, this.labels.get(nodeId) ?? {}) !== undefined
    )
      return undefined;
    const resources = request.resources;
    if (resources) {
      const scalars = this.resources.get(nodeId) ?? {};
      for (const resource in resources) {
        const need = resources[resource]!;
        if (!(need > 0)) continue;
        const scalar = scalars[resource];
        if (!scalar || scalar.allocated + need > Math.floor(scalar.allocatable * scalar.ratio))
          return undefined;
      }
    }
    if (want.size === 0) return { nodeId, free: 0, total: 0 };
    // Healthy bookable atoms per class, minus the booked ones this window makes busy.
    const classes = this.classCounts.get(nodeId);
    const booked = this.bookedByNode.get(nodeId);
    let busy: Map<string, number> | undefined;
    if (booked)
      for (const deviceId of booked) {
        const device = this.meta.get(deviceId)!;
        if (device.bookable && device.healthy && want.has(device.class))
          if (this.busy(deviceId, request.during))
            (busy ??= new Map()).set(device.class, (busy.get(device.class) ?? 0) + 1);
      }
    let free = 0;
    let total = 0;
    for (const [deviceClass, count] of want) {
      const counts = classes?.get(deviceClass);
      const available = (counts?.healthy ?? 0) - (busy?.get(deviceClass) ?? 0);
      if (available < count) return undefined;
      free += available;
      total += counts?.bookable ?? 0;
    }
    return { nodeId, free, total };
  }

  /**
   * Every fitting schedulable node scored with `partialScorer` and sorted best first, memoized per
   * request shape (window, classes, scalars, image, weights) and kept current as this worker records
   * or forgets allocations (`refresh`), so a batch of like requests ranks 10k nodes once.
   */
  ranked(
    request: PlacementRequest,
    weights: Readonly<Record<string, number>> = {},
    imageCached?: ReadonlySet<string>,
  ): readonly Candidate[] {
    const key = JSON.stringify([
      request.during.start,
      request.during.end,
      request.devices.map((device) => [device.class, device.count]),
      request.resources ?? {},
      request.imageId ?? null,
      weights,
      // Rankings differ per tenant only when some node is dedicated to one.
      this.dedicatedTo.size > 0 ? request.tenantId : null,
      request.nodeLabels ?? null,
    ]);
    let shape = this.shapes.get(key);
    if (!shape) {
      if (this.shapes.size >= 32) this.shapes.clear();
      const score = partialScorer(request, weights, imageCached);
      const want = wantOf(request);
      const sorted: Candidate[] = [];
      const partial = new Map<string, number>();
      for (const node of this.schedulable) {
        const counts = this.countsFor(node.id, request, want);
        if (!counts) continue;
        const value = score(counts);
        sorted.push({ nodeId: node.id, partial: value });
        partial.set(node.id, value);
      }
      sorted.sort((a, b) => (before(a, b) ? -1 : before(b, a) ? 1 : 0));
      shape = { request, want, score, sorted, partial };
      this.shapes.set(key, shape);
    }
    return shape.sorted;
  }

  private readonly shapes = new Map<
    string,
    {
      request: PlacementRequest;
      want: ReadonlyMap<string, number>;
      score: (row: CandidateCounts) => number;
      sorted: Candidate[];
      partial: Map<string, number>;
    }
  >();

  /** Re-scores one node in every memoized ranking after its bookings or scalars changed. */
  private refresh(nodeId: string): void {
    if (this.shapes.size === 0 || !this.schedulableIds.has(nodeId)) return;
    for (const shape of this.shapes.values()) {
      const old = shape.partial.get(nodeId);
      if (old !== undefined) {
        const at = lowerBound(shape.sorted, { nodeId, partial: old });
        if (shape.sorted[at]?.nodeId === nodeId) shape.sorted.splice(at, 1);
        shape.partial.delete(nodeId);
      }
      const counts = this.countsFor(nodeId, shape.request, shape.want);
      if (!counts) continue;
      const entry = { nodeId, partial: shape.score(counts) };
      shape.sorted.splice(lowerBound(shape.sorted, entry), 0, entry);
      shape.partial.set(nodeId, entry.partial);
    }
  }

  /**
   * The placement view of the pool (or of `onlyNodes`) for one window, as `loadNodeViews` builds it.
   * Reads the devices of nodes not viewed before through `tx`.
   */
  async views(tx: SqlTx, during: TimeRange, onlyNodes?: readonly string[]): Promise<NodeView[]> {
    await this.hydrate(tx, onlyNodes);
    const nodes = onlyNodes
      ? onlyNodes.flatMap((id) => {
          const node = this.nodeById.get(id);
          return node ? [node] : [];
        })
      : this.nodes;
    return nodes.map((node) => {
      const all = this.devices.get(node.id) ?? [];
      const view: NodeView = {
        ...node,
        labels: this.labels.get(node.id) ?? {},
        devices: all,
        free: all.filter(
          (device): device is Atom =>
            device.bookable && device.healthy && !this.busy(device.id, during),
        ),
        resources: this.resources.get(node.id) ?? {},
      };
      const links = this.links.get(node.id);
      if (links) view.links = links;
      return view;
    });
  }

  /** Undoes a tentative `record` of atoms whose commit failed (scalars are not part of bulk plans). */
  forget(allocation: { atoms: readonly string[]; during: TimeRange }): void {
    for (const atom of allocation.atoms) {
      const intervals = this.bookings.get(atom);
      if (!intervals) continue;
      const at = intervals.findIndex(
        ([start, end]) => start === allocation.during.start && end === allocation.during.end,
      );
      if (at >= 0) intervals.splice(at, 1);
    }
    const nodes = new Set<string>();
    for (const atom of allocation.atoms) {
      const device = this.meta.get(atom);
      if (device) nodes.add(device.nodeId);
    }
    for (const nodeId of nodes) this.refresh(nodeId);
  }

  /** Records an allocation this worker committed: its atoms are busy in `during`, its scalars claimed. */
  record(allocation: {
    nodeId: string;
    atoms: readonly string[];
    resources: Readonly<Record<string, number>>;
    during: TimeRange;
  }): void {
    for (const atom of allocation.atoms) {
      this.bookings.set(atom, [
        ...(this.bookings.get(atom) ?? []),
        [allocation.during.start, allocation.during.end],
      ]);
      this.markBooked(atom);
    }
    const scalars = this.resources.get(allocation.nodeId);
    if (scalars) {
      const next = { ...scalars };
      for (const [resource, amount] of Object.entries(allocation.resources)) {
        const current = next[resource];
        if (current) next[resource] = { ...current, allocated: current.allocated + amount };
      }
      this.resources.set(allocation.nodeId, next);
    }
    this.refresh(allocation.nodeId);
  }
}
