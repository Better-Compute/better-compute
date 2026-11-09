import { field, manifest, type CallContext } from '@better-compute/core';
import type { DoClient } from '../../client/http.js';
import { spacesBucketPattern, spacesRegionPattern, type SpacesClient } from '../../spaces/s3.js';
import {
  hasCode,
  storageError,
  type DoResourceKind,
  type DoResourceState,
  type ManagedNames,
} from './kind.js';
import { bucketOwnership, otherTenant, readMarker, sameTenant } from './spaces-bucket.js';

// `do.cdn-endpoint`: DigitalOcean's CDN in front of a Spaces bucket (`/v2/cdn/endpoints`). The
// origin must be a bucket this deployment manages, on `ensure` and on `delete`: endpoints carry
// no names or tags, so the origin bucket is what ties one to better-compute. For `delete` and
// `purge` that is the bucket's name (this deployment's prefix, which a tenant cannot change) or
// its marker (an adopted bucket), so a tenant that deletes its bucket's marker never makes the
// endpoint undeletable; `ensure` and `adopt` also need the marker, for its tenant. DO allows one endpoint per origin, which is what makes `ensure`
// idempotent: it looks the endpoint up by origin.
//
// An endpoint lives in its origin bucket (`parent: 'do.spaces-bucket'`): `ensure` requires the
// request's `parent`, the dispatcher's own tenant-scoped bucket row, and it must be the bucket the
// origin names (`<region>/<bucket>`). The bucket's marker must also name the request's tenant, so
// one tenant never fronts, takes over (by origin), repoints or purges another tenant's bucket.

/** The TTLs (seconds) DigitalOcean's CDN accepts. */
export const cdnTtls = [60, 600, 3600, 86_400, 604_800] as const;

const originPattern = new RegExp(
  `^(${spacesBucketPattern.source.slice(1, -1)})\\.(${spacesRegionPattern.source.slice(1, -1)})\\.digitaloceanspaces\\.com$`,
);
const hostnamePattern =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const cdnEndpointSpec = manifest({
  origin: field
    .string({ pattern: originPattern })
    .describe(
      'The Spaces origin: <bucket>.<region>.digitaloceanspaces.com, a bucket better-compute manages',
    ),
  ttl: field
    .int({ min: 60, max: 604_800 })
    .default(3600)
    .describe('Cache lifetime in seconds: 60, 600, 3600, 86400 or 604800'),
  customDomain: field
    .string({ pattern: hostnamePattern })
    .optional()
    .describe('A custom hostname for the endpoint; needs certificateId'),
  certificateId: field
    .string({ pattern: uuidPattern })
    .optional()
    .describe('The DigitalOcean certificate (uuid) that covers customDomain'),
});

export interface CdnEndpointSpec {
  origin: string;
  ttl: number;
  customDomain?: string;
  certificateId?: string;
}

interface DoCdnEndpoint {
  id: string;
  origin: string;
  endpoint: string;
  ttl?: number;
  custom_domain?: string;
  certificate_id?: string;
  created_at?: string;
}

export interface CdnEndpointKind extends DoResourceKind<CdnEndpointSpec> {
  /** Purges cached files (paths, `*` wildcards allowed) of a managed endpoint. */
  purge(id: string, files: readonly string[], context: CallContext): Promise<void>;
}

function state(endpoint: DoCdnEndpoint): DoResourceState {
  return {
    id: endpoint.id,
    state: 'ready',
    outputs: {
      origin: endpoint.origin,
      endpoint: endpoint.endpoint,
      url: `https://${endpoint.custom_domain || endpoint.endpoint}`,
      ttl: String(endpoint.ttl ?? 3600),
      ...(endpoint.custom_domain ? { customDomain: endpoint.custom_domain } : {}),
    },
  };
}

function checkId(id: string): void {
  if (!uuidPattern.test(id))
    throw storageError('INVALID_INPUT', 'Not a CDN endpoint id', 'cdnEndpointId');
}

