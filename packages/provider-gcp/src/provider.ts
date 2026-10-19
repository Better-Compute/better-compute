import { ComputeError, type ProviderContext } from '@better-compute/core';
import {
  cachedTokenSource,
  federatedTokenSource,
  googleEndpoint,
  impersonatedTokenSource,
  metadataTokenSource,
  serviceAccountTokenSource,
  type TokenSource,
} from '@better-compute/gcp-common';
import { defineProvider, type ProviderDefinition } from '@better-compute/vps';
import { gceClient } from './client.js';
import { GcpCompute, parseDiscoverLabel } from './compute.js';
import { gcpConfig, type GcpConfig, type GcpProviderOptions } from './config.js';
import { checkGcpAccount, federationOf, subjectTokenAudience } from './federation.js';

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
 *
 * `federationAudience` is the keyless path: the account's workload identity (`context.identity`,
 * which vps fixes to the account) is exchanged at STS for an access token, with `impersonate` on
 * top if set. It excludes `credentials`, needs a workload issuer, and is never ambient, so a
 * tenant's federated account satisfies the rule above and a platform account may use it too.
 */
function accountTokens(
  config: GcpConfig,
  context: ProviderContext,
  options: GcpProviderOptions,
): TokenSource {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const federation = federationOf(config, context);
  if (federation) {
    const { audience, identity } = federation;
    // The account's own subject is signed for the pool provider's audience, as an https URL.
    const federated = federatedTokenSource({
      audience,
      subjectToken: async () =>
        (await identity.mint({ audience: subjectTokenAudience(audience) })).token,
      fetch: fetchImpl,
      universeDomain: options.universeDomain,
    });
    if (!config.impersonate) return federated;
    return impersonatedTokenSource(federated, config.impersonate, {
      fetch: fetchImpl,
      universeDomain: options.universeDomain,
    });
  }
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
      base = serviceAccountTokenSource(key, {
        fetch: fetchImpl,
        universeDomain: options.universeDomain,
      });
    } else if (options.tokenSource) base = cachedTokenSource(options.tokenSource);
    else base = metadataTokenSource({ fetch: fetchImpl });
    return base;
  };
  const lazyBase: TokenSource = {
    token: async (call) => (await resolveBase()).token(call),
  };
  if (!config.impersonate) return lazyBase;
  return impersonatedTokenSource(lazyBase, config.impersonate, {
    fetch: fetchImpl,
    universeDomain: options.universeDomain,
  });
}

/**
 * A Google Compute Engine provider definition. Pass `fetch` to emulate the API, and `tokenSource`
 * to supply the host's own credentials (workload identity) to platform accounts that name no key.
 */
export function gcpProvider(options: GcpProviderOptions = {}): ProviderDefinition<GcpConfig> {
  // Validated now, so a malformed universe fails when the host builds the provider.
  const universeEndpoint = `${googleEndpoint('compute', { universeDomain: options.universeDomain })}/compute/v1`;
  return defineProvider<GcpConfig>({
    id: 'gcp',
    version: '0.1.0',
    provides: ['vps'],
    config: gcpConfig as unknown as ProviderDefinition<GcpConfig>['config'],
    capabilities: ['power', 'list', 'discover', 'claim', 'reservations', 'networks'],
    // One pool provider is one account: vps refuses a second account with the same audience.
    accountKey: (config) => config.federationAudience || undefined,
    // A federated account proves, before it is stored, that its pool trusts exactly its subject.
    checkAccount: (config, context) => checkGcpAccount(config, context, options),
    create: (config, context) => {
      if (config.zones.length === 0)
        throw new ComputeError('INVALID_CONFIG', 'A GCP account lists at least one zone');
      parseDiscoverLabel(config.discoverLabel);
      const client = gceClient({
        fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
        endpoint: options.endpoint ?? universeEndpoint,
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
