import { ComputeError, type Clock, type ExternalMachine } from '@better-compute/core';
import type { QueryClient, XmlElement } from '@better-compute/aws-core';

/** One EC2 instance type, as `DescribeInstanceTypes` reports it. */
export interface InstanceTypeInfo {
  type: string;
  vcpu: number;
  memoryGiB: number;
  arch: readonly ('x86_64' | 'arm64')[];
  gpus?: { model: string; count: number };
  bareMetal: boolean;
  instanceStorageGiB?: number;
  efa: boolean;
  maxEfaInterfaces?: number;
}

const gpuNames: Readonly<Record<string, string>> = {
  H100: 'H100',
  H200: 'H200',
  B200: 'B200',
  A100: 'A100',
  L4: 'L4',
  L40S: 'L40S',
  A10G: 'A10G',
  T4: 'T4',
  T4G: 'T4',
};

/** A `GpuInfo` manufacturer and name as the pool `gpuModel` string; unknown → 'other'. */
export function gpuModel(manufacturer: string, name: string): string {
  if (manufacturer.trim().toUpperCase() !== 'NVIDIA') return 'other';
  return gpuNames[name.trim().toUpperCase()] ?? 'other';
}

const number = (text: string | undefined): number => {
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 ? value : 0;
};

export function parseInstanceTypes(items: readonly XmlElement[]): InstanceTypeInfo[] {
  const out: InstanceTypeInfo[] = [];
  for (const item of items) {
    const type = item.textOf('instanceType');
    if (!type) continue;
    const arch = item
      .child('processorInfo')
      ?.items('supportedArchitectures')
      .map((entry) => entry.text)
      .filter((value): value is 'x86_64' | 'arm64' => value === 'x86_64' || value === 'arm64');
    let gpus: InstanceTypeInfo['gpus'];
    const gpuItems = item.child('gpuInfo')?.items('gpus') ?? [];
    if (gpuItems.length) {
      const count = gpuItems.reduce((sum, gpu) => sum + number(gpu.textOf('count')), 0);
      const models = new Set(
        gpuItems.map((gpu) => gpuModel(gpu.textOf('manufacturer') ?? '', gpu.textOf('name') ?? '')),
      );
      gpus = { model: models.size === 1 ? [...models][0]! : 'other', count };
    }
    const storage = item.child('instanceStorageInfo')?.textOf('totalSizeInGB');
    const network = item.child('networkInfo');
    const efa = network?.textOf('efaSupported') === 'true';
    const maxEfa = network?.child('efaInfo')?.textOf('maximumEfaInterfaces');
    out.push({
      type,
      vcpu: number(item.child('vCpuInfo')?.textOf('defaultVCpus')),
      memoryGiB: number(item.child('memoryInfo')?.textOf('sizeInMiB')) / 1024,
      arch: arch?.length ? arch : ['x86_64'],
      ...(gpus ? { gpus } : {}),
      bareMetal: item.textOf('bareMetal') === 'true',
      ...(storage !== undefined ? { instanceStorageGiB: number(storage) } : {}),
      efa,
      ...(maxEfa !== undefined ? { maxEfaInterfaces: number(maxEfa) } : {}),
    });
  }
  return out;
}

