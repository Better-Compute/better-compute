import {
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { ComputeError, systemClock, type Clock } from '@better-compute/core';
import { privateKeyPem, toPrivateKey } from './keys.js';

// Break-glass SSH (PLAN.md §13 "Interactive access"): `nodes.issueSshCert` returns a short OpenSSH
// user certificate (TTL ≤ the binding activation and ≤ 1 h) from a compute SSH CA, only after
// `compute:nodes:ssh-root` with MFA. Nodes trust the CA through `AccessSection.ssh_ca_public_keys`.
// The format is OpenSSH's PROTOCOL.certkeys (cert-v01), written and read here without dependencies.

export type SshKeyType = 'ssh-ed25519' | 'ecdsa-sha2-nistp256';
const certType: Record<SshKeyType, string> = {
  'ssh-ed25519': 'ssh-ed25519-cert-v01@openssh.com',
  'ecdsa-sha2-nistp256': 'ecdsa-sha2-nistp256-cert-v01@openssh.com',
};

// --- SSH wire encoding (RFC 4251 §5) --------------------------------------------------------------

class Writer {
  private chunks: Buffer[] = [];
  uint32(value: number): this {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(value >>> 0);
    this.chunks.push(buffer);
    return this;
  }
  uint64(value: bigint): this {
    const buffer = Buffer.alloc(8);
    buffer.writeBigUInt64BE(value);
    this.chunks.push(buffer);
    return this;
  }
  string(value: Uint8Array | string): this {
    const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
    return this.uint32(bytes.length).raw(bytes);
  }
  /** A non-negative mpint: two's complement, minimal, a leading zero when the top bit is set. */
  mpint(value: Uint8Array): this {
    let start = 0;
    while (start < value.length && value[start] === 0) start++;
    let bytes = Buffer.from(value.subarray(start));
    if (bytes.length && bytes[0]! & 0x80) bytes = Buffer.concat([Buffer.of(0), bytes]);
    return this.string(bytes);
  }
  raw(value: Uint8Array): this {
    this.chunks.push(Buffer.from(value));
    return this;
  }
  bytes(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

class Reader {
  private offset = 0;
  constructor(private readonly data: Buffer) {}
  private need(length: number) {
    if (this.offset + length > this.data.length)
      throw new ComputeError('INVALID_INPUT', 'Truncated SSH data');
  }
  uint32(): number {
    this.need(4);
    const value = this.data.readUInt32BE(this.offset);
    this.offset += 4;
    return value;
  }
  uint64(): bigint {
    this.need(8);
    const value = this.data.readBigUInt64BE(this.offset);
    this.offset += 8;
    return value;
  }
  string(): Buffer {
    const length = this.uint32();
    this.need(length);
    const value = this.data.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }
  text(): string {
    return this.string().toString('utf8');
  }
  get position(): number {
    return this.offset;
  }
  done(): boolean {
    return this.offset === this.data.length;
  }
}

function packedStrings(values: readonly string[]): Buffer {
  const writer = new Writer();
  for (const value of values) writer.string(value);
  return writer.bytes();
}

function readPackedStrings(data: Buffer): string[] {
  const reader = new Reader(data);
  const values: string[] = [];
  while (!reader.done()) values.push(reader.text());
  return values;
}

/** Name/data pairs sorted by name; `data` is a string wrapping the value (empty for flags). */
function packedOptions(options: Readonly<Record<string, string>>): Buffer {
  const writer = new Writer();
  for (const name of Object.keys(options).sort()) {
    const value = options[name]!;
    writer.string(name).string(value === '' ? Buffer.alloc(0) : new Writer().string(value).bytes());
  }
  return writer.bytes();
}

function readPackedOptions(data: Buffer): Record<string, string> {
  const reader = new Reader(data);
  const options: Record<string, string> = {};
  while (!reader.done()) {
    const name = reader.text();
    const value = reader.string();
    options[name] = value.length ? new Reader(value).text() : '';
  }
  return options;
}

// --- Keys ---------------------------------------------------------------------------------------

/** The SSH public key blob (`ssh-ed25519` or `ecdsa-sha2-nistp256`) of a node key. */
export function sshPublicKeyBlob(key: KeyObject): {
  type: SshKeyType;
  blob: Buffer;
  fields: Buffer;
} {
  const publicKey = key.type === 'private' ? createPublicKey(key) : key;
  const jwk = publicKey.export({ format: 'jwk' });
  if (publicKey.asymmetricKeyType === 'ed25519') {
    const fields = new Writer().string(Buffer.from(jwk.x!, 'base64url')).bytes();
    return {
      type: 'ssh-ed25519',
      blob: new Writer().string('ssh-ed25519').raw(fields).bytes(),
      fields,
    };
  }
  if (
    publicKey.asymmetricKeyType === 'ec' &&
    publicKey.asymmetricKeyDetails?.namedCurve === 'prime256v1'
  ) {
    const point = Buffer.concat([
      Buffer.of(4),
      Buffer.from(jwk.x!, 'base64url'),
      Buffer.from(jwk.y!, 'base64url'),
    ]);
    const fields = new Writer().string('nistp256').string(point).bytes();
    return {
      type: 'ecdsa-sha2-nistp256',
      blob: new Writer().string('ecdsa-sha2-nistp256').raw(fields).bytes(),
      fields,
    };
  }
  throw new ComputeError('INVALID_INPUT', 'SSH keys here are Ed25519 or ECDSA P-256');
}

/** `ssh-ed25519 AAAA… comment` for a public key. */
export function formatSshPublicKey(key: KeyObject, comment = ''): string {
  const { type, blob } = sshPublicKeyBlob(key);
  return `${type} ${blob.toString('base64')}${comment ? ` ${comment}` : ''}`;
}

function keyFromBlob(type: string, reader: Reader): KeyObject {
  if (type === 'ssh-ed25519') {
    const raw = reader.string();
    if (raw.length !== 32) throw new ComputeError('INVALID_INPUT', 'Bad Ed25519 key');
    return createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') },
      format: 'jwk',
    });
  }
  if (type === 'ecdsa-sha2-nistp256') {
    if (reader.text() !== 'nistp256') throw new ComputeError('INVALID_INPUT', 'Bad ECDSA curve');
    const point = reader.string();
    if (point.length !== 65 || point[0] !== 4)
      throw new ComputeError('INVALID_INPUT', 'Bad ECDSA point');
    return createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: point.subarray(1, 33).toString('base64url'),
        y: point.subarray(33).toString('base64url'),
      },
      format: 'jwk',
    });
  }
  throw new ComputeError('INVALID_INPUT', `Unsupported SSH key type ${type}`);
}

