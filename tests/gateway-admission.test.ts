import { afterEach, describe, expect, it } from 'vitest';
import { GrpcCode, GrpcError, type HandshakeOutcome } from '@better-compute/gateway';
import { agentFrame, FakeStream, gatewayFixture, helloFrame, type GatewayFixture } from './support/gateway.js';

// What a stream may cost the gateway before and after its Hello: unauthenticated joins never spend the
// tokens reconnecting nodes need, a stream that says no Hello gives its place back, and one that sends
// frames faster than they are handled is closed instead of queued without limit.

let f: GatewayFixture | undefined;
afterEach(() => f?.close());

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const refusal = (open: () => unknown): GrpcError => {
  try {
    open();
  } catch (error) {
    if (error instanceof GrpcError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

describe('joins and session opens', () => {
  it('keeps a flood of joins from refusing the reconnects of nodes in the fleet', async () => {
    f = await gatewayFixture({ handshakesPerSecond: 3, joinsPerSecond: 2 });
    const nodes = await Promise.all([f.addNode(), f.addNode(), f.addNode()]);
    // Join takes no client certificate: anyone can send as many as they like.
    const outcomes = await Promise.all(
      Array.from({ length: 50 }, () =>
        f!.gateway.join({} as never).then(
          () => 'ok',
          (error: unknown) => (error instanceof GrpcError ? `grpc:${error.code}` : 'service'),
        ),
      ),
    );
    // Two reached JoinService (which refuses them here); the rest met the join bucket.
    expect(outcomes.filter((outcome) => outcome === 'service')).toHaveLength(2);
    expect(outcomes.filter((outcome) => outcome === `grpc:${GrpcCode.RESOURCE_EXHAUSTED}`)).toHaveLength(48);
    expect(f.services.calls.filter((call) => call.method === 'join')).toHaveLength(2);
    // The handshake bucket is untouched: every node still gets in.
    for (const node of nodes) await f.connect(node);
    expect(f.gateway.status()).toMatchObject({ sessions: 3, pendingStreams: 0 });
  });
});

describe('streams before their Hello', () => {
  it('closes a stream that says no Hello in time and gives its place back', async () => {
    const outcomes: HandshakeOutcome[] = [];
    f = await gatewayFixture({ helloTimeoutMs: 40, observe: { onHandshake: (outcome) => outcomes.push(outcome) } });
    const [silent, prompt] = [await f.addNode(), await f.addNode()];
    const stream = new FakeStream();
    f.gateway.open({ nodeId: silent, role: 'node' }, stream);
    expect(f.gateway.status().pendingStreams).toBe(1);
    // A stream that does say Hello is not timed out, however long the session then lives.
    await f.connect(prompt);
    await wait(120);
    expect(stream.closed?.error).toMatchObject({ code: GrpcCode.DEADLINE_EXCEEDED });
    expect(f.gateway.status()).toMatchObject({ sessions: 1, pendingStreams: 0 });
    expect(outcomes).toEqual(['welcomed', 'timeout']);
  });

  it('counts them toward the stream limit', async () => {
    f = await gatewayFixture({ maxStreams: 2, helloTimeoutMs: 60_000 });
    const [a, b, c] = [await f.addNode(), await f.addNode(), await f.addNode()];
    // Two streams that never say Hello used to cost nothing: any number of them could be opened.
    const first = f.gateway.open({ nodeId: a, role: 'node' }, new FakeStream());
    f.gateway.open({ nodeId: b, role: 'node' }, new FakeStream());
    const full = refusal(() => f!.gateway.open({ nodeId: c, role: 'node' }, new FakeStream()));
    expect(full.code).toBe(GrpcCode.RESOURCE_EXHAUSTED);
    expect(full.message).toMatch(/stream limit/);
    // A stream that ends frees its place.
    await first.end();
    expect(f.gateway.status().pendingStreams).toBe(1);
    await f.connect(c);
    expect(f.gateway.status()).toMatchObject({ sessions: 1, pendingStreams: 1 });
  });

  it('frees the place of a stream whose first frame is not Hello, or whose Hello is refused', async () => {
    f = await gatewayFixture();
    const node = await f.addNode();
    const stream = new FakeStream();
    const handle = f.gateway.open({ nodeId: node, role: 'node' }, stream);
    await handle.receive(agentFrame({ case: 'heartbeat', value: {} }));
    expect(stream.closed?.error).toMatchObject({ code: GrpcCode.INVALID_ARGUMENT });
    expect(f.gateway.status().pendingStreams).toBe(0);
    // A Hello naming another node than the certificate's.
    const other = new FakeStream();
    const refused = f.gateway.open({ nodeId: node, role: 'node' }, other);
    await refused.receive(helloFrame('node_01k5w0000000000000000000zz'));
    expect(other.closed?.error).toBeDefined();
    expect(f.gateway.status()).toMatchObject({ sessions: 0, pendingStreams: 0 });
  });
});

describe('frames waiting on a stream', () => {
  it('closes a stream that outruns its queue instead of queueing without limit', async () => {
    f = await gatewayFixture({ maxQueuedFrames: 8 });
    const node = await f.addNode();
    const { stream, handle } = await f.connect(node);
    // Thirty frames with no await between them: nothing was handled yet when the ninth arrives.
    const sent = Array.from({ length: 30 }, () => handle.receive(agentFrame({ case: 'heartbeat', value: {} })));
    await Promise.all(sent);
    await wait(20);
    expect(stream.closed?.error).toMatchObject({ code: GrpcCode.RESOURCE_EXHAUSTED });
    expect(stream.closed?.error?.retryAfterMs).toBeGreaterThanOrEqual(1_000);
    expect(f.gateway.status().sessions).toBe(0);
    // A daemon at its usual pace is never near the bound.
    const again = await f.connect(node);
    for (let i = 0; i < 30; i++) await again.handle.receive(agentFrame({ case: 'heartbeat', value: {} }));
    expect(again.stream.closed).toBeUndefined();
    expect(f.gateway.status().sessions).toBe(1);
  });
});
