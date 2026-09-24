import type { Migration } from '@better-compute/core';

// The provision module's tables (PLAN.md §11.2), under its own ledger owner `provision`.
// Every transition is persisted, so the worker that next owns a node's shard resumes a crashed
// workflow where it stopped. Time is compute_now() throughout (P9).

export const provisionMigrations: readonly Migration[] = Object.freeze([
  {
    name: 'provision/0001_workflows',
    sql: `
-- Stored profiles: one row per (tenant, id, version). A version is immutable once used_at is set.
CREATE TABLE profiles (
  tenant_id text NOT NULL,
  id text NOT NULL,
  profile_version int NOT NULL CHECK (profile_version > 0),
  target text NOT NULL CHECK (target IN ('metal', 'vps')),
  document jsonb NOT NULL,
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT compute_now(),
  deleted_at timestamptz,
  version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id, profile_version)
);

CREATE TABLE workflows (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  node_id text REFERENCES nodes,
  instance_id text,
  profile_id text NOT NULL,
  profile_version int NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'running', 'paused', 'succeeded', 'failed', 'cancelled')),
  -- Set while cleanup runs after a failure or an abort: where the workflow ends up afterwards.
  outcome text CHECK (outcome IN ('failed', 'cancelled')),
  -- The step running or waiting now.
  step_id text,
  error jsonb,
  -- The reconciler key: the node, else the workflow itself.
  work_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT compute_now(),
  updated_at timestamptz NOT NULL DEFAULT compute_now(),
  finished_at timestamptz,
  version bigint NOT NULL DEFAULT 1,
  CHECK (node_id IS NOT NULL OR instance_id IS NOT NULL)
);
-- One active workflow per node and per instance.
CREATE UNIQUE INDEX workflows_active_node ON workflows (node_id)
  WHERE state IN ('pending', 'running', 'paused') AND node_id IS NOT NULL;
CREATE UNIQUE INDEX workflows_active_instance ON workflows (instance_id)
  WHERE state IN ('pending', 'running', 'paused') AND instance_id IS NOT NULL;
CREATE INDEX workflows_tenant ON workflows (tenant_id, created_at);
CREATE INDEX workflows_work_key ON workflows (work_key) WHERE state IN ('pending', 'running', 'paused');

CREATE TABLE workflow_steps (
  workflow_id text NOT NULL REFERENCES workflows,
  id text NOT NULL,
  -- Execution order within the workflow; phases are ordered main < on-failure < cleanup.
  index int NOT NULL,
  phase text NOT NULL CHECK (phase IN ('main', 'on-failure', 'cleanup')),
  -- on-failure steps: the step whose failure runs them; cleanup steps from a step definition: the
  -- step that must have started for them to run.
  parent_id text,
  action text NOT NULL,
  driver text,
  runs_on text NOT NULL CHECK (runs_on IN ('control-plane', 'site', 'node', 'ramdisk')),
  command_kind text,
  args jsonb NOT NULL DEFAULT '{}',
  state text NOT NULL CHECK (state IN ('pending', 'running', 'waiting', 'succeeded', 'failed', 'skipped', 'cancelled')),
  attempt int NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  retries int NOT NULL DEFAULT 0 CHECK (retries >= 0),
  timeout_ms bigint NOT NULL CHECK (timeout_ms > 0),
  await text CHECK (await = 'rejoin'),
  on_failure jsonb,
  when_expr text,
  idempotency_key text NOT NULL,
  -- Denormalized from the workflow for the in-flight index.
  node_id text,
  command_id text,
  -- await 'rejoin': the node's boot_id and role when the command was sent.
  sent_boot_id text,
  sent_role text,
  started_at timestamptz,
  deadline timestamptz,
  finished_at timestamptz,
  result jsonb,
  error jsonb,
  PRIMARY KEY (workflow_id, id),
  UNIQUE (workflow_id, index)
);
-- One in-flight step per node.
CREATE UNIQUE INDEX workflow_steps_inflight_node ON workflow_steps (node_id)
  WHERE state IN ('running', 'waiting') AND node_id IS NOT NULL;
CREATE INDEX workflow_steps_command ON workflow_steps (command_id) WHERE command_id IS NOT NULL;
`,
  },
]);
