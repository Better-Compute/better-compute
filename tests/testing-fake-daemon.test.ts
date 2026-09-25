import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { WireType } from '@bufbuild/protobuf/wire';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AgentRole,
  Binding,
  CommandRejectReason,
  CommandState,
  ConditionStatus,
  INVENTORY_SECTIONS,
  Lane,
  NodeSpecSchema,
  SectionState,
  SpecRequestReason,
  decodeCommandResult,
  decodeInventorySection,
  unwrapAttestedReport,
  type CommandUpdate,
  type Event,
} from '@better-compute/protocol';
import {
  COMMAND_TTL_MS,
  JournalError,
  MemoryJournal,
  REASON_INTERRUPTED,
  accept,
  ackResult,
  cdiSpecPath,
  complete,
  createDaemonHarness,
  encodeInventorySections,
  envFilePath,
  fakeGpuReset,
  fakeHardware,
  markRunning,
  recover,
  resolve,
  sweep,
  type Action,
  type DaemonFact,
  type DaemonHarness,
  type DaemonHarnessOptions,
  type Delivery,
  type Runtime,
} from '@better-compute/testing';

// FakeDaemon (PLAN.md §6, §7): the journal rules mirrored from daemon/internal/journal, the
// acceptance checks in dispatch.Precheck order, duplicate delivery, self-terminating kinds, journal
// loss, desired state with the devices converger, events, and the v0.1 kinds. Deterministic: every
// test runs on a sim scheduler.

const T0 = Date.UTC(2026, 8, 23, 12);
const sha256 = (bytes: Uint8Array) => new Uint8Array(createHash('sha256').update(bytes).digest());

// ---- journal rules (a line-by-line port of daemon/internal/journal/journal_test.go) -------------

const rt = (bootId: string, incarnation: string): Runtime => ({ bootId, incarnation, now: T0 });

function deliverNew(j: MemoryJournal, d: Delivery, runtime: Runtime) {
  expect(resolve(j, d, runtime).action).toBe('execute');
  accept(j, d, runtime);
}

