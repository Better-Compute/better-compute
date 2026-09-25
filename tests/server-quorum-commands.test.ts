import { createHash } from 'node:crypto';
import { fromBinary } from '@bufbuild/protobuf';
import { afterEach, describe, expect, it } from 'vitest';
import { manualClock, shardOf, type SqlExecutor } from '@better-compute/core';
import { setSimClock, useSimClock } from '@better-compute/postgres';
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
import { betterCompute, pkiJoinCrypto } from '@better-compute/server';
import { fakeIam } from '@better-compute/testing';
import { ACME, OTHER, options } from './support/server.js';

// The command queue's half of the destructive-batch quorum (PLAN.md §13, v1.0): `createBatch` stores a
// batch through the quorum module; `enqueue({ batchId })` checks the command's (subject, kind) is in the
// batch, signs batch_id into the body, records the member, and holds it (not_before = infinity) while a
// configured quorum has not approved the batch. Without approver keys batches are audit-only.

const T0 = Date.UTC(2026, 8, 25, 12);
const TOKEN = 'op-token';
let db: SqlExecutor | undefined;
afterEach(async () => {
  await db?.close();
  db = undefined;
});

async function setup(withApprovers: boolean) {
  db = pglite();
  const clock = manualClock(T0);
  const approvers = [createApproverKey(), createApproverKey()];
  const iam = fakeIam({ callers: { [TOKEN]: { tenantId: ACME, identityId: 'usr_ops' } }, allow: [{}] });
  const compute = betterCompute({
    ...options(db, iam),
    clock,
    pki: {
      commandSigning: createCommandSigningAuthority({ clock: manualClock(T0 - 60_000) }),
      // JoinService: its trust domain is a signed part of every approval.
      join: pkiJoinCrypto({
        trustDomain: 'compute.test',
        nodeCa: createNodeCa({ clock: manualClock(T0 - 60_000) }),
        signingKey: createSigningKey({ clock: manualClock(T0 - 60_000) }),
        encryptionKey: generateP256KeyPair().privateKey,
      }),
      ...(withApprovers
        ? { approvers: { keys: approvers.map((approver) => approver.key.spkiDer), threshold: 1 } }
        : {}),
    },
  } as never) as any;
  await compute.initialize();
  await useSimClock(db, T0);
  for (const [site, tenant] of [
    ['site_a', ACME],
    ['site_b', OTHER],
  ])
    await db.query(
      `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ($1, $2, 'shared', 'eu', 1)`,
      [site, tenant],
    );
  const node = async (id: string, site = 'site_a', tenant = ACME) =>
    db!.query(
      `INSERT INTO nodes (id, site_id, owner_tenant_id, role, provision_state, maintenance, cordoned, connectivity,
         trust, generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
       VALUES ($1, $2, $3, 'host', 'ready', false, false, 'disconnected', 'platform', 0, 0, 1, 1, $4, 1)`,
      [id, site, tenant, shardOf(id)],
    );
  await node('node_a');
  await node('node_b');
  await node('node_x', 'site_b', OTHER);
  const commands = compute.context.commands;
  const batch = (
    tenantId: string,
    scope: { subject: string; kind: string; payloadSha256?: Uint8Array }[],
    notAfterMs = T0 + 3_600_000,
  ) =>
    db!.transaction((tx) => commands.createBatch(tx, { tenantId, scope, reason: 'reboot rack 7', notAfterMs }));
  const enqueue = (nodeId: string, batchId: string | undefined, key: string, kind = 'node.reboot') =>
    db!.transaction((tx) =>
      commands.enqueue(tx, {
        nodeId,
        kind,
        payload: undefined,
        idempotencyKey: key,
        notAfter: T0 + 600_000,
        ...(batchId ? { batchId } : {}),
      }),
    );
  const row = async (id: string) =>
    (
      await db!.query<{ held: boolean; body: Uint8Array; member: string | null }>(
        `SELECT c.not_before = 'infinity' AS held, c.body, m.batch_id AS member
           FROM commands c LEFT JOIN command_batch_members m ON m.command_id = c.id WHERE c.id = $1`,
        [id],
      )
    ).rows[0]!;
  return { compute, approvers, batch, enqueue, row };
}

