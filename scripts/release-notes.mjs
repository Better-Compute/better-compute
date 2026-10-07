// Prints the CHANGELOG.md section of one version: the GitHub release notes for tag v<version>.
//
//   node scripts/release-notes.mjs 0.1.0 > notes.md
//
// The section starts at its `## 0.1.0 (2026-09-27)` heading (the heading itself is left out, the release
// title names the version) and ends at the next `## ` heading. It fails when the section is missing
// or empty, so a release is never cut without notes (ci.yml's publish job runs it before publishing).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { root } from './tooling.mjs';

const version = process.argv[2]?.replace(/^v/, '');
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? ''))
  throw new Error('Usage: node scripts/release-notes.mjs VERSION');

const lines = (await readFile(join(root, 'CHANGELOG.md'), 'utf8')).split(/\r?\n/);
const escaped = version.replaceAll('.', '\\.');
const heading = new RegExp(`^## \\[?${escaped}\\]?(?:\\s|$)`);
const start = lines.findIndex((line) => heading.test(line));
if (start === -1) throw new Error(`CHANGELOG.md has no "## ${version}" section`);
const length = lines.slice(start + 1).findIndex((line) => line.startsWith('## '));
const body = lines
  .slice(start + 1, length === -1 ? undefined : start + 1 + length)
  .join('\n')
  .trim();
if (body === '') throw new Error(`CHANGELOG.md's "## ${version}" section is empty`);
process.stdout.write(`${body}\n`);
