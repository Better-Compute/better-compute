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

// Signed intent: a command-signing root, a worker key it certifies, a command and a desired state
// signed by it, a signature by a non-worker certificate under the node CA, and a SignedTrustBundle
// carrying the root, signed by the JoinService key.
const { create } = await import('@bufbuild/protobuf');
const { CommandSchema, CommandBodySchema, DesiredStateSchema, DesiredStateBodySchema, SignedTrustBundleSchema, Lane } = await import(
  '@better-compute/protocol'
);
const authority = pki.createCommandSigningAuthority({ clock });
const worker = authority.issueWorkerKey({ workerId: 'go-interop' });
const command = pki.signCommand(
  create(CommandBodySchema, {
    id: 'cmd_go_1',
    nodeId,
    seq: 1n,
    kind: 'diag.nvml',
    lane: Lane.CONTROL,
    retrySafe: true,
  }),
  worker,
);
const desired = pki.signDesiredState(
  create(DesiredStateBodySchema, { nodeId, generation: 3n, baseGeneration: 0n, specHash: new Uint8Array(32), spec: { case: 'full', value: {} } }),
  worker,
);
const nodeSigner = pki.createSigningKey({ privateKey: nodeKey, certificate: issued.certificate });
const byNode = pki.signCommand(create(CommandBodySchema, { id: 'cmd_go_2', nodeId, kind: 'diag.nvml' }), nodeSigner);
const trust = pki.signTrustBundle({ version: 7n, commandSigningRoots: [authority.certificate] }, signing);

// An exec ticket issued by TS for this node (tunnel ts_tunnel_1), with its JWKS.
const tickets = pki.createExecTicketIssuer({ issuer: 'https://compute.test', clock });
const ticket = tickets.issue({ nodeId, sid: 'ts_tunnel_1', op: 'console', subject: 'user_1' });

// A SecretRequest and a WorkloadTokenRequest made by TS with the node key, each answered with a JWE
// to its one-time key: Go checks it builds the same signing inputs and opens the answers.
const { createPublicKey: pub } = await import('node:crypto');
const { SecretRequestSchema, SecretResponseSchema, WorkloadTokenRequestSchema, WorkloadTokenResponseSchema } = await import('@better-compute/protocol');
const secret = pki.createSecretRequest({ nodeKey, ref: 'secret://tenant/user-data', allocationId: 'alloc_go' });
const secretResponse = pki.sealSecretResponse(
  { ...secret.request, recipient: pub(secret.ephemeralKey) },
  'hello secret',
  { expiresAt: now + 60_000 },
);
const workload = pki.createWorkloadTokenRequest({ nodeKey, instanceId: 'inst_go', audience: 'sts.example' });
const workloadResponse = pki.sealWorkloadTokenResponse(
  { ...workload.request, recipient: pub(workload.ephemeralKey) },
  'eyJ.workload.jwt',
  now + 300_000,
);

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
  commandSigningRoot: hex(authority.certificate),
  signedCommand: hex(toBinary(CommandSchema, command)),
  signedDesiredState: hex(toBinary(DesiredStateSchema, desired)),
  nodeSignedCommand: hex(toBinary(CommandSchema, byNode)),
  signedTrustBundle: hex(toBinary(SignedTrustBundleSchema, trust)),
  execTicket: ticket.token,
  execTicketJti: ticket.jti,
  execTicketJwks: tickets.jwksJson(),
  secretRequest: hex(toBinary(SecretRequestSchema, secret.request)),
  secretEphemeralPkcs8: hex(secret.ephemeralKey.export({ type: 'pkcs8', format: 'der' })),
  secretResponse: hex(toBinary(SecretResponseSchema, secretResponse)),
  workloadRequest: hex(toBinary(WorkloadTokenRequestSchema, workload.request)),
  workloadEphemeralPkcs8: hex(workload.ephemeralKey.export({ type: 'pkcs8', format: 'der' })),
  workloadResponse: hex(toBinary(WorkloadTokenResponseSchema, workloadResponse)),
};
const file = join(root, 'daemon/internal/pki/testdata/interop.json');
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${file}`);
void createPrivateKey;
