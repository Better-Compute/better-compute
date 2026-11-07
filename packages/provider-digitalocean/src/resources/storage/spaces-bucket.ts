import { field, isComputeError, manifest, type CallContext } from '@better-compute/core';
import type { DoClient } from '../../client/http.js';
import { readCappedBytes } from '../../spaces/capped.js';
import { spacesRegionPattern, xmlValue, xmlValues, type SpacesClient } from '../../spaces/s3.js';
import {
  hasCode,
  managedByAnother,
  notManaged,
  storageError,
  type DoResourceKind,
  type DoResourceState,
  type ManagedNames,
} from './kind.js';

// `do.spaces-bucket`: a tenant Spaces bucket, managed over the S3 API with the account's Spaces
// key pair. Bucket names are global and untaggable. A bucket `ensure` creates is named for this
// deployment (`bc-<deployment hash>-…`, ManagedNames, like Spaces keys and registries), and that
// name is its proof of ownership: nothing a tenant can write changes it. The marker object
// (`.better-compute/owner`) sits inside the bucket, where the tenant's `readwrite` keys can delete
// or rewrite it, so it carries the tenant and resource for the tenant checks (and ownership of an
// adopted bucket, whose name is not ours). A tenant that breaks its marker loses its own access
// (every tenant check fails closed) but never makes its bucket, or the CDN endpoint in front of
// it, undeletable: `delete` of a bucket with this deployment's name proceeds without the marker.
// A bucket named for another deployment (another `bc-` prefix) is `managedByAnother` everywhere.
//
// `ensure` never takes over a bucket without the marker (adopt is an explicit operation), and
// `delete` refuses a bucket with anything in it besides the marker: tenant data is never deleted
// to delete a bucket. `adopt` writes the marker on an unmarked bucket (an operator call only,
// unless `allowTenantAdopt`); `release` removes it from an adopted bucket (a bucket with this
// deployment's name cannot be released: its name keeps it ours).
//
// The marker names the cloud resource and the tenant (`better-compute-resource`, `-tenant` from
// the request's labels): an ensure carrying another tenant's labels is refused, and
// `do.spaces-key` grants and `do.cdn-endpoint` origins are checked against it. Only a 404 means a
// bucket is gone: a 403 (a narrowed or revoked account key) fails closed, so a row is never dropped
// while its bucket stays up.

/** The object that marks a bucket as this deployment's. */
export const bucketMarkerKey = '.better-compute/owner';

export const spacesBucketSpec = manifest({
  region: field
    .string({ pattern: spacesRegionPattern })
    .describe('The Spaces region slug the bucket lives in (nyc3, ams3, sgp1, fra1, …)'),
  acl: field
    .option(['private', 'public-read'])
    .default('private')
    .describe('private, or public-read: anyone may list the bucket'),
  versioning: field
    .boolean()
    .default(false)
    .describe('Keep every version of every object (once enabled it can only be suspended)'),
});

export interface SpacesBucketSpec {
  region: string;
  acl: 'private' | 'public-read';
  versioning: boolean;
}

interface BucketTarget {
  region: string;
  bucket: string;
}

const allUsers = 'http://acs.amazonaws.com/groups/global/AllUsers';

export function parseBucketId(id: string): BucketTarget {
  const match = /^([a-z]{3}[0-9])\/([a-z0-9][a-z0-9-]{1,61}[a-z0-9])$/.exec(id);
  if (!match)
    throw storageError('INVALID_INPUT', `${JSON.stringify(id)} is not a bucket id (<region>/<bucket>)`, 'bucketId');
  return { region: match[1]!, bucket: match[2]! };
}

/** The most bytes of a marker object that are read. */
const maxMarkerBytes = 4096;

/** What a bucket's marker says: who manages it, and (for this deployment's) its tenant and resource. */
export interface BucketMarker {
  owner: 'mine' | 'missing' | 'other';
  tenant?: string;
  resource?: string;
  /** The marker's bytes, to put the same marker back. */
  body?: Uint8Array;
}

