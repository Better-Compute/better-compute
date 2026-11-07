import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { awsProvider } from '@better-compute/provider-aws';
import { closeFixtures, computeFixture, type ComputeFixture } from '@better-compute/testing';
import { providerResourceName, vps } from '@better-compute/vps';
import { AwsEmulator } from './support/aws-emulator/index.js';
import { Ec2Emulator, type EmuInstance } from './support/aws-emulator/ec2.js';
import { EbsEmulator, type EmuVolume } from './support/aws-emulator/ebs.js';

// AWS A5 through vps: the real provider-aws against the EC2/EBS emulator, wired through the generic
// providerVolumes / providerSnapshots API (the do-volumes lane's vps half) on PGlite. One root AWS
// account in us-east-1 (zones a and b) backs a provider pool offered to acme. vps keeps an AWS
// volume per zone (its region is the AZ), so a volume in another zone than the instance is refused
// before any EC2 call. Covers create and attach, zone mismatch, delete while attached, resize with
// the six-hour ModifyVolume cooldown, snapshot, restore, detach and delete, and an instance delete
// that keeps one volume and takes its deleteWithInstance one.
//
// Lane note (aws-ebs, wf/aws-ebs): the providerVolumes API lands with wf/do-volumes. Until both
// branches are on one tree this file skips itself; on the integration branch it runs (remove the
// guard there). It needs no vps change: vps allows `config.regions` plus `config.zones.map(zoneRegion)`,
// and zoneRegion strips only a `-x` suffix (GCE's us-central1-a), so an AWS zone such as us-east-1a
// stays a zone: an AWS volume's vps region is its AZ, the bare region is refused, and targetInstance
// compares that zone with the instance offer's zone. provider-aws reads a spec region that is one of
// the account's zones as the zone (verified on wf/do-volumes 57e0b776). Kept as a later vps
// robustness item: accept zones by name rather than through zoneRegion's shape, and pass `zone`.
// The provider half fails closed meanwhile: a bare region on a multi-zone account is INVALID_INPUT
// (reason zone-required), never a silent first zone.
const hasProviderVolumes = existsSync(
  new URL('../packages/vps/src/provider-resources.ts', import.meta.url),
);

afterEach(closeFixtures);

const ZONE = 'us-east-1a';
const OTHER_ZONE = 'us-east-1b';
const HOUR = 3_600_000;

type Api = any;

interface World {
  emu: AwsEmulator;
  ec2: Ec2Emulator;
  ebs: EbsEmulator;
  fixture: ComputeFixture;
  api: Api;
  acme: { token: string };
  tenantId: string;
  poolId: string;
  tick(job: string, advanceMs?: number): Promise<void>;
  /** Runs `vps.provider-resources` (letting EBS states move in between) `rounds` times. */
  converge(rounds?: number, advanceMs?: number): Promise<void>;
}

async function world(): Promise<World> {
  const emu = new AwsEmulator();
  const ec2 = new Ec2Emulator(emu);
  const ebs = new EbsEmulator(emu, ec2);
  const aws = awsProvider({ fetch: emu.fetch, credentials: emu.ambient });
  const fixture = await computeFixture({
    clock: 'sim',
    modules: [vps({ providers: [aws], discovery: { every: '1m' } })],
  });
  emu.follow(fixture.clock);
  const { compute, tenants, iam } = fixture;
  (iam as { rootTenantId?: string }).rootTenantId = tenants.root.id;
  iam.allow({ token: tenants.root.token });
  iam.allow({ token: tenants.acme.token });
  const api = compute.api as Api;
  const root = { token: tenants.root.token };
  const account = await api.providerAccounts.create(root, {
    tenantId: tenants.root.id,
    provider: 'aws',
    name: 'aws-use1',
    config: { region: 'us-east-1', zones: [ZONE, OTHER_ZONE] },
  });
  const site = await api.sites.create(root, {
    tenantId: tenants.root.id,
    kind: 'shared',
    region: 'us-east-1',
    idempotencyKey: 'aws-site',
  });
  const pool = await api.pools.create(root, {
    tenantId: tenants.root.id,
    siteId: site.id,
    class: 'provider',
    providerAccountId: account.id,
    idempotencyKey: 'aws-pool',
  });
  await api.pools.offer(root, {
    tenantId: tenants.root.id,
    poolId: pool.id,
    toTenantId: tenants.acme.id,
    quota: { vcpu: 2000, memoryGiB: 20_000, diskGiB: 10_000, gpu: 64 },
  });
  await api.flavors.create(root, {
    tenantId: tenants.root.id,
    poolId: pool.id,
    name: 'm7i.large',
    vcpu: 2,
    memoryGiB: 8,
    diskGiB: 100,
    offerId: `${ZONE}/m7i.large`,
  });
  const tick = async (job: string, advanceMs = 1_000) => {
    await fixture.advance(advanceMs);
    for (let round = 0; round < 2; round++) await compute.jobs[job]!.tick();
  };
  return {
    emu,
    ec2,
    ebs,
    fixture,
    api,
    acme: { token: tenants.acme.token },
    tenantId: tenants.acme.id,
    poolId: pool.id,
    tick,
    async converge(rounds = 8, advanceMs = 5_000) {
      for (let round = 0; round < rounds; round++) {
        ebs.tick();
        await tick('vps.provider-resources', advanceMs);
      }
    },
  };
}

