import type { KeyObject } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { create, fromBinary } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { defineAttestor, isComputeError, shardOf, type ErrorCode } from '@better-compute/core';
import {
  createCsr,
  createNodeCa,
  createSigningKey,
  generateP256KeyPair,
  issueJoinToken,
  parseCertificate,
  parseCsr,
  sealJoinToken,
  sha256,
  signRenewPop,
  openJoinResponse,
  verifyJoinResponse,
  type LocalCertificateAuthority,
  type SigningKey,
} from '@better-compute/pki';
import {
  AgentRole,
  HardwareClaimsSchema,
  JoinRequestSchema,
  JoinResponseBodySchema,
  RenewRequestSchema,
  type JoinRequest,
  type JoinResponseBody,
  type RenewRequest,
} from '@better-compute/protocol';
import {
  createGatewayServices,
  createJoinService,
  pkiJoinCrypto,
  type JoinCrypto,
  type JoinService,
} from '@better-compute/server';
import { closeFixtures, computeFixture, type ComputeFixture } from '@better-compute/testing';
import { sibling } from './support/runtime.js';

// JoinService and GatewayServices (PLAN.md §3.3 steps 3-4, §7.7, §13) against real PKI: sealed
// join tokens (JWE), a local node CA, the pinned join-signing key and Renew proofs of possession.
// Security negatives from §16 v0.1: maxUses and TTL, expect bindings, reclaim with ≥ 2 identifiers,
// placeholder DMI, node A's certificate cannot renew as node B, PoP replay.

afterEach(closeFixtures);

const TRUST_DOMAIN = 'compute.test';
const SITE = 'site_a';
const POOL = 'pool_h100';

/** A local node CA, the pinned signing key and the encryption key, behind the server's adapter. */
function localPki(clock: { now(): number }) {
  const nodeCa = createNodeCa({ clock, trustDomain: TRUST_DOMAIN });
  const signingKey = createSigningKey({ clock });
  const encryption = generateP256KeyPair();
  const crypto = pkiJoinCrypto({
    trustDomain: TRUST_DOMAIN,
    nodeCa,
    signingKey,
    encryptionKey: encryption.privateKey,
  });
  return { crypto, nodeCa, signingKey, encryption };
}

interface Setup {
  fixture: ComputeFixture;
  service: JoinService;
  crypto: JoinCrypto;
  nodeCa: LocalCertificateAuthority;
  signingKey: SigningKey;
  encryptionKey: KeyObject;
}

async function setup(): Promise<Setup> {
  const fixture = await computeFixture({ clock: 'sim' });
  const { database, compute, tenants } = fixture;
  await database.query(
    `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ($1, $2, 'shared', 'eu-1', 1),
       ('site_custom', $3, 'custom', 'eu-1', 1)`,
    [SITE, tenants.root.id, tenants.acme.id],
  );
  await database.query(
    `INSERT INTO pools (id, owner_tenant_id, site_id, class, gpu_model, sharing, agent, policy, version)
     VALUES ($1, $2, $3, 'metal-host', 'H100', 'exclusive', 'bcd', $4, 1),
            ('pool_other', $2, $3, 'metal-dedicated', 'H100', 'exclusive', 'bcd', '{}', 1),
            ('pool_byo', $5, 'site_custom', 'metal-host', 'H100', 'exclusive', 'bcd', '{}', 1)`,
    [
      POOL,
      tenants.root.id,
      SITE,
      JSON.stringify({ acceptance: [{ kind: 'diag.nvml' }] }),
      tenants.acme.id,
    ],
  );
  const pki = localPki(fixture.clock);
  const service = createJoinService({
    database,
    clock: fixture.clock,
    work: compute.context.work,
    events: compute.context.events,
    authz: compute.context.authz,
    crypto: pki.crypto,
  });
  return {
    fixture,
    service,
    crypto: pki.crypto,
    nodeCa: pki.nodeCa,
    signingKey: pki.signingKey,
    encryptionKey: pki.encryption.publicKey,
  };
}

interface TokenOptions {
  tenantId?: string;
  role?: 'node' | 'site' | 'provisioned' | 'discovery';
  poolId?: string | null;
  siteId?: string | null;
  maxUses?: number;
  ttlSeconds?: number;
  expect?: Record<string, string>;
  allowReclaim?: boolean;
}

async function mintToken(s: Setup, options: TokenOptions = {}) {
  const issued = issueJoinToken();
  await s.fixture.database.query(
    `INSERT INTO join_tokens (id, tenant_id, role, pool_id, site_id, secret_hash, uses_left, expect,
       allow_reclaim, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, compute_now() + make_interval(secs => $10))`,
    [
      issued.id,
      options.tenantId ?? s.fixture.tenants.root.id,
      options.role ?? 'node',
      options.poolId === undefined ? POOL : options.poolId,
      options.siteId ?? null,
      issued.secretHash,
      options.maxUses ?? 1,
      options.expect ? JSON.stringify(options.expect) : null,
      options.allowReclaim ?? false,
      options.ttlSeconds ?? 3600,
    ],
  );
  return issued;
}

