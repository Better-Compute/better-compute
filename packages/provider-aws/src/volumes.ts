import {
  ComputeError,
  isComputeError,
  type CallContext,
  type ErrorCode,
  type ProviderContext,
  type ProviderDetachOptions,
  type ProviderResourceState,
  type ProviderVolumes,
  type ProviderVolumeSpec,
} from '@better-compute/core';
import type { QueryParams, XmlElement } from '@better-compute/aws-core';
import type { AwsConfig } from './config.js';
import { clientToken, tags, tagValue } from './ids.js';

// AWS A5: EBS volumes and snapshots behind the generic ProviderVolumes contract (program plan
// §6 A5). Every call is idempotent and non-blocking: it reads EBS, starts at most one operation and
// reports where it stands; the vps reconciler calls again. Ownership is the tag pair
// better-compute:managed=true + better-compute:volume=<name> (snapshots: …:snapshot=<name>), and
// every mutation refuses a volume or snapshot without it (AD6).

/** The EBS volume types, gp3 first (the default). */
export const ebsVolumeTypes = ['gp3', 'gp2', 'io2', 'io1', 'st1', 'sc1', 'standard'] as const;
export type EbsVolumeType = (typeof ebsVolumeTypes)[number];

/** The smallest volume of each type, in GiB. */
const minSizeGiB: Record<EbsVolumeType, number> = {
  gp3: 1,
  gp2: 1,
  io2: 4,
  io1: 4,
  st1: 125,
  sc1: 125,
  standard: 1,
};
const iopsTypes: ReadonlySet<string> = new Set(['gp3', 'io1', 'io2']);
const throughputTypes: ReadonlySet<string> = new Set(['gp3']);

/** EBS allows 50 tags per resource; ours take 3, the rest is for tenant labels. */
const maxLabels = 40;
/** After a modification starts, EBS refuses the next one on that volume for six hours. */
export const ebsModificationCooldownMs = 6 * 3_600_000;

const volumePattern = /^vol-[0-9a-f]{8,17}$/;
const snapshotPattern = /^snap-[0-9a-f]{8,17}$/;
const instancePattern = /^i-[0-9a-f]{8,17}$/;
/** The device names a data volume attaches at (`/dev/sd[f-p]`, the range EC2 recommends). */
const deviceLetters = 'fghijklmnop';
/** `/dev/sdf` and `/dev/xvdf` are one attachment point: the letter after the prefix. */
const deviceKey = (device: string) => device.replace(/^\/dev\/(?:sd|xvd)/, '');

function fail(code: ErrorCode, message: string, reason: string): ComputeError {
  return new ComputeError(code, message, undefined, { provider: 'aws', reason });
}

/** `vol-0123…` → `vol0123…`: the serial a Nitro guest sees the volume under (udev by-id). */
export function ebsSerial(volumeId: string): string {
  return volumeId.replace('-', '');
}

/** The guest path of an attached EBS volume on a Nitro instance (the NVMe by-id link). */
export function ebsGuestDevice(volumeId: string): string {
  return `/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${ebsSerial(volumeId)}`;
}

/** The ownership keys (`better-compute:<key>`) a tenant label may never set. */
const reservedLabels: ReadonlySet<string> = new Set(
  Object.values(tags)
    .filter((tag) => tag.startsWith('better-compute:'))
    .map((tag) => tag.slice('better-compute:'.length)),
);

/** A tag key for a tenant label: `better-compute:<key>`, only characters EC2 takes; never an ownership key. */
function labelKey(key: string): string | undefined {
  const clean = Array.from(String(key).replace(/[^\p{L}\p{N} _.:/=+\-@]/gu, ''))
    .slice(0, 100)
    .join('');
  if (clean === '' || reservedLabels.has(clean.toLowerCase())) return undefined;
  return `better-compute:${clean}`;
}

function tagList(
  name: string,
  owner: string,
  labels: Readonly<Record<string, string>> | undefined,
): { Key: string; Value: string }[] {
  const entries = new Map<string, string>();
  const sorted = Object.entries(labels ?? {})
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, maxLabels);
  for (const [key, value] of sorted) {
    const tag = labelKey(key);
    if (tag) entries.set(tag, tagValue(value));
  }
  // The ownership tags win over tenant labels.
  entries.set(tags.name, name);
  entries.set(tags.managed, 'true');
  entries.set(owner, name);
  return [...entries]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([Key, Value]) => ({ Key, Value }));
}

function tagsOf(item: XmlElement): Map<string, string> {
  const found = new Map<string, string>();
  for (const tag of item.items('tagSet')) {
    const key = tag.textOf('key');
    if (key !== undefined) found.set(key, tag.textOf('value') ?? '');
  }
  return found;
}

const state = (
  id: string,
  value: ProviderResourceState['state'],
  outputs?: Record<string, string>,
  message?: string,
): ProviderResourceState => ({
  id,
  state: value,
  ...(outputs ? { outputs } : {}),
  ...(message !== undefined ? { message } : {}),
});

/** A volume as DescribeVolumes / CreateVolume reports it. */
interface EbsVolume {
  id: string;
  status: string;
  zone: string;
  sizeGiB: number;
  type: string;
  iops?: string;
  throughput?: string;
  encrypted: boolean;
  snapshotId?: string;
  tags: Map<string, string>;
  attachment?: { instanceId: string; device: string; status: string };
}

