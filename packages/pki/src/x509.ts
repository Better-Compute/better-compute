import { createHash, createPublicKey, KeyObject, sign, verify } from 'node:crypto';
import { ComputeError } from '@better-compute/core';
import {
  children,
  compareBytes,
  decodeBitString,
  decodeBoolean,
  decodeInteger,
  decodeNamedBits,
  decodeOid,
  decodeString,
  decodeTime,
  der,
  expectTag,
  parseDer,
  Tag,
  type DerNode,
} from './der.js';
import { roleExtensionOid, spkiDer } from './keys.js';

export const oids = {
  ecPublicKey: '1.2.840.10045.2.1',
  prime256v1: '1.2.840.10045.3.1.7',
  ecdsaWithSha256: '1.2.840.10045.4.3.2',
  commonName: '2.5.4.3',
  organization: '2.5.4.10',
  organizationalUnit: '2.5.4.11',
  subjectKeyIdentifier: '2.5.29.14',
  keyUsage: '2.5.29.15',
  subjectAltName: '2.5.29.17',
  basicConstraints: '2.5.29.19',
  authorityKeyIdentifier: '2.5.29.35',
  extKeyUsage: '2.5.29.37',
  serverAuth: '1.3.6.1.5.5.7.3.1',
  clientAuth: '1.3.6.1.5.5.7.3.2',
  extensionRequest: '1.2.840.113549.1.9.14',
} as const;

/** KeyUsage bit positions (RFC 5280 §4.2.1.3). */
export const keyUsageBits = { digitalSignature: 0, keyCertSign: 5, cRLSign: 6 } as const;

/** Extensions this package understands; any other critical extension fails verification. */
const understood: ReadonlySet<string> = new Set([
  oids.basicConstraints,
  oids.keyUsage,
  oids.extKeyUsage,
  oids.subjectAltName,
  oids.subjectKeyIdentifier,
  oids.authorityKeyIdentifier,
  roleExtensionOid,
]);

export const ecdsaWithSha256 = (): Uint8Array => der.sequence(der.oid(oids.ecdsaWithSha256));

export interface NameInput {
  commonName?: string;
  organization?: string;
  organizationalUnit?: string;
}

/** A DER `Name` (RDNSequence) with one attribute per RDN, O then OU then CN. */
export function distinguishedName(name: NameInput): Uint8Array {
  const rdns: Uint8Array[] = [];
  const add = (oid: string, value: string | undefined) => {
    if (value === undefined) return;
    if (value.length === 0 || value.length > 64)
      throw new ComputeError('INVALID_INPUT', 'Name attributes must be 1 to 64 characters');
    rdns.push(der.set(der.sequence(der.oid(oid), der.utf8(value))));
  };
  add(oids.organization, name.organization);
  add(oids.organizationalUnit, name.organizationalUnit);
  add(oids.commonName, name.commonName);
  return der.sequence(...rdns);
}

/** RFC 5280 §4.2.1.2 method 1: SHA-1 of the subjectPublicKey BIT STRING contents. */
export function subjectKeyId(publicKey: KeyObject | Uint8Array): Uint8Array {
  const spki = publicKey instanceof KeyObject ? spkiDer(publicKey) : publicKey;
  const [, bits] = children(parseDer(spki));
  return new Uint8Array(createHash('sha1').update(decodeBitString(bits!)).digest());
}

export type ExtendedKeyUsage = 'client' | 'server';

export interface CertificateTemplate {
  /** Big-endian magnitude; positive, at most 20 bytes. */
  serial: Uint8Array;
  issuer: Uint8Array;
  subject: Uint8Array;
  notBefore: number;
  notAfter: number;
  publicKey: KeyObject;
  /** The issuer's subject key id (omitted for self-signed roots). */
  authorityKeyId?: Uint8Array;
  /** A CA certificate; `pathLength` bounds the CAs below it. */
  ca?: { pathLength?: number };
  usage?: readonly ExtendedKeyUsage[];
  /** Further extended key usages by OID (the command-signing usage). */
  extKeyUsageOids?: readonly string[];
  uriSans?: readonly string[];
  dnsSans?: readonly string[];
  /** The role extension (`node`, `site`, `ramdisk`, `gateway`, `internal`, …). */
  role?: string;
}

function extension(oid: string, critical: boolean, value: Uint8Array): Uint8Array {
  return critical
    ? der.sequence(der.oid(oid), der.boolean(true), der.octetString(value))
    : der.sequence(der.oid(oid), der.octetString(value));
}

