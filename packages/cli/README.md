# @better-compute/cli

The `better-compute` command line: deployment jobs (`init`, `migrate`, `doctor`, `serve`), any API method as an IAM credential (`api`), and shortcuts for capacity, nodes, fleet, PKI and audit work.

## Install

```sh
npm install @better-compute/cli
```

It is also included in the umbrella package as `better-compute/cli`, and the umbrella ships the `better-compute` bin:

```sh
npm install better-compute
```

Better IAM (`npm install better-iam`) provides the optional `@better-iam/*` peers the CLI uses:
`@better-iam/client` for `iam setup --meters`, `@better-iam/cli` to reuse a session saved by
`better-iam login`, and `@better-iam/server` with `@better-iam/adapter-sqlite` for the in-memory
IAM that `dev --sim` starts when no IAM is configured. `@electric-sql/pglite` is an optional peer
for PGlite databases, and `@better-compute/testing` is an optional peer for `sim` and `dev --sim`.

## Usage

```sh
better-compute help                 # every command; help <command> for one; help --json for tools
better-compute init                 # writes better-compute.config.ts (PGlite in development)
better-compute migrate              # finds the nearest better-compute.config.* (or --config PATH)
better-compute doctor --strict      # selfCheck findings; exits 1 (DOCTOR_FINDINGS) on any warning
better-compute serve                # the API and every worker role in one process
better-compute api --list           # every route, whether it needs a token, its IAM action
better-compute api system.version
BETTER_COMPUTE_TOKEN=… better-compute api system.whoami --url https://compute.example.com
BETTER_COMPUTE_TENANT=org_… better-compute reserve --pool pool_… --gpus 4 --for 8h --model H100
```

From code, the same program runs in process and takes project commands:

```ts
import { createCli, defineCommand, runCli } from '@better-compute/cli';

// One command line; failures reject with an error whose `code` says what went wrong.
await runCli(['doctor', '--strict']);

// A project CLI: the built-in commands plus your own.
const seed = defineCommand({
  name: 'seed',
  summary: 'Create the demo sites and pools',
  target: 'config',
  flags: { region: { type: 'string', description: 'Region label', default: 'eu' } },
  async run({ compute, flags }) {
    const instance = await compute();
    // ...create sites and pools through instance
    return { created: true, region: flags.region };
  },
});
await createCli({ commands: [seed] }).run(process.argv.slice(2));
```

The framework is a port of Better IAM's `defineCommand` framework, so project commands get the
same flag parsing, help, configuration loading and output as the built-in ones.

## Commands

Commands may be two words (`pki init`); `help pki` lists a group.

- **Setup:** `init`, `migrate`, `doctor`, `serve`, `dev`, `sim`, `version`, `completion`.
- **API:** `api`, plus `auth login|status|logout` for saved credentials.
- **Capacity:** `reserve`, `release`, `extend`, `reservations list|get`, `pools list`, `capacity`,
  `quotas get|set`, `usage list|export`.
- **Nodes and instances:** `nodes list|get|events|label|taint|cordon|uncordon|drain|delete`,
  `join-tokens create|list|revoke`, `join-requests …`, `instances …`, `inventory get|history|diff`.
- **Access and sandboxes:** `console`, `exec`, `forward`, `ssh-cert`,
  `sandbox create|list|get|extend|snapshot|delete|exec|templates`, `sandbox-template …`,
  `sandbox-volume …`.
- **Bare metal:** `metal enroll|deploy|undeploy|abort|discovered|confirm-mac|power|bulk|…`,
  `profiles …`, `provider-accounts …`, `sandbox-snapshot …`.
- **Fleet and operations:** `fleet export|plan|status|apply`, `rollouts …`, `releases register|list`,
  `workflows …`, `commands …`, `events list|watch`, `webhooks …`, catalog groups (`sites`, `projects`,
  `images`, `flavors`) and admin groups (`pools create|update|archive|offer|unoffer`, `secrets`,
  `site-tokens`, `drivers list`).
- **Machine PKI and the daemon:** `pki init|show|issue-gateway|trust-version|renew-ca|reseal|…`,
  `daemon install-script`, `release keygen|sign|cosign|verify`.
- **Destructive batches:** `batch keygen|sign|sign-approvers|list|show|approve|create|members|cancel`.
- **IAM and audit:** `iam setup`, `audit checkpoint|verify|prove|check-proof`, `support bundle`.

