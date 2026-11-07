import { beforeEach, describe, expect, it } from 'vitest';
import { isComputeError, type ComputeError } from '@better-compute/core';
import {
  bucketMarkerKey,
  deploymentTag,
  managedNamePrefix,
  resetBudgets,
} from '@better-compute/provider-digitalocean';
import { seedCdnEndpoint } from './support/do-emulator/cdn.js';
import { storageAccount, storageWorld } from './support/do-storage-harness.js';

// The `do.spaces-bucket` kind: tenant buckets over S3 with the account's Spaces keys. Ownership is
// a marker object; tenant data is never deleted to delete a bucket.

beforeEach(() => resetBudgets());

// A bucket ensure makes is named for this deployment (bc-<deployment hash>-…); requests name bc-….
const own = managedNamePrefix('default');

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
      `${own}tenant-a-assets`,
      { region: 'nyc3' },
      w.ctx(),
    );
    expect(created).toEqual({
      id: `nyc3/${own}tenant-a-assets`,
      state: 'ready',
      outputs: {
        bucket: `${own}tenant-a-assets`,
        region: 'nyc3',
        endpoint: `https://${own}tenant-a-assets.nyc3.digitaloceanspaces.com`,
        origin: `${own}tenant-a-assets.nyc3.digitaloceanspaces.com`,
        acl: 'private',
        versioning: 'off',
      },
    });
    const bucket = w.spaces.buckets.get(`${own}tenant-a-assets`)!;
    expect(bucket.objects.has(bucketMarkerKey)).toBe(true);

    const again = await w.ensure(
      'do.spaces-bucket',
      `${own}tenant-a-assets`,
      { region: 'nyc3' },
      w.ctx(),
    );
    expect(again).toEqual(created);
    expect(w.spaces.requests.filter((r) => r.method === 'PUT')).toHaveLength(2);

    const changed = await w.ensure(
      'do.spaces-bucket',
      `${own}tenant-a-assets`,
      { region: 'nyc3', acl: 'public-read', versioning: true },
      w.ctx(),
    );
    expect(changed.outputs).toMatchObject({ acl: 'public-read', versioning: 'enabled' });
    expect(bucket.acl).toBe('public-read');
    expect(bucket.versioning).toBe('Enabled');

    const off = await w.ensure(
      'do.spaces-bucket',
      `${own}tenant-a-assets`,
      { region: 'nyc3' },
      w.ctx(),
    );
    expect(off.outputs).toMatchObject({ acl: 'private', versioning: 'suspended' });
  });

  it('creates a versioned bucket in one pass', async () => {
    const w = await storageWorld();
    const state = await w.ensure(
      'do.spaces-bucket',
      `${own}tenant-a-logs`,
      { region: 'nyc3', versioning: true },
      w.ctx(),
    );
    expect(state.outputs?.versioning).toBe('enabled');
    expect(w.spaces.buckets.get(`${own}tenant-a-logs`)!.versioning).toBe('Enabled');
  });

  it('refuses a name another account holds, and a bucket of ours it does not manage', async () => {
    const w = await storageWorld();
    w.spaces.seedBucket(`${own}taken-name`, { owner: 'SOMEONEELSE' });
    const taken = await failure(
      w.ensure('do.spaces-bucket', `${own}taken-name`, { region: 'nyc3' }, w.ctx()),
    );
    expect(taken.code).toBe('CONFLICT');
    expect(taken.details?.reason).toBe('bucketNameTaken');

    // A bucket with this deployment's name but no marker: ensure never claims it.
    const hand = w.spaces.seedBucket(`${own}hand-made`);
    const unmanaged = await failure(
      w.ensure('do.spaces-bucket', `${own}hand-made`, { region: 'nyc3' }, w.ctx()),
    );
    expect(unmanaged.details?.reason).toBe('notManaged');
    expect(hand.objects.size).toBe(0);

    const other = w.spaces.seedBucket(`${own}other-dep`);
    other.objects.set(bucketMarkerKey, { body: markerBody('staging') });
    expect(
      (
        await failure(
          w.ensure('do.spaces-bucket', `${own}other-dep`, { region: 'nyc3' }, w.ctx()),
        )
      ).details?.reason,
    ).toBe('managedByAnother');
  });

  it("records the tenant in the marker and refuses another tenant's ensure on the bucket", async () => {
    const w = await storageWorld();
    const labels = { 'better-compute-tenant': 'ten_a', 'better-compute-resource': 'res_a' };
    await w.ensure('do.spaces-bucket', `${own}tenant-a-assets`, { region: 'nyc3' }, w.ctx(), { labels });
    const marker = JSON.parse(
      new TextDecoder().decode(w.spaces.buckets.get(`${own}tenant-a-assets`)!.objects.get(bucketMarkerKey)!.body),
    );
    expect(marker).toEqual({
      managedBy: 'better-compute',
      deployment: deploymentTag('default'),
      resource: 'res_a',
      tenant: 'ten_a',
    });
    const before = w.spaces.requests.length;
    const refused = await failure(
      w.ensure('do.spaces-bucket', `${own}tenant-a-assets`, { region: 'nyc3', acl: 'public-read' }, w.ctx(), {
        id: `nyc3/${own}tenant-a-assets`,
        labels: { 'better-compute-tenant': 'ten_b', 'better-compute-resource': 'res_b' },
      }),
    );
    expect(refused.code).toBe('ACCESS_DENIED');
    expect(refused.details?.reason).toBe('otherTenant');
    expect(w.spaces.requests.slice(before).some((r) => r.method === 'PUT')).toBe(false);
    expect(w.spaces.buckets.get(`${own}tenant-a-assets`)!.acl).toBe('private');
  });

  it('removes the bucket it just made when the marker cannot be written, so the next pass starts over', async () => {
    const w = await storageWorld();
    w.spaces.failNext(`PUT /${own}tenant-a-assets/${bucketMarkerKey}`, 503, 'SlowDown');
    const error = await failure(
      w.ensure('do.spaces-bucket', `${own}tenant-a-assets`, { region: 'nyc3' }, w.ctx()),
    );
    expect(error.code).toBe('RATE_LIMITED');
    // Left in place, an unmarked bucket would be refused as unmanaged on every later pass.
    expect(w.spaces.buckets.has(`${own}tenant-a-assets`)).toBe(false);
    const again = await w.ensure('do.spaces-bucket', `${own}tenant-a-assets`, { region: 'nyc3' }, w.ctx());
    expect(again.state).toBe('ready');
    expect(w.spaces.buckets.get(`${own}tenant-a-assets`)!.objects.has(bucketMarkerKey)).toBe(true);
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
    const raced = w.spaces.seedBucket(`${own}raced-name`);
    raced.objects.set(bucketMarkerKey, { body: markerBody('staging') });
    w.spaces.failNext(`HEAD /${own}raced-name$`, 404, 'NoSuchBucket');
    const error = await failure(
      w.ensure('do.spaces-bucket', `${own}raced-name`, { region: 'nyc3' }, w.ctx()),
    );
    expect(error.details?.reason).toBe('managedByAnother');
    expect(new TextDecoder().decode(raced.objects.get(bucketMarkerKey)!.body)).toContain(
      deploymentTag('staging'),
    );
    expect(w.spaces.buckets.has(`${own}raced-name`)).toBe(true);
  });

  it('does not read a marker too big to be one', async () => {
    const w = await storageWorld();
    const padded = w.spaces.seedBucket(`${own}padded`);
    padded.objects.set(bucketMarkerKey, {
      body: new TextEncoder().encode(
        JSON.stringify({ managedBy: 'better-compute', deployment: deploymentTag('default'), pad: 'x'.repeat(5000) }),
      ),
    });
    const error = await failure(w.ensure('do.spaces-bucket', `${own}padded`, { region: 'nyc3' }, w.ctx()));
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
    w.spaces.seedBucket(`${own}padded`);
    const error = await failure(w.ensure('do.spaces-bucket', `${own}padded`, { region: 'nyc3' }, w.ctx()));
    expect(error.details?.reason).toBe('managedByAnother');
    expect(pulled).toBeLessThan(64 * 1024);
  });

  it('reads a 403 on a bucket it holds the id of as lost access, not a taken name', async () => {
    const w = await storageWorld();
    const created = await w.ensure('do.spaces-bucket', `${own}tenant-a-assets`, { region: 'nyc3' }, w.ctx());
    w.spaces.failNext(`HEAD /${own}tenant-a-assets$`, 403, 'AccessDenied');
    const refused = await failure(
      w.ensure('do.spaces-bucket', `${own}tenant-a-assets`, { region: 'nyc3' }, w.ctx(), { id: created.id }),
    );
    expect([refused.code, refused.details?.reason]).toEqual(['ACCESS_DENIED', 'spacesAccess']);
    expect(w.spaces.buckets.has(`${own}tenant-a-assets`)).toBe(true);
  });

  it('validates the name and spec before any request', async () => {
    const w = await storageWorld();
    for (const [name, spec] of [
      ['Bad_Name', { region: 'nyc3' }],
      // A created bucket is named for this deployment, from a requested bc- name only.
      ['plain-name', { region: 'nyc3' }],
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
      w.ensure('do.spaces-bucket', `${own}tenant-a-assets`, { region: 'nyc3' }, w.ctx()),
    );
    expect(error.code).toBe('INVALID_CONFIG');
    expect(error.details?.reason).toBe('spacesKeys');
    await expect(storageWorld({ ...bare, spacesAccessKey: 'secret://spaces/access' })).rejects.toThrow(
      /together/,
    );
  });

  it('never sends the secret key over the wire or into an error', async () => {
    const w = await storageWorld();
    await w.ensure('do.spaces-bucket', `${own}tenant-a-assets`, { region: 'nyc3' }, w.ctx());
    expect(JSON.stringify(w.spaces.requests)).not.toContain('spaces-secret');
  });
});

