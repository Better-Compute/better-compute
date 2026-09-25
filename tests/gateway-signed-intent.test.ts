import { create, toBinary } from '@bufbuild/protobuf';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serveGatewayWs, type ServedGatewayWs } from '@better-compute/gateway';
import {
  createCommandSigningAuthority,
  createCsr,
  createNodeCa,
  createServingCa,
  generateP256KeyPair,
  nodeSpiffeId,
} from '@better-compute/pki';
import { SignatureSchema } from '@better-compute/protocol';
import { createRealtimeScheduler, createWsDialer, FakeDaemon } from '@better-compute/testing';
// Until server exports it (runtime/command-signing.ts).
import { createCommandSigner } from '../packages/server/src/runtime/command-signing.js';
import { gatewayFixture, SITE, type GatewayFixture } from './support/gateway.js';

// Signed intent through a real gateway (PLAN.md §13, v0.2 exit: "unsigned destructive commands are
// rejected"): the gateway relays `commands.signature` verbatim; a signature it forged or swapped
// is refused by the daemon (BAD_SIGNATURE), a worker-signed destructive command runs.

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

async function connect() {
  const nodeCa = createNodeCa({ clock: f.clock });
  const servingCa = createServingCa({ clock: f.clock });
  const gatewayKey = generateP256KeyPair();
  const serving = await servingCa.issue(gatewayKey.publicKey, {
    usage: 'server',
    dnsSans: ['gw.ws.test'],
    ttlSeconds: 86_400,
  });
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
  return dial;
}

describe('signed intent through a real gateway', () => {
  it('the daemon refuses a gateway-forged signature on a destructive command and runs a worker-signed one', async () => {
    const authority = createCommandSigningAuthority({ clock: f.clock });
    const signer = createCommandSigner({ authority, workerId: 'worker-e2e', clock: f.clock });
    const dial = await connect();
    const node = await f.addNode();
    const daemon = new FakeDaemon({
      nodeId: node,
      scheduler: createRealtimeScheduler({ onError: () => {} }),
      backoff: { minMs: 20, maxMs: 200 },
      dial: () => dial(node),
      intent: { roots: [authority.certificate], version: 1n },
    });
    daemons.push(daemon);
    daemon.start();
    await expect.poll(() => daemon.welcomed, { timeout: 5_000 }).toBe(true);

    const sign = async (id: string, signature: Uint8Array) =>
      f.db.query('UPDATE commands SET signature = $2 WHERE id = $1', [id, Buffer.from(signature)]);
    const bodyOf = async (id: string) => new Uint8Array((await f.command(id)).body as Uint8Array);

    // A signature a gateway (or anything but a worker key) made up.
    const forged = await f.enqueue(node, { kind: 'node.reboot' });
    await sign(
      forged,
      toBinary(SignatureSchema, create(SignatureSchema, { kid: 'k1', sig: new Uint8Array(64) })),
    );
    // A real worker signature over ANOTHER command's body (a swapped payload).
    const other = await f.enqueue(node, { kind: 'node.reboot' });
    const swapped = await f.enqueue(node, { kind: 'node.reboot' });
    await sign(swapped, signer.sign(await bodyOf(other)));
    // The genuine one.
    const genuine = await f.enqueue(node, { kind: 'node.reboot' });
    await sign(genuine, signer.sign(await bodyOf(genuine)));

    await f.gateway.jobs.dispatch.tick();
    for (const id of [forged, swapped])
      await expect
        .poll(async () => (await f.command(id)).state, { timeout: 10_000 })
        .toBe('rejected');
    for (const id of [forged, swapped])
      expect((await f.command(id)).reason).toMatch(/BAD_SIGNATURE|bad.signature/i);
    expect(daemon.executions.get(forged)).toBeUndefined();
    expect(daemon.executions.get(swapped)).toBeUndefined();
    await expect
      .poll(async () => (await f.command(genuine)).state, { timeout: 10_000 })
      .not.toMatch(/pending|dispatched|rejected/);
    // The never-signed one was held back by the gateway (signed frames only on WS).
    expect((await f.command(other)).state).toBe('pending');
  }, 30_000);
});
