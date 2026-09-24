import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  base64url,
  buildReleaseManifest,
  createReleaseSigningKey,
  createSigningKey,
  fromPem,
  parseCertificate,
  platformFromName,
  releaseArtifact,
  signReleaseManifest,
  spkiPin,
  subjectKeyId,
  verifyReleaseArtifact,
  verifyReleaseManifest,
  type SignedReleaseManifest,
  type SigningKey,
} from '@better-compute/pki';
import { CliError, usageError } from '../errors.js';
import { defineCommand } from '../framework.js';
import { replace, writeNew } from './pki.js';

// Offline release signing (PLAN.md §13 "Supply chain"): keys that never leave the release
// manager's machine, a signed manifest of a release's artifacts, and verification by pin with a
// threshold, rollback floor and expiry. The install script and bcd's self-update check the same
// manifest.

const pinPattern = /^sha256\/[A-Za-z0-9+/]{43}=$/;

async function readText(path: string, what: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new CliError('FILE_NOT_FOUND', `No ${what} at ${path}`);
    throw error;
  }
}

/** A release key file: its certificate and PKCS#8 private key, as written by `release keygen`. */
async function loadKey(path: string): Promise<SigningKey> {
  const text = await readText(path, 'release key');
  const [certificate] = fromPem(text);
  const privateKey = /-----BEGIN PRIVATE KEY-----[\s\S]+?-----END PRIVATE KEY-----/.exec(text)?.[0];
  if (!certificate || !privateKey)
    throw usageError(`${path} is not a release key (release keygen writes one)`);
  return createSigningKey({ privateKey, certificate });
}

/** The public half of a cosigner, from its `.pub.pem` (a certificate). */
async function loadPublic(path: string): Promise<Pick<SigningKey, 'kid' | 'publicKey'>> {
  const [certificate] = fromPem(await readText(path, 'public key'));
  if (!certificate) throw usageError(`${path} holds no certificate`);
  const publicKey = parseCertificate(certificate).publicKey;
  // The same kid a SigningKey derives: base64url of the subject key id.
  return { kid: base64url(subjectKeyId(publicKey)), publicKey };
}

const list = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

async function readManifest(path: string): Promise<SignedReleaseManifest> {
  try {
    return JSON.parse(await readText(path, 'release manifest')) as SignedReleaseManifest;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw usageError(`${path} is not JSON`);
  }
}

const manifestJson = (signed: SignedReleaseManifest) => `${JSON.stringify(signed, null, 2)}\n`;

