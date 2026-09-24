import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  canTransition,
  commandInFlightStates,
  commandStateTable,
  commandTerminalStates,
  connectivityTable,
  defineStateTable,
  exits,
  instanceStateTable,
  isComputeError,
  isTerminal,
  metalRecoverTargets,
  provisionFailableStates,
  provisionStateTable,
  recoverTarget,
  reservationQuotaStates,
  reservationStateTable,
  schedulableProvisionStates,
  stateTables,
  stepStateTable,
  targets,
  transition,
  workflowStateTable,
  type StateTable,
} from '@better-compute/core';

type AnyTable = StateTable<string, string>;
const tables = Object.entries(stateTables) as [string, AnyTable][];

function reachable(table: AnyTable, from: readonly string[]): Set<string> {
  const seen = new Set(from);
  const queue = [...from];
  while (queue.length) {
    const state = queue.shift()!;
    for (const { to } of exits(table, state))
      if (!seen.has(to)) {
        seen.add(to);
        queue.push(to);
      }
  }
  return seen;
}

function walk(table: AnyTable, start: string, steps: [string, string?][]): string {
  return steps.reduce<string>((state, [verb, to]) => transition(table, state, verb, to), start);
}

describe.each(tables)('%s state table', (_name, table) => {
  it('answers every (state, verb) pair exactly as declared', () => {
    for (const state of table.states)
      for (const verb of table.verbs) {
        const declared = table.transitions[state]?.[verb];
        const expected =
          declared === undefined ? [] : typeof declared === 'string' ? [declared] : declared;
        expect(targets(table, state, verb)).toEqual(expected);
        if (expected.length === 1) {
          expect(canTransition(table, state, verb)).toBe(true);
          expect(transition(table, state, verb)).toBe(expected[0]);
        } else {
          expect(canTransition(table, state, verb)).toBe(false);
          let error: unknown;
          try {
            transition(table, state, verb);
          } catch (caught) {
            error = caught;
          }
          expect(isComputeError(error, 'INVALID_STATE')).toBe(true);
          expect((error as { details?: unknown }).details).toMatchObject({ from: state, verb });
        }
        for (const to of table.states) {
          const legal = expected.includes(to);
          expect(canTransition(table, state, verb, to)).toBe(legal);
          if (legal) expect(transition(table, state, verb, to)).toBe(to);
          else expect(() => transition(table, state, verb, to)).toThrow(/cannot/);
        }
      }
  });

  it('rejects states and verbs it does not know', () => {
    expect(() => transition(table, 'no-such-state', table.verbs[0]!)).toThrow(/cannot/);
    expect(() => transition(table, table.states[0]!, 'constructor')).toThrow(/cannot/);
    expect(targets(table, '__proto__', 'toString')).toEqual([]);
  });

  it('has no exits from terminal states', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...(table.terminal.length ? table.terminal : ['__none__'])),
        fc.constantFrom(...table.verbs),
        (state, verb) => {
          if (state === '__none__') return;
          expect(isTerminal(table, state)).toBe(true);
          expect(targets(table, state, verb)).toEqual([]);
          expect(exits(table, state)).toEqual([]);
        },
      ),
    );
  });

  it('reaches every state from an initial state', () => {
    expect([...reachable(table, table.initial)].sort()).toEqual([...table.states].sort());
  });

  it('can reach a terminal state from every state, when it has any', () => {
    if (!table.terminal.length) return;
    for (const state of table.states) {
      const found = [...reachable(table, [state])].some((next) => table.terminal.includes(next));
      expect(found, `${state} cannot terminate`).toBe(true);
    }
  });

  it('stays inside its states on random walks; illegal verbs throw INVALID_STATE', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...table.initial),
        fc.array(fc.tuple(fc.constantFrom(...table.verbs), fc.constantFrom(...table.states)), {
          maxLength: 40,
        }),
        (start, moves) => {
          let state = start;
          for (const [verb, pick] of moves) {
            const next = targets(table, state, verb);
            if (!next.length) {
              expect(() => transition(table, state, verb)).toThrow(/cannot/);
              continue;
            }
            const to = next.includes(pick) ? pick : next[0]!;
            state = transition(table, state, verb, to);
            expect(table.states).toContain(state);
          }
        },
      ),
    );
  });
});