/** Builds and signs an X.509 v3 certificate with ECDSA P-256 / SHA-256. */
export function buildCertificate(template: CertificateTemplate, signer: KeyObject): Uint8Array {
  if (template.serial.length === 0 || template.serial.length > 20 || template.serial[0]! & 0x80)
    throw new ComputeError('INVALID_INPUT', 'Serial must be 1 to 20 bytes and positive');
  if (!(template.notAfter > template.notBefore))
    throw new ComputeError('INVALID_INPUT', 'notAfter must be after notBefore');
  const publicKeyInfo = spkiDer(template.publicKey);
  const extensions: Uint8Array[] = [];
  const emptySubject = children(parseDer(template.subject)).length === 0;
  if (template.ca) {
    const constraints =
      template.ca.pathLength === undefined
        ? der.sequence(der.boolean(true))
        : der.sequence(der.boolean(true), der.integer(template.ca.pathLength));
    extensions.push(extension(oids.basicConstraints, true, constraints));
    extensions.push(
      extension(
        oids.keyUsage,
        true,
        der.namedBits([
          keyUsageBits.digitalSignature,
          keyUsageBits.keyCertSign,
          keyUsageBits.cRLSign,
        ]),
      ),
    );
  } else {
    extensions.push(extension(oids.basicConstraints, true, der.sequence()));
    extensions.push(extension(oids.keyUsage, true, der.namedBits([keyUsageBits.digitalSignature])));
  }
  const ekus = [
    ...(template.usage ?? []).map((usage) =>
      usage === 'server' ? oids.serverAuth : oids.clientAuth,
    ),
    ...(template.extKeyUsageOids ?? []),
  ];
  if (ekus.length)
    extensions.push(
      extension(oids.extKeyUsage, false, der.sequence(...ekus.map((oid) => der.oid(oid)))),
    );
  const names = [
    ...(template.dnsSans ?? []).map((name) => der.implicit(2, parseDer(der.ia5(name)).value)),
    ...(template.uriSans ?? []).map((uri) => der.implicit(6, parseDer(der.ia5(uri)).value)),
  ];
  if (names.length)
    // RFC 5280 §4.2.1.6: critical when the subject is empty.
    extensions.push(extension(oids.subjectAltName, emptySubject, der.sequence(...names)));
  else if (emptySubject)
    throw new ComputeError('INVALID_INPUT', 'A certificate needs a subject or a SAN');
  extensions.push(
    extension(oids.subjectKeyIdentifier, false, der.octetString(subjectKeyId(publicKeyInfo))),
  );
  if (template.authorityKeyId)
    extensions.push(
      extension(
        oids.authorityKeyIdentifier,
        false,
        der.sequence(der.implicit(0, template.authorityKeyId)),
      ),
    );
  if (template.role !== undefined)
    extensions.push(extension(roleExtensionOid, false, der.utf8(template.role)));
  const tbs = der.sequence(
    der.explicit(0, der.integer(2)),
    der.integer(template.serial),
    ecdsaWithSha256(),
    template.issuer,
    der.sequence(der.time(template.notBefore), der.time(template.notAfter)),
    template.subject,
    publicKeyInfo,
    der.explicit(3, der.sequence(...extensions)),
  );
  const signature = sign('sha256', tbs, { key: signer, dsaEncoding: 'der' });
  return der.sequence(tbs, ecdsaWithSha256(), der.bitString(new Uint8Array(signature)));
}

export interface CertificateExtension {
  critical: boolean;
  value: Uint8Array;
}

export interface ParsedCertificate {
  der: Uint8Array;
  /** The signed TBSCertificate bytes. */
  tbs: Uint8Array;
  /** Lower-case hex without leading zeros (`node_certs.serial`). */
  serial: string;
  signatureAlgorithm: string;
  signature: Uint8Array;
  /** DER `Name`s, compared bytewise when chaining. */
  issuer: Uint8Array;
  subject: Uint8Array;
  subjectCommonName?: string;
  notBefore: number;
  notAfter: number;
  subjectPublicKeyInfo: Uint8Array;
  publicKey: KeyObject;
  extensions: ReadonlyMap<string, CertificateExtension>;
  isCa: boolean;
  pathLength?: number;
  keyUsage?: number[];
  extKeyUsage: string[];
  uriSans: string[];
  dnsSans: string[];
  role?: string;
  subjectKeyId?: Uint8Array;
  authorityKeyId?: Uint8Array;
}

function malformed(what: string): ComputeError {
  return new ComputeError('INVALID_INPUT', `Malformed certificate: ${what}`);
}