describe('do.spaces-bucket get and delete', () => {
  it('reads a bucket, and nothing for a gone one', async () => {
    const w = await storageWorld();
    await w.ensure(
      'do.spaces-bucket',
      `${own}tenant-a-assets`,
      { region: 'nyc3', acl: 'public-read' },
      w.ctx(),
    );
    expect(
      (await w.resources.get('do.spaces-bucket', `nyc3/${own}tenant-a-assets`, w.ctx()))?.outputs?.acl,
    ).toBe('public-read');
    expect(await w.resources.get('do.spaces-bucket', 'nyc3/nothing-here', w.ctx())).toBeUndefined();
    expect((await failure(w.resources.get('do.spaces-bucket', 'nothing-here', w.ctx()))).code).toBe(
      'INVALID_INPUT',
    );
  });

  it('deletes an empty managed bucket', async () => {
    const w = await storageWorld();
    await w.ensure('do.spaces-bucket', `${own}tenant-a-assets`, { region: 'nyc3' }, w.ctx());
    expect(await w.resources.delete('do.spaces-bucket', `nyc3/${own}tenant-a-assets`, w.ctx())).toEqual({
      id: `nyc3/${own}tenant-a-assets`,
      state: 'deleted',
    });
    expect(w.spaces.buckets.has(`${own}tenant-a-assets`)).toBe(false);
    expect(
      (await w.resources.delete('do.spaces-bucket', `nyc3/${own}tenant-a-assets`, w.ctx())).state,
    ).toBe('deleted');
  });

  it('deletes a versioned bucket, clearing the marker versions', async () => {
    const w = await storageWorld();
    await w.ensure(
      'do.spaces-bucket',
      `${own}tenant-a-logs`,
      { region: 'nyc3', versioning: true },
      w.ctx(),
    );
    // The marker was rewritten once, so it has an old version too.
    const bucket = w.spaces.buckets.get(`${own}tenant-a-logs`)!;
    bucket.noncurrent.set('v-old', { key: bucketMarkerKey, deleteMarker: false });
    expect((await w.resources.delete('do.spaces-bucket', `nyc3/${own}tenant-a-logs`, w.ctx())).state).toBe(
      'deleted',
    );
    expect(w.spaces.buckets.has(`${own}tenant-a-logs`)).toBe(false);
  });

  it('refuses to delete a bucket that holds tenant data, and keeps it', async () => {
    const w = await storageWorld();
    await w.ensure('do.spaces-bucket', `${own}tenant-a-assets`, { region: 'nyc3' }, w.ctx());
    const bucket = w.spaces.buckets.get(`${own}tenant-a-assets`)!;
    bucket.objects.set('index.html', { body: new TextEncoder().encode('<h1>hi</h1>') });
    const refused = await failure(
      w.resources.delete('do.spaces-bucket', `nyc3/${own}tenant-a-assets`, w.ctx()),
    );
    expect(refused.code).toBe('INVALID_STATE');
    expect(refused.details?.reason).toBe('bucketNotEmpty');
    expect(bucket.objects.has('index.html')).toBe(true);
    expect(bucket.objects.has(bucketMarkerKey)).toBe(true);
  });

  it('puts the same marker back when an object lands between the check and the delete', async () => {
    const w = await storageWorld();
    await w.ensure('do.spaces-bucket', `${own}tenant-a-assets`, { region: 'nyc3' }, w.ctx(), {
      labels: { 'better-compute-resource': 'res_1' },
    });
    const text = (body: Uint8Array) => new TextDecoder().decode(body);
    const before = text(w.spaces.buckets.get(`${own}tenant-a-assets`)!.objects.get(bucketMarkerKey)!.body);
    expect(before).toContain('res_1');
    w.spaces.failNext(`DELETE /${own}tenant-a-assets$`, 409, 'BucketNotEmpty');
    const refused = await failure(
      w.resources.delete('do.spaces-bucket', `nyc3/${own}tenant-a-assets`, w.ctx()),
    );
    expect(refused.details?.reason).toBe('bucketNotEmpty');
    const after = w.spaces.buckets.get(`${own}tenant-a-assets`)!.objects.get(bucketMarkerKey)!.body;
    expect(text(after)).toBe(before);
  });

  it('refuses to delete a bucket a CDN endpoint still fronts', async () => {
    const w = await storageWorld();
    await w.ensure('do.spaces-bucket', `${own}tenant-a-assets`, { region: 'nyc3' }, w.ctx());
    // Deleting the bucket first would orphan the endpoint: its ownership is the bucket's marker.
    seedCdnEndpoint(w.emu, { origin: `${own}tenant-a-assets.nyc3.digitaloceanspaces.com` });
    const refused = await failure(
      w.resources.delete('do.spaces-bucket', `nyc3/${own}tenant-a-assets`, w.ctx()),
    );
    expect(refused.code).toBe('INVALID_STATE');
    expect(refused.details?.reason).toBe('cdnEndpointAttached');
    expect(w.spaces.buckets.get(`${own}tenant-a-assets`)!.objects.has(bucketMarkerKey)).toBe(true);
    // An endpoint in front of another bucket does not hold this one.
    seedCdnEndpoint(w.emu, { origin: `${own}tenant-a-other.nyc3.digitaloceanspaces.com` });
    await w.ensure('do.spaces-bucket', `${own}tenant-a-spare`, { region: 'nyc3' }, w.ctx());
    expect((await w.resources.delete('do.spaces-bucket', `nyc3/${own}tenant-a-spare`, w.ctx())).state).toBe(
      'deleted',
    );
  });

  it('never reports a bucket deleted or gone when Spaces answers 403 for it', async () => {
    const w = await storageWorld();
    await w.ensure('do.spaces-bucket', `${own}tenant-a-assets`, { region: 'nyc3' }, w.ctx());
    // A rotated or narrowed account key answers 403 for a bucket the account still holds.
    w.spaces.failNext(`HEAD /${own}tenant-a-assets$`, 403, 'AccessDenied');
    const refused = await failure(
      w.resources.delete('do.spaces-bucket', `nyc3/${own}tenant-a-assets`, w.ctx()),
    );
    expect(refused.code).toBe('ACCESS_DENIED');
    expect(refused.details?.reason).toBe('spacesAccess');
    expect(w.spaces.buckets.has(`${own}tenant-a-assets`)).toBe(true);
    w.spaces.failNext(`HEAD /${own}tenant-a-assets$`, 403, 'AccessDenied');
    const unread = await failure(w.resources.get('do.spaces-bucket', `nyc3/${own}tenant-a-assets`, w.ctx()));
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
    await w.ensure('do.spaces-bucket', `${own}tenant-a-assets`, { region: 'nyc3' }, w.ctx());
    w.spaces.failNext(`DELETE /${own}tenant-a-assets$`, 503, 'ServiceUnavailable');
    await failure(w.resources.delete('do.spaces-bucket', `nyc3/${own}tenant-a-assets`, w.ctx()));
    expect(w.spaces.buckets.get(`${own}tenant-a-assets`)!.objects.has(bucketMarkerKey)).toBe(true);
    expect((await w.resources.delete('do.spaces-bucket', `nyc3/${own}tenant-a-assets`, w.ctx())).state).toBe(
      'deleted',
    );
    expect(w.spaces.buckets.has(`${own}tenant-a-assets`)).toBe(false);
  });

  it('a delete cut off after the marker went (a crash) converges on retry, by the name', async () => {
    const w = await storageWorld();
    await w.ensure('do.spaces-bucket', `${own}tenant-a-assets`, { region: 'nyc3' }, w.ctx());
    // The process died between the marker delete and the bucket delete: empty and unmarked.
    w.spaces.buckets.get(`${own}tenant-a-assets`)!.objects.delete(bucketMarkerKey);
    expect((await w.resources.delete('do.spaces-bucket', `nyc3/${own}tenant-a-assets`, w.ctx())).state).toBe(
      'deleted',
    );
    expect(w.spaces.buckets.has(`${own}tenant-a-assets`)).toBe(false);
  });

  it('a tenant that deletes or rewrites its marker never makes its bucket undeletable', async () => {
    const w = await storageWorld();
    const labels = { 'better-compute-tenant': 'ten_a', 'better-compute-resource': 'res_a' };
    for (const tamper of ['delete', 'other-deployment', 'garbage'] as const) {
      await w.ensure('do.spaces-bucket', `${own}tenant-a-assets`, { region: 'nyc3' }, w.ctx(), { labels });
      const objects = w.spaces.buckets.get(`${own}tenant-a-assets`)!.objects;
      // The tenant's readwrite key reaches the marker like any other object.
      if (tamper === 'delete') objects.delete(bucketMarkerKey);
      else
        objects.set(bucketMarkerKey, {
          body: tamper === 'garbage' ? new TextEncoder().encode('{not json') : markerBody('staging'),
        });
      // It loses its own access: the tenant checks fail closed.
      const ensured = await failure(
        w.ensure('do.spaces-bucket', `${own}tenant-a-assets`, { region: 'nyc3' }, w.ctx(), {
          id: `nyc3/${own}tenant-a-assets`,
          labels,
        }),
      );
      expect(ensured.code, tamper).toBe('INVALID_STATE');
      // But the bucket, whose name is this deployment's, is still deleted when empty.
      expect(
        (await w.resources.delete('do.spaces-bucket', `nyc3/${own}tenant-a-assets`, w.ctx())).state,
        tamper,
      ).toBe('deleted');
      expect(w.spaces.buckets.has(`${own}tenant-a-assets`), tamper).toBe(false);
    }
    // Tenant data still keeps it: a delete never empties a bucket.
    await w.ensure('do.spaces-bucket', `${own}tenant-a-assets`, { region: 'nyc3' }, w.ctx(), { labels });
    const objects = w.spaces.buckets.get(`${own}tenant-a-assets`)!.objects;
    objects.delete(bucketMarkerKey);
    objects.set('data.bin', { body: new TextEncoder().encode('tenant data') });
    expect(
      (await failure(w.resources.delete('do.spaces-bucket', `nyc3/${own}tenant-a-assets`, w.ctx()))).details
        ?.reason,
    ).toBe('bucketNotEmpty');
    expect(objects.has('data.bin')).toBe(true);
    // A failed bucket delete puts back no made-up marker either.
    objects.delete('data.bin');
    w.spaces.failNext(`DELETE /${own}tenant-a-assets$`, 503, 'ServiceUnavailable');
    await failure(w.resources.delete('do.spaces-bucket', `nyc3/${own}tenant-a-assets`, w.ctx()));
    expect(objects.has(bucketMarkerKey)).toBe(false);
  });

  it("refuses a bucket named for another deployment, sending nothing", async () => {
    const w = await storageWorld();
    const theirs = `${managedNamePrefix('staging')}assets`;
    w.spaces.seedBucket(theirs);
    const reasons = await Promise.all([
      failure(w.ensure('do.spaces-bucket', 'bc-x', { region: 'nyc3' }, w.ctx(), { id: `nyc3/${theirs}` })),
      failure(w.resources.delete('do.spaces-bucket', `nyc3/${theirs}`, w.ctx())),
      failure(w.resources.adopt('do.spaces-bucket', `nyc3/${theirs}`, {}, w.ctx())),
      failure(w.resources.release('do.spaces-bucket', `nyc3/${theirs}`, w.ctx())),
    ]);
    expect(reasons.map((e) => e.details?.reason)).toEqual([
      'managedByAnother',
      'managedByAnother',
      'managedByAnother',
      'managedByAnother',
    ]);
    expect(w.spaces.requests).toHaveLength(0);
    expect(w.spaces.buckets.has(theirs)).toBe(true);
  });

  it('refuses to delete a bucket it does not manage', async () => {
    const w = await storageWorld();
    w.spaces.seedBucket('hand-made');
    const refused = await failure(w.resources.delete('do.spaces-bucket', 'nyc3/hand-made', w.ctx()));
    expect(refused.details?.reason).toBe('notManaged');
    expect(w.spaces.buckets.has('hand-made')).toBe(true);
  });
});
