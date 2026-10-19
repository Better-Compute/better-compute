import { afterEach, describe, expect, it } from 'vitest';
import { applyBudgetPolicy } from '@better-compute/capacity';
import { closeFixtures } from '@better-compute/testing';
import { sandboxIamReactions } from '@better-compute/vps';
import { gceWorld, type GceWorld } from './support/vps-gce.js';

// Offer budget policies over the API (D16): `pools.offer` stores `onBudgetExceeded` (now with `suspend`) and
// `allowedRegions`; `pools.updateOffer` changes them and lifts a suspension; a spent budget with `suspend` stops the
// tenant's running instances in the pool and refuses new work while `suspended_at` is set. Budget checks on
// `instances.attach` and `networks.create` follow in the `paths` section.

afterEach(closeFixtures);

const code = (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (error: { code?: string }) => error.code,
  );

const alertFor = (world: GceWorld) => ({
  tenantId: world.acmeTenant,
  budgetId: 'bud_1',
  name: 'monthly',
  exceeded: true,
  spentMicros: 21,
  amountMicros: 20,
});

/** What the host's budget handler does for an IAM alert: capacity's policy, then vps's suspension reaction. */
async function overspend(world: GceWorld, alert = alertFor(world)) {
  const context = world.fixture.compute.context;
  return context.sql.transaction(async (tx) =>
    applyBudgetPolicy(tx as never, context, alert, {
      suspend: (suspendTx, suspended) => sandboxIamReactions.budget(suspendTx, context, suspended),
    }),
  );
}

const offerRow = async (world: GceWorld, tenantId = world.acmeTenant) => {
  const { rows } = await world.fixture.database.query<{
    on_budget_exceeded: string | null;
    allowed_regions: string[] | null;
    suspended_at: Date | null;
  }>(
    `SELECT on_budget_exceeded, allowed_regions, suspended_at FROM pool_offers WHERE pool_id = $1 AND tenant_id = $2`,
    [world.poolId, tenantId],
  );
  return rows[0]!;
};

const updateOffer = (world: GceWorld, extra: Record<string, unknown>, who = world.root) =>
  world.api.pools.updateOffer(who, {
    tenantId: world.rootTenant,
    poolId: world.poolId,
    toTenantId: world.acmeTenant,
    ...extra,
  });

async function createVm(world: GceWorld, key = 'vm-1') {
  return world.api.instances.create(world.acme, {
    tenantId: world.acmeTenant,
    poolId: world.poolId,
    flavor: 'a2.highgpu.1g',
    imageId: 'debian-12',
    idempotencyKey: key,
  });
}

const viewOf = (world: GceWorld, instanceId: string) =>
  world.api.instances.get(world.acme, { tenantId: world.acmeTenant, instanceId });

async function settle(world: GceWorld, rounds = 3, ms = 1_000) {
  for (let round = 0; round < rounds; round++) {
    await world.fixture.advance(ms);
    await world.tick('vps.instances', 1);
  }
}

async function runningVm(world: GceWorld, key = 'vm-1') {
  const created = await createVm(world, key);
  await settle(world);
  expect((await viewOf(world, created.id)).state).toBe('running');
  return created;
}

