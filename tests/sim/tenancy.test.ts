import { afterEach, describe, expect, it } from 'vitest';
import { tenantStateHandler, type IamTenantStatus } from '@better-compute/server';
import {
  assertInvariants,
  createControlPlaneSim,
  type ControlPlaneSim,
} from '@better-compute/testing';

// PLAN.md §12.8 on the real control plane and gateways under the fleet simulator: IAM suspends a tenant with
// running reservations (new admissions are refused, running work continues, reads go on), then deletes it (the
// tenancy teardown asks every module; capacity releases its reservations). Billing covers exactly what ran (I8),
// no device is double-booked (I1), and nothing is released by a disconnect (I5).

const MIN = 60_000;

let rig: ControlPlaneSim | undefined;
afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

describe('tenancy under the fleet simulator (§12.8)', () => {
  it('suspends admissions, keeps running work, then tears the deleted tenant down with billing intact', async () => {
    rig = await createControlPlaneSim({ seed: 'tenancy', nodes: 4 });
    const r = rig;
    await r.run(3 * MIN);
    const acmeId = r.tenants.acme.id;
    const acme = { token: r.tenants.acme.token };
    const create = (key: string) =>
      r.api(() =>
        r.compute.api.reservations.create(acme, {
          tenantId: acmeId,
          poolId: r.poolId,
          devices: [{ class: 'gpu', count: 4 }],
          duration: '2h',
          idempotencyKey: key,
        } as never),
      );
    const states = async (ids: readonly string[]) =>
      (
        await r.database.query<{ state: string }>(
          'SELECT state FROM reservations WHERE id = ANY($1::text[]) ORDER BY id',
          [ids],
        )
      ).rows.map((row) => row.state);
    const ids = [(await create('tenancy-1')).id, (await create('tenancy-2')).id];
    for (let waited = 0; waited < 3 * MIN; waited += 5_000) {
      if ((await states(ids)).every((state) => state === 'active')) break;
      await r.run(5_000);
    }
    expect(await states(ids)).toEqual(['active', 'active']);

    // IAM suspends acme. The bridge's handler only queues; the tenancy reconciler (ticked with the others) reads.
    let iamStates: IamTenantStatus[] = [{ tenantId: acmeId, status: 'suspended' }];
    const handler = tenantStateHandler(r.compute, { readTenants: async () => iamStates });
    const deliver = (action: string) =>
      r.compute.context.sql.transaction((tx) =>
        handler(tx, { tenantId: r.tenants.root.id, action, subjectId: acmeId, metadata: {} }),
      );
    await deliver('iam:tenants:update');
    await r.run(5_000);
    await expect(create('tenancy-3')).rejects.toMatchObject({ code: 'TENANT_SUSPENDED' });
    // Running work continues, and acme can still read it.
    await r.run(MIN);
    expect(await states(ids)).toEqual(['active', 'active']);
    expect(
      await r.api(() =>
        r.compute.api.reservations.get(acme, { tenantId: acmeId, reservationId: ids[0]! } as never),
      ),
    ).toMatchObject({ id: ids[0], state: 'active' });

    // IAM deletes acme: refused at once, and the teardown releases its reservations.
    iamStates = [{ tenantId: acmeId, status: 'deleted' }];
    await deliver('iam:tenants:delete');
    await expect(
      r.api(() =>
        r.compute.api.reservations.get(acme, { tenantId: acmeId, reservationId: ids[0]! } as never),
      ),
    ).rejects.toMatchObject({ code: 'TENANT_SUSPENDED' });
    for (let waited = 0; waited < 3 * MIN; waited += 5_000) {
      if ((await states(ids)).every((state) => state === 'released')) break;
      await r.run(5_000);
    }
    expect(await states(ids)).toEqual(['released', 'released']);
    for (let waited = 0; waited < 2 * MIN; waited += 5_000) {
      const { rows } = await r.database.query<{ done: boolean }>(
        'SELECT teardown_done_at IS NOT NULL AS done FROM compute_tenant_states WHERE tenant_id = $1',
        [acmeId],
      );
      if (rows[0]?.done) break;
      await r.run(5_000);
    }
    const tornDown = await r.database.query<{ subject: string }>(
      `SELECT payload->>'subject' AS subject FROM outbox WHERE topic = 'tenant.torn-down'`,
    );
    expect(tornDown.rows).toEqual([{ subject: `tenant/${acmeId}` }]);

    // Two metering periods after the release, billing matches what ran.
    await r.run(11 * MIN);
    assertInvariants(await r.invariants());
  }, 600_000);
});