export function cdnEndpointKind(deps: {
  client: DoClient;
  spaces: (region: string) => SpacesClient;
  deploymentTag: string;
  /** This deployment's names: a bucket with its prefix is a managed origin by its name alone. */
  names: ManagedNames;
}): CdnEndpointKind {
  const { client } = deps;

  async function originOwner(
    origin: string,
    signal: AbortSignal,
  ): Promise<'mine' | 'missing' | 'other'> {
    const match = originPattern.exec(origin);
    if (!match)
      throw storageError('INVALID_INPUT', `${origin} is not a Spaces origin`, 'origin');
    // The name proves a bucket ensure made; only an adopted bucket's ownership is its marker.
    if (deps.names.owner(match[1]!) === 'this') return 'mine';
    const marked = await bucketOwnership(
      deps.spaces(match[2]!),
      match[1]!,
      deps.deploymentTag,
      signal,
    );
    return marked === 'missing' && deps.names.owner(match[1]!) === 'other' ? 'other' : marked;
  }

  /**
   * Refuses (the contract's `notManaged`) an endpoint whose origin is not a bucket this deployment
   * manages. (`ensure` checks its origin itself, with reason `unmanagedOrigin`.)
   */
  async function requireManagedOrigin(origin: string, signal: AbortSignal): Promise<void> {
    if ((await originOwner(origin, signal)) !== 'mine')
      throw storageError(
        'INVALID_STATE',
        `The CDN origin ${origin} is not a bucket better-compute manages`,
        'notManaged',
      );
  }

  const specOf = (endpoint: DoCdnEndpoint) => ({
    origin: endpoint.origin,
    ttl: endpoint.ttl ?? 3600,
    ...(endpoint.custom_domain ? { customDomain: endpoint.custom_domain } : {}),
    ...(endpoint.certificate_id ? { certificateId: endpoint.certificate_id } : {}),
  });

  async function read(id: string, signal: AbortSignal): Promise<DoCdnEndpoint | undefined> {
    checkId(id);
    try {
      return (
        await client.request<{ endpoint: DoCdnEndpoint }>('GET', `/cdn/endpoints/${id}`, {
          signal,
          budget: 'observe',
        })
      ).endpoint;
    } catch (error) {
      if (hasCode(error, 'NOT_FOUND')) return undefined;
      throw error;
    }
  }

  return {
    kind: 'do.cdn-endpoint',
    family: 'edge',
    description:
      "DigitalOcean's CDN in front of a Spaces bucket this deployment manages, with an optional custom domain",
    spec: cdnEndpointSpec as unknown as DoResourceKind<CdnEndpointSpec>['spec'],
    outputs: ['origin', 'endpoint', 'url', 'ttl', 'customDomain'],
    regional: false,
    updatable: ['ttl', 'customDomain', 'certificateId'],
    parent: 'do.spaces-bucket',
    // A certificate is an object of the whole account, named by its raw uuid: on a shared account
    // it may be another tenant's, so only the tenant's own account may name one (and so a custom domain).
    accountWide: (spec) => [
      ...(spec?.certificateId !== undefined ? ['certificateId'] : []),
      ...(spec?.customDomain !== undefined ? ['customDomain'] : []),
    ],

    async ensure({ spec, id, parent, labels }, ctx: CallContext) {
      if (!(cdnTtls as readonly number[]).includes(spec.ttl))
        throw storageError(
          'INVALID_INPUT',
          `ttl must be one of ${cdnTtls.join(', ')} seconds`,
          'ttl',
        );
      if (!spec.customDomain !== !spec.certificateId)
        throw storageError(
          'INVALID_INPUT',
          'customDomain and certificateId are set together or not at all',
          'customDomain',
        );
      const match = originPattern.exec(spec.origin)!;
      const bucketId = `${match[2]}/${match[1]}`;
      // The parent is the caller's own bucket row: without it nothing says the origin is theirs.
      if (parent === undefined)
        throw storageError(
          'INVALID_INPUT',
          'A CDN endpoint lives in its origin bucket: the request names it as its parent',
          'parent',
        );
      if (parent !== bucketId)
        throw storageError(
          'INVALID_INPUT',
          `The endpoint's origin is bucket ${bucketId} but it lives in ${parent}`,
          'parent',
        );
      const marker = await readMarker(
        deps.spaces(match[2]!),
        match[1]!,
        deps.deploymentTag,
        ctx.signal,
      );
      if (marker.owner !== 'mine')
        throw storageError(
          'INVALID_STATE',
          `The CDN origin ${spec.origin} is not a bucket better-compute manages`,
          'unmanagedOrigin',
        );
      if (!sameTenant(marker, labels)) otherTenant(`The CDN origin ${spec.origin}`);
      // The endpoint an earlier ensure answered wins; its origin cannot change in place.
      let existing = id !== undefined ? await read(id, ctx.signal) : undefined;
      if (existing && existing.origin !== spec.origin)
        throw storageError(
          'INVALID_STATE',
          `CDN endpoint ${existing.id} serves ${existing.origin}; an origin cannot change in place`,
          'replaceRequired',
        );
      if (!existing)
        for await (const endpoint of client.pages<DoCdnEndpoint>('/cdn/endpoints', 'endpoints', {
          signal: ctx.signal,
          budget: 'sweep',
        }))
          if (endpoint.origin === spec.origin) existing = endpoint;
      const wanted = {
        ttl: spec.ttl,
        ...(spec.customDomain
          ? { custom_domain: spec.customDomain, certificate_id: spec.certificateId }
          : {}),
      };
      if (!existing) {
        const created = await client.request<{ endpoint: DoCdnEndpoint }>(
          'POST',
          '/cdn/endpoints',
          { body: { origin: spec.origin, ...wanted }, signal: ctx.signal, budget: 'mutate' },
        );
        ctx.log.info('digitalocean.cdn-endpoint.created', { origin: spec.origin });
        return state(created.endpoint);
      }
      const drift =
        (existing.ttl ?? 3600) !== spec.ttl ||
        (existing.custom_domain || undefined) !== spec.customDomain ||
        (existing.certificate_id || undefined) !== spec.certificateId;
      if (!drift) return state(existing);
      const updated = await client.request<{ endpoint: DoCdnEndpoint }>(
        'PUT',
        `/cdn/endpoints/${existing.id}`,
        {
          // An empty custom_domain removes the custom domain.
          body: spec.customDomain ? wanted : { ttl: spec.ttl, custom_domain: '' },
          signal: ctx.signal,
          budget: 'mutate',
        },
      );
      return state(updated.endpoint);
    },

    // A create whose answer was lost: the endpoint of the request's origin (DO allows one per
    // origin, which is how ensure finds it), when the origin is a bucket this deployment manages.
    async find({ spec }, ctx) {
      if ((await originOwner(spec.origin, ctx.signal)) !== 'mine') return undefined;
      for await (const endpoint of client.pages<DoCdnEndpoint>('/cdn/endpoints', 'endpoints', {
        signal: ctx.signal,
        budget: 'sweep',
      }))
        if (endpoint.origin === spec.origin) return endpoint.id;
      return undefined;
    },

    async get(id, ctx) {
      const endpoint = await read(id, ctx.signal);
      return endpoint ? { ...state(endpoint), spec: specOf(endpoint) } : undefined;
    },

    async adopt(id, labels, ctx) {
      // Endpoints carry no labels: one in front of a bucket this deployment manages is already
      // its own, and the row adopt makes serves delete and purge, so the origin bucket's marker
      // must name the caller's tenant (none: the operator's), as ensure requires.
      const endpoint = await read(id, ctx.signal);
      if (!endpoint)
        throw storageError('NOT_FOUND', `CDN endpoint ${id} not found`, 'cdnEndpoint');
      const match = originPattern.exec(endpoint.origin);
      const marker = match
        ? await readMarker(deps.spaces(match[2]!), match[1]!, deps.deploymentTag, ctx.signal)
        : undefined;
      if (marker?.owner !== 'mine')
        throw storageError(
          'INVALID_STATE',
          `The CDN origin ${endpoint.origin} is not a bucket better-compute manages`,
          'notManaged',
        );
      if (!sameTenant(marker, labels)) otherTenant(`The CDN origin ${endpoint.origin}`);
      return { ...state(endpoint), spec: specOf(endpoint) };
    },

    async delete(id, ctx) {
      const endpoint = await read(id, ctx.signal);
      if (!endpoint) return { id, state: 'deleted' };
      await requireManagedOrigin(endpoint.origin, ctx.signal);
      try {
        await client.request('DELETE', `/cdn/endpoints/${id}`, {
          signal: ctx.signal,
          budget: 'mutate',
        });
      } catch (error) {
        if (!hasCode(error, 'NOT_FOUND')) throw error;
      }
      return { id, state: 'deleted' };
    },

    async purge(id, files, ctx) {
      if (files.length === 0 || files.length > 50 || files.some((f) => !f || f.length > 1024))
        throw storageError('INVALID_INPUT', 'Purge 1 to 50 paths', 'purgeFiles');
      const endpoint = await read(id, ctx.signal);
      if (!endpoint)
        throw storageError('NOT_FOUND', `CDN endpoint ${id} not found`, 'cdnEndpoint');
      await requireManagedOrigin(endpoint.origin, ctx.signal);
      await client.request('DELETE', `/cdn/endpoints/${id}/cache`, {
        body: { files },
        signal: ctx.signal,
        budget: 'mutate',
      });
    },

    async *discover(ctx) {
      for await (const endpoint of client.pages<DoCdnEndpoint>('/cdn/endpoints', 'endpoints', {
        signal: ctx.signal,
        budget: 'sweep',
      })) {
        const owner = originPattern.test(endpoint.origin)
          ? await originOwner(endpoint.origin, ctx.signal)
          : 'missing';
        yield {
          id: endpoint.id,
          name: endpoint.origin,
          ...(owner === 'mine' ? { managedBy: 'this' as const } : {}),
          ...(owner === 'other' ? { managedBy: 'other' as const } : {}),
          outputs: state(endpoint).outputs!,
          spec: specOf(endpoint),
        };
      }
    },
  };
}
