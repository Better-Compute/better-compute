import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  X509Certificate,
  type JsonWebKey,
  type KeyObject,
} from 'node:crypto';
import { ComputeError, systemClock, type Clock } from '@better-compute/core';
import {
  createInternalCa,
  createNodeCa,
  createRootCa,
  createServingCa,
  renewCaCertificate,
  type LocalCertificateAuthority,
} from './ca.js';
import { createCommandSigningAuthority, type CommandSigningAuthority } from './intent.js';
import { publicJwk } from './jwe.js';
import {
  base64url,
  fromBase64url,
  fromPem,
  generateP256KeyPair,
  privateKeyPem,
  randomBytesArray,
  spkiPin,
  toPem,
  toPrivateKey,
  toPublicKey,
} from './keys.js';
import { createRevocationSet, type RevocationSet } from './revocation.js';
import { createSigningKey, type SigningKey } from './signing.js';
import { createSshCertificateAuthority, type SshCertificateAuthority } from './ssh.js';
import { createExecTicketIssuer, jwkThumbprint, type ExecTicketIssuer } from './tickets.js';
import { isTrustDomain } from './spiffe.js';
import { parseCertificate } from './x509.js';

/**
 * Everything a deployment's machine PKI consists of (PLAN.md §13): the offline root, the three
 * subordinate CAs and the two JoinService keys. `better-compute pki init` creates one; the control
 * plane loads it at start. No key does two jobs.
 */
export interface PkiBundle {
  trustDomain: string;
  /** Absent when the root key was exported separately and kept offline. */
  root?: LocalCertificateAuthority;
  /** The root certificate, always present (the trust anchor above the three CAs). */
  rootCertificate: Uint8Array;
  nodeCa: LocalCertificateAuthority;
  servingCa: LocalCertificateAuthority;
  internalCa: LocalCertificateAuthority;
  joinSigning: SigningKey;
  joinEncryption: { privateKey: KeyObject; publicKey: KeyObject };
  /** Signs audit checkpoints (v0.4). Absent in bundles made before it existed. */
  auditSigning?: SigningKey;
  /**
   * Signs exec tickets (v0.3 tunnels; P-256): `execTicketIssuer(bundle, { issuer })`. Every api
   * replica and the gateway derive the same `kid` from it. Absent in older bundles.
   */
  execTicketKey?: KeyObject;
  /** The compute SSH CA for break-glass certificates (v0.3). Absent in older bundles. */
  sshCa?: SshCertificateAuthority;
  /**
   * The sandbox SSH CA (v0.5, §3.7): `sandboxes.exec` certificates (`TunnelsOptions.sandboxSsh`), trusted by sandbox
   * guests (`vps({ sandboxExec: { caPublicKey } })`). Separate from break-glass: a sandbox certificate never opens a
   * node. Absent in older bundles.
   */
  sandboxSshCa?: SshCertificateAuthority;
  /**
   * The command-signing root (v0.2 signed intent, `TrustBundle.command_signing_roots`): certifies the
   * workers' 24 h signing keys. Production keeps this root in KMS / Vault; the bundle form serves
   * development and small deployments, as for the CAs. Absent in older bundles.
   */
  commandSigning?: CommandSigningAuthority;
  /**
   * Root rotation (§13: new key first, switch after every daemon has it, then drop the old): the next root,
   * published in the trust bundle but not signing yet (step 1).
   */
  commandSigningNext?: CommandSigningAuthority;
  /** The former root (DER), still trusted after the switch until it is dropped (step 3). */
  commandSigningPrevious?: Uint8Array;
  /** `TrustBundle.version`: raised whenever the set of trusted roots changes (default 1). */
  trustVersion?: number;
  /** Shared by the three CAs. */
  revocations: RevocationSet;
}

/** What install scripts and `bcd`'s config.toml need; nothing here is secret. */
export interface PkiPins {
  trustDomain: string;
  servingCaSpkiPin: string;
  joinSigningKeyPin: string;
  joinEncryptionKeyPin: string;
  /** The key bcd seals join tokens to; its pin is `joinEncryptionKeyPin`. */
  joinEncryptionJwk: JsonWebKey;
  /** What `audit verify` and third parties check checkpoints against. */
  auditSigningKeyPin?: string;
  /** The exec ticket key's JWKS `kid` (RFC 7638 thumbprint). */
  execTicketKeyId?: string;
  /** The SSH CA's OpenSSH public key (`TrustedUserCAKeys`, NodeSpec `access.sshCaPublicKeys`). */
  sshCaPublicKey?: string;
  /** The sandbox SSH CA's public key (what sandbox guests' sshd trusts). */
  sandboxSshCaPublicKey?: string;
  /** Hex SHA-256 of the command-signing root certificate (DER), as trust bundles list it. */
  commandSigningRootSha256?: string;
  /** During a root rotation: the added root (not signing yet) and the former root (still trusted). */
  commandSigningNextRootSha256?: string;
  commandSigningPreviousRootSha256?: string;
  /** The trust bundle version daemons receive (default 1). */
  trustVersion?: number;
}

