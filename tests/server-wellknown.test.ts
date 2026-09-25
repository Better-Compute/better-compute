import { createPublicKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isComputeError, type SqlExecutor } from '@better-compute/core';
import {
  createPkiBundle,
  createSigningKey,
  issueJoinToken,
  matchesPin,
  parseCertificate,
  pkiPins,
  sealJoinToken,
  spkiPin,
  verifySignature,
  type PkiBundle,
} from '@better-compute/pki';
import {
  betterCompute,
  pkiJoinCrypto,
  serverVersion,
  type JoinCrypto,
  type JoinPublicKeys,
} from '@better-compute/server';
import { fakeIam } from './support/fake-iam.js';
import { BASE_URL, memoryLogger, options } from './support/server.js';

// GET {basePath}/.well-known/better-compute and the join-key fallback (PLAN.md §6 Install, the
// JOIN KEY DISTRIBUTION decision): with `pki.join` the document also carries JoinService's public
// keys (the encryption JWK and the signing certificate, each with its bcd-config pin), which a
// daemon installed without them accepts only when they match its pins. Never private material.

const TRUST_DOMAIN = 'compute.test';

/** The GET routes touch no store: an executor that refuses everything proves it. */
const noStore = {
  dialect: 'postgres',
  kind: 'pglite',
  query: () => Promise.reject(new Error('no store in this test')),
  transaction: () => Promise.reject(new Error('no store in this test')),
  migrate: () => Promise.reject(new Error('no store in this test')),
  close: async () => {},
} as unknown as SqlExecutor;

function server(join?: JoinCrypto, log = memoryLogger()) {
  return betterCompute({
    ...options(noStore, fakeIam()),
    log,
    ...(join ? { pki: { join } } : {}),
  });
}

const joinFrom = (bundle: PkiBundle) =>
  pkiJoinCrypto({
    trustDomain: bundle.trustDomain,
    nodeCa: bundle.nodeCa,
    signingKey: bundle.joinSigning,
    encryptionKey: bundle.joinEncryption.privateKey,
  });

async function wellKnown(compute: ReturnType<typeof server>) {
  const response = await compute.handler(
    new Request(`${BASE_URL}/api/compute/.well-known/better-compute`),
  );
  const text = await response.text();
  return { status: response.status, headers: response.headers, text, json: JSON.parse(text) };
}

