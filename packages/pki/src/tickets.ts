import {
  createHash,
  createPublicKey,
  sign,
  verify,
  type JsonWebKey,
  type KeyObject,
} from 'node:crypto';
import { ComputeError, newId, systemClock, type Clock } from '@better-compute/core';
import {
  assertP256,
  base64url,
  fromBase64url,
  generateP256KeyPair,
  toPrivateKey,
  toPublicKey,
} from './keys.js';
import type { ReplayCache } from './pop.js';

// Exec tickets (PLAN.md §7.6, §13): after the API authorized `compute:instances:exec` or
// `compute:nodes:console`, it issues a 60 s single-use ES256 JWT for one node. The gateway checks it
// and the daemon re-verifies it against the JWKS in its NodeSpec `access` section and its own `jti`
// set, so neither a replayed ticket nor a compromised gateway opens a tunnel.

/** `typ` of an exec ticket, so no other JWT (a session JWT, a workload token) passes as one. */
export const execTicketType = 'bc-exec+jwt';
/** Tickets live at most this long. */
export const maxExecTicketSeconds = 60;

export type TunnelOp = 'exec' | 'console' | 'ssh' | 'tcp';
const ops: readonly TunnelOp[] = ['exec', 'console', 'ssh', 'tcp'];

export interface ExecTicketClaims {
  /** The issuing control plane. */
  iss: string;
  /** `node:<nodeId>`: the only daemon that may accept it. */
  aud: `node:${string}`;
  /** The caller (better-iam identity id), for the daemon's audit line. */
  sub: string;
  /** The tunnel/stream id the ticket opens. */
  sid: string;
  op: TunnelOp;
  jti: string;
  /** Seconds since the epoch. */
  iat: number;
  exp: number;
  /** The tenant, the instance (exec into a VM) and the port (tcp) when relevant. */
  tnt?: string;
  inst?: string;
  port?: number;
  /** The caller's IAM session: re-authorization checks it is still live (§7.6). */
  ses?: string;
  /** The IAM action `tunnels.open` decided (`compute:instances:exec`, `compute:nodes:console`): re-decided as is. */
  act?: string;
  /**
   * An AI agent acting for `sub` (a delegated session or agent key), and its delegation: a revoked
   * delegation closes exactly the tunnels it opened (the gateway's `closeTunnels` filters on them).
   */
  agt?: string;
  dlg?: string;
}

export interface IssueExecTicketInput {
  nodeId: string;
  sid: string;
  op: TunnelOp;
  subject: string;
  tenantId?: string;
  instanceId?: string;
  port?: number;
  /** The caller's IAM session id (`ses`). */
  sessionId?: string;
  /** The decided IAM action (`act`). */
  action?: string;
  /** The agent acting for the subject (`agt`) and its delegation (`dlg`). */
  agentId?: string;
  delegationId?: string;
  /** Default and maximum 60. */
  ttlSeconds?: number;
}

export interface ExecTicketIssuer {
  /** The JWKS JSON for `AccessSection.exec_ticket_jwks_json`: every key still accepted. */
  jwksJson(): string;
  issue(input: IssueExecTicketInput): { token: string; jti: string; expiresAt: number };
  /** Starts signing with a new key; the previous key stays in the JWKS for `keepPrevious` more rotations. */
  rotate(): void;
}

interface TicketKey {
  kid: string;
  privateKey: KeyObject;
  publicJwk: JsonWebKey;
}

function ticketKey(privateKey: KeyObject): TicketKey {
  assertP256(privateKey, 'ticket signing key');
  const jwk = toPublicKey(privateKey).export({ format: 'jwk' });
  const publicJwk: JsonWebKey = { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y! };
  return { kid: jwkThumbprint(publicJwk), privateKey, publicJwk };
}

/**
 * RFC 7638 thumbprint of a P-256 public JWK: the `kid`, so every process holding the same key
 * (api replicas, the gateway's copy of the JWKS) names it the same way.
 */
export function jwkThumbprint(jwk: JsonWebKey): string {
  const canonical = `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`;
  return base64url(new Uint8Array(createHash('sha256').update(canonical).digest()));
}

const encode = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));

/**
 * Issues exec tickets. Keys rotate with `rotate()`; the JWKS lists the current key and the last
 * `keepPrevious` (default 1), so tickets and NodeSpecs in flight stay valid across a rotation.
 */
