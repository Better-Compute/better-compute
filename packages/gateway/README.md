# @better-compute/gateway

The better-compute gateway: it holds each `bcd` node daemon's long-lived gRPC session over HTTP/2 mTLS, tracks liveness, dispatches commands and ingests results and events.

## Install

```sh
npm install @better-compute/gateway
```

It is also included in the umbrella package as `better-compute/gateway`:

```sh
npm install better-compute
```

## Usage

```ts
import { createGateway, serveGateway, xidStatusHandler } from '@better-compute/gateway';

const gateway = createGateway({
  region: 'eu-1',
  database, // the compute store (postgres() / pglite())
  services: compute.gatewayServices, // JoinService, renewal, secret broker
  work,
  events, // the server runtime's WorkQueue / EventPublisher (SQL defaults otherwise)
  revocations, // pki RevocationSet: refused at open, pushed to live sessions
  reports: { status: xidStatusHandler }, // plus allocation handlers from the host
});
await gateway.start(); // directory row + `gateway:<id>` lease
await serveGateway(gateway, {
  port: 443,
  tls: { key, cert, ca: nodeCaPem },
  nodeRoots: [nodeCa.certificate], // → certificateAuthenticate (required: no weaker default)
  revocations,
});
```

Every `bcd` daemon holds one long-lived gRPC `Session` stream to a gateway over HTTP/2 mTLS. The gateway runs liveness and dispatch, ingests results and events, and forwards `Join`, `Renew` and `SecretRequest` to the api. It holds no CA and no signing key. It depends on `@better-compute/core`, `protocol`, `inventory`, `pki` and `server` (types only).

The gateway runs today from Node against PGlite or PostgreSQL. `bcd`, the Go daemon on the other end, is built and tested against simulated and fake hardware but is not released as a binary yet, and nothing has run on real GPU hardware.

## What it does

