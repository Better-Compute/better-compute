import {
  ComputeError,
  isComputeError,
  type CallContext,
  type ExternalMachine,
  type ExternalReservation,
  type ImageRef,
  type NetworkRef,
  type Offer,
  type OfferQuery,
  type PowerAction,
  type ProviderContext,
  type ProviderImpl,
} from '@better-compute/core';
import type { QueryClient, QueryParams, XmlElement } from '@better-compute/aws-core';
import type { AccountCredentials } from './account.js';
import { parseDiscoverTag, type AwsConfig, type AwsProviderOptions } from './config.js';
import { clientToken, offerId, parseInstanceId, parseOfferId, tags, tagValue } from './ids.js';
import { aliasRootDeviceOf, resolveImage, ssmImagePrefixes } from './images.js';
import {
  toMachine,
  type InstanceTypeCache,
  type InstanceTypeInfo,
  type ZoneCache,
} from './shapes.js';
import { packUserData } from './userdata.js';
import {
  liveReservationStates,
  matchesQuery,
  parseCapacityReservation,
  reservationOffer,
  toReservation,
  usable,
  type CapacityReservationInfo,
} from './markets/reservations.js';

export interface AwsComputeDeps {
  ec2: QueryClient;
  account: AccountCredentials;
  types: InstanceTypeCache;
  zones: ZoneCache;
}

export interface AwsCreateRequest {
  offerId: string;
  image: ImageRef;
  userData: string;
  name: string;
  network?: NetworkRef;
  labels?: Readonly<Record<string, string>>;
  sshKeys?: readonly string[];
}

const offeringsTtlMs = 3_600_000;
const imageTtlMs = 86_400_000;
/** EC2 allows 50 tags per resource; ours take 3, the rest is for tenant labels. */
const maxLabels = 40;

/** `stateReason.code` of a terminated instance → what `get` reports. */
function terminatedFailure(code: string | undefined): ComputeError | 'error' | undefined {
  if (code === 'Server.InsufficientInstanceCapacity')
    return new ComputeError(
      'CAPACITY_UNAVAILABLE',
      'EC2 had no capacity for the instance',
      undefined,
      {
        provider: 'aws',
        reason: code,
      },
    );
  if (code === 'Client.VolumeLimitExceeded')
    return new ComputeError(
      'QUOTA_EXCEEDED',
      'the EBS volume limit was reached launching the instance',
      undefined,
      {
        provider: 'aws',
        reason: code,
      },
    );
  if (code === 'Server.InternalError') return 'error';
  return undefined;
}

const rebootLike = { waits: ['pending', 'stopping'], accepts: ['running'] } as const;
/**
 * Per power action, the EC2 states it waits out (a retryable UNAVAILABLE, so the reconciler comes
 * back) and the states EC2 accepts it in. EC2 answers StartInstances on a stopping instance and
 * StopInstances on a pending one with IncorrectInstanceState; vps would fail the instance for good
 * on that INVALID_STATE, and `get` reports stopping as stopped, so vps does ask to start it.
 */
const powerStates: Record<PowerAction, { waits: readonly string[]; accepts: readonly string[] }> = {
  on: { waits: ['stopping'], accepts: ['pending', 'running', 'stopped'] },
  'graceful-off': { waits: ['pending'], accepts: ['running', 'stopping', 'stopped'] },
  off: { waits: ['pending'], accepts: ['running', 'stopping', 'stopped'] },
  reset: rebootLike,
  cycle: rebootLike,
  'graceful-restart': rebootLike,
  nmi: rebootLike,
};

/** `state` undefined: the instance changed state while the action ran. */
function transitional(id: string, state?: string): ComputeError {
  return new ComputeError(
    'UNAVAILABLE',
    state === undefined
      ? `instance ${id} changed state during the power action; it is retried`
      : `instance ${id} is ${state}; the power action waits for it to settle`,
    undefined,
    { provider: 'aws', reason: 'transitional-state', ...(state === undefined ? {} : { state }) },
  );
}

