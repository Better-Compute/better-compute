// Writes daemon/internal/pki/testdata/quorum.json: an approver set's canonical bytes and signing
// input as @better-compute/protocol builds them (approverSetInput, approverSetSigningInput), so bcd's
// ApproverSetInput is checked byte for byte against the TypeScript side. (signing.json pins the
// signing framing; this pins the set's canonical form, which has no golden of its own.)
//
//   node --import ./tests/fixtures/bcx-loader.mjs scripts/daemon-quorum-fixture.mjs
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const protocol = await import('@better-compute/protocol');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const hex = (bytes) => Buffer.from(bytes).toString('hex');

// Two keys named out of kid order, so the canonical sort matters.
const spki = [Buffer.alloc(91, 7), Buffer.alloc(91, 3)];
const keys = spki.map((der) => ({ kid: createHash('sha256').update(der).digest('base64url'), spkiDer: der }));
const set = {
  approverKeys: keys,
  approverThreshold: 2,
  quorumTiers: [
    { maxScopeSize: 10, threshold: 1 },
    { maxScopeSize: 1000, threshold: 2 },
  ],
  unbatchedDestructivePerHour: 3,
};
const input = protocol.approverSetInput(set);
const version = 9n;
const out = {
  version: String(version),
  keys: keys.map((key) => ({ kid: key.kid, spkiDer: hex(key.spkiDer) })),
  approverThreshold: set.approverThreshold,
  quorumTiers: set.quorumTiers,
  unbatchedDestructivePerHour: set.unbatchedDestructivePerHour,
  approverSetInput: hex(input),
  signingInput: hex(protocol.approverSetSigningInput({ version, setSha256: createHash('sha256').update(input).digest() })),
};
const file = join(root, 'daemon/internal/pki/testdata/quorum.json');
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${file}`);