describe('provision (metal) states', () => {
  const t = provisionStateTable;

  it('covers the §11.1 lifecycle', () => {
    expect(t.states).toEqual([
      'adopting',
      'adopted',
      'enrolling',
      'inspecting',
      'commissioning',
      'ready',
      'deploying',
      'deployed',
      'releasing',
      'rescue',
      'failed',
      'retiring',
      'retired',
    ]);
    expect(t.initial).toEqual(['adopting', 'enrolling']);
    expect(t.terminal).toEqual(['retired']);
    expect(
      walk(t, 'adopting', [['complete'], ['adopt'], ['complete'], ['release'], ['complete']]),
    ).toBe('ready');
    expect(
      walk(t, 'enrolling', [
        ['complete'],
        ['complete'],
        ['complete'],
        ['deploy'],
        ['complete'],
        ['rescue'],
        ['unrescue'],
        ['release'],
        ['complete'],
        ['retire'],
        ['complete'],
      ]),
    ).toBe('retired');
    expect(canTransition(t, 'deployed', 'retire')).toBe(false);
  });

  it('enters ready only after commissioning or a completed release (the wipe)', () => {
    const entries: string[] = [];
    for (const state of t.states)
      for (const verb of t.verbs)
        if (targets(t, state, verb).includes('ready')) entries.push(`${state}:${verb}`);
    expect(entries.sort()).toEqual(['commissioning:complete', 'releasing:complete']);
  });

  it('fails into failed from exactly the failable states, and recovers per metalRecoverTargets', () => {
    const failing = t.states.filter((state) => targets(t, state, 'fail').includes('failed'));
    expect(failing.sort()).toEqual([...provisionFailableStates].sort());
    for (const state of t.states)
      if (canTransition(t, state, 'abort')) expect(provisionFailableStates).toContain(state);
    expect(new Set(targets(t, 'failed', 'recover'))).toEqual(
      new Set(Object.values(metalRecoverTargets)),
    );
    for (const failedFrom of provisionFailableStates) {
      const to = recoverTarget(failedFrom);
      expect(transition(t, 'failed', 'recover', to)).toBe(to);
      expect(to).not.toBe('ready');
    }
    expect(recoverTarget('deploying')).toBe('releasing');
    expect(() => transition(t, 'failed', 'recover')).toThrow(/cannot recover from failed/);
    expect(transition(t, 'failed', 'retire')).toBe('retiring');
  });

  it('schedules only adopted and deployed nodes', () => {
    expect(schedulableProvisionStates).toEqual(['adopted', 'deployed']);
  });
});

describe('connectivity', () => {
  const t = connectivityTable;
  it('only escalates through disconnected → unreachable → lost, and reconnects from anywhere', () => {
    expect(t.terminal).toEqual([]);
    expect(t.initial).toEqual(['disconnected']);
    for (const state of t.states) expect(transition(t, state, 'connect')).toBe('connected');
    const into = (target: (typeof t.states)[number]) =>
      t.states.filter((state) =>
        t.verbs.some((verb) => state !== target && targets(t, state, verb).includes(target)),
      );
    expect(into('unreachable')).toEqual(['disconnected']);
    expect(into('lost')).toEqual(['unreachable']);
    expect(canTransition(t, 'connected', 'timeout')).toBe(false);
  });
});

describe('reservation states (§10.5)', () => {
  const t = reservationStateTable;

  it('follows the diagram', () => {
    expect(t.initial).toEqual(['draft']);
    expect([...t.terminal].sort()).toEqual([
      'cancelled',
      'denied',
      'expired',
      'failed',
      'released',
    ]);
    expect(
      walk(t, 'draft', [
        ['place'],
        ['start'],
        ['bind'],
        ['extend'],
        ['renew'],
        ['release'],
        ['complete'],
      ]),
    ).toBe('released');
    expect(transition(t, 'draft', 'deny')).toBe('denied');
    expect(walk(t, 'draft', [['defer'], ['place']])).toBe('placed');
    expect(walk(t, 'draft', [['defer'], ['fail']])).toBe('failed');
    expect(walk(t, 'draft', [['awaitConfirmation'], ['retry'], ['place']])).toBe('placed');
    expect(walk(t, 'draft', [['awaitConfirmation'], ['expire']])).toBe('expired');
    expect(walk(t, 'draft', [['place'], ['start'], ['defer']])).toBe('pending');
    expect(walk(t, 'draft', [['place'], ['start'], ['fail']])).toBe('failed');
    expect(walk(t, 'draft', [['place'], ['cancel']])).toBe('cancelled');
    expect(canTransition(t, 'active', 'cancel')).toBe(false);
    expect(canTransition(t, 'active', 'defer')).toBe(false);
  });

  it('keeps the state on extend and renew', () => {
    for (const state of t.states)
      for (const verb of ['extend', 'renew'] as const) {
        const next = targets(t, state, verb);
        if (next.length) expect(next).toEqual([state]);
      }
    expect(t.states.filter((state) => canTransition(t, state, 'extend'))).toEqual([
      'placed',
      'binding',
      'active',
    ]);
  });

  it('counts every non-terminal, admitted state against quota', () => {
    for (const state of reservationQuotaStates) expect(isTerminal(t, state)).toBe(false);
    expect(reservationQuotaStates).not.toContain('draft');
  });
});

