# Examples

Each example is a private workspace package with a `better-compute.config.ts`. They all run the same deployment, [`shared/compose.ts`](shared/compose.ts): every module (provision + metal, vps, events, fleet, and rollout and audit when their keys exist) and a `host` export with server-sent events at `GET /watch`, Prometheus metrics at `GET /metrics` and the gateway role when its certificate exists.

| Example                          | What it shows                                                                                             | Runs here?                                          |
| -------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| [`dev`](dev)                     | `better-compute dev --sim 8`: simulated GPU machines join, get adopted, and serve reservations, on PGlite | yes, Node.js 22.18+ only                            |
| [`postgres`](postgres)           | api, worker and gateway processes on PostgreSQL, from one configuration                                   | needs PostgreSQL 16+ (Docker Compose file included) |
| [`emulated-site`](emulated-site) | bare metal: QEMU/KVM machines with Redfish BMCs (sushy-tools), PXE through a `bcd site` agent             | requires Linux + KVM                                |

`tests/examples-smoke.test.ts` checks that each configuration loads, migrates and passes `better-compute doctor`, and that `dev --sim` adopts machines and serves `/watch`.

The configurations are TypeScript: run them with Node.js 22.18 or later, which strips types by default.
