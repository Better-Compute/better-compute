import { ComputeError } from './errors.js';

// JSON Schema descriptions of method inputs (`MethodDefinition.validate.jsonSchema`), for the generated
// API reference and tool schemas, in the server's convention: strict objects, `INVALID_INPUT` with
// `details.issues: { message, path }[]`.
//
// `describedBy(schema, validate)` checks the input's structure against the schema first (the type of
// every field, required and unknown fields, enums), reporting every structural issue at once; the
// method's own validator then applies the domain rules (patterns, ranges, "exactly one of") and keeps
// its messages. `manifest(...)` inputs describe themselves already: pass `m.jsonSchema()` and `m.parse`.

/** A JSON Schema node (2020-12 keywords; only the structural ones are checked by `describedBy`). */
export type InputSchema = { readonly [keyword: string]: unknown };

/** An input validator that carries the JSON Schema it checks. */
export type DescribedValidator<I> = ((raw: unknown) => I) & { readonly jsonSchema: InputSchema };

interface Issue {
  message: string;
  path: string[];
}

const typeNames: Record<string, string> = {
  string: 'a string',
  integer: 'an integer',
  number: 'a number',
  boolean: 'true or false',
  object: 'an object',
  array: 'an array',
  null: 'null',
};

function hasType(type: string, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'integer':
      return typeof value === 'number' && Number.isSafeInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'null':
      return value === null;
    default:
      return true;
  }
}

function walk(schema: InputSchema, value: unknown, path: string[], issues: Issue[]): void {
  const types = schema.type === undefined ? [] : [schema.type].flat().map(String);
  if (types.length > 0 && !types.some((type) => hasType(type, value))) {
    issues.push({
      message: `Expected ${types.map((type) => typeNames[type] ?? type).join(' or ')}`,
      path,
    });
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    issues.push({ message: `Must be one of ${schema.enum.join(', ')}`, path });
    return;
  }
  if (Array.isArray(value) && schema.items && typeof schema.items === 'object') {
    value.forEach((item, index) =>
      walk(schema.items as InputSchema, item, [...path, String(index)], issues),
    );
    return;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  const properties = (schema.properties ?? undefined) as Record<string, InputSchema> | undefined;
  if (properties) {
    if (schema.additionalProperties === false)
      for (const key of Object.keys(record))
        if (!Object.hasOwn(properties, key))
          issues.push({ message: `Unknown field ${key}`, path: [...path, key] });
    for (const key of (schema.required ?? []) as string[])
      if (record[key] === undefined) issues.push({ message: 'Required', path: [...path, key] });
    for (const [key, property] of Object.entries(properties))
      if (record[key] !== undefined) walk(property, record[key], [...path, key], issues);
  } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
    for (const [key, item] of Object.entries(record))
      walk(schema.additionalProperties as InputSchema, item, [...path, key], issues);
  }
}

/** `validate` with its input described by `schema`: structural issues first, all at once. */
export function describedBy<I>(schema: InputSchema, validate: (raw: unknown) => I): DescribedValidator<I> {
  return Object.assign(
    (raw: unknown) => {
      const issues: Issue[] = [];
      walk(schema, raw, [], issues);
      if (issues.length > 0) {
        const first = issues[0]!;
        const where = first.path.length ? `${first.path.join('.')}: ` : '';
        throw new ComputeError('INVALID_INPUT', `${where}${first.message}`, undefined, { issues });
      }
      return validate(raw);
    },
    { jsonSchema: schema },
  );
}

/** A strict object schema: only `properties`, with `required` present. */
export function strictObject(
  properties: Readonly<Record<string, InputSchema>>,
  required: readonly string[] = [],
): InputSchema {
  return { type: 'object', properties, required: [...required], additionalProperties: false };
}
