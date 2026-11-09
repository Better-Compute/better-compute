import { describe, expect, it } from 'vitest';
import {
  check,
  ConformanceSkip,
  isConformanceSkip,
  runConformance,
  skip,
  type ConformanceCase,
} from '@better-compute/core/conformance';

// The skipped outcome of the conformance runner: a case that does not apply to its subject checked
// nothing, so it is reported apart from the cases that passed.

interface Subject {
  volumes?: boolean;
}

const cases: ConformanceCase<Subject>[] = [
  { name: 'always', run: async () => check(true, 'holds') },
  {
    name: 'returns a skip',
    run: async (subject) => {
      if (!subject.volumes) return skip('the provider has no volumes');
      check(true, 'volumes hold');
    },
  },
  {
    name: 'throws a skip',
    run: async (subject) => {
      if (!subject.volumes) throw skip('nothing to attach to');
    },
  },
  { name: 'fails', run: async () => check(false, 'never holds') },
];

describe('conformance runner: skipped cases', () => {
  it('reports a returned or thrown skip under skipped, with its reason, and not under passed', async () => {
    const report = await runConformance(cases, {});
    expect(report.passed).toEqual(['always']);
    expect(report.skipped).toEqual([
      { name: 'returns a skip', reason: 'the provider has no volumes' },
      { name: 'throws a skip', reason: 'nothing to attach to' },
    ]);
    expect(report.failed.map((entry) => entry.name)).toEqual(['fails']);
  });

  it('a case that applies passes as before, and every case is disposed whatever its outcome', async () => {
    let disposed = 0;
    const report = await runConformance(cases, () => ({ volumes: true }), {
      dispose: () => void disposed++,
    });
    expect(report.passed).toEqual(['always', 'returns a skip', 'throws a skip']);
    expect(report.skipped).toEqual([]);
    expect(disposed).toBe(4);
  });

  it('a skip is recognized by its shape, and only a skip is one', () => {
    const made = skip('why');
    expect(made).toBeInstanceOf(ConformanceSkip);
    expect(made.reason).toBe('why');
    expect(isConformanceSkip(made)).toBe(true);
    // One made by another copy of the module (a second install of core) still counts.
    const foreign = Object.assign(new Error('skipped: why'), {
      name: 'ConformanceSkip',
      reason: 'why',
    });
    expect(isConformanceSkip(foreign)).toBe(true);
    for (const other of [undefined, null, 'skip', new Error('skipped'), { reason: 'why' }])
      expect(isConformanceSkip(other)).toBe(false);
  });
});
