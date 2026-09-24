// Signed per-tenant Merkle checkpoints over `audit_events` (PLAN.md §13, v0.4). Writers append freely (no
// chain head to serialize on, unlike better-iam's audit chain); checkpoints seal what committed.
//
// A pass reads rows committed past the global (txid, seq) cursor, from transactions older than the snapshot's
// xmin, so nothing can commit behind the cursor however long its transaction ran (occurred_at is the
// transaction's start and is only data). Rows are grouped by tenant; each tenant gets one checkpoint over its
// rows in (txid, seq) order: an RFC 6962 root, signed and linked to the tenant's previous checkpoint. The
// hashing and signing primitives are `@better-compute/pki`'s.

import { createHash } from 'node:crypto';
import { ComputeError, type SqlExecutor, type SqlTx } from '@better-compute/core';
import {
  base64url,
  canonicalJson,
  fromBase64url,
  merkleInclusionProof,
  merkleLeafHash,
  merkleRoot,
  signCheckpoint,
  verifyCheckpoint,
  verifyMerkleInclusion,
  type SignerTrust,
  type SigningKey,
} from '@better-compute/pki';

export interface CommitCursor {
  txid: string;
  seq: string;
}
const cursorText = (cursor: CommitCursor) => `${cursor.txid}.${cursor.seq}`;

/** What a checkpoint signs (canonical JSON). */
export interface AuditCheckpointBody {
  v: 1;
  tenantId: string;
  sequence: number;
  /** Global commit-cursor range (from, to], `<txid>.<seq>`. */
  from: string;
  to: string;
  size: number;
  /** base64url RFC 6962 root. */
  root: string;
  /** base64url SHA-256 of the previous checkpoint's body bytes; null for the first. */
  previous: string | null;
}

export interface CheckpointSignature {
  kid: string;
  sig: string;
  chain: string[];
}

export interface AuditCheckpoint {
  body: AuditCheckpointBody;
  /** The exact signed bytes. */
  bodyText: string;
  signature: CheckpointSignature;
  from: CommitCursor;
  to: CommitCursor;
  firstEventId: string;
  lastEventId: string;
}

/** An `audit_events` row as hashed: time in microseconds since the epoch (the column's precision). */
export interface AuditLeaf {
  id: string;
  tenantId: string;
  occurredAtUs: string;
  action: string;
  resourceType: string;
  resourceId: string;
  admission: unknown;
  details: unknown;
}

/** The leaf hash of a row: RFC 6962 over its canonical JSON. */
export function auditLeafHash(leaf: AuditLeaf): Uint8Array {
  return merkleLeafHash(new TextEncoder().encode(canonicalJson(leaf)));
}

const sha256b64 = (text: string) => base64url(createHash('sha256').update(text).digest());

interface EventRow {
  id: string;
  tenant_id: string;
  occurred_us: string;
  action: string;
  resource_type: string;
  resource_id: string;
  admission: unknown;
  details: unknown;
  txid_text: string;
  seq_text: string;
}

// Aliases differ from the columns so ORDER BY sorts xid8/bigint, not their text.
const eventColumns = `id, tenant_id, (extract(epoch FROM occurred_at) * 1000000)::bigint::text AS occurred_us,
  action, resource_type, resource_id, admission, details, txid::text AS txid_text, seq::text AS seq_text`;

const parseJson = (value: unknown) =>
  typeof value === 'string' ? JSON.parse(value) : (value ?? null);

function toLeaf(row: EventRow): AuditLeaf {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    occurredAtUs: row.occurred_us,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    admission: parseJson(row.admission),
    details: parseJson(row.details),
  };
}

interface CheckpointRow {
  from_txid: string;
  from_seq: string;
  to_txid: string;
  to_seq: string;
  first_event_id: string;
  last_event_id: string;
  body: string;
  signature: unknown;
}
const checkpointColumns = `from_txid::text AS from_txid, from_seq::text AS from_seq, to_txid::text AS to_txid,
  to_seq::text AS to_seq, first_event_id, last_event_id, body, signature`;

