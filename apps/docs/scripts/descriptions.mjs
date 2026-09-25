// The hand-written text the generator merges into the reference pages, and its validation. No
// dependencies, so tests/docs-generate.test.ts runs it without the packages being built:
//
//   descriptions/api/<group>.md   an overview paragraph, then `## method` sections whose first
//                                 paragraph is the method's summary
//   descriptions/errors.md        `## CODE` sections
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** `## heading` sections of Markdown text: the text before the first heading is `''`. */
export function parseSections(text) {
  const out = new Map();
  let current = '';
  let buffer = [];
  let fence = false;
  const flush = () => {
    const body = buffer.join('\n').trim();
    if (body) out.set(current, body);
  };
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const heading = fence ? null : /^## (.+)$/.exec(line);
    if (heading) {
      flush();
      current = heading[1].trim();
      buffer = [];
    } else buffer.push(line);
  }
  flush();
  return out;
}

/** The sections of a Markdown file; an absent file has none. */
export async function sections(path) {
  if (!existsSync(path)) return new Map();
  return parseSections(await readFile(path, 'utf8'));
}

/** The first paragraph as one line (a method's summary, an error's meaning). */
export const firstParagraph = (text) => (text ?? '').split(/\n\s*\n/)[0].replace(/\s+/g, ' ').trim();

/**
 * Problems in `descriptions/` against what the generator knows: a file for an unknown group, a
 * `## heading` naming no method of its group or no error code, a heading given twice. `api` is
 * generated/api.json's shape (`[{ group, slug, methods: [{ method }] }]`), `errorCodes` a string list.
 */
export async function checkDescriptions(docs, { api, errorCodes }) {
  const problems = [];
  const dir = join(docs, 'descriptions');
  const groups = new Map(api.map((entry) => [entry.group, entry]));
  const apiDir = join(dir, 'api');
  if (existsSync(apiDir)) {
    for (const name of (await readdir(apiDir)).sort()) {
      const path = `descriptions/api/${name}`;
      if (!name.endsWith('.md')) {
        problems.push(`${path}: only <group>.md files belong here`);
        continue;
      }
      const group = groups.get(name.slice(0, -3));
      if (!group) {
        problems.push(`${path}: no API group ${name.slice(0, -3)} (groups are named as in generated/api.json)`);
        continue;
      }
      const text = await readFile(join(apiDir, name), 'utf8');
      const methods = new Set(group.methods.map((method) => method.method));
      for (const heading of duplicates(text)) problems.push(`${path}: ## ${heading} appears twice`);
      for (const heading of parseSections(text).keys())
        if (heading && !methods.has(heading))
          problems.push(`${path}: ## ${heading} is not a method of ${group.group}`);
    }
  }
  const errorsPath = join(dir, 'errors.md');
  if (existsSync(errorsPath)) {
    const text = await readFile(errorsPath, 'utf8');
    const codes = new Set(errorCodes);
    for (const heading of duplicates(text)) problems.push(`descriptions/errors.md: ## ${heading} appears twice`);
    for (const heading of parseSections(text).keys())
      if (heading && !codes.has(heading)) problems.push(`descriptions/errors.md: ## ${heading} is not an error code`);
  }
  return problems;
}

function duplicates(text) {
  const seen = new Set();
  const twice = new Set();
  let fence = false;
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const heading = fence ? null : /^## (.+)$/.exec(line);
    if (!heading) continue;
    const name = heading[1].trim();
    if (seen.has(name)) twice.add(name);
    seen.add(name);
  }
  return [...twice];
}
