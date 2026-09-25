'use client';

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { AnimatePresence, motion, useInView } from 'motion/react';
import {
  RiArrowGoBackLine,
  RiCheckLine,
  RiCloseLine,
  RiHourglassLine,
  RiPencilLine,
  RiQuillPenLine,
  RiShieldCheckLine,
  RiShieldCrossLine,
} from 'react-icons/ri';
import { cx } from '@/utils/cx';
import { DiagramFrame, ReplayButton } from './frame';
import { ease, useReducedMotionSafe } from './motion';

/**
 * Tamper-evident audit, computed for real in the browser. Seven `audit_events` rows of tenant org_acme are the leaves
 * of an RFC 6962 Merkle tree: SHA-256 with the 0x00 leaf and 0x01 node prefixes over each row's canonical JSON, split
 * at the largest power of two below the size, exactly as `@better-compute/pki` (audit.ts) builds it. Checkpoint 2
 * signs that root with an ES256 audit key over the `bettercompute.v1/audit-checkpoint` signing input. Picking a row
 * plays its inclusion proof up the tree; editing a row, or rewriting the checkpoint's root to match, fails the proof
 * the way `verifyAuditProof` and `better-compute audit verify` do. The key is generated for this page.
 */

// --- The shapes @better-compute/core and @better-compute/audit hash ------------------------------------------------

type Bytes = Uint8Array<ArrayBuffer>;

/** `AdmissionContext` (core/domain.ts): what the envelope stores with every allowed mutation. */
interface AdmissionContext {
  tenantId: string;
  identityId: string;
  identityKind: 'user' | 'service' | 'agent';
  sessionId: string;
  sessionKind: 'user' | 'role' | 'api-key' | 'session-token' | 'delegated';
  requestId?: string;
  action: string;
  resource: { type: string; id: string };
  decidedAt: number;
}

/** `AuditLeaf` (audit/checkpoints.ts): an `audit_events` row as hashed, time in microseconds. */
interface AuditLeaf {
  id: string;
  tenantId: string;
  occurredAtUs: string;
  action: string;
  resourceType: string;
  resourceId: string;
  admission: AdmissionContext | null;
  details: Record<string, unknown> | null;
}

/** `AuditCheckpointBody`: what a checkpoint signs, as canonical JSON. */
interface AuditCheckpointBody {
  v: 1;
  tenantId: string;
  sequence: number;
  from: string;
  to: string;
  size: number;
  root: string;
  previous: string | null;
}

/** A change someone could make to a row directly in the database. */
interface Edit {
  field: string;
  from: string;
  to: string;
  apply: (leaf: AuditLeaf) => AuditLeaf;
}

interface Row {
  leaf: AuditLeaf;
  /** The row's place in commit order, `<txid>.<seq>`. */
  cursor: string;
  /** Absent for the row the checkpoint has not sealed yet. */
  edit?: Edit;
}

// --- One hour of org_acme's audit trail ---------------------------------------------------------------------------

const TENANT = 'org_acme';
const HOUR_US = 3_600_000_000;

/** Epoch microseconds, as `extract(epoch FROM occurred_at) * 1000000` returns them. */
const at = (h: number, m: number, s: number, micros: number) =>
  String(Date.UTC(2026, 8, 24, h, m, s) * 1000 + micros);

/** hh:mm:ss (UTC) of an `occurredAtUs`. */
const clock = (occurredAtUs: string) =>
  new Date(Math.floor(Number(occurredAtUs) / 1000)).toISOString().slice(11, 19);

const shortId = (id: string) => `${id.slice(0, 12)}…`;

const olivia = { identityId: 'usr_olivia', sessionId: 'ses_01m39m5dt0v230svn886ngx3p0' };
const alice = { identityId: 'usr_alice', sessionId: 'ses_01m39nkx3r4krk56knz1199qdr' };
const aliceEarlier = { identityId: 'usr_alice', sessionId: 'ses_01m39h28yr33a9sazvnmsxkjp1' };
const bob = { identityId: 'usr_bob', sessionId: 'ses_01m39qzstge2tf0ez8a01f6m84' };

const pool = { type: 'compute-pool', id: 'pool_01m39b2ywgsdk27cf3cg7k3k9v' };
const node = { type: 'compute-node', id: 'node_01m39n4xr282tks96wbnv554s2' };
// Reservation ids are request-as-resource drafts: rsv_ + base32(sha256(tenant, identity, idempotency key)).
const reservation = {
  type: 'compute-reservation',
  id: 'rsv_e7r7ekf7hzwcsz744s2zbe07f0r97s26hh6xdkqp9vbxvrvnbgk0',
};
const bobsReservation = {
  type: 'compute-reservation',
  id: 'rsv_hbh8a1g6vt7hq5jwxzhjkmnht3smzh8z5dafwct5a22xrt090s5g',
};
const earlierReservation = {
  type: 'compute-reservation',
  id: 'rsv_nppt2z2c43ejx73gatt91ec5c97enj5ayz0t3mtms0my3aen9hx0',
};

/** The row the envelope's `recordAudit` writes for an allowed mutation: its admission context, no details. */
function mutation(
  id: string,
  occurredAtUs: string,
  caller: { identityId: string; sessionId: string },
  requestId: string,
  action: string,
  resource: { type: string; id: string },
): AuditLeaf {
  return {
    id,
    tenantId: TENANT,
    occurredAtUs,
    action,
    resourceType: resource.type,
    resourceId: resource.id,
    admission: {
      tenantId: TENANT,
      identityId: caller.identityId,
      identityKind: 'user',
      sessionId: caller.sessionId,
      sessionKind: 'user',
      requestId,
      action,
      resource,
      // IAM decides just before the method's transaction starts.
      decidedAt: Math.floor(Number(occurredAtUs) / 1000) - 12,
    },
    details: null,
  };
}

const reassign = (from: string, to: string): Edit => ({
  field: 'admission.identityId',
  from,
  to,
  apply: (leaf) => ({
    ...leaf,
    admission: leaf.admission && { ...leaf.admission, identityId: to },
  }),
});

const backdate = (occurredAtUs: string): Edit => {
  const earlier = String(Number(occurredAtUs) - HOUR_US);
  return {
    field: 'occurredAtUs',
    from: clock(occurredAtUs),
    to: clock(earlier),
    apply: (leaf) => ({ ...leaf, occurredAtUs: earlier }),
  };
};

