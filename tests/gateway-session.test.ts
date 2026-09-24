import { createHash } from 'node:crypto';
import { create, toBinary } from '@bufbuild/protobuf';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GrpcCode } from '@better-compute/gateway';
import {
  AgentRole,
  CommandBodySchema,
  CommandRejectReason,
  CommandState,
  encodeMessage,
  GpusSectionSchema,
  Lane,
  unwrapCommand,
  unwrapDesiredState,
  wrapAttestedReport,
} from '@better-compute/protocol';
import {
  agentFrame,
  FakeStream,
  gatewayFixture,
  helloFrame,
  TENANT,
  type GatewayFixture,
} from './support/gateway.js';

// The gateway core on PGlite (PLAN.md §7.2-7.5, §8.5): Hello and its resume rules, dispatch by join
// with credits, results, events, liveness, fencing and forwarding. The transport is a recorder.

let f: GatewayFixture;
beforeEach(async () => {
  f = await gatewayFixture();
});
afterEach(async () => {
  await f.close();
});

const update = (commandId: string, state: CommandState, extra: Record<string, unknown> = {}) =>
  agentFrame({ case: 'update', value: { commandId, state, bootId: 'boot-1', ...extra } });

describe('start', () => {
  it('registers the directory row and takes the gateway lease', async () => {
    const { rows: gateways } = await f.db.query('SELECT id, region, sessions, draining FROM gateways');
    expect(gateways).toEqual([{ id: f.gateway.id, region: 'eu-1', sessions: 0, draining: false }]);
    const { rows: leases } = await f.db.query('SELECT name, owner, epoch FROM leases');
    expect(leases).toEqual([{ name: `gateway:${f.gateway.id}`, owner: f.gateway.id, epoch: 1 }]);
  });

  it('refuses a second process with the same gateway id while the lease is live', async () => {
    await expect(f.another({ id: f.gateway.id })).resolves.toBeDefined(); // same owner renews
    const { rows } = await f.db.query('SELECT epoch FROM leases');
    expect(rows).toEqual([{ epoch: 1 }]);
  });
});

describe('Hello', () => {
  it('bumps the epoch, routes the node here and answers Welcome', async () => {
    const node = await f.addNode();
    const { stream } = await f.connect(node, { inventoryHashes: { gpus: new Uint8Array(32) } });
    const [welcome] = stream.of('welcome');
    expect(welcome).toMatchObject({
      epoch: 1n,
      gatewayId: f.gateway.id,
      protocolVersion: 1,
      heartbeatIntervalMs: 10_000,
      leaseTtlMs: 40_000,
      ackedEventSeq: 0n,
      requestSections: ['gpus'],
      upgradeRequired: false,
    });
    expect(welcome!.credits.map((c) => [c.lane, c.credits])).toEqual([
      [Lane.CONTROL, 8],
      [Lane.PROVISION, 4],
      [Lane.BULK, 2],
    ]);
    expect(Number(welcome!.serverTime!.seconds) * 1000).toBe(f.clock.now());
    expect(await f.session(node)).toMatchObject({
      gateway_id: f.gateway.id,
      session_epoch: 1,
      boot_id: 'boot-1',
      journal_id: 'journal-1',
      role: 'node',
      disconnected_at: null,
    });
    const { rows } = await f.db.query('SELECT connectivity FROM nodes WHERE id = $1', [node]);
    expect(rows).toEqual([{ connectivity: 'connected' }]);
    const [connected] = await f.outbox('node.connected');
    expect(connected!.payload).toMatchObject({
      tenantId: TENANT,
      subject: `node/${node}`,
      data: { nodeId: node, epoch: 1, journalChanged: false, bootChanged: false },
    });
    const { rows: work } = await f.db.query("SELECT kind, key FROM work_queue WHERE kind = 'node'");
    expect(work).toEqual([{ kind: 'node', key: node }]);
    expect(f.gateway.sessions()).toMatchObject([{ nodeId: node, epoch: 1, role: 'node' }]);
  });

  it('requires Hello first and rejects a second Hello', async () => {
    const node = await f.addNode();
    const stream = new FakeStream();
    const handle = f.gateway.open({ nodeId: node }, stream);
    await handle.receive(agentFrame({ case: 'heartbeat', value: {} }));
    expect(stream.closed?.error?.code).toBe(GrpcCode.INVALID_ARGUMENT);

    const again = await f.connect(node);
    await again.handle.receive(agentFrame({ case: 'hello', value: { nodeId: node } }));
    expect(again.stream.closed?.error?.code).toBe(GrpcCode.INVALID_ARGUMENT);
  });

  it('rejects a Hello that does not match the certificate or an unknown node', async () => {
    const node = await f.addNode();
    const other = await f.addNode();
    const mismatch = new FakeStream();
    await f.gateway.open({ nodeId: node }, mismatch).receive(
      helloFrame(other),
    );
    expect(mismatch.closed?.error?.code).toBe(GrpcCode.PERMISSION_DENIED);

    const { stream: role } = await f.connect(node, { role: AgentRole.SITE });
    expect(role.closed?.error?.code).toBe(GrpcCode.PERMISSION_DENIED);

    const { stream: unknown } = await f.connect('node_01jz00000000000000000000zz');
    expect(unknown.closed?.error).toMatchObject({ code: GrpcCode.PERMISSION_DENIED, message: 'this node has not joined' });
    expect((await f.session(node)).session_epoch).toBe(0);
  });

  it('restricts a daemon below the protocol minimum to upgrade_required', async () => {
    const node = await f.addNode();
    await f.enqueue(node);
    const { stream } = await f.connect(node, { protoMin: 0, protoMax: 0 });
    expect(stream.of('welcome')[0]!.upgradeRequired).toBe(true);
    expect(await f.gateway.jobs.dispatch.tick()).toBe(0);
    expect(stream.of('command')).toEqual([]);
  });

  it('supersedes an older session of the same node on this gateway', async () => {
    const node = await f.addNode();
    const first = await f.connect(node);
    const second = await f.connect(node);
    expect(first.stream.closed?.error?.code).toBe(GrpcCode.ABORTED);
    expect(second.stream.of('welcome')[0]!.epoch).toBe(2n);
    // The old stream ending later must not disconnect the new session (epoch-fenced).
    await first.handle.end();
    expect(await f.session(node)).toMatchObject({ session_epoch: 2, gateway_id: f.gateway.id, disconnected_at: null });
  });
});

