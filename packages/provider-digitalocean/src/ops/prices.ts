import type { ProviderListPrice } from '@better-compute/core';
import type { DoClient } from '../client/http.js';
import { catalogSizes } from '../compute/offers.js';
import type { DoSize } from '../compute/types.js';
import { offerId } from '../ids.js';

// List prices (platform compute billing, DigitalOcean P9). DigitalOcean prices a Droplet size as a whole: one hourly
// price covers its vCPUs, memory, disk and GPUs, and is the same in every region that offers the size. So each
// (size, region) is one `instance` price naming its offer; no vCPU, memory or GPU part is derived from it (there is
// no unambiguous split, and a missing price beats a wrong one). Spot prices change daily and volumes and addresses
// are other phases' resources: none of them is listed here.

/** The instance prices of `sizes` in `regions`, skipping any size without a positive, finite hourly price. */
export function pricesOfSizes(
  sizes: readonly DoSize[],
  regions: readonly string[],
): ProviderListPrice[] {
  const wanted = new Set(regions);
  const prices: ProviderListPrice[] = [];
  for (const size of sizes) {
    const hourly = size.price_hourly;
    if (typeof hourly !== 'number' || !Number.isFinite(hourly) || hourly <= 0) continue;
    const unitPriceMicros = Math.round(hourly * 1_000_000);
    if (!Number.isSafeInteger(unitPriceMicros) || unitPriceMicros <= 0) continue;
    for (const region of size.regions ?? []) {
      if (!wanted.has(region)) continue;
      prices.push({
        resource: 'instance',
        region,
        offerId: offerId(region, size.slug),
        spot: false,
        unitPriceMicros,
        unit: 'hour',
        currency: 'USD',
        sku: size.slug,
      });
    }
  }
  return prices;
}

/**
 * `listPrices` of the DigitalOcean provider: the sizes come from the offers catalog (cached ten minutes per client),
 * limited to the account's regions and, when asked, to `query.regions`.
 */
export async function listPrices(
  client: DoClient,
  accountRegions: readonly string[],
  query: { regions?: readonly string[] },
  signal: AbortSignal,
): Promise<ProviderListPrice[]> {
  const regions = query.regions
    ? accountRegions.filter((region) => query.regions!.includes(region))
    : accountRegions;
  if (regions.length === 0) return [];
  return pricesOfSizes(await catalogSizes(client, signal), regions);
}
