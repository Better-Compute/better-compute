// Kernel cpulist form (PLAN.md §3.8), as /sys and cgroup v2's cpuset files write it: "0-31,64-95".
// Used for NUMA-local cpusets in device assignments and instance placement.

/** The highest CPU id accepted (Linux's largest NR_CPUS is 8192). */
export const maxCpuId = 8191;
/** At most this many characters and comma-separated parts are read. */
const maxListLength = 32_768;
const maxParts = 4096;

/**
 * The CPU ids of a cpulist, sorted; malformed parts are skipped. Bounded: a cpulist comes from a
 * node's inventory (possibly a tenant's modified bcd), so ids above `maxCpuId`, lists longer than
 * 32 KiB and more than 4096 parts are refused rather than parsed (review 2: an oversized list
 * could stall the control plane).
 */
export function parseCpuList(list: string | undefined): number[] {
  const text = list ?? '';
  if (text.length > maxListLength) return [];
  const parts = text.split(',');
  if (parts.length > maxParts) return [];
  const cpus = new Set<number>();
  for (const part of parts) {
    const match = /^\s*(\d{1,5})(?:-(\d{1,5}))?\s*$/.exec(part);
    if (!match) continue;
    const first = Number(match[1]);
    const last = match[2] !== undefined ? Number(match[2]) : first;
    if (last < first || last > maxCpuId) continue;
    for (let cpu = first; cpu <= last; cpu++) cpus.add(cpu);
  }
  return [...cpus].sort((a, b) => a - b);
}

/** A cpulist from CPU ids, as ranges: [0,1,2,3,8] → "0-3,8". Empty for none. */
export function formatCpuList(cpus: Iterable<number>): string {
  const sorted = [...new Set(cpus)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let index = 0; index < sorted.length; ) {
    const first = sorted[index]!;
    let last = first;
    while (sorted[index + 1] === last + 1) last = sorted[++index]!;
    parts.push(first === last ? String(first) : `${first}-${last}`);
    index++;
  }
  return parts.join(',');
}
