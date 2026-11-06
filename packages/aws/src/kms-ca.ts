import { createHash, randomBytes } from 'node:crypto';
import {
  ComputeError,
  systemClock,
  type CertificateAuthority,
  type CertificateProfile,
  type IssuedCertificate,
} from '@better-compute/core';
import {
  agentCertificateRoles,
  buildCertificateWithSigner,
  createRevocationSet,
  der,
  distinguishedName,
  ecdsaWithSha256,
  isNodeKeyStatement,
  normalizeSerial,
  parseCertificate,
  parseCsr,
  parseNodeSpiffeId,
  type CertificateSigner,
  type RevocationSet,
} from '@better-compute/pki';
import { transportFor, type AwsServiceOptions } from './common.js';
import { jsonClient, type JsonClient } from './internal/transport.js';

export interface KmsCertificateAuthorityOptions extends AwsServiceOptions {
  id: string;
  /** An ECC_NIST_P256 SIGN_VERIFY KMS key. */
  keyId: string;
  /** DER CA certificate whose public key is the KMS key's (issued by the operator's root over kmsCaCsr). */
  certificate: Uint8Array;
  /** The issuers above it, DER. */
  chain?: Uint8Array[];
  /** The job, for the local CAs' profile rules (default 'internal'). */
  kind?: 'node' | 'serving' | 'internal';
  /** Caps every leaf's lifetime (default: the kind's local-CA maximum: node 1 d, serving 30 d, internal 7 d). */
  maxTtlSeconds?: number;
  /** Shared with verifiers (default: a new set). */
  revocations?: RevocationSet;
  organization?: string;
}

const day = 24 * 3600;
const kindMaxTtl = { node: day, serving: 30 * day, internal: 7 * day } as const;
const dnsPattern = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

function kms(options: AwsServiceOptions): JsonClient {
  return jsonClient(transportFor(options), { hostPrefix: 'kms', jsonVersion: '1.1', targetPrefix: 'TrentService' });
}

function checkKeyId(keyId: string): string {
  if (typeof keyId !== 'string' || !/^[A-Za-z0-9:/_+=.@-]{1,2048}$/.test(keyId))
    throw new ComputeError('INVALID_CONFIG', 'keyId is a KMS key id, ARN or alias');
  return keyId;
}

/** A `CertificateSigner` backed by a KMS ECC_NIST_P256 key (Sign, MessageType DIGEST). */
export function kmsCertificateSigner(client: JsonClient, keyId: string): CertificateSigner {
  return {
    algorithm: 'ecdsa-sha256',
    async sign(tbs) {
      const result = await client.call<{ Signature?: string }>('Sign', {
        KeyId: keyId,
        Message: createHash('sha256').update(tbs).digest('base64'),
        MessageType: 'DIGEST',
        SigningAlgorithm: 'ECDSA_SHA_256',
      });
      if (!result.Signature) throw new ComputeError('PROVIDER_ERROR', 'KMS Sign returned no signature');
      return new Uint8Array(Buffer.from(result.Signature, 'base64'));
    },
  };
}

async function kmsPublicKey(client: JsonClient, keyId: string): Promise<Uint8Array> {
  const result = await client.call<{ PublicKey?: string; KeySpec?: string; KeyUsage?: string }>('GetPublicKey', { KeyId: keyId });
  if (result.KeySpec !== 'ECC_NIST_P256' || result.KeyUsage !== 'SIGN_VERIFY' || !result.PublicKey)
    throw new ComputeError('INVALID_CONFIG', 'the KMS key is not an ECC_NIST_P256 SIGN_VERIFY key');
  return new Uint8Array(Buffer.from(result.PublicKey, 'base64'));
}

function randomSerial(): Uint8Array {
  const serial = new Uint8Array(randomBytes(16));
  serial[0] = (serial[0]! & 0x7f) | 0x01;
  return serial;
}

/**
 * A `CertificateAuthority` whose key never leaves KMS: it builds the template the local CAs build
 * for the profile and has KMS sign the TBSCertificate's digest. The CA certificate must certify the
 * KMS key's public key (checked on first use; a mismatch is INVALID_CONFIG).
 */
