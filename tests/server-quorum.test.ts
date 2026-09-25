import { createHash } from 'node:crypto';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { afterEach, describe, expect, it } from 'vitest';
import { manualClock, type SqlExecutor } from '@better-compute/core';
import { setSimClock, useSimClock } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import {
  batchScope,
  createApproverKey,
  createCommandSigningAuthority,
  createNodeCa,
  createSigningKey,
  generateP256KeyPair,
  signBatchApproval,
  verifyBatchApproval,
  verifyBatchProof,
} from '@better-compute/pki';
import {
  BatchApprovalSchema,
  BatchProofSchema,
  NodeRebootRequestSchema,
  commandKinds,
} from '@better-compute/protocol';
import { betterCompute, createCommandBatch, pkiJoinCrypto, quorumConfigOf } from '@better-compute/server';
import { fakeIam } from '@better-compute/testing';
import { ACME, options } from './support/server.js';

// The destructive-batch quorum, server side (PLAN.md §13, v1.0): a batch's tree is fixed when it is
// created; approvals are approver-key signatures over its root; once k distinct approvers signed,
// the batch is approved, its held commands become due, and the stored approval + per-leaf proofs
// are what the gateway attaches (and the daemon verifies).

const T0 = Date.UTC(2026, 8, 25, 12);
const TOKEN = 'op-token';
const TRUST_DOMAIN = 'compute.test';
const NODE_Q = 'node_01k5w00000000000000000000q';
let db: SqlExecutor | undefined;
afterEach(async () => {
  await db?.close();
  db = undefined;
});

/** The tenant's machines the batches name: batch subjects must be its own nodes. */
async function seedNodes(sql: SqlExecutor) {
  await sql.query(
    `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site_q1', $1, 'shared', 'eu', 1)`,
    [ACME],
  );
  for (const id of ['node_a', 'node_b', 'node_agent'])
    await sql.query(
      `INSERT INTO nodes (id, site_id, owner_tenant_id, role, provision_state, maintenance, cordoned, connectivity,
         trust, generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
       VALUES ($1, 'site_q1', $2, 'host', 'ready', false, false, 'disconnected', 'platform', 0, 0, 1, 1, 0, 1)`,
      [id, ACME],
    );
}

async function setup() {
  db = pglite();
  const clock = manualClock(T0);
  const approvers = [createApproverKey(), createApproverKey(), createApproverKey()];
  const iam = fakeIam({
    callers: { [TOKEN]: { tenantId: ACME, identityId: 'usr_ops' } },
    allow: [{}],
  });
  const compute = betterCompute({
    ...options(db, iam),
    clock,
    pki: {
      commandSigning: createCommandSigningAuthority({ clock: manualClock(T0 - 60_000) }),
      // JoinService: its trust domain is a signed part of every approval.
      join: pkiJoinCrypto({
        trustDomain: TRUST_DOMAIN,
        nodeCa: createNodeCa({ clock: manualClock(T0 - 60_000) }),
        signingKey: createSigningKey({ clock: manualClock(T0 - 60_000) }),
        encryptionKey: generateP256KeyPair().privateKey,
      }),
      approvers: {
        keys: approvers.map((approver) => approver.key.spkiDer),
        threshold: 2,
        tiers: [{ maxScopeSize: 1, threshold: 1 }],
      },
    },
  } as never) as any;
  await compute.initialize();
  // compute_now() follows the same clock (the batch's end is compared in SQL).
  await useSimClock(db, T0);
  await seedNodes(db);
  const quorum = quorumConfigOf({
    approverKeys: approvers.map((approver) => approver.key),
    approverThreshold: 2,
    quorumTiers: [{ maxScopeSize: 1, threshold: 1 }],
  });
  const create = (scope: { subject: string; kind: string }[], notAfterMs = T0 + 3_600_000) =>
    db!.transaction((tx) =>
      createCommandBatch(
        tx,
        { tenantId: ACME, scope, reason: 'reimage rack 7', notAfterMs },
        { now: T0, quorum },
      ),
    );
  /** A held command in the batch, as the command queue writes it. */
  const member = async (batchId: string, id: string, subject: string, kind: string) => {
    await db!.query(
      `INSERT INTO commands (id, node_id, seq, kind, body, state, not_before, not_after, retry_safe,
         self_terminating, attested, idempotency_key)
       VALUES ($1, $2, 1, $3, '\\x00', 'pending', 'infinity', compute_now() + interval '1 day', false,
         false, false, $1)`,
      [id, `node_${id}`, kind],
    );
    await db!.query(
      `INSERT INTO command_batch_members (command_id, batch_id, subject, kind) VALUES ($1, $2, $3, $4)`,
      [id, batchId, subject, kind],
    );
  };
  const api = compute.api.commandBatches;
  const cred = { token: TOKEN };
  const sign = (
    view: { batchId: string; scopeRoot: string; scopeSize: number; notAfter: number },
    i: number,
  ) => {
    const sig = signBatchApproval(
      {
        batchId: view.batchId,
        scopeRoot: new Uint8Array(Buffer.from(view.scopeRoot, 'hex')),
        scopeSize: view.scopeSize,
        notAfter: view.notAfter,
        trustDomain: TRUST_DOMAIN,
      },
      approvers[i]!.privateKey,
    );
    return { kid: sig.kid, sig: Buffer.from(sig.sig).toString('base64url') };
  };
  return { compute, clock, approvers, quorum, create, member, api, cred, sign };
}

