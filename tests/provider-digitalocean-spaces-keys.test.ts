import { beforeEach, describe, expect, it } from 'vitest';
import { isComputeError, type ComputeError } from '@better-compute/core';
import { resetBudgets } from '@better-compute/provider-digitalocean';
import { registerSpacesKeys, seedSpacesKey, spacesKeys } from './support/do-emulator/spaces-keys.js';
import { storageWorld } from './support/do-storage-harness.js';

// The `do.spaces-key` kind: Spaces access keys with per-bucket grants. The secret is a secret
// output of the create only; the id and grants are plain outputs.

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

const world = () =>
  storageWorld(undefined, undefined, ({ emu, spaces }) => registerSpacesKeys(emu, spaces));

describe('do.spaces-key', () => {
  it('creates a key once and returns its secret only from the create', async () => {
    const w = await world();
    const spec = { grants: ['tenant-a-assets:readwrite', 'tenant-a-logs:read'] };
    const first = await w.ensure('do.spaces-key', 'bc-key1', spec, w.ctx());
    expect(first.state).toBe('ready');
    expect(first.outputs).toEqual({
      accessKeyId: first.id,
      name: 'bc-key1',
      grants: 'tenant-a-assets:readwrite,tenant-a-logs:read',
    });
    expect(first.secretOutputs?.secretKey).toBe(w.spaces.keys.get(first.id));
    // The secret never sits in the plain outputs.
    expect(JSON.stringify(first.outputs)).not.toContain(first.secretOutputs!.secretKey);

    const again = await w.ensure('do.spaces-key', 'bc-key1', spec, w.ctx());
    expect(again.outputs).toEqual(first.outputs);
    expect(again.id).toBe(first.id);
    expect(again.secretOutputs).toBeUndefined();
    expect(spacesKeys(w.emu).size).toBe(1);
    const posts = w.emu.requests.filter((r) => r.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toEqual({
      name: 'bc-key1',
      grants: [
        { bucket: 'tenant-a-assets', permission: 'readwrite' },
        { bucket: 'tenant-a-logs', permission: 'read' },
      ],
    });
  });

  it('changes grants in place', async () => {
    const w = await world();
    const created = await w.ensure(
      'do.spaces-key',
      'bc-key1',
      { grants: ['tenant-a-assets:read'] },
      w.ctx(),
    );
    const changed = await w.ensure(
      'do.spaces-key',
      'bc-key1',
      { grants: ['*:fullaccess'] },
      w.ctx(),
    );
    expect(changed.id).toBe(created.id);
    expect(changed.outputs?.grants).toBe('*:fullaccess');
    expect(spacesKeys(w.emu).get(created.id)!.grants).toEqual([
      { bucket: '', permission: 'fullaccess' },
    ]);
  });

  it('never changes the grants of a key it does not manage, even when named by id', async () => {
    const w = await world();
    const foreign = seedSpacesKey(w.emu, {
      name: 'ci-deploy',
      access_key: 'DOFOREIGN0001',
      grants: [{ bucket: 'ci-cache', permission: 'read' }],
    });
    const refused = await failure(
      w.ensure('do.spaces-key', 'bc-key1', { grants: ['*:fullaccess'] }, w.ctx(), {
        id: foreign.access_key,
      }),
    );
    expect(refused.code).toBe('INVALID_STATE');
    expect(refused.details?.reason).toBe('notManaged');
    expect(spacesKeys(w.emu).get('DOFOREIGN0001')!.grants).toEqual([
      { bucket: 'ci-cache', permission: 'read' },
    ]);
    expect(w.emu.requests.some((r) => r.method === 'PUT' || r.method === 'POST')).toBe(false);
  });

  it('picks the oldest of two keys with one name', async () => {
    const w = await world();
    seedSpacesKey(w.emu, {
      name: 'bc-dup',
      access_key: 'DOYOUNGER0001',
      created_at: '2026-11-02T00:00:00Z',
      grants: [{ bucket: 'b-one', permission: 'read' }],
    });
    seedSpacesKey(w.emu, {
      name: 'bc-dup',
      access_key: 'DOOLDER00001',
      created_at: '2026-11-01T00:00:00Z',
      grants: [{ bucket: 'b-one', permission: 'read' }],
    });
    const state = await w.ensure('do.spaces-key', 'bc-dup', { grants: ['b-one:read'] }, w.ctx());
    expect(state.id).toBe('DOOLDER00001');
  });

  it('validates the spec and the name before any request', async () => {
    const w = await world();
    for (const grants of [[], ['Bad:read'], ['b-one:fullaccess'], ['*:read'], ['b-one:write']])
      expect(
        (await failure(w.ensure('do.spaces-key', 'bc-key1', { grants }, w.ctx()))).code,
        JSON.stringify(grants),
      ).toBe('INVALID_INPUT');
    expect(
      (
        await failure(
          w.ensure('do.spaces-key', 'tenant-key', { grants: ['b-one:read'] }, w.ctx()),
        )
      ).details?.reason,
    ).toBe('name');
    expect(w.emu.requests).toHaveLength(0);
  });

  it('gets, deletes, and refuses to delete a key it does not manage', async () => {
    const w = await world();
    const created = await w.ensure(
      'do.spaces-key',
      'bc-key1',
      { grants: ['b-one:read'] },
      w.ctx(),
    );
    expect((await w.resources.get('do.spaces-key', created.id, w.ctx()))?.secretOutputs).toBeUndefined();
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

  it('discovers every key and marks the managed ones', async () => {
    const w = await world();
    seedSpacesKey(w.emu, { name: 'ci-deploy', access_key: 'DOFOREIGN0001' });
    seedSpacesKey(w.emu, { name: 'bc-mine', access_key: 'DOMINE000001' });
    const found = [];
    for await (const entry of w.resources.discover('do.spaces-key', w.ctx())) found.push(entry);
    expect(found.map((e) => [e.id, e.name, e.managedBy])).toEqual([
      ['DOFOREIGN0001', 'ci-deploy', undefined],
      ['DOMINE000001', 'bc-mine', 'this'],
    ]);
  });

  it('refuses an unknown kind', async () => {
    const w = await world();
    expect((await failure(w.ensure('do.nope', 'bc-x', {}, w.ctx()))).code).toBe(
      'UNSUPPORTED',
    );
  });
});
