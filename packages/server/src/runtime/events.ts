import {
  ComputeError,
  newId,
  type ComputeEvent,
  type EventPublisher,
  type EventSink,
  type Json,
  type Logger,
  type SqlExecutor,
  type SqlTx,
} from '@better-compute/core';

// Events through the outbox (PLAN.md §8.4, §9.3). `publish` appends one row in the caller's
// transaction: topic = type, payload = { id, type, tenantId, subject, data, time } with `time` from
// compute_now() (the gateway writes the same shape). Commit order is not `seq` order, so readers
// take only transactions older than their snapshot's xmin and walk (txid, seq) with a cursor that
// nothing can appear behind. OutboxDispatch (one singleton lease) hands batches to every event sink,
// at least once; every process tails the outbox for its own in-process subscribers.

const maxPayloadBytes = 64 * 1024;
const typePattern = /^[a-z][a-zA-Z0-9_-]*(?:\.[a-zA-Z0-9_-]+)+$/;

const insertEvent = `INSERT INTO outbox (topic, payload)
  VALUES ($1, $2::jsonb || jsonb_build_object('time', compute_now()))`;

// Order by the qualified columns: a bare `ORDER BY txid, seq` would sort the text aliases.
const readOutbox = `SELECT o.seq::text AS seq, o.txid::text AS txid, o.topic, o.payload FROM outbox o
  WHERE o.txid < pg_snapshot_xmin(pg_current_snapshot()) AND (o.txid, o.seq) > ($1::xid8, $2::bigint)
  ORDER BY o.txid, o.seq LIMIT $3`;

/** The first position every later-committing transaction sorts after. */
const outboxHead = 'SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS txid';

/** A position in the outbox: xid8 and seq as decimal strings. */
export interface OutboxCursor {
  txid: string;
  seq: string;
}

/** Before every row. */
export const outboxOrigin: OutboxCursor = Object.freeze({ txid: '0', seq: '0' });

/** An event's `sequence` (SSE `Last-Event-ID`): `<txid>:<seq>`. */
export const formatSequence = (cursor: OutboxCursor) => `${cursor.txid}:${cursor.seq}`;

const byteLength = (text: string) => new TextEncoder().encode(text).byteLength;

function checkText(value: unknown, name: string, max: number): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max)
    throw new ComputeError('INVALID_INPUT', `An event's ${name} is a non-empty string`);
}

/** `ctx.events`: appends to the outbox in the caller's transaction. */
export const eventPublisher: EventPublisher = Object.freeze({
  async publish(tx: SqlTx, event: Omit<ComputeEvent, 'id' | 'time' | 'sequence'>) {
    if (!event || typeof event !== 'object')
      throw new ComputeError('INVALID_INPUT', 'publish() takes an event');
    checkText(event.type, 'type', 128);
    if (!typePattern.test(event.type))
      throw new ComputeError(
        'INVALID_INPUT',
        `Event type ${JSON.stringify(event.type)} must look like area.name (node.connected)`,
      );
    checkText(event.tenantId, 'tenantId', 128);
    checkText(event.subject, 'subject', 512);
    let payload: string;
    try {
      payload = JSON.stringify({
        id: newId('evt'),
        type: event.type,
        tenantId: event.tenantId,
        subject: event.subject,
        data: event.data === undefined ? null : event.data,
      });
    } catch {
      throw new ComputeError('INVALID_INPUT', 'Event data must be JSON');
    }
    if (byteLength(payload) > maxPayloadBytes)
      throw new ComputeError('INVALID_INPUT', `An event is at most ${maxPayloadBytes} bytes`);
    await tx.query(insertEvent, [event.type, payload]);
  },
});

/** One outbox row as read with its cursor columns as decimal text. */
export interface OutboxRow {
  seq: string;
  txid: string;
  topic: string;
  payload: unknown;
}

/** An outbox row as a `ComputeEvent`; its `sequence` is the row's `<txid>:<seq>` cursor. */
export function toEvent(row: OutboxRow): ComputeEvent {
  const payload = (
    typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload ?? {})
  ) as Record<string, unknown>;
  // compute_now() as JSON (`2026-01-01T00:00:00+00:00`), normalized to RFC 3339 in UTC.
  const time = typeof payload.time === 'string' ? payload.time : '';
  const parsed = new Date(time);
  return {
    id: typeof payload.id === 'string' ? payload.id : `evt_outbox_${row.txid}_${row.seq}`,
    type: typeof payload.type === 'string' ? payload.type : row.topic,
    tenantId: typeof payload.tenantId === 'string' ? payload.tenantId : '',
    subject: typeof payload.subject === 'string' ? payload.subject : '',
    time: Number.isNaN(parsed.getTime()) ? time : parsed.toISOString(),
    sequence: formatSequence(row),
    data: (payload.data ?? null) as Json,
  };
}

/** Reads up to `limit` events after `cursor`, from transactions every snapshot sees as finished. */
export async function readEvents(
  sql: SqlTx,
  cursor: OutboxCursor,
  limit: number,
): Promise<{ events: ComputeEvent[]; cursor: OutboxCursor }> {
  const { rows } = await sql.query<OutboxRow>(readOutbox, [cursor.txid, cursor.seq, limit]);
  const last = rows.at(-1);
  return {
    events: rows.map(toEvent),
    cursor: last ? { txid: last.txid, seq: last.seq } : cursor,
  };
}

