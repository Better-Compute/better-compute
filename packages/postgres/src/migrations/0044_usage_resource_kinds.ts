import type { Migration } from '@better-compute/core';

/**
 * (DO P2) `usage_windows.source_kind` accepts `volume` and `address`: vps meters provider volumes
 * (`vps.volume.gib.hours`) and reserved addresses (`vps.address.hours`) by default
 * (`provider-resource-usage.ts`). The CHECK is rewritten as the full list of kinds, `kubernetes` included (the
 * kubernetes module's migration adds it, and on a database where that migration already ran this one must keep it);
 * that migration's own list carries `volume` and `address` too, so whichever runs last accepts every kind.
 *
 * `NOT VALID`, as core/0029 added it: existing rows are not scanned, and inserts and updates are still checked.
 */
export const usageResourceKindsMigration: Migration = {
  name: 'core/0044_usage_resource_kinds',
  sql: `
ALTER TABLE usage_windows DROP CONSTRAINT IF EXISTS usage_windows_source_kind_ck;
ALTER TABLE usage_windows
  ADD CONSTRAINT usage_windows_source_kind_ck
    CHECK (source_kind IN ('allocation', 'instance', 'grant', 'network', 'snapshot', 'cost', 'kubernetes', 'volume',
                           'address')) NOT VALID;
`,
};
