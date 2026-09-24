import { createHash } from 'node:crypto';
import { clone, create, toBinary, type MessageInitShape } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import {
  AgentRole,
  Binding,
  CommandBodySchema,
  CommandRejectReason,
  CommandState,
  DesiredStateBodySchema,
  DeviceAssignmentSchema,
  DevicesSectionSchema,
  INVENTORY_SECTIONS,
  Lane,
  NodeSpecSchema,
  PROTOCOL_VERSION,
  ServerFrameSchema,
  commandKinds,
  decodeInventorySection,
  isCommandKind,
  negotiateProtocolVersion,
  packCommandPayload,
  unwrapAttestedReport,
  wrapDesiredState,
  type AgentFrame,
  type CommandKind,
  type CommandPayload,
  type CommandUpdate,
  type Condition,
  type EventBatch,
  type Hello,
  type NodeSpec,
  type ServerFrame,
} from '@better-compute/protocol';
import type { EventLog, LogValue } from '../event-log.js';
import type { ServerConn } from '../frame-conn.js';
import type { Scheduler } from '../scheduler.js';
import type {
  BilledAllocation,
  BookingRow,
  ConnectivityFact,
  ReleaseFact,
  ServerOutcome,
  UsageWindow,
} from './invariants.js';
import type { GatewayFacts, GatewayPeer, GatewayPort } from './port.js';

// A minimal in-memory control plane speaking the server side of agent/v1 Session (PLAN.md §7.2–
// §7.5), just enough to drive FakeDaemons end to end before the real gateway core
// (@better-compute/gateway) and the server runtime exist: the Hello transaction (epoch bump, the
// self-terminating and journal-lost rules), Welcome, desired state, dispatch with credits and BUSY
// back-off, result and event ingestion with dedupe and Acks, liveness (3 missed heartbeats close a
// session; unreachable after TTL + grace, which releases nothing), the command sweeper, and
// bookings with usage flushes for the invariant checkers. Its maps stand in for the database.
//
// The real gateway session core replaces it through `GatewayPort`; nothing here is a reference for
// how the server must be built.

/** The control plane's command states (PLAN.md §7.4). */
export type StubCommandState =
  | 'pending'
  | 'dispatched'
  | 'acked'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'rejected'
  | 'expired'
  | 'cancelled';

const TERMINAL: ReadonlySet<StubCommandState> = new Set([
  'succeeded',
  'failed',
  'rejected',
  'expired',
  'cancelled',
]);
const IN_FLIGHT: ReadonlySet<StubCommandState> = new Set(['dispatched', 'acked', 'running']);

/** Whether a command state is terminal. */
export const isTerminal = (state: StubCommandState): boolean => TERMINAL.has(state);

/** One `commands` row. */
export interface StubCommand {
  readonly id: string;
  readonly nodeId: string;
  readonly seq: number;
  readonly kind: string;
  readonly lane: Lane;
  readonly retrySafe: boolean;
  readonly selfTerminating: boolean;
  readonly notAfter: number;
  readonly minGeneration: number;
  /** UNIQUE(node_id, idempotency_key). */
  readonly idempotencyKey: string;
  /** The CommandBody bytes, stored once and resent verbatim. */
  readonly body: Uint8Array;
  state: StubCommandState;
  /** The session epoch of the last dispatch. */
  epoch: number;
  attempts: number;
  /** BUSY back-off: not dispatched before this time. */
  notBefore: number;
  busyCount: number;
  result?: Uint8Array;
  errorCode?: string;
  rejectReason?: CommandRejectReason;
  rebooted?: boolean;
  createdAt: number;
  finishedAt?: number;
}

/** An allocation with its booking (device_bookings + allocations rows). */
export interface StubAllocation {
  readonly allocationId: string;
  readonly nodeId: string;
  readonly deviceIds: readonly string[];
  readonly tenantId: string;
  /** Who is billed; kept as a snapshot, so deleting the identity later loses nothing (I8). */
  readonly subject: string;
  readonly start: number;
  /** The planned end of `during` (`Infinity` when open-ended). */
  end: number;
  state: 'active' | 'released';
  releasedAt?: number;
  releaseReason?: string;
  lastFlushedAt: number;
}

export type Connectivity = 'never' | 'connected' | 'disconnected' | 'unreachable';

interface StubSession {
  readonly conn: ServerConn;
  readonly peer: GatewayPeer;
  readonly id: string;
  epoch: number;
  welcomed: boolean;
  closed: boolean;
  lastSeen: number;
  journalId: string;
  bootId: string;
}

