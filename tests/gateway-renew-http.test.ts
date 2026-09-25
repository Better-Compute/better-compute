import { createPublicKey } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { create } from '@bufbuild/protobuf';
import { afterEach, describe, expect, it } from 'vitest';
import { gatewayRenewHandler, type RenewHttpOptions } from '@better-compute/gateway';
import { createNodeCa, generateP256KeyPair, nodeSpiffeId, prepareAgentRenew } from '@better-compute/pki';
import { AgentRole, decodeMessage, encodeMessage, RenewRequestSchema, RenewResponseSchema } from '@better-compute/protocol';
import { createDevStack, createH2cClient, fakeHardware, runAgentJoin, type DevStack } from '@better-compute/testing';

// `POST /v1/renew` on the WS listener (PLAN.md §7.1): certificate renewal for WS-mode daemons whose
// proxy strips client certificates. No TLS identity at all: JoinService verifies the presented chain,
// the proof of possession by the current key (±60 s, replay cache) and revocation.

let dev: DevStack | undefined;
let server: Server | undefined;
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  await dev?.close();
  dev = undefined;
});

/** A node that joined through JoinService: its chain and key, as bcd holds them. */
async function joined(stack: DevStack) {
  const { poolId } = await stack.createPool({ key: 'renew' });
  const api = stack.compute.api as any;
  const { token } = await api.joinTokens.create(stack.root, {
    tenantId: stack.rootTenantId,
    poolId,
    ttlSeconds: 600,
    maxUses: 1,
    idempotencyKey: `renew-${Math.random()}`,
  });
  const client = createH2cClient({ url: stack.gatewayUrl });
  cleanups.push(() => client.close());
  const { body, privateKey } = await runAgentJoin({
    send: (request) => client.join(request),
    role: AgentRole.NODE,
    signer: { publicKey: createPublicKey({ key: stack.pins.joinSigningKey, format: 'jwk' }) },
    nodeCaRoots: [stack.pins.nodeCaCertificate],
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    claims: fakeHardware({ seed: `renew-${Math.random()}`, variant: 'hgx-h100' }).claims,
    daemonVersion: '0.1.0-bcd',
    token: { token, joinEncryptionKey: createPublicKey({ key: stack.pins.joinEncryptionJwk, format: 'jwk' }) },
  });
  return { nodeId: body.nodeId, chain: body.certChain, privateKey };
}

async function serve(stack: DevStack, options: RenewHttpOptions = {}) {
  const handler = gatewayRenewHandler(stack.gateway, options);
  server = createServer((req, res) => {
    if (!handler(req, res)) res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1/renew`;
  return (body: Uint8Array) =>
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-protobuf' }, body });
}

const encoded = (request: ReturnType<typeof prepareAgentRenew>['request']) =>
  encodeMessage(RenewRequestSchema, create(RenewRequestSchema, request));

describe('POST /v1/renew (renewal without a TLS client certificate)', () => {
  it('renews with a valid proof, and refuses a replay, a foreign chain and a revoked certificate', { timeout: 60_000 }, async () => {
    dev = await createDevStack({ admitExternalJoins: true });
    const node = await joined(dev);
    const post = await serve(dev);

    const prepared = prepareAgentRenew({ nodeId: node.nodeId, currentKey: node.privateKey, chain: node.chain, now: Date.now() });
    const ok = await post(encoded(prepared.request));
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('application/x-protobuf');
    const renewed = decodeMessage(RenewResponseSchema, new Uint8Array(await ok.arrayBuffer()));
    expect(renewed.certChain.length).toBeGreaterThan(0);

    // The same proof again is a replay.
    const replay = await post(encoded(prepared.request));
    expect([401, 403]).toContain(replay.status);

    // A chain from another CA naming the same node proves nothing.
    const foreignCa = createNodeCa({ trustDomain: 'evil.example' });
    const foreignKey = generateP256KeyPair();
    const foreign = await foreignCa.issue(foreignKey.publicKey, {
      usage: 'client',
      role: 'node',
      uriSans: [nodeSpiffeId({ trustDomain: 'evil.example', siteId: 'site_x', nodeId: node.nodeId })],
      ttlSeconds: 3600,
    });
    const forged = prepareAgentRenew({
      nodeId: node.nodeId,
      currentKey: foreignKey.privateKey,
      chain: [foreign.certificate, ...foreign.chain],
      now: Date.now(),
    });
    expect([401, 403]).toContain((await post(encoded(forged.request))).status);

    // After the node's identity is revoked, its certificate renews no more.
    await (dev.compute.api as any).nodes.revokeIdentity(dev.root, {
      tenantId: dev.rootTenantId,
      nodeId: node.nodeId,
      reason: 'key-compromise',
    });
    const again = prepareAgentRenew({
      nodeId: node.nodeId,
      currentKey: prepared.privateKey,
      chain: renewed.certChain,
      now: Date.now(),
    });
    expect([401, 403]).toContain((await post(encoded(again.request))).status);
  });

  it('limits renewals per node, caps the body and takes only POSTs of RenewRequest bytes', { timeout: 60_000 }, async () => {
    dev = await createDevStack({ admitExternalJoins: true });
    const node = await joined(dev);
    const post = await serve(dev, { perNodePerHour: 1, maxBytes: 4096 });
    const request = () =>
      encoded(prepareAgentRenew({ nodeId: node.nodeId, currentKey: node.privateKey, chain: node.chain, now: Date.now() }).request);
    expect((await post(request())).status).toBe(200);
    const limited = await post(request());
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);

    expect((await post(new Uint8Array(8192))).status).toBe(429);
    expect((await post(new Uint8Array([0xff, 0xff, 0xff]))).status).toBe(400);
    const url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1/renew`;
    expect((await fetch(url)).status).toBe(405);
  });
});
