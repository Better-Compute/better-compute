import { describe, expect, it } from 'vitest';
import {
  isComputeError,
  type CallContext,
  type Logger,
  type ProviderImpl,
  type ProviderResourceState,
  type ProviderVolumeSpec,
} from '@better-compute/core';
import {
  awsProvider,
  clientToken,
  type AwsConfig,
  type AwsVolumes,
} from '@better-compute/provider-aws';
import { AwsEmulator } from './support/aws-emulator/index.js';
import { Ec2Emulator } from './support/aws-emulator/ec2.js';
import { EbsEmulator } from './support/aws-emulator/ebs.js';

// AWS A5: EBS volumes and snapshots behind ProviderVolumes, on the EC2/EBS emulator.

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };

function world(config: Partial<AwsConfig> & Record<string, unknown> = {}) {
  const emu = new AwsEmulator();
  const ec2 = new Ec2Emulator(emu);
  const ebs = new EbsEmulator(emu, ec2);
  const lines: string[] = [];
  const log: Logger = {
    debug: (m, f) => lines.push(`${m} ${JSON.stringify(f ?? {})}`),
    info: (m, f) => lines.push(`${m} ${JSON.stringify(f ?? {})}`),
    warn: (m, f) => lines.push(`${m} ${JSON.stringify(f ?? {})}`),
    error: (m, f) => lines.push(`${m} ${JSON.stringify(f ?? {})}`),
  };
  const provider = awsProvider({ fetch: emu.fetch, credentials: emu.ambient });
  const create = () =>
    provider.create(
      provider.config.parse({
        region: 'us-east-1',
        zones: ['us-east-1a', 'us-east-1b'],
        ...config,
      }) as AwsConfig,
      {
        clock: emu.clock,
        log,
        secrets: { resolve: async () => '' },
        account: { id: 'pa_platform', tenantId: 'root', platform: true },
      },
    ) as ProviderImpl;
  const impl = create();
  const volumes = impl.volumes!;
  /** Another control-plane process on the same account: none of this one's memos. */
  const fresh = () => create().volumes!;
  const call = (key = 'pv_test'): CallContext => ({
    idempotencyKey: key,
    signal: new AbortController().signal,
    clock: emu.clock,
    secrets: { resolve: async () => '' },
    log: quiet,
  });
  const spec = (overrides: Partial<ProviderVolumeSpec> = {}): ProviderVolumeSpec => ({
    name: 'bc-v-0001',
    region: 'us-east-1',
    // Two zones: a bare region names no zone, so the spec names one (vps passes it).
    zone: 'us-east-1a',
    sizeGiB: 10,
    kind: 'block',
    ...overrides,
  });
  /** Calls `step` (ticking EBS between calls) until it reports one of `until`. */
  const settle = async (
    step: () => Promise<ProviderResourceState>,
    until: ProviderResourceState['state'][] = ['ready'],
  ) => {
    for (let n = 0; n < 10; n++) {
      const state = await step();
      if (until.includes(state.state)) return state;
      ebs.tick();
    }
    throw new Error('did not settle');
  };
  const managed = { 'better-compute:managed': 'true', 'better-compute:volume': 'bc-v-made' };
  return { emu, ec2, ebs, impl, volumes, fresh, call, spec, settle, lines, managed };
}

async function rejects(promise: Promise<unknown>, code: string, reason?: string) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(isComputeError(error, code as never), String(error)).toBe(true);
  if (reason !== undefined)
    expect((error as { details?: { reason?: string } }).details?.reason).toBe(reason);
  return error;
}