| Area | Behaviour |
| --- | --- |
| Hello | One transaction bumps `node_sessions.session_epoch` and routes the node to this gateway. A new `boot_id` or role completes in-flight self-terminating commands (`succeeded`, `rebooted`). A new `journal_id` fails in-flight non-retry-safe ones (`journal-lost`). `unacked_results` are applied. The remaining in-flight commands are replayed in `seq` order, except those the journal reports running. Inventory hashes go to `@better-compute/inventory`, which chooses `Welcome.request_sections`. |
| Welcome | Epoch, credits (control 8, provision 4, bulk 2), cumulative event ack, server time, `upgrade_required` below the protocol minimum. A full `DesiredState` follows when the daemon is behind. |
| Dispatch | By join: `FOR UPDATE OF c SKIP LOCKED FOR SHARE OF s`, marked only when the row's epoch equals the live session's and the lane has credit. Per-lane order is preserved. Each run is fenced by the `gateway:<id>` lease. |
| Results | Accepted from any epoch and scoped to the reporting node. The core state table deduplicates them. The terminal `result` is stored and acked. `BUSY` → `pending` with 1 s → 30 s back-off. |
| Events | Deduplicated by the cumulative ack of the current journal. Published to the outbox, with attested reports decoded. A report about another node is `security.node-mismatch` and never reaches a handler. Report handlers run under a SAVEPOINT, so a failing one cannot poison the stream. |
| Liveness | Kept in memory and flushed every 15 s as ages, not timestamps, fenced by epoch. A stale epoch means a zombie stream, which is dropped (`ABORTED`). Three missed heartbeats close a session. So does an expired certificate. |
| Fencing | The lease renews every 5 s (TTL 20 s). If it's lost, or renewals fail for TTL/2, every stream is dropped. |
| Admission | Handshake token bucket (200/s), `maxStreams`, and `maxPendingHellos` (64). The last one refuses Hellos beyond it with `RESOURCE_EXHAUSTED` so a reconnect storm cannot starve the lease; see the [gateway-streams benchmark](https://github.com/better-compute/better-compute/tree/main/bench/gateway-streams). Also drain (`Drain{rand(0, 60 s)}`) and revocation push (`RevocationNotice`, then `UNAUTHENTICATED`). |
| Cancel | A pending command with `cancel_requested_at` is cancelled and never sent. An in-flight one gets `Cancel{id, reason}` once per session, and again after every reconnect, until the daemon settles it. A real outcome wins over a late cancel. |
| Body guard | A stored body that doesn't decode, lacks `not_after`, or names another command or node is cancelled `invalid-body` instead of sent (the protocol treats a missing `not_after` as `EXPIRED`). |
| Control API | `internalHandler` / `serveInternal` (internal-CA mTLS) / `gatewayControlClient` provide `health`, `poke {nodeIds?}`, `revoke` and `drain`. `gatewayNotifier` implements core `Notifier`: `publish('gw:<id>')` pokes that gateway through `gateways.internal_url`. Accelerators only: the loops converge without them. `gatewayTunnelRelay({ sql, tls })` is the server's `TunnelRelay` for `handleTunnel`. It opens the tunnel through the gateway named by `node_sessions.gateway_id`, with URLs cached 30 s; an unregistered gateway is `UNAVAILABLE`. |
| Tunnels | Exec tickets are verified by the gateway (signature, audience, jti) and again by the daemon. `OpenTunnel` goes out on the Session and the daemon opens a `Tunnel` stream. The relay has backpressure. Limits: 12 h, and 60 s re-authorization (the tunnel closes after 2 min of IAM failures). Revocation and `POST /v1/tunnels/close` also close tunnels. |
| WebSocket fallback | `GET /v1/session`, subprotocol `bc.agent.v1`, same framing. The daemon sends a proof JWT (`x5c` node chain, ±60 s, `jti`, nonce-bound); the gateway answers with `x-bc-gateway-proof` over the nonce, signed by its serving key. WebSocket sessions get signed commands and specs only. `attachGatewayWs`/`serveGatewayWs` serve it; `connectGatewayWs` is the daemon side. |
| Restricted certs | `node_certs.allowed_kinds` (read at Hello): other kinds are cancelled `kind-not-allowed`, including in-flight ones after a restricted re-join. |
| Status hooks | `reports.status: handler \| handler[]`, each under its own savepoint. `xidStatusHandler` routes XID conditions to inventory's `recordXid`, host pressure to `recordHostPressure`, and bcd's own conditions (`daemonNodeConditions`) to node conditions. FabricManagerDown, MPSDown, ForeignGpuExposure, PodResourcesUnavailable, KubernetesReleaseStuck and KubernetesReleasesUnreadable set NoSchedule while true (placement has no per-binding NoSchedule, so a node whose pod-resources API is unreachable takes no work at all); ForeignGpuExposure also wakes the node's started reservations. RebootRequired, KubernetesReleased, KubernetesTaintsDrift and HostManagedExternally are informational. They are written and published (`node.condition.changed`) only on a change, and are advisory on a tenant-controlled node. |
| Frame streams | `attachFrameConn(gateway, peer, conn)` serves a session over an in-memory frame stream (the testing kit's `FrameConn` shape), so the fleet simulator runs real FakeDaemons against a real gateway. |
| Tenant-controlled | A `node-tenant` certificate gets no secrets, and destructive kinds are cancelled `tenant-controlled`. |

## Transport

`serveGateway` implements gRPC directly on `node:http2`, without a framework:

- `application/grpc[+proto]` content types and length-prefixed messages;
- `grpc-status`, and percent-encoded `grpc-message`, in trailers;
- trailers-only responses for immediate errors;
- `grpc-timeout` is tolerated;
- no compression;
- HTTP/2 PING every 20 s.

`Join` accepts clients without a certificate. `Renew`, `Session` and `Tunnel` require one that the authenticator accepts, and the node id always comes from the certificate's SPIFFE SAN.

- Pass `nodeRoots` (plus `revocations` and `trustDomain`) to get `certificateAuthenticate`, or pass an explicit `authenticate`. Anything else is `INVALID_CONFIG`.
- The serial, role and expiry that `certificateAuthenticate` returns drive `allowed_kinds`, revocation and the Hello role check. `unsafeSanOnlyAuthenticate` skips all three and is for tests only.
- `insecure: true` serves h2c for tests only.
- `createGateway` warns at start when it has no `revocations` feed.

## Testing

Tests drive the core without a transport (`gateway.open(peer, sink)` plus `gateway.jobs.*.tick()` with `manual: true`). The repository's gateway tests cover the core on PGlite with the simulated clock, the transport over h2c with a real HTTP/2 client, and mTLS with pki-issued certificates.

## Documentation

- [Gateway](https://better-compute.com/docs/daemon/gateway)
- [Sessions](https://better-compute.com/docs/daemon/sessions)
- [Protocol](https://better-compute.com/docs/daemon/protocol)

## License

[Apache License 2.0](https://github.com/better-compute/better-compute/blob/main/LICENSE)
