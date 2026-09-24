import {
  ComputeError,
  type DeviceSelector,
  type MatchExpression,
  type MatchOperator,
} from '@better-compute/core';

/** What a selector is evaluated against: one device's attributes, then its node's labels. */
export interface SelectorSubject {
  attributes?: Readonly<Record<string, string | number | boolean>>;
  labels?: Readonly<Record<string, string>>;
}

const operators: readonly MatchOperator[] = [
  'In',
  'NotIn',
  'Exists',
  'DoesNotExist',
  'Gt',
  'Gte',
  'Lt',
  'Lte',
];
const keyPattern = /^[A-Za-z][A-Za-z0-9._/-]{0,127}$/;
const maxExpressions = 32;
const maxValues = 64;

function lookup(subject: SelectorSubject, key: string): string | number | boolean | undefined {
  if (subject.attributes && Object.hasOwn(subject.attributes, key)) return subject.attributes[key];
  if (subject.labels && Object.hasOwn(subject.labels, key)) return subject.labels[key];
  return undefined;
}

function toNumber(value: string | number | boolean | undefined): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** One expression against one subject. Comparisons are numeric; `In`/`NotIn` compare as strings. */
export function matchesExpression(expression: MatchExpression, subject: SelectorSubject): boolean {
  const value = lookup(subject, expression.key);
  const values = expression.values ?? [];
  switch (expression.op) {
    case 'Exists':
      return value !== undefined;
    case 'DoesNotExist':
      return value === undefined;
    case 'In':
      return value !== undefined && values.some((candidate) => String(candidate) === String(value));
    case 'NotIn':
      return (
        value === undefined || !values.some((candidate) => String(candidate) === String(value))
      );
    default: {
      const left = toNumber(value);
      const right = toNumber(values[0]);
      if (left === undefined || right === undefined) return false;
      if (expression.op === 'Gt') return left > right;
      if (expression.op === 'Gte') return left >= right;
      if (expression.op === 'Lt') return left < right;
      return left <= right;
    }
  }
}

/** Every expression holds (an absent or empty selector matches everything). */
export function matchesSelector(
  selector: DeviceSelector | undefined,
  subject: SelectorSubject,
): boolean {
  if (!selector) return true;
  return selector.matchExpressions.every((expression) => matchesExpression(expression, subject));
}

/** Checks a selector's shape; throws `INVALID_INPUT` naming the first problem. */
export function assertSelector(selector: unknown): asserts selector is DeviceSelector {
  const fail = (message: string): never => {
    throw new ComputeError('INVALID_INPUT', `Invalid selector: ${message}`);
  };
  if (typeof selector !== 'object' || selector === null) fail('expected an object');
  const expressions = (selector as { matchExpressions?: unknown }).matchExpressions;
  if (!Array.isArray(expressions)) fail('matchExpressions must be an array');
  const list = expressions as unknown[];
  if (list.length > maxExpressions) fail(`at most ${maxExpressions} expressions`);
  list.forEach((raw, index) => {
    if (typeof raw !== 'object' || raw === null) fail(`expression ${index} is not an object`);
    const { key, op, values } = raw as { key?: unknown; op?: unknown; values?: unknown };
    if (typeof key !== 'string' || !keyPattern.test(key)) fail(`expression ${index} has a bad key`);
    if (!operators.includes(op as MatchOperator)) fail(`expression ${index} has a bad op`);
    const unary = op === 'Exists' || op === 'DoesNotExist';
    if (unary) {
      if (values !== undefined && !(Array.isArray(values) && values.length === 0))
        fail(`${String(op)} takes no values (expression ${index})`);
      return;
    }
    if (!Array.isArray(values) || values.length === 0)
      fail(`${String(op)} needs values (expression ${index})`);
    const items = values as unknown[];
    if (items.length > maxValues) fail(`at most ${maxValues} values (expression ${index})`);
    for (const item of items)
      if (typeof item !== 'string' && !(typeof item === 'number' && Number.isFinite(item)))
        fail(`values must be strings or finite numbers (expression ${index})`);
    const comparison = op === 'Gt' || op === 'Gte' || op === 'Lt' || op === 'Lte';
    if (comparison && (items.length !== 1 || toNumber(items[0] as string | number) === undefined))
      fail(`${String(op)} takes exactly one numeric value (expression ${index})`);
  });
}

function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (depth < 0) throw new ComputeError('INVALID_INPUT', 'Unbalanced ")" in selector');
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else current += char;
  }
  if (depth !== 0) throw new ComputeError('INVALID_INPUT', 'Unbalanced "(" in selector');
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

function literal(raw: string): string | number {
  const value = raw.trim();
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

const setPattern = /^([A-Za-z][A-Za-z0-9._/-]*)\s+(in|notin)\s*\((.*)\)$/i;
const comparePattern = /^([A-Za-z][A-Za-z0-9._/-]*)\s*(>=|<=|==|!=|=|>|<)\s*(\S.*)$/;
const comparisons: Record<string, MatchOperator> = {
  '>': 'Gt',
  '>=': 'Gte',
  '<': 'Lt',
  '<=': 'Lte',
  '=': 'In',
  '==': 'In',
  '!=': 'NotIn',
};

/**
 * Parses the CLI shorthand (PLAN.md §10.3) into a selector:
 * `gpuProduct in (H100-SXM5-80GB), vramGiB >= 80, mig.capable, !fabric.domain`.
 * `key` alone is `Exists`, `!key` is `DoesNotExist`, `=`/`!=` are one-value `In`/`NotIn`.
 */
export function parseSelector(text: string): DeviceSelector {
  const matchExpressions: MatchExpression[] = splitTopLevel(text).map((part) => {
    const set = setPattern.exec(part);
    if (set) {
      const values = splitTopLevel(set[3]!).map(literal);
      return { key: set[1]!, op: set[2]!.toLowerCase() === 'in' ? 'In' : 'NotIn', values };
    }
    const compare = comparePattern.exec(part);
    if (compare)
      return { key: compare[1]!, op: comparisons[compare[2]!]!, values: [literal(compare[3]!)] };
    if (part.startsWith('!') && keyPattern.test(part.slice(1).trim()))
      return { key: part.slice(1).trim(), op: 'DoesNotExist' };
    if (keyPattern.test(part)) return { key: part, op: 'Exists' };
    throw new ComputeError('INVALID_INPUT', `Cannot parse selector term ${JSON.stringify(part)}`);
  });
  const selector = { matchExpressions };
  assertSelector(selector);
  return selector;
}

/** The inverse of `parseSelector`, for display. */
export function formatSelector(selector: DeviceSelector): string {
  const symbols: Partial<Record<MatchOperator, string>> = {
    Gt: '>',
    Gte: '>=',
    Lt: '<',
    Lte: '<=',
  };
  return selector.matchExpressions
    .map(({ key, op, values = [] }) => {
      if (op === 'Exists') return key;
      if (op === 'DoesNotExist') return `!${key}`;
      if (op === 'In' || op === 'NotIn')
        return `${key} ${op === 'In' ? 'in' : 'notin'} (${values.join(', ')})`;
      return `${key} ${symbols[op]} ${values[0]}`;
    })
    .join(', ');
}
