'use client';

import { memo, useEffect, useReducer, useRef, useState, type FocusEvent, type ReactNode } from 'react';
import { AnimatePresence, motion, useInView } from 'motion/react';
import type { IconType } from 'react-icons';
import {
  RiDatabase2Line,
  RiHourglassLine,
  RiRobot2Line,
  RiRouterLine,
  RiServerLine,
  RiShieldCheckLine,
  RiShieldCrossLine,
  RiShieldKeyholeLine,
  RiUserLine,
  RiUserSettingsLine,
} from 'react-icons/ri';
import { cx } from '@/utils/cx';
import { DiagramFrame, PlayToggle, ReplayButton } from './frame';
import { ease, useReducedMotionSafe } from './motion';

/**
 * P7 and §3.4 of PLAN.md, simulated in the browser. Every API mutation goes through the envelope in
 * packages/server/src/operations.ts and makes exactly one Better IAM decision (`iam.require` on
 * `compute:<area>:<verb>` @ `compute-<type>/<id>`). The fleet's frames (proto/bettercompute/agent/v1/session.proto)
 * go node → gateway → Postgres and never reach IAM, which tests/sim/iam-negative.test.ts asserts with `spyIamPort`.
 *
 * A delegated agent session is refused, the envelope asks IAM for a confirmation (`403 CONFIRMATION_REQUIRED`), and
 * the draft parks in `awaiting-confirmation` (packages/capacity/src/reservations.ts). The person decides with Better
 * IAM's `delegations.decideConfirmation`; the retry with the same idempotency key is decided on the same draft id.
 *
 * Methods, actions and resources are rows of generated/api.json (all registered in v0.1, except `images.register`,
 * registered in v0.2). Draft ids are computed with core's `draftId` algorithm (packages/core/src/ids.ts). Time runs ten
 * times faster than real time, so each node's 10 s heartbeat arrives every second.
 */

// ---------------------------------------------------------------------------------------------
// Draft ids: `rsv_` + Crockford base32 of sha256(JSON [domain, prefix, tenant, identity, key]).
// A synchronous SHA-256 keeps the reducer pure; it matches node:crypto and core's draftId.
// ---------------------------------------------------------------------------------------------

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
const ror = (x: number, n: number) => (x >>> n) | (x << (32 - n));

