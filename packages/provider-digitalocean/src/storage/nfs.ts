import { createHash } from 'node:crypto';
import {
  ComputeError,
  isComputeError,
  type CallContext,
  type Logger,
  type ProviderResourceState,
  type ProviderVolumeSpec,
} from '@better-compute/core';
import type { DoClient } from '../client/http.js';
import { assignTag, hasTag, spelled, unassignTag } from '../compute/tags.js';
import type { DoDroplet } from '../compute/types.js';
import type { DoConfig } from '../config.js';
import { deploymentTag, labels, parseMachineId, tagFor } from '../ids.js';
import { networkOfVpc, vpcForNetwork, vpcLookup } from '../networks/vpcs.js';
import type { DoShare, DoShareAction, DoShareSnapshot } from './types.js';

// Network File Storage shares as `kind: 'shared'` provider volumes (P6). The API's shapes are
// unverified (the nfs fixture's provenance says why), so the provider reads only the fields it
// needs and fails closed on the rest.
//
// Ownership. Shares carry no tags (as far as the reference shows), so a share of ours is one whose
// name is the vps name plus `-` and the deployment's 12-hex hash (`shareName`): the same hash
// the deployment tag carries, and the same trust (anyone on the account can forge either). Every
// call but `ensureVolume` and `getVolume` refuses any other share (`INVALID_STATE`, `notManaged`),
// so better-compute never resizes, attaches or deletes a share it did not make.
//
// Reachability. An NFS share is reached over a VPC, and VPC membership is its only access
// control, so a share is created in its tenant network's VPC in the region (`spec.network`,
// required) and never in a region's default VPC or a VPC that is not a better-compute network's.
//
// Attachments. A share is attached to many machines at once, and DO keeps no record of which: the
// VPCs it is reachable from are all it knows. Attaching a share to a Droplet (an instance of this
// deployment, in the share's region) tags the Droplet `bc-nfs-<16 hex>` (`shareTag`), the
// stateless record of who has it, and attaches the Droplet's VPC to the share when it is not
// there yet. That VPC must be a better-compute network's (never a default or hand-made VPC) and
// of the same network as the share's VPCs. Detaching untags the Droplet and takes its VPC off the
// share once no tagged Droplet is left in it; the share's last VPC, its home in the tenant
// network, stays. A detach of a Droplet that is gone (its tag went with it) takes off every VPC no tagged Droplet is
// in (`prune`). A share some Droplet still carries the tag of is not deleted; a deleted share's tag goes with it.
//
// Ids. Every share call names the region (`?region=`), so a share's provider id is
// `nfs:<region>:<uuid>`; nothing else in the provider has that shape, which is how `DoVolumes`
// tells shares from block volumes. A share DO answers with whose id is not a UUID, or that is in
// another region, is `PROVIDER_ERROR` (`badBody`): never an id vps would store and fail on later.
//
// Duplicates. Whether DO refuses a second share of a name in a region is unverified, so `ensure`
// and `find` keep the oldest share of the name (then the lowest id) and delete each younger one no
// Droplet carries the tag of (`digitalocean.duplicateShareReaped`); a create lists again after it,
// so one that raced an earlier create whose answer was lost gives way to the older share.
//
// Actions (resize, snapshot, attach, detach) answer with an action that has no id and no list to
// poll. No state outlives a call (ruling R4): a call reads the share and acts on what it sees; DO
// refuses a second action while one runs (the `pending event` 422, CONFLICT `actionPending`),
// which the call reports as still busy.

/** DO's smallest share, in GiB (unverified). */
export const minShareGiB = 50;
/** DO's largest share, in GiB. */
export const maxShareGiB = 16_384;
const vpsNamePattern = /^[a-z][a-z0-9-]{0,63}$/;
const maxShareName = 64;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const regionPattern = /^[a-z][a-z0-9]{0,15}$/;
const sharePrefix = 'nfs:';
const snapshotNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/;
const maxSnapshotName = 255;

/** Oldest first by `created_at`, then by id: the order in which one of several resources of a name survives. */
function byAge(
  a: { created_at: string; id: string },
  b: { created_at: string; id: string },
): number {
  const at = Date.parse(a.created_at) - Date.parse(b.created_at);
  return Number.isFinite(at) && at !== 0 ? at : String(a.id).localeCompare(String(b.id));
}

function fail(
  code: 'INVALID_INPUT' | 'INVALID_STATE' | 'UNSUPPORTED' | 'CONFLICT' | 'NOT_FOUND',
  message: string,
  reason: string,
): ComputeError {
  return new ComputeError(code, message, undefined, { provider: 'digitalocean', reason });
}

function deploymentHash(deployment: string): string {
  return createHash('sha256').update(deployment).digest('hex').slice(0, 12);
}

/** What a share name leaves for the vps name: all but `-<12 hex>` of the deployment. */
const vpsNameRoom = 64 - 13;

