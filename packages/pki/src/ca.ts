import type { KeyObject } from 'node:crypto';
import {
  ComputeError,
  systemClock,
  type CertificateAuthority,
  type CertificateProfile,
  type Clock,
  type IssuedCertificate,
} from '@better-compute/core';
import { parseCsr } from './csr.js';
import {
  assertP256,
  fromPem,
  generateP256KeyPair,
  privateKeyPem,
  randomBytesArray,
  toPem,
  toPrivateKey,
  toPublicKey,
  type PublicKeyInput,
} from './keys.js';
import { createRevocationSet, normalizeSerial, type RevocationSet } from './revocation.js';
import { parseNodeSpiffeId } from './spiffe.js';
import {
  buildCertificate,
  distinguishedName,
  parseCertificate,
  subjectKeyId,
  verifyCertificateChain,
  type ExtendedKeyUsage,
  type ParsedCertificate,
} from './x509.js';

/**
 * What a CA may sign. No key does two jobs (PLAN.md §13):
 * - `root`: the offline root; signs only subordinate CAs.
 * - `node`: per-region agent client certificates (SPIFFE URI SAN + role, `clientAuth`, ≤ 24 h).
 * - `serving`: gateway serving certificates (DNS SANs, `serverAuth`, ≤ 30 days).
 * - `internal`: control-plane mTLS between api, worker and gateways (≤ 7 days).
 */
export type CaKind = 'root' | 'node' | 'serving' | 'internal';

export const agentCertificateRoles = ['node', 'site', 'ramdisk', 'node-tenant'] as const;
export type AgentCertificateRole = (typeof agentCertificateRoles)[number];

const hour = 3600;
const day = 24 * hour;

/** The longest leaf each kind issues unless `maxTtlSeconds` lowers it. */
export const defaultMaxTtlSeconds: Readonly<Record<Exclude<CaKind, 'root'>, number>> = {
  node: day,
  serving: 30 * day,
  internal: 7 * day,
};
/** Ramdisk certificates live at most 2 h (PLAN.md §3.5), whatever the profile asks. */
export const ramdiskMaxTtlSeconds = 2 * hour;

export interface LocalCaOptions {
  /** `CertificateAuthority.id` (default `<kind>-ca`). */
  id?: string;
  commonName?: string;
  /** Subject organization (default `better-compute`). */
  organization?: string;
  clock?: Clock;
  /** Lifetime of a generated CA certificate (default 10 years for roots, 1 year otherwise). */
  validitySeconds?: number;
  /** Signs the new CA's certificate (a `root`); otherwise it is self-signed. */
  issuer?: LocalCertificateAuthority;
  /** Caps every leaf's lifetime below the kind's default maximum. */
  maxTtlSeconds?: number;
  /** Node CAs: SPIFFE URI SANs must use this trust domain. */
  trustDomain?: string;
  /** Shared with gateways and the Renew verifier (default: a new set). */
  revocations?: RevocationSet;
  /** Backdates `notBefore` to absorb clock skew (default 60 s). */
  backdateSeconds?: number;
  /** Loads an existing CA instead of generating one: its key and its certificates, signing first. */
  existing?: {
    privateKey: KeyObject | Uint8Array | string;
    certificates: readonly (Uint8Array | string)[];
  };
}

export interface LocalCertificateAuthority extends CertificateAuthority {
  readonly kind: CaKind;
  /** This CA's certificate (DER). */
  readonly certificate: Uint8Array;
  /** This CA's certificate and its issuers, signing first. */
  readonly chain: readonly Uint8Array[];
  readonly publicKey: KeyObject;
  readonly subjectKeyId: Uint8Array;
  readonly notAfter: number;
  readonly revocations: RevocationSet;
  /** Signs a PKCS#10 request (the request's subject is ignored; names come from `profile`). */
  sign(csr: Uint8Array, profile: CertificateProfile): Promise<IssuedCertificate>;
  /** Issues for a key generated locally (`better-compute pki issue-gateway`), with no request. */
  issue(publicKey: PublicKeyInput, profile: CertificateProfile): Promise<IssuedCertificate>;
  revoke(serial: string, reason?: string): Promise<void>;
  isRevoked(serial: string): boolean;
  /**
   * Verifies a presented chain (leaf first) against this CA's own certificate as the trust anchor,
   * at the CA clock's time; rejects revoked leaves. Throws `ACCESS_DENIED`.
   */
  verify(
    chain: readonly Uint8Array[],
    options?: { usage?: ExtendedKeyUsage; now?: number },
  ): ParsedCertificate[];
  /** PEM for storage: certificates signing first, and the PKCS#8 key. Handle as a secret. */
  export(): { certificatesPem: string; privateKeyPem: string };
}

const dnsPattern =
  /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

function invalid(message: string): ComputeError {
  return new ComputeError('INVALID_INPUT', message);
}

