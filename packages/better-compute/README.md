# better-compute

An embeddable TypeScript control plane for GPU, CPU and bare-metal capacity, with every better-compute package in one
install.

better-compute tracks what hardware exists, what is free and who holds it. The database referees every booking, so
double-booking cannot happen. It also makes machines useful: adopt a running server, deploy an image over PXE, or run
a VPS or a sandbox on your own hosts or a provider's. [Better IAM](https://www.npmjs.com/package/better-iam) is the
identity provider, policy decision point and billing ledger.

## Install

```sh
npm install better-compute better-iam
```

- Better IAM (`better-iam`, `>=0.2.0 <0.4.0`) is required for identity and authorization. The umbrella declares the
  `@better-iam/*` packages it uses (`server`, `core`, `client`, `cli`, `mcp`, `adapter-sqlite`) as optional peers, and
  `better-iam` brings them.
- `@electric-sql/pglite` (`^0.5.8`) is an optional peer for `better-compute/pglite`, the testing fixture and
  `better-compute dev` without a database URL: `npm install @electric-sql/pglite`.
- Node.js 22.12 or later, ESM only. PostgreSQL 16 or later in production; PGlite for development and tests.

Each package is also published on its own as `@better-compute/<name>`, for services that need only part of the
platform (for example a browser bundle that needs only `@better-compute/client`).

## Usage

Try it with simulated GPU machines and an embedded Better IAM, no database server needed:

```sh
npm install better-compute better-iam @electric-sql/pglite
npx better-compute dev --memory --sim 8
```

Embed the control plane in your own service:

```ts
import { betterCompute } from 'better-compute';
import { metal } from 'better-compute/metal';
import { postgres } from 'better-compute/postgres';
import { provisionModule } from 'better-compute/provision';
import { vps } from 'better-compute/vps';

const bareMetal = metal();

export const compute = betterCompute({
  database: postgres({ url: process.env.BETTER_COMPUTE_DATABASE_URL! }),
  secret: process.env.BETTER_COMPUTE_SECRET!, // at least 32 characters
  baseURL: 'https://compute.example.com',
  rootTenantId, // the Better IAM root (platform) tenant
  iam, // an IamPort from better-compute/iam
  modules: [provisionModule({ modules: [bareMetal] }), bareMetal, vps()],
});
await compute.initialize(); // migrates the store, then starts the modules
// Serve compute.handler (fetch) or compute.nodeHandler (Node.js) under /api/compute.
```

Call it from anywhere with the typed client:

```ts
import { createComputeClient } from 'better-compute/client';
import type { compute } from './compute.server'; // type-only

const client = createComputeClient<typeof compute>({
  baseURL: 'https://compute.example.com',
  token: () => process.env.BETTER_COMPUTE_TOKEN,
});
const { version } = await client.system.version();
```

## Three runtime parts

- **`bcd`** is one Go binary. It runs in mode `node` on every server, `site` once per datacenter (proxy DHCP, iPXE,
  image cache, BMC access) and `ramdisk` during PXE commissioning. It only dials out, and it will ship as release
  binaries, not through npm. It is built and tested against simulated and fake hardware but has no released binary
  yet; `better-compute dev --sim` and the `FakeDaemon` of `better-compute/testing` speak its protocol meanwhile.
- **The control plane** is `betterCompute(options)` from this package. It returns
  `{ api, handler, nodeHandler, initialize, start, … }` and runs in process mode `api`, `gateway`, `worker` or `all`.
  Postgres is the truth, and all SQL reads one clock, `compute_now()`.
