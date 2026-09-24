import { connect, type Socket } from 'node:net';
import { create, toBinary } from '@bufbuild/protobuf';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  encodeWsFrame,
  frameMessage,
  MessageDecoder,
  serveGatewayWs,
  signAgentProof,
  signGatewayProof,
  verifyAgentProof,
  verifyGatewayProof,
  WS_PATH,
  WS_SUBPROTOCOL,
  WsConnection,
  WsFrameDecoder,
  WsOpcode,
  wsClientKey,
  wsNonce,
  type ServedGatewayWs,
} from '@better-compute/gateway';
import {
  createCsr,
  createNodeCa,
  createReplayCache,
  createRevocationSet,
  createServingCa,
  generateP256KeyPair,
  nodeSpiffeId,
  type LocalCertificateAuthority,
  type RevocationSet,
} from '@better-compute/pki';
import {
  decodeServerFrame,
  encodeAgentFrame,
  SignatureSchema,
  unwrapCommand,
  type ServerFrame,
} from '@better-compute/protocol';
import { gatewayFixture, helloFrame, SITE, T0, type GatewayFixture } from './support/gateway.js';

// The WS fallback (PLAN.md §7.1, v0.4): RFC 6455 framing, in-band proofs both ways, and signed
// frames only.

describe('RFC 6455 codec', () => {
  const mask = new Uint8Array([1, 2, 3, 4]);
  it.each([0, 5, 125, 126, 65_535, 65_536, 200_000])('round-trips a masked %i-byte message', (size) => {
    const payload = new Uint8Array(size).map((_, i) => i % 251);
    const wire = encodeWsFrame(WsOpcode.binary, payload, mask);
    const decoder = new WsFrameDecoder(true, 1 << 20);
    const frames = [...decoder.push(wire.subarray(0, 3)), ...decoder.push(wire.subarray(3))];
    expect(frames).toHaveLength(1);
    expect(frames[0]!.opcode).toBe(WsOpcode.binary);
    expect(Buffer.compare(frames[0]!.payload, Buffer.from(payload))).toBe(0);
  });

  it('enforces masking direction, reserved bits, control-frame rules and the size limit', () => {
    const server = () => new WsFrameDecoder(true, 1024);
    expect(() => server().push(encodeWsFrame(WsOpcode.binary, new Uint8Array(1)))).toThrow(/must be masked/);
    const reserved = encodeWsFrame(WsOpcode.binary, new Uint8Array(1), mask);
    reserved[0] |= 0x40;
    expect(() => server().push(reserved)).toThrow(/reserved/);
    expect(() => server().push(encodeWsFrame(WsOpcode.ping, new Uint8Array(126), mask))).toThrow(/control/);
    expect(() => server().push(encodeWsFrame(WsOpcode.ping, new Uint8Array(1), mask, false))).toThrow(/control/);
    expect(() => server().push(encodeWsFrame(WsOpcode.binary, new Uint8Array(2048), mask))).toThrow(/too large/);
    expect(() => new WsFrameDecoder(false, 1024).push(encodeWsFrame(WsOpcode.binary, new Uint8Array(1), mask))).toThrow(
      /must not be masked/,
    );
  });
});

interface Pki {
  nodeCa: LocalCertificateAuthority;
  servingCa: LocalCertificateAuthority;
  serving: { key: import('node:crypto').KeyObject; chain: Uint8Array[] };
  agent(nodeId: string, options?: { ca?: LocalCertificateAuthority }): Promise<{ key: import('node:crypto').KeyObject; chain: Uint8Array[]; serial: string }>;
}

async function pki(clock: { now(): number }): Promise<Pki> {
  const nodeCa = createNodeCa({ clock });
  const servingCa = createServingCa({ clock });
  const gatewayKey = generateP256KeyPair();
  const serving = await servingCa.issue(gatewayKey.publicKey, { usage: 'server', dnsSans: ['gw.eu-1.test'], ttlSeconds: 86_400 });
  return {
    nodeCa,
    servingCa,
    serving: { key: gatewayKey.privateKey, chain: [serving.certificate, ...serving.chain] },
    async agent(nodeId, options = {}) {
      const key = generateP256KeyPair();
      const issued = await (options.ca ?? nodeCa).sign(createCsr(key.privateKey), {
        usage: 'client',
        role: 'node',
        ttlSeconds: 3_600,
        uriSans: [nodeSpiffeId({ trustDomain: 'compute.test', siteId: SITE, nodeId })],
      });
      return { key: key.privateKey, chain: [issued.certificate, ...issued.chain], serial: issued.serial };
    },
  };
}

