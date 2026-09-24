import {
  createPublicKey,
  verify,
  X509Certificate,
  type JsonWebKey,
  type KeyObject,
} from 'node:crypto';
import {
  defineAttestor,
  type AgentRole,
  type AttestationResult,
  type AttestorVerifier,
  type HardwareClaims,
  type SqlTx,
} from '@better-compute/core';
import { base64url, fromBase64url, sha256 } from '../keys.js';
import { csrSha256Of, refuser, useOnce, type AttestorBaseOptions } from './common.js';

/**
 * The `cloud-iid` attestor (v0.3, PLAN.md §3.6): a platform-owned cloud VM (a `vps-host` or
 * `provider` node) joins with its provider's signed instance identity instead of a token. Each
 * provider verifies its own format; the host's `resolve` then maps the verified instance to the
 * provider account and pool it belongs to, and refuses instances it did not create. No new
 * dependency: signatures are `node:crypto`, provider keys are injected (AWS certificates) or fetched
 * through an injected `fetch` (GCP JWKS).
 *
 * Evidence (`JoinRequest.attestation`, UTF-8 JSON): `{"provider":"gcp","document":"<jwt>"}` or
 * `{"provider":"aws","document":"<IID JSON>","signature":"<base64>"}`.
 *
 * Replay: a GCP identity token's audience carries the CSR hash (`<audience>#<b64url sha256(csr)>`),
 * so a captured token is useless with another key. An AWS document cannot be bound, so it is
 * accepted only within `maxAgeMs` of the instance's `pendingTime` (first boot). Either way, the
 * attestor admits each (provider, account, instance) once (`attestation_uses`); later re-joins of
 * that machine go through x509pop.
 */

export interface CloudIidEvidence {
  provider: string;
  document: string;
  signature?: string;
}

/** What a provider proved about the instance. */
export interface CloudInstanceIdentity {
  provider: string;
  /** AWS account id, GCP project id, … */
  accountId: string;
  instanceId: string;
  region?: string;
  zone?: string;
  /** Epoch ms of the instance's creation / first boot, when the document says. */
  createdAt?: number;
  /** The verified claims, for resolvers that need more. */
  claims: Readonly<Record<string, unknown>>;
}

export interface CloudIdentityVerifyInput {
  now: number;
  /** SHA-256 of the join CSR, when JoinService provided it. */
  csrSha256?: Uint8Array;
}

export interface CloudIdentityProvider {
  readonly id: string;
  /** Throws (anything) to refuse. */
  verify(
    evidence: CloudIidEvidence,
    input: CloudIdentityVerifyInput,
  ): Promise<CloudInstanceIdentity>;
}

export type CloudIidResolver = (
  tx: SqlTx,
  identity: CloudInstanceIdentity,
  request: { role: AgentRole; claims: HardwareClaims },
) => Promise<AttestationResult | undefined>;

export interface CloudIidAttestorOptions extends AttestorBaseOptions {
  providers: readonly CloudIdentityProvider[];
  /**
   * Maps a verified instance to where it joins (tenant, pool, site; `nodeId` for a known machine).
   * Undefined refuses: an instance of an account compute does not manage, or one it did not create.
   */
  resolve: CloudIidResolver;
  /** Roles admitted (default `node`). */
  roles?: readonly AgentRole[];
}

class Refusal extends Error {}
const fail = (reason: string): never => {
  throw new Refusal(reason);
};

