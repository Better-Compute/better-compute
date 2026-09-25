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
// A quorum change also needs the current approvers' signatures (H1), for the set's own epoch
// (review #7 M1, `pki.approvers.epoch` and `setSignatures`), which they keep on every later version. A
// changed quorum without valid signatures for a higher epoch is published with a warning: daemons
// holding approver keys keep their old quorum (and take the rest of the bundle) until it is signed.

export const trustBundleStateMigration: Migration = {
  name: 'quorum/0003_trust_bundle_state',
  sql: `
CREATE TABLE trust_bundle_state (
  id text PRIMARY KEY CHECK (id = 'current'),
  version numeric(20, 0) NOT NULL CHECK (version >= 1),
  digest bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT compute_now()
);
`,
};

/** The published quorum, to tell a quorum change from a root rotation and to check its signatures. */
export const trustBundleApproverSetMigration: Migration = {
  name: 'quorum/0004_trust_bundle_approver_set',
  sql: `ALTER TABLE trust_bundle_state ADD COLUMN approver_set jsonb;`,
};

/**
 * Every bundle digest published, with its (latest) version: a stale replica never bumps one again,
 * and refuses to start. (A bundle replaced before this history existed is not in it: the first stale
 * restart after the migration still takes a new version, once.)
 */
export const trustBundleHistoryMigration: Migration = {
  name: 'quorum/0006_trust_bundle_history',
  sql: `
CREATE TABLE trust_bundle_history (
  digest bytea PRIMARY KEY,
  version numeric(20, 0) NOT NULL,
  published_at timestamptz NOT NULL DEFAULT compute_now()
);
`,
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
  /** The set's epoch (absent in records from before epochs: 0). */
  epoch?: string;
}

const storeSet = (set: ApproverSet, epoch: bigint): StoredApproverSet => ({
  epoch: epoch.toString(),
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
  // The epoch and its signatures too (review 10 L): a new epoch, or signatures added for it (the
  // set's own, so daemons advance), is a new bundle that daemons must receive.
  const signatures = (bundle.approverSetSignatures ?? [])
    .map((signature) => `${signature.kid}:${Buffer.from(signature.sig).toString('hex')}`)
    .sort();
  hash.update(`\nepoch:${bundle.approverSetEpoch ?? 0n}\nsignatures:${signatures.join(',')}`);
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
  options: { log?: Logger; trustDomain?: string | undefined } = {},
): () => Promise<void> {
  const configured = bundle.version;
  const signatures = bundle.approverSetSignatures ?? [];
  const epoch = bundle.approverSetEpoch ?? 0n;
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
        [configured.toString(), digest, JSON.stringify(storeSet(set, epoch))],
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
      // Every bundle published so far (the record seeds it where it predates the history).
      await tx.query(
        `INSERT INTO trust_bundle_history (digest, version) VALUES ($1, $2::numeric)
           ON CONFLICT (digest) DO NOTHING`,
        [row.digest, row.version],
      );
      // A bundle published before and since replaced (an old replica restarting with its old
      // config) keeps its old version, which daemons ignore: bumping it would roll them back, e.g.
      // to a command-signing root that was removed. Only an explicit pki.trustVersion above the
      // record republishes it.
      if (!same && configured <= recorded) {
        const past = await tx.query<{ version: string }>(
          'SELECT version::text AS version FROM trust_bundle_history WHERE digest = $1',
          [digest],
        );
        if (past.rows[0])
          return {
            version: BigInt(past.rows[0].version),
            stale: recorded,
            previous: undefined,
            previousEpoch: 0n,
            quorumChanged: false,
          };
      }
      const floor = same ? recorded : recorded + 1n;
      const version = configured > floor ? configured : floor;
      const previous = row.approver_set ? loadSet(row.approver_set) : undefined;
      const previousEpoch = BigInt(row.approver_set?.epoch ?? 0);
      const quorumChanged = previous !== undefined && !sameApproverSet(previous, set);
      if (version !== recorded || !same || !row.approver_set)
        await tx.query(
          `UPDATE trust_bundle_state SET version = $1, digest = $2, approver_set = $3::jsonb,
                  updated_at = compute_now()
            WHERE id = 'current'`,
          [version.toString(), digest, JSON.stringify(storeSet(set, epoch))],
        );
      await tx.query(
        `INSERT INTO trust_bundle_history (digest, version) VALUES ($1, $2::numeric)
           ON CONFLICT (digest) DO UPDATE SET version = EXCLUDED.version, published_at = compute_now()`,
        [digest, version.toString()],
      );
      return { version, stale: undefined, previous, previousEpoch, quorumChanged };
    });
    // Refuse rather than serve it: daemons that hold the newer bundle would ignore it, but a node
    // joining through this process would take the old roots (e.g. one removed as compromised).
    if (outcome.stale !== undefined)
      throw new ComputeError(
        'INVALID_CONFIG',
        `This process's trust bundle is the one published as version ${outcome.version}, since replaced by version ${outcome.stale}: update its configuration, or set pki.trustVersion above ${outcome.stale} to publish this bundle again on purpose`,
        undefined,
        { version: outcome.version.toString(), current: outcome.stale.toString() },
      );
    bundle.version = outcome.version;
    if (!outcome.quorumChanged || !outcome.previous?.approverKeys.length) return;
    // A quorum change that daemons holding keys will refuse: say so loudly, once per process.
    try {
      verifyApproverSetChange(
        { ...outcome.previous, epoch: outcome.previousEpoch },
        { ...set, epoch, approverSetSignatures: signatures, trustDomain: options.trustDomain },
      );
    } catch (error) {
      const next = outcome.previousEpoch + 1n;
      options.log?.warn(
        `The trust bundle changes the approver quorum without k signatures of the previous approvers for a higher epoch: daemons that hold approver keys keep the old quorum. Sign it with better-compute batch sign-approvers --epoch ${next} and set pki.approvers.epoch to ${next} and pki.approvers.setSignatures.`,
        {
          version: outcome.version.toString(),
          epoch: epoch.toString(),
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