/** One `nodes` + `node_sessions` row. */
export interface StubNode {
  readonly nodeId: string;
  role: AgentRole;
  epoch: number;
  bootId: string | undefined;
  journalId: string | undefined;
  connectivity: Connectivity;
  lastSeen: number;
  nextSeq: number;
  /** Cumulative event ack per journal. */
  readonly ackedEventSeq: Map<string, number>;
  readonly seenEvents: Set<string>;
  generation: number;
  spec: NodeSpec;
  specHash: Uint8Array;
  appliedGeneration: number;
  observedGeneration: number;
  /** Section name → lowercase hex SHA-256 of the stored content. */
  readonly inventoryHashes: Map<string, string>;
  readonly inventory: Map<string, Uint8Array>;
  conditions: Condition[];
  /** Allocations the node reported bound (AllocationBound), and failures (AllocationFailed). */
  readonly bound: Set<string>;
  readonly allocationFailures: Map<string, string>;
  duplicateIdentity: number;
  session: StubSession | undefined;
}

export interface GatewayStubOptions {
  scheduler: Scheduler;
  log?: EventLog;
  gatewayId?: string;
  heartbeatIntervalMs?: number;
  leaseTtlMs?: number;
  /** Extra time after the lease before a disconnected node turns unreachable (default 20 s). */
  unreachableGraceMs?: number;
  credits?: Partial<Record<Lane, number>>;
  /**
   * Credits granted in Welcome when they should differ from the ones dispatch counts against (a
   * gateway whose counters are out of sync, to exercise BUSY). Default: `credits`.
   */
  grantCredits?: Partial<Record<Lane, number>>;
  /** How long a dispatched command may stay non-terminal past `not_after` (default 10 min). */
  commandTimeoutMs?: number;
  busyBackoff?: { minMs: number; maxMs: number };
  /** Usage is flushed per active allocation this often (default 5 min). */
  usageFlushIntervalMs?: number;
  /** How spec changes are pushed: full specs (default) or section patches against the previous generation. */
  specMode?: 'full' | 'patch';
  /**
   * DELIBERATELY WRONG: release a node's allocations when its session closes. Exists to prove the
   * I5 checker catches it.
   */
  releaseOnDisconnect?: boolean;
  /**
   * DELIBERATELY WRONG: skip the journal-lost rule of the Hello transaction, so in-flight
   * non-retry-safe commands are replayed to a daemon that lost its journal. Exists to prove the I2
   * checker catches it.
   */
  skipJournalLostRule?: boolean;
}

export interface EnqueueOptions {
  /** Default: 5 minutes from now. */
  notAfter?: number;
  minGeneration?: number;
  /** Default: the kind's registry flags (`commandKinds`), false for unknown kinds. */
  retrySafe?: boolean;
  selfTerminating?: boolean;
  lane?: Lane;
  idempotencyKey?: string;
  id?: string;
}

export interface BookOptions {
  nodeId: string;
  deviceIds: readonly string[];
  /** Default: open-ended. */
  durationMs?: number;
  allocationId?: string;
  tenantId?: string;
  subject?: string;
  /** Skip the exclusion check (a buggy placer), to prove I1 catches it. */
  force?: boolean;
  env?: string[];
}

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
const sha256 = (bytes: Uint8Array): Uint8Array =>
  new Uint8Array(createHash('sha256').update(bytes).digest());
const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean =>
  a.byteLength === b.byteLength && a.every((v, i) => v === b[i]);

const UPDATE_STATE: Partial<Record<CommandState, StubCommandState>> = {
  [CommandState.SUCCEEDED]: 'succeeded',
  [CommandState.FAILED]: 'failed',
  [CommandState.CANCELLED]: 'cancelled',
  [CommandState.REJECTED]: 'rejected',
};

/** The in-memory gateway + control plane (see the file comment). */
export class GatewayStub implements GatewayPort {
  readonly nodes = new Map<string, StubNode>();
  readonly commands = new Map<string, StubCommand>();
  readonly allocations = new Map<string, StubAllocation>();
  /** Terminal command transitions, in order. */
  readonly outcomes: ServerOutcome[] = [];
  readonly releases: ReleaseFact[] = [];
  readonly connectivity: ConnectivityFact[] = [];
  readonly usage: UsageWindow[] = [];
  /** Protocol problems seen (bad hashes, frames before Hello, …). */
  readonly problems: string[] = [];
  /** Called for every terminal command transition. */
  onTerminal: ((command: StubCommand) => void) | undefined;

  private readonly scheduler: Scheduler;
  private readonly options: GatewayStubOptions;
  private readonly credits: Record<Lane, number>;
  private readonly bookingRows: BookingRow[] = [];
  private sessionSeq = 0;
  private commandSeq = 0;
  private allocationSeq = 0;
  private lastUsageFlush: number;

