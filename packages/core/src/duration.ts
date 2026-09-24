import { ComputeError } from './errors.js';

export type DurationUnit = 'ms' | 's' | 'm' | 'h' | 'd';
/** A duration literal such as `'90s'`, `'30m'`, `'8h'` or `'1d'`. `parseDuration` also accepts sums like `'1h30m'`. */
export type Duration = `${number}${DurationUnit}`;

const unitMs: Readonly<Record<DurationUnit, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};
const term = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/y;

/** The source of the pattern duration strings match, for JSON Schema and other validators. */
export const durationPattern = '^(\\d+(\\.\\d+)?(ms|s|m|h|d))+$';

/**
 * Parses `'90s'`, `'30m'`, `'8h'`, `'1d'` or a sum such as `'1h30m'` into whole milliseconds. A
 * non-negative safe integer passes through as milliseconds. Anything else is `INVALID_INPUT`.
 */
export function parseDuration(value: string | number): number {
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value) && value >= 0) return value;
    throw new ComputeError(
      'INVALID_INPUT',
      'A duration in milliseconds must be a non-negative integer',
    );
  }
  const invalid = () =>
    new ComputeError('INVALID_INPUT', `Invalid duration ${JSON.stringify(value)}`, undefined, {
      expected: 'like 90s, 30m, 8h, 1d or 1h30m',
    });
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) throw invalid();
  let total = 0;
  term.lastIndex = 0;
  while (term.lastIndex < value.length) {
    const start = term.lastIndex;
    const match = term.exec(value);
    if (!match || match.index !== start) throw invalid();
    total += Number(match[1]) * unitMs[match[2] as DurationUnit];
  }
  const ms = Math.round(total);
  if (!Number.isSafeInteger(ms)) throw invalid();
  return ms;
}

/** Formats milliseconds as the shortest sum of whole units, largest first: `5400000` → `'1h30m'`, `0` → `'0s'`. */
export function formatDuration(ms: number): string {
  if (!Number.isSafeInteger(ms) || ms < 0)
    throw new ComputeError(
      'INVALID_INPUT',
      'A duration must be a non-negative whole number of milliseconds',
    );
  if (ms === 0) return '0s';
  let rest = ms;
  let output = '';
  for (const unit of ['d', 'h', 'm', 's', 'ms'] as const) {
    const count = Math.floor(rest / unitMs[unit]);
    if (count > 0) {
      output += `${count}${unit}`;
      rest -= count * unitMs[unit];
    }
  }
  return output;
}
