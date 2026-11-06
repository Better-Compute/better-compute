import { field, manifest, type CallContext } from '@better-compute/core';
import { spacesRegionPattern, xmlValue, xmlValues, type SpacesClient } from '../../spaces/s3.js';
import { hasCode, storageError, type DoResourceKind, type DoResourceState } from './kind.js';

// `do.spaces-bucket`: a tenant Spaces bucket, managed over the S3 API with the account's Spaces
// key pair. Bucket names are global and untaggable, so ownership is a marker object
// (`.better-compute/owner`) naming this deployment: `ensure` never takes over a bucket without
// it (adopt is an explicit operation), and `delete` refuses a bucket without it, or with anything
// in it besides the marker. Tenant data is never deleted to delete a bucket.

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
  const response = await s3.request('GET', bucket, bucketMarkerKey, { signal, allow: [404] });
  const text = await response.text();
  if (response.status === 404) return 'missing';
  try {
    const parsed = JSON.parse(text) as { managedBy?: unknown; deployment?: unknown };
    return parsed.managedBy === 'better-compute' && parsed.deployment === deploymentTag
      ? 'mine'
      : 'other';
  } catch {
    return 'other';
  }
}

export function spacesBucketKind(deps: {
  /** The account's S3 client for a region; throws INVALID_CONFIG when the account has no Spaces keys. */
  spaces: (region: string) => SpacesClient;
  deploymentTag: string;
}): DoResourceKind<SpacesBucketSpec> {
  const marker = new TextEncoder().encode(
    JSON.stringify({ managedBy: 'better-compute', deployment: deps.deploymentTag }),
  );

  async function head(s3: SpacesClient, bucket: string, signal: AbortSignal): Promise<number> {
    const response = await s3.request('HEAD', bucket, undefined, {
      signal,
      allow: [301, 403, 404],
    });
    return response.status;
  }

  const ownership = (s3: SpacesClient, bucket: string, signal: AbortSignal) =>
    bucketOwnership(s3, bucket, deps.deploymentTag, signal);

  function refuseOwnership(found: 'missing' | 'other', bucket: string): never {
    throw storageError(
      'INVALID_STATE',
      found === 'missing'
        ? `Bucket ${bucket} exists in this account but better-compute does not manage it; adopt it to manage it`
        : `Bucket ${bucket} is managed by another better-compute deployment`,
      found === 'missing' ? 'unmanaged' : 'otherDeployment',
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
    spec: spacesBucketSpec as unknown as DoResourceKind<SpacesBucketSpec>['spec'],
    outputs: ['bucket', 'region', 'endpoint', 'origin', 'acl', 'versioning'],
    regional: true,
    updatable: ['acl', 'versioning'],

    async ensure(name: string, spec: SpacesBucketSpec, ctx: CallContext) {
      const target = parseBucketId(`${spec.region}/${name}`);
      const s3 = deps.spaces(target.region);
      const status = await head(s3, target.bucket, ctx.signal);
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
        await s3.request('PUT', target.bucket, bucketMarkerKey, {
          body: marker,
          headers: { 'content-type': 'application/json' },
          signal: ctx.signal,
        });
        ctx.log.info('digitalocean.spaces-bucket.created', {
          bucket: target.bucket,
          region: target.region,
        });
        if (spec.versioning) await setVersioning(s3, target.bucket, 'Enabled', ctx.signal);
        return ready(target, { acl: spec.acl, versioning: spec.versioning ? 'enabled' : 'off' });
      }
      const owner = await ownership(s3, target.bucket, ctx.signal);
      if (owner !== 'mine') refuseOwnership(owner, target.bucket);
      return converge(s3, target, spec, ctx.signal);
    },

    async get(id, ctx) {
      const target = parseBucketId(id);
      const s3 = deps.spaces(target.region);
      const status = await head(s3, target.bucket, ctx.signal);
      if (status !== 200) return undefined;
      return ready(target, await observed(s3, target.bucket, ctx.signal));
    },

    async delete(id, ctx) {
      const target = parseBucketId(id);
      const s3 = deps.spaces(target.region);
      const status = await head(s3, target.bucket, ctx.signal);
      if (status === 404 || status === 403) return { id, state: 'deleted' };
      const owner = await ownership(s3, target.bucket, ctx.signal);
      if (owner !== 'mine') refuseOwnership(owner, target.bucket);
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
        // An object arrived between the listing and the delete: the bucket stays, marked as ours.
        if (hasCode(error, 'INVALID_STATE'))
          await s3.request('PUT', target.bucket, bucketMarkerKey, {
            body: marker,
            headers: { 'content-type': 'application/json' },
            signal: ctx.signal,
          });
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
