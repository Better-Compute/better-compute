import { afterEach, describe, expect, it } from 'vitest';
import { ComputeError } from '@better-compute/core';
import { closeFixtures } from '@better-compute/testing';
import { lostMachineWindowMs } from '@better-compute/vps';
import { gceWorld, type GceWorld } from './support/vps-gce.js';

// A provider create runs outside any transaction, and its answer can be lost: a timeout after the provider
// accepted, or a delete that changed the row while the call was in flight. The row then has no machine id
// while the provider holds a machine. Deleting such an instance used to finish at once (no id, nothing to
// delete) and refund its quota, leaving the machine running, unbilled and unknown.

afterEach(closeFixtures);

const create = (w: GceWorld, key = 'vm-1') =>
  w.api.instances.create(w.acme, {
    tenantId: w.acmeTenant,
    poolId: w.poolId,
    flavor: 'a2.highgpu.1g',
    imageId: 'debian-12',
    idempotencyKey: key,
  });

async function step(w: GceWorld, ms = 1_000): Promise<void> {
  await w.fixture.advance(ms);
  await w.tick('vps.instances', 1);
}

const stateOf = async (w: GceWorld, instanceId: string) => {
  const { rows } = await w.fixture.database.query<{ state: string; external_id: string | null }>(
    `SELECT state, external_id FROM instances WHERE id = $1`,
    [instanceId],
  );
  return rows[0]!;
};

const quotaUsed = async (w: GceWorld) => {
  const { rows } = await w.fixture.database.query<{ used: string }>(
    `SELECT used FROM quota_usage WHERE tenant_id = $1 AND pool_id = $2 AND resource = 'vcpu'`,
    [w.acmeTenant, w.poolId],
  );
  return Number(rows[0]?.used ?? 0);
};

describe('deleting an instance whose create was never answered', () => {
  it('finds the machine the provider made and deletes it before finishing', async () => {
    const w = await gceWorld();
    const instance = await create(w);
    // The provider makes the machine, and the answer never arrives.
    w.cloud.failAfterCreate = new ComputeError('UNAVAILABLE', 'timeout');
    await step(w);
    expect(w.cloud.machines.size).toBe(1);
    expect(await stateOf(w, instance.id)).toMatchObject({ state: 'scheduling', external_id: null });

    await w.api.instances.delete(w.acme, { tenantId: w.acmeTenant, instanceId: instance.id });
    await step(w);
    // The search found it by its ownership label: the row has its id, and the delete follows.
    for (let round = 0; round < 3 && w.cloud.machines.size > 0; round++) await step(w);
    expect(w.cloud.machines.size).toBe(0);
    expect(w.cloud.requests.filter((request) => request.startsWith('delete '))).toHaveLength(1);
    for (let round = 0; round < 3 && (await stateOf(w, instance.id)).state !== 'deleted'; round++) await step(w);
    expect((await stateOf(w, instance.id)).state).toBe('deleted');
    expect(await quotaUsed(w)).toBe(0);
  });

  it('keeps the id of a machine whose create finished after the instance was deleted', async () => {
    const w = await gceWorld();
    const instance = await create(w);
    // The delete lands while the provider is still answering the create: the row's version moves on,
    // so the create's result is not applied. The machine's id is kept all the same.
    w.cloud.onCreate = async () => {
      await w.api.instances.delete(w.acme, { tenantId: w.acmeTenant, instanceId: instance.id });
    };
    await step(w);
    expect(w.cloud.machines.size).toBe(1);
    expect((await stateOf(w, instance.id)).external_id).not.toBeNull();
    for (let round = 0; round < 4 && (await stateOf(w, instance.id)).state !== 'deleted'; round++) await step(w);
    expect(w.cloud.machines.size).toBe(0);
    expect((await stateOf(w, instance.id)).state).toBe('deleted');
    // No search was needed: the id was on the row.
    expect(w.cloud.requests).not.toContain('discover');
    expect(await quotaUsed(w)).toBe(0);
  });

  it('waits out the window a listing may lag in, then finishes when there is no machine', async () => {
    const w = await gceWorld();
    const instance = await create(w);
    // The provider failed before making anything.
    w.cloud.failCreate = new ComputeError('UNAVAILABLE', 'try later');
    await step(w);
    expect(w.cloud.machines.size).toBe(0);
    await w.api.instances.delete(w.acme, { tenantId: w.acmeTenant, instanceId: instance.id });
    await step(w);
    // Nothing found, but a machine made a moment ago might not be listed yet: not finished.
    expect((await stateOf(w, instance.id)).state).toBe('deleting');
    expect(w.cloud.requests).toContain('discover');
    expect(await quotaUsed(w)).toBeGreaterThan(0);
    // Past the window the listing is believed.
    await step(w, lostMachineWindowMs);
    for (let round = 0; round < 3 && (await stateOf(w, instance.id)).state !== 'deleted'; round++) await step(w, 30_000);
    expect((await stateOf(w, instance.id)).state).toBe('deleted');
    expect(await quotaUsed(w)).toBe(0);
  });

  it('asks the provider nothing for an instance that never reached a create', async () => {
    const w = await gceWorld();
    const instance = await create(w);
    await w.api.instances.delete(w.acme, { tenantId: w.acmeTenant, instanceId: instance.id });
    await step(w);
    for (let round = 0; round < 3 && (await stateOf(w, instance.id)).state !== 'deleted'; round++) await step(w);
    expect((await stateOf(w, instance.id)).state).toBe('deleted');
    expect(w.cloud.requests).toEqual([]);
  });

  it('asks nothing for one the provider refused for good', async () => {
    const w = await gceWorld();
    const instance = await create(w);
    w.cloud.failCreate = new ComputeError('CAPACITY_UNAVAILABLE', 'stockout');
    await step(w);
    expect((await stateOf(w, instance.id)).state).toBe('error');
    const before = w.cloud.requests.length;
    await w.api.instances.delete(w.acme, { tenantId: w.acmeTenant, instanceId: instance.id });
    for (let round = 0; round < 3 && (await stateOf(w, instance.id)).state !== 'deleted'; round++) await step(w);
    expect((await stateOf(w, instance.id)).state).toBe('deleted');
    expect(w.cloud.requests.slice(before)).toEqual([]);
  });
});