  constructor(options: GatewayStubOptions) {
    this.options = options;
    this.scheduler = options.scheduler;
    this.credits = {
      [Lane.UNSPECIFIED]: 0,
      [Lane.CONTROL]: options.credits?.[Lane.CONTROL] ?? 8,
      [Lane.PROVISION]: options.credits?.[Lane.PROVISION] ?? 4,
      [Lane.BULK]: options.credits?.[Lane.BULK] ?? 2,
    };
    this.lastUsageFlush = this.scheduler.now();
  }

  private get now(): number {
    return this.scheduler.now();
  }
  private get heartbeatMs(): number {
    return this.options.heartbeatIntervalMs ?? 10_000;
  }

  // ---- GatewayPort ------------------------------------------------------------------------------

  accept(conn: ServerConn, peer: GatewayPeer): void {
    const session: StubSession = {
      conn,
      peer,
      id: `ses_${++this.sessionSeq}`,
      epoch: 0,
      welcomed: false,
      closed: false,
      lastSeen: this.now,
      journalId: '',
      bootId: '',
    };
    conn.onFrame((frame) => this.onFrame(session, frame));
    conn.onClose((info) => this.onSessionClosed(session, info.reason));
  }

  tick(now: number): void {
    this.sweepCommands(now);
    this.liveness(now);
    for (const allocation of this.allocations.values())
      if (allocation.state === 'active' && allocation.end <= now)
        this.release(allocation.allocationId, 'ends-at');
    if (now - this.lastUsageFlush >= (this.options.usageFlushIntervalMs ?? 5 * 60_000))
      this.flushUsage();
    for (const node of this.nodes.values()) this.dispatch(node);
  }

  kill(reason: string): void {
    for (const node of this.nodes.values()) {
      const session = node.session;
      if (session && !session.closed) session.conn.abort(reason);
    }
  }

  facts(): GatewayFacts {
    return {
      bookings: this.bookingRows.map((row) => ({ ...row })),
      releases: [...this.releases],
      connectivity: [...this.connectivity],
      allocations: [...this.allocations.values()].map(
        (a): BilledAllocation => ({
          allocationId: a.allocationId,
          start: a.start,
          ...(a.releasedAt === undefined ? {} : { end: a.releasedAt }),
          atoms: a.deviceIds.length,
        }),
      ),
      usage: [...this.usage],
      outcomes: [...this.outcomes],
    };
  }

  // ---- control-plane API ------------------------------------------------------------------------

  /** Enqueues a built-in kind (payload packed as the kind's request). */
  enqueue<K extends CommandKind>(
    nodeId: string,
    kind: K,
    payload?: MessageInitShape<(typeof commandKinds)[K]['payload']>,
    options: EnqueueOptions = {},
  ): StubCommand {
    const spec = commandKinds[kind];
    return this.enqueueBody(nodeId, kind, {
      payload: packCommandPayload(
        kind,
        create(spec.payload as never, (payload ?? {}) as never) as CommandPayload<K>,
      ),
      options: {
        retrySafe: spec.retrySafe,
        selfTerminating: spec.selfTerminating,
        lane: spec.lane,
        ...options,
      },
      attested: spec.attested,
    });
  }

  /** Enqueues any kind without a payload (unknown kinds test UNSUPPORTED). */
  enqueueRaw(nodeId: string, kind: string, options: EnqueueOptions = {}): StubCommand {
    return this.enqueueBody(nodeId, kind, { options });
  }

  private enqueueBody(
    nodeId: string,
    kind: string,
    input: {
      payload?: MessageInitShape<typeof CommandBodySchema>['payload'];
      options: EnqueueOptions;
      attested?: boolean;
    },
  ): StubCommand {
    const node = this.node(nodeId);
    const { options } = input;
    if (options.idempotencyKey)
      for (const existing of this.commands.values())
        if (existing.nodeId === nodeId && existing.idempotencyKey === options.idempotencyKey)
          return existing;
    const id = options.id ?? `cmd_${String(++this.commandSeq).padStart(8, '0')}`;
    const seq = ++node.nextSeq;
    const notAfter = options.notAfter ?? this.now + 5 * 60_000;
    const known = isCommandKind(kind) ? commandKinds[kind] : undefined;
    const lane = options.lane ?? known?.lane ?? Lane.CONTROL;
    const retrySafe = options.retrySafe ?? known?.retrySafe ?? false;
    const selfTerminating = options.selfTerminating ?? known?.selfTerminating ?? false;
    const body = create(CommandBodySchema, {
      id,
      nodeId,
      seq: BigInt(seq),
      kind,
      payload: input.payload,
      lane,
      notAfter: timestampFromMs(Math.floor(notAfter)),
      minGeneration: BigInt(options.minGeneration ?? 0),
      retrySafe,
      idempotencyKey: options.idempotencyKey ?? id,
      selfTerminating,
      attested: input.attested ?? false,
    });
    const command: StubCommand = {
      id,
      nodeId,
      seq,
      kind,
      lane,
      retrySafe,
      selfTerminating,
      notAfter,
      minGeneration: options.minGeneration ?? 0,
      idempotencyKey: body.idempotencyKey,
      body: toBinary(CommandBodySchema, body),
      state: 'pending',
      epoch: 0,
      attempts: 0,
      notBefore: this.now,
      busyCount: 0,
      createdAt: this.now,
    };
    this.commands.set(id, command);
    this.log('command.enqueue', { id, node: nodeId, kind, seq });
    this.dispatch(node);
    return command;
  }