const rows: Row[] = [
  {
    cursor: '48305.1190',
    leaf: mutation(
      'aud_01m39mrwbaspap5zy8tvhk16ee',
      at(12, 3, 17, 482913),
      olivia,
      'req_01m39mrwazqgjb0d5v6rj8nffv',
      'compute:join-tokens:create',
      pool,
    ),
    edit: reassign('usr_olivia', 'usr_bob'),
  },
  {
    cursor: '48337.1192',
    // Written by the JoinService itself: details instead of an admission context.
    leaf: {
      id: 'aud_01m39n4xr2t49c2ff618680fat',
      tenantId: TENANT,
      occurredAtUs: at(12, 9, 52, 130477),
      action: 'node.joined',
      resourceType: 'node',
      resourceId: node.id,
      admission: null,
      details: {
        attestor: 'join-token',
        tokenId: 'jt_01m39mrway0rkcppggmamfb1pa',
        serial: '5d4285e2fb28592c3817c427c2240f22',
        revoked: [],
        hardwareKey: null,
        hardwareKeyTrusted: false,
      },
    },
    edit: {
      field: 'details.attestor',
      from: 'join-token',
      to: 'provisioned',
      apply: (leaf) => ({ ...leaf, details: { ...leaf.details, attestor: 'provisioned' } }),
    },
  },
  {
    cursor: '48412.1196',
    leaf: mutation(
      'aud_01m39nth4pmc4bvyhqxhpf51k6',
      at(12, 21, 40, 118204),
      alice,
      'req_01m39nth45eqydw7n0ah984vc6',
      'compute:reservations:create',
      reservation,
    ),
    edit: reassign('usr_alice', 'usr_bob'),
  },
  {
    cursor: '48560.1201',
    leaf: mutation(
      'aud_01m39ph9ee9xvcg5xe2xhpr0tc',
      at(12, 34, 5, 902311),
      olivia,
      'req_01m39ph9e2p4jkzrym1pmmxnma',
      'compute:nodes:cordon',
      node,
    ),
    edit: backdate(at(12, 34, 5, 902311)),
  },
  {
    cursor: '48561.1202',
    leaf: mutation(
      'aud_01m39ph9x9nk680r6c7rdrd3sb',
      at(12, 34, 6, 377150),
      olivia,
      'req_01m39ph9wy991s2xf40z8paebh',
      'compute:nodes:drain',
      node,
    ),
    edit: reassign('usr_olivia', 'usr_bob'),
  },
  {
    cursor: '48790.1209',
    leaf: mutation(
      'aud_01m39q9vb8mzdysq0ebt2yjdct',
      at(12, 47, 30, 664018),
      alice,
      'req_01m39q9vatbvn8fxp5qvt0xbzq',
      'compute:reservations:extend',
      reservation,
    ),
    edit: reassign('usr_alice', 'usr_bob'),
  },
  {
    cursor: '48951.1214',
    leaf: mutation(
      'aud_01m39qxdwt52jyet2e19gp1st3',
      at(12, 58, 12, 250846),
      alice,
      'req_01m39qxdwfaax93hq34f3fj6b4',
      'compute:reservations:release',
      reservation,
    ),
    edit: {
      field: 'resourceId',
      from: shortId(reservation.id),
      to: shortId(bobsReservation.id),
      apply: (leaf) => ({ ...leaf, resourceId: bobsReservation.id }),
    },
  },
  {
    // Committed after the 13:00 pass moved the cursor: the 14:00 pass seals it.
    cursor: '49012.1219',
    leaf: mutation(
      'aud_01m39r5q9knz0k1vqchzb732gp',
      at(13, 2, 44, 19337),
      bob,
      'req_01m39r5q953tsr2v6rq0dsq1m2',
      'compute:reservations:create',
      bobsReservation,
    ),
  },
];

/** The rows checkpoint 1 sealed at 12:00. Not shown: only its body's hash reaches checkpoint 2, as `previous`. */
const earlierRows: AuditLeaf[] = [
  mutation(
    'aud_01m39hv7b7eqvzggyzzbk4jn7m',
    at(11, 12, 8, 551204),
    aliceEarlier,
    'req_01m39hv7awv9j5hkxzn3rcavgm',
    'compute:reservations:create',
    earlierReservation,
  ),
  mutation(
    'aud_01m39jp3bqvg1cyq0bp6cxwg66',
    at(11, 26, 49, 207733),
    aliceEarlier,
    'req_01m39jp3b6t7znypvcfvfz8n4a',
    'compute:reservations:extend',
    earlierReservation,
  ),
  mutation(
    'aud_01m39kebeex377zw8c4rceqvtx',
    at(11, 40, 3, 918015),
    aliceEarlier,
    'req_01m39kebdw8bqsdfce8n86p71t',
    'compute:reservations:extend',
    earlierReservation,
  ),
  mutation(
    'aud_01m39mab3m8r066jn49mjf0x10',
    at(11, 55, 21, 76410),
    aliceEarlier,
    'req_01m39mab34pw27tkmc2fr19433',
    'compute:reservations:release',
    earlierReservation,
  ),
];

/** The global commit-cursor ranges (from, to] of the two hourly passes. */
const FIRST = { from: '48017.1102', to: '48288.1188' };
const SECOND = { from: '48288.1188', to: '48960.1215' };

/** Rows sealed by checkpoint 2; the last row of `rows` is not. */
const SIZE = 7;

// --- RFC 6962 hashing, canonical JSON and the signing input, as @better-compute/pki and /protocol do them ----------

const utf8 = new TextEncoder();

function concat(parts: readonly Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

async function sha256(...parts: Uint8Array[]): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', concat(parts)));
}

/** RFC 6962 leaf hash: SHA-256(0x00 ‖ data). */
const merkleLeafHash = (data: Uint8Array) => sha256(Uint8Array.of(0), data);
/** RFC 6962 node hash: SHA-256(0x01 ‖ left ‖ right). */
const nodeHash = (left: Uint8Array, right: Uint8Array) => sha256(Uint8Array.of(1), left, right);

/** Canonical JSON: sorted keys, no whitespace, `undefined` members dropped. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

/** `auditLeafHash`: RFC 6962 over the row's canonical JSON. */
const auditLeafHash = (leaf: AuditLeaf) => merkleLeafHash(utf8.encode(canonicalJson(leaf)));

/** `"bettercompute.v1/" ‖ purpose ‖ 0x00 ‖ (uint32_be(len) ‖ part)*`: the bytes an ES256 signature covers. */
function signingInput(purpose: string, parts: readonly Uint8Array[]): Bytes {
  const head = utf8.encode(`bettercompute.v1/${purpose}\0`);
  const out = new Uint8Array(
    parts.reduce((total, part) => total + 4 + part.byteLength, head.byteLength),
  );
  const view = new DataView(out.buffer);
  out.set(head, 0);
  let offset = head.byteLength;
  for (const part of parts) {
    view.setUint32(offset, part.byteLength);
    out.set(part, offset + 4);
    offset += 4 + part.byteLength;
  }
  return out;
}

const ES256 = { name: 'ECDSA', hash: 'SHA-256' } as const;

