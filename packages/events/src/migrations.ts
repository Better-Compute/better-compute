import type { Migration } from '@better-compute/core';

/**
 * The events module's tables. `webhooks` holds per-tenant subscriptions with their signing secret sealed;
 * `webhook_deliveries` is the delivery queue and history (at most one row per webhook and event);
 * `event_cursors` holds each outbox reader's position.
 */
export const webhooksMigration: Migration = {
  name: 'events/0001_webhooks',
  sql: `
CREATE TABLE webhooks (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  url text NOT NULL,
  description text,
  -- Event type patterns: '*', 'reservation.*', 'node.connected'.
  events text[] NOT NULL CHECK (cardinality(events) BETWEEN 1 AND 20),
  active bool NOT NULL DEFAULT true,
  secret_sealed text NOT NULL,
  -- During a rotation both secrets sign deliveries until previous_expires_at.
  previous_secret_sealed text,
  previous_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT compute_now(),
  updated_at timestamptz NOT NULL DEFAULT compute_now(),
  version bigint NOT NULL DEFAULT 1
);
CREATE INDEX webhooks_tenant ON webhooks (tenant_id) WHERE active;

CREATE TABLE webhook_deliveries (
  id text PRIMARY KEY,
  webhook_id text NOT NULL REFERENCES webhooks ON DELETE CASCADE,
  tenant_id text NOT NULL,
  event_id text NOT NULL,
  event_type text NOT NULL,
  -- The exact JSON body that is signed and sent.
  body text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'delivered', 'dead', 'cancelled')),
  attempts int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT compute_now(),
  last_status int,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT compute_now(),
  delivered_at timestamptz,
  UNIQUE (webhook_id, event_id)
);
CREATE INDEX webhook_deliveries_due ON webhook_deliveries (next_attempt_at) WHERE state = 'pending';
CREATE INDEX webhook_deliveries_webhook ON webhook_deliveries (webhook_id, created_at);

CREATE TABLE event_cursors (
  name text PRIMARY KEY,
  txid xid8 NOT NULL,
  seq bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT compute_now()
);
`,
};

/** The index the `events.prune` retention pass deletes by: settled deliveries by state and age. */
export const deliveryRetentionMigration: Migration = {
  name: 'events/0002_delivery_retention',
  sql: `CREATE INDEX webhook_deliveries_settled ON webhook_deliveries (state, created_at) WHERE state <> 'pending';`,
};

export const eventsMigrations: readonly Migration[] = [
  webhooksMigration,
  deliveryRetentionMigration,
];
