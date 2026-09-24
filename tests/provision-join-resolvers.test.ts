import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SqlExecutor } from '@better-compute/core';
import { pglite } from '@better-compute/postgres/pglite';
import { discoveryWorkflowNodeResolver, provisionMigrations, provisionedTargetResolver } from '@better-compute/provision';

// The host-side resolvers pki's attestors use (PLAN.md §3.3 step 4, §3.6): a `provisioned` token
// resolves to the node whose running workflow rendered it, and a discovery assertion's workflow to
// its node. Finished workflows resolve to nothing.

let db: SqlExecutor;
const NODE_A = 'node_0000000000000000000000000a';
const NODE_B = 'node_0000000000000000000000000b';

beforeAll(async () => {
  db = pglite({ analyzeEveryMs: 0 });
  await db.migrate([...provisionMigrations]);
  await db.query(`INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site_a', 'acme', 'custom', 'eu', 1)`);
  for (const id of [NODE_A, NODE_B])
    await db.query(
      `INSERT INTO nodes (id, site_id, owner_tenant_id, role, provision_state, maintenance, cordoned, connectivity, trust,
         generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
       VALUES ($1, 'site_a', 'acme', 'host', 'deploying', false, false, 'connected', 'tenant-owned', 1, 1, 1, 0, 0, 1)`,
      [id],
    );
  await workflow('wf_a', NODE_A, 'running', 'jt_live');
  await workflow('wf_b', NODE_B, 'succeeded', 'jt_done');
  await db.query(
    `INSERT INTO inventory_snapshots (id, node_id, sha256, section_hashes, sections, collected_at)
     VALUES ('inv_1', $1, '\\x00', '{}', '{"system":{"productUuid":"4C4C4544-0042-3510-8052-B7C04F4E4E32"}}', now())`,
    [NODE_A],
  );
});
afterAll(() => db.close());

async function workflow(id: string, nodeId: string, state: string, tokenId: string) {
  await db.query(
    `INSERT INTO workflows (id, tenant_id, node_id, profile_id, profile_version, state, work_key)
     VALUES ($1, 'acme', $2, 'ubuntu', 1, $3, $2)`,
    [id, nodeId, state],
  );
  await db.query(
    `INSERT INTO workflow_steps (workflow_id, id, index, phase, action, runs_on, state, timeout_ms, idempotency_key, result)
     VALUES ($1, 'render', 0, 'main', 'userdata.render', 'control-plane', 'succeeded', 60000, $1 || ':render', $2::jsonb)`,
    [id, JSON.stringify({ userDataRef: 'secret://acme/ud', kind: 'cloud-init', joinTokenId: tokenId })],
  );
}

describe('provisionedTargetResolver', () => {
  const resolve = provisionedTargetResolver();
  it("resolves a running workflow's token to its node and product UUID", async () => {
    expect(await resolve(db, { id: 'jt_live', tenantId: 'acme', siteId: 'site_a' })).toEqual({
      nodeId: NODE_A,
      productUuid: '4C4C4544-0042-3510-8052-B7C04F4E4E32',
    });
  });
  it('answers nothing for a finished workflow, another tenant, another site or an unknown token', async () => {
    expect(await resolve(db, { id: 'jt_done', tenantId: 'acme' })).toBeUndefined();
    expect(await resolve(db, { id: 'jt_live', tenantId: 'other' })).toBeUndefined();
    expect(await resolve(db, { id: 'jt_live', tenantId: 'acme', siteId: 'site_b' })).toBeUndefined();
    expect(await resolve(db, { id: 'jt_nope', tenantId: 'acme' })).toBeUndefined();
  });
});

describe('discoveryWorkflowNodeResolver', () => {
  const resolve = discoveryWorkflowNodeResolver();
  it('resolves only running workflows, and never deleted nodes', async () => {
    expect(await resolve(db, 'wf_a')).toBe(NODE_A);
    expect(await resolve(db, 'wf_b')).toBeUndefined();
    expect(await resolve(db, 'wf_nope')).toBeUndefined();
    await db.query('UPDATE nodes SET deleted_at = now() WHERE id = $1', [NODE_A]);
    expect(await resolve(db, 'wf_a')).toBeUndefined();
  });
});
