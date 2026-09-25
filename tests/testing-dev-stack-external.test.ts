import { createPublicKey, X509Certificate } from 'node:crypto';
import { connect, type ClientHttp2Session } from 'node:http2';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_GATEWAY_SERVICE, frameMessage, MessageDecoder } from '@better-compute/gateway';
import { privateKeyPem, spkiPin, toPem } from '@better-compute/pki';
import { AgentFrameSchema, AgentRole, decodeServerFrame, encodeAgentFrame, PROTOCOL_VERSION, type ServerFrame } from '@better-compute/protocol';
import { create } from '@bufbuild/protobuf';
import {
  createDevStack,
  createH2cClient,
  createRealtimeScheduler,
  FakeDaemon,
  fakeHardware,
  runAgentJoin,
  type DevStack,
} from '@better-compute/testing';

// Daemons outside the dev stack's process (a real bcd in an integration test): they join through the
// gateway's Join RPC on their own, with only what `scripts/dev-gateway.mjs` prints (pins, a token), then
// open their Session either over the loopback h2c listener (`admitExternalJoins`) or, as in production,
// over the mTLS listener (`externalTls`) with the certificate JoinService issued them.

let dev: DevStack | undefined;
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  await dev?.close();
  dev = undefined;
});

/** A machine joining on its own, from the printed pins only (what bcd has). */
async function joinOutside(stack: DevStack, token: string, seed: string) {
  const client = createH2cClient({ url: stack.gatewayUrl });
  cleanups.push(() => client.close());
  const hardware = fakeHardware({ seed, variant: 'hgx-h100' });
  const { body, privateKey } = await runAgentJoin({
    send: (request) => client.join(request),
    role: AgentRole.NODE,
    signer: { publicKey: createPublicKey({ key: stack.pins.joinSigningKey, format: 'jwk' }) },
    nodeCaRoots: [stack.pins.nodeCaCertificate],
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    claims: hardware.claims,
    daemonVersion: '0.1.0-bcd',
    token: { token, joinEncryptionKey: createPublicKey({ key: stack.pins.joinEncryptionJwk, format: 'jwk' }) },
  });
  return { client, hardware, nodeId: body.nodeId, chain: body.certChain, privateKey };
}

async function tokenFor(stack: DevStack) {
  const { poolId } = await stack.createPool({ key: 'outside' });
  const api = stack.compute.api as any;
  const minted = await api.joinTokens.create(stack.root, {
    tenantId: stack.rootTenantId,
    poolId,
    ttlSeconds: 600,
    maxUses: 2,
    idempotencyKey: `outside-${Math.random()}`,
  });
  return minted.token as string;
}

describe('external joins on the dev stack', () => {
  it('admits a node that joined on its own over loopback h2c with admitExternalJoins, and runs it to adopted', { timeout: 60_000 }, async () => {
    dev = await createDevStack({ admitExternalJoins: true });
    const outside = await joinOutside(dev, await tokenFor(dev), 'outside-h2c');
    expect(await dev.admit(outside.nodeId)).toBe(true);
    const daemon = new FakeDaemon({
      nodeId: outside.nodeId,
      hardware: outside.hardware,
      nodeKey: outside.privateKey,
      scheduler: createRealtimeScheduler({ onError: () => {} }),
      backoff: { minMs: 100, maxMs: 1_000 },
      dial: () => outside.client.session(outside.nodeId),
    });
    cleanups.push(() => daemon.state !== 'stopped' && daemon.crash('test-end'));
    daemon.start();
    await dev.waitFor([outside.nodeId], { timeoutMs: 45_000 });
  });

  it('refuses header admission of outside joins on a non-loopback host', async () => {
    await expect(createDevStack({ admitExternalJoins: true, gateway: { host: '0.0.0.0' } })).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
    });
  });

  it('serves outside daemons over mTLS: the JoinService certificate opens a Session, no header needed', { timeout: 60_000 }, async () => {
    dev = await createDevStack({ externalTls: {} });
    expect(dev.externalGatewayUrl).toMatch(/^https:\/\/127\.0\.0\.1:\d+$/);
    // The control plane publishes where daemons dial and what to pin, for `bcd join --server <control plane>`.
    const wellKnown = (await (
      await dev.compute.handler(
        new Request(`http://127.0.0.1:3000${dev.compute.endpoint.basePath}/.well-known/better-compute`),
      )
    ).json()) as { gateway?: { url: string; serverName?: string; servingCaPin?: string } };
    expect(wellKnown.gateway).toEqual({
      url: dev.externalGatewayUrl,
      serverName: 'localhost',
      servingCaPin: spkiPin(new X509Certificate(Buffer.from(dev.servingCaCertificate!)).publicKey),
    });
    const outside = await joinOutside(dev, await tokenFor(dev), 'outside-tls');
    const h2: ClientHttp2Session = connect(dev.externalGatewayUrl!, {
      ca: toPem(dev.servingCaCertificate!),
      key: privateKeyPem(outside.privateKey),
      cert: outside.chain.map((der) => toPem(der)).join(''),
      servername: 'gw.dev.local',
    });
    h2.on('error', () => {});
    cleanups.push(() => h2.destroy());
    const stream = h2.request({
      ':method': 'POST',
      ':path': `/${AGENT_GATEWAY_SERVICE}/Session`,
      'content-type': 'application/grpc',
      te: 'trailers',
    });
    stream.on('error', () => {});
    const frames: ServerFrame[] = [];
    const decoder = new MessageDecoder();
    stream.on('data', (chunk: Buffer) => {
      for (const message of decoder.push(chunk)) frames.push(decodeServerFrame(message));
    });
    stream.write(
      frameMessage(
        encodeAgentFrame(
          create(AgentFrameSchema, {
            msg: {
              case: 'hello',
              value: {
                nodeId: outside.nodeId,
                bootId: 'boot-outside',
                journalId: 'journal-outside',
                role: AgentRole.NODE,
                protoMin: PROTOCOL_VERSION.min,
                protoMax: PROTOCOL_VERSION.max,
              },
            },
          }),
        ),
      ),
    );
    await expect.poll(() => frames.map((frame) => frame.msg.case), { timeout: 10_000 }).toContain('welcome');
    expect(dev.gateway.sessions()).toEqual(expect.arrayContaining([expect.objectContaining({ nodeId: outside.nodeId })]));
  });
});
