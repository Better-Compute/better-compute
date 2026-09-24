import type { Json } from '@better-compute/core';
import { MigMode, type Disk, type Gpu } from '@better-compute/protocol';
import type { InventoryChange } from './module.js';
import type { InventorySections } from './sections.js';

// Inventory diffs (PLAN.md §10.1): `gpu.missing|added`, `disk.replaced`, `driver.changed` and
// `mig.layout.changed`, keyed by stable device ids (GPU UUID, disk WWN, MAC).

function gpuSummary(gpu: Gpu): Json {
  const summary: Record<string, Json> = { index: gpu.index, uuid: gpu.uuid, name: gpu.name };
  if (gpu.pciBusId) summary.pciBusId = gpu.pciBusId;
  return summary;
}

function diskSummary(disk: Disk): Json {
  const summary: Record<string, Json> = { name: disk.name, model: disk.model, serial: disk.serial };
  if (disk.wwn) summary.wwn = disk.wwn;
  return summary;
}

/** A disk's stable identity: its WWN, else its serial, else nothing. */
function diskIdentity(disk: Disk): string | undefined {
  return disk.wwn || disk.serial || undefined;
}

/** MIG state as compared: mode plus the sorted instance layout. */
function migLayout(gpu: Gpu): Json {
  const mig = gpu.mig;
  const mode = mig?.current === MigMode.ENABLED ? 'enabled' : mig?.current === MigMode.DISABLED ? 'disabled' : 'unknown';
  const instances = [...(mig?.instances ?? [])]
    .sort((a, b) => a.giId - b.giId || a.ciId - b.ciId)
    .map((i) => `${i.giId}/${i.ciId}:${i.profile}`);
  return { mode, instances };
}

/**
 * The changes from `before` to `after`, in a stable order: GPUs missing, GPUs added, MIG layout
 * changes, disks replaced, then driver changes. A section missing on either side yields no
 * changes for it (the node stopped or started reporting it; that is not a hardware change).
 */
export function diffInventory(before: InventorySections, after: InventorySections): InventoryChange[] {
  const changes: InventoryChange[] = [];

  if (before.gpus && after.gpus) {
    const was = new Map(before.gpus.gpus.filter((g) => g.uuid).map((g) => [g.uuid, g]));
    const now = new Map(after.gpus.gpus.filter((g) => g.uuid).map((g) => [g.uuid, g]));
    for (const [uuid, gpu] of [...was].sort(([a], [b]) => (a < b ? -1 : 1)))
      if (!now.has(uuid)) changes.push({ type: 'gpu.missing', deviceId: uuid, before: gpuSummary(gpu) });
    for (const [uuid, gpu] of [...now].sort(([a], [b]) => (a < b ? -1 : 1)))
      if (!was.has(uuid)) changes.push({ type: 'gpu.added', deviceId: uuid, after: gpuSummary(gpu) });
    for (const [uuid, gpu] of [...now].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const old = was.get(uuid);
      if (!old) continue;
      const a = migLayout(old);
      const b = migLayout(gpu);
      if (JSON.stringify(a) !== JSON.stringify(b))
        changes.push({ type: 'mig.layout.changed', deviceId: uuid, before: a, after: b });
    }
  }

  if (before.disks && after.disks) {
    // A disk is replaced when the same slot (kernel name) now holds a different identity.
    const was = new Map(before.disks.disks.map((d) => [d.name, d]));
    for (const disk of [...after.disks.disks].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const old = was.get(disk.name);
      if (!old) continue;
      const a = diskIdentity(old);
      const b = diskIdentity(disk);
      if (a !== undefined && b !== undefined && a !== b)
        changes.push({ type: 'disk.replaced', deviceId: b, before: diskSummary(old), after: diskSummary(disk) });
    }
  }

  if (before.gpus && after.gpus) {
    const a = { driverVersion: before.gpus.driverVersion, cudaDriverVersion: before.gpus.cudaDriverVersion };
    const b = { driverVersion: after.gpus.driverVersion, cudaDriverVersion: after.gpus.cudaDriverVersion };
    if (a.driverVersion !== b.driverVersion || a.cudaDriverVersion !== b.cudaDriverVersion)
      changes.push({ type: 'driver.changed', before: a, after: b });
  }
  return changes;
}
