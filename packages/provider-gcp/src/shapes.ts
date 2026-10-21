import type { ExternalMachine } from '@better-compute/core';
import { bootDiskTypes } from './disks.js';
import { labels, machineId, offerId } from './ids.js';

// Compute Engine resources as the REST API returns them (only the members this provider reads), and
// their mapping onto the provider contract.

export interface GceAccelerator {
  acceleratorType?: string;
  acceleratorCount?: number;
}

/** One entry of an instance's `disks[]` (only the members read here). */
export interface GceAttachedDisk {
  boot?: boolean;
  /** `PERSISTENT` or `SCRATCH` (a local SSD). */
  type?: string;
  /** The persistent disk's resource URL; its type is one `disks.get` away. */
  source?: string;
  diskSizeGb?: string | number;
}

/** A persistent disk as `disks.get` returns it (only the members read here). */
export interface GceDisk {
  /** `https://…/zones/<zone>/diskTypes/<type>`. */
  type?: string;
  sizeGb?: string;
}

export interface GceInstance {
  id?: string;
  name: string;
  /** `https://…/zones/<zone>`. */
  zone: string;
  /** `https://…/zones/<zone>/machineTypes/<type>`. */
  machineType: string;
  status?: string;
  creationTimestamp?: string;
  labels?: Record<string, string>;
  labelFingerprint?: string;
  tags?: { items?: string[]; fingerprint?: string };
  guestAccelerators?: GceAccelerator[];
  disks?: GceAttachedDisk[];
  networkInterfaces?: {
    network?: string;
    subnetwork?: string;
    networkIP?: string;
    accessConfigs?: { natIP?: string }[];
  }[];
  reservationAffinity?: { consumeReservationType?: string; key?: string; values?: string[] };
  resourceStatus?: { reservationConsumptionInfo?: { consumedReservation?: string } };
}

export interface GceMachineType {
  name: string;
  zone: string;
  guestCpus: number;
  memoryMb: number;
  accelerators?: { guestAcceleratorType: string; guestAcceleratorCount: number }[];
  deprecated?: { state?: string };
}

export interface MachineShape {
  vcpu: number;
  memoryGiB?: number;
}

/** The last path segment of a resource URL or relative path. */
export function lastSegment(resource: string): string {
  return resource.split('/').pop() ?? resource;
}

/** `us-central1-a` is in `us-central1`. */
export function regionOf(zone: string): string {
  return zone.replace(/-[a-z]$/, '');
}

/** An accelerator type (`nvidia-h100-80gb`) as the pool `gpuModel` string (`H100`). */
export function gpuModel(acceleratorType: string): string {
  const type = lastSegment(acceleratorType);
  if (type === 'nvidia-h100-80gb' || type === 'nvidia-h100-mega-80gb') return 'H100';
  if (type === 'nvidia-h200-141gb') return 'H200';
  if (type === 'nvidia-b200') return 'B200';
  if (type === 'nvidia-gb200') return 'GB200';
  if (type === 'nvidia-a100-80gb' || type === 'nvidia-tesla-a100') return 'A100';
  if (type === 'nvidia-l4') return 'L4';
  if (type === 'nvidia-l40s') return 'L40S';
  if (type === 'nvidia-rtx-pro-6000') return 'RTX-PRO-6000';
  return 'other';
}

const states: Record<string, ExternalMachine['state']> = {
  PROVISIONING: 'pending',
  STAGING: 'pending',
  RUNNING: 'running',
  STOPPING: 'stopped',
  SUSPENDING: 'stopped',
  SUSPENDED: 'stopped',
  TERMINATED: 'stopped',
  STOPPED: 'stopped',
  REPAIRING: 'error',
};

/** GCE `status` as the contract's machine state. */
export function machineState(status: string | undefined): ExternalMachine['state'] {
  return (status !== undefined ? states[status] : undefined) ?? 'unknown';
}

// Shapes of the machine types a machine's vCPU and memory cannot be derived from. The provider
// reads the real shape from the machineTypes API; this table and the name parsing are the fallback
// when it cannot (a type outside the configured zones, a custom type, a denied read).
const knownShapes: Record<string, MachineShape> = {
  'a2-highgpu-1g': { vcpu: 12, memoryGiB: 85 },
  'a2-highgpu-8g': { vcpu: 96, memoryGiB: 680 },
  'a3-highgpu-8g': { vcpu: 208, memoryGiB: 1872 },
  'a3-megagpu-8g': { vcpu: 208, memoryGiB: 1872 },
};

/** The shape a machine type's name pins down, if it does. */
export function shapeFromName(machineType: string): MachineShape | undefined {
  const name = lastSegment(machineType);
  const known = knownShapes[name];
  if (known) return known;
  const custom = /-custom-(\d+)-(\d+)(?:-ext)?$/.exec(name);
  if (custom) return { vcpu: Number(custom[1]), memoryGiB: Number(custom[2]) / 1024 };
  const g2 = /^g2-standard-(\d+)$/.exec(name);
  if (g2) return { vcpu: Number(g2[1]), memoryGiB: Number(g2[1]) * 4 };
  const sized = /^[a-z0-9]+-(?:standard|highmem|highcpu|ultramem|megamem|hypermem)-(\d+)$/.exec(
    name,
  );
  if (sized) return { vcpu: Number(sized[1]) };
  return undefined;
}

