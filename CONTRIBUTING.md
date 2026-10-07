# Contributing to better-compute

Thank you for your interest in better-compute. Bug reports, documentation fixes and code are all welcome. By taking
part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

- **Questions and bugs:** open an [issue](https://github.com/better-compute/better-compute/issues) with the package
  versions, Node.js version, database (PostgreSQL or PGlite) and steps to reproduce.
- **Security issues:** never in a public issue; see [SECURITY.md](SECURITY.md).
- **Larger changes:** open an issue first to agree on the approach, especially for anything that touches a public API,
  the database schema, the daemon protocol (`proto/`) or the security model.

## Set up

You need Node.js 22.12 or later, and Go (the version in `daemon/go.mod`) only if you work on the daemon. The workspace
pins pnpm 11.19.0 (`packageManager`); pnpm 12 refuses it. Install with that version once, then run the pinned copy
from `node_modules` (or plain `pnpm` if your global pnpm is 11.x):

```sh
git clone https://github.com/better-compute/better-compute.git
cd better-compute
npx pnpm@11.19.0 install
node node_modules/pnpm/bin/pnpm.mjs build
```

The commands below are written as `pnpm <script>`; substitute `node node_modules/pnpm/bin/pnpm.mjs <script>` when
your global pnpm is another major version.

## Build and test

| Command                                       | What it does                                                                                              |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `pnpm build`                                  | `tsc -b`: builds every package's `dist/` in reference order                                               |
| `pnpm typecheck`                              | Type-checks every package and the client tests                                                            |
| `pnpm test`                                   | The vitest suite, against source, on PGlite and an embedded Better IAM (no database server)               |
| `pnpm test:iam-remote`                        | The IAM-dependent suites again, with Better IAM in remote mode                                            |
| `pnpm test:postgres`                          | The PostgreSQL-only suites; needs `BETTER_COMPUTE_POSTGRES_URL`                                           |
| `pnpm lint:repo`                              | Repository rules: dependency direction, one SQL clock, umbrella, protocol and docs drift, API surface     |
| `pnpm validate:packages`                      | Publishable metadata and exports of every package                                                         |
| `pnpm check`                                  | `typecheck`, `test`, `test:iam-remote`, `lint:repo` and `validate:packages`: run it before a pull request |
| `pnpm pack:all`                               | Packs every package into `artifacts/` (publishes nothing)                                                 |
| `pnpm check:packed-types`, `pnpm test:packed` | Checks the packed types, and installs the tarballs in a fresh consumer                                    |
| `pnpm format`, `pnpm format:check`            | Prettier                                                                                                  |

Some changes need a generator run, and `pnpm lint:repo` tells you which:

- `pnpm umbrella` after changing `packages/better-compute/umbrella.json`;
- `pnpm proto:gen` after changing `proto/` (`pnpm proto:check` verifies it; breaking changes to the wire protocol are
  refused);
- `node apps/docs/scripts/generate.mjs` when the API, CLI, errors, events, metrics or package descriptions change the
  generated documentation;
- `pnpm api:surface` to record additions to the API surface (methods, error codes, input shapes); the check refuses
  removals and narrowing.

For a real PostgreSQL:

```sh
BETTER_COMPUTE_POSTGRES_URL=postgres://postgres:postgres@localhost:5432/better_compute_test pnpm test:postgres
```

For the daemon, inside `daemon/`:

```sh
go vet ./...
go test -tags nonvml,fakehw ./...   # without GPUs or cgo, on Linux or Windows
```

[docs/development.md](docs/development.md) covers the workspace, the repository rules and CI in more detail.

## Pull requests

- Keep a pull request to one change, with tests. Tests live in `tests/` as `tests/<area>-<topic>.test.ts` and import
  packages by their specifiers.
- Update the documentation (`apps/docs/content/docs`) and the package README when behavior changes, and add a line
  under `## Unreleased` in [CHANGELOG.md](CHANGELOG.md) for user-visible changes.
- `pnpm check` must pass; CI runs it on Ubuntu and Windows with Node.js 22 and 24, plus the PostgreSQL suites and the
  packed-package checks.

## Commit style

Commit subjects name the area first, then say what changed, in lower case and without a trailing period:

```
capacity: a bound report never ends a deferred Kubernetes release
bcd join --reset: an identity that loads but no longer works can join again
docs: node keys through the helper, retiring adopted nodes
```

The area is a package, a component or a command (`server`, `cli`, `gateway`, `bcd`, `bcd helper`, `docs`, `e2e`, …).
Fixes for security issues start with `SECURITY` (`SECURITY capacity: …`). Use the body to explain why, when the
subject is not enough.

## Licensing and sign-off

better-compute is licensed under the [Apache License 2.0](LICENSE). By contributing, you agree that your contribution
is licensed under the same license, as section 5 of the license describes, and that you have the right to submit it.

We use the [Developer Certificate of Origin 1.1](https://developercertificate.org/) (DCO). Sign off every commit to
certify that you wrote it or otherwise have the right to submit it under the project's license:

```sh
git commit -s -m "cli: nodes delete"
```

This adds a `Signed-off-by: Your Name <you@example.com>` line with the name and email of your Git configuration. Use
your real name; anonymous contributions cannot be accepted.