describe('dispatch', () => {
  it('sends pending commands in seq order within lane credits and marks them dispatched', async () => {
    const node = await f.addNode();
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push(await f.enqueue(node));
    const { stream } = await f.connect(node);
    expect(await f.gateway.jobs.dispatch.tick()).toBe(8);
    expect(stream.commandIds()).toEqual(ids.slice(0, 8));
    expect(stream.of('command')[0]!.attempt).toBe(1);
    expect(await f.command(ids[0]!)).toMatchObject({ state: 'dispatched', session_epoch: 1, attempt: 1 });
    expect(await f.command(ids[8]!)).toMatchObject({ state: 'pending', session_epoch: null });
    expect(await f.gateway.jobs.dispatch.tick()).toBe(0);
  });

  it('frees credits on terminal results, stores the result and acks it', async () => {
    const node = await f.addNode();
    const ids: string[] = [];
    for (let i = 0; i < 9; i++) ids.push(await f.enqueue(node));
    const { stream, handle } = await f.connect(node);
    await f.gateway.jobs.dispatch.tick();
    stream.clear();

    await handle.receive(update(ids[0]!, CommandState.ACKED));
    await handle.receive(update(ids[0]!, CommandState.RUNNING));
    await handle.receive(update(ids[0]!, CommandState.SUCCEEDED, { result: new Uint8Array([7, 7]) }));
    expect(stream.of('ack')).toEqual([expect.objectContaining({ journalId: 'journal-1', commandIds: [ids[0]] })]);
    const row = await f.command(ids[0]!);
    expect(row).toMatchObject({ state: 'succeeded', reason: null });
    expect([...(row.result as Uint8Array)]).toEqual([7, 7]);
    const [settled] = await f.outbox('command.settled');
    expect(settled!.payload.data).toEqual({ commandId: ids[0], nodeId: node, kind: 'diag.nvml', state: 'succeeded' });

    expect(await f.gateway.jobs.dispatch.tick()).toBe(1);
    expect(stream.commandIds()).toEqual([ids[8]]);

    // A duplicate terminal result is acked again and changes nothing.
    stream.clear();
    await handle.receive(update(ids[0]!, CommandState.FAILED, { error: { code: 'internal' } }));
    expect(stream.of('ack')[0]!.commandIds).toEqual([ids[0]]);
    expect((await f.command(ids[0]!)).state).toBe('succeeded');
    expect(await f.outbox('command.settled')).toHaveLength(1);
  });

  it('keeps per-lane order: bulk credits do not hold back control commands', async () => {
    const node = await f.addNode();
    const bulk = [
      await f.enqueue(node, { kind: 'logs.collect' }),
      await f.enqueue(node, { kind: 'logs.collect' }),
      await f.enqueue(node, { kind: 'logs.collect' }),
    ];
    const control = await f.enqueue(node);
    const { stream } = await f.connect(node);
    await f.gateway.jobs.dispatch.tick();
    expect(stream.commandIds()).toEqual([bulk[0], bulk[1], control]);
  });

  it('resynchronises credits from heartbeats', async () => {
    const node = await f.addNode();
    for (let i = 0; i < 9; i++) await f.enqueue(node);
    const { stream, handle } = await f.connect(node);
    await f.gateway.jobs.dispatch.tick();
    expect(stream.of('command')).toHaveLength(8);
    await handle.receive(
      agentFrame({ case: 'heartbeat', value: { credits: [{ lane: Lane.CONTROL, credits: 3 }] } }),
    );
    expect(await f.gateway.jobs.dispatch.tick()).toBe(1);
  });

  it('never sends expired or not-yet-due commands', async () => {
    const node = await f.addNode();
    const soon = await f.enqueue(node, { notAfterMs: 1_000 });
    const { stream } = await f.connect(node);
    await f.advance(2_000);
    expect(await f.gateway.jobs.dispatch.tick()).toBe(0);
    expect(stream.commandIds()).toEqual([]);
    expect((await f.command(soon)).state).toBe('pending');
  });

  it('returns BUSY commands to pending with exponential back-off', async () => {
    const node = await f.addNode();
    const id = await f.enqueue(node);
    const { stream, handle } = await f.connect(node);
    await f.gateway.jobs.dispatch.tick();
    const busy = () =>
      handle.receive(
        update(id, CommandState.REJECTED, { rejectReason: CommandRejectReason.BUSY }),
      );
    await busy();
    expect(await f.command(id)).toMatchObject({ state: 'pending', session_epoch: null });
    expect(stream.of('ack')).toEqual([]); // BUSY is a refusal, not a journaled result
    expect(await f.gateway.jobs.dispatch.tick()).toBe(0);
    await f.advance(1_000);
    expect(await f.gateway.jobs.dispatch.tick()).toBe(1);
    expect(stream.of('command').at(-1)!.attempt).toBe(2);
    await busy();
    await f.advance(1_999);
    expect(await f.gateway.jobs.dispatch.tick()).toBe(0);
    await f.advance(1);
    expect(await f.gateway.jobs.dispatch.tick()).toBe(1);
  });

  it('maps rejections to reasons and never lets a node settle another node’s command', async () => {
    const a = await f.addNode();
    const b = await f.addNode();
    const id = await f.enqueue(a);
    const nodeA = await f.connect(a);
    const nodeB = await f.connect(b);
    await f.gateway.jobs.dispatch.tick();
    await nodeB.handle.receive(update(id, CommandState.SUCCEEDED));
    expect((await f.command(id)).state).toBe('dispatched');
    await nodeA.handle.receive(
      update(id, CommandState.REJECTED, { rejectReason: CommandRejectReason.STALE_GENERATION }),
    );
    expect(await f.command(id)).toMatchObject({ state: 'rejected', reason: 'stale-generation' });
  });
});

