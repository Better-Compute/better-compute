import {
  ComputeError,
  canonicalGpuModel,
  type CallContext,
  type Clock,
  type ProviderListPrice,
} from '@better-compute/core';
import { assertRegion, partitionOf, type JsonClient } from '@better-compute/aws-core';

// Provider list prices (A11, platform compute billing D14) from the Price List Query API (`pricing:GetProducts`,
// service AmazonEC2), read once per region per 24 hours. EC2 prices whole instance types, while proposals price
// vCPUs, GiBs and GPUs, so each family's instance price is split:
//
// - a GiB of memory weighs `memoryWeightPerGib` of a vCPU (about AWS's own 7th-generation c-to-m difference), and
//   the vCPU price is what is left, so the two compose back to the family's instance price exactly;
// - a GPU type's vCPUs and memory are priced at the region's cheapest general-purpose family, and the rest of the
//   instance price, per GPU, is the GPU's price. GPU models the meter catalog does not name are left out (the whole
//   family), as are Spot prices (they are not in the Price List).
//
// Only Linux, shared tenancy, on-demand capacity without preinstalled software is read. Fail closed: a product
// this mapping cannot read gives no price, never a guessed one.

/** A GiB of memory is priced at this part of a vCPU when an instance price is split. */
export const memoryWeightPerGib = 0.074;

/** How long a region's prices are kept. */
export const priceListTtlMs = 24 * 3_600_000;
/** EC2 bills a month of storage as 730 hours. */
const hoursPerMonth = 730;
const readMs = 50_000;

/** The families whose cheapest split prices a GPU type's vCPUs and memory (vps' general-purpose x86 families). */
const referenceFamilies: ReadonlySet<string> = new Set([
  'm5',
  'm5a',
  'm6i',
  'm6a',
  'm7i',
  'm7a',
  'm8i',
  'm8a',
]);

/** EC2 GPU families and the GPU they carry; `canonicalGpuModel` names the meter family. */
const gpuFamilies: Readonly<Record<string, string>> = {
  p4d: 'A100',
  p4de: 'A100',
  p5: 'H100',
  p5e: 'H200',
  p5en: 'H200',
  'p6-b200': 'B200',
  'p6e-gb200': 'GB200',
  g6: 'L4',
  gr6: 'L4',
  g6e: 'L40S',
  g5: 'A10G',
  g4dn: 'T4',
  p3: 'V100',
  p3dn: 'V100',
};

interface PriceDimension {
  unit?: string;
  beginRange?: string;
  pricePerUnit?: Record<string, string>;
}
interface PriceListItem {
  product?: { productFamily?: string; sku?: string; attributes?: Record<string, string> };
  terms?: { OnDemand?: Record<string, { priceDimensions?: Record<string, PriceDimension> }> };
}

/** A decimal price as integer micros (rounded), or undefined when it is not one. */
function micros(text: string | undefined): number | undefined {
  if (typeof text !== 'string' || !/^\d{1,12}(?:\.\d{1,20})?$/.test(text)) return undefined;
  const value = Math.round(Number(text) * 1e6);
  return Number.isSafeInteger(value) ? value : undefined;
}

/** The single on-demand price of a product in `unit`, starting at 0: `{ micros, currency }`. */
function onDemandPrice(
  item: PriceListItem,
  unit: string,
): { micros: number; currency: string } | undefined {
  const terms = Object.values(item.terms?.OnDemand ?? {});
  const dimensions = terms.flatMap((term) => Object.values(term.priceDimensions ?? {}));
  const usable = dimensions.filter(
    (dimension) => dimension.unit === unit && (dimension.beginRange ?? '0') === '0',
  );
  if (usable.length !== 1) return undefined;
  const entries = Object.entries(usable[0]!.pricePerUnit ?? {});
  if (entries.length !== 1) return undefined;
  const [currency, amount] = entries[0]!;
  const value = micros(amount);
  return value === undefined || value === 0 || !/^[A-Z]{3}$/.test(currency)
    ? undefined
    : { micros: value, currency };
}

