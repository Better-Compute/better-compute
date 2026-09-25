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
  {
    name: 'provision/0002_images',
    sql: `
-- The image catalog (PLAN.md §11.5). Images are built outside the control plane and registered by
-- digest; a signature from a signer on the tenant's allowlist makes them verified.
CREATE TABLE image_signers (
  tenant_id text NOT NULL,
  id text NOT NULL,
  algorithm text NOT NULL CHECK (algorithm IN ('ed25519', 'ecdsa-p256')),
  -- SPKI PEM.
  public_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT compute_now(),
  revoked_at timestamptz,
  PRIMARY KEY (tenant_id, id)
);
CREATE TABLE images (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  -- name@version, unique per tenant.
  ref text NOT NULL,
  kind text NOT NULL DEFAULT 'os' CHECK (kind IN ('os', 'ramdisk')),
  format text NOT NULL CHECK (format IN ('raw', 'qcow2', 'iso')),
  compression text NOT NULL CHECK (compression IN ('none', 'zstd', 'gzip')),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint CHECK (size_bytes >= 0),
  -- Where site caches pull it from (https:// or oci://).
  source text NOT NULL,
  signature bytea,
  signer_tenant_id text,
  signer_id text,
  verified bool NOT NULL,
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
  created_at timestamptz NOT NULL DEFAULT compute_now(),
  deleted_at timestamptz,
  version bigint NOT NULL DEFAULT 1,
  -- Unsigned images stay tenant-only.
  CHECK (verified OR visibility = 'private')
);
CREATE UNIQUE INDEX images_ref ON images (tenant_id, ref) WHERE deleted_at IS NULL;
CREATE INDEX images_public ON images (ref) WHERE visibility = 'public' AND deleted_at IS NULL;
-- Which site caches hold an image, for the image-cached scorer and LRU eviction.
CREATE TABLE image_locations (
  image_id text NOT NULL REFERENCES images,
  site_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('pulling', 'ready', 'failed', 'evicting')),
  size_bytes bigint,
  pinned bool NOT NULL DEFAULT false,
  last_used_at timestamptz NOT NULL DEFAULT compute_now(),
  updated_at timestamptz NOT NULL DEFAULT compute_now(),
  PRIMARY KEY (image_id, site_id)
);
CREATE INDEX image_locations_site ON image_locations (site_id, state, last_used_at);
`,
  },
  {
    name: 'provision/0003_workflow_owner',
    sql: `
-- The module that started a workflow (e.g. metal): its reconciler is queued, under the workflow's
-- key, whenever the workflow finishes. And the profile document as it was when the workflow
-- started, so steps read the pinned version (image, user data, role) even for shipped profiles.
ALTER TABLE workflows
  ADD COLUMN owner text,
  ADD COLUMN profile_document jsonb;
`,
  },
  {
    name: 'provision/0004_gated_mig_layout',
    sql: `
-- The MIG layout a node may apply now (PLAN.md §10.4, §10.6): capacity freezes a node at its old
-- layout while a pool's new one waits for every atom to be free (capacity/0004 capacity_mig_layouts).
-- provision does not depend on capacity, so this reads the table only when it exists; NULL means the
-- node is not frozen and the pool's layout applies.
CREATE FUNCTION provision_gated_mig_layout(node text) RETURNS text LANGUAGE plpgsql STABLE AS $fn$
DECLARE
  granted text;
BEGIN
  IF to_regclass('capacity_mig_layouts') IS NULL THEN
    RETURN NULL;
  END IF;
  EXECUTE 'SELECT layout FROM capacity_mig_layouts WHERE node_id = $1' INTO granted USING node;
  RETURN granted;
END
$fn$;
`,
  },
]);
