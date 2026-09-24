# Working in this repository

This guide covers the workspace, the scripts, the rules CI enforces and how releases will work. [PLAN.md](../PLAN.md) §4 is the source for the layout and §15 for the test strategy.

## Toolchain

- **pnpm 11.19.0**, pinned in `packageManager`, as a root devDependency and in CI. Run the pinned copy with `node node_modules/pnpm/bin/pnpm.mjs <args>` when your global pnpm is another major; scripts call it through `runPnpm` in `scripts/tooling.mjs`, which runs it with the current Node.js and no shell.
- **Node.js 22.12 or later**, ESM only. CI runs Node 22 and 24 on Ubuntu and Windows.
- **Go** (version from `daemon/go.mod`) only for `daemon/`. Logic builds use `-tags nonvml,fakehw`, which work without GPUs and without cgo, including on Windows.
- **Postgres** is optional locally: PGlite (PostgreSQL 18 in WebAssembly, with `btree_gist`) backs the tests. Suites that need real Postgres skip unless `BETTER_COMPUTE_POSTGRES_URL` is set.

## Scripts

| Command (`pnpm …`)         | Script                                            | What it does                                                                                       |
| -------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `build`                    | `tsc -b`                                          | Builds every package's `dist/` in reference order                                                  |
| `check`                    | —                                                 | `typecheck`, `test`, `lint:repo`, `validate:packages`: what CI runs first                          |
| `lint:repo`                | `check-deps`, `check-sql-now`, `umbrella --check` | The repository rules below                                                                         |
| `validate:packages`        | `scripts/validate-packages.mjs`                   | Publishable metadata, `{ types, import }` exports whose files exist, publint, one version          |
| `pack:all`                 | `scripts/pack.mjs`                                | `pnpm pack` of every package into `artifacts/` (replacing earlier tarballs); publishes nothing     |
| `check:packed-types`       | `scripts/check-packed-types.mjs`                  | `attw --profile esm-only` on every tarball                                                         |
| `test:packed`              | `scripts/packed-smoke.mjs`                        | Installs every tarball in a fresh `work/packed-*` consumer and imports the umbrella's entry points |
| `test:postgres`            | vitest                                            | The Postgres-only suites (needs `BETTER_COMPUTE_POSTGRES_URL`)                                     |
| `umbrella`                 | `scripts/umbrella.mjs`                            | Regenerates the umbrella from `packages/better-compute/umbrella.json`                              |
| `proto:gen`, `proto:check` | `scripts/proto-gen.mjs`                           | Protocol code generation and its drift check                                                       |
| `sync:iam`                 | `scripts/sync-better-iam.mjs`                     | Refreshes the vendored better-iam tarballs                                                         |

`node scripts/release-version.mjs X.Y.Z` sets one version on every package.

## Repository rules

`pnpm lint:repo` fails CI when any of these break. Each script's header comment is the full specification.

**Dependency rules** (`scripts/check-deps.mjs`, PLAN.md §4.3):

1. `@better-compute/server` never depends on or imports `provision`, `metal`, `vps`, `gateway`, `iam`, `postgres`, `provider-*`, `driver-*` or the `better-compute` umbrella. Applications pass modules, the store and the IAM port in. `inventory` and `capacity` are the built-in modules it may import.
2. `@better-compute/core`'s root entry, `src/index.ts` and every core file it reaches through relative imports, imports no Node.js built-in. Only `./conformance` may.
3. A package's `workspace:` dependencies (in `dependencies` and `devDependencies`) match its `tsconfig.json` references exactly.
4. Nothing in `packages/` imports or depends on a `@better-compute/provider-*` package.

Imports are read with a small lexer (`scripts/source-scan.mjs`), so comments and strings never count; type-only and dynamic imports do.

**One clock** (`scripts/check-sql-now.mjs`, PLAN.md P9): compute SQL reads time only through `compute_now()`. The script reports `now()`, `CURRENT_TIMESTAMP`, `LOCALTIMESTAMP`, `transaction_timestamp()`, `statement_timestamp()` and `clock_timestamp()` inside any string or template in `packages/*/src`. Two exemptions:

- the migration that defines `compute_now()`: `packages/postgres/src/migrations/0001_*.ts`, marked with the comment `-- defines compute_now()` next to `CREATE FUNCTION compute_now()`;
- a line carrying `check-sql-now: allow`, for a deliberate comparison such as `doctor` checking that `compute_now()` equals `now()` in production.

**Umbrella drift** (`scripts/umbrella.mjs --check`): `packages/better-compute/umbrella.json` lists the subpaths, the bin and the optional peers. The script owns the umbrella's `exports`, `dependencies`, `bin`, peers, tsconfig `references`, the one-line `src/<subpath>.ts` re-exports (nested subpaths flatten: `./iam/plugin` → `src/iam-plugin.ts`) and `src/cli-bin.ts`. It never touches `src/index.ts`, which is curated by hand. To add a subpath, add it to `umbrella.json`, run `pnpm umbrella`, and add its alias to `vitest.config.ts`.

## Tests

Tests live in the root `tests/` folder as flat `tests/<area>-<topic>.test.ts` files and import packages by their specifiers; `vitest.config.ts` maps every `@better-compute/*` specifier and `better-compute/*` subpath to `packages/*/src`, so no build is needed. The repository scripts export their logic for tests (`tests/scripts-*.test.ts`) and only act when run directly.

## CI

`.github/workflows/ci.yml`:

- **test** (Ubuntu and Windows × Node 22 and 24): `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm proto:check`, `buf breaking` against `proto/baseline.binpb` (once), `pnpm pack:all`, `pnpm check:packed-types`, `pnpm test:packed`.
- **postgres**: a `postgres:17` service, `BETTER_COMPUTE_POSTGRES_URL`, `pnpm build` and `pnpm test:postgres`.
- **publish**: after a green push to `main`, publishes every package with provenance and creates a GitHub release, but only when the umbrella's version is not on npm yet **and** better-iam is on npm. While `pnpm-workspace.yaml` still resolves better-iam from `vendor/better-iam`, it skips.

`.github/workflows/daemon.yml` runs when `daemon/` or `proto/` change: `go vet` and `go test -tags nonvml,fakehw ./...` on Ubuntu and Windows, `go vet ./...` with the default (NVML) build on Linux, and `goreleaser check`.

## better-iam before it is published

better-iam 0.1.0 is not on npm, so `vendor/better-iam/` holds its 23 packed tarballs and `SOURCE.json` (source, pack time, sha256s). `pnpm-workspace.yaml` is generated by `scripts/sync-better-iam.mjs` and overrides every `better-iam` and `@better-iam/*` package to its tarball, including transitive ones. Resync only when better-iam is green: `node scripts/sync-better-iam.mjs --install` copies `../better-iam/artifacts` (it packs inside better-iam only with `--pack` and the user's approval). The packed smoke uses the same tarballs, so it installs exactly what a user would get.

## Releases

1. `node scripts/release-version.mjs X.Y.Z`, then move the `## Unreleased` notes in `CHANGELOG.md` under `## X.Y.Z`.
2. `pnpm install`, `pnpm check`, `pnpm pack:all`, `pnpm check:packed-types`, `pnpm test:packed`.
3. Merge to `main`; the publish job does the rest once better-iam is on npm. `bcd` binaries are released from git tags by goreleaser (from v0.1).