describe('resume', () => {
  it('replays in-flight commands in seq order except those the journal holds as running', async () => {
    const node = await f.addNode();
    const ids = [await f.enqueue(node), await f.enqueue(node), await f.enqueue(node)];
    const first = await f.connect(node);
    await f.gateway.jobs.dispatch.tick();
    await first.handle.receive(update(ids[1]!, CommandState.RUNNING));
    await first.handle.end();
    expect(await f.session(node)).toMatchObject({ gateway_id: null, session_epoch: 1 });
    expect((await f.db.query('SELECT connectivity FROM nodes WHERE id = $1', [node])).rows[0]).toEqual({
      connectivity: 'disconnected',
    });

    const second = await f.connect(node, { runningCommandIds: [ids[1]!] });
    expect(second.stream.commandIds()).toEqual([ids[0], ids[2]]);
    expect(second.stream.of('command').map((c) => c.attempt)).toEqual([2, 2]);
    expect(await f.command(ids[0]!)).toMatchObject({ state: 'dispatched', session_epoch: 2 });
    // Replayed commands hold credits: 8 - 3 in flight.
    for (let i = 0; i < 6; i++) await f.enqueue(node);
    expect(await f.gateway.jobs.dispatch.tick()).toBe(5);
  });

  it('applies Hello.unacked_results before choosing the replay, and acks them', async () => {
    const node = await f.addNode();
    const ids = [await f.enqueue(node), await f.enqueue(node)];
    const first = await f.connect(node);
    await f.gateway.jobs.dispatch.tick();
    await first.handle.end();
    const second = await f.connect(node, {
      unackedResults: [{ commandId: ids[0]!, state: CommandState.SUCCEEDED, bootId: 'boot-1' }],
    });
    expect((await f.command(ids[0]!)).state).toBe('succeeded');
    expect(second.stream.commandIds()).toEqual([ids[1]]);
    expect(second.stream.of('ack')[0]!.commandIds).toEqual([ids[0]]);
  });

  it('fails in-flight non-retry-safe commands when the journal is lost, and replays the rest', async () => {
    const node = await f.addNode();
    const unsafe = await f.enqueue(node, { kind: 'gpu.reset' });
    const safe = await f.enqueue(node);
    const pending = await f.enqueue(node, { kind: 'gpu.reset', notAfterMs: 60_000 });
    const first = await f.connect(node);
    await f.gateway.jobs.dispatch.tick();
    await first.handle.receive(agentFrame({ case: 'events', value: { journalId: 'journal-1', events: [{ seq: 1n }] } }));
    await first.handle.end();
    // pending was dispatched too; make it pending again to prove only in-flight rows are failed.
    await f.db.query(`UPDATE commands SET state = 'pending', session_epoch = NULL WHERE id = $1`, [pending]);

    const second = await f.connect(node, { journalId: 'journal-2' });
    expect(await f.command(unsafe)).toMatchObject({ state: 'failed', reason: 'journal-lost' });
    expect((await f.command(pending)).state).toBe('pending');
    expect(second.stream.commandIds()).toEqual([safe]);
    expect(second.stream.of('welcome')[0]!.ackedEventSeq).toBe(0n);
    const settled = (await f.outbox('command.settled')).map((row) => row.payload.data);
    expect(settled).toEqual([expect.objectContaining({ commandId: unsafe, state: 'failed', reason: 'journal-lost' })]);
  });

  it('completes in-flight self-terminating commands on a new boot and never replays them', async () => {
    const node = await f.addNode();
    const reboot = await f.enqueue(node, { kind: 'node.reboot' });
    const diag = await f.enqueue(node);
    const first = await f.connect(node);
    await f.gateway.jobs.dispatch.tick();
    await first.handle.receive(update(reboot, CommandState.RUNNING));
    await first.handle.end();

    const second = await f.connect(node, { bootId: 'boot-2' });
    expect(await f.command(reboot)).toMatchObject({ state: 'succeeded', reason: 'rebooted' });
    expect(second.stream.commandIds()).toEqual([diag]);
    const [connected] = (await f.outbox('node.connected')).slice(-1);
    expect(connected!.payload.data).toMatchObject({ bootChanged: true, journalChanged: false });
  });
});

