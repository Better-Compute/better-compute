# better-iam conventions for better-compute to mirror

Source: `C:\Users\Sean Filimon\Desktop\better-iam`. I only read files; nothing was changed. `git` is not on PATH in this environment, but a hidden `.git` folder exists, and `coordination.md` says "No git here".

---

## 1. Root workspace

**`package.json`**, name `better-iam-workspace`, `private: true`, `"type": "module"`, `license: MIT`:
- The pnpm version is pinned in three places:
  - `"packageManager": "pnpm@11.19.0"`
  - devDependency `"pnpm": "11.19.0"`
  - CI `pnpm/action-setup` `version: 11.19.0`
- `"engines": { "node": ">=22.12.0" }`. Every package repeats it.
- Scripts:
  ```json
  "build": "tsc -b",
  "typecheck": "tsc -b --pretty false && tsc -p tests/tsconfig.client.json && tsc -p tests/tsconfig.application.json && ... && pnpm --filter @better-iam/console typecheck",
  "test": "vitest run",
  "test:postgres": "vitest run tests/postgres.test.ts tests/server-security.test.ts tests/adapter-conformance.test.ts tests/storage-query.test.ts",
  "check": "pnpm typecheck && pnpm test && pnpm validate:packages",
  "validate:packages": "node scripts/validate-packages.mjs",
  "pack:all": "node scripts/pack.mjs",
  "check:packed-types": "node scripts/check-packed-types.mjs",
  "test:packed": "node scripts/packed-smoke.mjs",
  "bench:scale": "vitest run --config vitest.bench.config.ts",
  "format": "prettier --write .", "format:check": "prettier --check .",
  "docs:api": "node scripts/api-reference.mjs"
  ```
- Root devDependencies hold all tooling and the framework hosts the tests need:
  - Tooling: `typescript ^5.9.3`, `vitest ^3.2.4`, `prettier 3.6.2` (exact version), `publint ^0.3.15`, `@arethetypeswrong/cli ^0.18.2`, `esbuild`, `happy-dom`, `@types/node ^22.19.0`.
  - Framework hosts: react, next, express, hono, fastify, nestjs, and others.
  - Packages do not carry their own test tooling.

**`pnpm-workspace.yaml`**
```yaml
packages: [packages/*, examples/*, apps/*]
allowBuilds: { argon2: true, better-sqlite3: true, esbuild: true }   # pnpm 11 native-build allowlist
```

**`tsconfig.base.json`**: `target ES2023`, `module/moduleResolution NodeNext`, `lib [ES2023, DOM, DOM.Iterable]`, `strict`, `noUncheckedIndexedAccess`, `declaration`, `declarationMap`, `sourceMap`, `composite`, `skipLibCheck`, `esModuleInterop`, `forceConsistentCasingInFileNames`.

**`tsconfig.json`** (root): `"files": []` plus `references` to every `./packages/*`, in dependency order (core, auth, server, protocols, adapters, client, cli, projects, frameworks, mcp, a2a). The umbrella `./packages/better-iam` comes last. Apps and examples are not in the references.

**Prettier** (`.prettierrc.json`): `{ "singleQuote": true, "printWidth": 100, "trailingComma": "all" }`. `.prettierignore` covers `dist`, `pnpm-lock.yaml`, `artifacts`, `work`, `*.tsbuildinfo`, framework build directories, and generated docs directories.

**`.gitattributes`**: `* text=auto eol=lf`, and `binary` for png, jpg, ico, woff2.

**`.gitignore` highlights**: `dist/`, `*.tsbuildinfo`, `artifacts/`, `work/`, `.claude/`, `.env`, `.env.*`, `.npmrc`, `*.db`, `*.db-shm`, `*.db-wal`, `.next-*/`, `.swc/`.

**`LICENSE`**: MIT, "Copyright (c) 2026 Better IAM contributors". A copy sits in the root and in every package.

**`CHANGELOG.md` format**: `# Changelog`, then `## Unreleased`, then `## 0.1.0`.
- Each Unreleased bullet opens with a one-sentence feature summary and "Guide `docs/x.md`."
- Nested sub-bullets list, all in backticks:
  - the new API group and its methods
  - actions such as `iam:billing:read|manage`
  - collections, audit event names and error codes
  - console changes
- Several sessions append their own bullets.

---

## 2. Per-package layout

Every package directory holds `src/`, `dist/`, `LICENSE`, `README.md`, `package.json` and `tsconfig.json`.

### Shared `package.json` shape
Taken from `packages/core/package.json`:
```json
{
  "name": "@better-iam/core", "version": "0.1.0", "description": "...",
  "type": "module", "license": "MIT", "author": "Better IAM contributors",
  "homepage": "https://github.com/Better-IAM/better-iam/tree/main/packages/core#readme",
  "repository": { "type": "git", "url": "git+https://github.com/Better-IAM/better-iam.git", "directory": "packages/core" },
  "bugs": { "url": "https://github.com/Better-IAM/better-iam/issues" },
  "keywords": [...], "publishConfig": { "access": "public" },
  "engines": { "node": ">=22.12.0" },
  "files": ["dist", "README.md", "LICENSE"],
  "main": "./dist/index.js", "types": "./dist/index.d.ts",
  "exports": {
    ".":             { "types": "./dist/index.d.ts",       "import": "./dist/index.js" },
    "./conformance": { "types": "./dist/conformance.d.ts", "import": "./dist/conformance.js" }
  },
  "sideEffects": false,
  "scripts": { "build": "tsc -b" },
  "dependencies": {}
}
```
- Packages are ESM-only. Each export has only `types` and `import` conditions: no `require`, no `default`. `attw --profile esm-only` enforces this.
- Every subpath maps to a flat `dist/<name>.js` file compiled from `src/<name>.ts`.
- Sibling packages are always referenced as `"workspace:*"`. `pnpm pack` rewrites that to the exact version, for example `"@better-iam/core": "0.1.0"`, which I confirmed inside the server tarball.

### Representative packages

