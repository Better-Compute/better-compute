import type { AwsEmulator, EmulatorRequest } from './index.js';
import type { Ec2Emulator, EmuInstance } from './ec2.js';
import { ec2Error, ec2Response, el, items } from './xml.js';

// EBS as provider-aws uses it, on the EC2 endpoint: CreateVolume (ClientToken dedupe, tags on
// create, from a snapshot), DescribeVolumes (ids, tag/attachment/status filters, paging),
// AttachVolume/DetachVolume, ModifyVolume with DescribeVolumesModifications and the six-hour
// cooldown from the start of the previous modification, DeleteVolume, and CreateSnapshot /
// DescribeSnapshots / DeleteSnapshot. Like EBS: a volume attaches only in its own zone and to one
// instance, a device name is used once per instance, an attached volume is not deleted, and a
// volume only grows. Knobs: settleOnRead (every Describe* moves transitional states one step),
// A terminating instance detaches its volumes (DeleteOnTermination is false for AttachVolume).
// newVolumeNotFound (eventual consistency right after CreateVolume), cooldownCode, stuckDetach (a
// guest that never releases the volume: only DetachVolume Force=true lets it go), addVolume and
// addSnapshot (foreign resources), and tick.

export interface EmuAttachment {
  instanceId: string;
  device: string;
  state: 'attaching' | 'attached' | 'detaching';
}

export interface EmuVolume {
  id: string;
  zone: string;
  sizeGiB: number;
  type: string;
  iops?: number;
  throughput?: number;
  encrypted: boolean;
  kmsKeyId?: string;
  snapshotId?: string;
  state: 'creating' | 'available' | 'in-use' | 'deleting' | 'deleted' | 'error';
  tags: Map<string, string>;
  attachment?: EmuAttachment;
  clientToken?: string;
  signature?: string;
  notFoundById: number;
  createTime: number;
}

export interface EmuModification {
  volumeId: string;
  state: 'modifying' | 'optimizing' | 'completed' | 'failed';
  originalSize: number;
  targetSize: number;
  startTime: number;
}

export interface EmuSnapshot {
  id: string;
  volumeId: string;
  volumeSize: number;
  state: 'pending' | 'completed' | 'error';
  description?: string;
  tags: Map<string, string>;
  ownerId: string;
  startTime: number;
  /** Registered as an AMI's snapshot: DeleteSnapshot refuses (InvalidSnapshot.InUse). */
  inUse?: boolean;
}

const sixHoursMs = 6 * 3_600_000;

function listOf(params: URLSearchParams, prefix: string): string[] {
  const out: string[] = [];
  for (let n = 1; params.has(`${prefix}.${n}`); n++) out.push(params.get(`${prefix}.${n}`)!);
  return out;
}

function filtersOf(params: URLSearchParams): Map<string, string[]> {
  const filters = new Map<string, string[]>();
  for (let n = 1; params.has(`Filter.${n}.Name`); n++)
    filters.set(params.get(`Filter.${n}.Name`)!, listOf(params, `Filter.${n}.Value`));
  return filters;
}

/** TagSpecification.N with ResourceType `type` → tags. */
function tagsFor(params: URLSearchParams, type: string): Map<string, string> {
  const tags = new Map<string, string>();
  for (let n = 1; params.has(`TagSpecification.${n}.ResourceType`); n++) {
    if (params.get(`TagSpecification.${n}.ResourceType`) !== type) continue;
    for (let m = 1; params.has(`TagSpecification.${n}.Tag.${m}.Key`); m++)
      tags.set(
        params.get(`TagSpecification.${n}.Tag.${m}.Key`)!,
        params.get(`TagSpecification.${n}.Tag.${m}.Value`) ?? '',
      );
  }
  return tags;
}

