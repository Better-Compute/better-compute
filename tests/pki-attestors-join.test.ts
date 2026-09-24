import { generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { create } from '@bufbuild/protobuf';
import { isComputeError } from '@better-compute/core';
import {
  base64url,
  cloudIidAttestor,
  cloudIidAudience,
  createCloudIidEvidence,
  createCsr,
  createNodeCa,
  createSigningKey,
  createX509popEvidence,
  gcpInstanceIdentity,
  generateP256KeyPair,
  issueJoinToken,
  provisionedAttestor,
  sealJoinToken,
  sha256,
  signDiscoveryAssertion,
  discoveryAttestor,
  staticJwks,
  verifyJoinResponse,
  x509popAttestor,
} from '@better-compute/pki';
import { AgentRole, HardwareClaimsSchema, JoinRequestSchema } from '@better-compute/protocol';
import { createJoinService, pkiJoinCrypto } from '@better-compute/server';
import { closeFixtures, computeFixture, runAgentJoin } from '@better-compute/testing';

// The v0.2+ attestors through the real JoinService (bb7106b seams: `evidence.token`,
// `context.csrSha256`): x509pop re-joins a node in place, provisioned spends a single-use token,
// cloud-iid admits a GCP instance bound to its CSR.

afterEach(closeFixtures);

const TRUST_DOMAIN = 'compute.test';
const SITE = 'site_a';
const POOL = 'pool_h100';
const AUDIENCE = 'https://compute.test/join';

const gcpKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
const gcpJwks = {
  keys: [{ ...gcpKey.publicKey.export({ format: 'jwk' }), kid: 'g1', alg: 'RS256' }],
};

async function setup() {
  const fixture = await computeFixture({ clock: 'sim' });
  const { database, compute, tenants } = fixture;
  await database.query(
    `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ($1, $2, 'shared', 'eu-1', 1)`,
    [SITE, tenants.root.id],
  );
  await database.query(
    `INSERT INTO pools (id, owner_tenant_id, site_id, class, gpu_model, sharing, agent, policy, version)
     VALUES ($1, $2, $3, 'metal-host', 'H100', 'exclusive', 'bcd', '{}', 1)`,
    [POOL, tenants.root.id, SITE],
  );
  const nodeCa = createNodeCa({ clock: fixture.clock, trustDomain: TRUST_DOMAIN });
  const signingKey = createSigningKey({ clock: fixture.clock });
  const encryption = generateP256KeyPair();
  const service = createJoinService({
    database,
    clock: fixture.clock,
    work: compute.context.work,
    events: compute.context.events,
    crypto: pkiJoinCrypto({
      trustDomain: TRUST_DOMAIN,
      nodeCa,
      signingKey,
      encryptionKey: encryption.privateKey,
    }),
    attestors: [
      x509popAttestor(),
      provisionedAttestor(),
      discoveryAttestor({ approval: 'always' }),
      cloudIidAttestor({
        providers: [gcpInstanceIdentity({ audience: AUDIENCE, jwks: staticJwks(gcpJwks) })],
        resolve: async (_tx, identity) =>
          identity.accountId === 'acme-gpu'
            ? { tenantId: tenants.root.id, role: 'node', poolId: POOL }
            : undefined,
      }),
    ],
  });
  const verify = (response: Parameters<typeof verifyJoinResponse>[0], csr: Uint8Array) =>
    verifyJoinResponse(response, {
      signer: { publicKey: signingKey.publicKey },
      csr,
      nodeCaRoots: [nodeCa.certificate],
      now: fixture.clock.now(),
    });
  return { fixture, service, encryption, verify, signingKey, nodeCa };
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function mintToken(s: Setup, role: 'node' | 'provisioned', expect?: Record<string, string>) {
  const issued = issueJoinToken();
  await s.fixture.database.query(
    `INSERT INTO join_tokens (id, tenant_id, role, pool_id, site_id, secret_hash, uses_left, expect,
       allow_reclaim, expires_at)
     VALUES ($1, $2, $3, $4, NULL, $5, 1, $6, false, compute_now() + interval '1 hour')`,
    [
      issued.id,
      s.fixture.tenants.root.id,
      role,
      POOL,
      issued.secretHash,
      expect ? JSON.stringify(expect) : null,
    ],
  );
  return issued;
}

const claims = {
  productUuid: '4c4c4544-0042-3510-8052-b7c04f4e4e01',
  productSerial: 'SN-7701',
  permanentMacs: ['3c:ec:ef:10:20:01'],
  gpuUuids: ['GPU-6f7c2a11-0000-4b3a-9e5d-000000000001'],
};

function request(
  s: Setup,
  options: { csr: Uint8Array; attestor?: string; token?: string; attestation?: Uint8Array },
) {
  return create(JoinRequestSchema, {
    csr: options.csr,
    claims: create(HardwareClaimsSchema, claims),
    daemonVersion: '0.2.0',
    role: AgentRole.NODE,
    ...(options.attestor ? { attestor: options.attestor } : {}),
    ...(options.attestation ? { attestation: options.attestation } : {}),
    ...(options.token
      ? {
          sealedToken: new TextEncoder().encode(
            sealJoinToken(options.token, s.encryption.publicKey, {
              csr: options.csr,
              issuedAt: s.fixture.clock.now(),
            }),
          ),
        }
      : {}),
  });
}

async function denied(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(isComputeError(error, 'ACCESS_DENIED')).toBe(true);
}

describe('attestors through JoinService', () => {
  it('x509pop: a node offline past expiry re-joins as itself, and only once', async () => {
    const s = await setup();
    const key = generateP256KeyPair().privateKey;
    const firstCsr = createCsr(key);
    const token = await mintToken(s, 'node');
    const first = s.verify(
      await s.service.join(request(s, { csr: firstCsr, token: token.token })),
      firstCsr,
    );

    await s.fixture.advance(2 * 86_400_000); // the 24 h certificate expired while offline
    const nextKey = generateP256KeyPair().privateKey;
    const csr = createCsr(nextKey);
    const attestation = createX509popEvidence({
      nodeId: first.nodeId,
      chain: first.certChain,
      privateKey: key,
      csr,
      now: s.fixture.clock.now(),
    });
    const again = request(s, { csr, attestor: 'x509pop', attestation });
    const second = s.verify(await s.service.join(again), csr);
    expect(second.nodeId).toBe(first.nodeId);

    const { rows } = await s.fixture.database.query<{
      identity_gen: number;
      certs: string;
      revoked: string;
    }>(
      `SELECT n.identity_gen,
              (SELECT count(*) FROM node_certs c WHERE c.node_id = n.id)::text AS certs,
              (SELECT count(*) FROM node_certs c WHERE c.node_id = n.id AND c.revoked_at IS NOT NULL)::text AS revoked
         FROM nodes n WHERE n.id = $1`,
      [first.nodeId],
    );
    expect(rows[0]).toEqual({ identity_gen: 2, certs: '2', revoked: '1' });
    // The old certificate was revoked by the reclaim: the same proof never works twice.
    await denied(s.service.join(again));
  });

  it('provisioned: the sealed token reaches the attestor as evidence.token and is spent', async () => {
    const s = await setup();
    const token = await mintToken(s, 'provisioned', { productUuid: claims.productUuid });
    const csr = createCsr(generateP256KeyPair().privateKey);
    const body = s.verify(
      await s.service.join(request(s, { csr, attestor: 'provisioned', token: token.token })),
      csr,
    );
    expect(body.nodeId).toMatch(/^node_/);
    const csr2 = createCsr(generateP256KeyPair().privateKey);
    await denied(
      s.service.join(request(s, { csr: csr2, attestor: 'provisioned', token: token.token })),
    );
    // A plain node token is not a provisioned credential.
    const plain = await mintToken(s, 'node', { productUuid: claims.productUuid });
    await denied(
      s.service.join(request(s, { csr: csr2, attestor: 'provisioned', token: plain.token })),
    );
  });

  it('cloud-iid: a GCP instance joins with an identity token bound to its CSR', async () => {
    const s = await setup();
    const csr = createCsr(generateP256KeyPair().privateKey);
    const identity = (forCsr: Uint8Array, project = 'acme-gpu') => {
      const enc = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));
      const nowS = Math.floor(s.fixture.clock.now() / 1000);
      const input = `${enc({ alg: 'RS256', kid: 'g1' })}.${enc({
        iss: 'https://accounts.google.com',
        aud: cloudIidAudience(AUDIENCE, sha256(forCsr)),
        iat: nowS,
        exp: nowS + 3600,
        google: {
          compute_engine: { project_id: project, zone: 'europe-west4-a', instance_id: '42' },
        },
      })}`;
      const sig = base64url(new Uint8Array(sign('sha256', Buffer.from(input), gcpKey.privateKey)));
      return createCloudIidEvidence({ provider: 'gcp', document: `${input}.${sig}` });
    };
    const body = s.verify(
      await s.service.join(request(s, { csr, attestor: 'cloud-iid', attestation: identity(csr) })),
      csr,
    );
    expect(body.nodeId).toMatch(/^node_/);
    // Relayed with another key's CSR, or from a project compute does not manage: refused.
    const other = createCsr(generateP256KeyPair().privateKey);
    await denied(
      s.service.join(request(s, { csr: other, attestor: 'cloud-iid', attestation: identity(csr) })),
    );
    await denied(
      s.service.join(
        request(s, { csr: other, attestor: 'cloud-iid', attestation: identity(other, 'stranger') }),
      ),
    );
  });

  it('discovery with approval: pending → operator approves → the same CSR joins as a ramdisk', async () => {
    const s = await setup();
    const db = s.fixture.database;
    const root = s.fixture.tenants.root.id;
    const signer = { publicKey: s.signingKey.publicKey };
    const wait = (ms: number) => s.fixture.advance(ms).then(() => undefined);
    const siteToken = async (role: 'site' | 'discovery') => {
      const issued = issueJoinToken();
      await db.query(
        `INSERT INTO join_tokens (id, tenant_id, role, pool_id, site_id, secret_hash, uses_left, expect,
           allow_reclaim, expires_at)
         VALUES ($1, $2, $3, NULL, $4, $5, 1, NULL, false, compute_now() + interval '1 hour')`,
        [issued.id, root, role, SITE, issued.secretHash],
      );
      return issued.token;
    };

    // The site agent joins first and takes the site's boot lease.
    const siteAgent = await runAgentJoin({
      send: (r) => s.service.join(r),
      signer,
      wait,
      now: () => s.fixture.clock.now(),
      role: AgentRole.SITE,
      claims: {
        ...claims,
        productUuid: '4c4c4544-0042-3510-8052-b7c04f4e4eff',
        permanentMacs: ['3c:ec:ef:ff:ff:ff'],
      },
      token: { token: await siteToken('site'), joinEncryptionKey: s.encryption.publicKey },
    });
    const siteAgentId = siteAgent.body.nodeId;
    await db.query(
      `INSERT INTO leases (name, owner, epoch, expires_at) VALUES ($1, $2, 4, compute_now() + interval '1 hour')`,
      [`site:${SITE}:boot`, siteAgentId],
    );

    // The PXE-booted ramdisk: token from its iPXE script, a fresh assertion every round.
    const deferrals: string[] = [];
    let requestId = '';
    const ramdisk = await runAgentJoin({
      send: (r) => s.service.join(r),
      signer,
      now: () => s.fixture.clock.now(),
      wait: async (ms) => {
        const { rows } = await db.query<{ state: string }>(
          'SELECT state FROM join_requests WHERE id = $1',
          [requestId],
        );
        expect(rows[0]?.state).toBe('pending');
        await db.query(
          `UPDATE join_requests SET state = 'approved', decided_at = compute_now(), decided_by = 'user_ops',
              pool_id = $2, expires_at = compute_now() + interval '1 hour' WHERE id = $1`,
          [requestId, POOL],
        );
        await wait(ms);
      },
      role: AgentRole.RAMDISK,
      claims,
      token: { token: await siteToken('discovery'), joinEncryptionKey: s.encryption.publicKey },
      attestor: {
        id: 'discovery',
        produce: async () => ({
          attestor: 'discovery',
          payload: signDiscoveryAssertion(siteAgent.privateKey, {
            siteId: SITE,
            siteAgentNodeId: siteAgentId,
            bootLeaseEpoch: 4,
            mac: claims.permanentMacs[0]!,
            productUuid: claims.productUuid,
            issuedAt: s.fixture.clock.now(),
            notAfter: s.fixture.clock.now() + 600_000,
          }),
        }),
      },
      onDeferral: (d) => {
        deferrals.push(d.kind);
        requestId = d.requestId ?? requestId;
      },
    });
    expect(deferrals).toEqual(['pending']);
    expect(ramdisk.rounds).toBe(2);
    expect(ramdisk.body.role).toBe(AgentRole.RAMDISK);
    const { rows } = await db.query<{ state: string; role: string; pool_id: string | null }>(
      `SELECT r.state, c.role, n.pool_id FROM join_requests r, node_certs c JOIN nodes n ON n.id = c.node_id
        WHERE r.id = $1 AND c.node_id = $2`,
      [requestId, ramdisk.body.nodeId],
    );
    expect(rows).toEqual([{ state: 'consumed', role: 'ramdisk', pool_id: POOL }]);
  });
});
