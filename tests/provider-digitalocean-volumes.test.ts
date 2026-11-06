import { beforeEach, describe, expect, it } from 'vitest';
import { isComputeError, type ComputeError } from '@better-compute/core';
import {
  deploymentTag,
  labels,
  tagFor,
  volumeDevice,
  type DoCompute,
} from '@better-compute/provider-digitalocean';
import { seedDroplet } from './support/do-emulator/droplets.js';
import { DoEmulator, type Json, type RecordedRequest } from './support/do-emulator/index.js';
import { failVolumeAction, seedSnapshot, seedVolume } from './support/do-emulator/volumes.js';
import { build, ctx, freshBudgets } from './support/do-harness.js';

// provider-digitalocean Block Storage (P2) against the emulator: volumes found by name, volume
// actions (attach, detach, resize) as non-blocking calls, volume snapshots, and the ownership
// rules that keep better-compute off volumes it did not make.

const t0 = Date.parse('2026-11-05T10:00:00Z');
const emulator = () => new DoEmulator({ now: () => t0 });

const managed = tagFor(labels.managed, 'true');
const deployment = deploymentTag('default');
const ours = [managed, deployment];
const instanceTag = (instance: string) => tagFor(labels.instance, instance);
const spec = { name: 'bc-v1', region: 'nyc3', sizeGiB: 10, kind: 'block' as const };