function toCheckpoint(row: CheckpointRow): AuditCheckpoint {
  return {
    body: JSON.parse(row.body) as AuditCheckpointBody,
    bodyText: row.body,
    signature: parseJson(row.signature) as CheckpointSignature,
    from: { txid: row.from_txid, seq: row.from_seq },
    to: { txid: row.to_txid, seq: row.to_seq },
    firstEventId: row.first_event_id,
    lastEventId: row.last_event_id,
  };
}

async function rangeRows(tx: SqlTx, tenantId: string, from: CommitCursor, to: CommitCursor) {
  const { rows } = await tx.query<EventRow>(
    `SELECT ${eventColumns} FROM audit_events
      WHERE tenant_id = $1 AND (txid, seq) > ($2::xid8, $3::bigint) AND (txid, seq) <= ($4::xid8, $5::bigint)
      ORDER BY txid, seq`,
    [tenantId, from.txid, from.seq, to.txid, to.seq],
  );
  return rows;
}

export interface CheckpointOptions {
  signer: SigningKey;
  /** Rows per pass, all tenants together. Default 50 000. */
  limit?: number;
  /** The cursor row. Default `audit`. */
  name?: string;
}

export interface CheckpointResult {
  checkpoints: AuditCheckpoint[];
  events: number;
  /** The pass hit its row limit: run again. */
  more: boolean;
}