export function kmsCertificateAuthority(options: KmsCertificateAuthorityOptions): CertificateAuthority {
  const keyId = checkKeyId(options.keyId);
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(options.id)) throw new ComputeError('INVALID_CONFIG', 'a CA id is [a-z][a-z0-9-]*');
  const own = parseCertificate(options.certificate);
  if (!own.isCa) throw new ComputeError('INVALID_CONFIG', 'the KMS CA certificate is not marked as a CA');
  const kind = options.kind ?? 'internal';
  const maxTtl = Math.min(options.maxTtlSeconds ?? Number.POSITIVE_INFINITY, kindMaxTtl[kind]);
  const clock = options.clock ?? systemClock;
  const revocations = options.revocations ?? createRevocationSet();
  const organization = options.organization ?? 'better-compute';
  const client = kms(options);
  const signer = kmsCertificateSigner(client, keyId);
  const chain = [options.certificate, ...(options.chain ?? [])].map((item) => item.slice());
  let checked: Promise<void> | undefined;

  const ensureKey = () =>
    (checked ??= kmsPublicKey(client, keyId).then((spki) => {
      if (Buffer.compare(Buffer.from(spki), Buffer.from(own.subjectPublicKeyInfo)) !== 0)
        throw new ComputeError('INVALID_CONFIG', 'the CA certificate does not certify the KMS key');
    })).catch((error) => {
      checked = undefined;
      throw error;
    });

  function checkProfile(profile: CertificateProfile): { commonName: string; role?: string } {
    const uriSans = profile.uriSans ?? [];
    const dnsSans = profile.dnsSans ?? [];
    const invalid = (message: string) => new ComputeError('INVALID_INPUT', message);
    if (!Number.isInteger(profile.ttlSeconds) || profile.ttlSeconds <= 0) throw invalid('ttlSeconds must be a positive integer');
    if (profile.ttlSeconds > maxTtl) throw invalid(`${kind} certificates live at most ${maxTtl} s`);
    for (const name of dnsSans) if (name.length > 253 || !dnsPattern.test(name)) throw invalid('invalid DNS SAN');
    for (const uri of uriSans) if (!/^[a-z][a-z0-9+.-]*:[\x21-\x7e]+$/.test(uri)) throw invalid('invalid URI SAN');
    const role = profile.role;
    switch (kind) {
      case 'node': {
        if (profile.usage !== 'client') throw invalid('A node CA issues client certificates only');
        if (dnsSans.length || uriSans.length === 0 || uriSans.length > 4 || !uriSans.slice(1).every(isNodeKeyStatement))
          throw invalid('A node certificate has exactly one SPIFFE URI SAN (then only urn:bc: statements) and no DNS SANs');
        const spiffe = parseNodeSpiffeId(uriSans[0]!);
        if (!spiffe) throw invalid('The URI SAN must be spiffe://<td>/site/<site>/node/<node>');
        if (!role || !(agentCertificateRoles as readonly string[]).includes(role))
          throw invalid(`A node certificate's role is one of ${agentCertificateRoles.join(', ')}`);
        return { commonName: spiffe.nodeId, role };
      }
      case 'serving':
        if (profile.usage !== 'server') throw invalid('A serving CA issues server certificates only');
        if (dnsSans.length === 0 || uriSans.length) throw invalid('A serving certificate has DNS SANs and no URI SANs');
        if (role !== undefined && role !== 'gateway') throw invalid("A serving certificate's role is gateway");
        return { commonName: dnsSans[0]!, ...(role ? { role } : {}) };
      case 'internal': {
        if (dnsSans.length + uriSans.length === 0) throw invalid('An internal certificate needs a SAN');
        if (role !== undefined && role !== 'internal' && role !== 'gateway')
          throw invalid("An internal certificate's role is internal or gateway");
        const commonName = dnsSans[0] ?? uriSans[0]!.split('/').filter(Boolean).pop() ?? 'internal';
        return { commonName: commonName.slice(0, 64), ...(role ? { role } : {}) };
      }
    }
  }

  return {
    id: options.id,
    certificates: async () => chain.map((item) => item.slice()),

    async sign(csr, profile): Promise<IssuedCertificate> {
      const request = parseCsr(csr);
      const { commonName, role } = checkProfile(profile);
      await ensureKey();
      const now = clock.now();
      if (now > own.notAfter) throw new ComputeError('INVALID_STATE', `CA ${options.id} has expired`);
      const certificate = await buildCertificateWithSigner(
        {
          serial: randomSerial(),
          issuer: own.subject,
          subject: distinguishedName({ organization, commonName }),
          notBefore: Math.max(now - 60_000, own.notBefore),
          notAfter: Math.min(now + profile.ttlSeconds * 1000, own.notAfter),
          publicKey: request.publicKey,
          ...(own.subjectKeyId ? { authorityKeyId: own.subjectKeyId } : {}),
          usage: [profile.usage],
          ...(profile.uriSans?.length ? { uriSans: profile.uriSans } : {}),
          ...(profile.dnsSans?.length ? { dnsSans: profile.dnsSans } : {}),
          ...(role ? { role } : {}),
        },
        signer,
      );
      const parsed = parseCertificate(certificate);
      return { serial: parsed.serial, certificate, chain: chain.map((item) => item.slice()), notBefore: parsed.notBefore, notAfter: parsed.notAfter };
    },

    async revoke(serial, reason) {
      revocations.add(normalizeSerial(serial), { at: clock.now(), ...(reason !== undefined ? { reason } : {}) });
    },
  };
}

/** A PKCS#10 CSR for the KMS key, signed by KMS, for the operator's root to certify as a CA. */
export async function kmsCaCsr(
  options: AwsServiceOptions & { keyId: string; subject: { commonName: string; organization?: string } },
): Promise<Uint8Array> {
  const keyId = checkKeyId(options.keyId);
  const client = kms(options);
  const spki = await kmsPublicKey(client, keyId);
  const info = der.sequence(
    der.integer(0),
    distinguishedName({ commonName: options.subject.commonName, organization: options.subject.organization ?? 'better-compute' }),
    spki,
    der.implicit(0, new Uint8Array(0), true),
  );
  const signature = await kmsCertificateSigner(client, keyId).sign(info);
  const csr = der.sequence(info, ecdsaWithSha256(), der.bitString(signature));
  parseCsr(csr); // the signature verifies under the key it names
  return csr;
}