function commonNameOf(name: DerNode): string | undefined {
  for (const rdn of children(name))
    for (const attribute of children(rdn)) {
      const [type, value] = children(attribute);
      if (type && value && decodeOid(type) === oids.commonName) return decodeString(value);
    }
  return undefined;
}

/** Parses a DER X.509 v3 certificate (structure only; see `verifyCertificateChain`). */
export function parseCertificate(input: Uint8Array): ParsedCertificate {
  const bytes = input.slice();
  const [tbsNode, algNode, sigNode, extra] = children(
    expectTag(parseDer(bytes), Tag.sequence, 'certificate'),
  );
  if (!tbsNode || !algNode || !sigNode || extra) throw malformed('expected three fields');
  const fields = children(expectTag(tbsNode, Tag.sequence, 'tbsCertificate'));
  let index = 0;
  const version = fields[index]?.tag === 0xa0 ? decodeInteger(children(fields[index++]!)[0]!) : 0n;
  if (version !== 2n) throw malformed('only v3 certificates are supported');
  const serial = decodeInteger(fields[index++]!);
  const innerAlg = expectTag(fields[index++], Tag.sequence, 'signature');
  const issuer = expectTag(fields[index++], Tag.sequence, 'issuer');
  const validity = children(expectTag(fields[index++], Tag.sequence, 'validity'));
  const subject = expectTag(fields[index++], Tag.sequence, 'subject');
  const spki = expectTag(fields[index++], Tag.sequence, 'subjectPublicKeyInfo');
  while (fields[index] && (fields[index]!.tag === 0x81 || fields[index]!.tag === 0x82)) index++;
  const extensionsNode = fields[index]?.tag === 0xa3 ? fields[index++] : undefined;
  if (index !== fields.length) throw malformed('unexpected fields');
  if (compareBytes(innerAlg.bytes, algNode.bytes) !== 0) throw malformed('algorithm mismatch');
  const signatureAlgorithm = decodeOid(children(algNode)[0]!);

  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey({ key: Buffer.from(spki.bytes), format: 'der', type: 'spki' });
  } catch {
    throw malformed('unreadable public key');
  }

  const extensions = new Map<string, CertificateExtension>();
  const parsed: ParsedCertificate = {
    der: bytes,
    tbs: tbsNode.bytes,
    serial: serial.toString(16),
    signatureAlgorithm,
    signature: decodeBitString(sigNode),
    issuer: issuer.bytes,
    subject: subject.bytes,
    notBefore: decodeTime(validity[0]!),
    notAfter: decodeTime(validity[1]!),
    subjectPublicKeyInfo: spki.bytes,
    publicKey,
    extensions,
    isCa: false,
    extKeyUsage: [],
    uriSans: [],
    dnsSans: [],
  };
  const cn = commonNameOf(subject);
  if (cn !== undefined) parsed.subjectCommonName = cn;
  if (extensionsNode) {
    for (const node of children(
      expectTag(children(extensionsNode)[0], Tag.sequence, 'extensions'),
    )) {
      const parts = children(node);
      const oid = decodeOid(parts[0]!);
      const critical = parts.length === 3 ? decodeBoolean(parts[1]!) : false;
      const value = expectTag(parts[parts.length - 1], Tag.octetString, 'extension value').value;
      if (extensions.has(oid)) throw malformed(`duplicate extension ${oid}`);
      extensions.set(oid, { critical, value });
      const inner = () => parseDer(value);
      switch (oid) {
        case oids.basicConstraints: {
          const items = children(inner());
          if (items[0]?.tag === Tag.boolean) parsed.isCa = decodeBoolean(items[0]);
          const length = items.find((item) => item.tag === Tag.integer);
          if (length) parsed.pathLength = Number(decodeInteger(length));
          break;
        }
        case oids.keyUsage:
          parsed.keyUsage = decodeNamedBits(inner());
          break;
        case oids.extKeyUsage:
          parsed.extKeyUsage = children(inner()).map(decodeOid);
          break;
        case oids.subjectAltName:
          for (const name of children(inner())) {
            if (name.tag === 0x86) parsed.uriSans.push(decodeString(name));
            else if (name.tag === 0x82) parsed.dnsSans.push(decodeString(name));
          }
          break;
        case oids.subjectKeyIdentifier:
          parsed.subjectKeyId = expectTag(inner(), Tag.octetString, 'subject key id').value.slice();
          break;
        case oids.authorityKeyIdentifier: {
          const keyId = children(inner()).find((item) => item.tag === 0x80);
          if (keyId) parsed.authorityKeyId = keyId.value.slice();
          break;
        }
        case roleExtensionOid:
          parsed.role = decodeString(inner());
          break;
      }
    }
  }
  return parsed;
}