/** The control-plane half of `cloud-iid`. */
export function cloudIidAttestor(options: CloudIidAttestorOptions): AttestorVerifier {
  const providers = new Map(options.providers.map((provider) => [provider.id, provider]));
  return defineAttestor({
    id: 'cloud-iid',
    version: '1.0.0',
    roles: options.roles ?? ['node'],
    async verify(evidence, context): Promise<AttestationResult> {
      const refuse = refuser('cloud-iid', options.onRefusal);
      let parsed: CloudIidEvidence;
      try {
        parsed = parseEvidence(evidence.payload);
      } catch {
        return refuse('malformed');
      }
      const provider = providers.get(parsed.provider);
      if (!provider) return refuse('unknown-provider');
      const csrSha256 = csrSha256Of(context);
      let identity: CloudInstanceIdentity;
      try {
        identity = await provider.verify(parsed, {
          now: context.clock.now(),
          ...(csrSha256 ? { csrSha256 } : {}),
        });
      } catch (error) {
        return refuse(`${parsed.provider}:${error instanceof Refusal ? error.message : 'invalid'}`);
      }
      const result = await options.resolve(context.tx, identity, {
        role: context.role,
        claims: context.claims,
      });
      if (!result) return refuse('unknown-instance');
      if (result.role !== context.role) return refuse('role');
      // One join per instance, ever: an AWS document is readable by anything on the VM and not
      // CSR-bound, and even a bound GCP token must not mint a second node. A known instance that
      // lost its certificate re-joins with x509pop.
      const subject = sha256(`${identity.provider}\0${identity.accountId}\0${identity.instanceId}`);
      if (!(await useOnce(context.tx, 'cloud-iid', subject))) return refuse('instance-reused');
      return result;
    },
  });
}

function parseEvidence(payload: Uint8Array): CloudIidEvidence {
  if (payload.length === 0 || payload.length > 64 * 1024) fail('size');
  const value = JSON.parse(new TextDecoder().decode(payload)) as Partial<CloudIidEvidence>;
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof value.provider !== 'string' ||
    typeof value.document !== 'string' ||
    (value.signature !== undefined && typeof value.signature !== 'string')
  )
    fail('shape');
  return value as CloudIidEvidence;
}

/** The agent side: `JoinRequest.attestation` from what the metadata service returned. */
export function createCloudIidEvidence(evidence: CloudIidEvidence): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(evidence));
}

/** The GCP / OIDC audience the agent must request: the pinned audience plus the CSR hash. */
export function cloudIidAudience(audience: string, csrSha256: Uint8Array): string {
  return `${audience}#${base64url(csrSha256)}`;
}

// --- OIDC identity tokens (GCP) -------------------------------------------------------------------

export type FetchLike = (
  url: string,
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface JwksSource {
  key(kid: string): Promise<KeyObject | undefined>;
}

/**
 * A JWKS fetched through `fetch` and cached for `cacheMs` (default 1 h). An unknown `kid` refetches,
 * at most once per `minRefreshMs` (default 60 s), so rotated keys are picked up without letting
 * garbage kids hammer the endpoint.
 */
export function remoteJwks(options: {
  url: string;
  fetch: FetchLike;
  clock?: { now(): number };
  cacheMs?: number;
  minRefreshMs?: number;
}): JwksSource {
  const now = () => options.clock?.now() ?? Date.now();
  let keys = new Map<string, KeyObject>();
  let fetchedAt = -Infinity;
  let pending: Promise<void> | undefined;
  const refresh = () =>
    (pending ??= (async () => {
      try {
        const response = await options.fetch(options.url);
        if (!response.ok) fail(`jwks-http-${response.status}`);
        keys = jwksKeys(await response.json());
        fetchedAt = now();
      } finally {
        pending = undefined;
      }
    })());
  return {
    async key(kid) {
      const age = now() - fetchedAt;
      if (age > (options.cacheMs ?? 3_600_000)) await refresh();
      else if (!keys.has(kid) && age > (options.minRefreshMs ?? 60_000)) await refresh();
      return keys.get(kid);
    },
  };
}

/** A fixed key set (tests, air-gapped hosts). */
export function staticJwks(jwks: unknown): JwksSource {
  const keys = jwksKeys(jwks);
  return { key: async (kid) => keys.get(kid) };
}

function jwksKeys(value: unknown): Map<string, KeyObject> {
  const out = new Map<string, KeyObject>();
  const list = (value as { keys?: unknown })?.keys;
  if (!Array.isArray(list)) fail('jwks-shape');
  for (const jwk of list as JsonWebKey[]) {
    if (typeof jwk?.kid !== 'string') continue;
    if (jwk.kty !== 'RSA' && jwk.kty !== 'EC') continue;
    try {
      out.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }));
    } catch {
      // skip keys node cannot read
    }
  }
  return out;
}

const jwtAlgorithms: Readonly<
  Record<string, { hash: string; dsaEncoding?: 'ieee-p1363'; kty: string }>
> = {
  RS256: { hash: 'sha256', kty: 'rsa' },
  ES256: { hash: 'sha256', dsaEncoding: 'ieee-p1363', kty: 'ec' },
};

