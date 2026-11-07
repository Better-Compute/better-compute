import { ComputeError, type ProviderContext } from '@better-compute/core';
import { clientFor } from '../../client/build.js';
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

export interface DoStorageOptions extends DoProviderOptions {
  /** The fetch for Spaces (S3) requests; default `fetch`. Tests pass an emulating one. */
  spacesFetch?: typeof fetch;
  /** The Spaces endpoint of a region; default `https://<region>.digitaloceanspaces.com`. */
  spacesEndpoint?: (region: string) => string;
  /**
   * Allows `do.spaces-key` grants of `*:fullaccess` (every bucket of the account). Off by
   * default: tenant keys are granted bucket by bucket. An operator-only code option.
   */
  spacesKeyFullAccess?: boolean;
  /**
   * Lets a tenant (an `adopt` carrying `better-compute-tenant`) adopt an unmarked Spaces bucket.
   * Off by default: unmarked buckets are the operator's (its spacesBlobStore bucket among them),
   * so only operator calls adopt them. An operator-only code option.
   */
  spacesTenantBucketAdopt?: boolean;
}

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
 * secret until the first call.
 */
export function storageKindHandlers(
  config: DoConfig,
  context: ProviderContext,
  options: DoStorageOptions = {},
): DoResourceKind[] {
  if (!config.spacesAccessKey !== !config.spacesSecretKey)
    throw new ComputeError(
      'INVALID_CONFIG',
      'spacesAccessKey and spacesSecretKey are set together or not at all',
      undefined,
      { provider: 'digitalocean', reason: 'spacesKeys' },
    );
  const client = clientFor(config, context, options);
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
 * The account's storage kinds as entries of the provider-wide DigitalOcean dispatcher
 * (`new DoResources(client, config, deployment, [...doResourceKinds(), ...doStorageKinds(...)])`
 * once lane do-cloud-resources is merged), so one `resources` serves databases and storage alike.
 */
export function doStorageKinds(
  config: DoConfig,
  context: ProviderContext,
  options: DoStorageOptions = {},
): DoStorageKindEntry[] {
  return storageKindHandlers(config, context, options).map(asDoKind);
}
