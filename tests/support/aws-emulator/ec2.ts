import type { AwsEmulator, EmulatorRequest } from './index.js';
import { ec2Error, ec2Response, el, items } from './xml.js';

// EC2 as provider-aws uses it: instance types, offerings and AZs; RunInstances with ClientToken
// dedupe; DescribeInstances with ids, filters and paging; terminate, start/stop/reboot, diagnostic
// interrupts, replace-root-volume tasks, tags and images. Knobs: newInstanceNotFound (eventual
// consistency), staleTagReads and serveStaleTags (tag writes EC2 does not show yet), asyncFailure,
// tick, settleOnRead, disableApiTermination and addInstance (foreign instances). Like EC2, StartInstances refuses a stopping instance, StopInstances a pending one and
// RebootInstances anything not running (IncorrectInstanceState).

export interface EmuType {
  type: string;
  vcpu: number;
  memoryMiB: number;
  arch: ('x86_64' | 'arm64')[];
  gpus?: { name: string; manufacturer: string; count: number };
  bareMetal?: boolean;
  instanceStorageGB?: number;
  efa?: number;
  /** (A10) NetworkInfo.MaximumNetworkCards (absent: 1). */
  networkCards?: number;
}

export interface EmuInstance {
  id: string;
  type: string;
  zone: string;
  state: 'pending' | 'running' | 'stopping' | 'stopped' | 'shutting-down' | 'terminated';
  imageId: string;
  clientToken?: string;
  /** The RunInstances parameters minus ClientToken: what a retry must repeat. */
  signature?: string;
  tags: Map<string, string>;
  volumeTags: Map<string, string>;
  launchTime: number;
  stateReason?: string;
  /** `reason` (StateTransitionReason), e.g. `Service initiated (2026-10-01 12:00:00 GMT)`. */
  transitionReason?: string;
  privateIp: string;
  publicIp?: string;
  subnetId: string;
  vpcId: string;
  groups: { id: string; name: string }[];
  /** Tags of the primary network interface (RunInstances tags it with 'network-interface'). */
  eniTags: Map<string, string>;
  /** Network interfaces attached (1 unless a test adds more); the first is the primary. */
  interfaces?: number;
  terminationProtected: boolean;
  capacityReservationId?: string;
  lifecycle?: 'spot' | 'capacity-block';
  notFoundById: number;
  notFoundByToken: number;
  rootDevice: string;
  userData?: string;
  /** Tags by-id reads show instead of `tags`, for `reads` more reads (eventually consistent tags). */
  staleTags?: { tags: Map<string, string>; reads: number };
}

const defaultTypes: EmuType[] = [
  { type: 't3.micro', vcpu: 2, memoryMiB: 1024, arch: ['x86_64'] },
  { type: 'm7i.large', vcpu: 2, memoryMiB: 8192, arch: ['x86_64'] },
  {
    type: 'g6.xlarge',
    vcpu: 4,
    memoryMiB: 16384,
    arch: ['x86_64'],
    gpus: { name: 'L4', manufacturer: 'NVIDIA', count: 1 },
    instanceStorageGB: 250,
  },
  {
    type: 'p5.48xlarge',
    vcpu: 192,
    memoryMiB: 2_097_152,
    arch: ['x86_64'],
    gpus: { name: 'H100', manufacturer: 'NVIDIA', count: 8 },
    instanceStorageGB: 30_400,
    efa: 32,
    networkCards: 32,
  },
  { type: 'm7g.large', vcpu: 2, memoryMiB: 8192, arch: ['arm64'] },
  { type: 'c7i.metal-24xl', vcpu: 96, memoryMiB: 196_608, arch: ['x86_64'], bareMetal: true },
];

const stateCodes: Record<EmuInstance['state'], number> = {
  pending: 0,
  running: 16,
  'shutting-down': 32,
  terminated: 48,
  stopping: 64,
  stopped: 80,
};