/** Parses an OpenSSH public key line (`ssh-ed25519 AAAA… comment`). */
export function parseSshPublicKey(line: string): KeyObject {
  const [type, data] = line.trim().split(/\s+/);
  if (!type || !data) throw new ComputeError('INVALID_INPUT', 'Not an OpenSSH public key line');
  const reader = new Reader(Buffer.from(data, 'base64'));
  if (reader.text() !== type) throw new ComputeError('INVALID_INPUT', 'Key type mismatch');
  const key = keyFromBlob(type, reader);
  if (!reader.done()) throw new ComputeError('INVALID_INPUT', 'Trailing key data');
  return key;
}

function sshSign(caKey: KeyObject, data: Buffer): Buffer {
  if (caKey.asymmetricKeyType === 'ed25519')
    return new Writer()
      .string('ssh-ed25519')
      .string(sign(null, data, caKey))
      .bytes();
  const raw = sign('sha256', data, { key: caKey, dsaEncoding: 'ieee-p1363' });
  const inner = new Writer().mpint(raw.subarray(0, 32)).mpint(raw.subarray(32)).bytes();
  return new Writer().string('ecdsa-sha2-nistp256').string(inner).bytes();
}

function sshVerify(caKey: KeyObject, data: Buffer, signature: Buffer): boolean {
  const reader = new Reader(signature);
  const type = reader.text();
  const body = reader.string();
  if (!reader.done()) return false;
  if (type === 'ssh-ed25519' && caKey.asymmetricKeyType === 'ed25519')
    return body.length === 64 && verify(null, data, caKey, body);
  if (type === 'ecdsa-sha2-nistp256' && caKey.asymmetricKeyType === 'ec') {
    const inner = new Reader(body);
    const pad = (value: Buffer) => {
      const trimmed = value[0] === 0 ? value.subarray(1) : value;
      if (trimmed.length > 32) throw new ComputeError('INVALID_INPUT', 'Bad ECDSA signature');
      return Buffer.concat([Buffer.alloc(32 - trimmed.length), trimmed]);
    };
    const raw = Buffer.concat([pad(inner.string()), pad(inner.string())]);
    return inner.done() && verify('sha256', data, { key: caKey, dsaEncoding: 'ieee-p1363' }, raw);
  }
  return false;
}

// --- Certificates -------------------------------------------------------------------------------

export interface SshUserCertificateInput {
  /** The user's OpenSSH public key line (Ed25519 or ECDSA P-256). */
  publicKey: string;
  /** Unix accounts the certificate may log in as; never empty (an empty list means "any"). */
  principals: readonly string[];
  /** Recorded by sshd in its log: the identity and activation it was issued for. */
  keyId: string;
  /** Epoch milliseconds; must be ≤ the binding activation's expiry and ≤ 1 h away. */
  validBefore: number;
  /** Default: `permit-pty` only (no agent, port or X11 forwarding). */
  extensions?: Readonly<Record<string, string>>;
  /** e.g. `{ 'source-address': '10.0.0.0/8' }`. */
  criticalOptions?: Readonly<Record<string, string>>;
}