function randomSerial(): Uint8Array {
  const serial = randomBytesArray(16);
  serial[0] = (serial[0]! & 0x7f) | 0x01;
  return serial;
}

function asDer(value: Uint8Array | string): Uint8Array {
  if (typeof value !== 'string') return value;
  const [first] = fromPem(value);
  if (!first) throw invalid('Expected a PEM certificate');
  return first;
}

/** Creates or loads a CA of the given kind. Prefer `createNodeCa` and friends. */
export function createLocalCa(
  kind: CaKind,
  options: LocalCaOptions = {},
): LocalCertificateAuthority {
  const clock = options.clock ?? systemClock;
  const revocations = options.revocations ?? createRevocationSet();
  const backdateMs = (options.backdateSeconds ?? 60) * 1000;
  const id = options.id ?? `${kind}-ca`;
  if (options.issuer && options.issuer.kind !== 'root')
    throw invalid('Only a root CA can issue a subordinate CA');
  if (kind === 'root' && options.issuer) throw invalid('A root CA is self-signed');

  let privateKey: KeyObject;
  let chain: Uint8Array[];
  if (options.existing) {
    privateKey = toPrivateKey(options.existing.privateKey);
    chain = options.existing.certificates.map(asDer);
    if (chain.length === 0) throw invalid('An existing CA needs its certificate');
  } else {
    const pair = generateP256KeyPair();
    privateKey = pair.privateKey;
    const now = clock.now();
    const validity = (options.validitySeconds ?? (kind === 'root' ? 3650 * day : 365 * day)) * 1000;
    const subject = distinguishedName({
      organization: options.organization ?? 'better-compute',
      commonName: options.commonName ?? `better-compute ${kind} CA`,
    });
    const issuer = options.issuer;
    if (issuer && now > issuer.notAfter)
      throw new ComputeError('INVALID_STATE', 'The root CA has expired');
    const parent = issuer ? parseCertificate(issuer.certificate) : undefined;
    const certificate = buildCertificate(
      {
        serial: randomSerial(),
        issuer: parent ? parent.subject : subject,
        subject,
        notBefore: now - backdateMs,
        notAfter: Math.min(now + validity, issuer?.notAfter ?? Number.POSITIVE_INFINITY),
        publicKey: pair.publicKey,
        ca: { pathLength: kind === 'root' ? 1 : 0 },
        ...(issuer ? { authorityKeyId: issuer.subjectKeyId } : {}),
      },
      issuer ? (issuer as InternalCa)[signerKey] : privateKey,
    );
    chain = [certificate, ...(issuer?.chain ?? [])];
  }
  assertP256(privateKey, 'CA key');
  const own = parseCertificate(chain[0]!);
  if (!own.isCa) throw invalid('The CA certificate is not marked as a CA');
  const publicKey = toPublicKey(privateKey);
  if (!own.publicKey.equals(publicKey)) throw invalid('The CA key does not match its certificate');
  const keyId = own.subjectKeyId ?? subjectKeyId(publicKey);
  const maxTtl =
    kind === 'root'
      ? 0
      : Math.min(options.maxTtlSeconds ?? Number.POSITIVE_INFINITY, defaultMaxTtlSeconds[kind]);

  const checkProfile = (profile: CertificateProfile): { commonName: string; role?: string } => {
    if (kind === 'root') throw invalid('A root CA signs only subordinate CAs');
    const uriSans = profile.uriSans ?? [];
    const dnsSans = profile.dnsSans ?? [];
    if (!Number.isInteger(profile.ttlSeconds) || profile.ttlSeconds <= 0)
      throw invalid('ttlSeconds must be a positive integer');
    if (profile.ttlSeconds > maxTtl) throw invalid(`${kind} certificates live at most ${maxTtl} s`);
    for (const name of dnsSans)
      if (name.length > 253 || !dnsPattern.test(name))
        throw invalid(`Invalid DNS SAN ${JSON.stringify(name)}`);
    for (const uri of uriSans)
      if (!/^[a-z][a-z0-9+.-]*:[\x21-\x7e]+$/.test(uri))
        throw invalid(`Invalid URI SAN ${JSON.stringify(uri)}`);
    const role: string | undefined = profile.role;
    switch (kind) {
      case 'node': {
        if (profile.usage !== 'client') throw invalid('A node CA issues client certificates only');
        if (dnsSans.length || uriSans.length !== 1)
          throw invalid('A node certificate has exactly one SPIFFE URI SAN and no DNS SANs');
        const spiffe = parseNodeSpiffeId(uriSans[0]!);
        if (!spiffe) throw invalid('The URI SAN must be spiffe://<td>/site/<site>/node/<node>');
        if (options.trustDomain !== undefined && spiffe.trustDomain !== options.trustDomain)
          throw invalid(`The SPIFFE trust domain must be ${options.trustDomain}`);
        if (!role || !(agentCertificateRoles as readonly string[]).includes(role))
          throw invalid(`A node certificate's role is one of ${agentCertificateRoles.join(', ')}`);
        if (role === 'ramdisk' && profile.ttlSeconds > ramdiskMaxTtlSeconds)
          throw invalid(`Ramdisk certificates live at most ${ramdiskMaxTtlSeconds} s`);
        return { commonName: spiffe.nodeId, role };
      }
      case 'serving':
        if (profile.usage !== 'server')
          throw invalid('A serving CA issues server certificates only');
        if (dnsSans.length === 0 || uriSans.length)
          throw invalid('A serving certificate has DNS SANs and no URI SANs');
        if (role !== undefined && role !== 'gateway')
          throw invalid("A serving certificate's role is gateway");
        return { commonName: dnsSans[0]!, ...(role ? { role } : {}) };
      case 'internal': {
        if (dnsSans.length + uriSans.length === 0)
          throw invalid('An internal certificate needs a SAN');
        if (role !== undefined && role !== 'internal' && role !== 'gateway')
          throw invalid("An internal certificate's role is internal or gateway");
        const commonName = dnsSans[0] ?? uriSans[0]!.split('/').filter(Boolean).pop() ?? 'internal';
        return { commonName: commonName.slice(0, 64), ...(role ? { role } : {}) };
      }
    }
  };

  const issueFor = async (
    key: KeyObject,
    profile: CertificateProfile,
  ): Promise<IssuedCertificate> => {
    const { commonName, role } = checkProfile(profile);
    assertP256(key, 'The certified key');
    const now = clock.now();
    if (now > own.notAfter) throw new ComputeError('INVALID_STATE', `CA ${id} has expired`);
    const notBefore = Math.max(now - backdateMs, own.notBefore);
    const notAfter = Math.min(now + profile.ttlSeconds * 1000, own.notAfter);
    const serial = randomSerial();
    const certificate = buildCertificate(
      {
        serial,
        issuer: own.subject,
        subject: distinguishedName({
          organization: options.organization ?? 'better-compute',
          commonName,
        }),
        notBefore,
        notAfter,
        publicKey: key,
        authorityKeyId: keyId,
        usage: [profile.usage],
        ...(profile.uriSans?.length ? { uriSans: profile.uriSans } : {}),
        ...(profile.dnsSans?.length ? { dnsSans: profile.dnsSans } : {}),
        ...(role ? { role } : {}),
      },
      privateKey,
    );
    const parsed = parseCertificate(certificate);
    return {
      serial: parsed.serial,
      certificate,
      chain: chain.map((item) => item.slice()),
      notBefore: parsed.notBefore,
      notAfter: parsed.notAfter,
    };
  };

  const ca: InternalCa = {
    id,
    kind,
    certificate: chain[0]!,
    chain,
    publicKey,
    subjectKeyId: keyId,
    notAfter: own.notAfter,
    revocations,
    [signerKey]: privateKey,
    certificates: async () => chain.map((item) => item.slice()),
    sign: async (csr, profile) => issueFor(parseCsr(csr).publicKey, profile),
    issue: async (key, profile) => issueFor(toPublicKey(key), profile),
    revoke: async (serial, reason) => {
      revocations.add(normalizeSerial(serial), {
        at: clock.now(),
        ...(reason !== undefined ? { reason } : {}),
      });
    },
    isRevoked: (serial) => revocations.has(serial),
    verify(presented, verifyOptions = {}) {
      const path = verifyCertificateChain(presented, [chain[0]!], {
        now: verifyOptions.now ?? clock.now(),
        ...(verifyOptions.usage ? { usage: verifyOptions.usage } : {}),
      });
      if (revocations.has(path[0]!.serial))
        throw new ComputeError('ACCESS_DENIED', 'Certificate chain rejected', undefined, {
          reason: `certificate ${path[0]!.serial} is revoked`,
        });
      return path;
    },
    export: () => ({
      certificatesPem: chain.map((item) => toPem(item)).join(''),
      privateKeyPem: privateKeyPem(privateKey),
    }),
  };
  return ca;
}

const signerKey = Symbol('better-compute.pki.signer');
interface InternalCa extends LocalCertificateAuthority {
  readonly [signerKey]: KeyObject;
}

/** The offline root that certifies per-region node, serving and internal CAs. */
export const createRootCa = (options: Omit<LocalCaOptions, 'issuer'> = {}) =>
  createLocalCa('root', options);
/** A per-region node CA: agent client certificates only (`spiffe://…/node/…`, role, ≤ 24 h). */
export const createNodeCa = (options: LocalCaOptions = {}) => createLocalCa('node', options);
/** The gateway serving CA whose SPKI daemons pin: server certificates only (≤ 30 days). */
export const createServingCa = (options: LocalCaOptions = {}) => createLocalCa('serving', options);
/** The internal control-plane CA (api ↔ gateway ↔ worker mTLS). */
export const createInternalCa = (options: LocalCaOptions = {}) =>
  createLocalCa('internal', options);
