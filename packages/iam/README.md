# @better-compute/iam

The Better IAM bridge for better-compute: the IAM plugin and catalog, the event inbox, the authorization projection and resolver, the `IamPort` implementations, usage recording and the flag cache.

## Install

```sh
npm install @better-compute/iam better-iam
```

It is also included in the umbrella package as `better-compute/iam`, `better-compute/iam/plugin` and `better-compute/iam/testing`:

```sh
npm install better-compute better-iam
```

[Better IAM](https://github.com/Better-IAM/better-iam) (`npm install better-iam`, >=0.2.0 <0.4.0) is required: it is compute's only identity provider, policy decision point and billing ledger. It provides the `@better-iam/*` peers this package uses. `@better-iam/core` is a required peer. `@better-iam/server` (embedded mode and IAM hosts), `@better-iam/client` (remote mode) and `@better-iam/adapter-sqlite` (the `./testing` kit) are optional peers.

## Usage

```ts
import { betterIam } from '@better-iam/server';
import { betterCompute } from 'better-compute';
import { createComputeIamBridge } from '@better-compute/iam';
import { metal } from '@better-compute/metal';

const bridge = createComputeIamBridge({ modules: [metal()] });
const iam = betterIam({
  database: iamDb,
  secret,
  baseURL,
  plugins: [bridge.plugin()], // catalog + afterAudit → iam_inbox
  resolveResource: bridge.resolveResource(), // memory-resident projection
});
const compute = betterCompute({
  database,
  secret,
  baseURL,
  modules: [metal(), ...bridge.modules],
  iam: bridge.embedded(iam, { rootTenantId }),
});
await compute.initialize(); // the iam module's start() loads the projection and binds the inbox
```

Until the projection is loaded, every compute decision is denied and inbox writes spill. `bridge.bind({ sql })` does the same as the module's `start()` for hosts that construct Better IAM outside compute.

## What the bridge holds

| Piece | What it does |
| --- | --- |
| `buildComputeCatalog` | Merges core's normative resource types (`compute-fleet`, `compute-pool`, …) with the catalogs of the modules and plugins in use, within Better IAM's limits. Plugins may only declare `compute:<id>:*` actions. |
| `computeIamPlugin` | The `IamPlugin` every IAM host on compute's IAM database installs: the catalog, plus an `afterAudit` that forwards the IAM events compute reacts to into compute's inbox. It **never throws**. A slow or failing inbox (2 s timeout) spills into a bounded buffer that is flushed after the next successful write. |
| `sqlInbox`, `memoryInbox` | Inbox writers that dedupe on the audit event id (`iam_inbox`, `ON CONFLICT DO NOTHING`). |
| `createAuthzProjection`, `sqlProjectionSource` | The memory-resident view of `authz_projection`. It loads at start and then tails `authz_changes` by `(txid, seq)`, reading only transactions older than the snapshot's xmin, so no commit is skipped. A miss does one primary-key read bounded to 20 ms. |
| `computeResolver` | Better IAM's `resolveResource`. It echoes the reference and adds the row's attributes, pending `extend` values, `ownerId` and the prefixed `parentType`/`parentId`. `compute-fleet/global` resolves only in the root tenant and `compute-tenant/{t}` only in `t`. A miss is `NOT_FOUND`. A timeout, or a projection that isn't loaded yet, denies. Other types go to the host's fallback. |
| `embeddedIam` | Core's `IamPort` over an in-process Better IAM: `authenticate` → `Caller`, `require`/`authorize`, `authorizeMany` in chunks of 50 (any error fails the list), delegated confirmation, `billing.check`, usage, cached flags. Better IAM errors become `ComputeError`s. |
| `recordUsageIsolated` | Usage with poison isolation. It bisects a failing `recordMany` batch down to the bad event. A deleted identity is re-attributed to its successor, or tenant-attributed with `attribution=orphaned`. What still fails is dead-lettered. Transient errors are rethrown untouched. |
| `createFlagCache` | One `features.isEnabled` per `(tenant, key)`, invalidated by `feature:*` events. The 5 min TTL is only a backstop. |
| `drainIamInbox`, `reconcileIamIdentities`, `flushUsageWindows` | The `iam` module's worker jobs: IamInbox (per tenant, in `sequence` order, level-triggered), IamReconcile (re-reads the owners of live reservations) and the hourly usage sink. |
| `iamJobs`, `iamJobReconcilers` | Better IAM's scheduler jobs, run as singleton periodic reconcilers under worker role `iam`: audit hooks every 1 s, auth outbox every 5 s, budget checks hourly, the retention sweep hourly and the period close daily. Enable them with `bridge.embedded(iam, { runIamJobs: true })` when compute's processes are the only IAM hosts. |
| `computeMeters`, `setupIamMeters`, `examplePolicies` | `better-compute iam setup` as data: the root meters (`gpu.<model>.hours`, `node.metal.hours`, `vps.vcpu.hours`, `vps.memory.gib.hours`), created idempotently, and the example `gpu-user` and `agent-guardrails` policies for org admins to apply. |
| `checkIamHost` | Per-host doctor checks: the catalog is installed, the resolver answers `compute-fleet/global`, and `sts.jwt` is configured when compute takes session JWTs. |
| `createComputeIamBridge` | Wires all of the above for embedded mode, including the `iam` module (migration `iam/0001_successors`; reconcilers `iam.inbox`, `iam.reconcile` and `iam.usage`). |

`@better-compute/iam/plugin` exports only what an IAM host installs: the catalog, the plugin, the inbox writers and `computeIamHost`.

## Remote mode

When the IAM deployment is one compute does not run, every `betterIam()` process on that IAM database installs `computeIamHost`:

```ts
import { computeIamHost, postgresInbox, replicaProjection } from '@better-compute/iam/plugin';
import { postgres } from '@better-compute/postgres';

const host = computeIamHost({
  projection: replicaProjection({ sql: postgres({ url: COMPUTE_READ_REPLICA_URL }) }), // read-only role
  inbox: postgresInbox({ sql: postgres({ url: IAM_DATABASE_URL }) }), // compute_inbox; the role needs CREATE
  rootTenantId,
});
const iam = betterIam({ ..., plugins: [host.plugin], resolveResource: host.resolveResource });
await iam.initialize(); // host.plugin.migrate creates compute_inbox
await host.start(); // loads the projection; until then compute decisions on this host deny
```

Compute then uses `bridge.remote({ baseURL, serviceToken, rootTenantId, iamDatabase })` as its IamPort. It forwards each caller's credential to Better IAM's HTTP API (`sts.getCallerIdentity`, `authorize`, `authorizeMany`, delegated confirmation). It uses the root service account for usage (`billing.recordMany`, ≤100 per call, with the same poison isolation) and for flags (`features.evaluate`). With `iamDatabase`, the iam module's `iam.pull` reconciler moves `compute_inbox` rows into `iam_inbox` every second. Instead of `postgresInbox`, an IAM host can use `httpInbox({ url, secret })`, which posts HMAC-signed batches that `createInboxHandler({ secret, inbox })` verifies on compute's side.

When compute cannot reach the IAM database (so no `postgresInbox` pull), the IAM root subscribes compute to a subtree webhook: `webhooks.create({ scope: 'subtree', events: [...computeIamEventPatterns], outcomes: ['allow'], url })`. Compute mounts `createIamWebhookHandler({ secret, inbox: sqlInbox(sql) })`, which verifies `X-Better-IAM-Signature` and writes the events compute reacts to into `iam_inbox`. The inbox dedupes redeliveries on the audit event id.

Admissions in remote mode need the admission refresh. Without it, the IAM host can decide on a row older than the one compute's first admission transaction just committed (a draft, or `extend`'s pending total), because its replica projection trails by the replication lag plus the 1 s tail. The IAM host mounts `host.refreshHandler({ secret, sql: replicaSql })` (for example at `POST /compute/refresh`). Compute passes `bridge.remote({ ..., refresh: { url, secret } })`. Before each admission's `require`, the port posts a signed `{ tenantId, type, id, lsn }`. The handler waits (≤ 2 s) until the replica has replayed compute's WAL position (`pg_last_wal_replay_lsn()`), then re-reads the row. A failure fails the admission with `UNAVAILABLE`. Use a secret distinct from the inbox's. In the projection, a row read fresh (a refresh or a miss) is never overwritten by a tail page that started reading before it: the page re-reads that row instead.

