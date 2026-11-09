import { ComputeError, isComputeError } from '@better-compute/core';
import type { GceClient, GceOperation } from './client.js';
import { labels, labelValue } from './ids.js';
import type { GceDisk, GceInstance } from './shapes.js';

// (U-04) The tenant's labels on a VM and on its boot disk. better-compute's own labels (`better-compute-*`)
// belong to the platform: a tenant's labels never set, change or remove them, and neither do keys starting
// with `bc-` (the prefix of better-compute's network tags and resource names). On create the ownership labels
// are merged last, so they win over anything a tenant asked for; on a change they are carried over exactly as
// the machine (or disk) holds them.

/** Label key prefixes better-compute keeps for itself. */
export const reservedLabelPrefixes: readonly string[] = ['better-compute-', 'bc-'];

/** Whether a label key is better-compute's own (never a tenant's to write). */
export function isReservedLabelKey(key: string): boolean {
  return reservedLabelPrefixes.some((prefix) => key.startsWith(prefix));
}

/**
 * A tenant's labels as Compute Engine label keys and values, with every reserved key dropped, also one that
 * only becomes reserved once lower-cased (`Better-Compute-Managed`), and keys GCE refuses (not starting with a
 * letter) dropped.
 */
export function tenantLabels(
  requested: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(requested ?? {})) {
    const key = labelValue(rawKey);
    if (!/^[a-z]/.test(key) || isReservedLabelKey(key)) continue;
    out[key] = labelValue(String(rawValue));
  }
  return out;
}

/**
 * The labels of a VM better-compute creates, and of its boot disk: the tenant's first, then the ownership
 * labels (`better-compute-managed`, `better-compute-instance`), which always win.
 */
export function machineLabels(
  requested: Readonly<Record<string, string>> | undefined,
  instanceId: string,
): Record<string, string> {
  return {
    ...tenantLabels(requested),
    [labels.managed]: 'true',
    [labels.instance]: labelValue(instanceId),
  };
}

/**
 * `current` after a tenant label change: `labels` set, the keys of `previous` that `labels` lacks removed,
 * every other label kept, and the reserved ones restored exactly as `current` held them. Undefined when
 * nothing would change.
 */
export function changedLabels(
  current: Readonly<Record<string, string>>,
  change: {
    labels: Readonly<Record<string, string>>;
    previous?: Readonly<Record<string, string>> | undefined;
  },
): Record<string, string> | undefined {
  const wanted = tenantLabels(change.labels);
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(current))
    if (!isReservedLabelKey(key)) next[key] = value;
  for (const key of Object.keys(tenantLabels(change.previous)))
    if (!Object.hasOwn(wanted, key)) delete next[key];
  Object.assign(next, wanted);
  // The ownership labels go back last, as the resource holds them: never set, changed or removed here.
  for (const [key, value] of Object.entries(current))
    if (isReservedLabelKey(key)) next[key] = value;
  const keys = new Set([...Object.keys(current), ...Object.keys(next)]);
  return [...keys].every((key) => current[key] === next[key]) ? undefined : next;
}

/** A persistent disk with its labels, as `disks.get` returns it. */
interface LabelledDisk extends GceDisk {
  labels?: Record<string, string>;
  labelFingerprint?: string;
}

export interface BootDiskLabelDeps {
  client: GceClient;
  /** The account's project: a disk of another project is never labelled. */
  projectId: string;
  /** Waits for a setLabels operation to finish. */
  waitDone(operation: GceOperation, signal: AbortSignal, what: string): Promise<void>;
}

/**
 * The project-relative path of a disk resource URL (`/zones/z/disks/d` or `/regions/r/disks/d`); undefined
 * for a disk of another project or anything else.
 */
export function diskPath(source: string | undefined, projectId: string): string | undefined {
  if (!source) return undefined;
  const path = /(?:\/projects\/([^/]+))?\/(zones|regions)\/([^/]+)\/disks\/([^/?#]+)$/.exec(source);
  if (!path || (path[1] !== undefined && path[1] !== projectId)) return undefined;
  return `/${path[2]}/${path[3]}/disks/${path[4]}`;
}

/**
 * Applies a tenant label change to the VM's boot disk (`disks.setLabels` under its labelFingerprint; a stale one
 * is retried once with a fresh read, a second is CONFLICT). A VM without a readable boot disk of the account's
 * project, or whose boot disk is gone, has nothing to label.
 */
export async function labelBootDisk(
  deps: BootDiskLabelDeps,
  instance: GceInstance,
  change: {
    labels: Readonly<Record<string, string>>;
    previous?: Readonly<Record<string, string>> | undefined;
  },
  signal: AbortSignal,
): Promise<void> {
  const boot = (instance.disks ?? []).find((disk) => disk.boot === true && disk.type !== 'SCRATCH');
  const path = diskPath(boot?.source, deps.projectId);
  if (!path) return;
  for (let attempt = 0; ; attempt++) {
    let disk: LabelledDisk;
    try {
      disk = await deps.client.request<LabelledDisk>('GET', path, { signal });
    } catch (error) {
      if (isComputeError(error, 'NOT_FOUND')) return;
      throw error;
    }
    const next = changedLabels(disk.labels ?? {}, change);
    if (!next) return;
    try {
      const operation = await deps.client.request<GceOperation>('POST', `${path}/setLabels`, {
        body: { labels: next, labelFingerprint: disk.labelFingerprint },
        signal,
      });
      await deps.waitDone(operation, signal, `Labelling disk ${path}`);
      return;
    } catch (error) {
      if (isComputeError(error, 'NOT_FOUND')) return;
      if (!isComputeError(error) || error.details?.status !== 412) throw error;
      if (attempt === 0) continue;
      throw new ComputeError('CONFLICT', `The labels of disk ${path} keep changing`, undefined, {
        provider: 'gcp',
        status: 412,
        reason: 'conditionNotMet',
      });
    }
  }
}