export interface CreatePkiBundleOptions {
  /** SPIFFE trust domain of agent identities, e.g. `compute.example.com`. */
  trustDomain: string;
  clock?: Clock;
  /** Subject organization of every CA (default `better-compute`). */
  organization?: string;
  /** Root lifetime (default 10 years); the subordinate CAs live 1 year within it. */
  rootValiditySeconds?: number;
  caValiditySeconds?: number;
}

export function createPkiBundle(options: CreatePkiBundleOptions): PkiBundle {
  if (!isTrustDomain(options.trustDomain))
    throw new ComputeError(
      'INVALID_INPUT',
      'trustDomain must be a SPIFFE trust domain (a-z 0-9 . - _)',
    );
  const clock = options.clock ?? systemClock;
  const revocations = createRevocationSet();
  const organization = options.organization ?? 'better-compute';
  const root = createRootCa({
    clock,
    organization,
    commonName: `${organization} root CA`,
    ...(options.rootValiditySeconds ? { validitySeconds: options.rootValiditySeconds } : {}),
  });
  const sub = (commonName: string) => ({
    clock,
    organization,
    commonName,
    issuer: root,
    revocations,
    ...(options.caValiditySeconds ? { validitySeconds: options.caValiditySeconds } : {}),
  });
  const encryption = generateP256KeyPair();
  return {
    trustDomain: options.trustDomain,
    root,
    rootCertificate: root.certificate,
    nodeCa: createNodeCa({
      ...sub(`${organization} node CA`),
      id: 'node-ca',
      trustDomain: options.trustDomain,
    }),
    servingCa: createServingCa({ ...sub(`${organization} gateway serving CA`), id: 'serving-ca' }),
    internalCa: createInternalCa({ ...sub(`${organization} internal CA`), id: 'internal-ca' }),
    joinSigning: createSigningKey({ clock, commonName: `${organization} join signing` }),
    joinEncryption: encryption,
    auditSigning: createSigningKey({ clock, commonName: `${organization} audit signing` }),
    execTicketKey: generateP256KeyPair().privateKey,
    sshCa: createSshCertificateAuthority({ clock, comment: sshComment(`${organization} ssh ca`) }),
    sandboxSshCa: createSshCertificateAuthority({ clock, comment: sshComment(`${organization} sandbox ssh ca`) }),
    commandSigning: createCommandSigningAuthority({
      clock,
      commonName: `${organization} command signing root`,
    }),
    revocations,
  };
}

const sha256Hex = (der: Uint8Array) => createHash('sha256').update(der).digest('hex');

/** An SSH key comment from free text (an organization name): printable ASCII, one line, at most 64 characters. */
const sshComment = (text: string): string =>
  text.replace(/[^\x21-\x7e ]+/g, '-').replace(/^[ -]+/, '').slice(0, 64).trimEnd() || 'better-compute';

/** The exec ticket issuer of a bundle (throws `INVALID_CONFIG` for a bundle made before v0.3). */
export function execTicketIssuer(
  bundle: PkiBundle,
  options: { issuer: string; clock?: Clock },
): ExecTicketIssuer {
  if (!bundle.execTicketKey)
    throw new ComputeError(
      'INVALID_CONFIG',
      'The PKI bundle has no exec ticket key; create a new one with pki init',
    );
  return createExecTicketIssuer({ ...options, privateKey: bundle.execTicketKey });
}

/**
 * What a new machine pins before it trusts anything the control plane says (`bcd join --serving-ca-pin
 * --join-signing-pin`, rendered into its user data by provision): taken from the bundle, never from the unsigned
 * `/.well-known/better-compute`, whose pins only the control plane's Web PKI certificate vouches for.
 */
export function bootstrapPins(bundle: PkiBundle): {
  servingCaPin: string;
  joinSigningPin: string;
  joinEncryptionPin: string;
} {
  const pins = pkiPins(bundle);
  return {
    servingCaPin: pins.servingCaSpkiPin,
    joinSigningPin: pins.joinSigningKeyPin,
    // The join token is sealed to this key: without its pin a forged document could swap it and replay the token.
    joinEncryptionPin: pins.joinEncryptionKeyPin,
  };
}

/**
 * What the server's `tunnels` options take from a bundle: the exec ticket issuer (named for the public base URL),
 * the break-glass SSH CA and the sandbox SSH CA when the bundle has them. Pair the sandbox CA's public key with
 * `vps({ sandboxExec: { caPublicKey: bundle.sandboxSshCa.publicKey } })` so sandbox guests trust it.
 */
