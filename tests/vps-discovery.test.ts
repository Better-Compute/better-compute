import { afterEach, describe, expect, it } from 'vitest';
import { apiSurface, ComputeError } from '@better-compute/core';
import { closeFixtures } from '@better-compute/testing';
import { autoAttachLabels, autoAttachRefused, discoveryWork } from '@better-compute/vps';
import { workRows } from './support/runtime.js';
import {
  fakeGceProvider,
  gceVm,
  gceWorld,
  type FakeGce,
  type GceWorld,
} from './support/vps-gce.js';

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

  it('rediscovers on the next period although the pass took a while', async () => {
    const world = await gceWorld({ discovery: { every: '1m' } });
    world.cloud.machines.set('us-central1-a/legacy', gceVm('legacy'));
    // The provider takes 10 s to list (within the run's 15 s lease).
    world.cloud.onDiscover = () => world.fixture.advance(10_000).then(() => undefined);
    const start = world.fixture.clock.now();
    await world.discover(0);
    expect(world.cloud.requests.filter((request) => request === 'discover')).toHaveLength(1);
    // One period after the first pass started, the next `all` tick finds the account due.
    await world.fixture.clock.set(start + 60_000);
    await world.tick('vps.discovery');
    expect(world.cloud.requests.filter((request) => request === 'discover')).toHaveLength(2);
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

describe('api: providerAccounts.machines and providerAccounts.discover', () => {
  it('machines lists free VMs by default and attached with filter', async () => {
    const world = await gceWorld({ discovery: { every: '1m' } });
    world.cloud.machines.set(
      'us-central1-b/zeta',
      gceVm('zeta', { id: 'us-central1-b/zeta', zone: 'us-central1-b' }),
    );
    world.cloud.machines.set('us-central1-a/legacy', gceVm('legacy'));
    const instance = await world.api.instances.create(world.acme, {
      tenantId: world.acmeTenant,
      poolId: world.poolId,
      flavor: 'a2.highgpu.1g',
      imageId: 'debian-12',
      idempotencyKey: 'vm-1',
    });
    await world.fixture.advance(1_000);
    await world.tick('vps.instances', 1);
    world.cloud.machines.set('us-central1-a/old', gceVm('old'));
    await world.discover(0);
    world.cloud.machines.delete('us-central1-a/old');
    await world.discover();
    const ref = { tenantId: world.rootTenant, accountId: world.accountId };
    const free = await world.api.providerAccounts.machines(world.root, ref);
    expect(free.items.map((item: { externalId: string }) => item.externalId)).toEqual([
      'us-central1-a/legacy',
      'us-central1-b/zeta',
    ]);
    expect(free.items[0]).toMatchObject({
      accountId: world.accountId,
      name: 'legacy',
      state: 'running',
      zone: 'us-central1-a',
      machineType: 'a3-highgpu-8g',
      gpus: { model: 'nvidia-h100-80gb', count: 8 },
      labels: {},
      networks: [{ network: 'default', address: '10.128.0.2' }],
      addresses: ['10.128.0.2'],
    });
    expect(free.items[0].instanceId).toBeUndefined();
    expect(typeof free.items[0].firstSeenAt).toBe('number');
    expect(free.discoveredAt).toBe(world.fixture.clock.now());
    const attached = await world.api.providerAccounts.machines(world.root, {
      ...ref,
      filter: 'attached',
    });
    expect(attached.items).toMatchObject([{ instanceId: instance.id, tenantId: world.acmeTenant }]);
    const all = await world.api.providerAccounts.machines(world.root, {
      ...ref,
      filter: 'all',
      includeGone: true,
    });
    expect(all.items).toHaveLength(4);
    expect(all.items.find((item: { name?: string }) => item.name === 'old').goneAt).toBeTypeOf(
      'number',
    );
    // Pages follow (zone, externalId).
    const first = await world.api.providerAccounts.machines(world.root, {
      ...ref,
      filter: 'all',
      limit: 2,
    });
    expect(first.items).toHaveLength(2);
    const rest = await world.api.providerAccounts.machines(world.root, {
      ...ref,
      filter: 'all',
      limit: 2,
      cursor: first.cursor,
    });
    expect(
      [...first.items, ...rest.items].map((item: { externalId: string }) => item.externalId),
    ).toEqual(
      (await world.api.providerAccounts.machines(world.root, { ...ref, filter: 'all' })).items.map(
        (item: { externalId: string }) => item.externalId,
      ),
    );
    expect(rest.cursor).toBeUndefined();
    // Another tenant's account is not found.
    await expect(
      world.api.providerAccounts.machines(world.acme, {
        tenantId: world.acmeTenant,
        accountId: world.accountId,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('machines is denied without providers:read', async () => {
    const world = await gceWorld({ discovery: { every: '1m' } });
    world.fixture.iam.addCaller('token-nobody', { tenantId: world.rootTenant });
    await expect(
      world.api.providerAccounts.machines(
        { token: 'token-nobody' },
        { tenantId: world.rootTenant, accountId: world.accountId },
      ),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  });

  it('discover with wait returns after the pass', async () => {
    const world = await gceWorld({ discovery: { every: '1h' } });
    world.cloud.machines.set('us-central1-a/legacy', gceVm('legacy'));
    await world.discover(0);
    world.cloud.machines.set('us-central1-a/web-1', gceVm('web-1'));
    await world.fixture.advance(5_000);
    const ref = { tenantId: world.rootTenant, accountId: world.accountId };
    const [answer] = await Promise.all([
      world.api.providerAccounts.discover(world.root, { ...ref, wait: true }),
      (async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        await world.tick('vps.discovery', 1);
      })(),
    ]);
    expect(answer).toEqual({ queued: true, discoveredAt: world.fixture.clock.now() });
    const { items } = await world.api.providerAccounts.machines(world.root, ref);
    expect(items).toHaveLength(2);
    // Without wait: queued, answered at once.
    expect(await world.api.providerAccounts.discover(world.root, ref)).toEqual({ queued: true });
    const plain = await world.api.providerAccounts.create(world.root, {
      tenantId: world.rootTenant,
      provider: 'fake-plain',
      name: 'plain',
      config: {},
    });
    await expect(
      world.api.providerAccounts.discover(world.root, { ...ref, accountId: plain.id }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });

  it('api surface has the rows', () => {
    expect(
      apiSurface.find((row) => row.group === 'providerAccounts' && row.method === 'machines'),
    ).toMatchObject({
      action: 'compute:providers:read',
      resource: 'provider-account',
      phase: 'v1.0',
      kind: 'read',
      module: 'vps',
    });
    expect(
      apiSurface.find((row) => row.group === 'providerAccounts' && row.method === 'discover'),
    ).toMatchObject({
      action: 'compute:providers:manage',
      resource: 'provider-account',
      phase: 'v1.0',
      kind: 'mutation',
    });
  });
});

describe('auto-attach', () => {
  const owner = 'identity-platform';
  const labelled = (world: GceWorld, extra: Record<string, string> = {}) => ({
    [autoAttachLabels.tenant]: world.acmeTenant,
    [autoAttachLabels.pool]: world.poolId,
    ...extra,
  });
  async function attachedInstances(world: GceWorld) {
    const { rows } = await world.fixture.database.query<{
      id: string;
      tenant_id: string;
      owner_identity_id: string;
      on_delete: string;
      external_id: string;
    }>(
      `SELECT id, tenant_id, owner_identity_id, on_delete, external_id FROM instances
        WHERE origin = 'attached' ORDER BY external_id`,
    );
    return rows;
  }

  it('auto-attaches a labelled VM to its tenant and pool', async () => {
    const world = await gceWorld({
      discovery: { every: '1m', autoAttach: { ownerIdentityId: owner } },
    });
    world.cloud.machines.set(
      'us-central1-a/legacy',
      gceVm('legacy', { labels: labelled(world, { [autoAttachLabels.owner]: 'identity-acme' }) }),
    );
    world.cloud.machines.set('us-central1-a/web-1', gceVm('web-1', { labels: labelled(world) }));
    await world.discover(0);
    const attached = await attachedInstances(world);
    expect(attached).toMatchObject([
      {
        tenant_id: world.acmeTenant,
        owner_identity_id: 'identity-acme',
        on_delete: 'detach',
        external_id: 'us-central1-a/legacy',
      },
      { tenant_id: world.acmeTenant, owner_identity_id: owner, external_id: 'us-central1-a/web-1' },
    ]);
    const mine = await world.api.instances.list(world.acme, { tenantId: world.acmeTenant });
    expect(mine.items.map((item: { id: string }) => item.id)).toEqual([attached[0]!.id]);
    // The instance reconciler then claims it, and the next pass leaves it alone.
    await world.tick('vps.instances', 1);
    expect(world.cloud.machines.get('us-central1-a/legacy')!.labels).toMatchObject({
      'better-compute-instance': attached[0]!.id,
    });
    await world.discover();
    expect(await attachedInstances(world)).toHaveLength(2);
    expect(await world.events('instance.attached')).toHaveLength(2);
  });

  it('ignores VMs without both labels', async () => {
    const world = await gceWorld({
      discovery: { every: '1m', autoAttach: { ownerIdentityId: owner } },
    });
    world.cloud.machines.set(
      'us-central1-a/tenant-only',
      gceVm('tenant-only', { labels: { [autoAttachLabels.tenant]: world.acmeTenant } }),
    );
    world.cloud.machines.set(
      'us-central1-a/pool-only',
      gceVm('pool-only', { labels: { [autoAttachLabels.pool]: world.poolId } }),
    );
    world.cloud.machines.set('us-central1-a/bare', gceVm('bare'));
    // Labelled, but its ownership label names an instance already: someone else's.
    world.cloud.machines.set(
      'us-central1-a/claimed',
      gceVm('claimed', { labels: labelled(world, { 'better-compute-instance': 'inst_other' }) }),
    );
    await world.discover(0);
    expect(await attachedInstances(world)).toEqual([]);
  });

  it('refuses a BYO account labelling a VM for another tenant', async () => {
    const byo: FakeGce = { machines: new Map(), requests: [] };
    const world = await gceWorld({
      discovery: { every: '1m', autoAttach: { ownerIdentityId: owner } },
      providers: [fakeGceProvider(byo, 'fake-gce-byo')],
    });
    const account = await world.api.providerAccounts.create(world.acme, {
      tenantId: world.acmeTenant,
      provider: 'fake-gce-byo',
      name: 'acme-gcp',
      config: {},
    });
    byo.machines.set(
      'us-central1-a/sneaky',
      gceVm('sneaky', {
        labels: {
          [autoAttachLabels.tenant]: world.fixture.tenants.other.id,
          [autoAttachLabels.pool]: world.poolId,
        },
      }),
    );
    await world.discover(0);
    expect(await attachedInstances(world)).toEqual([]);
    const refusals = async () =>
      (await world.events('provider.machine.changed')).filter(
        (event) => event.data.accountId === account.id,
      );
    expect(await refusals()).toMatchObject([
      {
        tenantId: world.acmeTenant,
        data: { externalId: 'us-central1-a/sneaky', changes: ['autoAttachRefused'] },
      },
    ]);
    const { rows } = await world.fixture.database.query<{
      machine: { autoAttachError?: { code: string } };
    }>(`SELECT machine FROM provider_machines WHERE account_id = $1`, [account.id]);
    expect(rows[0]!.machine.autoAttachError).toMatchObject({ code: autoAttachRefused });
    // Refused once, not on every pass.
    await world.discover();
    expect(await refusals()).toHaveLength(1);
  });

  it('never attaches a machine of another account through a pool it labels', async () => {
    const byo: FakeGce = { machines: new Map(), requests: [] };
    const world = await gceWorld({
      discovery: { every: '1m', autoAttach: { ownerIdentityId: owner } },
      providers: [fakeGceProvider(byo, 'fake-gce-byo')],
    });
    const account = await world.api.providerAccounts.create(world.acme, {
      tenantId: world.acmeTenant,
      provider: 'fake-gce-byo',
      name: 'acme-gcp',
      config: {},
    });
    // Review probe: acme labels a VM of its own account for the root pool offered to it; the
    // root account has a free VM with the same zone and name.
    byo.machines.set('us-central1-a/legacy', gceVm('legacy', { labels: labelled(world) }));
    world.cloud.machines.set('us-central1-a/legacy', gceVm('legacy'));
    await world.discover(0);
    await world.tick('vps.instances', 1);
    expect(await attachedInstances(world)).toEqual([]);
    const { rows } = await world.fixture.database.query<{
      machine: { autoAttachError?: { code: string; message: string } };
    }>(`SELECT machine FROM provider_machines WHERE account_id = $1`, [account.id]);
    expect(rows[0]!.machine.autoAttachError).toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining(account.id),
    });
    expect(world.cloud.requests.some((request) => request.startsWith('claim'))).toBe(false);
    expect(world.cloud.machines.get('us-central1-a/legacy')!.labels).toEqual({});
  });

  it('records quota failure without failing the pass', async () => {
    const world = await gceWorld({
      discovery: { every: '1m', autoAttach: { ownerIdentityId: owner } },
      quota: { vcpu: 512, memoryGiB: 4096, diskGiB: 1000, gpu: 4 },
    });
    world.cloud.machines.set('us-central1-a/legacy', gceVm('legacy', { labels: labelled(world) }));
    world.cloud.machines.set('us-central1-a/web-1', gceVm('web-1'));
    await world.discover(0);
    expect(await attachedInstances(world)).toEqual([]);
    const { rows } = await world.fixture.database.query<{
      external_id: string;
      machine: { autoAttachError?: { code: string } };
    }>(`SELECT external_id, machine FROM provider_machines ORDER BY external_id`);
    expect(rows.map((row) => row.external_id)).toEqual([
      'us-central1-a/legacy',
      'us-central1-a/web-1',
    ]);
    expect(rows[0]!.machine.autoAttachError).toMatchObject({ code: 'QUOTA_EXCEEDED' });
    const { rows: pass } = await world.fixture.database.query<{ ok: boolean; error: unknown }>(
      `SELECT last_ok_at IS NOT NULL AS ok, last_error AS error FROM provider_discovery`,
    );
    expect(pass).toEqual([{ ok: true, error: null }]);
    expect(await world.events('instance.attached')).toEqual([]);
  });

  it('disabled by default', async () => {
    const world = await gceWorld({ discovery: { every: '1m' } });
    world.cloud.machines.set('us-central1-a/legacy', gceVm('legacy', { labels: labelled(world) }));
    await world.discover(0);
    expect(await attachedInstances(world)).toEqual([]);
    const { rows } = await world.fixture.database.query<{ machine: Record<string, unknown> }>(
      `SELECT machine FROM provider_machines`,
    );
    expect(rows[0]!.machine.autoAttachError).toBeUndefined();
  });
});
