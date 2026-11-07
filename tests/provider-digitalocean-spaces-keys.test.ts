import { beforeEach, describe, expect, it } from 'vitest';
import { isComputeError, type ComputeError } from '@better-compute/core';
import {
  bucketMarkerKey,
  deploymentTag,
  managedNamePrefix,
  resetBudgets,
  type DoStorageOptions,
} from '@better-compute/provider-digitalocean';
import { registerSpacesKeys, seedSpacesKey, spacesKeys } from './support/do-emulator/spaces-keys.js';
import { storageWorld, type StorageWorld } from './support/do-storage-harness.js';

// The `do.spaces-key` kind: Spaces access keys with per-bucket grants. The secret is a secret
// output of the create only; the id and grants are plain outputs. Grants are tenant isolation:
// a key grants only buckets this deployment manages for the caller's own tenant.

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

// This deployment's keys are named bc-<deployment hash>-…; requests name bc-….
const own = managedNamePrefix('default');

const tenantA = { 'better-compute-tenant': 'ten_a', 'better-compute-resource': 'crs_key_a' };
const tenantB = { 'better-compute-tenant': 'ten_b', 'better-compute-resource': 'crs_key_b' };

const world = (options: DoStorageOptions = {}) =>
  storageWorld(undefined, options, ({ emu, spaces }) => registerSpacesKeys(emu, spaces));

/** A bucket the kind made, marked for a tenant (none: the operator's). */
async function bucket(
  w: StorageWorld,
  name: string,
  tenant?: string,
): Promise<void> {
  await w.ensure('do.spaces-bucket', name, { region: 'nyc3' }, w.ctx(), {
    labels: {
      'better-compute-resource': `crs_${name}`,
      ...(tenant ? { 'better-compute-tenant': tenant } : {}),
    },
  });
}

const mutations = (w: StorageWorld) =>
  w.emu.requests.filter((r) => r.method === 'POST' || r.method === 'PUT' || r.method === 'DELETE');

