import { describe, expect, it } from 'vitest';
import { manualClock } from '@better-compute/core';
import { createExecTicketIssuer, createReplayCache, verifyExecTicket } from '@better-compute/pki';

// Exec ticket claims for delegated callers (agt / dlg), and the fail-closed jti set single-use
// tickets rely on when it fills up.

const NODE = 'node_01jz00000000000000000000na';

describe('exec ticket agent claims', () => {
  it('carries agt and dlg only when given', () => {
    const clock = manualClock(Date.UTC(2026, 8, 24));
    const issuer = createExecTicketIssuer({ issuer: 'https://compute.test', clock });
    const verify = (token: string) =>
      verifyExecTicket(token, {
        jwks: issuer.jwksJson(),
        nodeId: NODE,
        now: clock.now(),
        jtiCache: createReplayCache(),
      });
    const delegated = issuer.issue({
      nodeId: NODE,
      sid: 'tun_1',
      op: 'exec',
      subject: 'usr_a',
      agentId: 'agt_1',
      delegationId: 'dlg_1',
    });
    expect(verify(delegated.token)).toMatchObject({ sub: 'usr_a', agt: 'agt_1', dlg: 'dlg_1' });
    const own = verify(
      issuer.issue({ nodeId: NODE, sid: 'tun_2', op: 'exec', subject: 'usr_a' }).token,
    );
    expect(own).not.toHaveProperty('agt');
    expect(own).not.toHaveProperty('dlg');
  });
});

describe('exec ticket sandbox claim', () => {
  const SANDBOX = 'sbx_01jz0000000000000000000000';
  it('carries sbx with its instance, and never alone', () => {
    const clock = manualClock(Date.UTC(2026, 8, 24));
    const issuer = createExecTicketIssuer({ issuer: 'https://compute.test', clock });
    const verify = (token: string) =>
      verifyExecTicket(token, {
        jwks: issuer.jwksJson(),
        nodeId: NODE,
        now: clock.now(),
        jtiCache: createReplayCache(),
      });
    const base = { nodeId: NODE, op: 'ssh' as const, subject: 'usr_a' };
    const ticket = issuer.issue({
      ...base,
      sid: 'tun_1',
      instanceId: 'inst_01jz0000000000000000000000',
      sandboxId: SANDBOX,
      action: 'compute:sandboxes:exec',
    });
    expect(verify(ticket.token)).toMatchObject({
      sbx: SANDBOX,
      inst: 'inst_01jz0000000000000000000000',
      act: 'compute:sandboxes:exec',
    });
    expect(verify(issuer.issue({ ...base, sid: 'tun_2' }).token)).not.toHaveProperty('sbx');
    expect(() => issuer.issue({ ...base, sid: 'tun_3', sandboxId: SANDBOX })).toThrow(/instance/);
    expect(() =>
      issuer.issue({
        ...base,
        sid: 'tun_4',
        instanceId: 'inst_01jz0000000000000000000000',
        sandboxId: 'inst_01jz0000000000000000000000',
      }),
    ).toThrow(/sandbox id/);
  });
});

describe('replay cache when full', () => {
  it('evicts the oldest live entry by default (that key becomes replayable)', () => {
    const cache = createReplayCache({ maxEntries: 2 });
    expect(cache.add('a', 1000, 0)).toBe(true);
    expect(cache.add('b', 1000, 0)).toBe(true);
    expect(cache.add('c', 1000, 0)).toBe(true);
    expect(cache.add('a', 1000, 1)).toBe(true);
  });

  it('refuses new keys while full of live entries, and recovers as they expire', () => {
    const cache = createReplayCache({ maxEntries: 2, whenFull: 'refuse' });
    expect(cache.add('a', 1000, 0)).toBe(true);
    expect(cache.add('b', 500, 0)).toBe(true);
    // Full of live entries: fail closed, and never forget a live one.
    expect(cache.add('c', 1000, 10)).toBe(false);
    expect(cache.add('a', 1000, 10)).toBe(false);
    expect(cache.size).toBe(2);
    // 'b' expired: room again (expired entries are purged even out of insertion order).
    expect(cache.add('c', 1000, 600)).toBe(true);
    expect(cache.add('a', 1000, 600)).toBe(false);
    expect(cache.size).toBe(2);
  });

  it('fails a ticket closed when the daemon’s jti set is full', () => {
    const clock = manualClock(Date.UTC(2026, 8, 24));
    const issuer = createExecTicketIssuer({ issuer: 'https://compute.test', clock });
    const jtiCache = createReplayCache({ maxEntries: 1, whenFull: 'refuse' });
    const verify = (sid: string) =>
      verifyExecTicket(issuer.issue({ nodeId: NODE, sid, op: 'exec', subject: 'usr_a' }).token, {
        jwks: issuer.jwksJson(),
        nodeId: NODE,
        now: clock.now(),
        jtiCache,
      });
    expect(verify('tun_1').sid).toBe('tun_1');
    expect(() => verify('tun_2')).toThrow(/rejected/);
  });
});
