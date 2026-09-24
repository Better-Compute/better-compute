import { createHash } from 'node:crypto';
import { ComputeError, systemClock, type Clock } from '@better-compute/core';
import { canonicalJson } from './audit.js';
import { base64url, fromBase64url, matchesPin, spkiDer, toPublicKey } from './keys.js';
import { createSigningKey, verifyPurpose, type SigningKey } from './signing.js';

// Offline release signing (PLAN.md §13 "Supply chain"): a TUF-lite manifest of one release's
// artifacts, signed under SigningPurpose 'release-manifest' by offline keys that installers and
// daemons know only by pin. The body lists its signing keys (`keys`, with each key's SPKI), so
// signatures are just `{ kid, sig }` and the format can grow into TUF roles (`spec` bumps) later.
// Verification order (the Go daemon's v0.4 self-update matches it): signatures from a threshold
// of distinct pinned keys → `sequence` ≥ the stored one (no rollback) → not expired → each
// artifact's size and SHA-256.

export const releaseManifestType = 'bettercompute.release';

export interface ReleaseArtifact {
  /** A file name, no directories (`bcd_1.2.0_linux_amd64.tar.gz`). */
  name: string;
  /** `os-arch` (`linux-amd64`, `linux-arm64`); absent for platform-independent files. */
  platform?: string;
  /** Lowercase hex SHA-256. */
  sha256: string;
  size: number;
}

export interface ReleaseKey {
  /** base64url of the key's subject key id (SHA-1 of the SPKI key bits, RFC 5280 method 1). */
  kid: string;
  alg: 'ES256';
  /** base64 DER SubjectPublicKeyInfo; trusted only if its `sha256/…` pin is configured. */
  spki: string;
}

export interface ReleaseManifest {
  type: typeof releaseManifestType;
  spec: 1;
  /** What is released (`bcd`). */
  product: string;
  version: string;
  /** Strictly increasing across releases of `product`: the rollback counter. */
  sequence: number;
  issuedAt: number;
  expiresAt: number;
  /** The keys that sign this manifest. */
  keys: ReleaseKey[];
  artifacts: ReleaseArtifact[];
}

/** The published form (`manifest.json`): the canonical body (base64) and its signatures. */
export interface SignedReleaseManifest {
  manifest: string;
  signatures: { kid: string; sig: string }[];
}

const namePattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$/;
const platformPattern = /^[a-z0-9]+-[a-z0-9_]+$/;
const productPattern = /^[a-z][a-z0-9-]{0,63}$/;
const versionPattern = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]{1,64})?$/;
const hexPattern = /^[0-9a-f]{64}$/;

const invalid = (message: string) => new ComputeError('INVALID_INPUT', message);

/** The artifact entry for a file's bytes. */
export function releaseArtifact(
  name: string,
  bytes: Uint8Array,
  platform?: string,
): ReleaseArtifact {
  if (!namePattern.test(name)) throw invalid(`${name} is not a plain file name`);
  if (platform !== undefined && !platformPattern.test(platform))
    throw invalid(`${platform} is not an os-arch platform`);
  return {
    name,
    ...(platform !== undefined ? { platform } : {}),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
  };
}

/** The platform goreleaser encodes in an archive name (`…_linux_amd64.tar.gz` → `linux-amd64`). */
export function platformFromName(name: string): string | undefined {
  const match = /_(linux|darwin|windows|freebsd)_(amd64|arm64|armv7|386|riscv64)(?:\.|$)/.exec(
    name,
  );
  return match ? `${match[1]}-${match[2]}` : undefined;
}