  /** Cancels a command: a pending one at once, a dispatched one through `Cancel{id}`. */
  cancel(commandId: string, reason = 'cancelled'): void {
    const command = this.commands.get(commandId);
    if (!command || isTerminal(command.state)) return;
    if (command.state === 'pending') {
      this.finish(command, 'cancelled', { errorCode: reason });
      return;
    }
    this.sendTo(this.node(command.nodeId), { case: 'cancel', value: { commandId, reason } });
  }

  /**
   * Books devices for a new allocation, as the placer's `INSERT … ON CONFLICT DO NOTHING` under
   * `EXCLUDE (device_id =, during &&)` would: `undefined` on a conflict (unless `force`). Adds the
   * assignment to the node's spec and pushes it.
   */
  book(options: BookOptions): StubAllocation | undefined {
    const start = this.now;
    const end = options.durationMs === undefined ? Infinity : start + options.durationMs;
    if (!options.force) {
      const wanted = new Set(options.deviceIds);
      for (const row of this.bookingRows)
        if (wanted.has(row.deviceId) && row.start < end && start < row.end) return undefined;
    }
    const allocationId =
      options.allocationId ?? `alloc_${String(++this.allocationSeq).padStart(6, '0')}`;
    const allocation: StubAllocation = {
      allocationId,
      nodeId: options.nodeId,
      deviceIds: [...options.deviceIds],
      tenantId: options.tenantId ?? 'tenant-acme',
      subject: options.subject ?? 'identity-acme',
      start,
      end,
      state: 'active',
      lastFlushedAt: start,
    };
    this.allocations.set(allocationId, allocation);
    for (const deviceId of options.deviceIds)
      this.bookingRows.push({ allocationId, deviceId, nodeId: options.nodeId, start, end });
    this.log('alloc.book', {
      allocation: allocationId,
      node: options.nodeId,
      devices: options.deviceIds.length,
    });
    this.updateSpec(options.nodeId, (spec) => {
      const devices = spec.devices ?? create(DevicesSectionSchema);
      devices.assignments.push(
        create(DeviceAssignmentSchema, {
          allocationId,
          reservationId: `rsv_${allocationId.slice(allocationId.indexOf('_') + 1)}`,
          binding: Binding.HOLD,
          devices: options.deviceIds.map((id) => ({ id, deviceClass: 'gpu' })),
          env: options.env ?? [],
        }),
      );
      spec.devices = devices;
    });
    return allocation;
  }

  /** Releases an allocation for an explicit cause: truncates `during`, flushes usage, updates the spec. */
  release(allocationId: string, reason: string): void {
    const allocation = this.allocations.get(allocationId);
    if (!allocation || allocation.state !== 'active') return;
    const now = this.now;
    this.flushAllocation(allocation, now);
    allocation.state = 'released';
    allocation.releasedAt = now;
    allocation.releaseReason = reason;
    for (const row of this.bookingRows)
      if (row.allocationId === allocationId && row.end > now) row.end = now;
    this.releases.push({ allocationId, nodeId: allocation.nodeId, at: now, reason });
    this.log('alloc.release', { allocation: allocationId, reason });
    this.updateSpec(allocation.nodeId, (spec) => {
      if (!spec.devices) return;
      spec.devices.assignments = spec.devices.assignments.filter(
        (a) => a.allocationId !== allocationId,
      );
    });
  }

  /** Changes a node's desired spec; bumps the generation and pushes it. */
  updateSpec(nodeId: string, mutate: (spec: NodeSpec) => void): void {
    const node = this.node(nodeId);
    const next = clone(NodeSpecSchema, node.spec);
    mutate(next);
    node.spec = next;
    node.generation++;
    node.specHash = sha256(toBinary(NodeSpecSchema, next));
    this.log('spec.bump', { node: nodeId, generation: node.generation });
    const session = node.session;
    if (!session?.welcomed || session.closed) return;
    if (this.options.specMode === 'patch' && node.generation > 1) {
      const patch = create(NodeSpecSchema, { devices: next.devices ?? {} });
      this.sendSpec(node, session, { base: node.generation - 1, spec: patch });
    } else this.sendSpec(node, session);
  }