| Package | exports | deps | Notes |
|---|---|---|---|
| `packages/core` | `.`, `./conformance` | none | `src/{index,storage,sql,policy,audit,instrument,snapshot,jcs,delegation-tokens,conformance}.ts`. Header: "Shared, browser-safe contracts. No Node.js dependencies belong in this entrypoint." |
| `packages/server` | `.`, `./assertions`, `./session-tokens` | core, auth, `jose` | Runtime-neutral pieces (assertions, session-tokens) get their own subpaths. |
| `packages/client` | `.`, `./passkeys`, `./session` | core, `@simplewebauthn/browser` | Browser-safe. |
| `packages/cli` | `.` plus `"bin": { "better-iam": "./dist/index.js" }` | core, server, client, adapter-sqlite, adapter-postgres | |
| `packages/adapter-postgres` | `.` | core, `kysely`, `pg`; devDep `@types/pg` | |
| `packages/oauth` | `.` | core, auth, `oauth4webapi`, `oidc-provider`, `jose` | |
| `packages/middleware` | `.`, `./express`, `./hono`, `./fastify` | | Multi-adapter package with subpaths. |
| `packages/react`, `packages/next` | | | Declare `peerDependencies` (not optional) on react and next. |
| `packages/nuxt` | | | Installed directly; it is not part of the umbrella. |

### Per-package `tsconfig.json`
```json
{ "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src/**/*.ts"],
  "references": [{ "path": "../core" }, { "path": "../auth" }] }
```
Each package's `references` list matches its `workspace:*` dependencies exactly.

### Server `src/` layout (the pattern for a control plane)
- `index.ts`: the `betterIam(options)` factory and exports.
- `options.ts`: `BetterIamOptions`.
- `context.ts`: `ServerContext`.
- `http.ts`: the router.
- `operations.ts`: the transactional envelope.
- `define.ts`: `defineConfig` and `configOptions`.
- `api/index.ts`: `createApi(ctx, auth)`, plus one `api/<group>.ts` per group.
- Domain services such as `lifecycle.ts` and `billing-service.ts` sit at the `src/` root.
- Some files are very large: `api/billing.ts` is 141 KB and the server tarball is about 1 MB.

### Per-package `README.md`
Title, a one-paragraph purpose, an import snippet, then operational notes. `adapter-postgres/README.md` is the model: pool and lock options, transaction rules, error codes (`CONFLICT`, `STORAGE_BUSY`), and the test env var `BETTER_IAM_POSTGRES_URL`.

---

## 3. Umbrella package: `packages/better-iam`

- `name: "better-iam"`, with `"bin": { "better-iam": "./dist/cli-bin.js" }`.
- It has **29 subpath exports**: `./core`, `./auth`, `./auth/templates`, `./server`, `./session-tokens`, `./oauth`, `./saml`, `./scim`, `./adapter-postgres`, `./adapter-sqlite`, `./adapter-libsql`, `./client`, `./client/passkeys`, `./client/session`, `./cli`, `./projects`, `./react`, `./next`, `./next/edge`, `./next/client`, `./nestjs`, `./nestjs/testing`, `./vue`, `./svelte`, `./svelte/kit`, `./middleware`, `./express`, `./hono`, `./fastify`, `./react-router`, `./mcp`, `./a2a`.
- Nested subpaths are flattened to file names: `./client/passkeys` maps to `dist/client-passkeys.js`.
- **Each subpath is a one-line re-export file.** `src/oauth.ts` is `export * from '@better-iam/oauth';` and `src/express.ts` is `export * from '@better-iam/middleware/express';`.
  - Exception: `src/next-client.ts` starts with `'use client'` and uses named re-exports. The comment explains: "Next refuses `export *` in a 'use client' module imported from a server component".
- **`src/index.ts`** re-exports only a curated set from `@better-iam/server` and `@better-iam/core`: `betterIam`, `IamError`, `definePolicy`, `evaluatePolicy`, `validatePolicy`, `verifyAuditChain`, `verifyAssertion`, `assertionKey`, `verifyWebhookSignature`, plus many `export type` lines.
- **`src/cli-bin.ts`**:
  ```ts
  #!/usr/bin/env node
  import { runBinary } from '@better-iam/cli';
  runBinary();
  ```
- **How protocol packages "load lazily"** (README: "Protocol packages are loaded only when their subpaths are imported"). This works through ESM subpath isolation plus dependency inversion, not dynamic `import()`:
  1. The umbrella `index.ts` imports only server and core.
  2. `@better-iam/server` never imports oauth, saml or scim.
  3. The application creates the protocol itself and mounts it:
     ```ts
     const host = iam.protocolHost;
     const scim = createScimService({ ...host });
     iam.useProtocol(scim);   // or betterIam({ protocols: [ProtocolMount] })
     ```
     `ProtocolMount` is `{ handle?(Request): Promise<Response|undefined>; nodeHandler?(req,res) }` (`server/src/options.ts:100`). `useProtocol({ basePath, handler?, nodeHandler? })` is in `http.ts:770`.
  4. `iam.handler` checks protocol mounts before normal basePath routing.
  - The only real dynamic import is in the CLI: `await import('@better-iam/adapter-libsql')` inside `configFromEnv`, which fails with `MISSING_DEPENDENCY` if the package is absent.
- **Dependencies**: all 21 scoped packages are hard `dependencies` (`workspace:*`), so the "lazy" behaviour applies at import time, not install time.
- **Optional peers**: the umbrella re-declares every framework peer: `@nestjs/common|core`, `next`, `react`, `vue`, `svelte`, `@sveltejs/kit`, `react-router`. Each is marked `peerDependenciesMeta: { x: { optional: true } }`, so installing `better-iam` without React does not warn. The scoped framework packages keep non-optional peers.
- **Umbrella tsconfig** references all 21 siblings.
- **Umbrella `README.md`**: a one-paragraph pitch, a 3-line import example (`better-iam`, `better-iam/adapter-sqlite`, `better-iam/client`) and a runtime note. The root `README.md` carries the full `| Import | Purpose |` table.

---

## 4. `scripts/` (all ESM `.mjs`, root = `resolve(import.meta.dirname, '..')`)

