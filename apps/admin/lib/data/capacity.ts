// Capacity data for the admin panel: the API's shapes (pools.list, capacity.summary/timeline/preview,
// reservations.*, quotas.*, usage.list, flavors.list), one `CapacitySource` interface, and two sources:
//
// - `createSimCapacitySource({ seed })`: a deterministic simulated fleet. Bookings are planned per node and
//   per GPU (atoms), so the rollup, the timelines, the Gantt and usage all agree with each other the way the
//   real tables do. The plan is a function of (seed, week) only; states follow the clock, so a reservation
//   placed for 14:00 turns active at 14:00 while the page is open. Mutations (release, cancel, extend,
//   create, quota set) apply to an in-memory overlay.
// - `createLiveCapacitySource(request)`: the same interface over a ComputeRequester-style
//   `request(path, body)` against /api/compute.
//
// Everything here is SSR-safe: no randomness or clock reads at module load.

import { DAY, HOUR } from './core';
import { nodeHealth } from './fleet-health';
import { poolPulse } from './platform';
import { poolNodeId, pools as topoPools, sites as topoSites, tenants as topoTenants, type Pool as TopoPool } from './topology';

// --- API shapes --------------------------------------------------------------------------------------

export type PoolClass = 'metal-host' | 'metal-dedicated' | 'vps-host' | 'provider';
export type SharingMode = 'exclusive' | 'mig' | 'timeslice' | 'mps';
export type ReservationBinding = 'hold' | 'instance' | 'node' | 'kubernetes';
export type ReservationState =
  | 'draft'
  | 'denied'
  | 'awaiting-confirmation'
  | 'pending'
  | 'placed'
  | 'binding'
  | 'active'
  | 'releasing'
  | 'released'
  | 'failed'
  | 'cancelled'
  | 'expired';

export const reservationStates: readonly ReservationState[] = [
  'awaiting-confirmation',
  'pending',
  'placed',
  'binding',
  'active',
  'releasing',
  'released',
  'expired',
  'cancelled',
  'failed',
  'denied',
];

/** States whose bookings hold devices now or later. */
export const liveStates: ReadonlySet<ReservationState> = new Set([
  'placed',
  'binding',
  'active',
  'releasing',
]);

export interface TimeRange {
  start: number;
  end: number;
}

export interface Condition {
  type: string;
  status: 'true' | 'false' | 'unknown';
  reason?: string;
  message?: string;
  since: number;
}

/** The PoolPolicy fields the admin shows; the rest pass through untyped. */
export interface PoolPolicy {
  overcommit?: Record<string, number>;
  disruptionBudget?: number;
  maxPending?: string;
  sharing?: { replicas?: number };
  migLayout?: string;
  tenantRoot?: boolean;
  runtime?: string;
  singleTenant?: boolean;
  perGpu?: { vcpu?: number; memoryGiB?: number };
  hostReserve?: { vcpu?: number; memoryGiB?: number };
  hugepages?: { size: '2Mi' | '1Gi'; count: number; perNuma?: boolean };
  joinAttestors?: string[];
  kubernetes?: { apiServer?: string; gpuApi?: 'device-plugin' | 'dra'; platformOperated?: boolean };
  gpu?: { powerLimitWatts?: number; ecc?: boolean };
  admission?: { budgetCheck?: 'none' | 'meter' };
  [key: string]: unknown;
}

export interface QuotaRow {
  /** Absent in `quotas.get` (always the caller's tenant); set on the admin's cross-tenant rows. */
  tenantId?: string;
  poolId: string;
  resource: string;
  max: number;
  used: number;
  available?: number;
}

/** `pools.list` item (capacity's TenantPool). */
export interface AdminPool {
  id: string;
  ownerTenantId: string;
  siteId: string;
  class: PoolClass;
  gpuModel?: string;
  sharing: SharingMode;
  agent: 'bcd' | 'none';
  providerAccountId?: string;
  policy: PoolPolicy;
  version: number;
  owned: boolean;
  archived: boolean;
  quotas: QuotaRow[];
}

/** One rollup row (capacity's PoolCapacity). */
export interface CapacityRow {
  poolId?: string;
  resource: string;
  total: number;
  allocatable: number;
  allocated: number;
  reserved: number;
  available: number;
  provisioning?: number;
  unhealthy?: number;
  maintenance?: number;
  unreachable?: number;
  updatedAt?: number;
  /**
   * Admin extra (sim; absent from the API): unbooked GPUs on schedulable nodes right now. Without it the views
   * fall back to allocatable − allocated.
   */
  freeNow?: number;
}

/** Free GPUs now, and the share of schedulable GPUs in use, from a rollup row. */
export function rowFree(row: CapacityRow): { freeNow: number; utilization: number } {
  const freeNow = row.freeNow ?? Math.max(0, row.allocatable - row.allocated);
  return { freeNow, utilization: row.allocatable > 0 ? Math.min(1, (row.allocatable - freeNow) / row.allocatable) : 0 };
}

export interface CapacitySummary {
  pools: { poolId: string; gpuModel: string; owned: boolean; capacity: CapacityRow[] }[];
  byGpuModel: Record<
    string,
    { total: number; allocatable: number; allocated: number; reserved: number; available: number }
  >;
}

export interface CapacityTimeline {
  poolId: string;
  allocatable: number;
  buckets: { start: number; end: number; booked: number; free: number }[];
}

export interface CapacityPreview {
  fits: boolean;
  candidates: { nodeId: string; atoms: string[]; score: number }[];
  reason?: string;
  preemptible?: { reservations: number; startsAt: number };
}

export interface DeviceRequest {
  class: 'gpu' | 'gpu.mig' | 'gpu.slot' | 'node';
  count: number;
  sharing?: SharingMode;
}

export interface ReservationSpec {
  poolId: string;
  projectId?: string;
  devices: DeviceRequest[];
  resources?: Record<string, number>;
  topology?: 'any' | 'nvlink-all';
  gang?: { size: number; topologyKey?: string };
  start?: number;
  duration: string;
  binding?: ReservationBinding;
  leaseSeconds?: number;
  spot?: boolean;
  hostShare?: Record<string, number>;
}

export interface Reservation {
  id: string;
  tenantId: string;
  poolId: string;
  projectId?: string;
  state: ReservationState;
  request: ReservationSpec;
  during?: TimeRange;
  leaseExpiresAt?: number;
  ownerIdentityId: string;
  agentId?: string;
  idempotencyKey: string;
  conditions: Condition[];
  binding?: { nodeId: string; cdiDevices: string[]; envFile: string; cgroupParent?: string };
  operation?: { id: string; state: 'pending' | 'running' | 'succeeded' | 'failed'; error?: { code: string; message: string } };
  version: number;
  /** Admin extra (sim, or joined from allocations when live): the nodes it booked. */
  nodeIds?: string[];
  /** Admin extra: the booked atoms, `<nodeId>/gpu<index>`. */
  atoms?: string[];
}

/** A node as capacity sees it: its GPUs and whether they count as allocatable. */
export interface CapacityNode {
  id: string;
  poolId: string;
  gpus: number;
  health: 'ok' | 'unhealthy' | 'maintenance' | 'provisioning' | 'unreachable';
}

/** `usage.list` item. */
export interface UsageWindow {
  idempotencyKey: string;
  allocationId: string;
  identityId?: string;
  meter: string;
  quantity: number;
  windowStart: number;
  windowEnd: number;
  tags: Record<string, string>;
  outcome?: 'recorded' | 'duplicate' | 'reattributed' | 'dead-lettered';
}

/** `flavors.list` item (vps FlavorRecord). */
export interface FlavorRecord {
  id: string;
  poolId: string;
  name: string;
  vcpu: number;
  memoryGiB: number;
  diskGiB: number;
  gpus: number;
  placement?: { numaAffine?: boolean; pinned?: boolean; hugepages?: '2Mi' | '1Gi' };
  offerId?: string;
  archived: boolean;
  version: number;
}

/** A pool offer (pools.offer): who else may book the pool, with their quota. */
export interface PoolOffer {
  poolId: string;
  tenantId: string;
  quota: Record<string, number>;
  priority?: number;
  includeDescendants: boolean;
}

export interface TenantRef {
  id: string;
  name: string;
  projects: string[];
}

export interface IdentityRef {
  id: string;
  name: string;
  tenantId: string;
  agent?: boolean;
}

export interface SiteRef {
  id: string;
  name: string;
  region: string;
}

/** Everything the capacity pages read, loaded together. */
export interface CapacitySnapshot {
  now: number;
  tenantId: string;
  pools: AdminPool[];
  summary: CapacitySummary;
  reservations: Reservation[];
  quotas: QuotaRow[];
  usage: UsageWindow[];
  flavors: FlavorRecord[];
  offers: PoolOffer[];
  tenants: TenantRef[];
  identities: IdentityRef[];
  sites: SiteRef[];
  /** Estimated price per meter unit (IAM billing holds the real prices). */
  prices: Record<string, number>;
  /** Nodes per pool (sim knows them; live leaves it empty). */
  nodesByPool: Record<string, string[]>;
  /** Every node with GPUs and its health (sim; live leaves it empty until the fleet source joins it). */
  nodes: CapacityNode[];
  source: 'sim' | 'live';
}

export interface PlacementRequest {
  poolId: string;
  gpus: number;
  durationMs: number;
  start?: number;
  gang?: number;
  spot?: boolean;
  tenantId?: string;
  projectId?: string;
  binding?: ReservationBinding;
}

export interface CapacitySource {
  readonly kind: 'sim' | 'live';
  load(signal?: AbortSignal): Promise<CapacitySnapshot>;
  timeline(
    poolId: string,
    range: { from: number; to: number; stepMinutes?: number },
    signal?: AbortSignal,
  ): Promise<CapacityTimeline>;
  preview(request: PlacementRequest): Promise<CapacityPreview>;
  create(request: PlacementRequest): Promise<Reservation>;
  release(reservationId: string): Promise<Reservation>;
  cancel(reservationId: string): Promise<Reservation>;
  extend(reservationId: string, byMs: number): Promise<Reservation>;
  setQuota(row: { tenantId?: string; poolId: string; resource: string; max: number }): Promise<QuotaRow>;
}

// --- Small helpers shared by the views ----------------------------------------------------------------

export { DAY, HOUR };
export const WEEK = 7 * DAY;

