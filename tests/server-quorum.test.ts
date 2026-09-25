import { fromBinary } from '@bufbuild/protobuf';
import { afterEach, describe, expect, it } from 'vitest';
import { manualClock, type SqlExecutor } from '@better-compute/core';
import { setSimClock, useSimClock } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import {
  batchScope,
  createApproverKey,
  createCommandSigningAuthority,
  signBatchApproval,
  verifyBatchApproval,
  verifyBatchProof,
} from '@better-compute/pki';
import { BatchApprovalSchema, BatchProofSchema } from '@better-compute/protocol';
import { betterCompute, createCommandBatch, quorumConfigOf } from '@better-compute/server';
import { fakeIam } from '@better-compute/testing';
import { ACME, options } from './support/server.js';

// The destructive-batch quorum, server side (PLAN.md §13, v1.0): a batch's tree is fixed when it is
// created; approvals are approver-key signatures over its root; once k distinct approvers signed,
// the batch is approved, its held commands become due, and the stored approval + per-leaf proofs
// are what the gateway attaches (and the daemon verifies).

const T0 = Date.UTC(2026, 8, 25, 12);
const TOKEN = 'op-token';
let db: SqlExecutor | undefined;
afterEach(async () => {
  await db?.close();
  db = undefined;
});

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
      },
      approvers[i]!.privateKey,
    );
    return { kid: sig.kid, sig: Buffer.from(sig.sig).toString('base64url') };
  };
  return { compute, clock, approvers, quorum, create, member, api, cred, sign };
}

const scope = [
  { subject: 'node_a', kind: 'disk.wipe' },
  { subject: 'bmc:10.0.0.11', kind: 'bmc.power' },
  { subject: 'bmc:10.0.0.12', kind: 'bmc.power' },
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

  it('needs no approvals where the deployment publishes no approver keys', async () => {
    db = pglite();
    const compute = betterCompute({ ...options(db, fakeIam({ allow: [{}] })) } as never) as any;
    await compute.initialize();
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