`better-compute help` prints the full list with a summary for each command.

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

Environment-only deployments, and the configuration `init` writes, start with `unconfiguredIam()`:
no credential authenticates, so only the public methods (`system.version`, and `system.whoami`
without a token) answer. `doctor` reports this as the `iam.not-configured` warning. Better IAM
plugs in through the IAM bridge from `better-compute/iam`:
`iam: bridge.embedded(iam, { rootTenantId })`.

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
- **Token.** Token commands use `BETTER_COMPUTE_TOKEN`, else a session saved by `better-iam login`
  (when `@better-iam/cli` is installed), else a profile saved with `better-compute auth login`.
  Public methods need none; `system.whoami` carries the token when one is set.

## Capacity shortcuts

These call the capacity routes as the caller's token (in process, or with `--url`), for the
tenant in `--tenant` or `BETTER_COMPUTE_TENANT`:

| Command                                                                                                                                      | Route                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `reserve --pool ID --gpus N --for 8h [--model M] [--product P] [--selector EXPR] [--nvlink] [--start TIME] [--lease S] [--key K] [--wait S]` | `reservations.create`                       |
| `release RSV [--cancel]`                                                                                                                     | `reservations.release` / `.cancel`          |
| `extend RSV --by 4h \| --until TIME \| --renew`                                                                                              | `reservations.extend` / `.renew`            |
| `reservations list [--state S] [--pool ID]`, `reservations get RSV`                                                                          | `reservations.list` / `.get`                |
| `pools list`                                                                                                                                 | `pools.list`                                |
| `capacity [--pool ID] [--preview --gpus N --for D]`                                                                                          | `capacity.summary` / `.byPool` / `.preview` |

- `--selector` takes the device selector shorthand, parsed by `@better-compute/capacity`, for
  example `gpuProduct in (H100-SXM5-80GB), vramGiB >= 80, !fabric.domain`.
- Times are ISO 8601, epoch milliseconds, or `+DURATION` from now.
- `reserve` and `extend` send a new idempotency key on each run and print it on stderr. Repeat the
  command with `--key` to retry the same request safely.

## Machine PKI and the daemon installer

```sh
BETTER_COMPUTE_SECRET=… better-compute pki init --trust-domain compute.example.com [--offline-root PATH]
better-compute pki show                                       # pins for install scripts; no secret needed
better-compute pki issue-gateway --san gw.eu.example.com      # gateway.key + gateway.crt, 30 days
better-compute daemon install-script --pool pool_… --site fsn1 --gateway-url https://gw.eu.example.com \
  --base-url https://compute.example.com --bcd-version 0.1.0 --sha256 amd64=<hex>,arm64=<hex> > install-bcd.sh
better-compute iam setup --audience https://compute.example.com   # example policies to apply
```

- **`pki init`** writes `.better-compute/pki.json` (`--pki` or `BETTER_COMPUTE_PKI` to move it,
  mode 0600). The bundle holds the root, node, serving and internal CAs and the JoinService signing
  and encryption keys. Private keys are sealed under `BETTER_COMPUTE_SECRET`; `--plaintext` stores
  PEM instead. `--offline-root` keeps the root key in its own file.
- **The install script** reads the join token only from `BCD_JOIN_TOKEN` or standard input. It
  downloads the pinned bcd for the machine's architecture from the control plane's downloads route
  and checks its SHA-256, writes `/etc/bcd/config.toml` (0600, bcd's TOML subset with the three
  pins) and a hardened `bcd.service`, and runs `bcd join`. On a host that is already configured,
  running it without a token upgrades bcd in place. bcd, the Go node agent, is not released as a
  binary yet: the control plane serves a build you make from the repository and register.
- **`iam setup`** prints example compute policies for an organization administrator. With
  `--meters --iam-url URL --root-tenant ID` and a root `BETTER_IAM_TOKEN`, it also creates the
  root billing meters in Better IAM through the optional peer `@better-iam/client`.

## Destructive batches (quorum)

A fleet-wide reimage, wipe or BMC power action runs only after k approvers sign it. Each approver
holds a P-256 key off the control plane, and every daemon checks the signatures itself.

