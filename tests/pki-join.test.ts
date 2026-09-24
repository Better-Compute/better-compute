import { createCipheriv, createPrivateKey, createPublicKey, diffieHellman } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fromBinary } from '@bufbuild/protobuf';
import { ComputeError, manualClock, type SqlExecutor } from '@better-compute/core';
import { setSimClock, useSimClock } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import { AgentRole, JoinResponseBodySchema } from '@better-compute/protocol';
import {
  base64url,
  claimsFromWire,
  concatKdf,
  createCsr,
  createNodeCa,
  createSigningKey,
  generateP256KeyPair,
  issueJoinToken,
  joinTokenAttestor,
  matchesExpect,
  nodeSpiffeId,
  openJwe,
  openSealedToken,
  parseJoinToken,
  sealJoinToken,
  sealJwe,
  signJoinResponse,
  signTrustBundle,
  spkiPin,
  verifyJoinResponse,
  verifyJoinToken,
  verifyTrustBundle,
  type JoinTokenRecord,
} from '@better-compute/pki';

const now = Date.UTC(2026, 8, 24, 12);
const claims = {
  productUuid: '4C4C4544-0042-3510-8052-B7C04F4E4E32',
  serial: 'SN-7731',
  macs: ['3C:EC:EF:10:20:30', '3c:ec:ef:10:20:31'],
  gpuUuids: ['GPU-6f7c2a11-0000-4b3a-9e5d-000000000001'],
};

describe('JWE (ECDH-ES+A256KW, A256GCM)', () => {
  it('matches the RFC 7518 Appendix C key agreement vector', () => {
    const alice = createPrivateKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: 'gI0GAILBdu7T53akrFmMyGcsF3n5dO7MmwNBHKW5SV0',
        y: 'SLW_xSffzlPWrHEVI30DHM_4egVwt3NQqeUD7nMFpps',
        d: '0_NxaRPUMQoAJt50Gz8YiTr8gRTwyEaCumd-MToTmIo',
      },
      format: 'jwk',
    });
    const bob = createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: 'weNJy2HscCSM6AEDTDg04biOvhFhyyWvOHQfeF_PxMQ',
        y: 'e8lnCO-AlStT-NJVX-crhB7QRYhiix03illJOVAOyck',
      },
      format: 'jwk',
    });
    const z = new Uint8Array(diffieHellman({ privateKey: alice, publicKey: bob }));
    expect([...z]).toEqual([
      158, 86, 217, 29, 129, 113, 53, 211, 114, 131, 66, 131, 191, 132, 38, 156, 251, 49, 110, 163,
      218, 128, 106, 72, 246, 218, 167, 121, 140, 254, 144, 196,
    ]);
    const derived = concatKdf(
      z,
      'A128GCM',
      128,
      new TextEncoder().encode('Alice'),
      new TextEncoder().encode('Bob'),
    );
    expect(base64url(derived)).toBe('VqqN6vgjbSBcIijNcacQGg');
  });

  it('uses RFC 3394 AES key wrap (256-bit KEK, 256-bit key vector)', () => {
    const kek = Buffer.from(
      '000102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F',
      'hex',
    );
    const key = Buffer.from(
      '00112233445566778899AABBCCDDEEFF000102030405060708090A0B0C0D0E0F',
      'hex',
    );
    const wrap = createCipheriv('id-aes256-wrap', kek, Buffer.from('a6a6a6a6a6a6a6a6', 'hex'));
    expect(
      Buffer.concat([wrap.update(key), wrap.final()])
        .toString('hex')
        .toUpperCase(),
    ).toBe('28C9F404C4B810F4CBCCB35CFB87F8263F5786E2D80ED326CBC7F0E71A99F43BFB988B9B7A02DD21');
  });

  it('round-trips, authenticates the header and fails closed', () => {
    const recipient = generateP256KeyPair();
    const jwe = sealJwe('secret value', recipient.publicKey, { kid: 'k1', typ: 'x' });
    const opened = openJwe(jwe, recipient.privateKey, { typ: 'x' });
    expect(new TextDecoder().decode(opened.plaintext)).toBe('secret value');
    expect(opened.header).toMatchObject({ alg: 'ECDH-ES+A256KW', enc: 'A256GCM', kid: 'k1' });

    const parts = jwe.split('.');
    const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString());
    const reheadered = [
      base64url(Buffer.from(JSON.stringify({ ...header, kid: 'k2' }))),
      ...parts.slice(1),
    ].join('.');
    const flipped = [
      ...parts.slice(0, 3),
      parts[3]!.slice(0, -2) + (parts[3]!.endsWith('A') ? 'BA' : 'AA'),
      parts[4],
    ].join('.');
    for (const bad of [reheadered, flipped, parts.slice(0, 4).join('.'), 'x'.repeat(300_000)])
      expect(() => openJwe(bad, recipient.privateKey)).toThrow('Cannot open JWE');
    expect(() => openJwe(jwe, generateP256KeyPair().privateKey)).toThrow('Cannot open JWE');
    expect(() => openJwe(jwe, recipient.privateKey, { typ: 'y' })).toThrow('Cannot open JWE');
    expect(() => sealJwe('x', recipient.publicKey, { alg: 'none' })).toThrow(/reserved/);

    // An off-curve ephemeral key is refused (invalid-curve attack).
    const offCurve = { ...header, epk: { ...header.epk, y: header.epk.x } };
    const attack = [base64url(Buffer.from(JSON.stringify(offCurve))), ...parts.slice(1)].join('.');
    expect(() => openJwe(attack, recipient.privateKey)).toThrow('Cannot open JWE');
  });
});

