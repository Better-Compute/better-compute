import { ComputeError, type Clock } from '@better-compute/core';
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
      const models = new Set(gpuItems.map((gpu) => gpuModel(gpu.textOf('manufacturer') ?? '', gpu.textOf('name') ?? '')));
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
  get(types: readonly string[], signal: AbortSignal): Promise<ReadonlyMap<string, InstanceTypeInfo>>;
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
          const doc = await ec2.call('DescribeInstanceTypes', { InstanceType: batch, NextToken: token }, { signal });
          for (const info of parseInstanceTypes(doc.items('instanceTypeSet'))) cache.set(info.type, { info, at: now });
          token = doc.textOf('nextToken') || undefined;
          if (token && seen.has(token))
            throw new ComputeError('PROVIDER_ERROR', 'AWS returned a pagination token twice', undefined, {
              provider: 'aws',
              reason: 'pagination-loop',
            });
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
