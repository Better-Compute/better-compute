#!/usr/bin/env node
// Regenerates the docs reference from COMMITTED code only and copies the result into a checkout:
//
//   node scripts/head-check.mjs --run apps/docs/scripts/sync-from-head.mjs <checkout root> [--accept-breaking]
//
// head-check builds a worktree at HEAD and runs this inside it while holding the tree, so other
// sessions' uncommitted work (their dist output) never reaches the generated reference. Here it runs
// `generate.mjs` and `scripts/api-reference.mjs` (docs/api-reference.md), then
// `scripts/api-surface.mjs --update` (additions are frozen; a break is refused, and this exits
// non-zero), and copies every file those changed in the tree to the same path in <checkout root>.
// Review and commit there.
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const tree = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const target = process.argv[2];
if (!target || !isAbsolute(target) || !existsSync(join(target, 'apps', 'docs'))) {
  console.error('sync-from-head: pass the absolute root of the checkout to copy into');
  process.exit(2);
}
if (target === tree) {
  console.error('sync-from-head: run it through head-check --run, not in the checkout itself');
  process.exit(2);
}

const node = (script, args = []) =>
  spawnSync(process.execPath, [join(tree, script), ...args], { cwd: tree, stdio: 'inherit' }).status ?? 1;
if (node('apps/docs/scripts/generate.mjs') !== 0) process.exit(1);
if (node('scripts/api-reference.mjs') !== 0) process.exit(1);
// `--accept-breaking` after the checkout root records a deliberate break (e.g. a security fix that moves
// a method's decision to another resource); nothing else is passed on.
const surface = node('scripts/api-surface.mjs', ['--update', ...process.argv.slice(3).filter((arg) => arg === '--accept-breaking')]);

const defaultGit = join(process.env.LOCALAPPDATA ?? '', 'GitHubDesktop', 'app-3.6.5', 'resources', 'app', 'git', 'cmd', 'git.exe');
const git = process.env.GIT ?? (existsSync(defaultGit) ? defaultGit : 'git');
// Untracked files one by one (a new group's page may sit in a new directory).
const changed = execFileSync(git, ['status', '--porcelain', '--untracked-files=all', '--', 'apps/docs', 'generated', 'docs/api-reference.md'], {
  cwd: tree,
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean)
  .map((line) => line.slice(3).replace(/^"|"$/g, ''));
for (const path of changed) {
  mkdirSync(dirname(join(target, path)), { recursive: true });
  copyFileSync(join(tree, path), join(target, path));
  console.log(`sync-from-head: ${path}`);
}
console.log(`sync-from-head: ${changed.length} file(s) copied into ${target}`);
process.exit(surface);
