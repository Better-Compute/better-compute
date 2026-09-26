// Writes the tpm attestor's wire contract between bcd and packages/pki (daemon/internal/tpm/testdata/):
// the challenge packages/pki's tpmAttestor makes for bcd's round-1 evidence. With it, bcd's
// TestTSContract answers the challenge through its TPM client (TS -> Go) and writes answer.json, which
// tests/pki-attestors-tpm-bcd.test.ts verifies with tpmAttestor (Go -> TS). A change on either side
// that breaks the other fails a test instead of a machine's join.
//
// To regenerate (after a deliberate change of either side), delete testdata/{evidence,challenge,answer}.json
// (keep sim.json, ek-cert.der and ek-root.der: the same TPM and its manufacturer certificate), then:
//   node scripts/daemon-test.mjs ./internal/tpm/ --run TestTSContract       writes evidence.json, skips
//   node --import ./tests/fixtures/bcx-loader.mjs scripts/daemon-tpm-fixture.mjs    writes challenge.json
//   node scripts/daemon-test.mjs ./internal/tpm/ --run TestTSContract       writes answer.json
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './tooling.mjs';

const { tpmAttestor } = await import('@better-compute/pki');
const { isAttestationDeferral, manualClock } = await import('@better-compute/core');

const dir = join(root, 'daemon/internal/tpm/testdata');
const evidence = new Uint8Array(readFileSync(join(dir, 'evidence.json')));
// Fixture values only: the key that seals the challenge state, the verifier's clock, the CSR's digest.
const challengeKey = new Uint8Array(32).fill(7);
const now = Date.UTC(2026, 8, 26, 12);
const csrSha256 = new Uint8Array(createHash('sha256').update('bcd tpm contract csr').digest());

// The EK's certificate chains to the fixture's manufacturer root (ek-root.der), as a real TPM's does.
const ekRoot = new Uint8Array(readFileSync(join(dir, 'ek-root.der')));
const verdict = await tpmAttestor({ challengeKey, ekRoots: [ekRoot] }).verify(
  { attestor: 'tpm', payload: evidence },
  {
    tx: { query: async () => ({ rows: [], rowCount: 0 }) },
    clock: manualClock(now),
    claims: {},
    role: 'node',
    csrSha256,
  },
);
if (!isAttestationDeferral(verdict) || verdict.deferred !== 'challenge')
  throw new Error(`tpmAttestor did not challenge bcd's evidence: ${JSON.stringify(verdict)}`);
const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
const out = {
  challengeKey: b64(challengeKey),
  now,
  csrSha256: b64(csrSha256),
  payload: b64(verdict.challenge),
};
writeFileSync(join(dir, 'challenge.json'), `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${join(dir, 'challenge.json')}`);