describe('in-band proofs', () => {
  const now = T0;
  const clock = { now: () => now };
  let p: Pki;
  beforeEach(async () => {
    p = await pki(clock);
  });

  const options = (overrides: Partial<Parameters<typeof verifyAgentProof>[1]> = {}) => ({
    roots: [p.nodeCa.certificate],
    audiences: ['gw.eu-1.test'],
    nonce: 'n'.repeat(43),
    now,
    jtiCache: createReplayCache(),
    ...overrides,
  });

  it('accepts a fresh proof bound to the nonce and rejects its replay', async () => {
    const agent = await p.agent('node_ws_1');
    const token = signAgentProof({ ...agent, nodeId: 'node_ws_1', audience: 'gw.eu-1.test', nonce: 'n'.repeat(43), now });
    const verify = options();
    expect(verifyAgentProof(token, verify)).toMatchObject({ nodeId: 'node_ws_1', role: 'node' });
    expect(() => verifyAgentProof(token, verify)).toThrow(expect.objectContaining({ details: { reason: 'replayed' } }));
  });

  it.each([
    ['wrong audience', { audience: 'gw.other.test' }, {}, 'wrong audience'],
    ['another connection', {}, { nonce: 'm'.repeat(43) }, 'nonce mismatch'],
    ['stale', { now: now - 120_000 }, {}, 'stale'],
    ['claims another node', { nodeId: 'node_victim' }, {}, 'sub is not the certificate node'],
  ])('rejects a proof for %s', async (_name, sign, verify, reason) => {
    const agent = await p.agent('node_ws_2');
    const token = signAgentProof({ ...agent, nodeId: 'node_ws_2', audience: 'gw.eu-1.test', nonce: 'n'.repeat(43), now, ...sign });
    expect(() => verifyAgentProof(token, options(verify))).toThrow(expect.objectContaining({ code: 'UNAUTHENTICATED', details: { reason } }));
  });

  it('rejects a chain from another CA, a revoked certificate and a tampered signature', async () => {
    const foreign = await p.agent('node_ws_3', { ca: createNodeCa({ clock }) });
    const signed = (agent: { key: import('node:crypto').KeyObject; chain: Uint8Array[] }) =>
      signAgentProof({ ...agent, nodeId: 'node_ws_3', audience: 'gw.eu-1.test', nonce: 'n'.repeat(43), now });
    expect(() => verifyAgentProof(signed(foreign), options())).toThrow(/Proof rejected/);

    const revoked = await p.agent('node_ws_3');
    const revocations: RevocationSet = createRevocationSet();
    revocations.add(revoked.serial);
    expect(() => verifyAgentProof(signed(revoked), options({ revocations }))).toThrow(/Proof rejected/);

    const good = signed(await p.agent('node_ws_3'));
    const [h, c, s] = good.split('.');
    const tampered = `${h}.${c}.${s!.slice(0, -4)}AAAA`;
    expect(() => verifyAgentProof(tampered, options())).toThrow(expect.objectContaining({ details: { reason: 'bad signature' } }));
  });

  it('lets the daemon verify the gateway proof against its pinned serving CA only', () => {
    const token = signGatewayProof({ ...p.serving, gatewayId: 'gw_1', nodeId: 'node_x', nonce: 'n'.repeat(43), now });
    expect(verifyGatewayProof(token, { servingRoots: [p.servingCa.certificate], nodeId: 'node_x', nonce: 'n'.repeat(43), now })).toBe('gw_1');
    expect(() =>
      verifyGatewayProof(token, { servingRoots: [p.servingCa.certificate], nodeId: 'node_x', nonce: 'm'.repeat(43), now }),
    ).toThrow(expect.objectContaining({ details: { reason: 'not for this connection' } }));
    const mitm = createServingCa({ clock });
    expect(() => verifyGatewayProof(token, { servingRoots: [mitm.certificate], nodeId: 'node_x', nonce: 'n'.repeat(43), now })).toThrow(
      expect.objectContaining({ details: { reason: 'serving chain not trusted' } }),
    );
  });
});

