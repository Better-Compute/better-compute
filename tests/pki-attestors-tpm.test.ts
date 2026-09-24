import { generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isAttestationDeferral,
  manualClock,
  type AttestationContext,
  type AttestationDeferral,
  type SqlTx,
} from '@better-compute/core';
import {
  akAttributes,
  buildCertificate,
  createCsr,
  createNodeCa,
  createSigningKey,
  distinguishedName,
  ekAttributes,
  generateP256KeyPair,
  marshalTpmPublic,
  sha256,
  TPM_ALG,
  TPMA_OBJECT,
  tpmAttestor,
  tpmProducer,
  type SoftwareTpm,
  type TpmAttestorOptions,
} from '@better-compute/pki';
import { AgentRole } from '@better-compute/protocol';
import { createJoinService, pkiJoinCrypto } from '@better-compute/server';
import { closeFixtures, computeFixture, runAgentJoin } from '@better-compute/testing';

// The v0.5 `tpm` attestor: a stateless two-round join (challenge deferral) over a software TPM.

afterEach(closeFixtures);

const now = Date.UTC(2026, 8, 24, 12);
const year = 365 * 86_400_000;

/** A manufacturer EK CA (ECDSA root) and a certificate for an RSA EK. */
function manufacturer(name = 'Acme TPM EK Root') {
  const key = generateP256KeyPair();
  const subject = distinguishedName({ commonName: name });
  const root = buildCertificate(
    {
      serial: new Uint8Array([1]),
      issuer: subject,
      subject,
      notBefore: now - year,
      notAfter: now + 10 * year,
      publicKey: key.publicKey,
      ca: {},
    },
    key.privateKey,
  );
  const certify = (ekPublicKey: KeyObject) =>
    buildCertificate(
      {
        serial: new Uint8Array(randomBytes(8)).map((b, i) => (i === 0 ? b & 0x7f : b)),
        issuer: subject,
        subject: distinguishedName({ commonName: 'EK' }),
        notBefore: now - year,
        notAfter: now + 10 * year,
        publicKey: ekPublicKey,
      },
      key.privateKey,
    );
  return { root, certify };
}

function softwareTpm(
  options: { certifiedBy?: ReturnType<typeof manufacturer>; akAttrs?: number } = {},
): SoftwareTpm {
  const ek = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const ak = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const bank = new Map<number, Uint8Array>();
  for (let pcr = 0; pcr < 8; pcr++) bank.set(pcr, new Uint8Array(32).fill(pcr + 1));
  return {
    ekPrivateKey: ek.privateKey,
    ekPublic: marshalTpmPublic({
      key: ek.publicKey,
      attributes: ekAttributes,
      authPolicy: new Uint8Array(32).fill(0x83),
      symmetric: { alg: TPM_ALG.AES, keyBits: 128, mode: TPM_ALG.CFB },
    }),
    akPrivateKey: ak.privateKey,
    akPublic: marshalTpmPublic({
      key: ak.publicKey,
      attributes: options.akAttrs ?? akAttributes,
      scheme: { alg: TPM_ALG.ECDSA, hash: TPM_ALG.SHA256 },
    }),
    ...(options.certifiedBy ? { ekCertificate: options.certifiedBy.certify(ek.publicKey) } : {}),
    pcrs: new Map([[TPM_ALG.SHA256 as number, bank]]),
  };
}

const challengeKey = new Uint8Array(randomBytes(32));
const acme = manufacturer();
const known = new Set<string>();
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

function attestor(overrides: Partial<TpmAttestorOptions> = {}, reasons: string[] = []) {
  return tpmAttestor({
    challengeKey,
    ekRoots: [acme.root],
    resolve: async (_tx, identity) =>
      known.has(hex(identity.ekSha256))
        ? { tenantId: 'org_acme', role: 'node', poolId: 'pool_tpm' }
        : undefined,
    onRefusal: (r) => void reasons.push(r.reason),
    ...overrides,
  });
}

function enroll(tpm: SoftwareTpm) {
  known.add(hex(sha256(tpm.ekPublic)));
}

