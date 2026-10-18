import { ComputeError, isComputeError, type ProviderContext } from '@better-compute/core';
import { clientFor } from './client/build.js';
import type { DoClient } from './client/http.js';
import type { DoConfig, DoProviderOptions } from './config.js';

// A read-only look at what a token may do, for the CLI's account check: GET /account, then one
// page of each list the provider reads. A 403 on a list is that scope missing; `account:read` is
// fatal, since without it nothing else is worth reporting.

/** Whether the token may read a family of resources. */
export type DoFamilyState = 'ok' | 'denied';

/** What `probeAccount` found. */
export interface DoAccountReport {
  account: { uuid: string; status: string; dropletLimit: number };
  families: Record<'compute' | 'networks' | 'keys' | 'tags', DoFamilyState>;
  /** The read scopes the token lacks, in probe order. */
  missing: string[];
}

type Family = keyof DoAccountReport['families'];

/** One list per read scope. A family is denied when any of its probes is. */
const probes: readonly { family: Family; path: string; scope: string }[] = [
  { family: 'compute', path: '/droplets', scope: 'droplet:read' },
  { family: 'compute', path: '/regions', scope: 'regions:read' },
  { family: 'compute', path: '/sizes', scope: 'sizes:read' },
  { family: 'networks', path: '/vpcs', scope: 'vpc:read' },
  { family: 'networks', path: '/firewalls', scope: 'firewall:read' },
  { family: 'keys', path: '/account/keys', scope: 'ssh_key:read' },
  { family: 'tags', path: '/tags', scope: 'tag:read' },
];

/** How long the whole probe may take. */
const probeTimeoutMs = 30_000;

function badBody(): ComputeError {
  return new ComputeError(
    'PROVIDER_ERROR',
    'DigitalOcean answered GET /account with an account the probe cannot read',
    undefined,
    { provider: 'digitalocean', reason: 'badBody' },
  );
}

/**
 * Read-only probe (GET account, regions, sizes, droplets?per_page=1, vpcs?per_page=1,
 * firewalls?per_page=1, account/keys?per_page=1, tags?per_page=1). Built the way the provider
 * builds its client, so the token resolves, and is budgeted, exactly as it does for a create.
 * Throws when the token is refused or cannot read the account; any other failure of a list
 * propagates too, since it says nothing about a scope.
 */
export async function probeAccount(
  config: DoConfig,
  context: ProviderContext,
  options: DoProviderOptions = {},
): Promise<DoAccountReport> {
  const client: DoClient = clientFor(config, context, options);
  const signal = AbortSignal.timeout(probeTimeoutMs);

  const { account } = await client.request<{
    account?: { uuid?: unknown; status?: unknown; droplet_limit?: unknown };
  }>('GET', '/account', { signal, budget: 'observe' });
  if (
    typeof account?.uuid !== 'string' ||
    typeof account.status !== 'string' ||
    typeof account.droplet_limit !== 'number'
  )
    throw badBody();

  const denied = await Promise.all(
    probes.map(async ({ path }) => {
      try {
        await client.request('GET', path, {
          query: { per_page: '1' },
          signal,
          budget: 'observe',
        });
        return false;
      } catch (error) {
        if (isComputeError(error, 'ACCESS_DENIED')) return true;
        throw error;
      }
    }),
  );

  const families: DoAccountReport['families'] = {
    compute: 'ok',
    networks: 'ok',
    keys: 'ok',
    tags: 'ok',
  };
  const missing: string[] = [];
  probes.forEach(({ family, scope }, i) => {
    if (!denied[i]) return;
    families[family] = 'denied';
    missing.push(scope);
  });
  return {
    account: { uuid: account.uuid, status: account.status, dropletLimit: account.droplet_limit },
    families,
    missing,
  };
}
