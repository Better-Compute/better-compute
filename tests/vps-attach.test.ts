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

describe('lifecycle of attached instances', () => {
  /** One reconciler step after `ms` of sim time. */
  const step = async (world: GceWorld, ms = 1_000) => {
    await world.fixture.advance(ms);
    await world.tick('vps.instances', 1);
  };
  const view = (world: GceWorld, instanceId: string) =>
    world.api.instances.get(world.acme, { tenantId: world.acmeTenant, instanceId });
  const vm = (world: GceWorld) => world.cloud.machines.get(LEGACY);
  const asAcme = (world: GceWorld) => ({ tenantId: world.acmeTenant });

  it('claims the VM label on first reconcile', async () => {
    const world = await legacyWorld();
    const instance = await world.api.instances.attach(world.root, attachInput(world));
    await step(world);
    expect(vm(world)!.labels).toEqual({ [instanceLabel]: instance.id });
    expect(await view(world, instance.id)).toMatchObject({
      state: 'running',
      addresses: ['10.128.0.2'],
    });
    expect(world.cloud.requests).toContain(`claim ${LEGACY} ${instance.id}`);
    expect(world.cloud.requests.some((request) => request.startsWith('create'))).toBe(false);
    // Steady: later passes read, they do not claim again.
    await step(world, 60_000);
    expect(world.cloud.requests.filter((request) => request.startsWith('claim'))).toHaveLength(1);
  });

  it('adopts a stopped VM as stopped', async () => {
    const world = await gceWorld({ discovery: { every: '1m' } });
    world.cloud.machines.set(LEGACY, gceVm('legacy', { state: 'stopped' }));
    await world.discover(0);
    const instance = await world.api.instances.attach(world.root, attachInput(world));
    expect(instance.desiredState).toBe('stopped');
    await step(world);
    expect(await view(world, instance.id)).toMatchObject({ state: 'stopped' });
    expect(world.cloud.requests.some((request) => request.startsWith('power'))).toBe(false);
  });

  it('delete of an attached instance detaches by default', async () => {
    const world = await legacyWorld();
    const instance = await world.api.instances.attach(world.root, attachInput(world));
    await step(world);
    await world.api.instances.delete(world.acme, { ...asAcme(world), instanceId: instance.id });
    await step(world);
    expect(vm(world)).toMatchObject({ state: 'running', labels: {} });
    expect(world.cloud.requests.some((request) => request.startsWith('delete'))).toBe(false);
    expect(world.cloud.requests).toContain(`release ${LEGACY} ${instance.id}`);
    expect(await view(world, instance.id)).toMatchObject({ state: 'deleted' });
    expect((await world.events('instance.detached')).map((event) => event.data)).toMatchObject([
      { externalId: LEGACY },
    ]);
    expect(await world.events('instance.deleted')).toEqual([]);
    expect(await quotaUsed(world, 'gpu')).toBe(0);
    expect(await quotaUsed(world, 'vcpu')).toBe(0);
    expect(await machineLink(world)).toBeNull();
    // The machine is free: it can be attached again (to a new instance).
    await world.discover();
    const again = await world.api.instances.attach(
      world.root,
      attachInput(world, { idempotencyKey: 'attach-legacy-2' }),
    );
    expect(again.id).not.toBe(instance.id);
  });

  it("onDelete:'delete' deletes the VM", async () => {
    const world = await legacyWorld();
    const instance = await world.api.instances.attach(
      world.root,
      attachInput(world, { onDelete: 'delete' }),
    );
    await step(world);
    await world.api.instances.delete(world.acme, { ...asAcme(world), instanceId: instance.id });
    await step(world);
    expect(vm(world)).toBeUndefined();
    const tail = world.cloud.requests.slice(-2);
    expect(tail).toEqual([`claim ${LEGACY} ${instance.id} managed`, `delete ${LEGACY}`]);
    expect(await view(world, instance.id)).toMatchObject({ state: 'deleted' });
    expect(await world.events('instance.deleted')).toHaveLength(1);
    expect(await quotaUsed(world, 'gpu')).toBe(0);
  });

  it('an attached instance whose VM vanished goes lost, never recreated', async () => {
    const world = await legacyWorld();
    const instance = await world.api.instances.attach(world.root, attachInput(world));
    await step(world);
    world.cloud.machines.delete(LEGACY);
    await step(world, 60_000);
    await step(world, 60_000);
    expect(await view(world, instance.id)).toMatchObject({ state: 'lost' });
    expect(world.cloud.requests.some((request) => request.startsWith('create'))).toBe(false);
    // Discovery marking it gone wakes the instance; it stays lost.
    await world.discover();
    await step(world);
    expect(await view(world, instance.id)).toMatchObject({ state: 'lost' });
    expect(world.cloud.requests.some((request) => request.startsWith('create'))).toBe(false);
  });

  it('start/stop on an attached instance call the provider', async () => {
    const world = await legacyWorld();
    const instance = await world.api.instances.attach(world.root, attachInput(world));
    await step(world);
    const ref = { ...asAcme(world), instanceId: instance.id };
    await world.api.instances.stop(world.acme, ref);
    await step(world);
    expect(world.cloud.requests).toContain(`power ${LEGACY} graceful-off`);
    expect(await view(world, instance.id)).toMatchObject({ state: 'stopped' });
    expect(vm(world)!.state).toBe('stopped');
    await world.api.instances.start(world.acme, ref);
    await step(world);
    expect(world.cloud.requests).toContain(`power ${LEGACY} on`);
    expect(await view(world, instance.id)).toMatchObject({ state: 'running' });
  });

  it('detach refuses a created instance', async () => {
    const world = await legacyWorld();
    const created = await world.api.instances.create(world.acme, {
      ...asAcme(world),
      poolId: world.poolId,
      flavor: 'a2.highgpu.1g',
      imageId: 'debian-12',
      idempotencyKey: 'vm-1',
    });
    expect(
      await code(
        world.api.instances.detach(world.acme, { ...asAcme(world), instanceId: created.id }),
      ),
    ).toBe('INVALID_STATE');
    // An attached one is detached: deleting at once, then deleted with its machine left running.
    const attached = await world.api.instances.attach(
      world.root,
      attachInput(world, { onDelete: 'delete' }),
    );
    await step(world);
    const detaching = await world.api.instances.detach(world.acme, {
      ...asAcme(world),
      instanceId: attached.id,
    });
    expect(detaching).toMatchObject({ state: 'deleting', onDelete: 'detach' });
    await step(world);
    expect(await view(world, attached.id)).toMatchObject({ state: 'deleted' });
    expect(vm(world)).toMatchObject({ state: 'running', labels: {} });
    expect(world.cloud.requests).not.toContain(`delete ${LEGACY}`);
  });

  it('claim conflict fails the instance', async () => {
    const world = await legacyWorld();
    const instance = await world.api.instances.attach(world.root, attachInput(world));
    // Labelled for someone else after discovery saw it free, before the claim.
    vm(world)!.labels = { [instanceLabel]: 'inst_other' };
    await step(world);
    const failed = await view(world, instance.id);
    expect(failed.state).toBe('error');
    expect(failed.conditions.map((condition: { type: string }) => condition.type)).toContain(
      'AttachConflict',
    );
    expect(await world.events('instance.failed')).toMatchObject([
      { data: { reason: 'AttachConflict' } },
    ]);
    // Review probe (a): the customer cannot start, stop or reboot it into the foreign machine.
    const ref = { ...asAcme(world), instanceId: instance.id };
    const calls = world.cloud.requests.length;
    for (const method of ['start', 'stop', 'reboot'] as const)
      expect(await code(world.api.instances[method](world.acme, ref)), method).toBe(
        'INVALID_STATE',
      );
    await step(world, 60_000);
    // Deleting it never touches the other instance's machine: finished as a detach, no call.
    await world.api.instances.delete(world.acme, ref);
    await step(world);
    expect(world.cloud.requests.slice(calls)).toEqual([]);
    expect(await world.events('instance.detached')).toHaveLength(1);
    expect(await view(world, instance.id)).toMatchObject({ state: 'deleted' });
    expect(vm(world)).toMatchObject({
      state: 'running',
      labels: { [instanceLabel]: 'inst_other' },
    });
    expect(world.cloud.requests.some((request) => request.startsWith('delete'))).toBe(false);
  });
});

