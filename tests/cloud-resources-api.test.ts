import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeFixtures } from '@better-compute/testing';
import type { CloudResourceView } from '@better-compute/cloud-resources';
import { cloudResourcesWorld, type CloudResourcesWorld } from './support/cloud-resources-world.js';
import { memorySecrets } from './support/memory-secrets.js';

// cloudResources.kinds/create/list/get/update/delete and their refusals, through the real envelope (fake IAM,
// PGlite): the platform's pool offered to tenants (the hosted model), acme's own account (BYO), and a provider
// that serves no resources.

let world: CloudResourcesWorld;
let counter = 0;

type Who = 'root' | 'acme' | 'other';
const tenantOf = (who: Who) =>
  who === 'root' ? world.rootTenant : who === 'acme' ? world.acmeTenant : world.otherTenant;
const dbSpec = (extra: Record<string, unknown> = {}) => ({
  region: 'nyc3',
  engine: 'pg',
  version: '16',
  size: 'small',
  ...extra,
});
const body = (extra: Record<string, unknown> = {}, who: Who = 'acme') => {
  counter++;
  return {
    tenantId: tenantOf(who),
    poolId: world.poolId,
    kind: 'fake.database',
    name: `db${counter}`,
    spec: dbSpec(),
    idempotencyKey: `key-${counter}`,
    ...extra,
  };
};
const create = (
  extra: Record<string, unknown> = {},
  who: Who = 'acme',
): Promise<CloudResourceView> => world.api.cloudResources.create(world[who], body(extra, who));
const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => ({ code: 'resolved', message: '', details: undefined as any }),
    (error: { code?: string; message?: string; details?: any }) => ({
      code: error.code ?? String(error),
      message: error.message ?? '',
      details: error.details,
    }),
  );
const codeOf = async (promise: Promise<unknown>) => (await failure(promise)).code;
const projected = (resourceId: string, tenantId: string) =>
  world.fixture.compute.authz.get('cloud-resource', resourceId, tenantId);

beforeAll(async () => {
  world = await cloudResourcesWorld({ quotas: { 'fake.app': 2 }, secrets: memorySecrets() });
});
afterAll(closeFixtures);

describe('cloudResources.kinds', () => {
  it('lists what the pool’s provider serves, with spec schemas, quotas and preview availability', async () => {
    const { items } = await world.api.cloudResources.kinds(world.acme, {
      tenantId: world.acmeTenant,
      poolId: world.poolId,
    });
    expect(items.map((kind: { kind: string }) => kind.kind)).toEqual([
      'fake.database',
      'fake.database-user',
      'fake.app',
      'fake.agent',
    ]);
    const database = items.find((kind: { kind: string }) => kind.kind === 'fake.database');
    expect(database).toMatchObject({
      family: 'data',
      outputs: ['host', 'port', 'uri'],
      secretOutputs: ['password'],
      regional: true,
      updatable: ['size', 'nodes'],
      meters: [{ meter: 'fake.database.hours', unit: 'hour' }],
      preview: false,
      available: true,
      quota: 20,
    });
    expect(database.specSchema.properties.engine.enum).toEqual(['pg', 'mysql']);
    expect(items.find((kind: { kind: string }) => kind.kind === 'fake.app').quota).toBe(2);
    expect(items.find((kind: { kind: string }) => kind.kind === 'fake.database-user').parent).toBe(
      'fake.database',
    );
    // The platform account does not enable previews; acme's own account does.
    expect(items.find((kind: { kind: string }) => kind.kind === 'fake.agent')).toMatchObject({
      preview: true,
      available: false,
    });
    const own = await world.api.cloudResources.kinds(world.acme, {
      tenantId: world.acmeTenant,
      poolId: world.acmePoolId,
    });
    expect(own.items.find((kind: { kind: string }) => kind.kind === 'fake.agent').available).toBe(
      true,
    );
  });

  it('refuses a pool whose provider serves no resources, and a pool the tenant cannot see', async () => {
    expect(
      await codeOf(
        world.api.cloudResources.kinds(world.acme, {
          tenantId: world.acmeTenant,
          poolId: world.plainPoolId,
        }),
      ),
    ).toBe('UNSUPPORTED');
    expect(
      await codeOf(
        world.api.cloudResources.kinds(world.other, {
          tenantId: world.otherTenant,
          poolId: world.acmePoolId,
        }),
      ),
    ).toBe('NOT_FOUND');
  });
});

