import { ComputeError } from '@better-compute/core';

// Strict input validation for the server's API groups: every object rejects unknown fields, nested
// objects and maps included (core's `manifest` covers flat configuration only). Failures are
// `INVALID_INPUT` with `details.issues: { message, path }[]`, the shape `manifest().parse` uses.

export interface Issue {
  message: string;
  path: string[];
}

type Path = readonly string[];

/** A JSON Schema (2020-12) fragment describing what a validator accepts. */
export type JsonSchema = { readonly [keyword: string]: unknown };

/** One field's validator. `parse` returns the value, or `undefined` after pushing issues. */
export interface Schema<T> {
  readonly optional: boolean;
  readonly fallback?: { value: T };
  /**
   * What `parse` accepts, as JSON Schema (for generated docs and tool schemas). Every `v.*` builder
   * sets it; a hand-written Schema without it documents as "any value".
   */
  readonly jsonSchema?: JsonSchema;
  parse(value: unknown, path: Path, issues: Issue[]): T | undefined;
}
interface OptionalSchema<T> extends Schema<T> {
  readonly optional: true;
}

type Shape = Readonly<Record<string, Schema<unknown>>>;
type Output<S> = S extends Schema<infer T> ? T : never;
type OptionalKeys<S extends Shape> = {
  [K in keyof S]: S[K] extends OptionalSchema<unknown> ? K : never;
}[keyof S];
type Simplify<T> = { [K in keyof T]: T[K] } & {};
export type Infer<S extends Shape> = Simplify<
  { [K in Exclude<keyof S, OptionalKeys<S>>]: Output<S[K]> } & {
    [K in OptionalKeys<S>]?: Output<S[K]>;
  }
>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const reserved = new Set(['__proto__', 'constructor', 'prototype']);

function schema<T>(jsonSchema: JsonSchema, parse: Schema<T>['parse']): Schema<T> {
  return { optional: false, jsonSchema, parse };
}

/** Drops keywords whose value is undefined (options not given). */
const defined = (fields: Record<string, unknown>): JsonSchema =>
  Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));

/** JSON Schema has no regex flags: a flagged pattern is described without one. */
const patternOf = (pattern: RegExp | undefined) => (pattern && !pattern.flags ? pattern.source : undefined);

function objectSchema(shape: Shape): JsonSchema {
  return {
    type: 'object',
    properties: Object.fromEntries(Object.entries(shape).map(([key, field]) => [key, field.jsonSchema ?? {}])),
    required: Object.entries(shape)
      .filter(([, field]) => !field.optional && !field.fallback)
      .map(([key]) => key),
    additionalProperties: false,
  };
}
function fail(issues: Issue[], path: Path, message: string): undefined {
  issues.push({ message, path: [...path] });
  return undefined;
}

export interface StringOptions {
  pattern?: RegExp;
  min?: number;
  max?: number;
}