  /** GPU UUIDs the node reported (its stored `gpus` section). */
  gpus(nodeId: string): string[] {
    const content = this.nodes.get(nodeId)?.inventory.get('gpus');
    if (!content) return [];
    return decodeInventorySection('gpus', content).gpus.map((gpu) => gpu.uuid);
  }

  /** GPUs of the node with no live booking right now. */
  freeGpus(nodeId: string): string[] {
    const now = this.now;
    const busy = new Set(
      this.bookingRows.filter((r) => r.start <= now && now < r.end).map((r) => r.deviceId),
    );
    return this.gpus(nodeId).filter((id) => !busy.has(id));
  }

  /** Flushes usage for every active allocation now (the usage sink's periodic flush). */
  flushUsage(): void {
    this.lastUsageFlush = this.now;
    for (const allocation of this.allocations.values())
      if (allocation.state === 'active')
        this.flushAllocation(allocation, Math.min(this.now, allocation.end));
  }

  /** The node row, created on first use. */
  node(nodeId: string): StubNode {
    let node = this.nodes.get(nodeId);
    if (!node) {
      const spec = create(NodeSpecSchema);
      node = {
        nodeId,
        role: AgentRole.NODE,
        epoch: 0,
        bootId: undefined,
        journalId: undefined,
        connectivity: 'never',
        lastSeen: this.now,
        nextSeq: 0,
        ackedEventSeq: new Map(),
        seenEvents: new Set(),
        generation: 0,
        spec,
        specHash: sha256(toBinary(NodeSpecSchema, spec)),
        appliedGeneration: 0,
        observedGeneration: 0,
        inventoryHashes: new Map(),
        inventory: new Map(),
        conditions: [],
        bound: new Set(),
        allocationFailures: new Map(),
        duplicateIdentity: 0,
        session: undefined,
      };
      this.nodes.set(nodeId, node);
    }
    return node;
  }

  /** The node's commands in seq order. */
  commandsOf(nodeId: string): StubCommand[] {
    return [...this.commands.values()]
      .filter((c) => c.nodeId === nodeId)
      .sort((a, b) => a.seq - b.seq);
  }

  // ---- session ----------------------------------------------------------------------------------

  private onFrame(session: StubSession, frame: AgentFrame): void {
    if (session.closed) return;
    const msg = frame.msg;
    if (!session.welcomed) {
      if (msg.case !== 'hello') {
        this.problem(`${session.peer.nodeId}: ${msg.case ?? 'empty frame'} before Hello`);
        session.conn.abort('PERMISSION_DENIED: Hello must come first');
        return;
      }
      this.onHello(session, msg.value);
      return;
    }
    const node = this.node(session.peer.nodeId);
    // Liveness is fenced by epoch: only the current session moves last_seen.
    if (node.session === session) {
      session.lastSeen = this.now;
      node.lastSeen = this.now;
    }
    switch (msg.case) {
      case 'hello':
        this.problem(`${node.nodeId}: second Hello on one stream`);
        session.conn.abort('protocol: second Hello');
        return;
      case 'heartbeat': {
        node.appliedGeneration = Math.max(
          node.appliedGeneration,
          Number(msg.value.appliedGeneration),
        );
        const changed = Object.entries(msg.value.inventoryHashes)
          .filter(([name, hash]) => node.inventoryHashes.get(name) !== hex(hash))
          .map(([name]) => name);
        if (changed.length > 0 && node.session === session) {
          const pending = [...this.commands.values()].some(
            (c) =>
              c.nodeId === node.nodeId && c.kind === 'inventory.refresh' && !isTerminal(c.state),
          );
          if (!pending) this.enqueue(node.nodeId, 'inventory.refresh', { sections: changed });
        }
        return;
      }
      case 'update': {
        const terminal = this.applyUpdate(node, msg.value);
        if (terminal)
          this.sendOn(session, { case: 'ack', value: { commandIds: [msg.value.commandId] } });
        this.dispatch(node);
        return;
      }
      case 'events':
        this.onEvents(node, session, msg.value);
        return;
      case 'status':
        node.observedGeneration = Math.max(
          node.observedGeneration,
          Number(msg.value.observedGeneration),
        );
        node.appliedGeneration = Math.max(
          node.appliedGeneration,
          Number(msg.value.appliedGeneration),
        );
        node.conditions = msg.value.conditions;
        return;
      case 'inventory': {
        const { section, content, sha256: claimed } = msg.value;
        if (
          !INVENTORY_SECTIONS.includes(section as never) ||
          !bytesEqual(sha256(content), claimed)
        ) {
          this.problem(`${node.nodeId}: inventory section ${section} does not match its sha256`);
          return;
        }
        node.inventory.set(section, content);
        node.inventoryHashes.set(section, hex(claimed));
        return;
      }
      case 'specRequest':
        this.log('spec.requested', {
          node: node.nodeId,
          have: Number(msg.value.haveGeneration),
          reason: msg.value.reason,
        });
        if (node.session === session && node.generation > 0) this.sendSpec(node, session);
        return;
      case 'secretRequest':
        this.sendOn(session, {
          case: 'secret',
          value: { ref: msg.value.ref, requestId: msg.value.requestId, error: 'not-found' },
        });
        return;
      default:
        this.problem(`${node.nodeId}: unexpected frame ${msg.case ?? 'empty'}`);
    }
  }