/** Whether `issuer`'s key signed `certificate` (ECDSA P-256 / SHA-256 only). */
export function verifyCertificateSignature(
  certificate: ParsedCertificate,
  issuerKey: KeyObject,
): boolean {
  if (certificate.signatureAlgorithm !== oids.ecdsaWithSha256) return false;
  try {
    return verify(
      'sha256',
      certificate.tbs,
      { key: issuerKey, dsaEncoding: 'der' },
      certificate.signature,
    );
  } catch {
    return false;
  }
}

export interface ChainOptions {
  /** Epoch milliseconds to check validity at. */
  now: number;
  /** The leaf must allow this extended key usage. */
  usage?: ExtendedKeyUsage;
  /** Maximum certificates from leaf to anchor, anchor excluded (default 4). */
  maxDepth?: number;
}

/**
 * Verifies `chain` (leaf first, DER) up to one of `roots` (trust anchors, DER). Checks signatures,
 * validity at `now`, CA flags, path lengths, key usage, the leaf's extended key usage, and that no
 * certificate carries a critical extension this package does not understand. Returns the parsed
 * path, leaf first, anchor last. Throws `ACCESS_DENIED` with a reason in `details`.
 */
export function verifyCertificateChain(
  chain: readonly Uint8Array[],
  roots: readonly Uint8Array[],
  options: ChainOptions,
): ParsedCertificate[] {
  const deny = (reason: string) =>
    new ComputeError('ACCESS_DENIED', 'Certificate chain rejected', undefined, { reason });
  if (chain.length === 0) throw deny('empty chain');
  const maxDepth = options.maxDepth ?? 4;
  let parsedChain: ParsedCertificate[];
  let anchors: ParsedCertificate[];
  try {
    parsedChain = chain.map(parseCertificate);
    anchors = roots.map(parseCertificate);
  } catch {
    throw deny('malformed certificate');
  }
  const checkCommon = (cert: ParsedCertificate) => {
    if (options.now < cert.notBefore) throw deny(`certificate ${cert.serial} is not yet valid`);
    if (options.now > cert.notAfter) throw deny(`certificate ${cert.serial} has expired`);
    for (const [oid, ext] of cert.extensions)
      if (ext.critical && !understood.has(oid)) throw deny(`unknown critical extension ${oid}`);
  };
  const leaf = parsedChain[0]!;
  checkCommon(leaf);
  if (leaf.isCa) throw deny('the leaf is a CA');
  if (leaf.keyUsage && !leaf.keyUsage.includes(keyUsageBits.digitalSignature))
    throw deny('the leaf may not sign');
  if (options.usage) {
    const wanted = options.usage === 'server' ? oids.serverAuth : oids.clientAuth;
    if (!leaf.extKeyUsage.includes(wanted)) throw deny(`the leaf lacks ${options.usage}Auth`);
  }
  const path: ParsedCertificate[] = [leaf];
  let current = leaf;
  for (let depth = 0; depth <= maxDepth; depth++) {
    const anchor = anchors.find(
      (candidate) =>
        compareBytes(candidate.subject, current.issuer) === 0 &&
        verifyCertificateSignature(current, candidate.publicKey),
    );
    if (anchor) {
      checkCommon(anchor);
      if (!anchor.isCa) throw deny('the trust anchor is not a CA');
      if (anchor.pathLength !== undefined && path.length - 1 > anchor.pathLength)
        throw deny('path length exceeded');
      path.push(anchor);
      return path;
    }
    const issuer = parsedChain[depth + 1];
    if (!issuer) throw deny('the chain does not reach a trusted root');
    if (compareBytes(issuer.subject, current.issuer) !== 0) throw deny('issuer name mismatch');
    if (!verifyCertificateSignature(current, issuer.publicKey)) throw deny('bad signature');
    checkCommon(issuer);
    if (!issuer.isCa) throw deny(`certificate ${issuer.serial} is not a CA`);
    if (issuer.keyUsage && !issuer.keyUsage.includes(keyUsageBits.keyCertSign))
      throw deny(`certificate ${issuer.serial} may not sign certificates`);
    if (issuer.pathLength !== undefined && path.length - 1 > issuer.pathLength)
      throw deny('path length exceeded');
    path.push(issuer);
    current = issuer;
  }
  throw deny('chain too long');
}
