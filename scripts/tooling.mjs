import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export const root = resolve(import.meta.dirname, '..');

/** Workspace package globs (pnpm-workspace.yaml `packages`). */
export const workspacePackages = ['packages/*', 'examples/*', 'apps/*'];

/**
 * The one source of the native-build allowlist. `sync-better-iam.mjs` writes it into
 * pnpm-workspace.yaml and `packed-smoke.mjs` into its consumer workspace.
 * argon2 arrives through @better-iam/auth, better-sqlite3 through @better-iam/adapter-sqlite.
 * `false` denies a package's install script explicitly (buf's JS wrapper finds its platform binary
 * without the postinstall optimisation).
 */
export const allowBuilds = {
  argon2: true,
  'better-sqlite3': true,
  esbuild: true,
  '@bufbuild/buf': false,
};

/** Execute the pinned JS package-manager entrypoint directly; no shell interpolation. */
export function runPnpm(args, options = {}) {
  const manifestPath = resolve(root, 'node_modules', 'pnpm', 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const entry = resolve(
    dirname(manifestPath),
    typeof manifest.bin === 'string' ? manifest.bin : manifest.bin.pnpm,
  );
  const result = spawnSync(process.execPath, [entry, ...args], {
    stdio: 'inherit',
    ...options,
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`pnpm ${args[0]} failed (${result.status})`);
}
