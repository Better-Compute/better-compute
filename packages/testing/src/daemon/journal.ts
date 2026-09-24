// The FakeDaemon's journal: a TypeScript mirror of daemon/internal/journal (journal.go, memory.go,
// rules.go), which is the reference. Names and rules follow the Go code one to one; the deviations
// are marked "TS:" and listed in the package README.
//
//   - meta: node id, journal_id, event seq, last epoch, applied generation;
//   - commands: id → accepted | running{boot_id} | done + result, kept for 7 days (COMMAND_TTL_MS);
//   - unacked events: metric-like events are dropped oldest-first when the journal is full, results
//     and transitions never are;
//   - the last full spec with its hash and signature, enforced while offline;
//   - certificates, and the exec-ticket jti set.
//
// It lives in memory. A FakeDaemon "crash" keeps the MemoryJournal (the disk survives); a journal
// loss replaces it with a new one, which gets a new journal_id.

/** Caps from PLAN.md §6 (P12: everything is bounded). */
export const JOURNAL_DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
export const JOURNAL_DEFAULT_MAX_EVENTS = 10_000;
/** How long a done command is kept to answer duplicate deliveries. */
export const COMMAND_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** The failure reason of a non-retry-safe command a crash interrupted. */
export const REASON_INTERRUPTED = 'interrupted';

/** Go's per-event bookkeeping overhead, counted against the byte cap. */
const EVENT_OVERHEAD = 32;
const MAX_TICKETS = 10_000;

export type JournalErrorCode = 'FULL' | 'NOT_FOUND' | 'STALE_SPEC' | 'INVALID';

/** A journal failure (Go: ErrFull, ErrNotFound, ErrStaleSpec, and plain errors as INVALID). */
export class JournalError extends Error {
  constructor(
    readonly code: JournalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'JournalError';
  }
}

export interface JournalMeta {
  nodeId: string;
  journalId: string;
  eventSeq: number;
  lastEpoch: number;
  appliedGeneration: number;
}

/** A command entry's state. */
export type EntryState = 'accepted' | 'running' | 'done';

/**
 * A done command's terminal outcome. TS: `cancelled` is added for `Cancel{id}` before any action
 * ran (CommandState.CANCELLED); Go's journal has only succeeded, failed and rejected so far.
 */
export type Outcome = 'succeeded' | 'failed' | 'rejected' | 'cancelled';

export interface JournalResult {
  outcome: Outcome;
  /** Explains a failure or rejection, e.g. REASON_INTERRUPTED or "EXPIRED". */
  reason?: string;
  /** Human-readable detail (TS: CommandError.message). */
  message?: string;
  /** A self-terminating command completed by the reboot it caused. */
  rebooted?: boolean;
  /** The kind-specific result body. */
  payload?: Uint8Array;
  /** TS: the boot the result was produced in (CommandUpdate.boot_id on replay). */
  bootId?: string;
}

export interface JournalCommand {
  id: string;
  kind: string;
  /** Copied from the CommandBody that was accepted. */
  retrySafe: boolean;
  selfTerminating: boolean;
  state: EntryState;
  /** The boot the command started running in (state `running`). */
  bootId?: string;
  /** The daemon process that last wrote the entry. */
  incarnation: string;
  /** Set once the command is done. */
  result?: JournalResult;
  /** The server acknowledged the result; until then Hello replays it. */
  resultAcked: boolean;
  updatedAt: number;
}

/** Only metric-like events are ever dropped. */
export type EventClass = 'metric' | 'transition' | 'result';

export interface JournalEvent {
  seq: number;
  class: EventClass;
  kind: string;
  payload: Uint8Array;
}

export interface EventStats {
  count: number;
  bytes: number;
  droppedMetrics: number;
}

/** The last full desired state, as received in DesiredState. */
export interface JournalSpec {
  generation: number;
  hash: Uint8Array;
  body: Uint8Array;
  signature: Uint8Array;
}

export interface JournalCerts {
  chain: Uint8Array[];
  trustBundle: Uint8Array[];
  notAfter: number;
}

export interface MemoryJournalOptions {
  maxEvents?: number;
  maxBytes?: number;
  /** Mints the journal_id (Go: NewID("jrn"), 32 random hex digits). */
  newJournalId?: () => string;
}

const copy = <T>(value: T): T => structuredClone(value);

/** Go's NewID(prefix) shape: `<prefix>_<32 hex>`, from a seeded source. */
export function journalStyleId(prefix: string, hex32: string): string {
  return `${prefix}_${hex32}`;
}

/**
 * An in-memory journal (Go: journal.Memory). Values passed in and returned are copies, never
 * shared with the store.
 */