/** One checkpoint pass; the cursor row lock serializes concurrent passes. */
export async function checkpointAudit(
  sql: SqlExecutor,
  options: CheckpointOptions,
): Promise<CheckpointResult> {
  const limit = options.limit ?? 50_000;
  const name = options.name ?? 'audit';
  return sql.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO audit_checkpoint_cursor (name, txid, seq) VALUES ($1, '0'::xid8, 0)
       ON CONFLICT (name) DO NOTHING`,
      [name],
    );
    const { rows: cursor } = await tx.query<{ txid_text: string; seq_text: string }>(
      `SELECT txid::text AS txid_text, seq::text AS seq_text FROM audit_checkpoint_cursor
        WHERE name = $1 FOR UPDATE`,
      [name],
    );
    const from: CommitCursor = { txid: cursor[0]!.txid_text, seq: cursor[0]!.seq_text };
    const { rows } = await tx.query<EventRow>(
      `SELECT ${eventColumns} FROM audit_events
        WHERE txid < pg_snapshot_xmin(pg_current_snapshot()) AND (txid, seq) > ($1::xid8, $2::bigint)
        ORDER BY txid, seq LIMIT $3`,
      [from.txid, from.seq, limit],
    );
    if (rows.length === 0) return { checkpoints: [], events: 0, more: false };
    const last = rows.at(-1)!;
    const to: CommitCursor = { txid: last.txid_text, seq: last.seq_text };

    const byTenant = new Map<string, EventRow[]>();
    for (const row of rows)
      byTenant.set(row.tenant_id, [...(byTenant.get(row.tenant_id) ?? []), row]);
    const checkpoints: AuditCheckpoint[] = [];
    for (const tenantId of [...byTenant.keys()].sort()) {
      const events = byTenant.get(tenantId)!;
      const { rows: previous } = await tx.query<{ sequence: string; body: string }>(
        `SELECT sequence::text AS sequence, body FROM audit_checkpoints
          WHERE tenant_id = $1 ORDER BY sequence DESC LIMIT 1`,
        [tenantId],
      );
      const body: AuditCheckpointBody = {
        v: 1,
        tenantId,
        sequence: previous[0] ? Number(previous[0].sequence) + 1 : 1,
        from: cursorText(from),
        to: cursorText(to),
        size: events.length,
        root: base64url(merkleRoot(events.map((row) => auditLeafHash(toLeaf(row))))),
        previous: previous[0] ? sha256b64(previous[0].body) : null,
      };
      const signed = signCheckpoint(body, options.signer);
      const bodyText = new TextDecoder().decode(signed.bodyBytes);
      await tx.query(
        `INSERT INTO audit_checkpoints (tenant_id, sequence, from_txid, from_seq, to_txid, to_seq, size, root,
                                        first_event_id, last_event_id, body, signature)
         VALUES ($1, $2, $3::xid8, $4, $5::xid8, $6, $7, $8, $9, $10, $11, $12::jsonb)`,
        [
          tenantId,
          body.sequence,
          from.txid,
          from.seq,
          to.txid,
          to.seq,
          body.size,
          body.root,
          events[0]!.id,
          events.at(-1)!.id,
          bodyText,
          JSON.stringify(signed.signature),
        ],
      );
      checkpoints.push({
        body,
        bodyText,
        signature: signed.signature,
        from,
        to,
        firstEventId: events[0]!.id,
        lastEventId: events.at(-1)!.id,
      });
    }
    await tx.query(
      `UPDATE audit_checkpoint_cursor SET txid = $2::xid8, seq = $3::bigint, updated_at = compute_now()
        WHERE name = $1`,
      [name, to.txid, to.seq],
    );
    return { checkpoints, events: rows.length, more: rows.length === limit };
  });
}

/** Whether the signature verifies and the signed bytes are exactly this body. */
function signedBy(checkpoint: Pick<AuditCheckpoint, 'bodyText' | 'signature'>, trust: SignerTrust) {
  try {
    const verified = verifyCheckpoint(
      { bodyBytes: new TextEncoder().encode(checkpoint.bodyText), signature: checkpoint.signature },
      trust,
    );
    return canonicalJson(verified) === checkpoint.bodyText;
  } catch {
    return false;
  }
}

export type AuditProblemCode =
  | 'gap'
  | 'chain'
  | 'body'
  | 'signature'
  | 'root'
  | 'size'
  | 'uncovered';

export interface AuditProblem {
  code: AuditProblemCode;
  sequence?: number;
  message: string;
}

export interface VerifyOptions {
  tenantId: string;
  trust: SignerTrust;
  /** Also report committed rows no checkpoint covers yet whose occurred_at is older than this. */
  uncoveredOlderThanMs?: number;
}

export interface VerifyReport {
  ok: boolean;
  tenantId: string;
  checkpoints: number;
  events: number;
  /** Committed rows after the tenant's last checkpoint. */
  unsealed: number;
  problems: AuditProblem[];
}

/**
 * Verifies a tenant's whole chain: sequences from 1 without gaps, each body canonical and matching its row,
 * each linked to the previous body's hash, each signature under the trusted audit key, and each root and size
 * recomputed from the rows `audit_events` holds now: an edited, inserted or deleted row inside a sealed range
 * shows as `root`/`size`.
 */
export async function verifyAuditCheckpoints(
  sql: SqlExecutor,
  options: VerifyOptions,
): Promise<VerifyReport> {
  return sql.transaction(
    async (tx) => {
      const problems: AuditProblem[] = [];
      const { rows } = await tx.query<CheckpointRow>(
        `SELECT ${checkpointColumns} FROM audit_checkpoints WHERE tenant_id = $1 ORDER BY sequence`,
        [options.tenantId],
      );
      let previous: AuditCheckpoint | undefined;
      let events = 0;
      for (const checkpoint of rows.map(toCheckpoint)) {
        const { body } = checkpoint;
        const at = body.sequence;
        const expected = (previous?.body.sequence ?? 0) + 1;
        if (body.sequence !== expected)
          problems.push({
            code: 'gap',
            sequence: at,
            message: `Checkpoint ${expected} is missing`,
          });
        if (
          canonicalJson(body) !== checkpoint.bodyText ||
          body.tenantId !== options.tenantId ||
          body.from !== cursorText(checkpoint.from) ||
          body.to !== cursorText(checkpoint.to)
        )
          problems.push({
            code: 'body',
            sequence: at,
            message: 'The signed body does not match its row',
          });
        const link = previous ? sha256b64(previous.bodyText) : null;
        if (body.previous !== link)
          problems.push({
            code: 'chain',
            sequence: at,
            message: 'The link to the previous checkpoint is broken',
          });
        if (!signedBy(checkpoint, options.trust))
          problems.push({
            code: 'signature',
            sequence: at,
            message: 'The signature does not verify under the audit key',
          });
        const leaves = await rangeRows(tx, options.tenantId, checkpoint.from, checkpoint.to);
        events += leaves.length;
        if (leaves.length !== body.size)
          problems.push({
            code: 'size',
            sequence: at,
            message: `${leaves.length} rows are in range, the checkpoint sealed ${body.size}`,
          });
        if (base64url(merkleRoot(leaves.map((row) => auditLeafHash(toLeaf(row))))) !== body.root)
          problems.push({
            code: 'root',
            sequence: at,
            message: 'The rows in range do not hash to the sealed root',
          });
        previous = checkpoint;
      }
      const after = previous?.to ?? { txid: '0', seq: '0' };
      const { rows: pending } = await tx.query<{ total: string; stale: string }>(
        `SELECT count(*)::text AS total,
                count(*) FILTER (WHERE occurred_at < compute_now() - make_interval(secs => $4::float8 / 1000))::text AS stale
           FROM audit_events WHERE tenant_id = $1 AND (txid, seq) > ($2::xid8, $3::bigint)`,
        [options.tenantId, after.txid, after.seq, options.uncoveredOlderThanMs ?? 0],
      );
      const unsealed = Number(pending[0]?.total ?? 0);
      const stale = Number(pending[0]?.stale ?? 0);
      if (options.uncoveredOlderThanMs !== undefined && stale > 0)
        problems.push({
          code: 'uncovered',
          message: `${stale} rows are not covered by any checkpoint yet`,
        });
      return {
        ok: problems.length === 0,
        tenantId: options.tenantId,
        checkpoints: rows.length,
        events,
        unsealed,
        problems,
      };
    },
    { isolation: 'repeatable read', readOnly: true },
  );
}

/** Everything a third party needs to check that one event is sealed, with no database access. */
export interface AuditInclusionProof {
  event: AuditLeaf;
  index: number;
  /** base64url sibling hashes, bottom-up. */
  proof: string[];
  checkpoint: { body: AuditCheckpointBody; bodyText: string; signature: CheckpointSignature };
}

/** The inclusion proof of one event; `NOT_FOUND` when it is missing or not checkpointed yet. */
export async function proveAuditEvent(
  sql: SqlExecutor,
  input: { tenantId: string; eventId: string },
): Promise<AuditInclusionProof> {
  return sql.transaction(
    async (tx) => {
      const { rows: found } = await tx.query<EventRow>(
        `SELECT ${eventColumns} FROM audit_events WHERE id = $1 AND tenant_id = $2`,
        [input.eventId, input.tenantId],
      );
      if (!found[0]) throw new ComputeError('NOT_FOUND', 'Audit event not found');
      const { rows: covering } = await tx.query<CheckpointRow>(
        `SELECT ${checkpointColumns} FROM audit_checkpoints
          WHERE tenant_id = $1 AND (from_txid, from_seq) < ($2::xid8, $3::bigint)
            AND (to_txid, to_seq) >= ($2::xid8, $3::bigint)
          ORDER BY sequence LIMIT 1`,
        [input.tenantId, found[0].txid_text, found[0].seq_text],
      );
      if (!covering[0]) throw new ComputeError('NOT_FOUND', 'The event is not checkpointed yet');
      const checkpoint = toCheckpoint(covering[0]);
      const leaves = (await rangeRows(tx, input.tenantId, checkpoint.from, checkpoint.to)).map(
        toLeaf,
      );
      const index = leaves.findIndex((leaf) => leaf.id === input.eventId);
      if (index < 0)
        throw new ComputeError('INVALID_STATE', 'The event is not in its checkpoint range');
      return {
        event: leaves[index]!,
        index,
        proof: merkleInclusionProof(leaves.map(auditLeafHash), index).map((hash) =>
          base64url(hash),
        ),
        checkpoint: {
          body: checkpoint.body,
          bodyText: checkpoint.bodyText,
          signature: checkpoint.signature,
        },
      };
    },
    { isolation: 'repeatable read', readOnly: true },
  );
}

/** Checks a proof offline: the signature over the exact body, the tenant, and the inclusion path. */
export function verifyAuditProof(proof: AuditInclusionProof, trust: SignerTrust): boolean {
  try {
    if (!signedBy(proof.checkpoint, trust)) return false;
    const body = JSON.parse(proof.checkpoint.bodyText) as AuditCheckpointBody;
    if (canonicalJson(body) !== canonicalJson(proof.checkpoint.body)) return false;
    if (proof.event.tenantId !== body.tenantId) return false;
    return verifyMerkleInclusion(
      auditLeafHash(proof.event),
      proof.index,
      body.size,
      proof.proof.map((hash) => fromBase64url(hash)),
      fromBase64url(body.root),
    );
  } catch {
    return false;
  }
}
