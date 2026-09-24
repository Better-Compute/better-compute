import type { Json } from './domain.js';
import { durationPattern, parseDuration } from './duration.js';
import { ComputeError } from './errors.js';

// Standard Schema v1 (https://standardschema.dev), declared inline so core has no dependencies.
// Any conforming schema (zod, valibot, arktype, or a `manifest`) is accepted wherever a
// `Manifest<C>` is.

/** The Standard Schema v1 interface. */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': StandardSchemaV1.Props<Input, Output>;
}
export declare namespace StandardSchemaV1 {
  interface Props<Input = unknown, Output = Input> {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => Result<Output> | Promise<Result<Output>>;
    readonly types?: Types<Input, Output> | undefined;
  }
  type Result<Output> = SuccessResult<Output> | FailureResult;
  interface SuccessResult<Output> {
    readonly value: Output;
    readonly issues?: undefined;
  }
  interface FailureResult {
    readonly issues: ReadonlyArray<Issue>;
  }
  interface Issue {
    readonly message: string;
    readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined;
  }
  interface PathSegment {
    readonly key: PropertyKey;
  }
  interface Types<Input = unknown, Output = Input> {
    readonly input: Input;
    readonly output: Output;
  }
  type InferInput<Schema extends StandardSchemaV1> = NonNullable<
    Schema['~standard']['types']
  >['input'];
  type InferOutput<Schema extends StandardSchemaV1> = NonNullable<
    Schema['~standard']['types']
  >['output'];
}

/** What contracts accept as configuration schema: any Standard Schema whose output is `C`. */
export type Manifest<C = unknown> = StandardSchemaV1<unknown, C>;

/** A reference to a secret, resolved just in time and never stored or echoed as a value. */
export type SecretRef = `secret://${string}` | `vault://${string}` | `env://${string}`;
const secretRefSource = '^(secret|vault|env)://\\S+$';
const secretRefPattern = new RegExp(secretRefSource);

export function isSecretRef(value: unknown): value is SecretRef {
  return typeof value === 'string' && value.length <= 2048 && secretRefPattern.test(value);
}

export type FieldKind =
  | 'string'
  | 'int'
  | 'number'
  | 'boolean'
  | 'option'
  | 'secret'
  | 'duration'
  | 'url'
  | 'list';
/** `required` fields must be given; `optional` ones may be absent; `defaulted` ones take their default. */
export type Presence = 'required' | 'optional' | 'defaulted';
type Scalar = string | number | boolean;

/**
 * Disables a field when every named field has one of the listed values, for example
 * `{ location: ['ash', 'hil'] }`. A disabled field must be absent and gets no default.
 */
export type DisabledPredicate = Readonly<Record<string, Scalar | readonly Scalar[]>>;

export interface Suggestion {
  value: string;
  label?: string;
  description?: string;
}
/** What a suggestion source sees: the values entered so far, and a way to use their secrets. */
export interface SuggestContext {
  values: Readonly<Record<string, unknown>>;
  resolveSecret?(ref: SecretRef): Promise<string>;
  signal?: AbortSignal;
}
export type SuggestFn = (context: SuggestContext) => Promise<readonly (string | Suggestion)[]>;

/** The serializable description of a field, as `jsonSchema()` and forms read it. */
export interface FieldSpec {
  readonly kind: FieldKind;
  readonly presence: Presence;
  readonly description?: string;
  readonly masked: boolean;
  readonly suggestible: boolean;
  readonly disabledWhen?: DisabledPredicate;
  readonly options?: readonly string[];
  readonly min?: number;
  readonly max?: number;
  readonly pattern?: string;
  readonly maxLength?: number;
  /** The default in input form (what a person would type). */
  readonly default?: unknown;
  readonly item?: FieldSpec;
}

export type FieldParseResult<T> = { value: T } | { issues: StandardSchemaV1.Issue[] };

/**
 * One manifest field. Modifiers return new fields; `Out` is the validated value, `In` what a person
 * or config file supplies (they differ only for durations, which validate to milliseconds).
 */
