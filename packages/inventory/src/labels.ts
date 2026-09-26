import type { Condition, Label } from '@better-compute/core';
import type { GpusSection } from '@better-compute/protocol';
import type { NodeConditionType } from './conditions.js';
import { bytesToGiB } from './devices.js';
import { normalizeGpuProduct } from './gpu-models.js';
import type { InventorySections } from './sections.js';

// Node labels, derived GFD-style (PLAN.md §10.6), and the v0.1 inventory conditions (§10.1).

/** The value a label takes when a node's GPUs disagree. */
export const mixedLabelValue = 'mixed';

/** Label keys inventory owns; operator and system labels never use them. */
export const inventoryLabelKeys = [
  'gpu.present',
  'gpu.count',
  'gpu.product',
  'gpu.model',
  'gpu.vramGiB',
  'cuda.driver.major',
  'nvidia.driver.version',
  'mig.capable',
  'fabric.domain',
  'cpu.arch',
  'cpu.vendor',
  'cpu.model',
  // (v1.1 §3.8) Host CPU and memory: selectors and `when:` expressions over them, e.g. `numa.nodes > 1`.
  'cpu.count',
  'cpu.sockets',
  'cpu.isolated',
  'numa.nodes',
  'memory.totalGiB',
  'hugepages.2Mi',
  'hugepages.1Gi',
  'os.distro',
  'os.kernel',
  'kvm.available',
] as const;
export type InventoryLabelKey = (typeof inventoryLabelKeys)[number];

function one<T>(values: readonly T[]): T | typeof mixedLabelValue | undefined {
  if (values.length === 0) return undefined;
  const first = values[0]!;
  return values.every((value) => value === first) ? first : mixedLabelValue;
}

/** The major version of a driver version string such as `550.90.07` or `12.4`. */
export function majorVersion(version: string): string | undefined {
  const match = /^(\d+)(?:\.|$)/.exec(version.trim());
  return match ? match[1] : undefined;
}

/**
 * The `cpu.model` label value of a CPU model string, as the host reports it: trademark marks
 * dropped, every run of other characters than `A-Z a-z 0-9 . _` turned into one `-`, trimmed, at
 * most 63 characters. `AMD EPYC 9654 96-Core Processor` → `AMD-EPYC-9654-96-Core-Processor`,
 * `Intel(R) Xeon(R) Platinum 8480+` → `Intel-Xeon-Platinum-8480`. Memory snapshots restore only on
 * a host whose value is equal (sandboxes normalize `InstanceSnapshotResult.cpu_model` the same way).
 */
export function cpuModelLabelValue(model: string): string {
  return model
    .replace(/\((?:r|tm)\)/gi, ' ')
    .replace(/[^A-Za-z0-9._]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 63)
    .replace(/[-.]+$/, '');
}

/** How many CPUs a kernel cpulist names (`0-3,8,10-11` → 7); 0 for an empty or malformed one. */
export function cpulistCount(list: string): number {
  let count = 0;
  for (const part of list.trim().split(',')) {
    if (!part) continue;
    const match = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!match) return 0;
    const from = Number(match[1]);
    const to = match[2] === undefined ? from : Number(match[2]);
    if (to < from) return 0;
    count += to - from + 1;
  }
  return count;
}

function gpuLabels(section: GpusSection | undefined, labels: Map<string, string>): void {
  const gpus = section?.gpus.filter((gpu) => gpu.uuid) ?? [];
  labels.set('gpu.present', String(gpus.length > 0));
  labels.set('gpu.count', String(gpus.length));
  if (gpus.length === 0) return;
  const names = gpus.map((gpu) => normalizeGpuProduct(gpu.name));
  labels.set('gpu.product', one(names.map((n) => n.gpuProduct))!);
  labels.set('gpu.model', one(names.map((n) => n.gpuModel))!);
  labels.set('gpu.vramGiB', String(one(gpus.map((gpu) => bytesToGiB(gpu.vramBytes)))));
  const cuda = majorVersion(section!.cudaDriverVersion);
  if (cuda) labels.set('cuda.driver.major', cuda);
  if (section!.driverVersion) labels.set('nvidia.driver.version', section!.driverVersion);
  labels.set('mig.capable', String(gpus.every((gpu) => gpu.mig?.capable === true)));
  const domains = gpus.map((gpu) =>
    gpu.fabric?.clusterUuid ? `${gpu.fabric.clusterUuid}.${gpu.fabric.cliqueId}` : '',
  );
  const domain = one(domains);
  if (domain) labels.set('fabric.domain', domain);
}

/**
 * The inventory-sourced labels of a node, sorted by key. A label whose GPUs disagree is `mixed`;
 * a label without data is absent. Values are strings, as node labels are.
 */
