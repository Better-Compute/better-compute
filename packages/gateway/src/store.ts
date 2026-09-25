import { fromBinary, toBinary, toJson, type JsonValue } from '@bufbuild/protobuf';
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
import {
  ingestInventorySection,
  ingestInventorySections,
  recordInventoryHashes,
  recordInventoryHashesMany,
} from '@better-compute/inventory';
import { desiredStateBodyFromJson, desiredStateFromStored } from '@better-compute/pki';
import {
  AttestedReportBodySchema,
  CommandBodySchema,
  CommandRejectReason,
  CommandState as WireState,
  DesiredStateBodySchema,
  EventSchema,
  Lane,
  protocolRegistry,
  SignatureSchema,
  StatusReportSchema,
  decodeMessage,
  unwrapAttestedReport,
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
  /** (v1.0 §13) The signed body's `batch_id`, when the command belongs to a destructive batch. */
  batchId?: string;
  /** The batch's encoded BatchApproval and this command's encoded BatchProof, sent with it. */
  batchApproval?: Uint8Array;
  batchProof?: Uint8Array;
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
  /** The session certificate's serial: its `node_certs.allowed_kinds` restrict dispatch. */
  certSerial?: string;
  /** `Hello.daemon_version` / `proto_max`, stored on the session row for Rollout (v0.4). */
  daemonVersion?: string;
  protoMax?: number;
  /**
   * `Hello.trust_version`: the TrustBundle version the daemon holds (0: none), stored as
   * `node_sessions.trust_version` so a command-root switch can wait for every connected node (§13).
   */
  trustVersion?: bigint;
  /**
   * `Hello.approver_set_epoch` / `approver_set_sha256` (v1.0 §13): the approver set the daemon HOLDS,
   * which can lag its trust_version (a quorum change refused). Stored as NULL when it holds none.
   */
  approverSetEpoch?: bigint;
  approverSetSha256?: Uint8Array;
  /**
   * `Hello.capabilities` (e.g. `tunnel.instance-dial`), stored as `node_sessions.capabilities`, as-is
   * from each Hello, for API checks such as `tunnels.open`. Malformed entries are dropped.
   */
  capabilities?: readonly string[];
  /** `Hello.drivers`: each becomes the node label `bc.dev/driver.<id>=<version>`. */
  drivers?: readonly { id: string; version: string }[];
}

/**
 * Hello's capabilities as stored: names of `[a-z0-9][a-z0-9._-]{0,63}` only (a daemon's claim, never
 * trusted into anything but this list), de-duplicated, sorted, at most 64.
 */
export function sessionCapabilities(capabilities: readonly string[] | undefined): string[] {
  const valid = (capabilities ?? []).filter((name) => /^[a-z0-9][a-z0-9._-]{0,63}$/.test(name));
  return [...new Set(valid)].sort().slice(0, 64);
}

/**
 * The approver set a daemon reports holding, as SQL parameters (epoch as a decimal string for
 * numeric(20,0), digest as bytes): both NULL when it holds none (an empty digest), so readers can tell
 * "no quorum" from a real set.
 */
function approverSetParams(epoch: bigint | undefined, sha256: Uint8Array | undefined): [string | null, Buffer | null] {
  if (!sha256?.byteLength) return [null, null];
  return [String(epoch ?? 0n), Buffer.from(sha256)];
}

/** The prefix of the node labels Hello writes for advertised drivers (source `system`). */
export const driverLabelPrefix = 'bc.dev/driver.';

/**
 * Hello's drivers as node labels. Ids outside `[a-z0-9._-]` (1-63) are skipped rather than trusted
 * into a label key; a missing version is recorded as `unknown`; the last entry for an id wins.
 */
export function driverLabels(drivers: readonly { id: string; version: string }[]): { key: string; value: string }[] {
  const labels = new Map<string, string>();
  for (const driver of drivers.slice(0, 64))
    if (/^[a-z0-9][a-z0-9._-]{0,62}$/.test(driver.id))
      labels.set(`${driverLabelPrefix}${driver.id}`, (driver.version || 'unknown').slice(0, 63));
  return [...labels].map(([key, value]) => ({ key, value }));
}

/** The prefix of the node labels Hello writes for advertised capabilities (source `system`). */
export const capabilityLabelPrefix = 'bc.dev/cap.';

/**
 * Hello's capabilities as node labels `bc.dev/cap.<capability>=1`, so placement can require one
 * (`nodeLabels: { 'bc.dev/cap.instance.network-policy': '*' }`): only names `sessionCapabilities` keeps.
 */
