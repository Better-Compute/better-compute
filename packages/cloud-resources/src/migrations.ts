import type { Migration } from '@better-compute/core';

/**
 * Cloud resources: the long tail of a provider's managed services (databases, apps, functions, …) in one table.
 * The API records what the tenant wants (`desired_state`, `spec`); the `cloud.resources` reconciler converges the
 * provider through `ProviderImpl.resources` and writes back `state` and the outputs. `secret_outputs` holds
 * SecretRefs only: the values are sealed into the SecretStore in the run that received them and never stored here.
 * A resource references the vps tables it lives on (pool, provider account) by id only, without foreign keys: vps
 * owns those rows and their deletion rules.
 */
export const cloudResourcesMigration: Migration = {
  name: 'cloud-resources/0001_resources',
  sql: `
CREATE TABLE cloud_resources (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  project_id text,
  pool_id text NOT NULL,
  provider_account_id text NOT NULL,
  provider text NOT NULL,
  kind text NOT NULL,
  family text NOT NULL
    CHECK (family IN ('storage', 'network', 'edge', 'data', 'platform', 'ai', 'observability')),
  name text NOT NULL,
  description text,
  region text,
  -- A cloud resource of the kind's parent kind that this one lives in (a database user's database).
  parent_id text REFERENCES cloud_resources,
  spec jsonb NOT NULL,
  -- The provider-side name (bc-r-...), and the id the provider answered (null until it accepted the resource).
  provider_name text NOT NULL,
  provider_id text,
  state text NOT NULL
    CHECK (state IN ('pending', 'provisioning', 'ready', 'updating', 'deleting', 'deleted', 'released', 'error')),
  desired_state text NOT NULL CHECK (desired_state IN ('present', 'deleted', 'released')),
  message text,
  outputs jsonb NOT NULL DEFAULT '{}',
  -- name -> SecretRef. Never a value.
  secret_outputs jsonb NOT NULL DEFAULT '{}',
  adopted bool NOT NULL DEFAULT false,
  -- The caller identity: idempotency keys are scoped to (tenant, caller), as the id derives from them.
  created_by text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash bytea NOT NULL,
  version bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT compute_now(),
  updated_at timestamptz NOT NULL DEFAULT compute_now(),
  -- The provider first accepted the resource: it exists provider-side (and bills) from here.
  provisioned_at timestamptz,
  ready_at timestamptz,
  deleted_at timestamptz,
  UNIQUE (tenant_id, created_by, idempotency_key)
);
-- A deleted or released resource's name is free again.
CREATE UNIQUE INDEX cloud_resources_name ON cloud_resources (tenant_id, kind, name)
  WHERE state NOT IN ('deleted', 'released');
-- One live row per provider resource: a resource is never adopted twice, nor adopted while it is created here.
CREATE UNIQUE INDEX cloud_resources_provider_id ON cloud_resources (provider_account_id, kind, provider_id)
  WHERE provider_id IS NOT NULL AND state NOT IN ('deleted', 'released');
CREATE INDEX cloud_resources_tenant ON cloud_resources (tenant_id, created_at)
  WHERE state NOT IN ('deleted', 'released');
CREATE INDEX cloud_resources_parent ON cloud_resources (parent_id) WHERE parent_id IS NOT NULL;
-- The reconciler's 30 s sweep: resources still converging (or being deleted or released).
CREATE INDEX cloud_resources_converging ON cloud_resources (id)
  WHERE state IN ('pending', 'provisioning', 'updating', 'deleting')
     OR (desired_state <> 'present' AND state NOT IN ('deleted', 'released'));
-- The 5 min refresh: settled resources, ready or in error.
CREATE INDEX cloud_resources_settled ON cloud_resources (id) WHERE state IN ('ready', 'error');
`,
};

export const cloudResourcesMigrations: readonly Migration[] = Object.freeze([
  cloudResourcesMigration,
]);
