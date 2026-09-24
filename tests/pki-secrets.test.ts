import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { manualClock, type SqlExecutor } from '@better-compute/core';
import { pglite } from '@better-compute/postgres/pglite';
import { create } from '@bufbuild/protobuf';
import { SecretRequestSchema } from '@better-compute/protocol';
import {
  createNodeCa,
  createSecretRequest,
  formatSecretRef,
  generateP256KeyPair,
  localSealedSecretStore,
  nodeSpiffeId,
  openSecretRequest,
  openSecretResponse,
  parseCertificate,
  parseSecretRef,
  refuseSecretRequest,
  sealedSecretsMigration,
  sealSecretResponse,
  spkiSha256,
  type NodeCertLookup,
} from '@better-compute/pki';

const KEY = 'sealing-key-one-at-least-32-bytes-long!!';
const KEY2 = 'sealing-key-two-at-least-32-bytes-long!!';

describe('secret:// refs', () => {
  it('round-trips and refuses anything else', () => {
    expect(parseSecretRef(formatSecretRef('org_acme', 'sec_1'))).toEqual({
      tenantId: 'org_acme',
      id: 'sec_1',
    });
    for (const bad of ['secret://a', 'secret://a/b/c', 'vault://a/b', 'secret://a b/c'])
      expect(parseSecretRef(bad), bad).toBeUndefined();
  });
});