- **The API** is `POST /api/compute/{group}/{method}`. It comes with a typed client inferred from the server, the
  `better-compute` CLI (this package's bin) and MCP tools.

Nothing has run on real GPU hardware or on a real TPM yet: the hardware paths are tested against captured output and
fakes.

## Imports

The root entry loads only `@better-compute/server` and `@better-compute/core`. Every other subpath loads only when an
application imports it. The server never imports the injected modules (`provision`, `metal`, `vps`): the application
passes them in. `inventory` and `capacity` are built in and always registered.

| Import                                              | Contents                                                                                                                              |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `better-compute`                                    | `betterCompute`, `defineConfig`, `configOptions`, `ComputeError`, the `define*` helpers (below), `manifest`, `field`, and their types |
| `better-compute/core`                               | Browser-safe contracts: ids, errors, domain types, state tables, extension and port contracts, the IAM catalog, `defineMethod`        |
| `better-compute/protocol`                           | Generated `bcd` ↔ control-plane wire types and helpers                                                                               |
| `better-compute/inventory`                          | Section hashing, diffs, GPU model mapping, labels and health conditions                                                               |
| `better-compute/capacity`                           | Atoms, bookings, quotas, rollups and the placement pipeline                                                                           |
| `better-compute/provision`                          | The workflow engine, `defineStep`, `defineProfile`, `provisionModule()`                                                               |
| `better-compute/metal`                              | Bare-metal verbs and drivers (power, management, boot, deploy, inspect), `metal()`                                                    |
| `better-compute/vps`                                | Instances and sandboxes, runtimes, flavors, `defineProvider`, `vps()`                                                                 |
| `better-compute/iam`, `/iam/plugin`, `/iam/testing` | The Better IAM bridge, the plugin for IAM hosts, and an embedded Better IAM for tests and `dev --sim`                                 |
| `better-compute/events`                             | Signed webhooks and the server-sent `/watch` stream                                                                                   |
| `better-compute/fleet`                              | FleetConfig export, plan and apply                                                                                                    |
| `better-compute/rollout`                            | Signed `bcd` releases and wave rollouts                                                                                               |
| `better-compute/audit`                              | Signed per-tenant Merkle checkpoints over the audit log                                                                               |
| `better-compute/observability`                      | A bounded Prometheus registry and the standard metrics                                                                                |
| `better-compute/server`                             | Everything the server exports: `betterCompute()`, the envelope, the registry, JoinService, controllers                                |
| `better-compute/gateway`                            | Daemon sessions over gRPC on HTTP/2 mTLS, liveness and dispatch                                                                       |
| `better-compute/pki`                                | Local CAs, SPIFFE node certificates, sealed join tokens, attestors                                                                    |
| `better-compute/postgres`                           | `postgres({ url })` (PgBouncer-safe), migrations, `compute_now()` and sim-clock helpers                                               |
| `better-compute/pglite`                             | `pglite()`, the PGlite store for development and tests                                                                                |
| `better-compute/client`                             | `createComputeClient<typeof compute>()`, the typed, browser-safe client                                                               |
| `better-compute/cli`                                | The `better-compute` command line, which is also this package's bin                                                                   |
| `better-compute/mcp`                                | Model Context Protocol tools for AI agents, gated by Better IAM                                                                       |
| `better-compute/testing`                            | `computeFixture()`, `FakeDaemon`, the fleet simulator, the dev stack                                                                  |

The `define*` helpers of the root entry are `defineModule`, `definePlugin`, `defineDriver`, `defineSchedulerPlugin`,
`defineAttestor` and `defineSink`. `defineMethod`, `defineStep`, `defineProfile` and `defineProvider` come from
`better-compute/core`, `/provision` and `/vps`.

Some packages stay outside the umbrella and are installed directly: `@better-compute/provider-hetzner`,
`@better-compute/provider-proxmox`, `@better-compute/provider-digitalocean`, `@better-compute/provider-kubernetes`, `@better-compute/driver-sdk` and
`@better-compute/console-kit`.

## Documentation

- [Installation](https://better-compute.com/docs/guides/installation)
- [Quickstart](https://better-compute.com/docs/guides/quickstart)
- [API reference](https://better-compute.com/docs/reference/api)

## License

[Apache License 2.0](https://github.com/better-compute/better-compute/blob/main/LICENSE)