export interface Field<Out = unknown, In = Out, P extends Presence = Presence> {
  readonly spec: FieldSpec;
  optional(): Field<Out, In, 'optional'>;
  /**
   * A default in input form, validated immediately (`INVALID_CONFIG` if it does not pass). Call it
   * before `disabledWhen`, whose field may be absent whatever its default.
   */
  default(value: In): Field<Out, In, 'defaulted'>;
  describe(text: string): Field<Out, In, P>;
  /** Live suggestions for the CLI, console and MCP. */
  suggest(fn: SuggestFn): Field<Out, In, P>;
  disabledWhen(predicate: DisabledPredicate): Field<Out, In, 'optional'>;
  /** The same field, shown masked in forms and replaced by `redact()`. Secrets are always masked. */
  readonly masked: Field<Out, In, P>;
  /** Parses one present value; `path` prefixes issue paths. */
  parse(value: unknown, path?: readonly PropertyKey[]): FieldParseResult<Out>;
}

type AnyField = Field<any, any, Presence>;
type Parser = (value: unknown, path: readonly PropertyKey[]) => FieldParseResult<unknown>;

interface FieldState {
  spec: FieldSpec;
  parser: Parser;
  suggest?: SuggestFn;
  hasDefault?: boolean;
  /** The default in output form. */
  fallback?: unknown;
}
type FieldChange = Omit<Partial<FieldState>, 'spec'> & { spec?: Partial<FieldSpec> };

const internals = new WeakMap<object, FieldState>();

function issue(
  message: string,
  path: readonly PropertyKey[],
): { issues: StandardSchemaV1.Issue[] } {
  return { issues: [{ message, path: [...path] }] };
}

function makeField<Out, In, P extends Presence>(state: FieldState): Field<Out, In, P> {
  Object.freeze(state.spec);
  const derive = <Q extends Presence>(next: FieldChange) =>
    makeField<Out, In, Q>({ ...state, ...next, spec: { ...state.spec, ...next.spec } });
  const created: Field<Out, In, P> = {
    spec: state.spec,
    optional: () => derive<'optional'>({ spec: { presence: 'optional' } }),
    default(value) {
      if (state.spec.disabledWhen)
        throw new ComputeError('INVALID_CONFIG', 'Call default() before disabledWhen()');
      const parsed = state.parser(value, []);
      if ('issues' in parsed)
        throw new ComputeError(
          'INVALID_CONFIG',
          `Invalid default for a ${state.spec.kind} field: ${parsed.issues[0]?.message ?? 'invalid'}`,
        );
      return derive<'defaulted'>({
        spec: { presence: 'defaulted', default: value },
        hasDefault: true,
        fallback: parsed.value,
      });
    },
    describe: (text) => derive<P>({ spec: { description: text } }),
    suggest: (fn) => derive<P>({ suggest: fn, spec: { suggestible: true } }),
    disabledWhen: (predicate) =>
      derive<'optional'>({ spec: { presence: 'optional', disabledWhen: { ...predicate } } }),
    get masked() {
      return derive<P>({ spec: { masked: true } });
    },
    parse: (value, path = []) => state.parser(value, path) as FieldParseResult<Out>,
  };
  internals.set(created, state);
  return Object.freeze(created);
}

function scalar<Out, In = Out>(
  kind: FieldKind,
  parser: Parser,
  extra: Partial<FieldSpec> = {},
): Field<Out, In, 'required'> {
  return makeField({
    spec: { kind, presence: 'required', masked: kind === 'secret', suggestible: false, ...extra },
    parser,
  });
}

function bounds(value: number, spec: { min?: number; max?: number }, path: readonly PropertyKey[]) {
  if (spec.min !== undefined && value < spec.min)
    return issue(`Must be at least ${spec.min}`, path);
  if (spec.max !== undefined && value > spec.max) return issue(`Must be at most ${spec.max}`, path);
  return { value };
}

