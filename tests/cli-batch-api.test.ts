import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCli, type CliIO } from '@better-compute/cli';
import {
  createApproverKey,
  createCommandSigningAuthority,
  createNodeCa,
  createSigningKey,
  expectedPayloadType,
  generateP256KeyPair,
} from '@better-compute/pki';
import { pglite } from '@better-compute/postgres/pglite';
import { encodeMessageJson } from '@better-compute/protocol';
import {
  betterCompute,
  createCommandBatch,
  pkiJoinCrypto,
  quorumConfigOf,
  type BetterCompute,
} from '@better-compute/server';
import { fakeIam } from './support/fake-iam.js';
import { ACME, BASE_URL, options } from './support/server.js';

// `better-compute batch show / approve / cancel` against the real commandBatches API (PLAN.md §13): the CLI pages the
// scope, recomputes the root the server asks approvers to sign, shows every subject, and signs only then; k approvals
// release the batch. A server that lists other commands than its root commits to is refused (SCOPE_MISMATCH).

const TOKEN = 'biam_ses_ops_batch_test';
let compute: BetterCompute<any, any> | undefined;
afterEach(async () => {
  await compute?.stop().catch(() => undefined);
  compute = undefined;
});

const digest = (bytes: Uint8Array) => new Uint8Array(createHash('sha256').update(bytes).digest());
/** A leaf bound to its operation, with the payload stored for approvers to read. */
const leaf = (subject: string, kind: string, typeName: string, json: unknown) => {
  const value = encodeMessageJson(typeName, json);
  return { subject, kind, payloadSha256: digest(value), payload: { typeUrl: `type.googleapis.com/${typeName}`, value } };
};
// (Built-in destructive kinds: this deployment registers no module kinds.)
const scope = [
  leaf('node_a', 'node.reboot', 'bettercompute.agent.v1.NodeRebootRequest', { reason: 'rack 7 reimage' }),
  leaf('node_b', 'node.reboot', 'bettercompute.agent.v1.NodeRebootRequest', { reason: 'rack 7 reimage' }),
  leaf('node_site', 'gpu.reset', 'bettercompute.agent.v1.GpuResetRequest', { gpuUuids: ['GPU-0a1b'] }),
];

async function setup() {
  const db = pglite();
  const approvers = [createApproverKey(), createApproverKey()];
  const iam = fakeIam({
    callers: {
      [TOKEN]: { identityId: 'idn_ops', identityKind: 'user', tenantId: ACME, sessionId: 'ses_ops', sessionKind: 'user' },
    },
    allow: [{}],
  });
  compute = betterCompute({
    ...options(db, iam),
    pki: {
      commandSigning: createCommandSigningAuthority(),
      // JoinService: its trust domain is a signed part of every approval.
      join: pkiJoinCrypto({
        trustDomain: 'compute.test',
        nodeCa: createNodeCa(),
        signingKey: createSigningKey(),
        encryptionKey: generateP256KeyPair().privateKey,
      }),
      approvers: { keys: approvers.map((approver) => approver.key.spkiDer), threshold: 2 },
    },
  } as never) as BetterCompute<any, any>;
  await compute.initialize();
  // Batch subjects are the tenant's own nodes (the site agent for bmc:), checked at creation.
  await db.query(`INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site_b', $1, 'shared', 'eu', 1)`, [
    ACME,
  ]);
  for (const id of ['node_a', 'node_b', 'node_site'])
    await db.query(
      `INSERT INTO nodes (id, site_id, owner_tenant_id, role, provision_state, maintenance, cordoned, connectivity,
         trust, generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
       VALUES ($1, 'site_b', $2, 'host', 'ready', false, false, 'disconnected', 'platform', 0, 0, 1, 1, 0, 1)`,
      [id, ACME],
    );
  const quorum = quorumConfigOf({ approverKeys: approvers.map((approver) => approver.key), approverThreshold: 2 } as never);
  const created = await db.transaction((tx) =>
    createCommandBatch(
      tx,
      { tenantId: ACME, scope, reason: 'reimage rack 7', notAfterMs: Date.now() + 3_600_000 } as never,
      { now: Date.now(), quorum, payloadTypeOf: expectedPayloadType } as never,
    ),
  );
  const cwd = await mkdtemp(join(tmpdir(), 'bc-batch-api-'));
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    cwd,
    env: {
      BETTER_COMPUTE_URL: BASE_URL,
      BETTER_COMPUTE_TOKEN: TOKEN,
      BETTER_COMPUTE_TENANT: ACME,
      // The deployment this approver approves for (not the server's word for it).
      BETTER_COMPUTE_TRUST_DOMAIN: 'compute.test',
    },
    fetch: async (input, init) => compute!.handler(new Request(input, init)),
  };
  const run = async (argv: string[]) => {
    out.length = 0;
    err.length = 0;
    await createCli().run(argv, io);
    return JSON.parse(out.join('\n'));
  };
  // The two approvers' private keys, as their operators hold them.
  for (const [i, name] of ['alice', 'bob'].entries())
    await writeFile(join(cwd, `${name}.pem`), approvers[i]!.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), {
      mode: 0o600,
    });
  return { db, batchId: (created as { batchId: string }).batchId, cwd, err, run, io };
}

