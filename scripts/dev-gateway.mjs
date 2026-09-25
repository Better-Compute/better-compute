#!/usr/bin/env node
// A dev control plane + gateway for running a real bcd against (the Go daemon's integration tests):
//
//   node scripts/dev-gateway.mjs [--tls] [--host <addr>] [--port <n>] [--dns gw.dev.local,localhost]
//                                [--advertise <host>] [--uses 8] [--expect-gpus 8] [--quiet]
//
// Starts `createDevStack` (PGlite, fake IAM, local CAs). Daemons join through the gateway's Join RPC
// with the printed token, then open their Session:
// - default: over the loopback cleartext HTTP/2 listener, authenticated by the `x-bc-test-node` header
//   (`admitExternalJoins`); loopback only, since the header proves nothing;
// - `--tls`: over an mTLS listener on `--host` (e.g. 0.0.0.0 for a daemon in WSL), authenticated as in
//   production by the certificate JoinService issued (chain to the node CA, revocation, role). The
//   daemon pins `servingCaCertDer` and sets its TLS server name to one of `--dns` (default
//   gw.dev.local, localhost). Join also works on this listener (no client certificate needed).
//
// Prints one JSON line on stdout, then keeps running, logging node lifecycle, command, reservation
// and security events on stderr until SIGINT/SIGTERM:
//
//   { gatewayUrl, tlsGatewayUrl?, servingCaCertDer?, servingCaPin?, tlsServerName?, joinSigningKeyPin,
//     joinEncryptionJwk, nodeCaCertDer, token, poolId, siteId, tenantId }
//
// Needs built packages (`node node_modules/typescript/bin/tsc -b packages/testing`). Local development only.

import { createPublicKey } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = (pkg) => join(root, 'packages', pkg, 'dist', 'index.js');
for (const pkg of ['testing', 'pki'])
  if (!existsSync(dist(pkg))) {
    console.error(`Missing build of packages/${pkg}. Run: node node_modules/typescript/bin/tsc -b packages/testing`);
    process.exit(1);
  }
const { createDevStack } = await import(pathToFileURL(dist('testing')).href);
const { spkiPin, parseCertificate } = await import(pathToFileURL(dist('pki')).href);

function flag(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  if (at < 0) return fallback;
  const value = process.argv[at + 1];
  if (value === undefined || value.startsWith('--')) return true;
  return value;
}
const tls = flag('tls', false) === true;
const host = String(flag('host', '127.0.0.1'));
const port = Number(flag('port', 0));
const uses = Number(flag('uses', 8));
const expectGpus = flag('expect-gpus', undefined);
const quiet = flag('quiet', false) === true;
const dnsNames = String(flag('dns', 'gw.dev.local,localhost'))
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean);
if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new Error('--port must be 0-65535');
if (!Number.isSafeInteger(uses) || uses < 1 || uses > 10_000) throw new Error('--uses must be 1-10000');
const loopback = ['127.0.0.1', '::1', 'localhost'].includes(host);
if (!tls && !loopback) {
  console.error(
    `Refusing --host ${host} without --tls: the cleartext listener authenticates by a header anyone could send. ` +
      'Use --tls (mTLS with the dev node CA) to serve beyond this machine.',
  );
  process.exit(2);
}

const dev = await createDevStack(
  tls
    ? { externalTls: { host, port, dnsNames } }
    : { gateway: { host, port }, admitExternalJoins: true },
);
const api = dev.compute.api;
const { poolId, siteId } = await dev.createPool({
  key: 'bcd',
  ...(expectGpus === undefined ? {} : { expectGpuCount: Number(expectGpus) }),
});
const minted = await api.joinTokens.create(dev.root, {
  tenantId: dev.rootTenantId,
  poolId,
  ttlSeconds: 86_400,
  maxUses: uses,
  idempotencyKey: `dev-gateway-${Date.now()}`,
});

const advertise = flag('advertise', undefined);
const advertised = (value) => {
  const url = new URL(value);
  if (typeof advertise === 'string') url.hostname = advertise;
  return url.origin;
};
console.log(
  JSON.stringify({
    gatewayUrl: advertised(dev.gatewayUrl),
    ...(tls
      ? {
          tlsGatewayUrl: advertised(dev.externalGatewayUrl),
          servingCaCertDer: Buffer.from(dev.servingCaCertificate).toString('hex'),
          servingCaPin: spkiPin(parseCertificate(dev.servingCaCertificate).publicKey),
          tlsServerName: dnsNames[0],
        }
      : {}),
    joinSigningKeyPin: spkiPin(createPublicKey({ key: dev.pins.joinSigningKey, format: 'jwk' })),
    joinEncryptionJwk: dev.pins.joinEncryptionJwk,
    nodeCaCertDer: Buffer.from(dev.pins.nodeCaCertificate).toString('hex'),
    token: minted.token,
    poolId,
    siteId,
    tenantId: dev.rootTenantId,
  }),
);

if (!quiet)
  for (const pattern of ['node.*', 'command.settled', 'reservation.*', 'security.*'])
    dev.compute.events.subscribe(pattern, (event) => {
      const data = event.data && typeof event.data === 'object' ? event.data : {};
      const detail = ['state', 'kind', 'reason', 'commandId'].flatMap((key) =>
        data[key] === undefined ? [] : [`${key}=${data[key]}`],
      );
      console.error(`${event.time} ${event.type} ${event.subject} ${detail.join(' ')}`.trim());
    });

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await dev.close().catch((error) => console.error(String(error)));
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
