import {
  ComputeError,
  isComputeError,
  type CallContext,
  type ExternalMachine,
  type Offer,
  type OfferQuery,
  type ProviderContext,
  type ProviderImpl,
} from '@better-compute/core';
import type { DoClient } from '../client/http.js';
import type { DoConfig, DoProviderOptions } from '../config.js';
import {
  deploymentTag,
  dropletName,
  isManagedTag,
  keyTag,
  labels,
  labelsFromTags,
  machineId,
  offerId,
  parseMachineId,
  parseOfferId,
  tagFor,
} from '../ids.js';
import { ensureSshKeys } from './keys.js';
import { cachedSize, gpuModelOf, listOffers } from './offers.js';
import type { DoAction, DoDroplet, DoVpc } from './types.js';

// Droplets as machines. DO has no idempotency key, so a create carries its key as a tag
// (`keyTag`) and looks for it before and after its POST. Two creates that race on one key both
// post; the second lookup sees both Droplets, keeps the oldest and deletes the rest, so every
// caller converges on one Droplet (DO-D4). Deletion only ever touches a Droplet that carries the
// managed tag and this deployment's tag (DO-D16, ruling R3), one Droplet at a time: the
// tag-scoped bulk endpoints are never called.

/** DO's limit on `user_data`, in bytes. */
const maxUserDataBytes = 65_536;

const managedTag = tagFor(labels.managed, 'true');
/** Label keys only the provider writes: a request's label never overrides them. */
const reservedKeys: ReadonlySet<string> = new Set([
  labels.managed,
  labels.instance,
  labels.deployment,
  labels.key,
]);
const tagPattern = /^[a-z0-9:_-]{1,255}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(
  code:
    | 'INVALID_INPUT'
    | 'INVALID_CONFIG'
    | 'INVALID_STATE'
    | 'UNSUPPORTED'
    | 'CAPACITY_UNAVAILABLE',
  message: string,
  reason: string,
): ComputeError {
  return new ComputeError(code, message, undefined, { provider: 'digitalocean', reason });
}

const states: Readonly<Record<string, ExternalMachine['state']>> = {
  new: 'pending',
  active: 'running',
  off: 'stopped',
  archive: 'deleted',
};

/** A Droplet as a machine. Pure: the network is the Droplet's VPC uuid (ruling R2). */
export function toMachine(droplet: DoDroplet): ExternalMachine {
  const tags = droplet.tags ?? [];
  const v4 = droplet.networks?.v4 ?? [];
  const v6 = droplet.networks?.v6 ?? [];
  const publicV4 = v4.filter((n) => n.type === 'public').map((n) => n.ip_address);
  const privateV4 = v4.filter((n) => n.type === 'private').map((n) => n.ip_address);
  const decoded = labelsFromTags(tags);
  const gpuInfo = droplet.gpu_info ?? droplet.size?.gpu_info;
  const model = gpuModelOf({ gpu_info: gpuInfo });
  const createdAt = Date.parse(droplet.created_at);
  const claimedBy = decoded[labels.instance];
  return {
    id: machineId(droplet.id),
    name: droplet.name,
    state: states[droplet.status] ?? 'unknown',
    offerId: offerId(droplet.region.slug, droplet.size_slug),
    region: droplet.region.slug,
    addresses: [...publicV4, ...privateV4, ...v6.map((n) => n.ip_address)],
    machineType: droplet.size_slug,
    vcpu: droplet.vcpus,
    memoryGiB: droplet.memory / 1024,
    ...(model !== undefined ? { gpus: { model, count: gpuInfo?.count ?? 0 } } : {}),
    labels: decoded,
    ...(claimedBy !== undefined ? { claimedBy } : {}),
    ...(Number.isFinite(createdAt) ? { createdAt } : {}),
    ...(droplet.vpc_uuid
      ? {
          networks: [
            {
              network: droplet.vpc_uuid,
              ...(privateV4[0] !== undefined ? { address: privateV4[0] } : {}),
              ...(publicV4[0] !== undefined ? { publicAddress: publicV4[0] } : {}),
              tags: tags.filter(isManagedTag),
            },
          ],
        }
      : {}),
  };
}

/** Oldest first: by creation time (whole seconds at DO), then by id. */
function byAge(a: DoDroplet, b: DoDroplet): number {
  const at = Date.parse(a.created_at) - Date.parse(b.created_at);
  return Number.isFinite(at) && at !== 0 ? at : a.id - b.id;
}

function hasTag(droplet: DoDroplet, tag: string): boolean {
  return (droplet.tags ?? []).some((t) => t.toLowerCase() === tag);
}

export class DoCompute implements ProviderImpl {
  protected readonly config: DoConfig;
  protected readonly context: ProviderContext;
  protected readonly options: Required<Pick<DoProviderOptions, 'deployment' | 'inCallWaitMs'>>;
  protected readonly client: DoClient;
  /** This deployment's tag: what `delete` and the reaper require, with the managed tag. */
  protected readonly deploymentTag: string;