const tagSet = (tags: Map<string, string>) =>
  items(
    'tagSet',
    [...tags]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${el('key', k)}${el('value', v)}`),
  );

function tagMatch(tags: Map<string, string>, filters: Map<string, string[]>): boolean {
  for (const [name, values] of filters) {
    if (!name.startsWith('tag:')) continue;
    const value = tags.get(name.slice(4));
    if (value === undefined || !values.includes(value)) return false;
  }
  return true;
}

/** The device letter of `/dev/sdf` or `/dev/xvdf` (EC2 treats them as one attachment point). */
const deviceKey = (device: string) => device.replace(/^\/dev\/(?:sd|xvd)/, '');

export class EbsEmulator {
  readonly volumes = new Map<string, EmuVolume>();
  readonly snapshots = new Map<string, EmuSnapshot>();
  readonly modifications: EmuModification[] = [];
  /** Page size cap for paged reads (small, so tests page). */
  pageSize = 2;
  /** Every DescribeVolumes / DescribeSnapshots / DescribeVolumesModifications first ticks. */
  settleOnRead = false;
  /** By-id DescribeVolumes reads that miss a just-created volume. */
  newVolumeNotFound = 0;
  /** The error code ModifyVolume answers inside the six-hour cooldown. */
  cooldownCode = 'VolumeModificationRateExceeded';
  /** Volumes filtered (not by-id) DescribeVolumes reads leave out: tag reads that lag behind. */
  hideFromFilters = new Set<string>();
  /** Volumes whose detach stays `detaching` until a DetachVolume with Force=true. */
  stuckDetach = new Set<string>();
  /** When DescribeVolumes shows a modification's new size: from `optimizing` (default) or only once `completed`. */
  sizeShownWhen: 'optimizing' | 'completed' = 'optimizing';
  /** Volumes whose modifications DescribeVolumesModifications leaves out (a read that lags ModifyVolume). */
  hiddenModifications = new Set<string>();
  /** Whether a failed modification still holds the next one for six hours ((verify) A12). */
  failedModificationCoolsDown = true;
  #next = 0;

  constructor(
    private readonly emu: AwsEmulator,
    private readonly ec2: Ec2Emulator,
  ) {
    ec2.extensions.push((request) => this.#handle(request));
    ec2.blockDevices = (instance) => this.#blockDevices(instance);
  }

  #id(prefix: string): string {
    return `${prefix}-${(++this.#next).toString(16).padStart(17, '0')}`;
  }

  /** A volume better-compute did not create (or one with chosen tags). */
  addVolume(
    options: {
      zone?: string;
      sizeGiB?: number;
      tags?: Record<string, string>;
      state?: EmuVolume['state'];
      attachedTo?: { instanceId: string; device: string };
    } = {},
  ): EmuVolume {
    const volume: EmuVolume = {
      id: this.#id('vol'),
      zone: options.zone ?? 'us-east-1a',
      sizeGiB: options.sizeGiB ?? 10,
      type: 'gp3',
      encrypted: false,
      state: options.state ?? (options.attachedTo ? 'in-use' : 'available'),
      tags: new Map(Object.entries(options.tags ?? {})),
      notFoundById: 0,
      createTime: this.emu.now(),
      ...(options.attachedTo ? { attachment: { ...options.attachedTo, state: 'attached' } } : {}),
    };
    this.volumes.set(volume.id, volume);
    return volume;
  }

  /** A snapshot better-compute did not create (or one with chosen tags). */
  addSnapshot(
    options: { volumeSize?: number; tags?: Record<string, string>; ownerId?: string } = {},
  ): EmuSnapshot {
    const snapshot: EmuSnapshot = {
      id: this.#id('snap'),
      volumeId: 'vol-ffffffff',
      volumeSize: options.volumeSize ?? 10,
      state: 'completed',
      tags: new Map(Object.entries(options.tags ?? {})),
      ownerId: options.ownerId ?? '222222222222',
      startTime: this.emu.now(),
    };
    this.snapshots.set(snapshot.id, snapshot);
    return snapshot;
  }

  /** Moves every transitional state one step. */
  tick(): void {
    for (const volume of this.volumes.values()) {
      if (volume.state === 'creating') volume.state = 'available';
      else if (volume.state === 'deleting') volume.state = 'deleted';
      else if (volume.state === 'deleted') this.volumes.delete(volume.id);
      const attachment = volume.attachment;
      // AttachVolume leaves DeleteOnTermination false: a terminating instance lets its volumes go
      // (detaching while it shuts down, available once it is terminated), stuck guest or not.
      const host = attachment ? this.ec2.instances.get(attachment.instanceId) : undefined;
      if (attachment && (!host || host.state === 'terminated')) {
        delete volume.attachment;
        volume.state = 'available';
        continue;
      }
      if (attachment && host?.state === 'shutting-down') {
        attachment.state = 'detaching';
        continue;
      }
      if (attachment?.state === 'attaching') attachment.state = 'attached';
      else if (attachment?.state === 'detaching' && !this.stuckDetach.has(volume.id)) {
        delete volume.attachment;
        volume.state = 'available';
      }
    }
    for (const modification of this.modifications) {
      const volume = this.volumes.get(modification.volumeId);
      if (modification.state === 'modifying') {
        modification.state = 'optimizing';
        if (volume && this.sizeShownWhen === 'optimizing') volume.sizeGiB = modification.targetSize;
      } else if (modification.state === 'optimizing') {
        modification.state = 'completed';
        if (volume) volume.sizeGiB = modification.targetSize;
      }
    }
    for (const snapshot of this.snapshots.values())
      if (snapshot.state === 'pending') snapshot.state = 'completed';
  }

  #blockDevices(instance: EmuInstance): string[] {
    const out = [
      `${el('deviceName', instance.rootDevice)}<ebs>${el('volumeId', `vol-root${instance.id.slice(2, 10)}`)}${el('status', 'attached')}</ebs>`,
    ];
    for (const volume of this.volumes.values())
      if (volume.attachment?.instanceId === instance.id)
        out.push(
          `${el('deviceName', volume.attachment.device)}<ebs>${el('volumeId', volume.id)}${el('status', volume.attachment.state)}</ebs>`,
        );
    return out;
  }

  #page<T>(all: T[], params: URLSearchParams): { page: T[]; next?: string } {
    const start = Number(params.get('NextToken')?.replace(/^tok-/, '') ?? '0');
    const max = Math.min(Number(params.get('MaxResults') ?? Infinity), this.pageSize);
    const page = all.slice(start, start + max);
    const next = start + max < all.length ? `tok-${start + max}` : undefined;
    return { page, ...(next ? { next } : {}) };
  }

  #attachmentXml(volume: EmuVolume): string {
    const a = volume.attachment;
    return a
      ? `${el('volumeId', volume.id)}${el('instanceId', a.instanceId)}${el('device', a.device)}${el('status', a.state)}${el('attachTime', new Date(volume.createTime).toISOString())}${el('deleteOnTermination', false)}`
      : '';
  }

  #volumeXml(volume: EmuVolume): string {
    return [
      el('volumeId', volume.id),
      el('size', volume.sizeGiB),
      el('snapshotId', volume.snapshotId ?? ''),
      el('availabilityZone', volume.zone),
      el('status', volume.state),
      el('createTime', new Date(volume.createTime).toISOString()),
      items('attachmentSet', volume.attachment ? [this.#attachmentXml(volume)] : []),
      el('volumeType', volume.type),
      el('iops', volume.iops),
      el('throughput', volume.throughput),
      el('encrypted', volume.encrypted),
      el('kmsKeyId', volume.kmsKeyId),
      el('multiAttachEnabled', false),
      tagSet(volume.tags),
    ].join('');
  }

  #snapshotXml(snapshot: EmuSnapshot): string {
    return [
      el('snapshotId', snapshot.id),
      el('volumeId', snapshot.volumeId),
      el('status', snapshot.state),
      el('startTime', new Date(snapshot.startTime).toISOString()),
      el('progress', snapshot.state === 'completed' ? '100%' : '0%'),
      el('ownerId', snapshot.ownerId),
      el('volumeSize', snapshot.volumeSize),
      el('description', snapshot.description),
      el('encrypted', true),
      tagSet(snapshot.tags),
    ].join('');
  }

  #modificationXml(m: EmuModification): string {
    return [
      el('volumeId', m.volumeId),
      el('modificationState', m.state),
      el('targetSize', m.targetSize),
      el('originalSize', m.originalSize),
      el('progress', m.state === 'completed' ? 100 : 0),
      el('startTime', new Date(m.startTime).toISOString()),
    ].join('');
  }

  #volume(id: string): EmuVolume | Response {
    const volume = this.volumes.get(id);
    if (!volume) return ec2Error('InvalidVolume.NotFound', `The volume '${id}' does not exist.`);
    return volume;
  }

  #handle(request: EmulatorRequest): Response | undefined {
    const p = request.params;
    const action = request.operation;
    switch (action) {
      case 'CreateVolume':
        return this.#create(p);
      case 'DescribeVolumes': {
        if (this.settleOnRead) this.tick();
        const ids = listOf(p, 'VolumeId');
        const filters = filtersOf(p);
        let found: EmuVolume[];
        if (ids.length) {
          found = [];
          for (const id of ids) {
            const volume = this.volumes.get(id);
            if (!volume || volume.notFoundById > 0) {
              if (volume) volume.notFoundById -= 1;
              return ec2Error('InvalidVolume.NotFound', `The volume '${id}' does not exist.`);
            }
            found.push(volume);
          }
        } else found = [...this.volumes.values()].filter((v) => !this.hideFromFilters.has(v.id));
        found = found.filter((volume) => {
          if (!tagMatch(volume.tags, filters)) return false;
          const status = filters.get('status');
          if (status && !status.includes(volume.state)) return false;
          const attached = filters.get('attachment.instance-id');
          if (attached && !attached.includes(volume.attachment?.instanceId ?? '')) return false;
          return true;
        });
        const { page, next } = ids.length ? { page: found, next: undefined } : this.#page(found, p);
        return ec2Response(
          action,
          items(
            'volumeSet',
            page.map((volume) => this.#volumeXml(volume)),
          ) + el('nextToken', next),
        );
      }
      case 'AttachVolume': {
        const volume = this.#volume(p.get('VolumeId') ?? '');
        if (volume instanceof Response) return volume;
        const instanceId = p.get('InstanceId') ?? '';
        const instance = this.ec2.instances.get(instanceId);
        if (!instance)
          return ec2Error(
            'InvalidInstanceID.NotFound',
            `The instance ID '${instanceId}' does not exist`,
          );
        const device = p.get('Device') ?? '';
        if (!/^\/dev\/(sd[a-z]|xvd[a-z])$/.test(device))
          return ec2Error(
            'InvalidParameterValue',
            `Value (${device}) for parameter device is invalid.`,
          );
        if (volume.zone !== instance.zone)
          return ec2Error(
            'InvalidVolume.ZoneMismatch',
            `The volume '${volume.id}' is not in the same availability zone as instance '${instanceId}'`,
          );
        if (volume.attachment || volume.state === 'in-use')
          return ec2Error('VolumeInUse', `vol ${volume.id} is already attached to an instance`);
        if (volume.state !== 'available')
          return ec2Error('IncorrectState', `The volume '${volume.id}' is not 'available'.`);
        if (instance.state !== 'running' && instance.state !== 'stopped')
          return ec2Error(
            'IncorrectInstanceState',
            `The instance '${instanceId}' is not 'running'.`,
          );
        const used = [instance.rootDevice, ...this.#attachedDevices(instanceId)].map(deviceKey);
        if (used.includes(deviceKey(device)))
          return ec2Error('InvalidParameterValue', `Attachment point ${device} is already in use`);
        volume.attachment = { instanceId, device, state: 'attaching' };
        volume.state = 'in-use';
        return ec2Response(action, this.#attachmentXml(volume));
      }
      case 'DetachVolume': {
        const volume = this.#volume(p.get('VolumeId') ?? '');
        if (volume instanceof Response) return volume;
        const instanceId = p.get('InstanceId');
        if (!volume.attachment)
          return ec2Error('IncorrectState', `Volume '${volume.id}' is in the 'available' state.`);
        if (instanceId && volume.attachment.instanceId !== instanceId)
          return ec2Error(
            'InvalidAttachment.NotFound',
            `Volume '${volume.id}' is not attached to '${instanceId}'.`,
          );
        if (p.get('Force') === 'true') this.stuckDetach.delete(volume.id);
        volume.attachment.state = 'detaching';
        return ec2Response(action, this.#attachmentXml(volume));
      }
      case 'ModifyVolume': {
        const volume = this.#volume(p.get('VolumeId') ?? '');
        if (volume instanceof Response) return volume;
        const size = p.has('Size') ? Number(p.get('Size')) : volume.sizeGiB;
        if (size < volume.sizeGiB)
          return ec2Error(
            'InvalidParameterValue',
            `New size cannot be smaller than existing size (${volume.sizeGiB}).`,
          );
        const last = this.modifications.filter((m) => m.volumeId === volume.id).at(-1);
        if (last?.state === 'modifying')
          return ec2Error(
            'IncorrectModificationState',
            `Volume ${volume.id} is in a modification state that does not allow further modification.`,
          );
        if (
          last &&
          (last.state !== 'failed' || this.failedModificationCoolsDown) &&
          this.emu.now() - last.startTime < sixHoursMs
        )
          return ec2Error(
            this.cooldownCode,
            "You've reached the maximum modification rate per volume limit. Wait at least 6 hours between modifications per EBS volume.",
          );
        if (volume.state !== 'available' && volume.state !== 'in-use')
          return ec2Error('IncorrectState', `The volume '${volume.id}' is ${volume.state}.`);
        const modification: EmuModification = {
          volumeId: volume.id,
          state: 'modifying',
          originalSize: volume.sizeGiB,
          targetSize: size,
          startTime: this.emu.now(),
        };
        this.modifications.push(modification);
        return ec2Response(
          action,
          `<volumeModification>${this.#modificationXml(modification)}</volumeModification>`,
        );
      }
      case 'DescribeVolumesModifications': {
        if (this.settleOnRead) this.tick();
        const ids = listOf(p, 'VolumeId');
        // Like EBS: the latest modification of each volume; a volume never modified is NotFound.
        const latest = new Map<string, EmuModification>();
        for (const m of this.modifications)
          if ((ids.length === 0 || ids.includes(m.volumeId)) && !this.hiddenModifications.has(m.volumeId))
            latest.set(m.volumeId, m);
        const missing = ids.find((id) => !latest.has(id));
        if (missing)
          return ec2Error(
            'InvalidVolumeModification.NotFound',
            `Modification for volume '${missing}' does not exist.`,
          );
        const found = [...latest.values()];
        return ec2Response(
          action,
          items(
            'volumeModificationSet',
            found.map((m) => this.#modificationXml(m)),
          ),
        );
      }
      case 'DeleteVolume': {
        const volume = this.#volume(p.get('VolumeId') ?? '');
        if (volume instanceof Response) return volume;
        if (volume.attachment || volume.state === 'in-use')
          return ec2Error(
            'VolumeInUse',
            `Volume ${volume.id} is currently attached to an instance`,
          );
        if (volume.state === 'deleting' || volume.state === 'deleted')
          return ec2Response(action, el('return', true));
        if (volume.state !== 'available' && volume.state !== 'error')
          return ec2Error('IncorrectState', `The volume '${volume.id}' is ${volume.state}.`);
        volume.state = 'deleting';
        return ec2Response(action, el('return', true));
      }
      case 'CreateSnapshot': {
        const volume = this.#volume(p.get('VolumeId') ?? '');
        if (volume instanceof Response) return volume;
        const snapshot: EmuSnapshot = {
          id: this.#id('snap'),
          volumeId: volume.id,
          volumeSize: volume.sizeGiB,
          state: 'pending',
          tags: tagsFor(p, 'snapshot'),
          ownerId: '222222222222',
          startTime: this.emu.now(),
          ...(p.get('Description') ? { description: p.get('Description')! } : {}),
        };
        this.snapshots.set(snapshot.id, snapshot);
        return ec2Response(action, this.#snapshotXml(snapshot));
      }
      case 'DescribeSnapshots': {
        if (this.settleOnRead) this.tick();
        const ids = listOf(p, 'SnapshotId');
        const owners = listOf(p, 'Owner');
        const filters = filtersOf(p);
        let found: EmuSnapshot[];
        if (ids.length) {
          found = [];
          for (const id of ids) {
            const snapshot = this.snapshots.get(id);
            if (!snapshot)
              return ec2Error('InvalidSnapshot.NotFound', `The snapshot '${id}' does not exist.`);
            found.push(snapshot);
          }
        } else found = [...this.snapshots.values()].filter((x) => !this.hideFromFilters.has(x.id));
        found = found.filter(
          (snapshot) =>
            tagMatch(snapshot.tags, filters) &&
            (owners.length === 0 ||
              owners.some((owner) =>
                owner === 'self' ? snapshot.ownerId === '222222222222' : owner === snapshot.ownerId,
              )),
        );
        const { page, next } = ids.length ? { page: found, next: undefined } : this.#page(found, p);
        return ec2Response(
          action,
          items(
            'snapshotSet',
            page.map((snapshot) => this.#snapshotXml(snapshot)),
          ) + el('nextToken', next),
        );
      }
      case 'DeleteSnapshot': {
        const id = p.get('SnapshotId') ?? '';
        const snapshot = this.snapshots.get(id);
        if (!snapshot)
          return ec2Error('InvalidSnapshot.NotFound', `The snapshot '${id}' does not exist.`);
        if (snapshot.inUse)
          return ec2Error(
            'InvalidSnapshot.InUse',
            `The snapshot ${id} is currently in use by an AMI`,
          );
        this.snapshots.delete(id);
        return ec2Response(action, el('return', true));
      }
      default:
        return undefined;
    }
  }

  #attachedDevices(instanceId: string): string[] {
    return [...this.volumes.values()]
      .filter((volume) => volume.attachment?.instanceId === instanceId)
      .map((volume) => volume.attachment!.device);
  }

  #create(p: URLSearchParams): Response {
    const token = p.get('ClientToken') ?? undefined;
    const signature = [...p]
      .filter(([key]) => key !== 'ClientToken')
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join('&');
    if (token) {
      const existing = [...this.volumes.values()].find((volume) => volume.clientToken === token);
      if (existing) {
        if (existing.signature !== signature)
          return ec2Error(
            'IdempotentParameterMismatch',
            'Arguments on this idempotent request are inconsistent with arguments used in previous request(s).',
          );
        return ec2Response('CreateVolume', this.#volumeXml(existing));
      }
    }
    const zone = p.get('AvailabilityZone') ?? '';
    if (!this.ec2.zones.has(zone))
      return ec2Error('InvalidParameterValue', `Invalid availability zone: [${zone}]`);
    const snapshotId = p.get('SnapshotId') ?? undefined;
    let size = p.has('Size') ? Number(p.get('Size')) : undefined;
    if (snapshotId) {
      const snapshot = this.snapshots.get(snapshotId);
      if (!snapshot)
        return ec2Error('InvalidSnapshot.NotFound', `The snapshot '${snapshotId}' does not exist.`);
      size ??= snapshot.volumeSize;
      if (size < snapshot.volumeSize)
        return ec2Error(
          'InvalidParameterValue',
          `Volume of ${size}GiB is too small; minimum is ${snapshot.volumeSize}GiB`,
        );
    }
    if (size === undefined || !Number.isInteger(size) || size < 1)
      return ec2Error(
        'MissingParameter',
        'The request must contain the parameter size or snapshotId',
      );
    const volume: EmuVolume = {
      id: this.#id('vol'),
      zone,
      sizeGiB: size,
      type: p.get('VolumeType') ?? 'gp2',
      ...(p.has('Iops') ? { iops: Number(p.get('Iops')) } : {}),
      ...(p.has('Throughput') ? { throughput: Number(p.get('Throughput')) } : {}),
      encrypted: p.get('Encrypted') === 'true',
      ...(p.get('KmsKeyId') ? { kmsKeyId: p.get('KmsKeyId')! } : {}),
      ...(snapshotId ? { snapshotId } : {}),
      state: 'creating',
      tags: tagsFor(p, 'volume'),
      ...(token ? { clientToken: token } : {}),
      signature,
      notFoundById: this.newVolumeNotFound,
      createTime: this.emu.now(),
    };
    this.volumes.set(volume.id, volume);
    return ec2Response('CreateVolume', this.#volumeXml(volume));
  }
}