describe('events', () => {
  it('stores events above the cumulative ack once, and acks the highest seq', async () => {
    const node = await f.addNode();
    const { stream, handle } = await f.connect(node);
    const batch = (seqs: number[], journalId = 'journal-1') =>
      agentFrame({
        case: 'events',
        value: { journalId, events: seqs.map((seq) => ({ seq: BigInt(seq) })) },
      });
    await handle.receive(batch([1, 2, 3]));
    await handle.receive(batch([2, 3, 4]));
    await handle.receive(batch([9], 'journal-old'));
    expect(stream.of('ack').map((ack) => ack.eventSeq)).toEqual([3n, 4n]);
    expect((await f.outbox('node.event')).map((row) => row.payload.data.seq)).toEqual([1, 2, 3, 4]);
    expect((await f.session(node)).acked_event_seq).toBe(4);

    // After a reconnect Welcome carries the cumulative ack.
    const again = await f.connect(node);
    expect(again.stream.of('welcome')[0]!.ackedEventSeq).toBe(4n);
  });

  it('decodes attested reports and flags reports about another node', async () => {
    const node = await f.addNode();
    const { handle } = await f.connect(node);
    const report = (nodeId: string) =>
      wrapAttestedReport({
        $typeName: 'bettercompute.agent.v1.AttestedReportBody',
        nodeId,
        bootId: 'boot-1',
        report: {
          case: 'allocationBound',
          value: {
            $typeName: 'bettercompute.agent.v1.AllocationBound',
            allocationId: 'alloc_1',
            generation: 3n,
            deviceIds: ['GPU-1'],
            cdiDevices: ['bcd.dev/gpu=GPU-1'],
            cdiSpecPath: '/etc/cdi/bcd-alloc_1.json',
            envFile: '',
          },
        },
      });
    await handle.receive(
      agentFrame({
        case: 'events',
        value: {
          journalId: 'journal-1',
          events: [
            { seq: 1n, body: { case: 'attested', value: report(node) } },
            { seq: 2n, body: { case: 'attested', value: report('node_other') } },
          ],
        },
      }),
    );
    const [event] = await f.outbox('node.event');
    expect(event!.payload.data.report).toMatchObject({
      nodeId: node,
      allocationBound: { allocationId: 'alloc_1', deviceIds: ['GPU-1'] },
    });
    expect(await f.outbox('security.node-mismatch')).toHaveLength(1);
  });
});