export class MemoryJournal {
  private readonly maxEvents: number;
  private readonly maxBytes: number;
  private metaValue: JournalMeta;
  private readonly entries = new Map<string, JournalCommand>();
  private events: JournalEvent[] = [];
  private eventBytes = 0;
  private dropped = 0;
  private specValue: JournalSpec | undefined;
  private certsValue: JournalCerts | undefined;
  private readonly tickets = new Map<string, number>();

  constructor(nodeId: string, options: MemoryJournalOptions = {}) {
    this.maxEvents = options.maxEvents && options.maxEvents > 0 ? options.maxEvents : JOURNAL_DEFAULT_MAX_EVENTS;
    this.maxBytes = options.maxBytes && options.maxBytes > 0 ? options.maxBytes : JOURNAL_DEFAULT_MAX_BYTES;
    const journalId =
      options.newJournalId?.() ??
      journalStyleId(
        'jrn',
        Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join(''),
      );
    this.metaValue = { nodeId, journalId, eventSeq: 0, lastEpoch: 0, appliedGeneration: 0 };
  }

  meta(): JournalMeta {
    return { ...this.metaValue };
  }

  /** Stores nodeId, lastEpoch and appliedGeneration; journalId and eventSeq belong to the journal. */
  saveMeta(meta: JournalMeta): void {
    this.metaValue.nodeId = meta.nodeId;
    this.metaValue.lastEpoch = meta.lastEpoch;
    this.metaValue.appliedGeneration = meta.appliedGeneration;
  }

  command(id: string): JournalCommand | undefined {
    const entry = this.entries.get(id);
    return entry ? copy(entry) : undefined;
  }

  putCommand(entry: JournalCommand): void {
    if (!entry.id) throw new JournalError('INVALID', 'journal: a command needs an id');
    this.entries.set(entry.id, copy(entry));
  }

  deleteCommand(id: string): void {
    this.entries.delete(id);
  }

