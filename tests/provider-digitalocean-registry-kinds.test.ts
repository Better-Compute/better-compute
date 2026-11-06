import { beforeEach, describe, expect, it } from 'vitest';
import { isComputeError, type ComputeError } from '@better-compute/core';
import {
  managedNamePrefix,
  resetBudgets,
  type ContainerRegistryKind,
} from '@better-compute/provider-digitalocean';
import { registerRegistry, registryWorld, seedRegistry } from './support/do-emulator/registry.js';
import { storageWorld, type StorageWorld } from './support/do-storage-harness.js';

// The Container Registry kinds: registries (managed names, never deleted with images in them)
// and garbage collection as "collected within the last N hours".

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

// This deployment's registries are named bc-<deployment hash>-…; the request names bc-….
const own = managedNamePrefix('default');
const mineA = `${own}tenant-a`;
const theirs = `${managedNamePrefix('staging')}tenant-a`;

const world = (): Promise<StorageWorld> =>
  storageWorld(undefined, undefined, ({ emu }) => registerRegistry(emu));

describe('do.container-registry', () => {
  it('creates a registry once and reports its endpoint', async () => {
    const w = await world();
    const created = await w.ensure(
      'do.container-registry',
      'bc-tenant-a',
      { region: 'nyc3' },
      w.ctx(),
    );
    expect(created).toEqual({
      id: mineA,
      state: 'ready',
      outputs: {
        name: mineA,
        region: 'nyc3',
        endpoint: `registry.digitalocean.com/${mineA}`,
        storageUsageBytes: '0',
      },
    });
    expect(
      await w.ensure('do.container-registry', 'bc-tenant-a', { region: 'nyc3' }, w.ctx()),
    ).toEqual(created);
    expect(w.emu.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
    const moved = await failure(
      w.ensure('do.container-registry', 'bc-tenant-a', { region: 'ams3' }, w.ctx()),
    );
    expect(moved.details?.reason).toBe('replaceRequired');
  });

  it('maps the subscription limit to a refusal and requires a managed name', async () => {
    const w = await world();
    registryWorld(w.emu).registryLimit = 0;
    expect(
      (await failure(w.ensure('do.container-registry', 'bc-x', { region: 'nyc3' }, w.ctx())))
        .code,
    ).toBe('INVALID_INPUT');
    expect(
      (await failure(w.ensure('do.container-registry', 'acme', { region: 'nyc3' }, w.ctx())))
        .details?.reason,
    ).toBe('name');
  });

  it('deletes an empty managed registry and refuses the rest', async () => {
    const w = await world();
    await w.ensure('do.container-registry', 'bc-tenant-a', { region: 'nyc3' }, w.ctx());
    registryWorld(w.emu).repositories.set(mineA, [{ name: 'app', tag_count: 3 }]);
    const busy = await failure(w.resources.delete('do.container-registry', mineA, w.ctx()));
    expect(busy.details?.reason).toBe('registryNotEmpty');
    expect(registryWorld(w.emu).registries.has(mineA)).toBe(true);

    registryWorld(w.emu).repositories.set(mineA, []);
    expect((await w.resources.delete('do.container-registry', mineA, w.ctx())).state).toBe(
      'deleted',
    );
    expect(registryWorld(w.emu).registries.has(mineA)).toBe(false);
    expect((await w.resources.delete('do.container-registry', mineA, w.ctx())).state).toBe(
      'deleted',
    );

    seedRegistry(w.emu, { name: 'acme' });
    expect(
      (await failure(w.resources.delete('do.container-registry', 'acme', w.ctx()))).details?.reason,
    ).toBe('notManaged');
  });

  it("never deletes or takes another deployment's registry", async () => {
    const w = await world();
    seedRegistry(w.emu, { name: theirs });
    // So old a bc- name that carries no deployment at all is not this deployment's either.
    seedRegistry(w.emu, { name: 'bc-tenant-a' });
    for (const name of [theirs, 'bc-tenant-a']) {
      const refused = await failure(w.resources.delete('do.container-registry', name, w.ctx()));
      expect(refused.code).toBe('INVALID_STATE');
      expect(refused.details?.reason).toBe('managedByAnother');
      const taken = await failure(
        w.ensure('do.container-registry', 'bc-tenant-a', { region: 'nyc3' }, w.ctx(), { id: name }),
      );
      expect(taken.details?.reason).toBe('managedByAnother');
    }
    expect(registryWorld(w.emu).registries.has(theirs)).toBe(true);
    expect(w.emu.requests).toHaveLength(0);
    const found = [];
    for await (const entry of w.resources.discover('do.container-registry', w.ctx())) found.push(entry);
    expect(found.map((e) => [e.id, e.managedBy])).toEqual([
      [theirs, 'other'],
      ['bc-tenant-a', 'other'],
    ]);
  });

  it('derives a deployment-scoped name that fits 63 characters', async () => {
    const w = await world();
    const long = `bc-${'a'.repeat(60)}`;
    const created = await w.ensure('do.container-registry', long, { region: 'nyc3' }, w.ctx());
    expect(created.id.startsWith(own)).toBe(true);
    expect(created.id.length).toBeLessThanOrEqual(63);
    expect((await w.ensure('do.container-registry', long, { region: 'nyc3' }, w.ctx())).id).toBe(
      created.id,
    );
  });

  it('lists repositories and discovers registries', async () => {
    const w = await world();
    seedRegistry(w.emu, { name: 'acme' });
    seedRegistry(w.emu, { name: mineA });
    registryWorld(w.emu).repositories.set(mineA, [{ name: 'app', tag_count: 3 }]);
    const kind = w.resources.kinds().find((k) => k.kind === 'do.container-registry') as ContainerRegistryKind;
    const repos = [];
    for await (const repo of kind.repositories(mineA, w.ctx())) repos.push(repo);
    expect(repos).toEqual([{ name: 'app', tags: 3 }]);
    const found = [];
    for await (const entry of w.resources.discover('do.container-registry', w.ctx())) found.push(entry);
    expect(found.map((e) => [e.id, e.managedBy, e.region, e.spec])).toEqual([
      ['acme', undefined, 'nyc3', { region: 'nyc3' }],
      [mineA, 'this', 'nyc3', { region: 'nyc3' }],
    ]);
  });
});

describe('do.registry-garbage-collection', () => {
  it('starts one collection, follows it, and does not start another inside the window', async () => {
    const w = await world();
    seedRegistry(w.emu, { name: mineA });
    const spec = { registry: mineA, type: 'untagged-manifests' };
    const started = await w.ensure('do.registry-garbage-collection', 'bc-gc', spec, w.ctx(), { parent: mineA });
    expect(started.state).toBe('pending');
    const gcs = registryWorld(w.emu).collections.get(mineA)!;
    expect(gcs).toHaveLength(1);
    expect(gcs[0]!.type).toBe('untagged manifests only');
    expect(started.id).toBe(`${mineA}/${gcs[0]!.uuid}`);

    // Running: ensure adopts it.
    expect((await w.ensure('do.registry-garbage-collection', 'bc-gc', spec, w.ctx(), { parent: mineA })).id).toBe(
      started.id,
    );
    gcs[0]!.status = 'succeeded';
    gcs[0]!.freed_bytes = 1024;
    const done = await w.resources.get('do.registry-garbage-collection', started.id, w.ctx());
    expect(done).toMatchObject({ state: 'ready', outputs: { status: 'succeeded', freedBytes: '1024' } });
    // Done inside the window: still the same one.
    w.clock.advance(23 * 3_600_000);
    expect((await w.ensure('do.registry-garbage-collection', 'bc-gc', spec, w.ctx(), { parent: mineA })).state).toBe(
      'ready',
    );
    expect(gcs).toHaveLength(1);
    // Past the window: a new collection.
    w.clock.advance(2 * 3_600_000);
    const next = await w.ensure('do.registry-garbage-collection', 'bc-gc', spec, w.ctx(), { parent: mineA });
    expect(next.state).toBe('pending');
    expect(next.id).not.toBe(started.id);
    expect(gcs).toHaveLength(2);
  });

  it('reports a failed collection as an error, and cancels a running one on delete', async () => {
    const w = await world();
    seedRegistry(w.emu, { name: mineA });
    const spec = { registry: mineA };
    const started = await w.ensure('do.registry-garbage-collection', 'bc-gc', spec, w.ctx(), { parent: mineA });
    expect((await w.resources.delete('do.registry-garbage-collection', started.id, w.ctx())).state).toBe(
      'deleting',
    );
    const gc = registryWorld(w.emu).collections.get(mineA)![0]!;
    expect(gc.status).toBe('cancelled');
    expect((await w.resources.get('do.registry-garbage-collection', started.id, w.ctx()))?.state).toBe(
      'error',
    );
    expect((await w.resources.delete('do.registry-garbage-collection', started.id, w.ctx())).state).toBe(
      'deleted',
    );
  });

  it('never cancels a collection on a registry it does not manage', async () => {
    const w = await world();
    seedRegistry(w.emu, { name: 'acme' });
    const uuid = 'aaaaaaaa-0000-4000-8000-000000000002';
    registryWorld(w.emu).collections.set('acme', [
      { uuid, registry_name: 'acme', status: 'scanning manifests', created_at: '2026-11-05T09:00:00Z' },
    ]);
    const refused = await failure(
      w.resources.delete('do.registry-garbage-collection', `acme/${uuid}`, w.ctx()),
    );
    expect(refused.code).toBe('INVALID_STATE');
    expect(refused.details?.reason).toBe('notManaged');
    expect(registryWorld(w.emu).collections.get('acme')![0]!.status).toBe('scanning manifests');
    expect(w.emu.requests.some((r) => r.method === 'PUT')).toBe(false);
  });

  it('adopts a collection someone else started meanwhile', async () => {
    const w = await world();
    seedRegistry(w.emu, { name: mineA });
    registryWorld(w.emu).collections.set(mineA, [
      { uuid: 'aaaaaaaa-0000-4000-8000-000000000001', registry_name: mineA, status: 'scanning manifests', created_at: '2026-01-01T00:00:00Z' },
    ]);
    const state = await w.ensure('do.registry-garbage-collection', 'bc-gc', { registry: mineA }, w.ctx(), {
      parent: mineA,
    });
    expect(state).toMatchObject({ id: `${mineA}/aaaaaaaa-0000-4000-8000-000000000001`, state: 'pending' });
  });

  it('refuses an unmanaged or missing registry', async () => {
    const w = await world();
    seedRegistry(w.emu, { name: 'acme' });
    expect(
      (await failure(w.ensure('do.registry-garbage-collection', 'bc-gc', { registry: 'acme' }, w.ctx())))
        .code,
    ).toBe('INVALID_INPUT');
    expect(
      (
        await failure(
          w.ensure('do.registry-garbage-collection', 'bc-gc', { registry: `${own}none` }, w.ctx(), {
            parent: `${own}none`,
          }),
        )
      ).code,
    ).toBe('NOT_FOUND');
  });

  it("requires the parent registry, and never starts a collection on a registry it does not name", async () => {
    const w = await world();
    seedRegistry(w.emu, { name: mineA });
    seedRegistry(w.emu, { name: `${own}tenant-b` });
    seedRegistry(w.emu, { name: theirs });
    const noParent = await failure(
      w.ensure('do.registry-garbage-collection', 'bc-gc', { registry: mineA }, w.ctx()),
    );
    expect(noParent.code).toBe('INVALID_INPUT');
    expect(noParent.details?.reason).toBe('parent');
    // Tenant B's row names its own registry as the parent but the spec names tenant A's.
    const crossed = await failure(
      w.ensure('do.registry-garbage-collection', 'bc-gc', { registry: mineA }, w.ctx(), {
        parent: `${own}tenant-b`,
      }),
    );
    expect(crossed.code).toBe('INVALID_INPUT');
    expect(crossed.details?.reason).toBe('parent');
    const foreign = await failure(
      w.ensure('do.registry-garbage-collection', 'bc-gc', { registry: theirs }, w.ctx(), {
        parent: theirs,
      }),
    );
    expect(foreign.details?.reason).toBe('managedByAnother');
    expect(w.emu.requests.some((r) => r.method === 'POST' || r.method === 'PUT')).toBe(false);
    expect(registryWorld(w.emu).collections.get(mineA) ?? []).toHaveLength(0);
  });
});