export interface SshCertificate {
  type: string;
  keyType: SshKeyType;
  nonce: Buffer;
  publicKey: KeyObject;
  serial: bigint;
  certType: 'user' | 'host';
  keyId: string;
  principals: string[];
  /** Epoch milliseconds. */
  validAfter: number;
  validBefore: number;
  criticalOptions: Record<string, string>;
  extensions: Record<string, string>;
  signatureKey: KeyObject;
  /** Whether the signature verifies under `signatureKey` (check that key is a trusted CA separately). */
  signatureValid: boolean;
}

/** Parses an OpenSSH certificate line and checks its signature under the embedded CA key. */
export function parseSshCertificate(line: string): SshCertificate {
  const [type, data] = line.trim().split(/\s+/);
  const keyType = (Object.keys(certType) as SshKeyType[]).find((key) => certType[key] === type);
  if (!type || !data || !keyType)
    throw new ComputeError('INVALID_INPUT', 'Not an OpenSSH certificate line');
  const bytes = Buffer.from(data, 'base64');
  const reader = new Reader(bytes);
  if (reader.text() !== type) throw new ComputeError('INVALID_INPUT', 'Certificate type mismatch');
  const nonce = reader.string();
  const publicKey = keyFromBlob(keyType, reader);
  const serial = reader.uint64();
  const kind = reader.uint32();
  const keyId = reader.text();
  const principals = readPackedStrings(reader.string());
  const validAfter = reader.uint64();
  const validBefore = reader.uint64();
  const criticalOptions = readPackedOptions(reader.string());
  const extensions = readPackedOptions(reader.string());
  reader.string(); // reserved
  const caBlob = new Reader(reader.string());
  const caType = caBlob.text();
  const signatureKey = keyFromBlob(caType, caBlob);
  const signed = bytes.subarray(0, reader.position);
  const signature = reader.string();
  if (!reader.done()) throw new ComputeError('INVALID_INPUT', 'Trailing certificate data');
  const seconds = (value: bigint) =>
    value > 0xffffffffffffn ? Number.MAX_SAFE_INTEGER : Number(value) * 1000;
  return {
    type,
    keyType,
    nonce,
    publicKey,
    serial,
    certType: kind === 1 ? 'user' : 'host',
    keyId,
    principals,
    validAfter: seconds(validAfter),
    validBefore: seconds(validBefore),
    criticalOptions,
    extensions,
    signatureKey,
    signatureValid: (() => {
      try {
        return sshVerify(signatureKey, signed, signature);
      } catch {
        return false;
      }
    })(),
  };
}

export interface SshHostCertificateInput {
  /** The host's own OpenSSH public key line (its sshd host key). */
  publicKey: string;
  /** The names clients reach it by (`HostKeyAlias`, a host name): letters, digits, `.`, `_`, `-`. */
  principals: readonly string[];
  keyId: string;
  /** Epoch ms; at most the CA's `maxHostTtlSeconds` ahead (default 30 days). */
  validBefore: number;
}

export interface SshCertificateAuthority {
  /** `AccessSection.ssh_ca_public_keys` entry (OpenSSH public key line). */
  readonly publicKey: string;
  issueUserCertificate(input: SshUserCertificateInput): {
    certificate: string;
    serial: bigint;
    validBefore: number;
  };
  /**
   * An OpenSSH host certificate (`HostCertificate` in sshd_config): clients that trust this CA as
   * `@cert-authority <principal> <key>` in known_hosts accept the host without trust on first use.
   */
  issueHostCertificate(input: SshHostCertificateInput): {
    certificate: string;
    serial: bigint;
    validBefore: number;
  };
  export(): { privateKeyPem: string };
}

const hostPrincipalPattern = /^[A-Za-z0-9._-]{1,253}$/;

// A Unix account, optionally bound to one host (`root@node_…`, what break-glass certificates use so
// a certificate opens only the node it names). No commas or whitespace: sshd splits on them.
const principalPattern = /^[a-z_][a-z0-9_-]{0,31}(@[A-Za-z0-9._-]{1,128})?$/;

/**
 * The compute SSH CA for break-glass access (§13). Ed25519 by default; ECDSA P-256 for FIPS-style
 * deployments. Certificates are user certificates only, valid from 1 minute ago (skew) to at most
 * 1 hour ahead, with explicit principals and only `permit-pty` unless told otherwise.
 */