async function twoRounds(
  a: ReturnType<typeof tpmAttestor>,
  tpm: SoftwareTpm,
  options: {
    clock?: ReturnType<typeof manualClock>;
    csr2?: Uint8Array;
    advance?: number;
    tamper?: (payload: Uint8Array) => Uint8Array;
  } = {},
) {
  const clock = options.clock ?? manualClock(now);
  const csr = sha256(createCsr(generateP256KeyPair().privateKey));
  const ctx = (csrSha256: Uint8Array): AttestationContext => ({
    // No node_bindings row: every EK here is new (the JoinService tests cover bound EKs).
    tx: { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as SqlTx,
    clock,
    claims: {},
    role: 'node',
    csrSha256,
  });
  const producer = tpmProducer(tpm);
  const first = await a.verify(await producer.produce({ claims: {}, nonce: csr }), ctx(csr));
  expect(isAttestationDeferral(first)).toBe(true);
  const deferral = first as AttestationDeferral;
  expect(deferral.deferred).toBe('challenge');
  if (options.advance) clock.advance(options.advance);
  const answer = await producer.produce({ claims: {}, nonce: csr, challenge: deferral.challenge! });
  const payload = options.tamper ? options.tamper(answer.payload) : answer.payload;
  return a.verify({ attestor: 'tpm', payload }, ctx(options.csr2 ?? csr));
}

const editAnswer = (edit: (e: Record<string, any>) => void) => (payload: Uint8Array) => {
  const e = JSON.parse(new TextDecoder().decode(payload));
  edit(e);
  return new TextEncoder().encode(JSON.stringify(e));
};

describe('tpm attestor', () => {
  it('challenges, then admits the EK holder whose AK quotes fresh, policy-compliant PCRs', async () => {
    const tpm = softwareTpm({ certifiedBy: acme });
    enroll(tpm);
    const seen: string[] = [];
    const a = attestor({
      resolve: async (_tx, identity) => {
        seen.push(hex(identity.ekSha256));
        expect(identity.ekCertificate?.issuer).toContain('Acme TPM EK Root');
        expect(identity.pcrs.get(TPM_ALG.SHA256)?.get(7)).toEqual(new Uint8Array(32).fill(8));
        return { tenantId: 'org_acme', role: 'node', poolId: 'pool_tpm' };
      },
    });
    await expect(twoRounds(a, tpm)).resolves.toEqual({
      tenantId: 'org_acme',
      role: 'node',
      poolId: 'pool_tpm',
      bind: sha256(tpm.ekPublic),
    });
    expect(seen).toEqual([hex(sha256(tpm.ekPublic))]);
  });

  it('refuses answers for another CSR, late answers, forged secrets and PCR lies', async () => {
    const tpm = softwareTpm({ certifiedBy: acme });
    enroll(tpm);
    const reasons: string[] = [];
    const a = attestor({}, reasons);
    const denied = { code: 'ACCESS_DENIED' };
    await expect(twoRounds(a, tpm, { csr2: sha256(new Uint8Array([1])) })).rejects.toMatchObject(
      denied,
    );
    await expect(twoRounds(a, tpm, { advance: 5 * 60_000 + 1 })).rejects.toMatchObject(denied);
    await expect(
      twoRounds(a, tpm, {
        tamper: editAnswer((e) => (e.answer.secret = Buffer.alloc(32, 1).toString('base64url'))),
      }),
    ).rejects.toMatchObject(denied);
    await expect(
      twoRounds(a, tpm, {
        tamper: editAnswer((e) => (e.answer.pcrs[TPM_ALG.SHA256]['7'] = '00'.repeat(32))),
      }),
    ).rejects.toMatchObject(denied);
    await expect(
      twoRounds(a, tpm, {
        tamper: editAnswer((e) => (e.answer.state = e.answer.state.slice(0, -4) + 'AAAA')),
      }),
    ).rejects.toMatchObject(denied);
    // Another machine's AK cannot answer for this one's challenge.
    const other = softwareTpm({ certifiedBy: acme });
    await expect(
      twoRounds(a, tpm, {
        tamper: editAnswer((e) => (e.ak = Buffer.from(other.akPublic).toString('base64url'))),
      }),
    ).rejects.toMatchObject(denied);
    expect(reasons).toEqual([
      'challenge-for-another-csr',
      'challenge-expired',
      'credential',
      'pcr-digest',
      'state',
      'challenge-for-another-key',
    ]);
  });

  it('refuses unknown or uncertified EKs, foreign manufacturers, non-AK keys and PCR policy failures', async () => {
    const reasons: string[] = [];
    const a = attestor({}, reasons);
    const denied = { code: 'ACCESS_DENIED' };
    await expect(twoRounds(a, softwareTpm({ certifiedBy: acme }))).rejects.toMatchObject(denied); // not enrolled
    await expect(twoRounds(a, softwareTpm())).rejects.toMatchObject(denied);
    await expect(
      twoRounds(a, softwareTpm({ certifiedBy: manufacturer('Evil Root') })),
    ).rejects.toMatchObject(denied);
    const swapped = softwareTpm({ certifiedBy: acme });
    swapped.ekCertificate = acme.certify(
      generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey,
    );
    await expect(twoRounds(a, swapped)).rejects.toMatchObject(denied);
    await expect(
      twoRounds(
        a,
        softwareTpm({ certifiedBy: acme, akAttrs: akAttributes & ~TPMA_OBJECT.fixedTPM }),
      ),
    ).rejects.toMatchObject(denied);
    const measured = softwareTpm({ certifiedBy: acme });
    enroll(measured);
    const strict = attestor(
      {
        pcrPolicy: (pcrs) =>
          pcrs.get(TPM_ALG.SHA256)?.get(7)?.[0] === 0xaa ? undefined : 'secure-boot',
      },
      reasons,
    );
    await expect(twoRounds(strict, measured)).rejects.toMatchObject(denied);
    expect(reasons).toEqual([
      'unknown-ek',
      'no-ek-certificate',
      'ek-certificate-chain',
      'ek-certificate-key',
      'ak-attributes',
      'pcr-policy:secure-boot',
    ]);
    // Labs (swtpm) may opt out of the EK certificate.
    const lab = softwareTpm();
    enroll(lab);
    await expect(twoRounds(attestor({ allowUncertifiedEk: true }), lab)).resolves.toMatchObject({
      role: 'node',
    });
  });

  it('joins through the real JoinService with runAgentJoin: challenge, answer, certificate', async () => {
    const fixture = await computeFixture({ clock: 'sim' });
    const { database, compute, tenants } = fixture;
    await database.query(
      `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site_t', $1, 'shared', 'eu-1', 1)`,
      [tenants.root.id],
    );
    await database.query(
      `INSERT INTO pools (id, owner_tenant_id, site_id, class, gpu_model, sharing, agent, policy, version)
       VALUES ('pool_tpm', $1, 'site_t', 'metal-host', 'H100', 'exclusive', 'bcd', '{}', 1)`,
      [tenants.root.id],
    );
    const tpm = softwareTpm({ certifiedBy: acme });
    enroll(tpm);
    const nodeCa = createNodeCa({ clock: fixture.clock, trustDomain: 'compute.test' });
    const signingKey = createSigningKey({ clock: fixture.clock });
    const service = createJoinService({
      database,
      clock: fixture.clock,
      work: compute.context.work,
      events: compute.context.events,
      crypto: pkiJoinCrypto({
        trustDomain: 'compute.test',
        nodeCa,
        signingKey,
        encryptionKey: generateP256KeyPair().privateKey,
      }),
      attestors: [
        attestor({
          resolve: async (_tx, identity) =>
            known.has(hex(identity.ekSha256))
              ? { tenantId: tenants.root.id, role: 'node', poolId: 'pool_tpm' }
              : undefined,
        }),
      ],
    });
    const deferrals: string[] = [];
    const joined = await runAgentJoin({
      send: (request) => service.join(request),
      signer: { publicKey: signingKey.publicKey },
      wait: (ms) => fixture.advance(ms).then(() => undefined),
      now: () => fixture.clock.now(),
      nodeCaRoots: [nodeCa.certificate],
      claims: {
        productUuid: '4c4c4544-0042-3510-8052-b7c04f4e4e77',
        productSerial: 'SN-TPM-1',
        permanentMacs: ['3c:ec:ef:77:77:77'],
      },
      attestor: tpmProducer(tpm),
      onDeferral: (d) => void deferrals.push(d.kind),
    });
    expect(deferrals).toEqual(['challenge']);
    expect(joined.rounds).toBe(2);
    expect(joined.body.role).toBe(AgentRole.NODE);
    const { rows } = await database.query<{ pool_id: string }>(
      'SELECT pool_id FROM nodes WHERE id = $1',
      [joined.body.nodeId],
    );
    expect(rows).toEqual([{ pool_id: 'pool_tpm' }]);
  });

  it('enrolls an unknown EK after operator approval, binds it, and later re-joins reclaim the node', async () => {
    const fixture = await computeFixture({ clock: 'sim' });
    const { database, compute, tenants } = fixture;
    await database.query(
      `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site_t', $1, 'shared', 'eu-1', 1)`,
      [tenants.root.id],
    );
    await database.query(
      `INSERT INTO pools (id, owner_tenant_id, site_id, class, gpu_model, sharing, agent, policy, version)
       VALUES ('pool_tpm', $1, 'site_t', 'metal-host', 'H100', 'exclusive', 'bcd', '{}', 1)`,
      [tenants.root.id],
    );
    const tpm = softwareTpm({ certifiedBy: acme }); // not in `known`: needs enrollment
    const nodeCa = createNodeCa({ clock: fixture.clock, trustDomain: 'compute.test' });
    const signingKey = createSigningKey({ clock: fixture.clock });
    const service = createJoinService({
      database,
      clock: fixture.clock,
      work: compute.context.work,
      events: compute.context.events,
      crypto: pkiJoinCrypto({
        trustDomain: 'compute.test',
        nodeCa,
        signingKey,
        encryptionKey: generateP256KeyPair().privateKey,
      }),
      attestors: [
        attestor({
          resolve: async () => undefined,
          enrollment: { tenantId: tenants.root.id, siteId: 'site_t' },
        }),
      ],
    });
    const join = (deferrals: string[], onWait: () => Promise<void> = async () => {}) =>
      runAgentJoin({
        send: (request) => service.join(request),
        signer: { publicKey: signingKey.publicKey },
        wait: async (ms) => {
          await onWait();
          await fixture.advance(ms);
        },
        now: () => fixture.clock.now(),
        nodeCaRoots: [nodeCa.certificate],
        claims: {
          productUuid: '4c4c4544-0042-3510-8052-b7c04f4e4e78',
          productSerial: 'SN-TPM-2',
          permanentMacs: ['3c:ec:ef:78:78:78'],
        },
        attestor: tpmProducer(tpm),
        onDeferral: (d) => void deferrals.push(d.kind),
      });

    const first: string[] = [];
    const enrolled = await join(first, async () => {
      const pending = await database.query<{
        id: string;
        attestor: string;
        claims: { tpm?: unknown };
      }>(`SELECT id, attestor, claims FROM join_requests WHERE state = 'pending'`);
      expect(pending.rows).toHaveLength(1);
      expect(pending.rows[0]).toMatchObject({
        attestor: 'tpm',
        claims: { tpm: { ekSha256: hex(sha256(tpm.ekPublic)) } },
      });
      await database.query(
        `UPDATE join_requests SET state = 'approved', decided_at = compute_now(), decided_by = 'user_ops',
            pool_id = 'pool_tpm', expires_at = compute_now() + interval '1 hour' WHERE id = $1`,
        [pending.rows[0]!.id],
      );
    });
    expect(first).toEqual(['challenge', 'pending', 'challenge']);
    expect(enrolled.rounds).toBe(4);
    const bindings = await database.query<{ node_id: string }>(
      `SELECT node_id FROM node_bindings WHERE attestor = 'tpm' AND subject = $1`,
      [sha256(tpm.ekPublic)],
    );
    expect(bindings.rows).toEqual([{ node_id: enrolled.body.nodeId }]);

    // Reinstalled (new key): the bound EK brings the machine back as the same node, no approval.
    const second: string[] = [];
    const again = await join(second);
    expect(second).toEqual(['challenge']);
    expect(again.body.nodeId).toBe(enrolled.body.nodeId);
    const node = await database.query<{ identity_gen: number; pool_id: string }>(
      'SELECT identity_gen, pool_id FROM nodes WHERE id = $1',
      [enrolled.body.nodeId],
    );
    expect(node.rows).toEqual([{ identity_gen: 2, pool_id: 'pool_tpm' }]);
  });
});
