import { afterEach, describe, expect, it } from 'vitest';
import { manualClock, type SqlExecutor } from '@better-compute/core';
import { pglite } from '@better-compute/postgres/pglite';
import {
  createCommandSigningAuthority,
  createNodeCa,
  createSigningKey,
  generateP256KeyPair,
  verifyTrustBundle,
} from '@better-compute/pki';
import { betterCompute, pkiJoinCrypto } from '@better-compute/server';
import { fakeIam } from './support/fake-iam.js';
import { options } from './support/server.js';

// Review 7 #4: a stale replica restarting with an OLD bundle must not republish it as the newest
// version. Daemons would take it and trust again, say, a command-signing root the new config removed.
// A digest published before and since replaced keeps its old version (daemons ignore it); only an
// explicit pki.trustVersion above the record publishes it again.

const T0 = Date.UTC(2026, 8, 25, 12);
let db: SqlExecutor | undefined;
afterEach(async () => {
  await db?.close();
  db = undefined;
});

describe('trust bundle version: stale replicas (review 7 #4)', () => {
  it('never bumps a bundle that was published before and replaced', async () => {
    db = pglite();
    const authority = createCommandSigningAuthority({ clock: manualClock(T0 - 60_000) });
    const signingKey = createSigningKey({ clock: manualClock(T0 - 60_000) });
    const join = pkiJoinCrypto({
      trustDomain: 'compute.test',
      nodeCa: createNodeCa({ clock: manualClock(T0 - 60_000) }),
      signingKey,
      encryptionKey: generateP256KeyPair().privateKey,
    });
    // The root a later config drops (e.g. a compromised worker root).
    const revoked = createCommandSigningAuthority({ clock: manualClock(T0 - 60_000) }).certificate;
    const warnings: string[] = [];
    const log = { debug() {}, info() {}, warn: (message: string) => warnings.push(message), error() {} };
    const published = async (pki: Record<string, unknown>) => {
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

    const old = await published({ commandSigningRoots: [revoked] });
    expect(old.version).toBe(1n);
    expect(old.commandSigningRoots).toHaveLength(2);
    // The new config removes the root: version 2.
    expect((await published({})).version).toBe(2n);
    // A replica still on the old config restarts: it keeps version 1, which daemons holding 2
    // ignore, and says so.
    expect((await published({ commandSigningRoots: [revoked] })).version).toBe(1n);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/replaced by version 2/);
    // The record is untouched: the new config still publishes 2.
    expect((await published({})).version).toBe(2n);
    // Republishing the old bundle on purpose takes a version above the record.
    expect((await published({ commandSigningRoots: [revoked], trustVersion: 3 })).version).toBe(3n);
    // Now the root-less bundle is the stale one.
    expect((await published({})).version).toBe(2n);
    expect(warnings).toHaveLength(2);
  });
});
