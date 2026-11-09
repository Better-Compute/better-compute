import { field, isComputeError, manifest, type CallContext } from '@better-compute/core';
import type { DoClient } from '../../client/http.js';
import type { SpacesClient } from '../../spaces/s3.js';
import {
  hasCode,
  storageError,
  type DoResourceKind,
  type DoResourceState,
  type ManagedNames,
} from './kind.js';
import { otherTenant, readMarker, sameTenant } from './spaces-bucket.js';

// `do.spaces-key`: a Spaces access key with per-bucket grants (`/v2/spaces/keys`). The access key
// id is the resource id and a plain output (an identifier, as AWS treats key ids); the secret key
// is a secret output, returned once by the `ensure` that creates the key and never again (DO shows
// it only at creation). Keys carry no tags, so ownership is the name, which carries the
// deployment (`bc-<deployment hash>-…`, DO-D4, DO-D16): `ensure` and `delete` refuse a key named
// for another deployment (`managedByAnother`) or for none (`notManaged`), and discovery reports
// another deployment's keys as `managedBy: 'other'`.
//
// Grants are tenant isolation. A grant names a bucket by its do.spaces-bucket id
// (`<region>/<bucket>:read|readwrite`), and before any create or regrant every granted bucket's
// marker must name this deployment and the request's own tenant (`better-compute-tenant`), so a
// tenant never mints a key for another tenant's bucket or the operator's. `*:fullaccess` (every
// bucket in the account) is refused unless the operator turns it on in code
// (`spacesKeyFullAccess`).
//
// A key is created only when the caller holds no id for it: one found by name alone is a create
// whose answer (and secret) was lost, so a fresh key is created, and every older key with the name
// is deleted, so the secret always comes back and no orphaned credential stays live. Only older
// keys go (by created_at, then access key), so two racing creates of one name never delete each
// other's key: the newest survives, and the run whose key was reaped makes a fresh one on its next
// pass (its recorded id reads as gone). An id is honoured only for the key of the request's own
// name: another key of this deployment (another resource's, maybe another tenant's) is refused.

/**
 * `<region>/<bucket>:read`, `<region>/<bucket>:readwrite`, or `*:fullaccess` (every bucket of the
 * account; operator-only).
 */
export const spacesGrantPattern =
  /^(?:[a-z]{3}[0-9]\/[a-z0-9][a-z0-9-]{1,61}[a-z0-9]:(?:read|readwrite)|\*:fullaccess)$/;