function base64(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
const base64url = (bytes: Uint8Array) =>
  base64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function equal(a: Uint8Array, b: Uint8Array) {
  return a.byteLength === b.byteLength && a.every((byte, index) => byte === b[index]);
}

/** A subtree over leaves [start, end). Its shape follows RFC 6962's split, so it is known before any hashing. */
interface Shape {
  id: string;
  start: number;
  end: number;
  level: number;
  left?: Shape;
  right?: Shape;
}

/** The largest power of two below `n` (n ≥ 2). */
function split(n: number) {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

function shape(start: number, end: number): Shape {
  if (end - start === 1) return { id: `${start}`, start, end, level: 0 };
  const k = split(end - start);
  const left = shape(start, start + k);
  const right = shape(start + k, end);
  return {
    id: `${start}-${end}`,
    start,
    end,
    level: Math.max(left.level, right.level) + 1,
    left,
    right,
  };
}

/** `merkleRoot`, recording every subtree's hash on the way. */
async function hashTree(
  tree: Shape,
  leaves: readonly Bytes[],
  out: Map<string, Bytes>,
): Promise<Bytes> {
  const hash =
    tree.left && tree.right
      ? await nodeHash(
          await hashTree(tree.left, leaves, out),
          await hashTree(tree.right, leaves, out),
        )
      : leaves[tree.start]!;
  out.set(tree.id, hash);
  return hash;
}

/** `merkleInclusionProof`: the subtrees whose roots form leaf `index`'s audit path, bottom-up. */
function proofOf(tree: Shape, index: number): Shape[] {
  if (!tree.left || !tree.right) return [];
  const k = tree.left.end - tree.left.start;
  return index < k
    ? [...proofOf(tree.left, index), tree.right]
    : [...proofOf(tree.right, index - k), tree.left];
}

/** The nodes a verifier recomputes for leaf `index`: the leaf, then each parent up to the root. */
function pathOf(tree: Shape, index: number): Shape[] {
  if (!tree.left || !tree.right) return [tree];
  const k = tree.left.end - tree.left.start;
  return [...(index < k ? pathOf(tree.left, index) : pathOf(tree.right, index - k)), tree];
}

interface Walk {
  ok: boolean;
  /** Each hash the verifier computes, and on which side the proof's sibling went. */
  steps: { side: 'left' | 'right'; hash: Bytes }[];
}

/** `verifyMerkleInclusion` (RFC 9162 §2.1.3.2), step for step. */
async function verifyMerkleInclusion(
  leaf: Bytes,
  index: number,
  size: number,
  proof: readonly Bytes[],
  root: Bytes,
): Promise<Walk> {
  const steps: Walk['steps'] = [];
  if (!(Number.isInteger(index) && Number.isInteger(size) && index >= 0 && index < size))
    return { ok: false, steps };
  let fn = index;
  let sn = size - 1;
  let hash = leaf;
  for (const sibling of proof) {
    if (sn === 0) return { ok: false, steps };
    if (fn % 2 === 1 || fn === sn) {
      hash = await nodeHash(sibling, hash);
      steps.push({ side: 'left', hash });
      while (fn % 2 === 0 && fn !== 0) {
        fn = Math.floor(fn / 2);
        sn = Math.floor(sn / 2);
      }
    } else {
      hash = await nodeHash(hash, sibling);
      steps.push({ side: 'right', hash });
    }
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  return { ok: sn === 0 && equal(hash, root), steps };
}

const TREE = shape(0, SIZE);

/** Every subtree with its parent, root first. */
const subtrees: { tree: Shape; parent?: Shape }[] = [];
(function walk(tree: Shape, parent?: Shape) {
  subtrees.push({ tree, parent });
  if (tree.left) walk(tree.left, tree);
  if (tree.right) walk(tree.right, tree);
})(TREE);

// --- Sealing (the 13:00 pass) and verifying (whenever the reader changes something) ------------------------------

interface Sealed {
  publicKey: CryptoKey;
  /** `sha256/` + base64 SHA-256 of the key's SPKI: what `--pin` and BETTER_COMPUTE_AUDIT_PIN hold. */
  pin: string;
  /** base64url SHA-1 of the public key, as `createSigningKey` names it. */
  kid: string;
  leaves: Bytes[];
  nodes: Map<string, Bytes>;
  root: Bytes;
  body: AuditCheckpointBody;
  bodyText: string;
  signature: Bytes;
}

/** Makes the audit key, seals checkpoint 1 and then checkpoint 2 the way `checkpointAudit` does. */
async function seal(): Promise<Sealed> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('WebCrypto is not available here');
  const keys = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
    'sign',
    'verify',
  ]);
  const spki = new Uint8Array(await subtle.exportKey('spki', keys.publicKey));
  const point = new Uint8Array(await subtle.exportKey('raw', keys.publicKey));
  const pin = `sha256/${base64(await sha256(spki))}`;
  const kid = base64url(new Uint8Array(await subtle.digest('SHA-1', point)));

  const earlier = await Promise.all(earlierRows.map(auditLeafHash));
  const first: AuditCheckpointBody = {
    v: 1,
    tenantId: TENANT,
    sequence: 1,
    ...FIRST,
    size: earlier.length,
    root: base64url(await hashTree(shape(0, earlier.length), earlier, new Map())),
    previous: null,
  };

  const leaves = await Promise.all(rows.slice(0, SIZE).map((row) => auditLeafHash(row.leaf)));
  const nodes = new Map<string, Bytes>();
  const root = await hashTree(TREE, leaves, nodes);
  const body: AuditCheckpointBody = {
    v: 1,
    tenantId: TENANT,
    sequence: 2,
    ...SECOND,
    size: SIZE,
    root: base64url(root),
    // The link to the tenant's previous checkpoint: SHA-256 of its exact body text.
    previous: base64url(await sha256(utf8.encode(canonicalJson(first)))),
  };
  const bodyText = canonicalJson(body);
  const signature = new Uint8Array(
    await subtle.sign(
      ES256,
      keys.privateKey,
      signingInput('audit-checkpoint', [utf8.encode(bodyText)]),
    ),
  );
  return { publicKey: keys.publicKey, pin, kid, leaves, nodes, root, body, bodyText, signature };
}

type Problem = 'signature' | 'root';

interface View {
  key: string;
  selected: number;
  forged: boolean;
  leaves: Bytes[];
  nodes: Map<string, Bytes>;
  body: AuditCheckpointBody;
  signatureOk: boolean;
  /** Null for the unsealed row: `proveAuditEvent` answers NOT_FOUND. */
  proof: { leaf: Bytes; walk: Walk; tenantOk: boolean } | null;
  valid: boolean | null;
  /** What `verifyAuditCheckpoints` reports for checkpoint 2, in its order. */
  problems: Problem[];
}

const stateKey = (selected: number, edits: readonly number[], forged: boolean) =>
  `${selected}|${edits.join(',')}|${forged ? 1 : 0}`;

/** Rebuilds the tree from the rows as they are now and checks the selected row's proof against the checkpoint. */
async function evaluate(
  sealed: Sealed,
  selected: number,
  edits: readonly number[],
  forged: boolean,
): Promise<View> {
  const leaves = await Promise.all(
    rows
      .slice(0, SIZE)
      .map((row, index) =>
        edits.includes(index) && row.edit
          ? auditLeafHash(row.edit.apply(row.leaf))
          : Promise.resolve(sealed.leaves[index]!),
      ),
  );
  const nodes = new Map<string, Bytes>();
  const root = await hashTree(TREE, leaves, nodes);
  // Forging: the attacker writes the edited rows' root into the stored body. They have no audit key, so the
  // signature stays the one made over the original bytes.
  const body = forged ? { ...sealed.body, root: base64url(root) } : sealed.body;
  const bodyRoot = forged ? root : sealed.root;
  const signatureOk = await crypto.subtle.verify(
    ES256,
    sealed.publicKey,
    sealed.signature,
    signingInput('audit-checkpoint', [utf8.encode(canonicalJson(body))]),
  );
  let proof: View['proof'] = null;
  if (selected < SIZE) {
    // `proveAuditEvent` builds the path from the rows in the checkpoint's range as they are now.
    const siblings = proofOf(TREE, selected).map((tree) => nodes.get(tree.id)!);
    const walk = await verifyMerkleInclusion(
      leaves[selected]!,
      selected,
      body.size,
      siblings,
      bodyRoot,
    );
    proof = {
      leaf: leaves[selected]!,
      walk,
      tenantOk: rows[selected]!.leaf.tenantId === body.tenantId,
    };
  }
  const problems: Problem[] = [];
  if (!signatureOk) problems.push('signature');
  if (!equal(root, bodyRoot)) problems.push('root');
  return {
    key: stateKey(selected, edits, forged),
    selected,
    forged,
    leaves,
    nodes,
    body,
    signatureOk,
    proof,
    valid: proof ? signatureOk && proof.tenantOk && proof.walk.ok : null,
    problems,
  };
}

// --- Layout ---------------------------------------------------------------------------------------------------------

/** Horizontal slots: the seven sealed rows, then the unsealed one. */
const SLOTS = rows.length;
/** Chip top and height by tree level (0 = leaves, 3 = root). */
const TOP = [172, 116, 60, 4];
const CHIP = [28, 24, 24, 28];
const TREE_HEIGHT = 238;
/** How long the verifier spends on each step of the walk up the tree. */
const STEP = 0.14;