describe('provider-aws volumes: ensure, get, delete', () => {
  it('offers the EBS volume types', () => {
    const { volumes } = world();
    expect(volumes.types).toEqual(['gp3', 'gp2', 'io2', 'io1', 'st1', 'sc1', 'standard']);
    expect(awsProvider().capabilities).toContain('volumes');
  });

  it('creates an encrypted gp3 volume tagged as ours, pending until EBS makes it', async () => {
    const { volumes, call, spec, emu, ebs } = world({
      kmsKeyId: 'arn:aws:kms:us-east-1:222222222222:key/1234abcd-12ab-34cd-56ef-1234567890ab',
    });
    const first = await volumes.ensureVolume(
      spec({ labels: { team: 'ml', managed: 'false', volume: 'x' } }),
      call(),
    );
    expect(first.state).toBe('pending');
    expect(first.id).toMatch(/^vol-[0-9a-f]{17}$/);
    const [request] = emu.calls('CreateVolume');
    const p = request!.params;
    expect(p.get('AvailabilityZone')).toBe('us-east-1a');
    expect(p.get('Size')).toBe('10');
    expect(p.get('VolumeType')).toBe('gp3');
    expect(p.get('Encrypted')).toBe('true');
    expect(p.get('KmsKeyId')).toContain(':key/1234abcd');
    const volume = ebs.volumes.get(first.id)!;
    expect(Object.fromEntries(volume.tags)).toEqual({
      Name: 'bc-v-0001',
      'better-compute:managed': 'true',
      'better-compute:volume': 'bc-v-0001',
      'better-compute:team': 'ml',
    });
    ebs.tick();
    const ready = await volumes.ensureVolume(spec(), call());
    expect(ready).toMatchObject({
      id: first.id,
      state: 'ready',
      outputs: {
        region: 'us-east-1',
        zone: 'us-east-1a',
        sizeGiB: '10',
        type: 'gp3',
        encrypted: 'true',
        serial: first.id.replace('-', ''),
      },
    });
    expect(ready.outputs?.attachedTo).toBeUndefined();
    expect(emu.calls('CreateVolume')).toHaveLength(1);
  });

  it('create is idempotent by client token', async () => {
    const { volumes, call, spec, emu, ebs } = world();
    // The first answer is lost after EBS made the volume.
    let lose = true;
    emu.afterAction('CreateVolume', () => {
      if (lose) {
        lose = false;
        throw new TypeError('fetch failed: connection reset');
      }
    });
    await rejects(volumes.ensureVolume(spec(), call()), 'UNAVAILABLE');
    // Tag reads lag behind the write: the retry creates again, with the same ClientToken.
    ebs.hideFromFilters = new Set(ebs.volumes.keys());
    const again = await volumes.ensureVolume(spec(), call());
    expect(ebs.volumes.size).toBe(1);
    expect(again.id).toBe([...ebs.volumes.keys()][0]);
    const tokens = emu.calls('CreateVolume').map((r) => r.params.get('ClientToken'));
    expect(tokens).toEqual([clientToken('volume:bc-v-0001'), clientToken('volume:bc-v-0001')]);
    // Now this client knows the id: a later ensure reads it, whatever the tag reads say.
    expect((await volumes.ensureVolume(spec({ sizeGiB: 20 }), call())).id).toBe(again.id);
    expect(emu.calls('CreateVolume')).toHaveLength(2);
  });

  it('a lost create retried with other parameters waits instead of making a second volume', async () => {
    const { volumes, call, spec, emu, ebs } = world();
    emu.afterAction('CreateVolume', () => {
      throw new TypeError('fetch failed: connection reset');
    });
    await rejects(volumes.ensureVolume(spec(), call()), 'UNAVAILABLE');
    emu.afterAction('CreateVolume', () => {});
    ebs.hideFromFilters = new Set(ebs.volumes.keys());
    await rejects(
      volumes.ensureVolume(spec({ sizeGiB: 20 }), call()),
      'UNAVAILABLE',
      'not-visible-yet',
    );
    expect(ebs.volumes.size).toBe(1);
    ebs.hideFromFilters.clear();
    expect((await volumes.ensureVolume(spec({ sizeGiB: 20 }), call())).id).toBe(
      [...ebs.volumes.keys()][0],
    );
  });

  it('places the volume in the zone the spec names', async () => {
    const { volumes, call, spec, ebs } = world();
    const byRegion = await volumes.ensureVolume(
      spec({ name: 'a', region: 'us-east-1b', zone: undefined }),
      call(),
    );
    expect(ebs.volumes.get(byRegion.id)!.zone).toBe('us-east-1b');
    const byZone = await volumes.ensureVolume(spec({ name: 'b', zone: 'us-east-1b' }), call());
    expect(ebs.volumes.get(byZone.id)!.zone).toBe('us-east-1b');
    await rejects(
      volumes.ensureVolume(spec({ name: 'c', zone: 'us-east-1c' }), call()),
      'INVALID_INPUT',
      'zone',
    );
    await rejects(
      volumes.ensureVolume(spec({ name: 'd', region: 'eu-west-1' }), call()),
      'INVALID_INPUT',
      'region',
    );
    await rejects(
      volumes.ensureVolume(spec({ name: 'e', region: 'us-east-1a', zone: 'us-east-1b' }), call()),
      'INVALID_INPUT',
      'zone',
    );
  });

  it('a bare region with several zones and no zone is refused, never placed in the first zone', async () => {
    const { volumes, call, spec, emu } = world();
    await rejects(
      volumes.ensureVolume(spec({ region: 'us-east-1', zone: undefined }), call()),
      'INVALID_INPUT',
      'zone-required',
    );
    expect(emu.calls('CreateVolume')).toHaveLength(0);
    // One zone: the region names it.
    const single = world({ zones: ['us-east-1b'] });
    const made = await single.volumes.ensureVolume(
      single.spec({ region: 'us-east-1', zone: undefined }),
      single.call(),
    );
    expect(single.ebs.volumes.get(made.id)!.zone).toBe('us-east-1b');
  });

  it('refuses what EBS cannot be asked for', async () => {
    const { volumes, call, spec, emu } = world();
    await rejects(volumes.ensureVolume(spec({ kind: 'shared' }), call()), 'UNSUPPORTED', 'shared');
    await rejects(
      volumes.ensureVolume(spec({ filesystem: 'ext4' }), call()),
      'UNSUPPORTED',
      'filesystem',
    );
    await rejects(volumes.ensureVolume(spec({ type: 'nvme' }), call()), 'INVALID_INPUT', 'type');
    await rejects(volumes.ensureVolume(spec({ sizeGiB: 0 }), call()), 'INVALID_INPUT', 'size');
    await rejects(volumes.ensureVolume(spec({ sizeGiB: 1.5 }), call()), 'INVALID_INPUT', 'size');
    await rejects(
      volumes.ensureVolume(spec({ type: 'st1', sizeGiB: 100 }), call()),
      'INVALID_INPUT',
      'size',
    );
    await rejects(
      volumes.ensureVolume(spec({ type: 'st1', sizeGiB: 125, iops: 3000 }), call()),
      'INVALID_INPUT',
      'iops',
    );
    await rejects(
      volumes.ensureVolume(spec({ type: 'io2', throughputMiBps: 500 }), call()),
      'INVALID_INPUT',
      'throughput',
    );
    await rejects(
      volumes.ensureVolume(spec({ name: 'bad\nname' }), call()),
      'INVALID_INPUT',
      'name',
    );
    expect(emu.calls('CreateVolume')).toHaveLength(0);
  });

  it('passes provisioned IOPS and throughput', async () => {
    const { volumes, call, spec, emu } = world();
    await volumes.ensureVolume(spec({ type: 'gp3', iops: 6000, throughputMiBps: 500 }), call());
    const p = emu.calls('CreateVolume')[0]!.params;
    expect([p.get('Iops'), p.get('Throughput')]).toEqual(['6000', '500']);
  });

  it('a volume deleted outside better-compute is an error, never pending forever', async () => {
    const { volumes, fresh, call, spec, emu, ebs } = world();
    const made = await volumes.ensureVolume(spec(), call());
    ebs.tick();
    expect((await volumes.ensureVolume(spec(), call())).state).toBe('ready');
    // An operator deletes it: EBS still lists the deleting twin under the name.
    ebs.volumes.get(made.id)!.state = 'deleting';
    const outside = await volumes.ensureVolume(spec(), call());
    expect(outside).toMatchObject({
      id: made.id,
      state: 'error',
      outputs: { reason: 'deleted-outside' },
    });
    expect(outside.message).toContain('deleted outside better-compute');
    expect(await fresh().ensureVolume(spec(), call())).toMatchObject({ state: 'error' });
    // Gone from the listing: where EBS answers the old ClientToken with the deleted volume, that is
    // the same error, and the id is not remembered as one this client is waiting on.
    ebs.retainClientTokens = true;
    ebs.tick();
    ebs.tick();
    expect(ebs.volumes.has(made.id)).toBe(false);
    const again = fresh();
    expect(await again.ensureVolume(spec(), call())).toMatchObject({
      id: made.id,
      state: 'error',
      outputs: { reason: 'deleted-outside' },
    });
    expect(await again.getVolume(made.id, call())).toBeUndefined();
    expect(ebs.volumes.size).toBe(0);
    expect(emu.calls('CreateVolume')).toHaveLength(2);
  });

  it('a volume this client is deleting reads deleting, not an error', async () => {
    const { volumes, call, spec, ebs } = world();
    const made = await volumes.ensureVolume(spec(), call());
    ebs.tick();
    expect((await volumes.deleteVolume(made.id, call())).state).toBe('deleting');
    expect(await volumes.ensureVolume(spec(), call())).toMatchObject({
      id: made.id,
      state: 'deleting',
    });
    ebs.tick();
    expect((await volumes.ensureVolume(spec(), call())).state).toBe('deleted');
  });

  it('getVolume: undefined for a missing or malformed id, pending while a new one is not visible', async () => {
    const { volumes, call, spec, ebs } = world();
    expect(await volumes.getVolume('vol-0000000000000dead', call())).toBeUndefined();
    expect(await volumes.getVolume('i-0123456789abcdef0', call())).toBeUndefined();
    ebs.newVolumeNotFound = 1;
    const made = await volumes.ensureVolume(spec(), call());
    expect(await volumes.getVolume(made.id, call())).toMatchObject({
      id: made.id,
      state: 'pending',
    });
    expect(await volumes.getVolume(made.id, call())).toMatchObject({
      id: made.id,
      state: 'pending',
    });
    ebs.tick();
    expect(await volumes.getVolume(made.id, call())).toMatchObject({ state: 'ready' });
  });

  it("findVolume: this deployment's volume of a name, never created (a delete whose create answer was lost)", async () => {
    const { volumes, call, ebs, emu, managed } = world();
    const find = (name: string, region: string) =>
      (volumes as AwsVolumes).findVolume(name, region, call());
    expect(await find('bc-v-made', 'us-east-1')).toBeUndefined();
    // Another's volume of the name (no managed tag) is none.
    ebs.addVolume({ tags: { 'better-compute:volume': 'bc-v-made' } });
    expect(await find('bc-v-made', 'us-east-1')).toBeUndefined();
    const mine = ebs.addVolume({ zone: 'us-east-1a', tags: managed });
    expect(await find('bc-v-made', 'us-east-1')).toMatchObject({ id: mine.id, state: 'ready' });
    // vps keeps an AWS volume's region as its zone: the same zone finds it, another zone does not.
    expect(await find('bc-v-made', 'us-east-1a')).toMatchObject({ id: mine.id });
    expect(await find('bc-v-made', 'us-east-1b')).toBeUndefined();
    expect(await find('bc-v-made', 'eu-west-1')).toBeUndefined();
    expect(await find('', 'us-east-1')).toBeUndefined();
    // A volume that is gone has nothing left to delete.
    mine.state = 'deleted';
    expect(await find('bc-v-made', 'us-east-1')).toBeUndefined();
    expect(emu.calls('CreateVolume')).toHaveLength(0);
  });

  it('findVolume: a volume this client just made, not visible to any read yet, is pending', async () => {
    const { volumes, fresh, call, spec, ebs, emu } = world();
    ebs.newVolumeNotFound = 2;
    const made = await volumes.ensureVolume(spec(), call());
    ebs.hideFromFilters.add(made.id);
    expect(
      await (volumes as AwsVolumes).findVolume('bc-v-0001', 'us-east-1a', call()),
    ).toMatchObject({ id: made.id, state: 'pending' });
    // Another process (none of this one's memos) does not see it yet: none, and nothing created.
    expect(
      await (fresh() as AwsVolumes).findVolume('bc-v-0001', 'us-east-1a', call()),
    ).toBeUndefined();
    expect(emu.calls('CreateVolume')).toHaveLength(1);
  });

  it('refuses mutating an untagged volume', async () => {
    const { volumes, call, ebs, emu } = world();
    const foreign = ebs.addVolume({ tags: { Name: 'theirs' } });
    await rejects(volumes.deleteVolume(foreign.id, call()), 'INVALID_STATE', 'not-managed');
    await rejects(volumes.resizeVolume(foreign.id, 20, call()), 'INVALID_STATE', 'not-managed');
    await rejects(volumes.snapshotVolume(foreign.id, 's', call()), 'INVALID_STATE', 'not-managed');
    expect(emu.calls('DeleteVolume')).toHaveLength(0);
    expect(emu.calls('ModifyVolume')).toHaveLength(0);
    expect(emu.calls('CreateSnapshot')).toHaveLength(0);
    // A tenant label never makes a volume look managed.
    expect(ebs.volumes.get(foreign.id)!.state).toBe('available');
  });

  it('never touches a root volume (managed and instance tags, no volume name)', async () => {
    const { volumes, call, ebs, emu, ec2 } = world();
    const rootTags = { 'better-compute:managed': 'true', 'better-compute:instance': 'ins_a' };
    const a = ec2.addInstance({ tags: rootTags });
    const b = ec2.addInstance({
      tags: { 'better-compute:managed': 'true', 'better-compute:instance': 'ins_b' },
    });
    // a's root volume, attached; and a stopped instance's root volume another tenant might want.
    const attachedRoot = ebs.addVolume({
      tags: rootTags,
      attachedTo: { instanceId: a.id, device: '/dev/sdf' },
    });
    const freeRoot = ebs.addVolume({ tags: rootTags });
    await rejects(
      volumes.attachVolume(freeRoot.id, b.id, call(), 'ins_b'),
      'INVALID_STATE',
      'not-managed',
    );
    await rejects(
      volumes.detachVolume(attachedRoot.id, a.id, call()),
      'INVALID_STATE',
      'not-managed',
    );
    await rejects(
      volumes.detachVolume(attachedRoot.id, a.id, call(), { force: true }),
      'INVALID_STATE',
      'not-managed',
    );
    await rejects(
      volumes.resizeVolume(attachedRoot.id, 200, call()),
      'INVALID_STATE',
      'not-managed',
    );
    await rejects(
      volumes.snapshotVolume(attachedRoot.id, 'bc-s-root', call()),
      'INVALID_STATE',
      'not-managed',
    );
    await rejects(volumes.deleteVolume(freeRoot.id, call()), 'INVALID_STATE', 'not-managed');
    for (const action of [
      'AttachVolume',
      'DetachVolume',
      'ModifyVolume',
      'CreateSnapshot',
      'DeleteVolume',
    ])
      expect(emu.calls(action), action).toHaveLength(0);
  });

  it('delete: refused while attached, then deleting, then deleted (idempotent)', async () => {
    const { volumes, call, ebs, emu, managed, ec2 } = world();
    const instance = ec2.addInstance({ tags: { 'better-compute:instance': 'ins_1' } });
    const attached = ebs.addVolume({
      tags: managed,
      attachedTo: { instanceId: instance.id, device: '/dev/sdf' },
    });
    await rejects(volumes.deleteVolume(attached.id, call()), 'INVALID_STATE', 'attached');
    expect(emu.calls('DeleteVolume')).toHaveLength(0);
    const free = ebs.addVolume({ tags: managed });
    expect((await volumes.deleteVolume(free.id, call())).state).toBe('deleting');
    expect((await volumes.deleteVolume(free.id, call())).state).toBe('deleting');
    ebs.tick();
    expect((await volumes.deleteVolume(free.id, call())).state).toBe('deleted');
    ebs.tick();
    expect((await volumes.deleteVolume(free.id, call())).state).toBe('deleted');
    expect(await volumes.getVolume(free.id, call())).toBeUndefined();
    await rejects(volumes.deleteVolume('not-a-volume', call()), 'INVALID_INPUT');
  });

  it('a deleting or deleted volume is not attached, resized or snapshotted', async () => {
    const { volumes, call, ebs, emu, managed, ec2 } = world();
    const instance = ec2.addInstance({ tags: { 'better-compute:instance': 'ins_1' } });
    const deleting = ebs.addVolume({ tags: managed, state: 'deleting' });
    const deleted = ebs.addVolume({ tags: managed, state: 'deleted' });
    await rejects(
      volumes.attachVolume(deleting.id, instance.id, call()),
      'INVALID_STATE',
      'deleting',
    );
    await rejects(volumes.resizeVolume(deleting.id, 20, call()), 'INVALID_STATE', 'deleting');
    await rejects(
      volumes.snapshotVolume(deleting.id, 'bc-s-0009', call()),
      'INVALID_STATE',
      'deleting',
    );
    await rejects(volumes.attachVolume(deleted.id, instance.id, call()), 'NOT_FOUND', 'volume');
    await rejects(volumes.resizeVolume(deleted.id, 20, call()), 'NOT_FOUND', 'volume');
    await rejects(volumes.snapshotVolume(deleted.id, 'bc-s-0009', call()), 'NOT_FOUND', 'volume');
    expect(emu.calls('AttachVolume')).toHaveLength(0);
    expect(emu.calls('ModifyVolume')).toHaveLength(0);
    expect(emu.calls('CreateSnapshot')).toHaveLength(0);
  });
});

