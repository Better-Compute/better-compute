import { createHmac, sign, type JsonWebKey, type KeyObject } from 'node:crypto';
import { ComputeError, newId, systemClock, type Clock } from '@better-compute/core';
import {
  base64url,
  fromBase64url,
  generateP256KeyPair,
  randomBytesArray,
  timingSafeEqualBytes,
  toPrivateKey,
  toPublicKey,
} from './keys.js';

// Workload identity (PLAN.md §12.2 last row, v0.5, optional): an instance asks its IMDS for an OIDC
// token `sub = "t:<tenantId>:instance:<id>"` of at most 15 minutes and exchanges it at better-iam's
// `sts/assumeRoleWithWebIdentity` under a trust its tenant admin created. The issuer's discovery
// document and JWKS are served on a public https:443 host.

/** Workload tokens live at most this long. */
export const maxWorkloadTokenSeconds = 900;

export interface WorkloadTokenClaims {
  iss: string;
  sub: `t:${string}:instance:${string}`;
  aud: string;
  iat: number;
  nbf: number;
  exp: number;
  jti: string;
  tenant_id: string;
  instance_id: string;
  [claim: string]: unknown;
}

interface IssuerKey {
  kid: string;
  privateKey: KeyObject;
  publicJwk: JsonWebKey;
  /** When it started signing (epoch ms); undefined while only published. */
  promotedAt?: number;
  /** When it stopped signing (epoch ms). */
  demotedAt?: number;
}

export interface WorkloadIssuer {
  readonly issuer: string;
  /** Mints a workload token (≤ 15 min). Extra claims must not shadow the registered ones. */
  issue(input: {
    tenantId: string;
    instanceId: string;
    audience?: string;
    ttlSeconds?: number;
    claims?: Record<string, string | number | boolean>;
  }): { token: string; jti: string; expiresAt: number };
  /** Every key a verifier should accept: the signing key, keys waiting to sign, and retiring keys. */
  jwks(): { keys: JsonWebKey[] };
  /** The OIDC discovery document for `<issuer>/.well-known/openid-configuration`. */
  discoveryDocument(): Record<string, unknown>;
  /**
   * Rotation, in three steps so no token ever fails verification: `addKey()` publishes a new key
   * (still signing with the old one); once verifiers have re-read the JWKS, `promote(kid)` signs with
   * it; `retire(kid)` drops a demoted key, refused until its last token has expired.
   */
  addKey(): string;
  promote(kid: string): void;
  retire(kid: string): void;
  /** Keys as PKCS#8 PEM with their state, for storage (handle as secrets). */
  exportKeys(): { kid: string; privateKeyPem: string; promotedAt?: number; demotedAt?: number }[];
}

const encode = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));
const reservedClaims = new Set([
  'iss',
  'sub',
  'aud',
  'iat',
  'nbf',
  'exp',
  'jti',
  'tenant_id',
  'instance_id',
]);
const idPart = /^[A-Za-z0-9._-]{1,128}$/;

function makeKey(privateKey: KeyObject, kid: string = newId('wkey')): IssuerKey {
  const jwk = toPublicKey(privateKey).export({ format: 'jwk' });
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256')
    throw new ComputeError('INVALID_INPUT', 'Workload signing keys are P-256');
  return { kid, privateKey, publicJwk: { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y! } };
}