  /** The Hello transaction of PLAN.md §7.2, then Welcome, spec and replay. */
  private onHello(session: StubSession, hello: Hello): void {
    const { peer } = session;
    if (hello.nodeId !== peer.nodeId || hello.role !== peer.role) {
      this.problem(`${peer.nodeId}: Hello for ${hello.nodeId} does not match the certificate`);
      session.conn.abort('PERMISSION_DENIED: node id or role does not match the certificate');
      return;
    }
    const node = this.node(peer.nodeId);
    const now = this.now;
    node.epoch++;
    session.epoch = node.epoch;
    session.journalId = hello.journalId;
    session.bootId = hello.bootId;
    const previous = { bootId: node.bootId, journalId: node.journalId, role: node.role };
    const superseded = node.session;
    node.session = session;
    if (superseded && !superseded.closed) {
      if (superseded.bootId !== hello.bootId) node.duplicateIdentity++;
      superseded.conn.abort('ABORTED: superseded by a newer session');
    }
    node.bootId = hello.bootId;
    node.journalId = hello.journalId;
    node.role = hello.role;
    this.log('session.hello', {
      node: node.nodeId,
      epoch: node.epoch,
      journal: hello.journalId,
      boot: hello.bootId,
    });
    // 1. boot_id or role changed: in-flight self-terminating commands completed by the reboot.
    if (
      previous.bootId !== undefined &&
      (previous.bootId !== hello.bootId || previous.role !== hello.role)
    )
      for (const command of this.commandsOf(node.nodeId))
        if (IN_FLIGHT.has(command.state) && command.selfTerminating)
          this.finish(command, 'succeeded', { rebooted: true });
    // 2. journal_id changed: in-flight non-retry-safe commands fail instead of replaying.
    if (
      !this.options.skipJournalLostRule &&
      previous.journalId !== undefined &&
      previous.journalId !== hello.journalId
    )
      for (const command of this.commandsOf(node.nodeId))
        if (IN_FLIGHT.has(command.state) && !command.retrySafe)
          this.finish(command, 'failed', { errorCode: 'journal-lost' });
    const acked: string[] = [];
    for (const update of hello.unackedResults)
      if (this.applyUpdate(node, update)) acked.push(update.commandId);
    session.welcomed = true;
    session.lastSeen = now;
    node.lastSeen = now;
    this.setConnectivity(node, 'connected');

    const version =
      negotiateProtocolVersion({ min: hello.protoMin, max: hello.protoMax }) ??
      PROTOCOL_VERSION.min;
    const requestSections = INVENTORY_SECTIONS.filter((name) => {
      const hash = hello.inventoryHashes[name];
      return hash !== undefined && node.inventoryHashes.get(name) !== hex(hash);
    });
    this.sendOn(session, {
      case: 'welcome',
      value: {
        epoch: BigInt(node.epoch),
        sessionId: session.id,
        gatewayId: this.options.gatewayId ?? 'gw-stub',
        protocolVersion: version,
        heartbeatIntervalMs: this.heartbeatMs,
        leaseTtlMs: this.options.leaseTtlMs ?? 40_000,
        credits: [Lane.CONTROL, Lane.PROVISION, Lane.BULK].map((lane) => ({
          lane,
          credits: this.options.grantCredits?.[lane] ?? this.credits[lane],
        })),
        ackedEventSeq: BigInt(node.ackedEventSeq.get(hello.journalId) ?? 0),
        requestSections,
        serverTime: timestampFromMs(Math.floor(now)),
      },
    });
    const applied = Number(hello.appliedGeneration);
    node.appliedGeneration = applied;
    if (node.generation > 0) {
      if (applied === node.generation && !bytesEqual(hello.appliedSpecHash, node.specHash)) {
        // Same generation, another spec: move past it so the daemon takes the resend.
        node.generation++;
        this.sendSpec(node, session);
      } else if (applied < node.generation) this.sendSpec(node, session);
    }
    const running = new Set(hello.runningCommandIds);
    for (const command of this.commandsOf(node.nodeId))
      if (IN_FLIGHT.has(command.state) && !running.has(command.id))
        this.sendCommand(node, session, command);
    if (acked.length > 0) this.sendOn(session, { case: 'ack', value: { commandIds: acked } });
    this.dispatch(node);
  }

