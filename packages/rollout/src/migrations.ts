import type { Migration } from '@better-compute/core';

/**
 * Registered bcd releases (verified signed manifests), rollouts and each rollout's node plan. A node
 * belongs to at most one active (running/paused) rollout; its state there decides what
 * `NodeSpec.daemon` it gets.
 */
export const rolloutMigration: Migration = {
  name: 'rollout/0001_rollouts',
  sql: `
CREATE TABLE daemon_releases (
  version text PRIMARY KEY,
  product text NOT NULL,
  sequence bigint NOT NULL UNIQUE,
  manifest jsonb NOT NULL,
  binaries jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  registered_by text NOT NULL,
  registered_at timestamptz NOT NULL DEFAULT compute_now()
);

CREATE TABLE rollouts (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  version text NOT NULL REFERENCES daemon_releases (version),
  state text NOT NULL CHECK (state IN ('running', 'paused', 'completed', 'aborted')),
  pool_ids jsonb,
  waves jsonb NOT NULL,
  wave integer NOT NULL DEFAULT 0,
  wave_started_at timestamptz NOT NULL DEFAULT compute_now(),
  wave_done_at timestamptz,
  max_failure_ratio double precision NOT NULL,
  soak_seconds integer NOT NULL,
  upgrade_timeout_seconds integer NOT NULL,
  rollback boolean NOT NULL DEFAULT false,
  reason text,
  created_by text NOT NULL,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT compute_now(),
  updated_at timestamptz NOT NULL DEFAULT compute_now(),
  UNIQUE (tenant_id, created_by, idempotency_key)
);
CREATE INDEX rollouts_active ON rollouts (tenant_id) WHERE state IN ('running', 'paused');

CREATE TABLE rollout_nodes (
  rollout_id text NOT NULL REFERENCES rollouts (id),
  node_id text NOT NULL,
  pool_id text NOT NULL,
  wave integer NOT NULL,
  ordinal integer NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'upgrading', 'succeeded', 'failed', 'skipped',
                                       'rolling-back', 'rolled-back')),
  from_version text,
  started_at timestamptz,
  finished_at timestamptz,
  error text,
  PRIMARY KEY (rollout_id, node_id)
);
CREATE INDEX rollout_nodes_node ON rollout_nodes (node_id);
CREATE INDEX rollout_nodes_pool ON rollout_nodes (pool_id) WHERE state IN ('upgrading', 'rolling-back');
`,
};

export const rolloutMigrations: readonly Migration[] = Object.freeze([rolloutMigration]);