const hashText = (value: Bytes | undefined, length: number) =>
  value ? base64url(value).slice(0, length) : '·'.repeat(length);

function listRows(indexes: readonly number[]) {
  const names = indexes.map((index) => `#${index}`);
  return names.length === 1
    ? `Row ${names[0]} was`
    : `Rows ${names.slice(0, -1).join(', ')} and ${names.at(-1)} were`;
}

function storyOf(selected: number, edits: readonly number[], forged: boolean) {
  if (selected >= SIZE)
    return `Row #${selected} committed at ${clock(rows[selected]!.leaf.occurredAtUs)}, after the 13:00 pass moved the cursor to ${SECOND.to}. Until the next hourly pass seals it, audit prove answers NOT_FOUND.`;
  if (edits.length === 0)
    return `Row #${selected} is leaf ${selected} of ${SIZE} in checkpoint 2. Its proof is ${proofOf(TREE, selected).length} sibling hashes: hashing up from the leaf rebuilds the root the audit key signed.`;
  if (forged)
    return 'The attacker also writes the new root into the checkpoint. The path reaches it now, but the signature covers the old bytes, and signing new ones takes the audit key: verifiers hold only its pin.';
  if (edits.includes(selected))
    return `Row #${selected} was edited in the database. Its leaf hash changed, so the path climbs to a root the audit key never signed.`;
  return `${listRows(edits)} edited. Row #${selected} is untouched, but its proof is built from the rows as they are now: it carries the changed subtree hash and misses the signed root too.`;
}

function announcement(view: View | null) {
  if (!view) return '';
  if (view.valid === null) return `Row ${view.selected} is not sealed yet: NOT_FOUND.`;
  return view.valid
    ? `The proof for row ${view.selected} verifies against the signed checkpoint.`
    : `The proof for row ${view.selected} fails: INVALID_PROOF. audit verify reports ${view.problems.join(' and ')}.`;
}

// --- The demo -------------------------------------------------------------------------------------------------------

export function MerkleAudit() {
  const [selected, setSelected] = useState(2);
  const [edits, setEdits] = useState<number[]>([]);
  const [forged, setForged] = useState(false);
  const [sealed, setSealed] = useState<Sealed | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const reduced = useReducedMotionSafe();
  const treeRef = useRef<HTMLDivElement>(null);
  const inView = useInView(treeRef, { once: true, amount: 0.3 });
  // Edges are drawn in real pixels so pathLength animates cleanly.
  const [width, setWidth] = useState(560);

  useEffect(() => {
    let live = true;
    seal().then(
      (next) => {
        if (live) setSealed(next);
      },
      () => {
        if (live) setUnsupported(true);
      },
    );
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!sealed) return;
    let live = true;
    void evaluate(sealed, selected, edits, forged).then((next) => {
      if (live) setView(next);
    });
    return () => {
      live = false;
    };
  }, [sealed, selected, edits, forged]);

  useEffect(() => {
    const element = treeRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  function toggleEdit(index: number) {
    const editing = !edits.includes(index);
    const next = editing
      ? [...edits, index].sort((a, b) => a - b)
      : edits.filter((item) => item !== index);
    setEdits(next);
    if (next.length === 0) setForged(false);
    if (editing) setSelected(index);
  }

  const tampered = edits.length > 0 || forged;
  const walkKey = stateKey(selected, edits, forged);
  const story = storyOf(selected, edits, forged);

  return (
    <DiagramFrame
      label={
        <>
          Audit checkpoints · tenant {TENANT}
          <span className="hidden text-text-tertiary sm:inline"> · pick a row, then edit it</span>
        </>
      }
      live
      bodyClassName="p-0 sm:p-0"
      actions={
        <AnimatePresence initial={false}>
          {tampered ? (
            <motion.span
              key="restore"
              initial={{ opacity: 0, x: 6 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 6 }}
              transition={{ duration: 0.2 }}
            >
              <ReplayButton
                onClick={() => {
                  setEdits([]);
                  setForged(false);
                }}
                label="Restore"
              />
            </motion.span>
          ) : null}
        </AnimatePresence>
      }
      footer="Hashes and the ES256 signature are computed in your browser with WebCrypto, byte for byte as @better-compute/pki computes them. The audit key is made for this page and never leaves it."
    >
      <div className="@container p-4 sm:p-6">
        <AnimatePresence mode="wait" initial={false}>
          <motion.p
            key={story}
            className="mb-5 min-h-10 text-body-2-regular leading-5 text-text-secondary"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.2 }}
          >
            {story}
          </motion.p>
        </AnimatePresence>

        <div className="grid items-start gap-5 @3xl:grid-cols-12 @3xl:gap-x-6">
          <div className="min-w-0 @3xl:col-span-7 @3xl:col-start-6 @3xl:row-start-1">
            <div ref={treeRef} className="relative w-full" style={{ height: TREE_HEIGHT }}>
              <MerkleTree
                width={width}
                selected={selected}
                sealed={sealed}
                view={view}
                inView={inView}
                reduced={reduced}
                walkKey={walkKey}
                onSelect={setSelected}
              />
            </div>
            <Legend />
          </div>

          <div className="min-w-0 @3xl:col-span-5 @3xl:col-start-1 @3xl:row-start-1">
            <EventList
              selected={selected}
              edits={edits}
              onSelect={setSelected}
              onToggleEdit={toggleEdit}
            />
          </div>

          <div className="min-w-0 @3xl:col-span-5 @3xl:col-start-1 @3xl:row-start-2">
            <CheckpointCard
              sealed={sealed}
              view={view}
              canForge={edits.length > 0}
              forged={forged}
              onForge={() => setForged((value) => !value)}
              reduced={reduced}
            />
          </div>

          <div className="min-w-0 @3xl:col-span-7 @3xl:col-start-6 @3xl:row-start-2">
            <Verifier view={view} sealed={sealed} unsupported={unsupported} reduced={reduced} />
          </div>
        </div>
        {/* Always mounted, so screen readers hear each new verdict. */}
        <p className="sr-only" aria-live="polite">
          {announcement(view)}
        </p>
      </div>
    </DiagramFrame>
  );
}

// --- The tree -------------------------------------------------------------------------------------------------------

/** Solid ink: on the verifier's path. Outline: a hash the proof supplies. Hatched: not what the key signed. */
function chipClass({
  onPath,
  sibling,
  changed,
}: {
  onPath: boolean;
  sibling: boolean;
  changed: boolean;
}) {
  if (changed)
    return cx(
      'hatch border-text-primary bg-background-primary-default text-text-primary',
      onPath && 'outline-1 outline-offset-2 outline-text-primary',
    );
  if (onPath) return 'border-text-primary bg-text-primary text-background-full';
  if (sibling) return 'border-text-primary bg-background-primary-default text-text-primary';
  return 'border-border-button-default bg-background-primary-default text-text-secondary';
}

