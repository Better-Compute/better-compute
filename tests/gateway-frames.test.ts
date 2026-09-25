import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachFrameConn, closeReason, GrpcCode, GrpcError, type FrameEndpoint } from '@better-compute/gateway';
import { CommandState, unwrapCommand, type AgentFrame, type ServerFrame } from '@better-compute/protocol';
import { agentFrame, gatewayFixture, helloFrame, type GatewayFixture } from './support/gateway.js';

// The frame-stream adapter the simulator uses to run daemons against a real gateway without HTTP/2.

/** A minimal in-memory gateway end: frames are pushed by the test, replies recorded. */
class Endpoint implements FrameEndpoint {
  closed = false;
  reason: string | undefined;
  retryAfterMs: number | undefined;
  readonly received: ServerFrame[] = [];
  private frameHandler: ((frame: AgentFrame) => void | Promise<void>) | undefined;
  private closeHandlers: ((info: { reason: string }) => void | Promise<void>)[] = [];

  send(frame: ServerFrame) {
    if (this.closed) return false;
    this.received.push(frame);
    return true;
  }
  onFrame(handler: (frame: AgentFrame) => void | Promise<void>) {
    this.frameHandler = handler;
  }
  onClose(handler: (info: { reason: string }) => void | Promise<void>) {
    this.closeHandlers.push(handler);
  }
  close(reason = 'closed', info?: { retryAfterMs?: number }) {
    if (this.closed) return;
    this.closed = true;
    this.reason = reason;
    this.retryAfterMs = info?.retryAfterMs;
    for (const handler of this.closeHandlers) void handler({ reason });
  }
  /** The daemon side sends a frame. */
  async push(frame: AgentFrame) {
    await this.frameHandler?.(frame);
  }
  /** The daemon side goes away. */
  async drop() {
    this.closed = true;
    await Promise.all(this.closeHandlers.map((handler) => handler({ reason: 'remote reset' })));
  }
}

let f: GatewayFixture;
beforeEach(async () => {
  f = await gatewayFixture();
});
afterEach(() => f.close());

describe('attachFrameConn', () => {
  it('runs a full session over a frame stream', async () => {
    const node = await f.addNode();
    const id = await f.enqueue(node);
    const conn = new Endpoint();
    expect(attachFrameConn(f.gateway, { nodeId: node, role: 'node' }, conn)).toBe(true);
    await conn.push(helloFrame(node));
    expect(conn.received[0]!.msg.case).toBe('welcome');
    await f.gateway.jobs.dispatch.tick();
    const command = conn.received.find((frame) => frame.msg.case === 'command')!;
    expect(command.msg.case === 'command' && unwrapCommand(command.msg.value).id).toBe(id);
    await conn.push(agentFrame({ case: 'update', value: { commandId: id, state: CommandState.SUCCEEDED } }));
    expect((await f.command(id)).state).toBe('succeeded');

    await conn.drop();
    await expect.poll(async () => (await f.session(node)).gateway_id).toBeNull();
  });

  it('closes the endpoint with the status as its reason', async () => {
    const node = await f.addNode();
    const conn = new Endpoint();
    attachFrameConn(f.gateway, { nodeId: node }, conn);
    await conn.push(helloFrame('node_other'));
    expect(conn.reason).toBe('PERMISSION_DENIED: Hello.node_id does not match the certificate');

    await f.gateway.drain();
    const refused = new Endpoint();
    expect(attachFrameConn(f.gateway, { nodeId: node }, refused)).toBe(false);
    expect(refused.reason).toBe('UNAVAILABLE: gateway is draining');
    expect(refused.retryAfterMs).toBeUndefined();
  });

  it("passes a busy refusal's retry pushback to the endpoint", async () => {
    const g = await f.another({ handshakesPerSecond: 1 });
    const [a, b] = [await f.addNode(), await f.addNode()];
    expect(attachFrameConn(g, { nodeId: a, role: 'node' }, new Endpoint())).toBe(true);
    const refused = new Endpoint();
    expect(attachFrameConn(g, { nodeId: b, role: 'node' }, refused)).toBe(false);
    expect(refused.reason).toMatch(/^RESOURCE_EXHAUSTED: handshake rate exceeded/);
    expect(refused.retryAfterMs).toBeGreaterThanOrEqual(250);
    await g.stop();
  });

  it('formats statuses', () => {
    expect(closeReason()).toBe('OK');
    expect(closeReason(new GrpcError(GrpcCode.ABORTED, ''))).toBe('ABORTED');
    expect(closeReason(new GrpcError(GrpcCode.RESOURCE_EXHAUSTED, 'slow down'))).toBe('RESOURCE_EXHAUSTED: slow down');
  });
});