describe('instances.reboot', () => {
  const step = async (world: GceWorld, ms = 1_000) => {
    await world.fixture.advance(ms);
    await world.tick('vps.instances', 1);
  };
  async function runningAttached(world: GceWorld) {
    const instance = await world.api.instances.attach(world.root, attachInput(world));
    await step(world);
    return { tenantId: world.acmeTenant, instanceId: instance.id as string };
  }
  const powers = (world: GceWorld) =>
    world.cloud.requests.filter((request) => request.startsWith('power'));

  it('reboot issues graceful-restart once', async () => {
    const world = await legacyWorld();
    const ref = await runningAttached(world);
    const answer = await world.api.instances.reboot(world.acme, ref);
    expect(answer).toMatchObject({ id: ref.instanceId, state: 'running' });
    await step(world);
    await step(world, 60_000);
    expect(powers(world)).toEqual([`power ${LEGACY} graceful-restart`]);
    const rebooted = await world.events('instance.rebooted');
    expect(rebooted).toMatchObject([{ data: { hard: false } }]);
    expect(await world.api.instances.get(world.acme, ref)).toMatchObject({ state: 'running' });
    // A second reboot is a second restart.
    await world.api.instances.reboot(world.acme, ref);
    await step(world);
    expect(powers(world)).toHaveLength(2);
  });

  it('hard reboot issues reset', async () => {
    const world = await legacyWorld();
    const ref = await runningAttached(world);
    await world.api.instances.reboot(world.acme, { ...ref, hard: true });
    await step(world);
    await step(world, 60_000);
    expect(powers(world)).toEqual([`power ${LEGACY} reset`]);
    expect(await world.events('instance.rebooted')).toMatchObject([{ data: { hard: true } }]);
  });

  it('reboot of a stopped instance is refused', async () => {
    const world = await legacyWorld();
    const ref = await runningAttached(world);
    await world.api.instances.stop(world.acme, ref);
    expect(await code(world.api.instances.reboot(world.acme, ref))).toBe('INVALID_STATE');
    await step(world);
    expect(await code(world.api.instances.reboot(world.acme, ref))).toBe('INVALID_STATE');
    expect(powers(world)).toEqual([`power ${LEGACY} graceful-off`]);
    // Not yet running (still scheduling) is refused the same way.
    const fresh = await world.api.instances.create(world.acme, {
      tenantId: world.acmeTenant,
      poolId: world.poolId,
      flavor: 'a2.highgpu.1g',
      imageId: 'debian-12',
      idempotencyKey: 'vm-1',
    });
    expect(
      await code(
        world.api.instances.reboot(world.acme, {
          tenantId: world.acmeTenant,
          instanceId: fresh.id,
        }),
      ),
    ).toBe('INVALID_STATE');
  });

  it('api surface has the rows', () => {
    for (const [method, action] of [
      ['detach', 'compute:instances:delete'],
      ['reboot', 'compute:instances:update'],
    ] as const)
      expect(
        apiSurface.find((row) => row.group === 'instances' && row.method === method),
      ).toMatchObject({ action, resource: 'instance', kind: 'mutation', phase: 'v1.0' });
  });
});