  constructor(
    config: DoConfig,
    context: ProviderContext,
    options: Required<Pick<DoProviderOptions, 'deployment' | 'inCallWaitMs'>>,
    client: DoClient,
  ) {
    this.config = config;
    this.context = context;
    this.options = options;
    this.client = client;
    this.deploymentTag = deploymentTag(options.deployment);
  }

  /** Whether better-compute may delete the Droplet: managed, and in this deployment (R3). */
  protected owned(droplet: DoDroplet): boolean {
    return hasTag(droplet, managedTag) && hasTag(droplet, this.deploymentTag);
  }

  // ------------------------------------------------------------------------------- offers

  async listOffers(query: OfferQuery): Promise<Offer[]> {
    return listOffers(this.client, this.config, query, new AbortController().signal);
  }

  // ------------------------------------------------------------------------------- create

  /** Whether a size is a GPU one: by its slug, or by the catalog when the client holds it. */
  protected isGpuSize(size: string): boolean {
    return size.startsWith('gpu-') || cachedSize(this.client, size)?.gpu_info !== undefined;
  }

  /**
   * This deployment's managed Droplets carrying the key tag, oldest first. A `tag_name` list may
   * omit GPU Droplets and can't be combined with `type` (research S2), so for a GPU size the GPU
   * list is paged as well and filtered by the tag here.
   */
  protected async byKey(key: string, gpu: boolean, signal: AbortSignal): Promise<DoDroplet[]> {
    const tag = keyTag(key);
    const found = new Map<number, DoDroplet>();
    for await (const droplet of this.client.pages<DoDroplet>('/droplets', 'droplets', {
      query: { tag_name: tag },
      signal,
      budget: 'observe',
    }))
      found.set(droplet.id, droplet);
    if (gpu)
      for await (const droplet of this.client.pages<DoDroplet>('/droplets', 'droplets', {
        query: { type: 'gpus' },
        signal,
        budget: 'observe',
      }))
        if (hasTag(droplet, tag)) found.set(droplet.id, droplet);
    return [...found.values()].filter((droplet) => this.owned(droplet)).sort(byAge);
  }

  /** The `vpc_uuid` for a create: `config.vpc` as a uuid, or resolved by name; none without it. */
  protected async vpcFor(region: string, signal: AbortSignal): Promise<string | undefined> {
    const wanted = this.config.vpc;
    if (wanted === undefined) return undefined;
    if (uuidPattern.test(wanted)) return wanted;
    for await (const vpc of this.client.pages<DoVpc>('/vpcs', 'vpcs', {
      signal,
      budget: 'observe',
    })) {
      if (vpc.name !== wanted) continue;
      if (vpc.region !== region)
        throw fail(
          'INVALID_CONFIG',
          `the account's VPC ${wanted} is in ${vpc.region}, not in ${region}`,
          'vpc',
        );
      return vpc.id;
    }
    throw fail('INVALID_CONFIG', `the account's VPC ${wanted} does not exist`, 'vpc');
  }

  /** Deletes a Droplet by id; one that is already gone counts as deleted. */
  protected async destroy(id: number, signal: AbortSignal): Promise<void> {
    try {
      await this.client.request('DELETE', `/droplets/${id}`, { signal, budget: 'mutate' });
    } catch (error) {
      if (!isComputeError(error, 'NOT_FOUND')) throw error;
    }
  }

  /**
   * Keeps the oldest of the Droplets created under one key and deletes the others, one by one.
   * Each was found by the key, managed and in this deployment, so each is one of ours.
   */
  protected async converge(droplets: DoDroplet[], signal: AbortSignal): Promise<DoDroplet> {
    const [oldest, ...others] = droplets.sort(byAge);
    for (const duplicate of others) {
      this.context.log.info('digitalocean.duplicateReaped', {
        kept: oldest!.id,
        deleted: duplicate.id,
      });
      await this.destroy(duplicate.id, signal);
    }
    return oldest!;
  }

