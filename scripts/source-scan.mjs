// Lexes TypeScript source just far enough to tell code, comments, strings and template text apart.
// check-deps.mjs reads import specifiers through it and check-sql-now.mjs reads string text, so
// neither is fooled by comments, JSDoc examples or code inside template substitutions.
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

/** Words after which a `/` starts a regular expression rather than a division. */
const regexAfterWords = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

/**
 * @typedef {object} Token
 * @property {'name' | 'number' | 'punct' | 'string' | 'template' | 'regex'} type
 * @property {string} value  A string's unquoted value; a template chunk's raw text; otherwise the source text.
 * @property {number} start  Source offset of the text (for strings and templates: inside the quotes).
 * @property {number} end
 * @property {boolean} [complete]  A template chunk that is a whole template without substitutions.
 */

const isSpace = (c) => /\s/.test(c);
const isNameStart = (c) => /[A-Za-z_$#]/.test(c) || c > '\u007f';
const isNamePart = (c) => /[\w$]/.test(c) || c > '\u007f';

/**
 * Splits source into tokens, dropping whitespace and comments. A template literal becomes one
 * `template` token per literal chunk; its substitutions are tokenized as code. Regular expressions
 * are told from division by the previous token, which is enough for real code.
 * @param {string} source
 * @returns {Token[]}
 */
export function tokenize(source) {
  /** @type {Token[]} */
  const tokens = [];
  /** One entry per open `{` (`code`) or `${` (`template`). */
  const braces = [];
  const n = source.length;
  let i = source.startsWith('#!') ? source.indexOf('\n') : 0;
  if (i < 0) i = n;

  /** Reads template text from `from` (just after a backtick or a substitution's `}`). */
  const readTemplate = (from, whole) => {
    let j = from;
    while (j < n) {
      const c = source[j];
      if (c === '\\') j += 2;
      else if (c === '`') {
        tokens.push({
          type: 'template',
          value: source.slice(from, j),
          start: from,
          end: j,
          complete: whole,
        });
        return j + 1;
      } else if (c === '$' && source[j + 1] === '{') {
        tokens.push({
          type: 'template',
          value: source.slice(from, j),
          start: from,
          end: j,
          complete: false,
        });
        braces.push('template');
        return j + 2;
      } else j++;
    }
    tokens.push({
      type: 'template',
      value: source.slice(from),
      start: from,
      end: n,
      complete: false,
    });
    return n;
  };
  const regexAllowed = () => {
    const previous = tokens[tokens.length - 1];
    if (!previous) return true;
    if (previous.type === 'punct') return !/^[)\]}]$/.test(previous.value);
    if (previous.type === 'name') return regexAfterWords.has(previous.value);
    return false;
  };

  while (i < n) {
    const c = source[i];
    if (isSpace(c)) {
      i++;
    } else if (c === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i);
      i = end < 0 ? n : end;
    } else if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      let value = '';
      while (j < n && source[j] !== c && source[j] !== '\n') {
        if (source[j] === '\\') {
          value += source[j + 1] ?? '';
          j += 2;
        } else value += source[j++];
      }
      tokens.push({ type: 'string', value, start: i + 1, end: Math.min(j, n) });
      i = j + 1;
    } else if (c === '`') {
      i = readTemplate(i + 1, true);
    } else if (c === '{') {
      braces.push('code');
      tokens.push({ type: 'punct', value: c, start: i, end: i + 1 });
      i++;
    } else if (c === '}') {
      if (braces.pop() === 'template') i = readTemplate(i + 1, false);
      else {
        tokens.push({ type: 'punct', value: c, start: i, end: i + 1 });
        i++;
      }
    } else if (c === '/' && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      while (j < n && source[j] !== '\n') {
        const d = source[j];
        if (d === '\\') j++;
        else if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) break;
        j++;
      }
      j++;
      while (j < n && isNamePart(source[j])) j++;
      tokens.push({ type: 'regex', value: source.slice(i, j), start: i, end: j });
      i = j;
    } else if (isNameStart(c)) {
      let j = i + 1;
      while (j < n && isNamePart(source[j])) j++;
      tokens.push({ type: 'name', value: source.slice(i, j), start: i, end: j });
      i = j;
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(source[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(source[j])) j++;
      tokens.push({ type: 'number', value: source.slice(i, j), start: i, end: j });
      i = j;
    } else {
      tokens.push({ type: 'punct', value: c, start: i, end: i + 1 });
      i++;
    }
  }
  return tokens;
}

/**
 * Module specifiers a source file imports or re-exports, in first-seen order: `import … from`,
 * `export … from`, side-effect `import '…'`, `import('…')` (also in type positions) and
 * `require('…')` with a literal argument. Type-only imports count.
 * @param {string} source
 * @returns {string[]}
 */
export function importSpecifiers(source) {
  const tokens = tokenize(source);
  const found = new Set();
  const literal = (token) =>
    token?.type === 'string' || (token?.type === 'template' && token.complete)
      ? token.value
      : undefined;
  const isPunct = (token, value) => token?.type === 'punct' && token.value === value;
  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k];
    if (token.type !== 'name' || isPunct(tokens[k - 1], '.')) continue;
    const next = tokens[k + 1];
    if ((token.value === 'from' || token.value === 'import') && next?.type === 'string') {
      // `from '…'` can only end an import or export declaration; `import '…'` is a side-effect import.
      found.add(next.value);
    } else if ((token.value === 'import' || token.value === 'require') && isPunct(next, '(')) {
      const specifier = literal(tokens[k + 2]);
      if (specifier !== undefined && (isPunct(tokens[k + 3], ')') || isPunct(tokens[k + 3], ',')))
        found.add(specifier);
    }
  }
  return [...found];
}

/**
 * The text of every string literal and template chunk, with its source offset. Template
 * substitutions are code, so they are not included.
 * @param {string} source
 * @returns {{ text: string, start: number }[]}
 */
export function stringChunks(source) {
  return tokenize(source)
    .filter((token) => token.type === 'string' || token.type === 'template')
    .map((token) => ({ text: source.slice(token.start, token.end), start: token.start }));
}

/**
 * The package a bare specifier names (`@scope/name` or `name`), or `undefined` for relative,
 * absolute, `node:` and `#` subpath-import specifiers.
 * @param {string} specifier
 */
export function packageName(specifier) {
  if (/^(?:\.|\/|#|[A-Za-z]:|node:|data:|file:)/.test(specifier)) return undefined;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** 1-based line and column of `offset` in `source`. */
export function lineColumn(source, offset) {
  const before = source.slice(0, offset);
  const line = before.split('\n').length;
  return { line, column: offset - before.lastIndexOf('\n') };
}

/**
 * TypeScript source files under `directory`, as POSIX paths relative to it (empty when it does not exist).
 * @param {string} directory
 */
export async function sourceFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory, { recursive: true, withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && /\.(?:[mc]?ts|tsx)$/.test(entry.name))
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)).replaceAll('\\', '/'))
    .sort();
}
