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

describe('an adoption whose takeover has not completed', () => {
  const row = async (resourceId: string) =>
    (
      await world.fixture.database.query<{ provisioned_at: unknown; ready_at: unknown }>(
        `SELECT provisioned_at, ready_at FROM cloud_resources WHERE id = $1`,
        [resourceId],
      )
    ).rows[0]!;

  it('a description change before the takeover still takes the resource over', async () => {
    const legacy = world.cloud.seed({ kind: 'fake.database', name: 'desc', spec, owner: 'none' });
    const adopted = await adopt(legacy.id);
    // It bills from its first ready, not from the adopt call.
    expect((await row(adopted.id)).provisioned_at).toBeNull();
    await world.api.cloudResources.update(world.acme, {
      tenantId: world.acmeTenant,
      resourceId: adopted.id,
      description: 'the orders database',
    });
    await world.until(async () => (await get(adopted.id)).state === 'ready');
    expect(world.cloud.calls).toContain(`adopt fake.database ${legacy.id}`);
    expect(await get(adopted.id)).toMatchObject({ spec, description: 'the orders database' });
    expect(legacy.labels['better-compute-resource']).toBe(adopted.id);
    expect((await row(adopted.id)).ready_at).not.toBeNull();
  });

  it('a spec change before the takeover is refused', async () => {
    const legacy = world.cloud.seed({ kind: 'fake.database', name: 'early', spec, owner: 'none' });
    const adopted = await adopt(legacy.id);
    expect(
      await failure(
        world.api.cloudResources.update(world.acme, {
          tenantId: world.acmeTenant,
          resourceId: adopted.id,
          spec: { size: 'large' },
        }),
      ),
    ).toMatchObject({ code: 'INVALID_STATE', details: { reason: 'adopting' } });
  });

  it('deleted before (or after a failed) takeover, it is let go here: nothing deleted at the provider, nothing billed', async () => {
    for (const failed of [false, true]) {
      const legacy = world.cloud.seed({
        kind: 'fake.database',
        name: `gone-${failed}`,
        spec,
        owner: 'none',
      });
      const adopted = await adopt(legacy.id, { idempotencyKey: `gone-${failed}` });
      if (failed) {
        // Another deployment took it meanwhile: the takeover is refused.
        legacy.owner = 'other';
        await world.until(async () => (await get(adopted.id)).state === 'error');
        legacy.owner = 'none';
      }
      await world.api.cloudResources.delete(world.acme, {
        tenantId: world.acmeTenant,
        resourceId: adopted.id,
      });
      await world.until(async () => (await get(adopted.id)).state === 'released');
      expect(world.cloud.calls).not.toContain(`delete fake.database ${legacy.id}`);
      expect(legacy.deleted).toBe(false);
      expect((await row(adopted.id)).provisioned_at).toBeNull();
      await world.tick('cloud.resources.usage', 1, 2 * 3_600_000);
      const windows = await world.fixture.database.query(
        `SELECT 1 FROM usage_windows WHERE source_kind = 'cloud-resource' AND source_id = $1`,
        [adopted.id],
      );
      expect(windows.rows).toEqual([]);
      // Recorded nowhere any more: it can be adopted again.
      expect((await adopt(legacy.id, { idempotencyKey: `gone-again-${failed}` })).state).toBe(
        'pending',
      );
    }
  });
});

describe('cloudResources.adopt: finding the resource', () => {
  it('asks the provider for the one resource: one past the discover cap is found, and nothing is listed', async () => {
    for (let index = 0; index < 501; index++)
      world.cloud.seed({ kind: 'fake.database', name: `filler-${index}`, spec, owner: 'none' });
    const last = world.cloud.seed({ kind: 'fake.database', name: 'past-cap', spec, owner: 'none' });
    const before = world.cloud.calls.length;
    const adopted = await adopt(last.id, { name: 'past-cap', idempotencyKey: 'past-cap' });
    expect(adopted.state).toBe('pending');
    expect(world.cloud.calls.slice(before)).toEqual([`get fake.database ${last.id}`]);
    const foreign = world.cloud.seed({
      kind: 'fake.database',
      name: 'foreign-get',
      spec,
      owner: 'other',
      labels: { 'better-compute-managed': 'true' },
    });
    expect(await failure(adopt(foreign.id, { idempotencyKey: 'foreign-get' }))).toMatchObject({
      code: 'INVALID_STATE',
      details: { reason: 'managedByAnother' },
    });
  });

  it('a kind whose get cannot say who manages it is looked up through discover', async () => {
    const foreign = world.cloud.seed({
      kind: 'fake.app',
      name: 'foreign-app',
      spec: { image: 'nginx', instances: 1 },
      owner: 'other',
      labels: { 'better-compute-managed': 'true' },
    });
    const app = (providerId: string, key: string) =>
      world.api.cloudResources.adopt(world.acme, {
        tenantId: world.acmeTenant,
        poolId: world.acmePoolId,
        kind: 'fake.app',
        providerId,
        name: key,
        idempotencyKey: key,
      });
    expect(await failure(app(foreign.id, 'foreign-app'))).toMatchObject({
      code: 'INVALID_STATE',
      details: { reason: 'managedByAnother' },
    });
    expect(world.cloud.calls).toContain('discover fake.app');
    const mine = world.cloud.seed({
      kind: 'fake.app',
      name: 'legacy-app',
      spec: { image: 'nginx', instances: 1 },
      owner: 'none',
    });
    expect((await app(mine.id, 'legacy-app')).state).toBe('pending');
  });
});

