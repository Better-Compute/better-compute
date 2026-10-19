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
  type ProviderNetworks,
} from '@better-compute/core';
import {
  operationFailure,
  settled,
  waitForOperation,
  type GceClient,
  type GceOperation,
} from './client.js';
import type { GcpConfig, GcpProviderOptions } from './config.js';
import {
  bootDiskTypes,
  diskSizeRange,
  hyperdiskBootType,
  isDiskTypeRefusal,
  needsGvnic,
  type GceDiskType,
} from './disks.js';
import {
  instanceName,
  labels,
  labelValue,
  machineId,
  offerId,
  parseMachineId,
  parseOfferId,
  requestIdFor,
} from './ids.js';
import { GcpNetworks } from './networks.js';
import { readReservations } from './reservations.js';
import {
  gpusOfType,
  regionOf,
  shapeOf,
  toMachine,
  type GceDisk,
  type GceInstance,
  type GceMachineType,
  type MachineShape,
  type ToMachineOptions,
} from './shapes.js';

// Compute Engine VMs as VPS instances: offers from machine types, create (idempotent by requestId),
// get, delete, power and list. A VM id is `zone/name`. Only VMs carrying the better-compute labels
// are ever deleted or powered.

/** Whether an offer satisfies the query's resource filters. */
function matches(query: OfferQuery, offer: Offer): boolean {
  if (
    query.gpuModel !== undefined &&
    offer.gpus?.model.toLowerCase() !== query.gpuModel.toLowerCase()
  )
    return false;
  return (
    (query.minGpus ?? 0) <= (offer.gpus?.count ?? 0) &&
    offer.vcpu >= (query.minVcpu ?? 0) &&
    offer.memoryGiB >= (query.minMemoryGiB ?? 0)
  );
}

const acceleratorFamily = /^(a2|a3|a4|g2)-/;
const instanceWaitMs = 20_000;

export class GcpCompute implements ProviderImpl {
  protected readonly client: GceClient;
  protected readonly config: GcpConfig;
  protected readonly context: ProviderContext;
  protected readonly options: GcpProviderOptions;
  readonly #types = new Map<string, GceMachineType | undefined>();
  /** Keyed `zone/diskType`: undefined when the zone does not offer it. */
  readonly #diskTypes = new Map<string, GceDiskType | undefined>();
  /** Machine types GCE refused a Persistent Disk for although the family table allowed one. */
  readonly #hyperdiskOnly = new Set<string>();
  /** Persistent disks' types by disk resource URL, with when each answer stops being used. */
  readonly #diskKinds = new Map<string, { type: string | undefined; until: number }>();
  readonly networks: ProviderNetworks;

  constructor(
    config: GcpConfig,
    context: ProviderContext,
    options: GcpProviderOptions,
    client: GceClient,
  ) {
    this.config = config;
    this.context = context;
    this.options = options;
    this.client = client;
    this.networks = new GcpNetworks(client, options);
  }

  // ------------------------------------------------------------------------------- shared

