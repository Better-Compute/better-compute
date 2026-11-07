import type { Migration } from '@better-compute/core';

/**
 * (DO P2) `usage_windows.source_kind` accepts `volume` and `address`: vps meters provider volumes
 * (`vps.volume.gib.hours`) and reserved addresses (`vps.address.hours`) by default
 * (`provider-resource-usage.ts`). Modules add their own kinds to the same CHECK (`kubernetes`, `cloud-resource`), so
 * this appends the two kinds to whatever the CHECK holds instead of rewriting the list: on a database where a
 * module's migration already ran, its kind stays. The kubernetes and cloud-resources migrations append the same way,
 * so whichever runs last accepts every kind.
 *
 * `NOT VALID`, as core/0029 added it: existing rows are not scanned, and inserts and updates are still checked.
 */
export const usageResourceKindsMigration: Migration = {
  name: 'core/0044_usage_resource_kinds',
  sql: `
DO $$
DECLARE
  kinds text[];
  added text[] := ARRAY['volume', 'address'];
BEGIN
  SELECT array_agg(DISTINCT m.value[1]) INTO kinds
    FROM pg_constraint c
    -- Each value, as PostgreSQL renders it: ARRAY['a'::text, …] or '{a,b}'::text[].
    CROSS JOIN LATERAL regexp_matches(pg_get_constraintdef(c.oid), '[''{,]([A-Za-z0-9_-]+)(?=[''},])', 'g') AS m(value)
   WHERE c.conname = 'usage_windows_source_kind_ck' AND c.conrelid = 'usage_windows'::regclass;
  IF kinds IS NULL THEN
    kinds := ARRAY['allocation', 'instance', 'grant', 'network', 'snapshot', 'cost'];
  END IF;
  IF NOT (added <@ kinds) THEN
    ALTER TABLE usage_windows DROP CONSTRAINT IF EXISTS usage_windows_source_kind_ck;
    kinds := ARRAY(SELECT DISTINCT k FROM unnest(kinds || added) AS k);
    EXECUTE 'ALTER TABLE usage_windows ADD CONSTRAINT usage_windows_source_kind_ck CHECK (source_kind IN ('
      || (SELECT string_agg(quote_literal(k), ', ' ORDER BY k) FROM unnest(kinds) AS k)
      || ')) NOT VALID';
  END IF;
END $$;
`,
};
