import { ComputeError, type ProviderContext } from '@better-compute/core';
import { clientFor } from '../../client/build.js';
import type { DoClient } from '../../client/http.js';
import type { DoConfig, DoProviderOptions } from '../../config.js';
import { deploymentTag, managedNamePrefix } from '../../ids.js';
import { spacesClient, type SpacesClient } from '../../spaces/s3.js';
import { cdnEndpointKind } from './cdn-endpoint.js';
import { containerRegistryKind, registryGcKind } from './container-registry.js';
import {
  asDoKind,
  managedNames,
  storageDispatcher,
  type DoResourceKind,
  type DoStorageKindEntry,
  type DoStorageResources,
} from './kind.js';
import { spacesBucketKind } from './spaces-bucket.js';
import { spacesKeyKind } from './spaces-key.js';

export * from './cdn-endpoint.js';
export * from './container-registry.js';
export * from './kind.js';
export * from './spaces-bucket.js';
export * from './spaces-key.js';

/**
 * The options of the storage kinds: the provider's own (`spacesFetch`, `spacesEndpoint`,
 * `spacesKeyFullAccess` and `spacesTenantBucketAdopt` are `DoProviderOptions`, so
 * `digitaloceanProvider(options)` hands them to the kinds it serves).
 */
export type DoStorageOptions = DoProviderOptions;

/**
 * The account's S3 clients, one per region, over its Spaces key pair. Without the pair every call
 * fails closed (`INVALID_CONFIG`, reason `spacesKeys`).
 */
function spacesFor(
  config: DoConfig,
  context: ProviderContext,
  options: DoStorageOptions,
): (region: string) => SpacesClient {
  const clients = new Map<string, SpacesClient>();
  return (region) => {
    const { spacesAccessKey, spacesSecretKey } = config;
    if (!spacesAccessKey || !spacesSecretKey)
      throw new ComputeError(
        'INVALID_CONFIG',
        'This DigitalOcean account has no Spaces key pair (spacesAccessKey and spacesSecretKey)',
        undefined,
        { provider: 'digitalocean', reason: 'spacesKeys' },
      );
    let client = clients.get(region);
    if (!client) {
      client = spacesClient({
        fetch: options.spacesFetch ?? globalThis.fetch.bind(globalThis),
        region,
        ...(options.spacesEndpoint ? { endpoint: options.spacesEndpoint(region) } : {}),
        credentials: async () => ({
          accessKeyId: await context.secrets.resolve(spacesAccessKey),
          secretAccessKey: await context.secrets.resolve(spacesSecretKey),
        }),
        clock: context.clock,
        log: context.log,
      });
      clients.set(region, client);
    }
    return client;
  };
}

/**
 * The storage kind handlers of one DigitalOcean account (Spaces keys and buckets, CDN endpoints,
 * the Container Registry). Like the provider's `create`, they make no request and resolve no
 * secret until the first call. `client`: the account's API client when the caller already built
 * one (the provider shares its own, and so its request budget).
 */
export function storageKindHandlers(
  config: DoConfig,
  context: ProviderContext,
  options: DoStorageOptions = {},
  client: DoClient = clientFor(config, context, options),
): DoResourceKind[] {
  if (!config.spacesAccessKey !== !config.spacesSecretKey)
    throw new ComputeError(
      'INVALID_CONFIG',
      'spacesAccessKey and spacesSecretKey are set together or not at all',
      undefined,
      { provider: 'digitalocean', reason: 'spacesKeys' },
    );
  const deployment = options.deployment ?? 'default';
  const tag = deploymentTag(deployment);
  const names = managedNames(managedNamePrefix(deployment));
  const spaces = spacesFor(config, context, options);
  return [
    spacesKeyKind({
      client,
      names,
      spaces,
      deploymentTag: tag,
      ...(options.spacesKeyFullAccess ? { allowFullAccess: true } : {}),
    }),
    spacesBucketKind({
      spaces,
      deploymentTag: tag,
      names,
      client,
      ...(options.spacesTenantBucketAdopt ? { allowTenantAdopt: true } : {}),
    }),
    cdnEndpointKind({ client, spaces, deploymentTag: tag, names }),
    containerRegistryKind(client, names),
    registryGcKind(client, names),
  ];
}

/** The account's storage kinds served on their own, as core's `ProviderResources`. */
export function doStorageResources(
  config: DoConfig,
  context: ProviderContext,
  options: DoStorageOptions = {},
): DoStorageResources {
  return storageDispatcher(storageKindHandlers(config, context, options));
}

/**
 * The account's storage kinds as entries of the provider-wide DigitalOcean dispatcher: the provider
 * appends them to `doResourceKinds()`, so its one `resources` (`DoResources`) serves databases and
 * storage alike, and `cloudResources.kinds` lists them.
 */
export function doStorageKinds(
  config: DoConfig,
  context: ProviderContext,
  options: DoStorageOptions = {},
  client?: DoClient,
): DoStorageKindEntry[] {
  return storageKindHandlers(config, context, options, client).map(asDoKind);
}
