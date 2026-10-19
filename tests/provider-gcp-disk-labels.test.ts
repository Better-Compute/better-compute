import { describe, expect, it } from 'vitest';
import { manualClock, type CallContext, type ProviderImpl } from '@better-compute/core';
import {
  changedLabels,
  diskPath,
  gcpProvider,
  isReservedLabelKey,
  machineLabels,
  tenantLabels,
  type GcpConfig,
} from '@better-compute/provider-gcp';
import { GceEmulator } from './support/gce-emulator.js';

// U-04: the tenant's labels on Compute Engine VMs and their boot disks. better-compute's own labels
// (better-compute-*) and the bc- prefix are never a tenant's: refused in vps input, dropped here too, and the
// ownership labels are merged last on create and carried over unchanged by setLabels.

const zone = 'us-central1-a';
const gcpAccount = { projectId: 'p', zones: [zone] };
const secrets = { resolve: async (ref: string) => ref };
const platformAccount = { id: 'pacct_platform', tenantId: 'root', platform: true };
const log = { debug() {}, info() {}, warn() {}, error() {} };

function ctx(key = 'inst_one'): CallContext {
  return {
    idempotencyKey: key,
    signal: new AbortController().signal,
    clock: manualClock(1_000_000),
    secrets,
    log,
  };
}

async function build(emu: GceEmulator): Promise<ProviderImpl> {
  const provider = gcpProvider({ fetch: emu.fetch, operationPollMs: 0 });
  const parsed = await provider.config['~standard'].validate(gcpAccount);
  return provider.create((parsed as { value: GcpConfig }).value, {
    clock: manualClock(1_000_000),
    secrets,
    log,
    account: platformAccount,
  });
}

const insertBody = (emu: GceEmulator) =>
  emu.requests.find(
    (r) => r.method === 'POST' && r.url.pathname.endsWith(`/zones/${zone}/instances`),
  )!.body as {
    labels: Record<string, string>;
    disks: { initializeParams: { labels: Record<string, string> } }[];
  };

