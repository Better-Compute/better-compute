import { afterEach, describe, expect, it } from 'vitest';
import { ComputeError, manifest, type SpendCheckInput } from '@better-compute/core';
import { applyBudgetPolicy } from '@better-compute/capacity';
import { installIamHandlers } from '@better-compute/cli';
import type { IamEventHandlers, IamInboxEvent } from '@better-compute/iam';
import { closeFixtures } from '@better-compute/testing';
import { defineProvider, sandboxIamReactions } from '@better-compute/vps';
import { gceVm, gceWorld, type GceWorld } from './support/vps-gce.js';

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

// --- paths: budget checks on the billable paths a tenant or the platform can start (Task 21) ---------------------

const LEGACY = 'us-central1-a/legacy';

/** A provider with tenant networks, so `networks.create` gets past the pool and provider checks. */
const networkProvider = defineProvider({
  id: 'fake-net',
  version: '1.0.0',
  provides: ['vps'],
  config: manifest({}) as never,
  create: () => ({
    async listOffers() {
      return [];
    },
    async create() {
      throw new ComputeError('UNSUPPORTED', 'unused');
    },
    async get() {
      return undefined;
    },
    async delete() {},
    networks: {} as never,
  }),
});

interface Budget {
  /** Every `billingCheck` the control plane made, in order. */
  checks: SpendCheckInput[];
  /** Whether the next checks are allowed. */
  allowed: boolean;
}

/** Replaces the fixture IAM's `billingCheck` with one that records its inputs and can refuse. */
function watchBudget(world: GceWorld): Budget {
  const budget: Budget = { checks: [], allowed: true };
  (world.fixture.iam as unknown as { billingCheck: unknown }).billingCheck = async (
    input: SpendCheckInput,
  ) => {
    budget.checks.push(input);
    return budget.allowed
      ? { allowed: true, budgets: [] }
      : { allowed: false, budgets: [], blockedBy: { budgetId: 'bud_1', name: 'monthly' } };
  };
  return budget;
}

/** acme's offer reacts to a spent budget by stopping new work, so its admissions check the budget. */
const stopNew = (world: GceWorld, poolId = world.poolId) =>
  world.api.pools.updateOffer(world.root, {
    tenantId: world.rootTenant,
    poolId,
    toTenantId: world.acmeTenant,
    onBudgetExceeded: 'stop-new',
  });

async function legacyWorld(): Promise<GceWorld> {
  const world = await gceWorld({
    discovery: { every: '1m' },
    quota: { vcpu: 1024, memoryGiB: 8192, diskGiB: 2000, gpu: 64 },
    providers: [networkProvider],
  });
  world.cloud.machines.set(LEGACY, gceVm('legacy'));
  await world.discover(0);
  return world;
}

const attach = (world: GceWorld, extra: Record<string, unknown> = {}) =>
  world.api.instances.attach(world.root, {
    tenantId: world.acmeTenant,
    poolId: world.poolId,
    externalId: LEGACY,
    ownerIdentityId: world.fixture.tenants.acme.caller.identityId,
    idempotencyKey: 'attach-legacy',
    ...extra,
  });

/** A root-owned pool on a provider account that has networks, offered to acme. */
async function networkPool(world: GceWorld): Promise<string> {
  const account = await world.api.providerAccounts.create(world.root, {
    tenantId: world.rootTenant,
    provider: 'fake-net',
    name: 'net-main',
    config: {},
  });
  const { rows } = await world.fixture.database.query<{ site_id: string }>(
    `SELECT site_id FROM pools WHERE id = $1`,
    [world.poolId],
  );
  const pool = await world.api.pools.create(world.root, {
    tenantId: world.rootTenant,
    siteId: rows[0]!.site_id,
    class: 'provider',
    providerAccountId: account.id,
    idempotencyKey: 'net-pool',
  });
  await world.api.pools.offer(world.root, {
    tenantId: world.rootTenant,
    poolId: pool.id,
    toTenantId: world.acmeTenant,
    quota: { vcpu: 8 },
  });
  return pool.id;
}

const createNetwork = (
  world: GceWorld,
  poolId: string,
  key: string,
  who = world.acme,
  tenantId = world.acmeTenant,
) =>
  world.api.networks.create(who, {
    tenantId,
    poolId,
    name: `net-${key}`,
    idempotencyKey: key,
  });

/** The platform sets a pool's billing mode (root-only policy knob). */
const billingMode = async (world: GceWorld, poolId: string, mode: string) => {
  const { rows } = await world.fixture.database.query<{ policy: object }>(
    `SELECT policy FROM pools WHERE id = $1`,
    [poolId],
  );
  await world.api.pools.update(world.root, {
    tenantId: world.rootTenant,
    poolId,
    policy: { ...rows[0]!.policy, billing: { mode } },
  });
};

