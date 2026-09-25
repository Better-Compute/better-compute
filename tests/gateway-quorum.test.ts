import { create } from '@bufbuild/protobuf';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BatchApprovalSchema,
  BatchProofSchema,
  CommandBodySchema,
  CommandState,
  decodeMessage,
  encodeMessage,
  unwrapCommand,
} from '@better-compute/protocol';
import { createQuorumModule } from '@better-compute/server';
import { agentFrame, gatewayFixture, type GatewayFixture } from './support/gateway.js';

// The gateway's half of the destructive-batch quorum (PLAN.md §13, v1.0): a command in a batch that
// needs approvals is sent only once the batch is approved, with the stored approval and its leaf's
// proof attached, on dispatch and on replay; a batch without a quorum (required = 0) changes nothing.

let f: GatewayFixture;
beforeEach(async () => {
  f = await gatewayFixture();
  // The quorum module's own migrations (a compute host applies them; a bare gateway store does not).
  await f.db.migrate([...(createQuorumModule({}).migrations ?? [])]);
});
afterEach(() => f.close());

const root = new Uint8Array(32).fill(7);
const approval = encodeMessage(
  BatchApprovalSchema,
  create(BatchApprovalSchema, {
    batchId: 'batch_1',
    scopeRoot: root,
    scopeSize: 2,
    signatures: [{ kid: 'approver-1', sig: new Uint8Array([1, 2, 3]) }],
  }),
);
const proof = encodeMessage(BatchProofSchema, create(BatchProofSchema, { index: 1, siblings: [new Uint8Array(32).fill(9)] }));

/** A batch with one leaf for `commandId`'s node, and the command as its member. */
async function batched(commandId: string, nodeId: string, required: number) {
  await f.db.query(
    `INSERT INTO command_batches (id, tenant_id, reason, scope_root, scope_size, required, not_after, state)
     VALUES ('batch_1', 'tenant-1', 'reimage', $1, 2, $2, compute_now() + interval '1 hour', 'pending')
     ON CONFLICT (id) DO NOTHING`,
    [Buffer.from(root), required],
  );
  await f.db.query(
    `INSERT INTO command_batch_scope (batch_id, subject, kind, leaf_index, proof) VALUES ('batch_1', $1, 'diag.nvml', 1, $2)
     ON CONFLICT DO NOTHING`,
    [nodeId, Buffer.from(proof)],
  );
  await f.db.query(
    `INSERT INTO command_batch_members (command_id, batch_id, subject, kind) VALUES ($1, 'batch_1', $2, 'diag.nvml')`,
    [commandId, nodeId],
  );
}
const approve = () =>
  f.db.query(`UPDATE command_batches SET state = 'approved', approval = $1 WHERE id = 'batch_1'`, [Buffer.from(approval)]);

const commandsOf = (stream: { of(type: 'command'): { body: Uint8Array; batchApproval?: unknown; batchProof?: unknown }[] }) =>
  stream.of('command').map((command) => ({ id: unwrapCommand(command as never).id, command }));

describe('batched commands at the gateway (v1.0 quorum)', () => {
  it('withholds a member of an unapproved batch, then sends it with the approval and its proof', async () => {
    const node = await f.addNode();
    const id = await f.enqueue(node);
    const plain = await f.enqueue(node);
    await batched(id, node, 1);
    const { stream } = await f.connect(node);
    await f.gateway.jobs.dispatch.tick();
    // The unbatched command goes; the batched one waits, still pending.
    expect(commandsOf(stream).map((sent) => sent.id)).toEqual([plain]);
    expect((await f.command(id)).state).toBe('pending');

    await approve();
    await f.gateway.jobs.dispatch.tick();
    const sent = commandsOf(stream).find((command) => command.id === id)!.command as {
      batchApproval?: { batchId: string; scopeRoot: Uint8Array; signatures: unknown[] };
      batchProof?: { index: number; siblings: Uint8Array[] };
    };
    expect(sent.batchApproval).toMatchObject({ batchId: 'batch_1', scopeSize: 2 });
    expect(Buffer.from(sent.batchApproval!.scopeRoot).equals(Buffer.from(root))).toBe(true);
    expect(sent.batchProof).toMatchObject({ index: 1 });
    expect(sent.batchProof!.siblings).toHaveLength(1);
  });

  it('sends a member of a batch without a quorum (required = 0) at once, with nothing attached', async () => {
    const node = await f.addNode();
    const id = await f.enqueue(node);
    await batched(id, node, 0);
    const { stream } = await f.connect(node);
    await f.gateway.jobs.dispatch.tick();
    const sent = commandsOf(stream).find((command) => command.id === id)!.command;
    expect(sent.batchApproval).toBeUndefined();
    expect(sent.batchProof).toBeUndefined();
  });

  it('re-attaches the approval when an in-flight batched command is replayed at a new Hello', async () => {
    const node = await f.addNode();
    const id = await f.enqueue(node);
    // The signed body names the batch (the command queue writes it; here set directly).
    const { rows } = await f.db.query<{ body: Uint8Array }>('SELECT body FROM commands WHERE id = $1', [id]);
    const body = decodeMessage(CommandBodySchema, rows[0]!.body);
    await f.db.query('UPDATE commands SET body = $2 WHERE id = $1', [
      id,
      Buffer.from(encodeMessage(CommandBodySchema, { ...body, batchId: 'batch_1' })),
    ]);
    await batched(id, node, 1);
    await approve();
    const first = await f.connect(node);
    await f.gateway.jobs.dispatch.tick();
    expect(commandsOf(first.stream).map((sent) => sent.id)).toEqual([id]);
    await first.handle.receive(agentFrame({ case: 'update', value: { commandId: id, state: CommandState.ACKED, bootId: 'boot-1' } }));
    await first.handle.end();

    // Same journal, the command not running: it is replayed, with its approval again.
    const second = await f.connect(node, { bootId: 'boot-1' });
    const replayed = commandsOf(second.stream).find((sent) => sent.id === id)!.command;
    expect(replayed.batchApproval).toMatchObject({ batchId: 'batch_1' });
    expect(replayed.batchProof).toMatchObject({ index: 1 });
  });
});
