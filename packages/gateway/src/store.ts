import { createHash } from 'node:crypto';
import { fromBinary, fromJson, toBinary, toJson, type JsonValue } from '@bufbuild/protobuf';
import {
  canTransition,
  commandStateTable,
  commandTerminalStates,
  ComputeError,
  type AgentRole,
  type CommandState,
  type CommandVerb,
  type EventPublisher,
  type Json,
  type SqlExecutor,
  type SqlTx,
  type WorkQueue,
} from '@better-compute/core';
import { ingestInventorySection, recordInventoryHashes } from '@better-compute/inventory';
import {
  AttestedReportBodySchema,
  CommandBodySchema,
  CommandRejectReason,
  CommandState as WireState,
  DesiredStateBodySchema,
  EventSchema,
  Lane,
  NodeSpecSchema,
  protocolRegistry,
  SignatureSchema,
  StatusReportSchema,
  decodeMessage,
  unwrapAttestedReport,
  wrapDesiredState,
  type AllocationBound,
  type AllocationFailed,
  type AllocationReleased,
  type CommandUpdate,
  type DesiredState,
  type EventBatch,
  type InventorySection,
  type Signature,
  type StatusReport,
} from '@better-compute/protocol';

/** A command row as the gateway sends it: the stored body and signature bytes, verbatim. */
export interface StoredCommand {
  id: string;
  nodeId: string;
  seq: number;
  kind: string;
  body: Uint8Array;
  signature?: Signature;
  state: CommandState;
  lane: Lane;
  /** Delivery attempt (`Command.attempt`), counted per send. */
  attempt: number;
  /** The body decodes, carries `not_after`, and names this row's command and node. */
  valid: boolean;
}

/** A command that reached a terminal state in a gateway transaction. */
export interface SettledCommand {
  id: string;
  kind: string;
  state: CommandState;
  reason?: string;
}

export interface HelloInput {
  gatewayId: string;
  sessionId: string;
  nodeId: string;
  bootId: string;
  journalId: string;
  role: AgentRole;
  /** Commands the journal holds as running: settled by the daemon later, never re-sent. */
  runningCommandIds: readonly string[];
  /** `Hello.unacked_results`, applied in the same transaction before the replay is chosen. */
  unackedResults: readonly CommandUpdate[];
  /** `Hello.inventory_hashes`: section name → SHA-256 of its content. */
  inventoryHashes: Readonly<Record<string, Uint8Array>>;
}

export interface HelloResult {
  epoch: number;
  tenantId: string;
  /** Cumulative event ack for `journalId` (0 after a journal change). */
  ackedEventSeq: number;
  generation: number;
  /** Non-terminal in-flight commands to re-send, in `seq` order, now stamped with `epoch`. */
  replay: StoredCommand[];
  /** In-flight commands the journal reported running: not re-sent, but they hold credits. */
  running: StoredCommand[];
  /** Commands settled by the self-terminating and journal-lost rules and by `unackedResults`. */
  settled: SettledCommand[];
  /** Terminal `unackedResults` the daemon may stop replaying. */
  ackCommandIds: string[];
  /** Inventory sections to pull now (`Welcome.request_sections`). */
  requestSections: string[];
  journalChanged: boolean;
  bootChanged: boolean;
  /** The node has commands waiting for dispatch (so the Hello is worth a dispatch poke). */
  hasPending: boolean;
}

export interface UpdatesResult {
  settled: SettledCommand[];
  /** Terminal updates now stored (or already stored): `Ack.command_ids`. */
  ackCommandIds: string[];
  /** Commands the daemon answered `BUSY`, now `pending` again. */
  busy: string[];
}

/** One daemon's liveness, flushed as an age so gateway clock skew cannot fake it (§7.5). */
export interface LivenessEntry {
  nodeId: string;
  epoch: number;
  ageMs: number;
}

/** A `leases` row this process holds (§8.5). */
export interface LeaseToken {
  name: string;
  owner: string;
  epoch: number;
}

/** Renders a node's desired state; the default reads `nodes.spec` as protobuf JSON of `NodeSpec`. */
export interface SpecSource {
  load(tx: SqlTx, nodeId: string): Promise<DesiredState | undefined>;
}

/**
 * Inventory ingestion (§10.1), in the gateway's transactions. The default is
 * `@better-compute/inventory`'s store: hashes land in `node_inventory`, pulled sections in
 * `node_inventory_sections`, and the Inventory reconciler builds snapshots from them.
 */
export interface InventoryIngest {
  /** Stores reported hashes; returns the sections to pull (`Welcome.request_sections`). */
  recordHashes(
    tx: SqlTx,
    work: WorkQueue,
    nodeId: string,
    hashes: Readonly<Record<string, Uint8Array>>,
    options: { bootId?: string },
  ): Promise<string[]>;
  /** Verifies a section against its own sha256 (`INVALID_INPUT` otherwise) and stores it. */
  ingestSection(
    tx: SqlTx,
    work: WorkQueue,
    nodeId: string,
    section: { section: string; content: Uint8Array; sha256: Uint8Array },
  ): Promise<void>;
}

/** Where a node's report came from, for the handlers below. */
export interface ReportContext {
  nodeId: string;
  tenantId: string;
  journalId: string;
  seq: number;
  /** The boot the node reported from (`AttestedReportBody.boot_id`; empty for unattested). */
  bootId: string;
  /** Whether a `node_sig` came with it. Verified by workers from v0.2; never trusted as proof here. */
  signed: boolean;
  work: WorkQueue;
}