function parseVolume(item: XmlElement): EbsVolume | undefined {
  const id = item.textOf('volumeId');
  if (!id) return undefined;
  const attachment = item
    .items('attachmentSet')
    .map((a) => ({
      instanceId: a.textOf('instanceId') ?? '',
      device: a.textOf('device') ?? '',
      status: a.textOf('status') ?? '',
    }))
    .find((a) => a.instanceId !== '' && a.status !== 'detached');
  const snapshotId = item.textOf('snapshotId');
  return {
    id,
    status: item.textOf('status') ?? '',
    zone: item.textOf('availabilityZone') ?? '',
    sizeGiB: Number(item.textOf('size') ?? '0'),
    type: item.textOf('volumeType') ?? '',
    ...(item.textOf('iops') ? { iops: item.textOf('iops')! } : {}),
    ...(item.textOf('throughput') ? { throughput: item.textOf('throughput')! } : {}),
    encrypted: item.textOf('encrypted') === 'true',
    ...(snapshotId ? { snapshotId } : {}),
    tags: tagsOf(item),
    ...(attachment ? { attachment } : {}),
  };
}

/** What an AWS volume and its snapshots look like to vps. */
function volumeOutputs(volume: EbsVolume, region: string): Record<string, string> {
  const outputs: Record<string, string> = {
    region,
    zone: volume.zone,
    sizeGiB: String(volume.sizeGiB),
    type: volume.type,
    encrypted: String(volume.encrypted),
    serial: ebsSerial(volume.id),
  };
  if (volume.iops !== undefined) outputs.iops = volume.iops;
  if (volume.throughput !== undefined) outputs.throughputMiBps = volume.throughput;
  if (volume.snapshotId !== undefined) outputs.snapshot = volume.snapshotId;
  if (volume.attachment) {
    outputs.attachedTo = volume.attachment.instanceId;
    outputs.attachDevice = volume.attachment.device;
    outputs.device = ebsGuestDevice(volume.id);
  }
  return outputs;
}

/** EBS volume status → contract state. */
function volumeState(volume: EbsVolume, region: string): ProviderResourceState {
  const outputs = volumeOutputs(volume, region);
  switch (volume.status) {
    case 'creating':
      return state(volume.id, 'pending', outputs);
    case 'available':
    case 'in-use':
      return state(volume.id, 'ready', outputs);
    case 'deleting':
      return state(volume.id, 'deleting', outputs);
    case 'deleted':
      return state(volume.id, 'deleted');
    default:
      return state(
        volume.id,
        'error',
        outputs,
        `EBS reports volume ${volume.id} ${volume.status || 'in an unknown state'}`,
      );
  }
}

const gone = (volume: EbsVolume) => volume.status === 'deleted' || volume.status === 'deleting';

/**
 * A volume of a name that was deleted outside better-compute (an operator, a cleanup script): an
 * error vps surfaces, never pending for ever and never an empty volume in its place.
 */
function deletedOutside(id: string): ProviderResourceState {
  return state(
    id,
    'error',
    { reason: 'deleted-outside' },
    `EBS volume ${id} was deleted outside better-compute`,
  );
}

/** A snapshot as DescribeSnapshots / CreateSnapshot reports it. */
interface EbsSnapshot {
  id: string;
  volumeId: string;
  status: string;
  volumeSize: number;
  tags: Map<string, string>;
}

function parseSnapshot(item: XmlElement): EbsSnapshot | undefined {
  const id = item.textOf('snapshotId');
  if (!id) return undefined;
  return {
    id,
    volumeId: item.textOf('volumeId') ?? '',
    status: item.textOf('status') ?? '',
    volumeSize: Number(item.textOf('volumeSize') ?? '0'),
    tags: tagsOf(item),
  };
}

/** EBS snapshot status → contract state. */
function snapshotState(snapshot: EbsSnapshot, region: string): ProviderResourceState {
  const outputs = {
    volume: snapshot.volumeId,
    region,
    sizeGiB: String(snapshot.volumeSize),
  };
  switch (snapshot.status) {
    case 'pending':
      return state(snapshot.id, 'pending', outputs);
    case 'completed':
      return state(snapshot.id, 'ready', outputs);
    default:
      return state(
        snapshot.id,
        'error',
        outputs,
        `EBS reports snapshot ${snapshot.id} ${snapshot.status || 'in an unknown state'}`,
      );
  }
}

/** The instance facts attach needs. */
interface EbsInstance {
  id: string;
  state: string;
  zone: string;
  tags: Map<string, string>;
  devices: string[];
}

export interface AwsVolumesDeps {
  /** An EC2 Query call after the account's identity checks (AwsCompute's). */
  call(action: string, params: QueryParams, signal: AbortSignal): Promise<XmlElement>;
}

/** EBS on one AWS account in one region (`ProviderImpl.volumes`). */
export class AwsVolumes implements ProviderVolumes {
  readonly types: readonly string[] = ebsVolumeTypes;
  /** name → volume id this client created, for the window EBS may not show it in tag reads. */
  readonly #created = new Map<string, { id: string; at: number }>();
  /** volume id → when this client created it (by-id reads lag too). */
  readonly #createdIds = new Map<string, number>();
  /** name → snapshot id this client created (CreateSnapshot has no ClientToken). */
  readonly #createdSnapshots = new Map<string, { id: string; at: number }>();
  readonly #createdSnapshotIds = new Map<string, number>();
  /** Attachments (`volumeId:instanceId`) this process force-detached: forced once, then waited on. */
  readonly #forced = new Set<string>();
  /** volume id → the resize this client started, for the window DescribeVolumesModifications may not list it. */
  readonly #resizing = new Map<string, { sizeGiB: number; at: number }>();
  /** volume id → when this client sent its DeleteVolume: a deleting twin of a name is then its own. */
  readonly #deleted = new Map<string, number>();
  /**
   * instance id → device letter → the volume this client attached there (or '': a device EC2 said
   * was in use), for the window attachment reads may not show it: two attaches to one new instance in
   * one pass never pick one device.
   */
  readonly #devices = new Map<string, Map<string, { volumeId: string; at: number }>>();

