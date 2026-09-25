import { describe, expect, it } from 'vitest';
import {
  ALLOWED_RELEASE_REASONS,
  assertInvariants,
  atomMilliseconds,
  checkI1,
  checkI2,
  checkI3,
  checkI4,
  checkI5,
  checkI8,
  type ExecutionFact,
} from '@better-compute/testing';

// The fleet invariants of PLAN.md §15 as pure functions over collected facts.

describe('I1: no overlapping bookings or node-reported assignments', () => {
  it('accepts back-to-back bookings and flags overlapping ones per device', () => {
    const ok = [
      { allocationId: 'a', deviceId: 'GPU-1', start: 0, end: 10 },
      { allocationId: 'b', deviceId: 'GPU-1', start: 10, end: 20 },
      { allocationId: 'c', deviceId: 'GPU-2', start: 5, end: Infinity },
    ];
    expect(checkI1({ bookings: ok })).toEqual([]);
    const bad = [
      ...ok,
      { allocationId: 'd', deviceId: 'GPU-1', start: 15, end: 16 },
      { allocationId: 'e', deviceId: 'GPU-2', start: 100, end: 101 },
    ];
    expect(checkI1({ bookings: bad }).map((v) => v.subject)).toEqual(['d', 'e']);
    // An empty range overlaps nothing.
    expect(
      checkI1({ bookings: [...ok, { allocationId: 'z', deviceId: 'GPU-1', start: 5, end: 5 }] }),
    ).toEqual([]);
  });

  it('flags a node holding one device for two allocations, and bindings without a booking', () => {
    const bookings = [
      { allocationId: 'a', deviceId: 'GPU-1', start: 0, end: 10 },
      { allocationId: 'b', deviceId: 'GPU-1', start: 10, end: 20 },
    ];
    const clean = [
      { nodeId: 'n', allocationId: 'a', deviceIds: ['GPU-1'], from: 1, to: 12 },
      { nodeId: 'm', allocationId: 'b', deviceIds: ['GPU-1'], from: 11 },
    ];
    // Different nodes' GPU-1s are different devices; late release on the node is not an overlap in itself.
    expect(checkI1({ bookings, bindings: clean })).toEqual([]);
    const overlapping = [
      ...clean,
      { nodeId: 'n', allocationId: 'b', deviceIds: ['GPU-1'], from: 11 },
    ];
    expect(checkI1({ bindings: overlapping })).toEqual([
      expect.objectContaining({
        invariant: 'I1',
        subject: 'b',
        message: expect.stringMatching(/bound to a and b/),
      }),
    ]);
    const stray = [{ nodeId: 'n', allocationId: 'a', deviceIds: ['GPU-1', 'GPU-9'], from: 1 }];
    expect(checkI1({ bookings, bindings: stray })[0]?.message).toMatch(/GPU-9 .* no booking/);
  });
});

const fact = (over: Partial<ExecutionFact>): ExecutionFact => ({
  phase: 'started',
  at: 0,
  nodeId: 'n',
  commandId: 'cmd',
  kind: 'gpu.reset',
  retrySafe: false,
  selfTerminating: false,
  journalId: 'j1',
  incarnation: 'i1',
  bootId: 'b1',
  ...over,
});

