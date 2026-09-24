import { randomBytes, sign, verify, X509Certificate, type KeyObject } from 'node:crypto';
import { ComputeError } from '@better-compute/core';
import {
  agentIdentityFromChain,
  createReplayCache,
  verifyCertificateChain,
  type AgentIdentity,
  type ReplayCache,
  type RevocationSet,
} from '@better-compute/pki';

// In-band authentication for the WS fallback (PLAN.md §7.1, v0.4). A TLS-inspecting proxy strips
// client certificates and re-signs the server's, so each side proves itself inside the connection:
// - the daemon sends a cert-bound proof JWT (ES256 by its node key, `x5c` = its chain, ±60 s,
//   single-use `jti`, bound to its connection nonce);
// - the gateway answers with a JWS over that nonce by its serving key (`x5c` = its serving chain),
//   which the daemon checks against the serving CA it pinned at join.

export const agentProofType = 'bc-agent-proof+jwt';
export const gatewayProofType = 'bc-gateway-proof+jwt';
const maxSkewMs = 60_000;
const maxLifetimeS = 120;

const b64url = (bytes: Uint8Array | string) => Buffer.from(bytes).toString('base64url');
const fromB64url = (text: string) => Buffer.from(text, 'base64url');

function compact(header: object, claims: object, key: KeyObject): string {
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' });
  return `${input}.${b64url(signature)}`;
}

interface Parsed {
  header: { alg?: unknown; typ?: unknown; x5c?: unknown };
  claims: Record<string, unknown>;
  input: Buffer;
  signature: Buffer;
  chain: Uint8Array[];
}

function parse(token: string, typ: string): Parsed {
  const deny = (reason: string) => new ComputeError('UNAUTHENTICATED', 'Proof rejected', undefined, { reason });
  if (typeof token !== 'string' || token.length > 16_384) throw deny('malformed');
  const parts = token.split('.');
  if (parts.length !== 3) throw deny('malformed');
  let header: Parsed['header'];
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(fromB64url(parts[0]!).toString('utf8'));
    claims = JSON.parse(fromB64url(parts[1]!).toString('utf8'));
  } catch {
    throw deny('malformed');
  }
  if (header.alg !== 'ES256' || header.typ !== typ) throw deny('wrong alg or typ');
  if (!Array.isArray(header.x5c) || !header.x5c.length || header.x5c.length > 4 || !header.x5c.every((c) => typeof c === 'string'))
    throw deny('x5c required');
  return {
    header,
    claims,
    input: Buffer.from(`${parts[0]}.${parts[1]}`),
    signature: fromB64url(parts[2]!),
    // RFC 7515 x5c: standard base64 DER, leaf first.
    chain: (header.x5c as string[]).map((der) => new Uint8Array(Buffer.from(der, 'base64'))),
  };
}

const leafKey = (der: Uint8Array): KeyObject => new X509Certificate(der).publicKey;

/** A fresh connection nonce (base64url, 32 bytes). */
export const wsNonce = (): string => b64url(randomBytes(32));

/** The daemon side (and tests): a proof JWT for one connection. */
export function signAgentProof(input: {
  key: KeyObject;
  chain: readonly Uint8Array[];
  nodeId: string;
  audience: string;
  nonce: string;
  now: number;
  jti?: string;
}): string {
  const iat = Math.floor(input.now / 1000);
  return compact(
    { alg: 'ES256', typ: agentProofType, x5c: input.chain.map((der) => Buffer.from(der).toString('base64')) },
    { sub: input.nodeId, aud: input.audience, iat, exp: iat + 60, jti: input.jti ?? b64url(randomBytes(16)), nonce: input.nonce },
    input.key,
  );
}

export interface VerifyAgentProofOptions {
  /** Node-CA trust anchors (DER). */
  roots: readonly Uint8Array[];
  /** Audiences this gateway answers to, e.g. `gw.<region>`. */
  audiences: readonly string[];
  /** The nonce the daemon sent with this connection. */
  nonce: string;
  now: number;
  jtiCache: ReplayCache;
  revocations?: RevocationSet;
  trustDomain?: string;
}