async function failure(promise: Promise<unknown>): Promise<ComputeError> {
  try {
    await promise;
  } catch (error) {
    if (isComputeError(error)) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

const calls = (emu: DoEmulator, method: string, path: RegExp): RecordedRequest[] =>
  emu.requests.filter((r) => r.method === method && path.test(r.url.pathname));
const writes = (emu: DoEmulator) => emu.requests.filter((r) => r.method !== 'GET');

/** A Droplet of instance `ins_1` in this deployment. */
function host(emu: DoEmulator, extra: { region?: string; tags?: string[] } = {}): Json {
  return seedDroplet(emu.state, {
    region: extra.region ?? 'nyc3',
    tags: extra.tags ?? [deployment, instanceTag('ins_1')],
  });
}

async function setup(emu = emulator()): Promise<{ emu: DoEmulator; impl: DoCompute }> {
  return { emu, impl: await build(emu) };
}

beforeEach(freshBudgets);

describe('provider-digitalocean volumes: ensure and get', () => {
  it('creates a volume with the ownership and label tags, and a second ensure finds it', async () => {
    const { emu, impl } = await setup();
    const made = await impl.volumes.ensureVolume(
      { ...spec, filesystem: 'ext4', labels: { team: 'ML' } },
      ctx(),
    );
    expect(made).toEqual({
      id: expect.any(String),
      state: 'ready',
      outputs: {
        region: 'nyc3',
        sizeGiB: '10',
        filesystem: 'ext4',
        device: '/dev/disk/by-id/scsi-0DO_Volume_bc-v1',
      },
    });
    const [post] = calls(emu, 'POST', /^\/v2\/volumes$/);
    expect(post!.body).toEqual({
      name: 'bc-v1',
      region: 'nyc3',
      size_gigabytes: 10,
      description: 'better-compute volume',
      filesystem_type: 'ext4',
      tags: [managed, deployment, 'team:ml'],
    });
    const again = await impl.volumes.ensureVolume({ ...spec, filesystem: 'ext4' }, ctx('k2'));
    expect(again.id).toBe(made.id);
    expect(calls(emu, 'POST', /^\/v2\/volumes$/)).toHaveLength(1);
    expect(await impl.volumes.getVolume(made.id, ctx())).toEqual(made);
    expect(volumeDevice('bc-v1')).toBe(made.outputs?.device);
  });

  it('refuses what DO would refuse before any request', async () => {
    const { emu, impl } = await setup();
    const refusals: [Parameters<typeof impl.volumes.ensureVolume>[0], string, string][] = [
      [{ ...spec, kind: 'shared' }, 'UNSUPPORTED', 'sharedVolume'],
      [{ ...spec, region: 'sfo3' }, 'INVALID_INPUT', 'region'],
      [{ ...spec, name: 'Bad_Name' }, 'INVALID_INPUT', 'name'],
      [{ ...spec, name: `v${'a'.repeat(64)}` }, 'INVALID_INPUT', 'name'],
      [{ ...spec, sizeGiB: 0 }, 'INVALID_INPUT', 'size'],
      [{ ...spec, sizeGiB: 16_385 }, 'INVALID_INPUT', 'size'],
      [{ ...spec, sizeGiB: 1.5 }, 'INVALID_INPUT', 'size'],
      [{ ...spec, snapshotId: '../droplets' }, 'INVALID_INPUT', 'snapshotId'],
      [{ ...spec, labels: { 'better-compute-instance:x': 'y' } }, 'INVALID_INPUT', 'label'],
    ];
    for (const [bad, code, reason] of refusals) {
      const error = await failure(impl.volumes.ensureVolume(bad, ctx()));
      expect([error.code, error.details?.reason], JSON.stringify(bad)).toEqual([code, reason]);
    }
    expect(emu.requests).toHaveLength(0);
  });

  it('never writes a reserved label as a tag', async () => {
    const { emu, impl } = await setup();
    await impl.volumes.ensureVolume(
      { ...spec, labels: { [labels.instance]: 'forged', [labels.managed]: 'false' } },
      ctx(),
    );
    expect(calls(emu, 'POST', /^\/v2\/volumes$/)[0]!.body.tags).toEqual([managed, deployment]);
  });

  it('refuses a same-named volume that is not ours, and one formatted otherwise', async () => {
    const { emu, impl } = await setup();
    seedVolume(emu.state, { name: 'bc-v1', tags: ['team:ops'] });
    const taken = await failure(impl.volumes.ensureVolume(spec, ctx()));
    expect([taken.code, taken.details?.reason]).toEqual(['CONFLICT', 'nameTaken']);
    seedVolume(emu.state, { name: 'bc-v2', tags: ours, filesystem_type: 'xfs' });
    const formatted = await failure(impl.volumes.ensureVolume({ ...spec, name: 'bc-v2' }, ctx()));
    expect([formatted.code, formatted.details?.reason]).toEqual(['INVALID_STATE', 'filesystem']);
    expect(writes(emu)).toHaveLength(0);
  });

  it('a create that loses a race on the name returns the winner', async () => {
    const { emu, impl } = await setup();
    let winner: Json | undefined;
    emu.beforeAction('POST /volumes', ({ state }) => {
      winner = seedVolume(state, { name: 'bc-v1', tags: ours });
    });
    const got = await impl.volumes.ensureVolume(spec, ctx());
    expect(got.id).toBe(winner!.id);
    expect(emu.state.volumes.size).toBe(1);
  });

  it('a create whose answer never arrived finds the volume it made', async () => {
    const { emu, impl } = await setup();
    let landed: Json | undefined;
    emu.beforeAction('POST /volumes', ({ state }) => {
      landed = seedVolume(state, { name: 'bc-v1', tags: ours });
    });
    emu.failNext({ method: 'POST', path: /^\/volumes$/ }, 500, {
      id: 'server_error',
      message: 'x',
    });
    expect((await impl.volumes.ensureVolume(spec, ctx())).id).toBe(landed!.id);
    // Nothing landed: the error stands.
    emu.failNext({ method: 'POST', path: /^\/volumes$/ }, 500, {
      id: 'server_error',
      message: 'x',
    });
    const error = await failure(impl.volumes.ensureVolume({ ...spec, name: 'bc-v9' }, ctx()));
    expect(error.code).toBe('UNAVAILABLE');
  });

  it('maps the account volume limit to QUOTA_EXCEEDED', async () => {
    const emu = emulator();
    emu.volumeLimit = 0;
    const { impl } = await setup(emu);
    const error = await failure(impl.volumes.ensureVolume(spec, ctx()));
    expect([error.code, error.details?.reason]).toEqual(['QUOTA_EXCEEDED', 'volumeLimit']);
  });

  it('findVolume finds our volume by name without creating one, and never a volume that is not ours', async () => {
    const { emu, impl } = await setup();
    expect(await impl.volumes.findVolume('bc-v1', 'nyc3', ctx())).toBe(undefined);
    seedVolume(emu.state, { name: 'bc-v2', tags: ['team:ops'] });
    expect(await impl.volumes.findVolume('bc-v2', 'nyc3', ctx())).toBe(undefined);
    const mine = seedVolume(emu.state, { name: 'bc-v3', tags: ours });
    expect((await impl.volumes.findVolume('bc-v3', 'nyc3', ctx()))?.id).toBe(mine.id);
    expect(await impl.volumes.findVolume('bc-v3', 'ams3', ctx())).toBe(undefined);
    expect(await impl.volumes.findVolume('Bad Name', 'nyc3', ctx())).toBe(undefined);
    expect(writes(emu)).toHaveLength(0);
  });

  it('getVolume is undefined for a missing or malformed id', async () => {
    const { emu, impl } = await setup();
    expect(await impl.volumes.getVolume('0b7d9b2c-0000-4000-8000-000000000000', ctx())).toBe(
      undefined,
    );
    expect(await impl.volumes.getVolume('../droplets/1', ctx())).toBe(undefined);
    expect(calls(emu, 'GET', /droplets/)).toHaveLength(0);
  });
});

describe('provider-digitalocean volumes: attach and detach', () => {
  it('attaches to an instance Droplet in the region and reports it', async () => {
    const { emu, impl } = await setup();
    const droplet = host(emu);
    const { id } = await impl.volumes.ensureVolume(spec, ctx());
    const attached = await impl.volumes.attachVolume(id, String(droplet.id), ctx(), 'ins_1');
    expect(attached).toMatchObject({
      id,
      state: 'ready',
      outputs: { attachedTo: String(droplet.id) },
    });
    const [post] = calls(emu, 'POST', /^\/v2\/volumes\/[^/]+\/actions$/);
    expect(post!.body).toEqual({ type: 'attach', droplet_id: droplet.id, region: 'nyc3' });
    // Again: already attached, nothing is posted.
    expect((await impl.volumes.attachVolume(id, String(droplet.id), ctx())).state).toBe('ready');
    expect(calls(emu, 'POST', /\/actions$/)).toHaveLength(1);
  });

  it('is non-blocking: pending while the action runs, one action, then ready', async () => {
    const emu = emulator();
    emu.volumeActionReads = 3;
    const { impl } = await setup(emu);
    const droplet = host(emu);
    const { id } = await impl.volumes.ensureVolume(spec, ctx());
    const seen: string[] = [];
    for (let i = 0; i < 5; i++)
      seen.push((await impl.volumes.attachVolume(id, String(droplet.id), ctx())).state);
    expect(seen[0]).toBe('pending');
    expect(seen.at(-1)).toBe('ready');
    expect(calls(emu, 'POST', /\/actions$/)).toHaveLength(1);
  });

  it('refuses a Droplet in another region before any write', async () => {
    const { emu, impl } = await setup();
    const droplet = host(emu, { region: 'sfo3' });
    const { id } = await impl.volumes.ensureVolume(spec, ctx());
    const error = await failure(impl.volumes.attachVolume(id, String(droplet.id), ctx()));
    expect([error.code, error.details?.reason]).toEqual(['INVALID_INPUT', 'region']);
    expect(calls(emu, 'POST', /\/actions$/)).toHaveLength(0);
  });

  it('refuses a Droplet that is not this instance of this deployment', async () => {
    const { emu, impl } = await setup();
    const { id } = await impl.volumes.ensureVolume(spec, ctx());
    const stranger = host(emu, { tags: [instanceTag('ins_1')] });
    const plain = host(emu, { tags: [deployment] });
    const other = host(emu, { tags: [deployment, instanceTag('ins_2')] });
    for (const [droplet, instance] of [
      [stranger, undefined],
      [plain, undefined],
      [other, 'ins_1'],
    ] as const) {
      const error = await failure(
        impl.volumes.attachVolume(id, String(droplet.id), ctx(), instance),
      );
      expect([error.code, error.details?.reason]).toEqual(['INVALID_STATE', 'notInstance']);
    }
    const missing = await failure(impl.volumes.attachVolume(id, '999999', ctx()));
    expect(missing.code).toBe('NOT_FOUND');
    expect(calls(emu, 'POST', /\/actions$/)).toHaveLength(0);
  });

  it('never moves a volume attached elsewhere, and maps DO 422 race to CONFLICT', async () => {
    const { emu, impl } = await setup();
    const first = host(emu);
    const second = host(emu);
    const { id } = await impl.volumes.ensureVolume(spec, ctx());
    await impl.volumes.attachVolume(id, String(first.id), ctx());
    const error = await failure(impl.volumes.attachVolume(id, String(second.id), ctx()));
    expect([error.code, error.details?.reason]).toEqual(['CONFLICT', 'attachedElsewhere']);
    expect(calls(emu, 'POST', /\/actions$/)).toHaveLength(1);

    // Attached by someone else between our read and our write: DO's 422.
    const { id: v2 } = await impl.volumes.ensureVolume({ ...spec, name: 'bc-v2' }, ctx());
    emu.beforeAction('POST /volumes/*/actions', ({ state }) => {
      state.volumes.get(v2)!.droplet_ids = [first.id];
    });
    const raced = await failure(impl.volumes.attachVolume(v2, String(second.id), ctx()));
    expect([raced.code, raced.details?.reason]).toEqual(['CONFLICT', 'attachedElsewhere']);
  });

  it('maps a Droplet full of volumes to QUOTA_EXCEEDED', async () => {
    const { emu, impl } = await setup();
    const droplet = host(emu);
    for (let i = 0; i < 7; i++)
      seedVolume(emu.state, { name: `full-${i}`, tags: ours, droplet_ids: [droplet.id] });
    const { id } = await impl.volumes.ensureVolume(spec, ctx());
    const error = await failure(impl.volumes.attachVolume(id, String(droplet.id), ctx()));
    expect([error.code, error.details?.reason]).toEqual(['QUOTA_EXCEEDED', 'volumesPerDroplet']);
  });

  it('never touches a volume that is not ours', async () => {
    const { emu, impl } = await setup();
    const droplet = host(emu);
    const foreign = seedVolume(emu.state, { name: 'theirs', tags: [deployment] });
    for (const call of [
      () => impl.volumes.attachVolume(foreign.id, String(droplet.id), ctx()),
      () => impl.volumes.resizeVolume(foreign.id, 20, ctx()),
      () => impl.volumes.deleteVolume(foreign.id, ctx()),
      () => impl.volumes.snapshotVolume(foreign.id, 'snap', ctx()),
    ]) {
      const error = await failure(call());
      expect([error.code, error.details?.reason]).toEqual(['INVALID_STATE', 'notManaged']);
    }
    const attachedForeign = seedVolume(emu.state, { name: 'theirs2', droplet_ids: [droplet.id] });
    const detach = await failure(
      impl.volumes.detachVolume(attachedForeign.id, String(droplet.id), ctx()),
    );
    expect(detach.code).toBe('INVALID_STATE');
    expect(writes(emu)).toHaveLength(0);
  });

  it('detaches, and a volume that is not attached there counts as detached', async () => {
    const emu = emulator();
    const { impl } = await setup(emu);
    const droplet = host(emu);
    const { id } = await impl.volumes.ensureVolume(spec, ctx());
    await impl.volumes.attachVolume(id, String(droplet.id), ctx());
    const detached = await impl.volumes.detachVolume(id, String(droplet.id), ctx());
    expect(detached).toEqual({ id, state: 'deleted' });
    const posts = calls(emu, 'POST', /\/actions$/);
    expect(posts.at(-1)!.body).toEqual({ type: 'detach', droplet_id: droplet.id, region: 'nyc3' });
    expect((await impl.volumes.getVolume(id, ctx()))?.outputs?.attachedTo).toBe(undefined);
    expect((await impl.volumes.detachVolume(id, String(droplet.id), ctx())).state).toBe('deleted');
    expect(
      (await impl.volumes.detachVolume('0b7d9b2c-0000-4000-8000-000000000000', '1', ctx())).state,
    ).toBe('deleted');
    expect(calls(emu, 'POST', /\/actions$/)).toHaveLength(2);
  });

  it('a detach while the attach still runs reports deleting, not deleted', async () => {
    const emu = emulator();
    emu.volumeActionReads = 5;
    const { impl } = await setup(emu);
    const droplet = host(emu);
    const { id } = await impl.volumes.ensureVolume(spec, ctx());
    expect((await impl.volumes.attachVolume(id, String(droplet.id), ctx())).state).toBe('pending');
    expect((await impl.volumes.detachVolume(id, String(droplet.id), ctx())).state).toBe('deleting');
  });

  it('reports an errored action as error, and the next call starts it again', async () => {
    const { emu, impl } = await setup();
    const droplet = host(emu);
    const { id } = await impl.volumes.ensureVolume(spec, ctx());
    failVolumeAction(emu.state, 'attach');
    const errored = await impl.volumes.attachVolume(id, String(droplet.id), ctx());
    expect(errored.state).toBe('error');
    expect(errored.message).toMatch(/attach_volume action on volume .* errored/);
    expect((await impl.volumes.attachVolume(id, String(droplet.id), ctx())).state).toBe('ready');
  });

  it('a deleted Droplet leaves its volumes detached', async () => {
    const { emu, impl } = await setup();
    const droplet = host(emu, { tags: [managed, deployment, instanceTag('ins_1')] });
    const { id } = await impl.volumes.ensureVolume(spec, ctx());
    await impl.volumes.attachVolume(id, String(droplet.id), ctx());
    await impl.delete(String(droplet.id), ctx());
    expect((await impl.volumes.getVolume(id, ctx()))?.outputs?.attachedTo).toBe(undefined);
  });

  it('deletes a Droplet with the named volumes of ours in one selective destroy (DO-D16)', async () => {
    const { emu, impl } = await setup();
    const droplet = host(emu, { tags: [managed, deployment, instanceTag('ins_1')] });
    const { id: mine } = await impl.volumes.ensureVolume(spec, ctx());
    await impl.volumes.attachVolume(mine, String(droplet.id), ctx());
    // A tenant's own volume attached by hand, and one of ours that is not on this Droplet: both survive.
    const byHand = seedVolume(emu.state, { name: 'by-hand', droplet_ids: [droplet.id] });
    const { id: elsewhere } = await impl.volumes.ensureVolume({ ...spec, name: 'bc-v2' }, ctx('k2'));
    await impl.delete(String(droplet.id), ctx('del'), {
      volumes: [mine, byHand.id, elsewhere, 'not-a-volume'],
    });
    const selective = calls(
      emu,
      'DELETE',
      /^\/v2\/droplets\/\d+\/destroy_with_associated_resources\/selective$/,
    );
    expect(selective).toHaveLength(1);
    expect(selective[0]!.body).toEqual({ volumes: [mine] });
    expect(calls(emu, 'DELETE', /^\/v2\/droplets\/\d+$/)).toHaveLength(0);
    expect(emu.state.droplets.has(droplet.id)).toBe(false);
    expect(await impl.volumes.getVolume(mine, ctx())).toBeUndefined();
    expect(emu.state.volumes.get(byHand.id)?.droplet_ids).toEqual([]);
    expect(await impl.volumes.getVolume(elsewhere, ctx())).toMatchObject({ state: 'ready' });
  });

  it('a delete naming no volume of ours is a plain Droplet delete', async () => {
    const { emu, impl } = await setup();
    const droplet = host(emu, { tags: [managed, deployment, instanceTag('ins_1')] });
    const byHand = seedVolume(emu.state, { name: 'by-hand', droplet_ids: [droplet.id] });
    await impl.delete(String(droplet.id), ctx(), { volumes: [byHand.id] });
    expect(calls(emu, 'DELETE', /^\/v2\/droplets\/\d+$/)).toHaveLength(1);
    expect(calls(emu, 'DELETE', /selective$/)).toHaveLength(0);
    expect(emu.state.volumes.has(byHand.id)).toBe(true);
  });
});

describe('provider-digitalocean volumes: resize and delete', () => {
  it('grows only', async () => {
    const { emu, impl } = await setup();
    const { id } = await impl.volumes.ensureVolume(spec, ctx());
    const shrink = await failure(impl.volumes.resizeVolume(id, 5, ctx()));
    expect([shrink.code, shrink.details?.reason]).toEqual(['INVALID_INPUT', 'shrink']);
    const huge = await failure(impl.volumes.resizeVolume(id, 16_385, ctx()));
    expect(huge.code).toBe('INVALID_INPUT');
    expect((await impl.volumes.resizeVolume(id, 10, ctx())).state).toBe('ready');
    expect(calls(emu, 'POST', /\/actions$/)).toHaveLength(0);
    const grown = await impl.volumes.resizeVolume(id, 20, ctx());
    expect(grown).toMatchObject({ state: 'ready', outputs: { sizeGiB: '20' } });
    expect(calls(emu, 'POST', /\/actions$/)[0]!.body).toEqual({
      type: 'resize',
      size_gigabytes: 20,
      region: 'nyc3',
    });
  });

  it('reports updating while a resize runs', async () => {
    const emu = emulator();
    emu.volumeActionReads = 3;
    const { impl } = await setup(emu);
    const { id } = await impl.volumes.ensureVolume(spec, ctx());
    expect((await impl.volumes.resizeVolume(id, 20, ctx())).state).toBe('updating');
    expect((await impl.volumes.resizeVolume(id, 20, ctx())).state).toBe('updating');
    expect((await impl.volumes.resizeVolume(id, 20, ctx())).state).toBe('ready');
    expect(calls(emu, 'POST', /\/actions$/)).toHaveLength(1);
  });

  it('refuses to delete an attached volume, deletes a detached one, and again counts as deleted', async () => {
    const { emu, impl } = await setup();
    const droplet = host(emu);
    const { id } = await impl.volumes.ensureVolume(spec, ctx());
    await impl.volumes.attachVolume(id, String(droplet.id), ctx());
    const attached = await failure(impl.volumes.deleteVolume(id, ctx()));
    expect([attached.code, attached.details?.reason]).toEqual(['INVALID_STATE', 'attached']);
    await impl.volumes.detachVolume(id, String(droplet.id), ctx());
    expect(await impl.volumes.deleteVolume(id, ctx())).toEqual({ id, state: 'deleted' });
    expect(emu.state.volumes.size).toBe(0);
    expect(await impl.volumes.deleteVolume(id, ctx())).toEqual({ id, state: 'deleted' });
    const malformed = await failure(impl.volumes.deleteVolume('1/../2', ctx()));
    expect(malformed.code).toBe('INVALID_INPUT');
  });

  it('a volume attached between the read and the delete is DO 409, CONFLICT', async () => {
    const { emu, impl } = await setup();
    const droplet = host(emu);
    const { id } = await impl.volumes.ensureVolume(spec, ctx());
    emu.beforeAction('DELETE /volumes/*', ({ state }) => {
      state.volumes.get(id)!.droplet_ids = [droplet.id];
    });
    expect((await failure(impl.volumes.deleteVolume(id, ctx()))).code).toBe('CONFLICT');
  });
});

describe('provider-digitalocean volumes: snapshots', () => {
  it('snapshots by name with the ownership tags, reads and deletes the snapshot', async () => {
    const { emu, impl } = await setup();
    const { id } = await impl.volumes.ensureVolume(spec, ctx());
    const snap = await impl.volumes.snapshotVolume(id, 'nightly-1', ctx());
    expect(snap).toEqual({
      id: expect.any(String),
      state: 'ready',
      outputs: { volume: id, region: 'nyc3', sizeGiB: '10', storedGiB: '0' },
    });
    expect(calls(emu, 'POST', /\/snapshots$/)[0]!.body).toEqual({
      name: 'nightly-1',
      tags: [managed, deployment],
    });
    expect((await impl.volumes.snapshotVolume(id, 'nightly-1', ctx())).id).toBe(snap.id);
    expect(calls(emu, 'POST', /\/snapshots$/)).toHaveLength(1);
    expect(await impl.volumes.getSnapshot(snap.id, ctx())).toEqual(snap);
    expect(await impl.volumes.deleteSnapshot(snap.id, ctx())).toEqual({
      id: snap.id,
      state: 'deleted',
    });
    expect(await impl.volumes.deleteSnapshot(snap.id, ctx())).toEqual({
      id: snap.id,
      state: 'deleted',
    });
    expect(await impl.volumes.getSnapshot(snap.id, ctx())).toBe(undefined);
    expect(await impl.volumes.getSnapshot('12345', ctx())).toBe(undefined);
  });

  it('restores: a volume created from a snapshot names it', async () => {
    const { emu, impl } = await setup();
    const { id } = await impl.volumes.ensureVolume(spec, ctx());
    const snap = await impl.volumes.snapshotVolume(id, 'base', ctx());
    const restored = await impl.volumes.ensureVolume(
      { ...spec, name: 'bc-v2', snapshotId: snap.id },
      ctx(),
    );
    expect(restored.state).toBe('ready');
    expect(calls(emu, 'POST', /^\/v2\/volumes$/).at(-1)!.body.snapshot_id).toBe(snap.id);
  });

  it('two racing snapshot calls converge on the oldest; a foreign one of the name is CONFLICT', async () => {
    const { emu, impl } = await setup();
    const { id } = await impl.volumes.ensureVolume(spec, ctx());
    const volume = emu.state.volumes.get(id)!;
    let rival: Json | undefined;
    emu.beforeAction('POST /volumes/*/snapshots', ({ state }) => {
      rival = seedSnapshot(state, {
        volume,
        name: 'race',
        tags: ours,
        created_at: '2026-11-05T09:00:00Z',
      });
    });
    const kept = await impl.volumes.snapshotVolume(id, 'race', ctx());
    expect(kept.id).toBe(rival!.id);
    expect([...emu.state.snapshots.values()].filter((s) => s.name === 'race')).toHaveLength(1);

    seedSnapshot(emu.state, { volume, name: 'theirs', tags: ['team:ops'] });
    const taken = await failure(impl.volumes.snapshotVolume(id, 'theirs', ctx()));
    expect([taken.code, taken.details?.reason]).toEqual(['CONFLICT', 'nameTaken']);
  });

  it('never deletes a snapshot that is not ours', async () => {
    const { emu, impl } = await setup();
    const volume = seedVolume(emu.state, { name: 'theirs' });
    const foreign = seedSnapshot(emu.state, { volume, name: 'x', tags: [deployment] });
    const error = await failure(impl.volumes.deleteSnapshot(foreign.id, ctx()));
    expect([error.code, error.details?.reason]).toEqual(['INVALID_STATE', 'notManaged']);
    const bad = await failure(impl.volumes.deleteSnapshot('../volumes', ctx()));
    expect(bad.code).toBe('INVALID_INPUT');
    expect(writes(emu)).toHaveLength(0);
  });

  it('refuses a snapshot name DO would not take before any request', async () => {
    const { emu, impl } = await setup();
    const { id } = await impl.volumes.ensureVolume(spec, ctx());
    const before = emu.requests.length;
    const error = await failure(impl.volumes.snapshotVolume(id, 'bad name!', ctx()));
    expect(error.code).toBe('INVALID_INPUT');
    expect(emu.requests).toHaveLength(before);
  });
});
