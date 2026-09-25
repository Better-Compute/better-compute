import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { create, toBinary } from '@bufbuild/protobuf';
import type { SqlExecutor } from '@better-compute/core';
import {
  createCsr,
  createNodeCa,
  generateP256KeyPair,
  nodeSpiffeId,
  signAttestedReport,
  spkiSha256,
} from '@better-compute/pki';
import { pglite } from '@better-compute/postgres/pglite';
import {
  AllocationBoundSchema,
  AllocationReleasedSchema,
  AttestedReportBodySchema,
} from '@better-compute/protocol';
import { pkiAllocationBindingCheck } from '@better-compute/server';

// pkiAllocationBindingCheck (P14, v0.2 exit "a gateway-forged AllocationBound is rejected"): only
// the node's own signature over a report of exactly this allocation, bound, from a certificate role
// that runs workloads, makes a binding count; the signed CDI devices are what counts.

const NOW = Date.UTC(2026, 8, 24, 12);
const NODE = 'node_01k5w00000000000000000bnd1';
const OTHER = 'node_01k5w00000000000000000bnd2';
let db: SqlExecutor;
const keys = new Map<string, ReturnType<typeof generateP256KeyPair>['privateKey']>();

async function certify(nodeId: string, role: string, revoked = false) {
  const key = generateP256KeyPair().privateKey;
  const ca = createNodeCa();
  const issued = await ca.sign(createCsr(key), {
    usage: 'client',
    role: role as 'node',
    ttlSeconds: 86_400,
    uriSans: [nodeSpiffeId({ trustDomain: 'compute.test', siteId: 'site_b', nodeId })],
  });
  await db.query(
    `INSERT INTO node_certs (serial, node_id, role, identity_gen, spki_sha256, der, not_before, not_after, revoked_at)
     VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8)`,
    [
      issued.serial,
      nodeId,
      role,
      spkiSha256(key),
      issued.certificate,
      new Date(NOW - 3_600_000),
      new Date(NOW + 86_400_000),
      revoked ? new Date(NOW - 60_000) : null,
    ],
  );
  return key;
}

beforeAll(async () => {
  db = pglite();
  await db.migrate([]);
  await db.query(
    `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site_b', 'root', 'shared', 'eu', 1)`,
  );
  for (const id of [NODE, OTHER])
    await db.query(
      `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance,
         cordoned, connectivity, trust, generation, observed_generation, next_cmd_seq, identity_gen,
         shard, version)
       VALUES ($1, 'site_b', NULL, 'root', 'host', 'adopted', false, false, 'connected',
         'platform', 1, 1, 1, 1, 0, 1)`,
      [id],
    );
  keys.set(NODE, await certify(NODE, 'node'));
  keys.set(OTHER, await certify(OTHER, 'node'));
});
afterAll(async () => {
  await db.close();
});

function bound(nodeId: string, allocationId: string, cdiDevices = ['bcd.dev/gpu=GPU-1']) {
  return {
    nodeId,
    report: {
      case: 'allocationBound' as const,
      value: create(AllocationBoundSchema, { allocationId, cdiDevices, envFile: '/run/bcd/a.env' }),
    },
  };
}

function evidence(
  key: ReturnType<typeof generateP256KeyPair>['privateKey'],
  body: ReturnType<typeof bound> | { nodeId: string; report: { case: 'allocationReleased'; value: unknown } },
) {
  const signed = signAttestedReport(key, create(AttestedReportBodySchema, body as never));
  return { body: signed.body, kid: signed.nodeSig!.kid, sig: signed.nodeSig!.sig };
}

describe('pkiAllocationBindingCheck', () => {
  const check = pkiAllocationBindingCheck({ now: () => NOW });
  const run = (allocationId: string, nodeId: string, proof: ReturnType<typeof evidence>) =>
    db.transaction((tx) => check(tx, { allocationId, nodeId, evidence: proof }));

  it('accepts the node’s own signed report of this allocation, with the signed devices', async () => {
    const proof = evidence(keys.get(NODE)!, bound(NODE, 'alloc_1', ['bcd.dev/gpu=GPU-7']));
    expect(await run('alloc_1', NODE, proof)).toEqual({
      ok: true,
      cdiDevices: ['bcd.dev/gpu=GPU-7'],
      envFile: '/run/bcd/a.env',
    });
  });

  it('refuses unsigned, forged, swapped, foreign and revoked reports', async () => {
    const good = evidence(keys.get(NODE)!, bound(NODE, 'alloc_1'));
    // Unsigned (the gateway relays an empty node_sig).
    expect(await run('alloc_1', NODE, { ...good, kid: '', sig: new Uint8Array() })).toMatchObject({
      ok: false,
      reason: 'unsigned report',
    });
    // A gateway rewrites the body (other devices) and keeps the signature.
    const forgedBody = toBinary(
      AttestedReportBodySchema,
      create(AttestedReportBodySchema, bound(NODE, 'alloc_1', ['bcd.dev/gpu=GPU-other']) as never),
    );
    expect(await run('alloc_1', NODE, { ...good, body: forgedBody })).toMatchObject({ ok: false });
    // A genuine report of another allocation, swapped in.
    const other = evidence(keys.get(NODE)!, bound(NODE, 'alloc_2'));
    expect(await run('alloc_1', NODE, other)).toMatchObject({
      ok: false,
      reason: 'the signed report is not this allocation bound',
    });
    // Another node's key and body, presented for this node's allocation.
    const foreign = evidence(keys.get(OTHER)!, bound(OTHER, 'alloc_1'));
    expect(await run('alloc_1', NODE, foreign)).toMatchObject({ ok: false });
    // A released report is not a binding.
    const released = evidence(keys.get(NODE)!, {
      nodeId: NODE,
      report: {
        case: 'allocationReleased',
        value: create(AllocationReleasedSchema, { allocationId: 'alloc_1' }),
      },
    });
    expect(await run('alloc_1', NODE, released)).toMatchObject({ ok: false });
    // A revoked certificate.
    const revokedKey = await certify(NODE, 'node', true);
    expect(await run('alloc_1', NODE, evidence(revokedKey, bound(NODE, 'alloc_1')))).toMatchObject({
      ok: false,
      reason: 'certificate revoked',
    });
  });

  it('refuses certificate roles that do not run workloads', async () => {
    const siteKey = await certify(NODE, 'site');
    expect(await run('alloc_1', NODE, evidence(siteKey, bound(NODE, 'alloc_1')))).toMatchObject({
      ok: false,
      reason: 'a site certificate cannot report allocations',
    });
  });
});