type Claims = Partial<{
  productUuid: string;
  productSerial: string;
  boardSerial: string;
  permanentMacs: string[];
  gpuUuids: string[];
}>;

/** A machine: its hardware claims and the daemon's current key. */
function machine(n: number, claims: Claims = {}) {
  const hex = n.toString(16).padStart(2, '0');
  return {
    claims: {
      productUuid: `4c4c4544-0042-3510-8052-b7c04f4e4e${hex}`,
      productSerial: `SN-77${hex}`,
      permanentMacs: [`3c:ec:ef:10:20:${hex}`],
      gpuUuids: [`GPU-6f7c2a11-0000-4b3a-9e5d-0000000000${hex}`],
      ...claims,
    },
    key: generateP256KeyPair().privateKey,
  };
}

function joinRequest(
  s: Setup,
  token: string,
  host: ReturnType<typeof machine>,
  options: { role?: AgentRole; csr?: Uint8Array; sealCsr?: Uint8Array } = {},
): { request: JoinRequest; csr: Uint8Array } {
  const csr = options.csr ?? createCsr(host.key);
  const sealed = sealJoinToken(token, s.encryptionKey, {
    csr: options.sealCsr ?? csr,
    issuedAt: s.fixture.clock.now(),
  });
  return {
    csr,
    request: create(JoinRequestSchema, {
      sealedToken: new TextEncoder().encode(sealed),
      csr,
      claims: create(HardwareClaimsSchema, host.claims),
      daemonVersion: '0.1.0',
      role: options.role ?? AgentRole.NODE,
    }),
  };
}

async function join(s: Setup, token: string, host: ReturnType<typeof machine>) {
  const { request, csr } = joinRequest(s, token, host);
  const response = await s.service.join(request);
  const body = verifyJoinResponse(response, {
    signer: { publicKey: s.signingKey.publicKey },
    csr,
    nodeCaRoots: [s.nodeCa.certificate],
    now: s.fixture.clock.now(),
  });
  return { response, body, csr };
}

async function refusal(promise: Promise<unknown>, code: ErrorCode = 'ACCESS_DENIED') {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!isComputeError(error, code)) throw new Error(`expected ${code}, got ${String(error)}`);
  return (error.details?.reason as string | undefined) ?? '';
}

async function usesLeft(s: Setup, token: { id: string }) {
  const { rows } = await s.fixture.database.query<{ uses_left: number }>(
    'SELECT uses_left FROM join_tokens WHERE id = $1',
    [token.id],
  );
  return Number(rows[0]!.uses_left);
}

async function nodeRow(s: Setup, id: string) {
  const { rows } = await s.fixture.database.query<Record<string, unknown>>(
    `SELECT id, site_id, pool_id, owner_tenant_id, role, provision_state, connectivity, trust,
            encode(hardware_key, 'hex') AS hardware_key, hardware_key_trusted, generation,
            next_cmd_seq, identity_gen, shard FROM nodes WHERE id = $1`,
    [id],
  );
  return rows[0];
}

