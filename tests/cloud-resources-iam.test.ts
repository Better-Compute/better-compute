import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { SqlExecutor, SqlTx } from '@better-compute/core';
import { pglite } from '@better-compute/postgres/pglite';
import {
  createComputeIamBridge,
  memoryInbox,
  successorsMigration,
  type ProjectionRow,
} from '@better-compute/iam';
import { closeIamFixtures, iamFixture } from './support/iam.js';

// IAM per family on a real better-iam: cloudResources decides on `cloud-resource/{id}` with the resource's kind and
// family as attributes (the projection row cloudResources.create stages), so one policy can allow a team managed
// databases and deny it App Platform, with no per-family action.

let db: SqlExecutor;

beforeAll(async () => {
  db = pglite();
  await db.migrate([successorsMigration]);
});
afterAll(async () => {
  await db.close();
});
afterEach(closeIamFixtures);

async function upsert(tx: SqlTx, row: ProjectionRow): Promise<void> {
  await tx.query(
    `INSERT INTO authz_projection (type, id, tenant_id, attributes, parent_type, parent_id, owner_id, pending)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, NULL)
     ON CONFLICT (type, id, tenant_id) DO UPDATE SET attributes = EXCLUDED.attributes`,
    [
      row.type,
      row.id,
      row.tenantId,
      JSON.stringify(row.attributes),
      row.parentType ?? null,
      row.parentId ?? null,
      row.ownerId ?? null,
    ],
  );
  await tx.query(
    `INSERT INTO authz_changes (type, id, tenant_id, op) VALUES ($1, $2, $3, 'upsert')`,
    [row.type, row.id, row.tenantId],
  );
}

/** The projection row of a cloud resource, as cloudResources.create stages it (resources.ts authzRow). */
const resource = (id: string, tenantId: string, kind: string, family: string): ProjectionRow => ({
  type: 'cloud-resource',
  id,
  tenantId,
  attributes: {
    kind,
    family,
    provider: 'digitalocean',
    providerAccountId: 'pacct_1',
    poolId: 'pool_1',
    region: 'nyc3',
  },
  parentType: 'tenant',
  parentId: tenantId,
  ownerId: 'idn_owner',
});

describe('cloud-resource IAM by family', () => {
  it('a policy on resource.family allows databases and denies App Platform, for every action', async () => {
    const bridge = createComputeIamBridge();
    const f = await iamFixture({
      plugins: [bridge.plugin({ inbox: memoryInbox() })],
      resolveResource: bridge.resolveResource(),
    });
    bridge.embedded(f.iam, { rootTenantId: f.rootTenantId });
    const dba = await f.member('dba');
    const session = await f.signIn('dba');
    await f.grant(dba.id, {
      version: 1,
      statements: [
        {
          effect: 'allow',
          actions: [
            'compute:cloud-resources:create',
            'compute:cloud-resources:read',
            'compute:cloud-resources:update',
            'compute:cloud-resources:delete',
          ],
          resources: ['compute-cloud-resource/*'],
          conditions: { StringEquals: { 'resource.family': 'data' } },
        },
      ],
    });
    await db.transaction(async (tx) => {
      await upsert(tx, resource('crs_db', f.tenantId, 'do.database.pg', 'data'));
      await upsert(tx, resource('crs_app', f.tenantId, 'do.app', 'platform'));
      // A staged create (the draft cloudResources.create decides on) carries the family too.
      await upsert(tx, resource('crs_draft_fn', f.tenantId, 'do.functions-namespace', 'platform'));
    });
    await bridge.bind({ sql: db });
    const decide = (action: string, id: string) =>
      f.iam
        .authorize({
          ...session,
          tenantId: f.tenantId,
          action: `compute:cloud-resources:${action}`,
          resource: { type: 'compute-cloud-resource', id },
        })
        .then((decision) => decision.allowed);
    try {
      for (const action of ['create', 'read', 'update', 'delete']) {
        expect(await decide(action, 'crs_db')).toBe(true);
        expect(await decide(action, 'crs_app')).toBe(false);
      }
      expect(await decide('create', 'crs_draft_fn')).toBe(false);
    } finally {
      await bridge.stop();
    }
  });
});