/** Filter.N.Name / Filter.N.Value.M → name → values. */
function filtersOf(params: URLSearchParams): Map<string, string[]> {
  const filters = new Map<string, string[]>();
  for (let n = 1; params.has(`Filter.${n}.Name`); n++) {
    const values: string[] = [];
    for (let m = 1; params.has(`Filter.${n}.Value.${m}`); m++)
      values.push(params.get(`Filter.${n}.Value.${m}`)!);
    filters.set(params.get(`Filter.${n}.Name`)!, values);
  }
  return filters;
}

function listOf(params: URLSearchParams, prefix: string): string[] {
  const out: string[] = [];
  for (let n = 1; params.has(`${prefix}.${n}`); n++) out.push(params.get(`${prefix}.${n}`)!);
  return out;
}

export class Ec2Emulator {
  readonly zones = new Map([
    ['us-east-1a', 'use1-az1'],
    ['us-east-1b', 'use1-az2'],
    ['us-east-1c', 'use1-az4'],
  ]);
  readonly types = new Map(defaultTypes.map((t) => [t.type, t]));
  /** zone → offered types. p5 only in us-east-1a. */
  readonly offerings = new Map<string, Set<string>>();
  readonly instances = new Map<string, EmuInstance>();
  readonly images = new Map<string, { rootDevice: string; arch: string }>([
    ['ami-0123456789abcdef0', { rootDevice: '/dev/xvda', arch: 'x86_64' }],
  ]);
  readonly replaceRootTasks: {
    id: string;
    instanceId: string;
    imageId: string;
    clientToken?: string;
  }[] = [];
  readonly diagnosticInterrupts: string[] = [];
  /** Page size cap for paged reads (small, so tests page). */
  pageSize = 2;
  /** Reads that miss a new instance: by `InstanceId` and by the `client-token` filter. */
  newInstanceNotFound = { byId: 0, byToken: 0 };
  /** Every DescribeInstances first moves transitional states one step (time passing between reads). */
  settleOnRead = false;
  /** After CreateTags/DeleteTags, this many by-id reads still show the tags from before the write. */
  staleTagReads = 0;
  /** Operations other emulator modules (capacity.ts) answer, checked before the built-in ones. */
  readonly extra = new Map<string, (request: EmulatorRequest) => Response>();
  /** RunInstances hooks: `check` may refuse the launch; `launched` sees the new instance. */
  readonly runHooks: {
    check?(params: URLSearchParams): Response | undefined;
    launched?(instance: EmuInstance, params: URLSearchParams): void;
  }[] = [];
  /** (A4) Scheduled events per instance, as DescribeInstanceStatus reports them. */
  readonly scheduledEvents = new Map<
    string,
    { id: string; code: string; description: string; notBefore: number; notAfter?: number }[]
  >();
  #next = 0;

  constructor(private readonly emu: AwsEmulator) {
    for (const zone of this.zones.keys())
      this.offerings.set(
        zone,
        new Set(
          [...this.types.keys()].filter((type) => type !== 'p5.48xlarge' || zone === 'us-east-1a'),
        ),
      );
    emu.register(/^ec2\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/, {
      service: 'ec2',
      protocol: 'ec2',
      handle: (request) => this.#handle(request),
    });
  }

