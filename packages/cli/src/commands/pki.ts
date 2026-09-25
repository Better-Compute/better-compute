import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  createPkiBundle,
  exportPkiBundle,
  exportRootKey,
  generateP256KeyPair,
  importPkiBundle,
  pkiPins,
  privateKeyPem,
  parseCertificate,
  readPkiPins,
  renewBundleCa,
  rotateCommandSigningRoot,
  approverSetDigest,
  sameApproverSet,
  verifyApproverSetChange,
  toPem,
  type ApproverSet,
  type BundleCa,
  type CommandRootRotationStage,
  type PkiBundle,
} from '@better-compute/pki';
import type { ImportPkiBundleOptions } from '@better-compute/pki';
import type { Finding, SqlExecutor } from '@better-compute/core';
import { trustBundleDigest } from '@better-compute/server';
import type { AnyComputeOptions } from '../config.js';
import { CliError, usageError } from '../errors.js';
import { defineCommand, type FlagSpec } from '../framework.js';

/** Where the PKI bundle lives unless `--pki` or `BETTER_COMPUTE_PKI` says otherwise. */
export const defaultPkiPath = '.better-compute/pki.json';

export const pkiFlag: FlagSpec = {
  type: 'string',
  value: 'PATH',
  env: 'BETTER_COMPUTE_PKI',
  default: defaultPkiPath,
  description: 'The PKI bundle written by pki init',
};

const minSecret = 32;

/** Writes a file readable only by its owner, never replacing one that exists. */
export async function writeNew(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, content, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new CliError('FILE_EXISTS', `${path} already exists; it was not overwritten`);
    throw error;
  }
}

/** Replaces a file atomically (write beside it, then rename), owner-only. */
export async function replace(path: string, content: string, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, content, { mode });
  await rename(temporary, path);
}

async function readBundleText(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new CliError(
        'PKI_NOT_FOUND',
        `No PKI bundle at ${path}`,
        'Run better-compute pki init first.',
      );
    throw error;
  }
}

/**
 * How the environment unlocks a bundle: BETTER_COMPUTE_SECRET, and BETTER_COMPUTE_PKI_ALLOW_UNAUTHENTICATED=1 for the
 * one run that re-seals a bundle whose public parts nothing authenticates (the former seal format, or unsealed).
 */
export function pkiUnlockOptions(
  env: NodeJS.ProcessEnv,
): Pick<ImportPkiBundleOptions, 'secret' | 'allowUnauthenticated'> {
  return {
    ...(env.BETTER_COMPUTE_SECRET ? { secret: env.BETTER_COMPUTE_SECRET } : {}),
    ...(env.BETTER_COMPUTE_PKI_ALLOW_UNAUTHENTICATED === '1' ? { allowUnauthenticated: true } : {}),
  };
}

/** Loads the bundle, unsealing it with BETTER_COMPUTE_SECRET when it is sealed. */
export async function loadPkiBundle(path: string, env: NodeJS.ProcessEnv): Promise<PkiBundle> {
  return importPkiBundle(await readBundleText(path), pkiUnlockOptions(env));
}

/**
 * Loads the bundle for a command that writes it back sealed in the current format: that would vouch for whatever
 * the file holds, so an unauthenticated bundle is never accepted here, only by `pki reseal` (which prints the pins
 * it seals). BETTER_COMPUTE_PKI_ALLOW_UNAUTHENTICATED is refused rather than silently honored.
 */
async function loadPkiBundleForRewrite(path: string, env: NodeJS.ProcessEnv): Promise<PkiBundle> {
  if (env.BETTER_COMPUTE_PKI_ALLOW_UNAUTHENTICATED === '1')
    throw new CliError(
      'INVALID_STATE',
      'This command writes the bundle back; it does not accept an unauthenticated bundle',
      'Check the pins, run better-compute pki reseal first, then unset BETTER_COMPUTE_PKI_ALLOW_UNAUTHENTICATED.',
    );
  return loadPkiBundle(path, env);
}

/**
 * The pins of the bundle at `path`, checked against its seal when BETTER_COMPUTE_SECRET is set. Without it they come
 * from a file nothing vouches for, and `warn` says so.
 */
