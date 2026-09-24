import { create, type MessageInitShape } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import {
  ComputeError,
  isComputeError,
  newId,
  systemClock,
  type AgentRole,
  type Clock,
  type EventPublisher,
  type Logger,
  type SqlExecutor,
  type WorkQueue,
} from '@better-compute/core';
import {
  AgentRole as WireRole,
  commandKinds,
  isCommandKind,
  Lane,
  PROTOCOL_VERSION,
  ServerFrameSchema,
  WelcomeSchema,
  negotiateProtocolVersion,
  type AgentFrame,
  type CommandUpdate,
  type DesiredState,
  type EventBatch,
  type Hello,
  type Heartbeat,
  type InventorySection,
  type JoinRequest,
  type JoinResponse,
  type RenewRequest,
  type RenewResponse,
  type SecretRequest,
  type ServerFrame,
  type SpecRequest,
  type StatusReport,
} from '@better-compute/protocol';
import type { GatewayServices } from '@better-compute/server';
import { GrpcCode, GrpcError, toGrpcError } from './grpc.js';
import { sqlEventPublisher, sqlWorkQueue } from './ports.js';
import {
  createGatewayStore,
  FencedError,
  isTerminalUpdate,
  type GatewayStore,
  type InventoryIngest,
  type LeaseToken,
  type ReportHandlers,
  type SpecSource,
  type StoredCommand,
} from './store.js';
import { TokenBucket } from './token-bucket.js';
import {
  createTunnelRegistry,
  type TunnelEndpoint,
  type TunnelHandle,
  type TunnelInfo,
  type TunnelOptions,
  type TunnelStreamHandle,
} from './tunnels.js';

/** Who is on the other end of a stream, from its mTLS certificate (§7.2). */
export interface PeerIdentity {
  nodeId: string;
  /** The certificate's role OID; when set, `Hello.role` must match it. */
  role?: AgentRole;
  siteId?: string;
  /** The leaf's serial (lower-case hex): revocations close the session carrying it. */
  serial?: string;
  /** The leaf's expiry (epoch ms): the session closes when it passes. */
  notAfter?: number;
  /**
   * A `node-tenant` certificate (§13): the tenant has root on the node, so it gets no secrets and
   * no destructive platform commands; those are rejected `tenant-controlled` instead of sent.
   */
  tenantControlled?: boolean;
}

/** What the gateway needs from a revocation feed (pki's `RevocationSet` satisfies it). */
export interface RevocationFeed {
  has(serial: string): boolean;
  subscribe(listener: (entry: { serial: string; reason?: string }) => void): () => void;
}

/** Where a session writes frames; implemented by the transport. */
export interface SessionSink {
  send(frame: ServerFrame): void;
  /** Ends the stream with a status (`OK` when omitted). */
  close(error?: GrpcError): void;
}

/** A session as the transport drives it. */
export interface SessionHandle {
  /** Handles one frame; frames are processed strictly in order. */
  receive(frame: AgentFrame): Promise<void>;
  /** The stream ended from the daemon's side (half-close, reset or network loss). */
  end(reason?: string): Promise<void>;
}

/** Per-lane credits (§7.5): commands in flight the gateway keeps outstanding per node. */
export type LaneCreditLimits = Record<'control' | 'provision' | 'bulk', number>;

export interface GatewayOptions {
  /** `gw_…`; one per process. Defaults to a fresh id. */
  id?: string;
  region: string;
  /** The internal mTLS endpoint the api dials (tunnels, forwarded calls). */
  internalUrl?: string;
  softwareVersion?: string;
  database: SqlExecutor;
  /** The api's JoinService and secret broker (dependency inversion, §8.2). */
  services: GatewayServices;
  clock?: Clock;
  /** Defaults to SQL on `work_queue`; pass the server's to share its implementation. */
  work?: WorkQueue;
  /** Defaults to SQL on `outbox`. */
  events?: EventPublisher;
  specs?: SpecSource;
  inventory?: InventoryIngest;
  /**
   * Transitions driven by node reports (AllocationBound/Released/Failed), injected by the host,
   * e.g. `{ allocationBound: (tx, c, r) => markAllocationBound(tx, c.work, r.allocationId, r) }`.
   */
  reports?: ReportHandlers;
  log?: Logger;
  /** Streams this gateway admits (default 5 000). */
  maxStreams?: number;
  heartbeatIntervalMs?: number;
  /** Daemon liveness lease (default 40 000 ms). */
  sessionLeaseTtlMs?: number;
  credits?: Partial<LaneCreditLimits>;
  /** Session opens and joins admitted per second (default 200, the §7.2 token bucket). */
  handshakesPerSecond?: number;
  /**
   * Hello transactions in flight at once (default 64). Beyond it a Hello is refused
   * `RESOURCE_EXHAUSTED` (retry with jitter), so a reconnect storm cannot queue enough database work
   * to starve the gateway's own lease renewal.
   */
  maxPendingHellos?: number;
  /** `gateway:<id>` lease TTL (default 20 000 ms), renewed every `leaseRenewMs` (5 000 ms). */
  gatewayLeaseTtlMs?: number;
  leaseRenewMs?: number;
  /** Liveness ages are flushed this often (default 15 000 ms). */
  livenessFlushMs?: number;
  dispatchIntervalMs?: number;
  dispatchBatch?: number;
  /** How often open sessions are checked for a newer NodeSpec generation (default 10 000 ms). */
  specSweepMs?: number;
  busyBackoff?: { initialMs?: number; maxMs?: number };
  /** No timers: tests and the simulator step `jobs` themselves. */
  manual?: boolean;
  capabilities?: string[];
  /**
   * Revoked certificate serials: refused at open, and a live session whose certificate is revoked
   * gets a RevocationNotice and is closed at once (§16: within 5 s of the revocation).
   */
  revocations?: RevocationFeed;
  /** Interactive tunnels (v0.3, §7.6): how exec tickets are verified and re-authorized. */
  tunnels?: TunnelOptions;
  /** For `Drain.reconnect_after_ms`; default `Math.random`. */
  random?: () => number;
}

