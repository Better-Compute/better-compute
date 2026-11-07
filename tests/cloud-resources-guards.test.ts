import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeFixtures } from '@better-compute/testing';
import { liveCloudResources } from '@better-compute/vps';
import { cloudResourcesWorld, type CloudResourcesWorld } from './support/cloud-resources-world.js';
import { memorySecrets } from './support/memory-secrets.js';

// What vps refuses to delete from under a live cloud resource: the provider account it lives on (its pool can be
// archived first) and a tenant network it joined. Without these the resources could never be deleted (the account
// gone) and would bill on, or the provider would refuse to delete a VPC with a database in it.

let world: CloudResourcesWorld;

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => ({ code: 'resolved', message: '', details: undefined as any }),
    (error: { code?: string; message?: string; details?: any }) => ({
      code: error.code,
      message: error.message ?? '',
      details: error.details,
    }),
  );
const stateOf = async (resourceId: string) =>
  (
    await world.fixture.database.query<{ state: string }>(
      `SELECT state FROM cloud_resources WHERE id = $1`,
      [resourceId],
    )
  ).rows[0]!.state;
const remove = (resourceId: string) =>
  world.api.cloudResources.delete(world.acme, { tenantId: world.acmeTenant, resourceId });

beforeAll(async () => {
  world = await cloudResourcesWorld({ secrets: memorySecrets() });
});
afterAll(closeFixtures);

describe('vps deletes nothing a live cloud resource uses', () => {
  it('a tenant network a resource joined cannot be deleted until the resource is gone', async () => {
    const networkId = 'net_dddddddddddddddddddddddddd';
    await world.fixture.database.query(`SET session_replication_role = replica`);
    try {
      await world.fixture.database.query(
        `INSERT INTO networks (id, tenant_id, pool_id, provider_account_id, name, state, desired_state,
                               created_by, idempotency_key, request_hash, version)
         VALUES ($1, $2, $3, $4, 'guard-net', 'ready', 'present', 'idn_x', $1, '\\x00'::bytea, 1)`,
        [networkId, world.acmeTenant, world.poolId, world.accountId],
      );
    } finally {
      await world.fixture.database.query(`SET session_replication_role = DEFAULT`);
    }
    const created = await world.api.cloudResources.create(world.acme, {
      tenantId: world.acmeTenant,
      poolId: world.poolId,
      kind: 'fake.database',
      name: 'in-network',
      spec: { region: 'nyc3', engine: 'pg', version: '16', size: 'small', tenantNetwork: networkId },
      idempotencyKey: 'in-network',
    });
    // The networks a spec names are kept on the row, for vps to see without knowing the kind.
    const stored = await world.fixture.database.query<{ network_ids: string[] }>(
      `SELECT network_ids FROM cloud_resources WHERE id = $1`,
      [created.id],
    );
    expect(stored.rows[0]!.network_ids).toEqual([networkId]);
    expect(
      await liveCloudResources(world.fixture.database as never, 'network_id', networkId),
    ).toEqual([created.id]);
    const blocked = await failure(
      world.api.networks.delete(world.acme, { tenantId: world.acmeTenant, networkId }),
    );
    expect(blocked).toMatchObject({
      code: 'INVALID_STATE',
      details: { resourceIds: [created.id] },
    });
    expect(blocked.message).toMatch(/cloud resource/);
    await remove(created.id);
    await world.until(async () => (await stateOf(created.id)) === 'deleted');
    expect(
      await liveCloudResources(world.fixture.database as never, 'network_id', networkId),
    ).toEqual([]);
    expect(
      (await failure(world.api.networks.delete(world.acme, { tenantId: world.acmeTenant, networkId })))
        .code,
    ).toBe('resolved');
  });

  it('an account whose pool was archived with a resource still on it cannot be deleted until it is gone', async () => {
    const created = await world.api.cloudResources.create(world.acme, {
      tenantId: world.acmeTenant,
      poolId: world.acmePoolId,
      kind: 'fake.app',
      name: 'on-own-account',
      spec: { image: 'nginx' },
      idempotencyKey: 'on-own-account',
    });
    await world.until(async () => (await stateOf(created.id)) === 'ready');
    await world.api.pools.archive(world.acme, {
      tenantId: world.acmeTenant,
      poolId: world.acmePoolId,
    });
    const deleteAccount = () =>
      failure(
        world.api.providerAccounts.delete(world.acme, {
          tenantId: world.acmeTenant,
          accountId: world.acmeAccountId,
        }),
      );
    const blocked = await deleteAccount();
    expect(blocked).toMatchObject({
      code: 'INVALID_STATE',
      details: { resourceIds: [created.id] },
    });
    expect(blocked.message).toMatch(/cloud resource/);
    await remove(created.id);
    await world.until(async () => (await stateOf(created.id)) === 'deleted');
    expect((await deleteAccount()).code).toBe('resolved');
  });
});
