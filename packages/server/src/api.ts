import type {
  ComputeModule,
  ComputePlugin,
  Credential,
  MethodDefinition,
  ModuleApis,
  PluginApis,
} from '@better-compute/core';
import type { CapacityApi } from '@better-compute/capacity';
import type { InventoryApi } from '@better-compute/inventory';
import { serverGroups, type ServerApi, type ServerGroupsOptions } from './api/index.js';
import { cachesFor } from './caches.js';
import type { ResolvedOptions } from './options.js';
import type { SelfCheckReport } from './self-check.js';
import { systemApi, type SystemApi } from './system.js';
import type { ServerInfo } from './version.js';

export type * from './api/index.js';
export type { ComputeCaches } from './caches.js';

/**
 * A method as `compute.api` exposes it: `(credential, input)`, through the same envelope as HTTP.
 * When the input has no required fields both may be left out (`compute.api.system.version()`).
 * The typed client strips the credential (`createComputeClient<typeof compute>`).
 */
export type ApiMethod<M> =
  M extends MethodDefinition<infer I, infer O>
    ? {} extends I
      ? (credential?: Credential, input?: I) => Promise<O>
      : (credential: Credential, input: I) => Promise<O>
    : never;

/** API groups of method definitions (`{ group: { method: MethodDefinition } }`), as callable methods. */
export type CallableApi<G> = {
  [Group in keyof G]: { [Method in keyof G[Group]]: ApiMethod<G[Group][Method]> };
};

/**
 * The groups every server has: `system`, the server's own v0.1 groups (`projects`, `sites`,
 * `joinTokens`, `nodes`, `commands`, `usage`, `events`) and the built-in modules' (`inventory`;
 * `pools`, `capacity`, `reservations`, `quotas`).
 */
export type CoreGroups = SystemApi & ServerApi & InventoryApi & CapacityApi;

/** The core groups as `compute.api` exposes them. */
export type CoreApi = CallableApi<CoreGroups>;

/** Plugin groups by plugin id, mounted under `plugins/{id}/{group}/{method}`. */
export type PluginsApi<P extends readonly ComputePlugin[]> = {
  [Id in keyof PluginApis<P>]: CallableApi<PluginApis<P>[Id]>;
};

/** `compute.api`: the core groups, the injected modules' groups, and `plugins[id]`. */
export type ComputeApi<
  M extends readonly ComputeModule[],
  P extends readonly ComputePlugin[],
> = CallableApi<CoreGroups & ModuleApis<M>> & { plugins: PluginsApi<P> };

/**
 * The server's own groups, registered before the built-in modules: `system`, then the v0.1 groups
 * of module `server` in §9.2. `extra` is for tests (join-token minting, list retry delay).
 */
export function coreGroups(
  options: ResolvedOptions,
  host: { info(): ServerInfo; selfCheck(): Promise<SelfCheckReport> },
  extra: Partial<Pick<ServerGroupsOptions, 'joinTokens' | 'listRetryDelayMs'>> = {},
): SystemApi & ServerApi {
  return {
    ...systemApi(host),
    ...serverGroups({
      typePrefix: options.typePrefix,
      caches: cachesFor(options, { now: () => options.clock.now() }),
      ...extra,
    }),
  };
}
