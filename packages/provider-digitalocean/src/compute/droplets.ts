import {
  ComputeError,
  isComputeError,
  type CallContext,
  type CatalogImageIdentity,
  type ExternalMachine,
  type Offer,
  type OfferQuery,
  type PowerAction,
  type ProviderContext,
  type ProviderDeleteOptions,
  type ProviderImpl,
  type ProviderKubernetes,
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
  networkMemberTag,
  offerId,
  parseMachineId,
  parseOfferId,
  tagFor,
} from '../ids.js';
import { DoAddresses } from '../edge/addresses.js';
import { DoNetworks } from '../networks/index.js';
import { DoVolumes } from '../storage/volumes.js';
import { DoResources } from '../resources/registry.js';
import { networkNamer, vpcForNetwork } from '../networks/vpcs.js';
import { poolMembers } from './autoscale.js';
import { ensureSshKeys } from './keys.js';
import { DoCatalogImages } from './catalog.js';
import { checkGpuImage, classifyImage, imageParam, type ImageChoice } from './images.js';
import { cachedSize, gpuModelOf, listOffers, sizeOf } from './offers.js';
import { spotEnabled, spotPriceOf, spotShape } from './spot.js';
import {
  assignTag,
  doksTagKeys,
  ensureTag,
  hasTag,
  isKubernetesNode,
  spelled,
  unassignTag,
} from './tags.js';
import type { DoAction, DoDroplet, DoVpc } from './types.js';

// Droplets as machines. DO has no idempotency key, so a create carries its key as a tag
// (`keyTag`) and looks for it before and after its POST. Two creates that race on one key both
// post; the second lookup sees both Droplets, keeps the oldest and deletes the rest, so every
// caller converges on one Droplet (DO-D4). Deletion only ever touches a Droplet that carries the
// managed tag and this deployment's tag (DO-D16, ruling R3), one Droplet at a time: the
// tag-scoped bulk endpoints are never called. Power acts on a Droplet that carries this
// deployment's tag and an instance tag (a claimed VM is powerable without being deletable); a
// rebuild wipes the disk, so it needs the same ownership as a delete. Attaching (claim) is the
// other direction: DO has no atomic compare-and-set on tags, so a claim writes its tags and then
// reads the Droplet again; if another instance tag appeared in between, it takes its own back
// (tag-then-verify, DO-D6).

/** DO's limit on `user_data`, in bytes. */
const maxUserDataBytes = 65_536;

const managedTag = tagFor(labels.managed, 'true');
/** Label keys only the provider writes: a request's label never overrides them. */
const reservedKeys: ReadonlySet<string> = new Set([
  labels.managed,
  labels.instance,
  labels.deployment,
  labels.key,
  labels.autoscalePool,
  labels.capacity,
]);
const spotTag = tagFor(labels.capacity, 'spot');
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

function notFound(id: string): ComputeError {
  return new ComputeError('NOT_FOUND', `Droplet ${id} does not exist`, undefined, {
    provider: 'digitalocean',
    id,
  });
}

const states: Readonly<Record<string, ExternalMachine['state']>> = {
  new: 'pending',
  active: 'running',
  off: 'stopped',
  archive: 'deleted',
};

/**
 * A Droplet as a machine. Pure: the network is the Droplet's VPC uuid; `get`, `list`, `discover`
 * and `claim` name it (ruling R2, `networkNamer`).
 */
