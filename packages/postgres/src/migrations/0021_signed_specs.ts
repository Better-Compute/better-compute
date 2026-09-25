import type { Migration } from '@better-compute/core';

/**
 * Signed NodeSpecs (PLAN.md §16 v0.4 "signing of all commands and specs"; asked by [402c97]): the
 * gateway holds no signing key, so the worker that writes `nodes.spec` (the NodeSpec reconciler,
 * under a worker signing key) also stores the exact signed bytes, and the gateway relays them
 * verbatim. `spec_body` is the serialized `DesiredStateBody` for `nodes.generation`; NULL means
 * unsigned. Additive.
 */
export const signedSpecsMigration: Migration = {
  name: 'core/0021_signed_specs',
  sql: `
ALTER TABLE nodes
  ADD COLUMN spec_body bytea,
  ADD COLUMN spec_signature bytea;
`,
};