interface InstancePrice {
  sku: string;
  family: string;
  vcpu: number;
  memoryGiB: number;
  gpus: number;
  micros: number;
  currency: string;
}

/** An instance type product as its shape and hourly price; undefined when any of it is unreadable. */
function instanceOf(item: PriceListItem): InstancePrice | undefined {
  const attributes = item.product?.attributes ?? {};
  const type = attributes.instanceType ?? '';
  const match = /^([a-z][a-z0-9-]*)\.[a-z0-9-]+$/.exec(type);
  const vcpu = Number(attributes.vcpu);
  const memory = /^(\d+(?:\.\d+)?) GiB$/.exec(attributes.memory ?? '');
  const gpus = attributes.gpu === undefined || attributes.gpu === '' ? 0 : Number(attributes.gpu);
  const price = onDemandPrice(item, 'Hrs');
  const sku = item.product?.sku;
  if (!match || !memory || !price || !sku) return undefined;
  if (!Number.isInteger(vcpu) || vcpu <= 0 || !Number.isInteger(gpus) || gpus < 0) return undefined;
  return {
    sku,
    family: match[1]!,
    vcpu,
    memoryGiB: Number(memory[1]),
    gpus,
    micros: price.micros,
    currency: price.currency,
  };
}

/** One instance price split: memory at the weight, the vCPU the rest, so they compose back to the price. */
function split(instance: InstancePrice): { vcpu: number; memory: number } {
  const memory = Math.round(
    (memoryWeightPerGib * instance.micros) /
      (instance.vcpu + memoryWeightPerGib * instance.memoryGiB),
  );
  const vcpu = Math.round((instance.micros - instance.memoryGiB * memory) / instance.vcpu);
  return { vcpu, memory };
}