describe('journal rules (mirrors journal_test.go)', () => {
  it('a done command resends its stored result, in this process, after a restart and after a reboot', () => {
    const j = new MemoryJournal('node_1');
    const first = rt('boot-1', 'inc-1');
    const d: Delivery = { id: 'cmd_1', kind: 'diag.nvml', retrySafe: true, selfTerminating: false };
    deliverNew(j, d, first);
    markRunning(j, d.id, first);
    const want = { outcome: 'succeeded' as const, payload: new TextEncoder().encode('{"gpus":8}') };
    complete(j, d.id, want, T0);
    for (const runtime of [first, rt('boot-1', 'inc-2'), rt('boot-2', 'inc-3')]) {
      const decision = resolve(j, d, runtime);
      expect(decision.action).toBe('resend');
      expect(decision.result).toEqual(want);
    }
  });

  it('an in-flight command re-attaches in its own process', () => {
    const j = new MemoryJournal('node_1');
    const runtime = rt('boot-1', 'inc-1');
    const d: Delivery = { id: 'cmd_1', kind: 'wipe', retrySafe: false, selfTerminating: false };
    deliverNew(j, d, runtime);
    expect(resolve(j, d, runtime).action).toBe('reattach');
    markRunning(j, d.id, runtime);
    expect(resolve(j, d, runtime).action).toBe('reattach');
    expect(j.command(d.id)).toMatchObject({ state: 'running', bootId: 'boot-1' });
  });

  const cases: [string, boolean, boolean, boolean, boolean, Action, string, boolean][] = [
    ['accepted, not retry-safe', false, false, false, false, 'report', 'failed', false],
    ['accepted, retry-safe', false, true, false, false, 'reexecute', '', false],
    ['running, not retry-safe', true, false, false, false, 'report', 'failed', false],
    ['running, retry-safe', true, true, false, false, 'reexecute', '', false],
    [
      'self-terminating running across a reboot',
      true,
      false,
      true,
      true,
      'report',
      'succeeded',
      true,
    ],
    [
      'retry-safe self-terminating running across a reboot is never replayed',
      true,
      true,
      true,
      true,
      'report',
      'succeeded',
      true,
    ],
    ['self-terminating running, same boot', true, false, true, false, 'report', 'failed', false],
    [
      'self-terminating accepted, never started, across a reboot',
      false,
      false,
      true,
      true,
      'report',
      'failed',
      false,
    ],
    [
      'retry-safe self-terminating accepted across a reboot',
      false,
      true,
      true,
      true,
      'reexecute',
      '',
      false,
    ],
  ];
  it.each(cases)(
    'crash rule: %s',
    (_name, running, retrySafe, selfTerminating, rebooted, want, outcome, wantRebooted) => {
      const j = new MemoryJournal('node_1');
      const before = rt('boot-1', 'inc-1');
      const after = rt(rebooted ? 'boot-2' : 'boot-1', 'inc-2');
      const d: Delivery = { id: 'cmd_1', kind: 'k', retrySafe, selfTerminating };
      deliverNew(j, d, before);
      if (running) markRunning(j, d.id, before);
      const decision = resolve(j, d, after);
      expect(decision.action).toBe(want);
      if (want === 'reexecute') {
        // resolve() writes nothing: the dispatcher re-runs the checks, then accepts again.
        accept(j, d, after);
        expect(resolve(j, d, after).action).toBe('reattach');
        return;
      }
      expect(decision.result?.outcome).toBe(outcome);
      expect(decision.result?.rebooted === true).toBe(wantRebooted);
      if (outcome === 'failed') expect(decision.result!.reason).toBe(REASON_INTERRUPTED);
      // The outcome is journaled, so the next duplicate resends it instead of deciding again.
      const again = resolve(j, d, after);
      expect(again.action).toBe('resend');
      expect(again.result).toEqual(decision.result);
    },
  );

  it('judges entries by the flags stored at acceptance, not the redelivered copy', () => {
    const j = new MemoryJournal('node_1');
    const d: Delivery = { id: 'cmd_1', kind: 'wipe', retrySafe: false, selfTerminating: false };
    deliverNew(j, d, rt('boot-1', 'inc-1'));
    const decision = resolve(j, { ...d, retrySafe: true }, rt('boot-1', 'inc-2'));
    expect(decision).toMatchObject({ action: 'report', result: { outcome: 'failed' } });
  });

  it('recover() completes what needs no server input and leaves retry-safe entries for redelivery', () => {
    const j = new MemoryJournal('node_1');
    const before = rt('boot-1', 'inc-1');
    const deliveries: Delivery[] = [
      { id: 'a-reboot', kind: 'node.reboot', retrySafe: false, selfTerminating: true },
      { id: 'b-wipe', kind: 'wipe', retrySafe: false, selfTerminating: false },
      { id: 'c-refresh', kind: 'inventory.refresh', retrySafe: true, selfTerminating: false },
      { id: 'd-diag', kind: 'diag.nvml', retrySafe: true, selfTerminating: false },
    ];
    for (const d of deliveries) deliverNew(j, d, before);
    markRunning(j, 'a-reboot', before);
    complete(j, 'd-diag', { outcome: 'succeeded' }, T0);
    const after = rt('boot-2', 'inc-2');
    const completed = recover(j, after);
    expect(completed.map((c) => c.id)).toEqual(['a-reboot', 'b-wipe']);
    expect(completed[0]!.result).toMatchObject({ outcome: 'succeeded', rebooted: true });
    expect(completed[1]!.result).toMatchObject({ outcome: 'failed', reason: REASON_INTERRUPTED });
    expect(completed.every((c) => !c.resultAcked)).toBe(true);
    expect(resolve(j, deliveries[2]!, after).action).toBe('reexecute');
    expect(recover(j, after)).toEqual([]);
  });

  it('sweep() drops done commands past the TTL and never accepted or running ones', () => {
    const j = new MemoryJournal('node_1');
    const runtime = rt('boot-1', 'inc-1');
    for (const id of ['old', 'recent', 'pending'])
      deliverNew(j, { id, kind: 'diag.nvml', retrySafe: false, selfTerminating: false }, runtime);
    complete(j, 'old', { outcome: 'succeeded' }, T0);
    complete(j, 'recent', { outcome: 'succeeded' }, T0 + 6 * 24 * 3_600_000);
    expect(sweep(j, T0 + COMMAND_TTL_MS + 3_600_000)).toBe(1);
    expect(j.commands().map((c) => c.id)).toEqual(['pending', 'recent']);
  });

  it('refuses lifecycle mistakes', () => {
    const j = new MemoryJournal('node_1');
    const runtime = rt('boot-1', 'inc-1');
    const code = (fn: () => void) => {
      try {
        fn();
      } catch (error) {
        return error instanceof JournalError ? error.code : 'other';
      }
      return 'ok';
    };
    expect(code(() => markRunning(j, 'missing', runtime))).toBe('NOT_FOUND');
    expect(code(() => complete(j, 'missing', { outcome: 'failed' }, T0))).toBe('NOT_FOUND');
    const d: Delivery = {
      id: 'cmd_1',
      kind: 'diag.nvml',
      retrySafe: false,
      selfTerminating: false,
    };
    deliverNew(j, d, runtime);
    expect(code(() => complete(j, d.id, { outcome: 'maybe' as never }, T0))).toBe('INVALID');
    complete(j, d.id, { outcome: 'succeeded' }, T0);
    expect(code(() => complete(j, d.id, { outcome: 'failed' }, T0))).toBe('INVALID');
    expect(code(() => markRunning(j, d.id, runtime))).toBe('INVALID');
    expect(code(() => accept(j, d, runtime))).toBe('INVALID');
    ackResult(j, d.id);
    expect(j.command(d.id)?.resultAcked).toBe(true);
  });

  it('drops metric events oldest-first; results and transitions never', () => {
    const j = new MemoryJournal('node_1', { maxEvents: 3 });
    const add = (cls: 'metric' | 'transition' | 'result', kind: string) =>
      j.appendEvent({ class: cls, kind, payload: new Uint8Array() }).seq;
    expect([add('metric', 'm1'), add('transition', 't1'), add('metric', 'm2')]).toEqual([1, 2, 3]);
    expect(add('result', 'r1')).toBe(4);
    expect(add('transition', 't2')).toBe(5);
    expect(j.unackedEvents().map((e) => e.kind)).toEqual(['t1', 'r1', 't2']);
    expect(() => add('result', 'r2')).toThrow(JournalError);
    expect(() => add('metric', 'm3')).toThrow(/full/);
    expect(j.eventStats()).toMatchObject({ count: 3, droppedMetrics: 3 });
    j.ackEvents(4);
    expect(j.unackedEvents().map((e) => e.kind)).toEqual(['t2']);
    expect(add('result', 'r2')).toBe(6);
    expect(j.meta().eventSeq).toBe(6);
  });

  it('caps event bytes, refusing an event larger than the cap without touching the backlog', () => {
    const j = new MemoryJournal('node_1', { maxBytes: 100 });
    for (let i = 0; i < 3; i++)
      j.appendEvent({ class: 'metric', kind: 'm', payload: new Uint8Array(10) });
    expect(j.eventStats()).toMatchObject({ count: 2, droppedMetrics: 1 });
    expect(() =>
      j.appendEvent({ class: 'result', kind: 'r', payload: new Uint8Array(100) }),
    ).toThrow(JournalError);
    expect(j.eventStats().count).toBe(2);
    expect(() =>
      j.appendEvent({ class: 'bogus' as never, kind: 'x', payload: new Uint8Array() }),
    ).toThrow(/class/);
  });

  it('owns journal_id and the event seq; specs never regress; tickets are single-use; values are copies', () => {
    const j = new MemoryJournal('node_1', { newJournalId: () => 'jrn_fixed' });
    j.saveMeta({
      nodeId: 'node_1',
      journalId: 'forged',
      eventSeq: 99,
      lastEpoch: 7,
      appliedGeneration: 3,
    });
    expect(j.meta()).toEqual({
      nodeId: 'node_1',
      journalId: 'jrn_fixed',
      eventSeq: 0,
      lastEpoch: 7,
      appliedGeneration: 3,
    });
    expect(new MemoryJournal('node_1').meta().journalId).toMatch(/^jrn_[0-9a-f]{32}$/);
    for (const g of [5, 5, 6])
      j.saveSpec({
        generation: g,
        hash: new Uint8Array(),
        body: new Uint8Array(),
        signature: new Uint8Array(),
      });
    expect(() =>
      j.saveSpec({
        generation: 4,
        hash: new Uint8Array(),
        body: new Uint8Array(),
        signature: new Uint8Array(),
      }),
    ).toThrow(/older/);
    expect(j.spec()?.generation).toBe(6);
    expect(j.rememberTicket('jti-1', T0 + 60_000, T0)).toBe(true);
    expect(j.rememberTicket('jti-1', T0 + 60_000, T0 + 1_000)).toBe(false);
    expect(j.rememberTicket('jti-2', T0, T0)).toBe(false);
    const payload = new TextEncoder().encode('result');
    j.putCommand({
      id: 'cmd_1',
      kind: 'k',
      retrySafe: false,
      selfTerminating: false,
      state: 'done',
      incarnation: 'inc',
      resultAcked: false,
      updatedAt: T0,
      result: { outcome: 'succeeded', payload },
    });
    payload[0] = 88;
    j.command('cmd_1')!.result!.payload![1] = 89;
    expect(new TextDecoder().decode(j.command('cmd_1')!.result!.payload)).toBe('result');
  });
});

