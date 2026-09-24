import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IamError } from '@better-iam/core';
import type { AuthzAttributes, SqlExecutor, SqlTx } from '@better-compute/core';
import { pglite } from '@better-compute/postgres/pglite';
import {
  computeResolver,
  createAuthzProjection,
  createComputeIamBridge,
  memoryInbox,
  sqlProjectionSource,
  successorsMigration,
  type ProjectionRow,
  type ProjectionSource,
} from '@better-compute/iam';
import { closeIamFixtures, iamFixture } from './support/iam.js';

// The memory-resident authz projection over authz_projection + authz_changes, and the resolver better-iam
// calls inside its decision transaction (PLAN.md §12.4).

let db: SqlExecutor;

beforeAll(async () => {
  db = pglite();
  await db.migrate([successorsMigration]);
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await db.query('DELETE FROM authz_projection');
  await db.query('DELETE FROM authz_changes');
});
afterEach(closeIamFixtures);

/** What the server's AuthzWriter does: the row and its change, in one transaction. */
async function upsert(tx: SqlTx, row: ProjectionRow): Promise<void> {
  await tx.query(
    `INSERT INTO authz_projection (type, id, tenant_id, attributes, parent_type, parent_id, owner_id, pending)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8::jsonb)
     ON CONFLICT (type, id, tenant_id) DO UPDATE SET attributes = EXCLUDED.attributes,
       parent_type = EXCLUDED.parent_type, parent_id = EXCLUDED.parent_id,
       owner_id = EXCLUDED.owner_id, pending = EXCLUDED.pending`,
    [
      row.type,
      row.id,
      row.tenantId,
      JSON.stringify(row.attributes),
      row.parentType ?? null,
      row.parentId ?? null,
      row.ownerId ?? null,
      row.pending ? JSON.stringify(row.pending) : null,
    ],
  );
  await tx.query(
    `INSERT INTO authz_changes (type, id, tenant_id, op) VALUES ($1, $2, $3, 'upsert')`,
    [row.type, row.id, row.tenantId],
  );
}
async function remove(tx: SqlTx, type: string, id: string, tenantId: string): Promise<void> {
  await tx.query('DELETE FROM authz_projection WHERE type = $1 AND id = $2 AND tenant_id = $3', [
    type,
    id,
    tenantId,
  ]);
  await tx.query(
    `INSERT INTO authz_changes (type, id, tenant_id, op) VALUES ($1, $2, $3, 'delete')`,
    [type, id, tenantId],
  );
}
const write = (fn: (tx: SqlTx) => Promise<void>) => db.transaction(fn);
const pool = (id: string, tenantId: string, attributes: AuthzAttributes = {}): ProjectionRow => ({
  type: 'pool',
  id,
  tenantId,
  attributes,
});