```sh
BETTER_COMPUTE_APPROVER_PASSPHRASE=… better-compute batch keygen --out ~/.better-compute/approver.pem
better-compute batch list --state pending
better-compute batch show --batch batch_… [--scope-out batch.json]
better-compute batch approve --batch batch_… --key ~/.better-compute/approver.pem [--expect my-nodes.txt] --yes
better-compute batch sign --key approver.pem --scope batch.json   # offline; then approve --signature FILE
better-compute batch cancel --batch batch_…
better-compute batch create --reason "reimage rack 7" --scope rack7.json   # [{ subject, kind, payload: { json } }]
better-compute batch members --batch batch_…                               # its commands, held or run
better-compute pki trust-version   # published version/epoch, the approver-set pin, nodes on another set
```

- **`batch keygen`** writes the private key (mode 0600, encrypted under
  `BETTER_COMPUTE_APPROVER_PASSPHRASE` when set) and `<out>.pub`. The public key goes into the
  deployment's `pki.approvers.keys`; the examples read `BETTER_COMPUTE_APPROVER_KEYS` and
  `_THRESHOLD`.
- **`batch approve`** pages the batch's scope and recomputes the Merkle root from it. It refuses
  with `SCOPE_MISMATCH` when the listed commands do not give the root the server asks it to sign.
  It then prints every subject by kind and signs the root, size, expiry and trust domain. Without
  `--yes` it stops after the summary. `--root` approves only the root you reviewed, `--expect`
  only the subjects you list, and `--max-hours` (default 72) refuses long approval windows.
- **`batch sign`** does the same offline from `batch show --scope-out`. Signing a bare `--root`
  needs `--unchecked`.
- **`batch sign-approvers`** is how the quorum itself changes. Each current approver signs the new
  set's keys, threshold, tiers and unbatched cap for one trust-bundle `--version`. Daemons that
  hold approver keys refuse a changed quorum, including its removal, without their threshold of
  such signatures.
- Approvals and set changes sign the deployment's trust domain. The approver pins it with
  `--trust-domain` or `BETTER_COMPUTE_TRUST_DOMAIN`, or it comes from the local PKI bundle; never
  from the server. A batch or scope file of another domain is refused with
  `TRUST_DOMAIN_MISMATCH`.
- `batch approve` and `batch sign` also show each operation a leaf binds, decoded from the stored
  payload the leaf's digest covers. Payloads are decoded as the kind's own type and grouped by
  digest; `--operations-out FILE` writes them in full. A payload that isn't the bound one, or that
  carries fields this CLI can't show, is `SCOPE_MISMATCH`. Leaves shown only as a digest, and kinds
  whose type isn't known here, need `--allow-opaque`.
- `daemon install-script --approver-set-sha256` pins a new node's first approver set; the digest
  comes from `pki trust-version`, computed from the configured keys. `--release-pins`,
  `--release-sequence` and `--bmc-networks` write bcd's `[update]` and `[site]` sections.
- Key files readable by others are refused, as ssh does.

## Output and exit codes

- Results print as indented JSON. `--format compact|table` changes the format, and
  `--query a.b[].c` selects part of the result.
- Failures print `CODE: message` on stderr, then a `Hint:` line when there is one. Control
  characters are stripped. Unknown errors stay generic unless `BETTER_COMPUTE_DEBUG` is set,
  which also prints stacks.
- The exit code is 0 on success, 2 for a usage mistake (`INVALID_ARGUMENT`, `INVALID_COMMAND`)
  and 1 otherwise.

## From code

- `runCli(argv, io)` and `main(argv, cli, io)` run a command line; `runBinary()` is what the bin
  does.
- `createCli({ commands })` and `createCliProgram(builtins, version, io)` build a program;
  `computeCommands(define)` turns every built-in command into another framework's commands, so a
  host (for example Better IAM's CLI) can ship one binary.
- `loadConfig()`, `configFromEnv()`, `localTransport()` and `remoteTransport()` are exported too.

The package's bin is `dist/index.js`, and the `better-compute` umbrella ships it as
`better-compute`.

## Documentation

- [CLI guide](https://better-compute.com/docs/guides/clients/cli)
- [CLI reference](https://better-compute.com/docs/reference/cli)
- [Configuration](https://better-compute.com/docs/operations/configuration)

## License

[Apache License 2.0](https://github.com/better-compute/better-compute/blob/main/LICENSE)