/**
 * State transitions driven by node reports, injected by the host (the gateway imports no domain
 * module). Each runs in the transaction that stores the event and advances the ack, so a report is
 * applied exactly once. Reports whose `node_id` is not the session's are never passed on.
 */
export interface ReportHandlers {
  allocationBound?(tx: SqlTx, context: ReportContext, report: AllocationBound): Promise<unknown>;
  allocationReleased?(tx: SqlTx, context: ReportContext, report: AllocationReleased): Promise<unknown>;
  allocationFailed?(tx: SqlTx, context: ReportContext, report: AllocationFailed): Promise<unknown>;
}

export const inventoryStore: InventoryIngest = {
  recordHashes: (tx, work, nodeId, hashes, options) =>
    recordInventoryHashes(tx, work, nodeId, hashes, options),
  ingestSection: (tx, work, nodeId, section) => ingestInventorySection(tx, work, nodeId, section),
};

/** Raised inside a fenced transaction when this process no longer holds its gateway lease. */
export class FencedError extends ComputeError {
  constructor(lease: string) {
    super('INVALID_STATE', `Lease ${lease} is no longer held by this process`);
    this.name = 'ComputeError';
  }
}

export interface GatewayStoreOptions {
  database: SqlExecutor;
  work: WorkQueue;
  events: EventPublisher;
  specs?: SpecSource;
  inventory?: InventoryIngest;
  reports?: ReportHandlers;
  /** The lease every routing transaction re-checks first (`FOR SHARE`); undefined = not held. */
  fence: () => LeaseToken | undefined;
}

const inFlight = ['dispatched', 'acked', 'running'];
const bytesOf = (value: unknown): Uint8Array =>
  value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(0);

/** Wire state of a CommandUpdate → the verb the state table applies. */
function verbOf(update: CommandUpdate): CommandVerb | undefined {
  switch (update.state) {
    case WireState.ACKED:
      return 'ack';
    case WireState.RUNNING:
      return 'start';
    case WireState.SUCCEEDED:
      return 'succeed';
    case WireState.FAILED:
      return 'fail';
    case WireState.REJECTED:
      return update.rejectReason === CommandRejectReason.BUSY ? 'busy' : 'reject';
    case WireState.CANCELLED:
      return 'cancel';
    default:
      return undefined;
  }
}

const terminalWire = new Set<WireState>([
  WireState.SUCCEEDED,
  WireState.FAILED,
  WireState.REJECTED,
  WireState.CANCELLED,
]);

/** Whether an update is terminal and so journaled until acked (BUSY is not: it is a refusal). */
export function isTerminalUpdate(update: CommandUpdate): boolean {
  return (
    terminalWire.has(update.state) &&
    !(update.state === WireState.REJECTED && update.rejectReason === CommandRejectReason.BUSY)
  );
}

function reasonOf(update: CommandUpdate): string | null {
  switch (update.state) {
    case WireState.FAILED:
      return update.error?.code || 'failed';
    case WireState.REJECTED:
      return (CommandRejectReason[update.rejectReason] ?? 'UNSPECIFIED')
        .toLowerCase()
        .replace(/_/g, '-');
    case WireState.SUCCEEDED:
      return update.rebooted ? 'rebooted' : null;
    default:
      return null;
  }
}

function storedCommand(row: Record<string, unknown>): StoredCommand {
  const body = bytesOf(row.body);
  let lane = Lane.CONTROL;
  let valid = false;
  try {
    const decoded = decodeMessage(CommandBodySchema, body);
    lane = decoded.lane || Lane.CONTROL;
    // PLAN §6: a command without not_after is EXPIRED on arrival, so one is never sent; nor is a
    // body naming another command or node than its row.
    valid =
      decoded.notAfter !== undefined && decoded.id === String(row.id) && decoded.nodeId === String(row.node_id);
  } catch {
    valid = false;
  }
  const signature = row.signature == null ? undefined : bytesOf(row.signature);
  return {
    id: String(row.id),
    nodeId: String(row.node_id),
    seq: Number(row.seq),
    kind: String(row.kind),
    body,
    signature: signature?.byteLength ? fromBinary(SignatureSchema, signature) : undefined,
    state: row.state as CommandState,
    lane,
    attempt: Number(row.attempt ?? 0),
    valid,
  };
}

/** Reads `nodes.spec` (protobuf JSON of NodeSpec) into a full, unsigned DesiredState. */
export const nodeSpecColumn: SpecSource = {
  async load(tx, nodeId) {
    const { rows } = await tx.query<{ generation: number; spec: JsonValue | null }>(
      'SELECT generation, spec FROM nodes WHERE id = $1',
      [nodeId],
    );
    const row = rows[0];
    if (!row || row.spec === null || row.spec === undefined) return undefined;
    const spec = fromJson(NodeSpecSchema, row.spec, { registry: protocolRegistry });
    const specHash = createHash('sha256').update(toBinary(NodeSpecSchema, spec)).digest();
    return wrapDesiredState({
      $typeName: DesiredStateBodySchema.typeName,
      nodeId,
      generation: BigInt(row.generation),
      baseGeneration: 0n,
      specHash: new Uint8Array(specHash),
      spec: { case: 'full', value: spec },
      traceparent: '',
    });
  },
};

