# @better-compute/gateway

The better-compute gateway (PLAN.md §7, §8.1, §8.5). Every `bcd` daemon holds one long-lived gRPC
`Session` stream to a gateway over HTTP/2 mTLS. The gateway runs liveness and dispatch, ingests
results and events, and forwards `Join`, `Renew` and `SecretRequest` to the api. It holds no CA and
no signing key (P14). It depends on `@better-compute/core`, `protocol`, `inventory`, `pki` and
`server` (types only).

**Status: v0.1.**

```ts
import { certificateAuthenticate, createGateway, serveGateway } from '@better-compute/gateway';

const gateway = createGateway({
  region: 'eu-1',
  database, // the compute store (postgres() / pglite())
  services: compute.gatewayServices, // JoinService, renewal, secret broker
  work, events, // the server runtime's WorkQueue / EventPublisher (SQL defaults otherwise)
  revocations, // pki RevocationSet: refused at open, pushed to live sessions
  reports: { allocationBound: (tx, c, r) => markAllocationBound(tx, c.work, r.allocationId, r) },
});
await gateway.start(); // directory row + `gateway:<id>` lease
await serveGateway(gateway, {
  port: 443,
  tls: { key, cert, ca: nodeCaPem },
  authenticate: certificateAuthenticate({ roots: [nodeCa.certificate], revocations }),
});
```

## What it does

| Area | Behaviour |
|---|---|
| Hello (§7.2) | One transaction bumps `node_sessions.session_epoch` and routes the node to this gateway. A new `boot_id` or role completes in-flight self-terminating commands (`succeeded`, `rebooted`). A new `journal_id` fails in-flight non-retry-safe ones (`journal-lost`). `unacked_results` are applied. The remaining in-flight commands are replayed in `seq` order, except those the journal reports running. Inventory hashes go to `@better-compute/inventory`, which chooses `Welcome.request_sections`. |
| Welcome | Epoch, credits (control 8, provision 4, bulk 2), cumulative event ack, server time, `upgrade_required` below the protocol minimum. A full `DesiredState` follows when the daemon is behind. |
| Dispatch (§8.5) | By join: `FOR UPDATE OF c SKIP LOCKED FOR SHARE OF s`, marked only when the row's epoch equals the live session's and the lane has credit. Per-lane order is preserved. Each run is fenced by the `gateway:<id>` lease. |
| Results | Accepted from any epoch and scoped to the reporting node. The core state table deduplicates them. The terminal `result` is stored and acked. `BUSY` → `pending` with 1 s → 30 s back-off. |
| Events (§7.4) | Deduplicated by the cumulative ack of the current journal. Published to the outbox, with attested reports decoded. A report about another node is `security.node-mismatch` and never reaches a handler. Report handlers run under a SAVEPOINT, so a failing one cannot poison the stream. |
| Liveness (§7.5) | Kept in memory and flushed every 15 s as ages, not timestamps, fenced by epoch. A stale epoch means a zombie stream, which is dropped (`ABORTED`). Three missed heartbeats close a session. So does an expired certificate. |
| Fencing (§7.8) | The lease renews every 5 s (TTL 20 s). If it's lost, or renewals fail for TTL/2, every stream is dropped. |
| Admission | Handshake token bucket (200/s), `maxStreams`, drain (`Drain{rand(0, 60 s)}`), revocation push (`RevocationNotice`, then `UNAUTHENTICATED`). |
| Tenant-controlled (§13) | A `node-tenant` certificate gets no secrets, and destructive kinds are cancelled `tenant-controlled`. |

## Transport

`serveGateway` implements gRPC directly on `node:http2`, without a framework:
- `application/grpc[+proto]` content types and length-prefixed messages;
- `grpc-status`, and percent-encoded `grpc-message`, in trailers;
- trailers-only responses for immediate errors;
- `grpc-timeout` is tolerated;
- no compression;
- HTTP/2 PING every 20 s.

`Join` accepts clients without a certificate. `Renew` and `Session` require one that `authenticate` accepts, and the node id always comes from the certificate's SPIFFE SAN. `Tunnel` answers `UNIMPLEMENTED` until v0.3. `insecure: true` serves h2c for tests only.

Tests drive the core without a transport (`gateway.open(peer, sink)` plus `gateway.jobs.*.tick()` with `manual: true`).
`tests/gateway-*.test.ts` covers the core on PGlite with the sim clock, the transport over h2c with a real HTTP/2
client, and mTLS with pki-issued certificates.
