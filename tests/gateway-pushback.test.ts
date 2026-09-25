import { afterEach, describe, expect, it } from 'vitest';
import { GrpcCode, GrpcError, statusTrailers } from '@better-compute/gateway';
import { FakeStream, gatewayFixture, type GatewayFixture } from './support/gateway.js';

// Refusals of a busy gateway carry `grpc-retry-pushback-ms` (§8.6): a power-on herd spreads over the
// time the handshake bucket needs instead of each daemon's own doubling back-off.

let f: GatewayFixture | undefined;
afterEach(() => f?.close());

const refusal = (open: () => unknown): GrpcError => {
  try {
    open();
  } catch (error) {
    if (error instanceof GrpcError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

describe('retry pushback', () => {
  it('sends grpc-retry-pushback-ms in the status trailers when the status carries one', () => {
    expect(statusTrailers(GrpcCode.RESOURCE_EXHAUSTED, 'busy', 1234.4)).toMatchObject({
      'grpc-status': String(GrpcCode.RESOURCE_EXHAUSTED),
      'grpc-retry-pushback-ms': '1234',
    });
    expect(statusTrailers(GrpcCode.RESOURCE_EXHAUSTED, 'busy')).not.toHaveProperty('grpc-retry-pushback-ms');
  });

  it('spreads handshake-bucket refusals over the time the bucket needs to admit them', async () => {
    f = await gatewayFixture({ handshakesPerSecond: 2 });
    const nodes = await Promise.all(Array.from({ length: 40 }, () => f!.addNode()));
    const pushbacks: number[] = [];
    for (const node of nodes) {
      try {
        f.gateway.open({ nodeId: node, role: 'node' }, new FakeStream());
      } catch (error) {
        if (!(error instanceof GrpcError)) throw error;
        expect(error.code).toBe(GrpcCode.RESOURCE_EXHAUSTED);
        pushbacks.push(error.retryAfterMs!);
      }
    }
    // Two admitted by the bucket; 38 refused, each told when to come back.
    expect(pushbacks.length).toBeGreaterThanOrEqual(36);
    for (const ms of pushbacks) expect(ms).toBeGreaterThanOrEqual(250);
    // The window grows with the herd: the last refusals may be told up to refused ÷ rate seconds.
    expect(Math.max(...pushbacks)).toBeGreaterThan(1_000);
    expect(Math.max(...pushbacks)).toBeLessThanOrEqual((pushbacks.length / 2) * 1000);
    // Jittered: not all the same.
    expect(new Set(pushbacks).size).toBeGreaterThan(pushbacks.length / 2);
  });

  it('tells a gateway at its stream limit to come back much later', async () => {
    f = await gatewayFixture({ maxStreams: 1 });
    const [a, b] = [await f.addNode(), await f.addNode()];
    await f.connect(a);
    const error = refusal(() => f!.gateway.open({ nodeId: b, role: 'node' }, new FakeStream()));
    expect(error.code).toBe(GrpcCode.RESOURCE_EXHAUSTED);
    expect(error.retryAfterMs).toBeGreaterThanOrEqual(5_000);
  });
});