describe('provider-aws volumes: attach, detach', () => {
  const owned = (ec2: Ec2Emulator, instanceId = 'ins_1', zone = 'us-east-1a') =>
    ec2.addInstance({
      zone,
      tags: { 'better-compute:instance': instanceId, 'better-compute:managed': 'true' },
    });

  it('attach picks the next free device and settles to ready', async () => {
    const { volumes, call, ebs, ec2, emu, managed, settle } = world();
    const instance = owned(ec2);
    ebs.addVolume({ tags: managed, attachedTo: { instanceId: instance.id, device: '/dev/sdf' } });
    ebs.addVolume({ tags: managed, attachedTo: { instanceId: instance.id, device: '/dev/xvdg' } });
    const volume = ebs.addVolume({ tags: managed });
    const first = await volumes.attachVolume(volume.id, instance.id, call(), 'ins_1');
    expect(first.state).toBe('pending');
    const p = emu.calls('AttachVolume')[0]!.params;
    expect([p.get('VolumeId'), p.get('InstanceId'), p.get('Device')]).toEqual([
      volume.id,
      instance.id,
      '/dev/sdh',
    ]);
    const ready = await settle(() => volumes.attachVolume(volume.id, instance.id, call(), 'ins_1'));
    expect(ready.outputs).toMatchObject({
      attachedTo: instance.id,
      attachDevice: '/dev/sdh',
      serial: volume.id.replace('-', ''),
      device: `/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${volume.id.replace('-', '')}`,
    });
    expect(emu.calls('AttachVolume')).toHaveLength(1);
    expect((await volumes.getVolume(volume.id, call()))?.outputs?.attachedTo).toBe(instance.id);
  });

  it('refuses attaching across zones before any write', async () => {
    const { volumes, call, ebs, ec2, emu, managed } = world();
    const instance = owned(ec2, 'ins_1', 'us-east-1b');
    const volume = ebs.addVolume({ tags: managed, zone: 'us-east-1a' });
    await rejects(
      volumes.attachVolume(volume.id, instance.id, call()),
      'INVALID_INPUT',
      'zone-mismatch',
    );
    expect(emu.calls('AttachVolume')).toHaveLength(0);
  });

  it('attaches only to an instance of this deployment, and of the instance named', async () => {
    const { volumes, call, ebs, ec2, emu, managed } = world();
    const volume = ebs.addVolume({ tags: managed });
    const foreign = ec2.addInstance({ tags: { Name: 'theirs' } });
    await rejects(
      volumes.attachVolume(volume.id, foreign.id, call()),
      'INVALID_STATE',
      'not-instance',
    );
    const other = owned(ec2, 'ins_2');
    await rejects(
      volumes.attachVolume(volume.id, other.id, call(), 'ins_1'),
      'INVALID_STATE',
      'not-instance',
    );
    const gone = owned(ec2, 'ins_3');
    gone.state = 'terminated';
    await rejects(
      volumes.attachVolume(volume.id, gone.id, call(), 'ins_3'),
      'INVALID_STATE',
      'instance-state',
    );
    await rejects(volumes.attachVolume(volume.id, 'i-0000000000000dead', call()), 'NOT_FOUND');
    await rejects(volumes.attachVolume(volume.id, 'srv-1', call()), 'INVALID_INPUT');
    const theirs = ebs.addVolume({ tags: { Name: 'x' } });
    await rejects(
      volumes.attachVolume(theirs.id, other.id, call(), 'ins_2'),
      'INVALID_STATE',
      'not-managed',
    );
    expect(emu.calls('AttachVolume')).toHaveLength(0);
  });

  it('a volume attached to another machine is CONFLICT; a pending instance or volume waits', async () => {
    const { volumes, call, ebs, ec2, emu, managed } = world();
    const a = owned(ec2, 'ins_a');
    const b = owned(ec2, 'ins_b');
    const volume = ebs.addVolume({
      tags: managed,
      attachedTo: { instanceId: a.id, device: '/dev/sdf' },
    });
    await rejects(
      volumes.attachVolume(volume.id, b.id, call(), 'ins_b'),
      'CONFLICT',
      'attached-elsewhere',
    );
    const creating = ebs.addVolume({ tags: managed, state: 'creating' });
    expect((await volumes.attachVolume(creating.id, b.id, call(), 'ins_b')).state).toBe('pending');
    const starting = owned(ec2, 'ins_c');
    starting.state = 'pending';
    const free = ebs.addVolume({ tags: managed });
    expect((await volumes.attachVolume(free.id, starting.id, call(), 'ins_c')).state).toBe(
      'pending',
    );
    expect(emu.calls('AttachVolume')).toHaveLength(0);
  });

  it('no free device is QUOTA_EXCEEDED', async () => {
    const { volumes, call, ebs, ec2, managed } = world();
    const instance = owned(ec2);
    for (const letter of 'fghijklmnop')
      ebs.addVolume({
        tags: managed,
        attachedTo: { instanceId: instance.id, device: `/dev/sd${letter}` },
      });
    const volume = ebs.addVolume({ tags: managed });
    await rejects(
      volumes.attachVolume(volume.id, instance.id, call(), 'ins_1'),
      'QUOTA_EXCEEDED',
      'devices',
    );
  });

  it('a lost race for the device or the volume is retried, never misreported', async () => {
    const { volumes, call, ebs, ec2, emu, managed } = world();
    const instance = owned(ec2);
    const volume = ebs.addVolume({ tags: managed });
    emu.beforeAction('AttachVolume', () => {
      emu.beforeAction('AttachVolume', () => {});
      ebs.addVolume({ tags: managed, attachedTo: { instanceId: instance.id, device: '/dev/sdf' } });
    });
    await rejects(
      volumes.attachVolume(volume.id, instance.id, call(), 'ins_1'),
      'UNAVAILABLE',
      'device-race',
    );
    expect((await volumes.attachVolume(volume.id, instance.id, call(), 'ins_1')).state).toBe(
      'pending',
    );
    expect(ebs.volumes.get(volume.id)!.attachment?.device).toBe('/dev/sdg');
  });

  it('two attaches to one instance in a pass never pick one device, whatever the reads lag', async () => {
    const { volumes, call, ebs, ec2, emu, managed } = world();
    const instance = owned(ec2);
    ebs.attachmentReadLag = true;
    const first = ebs.addVolume({ tags: managed });
    const second = ebs.addVolume({ tags: { ...managed, 'better-compute:volume': 'bc-v-two' } });
    expect((await volumes.attachVolume(first.id, instance.id, call(), 'ins_1')).state).toBe(
      'pending',
    );
    // The attachment reads do not show the first attach yet: this client remembers its device.
    expect((await volumes.attachVolume(second.id, instance.id, call(), 'ins_1')).state).toBe(
      'pending',
    );
    expect(emu.calls('AttachVolume').map((c) => c.params.get('Device'))).toEqual([
      '/dev/sdf',
      '/dev/sdg',
    ]);
  });

  it('an attachment point another writer took, unseen by any read, is a retried device race', async () => {
    const { volumes, fresh, call, ebs, ec2, emu, managed } = world();
    const instance = owned(ec2);
    ebs.attachmentReadLag = true;
    const theirs = ebs.addVolume({ tags: managed });
    const ours = ebs.addVolume({ tags: { ...managed, 'better-compute:volume': 'bc-v-two' } });
    // Another control-plane process attached at /dev/sdf; no read shows it yet.
    await fresh().attachVolume(theirs.id, instance.id, call(), 'ins_1');
    await rejects(
      volumes.attachVolume(ours.id, instance.id, call(), 'ins_1'),
      'UNAVAILABLE',
      'device-race',
    );
    // The retry skips the device EC2 refused.
    expect((await volumes.attachVolume(ours.id, instance.id, call(), 'ins_1')).state).toBe(
      'pending',
    );
    expect(ebs.volumes.get(ours.id)!.attachment?.device).toBe('/dev/sdg');
    expect(emu.calls('AttachVolume')).toHaveLength(3);
  });

  it('detach: deleting, then deleted; never detaches from another machine', async () => {
    const { volumes, call, ebs, ec2, emu, managed, settle } = world();
    const a = owned(ec2, 'ins_a');
    const b = owned(ec2, 'ins_b');
    const volume = ebs.addVolume({
      tags: managed,
      attachedTo: { instanceId: a.id, device: '/dev/sdf' },
    });
    expect((await volumes.detachVolume(volume.id, b.id, call())).state).toBe('deleted');
    expect(emu.calls('DetachVolume')).toHaveLength(0);
    expect((await volumes.detachVolume(volume.id, a.id, call())).state).toBe('deleting');
    const p = emu.calls('DetachVolume')[0]!.params;
    expect([p.get('VolumeId'), p.get('InstanceId'), p.get('Force')]).toEqual([
      volume.id,
      a.id,
      null,
    ]);
    await settle(() => volumes.detachVolume(volume.id, a.id, call()), ['deleted']);
    expect(emu.calls('DetachVolume')).toHaveLength(1);
    expect((await volumes.getVolume(volume.id, call()))?.outputs?.attachedTo).toBeUndefined();
    expect((await volumes.detachVolume('vol-0000000000000dead', a.id, call())).state).toBe(
      'deleted',
    );
    const theirs = ebs.addVolume({
      tags: { Name: 'x' },
      attachedTo: { instanceId: a.id, device: '/dev/sdg' },
    });
    await rejects(volumes.detachVolume(theirs.id, a.id, call()), 'INVALID_STATE', 'not-managed');
  });

  it('a volume attached to an instance that terminates reads detached, not deleted', async () => {
    const { volumes, call, ebs, ec2, managed } = world();
    const a = owned(ec2, 'ins_a');
    const volume = ebs.addVolume({
      tags: managed,
      attachedTo: { instanceId: a.id, device: '/dev/sdf' },
    });
    expect((await volumes.getVolume(volume.id, call()))?.outputs?.attachedTo).toBe(a.id);
    // AttachVolume leaves DeleteOnTermination false: EC2 detaches the volume and keeps it.
    a.state = 'shutting-down';
    ebs.tick();
    expect(ebs.volumes.get(volume.id)!.attachment?.state).toBe('detaching');
    ec2.tick();
    ebs.tick();
    const read = await volumes.getVolume(volume.id, call());
    expect(read).toMatchObject({ state: 'ready' });
    expect(read?.outputs?.attachedTo).toBeUndefined();
    expect(ebs.volumes.get(volume.id)!.state).toBe('available');
  });

  it('force: a detach stuck in detaching is forced (DetachVolume Force=true), once', async () => {
    const { volumes, call, ebs, ec2, emu, managed } = world();
    const a = owned(ec2, 'ins_a');
    const b = owned(ec2, 'ins_b');
    const volume = ebs.addVolume({
      tags: managed,
      attachedTo: { instanceId: a.id, device: '/dev/sdf' },
    });
    ebs.stuckDetach.add(volume.id);
    expect((await volumes.detachVolume(volume.id, a.id, call())).state).toBe('deleting');
    ebs.tick();
    ebs.tick();
    // The guest never let go: still detaching, and a plain retry does not call again.
    expect((await volumes.detachVolume(volume.id, a.id, call())).state).toBe('deleting');
    expect(emu.calls('DetachVolume')).toHaveLength(1);
    // Forced: another machine's attachment is still never touched.
    expect((await volumes.detachVolume(volume.id, b.id, call(), { force: true })).state).toBe(
      'deleted',
    );
    expect((await volumes.detachVolume(volume.id, a.id, call(), { force: true })).state).toBe(
      'deleting',
    );
    const calls = emu.calls('DetachVolume');
    expect(calls).toHaveLength(2);
    expect([calls[1]!.params.get('InstanceId'), calls[1]!.params.get('Force')]).toEqual([
      a.id,
      'true',
    ]);
    ebs.tick();
    expect((await volumes.detachVolume(volume.id, a.id, call(), { force: true })).state).toBe(
      'deleted',
    );
    expect(emu.calls('DetachVolume')).toHaveLength(2);
    // An attached (not yet detaching) volume is forced straight away; foreign ones are refused.
    const other = ebs.addVolume({
      tags: { ...managed, 'better-compute:volume': 'bc-v-other' },
      attachedTo: { instanceId: a.id, device: '/dev/sdg' },
    });
    expect((await volumes.detachVolume(other.id, a.id, call(), { force: true })).state).toBe(
      'deleting',
    );
    expect(emu.calls('DetachVolume')[2]!.params.get('Force')).toBe('true');
    const theirs = ebs.addVolume({
      tags: { Name: 'x' },
      attachedTo: { instanceId: a.id, device: '/dev/sdh' },
    });
    await rejects(
      volumes.detachVolume(theirs.id, a.id, call(), { force: true }),
      'INVALID_STATE',
      'not-managed',
    );
  });
});

