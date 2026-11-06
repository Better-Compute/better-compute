import {
  ComputeError,
  isComputeError,
  type CallContext,
  type Logger,
  type ProviderResourceState,
  type ProviderVolumes,
  type ProviderVolumeSpec,
} from '@better-compute/core';
import type { DoClient } from '../client/http.js';
import type { DoAction, DoDroplet } from '../compute/types.js';
import type { DoConfig } from '../config.js';
import { deploymentTag, labels, parseMachineId, tagFor } from '../ids.js';
import { DoShares, isShareId } from './nfs.js';
import type { DoSnapshot, DoVolume } from './types.js';

// Block Storage volumes as provider volumes (P2). A volume is found by its name, which is unique
// per region: vps derives it, so a retried ensure finds what its first attempt made, and a create
// that races another one on the same name loses with a 422 and reads the winner. A volume of
// ours carries the managed tag and this deployment's tag (DO-D16, as Droplets do): every call but
// `ensureVolume` and `getVolume` refuses any other volume (`INVALID_STATE`), and `ensureVolume`
// refuses a same-named volume that is not ours (`CONFLICT`), so better-compute never attaches,
// resizes or deletes a volume it did not make.
//
// Attach, detach and resize are DO volume actions: they answer 202 and run in the background.
// No state outlives a call (ruling R4): each call reads the volume and, before it starts an
// action, the volume's action list, so a call that finds an action of its own still running
// reports `pending`/`updating`/`deleting` and starts nothing. A volume attaches only to a Droplet
// in its region (`INVALID_INPUT` before any write) that belongs to an instance of this deployment,
// and DO attaches a Block Storage volume to one Droplet at a time: one attached elsewhere is
// `CONFLICT`, never moved. The guest sees it as `/dev/disk/by-id/scsi-0DO_Volume_<name>`.
//
// Volume snapshots are found by name among the volume's snapshots and carry the same two tags.
// DO keeps no snapshot name unique, so two racing calls may both take one: the call keeps the
// oldest of ours and deletes the others (as Droplet creates do, DO-D4). A snapshot outlives its
// volume; `ensureVolume` with `snapshotId` restores one into a new volume.
//
// `kind: 'shared'` volumes are Network File Storage shares (P6, ./nfs.ts): `ensureVolume` and
// every call given a share id (`nfs:<region>:<uuid>`) go to `DoShares`.

/** DO's largest volume, in GiB. */
export const maxVolumeGiB = 16_384;
const volumeNamePattern = /^[a-z][a-z0-9-]{0,63}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const tagPattern = /^[a-z0-9:_-]{1,255}$/;
const managedTag = tagFor(labels.managed, 'true');
const instanceTagPrefix = `${labels.instance}:`;
/** Label keys only the provider writes: a spec's label never sets them. */
const reservedKeys: ReadonlySet<string> = new Set([
  labels.managed,
  labels.instance,
  labels.deployment,
  labels.key,
  labels.autoscalePool,
]);

function fail(
  code: 'INVALID_INPUT' | 'INVALID_STATE' | 'UNSUPPORTED' | 'CONFLICT' | 'NOT_FOUND',
  message: string,
  reason: string,
): ComputeError {
  return new ComputeError(code, message, undefined, { provider: 'digitalocean', reason });
}

/** Whether a tag list carries the (lowercase) tag, in any spelling. */
export function carries(tags: readonly string[] | null | undefined, tag: string): boolean {
  return (tags ?? []).some((t) => t.toLowerCase() === tag);
}

/** The guest path a DO volume appears at once attached. */
export function volumeDevice(name: string): string {
  return `/dev/disk/by-id/scsi-0DO_Volume_${name}`;
}

/** A volume id as DO writes it (a uuid); anything else is `INVALID_INPUT`. */
export function parseVolumeId(id: string): string {
  if (!uuidPattern.test(id))
    throw fail(
      'INVALID_INPUT',
      `${JSON.stringify(id)} is not a DigitalOcean volume id`,
      'volumeId',
    );
  return id.toLowerCase();
}