function MerkleTree({
  width,
  selected,
  sealed,
  view,
  inView,
  reduced,
  walkKey,
  onSelect,
}: {
  width: number;
  selected: number;
  sealed: Sealed | null;
  view: View | null;
  inView: boolean;
  reduced: boolean;
  walkKey: string;
  onSelect: (index: number) => void;
}) {
  const slot = (index: number) => ((index + 0.5) / SLOTS) * width;
  const xOf = (tree: Shape) => (slot(tree.start) + slot(tree.end - 1)) / 2;
  const sealedRow = selected < SIZE;
  const path = sealedRow ? pathOf(TREE, selected) : [];
  const proof = sealedRow ? proofOf(TREE, selected) : [];
  const pathStep = new Map(path.map((tree, index) => [tree.id, index]));
  const proofStep = new Map(proof.map((tree, index) => [tree.id, index]));
  const changedAt = (tree: Shape) => {
    const now = view?.nodes.get(tree.id);
    const then = sealed?.nodes.get(tree.id);
    return Boolean(now && then && !equal(now, then));
  };
  const rootChanged = changedAt(TREE);
  const delayOf = (step: number | undefined) => (reduced || step === undefined ? 0 : step * STEP);
  const bracketY = TOP[0]! + CHIP[0]! + 8;
  const divider = (SIZE / SLOTS) * width;

  return (
    <>
      <svg
        className="pointer-events-none absolute inset-0 overflow-visible"
        width={width}
        height={TREE_HEIGHT}
        viewBox={`0 0 ${width} ${TREE_HEIGHT}`}
        aria-hidden
      >
        {subtrees.map(({ tree, parent }) => {
          if (!parent) return null;
          // Drawn from the child up, the direction the verifier walks.
          const x1 = xOf(tree);
          const y1 = TOP[tree.level]!;
          const x2 = xOf(parent);
          const y2 = TOP[parent.level]! + CHIP[parent.level]!;
          const mid = (y1 + y2) / 2;
          const d = `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`;
          const step = pathStep.get(tree.id);
          const onPath = step !== undefined && pathStep.has(parent.id);
          const sib = proofStep.get(tree.id);
          const sibling = sib !== undefined && pathStep.has(parent.id);
          return (
            <g key={tree.id}>
              <motion.path
                d={d}
                fill="none"
                stroke="currentColor"
                strokeWidth={1}
                className="text-text-tertiary"
                initial={{ pathLength: 0, opacity: 0.7 }}
                animate={{ pathLength: inView ? 1 : 0, opacity: onPath || sibling ? 0.2 : 0.7 }}
                transition={{
                  pathLength: { duration: 0.6, delay: 0.15 + tree.level * 0.12, ease },
                  opacity: { duration: 0.2 },
                }}
              />
              {onPath && inView ? (
                <motion.path
                  key={`${walkKey}-path`}
                  d={d}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.75}
                  className="text-text-primary"
                  initial={{ pathLength: reduced ? 1 : 0 }}
                  animate={{ pathLength: 1 }}
                  transition={{ duration: 0.3, delay: delayOf(step), ease }}
                />
              ) : null}
              {sibling && inView ? (
                <motion.path
                  key={`${walkKey}-sibling`}
                  d={d}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.25}
                  strokeDasharray="3 3"
                  className="text-text-primary"
                  initial={{ opacity: reduced ? 1 : 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.25, delay: delayOf(sib) }}
                />
              ) : null}
            </g>
          );
        })}
        {/* The checkpoint's range under the sealed leaves, and the cursor line after it. */}
        <motion.path
          d={`M ${slot(0) - 14} ${bracketY - 5} V ${bracketY} H ${slot(SIZE - 1) + 14} V ${bracketY - 5}`}
          fill="none"
          stroke="currentColor"
          strokeWidth={1}
          className="text-text-tertiary"
          initial={{ opacity: 0 }}
          animate={{ opacity: inView ? 1 : 0 }}
          transition={{ duration: 0.4, delay: 0.5 }}
        />
        <motion.line
          x1={divider}
          x2={divider}
          y1={TOP[1]}
          y2={bracketY + 4}
          stroke="currentColor"
          strokeWidth={1}
          strokeDasharray="2 4"
          className="text-text-tertiary"
          initial={{ opacity: 0 }}
          animate={{ opacity: inView ? 1 : 0 }}
          transition={{ duration: 0.4, delay: 0.5 }}
        />
      </svg>

      {subtrees.map(({ tree }) => {
        const leaf = tree.level === 0;
        const isRoot = tree === TREE;
        const step = pathStep.get(tree.id);
        const sib = proofStep.get(tree.id);
        const changed = changedAt(tree);
        const onPath = step !== undefined;
        const delay = delayOf(onPath ? step : sib);
        const hash = view?.nodes.get(tree.id);
        const reveal = {
          initial: { opacity: 0, y: 6 },
          animate: inView ? { opacity: 1, y: 0 } : undefined,
          transition: { duration: 0.45, ease, delay: 0.1 + tree.level * 0.12 + tree.start * 0.02 },
        };
        const tag =
          sib !== undefined ? (
            <span className="absolute -top-2 -right-2 rounded-full border border-text-primary bg-background-primary-default px-1 font-mono text-[0.5625rem] leading-3.5 text-text-primary">
              p{sib}
            </span>
          ) : null;
        const chip = cx(
          'absolute flex -translate-x-1/2 items-center justify-center gap-1 rounded-md border font-mono whitespace-nowrap shadow-xs transition-[background-color,border-color,color,outline-color,translate] duration-300',
          chipClass({ onPath, sibling: sib !== undefined, changed }),
        );
        if (leaf) {
          const row = rows[tree.start]!;
          return (
            <motion.button
              key={tree.id}
              type="button"
              // The list below is the keyboard path; the tree is a pointer shortcut to the same choice.
              tabIndex={-1}
              onClick={() => onSelect(tree.start)}
              aria-pressed={selected === tree.start}
              aria-label={`Row #${tree.start}, ${row.leaf.action}`}
              title={`#${tree.start} · ${row.leaf.action} · ${clock(row.leaf.occurredAtUs)} · commit ${row.cursor}`}
              className={cx(
                chip,
                'h-7 min-w-7 cursor-pointer px-1.5 text-caption-2-medium tabular-nums motion-safe:hover:-translate-y-0.5',
              )}
              style={{ left: xOf(tree), top: TOP[0], transitionDelay: `${delay}s` }}
              {...reveal}
            >
              #{tree.start}
              {tag}
            </motion.button>
          );
        }
        return (
          <motion.div
            key={tree.id}
            aria-hidden
            className={cx(
              chip,
              isRoot ? 'h-7 px-2 text-caption-2-regular' : 'h-6 px-1.5 text-caption-2-regular',
            )}
            style={{ left: xOf(tree), top: TOP[tree.level], transitionDelay: `${delay}s` }}
            {...reveal}
          >
            {isRoot ? <span className="font-sans text-caption-2-medium">root</span> : null}
            <HashText
              text={hashText(hash, isRoot ? 6 : 5)}
              delay={reduced ? 0 : tree.level * 0.06}
            />
            {tag}
            {isRoot ? <RootTag changed={rootChanged} view={view} /> : null}
          </motion.div>
        );
      })}

      {/* The row after the cursor: committed, not sealed. */}
      <motion.button
        type="button"
        tabIndex={-1}
        onClick={() => onSelect(SIZE)}
        aria-pressed={selected === SIZE}
        aria-label={`Row #${SIZE}, ${rows[SIZE]!.leaf.action}, not sealed yet`}
        title={`#${SIZE} · ${rows[SIZE]!.leaf.action} · ${clock(rows[SIZE]!.leaf.occurredAtUs)} · commit ${rows[SIZE]!.cursor}`}
        className={cx(
          'absolute flex h-7 min-w-7 -translate-x-1/2 cursor-pointer items-center justify-center rounded-md border border-dashed bg-background-primary-default px-1.5 font-mono text-caption-2-medium tabular-nums transition-colors duration-300 motion-safe:hover:-translate-y-0.5',
          selected === SIZE
            ? 'border-text-primary text-text-primary outline-1 outline-offset-2 outline-text-primary'
            : 'border-border-button-active text-text-tertiary hover:text-text-primary',
        )}
        style={{ left: slot(SIZE), top: TOP[0] }}
        initial={{ opacity: 0, y: 6 }}
        animate={inView ? { opacity: 1, y: 0 } : undefined}
        transition={{ duration: 0.45, ease, delay: 0.3 }}
      >
        #{SIZE}
      </motion.button>

      <span
        aria-hidden
        className="absolute -translate-x-1/2 text-caption-2-regular whitespace-nowrap text-text-tertiary"
        style={{ left: xOf(TREE), top: bracketY + 6 }}
      >
        checkpoint 2 · size {SIZE}
      </span>
      <span
        aria-hidden
        className="absolute -translate-x-1/2 text-caption-2-regular whitespace-nowrap text-text-tertiary"
        style={{ left: slot(SIZE), top: bracketY + 6 }}
      >
        unsealed
      </span>
    </>
  );
}