export interface InstanceTypeCache {
  get(
    types: readonly string[],
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string, InstanceTypeInfo>>;
}

/** Instance types cached for `ttlMs` (default a day), read in batches of 100. */
export function instanceTypeCache(
  ec2: QueryClient,
  options: { clock: Clock; ttlMs?: number },
): InstanceTypeCache {
  const ttlMs = options.ttlMs ?? 86_400_000;
  const cache = new Map<string, { info: InstanceTypeInfo; at: number }>();
  return {
    async get(types, signal) {
      const now = options.clock.now();
      const missing = [...new Set(types)].filter((type) => {
        const hit = cache.get(type);
        return !hit || now - hit.at >= ttlMs;
      });
      for (let start = 0; start < missing.length; start += 100) {
        const batch = missing.slice(start, start + 100);
        let token: string | undefined;
        const seen = new Set<string>();
        do {
          const doc = await ec2.call(
            'DescribeInstanceTypes',
            { InstanceType: batch, NextToken: token },
            { signal },
          );
          for (const info of parseInstanceTypes(doc.items('instanceTypeSet')))
            cache.set(info.type, { info, at: now });
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
      const out = new Map<string, InstanceTypeInfo>();
      for (const type of types) {
        const hit = cache.get(type);
        if (hit) out.set(type, hit.info);
      }
      return out;
    },
  };
}

export interface ZoneCache {
  /** The zone id (`use1-az1`) of a zone name, as this account sees it. */
  zoneId(zone: string, signal: AbortSignal): Promise<string | undefined>;
  /** Every known zone name → zone id. */
  all(signal: AbortSignal): Promise<ReadonlyMap<string, string>>;
}

/** `DescribeAvailabilityZones` cached for `ttlMs` (default an hour). */
export function zoneCache(ec2: QueryClient, options: { clock: Clock; ttlMs?: number }): ZoneCache {
  const ttlMs = options.ttlMs ?? 3_600_000;
  let loaded: { zones: Map<string, string>; at: number } | undefined;
  const load = async (signal: AbortSignal) => {
    const now = options.clock.now();
    if (loaded && now - loaded.at < ttlMs) return loaded.zones;
    const doc = await ec2.call('DescribeAvailabilityZones', {}, { signal });
    const zones = new Map<string, string>();
    for (const item of doc.items('availabilityZoneInfo')) {
      const name = item.textOf('zoneName');
      const id = item.textOf('zoneId');
      if (name && id) zones.set(name, id);
    }
    loaded = { zones, at: now };
    return zones;
  };
  return {
    async zoneId(zone, signal) {
      return (await load(signal)).get(zone);
    },
    all: load,
  };
}

const states: Readonly<Record<string, ExternalMachine['state']>> = {
  pending: 'pending',
  running: 'running',
  stopping: 'stopped',
  stopped: 'stopped',
  'shutting-down': 'deleting',
  terminated: 'deleted',
};

/** The EC2 instance state as the contract's machine state. */
export function machineState(state: string | undefined): ExternalMachine['state'] {
  return state !== undefined && Object.hasOwn(states, state) ? states[state]! : 'unknown';
}

/** `Service initiated (2026-10-01 12:00:00 GMT)` → epoch ms. */
function transitionTime(reason: string | undefined): number | undefined {
  const match = reason ? /\((\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) GMT\)/.exec(reason) : null;
  if (!match) return undefined;
  const at = Date.parse(`${match[1]}T${match[2]}Z`);
  return Number.isFinite(at) ? at : undefined;
}

/** The state reasons EC2 gives a Spot Instance it reclaimed, and what it did. */
const spotReclaims: Readonly<Record<string, 'terminate' | 'stop' | 'hibernate'>> = {
  'Server.SpotInstanceTermination': 'terminate',
  'Server.SpotInstanceShutdown': 'stop',
  'Server.SpotInstanceHibernate': 'hibernate',
};

/**
 * The `better-compute:` security groups (AD10) an interface carries, by name: one per network tag.
 * A network's own group (`bc-net-<network>`, its untargeted rules) is not a tag.
 */
const managedGroup = /^bc-(?!net-)/;

/** An EC2 instance (a `DescribeInstances`/`RunInstances` item) as an `ExternalMachine`. */
export function toMachine(
  instance: XmlElement,
  info: {
    region: string;
    types: ReadonlyMap<string, InstanceTypeInfo>;
    zoneIds: ReadonlyMap<string, string>;
    /** When the read happened: the interruption time when EC2's reason has none. */
    now?: number;
  },
): ExternalMachine {
  const id = instance.textOf('instanceId') ?? '';
  const type = instance.textOf('instanceType');
  const zone = instance.child('placement')?.textOf('availabilityZone');
  const capacityReservation = instance.textOf('capacityReservationId');
  const lifecycle = instance.textOf('instanceLifecycle');
  const spot = lifecycle === 'spot';
  const block = lifecycle === 'capacity-block';
  // vps knows a Capacity Block as cb:cr-… (markets/reservations.ts); the offer id names the cr-… itself.
  const reservation =
    capacityReservation && block ? `cb:${capacityReservation}` : capacityReservation;
  const market = spot
    ? 'spot'
    : block
      ? 'capacity-block'
      : capacityReservation
        ? 'reserved'
        : undefined;
  const tags: Record<string, string> = {};
  for (const item of instance.items('tagSet')) {
    const key = item.textOf('key');
    if (key !== undefined && !Object.hasOwn(tags, key) && key !== '__proto__')
      tags[key] = item.textOf('value') ?? '';
  }
  const labels: Record<string, string> = { ...tags };
  const zoneId = zone ? info.zoneIds.get(zone) : undefined;
  if (zoneId) labels['topology.aws/zone-id'] = zoneId;
  const addresses: string[] = [];
  const push = (address: string | undefined) => {
    if (address && !addresses.includes(address)) addresses.push(address);
  };
  push(instance.textOf('privateIpAddress'));
  push(instance.textOf('ipAddress'));
  const networks: NonNullable<ExternalMachine['networks']>[number][] = [];
  for (const eni of instance.items('networkInterfaceSet')) {
    const publicAddress = eni.child('association')?.textOf('publicIp');
    push(eni.textOf('privateIpAddress'));
    push(publicAddress);
    for (const v6 of eni.items('ipv6AddressesSet')) push(v6.textOf('ipv6Address'));
    const groups = eni
      .items('groupSet')
      .map((group) => group.textOf('groupName') ?? '')
      .filter((name) => managedGroup.test(name));
    networks.push({
      network: eni.textOf('vpcId') ?? instance.textOf('vpcId') ?? '',
      ...(eni.textOf('subnetId') ? { subnet: eni.textOf('subnetId')! } : {}),
      ...(eni.textOf('privateIpAddress') ? { address: eni.textOf('privateIpAddress')! } : {}),
      ...(publicAddress ? { publicAddress } : {}),
      ...(groups.length ? { tags: groups } : {}),
    });
  }
  const typeInfo = type ? info.types.get(type) : undefined;
  const launched = Date.parse(instance.textOf('launchTime') ?? '');
  const name = tags.Name;
  const claimedBy = tags['better-compute:instance'];
  return {
    id,
    ...(name ? { name } : {}),
    state: machineState(instance.child('instanceState')?.textOf('name')),
    ...(zone && type
      ? {
          offerId: `${zone}/${type}${capacityReservation ? `@${capacityReservation}` : ''}${spot ? ':spot' : ''}`,
        }
      : {}),
    region: info.region,
    addresses,
    ...(zone ? { zone } : {}),
    ...(type ? { machineType: type } : {}),
    ...(typeInfo ? { vcpu: typeInfo.vcpu, memoryGiB: typeInfo.memoryGiB } : {}),
    ...(typeInfo?.gpus ? { gpus: { ...typeInfo.gpus } } : {}),
    labels,
    ...(networks.length ? { networks } : {}),
    ...(reservation ? { reservation } : {}),
    ...(Number.isFinite(launched) ? { createdAt: launched } : {}),
    ...(claimedBy ? { claimedBy } : {}),
    ...(market ? { market } : {}),
    ...interruptionOf(),
  };

  function interruptionOf(): Pick<ExternalMachine, 'interruption'> {
    const code = instance.child('stateReason')?.textOf('code');
    if (!spot || code === undefined || !Object.hasOwn(spotReclaims, code)) return {};
    const at = transitionTime(instance.textOf('reason')) ?? info.now;
    if (at === undefined) return {};
    return { interruption: { kind: 'spot', at, action: spotReclaims[code]! } };
  }
}
