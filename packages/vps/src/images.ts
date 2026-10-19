import {
  ComputeError,
  strictObject,
  type CallContext,
  type ProviderImage,
  type ProviderImageMiss,
  type SqlTx,
} from '@better-compute/core';
import { readPoolAccount, type ClientDeps, type ProviderClients } from './accounts.js';
import { fail, id, object, tenant } from './input.js';
import { visibleVpsPool } from './instances.js';

// `images.resolve` (U-03): a provider pool's image families, resolved by its account's provider
// (`ProviderImpl.images.resolve`, which caches and hides deprecated images) for the image pickers of
// whoever may launch there. A read on the pool: the owner and the tenants it is offered to.

/** At most this many families per call. */
export const maxImageFamilies = 50;
/** How long one resolve may wait on the provider. */
const resolveBudgetMs = 30_000;

/** A family as a provider takes it: `family`, `project/family` or `projects/<p>/global/images/family/<f>`. */
const familyPattern = /^[a-z0-9][a-z0-9._:/-]{0,199}$/;

export interface ResolveImagesInput {
  tenantId: string;
  poolId: string;
  families: string[];
}

export interface ResolveImagesOutput {
  poolId: string;
  provider: string;
  /** One per family that resolved, in the order asked (duplicates once). */
  items: ProviderImage[];
  /** Families with no image, or whose newest image is deprecated. */
  missing: ProviderImageMiss[];
}

export const imageSchemas = {
  resolve: strictObject(
    {
      tenantId: {
        type: 'string',
        pattern: '^[A-Za-z0-9._:-]{1,128}$',
        maxLength: 128,
        description: 'The tenant the call acts in',
      },
      poolId: {
        type: 'string',
        pattern: '^pool_[0-9a-hjkmnp-tv-z]{26,52}$',
        maxLength: 57,
        description: 'A provider pool the tenant owns or is offered',
      },
      families: {
        type: 'array',
        minItems: 1,
        maxItems: maxImageFamilies,
        items: {
          type: 'string',
          pattern: familyPattern.source,
          maxLength: 200,
          description:
            "An image family (ubuntu-2404-lts-amd64, in the account's imageProject), project/family, or projects/<project>/global/images/family/<family>",
        },
        description: `The families, at most ${maxImageFamilies}`,
      },
    },
    ['tenantId', 'poolId', 'families'],
  ),
};

export function parseResolveImages(raw: unknown): ResolveImagesInput {
  const input = object(raw, ['tenantId', 'poolId', 'families']);
  if (
    !Array.isArray(input.families) ||
    input.families.length === 0 ||
    input.families.length > maxImageFamilies
  )
    fail(`families must list 1 to ${maxImageFamilies} image families`);
  const families = input.families.map((family, index) => {
    if (typeof family !== 'string' || !familyPattern.test(family))
      fail(`families[${index}] is not an image family`);
    return family;
  });
  return {
    tenantId: tenant(input.tenantId),
    poolId: id(input.poolId, 'pool', 'poolId'),
    families: [...new Set(families)],
  };
}

export interface ImageDeps extends ClientDeps {
  clients: ProviderClients;
}

/**
 * Resolves `families` on the pool's provider account. Runs with no transaction open (the provider is called over
 * the network): `sql` is the read-only connection of a manual read.
 */
export async function resolvePoolImages(
  deps: ImageDeps,
  sql: SqlTx,
  input: ResolveImagesInput,
  signal: AbortSignal,
): Promise<ResolveImagesOutput> {
  const pool = await visibleVpsPool(sql, input.tenantId, input.poolId);
  if (pool.class !== 'provider')
    throw new ComputeError(
      'INVALID_INPUT',
      `Pool ${pool.id} is ${pool.class}: images resolve on provider pools`,
    );
  // R1: only an account of the pool's owner tenant drives the pool (visibleVpsPool leaves any other out).
  const account = pool.providerAccountId
    ? await readPoolAccount(sql, pool.providerAccountId, pool.id)
    : undefined;
  if (!account)
    throw new ComputeError('INVALID_STATE', `Provider pool ${pool.id} has no provider account`);
  const client = await deps.clients.client(account, deps);
  if (!client.images)
    throw new ComputeError(
      'UNSUPPORTED',
      `Provider ${account.provider} does not resolve image families`,
      undefined,
      { provider: account.provider },
    );
  const call: CallContext = {
    idempotencyKey: `images:${account.id}`,
    signal: AbortSignal.any([signal, AbortSignal.timeout(resolveBudgetMs)]),
    clock: deps.clock,
    secrets: deps.secrets,
    log: deps.log,
  };
  const resolved = await client.images.resolve(input.families, call);
  return {
    poolId: pool.id,
    provider: account.provider,
    items: resolved.items,
    missing: resolved.missing,
  };
}
