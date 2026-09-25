// Checks apps/docs/content (mirrors ../better-iam/apps/docs/scripts/check-content.mjs):
//
//   node apps/docs/scripts/check-content.mjs
//
// - every .md/.mdx page starts with frontmatter that has `title` and `description` (and a known `status`);
// - every meta.json parses, and each of its `pages` names a page or folder next to it (or a `---Section---`);
// - every internal link `/docs/...` names a page, and its `#anchor` a heading of that page (github-slugger
//   rules: lower case, punctuation dropped, spaces to hyphens; `[#custom-id]` wins);
// - code fences are closed;
// - every .mdx page compiles with @mdx-js/mdx + remark-gfm (a stray `<x>` or `{x}` in prose takes the
//   whole site down in `next dev`), when the site's dependencies are installed; skipped otherwise.
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const docs = join(dirname(fileURLToPath(import.meta.url)), '..');
const content = join(docs, 'content', 'docs');
const statuses = new Set(['new', 'beta', 'experimental', 'deprecated']);
const problems = [];
const problem = (path, message) => problems.push(`${relative(docs, path)}: ${message}`);

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path)));
    else out.push(path);
  }
  return out;
}

/** The page route of a content file: content/docs/guides/quickstart.mdx → /docs/guides/quickstart. */
const routeOf = (path) => {
  const rel = relative(content, path).split(sep).join('/').replace(/\.mdx?$/, '');
  const route = rel === 'index' ? '' : rel.replace(/\/index$/, '');
  return route ? `/docs/${route}` : '/docs';
};

// As github-slugger (Fumadocs): underscores are kept (`## SPEND_LIMIT_REACHED` → `#spend_limit_reached`);
// emphasis markers are gone by the time a heading renders, so an `_` left in heading text is literal.
const slug = (text) =>
  text
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[`*~[\]()]/g, '')
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\s-]/gu, '')
    .trim()
    .replace(/\s/g, '-');

function parseFrontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) return undefined;
  const fields = {};
  for (const line of match[1].split('\n')) {
    const field = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!field) continue;
    let value = field[2].trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    fields[field[1]] = value;
  }
  return { fields, body: text.slice(match[0].length) };
}

const files = existsSync(content) ? await walk(content) : [];
const pages = new Map();
for (const path of files.filter((file) => /\.mdx?$/.test(file))) {
  const text = (await readFile(path, 'utf8')).replace(/\r\n/g, '\n');
  const parsed = parseFrontmatter(text);
  if (!parsed) {
    problem(path, 'no frontmatter');
    continue;
  }
  const { fields, body } = parsed;
  for (const field of ['title', 'description'])
    if (!fields[field]) problem(path, `frontmatter has no ${field}`);
  if (fields.status && !statuses.has(fields.status))
    problem(path, `status must be one of ${[...statuses].join(', ')}`);
  const anchors = new Set();
  let fence = false;
  for (const line of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) continue;
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (!heading) continue;
    const custom = /\[#([\w-]+)\]\s*$/.exec(heading[1]);
    anchors.add(custom ? custom[1] : slug(heading[1]));
  }
  if (fence) problem(path, 'an unclosed code fence');
  pages.set(routeOf(path), { path, body, anchors });
}

/** @mdx-js/mdx's `compile` and remark-gfm, through fumadocs-mdx (the site's MDX pipeline); or undefined. */
async function mdxCompiler() {
  try {
    const site = createRequire(join(docs, 'package.json'));
    const fumadocs = createRequire(site.resolve('fumadocs-mdx/package.json'));
    const load = (name) => import(pathToFileURL(fumadocs.resolve(name)).href);
    const [{ compile }, gfm] = await Promise.all([load('@mdx-js/mdx'), load('remark-gfm')]);
    return (text) => compile(text, { remarkPlugins: [gfm.default] });
  } catch {
    return undefined;
  }
}

const compileMdx = await mdxCompiler();
let compiled = 0;
if (compileMdx)
  for (const { path, body } of pages.values()) {
    if (!path.endsWith('.mdx')) continue;
    try {
      await compileMdx(body);
      compiled++;
    } catch (error) {
      const at = error.line ? ` (line ${error.line} after the frontmatter)` : '';
      problem(path, `does not compile as MDX${at}: ${error.reason ?? error.message}`);
    }
  }

for (const { path, body } of pages.values()) {
  const withoutCode = body.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  for (const match of withoutCode.matchAll(/\]\((\/docs[^)\s]*)\)|href="(\/docs[^"]*)"/g)) {
    const target = match[1] ?? match[2];
    const [route, anchor] = target.split('#');
    const page = pages.get(route.replace(/\/$/, '') || '/docs');
    if (!page) problem(path, `links to ${target}, which is not a page`);
    else if (anchor && !page.anchors.has(anchor))
      problem(path, `links to ${target}, but ${route} has no heading #${anchor}`);
  }
}

for (const path of files.filter((file) => file.endsWith('meta.json'))) {
  let meta;
  try {
    meta = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    problem(path, `does not parse: ${error.message}`);
    continue;
  }
  for (const page of meta.pages ?? []) {
    if (/^---.*---$/.test(page) || page === '...' || page.startsWith('!')) continue;
    const base = join(dirname(path), page);
    const found =
      existsSync(`${base}.mdx`) ||
      existsSync(`${base}.md`) ||
      (existsSync(base) && (await stat(base)).isDirectory());
    if (!found) problem(path, `lists ${page}, which does not exist`);
  }
}

if (problems.length) {
  for (const line of problems) console.error(line);
  console.error(`${problems.length} problem(s) in apps/docs/content.`);
  process.exitCode = 1;
} else
  console.log(
    `apps/docs/content: ${pages.size} pages checked, no problems` +
      (compileMdx ? ` (${compiled} compiled as MDX).` : ' (MDX compile skipped: apps/docs dependencies not installed).'),
  );