/**
 * Verifies a daemon's proof JWT: the `x5c` chain is a valid node certificate (pki
 * `agentIdentityFromChain`: node CA, not revoked, one SPIFFE identity), the JWS is by that leaf's
 * key, `sub` is its node id, `aud` is this gateway, `iat` within ±60 s, the `nonce` is this
 * connection's, and the `jti` was never seen. Throws `UNAUTHENTICATED` with a reason.
 */
export function verifyAgentProof(token: string, options: VerifyAgentProofOptions): AgentIdentity {
  const deny = (reason: string) => new ComputeError('UNAUTHENTICATED', 'Proof rejected', undefined, { reason });
  const parsed = parse(token, agentProofType);
  let identity: AgentIdentity;
  try {
    identity = agentIdentityFromChain(parsed.chain, {
      roots: options.roots,
      now: options.now,
      ...(options.revocations ? { revocations: options.revocations } : {}),
      ...(options.trustDomain ? { trustDomain: options.trustDomain } : {}),
    });
  } catch (error) {
    throw deny(String((error as { details?: { reason?: string } }).details?.reason ?? 'bad chain'));
  }
  if (!verify('sha256', parsed.input, { key: leafKey(parsed.chain[0]!), dsaEncoding: 'ieee-p1363' }, parsed.signature))
    throw deny('bad signature');
  const { sub, aud, iat, exp, jti, nonce } = parsed.claims;
  if (sub !== identity.nodeId) throw deny('sub is not the certificate node');
  if (typeof aud !== 'string' || !options.audiences.includes(aud)) throw deny('wrong audience');
  if (typeof iat !== 'number' || typeof exp !== 'number' || exp <= iat || exp - iat > maxLifetimeS) throw deny('bad lifetime');
  if (Math.abs(options.now - iat * 1000) > maxSkewMs || options.now > exp * 1000 + maxSkewMs) throw deny('stale');
  if (nonce !== options.nonce) throw deny('nonce mismatch');
  if (typeof jti !== 'string' || jti.length < 8 || jti.length > 128) throw deny('jti required');
  if (!options.jtiCache.add(`${identity.nodeId}:${jti}`, exp * 1000 + maxSkewMs, options.now)) throw deny('replayed');
  return identity;
}

/** The gateway's answer: a JWS over the daemon's nonce by the serving key. */
export function signGatewayProof(input: {
  key: KeyObject;
  chain: readonly Uint8Array[];
  gatewayId: string;
  nodeId: string;
  nonce: string;
  now: number;
}): string {
  return compact(
    { alg: 'ES256', typ: gatewayProofType, x5c: input.chain.map((der) => Buffer.from(der).toString('base64')) },
    { iss: input.gatewayId, aud: input.nodeId, nonce: input.nonce, iat: Math.floor(input.now / 1000) },
    input.key,
  );
}

/**
 * The daemon side: the gateway proof must chain to the pinned serving CA with `serverAuth`, sign
 * this connection's nonce for this node, and be fresh. Returns the gateway id.
 */
export function verifyGatewayProof(
  token: string,
  options: { servingRoots: readonly Uint8Array[]; nodeId: string; nonce: string; now: number },
): string {
  const deny = (reason: string) => new ComputeError('UNAUTHENTICATED', 'Gateway proof rejected', undefined, { reason });
  const parsed = parse(token, gatewayProofType);
  try {
    verifyCertificateChain(parsed.chain, options.servingRoots, { now: options.now, usage: 'server' });
  } catch {
    throw deny('serving chain not trusted');
  }
  if (!verify('sha256', parsed.input, { key: leafKey(parsed.chain[0]!), dsaEncoding: 'ieee-p1363' }, parsed.signature))
    throw deny('bad signature');
  const { iss, aud, nonce, iat } = parsed.claims;
  if (aud !== options.nodeId || nonce !== options.nonce) throw deny('not for this connection');
  if (typeof iat !== 'number' || Math.abs(options.now - iat * 1000) > maxSkewMs) throw deny('stale');
  if (typeof iss !== 'string') throw deny('iss required');
  return iss;
}

export { createReplayCache };
