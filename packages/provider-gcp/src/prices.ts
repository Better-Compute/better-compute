import {
  ComputeError,
  canonicalGpuModel,
  type CallContext,
  type Clock,
  type Logger,
  type ProviderListPrice,
} from '@better-compute/core';
import type { TokenSource } from './auth.js';
import { mapGceError } from './client.js';

// Provider list prices from the Cloud Billing Catalog (platform compute billing, D14): the Compute Engine
// service's SKUs, read once per account per 24 hours and mapped onto ProviderListPrice. Commitment SKUs are
// skipped, so are the ones this mapping cannot price (an unknown GPU, a unit other than the one a resource is
// priced in). The catalog is public data; it is read with the account's own token only because the API wants
// an authenticated caller.

/** Compute Engine's service id in the Cloud Billing Catalog. */
export const computeEngineServiceId = '6F81-5844-456A';

/** How long the SKU list is kept (the catalog changes rarely). */
export const catalogTtlMs = 24 * 3_600_000;

/** Google bills a month as 730 hours: monthly storage prices become GiB-hours with it. */
const hoursPerMonth = 730;
const catalogReadMs = 50_000;

type Price = { currencyCode?: string; units?: string | number; nanos?: number };

interface CatalogSku {
  skuId?: string;
  description?: string;
  category?: { resourceGroup?: string; usageType?: string };
  serviceRegions?: string[];
  pricingInfo?: {
    pricingExpression?: {
      usageUnit?: string;
      tieredRates?: { startUsageAmount?: number | string; unitPrice?: Price }[];
    };
  }[];
}

export interface CatalogOptions {
  fetch: typeof fetch;
  /** `https://cloudbilling.googleapis.com` (the universe's Cloud Billing host). */
  endpoint: string;
  tokens: TokenSource;
  /** Business time for token expiry. */
  clock: Clock;
  log?: Logger;
}

/** SKU descriptions this mapping never prices: custom shapes, sole tenancy, licences and the like. */
const unpriceable =
  /\b(custom|extended|sole tenancy|sole tenant|commitment|licen[cs]e|licensing|confidential|windows|sql server|rhel|suse|premium image)\b/i;

/**
 * `Spot Preemptible N2 Instance Core running in Americas` → `n2`: the first token, after the spot prefix, and only
 * when it looks like a machine family (a letter, a digit, then more: `n2`, `c3d`, `a3`). `Compute optimized Core`,
 * `Memory-optimized Instance Core` or `Micro Instance Core` name no family and map to nothing.
 */
function familyOf(description: string): string | undefined {
  const rest = description.replace(/^(?:spot preemptible|preemptible|spot)\s+/i, '');
  const first = /^([A-Za-z][A-Za-z0-9-]*)\s/.exec(rest)?.[1]?.toLowerCase();
  return first !== undefined && /^[a-z]\d[a-z0-9-]*$/.test(first) ? first : undefined;
}

/** GPU variants that are not the plain model (`H100 Mega` is not an H100; a virtual workstation is not a compute GPU). */
const gpuVariant = /\b(mega|edge|workstation|vws|grid)\b/i;

/**
 * The tier a price starts at: the one starting at 0 after sorting by `startUsageAmount` (the catalog does not promise
 * an order). A price with no tier at 0 has no list price to read.
 */
function firstTier(
  rates: readonly { startUsageAmount?: number | string; unitPrice?: Price }[] | undefined,
): Price | undefined {
  const sorted = [...(rates ?? [])].sort(
    (a, b) => Number(a.startUsageAmount ?? 0) - Number(b.startUsageAmount ?? 0),
  );
  const first = sorted[0];
  return first && Number(first.startUsageAmount ?? 0) === 0 ? first.unitPrice : undefined;
}

/** The catalog's `{ units, nanos }` as micros of the currency. */
function microsOf(price: { units?: string | number; nanos?: number }): number | undefined {
  const units = Number(price.units ?? 0);
  const nanos = Number(price.nanos ?? 0);
  const micros = Math.round(units * 1_000_000 + nanos / 1000);
  return Number.isSafeInteger(micros) && micros >= 0 ? micros : undefined;
}

