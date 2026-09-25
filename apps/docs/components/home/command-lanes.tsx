'use client';

import { useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { AnimatePresence, motion, useInView } from 'motion/react';
import {
  RiAddLine,
  RiFileList3Line,
  RiLinkM,
  RiLinkUnlinkM,
  RiPulseLine,
  RiRefreshLine,
  RiScissorsCutLine,
  RiShutDownLine,
  RiStackLine,
  RiSubtractLine,
} from 'react-icons/ri';
import { cx } from '@/utils/cx';
import { DiagramFrame, PlayToggle, ReplayButton } from './frame';
import { ease, useReducedMotionSafe } from './motion';

/**
 * Desired state and commands over one gateway session (PLAN.md §7.2-7.5, §7.8), simulated in the browser.
 *
 * The model follows the code, not just the plan: the gateway half mirrors packages/gateway (the Hello transaction
 * with its self-terminating and journal-lost rules, dispatch by lane credit in seq order, BUSY back to `pending`
 * with a 1 s → 30 s back-off, heartbeat credit resync, epoch-fenced disconnect and liveness writes) and the node
 * half mirrors the FakeDaemon of @better-compute/testing (the journal and its resolve/recover rules, the
 * acceptance checks, lane credits and worker pools, reboot as a self-terminating kind, full-jitter redial). Kinds,
 * lanes, flags, durations and timers are the real ones; wall-clock time is compressed between events.
 */

// ---- protocol facts ---------------------------------------------------------------------------

type Lane = 'control' | 'provision' | 'bulk';
type Kind = 'diag.nvml' | 'inventory.refresh' | 'logs.collect' | 'node.reboot';
type DbState =
  | 'pending'
  | 'dispatched'
  | 'acked'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'rejected'
  | 'expired'
  | 'cancelled';
type Verb = 'dispatch' | 'busy' | 'ack' | 'start' | 'succeed' | 'fail' | 'reject';
type Connectivity = 'connected' | 'disconnected' | 'unreachable';
type GwId = 'a' | 'b';
type Weight = 'solid' | 'outline' | 'dashed' | 'hatch';
type FrameRow = 'session' | 'spec' | Lane;
type Glyph = 'down' | 'up' | 'cp' | 'gw' | 'node';
type Icon = ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;

/** The v0.1 kinds a `node` agent runs (generated/command-kinds.json; run times from the FakeDaemon). */
const KINDS: Record<
  Kind,
  {
    lane: Lane;
    retrySafe: boolean;
    selfTerminating: boolean;
    destructive: boolean;
    attested: boolean;
    timeout: string;
    runMs: number;
    icon: Icon;
  }
> = {
  'diag.nvml': {
    lane: 'control',
    retrySafe: true,
    selfTerminating: false,
    destructive: false,
    attested: true,
    timeout: '2m',
    runMs: 2_000,
    icon: RiPulseLine,
  },
  'inventory.refresh': {
    lane: 'control',
    retrySafe: true,
    selfTerminating: false,
    destructive: false,
    attested: false,
    timeout: '2m',
    runMs: 500,
    icon: RiRefreshLine,
  },
  'logs.collect': {
    lane: 'bulk',
    retrySafe: true,
    selfTerminating: false,
    destructive: false,
    attested: false,
    timeout: '15m',
    runMs: 5_000,
    icon: RiFileList3Line,
  },
  // commands.run sends delay_ms 0: the daemon journals running{boot_id} and reboots at once.
  'node.reboot': {
    lane: 'control',
    retrySafe: true,
    selfTerminating: true,
    destructive: true,
    attested: false,
    timeout: '15m',
    runMs: 0,
    icon: RiShutDownLine,
  },
};

const LANES: readonly Lane[] = ['control', 'provision', 'bulk'];
/** Welcome credits (§7.5) and the daemon's worker pools (§6 "Internals"). */
const CREDITS: Record<Lane, number> = { control: 8, provision: 4, bulk: 2 };
const WORKERS: Record<Lane, number> = { control: 4, provision: 2, bulk: 1 };

const TERMINAL: ReadonlySet<DbState> = new Set([
  'succeeded',
  'failed',
  'rejected',
  'expired',
  'cancelled',
]);
const IN_FLIGHT: ReadonlySet<DbState> = new Set(['dispatched', 'acked', 'running']);
/** The slice of core's commandStateTable this model exercises. */
const TRANSITIONS: Partial<Record<DbState, Partial<Record<Verb, DbState>>>> = {
  pending: { dispatch: 'dispatched' },
  dispatched: {
    dispatch: 'dispatched',
    busy: 'pending',
    ack: 'acked',
    start: 'running',
    succeed: 'succeeded',
    fail: 'failed',
    reject: 'rejected',
  },
  acked: { start: 'running', succeed: 'succeeded', fail: 'failed' },
  running: { succeed: 'succeeded', fail: 'failed' },
};

/** One-way wire latency in the model (not a protocol number). */
const LAT = 500;
/** The post-commit poke that wakes the node's gateway. */
const POKE = 50;
const HEARTBEAT = 10_000;
/** Three missed heartbeats close a session. */
const HB_TIMEOUT = 3 * HEARTBEAT;
const FLUSH = 15_000;
/** disconnected → unreachable after the 40 s lease TTL (plus grace after a gateway loss). */
const LEASE_TTL = 40_000;
/** The FakeDaemon's default rebootDurationMs. */
const REBOOT = 60_000;
/** commands.run's default notAfterSeconds (600). */
const NOT_AFTER = 600_000;
const BUSY_MIN = 1_000;
const BUSY_MAX = 30_000;
const REDIAL_MIN = 1_000;
const REDIAL_MAX = 60_000;
const GPUS = 8;

const NODE_ID = 'node_01k9x3m8q2c7vb5r0dh4sa6e1t';
const GW_IDS: Record<GwId, string> = {
  a: 'gw_01k9x1c4n7p2r5t8v0w3y6za9b',
  b: 'gw_01k9x1c4q8s1v4x7z0b3d6fh2j',
};
const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';
const HEX = '0123456789abcdef';

/** `gw_01k9…za9b` → `gw_…za9b`. */
const tail = (id: string, keep = 4) => `${id.slice(0, id.indexOf('_') + 1)}…${id.slice(-keep)}`;
const gwName = (gw: GwId) => tail(GW_IDS[gw]);
const other = (gw: GwId): GwId => (gw === 'a' ? 'b' : 'a');
const zero = (): Record<Lane, number> => ({ control: 0, provision: 0, bulk: 0 });
const seconds = (ms: number) => `${Math.max(0, Math.ceil(ms / 1000))} s`;
const list = (seqs: number[]) => seqs.map((seq) => `#${seq}`).join(', ');

/**
 * Real time between two events: proportional for the short gaps that carry the story (frames, runs), compressed
 * for idle stretches (heartbeats, a 60 s reboot, back-off).
 */
function pace(gap: number): number {
  if (gap <= 0) return 0;
  return Math.round(
    Math.min(1700, Math.min(gap, 1000) * 0.75 + Math.max(0, gap - 1000) * 0.12),
  );
}
const FRAME_S = pace(LAT) / 1000;

function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- model -------------------------------------------------------------------------------------

interface Row {
  id: string;
  seq: number;
  kind: Kind;
  lane: Lane;
  state: DbState;
  reason: string | null;
  epoch: number | null;
  attempt: number;
  notBefore: number;
  notAfter: number;
  /** Its last Command frame went into a dead stream. */
  lost: boolean;
  /** Its last answer was BUSY (never journaled). */
  busy: boolean;
  /** The gateway already said it holds this row for lack of credit. */
  heldNoted: boolean;
}

interface Entry {
  id: string;
  seq: number;
  kind: Kind;
  state: 'accepted' | 'running' | 'done';
  bootId: string | null;
  incarnation: number;
  outcome: 'succeeded' | 'failed' | 'rejected' | null;
  reason: string | null;
  rebooted: boolean;
  acked: boolean;
}

interface Exec {
  id: string;
  seq: number;
  kind: Kind;
  lane: Lane;
  phase: 'queued' | 'running';
  start: number;
  end: number;
}

interface Alloc {
  id: string;
  gpus: number[];
}

interface Conn {
  id: number;
  gw: GwId;
  daemonOpen: boolean;
  gwOpen: boolean;
}

/** A session as one gateway process holds it in memory. */
interface GSession {
  gw: GwId;
  conn: number;
  epoch: number;
  used: Record<Lane, number>;
  inFlight: Map<string, Lane>;
  busyCount: Map<string, number>;
  lastSeen: number;
  closed: boolean;
  sentGeneration: number;
  applied: number;
}

interface Body {
  id: string;
  seq: number;
  kind: Kind;
  lane: Lane;
  attempt: number;
  notAfter: number;
}

interface Update {
  id: string;
  state: 'ACKED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'REJECTED';
  reject?: 'BUSY' | 'EXPIRED';
  code?: string;
  rebooted?: boolean;
}

interface Hello {
  bootId: string;
  journalId: string;
  applied: number;
  unacked: Update[];
  running: string[];
}

interface Daemon {
  status: 'running' | 'rebooting';
  bootId: string;
  incarnation: number;
  journalId: string;
  lastEpoch: number;
  applied: number;
  observed: number;
  spec: Alloc[];
  holds: Alloc[];
  eventSeq: number;
  eventsAcked: number;
  entries: Map<string, Entry>;
  execs: Map<string, Exec>;
  queues: Record<Lane, string[]>;
  busyWorkers: Record<Lane, number>;
  inUse: Record<Lane, number>;
  session: { conn: number; gw: GwId; welcomed: boolean; epoch: number; credits: Record<Lane, number> } | null;
  redialAttempt: number;
  redialAt: number | null;
  rebootUntil: number | null;
}

interface Frame {
  id: number;
  row: FrameRow;
  dir: 'down' | 'up';
  label: string;
  weight: Weight;
  sentAt: number;
  arriveAt: number;
  lost: boolean;
  lostAt: number | null;
}

interface LogLine {
  id: number;
  at: number;
  glyph: Glyph;
  text: string;
}

const verbOf = (update: Update): Verb =>
  update.state === 'ACKED'
    ? 'ack'
    : update.state === 'RUNNING'
      ? 'start'
      : update.state === 'SUCCEEDED'
        ? 'succeed'
        : update.state === 'FAILED'
          ? 'fail'
          : update.reject === 'BUSY'
            ? 'busy'
            : 'reject';

/** Terminal updates are journaled until acked; BUSY is a refusal, not a result. */
const isTerminal = (update: Update) =>
  (update.state === 'SUCCEEDED' || update.state === 'FAILED' || update.state === 'REJECTED') &&
  update.reject !== 'BUSY';

const reasonOf = (update: Update): string | null =>
  update.state === 'FAILED'
    ? (update.code ?? 'failed')
    : update.state === 'REJECTED'
      ? (update.reject ?? 'unspecified').toLowerCase().replace(/_/g, '-')
      : update.rebooted
        ? 'rebooted'
        : null;

const updateOf = (entry: Entry): Update =>
  entry.outcome === 'failed'
    ? { id: entry.id, state: 'FAILED', code: entry.reason ?? 'internal' }
    : entry.outcome === 'rejected'
      ? { id: entry.id, state: 'REJECTED', reject: 'EXPIRED' }
      : { id: entry.id, state: 'SUCCEEDED', rebooted: entry.rebooted };

class Sim {
  now = 0;
  caption =
    'One live session. Desired state is a generation the node converges to; commands are one-shot rows that ride per-kind lanes. Run one, cut the link, reboot the node, or fill the bulk lane.';
  linkUp = true;
  fillArmed = false;

  private timers: { at: number; order: number; run: () => void }[] = [];
  private order = 0;
  private rand: () => number;
  private frameId = 0;
  private logId = 0;
  private connId = 0;
  private conns = new Map<number, Conn>();
  private lostHooks = new Map<number, () => void>();
  private dispatchAt: Record<GwId, number | null> = { a: null, b: null };
  private nextGw: GwId = 'b';

  // Control plane (Postgres).
  generation = 1;
  cpObserved = 1;
  allocs: Alloc[] = [];
  generations: number[] = [1];
  appliedGenerations = new Set<number>([1]);
  rows: Row[] = [];
  nextSeq = 1;
  ns: {
    gw: GwId | null;
    epoch: number;
    connectivity: Connectivity;
    bootId: string;
    journalId: string;
    ackedEventSeq: number;
    disconnectedAt: number | null;
  };
  // Gateways (one in-memory session map each).
  gws: Record<GwId, GSession | null> = { a: null, b: null };
  frames: Frame[] = [];
  log: LogLine[] = [];
  d: Daemon;

  constructor(seed = 20260924) {
    this.rand = mulberry32(seed);
    const bootId = this.hex(8);
    const journalId = `jrn_${this.hex(32)}`;
    this.d = {
      status: 'running',
      bootId,
      incarnation: 1,
      journalId,
      lastEpoch: 1,
      applied: 1,
      observed: 1,
      spec: [],
      holds: [],
      eventSeq: 0,
      eventsAcked: 0,
      entries: new Map(),
      execs: new Map(),
      queues: { control: [], provision: [], bulk: [] },
      busyWorkers: zero(),
      inUse: zero(),
      session: null,
      redialAttempt: 0,
      redialAt: null,
      rebootUntil: null,
    };
    this.ns = {
      gw: 'a',
      epoch: 1,
      connectivity: 'connected',
      bootId,
      journalId,
      ackedEventSeq: 0,
      disconnectedAt: null,
    };
    // The acceptance run that adopted the node (§3.3 step 7: diag.nvml in v0.1), long settled.
    const acceptance = this.newRow('diag.nvml');
    Object.assign(acceptance, { state: 'succeeded', epoch: 1, attempt: 1 });
    this.d.entries.set(acceptance.id, {
      id: acceptance.id,
      seq: acceptance.seq,
      kind: 'diag.nvml',
      state: 'done',
      bootId,
      incarnation: 1,
      outcome: 'succeeded',
      reason: null,
      rebooted: false,
      acked: true,
    });
    // A session already welcomed on gateway a at epoch 1.
    const conn = this.openConn('a');
    const session: GSession = {
      gw: 'a',
      conn: conn.id,
      epoch: 1,
      used: zero(),
      inFlight: new Map(),
      busyCount: new Map(),
      lastSeen: 0,
      closed: false,
      sentGeneration: 1,
      applied: 1,
    };
    this.gws.a = session;
    this.d.session = { conn: conn.id, gw: 'a', welcomed: true, epoch: 1, credits: { ...CREDITS } };
    this.scheduleBeat(conn.id, 2_000);
    this.scheduleHbCheck(session);
  }

  // ---- clock ----------------------------------------------------------------------------------

  peek(): number | null {
    let next: number | null = null;
    for (const timer of this.timers) if (next === null || timer.at < next) next = timer.at;
    return next;
  }

  advanceTo(time: number) {
    for (;;) {
      let best = -1;
      for (let index = 0; index < this.timers.length; index++) {
        const timer = this.timers[index]!;
        if (timer.at > time) continue;
        const current = best < 0 ? undefined : this.timers[best]!;
        if (!current || timer.at < current.at || (timer.at === current.at && timer.order < current.order))
          best = index;
      }
      if (best < 0) break;
      const [timer] = this.timers.splice(best, 1);
      this.now = timer!.at;
      timer!.run();
    }
    this.now = Math.max(this.now, time);
    this.frames = this.frames.filter((frame) => frame.arriveAt > this.now);
  }

  private at(time: number, run: () => void) {
    this.timers.push({ at: Math.max(time, this.now), order: this.order++, run });
  }

  /** The gateway's dispatch loop runs every second; this is its next turn. */
  private tick(time: number) {
    return Math.ceil(time / 1000) * 1000;
  }

  private hex(length: number) {
    let out = '';
    for (let index = 0; index < length; index++) out += HEX[Math.floor(this.rand() * 16)];
    return out;
  }

  private b32(length: number) {
    let out = '';
    for (let index = 0; index < length; index++) out += CROCKFORD[Math.floor(this.rand() * 32)];
    return out;
  }

  private say(text: string) {
    this.caption = text;
  }

  private write(glyph: Glyph, text: string) {
    this.log.push({ id: this.logId++, at: this.now, glyph, text });
    if (this.log.length > 30) this.log.shift();
  }

  // ---- transport ------------------------------------------------------------------------------

  private openConn(gw: GwId): Conn {
    const conn: Conn = { id: this.connId++, gw, daemonOpen: true, gwOpen: true };
    this.conns.set(conn.id, conn);
    return conn;
  }

  private frame(
    conn: Conn,
    dir: 'down' | 'up',
    row: FrameRow,
    label: string,
    weight: Weight,
    deliver: () => void,
    onLost?: () => void,
  ) {
    const open = dir === 'down' ? conn.daemonOpen : conn.gwOpen;
    const lost = !this.linkUp || !open;
    const frame: Frame = {
      id: this.frameId++,
      row,
      dir,
      label,
      weight,
      sentAt: this.now,
      arriveAt: this.now + LAT,
      lost,
      lostAt: lost ? this.now : null,
    };
    this.frames.push(frame);
    if (lost) onLost?.();
    else if (onLost) this.lostHooks.set(frame.id, onLost);
    this.at(frame.arriveAt, () => {
      this.lostHooks.delete(frame.id);
      const stillOpen = dir === 'down' ? conn.daemonOpen : conn.gwOpen;
      if (frame.lost) return;
      if (!stillOpen) {
        onLost?.();
        return;
      }
      deliver();
    });
  }

  /** A ServerFrame on a gateway's session stream. */
  private gsend(s: GSession, row: FrameRow, label: string, weight: Weight, deliver: () => void, onLost?: () => void) {
    const conn = this.conns.get(s.conn)!;
    this.frame(
      conn,
      'down',
      row,
      label,
      weight,
      () => {
        const session = this.d.session;
        if (session && session.conn === conn.id && this.d.status === 'running') deliver();
      },
      onLost,
    );
  }

  /** An AgentFrame from bcd; nothing leaves before Welcome or without a session (the journal keeps it). */
  private dsend(row: FrameRow, label: string, weight: Weight, deliver: (s: GSession) => void): boolean {
    const session = this.d.session;
    if (!session || !session.welcomed || this.d.status !== 'running') return false;
    const conn = this.conns.get(session.conn)!;
    if (!conn.daemonOpen) return false;
    this.frame(conn, 'up', row, label, weight, () => {
      const s = this.gws[conn.gw];
      if (s && !s.closed && s.conn === conn.id) deliver(s);
    });
    return true;
  }

  // ---- control plane ----------------------------------------------------------------------------

  private newRow(kind: Kind): Row {
    const seq = this.nextSeq++;
    const row: Row = {
      id: `cmd_01k9x${this.b32(21)}`,
      seq,
      kind,
      lane: KINDS[kind].lane,
      state: 'pending',
      reason: null,
      epoch: null,
      attempt: 0,
      notBefore: this.now,
      notAfter: this.now + NOT_AFTER,
      lost: false,
      busy: false,
      heldNoted: false,
    };
    this.rows.push(row);
    return row;
  }

  /** The session that routes the node: `node_sessions.gateway_id` and its epoch, as that gateway holds it. */
  routing(): GSession | null {
    const gw = this.ns.gw;
    if (!gw) return null;
    const s = this.gws[gw];
    return s && !s.closed && s.epoch === this.ns.epoch ? s : null;
  }

  run(kind: Kind) {
    const row = this.newRow(kind);
    this.write('cp', `commands row #${row.seq} ${kind} · pending · ${row.lane} lane`);
    this.say(
      this.routing()
        ? `#${row.seq} ${kind} is a pending row in Postgres. The gateway sends it while the ${row.lane} lane has credit, in seq order.`
        : `#${row.seq} ${kind} waits as a pending row: no gateway holds a session for the node, so nothing is sent.`,
    );
    if (this.ns.gw) this.wake(this.ns.gw, this.now + POKE);
  }

  /** Three logs.collect, landing while a heartbeat that still shows the bulk lane free is on the wire. */
  fill() {
    if (this.sessionLive()) {
      this.fillArmed = true;
      this.say(
        'Three logs.collect for the bulk lane (2 credits, 1 worker) will leave Postgres just as bcd sends its next heartbeat.',
      );
    } else this.fillNow();
  }

  private fillNow() {
    const seqs: number[] = [];
    for (let index = 0; index < 3; index++) seqs.push(this.newRow('logs.collect').seq);
    this.write('cp', `commands rows ${list(seqs)} logs.collect · pending · bulk lane`);
    this.say(
      `${list(seqs)} are pending. The gateway sends two, which is all the bulk lane's credit, and holds the third in Postgres.`,
    );
    if (this.ns.gw) this.wake(this.ns.gw, this.now + POKE);
  }

  book() {
    const taken = new Set(this.allocs.flatMap((alloc) => alloc.gpus));
    const free = Array.from({ length: GPUS }, (_, index) => index).filter((index) => !taken.has(index));
    if (free.length < 2) return;
    const alloc: Alloc = { id: `alloc_01k9x${this.b32(21)}`, gpus: free.slice(0, 2) };
    this.allocs.push(alloc);
    this.bump(`reservations.create → ${tail(alloc.id)} · 2 GPUs`, 'create');
  }

  release() {
    const alloc = this.allocs.shift();
    if (!alloc) return;
    this.bump(`reservations.release → ${tail(alloc.id)}`, 'release');
  }

  private bump(text: string, verb: 'create' | 'release') {
    this.generation += 1;
    this.generations.push(this.generation);
    this.write('cp', `${text} · NodeSpec generation ${this.generation}`);
    const live = this.sessionLive();
    this.say(
      live
        ? `reservations.${verb} changed the canonical spec, so NodeSpec moves to generation ${this.generation}. The gateway pushes the full spec; bcd converges it and reports observed_generation.`
        : `Generation ${this.generation} waits in Postgres while the node enforces generation ${this.d.applied}. Desired state is level-triggered: only the latest spec will be sent.`,
    );
    if (this.ns.gw) this.at(this.now + POKE, () => this.pushSpecs());
  }

  /** gateway pushSpecs: a full spec to a session whose node moved past what it holds and was sent. */
  private pushSpecs() {
    const s = this.routing();
    if (!s) return;
    const generation = this.generation;
    if (generation <= s.sentGeneration || generation <= s.applied) return;
    s.sentGeneration = generation;
    const spec = this.allocs.map((alloc) => ({ id: alloc.id, gpus: [...alloc.gpus] }));
    this.write('down', `DesiredState generation ${generation} · full`);
    this.gsend(
      s,
      'spec',
      `DesiredState g${generation}`,
      'solid',
      () => this.onDesired(generation, spec),
      () =>
        this.say(
          `DesiredState g${generation} was lost with the stream. Nothing to replay: the next Hello sends whatever generation is current.`,
        ),
    );
  }

  // ---- gateway ----------------------------------------------------------------------------------

  private wake(gw: GwId, time: number) {
    const current = this.dispatchAt[gw];
    if (current !== null && current <= time) return;
    this.dispatchAt[gw] = time;
    this.at(time, () => {
      if (this.dispatchAt[gw] !== time) return;
      this.dispatchAt[gw] = null;
      this.dispatch(gw);
    });
  }

  /** Dispatch by join: pending rows of nodes this gateway routes, in seq order, while the lane has credit. */
  private dispatch(gw: GwId) {
    const s = this.gws[gw];
    if (!s || s.closed || this.ns.gw !== gw || s.epoch !== this.ns.epoch) return;
    const pending = this.rows.filter((row) => row.state === 'pending').sort((a, b) => a.seq - b.seq);
    const blocked = new Set<Lane>();
    let later = Number.POSITIVE_INFINITY;
    for (const row of pending) {
      if (row.notBefore > this.now) {
        later = Math.min(later, row.notBefore);
        continue;
      }
      if (row.notAfter <= this.now) continue;
      // Per-lane order: once a lane is out of credit, later commands of that lane wait.
      if (blocked.has(row.lane) || !this.reserve(s, row)) {
        blocked.add(row.lane);
        if (!row.heldNoted) {
          row.heldNoted = true;
          this.write('gw', `#${row.seq} held: ${s.used[row.lane]}/${CREDITS[row.lane]} ${row.lane} credits in flight`);
          this.say(
            `#${row.seq} stays pending in Postgres: the gateway counts ${s.used[row.lane]} of ${CREDITS[row.lane]} ${row.lane} credits in flight.`,
          );
        }
        continue;
      }
      row.state = 'dispatched';
      row.epoch = s.epoch;
      row.attempt += 1;
      row.lost = false;
      row.busy = false;
      this.sendCommand(s, row);
    }
    if (later < Number.POSITIVE_INFINITY) this.wake(gw, this.tick(later));
  }

  private sendCommand(s: GSession, row: Row) {
    const body: Body = {
      id: row.id,
      seq: row.seq,
      kind: row.kind,
      lane: row.lane,
      attempt: Math.max(1, row.attempt),
      notAfter: row.notAfter,
    };
    this.write('down', `Command #${row.seq} ${row.kind} · attempt ${body.attempt} · epoch ${s.epoch}`);
    this.gsend(
      s,
      row.lane,
      `Command #${row.seq}`,
      'outline',
      () => this.onCommand(body),
      () => {
        if (row.state !== 'dispatched' || row.attempt !== body.attempt) return;
        row.lost = true;
        this.say(
          `#${row.seq} went out at epoch ${s.epoch} into a dead stream. Postgres still says dispatched; the next Hello replays it.`,
        );
      },
    );
  }

  private reserve(s: GSession, row: Row): boolean {
    if (s.inFlight.has(row.id)) return true;
    if (s.used[row.lane] >= CREDITS[row.lane]) return false;
    s.used[row.lane] += 1;
    s.inFlight.set(row.id, row.lane);
    return true;
  }

  /** Counts a command already on the daemon, even past the limit (heartbeats resync). */
  private reserveUnchecked(s: GSession, row: Row) {
    if (s.inFlight.has(row.id)) return;
    s.inFlight.set(row.id, row.lane);
    s.used[row.lane] += 1;
  }

  private releaseCredit(s: GSession, id: string) {
    const lane = s.inFlight.get(id);
    if (lane === undefined) return;
    s.inFlight.delete(id);
    s.used[lane] = Math.max(0, s.used[lane] - 1);
  }

  /** Results are facts: accepted from any epoch, deduplicated by the state table. */
  private gwUpdate(s: GSession, update: Update) {
    const row = this.rows.find((candidate) => candidate.id === update.id);
    const verb = verbOf(update);
    const to = row ? TRANSITIONS[row.state]?.[verb] : undefined;
    if (row && to) {
      if (verb === 'busy') {
        const count = (s.busyCount.get(update.id) ?? 0) + 1;
        s.busyCount.set(update.id, count);
        const backoff = Math.min(BUSY_MAX, BUSY_MIN * 2 ** (count - 1));
        Object.assign(row, { state: 'pending', epoch: null, notBefore: this.now + backoff, busy: true });
        this.releaseCredit(s, update.id);
        this.write('cp', `#${row.seq} BUSY → pending · not_before now + ${backoff / 1000} s`);
        this.say(
          `#${row.seq} reached bcd with no ${row.lane} credit left: REJECTED{BUSY}, never journaled. The gateway puts it back to pending with not_before +${backoff / 1000} s (1 s → 30 s). Nothing is dropped.`,
        );
        this.wake(s.gw, this.tick(row.notBefore));
      } else {
        row.state = to;
        row.reason = reasonOf(update);
        row.busy = false;
        if (TERMINAL.has(to)) s.busyCount.delete(update.id);
      }
    }
    if (isTerminal(update)) {
      this.releaseCredit(s, update.id);
      this.gsend(s, row?.lane ?? 'control', `Ack #${row?.seq ?? '?'}`, 'dashed', () => this.onAck([update.id], null));
      if (this.rows.some((candidate) => candidate.state === 'pending'))
        this.wake(s.gw, this.tick(this.now + 1));
    }
  }

  private gwHeartbeat(s: GSession, free: Record<Lane, number>, applied: number) {
    s.lastSeen = this.now;
    s.applied = Math.max(s.applied, applied);
    for (const lane of LANES) {
      const next = Math.min(CREDITS[lane], Math.max(0, CREDITS[lane] - free[lane]));
      const before = s.used[lane];
      s.used[lane] = next;
      const waiting = this.rows.some((row) => row.state === 'pending' && row.lane === lane);
      if (next < before && waiting) {
        this.write('gw', `Heartbeat resync: ${lane} ${before} → ${next} in flight`);
        this.say(
          `A heartbeat bcd sent before the burst landed says ${lane}: ${free[lane]} free. The gateway resyncs its count from it, so it will send more than bcd can hold right now.`,
        );
        this.wake(s.gw, this.tick(this.now + 1));
      }
    }
  }

  private gwEvents(s: GSession, upTo: number) {
    this.ns.ackedEventSeq = Math.max(this.ns.ackedEventSeq, upTo);
    this.gsend(s, 'spec', `Ack seq ${upTo}`, 'dashed', () => this.onAck([], upTo));
  }

  private gwStatus(s: GSession, observed: number, applied: number) {
    s.applied = Math.max(s.applied, applied);
    if (observed > this.cpObserved) {
      this.cpObserved = observed;
      this.write('cp', `nodes.observed_generation = GREATEST(…, ${observed})`);
    }
  }

  /** The Hello transaction (§7.2), then Welcome, results' Ack, DesiredState and the replay, in that order. */
  private gwHello(gw: GwId, conn: Conn, hello: Hello) {
    const prior = { ...this.ns };
    const bootChanged = prior.bootId !== hello.bootId;
    const journalChanged = prior.journalId !== hello.journalId;
    this.ns.epoch += 1;
    const epoch = this.ns.epoch;
    Object.assign(this.ns, { gw, bootId: hello.bootId, journalId: hello.journalId, disconnectedAt: null });
    if (journalChanged) this.ns.ackedEventSeq = 0;
    this.write('cp', `Hello tx: session_epoch ${prior.epoch} → ${epoch} · gateway_id ${gwName(gw)}`);
    const parts = [`Hello on ${gwName(gw)} bumps the epoch ${prior.epoch} → ${epoch}.`];

    // 1. A new boot completes in-flight self-terminating commands; never replayed.
    if (bootChanged)
      for (const row of this.rows)
        if (IN_FLIGHT.has(row.state) && KINDS[row.kind].selfTerminating) {
          Object.assign(row, { state: 'succeeded', reason: 'rebooted' });
          this.write('cp', `#${row.seq} ${row.kind} → succeeded · reason rebooted (new boot_id)`);
          parts.push(`#${row.seq} ${row.kind} is settled succeeded{rebooted} by the new boot_id.`);
        }
    // 2. A lost journal fails in-flight commands that are unsafe to run twice (none of this node's kinds).
    if (journalChanged)
      for (const row of this.rows)
        if (IN_FLIGHT.has(row.state) && !KINDS[row.kind].retrySafe)
          Object.assign(row, { state: 'failed', reason: 'journal-lost' });

    const ackIds: string[] = [];
    const settled: number[] = [];
    for (const update of hello.unacked) {
      const row = this.rows.find((candidate) => candidate.id === update.id);
      const to = row ? TRANSITIONS[row.state]?.[verbOf(update)] : undefined;
      if (row && to) {
        row.state = to;
        row.reason = reasonOf(update);
        settled.push(row.seq);
      }
      if (isTerminal(update)) ackIds.push(update.id);
    }
    if (settled.length)
      parts.push(`${list(settled)} came back in unacked_results and ${settled.length > 1 ? 'are' : 'is'} stored and acked.`);
    else if (ackIds.length) parts.push('The replayed results were already stored: deduplicated by command_id and acked.');

    const running = new Set(hello.running);
    const held = this.rows.filter((row) => IN_FLIGHT.has(row.state)).sort((a, b) => a.seq - b.seq);
    for (const row of held) {
      row.epoch = epoch;
      if (!running.has(row.id)) row.attempt += 1;
    }
    const replay = held.filter((row) => !running.has(row.id));
    const still = held.filter((row) => running.has(row.id));
    if (still.length) parts.push(`${list(still.map((row) => row.seq))} still running on the node: not re-sent.`);
    if (replay.length)
      parts.push(`${list(replay.map((row) => row.seq))} replayed in seq order (attempt ${replay[0]!.attempt}); the journal dedupes.`);

    if (this.ns.connectivity !== 'connected') {
      const was = this.ns.connectivity;
      this.ns.connectivity = 'connected';
      this.write('cp', `node.connected${was === 'unreachable' ? ' · unreachable cleared' : ''}`);
    }
    const previous = this.gws[gw];
    if (previous && !previous.closed) this.terminate(previous, 'superseded', false);
    const s: GSession = {
      gw,
      conn: conn.id,
      epoch,
      used: zero(),
      inFlight: new Map(),
      busyCount: new Map(),
      lastSeen: this.now,
      closed: false,
      sentGeneration: 0,
      applied: hello.applied,
    };
    this.gws[gw] = s;
    for (const row of [...still, ...replay]) this.reserveUnchecked(s, row);

    const acked = this.ns.ackedEventSeq;
    this.write('down', `Welcome · epoch ${epoch} · credits control 8, provision 4, bulk 2`);
    this.gsend(s, 'session', `Welcome e${epoch}`, 'solid', () => this.onWelcome(conn.id, epoch, acked));
    if (ackIds.length) this.gsend(s, 'session', `Ack ×${ackIds.length}`, 'dashed', () => this.onAck(ackIds, null));
    if (hello.applied < this.generation) {
      const generation = this.generation;
      const spec = this.allocs.map((alloc) => ({ id: alloc.id, gpus: [...alloc.gpus] }));
      const skipped = this.generations.filter((g) => g > hello.applied && g < generation);
      s.sentGeneration = generation;
      this.write('down', `DesiredState generation ${generation} · full`);
      this.gsend(s, 'spec', `DesiredState g${generation}`, 'solid', () => this.onDesired(generation, spec));
      parts.push(
        `One full DesiredState moves the node from g${hello.applied} to g${generation}${skipped.length ? `; g${skipped.join(', g')} never ${skipped.length > 1 ? 'reach' : 'reaches'} it` : ''}.`,
      );
    } else s.sentGeneration = this.generation;
    for (const row of replay) this.sendCommand(s, row);
    if (this.rows.some((row) => row.state === 'pending')) this.wake(gw, this.now + POKE);
    this.scheduleHbCheck(s);
    const stale = this.gws[other(gw)];
    if (stale && !stale.closed) this.scheduleFlush(stale);
    this.say(parts.join(' '));
  }

  /** Ends a session; `write` is the epoch-fenced disconnect (a superseded session skips it). */
  private terminate(s: GSession, reason: string, write: boolean) {
    if (s.closed) return;
    s.closed = true;
    const conn = this.conns.get(s.conn);
    if (conn) conn.gwOpen = false;
    if (this.gws[s.gw] === s) this.gws[s.gw] = null;
    if (!write) return;
    if (this.ns.gw === s.gw && this.ns.epoch === s.epoch) {
      const at = this.now;
      Object.assign(this.ns, { gw: null, disconnectedAt: at });
      if (this.ns.connectivity === 'connected') {
        this.ns.connectivity = 'disconnected';
        this.write('cp', `node.disconnected (${reason}) · epoch ${s.epoch} · nothing released`);
      }
      this.at(at + LEASE_TTL, () => {
        if (this.ns.connectivity !== 'disconnected' || this.ns.disconnectedAt !== at) return;
        this.ns.connectivity = 'unreachable';
        this.write('cp', 'node.unreachable · NoSchedule unreachable · NodeUnreachable');
        this.say(
          '40 s after the disconnect the node is unreachable: a NoSchedule reason and a NodeUnreachable condition. Nothing is released: allocations, CDI holds and commands stay.',
        );
      });
    } else {
      this.write('gw', `${gwName(s.gw)} disconnect write: session_epoch = ${s.epoch} → 0 rows`);
      this.say(
        `${gwName(s.gw)}'s disconnect write carries epoch ${s.epoch} and is fenced: the session row already belongs to epoch ${this.ns.epoch}.`,
      );
    }
  }

  /** Three missed heartbeats close a session. */
  private scheduleHbCheck(s: GSession) {
    this.at(s.lastSeen + HB_TIMEOUT, () => {
      if (s.closed) return;
      if (this.now - s.lastSeen < HB_TIMEOUT) {
        this.scheduleHbCheck(s);
        return;
      }
      this.write('gw', `${gwName(s.gw)}: three missed heartbeats`);
      if (this.ns.gw === s.gw && this.ns.epoch === s.epoch)
        this.say(
          `${gwName(s.gw)} missed three heartbeats and closes the session: node.disconnected. In-flight rows stay for the next session's replay.`,
        );
      this.terminate(s, 'heartbeat-timeout', true);
    });
  }

  /** The 15 s liveness flush writes ages fenced by epoch; a stream whose row moved on is a zombie. */
  private scheduleFlush(s: GSession) {
    this.at(Math.floor(this.now / FLUSH) * FLUSH + FLUSH, () => {
      if (s.closed) return;
      if (this.ns.gw === s.gw && this.ns.epoch === s.epoch) return;
      this.write('gw', `${gwName(s.gw)} liveness flush: session_epoch = ${s.epoch} → 0 rows · ABORTED`);
      this.say(
        `${gwName(s.gw)}'s liveness flush carries epoch ${s.epoch} and matches no row: its half-open stream is a zombie and is dropped (ABORTED).`,
      );
      this.terminate(s, 'superseded', false);
    });
  }

  // ---- bcd ----------------------------------------------------------------------------------------

  private scheduleBeat(connId: number, time: number) {
    const incarnation = this.d.incarnation;
    this.at(time, () => {
      const session = this.d.session;
      if (!session || session.conn !== connId || this.d.incarnation !== incarnation) return;
      if (this.d.status !== 'running') return;
      const free = zero();
      for (const lane of LANES) free[lane] = Math.max(0, session.credits[lane] - this.d.inUse[lane]);
      const applied = this.d.applied;
      this.dsend('session', 'Heartbeat', 'dashed', (s) => this.gwHeartbeat(s, free, applied));
      if (this.fillArmed) {
        this.fillArmed = false;
        this.fillNow();
      }
      this.scheduleBeat(connId, this.now + HEARTBEAT);
    });
  }

  private hello(): Hello {
    const d = this.d;
    const unacked: Update[] = [];
    const running: string[] = [];
    for (const entry of d.entries.values()) {
      if (entry.state === 'done' && !entry.acked) unacked.push(updateOf(entry));
      else if (entry.state !== 'done' && entry.incarnation === d.incarnation) running.push(entry.id);
    }
    return { bootId: d.bootId, journalId: d.journalId, applied: d.applied, unacked, running };
  }

  private dial() {
    const d = this.d;
    d.redialAt = null;
    if (d.status !== 'running' || d.session) return;
    if (!this.linkUp) {
      this.write('node', `redial ${d.redialAttempt}: no route to the gateway`);
      this.scheduleRedial();
      return;
    }
    const gw = this.nextGw;
    this.nextGw = other(gw);
    const conn = this.openConn(gw);
    d.session = { conn: conn.id, gw, welcomed: false, epoch: 0, credits: { ...CREDITS } };
    const hello = this.hello();
    const seqOf = (id: string) => d.entries.get(id)?.seq ?? 0;
    this.write(
      'up',
      `Hello → ${gwName(gw)} · boot ${d.bootId} · applied_generation ${d.applied} · unacked_results [${list(hello.unacked.map((u) => seqOf(u.id)))}] · running_command_ids [${list(hello.running.map(seqOf))}]`,
    );
    this.frame(conn, 'up', 'session', 'Hello', 'solid', () => this.gwHello(gw, conn, hello));
  }

  /** Full jitter, 1 s → 60 s. */
  private scheduleRedial() {
    const d = this.d;
    let ceiling = REDIAL_MIN;
    for (let index = 0; index < d.redialAttempt && ceiling < REDIAL_MAX; index++) ceiling *= 2;
    ceiling = Math.min(ceiling, REDIAL_MAX);
    const delay = Math.floor(this.rand() * (ceiling + 1));
    d.redialAttempt += 1;
    d.redialAt = this.now + delay;
    const incarnation = d.incarnation;
    this.at(d.redialAt, () => {
      if (this.d.incarnation !== incarnation || this.d.status !== 'running') return;
      this.dial();
    });
  }

  private onWelcome(connId: number, epoch: number, acked: number) {
    const d = this.d;
    const session = d.session;
    if (!session || session.conn !== connId || session.welcomed) return;
    Object.assign(session, { welcomed: true, epoch });
    d.lastEpoch = epoch;
    d.redialAttempt = 0;
    d.eventsAcked = Math.max(d.eventsAcked, acked);
    if (d.eventSeq > d.eventsAcked) {
      const from = d.eventsAcked + 1;
      const to = d.eventSeq;
      this.write('up', `EventBatch · seq ${from}–${to} (journaled while offline)`);
      this.dsend('spec', `EventBatch ${from}–${to}`, 'outline', (s) => this.gwEvents(s, to));
    }
    this.sendStatus();
    this.scheduleBeat(connId, this.now + HEARTBEAT);
  }

  private onAck(ids: string[], eventSeq: number | null) {
    const d = this.d;
    for (const id of ids) {
      const entry = d.entries.get(id);
      if (entry && entry.state === 'done') entry.acked = true;
    }
    if (eventSeq !== null) d.eventsAcked = Math.max(d.eventsAcked, eventSeq);
  }

  /** The journal's duplicate-delivery rules first (resolve), then the acceptance checks. */
  private onCommand(body: Body) {
    const d = this.d;
    const entry = d.entries.get(body.id);
    if (!entry) return this.admit(body);
    if (entry.state === 'done') {
      this.write('node', `#${body.seq} duplicate: journal says done → resend the stored result`);
      return this.sendResult(entry);
    }
    if (entry.incarnation === d.incarnation) {
      this.write('node', `#${body.seq} duplicate: accepted in this process → re-attach`);
      return;
    }
    if (entry.state === 'running' && KINDS[entry.kind].selfTerminating && entry.bootId !== d.bootId) {
      Object.assign(entry, { state: 'done', outcome: 'succeeded', rebooted: true, acked: false });
      return this.sendResult(entry);
    }
    if (KINDS[entry.kind].retrySafe) {
      this.write('node', `#${body.seq} was left by an earlier process: retry_safe → re-execute`);
      return this.admit(body);
    }
    Object.assign(entry, { state: 'done', outcome: 'failed', reason: 'interrupted', acked: false });
    this.sendResult(entry);
  }

  private admit(body: Body) {
    const d = this.d;
    // UNSUPPORTED (another node, unknown kind) and STALE_GENERATION (min_generation) cannot occur here.
    if (this.now >= body.notAfter) {
      const entry: Entry = {
        id: body.id,
        seq: body.seq,
        kind: body.kind,
        state: 'done',
        bootId: d.bootId,
        incarnation: d.incarnation,
        outcome: 'rejected',
        reason: 'EXPIRED',
        rebooted: false,
        acked: false,
      };
      d.entries.set(body.id, entry);
      return this.sendResult(entry);
    }
    const limit = d.session?.credits[body.lane] ?? CREDITS[body.lane];
    if (d.inUse[body.lane] >= limit) {
      this.write('node', `#${body.seq}: ${body.lane} credits ${d.inUse[body.lane]}/${limit} → REJECTED BUSY (not journaled)`);
      this.dsend(body.lane, `BUSY #${body.seq}`, 'hatch', (s) =>
        this.gwUpdate(s, { id: body.id, state: 'REJECTED', reject: 'BUSY' }),
      );
      return;
    }
    // `accepted` is durable before any side effect.
    d.entries.set(body.id, {
      id: body.id,
      seq: body.seq,
      kind: body.kind,
      state: 'accepted',
      bootId: null,
      incarnation: d.incarnation,
      outcome: null,
      reason: null,
      rebooted: false,
      acked: false,
    });
    d.inUse[body.lane] += 1;
    this.dsend(body.lane, `ACKED #${body.seq}`, 'outline', (s) => this.gwUpdate(s, { id: body.id, state: 'ACKED' }));
    d.execs.set(body.id, { id: body.id, seq: body.seq, kind: body.kind, lane: body.lane, phase: 'queued', start: 0, end: 0 });
    d.queues[body.lane].push(body.id);
    this.pump(body.lane);
  }

  private pump(lane: Lane) {
    const d = this.d;
    const queue = d.queues[lane];
    while (queue.length && d.busyWorkers[lane] < WORKERS[lane] && d.status === 'running') {
      const exec = d.execs.get(queue.shift()!);
      if (!exec) continue;
      d.busyWorkers[lane] += 1;
      this.startExec(exec);
    }
  }

  private startExec(exec: Exec) {
    const d = this.d;
    const entry = d.entries.get(exec.id)!;
    Object.assign(entry, { state: 'running', bootId: d.bootId, incarnation: d.incarnation });
    Object.assign(exec, { phase: 'running', start: this.now, end: this.now + KINDS[exec.kind].runMs });
    this.dsend(exec.lane, `RUNNING #${exec.seq}`, 'outline', (s) => this.gwUpdate(s, { id: exec.id, state: 'RUNNING' }));
    if (exec.kind === 'node.reboot') return this.reboot(exec);
    const incarnation = d.incarnation;
    this.at(exec.end, () => {
      if (this.d.incarnation !== incarnation || this.d.status !== 'running') return;
      this.finishExec(exec);
    });
  }

  private finishExec(exec: Exec) {
    const d = this.d;
    const entry = d.entries.get(exec.id)!;
    if (exec.kind === 'inventory.refresh') this.dsend('control', 'InventorySection ×8', 'outline', () => {});
    Object.assign(entry, { state: 'done', outcome: 'succeeded', acked: false });
    d.execs.delete(exec.id);
    d.inUse[exec.lane] = Math.max(0, d.inUse[exec.lane] - 1);
    d.busyWorkers[exec.lane] = Math.max(0, d.busyWorkers[exec.lane] - 1);
    this.write('node', `#${exec.seq} ${exec.kind} done · succeeded · journaled until acked`);
    this.sendResult(entry);
    this.pump(exec.lane);
  }

  private sendResult(entry: Entry) {
    const update = updateOf(entry);
    const label =
      entry.outcome === 'succeeded' ? `SUCCEEDED #${entry.seq}` : `${update.state} #${entry.seq}`;
    this.dsend(KINDS[entry.kind].lane, label, entry.outcome === 'succeeded' ? 'solid' : 'hatch', (s) =>
      this.gwUpdate(s, update),
    );
  }

  /** node.reboot's side effect: running{boot_id} is journaled, the process dies, boot_id changes, /run is cleared. */
  private reboot(exec: Exec) {
    const d = this.d;
    const previous = d.bootId;
    this.write('node', `#${exec.seq} running{boot_id ${previous}} journaled · rebooting`);
    this.say(
      `node.reboot journaled running{boot ${previous}} and the node went down. It is self-terminating: it completes on rejoin by the new boot_id and is never replayed.`,
    );
    const session = d.session;
    d.session = null;
    if (session) {
      const conn = this.conns.get(session.conn)!;
      conn.daemonOpen = false;
      // A dead process's socket closes: the gateway sees the reset after one latency.
      this.at(this.now + LAT, () => {
        const s = this.gws[conn.gw];
        if (!s || s.closed || s.conn !== conn.id) return;
        this.write('gw', `${gwName(conn.gw)}: stream reset by peer`);
        this.terminate(s, 'reset', true);
      });
    }
    Object.assign(d, {
      status: 'rebooting',
      execs: new Map(),
      queues: { control: [], provision: [], bulk: [] },
      busyWorkers: zero(),
      inUse: zero(),
      redialAt: null,
      redialAttempt: 0,
      bootId: this.hex(8),
      rebootUntil: this.now + REBOOT,
    });
    this.at(this.now + REBOOT, () => this.start());
  }

  /** A new process: journal recovery, the journaled spec enforced, then dial. */
  private start() {
    const d = this.d;
    Object.assign(d, { status: 'running', incarnation: d.incarnation + 1, rebootUntil: null });
    this.write('node', `bcd started · boot ${d.bootId}`);
    const recovered: Entry[] = [];
    for (const entry of d.entries.values()) {
      if (entry.state === 'done' || entry.incarnation === d.incarnation) continue;
      if (entry.state === 'running' && KINDS[entry.kind].selfTerminating && entry.bootId !== d.bootId) {
        Object.assign(entry, { state: 'done', outcome: 'succeeded', rebooted: true, acked: false });
        recovered.push(entry);
        this.write('node', `recover #${entry.seq}: succeeded{rebooted} · previous_boot_id ${entry.bootId}`);
      } else if (!KINDS[entry.kind].retrySafe)
        Object.assign(entry, { state: 'done', outcome: 'failed', reason: 'interrupted', acked: false });
    }
    if (recovered.length)
      this.say(
        `bcd is back with boot ${d.bootId}. Its journal shows ${list(recovered.map((entry) => entry.seq))} running under the old boot, so it reports succeeded{rebooted} in the Hello. The CDI holds on disk are still enforced.`,
      );
    this.converge();
    this.dial();
  }

  private onDesired(generation: number, spec: Alloc[]) {
    const d = this.d;
    if (generation <= d.applied) {
      this.write('node', `DesiredState g${generation} ≤ applied ${d.applied}: ignored`);
      return;
    }
    d.spec = spec;
    d.applied = generation;
    this.appliedGenerations.add(generation);
    this.write('node', `spec g${generation} journaled · converge host · devices · … · daemon`);
    this.converge();
  }

  /** The devices section: release holds no longer desired, bind new ones; observed moves once all converged. */
  private converge() {
    const d = this.d;
    const wanted = new Set(d.spec.map((alloc) => alloc.id));
    for (const hold of [...d.holds])
      if (!wanted.has(hold.id)) {
        d.holds = d.holds.filter((candidate) => candidate.id !== hold.id);
        this.emitEvent(`AllocationReleased ${tail(hold.id)}`);
      }
    for (const alloc of d.spec)
      if (!d.holds.some((hold) => hold.id === alloc.id)) {
        d.holds.push({ id: alloc.id, gpus: [...alloc.gpus] });
        this.emitEvent(`AllocationBound ${tail(alloc.id)}`);
      }
    d.observed = d.applied;
    this.sendStatus();
  }

  private emitEvent(label: string) {
    const d = this.d;
    d.eventSeq += 1;
    const seq = d.eventSeq;
    this.write('node', `event seq ${seq}: ${label}`);
    this.dsend('spec', `EventBatch ${seq}`, 'outline', (s) => this.gwEvents(s, seq));
  }

  private sendStatus() {
    const { observed, applied } = this.d;
    this.dsend('spec', `StatusReport ${observed}`, 'dashed', (s) => this.gwStatus(s, observed, applied));
  }

  // ---- the viewer's hands ---------------------------------------------------------------------------

  cut() {
    if (!this.linkUp) return;
    this.linkUp = false;
    let lost = 0;
    for (const frame of this.frames)
      if (!frame.lost) {
        Object.assign(frame, { lost: true, lostAt: this.now });
        lost += 1;
        this.lostHooks.get(frame.id)?.();
        this.lostHooks.delete(frame.id);
      }
    this.write('node', 'link down');
    const d = this.d;
    const session = d.session;
    const zombie = this.routing();
    if (session) {
      this.conns.get(session.conn)!.daemonOpen = false;
      d.session = null;
      this.write('node', 'connection reset · redial with full jitter (1 s → 60 s)');
      if (d.status === 'running') this.scheduleRedial();
    }
    this.say(
      `Link cut${lost ? `: ${lost} frame${lost > 1 ? 's' : ''} lost on the wire` : ''}. bcd saw the reset and redials with full jitter (1 s → 60 s)${zombie ? `; ${gwName(zombie.gw)} never saw it and still holds a half-open stream at epoch ${zombie.epoch}` : ''}.`,
    );
  }

  restore() {
    if (this.linkUp) return;
    this.linkUp = true;
    this.write('node', 'link up');
    const at = this.d.redialAt;
    this.say(
      at !== null
        ? `Link restored. bcd's next redial, due in ${seconds(at - this.now)} of back-off, gets through; the load balancer picks a gateway.`
        : 'Link restored.',
    );
  }

  sessionLive() {
    return this.linkUp && this.d.status === 'running' && this.d.session?.welcomed === true && this.routing() !== null;
  }

  rebootPending() {
    return (
      this.d.status === 'rebooting' ||
      this.rows.some((row) => row.kind === 'node.reboot' && !TERMINAL.has(row.state))
    );
  }

  bulkIdle() {
    return !this.fillArmed && !this.rows.some((row) => row.lane === 'bulk' && !TERMINAL.has(row.state));
  }

  endTour() {
    this.say(
      'That was the tour. Your turn: run commands, cut the link while one runs, book GPUs offline, reboot, or fill the bulk lane.',
    );
  }

  snapshot(): Snap {
    const d = this.d;
    const routing = this.routing();
    const owners = (allocs: Alloc[]) => {
      const out: (string | null)[] = Array.from({ length: GPUS }, () => null);
      for (const alloc of allocs) for (const gpu of alloc.gpus) out[gpu] = alloc.id;
      return out;
    };
    const lanes = {} as Snap['lanes'];
    for (const lane of LANES) {
      const execs = [...d.execs.values()].filter((exec) => exec.lane === lane);
      lanes[lane] = {
        pending: this.rows
          .filter((row) => row.lane === lane && row.state === 'pending')
          .sort((a, b) => a.seq - b.seq)
          .map((row) => ({
            id: row.id,
            seq: row.seq,
            kind: row.kind,
            notBefore: row.notBefore,
            busy: row.busy,
            held: row.heldNoted && row.notBefore <= this.now,
          })),
        used: routing ? routing.used[lane] : null,
        running: execs
          .filter((exec) => exec.phase === 'running')
          .sort((a, b) => a.start - b.start)
          .map((exec) => ({ id: exec.id, seq: exec.seq, kind: exec.kind, start: exec.start, end: exec.end })),
        queued: d.queues[lane].map((id) => {
          const exec = d.execs.get(id)!;
          return { id, seq: exec.seq, kind: exec.kind, start: 0, end: 0 };
        }),
        inUse: d.inUse[lane],
        limit: d.session?.credits[lane] ?? CREDITS[lane],
      };
    }
    return {
      now: this.now,
      nextAt: this.peek(),
      caption: this.caption,
      linkUp: this.linkUp,
      fillArmed: this.fillArmed,
      live: this.sessionLive(),
      rebootPending: this.rebootPending(),
      canBook: new Set(this.allocs.flatMap((alloc) => alloc.gpus)).size <= GPUS - 2,
      canRelease: this.allocs.length > 0,
      ns: { gw: this.ns.gw, epoch: this.ns.epoch, connectivity: this.ns.connectivity },
      generation: this.generation,
      cpObserved: this.cpObserved,
      sentGeneration: routing ? routing.sentGeneration : null,
      generations: this.generations.slice(-5).map((g) => ({
        g,
        state: this.appliedGenerations.has(g) ? 'applied' : g < d.applied ? 'skipped' : 'waiting',
      })),
      desired: owners(this.allocs),
      held: owners(d.holds),
      gateways: (['a', 'b'] as const).map((gw) => {
        const s = this.gws[gw];
        return {
          gw,
          session:
            s && !s.closed
              ? { epoch: s.epoch, zombie: !(this.ns.gw === gw && this.ns.epoch === s.epoch) }
              : null,
        };
      }),
      daemon: {
        status: d.status,
        bootId: d.bootId,
        journalId: d.journalId,
        lastEpoch: d.lastEpoch,
        applied: d.applied,
        observed: d.observed,
        eventSeq: d.eventSeq,
        eventsAcked: d.eventsAcked,
        session: d.session ? { gw: d.session.gw, welcomed: d.session.welcomed, epoch: d.session.epoch } : null,
        redialAt: d.redialAt,
        redialAttempt: d.redialAttempt,
        rebootUntil: d.rebootUntil,
      },
      lanes,
      frames: this.frames.map((frame) => ({ ...frame })),
      ledger: this.rows.slice(-6).map((row) => {
        const entry = d.entries.get(row.id);
        return {
          id: row.id,
          seq: row.seq,
          kind: row.kind,
          state: row.state,
          reason: row.reason,
          epoch: row.epoch,
          attempt: row.attempt,
          notBefore: row.notBefore,
          lost: row.lost,
          busy: row.busy,
          entry: entry
            ? {
                state: entry.state,
                outcome: entry.outcome,
                reason: entry.reason,
                rebooted: entry.rebooted,
                acked: entry.acked,
                bootId: entry.bootId,
              }
            : null,
        };
      }),
      log: this.log.slice(-6),
    };
  }
}

interface ChipInfo {
  id: string;
  seq: number;
  kind: Kind;
  start: number;
  end: number;
}

interface Snap {
  now: number;
  nextAt: number | null;
  caption: string;
  linkUp: boolean;
  fillArmed: boolean;
  live: boolean;
  rebootPending: boolean;
  canBook: boolean;
  canRelease: boolean;
  ns: { gw: GwId | null; epoch: number; connectivity: Connectivity };
  generation: number;
  cpObserved: number;
  sentGeneration: number | null;
  generations: { g: number; state: 'applied' | 'skipped' | 'waiting' }[];
  desired: (string | null)[];
  held: (string | null)[];
  gateways: { gw: GwId; session: { epoch: number; zombie: boolean } | null }[];
  daemon: {
    status: 'running' | 'rebooting';
    bootId: string;
    journalId: string;
    lastEpoch: number;
    applied: number;
    observed: number;
    eventSeq: number;
    eventsAcked: number;
    session: { gw: GwId; welcomed: boolean; epoch: number } | null;
    redialAt: number | null;
    redialAttempt: number;
    rebootUntil: number | null;
  };
  lanes: Record<
    Lane,
    {
      pending: { id: string; seq: number; kind: Kind; notBefore: number; busy: boolean; held: boolean }[];
      used: number | null;
      running: ChipInfo[];
      queued: ChipInfo[];
      inUse: number;
      limit: number;
    }
  >;
  frames: Frame[];
  ledger: {
    id: string;
    seq: number;
    kind: Kind;
    state: DbState;
    reason: string | null;
    epoch: number | null;
    attempt: number;
    notBefore: number;
    lost: boolean;
    busy: boolean;
    entry: {
      state: Entry['state'];
      outcome: Entry['outcome'];
      reason: string | null;
      rebooted: boolean;
      acked: boolean;
      bootId: string | null;
    } | null;
  }[];
  log: LogLine[];
}

// ---- guided tour ----------------------------------------------------------------------------------

interface TourStep {
  wait: number;
  act: (sim: Sim) => void;
  when?: (sim: Sim) => boolean;
}

/** The story the diagram plays until the reader takes over (real milliseconds between steps). */
const TOUR: TourStep[] = [
  { wait: 1400, act: (sim) => sim.run('diag.nvml') },
  { wait: 1800, act: (sim) => sim.book() },
  { wait: 1500, act: (sim) => sim.run('logs.collect'), when: (sim) => sim.sessionLive() },
  { wait: 1400, act: (sim) => sim.cut() },
  { wait: 1400, act: (sim) => sim.run('inventory.refresh') },
  { wait: 1400, act: (sim) => sim.book() },
  { wait: 1300, act: (sim) => sim.release() },
  { wait: 2200, act: (sim) => sim.restore() },
  { wait: 5200, act: (sim) => sim.run('node.reboot'), when: (sim) => sim.sessionLive() },
  { wait: 7000, act: (sim) => sim.fill(), when: (sim) => sim.sessionLive() && sim.bulkIdle() },
  { wait: 16000, act: (sim) => sim.endTour() },
];

// ---- view -------------------------------------------------------------------------------------------

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const clock = (ms: number) => {
  const total = Math.floor(ms / 100);
  const minutes = Math.floor(total / 600);
  const secondsPart = Math.floor((total % 600) / 10);
  return `${String(minutes).padStart(2, '0')}:${String(secondsPart).padStart(2, '0')}.${total % 10}`;
};

const weightClass: Record<Weight, string> = {
  solid: 'border-text-primary bg-text-primary text-background-full',
  outline: 'border-text-primary bg-surface-raised text-text-primary',
  dashed: 'border-dashed border-border-button-hover bg-surface-raised text-text-secondary',
  hatch: 'hatch border-text-primary bg-surface-raised text-text-primary',
};

const focusRing =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-focus-ring';

function Tag({ weight, children, title }: { weight: Weight; children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={cx(
        'inline-flex h-5 shrink-0 items-center gap-1 rounded-md border px-1.5 font-mono text-caption-2-regular whitespace-nowrap',
        weightClass[weight],
      )}
    >
      {children}
    </span>
  );
}

function Field({ name, children }: { name: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-baseline gap-1 font-mono text-caption-2-regular whitespace-nowrap text-text-secondary">
      {name}
      <span className="text-text-primary tabular-nums">{children}</span>
    </span>
  );
}

function ActionButton({
  icon: IconComponent,
  label,
  onClick,
  disabled,
  pressed,
  ariaLabel,
  mono = false,
}: {
  icon: Icon;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  ariaLabel: string;
  mono?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={pressed}
      aria-label={ariaLabel}
      title={ariaLabel}
      className={cx(
        'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 text-caption-1-medium whitespace-nowrap shadow-xs transition-[background-color,border-color,color,scale] duration-200 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-45 disabled:active:scale-100',
        pressed
          ? 'border-text-primary bg-text-primary text-background-full'
          : 'border-border-button-default bg-background-primary-default text-text-primary hover:border-border-button-hover hover:bg-background-secondary-default',
        mono && 'font-mono',
        focusRing,
      )}
    >
      <IconComponent className="size-3.5 shrink-0" aria-hidden />
      {label}
    </button>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label} className="flex min-w-0 flex-col gap-1.5">
      <span className="eyebrow">{label}</span>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

const rowGrid =
  'lg:grid-cols-[6.5rem_minmax(0,1.05fr)_6.75rem_minmax(8.5rem,0.8fr)_minmax(0,1.45fr)]';

/**
 * One row of the matrix: control plane, gateway, the session stream and the node, left to right on wide screens;
 * stacked (with the gateway beside the row's name) on narrow ones. The visual cells are hidden from assistive
 * technology; `summary` says the same in words.
 */
function MatrixRow({
  name,
  sub,
  summary,
  cp,
  gw,
  wire,
  node,
  dim = false,
}: {
  name: string;
  sub: string;
  summary: string;
  cp: ReactNode;
  gw: ReactNode;
  wire: ReactNode;
  node: ReactNode;
  dim?: boolean;
}) {
  return (
    <div
      className={cx(
        'grid grid-cols-1 gap-x-3 gap-y-2 border-b border-separator-border px-4 py-3 sm:px-5 lg:items-center lg:py-2.5',
        rowGrid,
      )}
    >
      <p className="sr-only">{summary}</p>
      <div aria-hidden className="flex items-center justify-between gap-2 lg:col-start-1 lg:row-start-1 lg:block">
        <div className="flex items-baseline gap-2 lg:flex-col lg:items-start lg:gap-0.5">
          <span className={cx('font-mono text-caption-1-medium', dim ? 'text-text-secondary' : 'text-text-primary')}>
            {name}
          </span>
          <span className="text-caption-2-regular text-text-tertiary">{sub}</span>
        </div>
        <div className="lg:hidden">{gw}</div>
      </div>
      <div aria-hidden className="flex min-w-0 items-center gap-2 lg:col-start-2 lg:row-start-1">
        <span className="w-14 shrink-0 font-mono text-caption-2-regular text-text-tertiary lg:hidden">Postgres</span>
        <div className="min-w-0 flex-1">{cp}</div>
      </div>
      <div aria-hidden className="hidden lg:col-start-3 lg:row-start-1 lg:block">
        {gw}
      </div>
      <div aria-hidden className="min-w-0 lg:col-start-4 lg:row-start-1">
        {wire}
      </div>
      <div aria-hidden className="flex min-w-0 items-center gap-2 lg:col-start-5 lg:row-start-1">
        <span className="w-14 shrink-0 font-mono text-caption-2-regular text-text-tertiary lg:hidden">bcd</span>
        <div className="min-w-0 flex-1">{node}</div>
      </div>
    </div>
  );
}

/** The session stream for one row: frames travel left (ServerFrame) or right to left (AgentFrame). */
function Wire({
  frames,
  linkUp,
  now,
  flowing,
  reduced,
}: {
  frames: Frame[];
  linkUp: boolean;
  now: number;
  flowing: boolean;
  reduced: boolean;
}) {
  return (
    <div className="relative h-8 overflow-hidden lg:h-9">
      <span
        aria-hidden
        className={cx(
          'absolute inset-x-0 top-1/2 border-t',
          linkUp ? 'border-border-button-hover' : 'border-dashed border-border-button-default',
        )}
      />
      {!linkUp ? (
        <span className="absolute top-1/2 left-1/2 z-10 flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-text-primary bg-surface-raised text-text-primary">
          <RiLinkUnlinkM className="size-3.5" aria-hidden />
        </span>
      ) : null}
      <AnimatePresence initial={false}>
        {frames.map((frame, index) => (
          <FramePill
            key={frame.id}
            frame={frame}
            index={index}
            now={now}
            flowing={flowing}
            reduced={reduced}
          />
        ))}
      </AnimatePresence>
    </div>
  );
}

function FramePill({
  frame,
  index,
  now,
  flowing,
  reduced,
}: {
  frame: Frame;
  index: number;
  now: number;
  flowing: boolean;
  reduced: boolean;
}) {
  const span = frame.arriveAt - frame.sentAt;
  const here = clamp01((now - frame.sentAt) / span);
  // A lost frame stalls where the link broke (or a little way out, when it was written into a dead stream).
  const stall = frame.lost ? Math.max(clamp01(((frame.lostAt ?? now) - frame.sentAt) / span), 0.35) : 1;
  const target = reduced ? 0.5 : flowing ? Math.min(stall, 1) : Math.min(here, stall);
  const from = reduced ? 0.5 : Math.min(here, stall);
  const position = (value: number) => (frame.dir === 'down' ? value : 1 - value);
  const duration = reduced || !flowing ? 0 : Math.max(0, (target - from) * FRAME_S);
  const offset = [-7, 7, 0][index % 3]!;
  return (
    <motion.span
      className={cx(
        'absolute top-1/2 z-0 inline-flex h-4 items-center rounded-full border px-1.5 font-mono text-[0.625rem] leading-none whitespace-nowrap',
        frame.lost ? 'border-dashed border-border-button-hover bg-surface-raised text-text-tertiary line-through' : weightClass[frame.weight],
      )}
      style={{ marginTop: offset - 8 }}
      initial={{ left: `${position(from) * 100}%`, x: `-${position(from) * 100}%`, opacity: 0 }}
      animate={{
        left: `${position(target) * 100}%`,
        x: `-${position(target) * 100}%`,
        opacity: frame.lost ? 0.45 : 1,
      }}
      exit={{ opacity: 0, transition: { duration: 0.15 } }}
      transition={{ left: { duration, ease: 'linear' }, x: { duration, ease: 'linear' }, opacity: { duration: 0.15 } }}
    >
      {frame.dir === 'down' ? '' : '← '}
      {frame.label}
      {frame.dir === 'down' ? ' →' : ''}
    </motion.span>
  );
}

function CommandChip({
  chip,
  running,
  now,
  nextAt,
  stepS,
  flowing,
}: {
  chip: ChipInfo;
  running: boolean;
  now: number;
  nextAt: number | null;
  stepS: number;
  flowing: boolean;
}) {
  const IconComponent = KINDS[chip.kind].icon;
  const length = Math.max(1, chip.end - chip.start);
  const at = clamp01((now - chip.start) / length);
  const next = clamp01(((nextAt ?? now) - chip.start) / length);
  return (
    <motion.span
      title={`#${chip.seq} ${chip.kind} · ${running ? 'running' : 'accepted, waiting for a worker'}`}
      className={cx(
        'absolute inset-0 flex items-center justify-center gap-0.5 overflow-hidden rounded-[5px] font-mono text-[0.625rem]',
        running ? 'bg-text-primary text-background-full' : 'border border-text-primary bg-surface-raised text-text-primary',
      )}
      initial={{ opacity: 0, scale: 0.7 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.85 }}
      transition={{ duration: 0.25, ease }}
    >
      <IconComponent className="size-2.5 shrink-0" aria-hidden />
      {chip.seq}
      {running ? (
        <motion.span
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-0.5 origin-left bg-background-full opacity-60"
          initial={{ scaleX: at }}
          animate={{ scaleX: flowing ? next : at }}
          transition={{ duration: flowing ? stepS : 0, ease: 'linear' }}
        />
      ) : null}
    </motion.span>
  );
}

/** The node's credits for one lane: the first slots are its workers, the rest hold accepted commands. */
function Slots({
  lane,
  info,
  snap,
  stepS,
  flowing,
}: {
  lane: Lane;
  info: Snap['lanes'][Lane];
  snap: Snap;
  stepS: number;
  flowing: boolean;
}) {
  const items = [
    ...info.running.map((chip) => ({ chip, running: true })),
    ...info.queued.map((chip) => ({ chip, running: false })),
  ];
  const rebooting = snap.daemon.status === 'rebooting';
  return (
    <div className="relative flex flex-wrap items-center gap-1">
      {Array.from({ length: info.limit }, (_, index) => {
        const item = items[index];
        return (
          <span
            key={index}
            className={cx(
              'relative h-6 w-8 shrink-0 rounded-md border lg:h-7 lg:w-9',
              index < WORKERS[lane]
                ? 'border-border-button-hover bg-background-primary-default'
                : 'border-dashed border-border-button-default',
            )}
          >
            <AnimatePresence>
              {item ? (
                <CommandChip
                  key={item.chip.id}
                  chip={item.chip}
                  running={item.running}
                  now={snap.now}
                  nextAt={snap.nextAt}
                  stepS={stepS}
                  flowing={flowing}
                />
              ) : null}
            </AnimatePresence>
          </span>
        );
      })}
      <span className="ms-1 font-mono text-caption-2-regular text-text-tertiary tabular-nums">
        {info.inUse}/{info.limit}
      </span>
      {rebooting ? (
        <span className="hatch absolute inset-y-0 -inset-x-1 flex items-center justify-center rounded-md border border-dashed border-text-primary bg-surface-raised/70 font-mono text-caption-2-regular text-text-primary">
          process down
        </span>
      ) : null}
    </div>
  );
}

function Pending({ items, now }: { items: Snap['lanes'][Lane]['pending']; now: number }) {
  if (!items.length) return <span className="font-mono text-caption-2-regular text-text-tertiary">no pending rows</span>;
  return (
    <div className="flex flex-wrap items-center gap-1">
      <AnimatePresence mode="popLayout" initial={false}>
        {items.map((item) => {
          const waiting = item.notBefore > now;
          return (
            <motion.span
              key={item.id}
              layout
              title={`#${item.seq} ${item.kind} · pending${waiting ? ' · not_before' : ''}`}
              className={cx(
                'inline-flex h-6 items-center gap-1 rounded-md border px-1.5 font-mono text-[0.625rem] whitespace-nowrap lg:h-7',
                item.busy ? weightClass.hatch : weightClass.dashed,
              )}
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, x: 10 }}
              transition={{ duration: 0.25, ease }}
            >
              #{item.seq}
              {waiting ? (
                <span className="text-text-secondary">+{seconds(item.notBefore - now)}</span>
              ) : item.held ? (
                <span className="text-text-secondary">no credit</span>
              ) : null}
            </motion.span>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

function Gpus({ owners, label }: { owners: (string | null)[]; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="font-mono text-caption-2-regular text-text-secondary">{label}</span>
      <span className="inline-flex gap-0.5">
        {owners.map((owner, index) => (
          <span
            key={index}
            title={owner ? `GPU ${index} · ${tail(owner)}` : `GPU ${index} · free`}
            className={cx(
              'size-2.5 rounded-[3px] border transition-colors duration-300',
              owner ? 'border-text-primary bg-text-primary' : 'border-dashed border-border-button-hover',
            )}
          />
        ))}
      </span>
    </span>
  );
}

function dbWeight(state: DbState): Weight {
  if (state === 'succeeded') return 'solid';
  if (state === 'pending') return 'dashed';
  if (IN_FLIGHT.has(state)) return 'outline';
  return 'hatch';
}

function Ledger({ snap }: { snap: Snap }) {
  return (
    <table className="w-full table-fixed border-collapse text-start">
      <caption className="sr-only">
        The last commands: the control plane&apos;s row in Postgres beside the node&apos;s journal entry.
      </caption>
      <thead>
        <tr className="text-start">
          <th scope="col" className="eyebrow w-9 pb-2 text-start font-normal">
            #
          </th>
          <th scope="col" className="eyebrow hidden w-32 pb-2 text-start font-normal sm:table-cell">
            kind
          </th>
          <th scope="col" className="eyebrow pb-2 text-start font-normal">
            Postgres · commands
          </th>
          <th scope="col" className="eyebrow pb-2 text-start font-normal">
            bcd · journal
          </th>
        </tr>
      </thead>
      <tbody>
        {snap.ledger.map((row) => {
          const IconComponent = KINDS[row.kind].icon;
          const waiting = row.state === 'pending' && row.notBefore > snap.now;
          const entry = row.entry;
          return (
            <tr key={row.id} className="border-t border-separator-border align-top">
              <td className="py-1.5 pe-2 font-mono text-caption-2-regular text-text-primary tabular-nums">
                #{row.seq}
              </td>
              <td className="hidden py-1.5 pe-2 sm:table-cell">
                <span className="flex min-w-0 items-center gap-1 font-mono text-caption-2-regular text-text-primary" title={row.kind}>
                  <IconComponent className="size-3 shrink-0 text-text-secondary" aria-hidden />
                  <span className="truncate">{row.kind}</span>
                </span>
              </td>
              <td className="py-1.5 pe-2">
                <span className="flex flex-wrap items-center gap-1">
                  <Tag weight={dbWeight(row.state)}>{row.state}</Tag>
                  <span className="font-mono text-caption-2-regular text-text-secondary tabular-nums">
                    {row.epoch !== null ? `e${row.epoch} · ` : ''}a{row.attempt}
                    {row.reason ? ` · ${row.reason}` : ''}
                    {waiting ? ` · +${seconds(row.notBefore - snap.now)}` : ''}
                  </span>
                  <span className="font-mono text-caption-2-regular text-text-tertiary sm:hidden">{row.kind}</span>
                </span>
              </td>
              <td className="py-1.5">
                <span className="flex flex-wrap items-center gap-1">
                  {entry ? (
                    <>
                      <Tag
                        weight={
                          entry.state !== 'done'
                            ? 'outline'
                            : entry.outcome === 'succeeded'
                              ? 'solid'
                              : 'hatch'
                        }
                      >
                        {entry.state === 'done'
                          ? `${entry.outcome}${entry.rebooted ? '{rebooted}' : ''}`
                          : entry.state === 'running'
                            ? `running{${entry.bootId?.slice(0, 4)}…}`
                            : 'accepted'}
                      </Tag>
                      {entry.state === 'done' ? (
                        <span
                          className={cx(
                            'font-mono text-caption-2-regular',
                            entry.acked ? 'text-text-tertiary' : 'text-text-primary underline decoration-dashed underline-offset-2',
                          )}
                        >
                          {entry.acked ? 'acked' : 'unacked'}
                        </span>
                      ) : null}
                    </>
                  ) : row.busy ? (
                    <Tag weight="hatch">BUSY · not journaled</Tag>
                  ) : row.lost && row.state === 'dispatched' ? (
                    <Tag weight="dashed">never arrived</Tag>
                  ) : (
                    <span className="font-mono text-caption-2-regular text-text-tertiary">no entry</span>
                  )}
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const glyphText: Record<Glyph, string> = { down: '↓', up: '↑', cp: '●', gw: '◆', node: '■' };

export function CommandLanes() {
  const [sim, setSim] = useState(() => new Sim());
  const [snap, setSnap] = useState<Snap>(() => sim.snapshot());
  const [running, setRunning] = useState(true);
  const [tour, setTour] = useState(true);
  const [tourTick, setTourTick] = useState(0);
  const tourIndex = useRef(0);
  const retrying = useRef(false);
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.2 });
  const reduced = useReducedMotionSafe();
  const flowing = running && inView;

  // With reduced motion nothing plays by itself; the reader drives.
  useEffect(() => {
    if (reduced) setTour(false);
  }, [reduced]);

  // The sim clock: run the next event after a paced wait, while on screen and not paused.
  useEffect(() => {
    if (!flowing) return;
    const next = sim.peek();
    if (next === null) return;
    const timer = window.setTimeout(() => {
      sim.advanceTo(next);
      setSnap(sim.snapshot());
    }, pace(next - sim.now));
    return () => window.clearTimeout(timer);
  }, [sim, snap, flowing]);

  // The guided tour, one step at a time, until the reader acts.
  useEffect(() => {
    if (!tour || !flowing) return;
    const step = TOUR[tourIndex.current];
    if (!step) {
      setTour(false);
      return;
    }
    const timer = window.setTimeout(
      () => {
        if (step.when && !step.when(sim)) {
          retrying.current = true;
          setTourTick((count) => count + 1);
          return;
        }
        retrying.current = false;
        step.act(sim);
        tourIndex.current += 1;
        setSnap(sim.snapshot());
        setTourTick((count) => count + 1);
      },
      retrying.current ? 600 : step.wait,
    );
    return () => window.clearTimeout(timer);
  }, [tour, flowing, tourTick, sim]);

  function act(run: (target: Sim) => void) {
    setTour(false);
    setRunning(true);
    run(sim);
    setSnap(sim.snapshot());
  }

  function reset() {
    const next = new Sim();
    tourIndex.current = 0;
    retrying.current = false;
    setSim(next);
    setSnap(next.snapshot());
    setRunning(true);
    setTour(!reduced);
    setTourTick((count) => count + 1);
  }

  const stepS = snap.nextAt === null ? 0 : pace(snap.nextAt - snap.now) / 1000;
  const framesOf = (row: FrameRow) => snap.frames.filter((frame) => frame.row === row);
  const d = snap.daemon;

  const nodeStatus: { weight: Weight; text: string } =
    d.status === 'rebooting'
      ? { weight: 'hatch', text: `rebooting · up in ${seconds((d.rebootUntil ?? snap.now) - snap.now)}` }
      : d.session?.welcomed
        ? { weight: 'solid', text: `session · epoch ${d.session.epoch}` }
        : d.session
          ? { weight: 'outline', text: 'Hello sent' }
          : d.redialAt !== null
            ? { weight: 'dashed', text: `redial ${d.redialAttempt} in ${seconds(d.redialAt - snap.now)}` }
            : { weight: 'dashed', text: 'no session' };

  const laneSummary = (lane: Lane) => {
    const info = snap.lanes[lane];
    return `${lane} lane: ${info.pending.length} pending in Postgres; the gateway counts ${info.used ?? 'no'} of ${CREDITS[lane]} credits in flight; bcd holds ${info.inUse} of ${info.limit} credits, ${info.running.length} running and ${info.queued.length} waiting for one of ${WORKERS[lane]} workers.`;
  };

  const gwCredit = (lane: Lane) => {
    const used = snap.lanes[lane].used;
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className="font-mono text-caption-2-regular text-text-secondary">gw</span>
        {used === null ? (
          <span className="font-mono text-caption-2-regular text-text-tertiary">—</span>
        ) : (
          <>
            <span className="inline-flex gap-px">
              {Array.from({ length: CREDITS[lane] }, (_, index) => (
                <span
                  key={index}
                  className={cx(
                    'h-2.5 w-1 rounded-[1px] transition-colors duration-200',
                    index < used ? 'bg-text-primary' : 'bg-background-tertiary-default',
                  )}
                />
              ))}
            </span>
            <span className="font-mono text-caption-2-regular text-text-primary tabular-nums">
              {used}/{CREDITS[lane]}
            </span>
          </>
        )}
      </span>
    );
  };

  return (
    <div ref={ref} className="min-w-0">
      <DiagramFrame
        live={snap.live}
        label={
          <>
            Session · <span className="font-mono text-text-primary">{tail(NODE_ID)}</span> · role{' '}
            <span className="font-mono text-text-primary">node</span>
          </>
        }
        actions={
          <>
            <span className="hidden font-mono text-caption-2-regular text-text-tertiary tabular-nums sm:inline" aria-hidden>
              t {clock(snap.now)}
            </span>
            <span className="hidden rounded-full bg-background-secondary-default px-2.5 py-0.5 text-caption-1-medium text-text-secondary sm:inline-flex">
              {!running ? 'Paused' : tour ? 'Guided tour' : 'You drive'}
            </span>
            <PlayToggle paused={!running} onClick={() => setRunning((value) => !value)} compact />
            <ReplayButton onClick={reset} label="Reset" />
          </>
        }
        bodyClassName="p-0 sm:p-0"
        footer={
          <>
            A faithful model of the gateway (<span className="font-mono">@better-compute/gateway</span>) and of the
            FakeDaemon in <span className="font-mono">@better-compute/testing</span>, which speaks the real protocol;
            the Go daemon <span className="font-mono">bcd node</span> follows the same rules and is tested end to
            end against the gateway, but is not released yet. Idle time is compressed.
          </>
        }
      >
        {/* Controls */}
        <div className="flex flex-wrap gap-x-6 gap-y-3 px-4 pt-4 sm:px-5">
          <Group label="Commands">
            {(['diag.nvml', 'inventory.refresh', 'logs.collect'] as const).map((kind) => (
              <ActionButton
                key={kind}
                icon={KINDS[kind].icon}
                label={kind}
                mono
                ariaLabel={`Enqueue ${kind} (${KINDS[kind].lane} lane)`}
                onClick={() => act((target) => target.run(kind))}
              />
            ))}
            <ActionButton
              icon={RiShutDownLine}
              label="node.reboot"
              mono
              ariaLabel="Enqueue node.reboot, a self-terminating command"
              disabled={snap.rebootPending}
              onClick={() => act((target) => target.run('node.reboot'))}
            />
          </Group>
          <Group label="Desired state">
            <ActionButton
              icon={RiAddLine}
              label="Book 2 GPUs"
              ariaLabel="reservations.create: book two GPUs, a new NodeSpec generation"
              disabled={!snap.canBook}
              onClick={() => act((target) => target.book())}
            />
            <ActionButton
              icon={RiSubtractLine}
              label="Release"
              ariaLabel="reservations.release: release the oldest booking, a new NodeSpec generation"
              disabled={!snap.canRelease}
              onClick={() => act((target) => target.release())}
            />
          </Group>
          <Group label="Stress">
            <ActionButton
              icon={snap.linkUp ? RiScissorsCutLine : RiLinkM}
              label={snap.linkUp ? 'Cut the link' : 'Restore the link'}
              pressed={!snap.linkUp}
              ariaLabel={snap.linkUp ? 'Cut the network link between node and gateway' : 'Restore the network link'}
              onClick={() => act((target) => (target.linkUp ? target.cut() : target.restore()))}
            />
            <ActionButton
              icon={RiStackLine}
              label="Fill bulk lane"
              ariaLabel="Enqueue three logs.collect on the bulk lane, which has two credits"
              disabled={snap.fillArmed}
              onClick={() => act((target) => target.fill())}
            />
          </Group>
        </div>

        {/* What just happened */}
        <div className="min-h-[4.25rem] px-4 pt-3 pb-3 sm:min-h-[3.75rem] sm:px-5">
          <AnimatePresence mode="wait" initial={false}>
            <motion.p
              key={snap.caption}
              aria-live={tour ? 'off' : 'polite'}
              className="text-body-2-regular leading-5 text-text-secondary"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.2 }}
            >
              {snap.caption}
            </motion.p>
          </AnimatePresence>
        </div>

        {/* The matrix */}
        <div role="group" aria-label="Session, desired state and command lanes" className="border-t border-separator-border">
          <div
            aria-hidden
            className={cx(
              'hidden border-b border-separator-border bg-surface-sunken px-5 py-2 lg:grid lg:gap-x-3',
              rowGrid,
            )}
          >
            <span />
            <span className="eyebrow">Control plane</span>
            <span className="eyebrow">Gateway</span>
            <span className="eyebrow">Session stream</span>
            <span className="eyebrow">Node · bcd</span>
          </div>

          <MatrixRow
            name="session"
            sub="Hello · epoch"
            summary={`Session: node_sessions epoch ${snap.ns.epoch}, gateway ${snap.ns.gw ? gwName(snap.ns.gw) : 'none'}, node ${snap.ns.connectivity}. Link ${snap.linkUp ? 'up' : 'cut'}. bcd: ${nodeStatus.text}, boot ${d.bootId}, last epoch ${d.lastEpoch}.`}
            cp={
              <span className="flex flex-wrap items-center gap-1.5">
                <Tag
                  weight={
                    snap.ns.connectivity === 'connected'
                      ? 'solid'
                      : snap.ns.connectivity === 'disconnected'
                        ? 'dashed'
                        : 'hatch'
                  }
                >
                  {snap.ns.connectivity}
                </Tag>
                <Field name="session_epoch">{snap.ns.epoch}</Field>
                <Field name="gateway_id">{snap.ns.gw ? gwName(snap.ns.gw) : 'NULL'}</Field>
              </span>
            }
            gw={
              <span className="flex flex-col gap-0.5">
                {snap.gateways.map((g) => (
                  <span key={g.gw} className="inline-flex items-center gap-1.5 font-mono text-caption-2-regular whitespace-nowrap">
                    <span
                      className={cx(
                        'size-2 shrink-0 rounded-full border',
                        !g.session
                          ? 'border-dashed border-border-button-hover'
                          : g.session.zombie
                            ? 'hatch border-text-primary'
                            : 'border-text-primary bg-text-primary',
                      )}
                    />
                    <span className={g.session ? 'text-text-primary' : 'text-text-tertiary'}>{gwName(g.gw)}</span>
                    {g.session ? (
                      <span className="text-text-secondary">
                        e{g.session.epoch}
                        {g.session.zombie ? ' zombie' : ''}
                      </span>
                    ) : null}
                  </span>
                ))}
              </span>
            }
            wire={<Wire frames={framesOf('session')} linkUp={snap.linkUp} now={snap.now} flowing={flowing} reduced={reduced} />}
            node={
              <span className="flex flex-wrap items-center gap-1.5">
                <Tag weight={nodeStatus.weight}>{nodeStatus.text}</Tag>
                <Field name="boot">{d.bootId}</Field>
                <Field name="journal">{tail(d.journalId)}</Field>
                <Field name="last_epoch">{d.lastEpoch}</Field>
              </span>
            }
          />

          <MatrixRow
            name="NodeSpec"
            sub="level-triggered"
            summary={`Desired state: generation ${snap.generation} in Postgres, observed ${snap.cpObserved}. bcd applied ${d.applied}, observed ${d.observed}; ${snap.held.filter(Boolean).length} of ${GPUS} GPUs held, ${snap.desired.filter(Boolean).length} desired.`}
            cp={
              <span className="flex flex-col gap-1.5">
                <span className="flex flex-wrap items-center gap-1.5">
                  <Field name="generation">{snap.generation}</Field>
                  <span className="inline-flex gap-0.5">
                    {snap.generations.map((item) => (
                      <span
                        key={item.g}
                        title={`generation ${item.g} · ${item.state === 'skipped' ? 'never sent: superseded' : item.state}`}
                        className={cx(
                          'inline-flex h-4 items-center rounded border px-1 font-mono text-[0.625rem] leading-none',
                          item.state === 'applied'
                            ? weightClass.solid
                            : item.state === 'skipped'
                              ? cx(weightClass.hatch, 'line-through')
                              : weightClass.dashed,
                        )}
                      >
                        g{item.g}
                      </span>
                    ))}
                  </span>
                  <Field name="observed">{snap.cpObserved}</Field>
                </span>
                <Gpus owners={snap.desired} label="desired" />
              </span>
            }
            gw={
              <span className="font-mono text-caption-2-regular text-text-secondary whitespace-nowrap">
                sent{' '}
                <span className="text-text-primary">{snap.sentGeneration === null ? '—' : `g${snap.sentGeneration}`}</span>
              </span>
            }
            wire={<Wire frames={framesOf('spec')} linkUp={snap.linkUp} now={snap.now} flowing={flowing} reduced={reduced} />}
            node={
              <span className="flex flex-col gap-1.5">
                <span className="flex flex-wrap items-center gap-1.5">
                  <Field name="applied">{d.applied}</Field>
                  <Field name="observed">{d.observed}</Field>
                  <Field name="event seq">
                    {d.eventSeq}
                    {d.eventSeq > d.eventsAcked ? ` (${d.eventSeq - d.eventsAcked} unacked)` : ''}
                  </Field>
                </span>
                <Gpus owners={snap.held} label="CDI holds" />
              </span>
            }
          />

          {LANES.map((lane) =>
            lane === 'provision' ? (
              <MatrixRow
                key={lane}
                name="provision"
                sub="4 credits · 2 workers"
                dim
                summary="provision lane: 4 credits and 2 workers, idle. No v0.1 kind of a node agent runs on it; diag.dcgm joins in v0.2."
                cp={<span className="font-mono text-caption-2-regular text-text-tertiary">diag.dcgm joins in v0.2</span>}
                gw={gwCredit(lane)}
                wire={<Wire frames={framesOf(lane)} linkUp={snap.linkUp} now={snap.now} flowing={flowing} reduced={reduced} />}
                node={<Slots lane={lane} info={snap.lanes[lane]} snap={snap} stepS={stepS} flowing={flowing} />}
              />
            ) : (
              <MatrixRow
                key={lane}
                name={lane}
                sub={`${CREDITS[lane]} credits · ${WORKERS[lane]} worker${WORKERS[lane] > 1 ? 's' : ''}`}
                summary={laneSummary(lane)}
                cp={<Pending items={snap.lanes[lane].pending} now={snap.now} />}
                gw={gwCredit(lane)}
                wire={<Wire frames={framesOf(lane)} linkUp={snap.linkUp} now={snap.now} flowing={flowing} reduced={reduced} />}
                node={<Slots lane={lane} info={snap.lanes[lane]} snap={snap} stepS={stepS} flowing={flowing} />}
              />
            ),
          )}
        </div>

        {/* Postgres beside the journal, and the protocol log */}
        <div className="grid lg:grid-cols-12">
          <div className="min-w-0 border-b border-separator-border px-4 py-4 sm:px-5 lg:col-span-7 lg:border-e lg:border-b-0">
            <Ledger snap={snap} />
          </div>
          <div className="min-w-0 px-4 py-4 sm:px-5 lg:col-span-5">
            <p className="eyebrow mb-2">Protocol log</p>
            <ol className="flex flex-col gap-1" aria-label="Protocol log, newest last">
              {snap.log.map((line) => (
                <li key={line.id} className="flex min-w-0 gap-2 font-mono text-caption-2-regular leading-4">
                  <span className="shrink-0 text-text-tertiary tabular-nums">{clock(line.at)}</span>
                  <span aria-hidden className="w-2.5 shrink-0 text-center text-text-secondary">
                    {glyphText[line.glyph]}
                  </span>
                  <span className="min-w-0 text-text-secondary [overflow-wrap:anywhere]">{line.text}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </DiagramFrame>
    </div>
  );
}