/**
 * The provider name of the share vps names `name`, for this deployment. A vps name longer than a share name leaves
 * room for (vps names a volume `bc-<id>`, 60 characters) keeps its first 38 characters and gains 12 hex of its own
 * hash, so it stays distinct, and the same on every call.
 */
export function shareName(name: string, deployment: string): string {
  const fitted =
    name.length <= vpsNameRoom
      ? name
      : `${name.slice(0, vpsNameRoom - 13)}-${createHash('sha256').update(name).digest('hex').slice(0, 12)}`;
  return `${fitted}-${deploymentHash(deployment)}`;
}

/** The Droplet tag that records a Droplet has the share attached: `bc-nfs-<16 hex>`. */
export function shareTag(uuid: string): string {
  return `bc-nfs-${createHash('sha256').update(uuid.toLowerCase()).digest('hex').slice(0, 16)}`;
}

/** A share's provider id: `nfs:<region>:<uuid>`. */
export function shareId(region: string, uuid: string): string {
  return `${sharePrefix}${region}:${uuid.toLowerCase()}`;
}

/** Whether a provider volume id names a share (`nfs:`), well formed or not. */
export function isShareId(id: string): boolean {
  return id.startsWith(sharePrefix);
}

/** The region and uuid of a share id; undefined when it is not one. */
export function parseShareId(id: string): { region: string; uuid: string } | undefined {
  if (!isShareId(id)) return undefined;
  const [region, uuid, ...rest] = id.slice(sharePrefix.length).split(':');
  if (rest.length > 0 || !region || !uuid) return undefined;
  if (!regionPattern.test(region) || !uuidPattern.test(uuid)) return undefined;
  return { region, uuid: uuid.toLowerCase() };
}

const snapshotPrefix = 'nfssnap:';

/** A share snapshot's provider id: `nfssnap:<region>:<uuid>`. */
export function shareSnapshotId(region: string, uuid: string): string {
  return `${snapshotPrefix}${region}:${uuid.toLowerCase()}`;
}

/** Whether a provider snapshot id names a share snapshot (`nfssnap:`), well formed or not. */
export function isShareSnapshotId(id: string): boolean {
  return id.startsWith(snapshotPrefix);
}

/** The region and uuid of a share snapshot id; undefined when it is not one. */
export function parseShareSnapshotId(id: string): { region: string; uuid: string } | undefined {
  return isShareSnapshotId(id)
    ? parseShareId(`${sharePrefix}${id.slice(snapshotPrefix.length)}`)
    : undefined;
}

/**
 * What a mount source may hold: an IPv4 address or host name (labels that start and end alphanumeric, the grammar
 * vps's `sharedVolumeMount` reads), and an absolute export path with no empty, `.` or `..` segment.
 */
const hostPattern =
  /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const mountPathPattern = /^\/[A-Za-z0-9._/-]{0,254}$/;

