import type { Offer, OfferQuery } from '@better-compute/core';
import type { DoClient } from '../client/http.js';
import type { DoConfig } from '../config.js';
import { offerId } from '../ids.js';
import type { DoRegion, DoSize } from './types.js';

// Offers: one per (size, region) the account is configured for. The size and region lists change
// rarely, so each client keeps them for ten minutes; a query is then answered without a request.

const catalogTtlMs = 10 * 60_000;
/** A load that no caller waits for any more still ends. */
const loadTimeoutMs = 60_000;

interface Catalog {
  sizes: DoSize[];
  regions: Map<string, DoRegion>;
}

interface CacheEntry {
  loadedAt: number;
  catalog: Promise<Catalog>;
  /** The catalog once it has loaded. */
  loaded?: Catalog;
}

/** Per client, so a test (or a second account) never sees another's catalog. */
const caches = new WeakMap<DoClient, CacheEntry>();

async function loadCatalog(client: DoClient, signal: AbortSignal): Promise<Catalog> {
  const sizes: DoSize[] = [];
  for await (const size of client.pages<DoSize>('/sizes', 'sizes', { signal, budget: 'sweep' }))
    sizes.push(size);
  const regions = new Map<string, DoRegion>();
  for await (const region of client.pages<DoRegion>('/regions', 'regions', {
    signal,
    budget: 'sweep',
  }))
    regions.set(region.slug, region);
  return { sizes, regions };
}

/** Rejects with the signal's reason as soon as it aborts, leaving the promise itself running. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * Concurrent callers share one load, which runs on its own signal: one caller's abort cancels only
 * that caller's wait. A failed load is dropped so the next call retries.
 */
function catalogOf(client: DoClient, signal: AbortSignal): Promise<Catalog> {
  const now = client.clock.now();
  const cached = caches.get(client);
  if (cached && now - cached.loadedAt < catalogTtlMs) return untilAborted(cached.catalog, signal);
  const entry: CacheEntry = {
    loadedAt: now,
    catalog: loadCatalog(client, AbortSignal.timeout(loadTimeoutMs)),
  };
  caches.set(client, entry);
  entry.catalog.then(
    (catalog) => {
      entry.loaded = catalog;
    },
    () => {
      if (caches.get(client) === entry) caches.delete(client);
    },
  );
  return untilAborted(entry.catalog, signal);
}

/**
 * The size `slug` from a catalog this client has already loaded, without a request or a wait:
 * undefined when it holds no fresh loaded catalog or the size isn't in it.
 */
export function cachedSize(client: DoClient, slug: string): DoSize | undefined {
  const cached = caches.get(client);
  if (!cached?.loaded || client.clock.now() - cached.loadedAt >= catalogTtlMs) return undefined;
  return cached.loaded.sizes.find((size) => size.slug === slug);
}

/**
 * The inventory's name for a size's GPU: a leading `nvidia_` or `amd_` is dropped, the rest is
 * upper-cased with `_` as `-` (`nvidia_h100` is `H100`, `nvidia_rtx_6000_ada` is `RTX-6000-ADA`).
 */
export function gpuModelOf(size: Pick<DoSize, 'gpu_info'>): string | undefined {
  const model = size.gpu_info?.model;
  if (!model) return undefined;
  return model
    .replace(/^(nvidia|amd)_/, '')
    .toUpperCase()
    .replaceAll('_', '-');
}

export async function listOffers(
  client: DoClient,
  config: DoConfig,
  query: OfferQuery,
  signal: AbortSignal,
): Promise<Offer[]> {
  if (query.kind === 'metal') return [];
  const catalog = await catalogOf(client, signal);
  const wanted = query.gpuModel?.toUpperCase();
  const offers: Offer[] = [];
  for (const size of catalog.sizes) {
    const model = gpuModelOf(size);
    const gpuCount = size.gpu_info?.count ?? 0;
    const memoryGiB = size.memory / 1024;
    if (wanted !== undefined && model?.toUpperCase() !== wanted) continue;
    if (query.minGpus !== undefined && gpuCount < query.minGpus) continue;
    if (query.minVcpu !== undefined && size.vcpus < query.minVcpu) continue;
    if (query.minMemoryGiB !== undefined && memoryGiB < query.minMemoryGiB) continue;
    for (const slug of size.regions) {
      if (!config.regions.includes(slug)) continue;
      if (query.region !== undefined && query.region !== slug) continue;
      const region = catalog.regions.get(slug);
      offers.push({
        id: offerId(slug, size.slug),
        kind: 'vps',
        region: slug,
        vcpu: size.vcpus,
        memoryGiB,
        diskGiB: size.disk,
        ...(model !== undefined ? { gpus: { model, count: gpuCount } } : {}),
        pricePerHour: size.price_hourly,
        currency: 'USD',
        available: size.available && !!region?.available && region.sizes.includes(size.slug),
      });
    }
  }
  return offers;
}