describe('I2: at most one execution per command', () => {
  it('allows one execution of a non-retry-safe command and flags a second', () => {
    const once = [fact({ phase: 'accepted' }), fact({ at: 1 }), fact({ phase: 'ended', at: 2 })];
    expect(checkI2({ executions: once })).toEqual([]);
    const twice = [...once, fact({ at: 5, incarnation: 'i2' })];
    expect(checkI2({ executions: twice })[0]?.message).toMatch(/not retry-safe\) started 2 times/);
    const reboot = [
      fact({ kind: 'node.reboot', retrySafe: true, selfTerminating: true }),
      fact({ at: 9, retrySafe: true, selfTerminating: true, incarnation: 'i2' }),
    ];
    expect(checkI2({ executions: reboot })[0]?.message).toMatch(/self-terminating/);
  });

  it('lets a retry-safe command re-run only after a crash interrupted it', () => {
    const retry = (over: Partial<ExecutionFact>) =>
      fact({ retrySafe: true, kind: 'diag.nvml', ...over });
    const interrupted = [
      retry({ at: 1 }),
      retry({ at: 5, incarnation: 'i2' }),
      retry({ phase: 'ended', at: 6, incarnation: 'i2' }),
    ];
    expect(checkI2({ executions: interrupted })).toEqual([]);
    const sameProcess = [retry({ at: 1 }), retry({ at: 2 })];
    expect(checkI2({ executions: sameProcess })[0]?.message).toMatch(/twice in daemon process i1/);
    const afterEnd = [
      retry({ at: 1 }),
      retry({ phase: 'ended', at: 2 }),
      retry({ at: 3, incarnation: 'i2' }),
    ];
    expect(checkI2({ executions: afterEnd })[0]?.message).toMatch(/ran again .* after it ended/);
    // A new journal may run a retry-safe command again (the journal that knew it is gone).
    const newJournal = [
      retry({ at: 1 }),
      retry({ phase: 'ended', at: 2 }),
      retry({ at: 3, incarnation: 'i2', journalId: 'j2' }),
    ];
    expect(checkI2({ executions: newJournal })).toEqual([]);
  });

  it('after a journal loss, a non-retry-safe command in flight must not replay nor end succeeded', () => {
    const loss = { nodeId: 'n', at: 10, oldJournalId: 'j1', newJournalId: 'j2' };
    const accepted = fact({ phase: 'accepted', at: 1 });
    expect(
      checkI2({
        executions: [accepted],
        journalLosses: [loss],
        outcomes: [{ commandId: 'cmd', nodeId: 'n', state: 'failed', errorCode: 'journal-lost' }],
      }),
    ).toEqual([]);
    const replayed = [accepted, fact({ at: 20, journalId: 'j2', incarnation: 'i2' })];
    expect(checkI2({ executions: replayed, journalLosses: [loss] })[0]?.message).toMatch(
      /replayed in j2/,
    );
    const lied = checkI2({
      executions: [accepted],
      journalLosses: [loss],
      outcomes: [{ commandId: 'cmd', nodeId: 'n', state: 'succeeded' }],
    });
    expect(lied[0]?.message).toMatch(/recorded it succeeded/);
    // Ended before the loss: nothing was in flight.
    expect(
      checkI2({
        executions: [accepted, fact({ phase: 'ended', at: 5 })],
        journalLosses: [loss],
        outcomes: [{ commandId: 'cmd', nodeId: 'n', state: 'succeeded' }],
      }),
    ).toEqual([]);
  });
});

describe('I5: no allocation released only because a node disconnected', () => {
  it('accepts the allowed causes whatever the connectivity, and names connectivity-driven releases', () => {
    expect(ALLOWED_RELEASE_REASONS).toEqual([
      'ends-at',
      'release',
      'cancel',
      'lease-lapse',
      'bind-failed',
    ]);
    const connectivity = [
      { nodeId: 'n', at: 0, state: 'connected' as const },
      { nodeId: 'n', at: 10, state: 'disconnected' as const },
      { nodeId: 'n', at: 70, state: 'unreachable' as const },
    ];
    expect(
      checkI5({
        releases: [{ allocationId: 'a', nodeId: 'n', at: 80, reason: 'ends-at' }],
        connectivity,
      }),
    ).toEqual([]);
    const violations = checkI5({
      releases: [
        { allocationId: 'a', nodeId: 'n', at: 10, reason: 'node-disconnected' },
        { allocationId: 'b', nodeId: 'n', at: 80, reason: 'reaped' },
        { allocationId: 'c', nodeId: 'n', at: 5, reason: 'mystery' },
      ],
      connectivity,
    });
    expect(violations.map((v) => v.message)).toEqual([
      'a was released (node-disconnected) while node n was disconnected',
      'b was released (reaped) while node n was unreachable',
      'c was released for a cause that is not allowed: mystery',
    ]);
  });
});

describe('I3: convergence within T', () => {
  const heardEvery = (from: number, to: number, step = 10_000) =>
    Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step);

  it('flags a reachable node that never reports a delivered spec, and skips the rest', () => {
    const heard = new Map([
      ['n1', heardEvery(0, 200_000)],
      ['n2', heardEvery(0, 200_000)],
      // n3 fell silent at 30 s: it cannot be judged.
      ['n3', heardEvery(0, 30_000)],
    ]);
    const violations = checkI3({
      heard,
      until: 200_000,
      specsDelivered: [
        { nodeId: 'n1', generation: 2, at: 10_000 },
        { nodeId: 'n1', generation: 3, at: 50_000 },
        { nodeId: 'n2', generation: 5, at: 20_000 },
        { nodeId: 'n3', generation: 2, at: 20_000 },
        // Too recent to judge.
        { nodeId: 'n2', generation: 6, at: 180_000 },
      ],
      observed: new Map([
        // n1 reported 2 in time, and 3 only after the 60 s bound.
        [
          'n1',
          [
            { generation: 2, at: 12_000 },
            { generation: 3, at: 115_000 },
          ],
        ],
        // n2 skipped straight to 5.
        ['n2', [{ generation: 5, at: 70_000 }]],
      ]),
    });
    expect(violations.map((v) => [v.invariant, v.subject])).toEqual([['I3', 'n1']]);
    expect(violations[0]!.message).toMatch(/generation 3/);
  });
});