function plainMountPath(path: string): boolean {
  if (!mountPathPattern.test(path)) return false;
  if (path === '/') return true;
  return path
    .slice(1)
    .split('/')
    .every((segment) => segment !== '' && segment !== '.' && segment !== '..');
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

/**
 * A share's outputs (plain values only). The mount source appears once DO gives one, and only
 * when it is plainly an address and a path: it ends up in a guest's mount line, so a value with
 * anything else in it is left out, never passed on.
 */
export function shareOutputs(share: DoShare): Record<string, string> {
  const host =
    typeof share.host === 'string' && hostPattern.test(share.host) ? share.host : undefined;
  const path =
    typeof share.mount_path === 'string' && plainMountPath(share.mount_path)
      ? share.mount_path
      : undefined;
  return {
    kind: 'shared',
    region: share.region,
    sizeGiB: String(share.size_gib),
    filesystem: 'nfs',
    ...(host !== undefined ? { host } : {}),
    ...(path !== undefined ? { mountPath: path } : {}),
    ...(host !== undefined && path !== undefined ? { device: `${host}:${path}` } : {}),
    ...((share.vpc_ids ?? []).length > 0 ? { vpcs: [...(share.vpc_ids ?? [])].join(',') } : {}),
  };
}

/** The contract state of a share, by its status. */
function shareState(share: DoShare, outputs = shareOutputs(share)): ProviderResourceState {
  const id = shareId(share.region, share.id);
  switch (share.status) {
    case 'ACTIVE':
      return state(id, 'ready', outputs);
    case 'CREATING':
      return state(id, 'pending', outputs);
    case 'DELETED':
      return state(id, 'deleted');
    case 'FAILED':
      return state(id, 'error', outputs, `DigitalOcean reports share ${share.id} failed`);
    default:
      // A status this provider does not know: busy, never ready.
      return state(id, 'pending', outputs);
  }
}

export class DoShares {
  protected readonly client: DoClient;
  protected readonly config: DoConfig;
  protected readonly log: Logger;
  protected readonly deployment: string;
  protected readonly suffix: string;
  protected readonly deploymentTag: string;

  constructor(client: DoClient, config: DoConfig, deployment: string, log: Logger) {
    this.client = client;
    this.config = config;
    this.log = log;
    this.deployment = deployment;
    this.suffix = `-${deploymentHash(deployment)}`;
    this.deploymentTag = deploymentTag(deployment);
  }

  /** Whether better-compute may act on the share: its name carries this deployment's hash. */
  protected owned(share: DoShare): boolean {
    return (
      typeof share.name === 'string' &&
      share.name.endsWith(this.suffix) &&
      vpsNamePattern.test(share.name.slice(0, -this.suffix.length))
    );
  }

  protected refuseForeign(share: DoShare): void {
    if (!this.owned(share))
      throw fail(
        'INVALID_STATE',
        `share ${share.id} is not managed by this better-compute deployment and is never changed by it`,
        'notManaged',
      );
  }

  /** The share, or undefined when it does not exist. */
  protected async share(
    ref: { region: string; uuid: string },
    signal: AbortSignal,
  ): Promise<DoShare | undefined> {
    try {
      const reply = await this.client.request<{ share: DoShare }>(
        'GET',
        `/nfs/${encodeURIComponent(ref.uuid)}`,
        { query: { region: ref.region }, signal, budget: 'observe' },
      );
      return reply.share?.status === 'DELETED' ? undefined : reply.share;
    } catch (error) {
      if (isComputeError(error, 'NOT_FOUND')) return undefined;
      throw error;
    }
  }

  /** A share id as the contract calls give it; anything else is `INVALID_INPUT`. */
  protected parse(id: string): { region: string; uuid: string } {
    const ref = parseShareId(id);
    if (!ref)
      throw fail(
        'INVALID_INPUT',
        `${JSON.stringify(id)} is not a DigitalOcean share id`,
        'volumeId',
      );
    return ref;
  }

  /** The share to act on: it must exist and be ours. */
  protected async ours(id: string, signal: AbortSignal): Promise<DoShare> {
    const ref = this.parse(id);
    const share = await this.share(ref, signal);
    if (!share)
      throw new ComputeError('NOT_FOUND', `share ${id} does not exist`, undefined, {
        provider: 'digitalocean',
        id,
      });
    this.refuseForeign(share);
    return share;
  }

  /**
   * A share DO answered with must have a UUID id and be in the region asked for: its provider id (`shareId`) is
   * stored by vps, and an id `parseShareId` refuses would make every later call on it fail while the share leaks.
   * Anything else is `PROVIDER_ERROR` (`badBody`), never an id.
   */
  protected wellFormed(share: DoShare, region: string): DoShare {
    if (typeof share.id !== 'string' || !uuidPattern.test(share.id) || share.region !== region)
      throw new ComputeError(
        'PROVIDER_ERROR',
        `DigitalOcean answered with a share that is not a share in ${region} (its id or region has an unexpected shape)`,
        undefined,
        { provider: 'digitalocean', reason: 'badBody' },
      );
    return share;
  }

  /**
   * The shares named `name` in `region`, oldest first (then by id). DO refusing a second share of a name is
   * unverified (D1/D2), so there may be more than one; `survivor` keeps the oldest.
   */
  protected async byName(name: string, region: string, signal: AbortSignal): Promise<DoShare[]> {
    const out: DoShare[] = [];
    for await (const share of this.client.pages<DoShare>('/nfs', 'shares', {
      query: { region },
      signal,
      budget: 'observe',
    }))
      if (share.name === name && share.region === region && share.status !== 'DELETED')
        out.push(this.wellFormed(share, region));
    return out.sort(byAge);
  }

  /**
   * The oldest of the shares of one name (all ours by name), and exactly one survivor: each younger one (a create
   * retried after an answer was lost while the list lagged) is deleted, unless some Droplet carries its tag (then it
   * stays, logged, for an operator: it may hold data). A duplicate that is busy is left for the next call.
   */
  protected async survivor(found: DoShare[], signal: AbortSignal): Promise<DoShare | undefined> {
    const [oldest, ...others] = [...found].sort(byAge);
    for (const duplicate of others) {
      if (!this.owned(duplicate)) continue;
      const fields = { kept: oldest!.id, deleted: duplicate.id, region: duplicate.region };
      if ((await this.holders(duplicate, signal)).length > 0) {
        this.log.warn('digitalocean.duplicateShareHeld', {
          kept: oldest!.id,
          held: duplicate.id,
          region: duplicate.region,
        });
        continue;
      }
      try {
        await this.client.request('DELETE', `/nfs/${encodeURIComponent(duplicate.id)}`, {
          query: { region: duplicate.region },
          signal,
          budget: 'mutate',
        });
      } catch (error) {
        if (isComputeError(error, 'CONFLICT') && error.details?.reason === 'actionPending') {
          this.log.warn('digitalocean.duplicateShareBusy', fields);
          continue;
        }
        if (!isComputeError(error, 'NOT_FOUND')) throw error;
      }
      this.log.info('digitalocean.duplicateShareReaped', fields);
      await this.dropTag(duplicate.id, signal);
    }
    return oldest;
  }

  /**
   * Starts a share action. DO's refusal while another action runs is reported as `undefined`
   * (the caller says it is still busy); any other refusal propagates.
   */
  protected async act(
    share: DoShare,
    type: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<DoShareAction | 'busy'> {
    try {
      const reply = await this.client.request<{ action?: DoShareAction }>(
        'POST',
        `/nfs/${encodeURIComponent(share.id)}/actions`,
        { body: { type, region: share.region, params }, signal, budget: 'mutate' },
      );
      this.log.info('digitalocean.shareAction', { share: share.id, type });
      return reply.action ?? { status: 'in-progress', type };
    } catch (error) {
      if (isComputeError(error, 'CONFLICT') && error.details?.reason === 'actionPending')
        return 'busy';
      throw error;
    }
  }

  /**
   * What a call that started `action` reports: the share read again once it completed, `error`
   * when DO says it errored, else `busy`.
   */
  protected async after(
    share: DoShare,
    action: DoShareAction | 'busy',
    busy: 'pending' | 'updating' | 'deleting',
    signal: AbortSignal,
  ): Promise<ProviderResourceState> {
    const id = shareId(share.region, share.id);
    if (action !== 'busy' && action.status === 'errored')
      return state(
        id,
        'error',
        shareOutputs(share),
        `DigitalOcean's ${action.type} action on share ${share.id} errored; the next call tries again`,
      );
    if (action === 'busy' || action.status !== 'completed')
      return state(id, busy, shareOutputs(share));
    const fresh = await this.share({ region: share.region, uuid: share.id }, signal);
    if (!fresh) return state(id, 'deleted');
    return shareState(fresh);
  }

  // ------------------------------------------------------------------------------- ensure, get

  /** Refuses what DO would refuse, and a share without a network, before any request. */
  protected validate(spec: ProviderVolumeSpec): string {
    if (!this.config.regions.includes(spec.region))
      throw fail('INVALID_INPUT', `region ${spec.region} is not one this account uses`, 'region');
    const name = vpsNamePattern.test(spec.name) ? shareName(spec.name, this.deployment) : '';
    if (name === '' || name.length > maxShareName)
      throw fail(
        'INVALID_INPUT',
        `${JSON.stringify(spec.name)} is not a share name: a lower-case letter, then [a-z0-9-], at most 64 characters`,
        'name',
      );
    if (!Number.isInteger(spec.sizeGiB) || spec.sizeGiB < minShareGiB || spec.sizeGiB > maxShareGiB)
      throw fail(
        'INVALID_INPUT',
        `a DigitalOcean share is ${minShareGiB} to ${maxShareGiB} whole GiB, not ${spec.sizeGiB}`,
        'size',
      );
    if (spec.filesystem !== undefined && spec.filesystem !== 'none')
      throw fail(
        'INVALID_INPUT',
        `a share is a network filesystem; it is not formatted ${spec.filesystem}`,
        'filesystem',
      );
    if (spec.snapshotId !== undefined)
      throw fail(
        'UNSUPPORTED',
        'a DigitalOcean share is not created from a snapshot',
        'sharedRestore',
      );
    if (
      spec.network === undefined ||
      typeof spec.network.network !== 'string' ||
      !spec.network.network
    )
      throw fail(
        'INVALID_INPUT',
        'a DigitalOcean share is reached over a VPC: it names the tenant network it is reachable from',
        'network',
      );
    return name;
  }

  /** What `ensure` refuses before any request, with no request. */
  check(spec: ProviderVolumeSpec): void {
    this.validate(spec);
  }

  async ensure(spec: ProviderVolumeSpec, ctx: CallContext): Promise<ProviderResourceState> {
    const name = this.validate(spec);
    const { signal } = ctx;
    const existing = await this.survivor(await this.byName(name, spec.region, signal), signal);
    if (existing) return shareState(existing);
    // The network's VPC in the region: never a default VPC, never another network's.
    const vpc = await vpcForNetwork(this.client, spec.network!, spec.region, signal);
    let created: DoShare | undefined;
    try {
      const reply = await this.client.request<{ share?: DoShare }>('POST', '/nfs', {
        body: { name, region: spec.region, size_gib: spec.sizeGiB, vpc_ids: [vpc.id] },
        signal,
        budget: 'mutate',
      });
      created = reply.share;
    } catch (error) {
      // A racing create of the same name won, or an answer that never arrived may have made it.
      if (!isComputeError(error, 'CONFLICT') && !isComputeError(error, 'UNAVAILABLE')) throw error;
      const landed = await this.survivor(await this.byName(name, spec.region, signal), signal);
      if (!landed) throw error;
      return shareState(landed);
    }
    if (!created || created.name !== name)
      throw new ComputeError(
        'PROVIDER_ERROR',
        'DigitalOcean accepted a share create but returned no share',
        undefined,
        { provider: 'digitalocean', reason: 'badBody' },
      );
    this.wellFormed(created, spec.region);
    this.log.info('digitalocean.shareCreated', { share: created.id, region: created.region });
    // An earlier create whose answer was lost may have made a share of the name the list above did not show yet: the
    // oldest survives, and the one just made (no Droplet has it yet) goes. The list may not show this one yet either.
    const listed = await this.byName(name, spec.region, signal);
    const all = listed.some((share) => share.id === created.id) ? listed : [...listed, created];
    return shareState((await this.survivor(all, signal))!);
  }

  async find(
    name: string,
    region: string,
    ctx: CallContext,
  ): Promise<ProviderResourceState | undefined> {
    if (!vpsNamePattern.test(name) || !this.config.regions.includes(region)) return undefined;
    const found = await this.survivor(
      await this.byName(shareName(name, this.deployment), region, ctx.signal),
      ctx.signal,
    );
    return found ? shareState(found) : undefined;
  }

  async get(id: string, ctx: CallContext): Promise<ProviderResourceState | undefined> {
    const ref = parseShareId(id);
    if (!ref) return undefined;
    const share = await this.share(ref, ctx.signal);
    return share ? shareState(share) : undefined;
  }

  // ----------------------------------------------------------------------- resize and delete

  async resize(id: string, sizeGiB: number, ctx: CallContext): Promise<ProviderResourceState> {
    this.parse(id);
    if (!Number.isInteger(sizeGiB) || sizeGiB < minShareGiB || sizeGiB > maxShareGiB)
      throw fail(
        'INVALID_INPUT',
        `a DigitalOcean share is ${minShareGiB} to ${maxShareGiB} whole GiB, not ${sizeGiB}`,
        'size',
      );
    const { signal } = ctx;
    const share = await this.ours(id, signal);
    if (sizeGiB < share.size_gib)
      throw fail(
        'INVALID_INPUT',
        `share ${share.id} is ${share.size_gib} GiB; a share only grows`,
        'shrink',
      );
    if (share.status !== 'ACTIVE') {
      const now = shareState(share);
      return now.state === 'ready' || now.state === 'pending' ? { ...now, state: 'updating' } : now;
    }
    if (sizeGiB === share.size_gib) return shareState(share);
    const action = await this.act(share, 'resize', { size_gib: sizeGiB }, signal);
    return this.after(share, action, 'updating', signal);
  }

  /** Deletes a share of ours that no Droplet has attached. */
  async delete(id: string, ctx: CallContext): Promise<ProviderResourceState> {
    const ref = this.parse(id);
    const { signal } = ctx;
    const share = await this.share(ref, signal);
    if (!share) return state(shareId(ref.region, ref.uuid), 'deleted');
    this.refuseForeign(share);
    const holder = (await this.holders(share, signal))[0]?.id;
    if (holder !== undefined)
      throw fail(
        'INVALID_STATE',
        `share ${share.id} is attached to Droplet ${holder}; detach it first`,
        'attached',
      );
    try {
      await this.client.request('DELETE', `/nfs/${encodeURIComponent(share.id)}`, {
        query: { region: share.region },
        signal,
        budget: 'mutate',
      });
    } catch (error) {
      if (isComputeError(error, 'CONFLICT') && error.details?.reason === 'actionPending')
        return state(shareId(share.region, share.id), 'deleting', shareOutputs(share));
      if (!isComputeError(error, 'NOT_FOUND')) throw error;
    }
    this.log.info('digitalocean.shareDeleted', { share: share.id });
    await this.dropTag(share.id, signal);
    return state(shareId(share.region, share.id), 'deleted');
  }

  /**
   * The share's Droplet tag (`bc-nfs-…`), once the share is gone: no Droplet carries it (a share some Droplet carries
   * the tag of is not deleted). Best effort: a tag left behind holds nothing, so a failure is logged, never thrown.
   */
  protected async dropTag(uuid: string, signal: AbortSignal): Promise<void> {
    const tag = shareTag(uuid);
    try {
      await this.client.request('DELETE', `/tags/${encodeURIComponent(tag)}`, {
        signal,
        budget: 'mutate',
      });
    } catch (error) {
      if (isComputeError(error, 'NOT_FOUND')) return;
      if (signal.aborted) throw error;
      this.log.warn('digitalocean.shareTagLeft', {
        tag,
        code: isComputeError(error) ? error.code : 'unknown',
      });
    }
  }

  // ----------------------------------------------------------------------- attach and detach

  /** The Droplet, or undefined when it does not exist. */
  protected async droplet(dropletId: number, signal: AbortSignal): Promise<DoDroplet | undefined> {
    try {
      const reply = await this.client.request<{ droplet: DoDroplet }>(
        'GET',
        `/droplets/${dropletId}`,
        { signal, budget: 'observe' },
      );
      return reply.droplet;
    } catch (error) {
      if (isComputeError(error, 'NOT_FOUND')) return undefined;
      throw error;
    }
  }

  /**
   * Every Droplet that carries the share's tag, ours or not (a tag put on by hand still counts:
   * it keeps the share, and its VPC, in place). The default list omits GPU Droplets (research
   * S2), so the GPU list is read too and filtered here.
   */
  protected async holders(share: DoShare, signal: AbortSignal): Promise<DoDroplet[]> {
    const tag = shareTag(share.id);
    const out = new Map<number, DoDroplet>();
    const queries: Record<string, string>[] = [{ tag_name: tag }, { type: 'gpus' }];
    for (const query of queries)
      for await (const droplet of this.client.pages<DoDroplet>('/droplets', 'droplets', {
        query,
        signal,
        budget: 'observe',
      }))
        if (hasTag(droplet, tag)) out.set(droplet.id, droplet);
    return [...out.values()];
  }

  async attach(
    id: string,
    machineId: string,
    ctx: CallContext,
    instanceId?: string,
  ): Promise<ProviderResourceState> {
    this.parse(id);
    const dropletId = parseMachineId(machineId);
    const { signal } = ctx;
    const share = await this.ours(id, signal);
    const droplet = await this.droplet(dropletId, signal);
    if (!droplet) throw fail('NOT_FOUND', `Droplet ${dropletId} does not exist`, 'machine');
    if (droplet.region.slug !== share.region)
      throw fail(
        'INVALID_INPUT',
        `share ${share.id} is in ${share.region} and Droplet ${droplet.id} in ${droplet.region.slug}: a share attaches only in its region`,
        'region',
      );
    const instanceOf =
      instanceId === undefined
        ? (droplet.tags ?? []).some((t) => t.toLowerCase().startsWith(`${labels.instance}:`))
        : hasTag(droplet, tagFor(labels.instance, instanceId));
    if (!hasTag(droplet, this.deploymentTag) || !instanceOf)
      throw fail(
        'INVALID_STATE',
        instanceId === undefined
          ? `Droplet ${droplet.id} does not belong to an instance of this better-compute deployment`
          : `Droplet ${droplet.id} does not belong to instance ${instanceId}`,
        'notInstance',
      );
    // NFS has no access control but the VPC: only a VPC of the share's own network may reach it.
    const lookup = vpcLookup(this.client, signal);
    const vpc = droplet.vpc_uuid ? await lookup(droplet.vpc_uuid) : undefined;
    const network = vpc && !vpc.default ? networkOfVpc(vpc) : undefined;
    if (!vpc || network === undefined)
      throw fail(
        'INVALID_STATE',
        `Droplet ${droplet.id} is not in a better-compute network's VPC; a share is reachable only from its network`,
        'vpcNotManaged',
      );
    const vpcIds = share.vpc_ids ?? [];
    if (!vpcIds.includes(vpc.id)) {
      const networks = new Set<string>();
      for (const vpcId of vpcIds) {
        const found = await lookup(vpcId);
        const of = found && networkOfVpc(found);
        if (of !== undefined) networks.add(of);
      }
      if (!networks.has(network))
        throw fail(
          'INVALID_STATE',
          `Droplet ${droplet.id} is in network ${network}; share ${share.id} belongs to another network`,
          'otherNetwork',
        );
    }
    const sid = shareId(share.region, share.id);
    if (share.status !== 'ACTIVE') {
      const now = shareState(share);
      return now.state === 'error' ? now : state(sid, 'pending', shareOutputs(share));
    }
    // The tag first: a detach running meanwhile then sees this Droplet and keeps its VPC.
    const tag = shareTag(share.id);
    let current = share;
    if (!hasTag(droplet, tag)) {
      await assignTag(this.client, tag, droplet.id, signal);
      // A detach that read the holders before the tag landed may have taken this VPC off since the read above:
      // read the share again, so a VPC that is gone is attached again rather than reported ready.
      if (vpcIds.includes(vpc.id)) current = await this.ours(id, signal);
    }
    const on = (outputs: Record<string, string> | undefined) => ({
      ...(outputs ?? shareOutputs(current)),
      attachedTo: String(droplet.id),
    });
    if ((current.vpc_ids ?? []).includes(vpc.id))
      return state(sid, 'ready', on(shareOutputs(current)));
    if (current.status !== 'ACTIVE') {
      const now = shareState(current);
      return now.state === 'error' ? now : state(sid, 'pending', shareOutputs(current));
    }
    const action = await this.act(current, 'attach', { vpc_id: vpc.id }, signal);
    const after = await this.after(current, action, 'pending', signal);
    return after.state === 'ready' ? { ...after, outputs: on(after.outputs) } : after;
  }

  /**
   * (D4) A Droplet that had the share is gone: its tag went with it, but nothing took its VPC off the share. Each VPC
   * on the share that no tagged Droplet is in leaves it, one VPC action per call (`deleting` while one runs or more
   * are left); the share's home (its first VPC) always stays, and only a better-compute network's VPC is taken off.
   */
  protected async prune(share: DoShare, signal: AbortSignal): Promise<ProviderResourceState> {
    const sid = shareId(share.region, share.id);
    if (!this.owned(share)) return state(sid, 'deleted');
    const [home, ...rest] = share.vpc_ids ?? [];
    if (home === undefined || rest.length === 0) return state(sid, 'deleted');
    const held = new Set((await this.holders(share, signal)).map((droplet) => droplet.vpc_uuid));
    const lookup = vpcLookup(this.client, signal);
    const stale: string[] = [];
    for (const vpcId of rest) {
      if (held.has(vpcId)) continue;
      const vpc = await lookup(vpcId);
      if (vpc && !vpc.default && networkOfVpc(vpc) !== undefined) stale.push(vpcId);
    }
    if (stale.length === 0) return state(sid, 'deleted');
    if (share.status !== 'ACTIVE') return state(sid, 'deleting', shareOutputs(share));
    this.log.info('digitalocean.shareVpcPruned', { share: share.id, vpc: stale[0] });
    const action = await this.act(share, 'detach', { vpc_id: stale[0] }, signal);
    const after = await this.after(share, action, 'deleting', signal);
    if (after.state !== 'ready') return after;
    return stale.length > 1 ? state(sid, 'deleting', shareOutputs(share)) : state(sid, 'deleted');
  }

  async detach(id: string, machineId: string, ctx: CallContext): Promise<ProviderResourceState> {
    const ref = this.parse(id);
    const dropletId = parseMachineId(machineId);
    const { signal } = ctx;
    const sid = shareId(ref.region, ref.uuid);
    const share = await this.share(ref, signal);
    if (!share) return state(sid, 'deleted');
    const droplet = await this.droplet(dropletId, signal);
    // A Droplet that is gone took its tag with it, but not its VPC off the share.
    if (!droplet) return this.prune(share, signal);
    const tag = shareTag(share.id);
    if (hasTag(droplet, tag)) {
      this.refuseForeign(share);
      await unassignTag(this.client, spelled(droplet, tag), droplet.id, signal);
    } else if (!this.owned(share)) return state(sid, 'deleted');
    // The Droplet's VPC leaves the share once no Droplet there has it; the last VPC stays.
    const vpcIds = share.vpc_ids ?? [];
    const vpcId = droplet.vpc_uuid;
    if (vpcId === undefined || !vpcIds.includes(vpcId) || vpcIds.length <= 1)
      return state(sid, 'deleted');
    if (share.status !== 'ACTIVE') return state(sid, 'deleting', shareOutputs(share));
    const others = (await this.holders(share, signal)).filter(
      (d) => d.id !== droplet.id && d.vpc_uuid === vpcId,
    );
    if (others.length > 0) return state(sid, 'deleted');
    const action = await this.act(share, 'detach', { vpc_id: vpcId }, signal);
    const after = await this.after(share, action, 'deleting', signal);
    return after.state === 'ready' ? state(sid, 'deleted') : after;
  }

  // -------------------------------------------------------------------------------- snapshots

  /** Whether a share snapshot is ours: named by this deployment, like a share. */
  protected ownedSnapshot(snapshot: DoShareSnapshot): boolean {
    return (
      typeof snapshot.name === 'string' &&
      snapshot.name.endsWith(this.suffix) &&
      snapshotNamePattern.test(snapshot.name.slice(0, -this.suffix.length))
    );
  }

  protected snapshotState(snapshot: DoShareSnapshot): ProviderResourceState {
    const id = shareSnapshotId(snapshot.region, snapshot.id);
    const outputs = {
      kind: 'shared',
      volume: shareId(snapshot.region, snapshot.share_id),
      region: snapshot.region,
      sizeGiB: String(snapshot.size_gib),
    };
    switch (snapshot.status) {
      case 'ACTIVE':
        return state(id, 'ready', outputs);
      case 'DELETED':
        return state(id, 'deleted');
      case 'FAILED':
        return state(id, 'error', outputs, `DigitalOcean reports snapshot ${snapshot.id} failed`);
      default:
        return state(id, 'pending', outputs);
    }
  }

  /** The share's snapshots named `name`, oldest first. */
  protected async snapshotsNamed(
    share: DoShare,
    name: string,
    signal: AbortSignal,
  ): Promise<DoShareSnapshot[]> {
    const out: DoShareSnapshot[] = [];
    for await (const snapshot of this.client.pages<DoShareSnapshot>('/nfs/snapshots', 'snapshots', {
      query: { region: share.region, share_id: share.id },
      signal,
      budget: 'observe',
    }))
      if (snapshot.name === name && snapshot.share_id === share.id && snapshot.status !== 'DELETED')
        out.push(snapshot);
    return out.sort(byAge);
  }

  protected async destroySnapshot(snapshot: DoShareSnapshot, signal: AbortSignal): Promise<void> {
    try {
      await this.client.request('DELETE', `/nfs/snapshots/${encodeURIComponent(snapshot.id)}`, {
        query: { region: snapshot.region },
        signal,
        budget: 'mutate',
      });
    } catch (error) {
      if (!isComputeError(error, 'NOT_FOUND')) throw error;
    }
  }

  /** The oldest of the found snapshots (all ours by name); later ones (a racing call) go. */
  protected async converge(
    found: DoShareSnapshot[],
    signal: AbortSignal,
  ): Promise<DoShareSnapshot | undefined> {
    const [oldest, ...others] = found;
    for (const duplicate of others) {
      this.log.info('digitalocean.duplicateShareSnapshotReaped', {
        kept: oldest!.id,
        deleted: duplicate.id,
      });
      await this.destroySnapshot(duplicate, signal);
    }
    return oldest;
  }

  async snapshot(id: string, name: string, ctx: CallContext): Promise<ProviderResourceState> {
    this.parse(id);
    const full = `${name}${this.suffix}`;
    if (!snapshotNamePattern.test(name) || full.length > maxSnapshotName)
      throw fail(
        'INVALID_INPUT',
        `${JSON.stringify(name)} is not a snapshot name: a letter or digit, then [a-zA-Z0-9._-], at most ${maxSnapshotName - this.suffix.length} characters`,
        'name',
      );
    const { signal } = ctx;
    const share = await this.ours(id, signal);
    const existing = await this.converge(await this.snapshotsNamed(share, full, signal), signal);
    if (existing) return this.snapshotState(existing);
    if (share.status === 'ACTIVE') {
      const action = await this.act(share, 'snapshot', { name: full }, signal);
      if (action !== 'busy' && action.status === 'errored')
        throw new ComputeError(
          'PROVIDER_ERROR',
          `DigitalOcean's snapshot action on share ${share.id} errored`,
          undefined,
          { provider: 'digitalocean', reason: 'actionErrored' },
        );
      // The action makes the snapshot: it may already be there, or not yet.
      const kept = await this.converge(await this.snapshotsNamed(share, full, signal), signal);
      if (kept) return this.snapshotState(kept);
    }
    throw new ComputeError(
      'UNAVAILABLE',
      `DigitalOcean has not made the snapshot ${name} of share ${share.id} yet; the next call looks again`,
      undefined,
      { provider: 'digitalocean', reason: 'snapshotUnconfirmed' },
    );
  }

  /** The snapshot, or undefined when it does not exist. */
  protected async findSnapshot(
    ref: { region: string; uuid: string },
    signal: AbortSignal,
  ): Promise<DoShareSnapshot | undefined> {
    try {
      const reply = await this.client.request<{ snapshot: DoShareSnapshot }>(
        'GET',
        `/nfs/snapshots/${encodeURIComponent(ref.uuid)}`,
        { query: { region: ref.region }, signal, budget: 'observe' },
      );
      return reply.snapshot?.status === 'DELETED' ? undefined : reply.snapshot;
    } catch (error) {
      if (isComputeError(error, 'NOT_FOUND')) return undefined;
      throw error;
    }
  }

  async getSnapshot(id: string, ctx: CallContext): Promise<ProviderResourceState | undefined> {
    const ref = parseShareSnapshotId(id);
    if (!ref) return undefined;
    const snapshot = await this.findSnapshot(ref, ctx.signal);
    return snapshot ? this.snapshotState(snapshot) : undefined;
  }

  async deleteSnapshot(id: string, ctx: CallContext): Promise<ProviderResourceState> {
    const ref = parseShareSnapshotId(id);
    if (!ref)
      throw fail(
        'INVALID_INPUT',
        `${JSON.stringify(id)} is not a DigitalOcean share snapshot id`,
        'snapshotId',
      );
    const sid = shareSnapshotId(ref.region, ref.uuid);
    const snapshot = await this.findSnapshot(ref, ctx.signal);
    if (!snapshot) return state(sid, 'deleted');
    if (!this.ownedSnapshot(snapshot))
      throw fail(
        'INVALID_STATE',
        `snapshot ${snapshot.id} is not a share snapshot managed by this better-compute deployment and is never deleted by it`,
        'notManaged',
      );
    await this.destroySnapshot(snapshot, ctx.signal);
    return state(sid, 'deleted');
  }
}
