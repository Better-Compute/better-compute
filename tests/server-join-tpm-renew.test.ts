import { createPublicKey, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { defineAttestor, isComputeError } from '@better-compute/core';
import {
  akAttributes,
  createCsr,
  createNodeCa,
  createSigningKey,
  ekAttributes,
  generateP256KeyPair,
  marshalTpmPublic,
  nodeSpiffeIdOf,
  parseCertificate,
  parseTpmAkUri,
  parseTpmPublic,
  sha256,
  signRenewPop,
  softwareTpmCertify,
  TPM_ALG,
  tpmAttestor,
  tpmName,
  tpmProducer,
  type SoftwareTpm,
} from '@better-compute/pki';
import { RenewRequestSchema } from '@better-compute/protocol';
import { createJoinService, pkiJoinCrypto } from '@better-compute/server';
import { closeFixtures, computeFixture, runAgentJoin } from '@better-compute/testing';

// A node whose TPM certified its key at the join (tpm attestor, D1) gets a certificate naming that AK
// (URI SAN urn:bc:tpm-ak:<nameAlg>:<digest>). Every renewal must then carry RenewRequest.key_attestation:
// the same AK certifying the CSR's key, over sha256(csr), as one the TPM holds. The statement comes
// from the old certificate, never from the CSR, so a renewal can neither drop it nor go without it.

afterEach(closeFixtures);

function softwareTpm(nodeKey?: KeyObject): SoftwareTpm {
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
    akPublic: marshalTpmPublic({ key: ak.publicKey, attributes: akAttributes, scheme: { alg: TPM_ALG.ECDSA, hash: TPM_ALG.SHA256 } }),
    pcrs: new Map([[TPM_ALG.SHA256 as number, bank]]),
    ...(nodeKey ? { nodeKey: createPublicKey(nodeKey) } : {}),
  };
}

async function setup() {
  const fixture = await computeFixture({ clock: 'sim' });
  const { database, compute, tenants } = fixture;
  await database.query(`INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site_r', $1, 'shared', 'eu-1', 1)`, [
    tenants.root.id,
  ]);
  await database.query(
    `INSERT INTO pools (id, owner_tenant_id, site_id, class, gpu_model, sharing, agent, policy, version)
     VALUES ('pool_r', $1, 'site_r', 'metal-host', 'H100', 'exclusive', 'bcd', '{}', 1)`,
    [tenants.root.id],
  );
  const nodeCa = createNodeCa({ clock: fixture.clock, trustDomain: 'compute.test' });
  const signingKey = createSigningKey({ clock: fixture.clock });
  const service = createJoinService({
    database,
    clock: fixture.clock,
    work: compute.context.work,
    events: compute.context.events,
    rootTenantId: tenants.root.id,
    crypto: pkiJoinCrypto({ trustDomain: 'compute.test', nodeCa, signingKey, encryptionKey: generateP256KeyPair().privateKey }),
    attestors: [
      tpmAttestor({
        challengeKey: new Uint8Array(randomBytes(32)),
        allowUncertifiedEk: true,
        // Both kinds of machine: one whose TPM holds the node key, one whose key is a file.
        nodeKey: 'any',
        resolve: async () => ({ tenantId: tenants.root.id, role: 'node', poolId: 'pool_r' }),
      }),
      // An attestor whose statement about the node key no renewal could prove.
      defineAttestor({
        id: 'unprovable',
        version: '1.0.0',
        roles: ['node'],
        verify: async () => ({ tenantId: tenants.root.id, role: 'node', poolId: 'pool_r', nodeKeyUri: 'urn:bc:other-key:1' }),
      }),
    ],
  });
  let serial = 0;
  const join = async (tpm: SoftwareTpm, privateKey: KeyObject) => {
    serial++;
    const joined = await runAgentJoin({
      send: (request) => service.join(request),
      signer: { publicKey: signingKey.publicKey },
      wait: (ms) => fixture.advance(ms).then(() => undefined),
      now: () => fixture.clock.now(),
      nodeCaRoots: [nodeCa.certificate],
      claims: { productUuid: `4c4c4544-0042-3510-8052-b7c04f4e4e9${serial}`, productSerial: `SN-R-${serial}`, permanentMacs: [`3c:ec:ef:90:90:9${serial}`] },
      attestor: tpmProducer(tpm),
      privateKey,
    });
    return { nodeId: joined.body.nodeId, chain: joined.body.certChain };
  };
  /** A RenewRequest for a new key, its proof of possession by `current`, and what the TPM says. */
  const renewal = (
    node: { nodeId: string; chain: Uint8Array[] },
    current: KeyObject,
    attest?: (csr: Uint8Array, next: KeyObject) => ReturnType<typeof softwareTpmCertify> | undefined,
  ) => {
    const next = generateP256KeyPair().privateKey;
    const csr = createCsr(next);
    const clientTime = fixture.clock.now();
    const keyAttestation = attest?.(csr, next);
    return {
      next,
      request: create(RenewRequestSchema, {
        csr,
        chain: node.chain,
        clientTime: timestampFromMs(clientTime),
        popSig: signRenewPop({ csr, nodeId: node.nodeId, clientTime, privateKey: current }).popSig,
        ...(keyAttestation ? { keyAttestation } : {}),
      }),
    };
  };
  const refusedEvents = async () =>
    (
      await database.query<{ payload: { tenantId: string; subject: string; data: { reason: string; nodeId?: string } } }>(
        `SELECT payload FROM outbox WHERE topic = 'security.renew.refused' ORDER BY seq`,
      )
    ).rows.map((row) => ({ tenantId: row.payload.tenantId, subject: row.payload.subject, ...row.payload.data }));
  return { fixture, service, join, renewal, refusedEvents, signingKey, nodeCa, rootTenantId: tenants.root.id };
}

