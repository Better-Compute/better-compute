import { ComputeError, type Clock } from '@better-compute/core';
import { partitionOf, type JsonClient, type QueryClient } from '@better-compute/aws-core';

// Offer prices (AWS A3, config `pricing`). On-demand: the Price List Query API (`GetProducts`,
// JSON 1.1, served from us-east-1 for the commercial partition), one paged region-wide read of
// Linux / shared tenancy / no pre-installed software / used capacity, cached a day. Spot:
// `DescribeSpotPriceHistory` from now, which gives the price in effect per zone and type, cached
// 10 minutes. A failed read leaves prices unset (it never fails listOffers) and is retried after
// 10 minutes. GovCloud (aws-us-gov) has no Price List API: on-demand prices are never read there.

export type PricingMode = 'off' | 'on-demand' | 'all';

export interface Price {
  pricePerHour: number;
  currency: string;
}

const onDemandTtlMs = 86_400_000;
const spotTtlMs = 10 * 60_000;
const failureTtlMs = 10 * 60_000;
/** The Price List paging guard: a region has well under this many Linux shared products. */
const maxPages = 200;

/** One Price List product (a JSON document inside `PriceList`) → its type and hourly price. */
export function parsePriceListProduct(
  text: string,
): { instanceType: string; price: Price } | undefined {
  let doc: {
    product?: { attributes?: Record<string, unknown> };
    terms?: { OnDemand?: Record<string, { priceDimensions?: Record<string, unknown> }> };
  };
  try {
    doc = JSON.parse(text) as typeof doc;
  } catch {
    return undefined;
  }
  const attributes = doc.product?.attributes ?? {};
  const instanceType = attributes.instanceType;
  if (typeof instanceType !== 'string' || !/^[a-z][a-z0-9-]*\.[a-z0-9-]+$/.test(instanceType))
    return undefined;
  // Capacity Block and other market options are priced elsewhere.
  if (attributes.marketoption !== undefined && attributes.marketoption !== 'OnDemand')
    return undefined;
  for (const term of Object.values(doc.terms?.OnDemand ?? {}))
    for (const dimension of Object.values(term.priceDimensions ?? {})) {
      const { unit, pricePerUnit } = (dimension ?? {}) as {
        unit?: unknown;
        pricePerUnit?: Record<string, unknown>;
      };
      if (unit !== 'Hrs' || !pricePerUnit) continue;
      for (const currency of ['USD', 'CNY']) {
        const value = Number(pricePerUnit[currency]);
        if (typeof pricePerUnit[currency] === 'string' && Number.isFinite(value) && value > 0)
          return { instanceType, price: { pricePerHour: value, currency } };
      }
    }
  return undefined;
}

export interface PriceReader {
  /** On-demand prices by instance type; empty when the read failed. */
  onDemand(signal: AbortSignal): Promise<ReadonlyMap<string, Price>>;
  /** Spot prices by `<zone>/<type>`; empty when the read failed. */
  spot(signal: AbortSignal): Promise<ReadonlyMap<string, Price>>;
}

