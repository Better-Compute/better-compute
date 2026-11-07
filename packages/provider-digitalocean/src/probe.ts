import {
  ComputeError,
  isComputeError,
  type ProviderAccountProbe,
  type ProviderContext,
} from '@better-compute/core';
import { clientFor } from './client/build.js';
import { readDeadline } from './client/deadline.js';
import type { DoClient } from './client/http.js';
import type { ReportedRateLimit } from './client/budget.js';
import type { DoConfig, DoProviderOptions } from './config.js';

// A read-only look at what a token may do, for the CLI's account check: GET /account, then one
// page of each list the provider reads. A 403 on a list is that scope missing; `account:read` is
// fatal, since without it nothing else is worth reporting. Write scopes are not probed: DO has no
// read-only way to see them, and a trial write could create (and bill) something. The report names
// them as `unverified`, so a token that reads but cannot create is not taken for a working one.

/**
 * Whether the token may read a family of resources. `unavailable` is only for an optional family
 * (`nfs`): the account's first region answered that it has no such list there, or the account
 * names no region to ask about.
 */
export type DoFamilyState = 'ok' | 'denied' | 'unavailable';

/** What `probeAccount` found. */
export interface DoAccountReport {
  /**
   * `dropletLimit` is absent when the token lacks `droplet:read`: DigitalOcean then leaves it out. `team` (P9
   * Organizations) is the team the token belongs to, read-only: its id and name, never its members' details.
   */
  account: {
    uuid: string;
    status: string;
    dropletLimit?: number;
    team?: { uuid?: string; name?: string };
  };
  families: Record<
    | 'compute'
    | 'networks'
    | 'keys'
    | 'tags'
    | 'storage'
    | 'addresses'
    | 'nfs'
    | 'loadBalancers'
    | 'dns'
    | 'certificates',
    DoFamilyState
  >;
  /** The read scopes the token lacks, in probe order (the operations scopes last). */
  missing: string[];
  /**
   * The write scopes the provider needs that a read-only probe cannot check (the README's scope table): a token
   * without one passes the probe and fails the first write with `ACCESS_DENIED`.
   */
  unverified: string[];
  /** (P9) The operations families, only when the probe is asked for them (`{ operations: true }`). */
  operations?: Partial<Record<DoOperationsFamily, DoFamilyState>>;
  /**
   * (P9) What DigitalOcean's answers to the probe left of the token's hourly request limit (every process using
   * the token counts against it), for the admin panel's rate-budget gauge. Absent when no answer carried it.
   */
  rateLimit?: ReportedRateLimit;
}

/** (P9) Read scopes the operations surfaces need: none of them is needed to run Droplets. */
export type DoOperationsFamily = 'billing' | 'projects' | 'monitoring' | 'security';

/** One read per operations scope. */
const operationsProbes: readonly { family: DoOperationsFamily; path: string; scope: string }[] = [
  { family: 'billing', path: '/customers/my/balance', scope: 'billing:read' },
  { family: 'projects', path: '/projects', scope: 'project:read' },
  { family: 'monitoring', path: '/monitoring/alerts', scope: 'monitoring:read' },
  { family: 'security', path: '/security/scans', scope: 'security:read' },
];

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
  { family: 'loadBalancers', path: '/load_balancers', scope: 'load_balancer:read' },
  { family: 'dns', path: '/domains', scope: 'domain:read' },
  { family: 'certificates', path: '/certificates', scope: 'certificate:read' },
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
 * reserved_ips?per_page=1, nfs?region=<first region>&per_page=1, load_balancers?per_page=1,
 * domains?per_page=1, certificates?per_page=1). Built the way the provider
 * builds its client, so the token resolves, and is budgeted, exactly as it does for a create.
 * Throws when the token is refused or cannot read the account; any other failure of a list
 * propagates too, since it says nothing about a scope, except that the optional NFS list is
 * reported `unavailable` when its region answers it has none (or there is no region to ask).
 */
export async function probeAccount(
  config: DoConfig,
  context: ProviderContext & { signal?: AbortSignal },
  options: DoProviderOptions = {},
  scope: { operations?: boolean } = {},
): Promise<DoAccountReport> {
  const client: DoClient = clientFor(config, context, options);
  const deadline = readDeadline(context, probeTimeoutMs);
  try {
    const report = await probe(client, config, deadline.signal, scope.operations === true);
    const rateLimit = client.rateLimit?.();
    return rateLimit ? { ...report, rateLimit } : report;
  } catch (error) {
    // The client rethrows an abort as it is; a caller should see a ComputeError.
    if (deadline.timedOut())
      throw new ComputeError(
        'UNAVAILABLE',
        `The DigitalOcean account probe took longer than ${probeTimeoutMs / 1000} seconds`,
        undefined,
        { provider: 'digitalocean', reason: 'timeout' },
      );
    throw error;
  } finally {
    deadline.done();
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
  config: DoConfig,
  signal: AbortSignal,
  withOperations: boolean,
): Promise<DoAccountReport> {
  const { account } = await client.request<{
    account?: { uuid?: unknown; status?: unknown; droplet_limit?: unknown; team?: unknown };
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
    loadBalancers: 'ok',
    dns: 'ok',
    certificates: 'ok',
  };
  const missing: string[] = [];
  probes.forEach(({ family, scope }, i) => {
    const answer = answers[i]!;
    if (answer === 'denied') {
      families[family] = 'denied';
      missing.push(scope);
    } else if (answer === 'unavailable' && families[family] === 'ok') families[family] = answer;
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
  const rawTeam = (account.team ?? {}) as { uuid?: unknown; name?: unknown };
  const team = {
    ...(typeof rawTeam.uuid === 'string' && rawTeam.uuid
      ? { uuid: rawTeam.uuid.slice(0, 64) }
      : {}),
    ...(typeof rawTeam.name === 'string' && rawTeam.name
      ? { name: rawTeam.name.slice(0, 200) }
      : {}),
  };
  return {
    ...(operations ? { operations } : {}),
    account: {
      uuid: account.uuid,
      status: account.status,
      ...(typeof account.droplet_limit === 'number' ? { dropletLimit: account.droplet_limit } : {}),
      ...(Object.keys(team).length ? { team } : {}),
    },
    families,
    missing,
    unverified: [...writeScopes],
  };
}

/**
 * A probe report as `providerAccounts.check` answers it (`ProviderAccountProbe`): the scopes Droplets need are
 * `missing`, the operations scopes `optional`, and the account is ok only when it is `active` with nothing missing
 * (a locked or warned account cannot create Droplets).
 */
export function checkReport(report: DoAccountReport): ProviderAccountProbe {
  const operationsScopes = new Set(operationsProbes.map(({ scope }) => scope));
  const missing = report.missing.filter((scope) => !operationsScopes.has(scope));
  const optional = report.missing.filter((scope) => operationsScopes.has(scope));
  return {
    ok: missing.length === 0 && report.account.status === 'active',
    missing,
    optional,
    details: {
      account: {
        ...report.account,
        ...(report.account.team ? { team: { ...report.account.team } } : {}),
      },
      families: { ...report.families },
      ...(report.operations ? { operations: { ...report.operations } } : {}),
    },
    ...(report.rateLimit ? { rateLimit: { ...report.rateLimit } } : {}),
  };
}
