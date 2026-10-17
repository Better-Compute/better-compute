import { afterEach, describe, expect, it } from 'vitest';
import { ComputeError } from '@better-compute/core';
import { closeFixtures } from '@better-compute/testing';
import { discoveryWork } from '@better-compute/vps';
import { workRows } from './support/runtime.js';
import { gceVm, gceWorld, type GceWorld } from './support/vps-gce.js';

// The `vps.discovery` worker (R5): every provider account whose provider can `discover` is listed
// into `provider_machines` on a period, with first sightings, changes and disappearances published
// as provider.machine.* events, and machines better-compute created linked to their instance.

afterEach(closeFixtures);

async function machineRows(world: GceWorld) {
  const { rows } = await world.fixture.database.query<{
    external_id: string;
    instance_id: string | null;
    gone: boolean;
    machine: Record<string, unknown>;
  }>(
    `SELECT external_id, instance_id, gone_at IS NOT NULL AS gone, machine FROM provider_machines
      WHERE account_id = $1 ORDER BY external_id`,
    [world.accountId],
  );
  return rows;
}

describe('vps.discovery', () => {
  it('first pass records every VM and publishes provider.machine.discovered', async () => {
    const world = await gceWorld({ discovery: { every: '1m' } });
    for (const name of ['legacy', 'web-1', 'web-2'])
      world.cloud.machines.set(`us-central1-a/${name}`, gceVm(name));
    await world.discover(0);
    const rows = await machineRows(world);
    expect(rows.map((row) => [row.external_id, row.gone, row.instance_id])).toEqual([
      ['us-central1-a/legacy', false, null],
      ['us-central1-a/web-1', false, null],
      ['us-central1-a/web-2', false, null],
    ]);
    expect(rows[0]!.machine).toMatchObject({ machineType: 'a3-highgpu-8g', state: 'running' });
    const events = await world.events('provider.machine.');
    expect(events.map((event) => event.type)).toEqual([
      'provider.machine.discovered',
      'provider.machine.discovered',
      'provider.machine.discovered',
    ]);
    expect(events[0]).toMatchObject({
      tenantId: world.rootTenant,
      data: {
        accountId: world.accountId,
        externalId: 'us-central1-a/legacy',
        machineType: 'a3-highgpu-8g',
        gpus: { model: 'nvidia-h100-80gb', count: 8 },
      },
    });
    const { rows: state } = await world.fixture.database.query<{ ok: boolean; error: unknown }>(
      `SELECT last_ok_at IS NOT NULL AS ok, last_error AS error FROM provider_discovery WHERE account_id = $1`,
      [world.accountId],
    );
    expect(state).toEqual([{ ok: true, error: null }]);
    // A second pass with nothing changed publishes nothing.
    await world.discover();
    expect(await world.events('provider.machine.')).toHaveLength(3);
  });

  it('a VM removed in GCP is marked gone on the next pass', async () => {
    const world = await gceWorld({ discovery: { every: '1m' } });
    world.cloud.machines.set('us-central1-a/legacy', gceVm('legacy'));
    world.cloud.machines.set('us-central1-a/web-1', gceVm('web-1'));
    await world.discover(0);
    world.cloud.machines.delete('us-central1-a/web-1');
    await world.discover();
    expect((await machineRows(world)).map((row) => [row.external_id, row.gone])).toEqual([
      ['us-central1-a/legacy', false],
      ['us-central1-a/web-1', true],
    ]);
    expect((await world.events('provider.machine.gone')).map((event) => event.data)).toEqual([
      { accountId: world.accountId, externalId: 'us-central1-a/web-1' },
    ]);
    // It comes back: seen again, no longer gone.
    world.cloud.machines.set('us-central1-a/web-1', gceVm('web-1'));
    await world.discover();
    expect((await machineRows(world)).every((row) => !row.gone)).toBe(true);
  });

  it('a changed VM publishes provider.machine.changed with the changed fields', async () => {
    const world = await gceWorld({ discovery: { every: '1m' } });
    world.cloud.machines.set('us-central1-a/legacy', gceVm('legacy'));
    await world.discover(0);
    world.cloud.machines.get('us-central1-a/legacy')!.state = 'stopped';
    await world.discover();
    const changed = await world.events('provider.machine.changed');
    expect(changed).toHaveLength(1);
    expect(changed[0]!.data).toMatchObject({
      accountId: world.accountId,
      externalId: 'us-central1-a/legacy',
    });
    expect(changed[0]!.data.changes).toContain('state');
    expect((await machineRows(world))[0]!.machine).toMatchObject({ state: 'stopped' });
  });

  it('links machines created by instances.create to their instance', async () => {
    const world = await gceWorld({ discovery: { every: '1m' } });
    const instance = await world.api.instances.create(world.acme, {
      tenantId: world.acmeTenant,
      poolId: world.poolId,
      flavor: 'a2.highgpu.1g',
      imageId: 'debian-12',
      idempotencyKey: 'vm-1',
    });
    await world.fixture.advance(1_000);
    await world.tick('vps.instances', 1);
    expect(world.cloud.machines.size).toBe(1);
    await world.discover(0);
    const [row] = await machineRows(world);
    expect(row).toMatchObject({ instance_id: instance.id, gone: false });
  });

  it('a provider without discover is skipped', async () => {
    const world = await gceWorld({ discovery: { every: '1m' } });
    const plain = await world.api.providerAccounts.create(world.root, {
      tenantId: world.rootTenant,
      provider: 'fake-plain',
      name: 'hetzner-main',
      config: {},
    });
    await world.discover(0);
    const { rows } = await world.fixture.database.query<{ account_id: string }>(
      `SELECT account_id FROM provider_discovery ORDER BY account_id`,
    );
    expect(rows.map((row) => row.account_id)).toEqual([world.accountId]);
    expect(rows.map((row) => row.account_id)).not.toContain(plain.id);
  });

  it('rate limits defer the account, not the worker', async () => {
    const world = await gceWorld({ discovery: { every: '1m' } });
    world.cloud.machines.set('us-central1-a/legacy', gceVm('legacy'));
    world.cloud.failNext = new ComputeError('RATE_LIMITED', 'Quota exceeded', undefined, {
      retryAfterMs: 30_000,
    });
    await world.discover(0);
    const now = world.fixture.clock.now();
    const rows = await workRows(world.fixture.database, discoveryWork);
    const deferred = rows.find((row) => row.key === world.accountId);
    expect(deferred).toBeDefined();
    expect(Math.abs(deferred!.not_before.getTime() - (now + 30_000))).toBeLessThan(1_000);
    const { rows: state } = await world.fixture.database.query<{ error: string | null }>(
      `SELECT last_error AS error FROM provider_discovery WHERE account_id = $1`,
      [world.accountId],
    );
    expect(state[0]!.error).toMatch(/RATE_LIMITED/);
    expect(await machineRows(world)).toEqual([]);
    // 30 s later the account is listed.
    await world.fixture.advance(30_000);
    await world.tick(discoveryWork, 1);
    expect(await machineRows(world)).toHaveLength(1);
  });
});
