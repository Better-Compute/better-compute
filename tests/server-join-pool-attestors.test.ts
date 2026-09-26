import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { definePlugin, isComputeError } from '@better-compute/core';
import {
  akAttributes,
  createNodeCa,
  createSigningKey,
  ekAttributes,
  generateP256KeyPair,
  issueJoinToken,
  marshalTpmPublic,
  TPM_ALG,
  tpmAttestor,
  tpmProducer,
  type SoftwareTpm,
} from '@better-compute/pki';
import { createJoinService, pkiJoinCrypto } from '@better-compute/server';
import { closeFixtures, computeFixture, runAgentJoin } from '@better-compute/testing';

// PoolPolicy.joinAttestors (v0.5 §13): a pool admits machines only through the attestors it lists.
// JoinService checks it where it resolves the pool, a reclaim included; pools.create/update refuse
// names the control plane does not run.

afterEach(closeFixtures);

function softwareTpm(): SoftwareTpm {
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
  };
}

const tpm = (poolId: () => string, tenantId: () => string) =>
  tpmAttestor({
    challengeKey: new Uint8Array(randomBytes(32)),
    allowUncertifiedEk: true,
    resolve: async () => ({ tenantId: tenantId(), role: 'node', poolId: poolId() }),
  });

describe('PoolPolicy.joinAttestors', () => {
  it('admits a tpm join, refuses a token join and a token reclaim of the tpm-bound machine, and audits the refusal', async () => {
    const fixture = await computeFixture({ clock: 'sim' });
    const { database, compute, tenants } = fixture;
    await database.query(`INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site_t', $1, 'shared', 'eu-1', 1)`, [
      tenants.root.id,
    ]);
    await database.query(
      `INSERT INTO pools (id, owner_tenant_id, site_id, class, gpu_model, sharing, agent, policy, version)
       VALUES ('pool_tpm', $1, 'site_t', 'metal-host', 'H100', 'exclusive', 'bcd', $2, 1)`,
      [tenants.root.id, JSON.stringify({ joinAttestors: ['tpm'] })],
    );
    const nodeCa = createNodeCa({ clock: fixture.clock, trustDomain: 'compute.test' });
    const signingKey = createSigningKey({ clock: fixture.clock });
    const encryption = generateP256KeyPair();
    const service = createJoinService({
      database,
      clock: fixture.clock,
      work: compute.context.work,
      events: compute.context.events,
      rootTenantId: tenants.root.id,
      crypto: pkiJoinCrypto({ trustDomain: 'compute.test', nodeCa, signingKey, encryptionKey: encryption.privateKey }),
      attestors: [tpm(() => 'pool_tpm', () => tenants.root.id)],
    });
    // One machine: the same hardware claims (a trusted hardware key) whichever way it joins.
    const claims = { productUuid: '4c4c4544-0042-3510-8052-b7c04f4e4e90', productSerial: 'SN-PA-1', permanentMacs: ['3c:ec:ef:90:90:90'] };
    const token = async (allowReclaim: boolean) => {
      const issued = issueJoinToken();
      await database.query(
        `INSERT INTO join_tokens (id, tenant_id, role, pool_id, site_id, secret_hash, uses_left, allow_reclaim, expires_at)
         VALUES ($1, $2, 'node', 'pool_tpm', NULL, $3, 1, $4, compute_now() + interval '1 hour')`,
        [issued.id, tenants.root.id, issued.secretHash, allowReclaim],
      );
      return issued.token;
    };
    const join = async (how: { token?: string; tpm?: SoftwareTpm }) =>
      runAgentJoin({
        send: (request) => service.join(request),
        signer: { publicKey: signingKey.publicKey },
        wait: (ms) => fixture.advance(ms).then(() => undefined),
        now: () => fixture.clock.now(),
        nodeCaRoots: [nodeCa.certificate],
        claims,
        ...(how.tpm ? { attestor: tpmProducer(how.tpm) } : {}),
        ...(how.token ? { token: { token: how.token, joinEncryptionKey: encryption.publicKey, now: () => fixture.clock.now() } } : {}),
      });
    const refused = async (promise: Promise<unknown>) => {
      const error = await promise.then(
        () => undefined,
        (reason: unknown) => reason,
      );
      expect(isComputeError(error, 'ACCESS_DENIED')).toBe(true);
      return (error as { details?: { reason?: string } }).details?.reason;
    };

    // A token join (join-token is not listed): refused, and nothing joins.
    expect(await refused(join({ token: await token(false) }))).toBe('pool-attestor');
    expect((await database.query(`SELECT id FROM nodes WHERE pool_id = 'pool_tpm'`)).rows).toEqual([]);

    // The TPM: admitted, and bound to its EK.
    const machineTpm = softwareTpm();
    const joined = await join({ tpm: machineTpm });
    expect((await database.query<{ pool_id: string }>('SELECT pool_id FROM nodes WHERE id = $1', [joined.body.nodeId])).rows).toEqual([
      { pool_id: 'pool_tpm' },
    ]);

    // The same machine reclaimed with a token (allow_reclaim, same trusted hardware key): refused.
    expect(await refused(join({ token: await token(true) }))).toBe('pool-attestor');
    const node = await database.query<{ identity_gen: number }>('SELECT identity_gen FROM nodes WHERE id = $1', [joined.body.nodeId]);
    expect(node.rows).toEqual([{ identity_gen: 1 }]);
    // Its TPM reclaims it.
    expect((await join({ tpm: machineTpm })).body.nodeId).toBe(joined.body.nodeId);

    // Each refusal is the pool owner's security.join.refused, reason pool-attestor.
    const events = await database.query<{ payload: { tenantId: string; data: { attestor: string; reason: string } } }>(
      `SELECT payload FROM outbox WHERE topic = 'security.join.refused' ORDER BY seq`,
    );
    expect(events.rows.map((row) => [row.payload.tenantId, row.payload.data.attestor, row.payload.data.reason])).toEqual([
      [tenants.root.id, 'join-token', 'join:pool-attestor'],
      [tenants.root.id, 'join-token', 'join:pool-attestor'],
    ]);
  });

  it('pools.create and pools.update take only attestors the control plane runs', async () => {
    const fixture = await computeFixture({
      clock: 'sim',
      plugins: [definePlugin({ id: 'tpm-attestor', extensions: [tpm(() => '', () => '')] })],
    });
    const { compute, tenants, iam } = fixture;
    iam.allow({ token: tenants.root.token });
    const root = { token: tenants.root.token };
    const site = await compute.api.sites.create(root, { tenantId: tenants.root.id, kind: 'shared', region: 'eu-1', idempotencyKey: 'pa-site' });
    const create = (joinAttestors: unknown, key: string) =>
      compute.api.pools.create(root, {
        tenantId: tenants.root.id,
        siteId: site.id,
        class: 'metal-host',
        policy: { joinAttestors },
        idempotencyKey: key,
      } as never);
    const pool = (await create(['tpm', 'join-token'], 'pa-ok')) as { id: string };
    for (const [bad, key] of [
      [['tpmx'], 'pa-unknown'],
      [[], 'pa-empty'],
      ['tpm', 'pa-string'],
    ] as const)
      await expect(create(bad, key), JSON.stringify(bad)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      compute.api.pools.update(root, { tenantId: tenants.root.id, poolId: pool.id, policy: { joinAttestors: ['x509pop'] } } as never),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('x509pop') });
  });
});
