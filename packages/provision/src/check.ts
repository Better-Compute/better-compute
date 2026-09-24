// Shape checks shared by defineStep and defineProfile. They fail fast with `INVALID_CONFIG`, naming
// the path of the first offending field, the way better-iam's validatePolicy does.
import { ComputeError, parseDuration, type RunsOn } from '@better-compute/core';

/** Throws `INVALID_CONFIG` for the definition being checked. */
export type Fail = (path: string, message: string) => never;

export function failFor(subject: string): Fail {
  return (path, message) => {
    throw new ComputeError(
      'INVALID_CONFIG',
      `${subject}: ${path ? `${path} ` : ''}${message}`,
      undefined,
      { path },
    );
  };
}

export const join = (path: string, key: string | number): string =>
  typeof key === 'number' ? `${path}[${key}]` : path ? `${path}.${key}` : key;

/** A plain object: an object literal or `Object.create(null)`, not an array, class or function. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Rejects keys outside `allowed`, so a misspelt option fails instead of being ignored. */
export function onlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  fail: Fail,
): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) fail(join(path, key), 'is not a known field');
}

export const runsOnValues: readonly RunsOn[] = ['control-plane', 'site', 'node', 'ramdisk'];

/** Step ids and command kinds: dotted, e.g. `power.setPower`, `wait.agentJoined`, `diag.dcgm`. */
export const dottedIdPattern = /^[a-z][a-z0-9-]*(?:\.[a-z][A-Za-z0-9-]*)+$/;
/** Driver ids, driver concerns and config units: `redfish`, `virtual-media`, `nvidia-driver`. */
export const namePattern = /^[a-z][a-z0-9-]{0,63}$/;
const versionPattern = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
export const maxRetries = 100;

export function checkDottedId(value: unknown, path: string, fail: Fail): void {
  if (typeof value !== 'string' || value.length > 128 || !dottedIdPattern.test(value))
    fail(path, 'must be a dotted id such as power.setPower');
}

export function checkName(value: unknown, path: string, fail: Fail): void {
  if (typeof value !== 'string' || !namePattern.test(value))
    fail(path, 'must be lower-case letters, digits and hyphens, starting with a letter');
}

export function checkVersion(value: unknown, path: string, fail: Fail): void {
  if (typeof value !== 'string' || !versionPattern.test(value))
    fail(path, 'must be a version string such as 1.0.0');
}

export function checkRunsOn(value: unknown, path: string, fail: Fail): asserts value is RunsOn {
  if (!runsOnValues.includes(value as RunsOn))
    fail(path, `must be one of ${runsOnValues.join(', ')}`);
}

export function checkOneOf(
  value: unknown,
  allowed: readonly string[],
  path: string,
  fail: Fail,
): void {
  if (typeof value !== 'string' || !allowed.includes(value))
    fail(path, `must be one of ${allowed.join(', ')}`);
}

/** A positive duration (`'30m'`, `'15m'`, or milliseconds). */
export function checkTimeout(value: unknown, path: string, fail: Fail): void {
  let ms: number;
  try {
    ms = parseDuration(value as string | number);
  } catch {
    return fail(path, 'must be a duration such as 30s, 10m or 1h');
  }
  if (ms <= 0) fail(path, 'must be longer than zero');
}

export function checkRetries(value: unknown, path: string, fail: Fail): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maxRetries)
    fail(path, `must be a whole number from 0 to ${maxRetries}`);
}

export function checkText(value: unknown, maxLength: number, path: string, fail: Fail): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength)
    fail(path, `must be a non-empty string of at most ${maxLength} characters`);
}

/** JSON values only: profiles are stored as documents, so functions and `undefined` cannot round-trip. */
export function checkJson(value: unknown, path: string, fail: Fail, depth = 0): void {
  if (depth > 32) fail(path, 'is nested too deeply');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(path, 'must be a finite number');
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => checkJson(item, join(path, index), fail, depth + 1));
    return;
  }
  if (!isPlainObject(value)) fail(path, 'must be a JSON value');
  for (const [key, item] of Object.entries(value))
    checkJson(item, join(path, key), fail, depth + 1);
}

/** A JSON object (`with`, driver `config`, config units). */
export function checkJsonObject(value: unknown, path: string, fail: Fail): void {
  if (!isPlainObject(value)) fail(path, 'must be an object');
  checkJson(value, path, fail);
}

/** Any Standard Schema v1: a `manifest(...)`, zod, valibot, arktype. */
export function isStandardSchema(value: unknown): boolean {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false;
  const props = (value as { '~standard'?: { version?: unknown; validate?: unknown } })['~standard'];
  return props?.version === 1 && typeof props.validate === 'function';
}

export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