/** The list prices of one region's products, in the mapping above. */
export function pricesOfRegion(
  region: string,
  items: { instances: PriceListItem[]; storage: PriceListItem[]; addresses: PriceListItem[] },
): ProviderListPrice[] {
  const out: ProviderListPrice[] = [];
  const base = (sku: string, currency: string) => ({ region, spot: false, currency, sku });
  const instances = items.instances
    .map(instanceOf)
    .filter((instance): instance is InstancePrice => instance !== undefined);
  // Per family, the size with the lowest split vCPU price (sizes of one family price linearly; ties by SKU).
  const families = new Map<string, { instance: InstancePrice; vcpu: number; memory: number }>();
  for (const instance of instances) {
    if (instance.gpus > 0) continue;
    const parts = split(instance);
    const seen = families.get(`${instance.family}\u0000${instance.currency}`);
    if (
      !seen ||
      parts.vcpu < seen.vcpu ||
      (parts.vcpu === seen.vcpu && instance.sku < seen.instance.sku)
    )
      families.set(`${instance.family}\u0000${instance.currency}`, { instance, ...parts });
  }
  for (const { instance, vcpu, memory } of families.values()) {
    if (vcpu <= 0 || memory <= 0) continue;
    const row = base(instance.sku, instance.currency);
    out.push(
      {
        ...row,
        resource: 'vcpu',
        machineFamily: instance.family,
        unitPriceMicros: vcpu,
        unit: 'hour',
      },
      {
        ...row,
        resource: 'memory',
        machineFamily: instance.family,
        unitPriceMicros: memory,
        unit: 'gib-hour',
      },
    );
  }

  // GPU types: vCPUs and memory at the cheapest reference family (by a vCPU and four GiB), GPUs the rest.
  const reference = new Map<string, { vcpu: number; memory: number }>();
  for (const { instance, vcpu, memory } of families.values()) {
    if (!referenceFamilies.has(instance.family) || vcpu <= 0 || memory <= 0) continue;
    const seen = reference.get(instance.currency);
    if (!seen || vcpu + 4 * memory < seen.vcpu + 4 * seen.memory)
      reference.set(instance.currency, { vcpu, memory });
  }
  const gpuFamilyRows = new Map<
    string,
    { instance: InstancePrice; perGpu: number; model: string }
  >();
  for (const instance of instances) {
    if (instance.gpus === 0) continue;
    const rate = reference.get(instance.currency);
    const raw = gpuFamilies[instance.family];
    const model = raw === undefined ? 'other' : canonicalGpuModel(raw);
    if (!rate || model === 'other') continue;
    const perGpu = Math.round(
      (instance.micros - instance.vcpu * rate.vcpu - instance.memoryGiB * rate.memory) /
        instance.gpus,
    );
    if (perGpu <= 0) continue;
    const key = `${instance.family}\u0000${instance.currency}`;
    const seen = gpuFamilyRows.get(key);
    if (
      !seen ||
      perGpu < seen.perGpu ||
      (perGpu === seen.perGpu && instance.sku < seen.instance.sku)
    )
      gpuFamilyRows.set(key, { instance, perGpu, model });
  }
  const gpuModels = new Map<string, ProviderListPrice>();
  for (const { instance, perGpu, model } of gpuFamilyRows.values()) {
    const rate = reference.get(instance.currency)!;
    const row = base(instance.sku, instance.currency);
    out.push(
      {
        ...row,
        resource: 'vcpu',
        machineFamily: instance.family,
        unitPriceMicros: rate.vcpu,
        unit: 'hour',
      },
      {
        ...row,
        resource: 'memory',
        machineFamily: instance.family,
        unitPriceMicros: rate.memory,
        unit: 'gib-hour',
      },
    );
    // One GPU row per model and currency: the cheapest family's.
    const key = `${model}\u0000${instance.currency}`;
    const seen = gpuModels.get(key);
    if (!seen || perGpu < seen.unitPriceMicros)
      gpuModels.set(key, {
        ...row,
        resource: 'gpu',
        gpuModel: model,
        unitPriceMicros: perGpu,
        unit: 'hour',
      });
  }
  out.push(...gpuModels.values());

  // EBS capacity (GB-Mo, which EBS bills as GiB) per volume type.
  const disks = new Map<string, ProviderListPrice>();
  for (const item of items.storage) {
    const attributes = item.product?.attributes ?? {};
    const type = attributes.volumeApiName;
    const price = onDemandPrice(item, 'GB-Mo');
    const sku = item.product?.sku;
    if (!type || !/^[a-z0-9]{2,16}$/.test(type) || !price || !sku) continue;
    if (!/EBS:VolumeUsage/.test(attributes.usagetype ?? '')) continue;
    const key = `${type}\u0000${price.currency}`;
    const row: ProviderListPrice = {
      ...base(sku, price.currency),
      resource: 'disk',
      diskType: type,
      unitPriceMicros: Math.round(price.micros / hoursPerMonth),
      unit: 'gib-hour',
    };
    // Two products for one type that disagree are no answer.
    const seen = disks.get(key);
    if (seen && seen.unitPriceMicros !== row.unitPriceMicros) disks.set(key, { ...seen, sku: '' });
    else if (!seen) disks.set(key, row);
  }
  out.push(...[...disks.values()].filter((row) => row.sku !== ''));

  // An in-use public IPv4 address, per hour.
  for (const item of items.addresses) {
    const usage = item.product?.attributes?.usagetype ?? '';
    const price = onDemandPrice(item, 'Hrs');
    const sku = item.product?.sku;
    if (!/(?:^|-)PublicIPv4:InUseAddress$/.test(usage) || !price || !sku) continue;
    out.push({
      ...base(sku, price.currency),
      resource: 'ip',
      unitPriceMicros: price.micros,
      unit: 'hour',
    });
    break;
  }
  return out;
}