const scope = [
  { subject: 'node_a', kind: 'disk.wipe' },
  // A BMC subject names the site agent that drives it (review #6 H2).
  { subject: 'bmc:node_agent/10.0.0.11', kind: 'bmc.power' },
  { subject: 'bmc:node_agent/10.0.0.12', kind: 'bmc.power' },
];

describe('commandBatches (v1.0 quorum, §13)', () => {
  it('stores the tree at creation: root, size and every leaf proof match pki', async () => {
    const s = await setup();
    const created = await s.create(scope);
    expect(created).toMatchObject({ held: true, required: 2, size: 3 });
    const view = await s.api.get(s.cred, { tenantId: ACME, batchId: created.batchId });
    const expected = batchScope(created.batchId, scope);
    expect(view).toMatchObject({
      state: 'pending',
      scopeRoot: Buffer.from(expected.root).toString('hex'),
      scopeSize: 3,
      requiredApprovals: 2,
      approvals: [],
    });
    const { rows } = await db!.query<{ subject: string; kind: string; proof: Uint8Array }>(
      'SELECT subject, kind, proof FROM command_batch_scope WHERE batch_id = $1',
      [created.batchId],
    );
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      const proof = fromBinary(BatchProofSchema, new Uint8Array(row.proof));
      expect(
        verifyBatchProof({
          batchId: created.batchId,
          subject: row.subject,
          kind: row.kind,
          proof,
          root: expected.root,
          size: 3,
        }),
      ).toBe(true);
    }
    // The scope pages by leaf index, for a CLI that recomputes the root before signing.
    const page = await s.api.scope(s.cred, { tenantId: ACME, batchId: created.batchId, limit: 2 });
    expect(page.items.map((item: { leafIndex: number }) => item.leafIndex)).toEqual([0, 1]);
    expect(page.next).toBe(2);
    // A one-leaf batch falls in the tier that needs one approval.
    expect((await s.create([{ subject: 'node_b', kind: 'node.reboot' }])).required).toBe(1);
  });

  it('approves with k distinct approver signatures, then releases the held commands', async () => {
    const s = await setup();
    const { batchId } = await s.create(scope);
    await s.member(batchId, 'cmd_1', 'node_a', 'disk.wipe');
    const view = await s.api.get(s.cred, { tenantId: ACME, batchId });

    // A signature by a key outside the set, or over another root, is refused.
    const outsider = createApproverKey();
    const forged = signBatchApproval(
      {
        batchId,
        scopeRoot: new Uint8Array(Buffer.from(view.scopeRoot, 'hex')),
        scopeSize: 3,
        notAfter: view.notAfter,
        trustDomain: TRUST_DOMAIN,
      },
      outsider.privateKey,
    );
    await expect(
      s.api.approve(s.cred, {
        tenantId: ACME,
        batchId,
        signature: { kid: forged.kid, sig: Buffer.from(forged.sig).toString('base64url') },
      }),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });

    const first = await s.api.approve(s.cred, {
      tenantId: ACME,
      batchId,
      signature: s.sign(view, 0),
    });
    expect(first).toMatchObject({
      state: 'pending',
      approvals: [{ kid: s.approvers[0]!.key.kid }],
    });
    // The same approver twice counts once.
    expect(
      (await s.api.approve(s.cred, { tenantId: ACME, batchId, signature: s.sign(view, 0) })).state,
    ).toBe('pending');
    const held = await db!.query<{ held: boolean }>(
      `SELECT not_before = 'infinity' AS held FROM commands WHERE id = 'cmd_1'`,
    );
    expect(held.rows[0]!.held).toBe(true);

    const second = await s.api.approve(s.cred, {
      tenantId: ACME,
      batchId,
      signature: s.sign(view, 2),
    });
    expect(second.state).toBe('approved');
    // The stored approval is what a daemon verifies.
    const { rows } = await db!.query<{ approval: Uint8Array }>(
      'SELECT approval FROM command_batches WHERE id = $1',
      [batchId],
    );
    const approval = fromBinary(BatchApprovalSchema, new Uint8Array(rows[0]!.approval));
    expect(
      verifyBatchApproval(approval, {
        approverKeys: s.quorum!.approverKeys,
        threshold: 2,
        tiers: s.quorum!.tiers,
        now: T0,
        trustDomain: TRUST_DOMAIN,
      }).sort(),
    ).toEqual([s.approvers[0]!.key.kid, s.approvers[2]!.key.kid].sort());
    const released = await db!.query<{ due: boolean }>(
      `SELECT not_before <= compute_now() AS due FROM commands WHERE id = 'cmd_1'`,
    );
    expect(released.rows[0]!.due).toBe(true);
    // Approved is final.
    await expect(
      s.api.approve(s.cred, { tenantId: ACME, batchId, signature: s.sign(view, 1) }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('cancels a batch and its held commands; an expired batch cannot be approved', async () => {
    const s = await setup();
    const cancelled = await s.create(scope);
    await s.member(cancelled.batchId, 'cmd_c', 'node_a', 'disk.wipe');
    expect((await s.api.cancel(s.cred, { tenantId: ACME, batchId: cancelled.batchId })).state).toBe(
      'cancelled',
    );
    const { rows } = await db!.query<{ state: string }>(
      `SELECT state FROM commands WHERE id = 'cmd_c'`,
    );
    expect(rows[0]!.state).toBe('cancelled');

    const short = await s.create(scope, T0 + 60_000);
    const view = await s.api.get(s.cred, { tenantId: ACME, batchId: short.batchId });
    const signature = s.sign(view, 0);
    s.clock.advance(120_000);
    await setSimClock(db!, T0 + 120_000);
    await expect(
      s.api.approve(s.cred, { tenantId: ACME, batchId: short.batchId, signature }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect((await s.api.get(s.cred, { tenantId: ACME, batchId: short.batchId })).state).toBe(
      'expired',
    );
    const listed = await s.api.list(s.cred, { tenantId: ACME });
    expect(listed.items.map((item: { state: string }) => item.state).sort()).toEqual([
      'cancelled',
      'expired',
    ]);
  });

  it('creates batches through the API and runs a batched reboot once approved', async () => {
    const s = await setup();
    await db!.query(
      `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site_q', $1, 'shared', 'eu', 1)`,
      [ACME],
    );
    await db!.query(
      `INSERT INTO nodes (id, site_id, owner_tenant_id, role, provision_state, maintenance, cordoned, connectivity,
         trust, generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
       VALUES ($2, 'site_q', $1, 'host', 'ready', false, false, 'disconnected', 'platform', 0, 0, 1, 1, 0, 1)`,
      [ACME, NODE_Q],
    );
    // What the API's visibility check reads (a real node gets it from the node pass).
    await db!.query(
      `INSERT INTO authz_projection (type, id, tenant_id, attributes) VALUES ('node', $1, $2, '{}')`,
      [NODE_Q, ACME],
    );
    const request = {
      tenantId: ACME,
      reason: 'reboot after the kernel update',
      scope: [{ subject: NODE_Q, kind: 'node.reboot' }],
      idempotencyKey: 'reboot-q',
    };
    const created = await s.api.create(s.cred, request);
    // One leaf: the tier that needs one approval.
    expect(created).toMatchObject({
      state: 'pending',
      scopeSize: 1,
      requiredApprovals: 1,
      trustDomain: TRUST_DOMAIN,
      createdBy: 'usr_ops',
    });
    // A retry is the same batch; the key for another request is refused.
    expect((await s.api.create(s.cred, request)).batchId).toBe(created.batchId);
    await expect(
      s.api.create(s.cred, { ...request, scope: [{ subject: NODE_Q, kind: 'disk.wipe' }] }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      s.api.create(s.cred, { ...request, idempotencyKey: 'bad', scope: [{ subject: NODE_Q, kind: 'Reboot' }] }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    const commands = s.compute.api.commands;
    const run = { tenantId: ACME, nodeId: NODE_Q, kind: 'node.reboot' };
    // With approvers and no break-glass allowance, a reboot needs its batch.
    await expect(commands.run(s.cred, { ...run, idempotencyKey: 'r0' })).rejects.toMatchObject({
      code: 'INVALID_STATE',
      details: { reason: 'batch-required' },
    });
    const queued = await commands.run(s.cred, { ...run, idempotencyKey: 'r1', batchId: created.batchId });
    const due = async () =>
      (
        await db!.query<{ due: boolean }>(
          `SELECT not_before <= compute_now() AS due FROM commands WHERE id = $1`,
          [queued.id],
        )
      ).rows[0]!.due;
    expect(await due()).toBe(false);
    // The API says why it waits.
    expect(queued).toMatchObject({ awaitingApproval: true, batchId: created.batchId });
    expect(queued.notBefore).toBeUndefined();
    const approved = await s.api.approve(s.cred, {
      tenantId: ACME,
      batchId: created.batchId,
      signature: s.sign(created, 1),
    });
    expect(approved).toMatchObject({ state: 'approved', commands: { pending: 1 } });
    expect(await due()).toBe(true);
    const released = await commands.get(s.cred, { tenantId: ACME, nodeId: NODE_Q, commandId: queued.id });
    expect(released.awaitingApproval).toBeUndefined();
    expect(released).toMatchObject({ notBefore: expect.any(Number), batchId: created.batchId });
  });

  it('stores a leaf payload for approvers and binds the leaf to its digest (review 7 #3)', async () => {
    const s = await setup();
    const value = Buffer.from(
      toBinary(NodeRebootRequestSchema, create(NodeRebootRequestSchema, { reason: 'kernel 6.9' })),
    );
    const typeUrl = `type.googleapis.com/${commandKinds['node.reboot'].payload.typeName}`;
    const created = await s.api.create(s.cred, {
      tenantId: ACME,
      reason: 'reboot one node',
      idempotencyKey: 'reboot-1',
      scope: [
        { subject: 'node_a', kind: 'node.reboot', payload: { typeUrl, value: value.toString('base64') } },
        { subject: 'node_b', kind: 'disk.wipe' },
      ],
    });
    const { items } = await s.api.scope(s.cred, { tenantId: ACME, batchId: created.batchId });
    const bound = items.find((item: { kind: string }) => item.kind === 'node.reboot');
    // The digest is derived from the payload; the payload is there for the approver to decode.
    expect(bound).toMatchObject({
      subject: 'node_a',
      payloadSha256: createHash('sha256').update(value).digest('hex'),
      payload: { typeUrl, value: value.toString('base64') },
    });
    // The unbound leaf is flagged by its empty digest and carries no payload.
    expect(items.find((item: { kind: string }) => item.kind === 'disk.wipe')).toEqual({
      leafIndex: expect.any(Number),
      subject: 'node_b',
      kind: 'disk.wipe',
      payloadSha256: '',
    });
    // A payload that does not match the digest given with it is refused.
    await expect(
      s.api.create(s.cred, {
        tenantId: ACME,
        reason: 'mismatch',
        idempotencyKey: 'reboot-2',
        scope: [
          {
            subject: 'node_a',
            kind: 'node.reboot',
            payloadSha256: '00'.repeat(32),
            payload: { typeUrl, value: value.toString('base64') },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    // Review 8 #2: the payload's type is its kind's, never a label the creator picks (an approver
    // decoding the bytes as a harmless message the daemon would run as another).
    await expect(
      s.api.create(s.cred, {
        tenantId: ACME,
        reason: 'mislabelled',
        idempotencyKey: 'reboot-3',
        scope: [
          {
            subject: 'node_a',
            kind: 'node.reboot',
            payload: { typeUrl: 'type.googleapis.com/google.protobuf.Empty', value: value.toString('base64') },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it("refuses leaves that name another tenant's machines, or no machine (review 8 #1)", async () => {
    const s = await setup();
    await db!.query(
      `INSERT INTO nodes (id, site_id, owner_tenant_id, role, provision_state, maintenance, cordoned, connectivity,
         trust, generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
       VALUES ('node_other', 'site_q1', 'org_other', 'host', 'ready', false, false, 'disconnected', 'platform',
         0, 0, 1, 1, 0, 1)`,
    );
    const create = (subject: string, key: string) =>
      s.api.create(s.cred, {
        tenantId: ACME,
        reason: 'reboot',
        idempotencyKey: key,
        scope: [{ subject, kind: 'node.reboot' }],
      });
    await expect(create('node_other', 'k1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(create('node_missing', 'k2')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(create('bmc:node_other/10.0.0.5', 'k3')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(create('node:node_other', 'k4')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(create('bmc:10.0.0.5', 'k5')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect((await create('bmc:node_agent/10.0.0.5', 'k6')).scopeSize).toBe(1);
  });

  it('needs no approvals where the deployment publishes no approver keys', async () => {
    db = pglite();
    const compute = betterCompute({ ...options(db, fakeIam({ allow: [{}] })) } as never) as any;
    await compute.initialize();
    await seedNodes(db);
    const created = await db.transaction((tx) =>
      createCommandBatch(
        tx,
        { tenantId: ACME, scope, reason: 'no quorum' },
        { now: Date.now(), quorum: quorumConfigOf(undefined) },
      ),
    );
    expect(created).toMatchObject({ held: false, required: 0, size: 3 });
  });
});
