import { describe, expect, it } from 'vitest';
import { manualClock } from '@better-compute/core';
import { signingInput } from '@better-compute/protocol';
import {
  buildReleaseManifest,
  canonicalJson,
  createReleaseSigningKey,
  platformFromName,
  releaseArtifact,
  signReleaseManifest,
  spkiPin,
  verifyPurpose,
  verifyReleaseArtifact,
  verifyReleaseManifest,
  type ReleaseManifest,
  type SignedReleaseManifest,
} from '@better-compute/pki';

// Offline release manifests (PLAN.md §13): TUF-lite, threshold of pinned keys, rollback and expiry.

const T0 = Date.UTC(2026, 8, 24, 12);
const clock = manualClock(T0);
const amd64 = new TextEncoder().encode('bcd amd64 tarball');
const arm64 = new TextEncoder().encode('bcd arm64 tarball');
const alice = createReleaseSigningKey({ clock });
const bob = createReleaseSigningKey({ clock });
const mallory = createReleaseSigningKey({ clock });
const pins = [spkiPin(alice.publicKey), spkiPin(bob.publicKey)];

const manifestFor = (sequence = 7, signers = [alice, bob]) =>
  buildReleaseManifest({
    product: 'bcd',
    version: '1.4.0',
    sequence,
    signers,
    clock,
    validitySeconds: 30 * 86400,
    artifacts: [
      releaseArtifact('bcd_1.4.0_linux_arm64.tar.gz', arm64, 'linux-arm64'),
      releaseArtifact('bcd_1.4.0_linux_amd64.tar.gz', amd64, 'linux-amd64'),
    ],
  });

const reason = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return (error as { details?: { reason?: string } }).details?.reason ?? String(error);
  }
  return 'accepted';
};