export const v = {
  string(options: StringOptions = {}): Schema<string> {
    const max = options.max ?? 256;
    const json = defined({ type: 'string', minLength: options.min || undefined, maxLength: max, pattern: patternOf(options.pattern) });
    return schema(json, (value, path, issues) => {
      if (typeof value !== 'string') return fail(issues, path, 'Expected a string');
      if (value.length < (options.min ?? 0))
        return fail(issues, path, `Must be at least ${options.min} characters`);
      if (value.length > max) return fail(issues, path, `Must be at most ${max} characters`);
      if (options.pattern && !options.pattern.test(value))
        return fail(issues, path, `Must match ${options.pattern.source}`);
      return value;
    });
  },
  int(options: { min?: number; max?: number } = {}): Schema<number> {
    return schema(defined({ type: 'integer', minimum: options.min, maximum: options.max }), (value, path, issues) => {
      if (typeof value !== 'number' || !Number.isSafeInteger(value))
        return fail(issues, path, 'Expected an integer');
      if (options.min !== undefined && value < options.min)
        return fail(issues, path, `Must be at least ${options.min}`);
      if (options.max !== undefined && value > options.max)
        return fail(issues, path, `Must be at most ${options.max}`);
      return value;
    });
  },
  boolean(): Schema<boolean> {
    return schema({ type: 'boolean' }, (value, path, issues) =>
      typeof value === 'boolean' ? value : fail(issues, path, 'Expected true or false'),
    );
  },
  option<const V extends readonly [string, ...string[]]>(values: V): Schema<V[number]> {
    return schema({ type: 'string', enum: [...values] }, (value, path, issues) =>
      typeof value === 'string' && (values as readonly string[]).includes(value)
        ? (value as V[number])
        : fail(issues, path, `Expected one of ${values.join(', ')}`),
    );
  },
  list<T>(item: Schema<T>, options: { min?: number; max: number; unique?: boolean }): Schema<T[]> {
    const json = defined({
      type: 'array',
      items: item.jsonSchema ?? {},
      minItems: options.min || undefined,
      maxItems: options.max,
      uniqueItems: options.unique || undefined,
    });
    return schema(json, (value, path, issues) => {
      if (!Array.isArray(value)) return fail(issues, path, 'Expected a list');
      if (value.length < (options.min ?? 0))
        return fail(issues, path, `Must list at least ${options.min} items`);
      if (value.length > options.max)
        return fail(issues, path, `Must list at most ${options.max} items`);
      const before = issues.length;
      const output = value.map((entry, index) =>
        item.parse(entry, [...path, String(index)], issues),
      );
      if (issues.length > before) return undefined;
      if (
        options.unique &&
        new Set(output.map((entry) => JSON.stringify(entry))).size !== output.length
      )
        return fail(issues, path, 'Must not repeat an item');
      return output as T[];
    });
  },
  /** A JSON object used as a map: keys match `key`, values match `value`. */
  record<T>(key: RegExp, value: Schema<T>, options: { max: number }): Schema<Record<string, T>> {
    const json = defined({
      type: 'object',
      propertyNames: defined({ pattern: patternOf(key) }),
      additionalProperties: value.jsonSchema ?? {},
      maxProperties: options.max,
    });
    return schema(json, (input, path, issues) => {
      if (!isRecord(input)) return fail(issues, path, 'Expected an object');
      const keys = Object.keys(input);
      if (keys.length > options.max)
        return fail(issues, path, `Must have at most ${options.max} entries`);
      const before = issues.length;
      const output: Record<string, T> = Object.create(null);
      for (const name of keys) {
        if (!key.test(name) || reserved.has(name)) {
          fail(issues, [...path, name], `Key must match ${key.source}`);
          continue;
        }
        const parsed = value.parse(input[name], [...path, name], issues);
        if (parsed !== undefined) output[name] = parsed;
      }
      return issues.length > before ? undefined : { ...output };
    });
  },
  /** Any JSON object, validated later by whoever knows its shape (a command's payload). */
  anyObject(): Schema<Record<string, unknown>> {
    return schema({ type: 'object' }, (value, path, issues) =>
      isRecord(value) ? value : fail(issues, path, 'Expected an object'),
    );
  },
  object<S extends Shape>(shape: S): Schema<Infer<S>> {
    return schema(objectSchema(shape), (input, path, issues) => parseObject(shape, input, path, issues));
  },
  optional<T>(inner: Schema<T>): OptionalSchema<T> {
    return { optional: true, parse: inner.parse, ...(inner.jsonSchema ? { jsonSchema: inner.jsonSchema } : {}) };
  },
  /** Absent means `value`; the output always has the field. */
  withDefault<T>(inner: Schema<T>, value: T): Schema<T> {
    return { optional: false, fallback: { value }, parse: inner.parse, jsonSchema: { ...inner.jsonSchema, default: value } };
  },
};

function parseObject<S extends Shape>(
  shape: S,
  input: unknown,
  path: Path,
  issues: Issue[],
): Infer<S> | undefined {
  if (!isRecord(input)) return fail(issues, path, 'Expected an object');
  const before = issues.length;
  for (const key of Object.keys(input))
    if (!Object.hasOwn(shape, key)) fail(issues, [...path, key], `Unknown field ${key}`);
  const output: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(shape)) {
    const raw = Object.hasOwn(input, key) ? input[key] : undefined;
    if (raw === undefined) {
      if (field.fallback) output[key] = structuredClone(field.fallback.value);
      else if (!field.optional) fail(issues, [...path, key], 'Required');
      continue;
    }
    const parsed = field.parse(raw, [...path, key], issues);
    if (parsed !== undefined) output[key] = parsed;
  }
  return issues.length > before ? undefined : (output as Infer<S>);
}

/** `INVALID_INPUT` naming the first issue, with all of them in `details.issues`. */
function invalid(issues: Issue[]): ComputeError {
  const first = issues[0];
  const where = first && first.path.length ? `${first.path.join('.')}: ` : '';
  return new ComputeError(
    'INVALID_INPUT',
    `${where}${first?.message ?? 'Invalid input'}`,
    undefined,
    {
      issues,
    },
  );
}

/**
 * A strict object validator. It carries `jsonSchema`, what it accepts as JSON Schema, which a
 * method's `validate` exposes to the generated reference.
 */
export function parser<S extends Shape>(shape: S): ((input: unknown) => Infer<S>) & { readonly jsonSchema: JsonSchema } {
  return Object.assign(
    (input: unknown) => {
      const issues: Issue[] = [];
      const output = parseObject(shape, input, [], issues);
      if (output === undefined || issues.length) throw invalid(issues);
      return output;
    },
    { jsonSchema: objectSchema(shape) },
  );
}

/** Validates one nested value against `schema`, reporting issues under `path`. */
export function check<T>(schema: Schema<T>, value: unknown, path: readonly string[]): T {
  const issues: Issue[] = [];
  const output = schema.parse(value, path, issues);
  if (output === undefined || issues.length) throw invalid(issues);
  return output;
}