describe('the local sealed store on PGlite', () => {
  let db: SqlExecutor;
  beforeAll(async () => {
    db = pglite();
    await db.migrate([sealedSecretsMigration]);
  });
  afterAll(async () => {
    await db.close();
  });

  it('seals at rest, resolves, replaces and deletes', async () => {
    const store = localSealedSecretStore({ sql: db, keys: KEY });
    expect(store).toMatchObject({ id: 'local-sealed', schemes: ['secret'] });
    const ref = await store.put('org_acme', 'bmc-password-1');
    expect(ref).toMatch(/^secret:\/\/org_acme\/sec_/);
    const { rows } = await db.query<{ ciphertext: Uint8Array }>(
      'SELECT ciphertext FROM sealed_secrets WHERE ref = $1',
      [ref],
    );
    expect(Buffer.from(rows[0]!.ciphertext).toString('utf8')).not.toContain('bmc-password');
    expect(await store.resolve(ref)).toBe('bmc-password-1');
    await store.put('org_acme', 'bmc-password-2', { ref });
    expect(await store.resolve(ref)).toBe('bmc-password-2');
    await store.delete(ref);
    await expect(store.resolve(ref)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('keeps tenants apart and detects rows moved between refs', async () => {
    const store = localSealedSecretStore({ sql: db, keys: KEY });
    const ref = await store.put('org_acme', 'acme-only');
    await expect(store.put('org_evil', 'overwrite', { ref })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(store.put('org_evil', 'x', { ref: 'secret://org_evil/stolen' })).resolves.toBe(
      'secret://org_evil/stolen',
    );
    // Copying acme's ciphertext under the evil ref leaves it unreadable: the AAD binds ref and tenant.
    await db.query(
      `UPDATE sealed_secrets SET iv = a.iv, ciphertext = a.ciphertext, key_id = a.key_id
         FROM sealed_secrets a WHERE sealed_secrets.ref = 'secret://org_evil/stolen' AND a.ref = $1`,
      [ref],
    );
    await expect(store.resolve('secret://org_evil/stolen')).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    await expect(store.resolve('vault://kv/x' as never)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('rotates keys: old values open, reseal moves them to the current key', async () => {
    const old = localSealedSecretStore({ sql: db, keys: { current: 'k1', keys: { k1: KEY } } });
    const ref = await old.put('org_acme', 'rotate-me');
    const rotated = localSealedSecretStore({
      sql: db,
      keys: { current: 'k2', keys: { k1: KEY, k2: KEY2 } },
    });
    expect(await rotated.resolve(ref)).toBe('rotate-me');
    // The row the previous test damaged is reported, and does not stop the others.
    const result = await rotated.reseal();
    expect(result.resealed).toBeGreaterThanOrEqual(1);
    expect(result.unreadable).toEqual(['secret://org_evil/stolen']);
    expect(result.last).toBeUndefined();
    const paged = await rotated.reseal({ limit: 1 });
    expect(paged).toEqual({
      resealed: 0,
      unreadable: ['secret://org_evil/stolen'],
      last: 'secret://org_evil/stolen',
    });
    expect(await rotated.reseal({ limit: 1, after: paged.last! })).toEqual({
      resealed: 0,
      unreadable: [],
    });
    const newOnly = localSealedSecretStore({
      sql: db,
      keys: { current: 'k2', keys: { k2: KEY2 } },
    });
    expect(await newOnly.resolve(ref)).toBe('rotate-me');
    await expect(old.resolve(ref)).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    expect(() => localSealedSecretStore({ sql: db, keys: 'short' })).toThrow(/32 bytes/);
    expect(() =>
      localSealedSecretStore({ sql: db, keys: { current: 'k9', keys: { k1: KEY } } }),
    ).toThrow(/not listed/);
  });
});

describe('SecretRequest and SecretResponse', () => {
  async function node() {
    const clock = manualClock(Date.UTC(2026, 8, 24, 12));
    const ca = createNodeCa({ clock });
    const key = generateP256KeyPair();
    const nodeId = 'node_01k5w0000000000000000000aa';
    const issued = await ca.issue(key.publicKey, {
      usage: 'client',
      role: 'node',
      ttlSeconds: 86_400,
      uriSans: [nodeSpiffeId({ trustDomain: 'compute.test', siteId: 's', nodeId })],
    });
    const cert = parseCertificate(issued.certificate);
    let revokedAt: number | null = null;
    const lookup: NodeCertLookup = async (spki, id) =>
      Buffer.compare(Buffer.from(spki), Buffer.from(spkiSha256(key.publicKey))) === 0 &&
      id === nodeId
        ? {
            serial: cert.serial,
            nodeId,
            role: 'node',
            der: issued.certificate,
            notBefore: cert.notBefore,
            notAfter: cert.notAfter,
            revokedAt,
          }
        : undefined;
    return { clock, key, nodeId, lookup, revoke: () => (revokedAt = clock.now()) };
  }

  it('delivers a value only to the one-time key of a signed, bound request', async () => {
    const n = await node();
    const { request, ephemeralKey } = createSecretRequest({
      nodeKey: n.key.privateKey,
      ref: 'secret://org_acme/bmc',
      workflowId: 'wf_1',
      stepId: 'power',
    });
    expect(request.epk).toHaveLength(65);
    const opened = await openSecretRequest(request, {
      nodeId: n.nodeId,
      lookup: n.lookup,
      now: n.clock.now(),
      isBound: (req) => req.workflowId === 'wf_1' && req.ref === 'secret://org_acme/bmc',
    });
    const response = sealSecretResponse(opened, 'hunter2');
    expect(response.jwe).not.toContain('hunter2');
    expect(
      openSecretResponse(response, ephemeralKey, {
        ref: request.ref,
        requestId: request.requestId,
      }),
    ).toBe('hunter2');
    expect(() => openSecretResponse(response, generateP256KeyPair().privateKey, request)).toThrow();
    expect(() =>
      openSecretResponse(response, ephemeralKey, { ...request, requestId: 'other' }),
    ).toThrow(/another request/);
  });

  it('refuses forged, unbound, foreign and revoked requests with the wire refusal code', async () => {
    const n = await node();
    const options = { nodeId: n.nodeId, lookup: n.lookup, now: n.clock.now(), isBound: () => true };
    const refusal = async (request: Parameters<typeof openSecretRequest>[0], extra = {}) => {
      try {
        await openSecretRequest(request, { ...options, ...extra });
        return 'accepted';
      } catch (error) {
        return (error as { details: { refusal: string } }).details.refusal;
      }
    };
    const { request } = createSecretRequest({
      nodeKey: n.key.privateKey,
      ref: 'secret://org_acme/bmc',
      allocationId: 'alloc_1',
    });
    expect(await refusal(request)).toBe('accepted');
    // A gateway swapping the ref (or the epk) breaks the node signature.
    expect(
      await refusal(create(SecretRequestSchema, { ...request, ref: 'secret://org_acme/other' })),
    ).toBe('access-denied');
    const attacker = generateP256KeyPair();
    const swapped = createSecretRequest({
      nodeKey: attacker.privateKey,
      ref: request.ref,
      allocationId: 'alloc_1',
    });
    expect(
      await refusal(create(SecretRequestSchema, { ...request, epk: swapped.request.epk })),
    ).toBe('access-denied');
    // Signed by another key, or claimed for another node.
    expect(await refusal(swapped.request)).toBe('access-denied');
    expect(await refusal(request, { nodeId: 'node_other' })).toBe('access-denied');
    expect(await refusal(request, { isBound: () => false })).toBe('not-bound');
    const unbound = createSecretRequest({ nodeKey: n.key.privateKey, ref: request.ref });
    expect(await refusal(unbound.request)).toBe('not-bound');
    n.revoke();
    expect(await refusal(request)).toBe('access-denied');
    const refused = refuseSecretRequest(request, 'not-found');
    expect(refused).toMatchObject({ error: 'not-found', jwe: '' });
    expect(() => openSecretResponse(refused, generateP256KeyPair().privateKey, request)).toThrow(
      /not-found/,
    );
  });
});
