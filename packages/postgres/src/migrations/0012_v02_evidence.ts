import type { Migration } from '@better-compute/core';

/**
 * Node evidence (PLAN.md §3.3, §6, §13, P14). Additive only.
 * - `commands.result_sig_kid`, `result_sig`: `CommandUpdate.node_sig` as the gateway received it.
 *   `commands.attested` only says the kind's result must be node-signed. Workers verify the stored
 *   signature against `node_certs` before any transition that depends on the result (a release
 *   reaches `ready` only after an attested wipe), so a gateway cannot forge one.
 * - `node_bindings`: an attestor's stable hardware subject (sha256 of a TPM EK, ...) bound to the node
 *   it admitted (`AttestationResult.bind`). JoinService inserts after issuing and refuses
 *   `bound-elsewhere` when the subject names another node. `nodes.delete` and retirement drop the
 *   node's rows, so the machine can join again.
 */
export const v02EvidenceMigration: Migration = {
  name: 'core/0012_v02_evidence',
  sql: `
ALTER TABLE commands ADD COLUMN result_sig_kid text;
ALTER TABLE commands ADD COLUMN result_sig bytea;

CREATE TABLE node_bindings (
  attestor text NOT NULL,
  subject bytea NOT NULL CHECK (length(subject) = 32),
  node_id text NOT NULL REFERENCES nodes,
  bound_at timestamptz NOT NULL DEFAULT compute_now(),
  PRIMARY KEY (attestor, subject)
);
CREATE INDEX node_bindings_node ON node_bindings (node_id);
`,
};

/** The tables `core/0012_v02_evidence` creates. */
export const v02EvidenceTables = ['node_bindings'] as const;