/** `gpu.<model>.hours` meter for a short GPU model name ("H100", "H100 MIG" → `gpu.h100.mig.hours`). */
export function gpuMeter(shortModel: string): string {
  const slug = shortModel
    .toLowerCase()
    .replace(/^nvidia\s+|^amd\s+/, '')
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.|\.$/g, '');
  return `gpu.${slug || 'unknown'}.hours`;
}

export function reservationGpus(reservation: Pick<Reservation, 'request'>): number {
  const perNode = reservation.request.devices.reduce(
    (sum, device) => sum + (device.class === 'node' ? 8 : device.count),
    0,
  );
  return perNode * (reservation.request.gang?.size ?? 1);
}

export function durationMs(duration: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)$/.exec(duration);
  if (!match) return 0;
  const unit = { ms: 1, s: 1_000, m: 60_000, h: HOUR, d: DAY, w: WEEK }[match[2] as 'ms'];
  return Number(match[1]) * unit;
}

export function formatDuration(ms: number): string {
  if (ms % WEEK === 0 && ms >= WEEK) return `${ms / WEEK}w`;
  if (ms % DAY === 0 && ms >= DAY) return `${ms / DAY}d`;
  if (ms % HOUR === 0) return `${ms / HOUR}h`;
  return `${Math.round(ms / 60_000)}m`;
}

// --- Seeded randomness ---------------------------------------------------------------------------------

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = ReturnType<typeof mulberry32>;
const pick = <T>(rng: Rng, items: readonly T[]): T => items[Math.floor(rng() * items.length)]!;
const weighted = <T>(rng: Rng, items: readonly (readonly [T, number])[]): T => {
  const total = items.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = rng() * total;
  for (const [item, weight] of items) {
    roll -= weight;
    if (roll <= 0) return item;
  }
  return items[items.length - 1]![0];
};
const idFrom = (rng: Rng, prefix: string) =>
  `${prefix}_${Math.floor(rng() * 36 ** 8)
    .toString(36)
    .padStart(8, '0')}`;

// --- The simulated fleet -------------------------------------------------------------------------------

// The simulated fleet is the shared topology (lib/data/topology.ts: the same sites, pool ids, tenants and node ids
// the fleet pages list), plus what only capacity needs per pool: class, sharing, policy, binding, load.

const PLATFORM = 'ten_root';

const SITES: SiteRef[] = topoSites.map((site) => ({
  id: site.id,
  name: site.name,
  region: site.region === 'eu' ? 'Europe' : 'United States',
}));

const PROJECTS: Record<string, string[]> = {
  ten_root: ['infra', 'burn-in'],
  ten_aurora: ['aurora-7b', 'eval', 'rlhf'],
  ten_kestrel: ['kestrel-llm', 'inference', 'distill'],
  ten_meridian: ['protein-fold', 'docking'],
  ten_northwind: ['render-farm', 'upscale'],
  ten_polaris: ['sim2real', 'vla-train'],
  ten_quanta: ['md-sim', 'surrogates', 'serving'],
  ten_sable: ['malware-ml', 'sandbox-ci'],
};

const TENANTS: TenantRef[] = topoTenants.map((tenant) => ({
  id: tenant.id,
  name: tenant.name,
  projects: PROJECTS[tenant.id] ?? ['default'],
}));

const FIRST = ['Ada', 'Bo', 'Chen', 'Dara', 'Eli', 'Farah', 'Gus', 'Hana', 'Ivo', 'Jun', 'Kai', 'Lena', 'Mo', 'Noor'];

interface PoolSeed {
  id: string;
  siteId: string;
  class: PoolClass;
  gpuModel: string;
  /** Short model name ("H100"), for meters and dense views. */
  short: string;
  sharing: SharingMode;
  nodes: number;
  gpusPerNode: number;
  vcpuPerNode: number;
  memoryGiBPerNode: number;
  /** Target booked fraction. */
  load: number;
  owner?: string;
  agent?: 'bcd' | 'none';
  providerAccountId?: string;
  policy: PoolPolicy;
  binding: ReservationBinding;
  tenants: string[];
  gangs?: boolean;
  spotShare?: number;
  /** List price per GPU hour (GPU pools) or per vCPU hour. */
  price: number;
  topo: TopoPool;
}

type PoolExtras = Omit<PoolSeed, 'id' | 'siteId' | 'gpuModel' | 'short' | 'nodes' | 'gpusPerNode' | 'vcpuPerNode' | 'memoryGiBPerNode' | 'price' | 'topo'>;

const EXTRAS: Record<string, PoolExtras> = {
  pool_h100_fra1: {
    class: 'metal-host',
    sharing: 'exclusive',
    load: 0.84,
    policy: { disruptionBudget: 0.05, perGpu: { vcpu: 26, memoryGiB: 240 }, gpu: { powerLimitWatts: 700, ecc: true }, joinAttestors: ['tpm'] },
    binding: 'hold',
    tenants: ['ten_aurora', 'ten_kestrel', 'ten_polaris', 'ten_quanta', 'ten_meridian'],
    gangs: true,
    spotShare: 0.08,
  },
  pool_h200_iad1: {
    class: 'metal-host',
    sharing: 'exclusive',
    load: 0.76,
    policy: { perGpu: { vcpu: 26, memoryGiB: 240 }, maxPending: '6h', admission: { budgetCheck: 'meter' } },
    binding: 'hold',
    tenants: ['ten_kestrel', 'ten_quanta', 'ten_aurora'],
    spotShare: 0.22,
  },
  pool_b200_sjc1: {
    class: 'metal-host',
    sharing: 'exclusive',
    load: 0.9,
    policy: {
      perGpu: { vcpu: 34, memoryGiB: 360 },
      hugepages: { size: '1Gi', count: 512, perNuma: true },
      kubernetes: { apiServer: 'https://k8s-sjc1.internal:6443', gpuApi: 'dra', platformOperated: true },
    },
    binding: 'kubernetes',
    tenants: ['ten_root'],
    gangs: true,
  },
  pool_a100_ams2: {
    class: 'metal-host',
    sharing: 'exclusive',
    load: 0.66,
    policy: { perGpu: { vcpu: 16, memoryGiB: 120 } },
    binding: 'hold',
    tenants: ['ten_meridian', 'ten_polaris', 'ten_sable', 'ten_aurora'],
    gangs: true,
  },
  pool_l40s_fra1: {
    class: 'vps-host',
    sharing: 'timeslice',
    load: 0.55,
    policy: { sharing: { replicas: 4 }, runtime: 'cloud-hypervisor', overcommit: { vcpu: 2, memoryGiB: 1.2 }, hostReserve: { vcpu: 4, memoryGiB: 16 } },
    binding: 'instance',
    tenants: ['ten_northwind', 'ten_sable', 'ten_quanta'],
  },
  pool_mig_iad1: {
    class: 'metal-host',
    sharing: 'mig',
    load: 0.7,
    policy: { migLayout: 'all-1g.10gb', disruptionBudget: 0.1 },
    binding: 'hold',
    tenants: ['ten_quanta', 'ten_sable', 'ten_kestrel'],
  },
  pool_cpu_hel1: {
    class: 'provider',
    sharing: 'exclusive',
    load: 0.48,
    agent: 'none',
    providerAccountId: 'pa_hetzner_robot',
    policy: {},
    binding: 'instance',
    tenants: ['ten_sable', 'ten_meridian', 'ten_northwind'],
  },
  pool_sbx_ams2: {
    class: 'vps-host',
    sharing: 'exclusive',
    load: 0.38,
    policy: { runtime: 'firecracker', overcommit: { vcpu: 3 }, hostReserve: { vcpu: 4, memoryGiB: 16 } },
    binding: 'instance',
    tenants: ['ten_sable', 'ten_kestrel', 'ten_aurora'],
  },
  pool_sbx_iad1: {
    class: 'vps-host',
    sharing: 'exclusive',
    load: 0.38,
    policy: { runtime: 'firecracker', overcommit: { vcpu: 3 }, hostReserve: { vcpu: 4, memoryGiB: 16 } },
    binding: 'instance',
    tenants: ['ten_kestrel', 'ten_polaris'],
  },
};

const DEFAULT_EXTRAS: PoolExtras = { class: 'metal-host', sharing: 'exclusive', load: 0.6, policy: {}, binding: 'hold', tenants: [PLATFORM] };

const POOLS: PoolSeed[] = topoPools.map((pool) => {
  const extras = EXTRAS[pool.id] ?? DEFAULT_EXTRAS;
  return {
    ...extras,
    // Pools not offered to anyone book for the operator only.
    tenants: pool.offered ? extras.tenants : [PLATFORM],
    id: pool.id,
    siteId: pool.siteId,
    gpuModel: pool.model,
    short: pool.short,
    nodes: pool.nodes,
    gpusPerNode: pool.gpusPerNode,
    vcpuPerNode: pool.vcpusPerNode,
    memoryGiBPerNode: pool.memoryGiBPerNode,
    price: pool.price,
    topo: pool,
  };
});

/** `gpu.<model>.hours` meter of a pool. */
const meterOf = (pool: PoolSeed) => gpuMeter(pool.short);

const PRICES: Record<string, number> = {
  ...Object.fromEntries(POOLS.filter((pool) => pool.gpusPerNode > 0).map((pool) => [meterOf(pool), pool.price])),
  'node.metal.hours': 14,
  'vps.vcpu.hours': 0.018,
  'vps.memory.gib.hours': 0.0035,
};

type PlannedNode = CapacityNode;

interface PlannedBooking {
  id: string;
  poolId: string;
  tenantId: string;
  projectId: string;
  identityId: string;
  agentId?: string;
  start: number;
  end: number;
  /** Atoms per node: node id → GPU indices. */
  atoms: { nodeId: string; gpus: number[] }[];
  gangSize?: number;
  spot: boolean;
  lease?: number;
  binding: ReservationBinding;
  /** Planned fate once terminal (for bookings in the past) or its pre-start state. */
  fate: 'released' | 'expired' | 'cancelled' | 'failed';
  preState: 'placed' | 'pending' | 'awaiting-confirmation';
}

interface Plan {
  epoch: number;
  nodes: PlannedNode[];
  bookings: PlannedBooking[];
  identities: IdentityRef[];
  flavors: FlavorRecord[];
  offers: PoolOffer[];
}

const PLAN_BEFORE = 35 * DAY;
const PLAN_AFTER = 21 * DAY;