  /** Every entry, ordered by id. */
  commands(): JournalCommand[] {
    return [...this.entries.values()].map(copy).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /**
   * Assigns the next seq and stores the event. When full, drops the oldest metric events to make
   * room; if that is not enough, throws JournalError('FULL').
   */
  appendEvent(event: Omit<JournalEvent, 'seq'>): JournalEvent {
    if (!['metric', 'transition', 'result'].includes(event.class))
      throw new JournalError('INVALID', `journal: unknown event class ${String(event.class)}`);
    const size = eventSize(event);
    // Drop metrics oldest-first only when that can make room: an event larger than the whole cap is
    // refused without touching the backlog.
    while (size <= this.maxBytes && !this.fits(size)) {
      if (!this.dropOldestMetric()) break;
    }
    if (!this.fits(size)) {
      if (event.class === 'metric') this.dropped++;
      throw new JournalError('FULL', 'journal: full');
    }
    this.metaValue.eventSeq++;
    const stored: JournalEvent = { ...event, payload: event.payload.slice(), seq: this.metaValue.eventSeq };
    this.events.push(stored);
    this.eventBytes += size;
    return copy(stored);
  }

  /** Forgets every event with seq <= upTo (the server's cumulative ack). */
  ackEvents(upTo: number): void {
    const kept: JournalEvent[] = [];
    for (const e of this.events) {
      if (e.seq <= upTo) {
        this.eventBytes -= eventSize(e);
        continue;
      }
      kept.push(e);
    }
    this.events = kept;
  }

  /** The stored events in seq order. */
  unackedEvents(): JournalEvent[] {
    return this.events.map(copy);
  }

  eventStats(): EventStats {
    return { count: this.events.length, bytes: this.eventBytes, droppedMetrics: this.dropped };
  }

  spec(): JournalSpec | undefined {
    return this.specValue ? copy(this.specValue) : undefined;
  }

  /** Replaces the stored spec; an older generation throws JournalError('STALE_SPEC'). */
  saveSpec(spec: JournalSpec): void {
    if (this.specValue && spec.generation < this.specValue.generation)
      throw new JournalError('STALE_SPEC', 'journal: spec generation is older than the stored spec');
    this.specValue = copy(spec);
  }

  certs(): JournalCerts | undefined {
    return this.certsValue ? copy(this.certsValue) : undefined;
  }

  saveCerts(certs: JournalCerts): void {
    this.certsValue = copy(certs);
  }

  /**
   * Records an exec-ticket jti until expiresAt and reports whether it was fresh: false means a
   * replay, or a ticket already expired at now. Forgets jtis expired at now.
   */
  rememberTicket(jti: string, expiresAt: number, now: number): boolean {
    for (const [id, exp] of this.tickets) if (!(exp > now)) this.tickets.delete(id);
    if (!(expiresAt > now)) return false;
    if (this.tickets.has(jti)) return false;
    if (this.tickets.size >= MAX_TICKETS) throw new JournalError('FULL', 'journal: full');
    this.tickets.set(jti, expiresAt);
    return true;
  }

  private fits(size: number): boolean {
    return this.events.length < this.maxEvents && this.eventBytes + size <= this.maxBytes;
  }

  private dropOldestMetric(): boolean {
    const index = this.events.findIndex((e) => e.class === 'metric');
    if (index < 0) return false;
    this.eventBytes -= eventSize(this.events[index]!);
    this.events.splice(index, 1);
    this.dropped++;
    return true;
  }
}

function eventSize(event: Pick<JournalEvent, 'kind' | 'payload'>): number {
  return EVENT_OVERHEAD + event.kind.length + event.payload.byteLength;
}

// ---------------------------------------------------------------------------------------------
// Command rules (rules.go). A delivered command goes through resolve() first. A new command
// ('execute') or an interrupted retry-safe one ('reexecute') then passes the acceptance checks, and
// accept() makes `accepted` durable before any side effect. Self-terminating kinds call
// markRunning() immediately before theirs; other kinds call it when they start. complete() records
// the result, which Hello replays until ackResult().
//
// "Crashed" is decided per daemon process: every process start picks a fresh incarnation, and an
// accepted or running entry written by another incarnation belongs to a process that no longer
// exists, so nothing is left to re-attach to.

/** Identifies the running daemon process to the command rules. */
export interface Runtime {
  bootId: string;
  incarnation: string;
  now: number;
}

/** What the rules need from a delivered CommandBody. */
export interface Delivery {
  id: string;
  kind: string;
  retrySafe: boolean;
  selfTerminating: boolean;
}

export type Action =
  /** The command is new: run the acceptance checks, then accept and execute it. */
  | 'execute'
  /** The command is done: resend the stored result. */
  | 'resend'
  /** This process has it accepted or running: the execution in flight reports the result. */
  | 'reattach'
  /** A crash interrupted a retry-safe command: run the checks again, then accept and execute. */
  | 'reexecute'
  /** resolve() completed it without executing (FAILED{interrupted} or SUCCEEDED{rebooted}). */
  | 'report';

export interface Decision {
  action: Action;
  /** Set for 'resend' and 'report'. */
  result?: JournalResult;
}

/**
 * TS: optional kind knowledge for results the rules produce on their own. Go leaves the payload of
 * SUCCEEDED{rebooted} empty; commands.proto defines NodeRebootResult{previous_boot_id}, which the
 * FakeDaemon fills from the running entry's boot_id through this hook.
 */
export interface RuleHooks {
  rebootedPayload?: (entry: JournalCommand) => Uint8Array | undefined;
}

/**
 * Applies the duplicate-delivery rules: no entry → execute; done → resend; accepted or running in
 * this incarnation → reattach; running a self-terminating kind in an earlier incarnation and an
 * earlier boot → SUCCEEDED{rebooted} (report); otherwise left by an earlier incarnation →
 * reexecute if retry-safe, else FAILED{interrupted} (report). Entries are judged by the flags
 * stored when they were accepted, not by the redelivered copy.
 */
export function resolve(
  journal: MemoryJournal,
  delivery: Delivery,
  rt: Runtime,
  hooks: RuleHooks = {},
): Decision {
  const entry = journal.command(delivery.id);
  if (!entry) return { action: 'execute' };
  if (entry.state === 'done') return { action: 'resend', result: entry.result! };
  if (entry.incarnation === rt.incarnation) return { action: 'reattach' };
  const { result, reexecute } = interrupted(entry, rt, hooks);
  if (reexecute) return { action: 'reexecute' };
  const done = finish(journal, entry, result, rt.now);
  return { action: 'report', result: done.result! };
}

/** Durably records `delivery` as accepted by this incarnation. Must return before any side effect. */
export function accept(journal: MemoryJournal, delivery: Delivery, rt: Runtime): void {
  if (!delivery.id) throw new JournalError('INVALID', 'journal: a command needs an id');
  const entry = journal.command(delivery.id);
  if (entry?.state === 'done')
    throw new JournalError('INVALID', `journal: command ${delivery.id} is already done`);
  journal.putCommand({
    id: delivery.id,
    kind: delivery.kind,
    retrySafe: delivery.retrySafe,
    selfTerminating: delivery.selfTerminating,
    state: 'accepted',
    incarnation: rt.incarnation,
    resultAcked: false,
    updatedAt: rt.now,
  });
}

/** accepted → running{boot_id}. Self-terminating kinds call it immediately before their side effect. */
export function markRunning(journal: MemoryJournal, id: string, rt: Runtime): void {
  const entry = journal.command(id);
  if (!entry) throw new JournalError('NOT_FOUND', `journal: command not found: ${id}`);
  if (entry.state !== 'accepted')
    throw new JournalError('INVALID', `journal: command ${id} is ${entry.state}, not accepted`);
  journal.putCommand({ ...entry, state: 'running', bootId: rt.bootId, incarnation: rt.incarnation, updatedAt: rt.now });
}

const outcomes: readonly Outcome[] = ['succeeded', 'failed', 'rejected', 'cancelled'];

/** Records a command's result. */
export function complete(journal: MemoryJournal, id: string, result: JournalResult, now: number): void {
  if (!outcomes.includes(result.outcome))
    throw new JournalError('INVALID', `journal: invalid outcome ${JSON.stringify(result.outcome)}`);
  const entry = journal.command(id);
  if (!entry) throw new JournalError('NOT_FOUND', `journal: command not found: ${id}`);
  if (entry.state === 'done') throw new JournalError('INVALID', `journal: command ${id} is already done`);
  finish(journal, entry, result, now);
}

/**
 * TS: journals a terminal rejection (UNSUPPORTED, EXPIRED, STALE_GENERATION, BAD_SIGNATURE) as a
 * done entry with outcome `rejected` and the code as reason, so a duplicate resends the same
 * answer and Hello replays it until acked. Go's dispatcher (still a TODO) has no helper for this;
 * `Result.Reason`'s doc ("such as … EXPIRED") implies it. BUSY is never journaled.
 */
export function recordRejection(
  journal: MemoryJournal,
  delivery: Delivery,
  reason: string,
  rt: Runtime,
  bootId: string,
): JournalResult {
  const result: JournalResult = { outcome: 'rejected', reason, bootId };
  journal.putCommand({
    id: delivery.id,
    kind: delivery.kind,
    retrySafe: delivery.retrySafe,
    selfTerminating: delivery.selfTerminating,
    state: 'done',
    incarnation: rt.incarnation,
    result,
    resultAcked: false,
    updatedAt: rt.now,
  });
  return result;
}

/** Records that the server has a done command's result, so Hello stops replaying it. */
export function ackResult(journal: MemoryJournal, id: string): void {
  const entry = journal.command(id);
  if (!entry) throw new JournalError('NOT_FOUND', `journal: command not found: ${id}`);
  if (entry.state !== 'done')
    throw new JournalError('INVALID', `journal: command ${id} is ${entry.state}, not done`);
  journal.putCommand({ ...entry, resultAcked: true });
}

/**
 * Runs once at daemon start: completes the entries an earlier incarnation left accepted or running
 * whose outcome needs no server input (SUCCEEDED{rebooted}, FAILED{interrupted}) and returns them,
 * to report in Hello.unacked_results. Retry-safe entries stay until the server redelivers them.
 */
export function recover(journal: MemoryJournal, rt: Runtime, hooks: RuleHooks = {}): JournalCommand[] {
  const completed: JournalCommand[] = [];
  for (const entry of journal.commands()) {
    if (entry.state === 'done' || entry.incarnation === rt.incarnation) continue;
    const { result, reexecute } = interrupted(entry, rt, hooks);
    if (reexecute) continue;
    completed.push(finish(journal, entry, result, rt.now));
  }
  return completed;
}

/** Deletes done commands last updated before now-ttl; accepted and running entries stay. */
export function sweep(journal: MemoryJournal, now: number, ttlMs = COMMAND_TTL_MS): number {
  const cutoff = now - ttlMs;
  let removed = 0;
  for (const entry of journal.commands()) {
    if (entry.state !== 'done' || !(entry.updatedAt < cutoff)) continue;
    journal.deleteCommand(entry.id);
    removed++;
  }
  return removed;
}

/**
 * Decides an entry an earlier incarnation left accepted or running. TS: the result carries the
 * current boot as `bootId`; the payload stays with the caller (Go leaves it empty).
 */
export function interrupted(
  entry: JournalCommand,
  rt: Runtime,
  hooks: RuleHooks = {},
): { result: JournalResult; reexecute: boolean } {
  if (entry.state === 'running' && entry.selfTerminating && entry.bootId !== rt.bootId) {
    const result: JournalResult = { outcome: 'succeeded', rebooted: true, bootId: rt.bootId };
    const payload = hooks.rebootedPayload?.(entry);
    if (payload) result.payload = payload;
    return { result, reexecute: false };
  }
  if (entry.retrySafe) return { result: { outcome: 'succeeded' }, reexecute: true };
  return { result: { outcome: 'failed', reason: REASON_INTERRUPTED, bootId: rt.bootId }, reexecute: false };
}

function finish(journal: MemoryJournal, entry: JournalCommand, result: JournalResult, now: number): JournalCommand {
  const done: JournalCommand = { ...entry, state: 'done', result, resultAcked: false, updatedAt: now };
  journal.putCommand(done);
  return copy(done);
}
