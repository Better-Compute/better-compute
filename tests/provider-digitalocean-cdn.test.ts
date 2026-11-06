import { beforeEach, describe, expect, it } from 'vitest';
import { isComputeError, type ComputeError } from '@better-compute/core';
import {
  bucketMarkerKey,
  resetBudgets,
  type CdnEndpointKind,
} from '@better-compute/provider-digitalocean';
import { cdnEndpoints, cdnPurges, registerCdn, seedCdnEndpoint } from './support/do-emulator/cdn.js';
import { storageWorld, type StorageWorld } from './support/do-storage-harness.js';

// The `do.cdn-endpoint` kind: DigitalOcean's CDN in front of a bucket better-compute manages.

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

const origin = 'tenant-a-assets.nyc3.digitaloceanspaces.com';
const cert = '0f8a2d6e-3b1c-4a5d-9e7f-1a2b3c4d5e6f';

async function world(): Promise<StorageWorld> {
  const w = await storageWorld(undefined, undefined, ({ emu }) => registerCdn(emu));
  await w.ensure('do.spaces-bucket', 'tenant-a-assets', { region: 'nyc3' }, w.ctx());
  return w;
}

describe('do.cdn-endpoint', () => {
  it('creates one endpoint per origin and converges it in place', async () => {
    const w = await world();
    const created = await w.ensure('do.cdn-endpoint', 'bc-cdn1', { origin }, w.ctx());
    expect(created.state).toBe('ready');
    expect(created.outputs).toEqual({
      origin,
      endpoint: 'tenant-a-assets.nyc3.cdn.digitaloceanspaces.com',
      url: 'https://tenant-a-assets.nyc3.cdn.digitaloceanspaces.com',
      ttl: '3600',
    });
    const again = await w.ensure('do.cdn-endpoint', 'bc-cdn1', { origin }, w.ctx());
    expect(again).toEqual(created);
    expect(cdnEndpoints(w.emu).size).toBe(1);

    const custom = await w.ensure(
      'do.cdn-endpoint',
      'bc-cdn1',
      { origin, ttl: 86400, customDomain: 'assets.example.com', certificateId: cert },
      w.ctx(),
    );
    expect(custom.id).toBe(created.id);
    expect(custom.outputs).toMatchObject({
      ttl: '86400',
      customDomain: 'assets.example.com',
      url: 'https://assets.example.com',
    });
    const plain = await w.ensure('do.cdn-endpoint', 'bc-cdn1', { origin }, w.ctx());
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
      ),
    );
    expect(refused.code).toBe('INVALID_STATE');
    expect(refused.details?.reason).toBe('unmanagedOrigin');
    expect(w.emu.requests.filter((r) => r.url.pathname.startsWith('/v2/cdn'))).toHaveLength(0);
  });

  it('validates ttl, custom domain and origin', async () => {
    const w = await world();
    const reason = async (spec: Record<string, unknown>) =>
      (await failure(w.ensure('do.cdn-endpoint', 'bc-cdn1', spec, w.ctx()))).details
        ?.reason;
    expect(await reason({ origin, ttl: 120 })).toBe('ttl');
    expect(await reason({ origin, customDomain: 'assets.example.com' })).toBe('customDomain');
    expect(await reason({ origin, certificateId: cert })).toBe('customDomain');
    expect(
      (await failure(w.ensure('do.cdn-endpoint', 'bc-cdn1', { origin: 'example.com' }, w.ctx())))
        .code,
    ).toBe('INVALID_INPUT');
  });

  it('deletes a managed endpoint, and leaves one whose origin is not ours', async () => {
    const w = await world();
    const created = await w.ensure('do.cdn-endpoint', 'bc-cdn1', { origin }, w.ctx());
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

  it('a bucket that lost its marker loses the right to its endpoint', async () => {
    const w = await world();
    const created = await w.ensure('do.cdn-endpoint', 'bc-cdn1', { origin }, w.ctx());
    w.spaces.buckets.get('tenant-a-assets')!.objects.delete(bucketMarkerKey);
    expect((await failure(w.resources.delete('do.cdn-endpoint', created.id, w.ctx()))).code).toBe(
      'INVALID_STATE',
    );
  });

  it('purges cached paths of a managed endpoint', async () => {
    const w = await world();
    const created = await w.ensure('do.cdn-endpoint', 'bc-cdn1', { origin }, w.ctx());
    const kind = w.resources.kinds().find((k) => k.kind === 'do.cdn-endpoint') as CdnEndpointKind;
    await kind.purge(created.id, ['assets/*', 'index.html'], w.ctx());
    expect(cdnPurges(w.emu)).toEqual([{ id: created.id, files: ['assets/*', 'index.html'] }]);
    expect((await failure(kind.purge(created.id, [], w.ctx()))).details?.reason).toBe('purgeFiles');
  });

  it('discovers endpoints by origin', async () => {
    const w = await world();
    const created = await w.ensure('do.cdn-endpoint', 'bc-cdn1', { origin }, w.ctx());
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