// ---- FakeDaemon ---------------------------------------------------------------------------------

async function daemon(
  options: DaemonHarnessOptions = {},
): Promise<DaemonHarness & { facts: DaemonFact[] }> {
  const facts: DaemonFact[] = [];
  const h = createDaemonHarness({
    nodeId: 'node_a',
    start: T0,
    facts: { record: (f) => void facts.push(f) },
    ...options,
  });
  await h.advance(10);
  return Object.assign(h, { facts });
}

const updates = (h: DaemonHarness, id?: string): CommandUpdate[] =>
  h.servers.flatMap((s) => s.updates(id));
const states = (h: DaemonHarness, id: string): string[] =>
  updates(h, id).map((u) =>
    u.state === CommandState.REJECTED
      ? `REJECTED:${CommandRejectReason[u.rejectReason]}`
      : CommandState[u.state],
  );
const allFrames = <K extends Parameters<DaemonHarness['server']['of']>[0]>(
  h: DaemonHarness,
  kind: K,
) => h.servers.flatMap((s) => s.of(kind));
const lastHello = (h: DaemonHarness) => h.servers[h.servers.length - 1]!.of('hello')[0]!;
const events = (h: DaemonHarness): Event[] => allFrames(h, 'events').flatMap((b) => b.events);

describe('session', () => {
  it('opens with a Hello built from the journal and records the Welcome epoch', async () => {
    const h = await daemon();
    const hello = h.server.of('hello')[0]!;
    expect(hello).toMatchObject({
      nodeId: 'node_a',
      role: AgentRole.NODE,
      daemonVersion: '0.1.0',
      protoMin: 1,
      protoMax: 1,
      capabilities: ['cdi', 'nvml'],
      lastEpoch: 0n,
      appliedGeneration: 0n,
      lastEventSeq: 0n,
      unackedResults: [],
      runningCommandIds: [],
    });
    expect(hello.bootId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(hello.journalId).toBe(h.daemon.journalId);
    expect(hello.drivers.map((d) => d.id)).toEqual(['nvidia']);
    const sections = encodeInventorySections(h.daemon.hardware.inventory);
    // Every section a GPU host has; `images` comes only from nodes with an image cache.
    expect(Object.keys(hello.inventoryHashes)).toEqual(INVENTORY_SECTIONS.filter((s) => s !== 'images'));
    for (const s of sections) expect(hello.inventoryHashes[s.name]).toEqual(s.sha256);
    expect(h.daemon.welcomed).toBe(true);
    expect(h.daemon.epoch).toBe(1);

    h.daemon.disconnect();
    await h.advance(2_000);
    expect(h.servers).toHaveLength(2);
    expect(lastHello(h).lastEpoch).toBe(1n);
    expect(h.daemon.epoch).toBe(2);
  });

  it('sends the requested inventory sections as protobuf binary with their sha256', async () => {
    const h = await daemon({
      autoWelcome: () => ({ requestSections: ['gpus', 'system', 'nonsense'] }),
    });
    const sent = h.server.of('inventory');
    expect(sent.map((s) => s.section)).toEqual(['system', 'gpus']);
    for (const s of sent) {
      expect(s.sha256).toEqual(sha256(s.content));
      expect(s.schemaVersion).toBe(1);
    }
    const gpus = decodeInventorySection('gpus', sent[1]!.content);
    expect(gpus.gpus).toHaveLength(8);
    expect(gpus.gpus[0]!.name).toBe('NVIDIA H100 80GB HBM3');
  });

  it('heartbeats with free credits every interval, and inventory hashes on every 10th', async () => {
    const h = await daemon();
    await h.advance(6_000);
    h.sendCommand('logs.collect', { uploadUrl: 'https://objects.example/u' });
    await h.advance(4_000);
    const [first] = h.server.of('heartbeat');
    expect(first?.credits.find((c) => c.lane === Lane.BULK)?.credits).toBe(1);
    expect(first?.inventoryHashes).toEqual({});
    await h.advance(90_000);
    const beats = h.server.of('heartbeat');
    expect(beats).toHaveLength(10);
    expect(Object.keys(beats[9]!.inventoryHashes)).toHaveLength(INVENTORY_SECTIONS.length - 1);
    expect(beats[9]!.credits.find((c) => c.lane === Lane.BULK)?.credits).toBe(2);
  });

  it('Drain closes the session and redials after reconnect_after_ms', async () => {
    const h = await daemon();
    h.server.send({ case: 'drain', value: { reconnectAfterMs: 7_000 } });
    await h.advance(6_990);
    expect(h.servers).toHaveLength(1);
    await h.advance(20);
    expect(h.servers).toHaveLength(2);
    expect(h.daemon.welcomed).toBe(true);
  });

  it('a RevocationNotice ends the session for good', async () => {
    const h = await daemon();
    h.server.send({ case: 'revoked', value: { reason: 'compromised' } });
    await h.advance(10 * 60_000);
    expect(h.servers).toHaveLength(1);
    expect(h.daemon.revoked).toBe(true);
    expect(h.daemon.connected).toBe(false);
  });

  it('detects a dead link by PING and redials with full-jitter backoff', async () => {
    const h = await daemon();
    const first = h.server;
    first.link.control.partition();
    await h.advance(39_000);
    expect(first.link.agent.closed).toBe(false);
    await h.advance(1_000);
    expect(first.link.agent.closed).toBe(true);
    expect(first.link.agent.closeInfo?.reason).toBe('ping-timeout');
    // The gateway end never learns (the reset is held by the partition); its own timeout handles it.
    expect(first.link.server.closed).toBe(false);
    await h.advance(1_010);
    expect(h.servers).toHaveLength(2);
    expect(h.daemon.welcomed).toBe(true);
  });

  it('drops a session that gets no Welcome, and keeps backing off while the gateway is unreachable', async () => {
    const h = await daemon({ autoWelcome: false });
    await h.advance(30_000);
    expect(h.server.link.agent.closed).toBe(true);
    h.reachable = false;
    await h.advance(10 * 60_000);
    expect(h.servers).toHaveLength(1);
    h.reachable = true;
    await h.advance(61_000);
    expect(h.servers).toHaveLength(2);
  });

  it('closes the session on a frame before Welcome', async () => {
    const h = await daemon({ autoWelcome: false });
    h.server.ack({ commandIds: [] });
    await h.advance(5);
    expect(h.server.link.agent.closed).toBe(true);
  });
});

describe('acceptance checks (dispatch.Precheck order)', () => {
  it('rejects another node’s command UNSUPPORTED before any other check', async () => {
    const h = await daemon();
    const body = h.rawCommandBody('no.such.kind', {
      nodeId: 'node_b',
      notAfter: timestampFromMs(0),
      minGeneration: 9n,
    });
    h.server.command(body);
    await h.advance(5);
    expect(states(h, body.id)).toEqual(['REJECTED:UNSUPPORTED']);
    expect(h.daemon.journal.command(body.id)?.result).toMatchObject({
      outcome: 'rejected',
      reason: 'UNSUPPORTED',
    });
  });

  it('rejects unknown kinds UNSUPPORTED, even past not_after (the kind is checked first)', async () => {
    const h = await daemon();
    const body = h.rawCommandBody('gpu.reset', { notAfter: timestampFromMs(0) });
    h.server.command(body);
    await h.advance(5);
    expect(states(h, body.id)).toEqual(['REJECTED:UNSUPPORTED']);
  });

  it('rejects kinds the agent role may not run', async () => {
    const h = await daemon({ role: AgentRole.SITE });
    const body = h.sendCommand('diag.nvml');
    await h.advance(5);
    expect(states(h, body.id)).toEqual(['REJECTED:UNSUPPORTED']);
  });

  it('rejects EXPIRED past not_after (server time) and without one', async () => {
    const h = await daemon();
    const late = h.sendCommand('diag.nvml', {}, { notAfter: timestampFromMs(T0) });
    const none = h.sendCommand('diag.nvml', {}, { notAfter: undefined });
    await h.advance(5);
    expect(states(h, late.id)).toEqual(['REJECTED:EXPIRED']);
    expect(states(h, none.id)).toEqual(['REJECTED:EXPIRED']);
  });

  it('evaluates not_after in server time through the Welcome offset', async () => {
    const h = await daemon({ clockSkewMs: 3_600_000 });
    const body = h.sendCommand('diag.nvml', {}, { notAfter: timestampFromMs(T0 + 60_000) });
    await h.advance(5);
    expect(states(h, body.id)).toEqual(['ACKED', 'RUNNING']);
  });

  it('defers on min_generation with a SpecRequest, then runs once the spec arrives', async () => {
    const h = await daemon();
    const body = h.sendCommand('diag.nvml', {}, { minGeneration: 3n });
    await h.advance(5);
    expect(states(h, body.id)).toEqual([]);
    expect(h.daemon.deferred).toEqual([body.id]);
    expect(h.server.of('specRequest')).toEqual([
      expect.objectContaining({ haveGeneration: 0n, reason: SpecRequestReason.MIN_GENERATION }),
    ]);
    h.server.command(body, 2); // a duplicate while deferred changes nothing
    await h.advance(5);
    expect(h.server.of('specRequest')).toHaveLength(1);
    h.sendSpec(3, {});
    await h.advance(5);
    expect(states(h, body.id)).toEqual(['ACKED', 'RUNNING']);
    expect(h.daemon.deferred).toEqual([]);
  });

  it('rejects STALE_GENERATION when the spec is still behind at not_after', async () => {
    const h = await daemon();
    const body = h.sendCommand(
      'diag.nvml',
      {},
      { minGeneration: 3n, notAfter: timestampFromMs(T0 + 60_000) },
    );
    await h.advance(59_000);
    expect(states(h, body.id)).toEqual([]);
    await h.advance(2_000);
    expect(states(h, body.id)).toEqual(['REJECTED:STALE_GENERATION']);
  });

  it('rejects EXPIRED a command first seen stale and late', async () => {
    const h = await daemon();
    const body = h.sendCommand(
      'diag.nvml',
      {},
      { minGeneration: 3n, notAfter: timestampFromMs(T0) },
    );
    await h.advance(5);
    expect(states(h, body.id)).toEqual(['REJECTED:EXPIRED']);
  });

  it('answers BUSY without a credit, journals nothing, and accepts the redelivery later', async () => {
    const h = await daemon({
      autoWelcome: () => ({ credits: [{ lane: Lane.CONTROL, credits: 1 }] }),
    });
    const first = h.sendCommand('diag.nvml');
    const second = h.sendCommand('diag.nvml');
    await h.advance(5);
    expect(states(h, first.id)).toEqual(['ACKED', 'RUNNING']);
    expect(states(h, second.id)).toEqual(['REJECTED:BUSY']);
    expect(h.daemon.journal.command(second.id)).toBeUndefined();
    await h.advance(2_000);
    h.server.command(second, 2);
    await h.advance(5);
    expect(states(h, second.id)).toEqual(['REJECTED:BUSY', 'ACKED', 'RUNNING']);
  });

  it('accepts only daemon.upgrade when Welcome says upgrade_required', async () => {
    const h = await daemon({ autoWelcome: () => ({ upgradeRequired: true }) });
    const body = h.sendCommand('diag.nvml');
    await h.advance(5);
    expect(states(h, body.id)).toEqual(['REJECTED:UNSUPPORTED']);
  });

  it('journals a rejection: a duplicate resends it and Hello replays it until acked', async () => {
    const h = await daemon();
    const body = h.sendCommand('diag.nvml', {}, { notAfter: timestampFromMs(T0) });
    await h.advance(5);
    h.server.command(body, 2);
    await h.advance(5);
    expect(states(h, body.id)).toEqual(['REJECTED:EXPIRED', 'REJECTED:EXPIRED']);
    h.daemon.disconnect();
    await h.advance(2_000);
    expect(lastHello(h).unackedResults.map((u) => u.commandId)).toEqual([body.id]);
    h.server.ack({ commandIds: [body.id] });
    await h.advance(5);
    h.daemon.disconnect();
    await h.advance(2_000);
    expect(lastHello(h).unackedResults).toEqual([]);
  });
});

describe('execution and duplicate delivery', () => {
  it('reports ACKED, RUNNING, SUCCEEDED with the result, and replays it in Hello until acked', async () => {
    const h = await daemon();
    const body = h.sendCommand('diag.nvml', { expectedGpuCount: 8 });
    await h.advance(1_000);
    expect(states(h, body.id)).toEqual(['ACKED', 'RUNNING']);
    await h.advance(1_010);
    expect(states(h, body.id)).toEqual(['ACKED', 'RUNNING', 'SUCCEEDED']);
    const done = updates(h, body.id)[2]!;
    const result = decodeCommandResult('diag.nvml', done.result);
    expect(result).toMatchObject({ passed: true, gpuCount: 8, driverVersion: '550.90.07' });
    expect(result.gpus.map((g) => g.uuid)).toEqual([...h.daemon.hardware.gpuUuids].sort());
    expect(done.bootId).toBe(h.daemon.bootId);
    expect(h.daemon.journal.command(body.id)).toMatchObject({ state: 'done', resultAcked: false });

    h.daemon.disconnect();
    await h.advance(2_000);
    const replay = lastHello(h).unackedResults;
    expect(replay.map((u) => [u.commandId, u.state])).toEqual([[body.id, CommandState.SUCCEEDED]]);
    expect(replay[0]!.result).toEqual(done.result);
    h.server.ack({ commandIds: [body.id] });
    await h.advance(5);
    expect(h.daemon.journal.command(body.id)?.resultAcked).toBe(true);
    expect(h.facts.filter((f) => f.type === 'execution.started')).toHaveLength(1);
  });

  it('done → resends the stored result without running again', async () => {
    const h = await daemon();
    const body = h.sendCommand('diag.nvml');
    await h.advance(2_010);
    h.server.command(body, 2);
    await h.advance(5);
    const [, , first, again] = updates(h, body.id);
    expect(again).toEqual(first);
    expect(h.daemon.executions.get(body.id)).toBe(1);
  });

  it('running → re-attaches: no new update, no second execution', async () => {
    const h = await daemon();
    const body = h.sendCommand('diag.nvml');
    await h.advance(500);
    h.server.command(body, 2);
    await h.advance(5);
    expect(states(h, body.id)).toEqual(['ACKED', 'RUNNING']);
    await h.advance(2_000);
    expect(states(h, body.id)).toEqual(['ACKED', 'RUNNING', 'SUCCEEDED']);
    expect(h.daemon.executions.get(body.id)).toBe(1);
  });

  it('accepted but not running after a crash, retry-safe → re-executes on redelivery', async () => {
    const h = await daemon({ workers: { [Lane.CONTROL]: 1 } });
    h.sendCommand('diag.nvml');
    const queued = h.sendCommand('inventory.refresh');
    await h.advance(5);
    expect(states(h, queued.id)).toEqual(['ACKED']);
    h.daemon.crash();
    h.daemon.restart();
    await h.advance(2_000);
    const hello = lastHello(h);
    expect(hello.runningCommandIds).toEqual([]);
    expect(hello.unackedResults.map((u) => u.commandId)).not.toContain(queued.id);
    h.server.command(queued, 2);
    await h.advance(1_000);
    expect(states(h, queued.id)).toEqual(['ACKED', 'ACKED', 'RUNNING', 'SUCCEEDED']);
    expect(h.daemon.executions.get(queued.id)).toBe(1);
  });

  it('accepted but not running after a crash, not retry-safe → FAILED{interrupted}, never executed', async () => {
    const h = await daemon({
      workers: { [Lane.CONTROL]: 1 },
      kinds: { 'gpu.reset': fakeGpuReset },
    });
    h.sendCommand('diag.nvml');
    const gpu = h.daemon.hardware.gpuUuids[0]!;
    const reset = h.sendCommand('gpu.reset', { gpuUuids: [gpu] });
    await h.advance(5);
    expect(reset.retrySafe).toBe(false);
    h.daemon.crash();
    h.daemon.restart();
    await h.advance(2_000);
    const replay = lastHello(h).unackedResults.find((u) => u.commandId === reset.id);
    expect(replay).toMatchObject({
      state: CommandState.FAILED,
      error: { code: REASON_INTERRUPTED },
    });
    h.server.command(reset, 2);
    await h.advance(5);
    expect(states(h, reset.id).at(-1)).toBe('FAILED');
    expect(h.daemon.executions.get(reset.id)).toBeUndefined();
  });

  it('running when the daemon crashed: not retry-safe → FAILED{interrupted}; retry-safe → runs again', async () => {
    const h = await daemon({ kinds: { 'gpu.reset': fakeGpuReset } });
    const reset = h.sendCommand('gpu.reset', { gpuUuids: [h.daemon.hardware.gpuUuids[0]!] });
    const diag = h.sendCommand('diag.nvml');
    await h.advance(500);
    h.daemon.crash();
    h.daemon.restart();
    await h.advance(2_000);
    expect(lastHello(h).unackedResults.map((u) => [u.commandId, u.state])).toEqual([
      [reset.id, CommandState.FAILED],
    ]);
    h.server.command(diag, 2);
    h.server.command(reset, 2);
    await h.advance(2_100);
    expect(states(h, diag.id).slice(-3)).toEqual(['ACKED', 'RUNNING', 'SUCCEEDED']);
    expect(h.daemon.executions.get(diag.id)).toBe(2);
    expect(h.daemon.executions.get(reset.id)).toBe(1);
  });

  it('a done command swept after the 7-day TTL is new again', async () => {
    const h = await daemon();
    const body = h.sendCommand(
      'diag.nvml',
      {},
      { notAfter: timestampFromMs(T0 + 9 * 24 * 3_600_000) },
    );
    await h.advance(2_010);
    await h.advance(COMMAND_TTL_MS + 3_600_000);
    expect(h.daemon.journal.command(body.id)).toBeUndefined();
  });

  it('Cancel: a queued command is CANCELLED; a running one reports its real outcome', async () => {
    const h = await daemon({ workers: { [Lane.CONTROL]: 1 } });
    const running = h.sendCommand('diag.nvml');
    const queued = h.sendCommand('diag.nvml');
    await h.advance(5);
    h.server.cancel(queued.id, 'operator');
    h.server.cancel(running.id, 'operator');
    await h.advance(3_000);
    expect(states(h, queued.id)).toEqual(['ACKED', 'CANCELLED']);
    expect(h.daemon.journal.command(queued.id)?.result).toMatchObject({ outcome: 'cancelled' });
    expect(states(h, running.id)).toEqual(['ACKED', 'RUNNING', 'SUCCEEDED']);
    expect(h.daemon.creditsInUse(Lane.CONTROL)).toBe(0);
  });
});

describe('self-terminating kinds (node.reboot)', () => {
  it('journals running{boot_id}, reboots, and reports SUCCEEDED{rebooted} with the new boot_id', async () => {
    const h = await daemon({ rebootDurationMs: 60_000 });
    const oldBoot = h.daemon.bootId;
    const body = h.sendCommand('node.reboot', { reason: 'test', delayMs: 1_000 });
    await h.advance(5);
    expect(states(h, body.id)).toEqual(['ACKED']);
    await h.advance(1_000);
    expect(h.daemon.state).toBe('rebooting');
    expect(h.daemon.journal.command(body.id)).toMatchObject({ state: 'running', bootId: oldBoot });
    expect(h.daemon.bootId).not.toBe(oldBoot);
    await h.advance(60_010);
    const replay = lastHello(h).unackedResults;
    expect(replay).toHaveLength(1);
    expect(replay[0]).toMatchObject({
      commandId: body.id,
      state: CommandState.SUCCEEDED,
      rebooted: true,
      bootId: h.daemon.bootId,
    });
    expect(decodeCommandResult('node.reboot', replay[0]!.result).previousBootId).toBe(oldBoot);
    expect(lastHello(h).bootId).toBe(h.daemon.bootId);
    h.server.command(body, 2);
    await h.advance(5_000);
    expect(h.daemon.state).toBe('running');
    expect(h.daemon.executions.get(body.id)).toBe(1);
    expect(updates(h, body.id).at(-1)).toMatchObject({
      state: CommandState.SUCCEEDED,
      rebooted: true,
    });
  });

  it('never replays across a reboot once running; re-executes a retry-safe one that never started', async () => {
    const h = await daemon({ rebootDurationMs: 10_000 });
    const body = h.sendCommand('node.reboot', { delayMs: 5_000 });
    await h.advance(1_000);
    // The node reboots for another reason while the command waits for its delay.
    h.daemon.reboot({ durationMs: 10_000 });
    await h.advance(10_010);
    expect(lastHello(h).unackedResults).toEqual([]);
    h.server.command(body, 2);
    await h.advance(5_010);
    expect(h.daemon.state).toBe('rebooting');
    expect(h.daemon.executions.get(body.id)).toBe(1);
  });
});

describe('journal loss', () => {
  it('starts a new journal_id and forgets results, events and the spec; the files stay', async () => {
    const h = await daemon();
    const gpu = h.daemon.hardware.gpuUuids[0]!;
    h.sendSpec(2, {
      devices: {
        assignments: [
          {
            allocationId: 'alloc_1',
            binding: Binding.HOLD,
            devices: [{ id: gpu, deviceClass: 'gpu' }],
          },
        ],
      },
    });
    const body = h.sendCommand('diag.nvml');
    await h.advance(2_010);
    const before = lastHello(h).journalId;
    expect(() => h.daemon.loseJournal()).toThrow(/stopped/);
    h.daemon.crash();
    h.daemon.loseJournal();
    h.daemon.restart();
    await h.advance(2_000);
    const hello = lastHello(h);
    expect(hello.journalId).not.toBe(before);
    expect(hello).toMatchObject({
      appliedGeneration: 0n,
      lastEventSeq: 0n,
      unackedResults: [],
      runningCommandIds: [],
    });
    expect(h.daemon.journal.command(body.id)).toBeUndefined();
    expect(h.daemon.files.has(cdiSpecPath('alloc_1'))).toBe(true);
    expect(h.facts.filter((f) => f.type === 'journal.lost')).toEqual([
      expect.objectContaining({ oldJournalId: before, newJournalId: hello.journalId }),
    ]);
  });
});

describe('desired state and the devices converger', () => {
  const hold = (allocationId: string, ids: string[]) => ({
    allocationId,
    reservationId: `rsv_${allocationId}`,
    binding: Binding.HOLD,
    devices: ids.map((id) => ({ id, deviceClass: 'gpu' })),
    env: ['EXTRA=1'],
  });
  const bodies = (h: DaemonHarness) =>
    events(h).flatMap((e) =>
      e.body.case === 'attested' ? [unwrapAttestedReport(e.body.value).report] : [],
    );

  it('writes the CDI hold and env file, reports AllocationBound and the observed generation', async () => {
    const h = await daemon();
    const [g0, g1, g2] = h.daemon.hardware.gpuUuids;
    const specHash = new Uint8Array(32).fill(7);
    h.sendSpec(
      4,
      {
        devices: { assignments: [hold('alloc_1', [g0!, g1!]), hold('alloc_2', [g2!])] },
        telemetry: { otlpEndpoint: 'https://otel' },
      },
      { specHash },
    );
    await h.advance(5);
    const cdi = JSON.parse(h.daemon.files.get(cdiSpecPath('alloc_1'))!);
    expect(cdi.devices.map((d: { name: string }) => d.name)).toEqual([g0, g1]);
    expect(h.daemon.files.get(envFilePath('alloc_1'))).toContain(
      `NVIDIA_VISIBLE_DEVICES=${g0},${g1}`,
    );
    expect(h.daemon.files.get(envFilePath('alloc_1'))).toContain('EXTRA=1');
    const bound = bodies(h)
      .filter((r) => r.case === 'allocationBound')
      .map((r) => r.value);
    expect(bound).toEqual([
      expect.objectContaining({
        allocationId: 'alloc_1',
        generation: 4n,
        deviceIds: [g0, g1],
        cdiDevices: [`bcd.dev/gpu=${g0}`, `bcd.dev/gpu=${g1}`],
        cdiSpecPath: '/etc/cdi/bcd-alloc_1.json',
        envFile: '/run/bcd/allocations/alloc_1.env',
      }),
      expect.objectContaining({ allocationId: 'alloc_2' }),
    ]);
    const status = h.server.of('status').at(-1)!;
    expect(status).toMatchObject({
      observedGeneration: 4n,
      appliedGeneration: 4n,
      appliedSpecHash: specHash,
    });
    expect(status.sections.map((s) => [s.section, SectionState[s.state]])).toEqual([
      ['host', 'CONVERGED'],
      ['devices', 'CONVERGED'],
      ['instances', 'CONVERGED'],
      ['access', 'CONVERGED'],
      ['telemetry', 'CONVERGED'],
      ['daemon', 'CONVERGED'],
    ]);
    h.daemon.disconnect();
    await h.advance(2_000);
    expect(lastHello(h)).toMatchObject({ appliedGeneration: 4n, appliedSpecHash: specHash });
  });

  it('rejects overlapping assignments (AllocationFailed{overlap}, section FAILED) and missing devices', async () => {
    const h = await daemon();
    const [g0, g1] = h.daemon.hardware.gpuUuids;
    h.sendSpec(1, { devices: { assignments: [hold('alloc_1', [g0!])] } });
    await h.advance(5);
    h.sendSpec(2, {
      devices: {
        assignments: [
          hold('alloc_1', [g0!]),
          hold('alloc_2', [g0!, g1!]),
          hold('alloc_3', ['GPU-missing']),
          hold('alloc_4', [g1!, g1!]),
        ],
      },
    });
    await h.advance(5);
    expect(h.daemon.boundAllocations()).toEqual(['alloc_1']);
    const failed = events(h).flatMap((e) =>
      e.body.case === 'allocationFailed' ? [e.body.value] : [],
    );
    expect(failed.map((f) => [f.allocationId, f.reason])).toEqual([
      ['alloc_2', 'overlap'],
      ['alloc_3', 'device-missing'],
      ['alloc_4', 'overlap'],
    ]);
    expect(failed[0]!.message).toContain('alloc_1');
    const status = h.server.of('status').at(-1)!;
    expect(status.observedGeneration).toBe(2n);
    expect(status.sections.find((s) => s.section === 'devices')).toMatchObject({
      state: SectionState.FAILED,
      generation: 2n,
    });
    // The same failure is not reported again for the same generation.
    h.daemon.converge();
    await h.advance(5);
    expect(events(h).filter((e) => e.body.case === 'allocationFailed')).toHaveLength(3);
  });

  it('releases a hold only when the spec drops it (AllocationReleased)', async () => {
    const h = await daemon();
    const [g0] = h.daemon.hardware.gpuUuids;
    h.sendSpec(1, { devices: { assignments: [hold('alloc_1', [g0!])] } });
    await h.advance(5);
    h.sendSpec(2, { devices: { assignments: [] } });
    await h.advance(5);
    expect(h.daemon.files.size).toBe(0);
    const released = bodies(h)
      .filter((r) => r.case === 'allocationReleased')
      .map((r) => r.value);
    expect(released).toEqual([
      expect.objectContaining({ allocationId: 'alloc_1', generation: 2n, deviceIds: [g0] }),
    ]);
  });

  it('ignores stale generations and specs for another node', async () => {
    const h = await daemon();
    const [g0] = h.daemon.hardware.gpuUuids;
    h.sendSpec(3, { devices: { assignments: [hold('alloc_1', [g0!])] } });
    await h.advance(5);
    h.sendSpec(2, {});
    h.server.desired({ nodeId: 'node_b', generation: 9n, spec: { case: 'full', value: {} } });
    await h.advance(5);
    expect(h.daemon.appliedGeneration).toBe(3);
    expect(h.daemon.boundAllocations()).toEqual(['alloc_1']);
  });

  it('applies a patch only on its base generation, asking for a full spec otherwise', async () => {
    const h = await daemon();
    const [g0, g1] = h.daemon.hardware.gpuUuids;
    h.sendSpec(1, {
      devices: { assignments: [hold('alloc_1', [g0!])] },
      telemetry: { otlpEndpoint: 'https://otel' },
    });
    await h.advance(5);
    h.sendSpec(3, { devices: { assignments: [hold('alloc_2', [g1!])] } }, { patchOf: 2 });
    await h.advance(5);
    expect(h.server.of('specRequest')).toEqual([
      expect.objectContaining({
        haveGeneration: 1n,
        reason: SpecRequestReason.PATCH_BASE_MISMATCH,
      }),
    ]);
    expect(h.daemon.appliedGeneration).toBe(1);
    h.sendSpec(2, { devices: { assignments: [hold('alloc_2', [g1!])] } }, { patchOf: 1 });
    await h.advance(5);
    expect(h.daemon.appliedGeneration).toBe(2);
    expect(h.daemon.boundAllocations()).toEqual(['alloc_2']);
    expect(h.daemon.spec?.telemetry?.otlpEndpoint).toBe('https://otel');
  });

  it('enforces the journaled spec while offline, and rewrites /run after a reboot without a new AllocationBound', async () => {
    const h = await daemon({ rebootDurationMs: 5_000 });
    const [g0] = h.daemon.hardware.gpuUuids;
    h.sendSpec(1, { devices: { assignments: [hold('alloc_1', [g0!])] } });
    await h.advance(5);
    h.reachable = false;
    h.daemon.reboot();
    expect(h.daemon.files.has(envFilePath('alloc_1'))).toBe(false);
    await h.advance(5_010);
    expect(h.daemon.state).toBe('running');
    expect(h.daemon.files.has(envFilePath('alloc_1'))).toBe(true);
    expect(h.daemon.boundAllocations()).toEqual(['alloc_1']);
    expect(h.facts.filter((f) => f.type === 'allocation.bound')).toHaveLength(1);
    expect(h.facts.filter((f) => f.type === 'allocation.unbound')).toHaveLength(0);
  });

  it('reports PROGRESSING while CDI writes fail and converges on the retry', async () => {
    const h = await daemon({ knobs: { cdiWriteFailures: 1 } });
    const [g0] = h.daemon.hardware.gpuUuids;
    h.sendSpec(1, { devices: { assignments: [hold('alloc_1', [g0!])] } });
    await h.advance(5);
    expect(h.server.of('status').at(-1)).toMatchObject({
      observedGeneration: 0n,
      appliedGeneration: 1n,
    });
    expect(h.daemon.boundAllocations()).toEqual([]);
    await h.advance(30_000);
    expect(h.server.of('status').at(-1)).toMatchObject({ observedGeneration: 1n });
    expect(h.daemon.boundAllocations()).toEqual(['alloc_1']);
  });

  it('reports sections it cannot converge as UNSUPPORTED with a SectionUnsupported condition', async () => {
    const h = await daemon();
    const spec = create(NodeSpecSchema, {
      host: { units: [{ unit: 'sysctl', configJson: '{}' }] },
    });
    spec.$unknown = [{ no: 9, wireType: WireType.Varint, data: new Uint8Array([1]) }];
    // The unknown field survives the wire: the daemon sees it as a section it does not know.
    const decoded = fromBinary(NodeSpecSchema, toBinary(NodeSpecSchema, spec));
    h.sendSpec(1, decoded);
    await h.advance(5);
    const status = h.server.of('status').at(-1)!;
    expect(status.observedGeneration).toBe(1n);
    expect(
      status.sections.filter((s) => s.state === SectionState.UNSUPPORTED).map((s) => s.section),
    ).toEqual(['host', '9']);
    expect(status.conditions.map((c) => [c.type, c.status, c.reason])).toEqual([
      ['SectionUnsupported', ConditionStatus.TRUE, '1'],
      ['SectionUnsupported', ConditionStatus.TRUE, '9'],
    ]);
  });
});

describe('events', () => {
  const hold = (allocationId: string, id: string) => ({
    allocationId,
    binding: Binding.HOLD,
    devices: [{ id, deviceClass: 'gpu' }],
  });

  it('replays events above the Welcome ack after a reconnect; Ack forgets them', async () => {
    const h = await daemon();
    const [g0, g1] = h.daemon.hardware.gpuUuids;
    h.sendSpec(1, { devices: { assignments: [hold('alloc_1', g0!), hold('alloc_2', g1!)] } });
    await h.advance(5);
    expect(events(h).map((e) => e.seq)).toEqual([1n, 2n]);
    h.server.ack({ journalId: h.daemon.journalId, eventSeq: 1 });
    await h.advance(5);
    expect(h.daemon.journal.unackedEvents().map((e) => e.seq)).toEqual([2]);
    h.daemon.disconnect();
    await h.advance(2_000);
    expect(h.server.of('events').flatMap((b) => b.events.map((e) => e.seq))).toEqual([2n]);
    expect(lastHello(h).lastEventSeq).toBe(2n);
  });

  it('when the journal is full of transitions: metrics are dropped and commands get BUSY until acks drain it', async () => {
    const h = await daemon({ journal: { maxEvents: 2 } });
    const [g0, g1, g2] = h.daemon.hardware.gpuUuids;
    h.sendSpec(1, {
      devices: { assignments: [hold('alloc_1', g0!), hold('alloc_2', g1!), hold('alloc_3', g2!)] },
    });
    await h.advance(5);
    expect(h.daemon.journal.eventStats().count).toBe(2);
    h.daemon.emitMetric();
    expect(h.daemon.journal.eventStats().droppedMetrics).toBe(1);
    const busy = h.sendCommand('diag.nvml');
    await h.advance(5);
    expect(states(h, busy.id)).toEqual(['REJECTED:BUSY']);
    h.server.ack({ journalId: h.daemon.journalId, eventSeq: 2 });
    await h.advance(5);
    expect(h.daemon.journal.unackedEvents().map((e) => e.kind)).toEqual(['allocation.bound']);
    expect(events(h).map((e) => e.seq)).toEqual([1n, 2n, 3n]);
    h.server.command(busy, 2);
    await h.advance(5);
    expect(states(h, busy.id)).toEqual(['REJECTED:BUSY', 'ACKED', 'RUNNING']);
  });
});

describe('v0.1 command kinds', () => {
  it('diag.nvml reports failing checks, a GPU count mismatch, and NVML missing on a CPU node', async () => {
    const h = await daemon({
      hardware: fakeHardware({ seed: 3, variant: 'hgx-h100-gpu-missing' }),
    });
    const [first] = h.daemon.hardware.gpuUuids;
    h.daemon.knobs.diag.failGpus = { [first!]: ['ecc.uncorrectable'] };
    const body = h.sendCommand('diag.nvml', { expectedGpuCount: 8 });
    await h.advance(2_010);
    const result = decodeCommandResult('diag.nvml', updates(h, body.id).at(-1)!.result);
    expect(result.passed).toBe(false);
    expect(result.gpuCount).toBe(7);
    expect(result.checks.find((c) => c.name === 'gpu.count')).toMatchObject({
      passed: false,
      message: '7 of 8 GPUs visible',
    });
    const bad = result.gpus.find((g) => g.uuid === first)!;
    expect(bad.passed).toBe(false);
    expect(bad.checks.find((c) => !c.passed)?.name).toBe('ecc.uncorrectable');

    const cpu = await daemon({ hardware: fakeHardware({ seed: 3, variant: 'cpu' }) });
    expect(cpu.server.of('hello')[0]!.capabilities).toEqual([]);
    const probe = cpu.sendCommand('diag.nvml');
    await cpu.advance(2_010);
    const none = decodeCommandResult('diag.nvml', updates(cpu, probe.id).at(-1)!.result);
    expect(none).toMatchObject({ passed: false, gpuCount: 0 });
    expect(none.checks[0]).toMatchObject({ name: 'nvml.init', passed: false });

    h.daemon.knobs.diag.error = 'nvml-timeout';
    const failing = h.sendCommand('diag.nvml');
    await h.advance(2_010);
    expect(updates(h, failing.id).at(-1)).toMatchObject({
      state: CommandState.FAILED,
      error: { code: 'nvml-timeout' },
    });
  });

  it('inventory.refresh sends the (re-collected) sections before it succeeds', async () => {
    const h = await daemon();
    h.daemon.setHardware(fakeHardware({ seed: 'node_a', variant: 'hgx-h100-gpu-missing' }));
    const body = h.sendCommand('inventory.refresh', { sections: ['gpus'], rescan: true });
    await h.advance(510);
    const frames = h.server.frames.map((f) => f.msg.case);
    const sectionAt = frames.lastIndexOf('inventory');
    const doneAt = frames.lastIndexOf('update');
    expect(sectionAt).toBeGreaterThan(-1);
    expect(sectionAt).toBeLessThan(doneAt);
    const section = h.server.of('inventory').at(-1)!;
    expect(decodeInventorySection('gpus', section.content).gpus).toHaveLength(7);
    const result = decodeCommandResult('inventory.refresh', updates(h, body.id).at(-1)!.result);
    expect(result.sectionHashes['gpus']).toEqual(section.sha256);
    const bad = h.sendCommand('inventory.refresh', { sections: ['gpu'] });
    await h.advance(510);
    expect(updates(h, bad.id).at(-1)).toMatchObject({
      state: CommandState.FAILED,
      error: { code: 'invalid-payload' },
    });
  });

  it('logs.collect uploads a redacted, bounded bundle to the presigned URL', async () => {
    const h = await daemon();
    const url = 'https://objects.example/bundle?sig=1';
    const body = h.sendCommand('logs.collect', {
      uploadUrl: url,
      units: ['bcd.service'],
      lookbackSeconds: 600,
    });
    await h.advance(5_010);
    const uploaded = h.daemon.uploads.get(url)!;
    const text = new TextDecoder().decode(uploaded);
    expect(text).toContain('node=node_a');
    expect(text).toContain('bcjt_[redacted]');
    expect(text).not.toMatch(/bcjt_01example/);
    const result = decodeCommandResult('logs.collect', updates(h, body.id).at(-1)!.result);
    expect(result).toMatchObject({
      uploadedBytes: BigInt(uploaded.byteLength),
      truncated: false,
      contentType: 'text/plain',
    });
    expect(result.sha256).toEqual(sha256(uploaded));

    const small = h.sendCommand('logs.collect', { uploadUrl: `${url}2`, maxBytes: 16n });
    await h.advance(5_010);
    expect(decodeCommandResult('logs.collect', updates(h, small.id).at(-1)!.result)).toMatchObject({
      uploadedBytes: 16n,
      truncated: true,
    });
    const plain = h.sendCommand('logs.collect', { uploadUrl: 'http://insecure' });
    h.daemon.knobs.logs.uploadFails = true;
    const refused = h.sendCommand('logs.collect', { uploadUrl: `${url}3` });
    await h.advance(10_010);
    expect(updates(h, plain.id).at(-1)).toMatchObject({
      state: CommandState.FAILED,
      error: { code: 'invalid-payload' },
    });
    expect(updates(h, refused.id).at(-1)).toMatchObject({
      state: CommandState.FAILED,
      error: { code: 'upload-failed' },
    });
  });
});

describe('determinism', () => {
  it('the same seed gives the same frames, ids and boot ids', async () => {
    const run = async () => {
      const h = await daemon({ seed: 'same' });
      h.sendCommand('diag.nvml');
      h.daemon.reboot({ durationMs: 1_000 });
      await h.advance(5_000);
      return h.servers.flatMap((s) =>
        s.frames.map((f) => JSON.stringify(f, (_k, v) => (typeof v === 'bigint' ? `${v}` : v))),
      );
    };
    expect(await run()).toEqual(await run());
  });
});