/** One deterministic step of a gateway loop; resolves to the items it handled. */
export interface GatewayJob {
  tick(): Promise<number>;
}

export interface GatewaySessionInfo {
  nodeId: string;
  epoch: number;
  sessionId: string;
  role: AgentRole;
  bootId: string;
  journalId: string;
  lastSeenMs: number;
  inFlight: number;
  upgradeRequired: boolean;
}

export interface GatewayStatus {
  id: string;
  region: string;
  started: boolean;
  draining: boolean;
  sessions: number;
  maxStreams: number;
  /** The `gateway:<id>` lease epoch, or null while fenced. */
  leaseEpoch: number | null;
}

export interface Gateway {
  readonly id: string;
  /** Registers the directory row and takes the `gateway:<id>` lease; then admits sessions. */
  start(): Promise<void>;
  /** Closes every session (`UNAVAILABLE`), releases the lease and stops the loops. */
  stop(): Promise<void>;
  /**
   * Simulates process death for the simulator: loops stop and every session is forgotten with no
   * database write (no disconnect, no lease release). The lease simply expires.
   */
  crash(): void;
  /** A new stream. Throws `GrpcError` (`RESOURCE_EXHAUSTED`, `UNAVAILABLE`) when not admitted. */
  open(peer: PeerIdentity, sink: SessionSink): SessionHandle;
  /** Forwarded to the api's JoinService; counted against the handshake bucket. */
  join(request: JoinRequest): Promise<JoinResponse>;
  /** Forwarded to the api's JoinService, which verifies the proof of possession. */
  renew(request: RenewRequest, peer: PeerIdentity): Promise<RenewResponse>;
  /** Asks every daemon to reconnect elsewhere and refuses new sessions (rolling deploys). */
  drain(options?: { reason?: string }): Promise<void>;
  /** Pushes a RevocationNotice to the node's session and closes it (§13). */
  revoke(nodeId: string, notice: { reason: string; serials?: Uint8Array[] }): Promise<boolean>;
  /**
   * Runs dispatch soon, and a spec check for `nodeIds` when given: after an enqueue or a NodeSpec
   * bump commits. An accelerator only: the 1 s dispatch loop and the spec sweep converge without it.
   */
  poke(nodeIds?: readonly string[]): void;
  sessions(): GatewaySessionInfo[];
  /** What `GET /v1/health` reports. */
  status(): GatewayStatus;
  /**
   * Opens a tunnel to a node connected here, for a caller holding an exec ticket (v0.3, §7.6).
   * Resolves when the node's Tunnel stream is up.
   */
  openTunnel(request: { ticket: string; nodeId: string; caller: TunnelEndpoint }): Promise<TunnelHandle>;
  /** A daemon's `Tunnel` stream (its certificate identity is `peer`). */
  acceptTunnel(peer: PeerIdentity, node: TunnelEndpoint): TunnelStreamHandle;
  /** Closes matching tunnels (e.g. `delegation:revoke` by subject); returns how many. */
  closeTunnels(filter: { tunnelId?: string; nodeId?: string; subject?: string }, reason: string): number;
  tunnels(): (TunnelInfo & { state: string })[];
  readonly jobs: Readonly<{
    dispatch: GatewayJob;
    liveness: GatewayJob;
    lease: GatewayJob;
    specs: GatewayJob;
    status: GatewayJob;
  }>;
  /** The SQL layer, for the simulator and tests. */
  readonly store: GatewayStore;
}

const noopLog: Logger = { debug() {}, info() {}, warn() {}, error() {} };

const roleNames: Partial<Record<WireRole, AgentRole>> = {
  [WireRole.NODE]: 'node',
  [WireRole.SITE]: 'site',
  [WireRole.RAMDISK]: 'ramdisk',
};

const laneKeys: Record<'control' | 'provision' | 'bulk', Lane> = {
  control: Lane.CONTROL,
  provision: Lane.PROVISION,
  bulk: Lane.BULK,
};