export function capabilityLabels(capabilities: readonly string[] | undefined): { key: string; value: string }[] {
  return sessionCapabilities(capabilities).map((name) => ({ key: `${capabilityLabelPrefix}${name}`, value: '1' }));
}

export interface HelloOptions {
  /** A prior session whose `last_seen` is younger than this is live (a second Hello is a duplicate). */
  liveWindowMs: number;
  /**
   * Duplicate-identity quarantine (§7.2): more than `max` duplicate Hellos within `windowMs` revoke
   * the presented certificate. Default 3 in 10 minutes. A reboot loop faster than the liveness
   * window looks the same and counts too.
   */
  duplicateHellos?: { max: number; windowMs: number };
}

export const duplicateHelloDefaults = { max: 3, windowMs: 10 * 60_000 } as const;

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
  /** `node_certs.allowed_kinds` of the session's certificate; null = unrestricted. */
  allowedKinds: string[] | null;
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
  /**
   * Many sections (of many nodes) set-wise, each failing only its own slot (`INVALID_INPUT`,
   * `NOT_FOUND`). Optional: without it the gateway calls `ingestSection` once per section.
   */
  ingestSections?(
    tx: SqlTx,
    work: WorkQueue,
    entries: readonly { nodeId: string; section: { section: string; content: Uint8Array; sha256: Uint8Array } }[],
  ): Promise<(Error | undefined)[]>;
  /**
   * Many nodes' hash reports set-wise; each slot holds the sections to pull, or its error. Optional:
   * without it the gateway calls `recordHashes` once per report.
   */
  recordHashesMany?(
    tx: SqlTx,
    work: WorkQueue,
    entries: readonly { nodeId: string; hashes: Readonly<Record<string, Uint8Array>>; bootId?: string }[],
  ): Promise<(readonly string[] | Error)[]>;
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
  /**
   * An attested report exactly as the node sent it (`AttestedReport.body` bytes and `node_sig`),
   * for handlers to store as evidence. The gateway never judges it: a worker verifies the stored
   * bytes against the node's certificates (pki `verifyAttestedReport`) before any transition that
   * depends on it (§13, P14). `kid`/`sig` are empty when the node did not sign.
   */
  attested?: { body: Uint8Array; kid: string; sig: Uint8Array };
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
  /**
   * The node's coalesced StatusReport (latest wins, so it carries the full condition set): e.g.
   * conditions `Xid<n>` with a `device_id` → inventory's `recordXid` (§10.1 health).
   */
  status?: StatusHandler | readonly StatusHandler[];
}

/**
 * Consumes a node's coalesced StatusReport in the status transaction. Several may be given
 * (`[xidStatusHandler, vpsInstanceStatusHandler]`): each runs under its own savepoint, so one
 * failing (published as `node.report-failed`) never blocks the others.
 */
export type StatusHandler = (
  tx: SqlTx,
  context: { nodeId: string; tenantId: string; work: WorkQueue; events?: EventPublisher },
  report: StatusReport,
) => Promise<unknown>;

export const inventoryStore: InventoryIngest = {
  recordHashes: (tx, work, nodeId, hashes, options) =>
    recordInventoryHashes(tx, work, nodeId, hashes, options),
  ingestSection: (tx, work, nodeId, section) => ingestInventorySection(tx, work, nodeId, section),
  ingestSections: (tx, work, entries) => ingestInventorySections(tx, work, entries),
  recordHashesMany: (tx, work, entries) => recordInventoryHashesMany(tx, work, entries),
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
  /** A settled command's owner work item besides its node (`GatewayOptions.commandOwner`). */
  commandOwner?: CommandOwner;
  /** The lease every routing transaction re-checks first (`FOR SHARE`); undefined = not held. */
  fence: () => LeaseToken | undefined;
}

/** The work item that owns a command besides its node, from its idempotency key. */
export type CommandOwner = (idempotencyKey: string) => { kind: string; key: string } | undefined;

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
  let batchId = '';
  try {
    const decoded = decodeMessage(CommandBodySchema, body);
    lane = decoded.lane || Lane.CONTROL;
    batchId = decoded.batchId;
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
    ...(batchId ? { batchId } : {}),
    ...batchAttachment(row),
  };
}

