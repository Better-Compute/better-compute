import { newId, shardOf, type EventPublisher, type SqlTx, type WorkQueue } from '@better-compute/core';

// Default SQL implementations of the core ports the gateway writes through (PLAN.md §8.4). A host
// passes the server's own implementations; these exist so a gateway process works on the base
// schema alone and so tests need no server runtime.

/**
 * The coalescing enqueue of §8.4: a key already queued has its `gen` bumped (so a reconciler that is
 * processing it keeps it) and keeps the earlier `not_before`. `enqueueMany` writes exactly the rows
 * the same calls one by one would: a key named n times in one call is inserted with `gen = n`, or
 * bumped by n.
 */
export const sqlWorkQueue: WorkQueue = {
  async enqueue(tx: SqlTx, kind: string, key: string, options: { notBefore?: number } = {}) {
    await tx.query(
      `INSERT INTO work_queue (kind, key, shard, gen, not_before)
       VALUES ($1, $2, $3, 1, COALESCE($4::timestamptz, compute_now()))
       ON CONFLICT (kind, key) DO UPDATE
         SET gen = work_queue.gen + 1, not_before = LEAST(work_queue.not_before, EXCLUDED.not_before)`,
      [
        kind,
        key,
        shardOf(key),
        options.notBefore === undefined ? null : new Date(options.notBefore),
      ],
    );
  },
  async enqueueMany(tx, kind, keys, options = {}) {
    if (!keys.length) return;
    // ON CONFLICT cannot touch a row twice in one statement: count repeats instead.
    const counts = new Map<string, number>();
    for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
    const distinct = [...counts.keys()];
    await tx.query(
      `INSERT INTO work_queue (kind, key, shard, gen, not_before)
       SELECT $1, v.key, v.shard, v.n, COALESCE($5::timestamptz, compute_now())
       FROM unnest($2::text[], $3::smallint[], $4::bigint[]) AS v(key, shard, n)
       ON CONFLICT (kind, key) DO UPDATE
         SET gen = work_queue.gen + EXCLUDED.gen, not_before = LEAST(work_queue.not_before, EXCLUDED.not_before)`,
      [
        kind,
        distinct,
        distinct.map(shardOf),
        distinct.map((key) => counts.get(key)!),
        options.notBefore === undefined ? null : new Date(options.notBefore),
      ],
    );
  },
};

const payloadOf = (event: Parameters<EventPublisher['publish']>[1]) =>
  JSON.stringify({
    id: newId('evt'),
    type: event.type,
    tenantId: event.tenantId,
    subject: event.subject,
    data: event.data,
  });

/**
 * Appends one outbox row per event (§8.4). `topic` is the event type; `payload` is the event without
 * its cursor, stamped with `compute_now()`. `publishMany` keeps input order in `seq`.
 */
export const sqlEventPublisher: EventPublisher = {
  async publish(tx, event) {
    await tx.query(
      `INSERT INTO outbox (topic, payload)
       VALUES ($1, $2::jsonb || jsonb_build_object('time', compute_now()))`,
      [event.type, payloadOf(event)],
    );
  },
  async publishMany(tx, events) {
    if (!events.length) return;
    await tx.query(
      `INSERT INTO outbox (topic, payload)
       SELECT v.topic, v.payload::jsonb || jsonb_build_object('time', compute_now())
       FROM unnest($1::text[], $2::text[]) WITH ORDINALITY AS v(topic, payload, n)
       ORDER BY v.n`,
      [events.map((event) => event.type), events.map(payloadOf)],
    );
  },
};
