import { newId, shardOf, type EventPublisher, type SqlTx, type WorkQueue } from '@better-compute/core';

// Default SQL implementations of the core ports the gateway writes through (PLAN.md §8.4). A host
// passes the server's own implementations; these exist so a gateway process works on the base
// schema alone and so tests need no server runtime.

/**
 * The coalescing enqueue of §8.4: a key already queued has its `gen` bumped (so a reconciler that is
 * processing it keeps it) and keeps the earlier `not_before`.
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
};

/**
 * Appends one outbox row per event (§8.4). `topic` is the event type; `payload` is the event without
 * its cursor, stamped with `compute_now()`.
 */
export const sqlEventPublisher: EventPublisher = {
  async publish(tx, event) {
    await tx.query(
      `INSERT INTO outbox (topic, payload)
       VALUES ($1, $2::jsonb || jsonb_build_object('time', compute_now()))`,
      [
        event.type,
        JSON.stringify({
          id: newId('evt'),
          type: event.type,
          tenantId: event.tenantId,
          subject: event.subject,
          data: event.data,
        }),
      ],
    );
  },
};