describe('createAuthzProjection over PostgreSQL', () => {
  it('loads every row, then tails committed changes in (txid, seq) order', async () => {
    await write(async (tx) => {
      await upsert(tx, pool('pool-1', 'ten_a', { gpuModel: 'H100' }));
      await upsert(tx, pool('pool-1', 'ten_b', { gpuModel: 'H100' }));
    });
    const projection = createAuthzProjection({ source: sqlProjectionSource(db) });
    expect(projection.ready).toBe(false);
    await projection.load();
    expect(projection.ready).toBe(true);
    expect(projection.size).toBe(2);
    expect(projection.get('pool', 'pool-1', 'ten_a')?.attributes).toEqual({ gpuModel: 'H100' });
    expect(await projection.sync()).toBe(0);

    await write(async (tx) => {
      await upsert(tx, pool('pool-1', 'ten_a', { gpuModel: 'H200' }));
      await upsert(tx, {
        type: 'reservation',
        id: 'rsv-1',
        tenantId: 'ten_a',
        attributes: { gpuCount: 4, durationHours: 24, spot: false },
        parentType: 'pool',
        parentId: 'pool-1',
        ownerId: 'idn_alice',
        pending: { durationHours: 48 },
      });
    });
    await write((tx) => remove(tx, 'pool', 'pool-1', 'ten_b'));
    expect(await projection.sync()).toBe(3);
    expect(projection.get('pool', 'pool-1', 'ten_a')?.attributes).toEqual({ gpuModel: 'H200' });
    expect(projection.get('pool', 'pool-1', 'ten_b')).toBeUndefined();
    expect(projection.get('reservation', 'rsv-1', 'ten_a')).toEqual({
      type: 'reservation',
      id: 'rsv-1',
      tenantId: 'ten_a',
      attributes: { gpuCount: 4, durationHours: 24, spot: false },
      parentType: 'pool',
      parentId: 'pool-1',
      ownerId: 'idn_alice',
      pending: { durationHours: 48 },
    });
    expect(projection.cursor).toMatchObject({ txid: expect.any(String), seq: expect.any(String) });
  });

  it('pages through long change feeds', async () => {
    const projection = createAuthzProjection({ source: sqlProjectionSource(db), batch: 7 });
    await projection.load();
    await write(async (tx) => {
      for (let i = 0; i < 30; i++) await upsert(tx, pool(`pool-${i}`, 'ten_a'));
    });
    expect(await projection.sync()).toBe(30);
    expect(projection.size).toBe(30);
  });

  it('reads a miss once from the store, bounded by the miss timeout', async () => {
    const projection = createAuthzProjection({ source: sqlProjectionSource(db) });
    await projection.load();
    await write((tx) => upsert(tx, pool('draft-pool', 'ten_a', { class: 'metal-host' })));
    // Committed but not yet tailed: the miss path finds it and caches it.
    const outcome = await projection.resolve('pool', 'draft-pool', 'ten_a');
    expect(outcome).toMatchObject({ status: 'hit', row: { attributes: { class: 'metal-host' } } });
    expect(projection.get('pool', 'draft-pool', 'ten_a')).toBeDefined();
    expect(await projection.resolve('pool', 'absent', 'ten_a')).toEqual({ status: 'miss' });

    const slow: ProjectionSource = {
      load: async () => ({ rows: [], cursor: { txid: '0', seq: '0' } }),
      changes: async (cursor) => ({ changed: [], rows: [], cursor }),
      get: () => new Promise(() => {}),
    };
    const stalled = createAuthzProjection({ source: slow, missTimeoutMs: 10 });
    expect(await stalled.resolve('pool', 'x', 't')).toEqual({ status: 'unavailable' });
    await stalled.load();
    expect(await stalled.resolve('pool', 'x', 't')).toEqual({ status: 'timeout' });
    const failing = createAuthzProjection({
      source: { ...slow, get: async () => Promise.reject(new Error('db down')) },
    });
    await failing.load();
    expect(await failing.resolve('pool', 'x', 't')).toEqual({ status: 'timeout' });
  });

  it('removes a resource from every view at once', () => {
    const projection = createAuthzProjection();
    projection.put(pool('p', 'ten_a'));
    projection.put(pool('p', 'ten_b'));
    projection.put(pool('q', 'ten_a'));
    projection.remove('pool', 'p');
    expect(projection.size).toBe(1);
    expect(projection.get('pool', 'q', 'ten_a')).toBeDefined();
    expect(Object.isFrozen(projection.get('pool', 'q', 'ten_a'))).toBe(true);
  });
});