| Script | What it does |
|---|---|
| `tooling.mjs` | `runPnpm(args, opts)` runs the **pinned** `node_modules/pnpm` bin through `process.execPath` with `spawnSync`, `shell: false`. No shell interpolation and no Corepack dependency, which is safe on Windows paths with spaces. |
| `validate-packages.mjs` | For every `packages/*`: fails unless `license === 'MIT'`, not `private`, `publishConfig.access === 'public'` and `repository.directory` set. `access()`s every `exports` target file, so a build is required. Runs `publint({ pkgDir })` (errors fail). Asserts **one synchronized version** (`versions.size === 1`). |
| `pack.mjs` | `pnpm pack --pack-destination artifacts/` in each `packages/*`. Prints "No packages were published." |
| `check-packed-types.mjs` | `pnpm exec attw artifacts/<tgz> --profile esm-only --quiet` for every tarball. |
| `packed-smoke.mjs` | Requires tarball count to be at least the package count. Creates `work/packed-XXXX/` with a `package.json` whose deps are `file:<abs>/artifacts/<name>.tgz` for every package, and a `pnpm-workspace.yaml` with `allowBuilds` plus `overrides` mapping every `@better-iam/*` to its tarball. Runs `pnpm install`, a `smoke.mjs` (imports `better-iam`, `better-iam/adapter-sqlite`, `better-iam/client`; in-memory SQLite migrate and bootstrap), then `pnpm exec better-iam --help`. Cleans up with a guard against deleting outside `work/`. |
| `release-version.mjs X.Y.Z` | Validates the semver (prerelease allowed) and rewrites `version` in every `packages/*/package.json`. Apps and examples are left alone. Reminds you to update the changelog and run `pnpm check`. |
| `api-reference.mjs` | Imports `packages/server/dist/index.js` (run after `pnpm build`) and creates a live `betterIam()` on in-memory SQLite. Writes `docs/api-reference.md`: a hand-written top-level table, then one table per `Object.keys(iam.api)` group. `routeGroups` decides "routed" versus "not routed". `publicApiMethods`, `publicAuthMethods` and `authenticatedAuthMethods` decide the credential column (`none` or `required`). Ends with `N groups, M methods.` |

---

## 5. Tests

- **`vitest.config.ts`**:
  - `include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx']`, `testTimeout` and `hookTimeout` 30000, `fileParallelism: false`.
  - `esbuild: { jsx: 'automatic', tsconfigRaw: { compilerOptions: { experimentalDecorators: true } } }`.
  - `resolve.alias` maps every `@better-iam/*` specifier **and subpath** to `packages/*/src/*.ts` via `fileURLToPath(new URL('./packages/x/src/y.ts', import.meta.url))`. Tests run against source, with no build.
  - Subpath aliases are listed **before** the bare package, because string aliases also match prefixes (commented in the file).
- **`vitest.bench.config.ts`** spreads the base config with `include: ['tests/bench/**/*.bench.ts']` and a 30-minute timeout. File: `tests/bench/scale.bench.ts`.
- **Layout**: about 190 flat `tests/<feature>.test.ts(x)` files at the root, named after the feature (`cli-remote`, `adapter-conformance`, `http-hardening`, `client`, `application`).
- **`tests/support/`**:
  - `organization.ts` exports `organizationFixture(overrides)` and `closeFixtures()`. The fixture sets up in-memory SQLite, a controllable clock, an `inbox` collecting outbox emails, a bootstrapped root with TOTP MFA, and an "Acme" org with an accepted owner. It returns `iam`, `database`, `inbox`, `rootCredential`, `tenantId`, `ownerCredential`, `ownerId`, `member(name)`, `signIn`, `ownerSignIn`, `rootSignIn`, `now` and `advance(ms)`. It is registered with `afterEach(closeFixtures)`.
  - Also `jwt-keys.ts` and `webauthn.ts`.
  - Dependencies not hoisted to the root are loaded with `createRequire(new URL('../../packages/auth/package.json', import.meta.url))('otplib')`.
- **Type-test projects**: `tests/tsconfig.{client,application,next,nestjs,svelte,middleware,react-router}.json`. Each extends the base with `composite:false`, `noEmit:true`, `baseUrl:".."`, `paths` pointing each `@better-iam/*` at `src`, and `"files": [specific tests]`, `"include": []`. They are run by `pnpm typecheck`.
  - These catch inference regressions, for example `expectTypeOf(client.identities.invite).parameter(0).toEqualTypeOf<...>()` in `tests/application.test.ts`.
- **Adapter matrix** (`tests/adapter-conformance.test.ts`): backends are SQLite in memory, SQLite on file, libSQL in memory, and PostgreSQL (`describe.skipIf(!BETTER_IAM_POSTGRES_URL)`). Each case gets a fresh store: `migrate()`, `test.run(store)`, `close()`. Postgres isolation uses a schema per case, with a collection-prefix fallback.

---

## 6. CI: `.github/workflows/ci.yml`

- **Triggers**: push to `main`, PRs, `workflow_dispatch`. `permissions: contents: read`. Concurrency is per ref, cancelling in-progress runs except on main.
- **`test` job**: matrix `os: [ubuntu-latest, windows-latest]` by `node: [22, 24]`. Steps:
  1. `pnpm install --frozen-lockfile`
  2. `pnpm check`
  3. `node examples/shared/smoke.mjs`
  4. `pnpm pack:all`
  5. `pnpm check:packed-types`
  6. `node scripts/packed-smoke.mjs`
- **`postgres` job**: `postgres:17-alpine` service, `BETTER_IAM_POSTGRES_URL`, runs `pnpm build`, then `pnpm test:postgres`.
- **`publish` job**: `needs: [test, postgres]`, only on push to main, `environment: npm`, non-cancelling `publish` concurrency, `permissions: contents: write, id-token: write`.
  1. Reads the version from `packages/better-iam/package.json`. The dist-tag is `next` if the version contains `-`, otherwise `latest`.
  2. Skips with a warning if `NPM_TOKEN` is unset, or if `npm view better-iam@$version` already exists.
  3. Otherwise runs `pnpm install`, then `pnpm build`, then `pnpm publish -r --access public --provenance --no-git-checks --tag $tag`. Reruns finish a partial release.
  4. `gh release create v$VERSION --generate-notes` (plus `--prerelease` when applicable).