  #id(prefix: string): string {
    return `${prefix}-${(++this.#next).toString(16).padStart(17, '0')}`;
  }

  /** A foreign (not better-compute created) running instance. */
  addInstance(
    options: {
      id?: string;
      type?: string;
      zone?: string;
      tags?: Record<string, string>;
      state?: EmuInstance['state'];
    } = {},
  ): EmuInstance {
    const id = options.id ?? this.#id('i');
    const instance: EmuInstance = {
      id,
      type: options.type ?? 't3.micro',
      zone: options.zone ?? 'us-east-1a',
      state: options.state ?? 'running',
      imageId: 'ami-0123456789abcdef0',
      tags: new Map(Object.entries(options.tags ?? {})),
      volumeTags: new Map(),
      launchTime: this.emu.now(),
      privateIp: `10.0.0.${this.instances.size + 10}`,
      publicIp: `54.0.0.${this.instances.size + 10}`,
      subnetId: 'subnet-0000000000000000a',
      vpcId: 'vpc-0000000000000000a',
      groups: [{ id: 'sg-0000000000000000a', name: 'default' }],
      eniTags: new Map(),
      terminationProtected: false,
      notFoundById: 0,
      notFoundByToken: 0,
      rootDevice: '/dev/xvda',
    };
    this.instances.set(id, instance);
    return instance;
  }

  /** The instance fails asynchronously after launch (stockout, volume limit). */
  asyncFailure(id: string, stateReasonCode: string): void {
    const instance = this.instances.get(id)!;
    instance.state = 'terminated';
    instance.stateReason = stateReasonCode;
  }

  /** Moves every transitional state one step. */
  tick(): void {
    for (const instance of this.instances.values()) {
      if (instance.state === 'pending') instance.state = 'running';
      else if (instance.state === 'stopping') instance.state = 'stopped';
      else if (instance.state === 'shutting-down') instance.state = 'terminated';
    }
  }

  /** The next `reads` by-id reads of `id` show `tags` (a stale replica). */
  serveStaleTags(id: string, tags: Record<string, string>, reads = 1): void {
    this.instances.get(id)!.staleTags = { tags: new Map(Object.entries(tags)), reads };
  }

  disableApiTermination(id: string): void {
    this.instances.get(id)!.terminationProtected = true;
  }

  #page<T>(all: T[], params: URLSearchParams): { page: T[]; next?: string } {
    const start = Number(params.get('NextToken')?.replace(/^tok-/, '') ?? '0');
    const max = Math.min(Number(params.get('MaxResults') ?? Infinity), this.pageSize);
    const page = all.slice(start, start + max);
    const next = start + max < all.length ? `tok-${start + max}` : undefined;
    return { page, ...(next ? { next } : {}) };
  }

  #instanceXml(instance: EmuInstance, shownTags: Map<string, string> = instance.tags): string {
    const tagSet = items(
      'tagSet',
      [...shownTags]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => `${el('key', k)}${el('value', v)}`),
    );
    const eni = `${el('networkInterfaceId', `eni-${instance.id.slice(2)}`)}<attachment>${el('deviceIndex', 0)}</attachment>${el('subnetId', instance.subnetId)}${el('vpcId', instance.vpcId)}${el('privateIpAddress', instance.privateIp)}${instance.publicIp ? `<association>${el('publicIp', instance.publicIp)}</association>` : ''}${items(
      'groupSet',
      instance.groups.map((g) => `${el('groupId', g.id)}${el('groupName', g.name)}`),
    )}`;
    return [
      el('instanceId', instance.id),
      el('imageId', instance.imageId),
      `<instanceState>${el('code', stateCodes[instance.state])}${el('name', instance.state)}</instanceState>`,
      el('privateIpAddress', instance.privateIp),
      el('ipAddress', instance.state === 'running' ? instance.publicIp : undefined),
      el('instanceType', instance.type),
      el('launchTime', new Date(instance.launchTime).toISOString()),
      `<placement>${el('availabilityZone', instance.zone)}</placement>`,
      el('clientToken', instance.clientToken),
      instance.stateReason
        ? `<stateReason>${el('code', instance.stateReason)}${el('message', instance.stateReason)}</stateReason>`
        : '',
      el('reason', instance.transitionReason),
      el('capacityReservationId', instance.capacityReservationId),
      el('instanceLifecycle', instance.lifecycle),
      el('architecture', this.types.get(instance.type)?.arch[0] ?? 'x86_64'),
      el('rootDeviceName', instance.rootDevice),
      el('subnetId', instance.subnetId),
      el('vpcId', instance.vpcId),
      tagSet,
      items('networkInterfaceSet', [
        eni,
        ...Array.from(
          { length: (instance.interfaces ?? 1) - 1 },
          (_, n) =>
            `${el('networkInterfaceId', `eni-${instance.id.slice(2)}-${n + 1}`)}<attachment>${el('deviceIndex', n + 1)}</attachment>${el('subnetId', instance.subnetId)}${el('vpcId', instance.vpcId)}`,
        ),
      ]),
    ].join('');
  }

  #matches(instance: EmuInstance, filters: Map<string, string[]>): boolean {
    for (const [name, values] of filters) {
      if (name === 'client-token' && !values.includes(instance.clientToken ?? '')) return false;
      if (name === 'instance-state-name' && !values.includes(instance.state)) return false;
      if (name === 'instance-id' && !values.includes(instance.id)) return false;
      if (name === 'tag-key' && !values.some((key) => instance.tags.has(key))) return false;
      if (name.startsWith('tag:')) {
        const value = instance.tags.get(name.slice(4));
        if (value === undefined || !values.includes(value)) return false;
      }
    }
    return true;
  }

  #handle(request: EmulatorRequest): Response {
    const p = request.params;
    const action = request.operation;
    const extra = this.extra.get(action);
    if (extra) return extra(request);
    switch (action) {
      case 'DescribeAvailabilityZones': {
        const names = listOf(p, 'ZoneName');
        const zones = [...this.zones].filter(
          ([zone]) => names.length === 0 || names.includes(zone),
        );
        return ec2Response(
          action,
          items(
            'availabilityZoneInfo',
            zones.map(
              ([zone, id]) =>
                `${el('zoneName', zone)}${el('zoneId', id)}${el('zoneState', 'available')}${el('regionName', 'us-east-1')}`,
            ),
          ),
        );
      }
      case 'DescribeInstanceTypeOfferings': {
        const locations = filtersOf(p).get('location') ?? [...this.offerings.keys()];
        const all: [string, string][] = [];
        for (const zone of locations)
          for (const type of this.offerings.get(zone) ?? []) all.push([zone, type]);
        const { page, next } = this.#page(all, p);
        return ec2Response(
          action,
          items(
            'instanceTypeOfferingSet',
            page.map(
              ([zone, type]) =>
                `${el('instanceType', type)}${el('locationType', 'availability-zone')}${el('location', zone)}`,
            ),
          ) + el('nextToken', next),
        );
      }
      case 'DescribeInstanceTypes': {
        const names = listOf(p, 'InstanceType');
        if (names.length > 100)
          return ec2Error('InvalidParameterValue', 'at most 100 instance types');
        const unknown = names.find((name) => !this.types.has(name));
        if (unknown) return ec2Error('InvalidInstanceType', `unknown ${unknown}`);
        const all = names.length
          ? names.map((name) => this.types.get(name)!)
          : [...this.types.values()];
        const { page, next } = this.#page(all, p);
        return ec2Response(
          action,
          items(
            'instanceTypeSet',
            page.map(
              (t) =>
                `${el('instanceType', t.type)}${el('bareMetal', t.bareMetal ?? false)}<processorInfo>${items(
                  'supportedArchitectures',
                  t.arch.map((a) => a),
                )}</processorInfo><vCpuInfo>${el('defaultVCpus', t.vcpu)}</vCpuInfo><memoryInfo>${el('sizeInMiB', t.memoryMiB)}</memoryInfo>${t.instanceStorageGB ? `<instanceStorageInfo>${el('totalSizeInGB', t.instanceStorageGB)}</instanceStorageInfo>` : ''}${t.gpus ? `<gpuInfo>${items('gpus', [`${el('name', t.gpus.name)}${el('manufacturer', t.gpus.manufacturer)}${el('count', t.gpus.count)}`])}</gpuInfo>` : ''}<networkInfo>${el('efaSupported', t.efa !== undefined)}${el('maximumNetworkCards', t.networkCards)}${t.efa ? `<efaInfo>${el('maximumEfaInterfaces', t.efa)}</efaInfo>` : ''}</networkInfo>`,
            ),
          ) + el('nextToken', next),
        );
      }
      case 'DescribeImages': {
        const ids = listOf(p, 'ImageId');
        const found = ids.filter((id) => this.images.has(id));
        if (found.length < ids.length)
          return ec2Error('InvalidAMIID.NotFound', 'The image id does not exist');
        return ec2Response(
          action,
          items(
            'imagesSet',
            found.map(
              (id) =>
                `${el('imageId', id)}${el('rootDeviceName', this.images.get(id)!.rootDevice)}${el('architecture', this.images.get(id)!.arch)}`,
            ),
          ),
        );
      }
      case 'RunInstances':
        return this.#run(request);
      case 'DescribeInstanceStatus': {
        const codes = filtersOf(p).get('event.code');
        const found = [...this.instances.values()].filter((instance) =>
          (this.scheduledEvents.get(instance.id) ?? []).some(
            (event) => !codes || codes.includes(event.code),
          ),
        );
        const { page, next } = this.#page(found, p);
        const iso = (ms: number) => new Date(ms).toISOString();
        return ec2Response(
          action,
          items(
            'instanceStatusSet',
            page.map(
              (instance) =>
                `${el('instanceId', instance.id)}${el('availabilityZone', instance.zone)}` +
                items(
                  'eventsSet',
                  (this.scheduledEvents.get(instance.id) ?? [])
                    .filter((event) => !codes || codes.includes(event.code))
                    .map(
                      (event) =>
                        `${el('instanceEventId', event.id)}${el('code', event.code)}${el('description', event.description)}${el('notBefore', iso(event.notBefore))}${el('notAfter', event.notAfter === undefined ? undefined : iso(event.notAfter))}`,
                    ),
                ) +
                `<instanceState>${el('code', stateCodes[instance.state])}${el('name', instance.state)}</instanceState>`,
            ),
          ) + el('nextToken', next),
        );
      }
      case 'DescribeInstances': {
        if (this.settleOnRead) this.tick();
        const ids = listOf(p, 'InstanceId');
        const filters = filtersOf(p);
        let found: EmuInstance[];
        if (ids.length) {
          found = [];
          for (const id of ids) {
            const instance = this.instances.get(id);
            if (instance && instance.notFoundById > 0) {
              instance.notFoundById -= 1;
              return ec2Error(
                'InvalidInstanceID.NotFound',
                `The instance ID '${id}' does not exist`,
              );
            }
            if (!instance)
              return ec2Error(
                'InvalidInstanceID.NotFound',
                `The instance ID '${id}' does not exist`,
              );
            found.push(instance);
          }
        } else {
          found = [...this.instances.values()].filter((instance) => {
            if (filters.has('client-token') && instance.notFoundByToken > 0) {
              instance.notFoundByToken -= 1;
              return false;
            }
            return true;
          });
        }
        found = found.filter((instance) => this.#matches(instance, filters));
        const { page, next } = ids.length ? { page: found, next: undefined } : this.#page(found, p);
        const shown = (instance: EmuInstance) => {
          const stale = instance.staleTags;
          if (!ids.length || !stale || stale.reads <= 0) return instance.tags;
          stale.reads -= 1;
          return stale.tags;
        };
        return ec2Response(
          action,
          items(
            'reservationSet',
            page.map(
              (instance) =>
                `${el('reservationId', `r-${instance.id.slice(2)}`)}${el('ownerId', '222222222222')}${items('instancesSet', [this.#instanceXml(instance, shown(instance))])}`,
            ),
          ) + el('nextToken', next),
        );
      }
      case 'TerminateInstances':
      case 'StartInstances':
      case 'StopInstances': {
        const ids = listOf(p, 'InstanceId');
        const changes: string[] = [];
        for (const id of ids) {
          const instance = this.instances.get(id);
          if (!instance)
            return ec2Error('InvalidInstanceID.NotFound', `The instance ID '${id}' does not exist`);
          const previous = instance.state;
          if (action === 'TerminateInstances') {
            if (instance.terminationProtected)
              return ec2Error(
                'OperationNotPermitted',
                `The instance '${id}' may not be terminated. Modify its 'disableApiTermination' instance attribute and try again.`,
              );
            if (instance.state !== 'terminated') instance.state = 'shutting-down';
          } else if (action === 'StartInstances') {
            if (instance.state === 'terminated' || instance.state === 'shutting-down')
              return ec2Error('IncorrectInstanceState', 'terminated');
            if (instance.state === 'stopping')
              return ec2Error(
                'IncorrectInstanceState',
                `The instance '${id}' is not in a state from which it can be started.`,
              );
            if (instance.state === 'stopped') instance.state = 'pending';
          } else {
            if (instance.state === 'terminated' || instance.state === 'shutting-down')
              return ec2Error('IncorrectInstanceState', 'terminated');
            if (instance.state === 'pending')
              return ec2Error(
                'IncorrectInstanceState',
                `The instance '${id}' is not in a state from which it can be stopped.`,
              );
            const force = p.get('Force') === 'true';
            if (instance.state === 'running') instance.state = force ? 'stopped' : 'stopping';
            else if (instance.state === 'stopping' && force) instance.state = 'stopped';
          }
          changes.push(
            `${el('instanceId', id)}<currentState>${el('code', stateCodes[instance.state])}${el('name', instance.state)}</currentState><previousState>${el('code', stateCodes[previous])}${el('name', previous)}</previousState>`,
          );
        }
        return ec2Response(action, items('instancesSet', changes));
      }
      case 'RebootInstances': {
        for (const id of listOf(p, 'InstanceId')) {
          const instance = this.instances.get(id);
          if (!instance)
            return ec2Error('InvalidInstanceID.NotFound', `The instance ID '${id}' does not exist`);
          if (instance.state !== 'running')
            return ec2Error(
              'IncorrectInstanceState',
              `The instance '${id}' is not in a state from which it can be rebooted.`,
            );
        }
        return ec2Response(action, el('return', true));
      }
      case 'SendDiagnosticInterrupt': {
        const id = p.get('InstanceId') ?? '';
        if (!this.instances.has(id))
          return ec2Error('InvalidInstanceID.NotFound', `The instance ID '${id}' does not exist`);
        this.diagnosticInterrupts.push(id);
        return ec2Response(action, '');
      }
      case 'CreateReplaceRootVolumeTask': {
        const instanceId = p.get('InstanceId') ?? '';
        if (!this.instances.has(instanceId))
          return ec2Error('InvalidInstanceID.NotFound', 'no such instance');
        const clientToken = p.get('ClientToken') ?? undefined;
        let task = this.replaceRootTasks.find((t) => clientToken && t.clientToken === clientToken);
        if (!task) {
          task = {
            id: this.#id('replacevol'),
            instanceId,
            imageId: p.get('ImageId') ?? '',
            ...(clientToken ? { clientToken } : {}),
          };
          this.replaceRootTasks.push(task);
        }
        return ec2Response(
          action,
          `<replaceRootVolumeTask>${el('replaceRootVolumeTaskId', task.id)}${el('instanceId', instanceId)}${el('taskState', 'pending')}</replaceRootVolumeTask>`,
        );
      }
      case 'CreateTags':
      case 'DeleteTags': {
        const resources = listOf(p, 'ResourceId');
        for (const id of resources) {
          const instance = this.instances.get(id);
          if (!instance)
            return ec2Error('InvalidInstanceID.NotFound', `The instance ID '${id}' does not exist`);
          if (this.staleTagReads > 0)
            instance.staleTags = { tags: new Map(instance.tags), reads: this.staleTagReads };
          for (let n = 1; p.has(`Tag.${n}.Key`); n++) {
            const key = p.get(`Tag.${n}.Key`)!;
            if (action === 'CreateTags') instance.tags.set(key, p.get(`Tag.${n}.Value`) ?? '');
            else {
              const value = p.get(`Tag.${n}.Value`);
              if (value === null || instance.tags.get(key) === value) instance.tags.delete(key);
            }
          }
        }
        return ec2Response(action, el('return', true));
      }
      default:
        return ec2Error('InvalidAction', `The action ${action} is not valid for this web service.`);
    }
  }

  #run(request: EmulatorRequest): Response {
    const p = request.params;
    const token = p.get('ClientToken') ?? undefined;
    const signature = [...p]
      .filter(([key]) => key !== 'ClientToken')
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join('&');
    if (token) {
      const existing = [...this.instances.values()].find(
        (instance) => instance.clientToken === token,
      );
      if (existing) {
        if (existing.signature !== signature)
          return ec2Error(
            'IdempotentParameterMismatch',
            'Arguments on this idempotent request are inconsistent with arguments used in previous request(s).',
          );
        return ec2Response(
          'RunInstances',
          `${el('reservationId', `r-${existing.id.slice(2)}`)}${el('ownerId', '222222222222')}${items('instancesSet', [this.#instanceXml(existing)])}`,
        );
      }
    }
    const type = p.get('InstanceType') ?? '';
    const zone = p.get('Placement.AvailabilityZone') ?? 'us-east-1a';
    if (!this.types.has(type))
      return ec2Error('InvalidParameterValue', `Invalid value '${type}' for InstanceType.`);
    if (!this.offerings.get(zone)?.has(type))
      return ec2Error(
        'Unsupported',
        `Your requested instance type (${type}) is not supported in your requested Availability Zone (${zone}).`,
      );
    const imageId = p.get('ImageId') ?? '';
    if (!/^ami-[0-9a-f]{8,17}$/.test(imageId) && !imageId.startsWith('resolve:ssm:'))
      return ec2Error('InvalidAMIID.Malformed', 'Invalid id');
    const userData = p.get('UserData') ?? undefined;
    if (userData && Buffer.from(userData, 'base64').length > 16_384)
      return ec2Error('InvalidParameterValue', 'User data is limited to 16384 bytes');
    for (const hook of this.runHooks) {
      const refused = hook.check?.(p);
      if (refused) return refused;
    }
    const instance = this.addInstance({ type, zone, state: 'pending' });
    instance.imageId = imageId.startsWith('resolve:ssm:') ? 'ami-0fedcba9876543210' : imageId;
    instance.publicIp =
      p.get('NetworkInterface.1.AssociatePublicIpAddress') === 'false'
        ? undefined
        : instance.publicIp;
    if (token) instance.clientToken = token;
    instance.signature = signature;
    instance.notFoundById = this.newInstanceNotFound.byId;
    instance.notFoundByToken = this.newInstanceNotFound.byToken;
    instance.userData = userData;
    instance.rootDevice = p.get('BlockDeviceMapping.1.DeviceName') ?? '/dev/sda1';
    const subnet = p.get('NetworkInterface.1.SubnetId');
    if (subnet) instance.subnetId = subnet;
    for (let n = 1; p.has(`TagSpecification.${n}.ResourceType`); n++) {
      const type = p.get(`TagSpecification.${n}.ResourceType`);
      const target =
        type === 'instance'
          ? instance.tags
          : type === 'network-interface'
            ? instance.eniTags
            : instance.volumeTags;
      for (let m = 1; p.has(`TagSpecification.${n}.Tag.${m}.Key`); m++)
        target.set(
          p.get(`TagSpecification.${n}.Tag.${m}.Key`)!,
          p.get(`TagSpecification.${n}.Tag.${m}.Value`) ?? '',
        );
    }
    for (const hook of this.runHooks) hook.launched?.(instance, p);
    return ec2Response(
      'RunInstances',
      `${el('reservationId', `r-${instance.id.slice(2)}`)}${el('ownerId', '222222222222')}${items('instancesSet', [this.#instanceXml(instance)])}`,
    );
  }
}
