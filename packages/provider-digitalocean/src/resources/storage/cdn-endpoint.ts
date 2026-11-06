import { field, manifest, type CallContext } from '@better-compute/core';
import type { DoClient } from '../../client/http.js';
import { spacesBucketPattern, spacesRegionPattern, type SpacesClient } from '../../spaces/s3.js';
import { hasCode, storageError, type DoResourceKind, type DoResourceState } from './kind.js';
import { bucketOwnership } from './spaces-bucket.js';

// `do.cdn-endpoint`: DigitalOcean's CDN in front of a Spaces bucket (`/v2/cdn/endpoints`). The
// origin must be a bucket this deployment manages (its marker object, see do.spaces-bucket), on
// `ensure` and on `delete`: endpoints carry no names or tags, so the origin bucket is what ties
// one to better-compute. DO allows one endpoint per origin, which is what makes `ensure`
// idempotent: it looks the endpoint up by origin.

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
}): CdnEndpointKind {
  const { client } = deps;

  async function requireManagedOrigin(origin: string, signal: AbortSignal): Promise<void> {
    const match = originPattern.exec(origin);
    if (!match)
      throw storageError('INVALID_INPUT', `${origin} is not a Spaces origin`, 'origin');
    const owner = await bucketOwnership(
      deps.spaces(match[2]!),
      match[1]!,
      deps.deploymentTag,
      signal,
    );
    if (owner !== 'mine')
      throw storageError(
        'INVALID_STATE',
        `The CDN origin ${origin} is not a bucket better-compute manages`,
        'unmanagedOrigin',
      );
  }

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
    spec: cdnEndpointSpec as unknown as DoResourceKind<CdnEndpointSpec>['spec'],
    outputs: ['origin', 'endpoint', 'url', 'ttl', 'customDomain'],
    regional: false,
    updatable: ['ttl', 'customDomain', 'certificateId'],

    async ensure(_name: string, spec: CdnEndpointSpec, ctx: CallContext) {
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
      await requireManagedOrigin(spec.origin, ctx.signal);
      let existing: DoCdnEndpoint | undefined;
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

    async get(id, ctx) {
      const endpoint = await read(id, ctx.signal);
      return endpoint ? state(endpoint) : undefined;
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
      }))
        yield { id: endpoint.id, name: endpoint.origin };
    },
  };
}