describe('cloudResources.create', () => {
  it('records the resource pending, publishes created and projects its kind and family for IAM', async () => {
    const created = await create({
      name: 'orders',
      description: 'Orders DB',
      idempotencyKey: 'orders-1',
    });
    expect(created).toMatchObject({
      tenantId: world.acmeTenant,
      poolId: world.poolId,
      providerAccountId: world.accountId,
      provider: 'fake-cloud',
      kind: 'fake.database',
      family: 'data',
      name: 'orders',
      description: 'Orders DB',
      region: 'nyc3',
      // The manifest's defaults are part of the stored spec.
      spec: { region: 'nyc3', engine: 'pg', version: '16', size: 'small', nodes: 1 },
      state: 'pending',
      outputs: {},
      secretOutputs: {},
      adopted: false,
      version: 1,
    });
    expect(created.id).toMatch(/^crs_/);
    expect(created.providerName).toMatch(/^bc-r-[a-z0-9]{24}$/);
    expect(await projected(created.id, world.acmeTenant)).toMatchObject({
      attributes: {
        kind: 'fake.database',
        family: 'data',
        provider: 'fake-cloud',
        providerAccountId: world.accountId,
        poolId: world.poolId,
        region: 'nyc3',
      },
    });
    const events = await world.events('cloud.resource.created');
    expect(events.at(-1)).toMatchObject({
      subject: `cloud-resource/${created.id}`,
      tenantId: world.acmeTenant,
      data: {
        resourceId: created.id,
        kind: 'fake.database',
        family: 'data',
        name: 'orders',
        region: 'nyc3',
      },
    });
  });

  it('replays a retried create; another request under the same key is CONFLICT', async () => {
    const input = body({ idempotencyKey: 'replay-1' });
    const first = await world.api.cloudResources.create(world.acme, input);
    const again = await world.api.cloudResources.create(world.acme, input);
    expect(again.id).toBe(first.id);
    expect(
      await codeOf(
        world.api.cloudResources.create(world.acme, { ...input, spec: dbSpec({ size: 'large' }) }),
      ),
    ).toBe('CONFLICT');
  });

  it('validates the spec with the kind’s manifest and the account’s regions', async () => {
    const bad = await failure(create({ spec: dbSpec({ engine: 'oracle' }) }));
    expect(bad.code).toBe('INVALID_INPUT');
    expect(bad.message).toMatch(/^spec\.engine: /);
    expect(bad.details).toMatchObject({ field: 'spec', kind: 'fake.database' });
    // sfo3 is a valid region of the kind, but not one the account works in.
    const region = await failure(create({ spec: dbSpec({ region: 'sfo3' }) }));
    expect(region.code).toBe('INVALID_INPUT');
    expect(region.details).toMatchObject({ field: 'spec.region', regions: ['nyc3', 'ams3'] });
    expect(await codeOf(create({ kind: 'fake.nothing' }))).toBe('UNSUPPORTED');
    expect(await codeOf(create({ poolId: world.plainPoolId }))).toBe('UNSUPPORTED');
    expect(await codeOf(create({ spec: [] as never }))).toBe('INVALID_INPUT');
    expect(await codeOf(create({ secret: 'x' }))).toBe('INVALID_INPUT');
  });

  it('refuses a preview kind unless the account enables previews', async () => {
    const refused = await failure(create({ kind: 'fake.agent', spec: { model: 'm' } }));
    expect(refused).toMatchObject({ code: 'UNSUPPORTED', details: { reason: 'preview' } });
    const own = await create({
      kind: 'fake.agent',
      spec: { model: 'm' },
      poolId: world.acmePoolId,
    });
    expect(own).toMatchObject({
      kind: 'fake.agent',
      family: 'ai',
      providerAccountId: world.acmeAccountId,
    });
  });

  it('keeps names unique per kind in the tenant, and counts the per-kind quota', async () => {
    await create({ kind: 'fake.app', name: 'web', spec: { image: 'nginx' } });
    expect(await codeOf(create({ kind: 'fake.app', name: 'web', spec: { image: 'nginx' } }))).toBe(
      'CONFLICT',
    );
    // Another kind may use the name, and so may another tenant.
    await create({ name: 'web' });
    await create({ kind: 'fake.app', name: 'web', spec: { image: 'nginx' } }, 'other');
    await create({ kind: 'fake.app', name: 'api', spec: { image: 'nginx' } });
    const over = await failure(
      create({ kind: 'fake.app', name: 'jobs', spec: { image: 'nginx' } }),
    );
    expect(over).toMatchObject({ code: 'QUOTA_EXCEEDED', details: { limit: 2, kind: 'fake.app' } });
  });

  it('a kind with a parent needs a parent of that kind on the same account', async () => {
    const database = await create({ name: 'users-db' });
    expect(await codeOf(create({ kind: 'fake.database-user', spec: { user: 'app' } }))).toBe(
      'INVALID_INPUT',
    );
    const app = (
      await world.api.cloudResources.list(world.acme, {
        tenantId: world.acmeTenant,
        kind: 'fake.app',
      })
    ).items[0];
    expect(
      await codeOf(create({ kind: 'fake.database-user', spec: { user: 'app' }, parentId: app.id })),
    ).toBe('INVALID_INPUT');
    expect(await codeOf(create({ parentId: database.id }))).toBe('INVALID_INPUT');
    // Another tenant's database is not found.
    expect(
      await codeOf(
        create(
          { kind: 'fake.database-user', spec: { user: 'app' }, parentId: database.id },
          'other',
        ),
      ),
    ).toBe('INVALID_INPUT');
    const user = await create({
      kind: 'fake.database-user',
      name: 'app',
      spec: { user: 'app' },
      parentId: database.id,
    });
    expect(user).toMatchObject({ parentId: database.id, family: 'data', state: 'pending' });
    expect(user.region).toBeUndefined();
  });
});