---

## 7. `packages/cli`

**Files**:
- `index.ts`: public exports, `processIO`, `createCli`, `runCli`, `cliManifest`, `main` and `runBinary`. A self-execution guard compares `realpathSync(argv[1])` against `import.meta.url`. The version is read from `../package.json`.
- `framework.ts`: `defineCommand`, `createCliProgram`, flag specs, help text and `manifestOf`.
- `config.ts`, `profiles.ts`, `transport.ts`.
- `output.ts`: `formatResult` and `selectPath`, behind `--format json|compact|table` and `--query a.b[].c`.
- `errors.ts`: `CliError(code, msg, hint)`, `usageError` and `usageCodes`.
- `tenant-config.ts`.
- `commands/{setup,operations,billing,audit,storage,access,api,session,shell}.ts`, collected in `commands/index.ts` as the `builtinCommands` array in help order.

**Command spec**:
```ts
defineCommand({ name, group, summary, description, usage?, flags, args, examples, aliases,
                target: 'config' | 'token' | 'none', output: 'json' | 'text', validate?, run(ctx) })
```
- `target: 'config'` is a deployment operation. It loads the config and uses no credential.
- `target: 'token'` acts as a session or API key, in process or remotely with `--url`.
- Flags carry `env`, `profile`, `default`, `choices` and `hidden`. Common flags (`--config`, `--url`, `--profile`, `--format`, `--query`) are added automatically based on the target.

**Config discovery** (`config.ts`):
1. `--config`
2. `BETTER_IAM_CONFIG`
3. The nearest of `better-iam.config.{mjs,js,ts,mts,cjs}`, walking up parent directories
4. Env-only mode: `configFromEnv()` reads `BETTER_IAM_DATABASE_URL` (`postgres://`, `sqlite:`, `libsql://`, `file:`) plus `BETTER_IAM_SECRET`, `BETTER_IAM_BASE_URL`, `BETTER_IAM_BASE_PATH` and `BETTER_IAM_TRUSTED_ORIGINS`.

The config module exports:
- `default`: options, a ready instance, or `(ctx: {command, env, cwd}) => options | instance`
- `commands`: project commands built with `defineCommand`
- `cli: { defaults: { '<cmd>'|'*': { flag: value } } }`

`defineConfig` and `configOptions` in `server/src/define.ts` type this. Loading a `.ts` config on Node below 22.18 gives a readable `CONFIG_LOAD_FAILED` hint.

**Login and profiles** (`profiles.ts`):
- The credentials file is found at:
  1. `BETTER_IAM_CREDENTIALS`
  2. `%APPDATA%\better-iam\credentials.json` on Windows
  3. `$XDG_CONFIG_HOME/better-iam/credentials.json`
  4. `~/.config/better-iam/credentials.json`
- Shape:
  ```
  {version:1, current, profiles:{[name]:{url|config|envConfig, tenantId, identityId, email, kind, token, expiresAt, savedAt}}}
  ```
- Writes are atomic: a temp file opened with `wx` and mode 0600, then renamed.
- Profile selection order: `--profile`, then `BETTER_IAM_PROFILE`, then the file's `current`, then `default`.
- A profile is tied to the deployment it was issued by (`sameTarget`), and a mismatch is reported.
- `login` reads the password from `BETTER_IAM_PASSWORD` or a hidden raw-mode prompt, and the MFA code from `BETTER_IAM_MFA_CODE` or a prompt. Neither is ever a flag. `--with-token` reads a token from stdin.
- Other session commands: `logout`, `profiles`, `token`.

**`BETTER_IAM_TOKEN`**: token commands use `BETTER_IAM_TOKEN` first, otherwise the saved profile token. While it is set, `--profile` is ignored. Other env vars:
- `BETTER_IAM_URL` (same as `--url`)
- `BETTER_IAM_TENANT` (default `--tenant`)
- `BETTER_IAM_DEBUG` (stack traces)
- `BETTER_IAM_ROOT_EMAIL`, `BETTER_IAM_ROOT_NAME`, `BETTER_IAM_ROOT_PASSWORD`

**Calling any API method** (`commands/api.ts` plus `transport.ts`):
```
better-iam api GROUP.METHOD [key=value ...] [--data JSON|@FILE|-] [--tenant ID] [--list [GROUP]] [--url URL] [--profile NAME]
```
- Inputs use HTTPie-style items: `name=x` (string), `limit:=10` (JSON), `doc:=@f.json`, `content=@f.md`, `resource.type=project` (nested), `actions[]=a` (append). Prototype keys are rejected.
- The `ApiTransport` interface is `{ mode: 'local'|'remote', target, call(path, input) }`:
  - `localTransport(iam, target, token)` dispatches in process and mirrors the HTTP router exactly: same route tables, credential rules and JSON round-trip, but no 64 KiB limit.
  - `remoteTransport(url, token)` uses `createIamClient<{api:unknown}>({ requestId:true, retryRateLimited:true }).$request(path, input)`. It requires https except on localhost.
- `listRoutes(iam)` powers `api --list`.

**Exit codes and errors**: `main()` returns 0 on success, 2 for usage errors and 1 otherwise. It prints `CODE: message` plus a `Hint:` line. Control characters are stripped, and unknown errors are made generic unless `BETTER_IAM_DEBUG` is set.

**Other commands**: `init`, `migrate`, `bootstrap`, `recover-root`, `doctor`, `secret`, `whoami`, `can`, `explain`, `who-can`, `config-export/validate/plan/apply`, `audit-*`, `store-export/import/copy`, `outbox`, `purge`, `sweep`, `completion`, `help --json` (the manifest).

---

## 8. Client, HTTP convention and API groups

