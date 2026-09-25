// The fleet invariants of PLAN.md §15 as pure functions over collected facts. They know nothing
// about the simulator: the facts can come from the fleet sim, from a real-time harness, or from a
// Postgres snapshot (bookings) plus daemon reports (bindings).

/** Invariant ids of PLAN.md §15 that this module checks. */
export type InvariantId = 'I1' | 'I2' | 'I4' | 'I5' | 'I8';

export interface InvariantViolation {
  invariant: InvariantId;
  message: string;
  /** The allocation, command or node the violation is about. */
  subject: string;
}

// ---------------------------------------------------------------------------------------------
// I1: no overlapping bookings or node-reported assignments.

/** One `device_bookings` row: the atom is booked by `allocationId` over [start, end). */
export interface BookingRow {
  allocationId: string;
  deviceId: string;
  nodeId?: string;
  start: number;
  /** Exclusive; `Infinity` for an open range. */
  end: number;
}

/** A device set a node had bound (CDI hold) for an allocation over [from, to). */
export interface NodeBinding {
  nodeId: string;
  allocationId: string;
  deviceIds: readonly string[];
  from: number;
  /** Exclusive; undefined while still bound. */
  to?: number;
}

interface Interval {
  owner: string;
  start: number;
  end: number;
}

/** Pairs of intervals of different owners that overlap, per key. */
function overlaps(byKey: Map<string, Interval[]>): { key: string; a: Interval; b: Interval }[] {
  const found: { key: string; a: Interval; b: Interval }[] = [];
  for (const [key, intervals] of byKey) {
    const sorted = [...intervals]
      .filter((i) => i.end > i.start)
      .sort((x, y) => x.start - y.start || x.end - y.end);
    let widest: Interval | undefined;
    for (const interval of sorted) {
      if (widest && interval.start < widest.end && interval.owner !== widest.owner)
        found.push({ key, a: widest, b: interval });
      if (!widest || interval.end > widest.end) widest = interval;
    }
  }
  return found;
}

const push = <K, V>(map: Map<K, V[]>, key: K, value: V): void => {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
};

/**
 * I1. Bookings: no atom is booked by two allocations at one instant (what `EXCLUDE (device_id =,
 * during &&)` guarantees). Bindings: no node holds one device for two allocations at one instant,
 * and (when bookings are given) a node only binds devices its allocation booked.
 */
