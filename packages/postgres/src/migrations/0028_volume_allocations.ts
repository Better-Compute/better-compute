import type { Migration } from '@better-compute/core';

/**
 * (v1.1, agent memory) Allocations may belong to a persistent volume (vps `sandboxVolumes`): its disk on
 * one host, booked as `diskGiB` through the CapacityPort (`PlacementRequest.volumeId`), charged to the
 * tenant's quota, until the volume is gone. Scalar resources only, never devices.
 */
export const volumeAllocationsMigration: Migration = {
  name: 'core/0028_volume_allocations',
  sql: `
ALTER TABLE allocations DROP CONSTRAINT allocations_owner_kind_check;
ALTER TABLE allocations ADD CONSTRAINT allocations_owner_kind_check
  CHECK (owner_kind IN ('reservation', 'instance', 'volume'));
`,
};
