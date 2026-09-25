import { afterEach, describe, expect, it } from 'vitest';
import { manualClock, type SqlExecutor } from '@better-compute/core';
import { pglite } from '@better-compute/postgres/pglite';
import {
  approverSetOf,
  createApproverKey,
  createCommandSigningAuthority,
  createNodeCa,
  createSigningKey,
  generateP256KeyPair,
  signApproverSet,
  verifyApproverSetChange,
  verifyTrustBundle,
} from '@better-compute/pki';
import { betterCompute, pkiJoinCrypto } from '@better-compute/server';
import { fakeIam } from './support/fake-iam.js';
import { options } from './support/server.js';

// The trust bundle's version follows its content (quorum review #6 M5): daemons take only a newer
// version, so a bundle that changed (roots, approvers, tiers) under its old version would reach no
// daemon. The deployment records the digest it published; a changed bundle gets the next version,
// an unchanged one keeps its version, and pki.trustVersion is a floor.

const T0 = Date.UTC(2026, 8, 25, 12);
let db: SqlExecutor | undefined;
afterEach(async () => {
  await db?.close();
  db = undefined;
});

describe('trust bundle version (review #6 M5)', () => {
  it('bumps the version when the published content changes, and only then', async () => {
    db = pglite();
    const authority = createCommandSigningAuthority({ clock: manualClock(T0 - 60_000) });
    const signingKey = createSigningKey({ clock: manualClock(T0 - 60_000) });
    const join = pkiJoinCrypto({
      trustDomain: 'compute.test',
      nodeCa: createNodeCa({ clock: manualClock(T0 - 60_000) }),
      signingKey,
      encryptionKey: generateP256KeyPair().privateKey,
    });
    const keys = [createApproverKey(), createApproverKey()].map((approver) => approver.key.spkiDer);
    /** One process with this config on the shared database: the version it publishes. */
    const published = async (pki: Record<string, unknown>, initialize = true) => {
      const compute = betterCompute({
        ...options(db!, fakeIam()),
        clock: manualClock(T0),
        pki: { join, commandSigning: authority, ...pki },
      } as never) as any;
      if (initialize) await compute.initialize();
      const bundle = verifyTrustBundle(await compute.gatewayServices.trustBundle(), {
        publicKey: signingKey.publicKey,
      });
      return bundle.version;
    };

    expect(await published({})).toBe(1n);
    // Restarted with the same bundle: the same version.
    expect(await published({})).toBe(1n);
    // Approvers added without touching trustVersion: the next version, which daemons take.
    expect(await published({ approvers: { keys, threshold: 2 } })).toBe(2n);
    expect(await published({ approvers: { keys, threshold: 2 } })).toBe(2n);
    // A gateway-only process (never initialize()d) settles before serving, and agrees.
    expect(await published({ approvers: { keys, threshold: 1 } }, false)).toBe(3n);
    expect(await published({ approvers: { keys, threshold: 1 } }, false)).toBe(3n);
    // pki.trustVersion is a floor: above the record it wins; below it, the record stands.
    expect(await published({ approvers: { keys, threshold: 1 }, trustVersion: 10 })).toBe(10n);
    expect(await published({ approvers: { keys, threshold: 1 }, trustVersion: 2 })).toBe(10n);
    // Removing the approvers brings back the bundle published as version 1: a stale config refuses
    // to start (review 7 #4, review 8 #4); only an explicit trustVersion publishes it again.
    await expect(published({})).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    expect(await published({ trustVersion: 11 })).toBe(11n);
  });

  it('publishes approver-set signatures only for their version, and refuses a mismatched signed change', async () => {
    db = pglite();
    const authority = createCommandSigningAuthority({ clock: manualClock(T0 - 60_000) });
    const signingKey = createSigningKey({ clock: manualClock(T0 - 60_000) });
    const join = pkiJoinCrypto({
      trustDomain: 'compute.test',
      nodeCa: createNodeCa({ clock: manualClock(T0 - 60_000) }),
      signingKey,
      encryptionKey: generateP256KeyPair().privateKey,
    });
    const approvers = [createApproverKey(), createApproverKey(), createApproverKey()];
    const warnings: string[] = [];
    const log = { debug() {}, info() {}, warn: (message: string) => warnings.push(message), error() {} };
    const boot = async (pki: Record<string, unknown>) => {
      const compute = betterCompute({
        ...options(db!, fakeIam()),
        clock: manualClock(T0),
        log,
        pki: { join, commandSigning: authority, ...pki },
      } as never) as any;
      await compute.initialize();
      return verifyTrustBundle(await compute.gatewayServices.trustBundle(), {
        publicKey: signingKey.publicKey,
      });
    };
    const two = approvers.slice(0, 2).map((approver) => approver.key);
    const first = { keys: two.map((key) => key.spkiDer), threshold: 2 };
    const firstSet = { approverKeys: two, approverThreshold: 2, quorumTiers: [], unbatchedDestructivePerHour: 0 };
    expect((await boot({ approvers: first })).version).toBe(1n);

    // Adding a third approver, signed by both current ones for epoch 2 (the first set is epoch 1).
    const all = approvers.map((approver) => approver.key);
    const nextSet = { approverKeys: all, approverThreshold: 2, quorumTiers: [], unbatchedDestructivePerHour: 0 };
    const setSignatures = approvers.slice(0, 2).map((approver) => {
      const signature = signApproverSet({ epoch: 2n, set: nextSet, trustDomain: 'compute.test' }, approver.privateKey);
      return { kid: signature.kid, sig: Buffer.from(signature.sig).toString('base64url') };
    });
    const next = { keys: all.map((key) => key.spkiDer), threshold: 2, setSignatures, epoch: 2 };
    const bundle = await boot({ approvers: next });
    expect(bundle.version).toBe(2n);
    expect(bundle.approverSetEpoch).toBe(2n);
    expect(bundle.approverSetSignatures).toHaveLength(2);
    // What a daemon holding the first set checks.
    expect(
      verifyApproverSetChange({ ...firstSet, epoch: 1n }, {
        ...approverSetOf(bundle),
        epoch: bundle.approverSetEpoch,
        approverSetSignatures: bundle.approverSetSignatures,
        trustDomain: 'compute.test',
      }),
    ).toHaveLength(2);
    expect(warnings).toEqual([]);

    // A root rotation with the quorum unchanged: the next version, still with the set's signatures, so a daemon
    // that missed version 2 takes the set from version 3.
    const rotated = await boot({
      approvers: next,
      commandSigningRoots: [createCommandSigningAuthority({ clock: manualClock(T0 - 60_000) }).certificate],
    });
    expect(rotated.version).toBe(3n);
    expect(rotated.approverSetEpoch).toBe(2n);
    expect(rotated.approverSetSignatures).toHaveLength(2);
    expect(
      verifyApproverSetChange({ ...firstSet, epoch: 1n }, {
        ...approverSetOf(rotated),
        epoch: rotated.approverSetEpoch,
        approverSetSignatures: rotated.approverSetSignatures,
        trustDomain: 'compute.test',
      }),
    ).toHaveLength(2);
    expect(warnings).toEqual([]);

    // The same signatures for another quorum: published, with a warning naming the epoch to sign.
    expect((await boot({ approvers: { ...next, threshold: 3 } })).version).toBe(4n);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/sign-approvers --epoch 3/);
    // setSignatures without the epoch they were signed for: refused at configuration.
    const { epoch: _epoch, ...unepoched } = next;
    expect(() =>
      betterCompute({
        ...options(db!, fakeIam()),
        pki: { join, commandSigning: authority, approvers: unepoched },
      } as never),
    ).toThrow(/pki.approvers.epoch/);
  });
});
