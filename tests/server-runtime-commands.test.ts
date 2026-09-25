import { afterEach, describe, expect, it } from 'vitest';
import { create } from '@bufbuild/protobuf';
import { anyUnpack } from '@bufbuild/protobuf/wkt';
import {
  defineModule,
  isComputeError,
  type CommandKindSpec,
  type EnqueueCommand,
  type SqlTx,
} from '@better-compute/core';
import {
  CommandBodySchema,
  DiagNvmlRequestSchema,
  Lane,
  NodeRebootRequestSchema,
  decodeMessage,
  protocolRegistry,
  unpackCommandPayload,
} from '@better-compute/protocol';
import { builtinCommandKinds, commandOwner, pokeMessage } from '@better-compute/server';
import { closeFixtures, computeFixture } from '@better-compute/testing';
import { recordingNotifier, seedNode, sibling, workRows } from './support/runtime.js';

// The command queue (PLAN.md §7.4, §8.5) and the CommandSweeper.

afterEach(closeFixtures);

const HOUR = 3_600_000;

async function commandRow(sql: SqlTx, id: string) {
  const { rows } = await sql.query<{
    node_id: string;
    seq: number;
    kind: string;
    body: Uint8Array;
    state: string;
    reason: string | null;
    not_before: Date;
    not_after: Date;
    min_generation: number | null;
    retry_safe: boolean;
    self_terminating: boolean;
    attested: boolean;
    idempotency_key: string;
  }>('SELECT * FROM commands WHERE id = $1', [id]);
  return rows[0]!;
}

async function setup() {
  const fixture = await computeFixture();
  const notifier = recordingNotifier();
  const compute = await sibling(fixture, { notifier });
  const node = await seedNode(fixture.database, {
    tenantId: fixture.tenants.acme.id,
    gatewayId: 'gw_1',
  });
  const enqueue = (command: Partial<EnqueueCommand> & { idempotencyKey: string }) =>
    fixture.database.transaction((tx) =>
      compute.context.commands.enqueue(tx, {
        nodeId: node.id,
        kind: 'diag.nvml',
        payload: undefined,
        notAfter: fixture.clock.now() + HOUR,
        ...command,
      }),
    );
  return { fixture, compute, notifier, node, enqueue };
}