export function checkI1(input: {
  bookings?: readonly BookingRow[];
  bindings?: readonly NodeBinding[];
}): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  const bookings = input.bookings ?? [];
  const byDevice = new Map<string, Interval[]>();
  for (const row of bookings)
    push(byDevice, row.deviceId, { owner: row.allocationId, start: row.start, end: row.end });
  for (const { key, a, b } of overlaps(byDevice))
    violations.push({
      invariant: 'I1',
      subject: b.owner,
      message: `device ${key} is booked by ${a.owner} [${a.start}, ${a.end}) and ${b.owner} [${b.start}, ${b.end})`,
    });

  const byNodeDevice = new Map<string, Interval[]>();
  for (const binding of input.bindings ?? [])
    for (const deviceId of binding.deviceIds)
      push(byNodeDevice, `${binding.nodeId}/${deviceId}`, {
        owner: binding.allocationId,
        start: binding.from,
        end: binding.to ?? Infinity,
      });
  for (const { key, a, b } of overlaps(byNodeDevice))
    violations.push({
      invariant: 'I1',
      subject: b.owner,
      message: `node device ${key} is bound to ${a.owner} and ${b.owner} at once (from ${b.start})`,
    });

  if (input.bookings && input.bindings) {
    const booked = new Map<string, Set<string>>();
    for (const row of bookings) {
      const devices = booked.get(row.allocationId) ?? new Set<string>();
      devices.add(row.deviceId);
      booked.set(row.allocationId, devices);
    }
    for (const binding of input.bindings) {
      const devices = booked.get(binding.allocationId);
      const stray = binding.deviceIds.filter((id) => !devices?.has(id));
      if (stray.length > 0)
        violations.push({
          invariant: 'I1',
          subject: binding.allocationId,
          message: `node ${binding.nodeId} bound ${stray.join(', ')} for ${binding.allocationId}, which has no booking for ${stray.length === 1 ? 'it' : 'them'}`,
        });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------------------------
// I2: at most one execution per command; after a journal loss, non-retry-safe in-flight commands
// fail rather than replay.

/** A side-effect fact from a node (FakeDaemon facts, or a real daemon's audit trail). */
export interface ExecutionFact {
  phase: 'accepted' | 'started' | 'ended';
  at: number;
  nodeId: string;
  commandId: string;
  kind: string;
  retrySafe: boolean;
  selfTerminating: boolean;
  journalId: string;
  incarnation: string;
  bootId: string;
  /** For `ended`. */
  outcome?: string;
}

export interface JournalLossFact {
  nodeId: string;
  at: number;
  oldJournalId: string;
  newJournalId: string;
}

/** The control plane's terminal state of a command. */
export interface ServerOutcome {
  commandId: string;
  nodeId: string;
  /** `succeeded`, `failed`, `rejected`, `expired`, `cancelled`. */
  state: string;
  /** For `failed`: `journal-lost`, `interrupted`, `timeout`, … */
  errorCode?: string;
}

/**
 * I2 over execution facts:
 * - a non-retry-safe or self-terminating command starts its side effect at most once, ever;
 * - a retry-safe command is re-executed only after a crash interrupted it: never twice in one
 *   daemon process, and never again in the same journal once an execution ended;
 * - after a journal loss, a non-retry-safe command accepted in the lost journal but not ended there
 *   never starts in another journal, and (when outcomes are given) does not end `succeeded` on the
 *   control plane.
 */
export function checkI2(input: {
  executions: readonly ExecutionFact[];
  journalLosses?: readonly JournalLossFact[];
  outcomes?: readonly ServerOutcome[];
}): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  const byCommand = new Map<string, ExecutionFact[]>();
  for (const fact of input.executions) push(byCommand, fact.commandId, fact);
  for (const [commandId, facts] of byCommand) {
    facts.sort((a, b) => a.at - b.at);
    const first = facts[0]!;
    const starts = facts.filter((f) => f.phase === 'started');
    if (!first.retrySafe || first.selfTerminating) {
      if (starts.length > 1)
        violations.push({
          invariant: 'I2',
          subject: commandId,
          message: `${first.kind} ${commandId} (${first.selfTerminating ? 'self-terminating' : 'not retry-safe'}) started ${starts.length} times: ${starts.map((s) => `${s.nodeId}@${s.at} ${s.journalId}/${s.incarnation}`).join(', ')}`,
        });
      continue;
    }
    for (let i = 1; i < starts.length; i++) {
      const start = starts[i]!;
      const sameProcess = starts.slice(0, i).find((s) => s.incarnation === start.incarnation);
      if (sameProcess)
        violations.push({
          invariant: 'I2',
          subject: commandId,
          message: `${commandId} started twice in daemon process ${start.incarnation} (at ${sameProcess.at} and ${start.at})`,
        });
      const endedBefore = facts.find(
        (f) => f.phase === 'ended' && f.at <= start.at && f.journalId === start.journalId,
      );
      if (endedBefore)
        violations.push({
          invariant: 'I2',
          subject: commandId,
          message: `${commandId} ran again at ${start.at} after it ended at ${endedBefore.at} in the same journal ${start.journalId}`,
        });
    }
  }

  const outcomes = new Map((input.outcomes ?? []).map((o) => [o.commandId, o]));
  for (const loss of input.journalLosses ?? []) {
    for (const [commandId, facts] of byCommand) {
      const accepted = facts.find(
        (f) =>
          f.phase === 'accepted' &&
          f.nodeId === loss.nodeId &&
          f.journalId === loss.oldJournalId &&
          f.at <= loss.at,
      );
      if (!accepted || accepted.retrySafe || accepted.selfTerminating) continue;
      const ended = facts.some((f) => f.phase === 'ended' && f.journalId === loss.oldJournalId);
      if (ended) continue;
      const replay = facts.find(
        (f) => f.phase === 'started' && f.journalId !== loss.oldJournalId && f.at >= loss.at,
      );
      if (replay)
        violations.push({
          invariant: 'I2',
          subject: commandId,
          message: `${accepted.kind} ${commandId} was in flight when journal ${loss.oldJournalId} was lost and replayed in ${replay.journalId} at ${replay.at}`,
        });
      const outcome = outcomes.get(commandId);
      if (outcome?.state === 'succeeded')
        violations.push({
          invariant: 'I2',
          subject: commandId,
          message: `${commandId} was in flight when journal ${loss.oldJournalId} was lost but the control plane recorded it succeeded`,
        });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------------------------
// I5: no allocation released only because a node disconnected.

/** Why the control plane released an allocation. */
export interface ReleaseFact {
  allocationId: string;
  nodeId: string;
  at: number;
  reason: string;
}

/** A node's connectivity transition as the control plane recorded it. */
export interface ConnectivityFact {
  nodeId: string;
  at: number;
  state: 'connected' | 'disconnected' | 'unreachable' | 'lost';
}

/**
 * The release causes that never depend on connectivity (PLAN.md §10.5): `ends_at`, an explicit
 * `release` or `cancel`, a renewable lease that lapsed, and a failed bind.
 */
export const ALLOWED_RELEASE_REASONS: readonly string[] = [
  'ends-at',
  'release',
  'cancel',
  'lease-lapse',
  'bind-failed',
];

/**
 * I5: every release has an allowed cause. A release whose cause is not allowed and that happened
 * while (or right as) its node was disconnected, unreachable or lost is reported as caused by
 * connectivity.
 */
export function checkI5(input: {
  releases: readonly ReleaseFact[];
  connectivity?: readonly ConnectivityFact[];
  allowedReasons?: readonly string[];
}): InvariantViolation[] {
  const allowed = new Set(input.allowedReasons ?? ALLOWED_RELEASE_REASONS);
  const transitions = new Map<string, ConnectivityFact[]>();
  for (const fact of input.connectivity ?? []) push(transitions, fact.nodeId, fact);
  for (const list of transitions.values()) list.sort((a, b) => a.at - b.at);
  const stateAt = (nodeId: string, at: number): string => {
    let state = 'unknown';
    for (const fact of transitions.get(nodeId) ?? []) {
      if (fact.at > at) break;
      state = fact.state;
    }
    return state;
  };
  const violations: InvariantViolation[] = [];
  for (const release of input.releases) {
    if (allowed.has(release.reason)) continue;
    const state = stateAt(release.nodeId, release.at);
    violations.push({
      invariant: 'I5',
      subject: release.allocationId,
      message:
        state === 'disconnected' || state === 'unreachable' || state === 'lost'
          ? `${release.allocationId} was released (${release.reason}) while node ${release.nodeId} was ${state}`
          : `${release.allocationId} was released for a cause that is not allowed: ${release.reason}`,
    });
  }
  return violations;
}

// ---------------------------------------------------------------------------------------------
// I4: no liveness false positives.

/** Default I4 window: a node heard this recently was alive (liveness gives up only after ≥ 3 missed 10 s beats). */
export const LIVENESS_WINDOW_MS = 20_000;

/**
 * I4: the control plane never marks a node unreachable (or lost) that a gateway heard from within `windowMs`
 * before the mark. `heard` is ground truth from the transport: per node, the sorted times at which a gateway
 * received one of its frames. Gateway clock skew is covered because the check uses the simulator's clock, not the
 * gateway's.
 */
export function checkI4(input: {
  connectivity: readonly ConnectivityFact[];
  heard: ReadonlyMap<string, readonly number[]>;
  windowMs?: number;
}): InvariantViolation[] {
  const windowMs = input.windowMs ?? LIVENESS_WINDOW_MS;
  const violations: InvariantViolation[] = [];
  for (const fact of input.connectivity) {
    if (fact.state !== 'unreachable' && fact.state !== 'lost') continue;
    const times = input.heard.get(fact.nodeId);
    if (!times?.length) continue;
    // The last time heard at or before the mark (binary search over the sorted times).
    let low = 0;
    let high = times.length - 1;
    let last: number | undefined;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (times[middle]! <= fact.at) {
        last = times[middle];
        low = middle + 1;
      } else high = middle - 1;
    }
    if (last !== undefined && fact.at - last < windowMs)
      violations.push({
        invariant: 'I4',
        subject: fact.nodeId,
        message: `node ${fact.nodeId} was marked ${fact.state} at ${fact.at}, ${fact.at - last} ms after a gateway heard from it`,
      });
  }
  return violations;
}

// ---------------------------------------------------------------------------------------------
// I8: billing conservation.

/** One flushed usage record: `atoms` devices over [start, end). */
export interface UsageWindow {
  /** The usage sink's idempotency key. */
  key: string;
  allocationId: string;
  start: number;
  end: number;
  atoms: number;
}

/** A booked allocation as billing sees it: `atoms` devices over [start, end). */
export interface BilledAllocation {
  allocationId: string;
  start: number;
  /** When `during` ended (release truncates it); undefined while active. */
  end?: number;
  atoms: number;
}

/** Σ (end − start) × atoms. */
export const atomMilliseconds = (
  windows: readonly { start: number; end: number; atoms: number }[],
): number => windows.reduce((sum, w) => sum + Math.max(0, w.end - w.start) * w.atoms, 0);

/**
 * I8: Σ usage = Σ booking duration × atoms, with no duplicate keys. Per allocation, the windows
 * must not overlap, must stay within the booking, and (for a closed booking, or up to `flushedUpTo`
 * for an open one) must add up to exactly its atom-milliseconds. Usage for an unknown allocation is
 * a violation too.
 */
export function checkI8(input: {
  allocations: readonly BilledAllocation[];
  usage: readonly UsageWindow[];
  /** Open allocations are checked up to this time (every window before it must be flushed). */
  flushedUpTo?: number;
}): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  const keys = new Set<string>();
  const byAllocation = new Map<string, UsageWindow[]>();
  for (const window of input.usage) {
    if (keys.has(window.key))
      violations.push({
        invariant: 'I8',
        subject: window.allocationId,
        message: `duplicate usage key ${window.key}`,
      });
    keys.add(window.key);
    push(byAllocation, window.allocationId, window);
  }
  const known = new Set(input.allocations.map((a) => a.allocationId));
  for (const id of byAllocation.keys())
    if (!known.has(id))
      violations.push({
        invariant: 'I8',
        subject: id,
        message: `usage recorded for unknown allocation ${id}`,
      });
  for (const allocation of input.allocations) {
    const windows = [...(byAllocation.get(allocation.allocationId) ?? [])].sort(
      (a, b) => a.start - b.start,
    );
    const end = allocation.end ?? input.flushedUpTo;
    if (end === undefined) continue;
    let cursor = allocation.start;
    for (const window of windows) {
      if (
        window.start < cursor ||
        window.end > (allocation.end ?? Infinity) ||
        window.atoms !== allocation.atoms
      )
        violations.push({
          invariant: 'I8',
          subject: allocation.allocationId,
          message: `usage window ${window.key} [${window.start}, ${window.end}) x${window.atoms} overlaps or leaves booking [${allocation.start}, ${allocation.end ?? '∞'}) x${allocation.atoms}`,
        });
      cursor = Math.max(cursor, window.end);
    }
    const billed = atomMilliseconds(windows.filter((w) => w.start < end));
    const booked = Math.max(0, end - allocation.start) * allocation.atoms;
    if (billed !== booked)
      violations.push({
        invariant: 'I8',
        subject: allocation.allocationId,
        message: `${allocation.allocationId} billed ${billed} atom-ms but booked ${booked} atom-ms up to ${end}`,
      });
  }
  return violations;
}

/** Throws one error listing every violation (at most `limit` lines); does nothing when empty. */
export function assertInvariants(violations: readonly InvariantViolation[], limit = 20): void {
  if (violations.length === 0) return;
  const lines = violations.slice(0, limit).map((v) => `${v.invariant} ${v.subject}: ${v.message}`);
  if (violations.length > limit) lines.push(`… and ${violations.length - limit} more`);
  throw new Error(`${violations.length} invariant violation(s):\n${lines.join('\n')}`);
}