**Declaring groups on the server** (`server/src/api/index.ts`):
```ts
export function createApi(ctx: ServerContext, auth: AuthApi) {
  return { auth, tenants: createTenantsApi(ctx), roles: createRolesApi(ctx), /* ... 44 groups */ };
}
export type Api = ReturnType<typeof createApi>;
```
Each `api/<group>.ts` exports `create<Group>Api(ctx)`, which returns an object of methods. Taken from `api/sod.ts`:
```ts
create: (credential: CredentialInput, input: { tenantId: string; name: string; ... }) =>
  operation(credential, input.tenantId, 'iam:sod:manage', 'sod/*', async ({ tx, principal }) => { ... }),
```
`operation(credential, tenantId, action, resourceId, fn, rootOnly?)` is the transactional envelope in `operations.ts`: authenticate, re-validate, authorize `action` on `iam/{resourceId}`, run the mutation in `tx`, append one audit event. A denial commits only its audit record.

**Route registration** (`server/src/http.ts`):
- `export const routeGroups = new Set([...])`. Adding a group means adding one line here; groups not listed are "not routed", meaning callable only from server code.
- `publicApiMethods` holds `'group/method'` strings that are called as `fn(body)` with no credential.
- `publicAuthMethods` and `authenticatedAuthMethods` do the same for `auth`.
- Unknown groups or methods return `NOT_FOUND` 404, and `Object.hasOwn` guards prevent route enumeration.

**The wire protocol** (the `handler(request)` Fetch-standard handler plus `nodeHandler`):
- **Methods and paths**:
  - `POST {basePath}/{group}/{method}` (default basePath `/api/iam`)
  - Top-level `POST /authorize`, `/authorizeMany`, `/listAccessible`
  - `POST /plugins/{pluginId}/{path}`
  - `GET` is used only for `/health`, `/metrics` (bearer `observability.metrics.bearerToken`) and `/.well-known/jwks.json`
  - Anything else is `METHOD_NOT_ALLOWED` 405
- **CSRF**: requires `content-type: application/json` **and** `X-Better-IAM: 1`, otherwise `CSRF_REJECTED` 403. A request carrying a cookie without `Origin` is also `CSRF_REJECTED`.
- **Origin**: an `Origin` must be in `trustedOrigins` (or trusted by the org hosts), otherwise `UNTRUSTED_ORIGIN` 403. Trusted origins get CORS `allow-origin`, `allow-credentials`, `expose-headers: retry-after, x-request-id` and `Vary: Origin`.
  - OPTIONS preflight returns 204 with allow-headers `content-type, x-better-iam, authorization, x-request-id, x-better-iam-persistent`.
- **Body**: capped at 64 KiB (`limitedBody(request, 65536)`) and must be a JSON object.
- **Response envelope**: `{ "data": ... }`, or `{ "error": { "code", "message", retryAfterMs?, region?, location? } }` with the HTTP status taken from `IamError(code, message, status = 400)`. Unknown errors become `INTERNAL_ERROR` 500.
- **Tracing**: `X-Request-Id` is echoed back. Spans are named by route, or `(unknown)`, so metric cardinality stays bounded.
- **Credentials**: a bearer `Authorization` header takes precedence over the cookie.

**Client** (`packages/client/src/index.ts`): `createIamClient<T extends { api: unknown }>(options)` returns `IamClient<T>`.
- Type mapping:
  ```ts
  IamClient<T> = ClientApi<T['api']> & ClientTransport & AuthorizeClient<T>
  ```
  `ClientApi` maps each group and method. If the server method's first parameter is credential-only, detected with
  ```ts
  type IsCredential<T> = Exclude<keyof T, keyof CredentialInput> extends never ? true : false
  ```
  then the client signature becomes `(input, options?)`, otherwise `(...params, options?)`. Return types become `Promise<Awaited<ReturnType>>`.
- Usage: `createIamClient<typeof iam>({ baseURL })` with a type-only import of the server instance. No codegen is involved.
- Runtime: a `Proxy` over group and method. Segments must match `^[A-Za-z][A-Za-z0-9_-]*$`; `then`, `catch`, `finally`, `toJSON`, `constructor`, `prototype` and `__proto__` are reserved. It posts with `credentials:'include'`, `redirect:'error'` and `cache:'no-store'`, and always sets `x-better-iam: 1`.
- `$request(path, input)` is the escape hatch for plugin endpoints.
- `noInputAuthMethods` and `noInputMethods` handle methods whose only argument is the credential.
- Options: `baseURL`, `basePath`, `token` (string or function; the shape is validated before sending), `headers`, `fetch`, `onUnauthenticated` (fires only for `UNAUTHENTICATED` and `SESSION_NETWORK_MISMATCH`), `retryRateLimited`, `requestId`.
- Errors are `IamClientError(code, message, status, retryAfterMs?, requestId?)`.

**Docs generation**: `scripts/api-reference.mjs` writes `docs/api-reference.md`, as described in section 4. `apps/docs/scripts/generate.mjs` goes further: it runs the TS checker over `packages/server/dist/index.d.ts` to produce JSON Schema per method, `public/openapi.json` (OpenAPI 3.1), an error catalog found by scanning `IamError` codes, and the CLI reference.

---

## 9. Core storage adapter contract (the pattern to reuse)

- **`IamStore`** (`core/src/index.ts:59`):
  - Required: `get`, `find(collection, filter?, {limit, offset, after})`, `insert`, `put` (updates only, not an upsert; tenant is immutable), `delete`, `transaction(fn)` (writes only inside it; nested calls join), `migrate`, `close` (idempotent).
  - Optional: `findOrdered`, `collections`, `describe`.
  - `StoredRecord = { id, tenantId, uniqueKey?, ...json }`. Filters use strict typed equality on top-level fields, and results are ordered by id in code-point order.
- **One generic table** (`core/src/sql.ts`):
  ```sql
  iam_records (collection, id, tenant_id, unique_key, data TEXT,
               PRIMARY KEY (collection, id), UNIQUE (collection, tenant_id, unique_key))
  ```
  Postgres uses `TEXT COLLATE "C"`.
- **Migration ledger**:
  - `schemaMigrations(dialect)` is an **ordered, append-only** list of named steps `0001_records` through `0005_lookup_indexes`. The code says "Never edit a released step; add a new one."
  - `applyMigrations(execute, dialect, { before? })` creates `iam_schema_version` (a single row, version 1) and `iam_migrations (name PK, applied_at)`, then runs the missing steps inside the adapter's serialized write transaction.
  - `describeRecords` backs `doctor`.