  /** A machine type's resource, cached (shapes do not change); undefined when it does not exist. */
  protected async machineType(
    zone: string,
    name: string,
    signal: AbortSignal,
  ): Promise<GceMachineType | undefined> {
    const key = `${zone}/${name}`;
    if (this.#types.has(key)) return this.#types.get(key);
    try {
      const type = await this.client.request<GceMachineType>(
        'GET',
        `/zones/${zone}/machineTypes/${name}`,
        { signal },
      );
      this.#types.set(key, type);
      return type;
    } catch (error) {
      if (isComputeError(error, 'NOT_FOUND')) {
        this.#types.set(key, undefined);
        return undefined;
      }
      // A denied or failed read is not fatal: the shape falls back to what the name says.
      if (signal.aborted) throw error;
      this.context.log.debug('gcp.machine_type_unreadable', { zone, machineType: name });
      return undefined;
    }
  }

  /**
   * A zone's disk type, cached; undefined when the zone does not offer it, 'unknown' when it cannot
   * be read (the create then goes ahead and GCE decides).
   */
  protected async diskType(
    zone: string,
    name: string,
    signal: AbortSignal,
  ): Promise<GceDiskType | undefined | 'unknown'> {
    const key = `${zone}/${name}`;
    if (this.#diskTypes.has(key)) return this.#diskTypes.get(key);
    try {
      const type = await this.client.request<GceDiskType>(
        'GET',
        `/zones/${zone}/diskTypes/${name}`,
        { signal },
      );
      this.#diskTypes.set(key, type);
      return type;
    } catch (error) {
      if (isComputeError(error, 'NOT_FOUND')) {
        this.#diskTypes.set(key, undefined);
        return undefined;
      }
      if (signal.aborted) throw error;
      this.context.log.debug('gcp.disk_type_unreadable', { zone, diskType: name });
      return 'unknown';
    }
  }

  /**
   * The boot disk type for `machineType` in `zone`: the first it takes that the zone offers. A zone
   * that offers none, or a size the type does not take, is INVALID_INPUT before anything is created.
   */
  protected async bootDiskType(
    zone: string,
    machineType: string,
    sizeGiB: number,
    signal: AbortSignal,
  ): Promise<string> {
    const candidates = this.#hyperdiskOnly.has(machineType)
      ? [hyperdiskBootType]
      : bootDiskTypes(machineType);
    for (const candidate of candidates) {
      const type = await this.diskType(zone, candidate, signal);
      if (type === undefined) continue;
      if (type === 'unknown') return candidate;
      if (type.deprecated?.state && type.deprecated.state !== 'ACTIVE') continue;
      const range = diskSizeRange(type);
      if (range && (sizeGiB < range.min || sizeGiB > range.max))
        throw new ComputeError(
          'INVALID_INPUT',
          `A ${candidate} boot disk in ${zone} is ${range.min}-${range.max} GiB, not ${sizeGiB} GiB`,
          undefined,
          { provider: 'gcp', reason: 'diskSizeOutOfRange', diskType: candidate, zone, ...range },
        );
      return candidate;
    }
    throw new ComputeError(
      'INVALID_INPUT',
      `${machineType} needs a ${candidates.join(' or ')} boot disk, which ${zone} does not offer`,
      undefined,
      { provider: 'gcp', reason: 'diskTypeUnavailable', machineType, zone, diskTypes: candidates },
    );
  }

  /**
   * The type (`pd-ssd`, `hyperdisk-balanced`, …) of the persistent disk at `source`, from `disks.get`, cached per
   * disk resource URL for a day (a failed read for five minutes, so a denied permission is not asked again at every
   * poll). Undefined when it cannot be read: the platform then meters the disk as `pd-balanced` and says so.
   */
  protected async persistentDiskType(
    source: string | undefined,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    if (!source) return undefined;
    const now = this.context.clock.now();
    const known = this.#diskKinds.get(source);
    if (known && known.until > now) return known.type;
    const path = /(?:\/projects\/([^/]+))?\/(zones|regions)\/([^/]+)\/disks\/([^/?#]+)$/.exec(
      source,
    );
    // A disk of another project is not this account's to read.
    const readable = path && (path[1] === undefined || path[1] === this.config.projectId);
    let type: string | undefined;
    if (readable) {
      try {
        const disk = await this.client.request<GceDisk>(
          'GET',
          `/${path[2]}/${path[3]}/disks/${path[4]}`,
          { signal },
        );
        type = disk.type ? disk.type.split('/').pop() : undefined;
      } catch (error) {
        if (signal.aborted) throw error;
        this.context.log.debug('gcp.disk_unreadable', { source });
      }
    }
    if (this.#diskKinds.size >= 10_000)
      for (const [key, entry] of this.#diskKinds)
        if (entry.until <= now) this.#diskKinds.delete(key);
    this.#diskKinds.set(source, { type, until: now + (type ? 86_400_000 : 300_000) });
    return type;
  }

  /**
   * The instance's disks for metering (D9): a SCRATCH disk is a `local-ssd`, a PERSISTENT one has the type its
   * resource says (boot disk first). The boot disk's type also names `bootDiskType`, falling back on the family table,
   * or Hyperdisk for a machine type create learned takes nothing else.
   */
  protected async instanceDisks(
    instance: GceInstance,
    machineType: string,
    signal: AbortSignal,
  ): Promise<Pick<ToMachineOptions, 'disks' | 'bootDiskType'>> {
    const disks: NonNullable<ExternalMachine['disks']>[number][] = [];
    let bootType: string | undefined;
    for (const attached of instance.disks ?? []) {
      const sizeGiB = Number(attached.diskSizeGb);
      if (!(sizeGiB > 0)) continue;
      const boot = attached.boot === true;
      const type =
        attached.type === 'SCRATCH'
          ? 'local-ssd'
          : await this.persistentDiskType(attached.source, signal);
      if (boot && type) bootType = type;
      disks.push({ ...(type ? { type } : {}), sizeGiB, ...(boot ? { boot } : {}) });
    }
    disks.sort((a, b) => Number(b.boot === true) - Number(a.boot === true));
    const bootDiskType =
      bootType ?? (this.#hyperdiskOnly.has(machineType) ? hyperdiskBootType : undefined);
    return {
      ...(disks.length > 0 ? { disks } : {}),
      ...(bootDiskType ? { bootDiskType } : {}),
    };
  }

  /** An instance as a machine, with the shape of its machine type and its disks. */
  protected async toMachine(instance: GceInstance, signal: AbortSignal): Promise<ExternalMachine> {
    const zone = instance.zone.split('/').pop()!;
    const typeName = instance.machineType.split('/').pop()!;
    const type = await this.machineType(zone, typeName, signal);
    const shape: MachineShape | undefined = type ? shapeOf(type) : undefined;
    return toMachine(instance, {
      projectId: this.config.projectId,
      ...(shape ? { shape } : {}),
      ...(await this.instanceDisks(instance, typeName, signal)),
    });
  }

  protected instance(zone: string, name: string, signal: AbortSignal): Promise<GceInstance> {
    return this.client.request<GceInstance>('GET', `/zones/${zone}/instances/${name}`, { signal });
  }

  protected inConfiguredZone(instance: GceInstance): boolean {
    return this.config.zones.includes(instance.zone.split('/').pop()!);
  }

  // ------------------------------------------------------------------------------- offers

  async listOffers(query: OfferQuery): Promise<Offer[]> {
    if (query.kind === 'metal') return [];
    const signal = new AbortController().signal;
    const zones = this.config.zones.filter(
      (zone) =>
        query.region === undefined || query.region === zone || query.region === regionOf(zone),
    );
    const offers: Offer[] = [];
    for (const zone of zones) {
      for await (const type of this.client.pages<GceMachineType>(
        `/zones/${zone}/machineTypes`,
        'items',
        { query: { maxResults: '500' }, signal },
      )) {
        if (type.deprecated?.state && type.deprecated.state !== 'ACTIVE') continue;
        this.#types.set(`${zone}/${type.name}`, { ...type, zone });
        const gpus = gpusOfType(type);
        const offer: Offer = {
          id: offerId(zone, type.name),
          kind: 'vps',
          region: regionOf(zone),
          vcpu: type.guestCpus,
          memoryGiB: type.memoryMb / 1024,
          ...(gpus ? { gpus } : {}),
          available: true,
        };
        if (matches(query, offer)) offers.push(offer);
      }
    }
    // Capacity held by ready reservations is offered too, available while any of it is unused.
    let reservations: ExternalReservation[] = [];
    try {
      reservations = await this.listReservations();
    } catch (error) {
      // Without permission to read reservations the on-demand offers still stand.
      if (!isComputeError(error, 'ACCESS_DENIED')) throw error;
      this.context.log.warn('gcp.reservations_unreadable', { reason: 'ACCESS_DENIED' });
    }
    for (const reservation of reservations) {
      if (reservation.state !== 'ready' || reservation.vcpu <= 0 || reservation.memoryGiB <= 0)
        continue;
      if (!zones.includes(reservation.zone)) continue;
      const offer: Offer = {
        id: reservation.offerId,
        kind: 'vps',
        region: reservation.region,
        vcpu: reservation.vcpu,
        memoryGiB: reservation.memoryGiB,
        ...(reservation.gpus ? { gpus: reservation.gpus } : {}),
        available: reservation.total - reservation.inUse > 0,
      };
      if (matches(query, offer)) offers.push(offer);
    }
    return offers.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  async listReservations(context?: CallContext): Promise<ExternalReservation[]> {
    return readReservations(
      {
        client: this.client,
        projectId: this.config.projectId,
        zones: this.config.zones,
        machineType: (zone, name, signal) => this.machineType(zone, name, signal),
      },
      context?.signal ?? new AbortController().signal,
    );
  }

  // ------------------------------------------------------------------------------- create

  async create(
    request: {
      offerId: string;
      image: ImageRef;
      userData: string;
      name: string;
      network?: NetworkRef;
      labels?: Readonly<Record<string, string>>;
      sshKeys?: readonly string[];
    },
    context: CallContext,
  ): Promise<ExternalMachine> {
    const { zone, machineType, reservation } = parseOfferId(request.offerId);
    if (!this.config.zones.includes(zone))
      throw new ComputeError('INVALID_INPUT', `Zone ${zone} is not one of the account's zones`);
    const type = await this.machineType(zone, machineType, context.signal);
    const accelerated = type
      ? (type.accelerators?.length ?? 0) > 0
      : acceleratorFamily.test(machineType);
    const name = instanceName(request.name);
    const diskGiB = this.config.diskGiB ?? 100;
    const diskType = await this.bootDiskType(zone, machineType, diskGiB, context.signal);
    // The guest agent of every Compute Engine image installs `ssh-keys`; cloud-init (which reads
    // user-data) only runs on some images, so the keys go in both.
    const metadata = [{ key: 'user-data', value: request.userData }];
    if (request.sshKeys?.length)
      metadata.push({
        key: 'ssh-keys',
        value: request.sshKeys.map((key) => `${sshUserOf(request.image)}:${key.trim()}`).join('\n'),
      });
    const body: Record<string, unknown> = {
      name,
      machineType: `zones/${zone}/machineTypes/${machineType}`,
      labels: {
        ...Object.fromEntries(
          Object.entries(request.labels ?? {}).map(([key, value]) => [
            labelValue(key),
            labelValue(value),
          ]),
        ),
        [labels.managed]: 'true',
        [labels.instance]: labelValue(request.name),
      },
      disks: [
        {
          boot: true,
          autoDelete: true,
          initializeParams: {
            sourceImage: this.sourceImage(request.image),
            diskSizeGb: String(diskGiB),
            diskType: `zones/${zone}/diskTypes/${diskType}`,
          },
        },
      ],
      networkInterfaces: [
        {
          ...this.networkInterface(zone, request.network),
          ...(needsGvnic(machineType) ? { nicType: 'GVNIC' } : {}),
        },
      ],
      metadata: { items: metadata },
      // GPU machines cannot live-migrate.
      scheduling: accelerated
        ? { onHostMaintenance: 'TERMINATE', automaticRestart: true }
        : { onHostMaintenance: 'MIGRATE', automaticRestart: true },
    };
    if (request.network?.tags?.length) body.tags = { items: [...request.network.tags] };
    if (reservation)
      body.reservationAffinity = {
        consumeReservationType: 'SPECIFIC_RESERVATION',
        key: 'compute.googleapis.com/reservation-name',
        values: [reservation],
      };
    const insert = async (key: string) =>
      settled(
        await this.client.request<GceOperation>('POST', `/zones/${zone}/instances`, {
          body,
          query: { requestId: requestIdFor(key) },
          signal: context.signal,
        }),
        `Creating ${machineId(zone, name)}`,
      );
    try {
      try {
        await insert(context.idempotencyKey);
      } catch (error) {
        // The family table allowed a Persistent Disk this machine type refuses (a 400, so nothing
        // was created): once more with Hyperdisk Balanced, under its own requestId.
        if (diskType === hyperdiskBootType || !isDiskTypeRefusal(error)) throw error;
        this.context.log.warn('gcp.disk_type_fallback', { zone, machineType, diskType });
        this.#hyperdiskOnly.add(machineType);
        const fallback = await this.bootDiskType(zone, machineType, diskGiB, context.signal);
        const [boot] = body.disks as { initializeParams: Record<string, unknown> }[];
        boot!.initializeParams.diskType = `zones/${zone}/diskTypes/${fallback}`;
        await insert(`${context.idempotencyKey}:${fallback}`);
      }
    } catch (error) {
      // The VM exists under another requestId (the 60-minute dedupe window passed): it is ours if
      // it carries this instance's label.
      if (isComputeError(error, 'CONFLICT')) {
        const existing = await this.instance(zone, name, context.signal);
        if (existing.labels?.[labels.instance] === labelValue(request.name))
          return this.toMachine(existing, context.signal);
      }
      throw error;
    }
    const pending: GceInstance = {
      name,
      zone,
      machineType,
      status: 'PROVISIONING',
      labels: body.labels as Record<string, string>,
      ...(type?.accelerators
        ? {
            guestAccelerators: type.accelerators.map((accelerator) => ({
              acceleratorType: accelerator.guestAcceleratorType,
              acceleratorCount: accelerator.guestAcceleratorCount,
            })),
          }
        : {}),
    };
    return this.toMachine(pending, context.signal);
  }

  /** An image family (or `projects/…`, `global/…` or URL reference) as a `sourceImage`. */
  protected sourceImage(image: ImageRef): string {
    if (/^https:\/\//.test(image) || image.startsWith('projects/') || image.startsWith('global/'))
      return image;
    return `projects/${this.config.imageProject ?? 'ubuntu-os-cloud'}/global/images/family/${image}`;
  }

  protected networkInterface(zone: string, network?: NetworkRef): Record<string, unknown> {
    const name = network?.network ?? this.config.network ?? 'default';
    const subnet = network ? network.subnet : this.config.subnet;
    const path = (value: string, kind: string, scope: string) =>
      /^https:\/\//.test(value) || value.startsWith('projects/') || value.startsWith(`${scope}/`)
        ? value
        : `${scope}/${kind}/${value}`;
    return {
      network: path(name, 'networks', 'global'),
      ...(subnet ? { subnetwork: path(subnet, 'subnetworks', `regions/${regionOf(zone)}`) } : {}),
      accessConfigs: [{ type: 'ONE_TO_ONE_NAT', name: 'External NAT' }],
    };
  }

  // ------------------------------------------------------------------------------- get, delete

  async get(id: string, context: CallContext): Promise<ExternalMachine | undefined> {
    let target: { zone: string; name: string };
    try {
      target = parseMachineId(id);
    } catch (error) {
      if (isComputeError(error, 'INVALID_INPUT')) return undefined;
      throw error;
    }
    try {
      return await this.toMachine(
        await this.instance(target.zone, target.name, context.signal),
        context.signal,
      );
    } catch (error) {
      if (isComputeError(error, 'NOT_FOUND')) return this.insertOutcome(target, context.signal);
      throw error;
    }
  }

  /**
   * What a VM that cannot be read is: GCE accepts an insert and reports its failure (a stockout,
   * a quota) on the operation later, and the VM may not be visible while it runs. So when a VM is
   * missing, its newest insert operation says whether it is still coming (a pending machine),
   * failed (the operation's error), or there is nothing to find (undefined).
   */
  protected async insertOutcome(
    target: { zone: string; name: string },
    signal: AbortSignal,
  ): Promise<ExternalMachine | undefined> {
    let newest: GceOperation | undefined;
    try {
      for await (const operation of this.client.pages<GceOperation & { insertTime?: string }>(
        `/zones/${target.zone}/operations`,
        'items',
        {
          query: {
            // GCE's RE2 syntax: parenthesized `eq` expressions joined by spaces (an implicit AND);
            // an explicit AND, or a `=` expression mixed in, is refused with a 400.
            filter: `(operationType eq insert) (targetLink eq .*/zones/${target.zone}/instances/${target.name})`,
            maxResults: '500',
          },
          signal,
        },
      )) {
        const time = (candidate: { insertTime?: string }) => Date.parse(candidate.insertTime ?? '');
        if (!newest || time(operation) >= time(newest as { insertTime?: string }))
          newest = operation;
      }
    } catch (error) {
      // A busy provider is asked again later; anything else (no permission to list operations, a
      // filter GCE refuses) leaves the outcome unknown, and a missing VM is then simply missing:
      // throwing here would keep every out-of-band delete from ever reading as gone.
      if (
        signal.aborted ||
        (isComputeError(error) && ['RATE_LIMITED', 'UNAVAILABLE', 'TIMEOUT'].includes(error.code))
      )
        throw error;
      this.context.log.warn('gcp.insert_operations_unreadable', {
        machineId: machineId(target.zone, target.name),
        code: isComputeError(error) ? error.code : 'unknown',
        reason: isComputeError(error) ? String(error.details?.reason ?? '') : '',
      });
      return undefined;
    }
    if (!newest) return undefined;
    if (newest.status !== 'DONE')
      return {
        id: machineId(target.zone, target.name),
        name: target.name,
        state: 'pending',
        addresses: [],
        zone: target.zone,
        region: regionOf(target.zone),
      };
    const failure = operationFailure(newest, `Creating ${machineId(target.zone, target.name)}`);
    if (failure) throw failure;
    return undefined;
  }

  async delete(id: string, context: CallContext): Promise<void> {
    let target: { zone: string; name: string };
    try {
      target = parseMachineId(id);
    } catch {
      return;
    }
    try {
      const instance = await this.instance(target.zone, target.name, context.signal);
      if (instance.labels?.[labels.managed] !== 'true')
        throw new ComputeError(
          'INVALID_STATE',
          `${id} is not managed by better-compute and is never deleted by it`,
          undefined,
          { provider: 'gcp', reason: 'notManaged' },
        );
      const operation = await this.client.request<GceOperation>(
        'DELETE',
        `/zones/${target.zone}/instances/${target.name}`,
        { signal: context.signal },
      );
      settled(operation, `Deleting ${id}`);
    } catch (error) {
      if (isComputeError(error, 'NOT_FOUND')) return;
      throw error;
    }
  }

  // ------------------------------------------------------------------------------- power, list

  async power(id: string, action: PowerAction, context: CallContext): Promise<void> {
    if (action === 'nmi') throw new ComputeError('UNSUPPORTED', 'Compute Engine has no NMI action');
    const { zone, name } = parseMachineId(id);
    const instance = await this.instance(zone, name, context.signal);
    if (!instance.labels?.[labels.instance])
      throw new ComputeError(
        'INVALID_STATE',
        `${id} is not an instance of better-compute and is never powered by it`,
        undefined,
        { provider: 'gcp', reason: 'notAttached' },
      );
    const act = async (verb: 'start' | 'stop' | 'reset', query?: Record<string, string>) =>
      settled(
        await this.client.request<GceOperation>(
          'POST',
          `/zones/${zone}/instances/${name}/${verb}`,
          {
            ...(query ? { query } : {}),
            signal: context.signal,
          },
        ),
        `${verb} ${id}`,
      );
    switch (action) {
      case 'on':
        await act('start');
        return;
      case 'graceful-off':
        await act('stop');
        return;
      case 'off':
        await act('stop', { discardLocalSsd: 'false' });
        return;
      case 'reset':
      case 'cycle':
        await act('reset');
        return;
      case 'graceful-restart': {
        // A VM cannot be started until it has stopped: wait for the stop (at most 20 s).
        await this.waitDone(await act('stop'), context.signal, `stop ${id}`);
        await act('start');
        return;
      }
      default:
        throw new ComputeError('UNSUPPORTED', `Compute Engine has no ${String(action)} action`);
    }
  }

  async *list(context: CallContext): AsyncIterable<ExternalMachine> {
    for await (const instance of this.client.aggregated<GceInstance>(
      '/aggregated/instances',
      'instances',
      {
        query: { filter: `labels.${labels.managed}=true` },
        signal: context.signal,
      },
    )) {
      if (this.inConfiguredZone(instance)) yield await this.toMachine(instance, context.signal);
    }
  }

  /** Waits (in-call, at most 20 s) for an operation to finish; UNAVAILABLE if it has not. */
  protected async waitDone(
    operation: GceOperation,
    signal: AbortSignal,
    what: string,
  ): Promise<void> {
    const done = await waitForOperation(this.client, operation, {
      signal,
      pollMs: this.options.operationPollMs ?? 2000,
      maxMs: instanceWaitMs,
      what,
    });
    if (done.status !== 'DONE')
      throw new ComputeError('UNAVAILABLE', `${what} has not finished yet`, undefined, {
        provider: 'gcp',
        reason: 'operationRunning',
        retryAfterMs: 5000,
      });
  }

  // ------------------------------------------------------------------------------- attach

  async *discover(context: CallContext): AsyncIterable<ExternalMachine> {
    const label = parseDiscoverLabel(this.config.discoverLabel);
    for await (const instance of this.client.aggregated<GceInstance>(
      '/aggregated/instances',
      'instances',
      {
        ...(label ? { query: { filter: `labels.${label.key}=${label.value}` } } : {}),
        signal: context.signal,
      },
    )) {
      if (this.inConfiguredZone(instance)) yield await this.toMachine(instance, context.signal);
    }
  }

  /**
   * Rewrites a VM's labels with `mutate` under its labelFingerprint. `mutate` returns the new
   * labels, or undefined when nothing needs writing. A stale fingerprint (412) is retried once with
   * a fresh read; a second one is a CONFLICT.
   */
  async #changeLabels(
    id: string,
    signal: AbortSignal,
    mutate: (current: Record<string, string>) => Record<string, string> | undefined,
  ): Promise<GceInstance> {
    const { zone, name } = parseMachineId(id);
    for (let attempt = 0; ; attempt++) {
      const instance = await this.instance(zone, name, signal);
      const next = mutate({ ...instance.labels });
      if (!next) return instance;
      try {
        const operation = await this.client.request<GceOperation>(
          'POST',
          `/zones/${zone}/instances/${name}/setLabels`,
          { body: { labels: next, labelFingerprint: instance.labelFingerprint }, signal },
        );
        await this.waitDone(operation, signal, `Labelling ${id}`);
        return await this.instance(zone, name, signal);
      } catch (error) {
        if (!isComputeError(error) || error.details?.status !== 412) throw error;
        if (attempt === 0) continue;
        throw new ComputeError('CONFLICT', `The labels of ${id} keep changing`, undefined, {
          provider: 'gcp',
          status: 412,
          reason: 'conditionNotMet',
        });
      }
    }
  }

  async claim(
    id: string,
    instanceId: string,
    context: CallContext,
    options: { managed?: boolean } = {},
  ): Promise<ExternalMachine> {
    const target = parseMachineId(id);
    if (!this.config.zones.includes(target.zone))
      throw new ComputeError(
        'INVALID_INPUT',
        `Zone ${target.zone} is not one of the account's zones`,
      );
    const owner = labelValue(instanceId);
    const instance = await this.#changeLabels(id, context.signal, (current) => {
      const claimed = current[labels.instance];
      if (claimed !== undefined && claimed !== owner)
        throw new ComputeError(
          'CONFLICT',
          `${id} is already claimed by instance ${claimed}`,
          undefined,
          {
            provider: 'gcp',
            reason: 'claimedByAnother',
            claimedBy: claimed,
          },
        );
      const next: Record<string, string> = { ...current, [labels.instance]: owner };
      if (options.managed) next[labels.managed] = 'true';
      const unchanged = Object.keys(next).every((key) => current[key] === next[key]);
      return unchanged ? undefined : next;
    });
    return this.toMachine(instance, context.signal);
  }

  async release(id: string, instanceId: string, context: CallContext): Promise<void> {
    // An id that never named a machine has nothing to release.
    try {
      parseMachineId(id);
    } catch {
      return;
    }
    const owner = labelValue(instanceId);
    try {
      await this.#changeLabels(id, context.signal, (current) => {
        if (current[labels.instance] !== owner) return undefined;
        const { [labels.instance]: _removed, ...rest } = current;
        return rest;
      });
    } catch (error) {
      // A machine that is gone has nothing left to release. Anything else (a 400 such as
      // `resourceNotReady` while the VM stops) is the caller's to retry: the label is still there.
      if (isComputeError(error, 'NOT_FOUND')) return;
      throw error;
    }
  }
}

/** `key=value` as a label filter; undefined when unset. */
export function parseDiscoverLabel(
  value: string | undefined,
): { key: string; value: string } | undefined {
  if (value === undefined || value === '') return undefined;
  const match = /^([a-z][a-z0-9_-]{0,62})=([a-z0-9_-]{0,63})$/.exec(value);
  if (!match)
    throw new ComputeError(
      'INVALID_CONFIG',
      'discoverLabel must be "key=value" with GCE label characters (a-z, 0-9, _ and -)',
    );
  return { key: match[1]!, value: match[2]! };
}

/** The login `ssh-keys` names for an image (the distribution's default user). */
export function sshUserOf(image: ImageRef): string {
  const name = image.toLowerCase();
  if (name.includes('debian')) return 'debian';
  if (name.includes('rocky')) return 'rocky';
  if (name.includes('centos')) return 'centos';
  return 'ubuntu';
}