function checkManifest(manifest: ReleaseManifest): void {
  if (manifest.type !== releaseManifestType || manifest.spec !== 1)
    throw invalid('Not a spec 1 release manifest');
  if (!productPattern.test(manifest.product)) throw invalid('product is invalid');
  if (!versionPattern.test(manifest.version)) throw invalid('version must be semver');
  if (!Number.isSafeInteger(manifest.sequence) || manifest.sequence < 1)
    throw invalid('sequence must be a positive integer');
  if (!Number.isSafeInteger(manifest.issuedAt) || !Number.isSafeInteger(manifest.expiresAt))
    throw invalid('issuedAt and expiresAt are epoch milliseconds');
  if (manifest.expiresAt <= manifest.issuedAt) throw invalid('expiresAt must follow issuedAt');
  if (!Array.isArray(manifest.keys) || manifest.keys.length === 0 || manifest.keys.length > 16)
    throw invalid('A release lists 1 to 16 signing keys');
  const kids = new Set<string>();
  for (const key of manifest.keys) {
    if (key.alg !== 'ES256' || typeof key.kid !== 'string' || typeof key.spki !== 'string')
      throw invalid('keys must be { kid, alg: ES256, spki }');
    if (kids.has(key.kid)) throw invalid(`key ${key.kid} is listed twice`);
    kids.add(key.kid);
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0)
    throw invalid('A release lists at least one artifact');
  const seen = new Set<string>();
  for (const artifact of manifest.artifacts) {
    if (!namePattern.test(artifact.name))
      throw invalid(`${artifact.name} is not a plain file name`);
    if (seen.has(artifact.name)) throw invalid(`${artifact.name} is listed twice`);
    seen.add(artifact.name);
    if (artifact.platform !== undefined && !platformPattern.test(artifact.platform))
      throw invalid(`${artifact.name}: platform must be os-arch`);
    if (!hexPattern.test(artifact.sha256)) throw invalid(`${artifact.name}: sha256 must be hex`);
    if (!Number.isSafeInteger(artifact.size) || artifact.size < 0)
      throw invalid(`${artifact.name}: size is invalid`);
  }
}

const releaseKeyOf = (key: Pick<SigningKey, 'kid' | 'publicKey'>): ReleaseKey => ({
  kid: key.kid,
  alg: 'ES256',
  spki: Buffer.from(spkiDer(key.publicKey)).toString('base64'),
});

export interface ReleaseManifestInput {
  product: string;
  version: string;
  sequence: number;
  artifacts: readonly ReleaseArtifact[];
  /** Every key that will sign, including ones that cosign later (their public halves suffice). */
  signers: readonly Pick<SigningKey, 'kid' | 'publicKey'>[];
  /** How long installers accept this manifest (default 365 days). */
  validitySeconds?: number;
  clock?: Clock;
}

