import { createHash } from 'node:crypto';
import type { Migration, SqlExecutor } from '@better-compute/core';
import { approverSetInput } from '@better-compute/protocol';
import type { JoinTrustBundle } from '../join/crypto.js';

// The trust bundle's version, kept honest (quorum review #6 M5). A daemon takes a bundle only when
// its version is newer than the one it holds, so a changed bundle (new roots, approvers, tiers)
// that keeps its old version would reach no daemon, silently. The deployment keeps the digest of the
// bundle it last published: a process whose bundle differs publishes the next version (or
// `pki.trustVersion`, when that is higher), and every process with that bundle then agrees on it.

export const trustBundleStateMigration: Migration = {
  name: 'quorum/0003_trust_bundle_state',
  sql: `
CREATE TABLE trust_bundle_state (
  id text PRIMARY KEY CHECK (id = 'current'),
  version numeric(20, 0) NOT NULL CHECK (version >= 1),
  digest bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
`,
};

/** SHA-256 over what a bundle publishes besides its version: its roots (as a set) and quorum fields. */
export function trustBundleDigest(bundle: JoinTrustBundle): Uint8Array {
  const hash = createHash('sha256');
  const roots = bundle.commandSigningRoots
    .map((root) => createHash('sha256').update(root).digest('hex'))
    .sort();
  hash.update(`roots:${roots.length}:${roots.join(',')}\n`);
  hash.update(
    approverSetInput({
      approverKeys: bundle.approverKeys ?? [],
      approverThreshold: bundle.approverThreshold ?? 0,
      quorumTiers: bundle.quorumTiers ?? [],
      unbatchedDestructivePerHour: bundle.unbatchedDestructivePerHour ?? 0,
    }),
  );
  return new Uint8Array(hash.digest());
}

/**
 * Settles `bundle.version` against the deployment's record, once per process (retried after a
 * failure): the recorded version when the bundle is unchanged, the next one when it changed, and
 * never below the configured `pki.trustVersion`. Without the table yet (a process that runs before
 * any process migrated), the configured version stands.
 */
export function trustVersionSettler(
  database: SqlExecutor,
  bundle: JoinTrustBundle,
): () => Promise<void> {
  const configured = bundle.version;
  let settled: Promise<void> | undefined;
  const settle = async () => {
    const exists = await database.query<{ table: string | null }>(
      `SELECT to_regclass('trust_bundle_state')::text AS table`,
    );
    if (!exists.rows[0]?.table) return;
    const digest = trustBundleDigest(bundle);
    bundle.version = await database.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO trust_bundle_state (id, version, digest) VALUES ('current', $1, $2)
           ON CONFLICT (id) DO NOTHING`,
        [configured.toString(), digest],
      );
      const { rows } = await tx.query<{ version: string; digest: Uint8Array }>(
        `SELECT version::text AS version, digest FROM trust_bundle_state WHERE id = 'current' FOR UPDATE`,
      );
      const recorded = BigInt(rows[0]!.version);
      const same = Buffer.from(rows[0]!.digest).equals(Buffer.from(digest));
      const floor = same ? recorded : recorded + 1n;
      const version = configured > floor ? configured : floor;
      if (version !== recorded || !same)
        await tx.query(
          `UPDATE trust_bundle_state SET version = $1, digest = $2, updated_at = now() WHERE id = 'current'`,
          [version.toString(), digest],
        );
      return version;
    });
  };
  return () =>
    (settled ??= settle().catch((error: unknown) => {
      settled = undefined;
      throw error;
    }));
}