export function tunnelsOptions(
  bundle: PkiBundle,
  options: { issuer: string; clock?: Clock },
): { issuer: ExecTicketIssuer; ssh?: SshCertificateAuthority; sandboxSsh?: SshCertificateAuthority } {
  return {
    issuer: execTicketIssuer(bundle, options),
    ...(bundle.sshCa ? { ssh: bundle.sshCa } : {}),
    ...(bundle.sandboxSshCa ? { sandboxSsh: bundle.sandboxSshCa } : {}),
  };
}

/**
 * What the server's `pki` options take for signed intent: the signing root, the other roots daemons must keep
 * trusting during a rotation, and the trust bundle's version. Undefined without a command-signing root.
 */
export function commandSigningOptions(bundle: PkiBundle):
  | {
      commandSigning: CommandSigningAuthority;
      commandSigningRoots: Uint8Array[];
      trustVersion: number;
    }
  | undefined {
  if (!bundle.commandSigning) return undefined;
  return {
    commandSigning: bundle.commandSigning,
    commandSigningRoots: [
      ...(bundle.commandSigningNext ? [bundle.commandSigningNext.certificate] : []),
      ...(bundle.commandSigningPrevious ? [bundle.commandSigningPrevious] : []),
    ],
    trustVersion: bundle.trustVersion ?? 1,
  };
}

export type BundleCa = 'node' | 'serving' | 'internal';

/**
 * The bundle with one subordinate CA's certificate renewed under the root (same key and subject; see
 * `renewCaCertificate`). Needs the root key: in the bundle, or loaded with `importPkiBundle({ rootKey })`.
 */
export function renewBundleCa(
  bundle: PkiBundle,
  which: BundleCa,
  options: { validitySeconds?: number; clock?: Clock } = {},
): PkiBundle {
  if (!bundle.root)
    throw new ComputeError(
      'INVALID_STATE',
      'Renewing a CA needs the root key: load the bundle with the offline root key',
    );
  const clock = options.clock ?? systemClock;
  const current =
    which === 'node' ? bundle.nodeCa : which === 'serving' ? bundle.servingCa : bundle.internalCa;
  const chain = renewCaCertificate(bundle.root, current, {
    clock,
    ...(options.validitySeconds !== undefined ? { validitySeconds: options.validitySeconds } : {}),
  });
  const existing = { privateKey: current.export().privateKeyPem, certificates: chain };
  const common = { id: current.id, clock, revocations: bundle.revocations, existing };
  switch (which) {
    case 'node':
      return { ...bundle, nodeCa: createNodeCa({ ...common, trustDomain: bundle.trustDomain }) };
    case 'serving':
      return { ...bundle, servingCa: createServingCa(common) };
    case 'internal':
      return { ...bundle, internalCa: createInternalCa(common) };
  }
}

export type CommandRootRotationStage = 'add' | 'switch' | 'drop';

/**
 * One step of a command-signing root rotation (PLAN.md §13), returning the new bundle (the input is unchanged):
 * - `add`: a new root joins the trust bundle (version + 1); workers still sign under the current one.
 * - `switch`: once every daemon holds that version, workers sign under the new root; the old one stays trusted.
 * - `drop`: once nothing signed under the old root is in flight (worker keys live ≤ 24 h), it leaves the trust
 *   bundle (version + 1).
 * Throws `INVALID_STATE` for a step out of order.
 */
export function rotateCommandSigningRoot(
  bundle: PkiBundle,
  stage: CommandRootRotationStage,
  options: { clock?: Clock; organization?: string } = {},
): PkiBundle {
  if (!bundle.commandSigning)
    throw new ComputeError('INVALID_STATE', 'The bundle has no command-signing root to rotate');
  const version = bundle.trustVersion ?? 1;
  const refuse = (message: string) => new ComputeError('INVALID_STATE', message);
  switch (stage) {
    case 'add': {
      if (bundle.commandSigningNext) throw refuse('A new root was already added; switch to it next');
      if (bundle.commandSigningPrevious)
        throw refuse('The previous root is still trusted; drop it before starting another rotation');
      return {
        ...bundle,
        commandSigningNext: createCommandSigningAuthority({
          ...(options.clock ? { clock: options.clock } : {}),
          commonName: `${options.organization ?? 'better-compute'} command signing root ${version + 1}`,
        }),
        trustVersion: version + 1,
      };
    }
    case 'switch': {
      if (!bundle.commandSigningNext) throw refuse('No new root to switch to; add one first');
      const { commandSigningNext: next, ...rest } = bundle;
      // The set of trusted roots is unchanged, so the version stays.
      return {
        ...rest,
        commandSigning: next,
        commandSigningPrevious: bundle.commandSigning.certificate,
        trustVersion: version,
      };
    }
    case 'drop': {
      if (!bundle.commandSigningPrevious) throw refuse('No previous root to drop');
      const { commandSigningPrevious: _previous, ...rest } = bundle;
      return { ...rest, trustVersion: version + 1 };
    }
  }
}