export interface StringFieldOptions {
  /** Matched with the `u` flag; a RegExp's own flags are dropped (JSON Schema patterns have none). */
  pattern?: string | RegExp;
  maxLength?: number;
}
export interface NumberFieldOptions {
  min?: number;
  max?: number;
}
export interface ListFieldOptions {
  min?: number;
  max?: number;
}

/** Field builders for `manifest({...})`. */
export const field = {
  string(options: StringFieldOptions = {}): Field<string, string, 'required'> {
    const pattern =
      options.pattern === undefined
        ? undefined
        : typeof options.pattern === 'string'
          ? options.pattern
          : options.pattern.source;
    let regex: RegExp | undefined;
    try {
      regex = pattern === undefined ? undefined : new RegExp(pattern, 'u');
    } catch {
      throw new ComputeError('INVALID_CONFIG', `Invalid pattern ${JSON.stringify(pattern)}`);
    }
    return scalar(
      'string',
      (value, path) => {
        if (typeof value !== 'string') return issue('Expected a string', path);
        if (options.maxLength !== undefined && value.length > options.maxLength)
          return issue(`Must be at most ${options.maxLength} characters`, path);
        if (regex && !regex.test(value)) return issue(`Must match ${pattern}`, path);
        return { value };
      },
      { pattern, maxLength: options.maxLength },
    );
  },
  int(options: NumberFieldOptions = {}): Field<number, number, 'required'> {
    return scalar(
      'int',
      (value, path) =>
        typeof value === 'number' && Number.isSafeInteger(value)
          ? bounds(value, options, path)
          : issue('Expected an integer', path),
      { min: options.min, max: options.max },
    );
  },
  number(options: NumberFieldOptions = {}): Field<number, number, 'required'> {
    return scalar(
      'number',
      (value, path) =>
        typeof value === 'number' && Number.isFinite(value)
          ? bounds(value, options, path)
          : issue('Expected a number', path),
      { min: options.min, max: options.max },
    );
  },
  boolean(): Field<boolean, boolean, 'required'> {
    return scalar('boolean', (value, path) =>
      typeof value === 'boolean' ? { value } : issue('Expected true or false', path),
    );
  },
  /** One of a fixed list of strings. */
  option<const V extends readonly [string, ...string[]]>(
    values: V,
  ): Field<V[number], V[number], 'required'> {
    if (!values.length || new Set(values).size !== values.length)
      throw new ComputeError('INVALID_CONFIG', 'option() needs distinct values');
    const allowed = [...values];
    return scalar(
      'option',
      (value, path) =>
        typeof value === 'string' && allowed.includes(value)
          ? { value }
          : issue(`Expected one of ${allowed.join(', ')}`, path),
      { options: allowed },
    );
  },
  /** A `SecretRef` (`secret://`, `vault://` or `env://`); masked, never a raw value. */
  secret(): Field<SecretRef, SecretRef, 'required'> {
    return scalar('secret', (value, path) =>
      isSecretRef(value)
        ? { value }
        : issue('Expected a secret reference (secret://, vault:// or env://)', path),
    );
  },
  /** A duration such as `'10m'` (or milliseconds); validates to milliseconds. */
  duration(): Field<number, string | number, 'required'> {
    return scalar('duration', (value, path) => {
      if (typeof value !== 'string' && typeof value !== 'number')
        return issue('Expected a duration such as 30s, 10m or 8h', path);
      try {
        return { value: parseDuration(value) };
      } catch {
        return issue('Expected a duration such as 30s, 10m or 8h', path);
      }
    });
  },
  /** An absolute URL. */
  url(): Field<string, string, 'required'> {
    return scalar('url', (value, path) => {
      if (typeof value !== 'string' || value.length > 2048) return issue('Expected a URL', path);
      try {
        new URL(value);
        return { value };
      } catch {
        return issue('Expected an absolute URL', path);
      }
    });
  },
  /** A list of one required field type. */
  list<F extends Field<any, any, 'required'>>(
    item: F,
    options: ListFieldOptions = {},
  ): Field<FieldOutput<F>[], FieldInput<F>[], 'required'> {
    if (item.spec.presence !== 'required' || item.spec.disabledWhen)
      throw new ComputeError('INVALID_CONFIG', 'List items must be plain required fields');
    return scalar(
      'list',
      (value, path) => {
        if (!Array.isArray(value)) return issue('Expected a list', path);
        if (options.min !== undefined && value.length < options.min)
          return issue(`Must list at least ${options.min} items`, path);
        if (options.max !== undefined && value.length > options.max)
          return issue(`Must list at most ${options.max} items`, path);
        const output: unknown[] = [];
        const issues: StandardSchemaV1.Issue[] = [];
        value.forEach((entry, index) => {
          const parsed = item.parse(entry, [...path, index]);
          if ('issues' in parsed) issues.push(...parsed.issues);
          else output.push(parsed.value);
        });
        return issues.length ? { issues } : { value: output };
      },
      { item: item.spec, min: options.min, max: options.max, masked: item.spec.masked },
    );
  },
};