/**
 * Capacity SKUs by what their description starts with, never by the resource group alone (`Extreme PD Capacity` shares
 * the `SSD` group with `SSD backed PD Capacity` and must not become `pd-ssd`). Regional, IOPS, throughput,
 * snapshot and every other disk SKU match none and are skipped.
 */
const diskCapacity: readonly (readonly [RegExp, string])[] = [
  [/^SSD backed PD Capacity\b/i, 'pd-ssd'],
  [/^Storage PD Capacity\b/i, 'pd-standard'],
  [/^Balanced PD Capacity\b/i, 'pd-balanced'],
  [/^Extreme PD Capacity\b/i, 'pd-extreme'],
  [/^Hyperdisk Balanced Capacity\b/i, 'hyperdisk-balanced'],
  [/^Hyperdisk Extreme Capacity\b/i, 'hyperdisk-extreme'],
  [/^SSD backed Local Storage\b/i, 'local-ssd'],
];

function diskTypeOf(description: string): string | undefined {
  return diskCapacity.find(([pattern]) => pattern.test(description))?.[1];
}

/** Maps one SKU to its prices, one per region; none when the SKU is not one this mapping prices. */
export function pricesOfSku(sku: CatalogSku): ProviderListPrice[] {
  const usage = sku.category?.usageType;
  if (usage !== 'OnDemand' && usage !== 'Preemptible') return [];
  const spot = usage === 'Preemptible';
  const group = sku.category?.resourceGroup ?? '';
  const description = sku.description ?? '';
  const expression = sku.pricingInfo?.[0]?.pricingExpression;
  const rate = firstTier(expression?.tieredRates);
  const unitOfUsage = expression?.usageUnit;
  if (!sku.skuId || !rate || !unitOfUsage) return [];
  const raw = microsOf(rate);
  // A free first tier is no list price to propose from.
  if (raw === undefined || raw === 0) return [];
  const currency = rate.currencyCode ?? 'USD';

  const base = { spot, currency, sku: sku.skuId };
  let price: Omit<ProviderListPrice, 'region'> | undefined;
  if ((group === 'CPU' || group === 'RAM') && !unpriceable.test(description)) {
    const machineFamily = familyOf(description);
    if (!machineFamily) return [];
    if (group === 'CPU' && unitOfUsage === 'h')
      price = { ...base, resource: 'vcpu', machineFamily, unitPriceMicros: raw, unit: 'hour' };
    else if (group === 'RAM' && unitOfUsage === 'GiBy.h')
      price = {
        ...base,
        resource: 'memory',
        machineFamily,
        unitPriceMicros: raw,
        unit: 'gib-hour',
      };
  } else if (
    group === 'GPU' &&
    unitOfUsage === 'h' &&
    !unpriceable.test(description) &&
    !gpuVariant.test(description)
  ) {
    // Only models the meter catalog names: a T4 would be priced as `other` and proposed for every unknown GPU.
    const gpuModel = canonicalGpuModel(description.replace(/\s+running in .*$/i, ''));
    if (gpuModel !== 'other')
      price = { ...base, resource: 'gpu', gpuModel, unitPriceMicros: raw, unit: 'hour' };
  } else if (/^ipaddress$/i.test(group)) {
    if (unitOfUsage === 'h' && /external ip/i.test(description))
      price = { ...base, resource: 'ip', unitPriceMicros: raw, unit: 'hour' };
  } else {
    const diskType = diskTypeOf(description);
    if (diskType) {
      if (unitOfUsage === 'GiBy.mo')
        price = {
          ...base,
          resource: 'disk',
          diskType,
          unitPriceMicros: Math.round(raw / hoursPerMonth),
          unit: 'gib-hour',
        };
      else if (unitOfUsage === 'GiBy.h')
        price = { ...base, resource: 'disk', diskType, unitPriceMicros: raw, unit: 'gib-hour' };
    }
  }
  if (!price) return [];
  const regions = sku.serviceRegions?.length ? sku.serviceRegions : ['global'];
  return regions.map((region) => ({ region, ...price! }));
}