/**
 * The tags for a spec's labels: `<key>:<value>` by the tag codec. A key with a colon could forge
 * a reserved prefix, so it is refused; the provider's own keys are skipped.
 */
export function labelTags(spec: Readonly<Record<string, string>> | undefined): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(spec ?? {})) {
    if (key.includes(':'))
      throw fail(
        'INVALID_INPUT',
        `label ${JSON.stringify(key)} can't be a DigitalOcean tag key: it has a colon`,
        'label',
      );
    if (reservedKeys.has(key.toLowerCase())) continue;
    const tag = tagFor(key, value);
    if (!tagPattern.test(tag))
      throw fail(
        'INVALID_INPUT',
        `label ${JSON.stringify(key)} can't be a DigitalOcean tag`,
        'label',
      );
    out.push(tag);
  }
  return out;
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

const snapshotNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/;

/** Oldest first: by creation time (whole seconds at DO), then by id. */
function snapshotsByAge(a: DoSnapshot, b: DoSnapshot): number {
  const at = Date.parse(a.created_at) - Date.parse(b.created_at);
  return Number.isFinite(at) && at !== 0 ? at : a.id.localeCompare(b.id);
}

/** A snapshot's outputs: the volume it is of, its region, and the size it restores to. */
export function snapshotOutputs(snapshot: DoSnapshot): Record<string, string> {
  return {
    volume: snapshot.resource_id,
    ...(snapshot.regions[0] !== undefined ? { region: snapshot.regions[0] } : {}),
    sizeGiB: String(snapshot.min_disk_size),
    storedGiB: String(snapshot.size_gigabytes),
  };
}

/** A volume's outputs (plain values only). */
export function volumeOutputs(volume: DoVolume): Record<string, string> {
  const attached = volume.droplet_ids?.[0];
  return {
    region: volume.region.slug,
    sizeGiB: String(volume.size_gigabytes),
    ...(volume.filesystem_type ? { filesystem: volume.filesystem_type } : {}),
    device: volumeDevice(volume.name),
    ...(attached !== undefined ? { attachedTo: String(attached) } : {}),
  };
}

export class DoVolumes implements ProviderVolumes {
  protected readonly client: DoClient;
  protected readonly config: DoConfig;
  protected readonly log: Logger;
  /** This deployment's tag: with the managed tag, what makes a volume ours. */
  protected readonly deploymentTag: string;
  /** Network File Storage shares: the `kind: 'shared'` volumes. */
  readonly shares: DoShares;

  constructor(client: DoClient, config: DoConfig, deployment: string, log: Logger) {
    this.client = client;
    this.config = config;
    this.log = log;
    this.deploymentTag = deploymentTag(deployment);
    this.shares = new DoShares(client, config, deployment, log);
  }

  /** Whether better-compute may act on the volume: managed, and in this deployment. */
  protected owned(tags: readonly string[] | null | undefined): boolean {
    return carries(tags, managedTag) && carries(tags, this.deploymentTag);
  }

  /** The volume, or undefined when it does not exist. */
  protected async volume(id: string, signal: AbortSignal): Promise<DoVolume | undefined> {
    try {
      const reply = await this.client.request<{ volume: DoVolume }>(
        'GET',
        `/volumes/${encodeURIComponent(id)}`,
        { signal, budget: 'observe' },
      );
      return reply.volume;
    } catch (error) {
      if (isComputeError(error, 'NOT_FOUND')) return undefined;
      throw error;
    }
  }

  /** The volume to act on: it must exist and be ours. */
  protected async ours(id: string, signal: AbortSignal): Promise<DoVolume> {
    const volume = await this.volume(id, signal);
    if (!volume)
      throw new ComputeError('NOT_FOUND', `volume ${id} does not exist`, undefined, {
        provider: 'digitalocean',
        id,
      });
    this.refuseForeign(volume);
    return volume;
  }

  protected refuseForeign(volume: DoVolume): void {
    if (!this.owned(volume.tags))
      throw fail(
        'INVALID_STATE',
        `volume ${volume.id} is not managed by this better-compute deployment and is never changed by it`,
        'notManaged',
      );
  }