describe('do.spaces-key', () => {
  it('creates a key once and returns its secret only from the create', async () => {
    const w = await world();
    await bucket(w, 'tenant-a-assets', 'ten_a');
    await bucket(w, 'tenant-a-logs', 'ten_a');
    const spec = { grants: ['nyc3/tenant-a-assets:readwrite', 'nyc3/tenant-a-logs:read'] };
    const first = await w.ensure('do.spaces-key', 'bc-key1', spec, w.ctx(), { labels: tenantA });
    expect(first.state).toBe('ready');
    expect(first.outputs).toEqual({
      accessKeyId: first.id,
      name: `${own}key1`,
      grants: 'tenant-a-assets:readwrite,tenant-a-logs:read',
    });
    expect(first.secretOutputs?.secretKey).toBe(w.spaces.keys.get(first.id));
    // The secret never sits in the plain outputs.
    expect(JSON.stringify(first.outputs)).not.toContain(first.secretOutputs!.secretKey);

    // The caller recorded the id with the sealed secret: the next pass keeps that key.
    const again = await w.ensure('do.spaces-key', 'bc-key1', spec, w.ctx(), {
      id: first.id,
      labels: tenantA,
    });
    expect(again.outputs).toEqual(first.outputs);
    expect(again.id).toBe(first.id);
    expect(again.secretOutputs).toBeUndefined();
    expect(spacesKeys(w.emu).size).toBe(1);
    const posts = w.emu.requests.filter((r) => r.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toEqual({
      name: `${own}key1`,
      grants: [
        { bucket: 'tenant-a-assets', permission: 'readwrite' },
        { bucket: 'tenant-a-logs', permission: 'read' },
      ],
    });
  });

  it('changes grants in place', async () => {
    const w = await world();
    await bucket(w, 'tenant-a-assets', 'ten_a');
    await bucket(w, 'tenant-a-logs', 'ten_a');
    const created = await w.ensure(
      'do.spaces-key',
      'bc-key1',
      { grants: ['nyc3/tenant-a-assets:read'] },
      w.ctx(),
      { labels: tenantA },
    );
    const changed = await w.ensure(
      'do.spaces-key',
      'bc-key1',
      { grants: ['nyc3/tenant-a-assets:readwrite', 'nyc3/tenant-a-logs:read'] },
      w.ctx(),
      { id: created.id, labels: tenantA },
    );
    expect(changed.id).toBe(created.id);
    expect(changed.outputs?.grants).toBe('tenant-a-assets:readwrite,tenant-a-logs:read');
    expect(spacesKeys(w.emu).get(created.id)!.grants).toEqual([
      { bucket: 'tenant-a-assets', permission: 'readwrite' },
      { bucket: 'tenant-a-logs', permission: 'read' },
    ]);
  });

  it("refuses a grant on another tenant's, the operator's, an unmarked or a missing bucket, sending nothing", async () => {
    const w = await world();
    await bucket(w, 'tenant-a-assets', 'ten_a');
    // The operator's bucket (a spacesBlobStore bucket it adopted): marked, with no tenant.
    await bucket(w, 'operator-blobs');
    w.spaces.seedBucket('hand-made');
    const staging = w.spaces.seedBucket('staging-assets');
    staging.objects.set(bucketMarkerKey, {
      body: new TextEncoder().encode(
        JSON.stringify({
          managedBy: 'better-compute',
          deployment: deploymentTag('staging'),
          tenant: 'ten_b',
        }),
      ),
    });
    const cases: [string, string][] = [
      ['nyc3/tenant-a-assets:readwrite', 'otherTenant'],
      ['nyc3/operator-blobs:read', 'otherTenant'],
      ['nyc3/hand-made:read', 'grantBucket'],
      ['nyc3/staging-assets:read', 'grantBucket'],
      ['nyc3/no-such-bucket:read', 'grantBucket'],
    ];
    for (const [grant, reason] of cases) {
      const refused = await failure(
        w.ensure('do.spaces-key', 'bc-key-b', { grants: [grant] }, w.ctx(), { labels: tenantB }),
      );
      expect([refused.code, refused.details?.reason], grant).toEqual(['ACCESS_DENIED', reason]);
    }
    expect(mutations(w)).toHaveLength(0);
    expect(spacesKeys(w.emu).size).toBe(0);

    // A regrant onto another tenant's bucket is refused before the PUT too.
    await bucket(w, 'tenant-b-assets', 'ten_b');
    const key = await w.ensure(
      'do.spaces-key',
      'bc-key-b',
      { grants: ['nyc3/tenant-b-assets:read'] },
      w.ctx(),
      { labels: tenantB },
    );
    const regrant = await failure(
      w.ensure(
        'do.spaces-key',
        'bc-key-b',
        { grants: ['nyc3/tenant-b-assets:read', 'nyc3/tenant-a-assets:readwrite'] },
        w.ctx(),
        { id: key.id, labels: tenantB },
      ),
    );
    expect(regrant.details?.reason).toBe('otherTenant');
    expect(w.emu.requests.some((r) => r.method === 'PUT')).toBe(false);
    expect(spacesKeys(w.emu).get(key.id)!.grants).toEqual([
      { bucket: 'tenant-b-assets', permission: 'read' },
    ]);
  });

  it('refuses full access unless the operator turns it on in code', async () => {
    const w = await world();
    const refused = await failure(
      w.ensure('do.spaces-key', 'bc-key1', { grants: ['*:fullaccess'] }, w.ctx(), { labels: tenantA }),
    );
    expect(refused.code).toBe('ACCESS_DENIED');
    expect(refused.details?.reason).toBe('fullAccess');
    expect(w.emu.requests).toHaveLength(0);
    expect(w.spaces.requests).toHaveLength(0);

    const operator = await world({ spacesKeyFullAccess: true });
    const key = await operator.ensure('do.spaces-key', 'bc-ops', { grants: ['*:fullaccess'] }, operator.ctx());
    expect(key.outputs?.grants).toBe('*:fullaccess');
    expect(spacesKeys(operator.emu).get(key.id)!.grants).toEqual([
      { bucket: '', permission: 'fullaccess' },
    ]);
  });

  it('never changes the grants of a key it does not manage, even when named by id', async () => {
    const w = await world();
    await bucket(w, 'tenant-a-assets', 'ten_a');
    const foreign = seedSpacesKey(w.emu, {
      name: 'ci-deploy',
      access_key: 'DOFOREIGN0001',
      grants: [{ bucket: 'ci-cache', permission: 'read' }],
    });
    const refused = await failure(
      w.ensure('do.spaces-key', 'bc-key1', { grants: ['nyc3/tenant-a-assets:read'] }, w.ctx(), {
        id: foreign.access_key,
        labels: tenantA,
      }),
    );
    expect(refused.code).toBe('INVALID_STATE');
    expect(refused.details?.reason).toBe('notManaged');
    expect(spacesKeys(w.emu).get('DOFOREIGN0001')!.grants).toEqual([
      { bucket: 'ci-cache', permission: 'read' },
    ]);
    expect(mutations(w)).toHaveLength(0);
  });

  it('a lost create answer still yields a secret on the next pass, and the lost key is deleted', async () => {
    let lose = true;
    const w = await storageWorld(undefined, {}, ({ emu, spaces }) => registerSpacesKeys(emu, spaces));
    // The same world, but the first POST /spaces/keys reaches DigitalOcean and its answer is lost.
    const lossy = await storageWorld(
      undefined,
      {
        fetch: async (input, init) => {
          const response = await w.emu.fetch(input, init);
          if (lose && init?.method === 'POST' && String(input).endsWith('/spaces/keys')) {
            lose = false;
            throw new TypeError('fetch failed');
          }
          return response;
        },
        spacesFetch: w.spaces.fetch,
      },
    );
    await bucket(w, 'tenant-a-assets', 'ten_a');
    const spec = { grants: ['nyc3/tenant-a-assets:read'] };
    const lost = await failure(lossy.ensure('do.spaces-key', 'bc-key1', spec, w.ctx(), { labels: tenantA }));
    expect(lost.code).toBe('UNAVAILABLE');
    const [orphan] = [...spacesKeys(w.emu).keys()];
    expect(orphan).toBeDefined();

    // The caller never recorded an id: the key found by name has a secret nobody holds.
    w.clock.advance(1000);
    const next = await lossy.ensure('do.spaces-key', 'bc-key1', spec, w.ctx(), { labels: tenantA });
    expect(next.secretOutputs?.secretKey).toBe(w.spaces.keys.get(next.id));
    expect(next.id).not.toBe(orphan);
    expect([...spacesKeys(w.emu).keys()]).toEqual([next.id]);
    // The orphan's credential no longer works.
    expect(w.spaces.keys.has(orphan!)).toBe(false);
  });

  it('two racing creates of one key leave exactly one live key', async () => {
    const w = await world();
    await bucket(w, 'tenant-a-assets', 'ten_a');
    const spec = { grants: ['nyc3/tenant-a-assets:read'] };
    // Two runs with no recorded id (a claim expired): each creates a key, then reaps.
    const [one, two] = await Promise.all([
      w.ensure('do.spaces-key', 'bc-k1', spec, w.ctx('r1'), { labels: tenantA }),
      w.ensure('do.spaces-key', 'bc-k1', spec, w.ctx('r2'), { labels: tenantA }),
    ]);
    const live = [...spacesKeys(w.emu).values()].filter((k) => k.name === `${own}k1`);
    expect(live).toHaveLength(1);
    const survivor = live[0]!.access_key as string;
    expect([one.id, two.id]).toContain(survivor);
    expect(await w.resources.get('do.spaces-key', survivor, w.ctx())).toBeDefined();
    expect(w.spaces.keys.has(survivor)).toBe(true);

    // The run that recorded the reaped key converges: its next pass makes a fresh key and the
    // older one goes.
    const loser = one.id === survivor ? two : one;
    expect(await w.resources.get('do.spaces-key', loser.id, w.ctx())).toBeUndefined();
    w.clock.advance(1000);
    const healed = await w.ensure('do.spaces-key', 'bc-k1', spec, w.ctx('r3'), {
      id: loser.id,
      labels: tenantA,
    });
    expect(healed.secretOutputs?.secretKey).toBe(w.spaces.keys.get(healed.id));
    expect([...spacesKeys(w.emu).values()].filter((k) => k.name === `${own}k1`).map((k) => k.access_key)).toEqual([
      healed.id,
    ]);
  });

  it('never reaps a key newer than its own', async () => {
    const w = await world();
    await bucket(w, 'tenant-a-assets', 'ten_a');
    w.clock.advance(60_000);
    // Another run's key, made after this run's create.
    const newer = { name: `${own}k2`, access_key: 'DONEWER00001', created_at: new Date(w.clock.now() + 5000).toISOString() };
    seedSpacesKey(w.emu, newer);
    const state = await w.ensure('do.spaces-key', 'bc-k2', { grants: ['nyc3/tenant-a-assets:read'] }, w.ctx(), {
      labels: tenantA,
    });
    expect(spacesKeys(w.emu).has('DONEWER00001')).toBe(true);
    expect(spacesKeys(w.emu).has(state.id)).toBe(true);
  });

  it('refuses an id that names another key of this deployment, sending nothing', async () => {
    const w = await world();
    await bucket(w, 'tenant-a-assets', 'ten_a');
    await bucket(w, 'tenant-b-assets', 'ten_b');
    const bKey = await w.ensure('do.spaces-key', 'bc-key-b', { grants: ['nyc3/tenant-b-assets:read'] }, w.ctx(), {
      labels: tenantB,
    });
    const before = mutations(w).length;
    // Tenant A's request carries tenant B's key id: its grants must not land on B's key.
    const refused = await failure(
      w.ensure('do.spaces-key', 'bc-key-a', { grants: ['nyc3/tenant-a-assets:readwrite'] }, w.ctx(), {
        id: bKey.id,
        labels: tenantA,
      }),
    );
    expect([refused.code, refused.details?.reason]).toEqual(['INVALID_STATE', 'idMismatch']);
    expect(mutations(w).slice(before)).toHaveLength(0);
    expect(spacesKeys(w.emu).get(bKey.id)!.grants).toEqual([
      { bucket: 'tenant-b-assets', permission: 'read' },
    ]);
  });

  it('reaps duplicate keys with its name after a create', async () => {
    const w = await world();
    await bucket(w, 'tenant-a-assets', 'ten_a');
    for (const access_key of ['DOYOUNGER0001', 'DOOLDER00001'])
      seedSpacesKey(w.emu, {
        name: `${own}dup`,
        access_key,
        grants: [{ bucket: 'tenant-a-assets', permission: 'read' }],
      });
    seedSpacesKey(w.emu, { name: `${own}other`, access_key: 'DOOTHER000001' });
    // The duplicates are older than the key the create makes.
    w.clock.advance(1000);
    const state = await w.ensure(
      'do.spaces-key',
      'bc-dup',
      { grants: ['nyc3/tenant-a-assets:read'] },
      w.ctx(),
      { labels: tenantA },
    );
    expect(state.secretOutputs?.secretKey).toBeDefined();
    expect([...spacesKeys(w.emu).keys()].sort()).toEqual(['DOOTHER000001', state.id].sort());
  });

  it('validates the spec and the name before any request', async () => {
    const w = await world();
    for (const grants of [
      [],
      ['Bad:read'],
      ['b-one:read'],
      ['nyc3/b-one:fullaccess'],
      ['*:read'],
      ['nyc3/b-one:write'],
      ['nyc3/Bad:read'],
    ])
      expect(
        (await failure(w.ensure('do.spaces-key', 'bc-key1', { grants }, w.ctx()))).code,
        JSON.stringify(grants),
      ).toBe('INVALID_INPUT');
    expect(
      (
        await failure(
          w.ensure('do.spaces-key', 'tenant-key', { grants: ['nyc3/b-one:read'] }, w.ctx()),
        )
      ).details?.reason,
    ).toBe('name');
    expect(w.emu.requests).toHaveLength(0);
  });

  it('gets, deletes, and refuses to delete a key it does not manage', async () => {
    const w = await world();
    await bucket(w, 'tenant-a-assets', 'ten_a');
    const created = await w.ensure(
      'do.spaces-key',
      'bc-key1',
      { grants: ['nyc3/tenant-a-assets:read'] },
      w.ctx(),
      { labels: tenantA },
    );
    const read = await w.resources.get('do.spaces-key', created.id, w.ctx());
    expect(read).toEqual({ id: created.id, state: 'ready', outputs: created.outputs });
    expect(await w.resources.delete('do.spaces-key', created.id, w.ctx())).toEqual({
      id: created.id,
      state: 'deleted',
    });
    expect(w.spaces.keys.has(created.id)).toBe(false);
    expect(await w.resources.get('do.spaces-key', created.id, w.ctx())).toBeUndefined();
    expect((await w.resources.delete('do.spaces-key', created.id, w.ctx())).state).toBe('deleted');

    const foreign = seedSpacesKey(w.emu, { name: 'ci-deploy', access_key: 'DOFOREIGN0001' });
    const refused = await failure(w.resources.delete('do.spaces-key', foreign.access_key, w.ctx()));
    expect(refused.code).toBe('INVALID_STATE');
    expect(refused.details?.reason).toBe('notManaged');
    expect(spacesKeys(w.emu).has('DOFOREIGN0001')).toBe(true);
  });

  it("never deletes or regrants another deployment's bc- key", async () => {
    const w = await world();
    await bucket(w, 'tenant-a-assets', 'ten_a');
    const theirs = seedSpacesKey(w.emu, {
      name: `${managedNamePrefix('staging')}key1`,
      access_key: 'DOSTAGING0001',
      grants: [{ bucket: 'b-one', permission: 'read' }],
    });
    // A bc- name with no deployment in it predates deployment-scoped names: not this one's either.
    const legacy = seedSpacesKey(w.emu, { name: 'bc-key1', access_key: 'DOLEGACY00001' });
    for (const key of [theirs, legacy]) {
      const refused = await failure(w.resources.delete('do.spaces-key', key.access_key, w.ctx()));
      expect(refused.code).toBe('INVALID_STATE');
      expect(refused.details?.reason).toBe('managedByAnother');
      const regrant = await failure(
        w.ensure('do.spaces-key', 'bc-key1', { grants: ['nyc3/tenant-a-assets:readwrite'] }, w.ctx(), {
          id: key.access_key,
          labels: tenantA,
        }),
      );
      expect(regrant.details?.reason).toBe('managedByAnother');
    }
    expect(spacesKeys(w.emu).has('DOSTAGING0001')).toBe(true);
    expect(spacesKeys(w.emu).has('DOLEGACY00001')).toBe(true);
    expect(mutations(w)).toHaveLength(0);
    const found = [];
    for await (const entry of w.resources.discover('do.spaces-key', w.ctx())) found.push(entry);
    expect(found.map((e) => [e.id, e.managedBy])).toEqual([
      ['DOSTAGING0001', 'other'],
      ['DOLEGACY00001', 'other'],
    ]);
  });

  it('discovers every key and marks the managed ones', async () => {
    const w = await world();
    seedSpacesKey(w.emu, { name: 'ci-deploy', access_key: 'DOFOREIGN0001' });
    seedSpacesKey(w.emu, { name: `${own}mine`, access_key: 'DOMINE000001' });
    const found = [];
    for await (const entry of w.resources.discover('do.spaces-key', w.ctx())) found.push(entry);
    expect(found.map((e) => [e.id, e.name, e.managedBy])).toEqual([
      ['DOFOREIGN0001', 'ci-deploy', undefined],
      ['DOMINE000001', `${own}mine`, 'this'],
    ]);
  });

  it('refuses an unknown kind', async () => {
    const w = await world();
    expect((await failure(w.ensure('do.nope', 'bc-x', {}, w.ctx()))).code).toBe(
      'UNSUPPORTED',
    );
  });
});