export function createSshCertificateAuthority(
  options: {
    algorithm?: 'ed25519' | 'ecdsa-p256';
    clock?: Clock;
    privateKey?: KeyObject | Uint8Array | string;
    comment?: string;
    /** Longest certificate lifetime (default and maximum 1 hour). */
    maxTtlSeconds?: number;
    /** Longest host certificate lifetime (default and maximum 30 days: a host key lives as long as its machine). */
    maxHostTtlSeconds?: number;
  } = {},
): SshCertificateAuthority {
  const clock = options.clock ?? systemClock;
  // The public key line goes into every node's sshd TrustedUserCAKeys: a comment with a line break would add a CA.
  if (options.comment !== undefined && !/^([\x21-\x7e][\x20-\x7e]{0,63})?$/.test(options.comment))
    throw new ComputeError('INVALID_CONFIG', 'The SSH CA comment must be printable ASCII, one line, at most 64 characters');
  const caKey = options.privateKey
    ? toPrivateKey(options.privateKey)
    : options.algorithm === 'ecdsa-p256'
      ? generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey
      : generateKeyPairSync('ed25519').privateKey;
  const caPublic = createPublicKey(caKey);
  const { blob: caBlob } = sshPublicKeyBlob(caPublic);
  const maxTtlMs = Math.min(options.maxTtlSeconds ?? 3600, 3600) * 1000;
  const maxHostTtlMs = Math.min(options.maxHostTtlSeconds ?? 30 * 86_400, 30 * 86_400) * 1000;
  let lastSerial = 0n;
  /** Signs a user (1) or host (2) certificate after the common checks. */
  const sign = (
    kind: 1 | 2,
    input: { publicKey: string; principals: readonly string[]; keyId: string; validBefore: number },
    maxMs: number,
    what: string,
    options: { criticalOptions: Record<string, string>; extensions: Record<string, string> },
  ) => {
    if (!input.principals.length)
      throw new ComputeError('INVALID_INPUT', 'A certificate names at least one principal');
    if (!input.keyId || input.keyId.length > 256 || /[\r\n]/.test(input.keyId))
      throw new ComputeError('INVALID_INPUT', 'keyId must be 1 to 256 characters on one line');
    const now = clock.now();
    if (!(input.validBefore > now)) throw new ComputeError('INVALID_INPUT', 'validBefore is in the past');
    if (input.validBefore - now > maxMs)
      throw new ComputeError('INVALID_INPUT', `${what} live at most ${Math.round(maxMs / 60_000)} minutes`);
    const subjectKey = parseSshPublicKey(input.publicKey);
    const { type: subjectType, fields } = sshPublicKeyBlob(subjectKey);
    // Serials only grow: microseconds since the epoch, bumped past the last one issued.
    let serial = BigInt(now) * 1000n;
    if (serial <= lastSerial) serial = lastSerial + 1n;
    lastSerial = serial;
    const validAfter = BigInt(Math.floor((now - 60_000) / 1000));
    const validBefore = BigInt(Math.floor(input.validBefore / 1000));
    const body = new Writer()
      .string(certType[subjectType])
      .string(randomBytes(32))
      .raw(fields)
      .uint64(serial)
      .uint32(kind)
      .string(input.keyId)
      .string(packedStrings(input.principals))
      .uint64(validAfter)
      .uint64(validBefore)
      .string(packedOptions(options.criticalOptions))
      .string(packedOptions(options.extensions))
      .string('')
      .string(caBlob)
      .bytes();
    const certificate = Buffer.concat([body, new Writer().string(sshSign(caKey, body)).bytes()]);
    return {
      certificate: `${certType[subjectType]} ${certificate.toString('base64')} ${input.keyId}`,
      serial,
      validBefore: Number(validBefore) * 1000,
    };
  };
  return {
    publicKey: formatSshPublicKey(caPublic, options.comment ?? 'better-compute-ssh-ca'),
    issueUserCertificate(input) {
      for (const principal of input.principals)
        if (!principalPattern.test(principal))
          throw new ComputeError('INVALID_INPUT', `Invalid principal ${JSON.stringify(principal)}`);
      return sign(1, input, maxTtlMs, 'Break-glass certificates', {
        criticalOptions: input.criticalOptions ?? {},
        extensions: input.extensions ?? { 'permit-pty': '' },
      });
    },
    issueHostCertificate(input) {
      for (const principal of input.principals)
        if (!hostPrincipalPattern.test(principal))
          throw new ComputeError('INVALID_INPUT', `Invalid host principal ${JSON.stringify(principal)}`);
      // Host certificates carry no options or extensions (OpenSSH defines none for them).
      return sign(2, input, maxHostTtlMs, 'Host certificates', { criticalOptions: {}, extensions: {} });
    },
    export: () => ({ privateKeyPem: privateKeyPem(caKey) }),
  };
}