describe('JoinService.join', () => {
  it('enrolls an adopting node with a 24 h SPIFFE certificate and a signed response', async () => {
    const s = await setup();
    const token = await mintToken(s);
    const host = machine(1);
    const { body, csr } = await join(s, token.token, host);

    expect(body.nodeId).toMatch(/^node_[0-9a-z]{26}$/);
    expect(body).toMatchObject({ siteId: SITE, trustDomain: TRUST_DOMAIN, role: AgentRole.NODE });
    expect(Buffer.from(body.csrSha256).equals(Buffer.from(sha256(csr)))).toBe(true);
    const leaf = parseCertificate(body.certChain[0]!);
    expect(leaf.uriSans).toEqual([`spiffe://${TRUST_DOMAIN}/site/${SITE}/node/${body.nodeId}`]);
    expect(leaf.role).toBe('node');
    expect(leaf.notAfter).toBe(s.fixture.clock.now() + 86_400_000);
    expect(body.certChain.slice(1)).toEqual([s.nodeCa.certificate]);

    expect(await nodeRow(s, body.nodeId)).toMatchObject({
      site_id: SITE,
      pool_id: POOL,
      owner_tenant_id: s.fixture.tenants.root.id,
      role: 'host',
      provision_state: 'adopting',
      connectivity: 'disconnected',
      trust: 'platform',
      hardware_key_trusted: true,
      identity_gen: 1,
      shard: shardOf(body.nodeId),
    });
    const { database } = s.fixture;
    const session = await database.query<{ session_epoch: number; last_seen: Date }>(
      'SELECT session_epoch, last_seen FROM node_sessions WHERE node_id = $1',
      [body.nodeId],
    );
    expect(session.rows).toEqual([
      { session_epoch: 0, last_seen: new Date(s.fixture.clock.now()) },
    ]);
    const certs = await database.query<{ serial: string; role: string; identity_gen: number }>(
      'SELECT serial, role, identity_gen FROM node_certs WHERE node_id = $1',
      [body.nodeId],
    );
    expect(certs.rows).toEqual([{ serial: leaf.serial, role: 'node', identity_gen: 1 }]);
    expect(await usesLeft(s, token)).toBe(0);
    const work = await database.query("SELECT key FROM work_queue WHERE kind = 'node'");
    expect(work.rows).toEqual([{ key: body.nodeId }]);
    const events = await database.query<{ topic: string }>('SELECT topic FROM outbox ORDER BY seq');
    expect(events.rows.map((row) => row.topic)).toEqual(['node.joined']);
    const audit = await database.query<{ action: string; resource_id: string }>(
      'SELECT action, resource_id FROM audit_events',
    );
    expect(audit.rows).toEqual([{ action: 'node.joined', resource_id: body.nodeId }]);
    // IAM decides on compute-node/{id} from the projection (§12.4).
    expect(
      await s.fixture.compute.authz.get('node', body.nodeId, s.fixture.tenants.root.id),
    ).toMatchObject({
      parentType: 'pool',
      parentId: POOL,
      attributes: { lifecycle: 'adopting', trust: 'platform', region: 'eu-1', gpuModel: 'H100' },
    });
    // No IAM call anywhere on the join path (P7).
    expect(s.fixture.iam.calls).toEqual([]);
  });

  it('honours maxUses: single-use by default, then refused', async () => {
    const s = await setup();
    const once = await mintToken(s);
    await join(s, once.token, machine(1));
    expect(await refusal(s.service.join(joinRequest(s, once.token, machine(2)).request))).toBe(
      'token',
    );
    const twice = await mintToken(s, { maxUses: 2 });
    await join(s, twice.token, machine(3));
    await join(s, twice.token, machine(4));
    expect(await usesLeft(s, twice)).toBe(0);
    expect(await refusal(s.service.join(joinRequest(s, twice.token, machine(5)).request))).toBe(
      'token',
    );
  });

  it('expires with its TTL and when revoked', async () => {
    const s = await setup();
    const short = await mintToken(s, { ttlSeconds: 60 });
    await s.fixture.advance(60_000);
    expect(await refusal(s.service.join(joinRequest(s, short.token, machine(1)).request))).toBe(
      'token',
    );
    expect(await usesLeft(s, short)).toBe(1);
    const revoked = await mintToken(s);
    await s.fixture.database.query(
      'UPDATE join_tokens SET revoked_at = compute_now() WHERE id = $1',
      [revoked.id],
    );
    expect(await refusal(s.service.join(joinRequest(s, revoked.token, machine(1)).request))).toBe(
      'token',
    );
  });

  it('refuses a wrong secret, an unreadable seal and a seal made for another CSR', async () => {
    const s = await setup();
    const token = await mintToken(s);
    const forged = `${token.token.slice(0, -4)}AAAA`;
    expect(await refusal(s.service.join(joinRequest(s, forged, machine(1)).request))).toBe('token');
    const host = machine(1);
    const garbage = create(JoinRequestSchema, {
      ...joinRequest(s, token.token, host).request,
      sealedToken: new TextEncoder().encode('not.a.jwe.at.all'),
    });
    expect(await refusal(s.service.join(garbage))).toBe('token');
    const other = createCsr(generateP256KeyPair().privateKey);
    expect(
      await refusal(s.service.join(joinRequest(s, token.token, host, { sealCsr: other }).request)),
    ).toBe('token');
    expect(await usesLeft(s, token)).toBe(1);
  });

  it('refuses a mismatched expect binding without consuming the token', async () => {
    const s = await setup();
    const host = machine(1);
    const bound = await mintToken(s, { expect: { productUuid: machine(2).claims.productUuid } });
    expect(await refusal(s.service.join(joinRequest(s, bound.token, host).request))).toBe('expect');
    expect(await usesLeft(s, bound)).toBe(1);
    const matching = await mintToken(s, {
      expect: { serial: host.claims.productSerial, mac: host.claims.permanentMacs[0]! },
    });
    const { body } = await join(s, matching.token, host);
    expect(body.nodeId).toMatch(/^node_/);
  });

  it('needs expect for a key built from placeholder DMI values', async () => {
    const s = await setup();
    const placeholder = machine(1, {
      productUuid: '03000200-0400-0500-0006-000700080009',
      productSerial: 'To Be Filled By O.E.M.',
      gpuUuids: [],
    });
    const plain = await mintToken(s);
    expect(await refusal(s.service.join(joinRequest(s, plain.token, placeholder).request))).toBe(
      'placeholder-hardware',
    );
    expect(await usesLeft(s, plain)).toBe(1);
    const bound = await mintToken(s, { expect: { mac: placeholder.claims.permanentMacs[0]! } });
    const { body } = await join(s, bound.token, placeholder);
    expect(await nodeRow(s, body.nodeId)).toMatchObject({ hardware_key_trusted: false });
  });

  it('reclaims a trusted key only with allowReclaim, in the same pool, and re-accepts it', async () => {
    const s = await setup();
    const host = machine(1);
    const first = await join(s, (await mintToken(s)).token, host);
    const oldSerial = parseCertificate(first.body.certChain[0]!).serial;

    // The same machine with a new node key.
    const rejoined = { ...host, key: generateP256KeyPair().privateKey };
    const noReclaim = await mintToken(s);
    expect(await refusal(s.service.join(joinRequest(s, noReclaim.token, rejoined).request))).toBe(
      'reclaim',
    );
    const elsewhere = await mintToken(s, { poolId: 'pool_other', allowReclaim: true });
    expect(await refusal(s.service.join(joinRequest(s, elsewhere.token, rejoined).request))).toBe(
      'reclaim',
    );

    const reclaim = await mintToken(s, { allowReclaim: true });
    const second = await join(s, reclaim.token, rejoined);
    expect(second.body.nodeId).toBe(first.body.nodeId);
    expect(await nodeRow(s, first.body.nodeId)).toMatchObject({
      identity_gen: 2,
      provision_state: 'adopting',
    });
    const certs = await s.fixture.database.query<{ serial: string; revoked: boolean }>(
      `SELECT serial, revoked_at IS NOT NULL AS revoked, revocation_reason FROM node_certs
        WHERE node_id = $1 ORDER BY issued_at, serial`,
      [first.body.nodeId],
    );
    expect(certs.rows).toContainEqual(
      expect.objectContaining({ serial: oldSerial, revoked: true, revocation_reason: 'reclaimed' }),
    );
    expect(s.nodeCa.isRevoked(oldSerial)).toBe(true);
    const condition = await s.fixture.database.query(
      "SELECT status, reason FROM node_conditions WHERE node_id = $1 AND type = 'AcceptanceFailed'",
      [first.body.nodeId],
    );
    expect(condition.rows).toEqual([{ status: 'unknown', reason: 'Requested' }]);
    const topics = await s.fixture.database.query<{ topic: string }>(
      'SELECT topic FROM outbox ORDER BY seq',
    );
    expect(topics.rows.map((row) => row.topic)).toContain('security.certificate-revoked');
  });

  it('never reclaims with fewer than two independent identifiers: a new node joins instead', async () => {
    const s = await setup();
    const lonely = machine(1, { productUuid: '', productSerial: '', gpuUuids: [] });
    const mac = lonely.claims.permanentMacs[0]!;
    const a = await join(
      s,
      (await mintToken(s, { expect: { mac }, allowReclaim: true })).token,
      lonely,
    );
    const again = { ...lonely, key: generateP256KeyPair().privateKey };
    const b = await join(
      s,
      (await mintToken(s, { expect: { mac }, allowReclaim: true })).token,
      again,
    );
    expect(b.body.nodeId).not.toBe(a.body.nodeId);
    expect(await nodeRow(s, a.body.nodeId)).toMatchObject({ identity_gen: 1 });
  });

  it('checks the requested role against the token, and joins site agents without a pool', async () => {
    const s = await setup();
    const nodeToken = await mintToken(s);
    expect(
      await refusal(
        s.service.join(
          joinRequest(s, nodeToken.token, machine(1), { role: AgentRole.SITE }).request,
        ),
      ),
    ).toBe('token');
    const siteToken = await mintToken(s, { role: 'site', poolId: null, siteId: SITE });
    const host = machine(2);
    const { request, csr } = joinRequest(s, siteToken.token, host, { role: AgentRole.SITE });
    const body: JoinResponseBody = verifyJoinResponse(await s.service.join(request), {
      signer: { publicKey: s.signingKey.publicKey },
      csr,
    });
    expect(body.role).toBe(AgentRole.SITE);
    expect(parseCertificate(body.certChain[0]!).role).toBe('site');
    expect(await nodeRow(s, body.nodeId)).toMatchObject({ role: 'site', pool_id: null });
  });

  it('marks nodes of a tenant custom site tenant-owned', async () => {
    const s = await setup();
    const token = await mintToken(s, { tenantId: s.fixture.tenants.acme.id, poolId: 'pool_byo' });
    const { body } = await join(s, token.token, machine(1));
    expect(await nodeRow(s, body.nodeId)).toMatchObject({
      owner_tenant_id: s.fixture.tenants.acme.id,
      trust: 'tenant-owned',
      site_id: 'site_custom',
    });
  });
});