const execTicketKeyIdOf = (key: KeyObject) => {
  const jwk = toPublicKey(key).export({ format: 'jwk' });
  return jwkThumbprint({ kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y! });
};

export function pkiPins(bundle: PkiBundle): PkiPins {
  return {
    trustDomain: bundle.trustDomain,
    servingCaSpkiPin: spkiPin(bundle.servingCa.publicKey),
    joinSigningKeyPin: spkiPin(bundle.joinSigning.publicKey),
    joinEncryptionKeyPin: spkiPin(bundle.joinEncryption.publicKey),
    joinEncryptionJwk: publicJwk(bundle.joinEncryption.publicKey),
    ...(bundle.auditSigning ? { auditSigningKeyPin: spkiPin(bundle.auditSigning.publicKey) } : {}),
    ...(bundle.execTicketKey ? { execTicketKeyId: execTicketKeyIdOf(bundle.execTicketKey) } : {}),
    ...(bundle.sshCa ? { sshCaPublicKey: bundle.sshCa.publicKey } : {}),
    ...(bundle.sandboxSshCa ? { sandboxSshCaPublicKey: bundle.sandboxSshCa.publicKey } : {}),
    ...(bundle.commandSigning
      ? { commandSigningRootSha256: sha256Hex(bundle.commandSigning.certificate) }
      : {}),
    ...(bundle.commandSigningNext
      ? { commandSigningNextRootSha256: sha256Hex(bundle.commandSigningNext.certificate) }
      : {}),
    ...(bundle.commandSigningPrevious
      ? { commandSigningPreviousRootSha256: sha256Hex(bundle.commandSigningPrevious) }
      : {}),
    ...(bundle.commandSigning ? { trustVersion: bundle.trustVersion ?? 1 } : {}),
  };
}

/**
 * The pins of a stored bundle, from its public parts, with each CA certificate's expiry. Without a secret nothing
 * is unsealed and nothing vouches for the file (`authenticated: false`): whoever can write it chooses these pins.
 * With the deployment `secret`, a sealed bundle's public parts are checked against the seal first (a changed file
 * throws), and `authenticated` is true. Throws `INVALID_CONFIG`.
 */
export function readPkiPins(
  text: string,
  options: Pick<ImportPkiBundleOptions, 'secret' | 'allowUnauthenticated'> = {},
): PkiPins & { expires: Record<string, number>; authenticated: boolean } {
  const stored = parseStored(text);
  const authenticated = options.secret !== undefined ? openKeys(stored, options).authenticated : false;
  const first = (pem: string, what: string) => {
    const der = fromPem(pem)[0];
    if (!der)
      throw new ComputeError('INVALID_CONFIG', `The PKI bundle lacks the ${what} certificate`);
    return parseCertificate(der);
  };
  const root = first(stored.rootCertificate, 'root');
  const serving = first(stored.servingCa, 'serving CA');
  const node = first(stored.nodeCa, 'node CA');
  const internal = first(stored.internalCa, 'internal CA');
  const signing = first(stored.joinSigningCertificate, 'join signing');
  const commandSigning = stored.commandSigningCertificate
    ? first(stored.commandSigningCertificate, 'command signing root')
    : undefined;
  return {
    trustDomain: stored.trustDomain,
    servingCaSpkiPin: spkiPin(serving.publicKey),
    joinSigningKeyPin: spkiPin(signing.publicKey),
    joinEncryptionKeyPin: spkiPin(stored.joinEncryptionPublicKey),
    joinEncryptionJwk: publicJwk(stored.joinEncryptionPublicKey),
    ...(stored.auditSigningCertificate
      ? {
          auditSigningKeyPin: spkiPin(
            first(stored.auditSigningCertificate, 'audit signing').publicKey,
          ),
        }
      : {}),
    ...(stored.execTicketPublicKey
      ? { execTicketKeyId: execTicketKeyIdOf(toPublicKey(stored.execTicketPublicKey)) }
      : {}),
    ...(stored.sshCaPublicKey ? { sshCaPublicKey: stored.sshCaPublicKey } : {}),
    ...(stored.sandboxSshCaPublicKey ? { sandboxSshCaPublicKey: stored.sandboxSshCaPublicKey } : {}),
    ...(commandSigning
      ? { commandSigningRootSha256: sha256Hex(fromPem(stored.commandSigningCertificate!)[0]!) }
      : {}),
    ...(stored.commandSigningNextCertificate
      ? {
          commandSigningNextRootSha256: sha256Hex(
            fromPem(stored.commandSigningNextCertificate)[0]!,
          ),
        }
      : {}),
    ...(stored.commandSigningPreviousCertificate
      ? {
          commandSigningPreviousRootSha256: sha256Hex(
            fromPem(stored.commandSigningPreviousCertificate)[0]!,
          ),
        }
      : {}),
    ...(commandSigning ? { trustVersion: stored.trustVersion ?? 1 } : {}),
    expires: {
      root: root.notAfter,
      nodeCa: node.notAfter,
      servingCa: serving.notAfter,
      internalCa: internal.notAfter,
      ...(commandSigning ? { commandSigningRoot: commandSigning.notAfter } : {}),
    },
    authenticated,
  };
}

