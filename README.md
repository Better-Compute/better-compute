# better-compute

An embeddable TypeScript control plane for GPU and bare-metal capacity. better-compute tracks what hardware exists, what is free and who holds it, with double-booking impossible by construction: the database referees every booking. It also makes machines useful: adopt a running server, deploy an image over PXE, or run a VPS on your own hosts or a provider's. [better-iam](https://github.com/Better-IAM/better-iam) is the only identity provider, policy decision point and billing ledger; better-compute owns only its machine PKI.

**Status: P0 (scaffold) · Node.js 22.12+ · PostgreSQL 16+ (CI on 17), PGlite for development · Apache-2.0**

Nothing is published yet. The package names are publication targets, and better-compute will not publish while it depends on better-iam through vendored tarballs. [PLAN.md](PLAN.md) is the approved design and roadmap.

## Runtime parts

- **`bcd`**, one Go binary on every server. Mode `node` runs on every machine (session, inventory, NVML health, CDI device holds, commands), `site` runs per datacenter (proxy DHCP, iPXE, image cache, BMC access) and `ramdisk` runs during PXE commissioning. It only ever dials out.
- **The control plane**, `betterCompute(options)`. Like `betterIam()`, it returns `{ api, handler, nodeHandler, initialize, start, … }`, and it runs in process modes `api`, `gateway`, `worker` or `all`. Postgres is the truth: bookings are guarded by `EXCLUDE` constraints, and all SQL reads one clock, `compute_now()`.
- **The API**, `POST /api/compute/{group}/{method}`, with a typed client inferred from the server, a CLI and (from v0.3) MCP tools. Every mutation makes one better-iam decision; fleet paths (heartbeats, inventory, commands) never call IAM.

```
SDK · CLI · MCP ──► api (authn/z, admission, placement) ──► Postgres ◄── worker (controllers, sinks)
                                                               ▲
bcd node · bcd site · bcd ramdisk ──── gRPC over mTLS, outbound 443 ──── gateway (sessions, dispatch)
```

## Package imports

The umbrella `better-compute` installs the packages below together and exposes them as subpaths; each is also published on its own as `@better-compute/<name>`. Injected modules (`provision`, `metal`, `vps`) are loaded only when an application imports and passes them in: the server never imports them.

| Import                     | Purpose                                                                                       | Status                |
| -------------------------- | --------------------------------------------------------------------------------------------- | --------------------- |
| `better-compute`           | `betterCompute`, `defineConfig`, `ComputeError`, the `define*` helpers, `manifest`, `field`   | P0                    |
| `better-compute/core`      | Browser-safe contracts: IDs, errors, domain types, state tables, extension and port contracts | P0, frozen            |
| `better-compute/protocol`  | Generated daemon ↔ control-plane wire types (`bettercompute.agent.v1` and friends)           | P0; `agent/v1` frozen |
| `better-compute/inventory` | Inventory hashing and diffs, GPU model mapping, health conditions; `inventoryModule`          | stub; v0.1            |
| `better-compute/provision` | Workflow engine, `defineStep`, `defineProfile`, images                                        | stub; v0.2            |
| `better-compute/metal`     | Bare-metal verbs and drivers (power, boot, deploy, inspect); `metal()`                        | stub; v0.2            |
| `better-compute/vps`       | VPS instances, runtimes, flavors, `defineProvider`; `vps()`                                   | stub; v0.3            |
| `better-compute/server`    | The control plane: `betterCompute()`, operation envelope, router, controller runtimes         | shell; v0.1           |
| `better-compute/postgres`  | PostgreSQL store (PgBouncer-safe), migrations, `compute_now()`, store conformance             | P0                    |
| `better-compute/pglite`    | PGlite store for development and tests (one connection, serialized transactions)              | P0                    |
| `better-compute/client`    | Typed, browser-safe API client                                                                | shell; v0.1           |
| `better-compute/cli`       | The `better-compute` command line (also the package's bin)                                    | shell; v0.1           |
| `better-compute/testing`   | Fixtures, simulated daemons, sim clock, conformance runners                                   | shell; v0.1           |

Later phases add `better-compute/capacity`, `/gateway`, `/pki`, `/iam` and `/iam/plugin` (v0.1) and `/mcp` (v0.3). Providers (`@better-compute/provider-hetzner` from v0.3, `provider-proxmox`), `@better-compute/driver-sdk` and `@better-compute/console-kit` stay outside the umbrella and are installed directly; `bcd` ships as release binaries.

```ts
import { betterCompute } from 'better-compute';
import { metal } from 'better-compute/metal';
import { postgres } from 'better-compute/postgres';
```

## Develop locally

pnpm 11.19.0 is pinned (`packageManager`, a root devDependency, and CI). On a fresh clone install with that version, then use the pinned copy in `node_modules`; plain `pnpm` works when your global pnpm is 11.x (pnpm 12 refuses this workspace).

```sh
npx pnpm@11.19.0 install                                   # once, on a fresh clone
node node_modules/pnpm/bin/pnpm.mjs check                  # typecheck, tests, repository rules, package validation
node node_modules/pnpm/bin/pnpm.mjs exec vitest run tests/scripts-umbrella.test.ts
node node_modules/pnpm/bin/pnpm.mjs pack:all
node node_modules/pnpm/bin/pnpm.mjs check:packed-types
node node_modules/pnpm/bin/pnpm.mjs test:packed            # installs the tarballs in a fresh consumer
```

Tests run against source (`tests/*.test.ts`, aliases in `vitest.config.ts`) on PGlite and embedded better-iam over in-memory SQLite, so no database server is needed. Postgres-only suites run when `BETTER_COMPUTE_POSTGRES_URL` is set:

```sh
BETTER_COMPUTE_POSTGRES_URL=postgres://postgres:postgres@localhost:5432/better_compute_test \
  node node_modules/pnpm/bin/pnpm.mjs test:postgres
```

The daemon needs Go (`daemon/go.mod`): `go test -tags nonvml,fakehw ./...` inside `daemon/` runs its logic without GPUs, on Linux or Windows. [docs/development.md](docs/development.md) covers the scripts, the repository rules CI enforces, the vendored better-iam and releases.

## Documentation

- [PLAN.md](PLAN.md): architecture, contracts, security model and roadmap
- [docs/development.md](docs/development.md): working in this repository
- [docs/research/](docs/research/): the research the plan cites (better-iam, Daytona, prior art)
- [bench/REFERENCE.md](bench/REFERENCE.md): the reference hardware benchmark results are quoted on
- [CHANGELOG.md](CHANGELOG.md)

## License

[Apache License 2.0](LICENSE), including the Go daemon.