describe('JoinService two-round joins (AttestationDeferral)', () => {
  /** An attestor that defers until its evidence says 'answer', recording what it saw in a table. */
  async function deferring(mode: 'approval' | 'challenge') {
    const s = await setup();
    await s.fixture.database.query('CREATE TABLE plg_test_rounds (csr text, evidence text)');
    const attestor = defineAttestor({
      id: 'two-round',
      version: '1.0.0',
      roles: ['node'],
      async verify(evidence, { tx, csrSha256 }) {
        const text = new TextDecoder().decode(evidence.payload);
        await tx.query('INSERT INTO plg_test_rounds VALUES ($1, $2)', [
          Buffer.from(csrSha256!).toString('hex'),
          text,
        ]);
        if (text !== 'answer')
          return mode === 'approval'
            ? { deferred: 'approval', requestId: 'jr_1', retryAfterSeconds: 12 }
            : {
                deferred: 'challenge',
                challenge: new TextEncoder().encode('nonce-1'),
                notAfter: new Date(s.fixture.clock.now() + 300_000),
              };
        return { tenantId: s.fixture.tenants.root.id, role: 'node', poolId: POOL };
      },
    });
    const service = createJoinService({
      database: s.fixture.database,
      clock: s.fixture.clock,
      work: s.fixture.compute.context.work,
      events: s.fixture.compute.context.events,
      crypto: s.crypto,
      attestors: [attestor],
    });
    const host = machine(9);
    const csr = createCsr(host.key);
    const request = (attestation: string) =>
      create(JoinRequestSchema, {
        csr,
        attestor: 'two-round',
        attestation: new TextEncoder().encode(attestation),
        claims: create(HardwareClaimsSchema, host.claims),
        role: AgentRole.NODE,
      });
    return { s, service, csr, request };
  }

  /** The signed body of a deferral: checked like any response, minus the certificate. */
  function deferralOf(s: Setup, response: { body: Uint8Array; sig?: unknown }, csr: Uint8Array) {
    const error = (() => {
      try {
        verifyJoinResponse(response as never, {
          signer: { publicKey: s.signingKey.publicKey },
          csr,
        });
      } catch (reason) {
        return reason;
      }
    })();
    // Signature and CSR binding pass; a deferral is never taken for a join.
    expect(isComputeError(error, 'ACCESS_DENIED') && error.details?.reason).toBe(
      'response is a deferral',
    );
    // openJoinResponse is the agent's way to read it.
    const opened = openJoinResponse(response as never, {
      signer: { publicKey: s.signingKey.publicKey },
      csr,
    });
    expect(opened.kind).not.toBe('joined');
    return fromBinary(JoinResponseBodySchema, response.body);
  }

  it('answers an approval deferral with a signed pending response, commits the attestor rows, issues nothing', async () => {
    const { s, service, csr, request } = await deferring('approval');
    const body = deferralOf(s, await service.join(request('first')), csr);
    expect(body.nodeId).toBe('');
    expect(body.certChain).toHaveLength(0);
    expect(body.deferral?.kind).toMatchObject({
      case: 'pending',
      value: { requestId: 'jr_1', retryAfterSeconds: 12 },
    });
    const rounds = await s.fixture.database.query('SELECT evidence FROM plg_test_rounds');
    expect(rounds.rows).toEqual([{ evidence: 'first' }]);
    const nodes = await s.fixture.database.query('SELECT id FROM nodes');
    expect(nodes.rows).toHaveLength(0);

    // Approved: the retry with the same CSR joins.
    const joined = verifyJoinResponse(await service.join(request('answer')), {
      signer: { publicKey: s.signingKey.publicKey },
      csr,
      nodeCaRoots: [s.nodeCa.certificate],
      now: s.fixture.clock.now(),
    });
    expect(joined.deferral).toBeUndefined();
    expect(await nodeRow(s, joined.nodeId)).toMatchObject({ pool_id: POOL, identity_gen: 1 });
  });

  it('delivers a challenge inside the signed body, bound to the CSR', async () => {
    const { s, service, csr, request } = await deferring('challenge');
    const body = deferralOf(s, await service.join(request('hello')), csr);
    expect(body.deferral?.kind.case).toBe('challenge');
    const challenge = body.deferral!.kind.value as {
      attestor: string;
      payload: Uint8Array;
      notAfter?: { seconds: bigint };
    };
    expect(challenge.attestor).toBe('two-round');
    expect(new TextDecoder().decode(challenge.payload)).toBe('nonce-1');
    expect(Number(challenge.notAfter!.seconds) * 1000).toBe(
      Math.floor((s.fixture.clock.now() + 300_000) / 1000) * 1000,
    );
    expect(Buffer.from(body.csrSha256).equals(Buffer.from(parseCsr(csr).sha256))).toBe(true);
  });
});

