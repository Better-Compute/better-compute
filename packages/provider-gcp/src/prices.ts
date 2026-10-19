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

interface CatalogSku {
  skuId?: string;
  description?: string;
  category?: { resourceGroup?: string; usageType?: string };
  serviceRegions?: string[];
  pricingInfo?: {
    pricingExpression?: {
      usageUnit?: string;
      tieredRates?: {
        unitPrice?: { currencyCode?: string; units?: string | number; nanos?: number };
      }[];
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

/** `Spot Preemptible N2 Instance Core running in Americas` → `n2`: the first token, after the spot prefix. */
function familyOf(description: string): string | undefined {
  const rest = description.replace(/^(?:spot preemptible|preemptible|spot)\s+/i, '');
  const first = /^([A-Za-z][A-Za-z0-9-]*)\s/.exec(rest)?.[1];
  return first?.toLowerCase();
}

/** The catalog's `{ units, nanos }` as micros of the currency. */
function microsOf(price: { units?: string | number; nanos?: number }): number | undefined {
  const units = Number(price.units ?? 0);
  const nanos = Number(price.nanos ?? 0);
  const micros = Math.round(units * 1_000_000 + nanos / 1000);
  return Number.isSafeInteger(micros) && micros >= 0 ? micros : undefined;
}

const diskGroup = /^(ssd|pdstandard|localssd|pdbalanced|hyperdisk\w*)$/i;
const diskExcluded =
  /\b(regional|iops|throughput|snapshot|image|archive|replication|storage pool)\b/i;

function diskTypeOf(group: string, description: string): string | undefined {
  if (!diskGroup.test(group) || diskExcluded.test(description)) return undefined;
  if (/local ssd|ssd backed local/i.test(description)) return 'local-ssd';
  if (/hyperdisk balanced/i.test(description)) return 'hyperdisk-balanced';
  if (/hyperdisk/i.test(description)) return undefined;
  if (/balanced/i.test(description)) return 'pd-balanced';
  if (/^pdstandard$/i.test(group)) return 'pd-standard';
  if (/^ssd$/i.test(group)) return 'pd-ssd';
  return undefined;
}

/** Maps one SKU to its prices, one per region; none when the SKU is not one this mapping prices. */
export function pricesOfSku(sku: CatalogSku): ProviderListPrice[] {
  const usage = sku.category?.usageType;
  if (usage !== 'OnDemand' && usage !== 'Preemptible') return [];
  const spot = usage === 'Preemptible';
  const group = sku.category?.resourceGroup ?? '';
  const description = sku.description ?? '';
  const expression = sku.pricingInfo?.[0]?.pricingExpression;
  const rate = expression?.tieredRates?.[0]?.unitPrice;
  const unitOfUsage = expression?.usageUnit;
  if (!sku.skuId || !rate || !unitOfUsage) return [];
  const raw = microsOf(rate);
  if (raw === undefined) return [];
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
  } else if (group === 'GPU' && unitOfUsage === 'h' && !unpriceable.test(description)) {
    // Only models the meter catalog names: a T4 would be priced as `other` and proposed for every unknown GPU.
    const gpuModel = canonicalGpuModel(description.replace(/\s+running in .*$/i, ''));
    if (gpuModel !== 'other')
      price = { ...base, resource: 'gpu', gpuModel, unitPriceMicros: raw, unit: 'hour' };
  } else if (/^ipaddress$/i.test(group)) {
    if (unitOfUsage === 'h' && /external ip/i.test(description))
      price = { ...base, resource: 'ip', unitPriceMicros: raw, unit: 'hour' };
  } else if (/^premiuminternetegress$/i.test(group)) {
    if (unitOfUsage === 'GiBy')
      price = { ...base, resource: 'egress', unitPriceMicros: raw, unit: 'gib' };
  } else {
    const diskType = diskTypeOf(group, description);
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
      for (const sku of payload?.skus ?? []) prices.push(...pricesOfSku(sku));
      pageToken = payload?.nextPageToken || undefined;
    } while (pageToken);
    return prices;
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
        entry.prices.catch(() => {
          if (cached === entry) cached = undefined;
        });
        cached = entry;
      }
      const all = await raceAbort(cached.prices, context.signal);
      const regions = query.regions ? new Set(query.regions) : undefined;
      return regions ? all.filter((price) => regions.has(price.region)) : [...all];
    },
  };
}
