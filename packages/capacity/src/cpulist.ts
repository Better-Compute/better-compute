// Kernel cpulist form (PLAN.md §3.8), as /sys and cgroup v2's cpuset files write it: "0-31,64-95".
// Used for NUMA-local cpusets in device assignments and instance placement.

/** The CPU ids of a cpulist, sorted; malformed parts are skipped, huge ranges refused. */
export function parseCpuList(list: string | undefined): number[] {
  const cpus = new Set<number>();
  for (const part of (list ?? '').split(',')) {
    const match = /^\s*(\d+)(?:-(\d+))?\s*$/.exec(part);
    if (!match) continue;
    const first = Number(match[1]);
    const last = match[2] !== undefined ? Number(match[2]) : first;
    if (last < first || last - first > 65_535) continue;
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