function planFleet(seed: number, epoch: number): Plan {
  const rng = mulberry32(seed ^ Math.floor(epoch / WEEK));
  const identities: IdentityRef[] = [];
  for (const tenant of TENANTS) {
    const count = 2 + Math.floor(rng() * 4);
    for (let index = 0; index < count; index += 1)
      identities.push({
        id: idFrom(rng, 'idn'),
        name: `${pick(rng, FIRST)} ${String.fromCharCode(65 + Math.floor(rng() * 26))}.`,
        tenantId: tenant.id,
      });
    identities.push({ id: idFrom(rng, 'agt'), name: `${tenant.name.split(' ')[0]} agent`, tenantId: tenant.id, agent: true });
  }
  const people = (tenantId: string) => identities.filter((identity) => identity.tenantId === tenantId);

  const nodes: PlannedNode[] = [];
  const bookings: PlannedBooking[] = [];
  const from = epoch - PLAN_BEFORE;
  const to = epoch + PLAN_AFTER;

  for (const pool of POOLS) {
    const poolNodes: PlannedNode[] = [];
    for (let index = 0; index < pool.nodes; index += 1) {
      rng(); // keeps the plan's random sequence stable (this roll once picked a per-week health)
      // Health is not planned: it comes from the fleet's nodeHealth at the clock (see healthAt).
      poolNodes.push({ id: poolNodeId(pool.topo, index), poolId: pool.id, gpus: pool.gpusPerNode, health: 'ok' });
    }
    nodes.push(...poolNodes);

    // Per-node busy intervals (per GPU index), so gangs and splits never overlap.
    const busy = new Map<string, TimeRange[][]>(
      poolNodes.map((node) => [node.id, Array.from({ length: node.gpus }, () => [] as TimeRange[])]),
    );
    const free = (nodeId: string, gpus: number[], start: number, end: number) =>
      gpus.every((gpu) => busy.get(nodeId)![gpu]!.every((range) => range.end <= start || range.start >= end));
    const mark = (nodeId: string, gpus: number[], start: number, end: number) =>
      gpus.forEach((gpu) => busy.get(nodeId)![gpu]!.push({ start, end }));

    const book = (atoms: PlannedBooking['atoms'], start: number, end: number, gangSize?: number) => {
      const tenantId = pick(rng, pool.tenants);
      const tenant = TENANTS.find((entry) => entry.id === tenantId)!;
      const who = people(tenantId);
      const person = pick(rng, who);
      const spot = rng() < (pool.spotShare ?? 0.04);
      bookings.push({
        id: idFrom(rng, 'rsv'),
        poolId: pool.id,
        tenantId,
        projectId: pick(rng, tenant.projects),
        identityId: person.id,
        ...(person.agent ? { agentId: person.id } : {}),
        start,
        end,
        atoms,
        ...(gangSize ? { gangSize } : {}),
        spot,
        ...(rng() < 0.12 ? { lease: pick(rng, [300, 900, 3600]) } : {}),
        binding: pool.binding,
        fate: weighted(rng, [
          ['released', 86],
          ['expired', 6],
          ['cancelled', 5],
          ['failed', 3],
        ] as const),
        preState: weighted(rng, [
          ['placed', 92],
          ['pending', 6],
          ['awaiting-confirmation', 2],
        ] as const),
      });
    };

    const durations = [2, 4, 6, 8, 12, 24, 24, 48, 72, 96, 168].map((hours) => hours * HOUR);

    // Gangs first: 2–6 whole nodes for 1–7 days.
    if (pool.gangs) {
      const gangCount = Math.round((pool.nodes / 4) * (PLAN_BEFORE + PLAN_AFTER) / (7 * DAY) * pool.load);
      for (let index = 0; index < gangCount; index += 1) {
        const size = Math.min(pool.nodes, 2 + Math.floor(rng() * 5));
        const first = Math.floor(rng() * (pool.nodes - size + 1));
        const members = poolNodes.slice(first, first + size);
        const start = from + Math.floor((rng() * (to - from)) / HOUR) * HOUR;
        const end = start + pick(rng, [24, 48, 72, 120, 168]) * HOUR;
        const all = Array.from({ length: pool.gpusPerNode }, (_, gpu) => gpu);
        if (members.every((node) => free(node.id, all, start, end))) {
          members.forEach((node) => mark(node.id, all, start, end));
          book(members.map((node) => ({ nodeId: node.id, gpus: all })), start, end, size);
        }
      }
    }

    // Then walk each node: whole-node bookings, or split into halves that walk on their own.
    const walk = (node: PlannedNode, gpus: number[], start: number, end: number, depth: number) => {
      let t = start + Math.floor(rng() * 12) * HOUR;
      while (t < end) {
        const gap = Math.floor(-Math.log(1 - rng()) * (1 - pool.load) * 30) * HOUR;
        t += gap;
        if (t >= end) break;
        if (gpus.length >= 2 && depth < 3 && rng() < 0.32) {
          const span = pick(rng, [24, 48, 96]) * HOUR;
          const half = gpus.length / 2;
          walk(node, gpus.slice(0, half), t, Math.min(end, t + span), depth + 1);
          walk(node, gpus.slice(half), t, Math.min(end, t + span), depth + 1);
          t += span;
          continue;
        }
        const length = pick(rng, durations);
        const stop = Math.min(end, t + length);
        if (stop - t >= HOUR && free(node.id, gpus, t, stop)) {
          mark(node.id, gpus, t, stop);
          book([{ nodeId: node.id, gpus }], t, stop);
          t = stop;
        } else {
          // Blocked by a gang: skip past the blocking interval.
          const blockers = gpus.flatMap((gpu) => busy.get(node.id)![gpu]!).filter((range) => range.end > t && range.start < stop);
          t = blockers.length ? Math.max(...blockers.map((range) => range.end)) : t + HOUR;
        }
      }
    };
    for (const node of poolNodes) {
      if (node.gpus === 0) continue;
      walk(node, Array.from({ length: node.gpus }, (_, gpu) => gpu), from, to, 0);
    }
  }

  const flavors: FlavorRecord[] = [];
  for (const pool of POOLS.filter((entry) => entry.class === 'vps-host' || entry.class === 'provider')) {
    const shapes: [string, number, number, number, number, FlavorRecord['placement']?][] =
      pool.class === 'provider'
        ? [
            ['ccx23', 4, 16, 160, 0],
            ['ccx33', 8, 32, 240, 0],
            ['ccx53', 32, 128, 600, 0],
            ['ccx63', 48, 192, 960, 0, { numaAffine: true }],
          ]
        : pool.gpusPerNode > 0
          ? [
              ['cpu.2x', 2, 8, 40, 0],
              ['cpu.8x', 8, 32, 160, 0],
              ['gpu.1x', 16, 96, 400, 1, { numaAffine: true }],
              ['gpu.2x', 32, 192, 800, 2, { numaAffine: true, pinned: true }],
              ['gpu.4x', 64, 384, 1600, 4, { numaAffine: true, pinned: true, hugepages: '1Gi' }],
            ]
          : [
              ['sandbox.micro', 1, 1, 8, 0],
              ['sandbox.small', 2, 4, 20, 0],
              ['sandbox.medium', 4, 8, 40, 0],
              ['sandbox.large', 8, 16, 80, 0, { numaAffine: true }],
              ['sandbox.xl', 16, 64, 160, 0, { numaAffine: true, pinned: true, hugepages: '2Mi' }],
            ];
    for (const [name, vcpu, memoryGiB, diskGiB, gpus, placement] of shapes)
      flavors.push({
        id: idFrom(rng, 'flv'),
        poolId: pool.id,
        name,
        vcpu,
        memoryGiB,
        diskGiB,
        gpus,
        ...(placement ? { placement } : {}),
        ...(pool.class === 'provider' ? { offerId: `hetzner:${name}` } : {}),
        archived: rng() < 0.05,
        version: 1 + Math.floor(rng() * 4),
      });
  }

  // One offer per tenant that books the pool (the operator's own row is its full size). GPU pools grant GPUs
  // and the host share that rides on them; CPU and sandbox pools grant vCPUs and memory.
  const offers: PoolOffer[] = [];
  for (const pool of POOLS) {
    for (const tenantId of new Set([PLATFORM, ...pool.tenants])) {
      const own = tenantId === PLATFORM;
      const fraction = own ? 1 : 0.25 + rng() * 0.5;
      const quota: Record<string, number> =
        pool.gpusPerNode > 0
          ? (() => {
              const total = pool.nodes * pool.gpusPerNode;
              const gpu = own ? total : Math.min(total, Math.max(8, Math.round((total * fraction) / 8) * 8));
              return {
                gpu,
                vcpu: gpu * (pool.policy.perGpu?.vcpu ?? Math.floor(pool.vcpuPerNode / pool.gpusPerNode)),
                memoryGiB: gpu * (pool.policy.perGpu?.memoryGiB ?? Math.floor(pool.memoryGiBPerNode / pool.gpusPerNode)),
              };
            })()
          : {
              vcpu: Math.round((pool.nodes * pool.vcpuPerNode * fraction) / 16) * 16,
              memoryGiB: Math.round((pool.nodes * pool.memoryGiBPerNode * fraction) / 64) * 64,
            };
      offers.push({
        poolId: pool.id,
        tenantId,
        quota,
        ...(own ? {} : { priority: Math.floor(rng() * 3) * 10 }),
        includeDescendants: own || rng() < 0.4,
      });
    }
  }

  return { epoch, nodes, bookings, identities, flavors, offers };
}

// --- Deriving a snapshot from the plan ------------------------------------------------------------------

interface Overlay {
  /** Bookings released or cancelled early, or extended: id → new end / state. */
  ends: Map<string, number>;
  states: Map<string, ReservationState>;
  created: PlannedBooking[];
  quotas: Map<string, number>;
}

const stateAt = (booking: PlannedBooking, now: number, overlay: Overlay): ReservationState => {
  const forced = overlay.states.get(booking.id);
  const end = overlay.ends.get(booking.id) ?? booking.end;
  if (forced) return forced;
  if (end <= now) return booking.fate;
  if (booking.start <= now) {
    if (booking.fate === 'failed' && now - booking.start < 20 * 60_000) return 'binding';
    if (now - booking.start < 3 * 60_000) return 'binding';
    if (end - now < 60_000) return 'releasing';
    return 'active';
  }
  if (booking.fate === 'cancelled' && booking.start - now < DAY) return 'cancelled';
  return booking.preState;
};

