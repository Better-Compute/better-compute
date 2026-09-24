import { create, toBinary } from '@bufbuild/protobuf';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serveGatewayWs, type ServedGatewayWs } from '@better-compute/gateway';
import { createCsr, createNodeCa, createServingCa, generateP256KeyPair, nodeSpiffeId } from '@better-compute/pki';
import { SignatureSchema } from '@better-compute/protocol';
import { createRealtimeScheduler, createWsDialer, FakeDaemon } from '@better-compute/testing';
import { gatewayFixture, SITE, type GatewayFixture } from './support/gateway.js';

// The testing kit's FakeDaemon over the WS fallback (PLAN.md §7.1, v0.4): in-band proofs both ways,
// signed commands only, and redial after the gateway drops the session.

let f: GatewayFixture;
let served: ServedGatewayWs;
const daemons: FakeDaemon[] = [];

beforeEach(async () => {
  f = await gatewayFixture();
});
afterEach(async () => {
  for (const daemon of daemons.splice(0)) daemon.crash('test over');
  await served?.close();
  await f.close();
});

async function setup() {
  const nodeCa = createNodeCa({ clock: f.clock });
  const servingCa = createServingCa({ clock: f.clock });
  const gatewayKey = generateP256KeyPair();
  const serving = await servingCa.issue(gatewayKey.publicKey, { usage: 'server', dnsSans: ['gw.ws.test'], ttlSeconds: 86_400 });
  served = await serveGatewayWs(f.gateway, {
    insecure: true,
    roots: [nodeCa.certificate],
    audiences: ['gw.ws.test'],
    serving: { key: gatewayKey.privateKey, chain: [serving.certificate, ...serving.chain] },
    clock: f.clock,
  });
  const dial = createWsDialer({
    url: `ws://127.0.0.1:${served.port}`,
    audience: 'gw.ws.test',
    servingRoots: [servingCa.certificate],
    clock: f.clock,
    async credentials(nodeId) {
      const key = generateP256KeyPair();
      const issued = await nodeCa.sign(createCsr(key.privateKey), {
        usage: 'client',
        role: 'node',
        ttlSeconds: 3_600,
        uriSans: [nodeSpiffeId({ trustDomain: 'compute.test', siteId: SITE, nodeId })],
      });
      return { key: key.privateKey, chain: [issued.certificate, ...issued.chain] };
    },
  });
  return { dial };
}

describe('FakeDaemon over WS', () => {
  it('joins in-band, runs signed commands only, redials after a reset and stays down once revoked', async () => {
    const { dial } = await setup();
    const node = await f.addNode();
    const daemon = new FakeDaemon({
      nodeId: node,
      scheduler: createRealtimeScheduler({ onError: () => {} }),
      backoff: { minMs: 20, maxMs: 200 },
      dial: () => dial(node),
    });
    daemons.push(daemon);
    daemon.start();
    await expect.poll(() => daemon.welcomed, { timeout: 5_000 }).toBe(true);
    expect(f.gateway.sessions()).toMatchObject([{ nodeId: node, epoch: 1 }]);

    const unsigned = await f.enqueue(node);
    const signed = await f.enqueue(node);
    await f.db.query('UPDATE commands SET signature = $2 WHERE id = $1', [
      signed,
      Buffer.from(toBinary(SignatureSchema, create(SignatureSchema, { kid: 'k1', sig: new Uint8Array([1, 2, 3]) }))),
    ]);
    await f.gateway.jobs.dispatch.tick();
    await expect.poll(async () => (await f.command(signed)).state, { timeout: 10_000 }).not.toBe('dispatched');
    expect(daemon.executions.get(unsigned)).toBeUndefined();
    expect((await f.command(unsigned)).state).toBe('pending');

    // A network reset: the daemon redials with a fresh proof (new nonce and jti) and a new epoch.
    daemon.disconnect('network reset');
    await expect.poll(() => f.gateway.sessions()[0]?.epoch, { timeout: 5_000 }).toBe(2);

    // A revocation pushed over WS: the daemon stops using the certificate and does not redial.
    await f.gateway.revoke(node, { reason: 'key compromise' });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(f.gateway.sessions()).toEqual([]);
  }, 30_000);
});
