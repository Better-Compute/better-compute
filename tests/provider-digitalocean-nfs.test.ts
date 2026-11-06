import { beforeEach, describe, expect, it } from 'vitest';
import { isComputeError, type ComputeError } from '@better-compute/core';
import {
  deploymentTag,
  labels,
  networkDescription,
  shareId,
  shareName,
  type DoCompute,
} from '@better-compute/provider-digitalocean';
import { DoEmulator, type Json, type RecordedRequest } from './support/do-emulator/index.js';
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
