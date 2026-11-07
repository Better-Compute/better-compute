import type { Migration } from '@better-compute/core';

/**
 * (DO P4) `usage_windows.source_kind` accepts `loadBalancer`: vps meters provider load balancers
 * (`vps.load-balancer.hours`) by default (`provider-resource-usage.ts`). As core/0044, this appends the kind to
 * whatever the CHECK holds instead of rewriting the list, so a kind a module's migration added (`kubernetes`,
 * `cloud-resource`) stays; the module migrations append the same way, so whichever runs last accepts every kind.
 * The kind has an upper-case letter, so the values are read case-sensitively (as core/0044 and the module
 * migrations read them).
 *
 * `NOT VALID`, as core/0029 added it: existing rows are not scanned, and inserts and updates are still checked.
 */
export const usageLoadBalancerKindMigration: Migration = {
  name: 'core/0060_usage_load_balancer_kind',
  sql: `
DO $$
DECLARE
  kinds text[];
  added text[] := ARRAY['loadBalancer'];
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