describe('provider-aws volumes: resize', () => {
  it('grows through ModifyVolume: updating, then ready at the new size', async () => {
    const { volumes, call, ebs, emu, managed } = world();
    const volume = ebs.addVolume({ tags: managed, sizeGiB: 10 });
    expect((await volumes.resizeVolume(volume.id, 10, call())).state).toBe('ready');
    await rejects(volumes.resizeVolume(volume.id, 9, call()), 'INVALID_INPUT', 'shrink');
    await rejects(volumes.resizeVolume(volume.id, 12.5, call()), 'INVALID_INPUT', 'size');
    expect(emu.calls('ModifyVolume')).toHaveLength(0);
    expect((await volumes.resizeVolume(volume.id, 20, call())).state).toBe('updating');
    expect(emu.calls('ModifyVolume')[0]!.params.get('Size')).toBe('20');
    // Still modifying: the same target waits; a larger one waits for the cooldown.
    expect((await volumes.resizeVolume(volume.id, 20, call())).state).toBe('updating');
    expect(emu.calls('ModifyVolume')).toHaveLength(1);
    ebs.tick();
    const grown = await volumes.resizeVolume(volume.id, 20, call());
    expect(grown).toMatchObject({ state: 'ready', outputs: { sizeGiB: '20' } });
    expect((await volumes.getVolume(volume.id, call()))?.outputs?.sizeGiB).toBe('20');
  });

  it('resize cooldown is RATE_LIMITED', async () => {
    const { volumes, call, ebs, emu, managed } = world();
    const volume = ebs.addVolume({ tags: managed, sizeGiB: 10 });
    await volumes.resizeVolume(volume.id, 20, call());
    ebs.tick();
    ebs.tick();
    emu.clock.advance(3_600_000);
    const error = (await rejects(
      volumes.resizeVolume(volume.id, 30, call()),
      'RATE_LIMITED',
      'cooldown',
    )) as {
      details?: { retryAfterMs?: number };
    };
    expect(error.details?.retryAfterMs).toBe(5 * 3_600_000);
    expect(emu.calls('ModifyVolume')).toHaveLength(1);
    emu.clock.advance(5 * 3_600_000);
    expect((await volumes.resizeVolume(volume.id, 30, call())).state).toBe('updating');
    expect(emu.calls('ModifyVolume')).toHaveLength(2);
  });

  it("EBS's own cooldown and modification-state refusals are RATE_LIMITED too", async () => {
    const { volumes, call, ebs, emu, managed } = world();
    const volume = ebs.addVolume({ tags: managed, sizeGiB: 10 });
    emu.failNext('ModifyVolume', 'VolumeModificationRateExceeded');
    await rejects(volumes.resizeVolume(volume.id, 20, call()), 'RATE_LIMITED', 'cooldown');
    emu.failNext('ModifyVolume', 'IncorrectModificationState');
    await rejects(volumes.resizeVolume(volume.id, 20, call()), 'RATE_LIMITED', 'cooldown');
  });

  it('a retry of its own resize waits while DescribeVolumes still shows the old size', async () => {
    const { volumes, call, ebs, emu, managed } = world();
    ebs.sizeShownWhen = 'completed';
    const volume = ebs.addVolume({ tags: managed, sizeGiB: 10 });
    expect((await volumes.resizeVolume(volume.id, 20, call())).state).toBe('updating');
    ebs.tick(); // optimizing; the size still reads 10
    expect(ebs.modifications[0]!.state).toBe('optimizing');
    expect((await volumes.resizeVolume(volume.id, 20, call())).state).toBe('updating');
    ebs.tick(); // completed: 20
    expect(await volumes.resizeVolume(volume.id, 20, call())).toMatchObject({
      state: 'ready',
      outputs: { sizeGiB: '20' },
    });
    expect(emu.calls('ModifyVolume')).toHaveLength(1);
  });

  it('a retry right after ModifyVolume, before EBS lists the modification, starts no second one', async () => {
    const { volumes, call, ebs, emu, managed } = world();
    const volume = ebs.addVolume({ tags: managed, sizeGiB: 10 });
    ebs.hiddenModifications.add(volume.id);
    expect((await volumes.resizeVolume(volume.id, 20, call())).state).toBe('updating');
    expect((await volumes.resizeVolume(volume.id, 20, call())).state).toBe('updating');
    // A larger target in that window waits for the cooldown of the one this client started.
    const error = (await rejects(
      volumes.resizeVolume(volume.id, 30, call()),
      'RATE_LIMITED',
      'cooldown',
    )) as { details?: { retryAfterMs?: number } };
    expect(error.details?.retryAfterMs).toBe(6 * 3_600_000);
    expect(emu.calls('ModifyVolume')).toHaveLength(1);
    ebs.hiddenModifications.clear();
    ebs.tick();
    expect((await volumes.resizeVolume(volume.id, 20, call())).state).toBe('ready');
  });

  it('a failed modification is retried: no local cooldown, EBS has the last word', async () => {
    const { volumes, call, ebs, emu, managed } = world();
    const volume = ebs.addVolume({ tags: managed, sizeGiB: 10 });
    await volumes.resizeVolume(volume.id, 20, call());
    ebs.modifications[0]!.state = 'failed';
    emu.clock.advance(60_000);
    // Where EBS lets a failed modification be retried at once, the retry goes through.
    ebs.failedModificationCoolsDown = false;
    expect((await volumes.resizeVolume(volume.id, 20, call())).state).toBe('updating');
    expect(emu.calls('ModifyVolume')).toHaveLength(2);
    // Where EBS still counts it, its refusal is RATE_LIMITED.
    ebs.modifications[1]!.state = 'failed';
    emu.clock.advance(200_000);
    ebs.failedModificationCoolsDown = true;
    await rejects(volumes.resizeVolume(volume.id, 20, call()), 'RATE_LIMITED', 'cooldown');
  });
});