/** Whether a reservation in this state holds (or held) devices in its window. */
export const holdsDevices = (state: ReservationState) =>
  liveStates.has(state) || state === 'released' || state === 'expired';

function toReservation(booking: PlannedBooking, now: number, overlay: Overlay): Reservation {
  const state = stateAt(booking, now, overlay);
  const end = overlay.ends.get(booking.id) ?? booking.end;
  const perNode = booking.atoms[0]!.gpus.length;
  const pool = POOLS.find((entry) => entry.id === booking.poolId)!;
  const deviceClass: DeviceRequest['class'] = booking.binding === 'node' ? 'node' : 'gpu';
  const conditions: Condition[] = [];
  if (state === 'pending')
    conditions.push({ type: 'Unschedulable', status: 'true', reason: 'InsufficientCapacity', message: `No ${perNode} free ${pool.gpuModel} in one node for the window`, since: booking.start - 6 * HOUR });
  if (state === 'failed')
    conditions.push({ type: 'Failed', status: 'true', reason: pick(mulberry32(booking.start), ['BindTimeout', 'QuotaExceeded', 'MaxPendingReached']), since: booking.start + 20 * 60_000 });
  if (booking.spot && state === 'active' && end - now < 2 * HOUR)
    conditions.push({ type: 'PreemptionNotice', status: 'true', reason: 'HigherPriority', message: 'A regular reservation needs these GPUs', since: now - 10 * 60_000 });
  const holds = holdsDevices(state);
  return {
    id: booking.id,
    tenantId: booking.tenantId,
    poolId: booking.poolId,
    projectId: booking.projectId,
    state,
    request: {
      poolId: booking.poolId,
      projectId: booking.projectId,
      devices: [deviceClass === 'node' ? { class: 'node', count: 1 } : { class: 'gpu', count: perNode, ...(pool.sharing !== 'exclusive' ? { sharing: pool.sharing } : {}) }],
      ...(booking.gangSize ? { gang: { size: booking.gangSize, topologyKey: 'fabric.domain' } } : {}),
      ...(perNode >= 8 ? { topology: 'nvlink-all' as const } : {}),
      start: booking.start,
      duration: formatDuration(booking.end - booking.start),
      binding: booking.binding,
      ...(booking.spot ? { spot: true } : {}),
      ...(booking.lease ? { leaseSeconds: booking.lease } : {}),
      ...(pool.policy.perGpu ? { hostShare: { vcpu: (pool.policy.perGpu.vcpu ?? 0) * perNode, memoryGiB: (pool.policy.perGpu.memoryGiB ?? 0) * perNode } } : {}),
    },
    ...(holds || state === 'placed' ? { during: { start: booking.start, end } } : {}),
    ...(booking.lease && liveStates.has(state) ? { leaseExpiresAt: Math.max(booking.start, now) + booking.lease * 1000 - ((now - booking.start) % (booking.lease * 1000)) } : {}),
    ownerIdentityId: booking.identityId,
    ...(booking.agentId ? { agentId: booking.agentId } : {}),
    idempotencyKey: `idem-${booking.id.slice(4)}`,
    conditions,
    ...(state === 'active' && booking.binding === 'hold'
      ? {
          binding: {
            nodeId: booking.atoms[0]!.nodeId,
            cdiDevices: booking.atoms[0]!.gpus.map((gpu) => `nvidia.com/gpu=${gpu}`),
            envFile: `/run/bcd/alloc/${booking.id}.env`,
            cgroupParent: `bcd-alloc-${booking.id.slice(4)}.slice`,
          },
        }
      : {}),
    operation: {
      id: `op_${booking.id.slice(4)}`,
      state: state === 'failed' ? 'failed' : state === 'pending' || state === 'binding' ? 'running' : 'succeeded',
      ...(state === 'failed' ? { error: { code: 'UNAVAILABLE', message: 'The node did not report AllocationBound in time' } } : {}),
    },
    version: 1 + (overlay.ends.has(booking.id) ? 1 : 0),
    nodeIds: booking.atoms.map((atom) => atom.nodeId),
    atoms: booking.atoms.flatMap((atom) => atom.gpus.map((gpu) => `${atom.nodeId}/gpu${gpu}`)),
  };
}

interface Derived {
  reservations: Reservation[];
  summary: CapacitySummary;
  quotas: QuotaRow[];
  usage: UsageWindow[];
  timelines: Map<string, CapacityTimeline>;
  /** Every node with its health at the clock (from the fleet). */
  nodes: CapacityNode[];
}

/**
 * A node's capacity health at `now`, decided by the fleet module (lib/data/fleet-health.ts), so capacity never
 * counts or books a GPU on a node the fleet shows as broken: offline → unreachable, degraded → unhealthy,
 * provisioning → provisioning, ready but held (failed, rescue, retiring) or cordoned → maintenance.
 */
function healthAt(nodeId: string, now: number): CapacityNode['health'] {
  const info = nodeHealth(nodeId, now);
  if (!info) return 'ok';
  if (info.health === 'offline') return 'unreachable';
  if (info.health === 'degraded') return 'unhealthy';
  if (info.health === 'provisioning') return 'provisioning';
  return info.schedulable ? 'ok' : 'maintenance';
}

/** A stable uniform [0, 1) per booking. */
const unitOf = (id: string) => {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) hash = Math.imul(hash ^ id.charCodeAt(index), 16777619);
  return mulberry32(hash)();
};

/** Mean lead time of a booking: most are made a day or two ahead, few a week or more. */
const LEAD = 1.6 * DAY;

/**
 * Whether a planned booking exists yet at `now`. Past bookings all exist; a future one appears once
 * `now` is within its (stable, per-booking) lead time, so new reservations arrive while the page is open.
 */
const visibleAt = (booking: PlannedBooking, now: number) =>
  booking.start <= now || unitOf(booking.id) < Math.exp(-(booking.start - now) / LEAD);

