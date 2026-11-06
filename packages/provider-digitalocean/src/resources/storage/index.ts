import { ComputeError, type ProviderContext } from '@better-compute/core';
import { clientFor } from '../../client/build.js';
import type { DoConfig, DoProviderOptions } from '../../config.js';
import { deploymentTag } from '../../ids.js';
import { spacesClient, type SpacesClient } from '../../spaces/s3.js';
import { doResources, type DoResources } from './kind.js';
import { spacesBucketKind } from './spaces-bucket.js';
import { spacesKeyKind } from './spaces-key.js';

export * from './kind.js';
export * from './spaces-bucket.js';
export * from './spaces-key.js';

export interface DoStorageOptions extends DoProviderOptions {
  /** The fetch for Spaces (S3) requests; default `fetch`. Tests pass an emulating one. */
  spacesFetch?: typeof fetch;
  /** The Spaces endpoint of a region; default `https://<region>.digitaloceanspaces.com`. */
  spacesEndpoint?: (region: string) => string;
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
 * The storage kinds of one DigitalOcean account (Spaces keys and buckets, CDN endpoints, the
 * Container Registry), served as one `DoResources`. Like the provider's `create`, it makes no
 * request and resolves no secret until the first call.
 */
export function doStorageResources(
  config: DoConfig,
  context: ProviderContext,
  options: DoStorageOptions = {},
): DoResources {
  if (!config.spacesAccessKey !== !config.spacesSecretKey)
    throw new ComputeError(
      'INVALID_CONFIG',
      'spacesAccessKey and spacesSecretKey are set together or not at all',
      undefined,
      { provider: 'digitalocean', reason: 'spacesKeys' },
    );
  const client = clientFor(config, context, options);
  const tag = deploymentTag(options.deployment ?? 'default');
  return doResources([
    spacesKeyKind(client),
    spacesBucketKind({ spaces: spacesFor(config, context, options), deploymentTag: tag }),
  ]);
}
