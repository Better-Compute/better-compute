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
import { GcpCompute, parseDiscoverLabel } from './compute.js';
import { gcpConfig, type GcpConfig, type GcpProviderOptions } from './config.js';

const defaultEndpoint = 'https://compute.googleapis.com/compute/v1';

/**
 * The token source for one account: the service-account key behind `credentials` when the account
 * names one (the host's `tokenSource` never overrides it), else the host's ambient identity
 * (`options.tokenSource`, else the metadata server); optionally impersonating another account.
 *
 * Ambient credentials are the control plane's own identity, so only a platform (root-tenant)
 * account may use them (ruling F1): a tenant's account brings its own key, or a tenant naming the
 * platform's project would act there as the platform. `impersonate` without `credentials` would
 * impersonate through that same identity, so it is refused too. The key is resolved on the first
 * request, not when the client is built.
 */
function accountTokens(
  config: GcpConfig,
  context: ProviderContext,
  options: GcpProviderOptions,
): TokenSource {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  if (!config.credentials && context.account?.platform !== true)
    throw new ComputeError(
      'INVALID_CONFIG',
      `GCP account ${context.account?.id ?? '(unknown)'} is not the platform's: it must name its own ` +
        `service-account key in credentials${config.impersonate ? ' to impersonate with' : ''}; ` +
        'ambient credentials (the metadata server, the host token source) are the platform identity',
      undefined,
      { provider: 'gcp', reason: 'ambientCredentials' },
    );
  let base: TokenSource | undefined;
  const resolveBase = async (): Promise<TokenSource> => {
    if (base) return base;
    if (config.credentials) {
      const key = await context.secrets.resolve(config.credentials);
      base = serviceAccountTokenSource(key, { fetch: fetchImpl });
    } else if (options.tokenSource) base = cachedTokenSource(options.tokenSource);
    else base = metadataTokenSource({ fetch: fetchImpl });
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
 * to supply the host's own credentials (workload identity) to platform accounts that name no key.
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
      parseDiscoverLabel(config.discoverLabel);
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