function derive(plan: Plan, now: number, overlay: Overlay): Derived {
  const all = [...plan.bookings.filter((booking) => visibleAt(booking, now)), ...overlay.created];
  const reservations = all.map((booking) => toReservation(booking, now, overlay));
  const byId = new Map(all.map((booking) => [booking.id, booking]));
  const holding = reservations.filter((reservation) => holdsDevices(reservation.state));
  const nodesNow: CapacityNode[] = plan.nodes.map((node) => (node.gpus > 0 ? { ...node, health: healthAt(node.id, now) } : node));

  // Rollup per pool (whole GPUs by atom, PLAN §10.6 semantics).
  const summary: CapacitySummary = { pools: [], byGpuModel: {} };
  const quotaUsed = new Map<string, number>();
  for (const pool of POOLS) {
    if (pool.gpusPerNode === 0) {
      // CPU and sandbox pools book no devices: their vCPU and memory rows follow the fleet pulse the Overview
      // shows (lib/data/platform.ts), split between the tenants by stable weights for quota use.
      const pulse = poolPulse(pool.topo, now);
      const memoryPerVcpu = pool.memoryGiBPerNode / pool.vcpuPerNode;
      const row = (resource: 'vcpu' | 'memoryGiB'): CapacityRow => {
        const scale = resource === 'vcpu' ? 1 : memoryPerVcpu;
        const offline = Math.round(pulse.unhealthy * scale);
        const total = Math.round(pulse.total * scale);
        return {
          poolId: pool.id,
          resource,
          total,
          allocatable: total - offline,
          allocated: Math.round(pulse.allocated * scale),
          reserved: Math.round(pulse.reserved * scale),
          available: Math.round(pulse.available * scale),
          provisioning: Math.round(pulse.nodes.provisioning * pool.vcpuPerNode * scale),
          unhealthy: Math.max(0, offline - Math.round(pulse.nodes.provisioning * pool.vcpuPerNode * scale)),
          maintenance: 0,
          unreachable: 0,
          updatedAt: now,
        };
      };
      summary.pools.push({ poolId: pool.id, gpuModel: pool.gpuModel, owned: true, capacity: [row('memoryGiB'), row('vcpu')] });
      const weights = pool.tenants.map((tenantId) => 0.2 + unitOf(`${tenantId}|${pool.id}`));
      const sum = weights.reduce((total, weight) => total + weight, 0);
      pool.tenants.forEach((tenantId, index) => {
        quotaUsed.set(`${tenantId}|${pool.id}|vcpu`, Math.round((pulse.allocated * weights[index]!) / sum));
        quotaUsed.set(`${tenantId}|${pool.id}|memoryGiB`, Math.round(((pulse.allocated * weights[index]!) / sum) * memoryPerVcpu));
      });
      continue;
    }
    const poolNodes = nodesNow.filter((node) => node.poolId === pool.id);
    const counts = { total: 0, allocatable: 0, provisioning: 0, unhealthy: 0, maintenance: 0, unreachable: 0 };
    for (const node of poolNodes) {
      counts.total += node.gpus;
      if (node.health === 'ok') counts.allocatable += node.gpus;
      else counts[node.health] += node.gpus;
    }
    const now_ = new Set<string>();
    const later = new Set<string>();
    for (const reservation of holding) {
      if (reservation.poolId !== pool.id || !reservation.during) continue;
      const booking = byId.get(reservation.id)!;
      const target = reservation.during.start <= now && reservation.during.end > now ? now_ : reservation.during.start > now ? later : undefined;
      if (!target) continue;
      for (const atom of booking.atoms) for (const gpu of atom.gpus) target.add(`${atom.nodeId}/${gpu}`);
      if (target === now_ || target === later) {
        const key = `${reservation.tenantId}|${pool.id}|gpu`;
        if (target === now_) quotaUsed.set(key, (quotaUsed.get(key) ?? 0) + reservationGpus(reservation));
      }
    }
    const allocated = now_.size;
    const reserved = later.size;
    // Exact free GPUs now: unbooked atoms on schedulable nodes (a booking on a broken node doesn't free a
    // healthy GPU, so allocatable − allocated would undercount).
    let freeNow = 0;
    for (const node of poolNodes) if (node.health === 'ok') for (let gpu = 0; gpu < node.gpus; gpu += 1) if (!now_.has(`${node.id}/${gpu}`)) freeNow += 1;
    const gpuRow: CapacityRow = {
      poolId: pool.id,
      resource: 'gpu',
      ...counts,
      allocated,
      reserved,
      available: Math.max(0, counts.allocatable - allocated - reserved),
      freeNow,
      updatedAt: now,
    };
    const scalar = (resource: string, perNode: number, perGpu: number): CapacityRow => {
      const total = poolNodes.length * perNode;
      const allocatable = poolNodes.filter((node) => node.health === 'ok').length * perNode;
      const used = Math.min(allocatable, Math.round(allocated * perGpu));
      const later_ = Math.min(allocatable - used, Math.round(reserved * perGpu * 0.5));
      return { poolId: pool.id, resource, total, allocatable, allocated: used, reserved: later_, available: Math.max(0, allocatable - used - later_), updatedAt: now };
    };
    const vcpuShare = pool.policy.perGpu?.vcpu ?? pool.vcpuPerNode / pool.gpusPerNode;
    const memShare = pool.policy.perGpu?.memoryGiB ?? pool.memoryGiBPerNode / pool.gpusPerNode;
    summary.pools.push({
      poolId: pool.id,
      gpuModel: pool.gpuModel,
      owned: (pool.owner ?? PLATFORM) === PLATFORM,
      capacity: [gpuRow, scalar('memoryGiB', pool.memoryGiBPerNode, memShare), scalar('vcpu', pool.vcpuPerNode, vcpuShare)],
    });
    const model = (summary.byGpuModel[pool.gpuModel] ??= { total: 0, allocatable: 0, allocated: 0, reserved: 0, available: 0 });
    model.total += gpuRow.total;
    model.allocatable += gpuRow.allocatable;
    model.allocated += gpuRow.allocated;
    model.reserved += gpuRow.reserved;
    model.available += gpuRow.available;
  }

  // Quotas: offers become the tenants' rows; the platform's own rows cover its pools.
  const quotas: QuotaRow[] = [];
  for (const offer of plan.offers) {
    for (const [resource, max0] of Object.entries(offer.quota)) {
      const override = overlay.quotas.get(`${offer.tenantId}|${offer.poolId}|${resource}`);
      const max = override ?? max0;
      const pool = POOLS.find((entry) => entry.id === offer.poolId)!;
      const direct = quotaUsed.get(`${offer.tenantId}|${offer.poolId}|${resource}`);
      const gpuUsed = quotaUsed.get(`${offer.tenantId}|${offer.poolId}|gpu`) ?? 0;
      const perGpu =
        resource === 'vcpu'
          ? pool.policy.perGpu?.vcpu ?? Math.floor(pool.vcpuPerNode / Math.max(1, pool.gpusPerNode))
          : pool.policy.perGpu?.memoryGiB ?? Math.floor(pool.memoryGiBPerNode / Math.max(1, pool.gpusPerNode));
      const used = direct ?? (resource === 'gpu' ? gpuUsed : Math.round(gpuUsed * perGpu));
      quotas.push({ tenantId: offer.tenantId, poolId: offer.poolId, resource, max, used, available: Math.max(0, max - used) });
    }
  }

  // Usage: daily windows for the last 30 days, per booking (the real ones are hourly; daily keeps it small).
  const usage: UsageWindow[] = [];
  const usageFrom = Math.floor((now - 30 * DAY) / DAY) * DAY;
  for (const reservation of holding) {
    if (!reservation.during) continue;
    const booking = byId.get(reservation.id)!;
    const pool = POOLS.find((entry) => entry.id === reservation.poolId)!;
    const start = Math.max(reservation.during.start, usageFrom);
    const end = Math.min(reservation.during.end, now);
    if (end <= start) continue;
    const gpus = reservationGpus(reservation);
    for (let day = Math.floor(start / DAY) * DAY; day < end; day += DAY) {
      const hours = (Math.min(end, day + DAY) - Math.max(start, day)) / HOUR;
      if (hours <= 0) continue;
      const tags = { project: reservation.projectId ?? '', poolId: pool.id, tenantId: reservation.tenantId, ...(booking.spot ? { spot: 'true' } : {}) };
      const push = (meter: string, quantity: number, suffix: string) =>
        usage.push({
          idempotencyKey: `${reservation.id}:${day}:${suffix}`,
          allocationId: `alc_${reservation.id.slice(4)}`,
          identityId: reservation.ownerIdentityId,
          meter,
          quantity: Math.round(quantity * 1000) / 1000,
          windowStart: Math.max(start, day),
          windowEnd: Math.min(end, day + DAY),
          tags,
          outcome: (day / DAY + gpus) % 97 === 0 ? 'dead-lettered' : 'recorded',
        });
      if (booking.binding === 'node') push('node.metal.hours', hours * booking.atoms.length, 'node');
      push(meterOf(pool), hours * gpus * (booking.spot ? 0.4 : 1), 'gpu');
      if (booking.binding === 'instance') {
        push('vps.vcpu.hours', hours * gpus * 16, 'vcpu');
        push('vps.memory.gib.hours', hours * gpus * 96, 'mem');
      }
    }
  }
  // CPU and sandbox pools: instance vCPU and memory hours per tenant per day, from the pulse (4 samples a day).
  for (const pool of POOLS.filter((entry) => entry.gpusPerNode === 0)) {
    const weights = pool.tenants.map((tenantId) => 0.2 + unitOf(`${tenantId}|${pool.id}`));
    const sum = weights.reduce((total, weight) => total + weight, 0);
    const memoryPerVcpu = pool.memoryGiBPerNode / pool.vcpuPerNode;
    for (let day = usageFrom; day < now; day += DAY) {
      const end = Math.min(now, day + DAY);
      const hours = (end - day) / HOUR;
      const samples = [0.125, 0.375, 0.625, 0.875].map((f) => poolPulse(pool.topo, day + f * (end - day)).allocated);
      const vcpus = samples.reduce((total, value) => total + value, 0) / samples.length;
      pool.tenants.forEach((tenantId, index) => {
        const share = (vcpus * weights[index]!) / sum;
        const tenant = TENANTS.find((entry) => entry.id === tenantId)!;
        const project = tenant.projects[Math.floor(unitOf(`${tenantId}:${day}`) * tenant.projects.length)]!;
        const tags = { project, poolId: pool.id, tenantId };
        const base = { allocationId: `alc_${pool.id}_${tenantId}`, windowStart: day, windowEnd: end, tags, outcome: 'recorded' as const };
        usage.push({ ...base, idempotencyKey: `${pool.id}:${tenantId}:${day}:vcpu`, meter: 'vps.vcpu.hours', quantity: Math.round(share * hours) });
        usage.push({ ...base, idempotencyKey: `${pool.id}:${tenantId}:${day}:mem`, meter: 'vps.memory.gib.hours', quantity: Math.round(share * hours * memoryPerVcpu) });
      });
    }
  }
  usage.sort((a, b) => a.windowStart - b.windowStart);

  return { reservations, summary, quotas, usage, timelines: new Map(), nodes: nodesNow };
}

/** Hourly (or `stepMinutes`) booked/free GPUs of one pool from the bookings. */
function timelineOf(
  poolId: string,
  reservations: readonly Reservation[],
  allocatable: number,
  range: { from: number; to: number; stepMinutes?: number },
): CapacityTimeline {
  const step = (range.stepMinutes ?? 60) * 60_000;
  const from = Math.floor(range.from / step) * step;
  const count = Math.max(1, Math.ceil((range.to - from) / step));
  const booked = new Float64Array(count);
  for (const reservation of reservations) {
    if (reservation.poolId !== poolId || !reservation.during) continue;
    if (!(liveStates.has(reservation.state) || reservation.state === 'released' || reservation.state === 'expired')) continue;
    const gpus = reservationGpus(reservation);
    const first = Math.max(0, Math.floor((reservation.during.start - from) / step));
    const last = Math.min(count - 1, Math.ceil((reservation.during.end - from) / step) - 1);
    for (let index = first; index <= last; index += 1) {
      const bucketStart = from + index * step;
      const overlap = Math.min(reservation.during.end, bucketStart + step) - Math.max(reservation.during.start, bucketStart);
      // A bucket counts a booking that holds devices for any part of it (the API's semantics: max, not mean).
      if (overlap > 0) booked[index]! += gpus;
    }
  }
  const buckets = Array.from({ length: count }, (_, index) => {
    const value = Math.min(allocatable, Math.round(booked[index]!));
    return { start: from + index * step, end: from + (index + 1) * step, booked: value, free: Math.max(0, allocatable - value) };
  });
  return { poolId, allocatable, buckets };
}

export interface SimOptions {
  seed?: number;
  /** Clock override (tests, SSR snapshots). */
  now?: () => number;
  /** Simulated latency per call. */
  latencyMs?: number;
}

/** The simulated source also answers synchronously (first render and SSR without a loading state). */
export interface SimCapacitySource extends CapacitySource {
  readonly kind: 'sim';
  snapshot(): CapacitySnapshot;
  timelineSync(poolId: string, range: { from: number; to: number; stepMinutes?: number }): CapacityTimeline;
}

