import { beforeEach, describe, expect, it } from 'vitest';
import { isComputeError, type ComputeError } from '@better-compute/core';
import { resetBudgets, type ContainerRegistryKind } from '@better-compute/provider-digitalocean';
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
      id: 'bc-tenant-a',
      state: 'ready',
      outputs: {
        name: 'bc-tenant-a',
        region: 'nyc3',
        endpoint: 'registry.digitalocean.com/bc-tenant-a',
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
    registryWorld(w.emu).repositories.set('bc-tenant-a', [{ name: 'app', tag_count: 3 }]);
    const busy = await failure(w.resources.delete('do.container-registry', 'bc-tenant-a', w.ctx()));
    expect(busy.details?.reason).toBe('registryNotEmpty');
    expect(registryWorld(w.emu).registries.has('bc-tenant-a')).toBe(true);

    registryWorld(w.emu).repositories.set('bc-tenant-a', []);
    expect((await w.resources.delete('do.container-registry', 'bc-tenant-a', w.ctx())).state).toBe(
      'deleted',
    );
    expect(registryWorld(w.emu).registries.has('bc-tenant-a')).toBe(false);
    expect((await w.resources.delete('do.container-registry', 'bc-tenant-a', w.ctx())).state).toBe(
      'deleted',
    );

    seedRegistry(w.emu, { name: 'acme' });
    expect(
      (await failure(w.resources.delete('do.container-registry', 'acme', w.ctx()))).details?.reason,
    ).toBe('notManaged');
  });

  it('lists repositories and discovers registries', async () => {
    const w = await world();
    seedRegistry(w.emu, { name: 'acme' });
    seedRegistry(w.emu, { name: 'bc-tenant-a' });
    registryWorld(w.emu).repositories.set('bc-tenant-a', [{ name: 'app', tag_count: 3 }]);
    const kind = w.resources.kinds().find((k) => k.kind === 'do.container-registry') as ContainerRegistryKind;
    const repos = [];
    for await (const repo of kind.repositories('bc-tenant-a', w.ctx())) repos.push(repo);
    expect(repos).toEqual([{ name: 'app', tags: 3 }]);
    const found = [];
    for await (const entry of w.resources.discover('do.container-registry', w.ctx())) found.push(entry);
    expect(found.map((e) => [e.id, e.managedBy, e.region, e.spec])).toEqual([
      ['acme', undefined, 'nyc3', { region: 'nyc3' }],
      ['bc-tenant-a', 'this', 'nyc3', { region: 'nyc3' }],
    ]);
  });
});

describe('do.registry-garbage-collection', () => {
  it('starts one collection, follows it, and does not start another inside the window', async () => {
    const w = await world();
    seedRegistry(w.emu, { name: 'bc-tenant-a' });
    const spec = { registry: 'bc-tenant-a', type: 'untagged-manifests' };
    const started = await w.ensure('do.registry-garbage-collection', 'bc-gc', spec, w.ctx());
    expect(started.state).toBe('pending');
    const gcs = registryWorld(w.emu).collections.get('bc-tenant-a')!;
    expect(gcs).toHaveLength(1);
    expect(gcs[0]!.type).toBe('untagged manifests only');
    expect(started.id).toBe(`bc-tenant-a/${gcs[0]!.uuid}`);

    // Running: ensure adopts it.
    expect((await w.ensure('do.registry-garbage-collection', 'bc-gc', spec, w.ctx())).id).toBe(
      started.id,
    );
    gcs[0]!.status = 'succeeded';
    gcs[0]!.freed_bytes = 1024;
    const done = await w.resources.get('do.registry-garbage-collection', started.id, w.ctx());
    expect(done).toMatchObject({ state: 'ready', outputs: { status: 'succeeded', freedBytes: '1024' } });
    // Done inside the window: still the same one.
    w.clock.advance(23 * 3_600_000);
    expect((await w.ensure('do.registry-garbage-collection', 'bc-gc', spec, w.ctx())).state).toBe(
      'ready',
    );
    expect(gcs).toHaveLength(1);
    // Past the window: a new collection.
    w.clock.advance(2 * 3_600_000);
    const next = await w.ensure('do.registry-garbage-collection', 'bc-gc', spec, w.ctx());
    expect(next.state).toBe('pending');
    expect(next.id).not.toBe(started.id);
    expect(gcs).toHaveLength(2);
  });

  it('reports a failed collection as an error, and cancels a running one on delete', async () => {
    const w = await world();
    seedRegistry(w.emu, { name: 'bc-tenant-a' });
    const spec = { registry: 'bc-tenant-a' };
    const started = await w.ensure('do.registry-garbage-collection', 'bc-gc', spec, w.ctx());
    expect((await w.resources.delete('do.registry-garbage-collection', started.id, w.ctx())).state).toBe(
      'deleting',
    );
    const gc = registryWorld(w.emu).collections.get('bc-tenant-a')![0]!;
    expect(gc.status).toBe('cancelled');
    expect((await w.resources.get('do.registry-garbage-collection', started.id, w.ctx()))?.state).toBe(
      'error',
    );
    expect((await w.resources.delete('do.registry-garbage-collection', started.id, w.ctx())).state).toBe(
      'deleted',
    );
  });

  it('adopts a collection someone else started meanwhile', async () => {
    const w = await world();
    seedRegistry(w.emu, { name: 'bc-tenant-a' });
    registryWorld(w.emu).collections.set('bc-tenant-a', [
      { uuid: 'aaaaaaaa-0000-4000-8000-000000000001', registry_name: 'bc-tenant-a', status: 'scanning manifests', created_at: '2026-01-01T00:00:00Z' },
    ]);
    const state = await w.ensure('do.registry-garbage-collection', 'bc-gc', { registry: 'bc-tenant-a' }, w.ctx());
    expect(state).toMatchObject({ id: 'bc-tenant-a/aaaaaaaa-0000-4000-8000-000000000001', state: 'pending' });
  });

  it('refuses an unmanaged or missing registry', async () => {
    const w = await world();
    seedRegistry(w.emu, { name: 'acme' });
    expect(
      (await failure(w.ensure('do.registry-garbage-collection', 'bc-gc', { registry: 'acme' }, w.ctx())))
        .code,
    ).toBe('INVALID_INPUT');
    expect(
      (await failure(w.ensure('do.registry-garbage-collection', 'bc-gc', { registry: 'bc-none' }, w.ctx())))
        .code,
    ).toBe('NOT_FOUND');
  });
});
