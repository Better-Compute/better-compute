import { ComputeError, isComputeError, type ProviderContext } from '@better-compute/core';
import { clientFor } from './client/build.js';
import type { DoClient } from './client/http.js';
import type { DoConfig, DoProviderOptions } from './config.js';

// A read-only look at what a token may do, for the CLI's account check: GET /account, then one
// page of each list the provider reads. A 403 on a list is that scope missing; `account:read` is
// fatal, since without it nothing else is worth reporting.

/**
 * Whether the token may read a family of resources. `unavailable` is only for an optional family
 * (`nfs`): the account's first region answered that it has no such list there, or the account
 * names no region to ask about.
 */
export type DoFamilyState = 'ok' | 'denied' | 'unavailable';

/** What `probeAccount` found. */
export interface DoAccountReport {
  /** `dropletLimit` is absent when the token lacks `droplet:read`: DigitalOcean then leaves it out. */
  account: { uuid: string; status: string; dropletLimit?: number };
  families: Record<
    'compute' | 'networks' | 'keys' | 'tags' | 'storage' | 'addresses' | 'nfs',
    DoFamilyState
  >;
  /** The read scopes the token lacks, in probe order. */
  missing: string[];
}

type Family = keyof DoAccountReport['families'];

/**
 * One list per read scope. A family is denied when any of its probes is. `regional` lists need a
 * region (the account's first). NFS (P6) answers per region, and its path, parameters and scope
 * name are unverified, so it is `optional`: its own family, never failing the probe for an
 * answer that says NFS is not there (400, 404, 422, UNSUPPORTED), and never hiding block storage.
 */
const probes: readonly {
  family: Family;
  path: string;
  scope: string;
  regional?: boolean;
  optional?: boolean;
}[] = [
  { family: 'compute', path: '/droplets', scope: 'droplet:read' },
  { family: 'compute', path: '/regions', scope: 'regions:read' },
  { family: 'compute', path: '/sizes', scope: 'sizes:read' },
  { family: 'networks', path: '/vpcs', scope: 'vpc:read' },
  { family: 'networks', path: '/firewalls', scope: 'firewall:read' },
  { family: 'keys', path: '/account/keys', scope: 'ssh_key:read' },
  { family: 'tags', path: '/tags', scope: 'tag:read' },
  { family: 'storage', path: '/volumes', scope: 'block_storage:read' },
  { family: 'nfs', path: '/nfs', scope: 'nfs:read', regional: true, optional: true },
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
 * propagates too, since it says nothing about a scope, except that the optional NFS list is
 * reported `unavailable` when its region answers it has none (or there is no region to ask).
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

  const region = config.regions[0];
  const answers = await Promise.all(
    probes.map(async ({ path, regional, optional }): Promise<DoFamilyState> => {
      if (regional && region === undefined) return 'unavailable';
      try {
        await client.request('GET', path, {
          query: { per_page: '1', ...(regional ? { region: region! } : {}) },
          signal,
          budget: 'observe',
        });
        return 'ok';
      } catch (error) {
        if (isComputeError(error, 'ACCESS_DENIED')) return 'denied';
        if (
          optional &&
          (isComputeError(error, 'INVALID_INPUT') ||
            isComputeError(error, 'NOT_FOUND') ||
            isComputeError(error, 'UNSUPPORTED'))
        )
          return 'unavailable';
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
    nfs: 'ok',
  };
  const missing: string[] = [];
  probes.forEach(({ family, scope }, i) => {
    const answer = answers[i]!;
    if (answer === 'denied') {
      families[family] = 'denied';
      missing.push(scope);
    } else if (answer === 'unavailable' && families[family] === 'ok') families[family] = answer;
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