describe('WS sessions end to end', () => {
  let f: GatewayFixture;
  let p: Pki;
  let served: ServedGatewayWs;
  const sockets: Socket[] = [];

  beforeEach(async () => {
    f = await gatewayFixture();
    p = await pki(f.clock);
    served = await serveGatewayWs(f.gateway, {
      insecure: true,
      roots: [p.nodeCa.certificate],
      audiences: ['gw.eu-1.test'],
      serving: p.serving,
      clock: f.clock,
    });
  });
  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.destroy();
    await served.close();
    await f.close();
  });

  /** A raw WS client: upgrade with a proof, check the gateway proof, then frames. */
  async function dial(nodeId: string, options: { proof?: string; protocol?: string } = {}) {
    const agent = await p.agent(nodeId);
    const nonce = wsNonce();
    const proof =
      options.proof ?? signAgentProof({ ...agent, nodeId, audience: 'gw.eu-1.test', nonce, now: f.clock.now() });
    const socket = connect(served.port, '127.0.0.1');
    sockets.push(socket);
    socket.write(
      `GET ${WS_PATH} HTTP/1.1\r\nhost: gw.eu-1.test\r\nupgrade: websocket\r\nconnection: Upgrade\r\n` +
        `sec-websocket-key: ${wsClientKey()}\r\nsec-websocket-version: 13\r\n` +
        `sec-websocket-protocol: ${options.protocol ?? WS_SUBPROTOCOL}\r\nx-bc-nonce: ${nonce}\r\nx-bc-proof: ${proof}\r\n\r\n`,
    );
    const head = await new Promise<{ status: number; headers: Record<string, string>; rest: Buffer }>((resolve) => {
      let buffer = Buffer.alloc(0);
      const onData = (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        socket.off('data', onData);
        socket.pause();
        const lines = buffer.subarray(0, end).toString('latin1').split('\r\n');
        const headers: Record<string, string> = {};
        for (const line of lines.slice(1)) {
          const at = line.indexOf(':');
          headers[line.slice(0, at).toLowerCase()] = line.slice(at + 1).trim();
        }
        resolve({ status: Number(lines[0]!.split(' ')[1]), headers, rest: buffer.subarray(end + 4) });
      };
      socket.on('data', onData);
    });
    const frames: ServerFrame[] = [];
    let closed: { code: number; reason: string } | undefined;
    const decoder = new MessageDecoder();
    let conn: WsConnection | undefined;
    if (head.status === 101) {
      if (head.rest.length) socket.unshift(head.rest);
      conn = new WsConnection(socket, {
        role: 'client',
        onMessage: (message) => {
          for (const bytes of decoder.push(message)) frames.push(decodeServerFrame(bytes));
        },
        onClose: (info) => (closed = info),
      });
      socket.resume();
    }
    return {
      head,
      nonce,
      frames,
      closed: () => closed,
      send: (msg: Parameters<typeof helloFrame>[0] extends string ? ReturnType<typeof helloFrame> : never) =>
        conn!.send(frameMessage(encodeAgentFrame(msg))),
      conn,
    };
  }

  it('authenticates both ways in-band and runs a session', async () => {
    const node = await f.addNode();
    const client = await dial(node);
    expect(client.head.status).toBe(101);
    expect(client.head.headers['sec-websocket-protocol']).toBe(WS_SUBPROTOCOL);
    const gatewayId = verifyGatewayProof(client.head.headers['x-bc-gateway-proof']!, {
      servingRoots: [p.servingCa.certificate],
      nodeId: node,
      nonce: client.nonce,
      now: f.clock.now(),
    });
    expect(gatewayId).toBe(f.gateway.id);

    client.send(helloFrame(node));
    await expect.poll(() => client.frames.map((frame) => frame.msg.case)).toEqual(['welcome']);
    expect(f.gateway.sessions()).toMatchObject([{ nodeId: node }]);

    client.conn!.close(1000, 'bye');
    await expect.poll(async () => (await f.session(node)).gateway_id).toBeNull();
  });

  it('sends only signed commands and specs to a WS session; unsigned ones stay pending', async () => {
    const node = await f.addNode();
    const unsigned = await f.enqueue(node);
    const signed = await f.enqueue(node);
    await f.db.query('UPDATE commands SET signature = $2 WHERE id = $1', [
      signed,
      Buffer.from(toBinary(SignatureSchema, create(SignatureSchema, { kid: 'k1', sig: new Uint8Array([1, 2, 3]) }))),
    ]);
    await f.db.query(`UPDATE nodes SET spec = '{}'::jsonb, generation = 2 WHERE id = $1`, [node]);
    const client = await dial(node);
    client.send(helloFrame(node));
    await expect.poll(() => client.frames.length).toBeGreaterThan(0);
    await f.gateway.jobs.dispatch.tick();
    await expect.poll(() => client.frames.filter((frame) => frame.msg.case === 'command').length).toBe(1);
    const sent = client.frames.flatMap((frame) => (frame.msg.case === 'command' ? [unwrapCommand(frame.msg.value).id] : []));
    expect(sent).toEqual([signed]);
    expect(client.frames.some((frame) => frame.msg.case === 'desired')).toBe(false);
    expect((await f.command(unsigned)).state).toBe('pending');
  });

  it('refuses upgrades without a valid proof, with a replayed proof, or for another subprotocol', async () => {
    const node = await f.addNode();
    expect((await dial(node, { proof: 'nope' })).head).toMatchObject({ status: 401 });
    expect((await dial(node, { protocol: 'chat' })).head).toMatchObject({ status: 400 });

    // A proof captured from one connection is bound to that connection's nonce: useless on another.
    const agent = await p.agent(node);
    const captured = signAgentProof({ ...agent, nodeId: node, audience: 'gw.eu-1.test', nonce: wsNonce(), now: f.clock.now() });
    const replayed = await dial(node, { proof: captured });
    expect(replayed.head).toMatchObject({ status: 401 });
    expect(decodeURIComponent(replayed.head.headers['x-bc-reason']!)).toBe('Proof rejected');
    // A fresh proof still works.
    expect((await dial(node)).head.status).toBe(101);
  });
});
