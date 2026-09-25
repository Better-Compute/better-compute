import { generateKeyPairSync, sign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { manualClock, type AttestationContext, type SqlExecutor } from '@better-compute/core';
import { useSimClock } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import { AgentRole, commandKinds } from '@better-compute/protocol';
import { metalCommandKinds } from '@better-compute/metal';
import {
  awsInstanceIdentity,
  base64url,
  cloudIidAttestor,
  cloudIidAudience,
  commandKindAllowed,
  createCloudIidEvidence,
  createCsr,
  createNodeCa,
  createX509popEvidence,
  discoveryAllowedKinds,
  discoveryAttestor,
  gcpInstanceIdentity,
  generateP256KeyPair,
  issueJoinToken,
  nodeSpiffeId,
  provisionedAttestor,
  remoteJwks,
  sha256,
  signDiscoveryAssertion,
  signRenewPop,
  spkiSha256,
  staticJwks,
  x509popAttestor,
  x509popProducer,
} from '@better-compute/pki';

const now = Date.UTC(2026, 8, 24, 12);
const day = 86_400_000;
const tenant = 'org_acme';
const siteId = 'site_fra1';
const poolId = 'pool_h100';
const claims = {
  productUuid: '4C4C4544-0042-3510-8052-B7C04F4E4E32',
  serial: 'SN-7731',
  macs: ['3C:EC:EF:10:20:30'],
};

let db: SqlExecutor;
let seq = 0;
const nodeIdFor = () => `node_01k5w00000000000000000${(seq++).toString().padStart(4, '0')}`;

beforeAll(async () => {
  db = pglite();
  await db.migrate();
  await useSimClock(db, now);
  await db.query(
    `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ($1, $2, 'shared', 'eu-central', 1)`,
    [siteId, tenant],
  );
  await db.query(
    `INSERT INTO pools (id, owner_tenant_id, site_id, class, sharing, agent, policy, version)
     VALUES ($1, $2, $3, 'metal-dedicated', 'exclusive', 'bcd', '{}', 1)`,
    [poolId, tenant, siteId],
  );
});
afterAll(async () => {
  await db.close();
});

async function insertNode(
  options: { role?: 'dedicated' | 'site'; state?: string; identityGen?: number } = {},
) {
  const id = nodeIdFor();
  const role = options.role ?? 'dedicated';
  await db.query(
    `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance, cordoned,
       connectivity, trust, generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
     VALUES ($1, $2, $3, $4, $5, $6, false, false, 'disconnected', 'platform', 0, 0, 1, $7, 0, 1)`,
    [
      id,
      siteId,
      role === 'site' ? null : poolId,
      tenant,
      role,
      options.state ?? 'adopted',
      options.identityGen ?? 1,
    ],
  );
  return id;
}

/** Issues and records a node certificate valid from `issuedAt` for `ttlMs`. */
async function issueCert(
  nodeId: string,
  options: { issuedAt: number; ttlMs: number; role?: 'node' | 'site'; identityGen?: number },
) {
  const key = generateP256KeyPair().privateKey;
  const ca = createNodeCa({ clock: manualClock(options.issuedAt) });
  const issued = await ca.sign(createCsr(key), {
    usage: 'client',
    role: options.role ?? 'node',
    ttlSeconds: options.ttlMs / 1000,
    uriSans: [nodeSpiffeId({ trustDomain: 'compute.test', siteId, nodeId })],
  });
  await db.query(
    `INSERT INTO node_certs (serial, node_id, role, identity_gen, spki_sha256, der, not_before, not_after)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      issued.serial,
      nodeId,
      options.role ?? 'node',
      options.identityGen ?? 1,
      spkiSha256(key),
      issued.certificate,
      new Date(issued.notBefore),
      new Date(issued.notAfter),
    ],
  );
  return { key, certificate: issued.certificate, serial: issued.serial };
}

async function insertToken(
  role: 'node' | 'provisioned' | 'discovery',
  overrides: Record<string, unknown> = {},
) {
  const issued = issueJoinToken();
  const row = {
    pool_id: poolId as string | null,
    site_id: siteId as string | null,
    uses_left: 1,
    expect: null as unknown,
    ...overrides,
  };
  await db.query(
    `INSERT INTO join_tokens (id, tenant_id, role, pool_id, site_id, secret_hash, uses_left, expect, allow_reclaim, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, $9)`,
    [
      issued.id,
      tenant,
      role,
      row.pool_id,
      row.site_id,
      issued.secretHash,
      row.uses_left,
      row.expect,
      new Date(now + 3_600_000),
    ],
  );
  return issued;
}

function context(
  tx: AttestationContext['tx'],
  overrides: Partial<AttestationContext> = {},
): AttestationContext {
  return { tx, clock: manualClock(now), claims, role: 'node', ...overrides };
}

function refusals() {
  const reasons: string[] = [];
  return { reasons, onRefusal: (refusal: { reason: string }) => void reasons.push(refusal.reason) };
}

const denied = { code: 'ACCESS_DENIED', message: 'Join refused' };

describe('x509pop', () => {
  async function rejoin(
    attestor: ReturnType<typeof x509popAttestor>,
    payload: Uint8Array,
    csr: Uint8Array | undefined,
    role: 'node' | 'site' = 'node',
  ) {
    return db.transaction((tx) =>
      attestor.verify(
        { attestor: 'x509pop', payload },
        context(tx, { role, ...(csr ? { csrSha256: sha256(csr) } : {}) }),
      ),
    );
  }

  it('re-admits a node whose certificate expired offline, as itself, once', async () => {
    const hook = refusals();
    const attestor = x509popAttestor(hook);
    const nodeId = await insertNode();
    const old = await issueCert(nodeId, { issuedAt: now - 3 * day, ttlMs: day });
    const csr = createCsr(generateP256KeyPair().privateKey);
    const payload = createX509popEvidence({
      nodeId,
      chain: [old.certificate],
      privateKey: old.key,
      csr,
      now,
    });
    await expect(rejoin(attestor, payload, csr)).resolves.toEqual({
      tenantId: tenant,
      role: 'node',
      nodeId,
      siteId,
      poolId,
    });
    await expect(rejoin(attestor, payload, csr)).rejects.toMatchObject(denied);
    expect(hook.reasons).toEqual(['replayed']);
  });

  it('binds the proof to the CSR and refuses without the binding', async () => {
    const hook = refusals();
    const attestor = x509popAttestor(hook);
    const nodeId = await insertNode();
    const old = await issueCert(nodeId, { issuedAt: now - 2 * day, ttlMs: day });
    const csr = createCsr(generateP256KeyPair().privateKey);
    const other = createCsr(generateP256KeyPair().privateKey);
    const payload = createX509popEvidence({
      nodeId,
      chain: [old.certificate],
      privateKey: old.key,
      csr,
      now,
    });
    await expect(rejoin(attestor, payload, other)).rejects.toMatchObject(denied);
    await expect(rejoin(attestor, payload, undefined)).rejects.toMatchObject(denied);
    expect(hook.reasons).toEqual(['bad-proof', 'no-csr-binding']);
  });

  it('does not accept a Renew proof: the purposes differ', async () => {
    const hook = refusals();
    const attestor = x509popAttestor(hook);
    const nodeId = await insertNode();
    const old = await issueCert(nodeId, { issuedAt: now - 2 * day, ttlMs: day });
    const csr = createCsr(generateP256KeyPair().privateKey);
    const renew = signRenewPop({ csr, nodeId, clientTime: now, privateKey: old.key });
    const payload = new TextEncoder().encode(
      JSON.stringify({
        v: 1,
        nodeId,
        chain: [base64url(old.certificate)],
        clientTime: now,
        sig: base64url(renew.popSig),
      }),
    );
    await expect(rejoin(attestor, payload, csr)).rejects.toMatchObject(denied);
    expect(hook.reasons).toEqual(['bad-proof']);
  });

  it('refuses past the 7-day grace, revoked, superseded, retired, foreign and mis-timed proofs', async () => {
    const hook = refusals();
    const attestor = x509popAttestor(hook);
    const csr = createCsr(generateP256KeyPair().privateKey);
    const attempt = async (
      setup: (
        nodeId: string,
      ) => Promise<{ key: import('node:crypto').KeyObject; certificate: Uint8Array }>,
      options: {
        clientTime?: number;
        nodeState?: string;
        identityGen?: number;
        role?: 'node' | 'site';
      } = {},
    ) => {
      const nodeId = await insertNode({
        ...(options.nodeState ? { state: options.nodeState } : {}),
        ...(options.identityGen ? { identityGen: options.identityGen } : {}),
      });
      const cert = await setup(nodeId);
      const payload = createX509popEvidence({
        nodeId,
        chain: [cert.certificate],
        privateKey: cert.key,
        csr,
        now: options.clientTime ?? now,
      });
      await expect(rejoin(attestor, payload, csr, options.role)).rejects.toMatchObject(denied);
    };
    await attempt((id) => issueCert(id, { issuedAt: now - 9 * day, ttlMs: day }));
    await attempt(async (id) => {
      const cert = await issueCert(id, { issuedAt: now - 2 * day, ttlMs: day });
      await db.query('UPDATE node_certs SET revoked_at = compute_now() WHERE serial = $1', [
        cert.serial,
      ]);
      return cert;
    });
    await attempt((id) => issueCert(id, { issuedAt: now - 2 * day, ttlMs: day }), {
      identityGen: 2,
    });
    await attempt((id) => issueCert(id, { issuedAt: now - 2 * day, ttlMs: day }), {
      nodeState: 'retired',
    });
    // A certificate compute never recorded (another CA's look-alike).
    await attempt(async (id) => {
      const key = generateP256KeyPair().privateKey;
      const ca = createNodeCa({ clock: manualClock(now - 2 * day) });
      const issued = await ca.sign(createCsr(key), {
        usage: 'client',
        role: 'node',
        ttlSeconds: 86_400,
        uriSans: [nodeSpiffeId({ trustDomain: 'compute.test', siteId, nodeId: id })],
      });
      return { key, certificate: issued.certificate };
    });
    await attempt((id) => issueCert(id, { issuedAt: now - 2 * day, ttlMs: day }), {
      clientTime: now - 5 * 60_000,
    });
    await attempt((id) => issueCert(id, { issuedAt: now - 2 * day, ttlMs: day }), { role: 'site' });
    expect(hook.reasons).toEqual([
      'past-grace',
      'revoked',
      'superseded',
      'retired',
      'unknown-certificate',
      'client-time',
      'role',
    ]);
  });

  it('has a producer for FakeDaemon', async () => {
    const nodeId = await insertNode({ role: 'site' });
    const old = await issueCert(nodeId, { issuedAt: now - 2 * day, ttlMs: day, role: 'site' });
    const csr = createCsr(generateP256KeyPair().privateKey);
    const producer = x509popProducer({
      nodeId,
      chain: [old.certificate],
      privateKey: old.key,
      csr,
      clock: manualClock(now),
    });
    const evidence = await producer.produce({ claims });
    expect(producer.id).toBe('x509pop');
    await expect(rejoin(x509popAttestor(), evidence.payload, csr, 'site')).resolves.toMatchObject({
      nodeId,
      role: 'site',
      siteId,
    });
  });
});

describe('provisioned', () => {
  const attest = (
    attestor: ReturnType<typeof provisionedAttestor>,
    token: string | undefined,
    overrides: Partial<AttestationContext> = {},
  ) =>
    db.transaction((tx) =>
      attestor.verify(
        { attestor: 'provisioned', payload: new Uint8Array(0), ...(token ? { token } : {}) },
        context(tx, overrides),
      ),
    );

  it('re-keys the node the token was minted for, bound to its product UUID, once', async () => {
    const hook = refusals();
    const nodeId = await insertNode({ state: 'deploying' });
    const issued = await insertToken('provisioned');
    const seen: string[] = [];
    const attestor = provisionedAttestor({
      ...hook,
      resolveTarget: async (_tx, token) => {
        seen.push(token.id);
        return token.id === issued.id
          ? { nodeId, productUuid: claims.productUuid.toLowerCase() }
          : undefined;
      },
    });
    await expect(attest(attestor, issued.token)).resolves.toEqual({
      tenantId: tenant,
      role: 'node',
      tokenId: issued.id,
      poolId,
      siteId,
      nodeId,
    });
    await expect(attest(attestor, issued.token)).rejects.toMatchObject(denied);
    expect(seen).toEqual([issued.id]);
    expect(hook.reasons).toEqual(['exhausted']);
  });

  it('refuses other token roles, multi-use tokens, unbound tokens and the wrong machine', async () => {
    const hook = refusals();
    const target = { nodeId: 'node_x', productUuid: '00000000-0000-0000-0000-000000000001' };
    const bound = provisionedAttestor({ ...hook, resolveTarget: async () => target });
    const unbound = provisionedAttestor(hook);
    await expect(attest(bound, (await insertToken('node')).token)).rejects.toMatchObject(denied);
    await expect(
      attest(bound, (await insertToken('provisioned', { uses_left: 3 })).token),
    ).rejects.toMatchObject(denied);
    await expect(attest(unbound, (await insertToken('provisioned')).token)).rejects.toMatchObject(
      denied,
    );
    await expect(attest(bound, (await insertToken('provisioned')).token)).rejects.toMatchObject(
      denied,
    );
    await expect(attest(bound, undefined)).rejects.toMatchObject(denied);
    await expect(
      attest(unbound, (await insertToken('provisioned')).token, { claims: { macs: claims.macs } }),
    ).rejects.toMatchObject(denied);
    expect(hook.reasons).toEqual([
      'token-role',
      'not-single-use',
      'unbound',
      'product-uuid-mismatch',
      'no-token',
      'no-product-uuid',
    ]);
  });

  it('accepts a token whose expect names the product UUID (provider bootstrap, new node)', async () => {
    const issued = await insertToken('provisioned', {
      expect: JSON.stringify({ productUuid: claims.productUuid }),
    });
    await expect(attest(provisionedAttestor(), issued.token)).resolves.toEqual({
      tenantId: tenant,
      role: 'node',
      tokenId: issued.id,
      poolId,
      siteId,
    });
    // A failed join rolls back: the token is not spent.
    const other = await insertToken('provisioned', {
      expect: JSON.stringify({ productUuid: 'aaaa' }),
    });
    await expect(attest(provisionedAttestor(), other.token)).rejects.toMatchObject(denied);
    const { rows } = await db.query<{ uses_left: number }>(
      'SELECT uses_left FROM join_tokens WHERE id = $1',
      [other.id],
    );
    expect(rows[0]!.uses_left).toBe(1);
  });
});

describe('discovery', () => {
  let agentId: string;
  let agentKey: import('node:crypto').KeyObject;
  const epoch = 7n;

  beforeAll(async () => {
    agentId = await insertNode({ role: 'site' });
    const cert = await issueCert(agentId, { issuedAt: now - 3_600_000, ttlMs: day, role: 'site' });
    agentKey = cert.key;
    await db.query(`INSERT INTO leases (name, owner, epoch, expires_at) VALUES ($1, $2, $3, $4)`, [
      `site:${siteId}:boot`,
      agentId,
      epoch.toString(),
      new Date(now + 30_000),
    ]);
  });

  const assertion = (
    overrides: Partial<Parameters<typeof signDiscoveryAssertion>[1]> = {},
    key = agentKey,
  ) =>
    signDiscoveryAssertion(key, {
      siteId,
      siteAgentNodeId: agentId,
      bootLeaseEpoch: epoch,
      mac: '3c:ec:ef:10:20:30',
      ip: '10.0.0.17',
      productUuid: claims.productUuid,
      issuedAt: now - 60_000,
      notAfter: now + 600_000,
      ...overrides,
    });

  const attest = (
    attestor: ReturnType<typeof discoveryAttestor>,
    token: string | undefined,
    payload: Uint8Array,
    overrides: Partial<AttestationContext> = {},
  ) =>
    db.transaction((tx) =>
      attestor.verify(
        { attestor: 'discovery', payload, ...(token ? { token } : {}) },
        context(tx, { role: 'ramdisk', ...overrides }),
      ),
    );

  it('admits a ramdisk vouched for by the boot-lease holder, with a short, restricted cert', async () => {
    const issued = await insertToken('discovery', { pool_id: null });
    const workflowNode = await insertNode();
    const attestor = discoveryAttestor({
      resolveWorkflowNode: async (_tx, workflowId) =>
        workflowId === 'wf_1' ? workflowNode : undefined,
    });
    await expect(
      attest(attestor, issued.token, assertion({ workflowId: 'wf_1' })),
    ).resolves.toEqual({
      tenantId: tenant,
      role: 'ramdisk',
      tokenId: issued.id,
      siteId,
      nodeId: workflowNode,
      certTtlSeconds: 7200,
      allowedKinds: discoveryAllowedKinds,
    });
  });

  it('refuses stale epochs, other signers, strangers, expired assertions and missing parts', async () => {
    const hook = refusals();
    const attestor = discoveryAttestor(hook);
    const token = async () => (await insertToken('discovery', { pool_id: null })).token;
    const intruder = generateP256KeyPair().privateKey;
    const cases: Array<[string | undefined, Uint8Array, Partial<AttestationContext>?]> = [
      [await token(), assertion({ bootLeaseEpoch: epoch - 1n })],
      [await token(), assertion({}, intruder)],
      [await token(), assertion({ mac: '3c:ec:ef:99:99:99' })],
      [await token(), assertion({ productUuid: '00000000-0000-0000-0000-000000000009' })],
      [await token(), assertion({ issuedAt: now - 30 * 60_000, notAfter: now + 600_000 })],
      [await token(), assertion({ siteId: 'site_other' })],
      [undefined, assertion()],
      [await token(), new Uint8Array(0)],
      [(await insertToken('node', { pool_id: null })).token, assertion()],
    ];
    for (const [tok, payload, overrides] of cases)
      await expect(attest(attestor, tok, payload, overrides)).rejects.toMatchObject(denied);
    expect(hook.reasons).toEqual([
      'stale-epoch',
      'bad-signature',
      'mac-mismatch',
      'product-uuid-mismatch',
      'assertion-expired',
      'site-mismatch',
      'no-token',
      'no-assertion',
      'role-mismatch',
    ]);
  });

  describe('with operator approval (join_requests)', () => {
    const csr = () => sha256(createCsr(generateP256KeyPair().privateKey));
    const withCsr = (csrSha256: Uint8Array) => ({ csrSha256 });
    const macOf = (n: number) => `3c:ec:ef:00:00:${n.toString(16).padStart(2, '0')}`;
    let n = 0;
    const machine = () => {
      n++;
      return {
        claims: {
          productUuid: `00000000-0000-4000-8000-0000000000${n.toString(16).padStart(2, '0')}`,
          macs: [macOf(n)],
        },
        mac: macOf(n),
      };
    };
    const vouch = (m: ReturnType<typeof machine>) =>
      assertion({ mac: m.mac, productUuid: m.claims.productUuid });
    const request = async (id: string) =>
      (await db.query<Record<string, unknown>>('SELECT * FROM join_requests WHERE id = $1', [id]))
        .rows[0]!;
    const usesLeft = async (id: string) =>
      Number(
        (
          await db.query<{ uses_left: number }>('SELECT uses_left FROM join_tokens WHERE id = $1', [
            id,
          ])
        ).rows[0]!.uses_left,
      );

    it('defers without spending the token, refreshes the one pending request, then consumes the approval once', async () => {
      const attestor = discoveryAttestor({ approval: 'always' });
      const m = machine();
      const issued = await insertToken('discovery', { pool_id: null });
      const first = csr();
      const deferral = await attest(attestor, issued.token, vouch(m), {
        claims: m.claims,
        ...withCsr(first),
      });
      expect(deferral).toMatchObject({ deferred: 'approval', retryAfterSeconds: 30 });
      const requestId = (deferral as { requestId: string }).requestId;
      expect(requestId).toMatch(/^jreq_/);
      expect(await usesLeft(issued.id)).toBe(1);
      expect(await request(requestId)).toMatchObject({
        state: 'pending',
        attestor: 'discovery',
        mac: m.mac,
        vouched_by: agentId,
      });

      // The ramdisk rebooted with a new key: same pending request, now for the newest CSR.
      const second = csr();
      await expect(
        attest(attestor, issued.token, vouch(m), { claims: m.claims, ...withCsr(second) }),
      ).resolves.toMatchObject({
        deferred: 'approval',
        requestId,
      });
      expect(Buffer.from((await request(requestId)).csr_sha256 as Uint8Array)).toEqual(
        Buffer.from(second),
      );

      await db.query(
        `UPDATE join_requests SET state = 'approved', decided_at = compute_now(), decided_by = 'user_ops',
            pool_id = $2, expires_at = compute_now() + interval '1 hour' WHERE id = $1`,
        [requestId, poolId],
      );
      await expect(
        attest(attestor, issued.token, vouch(m), { claims: m.claims, ...withCsr(second) }),
      ).resolves.toMatchObject({
        role: 'ramdisk',
        tokenId: issued.id,
        poolId,
        allowedKinds: discoveryAllowedKinds,
      });
      expect(await usesLeft(issued.id)).toBe(0);
      expect(await request(requestId)).toMatchObject({ state: 'consumed' });
    });

    it('refuses a rejected machine, needs the CSR binding, and skips approval for machines a workflow names', async () => {
      const hook = refusals();
      const attestor = discoveryAttestor({
        ...hook,
        approval: 'unknown-machines',
        resolveWorkflowNode: async () => 'node_known',
      });
      const m = machine();
      const c = csr();
      const issued = await insertToken('discovery', { pool_id: null });
      const deferral = (await attest(attestor, issued.token, vouch(m), {
        claims: m.claims,
        ...withCsr(c),
      })) as { requestId: string };
      await db.query(
        `UPDATE join_requests SET state = 'rejected', decided_at = compute_now(), reason = 'unknown chassis' WHERE id = $1`,
        [deferral.requestId],
      );
      await expect(
        attest(attestor, issued.token, vouch(m), { claims: m.claims, ...withCsr(c) }),
      ).rejects.toMatchObject(denied);
      await expect(
        attest(attestor, issued.token, vouch(m), { claims: m.claims }),
      ).rejects.toMatchObject(denied);
      expect(hook.reasons).toEqual(['rejected', 'no-csr-binding']);

      const known = machine();
      const token2 = await insertToken('discovery', { pool_id: null });
      await expect(
        attest(
          attestor,
          token2.token,
          assertion({ mac: known.mac, productUuid: known.claims.productUuid, workflowId: 'wf_9' }),
          {
            claims: known.claims,
            ...withCsr(csr()),
          },
        ),
      ).resolves.toMatchObject({ role: 'ramdisk', nodeId: 'node_known' });
    });
  });

  it('uses a signed assertion once, and binds a per-machine token to its MAC', async () => {
    const hook = refusals();
    const attestor = discoveryAttestor(hook);
    const captured = assertion({ mac: '3c:ec:ef:10:20:30', issuedAt: now - 30_000 });
    const first = await insertToken('discovery', { pool_id: null });
    await expect(attest(attestor, first.token, captured)).resolves.toMatchObject({
      role: 'ramdisk',
    });
    const second = await insertToken('discovery', { pool_id: null });
    await expect(attest(attestor, second.token, captured)).rejects.toMatchObject(denied);
    // The refused join rolled back: the second token is still unspent.
    const { rows } = await db.query<{ uses_left: number }>(
      'SELECT uses_left FROM join_tokens WHERE id = $1',
      [second.id],
    );
    expect(rows[0]!.uses_left).toBe(1);

    const twoNics = { ...claims, macs: ['3c:ec:ef:10:20:30', '3c:ec:ef:10:20:31'] };
    const forOtherNic = await insertToken('discovery', {
      pool_id: null,
      expect: JSON.stringify({ mac: '3c:ec:ef:10:20:31' }),
    });
    await expect(
      attest(attestor, forOtherNic.token, assertion({ issuedAt: now - 20_000 }), {
        claims: twoNics,
      }),
    ).rejects.toMatchObject(denied);
    expect(hook.reasons).toEqual(['assertion-reused', 'token-mac-mismatch']);
  });

  it('refuses once the vouching agent lost the boot lease', async () => {
    const hook = refusals();
    await db.query(`UPDATE leases SET owner = 'node_someone_else' WHERE name = $1`, [
      `site:${siteId}:boot`,
    ]);
    try {
      const issued = await insertToken('discovery', { pool_id: null });
      await expect(
        attest(discoveryAttestor(hook), issued.token, assertion()),
      ).rejects.toMatchObject(denied);
      expect(hook.reasons).toEqual(['not-boot-lease-holder']);
    } finally {
      await db.query(`UPDATE leases SET owner = $2 WHERE name = $1`, [
        `site:${siteId}:boot`,
        agentId,
      ]);
    }
  });
});

describe('commandKindAllowed', () => {
  it('matches exact kinds and prefix globs; null is unrestricted, [] allows nothing', () => {
    expect(commandKindAllowed('disk.wipe', discoveryAllowedKinds)).toBe(true);
    expect(commandKindAllowed('wipe', discoveryAllowedKinds)).toBe(false);
    expect(commandKindAllowed('diag.dcgm', discoveryAllowedKinds)).toBe(true);
    expect(commandKindAllowed('deploy.image', discoveryAllowedKinds)).toBe(true);
    expect(commandKindAllowed('deploy', discoveryAllowedKinds)).toBe(false);
    expect(commandKindAllowed('diagnose', discoveryAllowedKinds)).toBe(false);
    expect(commandKindAllowed('boot.kexec', discoveryAllowedKinds)).toBe(true);
    expect(commandKindAllowed('boot.prepareRamdisk', discoveryAllowedKinds)).toBe(false);
    expect(commandKindAllowed('exec.run', discoveryAllowedKinds)).toBe(false);
    expect(commandKindAllowed('exec.run', null)).toBe(true);
    expect(commandKindAllowed('exec.run', [])).toBe(false);
    expect(commandKindAllowed('x', ['.*'])).toBe(false);
  });

  it('allows a ramdisk certificate exactly the registered kinds whose roles include ramdisk', () => {
    const ramdiskKinds = [
      ...Object.entries(commandKinds)
        .filter(([, spec]) => spec.roles.includes(AgentRole.RAMDISK))
        .map(([kind]) => kind),
      ...metalCommandKinds
        .filter((spec) => spec.roles.includes('ramdisk'))
        .map((spec) => spec.kind),
    ];
    expect(ramdiskKinds).toEqual(
      expect.arrayContaining(['inventory.refresh', 'disk.wipe', 'deploy.image', 'boot.kexec']),
    );
    for (const kind of ramdiskKinds)
      expect([kind, commandKindAllowed(kind, discoveryAllowedKinds)]).toEqual([kind, true]);
    const others = [
      ...Object.entries(commandKinds)
        .filter(([, spec]) => !spec.roles.includes(AgentRole.RAMDISK))
        .map(([kind]) => kind),
      ...metalCommandKinds
        .filter((spec) => !spec.roles.includes('ramdisk'))
        .map((spec) => spec.kind),
    ].filter((kind) => !ramdiskKinds.includes(kind));
    for (const kind of others)
      expect([kind, commandKindAllowed(kind, discoveryAllowedKinds)]).toEqual([kind, false]);
  });
});

describe('cloud-iid', () => {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'k1';
  const jwks = {
    keys: [{ ...rsa.publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }],
  };
  const audience = 'https://compute.example.com/join';
  const csr = createCsr(generateP256KeyPair().privateKey);

  function jwt(
    payload: Record<string, unknown>,
    header: Record<string, unknown> = { alg: 'RS256', kid },
  ) {
    const enc = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));
    const input = `${enc(header)}.${enc(payload)}`;
    return `${input}.${base64url(new Uint8Array(sign('sha256', Buffer.from(input), rsa.privateKey)))}`;
  }
  const gcpClaims = (overrides: Record<string, unknown> = {}) => ({
    iss: 'https://accounts.google.com',
    aud: cloudIidAudience(audience, sha256(csr)),
    iat: Math.floor(now / 1000) - 30,
    exp: Math.floor(now / 1000) + 3570,
    google: {
      compute_engine: {
        project_id: 'acme-gpu',
        project_number: 1234,
        zone: 'europe-west4-a',
        instance_id: '5550001',
        instance_name: 'gpu-host-1',
        instance_creation_timestamp: Math.floor(now / 1000) - 120,
      },
    },
    ...overrides,
  });

  const resolved: unknown[] = [];
  const resolve = async (
    _tx: unknown,
    identity: { accountId: string; instanceId: string; provider: string },
  ) => {
    resolved.push(identity);
    return identity.accountId === 'acme-gpu' || identity.accountId === '111122223333'
      ? { tenantId: tenant, role: 'node' as const, poolId, siteId }
      : undefined;
  };

  const attest = (
    attestor: ReturnType<typeof cloudIidAttestor>,
    evidence: Parameters<typeof createCloudIidEvidence>[0],
    withCsr = true,
  ) =>
    db.transaction((tx) =>
      attestor.verify(
        { attestor: 'cloud-iid', payload: createCloudIidEvidence(evidence) },
        context(tx, withCsr ? { csrSha256: sha256(csr) } : {}),
      ),
    );

  it('admits a GCP instance whose identity token is bound to the CSR', async () => {
    const attestor = cloudIidAttestor({
      providers: [
        gcpInstanceIdentity({ audience, jwks: staticJwks(jwks), projects: ['acme-gpu'] }),
      ],
      resolve,
    });
    await expect(
      attest(attestor, { provider: 'gcp', document: jwt(gcpClaims()) }),
    ).resolves.toEqual({
      tenantId: tenant,
      role: 'node',
      poolId,
      siteId,
    });
    expect(resolved.at(-1)).toMatchObject({
      provider: 'gcp',
      accountId: 'acme-gpu',
      instanceId: '5550001',
      zone: 'europe-west4-a',
      region: 'europe-west4',
    });
  });

  it('refuses GCP tokens for another CSR, audience, issuer, project, age or key', async () => {
    const hook = refusals();
    const attestor = cloudIidAttestor({
      ...hook,
      providers: [
        gcpInstanceIdentity({ audience, jwks: staticJwks(jwks), projects: ['acme-gpu', 'other'] }),
      ],
      resolve,
    });
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const forged = (() => {
      const token = jwt(gcpClaims());
      const [h, p] = token.split('.');
      return `${h}.${p}.${base64url(new Uint8Array(sign('sha256', Buffer.from(`${h}.${p}`), other.privateKey)))}`;
    })();
    const cases: Array<[string, boolean?]> = [
      [jwt(gcpClaims({ aud: cloudIidAudience(audience, sha256(new Uint8Array([1]))) }))],
      [jwt(gcpClaims({ aud: audience }))],
      [jwt(gcpClaims()), false],
      [jwt(gcpClaims({ iss: 'https://evil.example' }))],
      [jwt(gcpClaims({ iat: Math.floor(now / 1000) - 3000 }))],
      [jwt(gcpClaims({ exp: Math.floor(now / 1000) - 120 }))],
      [forged],
      [jwt(gcpClaims(), { alg: 'none', kid })],
      [jwt(gcpClaims(), { alg: 'RS256', kid: 'unknown' })],
      [jwt(gcpClaims({ google: undefined }))],
    ];
    for (const [document, withCsr] of cases)
      await expect(
        attest(attestor, { provider: 'gcp', document }, withCsr ?? true),
      ).rejects.toMatchObject(denied);
    const project = jwt(
      gcpClaims({
        google: { compute_engine: { ...gcpClaims().google.compute_engine, project_id: 'other' } },
      }),
    );
    await expect(attest(attestor, { provider: 'gcp', document: project })).rejects.toMatchObject(
      denied,
    );
    await expect(attest(attestor, { provider: 'azure', document: 'x' })).rejects.toMatchObject(
      denied,
    );
    expect(hook.reasons).toEqual([
      'gcp:aud',
      'gcp:aud',
      'gcp:no-csr-binding',
      'gcp:iss',
      'gcp:too-old',
      'gcp:expired',
      'gcp:jwt-signature',
      'gcp:jwt-alg',
      'gcp:jwt-unknown-kid',
      'gcp:not-format-full',
      'unknown-instance',
      'unknown-provider',
    ]);
  });

  it('admits each instance once, even with a fresh, correctly bound token', async () => {
    const hook = refusals();
    const attestor = cloudIidAttestor({
      ...hook,
      providers: [gcpInstanceIdentity({ audience, jwks: staticJwks(jwks) })],
      resolve,
    });
    const instance = { ...gcpClaims().google.compute_engine, instance_id: '7770001' };
    const tokenFor = (forCsr: Uint8Array) =>
      jwt(
        gcpClaims({
          aud: cloudIidAudience(audience, sha256(forCsr)),
          google: { compute_engine: instance },
        }),
      );
    await expect(
      attest(attestor, { provider: 'gcp', document: tokenFor(csr) }),
    ).resolves.toMatchObject({
      tenantId: tenant,
    });
    const other = createCsr(generateP256KeyPair().privateKey);
    await expect(
      db.transaction((tx) =>
        attestor.verify(
          {
            attestor: 'cloud-iid',
            payload: createCloudIidEvidence({ provider: 'gcp', document: tokenFor(other) }),
          },
          context(tx, { csrSha256: sha256(other) }),
        ),
      ),
    ).rejects.toMatchObject(denied);
    expect(hook.reasons).toEqual(['instance-reused']);
  });

  it('fetches the JWKS through the injected fetch, caches it and refetches for a new kid', async () => {
    const clock = manualClock(now);
    const urls: string[] = [];
    let served = { keys: [] as unknown[] };
    const source = remoteJwks({
      url: 'https://keys.test/jwks',
      clock,
      fetch: async (url) => {
        urls.push(url);
        return { ok: true, status: 200, json: async () => served };
      },
    });
    expect(await source.key(kid)).toBeUndefined();
    served = jwks;
    expect(await source.key(kid)).toBeUndefined(); // within minRefresh: no refetch
    clock.advance(61_000);
    expect(await source.key(kid)).toBeDefined();
    expect(await source.key(kid)).toBeDefined();
    expect(urls).toEqual(['https://keys.test/jwks', 'https://keys.test/jwks']);
  });

  it('admits an AWS instance at first boot with a document signed by the region key', async () => {
    const hook = refusals();
    const aws = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = aws.publicKey.export({ format: 'pem', type: 'spki' }).toString();
    const attestor = cloudIidAttestor({
      ...hook,
      providers: [
        awsInstanceIdentity({ certificates: { 'eu-central-1': pem }, accounts: ['111122223333'] }),
      ],
      resolve,
    });
    const doc = (overrides: Record<string, unknown> = {}) =>
      JSON.stringify({
        accountId: '111122223333',
        instanceId: 'i-0abc',
        region: 'eu-central-1',
        availabilityZone: 'eu-central-1a',
        pendingTime: new Date(now - 5 * 60_000).toISOString(),
        ...overrides,
      });
    const signed = (document: string, key = aws.privateKey) => ({
      provider: 'aws',
      document,
      signature: Buffer.from(sign('sha256', Buffer.from(document), key)).toString('base64'),
    });
    await expect(attest(attestor, signed(doc()), false)).resolves.toMatchObject({
      tenantId: tenant,
      poolId,
    });
    expect(resolved.at(-1)).toMatchObject({
      provider: 'aws',
      instanceId: 'i-0abc',
      zone: 'eu-central-1a',
    });
    const tampered = signed(doc());
    tampered.document = doc({ instanceId: 'i-0evil' });
    await expect(attest(attestor, tampered)).rejects.toMatchObject(denied);
    await expect(attest(attestor, signed(doc({ region: 'us-east-1' })))).rejects.toMatchObject(
      denied,
    );
    await expect(
      attest(attestor, signed(doc({ pendingTime: new Date(now - 2 * 3_600_000).toISOString() }))),
    ).rejects.toMatchObject(denied);
    await expect(
      attest(attestor, signed(doc({ accountId: '999999999999' }))),
    ).rejects.toMatchObject(denied);
    await expect(attest(attestor, { provider: 'aws', document: doc() })).rejects.toMatchObject(
      denied,
    );
    expect(hook.reasons).toEqual([
      'aws:signature',
      'aws:no-certificate-for-region',
      'aws:too-old',
      'aws:account',
      'aws:no-signature',
    ]);
  });
});
