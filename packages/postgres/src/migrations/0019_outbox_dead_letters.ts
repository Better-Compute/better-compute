import type { Migration } from '@better-compute/core';

/**
 * Poison isolation for OutboxDispatch (PLAN.md §8.4; asked by [c321a3]): the runtime bisects a
 * failing batch, and an event is dead only when it fails alone and the next event succeeds. Dead
 * events land here, keyed by sink and commit position, so one event a sink always refuses no
 * longer blocks that sink. Only the runtime writes it; retention may prune by `dead_at`. Additive.
 */
export const outboxDeadLettersMigration: Migration = {
  name: 'core/0019_outbox_dead_letters',
  sql: `
CREATE TABLE outbox_dead_letters (
  -- EventSink.id
  sink text NOT NULL,
  txid xid8 NOT NULL,
  seq bigint NOT NULL,
  -- The ComputeEvent as delivered.
  event jsonb NOT NULL,
  error text NOT NULL,
  attempts integer NOT NULL CHECK (attempts > 0),
  dead_at timestamptz NOT NULL DEFAULT compute_now(),
  PRIMARY KEY (sink, txid, seq)
);
CREATE INDEX outbox_dead_letters_dead_at ON outbox_dead_letters (dead_at);
`,
};

/** The tables `core/0019_outbox_dead_letters` creates. */
export const outboxDeadLettersTables = ['outbox_dead_letters'] as const;
