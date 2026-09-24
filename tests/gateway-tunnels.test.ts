import { connect, type ClientHttp2Session } from 'node:http2';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_GATEWAY_SERVICE,
  frameMessage,
  gatewayControlClient,
  GrpcCode,
  MessageDecoder,
  serveGateway,
  serveInternal,
  type GatewayControlClient,
  type ServedGateway,
  type ServedInternal,
  type TunnelEndpoint,
  type TunnelOptions,
} from '@better-compute/gateway';
import { createExecTicketIssuer, createReplayCache, verifyExecTicket, type ExecTicketIssuer } from '@better-compute/pki';
import {
  AgentFrameSchema,
  AgentRole,
  decodeServerFrame,
  encodeAgentFrame,
  PROTOCOL_VERSION,
  TunnelFrameSchema,
  type TunnelFrame,
} from '@better-compute/protocol';
import { gatewayFixture, type GatewayFixture } from './support/gateway.js';

// Tunnels (PLAN.md §7.6, §13, v0.3 exit): exec tickets verified by the gateway and again by the
// daemon, relay with backpressure, re-authorization, the 12 h cap, revocation and close-by-subject.

const ISSUER = 'compute.test';
const data = (text: string, tunnelId = ''): TunnelFrame =>
  create(TunnelFrameSchema, { tunnelId, body: { case: 'data', value: new TextEncoder().encode(text) } });
const text = (frame: TunnelFrame | undefined) =>
  frame?.body.case === 'data' ? new TextDecoder().decode(frame.body.value) : undefined;

/** An endpoint that records what it is sent and whether it was paused. */
class Side implements TunnelEndpoint {
  readonly sent: TunnelFrame[] = [];
  closed: { code?: number } | undefined;
  paused = 0;
  resumed = 0;
  full = false;
  private drains: (() => void)[] = [];
  send(frame: TunnelFrame) {
    this.sent.push(frame);
    return !this.full;
  }
  onDrain(callback: () => void) {
    this.drains.push(callback);
  }
  drain() {
    this.full = false;
    for (const callback of this.drains.splice(0)) callback();
  }
  pause() {
    this.paused++;
  }
  resume() {
    this.resumed++;
  }
  close(error?: { code: number }) {
    this.closed ??= { code: error?.code };
  }
}