describe('JoinService.renew', () => {
  async function enrolled(s: Setup, n: number) {
    const host = machine(n);
    const { body } = await join(s, (await mintToken(s)).token, host);
    return { host, nodeId: body.nodeId, chain: body.certChain };
  }

  function renewRequest(
    s: Setup,
    node: { chain: Uint8Array[] },
    signer: KeyObject,
    options: { nodeId: string; csr?: Uint8Array; clientTime?: number },
  ): RenewRequest {
    const csr = options.csr ?? createCsr(generateP256KeyPair().privateKey);
    const clientTime = options.clientTime ?? s.fixture.clock.now();
    const pop = signRenewPop({ csr, nodeId: options.nodeId, clientTime, privateKey: signer });
    return create(RenewRequestSchema, {
      csr,
      chain: node.chain,
      clientTime: timestampFromMs(clientTime),
      popSig: pop.popSig,
    });
  }

  it('issues a new certificate for a proof of possession by the current key', async () => {
    const s = await setup();
    const node = await enrolled(s, 1);
    await s.fixture.advance(14 * 3600_000);
    const next = generateP256KeyPair().privateKey;
    const csr = createCsr(next);
    const response = await s.service.renew(
      renewRequest(s, node, node.host.key, { nodeId: node.nodeId, csr }),
    );
    const leaf = parseCertificate(response.certChain[0]!);
    expect(leaf.uriSans).toEqual([`spiffe://${TRUST_DOMAIN}/site/${SITE}/node/${node.nodeId}`]);
    expect(leaf.publicKey.equals(parseCsr(csr).publicKey)).toBe(true);
    expect(Number(response.notAfter!.seconds) * 1000).toBe(leaf.notAfter);
    const certs = await s.fixture.database.query(
      'SELECT serial FROM node_certs WHERE node_id = $1',
      [node.nodeId],
    );
    expect(certs.rowCount).toBe(2);
    expect(s.fixture.iam.calls).toEqual([]);
  });

  it("refuses node A's certificate renewing as node B", async () => {
    const s = await setup();
    const a = await enrolled(s, 1);
    const b = await enrolled(s, 2);
    // A signs a proof naming B: the node id comes from compute's record of A's certificate.
    expect(
      await refusal(s.service.renew(renewRequest(s, a, a.host.key, { nodeId: b.nodeId }))),
    ).toBe('proof');
    // A presents B's (public) certificate with its own key.
    expect(
      await refusal(s.service.renew(renewRequest(s, b, a.host.key, { nodeId: b.nodeId }))),
    ).toBe('proof');
    // The gateway saw A's mTLS identity, but the chain is B's.
    expect(
      await refusal(
        s.service.renew(renewRequest(s, b, b.host.key, { nodeId: b.nodeId }), {
          peerNodeId: a.nodeId,
        }),
      ),
    ).toBe('peer');
  });

  it('rejects a replayed proof and a client time outside ±60 s', async () => {
    const s = await setup();
    const node = await enrolled(s, 1);
    const request = renewRequest(s, node, node.host.key, { nodeId: node.nodeId });
    await s.service.renew(request);
    expect(await refusal(s.service.renew(request))).toBe('replay');
    await s.fixture.advance(121_000);
    // The proof outlived the cache, but its client time left the window long before.
    expect(await refusal(s.service.renew(request))).toBe('client-time');
    const early = renewRequest(s, node, node.host.key, {
      nodeId: node.nodeId,
      clientTime: s.fixture.clock.now() + 61_000,
    });
    expect(await refusal(s.service.renew(early))).toBe('client-time');
  });

  it('refuses revoked, expired and foreign certificates', async () => {
    const s = await setup();
    const node = await enrolled(s, 1);
    await s.fixture.database.query(
      'UPDATE node_certs SET revoked_at = compute_now() WHERE node_id = $1',
      [node.nodeId],
    );
    expect(
      await refusal(s.service.renew(renewRequest(s, node, node.host.key, { nodeId: node.nodeId }))),
    ).toBe('revoked');

    const fresh = await enrolled(s, 2);
    await s.fixture.advance(86_400_000);
    expect(
      await refusal(
        s.service.renew(renewRequest(s, fresh, fresh.host.key, { nodeId: fresh.nodeId })),
      ),
    ).toBe('revoked');

    // A certificate from another CA with the same identity is not one compute issued.
    const rogueCa = createNodeCa({ clock: s.fixture.clock, trustDomain: TRUST_DOMAIN });
    const rogueKey = generateP256KeyPair().privateKey;
    const rogue = await rogueCa.sign(createCsr(rogueKey), {
      uriSans: [`spiffe://${TRUST_DOMAIN}/site/${SITE}/node/${fresh.nodeId}`],
      role: 'node',
      usage: 'client',
      ttlSeconds: 3600,
    });
    expect(
      await refusal(
        s.service.renew(
          renewRequest(s, { chain: [rogue.certificate] }, rogueKey, { nodeId: fresh.nodeId }),
        ),
      ),
    ).toBe('certificate');
  });
});