describe('CommandQueue.enqueue', () => {
  it('takes seq from nodes.next_cmd_seq and stores a pending row with the kind flags', async () => {
    const { fixture, node, enqueue } = await setup();
    const first = await enqueue({ idempotencyKey: 'k-1' });
    const second = await enqueue({ idempotencyKey: 'k-2', kind: 'node.reboot' });
    expect([first.seq, second.seq]).toEqual([1, 2]);
    const next = await fixture.database.query<{ next_cmd_seq: number }>(
      'SELECT next_cmd_seq FROM nodes WHERE id = $1',
      [node.id],
    );
    expect(next.rows[0]!.next_cmd_seq).toBe(3);

    const diag = await commandRow(fixture.database, first.id);
    expect(diag).toMatchObject({
      node_id: node.id,
      seq: 1,
      kind: 'diag.nvml',
      state: 'pending',
      retry_safe: true,
      self_terminating: false,
      attested: true,
      idempotency_key: 'k-1',
      min_generation: null,
    });
    expect(diag.not_before.getTime()).toBe(fixture.clock.now());
    expect(diag.not_after.getTime()).toBe(fixture.clock.now() + HOUR);
    expect(await commandRow(fixture.database, second.id)).toMatchObject({
      kind: 'node.reboot',
      self_terminating: true,
      attested: false,
    });
  });

  it('returns the existing command for a used idempotency key, without a new seq', async () => {
    const { fixture, node, enqueue } = await setup();
    const first = await enqueue({ idempotencyKey: 'same' });
    expect(await enqueue({ idempotencyKey: 'same' })).toEqual(first);
    const count = await fixture.database.query('SELECT 1 FROM commands WHERE node_id = $1', [
      node.id,
    ]);
    expect(count.rowCount).toBe(1);
    expect((await enqueue({ idempotencyKey: 'other' })).seq).toBe(2);
    // The key names one command: another kind under it is a conflict.
    await expect(enqueue({ idempotencyKey: 'same', kind: 'node.reboot' })).rejects.toSatisfy(
      (error: unknown) => isComputeError(error, 'CONFLICT'),
    );
  });

  it('encodes a CommandBody the daemon can read, with the payload packed as Any', async () => {
    const { fixture, node, enqueue } = await setup();
    const notAfter = fixture.clock.now() + HOUR + 250;
    const { id } = await enqueue({
      idempotencyKey: 'wf:wf_1:step-3',
      payload: create(DiagNvmlRequestSchema, { gpuUuids: ['GPU-1'], expectedGpuCount: 8 }),
      notAfter,
      minGeneration: 4,
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    });
    const row = await commandRow(fixture.database, id);
    const body = decodeMessage(CommandBodySchema, new Uint8Array(row.body));
    expect(body).toMatchObject({
      id,
      nodeId: node.id,
      seq: 1n,
      kind: 'diag.nvml',
      lane: Lane.CONTROL,
      minGeneration: 4n,
      retrySafe: true,
      selfTerminating: false,
      attested: true,
      idempotencyKey: 'wf:wf_1:step-3',
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      workflowId: 'wf_1',
      stepId: 'step-3',
    });
    expect(Number(body.notAfter!.seconds) * 1000 + body.notAfter!.nanos / 1e6).toBe(notAfter);
    expect(unpackCommandPayload('diag.nvml', body.payload)).toMatchObject({
      gpuUuids: ['GPU-1'],
      expectedGpuCount: 8,
    });
    expect(anyUnpack(body.payload!, protocolRegistry)?.$typeName).toBe(
      DiagNvmlRequestSchema.typeName,
    );
  });

  it('accepts nothing or encoded bytes as the payload, and refuses the wrong message', async () => {
    const { fixture, enqueue } = await setup();
    const empty = await enqueue({ idempotencyKey: 'empty', payload: {} });
    const body = decodeMessage(
      CommandBodySchema,
      new Uint8Array((await commandRow(fixture.database, empty.id)).body),
    );
    expect(unpackCommandPayload('diag.nvml', body.payload)).toMatchObject({
      gpuUuids: [],
      expectedGpuCount: 0,
    });
    await enqueue({ idempotencyKey: 'bytes', payload: new Uint8Array([0x10, 0x02]) });
    for (const payload of [create(NodeRebootRequestSchema), { gpuUuids: ['x'] }, 42])
      await expect(
        enqueue({ idempotencyKey: `bad-${String(payload)}`, payload }),
      ).rejects.toSatisfy((error: unknown) => isComputeError(error, 'INVALID_INPUT'));
  });

  it('refuses unknown kinds (INVALID_CONFIG), unknown nodes and malformed commands', async () => {
    const { enqueue } = await setup();
    await expect(enqueue({ idempotencyKey: 'x', kind: 'teleport' })).rejects.toSatisfy(
      (error: unknown) => isComputeError(error, 'INVALID_CONFIG'),
    );
    await expect(enqueue({ idempotencyKey: 'x', nodeId: 'node_missing' })).rejects.toSatisfy(
      (error: unknown) => isComputeError(error, 'NOT_FOUND'),
    );
    for (const bad of [
      { idempotencyKey: '' },
      { idempotencyKey: 'has space' },
      { idempotencyKey: 'x', notAfter: 0 },
      { idempotencyKey: 'x', notBefore: Date.UTC(2027, 0, 1) },
      { idempotencyKey: 'x', minGeneration: -1 },
      { idempotencyKey: 'x', traceparent: 'nope' },
    ])
      await expect(enqueue(bad)).rejects.toSatisfy((error: unknown) =>
        isComputeError(error, 'INVALID_INPUT'),
      );
  });

  it('uses a module-registered kind and its flags', async () => {
    const fixture = await computeFixture();
    const spec: CommandKindSpec = {
      kind: 'acme.blink',
      lane: 'bulk',
      retrySafe: false,
      selfTerminating: false,
      attested: false,
      timeout: '30s',
      roles: ['node'],
      payload: DiagNvmlRequestSchema,
    };
    const compute = await sibling(fixture, {
      modules: [defineModule({ name: 'blinker', commandKinds: [spec] })],
    });
    const node = await seedNode(fixture.database, { tenantId: fixture.tenants.acme.id });
    const { id } = await fixture.database.transaction((tx) =>
      compute.context.commands.enqueue(tx, {
        nodeId: node.id,
        kind: 'acme.blink',
        payload: undefined,
        idempotencyKey: 'blink-1',
        notAfter: fixture.clock.now() + HOUR,
      }),
    );
    const row = await commandRow(fixture.database, id);
    expect(row).toMatchObject({ kind: 'acme.blink', retry_safe: false });
    expect(decodeMessage(CommandBodySchema, new Uint8Array(row.body)).lane).toBe(Lane.BULK);
  });

  it("takes a module kind's payload as proto3 JSON of its named type, and refuses JSON that is not one", async () => {
    const fixture = await computeFixture();
    // Module kinds name their payload type only (metal's `message('…')`); it resolves in protocol's registry.
    const spec: CommandKindSpec = {
      kind: 'acme.bmc',
      lane: 'control',
      retrySafe: true,
      timeout: '2m',
      roles: ['site'],
      payload: { kind: 'message', typeName: 'bettercompute.site.v1.BmcOperationRequest' } as never,
    };
    const compute = await sibling(fixture, { modules: [defineModule({ name: 'bmcs', commandKinds: [spec] })] });
    const node = await seedNode(fixture.database, { tenantId: fixture.tenants.acme.id });
    const send = (payload: unknown, key: string) =>
      fixture.database.transaction((tx) =>
        compute.context.commands.enqueue(tx, { nodeId: node.id, kind: 'acme.bmc', payload, idempotencyKey: key, notAfter: fixture.clock.now() + HOUR }),
      );
    const json = {
      driver: 'redfish',
      address: 'https://10.0.0.9',
      credentialsRef: 'secret://acme/bmc',
      operation: 'power.getPower',
      argsJson: '{}',
      tlsSpkiSha256: Buffer.from('ab'.repeat(32), 'hex').toString('base64'),
    };
    const { id } = await send(json, 'json-1');
    const body = decodeMessage(CommandBodySchema, new Uint8Array((await commandRow(fixture.database, id)).body));
    const payload = anyUnpack(body.payload!, protocolRegistry) as unknown as Record<string, unknown>;
    expect(payload).toMatchObject({ driver: 'redfish', address: 'https://10.0.0.9', operation: 'power.getPower', credentialsRef: 'secret://acme/bmc' });
    expect(Buffer.from(payload.tlsSpkiSha256 as Uint8Array).toString('hex')).toBe('ab'.repeat(32));

    await expect(send({ driver: 'redfish', colour: 'blue' }, 'json-2')).rejects.toSatisfy((error: unknown) =>
      isComputeError(error, 'INVALID_INPUT'),
    );
    await expect(send({ driver: 7 }, 'json-3')).rejects.toSatisfy((error: unknown) => isComputeError(error, 'INVALID_INPUT'));
  });

  it("refuses a module kind whose payload type is not a better-compute message (config, not input)", async () => {
    const fixture = await computeFixture();
    const spec: CommandKindSpec = {
      kind: 'acme.ghost',
      lane: 'control',
      retrySafe: true,
      timeout: '2m',
      roles: ['node'],
      payload: { kind: 'message', typeName: 'acme.v1.Ghost' } as never,
    };
    const compute = await sibling(fixture, { modules: [defineModule({ name: 'ghosts', commandKinds: [spec] })] });
    const node = await seedNode(fixture.database, { tenantId: fixture.tenants.acme.id });
    await expect(
      fixture.database.transaction((tx) =>
        compute.context.commands.enqueue(tx, { nodeId: node.id, kind: 'acme.ghost', payload: { a: 1 }, idempotencyKey: 'g', notAfter: fixture.clock.now() + HOUR }),
      ),
    ).rejects.toSatisfy((error: unknown) => isComputeError(error, 'INVALID_CONFIG'));
  });

  it("pokes the node's gateway after commit only (transactions through compute's executor)", async () => {
    const { fixture, compute, notifier, node } = await setup();
    // ctx.sql (and the envelope, reconcilers, jobs) run after-commit hooks; the raw store cannot.
    const sql = compute.context.sql;
    await sql.transaction(async (tx) => {
      await compute.context.commands.enqueue(tx, {
        nodeId: node.id,
        kind: 'diag.nvml',
        payload: undefined,
        idempotencyKey: 'poke',
        notAfter: fixture.clock.now() + HOUR,
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(notifier.published).toEqual([]);
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    // The gateway notifier reads `{nodeIds}` (a dispatch now plus a spec check for those nodes).
    expect(notifier.published).toEqual([{ channel: 'gw:gw_1', message: pokeMessage([node.id]) }]);
    expect(JSON.parse(notifier.published[0]!.message!)).toEqual({ nodeIds: [node.id] });

    await expect(
      sql.transaction(async (tx) => {
        await compute.context.commands.enqueue(tx, {
          nodeId: node.id,
          kind: 'diag.nvml',
          payload: undefined,
          idempotencyKey: 'rolled-back',
          notAfter: fixture.clock.now() + HOUR,
        });
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(notifier.published).toHaveLength(1);

    // A savepoint that rolls back drops its pokes; the outer commit runs the rest.
    await sql.transaction(async (tx) => {
      await sql
        .transaction(async (inner) => {
          await compute.context.commands.enqueue(inner, {
            nodeId: node.id,
            kind: 'diag.nvml',
            payload: undefined,
            idempotencyKey: 'savepoint',
            notAfter: fixture.clock.now() + HOUR,
          });
          throw new Error('undo');
        })
        .catch(() => undefined);
      await compute.context.commands.enqueue(tx, {
        nodeId: node.id,
        kind: 'diag.nvml',
        payload: undefined,
        idempotencyKey: 'kept',
        notAfter: fixture.clock.now() + HOUR,
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(notifier.published).toHaveLength(2);
    const kept = await fixture.database.query(
      "SELECT 1 FROM commands WHERE idempotency_key = 'savepoint'",
    );
    expect(kept.rowCount).toBe(0);
  });
});

describe('CommandQueue.cancel', () => {
  it('cancels pending commands, flags in-flight ones for the gateway, ignores terminal ones', async () => {
    const { fixture, compute, notifier, enqueue } = await setup();
    const { database } = fixture;
    const pending = await enqueue({ idempotencyKey: 'p' });
    const running = await enqueue({ idempotencyKey: 'r' });
    const done = await enqueue({ idempotencyKey: 'd' });
    await database.query("UPDATE commands SET state = 'running' WHERE id = $1", [running.id]);
    await database.query("UPDATE commands SET state = 'succeeded' WHERE id = $1", [done.id]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    notifier.published.length = 0;

    for (const id of [pending.id, running.id, done.id])
      await database.transaction((tx) => compute.context.commands.cancel(tx, id));
    expect(await commandRow(database, pending.id)).toMatchObject({
      state: 'cancelled',
      reason: 'cancelled',
    });
    // In flight: the state stays; core/0004's cancel request is what the gateway re-sends.
    expect(await commandRow(database, running.id)).toMatchObject({
      state: 'running',
      reason: null,
      cancel_requested_at: new Date(fixture.clock.now()),
      cancel_reason: 'cancelled',
    });
    expect(await commandRow(database, pending.id)).toMatchObject({ cancel_requested_at: null });
    expect(await commandRow(database, done.id)).toMatchObject({
      state: 'succeeded',
      reason: null,
      cancel_requested_at: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(notifier.published.map((poke) => poke.channel)).toEqual(['gw:gw_1']);

    await expect(
      database.transaction((tx) => compute.context.commands.cancel(tx, 'cmd_missing')),
    ).rejects.toSatisfy((error: unknown) => isComputeError(error, 'NOT_FOUND'));
  });
});

describe('CommandSweeper', () => {
  it('expires pending commands past not_after and fails in-flight ones past not_after + timeout', async () => {
    const probe = defineModule({
      name: 'probe',
      reconcilers: [{ name: 'probe', shardBy: 'none', run: async () => 'DONE' }],
    });
    const fixture = await computeFixture({ modules: [probe] });
    const { compute, database, clock, advance } = fixture;
    const node = await seedNode(database, { tenantId: fixture.tenants.acme.id });
    const enqueue = (idempotencyKey: string, kind: string, notAfterIn: number) =>
      database.transaction((tx) =>
        compute.context.commands.enqueue(tx, {
          nodeId: node.id,
          kind,
          payload: undefined,
          idempotencyKey,
          notAfter: clock.now() + notAfterIn,
        }),
      );
    const stale = await enqueue('probe:owner-1:accept', 'diag.nvml', 60_000);
    const fresh = await enqueue('fresh', 'diag.nvml', 10 * 60_000);
    const stuck = await enqueue('stuck', 'diag.nvml', 60_000); // diag.nvml times out 2 min after not_after
    const rebooting = await enqueue('reboot', 'node.reboot', 60_000); // 15 min rejoin window
    await database.query(
      "UPDATE commands SET state = 'dispatched', session_epoch = 1 WHERE id = ANY($1::text[])",
      [[stuck.id, rebooting.id]],
    );

    expect(await compute.jobs['command-sweeper']!.tick()).toBe(0);
    await advance(60_000);
    expect(await compute.jobs['command-sweeper']!.tick()).toBe(1);
    expect(await commandRow(database, stale.id)).toMatchObject({
      state: 'expired',
      reason: 'not_after',
    });
    expect(await commandRow(database, stuck.id)).toMatchObject({ state: 'dispatched' });

    await advance(2 * 60_000);
    expect(await compute.jobs['command-sweeper']!.tick()).toBe(1);
    expect(await commandRow(database, stuck.id)).toMatchObject({
      state: 'failed',
      reason: 'timeout',
    });
    expect(await commandRow(database, rebooting.id)).toMatchObject({ state: 'dispatched' });
    expect(await commandRow(database, fresh.id)).toMatchObject({ state: 'pending' });

    await advance(13 * 60_000);
    expect(await compute.jobs['command-sweeper']!.tick()).toBe(2); // fresh expires, reboot times out
    expect(await commandRow(database, rebooting.id)).toMatchObject({
      state: 'failed',
      reason: 'timeout',
    });
    expect(await compute.jobs['command-sweeper']!.tick()).toBe(0);

    // Owners are woken: the node's controller, and the reconciler the key names.
    expect((await workRows(database, 'node')).map((row) => row.key)).toEqual([node.id]);
    expect((await workRows(database, 'probe')).map((row) => row.key)).toEqual(['owner-1']);
    const settled = await database.query<{
      payload: { tenantId: string; subject: string; data: { state: string } };
    }>("SELECT payload FROM outbox WHERE topic = 'command.settled' ORDER BY seq");
    expect(settled.rows.map((row) => [row.payload.subject, row.payload.data.state])).toEqual([
      [`command/${stale.id}`, 'expired'],
      [`command/${stuck.id}`, 'failed'],
      ...[
        [`command/${fresh.id}`, 'expired'],
        [`command/${rebooting.id}`, 'failed'],
      ].sort(([a], [b]) => (a! < b! ? -1 : 1)),
    ]);
    expect(settled.rows[0]!.payload.tenantId).toBe(fixture.tenants.acme.id);
  });

  it("wakes a workflow step's owner under both keys the engine uses: the node and the workflow id", async () => {
    const workflow = defineModule({
      name: 'wf-probe',
      reconcilers: [{ name: 'workflow', shardBy: 'node', run: async () => 'DONE' }],
    });
    const fixture = await computeFixture({ modules: [workflow] });
    const { compute, database, clock, advance } = fixture;
    const node = await seedNode(database, { tenantId: fixture.tenants.acme.id });
    await database.transaction((tx) =>
      compute.context.commands.enqueue(tx, {
        nodeId: node.id,
        kind: 'diag.nvml',
        payload: undefined,
        idempotencyKey: 'wf:wf_7:probe',
        notAfter: clock.now() + 60_000,
      }),
    );
    await advance(60_000);
    expect(await compute.jobs['command-sweeper']!.tick()).toBe(1);
    expect((await workRows(database, 'workflow')).map((row) => row.key).sort()).toEqual([node.id, 'wf_7'].sort());
  });

  it('runs under its singleton lease only', async () => {
    const fixture = await computeFixture();
    await fixture.database.query(
      `INSERT INTO leases (name, owner, epoch, expires_at)
       VALUES ('singleton:command-sweeper', 'other', 1, compute_now() + interval '1 minute')`,
    );
    const node = await seedNode(fixture.database, { tenantId: fixture.tenants.acme.id });
    await fixture.database.transaction((tx) =>
      fixture.compute.context.commands.enqueue(tx, {
        nodeId: node.id,
        kind: 'inventory.refresh',
        payload: undefined,
        idempotencyKey: 'k',
        notAfter: fixture.clock.now() + 1_000,
      }),
    );
    await fixture.advance(2_000);
    expect(await fixture.compute.jobs['command-sweeper']!.tick()).toBe(0);
  });
});

describe('command kinds and owners', () => {
  it('knows the v0.1 kinds with their protocol flags', () => {
    expect(builtinCommandKinds.map((spec) => spec.kind).sort()).toEqual([
      'diag.nvml',
      'gpu.reset',
      'inventory.refresh',
      'logs.collect',
      'node.reboot',
    ]);
    expect(builtinCommandKinds.find((spec) => spec.kind === 'logs.collect')).toMatchObject({
      lane: 'bulk',
      roles: ['node', 'site', 'ramdisk'],
    });
  });

  it('derives the owning reconciler from the idempotency key', () => {
    const registered = (kind: string) => ['workflow', 'probe', 'node'].includes(kind);
    expect(commandOwner('wf:wf_1:step-2', registered)).toEqual({ kind: 'workflow', key: 'wf_1' });
    expect(commandOwner('probe:k:rest', registered)).toEqual({ kind: 'probe', key: 'k' });
    expect(commandOwner('node:n1', registered)).toBeUndefined();
    expect(commandOwner('unknown:k', registered)).toBeUndefined();
    expect(commandOwner('user-key', registered)).toBeUndefined();
  });
});
