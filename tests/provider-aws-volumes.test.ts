import { describe, expect, it } from 'vitest';
import {
  isComputeError,
  type CallContext,
  type Logger,
  type ProviderImpl,
  type ProviderResourceState,
  type ProviderVolumeSpec,
} from '@better-compute/core';
import { awsProvider, clientToken, type AwsConfig } from '@better-compute/provider-aws';
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
  const impl = provider.create(
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
  const volumes = impl.volumes!;
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
  return { emu, ec2, ebs, impl, volumes, call, spec, settle, lines, managed };
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
    const byRegion = await volumes.ensureVolume(spec({ name: 'a', region: 'us-east-1b' }), call());
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
    const restored = await volumes.ensureVolume(spec({ snapshotId: ours.id, sizeGiB: 20 }), call());
    expect(emu.calls('CreateVolume')[0]!.params.get('SnapshotId')).toBe(ours.id);
    expect(ebs.volumes.get(restored.id)!.snapshotId).toBe(ours.id);
  });
});
