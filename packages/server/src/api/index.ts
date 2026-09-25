import type { Caches } from '../caches.js';
import { createListRecipe } from '../list.js';
import { commandsApi, type CommandsApi } from './commands.js';
import { eventsApi, type EventsApi } from './events.js';
import { joinTokensApi, type JoinTokenMinter, type JoinTokensApi } from './join-tokens.js';
import { nodesApi, type NodesApi } from './nodes.js';
import { projectsApi, type ProjectsApi } from './projects.js';
import { sitesApi, type SitesApi } from './sites.js';
import { usageApi, type UsageApi } from './usage.js';
import { mergeGroups, serverV02Groups, type ServerV02Api, type ServerV02Options } from './v02.js';

export type { Page } from './common.js';
export type {
  CommandInfo,
  CommandsApi,
  GetCommandInput,
  ListCommandsInput,
  RunCommandInput,
  RunnableCommandKind,
} from './commands.js';
export type { EventsApi, ListEventsInput } from './events.js';
export type {
  CreatedJoinToken,
  CreateJoinTokenInput,
  JoinTokenExpect,
  JoinTokenInfo,
  JoinTokenMinter,
  JoinTokensApi,
  ListJoinTokensInput,
  RevokeJoinTokenInput,
} from './join-tokens.js';
export type {
  GetNodeInput,
  LabelNodeInput,
  ListNodesInput,
  NodeChangeInput,
  NodeDetail,
  NodeEvent,
  NodeEventsInput,
  NodeInfo,
  NodesApi,
  RevokeIdentityResult,
  TaintNodeInput,
} from './nodes.js';
export type {
  CreateProjectInput,
  GetProjectInput,
  ListProjectsInput,
  ProjectsApi,
} from './projects.js';
export type { CreateSiteInput, GetSiteInput, ListSitesInput, SitesApi } from './sites.js';
export type { ListUsageInput, UsageApi, UsageWindow } from './usage.js';

export type { ServerV02Api, ServerV02Options } from './v02.js';

/** The server's own groups of PLAN.md §9.2 (module `server`), besides `system`: v0.1 and v0.2. */
export type ServerApi = ProjectsApi &
  SitesApi &
  JoinTokensApi &
  NodesApi &
  CommandsApi &
  UsageApi &
  EventsApi &
  ServerV02Api;

export interface ServerGroupsOptions {
  /** The IAM resource type prefix (`compute-`), for the list recipe's per-item checks. */
  typePrefix: string;
  /** The server's read-decision cache, which per-item checks read and fill. */
  caches: Caches;
  /** The list recipe's wait before its one retry (default 100 ms). */
  listRetryDelayMs?: number;
  /** How join tokens are minted (default: 32 random bytes, `bcjt_<id>.<secret>`). */
  joinTokens?: JoinTokenMinter;
  /** Where `secrets.put` keeps values; without one, `secrets.*` answer UNAVAILABLE. */
  secrets?: ServerV02Options['secrets'];
  /** The registered drivers, for `drivers.list`. */
  drivers?: ServerV02Options['drivers'];
}

/** Builds the server's groups; handlers reach the ports through each call's `MethodContext`. */
export function serverGroups(options: ServerGroupsOptions): ServerApi {
  const lists = createListRecipe({
    typePrefix: options.typePrefix,
    caches: options.caches,
    ...(options.listRetryDelayMs === undefined ? {} : { retryDelayMs: options.listRetryDelayMs }),
  });
  // v0.2 methods join the v0.1 `sites` and `nodes` groups: merged method by method.
  return mergeGroups(
    {
      ...projectsApi(lists),
      ...sitesApi(lists),
      ...joinTokensApi(options.joinTokens),
      ...nodesApi(lists),
      ...commandsApi(),
      ...usageApi(),
      ...eventsApi(),
    },
    serverV02Groups({
      ...(options.joinTokens ? { joinTokens: options.joinTokens } : {}),
      ...(options.secrets ? { secrets: options.secrets } : {}),
      ...(options.drivers ? { drivers: options.drivers } : {}),
    }),
  );
}
