import { ComputeError, isId } from '@better-compute/core';

// Strict input parsing for the kubernetes groups: unknown fields are rejected, ids are checked by prefix, and every
// refusal is INVALID_INPUT naming the field.

export function fail(message: string): never {
  throw new ComputeError('INVALID_INPUT', message);
}

export function object(raw: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    fail('The request must be an object');
  for (const key of Object.keys(raw))
    if (!allowed.includes(key)) fail(`Unknown field ${JSON.stringify(key)}`);
  return raw as Record<string, unknown>;
}

const tenantPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const keyPattern = /^[A-Za-z0-9._:-]{1,128}$/;

export function tenant(value: unknown, name = 'tenantId'): string {
  if (typeof value !== 'string' || !tenantPattern.test(value)) fail(`${name} is invalid`);
  return value;
}

export function id(value: unknown, prefix: string, name: string): string {
  if (!isId(value, prefix)) fail(`${name} must be a ${prefix}_ id`);
  return value;
}

export function key(value: unknown, name = 'idempotencyKey'): string {
  if (typeof value !== 'string' || !keyPattern.test(value)) fail(`${name} is invalid`);
  return value;
}

export function int(value: unknown, what: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    fail(`${what} must be an integer from ${min} to ${max}`);
  return value;
}

export function bool(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') fail(`${what} must be true or false`);
  return value;
}

export function optional<T>(value: unknown, parse: (value: unknown) => T): T | undefined {
  return value === undefined ? undefined : parse(value);
}

/** Canonical JSON (sorted keys, undefined dropped): the input of request hashes. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .filter((entry) => (value as Record<string, unknown>)[entry] !== undefined)
    .sort()
    .map(
      (entry) => `${JSON.stringify(entry)}:${canonical((value as Record<string, unknown>)[entry])}`,
    )
    .join(',')}}`;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