// Last: it tears down everything acme has.
describe('cloud-resources tenantDeleted: adopted resources', () => {
  it('releases what the tenant adopted (left running at the provider) and deletes what it created', async () => {
    const legacy = world.cloud.seed({
      kind: 'fake.database',
      name: 'production',
      spec,
      owner: 'none',
      password: 'pw-production-abcdefgh',
    });
    const adopted = await adopt(legacy.id, { name: 'production', idempotencyKey: 'production' });
    await world.until(async () => (await get(adopted.id)).state === 'ready');
    // A user made through better-compute in the adopted database, and an app of its own: both created here.
    const user = await world.api.cloudResources.create(world.acme, {
      tenantId: world.acmeTenant,
      poolId: world.acmePoolId,
      kind: 'fake.database-user',
      name: 'production-user',
      spec: { user: 'app' },
      parentId: adopted.id,
      idempotencyKey: 'production-user',
    });
    const app = await world.api.cloudResources.create(world.acme, {
      tenantId: world.acmeTenant,
      poolId: world.acmePoolId,
      kind: 'fake.app',
      name: 'teardown-app',
      spec: { image: 'nginx' },
      idempotencyKey: 'teardown-app',
    });
    await world.until(
      async () => (await get(user.id)).state === 'ready' && (await get(app.id)).state === 'ready',
    );
    const userProviderId = (await get(user.id)).providerId!;
    const appProviderId = (await get(app.id)).providerId!;

    const hook = world.module.tenantDeleted!;
    const context = world.fixture.compute.context;
    let answer = await hook(context, world.acmeTenant);
    expect(answer).toBe('SYNC_AGAIN');
    for (let round = 0; round < 20 && answer !== 'DONE'; round++) {
      await world.tick();
      answer = await hook(context, world.acmeTenant);
    }
    expect(answer).toBe('DONE');

    // The adopted database is let go: never deleted, its ownership labels taken off, still running.
    expect((await get(adopted.id)).state).toBe('released');
    expect(world.cloud.calls).not.toContain(`delete fake.database ${legacy.id}`);
    expect(world.cloud.calls).toContain(`release fake.database ${legacy.id}`);
    expect(legacy.deleted).toBe(false);
    expect(legacy.owner).toBe('none');
    expect(Object.keys(legacy.labels).some((label) => label.startsWith('better-compute-'))).toBe(
      false,
    );
    // What better-compute created is deleted, the user inside the adopted database included (before the release).
    expect((await get(user.id)).state).toBe('deleted');
    expect((await get(app.id)).state).toBe('deleted');
    expect(world.cloud.resources.get(userProviderId)!.deleted).toBe(true);
    expect(world.cloud.resources.get(appProviderId)!.deleted).toBe(true);
    expect(world.cloud.calls.indexOf(`delete fake.database-user ${userProviderId}`)).toBeLessThan(
      world.cloud.calls.indexOf(`release fake.database ${legacy.id}`),
    );
    const releasing = (await world.events('cloud.resource.releasing')).filter(
      (event) => event.data.resourceId === adopted.id,
    );
    expect(releasing.map((event) => event.data.reason)).toEqual(['tenant-deleted']);
    // The release never showed as a failure while the user was still being deleted.
    expect(
      (await world.events('cloud.resource.failed')).filter(
        (event) => event.data.resourceId === adopted.id,
      ),
    ).toEqual([]);
  });
});
