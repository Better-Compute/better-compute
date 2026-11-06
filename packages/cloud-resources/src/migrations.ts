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

/** The usage source kind of a cloud resource's windows (`cmp:cloud-resource:<id>:<windowStartMs>:<meter>`). */
export const cloudResourceSourceKind = 'cloud-resource';

/**
 * Metering (see usage.ts). `metered_until` is how far `cloud.resources.usage` has written windows (NULL until it
 * first meters the resource, from `provisioned_at`, or `ready_at` for an adopted one); `meter_rates` is the rate
 * of each of the kind's meters the provider last reported (`ProviderResourceState.usage`).
 *
 * `usage_windows` gains the `cloud-resource` source kind. The CHECK is not replaced by a fixed list (another
 * module's migration may have added its own kind already): its current values are read back and this one is
 * appended, `NOT VALID` as in core/0029, so no partition is scanned. A migration that later replaces the CHECK
 * with a list without `cloud-resource` is reported by the module's selfCheck (`cloud-resources.usage-source`).
 */
export const cloudResourcesMeteringMigration: Migration = {
  name: 'cloud-resources/0002_metering',
  sql: `
ALTER TABLE cloud_resources ADD COLUMN metered_until timestamptz;
ALTER TABLE cloud_resources ADD COLUMN meter_rates jsonb NOT NULL DEFAULT '{}';
-- What cloud.resources.usage scans: resources that bill, or billed until an end it has not covered yet.
CREATE INDEX cloud_resources_unmetered ON cloud_resources ((coalesce(metered_until, provisioned_at, ready_at)))
  WHERE coalesce(provisioned_at, ready_at) IS NOT NULL
    AND (deleted_at IS NULL OR metered_until IS DISTINCT FROM deleted_at);

DO $$
DECLARE
  kinds text[];
BEGIN
  SELECT array_agg(DISTINCT m.value[1]) INTO kinds
    FROM pg_constraint c
    -- Each value, as PostgreSQL renders it: ARRAY['a'::text, …] or '{a,b}'::text[].
    CROSS JOIN LATERAL regexp_matches(pg_get_constraintdef(c.oid), '[''{,]([a-z0-9_-]+)(?=[''},])', 'g') AS m(value)
   WHERE c.conname = 'usage_windows_source_kind_ck' AND c.conrelid = 'usage_windows'::regclass;
  IF kinds IS NULL THEN
    kinds := ARRAY['allocation', 'instance', 'grant', 'network', 'snapshot', 'cost'];
  END IF;
  IF NOT ('${cloudResourceSourceKind}' = ANY (kinds)) THEN
    ALTER TABLE usage_windows DROP CONSTRAINT IF EXISTS usage_windows_source_kind_ck;
    kinds := kinds || '${cloudResourceSourceKind}'::text;
    EXECUTE 'ALTER TABLE usage_windows ADD CONSTRAINT usage_windows_source_kind_ck CHECK (source_kind IN ('
      || (SELECT string_agg(quote_literal(k), ', ' ORDER BY k) FROM unnest(kinds) AS k)
      || ')) NOT VALID';
  END IF;
END $$;
`,
};

/**
 * One provider resource, one live row; and adoption that does not hang on the row's version.
 *
 * - `identity`: the kind's `identity(spec)` for a resource with a parent (a database user's name, `firewall` for a
 *   cluster's single firewall). At most one live resource of a kind has it in one parent, so two rows never fight
 *   over one provider resource (each re-applying its own spec).
 * - `spec_changed`: the tenant changed the spec of an adopted resource (`cloudResources.update`). Until then it is
 *   observed, its spec the provider's; a description change does not count.
 */
export const cloudResourcesIdentityMigration: Migration = {
  name: 'cloud-resources/0003_identity',
  sql: `
ALTER TABLE cloud_resources ADD COLUMN identity text;
ALTER TABLE cloud_resources ADD COLUMN spec_changed bool NOT NULL DEFAULT false;
CREATE UNIQUE INDEX cloud_resources_identity ON cloud_resources (parent_id, kind, identity)
  WHERE parent_id IS NOT NULL AND identity IS NOT NULL AND state NOT IN ('deleted', 'released');
`,
};

export const cloudResourcesMigrations: readonly Migration[] = Object.freeze([
  cloudResourcesMigration,
  cloudResourcesMeteringMigration,
  cloudResourcesIdentityMigration,
]);
