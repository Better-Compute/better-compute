// The simulated fleet's shape, shared by every module so ids and counts agree across pages: the capacity views
// book GPUs in the same pools the fleet views list nodes for. Mirrors the API's objects (sites.list, pools.list):
// ids are the API's; the extra display fields (city, coordinates, price) are the admin's own.

export type SiteProvider = 'metal' | 'hetzner' | 'proxmox' | 'kubernetes';

export interface Site {
  id: string;
  name: string;
  city: string;
  region: 'eu' | 'us';
  provider: SiteProvider;
  /** For the site map: longitude, latitude. */
  lon: number;
  lat: number;
}

export type PoolKind = 'gpu' | 'cpu' | 'sandbox';

export interface Pool {
  id: string;
  name: string;
  siteId: string;
  kind: PoolKind;
  /** The GPU model label (`bc.dev/gpu.model`), or the CPU model for CPU and sandbox pools. */
  model: string;
  /** Short model name for dense views: "H100", "EPYC 9654". */
  short: string;
  nodes: number;
  gpusPerNode: number;
  vcpusPerNode: number;
  memoryGiBPerNode: number;
  gpuMemoryGiB?: number;
  /** Placement: inline (default) or the pool-lease placer. */
  placer: 'inline' | 'pool-lease';
  /** Owned by the operator's root tenant, or offered to tenants. */
  offered: boolean;
  /** List price per GPU hour (GPU pools) or per vCPU hour (CPU/sandbox pools), USD. */
  price: number;
}

export const sites: Site[] = [
  { id: 'fra1', name: 'Frankfurt 1', city: 'Frankfurt', region: 'eu', provider: 'metal', lon: 8.68, lat: 50.11 },
  { id: 'ams2', name: 'Amsterdam 2', city: 'Amsterdam', region: 'eu', provider: 'metal', lon: 4.9, lat: 52.37 },
  { id: 'hel1', name: 'Helsinki 1', city: 'Helsinki', region: 'eu', provider: 'hetzner', lon: 24.94, lat: 60.17 },
  { id: 'iad1', name: 'Ashburn 1', city: 'Ashburn', region: 'us', provider: 'metal', lon: -77.49, lat: 39.04 },
  { id: 'sjc1', name: 'San Jose 1', city: 'San Jose', region: 'us', provider: 'kubernetes', lon: -121.89, lat: 37.34 },
];

export const pools: Pool[] = [
  {
    id: 'pool_h100_fra1', name: 'H100 training', siteId: 'fra1', kind: 'gpu', model: 'NVIDIA H100 80GB HBM3',
    short: 'H100', nodes: 64, gpusPerNode: 8, vcpusPerNode: 224, memoryGiBPerNode: 2048, gpuMemoryGiB: 80,
    placer: 'pool-lease', offered: true, price: 2.49,
  },
  {
    id: 'pool_h200_iad1', name: 'H200 inference', siteId: 'iad1', kind: 'gpu', model: 'NVIDIA H200 141GB HBM3e',
    short: 'H200', nodes: 32, gpusPerNode: 8, vcpusPerNode: 224, memoryGiBPerNode: 2048, gpuMemoryGiB: 141,
    placer: 'pool-lease', offered: true, price: 3.29,
  },
  {
    id: 'pool_b200_sjc1', name: 'B200 frontier', siteId: 'sjc1', kind: 'gpu', model: 'NVIDIA B200 180GB HBM3e',
    short: 'B200', nodes: 24, gpusPerNode: 8, vcpusPerNode: 288, memoryGiBPerNode: 3072, gpuMemoryGiB: 180,
    placer: 'pool-lease', offered: false, price: 4.99,
  },
  {
    id: 'pool_a100_ams2', name: 'A100 general', siteId: 'ams2', kind: 'gpu', model: 'NVIDIA A100-SXM4-80GB',
    short: 'A100', nodes: 48, gpusPerNode: 8, vcpusPerNode: 128, memoryGiBPerNode: 1024, gpuMemoryGiB: 80,
    placer: 'inline', offered: true, price: 1.39,
  },
  {
    id: 'pool_l40s_fra1', name: 'L40S render', siteId: 'fra1', kind: 'gpu', model: 'NVIDIA L40S 48GB',
    short: 'L40S', nodes: 40, gpusPerNode: 4, vcpusPerNode: 96, memoryGiBPerNode: 512, gpuMemoryGiB: 48,
    placer: 'inline', offered: true, price: 0.89,
  },
  {
    id: 'pool_mig_iad1', name: 'H100 MIG slices', siteId: 'iad1', kind: 'gpu', model: 'NVIDIA H100 80GB MIG 1g.10gb',
    short: 'H100 MIG', nodes: 16, gpusPerNode: 8, vcpusPerNode: 224, memoryGiBPerNode: 2048, gpuMemoryGiB: 10,
    placer: 'inline', offered: true, price: 0.42,
  },
  {
    id: 'pool_cpu_hel1', name: 'EPYC compute', siteId: 'hel1', kind: 'cpu', model: 'AMD EPYC 9654 96-Core',
    short: 'EPYC 9654', nodes: 120, gpusPerNode: 0, vcpusPerNode: 192, memoryGiBPerNode: 768,
    placer: 'inline', offered: true, price: 0.012,
  },
  {
    id: 'pool_sbx_ams2', name: 'Sandboxes', siteId: 'ams2', kind: 'sandbox', model: 'AMD EPYC 9474F 48-Core',
    short: 'microVM', nodes: 60, gpusPerNode: 0, vcpusPerNode: 96, memoryGiBPerNode: 768,
    placer: 'inline', offered: true, price: 0.018,
  },
  {
    id: 'pool_sbx_iad1', name: 'Sandboxes US', siteId: 'iad1', kind: 'sandbox', model: 'AMD EPYC 9474F 48-Core',
    short: 'microVM', nodes: 36, gpusPerNode: 0, vcpusPerNode: 96, memoryGiBPerNode: 768,
    placer: 'inline', offered: true, price: 0.018,
  },
];