export const releaseCommands = [
  defineCommand({
    name: 'release keygen',
    group: 'Release',
    summary: 'Create an offline release signing key and print its pin',
    description:
      "release keygen writes a new P-256 release signing key to --out (owner-only, never overwritten) and its public half to <out>.pub.pem, and prints the key's pin. Keep the key offline. Give the pin to installers (BCD_RELEASE_PINS) and daemons; give the .pub.pem to whoever builds manifests that you will cosign.",
    flags: {
      out: { type: 'string', value: 'PATH', required: true, description: 'Where to write the key' },
    },
    examples: ['better-compute release keygen --out ~/keys/release-alice.pem'],
    async run({ flags, path, note }) {
      const key = createReleaseSigningKey();
      const exported = key.export();
      const target = path(flags.out!);
      await writeNew(target, `${exported.certificatePem}${exported.privateKeyPem}`);
      await writeNew(`${target}.pub.pem`, exported.certificatePem);
      const pin = spkiPin(key.publicKey);
      note(`Wrote ${target} (keep offline) and ${target}.pub.pem.`);
      return { kid: key.kid, pin, publicKey: `${target}.pub.pem` };
    },
  }),
  defineCommand({
    name: 'release sign',
    group: 'Release',
    summary: "Sign a release manifest over a directory's artifacts",
    description:
      "release sign hashes every file in DIR (not subdirectories; *.sha256, manifest.json and signature files are skipped), derives each artifact's platform from goreleaser names (_linux_amd64.), and writes a manifest signed with --key. --sequence must increase with every release of --product: installers and bcd refuse a manifest whose sequence is below the last one they accepted. List the public halves of keys that will cosign later with --cosigners so their signatures count.",
    args: [
      { name: 'dir', description: 'The directory holding the release artifacts', required: true },
    ],
    flags: {
      product: { type: 'string', value: 'NAME', required: true, description: 'e.g. bcd' },
      version: { type: 'string', value: 'SEMVER', required: true, description: 'e.g. 1.4.0' },
      sequence: {
        type: 'integer',
        value: 'N',
        required: true,
        min: 1,
        description: 'The rollback counter: higher than every earlier release',
      },
      key: { type: 'string', value: 'PATH', required: true, description: 'The signing key' },
      cosigners: {
        type: 'string',
        value: 'PATHS',
        description: 'Comma-separated .pub.pem files of keys that will cosign',
      },
      'validity-days': {
        type: 'integer',
        value: 'DAYS',
        min: 1,
        max: 3650,
        description: 'How long installers accept the manifest (default 365)',
      },
      out: {
        type: 'string',
        value: 'PATH',
        description: 'Where to write the manifest (default DIR/manifest.json)',
      },
    },
    examples: [
      'better-compute release sign dist --product bcd --version 1.4.0 --sequence 14 --key ~/keys/release-alice.pem',
    ],
    async run({ flags, args, path, note }) {
      const dir = path(args[0]!);
      const key = await loadKey(path(flags.key!));
      const cosigners = await Promise.all(
        list(flags.cosigners).map((item) => loadPublic(path(item))),
      );
      const artifacts = [];
      for (const name of (await readdir(dir)).sort()) {
        if (name === 'manifest.json' || /\.(sha256|sig|pem)$/.test(name)) continue;
        const file = join(dir, name);
        if (!(await stat(file)).isFile()) continue;
        artifacts.push(releaseArtifact(name, await readFile(file), platformFromName(name)));
      }
      if (!artifacts.length) throw usageError(`${dir} holds no artifacts`);
      const manifest = buildReleaseManifest({
        product: flags.product!,
        version: flags.version!,
        sequence: flags.sequence!,
        artifacts,
        signers: [key, ...cosigners.filter((entry) => entry.kid !== key.kid)],
        ...(flags['validity-days'] !== undefined
          ? { validitySeconds: flags['validity-days'] * 86400 }
          : {}),
      });
      const signed = signReleaseManifest(manifest, [key]);
      const target = flags.out ? path(flags.out) : join(dir, 'manifest.json');
      await replace(target, manifestJson(signed), 0o644);
      note(`Wrote ${target}: ${artifacts.length} artifact(s), signed by ${key.kid}.`);
      return {
        manifest: target,
        product: manifest.product,
        version: manifest.version,
        sequence: manifest.sequence,
        expiresAt: new Date(manifest.expiresAt).toISOString(),
        artifacts: manifest.artifacts,
      };
    },
  }),
  defineCommand({
    name: 'release cosign',
    group: 'Release',
    summary: 'Add your signature to a release manifest',
    description:
      "release cosign adds --key's signature to MANIFEST in place. The key must be one the manifest lists (release sign --cosigners), so a threshold of release managers can each sign on their own machine.",
    args: [{ name: 'manifest', description: 'The manifest.json', required: true }],
    flags: {
      key: { type: 'string', value: 'PATH', required: true, description: 'Your signing key' },
    },
    examples: ['better-compute release cosign dist/manifest.json --key ~/keys/release-bob.pem'],
    async run({ flags, args, path, note }) {
      const target = path(args[0]!);
      const signed = signReleaseManifest(await readManifest(target), [
        await loadKey(path(flags.key!)),
      ]);
      await replace(target, manifestJson(signed), 0o644);
      note(`${target} now carries ${signed.signatures.length} signature(s).`);
      return { manifest: target, signatures: signed.signatures.map((entry) => entry.kid) };
    },
  }),
  defineCommand({
    name: 'release verify',
    group: 'Release',
    summary: 'Verify a release manifest (and its artifacts) against pinned keys',
    description:
      'release verify checks MANIFEST the way installers and bcd do, in this order: a --threshold of distinct keys among --pins signed it; its sequence is not below --min-sequence (rollback); it has not expired; and, with --dir, every listed artifact present there matches its size and SHA-256. It exits RELEASE_REJECTED with the reason otherwise.',
    args: [{ name: 'manifest', description: 'The manifest.json', required: true }],
    flags: {
      pins: {
        type: 'string',
        value: 'PINS',
        required: true,
        env: 'BCD_RELEASE_PINS',
        description: 'Comma-separated sha256/… pins of the release keys',
      },
      threshold: { type: 'integer', value: 'N', min: 1, max: 16, description: 'Default 1' },
      'min-sequence': {
        type: 'integer',
        value: 'N',
        min: 0,
        description: 'The last sequence accepted before',
      },
      product: { type: 'string', value: 'NAME', description: 'Refuse other products' },
      dir: { type: 'string', value: 'DIR', description: 'Also check the artifacts in DIR' },
    },
    examples: [
      'better-compute release verify dist/manifest.json --pins sha256/…,sha256/… --threshold 2 --dir dist',
    ],
    async run({ flags, args, path }) {
      const pins = list(flags.pins);
      if (!pins.length || !pins.every((pin) => pinPattern.test(pin)))
        throw usageError('--pins takes sha256/<base64> pins separated by commas');
      const signed = await readManifest(path(args[0]!));
      let manifest;
      let checked: string[] = [];
      try {
        manifest = verifyReleaseManifest(
          signed,
          { pins, ...(flags.threshold !== undefined ? { threshold: flags.threshold } : {}) },
          {
            ...(flags['min-sequence'] !== undefined ? { minSequence: flags['min-sequence'] } : {}),
            ...(flags.product ? { product: flags.product } : {}),
          },
        );
        if (flags.dir) {
          const dir = path(flags.dir);
          const present = new Set(await readdir(dir));
          for (const artifact of manifest.artifacts) {
            if (!present.has(artifact.name)) continue;
            verifyReleaseArtifact(
              manifest,
              artifact.name,
              await readFile(join(dir, artifact.name)),
            );
            checked.push(artifact.name);
          }
        }
      } catch (error) {
        const reason = (error as { details?: { reason?: string } }).details?.reason;
        if ((error as { code?: string }).code === 'ACCESS_DENIED')
          throw new CliError('RELEASE_REJECTED', `${(error as Error).message} (${reason})`);
        throw error;
      }
      return {
        valid: true,
        product: manifest.product,
        version: manifest.version,
        sequence: manifest.sequence,
        expiresAt: new Date(manifest.expiresAt).toISOString(),
        artifactsChecked: checked,
      };
    },
  }),
];
