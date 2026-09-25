import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthzWriter, SqlExecutor } from '@better-compute/core';
import { pglite } from '@better-compute/postgres/pglite';
import {
  addImageSigner,
  createProfile,
  provisionMigrations,
  provisionModule,
  registerImage,
  teardownTenantProvisioning,
} from '@better-compute/provision';
import { generateKeyPairSync } from 'node:crypto';

// A deleted tenant's provisioning state goes: active workflows aborted, private images and
// profiles soft deleted with their authz rows, signers revoked. Public images stay.

let db: SqlExecutor;
const removed: string[] = [];
const authz: AuthzWriter = {
  async upsert() {},
  async remove(_tx, ref) {
    removed.push(`${ref.type}/${ref.id}`);
  },
  async setPending() {},
};
const context = {
  sql: undefined as unknown as SqlExecutor,
  work: { async enqueue() {} },
  events: { async publish() {} },
  commands: { async enqueue() { return { id: 'cmd', seq: 1 }; }, async cancel() {} },
  authz,
};
const module = provisionModule({ profiles: [] });

beforeAll(async () => {
  db = pglite({ analyzeEveryMs: 0 });
  await db.migrate(provisionMigrations);
  context.sql = db;
  await db.query(`INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('s', 'ten_gone', 'shared', 'eu', 1)`);
  await db.query(
    `INSERT INTO nodes (id, site_id, owner_tenant_id, role, provision_state, maintenance, cordoned, connectivity, trust,
       generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
     VALUES ('node_gone', 's', 'ten_gone', 'host', 'adopted', false, false, 'connected', 'platform', 1, 1, 1, 0, 0, 1)`,
  );
});
afterAll(() => db.close());

describe('teardownTenantProvisioning', () => {
  it('removes the tenant state and is idempotent', async () => {
    const key = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
    await db.transaction(async (tx) => {
      await addImageSigner(tx, { tenantId: 'ten_gone', id: 'team', algorithm: 'ed25519', publicKey: key });
      await registerImage(tx, undefined, 'ten_gone', 'root', { ref: 'mine@1', format: 'raw', sha256: 'ab'.repeat(32), source: 'https://images.example/mine' });
      await registerImage(tx, undefined, 'ten_keep', 'root', { ref: 'theirs@1', format: 'raw', sha256: 'cd'.repeat(32), source: 'https://images.example/theirs' });
      await createProfile(tx, undefined, 'ten_gone', {
        document: { id: 'gone-host', version: 1, target: 'metal', entry: 'adopt', acceptance: [{ use: 'wait.generationObserved' }] },
      });
    });
    const { id: workflowId } = await db.transaction((tx) =>
      module.workflowEngine(context).start(tx, { tenantId: 'ten_gone', profileId: 'gone-host', profileVersion: 1, nodeId: 'node_gone' }),
    );
    const result = await db.transaction((tx) => teardownTenantProvisioning(tx, context, 'ten_gone'));
    expect(result).toEqual({ workflowsAborted: 1, imagesDeleted: 1, profilesDeleted: 1, signersRevoked: 1 });
    expect(removed.sort()).toEqual(['image/' + (await imageId('mine@1')), 'profile/gone-host'].sort());
    const wf = await db.query<{ state: string; outcome: string | null }>('SELECT state, outcome FROM workflows WHERE id = $1', [workflowId]);
    expect(wf.rows[0]!.state === 'cancelled' || wf.rows[0]!.outcome === 'cancelled').toBe(true);
    // Another tenant's image is untouched; a second run does nothing.
    expect((await db.query(`SELECT 1 FROM images WHERE ref = 'theirs@1' AND deleted_at IS NULL`)).rowCount).toBe(1);
    expect(await db.transaction((tx) => teardownTenantProvisioning(tx, context, 'ten_gone'))).toEqual({
      workflowsAborted: 0,
      imagesDeleted: 0,
      profilesDeleted: 0,
      signersRevoked: 0,
    });
  });
});

async function imageId(ref: string): Promise<string> {
  return (await db.query<{ id: string }>('SELECT id FROM images WHERE ref = $1', [ref])).rows[0]!.id;
}