describe('release manifests', () => {
  it('has the spec 1 shape: keys with SPKI, sorted artifacts with platforms, {kid, sig} signatures', () => {
    const manifest = manifestFor();
    expect(manifest).toMatchObject({ type: 'bettercompute.release', spec: 1, sequence: 7 });
    expect(manifest.keys.map((key) => key.kid)).toEqual([alice.kid, bob.kid]);
    expect(manifest.keys[0]!.alg).toBe('ES256');
    expect(manifest.artifacts.map((artifact) => artifact.platform)).toEqual([
      'linux-amd64',
      'linux-arm64',
    ]);
    const signed = signReleaseManifest(manifest, [alice]);
    expect(signed.signatures).toEqual([{ kid: alice.kid, sig: expect.any(String) }]);
    // The Go side verifies the same framing: ES256 over signingInput('release-manifest', [body]).
    const bytes = new Uint8Array(Buffer.from(signed.manifest, 'base64'));
    expect(Buffer.from(bytes).toString('utf8')).toBe(canonicalJson(manifest));
    expect(signingInput('release-manifest', [bytes]).length).toBeGreaterThan(bytes.length);
    expect(
      verifyPurpose(
        alice.publicKey,
        'release-manifest',
        [bytes],
        new Uint8Array(Buffer.from(signed.signatures[0]!.sig, 'base64url')),
      ),
    ).toBe(true);
  });

  it('verifies with a threshold of distinct pinned keys; cosigning adds a signature', () => {
    const one = signReleaseManifest(manifestFor(), [alice]);
    expect(verifyReleaseManifest(one, { pins }, { clock }).version).toBe('1.4.0');
    expect(reason(() => verifyReleaseManifest(one, { pins, threshold: 2 }, { clock }))).toBe(
      'threshold',
    );
    const both = signReleaseManifest(one, [bob]);
    expect(both.signatures).toHaveLength(2);
    expect(both.manifest).toBe(one.manifest);
    expect(verifyReleaseManifest(both, { pins, threshold: 2 }, { clock }).sequence).toBe(7);
    // The same key twice does not count twice.
    const doubled = { ...one, signatures: [one.signatures[0]!, one.signatures[0]!] };
    expect(reason(() => verifyReleaseManifest(doubled, { pins, threshold: 2 }, { clock }))).toBe(
      'threshold',
    );
  });

  it('refuses unpinned keys, keys not in the manifest, and tampering', () => {
    // Mallory lists herself as a key and signs: not pinned.
    const forged = signReleaseManifest(manifestFor(7, [mallory]), [mallory]);
    expect(reason(() => verifyReleaseManifest(forged, { pins }, { clock }))).toBe('threshold');
    expect(() => signReleaseManifest(manifestFor(7, [alice]), [bob])).toThrow(/not one of/);

    const signed = signReleaseManifest(manifestFor(), [alice]);
    const body = JSON.parse(
      Buffer.from(signed.manifest, 'base64').toString('utf8'),
    ) as ReleaseManifest;
    body.artifacts[0]!.sha256 = 'f'.repeat(64);
    const tampered: SignedReleaseManifest = {
      ...signed,
      manifest: Buffer.from(canonicalJson(body)).toString('base64'),
    };
    expect(reason(() => verifyReleaseManifest(tampered, { pins }, { clock }))).toBe('threshold');
    // Swapping a pinned key's SPKI into the body breaks the signature too.
    body.keys = [{ ...body.keys[0]!, spki: body.keys[1]!.spki }];
    expect(
      reason(() =>
        verifyReleaseManifest(
          { ...signed, manifest: Buffer.from(canonicalJson(body)).toString('base64') },
          { pins },
          { clock },
        ),
      ),
    ).toBe('threshold');
    expect(reason(() => verifyReleaseManifest({ manifest: '!!', signatures: [] }, { pins }))).toBe(
      'malformed',
    );
  });

  it('refuses rollbacks, other products and expired manifests, in that order', () => {
    const signed = signReleaseManifest(manifestFor(7), [alice]);
    expect(reason(() => verifyReleaseManifest(signed, { pins }, { clock, minSequence: 7 }))).toBe(
      'accepted',
    );
    expect(reason(() => verifyReleaseManifest(signed, { pins }, { clock, minSequence: 8 }))).toBe(
      'rollback',
    );
    expect(reason(() => verifyReleaseManifest(signed, { pins }, { clock, product: 'api' }))).toBe(
      'product',
    );
    const later = manualClock(T0 + 31 * 86400 * 1000);
    expect(reason(() => verifyReleaseManifest(signed, { pins }, { clock: later }))).toBe('expired');
    expect(
      reason(() => verifyReleaseManifest(signed, { pins }, { clock: later, minSequence: 9 })),
    ).toBe('rollback');
  });

  it('checks downloaded artifacts by size and digest', () => {
    const manifest = verifyReleaseManifest(
      signReleaseManifest(manifestFor(), [alice]),
      { pins },
      { clock },
    );
    expect(verifyReleaseArtifact(manifest, 'bcd_1.4.0_linux_amd64.tar.gz', amd64).platform).toBe(
      'linux-amd64',
    );
    expect(
      reason(() =>
        verifyReleaseArtifact(manifest, 'bcd_1.4.0_linux_amd64.tar.gz', amd64.subarray(1)),
      ),
    ).toBe('size');
    const same = new Uint8Array(amd64);
    same[0] ^= 1;
    expect(
      reason(() => verifyReleaseArtifact(manifest, 'bcd_1.4.0_linux_amd64.tar.gz', same)),
    ).toBe('digest');
    expect(reason(() => verifyReleaseArtifact(manifest, 'other.tar.gz', amd64))).toBe('unlisted');
  });

  it('validates inputs and derives goreleaser platforms', () => {
    expect(() => releaseArtifact('../etc/passwd', amd64)).toThrow(/plain file name/);
    expect(() =>
      buildReleaseManifest({
        product: 'bcd',
        version: 'latest',
        sequence: 1,
        signers: [alice],
        artifacts: [releaseArtifact('a', amd64)],
      }),
    ).toThrow(/semver/);
    expect(platformFromName('bcd_1.4.0_linux_amd64.tar.gz')).toBe('linux-amd64');
    expect(platformFromName('bcd_1.4.0_linux_arm64.tar.gz.sha256')).toBe('linux-arm64');
    expect(platformFromName('checksums.txt')).toBeUndefined();
  });
});
