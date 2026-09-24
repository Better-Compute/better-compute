import type {
  ComputeModule,
  ComputePlugin,
  Credential,
  MethodDefinition,
  ModuleApis,
  PluginApis,
} from '@better-compute/core';
import type { InventoryApi } from '@better-compute/inventory';
import type { SystemApi } from './system.js';

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

/** The groups every server has: `system` and the built-in modules' (`inventory`; `capacity` from v0.1). */
export type CoreGroups = SystemApi & InventoryApi;

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