describe('ownership of attached machines (review fixes)', () => {
  const step = async (world: GceWorld, ms = 1_000) => {
    await world.fixture.advance(ms);
    await world.tick('vps.instances', 1);
  };
  const view = (world: GceWorld, instanceId: string) =>
    world.api.instances.get(world.acme, { tenantId: world.acmeTenant, instanceId });
  const mutating = (requests: string[]) =>
    requests.filter((request) => /^(power|delete|claim|release|create) /.test(request));

  it('refuses a machine discovery saw labelled for another instance', async () => {
    const world = await gceWorld({ discovery: { every: '1m' } });
    world.cloud.machines.set(
      LEGACY,
      gceVm('legacy', { labels: { [instanceLabel]: 'inst_other' } }),
    );
    await world.discover(0);
    await expect(world.api.instances.attach(world.root, attachInput(world))).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { claimedBy: 'inst_other' },
    });
    expect(await quotaUsed(world, 'gpu')).toBe(0);
    expect(await machineLink(world)).toBeNull();
  });

  it('a lost onDelete:delete instance never acquires a same-name stranger', async () => {
    const world = await legacyWorld();
    const instance = await world.api.instances.attach(
      world.root,
      attachInput(world, { onDelete: 'delete' }),
    );
    await step(world);
    const ref = { tenantId: world.acmeTenant, instanceId: instance.id };
    // Deleted out of band, then someone makes a VM with the same zone and name.
    world.cloud.machines.delete(LEGACY);
    await step(world, 60_000);
    expect(await view(world, instance.id)).toMatchObject({ state: 'lost' });
    world.cloud.machines.set(LEGACY, gceVm('legacy'));
    const before = world.cloud.requests.length;
    // Review probe (b): a wake reads the stranger, sees no label of ours, never recovers.
    await world.api.instances.start(world.acme, ref);
    await step(world);
    const lost = await view(world, instance.id);
    expect(lost.state).not.toBe('running');
    expect(lost.conditions.map((condition: { type: string }) => condition.type)).toContain(
      'OwnershipLost',
    );
    expect(await code(world.api.instances.stop(world.acme, ref))).toBe('INVALID_STATE');
    // The delete finishes as a detach: the stranger is neither claimed nor deleted.
    await world.api.instances.delete(world.acme, ref);
    await step(world);
    expect(await view(world, instance.id)).toMatchObject({ state: 'deleted' });
    expect(mutating(world.cloud.requests.slice(before))).toEqual([]);
    expect(world.cloud.machines.get(LEGACY)).toMatchObject({ state: 'running', labels: {} });
    expect(await world.events('instance.detached')).toHaveLength(1);
    expect(await quotaUsed(world, 'gpu')).toBe(0);
  });

  it('a running instance whose label is taken over fails with OwnershipLost and is left alone', async () => {
    const world = await legacyWorld();
    const instance = await world.api.instances.attach(world.root, attachInput(world));
    await step(world);
    world.cloud.machines.get(LEGACY)!.labels = { [instanceLabel]: 'inst_other' };
    await step(world, 60_000);
    const failed = await view(world, instance.id);
    expect(failed).toMatchObject({ state: 'error' });
    expect(failed.conditions).toContainEqual(
      expect.objectContaining({
        type: 'OwnershipLost',
        message: expect.stringContaining('inst_other'),
      }),
    );
    const before = world.cloud.requests.length;
    const ref = { tenantId: world.acmeTenant, instanceId: instance.id };
    expect(await code(world.api.instances.stop(world.acme, ref))).toBe('INVALID_STATE');
    await step(world, 60_000);
    expect(world.cloud.requests.slice(before)).toEqual([]);
  });

  it('a managed delete with the label intact still deletes', async () => {
    const world = await legacyWorld();
    const instance = await world.api.instances.attach(
      world.root,
      attachInput(world, { onDelete: 'delete' }),
    );
    await step(world);
    await world.api.instances.delete(world.acme, {
      tenantId: world.acmeTenant,
      instanceId: instance.id,
    });
    await step(world);
    expect(world.cloud.requests.slice(-3)).toEqual([
      `get ${LEGACY}`,
      `claim ${LEGACY} ${instance.id} managed`,
      `delete ${LEGACY}`,
    ]);
    expect(world.cloud.machines.has(LEGACY)).toBe(false);
  });

  it('a created instance whose provider returns an id held by a live row ends in error/DuplicateMachine', async () => {
    const world = await legacyWorld();
    const attached = await world.api.instances.attach(world.root, attachInput(world));
    await step(world);
    world.cloud.createId = LEGACY;
    const created = await world.api.instances.create(world.acme, {
      tenantId: world.acmeTenant,
      poolId: world.poolId,
      flavor: 'a2.highgpu.1g',
      imageId: 'debian-12',
      idempotencyKey: 'vm-dup',
    });
    await step(world);
    const failed = await view(world, created.id);
    expect(failed.state).toBe('error');
    expect(failed.conditions.map((condition: { type: string }) => condition.type)).toContain(
      'DuplicateMachine',
    );
    // No retry loop, and the live owner is untouched.
    await step(world, 60_000);
    expect(world.cloud.requests.filter((request) => request.startsWith('create'))).toHaveLength(1);
    expect(await view(world, attached.id)).toMatchObject({ state: 'running', externalId: LEGACY });
  });
});