In remote mode `billingCheck(input, credential)` runs as the caller, because HTTP `billing.check` checks the credential's own spend in its own tenant. The envelope passes the caller's credential for `budgetCheck: 'meter'` pools.

## Testing kit

`@better-compute/iam/testing` is for tests only. `createEmbeddedTestIam({ sql?, inbox?, sessionJwts?, runIamJobs? })` starts a real Better IAM on in-memory SQLite. It carries compute's plugin, resolver and inbox, and it is bootstrapped with a root administrator (TOTP MFA) and two active organizations (`acme`, `other`). Each organization has an owner credential and `member`, `signIn`, `policy`, `grant` and `share` helpers, and the kit returns the embedded `port`. It needs `@better-iam/server` and `@better-iam/adapter-sqlite`. `spyIamPort(port)` records every IAM call, attributed to the code path that made it (`spy.path('heartbeat', fn)`), for the "zero IAM calls on fleet paths" check.

## Re-deciding for a session (tunnels)

Long-lived streams re-check their caller every 60 s, but a WebSocket client can't send its credential again. `IamPort.authorizeSession({ identityId, sessionId }, decision)` re-decides for the session that the stream recorded.

- **Embedded:** `bridge.embedded(iam, { sessionReviewer })`.
- **Remote:** `bridge.remote({ ..., authorizeSessions: true })` makes the same calls over HTTP with the service token.