describe('GatewayServices', () => {
  it('delegates join and renew to JoinService; the secret broker arrives in v0.2', async () => {
    const s = await setup();
    const services = createGatewayServices({
      database: s.fixture.database,
      clock: s.fixture.clock,
      work: s.fixture.compute.context.work,
      events: s.fixture.compute.context.events,
      pki: { join: s.crypto },
    });
    const { request } = joinRequest(s, (await mintToken(s)).token, machine(1));
    const response = await services.join(request);
    expect(response.sig?.kid).toBe(s.signingKey.kid);
    const secret = await services.secret({} as never).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(isComputeError(secret, 'NOT_IMPLEMENTED')).toBe(true);
    expect((secret as Error).message).toBe('The secret broker arrives in v0.2');
  });

  it('refuses to join without the JoinService keys (INVALID_CONFIG)', async () => {
    const s = await setup();
    const { request } = joinRequest(s, (await mintToken(s)).token, machine(1));
    expect(await refusal(s.fixture.compute.gatewayServices.join(request), 'INVALID_CONFIG')).toBe(
      '',
    );
  });

  it('is what betterCompute({ pki: { join } }) hands the gateway, joined to the node controllers', async () => {
    const s = await setup();
    const compute = await sibling(s.fixture, {
      pki: { nodeCa: s.nodeCa, join: s.crypto } as never,
    });
    const token = await mintToken(s);
    const { request, csr } = joinRequest(s, token.token, machine(1));
    const body = verifyJoinResponse(await compute.gatewayServices.join(request), {
      signer: { publicKey: s.signingKey.publicKey },
      csr,
    });
    // The join woke the node reconciler, which waits for the daemon's Hello before acceptance.
    expect(await compute.jobs.node!.tick()).toBe(1);
    expect(await nodeRow(s, body.nodeId)).toMatchObject({ provision_state: 'adopting' });
    const acceptance = await s.fixture.database.query(
      'SELECT count(*)::int AS n FROM commands WHERE node_id = $1',
      [body.nodeId],
    );
    expect(acceptance.rows).toEqual([{ n: 0 }]);
    await compute.stop();
  });
});

