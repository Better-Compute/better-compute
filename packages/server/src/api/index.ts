import type { Caches } from '../caches.js';
import { createListRecipe } from '../list.js';
import { commandsApi, type CommandsApi } from './commands.js';
import { eventsApi, type EventsApi } from './events.js';
import { joinTokensApi, type JoinTokenMinter, type JoinTokensApi } from './join-tokens.js';
import { nodesApi, type NodesApi } from './nodes.js';
import { projectsApi, type ProjectsApi } from './projects.js';
import { sitesApi, type SitesApi } from './sites.js';
import { usageApi, type UsageApi } from './usage.js';

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

/** The server's own v0.1 groups of PLAN.md §9.2 (module `server`), besides `system`. */
export type ServerApi = ProjectsApi &
  SitesApi &
  JoinTokensApi &
  NodesApi &
  CommandsApi &
  UsageApi &
  EventsApi;

export interface ServerGroupsOptions {
  /** The IAM resource type prefix (`compute-`), for the list recipe's per-item checks. */
  typePrefix: string;
  /** The server's read-decision cache, which per-item checks read and fill. */
  caches: Caches;
  /** The list recipe's wait before its one retry (default 100 ms). */
  listRetryDelayMs?: number;
  /** How join tokens are minted (default: 32 random bytes, `bcjt_<id>.<secret>`). */
  joinTokens?: JoinTokenMinter;
}

/** Builds the server's groups; handlers reach the ports through each call's `MethodContext`. */
export function serverGroups(options: ServerGroupsOptions): ServerApi {
  const lists = createListRecipe({
    typePrefix: options.typePrefix,
    caches: options.caches,
    ...(options.listRetryDelayMs === undefined ? {} : { retryDelayMs: options.listRetryDelayMs }),
  });
  return {
    ...projectsApi(lists),
    ...sitesApi(lists),
    ...joinTokensApi(options.joinTokens),
    ...nodesApi(lists),
    ...commandsApi(),
    ...usageApi(),
    ...eventsApi(),
  };
}