describe('provider-aws volumes: snapshots and restores', () => {
  it('snapshots by name, once, tagged as ours', async () => {
    const { volumes, call, ebs, emu, managed } = world();
    const volume = ebs.addVolume({ tags: managed, sizeGiB: 12 });
    const first = await volumes.snapshotVolume(volume.id, 'bc-s-0001', call());
    expect(first).toMatchObject({ state: 'pending' });
    expect(first.id).toMatch(/^snap-[0-9a-f]{17}$/);
    const snapshot = ebs.snapshots.get(first.id)!;
    expect(Object.fromEntries(snapshot.tags)).toEqual({
      Name: 'bc-s-0001',
      'better-compute:managed': 'true',
      'better-compute:snapshot': 'bc-s-0001',
    });
    // Tag reads lag: this client still knows the id.
    ebs.hideFromFilters = new Set([first.id]);
    expect((await volumes.snapshotVolume(volume.id, 'bc-s-0001', call())).id).toBe(first.id);
    ebs.hideFromFilters.clear();
    ebs.tick();
    const ready = await volumes.snapshotVolume(volume.id, 'bc-s-0001', call());
    expect(ready).toMatchObject({
      id: first.id,
      state: 'ready',
      outputs: { volume: volume.id, region: 'us-east-1', sizeGiB: '12' },
    });
    expect(emu.calls('CreateSnapshot')).toHaveLength(1);
    expect(await volumes.getSnapshot(first.id, call())).toMatchObject({ state: 'ready' });
    expect(await volumes.getSnapshot('snap-0000000000000dead', call())).toBeUndefined();
    expect(await volumes.getSnapshot('vol-0000000000000dead', call())).toBeUndefined();
    // The snapshot names one volume: the same name on another volume is a conflict.
    const other = ebs.addVolume({ tags: managed });
    await rejects(
      volumes.snapshotVolume(other.id, 'bc-s-0001', call()),
      'CONFLICT',
      'snapshot-name',
    );
  });

  it('a second snapshot of one name (a restart inside the tag-read lag) is deleted, the oldest kept', async () => {
    const { volumes, fresh, call, ebs, emu, managed } = world();
    const volume = ebs.addVolume({ tags: managed });
    const first = await volumes.snapshotVolume(volume.id, 'bc-s-0001', call());
    // The control plane restarts before vps records the id, and the tag reads lag.
    ebs.hideFromFilters = new Set([first.id]);
    emu.clock.advance(1_000);
    const restarted = fresh();
    const second = await restarted.snapshotVolume(volume.id, 'bc-s-0001', call());
    expect(second.id).not.toBe(first.id);
    expect(ebs.snapshots.size).toBe(2);
    ebs.hideFromFilters.clear();
    // The next call sees both: it keeps the oldest and deletes the other.
    const kept = await restarted.snapshotVolume(volume.id, 'bc-s-0001', call());
    expect(kept.id).toBe(first.id);
    expect([...ebs.snapshots.keys()]).toEqual([first.id]);
    expect(emu.calls('DeleteSnapshot').map((c) => c.params.get('SnapshotId'))).toEqual([second.id]);
    expect(emu.calls('CreateSnapshot')).toHaveLength(2);
  });

  it('deleting a snapshot also deletes the other snapshots of its name', async () => {
    const { volumes, fresh, call, ebs, emu, managed } = world();
    const volume = ebs.addVolume({ tags: managed });
    const first = await volumes.snapshotVolume(volume.id, 'bc-s-0002', call());
    ebs.hideFromFilters = new Set([first.id]);
    emu.clock.advance(1_000);
    // vps holds the second one's id and never asks again before deleting it.
    const held = await fresh().snapshotVolume(volume.id, 'bc-s-0002', call());
    ebs.hideFromFilters.clear();
    const other = ebs.addSnapshot({
      tags: { 'better-compute:managed': 'true', 'better-compute:snapshot': 'bc-s-other' },
    });
    expect((await fresh().deleteSnapshot(held.id, call())).state).toBe('deleted');
    expect(ebs.snapshots.has(first.id)).toBe(false);
    expect(ebs.snapshots.has(held.id)).toBe(false);
    expect(ebs.snapshots.has(other.id)).toBe(true);
  });

  it('deletes only its own snapshots, idempotently', async () => {
    const { volumes, call, ebs, emu, managed } = world();
    const foreign = ebs.addSnapshot({ tags: { Name: 'theirs' } });
    await rejects(volumes.deleteSnapshot(foreign.id, call()), 'INVALID_STATE', 'not-managed');
    const volume = ebs.addVolume({ tags: managed });
    const made = await volumes.snapshotVolume(volume.id, 'bc-s-0002', call());
    ebs.snapshots.get(made.id)!.inUse = true;
    await rejects(volumes.deleteSnapshot(made.id, call()), 'INVALID_STATE', 'in-use');
    ebs.snapshots.get(made.id)!.inUse = false;
    expect((await volumes.deleteSnapshot(made.id, call())).state).toBe('deleted');
    expect((await volumes.deleteSnapshot(made.id, call())).state).toBe('deleted');
    expect(emu.calls('DeleteSnapshot')).toHaveLength(2);
    await rejects(volumes.deleteSnapshot('not-a-snapshot', call()), 'INVALID_INPUT');
  });

  it('a public or shared snapshot of another account is never used, whatever its tags', async () => {
    const { volumes, call, spec, ebs, emu } = world();
    const publicOne = ebs.addSnapshot({
      ownerId: '999999999999',
      volumeSize: 10,
      tags: { 'better-compute:managed': 'true', 'better-compute:snapshot': 'bc-s-0001' },
    });
    await rejects(
      volumes.ensureVolume(spec({ snapshotId: publicOne.id }), call()),
      'INVALID_INPUT',
      'snapshot',
    );
    expect(await volumes.getSnapshot(publicOne.id, call())).toBeUndefined();
    expect((await volumes.deleteSnapshot(publicOne.id, call())).state).toBe('deleted');
    expect(emu.calls('CreateVolume')).toHaveLength(0);
    expect(emu.calls('DeleteSnapshot')).toHaveLength(0);
    expect(ebs.snapshots.has(publicOne.id)).toBe(true);
    for (const request of emu.calls('DescribeSnapshots'))
      expect(request.params.get('Owner.1')).toBe('self');
  });

  it('restores only from its own completed snapshots, at least as large', async () => {
    const { volumes, call, spec, ebs, emu } = world();
    const foreign = ebs.addSnapshot({ tags: { Name: 'public' } });
    await rejects(
      volumes.ensureVolume(spec({ snapshotId: foreign.id }), call()),
      'INVALID_STATE',
      'not-managed',
    );
    const ours = ebs.addSnapshot({
      volumeSize: 20,
      tags: { 'better-compute:managed': 'true', 'better-compute:snapshot': 'bc-s-0003' },
    });
    await rejects(
      volumes.ensureVolume(spec({ snapshotId: ours.id, sizeGiB: 10 }), call()),
      'INVALID_INPUT',
      'size',
    );
    await rejects(
      volumes.ensureVolume(spec({ snapshotId: 'snap-0000000000000dead', sizeGiB: 20 }), call()),
      'INVALID_INPUT',
      'snapshot',
    );
    ours.state = 'pending';
    await rejects(
      volumes.ensureVolume(spec({ snapshotId: ours.id, sizeGiB: 20 }), call()),
      'UNAVAILABLE',
      'snapshot-pending',
    );
    expect(emu.calls('CreateVolume')).toHaveLength(0);
    ours.state = 'completed';
    // A restore keeps the snapshot's filesystem: a filesystem in the spec is ignored, not refused.
    const restored = await volumes.ensureVolume(
      spec({ snapshotId: ours.id, sizeGiB: 20, filesystem: 'ext4' }),
      call(),
    );
    expect(emu.calls('CreateVolume')[0]!.params.get('SnapshotId')).toBe(ours.id);
    expect(ebs.volumes.get(restored.id)!.snapshotId).toBe(ours.id);
  });
});
