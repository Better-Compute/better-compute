import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ComputeError } from '@better-compute/core';
import { closeFixtures } from '@better-compute/testing';
import type { CloudResourceView } from '@better-compute/cloud-resources';
import { cloudResourcesWorld, type CloudResourcesWorld } from './support/cloud-resources-world.js';
import { memorySecrets, type MemorySecrets } from './support/memory-secrets.js';

// The cloud.resources reconciler against the fake provider: convergence, secret sealing in the run that received
// the secret, in-place updates, children before parents, errors and retries, deletion.

let world: CloudResourcesWorld;
let secrets: MemorySecrets;
let counter = 0;

const get = (resourceId: string): Promise<CloudResourceView> =>
  world.api.cloudResources.get(world.acme, { tenantId: world.acmeTenant, resourceId });
const create = (extra: Record<string, unknown> = {}): Promise<CloudResourceView> => {
  counter++;
  return world.api.cloudResources.create(world.acme, {
    tenantId: world.acmeTenant,
    poolId: world.poolId,
    kind: 'fake.database',
    name: `r${counter}`,
    spec: { region: 'nyc3', engine: 'pg', version: '16', size: 'small' },
    idempotencyKey: `rk-${counter}`,
    ...extra,
  });
};
const settled = (resourceId: string, state: string) =>
  world.until(async () => (await get(resourceId)).state === state);
const stateOf = async (resourceId: string) =>
  (
    await world.fixture.database.query<{ state: string }>(
      `SELECT state FROM cloud_resources WHERE id = $1`,
      [resourceId],
    )
  ).rows[0]!.state;
const forResource = async (prefix: string, resourceId: string) =>
  (await world.events(prefix)).filter((event) => event.data.resourceId === resourceId);

/** Everything the control plane keeps or says: rows, events and logs. */
async function everythingStored(): Promise<string> {
  const rows = await world.fixture.database.query(`SELECT * FROM cloud_resources`);
  const outbox = await world.fixture.database.query(`SELECT payload FROM outbox`);
  return JSON.stringify([rows.rows, outbox.rows, world.logs]);
}

beforeAll(async () => {
  secrets = memorySecrets();
  world = await cloudResourcesWorld({ secrets });
});
afterAll(closeFixtures);
beforeEach(() => {
  world.cloud.delayTicks = 1;
  world.cloud.refuse.clear();
  delete world.cloud.failNext;
});

