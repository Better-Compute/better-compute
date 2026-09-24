import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  assertMigrations,
  formatDuration,
  isComputeError,
  isMigrationName,
  manualClock,
  parseDuration,
  systemClock,
  type Migration,
} from '@better-compute/core';
import {
  ConformanceFailure,
  check,
  checkEqual,
  checkRejects,
  runConformance,
  type ConformanceCase,
} from '@better-compute/core/conformance';
import { ComputeError } from '@better-compute/core';

function code(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return isComputeError(error) ? error.code : 'other';
  }
  return undefined;
}

describe('durations', () => {
  it('parses units and sums', () => {
    expect(parseDuration('90s')).toBe(90_000);
    expect(parseDuration('30m')).toBe(1_800_000);
    expect(parseDuration('8h')).toBe(28_800_000);
    expect(parseDuration('1d')).toBe(86_400_000);
    expect(parseDuration('250ms')).toBe(250);
    expect(parseDuration('1h30m')).toBe(5_400_000);
    expect(parseDuration('1.5h')).toBe(5_400_000);
    expect(parseDuration('0s')).toBe(0);
    expect(parseDuration(1234)).toBe(1234);
  });

  it('rejects anything else with INVALID_INPUT', () => {
    for (const value of ['', '8', 'h', '-1h', '1 h', '1H', '1w', '1h30', 'soon', '1e3s', ' 1h'])
      expect(
        code(() => parseDuration(value)),
        value,
      ).toBe('INVALID_INPUT');
    for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(code(() => parseDuration(value))).toBe('INVALID_INPUT');
    expect(code(() => formatDuration(-1))).toBe('INVALID_INPUT');
  });

  it('formats as the shortest sum and round-trips', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(5_400_000)).toBe('1h30m');
    expect(formatDuration(90_061_001)).toBe('1d1h1m1s1ms');
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10 ** 12 }), (ms) => {
        expect(parseDuration(formatDuration(ms))).toBe(ms);
      }),
    );
  });
});

describe('clocks', () => {
  it('moves a manual clock only forward, on request', () => {
    const clock = manualClock(1000);
    expect(clock.now()).toBe(1000);
    expect(clock.advance(500)).toBe(1500);
    clock.set(2000);
    expect(clock.now()).toBe(2000);
    expect(code(() => clock.set(1999))).toBe('INVALID_INPUT');
    expect(code(() => clock.advance(-1))).toBe('INVALID_INPUT');
    expect(code(() => manualClock(-5))).toBe('INVALID_INPUT');
    expect(manualClock().now()).toBe(0);
    expect(Math.abs(systemClock.now() - Date.now())).toBeLessThan(1000);
  });
});

describe('migrations', () => {
  const sql = 'SELECT 1';
  it('names follow <owner>/<nnnn>_<slug>', () => {
    for (const name of ['core/0001_init', 'capacity/0002_bookings', 'acme-autoinstall/0001_isos'])
      expect(isMigrationName(name)).toBe(true);
    for (const name of [
      'core/1_init',
      'Core/0001_init',
      'core/0001',
      'core0001_init',
      '/0001_x',
      'core/0001_Init',
    ])
      expect(isMigrationName(name)).toBe(false);
  });

  it('must be unique and increasing within each owner', () => {
    const ok: Migration[] = [
      { name: 'core/0001_init', sql },
      { name: 'capacity/0001_init', sql },
      { name: 'core/0002_compute_now', sql: async () => undefined },
      { name: 'capacity/0003_rollups', sql },
    ];
    expect(() => assertMigrations(ok)).not.toThrow();
    const bad: Migration[][] = [
      [
        { name: 'core/0001_init', sql },
        { name: 'core/0001_init', sql },
      ],
      [
        { name: 'core/0002_b', sql },
        { name: 'core/0001_a', sql },
      ],
      [
        { name: 'core/0001_a', sql },
        { name: 'core/0001_b', sql },
      ],
      [{ name: 'core/init' as never, sql }],
      [{ name: 'core/0001_a', sql: 42 as never }],
    ];
    for (const list of bad) expect(code(() => assertMigrations(list))).toBe('INVALID_CONFIG');
  });
});

describe('conformance runner', () => {
  const cases: ConformanceCase<{ value: number }>[] = [
    { name: 'passes', run: async (subject) => check(subject.value === 1, 'value is 1') },
    {
      name: 'compares deeply',
      run: async () => checkEqual({ b: [1, { c: 2 }], a: 1 }, { a: 1, b: [1, { c: 2 }] }, 'equal'),
    },
    { name: 'fails', run: async (subject) => check(subject.value === 2, 'value is 2') },
    {
      name: 'expects codes',
      run: async () => {
        await checkRejects(
          async () => Promise.reject(new ComputeError('NOT_FOUND', 'gone')),
          'NOT_FOUND',
          'rejects',
        );
      },
    },
  ];

  it('collects passes and failures, with fresh subjects and disposal', async () => {
    const disposed: number[] = [];
    let made = 0;
    const report = await runConformance(
      cases,
      () => ({ value: 1, id: ++made }) as { value: number },
      {
        dispose: (subject) =>
          void disposed.push((subject as { id: number } & { value: number }).id),
      },
    );
    expect(report.passed).toEqual(['passes', 'compares deeply', 'expects codes']);
    expect(report.failed.map((entry) => entry.name)).toEqual(['fails']);
    expect(report.failed[0]?.error).toBeInstanceOf(ConformanceFailure);
    expect(disposed).toEqual([1, 2, 3, 4]);
    expect((await runConformance(cases, { value: 1 })).failed).toHaveLength(1);
  });

  it('reports mismatches clearly', async () => {
    expect(() => checkEqual([1, 2], [2, 1], 'order')).toThrow(
      'order: expected [2,1], received [1,2]',
    );
    await expect(checkRejects(async () => undefined, 'CONFLICT', 'nothing')).rejects.toThrow(
      'nothing: expected CONFLICT, but the operation succeeded',
    );
    await expect(
      checkRejects(
        async () => Promise.reject(new ComputeError('NOT_FOUND', 'x')),
        'CONFLICT',
        'wrong',
      ),
    ).rejects.toThrow('wrong: expected CONFLICT, received NOT_FOUND');
  });
});
