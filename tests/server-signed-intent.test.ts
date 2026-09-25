import { create, fromBinary } from '@bufbuild/protobuf';
import { afterEach, describe, expect, it } from 'vitest';
import { manualClock, type SqlExecutor } from '@better-compute/core';
import { pglite } from '@better-compute/postgres/pglite';
import {
  createApproverKey,
  createCommandSigningAuthority,
  createNodeCa,
  createSigningKey,
  generateP256KeyPair,
  verifyCommand,
  verifyTrustBundle,
} from '@better-compute/pki';
import { CommandSchema, SignatureSchema } from '@better-compute/protocol';
import { betterCompute, pkiJoinCrypto } from '@better-compute/server';
import { fakeIam } from './support/fake-iam.js';
import { options } from './support/server.js';

// Signed intent on the server side (PLAN.md §13, v0.2): with `pki.commandSigning`, every command the
// queue writes carries a worker signature daemons can verify, and the trust bundle (roots + version)
// reaches them through JoinResponse.trust and a join-key-signed Welcome.trust.

const T0 = Date.UTC(2026, 8, 24, 12);
let db: SqlExecutor | undefined;
afterEach(async () => {
  await db?.close();
  db = undefined;
});

async function server(pki: Record<string, unknown> | undefined) {
  db = pglite();
  const clock = manualClock(T0);
  const compute = betterCompute({
    ...options(db, fakeIam()),
    clock,
    ...(pki ? { pki } : {}),
  } as never) as any;
  await compute.initialize();
  await db.query(
    `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site_i', 'org_root', 'shared', 'eu', 1)`,
  );
  await db.query(
    `INSERT INTO nodes (id, site_id, owner_tenant_id, role, provision_state, maintenance, cordoned, connectivity,
       trust, generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
     VALUES ('node_i', 'site_i', 'org_root', 'unassigned', 'adopted', false, false, 'connected', 'platform',
       0, 0, 1, 1, 0, 1)`,
  );
  const enqueue = (kind: string, key: string) =>
    db!.transaction((tx) =>
      compute.context.commands.enqueue(tx, {
        nodeId: 'node_i',
        kind,
        payload: undefined,
        idempotencyKey: key,
        notAfter: T0 + 3_600_000,
      }),
    );
  const row = async (id: string) =>
    (
      await db!.query<{ body: Uint8Array; signature: Uint8Array | null }>(
        'SELECT body, signature FROM commands WHERE id = $1',
        [id],
      )
    ).rows[0]!;
  return { compute, clock, enqueue, row };
}