export type FieldShape = Readonly<Record<string, AnyField>>;
export type FieldOutput<F> = F extends Field<infer O, any, any> ? O : never;
export type FieldInput<F> = F extends Field<any, infer I, any> ? I : never;
type Simplify<T> = { [K in keyof T]: T[K] } & {};
type KeysWith<S, P extends Presence> = {
  [K in keyof S]: S[K] extends Field<any, any, infer Q> ? ([Q] extends [P] ? K : never) : never;
}[keyof S];

/** The validated configuration a manifest produces. */
export type ManifestOutput<S extends FieldShape> = Simplify<
  { [K in KeysWith<S, 'required' | 'defaulted'>]: FieldOutput<S[K]> } & {
    [K in KeysWith<S, 'optional'>]?: FieldOutput<S[K]>;
  }
>;
/** The configuration a manifest accepts. */
export type ManifestInput<S extends FieldShape> = Simplify<
  { [K in KeysWith<S, 'required'>]: FieldInput<S[K]> } & {
    [K in KeysWith<S, 'optional' | 'defaulted'>]?: FieldInput<S[K]>;
  }
>;

/** A JSON Schema document (2020-12). */
export type JsonSchema = { [key: string]: Json };

/** The placeholder `redact()` puts in place of masked values. */
export const maskedValue = '********';

/** A typed configuration schema: Standard Schema v1 plus JSON Schema, suggestions and redaction. */
export interface ConfigManifest<S extends FieldShape = FieldShape>
  extends StandardSchemaV1<ManifestInput<S>, ManifestOutput<S>> {
  readonly fields: S;
  /** Validates synchronously and throws `INVALID_INPUT` (issues in `details.issues`). */
  parse(value: unknown): ManifestOutput<S>;
  /** JSON Schema 2020-12 with `x-bc` hints (`kind`, `masked`, `suggest`, `disabledWhen`). */
  jsonSchema(): JsonSchema;
  /** Suggestions for one field; empty when it has no suggestion source. */
  suggest(key: keyof S & string, context: SuggestContext): Promise<Suggestion[]>;
  /** A copy with every masked field's value replaced by `maskedValue`, safe to echo or log. */
  redact(value: Readonly<Record<string, unknown>>): Record<string, unknown>;
}

const keyPattern = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const reservedKeys = new Set(['__proto__', 'constructor', 'prototype']);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const copy = (value: unknown) =>
  typeof value === 'object' && value !== null ? structuredClone(value) : value;