  async create(
    request: Parameters<ProviderImpl['create']>[0],
    ctx: CallContext,
  ): Promise<ExternalMachine> {
    const { signal } = ctx;
    // 1. Everything that can be refused without a request.
    const { region, size, spot } = parseOfferId(request.offerId);
    if (!this.config.regions.includes(region))
      throw fail(
        'INVALID_INPUT',
        `offer ${request.offerId} is in ${region}, which this account does not use`,
        'region',
      );
    if (spot) throw fail('UNSUPPORTED', 'DigitalOcean Spot capacity is not supported yet', 'spot');
    if (request.image.includes('@'))
      throw fail(
        'UNSUPPORTED',
        `catalog image ${request.image} is not supported on DigitalOcean yet`,
        'catalogImage',
      );
    if (Buffer.byteLength(request.userData, 'utf8') > maxUserDataBytes)
      throw fail(
        'INVALID_INPUT',
        `user data is over DigitalOcean's limit of ${maxUserDataBytes} bytes`,
        'userData',
      );
    if (request.network)
      throw fail(
        'UNSUPPORTED',
        'creating a Droplet on a network is not supported yet',
        'networkRef',
      );
    if (!request.sshKeys?.length && this.config.defaultSshKey === undefined)
      throw fail(
        'INVALID_CONFIG',
        'a Droplet needs an SSH key: the instance has none and the account sets no defaultSshKey',
        'noSshKey',
      );
    // The instance tag names the instance, as provider-gcp's instance label does: power and
    // setTags (ruling R3) and vps's ownership checks read it.
    const tags = [
      managedTag,
      this.deploymentTag,
      keyTag(ctx.idempotencyKey),
      tagFor(labels.instance, request.name),
    ];
    for (const [key, value] of Object.entries(request.labels ?? {})) {
      if (reservedKeys.has(key.toLowerCase())) continue;
      const tag = tagFor(key, value);
      if (!tagPattern.test(tag))
        throw fail(
          'INVALID_INPUT',
          `label ${JSON.stringify(key)} can't be a DigitalOcean tag`,
          'label',
        );
      tags.push(tag);
    }
    const image = /^[1-9][0-9]*$/.test(request.image) ? Number(request.image) : request.image;
    const gpu = this.isGpuSize(size);

    // 2. A retry finds the Droplet its first attempt made.
    const existing = await this.byKey(ctx.idempotencyKey, gpu, signal);
    if (existing.length > 0) return toMachine(await this.converge(existing, signal));

    // 3. Keys and the VPC.
    const sshKeys = await ensureSshKeys(
      this.client,
      request.sshKeys ?? [],
      this.config.defaultSshKey,
      signal,
    );
    if (sshKeys.length === 0)
      throw fail('INVALID_CONFIG', 'a Droplet needs an SSH key and none was given', 'noSshKey');
    const vpc = await this.vpcFor(region, signal);

    // 4. The create.
    let created: DoDroplet | undefined;
    try {
      const reply = await this.client.request<{ droplet?: DoDroplet }>('POST', '/droplets', {
        body: {
          name: dropletName(request.name),
          region,
          size,
          image,
          ssh_keys: sshKeys,
          user_data: request.userData,
          ...(vpc !== undefined ? { vpc_uuid: vpc } : {}),
          monitoring: this.config.monitoring ?? true,
          ipv6: this.config.ipv6 ?? false,
          tags: [...new Set(tags)],
        },
        signal,
        budget: 'mutate',
      });
      created = reply.droplet;
    } catch (error) {
      // An answer that never arrived may still have created the Droplet: look before failing.
      if (!isComputeError(error, 'UNAVAILABLE')) throw error;
      const landed = await this.byKey(ctx.idempotencyKey, gpu, signal);
      if (landed.length === 0) throw error;
      return toMachine(await this.converge(landed, signal));
    }

    // 5. A create racing on the same key may have posted too: keep the oldest, reap the rest.
    const found = new Map(
      (await this.byKey(ctx.idempotencyKey, gpu, signal)).map((d) => [d.id, d] as const),
    );
    if (created && !found.has(created.id)) found.set(created.id, created);
    if (found.size === 0)
      throw new ComputeError(
        'PROVIDER_ERROR',
        'DigitalOcean accepted a create but returned no Droplet',
        undefined,
        {
          provider: 'digitalocean',
          reason: 'badBody',
        },
      );
    return toMachine(await this.converge([...found.values()], signal));
  }

  // ------------------------------------------------------------------------------- get, delete

  /** The Droplet, or undefined when it does not exist (or the id is not a Droplet id). */
  protected async droplet(id: string, signal: AbortSignal): Promise<DoDroplet | undefined> {
    let dropletId: number;
    try {
      dropletId = parseMachineId(id);
    } catch {
      return undefined;
    }
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
   * A Droplet that is still `new` may never come up: DO accepts a create with a 202 and runs it
   * as an action, which can end `errored` (without a message: the action model has none). The
   * action is read from the Droplet's own list, so no state outlives a call (ruling R4).
   */
  async get(id: string, ctx: CallContext): Promise<ExternalMachine | undefined> {
    const droplet = await this.droplet(id, ctx.signal);
    if (!droplet) return undefined;
    if (droplet.status === 'new') {
      let create: DoAction | undefined;
      for await (const action of this.client.pages<DoAction>(
        `/droplets/${droplet.id}/actions`,
        'actions',
        { signal: ctx.signal, budget: 'observe' },
      ))
        if (action.type === 'create') create = action;
      if (create?.status === 'errored')
        throw fail(
          'CAPACITY_UNAVAILABLE',
          `Droplet ${droplet.id}: its create action errored, so it will not come up`,
          'createActionErrored',
        );
    }
    return toMachine(droplet);
  }

  async delete(id: string, ctx: CallContext): Promise<void> {
    const droplet = await this.droplet(id, ctx.signal);
    if (!droplet) return;
    if (!this.owned(droplet))
      throw fail(
        'INVALID_STATE',
        `Droplet ${droplet.id} is not managed by this better-compute deployment and is never deleted by it`,
        'notManaged',
      );
    await this.destroy(droplet.id, ctx.signal);
  }
}
