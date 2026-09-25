import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  type JsonWebKey,
  type KeyObject,
} from 'node:crypto';
import { ComputeError, systemClock, type Clock } from '@better-compute/core';
import {
  createInternalCa,
  createNodeCa,
  createRootCa,
  createServingCa,
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
   * The command-signing root (v0.2 signed intent, `TrustBundle.command_signing_roots`): certifies the
   * workers' 24 h signing keys. Production keeps this root in KMS / Vault; the bundle form serves
   * development and small deployments, as for the CAs. Absent in older bundles.
   */
  commandSigning?: CommandSigningAuthority;
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
  /** Hex SHA-256 of the command-signing root certificate (DER), as trust bundles list it. */
  commandSigningRootSha256?: string;
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
    sshCa: createSshCertificateAuthority({ clock, comment: `${organization} ssh ca` }),
    commandSigning: createCommandSigningAuthority({
      clock,
      commonName: `${organization} command signing root`,
    }),
    revocations,
  };
}

const sha256Hex = (der: Uint8Array) => createHash('sha256').update(der).digest('hex');

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
    ...(bundle.commandSigning
      ? { commandSigningRootSha256: sha256Hex(bundle.commandSigning.certificate) }
      : {}),
  };
}

/**
 * The pins of a stored bundle, read from its public parts only: no secret needed, nothing unsealed.
 * Also reports each CA certificate's expiry. Throws `INVALID_CONFIG`.
 */
export function readPkiPins(text: string): PkiPins & { expires: Record<string, number> } {
  let stored: StoredBundle;
  try {
    stored = JSON.parse(text) as StoredBundle;
  } catch {
    throw new ComputeError('INVALID_CONFIG', 'The PKI bundle is not JSON');
  }
  if (stored?.format !== 'better-compute-pki' || stored.version !== 1)
    throw new ComputeError('INVALID_CONFIG', 'Not a better-compute PKI bundle (version 1)');
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
    ...(commandSigning
      ? { commandSigningRootSha256: sha256Hex(fromPem(stored.commandSigningCertificate!)[0]!) }
      : {}),
    expires: {
      root: root.notAfter,
      nodeCa: node.notAfter,
      servingCa: serving.notAfter,
      internalCa: internal.notAfter,
      ...(commandSigning ? { commandSigningRoot: commandSigning.notAfter } : {}),
    },
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
  /** PEM of the command-signing root certificate. */
  commandSigningCertificate?: string;
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
  | 'commandSigning';

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
  const commandSigning = bundle.commandSigning?.export();
  if (commandSigning) keys.commandSigning = commandSigning.privateKeyPem;
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
    ...(commandSigning ? { commandSigningCertificate: commandSigning.certificatePem } : {}),
  };
  if (options.secret !== undefined) {
    const salt = randomBytesArray(16);
    const iv = randomBytesArray(12);
    const cipher = createCipheriv('aes-256-gcm', sealKey(options.secret, salt), iv);
    const header = Buffer.from(`${stored.format}/${stored.version}/${stored.trustDomain}`);
    cipher.setAAD(header);
    const data = Buffer.concat([
      cipher.update(JSON.stringify(keys)),
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
}

/** Loads a bundle written by `exportPkiBundle`. Throws `INVALID_CONFIG` on a wrong secret or file. */
export function importPkiBundle(text: string, options: ImportPkiBundleOptions = {}): PkiBundle {
  let stored: StoredBundle;
  try {
    stored = JSON.parse(text) as StoredBundle;
  } catch {
    throw new ComputeError('INVALID_CONFIG', 'The PKI bundle is not JSON');
  }
  if (stored?.format !== 'better-compute-pki' || stored.version !== 1)
    throw new ComputeError('INVALID_CONFIG', 'Not a better-compute PKI bundle (version 1)');
  let keys: Partial<Record<KeyName, string>>;
  if (stored.sealed) {
    if (options.secret === undefined)
      throw new ComputeError(
        'INVALID_CONFIG',
        'The PKI bundle is sealed; pass the deployment secret',
      );
    try {
      const data = fromBase64url(stored.sealed.data);
      const decipher = createDecipheriv(
        'aes-256-gcm',
        sealKey(options.secret, fromBase64url(stored.sealed.salt)),
        fromBase64url(stored.sealed.iv),
      );
      decipher.setAAD(Buffer.from(`${stored.format}/${stored.version}/${stored.trustDomain}`));
      decipher.setAuthTag(data.subarray(data.length - 16));
      keys = JSON.parse(
        Buffer.concat([
          decipher.update(data.subarray(0, data.length - 16)),
          decipher.final(),
        ]).toString('utf8'),
      );
    } catch (error) {
      if (error instanceof ComputeError) throw error;
      throw new ComputeError(
        'INVALID_CONFIG',
        'Cannot unseal the PKI bundle: wrong secret or a damaged file',
      );
    }
  } else keys = stored.keys ?? {};
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
  if (stored.sshCaPublicKey) {
    const comment = stored.sshCaPublicKey.split(' ').slice(2).join(' ');
    bundle.sshCa = createSshCertificateAuthority({
      clock,
      privateKey: need('sshCa'),
      ...(comment ? { comment } : {}),
    });
    if (bundle.sshCa.publicKey.split(' ')[1] !== stored.sshCaPublicKey.split(' ')[1])
      throw new ComputeError('INVALID_CONFIG', 'The SSH CA key does not match its public key');
  }
  if (stored.commandSigningCertificate)
    // `existing` checks the key against the certificate (INVALID_CONFIG on a mismatch).
    bundle.commandSigning = createCommandSigningAuthority({
      clock,
      existing: {
        privateKey: need('commandSigning'),
        certificate: stored.commandSigningCertificate,
      },
    });
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
