import { ComputeError, type Flavor, type InstancePlacement, type SqlTx } from '@better-compute/core';
import { formatCpuList, parseCpuList, readNodeTopology } from '@better-compute/capacity';

// Where a guest lives on its host (PLAN.md §3.8): a flavor's `placement` becomes the instance's
// InstancePlacement once it has a host.
//   hugepages  guest memory is backed by hugepages of that size, booked from the host's
//              hugepages1Gi / hugepages2Mi rows instead of memoryGiB (never ballooned)
//   numaAffine vCPUs and memory on one NUMA node: its GPUs' node, else the least-loaded node that
//              holds the memory
//   pinned     each vCPU gets its own host CPU that no other pinned guest on the host has
//   balloon    (no flavor field) every guest of a pool that overcommits memory, except hugepage-
//              backed and GPU (VFIO) guests, whose memory is pinned
// A host that cannot honour numaAffine or pinned still runs the guest, floating, with a
// `PlacementDegraded` condition naming why: placement already booked the scalars. Two placements
// on one host serialize on its `vcpu` node_resources row (every hosted instance books vCPUs), so the
// second sees the first's pins.

export type FlavorPlacement = NonNullable<Flavor['placement']>;

const GiB = 2 ** 30;
const pageBytes = { '2Mi': 2 * 2 ** 20, '1Gi': GiB } as const;

/** Validates a flavor's `placement` input (absent or `{}`: none). */
export function parseFlavorPlacement(value: unknown): FlavorPlacement | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value))
    throw new ComputeError('INVALID_INPUT', 'placement must be an object');
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input))
    if (!['numaAffine', 'pinned', 'hugepages'].includes(key))
      throw new ComputeError('INVALID_INPUT', `placement: unknown field ${JSON.stringify(key)}`);
  const placement: FlavorPlacement = {};
  for (const key of ['numaAffine', 'pinned'] as const) {
    const flag = input[key];
    if (flag === undefined) continue;
    if (typeof flag !== 'boolean')
      throw new ComputeError('INVALID_INPUT', `placement.${key} must be a boolean`);
    if (flag) placement[key] = true;
  }
  if (input.hugepages !== undefined) {
    if (input.hugepages !== '2Mi' && input.hugepages !== '1Gi')
      throw new ComputeError('INVALID_INPUT', 'placement.hugepages must be 2Mi or 1Gi');
    placement.hugepages = input.hugepages;
  }
  return Object.keys(placement).length > 0 ? placement : undefined;
}

/** The scalar claim of a hosted instance: hugepage-backed memory books hugepages, not memoryGiB. */
export function placementResources(shape: {
  vcpu: number;
  memoryGiB: number;
  diskGiB: number;
  placement?: FlavorPlacement;
}): Record<string, number> {
  const resources: Record<string, number> = { vcpu: shape.vcpu, diskGiB: shape.diskGiB };
  if (shape.placement?.hugepages === '1Gi') resources.hugepages1Gi = shape.memoryGiB;
  else if (shape.placement?.hugepages === '2Mi') resources.hugepages2Mi = shape.memoryGiB * 512;
  else resources.memoryGiB = shape.memoryGiB;
  return resources;
}

/** What the host placement is stored as (`instances.host_placement`). */
export interface HostPlacement extends InstancePlacement {
  /** `cpus` are this guest's alone (one per vCPU). */
  pinned?: boolean;
}

export interface PlacementChoice {
  placement?: HostPlacement;
  /** Why numaAffine or pinned could not be honoured on this host. */
  degraded?: string;
}

/**
 * Chooses where on `nodeId` an instance's vCPUs and memory go (see the file comment). Reads the
 * host's inventory NUMA nodes, its GPUs' NUMA nodes and the other live guests' placements.
 */
