import {
  type Offer,
  type OfferQuery,
  type ProviderContext,
} from '@better-compute/core';
import type { QueryClient } from '@better-compute/aws-core';
import type { AccountCredentials } from './account.js';
import type { AwsConfig, AwsProviderOptions } from './config.js';
import { offerId } from './ids.js';
import type { InstanceTypeCache, ZoneCache } from './shapes.js';

export interface AwsComputeDeps {
  ec2: QueryClient;
  account: AccountCredentials;
  types: InstanceTypeCache;
  zones: ZoneCache;
}

const offeringsTtlMs = 3_600_000;

/** One AWS account's EC2 client (`ProviderImpl`). */
export class AwsCompute {
  #offerings: { pairs: [string, string][]; at: number } | undefined;

  constructor(
    readonly config: AwsConfig,
    readonly context: ProviderContext,
    readonly options: AwsProviderOptions,
    readonly deps: AwsComputeDeps,
  ) {}

  /** A signal for calls that the contract gives none (listOffers). */
  #signal(): AbortSignal {
    return AbortSignal.timeout(60_000);
  }

  /** Every EC2 call runs after the account's identity checks (memoized). */
  protected async ready(signal: AbortSignal): Promise<void> {
    await this.deps.account.verify({ signal, clock: this.context.clock });
  }

  async #offeringPairs(signal: AbortSignal): Promise<[string, string][]> {
    const now = this.context.clock.now();
    if (this.#offerings && now - this.#offerings.at < offeringsTtlMs) return this.#offerings.pairs;
    const pairs: [string, string][] = [];
    const seen = new Set<string>();
    let token: string | undefined;
    do {
      const doc = await this.deps.ec2.call(
        'DescribeInstanceTypeOfferings',
        {
          LocationType: 'availability-zone',
          Filter: [{ Name: 'location', Value: this.config.zones }],
          MaxResults: 1000,
          NextToken: token,
        },
        { signal },
      );
      for (const item of doc.items('instanceTypeOfferingSet')) {
        const zone = item.textOf('location');
        const type = item.textOf('instanceType');
        if (zone && type && this.config.zones.includes(zone)) pairs.push([zone, type]);
      }
      token = doc.textOf('nextToken') || undefined;
      if (token && seen.has(token)) break;
      if (token) seen.add(token);
    } while (token);
    pairs.sort(([az, at], [bz, bt]) => (az === bz ? (at < bt ? -1 : at > bt ? 1 : 0) : az < bz ? -1 : 1));
    this.#offerings = { pairs, at: now };
    return pairs;
  }

  async listOffers(query: OfferQuery): Promise<Offer[]> {
    if (query.region !== undefined && query.region !== this.config.region) return [];
    if (query.kind === 'metal') return [];
    const signal = this.#signal();
    await this.ready(signal);
    const pairs = await this.#offeringPairs(signal);
    const types = await this.deps.types.get([...new Set(pairs.map(([, type]) => type))], signal);
    const offers: Offer[] = [];
    for (const [zone, type] of pairs) {
      const info = types.get(type);
      if (!info || info.bareMetal) continue;
      if (query.gpuModel !== undefined && info.gpus?.model !== query.gpuModel) continue;
      if (query.minGpus !== undefined && (info.gpus?.count ?? 0) < query.minGpus) continue;
      if (query.minVcpu !== undefined && info.vcpu < query.minVcpu) continue;
      if (query.minMemoryGiB !== undefined && info.memoryGiB < query.minMemoryGiB) continue;
      offers.push({
        id: offerId({ zone, instanceType: type, market: 'on-demand' }),
        kind: 'vps',
        region: this.config.region,
        vcpu: info.vcpu,
        memoryGiB: info.memoryGiB,
        diskGiB: this.config.rootVolumeGiB,
        ...(info.gpus ? { gpus: { ...info.gpus } } : {}),
        available: true,
      });
    }
    return offers;
  }
}
