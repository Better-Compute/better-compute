import type { ProviderContext } from '@better-compute/core';
import type { DoConfig, DoProviderOptions } from '../config.js';
import { budgetFor } from './budget.js';
import { doClient, type DoClient } from './http.js';

export const defaultEndpoint = 'https://api.digitalocean.com/v2';

/**
 * The client an account's provider and its probe share: no request is made and the token is not
 * resolved until the first call, and the request budget it spends from is the token's own, shared
 * with every other client of that token.
 */
export function clientFor(
  config: DoConfig,
  context: ProviderContext,
  options: DoProviderOptions,
): DoClient {
  return doClient({
    fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
    endpoint: options.endpoint ?? defaultEndpoint,
    token: () => context.secrets.resolve(config.token),
    budget: (hash) =>
      budgetFor(hash, {
        perMinute: options.budget?.perMinute ?? 250,
        perHour: options.budget?.perHour ?? 5000,
        clock: context.clock,
      }),
    clock: context.clock,
    log: context.log,
  });
}