/** EC2 tag writes are eventually consistent: a read right after CreateTags may not show them. */
function tagPropagation(id: string): ComputeError {
  return new ComputeError(
    'UNAVAILABLE',
    `EC2 does not show the ownership tags just written on instance ${id} yet; it is retried`,
    undefined,
    { provider: 'aws', reason: 'tag-propagation' },
  );
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

/** One AWS account's EC2 client (`ProviderImpl`). */
export class AwsCompute implements ProviderImpl {
  #offerings: { pairs: [string, string][]; at: number } | undefined;
  readonly #created = new Map<string, number>();
  /** Instance id → when this client last claimed it with `managed` (tags lag behind writes). */
  readonly #managedClaims = new Map<string, number>();
  readonly #rootDevices = new Map<string, { device: string | undefined; at: number }>();
  readonly #loggedSsm = new Set<string>();
  /** Error codes already logged once (an unreadable market read is warned once per code). */
  readonly #warned = new Set<string>();
  readonly #ssmPrefixes: readonly string[];

  constructor(
    readonly config: AwsConfig,
    readonly context: ProviderContext,
    readonly options: AwsProviderOptions,
    readonly deps: AwsComputeDeps,
  ) {
    this.#ssmPrefixes = ssmImagePrefixes(options.ssmImagePrefixes);
  }

  /** How long EC2 may not yet show what this client just launched or tagged. */
  protected get consistencyWindowMs(): number {
    return this.options.consistencyWindowMs ?? 120_000;
  }

  /**
   * Whether `id` is in `map` (id → time) and younger than the consistency window. Older entries
   * are dropped on the way: they are inserted in time order, so the sweep stops at the first young
   * one and the map holds only what the window still needs.
   */
  protected recent(map: Map<string, number>, id: string): boolean {
    const now = this.context.clock.now();
    for (const [key, at] of map) {
      if (now - at < this.consistencyWindowMs) break;
      map.delete(key);
    }
    const at = map.get(id);
    return at !== undefined && now - at < this.consistencyWindowMs;
  }

  /** Records `id` at the current time (moving it to the end, so the map stays in time order). */
  #remember(map: Map<string, number>, id: string): void {
    this.recent(map, id);
    map.delete(id);
    map.set(id, this.context.clock.now());
  }

  /** Every EC2 call runs after the account's identity checks (memoized). */
  protected async ready(signal: AbortSignal): Promise<void> {
    await this.deps.account.verify({ signal, clock: this.context.clock });
  }

  protected async call(
    action: string,
    params: QueryParams,
    signal: AbortSignal,
  ): Promise<XmlElement> {
    await this.ready(signal);
    return this.deps.ec2.call(action, params, { signal });
  }

  // --- Offers -------------------------------------------------------------------------------------

  async #offeringPairs(signal: AbortSignal): Promise<[string, string][]> {
    const now = this.context.clock.now();
    if (this.#offerings && now - this.#offerings.at < offeringsTtlMs) return this.#offerings.pairs;
    const pairs: [string, string][] = [];
    const seen = new Set<string>();
    let token: string | undefined;
    do {
      const doc = await this.call(
        'DescribeInstanceTypeOfferings',
        {
          LocationType: 'availability-zone',
          Filter: [{ Name: 'location', Value: this.config.zones }],
          MaxResults: 1000,
          NextToken: token,
        },
        signal,
      );
      for (const item of doc.items('instanceTypeOfferingSet')) {
        const zone = item.textOf('location');
        const type = item.textOf('instanceType');
        if (zone && type && this.config.zones.includes(zone)) pairs.push([zone, type]);
      }
      token = doc.textOf('nextToken') || undefined;
      if (token && seen.has(token))
        throw new ComputeError(
          'PROVIDER_ERROR',
          'AWS returned a pagination token twice',
          undefined,
          {
            provider: 'aws',
            reason: 'pagination-loop',
          },
        );
      if (token) seen.add(token);
    } while (token);
    pairs.sort(([az, at], [bz, bt]) =>
      az === bz ? (at < bt ? -1 : at > bt ? 1 : 0) : az < bz ? -1 : 1,
    );
    this.#offerings = { pairs, at: now };
    return pairs;
  }

  async listOffers(query: OfferQuery): Promise<Offer[]> {
    if (query.region !== undefined && query.region !== this.config.region) return [];
    if (query.kind === 'metal') return [];
    const signal = AbortSignal.timeout(60_000);
    const pairs = await this.#offeringPairs(signal);
    const types = await this.#types([...new Set(pairs.map(([, type]) => type))], signal);
    const offers: Offer[] = [];
    for (const [zone, type] of pairs) {
      const info = types.get(type);
      if (!info || info.bareMetal) continue;
      if (query.gpuModel !== undefined && info.gpus?.model !== query.gpuModel) continue;
      if (query.minGpus !== undefined && (info.gpus?.count ?? 0) < query.minGpus) continue;
      if (query.minVcpu !== undefined && info.vcpu < query.minVcpu) continue;
      if (query.minMemoryGiB !== undefined && info.memoryGiB < query.minMemoryGiB) continue;
      offers.push({
        id: offerId({ zone, instanceType: type, market: 'on-demand' }),
        kind: 'vps',
        region: this.config.region,
        vcpu: info.vcpu,
        memoryGiB: info.memoryGiB,
        diskGiB: this.config.rootVolumeGiB,
        ...(info.gpus ? { gpus: { ...info.gpus } } : {}),
        available: true,
        ...(info.arch[0] ? { arch: info.arch[0] } : {}),
      });
    }
    offers.push(...(await this.#reservationOffers(query, signal)));
    return offers;
  }

  // --- Capacity markets (A3): reservations ---------------------------------------------------------

  /** Warns once per (topic, code) that a market read failed; the offers it would add are left out. */
  protected warnOnce(topic: string, error: unknown): void {
    const code = isComputeError(error) ? error.code : 'error';
    if (this.#warned.has(`${topic}:${code}`)) return;
    this.#warned.add(`${topic}:${code}`);
    this.context.log.warn(`aws: ${topic} unreadable; offers leave them out`, {
      provider: 'aws',
      reason: code,
    });
  }

  /** Every live capacity reservation (ODCRs and Capacity Blocks), paged; `ids` narrows the read. */
  protected async capacityReservations(
    signal: AbortSignal,
    ids?: readonly string[],
  ): Promise<CapacityReservationInfo[]> {
    const zoneIds = await this.deps.zones.all(signal);
    const names = new Map([...zoneIds].map(([name, id]) => [id, name]));
    const out: CapacityReservationInfo[] = [];
    const seen = new Set<string>();
    let token: string | undefined;
    do {
      const doc = await this.call(
        'DescribeCapacityReservations',
        ids
          ? { CapacityReservationId: ids }
          : {
              Filter: [{ Name: 'state', Value: liveReservationStates }],
              MaxResults: 1000,
              NextToken: token,
            },
        signal,
      );
      for (const item of doc.items('capacityReservationSet')) {
        const info = parseCapacityReservation(item, names);
        if (info) out.push(info);
      }
      token = ids ? undefined : doc.textOf('nextToken') || undefined;
      if (token && seen.has(token))
        throw new ComputeError(
          'PROVIDER_ERROR',
          'AWS returned a pagination token twice',
          undefined,
          { provider: 'aws', reason: 'pagination-loop' },
        );
      if (token) seen.add(token);
    } while (token);
    return out;
  }

  /** ODCRs and Capacity Blocks better-compute can launch into, as ExternalReservations. */
  async listReservations(context: CallContext): Promise<ExternalReservation[]> {
    return this.#reservations(context.signal);
  }

  async #reservations(signal: AbortSignal): Promise<ExternalReservation[]> {
    const { account } = await this.deps.account.verify({ signal, clock: this.context.clock });
    const infos = (await this.capacityReservations(signal)).filter((info) =>
      usable(info, this.config.zones),
    );
    const types = await this.#knownTypes(
      infos.map((info) => info.instanceType),
      signal,
    );
    const out: ExternalReservation[] = [];
    for (const info of infos) {
      const reservation = toReservation(info, { region: this.config.region, account, types });
      if (reservation) out.push(reservation);
    }
    return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** Instance types by name; a type EC2 no longer knows is left out rather than failing the read. */
  async #knownTypes(
    names: readonly string[],
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string, InstanceTypeInfo>> {
    const unique = [...new Set(names)];
    if (unique.length === 0) return new Map();
    try {
      return await this.#types(unique, signal);
    } catch (error) {
      if (!isComputeError(error, 'INVALID_INPUT') && !isComputeError(error, 'PROVIDER_ERROR'))
        throw error;
      const out = new Map<string, InstanceTypeInfo>();
      for (const name of unique) {
        try {
          const hit = (await this.#types([name], signal)).get(name);
          if (hit) out.set(name, hit);
        } catch (inner) {
          if (!isComputeError(inner, 'INVALID_INPUT') && !isComputeError(inner, 'PROVIDER_ERROR'))
            throw inner;
        }
      }
      return out;
    }
  }

  /** Ready reservations with their free slots, as offers; an unreadable read leaves them out. */
  async #reservationOffers(query: OfferQuery, signal: AbortSignal): Promise<Offer[]> {
    let reservations: ExternalReservation[];
    try {
      reservations = await this.#reservations(signal);
    } catch (error) {
      if (signal.aborted) throw error;
      this.warnOnce('capacity reservations', error);
      return [];
    }
    const types = await this.#knownTypes(
      reservations.map((r) => r.machineType),
      signal,
    );
    const offers: Offer[] = [];
    for (const reservation of reservations) {
      const info = types.get(reservation.machineType);
      const offer = reservationOffer(reservation, {
        diskGiB: this.config.rootVolumeGiB,
        ...(info?.arch[0] ? { arch: info.arch[0] } : {}),
        ...(info?.bareMetal ? { bareMetal: true } : {}),
      });
      if (offer && matchesQuery(query, offer)) offers.push(offer);
    }
    return offers;
  }

  async #types(
    types: readonly string[],
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string, InstanceTypeInfo>> {
    await this.ready(signal);
    return this.deps.types.get(types, signal);
  }

  /** Maps an instance item with the type and zone-id caches. */
  protected async machine(instance: XmlElement, signal: AbortSignal): Promise<ExternalMachine> {
    const type = instance.textOf('instanceType');
    let types: ReadonlyMap<string, InstanceTypeInfo> = new Map();
    try {
      if (type) types = await this.#types([type], signal);
    } catch (error) {
      // An unknown type (a retired family) still maps, without its shape.
      if (!isComputeError(error, 'INVALID_INPUT') && !isComputeError(error, 'PROVIDER_ERROR'))
        throw error;
    }
    const zoneIds = await this.deps.zones.all(signal);
    return toMachine(instance, { region: this.config.region, types, zoneIds });
  }

  // --- create, get, delete ------------------------------------------------------------------------

  /** The root device of an image: the alias's fixed name, DescribeImages for an AMI, none for SSM. */
  async #rootDevice(
    image: ImageRef,
    imageId: string,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const alias = aliasRootDeviceOf(image);
    if (alias) return alias;
    if (imageId.startsWith('resolve:ssm:')) {
      if (!this.#loggedSsm.has(imageId)) {
        this.#loggedSsm.add(imageId);
        this.context.log.info(
          'aws: an SSM image parameter has an unknown root device; the root volume keeps the AMI defaults',
          {
            provider: 'aws',
            image: imageId.slice(0, 256),
          },
        );
      }
      return undefined;
    }
    const now = this.context.clock.now();
    const hit = this.#rootDevices.get(imageId);
    if (hit && now - hit.at < imageTtlMs) return hit.device;
    let doc: XmlElement;
    try {
      doc = await this.call('DescribeImages', { ImageId: [imageId] }, signal);
    } catch (error) {
      if (isComputeError(error, 'NOT_FOUND'))
        throw new ComputeError(
          'INVALID_INPUT',
          `image ${imageId} does not exist in ${this.config.region}`,
          undefined,
          {
            provider: 'aws',
            reason: 'image',
          },
        );
      throw error;
    }
    const device = doc.items('imagesSet')[0]?.textOf('rootDeviceName');
    this.#rootDevices.set(imageId, { device, at: now });
    return device;
  }

  #tagSpecifications(request: AwsCreateRequest, context: CallContext) {
    const entries = new Map<string, string>();
    const labels = Object.entries(request.labels ?? {})
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, maxLabels);
    for (const [key, value] of labels) {
      const tag = labelKey(key);
      if (tag) entries.set(tag, tagValue(value));
    }
    // The ownership tags win over tenant labels.
    entries.set(tags.name, tagValue(request.name));
    entries.set(tags.managed, 'true');
    entries.set(tags.instance, tagValue(context.idempotencyKey));
    const sorted = [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const tagList = sorted.map(([Key, Value]) => ({ Key, Value }));
    return [
      { ResourceType: 'instance', Tag: tagList },
      { ResourceType: 'volume', Tag: tagList },
    ];
  }

  async create(request: AwsCreateRequest, context: CallContext): Promise<ExternalMachine> {
    const offer = parseOfferId(request.offerId);
    if (offer.reservation !== undefined || offer.market === 'spot')
      throw new ComputeError(
        'UNSUPPORTED',
        'capacity reservation and spot offers arrive with AWS phase A3',
        undefined,
        {
          provider: 'aws',
          reason: 'phase-a3',
        },
      );
    if (!this.config.zones.includes(offer.zone))
      throw new ComputeError(
        'INVALID_INPUT',
        `zone ${offer.zone} is not one of this account's zones`,
        undefined,
        {
          provider: 'aws',
          reason: 'zone',
        },
      );
    const { signal } = context;
    const info = (await this.#types([offer.instanceType], signal)).get(offer.instanceType);
    if (!info)
      throw new ComputeError(
        'INVALID_INPUT',
        `instance type ${offer.instanceType} does not exist in ${this.config.region}`,
        undefined,
        {
          provider: 'aws',
          reason: 'instance-type',
        },
      );
    const imageId = resolveImage(request.image, info.arch[0] ?? 'x86_64', this.#ssmPrefixes);
    const rootDevice = await this.#rootDevice(request.image, imageId, signal);
    const userData = packUserData(request.userData, request.sshKeys);
    const subnet = request.network?.subnet ?? this.config.subnetId;
    const groups = this.config.securityGroupIds ?? [];
    const params: QueryParams = {
      ClientToken: clientToken(context.idempotencyKey),
      MinCount: 1,
      MaxCount: 1,
      InstanceType: offer.instanceType,
      Placement: { AvailabilityZone: offer.zone },
      ImageId: imageId,
      UserData: userData.base64 === '' ? undefined : userData.base64,
      MetadataOptions: {
        HttpTokens: 'required',
        HttpEndpoint: 'enabled',
        HttpPutResponseHopLimit: this.config.metadataHopLimit,
        InstanceMetadataTags: 'disabled',
      },
      BlockDeviceMapping: rootDevice
        ? [
            {
              DeviceName: rootDevice,
              Ebs: {
                VolumeSize: this.config.rootVolumeGiB,
                VolumeType: this.config.rootVolumeType,
                Encrypted: true,
                KmsKeyId: this.config.kmsKeyId,
                DeleteOnTermination: true,
              },
            },
          ]
        : undefined,
      NetworkInterface: subnet
        ? [
            {
              DeviceIndex: 0,
              SubnetId: subnet,
              SecurityGroupId: groups.length ? groups : undefined,
              AssociatePublicIpAddress: this.config.associatePublicIp,
              DeleteOnTermination: true,
            },
          ]
        : undefined,
      SecurityGroupId: !subnet && groups.length ? groups : undefined,
      IamInstanceProfile: this.config.instanceProfile
        ? { Arn: this.config.instanceProfile }
        : undefined,
      InstanceInitiatedShutdownBehavior: 'stop',
      TagSpecification: this.#tagSpecifications(request, context),
    };
    const doc = await this.call('RunInstances', params, signal);
    const instance = doc.items('instancesSet')[0];
    const id = instance?.textOf('instanceId');
    if (!instance || !id)
      throw new ComputeError('PROVIDER_ERROR', 'RunInstances returned no instance', undefined, {
        provider: 'aws',
      });
    if (!this.recent(this.#created, id)) this.#created.set(id, this.context.clock.now());
    return this.machine(instance, signal);
  }

  /** The instance item by id; undefined when EC2 says it does not exist. */
  protected async describe(id: string, signal: AbortSignal): Promise<XmlElement | undefined> {
    try {
      const doc = await this.call('DescribeInstances', { InstanceId: [id] }, signal);
      return doc
        .items('reservationSet')
        .flatMap((reservation) => reservation.items('instancesSet'))
        .find((item) => item.textOf('instanceId') === id);
    } catch (error) {
      if (isComputeError(error, 'NOT_FOUND')) return undefined;
      throw error;
    }
  }

  async #byClientToken(id: string, context: CallContext): Promise<XmlElement | undefined> {
    const doc = await this.call(
      'DescribeInstances',
      { Filter: [{ Name: 'client-token', Value: [clientToken(context.idempotencyKey)] }] },
      context.signal,
    );
    return doc
      .items('reservationSet')
      .flatMap((reservation) => reservation.items('instancesSet'))
      .find((item) => item.textOf('instanceId') === id);
  }

  async get(id: string, context: CallContext): Promise<ExternalMachine | undefined> {
    try {
      parseInstanceId(id);
    } catch {
      return undefined;
    }
    let instance = await this.describe(id, context.signal);
    // EC2 is eventually consistent right after RunInstances: the ClientToken finds it sooner.
    instance ??= await this.#byClientToken(id, context);
    if (!instance) {
      if (this.recent(this.#created, id)) return { id, state: 'pending', addresses: [] };
      return undefined;
    }
    const machine = await this.machine(instance, context.signal);
    if (instance.child('instanceState')?.textOf('name') === 'terminated') {
      const failure = terminatedFailure(instance.child('stateReason')?.textOf('code'));
      if (failure instanceof ComputeError) throw failure;
      if (failure === 'error') return { ...machine, state: 'error' };
    }
    return machine;
  }

  async delete(id: string, context: CallContext): Promise<void> {
    parseInstanceId(id);
    // The same reads as get: by id, then by client token (EC2 lags right after RunInstances).
    const instance =
      (await this.describe(id, context.signal)) ?? (await this.#byClientToken(id, context));
    if (!instance) {
      // Never seen and not ours recently: gone. Ours and not yet visible: RunInstances tagged it
      // managed, so terminate it rather than report a delete that leaves it running.
      if (!this.recent(this.#created, id)) return;
      await this.#terminate(id, context);
      return;
    }
    const state = instance.child('instanceState')?.textOf('name');
    if (state === 'terminated' || state === 'shutting-down') return;
    const tagged = new Map(
      instance.items('tagSet').map((item) => [item.textOf('key'), item.textOf('value')]),
    );
    // Just claimed with managed by this client: EC2 may not show the tag yet. Retry, never fail.
    if (tagged.get(tags.managed) !== 'true' && this.recent(this.#managedClaims, id))
      throw tagPropagation(id);
    if (tagged.get(tags.managed) !== 'true')
      throw new ComputeError(
        'INVALID_STATE',
        `instance ${id} is not managed by better-compute`,
        undefined,
        {
          provider: 'aws',
          reason: 'not-managed',
        },
      );
    await this.#terminate(id, context);
  }

  /**
   * TerminateInstances. NOT_FOUND is success (already gone), except for an instance this client
   * launched inside the consistency window: EC2 may simply not show it yet, so that is a retryable
   * UNAVAILABLE (vps treats NOT_FOUND and success alike: deleted).
   */
  async #terminate(id: string, context: CallContext): Promise<void> {
    try {
      await this.call('TerminateInstances', { InstanceId: [id] }, context.signal);
    } catch (error) {
      if (isComputeError(error, 'NOT_FOUND')) {
        if (!this.recent(this.#created, id)) return;
        throw new ComputeError(
          'UNAVAILABLE',
          `instance ${id} was just launched and EC2 does not show it yet; retry the delete`,
          undefined,
          { provider: 'aws', reason: 'eventual-consistency' },
        );
      }
      if (isComputeError(error, 'INVALID_STATE') && error.details?.code === 'OperationNotPermitted')
        throw new ComputeError(
          'INVALID_STATE',
          `instance ${id} has termination protection on`,
          undefined,
          {
            provider: 'aws',
            reason: 'termination-protected',
          },
        );
      throw error;
    }
  }

  // --- power, reinstall, list ---------------------------------------------------------------------

  /** The instance's tags, or NOT_FOUND. */
  async #tagged(
    id: string,
    signal: AbortSignal,
  ): Promise<{ instance: XmlElement; tags: Map<string, string> }> {
    parseInstanceId(id);
    const instance = await this.describe(id, signal);
    if (!instance)
      throw new ComputeError('NOT_FOUND', `instance ${id} does not exist`, undefined, {
        provider: 'aws',
      });
    const found = new Map<string, string>();
    for (const item of instance.items('tagSet')) {
      const key = item.textOf('key');
      if (key !== undefined) found.set(key, item.textOf('value') ?? '');
    }
    return { instance, tags: found };
  }

  /** power and reinstall act only on an instance that names a better-compute instance. */
  async #claimed(id: string, signal: AbortSignal): Promise<XmlElement> {
    const { instance, tags: found } = await this.#tagged(id, signal);
    if (!found.get(tags.instance))
      throw new ComputeError(
        'INVALID_STATE',
        `${id} is not an instance of better-compute and is never changed by it`,
        undefined,
        {
          provider: 'aws',
          reason: 'not-claimed',
        },
      );
    return instance;
  }

  async power(id: string, action: PowerAction, context: CallContext): Promise<void> {
    const actions: Record<PowerAction, [string, QueryParams] | undefined> = {
      on: ['StartInstances', { InstanceId: [id] }],
      'graceful-off': ['StopInstances', { InstanceId: [id] }],
      off: ['StopInstances', { InstanceId: [id], Force: true }],
      reset: ['RebootInstances', { InstanceId: [id] }],
      cycle: ['RebootInstances', { InstanceId: [id] }],
      'graceful-restart': ['RebootInstances', { InstanceId: [id] }],
      nmi: ['SendDiagnosticInterrupt', { InstanceId: id }],
    };
    const call = Object.hasOwn(actions, action) ? actions[action] : undefined;
    if (!call)
      throw new ComputeError(
        'UNSUPPORTED',
        `EC2 has no power action ${String(action)}`,
        undefined,
        { provider: 'aws' },
      );
    const instance = await this.#claimed(id, context.signal);
    const state = instance.child('instanceState')?.textOf('name') ?? '';
    const { waits, accepts } = powerStates[action];
    if (waits.includes(state)) throw transitional(id, state);
    try {
      await this.call(call[0], call[1], context.signal);
    } catch (error) {
      // It moved between the read and the call (IncorrectInstanceState from a state EC2 accepts the
      // action in): retry. From a stable state the action cannot apply to, it stays INVALID_STATE.
      if (
        accepts.includes(state) &&
        isComputeError(error, 'INVALID_STATE') &&
        error.details?.code === 'IncorrectInstanceState'
      )
        throw transitional(id);
      throw error;
    }
  }

  async reinstall(id: string, image: ImageRef, context: CallContext): Promise<void> {
    const instance = await this.#claimed(id, context.signal);
    const type = instance.textOf('instanceType');
    const arch =
      (instance.textOf('architecture') as 'x86_64' | 'arm64' | undefined) ??
      (type ? (await this.#types([type], context.signal)).get(type)?.arch[0] : undefined) ??
      'x86_64';
    const imageId = resolveImage(image, arch === 'arm64' ? 'arm64' : 'x86_64', this.#ssmPrefixes);
    await this.call(
      'CreateReplaceRootVolumeTask',
      {
        InstanceId: id,
        ImageId: imageId,
        DeleteReplacedRootVolume: true,
        ClientToken: clientToken(`${context.idempotencyKey}:reinstall:${image}`),
      },
      context.signal,
    );
  }

  /** Pages DescribeInstances with filters, mapping every instance. */
  protected async *instances(
    filters: { Name: string; Value: string[] }[],
    context: CallContext,
  ): AsyncIterable<ExternalMachine> {
    const seen = new Set<string>();
    let token: string | undefined;
    do {
      const doc = await this.call(
        'DescribeInstances',
        { Filter: filters, MaxResults: 1000, NextToken: token },
        context.signal,
      );
      for (const reservation of doc.items('reservationSet'))
        for (const instance of reservation.items('instancesSet'))
          yield await this.machine(instance, context.signal);
      token = doc.textOf('nextToken') || undefined;
      if (token && seen.has(token))
        throw new ComputeError(
          'PROVIDER_ERROR',
          'AWS returned a pagination token twice',
          undefined,
          {
            provider: 'aws',
            reason: 'pagination-loop',
          },
        );
      if (token) seen.add(token);
    } while (token);
  }

  /** Live states: everything but terminated. */
  static readonly liveStates = ['pending', 'running', 'stopping', 'stopped', 'shutting-down'];

  list(context: CallContext): AsyncIterable<ExternalMachine> {
    return this.instances(
      [
        { Name: `tag:${tags.managed}`, Value: ['true'] },
        { Name: 'instance-state-name', Value: AwsCompute.liveStates },
      ],
      context,
    );
  }

  // --- attach: discover, claim, release -----------------------------------------------------------

  /** Every non-terminated instance the account can see, narrowed by `discoverTag`. */
  discover(context: CallContext): AsyncIterable<ExternalMachine> {
    const filters = [{ Name: 'instance-state-name', Value: AwsCompute.liveStates }];
    if (this.config.discoverTag !== undefined) {
      const [key, value] = parseDiscoverTag(this.config.discoverTag);
      filters.push({ Name: `tag:${key}`, Value: [value] });
    }
    return this.instances(filters, context);
  }

  /**
   * Writes the ownership tag. EC2 tags have no compare-and-swap: the vps unique index on the
   * external id referees between control planes, and the re-read narrows the window between two
   * writers here (a lost race is CONFLICT). EC2 tag reads are eventually consistent too: a re-read
   * that does not show the tag (or `managed`) yet is a retryable UNAVAILABLE, never a lost race.
   */
  async claim(
    id: string,
    instanceId: string,
    context: CallContext,
    options: { managed?: boolean } = {},
  ): Promise<ExternalMachine> {
    const owner = tagValue(instanceId);
    if (owner === '' || owner !== instanceId)
      throw new ComputeError(
        'INVALID_INPUT',
        'an instance id to claim with is plain text',
        undefined,
        { provider: 'aws' },
      );
    const before = await this.#tagged(id, context.signal);
    const holder = before.tags.get(tags.instance);
    if (holder && holder !== instanceId)
      throw new ComputeError(
        'CONFLICT',
        `instance ${id} is held by another better-compute instance`,
        undefined,
        {
          provider: 'aws',
          reason: 'claimed',
        },
      );
    const state = before.instance.child('instanceState')?.textOf('name');
    if (state === 'terminated' || state === 'shutting-down')
      throw new ComputeError('INVALID_STATE', `instance ${id} is ${state}`, undefined, {
        provider: 'aws',
        reason: state,
      });
    const wanted: { Key: string; Value: string }[] = [{ Key: tags.instance, Value: instanceId }];
    if (options.managed) wanted.push({ Key: tags.managed, Value: 'true' });
    if (holder !== instanceId || (options.managed && before.tags.get(tags.managed) !== 'true'))
      await this.call('CreateTags', { ResourceId: [id], Tag: wanted }, context.signal);
    const after = await this.#tagged(id, context.signal);
    const now = after.tags.get(tags.instance);
    if (!now || (options.managed && after.tags.get(tags.managed) !== 'true')) {
      if (options.managed) this.#remember(this.#managedClaims, id);
      throw tagPropagation(id);
    }
    if (now !== instanceId)
      throw new ComputeError(
        'CONFLICT',
        `instance ${id} was claimed by another control plane at the same time`,
        undefined,
        {
          provider: 'aws',
          reason: 'lost-race',
        },
      );
    if (options.managed) this.#remember(this.#managedClaims, id);
    return this.machine(after.instance, context.signal);
  }

  /** Removes the ownership (and managed) tags if they name `instanceId`; a missing instance is fine. */
  async release(id: string, instanceId: string, context: CallContext): Promise<void> {
    let current;
    try {
      current = await this.#tagged(id, context.signal);
    } catch (error) {
      if (isComputeError(error, 'NOT_FOUND')) return;
      throw error;
    }
    if (current.tags.get(tags.instance) !== instanceId) return;
    await this.call(
      'DeleteTags',
      { ResourceId: [id], Tag: [{ Key: tags.instance, Value: instanceId }, { Key: tags.managed }] },
      context.signal,
    );
  }
}
