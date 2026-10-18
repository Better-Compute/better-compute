import { createPublicKey, KeyObject, randomUUID, sign } from 'node:crypto';
import {
  ComputeError,
  systemClock,
  type Clock,
  type WorkloadIssuerPort,
} from '@better-compute/core';
import { base64url, spkiSha256 } from './keys.js';

/**
 * The control plane as an OIDC issuer for workload identity federation (GCP workload identity pools,
 * AWS web identity, ...): it signs short-lived ES256 identity tokens, and publishes the public keys
 * and the discovery document a relying party fetches to verify them.
 *
 * Key rollover: `signingKey` signs; `nextKey` is published ahead of time but never signs (relying
 * parties cache JWKS, so a key must be visible before it is used); `previousKeys` stay published so
 * tokens minted before the switch keep verifying until they expire. Only public keys ever leave this
 * module: the private key is used inside `crypto.sign` and appears in no JWKS, token, log or error.
 */
export interface WorkloadIssuerOptions {
  /** `https` URL (`http` only for `localhost` / `127.0.0.1`), no query, fragment or trailing slash. */
  issuer: string;
  /** EC P-256 private key: signs. */
  signingKey: KeyObject;
  /** Published, never signs (rollover). */
  nextKey?: KeyObject;
  /** Published, never sign (tokens still in flight). */
  previousKeys?: readonly KeyObject[];
  clock?: Clock;
}

export interface WorkloadIssuerDiscovery {
  issuer: string;
  jwks_uri: string;
  response_types_supported: ['id_token'];
  subject_types_supported: ['public'];
  id_token_signing_alg_values_supported: ['ES256'];
}

const defaultTtlSeconds = 300;
const minTtlSeconds = 60;
const maxTtlSeconds = 600;

function invalid(code: 'INVALID_CONFIG' | 'INVALID_INPUT', reason: string, message: string) {
  return new ComputeError(code, message, undefined, { reason });
}

function checkIssuer(issuer: unknown): string {
  if (typeof issuer !== 'string' || issuer.length === 0)
    throw invalid('INVALID_CONFIG', 'issuerUrl', 'The workload issuer URL is required');
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    throw invalid('INVALID_CONFIG', 'issuerUrl', 'The workload issuer is not a URL');
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    throw invalid(
      'INVALID_CONFIG',
      'issuerUrl',
      'The workload issuer must be an https URL (http only for localhost or 127.0.0.1)',
    );
  // `new URL` normalizes ("https://h" -> "https://h/"), so judge the text the caller gave us.
  if (
    url.search !== '' ||
    url.hash !== '' ||
    issuer.includes('?') ||
    issuer.includes('#') ||
    issuer.endsWith('/') ||
    url.username !== '' ||
    url.password !== ''
  )
    throw invalid(
      'INVALID_CONFIG',
      'issuerUrl',
      'The workload issuer URL must have no query, fragment, credentials or trailing slash',
    );
  // The text is used verbatim as `iss` and as the prefix of `jwks_uri`, so it must already be the
  // canonical form: `new URL` trims whitespace, lowercases scheme and host, adds a missing `//`,
  // percent-encodes and fills in an empty path with `/`. Accept only what it would print back.
  const canonical = url.href.endsWith('/') ? url.href.slice(0, -1) : url.href;
  if (issuer !== canonical)
    throw invalid(
      'INVALID_CONFIG',
      'issuerUrl',
      'The workload issuer URL must be in canonical form (lowercase scheme and host, no whitespace or characters needing escapes)',
    );
  return issuer;
}

function isP256(key: KeyObject): boolean {
  return key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1';
}

function checkKey(key: unknown, what: string, mustSign: boolean): KeyObject {
  const ok = key instanceof KeyObject && isP256(key) && (!mustSign || key.type === 'private');
  if (!ok)
    throw invalid(
      'INVALID_CONFIG',
      'issuerKey',
      mustSign
        ? `The workload issuer ${what} must be an EC P-256 private key`
        : `The workload issuer ${what} must be an EC P-256 key`,
    );
  return key as KeyObject;
}

interface PublishedKey {
  kid: string;
  jwk: Readonly<Record<string, unknown>>;
}

function published(key: KeyObject): PublishedKey {
  const publicKey = key.type === 'public' ? key : createPublicKey(key);
  const { x, y } = publicKey.export({ format: 'jwk' });
  const kid = base64url(spkiSha256(publicKey));
  // Only these members: nothing else of the exported JWK is ever copied out.
  return {
    kid,
    jwk: Object.freeze({ kty: 'EC', crv: 'P-256', x, y, kid, alg: 'ES256', use: 'sig' }),
  };
}

/** Builds the workload issuer. Throws `INVALID_CONFIG` (`details.reason`: `issuerUrl` | `issuerKey`). */
export function workloadIssuer(
  options: WorkloadIssuerOptions,
): WorkloadIssuerPort & { discovery(): WorkloadIssuerDiscovery } {
  const issuer = checkIssuer(options.issuer);
  const signingKey = checkKey(options.signingKey, 'signing key', true);
  const clock = options.clock ?? systemClock;
  const current = published(signingKey);

  const listed: PublishedKey[] = [current];
  const others = [
    ...(options.nextKey ? [checkKey(options.nextKey, 'next key', false)] : []),
    ...(options.previousKeys ?? []).map((key) => checkKey(key, 'previous key', false)),
  ];
  for (const key of others) {
    const entry = published(key);
    if (!listed.some((known) => known.kid === entry.kid)) listed.push(entry);
  }
  const keys = listed.map((entry) => entry.jwk);

  const header = base64url(
    Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: current.kid }), 'utf8'),
  );

  return {
    issuer,

    async mint(input) {
      const { subject, audience } = input;
      if (typeof subject !== 'string' || subject.length === 0)
        throw invalid('INVALID_INPUT', 'subject', 'A workload token needs a subject');
      if (typeof audience !== 'string' || audience.length === 0)
        throw invalid('INVALID_INPUT', 'audience', 'A workload token needs an audience');
      const ttl = input.ttlSeconds ?? defaultTtlSeconds;
      if (!Number.isInteger(ttl) || ttl < minTtlSeconds || ttl > maxTtlSeconds)
        throw invalid(
          'INVALID_INPUT',
          'ttl',
          `ttlSeconds must be an integer from ${minTtlSeconds} to ${maxTtlSeconds}`,
        );
      const iat = Math.floor(clock.now() / 1000);
      const exp = iat + ttl;
      const payload = base64url(
        Buffer.from(
          JSON.stringify({ iss: issuer, sub: subject, aud: audience, iat, exp, jti: randomUUID() }),
          'utf8',
        ),
      );
      const signingInput = `${header}.${payload}`;
      // ES256 wants the raw R || S pair (RFC 7518 3.4), not DER.
      const signature = sign('sha256', Buffer.from(signingInput, 'utf8'), {
        key: signingKey,
        dsaEncoding: 'ieee-p1363',
      });
      return { token: `${signingInput}.${base64url(signature)}`, expiresAt: exp * 1000 };
    },

    async jwks() {
      return { keys: keys.map((jwk) => ({ ...jwk })) };
    },

    discovery() {
      return {
        issuer,
        jwks_uri: `${issuer}/jwks.json`,
        response_types_supported: ['id_token'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['ES256'],
      };
    },
  };
}
