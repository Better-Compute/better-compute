import { beforeEach, describe, expect, it } from 'vitest';
import { isComputeError, type ComputeError } from '@better-compute/core';
import {
  bucketMarkerKey,
  managedNamePrefix,
  resetBudgets,
  type CdnEndpointKind,
} from '@better-compute/provider-digitalocean';
import { cdnEndpoints, cdnPurges, registerCdn, seedCdnEndpoint } from './support/do-emulator/cdn.js';
import { storageWorld, type StorageWorld } from './support/do-storage-harness.js';

// The `do.cdn-endpoint` kind: DigitalOcean's CDN in front of a bucket better-compute manages.

beforeEach(() => resetBudgets());

// Buckets ensure makes are named for this deployment: bc-<deployment hash>-….
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

const origin = `${own}tenant-a-assets.nyc3.digitaloceanspaces.com`;
const cert = '0f8a2d6e-3b1c-4a5d-9e7f-1a2b3c4d5e6f';

const tenantA = { 'better-compute-tenant': 'ten_a', 'better-compute-resource': 'crs_cdn_a' };
const tenantB = { 'better-compute-tenant': 'ten_b', 'better-compute-resource': 'crs_cdn_b' };
/** Tenant A's request: its endpoint lives in its own bucket row. */
const asA = { parent: `nyc3/${own}tenant-a-assets`, labels: tenantA };

async function world(): Promise<StorageWorld> {
  const w = await storageWorld(undefined, undefined, ({ emu }) => registerCdn(emu));
  await w.ensure('do.spaces-bucket', `${own}tenant-a-assets`, { region: 'nyc3' }, w.ctx(), {
    labels: { 'better-compute-tenant': 'ten_a', 'better-compute-resource': 'crs_bucket_a' },
  });
  return w;
}

