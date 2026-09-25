import { createHash } from 'node:crypto';
import { ComputeError, type Logger, type Migration, type SqlExecutor } from '@better-compute/core';
import { sameApproverSet, verifyApproverSetChange, type ApproverSet } from '@better-compute/pki';
import { approverSetInput } from '@better-compute/protocol';
import type { JoinTrustBundle } from '../join/crypto.js';

// The trust bundle's version, kept honest (quorum review #6 M5). A daemon takes a bundle only when
// its version is newer than the one it holds, so a changed bundle (new roots, approvers, tiers)
// that keeps its old version would reach no daemon, silently. The deployment keeps the digest of the
// bundle it last published: a process whose bundle differs publishes the next version (or
// `pki.trustVersion`, when that is higher), and every process with that bundle then agrees on it.
//
// A quorum change also needs the current approvers' signatures for its exact version (H1,
// `pki.approvers.setSignatures` for `pki.trustVersion`): they are published only when the settled
// version is the signed one, a changed quorum whose signatures name another version refuses to
// start, and a changed quorum without signatures is published with a warning (daemons holding
// approver keys keep their old quorum until it is signed).

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

/** The published quorum, to tell a quorum change from a root rotation and to check its signatures. */
export const trustBundleApproverSetMigration: Migration = {
  name: 'quorum/0004_trust_bundle_approver_set',
  sql: `ALTER TABLE trust_bundle_state ADD COLUMN approver_set jsonb;`,
};

/** The quorum fields of a bundle (TrustBundle 3-6). */
const approverSetOf = (bundle: JoinTrustBundle): ApproverSet => ({
  approverKeys: bundle.approverKeys ?? [],
  approverThreshold: bundle.approverThreshold ?? 0,
  quorumTiers: bundle.quorumTiers ?? [],
  unbatchedDestructivePerHour: bundle.unbatchedDestructivePerHour ?? 0,
});

interface StoredApproverSet {
  keys: { kid: string; spki: string }[];
  threshold: number;
  tiers: { maxScopeSize: number; threshold: number }[];
  unbatched: number;
}

const storeSet = (set: ApproverSet): StoredApproverSet => ({
  keys: set.approverKeys.map((key) => ({
    kid: key.kid,
    spki: Buffer.from(key.spkiDer).toString('base64'),
  })),
  threshold: set.approverThreshold,
  tiers: set.quorumTiers.map((tier) => ({ ...tier })),
  unbatched: set.unbatchedDestructivePerHour,
});

const loadSet = (stored: StoredApproverSet): ApproverSet => ({
  approverKeys: stored.keys.map((key) => ({
    kid: key.kid,
    spkiDer: new Uint8Array(Buffer.from(key.spki, 'base64')),
  })),
  approverThreshold: stored.threshold,
  quorumTiers: stored.tiers,
  unbatchedDestructivePerHour: stored.unbatched,
});

/** SHA-256 over what a bundle publishes besides its version: its roots (as a set) and quorum fields. */
export function trustBundleDigest(bundle: JoinTrustBundle): Uint8Array {
  const hash = createHash('sha256');
  const roots = bundle.commandSigningRoots
    .map((root) => createHash('sha256').update(root).digest('hex'))
    .sort();
  hash.update(`roots:${roots.length}:${roots.join(',')}\n`);
  hash.update(approverSetInput(approverSetOf(bundle)));
  return new Uint8Array(hash.digest());
}

/**
 * Settles `bundle.version` (and whether its approver-set signatures are published) against the
 * deployment's record, once per process (retried after a failure): the recorded version when the
 * bundle is unchanged, the next one when it changed, and never below the configured
 * `pki.trustVersion`. Without the table yet (a process that runs before any process migrated), the
 * configured version stands.
 */
export function trustVersionSettler(
  database: SqlExecutor,
  bundle: JoinTrustBundle,
  options: { log?: Logger } = {},
): () => Promise<void> {
  const configured = bundle.version;
  const signatures = bundle.approverSetSignatures ?? [];
  let settled: Promise<void> | undefined;
  const settle = async () => {
    const exists = await database.query<{ table: string | null }>(
      `SELECT to_regclass('trust_bundle_state')::text AS table`,
    );
    if (!exists.rows[0]?.table) return;
    const digest = trustBundleDigest(bundle);
    const set = approverSetOf(bundle);
    const outcome = await database.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO trust_bundle_state (id, version, digest, approver_set)
           VALUES ('current', $1, $2, $3::jsonb)
           ON CONFLICT (id) DO NOTHING`,
        [configured.toString(), digest, JSON.stringify(storeSet(set))],
      );
      const { rows } = await tx.query<{
        version: string;
        digest: Uint8Array;
        approver_set: StoredApproverSet | null;
      }>(
        `SELECT version::text AS version, digest, approver_set
           FROM trust_bundle_state WHERE id = 'current' FOR UPDATE`,
      );
      const row = rows[0]!;
      const recorded = BigInt(row.version);
      const same = Buffer.from(row.digest).equals(Buffer.from(digest));
      const floor = same ? recorded : recorded + 1n;
      const version = configured > floor ? configured : floor;
      const previous = row.approver_set ? loadSet(row.approver_set) : undefined;
      const quorumChanged = previous !== undefined && !sameApproverSet(previous, set);
      // Signatures bind a version: for a changed quorum published under another one, they are
      // worthless and daemons would keep the old quorum. Refuse before recording anything.
      if (signatures.length && quorumChanged && version !== configured)
        throw new ComputeError(
          'INVALID_CONFIG',
          `pki.approvers.setSignatures are for trust bundle version ${configured}, but this bundle publishes version ${version}: sign the quorum for version ${version} (better-compute batch sign-approvers --version ${version}) and set pki.trustVersion to it`,
          undefined,
          { signedVersion: configured.toString(), version: version.toString() },
        );
      if (version !== recorded || !same || !row.approver_set)
        await tx.query(
          `UPDATE trust_bundle_state SET version = $1, digest = $2, approver_set = $3::jsonb,
                  updated_at = now()
            WHERE id = 'current'`,
          [version.toString(), digest, JSON.stringify(storeSet(set))],
        );
      return { version, previous, quorumChanged };
    });
    bundle.version = outcome.version;
    // Published only for the version they sign (an unchanged quorum needs none).
    bundle.approverSetSignatures = outcome.version === configured ? signatures : [];
    if (!outcome.quorumChanged || !outcome.previous?.approverKeys.length) return;
    // A quorum change that daemons holding keys will refuse: say so loudly, once per process.
    try {
      verifyApproverSetChange(outcome.previous, {
        ...set,
        version: outcome.version,
        approverSetSignatures: bundle.approverSetSignatures,
      });
    } catch (error) {
      options.log?.warn(
        `The trust bundle changes the approver quorum without k signatures of the previous approvers: daemons that hold approver keys keep the old quorum. Sign it with better-compute batch sign-approvers --version ${outcome.version} and set pki.approvers.setSignatures and pki.trustVersion.`,
        {
          version: outcome.version.toString(),
          reason: error instanceof ComputeError ? error.details?.reason : String(error),
        },
      );
    }
  };
  return () =>
    (settled ??= settle().catch((error: unknown) => {
      settled = undefined;
      throw error;
    }));
}