async function refusal(promise: Promise<unknown>): Promise<string | undefined> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(isComputeError(error, 'ACCESS_DENIED')).toBe(true);
  return (error as { details?: { reason?: string } }).details?.reason;
}

const statementsOf = (der: Uint8Array) => parseCertificate(der).uriSans.filter((uri) => uri.startsWith('urn:bc:'));

describe('renewing a TPM-held node key', () => {
  it('names the AK in the certificate and renews only with a new key that AK certifies, carrying the name forward', async () => {
    const { service, join, renewal } = await setup();
    const key = generateP256KeyPair().privateKey;
    const tpm = softwareTpm(key);
    const node = await join(tpm, key);
    const akName = tpmName(parseTpmPublic(tpm.akPublic));
    const [statement] = statementsOf(node.chain[0]!);
    expect(parseTpmAkUri(statement!)).toEqual(akName);
    expect(nodeSpiffeIdOf(parseCertificate(node.chain[0]!).uriSans)?.nodeId).toBe(node.nodeId);

    // No attestation: refused, never renewed without the AK.
    expect(await refusal(service.renew(renewal(node, key).request))).toBe('key-attestation-missing');
    // Another TPM's AK.
    const other = softwareTpm();
    expect(await refusal(service.renew(renewal(node, key, (csr, next) => softwareTpmCertify(other, next, sha256(csr))).request))).toBe(
      'key-attestation-ak',
    );
    // The right AK, but it certified some other key than the CSR's.
    expect(
      await refusal(
        service.renew(renewal(node, key, (csr) => softwareTpmCertify(tpm, generateP256KeyPair().publicKey, sha256(csr))).request),
      ),
    ).toBe('node-key-not-csr');
    // The right AK and key, over another CSR (a replayed certification).
    expect(
      await refusal(service.renew(renewal(node, key, (_csr, next) => softwareTpmCertify(tpm, next, new Uint8Array(32))).request)),
    ).toBe('node-key-nonce');

    // The AK certifies the new key over this CSR: renewed, and the new certificate still names the AK
    // although the CSR asked for no SAN at all.
    const good = renewal(node, key, (csr, next) => softwareTpmCertify(tpm, next, sha256(csr)));
    const renewed = await service.renew(good.request);
    expect(statementsOf(renewed.certChain[0]!)).toEqual([statement]);
    expect(nodeSpiffeIdOf(parseCertificate(renewed.certChain[0]!).uriSans)?.nodeId).toBe(node.nodeId);

    // So the next renewal needs the AK again.
    const next = { nodeId: node.nodeId, chain: renewed.certChain };
    expect(await refusal(service.renew(renewal(next, good.next).request))).toBe('key-attestation-missing');
    const again = await service.renew(renewal(next, good.next, (csr, k) => softwareTpmCertify(tpm, k, sha256(csr))).request);
    expect(statementsOf(again.certChain[0]!)).toEqual([statement]);
  });

  it('publishes security.renew.refused: the owner’s, naming the node, only once the caller proved the current key', async () => {
    const { service, join, renewal, refusedEvents, rootTenantId } = await setup();
    const key = generateP256KeyPair().privateKey;
    const node = await join(softwareTpm(key), key);
    // A proof by the current key, without the AK's attestation.
    expect(await refusal(service.renew(renewal(node, key).request))).toBe('key-attestation-missing');
    // Someone else's key over the node's (public) certificate.
    expect(await refusal(service.renew(renewal(node, generateP256KeyPair().privateKey).request))).toBe('proof');
    expect(await refusedEvents()).toEqual([
      { tenantId: rootTenantId, subject: `node/${node.nodeId}`, reason: 'renew:key-attestation-missing', nodeId: node.nodeId, suppressed: 0 },
      { tenantId: rootTenantId, subject: 'renew', reason: 'renew:proof', suppressed: 0 },
    ]);
  });

  it('issues no certificate with a key statement no renewal could prove', async () => {
    const { fixture, service, signingKey, nodeCa } = await setup();
    const joined = runAgentJoin({
      send: (request) => service.join(request),
      signer: { publicKey: signingKey.publicKey },
      wait: (ms) => fixture.advance(ms).then(() => undefined),
      now: () => fixture.clock.now(),
      nodeCaRoots: [nodeCa.certificate],
      claims: { productUuid: '4c4c4544-0042-3510-8052-b7c04f4e4e99', productSerial: 'SN-R-U', permanentMacs: ['3c:ec:ef:90:90:99'] },
      attestor: { id: 'unprovable', produce: async () => ({ attestor: 'unprovable', payload: new Uint8Array([1]) }) },
    });
    expect(await refusal(joined)).toBe('node-key-statement');
  });

  it('a node key the TPM did not certify gets no AK statement and renews without one', async () => {
    const { service, join, renewal } = await setup();
    const key = generateP256KeyPair().privateKey;
    const node = await join(softwareTpm(), key);
    expect(statementsOf(node.chain[0]!)).toEqual([]);
    const renewed = await service.renew(renewal(node, key).request);
    expect(statementsOf(renewed.certChain[0]!)).toEqual([]);
  });
});
