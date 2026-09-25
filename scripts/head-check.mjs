#!/usr/bin/env node
// Runs the checks against the COMMITTED tree only, not the working tree several sessions are
// editing at once (a full `pnpm check` in the shared checkout mostly reports other sessions' work in
// progress):
//
//   node scripts/head-check.mjs [--ref <commit>] [--no-build] [vitest filters...]
//
// It keeps a git worktree at `<tmp>/bc-head-check` (or `-2`, `-3`… while another run holds the
// first; see claimTree), moves it to the commit (default: HEAD of this
// checkout), links every node_modules directory of this checkout into it (junctions, so nothing is
// installed or copied), builds with `tsc -b` unless --no-build, and runs `vitest run` with the
// given filters. The worktree is never cleaned with `git clean` (it would follow the junctions).
// `GIT` overrides the git executable (default: GitHub Desktop's bundled git on this machine).

import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const defaultGit = join(
  process.env.LOCALAPPDATA ?? '',
  'GitHubDesktop',
  'app-3.6.5',
  'resources',
  'app',
  'git',
  'cmd',
  'git.exe',
);
const gitPath = process.env.GIT ?? (existsSync(defaultGit) ? defaultGit : 'git');
const git = (args, cwd = root) =>
  execFileSync(gitPath, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const argv = process.argv.slice(2);
const take = (flag) => {
  const at = argv.indexOf(flag);
  if (at < 0) return undefined;
  const [, value] = argv.splice(at, 2);
  return value;
};
const ref = take('--ref') ?? 'HEAD';
const build = !argv.includes('--no-build');
const filters = argv.filter((arg) => arg !== '--no-build');

const commit = git(['rev-parse', ref]);

/**
 * Takes a worktree no other run is using. Several sessions run head-check at once; sharing one tree
 * let a second run move it to another commit mid-run (the first then tested a mix). Each tree has a
 * `<tree>.lock` holding the owner's pid, and a stale lock (dead pid) is taken over. Trees are kept
 * between runs (`bc-head-check`, `bc-head-check-2`, …), so the node_modules mirrors are reused.
 */
function claimTree() {
  for (let slot = 1; slot <= 8; slot++) {
    const path = join(tmpdir(), slot === 1 ? 'bc-head-check' : `bc-head-check-${slot}`);
    const lock = `${path}.lock`;
    try {
      writeFileSync(lock, String(process.pid), { flag: 'wx' });
      return { path, lock };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = Number(readFileSync(lock, 'utf8'));
      let alive = false;
      try {
        process.kill(owner, 0);
        alive = true;
      } catch (probe) {
        alive = probe.code === 'EPERM';
      }
      if (alive) continue;
      writeFileSync(lock, String(process.pid));
      return { path, lock };
    }
  }
  throw new Error('head-check: 8 worktrees are busy; wait for a run to finish');
}
const { path: tree, lock } = claimTree();
process.on('exit', () => {
  try {
    if (Number(readFileSync(lock, 'utf8')) === process.pid) rmSync(lock);
  } catch {
    // already gone
  }
});
if (existsSync(join(tree, '.git'))) {
  git(['checkout', '--quiet', '--detach', '--force', commit], tree);
  git(['reset', '--quiet', '--hard', commit], tree);
} else {
  git(['worktree', 'prune']);
  git(['worktree', 'add', '--quiet', '--detach', '--force', tree, commit]);
}
console.log(`head-check: ${git(['log', '--oneline', '-1', commit])}`);
console.log(`head-check: worktree ${tree}`);

// Every node_modules of the root, packages/*, apps/* and examples/* is rebuilt in the worktree as a
// real directory of junctions to this checkout's entries, EXCEPT workspace links (an entry whose
// target is a directory of this checkout, e.g. `@better-compute/core` -> packages/core): those point
// at the worktree's own copy, so no import ever reaches another session's uncommitted code.
const dirs = ['.'];
for (const parent of ['packages', 'apps', 'examples'])
  if (existsSync(join(root, parent)))
    for (const entry of readdirSync(join(root, parent), { withFileTypes: true }))
      if (entry.isDirectory()) dirs.push(join(parent, entry.name));
const inCheckout = (path) => {
  const rel = relative(root, path);
  return rel && !rel.startsWith('..') && !rel.split(/[\\/]/).includes('node_modules')
    ? rel
    : undefined;
};
let linked = 0;
/** Mirrors `source` (a node_modules or a scope directory) into `target`. */
function mirror(source, target) {
  let stat;
  try {
    stat = lstatSync(target);
  } catch {
    stat = undefined;
  }
  // An earlier run's whole-directory junction: replace it (unlink removes the link, not its target).
  if (stat?.isSymbolicLink()) unlinkSync(target);
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (existsSync(to) || isLink(to)) continue;
    if (entry.name.startsWith('@') && entry.isDirectory() && !lstatSync(from).isSymbolicLink()) {
      mirror(from, to);
      continue;
    }
    let real;
    try {
      real = realpathSync(from);
    } catch {
      continue; // a dangling link
    }
    const workspace = inCheckout(real);
    symlinkSync(workspace ? join(tree, workspace) : from, to, 'junction');
    linked++;
  }
}
function isLink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
for (const dir of dirs) {
  const source = join(root, dir, 'node_modules');
  if (!existsSync(source) || !existsSync(join(tree, dir))) continue;
  mirror(source, join(tree, dir, 'node_modules'));
}
if (linked) console.log(`head-check: linked ${linked} node_modules entries`);

const run = (label, args) => {
  console.log(`head-check: ${label}`);
  const result = spawnSync(process.execPath, args, { cwd: tree, stdio: 'inherit' });
  return result.status ?? 1;
};
let status = 0;
if (build)
  status = run('tsc -b', [
    join(tree, 'node_modules', 'typescript', 'bin', 'tsc'),
    '-b',
    '--pretty',
    'false',
  ]);
if (status === 0 || !build)
  status = run(`vitest run ${filters.join(' ')}`.trim(), [
    join(tree, 'node_modules', 'vitest', 'vitest.mjs'),
    'run',
    ...filters,
  ]);
console.log(
  `head-check: ${status === 0 ? 'green' : 'RED'} at ${commit.slice(0, 7)} (${relative(root, tree) || tree})`,
);
process.exit(status);
