import { beforeEach, describe, expect, it } from 'vitest';
import { isComputeError, type ComputeError } from '@better-compute/core';
import {
  deploymentTag,
  labels,
  networkDescription,
  shareId,
  shareName,
  shareOutputs,
  shareSnapshotId,
  shareTag,
  tagFor,
  type DoCompute,
} from '@better-compute/provider-digitalocean';
import { DoEmulator, type Json, type RecordedRequest } from './support/do-emulator/index.js';
import { seedDroplet } from './support/do-emulator/droplets.js';
import { seedShare } from './support/do-emulator/nfs.js';
import { seedVpc } from './support/do-emulator/vpcs.js';
import { build, ctx, freshBudgets } from './support/do-harness.js';

// provider-digitalocean Network File Storage (P6): shares as `kind: 'shared'` provider volumes
// against the emulator. A share is found by its provider name (the vps name plus this
// deployment's hash: shares carry no tags), lives in a tenant network's VPC, and is never
// resized or deleted by better-compute unless it made it.

const t0 = Date.parse('2026-11-05T10:00:00Z');
const emulator = () => new DoEmulator({ now: () => t0 });

const deployment = deploymentTag('default');
const net = { network: 'net-a' };
const spec = {
  name: 'bc-pvol-1',
  region: 'nyc3',
  sizeGiB: 100,
  kind: 'shared' as const,
  network: net,
};
const provName = shareName('bc-pvol-1', 'default');

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

/** The tenant network's VPC in a region (a VPC of ours, by its description). */
function subnet(emu: DoEmulator, name = 'net-a-nyc3', region = 'nyc3', network = 'net-a'): Json {
  return seedVpc(emu.state, { name, region, description: networkDescription(network) });
}

/** A Droplet of instance `ins_1` (or `instance`) of this deployment, in `vpc`. */
function host(
  emu: DoEmulator,
  vpc: Json,
  extra: { region?: string; tags?: string[]; instance?: string } = {},
): Json {
  return seedDroplet(emu.state, {
    region: extra.region ?? vpc.region,
    vpc_uuid: vpc.id,
    tags: extra.tags ?? [deployment, tagFor(labels.instance, extra.instance ?? 'ins_1')],
  });
}

const uuidOf = (id: string) => id.split(':')[2]!;
const tagged = (droplet: Json, id: string) =>
  (droplet.tags as string[]).includes(shareTag(uuidOf(id)));
const shareOf = (emu: DoEmulator, id: string) => emu.state.nfsShares.get(uuidOf(id))!;
const shareActions = (emu: DoEmulator, type?: string) =>
  calls(emu, 'POST', /^\/v2\/nfs\/[^/]+\/actions$/).filter(
    (r) => type === undefined || (r.body as Json).type === type,
  );

async function setup(emu = emulator()): Promise<{ emu: DoEmulator; impl: DoCompute; vpc: Json }> {
  const vpc = subnet(emu);
  return { emu, impl: await build(emu), vpc };
}

beforeEach(freshBudgets);