/** A quorum batch's approval and the command's proof, when the row carries them (required > 0). */
function batchAttachment(row: Record<string, unknown>): Pick<StoredCommand, 'batchApproval' | 'batchProof'> {
  if (!(Number(row.batch_required ?? 0) > 0) || row.batch_approval == null || row.batch_proof == null) return {};
  return { batchApproval: bytesOf(row.batch_approval), batchProof: bytesOf(row.batch_proof) };
}

/**
 * (v1.0 §13) Joins a dispatch candidate to its batch: a member of a batch that needs approvals is sent
 * only once the batch is approved and its leaf's proof exists (the command queue holds it until then;
 * this is the gateway's own guard, so a released-too-early row never goes out bare).
 */
const batchJoin = `LEFT JOIN command_batch_members m ON m.command_id = c.id
           LEFT JOIN command_batches b ON b.id = m.batch_id
           LEFT JOIN command_batch_scope sc ON sc.batch_id = m.batch_id AND sc.subject = m.subject AND sc.kind = m.kind
             AND sc.payload_sha256 = m.payload_sha256`;
const batchSendable = `(m.command_id IS NULL OR b.required = 0
             OR (b.state = 'approved' AND b.approval IS NOT NULL AND sc.proof IS NOT NULL))`;

/**
 * A node's full DesiredState (v0.4, signed specs). When the spec writer stored the encoded body
 * (`nodes.spec_body`, and with a worker key `spec_signature`, core/0021) for the current generation,
 * those bytes are relayed verbatim: the gateway never re-encodes, so it cannot alter what the worker
 * signed. Otherwise `nodes.spec` (protobuf JSON) is rendered unsigned with pki's
 * `desiredStateBodyFromJson`, the writer's own encoder, byte for byte.
 */
export const nodeSpecColumn: SpecSource = {
  async load(tx, nodeId) {
    const { rows } = await tx.query<{
      generation: number;
      spec: JsonValue | null;
      spec_body: Uint8Array | null;
      spec_signature: Uint8Array | null;
    }>('SELECT generation, spec, spec_body, spec_signature FROM nodes WHERE id = $1', [nodeId]);
    const row = rows[0];
    if (!row || row.spec === null || row.spec === undefined) return undefined;
    if (row.spec_body?.byteLength) {
      const body = bytesOf(row.spec_body);
      // A cheap guard: the writer rewrites or clears both columns with every generation bump.
      let current = false;
      try {
        const decoded = fromBinary(DesiredStateBodySchema, body);
        current = decoded.nodeId === nodeId && decoded.generation === BigInt(row.generation);
      } catch {
        current = false;
      }
      if (current) return desiredStateFromStored(body, row.spec_signature ? bytesOf(row.spec_signature) : null);
    }
    const body = desiredStateBodyFromJson({ nodeId, generation: row.generation, spec: row.spec });
    return desiredStateFromStored(toBinary(DesiredStateBodySchema, body));
  },
};

