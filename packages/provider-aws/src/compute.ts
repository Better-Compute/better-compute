import {
  ComputeError,
  isComputeError,
  type CallContext,
  type ExternalMachine,
  type ExternalReservation,
  type ReservationOffering,
  type ReservationOfferingQuery,
  type ImageRef,
  type NetworkRef,
  type Offer,
  type OfferQuery,
  type PowerAction,
  type ProviderMount,
  type ProviderPlacement,
  type ProviderContext,
  type ProviderEventBatch,
  type ProviderImpl,
  type PurchaseAttempt,
  type ProviderKubernetes,
} from '@better-compute/core';
import type {
  JsonClient,
  QueryClient,
  QueryParams,
  RestClient,
  XmlElement,
} from '@better-compute/aws-core';
import type { AccountCredentials } from './account.js';
import { parseDiscoverTag, type AwsConfig, type AwsProviderOptions } from './config.js';
import { ReadConsistency } from './consistency.js';
import { clientToken, offerId, parseInstanceId, parseOfferId, tags, tagValue } from './ids.js';
import {
  defaultEventSources,
  pollQueue,
  scanScheduledEvents,
  scheduledEventScanMs,
  type ScheduledEvent,
} from './events.js';
import {
  aliasRootDeviceOf,
  imageAllowed,
  imageOwnersOf,
  isAmiId,
  resolveImage,
  ssmImagePrefixes,
} from './images.js';
import { AwsFilesystems } from './filesystems.js';
import { AwsNetworks } from './networks.js';
import { checkPlacement, PlacementGroups, placementParams } from './placement.js';
import { InstanceTopology } from './topology.js';
import {
  toMachine,
  type InstanceTypeCache,
  type InstanceTypeInfo,
  type ZoneCache,
} from './shapes.js';
import { packUserData } from './userdata.js';
import { AwsVolumes } from './volumes.js';
import {
  liveReservationStates,
  matchesQuery,
  parseCapacityReservation,
  purchaseTag,
  reservationIdOf,
  reservationOffer,
  toReservation,
  usable,
  unusableReservation,
  type CapacityReservationInfo,
} from './markets/reservations.js';
import { quotaClassOf, quotaReader, type QuotaReader } from './markets/quotas.js';
import { priceReader, type PriceReader } from './markets/pricing.js';
import {
  blockOfferingId,
  checkOfferingQuery,
  maxBlockInstances,
  odcrOffering,
  parseOfferingId,
  type ParsedOffering,
} from './markets/purchases.js';

/** (A4) How long a scheduled-event scan the IAM policy refuses waits before it is tried again. */
const scanDeniedBackoffMs = 3_600_000;

export interface AwsComputeDeps {
  ec2: QueryClient;
  /** (A3) Service Quotas (JSON 1.1); absent: offers carry no quota headroom. */
  quotas?: JsonClient;
  /** (A3) The Price List Query API (JSON 1.1); absent: offers carry no on-demand price. */
  pricing?: JsonClient;
  /** (A4) The event-intake queue's client, when the account names `eventQueueUrl`. */
  sqs?: JsonClient;
  /** SSM Parameter Store; reinstall of a `resolve:ssm:` image needs it (UNSUPPORTED without). */
  ssm?: JsonClient;
  /** (A10) Amazon EFS (rest-json) and FSx (JSON 1.1); absent: no `filesystems`. */
  efs?: RestClient;
  fsx?: JsonClient;
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
  /** (A10) The placement group to launch into, made on first use. */
  placement?: ProviderPlacement;
  /** (A10) Filesystems mounted at boot, through a cloud-config part of the user data. */
  mounts?: readonly ProviderMount[];
  labels?: Readonly<Record<string, string>>;
  sshKeys?: readonly string[];
  /** (A9) A node of an EKS cluster: launched with `eksNodeInstanceProfile`, never `instanceProfile`. */
  kubernetesNode?: 'eks';
}

const offeringsTtlMs = 3_600_000;
const imageTtlMs = 86_400_000;
/**
 * How long after an attempt that may have bought a Capacity Block (its answer was lost) a retry
 * waits for EC2 to show that block before it decides the attempt bought nothing and buys. EC2's
 * reads settle in seconds; this is far beyond that.
 */
export const purchasePropagationMs = 15 * 60_000;
/**
 * `details.reason` of a retryable purchase failure raised before the purchase request was sent:
 * the attempt provably bought nothing (vps does not mark the purchase uncertain for it).
 */
export const purchaseNotSent = 'purchase-not-sent';
/** The codes vps retries a purchase on. */
const retriedPurchaseCodes: ReadonlySet<string> = new Set([
  'UNAVAILABLE',
  'RATE_LIMITED',
  'TIMEOUT',
]);
/** Clock skew allowed between vps (the purchase's request time) and EC2 (a block's createDate). */
const purchaseSkewMs = 5 * 60_000;
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