describe('provider-digitalocean NFS shares: ensure and get', () => {
  it('names a share by the vps name and the deployment, and keeps the hash stable', () => {
    expect(provName).toMatch(/^bc-pvol-1-[0-9a-f]{12}$/);
    expect(shareName('bc-pvol-1', 'default')).toBe(provName);
    expect(shareName('bc-pvol-1', 'other')).not.toBe(provName);
    expect(deployment).toContain(provName.slice(-12));
  });

  it("creates a share in the network's VPC, and a second ensure finds it", async () => {
    const { emu, impl, vpc } = await setup();
    const made = await impl.volumes.ensureVolume(spec, ctx());
    const share = [...emu.state.nfsShares.values()][0]!;
    expect(made).toEqual({
      id: shareId('nyc3', share.id),
      state: 'ready',
      outputs: {
        kind: 'shared',
        region: 'nyc3',
        sizeGiB: '100',
        filesystem: 'nfs',
        host: share.host,
        mountPath: share.mount_path,
        device: `${share.host}:${share.mount_path}`,
        vpcs: vpc.id,
      },
    });
    const [post] = calls(emu, 'POST', /^\/v2\/nfs$/);
    expect(post!.body).toEqual({
      name: provName,
      region: 'nyc3',
      size_gib: 100,
      vpc_ids: [vpc.id],
    });
    const again = await impl.volumes.ensureVolume(spec, ctx('k2'));
    expect(again).toEqual(made);
    expect(calls(emu, 'POST', /^\/v2\/nfs$/)).toHaveLength(1);
    expect(await impl.volumes.getVolume(made.id, ctx())).toEqual(made);
  });

  it('is pending while the share is CREATING, with no mount source yet', async () => {
    const emu = emulator();
    emu.nfsCreateReads = 2;
    const { impl } = await setup(emu);
    const made = await impl.volumes.ensureVolume(spec, ctx());
    expect(made.state).toBe('pending');
    expect(made.outputs?.device).toBe(undefined);
    expect((await impl.volumes.getVolume(made.id, ctx()))?.state).toBe('pending');
    const ready = await impl.volumes.getVolume(made.id, ctx());
    expect(ready?.state).toBe('ready');
    expect(ready?.outputs?.device).toMatch(/^10\.\d+\.\d+\.\d+:\//);
  });

  it('reports a FAILED share as error', async () => {
    const { emu, impl } = await setup();
    const share = seedShare(emu.state, { name: provName, status: 'FAILED' });
    const got = await impl.volumes.ensureVolume(spec, ctx());
    expect(got).toMatchObject({ id: shareId('nyc3', share.id), state: 'error' });
    expect(got.message).toMatch(/failed/i);
    expect(writes(emu)).toHaveLength(0);
  });

  it('refuses what DO would refuse, and a share without a network, before any request', async () => {
    const { emu, impl } = await setup();
    const refusals: [Parameters<typeof impl.volumes.ensureVolume>[0], string, string][] = [
      [{ ...spec, network: undefined }, 'INVALID_INPUT', 'network'],
      [{ ...spec, region: 'sfo3' }, 'INVALID_INPUT', 'region'],
      [{ ...spec, name: 'Bad_Name' }, 'INVALID_INPUT', 'name'],
      [{ ...spec, name: `v${'a'.repeat(55)}` }, 'INVALID_INPUT', 'name'],
      [{ ...spec, sizeGiB: 49 }, 'INVALID_INPUT', 'size'],
      [{ ...spec, sizeGiB: 16_385 }, 'INVALID_INPUT', 'size'],
      [{ ...spec, sizeGiB: 50.5 }, 'INVALID_INPUT', 'size'],
      [{ ...spec, filesystem: 'ext4' }, 'INVALID_INPUT', 'filesystem'],
      [
        { ...spec, snapshotId: '0b7d9b2c-0000-4000-8000-000000000000' },
        'UNSUPPORTED',
        'sharedRestore',
      ],
    ];
    for (const [bad, code, reason] of refusals) {
      const error = await failure(impl.volumes.ensureVolume(bad, ctx()));
      expect([error.code, error.details?.reason], JSON.stringify(bad)).toEqual([code, reason]);
    }
    expect(emu.requests).toHaveLength(0);
  });

  it('accepts filesystem none and ignores labels (shares carry no tags)', async () => {
    const { emu, impl } = await setup();
    await impl.volumes.ensureVolume(
      { ...spec, filesystem: 'none', labels: { team: 'ml', [labels.instance]: 'x' } },
      ctx(),
    );
    expect(Object.keys(calls(emu, 'POST', /^\/v2\/nfs$/)[0]!.body as Json).sort()).toEqual([
      'name',
      'region',
      'size_gib',
      'vpc_ids',
    ]);
  });

  it('never joins the default VPC or a VPC of another network', async () => {
    const emu = emulator();
    seedVpc(emu.state, { name: 'default-nyc3', region: 'nyc3', default: true });
    subnet(emu, 'net-b-nyc3', 'nyc3', 'net-b');
    const impl = await build(emu);
    const error = await failure(impl.volumes.ensureVolume(spec, ctx()));
    expect([error.code, error.details?.reason]).toEqual(['INVALID_STATE', 'noSubnetInRegion']);
    expect(writes(emu)).toHaveLength(0);
  });

  it('a create that loses a race on the name returns the winner', async () => {
    const { emu, impl, vpc } = await setup();
    let winner: Json | undefined;
    emu.beforeAction('POST /nfs', ({ state }) => {
      winner = seedShare(state, { name: provName, vpc_ids: [vpc.id] });
    });
    const got = await impl.volumes.ensureVolume(spec, ctx());
    expect(got.id).toBe(shareId('nyc3', winner!.id));
    expect(emu.state.nfsShares.size).toBe(1);
  });

  it('a create whose answer never arrived finds the share it made; otherwise the error stands', async () => {
    const { emu, impl, vpc } = await setup();
    let landed: Json | undefined;
    emu.beforeAction('POST /nfs', ({ state }) => {
      landed = seedShare(state, { name: provName, vpc_ids: [vpc.id] });
    });
    emu.failNext({ method: 'POST', path: /^\/nfs$/ }, 500, { id: 'server_error', message: 'x' });
    expect((await impl.volumes.ensureVolume(spec, ctx())).id).toBe(shareId('nyc3', landed!.id));
    emu.failNext({ method: 'POST', path: /^\/nfs$/ }, 500, { id: 'server_error', message: 'x' });
    const error = await failure(impl.volumes.ensureVolume({ ...spec, name: 'bc-pvol-9' }, ctx()));
    expect(error.code).toBe('UNAVAILABLE');
  });

  it('findVolume with kind shared finds our share by name, never another deployment', async () => {
    const { emu, impl } = await setup();
    expect(await impl.volumes.findVolume('bc-pvol-1', 'nyc3', ctx(), 'shared')).toBe(undefined);
    seedShare(emu.state, { name: 'bc-pvol-1' });
    seedShare(emu.state, { name: shareName('bc-pvol-1', 'other') });
    expect(await impl.volumes.findVolume('bc-pvol-1', 'nyc3', ctx(), 'shared')).toBe(undefined);
    const mine = seedShare(emu.state, { name: provName });
    expect((await impl.volumes.findVolume('bc-pvol-1', 'nyc3', ctx(), 'shared'))?.id).toBe(
      shareId('nyc3', mine.id),
    );
    // Without a kind, only block volumes are looked at.
    const before = calls(emu, 'GET', /^\/v2\/nfs$/).length;
    expect(await impl.volumes.findVolume('bc-pvol-1', 'nyc3', ctx())).toBe(undefined);
    expect(calls(emu, 'GET', /^\/v2\/nfs$/)).toHaveLength(before);
    expect(writes(emu)).toHaveLength(0);
  });

  it('getVolume is undefined for a missing share or a malformed share id', async () => {
    const { emu, impl } = await setup();
    expect(
      await impl.volumes.getVolume(shareId('nyc3', '0b7d9b2c-0000-4000-8000-000000000000'), ctx()),
    ).toBe(undefined);
    for (const bad of ['nfs:nyc3:../x', 'nfs:NYC3:0b7d9b2c-0000-4000-8000-000000000000', 'nfs:'])
      expect(await impl.volumes.getVolume(bad, ctx())).toBe(undefined);
    expect(calls(emu, 'GET', /^\/v2\/nfs\//)).toHaveLength(1);
  });
});

describe('provider-digitalocean NFS shares: resize and delete', () => {
  it('grows a share through a resize action, non-blocking, and never shrinks it', async () => {
    const emu = emulator();
    emu.nfsActionReads = 2;
    const { impl } = await setup(emu);
    const { id } = await impl.volumes.ensureVolume(spec, ctx());
    const shrink = await failure(impl.volumes.resizeVolume(id, 60, ctx()));
    expect([shrink.code, shrink.details?.reason]).toEqual(['INVALID_INPUT', 'shrink']);
    const small = await failure(impl.volumes.resizeVolume(id, 49, ctx()));
    expect([small.code, small.details?.reason]).toEqual(['INVALID_INPUT', 'size']);
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) seen.push((await impl.volumes.resizeVolume(id, 200, ctx())).state);
    expect(seen[0]).toBe('updating');
    expect(seen.at(-1)).toBe('ready');
    const resizes = calls(emu, 'POST', /^\/v2\/nfs\/[^/]+\/actions$/).filter(
      (r) => (r.body as Json).type === 'resize',
    );
    expect(resizes[0]!.body).toEqual({ type: 'resize', region: 'nyc3', params: { size_gib: 200 } });
    expect((await impl.volumes.getVolume(id, ctx()))?.outputs?.sizeGiB).toBe('200');
  });

  it('reports an errored resize as error', async () => {
    const { emu, impl } = await setup();
    const { id } = await impl.volumes.ensureVolume(spec, ctx());
    const { failNfsAction } = await import('./support/do-emulator/nfs.js');
    failNfsAction(emu.state, 'resize');
    const got = await impl.volumes.resizeVolume(id, 150, ctx());
    expect(got.state).toBe('error');
    expect(got.message).toMatch(/errored/);
  });

  it('deletes a share of ours; a missing one is deleted; a foreign one is never touched', async () => {
    const { emu, impl } = await setup();
    const { id } = await impl.volumes.ensureVolume(spec, ctx());
    expect(await impl.volumes.deleteVolume(id, ctx())).toEqual({ id, state: 'deleted' });
    expect(emu.state.nfsShares.size).toBe(0);
    expect((await impl.volumes.deleteVolume(id, ctx())).state).toBe('deleted');
    const foreign = seedShare(emu.state, { name: 'their-share' });
    const foreignId = shareId('nyc3', foreign.id);
    for (const call of [
      impl.volumes.deleteVolume(foreignId, ctx()),
      impl.volumes.resizeVolume(foreignId, 500, ctx()),
    ]) {
      const error = await failure(call);
      expect([error.code, error.details?.reason]).toEqual(['INVALID_STATE', 'notManaged']);
    }
    expect(emu.state.nfsShares.has(foreign.id)).toBe(true);
    expect(calls(emu, 'DELETE', /^\/v2\/nfs\//)).toHaveLength(1);
    expect(calls(emu, 'DELETE', /^\/v2\/nfs\//)[0]!.url.searchParams.get('region')).toBe('nyc3');
  });
});

describe('provider-digitalocean NFS shares: attach and detach', () => {
  it("attaches to an instance Droplet in the share's VPC: tags it, no share action", async () => {
    const { emu, impl, vpc } = await setup();
    const droplet = host(emu, vpc);
    const { id } = await impl.volumes.ensureVolume(spec, ctx());
    const attached = await impl.volumes.attachVolume(id, String(droplet.id), ctx(), 'ins_1');
    expect(attached).toMatchObject({
      id,
      state: 'ready',
      outputs: { attachedTo: String(droplet.id), device: expect.stringMatching(/:\//) },
    });
    expect(tagged(emu.state.droplets.get(droplet.id)!, id)).toBe(true);
    expect(shareActions(emu)).toHaveLength(0);
    const before = writes(emu).length;
    expect((await impl.volumes.attachVolume(id, String(droplet.id), ctx())).state).toBe('ready');
    expect(writes(emu)).toHaveLength(before);
    // getVolume names no machine: a share is attached to many.
    expect((await impl.volumes.getVolume(id, ctx()))?.outputs?.attachedTo).toBe(undefined);
  });

  it('attaches another subnet of the same network through a VPC attach, non-blocking', async () => {
    const emu = emulator();
    emu.nfsActionReads = 2;
    const { impl } = await setup(emu);
    const other = subnet(emu, 'net-a-nyc3-b');
    const first = host(emu, other);
    const second = host(emu, other, { instance: 'ins_2' });
    const { id } = await impl.volumes.ensureVolume(spec, ctx());
    const seen: string[] = [];
    for (let i = 0; i < 4; i++)
      seen.push((await impl.volumes.attachVolume(id, String(first.id), ctx())).state);
    expect(seen[0]).toBe('pending');
    expect(seen.at(-1)).toBe('ready');
    expect(shareActions(emu, 'attach')[0]!.body).toEqual({
      type: 'attach',
      region: 'nyc3',
      params: { vpc_id: other.id },
    });
    expect(shareOf(emu, id).vpc_ids.filter((v: string) => v === other.id)).toHaveLength(1);
    // The VPC is there now: a second machine in it needs no action.
    const actions = shareActions(emu).length;
    expect((await impl.volumes.attachVolume(id, String(second.id), ctx())).state).toBe('ready');
    expect(shareActions(emu)).toHaveLength(actions);
  });

  it('refuses a Droplet it may not reach the share from, before any write', async () => {
    const { emu, impl, vpc } = await setup();
    const { id } = await impl.volumes.ensureVolume(spec, ctx());
    const writesBefore = writes(emu).length;
    const defaultVpc = seedVpc(emu.state, { name: 'default-nyc3', region: 'nyc3', default: true });
    const foreignVpc = subnet(emu, 'net-b-nyc3', 'nyc3', 'net-b');
    const plainVpc = seedVpc(emu.state, { name: 'hand-made', region: 'nyc3' });
    const away = subnet(emu, 'net-a-sfo3', 'sfo3');
    const cases: [Json, string | undefined, string, string][] = [
      [host(emu, away), undefined, 'INVALID_INPUT', 'region'],
      [
        host(emu, vpc, { tags: [tagFor(labels.instance, 'ins_1')] }),
        undefined,
        'INVALID_STATE',
        'notInstance',
      ],
      [host(emu, vpc, { instance: 'ins_2' }), 'ins_1', 'INVALID_STATE', 'notInstance'],
      [host(emu, defaultVpc), undefined, 'INVALID_STATE', 'vpcNotManaged'],
      [host(emu, plainVpc), undefined, 'INVALID_STATE', 'vpcNotManaged'],
      [host(emu, foreignVpc), undefined, 'INVALID_STATE', 'otherNetwork'],
    ];
    for (const [droplet, instance, code, reason] of cases) {
      const error = await failure(
        impl.volumes.attachVolume(id, String(droplet.id), ctx(), instance),
      );
      expect([error.code, error.details?.reason], reason).toEqual([code, reason]);
    }
    const missing = await failure(impl.volumes.attachVolume(id, '999999', ctx()));
    expect(missing.code).toBe('NOT_FOUND');
    const foreign = seedShare(emu.state, { name: 'their-share', vpc_ids: [vpc.id] });
    const notOurs = await failure(
      impl.volumes.attachVolume(shareId('nyc3', foreign.id), String(host(emu, vpc).id), ctx()),
    );
    expect([notOurs.code, notOurs.details?.reason]).toEqual(['INVALID_STATE', 'notManaged']);
    const malformed = await failure(
      impl.volumes.attachVolume('nfs:nyc3:x', String(host(emu, vpc).id), ctx()),
    );
    expect(malformed.code).toBe('INVALID_INPUT');
    expect(writes(emu)).toHaveLength(writesBefore);
  });

  it('is pending on a share that is still CREATING, without writing', async () => {
    const emu = emulator();
    emu.nfsCreateReads = 5;
    const { impl, vpc } = await setup(emu);
    const droplet = host(emu, vpc);
    const { id } = await impl.volumes.ensureVolume(spec, ctx());
    const before = writes(emu).length;
    expect((await impl.volumes.attachVolume(id, String(droplet.id), ctx())).state).toBe('pending');
    expect(writes(emu)).toHaveLength(before);
  });

  it('detaches: untags the Droplet, and takes a VPC off once no tagged Droplet is in it', async () => {
    const { emu, impl, vpc } = await setup();
    const home = host(emu, vpc);
    const other = subnet(emu, 'net-a-nyc3-b');
    const first = host(emu, other);
    const second = host(emu, other, { instance: 'ins_2' });
    const { id } = await impl.volumes.ensureVolume(spec, ctx());
    for (const droplet of [home, first, second])
      expect((await impl.volumes.attachVolume(id, String(droplet.id), ctx())).state).toBe('ready');
    expect(shareOf(emu, id).vpc_ids).toEqual([vpc.id, other.id]);

    expect(await impl.volumes.detachVolume(id, String(first.id), ctx())).toEqual({
      id,
      state: 'deleted',
    });
    expect(tagged(emu.state.droplets.get(first.id)!, id)).toBe(false);
    // `second` still reaches it from that VPC.
    expect(shareOf(emu, id).vpc_ids).toEqual([vpc.id, other.id]);
    expect((await impl.volumes.detachVolume(id, String(second.id), ctx())).state).toBe('deleted');
    expect(shareOf(emu, id).vpc_ids).toEqual([vpc.id]);
    expect(shareActions(emu, 'detach')[0]!.body).toEqual({
      type: 'detach',
      region: 'nyc3',
      params: { vpc_id: other.id },
    });
    // The share's last VPC stays: it is the share's home in the tenant network.
    expect((await impl.volumes.detachVolume(id, String(home.id), ctx())).state).toBe('deleted');
    expect(shareOf(emu, id).vpc_ids).toEqual([vpc.id]);
    // Again, and for a Droplet that never had it or is gone: deleted, no writes.
    const before = writes(emu).length;
    for (const machine of [String(home.id), String(host(emu, vpc).id), '999999'])
      expect((await impl.volumes.detachVolume(id, machine, ctx())).state).toBe('deleted');
    expect(writes(emu)).toHaveLength(before);
  });

  it('a VPC detach that runs is deleting until it completes', async () => {
    const emu = emulator();
    const { impl, vpc } = await setup(emu);
    host(emu, vpc);
    const other = subnet(emu, 'net-a-nyc3-b');
    const droplet = host(emu, other);
    const { id } = await impl.volumes.ensureVolume(spec, ctx());
    await impl.volumes.attachVolume(id, String(droplet.id), ctx());
    emu.nfsActionReads = 2;
    const seen: string[] = [];
    for (let i = 0; i < 4; i++)
      seen.push((await impl.volumes.detachVolume(id, String(droplet.id), ctx())).state);
    expect(seen[0]).toBe('deleting');
    expect(seen.at(-1)).toBe('deleted');
    expect(shareOf(emu, id).vpc_ids).toEqual([vpc.id]);
  });

  it('never deletes a share a Droplet still has attached', async () => {
    const { emu, impl, vpc } = await setup();
    const droplet = host(emu, vpc);
    const { id } = await impl.volumes.ensureVolume(spec, ctx());
    await impl.volumes.attachVolume(id, String(droplet.id), ctx());
    const error = await failure(impl.volumes.deleteVolume(id, ctx()));
    expect([error.code, error.details?.reason]).toEqual(['INVALID_STATE', 'attached']);
    expect(emu.state.nfsShares.size).toBe(1);
    await impl.volumes.detachVolume(id, String(droplet.id), ctx());
    expect((await impl.volumes.deleteVolume(id, ctx())).state).toBe('deleted');
  });
});

describe('provider-digitalocean NFS shares: snapshots', () => {
  const snapName = shareName('bc-psnap-1', 'default');

  it('snapshots a share by name through a snapshot action, and a second call finds it', async () => {
    const { emu, impl } = await setup();
    const { id } = await impl.volumes.ensureVolume(spec, ctx());
    const taken = await impl.volumes.snapshotVolume(id, 'bc-psnap-1', ctx());
    const stored = [...emu.state.nfsSnapshots.values()][0]!;
    expect(taken).toEqual({
      id: shareSnapshotId('nyc3', stored.id),
      state: 'ready',
      outputs: { kind: 'shared', volume: id, region: 'nyc3', sizeGiB: '100' },
    });
    expect(stored.name).toBe(snapName);
    expect(shareActions(emu, 'snapshot')[0]!.body).toEqual({
      type: 'snapshot',
      region: 'nyc3',
      params: { name: snapName },
    });
    expect(await impl.volumes.snapshotVolume(id, 'bc-psnap-1', ctx())).toEqual(taken);
    expect(shareActions(emu, 'snapshot')).toHaveLength(1);
    expect(await impl.volumes.getSnapshot(taken.id, ctx())).toEqual(taken);
  });

  it('is UNAVAILABLE while the snapshot action has not made one yet, then ready', async () => {
    const emu = emulator();
    emu.nfsActionReads = 2;
    const { impl } = await setup(emu);
    const { id } = await impl.volumes.ensureVolume(spec, ctx());
    const first = await failure(impl.volumes.snapshotVolume(id, 'bc-psnap-1', ctx()));
    expect([first.code, first.details?.reason]).toEqual(['UNAVAILABLE', 'snapshotUnconfirmed']);
    let got;
    for (let i = 0; i < 3 && got === undefined; i++)
      got = await impl.volumes.snapshotVolume(id, 'bc-psnap-1', ctx()).catch(() => undefined);
    expect(got?.state).toBe('ready');
    expect(emu.state.nfsSnapshots.size).toBe(1);
  });

  it('reports a CREATING snapshot as pending and a FAILED one as error', async () => {
    const { emu, impl } = await setup();
    const { id } = await impl.volumes.ensureVolume(spec, ctx());
    const share = shareOf(emu, id);
    const { seedShareSnapshot } = await import('./support/do-emulator/nfs.js');
    seedShareSnapshot(emu.state, { share, name: snapName, status: 'CREATING' });
    expect((await impl.volumes.snapshotVolume(id, 'bc-psnap-1', ctx())).state).toBe('pending');
    seedShareSnapshot(emu.state, {
      share,
      name: shareName('bc-psnap-2', 'default'),
      status: 'FAILED',
    });
    expect((await impl.volumes.snapshotVolume(id, 'bc-psnap-2', ctx())).state).toBe('error');
    expect(shareActions(emu, 'snapshot')).toHaveLength(0);
  });

  it('two racing snapshots of a name converge on the oldest', async () => {
    const { emu, impl } = await setup();
    const { id } = await impl.volumes.ensureVolume(spec, ctx());
    const share = shareOf(emu, id);
    const { seedShareSnapshot } = await import('./support/do-emulator/nfs.js');
    const oldest = seedShareSnapshot(emu.state, {
      share,
      name: snapName,
      created_at: '2026-11-05T09:00:00Z',
    });
    const later = seedShareSnapshot(emu.state, {
      share,
      name: snapName,
      created_at: '2026-11-05T09:30:00Z',
    });
    const got = await impl.volumes.snapshotVolume(id, 'bc-psnap-1', ctx());
    expect(got.id).toBe(shareSnapshotId('nyc3', oldest.id));
    expect(emu.state.nfsSnapshots.has(later.id)).toBe(false);
  });

  it('deletes a snapshot of ours, idempotently, and never one that is not ours', async () => {
    const { emu, impl } = await setup();
    const { id } = await impl.volumes.ensureVolume(spec, ctx());
    const taken = await impl.volumes.snapshotVolume(id, 'bc-psnap-1', ctx());
    expect(await impl.volumes.deleteSnapshot(taken.id, ctx())).toEqual({
      id: taken.id,
      state: 'deleted',
    });
    expect(emu.state.nfsSnapshots.size).toBe(0);
    expect((await impl.volumes.deleteSnapshot(taken.id, ctx())).state).toBe('deleted');
    const { seedShareSnapshot } = await import('./support/do-emulator/nfs.js');
    const theirs = seedShareSnapshot(emu.state, { share: shareOf(emu, id), name: 'nightly' });
    const error = await failure(
      impl.volumes.deleteSnapshot(shareSnapshotId('nyc3', theirs.id), ctx()),
    );
    expect([error.code, error.details?.reason]).toEqual(['INVALID_STATE', 'notManaged']);
    expect(emu.state.nfsSnapshots.has(theirs.id)).toBe(true);
    const malformed = await failure(impl.volumes.deleteSnapshot('nfssnap:nyc3:x', ctx()));
    expect(malformed.code).toBe('INVALID_INPUT');
    expect(await impl.volumes.getSnapshot('nfssnap:nyc3:x', ctx())).toBe(undefined);
  });

  it('refuses a snapshot of a share that is not ours, and a bad name, before any write', async () => {
    const { emu, impl } = await setup();
    const { id } = await impl.volumes.ensureVolume(spec, ctx());
    const foreign = seedShare(emu.state, { name: 'their-share' });
    const before = writes(emu).length;
    const notOurs = await failure(
      impl.volumes.snapshotVolume(shareId('nyc3', foreign.id), 'bc-psnap-1', ctx()),
    );
    expect([notOurs.code, notOurs.details?.reason]).toEqual(['INVALID_STATE', 'notManaged']);
    const bad = await failure(impl.volumes.snapshotVolume(id, 'bad name!', ctx()));
    expect([bad.code, bad.details?.reason]).toEqual(['INVALID_INPUT', 'name']);
    expect(writes(emu)).toHaveLength(before);
  });
});

describe('provider-digitalocean NFS shares: the mount source', () => {
  it('passes on only a plain address and path, never one a mount line could not carry', () => {
    const base = {
      id: '0b7d9b2c-0000-4000-8000-000000000000',
      name: 'x',
      size_gib: 100,
      region: 'nyc3',
      status: 'ACTIVE',
      created_at: '2026-11-05T10:00:00Z',
      vpc_ids: ['v1', 'v2'],
    };
    expect(shareOutputs({ ...base, host: '10.0.0.2', mount_path: '/1/abc' })).toMatchObject({
      device: '10.0.0.2:/1/abc',
      vpcs: 'v1,v2',
    });
    for (const [host, path] of [
      ['10.0.0.2 nfs4', '/1/abc'],
      ['10.0.0.2', '/1/abc defaults'],
      ['10.0.0.2\n', '/1/abc'],
      ['10.0.0.2', 'relative/path'],
      ['10.0.0.2', '/1/../../etc'],
      ['$(reboot)', '/1/abc'],
    ]) {
      const outputs = shareOutputs({ ...base, host, mount_path: path });
      expect(outputs.device, `${host} ${path}`).toBe(undefined);
    }
  });
});
