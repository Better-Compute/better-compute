import { beforeEach, describe, expect, it } from 'vitest';
import { isComputeError, type ComputeError } from '@better-compute/core';
import { bucketMarkerKey, deploymentTag, resetBudgets } from '@better-compute/provider-digitalocean';
import { seedCdnEndpoint } from './support/do-emulator/cdn.js';
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
    const created = await w.ensure(
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

    const again = await w.ensure(
      'do.spaces-bucket',
      'tenant-a-assets',
      { region: 'nyc3' },
      w.ctx(),
    );
    expect(again).toEqual(created);
    expect(w.spaces.requests.filter((r) => r.method === 'PUT')).toHaveLength(2);

    const changed = await w.ensure(
      'do.spaces-bucket',
      'tenant-a-assets',
      { region: 'nyc3', acl: 'public-read', versioning: true },
      w.ctx(),
    );
    expect(changed.outputs).toMatchObject({ acl: 'public-read', versioning: 'enabled' });
    expect(bucket.acl).toBe('public-read');
    expect(bucket.versioning).toBe('Enabled');

    const off = await w.ensure(
      'do.spaces-bucket',
      'tenant-a-assets',
      { region: 'nyc3' },
      w.ctx(),
    );
    expect(off.outputs).toMatchObject({ acl: 'private', versioning: 'suspended' });
  });

  it('creates a versioned bucket in one pass', async () => {
    const w = await storageWorld();
    const state = await w.ensure(
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
      w.ensure('do.spaces-bucket', 'taken-name', { region: 'nyc3' }, w.ctx()),
    );
    expect(taken.code).toBe('CONFLICT');
    expect(taken.details?.reason).toBe('bucketNameTaken');

    const hand = w.spaces.seedBucket('hand-made');
    const unmanaged = await failure(
      w.ensure('do.spaces-bucket', 'hand-made', { region: 'nyc3' }, w.ctx()),
    );
    expect(unmanaged.details?.reason).toBe('notManaged');
    expect(hand.objects.size).toBe(0);

    const other = w.spaces.seedBucket('other-dep');
    other.objects.set(bucketMarkerKey, { body: markerBody('staging') });
    expect(
      (
        await failure(
          w.ensure('do.spaces-bucket', 'other-dep', { region: 'nyc3' }, w.ctx()),
        )
      ).details?.reason,
    ).toBe('managedByAnother');
  });

  it("records the tenant in the marker and refuses another tenant's ensure on the bucket", async () => {
    const w = await storageWorld();
    const labels = { 'better-compute-tenant': 'ten_a', 'better-compute-resource': 'res_a' };
    await w.ensure('do.spaces-bucket', 'tenant-a-assets', { region: 'nyc3' }, w.ctx(), { labels });
    const marker = JSON.parse(
      new TextDecoder().decode(w.spaces.buckets.get('tenant-a-assets')!.objects.get(bucketMarkerKey)!.body),
    );
    expect(marker).toEqual({
      managedBy: 'better-compute',
      deployment: deploymentTag('default'),
      resource: 'res_a',
      tenant: 'ten_a',
    });
    const before = w.spaces.requests.length;
    const refused = await failure(
      w.ensure('do.spaces-bucket', 'tenant-a-assets', { region: 'nyc3', acl: 'public-read' }, w.ctx(), {
        id: 'nyc3/tenant-a-assets',
        labels: { 'better-compute-tenant': 'ten_b', 'better-compute-resource': 'res_b' },
      }),
    );
    expect(refused.code).toBe('ACCESS_DENIED');
    expect(refused.details?.reason).toBe('otherTenant');
    expect(w.spaces.requests.slice(before).some((r) => r.method === 'PUT')).toBe(false);
    expect(w.spaces.buckets.get('tenant-a-assets')!.acl).toBe('private');
  });

  it('removes the bucket it just made when the marker cannot be written, so the next pass starts over', async () => {
    const w = await storageWorld();
    w.spaces.failNext(`PUT /tenant-a-assets/${bucketMarkerKey}`, 503, 'SlowDown');
    const error = await failure(
      w.ensure('do.spaces-bucket', 'tenant-a-assets', { region: 'nyc3' }, w.ctx()),
    );
    expect(error.code).toBe('RATE_LIMITED');
    // Left in place, an unmarked bucket would be refused as unmanaged on every later pass.
    expect(w.spaces.buckets.has('tenant-a-assets')).toBe(false);
    const again = await w.ensure('do.spaces-bucket', 'tenant-a-assets', { region: 'nyc3' }, w.ctx());
    expect(again.state).toBe('ready');
    expect(w.spaces.buckets.get('tenant-a-assets')!.objects.has(bucketMarkerKey)).toBe(true);
  });

  it("never overwrites another deployment's marker when a create answers 200 on an existing bucket", async () => {
    // Some S3 implementations answer 200 to a create of a bucket the caller already owns. If
    // another deployment of the same account made it between the HEAD and the PUT, its marker
    // must survive.
    let spaces: import('./support/spaces-emulator.js').SpacesEmulator | undefined;
    const lenientCreate: typeof fetch = async (input, init) => {
      const response = await spaces!.fetch(input, init);
      const url = new URL(String(input));
      const isCreate = init?.method === 'PUT' && url.pathname.split('/').length === 2 && !url.search;
      return isCreate && response.status === 409 ? new Response(null, { status: 200 }) : response;
    };
    const w = await storageWorld(storageAccount, { spacesFetch: lenientCreate }, (world) => {
      spaces = world.spaces;
    });
    const raced = w.spaces.seedBucket('raced-name');
    raced.objects.set(bucketMarkerKey, { body: markerBody('staging') });
    w.spaces.failNext('HEAD /raced-name$', 404, 'NoSuchBucket');
    const error = await failure(
      w.ensure('do.spaces-bucket', 'raced-name', { region: 'nyc3' }, w.ctx()),
    );
    expect(error.details?.reason).toBe('managedByAnother');
    expect(new TextDecoder().decode(raced.objects.get(bucketMarkerKey)!.body)).toContain(
      deploymentTag('staging'),
    );
    expect(w.spaces.buckets.has('raced-name')).toBe(true);
  });

  it('does not read a marker too big to be one', async () => {
    const w = await storageWorld();
    const padded = w.spaces.seedBucket('padded');
    padded.objects.set(bucketMarkerKey, {
      body: new TextEncoder().encode(
        JSON.stringify({ managedBy: 'better-compute', deployment: deploymentTag('default'), pad: 'x'.repeat(5000) }),
      ),
    });
    const error = await failure(w.ensure('do.spaces-bucket', 'padded', { region: 'nyc3' }, w.ctx()));
    expect(error.details?.reason).toBe('managedByAnother');
  });

  it('reads a marker sent without a length only up to its cap', async () => {
    // A marker is tenant-writable: a chunked answer of any size must not be read into memory.
    let pulled = 0;
    let spaces: import('./support/spaces-emulator.js').SpacesEmulator | undefined;
    const endless: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if ((init?.method ?? 'GET') === 'GET' && url.pathname.endsWith(`/${bucketMarkerKey}`)) {
        const chunk = new TextEncoder().encode('x'.repeat(1024));
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulled += chunk.length;
              if (pulled > 8 * 1024 * 1024) controller.close();
              else controller.enqueue(chunk);
            },
          }),
          { status: 200 },
        );
      }
      return spaces!.fetch(input, init);
    };
    const w = await storageWorld(storageAccount, { spacesFetch: endless }, (world) => {
      spaces = world.spaces;
    });
    w.spaces.seedBucket('padded');
    const error = await failure(w.ensure('do.spaces-bucket', 'padded', { region: 'nyc3' }, w.ctx()));
    expect(error.details?.reason).toBe('managedByAnother');
    expect(pulled).toBeLessThan(64 * 1024);
  });

  it('reads a 403 on a bucket it holds the id of as lost access, not a taken name', async () => {
    const w = await storageWorld();
    const created = await w.ensure('do.spaces-bucket', 'tenant-a-assets', { region: 'nyc3' }, w.ctx());
    w.spaces.failNext('HEAD /tenant-a-assets$', 403, 'AccessDenied');
    const refused = await failure(
      w.ensure('do.spaces-bucket', 'tenant-a-assets', { region: 'nyc3' }, w.ctx(), { id: created.id }),
    );
    expect([refused.code, refused.details?.reason]).toEqual(['ACCESS_DENIED', 'spacesAccess']);
    expect(w.spaces.buckets.has('tenant-a-assets')).toBe(true);
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
        (await failure(w.ensure('do.spaces-bucket', name, spec, w.ctx()))).code,
      ).toBe('INVALID_INPUT');
    expect(w.spaces.requests).toHaveLength(0);
  });

  it('fails closed without a Spaces key pair, and refuses half a pair', async () => {
    const { spacesAccessKey: _a, spacesSecretKey: _s, ...bare } = storageAccount;
    const w = await storageWorld(bare);
    const error = await failure(
      w.ensure('do.spaces-bucket', 'tenant-a-assets', { region: 'nyc3' }, w.ctx()),
    );
    expect(error.code).toBe('INVALID_CONFIG');
    expect(error.details?.reason).toBe('spacesKeys');
    await expect(storageWorld({ ...bare, spacesAccessKey: 'secret://spaces/access' })).rejects.toThrow(
      /together/,
    );
  });

  it('never sends the secret key over the wire or into an error', async () => {
    const w = await storageWorld();
    await w.ensure('do.spaces-bucket', 'tenant-a-assets', { region: 'nyc3' }, w.ctx());
    expect(JSON.stringify(w.spaces.requests)).not.toContain('spaces-secret');
  });
});