export function createExecTicketIssuer(options: {
  issuer: string;
  clock?: Clock;
  privateKey?: KeyObject | Uint8Array | string;
  keepPrevious?: number;
}): ExecTicketIssuer {
  const clock = options.clock ?? systemClock;
  const keepPrevious = options.keepPrevious ?? 1;
  let keys: TicketKey[] = [
    ticketKey(
      options.privateKey ? toPrivateKey(options.privateKey) : generateP256KeyPair().privateKey,
    ),
  ];
  return {
    jwksJson: () =>
      JSON.stringify({
        keys: keys.map((key) => ({ ...key.publicJwk, kid: key.kid, alg: 'ES256', use: 'sig' })),
      }),
    issue(input) {
      const ttl = input.ttlSeconds ?? maxExecTicketSeconds;
      if (!Number.isInteger(ttl) || ttl <= 0 || ttl > maxExecTicketSeconds)
        throw new ComputeError('INVALID_INPUT', `Exec tickets live 1 to ${maxExecTicketSeconds} s`);
      if (!ops.includes(input.op))
        throw new ComputeError('INVALID_INPUT', `Unknown tunnel op ${input.op}`);
      if (!input.nodeId || !input.sid || !input.subject)
        throw new ComputeError(
          'INVALID_INPUT',
          'An exec ticket names a node, a stream and a subject',
        );
      const now = Math.floor(clock.now() / 1000);
      const claims: ExecTicketClaims = {
        iss: options.issuer,
        aud: `node:${input.nodeId}`,
        sub: input.subject,
        sid: input.sid,
        op: input.op,
        jti: newId('tkt'),
        iat: now,
        exp: now + ttl,
        ...(input.tenantId !== undefined ? { tnt: input.tenantId } : {}),
        ...(input.instanceId !== undefined ? { inst: input.instanceId } : {}),
        ...(input.port !== undefined ? { port: input.port } : {}),
        ...(input.sessionId !== undefined ? { ses: input.sessionId } : {}),
        ...(input.action !== undefined ? { act: input.action } : {}),
        ...(input.agentId !== undefined ? { agt: input.agentId } : {}),
        ...(input.delegationId !== undefined ? { dlg: input.delegationId } : {}),
      };
      const current = keys[0]!;
      const signingInput = `${encode({ alg: 'ES256', typ: execTicketType, kid: current.kid })}.${encode(claims)}`;
      const signature = sign('sha256', Buffer.from(signingInput, 'ascii'), {
        key: current.privateKey,
        dsaEncoding: 'ieee-p1363',
      });
      return {
        token: `${signingInput}.${base64url(new Uint8Array(signature))}`,
        jti: claims.jti,
        expiresAt: claims.exp * 1000,
      };
    },
    rotate() {
      keys = [ticketKey(generateP256KeyPair().privateKey), ...keys].slice(0, keepPrevious + 1);
    },
  };
}

export interface VerifyExecTicketOptions {
  /** `AccessSection.exec_ticket_jwks_json`, or the parsed JWKS. */
  jwks: string | { keys: JsonWebKey[] };
  /** This daemon's node id (from its own certificate). */
  nodeId: string;
  /** Epoch milliseconds, in server time. */
  now: number;
  /** The daemon's `jti` set: a ticket is accepted once. */
  jtiCache: ReplayCache;
  /** When set, `iss` must equal it. */
  issuer?: string;
  /** Allowed `op`s (default all). */
  ops?: readonly TunnelOp[];
  /** Clock tolerance for `iat`/`exp` (default 5 s). */
  leewayMs?: number;
}

/**
 * The daemon's (and gateway's) check of an exec ticket: `typ`, ES256 under a JWKS key, `aud` =
 * this node, not expired, lifetime ≤ 60 s, a known `op`, and a `jti` never seen before. Throws
 * `ACCESS_DENIED` with a `reason`; the jti is recorded only for a ticket that passed every check.
 */
export function verifyExecTicket(
  token: string,
  options: VerifyExecTicketOptions,
): ExecTicketClaims {
  const deny = (reason: string) =>
    new ComputeError('ACCESS_DENIED', 'Exec ticket rejected', undefined, { reason });
  if (typeof token !== 'string' || token.length > 8192) throw deny('malformed');
  const parts = token.split('.');
  if (parts.length !== 3) throw deny('malformed');
  const [head, body, sig] = parts as [string, string, string];
  let header: { alg?: unknown; typ?: unknown; kid?: unknown };
  let claims: ExecTicketClaims;
  let signature: Uint8Array;
  try {
    header = JSON.parse(Buffer.from(fromBase64url(head)).toString('utf8'));
    claims = JSON.parse(Buffer.from(fromBase64url(body)).toString('utf8'));
    signature = fromBase64url(sig);
  } catch {
    throw deny('malformed');
  }
  if (header.alg !== 'ES256') throw deny('algorithm must be ES256');
  if (header.typ !== execTicketType) throw deny('not an exec ticket');
  const jwks =
    typeof options.jwks === 'string'
      ? (JSON.parse(options.jwks) as { keys: JsonWebKey[] })
      : options.jwks;
  const jwk = jwks.keys?.find((key) => (key as { kid?: string }).kid === header.kid);
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256') throw deny('unknown key');
  let key: KeyObject;
  try {
    key = createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y } as JsonWebKey,
      format: 'jwk',
    });
  } catch {
    throw deny('unknown key');
  }
  let valid = false;
  try {
    valid =
      signature.length === 64 &&
      verify(
        'sha256',
        Buffer.from(`${head}.${body}`, 'ascii'),
        { key, dsaEncoding: 'ieee-p1363' },
        signature,
      );
  } catch {
    valid = false;
  }
  if (!valid) throw deny('bad signature');
  if (typeof claims !== 'object' || claims === null) throw deny('malformed');
  if (claims.aud !== `node:${options.nodeId}`) throw deny('ticket for another node');
  if (options.issuer !== undefined && claims.iss !== options.issuer) throw deny('foreign issuer');
  if (!Number.isInteger(claims.iat) || !Number.isInteger(claims.exp)) throw deny('malformed');
  const leeway = options.leewayMs ?? 5000;
  if (claims.exp - claims.iat > maxExecTicketSeconds || claims.exp <= claims.iat)
    throw deny('lifetime too long');
  if (claims.iat * 1000 > options.now + leeway) throw deny('issued in the future');
  if (claims.exp * 1000 <= options.now - leeway) throw deny('expired');
  if (!(options.ops ?? ops).includes(claims.op)) throw deny('op not allowed');
  if (
    typeof claims.jti !== 'string' ||
    !claims.jti ||
    typeof claims.sid !== 'string' ||
    !claims.sid
  )
    throw deny('malformed');
  if (!options.jtiCache.add(claims.jti, claims.exp * 1000 + leeway, options.now))
    throw deny('replayed');
  return claims;
}
