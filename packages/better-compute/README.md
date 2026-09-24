# better-compute

This umbrella package installs every better-compute package together and exposes each one as a
subpath. better-compute tracks GPU and bare-metal capacity: what exists, what is free and who
holds it. The database referees every booking, so double-booking cannot happen. It also makes
machines useful: adopt a running server, deploy an image over PXE, or run a VPS on your own hosts
or a provider's. better-iam is the only identity provider, policy decision point and billing
ledger.

**Status: P0 (scaffold).** Node.js 22.12 or later; PostgreSQL 16 or later, or PGlite for
development and tests; ESM only. Nothing is published yet. The design and roadmap are in
[PLAN.md](../../PLAN.md).

```ts
import { betterCompute } from 'better-compute';
import { postgres } from 'better-compute/postgres';

const compute = betterCompute({
  database: postgres({ url: process.env.BETTER_COMPUTE_DATABASE_URL! }),
  secret: process.env.BETTER_COMPUTE_SECRET!, // at least 32 characters
  baseURL: 'https://compute.example.com',
  rootTenantId, // the better-iam root (platform) tenant
  iam, // an IamPort: the IAM bridge's embedded(iam) from v0.1
  modules: [], // metal(), vps(), provisionModule() as they land
});
await compute.initialize();
```

## Three runtime parts

- **`bcd`** is one Go binary. It runs in mode `node` on every server, `site` once per datacenter
  (proxy DHCP, iPXE, image cache, BMC access) and `ramdisk` during PXE commissioning. It only
  dials out, and it ships as release binaries, not through npm.
- **The control plane** is `betterCompute(options)` from this package. Like `betterIam()`, it
  returns `{ api, handler, nodeHandler, initialize, start, … }` and runs in process mode `api`,
  `gateway`, `worker` or `all`. Postgres is the truth, and all SQL reads one clock,
  `compute_now()`.
- **The API** is `POST /api/compute/{group}/{method}`. It comes with a typed client inferred from
  the server, the `better-compute` CLI (this package's bin) and, from v0.3, MCP tools.

## Imports

The root entry loads only `@better-compute/server` and `@better-compute/core`. Every other
subpath loads only when an application imports it. The server never imports the injected modules
(`provision`, `metal`, `vps`): the application passes them in.

| Import                     | Contents                                                                                                                              | Status                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `better-compute`           | `betterCompute`, `defineConfig`, `configOptions`, `ComputeError`, the `define*` helpers (below), `manifest`, `field`, and their types | P0                               |
| `better-compute/core`      | Browser-safe contracts: ids, errors, domain types, state tables, extension and port contracts                                         | P0; frozen at the P0 exit        |
| `better-compute/protocol`  | Generated `bcd` ↔ control-plane wire types and helpers                                                                               | P0; `agent/v1` frozen            |
| `better-compute/inventory` | GPU naming (`normalizeGpuProduct`, `gpuModels`), condition types, `inventoryModule`                                                   | stub: methods v0.1–v0.2          |
| `better-compute/provision` | `defineStep`, `defineProfile`, `provisionModule()`                                                                                    | stub: the engine arrives in v0.2 |
| `better-compute/metal`     | Driver kinds `power` … `firmware`, metal verbs, `metal()`                                                                             | stub: `metal()` arrives in v0.2  |
| `better-compute/vps`       | `defineProvider`, the `runtime` driver kind, `vps()`                                                                                  | stub: `vps()` arrives in v0.3    |
| `better-compute/server`    | `betterCompute()`, the operation envelope, the method → action registry, HTTP transports                                              | shell; v0.1                      |
| `better-compute/postgres`  | `postgres()` (PgBouncer-safe), migrations, `compute_now()` and sim-clock helpers, a Kysely dialect                                    | P0                               |
| `better-compute/pglite`    | `pglite()`, the PGlite store for development and tests                                                                                | P0                               |
| `better-compute/client`    | `createComputeClient<typeof compute>()`, the typed, browser-safe client                                                               | P0 shell; v0.1                   |
| `better-compute/cli`       | The `better-compute` command line, which is also this package's bin                                                                   | shell; v0.1                      |
| `better-compute/testing`   | `computeFixture()`, `closeFixtures()`, `fakeIam()`; the simulator and `FakeDaemon` later                                              | shell; v0.1                      |

The `define*` helpers of the root entry are `defineModule`, `definePlugin`, `defineDriver`,
`defineSchedulerPlugin`, `defineAttestor` and `defineSink`. `defineMethod`, `defineStep`,
`defineProfile` and `defineProvider` come from `better-compute/core`, `/provision` and `/vps`.

Calling a stub factory throws `ComputeError` `NOT_IMPLEMENTED`, and its message names the phase
that delivers it (`bare-metal provisioning arrives in v0.2`). The contract types each stub
exports are already the ones the later phases implement.

Later phases add `better-compute/capacity`, `/gateway`, `/pki`, `/iam` and `/iam/plugin` (v0.1)
and `/mcp` (v0.3). Some packages stay outside the umbrella and are installed directly:
`@better-compute/provider-hetzner`, `provider-proxmox`, `driver-sdk` and `console-kit`.

**Optional peers:** `@electric-sql/pglite` (for `better-compute/pglite` and the testing
fixture) and `@better-iam/{core,server,client,cli,adapter-sqlite}` (for embedded IAM). Install
the ones you use.

## License

[Apache License 2.0](LICENSE).