describe('paths', () => {
  it('attach is refused over budget', async () => {
    const world = await legacyWorld();
    await stopNew(world);
    const budget = watchBudget(world);
    budget.allowed = false;
    await expect(attach(world)).rejects.toMatchObject({
      code: 'SPEND_LIMIT_REACHED',
      details: { budgetId: 'bud_1', name: 'monthly' },
    });
    // Nothing was attached, and the machine is still free.
    const { rows } = await world.fixture.database.query(
      `SELECT 1 FROM instances WHERE origin = 'attached'`,
    );
    expect(rows).toEqual([]);
    // Once the budget's window resets the same key goes through.
    budget.allowed = true;
    expect((await attach(world)).origin).toBe('attached');
    expect(budget.checks).toHaveLength(2);
  });

  it('attach with billing none is not budget-checked', async () => {
    const world = await legacyWorld();
    await stopNew(world);
    const budget = watchBudget(world);
    budget.allowed = false;
    // The platform's own write-off, and a pool whose explicit mode is none.
    expect((await attach(world, { billing: 'none' })).origin).toBe('attached');
    expect(budget.checks).toEqual([]);
    world.cloud.machines.set('us-central1-a/second', gceVm('second'));
    await world.discover();
    await billingMode(world, world.poolId, 'none');
    expect(
      (await attach(world, { externalId: 'us-central1-a/second', idempotencyKey: 'attach-2' }))
        .origin,
    ).toBe('attached');
    expect(budget.checks).toEqual([]);
    // platform-fee is billed too.
    world.cloud.machines.set('us-central1-a/third', gceVm('third'));
    await world.discover();
    await billingMode(world, world.poolId, 'platform-fee');
    await expect(
      attach(world, { externalId: 'us-central1-a/third', idempotencyKey: 'attach-3' }),
    ).rejects.toMatchObject({ code: 'SPEND_LIMIT_REACHED' });
    expect(budget.checks).toHaveLength(1);
  });

  it('networks.create is refused over budget', async () => {
    const world = await legacyWorld();
    const poolId = await networkPool(world);
    await stopNew(world, poolId);
    const budget = watchBudget(world);
    budget.allowed = false;
    await expect(createNetwork(world, poolId, 'n1')).rejects.toMatchObject({
      code: 'SPEND_LIMIT_REACHED',
      details: { budgetId: 'bud_1' },
    });
    expect(budget.checks).toEqual([
      { tenantId: world.acmeTenant, identityId: world.fixture.tenants.acme.caller.identityId },
    ]);
    // Only a metered pool is checked: an unbilled pool creates its networks.
    await billingMode(world, poolId, 'none');
    budget.checks.length = 0;
    expect((await createNetwork(world, poolId, 'n1')).name).toBe('net-n1');
    expect(budget.checks).toEqual([]);
  });

  it("a root-issued create checks the target tenant's budget", async () => {
    const world = await legacyWorld();
    const poolId = await networkPool(world);
    await stopNew(world, poolId);
    await stopNew(world);
    const budget = watchBudget(world);
    budget.allowed = false;

    // The platform issues into acme: acme's budget is asked, with no identity (root's is not acme's).
    await expect(
      createNetwork(world, poolId, 'n-root', world.root, world.acmeTenant),
    ).rejects.toMatchObject({ code: 'SPEND_LIMIT_REACHED' });
    await expect(attach(world)).rejects.toMatchObject({ code: 'SPEND_LIMIT_REACHED' });
    await expect(
      world.api.instances.create(world.root, {
        tenantId: world.acmeTenant,
        poolId: world.poolId,
        flavor: 'a2.highgpu.1g',
        imageId: 'debian-12',
        ownerIdentityId: world.fixture.tenants.acme.caller.identityId,
        idempotencyKey: 'root-vm',
      }),
    ).rejects.toMatchObject({ code: 'SPEND_LIMIT_REACHED' });
    expect(budget.checks).toEqual([
      { tenantId: world.acmeTenant },
      { tenantId: world.acmeTenant },
      { tenantId: world.acmeTenant },
    ]);

    // Root's own budget is never what gates it: acme in budget, the platform's create goes through.
    budget.allowed = true;
    budget.checks.length = 0;
    expect((await createNetwork(world, poolId, 'n-root', world.root, world.acmeTenant)).name).toBe(
      'net-n-root',
    );
    expect(budget.checks).toEqual([{ tenantId: world.acmeTenant }]);
  });
});

// --- sweep: suspension stops spend with no host reaction wired (fix round 1, ruling F20-1) -----------------------

/** The budget alert of better-iam's inbox, as the bridge delivers it. */
const budgetEvent = (tenantId: string): IamInboxEvent => ({
  eventId: 'e-budget',
  tenantId,
  sequence: 1,
  occurredAt: 0,
  action: 'billing:budget-alert',
  subjectId: 'billing/budgets/bud_1',
  metadata: { kind: 'actual', threshold: 100, name: 'monthly', spentMicros: 21, amountMicros: 20 },
  reactions: ['budget'],
});

