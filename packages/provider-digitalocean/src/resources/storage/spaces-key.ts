import { field, manifest, type CallContext } from '@better-compute/core';
import type { DoClient } from '../../client/http.js';
import {
  checkManagedName,
  hasCode,
  managedResourceName,
  notManaged,
  storageError,
  type DoResourceKind,
  type DoResourceState,
} from './kind.js';

// `do.spaces-key`: a Spaces access key with per-bucket grants (`/v2/spaces/keys`). The access key
// id is the resource id and a plain output (an identifier, as AWS treats key ids); the secret key
// is a secret output, returned once by the `ensure` that creates the key and never again (DO shows
// it only at creation). Keys carry no tags, so ownership is the managed name (`bc-…`, DO-D4):
// `delete` refuses a key without one.

/** `<bucket>:read`, `<bucket>:readwrite`, or `*:fullaccess` (every bucket of the account). */
export const spacesGrantPattern =
  /^(?:[a-z0-9][a-z0-9-]{1,61}[a-z0-9]:(?:read|readwrite)|\*:fullaccess)$/;

export const spacesKeySpec = manifest({
  grants: field
    .list(field.string({ pattern: spacesGrantPattern }), { min: 1, max: 50 })
    .describe(
      'What the key may do: <bucket>:read, <bucket>:readwrite, or *:fullaccess for every bucket',
    ),
});

export interface SpacesKeySpec {
  grants: string[];
}

interface DoGrant {
  bucket: string;
  permission: 'read' | 'readwrite' | 'fullaccess';
}

interface DoSpacesKey {
  name: string;
  access_key: string;
  secret_key?: string;
  grants?: DoGrant[];
  created_at?: string;
}

function toGrants(grants: readonly string[]): DoGrant[] {
  const unique = [...new Set(grants)].sort();
  return unique.map((grant) => {
    const [bucket, permission] = grant.split(':') as [string, DoGrant['permission']];
    return { bucket: bucket === '*' ? '' : bucket, permission };
  });
}

const grantKey = (grants: readonly DoGrant[] | undefined): string =>
  (grants ?? [])
    .map((g) => `${g.bucket || '*'}:${g.permission}`)
    .sort()
    .join(',');

const outputsOf = (key: DoSpacesKey) => ({
  accessKeyId: key.access_key,
  name: key.name,
  grants: grantKey(key.grants),
});

/** The key's grants in the spec's shape; undefined for a key without any (not a valid spec). */
function specOf(key: DoSpacesKey): { grants: string[] } | undefined {
  const grants = grantKey(key.grants);
  return grants ? { grants: grants.split(',') } : undefined;
}

function state(key: DoSpacesKey, secret?: string): DoResourceState {
  return {
    id: key.access_key,
    state: 'ready',
    outputs: outputsOf(key),
    ...(secret !== undefined ? { secretOutputs: { secretKey: secret } } : {}),
  };
}

const accessKeyPattern = /^[A-Za-z0-9]{8,128}$/;

function checkAccessKey(id: string): void {
  if (!accessKeyPattern.test(id))
    throw storageError('INVALID_INPUT', 'Not a Spaces access key id', 'accessKey');
}

export function spacesKeyKind(client: DoClient): DoResourceKind<SpacesKeySpec> {
  async function byName(name: string, signal: AbortSignal): Promise<DoSpacesKey | undefined> {
    let found: DoSpacesKey | undefined;
    for await (const key of client.pages<DoSpacesKey>('/spaces/keys', 'keys', {
      signal,
      budget: 'sweep',
    }))
      // Two keys with one name (a create retried after its answer was lost): the oldest wins.
      if (key.name === name && (!found || (key.created_at ?? '') < (found.created_at ?? '')))
        found = key;
    return found;
  }

  async function read(id: string, signal: AbortSignal): Promise<DoSpacesKey | undefined> {
    checkAccessKey(id);
    try {
      const reply = await client.request<{ key: DoSpacesKey }>('GET', `/spaces/keys/${id}`, {
        signal,
        budget: 'observe',
      });
      return reply.key;
    } catch (error) {
      if (hasCode(error, 'NOT_FOUND')) return undefined;
      throw error;
    }
  }

  return {
    kind: 'do.spaces-key',
    family: 'storage',
    description: 'A Spaces access key with per-bucket read or read-write grants (its secret is a secret output)',
    spec: spacesKeySpec as unknown as DoResourceKind<SpacesKeySpec>['spec'],
    outputs: ['accessKeyId', 'name', 'grants'],
    secretOutputs: ['secretKey'],
    regional: false,
    updatable: ['grants'],

    async ensure({ name, spec, id }, ctx: CallContext) {
      checkManagedName(name, 'A Spaces key');
      const grants = toGrants(spec.grants);
      // The key an earlier ensure answered wins over the name; one gone is created again.
      const existing = (id !== undefined ? await read(id, ctx.signal) : undefined) ?? (await byName(name, ctx.signal));
      // Keys are owned by their bc- names: an id naming another key changes nothing.
      if (existing && !managedResourceName.test(existing.name))
        throw notManaged(`Spaces key ${existing.access_key} is not one better-compute manages; it was left alone`);
      if (!existing) {
        const created = await client.request<{ key: DoSpacesKey }>('POST', '/spaces/keys', {
          body: { name, grants },
          signal: ctx.signal,
          budget: 'mutate',
        });
        if (!created.key.secret_key)
          throw storageError(
            'PROVIDER_ERROR',
            'DigitalOcean created a Spaces key without returning its secret',
            'badBody',
          );
        ctx.log.info('digitalocean.spaces-key.created', { name });
        return state(created.key, created.key.secret_key);
      }
      if (grantKey(existing.grants) === grantKey(grants)) return state(existing);
      const updated = await client.request<{ key: DoSpacesKey }>(
        'PUT',
        `/spaces/keys/${existing.access_key}`,
        { body: { name: existing.name, grants }, signal: ctx.signal, budget: 'mutate' },
      );
      return state(updated.key);
    },

    async get(id, ctx) {
      const key = await read(id, ctx.signal);
      if (!key) return undefined;
      const spec = specOf(key);
      return { ...state(key), ...(spec ? { spec } : {}) };
    },

    async delete(id, ctx) {
      const key = await read(id, ctx.signal);
      if (!key) return { id, state: 'deleted' };
      if (!managedResourceName.test(key.name))
        throw notManaged(`Spaces key ${id} is not one better-compute manages; it was left alone`);
      try {
        await client.request('DELETE', `/spaces/keys/${id}`, {
          signal: ctx.signal,
          budget: 'mutate',
        });
      } catch (error) {
        if (!hasCode(error, 'NOT_FOUND')) throw error;
      }
      return { id, state: 'deleted' };
    },

    async *discover(ctx) {
      for await (const key of client.pages<DoSpacesKey>('/spaces/keys', 'keys', {
        signal: ctx.signal,
        budget: 'sweep',
      })) {
        const spec = specOf(key);
        yield {
          id: key.access_key,
          name: key.name,
          // Keys carry no tags: a managed name is all there is (another deployment's looks the same).
          ...(managedResourceName.test(key.name) ? { managedBy: 'this' as const } : {}),
          outputs: outputsOf(key),
          ...(spec ? { spec } : {}),
        };
      }
    },
  };
}