describe('provider-gcp labels (U-04)', () => {
  it('merges ownership labels last on the VM and its boot disk, and drops reserved tenant keys', async () => {
    const emu = new GceEmulator();
    const impl = await build(emu);
    await impl.create(
      {
        offerId: `${zone}/n2-standard-4`,
        image: 'debian-12',
        userData: '#cloud-config\n',
        name: 'inst_one',
        labels: {
          team: 'ml',
          'better-compute-managed': 'false',
          'better-compute-instance': 'inst_other',
          'Better-Compute-Tenant': 'x',
          'bc-net': 'x',
        },
      },
      ctx(),
    );
    const body = insertBody(emu);
    const expected = {
      team: 'ml',
      'better-compute-managed': 'true',
      'better-compute-instance': 'inst_one',
    };
    expect(body.labels).toEqual(expected);
    expect(Object.keys(body.labels).slice(-2)).toEqual([
      'better-compute-managed',
      'better-compute-instance',
    ]);
    expect(body.disks[0]!.initializeParams.labels).toEqual(expected);
  });

  it('setLabels writes the tenant labels on the VM and its boot disk, keeping everything else', async () => {
    const emu = new GceEmulator();
    const source = `https://compute.googleapis.com/compute/v1/projects/p/zones/${zone}/disks/vm1`;
    emu.persistentDisks.set(`${zone}/vm1`, {
      type: 'pd-balanced',
      sizeGb: '100',
      labels: { team: 'ml', 'better-compute-instance': 'inst_one', 'disk-owner': 'ops' },
      labelFingerprint: 'fp1',
    });
    emu.addInstance(zone, 'vm1', {
      labels: {
        team: 'ml',
        old: 'x',
        site: 'dc1',
        'better-compute-managed': 'true',
        'better-compute-instance': 'inst_one',
      },
      disks: [{ boot: true, type: 'PERSISTENT', source, diskSizeGb: '100' }],
    });
    const impl = await build(emu);
    await impl.setLabels!(
      `${zone}/vm1`,
      {
        labels: { team: 'infra', tier: 'gpu', 'better-compute-managed': 'false', 'bc-x': 'y' },
        previous: { team: 'ml', old: 'x', 'better-compute-instance': 'whatever' },
      },
      ctx(),
      'inst_one',
    );
    expect(emu.instances.get(`${zone}/vm1`)!.labels).toEqual({
      team: 'infra',
      tier: 'gpu',
      site: 'dc1',
      'better-compute-managed': 'true',
      'better-compute-instance': 'inst_one',
    });
    expect(emu.persistentDisks.get(`${zone}/vm1`)!.labels).toEqual({
      team: 'infra',
      tier: 'gpu',
      'disk-owner': 'ops',
      'better-compute-instance': 'inst_one',
    });
    // Nothing to change: no write.
    const posts = () =>
      emu.requests.filter((r) => r.method === 'POST' && r.path.includes('setLabels')).length;
    const before = posts();
    await impl.setLabels!(
      `${zone}/vm1`,
      { labels: { team: 'infra', tier: 'gpu' } },
      ctx(),
      'inst_one',
    );
    expect(posts()).toBe(before);
  });

  it('refuses a VM labelled for another instance, and reports a gone one as NOT_FOUND', async () => {
    const emu = new GceEmulator();
    emu.addInstance(zone, 'vm1', { labels: { 'better-compute-instance': 'inst_other' } });
    const impl = await build(emu);
    await expect(
      impl.setLabels!(`${zone}/vm1`, { labels: { team: 'ml' } }, ctx(), 'inst_one'),
    ).rejects.toMatchObject({ code: 'INVALID_STATE', details: { reason: 'notOwner' } });
    expect(emu.instances.get(`${zone}/vm1`)!.labels).toEqual({
      'better-compute-instance': 'inst_other',
    });
    await expect(
      impl.setLabels!(`${zone}/gone`, { labels: { team: 'ml' } }, ctx(), 'inst_one'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('skips a boot disk of another project or one that is gone', async () => {
    const emu = new GceEmulator();
    emu.addInstance(zone, 'vm1', {
      labels: { 'better-compute-instance': 'inst_one' },
      disks: [
        {
          boot: true,
          type: 'PERSISTENT',
          source: `https://compute.googleapis.com/compute/v1/projects/elsewhere/zones/${zone}/disks/vm1`,
          diskSizeGb: '100',
        },
      ],
    });
    emu.addInstance(zone, 'vm2', {
      labels: { 'better-compute-instance': 'inst_two' },
      disks: [
        {
          boot: true,
          type: 'PERSISTENT',
          source: `https://compute.googleapis.com/compute/v1/projects/p/zones/${zone}/disks/missing`,
          diskSizeGb: '100',
        },
      ],
    });
    const impl = await build(emu);
    await impl.setLabels!(`${zone}/vm1`, { labels: { team: 'ml' } }, ctx(), 'inst_one');
    await impl.setLabels!(`${zone}/vm2`, { labels: { team: 'ml' } }, ctx(), 'inst_two');
    expect(emu.instances.get(`${zone}/vm1`)!.labels).toMatchObject({ team: 'ml' });
    expect(emu.instances.get(`${zone}/vm2`)!.labels).toMatchObject({ team: 'ml' });
    expect(emu.requests.some((r) => r.path.includes('/projects/elsewhere'))).toBe(false);
  });

  it('label helpers', () => {
    expect(isReservedLabelKey('better-compute-pool')).toBe(true);
    expect(isReservedLabelKey('bc-abc')).toBe(true);
    expect(isReservedLabelKey('bcx')).toBe(false);
    expect(tenantLabels({ Team: 'ML', '9x': 'y', 'BC-x': 'y' })).toEqual({ team: 'ml' });
    expect(machineLabels({ 'better-compute-instance': 'evil' }, 'inst_a')).toEqual({
      'better-compute-managed': 'true',
      'better-compute-instance': 'inst_a',
    });
    expect(
      changedLabels({ a: '1', 'better-compute-instance': 'i' }, { labels: { a: '1' } }),
    ).toBeUndefined();
    expect(
      changedLabels(
        { a: '1', 'better-compute-instance': 'i' },
        { labels: {}, previous: { a: '1' } },
      ),
    ).toEqual({ 'better-compute-instance': 'i' });
    expect(diskPath(`https://x/compute/v1/projects/p/regions/r1/disks/d`, 'p')).toBe(
      '/regions/r1/disks/d',
    );
    expect(diskPath(`https://x/compute/v1/projects/q/zones/z/disks/d`, 'p')).toBeUndefined();
    expect(diskPath(undefined, 'p')).toBeUndefined();
  });
});