describe('JoinService restricted certificates (AttestationResult.allowedKinds, certTtlSeconds)', () => {
  const kinds = ['inventory', 'diag.*', 'wipe'];

  async function restricted(allowedKinds: readonly string[] = kinds, certTtlSeconds = 5400) {
    const s = await setup();
    const service = createJoinService({
      database: s.fixture.database,
      clock: s.fixture.clock,
      work: s.fixture.compute.context.work,
      events: s.fixture.compute.context.events,
      crypto: s.crypto,
      attestors: [
        defineAttestor({
          id: 'restricted',
          version: '1.0.0',
          roles: ['ramdisk'],
          async verify() {
            return {
              tenantId: s.fixture.tenants.root.id,
              role: 'ramdisk',
              siteId: SITE,
              certTtlSeconds,
              allowedKinds,
            };
          },
        }),
      ],
    });
    const host = machine(21);
    const csr = createCsr(host.key);
    const request = create(JoinRequestSchema, {
      csr,
      attestor: 'restricted',
      claims: create(HardwareClaimsSchema, host.claims),
      role: AgentRole.RAMDISK,
    });
    return { s, service, host, csr, request };
  }

  const certRows = (s: Setup, nodeId: string) =>
    s.fixture.database
      .query<{ allowed_kinds: string[] | null; ttl: number }>(
        `SELECT allowed_kinds, extract(epoch FROM not_after - issued_at)::int AS ttl
           FROM node_certs WHERE node_id = $1 ORDER BY issued_at, serial`,
        [nodeId],
      )
      .then((r) => r.rows);

  it('persists the allowed kinds and the shorter lifetime, and renew keeps the restriction', async () => {
    const { s, service, host, csr, request } = await restricted();
    const body = verifyJoinResponse(await service.join(request), {
      signer: { publicKey: s.signingKey.publicKey },
      csr,
      nodeCaRoots: [s.nodeCa.certificate],
      now: s.fixture.clock.now(),
    });
    expect(await certRows(s, body.nodeId)).toEqual([{ allowed_kinds: kinds, ttl: 5400 }]);

    await s.fixture.advance(60_000);
    const nextCsr = createCsr(host.key);
    const pop = signRenewPop({
      csr: nextCsr,
      nodeId: body.nodeId,
      clientTime: s.fixture.clock.now(),
      privateKey: host.key,
    });
    await service.renew(
      create(RenewRequestSchema, {
        csr: nextCsr,
        chain: body.certChain,
        clientTime: pop.clientTime,
        popSig: pop.popSig,
      }),
    );
    const rows = await certRows(s, body.nodeId);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ allowed_kinds: kinds });
    expect(rows[1]!.ttl).toBeLessThanOrEqual(2 * 3600); // the ramdisk cap still applies
  });

  it('caps an attestor asking for more than the role allows, and refuses malformed kinds', async () => {
    const long = await restricted(kinds, 86_400);
    const body = verifyJoinResponse(await long.service.join(long.request), {
      signer: { publicKey: long.s.signingKey.publicKey },
      csr: long.csr,
    });
    expect((await certRows(long.s, body.nodeId))[0]!.ttl).toBe(2 * 3600);

    const bad = await restricted(['wipe; DROP TABLE nodes']);
    const error = await bad.service.join(bad.request).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(isComputeError(error, 'INVALID_CONFIG')).toBe(true);
    const certs = await bad.s.fixture.database.query('SELECT 1 FROM node_certs');
    expect(certs.rows).toHaveLength(0);
  });
});