/** The cursor at the head: everything committed so far sorts before it. */
export async function headCursor(sql: SqlTx): Promise<OutboxCursor> {
  const { rows } = await sql.query<{ txid: string }>(outboxHead);
  return { txid: rows[0]?.txid ?? '0', seq: '0' };
}

/** Matches event types: `*` matches any run of characters (`reservation.*`, `*`). */
export function eventPattern(pattern: string): (type: string) => boolean {
  if (typeof pattern !== 'string' || pattern.length === 0 || pattern.length > 128)
    throw new ComputeError(
      'INVALID_INPUT',
      'An event pattern is a non-empty string such as node.*',
    );
  if (pattern === '*') return () => true;
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  const regex = new RegExp(`^${source}$`);
  return (type) => regex.test(type);
}

export type EventHandler = (event: ComputeEvent) => void | Promise<void>;

/** `compute.events`: in-process subscribers of committed events. */
export interface EventSubscriptions {
  /** Calls `handler` for each committed event whose type matches; returns the unsubscribe function. */
  subscribe(pattern: string, handler: EventHandler): () => void;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export interface LocalEvents extends EventSubscriptions {
  /** One tail pass: delivers the next batch to matching subscribers; returns how many it read. */
  tick(): Promise<number>;
  readonly size: number;
}

/**
 * Per-process subscribers. The first subscriber starts the process's cursor at the head (read right
 * away, so events committed after `subscribe()` returns are delivered); with no subscriber the
 * tail reads nothing. Handler errors are logged and isolated.
 */
export function createLocalEvents(
  database: SqlExecutor,
  log: Logger,
  batchSize: number,
): LocalEvents {
  const subscribers = new Set<{ matches: (type: string) => boolean; handler: EventHandler }>();
  let cursor: OutboxCursor | undefined;
  let starting: Promise<void> | undefined;

  const start = () => {
    starting ??= headCursor(database).then(
      (head) => {
        if (subscribers.size) cursor ??= head;
      },
      (error: unknown) => {
        starting = undefined;
        log.warn('Reading the outbox head failed', { error: message(error) });
      },
    );
  };

  return {
    get size() {
      return subscribers.size;
    },
    subscribe(pattern, handler) {
      if (typeof handler !== 'function')
        throw new ComputeError('INVALID_INPUT', 'subscribe() takes a handler function');
      const entry = { matches: eventPattern(pattern), handler };
      subscribers.add(entry);
      if (!cursor) start();
      return () => {
        subscribers.delete(entry);
        if (!subscribers.size) {
          cursor = undefined;
          starting = undefined;
        }
      };
    },
    async tick() {
      if (!subscribers.size) return 0;
      if (!cursor) {
        start();
        await starting;
        if (!cursor) return 0;
      }
      const page = await readEvents(database, cursor, batchSize);
      for (const event of page.events)
        for (const subscriber of [...subscribers]) {
          if (!subscriber.matches(event.type)) continue;
          try {
            await subscriber.handler(event);
          } catch (error) {
            log.warn('An event subscriber failed', { type: event.type, error: message(error) });
          }
        }
      cursor = page.cursor;
      return page.events.length;
    },
  };
}

export interface SinkDispatch {
  /** One pass over every sink; returns how many events were delivered in total. */
  dispatch(): Promise<number>;
  /** The cursor of each sink, by sink id. */
  cursors(): Record<string, OutboxCursor>;
}

/**
 * OutboxDispatch's delivery to event sinks, run by the lease holder. Each sink has its own cursor,
 * so one failing sink backs off without holding the others back.
 *
 * The cursors live in memory until the schema has a cursor table: a new holder starts every sink at
 * the origin and redelivers (at least once; events carry ids for deduplication).
 */
export function createSinkDispatch(
  database: SqlExecutor,
  sinks: readonly EventSink[],
  log: Logger,
  batchSize: number,
  now: () => number,
): SinkDispatch {
  const state = sinks.map((sink) => ({
    sink,
    cursor: outboxOrigin as OutboxCursor,
    failures: 0,
    retryAt: -Infinity,
  }));
  return {
    async dispatch() {
      let delivered = 0;
      for (const entry of state) {
        if (now() < entry.retryAt) continue;
        const page = await readEvents(database, entry.cursor, batchSize);
        if (!page.events.length) continue;
        try {
          await entry.sink.deliver(page.events);
          entry.cursor = page.cursor;
          entry.failures = 0;
          delivered += page.events.length;
        } catch (error) {
          entry.failures += 1;
          entry.retryAt = now() + Math.min(1000 * 2 ** (entry.failures - 1), 300_000);
          log.warn('An event sink failed; retrying with back-off', {
            sink: entry.sink.id,
            attempts: entry.failures,
            error: message(error),
          });
        }
      }
      return delivered;
    },
    cursors: () => Object.fromEntries(state.map((entry) => [entry.sink.id, { ...entry.cursor }])),
  };
}