describe('offers', () => {
  it('offer accepts and stores budget policy and regions', async () => {
    const world = await gceWorld();
    const other = world.fixture.tenants.other.id;
    await world.api.pools.offer(world.root, {
      tenantId: world.rootTenant,
      poolId: world.poolId,
      toTenantId: other,
      quota: { gpu: 1 },
      onBudgetExceeded: 'suspend',
      allowedRegions: ['us-central1', 'eu-west1'],
    });
    expect(await offerRow(world, other)).toMatchObject({
      on_budget_exceeded: 'suspend',
      allowed_regions: ['us-central1', 'eu-west1'],
      suspended_at: null,
    });
    // The other values the column took before still do, and an offer without them stays as it was.
    for (const policy of ['notify', 'stop-new', 'drain'])
      await world.api.pools.offer(world.root, {
        tenantId: world.rootTenant,
        poolId: world.poolId,
        toTenantId: other,
        quota: { gpu: 1 },
        onBudgetExceeded: policy,
      });
    await world.api.pools.offer(world.root, {
      tenantId: world.rootTenant,
      poolId: world.poolId,
      toTenantId: other,
      quota: { gpu: 2 },
    });
    expect(await offerRow(world, other)).toMatchObject({
      on_budget_exceeded: 'drain',
      allowed_regions: ['us-central1', 'eu-west1'],
    });
    for (const bad of [
      { onBudgetExceeded: 'explode' },
      { allowedRegions: [] },
      { allowedRegions: ['Not A Region'] },
      { allowedRegions: 'us-central1' },
    ])
      expect(
        await code(
          world.api.pools.offer(world.root, {
            tenantId: world.rootTenant,
            poolId: world.poolId,
            toTenantId: other,
            quota: { gpu: 1 },
            ...bad,
          }),
        ),
      ).toBe('INVALID_INPUT');
  });

  it('updateOffer changes the policy and regions of an offer, and suspends or lifts it', async () => {
    const world = await gceWorld();
    await updateOffer(world, { onBudgetExceeded: 'stop-new', allowedRegions: ['us-central1'] });
    expect(await offerRow(world)).toMatchObject({
      on_budget_exceeded: 'stop-new',
      allowed_regions: ['us-central1'],
      suspended_at: null,
    });
    await updateOffer(world, { suspended: true });
    expect((await offerRow(world)).suspended_at).not.toBeNull();
    // The other fields are untouched by a change that does not name them.
    expect(await offerRow(world)).toMatchObject({
      on_budget_exceeded: 'stop-new',
      allowed_regions: ['us-central1'],
    });
    await updateOffer(world, { suspended: false });
    expect((await offerRow(world)).suspended_at).toBeNull();
    // Nothing named, no such offer, the owner's own pool.
    expect(await code(updateOffer(world, {}))).toBe('INVALID_INPUT');
    expect(
      await code(
        updateOffer(world, {
          onBudgetExceeded: 'notify',
          toTenantId: world.fixture.tenants.other.id,
        }),
      ),
    ).toBe('NOT_FOUND');
    expect(await code(updateOffer(world, { onBudgetExceeded: 'nope' }))).toBe('INVALID_INPUT');
    expect((await world.events('pool.offer-updated')).length).toBe(3);
  });

  it('a tenant cannot update an offer', async () => {
    const world = await gceWorld();
    // acme is offered the pool but does not own it: the offer is the owner's to change.
    expect(
      await code(
        world.api.pools.updateOffer(world.acme, {
          tenantId: world.acmeTenant,
          poolId: world.poolId,
          toTenantId: world.acmeTenant,
          onBudgetExceeded: 'notify',
          suspended: false,
        }),
      ),
    ).toBe('NOT_FOUND');
    expect(
      await code(
        world.api.pools.updateOffer(world.acme, {
          tenantId: world.rootTenant,
          poolId: world.poolId,
          toTenantId: world.acmeTenant,
          onBudgetExceeded: 'notify',
        }),
      ),
    ).not.toBe('resolved');
    expect(await offerRow(world)).toMatchObject({ on_budget_exceeded: null, suspended_at: null });
  });
});