  constructor(
    readonly config: AwsConfig,
    readonly context: ProviderContext,
    readonly deps: AwsVolumesDeps,
    readonly consistencyWindowMs = 120_000,
  ) {}

  #recent(at: number | undefined): boolean {
    return at !== undefined && this.context.clock.now() - at < this.consistencyWindowMs;
  }

  #remember(name: string, id: string): void {
    const now = this.context.clock.now();
    for (const [key, entry] of this.#created)
      if (now - entry.at >= this.consistencyWindowMs) this.#created.delete(key);
    for (const [key, at] of this.#createdIds)
      if (now - at >= this.consistencyWindowMs) this.#createdIds.delete(key);
    this.#created.set(name, { id, at: now });
    this.#createdIds.set(id, now);
  }

  /** Drops a deleted volume or snapshot from the memos: a missing one is gone, not lagging. */
  #forget(id: string): void {
    this.#createdIds.delete(id);
    this.#createdSnapshotIds.delete(id);
    this.#resizing.delete(id);
    for (const [name, entry] of this.#created) if (entry.id === id) this.#created.delete(name);
    for (const [name, entry] of this.#createdSnapshots)
      if (entry.id === id) this.#createdSnapshots.delete(name);
  }

  #rememberSnapshot(name: string, id: string): void {
    const now = this.context.clock.now();
    for (const [key, entry] of this.#createdSnapshots)
      if (now - entry.at >= this.consistencyWindowMs) this.#createdSnapshots.delete(key);
    for (const [key, at] of this.#createdSnapshotIds)
      if (now - at >= this.consistencyWindowMs) this.#createdSnapshotIds.delete(key);
    this.#createdSnapshots.set(name, { id, at: now });
    this.#createdSnapshotIds.set(id, now);
  }

  #takeDevice(instanceId: string, letter: string, volumeId: string): void {
    const now = this.context.clock.now();
    for (const [id, letters] of this.#devices) {
      for (const [key, entry] of letters)
        if (now - entry.at >= this.consistencyWindowMs) letters.delete(key);
      if (letters.size === 0) this.#devices.delete(id);
    }
    let letters = this.#devices.get(instanceId);
    if (!letters) this.#devices.set(instanceId, (letters = new Map()));
    letters.set(letter, { volumeId, at: now });
  }

  /** Lets go of the devices this client gave a volume on an instance (it is being detached). */
  #releaseDevices(instanceId: string, volumeId: string): void {
    const letters = this.#devices.get(instanceId);
    if (!letters) return;
    for (const [key, entry] of letters) if (entry.volumeId === volumeId) letters.delete(key);
    if (letters.size === 0) this.#devices.delete(instanceId);
  }

  // --- reads -----------------------------------------------------------------------------------

  /** The volume by id; undefined when EBS says it does not exist. */
  protected async volume(id: string, signal: AbortSignal): Promise<EbsVolume | undefined> {
    try {
      const doc = await this.deps.call('DescribeVolumes', { VolumeId: [id] }, signal);
      return doc
        .items('volumeSet')
        .map(parseVolume)
        .find((volume) => volume?.id === id);
    } catch (error) {
      if (isComputeError(error, 'NOT_FOUND')) return undefined;
      throw error;
    }
  }

  /** The live volume of this deployment named `name`. */
  async #byName(name: string, signal: AbortSignal): Promise<EbsVolume | undefined> {
    const found: EbsVolume[] = [];
    const seen = new Set<string>();
    let token: string | undefined;
    do {
      const doc = await this.deps.call(
        'DescribeVolumes',
        {
          Filter: [
            { Name: `tag:${tags.volume}`, Value: [name] },
            { Name: `tag:${tags.managed}`, Value: ['true'] },
          ],
          MaxResults: 500,
          NextToken: token,
        },
        signal,
      );
      for (const item of doc.items('volumeSet')) {
        const volume = parseVolume(item);
        if (volume && volume.tags.get(tags.volume) === name) found.push(volume);
      }
      token = doc.textOf('nextToken') || undefined;
      if (token && seen.has(token))
        throw fail('PROVIDER_ERROR', 'AWS returned a pagination token twice', 'pagination-loop');
      if (token) seen.add(token);
    } while (token);
    // A deleted twin of the name (EBS keeps it visible for a while) never shadows the live one.
    return found.find((v) => v.status !== 'deleted' && v.status !== 'deleting') ?? found[0];
  }

  /**
   * The volume to change, or NOT_FOUND (also a deleted one EBS still lists); INVALID_STATE unless this
   * deployment made it, and while it is being deleted (never attached, resized or snapshotted then).
   */
  protected async owned(volumeId: string, signal: AbortSignal): Promise<EbsVolume> {
    const id = parseVolume_(volumeId);
    const volume = await this.volume(id, signal);
    if (!volume || volume.status === 'deleted')
      throw fail('NOT_FOUND', `volume ${id} does not exist`, 'volume');
    this.refuseForeign(volume);
    if (volume.status === 'deleting')
      throw fail('INVALID_STATE', `volume ${id} is being deleted`, 'deleting');
    return volume;
  }

  protected refuseForeign(volume: EbsVolume): void {
    if (volume.tags.get(tags.managed) !== 'true' || !volume.tags.get(tags.volume))
      throw fail(
        'INVALID_STATE',
        `volume ${volume.id} is not managed by better-compute and is never changed by it`,
        'not-managed',
      );
  }

  // --- ensure, get, delete ----------------------------------------------------------------------

  /** The zone a spec places its volume in (decision E-c). */
  #zoneOf(spec: ProviderVolumeSpec): string {
    const zones = this.config.zones;
    const regionIsZone = zones.includes(spec.region);
    if (!regionIsZone && spec.region !== this.config.region)
      throw fail(
        'INVALID_INPUT',
        `region ${String(spec.region).slice(0, 64)} is not this account's region ${this.config.region}`,
        'region',
      );
    if (spec.zone !== undefined) {
      if (!zones.includes(spec.zone) || (regionIsZone && spec.zone !== spec.region))
        throw fail(
          'INVALID_INPUT',
          `zone ${String(spec.zone).slice(0, 64)} is not one of this account's zones (${zones.join(', ')})`,
          'zone',
        );
      return spec.zone;
    }
    if (regionIsZone) return spec.region;
    // A bare region with several zones names none: never a silent first zone (an attach to an
    // instance in another zone would then fail only at reconcile time). Fail closed.
    if (zones.length !== 1)
      throw fail(
        'INVALID_INPUT',
        `region ${this.config.region} has several zones (${zones.join(', ')}); the volume names one`,
        'zone-required',
      );
    return zones[0]!;
  }

  #validate(spec: ProviderVolumeSpec): { zone: string; type: EbsVolumeType; name: string } {
    if (spec.kind !== 'block')
      throw fail(
        'UNSUPPORTED',
        'EBS volumes are block volumes; shared filesystems (EFS) arrive with AWS phase A10',
        'shared',
      );
    if (spec.filesystem !== undefined && spec.filesystem !== 'none')
      throw fail(
        'UNSUPPORTED',
        'EBS does not format volumes; the guest formats a raw volume',
        'filesystem',
      );
    const name = typeof spec.name === 'string' ? spec.name : '';
    if (name === '' || name.length > 255 || tagValue(name) !== name)
      throw fail(
        'INVALID_INPUT',
        'a volume name is 1 to 255 characters EC2 tags take (letters, digits, spaces, _.:/=+-@)',
        'name',
      );
    const type = (spec.type ?? 'gp3') as EbsVolumeType;
    if (!(ebsVolumeTypes as readonly string[]).includes(type))
      throw fail(
        'INVALID_INPUT',
        `EBS volume type ${String(spec.type).slice(0, 32)} is not one of ${ebsVolumeTypes.join(', ')}`,
        'type',
      );
    if (!Number.isInteger(spec.sizeGiB) || spec.sizeGiB < minSizeGiB[type])
      throw fail(
        'INVALID_INPUT',
        `an EBS ${type} volume is at least ${minSizeGiB[type]} whole GiB, not ${spec.sizeGiB}`,
        'size',
      );
    if (
      spec.iops !== undefined &&
      (!iopsTypes.has(type) || !Number.isInteger(spec.iops) || spec.iops < 1)
    )
      throw fail(
        'INVALID_INPUT',
        `provisioned IOPS are whole numbers, for ${[...iopsTypes].join(', ')} volumes only`,
        'iops',
      );
    if (
      spec.throughputMiBps !== undefined &&
      (!throughputTypes.has(type) ||
        !Number.isInteger(spec.throughputMiBps) ||
        spec.throughputMiBps < 1)
    )
      throw fail(
        'INVALID_INPUT',
        'provisioned throughput is a whole number of MiB/s, for gp3 volumes only',
        'throughput',
      );
    return { zone: this.#zoneOf(spec), type, name };
  }

  async ensureVolume(
    spec: ProviderVolumeSpec,
    context: CallContext,
  ): Promise<ProviderResourceState> {
    const { zone, type, name } = this.#validate(spec);
    const { signal } = context;
    const known = this.#created.get(name);
    let existing = await this.#byName(name, signal);
    if (!existing && known && this.#recent(known.at)) {
      existing = await this.volume(known.id, signal);
      // Made by this client and not visible to any read yet.
      if (!existing) return state(known.id, 'pending');
    }
    if (existing) {
      if (gone(existing) && !this.#recent(this.#deleted.get(existing.id)))
        return deletedOutside(existing.id);
      return volumeState(existing, this.config.region);
    }
    if (spec.snapshotId !== undefined) {
      await this.#restoreSource(spec.snapshotId, spec.sizeGiB, signal);
    }
    let doc: XmlElement;
    try {
      doc = await this.deps.call(
        'CreateVolume',
        {
          ClientToken: clientToken(`volume:${name}`),
          AvailabilityZone: zone,
          Size: spec.sizeGiB,
          VolumeType: type,
          Iops: spec.iops,
          Throughput: spec.throughputMiBps,
          Encrypted: true,
          KmsKeyId: this.config.kmsKeyId,
          SnapshotId: spec.snapshotId,
          TagSpecification: [
            { ResourceType: 'volume', Tag: tagList(name, tags.volume, spec.labels) },
          ],
        },
        signal,
      );
    } catch (error) {
      // The token names a volume an earlier, lost attempt made with other parameters: it exists and
      // the tag reads do not show it yet. Never a second volume.
      if (
        isComputeError(error, 'CONFLICT') &&
        error.details?.code === 'IdempotentParameterMismatch'
      )
        throw fail(
          'UNAVAILABLE',
          `volume ${name} was created by an earlier attempt that EBS does not show yet; it is retried`,
          'not-visible-yet',
        );
      throw error;
    }
    const made = parseVolume(doc);
    if (!made) throw fail('PROVIDER_ERROR', 'CreateVolume returned no volume', 'create');
    // EC2 answered the name's ClientToken with the volume it made before, deleted since: never
    // remembered as one being made (it would read pending for good), and never silently replaced.
    if (gone(made)) return deletedOutside(made.id);
    this.#remember(name, made.id);
    return volumeState(made, this.config.region);
  }

  /**
   * A restore's snapshot: one this deployment took, completed, no larger than the volume. One still
   * being taken is a retryable UNAVAILABLE (the restore waits for it).
   */
  async #restoreSource(snapshotId: string, sizeGiB: number, signal: AbortSignal): Promise<void> {
    if (typeof snapshotId !== 'string' || !snapshotPattern.test(snapshotId))
      throw fail('INVALID_INPUT', 'not an EBS snapshot id', 'snapshot');
    const snapshot = await this.snapshot(snapshotId, signal);
    if (!snapshot) throw fail('INVALID_INPUT', `snapshot ${snapshotId} does not exist`, 'snapshot');
    // Never a snapshot this deployment did not take: a public or shared one is another's data.
    this.#refuseForeignSnapshot(snapshot);
    if (snapshot.status === 'error')
      throw fail('INVALID_STATE', `snapshot ${snapshotId} failed`, 'snapshot-error');
    if (snapshot.status !== 'completed')
      throw fail(
        'UNAVAILABLE',
        `snapshot ${snapshotId} is still ${snapshot.status}; the restore waits for it`,
        'snapshot-pending',
      );
    if (sizeGiB < snapshot.volumeSize)
      throw fail(
        'INVALID_INPUT',
        `a volume restored from snapshot ${snapshotId} is at least ${snapshot.volumeSize} GiB`,
        'size',
      );
  }

  async getVolume(
    volumeId: string,
    context: CallContext,
  ): Promise<ProviderResourceState | undefined> {
    if (typeof volumeId !== 'string' || !volumePattern.test(volumeId)) return undefined;
    const volume = await this.volume(volumeId, context.signal);
    if (!volume)
      return this.#recent(this.#createdIds.get(volumeId)) ? state(volumeId, 'pending') : undefined;
    return volumeState(volume, this.config.region);
  }

  async deleteVolume(volumeId: string, context: CallContext): Promise<ProviderResourceState> {
    const id = parseVolume_(volumeId);
    const { signal } = context;
    const volume = await this.volume(id, signal);
    if (!volume) {
      // Just made by this client and not visible yet: deleting it later, never reporting it gone.
      if (this.#recent(this.#createdIds.get(id))) return state(id, 'deleting');
      return state(id, 'deleted');
    }
    if (volume.status === 'deleted') return state(id, 'deleted');
    this.refuseForeign(volume);
    if (volume.status === 'deleting') return volumeState(volume, this.config.region);
    if (volume.attachment)
      throw fail(
        'INVALID_STATE',
        `volume ${id} is attached to instance ${volume.attachment.instanceId}; detach it first`,
        'attached',
      );
    // A volume still being created is deleted once EBS made it.
    if (volume.status === 'creating')
      return state(id, 'deleting', volumeOutputs(volume, this.config.region));
    try {
      await this.deps.call('DeleteVolume', { VolumeId: id }, signal);
      this.#forget(id);
      const at = this.context.clock.now();
      for (const [key, sent] of this.#deleted)
        if (at - sent >= this.consistencyWindowMs) this.#deleted.delete(key);
      this.#deleted.set(id, at);
    } catch (error) {
      if (isComputeError(error, 'NOT_FOUND')) return state(id, 'deleted');
      if (error instanceof ComputeError && error.details?.code === 'VolumeInUse')
        throw fail(
          'INVALID_STATE',
          `volume ${id} is attached to an instance; detach it first`,
          'attached',
        );
      throw error;
    }
    return state(id, 'deleting', volumeOutputs(volume, this.config.region));
  }

  // --- attach, detach ---------------------------------------------------------------------------

  /** The instance facts attach needs; NOT_FOUND when EC2 does not know it. */
  async #instance(machineId: string, signal: AbortSignal): Promise<EbsInstance> {
    if (typeof machineId !== 'string' || !instancePattern.test(machineId))
      throw fail('INVALID_INPUT', 'not an EC2 instance id', 'machine');
    let item: XmlElement | undefined;
    try {
      const doc = await this.deps.call('DescribeInstances', { InstanceId: [machineId] }, signal);
      item = doc
        .items('reservationSet')
        .flatMap((reservation) => reservation.items('instancesSet'))
        .find((instance) => instance.textOf('instanceId') === machineId);
    } catch (error) {
      if (!isComputeError(error, 'NOT_FOUND')) throw error;
    }
    if (!item) throw fail('NOT_FOUND', `instance ${machineId} does not exist`, 'machine');
    const devices = item
      .items('blockDeviceMapping')
      .map((mapping) => mapping.textOf('deviceName') ?? '')
      .filter((device) => device !== '');
    const root = item.textOf('rootDeviceName');
    if (root) devices.push(root);
    return {
      id: machineId,
      state: item.child('instanceState')?.textOf('name') ?? '',
      zone: item.child('placement')?.textOf('availabilityZone') ?? '',
      tags: tagsOf(item),
      devices,
    };
  }

  /** The device names in use on an instance: its mappings plus every volume attached or attaching. */
  async #usedDevices(instance: EbsInstance, signal: AbortSignal): Promise<Set<string>> {
    const used = new Set(instance.devices.map(deviceKey));
    for (const [letter, entry] of this.#devices.get(instance.id) ?? [])
      if (this.#recent(entry.at)) used.add(letter);
    const seen = new Set<string>();
    let token: string | undefined;
    do {
      const doc = await this.deps.call(
        'DescribeVolumes',
        {
          Filter: [{ Name: 'attachment.instance-id', Value: [instance.id] }],
          MaxResults: 500,
          NextToken: token,
        },
        signal,
      );
      for (const item of doc.items('volumeSet')) {
        const device = parseVolume(item)?.attachment?.device;
        if (device) used.add(deviceKey(device));
      }
      token = doc.textOf('nextToken') || undefined;
      if (token && seen.has(token))
        throw fail('PROVIDER_ERROR', 'AWS returned a pagination token twice', 'pagination-loop');
      if (token) seen.add(token);
    } while (token);
    return used;
  }

  async attachVolume(
    volumeId: string,
    machineId: string,
    context: CallContext,
    instanceId?: string,
  ): Promise<ProviderResourceState> {
    const { signal } = context;
    const volume = await this.owned(volumeId, signal);
    const region = this.config.region;
    if (volume.attachment) {
      if (volume.attachment.instanceId !== machineId)
        throw fail(
          'CONFLICT',
          `volume ${volume.id} is attached to instance ${volume.attachment.instanceId}; detach it first`,
          'attached-elsewhere',
        );
      return state(
        volume.id,
        volume.attachment.status === 'attached' ? 'ready' : 'pending',
        volumeOutputs(volume, region),
      );
    }
    const instance = await this.#instance(machineId, signal);
    const owner = instance.tags.get(tags.instance);
    if (!owner || (instanceId !== undefined && owner !== instanceId))
      throw fail(
        'INVALID_STATE',
        instanceId === undefined
          ? `instance ${machineId} is not an instance of better-compute`
          : `instance ${machineId} does not belong to instance ${instanceId}`,
        'not-instance',
      );
    if (instance.zone !== volume.zone)
      throw fail(
        'INVALID_INPUT',
        `volume ${volume.id} is in ${volume.zone} and instance ${machineId} in ${instance.zone}: an EBS volume attaches only in its zone`,
        'zone-mismatch',
      );
    if (!['pending', 'running', 'stopping', 'stopped'].includes(instance.state))
      throw fail('INVALID_STATE', `instance ${machineId} is ${instance.state}`, 'instance-state');
    // EBS attaches to running and stopped instances; a volume still being made, or an instance
    // between states, waits for the next call.
    if (
      volume.status !== 'available' ||
      instance.state === 'pending' ||
      instance.state === 'stopping'
    ) {
      const now = volumeState(volume, region);
      return now.state === 'error'
        ? now
        : state(volume.id, 'pending', volumeOutputs(volume, region));
    }
    const used = await this.#usedDevices(instance, signal);
    const letter = [...deviceLetters].find((l) => !used.has(l));
    if (letter === undefined)
      throw fail(
        'QUOTA_EXCEEDED',
        `instance ${machineId} has no free device name in /dev/sd[f-p]`,
        'devices',
      );
    const device = `/dev/sd${letter}`;
    try {
      await this.deps.call(
        'AttachVolume',
        { VolumeId: volume.id, InstanceId: machineId, Device: device },
        signal,
      );
    } catch (error) {
      if (!(error instanceof ComputeError)) throw error;
      // Another writer took the volume or the device between the reads and the call.
      if (error.details?.code === 'VolumeInUse') {
        const now = await this.volume(volume.id, signal);
        if (now?.attachment?.instanceId === machineId)
          return state(volume.id, 'pending', volumeOutputs(now, region));
        throw fail(
          'CONFLICT',
          `volume ${volume.id} was attached elsewhere at the same time`,
          'attached-elsewhere',
        );
      }
      // The device: one a re-read (or another call of this client) shows taken, or EC2's own
      // "attachment point … in use" when no read shows the writer yet ((verify) the live message).
      if (
        error.code === 'INVALID_INPUT' &&
        (/attachment point|already in use/i.test(error.message) ||
          (await this.#usedDevices(instance, signal)).has(letter))
      ) {
        this.#takeDevice(machineId, letter, '');
        throw fail(
          'UNAVAILABLE',
          `device ${device} on instance ${machineId} was taken at the same time; it is retried`,
          'device-race',
        );
      }
      throw error;
    }
    this.#takeDevice(machineId, letter, volume.id);
    return state(volume.id, 'pending', {
      ...volumeOutputs(volume, region),
      attachedTo: machineId,
      attachDevice: device,
      device: ebsGuestDevice(volume.id),
    });
  }

  async detachVolume(
    volumeId: string,
    machineId: string,
    context: CallContext,
    options: ProviderDetachOptions = {},
  ): Promise<ProviderResourceState> {
    const id = parseVolume_(volumeId);
    const { signal } = context;
    const force = options.force === true;
    const volume = await this.volume(id, signal);
    // Not attached to that machine (or gone): nothing to detach; another machine's is never touched.
    const key = `${id}:${machineId}`;
    if (!volume || volume.attachment?.instanceId !== machineId) {
      this.#forced.delete(key);
      return state(id, 'deleted');
    }
    this.refuseForeign(volume);
    const region = this.config.region;
    // A detach under way is waited on; forced, it is forced once (a stuck guest), then waited on.
    if (volume.attachment.status === 'detaching' && (!force || this.#forced.has(key)))
      return state(id, 'deleting', volumeOutputs(volume, region));
    try {
      await this.deps.call(
        'DetachVolume',
        { VolumeId: id, InstanceId: machineId, ...(force ? { Force: 'true' } : {}) },
        signal,
      );
      if (force) this.#forced.add(key);
      this.#releaseDevices(machineId, id);
    } catch (error) {
      // Detached between the read and the call: the next call reads it detached.
      if (
        isComputeError(error, 'NOT_FOUND') ||
        (error instanceof ComputeError && error.details?.code === 'IncorrectState')
      )
        return state(id, 'deleting', volumeOutputs(volume, region));
      throw error;
    }
    return state(id, 'deleting', volumeOutputs(volume, region));
  }

  // --- resize ----------------------------------------------------------------------------------

  /** The latest modification of a volume; undefined when it was never modified. */
  async #modification(
    volumeId: string,
    signal: AbortSignal,
  ): Promise<{ state: string; targetSize: number; startTime: number } | undefined> {
    let doc: XmlElement;
    try {
      doc = await this.deps.call('DescribeVolumesModifications', { VolumeId: [volumeId] }, signal);
    } catch (error) {
      if (isComputeError(error, 'NOT_FOUND')) return undefined;
      throw error;
    }
    const latest = doc
      .items('volumeModificationSet')
      .filter((item) => item.textOf('volumeId') === volumeId)
      .map((item) => ({
        state: item.textOf('modificationState') ?? '',
        targetSize: Number(item.textOf('targetSize') ?? '0'),
        startTime: Date.parse(item.textOf('startTime') ?? ''),
      }))
      .sort((a, b) => a.startTime - b.startTime)
      .at(-1);
    return latest;
  }

  /**
   * The volume's latest modification: EBS's, or the one this client just started when EBS does not
   * list it yet (sizes only grow, so a listed one with another target is an older one).
   */
  async #latestModification(
    volumeId: string,
    signal: AbortSignal,
  ): Promise<{ state: string; targetSize: number; startTime: number } | undefined> {
    const listed = await this.#modification(volumeId, signal);
    const started = this.#resizing.get(volumeId);
    if (!started || !this.#recent(started.at)) {
      this.#resizing.delete(volumeId);
      return listed;
    }
    if (listed && listed.targetSize === started.sizeGiB) return listed;
    return { state: 'modifying', targetSize: started.sizeGiB, startTime: started.at };
  }

  #cooldown(volumeId: string, retryAfterMs: number, why: string): ComputeError {
    return new ComputeError(
      'RATE_LIMITED',
      `volume ${volumeId} ${why}; EBS takes one modification per volume every six hours`,
      undefined,
      {
        provider: 'aws',
        reason: 'cooldown',
        retryAfterMs: Math.max(1000, Math.ceil(retryAfterMs)),
      },
    );
  }

  async resizeVolume(
    volumeId: string,
    sizeGiB: number,
    context: CallContext,
  ): Promise<ProviderResourceState> {
    const { signal } = context;
    const volume = await this.owned(volumeId, signal);
    const region = this.config.region;
    if (!Number.isInteger(sizeGiB) || sizeGiB < 1)
      throw fail('INVALID_INPUT', `a volume size is whole GiB, not ${sizeGiB}`, 'size');
    if (sizeGiB < volume.sizeGiB)
      throw fail(
        'INVALID_INPUT',
        `volume ${volume.id} is ${volume.sizeGiB} GiB; a volume only grows`,
        'shrink',
      );
    const modification = await this.#latestModification(volume.id, signal);
    const now = this.context.clock.now();
    // A failed modification holds nothing here: EBS rolled it back, and its own refusal (if it
    // still counts one) is RATE_LIMITED below.
    const live = modification?.state === 'failed' ? undefined : modification;
    const left = (live?.startTime ?? -Infinity) + ebsModificationCooldownMs - now;
    if (live?.targetSize === sizeGiB) {
      // This very resize: under way until EBS optimizes it and DescribeVolumes shows the size.
      if (live.state !== 'modifying' && volume.sizeGiB >= sizeGiB)
        return volumeState(volume, region);
      return state(volume.id, 'updating', volumeOutputs(volume, region));
    }
    if (live?.state === 'modifying')
      throw this.#cooldown(volume.id, left, `is being modified to ${live.targetSize} GiB`);
    if (sizeGiB === volume.sizeGiB) return volumeState(volume, region);
    if (volume.status !== 'available' && volume.status !== 'in-use')
      return state(volume.id, 'updating', volumeOutputs(volume, region));
    if (Number.isFinite(left) && left > 0)
      throw this.#cooldown(volume.id, left, 'was modified less than six hours ago');
    try {
      await this.deps.call('ModifyVolume', { VolumeId: volume.id, Size: sizeGiB }, signal);
      const at = this.context.clock.now();
      for (const [key, entry] of this.#resizing)
        if (at - entry.at >= this.consistencyWindowMs) this.#resizing.delete(key);
      this.#resizing.set(volume.id, { sizeGiB, at });
    } catch (error) {
      const code = error instanceof ComputeError ? String(error.details?.code ?? '') : '';
      // EBS's own view of the cooldown (a modification this client did not see).
      if (code === 'IncorrectModificationState' || /ModificationRate/.test(code))
        throw this.#cooldown(volume.id, 600_000, 'cannot be modified yet');
      throw error;
    }
    return state(volume.id, 'updating', volumeOutputs(volume, region));
  }

  // --- snapshots -------------------------------------------------------------------------------

  /** The snapshot by id; undefined when EBS says it does not exist. */
  protected async snapshot(id: string, signal: AbortSignal): Promise<EbsSnapshot | undefined> {
    try {
      const doc = await this.deps.call('DescribeSnapshots', { SnapshotId: [id] }, signal);
      return doc
        .items('snapshotSet')
        .map(parseSnapshot)
        .find((snapshot) => snapshot?.id === id);
    } catch (error) {
      if (isComputeError(error, 'NOT_FOUND')) return undefined;
      throw error;
    }
  }

  async #snapshotByName(name: string, signal: AbortSignal): Promise<EbsSnapshot | undefined> {
    const seen = new Set<string>();
    let token: string | undefined;
    do {
      const doc = await this.deps.call(
        'DescribeSnapshots',
        {
          Owner: ['self'],
          Filter: [
            { Name: `tag:${tags.snapshot}`, Value: [name] },
            { Name: `tag:${tags.managed}`, Value: ['true'] },
          ],
          MaxResults: 500,
          NextToken: token,
        },
        signal,
      );
      for (const item of doc.items('snapshotSet')) {
        const snapshot = parseSnapshot(item);
        if (snapshot && snapshot.tags.get(tags.snapshot) === name) return snapshot;
      }
      token = doc.textOf('nextToken') || undefined;
      if (token && seen.has(token))
        throw fail('PROVIDER_ERROR', 'AWS returned a pagination token twice', 'pagination-loop');
      if (token) seen.add(token);
    } while (token);
    return undefined;
  }

  #refuseForeignSnapshot(snapshot: EbsSnapshot): void {
    if (snapshot.tags.get(tags.managed) !== 'true' || !snapshot.tags.get(tags.snapshot))
      throw fail(
        'INVALID_STATE',
        `snapshot ${snapshot.id} is not managed by better-compute and is never used or changed by it`,
        'not-managed',
      );
  }

  async snapshotVolume(
    volumeId: string,
    name: string,
    context: CallContext,
  ): Promise<ProviderResourceState> {
    const { signal } = context;
    if (typeof name !== 'string' || name === '' || name.length > 255 || tagValue(name) !== name)
      throw fail(
        'INVALID_INPUT',
        'a snapshot name is 1 to 255 characters EC2 tags take (letters, digits, spaces, _.:/=+-@)',
        'name',
      );
    const volume = await this.owned(volumeId, signal);
    const region = this.config.region;
    let existing = await this.#snapshotByName(name, signal);
    const known = this.#createdSnapshots.get(name);
    if (!existing && known && this.#recent(known.at)) {
      existing = await this.snapshot(known.id, signal);
      if (!existing) return state(known.id, 'pending', { volume: volume.id, region });
    }
    if (existing) {
      if (existing.volumeId !== volume.id)
        throw fail(
          'CONFLICT',
          `snapshot ${name} is a snapshot of volume ${existing.volumeId}, not ${volume.id}`,
          'snapshot-name',
        );
      return snapshotState(existing, region);
    }
    if (volume.status !== 'available' && volume.status !== 'in-use')
      throw fail(
        'UNAVAILABLE',
        `volume ${volume.id} is ${volume.status}; it is snapshotted once it is ready`,
        'volume-not-ready',
      );
    // CreateSnapshot takes no ClientToken: the memo above and the tag read stand in for it.
    const doc = await this.deps.call(
      'CreateSnapshot',
      {
        VolumeId: volume.id,
        Description: `better-compute ${name}`,
        TagSpecification: [
          { ResourceType: 'snapshot', Tag: tagList(name, tags.snapshot, undefined) },
        ],
      },
      signal,
    );
    const made = parseSnapshot(doc);
    if (!made) throw fail('PROVIDER_ERROR', 'CreateSnapshot returned no snapshot', 'snapshot');
    this.#rememberSnapshot(name, made.id);
    return snapshotState(made, region);
  }

  async getSnapshot(
    snapshotId: string,
    context: CallContext,
  ): Promise<ProviderResourceState | undefined> {
    if (typeof snapshotId !== 'string' || !snapshotPattern.test(snapshotId)) return undefined;
    const snapshot = await this.snapshot(snapshotId, context.signal);
    if (!snapshot)
      return this.#recent(this.#createdSnapshotIds.get(snapshotId))
        ? state(snapshotId, 'pending')
        : undefined;
    return snapshotState(snapshot, this.config.region);
  }

  async deleteSnapshot(snapshotId: string, context: CallContext): Promise<ProviderResourceState> {
    if (typeof snapshotId !== 'string' || !snapshotPattern.test(snapshotId))
      throw fail('INVALID_INPUT', 'not an EBS snapshot id', 'snapshot-id');
    const { signal } = context;
    const snapshot = await this.snapshot(snapshotId, signal);
    if (!snapshot) {
      if (this.#recent(this.#createdSnapshotIds.get(snapshotId)))
        return state(snapshotId, 'deleting');
      return state(snapshotId, 'deleted');
    }
    this.#refuseForeignSnapshot(snapshot);
    try {
      await this.deps.call('DeleteSnapshot', { SnapshotId: snapshotId }, signal);
      this.#forget(snapshotId);
    } catch (error) {
      if (isComputeError(error, 'NOT_FOUND')) return state(snapshotId, 'deleted');
      if (error instanceof ComputeError && error.details?.code === 'InvalidSnapshot.InUse')
        throw fail(
          'INVALID_STATE',
          `snapshot ${snapshotId} is in use (an AMI is registered from it)`,
          'in-use',
        );
      throw error;
    }
    return state(snapshotId, 'deleted');
  }
}

/** The EBS volume id; `INVALID_INPUT` otherwise. */
function parseVolume_(id: string): string {
  if (typeof id !== 'string' || !volumePattern.test(id))
    throw fail('INVALID_INPUT', 'not an EBS volume id', 'volume-id');
  return id;
}