describe('command states (§7.4)', () => {
  const t = commandStateTable;

  it('follows pending → dispatched → acked → running → terminal', () => {
    expect(walk(t, 'pending', [['dispatch'], ['ack'], ['start'], ['succeed']])).toBe('succeeded');
    expect(
      walk(t, 'pending', [['dispatch'], ['busy'], ['dispatch'], ['dispatch'], ['reject']]),
    ).toBe('rejected');
    expect(walk(t, 'pending', [['dispatch'], ['succeed']])).toBe('succeeded');
    expect(transition(t, 'pending', 'expire')).toBe('expired');
    expect([...commandTerminalStates].sort()).toEqual([
      'cancelled',
      'expired',
      'failed',
      'rejected',
      'succeeded',
    ]);
    expect(new Set(t.terminal)).toEqual(commandTerminalStates);
  });

  it('rejects only before acceptance, expires only while pending, and returns to pending only on BUSY', () => {
    const from = (verb: string) => t.states.filter((state) => canTransition(t, state, verb));
    expect(from('reject')).toEqual(['dispatched']);
    expect(from('expire')).toEqual(['pending']);
    expect(from('busy')).toEqual(['dispatched']);
    for (const state of commandInFlightStates) {
      expect(transition(t, state, 'fail')).toBe('failed');
      expect(isTerminal(t, state)).toBe(false);
    }
  });
});

describe('instance states (§11.1)', () => {
  const t = instanceStateTable;
  it('converges pending → running ⇄ stopped → deleted', () => {
    expect(
      walk(t, 'pending', [
        ['schedule'],
        ['complete'],
        ['complete'],
        ['complete'],
        ['stop'],
        ['start'],
        ['complete'],
      ]),
    ).toBe('running');
    expect(walk(t, 'running', [['resize'], ['complete', 'stopped']])).toBe('stopped');
    expect(walk(t, 'running', [['lose'], ['recreate']])).toBe('scheduling');
    expect(walk(t, 'error', [['delete'], ['complete']])).toBe('deleted');
    expect(t.terminal).toEqual(['deleted']);
    expect(() => transition(t, 'resizing', 'complete')).toThrow(/cannot complete from resizing/);
  });
});

describe('workflow and step states (§11.2)', () => {
  it('pauses, resumes, retries and cancels workflows', () => {
    const t = workflowStateTable;
    expect(
      walk(t, 'pending', [['start'], ['pause'], ['resume'], ['fail'], ['retry'], ['complete']]),
    ).toBe('succeeded');
    expect(walk(t, 'pending', [['start'], ['fail'], ['cancel']])).toBe('cancelled');
  });

  it('parks steps on commands and rejoin, and retries failed ones', () => {
    const t = stepStateTable;
    expect(
      walk(t, 'pending', [['start'], ['wait'], ['fail'], ['retry'], ['start'], ['complete']]),
    ).toBe('succeeded');
    expect(transition(t, 'pending', 'skip')).toBe('skipped');
    expect(canTransition(t, 'succeeded', 'retry')).toBe(false);
  });
});

describe('defineStateTable', () => {
  const base = {
    name: 'probe',
    states: ['a', 'b'] as const,
    verbs: ['go'] as const,
    initial: ['a'] as const,
    terminal: ['b'] as const,
  };

  it('accepts a well-formed table and freezes it', () => {
    const table = defineStateTable({ ...base, transitions: { a: { go: 'b' }, b: {} } });
    expect(Object.isFrozen(table)).toBe(true);
    expect(transition(table, 'a', 'go')).toBe('b');
  });

  it('rejects malformed tables with INVALID_CONFIG', () => {
    const attempts: (() => unknown)[] = [
      () => defineStateTable({ ...base, transitions: { a: { go: 'c' as 'b' }, b: {} } }),
      () => defineStateTable({ ...base, transitions: { a: { go: 'b' }, b: { go: 'a' } } }),
      () => defineStateTable({ ...base, transitions: { a: { go: 'b' } } as never }),
      () =>
        defineStateTable({
          ...base,
          states: ['a', 'a', 'b'] as never,
          transitions: { a: {}, b: {} },
        }),
      () => defineStateTable({ ...base, transitions: { a: { stay: 'a' } as never, b: {} } }),
      () => defineStateTable({ ...base, transitions: { a: { go: [] }, b: {} } }),
    ];
    for (const attempt of attempts) {
      let error: unknown;
      try {
        attempt();
      } catch (caught) {
        error = caught;
      }
      expect(isComputeError(error, 'INVALID_CONFIG')).toBe(true);
    }
  });
});
