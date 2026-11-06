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
  families: Record<'compute' | 'networks' | 'keys' | 'tags', DoFamilyState>;
  /** The read scopes the token lacks, in probe order (the operations scopes last). */
  missing: string[];
  /** (P9) The operations families, only when the probe is asked for them (`{ operations: true }`). */
  operations?: Partial<Record<DoOperationsFamily, DoFamilyState>>;
}

/** (P9) Read scopes the operations surfaces need: none of them is needed to run Droplets. */
export type DoOperationsFamily = 'billing';

/** One read per operations scope. */
const operationsProbes: readonly { family: DoOperationsFamily; path: string; scope: string }[] = [
  { family: 'billing', path: '/customers/my/balance', scope: 'billing:read' },
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
  scope: { operations?: boolean } = {},
): Promise<DoAccountReport> {
  const client: DoClient = clientFor(config, context, options);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, probeTimeoutMs);
  try {
    return await probe(client, controller.signal, scope.operations === true);
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

/** Whether a GET is refused for scope (true), allowed (false), or failed otherwise (thrown). */
async function refusedForScope(
  client: DoClient,
  path: string,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    await client.request('GET', path, { query: { per_page: '1' }, signal, budget: 'observe' });
    return false;
  } catch (error) {
    if (isComputeError(error, 'ACCESS_DENIED')) return true;
    throw error;
  }
}

async function probe(
  client: DoClient,
  signal: AbortSignal,
  withOperations: boolean,
): Promise<DoAccountReport> {
  const { account } = await client.request<{
    account?: { uuid?: unknown; status?: unknown; droplet_limit?: unknown };
  }>('GET', '/account', { signal, budget: 'observe' });
  // droplet_limit needs droplet:read in DigitalOcean's model: without it the body omits the field.
  if (typeof account?.uuid !== 'string' || typeof account.status !== 'string') throw badBody();

  const denied = await Promise.all(probes.map(({ path }) => refusedForScope(client, path, signal)));

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
  let operations: DoAccountReport['operations'];
  if (withOperations) {
    const refused = await Promise.all(
      operationsProbes.map(({ path }) => refusedForScope(client, path, signal)),
    );
    operations = {};
    operationsProbes.forEach(({ family, scope }, i) => {
      operations![family] = refused[i] ? 'denied' : 'ok';
      if (refused[i]) missing.push(scope);
    });
  }
  return {
    ...(operations ? { operations } : {}),
    account: {
      uuid: account.uuid,
      status: account.status,
      ...(typeof account.droplet_limit === 'number' ? { dropletLimit: account.droplet_limit } : {}),
    },
    families,
    missing,
  };
}