// --- Storage ---------------------------------------------------------------------------------------

/** The stored form: public parts in the clear, private keys PEM, or sealed under a secret. */
interface StoredBundle {
  format: 'better-compute-pki';
  version: 1;
  trustDomain: string;
  rootCertificate: string;
  nodeCa: string;
  servingCa: string;
  internalCa: string;
  joinSigningCertificate: string;
  joinEncryptionPublicKey: string;
  auditSigningCertificate?: string;
  /** SPKI PEM of the exec ticket key. */
  execTicketPublicKey?: string;
  /** OpenSSH public key line of the SSH CA. */
  sshCaPublicKey?: string;
  /** OpenSSH public key line of the sandbox SSH CA. */
  sandboxSshCaPublicKey?: string;
  /** PEM of the command-signing root certificate. */
  commandSigningCertificate?: string;
  /** Rotation: the next root (with its key under `commandSigningNext`) and the former root (public only). */
  commandSigningNextCertificate?: string;
  commandSigningPreviousCertificate?: string;
  trustVersion?: number;
  /** PEM private keys by name, or `sealed` instead. */
  keys?: Record<KeyName, string>;
  sealed?: { alg: 'HKDF-SHA256+A256GCM'; salt: string; iv: string; data: string };
}
type KeyName =
  | 'root'
  | 'nodeCa'
  | 'servingCa'
  | 'internalCa'
  | 'joinSigning'
  | 'joinEncryption'
  | 'auditSigning'
  | 'execTickets'
  | 'sshCa'
  | 'sandboxSshCa'
  | 'commandSigning'
  | 'commandSigningNext';

/** What a sealed bundle encrypts: the private keys and a digest of every public field. */
interface SealedPayload {
  keys: Partial<Record<KeyName, string>>;
  publicSha256: string;
}

