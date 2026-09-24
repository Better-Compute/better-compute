import type { Device, DeviceAttributes } from '@better-compute/core';
import { GpuLinkType, MigMode, type Gpu, type GpusSection } from '@better-compute/protocol';
import { normalizeGpuProduct } from './gpu-models.js';

// Devices derived from inventory (PLAN.md §2, §10.1, §10.4). Device ids are stable: the GPU UUID,
// and `<uuid>/gi<g>/ci<c>` for MIG instances. The atom rule: a GPU in MIG mode exposes only its
// instances as atoms, and the parent itself is not bookable.

const gib = 1024n ** 3n;

/** Whole GiB, rounded down; 0 for a missing value. */
export function bytesToGiB(bytes: bigint | undefined): number {
  return bytes === undefined || bytes <= 0n ? 0 : Number(bytes / gib);
}

/** Whether a GPU is partitioned by MIG (current mode, not a pending change). */
export function isMigEnabled(gpu: Gpu): boolean {
  return gpu.mig?.current === MigMode.ENABLED;
}

/** The device id of a MIG instance. */
export function migDeviceId(gpuUuid: string, giId: number, ciId: number): string {
  return `${gpuUuid}/gi${giId}/ci${ciId}`;
}

/**
 * Why a GPU is unhealthy as far as inventory can tell, or undefined when it looks healthy. Only
 * hard failures count here; counters and XIDs belong to Health (v0.2):
 * - a failed row remap means the board needs an RMA;
 * - a GPU without a UUID cannot be addressed or booked.
 */
export function gpuInventoryFault(gpu: Gpu): string | undefined {
  if (!gpu.uuid) return 'NoUuid';
  if (gpu.rowRemap?.failure) return 'RowRemapFailed';
  return undefined;
}

/** The attributes selectors and scorers read (`gpuProduct`, `gpuModel`, `vramGiB`, …). */
export function gpuAttributes(gpu: Gpu, section?: Pick<GpusSection, 'driverVersion'>): DeviceAttributes {
  const { gpuProduct, gpuModel } = normalizeGpuProduct(gpu.name);
  const attributes: DeviceAttributes = {
    gpuProduct,
    gpuModel,
    vramGiB: bytesToGiB(gpu.vramBytes),
    index: gpu.index,
  };
  if (gpu.pciBusId) attributes.pciBusId = gpu.pciBusId;
  if (gpu.numaNode !== undefined) attributes.numaNode = gpu.numaNode;
  if (gpu.architecture) attributes.architecture = gpu.architecture;
  if (gpu.cudaComputeCapabilityMajor > 0)
    attributes.computeCapability = `${gpu.cudaComputeCapabilityMajor}.${gpu.cudaComputeCapabilityMinor}`;
  if (section?.driverVersion) attributes.driverVersion = section.driverVersion;
  if (gpu.mig) attributes.migCapable = gpu.mig.capable;
  const nvlinkPeers = gpu.topology.filter((peer) => peer.link === GpuLinkType.NV).length;
  if (nvlinkPeers > 0) attributes.nvlinkPeers = nvlinkPeers;
  if (gpu.fabric?.clusterUuid) {
    attributes.fabricCluster = gpu.fabric.clusterUuid;
    attributes.fabricClique = gpu.fabric.cliqueId;
  }
  return attributes;
}

/**
 * Every device a node's GPU section implies, parents before children, sorted by GPU index.
 * - A GPU without MIG is one `gpu` atom.
 * - A GPU in MIG mode is a non-bookable `gpu` parent plus one `gpu.mig` atom per instance.
 * - A GPU with an inventory fault is still listed, with `healthy: false`, so its bookings stay
 *   visible; a GPU without a UUID is skipped (it has no stable id).
 */
export function devicesFromGpus(nodeId: string, section: GpusSection | undefined): Device[] {
  if (!section) return [];
  const devices: Device[] = [];
  const seen = new Set<string>();
  const gpus = [...section.gpus].sort((a, b) => a.index - b.index);
  for (const gpu of gpus) {
    if (!gpu.uuid || seen.has(gpu.uuid)) continue;
    seen.add(gpu.uuid);
    const healthy = gpuInventoryFault(gpu) === undefined;
    const attributes = gpuAttributes(gpu, section);
    const mig = isMigEnabled(gpu);
    devices.push({ id: gpu.uuid, nodeId, class: 'gpu', bookable: !mig, healthy, attributes });
    if (!mig) continue;
    const instances = [...(gpu.mig?.instances ?? [])].sort(
      (a, b) => a.giId - b.giId || a.ciId - b.ciId,
    );
    for (const instance of instances) {
      const id = migDeviceId(gpu.uuid, instance.giId, instance.ciId);
      if (seen.has(id)) continue;
      seen.add(id);
      const child: DeviceAttributes = {
        gpuProduct: attributes.gpuProduct!,
        gpuModel: attributes.gpuModel!,
        migProfile: instance.profile,
        giId: instance.giId,
        ciId: instance.ciId,
      };
      if (instance.uuid) child.migUuid = instance.uuid;
      if (attributes.numaNode !== undefined) child.numaNode = attributes.numaNode;
      devices.push({ id, nodeId, parentId: gpu.uuid, class: 'gpu.mig', bookable: true, healthy, attributes: child });
    }
  }
  return devices;
}

