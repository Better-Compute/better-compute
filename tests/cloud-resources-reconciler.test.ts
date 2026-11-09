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
  world.cloud.failAfterCreate.clear();
  delete world.cloud.failNext;
  world.cloud.loseAnswer.clear();
  world.cloud.during.clear();
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

  it('a secret sealed while the row changed meanwhile is kept: the version-guarded write missed, the secret is not lost', async () => {
    const created = await create({ name: 'race-seal-db' });
    await settled(created.id, 'ready');
    const ready = await get(created.id);
    const old = ready.secretOutputs.password!;
    world.cloud.resources.get(ready.providerId!)!.password = 'pw-minted-once-0123456789';
    // A description-only update lands between the provider's answer and the run's write (as the secret is sealed).
    const put = secrets.put;
    const made: string[] = [];
    secrets.put = async (tenantId, value) => {
      const ref = await put.call(secrets, tenantId, value);
      made.push(ref);
      if (made.length === 1)
        await world.api.cloudResources.update(world.acme, {
          tenantId: world.acmeTenant,
          resourceId: created.id,
          description: 'renamed meanwhile',
        });
      return ref;
    };
    try {
      await world.tick('cloud.resources', 1, 300_000);
      await world.tick('cloud.resources', 2);
    } finally {
      secrets.put = put;
    }
    const after = await get(created.id);
    // Sealed once, kept although the guarded write missed; only the superseded ref is destroyed.
    expect(made).toHaveLength(1);
    expect(after.secretOutputs.password).toBe(made[0]);
    expect(secrets.deleted).not.toContain(made[0]);
    expect(secrets.deleted).toContain(old);
    expect(await secrets.resolve(made[0]!)).toBe('pw-minted-once-0123456789');
    expect(after.description).toBe('renamed meanwhile');
  });

  it('a secret that could not be sealed drops the outdated ref, and ensure is told it is missing', async () => {
    const created = await create({ name: 'seal-fails-db' });
    await settled(created.id, 'ready');
    const ready = await get(created.id);
    const old = ready.secretOutputs.password!;
    world.cloud.resources.get(ready.providerId!)!.password = 'pw-unsealed-0123456789';
    const put = secrets.put;
    secrets.put = async () => {
      throw new ComputeError('UNAVAILABLE', 'the secret store is down');
    };
    try {
      await world.tick('cloud.resources', 1, 300_000);
      await world.tick('cloud.resources', 2);
    } finally {
      secrets.put = put;
    }
    const failed = await get(created.id);
    expect(failed.state).toBe('error');
    // The stored ref no longer matched the provider's secret: it is gone, never left pointing at a dead secret.
    expect(failed.secretOutputs.password).toBeUndefined();
    expect(secrets.deleted).toContain(old);
    expect(await everythingStored()).not.toContain('pw-unsealed-0123456789');
    // The next run says nothing is sealed (a key kind mints again), and seals what the provider answers.
    await world.tick('cloud.resources', 1, 300_000);
    await world.tick('cloud.resources', 2);
    expect(world.cloud.sealedNames.get(created.providerName)).toEqual([]);
    const healed = await get(created.id);
    expect(healed.state).toBe('ready');
    expect(await secrets.resolve(healed.secretOutputs.password!)).toBe('pw-unsealed-0123456789');
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

  it('ensure is handed the tenant networks the spec names by provider-side name, re-checked at run time', async () => {
    const network = async (id: string, tenantId: string) => {
      await world.fixture.database.query(`SET session_replication_role = replica`);
      try {
        await world.fixture.database.query(
          `INSERT INTO networks (id, tenant_id, pool_id, provider_account_id, name, state, desired_state,
                                 created_by, idempotency_key, request_hash, version)
           VALUES ($1, $2, $3, $4, $1, 'ready', 'present', 'idn_x', $1, '\\x00'::bytea, 1)`,
          [id, tenantId, world.poolId, world.accountId],
        );
      } finally {
        await world.fixture.database.query(`SET session_replication_role = DEFAULT`);
      }
      return id;
    };
    const ours = await network('net_aaaaaaaaaaaaaaaaaaaaaaaaaa', world.acmeTenant);
    const created = await create({
      name: 'on-net',
      spec: { region: 'nyc3', engine: 'pg', version: '16', size: 'small', tenantNetwork: ours },
    });
    await settled(created.id, 'ready');
    expect(world.cloud.networks.get(created.providerName)).toEqual({
      [ours]: 'bc-net-aaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    // A network that is no longer the tenant's by the time the reconciler runs: error, nothing sent.
    const moving = await network('net_bbbbbbbbbbbbbbbbbbbbbbbbbb', world.acmeTenant);
    const late = await create({
      name: 'late-net',
      spec: { region: 'nyc3', engine: 'pg', version: '16', size: 'small', tenantNetwork: moving },
    });
    await world.fixture.database.query(`UPDATE networks SET tenant_id = 'other' WHERE id = $1`, [
      moving,
    ]);
    await settled(late.id, 'error');
    expect((await get(late.id)).message).toContain(moving);
    expect(world.cloud.calls).not.toContain(`ensure fake.database ${late.providerName}`);
    // An adopted VPC shared with other tenants' machines (a project's default) is refused on a hosted pool.
    const shared = await network('net_cccccccccccccccccccccccccc', world.acmeTenant);
    await world.fixture.database.query(
      `UPDATE networks SET shared_tag_scoped = true, external_name = 'default-nyc3' WHERE id = $1`,
      [shared],
    );
    await expect(
      create({
        name: 'shared-net',
        spec: { region: 'nyc3', engine: 'pg', version: '16', size: 'small', tenantNetwork: shared },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT', details: { reason: 'network' } });
  });

  it('a spec SecretRef resolves only as the tenant’s own secret://<tenant>/… ref, whatever the store would serve', async () => {
    // A store that would hand these to acme: the module must not rely on the store's own scoping.
    const store = secrets.values as Map<string, { tenantId: string; value: string }>;
    store.set('env://CONTROL_PLANE_KEY', {
      tenantId: world.acmeTenant,
      value: 'control-plane-key',
    });
    store.set(`secret://${world.otherTenant}/theirs`, {
      tenantId: world.acmeTenant,
      value: 'other-value',
    });
    store.set('vault://platform/db', { tenantId: world.acmeTenant, value: 'vault-value' });
    store.set(`secret://${world.acmeTenant}/mine`, {
      tenantId: world.acmeTenant,
      value: 'acme-own',
    });
    const app = (name: string, secret: string) =>
      create({ kind: 'fake.app', name, spec: { image: 'nginx', secret } });
    const own = await app('ref-own', `secret://${world.acmeTenant}/mine`);
    const refused = [
      await app('ref-env', 'env://CONTROL_PLANE_KEY'),
      await app('ref-other', `secret://${world.otherTenant}/theirs`),
      await app('ref-vault', 'vault://platform/db'),
    ];
    await settled(own.id, 'ready');
    expect(world.cloud.resolved.get(own.providerName)).toBe('acme-own');
    for (const resource of refused) {
      await settled(resource.id, 'error');
      expect((await get(resource.id)).message).toContain('own secrets');
    }
    expect([...world.cloud.resolved.values()]).toEqual(['acme-own']);
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
    // No ensure was ever sent for it: not even a lookup.
    expect(
      world.cloud.calls.slice(before).filter((call) => /^(delete|find)/.test(call)),
    ).toEqual([]);
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

describe('cloud.resources: a resource the provider made is never forgotten', () => {
  const row = async (resourceId: string) =>
    (
      await world.fixture.database.query<{
        state: string;
        desired_state: string;
        provider_id: string | null;
        deleted_at: Date | null;
      }>(`SELECT state, desired_state, provider_id, deleted_at FROM cloud_resources WHERE id = $1`, [
        resourceId,
      ])
    ).rows[0]!;
  const atProvider = (resourceId: string) =>
    [...world.cloud.resources.values()].find((entry) => entry.idempotencyKey === resourceId);
  const remove = (resourceId: string) =>
    world.api.cloudResources.delete(world.acme, { tenantId: world.acmeTenant, resourceId });

  it('an error that carries the provider id records it, and a delete then deletes it at the provider', async () => {
    const app = await create({ kind: 'fake.app', name: 'failed-deploy', spec: { image: 'nginx' } });
    world.cloud.failAfterCreate.add(app.providerName);
    await settled(app.id, 'error');
    const made = atProvider(app.id)!;
    expect(made).toBeDefined();
    expect((await row(app.id)).provider_id).toBe(made.id);
    await remove(app.id);
    await settled(app.id, 'deleted');
    expect(world.cloud.calls).toContain(`delete fake.app ${made.id}`);
    expect(made.deleted).toBe(true);
  });

  it('a create the provider accepted whose answer was lost is found by its key and deleted', async () => {
    const database = await create({ name: 'lost-answer' });
    world.cloud.loseAnswer.set(database.providerName, new ComputeError('UNAVAILABLE', 'timed out'));
    await world.tick();
    const made = atProvider(database.id)!;
    expect(made).toBeDefined();
    expect(await row(database.id)).toMatchObject({ state: 'pending', provider_id: null });
    await remove(database.id);
    await settled(database.id, 'deleted');
    expect(world.cloud.calls).toContain(`find fake.database ${database.providerName}`);
    expect(world.cloud.calls).toContain(`delete fake.database ${made.id}`);
    expect(made.deleted).toBe(true);
    expect((await row(database.id)).provider_id).toBe(made.id);
  });

  it('a sent create the provider never made is looked up, then finished with no delete', async () => {
    const database = await create({ name: 'never-made' });
    // As a run that recorded the ensure as sent and then lost the connection before the provider got it.
    await world.fixture.database.query(
      `UPDATE cloud_resources SET ensure_sent_at = now() WHERE id = $1`,
      [database.id],
    );
    expect(atProvider(database.id)).toBeUndefined();
    await remove(database.id);
    const before = world.cloud.calls.length;
    await settled(database.id, 'deleted');
    const calls = world.cloud.calls.slice(before);
    expect(calls).toContain(`find fake.database ${database.providerName}`);
    // Nothing was ever made for it: no ensure, no provider id, so no delete of its own.
    expect(calls).not.toContain(`ensure fake.database ${database.providerName}`);
    expect((await row(database.id)).provider_id).toBeNull();
    expect(atProvider(database.id)).toBeUndefined();
  });

  it('a provider id answered after another run finished the row brings it back to be deleted', async () => {
    const app = await create({ kind: 'fake.app', name: 'late-answer', spec: { image: 'nginx' } });
    // Another run (after this one's claim expired) finishes the row while this one's create is in flight.
    world.cloud.during.set(app.providerName, async () => {
      await world.fixture.database.query(
        `UPDATE cloud_resources SET desired_state = 'deleted', state = 'deleted', deleted_at = now(),
                version = version + 1 WHERE id = $1`,
        [app.id],
      );
    });
    await world.tick();
    const made = atProvider(app.id)!;
    expect(made).toBeDefined();
    expect(await row(app.id)).toMatchObject({
      provider_id: made.id,
      desired_state: 'deleted',
      state: 'deleting',
      deleted_at: null,
    });
    await world.until(async () => (await stateOf(app.id)) === 'deleted');
    expect(world.cloud.calls).toContain(`delete fake.app ${made.id}`);
    expect(made.deleted).toBe(true);
  });

  it('no ensure is sent for a row deleted after the run read it', async () => {
    const app = await create({ kind: 'fake.app', name: 'deleted-first', spec: { image: 'nginx' } });
    await remove(app.id);
    await settled(app.id, 'deleted');
    expect(world.cloud.calls).not.toContain(`ensure fake.app ${app.providerName}`);
  });
});

describe('cloud.resources: one provider resource, one live row', () => {
  const user = (parentId: string, name: string, login: string, key = name) =>
    world.api.cloudResources.create(world.acme, {
      tenantId: world.acmeTenant,
      poolId: world.poolId,
      kind: 'fake.database-user',
      name,
      spec: { user: login },
      parentId,
      idempotencyKey: `id-${key}`,
    });
  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => ({ code: 'resolved', details: undefined as any }),
      (error: { code?: string; details?: any }) => ({ code: error.code, details: error.details }),
    );

  it('a second live child with the same identity in one parent is CONFLICT; free again once the first is gone', async () => {
    const database = await create({ name: 'ident-db' });
    const other = await create({ name: 'ident-db-2' });
    const first = await user(database.id, 'ident-a', 'app');
    expect(await failure(user(database.id, 'ident-b', 'app'))).toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'identity', resourceId: first.id },
    });
    // Another parent, or another identity, is a resource of its own.
    await user(other.id, 'ident-c', 'app');
    await user(database.id, 'ident-d', 'reporting');
    await world.api.cloudResources.delete(world.acme, {
      tenantId: world.acmeTenant,
      resourceId: first.id,
    });
    await settled(first.id, 'deleted');
    const again = await user(database.id, 'ident-e', 'app');
    expect(again.state).toBe('pending');
  });

  it('a row the provider answers another row’s id for goes to error; the first keeps it', async () => {
    const database = await create({ name: 'dup-db' });
    const first = await user(database.id, 'dup-a', 'app');
    await settled(first.id, 'ready');
    const providerId = (await get(first.id)).providerId!;
    // A row the identity check never saw (made before it existed): the provider answers the first one's user.
    const db = world.fixture.database;
    const dup = 'crs_duplicaterowfortest0000';
    await db.query(
      `INSERT INTO cloud_resources (id, tenant_id, project_id, pool_id, provider_account_id, provider, kind, family,
                                    name, description, region, parent_id, spec, provider_name, state, desired_state,
                                    created_by, idempotency_key, request_hash, version)
       SELECT $2, tenant_id, project_id, pool_id, provider_account_id, provider, kind, family, 'dup-b', NULL, region,
              parent_id, spec, 'bc-r-duplicaterow', 'pending', 'present', created_by, 'dup-b', request_hash, 1
         FROM cloud_resources WHERE id = $1`,
      [first.id, dup],
    );
    await world.fixture.compute.context.sql.transaction((tx) =>
      world.fixture.compute.context.work.enqueue(tx, 'cloud.resources', dup),
    );
    await world.until(async () => (await stateOf(dup)) === 'error');
    const row = (
      await db.query<{ message: string; provider_id: string | null; secret_outputs: unknown }>(
        `SELECT message, provider_id, secret_outputs FROM cloud_resources WHERE id = $1`,
        [dup],
      )
    ).rows[0]!;
    expect(row.message).toBe(`Another cloud resource already manages ${providerId}`);
    expect(row.provider_id).toBeNull();
    // It never holds a secret of the first one's user.
    expect(row.secret_outputs).toEqual({});
    expect((await get(first.id)).state).toBe('ready');
  });
});

describe('cloud.resources: a child the parent’s delete did not see', () => {
  it('a live child under a parent being deleted is deleted too, so the parent never waits on it forever', async () => {
    const database = await create({ name: 'missed-db' });
    await settled(database.id, 'ready');
    const child = await world.api.cloudResources.create(world.acme, {
      tenantId: world.acmeTenant,
      poolId: world.poolId,
      kind: 'fake.database-user',
      name: 'missed-user',
      spec: { user: 'missed' },
      parentId: database.id,
      idempotencyKey: 'missed-user',
    });
    await settled(child.id, 'ready');
    await world.api.cloudResources.delete(world.acme, {
      tenantId: world.acmeTenant,
      resourceId: database.id,
    });
    // As a create that committed under the parent after its delete marked the tree.
    await world.fixture.database.query(
      `UPDATE cloud_resources SET desired_state = 'present', state = 'ready' WHERE id = $1`,
      [child.id],
    );
    await settled(database.id, 'deleted');
    expect(await stateOf(child.id)).toBe('deleted');
    const providerId = (await get(child.id)).providerId!;
    expect(world.cloud.calls).toContain(`delete fake.database-user ${providerId}`);
  });
});

describe('cloud.resources: retries back off', () => {
  const retry = async (resourceId: string) =>
    (
      await world.fixture.database.query<{ attempts: number; waits: boolean }>(
        `SELECT attempts, next_attempt_at > compute_now() AS waits FROM cloud_resources WHERE id = $1`,
        [resourceId],
      )
    ).rows[0]!;

  it('a delete the provider refuses for good is asked again at growing intervals, not on every sweep', async () => {
    const created = await create({ name: 'refused-delete' });
    await settled(created.id, 'ready');
    const providerId = (await get(created.id)).providerId!;
    const line = `delete fake.database ${providerId}`;
    const asked = () => world.cloud.calls.filter((call) => call === line).length;
    // Another deployment took it: every delete is refused (not managed here).
    world.cloud.resources.get(providerId)!.owner = 'other';
    await world.api.cloudResources.delete(world.acme, {
      tenantId: world.acmeTenant,
      resourceId: created.id,
    });
    await settled(created.id, 'error');
    expect(asked()).toBe(1);
    expect(await retry(created.id)).toMatchObject({ attempts: 1, waits: true });
    // Twenty minutes of 30 s sweeps (and four 5 min refreshes): 30 s, 1, 2, 4 and 8 minutes apart, not forty times.
    await world.tick('cloud.resources', 40, 30_000);
    expect(asked()).toBeGreaterThanOrEqual(4);
    expect(asked()).toBeLessThanOrEqual(7);
    expect((await retry(created.id)).attempts).toBe(asked());
    expect(await stateOf(created.id)).toBe('error');
    // The wait never grows past an hour: once the cause is gone, the delete goes through at the next attempt.
    const before = asked();
    world.cloud.resources.get(providerId)!.owner = 'this';
    await world.tick('cloud.resources', 3, 30 * 60_000);
    await settled(created.id, 'deleted');
    expect(asked()).toBeGreaterThan(before);
    expect(world.cloud.resources.get(providerId)!.deleted).toBe(true);
  });

  it('marking the resource again starts the count over, and does not wait', async () => {
    const created = await create({ name: 'refused-then-fixed' });
    await settled(created.id, 'ready');
    const providerId = (await get(created.id)).providerId!;
    world.cloud.resources.get(providerId)!.owner = 'other';
    await world.api.cloudResources.delete(world.acme, {
      tenantId: world.acmeTenant,
      resourceId: created.id,
    });
    await settled(created.id, 'error');
    await world.tick('cloud.resources', 10, 30_000);
    expect((await retry(created.id)).attempts).toBeGreaterThan(1);
    // Wanted again, then deleted again (as after a release that was withdrawn): the count starts over.
    await world.fixture.database.query(
      `UPDATE cloud_resources SET desired_state = 'present', state = 'error' WHERE id = $1`,
      [created.id],
    );
    world.cloud.resources.get(providerId)!.owner = 'this';
    await world.api.cloudResources.delete(world.acme, {
      tenantId: world.acmeTenant,
      resourceId: created.id,
    });
    expect(await retry(created.id)).toMatchObject({ attempts: 0, waits: null });
    await settled(created.id, 'deleted');
  });

  it('a busy provider is asked again when it says (retryAfterMs), not after the fixed 30 s, and not by the sweep', async () => {
    const created = await create({ name: 'told-to-wait' });
    // The provider accepts the create and answers 429 with its own wait.
    world.cloud.loseAnswer.set(
      created.providerName,
      new ComputeError('RATE_LIMITED', 'slow down', undefined, { retryAfterMs: 120_000 }),
    );
    const line = `ensure fake.database ${created.providerName}`;
    const asked = () => world.cloud.calls.filter((call) => call === line).length;
    await world.tick();
    expect(asked()).toBe(1);
    expect(await stateOf(created.id)).toBe('pending');
    // 100 s of sweeps: the provider said two minutes.
    await world.tick('cloud.resources', 10, 10_000);
    expect(asked()).toBe(1);
    await world.tick('cloud.resources', 3, 10_000);
    expect(asked()).toBeGreaterThan(1);
    await settled(created.id, 'ready');
    expect(await retry(created.id)).toMatchObject({ attempts: 0, waits: null });
  });

  it('a wait the provider names is kept between 30 s and an hour', async () => {
    for (const [said, low, high] of [
      [0, 20_000, 40_000],
      [86_400_000, 3_590_000, 3_610_000],
    ] as const) {
      const created = await create({ name: `wait-${said}` });
      world.cloud.loseAnswer.set(
        created.providerName,
        new ComputeError('UNAVAILABLE', 'later', undefined, { retryAfterMs: said }),
      );
      await world.tick();
      const { rows } = await world.fixture.database.query<{ wait: string }>(
        `SELECT (extract(epoch FROM next_attempt_at - compute_now()) * 1000)::bigint::text AS wait
           FROM cloud_resources WHERE id = $1`,
        [created.id],
      );
      expect(Number(rows[0]!.wait)).toBeGreaterThanOrEqual(low);
      expect(Number(rows[0]!.wait)).toBeLessThanOrEqual(high);
      await world.api.cloudResources.delete(world.acme, {
        tenantId: world.acmeTenant,
        resourceId: created.id,
      });
    }
  });
});

describe('cloud-resources tenantDeleted', () => {
  it('marks at most 100 of a deleted tenant’s resources per call, SYNC_AGAIN until all are gone', async () => {
    const seed = await world.api.cloudResources.create(world.other, {
      tenantId: world.otherTenant,
      poolId: world.poolId,
      kind: 'fake.app',
      name: 'batch-seed',
      spec: { image: 'nginx' },
      idempotencyKey: 'batch-seed',
    });
    const db = world.fixture.database;
    // Rows the provider never accepted (no provider id): the reconciler finishes them without a call.
    await db.query(
      `INSERT INTO cloud_resources (id, tenant_id, project_id, pool_id, provider_account_id, provider, kind, family,
                                    name, spec, provider_name, state, desired_state, created_by, idempotency_key,
                                    request_hash, version)
       SELECT 'crs_batch' || lpad(n::text, 4, '0'), tenant_id, project_id, pool_id, provider_account_id, provider,
              kind, family, 'batch-' || n, spec, 'bc-r-batch' || n, 'pending', 'present', created_by,
              'batch-' || n, request_hash, 1
         FROM cloud_resources, generate_series(1, 150) AS n WHERE id = $1`,
      [seed.id],
    );
    const marked = async () =>
      Number(
        (
          await db.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM cloud_resources
              WHERE tenant_id = $1 AND desired_state = 'deleted'`,
            [world.otherTenant],
          )
        ).rows[0]!.count,
      );
    const before = await marked();
    const hook = world.module.tenantDeleted!;
    const context = world.fixture.compute.context;
    expect(await hook(context, world.otherTenant)).toBe('SYNC_AGAIN');
    expect((await marked()) - before).toBe(100);
    expect(await hook(context, world.otherTenant)).toBe('SYNC_AGAIN');
    expect((await marked()) - before).toBe(151);
    let answer = 'SYNC_AGAIN';
    for (let round = 0; round < 10 && answer !== 'DONE'; round++) {
      await world.tick();
      answer = await hook(context, world.otherTenant);
    }
    expect(answer).toBe('DONE');
  });
});
