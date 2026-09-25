import { describe, expect, it } from 'vitest';
import { createDaemonHarness } from '@better-compute/testing';

// FakeDaemon and gRPC retry pushback (§8.6, gateway a54aae6): a refusal that says when to come back
// (`grpc-retry-pushback-ms`, carried as CloseInfo.retryAfterMs) is followed exactly, and the full-jitter doubling
// starts over, so a gateway spreads a power-on herd over the time its handshake bucket needs instead of every daemon
// backing off towards the 60 s cap.

describe('FakeDaemon retry pushback', () => {
  it('redials exactly when a refusal says, and starts its own back-off over afterwards', async () => {
    const h = createDaemonHarness({ nodeId: 'node_pushback', autoWelcome: false });
    await h.advance(0);
    expect(h.servers).toHaveLength(1);

    // Refused repeatedly without a hint: the doubling grows (the third wait can reach 4 s).
    for (let refusal = 0; refusal < 3; refusal++) {
      h.server.conn.close('RESOURCE_EXHAUSTED: gateway busy; retry with jitter');
      const before = h.servers.length;
      for (let waited = 0; h.servers.length === before && waited < 10_000; waited += 100)
        await h.advance(100);
      expect(h.servers.length).toBe(before + 1);
    }

    // Now the refusal carries a pushback: nothing before it, a dial right at it.
    h.server.conn.close('RESOURCE_EXHAUSTED: handshake rate exceeded', { retryAfterMs: 7_000 });
    const before = h.servers.length;
    await h.advance(6_900);
    expect(h.servers.length).toBe(before);
    await h.advance(200);
    expect(h.servers.length).toBe(before + 1);

    // The doubling started over: a plain refusal now waits at most the first step (1 s).
    h.server.conn.close('UNAVAILABLE: gateway draining');
    await h.advance(1_050);
    expect(h.servers.length).toBe(before + 2);
  });
});