export function createSimCapacitySource(options: SimOptions = {}): SimCapacitySource {
  const seed = options.seed ?? 0x5eed;
  const clock = options.now ?? (() => Date.now());
  const latency = options.latencyMs ?? 0;
  const overlay: Overlay = { ends: new Map(), states: new Map(), created: [], quotas: new Map() };
  // Small LRUs: the live clock plus a few look-backs (attention lookbacks, time travel) stay cached side by side
  // instead of evicting each other. Two weekly plans cover a look-back across a week boundary.
  const plans = new Map<number, Plan>();
  const cache = new Map<string, Derived>();
  let revision = 0;

  const planFor = (now: number) => {
    const epoch = Math.floor(now / WEEK) * WEEK;
    let found = plans.get(epoch);
    if (!found) {
      found = planFleet(seed, epoch);
      plans.set(epoch, found);
      if (plans.size > 2) plans.delete(plans.keys().next().value!);
    }
    return found;
  };
  const current = () => {
    const now = clock();
    const fleet = planFor(now);
    // States move by the minute; recompute at most once per 15 s of simulated time.
    const key = `${fleet.epoch}:${Math.floor(now / 15_000)}:${revision}`;
    let derived = cache.get(key);
    if (derived) cache.delete(key);
    else derived = derive(fleet, now, overlay);
    cache.set(key, derived);
    if (cache.size > 8) cache.delete(cache.keys().next().value!);
    return { now, fleet, derived };
  };
  const wait = () => (latency > 0 ? new Promise((resolve) => setTimeout(resolve, latency)) : Promise.resolve());
  const find = (id: string) => {
    const { fleet } = current();
    const booking = [...fleet.bookings, ...overlay.created].find((entry) => entry.id === id);
    if (!booking) throw Object.assign(new Error(`Reservation ${id} not found`), { code: 'NOT_FOUND' });
    return booking;
  };
  const after = (id: string) => {
    revision += 1;
    return current().derived.reservations.find((entry) => entry.id === id)!;
  };

  const placeFor = (request: PlacementRequest) => {
    const { now, fleet, derived } = current();
    const pool = POOLS.find((entry) => entry.id === request.poolId);
    if (!pool) return { fits: false, reason: 'Unknown pool', candidates: [] } as CapacityPreview & { atoms?: PlannedBooking['atoms']; start?: number };
    const start = Math.max(now, request.start ?? now);
    const end = start + request.durationMs;
    const nodesNeeded = request.gang ?? 1;
    const perNode = request.gpus;
    if (pool.gpusPerNode === 0)
      return { fits: false, reason: `${pool.topo.name} has no GPUs: it runs instances and sandboxes (vCPU and memory)`, candidates: [] };
    if (perNode > pool.gpusPerNode)
      return { fits: false, reason: `A ${pool.gpuModel} node has ${pool.gpusPerNode} GPUs; ask for a gang of ${Math.ceil(perNode / pool.gpusPerNode)} nodes instead`, candidates: [] };
    const all = [...fleet.bookings, ...overlay.created];
    const holdingIds = new Set(
      derived.reservations.filter((entry) => liveStates.has(entry.state) && entry.during && entry.during.end > start && entry.during.start < end).map((entry) => entry.id),
    );
    const spotIds = new Set(all.filter((entry) => entry.spot).map((entry) => entry.id));
    const takenBy = (includeSpot: boolean) => {
      const taken = new Map<string, Set<number>>();
      for (const booking of all) {
        if (!holdingIds.has(booking.id)) continue;
        if (!includeSpot && spotIds.has(booking.id)) continue;
        const end_ = overlay.ends.get(booking.id) ?? booking.end;
        if (end_ <= start || booking.start >= end) continue;
        for (const atom of booking.atoms) {
          const set = taken.get(atom.nodeId) ?? new Set<number>();
          atom.gpus.forEach((gpu) => set.add(gpu));
          taken.set(atom.nodeId, set);
        }
      }
      return taken;
    };
    // Only nodes the fleet calls schedulable at this moment (healthAt 'ok').
    const rank = (taken: Map<string, Set<number>>) =>
      derived.nodes
        .filter((node) => node.poolId === pool.id && node.health === 'ok')
        .map((node) => {
          const used = taken.get(node.id) ?? new Set<number>();
          const freeGpus = Array.from({ length: node.gpus }, (_, gpu) => gpu).filter((gpu) => !used.has(gpu));
          // Bin-packing score: prefer the node that ends up fullest (least fragmentation).
          const score = freeGpus.length >= perNode ? Math.round((1 - (freeGpus.length - perNode) / node.gpus) * 1000) / 10 : -1;
          return { nodeId: node.id, atoms: freeGpus.slice(0, perNode).map((gpu) => `${node.id}/gpu${gpu}`), gpus: freeGpus.slice(0, perNode), score };
        })
        .filter((entry) => entry.score >= 0)
        .sort((a, b) => b.score - a.score || a.nodeId.localeCompare(b.nodeId));
    const candidates = rank(takenBy(true));
    if (candidates.length >= nodesNeeded)
      return {
        fits: true,
        candidates: candidates.slice(0, Math.max(nodesNeeded, 5)).map(({ nodeId, atoms, score }) => ({ nodeId, atoms, score })),
        atoms: candidates.slice(0, nodesNeeded).map((entry) => ({ nodeId: entry.nodeId, gpus: entry.gpus })),
        start,
      };
    const withoutSpot = rank(takenBy(false));
    const preemptible =
      !request.spot && withoutSpot.length >= nodesNeeded
        ? { reservations: all.filter((entry) => spotIds.has(entry.id) && holdingIds.has(entry.id) && entry.atoms.some((atom) => withoutSpot.slice(0, nodesNeeded).some((c) => c.nodeId === atom.nodeId))).length, startsAt: start + 2 * 60_000 }
        : undefined;
    return {
      fits: false,
      reason: `Only ${candidates.length} of ${nodesNeeded} node(s) have ${perNode} free ${pool.gpuModel} for the whole window`,
      candidates: candidates.map(({ nodeId, atoms, score }) => ({ nodeId, atoms, score })),
      ...(preemptible ? { preemptible } : {}),
    };
  };

  const memo = new WeakMap<Derived, CapacitySnapshot>();
  const snapshot = (): CapacitySnapshot => {
    const { now, fleet, derived } = current();
    // Same derivation → same object, so views memoize on identity.
    const known = memo.get(derived);
    if (known) return known;
    const nodesByPool: Record<string, string[]> = {};
    for (const node of fleet.nodes) (nodesByPool[node.poolId] ??= []).push(node.id);
    const value: CapacitySnapshot = {
        now,
        tenantId: PLATFORM,
        pools: POOLS.map((pool) => ({
          id: pool.id,
          ownerTenantId: pool.owner ?? PLATFORM,
          siteId: pool.siteId,
          class: pool.class,
          gpuModel: pool.gpuModel,
          sharing: pool.sharing,
          agent: pool.agent ?? 'bcd',
          ...(pool.providerAccountId ? { providerAccountId: pool.providerAccountId } : {}),
          policy: pool.policy,
          version: 3 + (pool.id.length % 5),
          owned: (pool.owner ?? PLATFORM) === PLATFORM,
          archived: false,
          quotas: derived.quotas.filter((row) => row.poolId === pool.id && row.tenantId === PLATFORM),
        })),
        summary: derived.summary,
        reservations: derived.reservations,
        quotas: derived.quotas,
        usage: derived.usage,
        flavors: fleet.flavors,
        offers: fleet.offers.map((offer) => ({
          ...offer,
          quota: Object.fromEntries(Object.entries(offer.quota).map(([resource, max]) => [resource, overlay.quotas.get(`${offer.tenantId}|${offer.poolId}|${resource}`) ?? max])),
        })),
        tenants: TENANTS,
        identities: fleet.identities,
        sites: SITES,
        prices: PRICES,
        nodesByPool,
        nodes: derived.nodes.filter((node) => node.gpus > 0),
        source: 'sim',
    };
    memo.set(derived, value);
    return value;
  };
  const timelineSync = (poolId: string, range: { from: number; to: number; stepMinutes?: number }) => {
    const { derived } = current();
    const row = derived.summary.pools.find((entry) => entry.poolId === poolId)?.capacity.find((entry) => entry.resource === 'gpu');
    return timelineOf(poolId, derived.reservations, row?.allocatable ?? 0, range);
  };

  return {
    kind: 'sim',
    snapshot,
    timelineSync,
    async load() {
      await wait();
      return snapshot();
    },
    async timeline(poolId, range) {
      await wait();
      return timelineSync(poolId, range);
    },
    async preview(request) {
      await wait();
      const { atoms: _atoms, start: _start, ...preview } = placeFor(request) as CapacityPreview & { atoms?: unknown; start?: unknown };
      return preview;
    },
    async create(request) {
      await wait();
      const placed = placeFor(request) as CapacityPreview & { atoms?: PlannedBooking['atoms']; start?: number };
      const { fleet } = current();
      const pool = POOLS.find((entry) => entry.id === request.poolId)!;
      const tenantId = request.tenantId ?? PLATFORM;
      const person = fleet.identities.find((identity) => identity.tenantId === tenantId && !identity.agent) ?? fleet.identities[0]!;
      const start = placed.start ?? Math.max(clock(), request.start ?? clock());
      const booking: PlannedBooking = {
        id: `rsv_${(clock() % 36 ** 8).toString(36).padStart(8, '0')}`,
        poolId: pool.id,
        tenantId,
        projectId: request.projectId ?? TENANTS.find((entry) => entry.id === tenantId)?.projects[0] ?? 'default',
        identityId: person.id,
        start,
        end: start + request.durationMs,
        atoms: placed.atoms ?? [{ nodeId: fleet.nodes.find((node) => node.poolId === pool.id)!.id, gpus: Array.from({ length: request.gpus }, (_, gpu) => gpu) }],
        ...(request.gang && request.gang > 1 ? { gangSize: request.gang } : {}),
        spot: request.spot ?? false,
        binding: request.binding ?? pool.binding,
        fate: 'released',
        preState: placed.fits ? 'placed' : 'pending',
      };
      overlay.created.push(booking);
      return after(booking.id);
    },
    async release(id) {
      await wait();
      find(id);
      overlay.ends.set(id, clock());
      overlay.states.set(id, 'released');
      return after(id);
    },
    async cancel(id) {
      await wait();
      find(id);
      overlay.states.set(id, 'cancelled');
      return after(id);
    },
    async extend(id, byMs) {
      await wait();
      const booking = find(id);
      overlay.ends.set(id, (overlay.ends.get(id) ?? booking.end) + byMs);
      return after(id);
    },
    async setQuota(row) {
      await wait();
      const tenantId = row.tenantId ?? PLATFORM;
      overlay.quotas.set(`${tenantId}|${row.poolId}|${row.resource}`, row.max);
      revision += 1;
      const found = current().derived.quotas.find(
        (entry) => entry.poolId === row.poolId && entry.resource === row.resource && entry.tenantId === tenantId,
      );
      return found ?? { poolId: row.poolId, resource: row.resource, max: row.max, used: 0, available: row.max };
    },
  };
}

// --- The shared simulated fleet ------------------------------------------------------------------------------
//
// One simulated source per JS runtime, so every module (capacity pages, the Overview, the fleet's node views)
// reads the same bookings, and a release on one page shows on every other. Call these with the workspace clock;
// derivation is cached per 15 s of that clock, so call them at `now`, not once per point of a history series
// (use `timelineSync` for series: it is cheap once the snapshot at `now` exists).

let shared: SimCapacitySource | undefined;
const sharedClock = { now: 0 };

/** The shared simulated source. Set its clock with `capacityAt(now)` before calling it directly. */
export function sharedCapacitySource(): SimCapacitySource {
  shared ??= createSimCapacitySource({ now: () => sharedClock.now || Date.now() });
  return shared;
}