describe('CommandQueue batches (v1.0 quorum, §13)', () => {
  it('holds a batched command until the quorum approves, with batch_id in its signed body', async () => {
    const s = await setup(true);
    const created = await s.batch(ACME, [
      { subject: 'node_a', kind: 'node.reboot' },
      { subject: 'node_b', kind: 'node.reboot' },
    ]);
    expect(created).toMatchObject({ held: true, required: 1, size: 2 });

    const { id } = await s.enqueue('node_a', created.batchId, 'reboot-a');
    const stored = await s.row(id);
    expect(stored).toMatchObject({ held: true, member: created.batchId });
    expect(fromBinary(CommandBodySchema, stored.body).batchId).toBe(created.batchId);

    // Approval (one of two approver keys, threshold 1) releases it; later members go out at once.
    const view = await s.compute.api.commandBatches.get({ token: TOKEN }, { tenantId: ACME, batchId: created.batchId });
    const sig = signBatchApproval(
      {
        batchId: view.batchId,
        scopeRoot: new Uint8Array(Buffer.from(view.scopeRoot, 'hex')),
        scopeSize: view.scopeSize,
        notAfter: view.notAfter,
        trustDomain: view.trustDomain,
      },
      s.approvers[0]!.privateKey,
    );
    await s.compute.api.commandBatches.approve(
      { token: TOKEN },
      { tenantId: ACME, batchId: created.batchId, signature: { kid: sig.kid, sig: Buffer.from(sig.sig).toString('base64url') } },
    );
    expect((await s.row(id)).held).toBe(false);
    const later = await s.enqueue('node_b', created.batchId, 'reboot-b');
    expect(await s.row(later.id)).toMatchObject({ held: false, member: created.batchId });
  });

  it('refuses a command outside the scope, an expired batch and another tenant’s batch', async () => {
    const s = await setup(true);
    const created = await s.batch(ACME, [{ subject: 'node_a', kind: 'node.reboot' }]);
    // Right kind, wrong node; right node, wrong kind.
    await expect(s.enqueue('node_b', created.batchId, 'k1')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(s.enqueue('node_a', created.batchId, 'k2', 'diag.nvml')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    // A node of another tenant cannot use this batch (it reads as missing), nor a made-up id.
    await expect(s.enqueue('node_x', created.batchId, 'k3')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(s.enqueue('node_a', 'batch_missing', 'k4')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // Past its end (the state still reads pending until the sweep): no longer admits commands.
    await setSimClock(db!, T0 + 3_600_001);
    await expect(s.enqueue('node_a', created.batchId, 'k5')).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('admits a command into a payload-bound leaf only with that exact payload, and records the leaf', async () => {
    const s = await setup(true);
    // node.reboot has an empty payload: its digest is SHA-256 of no bytes.
    const empty = createHash('sha256').update(new Uint8Array()).digest();
    const bound = await s.batch(ACME, [{ subject: 'node_a', kind: 'node.reboot', payloadSha256: empty }]);
    const { id } = await s.enqueue('node_a', bound.batchId, 'bound-a');
    const member = await db!.query<{ payload_sha256: Uint8Array }>(
      'SELECT payload_sha256 FROM command_batch_members WHERE command_id = $1',
      [id],
    );
    expect(Buffer.from(member.rows[0]!.payload_sha256).equals(empty)).toBe(true);
    // A leaf bound to another payload does not admit this one.
    const other = await s.batch(ACME, [{ subject: 'node_a', kind: 'node.reboot', payloadSha256: new Uint8Array(32).fill(1) }]);
    await expect(s.enqueue('node_a', other.batchId, 'bound-b')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('records batches for audit only without approver keys: members are sent at once', async () => {
    const s = await setup(false);
    const created = await s.batch(ACME, [{ subject: 'node_a', kind: 'node.reboot' }]);
    expect(created).toMatchObject({ held: false, required: 0 });
    const { id } = await s.enqueue('node_a', created.batchId, 'reboot-a');
    expect(await s.row(id)).toMatchObject({ held: false, member: created.batchId });
  });
});
