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
// transaction (`publishMany`: one row per event in a single INSERT): topic = type, payload =
// { id, type, tenantId, subject, data, time } with `time` from compute_now() (the gateway writes
// the same shape). Commit order is not `seq` order, so readers
// take only transactions older than their snapshot's xmin and walk (txid, seq) with a cursor that
// nothing can appear behind. OutboxDispatch (one singleton lease) hands batches to every event sink,
// at least once; every process tails the outbox for its own in-process subscribers.

const maxPayloadBytes = 64 * 1024;
const typePattern = /^[a-z][a-zA-Z0-9_-]*(?:\.[a-zA-Z0-9_-]+)+$/;

const insertEvent = `INSERT INTO outbox (topic, payload)
  VALUES ($1, $2::jsonb || jsonb_build_object('time', compute_now()))`;

/** One row per event, `seq` in input order (the ordinality sorts the rows before `seq` is drawn). */
const insertEvents = `INSERT INTO outbox (topic, payload)
  SELECT e.topic, e.payload::jsonb || jsonb_build_object('time', compute_now())
    FROM unnest($1::text[], $2::text[]) WITH ORDINALITY AS e(topic, payload, n)
   ORDER BY e.n`;

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

type PublishedEvent = Omit<ComputeEvent, 'id' | 'time' | 'sequence'>;

/** Checks an event and returns its outbox payload without `time` (the insert stamps it). */
function eventPayload(event: PublishedEvent): string {
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
  return payload;
}

/** `ctx.events`: appends to the outbox in the caller's transaction. */
export const eventPublisher: EventPublisher = Object.freeze({
  async publish(tx: SqlTx, event: PublishedEvent) {
    const payload = eventPayload(event);
    await tx.query(insertEvent, [event.type, payload]);
  },
  /**
   * The set-based publish: one INSERT for the batch, rows equal to `publish` called for each event
   * in order (`seq` follows the input). Every event is checked before anything is written.
   */
  async publishMany(tx: SqlTx, events: readonly PublishedEvent[]) {
    if (!Array.isArray(events))
      throw new ComputeError('INVALID_INPUT', 'publishMany() takes an array of events');
    if (!events.length) return;
    const payloads = events.map(eventPayload);
    await tx.query(insertEvents, [events.map((event) => event.type), payloads]);
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

/** The `outbox_cursors` row of an event sink (stream `outbox`). */
export const sinkCursorName = (sinkId: string) => `sink:${sinkId}`;

/** Whether the schema has the cursor table (`core/0009_runtime`). */
const cursorTablePresent = `SELECT to_regclass('outbox_cursors') IS NOT NULL AS present`;

const loadCursors = `SELECT c.name, c.txid::text AS txid_text, c.seq::text AS seq_text
  FROM outbox_cursors c WHERE c.name = ANY($1::text[])`;

/** Forward only: a late save by a holder that lost the lease never moves a cursor back. */
const saveCursor = `INSERT INTO outbox_cursors (name, stream, txid, seq)
  VALUES ($1, 'outbox', $2::xid8, $3::bigint)
  ON CONFLICT (name) DO UPDATE SET txid = EXCLUDED.txid, seq = EXCLUDED.seq,
    updated_at = compute_now()
  WHERE (outbox_cursors.txid, outbox_cursors.seq) < (EXCLUDED.txid, EXCLUDED.seq)`;

/** Whether `a` sorts after `b` in (txid, seq) order. */
function isAfter(a: OutboxCursor, b: OutboxCursor): boolean {
  const [at, bt] = [BigInt(a.txid), BigInt(b.txid)];
  return at > bt || (at === bt && BigInt(a.seq) > BigInt(b.seq));
}

export interface SinkDispatch {
  /**
   * One pass over every sink; returns how many events were delivered in total. `epoch` is the
   * outbox-dispatch lease's: a new one (this process just became the holder) reloads the stored
   * cursors before anything is read.
   */
  dispatch(epoch?: number): Promise<number>;
  /** The cursor of each sink, by sink id. */
  cursors(): Record<string, OutboxCursor>;
}

/**
 * OutboxDispatch's delivery to event sinks, run by the lease holder. Each sink has its own cursor,
 * so one failing sink backs off without holding the others back.
 *
 * Cursors are durable in `outbox_cursors` (`sink:<id>`, stream `outbox`): saved after each
 * delivered batch and loaded whenever this process takes the lease, so a new holder resumes where
 * the last one saved (at least once: a batch delivered before its save failed or the holder died is
 * delivered again; events carry ids for deduplication). A sink with no stored cursor starts at the
 * origin. Retention prunes the outbox only behind every stored cursor. On a schema without the
 * table the cursors stay in memory, and a new holder starts every sink at the origin.
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
    name: sinkCursorName(sink.id),
    cursor: outboxOrigin as OutboxCursor,
    failures: 0,
    retryAt: -Infinity,
  }));
  /** Whether cursors are stored (probed once per load until the table exists). */
  let durable = false;
  let loaded = false;
  let loadedEpoch: number | undefined;

  /** Takes each sink's stored cursor when it is ahead of the one in memory. */
  async function load(): Promise<void> {
    if (!durable) {
      const { rows } = await database.query<{ present: boolean }>(cursorTablePresent);
      durable = rows[0]?.present === true;
      if (!durable && !loaded)
        log.warn('outbox_cursors is missing (core/0009_runtime): sink cursors stay in memory', {});
    }
    if (!durable) return;
    const { rows } = await database.query<{ name: string; txid_text: string; seq_text: string }>(
      loadCursors,
      [state.map((entry) => entry.name)],
    );
    const stored = new Map(
      rows.map((row) => [row.name, { txid: row.txid_text, seq: row.seq_text }]),
    );
    for (const entry of state) {
      const cursor = stored.get(entry.name);
      if (cursor && isAfter(cursor, entry.cursor)) entry.cursor = cursor;
    }
  }

  async function save(entry: (typeof state)[number]): Promise<void> {
    if (!durable) return;
    try {
      await database.query(saveCursor, [entry.name, entry.cursor.txid, entry.cursor.seq]);
    } catch (error) {
      // Delivered but not saved: the next save carries the position; a new holder redelivers.
      log.warn('Saving an event sink cursor failed', {
        sink: entry.sink.id,
        error: message(error),
      });
    }
  }

  return {
    async dispatch(epoch) {
      if (!state.length) return 0;
      if (!loaded || epoch !== loadedEpoch) {
        await load();
        loaded = true;
        loadedEpoch = epoch;
      }
      let delivered = 0;
      for (const entry of state) {
        if (now() < entry.retryAt) continue;
        const page = await readEvents(database, entry.cursor, batchSize);
        if (!page.events.length) continue;
        try {
          await entry.sink.deliver(page.events);
        } catch (error) {
          entry.failures += 1;
          entry.retryAt = now() + Math.min(1000 * 2 ** (entry.failures - 1), 300_000);
          log.warn('An event sink failed; retrying with back-off', {
            sink: entry.sink.id,
            attempts: entry.failures,
            error: message(error),
          });
          continue;
        }
        entry.cursor = page.cursor;
        entry.failures = 0;
        delivered += page.events.length;
        await save(entry);
      }
      return delivered;
    },
    cursors: () => Object.fromEntries(state.map((entry) => [entry.sink.id, { ...entry.cursor }])),
  };
}