/** The gateway's SQL: every statement it runs against the base schema (PLAN.md §7.2-7.5, §8.5). */
export function createGatewayStore(options: GatewayStoreOptions) {
  const { database: db, work, events } = options;
  const specs = options.specs ?? nodeSpecColumn;
  const inventory = options.inventory ?? inventoryStore;
  const reports = options.reports ?? {};
  /** A settled command's owner besides its node, when the host bound one; `node` is woken anyway. */
  const ownerOf = (idempotencyKey: string) => {
    const owner = options.commandOwner?.(idempotencyKey);
    return owner && owner.kind !== 'node' ? owner : undefined;
  };

  /**
   * Whether the quorum module's tables exist (a compute host always migrates them; a bare gateway
   * store may not). Once present they stay; absent is re-checked every 30 s.
   */
  let quorumTables: { present: boolean; checkedAt: number } | undefined;
  async function hasQuorumTables(tx: SqlTx): Promise<boolean> {
    const now = Date.now();
    if (quorumTables?.present || (quorumTables && now - quorumTables.checkedAt < 30_000)) return quorumTables.present;
    const { rows } = await tx.query<{ present: boolean }>(
      `SELECT to_regclass('command_batch_members') IS NOT NULL AS present`,
    );
    quorumTables = { present: Boolean(rows[0]?.present), checkedAt: now };
    return quorumTables.present;
  }

  /** Re-attaches batch approvals to replayed commands whose signed body names a batch. */
  async function withBatchAttachments(tx: SqlTx, commands: StoredCommand[]): Promise<StoredCommand[]> {
    const batched = commands.filter((command) => command.batchId);
    if (!batched.length || !(await hasQuorumTables(tx))) return commands;
    const { rows } = await tx.query(
      `SELECT m.command_id, b.required AS batch_required, b.approval AS batch_approval, sc.proof AS batch_proof
         FROM command_batch_members m JOIN command_batches b ON b.id = m.batch_id
         LEFT JOIN command_batch_scope sc ON sc.batch_id = m.batch_id AND sc.subject = m.subject AND sc.kind = m.kind
           AND sc.payload_sha256 = m.payload_sha256
        WHERE m.command_id = ANY($1::text[])`,
      [batched.map((command) => command.id)],
    );
    const attachments = new Map(rows.map((row) => [String(row.command_id), batchAttachment(row)]));
    return commands.map((command) => ({ ...command, ...(attachments.get(command.id) ?? {}) }));
  }

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
    const rows = new Map<
      string,
      { nodeId: string; state: CommandState; kind: string; workflow: boolean; idempotencyKey: string }
    >();
    if (ids.length) {
      const read = await tx.query<{
        id: string;
        node_id: string;
        state: CommandState;
        kind: string;
        workflow: boolean;
        idempotency_key: string;
      }>(
        `SELECT id, node_id, state, kind, starts_with(idempotency_key, 'wf:') AS workflow, idempotency_key
           FROM commands WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE`,
        [ids],
      );
      for (const row of read.rows)
        rows.set(row.id, {
          nodeId: row.node_id,
          state: row.state,
          kind: row.kind,
          workflow: row.workflow,
          idempotencyKey: row.idempotency_key,
        });
    }
    /** Nodes whose workflow step's command settled: the Workflow reconciler (keyed by node) runs now, not at its 10 s poll. */
    const workflowWake = new Set<string>();
    /** Owners of settled commands (`commandOwner`), by work kind. */
    const ownerWake = new Map<string, Set<string>>();
    // Final write per command after every update of the batch, in order.
    const writes = new Map<
      string,
      {
        state: CommandState;
        reason: string | null;
        /** Set together or not at all: a node signature never sits next to another result. */
        result: { bytes: Uint8Array; sigKid: string | null; sig: Uint8Array | null } | null;
      }
    >();
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
            // The node's signature (attested kinds) is stored exactly as received, with the result
            // it covers; workers verify it (§6), the gateway never judges or strips it.
            const signed = Boolean(update.nodeSig?.sig.byteLength);
            const result =
              commandTerminalStates.has(to) && (update.result.byteLength || signed)
                ? {
                    bytes: update.result,
                    sigKid: signed ? update.nodeSig!.kid : null,
                    sig: signed ? update.nodeSig!.sig : null,
                  }
                : null;
            writes.set(update.commandId, { state: to, reason, result });
            if (commandTerminalStates.has(to)) {
              const settled: SettledCommand = { id: update.commandId, kind: row.kind, state: to };
              if (reason) settled.reason = reason;
              results[index]!.settled.push(settled);
              settledEvents.push({ entry: index, settled });
              if (row.workflow) workflowWake.add(entry.nodeId);
              const owner = ownerOf(row.idempotencyKey);
              if (owner) {
                let keys = ownerWake.get(owner.kind);
                if (!keys) ownerWake.set(owner.kind, (keys = new Set()));
                keys.add(owner.key);
              }
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
        `UPDATE commands c SET state = v.state, reason = v.reason, updated_at = compute_now(),
           result = CASE WHEN v.result IS NULL THEN c.result ELSE decode(v.result, 'hex') END,
           result_sig_kid = CASE WHEN v.result IS NULL THEN c.result_sig_kid ELSE v.sig_kid END,
           result_sig = CASE WHEN v.result IS NULL THEN c.result_sig ELSE decode(v.sig, 'hex') END
         FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[])
           AS v(id, state, reason, result, sig_kid, sig)
         WHERE c.id = v.id`,
        [
          list.map(([id]) => id),
          list.map(([, write]) => write.state),
          list.map(([, write]) => write.reason),
          list.map(([, write]) => (write.result ? Buffer.from(write.result.bytes).toString('hex') : null)),
          list.map(([, write]) => write.result?.sigKid ?? null),
          list.map(([, write]) => (write.result?.sig ? Buffer.from(write.result.sig).toString('hex') : null)),
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
    // `wf:` commands exist only where the provision module (and its `workflow` reconciler) runs.
    await enqueueAll(tx, 'workflow', [...workflowWake]);
    // One set-wise enqueue per owner kind, only for batches in which such a command settled.
    for (const [kind, keys] of ownerWake) await enqueueAll(tx, kind, [...keys]);
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
            context.attested = {
              body: envelope.body,
              kid: envelope.nodeSig?.kid ?? '',
              sig: envelope.nodeSig?.sig ?? new Uint8Array(0),
            };
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
      // No `node` wake: the node reconciler reads no agent events (its triggers are connect,
      // disconnect, settled commands and status), and a join storm paid one run per event batch.
      await tx.query('UPDATE node_sessions SET acked_event_seq = $2 WHERE node_id = $1', [
        nodeId,
        acked,
      ]);
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
    async hello(input: HelloInput, options: HelloOptions): Promise<HelloResult> {
      const outcome = await db.transaction(async (tx): Promise<HelloResult | { quarantined: string[] }> => {
        await fence(tx);
        // The session certificate as compute recorded it, before anything changes: Postgres is the
        // revocation truth (the in-memory feed may lag a poll), and a restricted certificate
        // (discovery/ramdisk, core/0010) limits what may be sent here. An unrecorded serial (a
        // certificate issued outside JoinService) is unrestricted.
        let allowedKinds: string[] | null = null;
        if (input.certSerial) {
          const cert = await tx.query<{ allowed_kinds: string[] | null; revoked: boolean; stale: boolean }>(
            `SELECT c.allowed_kinds, c.revoked_at IS NOT NULL AS revoked,
                    c.identity_gen < n.identity_gen AS stale
               FROM node_certs c JOIN nodes n ON n.id = c.node_id
              WHERE c.serial = $1 AND c.node_id = $2`,
            [input.certSerial, input.nodeId],
          );
          const row = cert.rows[0];
          if (row?.revoked || row?.stale)
            throw new ComputeError('UNAUTHENTICATED', 'certificate revoked', undefined, {
              reason: row.revoked ? 'revoked' : 'superseded identity generation',
            });
          allowedKinds = row?.allowed_kinds ?? null;
        }
        // The node row is locked too: this Hello rewrites its system labels (drivers, `bc.dev/cap.*`),
        // and placement re-checks nodeLabels under the node's FOR SHARE lock, so a capability a
        // downgraded daemon dropped can never be missed by a placement that commits after it.
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
           WHERE s.node_id = $1 FOR UPDATE OF s FOR NO KEY UPDATE OF n`,
          [input.nodeId, options.liveWindowMs / 1000],
        );
        const prior = previous.rows[0];
        if (!prior)
          throw new ComputeError('NOT_FOUND', `Node ${input.nodeId} has not joined`, undefined, {
            nodeId: input.nodeId,
          });
        const tenantId = prior.tenant_id;

        // Duplicate identity (§7.2): a second live Hello from another boot wins, and is reported. The
        // same certificate alternating between two machines (a cloned key) more than
        // `duplicateHellos.max` times within `windowMs` quarantines it: its serial is revoked (every
        // gateway's RevocationFeed drops the other clone too) and this Hello is refused. An operator
        // re-joins the real machine with a new token.
        const duplicate = prior.live && prior.boot_id !== null && prior.boot_id !== input.bootId;
        if (duplicate) {
          const limits = options.duplicateHellos ?? duplicateHelloDefaults;
          const counted = await tx.query<{ duplicate_hellos: number }>(
            `UPDATE node_sessions SET
               duplicate_hellos = CASE WHEN duplicate_since IS NULL
                 OR duplicate_since < compute_now() - make_interval(secs => $2::float8) THEN 1
                 ELSE duplicate_hellos + 1 END,
               duplicate_since = CASE WHEN duplicate_since IS NULL
                 OR duplicate_since < compute_now() - make_interval(secs => $2::float8) THEN compute_now()
                 ELSE duplicate_since END
             WHERE node_id = $1 RETURNING duplicate_hellos`,
            [input.nodeId, limits.windowMs / 1000],
          );
          const alternations = Number(counted.rows[0]!.duplicate_hellos);
          const quarantine = alternations > limits.max;
          await events.publish(tx, {
            type: 'security.node.duplicate-session',
            tenantId,
            subject: `node/${input.nodeId}`,
            data: {
              nodeId: input.nodeId,
              gatewayId: input.gatewayId,
              previousBootId: prior.boot_id,
              bootId: input.bootId,
              alternations,
              windowSeconds: limits.windowMs / 1000,
              quarantined: quarantine,
            },
          });
          if (quarantine) {
            // The presented certificate; without a recorded serial (header-authenticated dev
            // gateways), every live certificate of the node.
            const revoked = await tx.query<{ serial: string }>(
              `UPDATE node_certs SET revoked_at = compute_now(), revocation_reason = 'duplicate-identity'
                WHERE node_id = $1 AND revoked_at IS NULL AND ($2::text IS NULL OR serial = $2)
                RETURNING serial`,
              [input.nodeId, input.certSerial ?? null],
            );
            // A re-joined machine starts counting afresh.
            await tx.query(
              'UPDATE node_sessions SET duplicate_hellos = 0, duplicate_since = NULL WHERE node_id = $1',
              [input.nodeId],
            );
            const serials = revoked.rows.map((row) => row.serial);
            await events.publish(tx, {
              type: 'security.node.quarantined',
              tenantId,
              subject: `node/${input.nodeId}`,
              data: { nodeId: input.nodeId, reason: 'duplicate-identity', alternations, serials },
            });
            return { quarantined: serials };
          }
        }

        const journalChanged = prior.journal_id !== null && prior.journal_id !== input.journalId;
        const bootChanged =
          prior.boot_id !== null &&
          (prior.boot_id !== input.bootId || (prior.role !== null && prior.role !== input.role));

        const bumped = await tx.query<{ session_epoch: number; acked_event_seq: number }>(
          `UPDATE node_sessions SET gateway_id = $2, session_id = $3, session_epoch = session_epoch + 1,
             boot_id = $4, journal_id = $5, role = $6, daemon_version = $7, proto_max = $8,
             trust_version = $9, capabilities = $10::text[],
             approver_set_epoch = $11::numeric, approver_set_sha256 = $12::bytea,
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
            // What Rollout (v0.4) reads to see a self-update finish; empty/0 means unknown.
            input.daemonVersion || null,
            input.protoMax && input.protoMax > 0 ? input.protoMax : null,
            // What the daemon holds now, even if older than before (a restored disk): a root switch
            // must not count a node that lost the new bundle.
            String(input.trustVersion ?? 0n),
            sessionCapabilities(input.capabilities),
            ...approverSetParams(input.approverSetEpoch, input.approverSetSha256),
          ],
        );
        const epoch = Number(bumped.rows[0]!.session_epoch);
        const settled: SettledCommand[] = [];
        let workflowSettled = false;
        const owners = new Map<string, Set<string>>();
        const settleRule = async (sql: string, reason: string) => {
          const { rows } = await tx.query<{
            id: string;
            kind: string;
            state: CommandState;
            workflow: boolean;
            idempotency_key: string;
          }>(sql, [input.nodeId, inFlight]);
          for (const row of rows) {
            const entry: SettledCommand = { id: row.id, kind: row.kind, state: row.state, reason };
            settled.push(entry);
            if (row.workflow) workflowSettled = true;
            const owner = ownerOf(row.idempotency_key);
            if (owner) {
              let keys = owners.get(owner.kind);
              if (!keys) owners.set(owner.kind, (keys = new Set()));
              keys.add(owner.key);
            }
            await settle(tx, input.nodeId, tenantId, entry);
          }
        };
        // 1. A new boot (or role) completes in-flight self-terminating commands; never replayed.
        if (bootChanged)
          await settleRule(
            `UPDATE commands SET state = 'succeeded', reason = 'rebooted', updated_at = compute_now()
             WHERE node_id = $1 AND self_terminating AND state = ANY($2::text[])
             RETURNING id, kind, state, starts_with(idempotency_key, 'wf:') AS workflow, idempotency_key`,
            'rebooted',
          );
        // 2. A lost journal fails in-flight commands that are unsafe to run twice.
        if (journalChanged)
          await settleRule(
            `UPDATE commands SET state = 'failed', reason = 'journal-lost', updated_at = compute_now()
             WHERE node_id = $1 AND NOT retry_safe AND state = ANY($2::text[])
             RETURNING id, kind, state, starts_with(idempotency_key, 'wf:') AS workflow, idempotency_key`,
            'journal-lost',
          );
        // A workflow step waiting on these (a reboot's `rejoin`) runs now, not at its next poll.
        if (workflowSettled) await work.enqueue(tx, 'workflow', input.nodeId);
        for (const [kind, keys] of owners) await enqueueAll(tx, kind, [...keys]);
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
        const held = (await withBatchAttachments(tx, inFlightRows.rows.map(storedCommand))).sort(
          (a, b) => a.seq - b.seq,
        );
        const replay = held.filter((command) => !running.includes(command.id));
        const runningCommands = held.filter((command) => running.includes(command.id));

        const connected = await tx.query(
          `UPDATE nodes SET connectivity = 'connected' WHERE id = $1 AND connectivity <> 'connected'
           RETURNING id`,
          [input.nodeId],
        );
        // The drivers and capabilities the daemon advertises (§5.6 walkthrough 4: placement filters
        // on them) as system labels `bc.dev/driver.<id>=<version>` and `bc.dev/cap.<name>=1`,
        // replaced on every Hello (a dropped one goes), in one statement that writes nothing when
        // they did not change.
        const labels = [...driverLabels(input.drivers ?? []), ...capabilityLabels(input.capabilities)];
        await tx.query(
          `WITH wanted AS (SELECT * FROM unnest($2::text[], $3::text[]) AS w(key, value)),
           gone AS (
             DELETE FROM node_labels l WHERE l.node_id = $1 AND l.source = 'system'
               AND (starts_with(l.key, '${driverLabelPrefix}') OR starts_with(l.key, '${capabilityLabelPrefix}'))
               AND NOT EXISTS (SELECT 1 FROM wanted w WHERE w.key = l.key))
           INSERT INTO node_labels (node_id, key, value, source)
           SELECT $1, w.key, w.value, 'system' FROM wanted w
           ON CONFLICT (node_id, key) DO UPDATE SET value = EXCLUDED.value
             WHERE node_labels.source = 'system' AND node_labels.value <> EXCLUDED.value`,
          [input.nodeId, labels.map((label) => label.key), labels.map((label) => label.value)],
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
          allowedKinds,
        };
      });
      // Refused only after the quarantine committed (a throw inside would roll the revocation back).
      if ('quarantined' in outcome)
        throw new ComputeError('UNAUTHENTICATED', 'certificate quarantined: duplicate identity', undefined, {
          reason: 'duplicate-identity',
          serials: outcome.quarantined,
        });
      return outcome;
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
        const quorum = await hasQuorumTables(tx);
        const { rows } = await tx.query(
          `SELECT c.id, c.node_id, c.seq, c.kind, c.body, c.signature, c.state, c.attempt,
             c.cancel_requested_at IS NOT NULL AS cancel_requested, c.cancel_reason,
             s.session_epoch, n.owner_tenant_id AS tenant_id
             ${quorum ? ', b.required AS batch_required, b.approval AS batch_approval, sc.proof AS batch_proof' : ''}
           FROM commands c JOIN node_sessions s USING (node_id) JOIN nodes n ON n.id = c.node_id
           ${quorum ? batchJoin : ''}
           WHERE s.gateway_id = $1 AND c.state = 'pending'
             AND c.not_before <= compute_now() AND c.not_after > compute_now()
             ${quorum ? `AND ${batchSendable}` : ''}
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
     * Settles commands the gateway will not deliver to this node (e.g. `kind-not-allowed` for a
     * restricted certificate) as `cancelled`, from any non-terminal state, with their events.
     */
    async refuse(nodeId: string, tenantId: string, ids: readonly string[], reason: string): Promise<string[]> {
      if (!ids.length) return [];
      return db.transaction(async (tx) => {
        const { rows } = await tx.query<{ id: string; kind: string }>(
          `UPDATE commands SET state = 'cancelled', reason = $3, updated_at = compute_now()
           WHERE id = ANY($1::text[]) AND node_id = $2 AND state = ANY($4::text[])
           RETURNING id, kind`,
          [[...ids], nodeId, reason, ['pending', ...inFlight]],
        );
        await publishAll(
          tx,
          rows.map((row) => settledEvent(nodeId, tenantId, { id: row.id, kind: row.kind, state: 'cancelled', reason })),
        );
        if (rows.length) await work.enqueue(tx, 'node', nodeId);
        return rows.map((row) => row.id);
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
        const advanced = await tx.query(
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
        // The node reconciler waits on convergence: wake it when observed_generation moved, not on
        // every (coalesced, ~1/s) report. Conditions and instances go to the status handlers.
        if (advanced.rowCount) await work.enqueue(tx, 'node', nodeId);
        // A newer TrustBundle applied mid-session (Welcome.trust) is acked here, not at the next
        // Hello (§13 root switch). 0 means unchanged, so the usual report adds no statement.
        // The approver set held after that bundle is written only from a report at least as new as
        // the recorded version, so a late older report never pairs an old set with a newer version.
        if (report.trustVersion > 0n)
          await tx.query(
            `UPDATE node_sessions SET
               approver_set_epoch = CASE WHEN $2::bigint >= trust_version THEN $3::numeric ELSE approver_set_epoch END,
               approver_set_sha256 = CASE WHEN $2::bigint >= trust_version THEN $4::bytea ELSE approver_set_sha256 END,
               trust_version = GREATEST(trust_version, $2::bigint)
             WHERE node_id = $1`,
            [nodeId, String(report.trustVersion), ...approverSetParams(report.approverSetEpoch, report.approverSetSha256)],
          );
        // Health, instances, … are the host's; a failing handler must not hold back
        // observed_generation or the other handlers: each runs under its own savepoint.
        const handlers = reports.status === undefined ? [] : Array.isArray(reports.status) ? reports.status : [reports.status];
        for (const [index, handler] of (handlers as readonly StatusHandler[]).entries()) {
          await tx.query('SAVEPOINT gateway_status');
          try {
            await handler(tx, { nodeId, tenantId, work, events }, report);
            await tx.query('RELEASE SAVEPOINT gateway_status');
          } catch (error) {
            await tx.query('ROLLBACK TO SAVEPOINT gateway_status');
            await events.publish(tx, {
              type: 'node.report-failed',
              tenantId,
              subject: `node/${nodeId}`,
              data: {
                nodeId,
                report: 'status',
                handler: handler.name || String(index),
                error: error instanceof Error ? error.message : String(error),
              },
            });
          }
        }
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
     * in one transaction. Sections go set-wise (`ingestSections`: a few statements for the whole
     * batch, a corrupt section failing only its slot); hash reports, and sections without it, each
     * under their own SAVEPOINT. The slot of a failed entry holds its error.
     */
    async inventoryBatch(
      entries: readonly (
        | { kind: 'section'; nodeId: string; section: InventorySection }
        | { kind: 'hashes'; nodeId: string; bootId: string; hashes: Readonly<Record<string, Uint8Array>> }
      )[],
    ): Promise<(undefined | Error)[]> {
      return db.transaction(async (tx) => {
        const results: (undefined | Error)[] = new Array(entries.length).fill(undefined);
        const sections = entries.flatMap((entry, index) => (entry.kind === 'section' ? [{ entry, index }] : []));
        const setWise = inventory.ingestSections && sections.length > 1;
        if (setWise) {
          await tx.query('SAVEPOINT gateway_inventory');
          try {
            const outcomes = await inventory.ingestSections!(
              tx,
              work,
              sections.map(({ entry }) => ({
                nodeId: entry.nodeId,
                section: { section: entry.section.section, content: entry.section.content, sha256: entry.section.sha256 },
              })),
            );
            sections.forEach(({ index }, position) => (results[index] = outcomes[position]));
            await tx.query('RELEASE SAVEPOINT gateway_inventory');
          } catch (error) {
            await tx.query('ROLLBACK TO SAVEPOINT gateway_inventory');
            for (const { index } of sections) results[index] = error instanceof Error ? error : new Error(String(error));
          }
        }
        // Heartbeat hash reports: one statement for the batch (the pull list itself is not needed
        // here; a changed set is requested at the next Hello).
        const reports = entries.flatMap((entry, index) => (entry.kind === 'hashes' ? [{ entry, index }] : []));
        const hashesSetWise = inventory.recordHashesMany && reports.length > 1;
        if (hashesSetWise) {
          await tx.query('SAVEPOINT gateway_inventory');
          try {
            const outcomes = await inventory.recordHashesMany!(
              tx,
              work,
              reports.map(({ entry }) => ({ nodeId: entry.nodeId, hashes: entry.hashes, bootId: entry.bootId })),
            );
            reports.forEach(({ index }, position) => {
              const outcome = outcomes[position];
              results[index] = outcome instanceof Error ? outcome : undefined;
            });
            await tx.query('RELEASE SAVEPOINT gateway_inventory');
          } catch (error) {
            await tx.query('ROLLBACK TO SAVEPOINT gateway_inventory');
            for (const { index } of reports) results[index] = error instanceof Error ? error : new Error(String(error));
          }
        }
        for (const [index, entry] of entries.entries()) {
          if (setWise && entry.kind === 'section') continue;
          if (hashesSetWise && entry.kind === 'hashes') continue;
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
          } catch (error) {
            await tx.query('ROLLBACK TO SAVEPOINT gateway_inventory');
            results[index] = error instanceof Error ? error : new Error(String(error));
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