describe('computeResolver', () => {
  const ready = async (...rows: ProjectionRow[]) => {
    const projection = createAuthzProjection({
      source: {
        load: async () => ({ rows, cursor: { txid: '0', seq: '0' } }),
        changes: async (cursor) => ({ changed: [], rows: [], cursor }),
        get: async () => undefined,
      },
    });
    await projection.load();
    return projection;
  };

  it('echoes the reference and exposes attributes, pending values, owner and prefixed parent', async () => {
    const resolve = computeResolver(
      await ready({
        type: 'reservation',
        id: 'rsv-1',
        tenantId: 'ten_a',
        attributes: { gpuModel: 'H100', durationHours: 24 },
        pending: { durationHours: 96 },
        parentType: 'pool',
        parentId: 'pool-1',
        ownerId: 'idn_alice',
      }),
    );
    expect(await resolve({ tenantId: 'ten_a', type: 'compute-reservation', id: 'rsv-1' })).toEqual({
      tenantId: 'ten_a',
      type: 'compute-reservation',
      id: 'rsv-1',
      attributes: {
        gpuModel: 'H100',
        durationHours: 96,
        ownerId: 'idn_alice',
        parentType: 'compute-pool',
        parentId: 'pool-1',
      },
    });
  });

  it('scopes fleet to the root tenant and tenant/{t} to t, and misses as NOT_FOUND', async () => {
    const resolve = computeResolver(await ready(), { rootTenantId: 'ten_root' });
    const code = async (tenantId: string, type: string, id: string) => {
      try {
        await resolve({ tenantId, type, id });
        return 'resolved';
      } catch (error) {
        expect(error).toBeInstanceOf(IamError);
        return `${(error as IamError).code}/${(error as IamError).status}`;
      }
    };
    expect(await code('ten_root', 'compute-fleet', 'global')).toBe('resolved');
    expect(await code('ten_a', 'compute-fleet', 'global')).toBe('NOT_FOUND/404');
    expect(await code('ten_root', 'compute-fleet', 'other')).toBe('NOT_FOUND/404');
    expect(await code('ten_a', 'compute-tenant', 'ten_a')).toBe('resolved');
    expect(await code('ten_a', 'compute-tenant', 'ten_b')).toBe('NOT_FOUND/404');
    expect(await code('ten_a', 'compute-pool', 'absent')).toBe('NOT_FOUND/404');
    expect(await code('ten_a', 'app-doc', 'd1')).toBe('RESOURCE_RESOLVER_REQUIRED/400');
    const unrooted = computeResolver(await ready());
    await expect(
      unrooted({ tenantId: 't', type: 'compute-fleet', id: 'global' }),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  });

  it('reports each lookup to onLookup, and a throwing hook changes nothing', async () => {
    const seen: string[] = [];
    const resolve = computeResolver(await ready(pool('p1', 't')), {
      rootTenantId: 'root',
      onLookup: (result) => {
        seen.push(result);
        throw new Error('broken metrics');
      },
    });
    await resolve({ tenantId: 't', type: 'compute-pool', id: 'p1' });
    await expect(
      resolve({ tenantId: 't', type: 'compute-pool', id: 'nope' }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await resolve({ tenantId: 't', type: 'compute-tenant', id: 't' });
    await expect(resolve({ tenantId: 't', type: 'app-doc', id: 'd' })).rejects.toMatchObject({
      code: 'RESOURCE_RESOLVER_REQUIRED',
    });
    expect(seen).toEqual(['hit', 'miss', 'scope', 'fallback']);
  });

  it('delegates other types to the host fallback, and denies while the projection is not loaded', async () => {
    const resolve = computeResolver(createAuthzProjection(), {
      hostFallback: async (reference) => ({ ...reference, attributes: { app: true } }),
    });
    expect(await resolve({ tenantId: 't', type: 'app-doc', id: 'd1' })).toEqual({
      tenantId: 't',
      type: 'app-doc',
      id: 'd1',
      attributes: { app: true },
    });
    await expect(resolve({ tenantId: 't', type: 'compute-pool', id: 'p' })).rejects.toMatchObject({
      code: 'ACCESS_DENIED',
      status: 403,
    });
  });
});

describe('bridge.resolveResource on better-iam', () => {
  it('decides compute actions from committed projection rows, with pending extends and parent relations', async () => {
    const bridge = createComputeIamBridge();
    const f = await iamFixture({
      plugins: [bridge.plugin({ inbox: memoryInbox() })],
      resolveResource: bridge.resolveResource(),
    });
    bridge.embedded(f.iam, { rootTenantId: f.rootTenantId });
    const alice = await f.member('alice');
    const aliceSession = await f.signIn('alice');
    const reserve = (id: string) =>
      f.iam.authorize({
        ...aliceSession,
        tenantId: f.tenantId,
        action: 'compute:reservations:extend',
        resource: { type: 'compute-reservation', id },
      });

    // Not bound yet: every compute decision fails closed.
    await expect(reserve('rsv-1')).rejects.toMatchObject({ code: 'ACCESS_DENIED' });

    await f.grant(alice.id, {
      version: 1,
      statements: [
        {
          effect: 'allow',
          actions: ['compute:reservations:extend'],
          resources: ['compute-reservation/*'],
          conditions: {
            StringEquals: { 'resource.ownerId': '${principal.id}' },
            NumericLessThanEquals: { 'resource.durationHours': 72 },
            ArrayContains: { 'resource.parentRelations': 'user' },
          },
        },
      ],
    });
    await f.iam.api.relationships.create(f.ownerCredential, {
      tenantId: f.tenantId,
      type: 'compute-pool',
      id: 'pool-1',
      relation: 'user',
      subjectType: 'identity',
      subjectId: alice.id,
    });
    const row: ProjectionRow = {
      type: 'reservation',
      id: 'rsv-1',
      tenantId: f.tenantId,
      attributes: { gpuModel: 'H100', durationHours: 48 },
      parentType: 'pool',
      parentId: 'pool-1',
      ownerId: alice.id,
    };
    await write((tx) => upsert(tx, row));
    await bridge.bind({ sql: db });
    try {
      expect((await reserve('rsv-1')).allowed).toBe(true);
      // An extend to 96 h total is pending: the decision sees the total, so BoundedExtend denies it.
      await write((tx) => upsert(tx, { ...row, pending: { durationHours: 96 } }));
      await bridge.projection.sync();
      expect((await reserve('rsv-1')).allowed).toBe(false);
      await expect(reserve('rsv-absent')).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
      // compute-tenant/{t} resolves only in t, whatever the projection holds.
      const listed = await f.iam.authorize({
        ...f.ownerCredential,
        tenantId: f.tenantId,
        action: 'compute:pools:read',
        resource: { type: 'compute-tenant', id: f.tenantId },
      });
      expect(listed.allowed).toBe(true);
    } finally {
      await bridge.stop();
    }
  });
});
