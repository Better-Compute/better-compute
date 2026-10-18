import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ComputeError, manualClock } from '@better-compute/core';
import {
  base64url,
  fromBase64url,
  generateP256KeyPair,
  spkiSha256,
  staticJwks,
  verifyJwt,
  workloadIssuer,
} from '@better-compute/pki';

const issuerUrl = 'https://compute.example.com/workload';
const start = Date.UTC(2026, 9, 18, 12);

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(fromBase64url(part)).toString('utf8'));
}

async function failure(run: () => unknown): Promise<ComputeError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(ComputeError);
    return error as ComputeError;
  }
  throw new Error('expected a ComputeError');
}

describe('workloadIssuer', () => {
  it('a minted token verifies against the JWKS with the claims asked for', async () => {
    const clock = manualClock(start);
    const key = generateP256KeyPair().privateKey;
    const issuer = workloadIssuer({ issuer: issuerUrl, signingKey: key, clock });
    const { token, expiresAt } = await issuer.mint({
      subject: 'tenant:org_acme:account:acct_1',
      audience:
        '//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/q',
    });
    const claims = await verifyJwt(token, staticJwks(await issuer.jwks()));
    const iat = Math.floor(start / 1000);
    expect(claims.iss).toBe(issuerUrl);
    expect(claims.sub).toBe('tenant:org_acme:account:acct_1');
    expect(claims.aud).toBe(
      '//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/q',
    );
    expect(claims.iat).toBe(iat);
    expect(claims.exp).toBe(iat + 300);
    expect(expiresAt).toBe((iat + 300) * 1000);
    expect(typeof claims.jti).toBe('string');
    expect(claims.jti).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const header = decode(token.split('.')[0]!);
    const kid = base64url(spkiSha256(key));
    expect(header).toMatchObject({ alg: 'ES256', typ: 'JWT', kid });
    const jwks = await issuer.jwks();
    expect(jwks.keys[0]).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig', kid });
    // every token gets its own jti
    const again = await issuer.mint({ subject: 's', audience: 'a' });
    expect(decode(again.token.split('.')[1]!).jti).not.toBe(claims.jti);
  });

  it('honours ttlSeconds', async () => {
    const issuer = workloadIssuer({
      issuer: issuerUrl,
      signingKey: generateP256KeyPair().privateKey,
      clock: manualClock(start),
    });
    for (const ttl of [60, 600]) {
      const { token } = await issuer.mint({ subject: 's', audience: 'a', ttlSeconds: ttl });
      const claims = decode(token.split('.')[1]!);
      expect((claims.exp as number) - (claims.iat as number)).toBe(ttl);
    }
  });

  it('ttl outside 60..600 is INVALID_INPUT', async () => {
    const issuer = workloadIssuer({
      issuer: issuerUrl,
      signingKey: generateP256KeyPair().privateKey,
      clock: manualClock(start),
    });
    for (const ttlSeconds of [59, 601, 1.5, Number.NaN]) {
      const error = await failure(() => issuer.mint({ subject: 's', audience: 'a', ttlSeconds }));
      expect(error.code).toBe('INVALID_INPUT');
      expect(error.details).toMatchObject({ reason: 'ttl' });
    }
  });

  it('refuses an empty subject or audience', async () => {
    const issuer = workloadIssuer({
      issuer: issuerUrl,
      signingKey: generateP256KeyPair().privateKey,
      clock: manualClock(start),
    });
    expect((await failure(() => issuer.mint({ subject: '', audience: 'a' }))).code).toBe(
      'INVALID_INPUT',
    );
    expect((await failure(() => issuer.mint({ subject: 's', audience: '' }))).code).toBe(
      'INVALID_INPUT',
    );
  });

  it('rollover publishes next, signs with current, keeps previous', async () => {
    const clock = manualClock(start);
    const a = generateP256KeyPair().privateKey;
    const b = generateP256KeyPair().privateKey;
    const c = generateP256KeyPair().privateKey;
    const old = workloadIssuer({ issuer: issuerUrl, signingKey: a, clock });
    const { token: inFlight } = await old.mint({ subject: 's', audience: 'a' });

    const current = workloadIssuer({
      issuer: issuerUrl,
      signingKey: b,
      nextKey: c,
      previousKeys: [a],
      clock,
    });
    const jwks = await current.jwks();
    expect(jwks.keys).toHaveLength(3);
    expect(jwks.keys.map((key) => key.kid)).toEqual(
      [b, c, a].map((key) => base64url(spkiSha256(key))),
    );
    // a token minted before the rollover still verifies against the later issuer's keys
    const source = staticJwks(jwks);
    expect((await verifyJwt(inFlight, source)).iss).toBe(issuerUrl);
    // new tokens are signed by the current key, never by next
    for (let i = 0; i < 5; i++) {
      const { token } = await current.mint({ subject: 's', audience: 'a' });
      expect(decode(token.split('.')[0]!).kid).toBe(base64url(spkiSha256(b)));
    }
    // and the next key can be promoted later: a token minted by it verifies against today's JWKS
    const promoted = workloadIssuer({ issuer: issuerUrl, signingKey: c, previousKeys: [b], clock });
    const { token } = await promoted.mint({ subject: 's', audience: 'a' });
    expect((await verifyJwt(token, source)).iss).toBe(issuerUrl);
  });

  it('refuses an RSA key and an http issuer', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    const ec = generateP256KeyPair().privateKey;
    const p384 = generateKeyPairSync('ec', { namedCurve: 'P-384' }).privateKey;
    const config = (options: Partial<Parameters<typeof workloadIssuer>[0]>) => () =>
      workloadIssuer({ issuer: issuerUrl, signingKey: ec, ...options });

    for (const bad of [
      config({ signingKey: rsa }),
      config({ signingKey: p384 }),
      config({ nextKey: rsa }),
      config({ previousKeys: [p384] }),
      config({ signingKey: generateP256KeyPair().publicKey }),
    ]) {
      try {
        bad();
        throw new Error('expected a ComputeError');
      } catch (error) {
        expect(error).toBeInstanceOf(ComputeError);
        expect((error as ComputeError).code).toBe('INVALID_CONFIG');
        expect((error as ComputeError).details).toMatchObject({ reason: 'issuerKey' });
      }
    }

    for (const issuer of [
      'http://compute.example.com',
      'ftp://compute.example.com',
      'compute.example.com',
      'https://compute.example.com/',
      'https://compute.example.com/workload/',
      'https://compute.example.com/?a=1',
      'https://compute.example.com/#frag',
      'https://compute.example.com?',
      'http://localhost.example.com',
      '',
    ]) {
      try {
        config({ issuer })();
        throw new Error(`expected a ComputeError for ${issuer}`);
      } catch (error) {
        expect(error).toBeInstanceOf(ComputeError);
        expect((error as ComputeError).code).toBe('INVALID_CONFIG');
        expect((error as ComputeError).details).toMatchObject({ reason: 'issuerUrl' });
      }
    }

    expect(config({ issuer: 'http://localhost:3000' })().issuer).toBe('http://localhost:3000');
    expect(config({ issuer: 'http://127.0.0.1:8080/workload' })().issuer).toBe(
      'http://127.0.0.1:8080/workload',
    );
    expect(config({ issuer: 'https://compute.example.com' })().issuer).toBe(
      'https://compute.example.com',
    );
  });

  it('serves an OIDC discovery document', () => {
    const issuer = workloadIssuer({
      issuer: issuerUrl,
      signingKey: generateP256KeyPair().privateKey,
    });
    expect(issuer.discovery()).toEqual({
      issuer: issuerUrl,
      jwks_uri: `${issuerUrl}/jwks.json`,
      response_types_supported: ['id_token'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['ES256'],
    });
  });

  it('the JWKS never carries private material', async () => {
    const keys = [1, 2, 3, 4].map(() => generateP256KeyPair().privateKey);
    const issuer = workloadIssuer({
      issuer: issuerUrl,
      signingKey: keys[0]!,
      nextKey: keys[1]!,
      previousKeys: [keys[2]!, keys[3]!],
    });
    const jwks = await issuer.jwks();
    expect(jwks.keys).toHaveLength(4);
    for (const key of jwks.keys) {
      expect(Object.keys(key).sort()).toEqual(['alg', 'crv', 'kid', 'kty', 'use', 'x', 'y']);
      expect(key).not.toHaveProperty('d');
    }
    // mutating what jwks() returned changes nothing for the next caller
    (jwks.keys[0] as Record<string, unknown>).x = 'tampered';
    expect((await issuer.jwks()).keys[0]!.x).not.toBe('tampered');
    // a mint failure never echoes key material
    const text = JSON.stringify(
      await failure(() => issuer.mint({ subject: 's', audience: 'a', ttlSeconds: 1 })),
    );
    const d = keys[0]!.export({ format: 'jwk' }).d as string;
    expect(text).not.toContain(d);
  });

  it('a signature from a key outside the JWKS does not verify', async () => {
    const issuer = workloadIssuer({
      issuer: issuerUrl,
      signingKey: generateP256KeyPair().privateKey,
      clock: manualClock(start),
    });
    const rogue = generateP256KeyPair().privateKey;
    const { token } = await issuer.mint({ subject: 's', audience: 'a' });
    const [h, p] = token.split('.') as [string, string];
    const forged = `${h}.${p}.${base64url(sign('sha256', Buffer.from(`${h}.${p}`), { key: rogue, dsaEncoding: 'ieee-p1363' }))}`;
    await expect(verifyJwt(forged, staticJwks(await issuer.jwks()))).rejects.toThrow();
  });
});
