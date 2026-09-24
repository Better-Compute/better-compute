import { afterEach, describe, expect, it } from 'vitest';
import { isComputeError, type SqlTx } from '@better-compute/core';
import { closeFixtures, computeFixture } from '@better-compute/testing';

// The authz projection writer (PLAN.md §12.4): `authz_projection` rows in the caller's transaction
// and one `authz_changes` row per actual change, tailed by the IAM bridge's resolver.

afterEach(closeFixtures);

async function changes(sql: SqlTx) {
  const { rows } = await sql.query<{ type: string; id: string; tenant_id: string; op: string }>(
    'SELECT type, id, tenant_id, op FROM authz_changes ORDER BY txid, seq',
  );
  return rows.map((row) => `${row.op} ${row.type}/${row.id}@${row.tenant_id}`);
}

const pool = (tenantId: string, attributes: Record<string, string | number | boolean> = {}) => ({
  type: 'pool',
  id: 'pool_h100',
  tenantId,
  attributes: { region: 'eu-1', gpuModel: 'H100', ...attributes },
});

describe('AuthzWriter', () => {
  it('upserts rows and feeds only real changes', async () => {
    const fixture = await computeFixture();
    const { compute, database } = fixture;
    const { authz, sql } = compute.context;
    const root = fixture.tenants.root.id;
    const acme = fixture.tenants.acme.id;
    await sql.transaction(async (tx) => {
      await authz.upsert(tx, pool(root));
      await authz.upsert(tx, pool(acme));
    });
    await sql.transaction((tx) => authz.upsert(tx, pool(acme))); // unchanged: no feed row
    await sql.transaction((tx) =>
      authz.upsert(tx, { ...pool(acme, { sharing: 'exclusive' }), ownerId: 'id-1' }),
    );
    expect(await changes(database)).toEqual([
      `upsert pool/pool_h100@${root}`,
      `upsert pool/pool_h100@${acme}`,
      `upsert pool/pool_h100@${acme}`,
    ]);
    expect(await compute.authz.get('compute-pool', 'pool_h100', acme)).toEqual({
      type: 'pool',
      id: 'pool_h100',
      tenantId: acme,
      attributes: { region: 'eu-1', gpuModel: 'H100', sharing: 'exclusive' },
      ownerId: 'id-1',
    });
    expect(
      await compute.authz.get('compute-pool', 'pool_h100', fixture.tenants.other.id),
    ).toBeUndefined();
  });

  it('holds pending extend values apart and clears them', async () => {
    const fixture = await computeFixture();
    const { compute, database } = fixture;
    const { authz, sql } = compute.context;
    const acme = fixture.tenants.acme.id;
    const ref = { type: 'reservation', id: 'rsv_1', tenantId: acme };
    await sql.transaction((tx) =>
      authz.upsert(tx, {
        ...ref,
        attributes: { durationHours: 8, gpuCount: 4 },
        parentType: 'pool',
        parentId: 'pool_h100',
        ownerId: 'identity-acme',
      }),
    );
    await sql.transaction((tx) => authz.setPending(tx, ref, { durationHours: 24 }));
    expect(await compute.authz.get('reservation', 'rsv_1', acme)).toMatchObject({
      attributes: { durationHours: 8, gpuCount: 4 },
      pending: { durationHours: 24 },
      parentType: 'pool',
      parentId: 'pool_h100',
    });
    await sql.transaction((tx) => authz.setPending(tx, ref, null));
    expect((await compute.authz.get('reservation', 'rsv_1', acme))?.pending).toBeUndefined();
    expect(await changes(database)).toHaveLength(3);
    await expect(
      sql.transaction((tx) =>
        authz.setPending(tx, { ...ref, id: 'rsv_missing' }, { durationHours: 1 }),
      ),
    ).rejects.toSatisfy((error: unknown) => isComputeError(error, 'NOT_FOUND'));
  });

  it('removes one view or every view, with a delete in the feed for each', async () => {
    const fixture = await computeFixture();
    const { compute, database } = fixture;
    const { authz, sql } = compute.context;
    const [root, acme, other] = [
      fixture.tenants.root.id,
      fixture.tenants.acme.id,
      fixture.tenants.other.id,
    ];
    await sql.transaction(async (tx) => {
      for (const tenant of [root, acme, other]) await authz.upsert(tx, pool(tenant));
    });
    await sql.transaction((tx) =>
      authz.remove(tx, { type: 'pool', id: 'pool_h100', tenantId: other }),
    );
    expect(await compute.authz.get('pool', 'pool_h100', other)).toBeUndefined();
    await sql.transaction((tx) => authz.remove(tx, { type: 'pool', id: 'pool_h100' }));
    const left = await database.query('SELECT 1 FROM authz_projection');
    expect(left.rowCount).toBe(0);
    const feed = await changes(database);
    expect(feed.slice(3, 4)).toEqual([`delete pool/pool_h100@${other}`]);
    expect(feed.slice(4).sort()).toEqual(
      [`delete pool/pool_h100@${acme}`, `delete pool/pool_h100@${root}`].sort(),
    );
    // Removing what is not there writes nothing.
    await sql.transaction((tx) => authz.remove(tx, { type: 'pool', id: 'pool_h100' }));
    expect(await changes(database)).toHaveLength(6);
  });

  it('rolls back with the domain change', async () => {
    const fixture = await computeFixture();
    const { compute, database } = fixture;
    await expect(
      compute.context.sql.transaction(async (tx) => {
        await compute.context.authz.upsert(tx, pool(fixture.tenants.acme.id));
        throw new Error('placement failed');
      }),
    ).rejects.toThrow('placement failed');
    expect(await changes(database)).toEqual([]);
  });

  it('refuses attributes IAM cannot read', async () => {
    const fixture = await computeFixture();
    const { authz } = fixture.compute.context;
    const acme = fixture.tenants.acme.id;
    for (const row of [
      { ...pool(acme), attributes: { nested: { a: 1 } } as never },
      { ...pool(acme), attributes: { n: Number.POSITIVE_INFINITY } },
      {
        ...pool(acme),
        attributes: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`a${i}`, i])),
      },
      { ...pool(acme), type: '' },
      { ...pool(acme), tenantId: '' },
      { ...pool(acme), ownerId: 5 as never },
    ])
      await expect(authz.upsert(fixture.database, row)).rejects.toSatisfy((error: unknown) =>
        isComputeError(error, 'INVALID_INPUT'),
      );
  });
});