describe('cloudResources.get / list', () => {
  it('another tenant’s resource is not found; list filters by kind, family and pool', async () => {
    const created = await create({ name: 'lookup' });
    expect(
      (
        await world.api.cloudResources.get(world.acme, {
          tenantId: world.acmeTenant,
          resourceId: created.id,
        })
      ).id,
    ).toBe(created.id);
    expect(
      await codeOf(
        world.api.cloudResources.get(world.other, {
          tenantId: world.otherTenant,
          resourceId: created.id,
        }),
      ),
    ).toBe('NOT_FOUND');
    const platform = await world.api.cloudResources.list(world.acme, {
      tenantId: world.acmeTenant,
      family: 'platform',
    });
    expect(platform.items.length).toBeGreaterThan(0);
    expect(platform.items.every((item: CloudResourceView) => item.kind === 'fake.app')).toBe(true);
    const own = await world.api.cloudResources.list(world.acme, {
      tenantId: world.acmeTenant,
      poolId: world.acmePoolId,
    });
    expect(own.items.map((item: CloudResourceView) => item.kind)).toEqual(['fake.agent']);
  });
});

describe('cloudResources.update', () => {
  it('changes updatable fields and the description; any other field is replaceRequired', async () => {
    const created = await create({ name: 'resize' });
    const updated = await world.api.cloudResources.update(world.acme, {
      tenantId: world.acmeTenant,
      resourceId: created.id,
      spec: { size: 'large', nodes: 2 },
      description: 'bigger',
    });
    expect(updated).toMatchObject({
      spec: { region: 'nyc3', engine: 'pg', version: '16', size: 'large', nodes: 2 },
      description: 'bigger',
      version: 2,
    });
    const refused = await failure(
      world.api.cloudResources.update(world.acme, {
        tenantId: world.acmeTenant,
        resourceId: created.id,
        spec: { region: 'ams3', version: '17' },
      }),
    );
    expect(refused).toMatchObject({
      code: 'INVALID_STATE',
      details: {
        reason: 'replaceRequired',
        fields: ['region', 'version'],
        updatable: ['size', 'nodes'],
      },
    });
    const invalid = await failure(
      world.api.cloudResources.update(world.acme, {
        tenantId: world.acmeTenant,
        resourceId: created.id,
        spec: { nodes: 9 },
      }),
    );
    expect(invalid.code).toBe('INVALID_INPUT');
    const cleared = await world.api.cloudResources.update(world.acme, {
      tenantId: world.acmeTenant,
      resourceId: created.id,
      description: null,
    });
    expect(cleared.description).toBeUndefined();
    expect(cleared.version).toBe(3);
  });
});

describe('cloudResources.delete', () => {
  it('marks the resource and what lives in it for deletion; idempotent; then no update', async () => {
    const database = await create({ name: 'doomed' });
    const user = await create({
      kind: 'fake.database-user',
      name: 'u1',
      spec: { user: 'u1' },
      parentId: database.id,
    });
    const deleting = await world.api.cloudResources.delete(world.acme, {
      tenantId: world.acmeTenant,
      resourceId: database.id,
    });
    expect(deleting.state).toBe('deleting');
    const child = await world.api.cloudResources.get(world.acme, {
      tenantId: world.acmeTenant,
      resourceId: user.id,
    });
    expect(child.state).toBe('deleting');
    const again = await world.api.cloudResources.delete(world.acme, {
      tenantId: world.acmeTenant,
      resourceId: database.id,
    });
    expect(again.version).toBe(deleting.version);
    expect(
      await codeOf(
        world.api.cloudResources.update(world.acme, {
          tenantId: world.acmeTenant,
          resourceId: database.id,
          spec: { size: 'large' },
        }),
      ),
    ).toBe('INVALID_STATE');
    const reasons = (await world.events('cloud.resource.deleting')).filter(
      (event) => event.data.resourceId === database.id || event.data.resourceId === user.id,
    );
    expect(reasons.map((event) => event.data.reason).sort()).toEqual([
      'parent-deleted',
      'requested',
    ]);
  });
});