describe('tunnel core', () => {
  let f: GatewayFixture;
  let issuer: ExecTicketIssuer;
  let reauthorize: TunnelOptions['reauthorize'];

  beforeEach(async () => {
    reauthorize = undefined;
    f = await gatewayFixture({
      tunnels: {
        jwks: () => issuer.jwksJson(),
        issuer: ISSUER,
        reauthorize: (tunnel) => reauthorize?.(tunnel) ?? Promise.resolve(true),
      },
    });
    issuer = createExecTicketIssuer({ issuer: ISSUER, clock: f.clock });
  });
  afterEach(() => f.close());

  /** Opens a tunnel with a node session that answers OpenTunnel from `answer` (default: itself). */
  async function open(options: { answerAs?: string; ticketFor?: string; op?: 'exec' | 'console' } = {}) {
    const node = await f.addNode();
    const { stream } = await f.connect(node);
    const ticket = issuer.issue({ nodeId: options.ticketFor ?? node, sid: `tun_${node.slice(-6)}`, op: options.op ?? 'console', subject: 'user_1' });
    const caller = new Side();
    const opening = f.gateway.openTunnel({ ticket: ticket.token, nodeId: node, caller });
    const nodeSide = new Side();
    const openFrame = stream.of('openTunnel')[0];
    const handle = openFrame
      ? f.gateway.acceptTunnel({ nodeId: options.answerAs ?? node }, nodeSide)
      : undefined;
    handle?.receive(create(TunnelFrameSchema, { tunnelId: openFrame!.tunnelId, body: { case: 'opened', value: {} } }));
    return { node, stream, ticket, caller, nodeSide, handle, opening, openFrame };
  }

  it('asks the node over its session and relays both ways once its Tunnel stream is up', async () => {
    const { opening, openFrame, ticket, caller, nodeSide, handle } = await open();
    expect(openFrame).toMatchObject({ ticket: ticket.token });
    const tunnel = await opening;
    expect(tunnel.info).toMatchObject({ subject: 'user_1', op: 'console' });
    expect(f.gateway.tunnels()).toMatchObject([{ id: tunnel.info.id, state: 'open' }]);

    tunnel.receive(data('ls -la'));
    expect(text(nodeSide.sent[0])).toBe('ls -la');
    expect(nodeSide.sent[0]!.tunnelId).toBe(tunnel.info.id);
    handle!.receive(data('total 0'));
    expect(text(caller.sent[0])).toBe('total 0');

    // The node's exit status ends the tunnel on both sides.
    handle!.receive(create(TunnelFrameSchema, { tunnelId: tunnel.info.id, body: { case: 'closed', value: { exitCode: 3 } } }));
    expect(caller.sent.at(-1)!.body).toMatchObject({ case: 'closed', value: { exitCode: 3 } });
    expect(caller.closed).toBeDefined();
    expect(f.gateway.tunnels()).toEqual([]);
  });

  it('applies backpressure: a full side pauses the other until it drains', async () => {
    const { opening, caller, nodeSide } = await open();
    const tunnel = await opening;
    nodeSide.full = true;
    tunnel.receive(data('a lot'));
    expect(caller.paused).toBe(1);
    nodeSide.drain();
    expect(caller.resumed).toBe(1);
  });

  it('rejects replayed tickets, tickets for another node and unconfigured gateways', async () => {
    const { ticket, opening, node } = await open();
    await opening;
    await expect(
      f.gateway.openTunnel({ ticket: ticket.token, nodeId: node, caller: new Side() }),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });

    const other = await f.addNode();
    const foreign = issuer.issue({ nodeId: other, sid: 'tun_x', op: 'exec', subject: 'u' });
    await expect(f.gateway.openTunnel({ ticket: foreign.token, nodeId: node, caller: new Side() })).rejects.toMatchObject({
      code: 'ACCESS_DENIED',
    });

    const offline = await f.addNode();
    const lonely = issuer.issue({ nodeId: offline, sid: 'tun_y', op: 'exec', subject: 'u' });
    await expect(f.gateway.openTunnel({ ticket: lonely.token, nodeId: offline, caller: new Side() })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it("refuses a node answering for another node's tunnel", async () => {
    const { nodeSide, opening } = await open({ answerAs: 'node_intruder' });
    expect(nodeSide.closed?.code).toBe(GrpcCode.PERMISSION_DENIED);
    expect(f.gateway.tunnels()).toMatchObject([{ state: 'opening' }]);
    f.gateway.closeTunnels({ subject: 'user_1' }, 'test over');
    await expect(opening).rejects.toBeDefined();
  });

  it('re-authorizes every 60 s and closes on refusal', async () => {
    const { opening, caller } = await open();
    await opening;
    let calls = 0;
    reauthorize = async () => ++calls < 2;
    await f.advance(59_000);
    await f.gateway.jobs.liveness.tick();
    expect(calls).toBe(0);
    await f.advance(1_000);
    await f.gateway.jobs.liveness.tick();
    expect(calls).toBe(1);
    expect(f.gateway.tunnels()).toHaveLength(1);
    await f.advance(60_000);
    await f.gateway.jobs.liveness.tick();
    expect(f.gateway.tunnels()).toEqual([]);
    expect(caller.closed?.code).toBe(GrpcCode.PERMISSION_DENIED);
  });

  it('closes after IAM is unreachable for more than 2 minutes, and at the 12 h cap', async () => {
    const first = await open();
    await first.opening;
    reauthorize = async () => {
      throw new Error('IAM down');
    };
    for (let i = 0; i < 12; i++) {
      await f.advance(15_000);
      await f.gateway.jobs.lease.tick(); // keep this gateway's lease, as its loop would
      await f.gateway.jobs.liveness.tick();
    }
    expect(first.caller.sent.at(-1)!.body).toMatchObject({ case: 'closed', value: { reason: 'iam-unreachable' } });

    reauthorize = async () => true;
    const second = await open();
    await second.opening;
    await f.advance(12 * 3_600_000);
    await f.gateway.jobs.lease.tick();
    await f.gateway.jobs.liveness.tick();
    expect(second.caller.sent.at(-1)!.body).toMatchObject({ case: 'closed', value: { reason: 'max-duration' } });
  });

  it('closes tunnels by subject (delegation revoked) and on node revocation', async () => {
    const a = await open();
    await a.opening;
    expect(f.gateway.closeTunnels({ subject: 'user_1' }, 'delegation-revoked')).toBe(1);
    expect(a.nodeSide.sent.at(-1)!.body).toMatchObject({ case: 'closed', value: { reason: 'delegation-revoked' } });

    const b = await open();
    await b.opening;
    await f.gateway.revoke(b.node, { reason: 'key compromise' });
    expect(f.gateway.tunnels()).toEqual([]);
  });
});

describe('tunnels end to end over HTTP/2', () => {
  let f: GatewayFixture;
  let served: ServedGateway;
  let internal: ServedInternal;
  let control: GatewayControlClient;
  let issuer: ExecTicketIssuer;
  /** The key the gateway trusts; a compromised gateway could be handed another one. */
  let gatewayJwks: () => string;
  const clients: ClientHttp2Session[] = [];

  beforeEach(async () => {
    f = await gatewayFixture({ tunnels: { jwks: () => gatewayJwks(), issuer: ISSUER } });
    issuer = createExecTicketIssuer({ issuer: ISSUER, clock: f.clock });
    gatewayJwks = () => issuer.jwksJson();
    served = await serveGateway(f.gateway, {
      insecure: true,
      authenticate: (peer) => {
        const nodeId = peer.headers['x-test-node'];
        return typeof nodeId === 'string' ? { nodeId, role: 'node' } : undefined;
      },
    });
    internal = await serveInternal(f.gateway, { insecure: true });
    control = gatewayControlClient({ baseUrl: `http://127.0.0.1:${internal.port}`, timeoutMs: 5_000 });
  });
  afterEach(async () => {
    control.close();
    for (const client of clients.splice(0)) client.destroy();
    await internal.close();
    await served.close(100);
    await f.close();
  });

  /**
   * A bcd-like daemon: a Session on one HTTP/2 connection; on OpenTunnel it re-verifies the ticket
   * against its PINNED JWKS and its own jti set (P14) and only then opens a Tunnel stream on the same
   * connection, echoing data upper-cased.
   */
  async function daemon(nodeId: string, pinnedJwks = () => issuer.jwksJson()) {
    const client = connect(`http://127.0.0.1:${served.port}`);
    client.on('error', () => {});
    clients.push(client);
    const headers = { ':method': 'POST', 'content-type': 'application/grpc', te: 'trailers', 'x-test-node': nodeId };
    const session = client.request({ ...headers, ':path': `/${AGENT_GATEWAY_SERVICE}/Session` });
    const jti = createReplayCache();
    const refused: string[] = [];
    const opened: string[] = [];
    const decoder = new MessageDecoder();
    const welcomed = new Promise<void>((resolve) => {
      session.on('data', (chunk: Buffer) => {
        for (const bytes of decoder.push(chunk)) {
          const frame = decodeServerFrame(bytes);
          if (frame.msg.case === 'welcome') resolve();
          if (frame.msg.case !== 'openTunnel') continue;
          const { tunnelId, ticket } = frame.msg.value;
          try {
            verifyExecTicket(ticket, { jwks: pinnedJwks(), nodeId, now: f.clock.now(), jtiCache: jti, issuer: ISSUER });
          } catch (error) {
            refused.push(String((error as { details?: { reason?: string } }).details?.reason ?? error));
            continue;
          }
          opened.push(tunnelId);
          const tunnel = client.request({ ...headers, ':path': `/${AGENT_GATEWAY_SERVICE}/Tunnel` });
          tunnel.on('error', () => {});
          const tunnelDecoder = new MessageDecoder();
          const write = (out: TunnelFrame) => tunnel.write(frameMessage(toBinary(TunnelFrameSchema, out)));
          write(create(TunnelFrameSchema, { tunnelId, body: { case: 'opened', value: {} } }));
          tunnel.on('data', (tchunk: Buffer) => {
            for (const tbytes of tunnelDecoder.push(tchunk)) {
              const incoming = fromBinary(TunnelFrameSchema, tbytes);
              if (incoming.body.case === 'data') write(data(text(incoming)!.toUpperCase(), tunnelId));
              if (incoming.body.case === 'closed') {
                write(create(TunnelFrameSchema, { tunnelId, body: { case: 'closed', value: { exitCode: 0 } } }));
                tunnel.end();
              }
            }
          });
        }
      });
    });
    session.write(
      frameMessage(
        encodeAgentFrame(
          create(AgentFrameSchema, {
            msg: {
              case: 'hello',
              value: {
                nodeId,
                bootId: 'b',
                journalId: 'j',
                role: AgentRole.NODE,
                protoMin: PROTOCOL_VERSION.min,
                protoMax: PROTOCOL_VERSION.max,
              },
            },
          }),
        ),
      ),
    );
    await welcomed;
    return { refused, opened };
  }

  it('opens through the control API, relays both ways, and closes cleanly', async () => {
    const node = await f.addNode();
    const d = await daemon(node);
    const ticket = issuer.issue({ nodeId: node, sid: 'tun_e2e', op: 'exec', subject: 'user_1' });
    const tunnel = await control.openTunnel({ ticket: ticket.token, nodeId: node });
    expect(tunnel.id).toBe('tun_e2e');
    expect(d.opened).toEqual(['tun_e2e']);
    const frames = tunnel.frames[Symbol.asyncIterator]();
    tunnel.send(data('whoami'));
    expect(text((await frames.next()).value)).toBe('WHOAMI');
    tunnel.send(create(TunnelFrameSchema, { body: { case: 'closed', value: {} } }));
    const last = (await frames.next()).value as TunnelFrame;
    expect(last.body).toMatchObject({ case: 'closed', value: { exitCode: 0 } });
    await expect.poll(() => f.gateway.tunnels().length).toBe(0);
  });

  it('refuses a replayed ticket at the gateway', async () => {
    const node = await f.addNode();
    await daemon(node);
    const ticket = issuer.issue({ nodeId: node, sid: 'tun_once', op: 'exec', subject: 'user_1' });
    (await control.openTunnel({ ticket: ticket.token, nodeId: node })).close();
    await expect(control.openTunnel({ ticket: ticket.token, nodeId: node })).rejects.toMatchObject({
      code: 'ACCESS_DENIED',
    });
  });

  it('never opens a ticket the gateway accepts but the daemon rejects (P14: a compromised gateway)', async () => {
    const node = await f.addNode();
    const d = await daemon(node);
    // The gateway was handed an attacker's key; the daemon's pinned JWKS is the real one.
    const attacker = createExecTicketIssuer({ issuer: ISSUER, clock: f.clock });
    gatewayJwks = () => attacker.jwksJson();
    const forged = attacker.issue({ nodeId: node, sid: 'tun_forged', op: 'console', subject: 'mallory' });
    await expect(control.openTunnel({ ticket: forged.token, nodeId: node })).rejects.toBeDefined();
    expect(d.opened).toEqual([]);
    expect(d.refused).toHaveLength(1);
    expect(f.gateway.tunnels()).toEqual([]);
  }, 20_000);

  it('closes a live tunnel through POST /v1/tunnels/close (delegation revoked)', async () => {
    const node = await f.addNode();
    await daemon(node);
    const ticket = issuer.issue({ nodeId: node, sid: 'tun_rev', op: 'exec', subject: 'agent_7' });
    const tunnel = await control.openTunnel({ ticket: ticket.token, nodeId: node });
    const frames = tunnel.frames[Symbol.asyncIterator]();
    expect(await control.closeTunnels({ subject: 'agent_7' }, 'delegation-revoked')).toBe(1);
    const closed = (await frames.next()).value as TunnelFrame;
    expect(closed.body).toMatchObject({ case: 'closed', value: { reason: 'delegation-revoked' } });
    expect((await frames.next()).done).toBe(true);
  });

  it('refuses a Tunnel stream nobody asked for', async () => {
    const node = await f.addNode();
    await daemon(node);
    const client = clients[0]!;
    const stray = client.request({
      ':method': 'POST',
      ':path': `/${AGENT_GATEWAY_SERVICE}/Tunnel`,
      'content-type': 'application/grpc',
      te: 'trailers',
      'x-test-node': node,
    });
    stray.write(frameMessage(toBinary(TunnelFrameSchema, create(TunnelFrameSchema, { tunnelId: 'tun_nope', body: { case: 'opened', value: {} } }))));
    const status = await new Promise<number>((resolve) => {
      stray.once('trailers', (headers) => resolve(Number(headers['grpc-status'])));
      stray.once('response', (headers) => {
        if (headers['grpc-status'] !== undefined) resolve(Number(headers['grpc-status']));
      });
    });
    expect(status).toBe(GrpcCode.NOT_FOUND);
  });
});