describe('server signed intent', () => {
  it('signs every command with a worker key certified by the command-signing root', async () => {
    const authority = createCommandSigningAuthority({ clock: manualClock(T0 - 60_000) });
    const s = await server({ commandSigning: authority });
    for (const [kind, key] of [
      ['node.reboot', 'reboot-1'],
      ['diag.nvml', 'diag-1'],
    ] as const) {
      const { id } = await s.enqueue(kind, key);
      const stored = await s.row(id);
      expect(stored.signature).not.toBeNull();
      const signature = fromBinary(SignatureSchema, new Uint8Array(stored.signature!));
      // Exactly what a daemon runs: the chain to the trusted root, the EKU, then ES256 over the body.
      const body = verifyCommand(
        create(CommandSchema, { body: new Uint8Array(stored.body), signature }),
        {
          roots: [authority.certificate],
          now: T0,
          nodeId: 'node_i',
          required: true,
        },
      );
      expect(body.kind).toBe(kind);
      // Another root does not vouch for it.
      expect(() =>
        verifyCommand(create(CommandSchema, { body: new Uint8Array(stored.body), signature }), {
          roots: [createCommandSigningAuthority().certificate],
          now: T0,
          nodeId: 'node_i',
          required: true,
        }),
      ).toThrow(/rejected/);
    }
  });

  it('publishes the roots and version in JoinResponse.trust and a join-key-signed Welcome.trust', async () => {
    const authority = createCommandSigningAuthority({ clock: manualClock(T0 - 60_000) });
    const previous = createCommandSigningAuthority({
      clock: manualClock(T0 - 60_000),
      commonName: 'old root',
    });
    const signingKey = createSigningKey({ clock: manualClock(T0 - 60_000) });
    const join = pkiJoinCrypto({
      trustDomain: 'compute.test',
      nodeCa: createNodeCa({ clock: manualClock(T0 - 60_000) }),
      signingKey,
      encryptionKey: generateP256KeyPair().privateKey,
    });
    const s = await server({
      join,
      commandSigning: authority,
      commandSigningRoots: [previous.certificate], // a rotation in progress
      trustVersion: 3,
    });
    const signed = await s.compute.gatewayServices.trustBundle();
    const bundle = verifyTrustBundle(signed, { publicKey: signingKey.publicKey });
    expect(bundle.version).toBe(3n);
    expect(bundle.commandSigningRoots.map((root) => Buffer.from(root))).toEqual([
      Buffer.from(authority.certificate),
      Buffer.from(previous.certificate),
    ]);
    // Cached: the same signed bytes for every Welcome.
    expect((await s.compute.gatewayServices.trustBundle()).body).toEqual(signed.body);
  });

  it('publishes the v1.0 quorum (approver keys, threshold, tiers) in the signed trust bundle', async () => {
    const authority = createCommandSigningAuthority({ clock: manualClock(T0 - 60_000) });
    const signingKey = createSigningKey({ clock: manualClock(T0 - 60_000) });
    const join = pkiJoinCrypto({
      trustDomain: 'compute.test',
      nodeCa: createNodeCa({ clock: manualClock(T0 - 60_000) }),
      signingKey,
      encryptionKey: generateP256KeyPair().privateKey,
    });
    const approvers = [createApproverKey(), createApproverKey(), createApproverKey()];
    const s = await server({
      join,
      commandSigning: authority,
      trustVersion: 4,
      approvers: {
        keys: approvers.map((approver) => approver.key.spkiDer),
        threshold: 2,
        tiers: [{ maxScopeSize: 5, threshold: 1 }],
      },
    });
    const bundle = verifyTrustBundle(await s.compute.gatewayServices.trustBundle(), {
      publicKey: signingKey.publicKey,
    });
    expect(bundle.approverKeys.map((key) => key.kid)).toEqual(
      approvers.map((approver) => approver.key.kid),
    );
    expect(bundle).toMatchObject({
      approverThreshold: 2,
      unbatchedDestructivePerHour: 0,
      quorumTiers: [{ maxScopeSize: 5, threshold: 1 }],
    });
    // Refused: no signed intent, a threshold above the key count, a non-P-256 key.
    const keys = approvers.map((approver) => approver.key.spkiDer);
    for (const pki of [
      { approvers: { keys, threshold: 1 } },
      { commandSigning: authority, approvers: { keys, threshold: 4 } },
      { commandSigning: authority, approvers: { keys: [new Uint8Array([1, 2, 3])], threshold: 1 } },
    ])
      expect(() => betterCompute({ ...options(db!, fakeIam()), pki } as never)).toThrow(
        /INVALID_CONFIG|approvers|commandSigning/,
      );
    // Tiers (review #6 L3): ascending sizes, thresholds that never drop as batches grow, none
    // above the base threshold. Padding a scope must never make it cheaper to approve.
    for (const tiers of [
      [
        { maxScopeSize: 10, threshold: 1 },
        { maxScopeSize: 5, threshold: 1 },
      ],
      [
        { maxScopeSize: 5, threshold: 2 },
        { maxScopeSize: 10, threshold: 1 },
      ],
      [{ maxScopeSize: 5, threshold: 3 }],
    ])
      expect(() =>
        betterCompute({
          ...options(db!, fakeIam()),
          pki: { commandSigning: authority, approvers: { keys, threshold: 2, tiers } },
        } as never),
      ).toThrow(/tiers/);
  });

  it('stays v0.1 without pki.commandSigning, and validates the options', async () => {
    const s = await server(undefined);
    const { id } = await s.enqueue('node.reboot', 'reboot-unsigned');
    expect((await s.row(id)).signature).toBeNull();
    expect(await s.compute.gatewayServices.trustBundle()).toBeUndefined();
    await db!.close();
    db = pglite();
    expect(() =>
      betterCompute({ ...options(db!, fakeIam()), pki: { trustVersion: 2 } } as never),
    ).toThrow(/need pki.commandSigning/);
    const authority = createCommandSigningAuthority();
    expect(() =>
      betterCompute({
        ...options(db!, fakeIam()),
        pki: { commandSigning: authority, trustVersion: 0 },
      } as never),
    ).toThrow(/trustVersion/);
  });
});
