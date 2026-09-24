import { X509Certificate } from 'node:crypto';
import { ComputeError } from '@better-compute/core';
import {
  base64url,
  buildCertificate,
  distinguishedName,
  fromBase64url,
  fromPem,
  generateP256KeyPair,
  privateKeyPem,
  randomBytesArray,
  timingSafeEqualBytes,
  toPem,
} from '@better-compute/pki';

// The go-plugin style handshake (PLAN.md §5.5): the host execs the plugin with a magic cookie, a
// socket directory and its client certificate; the plugin listens and prints one line
// `bcx|1|<network>|<address>|grpc|<base64url DER server certificate>` on stdout. Both certificates
// are ephemeral, self-signed P-256, and pinned byte for byte by the other side (auto-mTLS).

/** Env var carrying the magic cookie. Not a secret: it only stops plugins being run by hand. */
export const BCX_MAGIC_COOKIE_KEY = 'BCX_MAGIC_COOKIE';
export const BCX_MAGIC_COOKIE_VALUE =
  '3f8e1c5a0b7d4e29a6c1f0d8b2e7a45c9d3b6f1e0a8c7d2b5e4f9a1c6b0d3e7f';
/** Env var naming the directory the plugin creates its unix socket in. */
export const BCX_SOCKET_DIR = 'BCX_SOCKET_DIR';
/** Env var carrying the host's ephemeral client certificate (PEM). */
export const BCX_CLIENT_CERT = 'BCX_CLIENT_CERT';
/** The bcx protocol version in the handshake line and `DescribeResponse.protocol_version`. */
export const BCX_PROTOCOL_VERSION = 1;

export type BcxNetwork = 'unix' | 'tcp';

/** The parsed handshake line. */
export interface Handshake {
  protocolVersion: number;
  network: BcxNetwork;
  /** A socket path (`unix`) or `127.0.0.1:<port>` (`tcp`). */
  address: string;
  /** The plugin's server certificate, DER. */
  certificate: Uint8Array;
}

export function formatHandshake(handshake: Handshake): string {
  return [
    'bcx',
    String(handshake.protocolVersion),
    handshake.network,
    handshake.address,
    'grpc',
    base64url(handshake.certificate),
  ].join('|');
}

/**
 * Parses a handshake line. The address is everything between the network and `grpc`, so a socket
 * path may contain `|`. Throws `INVALID_INPUT` on anything else, including another protocol version.
 */
export function parseHandshake(line: string): Handshake {
  const fields = line.trim().split('|');
  const invalid = (reason: string) =>
    new ComputeError('INVALID_INPUT', `Invalid bcx handshake: ${reason}`);
  if (fields.length < 6 || fields[0] !== 'bcx') throw invalid('expected bcx|1|<network>|…');
  const protocolVersion = Number(fields[1]);
  if (protocolVersion !== BCX_PROTOCOL_VERSION)
    throw invalid(`unsupported protocol version ${fields[1]}`);
  const network = fields[2];
  if (network !== 'unix' && network !== 'tcp') throw invalid(`unknown network ${network}`);
  if (fields[fields.length - 2] !== 'grpc') throw invalid('only the grpc protocol is supported');
  const address = fields.slice(3, -2).join('|');
  if (!address) throw invalid('missing address');
  if (network === 'tcp' && !/^[^:]+:\d{1,5}$/.test(address))
    throw invalid(`tcp address ${address} is not host:port`);
  let certificate: Uint8Array;
  try {
    certificate = fromBase64url(fields[fields.length - 1]!);
    new X509Certificate(certificate);
  } catch {
    throw invalid('the server certificate is not base64url DER');
  }
  return { protocolVersion, network, address, certificate };
}

/** An ephemeral TLS identity: PEM key and certificate, plus the certificate's DER. */
export interface EphemeralIdentity {
  keyPem: string;
  certificatePem: string;
  certificate: Uint8Array;
}

const minute = 60_000;
const tenYears = 10 * 365 * 24 * 60 * minute;

/**
 * A fresh self-signed P-256 certificate for one side of the handshake. Like go-plugin's, it is a CA
 * certificate (so OpenSSL accepts it as its own trust anchor) with both server and client usage and
 * the DNS name `localhost`; peers pin it exactly rather than trusting what it could sign.
 */
export function createEphemeralIdentity(commonName: string, now = Date.now()): EphemeralIdentity {
  const keys = generateP256KeyPair();
  const serial = randomBytesArray(16);
  // Positive, with a non-zero leading byte (minimal DER INTEGER).
  serial[0] = (serial[0]! & 0x7f) | 0x01;
  const name = distinguishedName({ organization: 'bcx', commonName });
  const certificate = buildCertificate(
    {
      serial,
      issuer: name,
      subject: name,
      notBefore: now - minute,
      notAfter: now + tenYears,
      publicKey: keys.publicKey,
      ca: {},
      usage: ['server', 'client'],
      dnsSans: ['localhost'],
    },
    keys.privateKey,
  );
  return {
    keyPem: privateKeyPem(keys.privateKey),
    certificatePem: toPem(certificate),
    certificate,
  };
}

/** The single certificate of a PEM text, as DER; `INVALID_INPUT` unless there is exactly one. */
export function certificateFromPem(pem: string): Uint8Array {
  const blocks = fromPem(pem);
  if (blocks.length !== 1)
    throw new ComputeError('INVALID_INPUT', 'Expected exactly one PEM certificate');
  return blocks[0]!;
}

/** Whether `presented` is exactly the pinned certificate. */
export function matchesCertificate(presented: Uint8Array | undefined, pinned: Uint8Array): boolean {
  return presented !== undefined && timingSafeEqualBytes(new Uint8Array(presented), pinned);
}
