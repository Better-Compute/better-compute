import { isComputeError } from '@better-compute/core';
import { lastSegment } from './shapes.js';

// Boot disks and NICs by machine family. Compute Engine refuses a create whose boot disk type the
// machine type cannot use ("pd-balanced disk type cannot be used by a3-ultragpu-8g machine type"),
// and its API does not say which types a machine type takes: this table does. A family it gets
// wrong is caught by create, which retries once with Hyperdisk Balanced and logs it.

/** Families whose machine types only take Hyperdisk (no Persistent Disk). */
const hyperdiskOnly = [
  'a3-ultragpu',
  'a4',
  'a4x',
  'c4',
  'c4a',
  'c4d',
  'g4',
  'h4d',
  'm4',
  'n4',
  'n4a',
  'n4d',
  'x4',
];

/** Families whose machine types only take a gVNIC network interface (no VirtIO-Net). */
const gvnicOnly = [
  'a3',
  'a4',
  'a4x',
  'c3',
  'c3d',
  'c4',
  'c4a',
  'c4d',
  'g4',
  'h3',
  'h4d',
  'm4',
  'n4',
  'n4a',
  'n4d',
  'x4',
  'z3',
];

/**
 * Families that cannot live-migrate whatever their accelerators: host maintenance stops them
 * (`onHostMaintenance: TERMINATE`). TERMINATE is accepted by every machine type, so a family
 * listed here by mistake only loses live migration; one missing from it is refused at create.
 */
const noLiveMigration = ['h3', 'h4d', 'x4'];

/** The boot disk type when nothing else is known: works on every Persistent Disk family. */
export const defaultBootDiskType = 'pd-balanced';
/** The only Hyperdisk type a boot disk can be. */
export const hyperdiskBootType = 'hyperdisk-balanced';

/** Whether `machineType` (`a3-ultragpu-8g`) is in one of `families` (`a3-ultragpu`, `c4`, …). */
function inFamily(machineType: string, families: readonly string[]): boolean {
  const name = lastSegment(machineType);
  return families.some((family) => name === family || name.startsWith(`${family}-`));
}

/** Whether `machineType` is a bare metal type (`c3-standard-192-metal`, `x4-megamem-960-metal`). */
export function isMetal(machineType: string): boolean {
  return lastSegment(machineType).endsWith('-metal');
}

/** The boot disk types `machineType` takes, best first. Bare metal takes Hyperdisk only. */
export function bootDiskTypes(machineType: string): string[] {
  return inFamily(machineType, hyperdiskOnly) || isMetal(machineType)
    ? [hyperdiskBootType]
    : [defaultBootDiskType, hyperdiskBootType];
}

/** Whether `machineType` needs a gVNIC interface. */
export function needsGvnic(machineType: string): boolean {
  return inFamily(machineType, gvnicOnly);
}

/** The `nicType` a create must ask for: IDPF on bare metal, gVNIC on gVNIC-only families, else the default. */
export function nicTypeOf(machineType: string): 'IDPF' | 'GVNIC' | undefined {
  if (isMetal(machineType)) return 'IDPF';
  return needsGvnic(machineType) ? 'GVNIC' : undefined;
}

/** Whether `machineType` cannot live-migrate for its family or bare metal (accelerators are checked apart). */
export function cannotLiveMigrate(machineType: string): boolean {
  return isMetal(machineType) || inFamily(machineType, noLiveMigration);
}

/** Whether a GCE create error is the refusal of a boot disk type by the machine type. */
export function isDiskTypeRefusal(error: unknown): boolean {
  if (!isComputeError(error, 'INVALID_INPUT')) return false;
  return /disk type cannot be used by|does not support .*disk type|disk type .* is not supported/i.test(
    error.message,
  );
}

/** A zone's disk type as the diskTypes API returns it (only the members read here). */
export interface GceDiskType {
  name: string;
  /** e.g. `10GB-65536GB`. */
  validDiskSize?: string;
  deprecated?: { state?: string };
}

/** `10GB-65536GB` as GiB bounds; undefined when it does not parse. */
export function diskSizeRange(type: GceDiskType): { min: number; max: number } | undefined {
  const match = /^(\d+)GB-(\d+)GB$/.exec(type.validDiskSize ?? '');
  return match ? { min: Number(match[1]), max: Number(match[2]) } : undefined;
}
