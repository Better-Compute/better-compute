import type {
  Atom,
  Device,
  NodeView,
  ScalarResource,
  SqlTx,
  TimeRange,
} from '@better-compute/core';
import { isSchedulable } from './eligibility.js';
import {
  readDeviceLinks,
  readDevices,
  readNodeLabels,
  readNodeResources,
  readPoolNodes,
  type NodeRow,
  type PoolRow,
} from './store.js';

// The in-memory index of the v0.4 pool-lease placer (PLAN.md §10.3): one pool's nodes, devices,
// scalars and booking intervals, loaded once per batch by the worker holding the pool. Placement views
// for any window are derived from it without touching the database. The worker records every
// allocation it commits. Bookings made elsewhere meanwhile (inline instance placements, releases) are
// not seen until the next batch; the guarded commit statements catch a stale view, and the placer
// replans without that node.

export class PoolIndex {
  private constructor(
    readonly pool: PoolRow,
    private readonly nodes: NodeRow[],
    private readonly devices: Map<string, Device[]>,
    private readonly labels: Map<string, Record<string, string>>,
    private readonly resources: Map<string, Record<string, ScalarResource>>,
    private readonly links: Map<string, NonNullable<NodeView['links']>>,
    /** Booking intervals per device, `[start, end)` in epoch ms. */
    private readonly bookings: Map<string, [number, number][]>,
  ) {}

  /** Loads a pool: every node, and devices, scalars, links and bookings ending after `from` for schedulable ones. */
  static async load(tx: SqlTx, pool: PoolRow, from: number): Promise<PoolIndex> {
    const nodes = await readPoolNodes(tx, pool.id);
    const live = nodes.filter((node) => isSchedulable(node, pool)).map((node) => node.id);
    const devices = new Map<string, Device[]>();
    for (const device of await readDevices(tx, live))
      devices.set(device.nodeId, [...(devices.get(device.nodeId) ?? []), device]);
    const bookings = new Map<string, [number, number][]>();
    if (live.length > 0) {
      const { rows } = await tx.query<{ device_id: string; start_ms: number; end_ms: number }>(
        `SELECT b.device_id, (extract(epoch FROM lower(b.during)) * 1000)::float8 AS start_ms,
                (extract(epoch FROM upper(b.during)) * 1000)::float8 AS end_ms
           FROM device_bookings b JOIN devices d ON d.id = b.device_id
          WHERE d.node_id = ANY($1::text[]) AND upper(b.during) > $2::timestamptz`,
        [live, new Date(from).toISOString()],
      );
      for (const row of rows)
        bookings.set(row.device_id, [
          ...(bookings.get(row.device_id) ?? []),
          [Number(row.start_ms), Number(row.end_ms)],
        ]);
    }
    return new PoolIndex(
      pool,
      nodes,
      devices,
      await readNodeLabels(
        tx,
        nodes.map((node) => node.id),
      ),
      await readNodeResources(tx, live),
      await readDeviceLinks(tx, live),
      bookings,
    );
  }

  private busy(deviceId: string, during: TimeRange): boolean {
    for (const [start, end] of this.bookings.get(deviceId) ?? [])
      if (start < during.end && during.start < end) return true;
    return false;
  }

  /** The placement view of the pool for one window, as `loadNodeViews` would build it. */
  views(during: TimeRange): NodeView[] {
    return this.nodes.map((node) => {
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

  /** Records an allocation this worker committed: its atoms are busy in `during`, its scalars claimed. */
  record(allocation: {
    nodeId: string;
    atoms: readonly string[];
    resources: Readonly<Record<string, number>>;
    during: TimeRange;
  }): void {
    for (const atom of allocation.atoms)
      this.bookings.set(atom, [
        ...(this.bookings.get(atom) ?? []),
        [allocation.during.start, allocation.during.end],
      ]);
    const scalars = this.resources.get(allocation.nodeId);
    if (!scalars) return;
    const next = { ...scalars };
    for (const [resource, amount] of Object.entries(allocation.resources)) {
      const current = next[resource];
      if (current) next[resource] = { ...current, allocated: current.allocated + amount };
    }
    this.resources.set(allocation.nodeId, next);
  }
}