describe('JoinService security.join.refused', () => {
  async function recording() {
    const s = await setup();
    const service = createJoinService({
      database: s.fixture.database,
      clock: s.fixture.clock,
      work: s.fixture.compute.context.work,
      events: s.fixture.compute.context.events,
      crypto: s.crypto,
      rootTenantId: s.fixture.tenants.root.id,
    });
    const refused = async () =>
      (
        await s.fixture.database.query<{
          payload: { tenantId: string; data: Record<string, unknown> };
        }>(`SELECT payload FROM outbox WHERE topic = 'security.join.refused' ORDER BY seq`)
      ).rows.map((row) => row.payload);
    return { s, service, refused };
  }

  it('bounds a spray of bad tokens to 60 root-tenant events and reports what it suppressed', async () => {
    const { s, service, refused } = await recording();
    const real = await mintToken(s, { tenantId: s.fixture.tenants.acme.id });
    const forged = `${real.token.slice(0, -4)}AAAA`; // a real id, a wrong secret
    for (let i = 0; i < 200; i++)
      expect(
        await refusal(service.join(joinRequest(s, forged, machine(40 + (i % 50))).request)),
      ).toBe('token');
    let events = await refused();
    expect(events).toHaveLength(60);
    // The id is real but the secret is not: nothing is attributed to acme, and no token id leaks.
    for (const event of events) {
      expect(event.tenantId).toBe(s.fixture.tenants.root.id);
      expect(event.data).toMatchObject({
        attestor: 'join-token',
        reason: 'join-token:secret-mismatch',
      });
      expect(event.data.tokenId).toBeUndefined();
      expect(JSON.stringify(event)).not.toContain(forged.split('.')[1]!);
    }
    expect(events[0]!.data).toMatchObject({
      suppressed: 0,
      csrSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });

    await s.fixture.advance(2_000); // two tokens refill
    await refusal(service.join(joinRequest(s, forged, machine(99)).request));
    events = await refused();
    expect(events).toHaveLength(61);
    expect(events[60]!.data.suppressed).toBe(140);
  });

  it("attributes a refusal after the token's secret verified to the token's tenant", async () => {
    const { s, service, refused } = await recording();
    const token = await mintToken(s, { tenantId: s.fixture.tenants.acme.id });
    // A valid node token presented by a site agent: authenticated, then refused for its role.
    expect(
      await refusal(
        service.join(joinRequest(s, token.token, machine(7), { role: AgentRole.SITE }).request),
      ),
    ).toBe('token');
    const [event] = await refused();
    expect(event).toMatchObject({
      tenantId: s.fixture.tenants.acme.id,
      data: { attestor: 'join-token', reason: 'join-token:role-mismatch', tokenId: token.id },
    });
    expect(JSON.stringify(event)).not.toContain(token.token.split('.')[1]!);
  });
});

describe('JoinService node bindings (AttestationResult.bind)', () => {
  it('binds a proven hardware subject to one node and refuses it for any other', async () => {
    const s = await setup();
    let subject: Uint8Array = new Uint8Array(32).fill(0xe5);
    const service = createJoinService({
      database: s.fixture.database,
      clock: s.fixture.clock,
      work: s.fixture.compute.context.work,
      events: s.fixture.compute.context.events,
      crypto: s.crypto,
      attestors: [
        defineAttestor({
          id: 'binder',
          version: '1.0.0',
          roles: ['node'],
          async verify() {
            return {
              tenantId: s.fixture.tenants.root.id,
              role: 'node',
              poolId: POOL,
              bind: subject,
            };
          },
        }),
      ],
    });
    const joinAs = (n: number) => {
      const host = machine(n);
      return service.join(
        create(JoinRequestSchema, {
          csr: createCsr(host.key),
          attestor: 'binder',
          claims: create(HardwareClaimsSchema, host.claims),
          role: AgentRole.NODE,
        }),
      );
    };
    const first = fromBinary(JoinResponseBodySchema, (await joinAs(31)).body);
    const bound = await s.fixture.database.query<{ node_id: string }>(
      `SELECT node_id FROM node_bindings WHERE attestor = 'binder'`,
    );
    expect(bound.rows).toEqual([{ node_id: first.nodeId }]);

    // Another machine claiming the same subject would become a second node: refused, rolled back.
    expect(await refusal(joinAs(32))).toBe('bound-elsewhere');
    const nodes = await s.fixture.database.query('SELECT id FROM nodes');
    expect(nodes.rows).toHaveLength(1);

    subject = new Uint8Array(16);
    const error = await joinAs(33).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(isComputeError(error, 'INVALID_CONFIG')).toBe(true);
  });
});