/** The emulated instance an instance created (its better-compute:instance tag). */
const vmOf = (w: World, instanceId: string): EmuInstance | undefined =>
  [...w.ec2.instances.values()].find(
    (instance) => instance.tags.get('better-compute:instance') === instanceId,
  );

/** The EBS volume vps made for a providerVolumes row (its better-compute:volume tag is the vps name). */
const ebsOf = (w: World, volumeId: string): EmuVolume | undefined =>
  [...w.ebs.volumes.values()].find(
    (volume) =>
      volume.state !== 'deleted' &&
      volume.tags.get('better-compute:managed') === 'true' &&
      volume.tags.get('better-compute:volume') === providerResourceName(volumeId),
  );

async function runningInstance(w: World, key: string): Promise<string> {
  const created = await w.api.instances.create(w.acme, {
    tenantId: w.tenantId,
    poolId: w.poolId,
    flavor: 'm7i.large',
    imageId: 'ubuntu-24.04',
    sshKeys: [],
    idempotencyKey: key,
  });
  let view = await w.api.instances.get(w.acme, { tenantId: w.tenantId, instanceId: created.id });
  for (let round = 0; round < 8 && view.state !== 'running'; round++) {
    w.ec2.tick();
    await w.tick('vps.instances', 15_000);
    view = await w.api.instances.get(w.acme, { tenantId: w.tenantId, instanceId: created.id });
  }
  expect(view.state).toBe('running');
  return created.id;
}

const codeOf = async (promise: Promise<unknown>) =>
  promise.then(
    () => 'ok',
    (error: { code?: string }) => error.code,
  );

