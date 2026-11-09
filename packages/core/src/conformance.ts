import { isComputeError, type ErrorCode } from './errors.js';

/**
 * One behavioral case of a contract's conformance suite. Framework-agnostic: a case throws on
 * failure, and returns (or throws) a `skip(reason)` when it does not apply to the subject and so
 * checked nothing. Packages publish suites as `<contract>ConformanceCases()` returning these, run
 * with `runConformance`, which reports passed, failed and skipped cases apart, or from any test
 * runner:
 *
 * ```ts
 * for (const test of placerConformanceCases())
 *   it(test.name, async (context) => {
 *     const outcome = await test.run(await createSubject());
 *     if (isConformanceSkip(outcome)) context.skip(outcome.reason);
 *   });
 * ```
 */
export interface ConformanceCase<T> {
  name: string;
  run(subject: T): Promise<void | ConformanceSkip>;
}

/**
 * What a case returns or throws when it did not apply to its subject (the provider lacks the
 * capability, the subject names nothing to run it on): nothing was checked, so it did not pass.
 */
export class ConformanceSkip extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`skipped: ${reason}`);
    this.name = 'ConformanceSkip';
    this.reason = reason;
  }
}

/** A skip for a case to return (`return skip('the provider has no volumes')`) or throw. */
export function skip(reason: string): ConformanceSkip {
  return new ConformanceSkip(reason);
}

/** Whether `value` is a case's skip, also one made by another copy of this module. */
export function isConformanceSkip(value: unknown): value is ConformanceSkip {
  return (
    value instanceof ConformanceSkip ||
    (value instanceof Error &&
      value.name === 'ConformanceSkip' &&
      typeof (value as { reason?: unknown }).reason === 'string')
  );
}

export class ConformanceFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConformanceFailure';
  }
}

/** Throws a `ConformanceFailure` unless `condition` holds. */
export function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ConformanceFailure(message);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? String(value);
  if (value instanceof Uint8Array) return `bytes(${[...value].join(',')})`;
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
    .join(',')}}`;
}

/** Deep equality by canonical JSON (key order ignored). */
export function checkEqual(actual: unknown, expected: unknown, message: string): void {
  const left = canonical(actual);
  const right = canonical(expected);
  check(left === right, `${message}: expected ${right}, received ${left}`);
}

/** Expects `operation` to reject with a `ComputeError` of `code`, and returns that error. */
export async function checkRejects(
  operation: () => Promise<unknown>,
  code: ErrorCode,
  message: string,
): Promise<Error> {
  let failure: unknown;
  try {
    await operation();
  } catch (error) {
    failure = error;
  }
  check(failure !== undefined, `${message}: expected ${code}, but the operation succeeded`);
  const received = isComputeError(failure) ? failure.code : String(failure);
  check(received === code, `${message}: expected ${code}, received ${received}`);
  return failure as Error;
}

export interface ConformanceReport {
  /** The cases that ran and held. A skipped case is not among them. */
  passed: string[];
  failed: { name: string; error: unknown }[];
  /** The cases that did not apply to the subject, with why: they checked nothing. */
  skipped: { name: string; reason: string }[];
}

export interface RunConformanceOptions<T> {
  /** Called after each case with the subject it ran against (close stores, stop servers). */
  dispose?(subject: T): void | Promise<void>;
}

/**
 * Runs every case and collects failures instead of stopping at the first. A case that returns or
 * throws a skip is reported under `skipped`, never under `passed`. Pass a factory to give each case
 * a fresh subject; a subject that is itself a function must be wrapped in one.
 */
export async function runConformance<T>(
  cases: readonly ConformanceCase<T>[],
  subject: T | (() => T | Promise<T>),
  options: RunConformanceOptions<T> = {},
): Promise<ConformanceReport> {
  const report: ConformanceReport = { passed: [], failed: [], skipped: [] };
  for (const test of cases) {
    const current =
      typeof subject === 'function' ? await (subject as () => T | Promise<T>)() : subject;
    try {
      const outcome = await test.run(current);
      if (isConformanceSkip(outcome))
        report.skipped.push({ name: test.name, reason: outcome.reason });
      else report.passed.push(test.name);
    } catch (error) {
      if (isConformanceSkip(error)) report.skipped.push({ name: test.name, reason: error.reason });
      else report.failed.push({ name: test.name, error });
    } finally {
      await options.dispose?.(current);
    }
  }
  return report;
}