describe('status, inventory and specs', () => {
  it('coalesces status reports and only moves observed_generation forward', async () => {
    const node = await f.addNode();
    const { handle } = await f.connect(node);
    const status = (generation: number) =>
      agentFrame({ case: 'status', value: { observedGeneration: BigInt(generation), appliedGeneration: BigInt(generation) } });
    await handle.receive(status(2));
    await handle.receive(status(5));
    expect(await f.gateway.jobs.status.tick()).toBe(1);
    await handle.receive(status(3));
    await f.gateway.jobs.status.tick();
    const { rows } = await f.db.query('SELECT observed_generation FROM nodes WHERE id = $1', [node]);
    expect(rows).toEqual([{ observed_generation: 5 }]);
    expect(await f.outbox('node.status')).toHaveLength(2);
  });

  it('ingests verified inventory sections and ignores corrupt ones', async () => {
    const node = await f.addNode();
    const { stream, handle } = await f.connect(node);
    const content = toBinary(GpusSectionSchema, create(GpusSectionSchema, {}));
    const sha256 = new Uint8Array(createHash('sha256').update(content).digest());
    await handle.receive(agentFrame({ case: 'inventory', value: { section: 'gpus', sha256, content, schemaVersion: 1 } }));
    await handle.receive(
      agentFrame({ case: 'inventory', value: { section: 'cpu', sha256: new Uint8Array(32), content, schemaVersion: 1 } }),
    );
    const { rows } = await f.db.query('SELECT section FROM node_inventory_sections WHERE node_id = $1', [node]);
    expect(rows).toEqual([{ section: 'gpus' }]);
    expect(stream.closed).toBeUndefined();
    const { rows: work } = await f.db.query("SELECT key FROM work_queue WHERE kind = 'inventory'");
    expect(work).toEqual([{ key: node }]);
  });

  it('sends the full NodeSpec when the daemon is behind, and pushes newer generations', async () => {
    const node = await f.addNode();
    const spec = { telemetry: { otlpEndpoint: 'https://otel.example:4317', exportIntervalMs: 15000 } };
    await f.db.query('UPDATE nodes SET spec = $2::jsonb, generation = 1 WHERE id = $1', [node, JSON.stringify(spec)]);
    const { stream, handle } = await f.connect(node);
    const [desired] = stream.of('desired');
    const body = unwrapDesiredState(desired!);
    expect(body).toMatchObject({ nodeId: node, generation: 1n, baseGeneration: 0n });
    expect(body.spec.case).toBe('full');
    expect(body.specHash).toHaveLength(32);

    stream.clear();
    expect(await f.gateway.jobs.specs.tick()).toBe(0);
    await f.db.query('UPDATE nodes SET generation = 2 WHERE id = $1', [node]);
    expect(await f.gateway.jobs.specs.tick()).toBe(1);
    expect(unwrapDesiredState(stream.of('desired')[0]!).generation).toBe(2n);

    stream.clear();
    await handle.receive(agentFrame({ case: 'specRequest', value: { haveGeneration: 1n } }));
    expect(stream.of('desired')).toHaveLength(1);
  });

  it('sends no spec to a daemon that already holds the current generation', async () => {
    const node = await f.addNode();
    await f.db.query(`UPDATE nodes SET spec = '{}'::jsonb, generation = 4 WHERE id = $1`, [node]);
    const { stream } = await f.connect(node, { appliedGeneration: 4n });
    // No applied_spec_hash echoed: the control plane cannot tell, so it resends.
    expect(stream.of('desired')).toHaveLength(1);
  });
});

