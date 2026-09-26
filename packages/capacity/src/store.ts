import type {
  Atom,
  Connectivity,
  Device,
  DeviceClass,
  GpuLink,
  NodeRole,
  NodeTrust,
  NodeView,
  PoolPolicy,
  ProvisionState,
  ScalarResource,
  SharingMode,
  SqlTx,
  TimeRange,
} from '@better-compute/core';
import { ComputeError } from '@better-compute/core';
import { gpuLinks, type GpusSection } from '@better-compute/inventory';
import { mayBeSchedulable } from './eligibility.js';
import { gpuLinkOrder } from './pipeline.js';

// Row loaders shared by placers, rollups and read methods. Timestamps cross the wire as ISO strings
// cast to timestamptz and come back as float8 epoch milliseconds, identical on pg and PGlite.

/** The pool columns placement reads. */
export interface PoolRow {
  id: string;
  ownerTenantId: string;
  siteId: string;
  class: string;
  gpuModel?: string;
  sharing: SharingMode;
  agent: string;
  policy: PoolPolicy;
  version: number;
  /** Archived pools take no new work (`pools.archive`). */
  archived: boolean;
}

const poolColumns = `id, owner_tenant_id, site_id, class, gpu_model, sharing, agent, policy, version,
  archived_at IS NOT NULL AS archived`;

interface RawPool {
  id: string;
  owner_tenant_id: string;
  site_id: string;
  class: string;
  gpu_model: string | null;
  sharing: SharingMode;
  agent: string;
  policy: PoolPolicy | string;
  version: string | number;
  archived: boolean;
}

function toPool(row: RawPool): PoolRow {
  const pool: PoolRow = {
    id: row.id,
    ownerTenantId: row.owner_tenant_id,
    siteId: row.site_id,
    class: row.class,
    sharing: row.sharing,
    agent: row.agent,
    policy: typeof row.policy === 'string' ? (JSON.parse(row.policy) as PoolPolicy) : row.policy,
    version: Number(row.version),
    archived: row.archived === true,
  };
  if (row.gpu_model !== null) pool.gpuModel = row.gpu_model;
  return pool;
}

/** Reads a pool without locking it. */
export async function readPool(tx: SqlTx, poolId: string): Promise<PoolRow | undefined> {
  const { rows } = await tx.query<RawPool>(`SELECT ${poolColumns} FROM pools WHERE id = $1`, [
    poolId,
  ]);
  return rows[0] ? toPool(rows[0]) : undefined;
}

/**
 * The v0.1 placement fence (PLAN.md §10.3): `SELECT … FROM pools WHERE id = $pool FOR UPDATE`,
 * so one admission transaction places into a pool at a time. Throws `NOT_FOUND`.
 */
export async function lockPool(tx: SqlTx, poolId: string): Promise<PoolRow> {
  const { rows } = await tx.query<RawPool>(
    `SELECT ${poolColumns} FROM pools WHERE id = $1 FOR UPDATE`,
    [poolId],
  );
  if (!rows[0]) throw new ComputeError('NOT_FOUND', `Pool ${poolId} not found`);
  return toPool(rows[0]);
}

/** A `nodes` row as schedulability and rollups need it. */
export interface NodeRow {
  id: string;
  siteId: string;
  poolId: string;
  ownerTenantId: string;
  role: NodeRole;
  provisionState: ProvisionState;
  maintenance: boolean;
  cordoned: boolean;
  connectivity: Connectivity;
  trust: NodeTrust;
  noScheduleReasons: string[];
  observedGeneration: number;
}

interface RawNode {
  id: string;
  site_id: string;
  pool_id: string;
  owner_tenant_id: string;
  role: NodeRole;
  provision_state: ProvisionState;
  maintenance: boolean;
  cordoned: boolean;
  connectivity: Connectivity;
  trust: NodeTrust;
  no_schedule_reasons: string[] | null;
  observed_generation: string | number;
}

/** Every node of a pool (or just `onlyNodes` of it), ordered by id. */
export async function readPoolNodes(
  tx: SqlTx,
  poolId: string,
  onlyNodes?: readonly string[],
): Promise<NodeRow[]> {
  const { rows } = await tx.query<RawNode>(
    `SELECT id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance, cordoned,
            connectivity, trust, no_schedule_reasons, observed_generation
       FROM nodes WHERE pool_id = $1 ${onlyNodes ? 'AND id = ANY($2::text[])' : ''} ORDER BY id`,
    onlyNodes ? [poolId, [...onlyNodes]] : [poolId],
  );
  return rows.map((row) => ({
    id: row.id,
    siteId: row.site_id,
    poolId: row.pool_id,
    ownerTenantId: row.owner_tenant_id,
    role: row.role,
    provisionState: row.provision_state,
    maintenance: row.maintenance,
    cordoned: row.cordoned,
    connectivity: row.connectivity,
    trust: row.trust,
    noScheduleReasons: row.no_schedule_reasons ?? [],
    observedGeneration: Number(row.observed_generation),
  }));
}

