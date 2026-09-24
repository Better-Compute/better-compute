// Reading compute's outbox (PLAN.md §8.4, §9.3). Commit order is not `seq` order, so readers take only
// transactions older than the snapshot's xmin, ordered by (txid, seq): nothing can appear behind the cursor.
// The cursor, `<txid>.<seq>`, is also SSE's `Last-Event-ID` and every event's `sequence`.

import { ComputeError, type ComputeEvent, type Json, type SqlTx } from '@better-compute/core';

export interface OutboxCursor {
  txid: string;
  seq: string;
}

/** Before every outbox row. */
export const outboxStart: OutboxCursor = Object.freeze({ txid: '0', seq: '0' });

const cursorPattern = /^(\d{1,20})\.(\d{1,20})$/;

export function formatCursor(cursor: OutboxCursor): string {
  return `${cursor.txid}.${cursor.seq}`;
}

/** Parses `<txid>.<seq>`; `INVALID_INPUT` otherwise. */
export function parseCursor(value: string): OutboxCursor {
  const match = cursorPattern.exec(value.trim());
  if (!match) throw new ComputeError('INVALID_INPUT', 'Invalid event cursor');
  return { txid: match[1]!, seq: match[2]! };
}

/** `*` matches every type, `reservation.*` a family, anything else exactly. */
export function matchesEventType(pattern: string, type: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) return type.startsWith(pattern.slice(0, -1));
  return pattern === type;
}

interface OutboxRow {
  txid_text: string;
  seq_text: string;
  topic: string;
  payload: unknown;
}

function toTime(value: unknown): string {
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value)))
    return new Date(value).toISOString();
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  return new Date(0).toISOString();
}

function toEvent(row: OutboxRow): ComputeEvent | undefined {
  const payload = (
    typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload
  ) as Record<string, Json> | null;
  if (!payload || typeof payload.tenantId !== 'string') return undefined;
  const sequence = formatCursor({ txid: row.txid_text, seq: row.seq_text });
  return {
    id: typeof payload.id === 'string' ? payload.id : `evt_outbox_${row.txid_text}_${row.seq_text}`,
    type: typeof payload.type === 'string' ? payload.type : row.topic,
    tenantId: payload.tenantId,
    subject: typeof payload.subject === 'string' ? payload.subject : '',
    time: toTime(payload.time),
    sequence,
    data: payload.data ?? null,
  };
}

export interface ReadOutboxOptions {
  after?: OutboxCursor;
  limit?: number;
  /** Only this tenant's events. */
  tenantId?: string;
}

export interface OutboxPage {
  events: ComputeEvent[];
  /** Past the last row read (matching or not), or `after` when nothing was read. */
  cursor: OutboxCursor;
  /** The page was full: read again. */
  more: boolean;
}

/** One page of outbox events after `after`, from finished transactions only. */
export async function readOutbox(tx: SqlTx, options: ReadOutboxOptions = {}): Promise<OutboxPage> {
  const after = options.after ?? outboxStart;
  const limit = options.limit ?? 500;
  const params: unknown[] = [after.txid, after.seq, limit];
  let tenantFilter = '';
  if (options.tenantId !== undefined) {
    params.push(options.tenantId);
    tenantFilter = `AND payload->>'tenantId' = $4`;
  }
  // Aliases differ from the columns so ORDER BY sorts xid8/bigint, not their text.
  const { rows } = await tx.query<OutboxRow>(
    `SELECT txid::text AS txid_text, seq::text AS seq_text, topic, payload FROM outbox
      WHERE txid < pg_snapshot_xmin(pg_current_snapshot())
        AND (txid, seq) > ($1::xid8, $2::bigint) ${tenantFilter}
      ORDER BY txid, seq LIMIT $3`,
    params,
  );
  const last = rows.at(-1);
  return {
    events: rows.map(toEvent).filter((event): event is ComputeEvent => event !== undefined),
    cursor: last ? { txid: last.txid_text, seq: last.seq_text } : after,
    more: rows.length === limit,
  };
}

/** The cursor after every finished transaction's rows: where a new reader starts without replaying history. */
export async function outboxTail(tx: SqlTx): Promise<OutboxCursor> {
  const { rows } = await tx.query<{ txid_text: string; seq_text: string }>(
    `SELECT txid::text AS txid_text, seq::text AS seq_text FROM outbox
      WHERE txid < pg_snapshot_xmin(pg_current_snapshot())
      ORDER BY txid DESC, seq DESC LIMIT 1`,
  );
  const row = rows[0];
  return row ? { txid: row.txid_text, seq: row.seq_text } : outboxStart;
}