function fieldSchema(spec: FieldSpec): JsonSchema {
  const schema: JsonSchema = {};
  switch (spec.kind) {
    case 'string':
      schema.type = 'string';
      if (spec.maxLength !== undefined) schema.maxLength = spec.maxLength;
      if (spec.pattern !== undefined) schema.pattern = spec.pattern;
      break;
    case 'int':
    case 'number':
      schema.type = spec.kind === 'int' ? 'integer' : 'number';
      if (spec.min !== undefined) schema.minimum = spec.min;
      if (spec.max !== undefined) schema.maximum = spec.max;
      break;
    case 'boolean':
      schema.type = 'boolean';
      break;
    case 'option':
      schema.type = 'string';
      schema.enum = [...(spec.options ?? [])];
      break;
    case 'secret':
      schema.type = 'string';
      schema.pattern = secretRefSource;
      schema.writeOnly = true;
      break;
    case 'duration':
      schema.type = ['string', 'integer'];
      schema.pattern = durationPattern;
      schema.minimum = 0;
      break;
    case 'url':
      schema.type = 'string';
      schema.format = 'uri';
      break;
    case 'list':
      schema.type = 'array';
      schema.items = fieldSchema(spec.item!);
      if (spec.min !== undefined) schema.minItems = spec.min;
      if (spec.max !== undefined) schema.maxItems = spec.max;
      break;
  }
  if (spec.description !== undefined) schema.description = spec.description;
  if (spec.default !== undefined) schema.default = copy(spec.default) as Json;
  const hints: JsonSchema = { kind: spec.kind };
  if (spec.masked) hints.masked = true;
  if (spec.suggestible) hints.suggest = true;
  if (spec.disabledWhen)
    hints.disabledWhen = Object.fromEntries(
      Object.entries(spec.disabledWhen).map(([key, value]) => [
        key,
        (Array.isArray(value) ? [...value] : value) as Json,
      ]),
    );
  schema['x-bc'] = hints;
  return schema;
}

function predicateHolds(predicate: DisabledPredicate, values: Record<string, unknown>): boolean {
  return Object.entries(predicate).every(([key, expected]) => {
    const actual = values[key];
    const allowed: readonly Scalar[] = Array.isArray(expected) ? expected : [expected as Scalar];
    return allowed.some((candidate) => candidate === actual);
  });
}

function describePredicate(predicate: DisabledPredicate): string {
  return Object.entries(predicate)
    .map(
      ([key, value]) =>
        `${key} ${Array.isArray(value) ? `in (${value.join(', ')})` : `= ${value}`}`,
    )
    .join(' and ');
}

/**
 * Declares a configuration schema from fields (§5.3). Unknown keys are rejected, defaults are
 * applied, and durations validate to milliseconds.
 *
 * ```ts
 * const config = manifest({ token: field.secret(), timeout: field.duration().default('10m') });
 * type Config = manifest.Infer<typeof config>; // { token: SecretRef; timeout: number }
 * ```
 */