Either way, it uses only Better IAM's public administrator API with compute's service account, which needs `iam:identities:read` and `iam:policies:simulate`:

1. `identities.listSessions`: revoked and expired sessions are gone.
2. `identities.get`: the identity must be active.
3. `policies.simulate`: MFA as the session had it.

Simulation is identity-level: it can't see what a delegation, an assumed role or an agent narrows. Such sessions answer false, so the stream closes and the client reopens it with a fresh credential.

`tunnels.authorize = tunnelAuthorizer(iamPort)` wires it for the tunnels module:

- With the upgrade request's credential, it makes the ordinary decision.
- Without one, it calls `authorizeSession` with the ticket's `sub` and `ses`.
- It re-decides the ticket's own action (`act`): `compute:instances:exec` on an instance, `compute:nodes:console` on a node.
- An unknown or mismatched action, or a ticket without a session or tenant, answers false.
- A port without `authorizeSession` throws `INVALID_CONFIG`.

## Suspended and deleted tenants

The server's `tenancy` module mirrors IAM tenant states. Its `tenantStateHandler(compute, { readTenants })` is the bridge's `tenant` handler (the host installs it by default). It makes no IAM call in the inbox transaction. The tenancy reconciler re-reads the tenant and its subtree through `readTenants` afterwards and applies what IAM says, retrying while IAM is down (plus a full re-read from the root every 15 min). A deletion, whose teardown can't be undone, therefore takes effect only once IAM confirms it. The envelope then refuses a suspended tenant's mutations and everything in a deleted one with `TENANT_SUSPENDED` (403); root callers are exempt. A deleted tenant is torn down through every module's `tenantDeleted` hook.

`iamTenantReader(iam, { credential })` is that `readTenants` for a Better IAM instance or client. It needs a root credential, since only root reads suspended and deleted tenants and every tenant's children. Better IAM writes a deletion into every descendant's own status, but a suspension only into decisions, so the reader gives each tenant its effective status: the worst of its own and its ancestors'. A tenant IAM answers "Tenant not found" for reads as `missing`. Any other 404 (a proxy, a wrong base path) is an error to retry. The tenancy module only lets `missing` confirm a tenant it already refuses, never start a teardown, and never suspends or deletes the root tenant, and a subtree larger than `maxTenants` (10 000) is refused rather than truncated.

## Documentation

- [IAM integration](https://better-compute.com/docs/guides/iam)
- [Actions and resources](https://better-compute.com/docs/guides/iam/actions-and-resources)
- [Tenancy](https://better-compute.com/docs/guides/iam/tenancy)

## License

[Apache License 2.0](https://github.com/better-compute/better-compute/blob/main/LICENSE)