/** The capacity snapshot at `now` (the workspace clock), bucketed to 15 s. */
export function capacityAt(now: number): CapacitySnapshot {
  sharedClock.now = Math.floor(now / 15_000) * 15_000;
  return sharedCapacitySource().snapshot();
}

export interface CapacityTotals {
  gpus: {
    total: number;
    allocatable: number;
    allocated: number;
    /** Atoms booked for later (the API's `reserved`; an atom can be allocated now and reserved later). */
    reserved: number;
    /** The API's conservative `available`. */
    available: number;
    /** allocatable − allocated. */
    freeNow: number;
    /** Provisioning, unhealthy, maintenance or unreachable. */
    unschedulable: number;
    utilization: number;
  };
  pools: Record<string, { total: number; allocatable: number; allocated: number; reserved: number; freeNow: number; unschedulable: number; utilization: number }>;
}

/** GPU totals from the capacity rollup at `now`, optionally for one site: the numbers /capacity shows. */
export function capacityTotals(now: number, scope: { siteId?: string } = {}): CapacityTotals {
  const snapshot = capacityAt(now);
  const pools: CapacityTotals['pools'] = {};
  const gpus = { total: 0, allocatable: 0, allocated: 0, reserved: 0, available: 0, freeNow: 0, unschedulable: 0, utilization: 0 };
  const siteOf = new Map(snapshot.pools.map((pool) => [pool.id, pool.siteId]));
  for (const entry of snapshot.summary.pools) {
    if (scope.siteId && siteOf.get(entry.poolId) !== scope.siteId) continue;
    const row = entry.capacity.find((capacity) => capacity.resource === 'gpu');
    if (!row) continue;
    const unschedulable = row.total - row.allocatable;
    const { freeNow, utilization } = rowFree(row);
    pools[entry.poolId] = {
      total: row.total,
      allocatable: row.allocatable,
      allocated: row.allocated,
      reserved: row.reserved,
      freeNow,
      unschedulable,
      utilization,
    };
    gpus.total += row.total;
    gpus.allocatable += row.allocatable;
    gpus.allocated += row.allocated;
    gpus.reserved += row.reserved;
    gpus.available += row.available;
    gpus.freeNow += freeNow;
    gpus.unschedulable += unschedulable;
  }
  gpus.utilization = gpus.allocatable ? Math.min(1, (gpus.allocatable - gpus.freeNow) / gpus.allocatable) : 0;
  return { gpus, pools };
}

export interface GpuHolder {
  reservationId: string;
  tenantId: string;
  projectId?: string;
  poolId: string;
  state: ReservationState;
  since: number;
  until: number;
  spot: boolean;
}

const holderCache = new WeakMap<CapacitySnapshot, Map<string, GpuHolder>>();

/** Who holds each GPU at `now`: atom id (`<nodeId>/gpu<i>`) → the reservation. Free GPUs are absent. */
export function gpuHolders(now: number): Map<string, GpuHolder> {
  const snapshot = capacityAt(now);
  const cached = holderCache.get(snapshot);
  if (cached) return cached;
  const holders = new Map<string, GpuHolder>();
  for (const reservation of snapshot.reservations) {
    if (!reservation.during || !liveStates.has(reservation.state)) continue;
    if (reservation.during.start > snapshot.now || reservation.during.end <= snapshot.now) continue;
    for (const atom of reservation.atoms ?? [])
      holders.set(atom, {
        reservationId: reservation.id,
        tenantId: reservation.tenantId,
        ...(reservation.projectId ? { projectId: reservation.projectId } : {}),
        poolId: reservation.poolId,
        state: reservation.state,
        since: reservation.during.start,
        until: reservation.during.end,
        spot: Boolean(reservation.request.spot),
      });
  }
  holderCache.set(snapshot, holders);
  return holders;
}

/** Reservations that booked a node, overlapping [now − back, now + ahead], by start. */
export function nodeBookings(nodeId: string, now: number, window: { back?: number; ahead?: number } = {}): Reservation[] {
  const snapshot = capacityAt(now);
  const from = snapshot.now - (window.back ?? DAY);
  const to = snapshot.now + (window.ahead ?? 3 * DAY);
  return snapshot.reservations
    .filter((reservation) => reservation.nodeIds?.includes(nodeId) && reservation.during && reservation.during.end > from && reservation.during.start < to)
    .sort((a, b) => a.during!.start - b.during!.start);
}

// --- Insights -------------------------------------------------------------------------------------------------
//
// What an operator should know about capacity right now, derived from the same snapshot every page reads. Shaped
// like the shell's AttentionItem (plus a suggested action), so "Needs attention" can merge them.

export type InsightSeverity = 'critical' | 'warning' | 'info';
export type InsightKind =
  | 'pool-full-soon'
  | 'unplaceable'
  | 'fragmented'
  | 'quota-full'
  | 'quota-idle'
  | 'out-of-service'
  | 'preemption'
  | 'lease-lapsing'
  | 'billing-dead-letter';

export interface CapacityInsight {
  id: string;
  kind: InsightKind;
  severity: InsightSeverity;
  title: string;
  detail: string;
  source: 'capacity';
  href: string;
  at: number;
  subject: string;
  action?: { label: string; href: string };
}

const insightCache = new WeakMap<CapacitySnapshot, Map<string, CapacityInsight[]>>();
const SEVERITY_RANK: Record<InsightSeverity, number> = { critical: 0, warning: 1, info: 2 };