export function createWorkloadIssuer(options: {
  /** The issuer URL: https on port 443, where the discovery document and JWKS are served. */
  issuer: string;
  /** The audience tokens carry unless the request names one (e.g. better-iam's provider audience). */
  defaultAudience: string;
  clock?: Clock;
  /** Keys from `exportKeys()`; default one fresh key. */
  keys?: { kid: string; privateKeyPem: string; promotedAt?: number; demotedAt?: number }[];
}): WorkloadIssuer {
  let url: URL;
  try {
    url = new URL(options.issuer);
  } catch {
    throw new ComputeError('INVALID_CONFIG', 'The workload issuer must be a URL');
  }
  if (url.protocol !== 'https:' || url.port || url.search || url.hash || url.username)
    throw new ComputeError(
      'INVALID_CONFIG',
      'The workload issuer must be https on port 443, without query',
    );
  const issuer = options.issuer.replace(/\/+$/, '');
  const clock = options.clock ?? systemClock;
  let keys: IssuerKey[] = options.keys?.length
    ? options.keys.map((stored) => ({
        ...makeKey(toPrivateKey(stored.privateKeyPem), stored.kid),
        ...(stored.promotedAt !== undefined ? { promotedAt: stored.promotedAt } : {}),
        ...(stored.demotedAt !== undefined ? { demotedAt: stored.demotedAt } : {}),
      }))
    : [{ ...makeKey(generateP256KeyPair().privateKey), promotedAt: clock.now() }];
  const signing = () => {
    const active = keys.filter(
      (key) => key.promotedAt !== undefined && key.demotedAt === undefined,
    );
    if (active.length !== 1)
      throw new ComputeError('INVALID_STATE', 'Exactly one workload key must be signing');
    return active[0]!;
  };
  signing();
  const find = (kid: string) => {
    const key = keys.find((item) => item.kid === kid);
    if (!key) throw new ComputeError('NOT_FOUND', `No workload key ${kid}`);
    return key;
  };

  return {
    issuer,
    issue(input) {
      if (!idPart.test(input.tenantId) || !idPart.test(input.instanceId))
        throw new ComputeError(
          'INVALID_INPUT',
          'tenantId and instanceId are ids of A-Z a-z 0-9 . _ -',
        );
      const ttl = input.ttlSeconds ?? maxWorkloadTokenSeconds;
      if (!Number.isInteger(ttl) || ttl < 60 || ttl > maxWorkloadTokenSeconds)
        throw new ComputeError(
          'INVALID_INPUT',
          `Workload tokens live 60 to ${maxWorkloadTokenSeconds} s`,
        );
      for (const claim of Object.keys(input.claims ?? {}))
        if (reservedClaims.has(claim))
          throw new ComputeError('INVALID_INPUT', `Claim ${claim} is reserved`);
      const now = Math.floor(clock.now() / 1000);
      const claims: WorkloadTokenClaims = {
        ...input.claims,
        iss: issuer,
        sub: `t:${input.tenantId}:instance:${input.instanceId}`,
        aud: input.audience ?? options.defaultAudience,
        iat: now,
        nbf: now,
        exp: now + ttl,
        jti: newId('wjt'),
        tenant_id: input.tenantId,
        instance_id: input.instanceId,
      };
      const key = signing();
      const signingInput = `${encode({ alg: 'ES256', typ: 'JWT', kid: key.kid })}.${encode(claims)}`;
      const signature = sign('sha256', Buffer.from(signingInput, 'ascii'), {
        key: key.privateKey,
        dsaEncoding: 'ieee-p1363',
      });
      return {
        token: `${signingInput}.${base64url(new Uint8Array(signature))}`,
        jti: claims.jti,
        expiresAt: claims.exp * 1000,
      };
    },
    jwks: () => ({
      keys: keys.map(
        (key) => ({ ...key.publicJwk, kid: key.kid, alg: 'ES256', use: 'sig' }) as JsonWebKey,
      ),
    }),
    discoveryDocument: () => ({
      issuer,
      jwks_uri: `${issuer}/.well-known/jwks.json`,
      response_types_supported: ['id_token'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['ES256'],
      claims_supported: [
        'iss',
        'sub',
        'aud',
        'iat',
        'nbf',
        'exp',
        'jti',
        'tenant_id',
        'instance_id',
      ],
    }),
    addKey() {
      const key = makeKey(generateP256KeyPair().privateKey);
      keys = [...keys, key];
      return key.kid;
    },
    promote(kid) {
      const next = find(kid);
      if (next.demotedAt !== undefined)
        throw new ComputeError('INVALID_STATE', 'A retired key cannot sign again');
      if (next.promotedAt !== undefined) return;
      const now = clock.now();
      const current = signing();
      current.demotedAt = now;
      next.promotedAt = now;
    },
    retire(kid) {
      const key = find(kid);
      if (key.demotedAt === undefined)
        throw new ComputeError('INVALID_STATE', 'Only a key that stopped signing can be retired');
      if (clock.now() < key.demotedAt + maxWorkloadTokenSeconds * 1000 + 60_000)
        throw new ComputeError(
          'INVALID_STATE',
          'Tokens signed with this key may still be valid; retire it later',
        );
      keys = keys.filter((item) => item.kid !== kid);
    },
    exportKeys: () =>
      keys.map((key) => ({
        kid: key.kid,
        privateKeyPem: key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        ...(key.promotedAt !== undefined ? { promotedAt: key.promotedAt } : {}),
        ...(key.demotedAt !== undefined ? { demotedAt: key.demotedAt } : {}),
      })),
  };
}

// --- IMDS (§13: bound per instance, IMDSv2-style token header) ---------------------------------

export const imdsSessionHeader = 'x-bc-metadata-token';
export const imdsSessionTtlHeader = 'x-bc-metadata-token-ttl-seconds';

export interface ImdsInstance {
  tenantId: string;
  instanceId: string;
}

/**
 * The metadata service's token exchange, IMDSv2-style. The host serves it on each instance's own
 * link-local address and passes the instance it received the request from (never a request field):
 * - `PUT /latest/api/token` with `x-bc-metadata-token-ttl-seconds` (1 to 21600) → a session token
 *   bound to that instance by an HMAC;
 * - `GET /latest/identity-token?audience=…` with `x-bc-metadata-token` → a workload token.
 * A session token from one instance fails on any other, and forwarded requests (`X-Forwarded-For`)
 * are refused, which blocks the usual SSRF relays.
 */
export function createImdsTokenService(options: {
  issuer: WorkloadIssuer;
  clock?: Clock;
  /** HMAC key for session tokens (default: random per process, so tokens die with it). */
  sessionKey?: Uint8Array;
  /** Audiences an instance may ask for (default: only the issuer's default audience). */
  audiences?: readonly string[];
}): { handler(request: Request, instance: ImdsInstance): Promise<Response> } {
  const clock = options.clock ?? systemClock;
  const sessionKey = options.sessionKey ?? randomBytesArray(32);
  const mac = (instance: ImdsInstance, expires: number) =>
    new Uint8Array(
      createHmac('sha256', sessionKey)
        .update(`bc-imds/v1\0${instance.tenantId}\0${instance.instanceId}\0${expires}`)
        .digest(),
    );
  const text = (status: number, body: string) =>
    new Response(body, { status, headers: { 'content-type': 'text/plain' } });
  return {
    async handler(request, instance) {
      if (request.headers.has('x-forwarded-for'))
        return text(403, 'Forwarded requests are refused');
      const url = new URL(request.url);
      if (url.pathname === '/latest/api/token') {
        if (request.method !== 'PUT') return text(405, 'Use PUT');
        const ttl = Number(request.headers.get(imdsSessionTtlHeader));
        if (!Number.isInteger(ttl) || ttl < 1 || ttl > 21_600)
          return text(400, `${imdsSessionTtlHeader} must be 1 to 21600`);
        const expires = Math.floor(clock.now() / 1000) + ttl;
        return text(200, `${expires}.${base64url(mac(instance, expires))}`);
      }
      if (url.pathname === '/latest/identity-token') {
        if (request.method !== 'GET') return text(405, 'Use GET');
        const [expiresText, tag] = (request.headers.get(imdsSessionHeader) ?? '').split('.');
        const expires = Number(expiresText);
        let valid = false;
        try {
          valid =
            Number.isInteger(expires) &&
            expires * 1000 > clock.now() &&
            timingSafeEqualBytes(fromBase64url(tag ?? ''), mac(instance, expires));
        } catch {
          valid = false;
        }
        if (!valid) return text(401, 'A valid metadata session token is required');
        const audience = url.searchParams.get('audience') ?? undefined;
        const allowed = options.audiences ?? [];
        if (audience !== undefined && !allowed.includes(audience))
          return text(400, 'Audience not allowed');
        const issued = options.issuer.issue({
          tenantId: instance.tenantId,
          instanceId: instance.instanceId,
          ...(audience ? { audience } : {}),
        });
        return text(200, issued.token);
      }
      return text(404, 'Not found');
    },
  };
}