describe('suspend', () => {
  it('suspend stops running provider instances and refuses new ones', async () => {
    const world = await gceWorld();
    await updateOffer(world, { onBudgetExceeded: 'suspend' });
    const vm = await runningVm(world);

    // Not yet spent: new work is admitted (the default fake IAM allows every budget check).
    const second = await createVm(world, 'vm-2');

    const result = await overspend(world);
    expect(result.pools).toEqual([{ poolId: world.poolId, policy: 'suspend' }]);
    expect((await offerRow(world)).suspended_at).not.toBeNull();
    expect(await world.events('quota.budget-suspended')).toEqual([
      expect.objectContaining({
        tenantId: world.acmeTenant,
        data: expect.objectContaining({ poolId: world.poolId, budgetId: 'bud_1' }),
      }),
    ]);

    // Desired state stopped, with the condition; the reconciler stops the machine.
    for (const id of [vm.id, second.id]) {
      const after = await viewOf(world, id);
      expect(after.desiredState).toBe('stopped');
      expect(after.conditions).toContainEqual(
        expect.objectContaining({ type: 'BudgetSuspended', status: 'true' }),
      );
    }
    await settle(world, 4, 30_000);
    expect((await viewOf(world, vm.id)).state).toBe('stopped');
    expect((await viewOf(world, second.id)).state).toBe('stopped');
    expect([...world.cloud.machines.values()].some((machine) => machine.state === 'running')).toBe(
      false,
    );

    // New work is refused while suspended: create, and starting a stopped one again.
    await expect(createVm(world, 'vm-3')).rejects.toMatchObject({
      code: 'SPEND_LIMIT_REACHED',
      details: { reason: 'offer-suspended', poolId: world.poolId },
    });
    expect(
      await code(
        world.api.instances.start(world.acme, { tenantId: world.acmeTenant, instanceId: vm.id }),
      ),
    ).toBe('SPEND_LIMIT_REACHED');

    // A replayed alert stops nothing twice and publishes the suspension once.
    await overspend(world);
    expect((await world.events('quota.budget-suspended')).length).toBe(1);
  });

  it('suspend leaves other offers and other tenants alone, and below 100 % does nothing', async () => {
    const world = await gceWorld();
    await updateOffer(world, { onBudgetExceeded: 'suspend' });
    const vm = await runningVm(world);
    const below = await overspend(world, { ...alertFor(world), exceeded: false });
    expect(below.pools).toEqual([]);
    expect((await offerRow(world)).suspended_at).toBeNull();
    expect((await viewOf(world, vm.id)).desiredState).toBe('running');
    // An offer with another policy is not suspended by the same alert.
    await updateOffer(world, { onBudgetExceeded: 'notify' });
    await overspend(world);
    expect((await offerRow(world)).suspended_at).toBeNull();
    expect((await viewOf(world, vm.id)).desiredState).toBe('running');
  });

  it('resuming does not restart instances', async () => {
    const world = await gceWorld();
    await updateOffer(world, { onBudgetExceeded: 'suspend' });
    const vm = await runningVm(world);
    await overspend(world);
    await settle(world);
    expect((await viewOf(world, vm.id)).state).toBe('stopped');

    await updateOffer(world, { suspended: false });
    expect((await offerRow(world)).suspended_at).toBeNull();
    await settle(world);
    const after = await viewOf(world, vm.id);
    expect(after.state).toBe('stopped');
    expect(after.desiredState).toBe('stopped');
    expect([...world.cloud.machines.values()].some((machine) => machine.state === 'running')).toBe(
      false,
    );
    // New work is admitted again, and the tenant may start its instance itself.
    const fresh = await createVm(world, 'vm-after');
    expect(fresh.id).not.toBe(vm.id);
    const started = await world.api.instances.start(world.acme, {
      tenantId: world.acmeTenant,
      instanceId: vm.id,
    });
    expect(started.desiredState).toBe('running');
    expect(
      started.conditions.some(
        (condition: { type: string }) => condition.type === 'BudgetSuspended',
      ),
    ).toBe(false);
  });
});

describe('regions', () => {
  it('allowedRegions refuses other regions', async () => {
    const world = await gceWorld();
    // The pool's site is in us-central1.
    await updateOffer(world, { allowedRegions: ['eu-west1'] });
    await expect(createVm(world, 'vm-eu')).rejects.toMatchObject({
      code: 'ACCESS_DENIED',
      details: { reason: 'region-not-allowed', region: 'us-central1' },
    });
    await updateOffer(world, { allowedRegions: ['eu-west1', 'us-central1'] });
    expect((await createVm(world, 'vm-us')).poolId).toBe(world.poolId);
  });

  it('reservations are refused in other regions and while suspended', async () => {
    const world = await gceWorld();
    const reserve = (key: string) =>
      world.api.reservations.create(world.acme, {
        tenantId: world.acmeTenant,
        poolId: world.poolId,
        devices: [{ class: 'gpu', count: 1 }],
        duration: '1h',
        idempotencyKey: key,
      });
    await updateOffer(world, { allowedRegions: ['eu-west1'] });
    await expect(reserve('r-eu')).rejects.toMatchObject({
      code: 'ACCESS_DENIED',
      details: { reason: 'region-not-allowed' },
    });
    await updateOffer(world, { allowedRegions: ['us-central1'], suspended: true });
    await expect(reserve('r-suspended')).rejects.toMatchObject({
      code: 'SPEND_LIMIT_REACHED',
      details: { reason: 'offer-suspended' },
    });
    await updateOffer(world, { suspended: false });
    // Past the offer's own refusals the request reaches the pool (a provider pool books no devices).
    expect(await code(reserve('r-ok'))).not.toMatch(/^(ACCESS_DENIED|SPEND_LIMIT_REACHED)$/);
  });

  it('an iamRegion on the site is the region that counts', async () => {
    const world = await gceWorld();
    await world.fixture.database.query(`UPDATE sites SET iam_region = 'eu-west1'`);
    await updateOffer(world, { allowedRegions: ['us-central1'] });
    expect(await code(createVm(world, 'vm-1'))).toBe('ACCESS_DENIED');
    await updateOffer(world, { allowedRegions: ['eu-west1'] });
    expect((await createVm(world, 'vm-2')).poolId).toBe(world.poolId);
  });
});
