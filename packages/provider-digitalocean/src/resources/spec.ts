import { createHash } from 'node:crypto';
import type { JsonSchema, Manifest, StandardSchemaV1 } from '@better-compute/core';

// Hand-written manifests for kinds whose spec is a provider document (an App Platform spec, a trigger's body): the
// field-based `manifest()` has no nested objects. They are Standard Schemas with a `jsonSchema()`, which is all
// the cloud-resources module asks of a kind's spec.

export type Issue = { message: string; path: (string | number)[] };

/** A Standard Schema over plain JSON values with its JSON Schema. `check` pushes issues; it never throws. */
export function objectManifest<T>(
  schema: JsonSchema,
  check: (value: unknown, issues: Issue[]) => T,
): Manifest<T> & { jsonSchema(): JsonSchema } {
  const props: StandardSchemaV1.Props<unknown, T> = {
    version: 1,
    vendor: 'better-compute',
    validate(value) {
      const issues: Issue[] = [];
      const out = check(value, issues);
      return issues.length > 0 ? { issues } : { value: out };
    },
  };
  return { '~standard': props, jsonSchema: () => structuredClone(schema) };
}

export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Whether a value is JSON (no functions, no cycles, finite numbers) and at most `maxDepth` deep. */
export function isJson(value: unknown, maxDepth = 16): boolean {
  if (maxDepth < 0) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((entry) => isJson(entry, maxDepth - 1));
  if (isObject(value)) return Object.values(value).every((entry) => isJson(entry, maxDepth - 1));
  return false;
}

/** JSON with object keys sorted, so equal documents serialize the same. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value))
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

/** The first `length` hex digits of the SHA-256 of a document's canonical form. */
export function fingerprint(value: unknown, length = 32): string {
  return createHash('sha256').update(canonical(value)).digest('hex').slice(0, length);
}