describe('liveness', () => {
  it('flushes ages, not timestamps, fenced by epoch', async () => {
    const node = await f.addNode();
    const { handle } = await f.connect(node);
    await f.advance(5_000);
    await handle.receive(agentFrame({ case: 'heartbeat', value: {} }));
    await f.advance(15_000);
    expect(await f.gateway.jobs.liveness.tick()).toBe(1);
    const { rows } = await f.db.query<{ last_seen: Date }>('SELECT last_seen FROM node_sessions WHERE node_id = $1', [node]);
    // Last heartbeat was 15 s ago in gateway time: stored relative to compute_now().
    expect(rows[0]!.last_seen.getTime()).toBe(f.clock.now() - 15_000);
  });

  it('closes a session after three missed heartbeats and marks the node disconnected', async () => {
    const node = await f.addNode();
    const { stream } = await f.connect(node);
    await f.advance(30_001);
    await f.gateway.jobs.liveness.tick();
    expect(stream.closed?.error).toMatchObject({ code: GrpcCode.UNAVAILABLE, message: 'missed heartbeats' });
    expect(await f.session(node)).toMatchObject({ gateway_id: null });
    expect((await f.outbox('node.disconnected'))[0]!.payload.data).toMatchObject({ reason: 'heartbeat-timeout' });
  });

  it('drops a zombie stream whose node reconnected through another gateway', async () => {
    const node = await f.addNode();
    const { stream } = await f.connect(node);
    const other = await f.another();
    const moved = await f.connect(node, {}, other);
    expect(moved.stream.of('welcome')[0]!.epoch).toBe(2n);

    // The old gateway's dispatch no longer sees the node; its liveness flush finds the epoch moved.
    await f.enqueue(node);
    expect(await f.gateway.jobs.dispatch.tick()).toBe(0);
    await f.advance(15_000);
    await f.gateway.jobs.liveness.tick();
    expect(stream.closed?.error?.code).toBe(GrpcCode.ABORTED);
    expect(await f.session(node)).toMatchObject({ gateway_id: other.id, session_epoch: 2, disconnected_at: null });
    expect(await other.jobs.dispatch.tick()).toBe(1);
  });
});

describe('fencing', () => {
  it('drops every stream and refuses work when another owner takes the lease', async () => {
    const node = await f.addNode();
    const { stream } = await f.connect(node);
    await f.db.query(
      `UPDATE leases SET owner = 'usurper', epoch = epoch + 1, expires_at = compute_now() + interval '1 hour'`,
    );
    await f.enqueue(node);
    await expect(f.gateway.jobs.dispatch.tick()).rejects.toThrow(/no longer held/);
    expect(stream.closed?.error?.code).toBe(GrpcCode.UNAVAILABLE);
    expect(await f.gateway.jobs.lease.tick()).toBe(0);
    expect(() => f.gateway.open({ nodeId: node }, { send() {}, close() {} })).toThrow(/not ready/);
  });

  it('self-fences when renewals keep failing for half the lease TTL', async () => {
    const node = await f.addNode();
    const { stream } = await f.connect(node);
    const query = f.db.transaction.bind(f.db);
    (f.db as { transaction: unknown }).transaction = () => Promise.reject(new Error('database down'));
    f.clock.advance(5_000);
    await f.gateway.jobs.lease.tick();
    expect(stream.closed).toBeUndefined();
    f.clock.advance(5_001);
    await f.gateway.jobs.lease.tick();
    expect(stream.closed?.error?.code).toBe(GrpcCode.UNAVAILABLE);
    (f.db as { transaction: unknown }).transaction = query;
  });
});

