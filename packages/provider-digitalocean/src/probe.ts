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
  /** `dropletLimit` is absent when the token lacks `droplet:read`: DigitalOcean then leaves it out. */
  account: { uuid: string; status: string; dropletLimit?: number };
  families: Record<
    'compute' | 'networks' | 'keys' | 'tags' | 'storage' | 'addresses',
    DoFamilyState
  >;
  /** The read scopes the token lacks, in probe order. */
  missing: string[];
}

type Family = keyof DoAccountReport['families'];

/**
 * One list per read scope. A family is denied when any of its probes is. `regional` lists need a
 * region (the account's first). NFS (P6) answers per region, and its scope name is unverified.
 */
const probes: readonly { family: Family; path: string; scope: string; regional?: boolean }[] = [
  { family: 'compute', path: '/droplets', scope: 'droplet:read' },
  { family: 'compute', path: '/regions', scope: 'regions:read' },
  { family: 'compute', path: '/sizes', scope: 'sizes:read' },
  { family: 'networks', path: '/vpcs', scope: 'vpc:read' },
  { family: 'networks', path: '/firewalls', scope: 'firewall:read' },
  { family: 'keys', path: '/account/keys', scope: 'ssh_key:read' },
  { family: 'tags', path: '/tags', scope: 'tag:read' },
  { family: 'storage', path: '/volumes', scope: 'block_storage:read' },
  { family: 'storage', path: '/nfs', scope: 'nfs:read', regional: true },
  { family: 'addresses', path: '/reserved_ips', scope: 'reserved_ip:read' },
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
 * firewalls?per_page=1, account/keys?per_page=1, tags?per_page=1, volumes?per_page=1,
 * reserved_ips?per_page=1, nfs?region=<first region>&per_page=1). Built the way the provider
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
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, probeTimeoutMs);
  try {
    return await probe(client, config, controller.signal);
  } catch (error) {
    // The client rethrows an abort as it is; a caller should see a ComputeError.
    if (timedOut)
      throw new ComputeError(
        'UNAVAILABLE',
        `The DigitalOcean account probe took longer than ${probeTimeoutMs / 1000} seconds`,
        undefined,
        { provider: 'digitalocean', reason: 'timeout' },
      );
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function probe(
  client: DoClient,
  config: DoConfig,
  signal: AbortSignal,
): Promise<DoAccountReport> {
  const { account } = await client.request<{
    account?: { uuid?: unknown; status?: unknown; droplet_limit?: unknown };
  }>('GET', '/account', { signal, budget: 'observe' });
  // droplet_limit needs droplet:read in DigitalOcean's model: without it the body omits the field.
  if (typeof account?.uuid !== 'string' || typeof account.status !== 'string') throw badBody();

  const denied = await Promise.all(
    probes.map(async ({ path, regional }) => {
      try {
        await client.request('GET', path, {
          query: {
            per_page: '1',
            ...(regional && config.regions[0] !== undefined ? { region: config.regions[0] } : {}),
          },
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
    storage: 'ok',
    addresses: 'ok',
  };
  const missing: string[] = [];
  probes.forEach(({ family, scope }, i) => {
    if (!denied[i]) return;
    families[family] = 'denied';
    missing.push(scope);
  });
  return {
    account: {
      uuid: account.uuid,
      status: account.status,
      ...(typeof account.droplet_limit === 'number' ? { dropletLimit: account.droplet_limit } : {}),
    },
    families,
    missing,
  };
}