describe('do.cdn-endpoint', () => {
  it('creates one endpoint per origin and converges it in place', async () => {
    const w = await world();
    const created = await w.ensure('do.cdn-endpoint', 'bc-cdn1', { origin }, w.ctx(), asA);
    expect(created.state).toBe('ready');
    expect(created.outputs).toEqual({
      origin,
      endpoint: `${own}tenant-a-assets.nyc3.cdn.digitaloceanspaces.com`,
      url: `https://${own}tenant-a-assets.nyc3.cdn.digitaloceanspaces.com`,
      ttl: '3600',
    });
    const again = await w.ensure('do.cdn-endpoint', 'bc-cdn1', { origin }, w.ctx(), asA);
    expect(again).toEqual(created);
    expect(cdnEndpoints(w.emu).size).toBe(1);

    const custom = await w.ensure(
      'do.cdn-endpoint',
      'bc-cdn1',
      { origin, ttl: 86400, customDomain: 'assets.example.com', certificateId: cert },
      w.ctx(),
      asA,
    );
    expect(custom.id).toBe(created.id);
    expect(custom.outputs).toMatchObject({
      ttl: '86400',
      customDomain: 'assets.example.com',
      url: 'https://assets.example.com',
    });
    const plain = await w.ensure('do.cdn-endpoint', 'bc-cdn1', { origin }, w.ctx(), asA);
    expect(plain.outputs?.customDomain).toBeUndefined();
    expect(cdnEndpoints(w.emu).get(created.id)!.certificate_id).toBeUndefined();
  });

  it('refuses an origin bucket better-compute does not manage', async () => {
    const w = await world();
    w.spaces.seedBucket('hand-made');
    const refused = await failure(
      w.ensure(
        'do.cdn-endpoint',
        'bc-cdn2',
        { origin: 'hand-made.nyc3.digitaloceanspaces.com' },
        w.ctx(),
        { parent: 'nyc3/hand-made', labels: tenantA },
      ),
    );
    expect(refused.code).toBe('INVALID_STATE');
    expect(refused.details?.reason).toBe('unmanagedOrigin');
    expect(w.emu.requests.filter((r) => r.url.pathname.startsWith('/v2/cdn'))).toHaveLength(0);
  });

  it('requires its origin bucket as the parent', async () => {
    const w = await world();
    const noParent = await failure(
      w.ensure('do.cdn-endpoint', 'bc-cdn1', { origin }, w.ctx(), { labels: tenantA }),
    );
    expect([noParent.code, noParent.details?.reason]).toEqual(['INVALID_INPUT', 'parent']);
    await w.ensure('do.spaces-bucket', `${own}tenant-a-other`, { region: 'nyc3' }, w.ctx(), {
      labels: tenantA,
    });
    const crossed = await failure(
      w.ensure('do.cdn-endpoint', 'bc-cdn1', { origin }, w.ctx(), {
        parent: `nyc3/${own}tenant-a-other`,
        labels: tenantA,
      }),
    );
    expect([crossed.code, crossed.details?.reason]).toEqual(['INVALID_INPUT', 'parent']);
    expect(w.emu.requests.filter((r) => r.url.pathname.startsWith('/v2/cdn'))).toHaveLength(0);
  });

  it("never takes over, repoints or duplicates another tenant's endpoint", async () => {
    const w = await world();
    const created = await w.ensure('do.cdn-endpoint', 'bc-cdn1', { origin }, w.ctx(), asA);
    const before = w.emu.requests.length;
    // Tenant B names tenant A's bucket as its origin (and as its parent): refused, nothing sent.
    for (const spec of [
      { origin },
      { origin, ttl: 600, customDomain: 'evil.example.com', certificateId: cert },
    ]) {
      const refused = await failure(
        w.ensure('do.cdn-endpoint', 'bc-cdn-b', spec, w.ctx(), {
          parent: `nyc3/${own}tenant-a-assets`,
          labels: tenantB,
        }),
      );
      expect([refused.code, refused.details?.reason]).toEqual(['ACCESS_DENIED', 'otherTenant']);
    }
    // Tenant B's own endpoint id cannot carry it there either.
    const byId = await failure(
      w.ensure('do.cdn-endpoint', 'bc-cdn-b', { origin, ttl: 600 }, w.ctx(), {
        id: created.id,
        parent: `nyc3/${own}tenant-a-assets`,
        labels: tenantB,
      }),
    );
    expect(byId.details?.reason).toBe('otherTenant');
    expect(
      w.emu.requests.slice(before).filter((r) => r.method === 'PUT' || r.method === 'POST'),
    ).toHaveLength(0);
    expect(cdnEndpoints(w.emu).size).toBe(1);
    expect(cdnEndpoints(w.emu).get(created.id)!.ttl).toBe(3600);
  });

  it("never adopts another tenant's endpoint, or one in front of the operator's bucket", async () => {
    const w = await world();
    await w.ensure('do.spaces-bucket', `${own}tenant-b-assets`, { region: 'nyc3' }, w.ctx(), {
      labels: { 'better-compute-tenant': 'ten_b', 'better-compute-resource': 'crs_bucket_b' },
    });
    // An operator bucket: marked by this deployment, with no tenant.
    await w.ensure('do.spaces-bucket', `${own}operator-site`, { region: 'nyc3' }, w.ctx());
    const theirs = seedCdnEndpoint(w.emu, { origin: `${own}tenant-b-assets.nyc3.digitaloceanspaces.com` });
    const ops = seedCdnEndpoint(w.emu, { origin: `${own}operator-site.nyc3.digitaloceanspaces.com` });
    const before = w.emu.requests.length;
    for (const endpoint of [theirs, ops]) {
      const refused = await failure(w.resources.adopt('do.cdn-endpoint', endpoint.id, tenantA, w.ctx()));
      expect([refused.code, refused.details?.reason]).toEqual(['ACCESS_DENIED', 'otherTenant']);
    }
    expect(
      w.emu.requests.slice(before).filter((r) => r.method !== 'GET'),
    ).toHaveLength(0);
    expect(cdnEndpoints(w.emu).has(theirs.id)).toBe(true);
    expect(cdnPurges(w.emu)).toHaveLength(0);
    // Tenant B (the bucket's own tenant) may adopt its endpoint.
    expect((await w.resources.adopt('do.cdn-endpoint', theirs.id, tenantB, w.ctx())).id).toBe(theirs.id);
  });

  it('validates ttl, custom domain and origin', async () => {
    const w = await world();
    const reason = async (spec: Record<string, unknown>) =>
      (await failure(w.ensure('do.cdn-endpoint', 'bc-cdn1', spec, w.ctx(), asA))).details
        ?.reason;
    expect(await reason({ origin, ttl: 120 })).toBe('ttl');
    expect(await reason({ origin, customDomain: 'assets.example.com' })).toBe('customDomain');
    expect(await reason({ origin, certificateId: cert })).toBe('customDomain');
    expect(
      (await failure(w.ensure('do.cdn-endpoint', 'bc-cdn1', { origin: 'example.com' }, w.ctx(), asA)))
        .code,
    ).toBe('INVALID_INPUT');
  });

  it('deletes a managed endpoint, and leaves one whose origin is not ours', async () => {
    const w = await world();
    const created = await w.ensure('do.cdn-endpoint', 'bc-cdn1', { origin }, w.ctx(), asA);
    expect((await w.resources.delete('do.cdn-endpoint', created.id, w.ctx())).state).toBe('deleted');
    expect(cdnEndpoints(w.emu).size).toBe(0);
    expect((await w.resources.delete('do.cdn-endpoint', created.id, w.ctx())).state).toBe('deleted');
    expect(await w.resources.get('do.cdn-endpoint', created.id, w.ctx())).toBeUndefined();

    w.spaces.seedBucket('hand-made');
    const foreign = seedCdnEndpoint(w.emu, { origin: 'hand-made.nyc3.digitaloceanspaces.com' });
    expect((await failure(w.resources.delete('do.cdn-endpoint', foreign.id, w.ctx()))).details?.reason).toBe(
      'notManaged',
    );
    expect(cdnEndpoints(w.emu).has(foreign.id)).toBe(true);
  });

  it('an endpoint stays deletable when its tenant deletes the bucket marker', async () => {
    const w = await world();
    const created = await w.ensure('do.cdn-endpoint', 'bc-cdn1', { origin }, w.ctx(), asA);
    // The marker is an object a tenant's readwrite key can delete; the bucket's name is not.
    w.spaces.buckets.get(`${own}tenant-a-assets`)!.objects.delete(bucketMarkerKey);
    // The tenant checks fail closed: no repointing or adopting through a markerless origin.
    expect(
      (await failure(w.ensure('do.cdn-endpoint', 'bc-cdn1', { origin, ttl: 600 }, w.ctx(), asA))).details
        ?.reason,
    ).toBe('unmanagedOrigin');
    expect((await failure(w.resources.adopt('do.cdn-endpoint', created.id, tenantA, w.ctx()))).details?.reason).toBe(
      'notManaged',
    );
    // But the endpoint, in front of a bucket named for this deployment, is still purged and deleted.
    const kind = w.resources.kinds().find((k) => k.kind === 'do.cdn-endpoint') as CdnEndpointKind;
    await kind.purge(created.id, ['index.html'], w.ctx());
    expect((await w.resources.delete('do.cdn-endpoint', created.id, w.ctx())).state).toBe('deleted');
    expect(cdnEndpoints(w.emu).size).toBe(0);
  });

  it('purges cached paths of a managed endpoint', async () => {
    const w = await world();
    const created = await w.ensure('do.cdn-endpoint', 'bc-cdn1', { origin }, w.ctx(), asA);
    const kind = w.resources.kinds().find((k) => k.kind === 'do.cdn-endpoint') as CdnEndpointKind;
    await kind.purge(created.id, ['assets/*', 'index.html'], w.ctx());
    expect(cdnPurges(w.emu)).toEqual([{ id: created.id, files: ['assets/*', 'index.html'] }]);
    expect((await failure(kind.purge(created.id, [], w.ctx()))).details?.reason).toBe('purgeFiles');
  });

  it('discovers endpoints by origin', async () => {
    const w = await world();
    const created = await w.ensure('do.cdn-endpoint', 'bc-cdn1', { origin }, w.ctx(), asA);
    const found = [];
    for await (const entry of w.resources.discover('do.cdn-endpoint', w.ctx())) found.push(entry);
    expect(found).toEqual([
      {
        id: created.id,
        name: origin,
        managedBy: 'this',
        outputs: created.outputs,
        spec: { origin, ttl: 3600 },
      },
    ]);
  });
});
