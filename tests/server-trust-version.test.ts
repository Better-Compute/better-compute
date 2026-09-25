import { afterEach, describe, expect, it } from 'vitest';
import { manualClock, type SqlExecutor } from '@better-compute/core';
import { pglite } from '@better-compute/postgres/pglite';
import {
  createApproverKey,
  createCommandSigningAuthority,
  createNodeCa,
  createSigningKey,
  generateP256KeyPair,
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
    // Removing the approvers is a change too.
    expect(await published({})).toBe(11n);
  });
});