  private onSessionClosed(session: StubSession, reason: string): void {
    if (session.closed) return;
    session.closed = true;
    const node = this.nodes.get(session.peer.nodeId);
    if (!node || node.session !== session) return;
    node.session = undefined;
    this.log('session.closed', { node: node.nodeId, epoch: session.epoch, reason });
    this.setConnectivity(node, 'disconnected');
    if (this.options.releaseOnDisconnect)
      for (const allocation of this.allocations.values())
        if (allocation.nodeId === node.nodeId && allocation.state === 'active')
          this.release(allocation.allocationId, 'node-disconnected');
  }

  private setConnectivity(node: StubNode, state: Exclude<Connectivity, 'never'>): void {
    if (node.connectivity === state) return;
    node.connectivity = state;
    this.connectivity.push({ nodeId: node.nodeId, at: this.now, state });
    this.log('node.connectivity', { node: node.nodeId, state });
  }

  private liveness(now: number): void {
    const missed = 3 * this.heartbeatMs;
    const unreachableAfter =
      (this.options.leaseTtlMs ?? 40_000) + (this.options.unreachableGraceMs ?? 20_000);
    for (const node of this.nodes.values()) {
      const session = node.session;
      if (session && !session.closed && now - session.lastSeen > missed) {
        this.log('session.expired', { node: node.nodeId, epoch: session.epoch });
        session.conn.abort('three heartbeats missed');
        this.onSessionClosed(session, 'three heartbeats missed');
      }
      // Unreachable is a condition only: it releases nothing (P6, I5).
      if (node.connectivity === 'disconnected' && now - node.lastSeen > unreachableAfter)
        this.setConnectivity(node, 'unreachable');
    }
  }

  // ---- commands ---------------------------------------------------------------------------------

  private dispatch(node: StubNode): void {
    const session = node.session;
    if (!session?.welcomed || session.closed) return;
    const now = this.now;
    const commands = this.commandsOf(node.nodeId);
    const inFlight = new Map<Lane, number>();
    for (const command of commands)
      if (IN_FLIGHT.has(command.state))
        inFlight.set(command.lane, (inFlight.get(command.lane) ?? 0) + 1);
    for (const command of commands) {
      if (command.state !== 'pending' || command.notBefore > now || command.notAfter <= now)
        continue;
      const used = inFlight.get(command.lane) ?? 0;
      if (used >= this.credits[command.lane]) continue;
      inFlight.set(command.lane, used + 1);
      command.state = 'dispatched';
      this.sendCommand(node, session, command);
    }
  }

  private sendCommand(node: StubNode, session: StubSession, command: StubCommand): void {
    command.epoch = session.epoch;
    command.attempts++;
    this.sendOn(session, {
      case: 'command',
      value: { body: command.body, attempt: command.attempts },
    });
    void node;
  }

  /** Applies a CommandUpdate from any epoch (facts). Returns whether it was terminal (to Ack). */
  private applyUpdate(node: StubNode, update: CommandUpdate): boolean {
    const command = this.commands.get(update.commandId);
    const terminal =
      update.state === CommandState.SUCCEEDED ||
      update.state === CommandState.FAILED ||
      update.state === CommandState.CANCELLED ||
      (update.state === CommandState.REJECTED && update.rejectReason !== CommandRejectReason.BUSY);
    if (!command || command.nodeId !== node.nodeId) {
      this.problem(`${node.nodeId}: update for unknown command ${update.commandId}`);
      return terminal;
    }
    if (isTerminal(command.state)) return terminal;
    switch (update.state) {
      case CommandState.ACKED:
        if (command.state === 'pending' || command.state === 'dispatched') command.state = 'acked';
        return false;
      case CommandState.RUNNING:
        if (command.state !== 'running') command.state = 'running';
        return false;
      case CommandState.REJECTED:
        if (update.rejectReason === CommandRejectReason.BUSY) {
          // Only the dispatch that was refused goes back to pending; a late BUSY never regresses.
          if (command.state === 'dispatched') {
            const { minMs, maxMs } = this.options.busyBackoff ?? { minMs: 1_000, maxMs: 30_000 };
            command.state = 'pending';
            command.notBefore = this.now + Math.min(maxMs, minMs * 2 ** command.busyCount);
            command.busyCount++;
            this.log('command.busy', { id: command.id, retryAt: command.notBefore });
          }
          return false;
        }
        this.finish(command, 'rejected', { rejectReason: update.rejectReason });
        return true;
      default: {
        const state = UPDATE_STATE[update.state];
        if (!state) return false;
        this.finish(command, state, {
          result: update.result,
          ...(update.error ? { errorCode: update.error.code } : {}),
          rebooted: update.rebooted,
        });
        return true;
      }
    }
  }

