import type { ProviderContext } from '@better-compute/core';
import { clientFor } from '../../client/build.js';
import type { DoConfig, DoProviderOptions } from '../../config.js';
import { doResources, type DoResources } from './kind.js';
import { spacesKeyKind } from './spaces-key.js';

export * from './kind.js';
export * from './spaces-key.js';

export interface DoStorageOptions extends DoProviderOptions {
  /** The fetch for Spaces (S3) requests; default `fetch`. Tests pass an emulating one. */
  spacesFetch?: typeof fetch;
  /** The Spaces endpoint of a region; default `https://<region>.digitaloceanspaces.com`. */
  spacesEndpoint?: (region: string) => string;
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
  const client = clientFor(config, context, options);
  return doResources([spacesKeyKind(client)]);
}