describe('a reused machine id never revives a lost or failed instance (review round 2)', () => {
  const step = async (world: GceWorld, ms = 1_000) => {
    await world.fixture.advance(ms);
    await world.tick('vps.instances', 1);
  };
  const view = (world: GceWorld, instanceId: string) =>
    world.api.instances.get(world.acme, { tenantId: world.acmeTenant, instanceId });
  const create = (world: GceWorld, idempotencyKey: string) =>
    world.api.instances.create(world.acme, {
      tenantId: world.acmeTenant,
      poolId: world.poolId,
      flavor: 'a2.highgpu.1g',
      imageId: 'debian-12',
      idempotencyKey,
    });

  it('a lost instance whose machine id a live instance reuses ends with DuplicateMachine, no loop', async () => {
    const world = await gceWorld({ discovery: { every: '1m' } });
    const a = await create(world, 'vm-a');
    await step(world);
    const machineId = (await view(world, a.id)).externalId as string;
    expect(await view(world, a.id)).toMatchObject({ state: 'running' });
    // A's machine is deleted out of band: A goes lost.
    world.cloud.machines.delete(machineId);
    await step(world, 60_000);
    expect(await view(world, a.id)).toMatchObject({ state: 'lost' });
    // The provider reuses the id for B's machine; B is live on it.
    world.cloud.machines.set(machineId, gceVm('reused', { id: machineId }));
    world.cloud.createId = machineId;
    const b = await create(world, 'vm-b');
    await step(world);
    expect(await view(world, b.id)).toMatchObject({ state: 'running', externalId: machineId });
    // Review probe: waking A reads B's machine. A never revives and the run does not loop.
    const before = world.cloud.requests.length;
    await world.api.instances.start(world.acme, { tenantId: world.acmeTenant, instanceId: a.id });
    await step(world);
    const duplicate = await view(world, a.id);
    expect(duplicate.state).toBe('lost');
    expect(duplicate.conditions).toContainEqual(
      expect.objectContaining({ type: 'DuplicateMachine', message: expect.stringContaining(b.id) }),
    );
    const { rows } = await world.fixture.database.query(
      `SELECT 1 FROM work_queue WHERE kind = 'vps.instances' AND key = $1`,
      [a.id],
    );
    expect(rows).toEqual([]);
    await step(world, 60_000);
    // Deleting A finishes without touching B's machine.
    await world.api.instances.delete(world.acme, { tenantId: world.acmeTenant, instanceId: a.id });
    await step(world);
    expect(await view(world, a.id)).toMatchObject({ state: 'deleted' });
    expect(
      world.cloud.requests
        .slice(before)
        .filter((request) => /^(power|delete|create) /.test(request)),
    ).toEqual([]);
    expect(await view(world, b.id)).toMatchObject({ state: 'running', externalId: machineId });
    expect(world.cloud.machines.has(machineId)).toBe(true);
  });

  it('instances.start on a failed instance whose machine id a live instance holds is CONFLICT', async () => {
    const world = await gceWorld({ discovery: { every: '1m' } });
    const a = await create(world, 'vm-a');
    await step(world);
    const machineId = (await view(world, a.id)).externalId as string;
    world.cloud.machines.get(machineId)!.state = 'error';
    await step(world, 60_000);
    expect(await view(world, a.id)).toMatchObject({ state: 'error' });
    world.cloud.machines.get(machineId)!.state = 'running';
    world.cloud.createId = machineId;
    const b = await create(world, 'vm-b');
    await step(world);
    expect(await view(world, b.id)).toMatchObject({ state: 'running', externalId: machineId });
    await expect(
      world.api.instances.start(world.acme, { tenantId: world.acmeTenant, instanceId: a.id }),
    ).rejects.toMatchObject({ code: 'CONFLICT', details: { instanceId: b.id } });
    expect(await view(world, a.id)).toMatchObject({ state: 'error' });
  });
});
