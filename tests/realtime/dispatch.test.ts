import { afterEach, describe, expect, it } from 'vitest';
import { create } from '@bufbuild/protobuf';
import { GrpcCode } from '@better-compute/gateway';
import { JoinRequestSchema } from '@better-compute/protocol';
import {
  createH2cClient,
  createRealtimeHarness,
  isRetryable,
  summarize,
  type RealtimeHarness,
} from '@better-compute/testing';

// The real-time harness (PLAN.md §15): a real gateway over h2c, a real database and FakeDaemons on the wall
// clock. The default run is small enough for CI; the 1k acceptance run lives behind `pnpm bench:scale`.

let harness: RealtimeHarness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('summarize', () => {
  it('reports nearest-rank percentiles', () => {
    const samples = Array.from({ length: 100 }, (_, i) => 100 - i);
    expect(summarize(samples)).toEqual({ count: 100, p50: 50, p90: 90, p99: 99, max: 100 });
    expect(summarize([])).toEqual({ count: 0, p50: 0, p90: 0, p99: 0, max: 0 });
  });

  it('treats RESOURCE_EXHAUSTED and UNAVAILABLE as retryable', () => {
    expect(isRetryable({ code: GrpcCode.RESOURCE_EXHAUSTED, message: '' })).toBe(true);
    expect(isRetryable({ code: GrpcCode.UNAVAILABLE, message: '' })).toBe(true);
    expect(isRetryable({ code: GrpcCode.PERMISSION_DENIED, message: '' })).toBe(false);
    expect(isRetryable(undefined)).toBe(false);
  });
});

describe('real-time harness', () => {
  it('connects every daemon over h2c and times dispatch → CommandUpdate', async () => {
    harness = await createRealtimeHarness({ nodes: 20 });
    const { elapsedMs } = await harness.connectAll(20_000);
    expect(harness.gateway.sessions()).toHaveLength(20);
    expect(elapsedMs).toBeLessThan(20_000);

    const result = await harness.dispatch({ kind: 'diag.nvml', timeoutMs: 20_000 });
    expect(result.failed).toEqual([]);
    expect(result.firstUpdate.count).toBe(20);
    expect(result.terminal.count).toBe(20);
    // Acknowledgement is a round trip on a local socket; completion includes the fake's work time.
    expect(result.firstUpdate.p99).toBeLessThan(2_000);
    expect(result.terminal.p50).toBeGreaterThanOrEqual(result.firstUpdate.p50);

    const text = harness.metrics.expose();
    expect(text).toContain('rt_command_ack_seconds_count{kind="diag.nvml"} 20');
    expect(text).toContain('rt_connect_seconds_count 20');
  }, 60_000);

  it('multiplexes every daemon on one connection when asked', async () => {
    harness = await createRealtimeHarness({ nodes: 5, sharedConnection: true });
    await harness.connectAll(10_000);
    expect(harness.client.connection).toBeDefined();
    const result = await harness.dispatch({ kind: 'diag.nvml', perNode: 2, timeoutMs: 20_000 });
    expect(result.failed).toEqual([]);
    expect(result.terminal.count).toBe(10);
  }, 60_000);

  it('rides out a reconnect storm: every dropped or crashed daemon gets a new session', async () => {
    harness = await createRealtimeHarness({ nodes: 20 });
    await harness.connectAll(20_000);
    const dropped = await harness.storm({ mode: 'disconnect', timeoutMs: 20_000 });
    expect(dropped).toMatchObject({ nodes: 20, missing: [] });
    expect(dropped.reconnect.count).toBe(20);
    const crashed = await harness.storm({ mode: 'crash', fraction: 0.25, timeoutMs: 20_000 });
    expect(crashed).toMatchObject({ nodes: 5, missing: [] });
    expect(harness.gateway.sessions()).toHaveLength(20);
    // The fleet still takes work after the storm.
    const result = await harness.dispatch({ kind: 'diag.nvml', timeoutMs: 20_000 });
    expect(result.failed).toEqual([]);
    expect(harness.metrics.expose()).toContain('rt_reconnect_seconds_count{mode="crash"} 5');
  }, 90_000);

  it('refuses Join with a gRPC status until the JoinService is wired', async () => {
    harness = await createRealtimeHarness({ nodes: 1 });
    const client = createH2cClient({ url: `http://127.0.0.1:${harness.served.port}` });
    try {
      await expect(client.join(create(JoinRequestSchema, {}))).rejects.toMatchObject({
        code: expect.any(Number),
      });
    } finally {
      await client.close();
    }
  }, 30_000);
});