export async function chooseHostPlacement(
  tx: Pick<SqlTx, 'query'>,
  instance: {
    id: string;
    nodeId: string;
    shape: { vcpu: number; memoryGiB: number; placement?: FlavorPlacement };
    deviceIds: readonly string[];
    /**
     * The pool overcommits memory (`policy.overcommit.memoryGiB` > 1): the guest gets a virtio
     * balloon so the host can reclaim its free memory. Never with hugepages or VFIO GPUs (pinned
     * guest memory cannot be ballooned).
     */
    balloon?: boolean;
  },
): Promise<PlacementChoice> {
  const wanted = instance.shape.placement;
  const balloon = instance.balloon === true && !wanted?.hugepages && instance.deviceIds.length === 0;
  if (!wanted) return balloon ? { placement: { balloon: true } } : {};
  const placement: HostPlacement = {};
  if (wanted.hugepages) placement.hugepageSizeBytes = pageBytes[wanted.hugepages];
  if (balloon) placement.balloon = true;
  if (!wanted.numaAffine && !wanted.pinned) return { placement };

  const topology = await readNodeTopology(tx, instance.nodeId, instance.deviceIds);
  if (topology.numa.size === 0) return { placement, degraded: 'NoNumaTopology' };
  const { rows } = await tx.query<{ placement: HostPlacement | string; vcpu: number | string }>(
    `SELECT host_placement AS placement, flavor->>'vcpu' AS vcpu FROM instances
      WHERE node_id = $1 AND id <> $2 AND NOT draft AND state NOT IN ('deleted', 'error')
        AND host_placement IS NOT NULL`,
    [instance.nodeId, instance.id],
  );
  const taken = new Set<number>();
  const load = new Map<number, number>();
  for (const row of rows) {
    const other = typeof row.placement === 'string' ? (JSON.parse(row.placement) as HostPlacement) : row.placement;
    if (other.pinned) for (const cpu of parseCpuList(other.cpus)) taken.add(cpu);
    for (const node of (other.mems ?? '').split(',').filter((entry) => /^\d+$/.test(entry)))
      load.set(Number(node), (load.get(Number(node)) ?? 0) + Number(row.vcpu));
  }
  const memoryBytes = instance.shape.memoryGiB * GiB;
  // The host's own CPUs (policy.hostReserve) are never a guest's.
  const usable = (nodes: readonly number[]) =>
    nodes.flatMap((node) => topology.numa.get(node)?.cpus ?? []).filter((cpu) => !topology.reserved?.has(cpu));
  const free = (nodes: readonly number[]) => usable(nodes).filter((cpu) => !taken.has(cpu));
  const all = [...topology.numa.keys()].sort((a, b) => a - b);

  let nodes: number[] = all;
  let degraded: string | undefined;
  if (wanted.numaAffine) {
    const gpuNodes = [...new Set(instance.deviceIds.map((id) => topology.deviceNuma.get(id)))];
    const fits = (node: number) =>
      (topology.numa.get(node)?.memoryBytes ?? 0) >= memoryBytes &&
      (!wanted.pinned || free([node]).length >= instance.shape.vcpu);
    if (instance.deviceIds.length > 0) {
      if (gpuNodes.some((node) => node === undefined)) degraded = 'GpuNumaUnknown';
      else nodes = (gpuNodes as number[]).sort((a, b) => a - b);
    } else {
      const choice = all
        .filter(fits)
        .sort((a, b) => (load.get(a) ?? 0) - (load.get(b) ?? 0) || a - b)[0];
      if (choice === undefined) degraded = 'NoNumaNodeFits';
      else nodes = [choice];
    }
    if (!degraded) {
      const localBytes = nodes.reduce((sum, node) => sum + (topology.numa.get(node)?.memoryBytes ?? 0), 0);
      if (localBytes >= memoryBytes) placement.mems = nodes.join(',');
      else degraded = 'NumaMemoryTooSmall';
      if (!wanted.pinned) placement.cpus = formatCpuList(usable(nodes));
    }
  }
  if (wanted.pinned) {
    // Kernel-isolated CPUs first (no host tasks, no timer ticks there), then the rest by id.
    const isolated = topology.isolated;
    const candidates = free(nodes).sort(
      (a, b) => Number(isolated?.has(b) ?? false) - Number(isolated?.has(a) ?? false) || a - b,
    );
    if (candidates.length >= instance.shape.vcpu) {
      placement.cpus = formatCpuList(candidates.slice(0, instance.shape.vcpu));
      placement.pinned = true;
    } else degraded ??= 'NotEnoughFreeCpus';
  }
  return degraded ? { placement, degraded } : { placement };
}

/** The InstancePlacement a node spec carries (the stored placement without the bookkeeping). */
export function specPlacement(stored: HostPlacement | undefined): InstancePlacement | undefined {
  if (!stored) return undefined;
  const placement: InstancePlacement = {};
  if (stored.cpus) placement.cpus = stored.cpus;
  if (stored.mems) placement.mems = stored.mems;
  if (stored.hugepageSizeBytes) placement.hugepageSizeBytes = stored.hugepageSizeBytes;
  if (stored.balloon && !stored.hugepageSizeBytes) placement.balloon = true;
  return Object.keys(placement).length > 0 ? placement : undefined;
}