/** Verifies a compact JWS with a key from `jwks`; returns its payload. Throws on anything off. */
export async function verifyJwt(token: string, jwks: JwksSource): Promise<Record<string, unknown>> {
  const parts = token.split('.');
  if (parts.length !== 3) fail('jwt-shape');
  const [h, p, s] = parts as [string, string, string];
  let header: { alg?: unknown; kid?: unknown; crit?: unknown };
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(fromBase64url(h)).toString('utf8'));
    payload = JSON.parse(Buffer.from(fromBase64url(p)).toString('utf8'));
  } catch {
    return fail('jwt-shape');
  }
  if (typeof payload !== 'object' || payload === null) fail('jwt-shape');
  if (header.crit !== undefined) fail('jwt-crit');
  const alg = typeof header.alg === 'string' ? jwtAlgorithms[header.alg] : undefined;
  if (!alg) fail('jwt-alg');
  if (typeof header.kid !== 'string') fail('jwt-kid');
  const key = await jwks.key(header.kid as string);
  if (!key) fail('jwt-unknown-kid');
  if (key!.asymmetricKeyType !== alg!.kty) fail('jwt-alg');
  let valid = false;
  try {
    valid = verify(
      alg!.hash,
      Buffer.from(`${h}.${p}`),
      alg!.dsaEncoding ? { key: key!, dsaEncoding: alg!.dsaEncoding } : key!,
      fromBase64url(s),
    );
  } catch {
    valid = false;
  }
  if (!valid) fail('jwt-signature');
  return payload;
}

export interface OidcInstanceIdentityOptions {
  id: string;
  issuers: readonly string[];
  jwks: JwksSource;
  /** The pinned audience; the token's `aud` must be exactly `cloudIidAudience(audience, csrSha256)`. */
  audience: string;
  /** Maximum age of `iat` (default 10 min). */
  maxAgeMs?: number;
  skewMs?: number;
  /** Maps the verified claims to the instance; throw to refuse. */
  identity(claims: Record<string, unknown>): Omit<CloudInstanceIdentity, 'provider' | 'claims'>;
}

/** A provider for OIDC-style instance identity tokens bound to the CSR through `aud`. */
export function oidcInstanceIdentity(options: OidcInstanceIdentityOptions): CloudIdentityProvider {
  const maxAgeMs = options.maxAgeMs ?? 600_000;
  const skewMs = options.skewMs ?? 60_000;
  return {
    id: options.id,
    async verify(evidence, input) {
      if (!input.csrSha256) fail('no-csr-binding');
      const claims = await verifyJwt(evidence.document, options.jwks);
      if (typeof claims.iss !== 'string' || !options.issuers.includes(claims.iss)) fail('iss');
      const expected = cloudIidAudience(options.audience, input.csrSha256!);
      const aud = claims.aud;
      if (!(aud === expected || (Array.isArray(aud) && aud.length === 1 && aud[0] === expected)))
        fail('aud');
      const exp = claims.exp;
      const iat = claims.iat;
      if (typeof exp !== 'number' || typeof iat !== 'number') fail('times');
      const now = input.now;
      if (now > (exp as number) * 1000 + skewMs) fail('expired');
      if ((iat as number) * 1000 > now + skewMs) fail('future');
      if (now - (iat as number) * 1000 > maxAgeMs + skewMs) fail('too-old');
      return { ...options.identity(claims), provider: options.id, claims };
    },
  };
}

export const gcpJwksUrl = 'https://www.googleapis.com/oauth2/v3/certs';
export const gcpIssuers: readonly string[] = ['https://accounts.google.com', 'accounts.google.com'];

/**
 * GCP Compute Engine identity tokens (metadata `instance/service-accounts/default/identity?
 * audience=<cloudIidAudience(…)>&format=full`). `format=full` is required: the
 * `google.compute_engine` claim names the project, zone and instance. `projects` limits which
 * project ids are accepted before `resolve` runs.
 */