export const siteById = (id: string) => sites.find((site) => site.id === id);
export const poolById = (id: string) => pools.find((pool) => pool.id === id);
export const poolsInSite = (siteId: string) => pools.filter((pool) => pool.siteId === siteId);

/** Stable node ids: `n-fra1-h100-017`. Rack = index / 8, unit = 42 − (index % 8) × 4 (4U servers). */
export function poolNodeId(pool: Pool, index: number): string {
  const tag = pool.id.split('_')[1];
  return `n-${pool.siteId}-${tag}-${String(index + 1).padStart(3, '0')}`;
}

export function poolNodePlacement(pool: Pool, index: number): { rack: string; unit: number } {
  const rack = Math.floor(index / 8);
  return {
    rack: `${pool.siteId.toUpperCase()}-R${String(rack + 1).padStart(2, '0')}`,
    unit: 42 - (index % 8) * 5,
  };
}

/** Fleet-wide totals of the topology (what exists, before health or bookings). */
export function topologyTotals(scope?: { siteId?: string }) {
  const inScope = pools.filter((pool) => !scope?.siteId || pool.siteId === scope.siteId);
  return {
    sites: scope?.siteId ? 1 : sites.length,
    pools: inScope.length,
    nodes: inScope.reduce((sum, pool) => sum + pool.nodes, 0),
    gpus: inScope.reduce((sum, pool) => sum + pool.nodes * pool.gpusPerNode, 0),
    vcpus: inScope.reduce((sum, pool) => sum + pool.nodes * pool.vcpusPerNode, 0),
    memoryGiB: inScope.reduce((sum, pool) => sum + pool.nodes * pool.memoryGiBPerNode, 0),
  };
}

/** Tenants (organizations) that book capacity in the simulation. */
export const tenants = [
  { id: 'ten_root', name: 'Operator (root)', slug: 'root' },
  { id: 'ten_aurora', name: 'Aurora Labs', slug: 'aurora' },
  { id: 'ten_kestrel', name: 'Kestrel AI', slug: 'kestrel' },
  { id: 'ten_meridian', name: 'Meridian Bio', slug: 'meridian' },
  { id: 'ten_northwind', name: 'Northwind Render', slug: 'northwind' },
  { id: 'ten_polaris', name: 'Polaris Robotics', slug: 'polaris' },
  { id: 'ten_quanta', name: 'Quanta Research', slug: 'quanta' },
  { id: 'ten_sable', name: 'Sable Security', slug: 'sable' },
] as const;

export type TenantId = (typeof tenants)[number]['id'];
export const tenantById = (id: string) => tenants.find((tenant) => tenant.id === id);