/** No EC2 read shows the instance, and it may only be lagging: the delete is retried, never done. */
function notVisible(id: string): ComputeError {
  return new ComputeError(
    'UNAVAILABLE',
    `EC2 does not show instance ${id} (yet); the delete is retried until it shows or has been missing for the consistency window`,
    undefined,
    { provider: 'aws', reason: 'eventual-consistency' },
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

/** The EBS volume id attached at the instance's root device (DescribeInstances), if any. */
function rootVolumeOf(instance: XmlElement): string | undefined {
  const root = instance.textOf('rootDeviceName');
  if (!root) return undefined;
  const mapping = instance
    .items('blockDeviceMapping')
    .find((item) => item.textOf('deviceName') === root);
  const volume = mapping?.child('ebs')?.textOf('volumeId');
  return volume && /^vol-[0-9a-f]{8,17}$/.test(volume) ? volume : undefined;
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

/** The region of an AWS zone name (the zone itself when it is not one). */
export function zoneRegionOf(zone: string): string {
  const match = /^([a-z]{2}(?:-gov)?-[a-z]+-\d{1,2})(?:[a-z]|-[a-z]{2,10}-\d{1,2}[a-z])$/.exec(
    zone,
  );
  return match ? match[1]! : zone;
}

/** One AWS account's EC2 client (`ProviderImpl`). */
export class AwsCompute implements ProviderImpl {
  /** Managed Kubernetes (EKS clusters and node groups); the provider sets it. */
  kubernetes?: ProviderKubernetes;
  #offerings: { pairs: [string, string][]; at: number } | undefined;
  /** Instance id → when this client launched it. Only a hint: another process may have launched it. */
  readonly #created = new Map<string, number>();
  /**
   * By-id instance reads that missed. Which process launched an instance is no test of whether EC2
   * may still not show it (another replica, or this one before a restart, may have), so a first
   * miss opens the consistency window for any id.
   */
  readonly #lag: ReadConsistency;
  /** Instance id → when this client last claimed it with `managed` (tags lag behind writes). */
  readonly #managedClaims = new Map<string, number>();
  /** Instance id → when this client last wrote or saw its own ownership tag on it in `claim`. */
  readonly #claims = new Map<string, number>();
  /**
   * AMI id → its root device, (A10) architecture and whether a tenant may launch it (DescribeImages,
   * cached a day).
   */
  readonly #images = new Map<
    string,
    { device: string | undefined; arch?: string; allowed: boolean; at: number }
  >();
  readonly #loggedSsm = new Set<string>();
  /** Error codes already logged once (an unreadable market read is warned once per code). */
  readonly #warned = new Set<string>();
  readonly #ssmPrefixes: readonly string[];
  /** Tenant networks on this account's VPCs (AWS A2). */
  readonly networks: AwsNetworks;
  /** (A5) EBS volumes and snapshots on this account. */
  readonly volumes: AwsVolumes;
  readonly #quotas: QuotaReader | undefined;
  readonly #prices: PriceReader;
  /** (A4, no queue) When the last DescribeInstanceStatus scan succeeded. */
  #scannedAt: number | undefined;
  /** (A4) A failed scan's backoff: no scan before this time. */
  #scanRetryAt: number | undefined;
  /** (A4) The scheduled events the last complete scan listed (a vanished one is completed). */
  #scheduled: ReadonlyMap<string, ScheduledEvent> = new Map();
  readonly #imageOwners: readonly string[];
  /** (A10) Shared filesystems (EFS, FSx for Lustre) on those networks. */
  readonly filesystems?: AwsFilesystems;
  /** (A10) EC2 placement group strategies `create({ placement })` launches into. */
  readonly placementStrategies = ['cluster', 'spread', 'partition'] as const;
  /** (A10) Placement groups made on first use. */
  readonly #placementGroups: PlacementGroups;
  /** (A10) Network nodes of running EFA machines. */
  readonly #topology: InstanceTopology;

  constructor(
    readonly config: AwsConfig,
    readonly context: ProviderContext,
    readonly options: AwsProviderOptions,
    readonly deps: AwsComputeDeps,
  ) {
    this.#ssmPrefixes = ssmImagePrefixes(options.ssmImagePrefixes);
    this.#imageOwners = imageOwnersOf(options.imageOwners);
    this.#lag = new ReadConsistency(context.clock, () => this.consistencyWindowMs);
    this.networks = new AwsNetworks({
      config,
      context,
      call: (action, params, signal) => this.call(action, params, signal),
      consistencyWindowMs: () => this.consistencyWindowMs,
    });
    this.volumes = new AwsVolumes(
      config,
      context,
      { call: (action, params, signal) => this.call(action, params, signal) },
      options.consistencyWindowMs ?? 120_000,
    );
    this.#quotas =
      config.quotas && deps.quotas
        ? quotaReader({
            client: deps.quotas,
            clock: context.clock,
            usage: (signal) => this.#quotaUsage(signal),
            onError: (error) => this.warnOnce('EC2 vCPU quotas', error),
          })
        : undefined;
    this.#prices = priceReader({
      mode: config.pricing,
      region: config.region,
      zones: config.zones,
      clock: context.clock,
      ...(deps.pricing ? { pricing: deps.pricing } : {}),
      ec2: deps.ec2,
      ready: (signal) => this.ready(signal),
      onError: (topic, error) => this.warnOnce(topic, error),
    });
    this.#placementGroups = new PlacementGroups(
      (action, params, signal) => this.call(action, params, signal),
      context.clock,
    );
    this.#topology = new InstanceTopology(
      (action, params, signal) => this.call(action, params, signal),
      context.clock,
      context.log,
    );
    if (deps.efs && deps.fsx)
      this.filesystems = new AwsFilesystems({
        config,
        context,
        efs: deps.efs,
        fsx: deps.fsx,
        networks: this.networks,
      });
  }

  /** `us-east-1a` and the Local Zone `us-west-2-lax-1a` are in `us-east-1` and `us-west-2`. */
  zoneRegion(zone: string): string {
    return zoneRegionOf(zone);
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

  /**
   * Whether no read finding instance `id` may still be EC2's eventual consistency: launched by this
   * client inside the window, or first missed by this process less than the window ago (it may be
   * another process's launch). False once it has been missing for the whole window: gone.
   */
  #mayLag(id: string): boolean {
    return this.#lag.mayLag(id, this.recent(this.#created, id) ? this.#created.get(id) : undefined);
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
      if (this.config.spot)
        offers.push({
          ...offers[offers.length - 1]!,
          id: offerId({ zone, instanceType: type, market: 'spot' }),
          market: 'spot',
        });
    }
    await this.#applyQuotas(offers, signal);
    await this.#applyPrices(offers, signal);
    offers.push(...(await this.#reservationOffers(query, signal)));
    return offers;
  }

  // --- Capacity markets (A3): prices -------------------------------------------------------------

  /** On-demand prices by type and Spot prices by zone and type; unknown prices stay unset. */
  async #applyPrices(offers: Offer[], signal: AbortSignal): Promise<void> {
    if (this.config.pricing === 'off' || offers.length === 0) return;
    const onDemand = await this.#prices.onDemand(signal);
    const spot = offers.some((offer) => offer.market === 'spot')
      ? await this.#prices.spot(signal)
      : new Map();
    for (const offer of offers) {
      const { zone, instanceType } = parseOfferId(offer.id);
      const price =
        offer.market === 'spot' ? spot.get(`${zone}/${instanceType}`) : onDemand.get(instanceType);
      if (!price) continue;
      offer.pricePerHour = price.pricePerHour;
      offer.currency = price.currency;
    }
  }

  // --- Capacity markets (A3): quotas -------------------------------------------------------------

  /** Caps on-demand and Spot offers at the quota headroom of their family: `count` machines. */
  async #applyQuotas(offers: Offer[], signal: AbortSignal): Promise<void> {
    if (!this.#quotas || offers.length === 0) return;
    const codeOf = (offer: Offer) => {
      const quota = quotaClassOf(parseOfferId(offer.id).instanceType);
      return quota ? (offer.market === 'spot' ? quota.spot : quota.onDemand) : undefined;
    };
    const codes = offers.map(codeOf).filter((code): code is string => code !== undefined);
    const headroom = await this.#quotas.headroom(codes, signal);
    for (const offer of offers) {
      const code = codeOf(offer);
      const room = code === undefined ? undefined : headroom.get(code);
      if (room === undefined || offer.vcpu <= 0) continue;
      offer.count = Math.floor(room / offer.vcpu);
      offer.available = offer.count > 0;
    }
  }

  /**
   * vCPUs in use per quota code: the default vCPUs of every pending or running instance (EC2's
   * "Running" quotas), Spot ones against the Spot code. Capacity Block instances are left out.
   */
  async #quotaUsage(signal: AbortSignal): Promise<Map<string, number>> {
    const found: { type: string; lifecycle: string | undefined }[] = [];
    const seen = new Set<string>();
    let token: string | undefined;
    do {
      const doc = await this.call(
        'DescribeInstances',
        {
          Filter: [{ Name: 'instance-state-name', Value: ['pending', 'running'] }],
          MaxResults: 1000,
          NextToken: token,
        },
        signal,
      );
      for (const reservation of doc.items('reservationSet'))
        for (const instance of reservation.items('instancesSet')) {
          const type = instance.textOf('instanceType');
          if (type) found.push({ type, lifecycle: instance.textOf('instanceLifecycle') });
        }
      token = doc.textOf('nextToken') || undefined;
      if (token && seen.has(token))
        throw new ComputeError(
          'PROVIDER_ERROR',
          'AWS returned a pagination token twice',
          undefined,
          { provider: 'aws', reason: 'pagination-loop' },
        );
      if (token) seen.add(token);
    } while (token);
    const types = await this.#knownTypes(
      found.map((entry) => entry.type),
      signal,
    );
    const usage = new Map<string, number>();
    for (const { type, lifecycle } of found) {
      if (lifecycle === 'capacity-block') continue;
      const quota = quotaClassOf(type);
      const vcpu = types.get(type)?.vcpu;
      if (!quota || vcpu === undefined) continue;
      const code = lifecycle === 'spot' ? quota.spot : quota.onDemand;
      usage.set(code, (usage.get(code) ?? 0) + vcpu);
    }
    return usage;
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
    filters: readonly { Name: string; Value: readonly string[] }[] = [
      { Name: 'state', Value: liveReservationStates },
    ],
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
              Filter: filters.map(({ Name, Value }) => ({ Name, Value: [...Value] })),
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

  // --- Capacity markets (A3): buying capacity ---------------------------------------------------

  /** The currency EC2 prices this partition in. */
  get #currency(): string {
    return this.config.region.startsWith('cn-') ? 'CNY' : 'USD';
  }

  /**
   * ODCRs the account could create now (in each of its zones that offers the type) and Capacity
   * Blocks on sale. A read: nothing is bought.
   */
  async listReservationOfferings(
    query: ReservationOfferingQuery,
    context: CallContext,
  ): Promise<ReservationOffering[]> {
    checkOfferingQuery(query);
    const { signal } = context;
    const now = this.context.clock.now();
    const info = (await this.#knownTypes([query.instanceType], signal)).get(query.instanceType);
    if (!info || info.bareMetal)
      throw new ComputeError(
        'INVALID_INPUT',
        `instance type ${query.instanceType} is not a virtual EC2 type in ${this.config.region}`,
        undefined,
        { provider: 'aws', reason: 'instance-type' },
      );
    const offered = new Set(
      (await this.#offeringPairs(signal))
        .filter(([, type]) => type === query.instanceType)
        .map(([zone]) => zone),
    );
    const out: ReservationOffering[] = [];
    for (const zone of this.config.zones) {
      if (!offered.has(zone)) continue;
      const offering = odcrOffering(query, zone, now, this.#currency);
      if (offering) out.push(offering);
    }
    if (query.count <= maxBlockInstances)
      for (const {
        offeringId: _id,
        upfrontCents: _cents,
        ...offering
      } of await this.#blockOfferings(query, signal))
        out.push(offering);
    return out.sort(
      (a, b) =>
        a.startsAt - b.startsAt ||
        a.upfrontPrice - b.upfrontPrice ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  }

  /** DescribeCapacityBlockOfferings for the query, in the account's zones, with self-describing ids. */
  async #blockOfferings(
    query: Pick<
      ReservationOfferingQuery,
      'instanceType' | 'count' | 'durationHours' | 'earliestStart' | 'latestStart'
    >,
    signal: AbortSignal,
  ): Promise<(ReservationOffering & { offeringId: string; upfrontCents: number })[]> {
    const hours = query.durationHours;
    const out: (ReservationOffering & { offeringId: string; upfrontCents: number })[] = [];
    const seen = new Set<string>();
    let token: string | undefined;
    do {
      const doc = await this.call(
        'DescribeCapacityBlockOfferings',
        {
          InstanceType: query.instanceType,
          InstanceCount: query.count,
          CapacityDurationHours: hours,
          StartDateRange:
            query.earliestStart === undefined
              ? undefined
              : new Date(query.earliestStart).toISOString(),
          EndDateRange:
            query.latestStart === undefined
              ? undefined
              : new Date(query.latestStart + hours * 3_600_000).toISOString(),
          MaxResults: 1000,
          NextToken: token,
        },
        signal,
      );
      for (const item of doc.items('capacityBlockOfferingSet')) {
        const offeringId = item.textOf('capacityBlockOfferingId');
        const zone = item.textOf('availabilityZone');
        const startsAt = Date.parse(item.textOf('startDate') ?? '');
        const endsAt = Date.parse(item.textOf('endDate') ?? '');
        const fee = Number(item.textOf('upfrontFee'));
        if (
          !offeringId ||
          !/^[a-z]{2,4}-[0-9a-f]{8,17}$/.test(offeringId) ||
          !zone ||
          !this.config.zones.includes(zone) ||
          item.textOf('instanceType') !== query.instanceType ||
          Number(item.textOf('instanceCount')) !== query.count ||
          (item.textOf('tenancy') ?? 'default') !== 'default' ||
          !Number.isFinite(startsAt) ||
          !Number.isFinite(endsAt) ||
          !Number.isFinite(fee) ||
          fee < 0
        )
          continue;
        if (query.earliestStart !== undefined && startsAt < query.earliestStart) continue;
        if (query.latestStart !== undefined && startsAt > query.latestStart) continue;
        const upfrontCents = Math.round(fee * 100);
        out.push({
          id: blockOfferingId({
            zone,
            instanceType: query.instanceType,
            count: query.count,
            hours,
            startsAt,
            upfrontPrice: fee,
            offeringId,
          }),
          instanceType: query.instanceType,
          zone,
          count: query.count,
          startsAt,
          endsAt,
          upfrontPrice: upfrontCents / 100,
          currency: item.textOf('currencyCode') ?? this.#currency,
          offeringId,
          upfrontCents,
        });
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
    return out;
  }

  /**
   * Buys an offering. **Spends money.** Off unless config `allowPurchases`, and only on a platform
   * account. Idempotent by `idempotencyKey`: the reservation carries a purchase tag (the key's
   * ClientToken), so a retry finds what an earlier attempt bought; an ODCR also sends the
   * ClientToken. A Capacity Block is bought only if EC2 still lists the confirmed offering at no
   * more than the confirmed price. PurchaseCapacityBlock has no ClientToken, so after an attempt
   * that may have bought (`attempt.uncertainSince`) a retry also looks for the block by what it
   * is, and buys again only once `purchasePropagationMs` passed without EC2 showing one.
   */
  async purchaseReservation(
    id: string,
    context: CallContext,
    attempt?: PurchaseAttempt,
  ): Promise<ExternalReservation> {
    if (!this.config.allowPurchases)
      throw new ComputeError(
        'ACCESS_DENIED',
        'this AWS account does not allow buying capacity (config allowPurchases)',
        undefined,
        { provider: 'aws', reason: 'purchases-disabled' },
      );
    if (this.context.account?.platform !== true)
      throw new ComputeError(
        'ACCESS_DENIED',
        'capacity is bought only in platform AWS accounts',
        undefined,
        { provider: 'aws', reason: 'not-platform-account' },
      );
    const offering = parseOfferingId(id, this.config.zones);
    const { signal } = context;
    const token = clientToken(context.idempotencyKey);
    // Everything before the purchase request only reads. A retryable failure there (a throttled
    // describe, an STS blip) provably bought nothing, and says so (`purchase-not-sent`): vps then
    // does not take the attempt for one that may have bought, which would hold every later attempt
    // back for `purchasePropagationMs`. From the purchase request on, any failure may have bought.
    const found = await this.#beforePurchaseRequest(async () => {
      const earlier = await this.#purchased(token, signal);
      if (earlier) return earlier;
      // PurchaseCapacityBlock takes no ClientToken, and EC2's reads are eventually consistent: when
      // an earlier attempt may have bought (its answer was lost), the block it bought may not show
      // its tag, or not show at all, yet. Look for it by what it is; until the window passes, never
      // buy again (nor take a sold-out offering for a failure): the earlier attempt may be the buyer.
      if (offering.kind === 'block' && attempt?.uncertainSince !== undefined) {
        const like = await this.#boughtBlock(
          offering,
          token,
          attempt.requestedAt,
          new Set(attempt.excludeReservationIds ?? []),
          signal,
        );
        if (like) return like;
        if (this.context.clock.now() < attempt.uncertainSince + purchasePropagationMs)
          throw new ComputeError(
            'UNAVAILABLE',
            'an earlier attempt of this purchase may have bought the Capacity Block; EC2 does not show it yet',
            undefined,
            { provider: 'aws', reason: 'purchase-propagating' },
          );
      }
      if (offering.kind === 'block') await this.#confirmBlock(offering, signal);
      else {
        const offered = (await this.#offeringPairs(signal)).some(
          ([zone, type]) => zone === offering.zone && type === offering.instanceType,
        );
        if (!offered)
          throw new ComputeError(
            'INVALID_INPUT',
            `${offering.instanceType} is not offered in ${offering.zone}`,
            undefined,
            { provider: 'aws', reason: 'offering' },
          );
      }
      // The identity check and the credentials the purchase request is signed with are resolved
      // here (both are cached), so a failure of either is still before the request.
      await this.ready(signal);
      await this.deps.account.source.credentials({ signal, clock: this.context.clock });
      return undefined;
    });
    if (found) return found;
    const purchaseTags = [
      { Key: tags.managed, Value: 'true' },
      { Key: purchaseTag, Value: token },
    ];
    let doc: XmlElement;
    if (offering.kind === 'block') {
      doc = await this.call(
        'PurchaseCapacityBlock',
        {
          CapacityBlockOfferingId: offering.offeringId,
          InstancePlatform: 'Linux/UNIX',
          TagSpecification: [{ ResourceType: 'capacity-reservation', Tag: purchaseTags }],
        },
        signal,
      );
    } else {
      try {
        doc = await this.call(
          'CreateCapacityReservation',
          {
            ClientToken: token,
            InstanceType: offering.instanceType,
            InstancePlatform: 'Linux/UNIX',
            AvailabilityZone: offering.zone,
            Tenancy: 'default',
            InstanceCount: offering.count,
            InstanceMatchCriteria: 'targeted',
            EndDateType: 'limited',
            EndDate: new Date(this.context.clock.now() + offering.hours * 3_600_000).toISOString(),
            TagSpecification: [{ ResourceType: 'capacity-reservation', Tag: purchaseTags }],
          },
          signal,
        );
      } catch (error) {
        // The ClientToken was used with other parameters: an earlier attempt of this purchase
        // created it (its end date moved on since). Retry until the purchase tag shows it.
        if (isComputeError(error, 'CONFLICT'))
          throw new ComputeError(
            'UNAVAILABLE',
            'an earlier attempt of this purchase created the reservation; EC2 does not show it yet',
            undefined,
            { provider: 'aws', reason: 'purchase-propagating' },
          );
        throw error;
      }
    }
    // EC2 answered 200: the capacity is bought. Nothing from here on may read as "not bought" (a
    // failed purchase): an answer this code cannot use (no reservation, a state it does not know, a
    // read it may not make) is retried as uncertain, and the retry finds the reservation by its tag
    // or by what it is.
    let reservation: ExternalReservation | undefined;
    try {
      const item = doc.child('capacityReservation');
      const zoneIds = await this.deps.zones.all(signal);
      const info = item
        ? parseCapacityReservation(item, new Map([...zoneIds].map(([name, zid]) => [zid, name])))
        : undefined;
      reservation = info ? await this.#asReservation(info, signal) : undefined;
    } catch {
      reservation = undefined;
    }
    if (!reservation)
      throw new ComputeError(
        'UNAVAILABLE',
        'EC2 sold the capacity but its answer is not readable; the purchase is retried and finds it',
        undefined,
        { provider: 'aws', reason: 'purchase-answer-unreadable' },
      );
    return reservation;
  }

  /**
   * Runs the part of a purchase that sends no purchase request. A retryable failure of it is
   * rethrown with `details.reason: 'purchase-not-sent'` (the reason it had moves to `cause`):
   * nothing can have been bought. `purchase-propagating` keeps its reason, and so does every
   * failure that is not retried.
   */
  async #beforePurchaseRequest<T>(step: () => Promise<T>): Promise<T> {
    try {
      return await step();
    } catch (error) {
      if (!isComputeError(error)) {
        this.context.log.warn('aws: a purchase failed before its request was sent', {
          provider: 'aws',
          error: error instanceof Error ? error.name : typeof error,
        });
        throw new ComputeError(
          'UNAVAILABLE',
          'the purchase could not be prepared; nothing was bought and it is retried',
          undefined,
          { provider: 'aws', reason: purchaseNotSent },
        );
      }
      const reason = error.details?.reason;
      if (!retriedPurchaseCodes.has(error.code) || reason === 'purchase-propagating') throw error;
      throw new ComputeError(error.code, error.message, error.status, {
        ...error.details,
        reason: purchaseNotSent,
        ...(typeof reason === 'string' ? { cause: reason } : {}),
      });
    }
  }

  /** The reservation an earlier attempt with this purchase token bought, if EC2 shows one. */
  async #purchased(token: string, signal: AbortSignal): Promise<ExternalReservation | undefined> {
    const { account } = await this.deps.account.verify({ signal, clock: this.context.clock });
    // Only the account's own reservations: one shared in from elsewhere is never taken for ours.
    const found = (
      await this.capacityReservations(signal, undefined, [
        { Name: `tag:${purchaseTag}`, Value: [token] },
      ])
    ).find((info) => info.ownerId === account);
    if (!found) return undefined;
    const reservation = await this.#asReservation(found, signal);
    if (!reservation)
      throw new ComputeError(
        'CONFLICT',
        `the capacity reservation this purchase bought (${found.capacityReservationId}) is ${found.state}`,
        undefined,
        { provider: 'aws', reason: 'purchase-ended', state: found.state },
      );
    return reservation;
  }

  /**
   * A Capacity Block of the account matching the offering (type, zone, count, start, duration),
   * created since the purchase was requested, carrying no other purchase's tag and not recorded by
   * another purchase (`exclude`, reservation ids): what an earlier attempt bought, when its tag
   * does not show yet.
   */
  async #boughtBlock(
    offering: Extract<ParsedOffering, { kind: 'block' }>,
    token: string,
    requestedAt: number,
    exclude: ReadonlySet<string>,
    signal: AbortSignal,
  ): Promise<ExternalReservation | undefined> {
    const { account } = await this.deps.account.verify({ signal, clock: this.context.clock });
    const hours = offering.hours * 3_600_000;
    const found = (
      await this.capacityReservations(signal, undefined, [
        { Name: 'instance-type', Value: [offering.instanceType] },
        { Name: 'availability-zone', Value: [offering.zone] },
      ])
    ).find(
      (info) =>
        info.ownerId === account &&
        info.block &&
        !exclude.has(reservationIdOf(info)) &&
        !exclude.has(info.capacityReservationId) &&
        info.zone === offering.zone &&
        info.instanceType === offering.instanceType &&
        info.total === offering.count &&
        (info.purchase === undefined || info.purchase === token) &&
        info.startsAt !== undefined &&
        Math.abs(info.startsAt - offering.startsAt) < 60_000 &&
        (info.endsAt === undefined || Math.abs(info.endsAt - info.startsAt - hours) <= 3_600_000) &&
        (info.createdAt === undefined || info.createdAt >= requestedAt - purchaseSkewMs),
    );
    if (!found) return undefined;
    const reservation = await this.#asReservation(found, signal);
    if (!reservation)
      throw new ComputeError(
        'CONFLICT',
        `the capacity reservation this purchase bought (${found.capacityReservationId}) is ${found.state}`,
        undefined,
        { provider: 'aws', reason: 'purchase-ended', state: found.state },
      );
    return reservation;
  }

  async #asReservation(
    info: CapacityReservationInfo,
    signal: AbortSignal,
  ): Promise<ExternalReservation | undefined> {
    const { account } = await this.deps.account.verify({ signal, clock: this.context.clock });
    const types = await this.#knownTypes([info.instanceType], signal);
    return toReservation(info, { region: this.config.region, account, types });
  }

  /** The confirmed block must still be on sale, at no more than the confirmed price. */
  async #confirmBlock(
    offering: Extract<ParsedOffering, { kind: 'block' }>,
    signal: AbortSignal,
  ): Promise<void> {
    const listed = (
      await this.#blockOfferings(
        {
          instanceType: offering.instanceType,
          count: offering.count,
          durationHours: offering.hours,
          earliestStart: offering.startsAt - 1_000,
          latestStart: offering.startsAt + 1_000,
        },
        signal,
      )
    ).find((entry) => entry.offeringId === offering.offeringId && entry.zone === offering.zone);
    if (!listed)
      throw new ComputeError(
        'CAPACITY_UNAVAILABLE',
        `Capacity Block offering ${offering.offeringId} is no longer on sale`,
        undefined,
        { provider: 'aws', reason: 'offering-gone' },
      );
    if (listed.upfrontCents > offering.upfrontCents)
      throw new ComputeError(
        'CONFLICT',
        `Capacity Block offering ${offering.offeringId} now costs ${listed.upfrontPrice} ${listed.currency}, more than confirmed`,
        undefined,
        { provider: 'aws', reason: 'price-changed' },
      );
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
    return toMachine(instance, {
      region: this.config.region,
      types,
      zoneIds,
      now: this.context.clock.now(),
    });
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
    return this.#checkedAmi(imageId, signal);
  }

  /**
   * A raw AMI's root device, after the ownership check: the image id comes from the tenant and EC2
   * launches anything the account can see, so a private AMI passes only when its owner is
   * `amazon`, `aws-marketplace` or one of the host's `imageOwners` (INVALID_INPUT, reason `image`).
   */
  async #checkedAmi(imageId: string, signal: AbortSignal): Promise<string | undefined> {
    const now = this.context.clock.now();
    let hit = this.#images.get(imageId);
    if (!hit || now - hit.at >= imageTtlMs) {
      hit = await this.#describeImage(imageId, signal);
      this.#images.set(imageId, hit);
    }
    if (!hit.allowed)
      throw new ComputeError(
        'INVALID_INPUT',
        `image ${imageId} is a private AMI whose owner the host does not allow (imageOwners)`,
        undefined,
        { provider: 'aws', reason: 'image' },
      );
    return hit.device;
  }

  async #describeImage(
    imageId: string,
    signal: AbortSignal,
  ): Promise<{ device: string | undefined; arch?: string; allowed: boolean; at: number }> {
    const now = this.context.clock.now();
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
    const item = doc.items('imagesSet').find((image) => image.textOf('imageId') === imageId);
    if (!item)
      throw new ComputeError(
        'INVALID_INPUT',
        `image ${imageId} does not exist in ${this.config.region}`,
        undefined,
        { provider: 'aws', reason: 'image' },
      );
    const allowed = imageAllowed(
      {
        isPublic: item.textOf('isPublic'),
        ownerId: item.textOf('imageOwnerId'),
        ownerAlias: item.textOf('imageOwnerAlias'),
      },
      this.#imageOwners,
    );
    const arch = item.textOf('architecture');
    return { device: item.textOf('rootDeviceName'), ...(arch ? { arch } : {}), allowed, at: now };
  }

  /**
   * The AMI id a `resolve:ssm:` image names now (SSM GetParameters, as the account). For calls
   * that, unlike RunInstances, take only an AMI id. The parameter is one `resolveImage` let through
   * (public, or under the host's `ssmImagePrefixes`); its value is never echoed.
   */
  async #ssmAmi(image: string, signal: AbortSignal): Promise<string> {
    const name = image.slice('resolve:ssm:'.length);
    if (!this.deps.ssm)
      throw new ComputeError(
        'UNSUPPORTED',
        'this AWS client has no SSM client to resolve a resolve:ssm: image',
        undefined,
        { provider: 'aws', reason: 'ssm-client' },
      );
    await this.ready(signal);
    const result = await this.deps.ssm.call<{
      Parameters?: { Name?: string; Value?: string }[];
      InvalidParameters?: string[];
    }>('GetParameters', { Names: [name] }, { signal });
    const bare = name.replace(/:\d+$/, '');
    const value = (result.Parameters ?? []).find((parameter) => parameter.Name === bare)?.Value;
    if (value === undefined || !isAmiId(value))
      throw new ComputeError(
        'INVALID_INPUT',
        value === undefined
          ? `SSM parameter ${bare.slice(0, 256)} does not exist in ${this.config.region}`
          : `SSM parameter ${bare.slice(0, 256)} does not hold an AMI id`,
        undefined,
        { provider: 'aws', reason: 'image' },
      );
    return value;
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
      // On a tenant network the primary interface carries the ownership tag too: a multi-interface
      // machine's groups change on it, and the IAM policy checks the tag there (AWS A2). Only
      // then, so a launch on an account still running the A1 policy is not refused.
      ...(request.network ? [{ ResourceType: 'network-interface', Tag: tagList }] : []),
    ];
  }

  async create(request: AwsCreateRequest, context: CallContext): Promise<ExternalMachine> {
    const offer = parseOfferId(request.offerId);
    // The EKS node identity goes only on EKS node launches, and an EKS node never falls back to the
    // account-wide profile: a role with an EC2_LINUX access entry on any other machine would let its
    // tenant register a Node in the operator's cluster.
    let instanceProfile = this.config.instanceProfile;
    if (request.kubernetesNode !== undefined) {
      if (request.kubernetesNode !== 'eks')
        throw new ComputeError('INVALID_INPUT', 'kubernetesNode is eks or absent', undefined, {
          provider: 'aws',
          reason: 'kubernetesNode',
        });
      if (!this.config.eksNodeInstanceProfile)
        throw new ComputeError(
          'INVALID_CONFIG',
          'The AWS account needs eksNodeInstanceProfile (an instance profile whose role has an EC2_LINUX access entry on the cluster) to launch EKS nodes',
          undefined,
          { provider: 'aws', reason: 'eksNodeInstanceProfile' },
        );
      instanceProfile = this.config.eksNodeInstanceProfile;
    }
    if (offer.market === 'spot' && offer.reservation !== undefined)
      throw unusableReservation(
        offer.reservation,
        'cannot take a Spot launch',
        'capacity-reservation',
      );
    if (offer.market === 'spot' && !this.config.spot)
      throw new ComputeError(
        'INVALID_INPUT',
        'this AWS account does not offer Spot capacity (config spot)',
        undefined,
        { provider: 'aws', reason: 'spot-disabled' },
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
    if (request.placement) {
      checkPlacement(request.placement);
      // An ODCR or Capacity Block pins where its capacity is; a placement group cannot move it.
      if (offer.reservation !== undefined)
        throw new ComputeError(
          'INVALID_INPUT',
          'a launch into a capacity reservation takes no placement group',
          undefined,
          { provider: 'aws', reason: 'placement-reservation' },
        );
    }
    const { signal } = context;
    let target: CapacityReservationInfo | undefined;
    if (offer.reservation !== undefined)
      try {
        target = await this.#launchTarget(offer.reservation, offer, signal);
      } catch (error) {
        // A retried create whose RunInstances went through answers with that instance (the
        // ClientToken's), whatever became of the reservation since (a block ended, an ODCR was
        // cancelled). A create that never launched keeps the refusal.
        const launched = await this.#launchedBefore(context).catch(() => undefined);
        if (launched) return this.machine(launched, signal);
        throw error;
      }
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
    // (A10) An AMI of the other architecture (x86_64 on Graviton) fails at launch: refuse it first.
    const imageArch = this.#images.get(imageId)?.arch;
    if (imageArch && !(info.arch as readonly string[]).includes(imageArch))
      throw new ComputeError(
        'INVALID_INPUT',
        `image ${imageId} is built for ${imageArch.slice(0, 16)}, not ${info.arch.join(' or ')} (${offer.instanceType})`,
        undefined,
        { provider: 'aws', reason: 'image-arch' },
      );
    const userData = packUserData(request.userData, request.sshKeys, request.mounts);
    // On a tenant network: its subnet in the offer's zone and the groups of its firewall rules.
    const placement = request.network
      ? await this.networks.placement(request.network, offer.zone, signal)
      : undefined;
    // (A10) The placement group first: made on first use, refused when it is not ours.
    if (request.placement) await this.#placementGroups.ensure(request.placement, signal);
    const subnet = placement?.subnetId ?? this.config.subnetId;
    const groups = placement?.groupIds ?? this.config.securityGroupIds ?? [];
    // (A10) EFA: one EFA interface per network card, up to the type's EFA maximum. EFA needs
    // explicit interfaces, so a subnet; launching an EFA type without EFA would hide a slow fabric.
    const efaInterfaces =
      this.config.efa === 'auto' && info.efa
        ? Math.max(1, Math.min(info.maxEfaInterfaces ?? 1, info.networkCards ?? 1))
        : 0;
    if (efaInterfaces > 0 && !subnet)
      throw new ComputeError(
        'INVALID_CONFIG',
        `${offer.instanceType} launches with EFA (config efa: auto), which needs subnetId or a network`,
        undefined,
        { provider: 'aws', reason: 'efa-subnet' },
      );
    // EC2 takes a public address only on a launch with one interface: a multi-card EFA machine has
    // none even with associatePublicIp. Said once per account and type, never silently.
    if (
      efaInterfaces > 1 &&
      this.config.associatePublicIp &&
      !this.#warned.has(`efa-public-ip:${offer.instanceType}`)
    ) {
      this.#warned.add(`efa-public-ip:${offer.instanceType}`);
      this.context.log.warn(
        'aws: EFA machines with several interfaces get no public IPv4 address',
        {
          instanceType: offer.instanceType,
          interfaces: efaInterfaces,
          reason: 'efa-public-ip',
        },
      );
    }
    const params: QueryParams = {
      ClientToken: clientToken(context.idempotencyKey),
      MinCount: 1,
      MaxCount: 1,
      InstanceType: offer.instanceType,
      Placement: {
        AvailabilityZone: offer.zone,
        ...(request.placement ? placementParams(request.placement) : {}),
      },
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
        ? efaInterfaces > 0
          ? Array.from({ length: efaInterfaces }, (_, card) => ({
              // The primary interface is device 0 on card 0; each other card's is device 1.
              NetworkCardIndex: card,
              DeviceIndex: card === 0 ? 0 : 1,
              InterfaceType: 'efa',
              SubnetId: subnet,
              SecurityGroupId: groups.length ? groups : undefined,
              // EC2 takes a public address only on a launch with one interface.
              AssociatePublicIpAddress:
                efaInterfaces === 1 ? this.config.associatePublicIp : undefined,
              DeleteOnTermination: true,
            }))
          : [
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
      IamInstanceProfile: instanceProfile ? { Arn: instanceProfile } : undefined,
      // A one-time Spot Instance cannot stop: a shutdown from inside it terminates it.
      InstanceInitiatedShutdownBehavior: offer.market === 'spot' ? 'terminate' : 'stop',
      TagSpecification: this.#tagSpecifications(request, context),
      ...(offer.market === 'spot'
        ? {
            InstanceMarketOptions: {
              MarketType: 'spot',
              SpotOptions: {
                SpotInstanceType: 'one-time',
                InstanceInterruptionBehavior: 'terminate',
              },
            },
          }
        : {}),
      ...(target
        ? {
            CapacityReservationSpecification: {
              CapacityReservationTarget: { CapacityReservationId: target.capacityReservationId },
            },
            ...(target.block ? { InstanceMarketOptions: { MarketType: 'capacity-block' } } : {}),
          }
        : {}),
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

  /**
   * The reservation an `@cr-…` offer launches into, read fresh: it must exist, be usable, active,
   * and hold the offer's type in the offer's zone. A Capacity Block launch needs
   * MarketType=capacity-block, which only the read can tell.
   */
  async #launchTarget(
    id: string,
    offer: { zone: string; instanceType: string; market: 'on-demand' | 'spot' },
    signal: AbortSignal,
  ): Promise<CapacityReservationInfo> {
    if (offer.market === 'spot')
      throw unusableReservation(id, 'cannot take a Spot launch', 'capacity-reservation');
    let found: CapacityReservationInfo | undefined;
    try {
      [found] = await this.capacityReservations(signal, [id]);
    } catch (error) {
      if (!isComputeError(error, 'NOT_FOUND')) throw error;
    }
    if (!found || found.capacityReservationId !== id)
      throw unusableReservation(
        id,
        `does not exist in ${this.config.region}`,
        'capacity-reservation',
      );
    if (!usable(found, this.config.zones))
      throw unusableReservation(
        id,
        'is not a Linux/UNIX, default-tenancy reservation in one of the account zones',
        'capacity-reservation',
      );
    if (found.instanceType !== offer.instanceType || found.zone !== offer.zone)
      throw unusableReservation(
        id,
        `holds ${found.instanceType} in ${found.zone}, not ${offer.instanceType} in ${offer.zone}`,
        'capacity-reservation',
      );
    if (found.state !== 'active')
      throw new ComputeError(
        'CAPACITY_UNAVAILABLE',
        `capacity reservation ${id} is ${found.state}, not active`,
        undefined,
        { provider: 'aws', reason: 'reservation-not-active', state: found.state },
      );
    return found;
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

  /** The instance an earlier RunInstances with this create's ClientToken launched, if any. */
  async #launchedBefore(context: CallContext): Promise<XmlElement | undefined> {
    const doc = await this.call(
      'DescribeInstances',
      { Filter: [{ Name: 'client-token', Value: [clientToken(context.idempotencyKey)] }] },
      context.signal,
    );
    return doc
      .items('reservationSet')
      .flatMap((reservation) => reservation.items('instancesSet'))[0];
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
      // Not visible: pending while that may be lag (also for an instance another replica, or this
      // process before a restart, just launched), and gone only after a whole window of misses. vps
      // marks a machine that reads `undefined` lost and stops billing it.
      return this.#mayLag(id) ? { id, state: 'pending', addresses: [] } : undefined;
    }
    this.#lag.seen(id);
    // Just claimed by this client: a lagging read may not show the ownership tag yet. vps would take
    // the missing label as lost ownership, so that is a retryable UNAVAILABLE inside the window.
    if (
      !instance.items('tagSet').some((item) => item.textOf('key') === tags.instance) &&
      this.recent(this.#claims, id)
    )
      throw tagPropagation(id);
    const machine = await this.machine(instance, context.signal);
    if (instance.child('instanceState')?.textOf('name') === 'terminated') {
      // EC2 drops a terminated instance from reads after a while: that miss is final.
      this.#lag.gone(id);
      const failure = terminatedFailure(instance.child('stateReason')?.textOf('code'));
      if (failure instanceof ComputeError) throw failure;
      if (failure === 'error') return { ...machine, state: 'error' };
    }
    return (await this.#withTopology([machine], context.signal))[0]!;
  }

  /**
   * (A10) Running machines of an EFA family carry the network nodes above them; get, list and
   * discover all label this way (list and discover read up to 100 machines at once).
   */
  async #withTopology(
    machines: readonly ExternalMachine[],
    signal: AbortSignal,
  ): Promise<ExternalMachine[]> {
    const running = machines.filter(
      (machine) => machine.state === 'running' && machine.machineType,
    );
    if (running.length === 0) return [...machines];
    const types = await this.#types(
      [...new Set(running.map((machine) => machine.machineType!))],
      signal,
    ).catch(() => undefined);
    const efa = running.filter((machine) => types?.get(machine.machineType!)?.efa);
    if (efa.length === 0) return [...machines];
    const labelled = new Map(
      (await this.#topology.labelAll(efa, signal)).map((machine) => [machine.id, machine]),
    );
    return machines.map((machine) => labelled.get(machine.id) ?? machine);
  }

  async delete(id: string, context: CallContext): Promise<void> {
    parseInstanceId(id);
    // The same reads as get: by id, then by client token (EC2 lags right after RunInstances).
    const instance =
      (await this.describe(id, context.signal)) ?? (await this.#byClientToken(id, context));
    if (!instance) {
      const ours = this.recent(this.#created, id);
      // Missing for the whole consistency window (or known terminated): gone.
      if (!this.#mayLag(id)) return;
      // Launched by this client and not visible yet: RunInstances tagged it managed, so terminate
      // it rather than report a delete that leaves it running.
      if (ours) {
        await this.#terminate(id, context);
        return;
      }
      // Never seen by this process: it may be an instance another replica (or this one before a
      // restart) just launched. Its managed tag cannot be checked yet, so nothing is terminated
      // blind and nothing is reported deleted: the delete is retried until EC2 shows the instance
      // or the window has passed.
      throw notVisible(id);
    }
    this.#lag.seen(id);
    const state = instance.child('instanceState')?.textOf('name');
    if (state === 'terminated' || state === 'shutting-down') {
      this.#lag.gone(id);
      this.volumes.forgetInstance(id);
      return;
    }
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
    // EC2 detaches its volumes as it terminates (A5): what this client attached to it is no longer pending.
    this.volumes.forgetInstance(id);
  }

  /**
   * TerminateInstances. NOT_FOUND is success (already gone) only once the instance has been missing
   * for the whole consistency window. Before that EC2 may simply not show it yet (this client just
   * launched it, or a read just found it and this call reached a lagging replica), so it is a
   * retryable UNAVAILABLE (vps treats NOT_FOUND and success alike: deleted).
   */
  async #terminate(id: string, context: CallContext): Promise<void> {
    try {
      await this.call('TerminateInstances', { InstanceId: [id] }, context.signal);
    } catch (error) {
      if (isComputeError(error, 'NOT_FOUND')) {
        if (!this.#mayLag(id)) return;
        throw notVisible(id);
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
    const resolved = resolveImage(image, arch === 'arm64' ? 'arm64' : 'x86_64', this.#ssmPrefixes);
    // CreateReplaceRootVolumeTask takes only an AMI id (resolve:ssm: is a launch-time syntax), so an
    // SSM image is read here; a raw AMI takes the same ownership check as create.
    let imageId: string;
    if (resolved.startsWith('resolve:ssm:')) imageId = await this.#ssmAmi(resolved, context.signal);
    else {
      await this.#checkedAmi(resolved, context.signal);
      imageId = resolved;
    }
    // (A10) As at create: an AMI the machine's architecture cannot boot is refused before the root
    // volume is replaced (EC2 would fail the task with the old volume already detached).
    const imageArch = this.#images.get(imageId)?.arch;
    if (imageArch && imageArch !== arch)
      throw new ComputeError(
        'INVALID_INPUT',
        `image ${imageId} is built for ${imageArch.slice(0, 16)}, not ${arch}${type ? ` (${type.slice(0, 64)})` : ''}`,
        undefined,
        { provider: 'aws', reason: 'image-arch' },
      );
    // The token covers retries of one reinstall: they see the same root volume. Once the task has
    // replaced it, the same reinstall again is a new task (a new wipe), not the finished one.
    const rootVolume = rootVolumeOf(instance);
    await this.call(
      'CreateReplaceRootVolumeTask',
      {
        InstanceId: id,
        ImageId: imageId,
        DeleteReplacedRootVolume: true,
        ClientToken: rootVolume
          ? clientToken(`${context.idempotencyKey}:reinstall:${image}:${rootVolume}`)
          : undefined,
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
      const page: ExternalMachine[] = [];
      for (const reservation of doc.items('reservationSet'))
        for (const instance of reservation.items('instancesSet'))
          page.push(await this.machine(instance, context.signal));
      yield* await this.#withTopology(page, context.signal);
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
      this.#remember(this.#claims, id);
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
    this.#remember(this.#claims, id);
    if (options.managed) this.#remember(this.#managedClaims, id);
    return this.machine(after.instance, context.signal);
  }

  /** Removes the ownership (and managed) tags if they name `instanceId`; a missing instance is fine. */
  async release(id: string, instanceId: string, context: CallContext): Promise<void> {
    // A released instance legitimately reads without the tag from here on.
    this.#claims.delete(id);
    this.#managedClaims.delete(id);
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

  // --- Events (A4) --------------------------------------------------------------------------------

  /**
   * The account's EventBridge events from its intake queue (`eventQueueUrl`), authenticated by
   * account, region and source. Messages are deleted only by the batch's `ack`. Without a queue,
   * the account's scheduled events (DescribeInstanceStatus) at most every 5 minutes. A failed scan
   * waits the same 5 minutes, and one the IAM policy refuses (a policy from before A4) an hour,
   * logged once per hour with the fix: vps polls every 15 s and must not spend the EC2 budget.
   */
  async pollEvents(
    context: CallContext,
    options: { waitMs: number; max: number },
  ): Promise<ProviderEventBatch> {
    const { sqs } = this.deps;
    if (sqs === undefined || this.config.eventQueueUrl === undefined) {
      const now = this.context.clock.now();
      if (
        (this.#scannedAt !== undefined && now - this.#scannedAt < scheduledEventScanMs) ||
        (this.#scanRetryAt !== undefined && now < this.#scanRetryAt)
      )
        return { events: [], received: 0, ack: async () => {} };
      let scan;
      try {
        scan = await scanScheduledEvents(
          (action, params, signal) => this.call(action, params, signal),
          context.signal,
          now,
          this.#scheduled,
        );
      } catch (error) {
        const denied = isComputeError(error, 'ACCESS_DENIED');
        this.#scanRetryAt = now + (denied ? scanDeniedBackoffMs : scheduledEventScanMs);
        if (denied)
          context.log.warn(
            'provider-aws: the account may not call ec2:DescribeInstanceStatus; scheduled events are read again in an hour (rerun `aws iam-policy` and update the role or user policy)',
            { provider: 'aws' },
          );
        throw error;
      }
      const { events, scheduled } = scan;
      this.#scanRetryAt = undefined;
      this.#scannedAt = now;
      this.#scheduled = scheduled;
      // Not a queue: nothing more to read until the next scan, however many events it found.
      return { events, received: 0, ack: async () => {} };
    }
    return pollQueue(
      {
        sqs,
        queueUrl: this.config.eventQueueUrl,
        region: this.config.region,
        sources: this.config.eventSources ?? defaultEventSources,
        account: async (signal) =>
          (await this.deps.account.verify({ signal, clock: this.context.clock })).account,
        log: context.log,
      },
      context,
      options,
    );
  }
}
