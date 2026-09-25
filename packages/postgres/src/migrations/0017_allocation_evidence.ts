import type { Migration } from '@better-compute/core';

/**
 * Node-attested `AllocationBound` (PLAN.md §16 v0.2 exit "a gateway-forged AllocationBound is
 * rejected", P14), the pattern of `commands.result_sig` in core/0012: capacity's
 * `markAllocationBound` stores the node's report as received, and the worker verifies it against
 * `node_certs` before the reservation goes active.
 * - `bound_report`: the raw `AttestedReport.body`;
 * - `bound_sig_kid`, `bound_sig`: its `node_sig` (NULL when the report came unsigned).
 * Written by capacity only. Additive.
 */
export const allocationEvidenceMigration: Migration = {
  name: 'core/0017_allocation_evidence',
  sql: `
ALTER TABLE allocations
  ADD COLUMN bound_report bytea,
  ADD COLUMN bound_sig_kid text,
  ADD COLUMN bound_sig bytea;
`,
};