/** Beside the root: whether the tree's root is still the one the audit key signed. */
function RootTag({ changed, view }: { changed: boolean; view: View | null }) {
  const forged = Boolean(view?.forged);
  const label = !view ? null : !changed ? 'signed' : forged ? 'not signed' : '≠ signed root';
  return (
    <span className="absolute top-1/2 left-full ms-2 -translate-y-1/2">
      <AnimatePresence mode="wait" initial={false}>
        {label ? (
          <motion.span
            key={label}
            className={cx(
              'inline-flex items-center gap-1 rounded-md px-1.5 py-px font-sans text-caption-2-medium whitespace-nowrap',
              changed
                ? 'hatch border border-text-primary bg-background-primary-default text-text-primary'
                : 'text-text-secondary',
            )}
            initial={{ opacity: 0, x: -4 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -4 }}
            transition={{ duration: 0.2 }}
          >
            {changed ? (
              <RiCloseLine className="size-3" aria-hidden />
            ) : (
              <RiCheckLine className="size-3 text-text-primary" aria-hidden />
            )}
            {label}
          </motion.span>
        ) : null}
      </AnimatePresence>
    </span>
  );
}

function HashText({
  text,
  delay = 0,
  className,
}: {
  text: string;
  delay?: number;
  className?: string;
}) {
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.span
        key={text}
        className={cx('inline-block', className)}
        initial={{ opacity: 0, filter: 'blur(3px)' }}
        animate={{ opacity: 1, filter: 'blur(0px)' }}
        exit={{ opacity: 0, filter: 'blur(3px)' }}
        transition={{ duration: 0.2, delay }}
      >
        {text}
      </motion.span>
    </AnimatePresence>
  );
}

