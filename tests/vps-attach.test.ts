import { afterEach, describe, expect, it } from 'vitest';
import { apiSurface } from '@better-compute/core';
import { closeFixtures } from '@better-compute/testing';
import { gceVm, gceWorld, instanceLabel, type GceWorld } from './support/vps-gce.js';

// instances.attach (R1, D5-D7): an operator attaches a GCE VM that already runs to a customer
// tenant (acme), owned by one of its people, without recreating it. The machine must have been
// seen by discovery and be free; the database referees a double attach.

afterEach(closeFixtures);

const LEGACY = 'us-central1-a/legacy';

async function legacyWorld(options: Parameters<typeof gceWorld>[0] = {}): Promise<GceWorld> {
  const world = await gceWorld({ discovery: { every: '1m' }, ...options });
  world.cloud.machines.set(LEGACY, gceVm('legacy'));
  await world.discover(0);
  return world;
}

const attachInput = (world: GceWorld, extra: Record<string, unknown> = {}) => ({
  tenantId: world.acmeTenant,
  poolId: world.poolId,
  externalId: LEGACY,
  ownerIdentityId: world.fixture.tenants.acme.caller.identityId,
  idempotencyKey: 'attach-legacy',
  ...extra,
});

const code = (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (error: { code?: string }) => error.code,
  );

async function machineLink(world: GceWorld, externalId = LEGACY) {
  const { rows } = await world.fixture.database.query<{ instance_id: string | null }>(
    `SELECT instance_id FROM provider_machines WHERE account_id = $1 AND external_id = $2`,
    [world.accountId, externalId],
  );
  return rows[0]?.instance_id;
}

async function quotaUsed(world: GceWorld, resource: string) {
  const { rows } = await world.fixture.database.query<{ used: string }>(
    `SELECT used FROM quota_usage WHERE tenant_id = $1 AND pool_id = $2 AND resource = $3`,
    [world.acmeTenant, world.poolId, resource],
  );
  return Number(rows[0]?.used ?? 0);
}

