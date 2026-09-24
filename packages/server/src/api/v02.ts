import { driversApi, type DriverSource, type DriversApi } from './drivers.js';
import { joinRequestsApi, type JoinRequestsApi } from './join-requests.js';
import type { JoinTokenMinter } from './join-tokens.js';
import { nodesDeleteApi, type NodesDeleteApi } from './nodes-delete.js';
import { secretsApi, type SecretStoreSource, type SecretsApi } from './secrets.js';
import { siteTokensApi, type SiteTokensApi } from './site-tokens.js';
import { sitesManageApi, type SitesManageApi } from './sites-manage.js';

// The server's v0.2 groups of PLAN.md §9.2: `joinRequests`, `siteTokens`, `secrets`, `drivers`, and
// `sites.update/delete` and `nodes.delete`, which join the v0.1 `sites` and `nodes` groups.

export type ServerV02Api = JoinRequestsApi &
  SiteTokensApi &
  SecretsApi &
  DriversApi &
  SitesManageApi &
  NodesDeleteApi;

export interface ServerV02Options {
  /** How site tokens are minted (default: the join-token minter, `bcjt_<id>.<secret>`). */
  joinTokens?: JoinTokenMinter;
  /** Where `secrets.put` keeps values; without one, `secrets.*` answer UNAVAILABLE. */
  secrets?: SecretStoreSource;
  /** The registered drivers (the registry's `extensions` of kind `driver`). */
  drivers?: DriverSource;
}

export function serverV02Groups(options: ServerV02Options = {}): ServerV02Api {
  return {
    ...joinRequestsApi(),
    ...siteTokensApi(options.joinTokens),
    ...secretsApi(options.secrets),
    ...driversApi(options.drivers ?? (() => [])),
    ...sitesManageApi(),
    ...nodesDeleteApi(),
  };
}

/** Merges API groups method by method, so `sites.update` joins `sites.list` rather than replacing it. */
export function mergeGroups<A extends object, B extends object>(a: A, b: B): A & B {
  const merged: Record<string, Record<string, unknown>> = {};
  for (const source of [a, b] as Record<string, Record<string, unknown>>[])
    for (const [group, methods] of Object.entries(source)) merged[group] = { ...merged[group], ...methods };
  return merged as A & B;
}
