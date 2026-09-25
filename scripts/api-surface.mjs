// The API surface freeze (PLAN.md §16 v1.0): fails when a method, an error code or an input shape
// that a client could depend on goes away or narrows. Additions are fine. `pnpm lint:repo` runs it.
//
//   node scripts/api-surface.mjs            check against the frozen surface
//   node scripts/api-surface.mjs --update   record the current surface (additions; refuses breaks)
//   node scripts/api-surface.mjs --update --accept-breaking   record a deliberate break
//
// The current surface is read from the docs generator's committed output, `apps/docs/generated/api.json`
// (every method of core's apiSurface and the live registry, with its input JSON Schema) and
// `errors.json`; `generate.mjs --check` keeps those equal to the code. The frozen one is
// `generated/api-surface.json`.
//
// Breaking, per served method (`group.method`; a planned one may still change or go): it disappears,
// it becomes planned again, its route,
// kind, IAM action or resource changes, an IAM alternative goes, a list method stops being one, or
// its input schema rejects an input the frozen schema accepted (a new required field, a type, enum
// value or property that goes, a tighter length, range, pattern or item count, a closed object that
// was open). A method without a frozen schema may gain one. Per error code: it disappears or its
// HTTP status changes.
import { existsSync, realpathSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Where the frozen surface lives, repo-relative. */
export const frozenPath = 'generated/api-surface.json';

/**
 * The surface as recorded: methods by `group.method`, error codes with their HTTP status.
 * @param {{ group: string, methods: Record<string, unknown>[] }[]} api  apps/docs/generated/api.json
 * @param {{ code: string, status: number }[]} errors  apps/docs/generated/errors.json
 */
export function surfaceOf(api, errors) {
  const methods = {};
  for (const group of api)
    for (const method of group.methods)
      methods[`${group.group}.${method.method}`] = {
        route: method.route,
        kind: method.kind,
        action: method.action ?? null,
        resource: method.resource ?? null,
        alternatives: (method.alternatives ?? []).map((pair) => `${pair.action} @ ${pair.resource}`).sort(),
        list: method.list === true,
        status: method.status,
        phase: method.phase ?? null,
        input: method.input ?? null,
      };
  const codes = {};
  for (const error of errors) codes[error.code] = error.status;
  return { methods: sortKeys(methods), errors: sortKeys(codes) };
}

function sortKeys(record) {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const typesOf = (schema) => (schema.type === undefined ? undefined : Array.isArray(schema.type) ? schema.type : [schema.type]);
const at = (path) => (path.length ? path.join('.') : '(input)');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Whether `schema` accepts every value (absent, `true` or `{}` modulo annotations). */
function acceptsAll(schema) {
  if (schema === undefined || schema === null || schema === true) return true;
  if (!isObject(schema)) return false;
  const annotations = new Set(['description', 'title', 'examples', 'default', '$comment', 'deprecated']);
  return Object.keys(schema).every((key) => annotations.has(key));
}

/**
 * Where `after` rejects inputs `before` accepted: one message per narrowing, empty when `after`
 * accepts at least everything `before` did. Covers the structural JSON Schema keywords the compute
 * validators use (type, enum, const, lengths, ranges, pattern, format, items, properties, required,
 * additionalProperties, anyOf/oneOf/allOf); anything it does not model, it compares for equality.
 * @param {unknown} before
 * @param {unknown} after
 * @param {string[]} [path]
 * @returns {string[]}
 */
export function narrowings(before, after, path = []) {
  if (acceptsAll(after)) return [];
  if (before === false) return [];
  if (after === false) return [`${at(path)}: now rejects every value`];
  if (acceptsAll(before)) {
    // Anything went before; any constraint now is a narrowing.
    return [`${at(path)}: was unconstrained, now constrained`];
  }
  const out = [];
  const branches = (schema) => schema.anyOf ?? schema.oneOf;
  if (branches(after)) {
    const olds = branches(before) ?? [before];
    for (const [index, old] of olds.entries())
      if (!branches(after).some((option) => narrowings(old, option, path).length === 0))
        out.push(`${at(path)}: ${olds.length > 1 ? `alternative ${index + 1} is` : 'the old shape is'} no longer accepted`);
    return out;
  }
  if (branches(before)) {
    for (const old of branches(before)) out.push(...narrowings(old, after, path));
    return [...new Set(out)];
  }
  for (const part of after.allOf ?? []) out.push(...narrowings(before, part, path));

  const beforeTypes = typesOf(before);
  const afterTypes = typesOf(after);
  if (afterTypes) {
    if (!beforeTypes) out.push(`${at(path)}: now limited to ${afterTypes.join(' | ')}`);
    else
      for (const type of beforeTypes)
        if (!afterTypes.includes(type) && !(type === 'integer' && afterTypes.includes('number')))
          out.push(`${at(path)}: no longer accepts ${type}`);
  }
  if (after.enum !== undefined) {
    const allowed = before.enum ?? (before.const !== undefined ? [before.const] : undefined);
    if (!allowed) out.push(`${at(path)}: now limited to ${JSON.stringify(after.enum)}`);
    else {
      const gone = allowed.filter((value) => !after.enum.some((kept) => same(kept, value)));
      if (gone.length) out.push(`${at(path)}: no longer accepts ${gone.map((v) => JSON.stringify(v)).join(', ')}`);
    }
  }
  if (after.const !== undefined) {
    const allowed = before.enum ?? (before.const !== undefined ? [before.const] : undefined);
    if (!allowed || allowed.some((value) => !same(value, after.const)))
      out.push(`${at(path)}: now only ${JSON.stringify(after.const)}`);
  }
  const tighterMin = (key) => {
    if (after[key] !== undefined && (before[key] === undefined || after[key] > before[key]))
      out.push(`${at(path)}: ${key} ${before[key] ?? 'none'} → ${after[key]}`);
  };
  const tighterMax = (key) => {
    if (after[key] !== undefined && (before[key] === undefined || after[key] < before[key]))
      out.push(`${at(path)}: ${key} ${before[key] ?? 'none'} → ${after[key]}`);
  };
  for (const key of ['minLength', 'minimum', 'exclusiveMinimum', 'minItems', 'minProperties']) tighterMin(key);
  for (const key of ['maxLength', 'maximum', 'exclusiveMaximum', 'maxItems', 'maxProperties']) tighterMax(key);
  for (const key of ['pattern', 'format', 'multipleOf'])
    if (after[key] !== undefined && after[key] !== before[key])
      out.push(`${at(path)}: ${key} ${JSON.stringify(before[key] ?? null)} → ${JSON.stringify(after[key])}`);
  if (after.uniqueItems === true && before.uniqueItems !== true) out.push(`${at(path)}: items must now be unique`);
  if (after.items !== undefined) out.push(...narrowings(before.items ?? {}, after.items, [...path, '[]']));

  // Objects.
  const oldProps = isObject(before.properties) ? before.properties : {};
  const newProps = isObject(after.properties) ? after.properties : {};
  const oldRequired = new Set(before.required ?? []);
  for (const key of after.required ?? [])
    if (!oldRequired.has(key)) out.push(`${at([...path, key])}: now required`);
  const oldExtra = before.additionalProperties;
  const newExtra = after.additionalProperties;
  for (const [key, schema] of Object.entries(oldProps)) {
    if (key in newProps) out.push(...narrowings(schema, newProps[key], [...path, key]));
    else if (newExtra === false) out.push(`${at([...path, key])}: no longer accepted`);
    else if (isObject(newExtra)) out.push(...narrowings(schema, newExtra, [...path, key]));
  }
  if (oldExtra !== false) {
    // Keys beyond the old properties were accepted (as `oldExtra`); they must still be.
    if (newExtra === false) out.push(`${at(path)}: no longer accepts other properties`);
    else if (isObject(newExtra)) out.push(...narrowings(oldExtra ?? {}, newExtra, [...path, '*']));
    for (const [key, schema] of Object.entries(newProps))
      if (!(key in oldProps)) out.push(...narrowings(oldExtra ?? {}, schema, [...path, key]));
  }
  return out;
}

/**
 * Compares the frozen surface with the current one.
 * @returns {{ breaking: string[], added: string[] }}
 */
export function compareSurfaces(frozen, current) {
  const breaking = [];
  const added = [];
  for (const [name, old] of Object.entries(frozen.methods ?? {})) {
    const now = current.methods[name];
    // A planned method is not served yet: nothing can depend on it, so it may change or go.
    if (old.status !== 'registered') {
      if (!same(old, now)) added.push(`${name}: ${now ? 'changed' : 'dropped'} while planned`);
      continue;
    }
    if (!now) {
      breaking.push(`${name}: removed`);
      continue;
    }
    if (now.status !== 'registered') breaking.push(`${name}: no longer served (now ${now.status})`);
    for (const key of ['route', 'kind', 'action', 'resource'])
      if (old[key] !== now[key]) breaking.push(`${name}: ${key} ${JSON.stringify(old[key])} → ${JSON.stringify(now[key])}`);
    for (const alternative of old.alternatives ?? [])
      if (!(now.alternatives ?? []).includes(alternative)) breaking.push(`${name}: IAM alternative ${alternative} removed`);
    if (old.list && !now.list) breaking.push(`${name}: no longer a list method`);
    if (old.input && now.input) for (const problem of narrowings(old.input, now.input)) breaking.push(`${name}: ${problem}`);
    if (!same(old, now) && !breaking.some((line) => line.startsWith(`${name}:`))) added.push(`${name}: changed compatibly`);
  }
  for (const name of Object.keys(current.methods)) if (!(name in (frozen.methods ?? {}))) added.push(`${name}: new`);
  for (const [code, status] of Object.entries(frozen.errors ?? {})) {
    if (!(code in current.errors)) breaking.push(`error ${code}: removed`);
    else if (current.errors[code] !== status) breaking.push(`error ${code}: HTTP ${status} → ${current.errors[code]}`);
  }
  for (const code of Object.keys(current.errors)) if (!(code in (frozen.errors ?? {}))) added.push(`error ${code}: new`);
  return { breaking, added };
}

/** True when run as `node scripts/api-surface.mjs`, false when a test imports it. */
function invokedDirectly() {
  const normal = (path) => (process.platform === 'win32' ? path.toLowerCase() : path);
  try {
    return normal(realpathSync(process.argv[1] ?? '')) === normal(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const generated = join(root, 'apps', 'docs', 'generated');
  const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));
  const current = surfaceOf(await readJson(join(generated, 'api.json')), await readJson(join(generated, 'errors.json')));
  const file = join(root, frozenPath);
  const frozen = existsSync(file) ? await readJson(file) : { methods: {}, errors: {} };
  const { breaking, added } = compareSurfaces(frozen, current);
  const update = process.argv.includes('--update');
  for (const line of breaking) console.error(`BREAKING ${line}`);
  if (update) {
    if (breaking.length > 0 && !process.argv.includes('--accept-breaking')) {
      console.error(`${breaking.length} breaking change(s); not recorded. Pass --accept-breaking to record a deliberate break.`);
      process.exitCode = 1;
    } else {
      await mkdir(dirname(file), { recursive: true });
      const body = {
        $comment: 'The frozen compute API surface (PLAN.md §16 v1.0). Written by `node scripts/api-surface.mjs --update`; do not edit.',
        ...current,
      };
      await writeFile(file, `${JSON.stringify(body, null, 2)}\n`);
      console.log(`Recorded ${Object.keys(current.methods).length} methods and ${Object.keys(current.errors).length} error codes in ${frozenPath} (${added.length} addition(s) or compatible change(s)).`);
    }
  } else if (breaking.length > 0) {
    console.error(`${breaking.length} breaking change(s) to the API surface; see PLAN.md §16 v1.0 and ${frozenPath}.`);
    process.exitCode = 1;
  } else {
    const note = added.length ? `; ${added.length} addition(s) or compatible change(s) not yet recorded (node scripts/api-surface.mjs --update)` : '';
    console.log(`API surface compatible with ${frozenPath}: ${Object.keys(current.methods).length} methods, ${Object.keys(current.errors).length} error codes${note}.`);
  }
}