export function priceReader(options: {
  mode: PricingMode;
  region: string;
  zones: readonly string[];
  clock: Clock;
  pricing?: JsonClient;
  ec2: QueryClient;
  /** Runs before every EC2 call (the account's identity checks). */
  ready(signal: AbortSignal): Promise<void>;
  onError(topic: string, error: unknown): void;
}): PriceReader {
  type Cached = { prices: ReadonlyMap<string, Price>; until: number };
  let onDemand: Cached | undefined;
  let spot: Cached | undefined;
  const empty: ReadonlyMap<string, Price> = new Map();
  /** Whether the partition has the Price List API (GovCloud does not). */
  const priceList = partitionOf(options.region).partition !== 'aws-us-gov';

  const readOnDemand = async (signal: AbortSignal) => {
    const prices = new Map<string, Price>();
    const filters = [
      ['regionCode', options.region],
      ['operatingSystem', 'Linux'],
      ['tenancy', 'Shared'],
      ['preInstalledSw', 'NA'],
      ['capacitystatus', 'Used'],
    ].map(([Field, Value]) => ({ Type: 'TERM_MATCH', Field, Value }));
    let token: string | undefined;
    const seen = new Set<string>();
    let pages = 0;
    do {
      const response = await options.pricing!.call<{ PriceList?: unknown; NextToken?: unknown }>(
        'GetProducts',
        {
          ServiceCode: 'AmazonEC2',
          Filters: filters,
          FormatVersion: 'aws_v1',
          MaxResults: 100,
          ...(token ? { NextToken: token } : {}),
        },
        { signal },
      );
      const list = Array.isArray(response.PriceList) ? response.PriceList : [];
      for (const entry of list) {
        if (typeof entry !== 'string') continue;
        const parsed = parsePriceListProduct(entry);
        if (!parsed) continue;
        const known = prices.get(parsed.instanceType);
        // Several products for one type (rare): the lowest hourly price is the on-demand one.
        if (!known || parsed.price.pricePerHour < known.pricePerHour)
          prices.set(parsed.instanceType, parsed.price);
      }
      token =
        typeof response.NextToken === 'string' && response.NextToken
          ? response.NextToken
          : undefined;
      if (token && (seen.has(token) || ++pages >= maxPages))
        throw new ComputeError(
          'PROVIDER_ERROR',
          'the AWS Price List did not stop paging',
          undefined,
          {
            provider: 'aws',
            reason: 'pagination-loop',
          },
        );
      if (token) seen.add(token);
    } while (token);
    return prices;
  };

  const readSpot = async (signal: AbortSignal) => {
    await options.ready(signal);
    const prices = new Map<string, Price>();
    const latest = new Map<string, number>();
    let token: string | undefined;
    const seen = new Set<string>();
    const startTime = new Date(options.clock.now()).toISOString();
    const currency = options.region.startsWith('cn-') ? 'CNY' : 'USD';
    do {
      const doc = await options.ec2.call(
        'DescribeSpotPriceHistory',
        {
          ProductDescription: ['Linux/UNIX'],
          StartTime: startTime,
          Filter: [{ Name: 'availability-zone', Value: [...options.zones] }],
          MaxResults: 1000,
          NextToken: token,
        },
        { signal },
      );
      for (const item of doc.items('spotPriceHistorySet')) {
        const zone = item.textOf('availabilityZone');
        const type = item.textOf('instanceType');
        const value = Number(item.textOf('spotPrice'));
        const at = Date.parse(item.textOf('timestamp') ?? '');
        if (!zone || !type || !Number.isFinite(value) || value <= 0) continue;
        const key = `${zone}/${type}`;
        const when = Number.isFinite(at) ? at : 0;
        if ((latest.get(key) ?? -Infinity) > when) continue;
        latest.set(key, when);
        prices.set(key, { pricePerHour: value, currency });
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
    return prices;
  };

  const cached = async (
    current: Cached | undefined,
    set: (value: Cached) => void,
    read: (signal: AbortSignal) => Promise<ReadonlyMap<string, Price>>,
    ttlMs: number,
    topic: string,
    signal: AbortSignal,
  ) => {
    const now = options.clock.now();
    if (current && now < current.until) return current.prices;
    try {
      const prices = await read(signal);
      set({ prices, until: now + ttlMs });
      return prices;
    } catch (error) {
      if (signal.aborted) throw error;
      options.onError(topic, error);
      set({ prices: empty, until: now + failureTtlMs });
      return empty;
    }
  };

  return {
    async onDemand(signal) {
      if (options.mode === 'off' || !options.pricing || !priceList) return empty;
      return cached(
        onDemand,
        (v) => (onDemand = v),
        readOnDemand,
        onDemandTtlMs,
        'on-demand prices',
        signal,
      );
    },
    async spot(signal) {
      if (options.mode !== 'all') return empty;
      return cached(spot, (v) => (spot = v), readSpot, spotTtlMs, 'spot prices', signal);
    },
  };
}