- **Shared base**: `abstract class RecordStore implements IamStore` (`storage.ts:370`) holds all the semantics. An adapter only supplies a `RecordDriver` (select, insert, update, delete, optional `query(RecordQuery)`), transaction boundaries, `migrate` and `close`. SQL helpers `planQuery`, `sqliteSelect` and `postgresSelect` are exported.
- **Conformance suite**:
  - `@better-iam/core/conformance` exports `adapterConformanceCases(): ConformanceCase[]` where each case is `{ name, run(store) }`, plus `ConformanceFailure` and `runAdapterConformance`.
  - The suite is framework-agnostic (throws on failure) and is published, so third-party adapters can run it.
  - The per-backend runner is in `tests/adapter-conformance.test.ts`.
  - The contract is documented in `docs/extensions.md`.
- **Plugin contract** (`IamPlugin`): `{ id, actions?, resourceTypes?, endpoints?: [{ method:'POST', path, action, validate, handler(ctx,input) }], hooks?, validateConfig?, migrate?(store), resolveContext?, afterAudit?, purge?(store, tenantIds) }`. The reference implementation is `packages/projects`, which keeps plugin-owned collections in the same store.

---

## 10. apps/, examples/, .claude/

**`apps/console`** (`@better-iam/console`, private, Next 15):
- Depends only on **`better-iam: workspace:*`**, so it dogfoods the umbrella's published surface.
- `src/app/api/iam/[...path]/route.ts` exports one `handle` as POST, OPTIONS, GET, PUT, PATCH and DELETE, with `runtime='nodejs'` and `dynamic='force-dynamic'`. It calls `(await getIam()).handler(request)`.
- `src/lib/iam.ts` keeps a `server-only` singleton on `globalThis` that survives dev reloads.
- `better-iam.config.mjs` is shared by the app and by `scripts/cli.mjs`, which is just `import { runCli } from 'better-iam/cli'; await runCli(process.argv.slice(2));`. Package scripts `migrate`, `bootstrap` and `doctor` go through it.
- `next.config.ts`: `serverExternalPackages` lists all `@better-iam/*` packages and native drivers; `distDir: process.env.NEXT_DIST_DIR ?? '.next'` lets several instances run at once.
- Route areas: `/admin` (root panel) and `/cloud/[org]`.

**`apps/docs`** (`@better-iam/docs`, Next 16 + Fumadocs, port 4000):
- `scripts/generate.mjs` builds the API, errors, CLI, OpenAPI and package reference data. It runs after `pnpm build`.
- `scripts/check-content.mjs` validates MDX.
- Hand-written `descriptions/api/{group}.md` files are merged into the generated pages.
- `content/docs/{guides,frameworks,federation,operations,reference}`.
- Also serves `llms.txt` and an MCP route at `app/api/mcp`.
- Authoring rules are in `apps/docs/README.md`: second person, sentence-case headings, never invent an API.

**`examples/`**, each named `@better-iam/example-<name>`, private, using `workspace:*`:
- `shared/` exports `./config` (`createExampleConfig(database)`), `./server` (`startExample`) and `./cli`. Its `smoke.mjs` runs in CI.
- `sqlite/` and `postgres/` contain just `better-iam.config.mjs` and `server.mjs`, with scripts calling `../shared/cli.mjs migrate|bootstrap|doctor`.
- The framework examples (`nextjs`, `nuxt`, `nestjs`, `sveltekit`, `react-router`) each have a `smoke.mjs` and a README.

**`.claude/launch.json`**:
- Format: `{ version: "0.0.1", configurations: [{ name, runtimeExecutable: "powershell", runtimeArgs: ["-NoProfile","-Command","<env>; node ..."], port, autoPort? }] }`.
- Entries: `docs` (4000), `example-sqlite` (3000), `console` (3000), plus per-session entries `console-<6hex>` on unique ports (3100 to 3950) with `NEXT_DIST_DIR=.next-<id>` and `%TEMP%\better-iam-console-<id>.db`.
- Every entry hard-codes `C:\Users\Sean Filimon\AppData\Local\Author Software\nvm\installs\v24.21.0` on PATH.

**`.claude/coordination.md`** (the multi-session working agreement; 97 KB, gitignored):
- The header rules, verbatim: "No git here: several Claude sessions edit this tree at once. Claim an area below before editing, re-read shared files right before each edit, insert your own lines instead of rewriting blocks, and never run `prettier --write .` on the whole tree (format only your own files). Announce full `vitest run`s."
- Each session gets a `## Session <6hex> ("<title>", <local id>)` section with `Claimed:`, `(in progress)` and `SHIPPED (green at N files / M)` lines. Entries name every file and exact symbol touched.
- Shared registries are changed by one-line inserts only: "one `'roleMining'` line in http.ts `routeGroups`", "one nav line in `[org]/layout.tsx`".
- Each session verifies in the browser on its own `console-<id>` launch entry.

---

## 11. `artifacts/` and how better-compute can depend on unpublished better-iam

**Contents**: 23 tarballs `better-iam-*-0.1.0.tgz` (scope flattened: `@better-iam/core` becomes `better-iam-core-0.1.0.tgz`, the umbrella is `better-iam-0.1.0.tgz`), about 1.9 MB total; server alone is about 1 MB.
- They were produced by `pnpm pack:all` at 2026-09-23 04:12, which is later than the newest source file (02:56), so they are current.
- They contain `dist/`, `LICENSE`, `README.md` and `package.json`. Inside, `workspace:*` has already been rewritten to `"0.1.0"`, a version that does not exist on npm.
- The directory is gitignored and rebuilt on demand.

**Options, compared**:

| Option | Verdict |
|---|---|
| `"@better-iam/server": "file:../better-iam/packages/server"` (a directory) | **Does not work.** The manifest's `workspace:*` deps cannot resolve outside the better-iam workspace. |
| `link:../better-iam/packages/<pkg>` for each package (as deps or pnpm `overrides`) | Live updates after `pnpm build` in better-iam, and deps resolve from better-iam's own `node_modules`. But it exposes better-compute to half-built `dist/` while other sessions are editing better-iam (see `coordination.md`). It can also load two copies of a package (so `instanceof IamError` breaks), ties native `argon2` and `better-sqlite3` builds to better-iam's Node version, and fails in CI where `../better-iam` doesn't exist. **Use only as an opt-in dev loop.** |
| **Packed tarballs plus `overrides` for every `@better-iam/*` package** (exactly what `scripts/packed-smoke.mjs` does) | **Recommended.** It installs the real published shape (exports map, `files`, attw- and publint-checked), gives deterministic snapshots unaffected by concurrent edits, records integrity in the lockfile, and switches to npm later with a one-line change. |

**Recommended setup for better-compute**:
1. **Snapshot script.** Add `scripts/sync-better-iam.mjs`. It runs `pnpm pack:all` in `../better-iam` through `runPnpm` (or just reads the existing tarballs), copies them to `vendor/better-iam/`, writes `vendor/better-iam/SOURCE.json` (the source path, pack time and version), and regenerates the `overrides` block. Commit `vendor/` (about 1.9 MB) so CI works without the sibling repo. The alternative is a second `actions/checkout` of `Better-IAM/better-iam` followed by `pnpm pack:all`.
2. **`pnpm-workspace.yaml`**:
   ```yaml
   packages: [packages/*, apps/*, examples/*]
   allowBuilds: { argon2: true, better-sqlite3: true, esbuild: true }  # argon2 via @better-iam/auth, better-sqlite3 via adapter-sqlite
   overrides:
     better-iam: file:vendor/better-iam/better-iam-0.1.0.tgz
     "@better-iam/core": file:vendor/better-iam/better-iam-core-0.1.0.tgz
     "@better-iam/auth": file:vendor/better-iam/better-iam-auth-0.1.0.tgz
     "@better-iam/server": file:vendor/better-iam/better-iam-server-0.1.0.tgz
     "@better-iam/client": file:vendor/better-iam/better-iam-client-0.1.0.tgz
     # ...all 23; transitive @better-iam/* 0.1.0 specs must be overridden or install 404s
   ```
   `packed-smoke.mjs` has proven the absolute-path form (forward slashes, `resolve(...).replaceAll('\\','/')`). The relative `file:vendor/...` form in overrides needs a one-time check that it resolves from the workspace root.
3. **Declare better-iam as a peer.** In the IAM bridge package (for example `@better-compute/iam`), declare `"peerDependencies": { "@better-iam/server": "^0.1.0", "@better-iam/core": "^0.1.0" }` and put the same names at `0.1.0` in `devDependencies` for tests. The host app then provides the single IAM instance and one copy of `IamError`. In the `better-compute` umbrella, mark them `peerDependenciesMeta: { optional: true }`, the same way better-iam treats its framework peers.
4. **After re-packing**, run `pnpm install --force`. The filenames stay `-0.1.0.tgz`, so a plain install may keep cached content or report an integrity mismatch.
5. **Once better-iam publishes** (its CI publishes on main when `NPM_TOKEN` is set), delete the overrides and keep `^0.1.0`.

**better-iam surfaces better-compute will import** (this decides which tarballs matter):
- **From `@better-iam/server`**:
  - `betterIam({ plugins: [IamPlugin], permissions: { resourceTypes } })`
  - `iam.require`, `iam.authorize`, `iam.authorizeMany`, `iam.listAccessible`, `iam.authenticate`
  - `iam.api.resources.register`, `iam.api.serviceAccounts.*`, `iam.api.credentials.create({ scopes })`
  - `sts.assumeRoleWithWebIdentity` (workload identity for daemons)
  - `iam.billing.record` (GPU-hour meters)
  - `verifyAssertion` with `iam.assertionKey()`, `verifyWebhookSignature`, `iam.events`
- **From `better-iam/session-tokens`**: `createSessionTokenVerifier`, for offline JWT verification against `/.well-known/jwks.json` in control-plane replicas and daemons.
- **From `better-iam/client`**: `createIamClient`.
- **Transitive packages**: core and auth.

---

## Mirror checklist for better-compute

**Workspace and tooling**
- Root package `better-compute-workspace`: private, ESM, MIT, `packageManager: pnpm@11.19.0`, with pnpm also as a devDependency and pinned in CI.
- `engines.node >=22.12.0` at the root and in every package.
- The same scripts: `build`, `typecheck`, `test`, `test:postgres`, `check`, `validate:packages`, `pack:all`, `check:packed-types`, `test:packed`, `bench:scale`, `format`, `format:check`, `docs:api`.
- `pnpm-workspace.yaml` with `packages/*`, `apps/*`, `examples/*` and an `allowBuilds` allowlist.
- Copy `tsconfig.base.json` verbatim. Root `tsconfig.json` uses `files: []` with references in dependency order and the umbrella last.
- The same Prettier config (singleQuote, printWidth 100, trailingComma all), `.gitattributes` with `eol=lf`, `.gitignore` and `.prettierignore` (including `artifacts/`, `work/`, `.claude/`, `vendor/` rules as needed).

**Packages**
- Scoped `@better-compute/*` packages with the identical `package.json` block: `files`, `main`/`types`, a conditions-only `{types, import}` exports map, `sideEffects:false`, `publishConfig.access public`, `repository.directory`, `homepage`, `bugs`, `keywords`, `build: tsc -b`, and `workspace:*` between siblings, mirrored in tsconfig `references`.
- Browser-safe `@better-compute/core` with no Node imports: types, `ComputeError(code, message, status)`, the `ComputeStore` contract, the `RecordStore` base, SQL helpers and migrations. Publish a `./conformance` subpath with `adapterConformanceCases()`.
- Separate subpath files for runtime-neutral pieces, the way server has `./assertions` and `./session-tokens`. The daemon agent protocol types are a candidate.
- The umbrella `better-compute`:
  - one-line `export * from '@better-compute/x'` files per subpath (`./metal`, `./vps`, `./provision`, `./inventory`, `./client`, `./cli`, `./core`, adapters, and so on)
  - a curated `index.ts`
  - `bin` pointing at `cli-bin.ts`, which calls `runBinary()`
  - optional peers for framework and IAM integrations
  - providers loaded through dependency inversion (`useProvider` or `providers: [...]`), never imported by the control-plane core