interface RawDevice {
  id: string;
  node_id: string;
  parent_id: string | null;
  class: DeviceClass;
  bookable: boolean;
  healthy: boolean;
  attributes: Device['attributes'] | string;
}

/** The devices of some nodes. */
export async function readDevices(tx: SqlTx, nodeIds: readonly string[]): Promise<Device[]> {
  if (nodeIds.length === 0) return [];
  const { rows } = await tx.query<RawDevice>(
    `SELECT id, node_id, parent_id, class, bookable, healthy, attributes
       FROM devices WHERE node_id = ANY($1::text[]) ORDER BY node_id, id`,
    [nodeIds],
  );
  return rows.map((row) => {
    const device: Device = {
      id: row.id,
      nodeId: row.node_id,
      class: row.class,
      bookable: row.bookable,
      healthy: row.healthy,
      attributes:
        typeof row.attributes === 'string'
          ? (JSON.parse(row.attributes) as Device['attributes'])
          : row.attributes,
    };
    if (row.parent_id !== null) device.parentId = row.parent_id;
    return device;
  });
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Device ids (of these nodes) with a booking that overlaps `during`; bookings of `ignoreAllocations`
 * do not count (a what-if for preemption).
 */
export async function readBusyDevices(
  tx: SqlTx,
  nodeIds: readonly string[],
  during: TimeRange,
  ignoreAllocations: readonly string[] = [],
): Promise<Set<string>> {
  if (nodeIds.length === 0) return new Set();
  const { rows } = await tx.query<{ device_id: string }>(
    `SELECT DISTINCT b.device_id FROM device_bookings b JOIN devices d ON d.id = b.device_id
      WHERE d.node_id = ANY($1::text[])
        AND b.during && tstzrange($2::timestamptz, $3::timestamptz)
        AND NOT (b.allocation_id = ANY($4::text[]))`,
    [nodeIds, iso(during.start), iso(during.end), [...ignoreAllocations]],
  );
  return new Set(rows.map((row) => row.device_id));
}

/**
 * Nodes of a pool whose host runtime caches `imageId` (`node_image_cache`, fed by inventory from the
 * daemon's `images` section), for the `image-cached` scorer. Empty while that table does not exist.
 */
export async function readImageCachedNodes(
  tx: SqlTx,
  poolId: string,
  imageId: string,
): Promise<Set<string>> {
  const exists = await tx.query<{ present: boolean }>(
    `SELECT to_regclass('node_image_cache') IS NOT NULL AS present`,
  );
  if (!exists.rows[0]?.present) return new Set();
  const { rows } = await tx.query<{ node_id: string }>(
    `SELECT c.node_id FROM node_image_cache c JOIN nodes n ON n.id = c.node_id
      WHERE n.pool_id = $1 AND c.image_id = $2 AND c.state = 'ready'`,
    [poolId, imageId],
  );
  return new Set(rows.map((row) => row.node_id));
}

/** `node_resources` rows by node, then resource. */
export async function readNodeResources(
  tx: SqlTx,
  nodeIds: readonly string[],
): Promise<Map<string, Record<string, ScalarResource>>> {
  const byNode = new Map<string, Record<string, ScalarResource>>();
  if (nodeIds.length === 0) return byNode;
  const { rows } = await tx.query<{
    node_id: string;
    resource: string;
    allocatable: string | number;
    ratio: string | number;
    allocated: string | number;
  }>(
    `SELECT node_id, resource, allocatable, ratio, allocated FROM node_resources
      WHERE node_id = ANY($1::text[])`,
    [nodeIds],
  );
  for (const row of rows) {
    const resources = byNode.get(row.node_id) ?? {};
    resources[row.resource] = {
      allocatable: Number(row.allocatable),
      ratio: Number(row.ratio),
      allocated: Number(row.allocated),
    };
    byNode.set(row.node_id, resources);
  }
  return byNode;
}

/** `node_labels` by node, as a key → value record. */
export async function readNodeLabels(
  tx: SqlTx,
  nodeIds: readonly string[],
): Promise<Map<string, Record<string, string>>> {
  const byNode = new Map<string, Record<string, string>>();
  if (nodeIds.length === 0) return byNode;
  const { rows } = await tx.query<{ node_id: string; key: string; value: string }>(
    // `bc.dev/` labels count only when the system wrote them (bcd's Hello, via the gateway): an
    // operator-set one could claim a capability the node's bcd does not enforce.
    `SELECT node_id, key, value FROM node_labels
      WHERE node_id = ANY($1::text[]) AND (NOT starts_with(key, 'bc.dev/') OR source = 'system')`,
    [nodeIds],
  );
  for (const row of rows) {
    const labels = byNode.get(row.node_id) ?? {};
    labels[row.key] = row.value;
    byNode.set(row.node_id, labels);
  }
  return byNode;
}

type Links = Record<string, Record<string, GpuLink>>;

/** `capacity_device_links` by node, symmetric. */
export async function readDeviceLinks(
  tx: SqlTx,
  nodeIds: readonly string[],
): Promise<Map<string, Links>> {
  const byNode = new Map<string, Links>();
  if (nodeIds.length === 0) return byNode;
  const { rows } = await tx.query<{ node_id: string; a: string; b: string; link: GpuLink }>(
    `SELECT node_id, a, b, link FROM capacity_device_links WHERE node_id = ANY($1::text[])`,
    [nodeIds],
  );
  for (const row of rows) {
    const links = byNode.get(row.node_id) ?? {};
    (links[row.a] ??= {})[row.b] = row.link;
    (links[row.b] ??= {})[row.a] = row.link;
    byNode.set(row.node_id, links);
  }
  return byNode;
}

/** One pair of a node's GPU topology matrix. */
export interface DeviceLink {
  a: string;
  b: string;
  link: GpuLink;
}

/**
 * Replaces a node's topology in `capacity_device_links` (the inventory controller calls it when the
 * `gpus` section changes). Pairs are normalized to `a < b`; a pair given twice keeps the better link.
 */
export async function writeDeviceLinks(
  tx: SqlTx,
  nodeId: string,
  links: readonly DeviceLink[],
): Promise<number> {
  const pairs = new Map<string, DeviceLink>();
  for (const { a, b, link } of links) {
    if (!gpuLinkOrder.includes(link))
      throw new ComputeError('INVALID_INPUT', `Unknown GPU link ${JSON.stringify(link)}`);
    if (a === b) continue;
    const [left, right] = a < b ? [a, b] : [b, a];
    const key = `${left}\u0000${right}`;
    const previous = pairs.get(key);
    if (!previous || gpuLinkOrder.indexOf(link) < gpuLinkOrder.indexOf(previous.link))
      pairs.set(key, { a: left, b: right, link });
  }
  await tx.query(`DELETE FROM capacity_device_links WHERE node_id = $1`, [nodeId]);
  const list = [...pairs.values()];
  if (list.length > 0)
    await tx.query(
      `INSERT INTO capacity_device_links (node_id, a, b, link)
       SELECT $1, * FROM unnest($2::text[], $3::text[], $4::text[])`,
      [
        nodeId,
        list.map((pair) => pair.a),
        list.map((pair) => pair.b),
        list.map((pair) => pair.link),
      ],
    );
  return list.length;
}

/**
 * Materializes a node's GPU topology from its inventory `gpus` section (inventory's `gpuLinks`:
 * pairs of the GPU UUIDs that `devicesFromGpus` gives the `gpu` atoms). Call it wherever
 * `node.inventory.changed` is handled, in the same transaction as the device upsert.
 */
export async function syncDeviceLinks(
  tx: SqlTx,
  nodeId: string,
  section: GpusSection | undefined,
): Promise<number> {
  return writeDeviceLinks(tx, nodeId, gpuLinks(section));
}

export interface LoadNodeViewsOptions {
  /** Leave these nodes out entirely. */
  excludeNodes?: readonly string[];
  /** Load only these nodes of the pool (a placement shortlist). */
  onlyNodes?: readonly string[];
  /** Count these allocations' atoms as free (a what-if for spot preemption). */
  ignoreAllocations?: readonly string[];
}

/**
 * Builds the placement view of a pool for one interval: every node, with devices, free atoms
 * (bookable, healthy and without an overlapping booking), scalars, labels and links. Devices and
 * bookings are read only for schedulable nodes; the others keep their node columns, so the
 * pipeline can report why they were turned down.
 */
export async function loadNodeViews(
  tx: SqlTx,
  pool: Pick<PoolRow, 'id' | 'ownerTenantId'>,
  during: TimeRange,
  options: LoadNodeViewsOptions = {},
): Promise<NodeView[]> {
  const excluded = new Set(options.excludeNodes ?? []);
  const nodes = (await readPoolNodes(tx, pool.id, options.onlyNodes)).filter(
    (node) => !excluded.has(node.id),
  );
  // Nodes dedicated to a tenant load too: the pipeline decides per request tenant.
  const live = nodes.filter((node) => mayBeSchedulable(node, pool)).map((node) => node.id);
  const [devices, busy, resources, labels, links] = [
    await readDevices(tx, live),
    await readBusyDevices(tx, live, during, options.ignoreAllocations),
    await readNodeResources(tx, live),
    await readNodeLabels(
      tx,
      nodes.map((node) => node.id),
    ),
    await readDeviceLinks(tx, live),
  ];
  const devicesByNode = new Map<string, Device[]>();
  for (const device of devices) {
    const list = devicesByNode.get(device.nodeId) ?? [];
    list.push(device);
    devicesByNode.set(device.nodeId, list);
  }
  return nodes.map((node) => {
    const all = devicesByNode.get(node.id) ?? [];
    const free = all.filter(
      (device): device is Atom => device.bookable && device.healthy && !busy.has(device.id),
    );
    const view: NodeView = {
      ...node,
      labels: labels.get(node.id) ?? {},
      devices: all,
      free,
      resources: resources.get(node.id) ?? {},
    };
    const nodeLinks = links.get(node.id);
    if (nodeLinks) view.links = nodeLinks;
    return view;
  });
}
