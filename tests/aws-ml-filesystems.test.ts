import { afterEach, describe, expect, it } from 'vitest';
import { awsProvider } from '@better-compute/provider-aws';
import { closeFixtures, computeFixture } from '@better-compute/testing';
import { defaultMeterGpuModels, meterCatalog } from '@better-compute/core';
import {
  filesystemMeterOf,
  meteredFilesystemKinds,
  parseCreateFilesystem,
  parseInstanceFilesystems,
  providerResourceName,
  vps,
} from '@better-compute/vps';
import { AwsEmulator } from './support/aws-emulator/index.js';
import { Ec2Emulator } from './support/aws-emulator/ec2.js';
import { VpcEmulator } from './support/aws-emulator/vpc.js';
import { EfsEmulator } from './support/aws-emulator/efs.js';
import { FsxEmulator } from './support/aws-emulator/fsx.js';

// AWS A10 shared filesystems through vps (sub-plan 2026-11-05 F8, F9): a tenant makes an nfs (EFS)
// or lustre (FSx for Lustre) filesystem on one of its networks, and instances it creates on that
// network mount it at boot from their user data.

afterEach(closeFixtures);

type Api = any;

async function world() {
  const emu = new AwsEmulator();
  const ec2 = new Ec2Emulator(emu);
  const vpc = new VpcEmulator(emu, ec2);
  const efs = new EfsEmulator(emu, vpc);
  const fsx = new FsxEmulator(emu, vpc);
  const aws = awsProvider({ fetch: emu.fetch, credentials: emu.ambient });
  const fixture = await computeFixture({ clock: 'sim', modules: [vps({ providers: [aws] })] });
  emu.follow(fixture.clock);
  const { compute, tenants, iam } = fixture;
  (iam as { rootTenantId?: string }).rootTenantId = tenants.root.id;
  iam.allow({ token: tenants.root.token });
  iam.allow({ token: tenants.acme.token });
  iam.allow({ token: tenants.other.token });
  const api = compute.api as Api;
  const root = { token: tenants.root.token };
  const acme = { token: tenants.acme.token };
  const other = { token: tenants.other.token };
  const account = await api.providerAccounts.create(root, {
    tenantId: tenants.root.id,
    provider: 'aws',
    name: 'aws-use1',
    config: { region: 'us-east-1', zones: ['us-east-1a', 'us-east-1b'] },
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
  for (const tenant of [tenants.acme.id, tenants.other.id])
    await api.pools.offer(root, {
      tenantId: tenants.root.id,
      poolId: pool.id,
      toTenantId: tenant,
      quota: { vcpu: 64, memoryGiB: 256, diskGiB: 2000 },
    });
  await api.flavors.create(root, {
    tenantId: tenants.root.id,
    poolId: pool.id,
    name: 'm7i.large',
    vcpu: 2,
    memoryGiB: 8,
    diskGiB: 100,
    offerId: 'us-east-1a/m7i.large',
  });
  const acmeTenant = tenants.acme.id;
  const tick = async (job: string, advanceMs = 5_000) => {
    await fixture.advance(advanceMs);
    for (let round = 0; round < 2; round++) await compute.jobs[job]!.tick();
  };
  /** A ready network of acme with one subnet in us-east-1a. */
  const network = async (name = 'train', cidr = '10.80.0.0/16') => {
    const made = await api.networks.create(acme, {
      tenantId: acmeTenant,
      poolId: pool.id,
      name,
      cidr,
      idempotencyKey: `net-${name}`,
    });
    await api.networks.addSubnet(acme, {
      tenantId: acmeTenant,
      networkId: made.id,
      name: 'a',
      region: 'us-east-1',
      zone: 'us-east-1a',
      cidr: cidr.replace(/\.0\.0\/16$/, '.1.0/24'),
    });
    for (let round = 0; round < 8; round++) {
      const view = await api.networks.get(acme, { tenantId: acmeTenant, networkId: made.id });
      if (view.state === 'ready') return view;
      await tick('vps.networks');
    }
    throw new Error('network never ready');
  };
  const fsView = (networkId: string, filesystemId: string) =>
    api.filesystems.get(acme, { tenantId: acmeTenant, networkId, filesystemId });
  /** Ticks the filesystems reconciler until the filesystem leaves pending/deleting. */
  const settleFs = async (networkId: string, filesystemId: string) => {
    let view = await fsView(networkId, filesystemId);
    for (
      let round = 0;
      round < 12 && (view.state === 'pending' || view.state === 'deleting');
      round++
    ) {
      // The reconciler looks again every 15 s while the provider works.
      await tick('vps.filesystems', 15_000);
      view = await fsView(networkId, filesystemId);
    }
    return view;
  };
  const settleInstance = async (instanceId: string) => {
    let view = await api.instances.get(acme, { tenantId: acmeTenant, instanceId });
    for (let round = 0; round < 8 && view.state !== 'running'; round++) {
      ec2.tick();
      await tick('vps.instances', 15_000);
      view = await api.instances.get(acme, { tenantId: acmeTenant, instanceId });
    }
    return view;
  };
  return {
    emu,
    ec2,
    vpc,
    efs,
    fsx,
    fixture,
    api,
    acme,
    other,
    acmeTenant,
    otherTenant: tenants.other.id,
    poolId: pool.id,
    tick,
    network,
    fsView,
    settleFs,
    settleInstance,
  };
}
type World = Awaited<ReturnType<typeof world>>;

const nfsInput = (w: World, networkId: string, extra: Record<string, unknown> = {}) => ({
  tenantId: w.acmeTenant,
  networkId,
  name: 'home',
  kind: 'nfs',
  idempotencyKey: 'fs-home',
  ...extra,
});

const vmInput = (w: World, networkId: string, extra: Record<string, unknown> = {}) => ({
  tenantId: w.acmeTenant,
  poolId: w.poolId,
  flavor: 'm7i.large',
  imageId: 'ubuntu-24.04',
  sshKeys: [],
  networkId,
  idempotencyKey: 'vm-1',
  ...extra,
});

const decode = (base64: string) => Buffer.from(base64, 'base64').toString('utf8');

describe('filesystems through vps on AWS (A10 F8, F9)', () => {
  it('makes an nfs filesystem on a network and mounts it on an instance there at boot', async () => {
    const w = await world();
    const net = await w.network();
    const created = await w.api.filesystems.create(w.acme, nfsInput(w, net.id));
    expect(created).toMatchObject({
      networkId: net.id,
      name: 'home',
      kind: 'nfs',
      state: 'pending',
      version: 1,
    });
    expect(created.id).toMatch(/^fs_/);
    // The same request again replays; another one under the key is CONFLICT.
    expect(await w.api.filesystems.create(w.acme, nfsInput(w, net.id))).toMatchObject({
      id: created.id,
    });
    await expect(
      w.api.filesystems.create(w.acme, nfsInput(w, net.id, { name: 'other' })),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    // The name is the network's: a second `home` is CONFLICT.
    await expect(
      w.api.filesystems.create(w.acme, nfsInput(w, net.id, { idempotencyKey: 'fs-home-2' })),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const ready = await w.settleFs(net.id, created.id);
    expect(ready).toMatchObject({ state: 'ready', mount: { fstype: 'nfs4' } });
    const efs = [...w.efs.fileSystems.values()];
    expect(efs).toHaveLength(1);
    expect(efs[0]!.creationToken).toBe(providerResourceName(created.id));
    expect(ready.mount.source).toBe(`${efs[0]!.id}.efs.us-east-1.amazonaws.com:/`);
    const listed = await w.api.filesystems.list(w.acme, {
      tenantId: w.acmeTenant,
      networkId: net.id,
    });
    expect(listed.items.map((item: { id: string }) => item.id)).toEqual([created.id]);

    const vm = await w.api.instances.create(
      w.acme,
      vmInput(w, net.id, { filesystems: [{ filesystem: created.id, path: '/mnt/home' }] }),
    );
    expect(vm.filesystems).toEqual([{ filesystemId: created.id, path: '/mnt/home' }]);
    expect(await w.settleInstance(vm.id)).toMatchObject({ state: 'running' });
    const userData = decode(w.emu.calls('RunInstances')[0]!.params.get('UserData')!);
    expect(userData).toContain('# better-compute: filesystem mounts');
    expect(userData).toContain(`${ready.mount.source} /mnt/home nfs4`);

    // A filesystem an instance mounts, or a network with a filesystem, is not deleted.
    await expect(
      w.api.filesystems.delete(w.acme, {
        tenantId: w.acmeTenant,
        networkId: net.id,
        filesystemId: created.id,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE', details: { instanceIds: [vm.id] } });

    await w.api.instances.delete(w.acme, { tenantId: w.acmeTenant, instanceId: vm.id });
    for (let round = 0; round < 8; round++) {
      w.ec2.tick();
      await w.tick('vps.instances', 15_000);
      const view = await w.api.instances.get(w.acme, { tenantId: w.acmeTenant, instanceId: vm.id });
      if (view.state === 'deleted') break;
    }
    await expect(
      w.api.networks.delete(w.acme, { tenantId: w.acmeTenant, networkId: net.id }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE', details: { filesystemIds: [created.id] } });

    const deleting = await w.api.filesystems.delete(w.acme, {
      tenantId: w.acmeTenant,
      networkId: net.id,
      filesystemId: created.id,
    });
    expect(deleting).toMatchObject({ state: 'deleting', version: 2 });
    expect(await w.settleFs(net.id, created.id)).toMatchObject({ state: 'deleted' });
    expect([...w.efs.fileSystems.values()].filter((fs) => fs.lifeCycleState !== 'deleted')).toEqual(
      [],
    );
    // Gone from the list; the network can go now.
    expect(
      (await w.api.filesystems.list(w.acme, { tenantId: w.acmeTenant, networkId: net.id })).items,
    ).toEqual([]);
    await expect(
      w.api.networks.delete(w.acme, { tenantId: w.acmeTenant, networkId: net.id }),
    ).resolves.toMatchObject({ state: 'deleting' });
    const { rows } = await w.fixture.database.query<{ topic: string }>(
      `SELECT topic FROM outbox WHERE topic LIKE 'network.filesystem.%' ORDER BY seq`,
    );
    const types = rows.map((row) => row.topic);
    for (const type of [
      'network.filesystem.created',
      'network.filesystem.ready',
      'network.filesystem.deleting',
      'network.filesystem.deleted',
    ])
      expect(types).toContain(type);
  });

  it('makes a lustre filesystem in one zone with the size asked', async () => {
    const w = await world();
    const net = await w.network();
    const created = await w.api.filesystems.create(
      w.acme,
      nfsInput(w, net.id, {
        name: 'scratch',
        kind: 'lustre',
        sizeGiB: 2400,
        zone: 'us-east-1a',
        idempotencyKey: 'fs-scratch',
      }),
    );
    expect(created).toMatchObject({ kind: 'lustre', sizeGiB: 2400, zone: 'us-east-1a' });
    const ready = await w.settleFs(net.id, created.id);
    expect(ready).toMatchObject({ state: 'ready', mount: { fstype: 'lustre' } });
    const made = [...w.fsx.fileSystems.values()];
    expect(made).toHaveLength(1);
    expect(made[0]!.capacity).toBe(2400);
  });

  it('refuses what the provider cannot make before anything is recorded', async () => {
    const w = await world();
    const net = await w.network();
    for (const [extra, code] of [
      [{ kind: 'lustre', sizeGiB: 1000 }, 'INVALID_INPUT'],
      [{ kind: 'lustre', zone: 'eu-west-1a' }, 'INVALID_INPUT'],
      [{ kind: 'nfs', sizeGiB: 1200 }, 'INVALID_INPUT'],
      [{ kind: 'ontap' }, 'INVALID_INPUT'],
      [{ name: 'Bad Name' }, 'INVALID_INPUT'],
    ] as const)
      await expect(
        w.api.filesystems.create(w.acme, nfsInput(w, net.id, { ...extra, idempotencyKey: 'x' })),
      ).rejects.toMatchObject({ code });
    expect(
      (await w.api.filesystems.list(w.acme, { tenantId: w.acmeTenant, networkId: net.id })).items,
    ).toEqual([]);
    // Another tenant's network is not found.
    await expect(
      w.api.filesystems.create(w.other, { ...nfsInput(w, net.id), tenantId: w.otherTenant }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('an instance mounts only ready filesystems of its own network, at plain paths', async () => {
    const w = await world();
    const net = await w.network();
    const second = await w.network('eval', '10.81.0.0/16');
    const fs = await w.api.filesystems.create(w.acme, nfsInput(w, net.id));
    // Not ready yet.
    await expect(
      w.api.instances.create(
        w.acme,
        vmInput(w, net.id, { filesystems: [{ filesystem: fs.id, path: '/mnt/home' }] }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await w.settleFs(net.id, fs.id);
    // On another network.
    await expect(
      w.api.instances.create(
        w.acme,
        vmInput(w, second.id, {
          filesystems: [{ filesystem: fs.id, path: '/mnt/home' }],
          idempotencyKey: 'vm-2',
        }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    // Without a network.
    await expect(
      w.api.instances.create(w.acme, {
        ...vmInput(w, net.id, { idempotencyKey: 'vm-3' }),
        networkId: undefined,
        filesystems: [{ filesystem: fs.id, path: '/mnt/home' }],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    // Another tenant cannot name it.
    await expect(
      w.api.instances.create(w.other, {
        ...vmInput(w, net.id, { idempotencyKey: 'vm-4' }),
        tenantId: w.otherTenant,
        filesystems: [{ filesystem: fs.id, path: '/mnt/home' }],
      }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/NOT_FOUND|INVALID_INPUT/) });
    // No partially created draft is left behind by a refusal.
    expect(w.ec2.instances.size).toBe(0);
  });
});

const HOUR = 3_600_000;

/** The usage windows of a filesystem (`network` sources keyed by its id). */
async function fsWindows(w: World, filesystemId: string) {
  const { rows } = await w.fixture.database.query<{
    source_kind: string;
    idempotency_key: string;
    tenant_id: string;
    meter: string;
    quantity: string;
    start_ms: number;
    tags: Record<string, string> | string;
  }>(
    `SELECT source_kind, idempotency_key, tenant_id, meter, quantity::text,
            (extract(epoch FROM window_start) * 1000)::float8 AS start_ms, tags
       FROM usage_windows WHERE source_id = $1 ORDER BY window_start, meter`,
    [filesystemId],
  );
  return rows.map((row) => ({
    kind: row.source_kind,
    key: row.idempotency_key,
    tenantId: row.tenant_id,
    meter: row.meter,
    quantity: Number(row.quantity),
    start: Number(row.start_ms),
    tags: typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags,
  }));
}

async function provisionedAt(w: World, filesystemId: string): Promise<number | null> {
  const { rows } = await w.fixture.database.query<{ at: number | null }>(
    `SELECT (extract(epoch FROM provisioned_at) * 1000)::float8 AS at FROM filesystems WHERE id = $1`,
    [filesystemId],
  );
  return rows[0]!.at === null ? null : Number(rows[0]!.at);
}

/** Moves sim time to the next top of the hour plus `hours` and a settle past the 5 minute grace. */
async function meterAfter(w: World, hours: number): Promise<number> {
  const now = w.fixture.clock.now();
  const target = (Math.floor(now / HOUR) + 1 + hours) * HOUR + 6 * 60_000;
  await w.fixture.advance(target - now);
  for (let round = 0; round < 2; round++) await w.fixture.compute.jobs['vps.ancillary-usage']!.tick();
  return target;
}

describe('filesystem metering (A10)', () => {
  it('an nfs filesystem bills the GiB EFS meters, from its first ready, as filesystem.nfs.gib.hours', async () => {
    const w = await world();
    const net = await w.network();
    const created = await w.api.filesystems.create(w.acme, nfsInput(w, net.id));
    // Pending bills nothing and starts nothing.
    expect(await provisionedAt(w, created.id)).toBeNull();
    await w.settleFs(net.id, created.id);
    const start = (await provisionedAt(w, created.id))!;
    expect(start).toBeGreaterThan(0);
    // EFS now meters 10 GiB; the periodic pass picks the size up.
    [...w.efs.fileSystems.values()][0]!.sizeBytes = 10 * 2 ** 30;
    await w.tick('vps.filesystems', 5 * 60_000);
    const { rows } = await w.fixture.database.query<{ billed_gib: number }>(
      `SELECT billed_gib FROM filesystems WHERE id = $1`,
      [created.id],
    );
    expect(Number(rows[0]!.billed_gib)).toBe(10);

    await meterAfter(w, 2);
    const windows = await fsWindows(w, created.id);
    expect(windows.length).toBeGreaterThanOrEqual(3);
    for (const window of windows)
      expect(window).toMatchObject({
        kind: 'network',
        tenantId: w.acmeTenant,
        meter: 'filesystem.nfs.gib.hours',
        key: `cmp:network:${created.id}:${window.start}:filesystem.nfs.gib.hours`,
        tags: { pool: w.poolId, provider: 'aws', region: 'us-east-1', source: 'filesystem' },
      });
    // The first partial hour bills its share; whole hours bill 10 GiB each.
    expect(windows[0]!.start).toBe(Math.floor(start / HOUR) * HOUR);
    expect(windows[0]!.quantity).toBeCloseTo((10 * (HOUR - (start % HOUR))) / HOUR, 5);
    for (const window of windows.slice(1)) expect(window.quantity).toBe(10);
    // A repeated pass writes nothing more.
    const before = JSON.stringify(windows);
    for (let round = 0; round < 2; round++) await w.fixture.compute.jobs['vps.ancillary-usage']!.tick();
    expect(JSON.stringify(await fsWindows(w, created.id))).toBe(before);
  });

  it('a lustre filesystem bills its provisioned capacity until it is deleted', async () => {
    const w = await world();
    const net = await w.network();
    const created = await w.api.filesystems.create(
      w.acme,
      nfsInput(w, net.id, {
        name: 'scratch',
        kind: 'lustre',
        sizeGiB: 2400,
        zone: 'us-east-1a',
        idempotencyKey: 'fs-scratch',
      }),
    );
    await w.settleFs(net.id, created.id);
    await meterAfter(w, 1);
    const whole = (await fsWindows(w, created.id)).slice(1);
    expect(whole.length).toBeGreaterThanOrEqual(1);
    for (const window of whole)
      expect(window).toMatchObject({ meter: 'filesystem.lustre.gib.hours', quantity: 2400 });

    await w.api.filesystems.delete(w.acme, {
      tenantId: w.acmeTenant,
      networkId: net.id,
      filesystemId: created.id,
    });
    expect(await w.settleFs(net.id, created.id)).toMatchObject({ state: 'deleted' });
    await meterAfter(w, 0);
    const settled = await fsWindows(w, created.id);
    // Nothing past the deletion: hours later, no new window.
    await meterAfter(w, 5);
    expect(await fsWindows(w, created.id)).toEqual(settled);
    const { rows } = await w.fixture.database.query<{ done: boolean }>(
      `SELECT metered_until = deleted_at AS done FROM filesystems WHERE id = $1`,
      [created.id],
    );
    expect(rows[0]!.done).toBe(true);
  });

  it('a pool in billing mode none bills no filesystem hours, and the watermark still advances', async () => {
    const w = await world();
    const net = await w.network();
    const created = await w.api.filesystems.create(w.acme, nfsInput(w, net.id));
    await w.settleFs(net.id, created.id);
    await w.fixture.database.query(
      `UPDATE pools SET policy = coalesce(policy, '{}'::jsonb) || '{"billing":{"mode":"none"}}'::jsonb WHERE id = $1`,
      [w.poolId],
    );
    const at = await meterAfter(w, 2);
    expect(await fsWindows(w, created.id)).toEqual([]);
    const { rows } = await w.fixture.database.query<{ until: number }>(
      `SELECT (extract(epoch FROM metered_until) * 1000)::float8 AS until FROM filesystems WHERE id = $1`,
      [created.id],
    );
    expect(Number(rows[0]!.until)).toBe(Math.floor((at - 5 * 60_000) / HOUR) * HOUR);
  });

  it('every filesystem meter is in meterCatalog', () => {
    const keys = new Set(meterCatalog({ gpuModels: defaultMeterGpuModels }).map((m) => m.key));
    expect(meteredFilesystemKinds).toEqual(['nfs', 'lustre']);
    for (const kind of meteredFilesystemKinds) expect(keys.has(filesystemMeterOf(kind))).toBe(true);
  });
});

describe('filesystem input', () => {
  it('parses create input', () => {
    expect(
      parseCreateFilesystem({
        tenantId: 't1',
        networkId: 'net_01h0000000000000000000000a',
        name: 'data',
        kind: 'lustre',
        sizeGiB: 1200,
        deployment: 'persistent',
        zone: 'us-east-1a',
        idempotencyKey: 'k',
      }),
    ).toMatchObject({
      kind: 'lustre',
      sizeGiB: 1200,
      deployment: 'persistent',
      zone: 'us-east-1a',
    });
    for (const bad of [
      { kind: 'nfs', extra: 1 },
      { kind: 'smb' },
      { kind: 'lustre', sizeGiB: 0 },
      { kind: 'lustre', deployment: 'hot' },
      { kind: 'nfs', zone: 'Z!' },
    ])
      expect(() =>
        parseCreateFilesystem({
          tenantId: 't1',
          networkId: 'net_01h0000000000000000000000a',
          name: 'data',
          idempotencyKey: 'k',
          ...bad,
        }),
      ).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });

  it('parses instance mounts: plain absolute paths outside system directories, once each', () => {
    const fsId = 'fs_01h0000000000000000000000a';
    expect(parseInstanceFilesystems([{ filesystem: fsId, path: '/mnt/data' }])).toEqual([
      { filesystemId: fsId, path: '/mnt/data' },
    ]);
    for (const bad of [
      'nope',
      [{ filesystem: fsId }],
      [{ filesystem: 'net_01h0000000000000000000000a', path: '/mnt/a' }],
      [{ filesystem: fsId, path: 'relative' }],
      [{ filesystem: fsId, path: '/mnt/../etc' }],
      [{ filesystem: fsId, path: '/etc/cron.d' }],
      [{ filesystem: fsId, path: '/' }],
      [{ filesystem: fsId, path: "/mnt/a'b" }],
      [
        { filesystem: fsId, path: '/mnt/a' },
        { filesystem: fsId, path: '/mnt/a' },
      ],
      Array.from({ length: 17 }, (_, n) => ({ filesystem: fsId, path: `/mnt/${n}` })),
    ])
      expect(() => parseInstanceFilesystems(bad)).toThrow(
        expect.objectContaining({ code: 'INVALID_INPUT' }),
      );
  });
});