type ServerFrameInit = NonNullable<MessageInitShape<typeof ServerFrameSchema>['msg']>;
const frame = (msg: ServerFrameInit): ServerFrame => create(ServerFrameSchema, { msg });

/** Destructive kinds need platform intent; an unknown kind is treated as destructive. */
const isDestructive = (kind: string): boolean =>
  isCommandKind(kind) ? commandKinds[kind].destructive : true;

/** A lower-case hex serial as the big-endian bytes RevocationNotice carries. */
const serialBytes = (serial: string): Uint8Array =>
  new Uint8Array(Buffer.from(serial.length % 2 ? `0${serial}` : serial, 'hex'));

interface LaneCounter {
  limit: number;
  used: number;
}

/** One live stream after its Hello. */
interface Session {
  readonly nodeId: string;
  readonly sessionId: string;
  readonly role: AgentRole;
  readonly bootId: string;
  readonly journalId: string;
  readonly tenantId: string;
  readonly epoch: number;
  readonly upgradeRequired: boolean;
  readonly sink: SessionSink;
  readonly peer: PeerIdentity;
  lastSeenMs: number;
  appliedGeneration: number;
  /** Highest generation sent as a full spec on this session. */
  sentGeneration: number;
  lanes: Map<Lane, LaneCounter>;
  /** Command id → lane, for credit release. */
  inFlight: Map<string, Lane>;
  busyCount: Map<string, number>;
  /** Cancel frames sent on this session (resent on the next session after a reconnect). */
  cancelsSent: Set<string>;
  pendingStatus?: StatusReport;
  closed: boolean;
}

/**
 * The gateway (PLAN.md §7, §8.1): daemon sessions, liveness, dispatch and forwarding, independent
 * of the transport (`serveGateway` puts it on gRPC/HTTP/2). Everything it knows about a node lives
 * in memory except what the store writes; restarting it loses nothing but open streams.
 */