export function capacityInsights(now: number, scope: { siteId?: string } = {}): CapacityInsight[] {
  const snapshot = capacityAt(now);
  const key = scope.siteId ?? '*';
  const cached = insightCache.get(snapshot)?.get(key);
  if (cached) return cached;
  const t = snapshot.now;
  const hour = Math.floor(t / HOUR) * HOUR;
  const source = sharedCapacitySource();
  const pools = snapshot.pools.filter((pool) => !scope.siteId || pool.siteId === scope.siteId);
  const inScope = new Set(pools.map((pool) => pool.id));
  const nameOf = (poolId: string) => topoPools.find((pool) => pool.id === poolId)?.name ?? poolId;
  const shortOf = (poolId: string) => topoPools.find((pool) => pool.id === poolId)?.short ?? '';
  const tenantName = (id: string) => snapshot.tenants.find((tenant) => tenant.id === id)?.name ?? id;
  const clock = (ms: number) => new Date(ms).toISOString().slice(11, 16);
  const inHours = (ms: number) => (ms < HOUR ? `${Math.max(1, Math.round(ms / 60_000))} min` : `${Math.round(ms / HOUR)} h`);
  const out: CapacityInsight[] = [];
  // `at` defaults to the start of the hour the condition is observed in, so a queue doesn't show every item as
  // "opened seconds ago" on each tick; kinds that know their origin pass it.
  const push = (insight: Omit<CapacityInsight, 'source' | 'at'> & { at?: number }) => out.push({ source: 'capacity', at: hour, ...insight });

  for (const pool of pools) {
    const summary = snapshot.summary.pools.find((entry) => entry.poolId === pool.id);
    const row = summary?.capacity.find((entry) => entry.resource === 'gpu');
    if (!row) continue;
    const name = nameOf(pool.id);

    // Fully booked within 72 h: the first full bucket and how long it lasts.
    const timeline = source.timelineSync(pool.id, { from: hour, to: hour + 72 * HOUR });
    const fullAt = timeline.buckets.findIndex((bucket) => bucket.start > t && bucket.free <= 0);
    if (fullAt >= 0 && timeline.allocatable > 0) {
      let span = 0;
      while (timeline.buckets[fullAt + span] && timeline.buckets[fullAt + span]!.free <= 0) span += 1;
      const start = timeline.buckets[fullAt]!.start;
      push({
        id: `capacity.full.${pool.id}.${start}`,
        kind: 'pool-full-soon',
        severity: start - t < 12 * HOUR ? 'warning' : 'info',
        title: `${name} is fully booked in ${inHours(start - t)}`,
        detail: `No ${shortOf(pool.id)} GPU is free from ${clock(start)} UTC for ${span} h. New requests there will wait in pending.`,
        href: `/pools/${pool.id}?tab=schedule`,
        subject: `pool/${pool.id}`,
        action: { label: 'Find another pool', href: `/reservations/new?pool=${pool.id}` },
      });
    }

    // Fragmentation: enough free GPUs in total, but no node holds a whole node's worth.
    const nodes = snapshot.nodes.filter((node) => node.poolId === pool.id && node.health === 'ok');
    const perNode = nodes[0]?.gpus ?? 0;
    if (perNode >= 4) {
      const held = new Set<string>();
      for (const reservation of snapshot.reservations)
        if (reservation.poolId === pool.id && reservation.during && liveStates.has(reservation.state) && reservation.during.start <= t && reservation.during.end > t)
          for (const atom of reservation.atoms ?? []) held.add(atom);
      const freePerNode = nodes.map((node) => Array.from({ length: node.gpus }, (_, gpu) => gpu).filter((gpu) => !held.has(`${node.id}/gpu${gpu}`)).length);
      const free = freePerNode.reduce((sum, value) => sum + value, 0);
      const whole = freePerNode.filter((value) => value === perNode).length;
      if (free >= perNode * 2 && whole === 0)
        push({
          id: `capacity.fragmented.${pool.id}`,
          kind: 'fragmented',
          severity: 'warning',
          title: `${name} is fragmented`,
          detail: `${free} GPUs are free, but no node has all ${perNode} free: a ${perNode}-GPU request can't land now. Bin-packing will heal it as bookings end.`,
          href: `/pools/${pool.id}`,
          subject: `pool/${pool.id}`,
          action: { label: 'See the rack', href: `/pools/${pool.id}` },
        });
    }

    // Out of service: a large share of the pool can't take work.
    const out_ = row.total - row.allocatable;
    if (row.total > 0 && out_ / row.total >= 0.08)
      push({
        id: `capacity.oos.${pool.id}`,
        kind: 'out-of-service',
        severity: out_ / row.total >= 0.15 ? 'critical' : 'warning',
        title: `${Math.round((out_ / row.total) * 100)}% of ${name} is out of service`,
        detail: `${out_} of ${row.total} GPUs sit on nodes that are offline, degraded, provisioning or held.`,
        href: `/nodes?pool=${pool.id}`,
        subject: `pool/${pool.id}`,
        action: { label: 'Open the nodes', href: `/nodes?pool=${pool.id}` },
      });
  }

  // Pending work with no window in 7 days, per pool.
  const stuck = new Map<string, Reservation[]>();
  for (const reservation of snapshot.reservations)
    if (reservation.state === 'pending' && inScope.has(reservation.poolId)) stuck.set(reservation.poolId, [...(stuck.get(reservation.poolId) ?? []), reservation]);
  for (const [poolId, list] of stuck) {
    const timeline = source.timelineSync(poolId, { from: hour, to: hour + 7 * DAY });
    const never = list.filter((reservation) => {
      const need = reservationGpus(reservation);
      const length = durationMs(reservation.request.duration);
      let run = 0;
      for (const bucket of timeline.buckets) {
        run = bucket.free >= need ? run + HOUR : 0;
        if (run >= length) return false;
      }
      return true;
    });
    if (never.length)
      push({
        id: `capacity.unplaceable.${poolId}`,
        kind: 'unplaceable',
        severity: 'critical',
        title: `${never.length} reservation${never.length === 1 ? '' : 's'} can't be placed in ${nameOf(poolId)} this week`,
        detail: `${never.map((reservation) => `${reservation.id} (${reservationGpus(reservation)} GPU, ${reservation.request.duration})`).slice(0, 3).join(', ')}${never.length > 3 ? '…' : ''}: no window in the next 7 days. Move them, or free capacity.`,
        href: `/reservations?pool=${poolId}`,
        subject: `pool/${poolId}`,
        action: { label: 'Review pending', href: `/reservations` },
      });
  }

  // Quotas: at the ceiling, or large and unused for the whole usage window.
  const usedRecently = new Set(snapshot.usage.filter((window) => window.windowStart >= t - 7 * DAY).map((window) => `${window.tags.tenantId}|${window.tags.poolId}`));
  for (const quota of snapshot.quotas) {
    if (quota.resource !== 'gpu' || !inScope.has(quota.poolId) || !quota.tenantId || quota.tenantId === snapshot.tenantId) continue;
    const available = quota.available ?? Math.max(0, quota.max - quota.used);
    if (quota.max > 0 && available <= 0)
      push({
        id: `capacity.quota-full.${quota.tenantId}.${quota.poolId}`,
        kind: 'quota-full',
        severity: 'warning',
        title: `${tenantName(quota.tenantId)} is at its ${shortOf(quota.poolId)} quota`,
        detail: `${quota.used} of ${quota.max} GPUs in ${nameOf(quota.poolId)}; its next booking there fails with QUOTA_EXCEEDED.`,
        href: `/quotas?tenant=${quota.tenantId}`,
        subject: `tenant/${quota.tenantId}`,
        action: { label: 'Adjust quota', href: `/quotas?tenant=${quota.tenantId}` },
      });
    else if (quota.max >= 32 && quota.used === 0 && !usedRecently.has(`${quota.tenantId}|${quota.poolId}`))
      push({
        id: `capacity.quota-idle.${quota.tenantId}.${quota.poolId}`,
        kind: 'quota-idle',
        severity: 'info',
        title: `${tenantName(quota.tenantId)} hasn't used its ${quota.max}-GPU ${shortOf(quota.poolId)} quota in 7 days`,
        detail: `Nothing booked in ${nameOf(quota.poolId)} since last week. Lowering it would tighten the pool's over-commit.`,
        href: `/quotas?tenant=${quota.tenantId}`,
        subject: `tenant/${quota.tenantId}`,
      });
  }

  // Spot work under preemption notice, and leases about to lapse.
  const notices = snapshot.reservations.filter((reservation) => inScope.has(reservation.poolId) && reservation.conditions.some((condition) => condition.type === 'PreemptionNotice'));
  if (notices.length)
    push({
      id: 'capacity.preemption',
      kind: 'preemption',
      severity: 'info',
      title: `${notices.length} spot reservation${notices.length === 1 ? '' : 's'} under preemption notice`,
      detail: `${notices.reduce((sum, reservation) => sum + reservationGpus(reservation), 0)} GPUs go back to regular work when the notices run out.`,
      href: '/reservations',
      subject: 'reservations/spot',
    });
  const lapsing = snapshot.reservations.filter((reservation) => inScope.has(reservation.poolId) && reservation.leaseExpiresAt !== undefined && reservation.leaseExpiresAt - t < 10 * 60_000 && reservation.leaseExpiresAt > t);
  if (lapsing.length)
    push({
      id: 'capacity.leases',
      kind: 'lease-lapsing',
      severity: 'info',
      title: `${lapsing.length} lease${lapsing.length === 1 ? '' : 's'} lapse within 10 minutes unless renewed`,
      detail: lapsing.slice(0, 4).map((reservation) => reservation.id).join(', '),
      href: `/reservations?id=${lapsing[0]!.id}`,
      subject: 'reservations/leases',
    });

  // Billing refused usage windows: someone must look.
  const dead = snapshot.usage.filter((window) => window.outcome === 'dead-lettered' && inScope.has(window.tags.poolId ?? ''));
  if (dead.length)
    push({
      id: 'capacity.dead-letter',
      kind: 'billing-dead-letter',
      severity: 'critical',
      at: Math.min(...dead.map((window) => window.windowEnd)),
      title: `${dead.length} usage window${dead.length === 1 ? '' : 's'} dead-lettered by billing`,
      detail: `${[...new Set(dead.map((window) => tenantName(window.tags.tenantId ?? '')))].slice(0, 3).join(', ')}: spend is under-reported until they are re-driven.`,
      href: '/usage',
      subject: 'usage/dead-letter',
    });

  out.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.title.localeCompare(b.title));
  const byScope = insightCache.get(snapshot) ?? new Map<string, CapacityInsight[]>();
  byScope.set(key, out);
  insightCache.set(snapshot, byScope);
  return out;
}

// --- Live source ----------------------------------------------------------------------------------------

/** `$request(path, body)` against /api/compute, as console-kit's ComputeRequester does. */
export type ComputeRequest = <T>(path: string, body: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<T>;

export function createLiveCapacitySource(request: ComputeRequest, options: { tenantId: string; now?: () => number }): CapacitySource {
  const clock = options.now ?? (() => Date.now());
  const tenantId = options.tenantId;
  const idem = () => `admin-${clock().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  const createBody = (input: PlacementRequest) => ({
    tenantId: input.tenantId ?? tenantId,
    poolId: input.poolId,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    devices: [{ class: 'gpu', count: input.gpus }],
    ...(input.gang && input.gang > 1 ? { gang: { size: input.gang } } : {}),
    ...(input.start ? { start: input.start } : {}),
    duration: formatDuration(input.durationMs),
    ...(input.spot ? { spot: true } : {}),
    ...(input.binding ? { binding: input.binding } : {}),
  });
  /** Follows `cursor` up to `pages` pages. */
  const paged = async <T>(path: string, body: Record<string, unknown>, pages: number, opts?: { signal?: AbortSignal }) => {
    const items: T[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < pages; page += 1) {
      const result = await request<{ items: T[]; cursor?: string }>(path, { ...body, ...(cursor ? { cursor } : {}) }, opts);
      items.push(...result.items);
      cursor = result.cursor;
      if (!cursor) break;
    }
    return { items };
  };
  return {
    kind: 'live',
    async load(signal) {
      const now = clock();
      const opts = signal ? { signal } : undefined;
      const [pools, summary, reservations, quotas, usage] = await Promise.all([
        request<{ items: AdminPool[] }>('pools/list', { tenantId }, opts),
        request<CapacitySummary>('capacity/summary', { tenantId }, opts),
        paged<Reservation>('reservations/list', { tenantId, scope: 'all', limit: 200 }, 10, opts),
        request<{ items: QuotaRow[] }>('quotas/get', { tenantId }, opts),
        paged<UsageWindow>('usage/list', { tenantId, from: now - 30 * DAY, to: now, limit: 500 }, 20, opts).catch(() => ({ items: [] as UsageWindow[] })),
      ]);
      const flavorPools = pools.items.filter((pool) => pool.class === 'vps-host' || pool.class === 'provider');
      const flavors = (
        await Promise.all(
          flavorPools.map((pool) =>
            request<{ items: FlavorRecord[] }>('flavors/list', { tenantId, poolId: pool.id }, opts)
              .then((result) => result.items)
              .catch(() => [] as FlavorRecord[]),
          ),
        )
      ).flat();
      const siteIds = [...new Set(pools.items.map((pool) => pool.siteId))];
      return {
        now,
        tenantId,
        pools: pools.items,
        summary,
        reservations: reservations.items,
        quotas: quotas.items,
        usage: usage.items,
        flavors,
        offers: [],
        tenants: [{ id: tenantId, name: tenantId, projects: [] }],
        identities: [],
        sites: siteIds.map((id) => ({ id, name: id, region: '' })),
        prices: {},
        nodesByPool: {},
        nodes: [],
        source: 'live',
      };
    },
    async timeline(poolId, range, signal) {
      // The API answers at most 7 days and 336 buckets per call: chunk longer ranges.
      const stepMinutes = range.stepMinutes ?? 60;
      const chunk = Math.min(WEEK, 336 * stepMinutes * 60_000);
      const parts: CapacityTimeline[] = [];
      for (let from = range.from; from < range.to; from += chunk)
        parts.push(
          await request<CapacityTimeline>(
            'capacity/timeline',
            { tenantId, poolId, from, to: Math.min(range.to, from + chunk), stepMinutes },
            signal ? { signal } : undefined,
          ),
        );
      return { poolId, allocatable: parts[0]?.allocatable ?? 0, buckets: parts.flatMap((part) => part.buckets) };
    },
    preview(input) {
      return request<CapacityPreview>('capacity/preview', { ...createBody(input), idempotencyKey: idem() });
    },
    create(input) {
      return request<Reservation>('reservations/create', { ...createBody(input), idempotencyKey: idem() });
    },
    release(reservationId) {
      return request<Reservation>('reservations/release', { tenantId, reservationId });
    },
    cancel(reservationId) {
      return request<Reservation>('reservations/cancel', { tenantId, reservationId });
    },
    extend(reservationId, byMs) {
      return request<Reservation>('reservations/extend', { tenantId, reservationId, by: byMs, idempotencyKey: idem() });
    },
    setQuota(row) {
      return request<QuotaRow>('quotas/set', { tenantId: row.tenantId ?? tenantId, poolId: row.poolId, resource: row.resource, max: row.max });
    },
  };
}