/** capacity's policy alone: what a deployment without vps's `iamReactions` runs on a spent budget. */
async function overspendBare(world: GceWorld) {
  const context = world.fixture.compute.context;
  return context.sql.transaction(async (tx) =>
    applyBudgetPolicy(tx as never, context, alertFor(world)),
  );
}

/** One `vps.suspension` pass a minute on. */
async function sweep(world: GceWorld) {
  await world.fixture.advance(60_000);
  await world.tick('vps.suspension', 1);
}

describe('sweep', () => {
  it('with no host reactions wired, a suspended offer stops its running instances on the next sweep tick', async () => {
    const world = await gceWorld();
    await updateOffer(world, { onBudgetExceeded: 'suspend' });
    const vm = await runningVm(world);
    await overspendBare(world);
    // Suspended at once, but nothing stopped yet: no reaction, no sweep.
    expect((await offerRow(world)).suspended_at).not.toBeNull();
    expect((await viewOf(world, vm.id)).desiredState).toBe('running');

    await sweep(world);
    const after = await viewOf(world, vm.id);
    expect(after.desiredState).toBe('stopped');
    expect(after.conditions).toContainEqual(
      expect.objectContaining({ type: 'BudgetSuspended', status: 'true' }),
    );
    await settle(world, 4, 30_000);
    expect((await viewOf(world, vm.id)).state).toBe('stopped');
    expect([...world.cloud.machines.values()].some((machine) => machine.state === 'running')).toBe(
      false,
    );

    // A hand suspension is swept too; lifting restarts nothing, and later passes leave it stopped.
    const second = await runningVm(world, 'vm-2').catch(() => undefined);
    expect(second).toBeUndefined(); // creates are refused while suspended
    await updateOffer(world, { suspended: false });
    await sweep(world);
    expect((await viewOf(world, vm.id)).desiredState).toBe('stopped');
    const third = await runningVm(world, 'vm-3');
    await updateOffer(world, { suspended: true });
    await sweep(world);
    expect((await viewOf(world, third.id)).desiredState).toBe('stopped');
    await updateOffer(world, { suspended: false });
    await sweep(world);
    await settle(world, 3, 30_000);
    expect((await viewOf(world, third.id)).state).toBe('stopped');
    expect([...world.cloud.machines.values()].some((machine) => machine.state === 'running')).toBe(
      false,
    );
  });

  it('a stop that failed is retried on the next tick', async () => {
    const world = await legacyWorld();
    const instance = await attach(world);
    await updateOffer(world, { suspended: true });
    // An attached instance that lost its machine cannot be stopped: the pass skips it.
    await world.fixture.database.query(
      `UPDATE instances SET conditions = '[{"type":"OwnershipLost","status":"true","since":0}]'::jsonb WHERE id = $1`,
      [instance.id],
    );
    await sweep(world);
    expect(
      (
        await world.fixture.database.query(`SELECT desired_state FROM instances WHERE id = $1`, [
          instance.id,
        ])
      ).rows,
    ).toEqual([{ desired_state: 'running' }]);
    // Fixed: the next tick stops it.
    await world.fixture.database.query(
      `UPDATE instances SET conditions = '[]'::jsonb WHERE id = $1`,
      [instance.id],
    );
    await sweep(world);
    const { rows } = await world.fixture.database.query<{
      desired_state: string;
      conditions: { type: string }[];
    }>(`SELECT desired_state, conditions FROM instances WHERE id = $1`, [instance.id]);
    expect(rows[0]!.desired_state).toBe('stopped');
    expect(rows[0]!.conditions.map((condition) => condition.type)).toContain('BudgetSuspended');
  });

  it('a budget inbox event through the host handlers stops them at once (the accelerator)', async () => {
    const world = await gceWorld();
    await updateOffer(world, { onBudgetExceeded: 'suspend' });
    const vm = await runningVm(world);
    let installed: IamEventHandlers = {};
    installIamHandlers(world.fixture.compute as never, {
      bridge: { setHandlers: (handlers) => (installed = handlers) },
      reactions: [sandboxIamReactions],
    });
    const context = world.fixture.compute.context;
    await context.sql.transaction((tx) =>
      installed.budget!(tx as never, budgetEvent(world.acmeTenant)),
    );
    expect((await offerRow(world)).suspended_at).not.toBeNull();
    const after = await viewOf(world, vm.id);
    expect(after.desiredState).toBe('stopped');
    expect(after.conditions).toContainEqual(expect.objectContaining({ type: 'BudgetSuspended' }));
    expect(await world.events('quota.budget-suspended')).toHaveLength(1);
  });
});