/** Resolves when `promise` does, or rejects with the signal's reason once the caller gives up. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

const unreadable = () =>
  new ComputeError(
    'UNAVAILABLE',
    'The AWS Price List answered a body that is not a price list',
    undefined,
    {
      provider: 'aws',
      reason: 'unparseable',
    },
  );

/** The account's `listPrices`: the regions asked (the account's region when none are), each cached a day. */
export function priceListReader(deps: { pricing: JsonClient; region: string; clock: Clock }) {
  const partition = partitionOf(deps.region).partition;
  const cache = new Map<string, { at: number; prices: Promise<ProviderListPrice[]> }>();

  async function products(
    region: string,
    filters: Record<string, string>,
    signal: AbortSignal,
  ): Promise<PriceListItem[]> {
    const out: PriceListItem[] = [];
    const seen = new Set<string>();
    let token: string | undefined;
    for (let page = 0; ; page++) {
      if (page >= 200)
        throw new ComputeError(
          'PROVIDER_ERROR',
          'AWS Price List pagination did not end',
          undefined,
          {
            provider: 'aws',
            reason: 'pagination-limit',
          },
        );
      const response = await deps.pricing.call<{ PriceList?: unknown; NextToken?: unknown }>(
        'GetProducts',
        {
          ServiceCode: 'AmazonEC2',
          FormatVersion: 'aws_v1',
          MaxResults: 100,
          Filters: Object.entries({ ...filters, regionCode: region }).map(([Field, Value]) => ({
            Type: 'TERM_MATCH',
            Field,
            Value,
          })),
          ...(token ? { NextToken: token } : {}),
        },
        { signal },
      );
      if (!Array.isArray(response.PriceList)) throw unreadable();
      for (const entry of response.PriceList) {
        if (typeof entry !== 'string') throw unreadable();
        try {
          out.push(JSON.parse(entry) as PriceListItem);
        } catch {
          throw unreadable();
        }
      }
      const next =
        typeof response.NextToken === 'string' && response.NextToken !== ''
          ? response.NextToken
          : undefined;
      if (!next) return out;
      if (seen.has(next))
        throw new ComputeError(
          'PROVIDER_ERROR',
          'AWS Price List returned a page token twice',
          undefined,
          {
            provider: 'aws',
            reason: 'pagination-loop',
          },
        );
      seen.add(next);
      token = next;
    }
  }

  async function read(region: string): Promise<ProviderListPrice[]> {
    const signal = AbortSignal.timeout(readMs);
    const instances = await products(
      region,
      {
        productFamily: 'Compute Instance',
        operatingSystem: 'Linux',
        tenancy: 'Shared',
        preInstalledSw: 'NA',
        capacitystatus: 'Used',
        licenseModel: 'No License required',
        marketoption: 'OnDemand',
      },
      signal,
    );
    const storage = await products(region, { productFamily: 'Storage' }, signal);
    const addresses = await products(region, { productFamily: 'IP Address' }, signal);
    return pricesOfRegion(region, { instances, storage, addresses });
  }

  return async function listPrices(
    query: { regions?: readonly string[] },
    context: CallContext,
  ): Promise<ProviderListPrice[]> {
    const regions = [...new Set(query.regions ?? [deps.region])];
    for (const region of regions) {
      let ok = false;
      try {
        ok = partitionOf(assertRegion(region)).partition === partition;
      } catch {
        ok = false;
      }
      if (!ok)
        throw new ComputeError(
          'INVALID_INPUT',
          `${JSON.stringify(String(region).slice(0, 32))} is not an AWS region of this account's partition`,
          undefined,
          { provider: 'aws', reason: 'region' },
        );
    }
    const now = context.clock.now();
    const out: ProviderListPrice[] = [];
    for (const region of regions) {
      let entry = cache.get(region);
      if (!entry || now - entry.at >= priceListTtlMs || now < entry.at) {
        // One read serves every caller until it fails or the TTL passes; no caller's signal cancels it. A failed
        // or empty read is not kept.
        const fresh = { at: now, prices: read(region) };
        const forget = () => {
          if (cache.get(region) === fresh) cache.delete(region);
        };
        fresh.prices.then((prices) => prices.length === 0 && forget(), forget);
        cache.set(region, fresh);
        entry = fresh;
      }
      out.push(...(await raceAbort(entry.prices, context.signal)));
    }
    return out;
  };
}