export function manifest<const S extends FieldShape>(fields: S): ConfigManifest<S> {
  const entries = Object.entries(fields);
  for (const [key, entry] of entries) {
    if (!keyPattern.test(key) || reservedKeys.has(key))
      throw new ComputeError(
        'INVALID_CONFIG',
        `Invalid manifest field name ${JSON.stringify(key)}`,
      );
    if (!internals.has(entry))
      throw new ComputeError('INVALID_CONFIG', `Manifest field ${key} must be built with field.*`);
    const predicate = entry.spec.disabledWhen;
    for (const target of Object.keys(predicate ?? {})) {
      const referenced = fields[target];
      if (!referenced || target === key)
        throw new ComputeError(
          'INVALID_CONFIG',
          `${key}.disabledWhen names unknown field ${target}`,
        );
      if (referenced.spec.disabledWhen)
        throw new ComputeError(
          'INVALID_CONFIG',
          `${key}.disabledWhen cannot depend on ${target}, which can itself be disabled`,
        );
    }
  }

  const validate = (value: unknown): StandardSchemaV1.Result<ManifestOutput<S>> => {
    if (!isRecord(value)) return { issues: [{ message: 'Expected an object' }] };
    const issues: StandardSchemaV1.Issue[] = [];
    for (const key of Object.keys(value))
      if (!Object.hasOwn(fields, key))
        issues.push({ message: `Unknown field ${key}`, path: [key] });
    const output: Record<string, unknown> = {};
    const settle = (key: string, entry: AnyField) => {
      const raw = Object.hasOwn(value, key) ? value[key] : undefined;
      if (raw === undefined) {
        const state = internals.get(entry)!;
        if (state.hasDefault) output[key] = copy(state.fallback);
        else if (entry.spec.presence === 'required')
          issues.push({ message: 'Required', path: [key] });
        return;
      }
      const parsed = entry.parse(raw, [key]);
      if ('issues' in parsed) issues.push(...parsed.issues);
      else output[key] = parsed.value;
    };
    // Fields a predicate can disable are settled after the fields their predicates read.
    for (const [key, entry] of entries) if (!entry.spec.disabledWhen) settle(key, entry);
    for (const [key, entry] of entries) {
      const predicate = entry.spec.disabledWhen;
      if (!predicate) continue;
      if (!predicateHolds(predicate, output)) settle(key, entry);
      else if (Object.hasOwn(value, key) && value[key] !== undefined)
        issues.push({
          message: `${key} is not available when ${describePredicate(predicate)}`,
          path: [key],
        });
    }
    return issues.length ? { issues } : { value: output as ManifestOutput<S> };
  };

  const schema: ConfigManifest<S> = {
    fields,
    '~standard': { version: 1, vendor: 'better-compute', validate, types: undefined },
    parse(value) {
      const result = validate(value);
      if (result.issues) throw invalidConfiguration(result.issues);
      return result.value;
    },
    jsonSchema() {
      const properties: JsonSchema = {};
      const required: string[] = [];
      for (const [key, entry] of entries) {
        properties[key] = fieldSchema(entry.spec);
        if (entry.spec.presence === 'required') required.push(key);
      }
      return {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties,
        required,
        additionalProperties: false,
      };
    },
    async suggest(key, context) {
      const entry = Object.hasOwn(fields, key) ? fields[key] : undefined;
      if (!entry) throw new ComputeError('INVALID_INPUT', `Unknown manifest field ${key}`);
      const source = internals.get(entry)?.suggest;
      if (!source) return [];
      const suggestions = await source(context);
      return suggestions.map((entry) =>
        typeof entry === 'string' ? { value: entry } : { ...entry },
      );
    },
    redact(value) {
      const output: Record<string, unknown> = { ...value };
      for (const [key, entry] of entries)
        if (entry.spec.masked && output[key] !== undefined) output[key] = maskedValue;
      return output;
    },
  };
  return Object.freeze(schema);
}

export declare namespace manifest {
  /** The validated configuration type of a manifest (or any Standard Schema). */
  type Infer<M extends StandardSchemaV1> = StandardSchemaV1.InferOutput<M>;
  /** The accepted input type of a manifest (or any Standard Schema). */
  type Input<M extends StandardSchemaV1> = StandardSchemaV1.InferInput<M>;
}

/**
 * Validates `value` against any `Manifest` (sync or async Standard Schema) and returns the output,
 * or throws `INVALID_INPUT` with the issues in `details.issues`.
 */
export async function validateManifest<C>(schema: Manifest<C>, value: unknown): Promise<C> {
  const result = await schema['~standard'].validate(value);
  if (result.issues) throw invalidConfiguration(result.issues);
  return result.value;
}

/** `INVALID_INPUT` carrying Standard Schema issues as `details.issues: {message, path: string[]}[]`. */
function invalidConfiguration(issues: ReadonlyArray<StandardSchemaV1.Issue>): ComputeError {
  const first = issues[0];
  const path = (entry: StandardSchemaV1.Issue) =>
    (entry.path ?? []).map((segment) =>
      typeof segment === 'object' ? String(segment.key) : String(segment),
    );
  const where = first && path(first).length ? `${path(first).join('.')}: ` : '';
  return new ComputeError(
    'INVALID_INPUT',
    `${where}${first?.message ?? 'Invalid configuration'}`,
    undefined,
    { issues: issues.map((entry) => ({ message: entry.message, path: path(entry) })) },
  );
}
