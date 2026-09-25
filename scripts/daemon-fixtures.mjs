// Writes fixtures for the Go daemon's interop tests (daemon/internal/pki/testdata/interop.json):
// a node CA, a node certificate with the role extension and SPIFFE SAN, a JoinService signing key
// and a signed JoinResponse for a CSR, a sealed join token the Go side must open... all produced
// by @better-compute/pki, so the Go code is checked against the TypeScript implementation.
//
//   node --import ./tests/fixtures/bcx-loader.mjs scripts/daemon-fixtures.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { createPrivateKey } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pki = await import('@better-compute/pki');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const hex = (bytes) => Buffer.from(bytes).toString('hex');

const now = Date.UTC(2026, 8, 24, 12);
const clock = { now: () => now };
const nodeCa = pki.createNodeCa({ clock });
const nodeKey = pki.generateP256KeyPair().privateKey;
const csr = pki.createCsr(nodeKey);
const nodeId = 'node_01k5w000000000000000000go1';
const issued = await nodeCa.sign(csr, {
  usage: 'client',
  role: 'node',
  ttlSeconds: 86_400,
  uriSans: [pki.nodeSpiffeId({ trustDomain: 'compute.test', siteId: 'site_go', nodeId })],
});
const signing = pki.createSigningKey({ clock });
const response = pki.signJoinResponse(
  {
    nodeId,
    certChain: [issued.certificate],
    csr,
    trustDomain: 'compute.test',
    siteId: 'site_go',
    role: 'node',
    issuedAt: now,
  },
  signing,
);
const { toBinary } = await import('@bufbuild/protobuf');
const { JoinResponseSchema } = await import('@better-compute/protocol');

// A JWE sealed by TS to a key whose private half Go gets, to check Go's OpenJWE.
const recipient = pki.generateP256KeyPair();
const jwe = pki.sealJwe('hello from ts', recipient.publicKey, { typ: 'bctest+jwe', rid: 'r1' });

const out = {
  now,
  nodeId,
  nodeKeyPkcs8: hex(nodeKey.export({ type: 'pkcs8', format: 'der' })),
  csr: hex(csr),
  nodeCert: hex(issued.certificate),
  nodeCaCert: hex(nodeCa.certificate),
  signingPin: pki.spkiPin(signing.publicKey),
  joinResponse: hex(toBinary(JoinResponseSchema, response)),
  jwe,
  jweRecipientPkcs8: hex(recipient.privateKey.export({ type: 'pkcs8', format: 'der' })),
};
const file = join(root, 'daemon/internal/pki/testdata/interop.json');
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${file}`);
void createPrivateKey;