describe.skipIf(!hasProviderVolumes)('provider-aws EBS through vps, end to end (A5)', () => {
  it('creates and attaches an EBS volume in the instance zone; refuses another zone and deleting it attached', async () => {
    const w = await world();
    const instanceId = await runningInstance(w, 'vm-1');
    const vm = vmOf(w, instanceId)!;
    const volume = await w.api.providerVolumes.create(w.acme, {
      tenantId: w.tenantId,
      poolId: w.poolId,
      name: 'data',
      region: ZONE,
      sizeGiB: 10,
      instanceId,
      idempotencyKey: 'v-data',
    });
    await w.converge();
    const view = await w.api.providerVolumes.get(w.acme, {
      tenantId: w.tenantId,
      volumeId: volume.id,
    });
    expect(view).toMatchObject({
      state: 'ready',
      region: ZONE,
      sizeGiB: 10,
      attachment: { instanceId, state: 'ready' },
    });
    const ebs = ebsOf(w, volume.id)!;
    expect(ebs).toMatchObject({ zone: ZONE, sizeGiB: 10, type: 'gp3', encrypted: true });
    expect(ebs.attachment).toMatchObject({ instanceId: vm.id, device: '/dev/sdf', state: 'attached' });
    // The guest path vps records is the Nitro udev by-id link of the volume's NVMe serial.
    expect(view.device).toBe(
      `/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${ebs.id.replace('-', '')}`,
    );
    // One CreateVolume and one AttachVolume, however many reconciler passes.
    expect(w.emu.calls('CreateVolume')).toHaveLength(1);
    expect(w.emu.calls('AttachVolume')).toHaveLength(1);

    // Zone mismatch: a volume in us-east-1b never reaches EC2 for an instance in us-east-1a.
    const elsewhere = await w.api.providerVolumes.create(w.acme, {
      tenantId: w.tenantId,
      poolId: w.poolId,
      name: 'elsewhere',
      region: OTHER_ZONE,
      sizeGiB: 5,
      idempotencyKey: 'v-elsewhere',
    });
    await w.converge(4);
    expect(ebsOf(w, elsewhere.id)).toMatchObject({ zone: OTHER_ZONE });
    expect(
      await codeOf(
        w.api.providerVolumes.attach(w.acme, {
          tenantId: w.tenantId,
          volumeId: elsewhere.id,
          instanceId,
        }),
      ),
    ).toBe('INVALID_INPUT');
    expect(
      await codeOf(
        w.api.providerVolumes.create(w.acme, {
          tenantId: w.tenantId,
          poolId: w.poolId,
          name: 'elsewhere-2',
          region: OTHER_ZONE,
          sizeGiB: 5,
          instanceId,
          idempotencyKey: 'v-elsewhere-2',
        }),
      ),
    ).toBe('INVALID_INPUT');
    // The bare region is not a place for an AWS volume (vps keeps them per zone).
    expect(
      await codeOf(
        w.api.providerVolumes.create(w.acme, {
          tenantId: w.tenantId,
          poolId: w.poolId,
          name: 'regional',
          region: 'us-east-1',
          sizeGiB: 5,
          idempotencyKey: 'v-regional',
        }),
      ),
    ).toBe('INVALID_INPUT');
    expect(w.emu.calls('AttachVolume')).toHaveLength(1);

    // Delete while attached.
    expect(
      await codeOf(
        w.api.providerVolumes.delete(w.acme, { tenantId: w.tenantId, volumeId: volume.id }),
      ),
    ).toBe('INVALID_STATE');
    expect(w.emu.calls('DeleteVolume')).toHaveLength(0);

    // Detach, then delete: EC2 detaches it, then the volume goes.
    await w.api.providerVolumes.detach(w.acme, { tenantId: w.tenantId, volumeId: volume.id });
    await w.converge();
    const detached = await w.api.providerVolumes.get(w.acme, {
      tenantId: w.tenantId,
      volumeId: volume.id,
    });
    expect(detached.attachment).toBeUndefined();
    expect(ebs.attachment).toBeUndefined();
    expect(w.emu.calls('DetachVolume')).toHaveLength(1);
    expect(w.emu.calls('DetachVolume')[0]!.params.get('Force')).toBeNull();
    await w.api.providerVolumes.delete(w.acme, { tenantId: w.tenantId, volumeId: volume.id });
    await w.converge();
    expect(
      await w.api.providerVolumes.get(w.acme, { tenantId: w.tenantId, volumeId: volume.id }),
    ).toMatchObject({ state: 'deleted' });
    expect(w.emu.calls('DeleteVolume').map((call) => call.params.get('VolumeId'))).toEqual([
      ebs.id,
    ]);
    expect(w.ebs.volumes.get(ebs.id)).toBeUndefined();
    expect(w.emu.unrouted).toEqual([]);
  });

  it('resizes through ModifyVolume, waits out the six-hour cooldown, snapshots and restores', async () => {
    const w = await world();
    const instanceId = await runningInstance(w, 'vm-2');
    const volume = await w.api.providerVolumes.create(w.acme, {
      tenantId: w.tenantId,
      poolId: w.poolId,
      name: 'data',
      region: ZONE,
      sizeGiB: 10,
      instanceId,
      idempotencyKey: 'v-data',
    });
    await w.converge();
    const ref = { tenantId: w.tenantId, volumeId: volume.id };
    const ebs = ebsOf(w, volume.id)!;

    // Grow 10 → 20: one ModifyVolume.
    await w.api.providerVolumes.resize(w.acme, { ...ref, sizeGiB: 20 });
    await w.converge();
    expect(await w.api.providerVolumes.get(w.acme, ref)).toMatchObject({
      state: 'ready',
      sizeGiB: 20,
    });
    expect(ebs.sizeGiB).toBe(20);
    expect(w.emu.calls('ModifyVolume')).toHaveLength(1);
    // Shrinking is refused before any call.
    expect(await codeOf(w.api.providerVolumes.resize(w.acme, { ...ref, sizeGiB: 15 }))).toBe(
      'INVALID_INPUT',
    );

    // Grow again within six hours of the first modification: EBS would refuse, so the provider
    // answers RATE_LIMITED without calling and vps keeps the volume updating.
    await w.api.providerVolumes.resize(w.acme, { ...ref, sizeGiB: 30 });
    await w.converge(4, 60_000);
    expect(await w.api.providerVolumes.get(w.acme, ref)).toMatchObject({ state: 'updating' });
    expect(ebs.sizeGiB).toBe(20);
    expect(w.emu.calls('ModifyVolume')).toHaveLength(1);
    // After the cooldown the second modification lands.
    await w.fixture.advance(6 * HOUR);
    await w.converge(8, 60_000);
    expect(await w.api.providerVolumes.get(w.acme, ref)).toMatchObject({
      state: 'ready',
      sizeGiB: 30,
    });
    expect(ebs.sizeGiB).toBe(30);
    expect(w.emu.calls('ModifyVolume')).toHaveLength(2);

    // Snapshot it, then restore the snapshot into a new volume in the same zone.
    const snapshot = await w.api.providerVolumes.snapshot(w.acme, {
      ...ref,
      name: 'data-1',
      idempotencyKey: 's-1',
    });
    await w.converge(4);
    expect(
      await w.api.providerSnapshots.get(w.acme, {
        tenantId: w.tenantId,
        snapshotId: snapshot.id,
      }),
    ).toMatchObject({ state: 'ready', sizeGiB: 30, region: ZONE });
    expect(w.emu.calls('CreateSnapshot')).toHaveLength(1);
    const ebsSnapshot = [...w.ebs.snapshots.values()].find((s) => s.volumeId === ebs.id)!;
    expect(ebsSnapshot.tags.get('better-compute:managed')).toBe('true');

    const restored = await w.api.providerSnapshots.restore(w.acme, {
      tenantId: w.tenantId,
      snapshotId: snapshot.id,
      name: 'data-copy',
      idempotencyKey: 'r-1',
    });
    await w.converge();
    expect(
      await w.api.providerVolumes.get(w.acme, { tenantId: w.tenantId, volumeId: restored.id }),
    ).toMatchObject({ state: 'ready', sizeGiB: 30, region: ZONE, sourceSnapshotId: snapshot.id });
    const copy = ebsOf(w, restored.id)!;
    expect(copy).toMatchObject({ zone: ZONE, sizeGiB: 30, snapshotId: ebsSnapshot.id });
    expect(copy.id).not.toBe(ebs.id);
    expect(w.emu.calls('CreateVolume')).toHaveLength(2);
    expect(w.emu.unrouted).toEqual([]);
  });

  it('deleting the instance keeps its volume and deletes the deleteWithInstance one after termination', async () => {
    const w = await world();
    const instanceId = await runningInstance(w, 'vm-3');
    const vm = vmOf(w, instanceId)!;
    const create = (name: string, extra: Record<string, unknown> = {}) =>
      w.api.providerVolumes.create(w.acme, {
        tenantId: w.tenantId,
        poolId: w.poolId,
        name,
        region: ZONE,
        sizeGiB: 10,
        instanceId,
        idempotencyKey: `v-${name}`,
        ...extra,
      });
    const data = await create('data');
    const scratch = await create('scratch', { deleteWithInstance: true });
    await w.converge();
    const dataOnEbs = ebsOf(w, data.id)!;
    const scratchOnEbs = ebsOf(w, scratch.id)!;
    expect([dataOnEbs.attachment?.device, scratchOnEbs.attachment?.device].sort()).toEqual([
      '/dev/sdf',
      '/dev/sdg',
    ]);

    await w.api.instances.delete(w.acme, { tenantId: w.tenantId, instanceId });
    let view = await w.api.instances.get(w.acme, { tenantId: w.tenantId, instanceId });
    for (let round = 0; round < 8 && view.state !== 'deleted'; round++) {
      w.ec2.tick();
      w.ebs.tick();
      await w.tick('vps.instances', 15_000);
      view = await w.api.instances.get(w.acme, { tenantId: w.tenantId, instanceId });
    }
    expect(view.state).toBe('deleted');
    // vps is done once EC2 accepted the termination; the instance finishes shutting down after.
    w.ec2.tick();
    expect(vm.state).toBe('terminated');
    await w.converge();
    // EC2 detached both on termination; vps then deleted only the deleteWithInstance one.
    expect(
      await w.api.providerVolumes.get(w.acme, { tenantId: w.tenantId, volumeId: scratch.id }),
    ).toMatchObject({ state: 'deleted' });
    expect(w.ebs.volumes.get(scratchOnEbs.id)).toBeUndefined();
    const kept = await w.api.providerVolumes.get(w.acme, {
      tenantId: w.tenantId,
      volumeId: data.id,
    });
    expect(kept).toMatchObject({ state: 'ready', desiredState: 'present' });
    expect(kept.attachment).toBeUndefined();
    expect(dataOnEbs).toMatchObject({ state: 'available' });
    expect(dataOnEbs.attachment).toBeUndefined();
    expect(w.emu.calls('DeleteVolume').map((call) => call.params.get('VolumeId'))).toEqual([
      scratchOnEbs.id,
    ]);
    // No DetachVolume at all: the termination let both volumes go, and vps read them detached.
    expect(w.emu.calls('DetachVolume')).toHaveLength(0);
    expect(w.emu.unrouted).toEqual([]);
  });
});