  private finish(
    command: StubCommand,
    state: StubCommandState,
    extra: {
      result?: Uint8Array;
      errorCode?: string;
      rejectReason?: CommandRejectReason;
      rebooted?: boolean;
    } = {},
  ): void {
    if (isTerminal(command.state)) return;
    command.state = state;
    command.finishedAt = this.now;
    if (extra.result && extra.result.byteLength > 0) command.result = extra.result;
    if (extra.errorCode !== undefined) command.errorCode = extra.errorCode;
    if (extra.rejectReason !== undefined) command.rejectReason = extra.rejectReason;
    if (extra.rebooted) command.rebooted = true;
    this.outcomes.push({
      commandId: command.id,
      nodeId: command.nodeId,
      state,
      ...(command.errorCode === undefined ? {} : { errorCode: command.errorCode }),
    });
    this.log('command.finish', {
      id: command.id,
      state,
      code: command.errorCode ?? null,
      reject: command.rejectReason ?? null,
      rebooted: command.rebooted === true,
    });
    this.onTerminal?.(command);
  }

  private sweepCommands(now: number): void {
    const timeout = this.options.commandTimeoutMs ?? 10 * 60_000;
    for (const command of this.commands.values()) {
      if (command.state === 'pending' && now >= command.notAfter) this.finish(command, 'expired');
      else if (IN_FLIGHT.has(command.state) && now >= command.notAfter + timeout)
        this.finish(command, 'failed', { errorCode: 'timeout' });
    }
  }

  // ---- events, spec, usage ----------------------------------------------------------------------

  private onEvents(node: StubNode, session: StubSession, batch: EventBatch): void {
    let high = node.ackedEventSeq.get(batch.journalId) ?? 0;
    for (const event of batch.events) {
      const seq = Number(event.seq);
      const key = `${batch.journalId}:${seq}`;
      high = Math.max(high, seq);
      if (node.seenEvents.has(key) || seq <= (node.ackedEventSeq.get(batch.journalId) ?? 0))
        continue;
      node.seenEvents.add(key);
      const body = event.body;
      if (body.case === 'attested') {
        const report = unwrapAttestedReport(body.value);
        if (report.nodeId !== node.nodeId) {
          this.problem(`${node.nodeId}: attested report for ${report.nodeId}`);
          continue;
        }
        if (report.report.case === 'allocationBound')
          node.bound.add(report.report.value.allocationId);
        if (report.report.case === 'allocationReleased')
          node.bound.delete(report.report.value.allocationId);
      } else if (body.case === 'allocationFailed')
        node.allocationFailures.set(body.value.allocationId, body.value.reason);
    }
    node.ackedEventSeq.set(batch.journalId, high);
    this.sendOn(session, {
      case: 'ack',
      value: { journalId: batch.journalId, eventSeq: BigInt(high) },
    });
  }

  private sendSpec(
    node: StubNode,
    session: StubSession,
    patch?: { base: number; spec: NodeSpec },
  ): void {
    const body = create(DesiredStateBodySchema, {
      nodeId: node.nodeId,
      generation: BigInt(node.generation),
      baseGeneration: BigInt(patch?.base ?? 0),
      specHash: node.specHash,
      spec: patch ? { case: 'patch', value: patch.spec } : { case: 'full', value: node.spec },
    });
    this.sendOn(session, { case: 'desired', value: wrapDesiredState(body) });
  }

  private flushAllocation(allocation: StubAllocation, until: number): void {
    if (until <= allocation.lastFlushedAt) return;
    this.usage.push({
      key: `${allocation.allocationId}:${allocation.lastFlushedAt}`,
      allocationId: allocation.allocationId,
      start: allocation.lastFlushedAt,
      end: until,
      atoms: allocation.deviceIds.length,
    });
    allocation.lastFlushedAt = until;
  }

  // ---- helpers ----------------------------------------------------------------------------------

  private sendTo(node: StubNode, msg: MessageInitShape<typeof ServerFrameSchema>['msg']): boolean {
    const session = node.session;
    if (!session?.welcomed || session.closed) return false;
    return this.sendOn(session, msg);
  }

  private sendOn(
    session: StubSession,
    msg: MessageInitShape<typeof ServerFrameSchema>['msg'],
  ): boolean {
    return session.conn.send(create(ServerFrameSchema, { msg }) as ServerFrame);
  }

  private problem(message: string): void {
    this.problems.push(message);
    this.log('problem', { message });
  }

  private log(event: string, data?: Record<string, LogValue>): void {
    this.options.log?.add(this.options.gatewayId ?? 'gateway', event, data);
  }
}
