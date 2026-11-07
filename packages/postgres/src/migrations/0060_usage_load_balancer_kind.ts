import type { Migration } from '@better-compute/core';

/**
 * (DO P4) `usage_windows.source_kind` accepts `loadBalancer`: vps meters provider load balancers
 * (`vps.load-balancer.hours`) by default (`provider-resource-usage.ts`). As core/0044, the CHECK is rewritten as the
 * full list of kinds (`kubernetes` included); the kubernetes module's migration lists `loadBalancer` too, so whichever
 * runs last accepts every kind.
 *
 * `NOT VALID`, as core/0029 added it: existing rows are not scanned, and inserts and updates are still checked.
 */
export const usageLoadBalancerKindMigration: Migration = {
  name: 'core/0060_usage_load_balancer_kind',
  sql: `
ALTER TABLE usage_windows DROP CONSTRAINT IF EXISTS usage_windows_source_kind_ck;
ALTER TABLE usage_windows
  ADD CONSTRAINT usage_windows_source_kind_ck
    CHECK (source_kind IN ('allocation', 'instance', 'grant', 'network', 'snapshot', 'cost', 'kubernetes', 'volume',
                           'address', 'loadBalancer')) NOT VALID;
`,
};