/** SHA-256 over the public fields (everything but `keys` and `sealed`), in sorted key order. */
function publicDigest(stored: StoredBundle): string {
  const fields = Object.entries(stored)
    .filter(([name, value]) => name !== 'keys' && name !== 'sealed' && value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

const minSecretLength = 32;

function sealKey(secret: string, salt: Uint8Array): Buffer {
  if (secret.length < minSecretLength)
    throw new ComputeError(
      'INVALID_CONFIG',
      `The PKI secret must be at least ${minSecretLength} characters`,
    );
  return Buffer.from(hkdfSync('sha256', secret, salt, 'better-compute/pki-bundle/v1', 32));
}

export interface ExportPkiBundleOptions {
  /** Seals the private keys with AES-256-GCM under a key derived from this (BETTER_COMPUTE_SECRET). */
  secret?: string;
  /** Leaves the root key out, for an offline root (store `exportRootKey` elsewhere). */
  omitRootKey?: boolean;
}

/**
 * Serializes a bundle to JSON. Without `secret` the private keys are plain PEM: write the file with
 * mode 0600, or better, pass the deployment secret so a copied file reveals nothing.
 */
export function exportPkiBundle(bundle: PkiBundle, options: ExportPkiBundleOptions = {}): string {
  const cas = (ca: LocalCertificateAuthority) => ca.export().certificatesPem;
  const keys: Partial<Record<KeyName, string>> = {
    nodeCa: bundle.nodeCa.export().privateKeyPem,
    servingCa: bundle.servingCa.export().privateKeyPem,
    internalCa: bundle.internalCa.export().privateKeyPem,
    joinSigning: bundle.joinSigning.export().privateKeyPem,
    joinEncryption: privateKeyPem(bundle.joinEncryption.privateKey),
  };
  if (bundle.root && !options.omitRootKey) keys.root = bundle.root.export().privateKeyPem;
  if (bundle.auditSigning) keys.auditSigning = bundle.auditSigning.export().privateKeyPem;
  if (bundle.execTicketKey) keys.execTickets = privateKeyPem(bundle.execTicketKey);
  if (bundle.sshCa) keys.sshCa = bundle.sshCa.export().privateKeyPem;
  if (bundle.sandboxSshCa) keys.sandboxSshCa = bundle.sandboxSshCa.export().privateKeyPem;
  const commandSigning = bundle.commandSigning?.export();
  if (commandSigning) keys.commandSigning = commandSigning.privateKeyPem;
  const commandSigningNext = bundle.commandSigningNext?.export();
  if (commandSigningNext) keys.commandSigningNext = commandSigningNext.privateKeyPem;
  const stored: StoredBundle = {
    format: 'better-compute-pki',
    version: 1,
    trustDomain: bundle.trustDomain,
    rootCertificate: toPem(bundle.rootCertificate),
    nodeCa: cas(bundle.nodeCa),
    servingCa: cas(bundle.servingCa),
    internalCa: cas(bundle.internalCa),
    joinSigningCertificate: bundle.joinSigning.export().certificatePem,
    joinEncryptionPublicKey: toPublicKey(bundle.joinEncryption.publicKey)
      .export({ type: 'spki', format: 'pem' })
      .toString(),
    ...(bundle.auditSigning
      ? { auditSigningCertificate: bundle.auditSigning.export().certificatePem }
      : {}),
    ...(bundle.execTicketKey
      ? {
          execTicketPublicKey: toPublicKey(bundle.execTicketKey)
            .export({ type: 'spki', format: 'pem' })
            .toString(),
        }
      : {}),
    ...(bundle.sshCa ? { sshCaPublicKey: bundle.sshCa.publicKey } : {}),
    ...(bundle.sandboxSshCa ? { sandboxSshCaPublicKey: bundle.sandboxSshCa.publicKey } : {}),
    ...(commandSigning ? { commandSigningCertificate: commandSigning.certificatePem } : {}),
    ...(commandSigningNext
      ? { commandSigningNextCertificate: commandSigningNext.certificatePem }
      : {}),
    ...(bundle.commandSigningPrevious
      ? { commandSigningPreviousCertificate: toPem(bundle.commandSigningPrevious) }
      : {}),
    ...(bundle.trustVersion !== undefined ? { trustVersion: bundle.trustVersion } : {}),
  };
  if (options.secret !== undefined) {
    const salt = randomBytesArray(16);
    const iv = randomBytesArray(12);
    const cipher = createCipheriv('aes-256-gcm', sealKey(options.secret, salt), iv);
    const header = Buffer.from(`${stored.format}/${stored.version}/${stored.trustDomain}`);
    cipher.setAAD(header);
    // The public parts are authenticated too: whoever can write the file but lacks the secret cannot add a
    // trust anchor (a command-signing root daemons would trust) or change the trust version.
    const sealedPayload: SealedPayload = { keys, publicSha256: publicDigest(stored) };
    const data = Buffer.concat([
      cipher.update(JSON.stringify(sealedPayload)),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    stored.sealed = {
      alg: 'HKDF-SHA256+A256GCM',
      salt: base64url(salt),
      iv: base64url(iv),
      data: base64url(data),
    };
  } else stored.keys = keys as Record<KeyName, string>;
  return `${JSON.stringify(stored, null, 2)}\n`;
}

/** The root key alone (PEM, sealed when `secret` is given), for keeping the root offline. */
export function exportRootKey(bundle: PkiBundle, options: { secret?: string } = {}): string {
  if (!bundle.root) throw new ComputeError('INVALID_STATE', 'This bundle holds no root key');
  const pem = bundle.root.export().privateKeyPem;
  if (options.secret === undefined) return pem;
  const salt = randomBytesArray(16);
  const iv = randomBytesArray(12);
  const cipher = createCipheriv('aes-256-gcm', sealKey(options.secret, salt), iv);
  cipher.setAAD(Buffer.from('better-compute-pki/root-key'));
  const data = Buffer.concat([cipher.update(pem), cipher.final(), cipher.getAuthTag()]);
  return `${JSON.stringify({ format: 'better-compute-pki-root-key', salt: base64url(salt), iv: base64url(iv), data: base64url(data) })}\n`;
}

export interface ImportPkiBundleOptions {
  /** Required when the bundle is sealed. */
  secret?: string;
  clock?: Clock;
  /** The root key (from `exportRootKey`) when the bundle was exported without it. */
  rootKey?: string;
  /**
   * Accept a bundle sealed in the former format, whose public parts nothing authenticates (and, with a secret,
   * an unsealed one). Off by default: whoever can write the file could otherwise swap certificates, add trust
   * anchors or roll the keys back to an older seal. Use it once to re-seal (`better-compute pki reseal`) after
   * checking the pins it prints.
   */
  allowUnauthenticated?: boolean;
}

/** Parses the stored JSON; throws `INVALID_CONFIG`. */
function parseStored(text: string): StoredBundle {
  let stored: StoredBundle;
  try {
    stored = JSON.parse(text) as StoredBundle;
  } catch {
    throw new ComputeError('INVALID_CONFIG', 'The PKI bundle is not JSON');
  }
  if (stored?.format !== 'better-compute-pki' || stored.version !== 1)
    throw new ComputeError('INVALID_CONFIG', 'Not a better-compute PKI bundle (version 1)');
  // One line, a key type the CA signs, a short printable comment: every node writes it into sshd's
  // TrustedUserCAKeys, where a second line would be a second trusted CA.
  for (const line of [stored.sshCaPublicKey, stored.sandboxSshCaPublicKey])
    if (line !== undefined && !sshCaLine.test(line))
      throw new ComputeError('INVALID_CONFIG', 'The PKI bundle has a malformed SSH CA public key');
  return stored;
}

const sshCaLine = /^(ssh-ed25519|ecdsa-sha2-nistp256) [A-Za-z0-9+/]+={0,2}( [\x21-\x7e][\x20-\x7e]{0,63})?$/;

/**
 * The private keys of a stored bundle and whether its public parts are authenticated (sealed with a digest that
 * matches). A secret with an unsealed bundle, or a bundle sealed in the former format, is refused unless
 * `allowUnauthenticated`.
 */
function openKeys(
  stored: StoredBundle,
  options: Pick<ImportPkiBundleOptions, 'secret' | 'allowUnauthenticated'>,
): { keys: Partial<Record<KeyName, string>>; authenticated: boolean } {
  const reseal =
    'run better-compute pki reseal: it prints the pins it would vouch for; compare them with your records, then run it again with --accept-unauthenticated';
  if (!stored.sealed) {
    if (options.secret !== undefined && !options.allowUnauthenticated)
      throw new ComputeError(
        'INVALID_CONFIG',
        `The PKI bundle is not sealed although a deployment secret is set; a sealed bundle may have been replaced. If this one is yours, ${reseal}`,
      );
    return { keys: stored.keys ?? {}, authenticated: false };
  }
  if (options.secret === undefined)
    throw new ComputeError('INVALID_CONFIG', 'The PKI bundle is sealed; pass the deployment secret');
  let opened: SealedPayload | Partial<Record<KeyName, string>>;
  try {
    const data = fromBase64url(stored.sealed.data);
    const decipher = createDecipheriv(
      'aes-256-gcm',
      sealKey(options.secret, fromBase64url(stored.sealed.salt)),
      fromBase64url(stored.sealed.iv),
    );
    decipher.setAAD(Buffer.from(`${stored.format}/${stored.version}/${stored.trustDomain}`));
    decipher.setAuthTag(data.subarray(data.length - 16));
    opened = JSON.parse(
      Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]).toString('utf8'),
    ) as SealedPayload | Partial<Record<KeyName, string>>;
  } catch (error) {
    if (error instanceof ComputeError) throw error;
    throw new ComputeError('INVALID_CONFIG', 'Cannot unseal the PKI bundle: wrong secret or a damaged file');
  }
  if ('publicSha256' in opened && typeof opened.keys === 'object') {
    if (opened.publicSha256 !== publicDigest(stored))
      throw new ComputeError(
        'INVALID_CONFIG',
        'The PKI bundle’s public parts were changed after it was sealed (a certificate, trust anchor or trust version); restore it from a backup',
      );
    return { keys: opened.keys, authenticated: true };
  }
  // Sealed in the former format: nothing ties its public parts to the seal, and an older seal of the same
  // deployment could be swapped in (rolling keys back).
  if (!options.allowUnauthenticated)
    throw new ComputeError(
      'INVALID_CONFIG',
      `The PKI bundle is sealed in the former format, which does not authenticate its certificates. ${reseal[0]!.toUpperCase()}${reseal.slice(1)}`,
    );
  if (stored.commandSigningPreviousCertificate !== undefined || stored.trustVersion !== undefined)
    throw new ComputeError(
      'INVALID_CONFIG',
      'This PKI bundle was sealed without authenticating its command-signing rotation; restore the copy from before the rotation and run better-compute pki rotate-command-root again',
    );
  return { keys: opened as Partial<Record<KeyName, string>>, authenticated: false };
}

/** Loads a bundle written by `exportPkiBundle`. Throws `INVALID_CONFIG` on a wrong secret or file. */
export function importPkiBundle(text: string, options: ImportPkiBundleOptions = {}): PkiBundle {
  const stored = parseStored(text);
  const { keys } = openKeys(stored, options);
  const need = (name: KeyName): string => {
    const value = keys[name];
    if (!value) throw new ComputeError('INVALID_CONFIG', `The PKI bundle lacks the ${name} key`);
    return value;
  };
  const clock = options.clock ?? systemClock;
  const revocations = createRevocationSet();
  const rootCertificate = fromPem(stored.rootCertificate)[0];
  if (!rootCertificate)
    throw new ComputeError('INVALID_CONFIG', 'The PKI bundle lacks the root certificate');
  const rootKey =
    keys.root ??
    (options.rootKey !== undefined ? openRootKey(options.rootKey, options.secret) : undefined);
  const existing = (key: string, pem: string) => ({ privateKey: key, certificates: fromPem(pem) });
  const bundle: PkiBundle = {
    trustDomain: stored.trustDomain,
    rootCertificate,
    nodeCa: createNodeCa({
      id: 'node-ca',
      clock,
      revocations,
      trustDomain: stored.trustDomain,
      existing: existing(need('nodeCa'), stored.nodeCa),
    }),
    servingCa: createServingCa({
      id: 'serving-ca',
      clock,
      revocations,
      existing: existing(need('servingCa'), stored.servingCa),
    }),
    internalCa: createInternalCa({
      id: 'internal-ca',
      clock,
      revocations,
      existing: existing(need('internalCa'), stored.internalCa),
    }),
    joinSigning: createSigningKey({
      privateKey: need('joinSigning'),
      certificate: fromPem(stored.joinSigningCertificate)[0]!,
    }),
    joinEncryption: (() => {
      const privateKey = toPrivateKey(need('joinEncryption'));
      return { privateKey, publicKey: toPublicKey(privateKey) };
    })(),
    revocations,
  };
  if (stored.auditSigningCertificate)
    bundle.auditSigning = createSigningKey({
      privateKey: need('auditSigning'),
      certificate: fromPem(stored.auditSigningCertificate)[0]!,
    });
  if (stored.execTicketPublicKey) {
    const key = toPrivateKey(need('execTickets'));
    if (spkiPin(key) !== spkiPin(stored.execTicketPublicKey))
      throw new ComputeError('INVALID_CONFIG', 'The exec ticket key does not match its public key');
    bundle.execTicketKey = key;
  }
  // Each SSH CA is rebuilt from its sealed key; the stored line must be that key's (the comment is free text).
  const sshCaOf = (line: string, key: KeyName, what: string) => {
    const comment = line.split(' ').slice(2).join(' ');
    const ca = createSshCertificateAuthority({ clock, privateKey: need(key), ...(comment ? { comment } : {}) });
    if (ca.publicKey.split(' ')[1] !== line.split(' ')[1])
      throw new ComputeError('INVALID_CONFIG', `The ${what} key does not match its public key`);
    return ca;
  };
  if (stored.sshCaPublicKey) bundle.sshCa = sshCaOf(stored.sshCaPublicKey, 'sshCa', 'SSH CA');
  if (stored.sandboxSshCaPublicKey)
    bundle.sandboxSshCa = sshCaOf(stored.sandboxSshCaPublicKey, 'sandboxSshCa', 'sandbox SSH CA');
  if (stored.commandSigningCertificate)
    // `existing` checks the key against the certificate (INVALID_CONFIG on a mismatch).
    bundle.commandSigning = createCommandSigningAuthority({
      clock,
      existing: {
        privateKey: need('commandSigning'),
        certificate: stored.commandSigningCertificate,
      },
    });
  if (stored.commandSigningNextCertificate)
    bundle.commandSigningNext = createCommandSigningAuthority({
      clock,
      existing: {
        privateKey: need('commandSigningNext'),
        certificate: stored.commandSigningNextCertificate,
      },
    });
  if (stored.commandSigningPreviousCertificate) {
    const previous = fromPem(stored.commandSigningPreviousCertificate)[0];
    if (!previous)
      throw new ComputeError('INVALID_CONFIG', 'The PKI bundle has an unreadable previous command-signing root');
    if (!new X509Certificate(previous).ca)
      throw new ComputeError('INVALID_CONFIG', 'The previous command-signing root is not a CA certificate');
    bundle.commandSigningPrevious = previous;
  }
  if (stored.trustVersion !== undefined) {
    if (!Number.isSafeInteger(stored.trustVersion) || stored.trustVersion < 1)
      throw new ComputeError('INVALID_CONFIG', 'The PKI bundle has an invalid trust version');
    bundle.trustVersion = stored.trustVersion;
  }
  if (rootKey)
    bundle.root = createRootCa({
      clock,
      existing: { privateKey: rootKey, certificates: [rootCertificate] },
    });
  if (spkiPin(bundle.joinEncryption.publicKey) !== spkiPin(stored.joinEncryptionPublicKey))
    throw new ComputeError(
      'INVALID_CONFIG',
      'The join encryption key does not match its public key',
    );
  return bundle;
}

function openRootKey(text: string, secret: string | undefined): string {
  if (text.includes('-----BEGIN')) return text;
  if (secret === undefined)
    throw new ComputeError('INVALID_CONFIG', 'The root key is sealed; pass the secret');
  try {
    const stored = JSON.parse(text) as { salt: string; iv: string; data: string };
    const data = fromBase64url(stored.data);
    const decipher = createDecipheriv(
      'aes-256-gcm',
      sealKey(secret, fromBase64url(stored.salt)),
      fromBase64url(stored.iv),
    );
    decipher.setAAD(Buffer.from('better-compute-pki/root-key'));
    decipher.setAuthTag(data.subarray(data.length - 16));
    return Buffer.concat([
      decipher.update(data.subarray(0, data.length - 16)),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new ComputeError(
      'INVALID_CONFIG',
      'Cannot unseal the root key: wrong secret or a damaged file',
    );
  }
}
