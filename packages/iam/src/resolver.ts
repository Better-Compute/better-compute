// `resolveResource` for better-iam (PLAN.md §12.4). better-iam has no resolver composition, so compute's
// resolver answers its own prefixed types and hands every other type to the host's fallback.

import { IamError, type ResourceRef } from '@better-iam/core';
import { fleetResourceId } from '@better-compute/core';
import type { AuthzProjection } from './projection.js';

/** A resolved resource: the reference echoed back, plus attributes for `resource.*`. */
export type ResolvedResource = ResourceRef & { attributes?: Record<string, unknown> };
/** better-iam's `resolveResource` option. */
export type ResourceResolver = (reference: ResourceRef) => Promise<ResolvedResource>;

export interface ComputeResolverOptions {
  /** Default `compute-`. */
  typePrefix?: string;
  /** The IAM root tenant: `compute-fleet/global` resolves only there. A function is read per call. */
  rootTenantId?: string | (() => string | undefined);
  /** The host's own app types; without it, other types fail with `RESOURCE_RESOLVER_REQUIRED`. */
  hostFallback?: ResourceResolver;
}

/**
 * Resolves compute's types from the memory-resident projection. Rules:
 * - the result echoes `{tenantId, type, id}` exactly (anything else is `RESOURCE_MISMATCH` in better-iam);
 * - `compute-fleet/global` exists only in the root tenant, `compute-tenant/{t}` only in tenant `t`;
 * - a miss is `NOT_FOUND` (unaudited; it aborts an `authorizeMany` batch);
 * - a slow or failed lookup, or a projection that is not loaded yet, denies (P11);
 * - attributes are the row's, overlaid by its pending `extend` values, plus `ownerId`, `parentType`
 *   (prefixed) and `parentId`, which better-iam turns into `resource.parentRelations`.
 */
export function computeResolver(
  projection: AuthzProjection,
  options: ComputeResolverOptions = {},
): ResourceResolver {
  const prefix = options.typePrefix ?? 'compute-';
  const rootTenant = () =>
    typeof options.rootTenantId === 'function' ? options.rootTenantId() : options.rootTenantId;
  const notFound = () => new IamError('NOT_FOUND', 'Resource not visible in this tenant', 404);

  return async (reference) => {
    const { tenantId, type, id } = reference;
    if (!type.startsWith(prefix)) {
      if (options.hostFallback) return options.hostFallback(reference);
      throw new IamError('RESOURCE_RESOLVER_REQUIRED', 'No resolver for this resource type', 400);
    }
    const kind = type.slice(prefix.length);
    const echo = { tenantId, type, id };
    if (kind === 'fleet') {
      const root = rootTenant();
      if (root === undefined)
        throw new IamError('ACCESS_DENIED', 'The compute root tenant is not configured', 403);
      if (id !== fleetResourceId || tenantId !== root) throw notFound();
      return { ...echo, attributes: {} };
    }
    if (kind === 'tenant') {
      if (id !== tenantId) throw notFound();
      return { ...echo, attributes: {} };
    }

    const outcome = await projection.resolve(kind, id, tenantId);
    if (outcome.status === 'miss') throw notFound();
    if (outcome.status !== 'hit')
      throw new IamError(
        'ACCESS_DENIED',
        outcome.status === 'timeout'
          ? 'The compute resource lookup timed out'
          : 'The compute authz projection is not loaded yet',
        403,
      );
    const row = outcome.row;
    const attributes: Record<string, unknown> = { ...row.attributes, ...row.pending };
    if (row.ownerId !== undefined) attributes.ownerId = row.ownerId;
    if (row.parentType !== undefined)
      attributes.parentType = row.parentType.startsWith(prefix)
        ? row.parentType
        : `${prefix}${row.parentType}`;
    if (row.parentId !== undefined) attributes.parentId = row.parentId;
    return { ...echo, attributes };
  };
}
