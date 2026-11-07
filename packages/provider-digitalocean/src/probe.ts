import { ComputeError, isComputeError, type ProviderContext } from '@better-compute/core';
import { clientFor } from './client/build.js';
import type { DoClient } from './client/http.js';
import type { DoConfig, DoProviderOptions } from './config.js';

// A read-only look at what a token may do, for the CLI's account check: GET /account, then one
// page of each list the provider reads. A 403 on a list is that scope missing; `account:read` is
// fatal, since without it nothing else is worth reporting. Write scopes are not probed: DO has no
// read-only way to see them, and a trial write could create (and bill) something. The report names
// them as `unverified`, so a token that reads but cannot create is not taken for a working one.

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
  /**
   * The write scopes the provider needs that a read-only probe cannot check (the README's scope table): a token
   * without one passes the probe and fails the first write with `ACCESS_DENIED`.
   */
  unverified: string[];
}

/** The write scopes the provider uses, by family; never probed (see the top of this file). */
const writeScopes: readonly string[] = [
  'droplet:create',
  'droplet:update',
  'droplet:delete',
  'ssh_key:create',
  'tag:create',
  'tag:delete',
  'vpc:create',
  'vpc:update',
  'vpc:delete',
  'firewall:create',
  'firewall:update',
  'firewall:delete',
  'block_storage:create',
  'block_storage:update',
  'block_storage:delete',
  'block_storage_action:create',
  'block_storage_snapshot:create',
  'block_storage_snapshot:delete',
  'reserved_ip:create',
  'reserved_ip:update',
  'reserved_ip:delete',
];

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
  { family: 'storage', path: '/volumes', scope: 'block_storage:read' },
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
 * reserved_ips?per_page=1). Built the way the provider
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
    return await probe(client, controller.signal);
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

async function probe(client: DoClient, signal: AbortSignal): Promise<DoAccountReport> {
  const { account } = await client.request<{
    account?: { uuid?: unknown; status?: unknown; droplet_limit?: unknown };
  }>('GET', '/account', { signal, budget: 'observe' });
  // droplet_limit needs droplet:read in DigitalOcean's model: without it the body omits the field.
  if (typeof account?.uuid !== 'string' || typeof account.status !== 'string') throw badBody();

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
    unverified: [...writeScopes],
  };
}