describe('join tokens', () => {
  const record = (
    overrides: Partial<JoinTokenRecord> = {},
  ): JoinTokenRecord & { token: string } => {
    const issued = issueJoinToken();
    return {
      token: issued.token,
      id: issued.id,
      tenantId: 'org_acme',
      role: 'node',
      poolId: 'pool_h100',
      siteId: null,
      secretHash: issued.secretHash,
      usesLeft: 1,
      expect: null,
      allowReclaim: false,
      expiresAt: now + 3_600_000,
      revokedAt: null,
      ...overrides,
    };
  };

  it('mints bcjt_<id>.<secret> and stores only the secret hash', () => {
    const issued = issueJoinToken();
    expect(issued.token).toMatch(/^bcjt_jt_[0-9a-z]{26}\.[A-Za-z0-9_-]{43}$/);
    expect(parseJoinToken(issued.token)?.id).toBe(issued.id);
    expect(Buffer.from(issued.secretHash).toString('hex')).not.toContain(
      issued.token.split('.')[1],
    );
    expect(parseJoinToken('bcjt_jt_x.y')).toBeUndefined();
  });

  it('admits a good token and names every refusal', () => {
    const good = record();
    const context = { now, role: 'node' as const, claims };
    expect(verifyJoinToken(good.token, good, context)).toEqual({
      ok: true,
      tokenId: good.id,
      tenantId: 'org_acme',
      role: 'node',
      poolId: 'pool_h100',
      allowReclaim: false,
    });
    const refusals: [string, JoinTokenRecord | undefined, string, Partial<typeof context>?][] = [
      ['not a token', good, 'malformed'],
      [good.token, undefined, 'unknown'],
      [good.token, { ...good, secretHash: new Uint8Array(32) }, 'secret-mismatch'],
      [good.token, { ...good, revokedAt: now - 1 }, 'revoked'],
      [good.token, { ...good, expiresAt: now }, 'expired'],
      [good.token, { ...good, usesLeft: 0 }, 'exhausted'],
      [good.token, good, 'role-mismatch', { role: 'site' }],
      [good.token, { ...good, role: 'discovery' }, 'role-mismatch'],
      [good.token, { ...good, expect: { serial: 'OTHER' } }, 'expect-mismatch'],
    ];
    for (const [token, row, reason, extra] of refusals)
      expect(verifyJoinToken(token, row, { ...context, ...extra }), reason).toEqual({
        ok: false,
        reason,
      });
    expect(
      verifyJoinToken(good.token, { ...good, role: 'discovery' }, { ...context, role: 'ramdisk' })
        .ok,
    ).toBe(true);
  });

  it('matches expect bindings after format normalization; blank values never match', () => {
    expect(
      matchesExpect(
        { mac: '3c-ec-ef-10-20-31', productUuid: '4c4c4544-0042-3510-8052-b7c04f4e4e32' },
        claims,
      ),
    ).toBe(true);
    expect(matchesExpect({ gpuUuid: '6F7C2A11-0000-4b3a-9e5d-000000000001' }, claims)).toBe(true);
    expect(matchesExpect({ mac: '3c:ec:ef:99:99:99' }, claims)).toBe(false);
    expect(matchesExpect({ serial: 'brd-9' }, { ...claims, boardSerial: 'BRD-9' })).toBe(true);
    expect(matchesExpect({ serial: ' ' }, { ...claims, serial: ' ' })).toBe(false);
    expect(matchesExpect({ productUuid: claims.productUuid }, { macs: [] })).toBe(false);
  });

  it('seals tokens to JoinService bound to the CSR, so a relay cannot reuse them', () => {
    const joinKey = generateP256KeyPair();
    const agent = generateP256KeyPair();
    const csr = createCsr(agent.privateKey);
    const { token } = issueJoinToken();
    const sealed = sealJoinToken(token, joinKey.publicKey, { csr, issuedAt: now });
    expect(sealed).not.toContain(token.split('.')[1]);
    expect(
      openSealedToken(sealed, joinKey.privateKey, { csr, now: now + 5_000, maxAgeMs: 600_000 }),
    ).toEqual({
      token,
      tokenId: parseJoinToken(token)!.id,
      issuedAt: now,
    });

    const reason = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        expect(error).toBeInstanceOf(ComputeError);
        expect((error as ComputeError).code).toBe('ACCESS_DENIED');
        return (error as ComputeError).details?.reason;
      }
      return 'accepted';
    };
    const relayCsr = createCsr(generateP256KeyPair().privateKey);
    expect(reason(() => openSealedToken(sealed, joinKey.privateKey, { csr: relayCsr }))).toBe(
      'sealed for another CSR',
    );
    expect(reason(() => openSealedToken(sealed, generateP256KeyPair().privateKey, { csr }))).toBe(
      'sealed token does not open',
    );
    expect(
      reason(() =>
        openSealedToken(sealed, joinKey.privateKey, {
          csr,
          now: now + 3_600_000,
          maxAgeMs: 600_000,
        }),
      ),
    ).toBe('sealed token is too old');
    // A JWE to the same key for another purpose never opens as a join token.
    const secretJwe = sealJwe(token, joinKey.publicKey, { typ: 'secret+jwe' });
    expect(reason(() => openSealedToken(secretJwe, joinKey.privateKey, { csr }))).toBe(
      'sealed token does not open',
    );
    expect(
      openSealedToken(new TextEncoder().encode(sealed), joinKey.privateKey, { csr }).token,
    ).toBe(token);
  });
});

