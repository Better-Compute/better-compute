import { ComputeError, isId } from '@better-compute/core';

// Input validation shared by the VPS API groups: unknown fields are rejected, ids are checked by
// prefix, and every refusal is INVALID_INPUT naming the field.

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
const namePattern = /^[a-z0-9][a-z0-9._-]{0,62}$/;

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

/** Lower-case names: flavors (`g1.small`) and provider accounts (`hetzner-main`). */
export function name(value: unknown, what = 'name'): string {
  if (typeof value !== 'string' || !namePattern.test(value))
    fail(`${what} must be 1-63 lower-case letters, digits, '.', '_' or '-'`);
  return value;
}

export function int(value: unknown, what: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    fail(`${what} must be an integer from ${min} to ${max}`);
  return value;
}

export function optional<T>(value: unknown, parse: (value: unknown) => T): T | undefined {
  return value === undefined ? undefined : parse(value);
}

/** OpenSSH public keys, one line each: `ssh-ed25519 AAAA… comment`. */
export function sshKeys(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) fail('sshKeys must list at most 32 keys');
  return value.map((entry, index) => {
    if (
      typeof entry !== 'string' ||
      entry.length > 8192 ||
      /[\r\n]/.test(entry) ||
      !/^(ssh-(ed25519|rsa)|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com) [A-Za-z0-9+/=]+( .*)?$/.test(
        entry,
      )
    )
      fail(`sshKeys[${index}] is not an OpenSSH public key`);
    return entry;
  });
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
