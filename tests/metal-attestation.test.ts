import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SqlExecutor } from '@better-compute/core';
import { pkiNodeSignatureCheck, resultSigningInput } from '@better-compute/metal';
import { pglite } from '@better-compute/postgres/pglite';
import { createCsr, createNodeCa, generateP256KeyPair, nodeSpiffeId, signNodeStatement, spkiSha256 } from '@better-compute/pki';

// Which node identities may attest a result (§13): platform ones (ramdisk, node), never a lessee's
// node-tenant certificate, a revoked one, or another node's.

const NODE = 'node_0000000000000000000000000q';
const OTHER = 'node_0000000000000000000000000r';
let db: SqlExecutor;
const ca = createNodeCa({});

beforeAll(async () => {
  db = pglite({ analyzeEveryMs: 0 });
  await db.migrate();
  await db.query(`INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site_a', 'root', 'shared', 'eu', 1)`);
  for (const id of [NODE, OTHER])
    await db.query(
      `INSERT INTO nodes (id, site_id, owner_tenant_id, role, provision_state, maintenance, cordoned, connectivity, trust,
         generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
       VALUES ($1, 'site_a', 'root', 'dedicated', 'deployed', false, false, 'connected', 'tenant-controlled', 1, 1, 1, 0, 0, 1)`,
      [id],
    );
});
afterAll(() => db.close());

async function cert(nodeId: string, role: 'ramdisk' | 'node' | 'node-tenant', revoked = false) {
  const key = generateP256KeyPair().privateKey;
  const issued = await ca.sign(createCsr(key), {
    usage: 'client',
    role,
    ttlSeconds: 3600,
    uriSans: [nodeSpiffeId({ trustDomain: 'compute.test', siteId: 'site_a', nodeId })],
  });
  await db.query(
    `INSERT INTO node_certs (serial, node_id, role, identity_gen, spki_sha256, der, not_before, not_after, revoked_at)
     VALUES ($1, $2, $3, 0, $4, $5, $6, $7, CASE WHEN $8 THEN now() END)`,
    [issued.serial, nodeId, role, spkiSha256(key), issued.certificate, new Date(issued.notBefore), new Date(issued.notAfter), revoked],
  );
  return key;
}

describe('pkiNodeSignatureCheck', () => {
  const check = pkiNodeSignatureCheck();
  const input = resultSigningInput('cmd_1', new Uint8Array([1, 2, 3]));
  const statement = (key: Awaited<ReturnType<typeof cert>>, nodeId = NODE, signed = input) => {
    const signature = signNodeStatement(key, signed);
    return { nodeId, input, kid: signature.kid, sig: signature.sig };
  };

  it('accepts platform identities of the node', async () => {
    expect(await check(db, statement(await cert(NODE, 'ramdisk')))).toBe(true);
    expect(await check(db, statement(await cert(NODE, 'node')))).toBe(true);
  });

  it("refuses a lessee's node-tenant key, revoked keys, other nodes' keys and other statements", async () => {
    expect(await check(db, statement(await cert(NODE, 'node-tenant')))).toBe(false);
    expect(await check(db, statement(await cert(NODE, 'ramdisk', true)))).toBe(false);
    expect(await check(db, statement(await cert(OTHER, 'ramdisk')))).toBe(false);
    const other = resultSigningInput('cmd_1', new Uint8Array([9]));
    expect(await check(db, statement(await cert(NODE, 'ramdisk'), NODE, other))).toBe(false);
  });
});