export function toMachine(droplet: DoDroplet): ExternalMachine {
  const tags = droplet.tags ?? [];
  const v4 = droplet.networks?.v4 ?? [];
  const v6 = droplet.networks?.v6 ?? [];
  const publicV4 = v4.filter((n) => n.type === 'public').map((n) => n.ip_address);
  const privateV4 = v4.filter((n) => n.type === 'private').map((n) => n.ip_address);
  // The pool label is discovery's, from a pool's member list: a tag of that name proves nothing.
  const { [labels.autoscalePool]: _forged, ...decoded } = labelsFromTags(tags);
  const gpuInfo = droplet.gpu_info ?? droplet.size?.gpu_info;
  const model = gpuModelOf({ gpu_info: gpuInfo });
  const createdAt = Date.parse(droplet.created_at);
  const claimedBy = decoded[labels.instance];
  return {
    id: machineId(droplet.id),
    name: droplet.name,
    state: states[droplet.status] ?? 'unknown',
    offerId: offerId(droplet.region.slug, droplet.size_slug, hasTag(droplet, spotTag)),
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

const instanceTagPrefix = `${labels.instance}:`;
const deploymentTagPrefix = `${labels.deployment}:`;

/** DO's action type for each power action; `nmi` has none. */
const powerTypes: Readonly<Record<Exclude<PowerAction, 'nmi'>, string>> = {
  on: 'power_on',
  off: 'power_off',
  'graceful-off': 'shutdown',
  'graceful-restart': 'reboot',
  cycle: 'power_cycle',
  reset: 'power_cycle',
};

/** What a DoCompute takes from the provider options. */
export type DoComputeOptions = Required<Pick<DoProviderOptions, 'deployment' | 'inCallWaitMs'>> &
  Pick<DoProviderOptions, 'catalogImages'>;

export class DoCompute implements ProviderImpl {
  protected readonly config: DoConfig;
  protected readonly context: ProviderContext;
  protected readonly options: DoComputeOptions;
  protected readonly client: DoClient;
  /** This deployment's tag: what `delete` and the reaper require, with the managed tag. */
  protected readonly deploymentTag: string;
  /** Tenant networks: VPCs, Cloud Firewalls and Droplet tags. */
  readonly networks: DoNetworks;
  /** Block Storage volumes and their snapshots (P2). */
  readonly volumes: DoVolumes;
  /** Reserved IPv4 and IPv6 addresses (P2). */
  readonly addresses: DoAddresses;
  /** Catalog images imported as custom images; absent without `catalogImages`. */
  protected readonly catalog: DoCatalogImages | undefined;
  /** Managed Kubernetes (DOKS clusters and node pools); the provider sets it. */
  kubernetes?: ProviderKubernetes;
  /** Managed databases and the rest of the long tail, through the generic resource contract (P7). */
  readonly resources: DoResources;

  constructor(
    config: DoConfig,
    context: ProviderContext,
    options: DoComputeOptions,
    client: DoClient,
  ) {
    this.config = config;
    this.context = context;
    this.options = options;
    this.client = client;
    this.deploymentTag = deploymentTag(options.deployment);
    this.networks = new DoNetworks(client, config, options.deployment);
    this.volumes = new DoVolumes(client, config, options.deployment, context.log);
    this.addresses = new DoAddresses(client, config, options.deployment, context.log);
    this.catalog = options.catalogImages
      ? new DoCatalogImages(
          client,
          options.catalogImages,
          { managed: managedTag, deployment: this.deploymentTag },
          context.log,
        )
      : undefined;
    this.resources = new DoResources(client, config, options.deployment);
  }

  /**
   * Whether better-compute may delete the Droplet: managed, and in this deployment (R3). A DOKS
   * worker never is, whatever tags it carries: DOKS owns its nodes.
   */
  protected owned(droplet: DoDroplet): boolean {
    return (
      hasTag(droplet, managedTag) &&
      hasTag(droplet, this.deploymentTag) &&
      !isKubernetesNode(droplet)
    );
  }

  /**
   * Whether better-compute may power the Droplet: in this deployment and claimed by an instance
   * (R3). Unlike `owned` it does not need the managed tag: tenants control the VMs they attach.
   */
  protected instanceOwned(droplet: DoDroplet): boolean {
    return (
      hasTag(droplet, this.deploymentTag) &&
      (droplet.tags ?? []).some((t) => t.toLowerCase().startsWith(instanceTagPrefix))
    );
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
   * list is paged as well and filtered by the tag here. An `archive` Droplet (a reclaimed Spot
   * Droplet DO still lists) is gone: it is never adopted, and never kept over a live one.
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
    return [...found.values()]
      .filter((droplet) => this.owned(droplet) && droplet.status !== 'archive')
      .sort(byAge);
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
    if (spot) await this.checkSpot(size, signal);
    const imageChoice = this.checkImage(classifyImage(request.image), request.catalogImage);
    if (Buffer.byteLength(request.userData, 'utf8') > maxUserDataBytes)
      throw fail(
        'INVALID_INPUT',
        `user data is over DigitalOcean's limit of ${maxUserDataBytes} bytes`,
        'userData',
      );
    if (!request.sshKeys?.length && this.config.sshKeyFingerprint === undefined)
      throw fail(
        'INVALID_CONFIG',
        'a Droplet needs an SSH key: the instance has none and the account sets no sshKeyFingerprint',
        'noSshKey',
      );
    // The instance tag names the instance, as provider-gcp's instance label does: power and
    // setTags (ruling R3) and vps's ownership checks read it.
    const tags = [
      managedTag,
      this.deploymentTag,
      keyTag(ctx.idempotencyKey),
      tagFor(labels.instance, request.name),
      ...(spot ? [spotTag] : []),
    ];
    for (const [key, value] of Object.entries(request.labels ?? {})) {
      // A tag is `<key>:<value>` split at its first colon, so a key with a colon could forge a
      // reserved prefix (`better-compute-instance:x` reads as a second instance tag).
      if (key.includes(':'))
        throw fail(
          'INVALID_INPUT',
          `label ${JSON.stringify(key)} can't be a DigitalOcean tag key: it has a colon`,
          'label',
        );
      // DOKS's own tag keys would make the Droplet read as a cluster worker, never ours to delete.
      if (doksTagKeys.has(key.toLowerCase()))
        throw fail(
          'INVALID_INPUT',
          `label ${JSON.stringify(key)} is DigitalOcean Kubernetes's own tag key (k8s, k8s-worker)`,
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
      tags.push(tag);
    }
    // On a tenant network the Droplet carries the network's member tag and the tags its rules
    // target from its first boot, so the base firewall covers it before any setTags.
    const ref = request.network;
    if (ref) {
      for (const tag of ref.tags ?? [])
        if (!tagPattern.test(tag))
          throw fail(
            'INVALID_INPUT',
            `network tag ${JSON.stringify(tag)} is not a DigitalOcean tag`,
            'tag',
          );
      tags.push(networkMemberTag(ref.network), ...(ref.tags ?? []));
    }
    const gpu = this.isGpuSize(size);
    checkGpuImage(imageChoice, size, gpu, cachedSize(this.client, size)?.gpu_info?.model);

    // 2. A retry finds the Droplet its first attempt made.
    const existing = await this.byKey(ctx.idempotencyKey, gpu, signal);
    if (existing.length > 0) return toMachine(await this.converge(existing, signal));

    // 3. The image, which for a catalog image may still be on its way into the region.
    const image = await this.imageFor(imageChoice, region, signal, request.catalogImage);

    // 4. The VPC, then the keys: a create refused for its VPC uploads no key.
    const vpc = ref
      ? (await vpcForNetwork(this.client, ref, region, signal)).id
      : await this.vpcFor(region, signal);
    const sshKeys = await ensureSshKeys(
      this.client,
      request.sshKeys ?? [],
      this.config.sshKeyFingerprint,
      signal,
    );
    if (sshKeys.length === 0)
      throw fail('INVALID_CONFIG', 'a Droplet needs an SSH key and none was given', 'noSshKey');

    // 5. The create.
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
          ...(spot ? spotShape.createBody : {}),
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

    // 6. A create racing on the same key may have posted too: keep the oldest, reap the rest.
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

  /**
   * Refuses a Spot create the account does not allow (DO-D14; while the wire shape is unverified,
   * one without `previews` too), or one for a size the catalog shows without a Spot price. The
   * catalog is loaded when the client holds none: DO is never left to decide, since a Spot member it
   * ignored would make an on-demand Droplet that reads back as Spot.
   */
  protected async checkSpot(size: string, signal: AbortSignal): Promise<void> {
    if (!this.config.allowSpot)
      throw fail(
        'UNSUPPORTED',
        'Spot capacity is off for this DigitalOcean account (allowSpot)',
        'spot',
      );
    if (!spotEnabled(this.config))
      throw fail(
        'UNSUPPORTED',
        "DigitalOcean Spot is a preview whose API shape better-compute hasn't verified: it needs previews as well as allowSpot",
        'spotPreview',
      );
    const known = cachedSize(this.client, size) ?? (await sizeOf(this.client, size, signal));
    if (!known || spotPriceOf(known) === undefined)
      throw fail('INVALID_INPUT', `size ${size} has no Spot capacity on DigitalOcean`, 'spot');
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
      try {
        for await (const action of this.client.pages<DoAction>(
          `/droplets/${droplet.id}/actions`,
          'actions',
          { signal: ctx.signal, budget: 'observe' },
        ))
          if (action.type === 'create') create = action;
      } catch (error) {
        // Deleted between the read and the action list.
        if (isComputeError(error, 'NOT_FOUND')) return undefined;
        throw error;
      }
      if (create?.status === 'errored')
        throw fail(
          'CAPACITY_UNAVAILABLE',
          `Droplet ${droplet.id}: its create action errored, so it will not come up`,
          'createActionErrored',
        );
    }
    return networkNamer(this.client, ctx.signal, this.context.log)(toMachine(droplet));
  }

  /**
   * Deletes a Droplet of ours. With `options.volumes` (P2) it is one selective destroy that also deletes those of the
   * named volumes that are ours and attached to it (DO-D16: never a tag-scoped bulk call, never a tenant's own
   * volume); naming none of ours is a plain delete. Every other volume is detached by DO and survives.
   */
  async delete(id: string, ctx: CallContext, options?: ProviderDeleteOptions): Promise<void> {
    const droplet = await this.droplet(id, ctx.signal);
    if (!droplet) return;
    if (!this.owned(droplet))
      throw fail(
        'INVALID_STATE',
        `Droplet ${droplet.id} is not managed by this better-compute deployment and is never deleted by it`,
        'notManaged',
      );
    const volumes = options?.volumes?.length
      ? await this.volumes.deletableWith(options.volumes, droplet.id, ctx.signal)
      : [];
    if (volumes.length === 0) {
      await this.destroy(droplet.id, ctx.signal);
      return;
    }
    try {
      await this.client.request(
        'DELETE',
        `/droplets/${droplet.id}/destroy_with_associated_resources/selective`,
        { body: { volumes }, signal: ctx.signal, budget: 'mutate' },
      );
    } catch (error) {
      if (!isComputeError(error, 'NOT_FOUND')) throw error;
    }
  }

  // ------------------------------------------------------------------- power, reinstall, list

  /** The Droplet to act on: it must exist and pass `allowed`, else the refusal's `reason`. */
  protected async target(
    id: string,
    signal: AbortSignal,
    allowed: (droplet: DoDroplet) => boolean,
    refusal: { reason: string; message: (droplet: DoDroplet) => string },
  ): Promise<DoDroplet> {
    const droplet = await this.droplet(id, signal);
    if (!droplet) throw notFound(id);
    if (!allowed(droplet)) throw fail('INVALID_STATE', refusal.message(droplet), refusal.reason);
    return droplet;
  }

  /** Starts a Droplet action. It is not awaited: a later `get` shows its effect. */
  protected async act(
    droplet: DoDroplet,
    body: { type: string; image?: string | number },
    signal: AbortSignal,
  ): Promise<void> {
    const reply = await this.client.request<{ action?: DoAction }>(
      'POST',
      `/droplets/${droplet.id}/actions`,
      { body, signal, budget: 'mutate' },
    );
    this.context.log.info('digitalocean.action', {
      droplet: droplet.id,
      type: body.type,
      action: reply.action?.id,
    });
  }

  async power(id: string, action: PowerAction, ctx: CallContext): Promise<void> {
    if (action === 'nmi') throw fail('UNSUPPORTED', 'DigitalOcean has no NMI power action', 'nmi');
    const droplet = await this.target(id, ctx.signal, (d) => this.instanceOwned(d), {
      reason: 'notInstance',
      message: (d) =>
        `Droplet ${d.id} does not belong to an instance of this better-compute deployment and is never powered by it`,
    });
    await this.act(droplet, { type: powerTypes[action] }, ctx.signal);
  }

  async reinstall(
    id: string,
    image: string,
    ctx: CallContext,
    options: { catalogImage?: CatalogImageIdentity } = {},
  ): Promise<void> {
    const choice = this.checkImage(classifyImage(image), options.catalogImage);
    const droplet = await this.target(id, ctx.signal, (d) => this.owned(d), {
      reason: 'notManaged',
      message: (d) =>
        `Droplet ${d.id} is not managed by this better-compute deployment and is never rebuilt by it`,
    });
    const gpuInfo = droplet.gpu_info ?? droplet.size?.gpu_info;
    checkGpuImage(choice, droplet.size_slug, gpuInfo !== undefined, gpuInfo?.model);
    const param = await this.imageFor(choice, droplet.region.slug, ctx.signal, options.catalogImage);
    await this.act(droplet, { type: 'rebuild', image: param }, ctx.signal);
  }

  // ------------------------------------------------------------------------------- images

  /**
   * Refuses, before any request, an image this provider can't boot: a catalog image needs a source,
   * and the host's resolution of it for the instance's tenant (a ref is unique only per tenant).
   */
  protected checkImage(choice: ImageChoice, identity?: CatalogImageIdentity): ImageChoice {
    if (choice.kind !== 'catalog') return choice;
    if (!this.catalog) throw noCatalog(choice.ref);
    if (identity === undefined || !/^[0-9a-f]{64}$/i.test(identity.sha256) || !identity.tenantId)
      throw fail(
        'INVALID_INPUT',
        `catalog image ${choice.ref} was not resolved for a tenant, so it is not imported`,
        'catalogImageUnresolved',
      );
    return choice;
  }

  /** The `image` member of a create or rebuild in `region`. */
  protected async imageFor(
    choice: ImageChoice,
    region: string,
    signal: AbortSignal,
    identity?: CatalogImageIdentity,
  ): Promise<string | number> {
    if (choice.kind !== 'catalog') return imageParam(choice);
    if (!this.catalog) throw noCatalog(choice.ref);
    return this.catalog.imageIn(choice.ref, this.checkedIdentity(choice, identity), region, signal);
  }

  /** The identity `checkImage` already required, for the compiler. */
  protected checkedIdentity(
    choice: Extract<ImageChoice, { kind: 'catalog' }>,
    identity: CatalogImageIdentity | undefined,
  ): CatalogImageIdentity {
    this.checkImage(choice, identity);
    return identity!;
  }

  /**
   * This deployment's managed Droplets. The `tag_name` list omits GPU Droplets and can't be
   * combined with `type=gpus` (research S2), so the GPU list is paged on its own and filtered by
   * the deployment tag here; a Droplet is yielded once.
   */
  async *list(ctx: CallContext): AsyncIterable<ExternalMachine> {
    const named = networkNamer(this.client, ctx.signal, this.context.log);
    const seen = new Set<number>();
    const queries: Record<string, string>[] = [{ tag_name: this.deploymentTag }, { type: 'gpus' }];
    for (const query of queries)
      for await (const droplet of this.client.pages<DoDroplet>('/droplets', 'droplets', {
        query,
        signal: ctx.signal,
        budget: 'sweep',
      })) {
        // The GPU list is everyone's, so both lists are checked for managed and deployment tags.
        if (seen.has(droplet.id) || !this.owned(droplet)) continue;
        seen.add(droplet.id);
        yield await named(toMachine(droplet));
      }
  }

  // ------------------------------------------------------------------- discover, claim, release

  /**
   * Every Droplet in the account's regions, claimed or not. The default list omits GPU Droplets,
   * so the `type=gpus` list is read too (research S2). `discoverTag` narrows the first query; the
   * GPU list can't be combined with `tag_name`, so it is filtered by the tag here. Droplets that
   * belong to a DO autoscale pool carry the pool's id in `labels['better-compute-autoscale-pool']`.
   * DOKS worker nodes are left out: DOKS owns them, so they are never up for a claim.
   */
  async *discover(ctx: CallContext): AsyncIterable<ExternalMachine> {
    const regions = new Set(this.config.regions);
    const wanted = this.config.discoverTag;
    const members = await poolMembers(this.client, ctx.signal, { fresh: true });
    const named = networkNamer(this.client, ctx.signal, this.context.log);
    const seen = new Set<number>();
    const queries: Record<string, string>[] = [
      wanted !== undefined ? { tag_name: wanted } : {},
      { type: 'gpus' },
    ];
    for (const query of queries)
      for await (const droplet of this.client.pages<DoDroplet>('/droplets', 'droplets', {
        query,
        signal: ctx.signal,
        budget: 'sweep',
      })) {
        if (seen.has(droplet.id) || !regions.has(droplet.region.slug)) continue;
        if (isKubernetesNode(droplet)) continue;
        if (query.type === 'gpus' && wanted !== undefined && !hasTag(droplet, wanted)) continue;
        seen.add(droplet.id);
        const machine = await named(toMachine(droplet));
        // The label comes from the pool's member list only (toMachine drops a forged tag's).
        const pool = members.get(droplet.id);
        yield pool === undefined
          ? machine
          : { ...machine, labels: { ...machine.labels, [labels.autoscalePool]: pool } };
      }
  }

  /** Makes the tag object exist: one that already does is fine. */
  protected ensureTag(name: string, signal: AbortSignal): Promise<void> {
    return ensureTag(this.client, name, signal);
  }

  /** Puts a tag on a Droplet; DO answers 204. */
  protected assignTag(name: string, dropletId: number, signal: AbortSignal): Promise<void> {
    return assignTag(this.client, name, dropletId, signal);
  }

  /** Takes a tag off one Droplet (never a bulk call); a Droplet or tag that is gone counts as done. */
  protected unassignTag(name: string, dropletId: number, signal: AbortSignal): Promise<void> {
    return unassignTag(this.client, name, dropletId, signal);
  }

  async claim(
    id: string,
    instanceId: string,
    ctx: CallContext,
    options: { managed?: boolean } = {},
  ): Promise<ExternalMachine> {
    const { signal } = ctx;
    const droplet = await this.droplet(id, signal);
    if (!droplet) throw notFound(id);
    if (!this.config.regions.includes(droplet.region.slug))
      throw fail(
        'INVALID_INPUT',
        `Droplet ${droplet.id} is in ${droplet.region.slug}, which this account does not use`,
        'region',
      );
    const ours = tagFor(labels.instance, instanceId);
    if (instanceTagsOf(droplet).some((t) => t.toLowerCase() !== ours)) {
      // Our tag next to a rival's is what a failed back-out leaves, and neither claimer can tell
      // who won: each drops its own tag when it next looks, so the Droplet ends up with one.
      if (hasTag(droplet, ours)) await this.backOut(droplet, ours, signal);
      throw claimedByAnother(droplet);
    }
    // A DOKS worker carries the pool's tags (this deployment's among them): a managed claim would
    // let a vps delete destroy a cluster node behind DOKS's back.
    if (isKubernetesNode(droplet))
      throw fail(
        'INVALID_STATE',
        `Droplet ${droplet.id} is a DigitalOcean Kubernetes node, which DOKS manages itself`,
        'kubernetesNode',
      );
    if ((await poolMembers(this.client, signal)).has(droplet.id))
      throw fail(
        'INVALID_STATE',
        `Droplet ${droplet.id} belongs to a DigitalOcean autoscale pool, which scales it itself`,
        'autoscalePool',
      );
    // The managed tag is not scoped to a deployment: next to another deployment's tag it would
    // let that deployment delete the Droplet too. Checked before any write, and again on the
    // read the managed write follows.
    if (options.managed) this.refuseOtherDeployment(droplet);

    // The instance and deployment tags first, then a verify; the managed tag, which hands
    // deletion over, only once the claim has held. A claim that loses never wrote it, so its
    // back-out can't take it from the winner.
    const missing = [ours, this.deploymentTag].filter((tag) => !hasTag(droplet, tag));
    let claimed = droplet;
    if (missing.length > 0) {
      for (const tag of missing) await this.assignTag(tag, droplet.id, signal);
      // Verify: another claim that wrote between our read and our write shows up now.
      const after = await this.droplet(id, signal);
      if (!after) throw notFound(id);
      if (instanceTagsOf(after).some((t) => t.toLowerCase() !== ours)) {
        this.context.log.warn('digitalocean.claimLost', { droplet: droplet.id });
        // Only what we added; the deployment tag stays, it names no instance.
        if (missing.includes(ours)) await this.backOut(after, ours, signal);
        throw claimedByAnother(after);
      }
      claimed = after;
    }
    // A managed write that fails leaves a plain claim, which a repeated claim completes.
    if (options.managed && !hasTag(claimed, managedTag)) {
      this.refuseOtherDeployment(claimed);
      await this.assignTag(managedTag, droplet.id, signal);
      claimed = { ...claimed, tags: [...claimed.tags, managedTag] };
    }
    return networkNamer(this.client, signal, this.context.log)(toMachine(claimed));
  }

  /** `INVALID_STATE` (`otherDeployment`) for a Droplet that carries another deployment's tag. */
  protected refuseOtherDeployment(droplet: DoDroplet): void {
    const other = (droplet.tags ?? []).some((t) => {
      const tag = t.toLowerCase();
      return tag.startsWith(deploymentTagPrefix) && tag !== this.deploymentTag;
    });
    if (other)
      throw fail(
        'INVALID_STATE',
        `Droplet ${droplet.id} carries another better-compute deployment's tag, so it is never handed to this one for deletion`,
        'otherDeployment',
      );
  }

  /** Takes our instance tag off a Droplet we lost; a failure is logged, the claim is lost anyway. */
  protected async backOut(droplet: DoDroplet, ours: string, signal: AbortSignal): Promise<void> {
    try {
      await this.unassignTag(spelled(droplet, ours), droplet.id, signal);
    } catch (error) {
      this.context.log.error('digitalocean.claimBackoutFailed', {
        droplet: droplet.id,
        error: isComputeError(error) ? error.code : 'unknown',
      });
    }
  }

  async release(id: string, instanceId: string, ctx: CallContext): Promise<void> {
    const { signal } = ctx;
    const droplet = await this.droplet(id, signal);
    if (!droplet) return;
    const ours = tagFor(labels.instance, instanceId);
    const claimed = hasTag(droplet, ours);
    const rivals = instanceTagsOf(droplet).some((t) => t.toLowerCase() !== ours);
    if (claimed) {
      // The managed tag goes first: if a later call fails, the Droplet is still the instance's
      // and a retry finishes the job, whereas the other order would leave a deletable Droplet
      // that no instance claims. It stays while another instance tag is on the Droplet.
      if (!rivals && hasTag(droplet, managedTag))
        await this.unassignTag(spelled(droplet, managedTag), droplet.id, signal);
      await this.unassignTag(spelled(droplet, ours), droplet.id, signal);
    }
    // Once no instance tag is left, nothing of this deployment claims the Droplet, so its
    // deployment tag goes last: left behind, it would make the Droplet this deployment's again
    // when another deployment claims it. A retry of a release that failed before this finishes
    // it (no instance tag, no managed tag). A managed tag that this call did not remove (a rival
    // kept it, or the instance tag was already gone) keeps the deployment tag next to it.
    // A DOKS worker keeps it: there it is its node pool's ownership tag, not a claim's.
    if (
      !rivals &&
      (claimed || !hasTag(droplet, managedTag)) &&
      hasTag(droplet, this.deploymentTag) &&
      !isKubernetesNode(droplet)
    )
      await this.unassignTag(spelled(droplet, this.deploymentTag), droplet.id, signal);
  }
}

function noCatalog(ref: string): ComputeError {
  return fail(
    'UNSUPPORTED',
    `catalog image ${ref} needs the provider's catalogImages option`,
    'catalogImage',
  );
}

/** The `better-compute-instance:*` tags a Droplet carries. */
function instanceTagsOf(droplet: DoDroplet): string[] {
  return (droplet.tags ?? []).filter((t) => t.toLowerCase().startsWith(instanceTagPrefix));
}

function claimedByAnother(droplet: DoDroplet): ComputeError {
  return new ComputeError(
    'CONFLICT',
    `Droplet ${droplet.id} is already claimed by another instance`,
    undefined,
    { provider: 'digitalocean', id: String(droplet.id), reason: 'claimedByAnother' },
  );
}
