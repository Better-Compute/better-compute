# better-compute

[![npm version](https://img.shields.io/npm/v/better-compute.svg)](https://www.npmjs.com/package/better-compute)
[![license](https://img.shields.io/npm/l/better-compute.svg)](LICENSE)
[![CI](https://github.com/better-compute/better-compute/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/better-compute/better-compute/actions/workflows/ci.yml)

An embeddable TypeScript control plane for GPU, CPU and bare-metal capacity. better-compute tracks what hardware
exists, what is free and who holds it, and the database referees every booking, so double-booking is impossible by
construction. It also makes machines useful: adopt a running server, deploy an image over PXE, run a VPS or a sandbox
on your own hosts or a provider's (Hetzner Cloud, Proxmox VE, Google Compute Engine, DigitalOcean), hand cloud VMs and reservations
the platform holds to customer tenants with their own networks and firewall rules, and reserve whole GPUs, MIG slices
or gangs of nodes through one typed API, a CLI or MCP tools. [Better IAM](https://github.com/Better-IAM/better-iam) is
the identity provider, policy decision point and billing ledger; better-compute owns only its machine PKI.

**Documentation: [better-compute.com/docs](https://better-compute.com/docs/guides)**

## Install

```sh
npm install better-compute better-iam
```

`better-compute` is the umbrella package: it installs every `@better-compute/*` package it covers and exposes each one
as a subpath (`better-compute/postgres`, `better-compute/client`, …), plus the `better-compute` command. Better IAM
(`better-iam`, `>=0.2.0 <0.4.0`) is required for identity and authorization. Requirements: Node.js 22.12 or later (ESM only),
and PostgreSQL 16 or later in production or PGlite (`@electric-sql/pglite`) for development. See
[Installation](https://better-compute.com/docs/guides/installation) for the optional peers and the packages outside the
umbrella.

## Quickstart

Run a complete control plane on your laptop: an in-memory PGlite database, an embedded Better IAM, a gateway, and eight
simulated HGX H100 machines that join the way the real daemon does.

```sh
npm install better-compute better-iam @electric-sql/pglite
npx better-compute dev --memory --sim 8
```

`dev` serves the API on `http://127.0.0.1:3000` and prints a root administrator's token and tenant for the embedded
Better IAM. In a second terminal in the same directory, reserve four GPUs, look at the pool's capacity and release
them:

```sh
export BETTER_COMPUTE_URL=http://127.0.0.1:3000
export BETTER_COMPUTE_TOKEN='biam_ses_…'   # the root token dev printed
export BETTER_COMPUTE_TENANT='…'           # the root tenant dev printed

npx better-compute pools list --query "items[].id"
npx better-compute reserve --pool pool_… --gpus 4 --for 1h
npx better-compute capacity --pool pool_…     # allocated: 4, available: 60
npx better-compute release rsv_…
```

In your own service, `betterCompute()` returns the API, a fetch handler and a Node.js handler, and the client is typed
from your server instance without code generation:

```ts
import { betterCompute } from 'better-compute';
import { postgres } from 'better-compute/postgres';

export const compute = betterCompute({
  database: postgres({ url: process.env.BETTER_COMPUTE_DATABASE_URL! }),
  secret: process.env.BETTER_COMPUTE_SECRET!, // at least 32 characters
  baseURL: 'https://compute.example.com',
  rootTenantId, // the Better IAM root (platform) tenant
  iam, // an IamPort from better-compute/iam
});
await compute.initialize(); // migrates, then starts the modules
```

```ts
import { createComputeClient } from 'better-compute/client';
import type { compute } from './compute.server'; // type-only

const client = createComputeClient<typeof compute>({
  baseURL: 'https://compute.example.com',
  token: () => process.env.BETTER_COMPUTE_TOKEN,
});
await client.reservations.create({
  tenantId,
  poolId,
  devices: [{ class: 'gpu', count: 4 }],
  duration: 3_600_000,
  binding: 'hold',
  idempotencyKey: 'train-1',
});
```

The [quickstart](https://better-compute.com/docs/guides/quickstart) walks through every step, including events and
your own configuration file (`better-compute init`).

## Documentation

- [Guides](https://better-compute.com/docs/guides): [quickstart](https://better-compute.com/docs/guides/quickstart),
  [installation](https://better-compute.com/docs/guides/installation),
  [concepts](https://better-compute.com/docs/guides/concepts)
- [Capacity](https://better-compute.com/docs/guides/capacity): pools, reservations, quotas, fractional GPUs, gangs and
  spot
- [Nodes](https://better-compute.com/docs/guides/nodes), [bare metal](https://better-compute.com/docs/guides/bare-metal)
  and [VPS and sandboxes](https://better-compute.com/docs/guides/vps), including
  [platform-issued compute](https://better-compute.com/docs/guides/vps/providers#platform-issued-compute) from provider
  accounts to customer tenants
- [IAM](https://better-compute.com/docs/guides/iam): how better-compute uses Better IAM for identity, policy and billing
- [The daemon](https://better-compute.com/docs/daemon): `bcd`, its sessions, protocol and host configuration
- [Extending](https://better-compute.com/docs/extending): modules, drivers, providers, scheduler plugins and sinks
- [Operations](https://better-compute.com/docs/operations): configuration, database, deployment, PKI, observability
  and security
- [Reference](https://better-compute.com/docs/reference): the [API](https://better-compute.com/docs/reference/api),
  the [CLI](https://better-compute.com/docs/reference/cli), errors, events and metrics

## Status

Version 0.2.0 is an early release; APIs and the daemon protocol may still change before 1.0.

- **Runs today:** the whole control plane (API, workers, gateway, CLI, MCP tools) runs from Node.js on PGlite or
  PostgreSQL. CI covers Node.js 22 and 24 on Ubuntu and Windows, and PostgreSQL 17.
- **The daemon, `bcd`:** the Go node agent is built and tested against simulated and fake hardware, including end to
  end against a real gateway, but it is not released as a binary yet. Build it from [`daemon/`](daemon) with Go, or use
  the simulated machines of `better-compute dev --sim`.
- **Hardware:** nothing has run on real GPU hardware or on a real TPM yet. GPU, MIG, NVLink and TPM attestation paths
  are tested against captured output and fakes only.
- **Better IAM** (`better-iam` on npm) is required for identity and authorization.

The [roadmap](https://better-compute.com/docs/reference/roadmap) lists what each phase delivered and what is open.

## How it fits together

- **`bcd`** is one Go binary. Mode `node` runs on every machine (session, inventory, GPU health, CDI device holds,
  commands), `site` runs per datacenter (proxy DHCP, iPXE, image cache, BMC access) and `ramdisk` runs during PXE
  commissioning. It only ever dials out.
- **The control plane** is `betterCompute(options)`, embedded in your Node.js service. It returns
  `{ api, handler, nodeHandler, initialize, start, … }` and runs as `api`, `gateway`, `worker` or all three. Postgres
  is the truth: bookings are guarded by `EXCLUDE` constraints, and all SQL reads one clock, `compute_now()`.
- **The API** is `POST /api/compute/{group}/{method}`, with a typed client inferred from the server, a CLI and MCP
  tools. Every mutation makes one Better IAM decision; fleet paths (heartbeats, inventory, commands) never call IAM.

```
SDK · CLI · MCP ──► api (authn/z, admission, placement) ──► Postgres ◄── worker (controllers, sinks)
                                                               ▲
bcd node · bcd site · bcd ramdisk ──── gRPC over mTLS, outbound 443 ──── gateway (sessions, dispatch)
```

## Packages

The umbrella `better-compute` exposes the packages marked with a subpath; each is also published on its own as
`@better-compute/<name>`. The server never imports the injected modules (`provision`, `metal`, `vps`): your
application passes them in.

| Package                                 | Umbrella subpath                      | What it does                                                                                          |
| --------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `better-compute`                        | `better-compute`                      | The umbrella: `betterCompute`, `defineConfig`, `ComputeError`, the `define*` helpers, and the CLI bin |
| `@better-compute/core`                  | `/core`                               | Browser-safe contracts: ids, errors, domain types, state tables, extension contracts, the IAM catalog |
| `@better-compute/server`                | `/server`                             | The control plane: `betterCompute()`, the operation envelope, router, controllers and worker runtime  |
| `@better-compute/postgres`              | `/postgres`, `/pglite`                | PostgreSQL (PgBouncer-safe) and PGlite stores, migrations, `compute_now()`, store conformance         |
| `@better-compute/capacity`              | `/capacity`                           | Pools, reservations, quotas, rollups and placement: fractional GPUs, gangs, calendar and spot         |
| `@better-compute/inventory`             | `/inventory`                          | Hardware inventory: section hashing and diffs, GPU model mapping, labels and health conditions        |
| `@better-compute/provision`             | `/provision`                          | The workflow engine, steps and profiles, images, and host configuration for nodes                     |
| `@better-compute/metal`                 | `/metal`                              | Bare-metal lifecycle: power, BMC management, PXE boot, deploy and inspect drivers; `metal()`          |
| `@better-compute/vps`                   | `/vps`                                | VPS instances, sandboxes, flavors, templates, snapshots, providers, attach, tenant networks; `vps()`  |
| `@better-compute/iam`                   | `/iam`, `/iam/plugin`, `/iam/testing` | The Better IAM bridge: IamPort, catalog and plugin, authz projection, inbox, usage and flags          |
| `@better-compute/gateway`               | `/gateway`                            | Daemon sessions over gRPC on HTTP/2 mTLS, liveness, command dispatch and join forwarding              |
| `@better-compute/pki`                   | `/pki`                                | Machine PKI: local CAs, SPIFFE node certificates, sealed join tokens, attestors, signed checkpoints   |
| `@better-compute/protocol`              | `/protocol`                           | Generated daemon ↔ control-plane wire types (`bettercompute.agent.v1` and friends)                   |
| `@better-compute/events`                | `/events`                             | Signed webhooks with retries and dead letters, and the server-sent `/watch` stream                    |
| `@better-compute/fleet`                 | `/fleet`                              | FleetConfig as code: export, plan and apply sites, pools, offers, quotas, flavors and accounts        |
| `@better-compute/rollout`               | `/rollout`                            | Signed `bcd` releases and wave rollouts with A/B self-update, within disruption budgets               |
| `@better-compute/audit`                 | `/audit`                              | Tamper-evident audit: signed per-tenant Merkle checkpoints and inclusion proofs                       |
| `@better-compute/observability`         | `/observability`                      | A bounded Prometheus registry and the standard `better_compute_*` metrics                             |
| `@better-compute/client`                | `/client`                             | `createComputeClient`, the typed, browser-safe API client                                             |
| `@better-compute/cli`                   | `/cli`                                | The `better-compute` command line: `dev`, `serve`, `migrate`, `doctor`, `reserve`, `pki`, `api`, …    |
| `@better-compute/mcp`                   | `/mcp`                                | Model Context Protocol tools for AI agents, gated by Better IAM                                       |
| `@better-compute/testing`               | `/testing`                            | Fixtures, the `FakeDaemon`, the fleet simulator, a sim clock and conformance runners                  |
| `@better-compute/provider-hetzner`      | —                                     | Hetzner Cloud servers as VPS instances and offers, and Hetzner Robot bootstrap                        |
| `@better-compute/provider-proxmox`      | —                                     | Proxmox VE QEMU VMs cloned from templates as VPS instances                                            |
| `@better-compute/provider-gcp`          | —                                     | Google Compute Engine VMs as VPS instances: discovery, attach, reservations, VPCs and firewalls       |
| `@better-compute/provider-digitalocean` | —                                     | DigitalOcean Droplets as VPS instances: discovery, attach, VPCs and firewalls                         |
| `@better-compute/provider-kubernetes`   | —                                     | Manifests that run `bcd` as a DaemonSet to adopt a Kubernetes cluster's nodes and GPUs into a pool    |
| `@better-compute/driver-sdk`            | —                                     | bcx, the out-of-process driver protocol (draft): `serveDriver` and `externalDriver` over mTLS gRPC    |
| `@better-compute/console-kit`           | —                                     | Framework-free view models for consoles over the typed client, with optional React bindings           |

`bcd` is not an npm package; it will ship as release binaries.

## Develop

Building from a clone needs pnpm 11.19.0 (pinned in `packageManager`; pnpm 12 refuses this workspace) and, for the
daemon, Go:

```sh
git clone https://github.com/better-compute/better-compute.git
cd better-compute
npx pnpm@11.19.0 install
node node_modules/pnpm/bin/pnpm.mjs build   # tsc -b
node node_modules/pnpm/bin/pnpm.mjs check   # typecheck, tests, repository rules, package validation
```

Tests run against source on PGlite and an embedded Better IAM, so no database server is needed; Postgres-only suites
run when `BETTER_COMPUTE_POSTGRES_URL` is set (`pnpm test:postgres`). Inside `daemon/`,
`go test -tags nonvml,fakehw ./...` runs the daemon's logic without GPUs. [docs/development.md](docs/development.md)
covers the scripts and the repository rules CI enforces, and
[local development](https://better-compute.com/docs/operations/local-development) covers the dev server and simulator.

## Releasing

Releases publish an explicit allowlist of packages with `node scripts/release-publish.mjs` (`--dry-run` first), never
`pnpm publish -r`; `aws-core` and `provider-digitalocean` are not released yet. [RELEASING.md](RELEASING.md) is the
checklist.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for the build and test commands, the commit style
and the sign-off, and follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Security

Please report vulnerabilities privately through
[GitHub Security Advisories](https://github.com/better-compute/better-compute/security/advisories/new), not in public
issues. [SECURITY.md](SECURITY.md) describes supported versions, scope and what to expect.

## License

[Apache License 2.0](LICENSE), including the Go daemon. See [NOTICE](NOTICE).
