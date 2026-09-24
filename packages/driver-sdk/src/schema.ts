import {
  ComputeError,
  maskedValue,
  type JsonSchema,
  type StandardSchemaV1,
} from '@better-compute/core';
import { isRecord, secretFields } from './wire.js';

// A remote driver's `config`: the host only has the JSON Schema the plugin advertised in
// `DriverManifest.config_schema_json`, so it checks the subset core's `manifest().jsonSchema()`
// emits (type, enum, pattern, maxLength, minimum/maximum, items, required, additionalProperties).
// The value is passed through unchanged: the plugin parses the raw config again on every call
// (defaults, durations), and runs cross-field rules (`disabledWhen`) and live checks in Validate.

/** The Standard Schema a remote driver's `config` is, plus the advertised JSON Schema. */
export interface RemoteConfigSchema
  extends StandardSchemaV1<Record<string, unknown>, Record<string, unknown>> {
  /** The plugin's JSON Schema (a copy). */
  jsonSchema(): JsonSchema;
  /** Validates synchronously; throws `INVALID_INPUT` with `details.issues` like `manifest().parse`. */
  parse(value: unknown): Record<string, unknown>;
  /** A copy with masked and secret fields replaced by `maskedValue`. */
  redact(value: Readonly<Record<string, unknown>>): Record<string, unknown>;
  /** Top-level fields declared secret (`x-bc.kind: 'secret'` or `writeOnly`). */
  readonly secretFields: readonly string[];
}

const patterns = new Map<string, RegExp | undefined>();
function compiled(pattern: string): RegExp | undefined {
  if (!patterns.has(pattern)) {
    let regex: RegExp | undefined;
    try {
      regex = new RegExp(pattern, 'u');
    } catch {
      regex = undefined;
    }
    patterns.set(pattern, regex);
  }
  return patterns.get(pattern);
}

function matchesType(type: unknown, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'integer':
      return typeof value === 'number' && Number.isSafeInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isRecord(value);
    case 'null':
      return value === null;
    default:
      return true;
  }
}

function check(
  schema: unknown,
  value: unknown,
  path: readonly PropertyKey[],
  issues: StandardSchemaV1.Issue[],
): void {
  if (!isRecord(schema)) return;
  const fail = (message: string) => issues.push({ message, path: [...path] });
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(type, value)))
      return void fail(`Expected ${types.join(' or ')}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => entry === value))
    return void fail(`Expected one of ${schema.enum.join(', ')}`);
  if (typeof value === 'string') {
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength)
      fail(`Must be at most ${schema.maxLength} characters`);
    if (typeof schema.pattern === 'string' && compiled(schema.pattern)?.test(value) === false)
      fail(`Must match ${schema.pattern}`);
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum)
      fail(`Must be at least ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum)
      fail(`Must be at most ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems)
      fail(`Must list at least ${schema.minItems} items`);
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems)
      fail(`Must list at most ${schema.maxItems} items`);
    value.forEach((item, index) => check(schema.items, item, [...path, index], issues));
  }
  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const key of Array.isArray(schema.required) ? schema.required : [])
      if (typeof key === 'string' && value[key] === undefined)
        issues.push({ message: 'Required', path: [...path, key] });
    for (const [key, entry] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) {
        if (entry !== undefined) check(properties[key], entry, [...path, key], issues);
      } else if (schema.additionalProperties === false)
        issues.push({ message: `Unknown field ${key}`, path: [...path, key] });
    }
  }
}

/** The `config` of a remote driver, from the JSON Schema its plugin advertised. */
export function remoteConfigSchema(schema: JsonSchema): RemoteConfigSchema {
  const secrets = secretFields(schema);
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const masked = Object.entries(properties)
    .filter(
      ([name, property]) =>
        secrets.includes(name) ||
        (isRecord(property) && isRecord(property['x-bc']) && property['x-bc'].masked === true),
    )
    .map(([name]) => name);
  const validate = (value: unknown): StandardSchemaV1.Result<Record<string, unknown>> => {
    const issues: StandardSchemaV1.Issue[] = [];
    check(schema, value, [], issues);
    if (!issues.length && !isRecord(value)) issues.push({ message: 'Expected an object' });
    return issues.length ? { issues } : { value: value as Record<string, unknown> };
  };
  return Object.freeze({
    '~standard': { version: 1 as const, vendor: 'better-compute-bcx', validate },
    secretFields: Object.freeze(secrets),
    jsonSchema: () => structuredClone(schema),
    parse(value: unknown) {
      const result = validate(value);
      if (!result.issues) return result.value;
      const paths = result.issues.map((issue) => (issue.path ?? []).map(String));
      const [first] = result.issues;
      throw new ComputeError(
        'INVALID_INPUT',
        `${paths[0]?.length ? `${paths[0].join('.')}: ` : ''}${first?.message ?? 'Invalid configuration'}`,
        undefined,
        {
          issues: result.issues.map((issue, index) => ({
            message: issue.message,
            path: paths[index],
          })),
        },
      );
    },
    redact(value: Readonly<Record<string, unknown>>) {
      const output: Record<string, unknown> = { ...value };
      for (const name of masked) if (output[name] !== undefined) output[name] = maskedValue;
      return output;
    },
  });
}
