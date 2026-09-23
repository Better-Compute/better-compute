# Session coordination (better-compute)

Several Claude sessions and workflow agents may edit this tree at once. Rules:

- Claim an area below before editing; name exact files and symbols. Re-read shared files right before each edit and
  insert your own lines instead of rewriting blocks.
- Shared registries (root `tsconfig.json`, `vitest.config.ts`, `packages/better-compute/umbrella.json`,
  `pnpm-workspace.yaml`, root `package.json`) change by one-line inserts, and only by the session that owns the
  package being added. `pnpm-workspace.yaml` is generated: run `node scripts/sync-better-iam.mjs --write`.
- Never run `prettier --write .` on the whole tree; format only your own files. Announce full `vitest run`s.
- Do not run `pnpm install` or add dependencies while other agents are working; ask the orchestrating session.
- better-iam (`../better-iam`) is read-only unless the user approves an upstream item in chat (PLAN.md §12.12).
- The contracts frozen at the end of P0 (`proto/bettercompute/agent/v1`, `@better-compute/core`, the v0.1 schema,
  the v0.1 rows of PLAN.md §9.2) change only by additive, reviewed edits.

## Toolchain on this machine

- git is not on PATH; use GitHub Desktop's bundled git:
  `& "$env:LOCALAPPDATA\GitHubDesktop\app-3.6.5\resources\app\git\cmd\git.exe" <args>`.
- The global pnpm is 12.x and refuses workspaces pinned to `pnpm@11.19.0`. Run the pinned copy:
  `node node_modules/pnpm/bin/pnpm.mjs <args>` (scripts use `runPnpm` from `scripts/tooling.mjs`).
- Go is not installed yet (PLAN.md D1); `daemon/` is written but unbuilt until it is.
- Docker is not running; PGlite (PostgreSQL 18, `btree_gist` verified) is the local database. Postgres-only
  suites skip unless `BETTER_COMPUTE_POSTGRES_URL` is set.

## Sessions

- (orchestrator, P0) Root workspace, scripts/tooling.mjs, scripts/sync-better-iam.mjs, vendor/better-iam,
  package manifests, vitest configs. P0 package work is fanned out by workflow; see the git log.