/** Builds the manifest body (artifacts sorted by name) without signing it. */
export function buildReleaseManifest(input: ReleaseManifestInput): ReleaseManifest {
  const issuedAt = (input.clock ?? systemClock).now();
  const manifest: ReleaseManifest = {
    type: releaseManifestType,
    spec: 1,
    product: input.product,
    version: input.version,
    sequence: input.sequence,
    issuedAt,
    expiresAt: issuedAt + (input.validitySeconds ?? 365 * 86400) * 1000,
    keys: input.signers.map(releaseKeyOf),
    artifacts: [...input.artifacts]
      .map(({ name, platform, sha256, size }) => ({
        name,
        ...(platform !== undefined ? { platform } : {}),
        sha256,
        size,
      }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  };
  checkManifest(manifest);
  return manifest;
}

/**
 * Signs a manifest with each key (offline: run where the keys live, never on a server). Each key
 * must be listed in `manifest.keys`. Pass an existing signed manifest to add signatures to it
 * (keys held by different people).
 */
export function signReleaseManifest(
  manifest: ReleaseManifest | SignedReleaseManifest,
  keys: readonly SigningKey[],
): SignedReleaseManifest {
  const existing = 'signatures' in manifest ? manifest : undefined;
  const body = existing
    ? (JSON.parse(Buffer.from(existing.manifest, 'base64').toString('utf8')) as ReleaseManifest)
    : (manifest as ReleaseManifest);
  checkManifest(body);
  if (!keys.length) throw invalid('At least one release key is needed');
  const bytes = existing
    ? new Uint8Array(Buffer.from(existing.manifest, 'base64'))
    : new TextEncoder().encode(canonicalJson(body));
  const signatures = new Map((existing?.signatures ?? []).map((entry) => [entry.kid, entry]));
  for (const key of keys) {
    const listed = body.keys.find((entry) => entry.kid === key.kid);
    if (!listed || listed.spki !== releaseKeyOf(key).spki)
      throw invalid(`Key ${key.kid} is not one of the manifest's keys`);
    signatures.set(key.kid, {
      kid: key.kid,
      sig: base64url(key.sign('release-manifest', [bytes]).sig),
    });
  }
  return {
    manifest: Buffer.from(bytes).toString('base64'),
    signatures: [...signatures.values()].sort((a, b) => (a.kid < b.kid ? -1 : 1)),
  };
}

export interface ReleaseTrust {
  /** `sha256/<base64>` SPKI pins of the release keys. */
  pins: readonly string[];
  /** How many distinct pinned keys must have signed (default 1). */
  threshold?: number;
}

export interface VerifyReleaseOptions {
  clock?: Clock;
  /** The highest `sequence` accepted before for this product: anything lower is a rollback. */
  minSequence?: number;
  /** Refuse manifests of any other product. */
  product?: string;
}

/**
 * Verifies a signed manifest and returns its body. Throws `ACCESS_DENIED` with `details.reason`:
 * `malformed`, `threshold` (too few distinct pinned keys signed), `not-canonical`, `product`,
 * `rollback` or `expired`, checked in that order. Nothing but the pins is trusted.
 */
export function verifyReleaseManifest(
  signed: SignedReleaseManifest,
  trust: ReleaseTrust,
  options: VerifyReleaseOptions = {},
): ReleaseManifest {
  const deny = (reason: string, message: string) =>
    new ComputeError('ACCESS_DENIED', `Release manifest rejected: ${message}`, undefined, {
      reason,
    });
  const threshold = trust.threshold ?? 1;
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > trust.pins.length)
    throw invalid('threshold must be between 1 and the number of pins');
  let bytes: Uint8Array;
  let manifest: ReleaseManifest;
  let text: string;
  try {
    if (typeof signed?.manifest !== 'string' || !Array.isArray(signed.signatures))
      throw new Error('shape');
    bytes = new Uint8Array(Buffer.from(signed.manifest, 'base64'));
    text = Buffer.from(bytes).toString('utf8');
    manifest = JSON.parse(text) as ReleaseManifest;
    checkManifest(manifest);
  } catch {
    throw deny('malformed', 'not a signed spec 1 manifest');
  }
  const trusted = new Set<string>();
  for (const entry of signed.signatures.slice(0, 16)) {
    const key = manifest.keys.find((listed) => listed.kid === entry?.kid);
    if (!key) continue;
    let publicKey;
    let sig: Uint8Array;
    try {
      publicKey = toPublicKey(new Uint8Array(Buffer.from(key.spki, 'base64')));
      sig = fromBase64url(String(entry.sig));
    } catch {
      continue;
    }
    const pin = trust.pins.find((candidate) => matchesPin(publicKey, candidate));
    if (!pin || trusted.has(pin)) continue;
    if (verifyPurpose(publicKey, 'release-manifest', [bytes], sig)) trusted.add(pin);
  }
  if (trusted.size < threshold)
    throw deny('threshold', `${trusted.size} of ${threshold} required release keys signed it`);
  if (canonicalJson(manifest) !== text) throw deny('not-canonical', 'body is not canonical');
  if (options.product !== undefined && manifest.product !== options.product)
    throw deny('product', `it releases ${manifest.product}, not ${options.product}`);
  if (options.minSequence !== undefined && manifest.sequence < options.minSequence)
    throw deny(
      'rollback',
      `sequence ${manifest.sequence} is older than ${options.minSequence} (rollback)`,
    );
  if ((options.clock ?? systemClock).now() >= manifest.expiresAt)
    throw deny('expired', 'it has expired');
  return manifest;
}

/** Checks a downloaded artifact against a verified manifest. Throws `ACCESS_DENIED`. */
export function verifyReleaseArtifact(
  manifest: ReleaseManifest,
  name: string,
  bytes: Uint8Array,
): ReleaseArtifact {
  const artifact = manifest.artifacts.find((entry) => entry.name === name);
  const deny = (reason: string, message: string) =>
    new ComputeError('ACCESS_DENIED', `${name}: ${message}`, undefined, { reason });
  if (!artifact) throw deny('unlisted', 'not in the release manifest');
  if (bytes.length !== artifact.size) throw deny('size', 'size does not match the manifest');
  if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256)
    throw deny('digest', 'SHA-256 does not match the manifest');
  return artifact;
}

/** A release signing key. Keep it offline; distribute only `spkiPin(key.publicKey)`. */
export function createReleaseSigningKey(options: { clock?: Clock } = {}): SigningKey {
  return createSigningKey({
    commonName: 'better-compute release signing',
    ...(options.clock ? { clock: options.clock } : {}),
  });
}