describe('cloud.resources: convergence', () => {
  it('creates the resource at the provider with its ownership labels and records it ready with outputs', async () => {
    const created = await create({ name: 'ready-db' });
    await settled(created.id, 'ready');
    const ready = await get(created.id);
    expect(ready).toMatchObject({
      state: 'ready',
      outputs: { host: `${created.providerName}.db.fake`, port: '25060' },
    });
    expect(ready.providerId).toBeDefined();
    expect(ready.readyAt).toBeDefined();
    const atProvider = world.cloud.resources.get(ready.providerId!)!;
    expect(atProvider.name).toBe(created.providerName);
    expect(atProvider.labels).toEqual({
      'better-compute-managed': 'true',
      'better-compute-resource': created.id,
      'better-compute-tenant': world.acmeTenant,
    });
    // The idempotency key at the provider is the resource id: a lost answer never makes a second resource.
    expect(atProvider.idempotencyKey).toBe(created.id);
    const events = await forResource('cloud.resource.ready', created.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toMatchObject({
      outputs: ['host', 'port', 'uri'],
      secretOutputs: ['password'],
    });
  });

  it('secret outputs are sealed in the run that received them: only SecretRefs are stored or returned', async () => {
    const created = await create({ name: 'sealed-db' });
    await settled(created.id, 'ready');
    const ready = await get(created.id);
    const ref = ready.secretOutputs.password!;
    expect(ref).toMatch(/^secret:\/\//);
    const password = world.cloud.resources.get(ready.providerId!)!.password!;
    // The ref resolves to the provider's password, for the resource's tenant only.
    expect(await secrets.resolve(ref, { tenantId: world.acmeTenant })).toBe(password);
    await expect(secrets.resolve(ref, { tenantId: world.otherTenant })).rejects.toMatchObject({
      code: 'ACCESS_DENIED',
    });
    // No password the provider ever handed out is in a row, an event or a log line.
    const stored = await everythingStored();
    for (const handedOut of world.cloud.passwords) expect(stored).not.toContain(handedOut);
    // A refresh that reads the same password keeps the same ref (nothing re-sealed).
    const sealedBefore = secrets.values.size;
    await world.tick('cloud.resources', 1, 300_000);
    await world.tick('cloud.resources', 2);
    expect((await get(created.id)).secretOutputs.password).toBe(ref);
    expect(secrets.values.size).toBe(sealedBefore);
  });

  it('a rotated secret is sealed anew and the old ref destroyed', async () => {
    const created = await create({ name: 'rotate-db' });
    await settled(created.id, 'ready');
    const ready = await get(created.id);
    const old = ready.secretOutputs.password!;
    world.cloud.resources.get(ready.providerId!)!.password = 'pw-rotated-0123456789';
    await world.tick('cloud.resources', 1, 300_000);
    await world.tick('cloud.resources', 2);
    const after = await get(created.id);
    expect(after.secretOutputs.password).not.toBe(old);
    expect(await secrets.resolve(after.secretOutputs.password!)).toBe('pw-rotated-0123456789');
    expect(secrets.deleted).toContain(old);
    expect(await everythingStored()).not.toContain('pw-rotated-0123456789');
  });

  it('an updatable change converges in place and publishes updated', async () => {
    const created = await create({ name: 'grow-db' });
    await settled(created.id, 'ready');
    const providerId = (await get(created.id)).providerId!;
    const updating = await world.api.cloudResources.update(world.acme, {
      tenantId: world.acmeTenant,
      resourceId: created.id,
      spec: { size: 'large' },
    });
    expect(updating.state).toBe('updating');
    await settled(created.id, 'ready');
    expect(world.cloud.resources.get(providerId)!.spec.size).toBe('large');
    expect((await get(created.id)).providerId).toBe(providerId);
    expect(await forResource('cloud.resource.updat', created.id)).toEqual([
      expect.objectContaining({
        type: 'cloud.resource.updating',
        data: expect.objectContaining({ fields: ['size'] }),
      }),
      expect.objectContaining({ type: 'cloud.resource.updated' }),
    ]);
  });

  it('ensure says whose account it is: shared on a hosted pool, the tenant’s own on its BYO pool', async () => {
    const hosted = await create({ name: 'scope-hosted' });
    const own = await create({ name: 'scope-own', poolId: world.acmePoolId });
    await settled(hosted.id, 'ready');
    await settled(own.id, 'ready');
    expect(world.cloud.scopes.get(hosted.providerName)).toBe('shared');
    expect(world.cloud.scopes.get(own.providerName)).toBe('tenant');
  });

  it('a provider refusal is error (published once); a busy provider is retried later', async () => {
    world.cloud.refuse.add('fake.app');
    const app = await create({ kind: 'fake.app', name: 'refused', spec: { image: 'nginx' } });
    await settled(app.id, 'error');
    expect((await get(app.id)).message).toBe('refused by the fake');
    await world.tick('cloud.resources', 1, 300_000);
    await world.tick();
    expect(await forResource('cloud.resource.failed', app.id)).toHaveLength(1);
    world.cloud.refuse.clear();
    // The 5 min refresh retries an error.
    await world.tick('cloud.resources', 1, 300_000);
    await settled(app.id, 'ready');

    const busy = await create({ name: 'busy-db' });
    world.cloud.failNext = new ComputeError('RATE_LIMITED', 'slow down');
    await world.tick();
    expect((await get(busy.id)).state).toBe('pending');
    expect(world.logs.some((line) => line.includes('provider busy'))).toBe(true);
    await settled(busy.id, 'ready');
  });
});

describe('cloud.resources: children and deletion', () => {
  it('a child waits for its parent; deleting the parent deletes the child first, then the parent', async () => {
    world.cloud.delayTicks = 2;
    const database = await create({ name: 'parent-db' });
    const user = await create({
      kind: 'fake.database-user',
      name: 'app-user',
      spec: { user: 'app' },
      parentId: database.id,
    });
    await world.tick();
    // The database is still being created: the user is not asked for yet.
    expect(
      world.cloud.calls.filter((call) => call.startsWith('ensure fake.database-user')),
    ).toHaveLength(0);
    await settled(user.id, 'ready');
    const readyUser = await get(user.id);
    const parentId = (await get(database.id)).providerId!;
    expect(world.cloud.resources.get(readyUser.providerId!)!.parent).toBe(parentId);
    expect(readyUser.secretOutputs.password).toMatch(/^secret:\/\//);

    await world.api.cloudResources.delete(world.acme, {
      tenantId: world.acmeTenant,
      resourceId: database.id,
    });
    await settled(database.id, 'deleted');
    const userDeleted = world.cloud.calls.indexOf(
      `delete fake.database-user ${readyUser.providerId}`,
    );
    const databaseDeleted = world.cloud.calls.indexOf(`delete fake.database ${parentId}`);
    expect(userDeleted).toBeGreaterThanOrEqual(0);
    expect(databaseDeleted).toBeGreaterThan(userDeleted);
    expect((await get(user.id)).state).toBe('deleted');
    // Their sealed secrets are destroyed with them, and the refs no longer returned.
    expect(secrets.deleted).toContain(readyUser.secretOutputs.password);
    expect((await get(user.id)).secretOutputs).toEqual({});
    expect(
      await world.fixture.compute.authz.get('cloud-resource', database.id, world.acmeTenant),
    ).toBeUndefined();
    expect(await forResource('cloud.resource.deleted', database.id)).toHaveLength(1);
  });

  it('a resource the provider never accepted is deleted without a provider call', async () => {
    const created = await create({ name: 'never' });
    await world.api.cloudResources.delete(world.acme, {
      tenantId: world.acmeTenant,
      resourceId: created.id,
    });
    const before = world.cloud.calls.length;
    await settled(created.id, 'deleted');
    expect(world.cloud.calls.slice(before).filter((call) => call.startsWith('delete'))).toEqual([]);
  });

  it('a delete the provider refuses (not managed here) leaves the resource in error, never forgotten', async () => {
    const created = await create({ name: 'taken-db' });
    await settled(created.id, 'ready');
    const providerId = (await get(created.id)).providerId!;
    world.cloud.resources.get(providerId)!.owner = 'other';
    await world.api.cloudResources.delete(world.acme, {
      tenantId: world.acmeTenant,
      resourceId: created.id,
    });
    await settled(created.id, 'error');
    expect((await get(created.id)).message).toMatch(/not managed here/);
    expect(world.cloud.resources.get(providerId)!.deleted).toBe(false);
  });

  it('a deleted tenant’s resources are deleted at the provider; DONE once all are gone', async () => {
    const created = await world.api.cloudResources.create(world.other, {
      tenantId: world.otherTenant,
      poolId: world.poolId,
      kind: 'fake.app',
      name: 'tenant-gone',
      spec: { image: 'nginx' },
      idempotencyKey: 'tenant-gone',
    });
    await world.until(async () => (await stateOf(created.id)) === 'ready');
    const hook = world.module.tenantDeleted!;
    const context = world.fixture.compute.context;
    expect(await hook(context, world.otherTenant)).toBe('SYNC_AGAIN');
    let answer = 'SYNC_AGAIN';
    for (let round = 0; round < 10 && answer !== 'DONE'; round++) {
      await world.tick();
      answer = await hook(context, world.otherTenant);
    }
    expect(answer).toBe('DONE');
    expect(await stateOf(created.id)).toBe('deleted');
    expect(
      (await world.events('cloud.resource.deleting')).some(
        (event) => event.data.resourceId === created.id && event.data.reason === 'tenant-deleted',
      ),
    ).toBe(true);
  });
});