describe('instances.attach', () => {
  it('attach creates an instance owned by the customer tenant and the given owner', async () => {
    const world = await legacyWorld();
    const instance = await world.api.instances.attach(world.root, attachInput(world));
    expect(instance).toMatchObject({
      tenantId: world.acmeTenant,
      poolId: world.poolId,
      origin: 'attached',
      onDelete: 'detach',
      externalId: LEGACY,
      state: 'scheduling',
      desiredState: 'running',
      flavor: 'a3-highgpu-8g',
      ownerIdentityId: world.fixture.tenants.acme.caller.identityId,
    });
    const mine = await world.api.instances.list(world.acme, {
      tenantId: world.acmeTenant,
      scope: 'mine',
    });
    expect(mine.items.map((item: { id: string }) => item.id)).toContain(instance.id);
    expect(await machineLink(world)).toBe(instance.id);
    expect(await quotaUsed(world, 'gpu')).toBe(8);
    expect(await quotaUsed(world, 'vcpu')).toBe(208);
    const [attached] = await world.events('instance.attached');
    expect(attached).toMatchObject({
      tenantId: world.acmeTenant,
      data: {
        instanceId: instance.id,
        accountId: world.accountId,
        externalId: LEGACY,
        poolId: world.poolId,
        onDelete: 'detach',
      },
    });
    // The provider was not touched by the call itself.
    expect(world.cloud.requests.filter((request) => request !== 'discover')).toEqual([]);
  });

  it('refuses a second attach of the same machine', async () => {
    const world = await legacyWorld();
    const first = await world.api.instances.attach(world.root, attachInput(world));
    await expect(
      world.api.instances.attach(world.root, attachInput(world, { idempotencyKey: 'again' })),
    ).rejects.toMatchObject({ code: 'CONFLICT', details: { instanceId: first.id } });
  });

  it('replays the same attach idempotently', async () => {
    const world = await legacyWorld();
    const first = await world.api.instances.attach(world.root, attachInput(world));
    const again = await world.api.instances.attach(world.root, attachInput(world));
    expect(again.id).toBe(first.id);
    expect(await quotaUsed(world, 'gpu')).toBe(8);
    // The same key for a different request is a conflict.
    expect(
      await code(
        world.api.instances.attach(world.root, attachInput(world, { onDelete: 'delete' })),
      ),
    ).toBe('CONFLICT');
  });

  it('refuses attaching a machine discovery marked gone', async () => {
    const world = await legacyWorld();
    world.cloud.machines.delete(LEGACY);
    await world.discover();
    await expect(world.api.instances.attach(world.root, attachInput(world))).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: expect.stringContaining('providerAccounts.discover'),
    });
    // Never seen at all: the same.
    expect(
      await code(
        world.api.instances.attach(
          world.root,
          attachInput(world, { externalId: 'us-central1-a/nope', idempotencyKey: 'nope' }),
        ),
      ),
    ).toBe('NOT_FOUND');
  });

  it('refuses a pool not visible to the tenant', async () => {
    const world = await legacyWorld();
    expect(
      await code(
        world.api.instances.attach(
          world.root,
          attachInput(world, { tenantId: world.fixture.tenants.other.id }),
        ),
      ),
    ).toBe('NOT_FOUND');
    expect(await machineLink(world)).toBeNull();
  });

  it('refuses a tenant attaching from a root account', async () => {
    const world = await legacyWorld();
    expect(
      await code(
        world.api.instances.attach(world.acme, attachInput(world, { ownerIdentityId: undefined })),
      ),
    ).toBe('ACCESS_DENIED');
    expect(await machineLink(world)).toBeNull();
    // Without iam.rootTenantId the same holds: a caller in its own tenant is not the platform.
    const bare = await legacyWorld({ iamRoot: false });
    expect(
      await code(
        bare.api.instances.attach(bare.acme, attachInput(bare, { ownerIdentityId: undefined })),
      ),
    ).toBe('ACCESS_DENIED');
    expect((await bare.api.instances.attach(bare.root, attachInput(bare))).origin).toBe('attached');
  });

  it('charges quota and refuses over quota', async () => {
    const world = await legacyWorld();
    await world.api.quotas.set(world.root, {
      tenantId: world.acmeTenant,
      poolId: world.poolId,
      resource: 'gpu',
      max: 4,
    });
    await expect(world.api.instances.attach(world.root, attachInput(world))).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
    });
    // Nothing was written.
    expect(await machineLink(world)).toBeNull();
    expect(await quotaUsed(world, 'gpu')).toBe(0);
    expect(await quotaUsed(world, 'vcpu')).toBe(0);
    const { rows } = await world.fixture.database.query(
      `SELECT 1 FROM instances WHERE origin = 'attached'`,
    );
    expect(rows).toEqual([]);
    expect(await world.events('instance.attached')).toEqual([]);
  });

  it('unique index refuses a concurrent duplicate', async () => {
    const world = await legacyWorld();
    const results = await Promise.allSettled([
      world.api.instances.attach(world.root, attachInput(world, { idempotencyKey: 'race-a' })),
      world.api.instances.attach(world.root, attachInput(world, { idempotencyKey: 'race-b' })),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(rejected.map((result) => result.reason.code)).toEqual(['CONFLICT']);
    const { rows } = await world.fixture.database.query(
      `SELECT id FROM instances WHERE external_id = $1 AND state <> 'deleted'`,
      [LEGACY],
    );
    expect(rows).toHaveLength(1);
    // The database itself refuses a second live instance of the machine.
    await expect(
      world.fixture.database.query(
        `INSERT INTO instances (id, tenant_id, pool_id, flavor, runtime, state, desired_state,
                                provider_account_id, external_id, owner_identity_id, idempotency_key,
                                request_hash, version)
         SELECT 'inst_dup', tenant_id, pool_id, flavor, runtime, 'running', 'running',
                provider_account_id, external_id, owner_identity_id, 'dup', request_hash, 1
           FROM instances WHERE external_id = $1`,
        [LEGACY],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    expect(instanceLabel).toBe('better-compute-instance');
  });

  it('api surface has the row and the action', () => {
    expect(
      apiSurface.find((row) => row.group === 'instances' && row.method === 'attach'),
    ).toMatchObject({
      action: 'compute:instances:attach',
      resource: 'instance',
      kind: 'mutation',
      phase: 'v1.0',
      module: 'vps',
    });
  });
});