/**
 * Only rows with one answer: SKUs that map to the same (resource, family, GPU model or disk type, region, spot,
 * currency) and disagree on the price are dropped altogether (the catalog has variants this mapping cannot tell
 * apart), and agreeing duplicates collapse to the first SKU id. Fail closed: a missing price beats a wrong one.
 */
export function unambiguous(prices: readonly ProviderListPrice[]): ProviderListPrice[] {
  const keyOf = (price: ProviderListPrice) =>
    [
      price.resource,
      price.machineFamily ?? price.gpuModel ?? price.diskType ?? '',
      price.region,
      price.spot,
      price.currency,
    ].join('|');
  const groups = new Map<string, ProviderListPrice[]>();
  for (const price of prices) {
    const group = groups.get(keyOf(price));
    if (group) group.push(price);
    else groups.set(keyOf(price), [price]);
  }
  const kept = new Set<ProviderListPrice>();
  for (const group of groups.values())
    if (group.every((price) => price.unitPriceMicros === group[0]!.unitPriceMicros))
      kept.add([...group].sort((a, b) => a.sku.localeCompare(b.sku))[0]!);
  // The rows that remain keep the catalog's own order.
  return prices.filter((price) => kept.has(price));
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

/** The account's catalog reader: `listPrices` of the GCP provider. */
export function catalogReader(options: CatalogOptions) {
  const endpoint = options.endpoint.replace(/\/+$/, '');
  let cached: { at: number; prices: Promise<ProviderListPrice[]> } | undefined;

  async function read(): Promise<ProviderListPrice[]> {
    const signal = AbortSignal.timeout(catalogReadMs);
    const prices: ProviderListPrice[] = [];
    let pageToken: string | undefined;
    do {
      const token = await options.tokens.token({ signal, clock: options.clock });
      const url = new URL(`${endpoint}/v1/services/${computeEngineServiceId}/skus`);
      url.searchParams.set('pageSize', '5000');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      let response: Response;
      try {
        response = await options.fetch(url.toString(), {
          method: 'GET',
          headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
          signal,
        });
      } catch {
        options.log?.warn('gcp.catalog_unreachable', {});
        throw new ComputeError('UNAVAILABLE', 'Cloud Billing Catalog unreachable', undefined, {
          provider: 'gcp',
          status: 0,
          reason: 'network',
        });
      }
      const text = await response.text();
      let payload: { skus?: CatalogSku[]; nextPageToken?: string } | undefined;
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        payload = undefined;
      }
      if (!response.ok)
        throw mapGceError(
          response.status,
          payload,
          response.headers,
          'GET Cloud Billing Catalog skus',
        );
      // A 200 that is not a SKU list (a proxy page, a truncated body) is an outage, not an empty catalog.
      if (
        typeof payload !== 'object' ||
        payload === null ||
        Array.isArray(payload) ||
        (payload.skus !== undefined && !Array.isArray(payload.skus))
      ) {
        options.log?.warn('gcp.catalog_unreadable', {});
        throw new ComputeError(
          'UNAVAILABLE',
          'Cloud Billing Catalog answered a body that is not a SKU list',
          undefined,
          { provider: 'gcp', status: response.status, reason: 'unparseable' },
        );
      }
      for (const sku of payload.skus ?? []) prices.push(...pricesOfSku(sku));
      pageToken = payload?.nextPageToken || undefined;
    } while (pageToken);
    return unambiguous(prices);
  }

  return {
    async listPrices(
      query: { regions?: readonly string[] },
      context: CallContext,
    ): Promise<ProviderListPrice[]> {
      const now = context.clock.now();
      if (!cached || now - cached.at >= catalogTtlMs || now < cached.at) {
        // One read serves every caller until it fails or the TTL passes; no caller's signal cancels it.
        const entry = { at: now, prices: read() };
        // A failed read, and an empty one (a catalog that lists nothing is not trusted for a day), are not kept.
        const forget = () => {
          if (cached === entry) cached = undefined;
        };
        entry.prices.then((prices) => prices.length === 0 && forget(), forget);
        cached = entry;
      }
      const all = await raceAbort(cached.prices, context.signal);
      const regions = query.regions ? new Set(query.regions) : undefined;
      return regions ? all.filter((price) => regions.has(price.region)) : [...all];
    },
  };
}