  /** The volumes named `name` in `region` (at most one at DO; a list to be safe). */
  protected async byName(name: string, region: string, signal: AbortSignal): Promise<DoVolume[]> {
    const out: DoVolume[] = [];
    for await (const volume of this.client.pages<DoVolume>('/volumes', 'volumes', {
      query: { name, region },
      signal,
      budget: 'observe',
    }))
      if (volume.name === name && volume.region.slug === region) out.push(volume);
    return out;
  }

  /** The volume's action that is still running, if any. */
  protected async running(id: string, signal: AbortSignal): Promise<DoAction | undefined> {
    for await (const action of this.client.pages<DoAction>(
      `/volumes/${encodeURIComponent(id)}/actions`,
      'actions',
      { signal, budget: 'observe' },
    ))
      if (action.status === 'in-progress') return action;
    return undefined;
  }

  /** Starts a volume action and returns it (DO answers 202 with it `in-progress`). */
  protected async act(
    volume: DoVolume,
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<DoAction | undefined> {
    const reply = await this.client.request<{ action?: DoAction }>(
      'POST',
      `/volumes/${encodeURIComponent(volume.id)}/actions`,
      { body: { ...body, region: volume.region.slug }, signal, budget: 'mutate' },
    );
    this.log.info('digitalocean.volumeAction', {
      volume: volume.id,
      type: String(body.type),
      action: reply.action?.id,
    });
    return reply.action;
  }

  // ------------------------------------------------------------------------------- ensure, get

  /** Refuses what DO would refuse, before any request. */
  protected validate(spec: ProviderVolumeSpec): string[] {
    if (spec.kind !== 'block')
      throw fail(
        'INVALID_INPUT',
        `volume kind ${String(spec.kind)} is not block or shared`,
        'kind',
      );
    if (!this.config.regions.includes(spec.region))
      throw fail('INVALID_INPUT', `region ${spec.region} is not one this account uses`, 'region');
    if (!volumeNamePattern.test(spec.name))
      throw fail(
        'INVALID_INPUT',
        `${JSON.stringify(spec.name)} is not a DigitalOcean volume name: a lower-case letter, then [a-z0-9-], at most 64 characters`,
        'name',
      );
    if (!Number.isInteger(spec.sizeGiB) || spec.sizeGiB < 1 || spec.sizeGiB > maxVolumeGiB)
      throw fail(
        'INVALID_INPUT',
        `a DigitalOcean volume is 1 to ${maxVolumeGiB} whole GiB, not ${spec.sizeGiB}`,
        'size',
      );
    if (spec.filesystem !== undefined && !['ext4', 'xfs', 'none'].includes(spec.filesystem))
      throw fail(
        'INVALID_INPUT',
        `filesystem ${spec.filesystem} is not ext4, xfs or none`,
        'filesystem',
      );
    if (spec.snapshotId !== undefined && !uuidPattern.test(spec.snapshotId))
      throw fail(
        'INVALID_INPUT',
        `${JSON.stringify(spec.snapshotId)} is not a DigitalOcean snapshot id`,
        'snapshotId',
      );
    return [managedTag, this.deploymentTag, ...labelTags(spec.labels)];
  }

  /** The volume `found` names for `spec`: ours, and formatted as the spec asks, or refused. */
  protected matching(spec: ProviderVolumeSpec, found: DoVolume): ProviderResourceState {
    if (!this.owned(found.tags))
      throw fail(
        'CONFLICT',
        `a volume named ${spec.name} in ${spec.region} exists and is not managed by this better-compute deployment`,
        'nameTaken',
      );
    const wanted = spec.filesystem === 'none' ? '' : (spec.filesystem ?? '');
    if ((found.filesystem_type ?? '') !== wanted)
      throw fail(
        'INVALID_STATE',
        `volume ${found.id} is formatted ${found.filesystem_type || 'raw'}, not ${wanted || 'raw'}; a filesystem is not changed in place`,
        'filesystem',
      );
    return state(found.id, 'ready', volumeOutputs(found));
  }

  async ensureVolume(spec: ProviderVolumeSpec, ctx: CallContext): Promise<ProviderResourceState> {
    if (spec.kind === 'shared') return this.shares.ensure(spec, ctx);
    const tags = this.validate(spec);
    const { signal } = ctx;
    const [existing] = await this.byName(spec.name, spec.region, signal);
    if (existing) return this.matching(spec, existing);
    let created: DoVolume | undefined;
    try {
      const reply = await this.client.request<{ volume?: DoVolume }>('POST', '/volumes', {
        body: {
          name: spec.name,
          region: spec.region,
          size_gigabytes: spec.sizeGiB,
          description: 'better-compute volume',
          ...(spec.filesystem !== undefined && spec.filesystem !== 'none'
            ? { filesystem_type: spec.filesystem }
            : {}),
          ...(spec.snapshotId !== undefined ? { snapshot_id: spec.snapshotId } : {}),
          tags: [...new Set(tags)],
        },
        signal,
        budget: 'mutate',
      });
      created = reply.volume;
    } catch (error) {
      // A racing create of the same name won, or an answer that never arrived may have created
      // the volume: read it before failing.
      if (!isComputeError(error, 'CONFLICT') && !isComputeError(error, 'UNAVAILABLE')) throw error;
      const [landed] = await this.byName(spec.name, spec.region, signal);
      if (!landed) throw error;
      return this.matching(spec, landed);
    }
    if (!created)
      throw new ComputeError(
        'PROVIDER_ERROR',
        'DigitalOcean accepted a volume create but returned no volume',
        undefined,
        { provider: 'digitalocean', reason: 'badBody' },
      );
    return state(created.id, 'ready', volumeOutputs(created));
  }

  async findVolume(
    name: string,
    region: string,
    ctx: CallContext,
    kind?: ProviderVolumeSpec['kind'],
  ): Promise<ProviderResourceState | undefined> {
    if (kind === 'shared') return this.shares.find(name, region, ctx);
    if (!volumeNamePattern.test(name) || !this.config.regions.includes(region)) return undefined;
    const found = (await this.byName(name, region, ctx.signal)).find((volume) => this.owned(volume.tags));
    return found ? state(found.id, 'ready', volumeOutputs(found)) : undefined;
  }

  async getVolume(id: string, ctx: CallContext): Promise<ProviderResourceState | undefined> {
    if (isShareId(id)) return this.shares.get(id, ctx);
    if (!uuidPattern.test(id)) return undefined;
    const volume = await this.volume(id.toLowerCase(), ctx.signal);
    return volume ? state(volume.id, 'ready', volumeOutputs(volume)) : undefined;
  }

  /**
   * Of `ids`, the volumes a Droplet's selective destroy may name (DO-D16): each exists, is ours (managed and this
   * deployment's) and is attached to `dropletId`. Anything else (a tenant's own volume attached by hand, one of ours on
   * another Droplet, a malformed id) is left out, and survives the Droplet.
   */
  async deletableWith(
    ids: readonly string[],
    dropletId: number,
    signal: AbortSignal,
  ): Promise<string[]> {
    const out: string[] = [];
    for (const raw of new Set(ids)) {
      if (!uuidPattern.test(raw)) continue;
      const volume = await this.volume(raw.toLowerCase(), signal);
      if (!volume || !this.owned(volume.tags) || !(volume.droplet_ids ?? []).includes(dropletId)) {
        if (volume)
          this.log.warn('digitalocean.selectiveDestroySkipped', { volume: volume.id, droplet: dropletId });
        continue;
      }
      if (!out.includes(volume.id)) out.push(volume.id);
    }
    return out;
  }

  // ----------------------------------------------------------------------- attach and detach

  /** The Droplet a volume attaches to: in the volume's region and an instance's of this deployment. */
  protected async target(
    machineId: string,
    volume: DoVolume,
    instanceId: string | undefined,
    signal: AbortSignal,
  ): Promise<DoDroplet> {
    const dropletId = parseMachineId(machineId);
    let droplet: DoDroplet;
    try {
      droplet = (
        await this.client.request<{ droplet: DoDroplet }>('GET', `/droplets/${dropletId}`, {
          signal,
          budget: 'observe',
        })
      ).droplet;
    } catch (error) {
      if (isComputeError(error, 'NOT_FOUND'))
        throw fail('NOT_FOUND', `Droplet ${dropletId} does not exist`, 'machine');
      throw error;
    }
    if (droplet.region.slug !== volume.region.slug)
      throw fail(
        'INVALID_INPUT',
        `volume ${volume.id} is in ${volume.region.slug} and Droplet ${droplet.id} in ${droplet.region.slug}: a volume attaches only in its region`,
        'region',
      );
    const tags = droplet.tags ?? [];
    const instanceOf =
      instanceId === undefined
        ? tags.some((t) => t.toLowerCase().startsWith(instanceTagPrefix))
        : carries(tags, tagFor(labels.instance, instanceId));
    if (!carries(tags, this.deploymentTag) || !instanceOf)
      throw fail(
        'INVALID_STATE',
        instanceId === undefined
          ? `Droplet ${droplet.id} does not belong to an instance of this better-compute deployment`
          : `Droplet ${droplet.id} does not belong to instance ${instanceId}`,
        'notInstance',
      );
    return droplet;
  }

  async attachVolume(
    volumeId: string,
    machineId: string,
    ctx: CallContext,
    instanceId?: string,
  ): Promise<ProviderResourceState> {
    if (isShareId(volumeId)) return this.shares.attach(volumeId, machineId, ctx, instanceId);
    const id = parseVolumeId(volumeId);
    const dropletId = parseMachineId(machineId);
    const { signal } = ctx;
    const volume = await this.ours(id, signal);
    if (volume.droplet_ids.includes(dropletId))
      return state(volume.id, 'ready', volumeOutputs(volume));
    if (volume.droplet_ids.length > 0)
      throw fail(
        'CONFLICT',
        `volume ${volume.id} is attached to Droplet ${volume.droplet_ids[0]}; detach it first`,
        'attachedElsewhere',
      );
    await this.target(machineId, volume, instanceId, signal);
    if (await this.running(volume.id, signal))
      return state(volume.id, 'pending', volumeOutputs(volume));
    const action = await this.act(volume, { type: 'attach', droplet_id: dropletId }, signal);
    return this.after(volume, action, 'pending', signal);
  }

  async detachVolume(
    volumeId: string,
    machineId: string,
    ctx: CallContext,
  ): Promise<ProviderResourceState> {
    if (isShareId(volumeId)) return this.shares.detach(volumeId, machineId, ctx);
    const id = parseVolumeId(volumeId);
    const dropletId = parseMachineId(machineId);
    const { signal } = ctx;
    const volume = await this.volume(id, signal);
    if (!volume) return state(id, 'deleted');
    if (!(volume.droplet_ids ?? []).includes(dropletId)) {
      // An attach still running would attach it after this call said it was detached.
      if (this.owned(volume.tags) && (await this.running(volume.id, signal)))
        return state(volume.id, 'deleting', volumeOutputs(volume));
      return state(volume.id, 'deleted');
    }
    this.refuseForeign(volume);
    if (await this.running(volume.id, signal))
      return state(volume.id, 'deleting', volumeOutputs(volume));
    const action = await this.act(volume, { type: 'detach', droplet_id: dropletId }, signal);
    const after = await this.after(volume, action, 'deleting', signal);
    return after.state === 'ready' ? state(volume.id, 'deleted') : after;
  }

  /**
   * What a call that started `action` reports: `ready` once the action completed (the volume is
   * read again for its outputs), `error` when DO says it errored, else `busy`.
   */
  protected async after(
    volume: DoVolume,
    action: DoAction | undefined,
    busy: 'pending' | 'updating' | 'deleting',
    signal: AbortSignal,
  ): Promise<ProviderResourceState> {
    if (action?.status === 'errored')
      return state(
        volume.id,
        'error',
        volumeOutputs(volume),
        `DigitalOcean's ${action.type} action on volume ${volume.id} errored; the next call tries again`,
      );
    if (action?.status !== 'completed') return state(volume.id, busy, volumeOutputs(volume));
    const fresh = await this.volume(volume.id, signal);
    if (!fresh) return state(volume.id, 'deleted');
    return state(fresh.id, 'ready', volumeOutputs(fresh));
  }

  // ----------------------------------------------------------------------- resize and delete

  async resizeVolume(
    volumeId: string,
    sizeGiB: number,
    ctx: CallContext,
  ): Promise<ProviderResourceState> {
    if (isShareId(volumeId)) return this.shares.resize(volumeId, sizeGiB, ctx);
    const id = parseVolumeId(volumeId);
    if (!Number.isInteger(sizeGiB) || sizeGiB < 1 || sizeGiB > maxVolumeGiB)
      throw fail(
        'INVALID_INPUT',
        `a DigitalOcean volume is 1 to ${maxVolumeGiB} whole GiB, not ${sizeGiB}`,
        'size',
      );
    const { signal } = ctx;
    const volume = await this.ours(id, signal);
    if (sizeGiB < volume.size_gigabytes)
      throw fail(
        'INVALID_INPUT',
        `volume ${volume.id} is ${volume.size_gigabytes} GiB; a volume only grows`,
        'shrink',
      );
    const busy = await this.running(volume.id, signal);
    if (busy) return state(volume.id, 'updating', volumeOutputs(volume));
    if (sizeGiB === volume.size_gigabytes) return state(volume.id, 'ready', volumeOutputs(volume));
    const action = await this.act(volume, { type: 'resize', size_gigabytes: sizeGiB }, signal);
    return this.after(volume, action, 'updating', signal);
  }

  async deleteVolume(volumeId: string, ctx: CallContext): Promise<ProviderResourceState> {
    if (isShareId(volumeId)) return this.shares.delete(volumeId, ctx);
    const id = parseVolumeId(volumeId);
    const { signal } = ctx;
    const volume = await this.volume(id, signal);
    if (!volume) return state(id, 'deleted');
    this.refuseForeign(volume);
    if (volume.droplet_ids.length > 0)
      throw fail(
        'INVALID_STATE',
        `volume ${volume.id} is attached to Droplet ${volume.droplet_ids[0]}; detach it first`,
        'attached',
      );
    try {
      await this.client.request('DELETE', `/volumes/${encodeURIComponent(volume.id)}`, {
        signal,
        budget: 'mutate',
      });
    } catch (error) {
      if (!isComputeError(error, 'NOT_FOUND')) throw error;
    }
    return state(volume.id, 'deleted');
  }

  // -------------------------------------------------------------------------------- snapshots

  /** The snapshot, or undefined when it does not exist. */
  protected async snapshot(id: string, signal: AbortSignal): Promise<DoSnapshot | undefined> {
    try {
      const reply = await this.client.request<{ snapshot: DoSnapshot }>(
        'GET',
        `/snapshots/${encodeURIComponent(id)}`,
        { signal, budget: 'observe' },
      );
      return reply.snapshot;
    } catch (error) {
      if (isComputeError(error, 'NOT_FOUND')) return undefined;
      throw error;
    }
  }

  /** The volume's snapshots named `name`, oldest first. */
  protected async snapshotsNamed(
    volumeId: string,
    name: string,
    signal: AbortSignal,
  ): Promise<DoSnapshot[]> {
    const out: DoSnapshot[] = [];
    for await (const snapshot of this.client.pages<DoSnapshot>(
      `/volumes/${encodeURIComponent(volumeId)}/snapshots`,
      'snapshots',
      { signal, budget: 'observe' },
    ))
      if (snapshot.name === name) out.push(snapshot);
    return out.sort(snapshotsByAge);
  }

  /**
   * One snapshot of the name: ours, the oldest of ours, with any later ones of ours (a racing
   * snapshot call) deleted. DO does not keep snapshot names unique, so a name taken by a snapshot
   * that is not ours is `CONFLICT`.
   */
  protected async converge(
    name: string,
    found: DoSnapshot[],
    signal: AbortSignal,
  ): Promise<DoSnapshot | undefined> {
    if (found.some((s) => !this.owned(s.tags)))
      throw fail(
        'CONFLICT',
        `a snapshot named ${name} of this volume exists and is not managed by this better-compute deployment`,
        'nameTaken',
      );
    const [oldest, ...others] = found;
    for (const duplicate of others) {
      this.log.info('digitalocean.duplicateSnapshotReaped', {
        kept: oldest!.id,
        deleted: duplicate.id,
      });
      await this.destroySnapshot(duplicate.id, signal);
    }
    return oldest;
  }

  protected async destroySnapshot(id: string, signal: AbortSignal): Promise<void> {
    try {
      await this.client.request('DELETE', `/snapshots/${encodeURIComponent(id)}`, {
        signal,
        budget: 'mutate',
      });
    } catch (error) {
      if (!isComputeError(error, 'NOT_FOUND')) throw error;
    }
  }

  async snapshotVolume(
    volumeId: string,
    name: string,
    ctx: CallContext,
  ): Promise<ProviderResourceState> {
    const id = parseVolumeId(volumeId);
    if (!snapshotNamePattern.test(name))
      throw fail(
        'INVALID_INPUT',
        `${JSON.stringify(name)} is not a snapshot name: a letter or digit, then [a-zA-Z0-9._-], at most 255 characters`,
        'name',
      );
    const { signal } = ctx;
    const volume = await this.ours(id, signal);
    const existing = await this.converge(
      name,
      await this.snapshotsNamed(volume.id, name, signal),
      signal,
    );
    if (existing) return state(existing.id, 'ready', snapshotOutputs(existing));
    let created: DoSnapshot | undefined;
    try {
      const reply = await this.client.request<{ snapshot?: DoSnapshot }>(
        'POST',
        `/volumes/${encodeURIComponent(volume.id)}/snapshots`,
        { body: { name, tags: [managedTag, this.deploymentTag] }, signal, budget: 'mutate' },
      );
      created = reply.snapshot;
    } catch (error) {
      if (!isComputeError(error, 'UNAVAILABLE')) throw error;
    }
    // A racing call may have taken one too, and an answer that never arrived may have landed.
    const found = await this.snapshotsNamed(volume.id, name, signal);
    if (created && !found.some((s) => s.id === created.id)) found.push(created);
    const kept = await this.converge(name, found.sort(snapshotsByAge), signal);
    if (!kept)
      throw new ComputeError(
        'UNAVAILABLE',
        `DigitalOcean did not confirm the snapshot ${name} of volume ${volume.id}; the next call tries again`,
        undefined,
        { provider: 'digitalocean', reason: 'snapshotUnconfirmed' },
      );
    return state(kept.id, 'ready', snapshotOutputs(kept));
  }

  async getSnapshot(id: string, ctx: CallContext): Promise<ProviderResourceState | undefined> {
    if (!uuidPattern.test(id)) return undefined;
    const snapshot = await this.snapshot(id.toLowerCase(), ctx.signal);
    if (!snapshot || snapshot.resource_type !== 'volume') return undefined;
    return state(snapshot.id, 'ready', snapshotOutputs(snapshot));
  }

  async deleteSnapshot(snapshotId: string, ctx: CallContext): Promise<ProviderResourceState> {
    if (!uuidPattern.test(snapshotId))
      throw fail(
        'INVALID_INPUT',
        `${JSON.stringify(snapshotId)} is not a DigitalOcean volume snapshot id`,
        'snapshotId',
      );
    const id = snapshotId.toLowerCase();
    const snapshot = await this.snapshot(id, ctx.signal);
    if (!snapshot) return state(id, 'deleted');
    if (snapshot.resource_type !== 'volume' || !this.owned(snapshot.tags))
      throw fail(
        'INVALID_STATE',
        `snapshot ${snapshot.id} is not a volume snapshot managed by this better-compute deployment and is never deleted by it`,
        'notManaged',
      );
    await this.destroySnapshot(snapshot.id, ctx.signal);
    return state(snapshot.id, 'deleted');
  }
}
