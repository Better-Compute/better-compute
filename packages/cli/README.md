# @better-compute/cli

The `better-compute` command line. It runs deployment jobs (`init`, `migrate`, `doctor`) and calls
any API method as an IAM credential (`api`). It is a port of better-iam's `defineCommand` framework,
so your own project commands get the same flag parsing, help, configuration loading and output.

**Status: P0 shell.** The commands are `init`, `migrate`, `doctor`, `api`, `version` and `help`.
The rest of PLAN.md §9.3 arrives with its phase.

```sh
better-compute help                 # every command; help <command> for one; help --json for tools
better-compute init                 # writes better-compute.config.ts (PGlite in development)
better-compute migrate              # finds the nearest better-compute.config.* (or --config PATH)
better-compute doctor --strict      # selfCheck findings; exits 1 (DOCTOR_FINDINGS) on any warning
better-compute api --list           # every route, whether it needs a token, its IAM action
better-compute api system.version
BETTER_COMPUTE_TOKEN=… better-compute api system.whoami --url https://compute.example.com
```

## Configuration

Configuration commands find the deployment in this order:

1. `--config PATH`;
2. `BETTER_COMPUTE_CONFIG`;
3. the nearest `better-compute.config.{mjs,js,ts,mts}` in the working directory or a parent
   (`.ts` needs Node.js 22.18 or later);
4. environment-only mode, with no file.

The module's default export is `defineConfig(options)` or `defineConfig(factory)` from
`better-compute/server`. A factory receives `{ command, env, cwd }`. Two named exports are
optional: `commands` (project commands built with `defineCommand`) and `cli.defaults`
(flag defaults, per command or `'*'`). The module is trusted, executable code.

**Environment-only mode** (`configFromEnv`) reads three variables:

- `BETTER_COMPUTE_DATABASE_URL`, one of:
  - `postgres://…`;
  - `pglite:DIR`, a directory relative to the working directory whose parent must exist;
  - `pglite:memory`.

  PGlite needs the optional peer `@electric-sql/pglite`. If it is missing, the command fails with
  `MISSING_DEPENDENCY` and an install hint.

- `BETTER_COMPUTE_SECRET`, at least 32 characters.
- `BETTER_COMPUTE_BASE_URL`, default `http://localhost:3000`.

P0 has no IAM bridge. Environment-only deployments, and the `init` template, use
`unconfiguredIam()`: no credential authenticates, so only the public methods (`system.version`,
and `system.whoami` without a token) answer. `doctor` reports this as the `iam.not-configured`
warning. Embedded better-iam plugs in as `iam: bridge.embedded(iam, { rootTenantId })` in v0.1.

## `api`

```
better-compute api GROUP.METHOD [key=value ...] [--data JSON|@FILE|-] [--list [GROUP]] [--config PATH] [--url URL]
```

- **Input.** HTTPie-style items, which `--data` can seed:
  - `name=x` sets a string and `limit:=10` sets JSON;
  - `spec:=@f.json` reads a JSON file and `notes=@f.md` reads a text file;
  - `a.b=x` nests and `ids[]=a` appends.

  Plugin methods are `plugins.ID.GROUP.METHOD`.

- **In process** (the default), calls go through `compute.handler`. They get exactly the HTTP
  route table, envelope, CSRF headers, 64 KiB body limit and JSON round trip.
- **Remote** (`--url` or `BETTER_COMPUTE_URL`), calls use the typed client with a request id and
  one rate-limit retry. `https` is required except for localhost.
- **Token.** The token is `BETTER_COMPUTE_TOKEN`. Public methods need none; `system.whoami`
  carries the token when one is set.

## Output and exit codes

- Results print as indented JSON. `--format compact|table` changes the format, and
  `--query a.b[].c` selects part of the result.
- Failures print `CODE: message` on stderr, then a `Hint:` line when there is one. Control
  characters are stripped. Unknown errors stay generic unless `BETTER_COMPUTE_DEBUG` is set,
  which also prints stacks.
- The exit code is 0 on success, 2 for a usage mistake (`INVALID_ARGUMENT`, `INVALID_COMMAND`)
  and 1 otherwise.

## From code

- `runCli(argv, io)` and `main(argv, cli, io)` run a command line.
- `createCli({ commands })` and `createCliProgram(builtins, version, io)` build a program.
- `loadConfig()`, `configFromEnv()`, `localTransport()` and `remoteTransport()` are exported too.

The package's bin is `dist/index.js`, and the `better-compute` umbrella ships it as
`better-compute`.