describe('batch commands against commandBatches', () => {
  it('shows a verified batch, stops without --yes, and releases it at k approvals', { timeout: 60_000 }, async () => {
    const s = await setup();
    const shown = await s.run(['batch', 'show', '--batch', s.batchId, '--scope-out', 'batch.json']);
    expect(shown).toMatchObject({ batchId: s.batchId, state: 'pending', scopeSize: 3, scopeVerified: true, subjects: 3 });
    const file = JSON.parse(await readFile(join(s.cwd, 'batch.json'), 'utf8'));
    expect(file).toMatchObject({ batchId: s.batchId, scopeRoot: shown.scopeRoot, trustDomain: shown.trustDomain });
    expect(file.scope).toHaveLength(3);

    // Without --yes: the summary, every subject, and nothing signed.
    const dry = await s.run(['batch', 'approve', '--batch', s.batchId, '--key', 'alice.pem']);
    expect(dry).toMatchObject({ approved: false, scopeRoot: shown.scopeRoot });
    expect(s.err.join('\n')).toMatch(/reimage rack 7/);
    expect(s.err.join('\n')).toMatch(/gpu\.reset: node_site/);
    // The operations themselves, decoded from the stored payloads the leaves bind (MEDIUM-3).
    expect(s.err.join('\n')).toMatch(/Operations:/);
    expect(s.err.join('\n')).toMatch(/node\.reboot ×2: \{"reason":"rack 7 reimage"\}/);
    expect(s.err.join('\n')).toMatch(/gpu\.reset ×1: \{"gpuUuids":\["GPU-0a1b"\]\}/);

    // A server of another deployment (or one lying about its own): refused before anything is signed.
    await expect(
      s.run(['batch', 'approve', '--batch', s.batchId, '--key', 'alice.pem', '--yes', '--trust-domain', 'prod.test']),
    ).rejects.toMatchObject({ code: 'TRUST_DOMAIN_MISMATCH' });
    // A reviewed root that changed is refused; the reviewed one is approved.
    await expect(
      s.run(['batch', 'approve', '--batch', s.batchId, '--key', 'alice.pem', '--root', '00'.repeat(32)]),
    ).rejects.toMatchObject({ code: 'SCOPE_CHANGED' });
    const first = await s.run(['batch', 'approve', '--batch', s.batchId, '--key', 'alice.pem', '--root', shown.scopeRoot]);
    expect(first).toMatchObject({ state: 'pending', approvals: [expect.objectContaining({})] });
    // The same key again changes nothing.
    await s.run(['batch', 'approve', '--batch', s.batchId, '--key', 'alice.pem', '--yes']);
    expect(s.err.join('\n')).toMatch(/already approved/);

    // The second approver signs offline from the scope file, and the signature is submitted.
    const signed = await s.run(['batch', 'sign', '--key', 'bob.pem', '--scope', 'batch.json']);
    await writeFile(join(s.cwd, 'bob.sig.json'), JSON.stringify(signed));
    const released = await s.run(['batch', 'approve', '--batch', s.batchId, '--signature', 'bob.sig.json']);
    expect(released).toMatchObject({ state: 'approved' });
    expect(released.approvals).toHaveLength(2);
    await expect(s.run(['batch', 'cancel', '--batch', s.batchId])).rejects.toMatchObject({ code: 'INVALID_STATE' });
    const listed = await s.run(['batch', 'list', '--state', 'approved']);
    expect(listed.items.map((item: { batchId: string }) => item.batchId)).toEqual([s.batchId]);
  });

  it('refuses a batch whose listed commands do not give its root, and cancels on request', { timeout: 60_000 }, async () => {
    const s = await setup();
    // The control plane lists one more BMC than the root it asks approvers to sign commits to.
    await s.db.query(
      `INSERT INTO command_batch_scope (batch_id, leaf_index, subject, kind, proof)
       SELECT batch_id, 99, 'bmc:node_site/10.0.0.99', 'bmc.power', proof FROM command_batch_scope WHERE batch_id = $1 LIMIT 1`,
      [s.batchId],
    );
    await expect(s.run(['batch', 'show', '--batch', s.batchId])).rejects.toMatchObject({ code: 'SCOPE_MISMATCH' });
    await expect(s.run(['batch', 'approve', '--batch', s.batchId, '--key', 'alice.pem', '--yes'])).rejects.toMatchObject({
      code: 'SCOPE_MISMATCH',
    });
    const cancelled = await s.run(['batch', 'cancel', '--batch', s.batchId]);
    expect(cancelled).toMatchObject({ state: 'cancelled' });
  });
});
