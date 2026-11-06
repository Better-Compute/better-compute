import { beforeEach, describe, expect, it } from 'vitest';
import { isComputeError, type ComputeError } from '@better-compute/core';
import { bucketMarkerKey, deploymentTag, resetBudgets } from '@better-compute/provider-digitalocean';
import { storageAccount, storageWorld } from './support/do-storage-harness.js';

// The `do.spaces-bucket` kind: tenant buckets over S3 with the account's Spaces keys. Ownership is
// a marker object; tenant data is never deleted to delete a bucket.

beforeEach(() => resetBudgets());

async function failure(promise: Promise<unknown>): Promise<ComputeError> {
  try {
    await promise;
  } catch (error) {
    if (isComputeError(error)) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

const markerBody = (deployment = 'default') =>
  new TextEncoder().encode(
    JSON.stringify({ managedBy: 'better-compute', deployment: deploymentTag(deployment) }),
  );

describe('do.spaces-bucket ensure', () => {
  it('creates a bucket with its marker, then converges acl and versioning in place', async () => {
    const w = await storageWorld();
    const created = await w.resources.ensure(
      'do.spaces-bucket',
      'tenant-a-assets',
      { region: 'nyc3' },
      w.ctx(),
    );
    expect(created).toEqual({
      id: 'nyc3/tenant-a-assets',
      state: 'ready',
      outputs: {
        bucket: 'tenant-a-assets',
        region: 'nyc3',
        endpoint: 'https://tenant-a-assets.nyc3.digitaloceanspaces.com',
        origin: 'tenant-a-assets.nyc3.digitaloceanspaces.com',
        acl: 'private',
        versioning: 'off',
      },
    });
    const bucket = w.spaces.buckets.get('tenant-a-assets')!;
    expect(bucket.objects.has(bucketMarkerKey)).toBe(true);

    const again = await w.resources.ensure(
      'do.spaces-bucket',
      'tenant-a-assets',
      { region: 'nyc3' },
      w.ctx(),
    );
    expect(again).toEqual(created);
    expect(w.spaces.requests.filter((r) => r.method === 'PUT')).toHaveLength(2);

    const changed = await w.resources.ensure(
      'do.spaces-bucket',
      'tenant-a-assets',
      { region: 'nyc3', acl: 'public-read', versioning: true },
      w.ctx(),
    );
    expect(changed.outputs).toMatchObject({ acl: 'public-read', versioning: 'enabled' });
    expect(bucket.acl).toBe('public-read');
    expect(bucket.versioning).toBe('Enabled');

    const off = await w.resources.ensure(
      'do.spaces-bucket',
      'tenant-a-assets',
      { region: 'nyc3' },
      w.ctx(),
    );
    expect(off.outputs).toMatchObject({ acl: 'private', versioning: 'suspended' });
  });

  it('creates a versioned bucket in one pass', async () => {
    const w = await storageWorld();
    const state = await w.resources.ensure(
      'do.spaces-bucket',
      'tenant-a-logs',
      { region: 'nyc3', versioning: true },
      w.ctx(),
    );
    expect(state.outputs?.versioning).toBe('enabled');
    expect(w.spaces.buckets.get('tenant-a-logs')!.versioning).toBe('Enabled');
  });

  it('refuses a name another account holds, and a bucket of ours it does not manage', async () => {
    const w = await storageWorld();
    w.spaces.seedBucket('taken-name', { owner: 'SOMEONEELSE' });
    const taken = await failure(
      w.resources.ensure('do.spaces-bucket', 'taken-name', { region: 'nyc3' }, w.ctx()),
    );
    expect(taken.code).toBe('CONFLICT');
    expect(taken.details?.reason).toBe('bucketNameTaken');

    const hand = w.spaces.seedBucket('hand-made');
    const unmanaged = await failure(
      w.resources.ensure('do.spaces-bucket', 'hand-made', { region: 'nyc3' }, w.ctx()),
    );
    expect(unmanaged.details?.reason).toBe('unmanaged');
    expect(hand.objects.size).toBe(0);

    const other = w.spaces.seedBucket('other-dep');
    other.objects.set(bucketMarkerKey, { body: markerBody('staging') });
    expect(
      (
        await failure(
          w.resources.ensure('do.spaces-bucket', 'other-dep', { region: 'nyc3' }, w.ctx()),
        )
      ).details?.reason,
    ).toBe('otherDeployment');
  });

  it('validates the name and spec before any request', async () => {
    const w = await storageWorld();
    for (const [name, spec] of [
      ['Bad_Name', { region: 'nyc3' }],
      ['ok-name', { region: 'NYC3' }],
      ['ok-name', { region: 'nyc3', acl: 'public-read-write' }],
      ['ok-name', {}],
    ] as const)
      expect(
        (await failure(w.resources.ensure('do.spaces-bucket', name, spec, w.ctx()))).code,
      ).toBe('INVALID_INPUT');
    expect(w.spaces.requests).toHaveLength(0);
  });

  it('fails closed without a Spaces key pair, and refuses half a pair', async () => {
    const { spacesAccessKey: _a, spacesSecretKey: _s, ...bare } = storageAccount;
    const w = await storageWorld(bare);
    const error = await failure(
      w.resources.ensure('do.spaces-bucket', 'tenant-a-assets', { region: 'nyc3' }, w.ctx()),
    );
    expect(error.code).toBe('INVALID_CONFIG');
    expect(error.details?.reason).toBe('spacesKeys');
    await expect(storageWorld({ ...bare, spacesAccessKey: 'secret://spaces/access' })).rejects.toThrow(
      /together/,
    );
  });

  it('never sends the secret key over the wire or into an error', async () => {
    const w = await storageWorld();
    await w.resources.ensure('do.spaces-bucket', 'tenant-a-assets', { region: 'nyc3' }, w.ctx());
    expect(JSON.stringify(w.spaces.requests)).not.toContain('spaces-secret');
  });
});

describe('do.spaces-bucket get and delete', () => {
  it('reads a bucket, and nothing for a gone one', async () => {
    const w = await storageWorld();
    await w.resources.ensure(
      'do.spaces-bucket',
      'tenant-a-assets',
      { region: 'nyc3', acl: 'public-read' },
      w.ctx(),
    );
    expect(
      (await w.resources.get('do.spaces-bucket', 'nyc3/tenant-a-assets', w.ctx()))?.outputs?.acl,
    ).toBe('public-read');
    expect(await w.resources.get('do.spaces-bucket', 'nyc3/nothing-here', w.ctx())).toBeUndefined();
    expect((await failure(w.resources.get('do.spaces-bucket', 'nothing-here', w.ctx()))).code).toBe(
      'INVALID_INPUT',
    );
  });

  it('deletes an empty managed bucket', async () => {
    const w = await storageWorld();
    await w.resources.ensure('do.spaces-bucket', 'tenant-a-assets', { region: 'nyc3' }, w.ctx());
    expect(await w.resources.delete('do.spaces-bucket', 'nyc3/tenant-a-assets', w.ctx())).toEqual({
      id: 'nyc3/tenant-a-assets',
      state: 'deleted',
    });
    expect(w.spaces.buckets.has('tenant-a-assets')).toBe(false);
    expect(
      (await w.resources.delete('do.spaces-bucket', 'nyc3/tenant-a-assets', w.ctx())).state,
    ).toBe('deleted');
  });

  it('deletes a versioned bucket, clearing the marker versions', async () => {
    const w = await storageWorld();
    await w.resources.ensure(
      'do.spaces-bucket',
      'tenant-a-logs',
      { region: 'nyc3', versioning: true },
      w.ctx(),
    );
    // The marker was rewritten once, so it has an old version too.
    const bucket = w.spaces.buckets.get('tenant-a-logs')!;
    bucket.noncurrent.set('v-old', { key: bucketMarkerKey, deleteMarker: false });
    expect((await w.resources.delete('do.spaces-bucket', 'nyc3/tenant-a-logs', w.ctx())).state).toBe(
      'deleted',
    );
    expect(w.spaces.buckets.has('tenant-a-logs')).toBe(false);
  });

  it('refuses to delete a bucket that holds tenant data, and keeps it', async () => {
    const w = await storageWorld();
    await w.resources.ensure('do.spaces-bucket', 'tenant-a-assets', { region: 'nyc3' }, w.ctx());
    const bucket = w.spaces.buckets.get('tenant-a-assets')!;
    bucket.objects.set('index.html', { body: new TextEncoder().encode('<h1>hi</h1>') });
    const refused = await failure(
      w.resources.delete('do.spaces-bucket', 'nyc3/tenant-a-assets', w.ctx()),
    );
    expect(refused.code).toBe('INVALID_STATE');
    expect(refused.details?.reason).toBe('bucketNotEmpty');
    expect(bucket.objects.has('index.html')).toBe(true);
    expect(bucket.objects.has(bucketMarkerKey)).toBe(true);
  });

  it('puts the marker back when an object lands between the check and the delete', async () => {
    const w = await storageWorld();
    await w.resources.ensure('do.spaces-bucket', 'tenant-a-assets', { region: 'nyc3' }, w.ctx());
    w.spaces.failNext('DELETE /tenant-a-assets$', 409, 'BucketNotEmpty');
    const refused = await failure(
      w.resources.delete('do.spaces-bucket', 'nyc3/tenant-a-assets', w.ctx()),
    );
    expect(refused.details?.reason).toBe('bucketNotEmpty');
    expect(w.spaces.buckets.get('tenant-a-assets')!.objects.has(bucketMarkerKey)).toBe(true);
  });

  it('refuses to delete a bucket it does not manage', async () => {
    const w = await storageWorld();
    w.spaces.seedBucket('hand-made');
    const refused = await failure(w.resources.delete('do.spaces-bucket', 'nyc3/hand-made', w.ctx()));
    expect(refused.details?.reason).toBe('unmanaged');
    expect(w.spaces.buckets.has('hand-made')).toBe(true);
  });
});