/** The gateway's SQL: every statement it runs against the base schema (PLAN.md §7.2-7.5, §8.5). */
export function createGatewayStore(options: GatewayStoreOptions) {
  const { database: db, work, events } = options;
  const specs = options.specs ?? nodeSpecColumn;
  const inventory = options.inventory ?? inventoryStore;
  const reports = options.reports ?? {};

  /** First statement of every routing transaction (§8.5): a zombie aborts, a takeover waits. */
  async function fence(tx: SqlTx): Promise<void> {
    const lease = options.fence();
    if (!lease) throw new FencedError('gateway');
    const { rowCount } = await tx.query(
      `SELECT 1 FROM leases WHERE name = $1 AND owner = $2 AND epoch = $3 AND expires_at > compute_now()
       FOR SHARE`,
      [lease.name, lease.owner, lease.epoch],
    );
    if (!rowCount) throw new FencedError(lease.name);
  }

  type OutboxEvent = Parameters<EventPublisher['publish']>[1];

  /** Set-based when the host's publisher supports it (one INSERT per batch), else one per event. */
  async function publishAll(tx: SqlTx, list: readonly OutboxEvent[]): Promise<void> {
    if (!list.length) return;
    if (events.publishMany) return events.publishMany(tx, list);
    for (const event of list) await events.publish(tx, event);
  }

  /** Set-based when the host's queue supports it, else one enqueue per key. */
  async function enqueueAll(tx: SqlTx, kind: string, keys: readonly string[]): Promise<void> {
    if (!keys.length) return;
    if (work.enqueueMany) return work.enqueueMany(tx, kind, keys);
    for (const key of keys) await work.enqueue(tx, kind, key);
  }

  function settledEvent(nodeId: string, tenantId: string, settled: SettledCommand): OutboxEvent {
    const data: Record<string, Json> = {
      commandId: settled.id,
      nodeId,
      kind: settled.kind,
      state: settled.state,
    };
    if (settled.reason) data.reason = settled.reason;
    return { type: 'command.settled', tenantId, subject: `command/${settled.id}`, data };
  }

  async function settle(tx: SqlTx, nodeId: string, tenantId: string, settled: SettledCommand): Promise<void> {
    await events.publish(tx, settledEvent(nodeId, tenantId, settled));
  }

  interface UpdateEntry {
    nodeId: string;
    tenantId: string;
    updates: readonly CommandUpdate[];
    busyBackoffMs: (commandId: string) => number;
  }

  /**
   * Applies CommandUpdates of many nodes set-wise (§7.2 "results are facts"): one locking read of
   * every command involved (id order, so concurrent flushes never deadlock), the state table in
   * memory in frame order, then one UPDATE for transitions and one for BUSY returns. Each update is
   * scoped to its reporting node: a node can never move another node's command.
   */
  async function applyUpdatesBulk(tx: SqlTx, entries: readonly UpdateEntry[]): Promise<UpdatesResult[]> {
    const results = entries.map((): UpdatesResult => ({ settled: [], ackCommandIds: [], busy: [] }));
    const ids = [...new Set(entries.flatMap((entry) => entry.updates.map((update) => update.commandId)))].sort();
    const rows = new Map<string, { nodeId: string; state: CommandState; kind: string }>();
    if (ids.length) {
      const read = await tx.query<{ id: string; node_id: string; state: CommandState; kind: string }>(
        'SELECT id, node_id, state, kind FROM commands WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE',
        [ids],
      );
      for (const row of read.rows) rows.set(row.id, { nodeId: row.node_id, state: row.state, kind: row.kind });
    }
    // Final write per command after every update of the batch, in order.
    const writes = new Map<string, { state: CommandState; reason: string | null; result: Uint8Array | null }>();
    const busy = new Map<string, number>();
    const settledEvents: { entry: number; settled: SettledCommand }[] = [];
    entries.forEach((entry, index) => {
      for (const update of entry.updates) {
        const row = rows.get(update.commandId);
        const verb = verbOf(update);
        if (row && row.nodeId === entry.nodeId && verb && canTransition(commandStateTable, row.state, verb)) {
          const to = commandStateTable.transitions[row.state][verb] as CommandState;
          row.state = to;
          if (verb === 'busy') {
            busy.set(update.commandId, entry.busyBackoffMs(update.commandId) / 1000);
            writes.delete(update.commandId);
            results[index]!.busy.push(update.commandId);
          } else {
            busy.delete(update.commandId);
            const reason = reasonOf(update);
            // The result is stored with the terminal state; owners read it from the row.
            const result = commandTerminalStates.has(to) && update.result.byteLength ? update.result : null;
            writes.set(update.commandId, { state: to, reason, result });
            if (commandTerminalStates.has(to)) {
              const settled: SettledCommand = { id: update.commandId, kind: row.kind, state: to };
              if (reason) settled.reason = reason;
              results[index]!.settled.push(settled);
              settledEvents.push({ entry: index, settled });
            }
          }
        }
        // Stored now, stored before, or unknown to this node: either way the journal can drop it.
        if (isTerminalUpdate(update)) results[index]!.ackCommandIds.push(update.commandId);
      }
    });
    if (writes.size) {
      const list = [...writes];
      await tx.query(
        `UPDATE commands c SET state = v.state, reason = v.reason,
           result = COALESCE(decode(v.result, 'hex'), c.result), updated_at = compute_now()
         FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS v(id, state, reason, result)
         WHERE c.id = v.id`,
        [
          list.map(([id]) => id),
          list.map(([, write]) => write.state),
          list.map(([, write]) => write.reason),
          list.map(([, write]) => (write.result ? Buffer.from(write.result).toString('hex') : null)),
        ],
      );
    }
    if (busy.size) {
      const list = [...busy];
      await tx.query(
        `UPDATE commands c SET state = 'pending', session_epoch = NULL, updated_at = compute_now(),
           not_before = compute_now() + make_interval(secs => v.secs)
         FROM unnest($1::text[], $2::float8[]) AS v(id, secs)
         WHERE c.id = v.id`,
        [list.map(([id]) => id), list.map(([, secs]) => secs)],
      );
    }
    await publishAll(
      tx,
      settledEvents.map(({ entry, settled }) => settledEvent(entries[entry]!.nodeId, entries[entry]!.tenantId, settled)),
    );
    const wake = new Set<string>();
    entries.forEach((entry, index) => {
      if (results[index]!.settled.length || results[index]!.busy.length) wake.add(entry.nodeId);
    });
    await enqueueAll(tx, 'node', [...wake]);
    return results;
  }

  async function applyUpdates(
    tx: SqlTx,
    nodeId: string,
    tenantId: string,
    updates: readonly CommandUpdate[],
    busyBackoffMs: (commandId: string) => number,
  ): Promise<UpdatesResult> {
    return (await applyUpdatesBulk(tx, [{ nodeId, tenantId, updates, busyBackoffMs }]))[0]!;
  }

  /** One EventBatch in the caller's transaction; undefined when it is for another journal. */
  async function ingestEvents(
    tx: SqlTx,
    nodeId: string,
    tenantId: string,
    batch: EventBatch,
  ): Promise<{ ackedEventSeq: number; stored: number } | undefined> {
    const { rows } = await tx.query<{ journal_id: string | null; acked_event_seq: number }>(
      'SELECT journal_id, acked_event_seq FROM node_sessions WHERE node_id = $1 FOR UPDATE',
      [nodeId],
    );
    const session = rows[0];
    if (!session || session.journal_id !== batch.journalId) return undefined;
    let acked = Number(session.acked_event_seq);
    let stored = 0;
    const fresh = [...batch.events]
      .filter((event) => Number(event.seq) > acked)
      .sort((a, b) => Number(a.seq - b.seq));
    for (const event of fresh) {
      const data: Record<string, Json> = {
        nodeId,
        journalId: batch.journalId,
        seq: Number(event.seq),
        event: toJson(EventSchema, event, { registry: protocolRegistry }) as Json,
      };
      let type = 'node.event';
      const context: ReportContext = {
        nodeId,
        tenantId,
        journalId: batch.journalId,
        seq: Number(event.seq),
        bootId: '',
        signed: false,
        work,
      };
      let apply: (() => Promise<unknown>) | undefined;
      if (event.body.case === 'attested') {
        const envelope = event.body.value;
        try {
          const report = unwrapAttestedReport(envelope);
          data.report = toJson(AttestedReportBodySchema, report, {
            registry: protocolRegistry,
          }) as Json;
          if (report.nodeId !== nodeId) type = 'security.node-mismatch';
          else {
            context.bootId = report.bootId;
            context.signed = Boolean(envelope.nodeSig?.sig.byteLength);
            const inner = report.report;
            if (inner.case === 'allocationBound' && reports.allocationBound)
              apply = () => reports.allocationBound!(tx, context, inner.value);
            else if (inner.case === 'allocationReleased' && reports.allocationReleased)
              apply = () => reports.allocationReleased!(tx, context, inner.value);
          }
        } catch {
          type = 'security.invalid-report';
        }
      } else if (event.body.case === 'allocationFailed' && reports.allocationFailed) {
        const failed = event.body.value;
        apply = () => reports.allocationFailed!(tx, context, failed);
      }
      await events.publish(tx, { type, tenantId, subject: `node/${nodeId}`, data });
      if (apply) {
        // A failing handler must not poison the stream (no ack → replay → same failure): its
        // writes roll back to the savepoint, the failure is published, and ingestion goes on.
        await tx.query('SAVEPOINT gateway_report');
        try {
          await apply();
          await tx.query('RELEASE SAVEPOINT gateway_report');
        } catch (error) {
          await tx.query('ROLLBACK TO SAVEPOINT gateway_report');
          await events.publish(tx, {
            type: 'node.report-failed',
            tenantId,
            subject: `node/${nodeId}`,
            data: {
              nodeId,
              journalId: batch.journalId,
              seq: Number(event.seq),
              error: error instanceof Error ? error.message : String(error),
            },
          });
        }
      }
      acked = Math.max(acked, Number(event.seq));
      stored++;
    }
    if (stored) {
      await tx.query('UPDATE node_sessions SET acked_event_seq = $2 WHERE node_id = $1', [
        nodeId,
        acked,
      ]);
      await work.enqueue(tx, 'node', nodeId);
    }
    return { ackedEventSeq: acked, stored };
  }

  return {
    fence,

    /** Upserts this gateway's directory row (§8.5); `draining` resets on start. */
    async register(gateway: {
      id: string;
      region: string;
      internalUrl: string;
      softwareVersion: string;
      maxStreams: number;
    }): Promise<void> {
      await db.query(
        `INSERT INTO gateways (id, region, internal_url, software_version, max_streams)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET region = EXCLUDED.region, internal_url = EXCLUDED.internal_url,
           software_version = EXCLUDED.software_version, max_streams = EXCLUDED.max_streams,
           sessions = 0, draining = false, started_at = compute_now(), heartbeat_at = compute_now()`,
        [gateway.id, gateway.region, gateway.internalUrl, gateway.softwareVersion, gateway.maxStreams],
      );
    },

    /** Records the session count and drain flag; the directory's liveness signal for `doctor`. */
    async heartbeat(gatewayId: string, sessions: number, draining: boolean): Promise<void> {
      await db.query(
        `UPDATE gateways SET heartbeat_at = compute_now(), sessions = $2, draining = $3 WHERE id = $1`,
        [gatewayId, sessions, draining],
      );
    },

    /**
     * Acquires or renews a lease (§8.5): the epoch rises on every change of owner. Returns the
     * epoch, or undefined while another owner holds it.
     */
    async acquireLease(name: string, owner: string, ttlMs: number): Promise<number | undefined> {
      return db.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO leases (name, owner, epoch, expires_at) VALUES ($1, NULL, 0, '-infinity')
           ON CONFLICT (name) DO NOTHING`,
          [name],
        );
        const { rows } = await tx.query<{ epoch: number }>(
          `UPDATE leases SET owner = $2,
             epoch = CASE WHEN owner = $2 THEN epoch ELSE epoch + 1 END,
             expires_at = compute_now() + make_interval(secs => $3::float8)
           WHERE name = $1 AND (owner = $2 OR expires_at < compute_now())
           RETURNING epoch`,
          [name, owner, ttlMs / 1000],
        );
        return rows[0] === undefined ? undefined : Number(rows[0].epoch);
      });
    },

    /** Gives a lease up at shutdown so a successor need not wait for the TTL. */
    async releaseLease(lease: LeaseToken): Promise<void> {
      await db.query(
        `UPDATE leases SET owner = NULL, expires_at = '-infinity'
         WHERE name = $1 AND owner = $2 AND epoch = $3`,
        [lease.name, lease.owner, lease.epoch],
      );
    },

    /**
     * The Hello transaction (§7.2): bump the epoch and route to this gateway, then apply the
     * self-terminating and journal-lost rules, the replayed results, and choose the replay.
     */
    async hello(input: HelloInput, options: { liveWindowMs: number }): Promise<HelloResult> {
      return db.transaction(async (tx) => {
        await fence(tx);
        const previous = await tx.query<{
          boot_id: string | null;
          journal_id: string | null;
          role: string | null;
          live: boolean;
          tenant_id: string;
          generation: number;
          has_pending: boolean;
        }>(
          `SELECT s.boot_id, s.journal_id, s.role, n.owner_tenant_id AS tenant_id, n.generation,
             EXISTS (SELECT 1 FROM commands c WHERE c.node_id = s.node_id AND c.state = 'pending') AS has_pending,
             (s.gateway_id IS NOT NULL AND s.disconnected_at IS NULL
              AND s.last_seen > compute_now() - make_interval(secs => $2::float8)) AS live
           FROM node_sessions s JOIN nodes n ON n.id = s.node_id
           WHERE s.node_id = $1 FOR UPDATE OF s`,
          [input.nodeId, options.liveWindowMs / 1000],
        );
        const prior = previous.rows[0];
        if (!prior)
          throw new ComputeError('NOT_FOUND', `Node ${input.nodeId} has not joined`, undefined, {
            nodeId: input.nodeId,
          });
        const tenantId = prior.tenant_id;
        const journalChanged = prior.journal_id !== null && prior.journal_id !== input.journalId;
        const bootChanged =
          prior.boot_id !== null &&
          (prior.boot_id !== input.bootId || (prior.role !== null && prior.role !== input.role));

        const bumped = await tx.query<{ session_epoch: number; acked_event_seq: number }>(
          `UPDATE node_sessions SET gateway_id = $2, session_id = $3, session_epoch = session_epoch + 1,
             boot_id = $4, journal_id = $5, role = $6,
             acked_event_seq = CASE WHEN journal_id IS DISTINCT FROM $5 THEN 0 ELSE acked_event_seq END,
             connected_at = compute_now(), last_seen = compute_now(), disconnected_at = NULL
           WHERE node_id = $1
           RETURNING session_epoch, acked_event_seq`,
          [
            input.nodeId,
            input.gatewayId,
            input.sessionId,
            input.bootId,
            input.journalId,
            input.role,
          ],
        );
        const epoch = Number(bumped.rows[0]!.session_epoch);
        const settled: SettledCommand[] = [];
        const settleRule = async (sql: string, reason: string) => {
          const { rows } = await tx.query<{ id: string; kind: string; state: CommandState }>(sql, [
            input.nodeId,
            inFlight,
          ]);
          for (const row of rows) {
            const entry: SettledCommand = { id: row.id, kind: row.kind, state: row.state, reason };
            settled.push(entry);
            await settle(tx, input.nodeId, tenantId, entry);
          }
        };
        // 1. A new boot (or role) completes in-flight self-terminating commands; never replayed.
        if (bootChanged)
          await settleRule(
            `UPDATE commands SET state = 'succeeded', reason = 'rebooted', updated_at = compute_now()
             WHERE node_id = $1 AND self_terminating AND state = ANY($2::text[])
             RETURNING id, kind, state`,
            'rebooted',
          );
        // 2. A lost journal fails in-flight commands that are unsafe to run twice.
        if (journalChanged)
          await settleRule(
            `UPDATE commands SET state = 'failed', reason = 'journal-lost', updated_at = compute_now()
             WHERE node_id = $1 AND NOT retry_safe AND state = ANY($2::text[])
             RETURNING id, kind, state`,
            'journal-lost',
          );
        const updates = await applyUpdates(tx, input.nodeId, tenantId, input.unackedResults, () => 1000);
        settled.push(...updates.settled);

        // Every in-flight row moves to the new epoch; the ones the journal holds as running are
        // not re-sent (they still occupy lane credits on the daemon).
        const running = [...input.runningCommandIds];
        const inFlightRows = await tx.query(
          `UPDATE commands SET session_epoch = $3,
             attempt = CASE WHEN id = ANY($4::text[]) THEN attempt ELSE attempt + 1 END,
             updated_at = compute_now()
           WHERE node_id = $1 AND state = ANY($2::text[])
           RETURNING id, node_id, seq, kind, body, signature, state, attempt`,
          [input.nodeId, inFlight, epoch, running],
        );
        const held = inFlightRows.rows.map(storedCommand).sort((a, b) => a.seq - b.seq);
        const replay = held.filter((command) => !running.includes(command.id));
        const runningCommands = held.filter((command) => running.includes(command.id));

        const connected = await tx.query(
          `UPDATE nodes SET connectivity = 'connected' WHERE id = $1 AND connectivity <> 'connected'
           RETURNING id`,
          [input.nodeId],
        );
        await events.publish(tx, {
          type: 'node.connected',
          tenantId,
          subject: `node/${input.nodeId}`,
          data: {
            nodeId: input.nodeId,
            gatewayId: input.gatewayId,
            epoch,
            bootId: input.bootId,
            journalChanged,
            bootChanged,
            // A second live Hello from another boot (§7.2): the new one wins; Health raises the
            // DuplicateIdentity condition and quarantines on repeated alternation.
            duplicateIdentity: prior.live && prior.boot_id !== null && prior.boot_id !== input.bootId,
          },
        });
        if (connected.rowCount || settled.length) await work.enqueue(tx, 'node', input.nodeId);

        const requestSections = await inventory.recordHashes(
          tx,
          work,
          input.nodeId,
          input.inventoryHashes,
          { bootId: input.bootId },
        );
        return {
          epoch,
          tenantId,
          ackedEventSeq: Number(bumped.rows[0]!.acked_event_seq),
          generation: Number(prior.generation),
          replay,
          running: runningCommands,
          settled,
          ackCommandIds: updates.ackCommandIds,
          requestSections,
          journalChanged,
          bootChanged,
          hasPending: Boolean(prior.has_pending) || updates.busy.length > 0,
        };
      });
    },

    /**
     * Dispatch by join (§8.5): pending commands of nodes routed to this gateway, locked `SKIP LOCKED`
     * with the session row `FOR SHARE` so a concurrent Hello serializes. `choose` picks what is sent
     * now (live session with the row's epoch, lane credit left); only those are marked dispatched.
     * `refuse` returns commands that must never reach their node (tenant-controlled nodes and
     * destructive kinds): they are cancelled with that reason in the same transaction.
     */
    async dispatch(
      gatewayId: string,
      limit: number,
      choose: (candidates: (StoredCommand & { epoch: number })[]) => {
        send: (StoredCommand & { epoch: number })[];
        refuse?: { command: StoredCommand; reason: string }[];
      },
    ): Promise<(StoredCommand & { epoch: number })[]> {
      return db.transaction(async (tx) => {
        await fence(tx);
        const { rows } = await tx.query(
          `SELECT c.id, c.node_id, c.seq, c.kind, c.body, c.signature, c.state, c.attempt,
             c.cancel_requested_at IS NOT NULL AS cancel_requested, c.cancel_reason,
             s.session_epoch, n.owner_tenant_id AS tenant_id
           FROM commands c JOIN node_sessions s USING (node_id) JOIN nodes n ON n.id = c.node_id
           WHERE s.gateway_id = $1 AND c.state = 'pending'
             AND c.not_before <= compute_now() AND c.not_after > compute_now()
           ORDER BY c.node_id, c.seq LIMIT $2
           FOR UPDATE OF c SKIP LOCKED FOR SHARE OF s`,
          [gatewayId, limit],
        );
        if (!rows.length) return [];
        const tenants = new Map(rows.map((row) => [String(row.node_id), String(row.tenant_id)]));
        // A cancel requested before dispatch wins: the command is cancelled, never sent (§7.4).
        const requested = rows
          .filter((row) => row.cancel_requested)
          .map((row) => ({ command: storedCommand(row), reason: String(row.cancel_reason ?? 'cancelled') }));
        const { send: chosen, refuse: refused = [] } = choose(
          rows
            .filter((row) => !row.cancel_requested)
            .map((row) => ({ ...storedCommand(row), epoch: Number(row.session_epoch) })),
        );
        const refuse = [...requested, ...refused];
        for (const { command, reason } of refuse) {
          if (!canTransition(commandStateTable, command.state, 'cancel')) continue;
          await tx.query(
            `UPDATE commands SET state = 'cancelled', reason = $2, updated_at = compute_now()
             WHERE id = $1 AND state = 'pending'`,
            [command.id, reason],
          );
          await settle(tx, command.nodeId, tenants.get(command.nodeId)!, {
            id: command.id,
            kind: command.kind,
            state: 'cancelled',
            reason,
          });
          await work.enqueue(tx, 'node', command.nodeId);
        }
        if (!chosen.length) return [];
        const marked = await tx.query<{ id: string; attempt: number }>(
          `UPDATE commands c SET state = 'dispatched', session_epoch = v.epoch,
             attempt = c.attempt + 1, updated_at = compute_now()
           FROM unnest($1::text[], $2::bigint[]) AS v(id, epoch)
           WHERE c.id = v.id AND c.state = 'pending'
           RETURNING c.id, c.attempt`,
          [chosen.map((command) => command.id), chosen.map((command) => command.epoch)],
        );
        const attempts = new Map(marked.rows.map((row) => [row.id, Number(row.attempt)]));
        return chosen
          .filter((command) => attempts.has(command.id))
          .map((command) => ({ ...command, state: 'dispatched' as const, attempt: attempts.get(command.id)! }));
      });
    },

    /**
     * In-flight commands on this gateway's sessions whose cancel was requested (§7.4 `Cancel`): the
     * gateway sends `Cancel{id}`; the daemon reports the real outcome or `CANCELLED`.
     */
    async cancels(
      gatewayId: string,
    ): Promise<{ id: string; nodeId: string; epoch: number; reason: string }[]> {
      const { rows } = await db.query<{ id: string; node_id: string; session_epoch: number; reason: string | null }>(
        `SELECT c.id, c.node_id, s.session_epoch, c.cancel_reason AS reason
         FROM commands c JOIN node_sessions s USING (node_id)
         WHERE s.gateway_id = $1 AND c.cancel_requested_at IS NOT NULL AND c.state = ANY($2::text[])
         ORDER BY c.node_id, c.seq`,
        [gatewayId, inFlight],
      );
      return rows.map((row) => ({
        id: row.id,
        nodeId: row.node_id,
        epoch: Number(row.session_epoch),
        reason: row.reason ?? 'cancelled',
      }));
    },

    /** Results are facts: accepted from any epoch, deduplicated by the state table (§7.2). */
    async updates(
      nodeId: string,
      tenantId: string,
      updates: readonly CommandUpdate[],
      busyBackoffMs: (commandId: string) => number,
    ): Promise<UpdatesResult> {
      return db.transaction((tx) => applyUpdates(tx, nodeId, tenantId, updates, busyBackoffMs));
    },

    /**
     * Group commit: many sessions' updates in one transaction (one per frame serializes a large
     * fleet on the store). Results come back in input order. When the batch fails, each entry is
     * retried alone so one bad frame cannot fail the others; a failed entry's slot is its error.
     */
    async updatesBatch(
      entries: readonly {
        nodeId: string;
        tenantId: string;
        updates: readonly CommandUpdate[];
        busyBackoffMs: (commandId: string) => number;
      }[],
    ): Promise<(UpdatesResult | Error)[]> {
      try {
        return await db.transaction((tx) => applyUpdatesBulk(tx, entries));
      } catch {
        const results: (UpdatesResult | Error)[] = [];
        for (const entry of entries)
          results.push(
            await db
              .transaction((tx) => applyUpdates(tx, entry.nodeId, entry.tenantId, entry.updates, entry.busyBackoffMs))
              .catch((error: unknown) => (error instanceof Error ? error : new Error(String(error)))),
          );
        return results;
      }
    },

    /**
     * Stores an event batch (§7.4): events above the cumulative ack of the node's current journal
     * are published, then the ack advances. A batch for another journal is ignored (undefined).
     */
    async events(
      nodeId: string,
      tenantId: string,
      batch: EventBatch,
    ): Promise<{ ackedEventSeq: number; stored: number } | undefined> {
      return db.transaction((tx) => ingestEvents(tx, nodeId, tenantId, batch));
    },

    /**
     * Group commit of event batches from many sessions: one transaction, session rows locked in
     * node-id order; on failure each batch is retried alone (its slot holds the error).
     */
    async eventsBatch(
      entries: readonly { nodeId: string; tenantId: string; batch: EventBatch }[],
    ): Promise<({ ackedEventSeq: number; stored: number } | undefined | Error)[]> {
      const order = entries.map((_, index) => index).sort((a, b) =>
        entries[a]!.nodeId < entries[b]!.nodeId ? -1 : entries[a]!.nodeId > entries[b]!.nodeId ? 1 : a - b,
      );
      try {
        return await db.transaction(async (tx) => {
          const results: ({ ackedEventSeq: number; stored: number } | undefined)[] = new Array(entries.length);
          for (const index of order) {
            const entry = entries[index]!;
            results[index] = await ingestEvents(tx, entry.nodeId, entry.tenantId, entry.batch);
          }
          return results;
        });
      } catch {
        const results: ({ ackedEventSeq: number; stored: number } | undefined | Error)[] = [];
        for (const entry of entries)
          results.push(
            await db
              .transaction((tx) => ingestEvents(tx, entry.nodeId, entry.tenantId, entry.batch))
              .catch((error: unknown) => (error instanceof Error ? error : new Error(String(error)))),
          );
        return results;
      }
    },
    /**
     * A status report (§7.2): `observed_generation` only moves forward; the report is published for
     * the Inventory/Health reconciler, which owns conditions.
     */
    async status(nodeId: string, tenantId: string, report: StatusReport): Promise<void> {
      await db.transaction(async (tx) => {
        await tx.query(
          `UPDATE nodes SET observed_generation = $2
           WHERE id = $1 AND observed_generation < $2`,
          [nodeId, Number(report.observedGeneration)],
        );
        await events.publish(tx, {
          type: 'node.status',
          tenantId,
          subject: `node/${nodeId}`,
          data: {
            nodeId,
            report: toJson(StatusReportSchema, report, { registry: protocolRegistry }) as Json,
          },
        });
        await work.enqueue(tx, 'node', nodeId);
      });
    },

    /** One pulled section; `INVALID_INPUT` when its bytes do not match its sha256. */
    async inventory(nodeId: string, section: InventorySection): Promise<void> {
      await db.transaction((tx) =>
        inventory.ingestSection(tx, work, nodeId, {
          section: section.section,
          content: section.content,
          sha256: section.sha256,
        }),
      );
    },

    /**
     * Group commit of inventory work from many sessions: pulled sections and heartbeat hash reports
     * in one transaction, each under its own SAVEPOINT so a corrupt section (`INVALID_INPUT`) fails
     * only itself. The slot of a failed entry holds its error.
     */
    async inventoryBatch(
      entries: readonly (
        | { kind: 'section'; nodeId: string; section: InventorySection }
        | { kind: 'hashes'; nodeId: string; bootId: string; hashes: Readonly<Record<string, Uint8Array>> }
      )[],
    ): Promise<(undefined | Error)[]> {
      return db.transaction(async (tx) => {
        const results: (undefined | Error)[] = [];
        for (const entry of entries) {
          await tx.query('SAVEPOINT gateway_inventory');
          try {
            if (entry.kind === 'section')
              await inventory.ingestSection(tx, work, entry.nodeId, {
                section: entry.section.section,
                content: entry.section.content,
                sha256: entry.section.sha256,
              });
            else await inventory.recordHashes(tx, work, entry.nodeId, entry.hashes, { bootId: entry.bootId });
            await tx.query('RELEASE SAVEPOINT gateway_inventory');
            results.push(undefined);
          } catch (error) {
            await tx.query('ROLLBACK TO SAVEPOINT gateway_inventory');
            results.push(error instanceof Error ? error : new Error(String(error)));
          }
        }
        return results;
      });
    },

    /** Hashes a heartbeat carries (every 10th); a changed set is pulled at the next Hello. */
    async inventoryHashes(
      nodeId: string,
      bootId: string,
      hashes: Readonly<Record<string, Uint8Array>>,
    ): Promise<string[]> {
      return db.transaction((tx) => inventory.recordHashes(tx, work, nodeId, hashes, { bootId }));
    },

    /** The node's full desired state, if it has one. */
    async desired(nodeId: string): Promise<DesiredState | undefined> {
      return db.transaction((tx) => specs.load(tx, nodeId), { readOnly: true });
    },

    /** `nodes.generation` of each node (to push specs that moved while a session is open). */
    async generations(nodeIds: readonly string[]): Promise<Map<string, number>> {
      if (!nodeIds.length) return new Map();
      const { rows } = await db.query<{ id: string; generation: number }>(
        'SELECT id, generation FROM nodes WHERE id = ANY($1::text[])',
        [[...nodeIds]],
      );
      return new Map(rows.map((row) => [row.id, Number(row.generation)]));
    },

    /**
     * Age-based liveness flush (§7.5), epoch-fenced. Returns the nodes whose row still names this
     * gateway and epoch; any other entry belongs to a superseded (zombie) session.
     */
    async flushLiveness(gatewayId: string, entries: readonly LivenessEntry[]): Promise<Set<string>> {
      if (!entries.length) return new Set();
      const { rows } = await db.query<{ node_id: string }>(
        `UPDATE node_sessions s
         SET last_seen = compute_now() - make_interval(secs => v.age_ms / 1000.0)
         FROM unnest($1::text[], $2::float8[], $3::bigint[]) AS v(id, age_ms, epoch)
         WHERE s.node_id = v.id AND s.session_epoch = v.epoch AND s.gateway_id = $4
         RETURNING s.node_id`,
        [
          entries.map((entry) => entry.nodeId),
          entries.map((entry) => entry.ageMs),
          entries.map((entry) => entry.epoch),
          gatewayId,
        ],
      );
      return new Set(rows.map((row) => row.node_id));
    },

    /**
     * A closed session (§7.5), epoch-fenced: unroutes the node and marks it disconnected. Nothing is
     * released and in-flight commands stay for the next session's replay. False when superseded.
     */
    async disconnect(
      gatewayId: string,
      nodeId: string,
      epoch: number,
      reason: string,
    ): Promise<boolean> {
      return db.transaction(async (tx) => {
        const { rows } = await tx.query<{ tenant_id: string }>(
          `UPDATE node_sessions s SET gateway_id = NULL, disconnected_at = compute_now()
           FROM nodes n
           WHERE s.node_id = $1 AND s.session_epoch = $2 AND s.gateway_id = $3 AND n.id = s.node_id
           RETURNING n.owner_tenant_id AS tenant_id`,
          [nodeId, epoch, gatewayId],
        );
        const row = rows[0];
        if (!row) return false;
        await tx.query(
          `UPDATE nodes SET connectivity = 'disconnected' WHERE id = $1 AND connectivity = 'connected'`,
          [nodeId],
        );
        await events.publish(tx, {
          type: 'node.disconnected',
          tenantId: row.tenant_id,
          subject: `node/${nodeId}`,
          data: { nodeId, gatewayId, epoch, reason },
        });
        await work.enqueue(tx, 'node', nodeId);
        return true;
      });
    },
  };
}

export type GatewayStore = ReturnType<typeof createGatewayStore>;