/** A GPU-to-GPU link class, best first (NVML topology levels). */
export type GpuLink = 'NV' | 'PIX' | 'PXB' | 'PHB' | 'NODE' | 'SYS';
const linkNames: Partial<Record<GpuLinkType, GpuLink>> = {
  [GpuLinkType.NV]: 'NV',
  [GpuLinkType.PIX]: 'PIX',
  [GpuLinkType.PXB]: 'PXB',
  [GpuLinkType.PHB]: 'PHB',
  [GpuLinkType.NODE]: 'NODE',
  [GpuLinkType.SYS]: 'SYS',
};
const linkRank: Readonly<Record<GpuLink, number>> = { NV: 0, PIX: 1, PXB: 2, PHB: 3, NODE: 4, SYS: 5 };

/** One undirected link between two GPU atoms of a node; `a < b`. */
export interface GpuPair {
  a: string;
  b: string;
  link: GpuLink;
}

/**
 * The GPU topology of a node as undirected pairs of device ids (the ids `devicesFromGpus` gives
 * the GPUs), for placement (§10.3). Each pair appears once with `a < b`; when the two directions
 * disagree the better link wins. Links to GPUs outside the section and unspecified links are
 * dropped. Sorted by `(a, b)`.
 */
export function gpuLinks(section: GpusSection | undefined): GpuPair[] {
  if (!section) return [];
  const present = new Set(section.gpus.map((gpu) => gpu.uuid).filter(Boolean));
  const pairs = new Map<string, GpuPair>();
  for (const gpu of section.gpus) {
    if (!gpu.uuid) continue;
    for (const peer of gpu.topology) {
      const link = linkNames[peer.link];
      if (!link || !present.has(peer.peerUuid) || peer.peerUuid === gpu.uuid) continue;
      const [a, b] = gpu.uuid < peer.peerUuid ? [gpu.uuid, peer.peerUuid] : [peer.peerUuid, gpu.uuid];
      const key = `${a}\n${b}`;
      const known = pairs.get(key);
      if (!known || linkRank[link] < linkRank[known.link]) pairs.set(key, { a, b, link });
    }
  }
  return [...pairs.values()].sort((x, y) => (x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : x.b > y.b ? 1 : 0));
}

/** A stored device as the reconciler compares it. */
export type StoredDevice = Pick<Device, 'id' | 'parentId' | 'class' | 'bookable' | 'healthy' | 'attributes'>;

/** What to write so the stored devices match an inventory. */
export interface DevicePlan {
  /** New devices, and devices whose class, parent, bookability, health or attributes changed. */
  upsert: Device[];
  /** Vanished devices without live bookings: delete them (children before parents). */
  remove: string[];
  /** Vanished devices that still have live bookings: keep them, `healthy = false`, delete later. */
  quarantine: string[];
}

function sameAttributes(a: DeviceAttributes, b: DeviceAttributes): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => Object.hasOwn(b, key) && a[key] === b[key]);
}

function sameDevice(stored: StoredDevice, next: Device): boolean {
  return (
    stored.class === next.class &&
    (stored.parentId ?? undefined) === (next.parentId ?? undefined) &&
    stored.bookable === next.bookable &&
    stored.healthy === next.healthy &&
    sameAttributes(stored.attributes, next.attributes)
  );
}

/**
 * Plans the device writes for one node (§10.1): upsert what inventory reports, delete what vanished,
 * and keep a vanished device with live bookings as `healthy = false` until its bookings end.
 * `unhealthy` holds device ids that Health has quarantined (v0.2); inventory never marks them
 * healthy again.
 */
export function planDevices(
  stored: readonly StoredDevice[],
  derived: readonly Device[],
  options: { bookedDeviceIds?: ReadonlySet<string>; unhealthy?: ReadonlySet<string> } = {},
): DevicePlan {
  const booked = options.bookedDeviceIds ?? new Set<string>();
  const quarantined = options.unhealthy ?? new Set<string>();
  const current = new Map(stored.map((device) => [device.id, device]));
  const next = new Set(derived.map((device) => device.id));
  const upsert: Device[] = [];
  for (const device of derived) {
    const merged = quarantined.has(device.id) ? { ...device, healthy: false } : device;
    const before = current.get(device.id);
    if (!before || !sameDevice(before, merged)) upsert.push(merged);
  }
  const remove: string[] = [];
  const quarantine: string[] = [];
  // Children first, so a parent is never deleted while an instance still references it.
  const vanished = stored
    .filter((device) => !next.has(device.id))
    .sort((a, b) => Number(a.parentId === undefined) - Number(b.parentId === undefined));
  const keptParents = new Set<string>();
  for (const device of vanished) {
    if (booked.has(device.id)) {
      if (device.healthy) quarantine.push(device.id);
      if (device.parentId) keptParents.add(device.parentId);
    } else if (!keptParents.has(device.id)) remove.push(device.id);
    else if (device.healthy) quarantine.push(device.id);
  }
  return { upsert, remove, quarantine };
}
