// The daemon protocol's shape and comments from the .proto sources (the TypeScript descriptors drop
// comments), for the generated reference/protocol page. No dependencies: a small reader for the
// subset of proto3 the repository uses (package, service/rpc, message with nested messages and enums,
// oneof, map, repeated/optional, enum, reserved/option lines), keeping each declaration's leading
// `//` comment (or its trailing one on the same line).
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/** Every .proto under `dir`, sorted. */
export async function protoFiles(dir) {
  const out = [];
  const walk = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith('.proto')) out.push(path);
    }
  };
  await walk(dir);
  return out.sort();
}

const tokenPattern = /\/\/[^\n]*|"(?:[^"\\]|\\.)*"|[A-Za-z_][\w.]*|\d+|[{}()<>;=,[\]]/g;

/** Parses one .proto file's text. */
export function parseProto(text, file) {
  // Comments first: a line comment immediately above a declaration (no blank line between) is its
  // description; a dashed rule starts a new section (its title is the comment line after it).
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const leading = new Map(); // line index → comment text
  const trailing = new Map();
  let block = [];
  let header = [];
  let beforeSyntax = true;
  lines.forEach((raw, index) => {
    const line = raw.trim();
    const comment = /^\/\/ ?(.*)$/.exec(line);
    if (comment) {
      const body = comment[1];
      if (/^-{5,}$/.test(body.trim())) {
        block = [];
        return;
      }
      block.push(body);
      return;
    }
    if (beforeSyntax && /^syntax\s*=/.test(line)) {
      header = block;
      beforeSyntax = false;
      block = [];
      return;
    }
    if (line && block.length) leading.set(index, block.join('\n').trim());
    if (!line) block = [];
    else block = [];
    const tail = /;\s*\/\/ ?(.*)$/.exec(raw);
    if (tail) trailing.set(index, tail[1].trim());
  });
  const describe = (index) => leading.get(index) ?? trailing.get(index) ?? '';

  const result = {
    file,
    package: '',
    description: header.join('\n').trim(),
    services: [],
    messages: [],
    enums: [],
  };
  // A line-oriented walk with a scope stack: declarations are one per line in this repository.
  const stack = [];
  const scopeName = () => stack.filter((scope) => scope.kind === 'message').map((scope) => scope.name).join('.');
  lines.forEach((raw, index) => {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (!line) return;
    let match;
    if ((match = /^package\s+([\w.]+)\s*;/.exec(line))) {
      result.package = match[1];
    } else if ((match = /^service\s+(\w+)\s*\{/.exec(line))) {
      const service = { name: match[1], description: describe(index), rpcs: [] };
      result.services.push(service);
      stack.push({ kind: 'service', name: match[1], target: service });
    } else if ((match = /^rpc\s+(\w+)\s*\(\s*(stream\s+)?([\w.]+)\s*\)\s*returns\s*\(\s*(stream\s+)?([\w.]+)\s*\)/.exec(line))) {
      stack.at(-1)?.target.rpcs.push({
        name: match[1],
        request: match[3],
        clientStreaming: Boolean(match[2]),
        response: match[5],
        serverStreaming: Boolean(match[4]),
        description: describe(index),
      });
    } else if ((match = /^message\s+(\w+)\s*\{/.exec(line))) {
      const parent = scopeName();
      const message = { name: parent ? `${parent}.${match[1]}` : match[1], description: describe(index), fields: [] };
      result.messages.push(message);
      stack.push({ kind: 'message', name: match[1], target: message });
      if (/\}\s*$/.test(line)) stack.pop(); // `message Empty {}`
    } else if ((match = /^enum\s+(\w+)\s*\{/.exec(line))) {
      const parent = scopeName();
      const en = { name: parent ? `${parent}.${match[1]}` : match[1], description: describe(index), values: [] };
      result.enums.push(en);
      stack.push({ kind: 'enum', name: match[1], target: en });
    } else if ((match = /^oneof\s+(\w+)\s*\{/.exec(line))) {
      stack.push({ kind: 'oneof', name: match[1], target: stack.at(-1)?.target });
    } else if (/^\}/.test(line)) {
      stack.pop();
    } else if (/^(reserved|option|extensions)\b/.test(line)) {
      // not part of the documented shape
    } else {
      const scope = stack.at(-1);
      if (!scope) return;
      if (scope.kind === 'enum' && (match = /^(\w+)\s*=\s*(-?\d+)/.exec(line))) {
        scope.target.values.push({ name: match[1], number: Number(match[2]), description: describe(index) });
      } else if (
        (scope.kind === 'message' || scope.kind === 'oneof') &&
        (match = /^(?:(repeated|optional)\s+)?(map\s*<\s*[\w.]+\s*,\s*[\w.]+\s*>|[\w.]+)\s+(\w+)\s*=\s*(\d+)/.exec(line))
      ) {
        const field = {
          name: match[3],
          number: Number(match[4]),
          type: match[2].replace(/\s+/g, ''),
          label: match[1] ?? '',
          description: describe(index),
        };
        if (scope.kind === 'oneof') field.oneof = scope.name;
        scope.target.fields.push(field);
      }
    }
  });
  return result;
}

/** Every .proto under `dir`, parsed, with repository-relative paths. */
export async function readProtocol(dir, root) {
  const files = [];
  for (const path of await protoFiles(dir))
    files.push(parseProto(await readFile(path, 'utf8'), relative(root, path).split(sep).join('/')));
  return files;
}

// tokenPattern is kept for future use by a stricter reader.
void tokenPattern;