function sha256(bytes: Uint8Array): Uint8Array {
  const hash = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const blocks = Math.ceil((bytes.length + 9) / 64);
  const data = new Uint8Array(blocks * 64);
  data.set(bytes);
  data[bytes.length] = 0x80;
  const view = new DataView(data.buffer);
  view.setUint32(data.length - 4, bytes.length * 8);
  const w: number[] = new Array(64).fill(0);
  for (let block = 0; block < blocks; block++) {
    for (let i = 0; i < 64; i++) {
      if (i < 16) {
        w[i] = view.getUint32(block * 64 + i * 4);
      } else {
        const a = w[i - 15]!;
        const b = w[i - 2]!;
        w[i] =
          (w[i - 16]! +
            (ror(a, 7) ^ ror(a, 18) ^ (a >>> 3)) +
            w[i - 7]! +
            (ror(b, 17) ^ ror(b, 19) ^ (b >>> 10))) |
          0;
      }
    }
    let [a, b, c, d, e, f, g, h] = hash as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (ror(e, 6) ^ ror(e, 11) ^ ror(e, 25)) + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) | 0;
      const t2 = ((ror(a, 2) ^ ror(a, 13) ^ ror(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    [a, b, c, d, e, f, g, h].forEach((value, i) => {
      hash[i] = (hash[i]! + value) | 0;
    });
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  hash.forEach((value, i) => outView.setUint32(i * 4, value >>> 0));
  return out;
}

const alphabet = '0123456789abcdefghjkmnpqrstvwxyz';

function base32(bytes: Uint8Array): string {
  let output = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) output += alphabet[(buffer << (5 - bits)) & 31];
  return output;
}

const draftIds = new Map<string, string>();

/** The request-as-resource id of §3.4 step 5: the same (tenant, identity, key) always names the same draft. */
function draftId(tenantId: string, identityId: string, idempotencyKey: string): string {
  const material = JSON.stringify(['better-compute/draft/v1', 'rsv', tenantId, identityId, idempotencyKey]);
  let id = draftIds.get(material);
  if (id === undefined) {
    id = `rsv_${base32(sha256(new TextEncoder().encode(material)))}`;
    draftIds.set(material, id);
  }
  return id;
}

/** `rsv_91cf7c1n…`: the prefix and the first eight characters of the body. */
function short(id: string): string {
  const at = id.lastIndexOf('_');
  return at < 0 || id.length <= at + 9 ? id : `${id.slice(0, at + 9)}…`;
}

// ---------------------------------------------------------------------------------------------
// The cast
// ---------------------------------------------------------------------------------------------

const TENANT = 'acme';

type CallerId = 'alice' | 'ops' | 'ci' | 'agent';

/** IAM bearers compute accepts (§3.4 step 1) and the session kinds compute's `Caller` distinguishes. */
const callers: Record<
  CallerId,
  { name: string; icon: IconType; credential: string; session: string }
> = {
  alice: { name: 'alice', icon: RiUserLine, credential: 'biam_ses_', session: 'user session' },
  ops: { name: 'ops', icon: RiUserSettingsLine, credential: 'biam_ses_', session: 'root operator' },
  ci: { name: 'ci-bot', icon: RiRobot2Line, credential: 'biam_key_', session: 'agent key' },
  agent: { name: 'Scheduler', icon: RiRobot2Line, credential: 'biam_dlg_', session: 'for alice' },
};

/** Four platform GPU nodes; ids are real `newId('node')` values. */
const nodes = [
  { host: 'gpu-a01', id: 'node_01m3b08ve37a1vvc85b8v8pw6d' },
  { host: 'gpu-a02', id: 'node_01m3b08vfhdpvhj4335a8bj1j9' },
  { host: 'gpu-a03', id: 'node_01m3b08vgy54yaznb1d6ncdjdb' },
  { host: 'gpu-a04', id: 'node_01m3b08vjdxrn668dxe4dgvckv' },
] as const;

/** Better IAM confirmation ids are random UUIDs. */
const confirmationIds = [
  '5b0e7c2a-91d4-4c38-b6f1-2e8a4d7c9f03',
  'c41f9e6d-2a7b-4e15-8d3c-7f60b2a19e54',
  '0e8d3b71-6c2f-4a9e-b5d4-19a7c3f8e2b6',
];

/** AgentFrame and ServerFrame messages of the daemon Session. Command and DesiredState travel to the node. */
const frameKinds = [
  'Heartbeat',
  'InventorySection',
  'CommandUpdate',
  'StatusReport',
  'EventBatch',
  'Command',
  'DesiredState',
] as const;
type FrameKind = (typeof frameKinds)[number];
const toNode: ReadonlySet<FrameKind> = new Set<FrameKind>(['Command', 'DesiredState']);

// ---------------------------------------------------------------------------------------------
// Simulation (a pure reducer over running time; pausing freezes it)
// ---------------------------------------------------------------------------------------------

type Lane = 'api' | 'fleet';
type Verdict = 'allow' | 'deny' | 'confirm';
type Stage = 'send' | 'envelope' | 'toIam' | 'decide' | 'toDb' | 'commit' | 'reply';
type CallKind = 'create' | 'run' | 'agent' | 'retry' | 'register' | 'cordon' | 'release';
type Item = 'alice' | 'ops' | 'agent' | 'ci' | 'cordon' | 'release';

interface Effect {
  /** Milliseconds after the call's transaction commits. */
  after: number;
  frame: FrameKind;
  node: number;
  /** Shown in the traffic list when set. */
  note?: string;
}

interface Call {
  seq: number;
  kind: CallKind;
  caller: CallerId;
  method: string;
  action: string;
  resource: string;
  verdict: Verdict;
  /** What the envelope does before the decision. */
  envelope: string;
  /** The handler's transaction (or the denial hook's); absent when nothing is written. */
  commit?: string;
  status: 200 | 403;
  reply: string;
  effects?: Effect[];
  confirm?: { key: string; draft: string; node: number };
}

interface Active {
  call: Call;
  stage: Stage;
  started: number;
  until: number;
}

type Tone = 'call' | 'reply' | 'up' | 'down' | 'flush';

interface Packet {
  id: number;
  lane: Lane;
  path: number[];
  born: number;
  duration: number;
  tone: Tone;
  label?: string;
}

type RowTag = 'api' | 'fleet' | 'worker' | 'iam';

interface Row {
  id: number;
  tag: RowTag;
  who: string;
  what: string;
  detail: string;
  /** IAM calls compute made for this row; null when it is not compute's call at all. */
  iam: number | null;
  verdict?: Verdict;
}

interface Confirmation {
  id: string;
  key: string;
  draft: string;
  node: number;
  since: number;
  /** Running time spent pending while nobody was at the card; autoplay decides at AUTO_DECIDE_MS. */
  waited: number;
  status: 'pending' | 'approved' | 'rejected';
  decidedAt: number;
}

interface State {
  t: number;
  ids: number;
  keys: number;
  script: number;
  loop: number;
  queue: Call[];
  call: Active | null;
  idleUntil: number;
  last: Call | null;
  confirmation: Confirmation | null;
  beats: number[];
  beatCounts: number[];
  pulses: number[];
  nextFlush: number;
  scheduled: (Effect & { at: number })[];
  packets: Packet[];
  mutations: number;
  decisions: number;
  confirmations: number;
  frames: number;
  byKind: Record<FrameKind, number>;
  flash: { kind: FrameKind; at: number } | null;
  rows: Row[];
  announce: string;
  held: { id: string; node: number } | null;
  cordoned: boolean;
}

const TICK = 100;
/** Each node heartbeats every 10 s (gateway default), shown ten times faster. */
const HEARTBEAT_MS = 1000;
/** The gateway flushes liveness ages to `node_sessions.last_seen` every 15 s. */
const FLUSH_MS = 1500;
const GAP_MS = 700;
const AUTO_DECIDE_MS = 3800;
const LINGER_MS = 2000;
const MAX_ROWS = 5;
const MAX_QUEUE = 3;

const stageMs: Record<Stage, number> = {
  send: 600,
  envelope: 800,
  toIam: 450,
  decide: 900,
  toDb: 450,
  commit: 750,
  reply: 800,
};

const script: Item[] = ['alice', 'ops', 'agent', 'ci', 'cordon', 'release'];

function initialState(): State {
  return {
    t: 0,
    ids: 0,
    keys: 0,
    script: 0,
    loop: 0,
    queue: [],
    call: null,
    idleUntil: 500,
    last: null,
    confirmation: null,
    beats: [150, 400, 650, 900],
    beatCounts: [0, 0, 0, 0],
    pulses: [-1e9, -1e9, -1e9, -1e9],
    nextFlush: 1200,
    scheduled: [],
    packets: [],
    mutations: 0,
    decisions: 0,
    confirmations: 0,
    frames: 0,
    byKind: {
      Heartbeat: 0,
      InventorySection: 0,
      CommandUpdate: 0,
      StatusReport: 0,
      EventBatch: 0,
      Command: 0,
      DesiredState: 0,
    },
    flash: null,
    rows: [],
    announce: '',
    held: null,
    cordoned: false,
  };
}

function bindEffects(node: number, id: string): Effect[] {
  return [
    { after: 250, frame: 'DesiredState', node, note: `deviceAssignments · ${short(id)}` },
    { after: 1350, frame: 'EventBatch', node, note: `AllocationBound · ${short(id)} active` },
    { after: 1700, frame: 'StatusReport', node },
  ];
}

function build(d: State, item: Item, reader: boolean): Call {
  const seq = ++d.ids;
  switch (item) {
    case 'alice': {
      const key = `train-${++d.keys}`;
      const id = draftId(TENANT, 'usr_alice', key);
      const node = reader ? d.keys % 3 : 0;
      if (!reader) d.held = { id, node };
      return {
        seq,
        kind: 'create',
        caller: 'alice',
        method: 'reservations.create',
        action: 'compute:reservations:create',
        resource: `compute-reservation/${id}`,
        verdict: 'allow',
        envelope: `tx 1 · idempotency lookup, draft ${short(id)}, projection row`,
        commit: 'tx 2 · draft → placed · audit_events',
        status: 200,
        reply: 'placed',
        effects: bindEffects(node, id),
      };
    }
    case 'ops': {
      ++d.keys;
      return {
        seq,
        kind: 'run',
        caller: 'ops',
        method: 'commands.run',
        action: 'compute:nodes:exec',
        resource: `compute-node/${nodes[1].id}`,
        verdict: 'allow',
        envelope: 'authenticate (cached 30 s) · tenant pre-check',
        commit: 'tx · command pending · audit_events',
        status: 200,
        reply: 'pending',
        effects: [
          { after: 250, frame: 'Command', node: 1, note: 'Command · inventory.refresh' },
          { after: 800, frame: 'CommandUpdate', node: 1 },
          { after: 1100, frame: 'CommandUpdate', node: 1 },
          { after: 1700, frame: 'InventorySection', node: 1, note: 'InventorySection · gpus' },
          { after: 2000, frame: 'CommandUpdate', node: 1, note: 'CommandUpdate · SUCCEEDED' },
        ],
      };
    }
    case 'agent': {
      const key = `nightly-${++d.keys}`;
      const id = draftId(TENANT, 'usr_alice', key);
      return {
        seq,
        kind: 'agent',
        caller: 'agent',
        method: 'reservations.create',
        action: 'compute:reservations:create',
        resource: `compute-reservation/${id}`,
        verdict: 'confirm',
        envelope: `tx 1 · idempotency lookup, draft ${short(id)}, projection row`,
        commit: 'denied hook · draft → awaiting-confirmation',
        status: 403,
        reply: 'CONFIRMATION_REQUIRED',
        confirm: { key, draft: id, node: 2 },
      };
    }
    case 'ci':
      return {
        seq,
        kind: 'register',
        caller: 'ci',
        method: 'images.register',
        action: 'compute:images:publish',
        resource: `compute-tenant/${TENANT}`,
        verdict: 'deny',
        envelope: 'authenticate (cached 30 s) · tenant pre-check',
        status: 403,
        reply: 'ACCESS_DENIED',
      };
    case 'cordon': {
      const undo = d.cordoned;
      d.cordoned = !undo;
      return {
        seq,
        kind: 'cordon',
        caller: 'ops',
        method: undo ? 'nodes.uncordon' : 'nodes.cordon',
        action: 'compute:nodes:cordon',
        resource: `compute-node/${nodes[3].id}`,
        verdict: 'allow',
        envelope: 'authenticate (cached 30 s) · tenant pre-check',
        commit: `tx · cordoned = ${!undo} · audit_events`,
        status: 200,
        reply: undo ? 'uncordoned' : 'cordoned',
      };
    }
    case 'release': {
      const held = d.held;
      if (!held) return build(d, 'alice', false);
      d.held = null;
      return {
        seq,
        kind: 'release',
        caller: 'alice',
        method: 'reservations.release',
        action: 'compute:reservations:release',
        resource: `compute-reservation/${held.id}`,
        verdict: 'allow',
        envelope: 'authenticate (cached 30 s) · tenant pre-check',
        commit: 'tx · active → releasing · audit_events',
        status: 200,
        reply: 'releasing',
        effects: [
          { after: 250, frame: 'DesiredState', node: held.node, note: `assignment removed · ${short(held.id)}` },
          {
            after: 1350,
            frame: 'EventBatch',
            node: held.node,
            note: `AllocationReleased · ${short(held.id)} released`,
          },
          { after: 1700, frame: 'StatusReport', node: held.node },
        ],
      };
    }
  }
}

/** The agent's second call after the person approved: same key, so the same draft id and the approved triple. */
function retryOf(d: State, c: Confirmation): Call {
  return {
    seq: ++d.ids,
    kind: 'retry',
    caller: 'agent',
    method: 'reservations.create',
    action: 'compute:reservations:create',
    resource: `compute-reservation/${c.draft}`,
    verdict: 'allow',
    envelope: `tx 1 · same key: awaiting-confirmation → draft ${short(c.draft)}`,
    commit: 'tx 2 · draft → placed · audit_events',
    status: 200,
    reply: 'placed',
    effects: bindEffects(c.node, c.draft),
  };
}

function stagesOf(call: Call): Stage[] {
  return call.commit
    ? ['send', 'envelope', 'toIam', 'decide', 'toDb', 'commit', 'reply']
    : ['send', 'envelope', 'toIam', 'decide', 'reply'];
}

function durationOf(call: Call, stage: Stage): number {
  if (stage === 'decide' && call.verdict === 'confirm') return 1300;
  if (stage === 'reply' && !call.commit) return 700;
  return stageMs[stage];
}

function addRow(d: State, row: Omit<Row, 'id'>) {
  d.rows = [{ ...row, id: ++d.ids }, ...d.rows].slice(0, MAX_ROWS);
}

function addPacket(d: State, packet: Omit<Packet, 'id'>) {
  d.packets = [...d.packets, { ...packet, id: ++d.ids }];
}

function emitFrame(d: State, frame: FrameKind, node: number, at: number, note?: string, hashes = false) {
  d.frames += 1;
  d.byKind = { ...d.byKind, [frame]: d.byKind[frame] + 1 };
  d.pulses = d.pulses.map((value, index) => (index === node ? at : value));
  const down = toNode.has(frame);
  // A heartbeat stops at the gateway (liveness is kept in memory); one carrying inventory hashes, and every
  // other frame, is written to Postgres. Frames to the node come from rows the gateway reads.
  const path = down ? [3, 1, 0] : frame === 'Heartbeat' && !hashes ? [0, 1] : [0, 1, 3];
  addPacket(d, {
    lane: 'fleet',
    path,
    born: at,
    duration: path.length === 2 ? 750 : 1400,
    tone: down ? 'down' : 'up',
    ...(frame === 'Heartbeat' ? {} : { label: frame }),
  });
  if (frame !== 'Heartbeat') d.flash = { kind: frame, at };
  if (note)
    addRow(d, {
      tag: 'fleet',
      who: nodes[node]!.host,
      what: `${down ? '←' : '→'} ${note}`,
      detail: 'no IAM call',
      iam: 0,
    });
}

function enter(d: State, active: Active) {
  const { call, stage, started } = active;
  const duration = active.until - active.started;
  switch (stage) {
    case 'send':
      d.mutations += 1;
      addPacket(d, { lane: 'api', path: [0, 1], born: started, duration, tone: 'call', label: call.method });
      break;
    case 'toIam':
      addPacket(d, { lane: 'api', path: [1, 2], born: started, duration, tone: 'call' });
      break;
    case 'decide':
      d.decisions += 1;
      if (call.verdict === 'confirm') d.confirmations += 1;
      break;
    case 'toDb':
      addPacket(d, { lane: 'api', path: [2, 3], born: started, duration, tone: 'call' });
      break;
    case 'commit':
      for (const effect of call.effects ?? [])
        d.scheduled = [...d.scheduled, { ...effect, at: started + effect.after }];
      break;
    case 'reply':
      addPacket(d, {
        lane: 'api',
        path: [call.commit ? 3 : 2, 0],
        born: started,
        duration,
        tone: 'reply',
        label: String(call.status),
      });
      break;
    default:
      break;
  }
}

function finish(d: State) {
  const call = d.call!.call;
  const caller = callers[call.caller];
  addRow(d, {
    tag: 'api',
    who: caller.name,
    what: call.method,
    detail: `${call.status} ${call.reply}`,
    iam: 1,
    verdict: call.verdict,
  });
  if (call.verdict === 'allow')
    d.announce = `${caller.name}, ${call.method}: one IAM decision, allowed. ${call.status} ${call.reply}.`;
  else if (call.verdict === 'deny')
    d.announce = `${caller.name}, ${call.method}: one IAM decision, refused. 403 ACCESS_DENIED.`;
  else
    d.announce = `${caller.name}, acting for alice, ${call.method}: one IAM decision, refused, and compute asked for a confirmation. 403 CONFIRMATION_REQUIRED. Approve or reject it as alice.`;
  if (call.confirm)
    d.confirmation = {
      id: confirmationIds[d.confirmations % confirmationIds.length]!,
      ...call.confirm,
      since: d.t,
      waited: 0,
      status: 'pending',
      decidedAt: 0,
    };
  d.last = call;
  d.call = null;
  d.idleUntil = d.t + GAP_MS;
}

function start(d: State, call: Call, at: number) {
  d.call = { call, stage: 'send', started: at, until: at + durationOf(call, 'send') };
  enter(d, d.call);
}

function advance(d: State) {
  const active = d.call!;
  const stages = stagesOf(active.call);
  const index = stages.indexOf(active.stage);
  if (index === stages.length - 1) {
    finish(d);
    return;
  }
  const stage = stages[index + 1]!;
  d.call = {
    call: active.call,
    stage,
    started: active.until,
    until: active.until + durationOf(active.call, stage),
  };
  enter(d, d.call);
}

function next(d: State): Call | null {
  if (d.queue.length > 0) {
    const [head, ...rest] = d.queue;
    d.queue = rest;
    return head!;
  }
  // The script waits for the person; calls the reader sends still go through.
  if (d.confirmation?.status === 'pending') return null;
  const item = script[d.script]!;
  d.script = (d.script + 1) % script.length;
  if (d.script === 0) d.loop += 1;
  return build(d, item, false);
}

function decide(d: State, approve: boolean) {
  const c = d.confirmation;
  if (!c || c.status !== 'pending') return;
  d.confirmation = { ...c, status: approve ? 'approved' : 'rejected', decidedAt: d.t };
  addRow(d, {
    tag: 'iam',
    who: 'alice',
    what: 'decideConfirmation',
    detail: approve ? 'delegation:confirm' : 'delegation:reject',
    iam: null,
  });
  if (approve) {
    d.queue = [retryOf(d, c), ...d.queue];
    d.announce =
      'alice approved in Better IAM. Scheduler retries with the same idempotency key, and one more decision allows it.';
  } else {
    d.announce =
      'alice rejected in Better IAM. Scheduler stops, and the draft expires at its deadline.';
  }
}

function tick(s: State, dt: number, hold: boolean): State {
  const d: State = { ...s, t: s.t + dt };

  // Fleet: heartbeats, liveness flushes and the frames admitted calls cause. None of it calls IAM.
  d.beats = [...s.beats];
  d.beatCounts = [...s.beatCounts];
  for (let node = 0; node < nodes.length; node++) {
    while (d.t >= d.beats[node]!) {
      const at = d.beats[node]!;
      d.beatCounts[node] = d.beatCounts[node]! + 1;
      // Every 10th heartbeat carries the inventory section hashes.
      emitFrame(d, 'Heartbeat', node, at, undefined, d.beatCounts[node]! % 10 === 0);
      d.beats[node] = at + HEARTBEAT_MS;
    }
  }
  while (d.t >= d.nextFlush) {
    addPacket(d, { lane: 'fleet', path: [1, 3], born: d.nextFlush, duration: 900, tone: 'flush' });
    d.nextFlush += FLUSH_MS;
  }
  if (s.scheduled.length > 0) {
    const due = s.scheduled.filter((effect) => effect.at <= d.t).sort((a, b) => a.at - b.at);
    d.scheduled = s.scheduled.filter((effect) => effect.at > d.t);
    for (const effect of due) emitFrame(d, effect.frame, effect.node, effect.at, effect.note);
  }

  // The person behind the delegation: autoplay approves for them unless the reader is at the card.
  const c = d.confirmation;
  if (c?.status === 'pending' && !hold) {
    d.confirmation = { ...c, waited: c.waited + dt };
    if (d.confirmation.waited >= AUTO_DECIDE_MS) decide(d, true);
  }
  const decided = d.confirmation;
  if (decided && decided.status !== 'pending' && d.t - decided.decidedAt >= LINGER_MS) {
    if (decided.status === 'rejected')
      addRow(d, {
        tag: 'worker',
        who: 'reconciler',
        what: `${short(decided.draft)} → expired`,
        detail: 'at its deadline (≤ 30 min)',
        iam: 0,
      });
    d.confirmation = null;
  }

  // API: one call at a time through the envelope.
  while (d.call && d.t >= d.call.until) advance(d);
  if (!d.call && d.t >= d.idleUntil) {
    const call = next(d);
    if (call) start(d, call, d.t);
  }

  d.packets = d.packets.filter((packet) => packet.born + packet.duration + 150 > d.t);
  return d;
}

type Action =
  | { type: 'tick'; dt: number; hold: boolean }
  | { type: 'send'; item: Item }
  | { type: 'decide'; approve: boolean }
  | { type: 'restart' }
  | { type: 'seed' };

function agentBusy(s: State): boolean {
  return (
    s.confirmation?.status === 'pending' ||
    s.call?.call.caller === 'agent' ||
    s.queue.some((call) => call.caller === 'agent')
  );
}

function reducer(s: State, action: Action): State {
  switch (action.type) {
    case 'tick':
      return tick(s, action.dt, action.hold);
    case 'send': {
      if (s.queue.length >= MAX_QUEUE || (action.item === 'agent' && agentBusy(s))) return s;
      const d: State = { ...s };
      d.queue = [...s.queue, build(d, action.item, true)];
      return d;
    }
    case 'decide': {
      const d: State = { ...s };
      decide(d, action.approve);
      return d;
    }
    case 'restart':
      return initialState();
    case 'seed': {
      // Reduced motion: rest on one finished run of the script instead of playing it.
      let d = initialState();
      for (let step = 0; step < 4000 && !(d.loop >= 1 && !d.call && !d.confirmation); step++)
        d = tick(d, TICK, false);
      // Deliver the frames the last call still had on their way.
      d = { ...d };
      for (const effect of [...d.scheduled].sort((a, b) => a.at - b.at))
        emitFrame(d, effect.frame, effect.node, effect.at, effect.note);
      return { ...d, scheduled: [], packets: [], flash: null, announce: '' };
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Geometry: four stations at the centers of four equal columns; the fleet rail bends under IAM.
// ---------------------------------------------------------------------------------------------

const X = [12.5, 37.5, 62.5, 87.5];
const RAIL_Y = 18;
const DIP = 24;
/** Waypoints ([x %, dy px]) of the fleet rail between the gateway and Postgres. */
const bypass: [number, number][] = [
  [50, 0],
  [57, DIP],
  [68, DIP],
  [75, 0],
];
const apiRail = `M ${X[0]} ${RAIL_Y} H ${X[3]}`;
const fleetRail = `M ${X[0]} ${RAIL_Y} H 50 C 54 ${RAIL_Y} 53 ${RAIL_Y + DIP} 57 ${RAIL_Y + DIP} H 68 C 72 ${RAIL_Y + DIP} 71 ${RAIL_Y} 75 ${RAIL_Y} H ${X[3]}`;

function route(packet: Packet) {
  const x: number[] = [];
  const y: number[] = [];
  packet.path.forEach((station, index) => {
    const from = packet.path[index - 1];
    if (packet.lane === 'fleet' && from !== undefined && Math.min(from, station) <= 1 && Math.max(from, station) >= 3) {
      for (const [px, py] of from < station ? bypass : [...bypass].reverse()) {
        x.push(px);
        y.push(py);
      }
    }
    x.push(X[station]!);
    y.push(0);
  });
  // Keyframe times by distance along the rail.
  const lengths = x.map((value, index) =>
    index === 0 ? 0 : Math.abs(value - x[index - 1]!) + Math.abs(y[index]! - y[index - 1]!) / 4,
  );
  const total = lengths.reduce((sum, value) => sum + value, 0) || 1;
  let run = 0;
  const times = lengths.map((value) => (run += value) / total);
  return { x: x.map((value) => `${value}%`), y, times };
}

// ---------------------------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------------------------

type Mark = 'idle' | 'active' | 'allow' | 'deny' | 'confirm' | 'ghost';

const sends: { item: Item; caller: CallerId; method: string }[] = [
  { item: 'alice', caller: 'alice', method: 'reservations.create' },
  { item: 'ops', caller: 'ops', method: 'commands.run' },
  { item: 'agent', caller: 'agent', method: 'reservations.create' },
  { item: 'ci', caller: 'ci', method: 'images.register' },
];

export function IamLanes() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.25 });
  const reduced = useReducedMotionSafe();
  const [paused, setPaused] = useState(false);
  // Pressing play (or sending a request) is an explicit choice, so it overrides the reduced-motion default.
  const [chosen, setChosen] = useState(false);
  const held = paused || (reduced && !chosen);
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const [focusLane, setFocusLane] = useState<Lane | null>(null);
  // While the reader points at or focuses the confirmation card, autoplay does not decide for them.
  const [atCard, setAtCard] = useState(false);
  const hold = useRef(false);
  hold.current = atCard;

  useEffect(() => {
    if (reduced && !chosen) dispatch({ type: 'seed' });
  }, [reduced, chosen]);

  useEffect(() => {
    if (held || !inView) return;
    const timer = setInterval(() => dispatch({ type: 'tick', dt: TICK, hold: hold.current }), TICK);
    return () => clearInterval(timer);
  }, [held, inView]);

  function play() {
    setChosen(true);
    setPaused(false);
  }

  const active = state.call;
  const current = active?.call ?? state.last;
  const stage = active?.stage;
  const decided =
    active !== null &&
    (stage === 'toDb' ||
      stage === 'commit' ||
      stage === 'reply' ||
      (stage === 'decide' && state.t >= active.started + (active.until - active.started) * 0.45));
  const verdictMark: Mark =
    current?.verdict === 'allow' ? 'allow' : current?.verdict === 'deny' ? 'deny' : 'confirm';
  const apiMarks: Mark[] = [
    stage === 'send' || stage === 'reply' ? 'active' : 'idle',
    stage === 'envelope' ? 'active' : 'idle',
    decided ? verdictMark : stage === 'decide' ? 'active' : 'idle',
    stage === 'commit' ? 'active' : 'idle',
  ];
  const lit =
    stage === 'send' || stage === 'envelope'
      ? 1
      : stage === 'toIam' || stage === 'decide'
        ? 2
        : stage === 'toDb' || stage === 'commit'
          ? 3
          : 0;
  const caller = current ? callers[current.caller] : undefined;
  const IamIcon =
    apiMarks[2] === 'allow'
      ? RiShieldCheckLine
      : apiMarks[2] === 'deny'
        ? RiShieldCrossLine
        : apiMarks[2] === 'confirm'
          ? RiHourglassLine
          : RiShieldKeyholeLine;
  const inFlight = state.mutations - state.decisions;
  const dim = (lane: Lane) => focusLane !== null && focusLane !== lane;
  const hover = (lane: Lane) => ({
    onPointerEnter: () => setFocusLane(lane),
    onPointerLeave: () => setFocusLane(null),
  });
  const narration = narrate(state);
  const agentDisabled = agentBusy(state);
  const queueFull = state.queue.length >= MAX_QUEUE;

  return (
    <div ref={ref} className="@container">
      <DiagramFrame
        live={!held}
        label="One IAM decision per mutation, none for the fleet"
        actions={
          <>
            <PlayToggle
              paused={held}
              compact
              onClick={() => {
                if (held) play();
                else setPaused(true);
              }}
            />
            <ReplayButton
              label="Restart"
              onClick={() => {
                dispatch({ type: 'restart' });
                play();
              }}
            />
          </>
        }
        footer={
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={narration.key}
              className="block"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.25 }}
            >
              {narration.text}
            </motion.span>
          </AnimatePresence>
        }
      >
        <p className="sr-only" aria-live="polite">
          {state.announce}
        </p>

        {/* Requests the reader can send */}
        <div className="mb-5 flex flex-wrap items-center gap-2" role="group" aria-label="Send a request">
          <span className="eyebrow me-1 w-full @lg:w-auto">Send a request as</span>
          {sends.map((send) => {
            const who = callers[send.caller];
            const Icon = who.icon;
            const disabled = queueFull || (send.item === 'agent' && agentDisabled);
            return (
              <button
                key={send.item}
                type="button"
                disabled={disabled}
                onClick={() => {
                  dispatch({ type: 'send', item: send.item });
                  play();
                }}
                aria-label={`Send ${send.method} as ${who.name} (${who.credential}, ${who.session})`}
                title={
                  disabled
                    ? send.item === 'agent' && agentDisabled
                      ? 'Scheduler already has a request waiting for alice'
                      : 'Three requests are already queued'
                    : undefined
                }
                className={cx(
                  'group inline-flex h-8 min-w-0 cursor-pointer items-center gap-1.5 rounded-lg border border-border-button-default bg-background-primary-default px-2.5 shadow-xs transition-[border-color,opacity,scale] duration-200 hover:border-border-button-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-focus-ring active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100',
                )}
              >
                <Icon
                  className="size-3.5 shrink-0 text-foreground-icon-secondary transition-colors group-hover:text-foreground-icon-primary"
                  aria-hidden
                />
                <span className="text-caption-1-medium text-text-primary">{who.name}</span>
                <span className="truncate font-mono text-caption-2-regular text-text-secondary">
                  {send.method}
                </span>
              </button>
            );
          })}
          <AnimatePresence initial={false}>
            {state.queue.length > 0 ? (
              <motion.span
                key="queued"
                className="rounded-md border border-dashed border-border-button-hover px-1.5 font-mono text-caption-2-regular leading-5 text-text-secondary"
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                transition={{ duration: 0.2 }}
              >
                {state.queue.length} queued
              </motion.span>
            ) : null}
          </AnimatePresence>
        </div>

        <div className="grid gap-5 @4xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] @4xl:gap-6">
          {/* The two lanes */}
          <div className="@container flex min-w-0 flex-col rounded-xl border border-separator-border bg-surface-sunken">
            <section
              aria-label="API lane"
              {...hover('api')}
              className={cx('px-3 pt-3 pb-3.5 transition-opacity duration-300 @md:px-4', dim('api') && 'opacity-45')}
            >
              <LaneHeader
                name="API"
                meta="POST /api/compute/{group}/{method}"
                legend={['request', 'response']}
              />
              <Track
                lane="api"
                rail={apiRail}
                lit={lit}
                packets={state.packets}
                stations={[
                  {
                    mark: apiMarks[0]!,
                    icon: caller?.icon ?? RiUserLine,
                    label: caller?.name ?? 'caller',
                    sub: caller ? `${caller.credential} · ${caller.session}` : 'IAM bearer',
                  },
                  { mark: apiMarks[1]!, icon: RiServerLine, label: 'compute api', sub: 'envelope' },
                  { mark: apiMarks[2]!, icon: IamIcon, label: 'Better IAM', sub: 'iam.require' },
                  { mark: apiMarks[3]!, icon: RiDatabase2Line, label: 'Postgres', sub: 'tx · audit_events' },
                ]}
              />
              <ApiCaption call={current} active={active} decided={decided || (!active && current !== null)} />
            </section>
            <section
              aria-label="Fleet lane"
              {...hover('fleet')}
              className={cx(
                'border-t border-separator-border px-3 pt-3 pb-3.5 transition-opacity duration-300 @md:px-4',
                dim('fleet') && 'opacity-45',
              )}
            >
              <LaneHeader name="Fleet" meta="gRPC Session · 4 nodes · time ×10" legend={['from nodes', 'to nodes']} />
              <Track
                lane="fleet"
                rail={fleetRail}
                lit={0}
                packets={state.packets}
                stations={[
                  {
                    mark: 'idle',
                    label: '4 nodes',
                    sub: 'Session · mTLS',
                    content: <NodeDots pulses={state.pulses} t={state.t} />,
                  },
                  { mark: 'idle', icon: RiRouterLine, label: 'gateway', sub: 'sessions · credits' },
                  { mark: 'ghost', icon: RiShieldKeyholeLine, label: 'Better IAM', sub: 'never called' },
                  { mark: 'idle', icon: RiDatabase2Line, label: 'Postgres', sub: 'node_sessions · commands' },
                ]}
              />
              <FrameTally byKind={state.byKind} flash={state.flash} t={state.t} />
            </section>
          </div>

          {/* Counters, and the traffic list (or the person's confirmation) */}
          <div className="@container flex min-w-0 flex-col gap-3">
            <dl className="grid grid-cols-2 gap-2 @2xl:grid-cols-4">
              <Counter
                label="API mutations"
                value={state.mutations}
                note={inFlight > 0 ? `${inFlight} in flight` : 'through the envelope'}
                {...hover('api')}
                dim={dim('api')}
                flip
              />
              <Counter
                label="IAM decisions"
                value={state.decisions}
                note={
                  state.confirmations > 0
                    ? `one each · +${state.confirmations} confirmation ${state.confirmations === 1 ? 'request' : 'requests'}`
                    : 'one per mutation'
                }
                strong
                {...hover('api')}
                dim={dim('api')}
                flip
              />
              <Counter
                label="Fleet frames"
                value={state.frames}
                note="Session, both ways"
                {...hover('fleet')}
                dim={dim('fleet')}
              />
              <Counter
                label="IAM calls from the fleet"
                value={0}
                note="spyIamPort records none"
                zero
                {...hover('fleet')}
                dim={dim('fleet')}
              />
            </dl>
            <div className="relative min-h-[12.75rem]">
              <AnimatePresence mode="wait" initial={false}>
                {state.confirmation ? (
                  <ConfirmationCard
                    key={`confirm-${state.confirmation.id}-${state.confirmation.since}`}
                    confirmation={state.confirmation}
                    autoplay={!held && !atCard}
                    onDecide={(approve) => {
                      dispatch({ type: 'decide', approve });
                      play();
                    }}
                    onHold={setAtCard}
                  />
                ) : (
                  <Traffic key="traffic" rows={state.rows} focusLane={focusLane} />
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>
      </DiagramFrame>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------------------------

function Code({ children }: { children: ReactNode }) {
  return <code className="font-mono text-text-primary">{children}</code>;
}

/** One sentence for what is happening, keyed so it changes once per call rather than once per stage. */
function narrate(s: State): { key: string; text: ReactNode } {
  const call = s.call?.call;
  const c = s.confirmation;
  if (!call) {
    if (c?.status === 'pending')
      return {
        key: `pending-${c.since}`,
        text: (
          <>
            The draft <Code>{short(c.draft)}</Code> waits in <Code>awaiting-confirmation</Code> for
            up to 30 minutes while alice decides in Better IAM. Nothing else waits for it.
          </>
        ),
      };
    if (c?.status === 'approved')
      return {
        key: `approved-${c.since}`,
        text: (
          <>
            alice approved (<Code>delegation:confirm</Code>). The approval covers this action on this
            draft only, once, within 900 s.
          </>
        ),
      };
    if (c?.status === 'rejected')
      return {
        key: `rejected-${c.since}`,
        text: (
          <>
            alice rejected (<Code>delegation:reject</Code>). Scheduler stops; the draft stays in{' '}
            <Code>awaiting-confirmation</Code> until its deadline, then expires.
          </>
        ),
      };
    return {
      key: 'fleet',
      text: (
        <>
          Between requests the fleet keeps talking: a <Code>Heartbeat</Code> every 10 s from each
          node, inventory, command results. The gateway writes them to Postgres and never calls
          Better IAM.
        </>
      ),
    };
  }
  const key = `call-${call.seq}`;
  switch (call.kind) {
    case 'create':
      return {
        key,
        text: (
          <>
            alice reserves GPUs. Transaction 1 writes the draft, one <Code>iam.require</Code>{' '}
            decides <Code>compute:reservations:create</Code> on it, and transaction 2 places it with
            its <Code>audit_events</Code> row.
          </>
        ),
      };
    case 'run':
      return {
        key,
        text: (
          <>
            ops runs <Code>inventory.refresh</Code> on gpu-a02: one decision on{' '}
            <Code>compute:nodes:exec</Code>. The <Code>Command</Code>, its{' '}
            <Code>CommandUpdate</Code>s and the <Code>InventorySection</Code> it sends back make
            none.
          </>
        ),
      };
    case 'agent':
      return {
        key,
        text: (
          <>
            Scheduler acts for alice under a delegation that holds{' '}
            <Code>compute:reservations:create</Code> back. The one decision refuses it, so compute
            asks IAM for a confirmation and answers <Code>403 CONFIRMATION_REQUIRED</Code>.
          </>
        ),
      };
    case 'retry':
      return {
        key,
        text: (
          <>
            Scheduler retries with the same <Code>idempotencyKey</Code>: same draft id, so the
            approved <Code>(action, type, id)</Code> matches. One more decision, allowed once.
          </>
        ),
      };
    case 'register':
      return {
        key,
        text: (
          <>
            ci-bot&rsquo;s agent key is refused by the example <Code>agent-guardrails</Code> policy.
            Still exactly one decision; compute sees only <Code>ACCESS_DENIED</Code>, and the handler
            never runs.
          </>
        ),
      };
    case 'cordon':
      return {
        key,
        text: (
          <>
            ops {call.method === 'nodes.cordon' ? 'cordons' : 'uncordons'} gpu-a04: one decision on{' '}
            <Code>compute:nodes:cordon</Code>, then one transaction with its{' '}
            <Code>audit_events</Code> row.
          </>
        ),
      };
    case 'release':
      return {
        key,
        text: (
          <>
            alice releases her reservation: one decision. The node drops the assignment and reports{' '}
            <Code>AllocationReleased</Code> without any IAM call.
          </>
        ),
      };
  }
}

function LaneHeader({ name, meta, legend }: { name: string; meta: string; legend: [string, string] }) {
  return (
    <div className="mb-1 flex min-w-0 items-center gap-2">
      <span className="eyebrow shrink-0 text-text-primary">{name}</span>
      <span className="min-w-0 truncate font-mono text-caption-2-regular text-text-tertiary">{meta}</span>
      <span className="ms-auto hidden shrink-0 items-center gap-2.5 text-caption-2-regular text-text-tertiary @xl:flex">
        <span className="inline-flex items-center gap-1">
          <span aria-hidden className="size-1.5 rounded-full bg-text-primary" />
          {legend[0]}
        </span>
        <span className="inline-flex items-center gap-1">
          <span aria-hidden className="size-2 rounded-full border border-text-primary" />
          {legend[1]}
        </span>
      </span>
    </div>
  );
}

interface StationSpec {
  mark: Mark;
  icon?: IconType;
  label: string;
  sub: string;
  content?: ReactNode;
}

const markClass: Record<Mark, string> = {
  idle: 'border-border-button-default bg-surface-raised text-foreground-icon-secondary shadow-xs',
  active: 'border-text-primary bg-surface-raised text-text-primary shadow-sm',
  allow: 'border-text-primary bg-text-primary text-background-full shadow-sm',
  deny: 'hatch border-text-primary bg-surface-raised text-text-primary shadow-sm',
  confirm: 'border-dashed border-text-primary bg-surface-raised text-text-primary shadow-sm',
  ghost: 'border-dashed border-border-button-hover text-foreground-icon-tertiary',
};

/** A rail with four stations, and the packets travelling along it. Decorative: the captions carry the text. */
function Track({
  lane,
  rail,
  lit,
  packets,
  stations,
}: {
  lane: Lane;
  rail: string;
  lit: number;
  packets: Packet[];
  stations: StationSpec[];
}) {
  // The fleet rail needs room below the stations for its bend under the IAM column.
  const height = lane === 'fleet' ? 48 : 40;
  return (
    <div>
      <div aria-hidden className="relative mt-3" style={{ height }}>
        <svg
          className="absolute inset-0 h-full w-full overflow-visible text-border-button-hover"
          viewBox={`0 0 100 ${height}`}
          preserveAspectRatio="none"
        >
          <path d={rail} fill="none" stroke="currentColor" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        </svg>
        {/* The segments the current request has travelled, drawn in ink. */}
        {lane === 'api'
          ? [0, 1, 2].map((segment) => (
              <motion.span
                key={segment}
                className="absolute h-px origin-left bg-text-primary"
                style={{
                  top: RAIL_Y,
                  left: `${X[segment]}%`,
                  width: `${X[segment + 1]! - X[segment]!}%`,
                }}
                initial={false}
                animate={{ scaleX: segment < lit ? 1 : 0, opacity: segment < lit ? 1 : 0 }}
                transition={{ duration: segment < lit ? 0.45 : 0.3, ease }}
              />
            ))
          : null}
        {packets
          .filter((packet) => packet.lane === lane)
          .map((packet) => (
            <PacketDot key={packet.id} packet={packet} />
          ))}
        {stations.map((station, index) => (
          <StationMark key={index} station={station} x={X[index]!} />
        ))}
      </div>
      <div className="grid grid-cols-4 gap-1 text-center">
        {stations.map((station, index) => (
          <div key={index} className="min-w-0">
            <p
              className={cx(
                'truncate text-caption-1-medium transition-colors duration-300',
                station.mark === 'ghost'
                  ? 'text-text-tertiary'
                  : station.mark === 'idle'
                    ? 'text-text-secondary'
                    : 'text-text-primary',
              )}
            >
              {station.label}
            </p>
            <p className="hidden truncate font-mono text-[0.625rem] leading-4 text-text-tertiary @md:block">
              {station.sub}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

function StationMark({ station, x }: { station: StationSpec; x: number }) {
  const Icon = station.icon;
  const busy = station.mark !== 'idle' && station.mark !== 'ghost';
  return (
    <span
      className="absolute -translate-x-1/2 -translate-y-1/2"
      style={{ left: `${x}%`, top: RAIL_Y }}
    >
      <span
        className={cx(
          'relative flex items-center justify-center rounded-full border transition-[background-color,border-color,color,box-shadow] duration-300',
          station.mark === 'ghost' ? 'size-7' : 'size-8',
          markClass[station.mark],
        )}
      >
        {station.mark === 'active' ? (
          <motion.span
            className="absolute -inset-1 rounded-full border border-text-primary"
            initial={{ opacity: 0.5, scale: 1 }}
            animate={{ opacity: 0, scale: 1.35 }}
            transition={{ duration: 1, repeat: Infinity, ease: 'easeOut' }}
          />
        ) : null}
        {station.content ??
          (Icon ? (
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span
                key={`${station.mark}-${station.label}`}
                className="flex"
                initial={busy ? { scale: 0.5, opacity: 0 } : { opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ type: 'spring', stiffness: 520, damping: 24 }}
              >
                <Icon className={station.mark === 'ghost' ? 'size-3.5' : 'size-4'} />
              </motion.span>
            </AnimatePresence>
          ) : null)}
      </span>
    </span>
  );
}

const toneClass: Record<Tone, string> = {
  call: 'size-2.5 bg-text-primary shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-text-primary)_18%,transparent)]',
  reply: 'size-2.5 border-[1.5px] border-text-primary bg-surface-raised',
  up: 'size-1.5 bg-text-primary',
  down: 'size-2 border border-text-primary bg-surface-raised',
  flush: 'size-1.5 bg-text-tertiary',
};

/**
 * One message on its way. A full-width carrier is translated by a share of its own width, so the motion is a
 * transform; fleet packets that pass the IAM column dip under it with the rail.
 */
const PacketDot = memo(function PacketDot({ packet }: { packet: Packet }) {
  const { x, y, times } = route(packet);
  const seconds = packet.duration / 1000;
  return (
    <motion.span
      className="pointer-events-none absolute inset-x-0 h-0"
      style={{ top: RAIL_Y }}
      initial={{ x: x[0], y: 0, opacity: 0 }}
      animate={{ x, y, opacity: [0, 1, 1, 0] }}
      transition={{
        x: { duration: seconds, times, ease: packet.lane === 'api' ? 'easeInOut' : 'linear' },
        y: { duration: seconds, times, ease: 'linear' },
        opacity: { duration: seconds, times: [0, 0.12, 0.85, 1] },
      }}
    >
      <span className={cx('absolute top-0 left-0 block -translate-x-1/2 -translate-y-1/2 rounded-full', toneClass[packet.tone])} />
      {packet.label ? (
        <span
          className={cx(
            'absolute bottom-2 left-0 -translate-x-1/2 rounded border px-1 font-mono text-[0.625rem] leading-4 whitespace-nowrap',
            packet.tone === 'call'
              ? 'border-text-primary bg-text-primary text-background-full'
              : packet.tone === 'reply'
                ? 'border-text-primary bg-surface-raised text-text-primary'
                : packet.tone === 'down'
                  ? 'border-dashed border-border-button-hover bg-surface-raised text-text-secondary'
                  : 'border-border-button-default bg-surface-raised text-text-secondary',
          )}
        >
          {packet.label}
        </span>
      ) : null}
    </motion.span>
  );
});

/** The four nodes inside their station; each lights when it sends a frame. */
function NodeDots({ pulses, t }: { pulses: number[]; t: number }) {
  return (
    <span className="grid grid-cols-2 gap-[3px]">
      {pulses.map((at, index) => (
        <span
          key={index}
          className={cx(
            'size-[5px] rounded-full transition-colors duration-200',
            t - at < 300 ? 'bg-text-primary' : 'bg-border-button-hover',
          )}
        />
      ))}
    </span>
  );
}

function ApiCaption({ call, active, decided }: { call: Call | null; active: Active | null; decided: boolean }) {
  if (!call)
    return (
      <p className="mt-2 min-h-[3.25rem] font-mono text-caption-2-regular leading-4 text-text-tertiary">
        Waiting for the first request…
      </p>
    );
  const [group, method] = call.method.split('.');
  const stage = active?.stage;
  const now = !active
    ? `${call.status} ${call.reply}`
    : stage === 'send'
      ? `Authorization: Bearer ${callers[call.caller].credential}…`
      : stage === 'envelope'
        ? call.envelope
        : stage === 'toIam' || stage === 'decide'
          ? call.verdict === 'confirm'
            ? 'iam.require · 1 decision → refused · iam.requestConfirmation'
            : 'iam.require · 1 decision (authenticate + decide)'
          : stage === 'toDb' || stage === 'commit'
            ? call.commit!
            : `${call.status} ${call.reply}`;
  const verdict =
    call.verdict === 'allow' ? 'allowed' : call.verdict === 'deny' ? 'ACCESS_DENIED' : 'CONFIRMATION_REQUIRED';
  return (
    <div
      className={cx(
        'mt-2 flex min-h-[3.25rem] min-w-0 flex-col gap-0.5 font-mono text-caption-2-regular leading-4 transition-opacity duration-300',
        !active && 'opacity-60',
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate text-text-primary">
          POST /api/compute/{group}/{method}
        </span>
        <AnimatePresence initial={false}>
          {decided ? (
            <motion.span
              key={`${call.seq}-verdict`}
              className={cx(
                'ms-auto shrink-0 rounded border px-1 text-[0.625rem] leading-4',
                call.verdict === 'allow' && 'border-text-primary bg-text-primary text-background-full',
                call.verdict === 'deny' && 'hatch border-text-primary text-text-primary',
                call.verdict === 'confirm' && 'border-dashed border-text-primary text-text-primary',
              )}
              initial={{ opacity: 0, scale: 0.85 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
            >
              {verdict}
            </motion.span>
          ) : null}
        </AnimatePresence>
      </div>
      <span className="min-w-0 truncate text-text-secondary" title={`${call.action} @ ${call.resource}`}>
        {call.action} @ {call.resource.slice(0, call.resource.indexOf('/') + 1)}
        {short(call.resource.slice(call.resource.indexOf('/') + 1))}
      </span>
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={`${call.seq}-${stage ?? 'done'}`}
          className="min-w-0 truncate text-text-tertiary"
          initial={{ opacity: 0, x: -4 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
        >
          {now}
        </motion.span>
      </AnimatePresence>
    </div>
  );
}

/** Frames per Session message kind; the kind of the latest non-heartbeat frame is outlined in ink for a moment. */
function FrameTally({
  byKind,
  flash,
  t,
}: {
  byKind: Record<FrameKind, number>;
  flash: State['flash'];
  t: number;
}) {
  return (
    <ul className="mt-2 flex min-h-[3.25rem] flex-wrap content-start gap-1" aria-label="Fleet frames by kind">
      {frameKinds.map((kind) => {
        const hot = flash?.kind === kind && t - flash.at < 700;
        return (
          <li
            key={kind}
            className={cx(
              'inline-flex items-center gap-1 rounded-md border px-1.5 font-mono text-[0.625rem] leading-4 transition-colors duration-200',
              toNode.has(kind) ? 'border-dashed' : '',
              hot
                ? 'border-text-primary bg-background-primary-default text-text-primary'
                : 'border-border-button-default bg-background-primary-default text-text-secondary',
            )}
          >
            {toNode.has(kind) ? (
              <>
                <span className="sr-only">to the node:</span>
                <span aria-hidden>←</span>
              </>
            ) : null}
            {kind}
            <span className="text-text-primary tabular-nums">{byKind[kind]}</span>
          </li>
        );
      })}
    </ul>
  );
}

function Counter({
  label,
  value,
  note,
  strong = false,
  zero = false,
  flip = false,
  dim,
  onPointerEnter,
  onPointerLeave,
}: {
  label: string;
  value: number;
  note: string;
  strong?: boolean;
  zero?: boolean;
  flip?: boolean;
  dim: boolean;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}) {
  return (
    <div
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      className={cx(
        'flex min-w-0 flex-col gap-0.5 rounded-lg border bg-background-primary-default px-3 py-2 shadow-xs transition-opacity duration-300',
        strong ? 'border-text-primary' : zero ? 'border-dashed border-text-primary' : 'border-border-button-default',
        dim && 'opacity-45',
      )}
    >
      <dt className="truncate text-caption-1-regular text-text-secondary">{label}</dt>
      <dd className="font-mono text-title-2-medium text-text-primary tabular-nums">
        {flip ? (
          <span className="relative inline-flex overflow-hidden">
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span
                key={value}
                initial={{ y: '70%', opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: '-70%', opacity: 0 }}
                transition={{ duration: 0.25, ease }}
              >
                {value}
              </motion.span>
            </AnimatePresence>
          </span>
        ) : (
          value
        )}
      </dd>
      <dd className="truncate text-caption-2-regular text-text-tertiary">{note}</dd>
    </div>
  );
}

const tagLabel: Record<RowTag, string> = { api: 'api', fleet: 'fleet', worker: 'worker', iam: 'iam' };

/** The latest traffic, newest first, with the IAM calls compute made for each. */
function Traffic({ rows, focusLane }: { rows: Row[]; focusLane: Lane | null }) {
  return (
    <motion.div
      className="flex h-full flex-col rounded-xl border border-border-button-default bg-background-primary-default shadow-xs"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.25, ease }}
    >
      <div className="flex items-center gap-2 border-b border-separator-border px-3 py-2">
        <span className="eyebrow">Traffic</span>
        <span className="ms-auto font-mono text-caption-2-regular text-text-tertiary">IAM calls</span>
      </div>
      {rows.length === 0 ? (
        <p className="px-3 py-3 text-caption-1-regular text-text-tertiary">
          Requests and notable frames appear here as they happen.
        </p>
      ) : (
        <ol className="flex flex-col">
          <AnimatePresence initial={false} mode="popLayout">
            {rows.map((row) => {
              const lane: Lane | null = row.tag === 'api' || row.tag === 'iam' ? 'api' : 'fleet';
              return (
                <motion.li
                  key={row.id}
                  layout
                  className={cx(
                    'flex h-8 min-w-0 items-center gap-2 border-b border-separator-border px-3 transition-opacity duration-300 last:border-b-0',
                    focusLane !== null && focusLane !== lane && 'opacity-40',
                  )}
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.3, ease }}
                >
                  <span className="w-10 shrink-0 font-mono text-[0.625rem] leading-4 tracking-wide text-text-tertiary uppercase">
                    {tagLabel[row.tag]}
                  </span>
                  <span className="w-16 shrink-0 truncate text-caption-1-medium text-text-primary">{row.who}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-caption-2-regular text-text-secondary">
                    {row.what}
                    <span className="hidden text-text-tertiary @md:inline"> · {row.detail}</span>
                  </span>
                  <IamCount value={row.iam} verdict={row.verdict} />
                </motion.li>
              );
            })}
          </AnimatePresence>
        </ol>
      )}
    </motion.div>
  );
}

/** Solid: one decision, allowed. Hatched: one decision, refused. Dashed ink: refused, confirmation asked. Dashed grey: none. */
function IamCount({ value, verdict }: { value: number | null; verdict?: Verdict }) {
  const label =
    value === null
      ? 'not a compute call'
      : value === 0
        ? 'no IAM call'
        : verdict === 'allow'
          ? 'one IAM decision, allowed'
          : verdict === 'deny'
            ? 'one IAM decision, refused'
            : 'one IAM decision, refused; confirmation requested';
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cx(
        'flex size-5 shrink-0 items-center justify-center rounded-full border font-mono text-[0.625rem] leading-none tabular-nums',
        value === null && 'border-transparent text-text-tertiary',
        value === 0 && 'border-dashed border-border-button-hover text-text-tertiary',
        value === 1 && verdict === 'allow' && 'border-text-primary bg-text-primary text-background-full',
        value === 1 && verdict === 'deny' && 'hatch border-text-primary text-text-primary',
        value === 1 && verdict === 'confirm' && 'border-dashed border-text-primary text-text-primary',
      )}
    >
      {value === null ? '–' : value}
    </span>
  );
}

/** What the person sees in Better IAM, and their two answers (`delegations.decideConfirmation`). */
function ConfirmationCard({
  confirmation: c,
  autoplay,
  onDecide,
  onHold,
}: {
  confirmation: Confirmation;
  autoplay: boolean;
  onDecide: (approve: boolean) => void;
  onHold: (holding: boolean) => void;
}) {
  const pending = c.status === 'pending';
  const progress = Math.min(1, c.waited / AUTO_DECIDE_MS);

  // Leaving the card releases the hold; unmounting it must too.
  useEffect(() => () => onHold(false), [onHold]);

  function onBlur(event: FocusEvent<HTMLElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onHold(false);
  }

  return (
    <motion.section
      aria-label="Confirmation request in Better IAM"
      onPointerEnter={() => onHold(true)}
      onPointerLeave={() => onHold(false)}
      onFocus={() => onHold(true)}
      onBlur={onBlur}
      className={cx(
        'flex h-full flex-col gap-2 rounded-xl border bg-background-primary-default p-3.5 shadow-sm',
        pending ? 'border-text-primary' : 'border-border-button-default',
      )}
      initial={{ opacity: 0, y: 8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.3, ease }}
    >
      <div className="flex min-w-0 items-center gap-2">
        <RiShieldKeyholeLine className="size-4 shrink-0 text-text-primary" aria-hidden />
        <span className="min-w-0 truncate text-body-2-medium text-text-primary">
          Better IAM · confirmation request
        </span>
        <span
          className={cx(
            'ms-auto shrink-0 rounded-md border px-1.5 font-mono text-[0.625rem] leading-4',
            c.status === 'pending' && 'border-dashed border-text-primary text-text-primary',
            c.status === 'approved' && 'border-text-primary bg-text-primary text-background-full',
            c.status === 'rejected' && 'hatch border-text-primary text-text-primary',
          )}
        >
          {c.status}
        </span>
      </div>
      <p className="text-caption-1-regular leading-5 text-text-secondary">
        <span className="text-caption-1-medium text-text-primary">Scheduler</span>, an agent acting for
        alice, asks to run{' '}
        <span className="font-mono text-caption-2-regular text-text-primary">compute:reservations:create</span>{' '}
        on <span className="font-mono text-caption-2-regular text-text-primary">{short(c.draft)}</span>.
      </p>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 font-mono text-caption-2-regular leading-4">
        <dt className="text-text-tertiary">confirmationId</dt>
        <dd className="truncate text-text-primary">{c.id}</dd>
        <dt className="text-text-tertiary">idempotencyKey</dt>
        <dd className="truncate text-text-primary">{c.key}</dd>
        <dt className="text-text-tertiary">draft</dt>
        <dd className="truncate text-text-primary">awaiting-confirmation, ≤ 30 min</dd>
      </dl>
      <div className="mt-auto flex min-w-0 flex-wrap items-center gap-2">
        {pending ? (
          <>
            <button
              type="button"
              onClick={() => onDecide(true)}
              className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-text-primary bg-text-primary px-3 text-caption-1-medium text-background-full transition-[opacity,scale] duration-200 hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-focus-ring active:scale-[0.98]"
            >
              <RiShieldCheckLine className="size-3.5" aria-hidden />
              Approve as alice
            </button>
            <button
              type="button"
              onClick={() => onDecide(false)}
              className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-border-button-default bg-background-primary-default px-3 text-caption-1-medium text-text-primary transition-[border-color,scale] duration-200 hover:border-border-button-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-focus-ring active:scale-[0.98]"
            >
              <RiShieldCrossLine className="size-3.5" aria-hidden />
              Reject
            </button>
          </>
        ) : (
          <p className="min-w-0 font-mono text-caption-2-regular leading-4 text-text-secondary">
            {c.status === 'approved'
              ? 'delegation:confirm · valid 900 s, used once by the retry'
              : 'delegation:reject · the agent stops polling getConfirmation'}
          </p>
        )}
        <span className="ms-auto hidden truncate font-mono text-[0.625rem] leading-4 text-text-tertiary @md:block">
          delegations.decideConfirmation
        </span>
      </div>
      {pending ? (
        <div className="flex items-center gap-2 text-caption-2-regular text-text-tertiary">
          <span className="relative h-px flex-1 overflow-hidden bg-border-button-default">
            <span
              className="absolute inset-y-0 left-0 bg-text-primary transition-[width] duration-100 ease-linear"
              style={{ width: autoplay ? `${progress * 100}%` : '0%' }}
            />
          </span>
          <span className="shrink-0">{autoplay ? 'Autoplay approves soon' : 'Waiting for you'}</span>
        </div>
      ) : null}
    </motion.section>
  );
}
