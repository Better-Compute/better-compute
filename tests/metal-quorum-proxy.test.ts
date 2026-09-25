import { createHash } from 'node:crypto';
import { fromBinary } from '@bufbuild/protobuf';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { manualClock, shardOf, type SqlExecutor, type StepContext } from '@better-compute/core';
import { httpViaSite, metal } from '@better-compute/metal';
import { useSimClock } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import {
  createApproverKey,
  createCommandSigningAuthority,
  createNodeCa,
  createSigningKey,
  generateP256KeyPair,
  signBatchApproval,
} from '@better-compute/pki';
import { CommandBodySchema } from '@better-compute/protocol';
import { provisionModule } from '@better-compute/provision';
import { betterCompute, pkiJoinCrypto } from '@better-compute/server';
import { fakeIam } from '@better-compute/testing';
import { ACME, options } from './support/server.js';

// Review 9 HIGH-3 with the quorum on (PLAN.md §13): a site.httpProxy that changes something (not GET), as
// an agentless (Talos) profile's apply-config would send, runs under a one-leaf batch of its own, bound
// to the exact request bytes, so approvers see that very request; it is held until they approve.

const T0 = Date.UTC(2026, 8, 25, 12);
const TOKEN = 'op-token';
const AGENT = 'node_s1tea000000000000000000003';
let db: SqlExecutor;
let compute: any;
let machine: string;
const approver = createApproverKey();

beforeAll(async () => {
  db = pglite();
  const iam = fakeIam({ callers: { [TOKEN]: { tenantId: ACME, identityId: 'usr_ops' } }, allow: [{}] });
  const bareMetal = metal();
  compute = betterCompute({
    ...options(db, iam),
    clock: manualClock(T0),
    modules: [provisionModule({ modules: [bareMetal] }), bareMetal],
    pki: {
      commandSigning: createCommandSigningAuthority({ clock: manualClock(T0 - 60_000) }),
      join: pkiJoinCrypto({
        trustDomain: 'compute.test',
        nodeCa: createNodeCa({ clock: manualClock(T0 - 60_000) }),
        signingKey: createSigningKey({ clock: manualClock(T0 - 60_000) }),
        encryptionKey: generateP256KeyPair().privateKey,
      }),
      approvers: { keys: [approver.key.spkiDer], threshold: 1 },
    },
  } as never);
  await compute.initialize();
  await useSimClock(db, T0);
  await db.query(`INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site_a', $1, 'shared', 'eu', 1)`, [ACME]);
  await db.query(
    `INSERT INTO pools (id, owner_tenant_id, site_id, class, sharing, agent, policy, version)
     VALUES ('pool_oob', $1, 'site_a', 'metal-host', 'exclusive', 'none', '{}', 1)`,
    [ACME],
  );
  // The site agent, connected.
  await db.query(
    `INSERT INTO nodes (id, site_id, owner_tenant_id, role, provision_state, maintenance, cordoned, connectivity,
       trust, generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
     VALUES ($1, 'site_a', $2, 'site', 'adopted', false, false, 'connected', 'platform', 0, 0, 1, 1, $3, 1)`,
    [AGENT, ACME, shardOf(AGENT)],
  );
  await db.query(
    `INSERT INTO node_sessions (node_id, session_epoch, boot_id, role, connected_at) VALUES ($1, 1, 'site-boot', 'site', compute_now())`,
    [AGENT],
  );
  const enrolled = await compute.api.metal.enroll(
    { token: TOKEN },
    { tenantId: ACME, siteId: 'site_a', poolId: 'pool_oob', bmc: { address: 'https://10.20.0.5', driver: 'redfish', credentials: 'secret://tenant-acme/bmc' } },
  );
  machine = enrolled.nodeId;
  await db.query(`UPDATE metal_nodes SET addresses = '{10.30.1.7}' WHERE node_id = $1`, [machine]);
});
afterAll(async () => {
  await compute?.stop?.().catch(() => {});
  await db?.close();
});

describe('a non-GET site.httpProxy under the quorum', () => {
  it('gets a one-leaf batch bound to its exact bytes, and waits for its approval', async () => {
    const step = {
      ...compute.context,
      node: { id: machine, siteId: 'site_a' },
      workflowId: 'wf_talos',
      stepId: 'main.3',
      attempt: 0,
      idempotencyKey: 'wf:talos:main.3',
    } as unknown as StepContext;
    const request = { url: 'https://10.30.1.7:50000/machine/config', method: 'POST' as const, body: '{"config":"…"}', tlsSpkiSha256: 'ab'.repeat(32) };
    await expect(httpViaSite(step, request)).rejects.toThrow(/not ready/);

    const { rows } = await db.query<{ id: string; body: Uint8Array; held: boolean; batch_id: string }>(
      `SELECT c.id, c.body, c.not_before = 'infinity' AS held, m.batch_id
         FROM commands c JOIN command_batch_members m ON m.command_id = c.id WHERE c.kind = 'site.httpProxy'`,
    );
    expect(rows).toHaveLength(1);
    const command = rows[0]!;
    expect(command.held).toBe(true);
    const body = fromBinary(CommandBodySchema, new Uint8Array(command.body));
    expect(body.batchId).toBe(command.batch_id);
    // The batch holds exactly this request: one leaf, its digest the command payload's.
    const scope = await compute.api.commandBatches.scope({ token: TOKEN }, { tenantId: ACME, batchId: command.batch_id });
    expect(scope.items).toHaveLength(1);
    expect(scope.items[0]).toMatchObject({ subject: `node:${machine}`, kind: 'site.httpProxy' });
    const digest = createHash('sha256').update(body.payload!.value).digest('hex');
    expect(scope.items[0].payloadSha256).toBe(digest);
    // A re-run of the step (still waiting) makes no second batch or command.
    await expect(httpViaSite(step, request)).rejects.toThrow(/not ready/);
    expect((await db.query(`SELECT 1 FROM commands WHERE kind = 'site.httpProxy'`)).rowCount).toBe(1);

    const view = await compute.api.commandBatches.get({ token: TOKEN }, { tenantId: ACME, batchId: command.batch_id });
    const sig = signBatchApproval(
      { batchId: view.batchId, scopeRoot: new Uint8Array(Buffer.from(view.scopeRoot, 'hex')), scopeSize: view.scopeSize, notAfter: view.notAfter, trustDomain: view.trustDomain },
      approver.privateKey,
    );
    await compute.api.commandBatches.approve(
      { token: TOKEN },
      { tenantId: ACME, batchId: command.batch_id, signature: { kid: sig.kid, sig: Buffer.from(sig.sig).toString('base64url') } },
    );
    const after = await db.query<{ held: boolean }>(`SELECT not_before = 'infinity' AS held FROM commands WHERE id = $1`, [command.id]);
    expect(after.rows[0]!.held).toBe(false);
  });
});
