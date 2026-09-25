#!/usr/bin/env node
// Commits only the given paths, without the shared index and without racing other sessions:
//
//   node scripts/private-commit.mjs -F <message-file> -- <path>...
//
// Several sessions commit to this checkout at once. `git commit` on the shared `.git/index` sweeps in
// whatever others staged, and the older private-index recipe (read-tree HEAD; add; commit) silently
// reverts a commit that lands between its read-tree and its commit (f069c84). This builds the tree
// in a throwaway index from HEAD plus the given paths, writes the commit with HEAD as its parent,
// and moves the branch with a compare-and-swap (`update-ref <new> <old>`): if HEAD moved meanwhile,
// it starts over on the new HEAD, so nobody's commit is ever reverted. Afterwards the shared index
// entries for the paths are reset to the new HEAD, so a later commit elsewhere cannot revert them.
// `GIT` overrides the git executable (default: GitHub Desktop's bundled git on this machine).

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

function usage(message) {
  if (message) console.error(message);
  console.error('Usage: node scripts/private-commit.mjs -F <message-file> -- <path>...');
  process.exit(2);
}

const argv = process.argv.slice(2);
const at = argv.indexOf('-F');
const dashes = argv.indexOf('--');
if (at < 0 || !argv[at + 1] || dashes < 0) usage();
const messageFile = argv[at + 1];
const paths = argv.slice(dashes + 1);
if (!paths.length) usage('No paths given');
if (!existsSync(messageFile)) usage(`No message file ${messageFile}`);

const git = (args, env) =>
  execFileSync(gitPath, args, {
    encoding: 'utf8',
    env: env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

const branch = git(['symbolic-ref', '-q', 'HEAD']);
for (let attempt = 1; attempt <= 10; attempt++) {
  const head = git(['rev-parse', 'HEAD']);
  const dir = mkdtempSync(join(tmpdir(), 'private-commit-'));
  const env = { ...process.env, GIT_INDEX_FILE: join(dir, 'index') };
  try {
    git(['read-tree', head], env);
    // -A also records deletions of the given paths.
    git(['add', '-A', '--', ...paths], env);
    const tree = git(['write-tree'], env);
    if (tree === git(['rev-parse', `${head}^{tree}`])) {
      console.log('Nothing to commit for the given paths.');
      process.exit(0);
    }
    const commit = git(['commit-tree', tree, '-p', head, '-F', messageFile]);
    try {
      git(['update-ref', '-m', 'private-commit', branch, commit, head]);
    } catch {
      console.error(`HEAD moved while committing (attempt ${attempt}); retrying on the new HEAD.`);
      continue;
    }
    // The shared index still holds the old blobs for these paths; make it match the new HEAD.
    try {
      git(['reset', '-q', commit, '--', ...paths]);
    } catch {
      // A path that no longer exists anywhere has no index entry to reset.
    }
    console.log(git(['log', '--oneline', '-1', commit]));
    console.log(git(['diff', '--stat', head, commit]));
    process.exit(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
console.error('HEAD kept moving; nothing was committed.');
process.exit(1);