export const spacesKeySpec = manifest({
  grants: field
    .list(field.string({ pattern: spacesGrantPattern }), { min: 1, max: 50 })
    .describe(
      'What the key may do: <region>/<bucket>:read or :readwrite on a bucket of the same tenant',
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

interface Grant extends DoGrant {
  /** The bucket's region; absent for `*:fullaccess`. */
  region?: string;
}

function parseGrants(grants: readonly string[]): Grant[] {
  const unique = [...new Set(grants)].sort();
  return unique.map((grant) => {
    const colon = grant.lastIndexOf(':');
    const target = grant.slice(0, colon);
    const permission = grant.slice(colon + 1) as DoGrant['permission'];
    if (target === '*') return { bucket: '', permission };
    const [region, bucket] = target.split('/') as [string, string];
    return { region, bucket, permission };
  });
}

const toDoGrants = (grants: readonly Grant[]): DoGrant[] =>
  grants.map(({ bucket, permission }) => ({ bucket, permission }));

/** DigitalOcean's view of the grants (bucket names only: a key does not record regions). */
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

function state(key: DoSpacesKey, secret?: string): DoResourceState {
  return {
    id: key.access_key,
    state: 'ready',
    outputs: outputsOf(key),
    ...(secret !== undefined ? { secretOutputs: { secretKey: secret } } : {}),
  };
}

const accessKeyPattern = /^[A-Za-z0-9]{8,128}$/;

/**
 * Whether `key` was made before `than`: by created_at, then (a tie) by access key. A key whose
 * time does not read is never older, so it is left alone.
 */
function olderThan(key: DoSpacesKey, than: DoSpacesKey): boolean {
  if (key.access_key === than.access_key) return false;
  const a = Date.parse(key.created_at ?? '');
  const b = Date.parse(than.created_at ?? '');
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  return a < b || (a === b && key.access_key < than.access_key);
}

function checkAccessKey(id: string): void {
  if (!accessKeyPattern.test(id))
    throw storageError('INVALID_INPUT', 'Not a Spaces access key id', 'accessKey');
}

export function spacesKeyKind(deps: {
  client: DoClient;
  names: ManagedNames;
  /** The account's S3 client for a region: grants are checked against the buckets' markers. */
  spaces: (region: string) => SpacesClient;
  deploymentTag: string;
  /** Allows `*:fullaccess` grants (every bucket of the account). Operator code only; default off. */
  allowFullAccess?: boolean;
}): DoResourceKind<SpacesKeySpec> {
  const { client, names } = deps;

  async function namedKeys(name: string, signal: AbortSignal): Promise<DoSpacesKey[]> {
    const found: DoSpacesKey[] = [];
    for await (const key of client.pages<DoSpacesKey>('/spaces/keys', 'keys', {
      signal,
      budget: 'sweep',
    }))
      if (key.name === name) found.push(key);
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

  /**
   * Refuses (before any key is created or changed) a grant the caller may not hold: full access
   * without the operator option, or a bucket that is not this deployment's and the caller's tenant's.
   */
  async function authorize(
    grants: readonly Grant[],
    labels: Readonly<Record<string, string>> | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    for (const grant of grants) {
      if (grant.permission === 'fullaccess') {
        if (!deps.allowFullAccess)
          throw storageError(
            'ACCESS_DENIED',
            'A Spaces key with full access to every bucket is not allowed; grant buckets one by one',
            'fullAccess',
          );
        continue;
      }
      const marker = await readMarker(
        deps.spaces(grant.region!),
        grant.bucket,
        deps.deploymentTag,
        signal,
      );
      if (marker.owner !== 'mine')
        throw storageError(
          'ACCESS_DENIED',
          `Bucket ${grant.bucket} in ${grant.region} is not a bucket this deployment manages; no key may grant it`,
          'grantBucket',
        );
      if (!sameTenant(marker, labels)) otherTenant(`Bucket ${grant.bucket}`);
    }
  }

  /**
   * Deletes the keys with the name that are older than the survivor (a create retried after a lost
   * answer). Never a newer one: a racing create of the same name keeps its key, so one survives.
   */
  async function reap(name: string, survivor: DoSpacesKey, ctx: CallContext): Promise<void> {
    try {
      const keys = await namedKeys(name, ctx.signal);
      const self = keys.find((key) => key.access_key === survivor.access_key) ?? survivor;
      for (const key of keys) {
        if (!olderThan(key, self)) continue;
        try {
          await client.request('DELETE', `/spaces/keys/${key.access_key}`, {
            signal: ctx.signal,
            budget: 'mutate',
          });
          ctx.log.info('digitalocean.spaces-key.duplicate-deleted', { name });
        } catch (error) {
          if (!hasCode(error, 'NOT_FOUND')) throw error;
        }
      }
    } catch (error) {
      // The new key's secret must still reach the caller; the next create of the name reaps again.
      ctx.log.warn('digitalocean.spaces-key.reap-failed', {
        name,
        code: isComputeError(error) ? error.code : 'UNKNOWN',
      });
    }
  }

  return {
    kind: 'do.spaces-key',
    family: 'storage',
    description:
      "A Spaces access key with read or read-write grants on the tenant's own buckets (its secret is a secret output)",
    spec: spacesKeySpec as unknown as DoResourceKind<SpacesKeySpec>['spec'],
    outputs: ['accessKeyId', 'name', 'grants'],
    secretOutputs: ['secretKey'],
    regional: false,
    updatable: ['grants'],

    async ensure(request, ctx: CallContext) {
      const { spec, id, labels } = request;
      const name = names.provider(request.name, 'A Spaces key');
      const grants = parseGrants(spec.grants);
      await authorize(grants, labels, ctx.signal);
      // The key an earlier ensure answered (whose secret the caller sealed) is the one to keep.
      const existing = id !== undefined ? await read(id, ctx.signal) : undefined;
      // Keys are owned by their names: an id naming another key changes nothing.
      if (existing) {
        names.requireOwn(existing.name, 'Spaces key');
        // Nor one of this deployment made for another name (another resource's grants).
        if (existing.name !== name)
          throw storageError(
            'INVALID_STATE',
            `Spaces key ${existing.access_key} was made for another resource`,
            'idMismatch',
          );
      }
      const wanted = toDoGrants(grants);
      if (!existing) {
        const created = await client.request<{ key: DoSpacesKey }>('POST', '/spaces/keys', {
          body: { name, grants: wanted },
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
        await reap(name, created.key, ctx);
        return state(created.key, created.key.secret_key);
      }
      // DigitalOcean shows a key's secret once, at creation. A caller that holds none sealed (its seal
      // failed in the run that received it) has a key nobody can use: say so, rather than `ready`.
      if (request.secretOutputs !== undefined && !request.secretOutputs.includes('secretKey'))
        return {
          ...state(existing),
          state: 'error',
          message:
            'The secret of this Spaces key was never sealed and DigitalOcean does not show it again; delete the key and create a new one',
        };
      if (grantKey(existing.grants) === grantKey(wanted)) return state(existing);
      const updated = await client.request<{ key: DoSpacesKey }>(
        'PUT',
        `/spaces/keys/${existing.access_key}`,
        { body: { name: existing.name, grants: wanted }, signal: ctx.signal, budget: 'mutate' },
      );
      return state(updated.key);
    },

    // A create whose answer was lost: the newest key with the request's name (the one a retried
    // ensure would have kept), read-only.
    async find(request, ctx) {
      const name = names.provider(request.name, 'A Spaces key');
      const keys = await namedKeys(name, ctx.signal);
      return keys.find((key) => keys.every((other) => !olderThan(key, other)))?.access_key;
    },

    // A key records bucket names but not their regions, so its spec cannot be read back.
    async get(id, ctx) {
      const key = await read(id, ctx.signal);
      return key ? state(key) : undefined;
    },

    async delete(id, ctx) {
      const key = await read(id, ctx.signal);
      if (!key) return { id, state: 'deleted' };
      names.requireOwn(key.name, 'Spaces key');
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
        const owner = names.owner(key.name);
        yield {
          id: key.access_key,
          name: key.name,
          // Keys carry no tags: the name says which deployment manages one.
          ...(owner ? { managedBy: owner } : {}),
          outputs: outputsOf(key),
        };
      }
    },
  };
}