const tenantLabel = 'better-compute-tenant';
const resourceLabel = 'better-compute-resource';

/** A bucket's marker: who it names, and its bytes (to put the same marker back). */
export async function readMarker(
  s3: SpacesClient,
  bucket: string,
  deploymentTag: string,
  signal: AbortSignal,
): Promise<BucketMarker> {
  const response = await s3.request('GET', bucket, bucketMarkerKey, { signal, allow: [404] });
  if (response.status === 404) {
    await response.body?.cancel();
    return { owner: 'missing' };
  }
  // Anything in a bucket can be written by its key holders: a marker too big to be one is not read,
  // and a body without a (true) length is read only up to the cap.
  if (Number(response.headers.get('content-length') ?? 0) > maxMarkerBytes) {
    await response.body?.cancel();
    return { owner: 'other' };
  }
  const body = await readCappedBytes(response, maxMarkerBytes + 1);
  if (body.length > maxMarkerBytes) return { owner: 'other' };
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as {
      managedBy?: unknown;
      deployment?: unknown;
      tenant?: unknown;
      resource?: unknown;
    };
    if (parsed.managedBy !== 'better-compute' || parsed.deployment !== deploymentTag)
      return { owner: 'other' };
    return {
      owner: 'mine',
      body,
      ...(typeof parsed.tenant === 'string' ? { tenant: parsed.tenant } : {}),
      ...(typeof parsed.resource === 'string' ? { resource: parsed.resource } : {}),
    };
  } catch {
    return { owner: 'other' };
  }
}

/**
 * Who manages a bucket: `mine` (this deployment's marker), `missing` (no marker, or no bucket)
 * or `other` (another deployment's marker, or one that does not parse).
 */
export async function bucketOwnership(
  s3: SpacesClient,
  bucket: string,
  deploymentTag: string,
  signal: AbortSignal,
): Promise<'mine' | 'missing' | 'other'> {
  return (await readMarker(s3, bucket, deploymentTag, signal)).owner;
}

/**
 * Whether a marker of this deployment belongs to the caller's tenant: the tenants must be the same
 * (a marker without one is the operator's, so it matches only a call without one).
 */
export function sameTenant(
  marker: BucketMarker,
  labels: Readonly<Record<string, string>> | undefined,
): boolean {
  return marker.owner === 'mine' && marker.tenant === labels?.[tenantLabel];
}

/** The refusal of a resource another tenant owns. */
export function otherTenant(what: string): never {
  throw storageError('ACCESS_DENIED', `${what} belongs to another tenant`, 'otherTenant');
}