export async function readTrustedPins(
  path: string,
  env: NodeJS.ProcessEnv,
  warn: (message: string) => void,
): Promise<ReturnType<typeof readPkiPins>> {
  const pins = readPkiPins(await readBundleText(path), pkiUnlockOptions(env));
  if (!pins.authenticated)
    warn(
      `Warning: the pins in ${path} are not authenticated (set BETTER_COMPUTE_SECRET to check them against the seal); whoever can write that file chooses them.`,
    );
  return pins;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** What to run for an expiring certificate of `readPkiPins().expires`. */
function renewalFor(name: string): string {
  if (name === 'nodeCa' || name === 'servingCa' || name === 'internalCa')
    return `renew it from the root: better-compute pki renew-ca --ca ${name.slice(0, -2)}`;
  if (name === 'commandSigningRoot')
    return 'rotate it: better-compute pki rotate-command-root --stage add, then switch and drop';
  return 'replace the root: a new PKI (pki init), and every node rejoins';
}

/** How far the connected daemons are from a trust bundle version (`node_sessions.trust_version`, §13). */
export interface TrustLag {
  /** Nodes with an open session. */
  connected: number;
  /** Of those, how many have not reported `version` yet. */
  behind: number;
  /** A few of them, for the message. */
  sample: { nodeId: string; trustVersion: number }[];
}

/**
 * Which connected daemons have not applied trust bundle `version` (Hello or StatusReport `trust_version`).
 * Connected: a session on a gateway, not ended, seen within `liveWindowMs` (default 2 minutes, a few gateway
 * lease TTLs). Other nodes do not count: Welcome hands them the current bundle before any command.
 */
export async function trustLag(
  sql: Pick<SqlExecutor, 'query'>,
  version: number,
  liveWindowMs = 120_000,
): Promise<TrustLag> {
  const live = `gateway_id IS NOT NULL AND disconnected_at IS NULL
                AND last_seen > compute_now() - make_interval(secs => $2::float8)`;
  const { rows } = await sql.query<{ connected: string | number; behind: string | number }>(
    `SELECT count(*) AS connected, count(*) FILTER (WHERE trust_version < $1) AS behind
       FROM node_sessions WHERE ${live}`,
    [version, liveWindowMs / 1000],
  );
  const { rows: sample } = await sql.query<{ node_id: string; trust_version: string | number }>(
    `SELECT node_id, trust_version FROM node_sessions
      WHERE ${live} AND trust_version < $1 ORDER BY node_id LIMIT 5`,
    [version, liveWindowMs / 1000],
  );
  return {
    connected: Number(rows[0]?.connected ?? 0),
    behind: Number(rows[0]?.behind ?? 0),
    sample: sample.map((row) => ({ nodeId: row.node_id, trustVersion: Number(row.trust_version) })),
  };
}

const lagText = (lag: TrustLag) =>
  `${lag.behind} of ${lag.connected} connected node(s) have not applied it (${lag.sample
    .map((node) => `${node.nodeId} at ${node.trustVersion}`)
    .join(', ')}${lag.behind > lag.sample.length ? ', …' : ''})`;

/** What the deployment last published as its trust bundle (`trust_bundle_state`, quorum review 6 M5). */
export interface PublishedTrust {
  version: number;
  digest: Uint8Array;
  approverSet?: ApproverSet;
  /** The published set's epoch (0 before epochs, or without a set). */
  approverSetEpoch: number;
}

/** The published trust bundle's record, or undefined before the quorum module migrated (or published). */
export async function publishedTrust(sql: Pick<SqlExecutor, 'query'>): Promise<PublishedTrust | undefined> {
  const { rows: table } = await sql.query<{ name: string | null }>(`SELECT to_regclass('trust_bundle_state')::text AS name`);
  if (!table[0]?.name) return undefined;
  const { rows } = await sql.query<{
    version: string;
    digest: Uint8Array;
    approver_set: {
      keys: { kid: string; spki: string }[];
      threshold: number;
      tiers: ApproverSet['quorumTiers'];
      unbatched: number;
      epoch?: string;
    } | null;
  }>(`SELECT version::text AS version, digest, approver_set FROM trust_bundle_state WHERE id = 'current'`);
  const row = rows[0];
  if (!row) return undefined;
  const stored = row.approver_set;
  return {
    version: Number(row.version),
    digest: new Uint8Array(row.digest),
    approverSetEpoch: Number(stored?.epoch ?? 0),
    ...(stored
      ? {
          approverSet: {
            approverKeys: stored.keys.map((key) => ({ kid: key.kid, spkiDer: new Uint8Array(Buffer.from(key.spki, 'base64')) })),
            approverThreshold: stored.threshold,
            quorumTiers: stored.tiers,
            unbatchedDestructivePerHour: stored.unbatched,
          },
        }
      : {}),
  };
}

interface ConfiguredApprovers {
  keys?: readonly Uint8Array[];
  threshold?: number;
  tiers?: readonly { maxScopeSize: number; threshold: number }[];
  unbatchedDestructivePerHour?: number;
  setSignatures?: readonly { kid: string; sig: string | Uint8Array }[];
  epoch?: number | bigint;
}
const approversOf = (options: AnyComputeOptions) =>
  (options as { pki?: { approvers?: ConfiguredApprovers; trustVersion?: number | bigint } }).pki;

/** The quorum fields `pki.approvers` configures, as the server publishes them (kid = base64url SHA-256 of the SPKI). */
export function configuredApproverSet(options: AnyComputeOptions): ApproverSet {
  const approvers = approversOf(options)?.approvers;
  return {
    approverKeys: (approvers?.keys ?? []).map((spkiDer) => ({
      kid: createHash('sha256').update(spkiDer).digest('base64url'),
      spkiDer: new Uint8Array(spkiDer),
    })),
    approverThreshold: approvers?.threshold ?? 0,
    quorumTiers: approvers?.tiers ?? [],
    unbatchedDestructivePerHour: approvers?.unbatchedDestructivePerHour ?? 0,
  };
}

/**
 * The digest of the trust bundle this bundle and configuration publish, version aside: its command-signing roots
 * (the signing root, then a rotation's next and previous ones) and the configured quorum, as the server hashes them.
 */
export function configuredTrustDigest(bundle: PkiBundle, options: AnyComputeOptions): Uint8Array | undefined {
  if (!bundle.commandSigning) return undefined;
  const roots = [
    bundle.commandSigning.certificate,
    ...(bundle.commandSigningNext ? [bundle.commandSigningNext.certificate] : []),
    ...(bundle.commandSigningPrevious ? [bundle.commandSigningPrevious] : []),
  ];
  // The epoch and set signatures are part of the digest too (review 10 L), resolved as the server does: epoch 1 by
  // default once approvers are configured, signatures as base64url or bytes.
  const approvers = approversOf(options)?.approvers;
  const quorumEpoch = approvers
    ? {
        approverSetEpoch: BigInt(approvers.epoch ?? 1),
        approverSetSignatures: (approvers.setSignatures ?? []).map((signature) => ({
          kid: signature.kid,
          sig:
            typeof signature.sig === 'string'
              ? new Uint8Array(Buffer.from(signature.sig, 'base64url'))
              : new Uint8Array(signature.sig),
        })),
      }
    : {};
  return trustBundleDigest({
    version: 0n,
    commandSigningRoots: roots,
    ...configuredApproverSet(options),
    ...quorumEpoch,
  } as never);
}

/** Connected daemons that enforce another approver set than the published one (review 10 M5). */
export interface QuorumLag {
  connected: number;
  behind: number;
  sample: { nodeId: string; epoch: number }[];
}

/**
 * Which connected daemons hold another approver set (epoch or digest) than `published`, from what they report
 * beside their trust version (node_sessions.approver_set_epoch / approver_set_sha256, both NULL while a daemon holds
 * no keys): with published keys, a NULL digest, another digest or another epoch lags; without, any held set does.
 * Undefined before those columns exist. A daemon can take a bundle's version while refusing its quorum part, so the
 * trust version alone says nothing about the set it enforces.
 */
export async function quorumLag(
  sql: Pick<SqlExecutor, 'query'>,
  published: PublishedTrust,
  liveWindowMs = 120_000,
): Promise<QuorumLag | undefined> {
  const { rows: ready } = await sql.query<{ ok: boolean }>(
    `SELECT count(*) = 2 AS ok FROM pg_attribute WHERE attrelid = to_regclass('node_sessions')
        AND attname IN ('approver_set_epoch', 'approver_set_sha256') AND NOT attisdropped`,
  );
  if (!ready[0]?.ok) return undefined;
  const keyed = Boolean(published.approverSet?.approverKeys.length);
  const digest = keyed ? Buffer.from(approverSetDigest(published.approverSet!)) : Buffer.alloc(0);
  const live = `gateway_id IS NOT NULL AND disconnected_at IS NULL
                AND last_seen > compute_now() - make_interval(secs => $3::float8)`;
  const differs = keyed
    ? `(approver_set_sha256 IS NULL OR approver_set_sha256 <> $2::bytea OR approver_set_epoch IS DISTINCT FROM $1::numeric)`
    : // (Still naming $1 and $2, which Postgres must be able to type.)
      `(approver_set_sha256 IS NOT NULL AND length(approver_set_sha256) > 0 AND $2::bytea IS NOT NULL AND $1::numeric IS NOT NULL)`;
  const { rows } = await sql.query<{ connected: string | number; behind: string | number }>(
    `SELECT count(*) AS connected, count(*) FILTER (WHERE ${differs}) AS behind FROM node_sessions WHERE ${live}`,
    [published.approverSetEpoch, digest, liveWindowMs / 1000],
  );
  const { rows: sample } = await sql.query<{ node_id: string; epoch: string | number | null }>(
    `SELECT node_id, approver_set_epoch AS epoch FROM node_sessions WHERE ${live} AND ${differs} ORDER BY node_id LIMIT 5`,
    [published.approverSetEpoch, digest, liveWindowMs / 1000],
  );
  return {
    connected: Number(rows[0]?.connected ?? 0),
    behind: Number(rows[0]?.behind ?? 0),
    sample: sample.map((row) => ({ nodeId: row.node_id, epoch: row.epoch === null ? 0 : Number(row.epoch) })),
  };
}

/**
 * doctor's quorum check (review 6 H1, review 7 M1): a configured approver quorum that differs from the published one
 * reaches the daemons that hold approver keys only when k of the CURRENT approvers signed it for a higher epoch.
 */
export async function quorumFindings(sql: Pick<SqlExecutor, 'query'>, options: AnyComputeOptions): Promise<Finding[]> {
  const published = await publishedTrust(sql);
  if (!published?.approverSet) return [];
  // Daemons still enforcing another set than the published one (they refused its change, or have not reconnected).
  const lag = await quorumLag(sql, published);
  const lagging: Finding[] = lag?.behind
    ? [
        {
          check: 'pki.quorum-lag',
          severity: 'warning',
          message: `${lag.behind} of ${lag.connected} connected node(s) enforce another approver set than the published one (epoch ${published.approverSetEpoch}): ${lag.sample
            .map((node) => `${node.nodeId} at epoch ${node.epoch}`)
            .join(', ')}${lag.behind > lag.sample.length ? ', …' : ''}`,
          fix: 'A refused change keeps their old approvers: check the set signatures (better-compute pki trust-version), or re-pin nodes that missed several changes',
        },
      ]
    : [];
  const configured = configuredApproverSet(options);
  if (sameApproverSet(published.approverSet, configured)) return lagging;
  const next = published.approverSetEpoch + 1;
  const pki = approversOf(options);
  const epoch = Number(pki?.approvers?.epoch ?? 1);
  // Verified as a daemon does (review 10 M5): the current set's threshold of valid signatures over this set, epoch
  // and the deployment's trust domain; merely having signatures says nothing.
  const trustDomain = (options as { pki?: { join?: { trustDomain?: string } } }).pki?.join?.trustDomain;
  const given = (pki?.approvers?.setSignatures ?? []) as readonly { kid?: unknown; sig?: unknown }[];
  let refusal: string | undefined;
  if (given.length) {
    try {
      verifyApproverSetChange(
        { ...published.approverSet, epoch: BigInt(published.approverSetEpoch) },
        {
          ...configured,
          epoch: BigInt(epoch),
          trustDomain,
          approverSetSignatures: given.map((signature) => ({
            kid: String(signature.kid),
            sig:
              typeof signature.sig === 'string'
                ? new Uint8Array(Buffer.from(signature.sig, 'base64url'))
                : new Uint8Array(signature.sig as Uint8Array),
          })),
        },
      );
    } catch (error) {
      refusal = String((error as { details?: { reason?: string } }).details?.reason ?? (error as Error).message);
    }
  }
  const signed = given.length > 0 && refusal === undefined;
  if (!published.approverSet.approverKeys.length)
    return [
      ...lagging,
      {
        check: 'pki.quorum-change',
        severity: 'info',
        message: `This configuration introduces an approver quorum (published trust version ${published.version} has none): daemons take the first set as it comes`,
        fix: 'Nothing to sign: roll the configuration out to every process',
      },
    ];
  if (signed)
    return [
      ...lagging,
      {
        check: 'pki.quorum-change',
        severity: 'info',
        message: `The configured approver quorum is signed for epoch ${epoch}: daemons take it on their next session`,
        fix: 'Roll the configuration out to every process',
      },
    ];
  return [
    ...lagging,
    {
      check: 'pki.quorum-unsigned',
      severity: 'warning',
      message: `The configured approver quorum differs from the one published (epoch ${published.approverSetEpoch}, trust version ${published.version}), and ${
        refusal ? `its signatures do not verify (${refusal})` : 'its current approvers have not signed it for a higher epoch'
      }: daemons that hold approver keys will keep the old quorum`,
      fix: `Each of ${published.approverSet.approverThreshold} current approver(s): better-compute batch sign-approvers --key <key> --epoch ${next} --approvers <new .pub files> --threshold <k>; then set pki.approvers.epoch to ${next} and pki.approvers.setSignatures to their signatures`,
    },
  ];
}

/** CAs expiring within this window are reported by `doctor`. */
export const caExpiryWarningMs = 30 * 86_400_000;

/**
 * `doctor`'s machine-PKI checks: nothing when there is no bundle at `path`; otherwise an error for
 * an unreadable bundle, an expired CA or a bundle that does not unseal with the deployment secret,
 * and a warning for a CA expiring within 30 days.
 */
export async function pkiFindings(
  path: string,
  env: NodeJS.ProcessEnv,
  now: number = Date.now(),
  /** The deployment's store: a rotation in progress also says how many daemons have the new version. */
  sql?: Pick<SqlExecutor, 'query'>,
): Promise<Finding[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const findings: Finding[] = [];
  let pins: ReturnType<typeof readPkiPins>;
  try {
    pins = readPkiPins(text);
  } catch (error) {
    return [
      {
        check: 'pki.unreadable',
        severity: 'error',
        message: `The PKI bundle at ${path} cannot be read: ${(error as Error).message}`,
        fix: 'Restore it from backup, or create a new PKI with better-compute pki init (every node rejoins)',
      },
    ];
  }
  for (const [name, notAfter] of Object.entries(pins.expires)) {
    if (notAfter <= now)
      findings.push({
        check: 'pki.ca-expired',
        severity: 'error',
        message: `The ${name} certificate expired at ${iso(notAfter)}`,
        fix: `Nothing it signs is trusted until you ${renewalFor(name)}`,
      });
    else if (notAfter - now <= caExpiryWarningMs)
      findings.push({
        check: 'pki.ca-expiring',
        severity: 'warning',
        message: `The ${name} certificate expires at ${iso(notAfter)}`,
        fix: `Before it expires, ${renewalFor(name)}, and roll the bundle out`,
      });
  }
  // A command-signing root rotation left half done (§13): a reminder, not a problem.
  if (pins.commandSigningNextRootSha256) {
    const lag = sql && pins.trustVersion !== undefined ? await trustLag(sql, pins.trustVersion) : undefined;
    findings.push({
      check: 'pki.rotation',
      severity: 'info',
      message: `A new command-signing root is published (trust version ${pins.trustVersion}) but not signing yet${
        lag ? (lag.behind ? `; ${lagText(lag)}` : `; all ${lag.connected} connected node(s) have it`) : ''
      }`,
      fix: 'Once every daemon has this trust version: better-compute pki rotate-command-root --stage switch',
    });
  }
  if (pins.commandSigningPreviousRootSha256)
    findings.push({
      check: 'pki.rotation',
      severity: 'info',
      message: 'The former command-signing root is still trusted',
      fix: 'At least 24 hours after the switch: better-compute pki rotate-command-root --stage drop',
    });
  try {
    importPkiBundle(text, pkiUnlockOptions(env));
  } catch (error) {
    findings.push({
      check: 'pki.unseal',
      severity: 'error',
      message: `The PKI bundle does not load with this deployment's secret: ${(error as Error).message}`,
      fix: 'Set BETTER_COMPUTE_SECRET to the secret the bundle was sealed with',
    });
  }
  return findings;
}

export const pkiCommands = [
  defineCommand({
    name: 'pki init',
    group: 'PKI',
    summary:
      'Create the machine PKI: root, node, serving and internal CAs and the JoinService keys',
    description:
      "pki init creates a deployment's machine PKI (PLAN.md §13) and writes it to one JSON file with mode 0600: an offline root CA, the per-region node CA (agent client certificates), the gateway serving CA, the internal control-plane CA, and the JoinService signing and encryption keys. No key does two jobs. The private keys are sealed with AES-256-GCM under a key derived from BETTER_COMPUTE_SECRET; without the secret, pass --plaintext to store them as PEM instead. --offline-root writes the root key to its own file and leaves it out of the bundle: keep that file off the servers. It prints the pins install scripts need (the same as pki show) and never overwrites an existing file.",
    output: 'json',
    flags: {
      'trust-domain': {
        type: 'string',
        value: 'DOMAIN',
        required: true,
        env: 'BETTER_COMPUTE_TRUST_DOMAIN',
        description: 'SPIFFE trust domain of agent identities, e.g. compute.example.com',
      },
      pki: pkiFlag,
      'offline-root': {
        type: 'string',
        value: 'PATH',
        description:
          'Write the root key here (sealed like the bundle) and leave it out of the bundle',
      },
      organization: {
        type: 'string',
        value: 'NAME',
        default: 'better-compute',
        description: 'Subject organization of the CA certificates',
      },
      plaintext: {
        type: 'boolean',
        description: 'Store private keys as PEM (mode 0600) when BETTER_COMPUTE_SECRET is not set',
      },
    },
    examples: [
      'BETTER_COMPUTE_SECRET=... better-compute pki init --trust-domain compute.example.com',
      'better-compute pki init --trust-domain compute.test --plaintext --pki ./dev/pki.json',
      'better-compute pki init --trust-domain compute.example.com --offline-root /media/usb/root-ca.key',
    ],
    async run({ flags, env, path, note }) {
      const secret = env.BETTER_COMPUTE_SECRET;
      if (secret !== undefined && secret.length < minSecret)
        throw new CliError(
          'INVALID_CONFIG',
          `BETTER_COMPUTE_SECRET must be at least ${minSecret} characters`,
        );
      if (!secret && !flags.plaintext)
        throw new CliError(
          'MISSING_ENV',
          'Set BETTER_COMPUTE_SECRET to seal the private keys, or pass --plaintext',
          'The secret must be the same for every process of the deployment.',
        );
      const target = path(flags.pki ?? defaultPkiPath);
      const bundle = createPkiBundle({
        trustDomain: flags['trust-domain']!,
        organization: flags.organization ?? 'better-compute',
      });
      const sealing = secret ? { secret } : {};
      if (flags['offline-root']) {
        const rootPath = path(flags['offline-root']);
        if (rootPath === target)
          throw usageError('--offline-root must differ from the bundle path');
        await writeNew(rootPath, exportRootKey(bundle, sealing));
        note(
          `Wrote the root key to ${rootPath}. Keep it offline; it is needed only to replace a CA.`,
        );
      }
      await writeNew(
        target,
        exportPkiBundle(bundle, { ...sealing, omitRootKey: Boolean(flags['offline-root']) }),
      );
      note(
        `Wrote the PKI bundle to ${target}${secret ? ' (sealed)' : ' (plaintext PEM, mode 0600)'}.`,
      );
      return readPkiPins(await readFile(target, 'utf8'), pkiUnlockOptions(env));
    },
  }),
  defineCommand({
    name: 'pki show',
    group: 'PKI',
    summary: 'Print the pins install scripts and bcd need, and the CA expiry dates',
    description:
      "pki show prints the trust domain, the gateway serving CA's SPKI pin, the JoinService signing and encryption key pins in bcd's sha256/<base64> form, the encryption key as a JWK, and when each CA expires. With BETTER_COMPUTE_SECRET the public half is checked against the seal first (authenticated: true); without it the pins come from a file nothing vouches for, and a warning says so.",
    flags: { pki: pkiFlag },
    examples: ['better-compute pki show', 'better-compute pki show --query servingCaSpkiPin'],
    async run({ flags, path, env, note }) {
      const pins = await readTrustedPins(path(flags.pki ?? defaultPkiPath), env, note);
      return {
        ...pins,
        expires: Object.fromEntries(
          Object.entries(pins.expires).map(([name, ms]) => [name, iso(ms)]),
        ),
      };
    },
  }),
  defineCommand({
    name: 'pki add-sandbox-ca',
    group: 'PKI',
    summary: 'Add the sandbox SSH CA to a bundle made before sandboxes',
    description:
      "pki add-sandbox-ca creates the sandbox SSH CA (PLAN.md §3.7) in a bundle that lacks it and writes the bundle back (sealed with BETTER_COMPUTE_SECRET when set). sandboxes.exec signs with it (the tunnels module's sandboxSsh, pki tunnelsOptions()) and sandbox guests trust its public key (vps({ sandboxExec: { caPublicKey } })); it is separate from the break-glass CA, so a sandbox certificate never opens a node. Bundles from pki init already have one.",
    output: 'json',
    flags: { pki: pkiFlag },
    examples: ['better-compute pki add-sandbox-ca'],
    async run({ flags, env, path, note }) {
      const target = path(flags.pki ?? defaultPkiPath);
      const bundle = await loadPkiBundleForRewrite(target, env);
      if (bundle.sandboxSshCa)
        throw new CliError('INVALID_STATE', `${target} already has a sandbox SSH CA`, 'pki show prints its public key.');
      const { createSshCertificateAuthority } = await import('@better-compute/pki');
      bundle.sandboxSshCa = createSshCertificateAuthority({ comment: `${bundle.trustDomain} sandbox ssh ca`.slice(0, 64) });
      const secret = env.BETTER_COMPUTE_SECRET;
      await replace(target, exportPkiBundle(bundle, { ...(secret ? { secret } : {}), omitRootKey: !bundle.root }));
      note('Roll the bundle out to every api replica, and give vps() the public key as sandboxExec.caPublicKey.');
      return { sandboxSshCaPublicKey: bundle.sandboxSshCa.publicKey };
    },
  }),
  defineCommand({
    name: 'pki reseal',
    group: 'PKI',
    summary: 'Seal the bundle in the current format, authenticating its public parts',
    description:
      "pki reseal rewrites the bundle sealed with BETTER_COMPUTE_SECRET in the current format, where the seal also covers every certificate and pin, so a file changed without the secret no longer loads. Bundles sealed before that format, or left unsealed while a secret is set, are refused everywhere else. First compare the pins it prints (the same as pki show) with the ones your install scripts and join tokens use, and check `certificates` (the SHA-256 of every certificate in every chain) holds nothing you did not put there: it seals whatever the file holds now. Needs BETTER_COMPUTE_SECRET; the current key and certificates are kept, nothing is rotated.",
    output: 'json',
    flags: {
      pki: pkiFlag,
      'accept-unauthenticated': {
        type: 'boolean',
        description: 'Seal a bundle nothing authenticates, after comparing the pins printed without it',
      },
    },
    examples: [
      'better-compute pki reseal',
      'better-compute pki reseal --accept-unauthenticated',
    ],
    async run({ flags, env, path, note, print }) {
      const target = path(flags.pki ?? defaultPkiPath);
      const secret = env.BETTER_COMPUTE_SECRET;
      if (!secret || secret.length < minSecret)
        throw new CliError(
          'MISSING_ENV',
          `Set BETTER_COMPUTE_SECRET (at least ${minSecret} characters): the bundle is sealed under it`,
        );
      const text = await readBundleText(target);
      // Resealing vouches for whatever the file holds: an unauthenticated bundle (the former seal, or unsealed) is
      // sealed only when asked explicitly, after its pins and key fingerprints have been shown and compared.
      let authenticated = true;
      try {
        importPkiBundle(text, { secret });
      } catch {
        authenticated = false;
      }
      if (!authenticated && !flags['accept-unauthenticated']) {
        const unverified = readPkiPins(text);
        print({
          ...unverified,
          authenticated: false,
          expires: Object.fromEntries(Object.entries(unverified.expires).map(([name, ms]) => [name, iso(ms)])),
        });
        throw new CliError(
          'INVALID_STATE',
          `${target} is not authenticated (sealed in the former format, or not sealed): nothing vouches for the pins above`,
          'Compare them with your records (install scripts, join tokens, pinned CAs), then run pki reseal --accept-unauthenticated.',
        );
      }
      const bundle = importPkiBundle(text, { secret, allowUnauthenticated: true });
      await replace(target, exportPkiBundle(bundle, { secret, omitRootKey: !bundle.root }));
      const pins = readPkiPins(await readFile(target, 'utf8'), { secret });
      note(`Sealed ${target} in the current format. These are the pins it now vouches for.`);
      return { ...pins, expires: Object.fromEntries(Object.entries(pins.expires).map(([name, ms]) => [name, iso(ms)])) };
    },
  }),
  defineCommand({
    name: 'pki rotate-command-root',
    group: 'PKI',
    summary: 'Rotate the command-signing root in three steps: add, switch, drop',
    description:
      "pki rotate-command-root performs one step of a command-signing root rotation (PLAN.md §13) on the bundle and writes it back (sealed with BETTER_COMPUTE_SECRET when set). --stage add creates a new root and publishes it beside the current one (the trust bundle's version goes up); workers keep signing under the current root. Roll the bundle out to every process: daemons receive the new version in Welcome.trust. --stage switch, once every daemon holds that version, makes workers sign under the new root while the old one stays trusted. --stage drop, at least 24 hours later (worker keys live at most 24 h), removes the old root (version up again). Each step prints the roots and version daemons will trust.",
    output: 'json',
    flags: {
      stage: {
        type: 'string',
        value: 'STAGE',
        required: true,
        choices: ['add', 'switch', 'drop'],
        description: 'add a new root, switch signing to it, or drop the old one',
      },
      pki: pkiFlag,
      force: {
        type: 'boolean',
        description: 'switch without checking that every connected daemon has the new trust version',
      },
    },
    examples: [
      'better-compute pki rotate-command-root --stage add',
      'better-compute pki rotate-command-root --stage switch',
      'better-compute pki rotate-command-root --stage drop',
    ],
    async run({ flags, env, path, note, configPath, deployment }) {
      const target = path(flags.pki ?? defaultPkiPath);
      const bundle = await loadPkiBundleForRewrite(target, env);
      const stage = flags.stage as CommandRootRotationStage;
      // Switch only after 100% acknowledgment (§13): a daemon still on the old version would reject every
      // command signed under the new root. Disconnected daemons get the bundle in Welcome before any command.
      if (stage === 'switch' && bundle.commandSigningNext && !flags.force) {
        let version = pkiPins(bundle).trustVersion ?? 1;
        if (!(await configPath()) && !env.BETTER_COMPUTE_DATABASE_URL)
          throw new CliError(
            'INVALID_STATE',
            `Cannot check which daemons hold trust version ${version}: no configuration or database`,
            "Run it where the deployment's configuration is (or set BETTER_COMPUTE_DATABASE_URL), or pass --force once you have checked.",
          );
        const { compute, options } = await deployment();
        // The version daemons get follows the bundle's content (M5): gate on the version the deployment published for
        // THIS bundle (with the new root), and refuse while it still publishes the one without it.
        const published = await publishedTrust(compute.context.sql);
        const expected = configuredTrustDigest(bundle, options);
        if (published && expected) {
          if (Buffer.compare(published.digest, expected) !== 0)
            throw new CliError(
              'INVALID_STATE',
              `Not switching: the deployment still publishes trust version ${published.version} without the new root`,
              'Roll the bundle from --stage add out to every process (restart them), then switch.',
            );
          version = published.version;
        }
        const lag = await trustLag(compute.context.sql, version);
        if (lag.behind > 0)
          throw new CliError(
            'INVALID_STATE',
            `Not switching: trust version ${version} is published, but ${lagText(lag)}; they would reject commands signed under the new root`,
            'Wait until they report it (better-compute doctor shows the count), or pass --force.',
          );
        note(`All ${lag.connected} connected node(s) hold trust version ${version}.`);
      }
      let rotated: PkiBundle;
      try {
        rotated = rotateCommandSigningRoot(bundle, stage);
      } catch (error) {
        throw new CliError('INVALID_STATE', (error as Error).message);
      }
      const secret = env.BETTER_COMPUTE_SECRET;
      await replace(target, exportPkiBundle(rotated, secret ? { secret } : {}));
      note(
        stage === 'add'
          ? 'Roll this bundle out to every process; switch once every daemon has the new trust version.'
          : stage === 'switch'
            ? 'Workers now sign under the new root. Drop the old root after 24 hours.'
            : 'The old root is no longer trusted.',
      );
      const pins = pkiPins(rotated);
      return {
        stage,
        trustVersion: pins.trustVersion,
        signingRoot: pins.commandSigningRootSha256,
        ...(pins.commandSigningNextRootSha256 ? { nextRoot: pins.commandSigningNextRootSha256 } : {}),
        ...(pins.commandSigningPreviousRootSha256
          ? { previousRoot: pins.commandSigningPreviousRootSha256 }
          : {}),
      };
    },
  }),
  defineCommand({
    name: 'pki trust-version',
    group: 'PKI',
    summary: 'Show the trust bundle version the deployment publishes, and the one to sign a quorum change for',
    description:
      "pki trust-version reads the trust bundle the deployment last published (its version follows its content: a changed bundle publishes the next version, pki.trustVersion is a floor) and compares it with this configuration and PKI bundle: whether they publish the same bundle, the published approver-set epoch, whether the configured approver quorum differs (then its current approvers sign it for signQuorumForEpoch: better-compute batch sign-approvers --epoch <n>, with pki.approvers.epoch set to it), and how many connected daemons hold that version.",
    target: 'config',
    output: 'json',
    flags: { pki: pkiFlag },
    examples: ['better-compute pki trust-version'],
    async run({ flags, env, path, deployment }) {
      const { compute, options } = await deployment();
      const sql = compute.context.sql;
      const published = await publishedTrust(sql);
      if (!published)
        throw new CliError(
          'NOT_FOUND',
          'The deployment has published no trust bundle yet',
          'Migrate, and start a process whose configuration has pki.commandSigning.',
        );
      const bundle = await loadPkiBundle(path(flags.pki ?? defaultPkiPath), env);
      const expected = configuredTrustDigest(bundle, options);
      const matches = expected ? Buffer.compare(published.digest, expected) === 0 : undefined;
      const quorumChanged = published.approverSet
        ? !sameApproverSet(published.approverSet, configuredApproverSet(options))
        : false;
      const lag = await trustLag(sql, published.version);
      const setLag = await quorumLag(sql, published);
      return {
        version: published.version,
        ...(matches === undefined ? {} : { configurationMatches: matches }),
        // What this configuration would publish: the same version, or the next one.
        nextVersion: matches === false ? published.version + 1 : published.version,
        approverSetEpoch: published.approverSetEpoch,
        // What install scripts pin (daemon install-script --approver-set-sha256): computed from THIS configuration's
        // approver keys, never from the database the api writes (review 10 M4); the published one when it differs.
        ...(configuredApproverSet(options).approverKeys.length
          ? { approverSetSha256: Buffer.from(approverSetDigest(configuredApproverSet(options))).toString('hex') }
          : {}),
        ...(published.approverSet?.approverKeys.length && !sameApproverSet(published.approverSet, configuredApproverSet(options))
          ? { publishedApproverSetSha256: Buffer.from(approverSetDigest(published.approverSet)).toString('hex') }
          : {}),
        quorumChanged,
        ...(quorumChanged ? { signQuorumForEpoch: published.approverSetEpoch + 1 } : {}),
        connected: lag.connected,
        behind: lag.behind,
        // Nodes enforcing another approver set (once daemons report it).
        ...(setLag ? { approverSetBehind: setLag.behind, approverSetSample: setLag.sample } : {}),
      };
    },
  }),
  defineCommand({
    name: 'pki renew-ca',
    group: 'PKI',
    summary: "Renew a CA's certificate under the root, keeping its key",
    description:
      "pki renew-ca issues a new certificate for the node, serving or internal CA from the root CA, for the same key and subject, and writes the bundle back (sealed with BETTER_COMPUTE_SECRET when set). Certificates the CA issued stay valid and the serving CA's SPKI pin does not change, so nothing is re-pinned and no node rejoins; roll the bundle out to every process before the old certificate expires (doctor warns 30 days ahead). The root key comes from the bundle or, for an offline root, from --root-key; it is never written into the bundle then.",
    output: 'json',
    flags: {
      ca: {
        type: 'string',
        value: 'CA',
        required: true,
        choices: ['node', 'serving', 'internal'],
        description: 'Which CA to renew',
      },
      'root-key': {
        type: 'string',
        value: 'PATH',
        description: 'The offline root key (pki init --offline-root), when the bundle has none',
      },
      days: {
        type: 'integer',
        value: 'N',
        default: 365,
        min: 1,
        max: 3650,
        description: 'Lifetime of the new certificate in days (capped by the root)',
      },
      pki: pkiFlag,
    },
    examples: [
      'better-compute pki renew-ca --ca node',
      'better-compute pki renew-ca --ca serving --root-key /media/usb/root-ca.key',
    ],
    async run({ flags, env, path, note }) {
      const target = path(flags.pki ?? defaultPkiPath);
      const secret = env.BETTER_COMPUTE_SECRET;
      const rootKeyPath = flags['root-key'] ? path(flags['root-key']) : undefined;
      if (env.BETTER_COMPUTE_PKI_ALLOW_UNAUTHENTICATED === '1') await loadPkiBundleForRewrite(target, env);
      const bundle = importPkiBundle(await readBundleText(target), {
        ...pkiUnlockOptions(env),
        ...(rootKeyPath ? { rootKey: await readFile(rootKeyPath, 'utf8') } : {}),
      });
      const which = flags.ca as BundleCa;
      let renewed: PkiBundle;
      try {
        renewed = renewBundleCa(bundle, which, { validitySeconds: (flags.days ?? 365) * 86_400 });
      } catch (error) {
        throw new CliError('INVALID_STATE', (error as Error).message);
      }
      // An offline root stays offline: the key read from --root-key is not written into the bundle.
      await replace(
        target,
        exportPkiBundle(renewed, { ...(secret ? { secret } : {}), omitRootKey: Boolean(rootKeyPath) }),
      );
      const ca = which === 'node' ? renewed.nodeCa : which === 'serving' ? renewed.servingCa : renewed.internalCa;
      note(`Renewed the ${which} CA certificate; roll the bundle out to every process.`);
      return {
        ca: which,
        notAfter: iso(ca.notAfter),
        serial: parseCertificate(ca.certificate).serial,
        ...(which === 'serving' ? { servingCaSpkiPin: pkiPins(renewed).servingCaSpkiPin } : {}),
      };
    },
  }),
  defineCommand({
    name: 'pki issue-gateway',
    group: 'PKI',
    summary: 'Issue a gateway serving certificate and key from the serving CA',
    description:
      "pki issue-gateway generates a P-256 key and issues a serving certificate for it from the bundle's gateway serving CA (PLAN.md §7.1): DNS SANs from --san (comma-separated), serverAuth, 30 days by default. It writes <name>.key (mode 0600) and <name>.crt (the certificate followed by the serving CA's chain) into --out, replacing earlier files atomically so a running gateway can hot-reload them. Daemons trust the certificate through the serving CA pin (pki show).",
    flags: {
      san: {
        type: 'string',
        value: 'NAMES',
        required: true,
        description: 'DNS names, comma-separated, e.g. gw.eu-central.example.com',
      },
      out: {
        type: 'string',
        value: 'DIR',
        default: '.better-compute/gateway',
        description: 'Directory for the key and certificate',
      },
      name: {
        type: 'string',
        value: 'NAME',
        default: 'gateway',
        description: 'File name stem: NAME.key and NAME.crt',
      },
      days: {
        type: 'integer',
        value: 'N',
        default: 30,
        min: 1,
        max: 30,
        description: 'Certificate lifetime in days',
      },
      pki: pkiFlag,
    },
    examples: [
      'better-compute pki issue-gateway --san gw.eu-central.example.com',
      'better-compute pki issue-gateway --san gw1.example.com,gw.example.com --out /etc/better-compute/tls --days 14',
    ],
    validate(flags) {
      if (!/^[a-zA-Z0-9._-]+$/.test(flags.name ?? 'gateway'))
        throw usageError('--name must be a plain file name');
    },
    async run({ flags, env, path, note }) {
      const bundle = await loadPkiBundle(path(flags.pki ?? defaultPkiPath), env);
      const dnsSans = flags
        .san!.split(',')
        .map((name) => name.trim().toLowerCase())
        .filter(Boolean);
      if (dnsSans.length === 0) throw usageError('--san needs at least one DNS name');
      const { privateKey, publicKey } = generateP256KeyPair();
      const issued = await bundle.servingCa.issue(publicKey, {
        usage: 'server',
        dnsSans,
        role: 'gateway',
        ttlSeconds: (flags.days ?? 30) * 86_400,
      });
      const dir = path(flags.out ?? '.better-compute/gateway');
      const stem = flags.name ?? 'gateway';
      const keyPath = join(dir, `${stem}.key`);
      const certPath = join(dir, `${stem}.crt`);
      // The chain stops below the root: clients anchor at the pinned serving CA.
      const chain = [issued.certificate, ...issued.chain.slice(0, -1)];
      await replace(keyPath, privateKeyPem(privateKey));
      await replace(certPath, chain.map((der) => toPem(der)).join(''), 0o644);
      note(`Wrote ${keyPath} and ${certPath}.`);
      return {
        serial: issued.serial,
        dnsSans,
        notBefore: iso(issued.notBefore),
        notAfter: iso(issued.notAfter),
        key: keyPath,
        certificate: certPath,
        servingCaSpkiPin: pkiPins(bundle).servingCaSpkiPin,
      };
    },
  }),
];
