import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeFixtures } from '@better-compute/testing';
import type { CloudResourceView } from '@better-compute/cloud-resources';
import { cloudResourcesWorld, type CloudResourcesWorld } from './support/cloud-resources-world.js';
import { memorySecrets } from './support/memory-secrets.js';

// cloudResources.discover, adopt and release: only on the tenant's own account; a resource another deployment
// manages is refused; an adopted resource is observed (its spec read back), then managed like any other.

let world: CloudResourcesWorld;

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => ({ code: 'resolved', details: undefined as any }),
    (error: { code?: string; details?: any }) => ({
      code: error.code ?? String(error),
      details: error.details,
    }),
  );
const spec = { region: 'nyc3', engine: 'pg', version: '15', size: 'medium', nodes: 1 };
const get = (resourceId: string): Promise<CloudResourceView> =>
  world.api.cloudResources.get(world.acme, { tenantId: world.acmeTenant, resourceId });
const discover = (who: 'acme' | 'other' = 'acme', poolId = world.acmePoolId) =>
  world.api.cloudResources.discover(world[who], {
    tenantId: who === 'acme' ? world.acmeTenant : world.otherTenant,
    poolId,
    kind: 'fake.database',
  });
const adopt = (providerId: string, extra: Record<string, unknown> = {}) =>
  world.api.cloudResources.adopt(world.acme, {
    tenantId: world.acmeTenant,
    poolId: world.acmePoolId,
    kind: 'fake.database',
    providerId,
    name: `adopted-${providerId}`,
    idempotencyKey: `adopt-${providerId}`,
    ...extra,
  });

beforeAll(async () => {
  world = await cloudResourcesWorld({ secrets: memorySecrets() });
});
afterAll(closeFixtures);

describe('cloudResources.discover', () => {
  it('lists the kind on the tenant’s own account, with who manages each and the resource recording it', async () => {
    const byHand = world.cloud.seed({ kind: 'fake.database', name: 'legacy', spec, owner: 'none' });
    const foreign = world.cloud.seed({
      kind: 'fake.database',
      name: 'theirs',
      spec,
      owner: 'other',
      labels: { 'better-compute-managed': 'true' },
    });
    const { items } = await discover();
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ providerId: byHand.id, name: 'legacy', region: 'nyc3', spec }),
        expect.objectContaining({ providerId: foreign.id, managedBy: 'other' }),
      ]),
    );
    expect(
      items.find((item: { providerId: string }) => item.providerId === byHand.id).managedBy,
    ).toBeUndefined();
  });

  it('is refused on a platform account offered to the tenant', async () => {
    expect(await failure(discover('acme', world.poolId))).toMatchObject({
      code: 'ACCESS_DENIED',
      details: { reason: 'notAccountOwner' },
    });
    expect((await failure(discover('other'))).code).toBe('NOT_FOUND');
  });
});

describe('cloudResources.adopt', () => {
  it('takes over an unmanaged resource: labels written, spec read back, then ready with sealed secrets', async () => {
    const legacy = world.cloud.seed({
      kind: 'fake.database',
      name: 'orders-legacy',
      spec,
      owner: 'none',
      password: 'pw-legacy-abcdefghijkl',
    });
    const adopted = await adopt(legacy.id, { name: 'orders' });
    expect(adopted).toMatchObject({
      kind: 'fake.database',
      family: 'data',
      name: 'orders',
      providerId: legacy.id,
      adopted: true,
      state: 'pending',
      spec: {},
    });
    await world.until(async () => (await get(adopted.id)).state === 'ready');
    const ready = await get(adopted.id);
    expect(ready.spec).toEqual(spec);
    expect(ready.secretOutputs.password).toMatch(/^secret:\/\//);
    expect(world.cloud.resources.get(legacy.id)!.labels).toMatchObject({
      'better-compute-managed': 'true',
      'better-compute-resource': adopted.id,
    });
    expect((await world.events('cloud.resource.adopted')).at(-1)!.data).toMatchObject({
      resourceId: adopted.id,
      providerId: legacy.id,
    });
    // Recorded once: a second adoption of it is CONFLICT, and discover names the resource.
    expect((await failure(adopt(legacy.id, { name: 'again', idempotencyKey: 'again' }))).code).toBe(
      'CONFLICT',
    );
    const listed = (await discover()).items.find(
      (item: { providerId: string }) => item.providerId === legacy.id,
    );
    expect(listed.resourceId).toBe(adopted.id);
    // Afterwards it is managed like any other: an update converges through ensure, in place.
    await world.api.cloudResources.update(world.acme, {
      tenantId: world.acmeTenant,
      resourceId: adopted.id,
      spec: { size: 'large' },
    });
    await world.until(async () => (await get(adopted.id)).state === 'ready');
    expect(world.cloud.resources.get(legacy.id)!.spec.size).toBe('large');
  });

  it('refuses a resource another deployment manages, one that does not exist, and a platform account', async () => {
    const foreign = world.cloud.seed({
      kind: 'fake.database',
      name: 'foreign',
      spec,
      owner: 'other',
      labels: { 'better-compute-managed': 'true' },
    });
    expect(await failure(adopt(foreign.id))).toMatchObject({
      code: 'INVALID_STATE',
      details: { reason: 'managedByAnother' },
    });
    expect((await failure(adopt('f-404'))).code).toBe('NOT_FOUND');
    expect(
      (await failure(adopt(foreign.id, { poolId: world.poolId, idempotencyKey: 'p' }))).code,
    ).toBe('ACCESS_DENIED');
    // Nothing was staged for the refused requests.
    expect(foreign.labels).toEqual({ 'better-compute-managed': 'true' });
  });
});

describe('cloudResources.release', () => {
  it('lets the resource go: labels removed, still running at the provider, the row released', async () => {
    const legacy = world.cloud.seed({
      kind: 'fake.database',
      name: 'to-release',
      spec,
      owner: 'none',
    });
    const adopted = await adopt(legacy.id);
    await world.until(async () => (await get(adopted.id)).state === 'ready');
    const releasing = await world.api.cloudResources.release(world.acme, {
      tenantId: world.acmeTenant,
      resourceId: adopted.id,
    });
    expect(releasing.state).toBe('ready');
    await world.until(async () => (await get(adopted.id)).state === 'released');
    const atProvider = world.cloud.resources.get(legacy.id)!;
    expect(atProvider.deleted).toBe(false);
    expect(atProvider.owner).toBe('none');
    expect(
      Object.keys(atProvider.labels).some((label) => label.startsWith('better-compute-')),
    ).toBe(false);
    expect((await get(adopted.id)).secretOutputs).toEqual({});
    // Released, it can be adopted again.
    const again = await adopt(legacy.id, { name: 'back', idempotencyKey: 'back' });
    expect(again.state).toBe('pending');
  });

  it('refuses a resource not yet at the provider', async () => {
    const created = await world.api.cloudResources.create(world.acme, {
      tenantId: world.acmeTenant,
      poolId: world.acmePoolId,
      kind: 'fake.app',
      name: 'fresh',
      spec: { image: 'nginx' },
      idempotencyKey: 'fresh',
    });
    expect(
      (
        await failure(
          world.api.cloudResources.release(world.acme, {
            tenantId: world.acmeTenant,
            resourceId: created.id,
          }),
        )
      ).code,
    ).toBe('INVALID_STATE');
  });
});