export function gcpInstanceIdentity(options: {
  audience: string;
  fetch?: FetchLike;
  jwks?: JwksSource;
  projects?: readonly string[];
  maxAgeMs?: number;
  clock?: { now(): number };
}): CloudIdentityProvider {
  const jwks =
    options.jwks ??
    (options.fetch
      ? remoteJwks({
          url: gcpJwksUrl,
          fetch: options.fetch,
          ...(options.clock ? { clock: options.clock } : {}),
        })
      : fail('gcpInstanceIdentity needs fetch or jwks'));
  return oidcInstanceIdentity({
    id: 'gcp',
    issuers: gcpIssuers,
    jwks,
    audience: options.audience,
    ...(options.maxAgeMs !== undefined ? { maxAgeMs: options.maxAgeMs } : {}),
    identity(claims) {
      const google = (claims.google as { compute_engine?: Record<string, unknown> } | undefined)
        ?.compute_engine;
      if (!google) fail('not-format-full');
      const projectId = google!.project_id;
      const instanceId = google!.instance_id;
      const zone = google!.zone;
      if (
        typeof projectId !== 'string' ||
        typeof instanceId !== 'string' ||
        typeof zone !== 'string'
      )
        fail('compute-engine-claims');
      if (options.projects && !options.projects.includes(projectId as string)) fail('project');
      const created = google!.instance_creation_timestamp;
      return {
        accountId: projectId as string,
        instanceId: instanceId as string,
        zone: zone as string,
        region: (zone as string).replace(/-[a-z]$/, ''),
        ...(typeof created === 'number' ? { createdAt: created * 1000 } : {}),
      };
    },
  });
}

// --- AWS instance identity documents --------------------------------------------------------------

export interface AwsInstanceIdentityOptions {
  /**
   * AWS's public certificates for the `signature` endpoint (RSA-SHA256), PEM, by region; `'*'` is
   * tried for regions not listed. Copy them from the AWS documentation ("Verify the instance
   * identity document") into your config; they are not bundled here.
   */
  certificates: Readonly<Record<string, string>>;
  /** Accepted only this long after the instance's `pendingTime` (default 30 min). */
  maxAgeMs?: number;
  /** Limits the AWS account ids accepted before `resolve` runs. */
  accounts?: readonly string[];
}

/**
 * AWS EC2 instance identity documents: `document` is the exact JSON from
 * `/latest/dynamic/instance-identity/document`, `signature` the base64 from `…/signature`.
 */
export function awsInstanceIdentity(options: AwsInstanceIdentityOptions): CloudIdentityProvider {
  const keys = new Map<string, KeyObject>();
  for (const [region, pem] of Object.entries(options.certificates))
    keys.set(region, publicKeyFromPem(pem));
  const maxAgeMs = options.maxAgeMs ?? 30 * 60_000;
  return {
    id: 'aws',
    async verify(evidence, input) {
      if (!evidence.signature) fail('no-signature');
      let doc: Record<string, unknown>;
      try {
        doc = JSON.parse(evidence.document) as Record<string, unknown>;
      } catch {
        return fail('document-shape');
      }
      const { accountId, instanceId, region, pendingTime } = doc;
      if (
        typeof accountId !== 'string' ||
        typeof instanceId !== 'string' ||
        typeof region !== 'string'
      )
        fail('document-shape');
      const key = keys.get(region as string) ?? keys.get('*');
      if (!key) fail('no-certificate-for-region');
      let valid = false;
      try {
        valid = verify(
          'sha256',
          Buffer.from(evidence.document, 'utf8'),
          key!,
          Buffer.from(evidence.signature!, 'base64'),
        );
      } catch {
        valid = false;
      }
      if (!valid) fail('signature');
      if (options.accounts && !options.accounts.includes(accountId as string)) fail('account');
      const pending = typeof pendingTime === 'string' ? Date.parse(pendingTime) : NaN;
      if (!Number.isFinite(pending)) fail('no-pending-time');
      if (pending > input.now + 60_000 || input.now - pending > maxAgeMs) fail('too-old');
      return {
        provider: 'aws',
        accountId: accountId as string,
        instanceId: instanceId as string,
        region: region as string,
        ...(typeof doc.availabilityZone === 'string' ? { zone: doc.availabilityZone } : {}),
        createdAt: pending,
        claims: doc,
      };
    },
  };
}

function publicKeyFromPem(pem: string): KeyObject {
  if (pem.includes('BEGIN CERTIFICATE')) return new X509Certificate(pem).publicKey;
  return createPublicKey(pem);
}