export function createGateway(options: GatewayOptions): Gateway {
  const id = options.id ?? newId('gw');
  const clock = options.clock ?? systemClock;
  const log = options.log ?? noopLog;
  const random = options.random ?? Math.random;
  const events = options.events ?? sqlEventPublisher;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;
  const sessionLeaseTtlMs = options.sessionLeaseTtlMs ?? 40_000;
  const gatewayLeaseTtlMs = options.gatewayLeaseTtlMs ?? 20_000;
  const leaseRenewMs = options.leaseRenewMs ?? 5_000;
  const livenessFlushMs = options.livenessFlushMs ?? 15_000;
  const dispatchIntervalMs = options.dispatchIntervalMs ?? 1_000;
  const dispatchBatch = options.dispatchBatch ?? 1_000;
  const specSweepMs = options.specSweepMs ?? 10_000;
  const maxStreams = options.maxStreams ?? 5_000;
  const busyInitialMs = options.busyBackoff?.initialMs ?? 1_000;
  const busyMaxMs = options.busyBackoff?.maxMs ?? 30_000;
  const credits: LaneCreditLimits = { control: 8, provision: 4, bulk: 2, ...options.credits };
  const handshakes = new TokenBucket(options.handshakesPerSecond ?? 200, clock);
  const maxPendingHellos = options.maxPendingHellos ?? 64;
  let pendingHellos = 0;

  let lease: LeaseToken | undefined;
  let lastLeaseOkMs = 0;
  let started = false;
  let stopping = false;
  let draining = false;
  let lastFlushMs = clock.now();
  const sessions = new Map<string, Session>();
  const timers: ReturnType<typeof setInterval>[] = [];

  const store = createGatewayStore({
    database: options.database,
    work: options.work ?? sqlWorkQueue,
    events,
    specs: options.specs,
    inventory: options.inventory,
    reports: options.reports,
    fence: () => lease,
  });

  const tunnelRegistry = createTunnelRegistry({
    clock,
    log,
    options: options.tunnels,
    sendOpen(nodeId, tunnelId, ticket) {
      const session = sessions.get(nodeId);
      if (!session || session.closed || session.upgradeRequired) return false;
      session.sink.send(frame({ case: 'openTunnel', value: { tunnelId, ticket } }));
      return true;
    },
  });

  const backoffMs = (session: Session, commandId: string) => {
    const count = (session.busyCount.get(commandId) ?? 0) + 1;
    session.busyCount.set(commandId, count);
    return Math.min(busyMaxMs, busyInitialMs * 2 ** (count - 1));
  };

  function release(session: Session, commandId: string) {
    session.cancelsSent.delete(commandId);
    const lane = session.inFlight.get(commandId);
    if (lane === undefined) return;
    session.inFlight.delete(commandId);
    const counter = session.lanes.get(lane);
    if (counter) counter.used = Math.max(0, counter.used - 1);
  }

  function reserve(session: Session, command: StoredCommand): boolean {
    if (session.inFlight.has(command.id)) return true;
    const counter = session.lanes.get(command.lane) ?? session.lanes.get(Lane.CONTROL)!;
    if (counter.used >= counter.limit) return false;
    counter.used++;
    session.inFlight.set(command.id, command.lane);
    return true;
  }

  /** Counts a command already in flight on the daemon, even past the limit (heartbeats resync). */
  function reserveUnchecked(session: Session, command: StoredCommand) {
    if (session.inFlight.has(command.id)) return;
    session.inFlight.set(command.id, command.lane);
    const counter = session.lanes.get(command.lane);
    if (counter) counter.used++;
  }

  function sendCommand(session: Session, command: StoredCommand) {
    session.sink.send(
      frame({
        case: 'command',
        value: { body: command.body, signature: command.signature, attempt: Math.max(1, command.attempt) },
      }),
    );
  }

  function sendDesired(session: Session, desired: DesiredState | undefined, generation: number) {
    if (!desired || session.closed) return;
    session.sink.send(frame({ case: 'desired', value: desired }));
    session.sentGeneration = Math.max(session.sentGeneration, generation);
  }

  /**
   * Ends a session. `disconnect` writes the epoch-fenced disconnect; a superseded or fenced
   * session skips it (its row belongs to someone else now).
   */
  async function terminate(
    session: Session,
    error: GrpcError | undefined,
    disconnect: boolean,
    reason: string,
  ): Promise<void> {
    if (session.closed) return;
    session.closed = true;
    if (sessions.get(session.nodeId) === session) sessions.delete(session.nodeId);
    try {
      session.sink.close(error);
    } catch {
      // The transport may already be gone.
    }
    if (disconnect && lease)
      await store.disconnect(id, session.nodeId, session.epoch, reason).catch((cause: unknown) => {
        log.warn('gateway: disconnect write failed', { nodeId: session.nodeId, cause: String(cause) });
      });
  }

  /** Any failure while handling a frame drops the stream; the daemon redials and replays. */
  async function fail(session: Session, cause: unknown) {
    const fenced = cause instanceof FencedError;
    log.warn('gateway: session failed', { nodeId: session.nodeId, cause: String(cause) });
    await terminate(
      session,
      fenced
        ? new GrpcError(GrpcCode.UNAVAILABLE, 'gateway fenced; reconnect')
        : new GrpcError(GrpcCode.UNAVAILABLE, 'temporary failure; reconnect'),
      !fenced,
      fenced ? 'fenced' : 'error',
    );
  }

  async function onHello(peer: PeerIdentity, sink: SessionSink, hello: Hello): Promise<Session> {
    if (!started || stopping || !lease)
      throw new GrpcError(GrpcCode.UNAVAILABLE, 'gateway is not ready');
    if (draining) throw new GrpcError(GrpcCode.UNAVAILABLE, 'gateway is draining');
    if (hello.nodeId !== peer.nodeId)
      throw new GrpcError(GrpcCode.PERMISSION_DENIED, 'Hello.node_id does not match the certificate');
    const role = roleNames[hello.role];
    if (!role) throw new GrpcError(GrpcCode.INVALID_ARGUMENT, 'Hello.role is required');
    if (peer.role && peer.role !== role)
      throw new GrpcError(GrpcCode.PERMISSION_DENIED, `the certificate is not valid for role ${role}`);
    if (!hello.bootId || !hello.journalId)
      throw new GrpcError(GrpcCode.INVALID_ARGUMENT, 'Hello.boot_id and journal_id are required');
    const version = negotiateProtocolVersion({ min: hello.protoMin, max: hello.protoMax });

    // Admission control (§8.6 reconnect storms): Hello transactions queue on the database; past
    // `maxPendingHellos` the daemon retries with jitter instead of growing a queue that would starve
    // this gateway's own lease renewal and fence it.
    if (pendingHellos >= maxPendingHellos)
      throw new GrpcError(GrpcCode.RESOURCE_EXHAUSTED, 'gateway busy; retry with jitter');
    pendingHellos++;
    const sessionId = newId('req');
    const result = await store
      .hello(
        {
          gatewayId: id,
          sessionId,
          nodeId: hello.nodeId,
          bootId: hello.bootId,
          journalId: hello.journalId,
          role,
          runningCommandIds: hello.runningCommandIds,
          unackedResults: hello.unackedResults,
          inventoryHashes: hello.inventoryHashes,
        },
        { liveWindowMs: sessionLeaseTtlMs },
      )
      .catch((error: unknown) => {
        if (isComputeError(error, 'NOT_FOUND'))
          throw new GrpcError(GrpcCode.PERMISSION_DENIED, 'this node has not joined');
        if (error instanceof FencedError) {
          void jobs.lease.tick().catch(() => {});
          throw new GrpcError(GrpcCode.UNAVAILABLE, 'gateway fenced; reconnect');
        }
        throw error;
      })
      .finally(() => {
        pendingHellos--;
      });

    const previous = sessions.get(hello.nodeId);
    if (previous)
      await terminate(previous, new GrpcError(GrpcCode.ABORTED, 'superseded by a newer session'), false, 'superseded');

    const lanes = new Map<Lane, LaneCounter>();
    for (const [name, lane] of Object.entries(laneKeys))
      lanes.set(lane, { limit: credits[name as keyof LaneCreditLimits], used: 0 });
    const session: Session = {
      nodeId: hello.nodeId,
      sessionId,
      role,
      bootId: hello.bootId,
      journalId: hello.journalId,
      tenantId: result.tenantId,
      epoch: result.epoch,
      upgradeRequired: version === undefined,
      sink,
      peer,
      lastSeenMs: clock.now(),
      appliedGeneration: Number(hello.appliedGeneration),
      sentGeneration: 0,
      lanes,
      inFlight: new Map(),
      busyCount: new Map(),
      cancelsSent: new Set(),
      closed: false,
    };
    sessions.set(session.nodeId, session);

    sink.send(
      frame({
        case: 'welcome',
        value: create(WelcomeSchema, {
          epoch: BigInt(result.epoch),
          sessionId,
          gatewayId: id,
          protocolVersion: version ?? PROTOCOL_VERSION.min,
          heartbeatIntervalMs,
          leaseTtlMs: sessionLeaseTtlMs,
          credits: [...lanes].map(([lane, counter]) => ({ lane, credits: counter.limit })),
          ackedEventSeq: BigInt(result.ackedEventSeq),
          requestSections: result.requestSections,
          serverTime: timestampFromMs(clock.now()),
          upgradeRequired: version === undefined,
          capabilities: options.capabilities ?? [],
        }),
      }),
    );
    if (result.ackCommandIds.length)
      sink.send(
        frame({
          case: 'ack',
          value: {
            journalId: session.journalId,
            eventSeq: BigInt(result.ackedEventSeq),
            commandIds: result.ackCommandIds,
          },
        }),
      );
    if (session.upgradeRequired) return session;

    if (
      session.appliedGeneration < result.generation ||
      (result.generation > 0 && !hello.appliedSpecHash.byteLength)
    )
      sendDesired(session, await store.desired(session.nodeId), result.generation);
    else session.sentGeneration = result.generation;
    for (const command of [...result.running, ...result.replay]) reserveUnchecked(session, command);
    for (const command of result.replay) sendCommand(session, command);
    gateway.poke();
    return session;
  }

  async function onHeartbeat(session: Session, heartbeat: Heartbeat) {
    session.lastSeenMs = clock.now();
    session.appliedGeneration = Math.max(
      session.appliedGeneration,
      Number(heartbeat.appliedGeneration),
    );
    for (const { lane, credits: free } of heartbeat.credits) {
      const counter = session.lanes.get(lane);
      if (counter) counter.used = Math.min(counter.limit, Math.max(0, counter.limit - free));
    }
    if (Object.keys(heartbeat.inventoryHashes).length)
      await store.inventoryHashes(session.nodeId, session.bootId, heartbeat.inventoryHashes);
  }

  async function onUpdates(session: Session, updates: CommandUpdate[]) {
    const result = await store.updates(session.nodeId, session.tenantId, updates, (commandId) =>
      backoffMs(session, commandId),
    );
    for (const update of updates) if (isTerminalUpdate(update)) release(session, update.commandId);
    for (const commandId of result.busy) release(session, commandId);
    for (const settled of result.settled) session.busyCount.delete(settled.id);
    if (result.ackCommandIds.length)
      session.sink.send(
        frame({
          case: 'ack',
          value: { journalId: session.journalId, commandIds: result.ackCommandIds },
        }),
      );
    if (result.busy.length) gateway.poke();
  }

  async function onEvents(session: Session, batch: EventBatch) {
    const result = await store.events(session.nodeId, session.tenantId, batch);
    if (!result) return;
    session.sink.send(
      frame({
        case: 'ack',
        value: { journalId: batch.journalId, eventSeq: BigInt(result.ackedEventSeq) },
      }),
    );
  }

  async function onInventory(session: Session, section: InventorySection) {
    try {
      await store.inventory(session.nodeId, section);
    } catch (error) {
      if (!isComputeError(error, 'INVALID_INPUT')) throw error;
      log.warn('gateway: inventory section rejected', {
        nodeId: session.nodeId,
        section: section.section,
        cause: error.message,
      });
    }
  }

  async function onSpecRequest(session: Session, _request: SpecRequest) {
    const desired = await store.desired(session.nodeId);
    const generations = await store.generations([session.nodeId]);
    sendDesired(session, desired, generations.get(session.nodeId) ?? 0);
  }

  function onSecret(session: Session, request: SecretRequest) {
    if (session.peer.tenantControlled) {
      // The tenant holds root on this node: platform secrets never go there (§13).
      session.sink.send(
        frame({
          case: 'secret',
          value: { ref: request.ref, requestId: request.requestId, error: 'access-denied' },
        }),
      );
      return;
    }
    // Outside the frame queue: the broker may be slow and nothing else depends on its answer.
    options.services.secret(request).then(
      (response) => {
        if (!session.closed) session.sink.send(frame({ case: 'secret', value: response }));
      },
      (error: unknown) => {
        const code = isComputeError(error) ? error.code : undefined;
        const refusal =
          code === 'NOT_FOUND'
            ? 'not-found'
            : code === 'ACCESS_DENIED'
              ? 'access-denied'
              : code === 'INVALID_STATE'
                ? 'not-bound'
                : 'unavailable';
        if (!session.closed)
          session.sink.send(
            frame({
              case: 'secret',
              value: { ref: request.ref, requestId: request.requestId, error: refusal },
            }),
          );
      },
    );
  }

  /** Sends a full spec to each session whose node moved past what it holds and was sent. */
  async function pushSpecs(candidates: Session[]): Promise<number> {
    const open = candidates.filter((session) => !session.closed && !session.upgradeRequired);
    if (!open.length) return 0;
    const generations = await store.generations(open.map((session) => session.nodeId));
    let sent = 0;
    for (const session of open) {
      const generation = generations.get(session.nodeId) ?? 0;
      if (generation > session.sentGeneration && generation > session.appliedGeneration) {
        sendDesired(session, await store.desired(session.nodeId), generation);
        sent++;
      }
    }
    return sent;
  }

  function job(run: () => Promise<number>): GatewayJob {
    let running: Promise<number> | undefined;
    return {
      tick() {
        running ??= run().finally(() => {
          running = undefined;
        });
        return running;
      },
    };
  }

  const jobs = {
    dispatch: job(async () => {
      if (!lease || stopping) return 0;
      const live = [...sessions.values()].filter((session) => !session.closed && !session.upgradeRequired);
      if (!live.length) return 0;
      const blocked = new Set<string>();
      const sent = await store
        .dispatch(id, dispatchBatch, (candidates) => {
          const refuse: { command: StoredCommand; reason: string }[] = [];
          const send = candidates.filter((command) => {
            const session = sessions.get(command.nodeId);
            const laneKey = `${command.nodeId}:${command.lane}`;
            if (!session || session.closed || session.upgradeRequired) return false;
            if (session.epoch !== command.epoch || blocked.has(laneKey)) return false;
            if (!command.valid) {
              refuse.push({ command, reason: 'invalid-body' });
              return false;
            }
            if (session.peer.tenantControlled && isDestructive(command.kind)) {
              refuse.push({ command, reason: 'tenant-controlled' });
              return false;
            }
            // Per-lane order: once a lane is out of credit, later commands of that lane wait.
            if (!reserve(session, command)) {
              blocked.add(laneKey);
              return false;
            }
            return true;
          });
          return { send, refuse };
        })
        .catch(async (error: unknown) => {
          if (error instanceof FencedError) await fence('dispatch fenced');
          throw error;
        });
      for (const command of sent) {
        const session = sessions.get(command.nodeId);
        // A session that closed after commit leaves the row dispatched: Hello replays it.
        if (session && !session.closed && session.epoch === command.epoch) sendCommand(session, command);
      }
      // Cancels requested after dispatch: one Cancel per session, until the daemon settles it.
      for (const cancel of await store.cancels(id)) {
        const session = sessions.get(cancel.nodeId);
        if (!session || session.closed || session.epoch !== cancel.epoch || session.cancelsSent.has(cancel.id))
          continue;
        session.cancelsSent.add(cancel.id);
        session.sink.send(frame({ case: 'cancel', value: { commandId: cancel.id, reason: cancel.reason } }));
      }
      return sent.length;
    }),

    liveness: job(async () => {
      const now = clock.now();
      let handled = await tunnelRegistry.sweep();
      for (const session of [...sessions.values()])
        if (session.peer.notAfter !== undefined && now > session.peer.notAfter) {
          await terminate(
            session,
            new GrpcError(GrpcCode.UNAUTHENTICATED, 'certificate expired; renew and reconnect'),
            true,
            'certificate-expired',
          );
          handled++;
        } else if (now - session.lastSeenMs > 3 * heartbeatIntervalMs) {
          await terminate(
            session,
            new GrpcError(GrpcCode.UNAVAILABLE, 'missed heartbeats'),
            true,
            'heartbeat-timeout',
          );
          handled++;
        }
      if (now - lastFlushMs < livenessFlushMs || !lease) return handled;
      lastFlushMs = now;
      const open = [...sessions.values()];
      const alive = await store.flushLiveness(
        id,
        open.map((session) => ({
          nodeId: session.nodeId,
          epoch: session.epoch,
          ageMs: Math.max(0, now - session.lastSeenMs),
        })),
      );
      for (const session of open)
        if (!alive.has(session.nodeId) && !session.closed) {
          // Another gateway's Hello bumped the epoch: this stream is a zombie.
          await terminate(session, new GrpcError(GrpcCode.ABORTED, 'superseded by a newer session'), false, 'superseded');
          handled++;
        }
      return handled + open.length;
    }),

    lease: job(async () => {
      const name = `gateway:${id}`;
      try {
        const epoch = await store.acquireLease(name, id, gatewayLeaseTtlMs);
        if (epoch === undefined) {
          await fence('lease held by another owner');
          return 0;
        }
        lease = { name, owner: id, epoch };
        lastLeaseOkMs = clock.now();
        await store.heartbeat(id, sessions.size, draining);
        return 1;
      } catch (error) {
        // Self-fence after TTL/2 without a successful renewal (§7.8).
        if (clock.now() - lastLeaseOkMs > gatewayLeaseTtlMs / 2) await fence('lease renewal failing');
        log.warn('gateway: lease renewal failed', { cause: String(error) });
        return 0;
      }
    }),

    specs: job(() => pushSpecs([...sessions.values()])),

    status: job(async () => {
      let flushed = 0;
      for (const session of sessions.values()) {
        const report = session.pendingStatus;
        if (!report || session.closed) continue;
        session.pendingStatus = undefined;
        await store.status(session.nodeId, session.tenantId, report);
        flushed++;
      }
      return flushed;
    }),
  };

  async function fence(reason: string) {
    lease = undefined;
    log.error('gateway: fenced; dropping every stream', { reason });
    for (const session of [...sessions.values()])
      await terminate(session, new GrpcError(GrpcCode.UNAVAILABLE, 'gateway fenced; reconnect'), false, 'fenced');
  }

  let pokeScheduled = false;
  const pokedSpecs = new Set<string>();
  let unsubscribe: (() => void) | undefined;

  const gateway: Gateway = {
    id,
    store,
    jobs,

    async start() {
      if (started) return;
      await store.register({
        id,
        region: options.region,
        internalUrl: options.internalUrl ?? '',
        softwareVersion: options.softwareVersion ?? '0.1.0',
        maxStreams,
      });
      if (!(await jobs.lease.tick()))
        throw new ComputeError('INVALID_STATE', `Gateway ${id} could not take its lease`);
      started = true;
      unsubscribe = options.revocations?.subscribe((entry) => {
        for (const session of [...sessions.values()])
          if (session.peer.serial === entry.serial)
            void gateway
              .revoke(session.nodeId, {
                reason: entry.reason ?? 'certificate revoked',
                serials: [serialBytes(entry.serial)],
              })
              .catch((error: unknown) => log.warn('gateway: revocation push failed', { cause: String(error) }));
      });
      if (options.manual) return;
      const every = (ms: number, gatewayJob: GatewayJob) => {
        const timer = setInterval(() => {
          gatewayJob.tick().catch((error: unknown) => log.warn('gateway: job failed', { cause: String(error) }));
        }, ms);
        timer.unref?.();
        timers.push(timer);
      };
      every(leaseRenewMs, jobs.lease);
      every(dispatchIntervalMs, jobs.dispatch);
      every(dispatchIntervalMs, jobs.status);
      every(Math.min(livenessFlushMs, heartbeatIntervalMs / 2), jobs.liveness);
      every(specSweepMs, jobs.specs);
    },

    async stop() {
      if (stopping) return;
      stopping = true;
      unsubscribe?.();
      for (const timer of timers.splice(0)) clearInterval(timer);
      tunnelRegistry.closeWhere({}, 'gateway-stopped');
      for (const session of [...sessions.values()])
        await terminate(session, new GrpcError(GrpcCode.UNAVAILABLE, 'gateway stopping'), true, 'gateway-stopped');
      if (lease) {
        await store.heartbeat(id, 0, true).catch(() => {});
        await store.releaseLease(lease).catch(() => {});
      }
      lease = undefined;
    },

    crash() {
      stopping = true;
      unsubscribe?.();
      for (const timer of timers.splice(0)) clearInterval(timer);
      lease = undefined;
      tunnelRegistry.closeWhere({}, 'gateway-crashed');
      for (const session of sessions.values()) session.closed = true;
      sessions.clear();
    },

    openTunnel(request) {
      if (!started || stopping) return Promise.reject(new ComputeError('INVALID_STATE', 'gateway is not ready'));
      return tunnelRegistry.open(request);
    },

    acceptTunnel(peer, node) {
      if (!started || stopping) throw new GrpcError(GrpcCode.UNAVAILABLE, 'gateway is not ready');
      if (peer.serial && options.revocations?.has(peer.serial))
        throw new GrpcError(GrpcCode.UNAUTHENTICATED, 'certificate revoked');
      return tunnelRegistry.accept(peer, node);
    },

    closeTunnels: (filter, reason) => tunnelRegistry.closeWhere(filter, reason),

    tunnels: () => tunnelRegistry.list(),

    open(peer, sink) {
      if (!started || stopping || !lease) throw new GrpcError(GrpcCode.UNAVAILABLE, 'gateway is not ready');
      if (draining) throw new GrpcError(GrpcCode.UNAVAILABLE, 'gateway is draining');
      if (sessions.size >= maxStreams && !sessions.has(peer.nodeId))
        throw new GrpcError(GrpcCode.RESOURCE_EXHAUSTED, 'gateway is at its stream limit');
      if (peer.serial && options.revocations?.has(peer.serial))
        throw new GrpcError(GrpcCode.UNAUTHENTICATED, 'certificate revoked');
      if (!handshakes.take())
        throw new GrpcError(GrpcCode.RESOURCE_EXHAUSTED, 'handshake rate exceeded; retry with jitter');

      let session: Session | undefined;
      let ended = false;
      let queue: Promise<void> = Promise.resolve();

      const handle = async (agentFrame: AgentFrame) => {
        if (ended) return;
        const msg = agentFrame.msg;
        if (!session) {
          if (msg.case !== 'hello') {
            ended = true;
            sink.close(new GrpcError(GrpcCode.INVALID_ARGUMENT, 'the first frame must be Hello'));
            return;
          }
          try {
            session = await onHello(peer, sink, msg.value);
          } catch (error) {
            ended = true;
            sink.close(toGrpcError(error));
          }
          return;
        }
        if (session.closed) return;
        session.lastSeenMs = clock.now();
        try {
          switch (msg.case) {
            case 'hello':
              await terminate(session, new GrpcError(GrpcCode.INVALID_ARGUMENT, 'duplicate Hello'), true, 'protocol');
              return;
            case 'heartbeat':
              return await onHeartbeat(session, msg.value);
            case 'update':
              return await onUpdates(session, [msg.value]);
            case 'events':
              return await onEvents(session, msg.value);
            case 'status':
              session.pendingStatus = msg.value;
              session.appliedGeneration = Math.max(session.appliedGeneration, Number(msg.value.appliedGeneration));
              return;
            case 'inventory':
              return await onInventory(session, msg.value);
            case 'specRequest':
              return await onSpecRequest(session, msg.value);
            case 'secretRequest':
              return onSecret(session, msg.value);
            default:
              // An unknown frame from a newer daemon: ignored (additive protocol, §7.6).
              return;
          }
        } catch (error) {
          await fail(session, error);
        }
      };

      return {
        receive(agentFrame) {
          queue = queue.then(() => handle(agentFrame));
          return queue;
        },
        end(reason = 'stream-closed') {
          queue = queue.then(async () => {
            ended = true;
            if (session) await terminate(session, undefined, true, reason);
          });
          return queue;
        },
      };
    },

    async join(request) {
      if (!handshakes.take())
        throw new GrpcError(GrpcCode.RESOURCE_EXHAUSTED, 'handshake rate exceeded; retry with jitter');
      return options.services.join(request);
    },

    async renew(request, _peer) {
      return options.services.renew(request);
    },

    async drain(drainOptions = {}) {
      draining = true;
      for (const session of sessions.values())
        if (!session.closed)
          session.sink.send(
            frame({
              case: 'drain',
              value: {
                reconnectAfterMs: Math.floor(random() * 60_000),
                reason: drainOptions.reason ?? 'gateway draining',
              },
            }),
          );
      if (lease) await store.heartbeat(id, sessions.size, true);
    },

    async revoke(nodeId, notice) {
      tunnelRegistry.closeWhere({ nodeId }, 'revoked');
      const session = sessions.get(nodeId);
      if (!session || session.closed) return false;
      session.sink.send(
        frame({
          case: 'revoked',
          value: { reason: notice.reason, serials: notice.serials ?? [] },
        }),
      );
      await terminate(session, new GrpcError(GrpcCode.UNAUTHENTICATED, 'certificate revoked'), true, 'revoked');
      return true;
    },

    poke(nodeIds) {
      if (options.manual || stopping) return;
      for (const nodeId of nodeIds ?? []) pokedSpecs.add(nodeId);
      if (pokeScheduled) return;
      pokeScheduled = true;
      setImmediate(() => {
        pokeScheduled = false;
        jobs.dispatch.tick().catch((error: unknown) => log.warn('gateway: dispatch failed', { cause: String(error) }));
        if (!pokedSpecs.size) return;
        // Only the named nodes: a full sweep per poke would scan every session (the sweep does that).
        const targets = [...pokedSpecs].flatMap((nodeId) => sessions.get(nodeId) ?? []);
        pokedSpecs.clear();
        pushSpecs(targets).catch((error: unknown) => log.warn('gateway: spec push failed', { cause: String(error) }));
      });
    },

    sessions() {
      return [...sessions.values()].map((session) => ({
        nodeId: session.nodeId,
        epoch: session.epoch,
        sessionId: session.sessionId,
        role: session.role,
        bootId: session.bootId,
        journalId: session.journalId,
        lastSeenMs: session.lastSeenMs,
        inFlight: session.inFlight.size,
        upgradeRequired: session.upgradeRequired,
      }));
    },

    status() {
      return {
        id,
        region: options.region,
        started,
        draining,
        sessions: sessions.size,
        maxStreams,
        leaseEpoch: lease?.epoch ?? null,
      };
    },
  };
  return gateway;
}
