import { terminalSafe, usageError } from './errors.js';

/** How a command prints its result: `json` (indented, the default), `compact` (one line), or `table`. */
export type OutputFormat = 'json' | 'compact' | 'table';
export const outputFormats: readonly OutputFormat[] = ['json', 'compact', 'table'];

const unsafeKeys = new Set(['__proto__', 'constructor', 'prototype']);

/** Splits `a.b[0].c` / `items[].id` into segments; `[]` maps the rest of the path over an array. */
function segments(path: string): string[] {
  const parts: string[] = [];
  for (const piece of path.split('.')) {
    const match = /^([^[\]]*)((?:\[\d*\])*)$/.exec(piece);
    if (!match)
      throw usageError(`--query ${path} is not a path like findings[].check or protocol.max`);
    if (match[1]) parts.push(match[1]);
    for (const index of match[2]!.match(/\[\d*\]/g) ?? []) parts.push(index.slice(1, -1) || '[]');
  }
  if (!parts.length || parts.some((part) => unsafeKeys.has(part)))
    throw usageError(`--query ${path} is not a usable path`);
  return parts;
}

/**
 * Selects part of a result for `--query`: dotted keys (`protocol.max`), array indexes (`findings.0`
 * or `findings[0]`), and `[]` to map over an array (`findings[].check`). A missing key selects
 * `null` rather than failing, like `jq`.
 */
export function selectPath(value: unknown, path: string): unknown {
  const walk = (current: unknown, parts: string[]): unknown => {
    if (!parts.length) return current;
    const [head, ...rest] = parts as [string, ...string[]];
    if (head === '[]')
      return Array.isArray(current) ? current.map((item) => walk(item, rest)) : null;
    if (current === null || typeof current !== 'object') return null;
    if (Array.isArray(current) && /^\d+$/.test(head))
      return walk(current[Number(head)] ?? null, rest);
    if (head === 'length' && Array.isArray(current)) return walk(current.length, rest);
    return Object.hasOwn(current, head)
      ? walk((current as Record<string, unknown>)[head], rest)
      : null;
  };
  return walk(value, segments(path));
}

/** A table cell: one line, never a control character (cells carry server text such as reasons and names). */
function cell(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
  return typeof value === 'string' || flat.length <= 60 ? flat : `${flat.slice(0, 57)}...`;
}

/** JSON with DEL and the C1 controls escaped too (JSON.stringify leaves U+007F–U+009F raw). */
const safeJson = (text: string) =>
  text.replace(/[\u007f-\u009f]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);

/** The rows a table shows: an array as it is, or the one array inside a result object (`{ findings: [...] }`). */
function tableRows(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return undefined;
  const arrays = Object.values(value).filter(Array.isArray);
  return arrays.length === 1 ? arrays[0] : undefined;
}

/** Renders rows of objects as aligned columns (keys in first-seen order), or an object as key/value lines. */
export function renderTable(value: unknown): string {
  const rows = tableRows(value);
  if (!rows) {
    if (value && typeof value === 'object') {
      const entries = Object.entries(value);
      const width = Math.max(0, ...entries.map(([key]) => key.length));
      return entries.map(([key, item]) => `${key.padEnd(width)}  ${cell(item)}`).join('\n');
    }
    return cell(value);
  }
  if (!rows.length) return '(no rows)';
  if (rows.every((row) => !row || typeof row !== 'object' || Array.isArray(row)))
    return rows.map(cell).join('\n');
  const columns: string[] = [];
  for (const row of rows)
    if (row && typeof row === 'object' && !Array.isArray(row))
      for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key);
  const shown = columns.slice(0, 8);
  const grid = [
    shown.map((column) => column.toUpperCase()),
    ...rows.map((row) =>
      shown.map((column) =>
        cell(row && typeof row === 'object' ? (row as Record<string, unknown>)[column] : undefined),
      ),
    ),
  ];
  const widths = shown.map((_, index) => Math.max(...grid.map((line) => line[index]!.length)));
  const lines = grid.map((line) =>
    line
      .map((text, index) => (index === line.length - 1 ? text : text.padEnd(widths[index]!)))
      .join('  ')
      .trimEnd(),
  );
  if (columns.length > shown.length)
    lines.push(`(${columns.length - shown.length} more column(s); use --format json to see them)`);
  return lines.join('\n');
}

/** Turns a command result into the text printed on stdout. Strings are printed as they are. */
export function formatResult(
  value: unknown,
  format: OutputFormat = 'json',
  query?: string,
): string {
  const selected = query === undefined ? value : selectPath(value, query);
  // A string result (or a --query selecting one) may be the server's words: no escape sequences to the terminal.
  if (typeof selected === 'string') return terminalSafe(selected);
  if (format === 'table') return renderTable(selected);
  const text = JSON.stringify(selected, null, format === 'compact' ? undefined : 2);
  return text === undefined ? 'null' : safeJson(text);
}
