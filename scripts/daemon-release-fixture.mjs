// Writes daemon/internal/pki/testdata/release.json: a bcd release manifest signed by two release keys
// with @better-compute/pki (signReleaseManifest), their pins, and the artifact bytes, so bcd's
// VerifyReleaseManifest (self-update) is checked against the TypeScript signer.
//
//   node --import ./tests/fixtures/bcx-loader.mjs scripts/daemon-release-fixture.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pki = await import('@better-compute/pki');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Issued 2026-01-01, valid for 100 years: tests pass their own "now".
const clock = { now: () => Date.UTC(2026, 0, 1) };
const keys = [pki.createReleaseSigningKey({ clock }), pki.createReleaseSigningKey({ clock })];
const other = pki.createReleaseSigningKey({ clock });
const amd64 = Buffer.from('bcd 0.4.0 linux-amd64 test binary\n');
const arm64 = Buffer.from('bcd 0.4.0 linux-arm64 test binary\n');
const manifest = pki.buildReleaseManifest({
  product: 'bcd',
  version: '0.4.0',
  sequence: 7,
  artifacts: [
    pki.releaseArtifact('bcd_0.4.0_linux_amd64', amd64, 'linux-amd64'),
    pki.releaseArtifact('bcd_0.4.0_linux_arm64', arm64, 'linux-arm64'),
    pki.releaseArtifact('bcd_0.4.0_linux_amd64.tar.gz', Buffer.from('archive'), 'linux-amd64'),
  ],
  signers: keys,
  validitySeconds: 100 * 365 * 86400,
  clock,
});
const signed = pki.signReleaseManifest(manifest, keys);
const out = {
  signed: JSON.stringify(signed),
  pins: keys.map((key) => pki.spkiPin(key.publicKey)),
  otherPin: pki.spkiPin(other.publicKey),
  issuedAt: manifest.issuedAt,
  expiresAt: manifest.expiresAt,
  binaries: { 'linux-amd64': amd64.toString('base64'), 'linux-arm64': arm64.toString('base64') },
};
const file = join(root, 'daemon/internal/pki/testdata/release.json');
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${file}`);