describe('the join-token attestor on the base schema', () => {
  let db: SqlExecutor;
  beforeAll(async () => {
    db = pglite();
    await db.migrate();
    await useSimClock(db, now);
  });
  afterAll(async () => {
    await db.close();
  });

  async function insert(overrides: Record<string, unknown> = {}) {
    const issued = issueJoinToken();
    const row = {
      id: issued.id,
      tenant_id: 'org_acme',
      role: 'node',
      pool_id: 'pool_h100',
      secret_hash: issued.secretHash,
      uses_left: 2,
      expect: null as unknown,
      allow_reclaim: false,
      expires_at: new Date(now + 3_600_000),
      ...overrides,
    };
    await db.query(
      `INSERT INTO join_tokens (id, tenant_id, role, pool_id, secret_hash, uses_left, expect, allow_reclaim, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        row.id,
        row.tenant_id,
        row.role,
        row.pool_id,
        row.secret_hash,
        row.uses_left,
        row.expect,
        row.allow_reclaim,
        row.expires_at,
      ],
    );
    return issued;
  }

  const attest = (
    attestor: ReturnType<typeof joinTokenAttestor>,
    token: string,
    role: 'node' | 'site' = 'node',
  ) =>
    db.transaction((tx) =>
      attestor.verify(
        { attestor: 'join-token', payload: new TextEncoder().encode(token) },
        { tx, clock: manualClock(0), claims, role },
      ),
    );

  it('admits, decrements uses and refuses once exhausted, at compute_now()', async () => {
    const refusals: string[] = [];
    const attestor = joinTokenAttestor({ onRefusal: (refusal) => refusals.push(refusal.reason) });
    expect(attestor).toMatchObject({ extension: 'attestor', id: 'join-token' });
    const issued = await insert();
    await expect(attest(attestor, issued.token)).resolves.toEqual({
      tenantId: 'org_acme',
      role: 'node',
      tokenId: issued.id,
      poolId: 'pool_h100',
    });
    await attest(attestor, issued.token);
    await expect(attest(attestor, issued.token)).rejects.toMatchObject({
      code: 'ACCESS_DENIED',
      message: 'Join refused',
    });
    const { rows } = await db.query<{ uses_left: number }>(
      'SELECT uses_left FROM join_tokens WHERE id = $1',
      [issued.id],
    );
    expect(rows[0]!.uses_left).toBe(0);

    const expiring = await insert({ expires_at: new Date(now + 60_000) });
    await setSimClock(db, now + 60_000);
    await expect(attest(attestor, expiring.token)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    const bound = await insert({ expect: JSON.stringify({ serial: 'sn-7731' }) });
    await expect(attest(attestor, bound.token)).resolves.toMatchObject({ tokenId: bound.id });
    await expect(attest(attestor, 'bcjt_garbage')).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    expect(refusals).toEqual(['exhausted', 'expired', 'malformed']);
  });

  it('never lets two concurrent joins spend a single-use token twice', async () => {
    const attestor = joinTokenAttestor();
    const issued = await insert({ uses_left: 1 });
    const results = await Promise.allSettled([
      attest(attestor, issued.token),
      attest(attestor, issued.token),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  });
});

describe('JoinResponse', () => {
  async function joined() {
    const clock = manualClock(now);
    const nodeCa = createNodeCa({ clock });
    const signer = createSigningKey({ clock, commonName: 'better-compute join signing' });
    const agent = generateP256KeyPair();
    const csr = createCsr(agent.privateKey);
    const nodeId = 'node_01k5w0000000000000000000aa';
    const issued = await nodeCa.sign(csr, {
      usage: 'client',
      role: 'node',
      ttlSeconds: 86_400,
      uriSans: [nodeSpiffeId({ trustDomain: 'compute.test', siteId: 'site_fra1', nodeId })],
    });
    const response = signJoinResponse(
      {
        nodeId,
        certChain: [issued.certificate, ...issued.chain],
        csr,
        trustDomain: 'compute.test',
        siteId: 'site_fra1',
        role: 'node',
        issuedAt: now,
        trust: { version: 1 },
      },
      signer,
    );
    return { nodeCa, signer, csr, response, nodeId };
  }

  it('verifies under the pinned key and binds the CSR, node, site and role', async () => {
    const { nodeCa, signer, csr, response, nodeId } = await joined();
    const body = verifyJoinResponse(response, {
      signer: { pin: spkiPin(signer.publicKey) },
      csr,
      nodeCaRoots: [nodeCa.certificate],
      now,
    });
    expect(body).toMatchObject({
      nodeId,
      trustDomain: 'compute.test',
      siteId: 'site_fra1',
      role: AgentRole.NODE,
    });
    expect(response.sig?.kid).toBe(signer.kid);
    expect(response.sig?.sig).toHaveLength(64);
  });

  it('rejects a wrong pin, another CSR and a relay-edited body', async () => {
    const { signer, csr, response } = await joined();
    const pin = { pin: spkiPin(signer.publicKey) };
    expect(() =>
      verifyJoinResponse(response, {
        signer: { pin: spkiPin(generateP256KeyPair().publicKey) },
        csr,
      }),
    ).toThrow('Join response rejected');
    expect(() =>
      verifyJoinResponse(response, {
        signer: pin,
        csr: createCsr(generateP256KeyPair().privateKey),
      }),
    ).toThrow();
    const body = fromBinary(JoinResponseBodySchema, response.body);
    expect(body.csrSha256).toHaveLength(32);
    const edited = { ...response, body: response.body.slice() };
    edited.body[edited.body.length - 3]! ^= 1;
    expect(() => verifyJoinResponse(edited, { signer: pin, csr })).toThrow();
    // Re-signing with a gateway's own key does not help: the pin names JoinService's key.
    const forged = signJoinResponse(
      {
        nodeId: 'node_x',
        certChain: body.certChain,
        csr,
        trustDomain: 'compute.test',
        siteId: 'site_fra1',
        role: 'node',
        issuedAt: now,
      },
      createSigningKey(),
    );
    expect(() => verifyJoinResponse(forged, { signer: pin, csr })).toThrow();
  });

  it('signs trust bundles that only move forward', () => {
    const signer = createSigningKey();
    const bundle = signTrustBundle({ version: 3 }, signer);
    expect(verifyTrustBundle(bundle, { publicKey: signer.publicKey }, 2n).version).toBe(3n);
    expect(() => verifyTrustBundle(bundle, { publicKey: signer.publicKey }, 3n)).toThrow();
    expect(() => verifyTrustBundle(bundle, { publicKey: createSigningKey().publicKey })).toThrow();
    // A join-response signature never verifies as a trust bundle (purpose separation).
    expect(() =>
      verifyTrustBundle(
        { ...bundle, signature: signer.sign('join-response', [bundle.body]) },
        { publicKey: signer.publicKey },
      ),
    ).toThrow();
  });
});

describe('claimsFromWire', () => {
  it('reads wire claims', () => {
    expect(
      claimsFromWire({
        $typeName: 'bettercompute.agent.v1.HardwareClaims',
        productUuid: 'u',
        productSerial: 's',
        boardSerial: '',
        chassisSerial: 'c',
        sysVendor: '',
        productName: '',
        permanentMacs: ['m'],
        gpuUuids: ['g'],
        bmcMac: '',
        hostname: 'h',
        bootId: '',
      }),
    ).toEqual({
      productUuid: 'u',
      serial: 's',
      chassisSerial: 'c',
      macs: ['m'],
      gpuUuids: ['g'],
      hostname: 'h',
    });
  });
});