describe('I4: no liveness false positives', () => {
  it('flags an unreachable or lost mark shortly after a gateway heard the node, and nothing else', () => {
    const heard = new Map([
      ['n1', [1_000, 11_000, 21_000]],
      ['n2', [1_000]],
      ['n3', [50_000]],
    ]);
    const violations = checkI4({
      heard,
      connectivity: [
        // n1 was heard 4 s before being marked: a false positive.
        { nodeId: 'n1', at: 25_000, state: 'unreachable' },
        // n2 went quiet at 1 s; marked 60 s later: a true positive.
        { nodeId: 'n2', at: 61_000, state: 'unreachable' },
        // n3 is heard only after the mark (it came back): not a false positive.
        { nodeId: 'n3', at: 40_000, state: 'lost' },
        // Connected/disconnected transitions are not liveness verdicts.
        { nodeId: 'n1', at: 21_500, state: 'disconnected' },
        // A node never heard from cannot be a false positive.
        { nodeId: 'n4', at: 5_000, state: 'unreachable' },
      ],
    });
    expect(violations.map((v) => [v.invariant, v.subject])).toEqual([['I4', 'n1']]);
    expect(violations[0]!.message).toMatch(/4000 ms after a gateway heard/);
    expect(
      checkI4({
        heard,
        connectivity: [{ nodeId: 'n1', at: 25_000, state: 'unreachable' }],
        windowMs: 3_000,
      }),
    ).toEqual([]);
  });
});

describe('I8: billing conservation', () => {
  const allocations = [
    { allocationId: 'a', start: 0, end: 100, atoms: 2 },
    { allocationId: 'b', start: 50, atoms: 1 },
  ];
  const usage = [
    { key: 'a:0', allocationId: 'a', start: 0, end: 60, atoms: 2 },
    { key: 'a:60', allocationId: 'a', start: 60, end: 100, atoms: 2 },
    { key: 'b:50', allocationId: 'b', start: 50, end: 90, atoms: 1 },
  ];

  it('holds when windows tile each booking exactly', () => {
    expect(atomMilliseconds(usage)).toBe(240);
    expect(checkI8({ allocations, usage })).toEqual([]);
    expect(checkI8({ allocations, usage, flushedUpTo: 90 })).toEqual([]);
    expect(checkI8({ allocations, usage, flushedUpTo: 95 })[0]?.message).toMatch(
      /b billed 40 atom-ms but booked 45/,
    );
  });

  it('flags duplicate keys, gaps, overlaps and usage for unknown allocations', () => {
    const messages = checkI8({
      allocations,
      usage: [
        ...usage.slice(0, 2),
        { key: 'a:0', allocationId: 'a', start: 0, end: 60, atoms: 2 },
        { key: 'x:0', allocationId: 'x', start: 0, end: 1, atoms: 1 },
      ],
    }).map((v) => v.message);
    expect(messages).toEqual([
      'duplicate usage key a:0',
      'usage recorded for unknown allocation x',
      expect.stringMatching(/usage window a:0 .* overlaps or leaves booking/),
      'a billed 320 atom-ms but booked 200 atom-ms up to 100',
    ]);
    const gap = checkI8({ allocations: [allocations[0]!], usage: [usage[0]!] });
    expect(gap.map((v) => v.message)).toEqual([
      'a billed 120 atom-ms but booked 200 atom-ms up to 100',
    ]);
  });
});

describe('assertInvariants', () => {
  it('throws one error listing the violations, and nothing when there are none', () => {
    expect(() => assertInvariants([])).not.toThrow();
    const many = Array.from({ length: 25 }, (_, i) => ({
      invariant: 'I2' as const,
      subject: `c${i}`,
      message: 'twice',
    }));
    expect(() => assertInvariants(many)).toThrow(
      /25 invariant violation\(s\):\nI2 c0: twice[\s\S]*and 5 more/,
    );
  });
});