- Per-package README (purpose, import snippet, operational notes) and LICENSE.

**Server and API**
- A `betterCompute(options)` factory returning `{ api, handler, nodeHandler, require/authorize, initialize, store, endpoint, ...jobs }`.
- `api/index.ts` `createApi(ctx)` plus `api/<group>.ts` files. Every method is `(credential, input) => operation(credential, tenantId, 'compute:<area>:<verb>', '<resource>/*', fn)`.
- `routeGroups` and `publicApiMethods` sets in `http.ts`.
- HTTP convention:
  - `POST /api/compute/{group}/{method}` with a JSON body
  - `X-Better-Compute: 1` plus JSON content-type as the CSRF gate; exact trusted Origin for cookie requests
  - `{data}` / `{error:{code,message}}` envelope
  - 64 KiB body cap, `X-Request-Id` echo
  - GET only for `/health`, `/metrics` and JWKS
  - NOT_FOUND for unknown routes
- `createComputeClient<typeof compute>()`: a Proxy client with the credential parameter stripped by type inference, a `$request` escape hatch, `onUnauthenticated`, `retryRateLimited` and `requestId`.

**CLI**
- `@better-compute/cli` built with `defineCommand({ target: 'config'|'token'|'none' })`.
- `better-compute.config.{mjs,ts}` discovered by walking parent directories; `defineConfig` factory with `{command, env, cwd}`; `configFromEnv` (`BETTER_COMPUTE_DATABASE_URL`, `BETTER_COMPUTE_SECRET`).
- Profiles file `%APPDATA%\better-compute\credentials.json` (XDG elsewhere), written 0600 atomically.
- `BETTER_COMPUTE_TOKEN`, `_URL`, `_PROFILE`, `_CONFIG`, `_DEBUG`.
- `api GROUP.METHOD key=value` with local and remote transports that mirror the router.
- Exit codes 0/2/1 and a `help --json` manifest.

**Scripts**
- Copy `tooling.mjs` (`runPnpm`), `validate-packages.mjs`, `pack.mjs`, `check-packed-types.mjs`, `packed-smoke.mjs`, `release-version.mjs` and `api-reference.mjs` with names swapped.
- Keep one synchronized version and one CHANGELOG with `## Unreleased` and per-version sections.

**Tests**
- Root `tests/*.test.ts` with vitest aliases to `packages/*/src` (subpaths first).
- A `tests/support/` fixture in the style of `clusterFixture()`: in-memory store, fake clock, fake daemons, `closeFixtures`.
- `tests/tsconfig.<area>.json` type-test projects, a matrix-driven adapter conformance test, and `tests/bench/*.bench.ts` behind `vitest.bench.config.ts`.

**CI**
- ubuntu and windows by Node 22 and 24: `pnpm check`, then example smoke, pack, attw, packed smoke.
- A Postgres service job.
- Publish on main when the umbrella version is not yet on npm, with provenance and a GitHub release.

**Apps, examples and working agreement**
- `apps/console` depending only on the umbrella; `apps/docs` generated from the live instance and TS declarations.
- `examples/shared` holding config, server, cli and smoke, with one directory per backend or provider.
- `.claude/coordination.md` with the same claim, insert-only and announce rules, and per-session `console-<id>` launch entries on unique ports and dist directories.

**Storage**
- Generic records table `compute_records (collection, id, tenant_id, unique_key, data)`, an append-only named migration ledger `compute_migrations` plus `compute_schema_version`, `describe()` for `doctor`, and the conformance suite.

---

## Things NOT to copy

- **Database-wide write serialization.** better-iam serializes every write through one database lock (`pg_advisory_xact_lock(1647206759, 1)` in adapter-postgres). That is fine for IAM but wrong for a horizontally scalable control plane with daemon heartbeats. Keep the records-table and migrations pattern, but use per-row or optimistic concurrency and a separate append-only or TTL path for heartbeats and telemetry.
- **Umbrella hard-depending on everything.** The "lazy" loading is import-time only. Ship `@better-compute/daemon` as a standalone package with its own `bin` and minimal dependencies (possibly single-file bundled), outside the umbrella's hard deps, the way `@better-iam/nuxt` is "install directly; not in umbrella". The daemon is deployed to every node.
- **One monolithic server package** (about 1 MB tarball, 141 KB API files). Split the domains (metal, vps, provision, inventory) into packages as the user asked.
- **Identical boilerplate `description` and README text across all packages.** "Composable authentication..." appears everywhere, along with legacy lines like "Publication does not grant rights; see LICENSE" and "No AWS wire compatibility is claimed", which contradict MIT and are left over from the `UNLICENSED` era.
- **`.claude/launch.json` debris**: the hard-coded nvm Node path, the pile of `console-<hash>` entries, and `fake-scim-205c24` pointing into a Temp scratchpad. The same goes for `.next-<hash>` entries in `apps/console/tsconfig.json`, the empty `.swc/`, and leftover `work/snapshot-test-*` directories.
- **Working without git.** Initialize git from day one and make it available to sessions.
- **Small script flaws**: unused imports (`spawnSync`, `readFile`) in `pack.mjs` and `validate-packages.mjs`; the missing space in `&&pnpm --filter` in `typecheck`; `validate-packages` assuming every exports entry is an object; the `allowBuilds` list duplicated between `pnpm-workspace.yaml` and `packed-smoke.mjs` (generate it from one source).
- **IAM-specific wire details**: the `auth` group special cases (`beginMfa`/`confirmMfa` dispatch, `noInputAuthMethods`), cookie session issuance, and `X-Better-IAM-Persistent`. better-compute should rely on better-iam for sessions and accept bearer tokens or JWTs only.
- **A 300-line "Unreleased" CHANGELOG** accumulated across sessions. Keep the format, but cut releases regularly.