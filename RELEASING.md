# Releasing

better-compute releases every published package at one version. `scripts/release-publish.mjs` is the only way
packages reach npm, both from CI and by hand. It publishes an explicit allowlist, never `pnpm publish -r`.

## What a release publishes

`releaseAllowlist` in `scripts/release-publish.mjs` names the packages. For 0.3 that is every package of 0.2.1
plus `@better-compute/gcp-common`, which provider-gcp depends on. `notReleased` names the workspace packages a
release leaves out on purpose, each with its reason:

| Left out                                | Why                                                    |
| --------------------------------------- | ------------------------------------------------------ |
| `@better-compute/aws-core`              | Not ready: only the unreleased AWS provider uses it    |
| `@better-compute/provider-digitalocean` | Not ready: the DigitalOcean program is still under way |

The script refuses to publish, and `tests/scripts-release-publish.test.ts` fails, when:

- a `packages/*` package is in neither list, so every new package needs an explicit decision;
- an allowlisted package is private or missing;
- the allowlisted packages disagree on the version;
- an allowlisted package has a `workspace:` dependency (or peer or optional dependency) that the release does not
  publish, because it would not install from npm.

Packages are published in dependency order, so `gcp-common` goes before `provider-gcp`. A version that is already
on npm is skipped, so running the script again finishes a partial release.

## The script

```sh
node scripts/release-publish.mjs --check      # validate the allowlist against packages/* (no build, no network)
node scripts/release-publish.mjs --list       # the allowlist in publish order (ci.yml reads it)
node scripts/release-publish.mjs --dry-run    # clean build, then `pnpm publish --dry-run` for each package
node scripts/release-publish.mjs --provenance # the real publish
```

| Option          | Effect                                                                                                   |
| --------------- | -------------------------------------------------------------------------------------------------------- |
| `--dry-run`     | Runs everything, but each publish is `pnpm publish --dry-run`. Nothing reaches npm.                      |
| `--tag <tag>`   | npm dist-tag. The default is `latest`, or `next` for a prerelease version (`X.Y.Z-rc.N`).                |
| `--provenance`  | npm provenance. It needs an OIDC identity, such as GitHub Actions with `id-token: write`.                |
| `--skip-build`  | Publishes the `dist/` already built. Without it, `scripts/pack.mjs` first rebuilds from a clean `dist/`. |
| `--no-registry` | Does not ask the registry which versions exist (offline dry runs). Every package counts as new.          |
| `--allow-dirty` | Publishes from a checkout with uncommitted changes. Do not use it for a real release.                    |

A real publish refuses a checkout with uncommitted changes. Each package is published from its own directory
with the pinned pnpm (`pnpm publish --access public --no-git-checks`), so pnpm rewrites `workspace:*` to the
exact version.

## Cutting a release

1. Branch from a clean checkout of `origin/main` (for example `release-0.3`). Merge whatever the release carries.
2. `node scripts/release-version.mjs X.Y.Z`, then move the `## Unreleased` notes in `CHANGELOG.md` under
   `## X.Y.Z (YYYY-MM-DD)` and leave `## Unreleased` empty. `node scripts/release-notes.mjs X.Y.Z` prints the
   notes.
3. Regenerate the references, which carry the package version: `node apps/docs/scripts/generate.mjs` and
   `pnpm docs:api` (after `tsc -b`).
4. `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm pack:all`, `pnpm check:packed-types`,
   `pnpm test:packed`.
5. Publish:
   - From CI: merge to `main`. The `publish` job in `.github/workflows/ci.yml` runs
     `node scripts/release-publish.mjs --skip-build --provenance` after `pnpm pack:all`, then tags `vX.Y.Z` and
     creates the GitHub release.
   - By hand, when Actions cannot publish: from a clean checkout of the release commit, run
     `node scripts/release-publish.mjs --dry-run` and read the plan, then `node scripts/release-publish.mjs`
     (add `--provenance` only where an OIDC identity exists). Tag `vX.Y.Z` on that commit afterwards.
6. A package's first publish must use a token or a manual publish. npm only lets you add a trusted publisher to a
   package that already exists. For 0.3 that is `@better-compute/gcp-common`.

`bcd` binaries are released from git tags by goreleaser (`.github/workflows/release.yml`), not by this script.
