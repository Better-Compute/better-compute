import type { Migration } from '@better-compute/core';

/**
 * v0.2 server and attestor follow-ups (PLAN.md §3.3, §9.2). Additive only.
 * - `sites.deleted_at`: `sites.delete` tombstones a site that pools, nodes or join requests ever
 *   referenced, so those rows keep their foreign key. NULL means live.
 * - `attestation_uses`: evidence an attestor admits only once (a cloud instance identity, a discovery
 *   assertion), keyed by sha256 of what must not be replayed. Attestors insert it in the join
 *   transaction of the final round (`ON CONFLICT DO NOTHING`, refusing on conflict), so deferrals do
 *   not burn it. `expires_at` NULL keeps it forever. `pruneAttestationUses` drops the expired rows.
 */
export const v02SecurityMigration: Migration = {
  name: 'core/0011_v02_security',
  sql: `
ALTER TABLE sites ADD COLUMN deleted_at timestamptz;

CREATE TABLE attestation_uses (
  attestor text NOT NULL,
  subject bytea NOT NULL CHECK (length(subject) = 32),
  node_id text,
  used_at timestamptz NOT NULL DEFAULT compute_now(),
  expires_at timestamptz,
  PRIMARY KEY (attestor, subject)
);
CREATE INDEX attestation_uses_expiry ON attestation_uses (expires_at) WHERE expires_at IS NOT NULL;
`,
};

/** The tables `core/0011_v02_security` creates. */
export const v02SecurityTables = ['attestation_uses'] as const;