function Legend() {
  const items: { label: string; swatch: string }[] = [
    { label: 'path to the root', swatch: 'border-text-primary bg-text-primary' },
    { label: 'hash from the proof', swatch: 'border-text-primary' },
    { label: 'not what the key signed', swatch: 'hatch border-text-primary' },
    { label: 'not sealed yet', swatch: 'border-dashed border-border-button-active' },
  ];
  return (
    <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-caption-2-regular text-text-secondary">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-1.5">
          <span aria-hidden className={cx('size-2.5 shrink-0 rounded-[3px] border', item.swatch)} />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

// --- The rows -------------------------------------------------------------------------------------------------------

function EventList({
  selected,
  edits,
  onSelect,
  onToggleEdit,
}: {
  selected: number;
  edits: readonly number[];
  onSelect: (index: number) => void;
  onToggleEdit: (index: number) => void;
}) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = rows.length - 1;
    const next =
      event.key === 'ArrowDown'
        ? Math.min(last, index + 1)
        : event.key === 'ArrowUp'
          ? Math.max(0, index - 1)
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null;
    if (next === null) return;
    event.preventDefault();
    onSelect(next);
    buttons.current[next]?.focus();
  }

  return (
    <div className="@container">
      <div className="mb-2 flex items-baseline gap-2 px-1">
        <span className="eyebrow">audit_events</span>
        <span className="text-caption-2-regular text-text-tertiary">in commit order</span>
      </div>
      <ol className="flex flex-col gap-0.5" aria-label={`audit_events rows of ${TENANT}`}>
        {rows.map((row, index) => {
          const isSelected = selected === index;
          const edited = edits.includes(index);
          const unsealed = index >= SIZE;
          const leaf = edited && row.edit ? row.edit.apply(row.leaf) : row.leaf;
          const [prefix, rest] = leaf.action.startsWith('compute:')
            ? ['compute:', leaf.action.slice('compute:'.length)]
            : ['', leaf.action];
          const attestor = leaf.details?.attestor;
          const who = leaf.admission?.identityId ?? (typeof attestor === 'string' ? attestor : '');
          return (
            <li key={row.leaf.id}>
              {unsealed ? (
                <div
                  aria-hidden
                  className="my-1 flex items-center gap-2 px-1 font-mono text-caption-2-regular text-text-tertiary"
                >
                  <span className="flex-1 border-t border-dashed border-border-button-hover" />
                  cursor {SECOND.to} · 13:00 pass
                  <span className="flex-1 border-t border-dashed border-border-button-hover" />
                </div>
              ) : null}
              <div
                className={cx(
                  'relative flex items-center rounded-lg border transition-[background-color,border-color,box-shadow] duration-200',
                  isSelected
                    ? 'border-text-primary bg-background-primary-default shadow-xs'
                    : unsealed
                      ? 'border-dashed border-border-button-hover hover:bg-background-secondary-default'
                      : 'border-transparent hover:bg-background-secondary-default',
                )}
              >
                <AnimatePresence>
                  {edited ? (
                    <motion.span
                      aria-hidden
                      className="hatch pointer-events-none absolute inset-0 rounded-lg"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.25 }}
                    />
                  ) : null}
                </AnimatePresence>
                <button
                  ref={(element) => {
                    buttons.current[index] = element;
                  }}
                  type="button"
                  onClick={() => onSelect(index)}
                  onKeyDown={(event) => onKeyDown(event, index)}
                  aria-pressed={isSelected}
                  aria-label={`Row #${index}, ${leaf.action}${who ? ` by ${who}` : ''} at ${clock(leaf.occurredAtUs)}${unsealed ? ', not sealed yet' : edited ? ', edited' : ''}. Show its proof.`}
                  title={`${leaf.id} · commit ${row.cursor}`}
                  className="relative flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg py-1.5 ps-2 pe-1 text-start focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-focus-ring"
                >
                  <span className="w-5 shrink-0 font-mono text-caption-2-regular text-text-tertiary tabular-nums">
                    #{index}
                  </span>
                  <span
                    className={cx(
                      'min-w-0 flex-1 truncate font-mono text-caption-1-regular',
                      unsealed ? 'text-text-secondary' : 'text-text-primary',
                    )}
                  >
                    {prefix ? (
                      <span className="hidden text-text-tertiary @md:inline">{prefix}</span>
                    ) : null}
                    {rest}
                  </span>
                  {who ? (
                    <span
                      className={cx(
                        'hidden shrink-0 font-mono text-caption-2-regular @sm:inline',
                        edited && row.edit?.to === who
                          ? 'font-medium text-text-primary'
                          : 'text-text-secondary',
                      )}
                    >
                      {who}
                    </span>
                  ) : null}
                  <span
                    className={cx(
                      'shrink-0 font-mono text-caption-2-regular tabular-nums',
                      edited && row.edit?.field === 'occurredAtUs'
                        ? 'font-medium text-text-primary'
                        : 'text-text-tertiary',
                    )}
                  >
                    {clock(leaf.occurredAtUs)}
                  </span>
                </button>
                {row.edit ? (
                  <button
                    type="button"
                    onClick={() => onToggleEdit(index)}
                    aria-pressed={edited}
                    aria-label={
                      edited
                        ? `Undo the edit to row #${index}`
                        : `Edit row #${index} in the database`
                    }
                    title={
                      edited
                        ? 'Undo the edit'
                        : `Edit in the database: ${row.edit.field} → ${row.edit.to}`
                    }
                    className="relative me-1 inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-background-secondary-hover hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-focus-ring aria-pressed:bg-text-primary aria-pressed:text-background-full"
                  >
                    {edited ? (
                      <RiArrowGoBackLine className="size-3.5" aria-hidden />
                    ) : (
                      <RiPencilLine className="size-3.5" aria-hidden />
                    )}
                  </button>
                ) : (
                  <span
                    className="me-1 inline-flex size-7 shrink-0 items-center justify-center text-text-tertiary"
                    title="Not sealed yet: the next pass hashes the row as it is then"
                  >
                    <RiHourglassLine className="size-3.5" aria-hidden />
                  </span>
                )}
              </div>
              <AnimatePresence initial={false}>
                {edited && row.edit ? (
                  <motion.div
                    className="overflow-hidden"
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.25, ease }}
                  >
                    <p className="flex flex-wrap items-center gap-x-1.5 pt-0.5 pb-1.5 ps-9 pe-2 font-mono text-caption-2-regular text-text-secondary">
                      <span className="text-text-tertiary">{row.edit.field}</span>
                      <span className="text-text-tertiary line-through decoration-text-tertiary">
                        {row.edit.from}
                      </span>
                      <span aria-hidden>→</span>
                      <span className="font-medium text-text-primary">{row.edit.to}</span>
                    </p>
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// --- The signed checkpoint ------------------------------------------------------------------------------------------

function CheckpointCard({
  sealed,
  view,
  canForge,
  forged,
  onForge,
  reduced,
}: {
  sealed: Sealed | null;
  view: View | null;
  canForge: boolean;
  forged: boolean;
  onForge: () => void;
  reduced: boolean;
}) {
  const body = view?.body ?? sealed?.body;
  const signatureOk = view ? view.signatureOk : null;
  const reached = Boolean(view?.proof?.walk.ok);
  const walkTime = view?.proof && !reduced ? view.proof.walk.steps.length * STEP + 0.15 : 0;
  const value = (text: string) => `"${text}"`;
  const hashValue = (text: string | null | undefined) =>
    text === null ? 'null' : text ? value(`${text.slice(0, 8)}…`) : value('········');
  const pairs: [string, ReactNode][] = [
    ['from', value(SECOND.from)],
    [
      'previous',
      <span key="previous" title="SHA-256 of checkpoint 1’s signed body (4 rows, sealed at 12:00)">
        {hashValue(body?.previous)}
      </span>,
    ],
    [
      'root',
      <span
        key="root"
        title={body?.root}
        className={cx(
          'relative inline-block rounded px-0.5',
          view?.forged
            ? 'border border-dashed border-text-primary text-text-primary'
            : 'bg-background-secondary-default text-text-primary',
        )}
      >
        {hashValue(body?.root)}
        {/* Lights in ink once the verifier's walk arrives at it, and again after every new walk. */}
        {reached && !view?.forged ? (
          <motion.span
            key={view?.key}
            aria-hidden
            className="absolute inset-0 rounded bg-text-primary px-0.5 text-background-full select-none"
            initial={{ opacity: reduced ? 1 : 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.25, delay: walkTime }}
          >
            {hashValue(body?.root)}
          </motion.span>
        ) : null}
      </span>,
    ],
    ['sequence', '2'],
    ['size', String(SIZE)],
    ['tenantId', value(TENANT)],
    ['to', value(SECOND.to)],
    ['v', '1'],
  ];

  return (
    <section
      aria-label="Checkpoint 2 of org_acme"
      className={cx(
        'rounded-xl border bg-background-primary-default p-3.5 shadow-xs transition-colors duration-300',
        signatureOk === false ? 'border-text-primary' : 'border-border-button-default',
      )}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-body-2-medium text-text-primary">Checkpoint 2</span>
        <span className="font-mono text-caption-2-regular text-text-tertiary">
          audit.checkpoint · 13:00 pass
        </span>
        <span className="ms-auto">
          <AnimatePresence mode="wait" initial={false}>
            {signatureOk === null ? null : (
              <motion.span
                key={String(signatureOk)}
                className={cx(
                  'inline-flex items-center gap-1 rounded-md border px-1.5 py-px text-caption-2-medium whitespace-nowrap',
                  signatureOk
                    ? 'border-text-primary bg-text-primary text-background-full'
                    : 'hatch border-text-primary text-text-primary',
                )}
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                transition={{ duration: 0.2 }}
              >
                {signatureOk ? (
                  <RiCheckLine className="size-3" aria-hidden />
                ) : (
                  <RiCloseLine className="size-3" aria-hidden />
                )}
                {signatureOk ? 'signed' : 'signature fails'}
              </motion.span>
            )}
          </AnimatePresence>
        </span>
      </div>

      {/* The signed bytes: the body as canonical JSON (hashes shortened here). */}
      <p className="mt-2.5 font-mono text-caption-2-regular leading-5 text-text-secondary">
        {'{'}
        {pairs.map(([key, content], index) => (
          <span key={key}>
            <span className="whitespace-nowrap">
              <span className="text-text-tertiary">&quot;{key}&quot;:</span>
              {content}
              {index < pairs.length - 1 ? ',' : ''}
            </span>
            <wbr />
          </span>
        ))}
        {'}'}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-separator-border pt-3">
        <span
          className="min-w-0 truncate font-mono text-caption-2-regular text-text-secondary"
          title={sealed ? `kid ${sealed.kid} · pin ${sealed.pin}` : undefined}
        >
          ES256 · audit-checkpoint · pin{' '}
          <span className="text-text-primary">
            {sealed ? `${sealed.pin.slice(0, 15)}…` : 'sha256/…'}
          </span>
        </span>
        <AnimatePresence initial={false}>
          {canForge ? (
            <motion.button
              key="forge"
              type="button"
              onClick={onForge}
              aria-pressed={forged}
              title="Write the edited rows' root into the stored body. Without the audit key, the signature stays the old one."
              className="ms-auto inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-border-button-default px-2 text-caption-1-medium text-text-primary transition-colors hover:border-border-button-hover hover:bg-background-secondary-default focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-focus-ring aria-pressed:border-text-primary aria-pressed:bg-text-primary aria-pressed:text-background-full"
              initial={{ opacity: 0, x: 6 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 6 }}
              transition={{ duration: 0.2 }}
            >
              <RiQuillPenLine className="size-3.5" aria-hidden />
              {forged ? 'Undo the rewrite' : 'Rewrite the root'}
            </motion.button>
          ) : null}
        </AnimatePresence>
      </div>
    </section>
  );
}

// --- The verifier ---------------------------------------------------------------------------------------------------

function Check({ ok, label }: { ok: boolean; label: string }) {
  return ok ? (
    <span
      role="img"
      aria-label={label}
      className="flex size-4 shrink-0 items-center justify-center rounded-full bg-text-primary text-background-full"
    >
      <RiCheckLine className="size-3" aria-hidden />
    </span>
  ) : (
    <span
      role="img"
      aria-label={label}
      className="hatch flex size-4 shrink-0 items-center justify-center rounded-full border border-text-primary text-text-primary"
    >
      <RiCloseLine className="size-3" aria-hidden />
    </span>
  );
}

function HashPill({
  value,
  changed,
  dashed,
}: {
  value: Bytes | string;
  changed?: boolean;
  dashed?: boolean;
}) {
  const text = typeof value === 'string' ? value : base64url(value);
  return (
    <span
      title={text}
      className={cx(
        'shrink-0 rounded border px-1',
        changed
          ? 'hatch border-text-primary text-text-primary'
          : dashed
            ? 'border-dashed border-text-primary text-text-primary'
            : 'border-transparent bg-background-secondary-default text-text-primary',
      )}
    >
      {text.slice(0, 8)}…
    </span>
  );
}

function Verifier({
  view,
  sealed,
  unsupported,
  reduced,
}: {
  view: View | null;
  sealed: Sealed | null;
  unsupported: boolean;
  reduced: boolean;
}) {
  const frame =
    'flex flex-col gap-3 rounded-xl border bg-background-primary-default p-3.5 shadow-xs transition-colors duration-300';
  if (!view || !sealed)
    return (
      <section aria-label="Inclusion proof" className={cx(frame, 'border-border-button-default')}>
        <span className="eyebrow">Inclusion proof</span>
        <p className="font-mono text-caption-2-regular text-text-secondary">
          {unsupported
            ? 'This demo hashes and signs with WebCrypto, which this page cannot reach (it needs a secure context).'
            : 'Sealing checkpoint 2…'}
        </p>
      </section>
    );

  const index = view.selected;
  const row = rows[index]!;
  const stagger = (step: number) => (reduced ? 0 : step * STEP);
  const report = view.problems.length
    ? `{ ok: false, problems: [${view.problems.map((code) => `{ code: '${code}', sequence: 2 }`).join(', ')}] } → AUDIT_TAMPERED`
    : `{ ok: true, checkpoints: 2, events: ${earlierRows.length + SIZE}, unsealed: ${rows.length - SIZE} }`;

  if (!view.proof)
    return (
      <section aria-label="Inclusion proof" className={cx(frame, 'border-border-button-default')}>
        <div className="flex items-center gap-2">
          <span className="eyebrow">Inclusion proof</span>
          <span className="ms-auto font-mono text-caption-2-regular text-text-tertiary">
            row #{index} · commit {row.cursor}
          </span>
        </div>
        <motion.div
          key={view.key}
          className="flex flex-wrap items-center gap-3"
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, ease }}
        >
          <span className="inline-flex items-center gap-2 rounded-lg border border-dashed border-text-primary px-2.5 py-1 whitespace-nowrap text-text-primary">
            <RiHourglassLine className="size-4 shrink-0" aria-hidden />
            <span className="text-body-medium">NOT_FOUND</span>
          </span>
          <span className="text-caption-1-regular text-text-secondary">
            Not in any checkpoint yet. The hourly audit.checkpoint pass seals it next.
          </span>
        </motion.div>
        <code className="min-w-0 overflow-x-auto border-t border-separator-border pt-3 font-mono text-caption-2-regular whitespace-nowrap text-text-secondary">
          proveAuditEvent(sql, {'{'} tenantId, eventId {'}'}) → NOT_FOUND &apos;The event is not
          checkpointed yet&apos;
        </code>
      </section>
    );

  const { walk, leaf, tenantOk } = view.proof;
  const path = pathOf(TREE, index);
  const changedAt = (tree: Shape, hash: Bytes) => {
    const then = sealed.nodes.get(tree.id);
    return Boolean(then && !equal(hash, then));
  };
  const lines = [
    { formula: `H(0x00 ‖ row #${index})`, hash: leaf, tree: path[0]! },
    ...walk.steps.map((step, j) => ({
      formula: step.side === 'left' ? `H(0x01 ‖ p${j} ‖ h)` : `H(0x01 ‖ h ‖ p${j})`,
      hash: step.hash,
      tree: path[j + 1]!,
    })),
  ];
  const settle = stagger(lines.length + 1);
  const valid = Boolean(view.valid);

  return (
    <section
      aria-label="Inclusion proof"
      className={cx(frame, valid ? 'border-border-button-default' : 'border-text-primary')}
    >
      <div className="flex items-center gap-2">
        <span className="eyebrow">Inclusion proof</span>
        <span className="ms-auto font-mono text-caption-2-regular text-text-tertiary">
          index {index} · size {view.body.size}
        </span>
      </div>

      <ol className="flex flex-col gap-1 font-mono text-caption-2-regular">
        {lines.map((line, j) => (
          <motion.li
            key={`${view.key}-${j}`}
            className="flex items-center gap-2"
            initial={{ opacity: 0, x: -4 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.25, delay: stagger(j), ease }}
          >
            <span className="shrink-0 text-text-tertiary">h ←</span>
            <span className="min-w-0 flex-1 truncate text-text-secondary">{line.formula}</span>
            <HashPill value={line.hash} changed={changedAt(line.tree, line.hash)} />
          </motion.li>
        ))}
        <motion.li
          key={`${view.key}-root`}
          className="flex items-center gap-2 border-t border-dashed border-separator-border pt-1"
          initial={{ opacity: 0, x: -4 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.25, delay: stagger(lines.length), ease }}
        >
          <span className="shrink-0 text-text-tertiary">h {walk.ok ? '=' : '≠'}</span>
          <span className="min-w-0 flex-1 truncate text-text-secondary">body.root</span>
          <HashPill value={view.body.root} dashed={view.forged} />
          <Check
            ok={walk.ok}
            label={walk.ok ? 'reaches the signed root' : 'misses the signed root'}
          />
        </motion.li>
        <motion.li
          key={`${view.key}-signature`}
          className="flex items-center gap-2"
          initial={{ opacity: 0, x: -4 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.25, delay: stagger(lines.length + 0.5), ease }}
        >
          <span className="shrink-0 text-text-tertiary">sig</span>
          <span className="min-w-0 flex-1 truncate text-text-secondary">
            ES256 over the body, under the pin
          </span>
          <Check
            ok={view.signatureOk}
            label={view.signatureOk ? 'signature verifies' : 'signature does not verify'}
          />
        </motion.li>
        <motion.li
          key={`${view.key}-tenant`}
          className="flex items-center gap-2"
          initial={{ opacity: 0, x: -4 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.25, delay: stagger(lines.length + 0.75), ease }}
        >
          <span className="shrink-0 text-text-tertiary">ten</span>
          <span className="min-w-0 flex-1 truncate text-text-secondary">
            event.tenantId = body.tenantId
          </span>
          <Check ok={tenantOk} label={tenantOk ? 'same tenant' : 'different tenant'} />
        </motion.li>
      </ol>

      <div className="flex flex-col gap-2 border-t border-separator-border pt-3">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={`${view.key}-${valid}`}
            className="flex flex-wrap items-center gap-x-3 gap-y-2"
            initial={{ opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25, ease, delay: settle }}
          >
            {valid ? (
              <span className="inline-flex items-center gap-2 rounded-lg border border-text-primary bg-text-primary px-2.5 py-1 whitespace-nowrap text-background-full">
                <RiShieldCheckLine className="size-4 shrink-0" aria-hidden />
                <span className="text-body-medium">Proof verifies</span>
              </span>
            ) : (
              <span className="hatch inline-flex items-center gap-2 rounded-lg border border-text-primary px-2.5 py-1 whitespace-nowrap text-text-primary">
                <RiShieldCrossLine className="size-4 shrink-0" aria-hidden />
                <span className="text-body-medium">INVALID_PROOF</span>
              </span>
            )}
            <code className="min-w-0 font-mono text-caption-2-regular text-text-secondary">
              verifyAuditProof(proof, {'{'} pin {'}'}) → {String(valid)}
            </code>
          </motion.div>
        </AnimatePresence>
        <code
          className="min-w-0 overflow-x-auto font-mono text-caption-2-regular whitespace-nowrap text-text-secondary"
          title="What better-compute audit verify --tenant org_acme reports for the whole trail"
        >
          <span className="text-text-tertiary">audit verify →</span> {report}
        </code>
      </div>
    </section>
  );
}