describe('do.spaces-bucket get and delete', () => {
  it('reads a bucket, and nothing for a gone one', async () => {
    const w = await storageWorld();
    await w.ensure(
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
    await w.ensure('do.spaces-bucket', 'tenant-a-assets', { region: 'nyc3' }, w.ctx());
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
    await w.ensure(
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
    await w.ensure('do.spaces-bucket', 'tenant-a-assets', { region: 'nyc3' }, w.ctx());
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

  it('puts the same marker back when an object lands between the check and the delete', async () => {
    const w = await storageWorld();
    await w.ensure('do.spaces-bucket', 'tenant-a-assets', { region: 'nyc3' }, w.ctx(), {
      labels: { 'better-compute-resource': 'res_1' },
    });
    const text = (body: Uint8Array) => new TextDecoder().decode(body);
    const before = text(w.spaces.buckets.get('tenant-a-assets')!.objects.get(bucketMarkerKey)!.body);
    expect(before).toContain('res_1');
    w.spaces.failNext('DELETE /tenant-a-assets$', 409, 'BucketNotEmpty');
    const refused = await failure(
      w.resources.delete('do.spaces-bucket', 'nyc3/tenant-a-assets', w.ctx()),
    );
    expect(refused.details?.reason).toBe('bucketNotEmpty');
    const after = w.spaces.buckets.get('tenant-a-assets')!.objects.get(bucketMarkerKey)!.body;
    expect(text(after)).toBe(before);
  });

  it('refuses to delete a bucket a CDN endpoint still fronts', async () => {
    const w = await storageWorld();
    await w.ensure('do.spaces-bucket', 'tenant-a-assets', { region: 'nyc3' }, w.ctx());
    // Deleting the bucket first would orphan the endpoint: its ownership is the bucket's marker.
    seedCdnEndpoint(w.emu, { origin: 'tenant-a-assets.nyc3.digitaloceanspaces.com' });
    const refused = await failure(
      w.resources.delete('do.spaces-bucket', 'nyc3/tenant-a-assets', w.ctx()),
    );
    expect(refused.code).toBe('INVALID_STATE');
    expect(refused.details?.reason).toBe('cdnEndpointAttached');
    expect(w.spaces.buckets.get('tenant-a-assets')!.objects.has(bucketMarkerKey)).toBe(true);
    // An endpoint in front of another bucket does not hold this one.
    seedCdnEndpoint(w.emu, { origin: 'tenant-a-other.nyc3.digitaloceanspaces.com' });
    await w.ensure('do.spaces-bucket', 'tenant-a-spare', { region: 'nyc3' }, w.ctx());
    expect((await w.resources.delete('do.spaces-bucket', 'nyc3/tenant-a-spare', w.ctx())).state).toBe(
      'deleted',
    );
  });

  it('never reports a bucket deleted or gone when Spaces answers 403 for it', async () => {
    const w = await storageWorld();
    await w.ensure('do.spaces-bucket', 'tenant-a-assets', { region: 'nyc3' }, w.ctx());
    // A rotated or narrowed account key answers 403 for a bucket the account still holds.
    w.spaces.failNext('HEAD /tenant-a-assets$', 403, 'AccessDenied');
    const refused = await failure(
      w.resources.delete('do.spaces-bucket', 'nyc3/tenant-a-assets', w.ctx()),
    );
    expect(refused.code).toBe('ACCESS_DENIED');
    expect(refused.details?.reason).toBe('spacesAccess');
    expect(w.spaces.buckets.has('tenant-a-assets')).toBe(true);
    w.spaces.failNext('HEAD /tenant-a-assets$', 403, 'AccessDenied');
    const unread = await failure(w.resources.get('do.spaces-bucket', 'nyc3/tenant-a-assets', w.ctx()));
    expect(unread.code).toBe('ACCESS_DENIED');
    // A bucket in another region is not gone either.
    w.spaces.seedBucket('elsewhere', { region: 'ams3' });
    expect(
      (await failure(w.resources.delete('do.spaces-bucket', 'nyc3/elsewhere', w.ctx()))).details
        ?.reason,
    ).toBe('region');
    expect(w.spaces.buckets.has('elsewhere')).toBe(true);
  });

  it('puts the marker back when the bucket delete fails, so a retry converges', async () => {
    const w = await storageWorld();
    await w.ensure('do.spaces-bucket', 'tenant-a-assets', { region: 'nyc3' }, w.ctx());
    w.spaces.failNext('DELETE /tenant-a-assets$', 503, 'ServiceUnavailable');
    await failure(w.resources.delete('do.spaces-bucket', 'nyc3/tenant-a-assets', w.ctx()));
    expect(w.spaces.buckets.get('tenant-a-assets')!.objects.has(bucketMarkerKey)).toBe(true);
    expect((await w.resources.delete('do.spaces-bucket', 'nyc3/tenant-a-assets', w.ctx())).state).toBe(
      'deleted',
    );
    expect(w.spaces.buckets.has('tenant-a-assets')).toBe(false);
  });

  it('recovers a delete cut off after the marker went (a crash) through adopt', async () => {
    const w = await storageWorld();
    await w.ensure('do.spaces-bucket', 'tenant-a-assets', { region: 'nyc3' }, w.ctx());
    // The process died between the marker delete and the bucket delete: empty and unmarked.
    w.spaces.buckets.get('tenant-a-assets')!.objects.delete(bucketMarkerKey);
    const refused = await failure(
      w.resources.delete('do.spaces-bucket', 'nyc3/tenant-a-assets', w.ctx()),
    );
    expect(refused.details?.reason).toBe('notManaged');
    await w.resources.adopt('do.spaces-bucket', 'nyc3/tenant-a-assets', {}, w.ctx());
    expect((await w.resources.delete('do.spaces-bucket', 'nyc3/tenant-a-assets', w.ctx())).state).toBe(
      'deleted',
    );
  });

  it('refuses to delete a bucket it does not manage', async () => {
    const w = await storageWorld();
    w.spaces.seedBucket('hand-made');
    const refused = await failure(w.resources.delete('do.spaces-bucket', 'nyc3/hand-made', w.ctx()));
    expect(refused.details?.reason).toBe('notManaged');
    expect(w.spaces.buckets.has('hand-made')).toBe(true);
  });
});
