import { ComputeError, type ProviderContext } from '@better-compute/core';
import { defineProvider, type ProviderDefinition } from '@better-compute/vps';
import {
  cachedTokenSource,
  impersonatedTokenSource,
  metadataTokenSource,
  serviceAccountTokenSource,
  type TokenSource,
} from './auth.js';
import { gceClient } from './client.js';
import { GcpCompute } from './compute.js';
import { gcpConfig, type GcpConfig, type GcpProviderOptions } from './config.js';

const defaultEndpoint = 'https://compute.googleapis.com/compute/v1';

/**
 * The token source for one account: the host's own (`options.tokenSource`), else the service-account
 * key behind `credentials`, else the metadata server; optionally impersonating another account. The
 * key is resolved on the first request, not when the client is built.
 */
function accountTokens(
  config: GcpConfig,
  context: ProviderContext,
  options: GcpProviderOptions,
): TokenSource {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  let base: TokenSource | undefined = options.tokenSource
    ? cachedTokenSource(options.tokenSource)
    : undefined;
  const resolveBase = async (): Promise<TokenSource> => {
    if (base) return base;
    if (config.credentials) {
      const key = await context.secrets.resolve(config.credentials);
      base = serviceAccountTokenSource(key, { fetch: fetchImpl });
    } else base = metadataTokenSource({ fetch: fetchImpl });
    return base;
  };
  const lazyBase: TokenSource = {
    token: async (call) => (await resolveBase()).token(call),
  };
  if (!config.impersonate) return lazyBase;
  return impersonatedTokenSource(lazyBase, config.impersonate, { fetch: fetchImpl });
}

/**
 * A Google Compute Engine provider definition. Pass `fetch` to emulate the API, and `tokenSource`
 * to supply tokens from the host's own credentials (workload identity) instead of a key.
 */
export function gcpProvider(options: GcpProviderOptions = {}): ProviderDefinition<GcpConfig> {
  return defineProvider<GcpConfig>({
    id: 'gcp',
    version: '0.1.0',
    provides: ['vps'],
    config: gcpConfig as unknown as ProviderDefinition<GcpConfig>['config'],
    capabilities: ['power', 'list', 'discover', 'claim', 'reservations', 'networks'],
    create: (config, context) => {
      if (config.zones.length === 0)
        throw new ComputeError('INVALID_CONFIG', 'A GCP account lists at least one zone');
      const client = gceClient({
        fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
        endpoint: options.endpoint ?? defaultEndpoint,
        projectId: config.projectId,
        tokens: accountTokens(config, context, options),
        clock: context.clock,
        log: context.log,
      });
      return new GcpCompute(config, context, options, client);
    },
  });
}

/** The Google Compute Engine provider (`vps({ providers: [gcp] })`). */
export const gcp: ProviderDefinition<GcpConfig> = gcpProvider();