export function spacesBucketKind(deps: {
  /** The account's S3 client for a region; throws INVALID_CONFIG when the account has no Spaces keys. */
  spaces: (region: string) => SpacesClient;
  deploymentTag: string;
  /** This deployment's names: a created bucket is named with its prefix, which proves it ours. */
  names: ManagedNames;
  /** The account's DigitalOcean API client: a delete looks for CDN endpoints in front of the bucket. */
  client: DoClient;
  /**
   * Lets an `adopt` carrying a tenant label claim an unmarked bucket for that tenant. Off by
   * default: every unmarked bucket of the account is the operator's (its spacesBlobStore bucket,
   * say), so only an operator call (no tenant label) may adopt one. Operator code only.
   */
  allowTenantAdopt?: boolean;
}): DoResourceKind<SpacesBucketSpec> {
  /** The marker's bytes; it names the cloud resource when the caller passed its labels. */
  const markerFor = (labels?: Readonly<Record<string, string>>) =>
    new TextEncoder().encode(
      JSON.stringify({
        managedBy: 'better-compute',
        deployment: deps.deploymentTag,
        ...(labels?.[resourceLabel] ? { resource: labels[resourceLabel] } : {}),
        ...(labels?.[tenantLabel] ? { tenant: labels[tenantLabel] } : {}),
      }),
    );
  async function putMarker(
    s3: SpacesClient,
    bucket: string,
    body: Uint8Array,
    signal: AbortSignal,
  ): Promise<void> {
    await s3.request('PUT', bucket, bucketMarkerKey, {
      body,
      headers: { 'content-type': 'application/json' },
      signal,
    });
  }

  async function head(s3: SpacesClient, bucket: string, signal: AbortSignal): Promise<number> {
    const response = await s3.request('HEAD', bucket, undefined, {
      signal,
      allow: [301, 403, 404],
    });
    return response.status;
  }

  const ownership = (s3: SpacesClient, bucket: string, signal: AbortSignal) =>
    bucketOwnership(s3, bucket, deps.deploymentTag, signal);

  /** Refuses (nothing sent) a bucket named for another deployment. */
  function refuseForeignName(bucket: string): void {
    if (deps.names.owner(bucket) === 'other')
      throw managedByAnother(`Bucket ${bucket} is named for another better-compute deployment`);
  }

  /** Whether the bucket is there: only a 404 says no; a 403 or a 301 fails closed. */
  async function present(
    s3: SpacesClient,
    target: BucketTarget,
    signal: AbortSignal,
  ): Promise<boolean> {
    const status = await head(s3, target.bucket, signal);
    if (status === 404) return false;
    if (status === 403)
      throw storageError(
        'ACCESS_DENIED',
        `The account's Spaces key may not read bucket ${target.bucket}`,
        'spacesAccess',
      );
    if (status === 301)
      throw storageError('INVALID_STATE', `Bucket ${target.bucket} is in another region`, 'region');
    return true;
  }

  function refuseOwnership(found: 'missing' | 'other', bucket: string): never {
    if (found === 'missing')
      throw notManaged(
        `Bucket ${bucket} exists in this account but better-compute does not manage it; adopt it to manage it`,
      );
    throw storageError(
      'INVALID_STATE',
      `Bucket ${bucket} is managed by another better-compute deployment`,
      'managedByAnother',
    );
  }

  async function observed(
    s3: SpacesClient,
    bucket: string,
    signal: AbortSignal,
  ): Promise<{ acl: 'private' | 'public-read'; versioning: 'off' | 'enabled' | 'suspended' }> {
    const acl = await (await s3.request('GET', bucket, undefined, { query: { acl: '' }, signal })).text();
    const publicRead = xmlValues(acl, 'Grant').some(
      (grant) => grant.includes(allUsers) && xmlValue(grant, 'Permission') === 'READ',
    );
    const versioning = xmlValue(
      await (await s3.request('GET', bucket, undefined, { query: { versioning: '' }, signal })).text(),
      'Status',
    );
    return {
      acl: publicRead ? 'public-read' : 'private',
      versioning:
        versioning === 'Enabled' ? 'enabled' : versioning === 'Suspended' ? 'suspended' : 'off',
    };
  }

  /** The bucket's spec as Spaces reports it (a suspended versioning reads as off). */
  const specOf = (target: BucketTarget, seen: { acl: string; versioning: string }) => ({
    region: target.region,
    acl: seen.acl,
    versioning: seen.versioning === 'enabled',
  });

  function ready(
    target: BucketTarget,
    seen: { acl: string; versioning: string },
  ): DoResourceState {
    const host = `${target.bucket}.${target.region}.digitaloceanspaces.com`;
    return {
      id: `${target.region}/${target.bucket}`,
      state: 'ready',
      outputs: {
        bucket: target.bucket,
        region: target.region,
        endpoint: `https://${host}`,
        origin: host,
        acl: seen.acl,
        versioning: seen.versioning,
      },
    };
  }

  async function setVersioning(
    s3: SpacesClient,
    bucket: string,
    status: 'Enabled' | 'Suspended',
    signal: AbortSignal,
  ): Promise<void> {
    await s3.request('PUT', bucket, undefined, {
      query: { versioning: '' },
      headers: { 'content-type': 'application/xml' },
      body: new TextEncoder().encode(
        `<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>${status}</Status></VersioningConfiguration>`,
      ),
      signal,
    });
  }

  async function converge(
    s3: SpacesClient,
    target: BucketTarget,
    spec: SpacesBucketSpec,
    signal: AbortSignal,
  ): Promise<DoResourceState> {
    const seen = await observed(s3, target.bucket, signal);
    if (seen.acl !== spec.acl) {
      await s3.request('PUT', target.bucket, undefined, {
        query: { acl: '' },
        headers: { 'x-amz-acl': spec.acl },
        signal,
      });
      seen.acl = spec.acl;
    }
    if (spec.versioning && seen.versioning !== 'enabled') {
      await setVersioning(s3, target.bucket, 'Enabled', signal);
      seen.versioning = 'enabled';
    } else if (!spec.versioning && seen.versioning === 'enabled') {
      await setVersioning(s3, target.bucket, 'Suspended', signal);
      seen.versioning = 'suspended';
    }
    return ready(target, seen);
  }

  return {
    kind: 'do.spaces-bucket',
    family: 'storage',
    description: "A Spaces (S3-compatible) bucket, marked as this deployment's by an owner object",
    spec: spacesBucketSpec as unknown as DoResourceKind<SpacesBucketSpec>['spec'],
    outputs: ['bucket', 'region', 'endpoint', 'origin', 'acl', 'versioning'],
    regional: true,
    updatable: ['acl', 'versioning'],

    async ensure({ name, spec, id, labels }, ctx: CallContext) {
      // The bucket an earlier ensure (or an adopt) answered wins over the derived name, which
      // carries this deployment's prefix (the requested `bc-` name, through ManagedNames).
      const target = parseBucketId(
        id ?? `${spec.region}/${deps.names.provider(name, 'A Spaces bucket')}`,
      );
      refuseForeignName(target.bucket);
      if (target.region !== spec.region)
        throw storageError(
          'INVALID_STATE',
          `Bucket ${target.bucket} is in ${target.region}; a bucket cannot move regions`,
          'replaceRequired',
        );
      const s3 = deps.spaces(target.region);
      const status = await head(s3, target.bucket, ctx.signal);
      // For a bucket this account made (the caller holds its id), a 403 is a narrowed or revoked
      // account key, never a name another account took.
      if (status === 403 && id !== undefined)
        throw storageError(
          'ACCESS_DENIED',
          `The account's Spaces key may not read bucket ${target.bucket}`,
          'spacesAccess',
        );
      if (status === 403)
        throw storageError(
          'CONFLICT',
          `The bucket name ${target.bucket} is taken by another Spaces account`,
          'bucketNameTaken',
        );
      if (status === 301)
        throw storageError(
          'INVALID_STATE',
          `Bucket ${target.bucket} exists in another region`,
          'region',
        );
      if (status === 404) {
        // A racing create (ours or another account's) answers CONFLICT; the next pass sorts it out.
        await s3.request('PUT', target.bucket, undefined, {
          headers: { 'x-amz-acl': spec.acl },
          signal: ctx.signal,
        });
        // A create can answer 200 for a bucket the account already holds, which another
        // deployment may have made since the HEAD: the marker is written only where there is none.
        let owner: 'mine' | 'missing' | 'other';
        try {
          owner = await ownership(s3, target.bucket, ctx.signal);
          if (owner === 'missing') await putMarker(s3, target.bucket, markerFor(labels), ctx.signal);
        } catch (error) {
          // Left unmarked, the bucket would be refused as unmanaged on every later pass. It was
          // just made, so it is empty; S3 never deletes a bucket that is not.
          await s3
            .request('DELETE', target.bucket, undefined, { signal: ctx.signal, allow: [404] })
            .catch((rollback: unknown) =>
              ctx.log.warn('digitalocean.spaces-bucket.rollback-failed', {
                bucket: target.bucket,
                region: target.region,
                code: isComputeError(rollback) ? rollback.code : 'UNKNOWN',
              }),
            );
          throw error;
        }
        if (owner === 'other') refuseOwnership(owner, target.bucket);
        ctx.log.info('digitalocean.spaces-bucket.created', {
          bucket: target.bucket,
          region: target.region,
        });
        if (spec.versioning) await setVersioning(s3, target.bucket, 'Enabled', ctx.signal);
        return ready(target, { acl: spec.acl, versioning: spec.versioning ? 'enabled' : 'off' });
      }
      const marker = await readMarker(s3, target.bucket, deps.deploymentTag, ctx.signal);
      if (marker.owner !== 'mine') refuseOwnership(marker.owner, target.bucket);
      // An id or a name reaching another tenant's (or resource's) bucket changes nothing in it.
      const resource = labels?.[resourceLabel];
      if (
        !sameTenant(marker, labels) ||
        (marker.resource !== undefined && resource !== undefined && marker.resource !== resource)
      )
        otherTenant(`Bucket ${target.bucket}`);
      return converge(s3, target, spec, ctx.signal);
    },

    async get(id, ctx) {
      const target = parseBucketId(id);
      const s3 = deps.spaces(target.region);
      if (!(await present(s3, target, ctx.signal))) return undefined;
      const seen = await observed(s3, target.bucket, ctx.signal);
      return { ...ready(target, seen), spec: specOf(target, seen) };
    },

    async adopt(id, labels, ctx) {
      const target = parseBucketId(id);
      refuseForeignName(target.bucket);
      const s3 = deps.spaces(target.region);
      const status = await head(s3, target.bucket, ctx.signal);
      if (status === 301)
        throw storageError('INVALID_STATE', `Bucket ${target.bucket} is in another region`, 'region');
      if (status !== 200)
        throw storageError(
          'NOT_FOUND',
          `This account has no bucket ${target.bucket} in ${target.region}`,
          'bucket',
        );
      const marker = await readMarker(s3, target.bucket, deps.deploymentTag, ctx.signal);
      const owner = marker.owner;
      if (owner === 'other') refuseOwnership(owner, target.bucket);
      if (owner === 'mine' && !sameTenant(marker, labels)) otherTenant(`Bucket ${target.bucket}`);
      if (owner === 'missing') {
        // An unmarked bucket is the operator's until claimed: a tenant may not claim one (and so be
        // granted keys on it) unless the operator turned tenant adoption on in code.
        if (labels[tenantLabel] !== undefined && !deps.allowTenantAdopt)
          throw storageError(
            'ACCESS_DENIED',
            `Bucket ${target.bucket} is not managed by better-compute; only the operator may adopt it`,
            'tenantAdopt',
          );
        await putMarker(s3, target.bucket, markerFor(labels), ctx.signal);
        ctx.log.info('digitalocean.spaces-bucket.adopted', {
          bucket: target.bucket,
          region: target.region,
        });
      }
      const seen = await observed(s3, target.bucket, ctx.signal);
      return { ...ready(target, seen), spec: specOf(target, seen) };
    },

    async release(id, ctx) {
      const target = parseBucketId(id);
      refuseForeignName(target.bucket);
      // Its name keeps a bucket of this deployment ours whatever the marker says.
      if (deps.names.owner(target.bucket) === 'this')
        throw storageError(
          'UNSUPPORTED',
          `Bucket ${target.bucket} is owned by its name; it cannot be released`,
          'adopt',
        );
      const s3 = deps.spaces(target.region);
      if ((await head(s3, target.bucket, ctx.signal)) !== 200) return;
      const owner = await ownership(s3, target.bucket, ctx.signal);
      if (owner === 'missing') return;
      if (owner === 'other') refuseOwnership(owner, target.bucket);
      await s3.request('DELETE', target.bucket, bucketMarkerKey, {
        signal: ctx.signal,
        allow: [404],
      });
      ctx.log.info('digitalocean.spaces-bucket.released', {
        bucket: target.bucket,
        region: target.region,
      });
    },

    async delete(id, ctx) {
      const target = parseBucketId(id);
      refuseForeignName(target.bucket);
      const s3 = deps.spaces(target.region);
      if (!(await present(s3, target, ctx.signal))) return { id, state: 'deleted' };
      const found = await readMarker(s3, target.bucket, deps.deploymentTag, ctx.signal);
      // The name proves a bucket ensure made ours: a marker its tenant deleted or rewrote (or a
      // delete cut off after the marker went) does not keep it running.
      const ownName = deps.names.owner(target.bucket) === 'this';
      if (found.owner !== 'mine' && !ownName)
        throw notManaged(
          `Bucket ${target.bucket} is not one this deployment manages; it was left alone`,
        );
      if (found.owner !== 'mine')
        ctx.log.warn('digitalocean.spaces-bucket.marker-lost', {
          bucket: target.bucket,
          region: target.region,
          marker: found.owner,
        });
      // A CDN endpoint is this deployment's only through its origin's marker: deleting the bucket
      // under one would leave an endpoint nothing could delete.
      const origin = `${target.bucket}.${target.region}.digitaloceanspaces.com`;
      for await (const endpoint of deps.client.pages<{ id: string; origin?: string }>(
        '/cdn/endpoints',
        'endpoints',
        { signal: ctx.signal, budget: 'sweep' },
      ))
        if (endpoint.origin === origin)
          throw storageError(
            'INVALID_STATE',
            `Bucket ${target.bucket} is the origin of CDN endpoint ${endpoint.id}; delete the endpoint first`,
            'cdnEndpointAttached',
          );
      const listing = await (
        await s3.request('GET', target.bucket, undefined, {
          query: { 'list-type': '2', 'max-keys': '2' },
          signal: ctx.signal,
        })
      ).text();
      if (xmlValues(listing, 'Key').some((key) => key !== bucketMarkerKey))
        throw storageError(
          'INVALID_STATE',
          `Bucket ${target.bucket} still holds objects; empty it before deleting it`,
          'bucketNotEmpty',
        );
      const { versioning } = await observed(s3, target.bucket, ctx.signal);
      await s3.request('DELETE', target.bucket, bucketMarkerKey, {
        signal: ctx.signal,
        allow: [404],
      });
      if (versioning !== 'off') {
        // The marker's old versions (and the delete marker just made) keep a versioned bucket non-empty.
        const versions = await (
          await s3.request('GET', target.bucket, undefined, {
            query: { versions: '', prefix: bucketMarkerKey },
            signal: ctx.signal,
          })
        ).text();
        for (const entry of [
          ...xmlValues(versions, 'Version'),
          ...xmlValues(versions, 'DeleteMarker'),
        ]) {
          const versionId = xmlValue(entry, 'VersionId');
          if (xmlValue(entry, 'Key') !== bucketMarkerKey || !versionId) continue;
          await s3.request('DELETE', target.bucket, bucketMarkerKey, {
            query: { versionId },
            signal: ctx.signal,
            allow: [404],
          });
        }
      }
      try {
        await s3.request('DELETE', target.bucket, undefined, { signal: ctx.signal, allow: [404] });
      } catch (error) {
        // An object arrived between the listing and the delete, or the delete failed: the bucket
        // stays, marked as ours, so the next delete finds it managed. (A bucket whose marker was
        // lost is ours by its name; no marker is made up for it.)
        if (found.owner === 'mine' && found.body)
          await putMarker(s3, target.bucket, found.body, ctx.signal).catch((restore: unknown) =>
            ctx.log.warn('digitalocean.spaces-bucket.marker-restore-failed', {
              bucket: target.bucket,
              region: target.region,
              code: isComputeError(restore) ? restore.code : 'UNKNOWN',
            }),
          );
        throw error;
      }
      ctx.log.info('digitalocean.spaces-bucket.deleted', {
        bucket: target.bucket,
        region: target.region,
      });
      return { id, state: 'deleted' };
    },
  };
}