/** A machine type resource as its shape. */
export function shapeOf(type: GceMachineType): MachineShape {
  return { vcpu: type.guestCpus, memoryGiB: type.memoryMb / 1024 };
}

/** The GPUs a machine type carries. */
export function gpusOfType(type: GceMachineType): { model: string; count: number } | undefined {
  const accelerator = type.accelerators?.[0];
  if (!accelerator) return undefined;
  return {
    model: gpuModel(accelerator.guestAcceleratorType),
    count: type.accelerators!.reduce((sum, entry) => sum + entry.guestAcceleratorCount, 0),
  };
}

/**
 * A reservation reference as an `ExternalReservation.id`: `<zone>/<name>` for the account's own
 * project, `projects/<owner>/zones/<zone>/reservations/<name>` for one shared in.
 */
export function reservationId(reference: string, projectId?: string): string {
  const path = reference.replace(/^https:\/\/[^/]+\/compute\/[^/]+\//, '');
  const match = /^projects\/([^/]+)\/zones\/([^/]+)\/reservations\/([^/]+)$/.exec(path);
  if (!match) return path;
  const [, owner, zone, name] = match;
  return owner === projectId
    ? `${zone}/${name}`
    : `projects/${owner}/zones/${zone}/reservations/${name}`;
}

export interface ToMachineOptions {
  /** The account's project, to tell its own reservations from shared ones. */
  projectId?: string;
  /** Overrides the shape derived from the machine type's name. */
  shape?: MachineShape;
  /** The instance's disks with their types resolved (platform compute billing). */
  disks?: ExternalMachine['disks'];
  /** The boot disk's type when known; else the machine family's table (Hyperdisk only for some). */
  bootDiskType?: string;
}

/** A Compute Engine instance as the contract's ExternalMachine. */
export function toMachine(instance: GceInstance, options: ToMachineOptions = {}): ExternalMachine {
  const zone = lastSegment(instance.zone);
  const type = lastSegment(instance.machineType);
  const nics = instance.networkInterfaces ?? [];
  const addresses = nics
    .flatMap((nic) => [nic.networkIP, nic.accessConfigs?.[0]?.natIP])
    .filter((address): address is string => typeof address === 'string' && address !== '');
  const machine: ExternalMachine = {
    id: machineId(zone, instance.name),
    name: instance.name,
    state: machineState(instance.status),
    offerId: offerId(zone, type),
    region: regionOf(zone),
    addresses,
    zone,
    machineType: type,
    // The boot disk's own type when it was resolved; else the type this family takes (Hyperdisk only for some).
    bootDiskType: options.bootDiskType ?? bootDiskTypes(type)[0]!,
  };
  if (options.disks && options.disks.length > 0) machine.disks = options.disks;
  const shape = options.shape ?? shapeFromName(type);
  if (shape) {
    machine.vcpu = shape.vcpu;
    if (shape.memoryGiB !== undefined) machine.memoryGiB = shape.memoryGiB;
  }
  const accelerators = (instance.guestAccelerators ?? []).filter(
    (entry) => entry.acceleratorType && (entry.acceleratorCount ?? 0) > 0,
  );
  if (accelerators.length)
    machine.gpus = {
      model: gpuModel(accelerators[0]!.acceleratorType!),
      count: accelerators.reduce((sum, entry) => sum + (entry.acceleratorCount ?? 0), 0),
    };
  if (instance.labels) {
    machine.labels = { ...instance.labels };
    const claimedBy = instance.labels[labels.instance];
    if (claimedBy) machine.claimedBy = claimedBy;
  }
  const tags = instance.tags?.items ?? [];
  if (nics.length)
    machine.networks = nics.map((nic, index) => {
      const entry: NonNullable<ExternalMachine['networks']>[number] = {
        network: nic.network ? lastSegment(nic.network) : 'default',
      };
      if (nic.subnetwork) entry.subnet = lastSegment(nic.subnetwork);
      if (nic.networkIP) entry.address = nic.networkIP;
      const publicAddress = nic.accessConfigs?.[0]?.natIP;
      if (publicAddress) entry.publicAddress = publicAddress;
      // Network tags belong to the instance; they are reported on its first interface.
      if (index === 0 && tags.length) entry.tags = [...tags];
      return entry;
    });
  const consumed = instance.resourceStatus?.reservationConsumptionInfo?.consumedReservation;
  if (consumed) machine.reservation = reservationId(consumed, options.projectId);
  const createdAt = instance.creationTimestamp ? Date.parse(instance.creationTimestamp) : NaN;
  if (Number.isFinite(createdAt)) machine.createdAt = createdAt;
  return machine;
}