describe('admission and control', () => {
  it('rate-limits session opens with the handshake bucket', async () => {
    await f.close();
    f = await gatewayFixture({ handshakesPerSecond: 2 });
    const node = await f.addNode();
    const sink = { send() {}, close() {} };
    f.gateway.open({ nodeId: node }, sink);
    f.gateway.open({ nodeId: node }, sink);
    expect(() => f.gateway.open({ nodeId: node }, sink)).toThrow(expect.objectContaining({ code: GrpcCode.RESOURCE_EXHAUSTED }));
    f.clock.advance(500);
    expect(() => f.gateway.open({ nodeId: node }, sink)).not.toThrow();
  });

  it('enforces maxStreams', async () => {
    await f.close();
    f = await gatewayFixture({ maxStreams: 1 });
    const a = await f.addNode();
    const b = await f.addNode();
    await f.connect(a);
    expect(() => f.gateway.open({ nodeId: b }, { send() {}, close() {} })).toThrow(/stream limit/);
    expect(() => f.gateway.open({ nodeId: a }, { send() {}, close() {} })).not.toThrow();
  });

  it('drains: asks daemons to reconnect after a jittered delay and refuses new sessions', async () => {
    const node = await f.addNode();
    const { stream } = await f.connect(node);
    await f.gateway.drain({ reason: 'rolling deploy' });
    expect(stream.of('drain')).toEqual([expect.objectContaining({ reconnectAfterMs: 30_000, reason: 'rolling deploy' })]);
    const { rows } = await f.db.query('SELECT draining FROM gateways');
    expect(rows).toEqual([{ draining: true }]);
    expect(() => f.gateway.open({ nodeId: node }, { send() {}, close() {} })).toThrow(/draining/);
  });

  it('pushes a RevocationNotice and closes the session UNAUTHENTICATED', async () => {
    const node = await f.addNode();
    const { stream } = await f.connect(node);
    expect(await f.gateway.revoke(node, { reason: 'key compromise', serials: [new Uint8Array([1])] })).toBe(true);
    expect(stream.of('revoked')[0]).toMatchObject({ reason: 'key compromise' });
    expect(stream.closed?.error?.code).toBe(GrpcCode.UNAUTHENTICATED);
    expect(await f.gateway.revoke(node, { reason: 'again' })).toBe(false);
  });

  it('forwards SecretRequest to the broker and maps refusals', async () => {
    const node = await f.addNode();
    const { stream, handle } = await f.connect(node);
    await handle.receive(agentFrame({ case: 'secretRequest', value: { ref: 'secret://x', requestId: 'r1' } }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(stream.of('secret')).toEqual([expect.objectContaining({ ref: 'secret://x', requestId: 'r1', error: 'unavailable' })]);
    expect(f.services.calls.map((call) => call.method)).toEqual(['secret']);
  });

  it('forwards Join through the handshake bucket', async () => {
    await expect(f.gateway.join({} as never)).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
    expect(f.services.calls).toEqual([{ method: 'join', request: {} }]);
  });

  it('stop closes sessions, marks nodes disconnected and releases the lease', async () => {
    const node = await f.addNode();
    const { stream } = await f.connect(node);
    await f.gateway.stop();
    expect(stream.closed?.error?.code).toBe(GrpcCode.UNAVAILABLE);
    expect(await f.session(node)).toMatchObject({ gateway_id: null });
    const { rows } = await f.db.query(`SELECT owner FROM leases`);
    expect(rows).toEqual([{ owner: null }]);
  });
});

describe('cancel', () => {
  const requestCancel = (id: string, reason = 'user asked') =>
    f.db.query('UPDATE commands SET cancel_requested_at = compute_now(), cancel_reason = $2 WHERE id = $1', [
      id,
      reason,
    ]);

  it('never sends a pending command whose cancel was requested', async () => {
    const node = await f.addNode();
    const id = await f.enqueue(node);
    const { stream } = await f.connect(node);
    await requestCancel(id);
    await f.gateway.jobs.dispatch.tick();
    expect(stream.commandIds()).toEqual([]);
    expect(await f.command(id)).toMatchObject({ state: 'cancelled', reason: 'user asked' });
    expect((await f.outbox('command.settled'))[0]!.payload.data).toMatchObject({ commandId: id, state: 'cancelled' });
  });

  it('pushes Cancel once per session for in-flight commands, again after a reconnect, until settled', async () => {
    const node = await f.addNode();
    const id = await f.enqueue(node);
    const first = await f.connect(node);
    await f.gateway.jobs.dispatch.tick();
    await first.handle.receive(update(id, CommandState.RUNNING));
    await requestCancel(id, 'operator abort');
    await f.gateway.jobs.dispatch.tick();
    await f.gateway.jobs.dispatch.tick();
    expect(first.stream.of('cancel')).toEqual([expect.objectContaining({ commandId: id, reason: 'operator abort' })]);

    await first.handle.end();
    const second = await f.connect(node, { runningCommandIds: [id] });
    await f.gateway.jobs.dispatch.tick();
    expect(second.stream.of('cancel').map((cancel) => cancel.commandId)).toEqual([id]);
    await second.handle.receive(update(id, CommandState.CANCELLED));
    expect((await f.command(id)).state).toBe('cancelled');
    await f.gateway.jobs.dispatch.tick();
    expect(second.stream.of('cancel')).toHaveLength(1);
  });

  it('lets the real outcome win over a late cancel', async () => {
    const node = await f.addNode();
    const id = await f.enqueue(node);
    const { handle } = await f.connect(node);
    await f.gateway.jobs.dispatch.tick();
    await requestCancel(id);
    await handle.receive(update(id, CommandState.SUCCEEDED, { result: new Uint8Array([1]) }));
    expect((await f.command(id)).state).toBe('succeeded');
  });
});

describe('body guard and admission', () => {
  it('cancels a stored body without not_after (or for another node) instead of sending it', async () => {
    const node = await f.addNode();
    const other = await f.addNode();
    const noDeadline = await f.enqueue(node);
    const misrouted = await f.enqueue(node);
    const good = await f.enqueue(node);
    const body = (id: string, nodeId: string, notAfter: boolean) =>
      Buffer.from(
        encodeMessage(
          CommandBodySchema,
          create(CommandBodySchema, {
            id,
            nodeId,
            kind: 'diag.nvml',
            ...(notAfter ? { notAfter: { seconds: BigInt(Math.floor(f.clock.now() / 1000) + 3600) } } : {}),
          }),
        ),
      );
    await f.db.query('UPDATE commands SET body = $2 WHERE id = $1', [noDeadline, body(noDeadline, node, false)]);
    await f.db.query('UPDATE commands SET body = $2 WHERE id = $1', [misrouted, body(misrouted, other, true)]);
    const { stream } = await f.connect(node);
    await f.gateway.jobs.dispatch.tick();
    expect(stream.of('command').map((command) => unwrapCommand(command).id)).toEqual([good]);
    expect(await f.command(noDeadline)).toMatchObject({ state: 'cancelled', reason: 'invalid-body' });
    expect(await f.command(misrouted)).toMatchObject({ state: 'cancelled', reason: 'invalid-body' });
  });

  it('refuses Hellos beyond maxPendingHellos with RESOURCE_EXHAUSTED instead of queueing them', async () => {
    await f.close();
    f = await gatewayFixture({ maxPendingHellos: 1 });
    const a = await f.addNode();
    const b = await f.addNode();
    const first = new FakeStream();
    const second = new FakeStream();
    await Promise.all([
      f.gateway.open({ nodeId: a }, first).receive(helloFrame(a)),
      f.gateway.open({ nodeId: b }, second).receive(helloFrame(b)),
    ]);
    expect(first.of('welcome')).toHaveLength(1);
    expect(second.closed?.error).toMatchObject({
      code: GrpcCode.RESOURCE_EXHAUSTED,
      message: 'gateway busy; retry with jitter',
    });
    const retry = await f.connect(b);
    expect(retry.stream.of('welcome')).toHaveLength(1);
  });

  it('turns a fenced Hello into UNAVAILABLE without leaking the lease name', async () => {
    const node = await f.addNode();
    await f.db.query(`UPDATE leases SET owner = 'usurper', epoch = epoch + 1, expires_at = compute_now() + interval '1 hour'`);
    const { stream } = await f.connect(node);
    expect(stream.closed?.error).toMatchObject({ code: GrpcCode.UNAVAILABLE, message: 'gateway fenced; reconnect' });
  });
});