describe('/.well-known/better-compute', () => {
  it('carries the public join keys and the pins pki computes for the bundle', async () => {
    const bundle = createPkiBundle({ trustDomain: TRUST_DOMAIN });
    const pins = pkiPins(bundle);
    const result = await wellKnown(server(joinFrom(bundle)));
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(result.json).toEqual({
      name: 'better-compute',
      version: serverVersion,
      basePath: '/api/compute',
      protocol: { min: 1, max: 1 },
      join: {
        encryptionJwk: pins.joinEncryptionJwk,
        encryptionKeyPin: pins.joinEncryptionKeyPin,
        signingCertificate: Buffer.from(bundle.joinSigning.certificate).toString('base64'),
        signingKeyPin: pins.joinSigningKeyPin,
      },
    });
    // What a daemon checks: the certificate and the JWK hash to its pins.
    const { join } = result.json;
    const certificate = new Uint8Array(Buffer.from(join.signingCertificate, 'base64'));
    expect(spkiPin(parseCertificate(certificate).publicKey)).toBe(join.signingKeyPin);
    const jwkKey = createPublicKey({ key: join.encryptionJwk, format: 'jwk' });
    expect(matchesPin(jwkKey, pins.joinEncryptionKeyPin)).toBe(true);
    expect(matchesPin(jwkKey, pins.joinSigningKeyPin)).toBe(false);
  });

  it('publishes keys that work: a token sealed to the JWK opens, a join signature verifies by pin', async () => {
    const bundle = createPkiBundle({ trustDomain: TRUST_DOMAIN });
    const join = joinFrom(bundle);
    const { json } = await wellKnown(server(join));
    const csr = new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x00]);
    const { token } = issueJoinToken();
    const sealed = sealJoinToken(token, json.join.encryptionJwk, { csr, issuedAt: Date.now() });
    expect(await join.openSealedToken(new TextEncoder().encode(sealed), csr, Date.now())).toBe(
      token,
    );
    const parts = [new TextEncoder().encode('join-response body')];
    const signature = await join.sign('join-response', parts);
    expect(
      verifySignature('join-response', parts, signature as never, { pin: json.join.signingKeyPin }),
    ).toBe(true);
  });

  it('never carries private material', async () => {
    const bundle = createPkiBundle({ trustDomain: TRUST_DOMAIN });
    const { text, json } = await wellKnown(server(joinFrom(bundle)));
    expect(Object.keys(json.join).sort()).toEqual([
      'encryptionJwk',
      'encryptionKeyPin',
      'signingCertificate',
      'signingKeyPin',
    ]);
    expect(Object.keys(json.join.encryptionJwk).sort()).toEqual(['crv', 'kty', 'x', 'y']);
    const encryptionScalar = bundle.joinEncryption.privateKey.export({ format: 'jwk' }).d!;
    // The first base64 line of the signing key's PKCS#8 body.
    const signingKeyLine = bundle.joinSigning.export().privateKeyPem.split('\n')[1]!;
    expect(encryptionScalar.length).toBeGreaterThan(20);
    expect(signingKeyLine.length).toBeGreaterThan(20);
    expect(text).not.toContain(encryptionScalar);
    expect(text).not.toContain(signingKeyLine);
    expect(text).not.toMatch(/PRIVATE KEY|"d"\s*:/);
  });

  it('keeps only the public fields a custom port returns, and omits a malformed answer', async () => {
    const bundle = createPkiBundle({ trustDomain: TRUST_DOMAIN });
    const base = joinFrom(bundle);
    const good = (await base.publicKeys!()) as JoinPublicKeys;
    const leaky: JoinCrypto = {
      ...base,
      publicKeys: () =>
        ({
          ...good,
          encryptionJwk: { ...good.encryptionJwk, d: 'leaked-private-scalar' },
          privateKeyPem: '-----BEGIN PRIVATE KEY-----',
        }) as JoinPublicKeys,
    };
    const leakyResult = await wellKnown(server(leaky));
    expect(leakyResult.text).not.toContain('leaked-private-scalar');
    expect(leakyResult.text).not.toContain('PRIVATE KEY');
    expect(leakyResult.json.join.encryptionKeyPin).toBe(good.encryptionKeyPin);

    const log = memoryLogger();
    const malformed: JoinCrypto = {
      ...base,
      publicKeys: () => ({ ...good, signingKeyPin: 'nope' }),
    };
    const result = await wellKnown(server(malformed, log));
    expect(result.status).toBe(200);
    expect(result.json.join).toBeUndefined();
    expect(log.entries).toMatchObject([{ level: 'error' }]);
  });

  it('omits join without pki.join, without publicKeys, or without the signing certificate', async () => {
    const bundle = createPkiBundle({ trustDomain: TRUST_DOMAIN });
    const bare = await wellKnown(server());
    expect(bare.json).toEqual({
      name: 'better-compute',
      version: serverVersion,
      basePath: '/api/compute',
      protocol: { min: 1, max: 1 },
    });
    const withoutPublicKeys: JoinCrypto = { ...joinFrom(bundle), publicKeys: undefined };
    expect((await wellKnown(server(withoutPublicKeys))).json.join).toBeUndefined();
    const signingKey = createSigningKey();
    const signOnly = pkiJoinCrypto({
      trustDomain: TRUST_DOMAIN,
      nodeCa: bundle.nodeCa,
      signingKey: { sign: (purpose, parts) => signingKey.sign(purpose, parts) },
      encryptionKey: bundle.joinEncryption.privateKey,
    });
    expect(signOnly.publicKeys).toBeUndefined();
    expect((await wellKnown(server(signOnly))).json.join).toBeUndefined();
  });

  it('retries a failing port after a minute and logs each failure', async () => {
    const bundle = createPkiBundle({ trustDomain: TRUST_DOMAIN });
    const base = joinFrom(bundle);
    let calls = 0;
    const flaky: JoinCrypto = {
      ...base,
      async publicKeys() {
        calls += 1;
        throw new Error('key store unavailable');
      },
    };
    const log = memoryLogger();
    const compute = server(flaky, log);
    expect((await wellKnown(compute)).json.join).toBeUndefined();
    expect((await wellKnown(compute)).json.join).toBeUndefined();
    expect(calls).toBe(1);
    expect(log.entries).toHaveLength(1);
    expect(String(log.entries[0]!.fields!.error)).toMatch(/key store unavailable/);

    // A working port is read once and then served from memory.
    let reads = 0;
    const counted: JoinCrypto = {
      ...base,
      publicKeys: () => (reads++, base.publicKeys!()),
    };
    const steady = server(counted);
    await wellKnown(steady);
    await wellKnown(steady);
    expect(reads).toBe(1);
  });

  it('follows a custom basePath, and system.version carries no join section', async () => {
    const bundle = createPkiBundle({ trustDomain: TRUST_DOMAIN });
    const compute = betterCompute({
      ...options(noStore, fakeIam()),
      basePath: '/compute/v1',
      pki: { join: joinFrom(bundle) },
    });
    const response = await compute.handler(
      new Request(`${BASE_URL}/compute/v1/.well-known/better-compute`),
    );
    const json = (await response.json()) as { basePath: string; join?: unknown };
    expect(json.basePath).toBe('/compute/v1');
    expect(json.join).toBeDefined();
    const version = await compute.handler(
      new Request(`${BASE_URL}/compute/v1/system/version`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-better-compute': '1' },
        body: '{}',
      }),
    );
    expect(version.status).toBe(200);
    const body = (await version.json()) as { data: Record<string, unknown> };
    expect(body.data).toEqual({
      name: 'better-compute',
      version: serverVersion,
      basePath: '/compute/v1',
      protocol: { min: 1, max: 1 },
    });
  });

  it('refuses a publicKeys that is not a function', () => {
    const bundle = createPkiBundle({ trustDomain: TRUST_DOMAIN });
    for (const publicKeys of ['keys', 42, {}]) {
      let caught: unknown;
      try {
        server({ ...joinFrom(bundle), publicKeys: publicKeys as never });
      } catch (error) {
        caught = error;
      }
      expect(isComputeError(caught, 'INVALID_CONFIG')).toBe(true);
    }
  });
});