export function inventoryLabels(sections: InventorySections): Label[] {
  const labels = new Map<string, string>();
  if (sections.gpus !== undefined || sections.system !== undefined) gpuLabels(sections.gpus, labels);
  if (sections.cpu?.architecture) labels.set('cpu.arch', sections.cpu.architecture);
  if (sections.cpu?.vendor) labels.set('cpu.vendor', sections.cpu.vendor);
  const cpuModel = cpuModelLabelValue(sections.cpu?.model ?? '');
  if (cpuModel) labels.set('cpu.model', cpuModel);
  const cpu = sections.cpu;
  if (cpu) {
    if (cpu.threads > 0) labels.set('cpu.count', String(cpu.threads));
    if (cpu.sockets > 0) labels.set('cpu.sockets', String(cpu.sockets));
    labels.set('cpu.isolated', String(cpulistCount(cpu.isolatedCpus)));
    if (cpu.numaNodes.length > 0) labels.set('numa.nodes', String(cpu.numaNodes.length));
  }
  const memory = sections.memory;
  if (memory && memory.totalBytes > 0n) {
    labels.set('memory.totalGiB', String(bytesToGiB(memory.totalBytes)));
    // Configured pool sizes, in pages (0 when the size exists but holds none).
    for (const pool of memory.hugepages) {
      const key = pool.pageSizeBytes === 2n << 20n ? 'hugepages.2Mi' : pool.pageSizeBytes === 1n << 30n ? 'hugepages.1Gi' : undefined;
      if (key) labels.set(key, String(pool.total));
    }
  }
  if (sections.os?.distro) labels.set('os.distro', sections.os.distro);
  if (sections.os?.kernel) labels.set('os.kernel', sections.os.kernel);
  if (sections.os) labels.set('kvm.available', String(sections.os.kvm));
  return [...labels]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => ({ key, value, source: 'inventory' as const }));
}

/** What the node is expected to hold: a join token's `expect`, or the pool's hardware profile. */
export interface InventoryExpectation {
  gpuCount?: number;
  /** Expected `gpuModel` (the family), e.g. `H100`. */
  gpuModel?: string;
}

/** A condition inventory raises, with whether it keeps the node from scheduling. */
export interface InventoryCondition extends Omit<Condition, 'since'> {
  type: NodeConditionType;
  noSchedule: boolean;
}

/**
 * The v0.1 inventory conditions (§10.1), each reported `true` or `false` so a cleared condition
 * is written back as `false`:
 * - `GpuCountMismatch`: the node reports a different number of GPUs than expected, or a
 *   different model family. `NoSchedule`.
 * - `GpuModelUnknown`: a GPU name is missing from `gpuModels`. `NoSchedule`.
 */
export function inventoryConditions(
  sections: InventorySections,
  expect: InventoryExpectation = {},
): InventoryCondition[] {
  const gpus = sections.gpus?.gpus.filter((gpu) => gpu.uuid) ?? [];
  const names = gpus.map((gpu) => ({ name: gpu.name, ...normalizeGpuProduct(gpu.name) }));
  const conditions: InventoryCondition[] = [];

  let mismatch: string | undefined;
  if (sections.gpus === undefined)
    // A node that never reported a gpus section (a CPU-only host) is not a node with zero GPUs.
    conditions.push({ type: 'GpuCountMismatch', status: 'unknown', reason: 'NotReported', noSchedule: false });
  else if (expect.gpuCount !== undefined && gpus.length !== expect.gpuCount)
    mismatch = `expected ${expect.gpuCount} GPUs, found ${gpus.length}`;
  else if (expect.gpuModel !== undefined) {
    const wrong = names.filter((n) => n.gpuModel !== 'other' && n.gpuModel !== expect.gpuModel);
    if (wrong.length > 0)
      mismatch = `expected ${expect.gpuModel} GPUs, found ${[...new Set(wrong.map((n) => n.gpuModel))].join(', ')}`;
  }
  if (sections.gpus !== undefined)
    conditions.push(
      mismatch
        ? { type: 'GpuCountMismatch', status: 'true', reason: 'InventoryMismatch', message: mismatch, noSchedule: true }
        : { type: 'GpuCountMismatch', status: 'false', noSchedule: false },
    );

  const unknown = [...new Set(names.filter((n) => n.gpuModel === 'other').map((n) => n.name))];
  conditions.push(
    unknown.length > 0
      ? {
          type: 'GpuModelUnknown',
          status: 'true',
          reason: 'NotInGpuModels',
          message: `unknown GPU name${unknown.length > 1 ? 's' : ''}: ${unknown.map((n) => JSON.stringify(n)).join(', ')}`,
          noSchedule: true,
        }
      : { type: 'GpuModelUnknown', status: 'false', noSchedule: false },
  );
  return conditions;
}

/**
 * The `nodes.no_schedule_reasons` entry for a condition type: the type itself, as Liveness writes
 * `unreachable` and `nodes.taint` writes the taint key (such as `unhealthy.gpu/<uuid>`).
 */
export const conditionReason = (type: string): string => type;

/**
 * Rewrites the condition-derived entries of `no_schedule_reasons`: entries for `owned` condition
 * types are replaced by those of `conditions` that are `true` and `noSchedule`; every other entry
 * (taints, conditions other controllers own) is kept. The result is sorted and duplicate-free.
 */
export function mergeNoScheduleReasons(
  current: readonly string[],
  owned: readonly string[],
  conditions: readonly Pick<InventoryCondition, 'type' | 'status' | 'noSchedule'>[],
): string[] {
  const replaced = new Set(owned.map(conditionReason));
  const kept = current.filter((reason) => !replaced.has(reason));
  const added = conditions
    .filter((condition) => condition.status === 'true' && condition.noSchedule)
    .map((condition) => conditionReason(condition.type));
  return [...new Set([...kept, ...added])].sort();
}
