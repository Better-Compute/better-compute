# @better-compute/server

The better-compute control plane: `betterCompute()`, the operation envelope every method runs
through, the method → action registry, the module host, the worker runtime, JoinService and the
HTTP transports. It never imports the store, the IAM bridge, the gateway or the injected modules
(`provision`, `metal`, `vps`); they arrive through options. The exceptions are the two always-on
built-in modules, `inventory` and `capacity`, and `@better-compute/pki` behind JoinService.

**Status: v0.1.** The bold rows of PLAN.md §9.2 are served: `system`, `projects`, `sites`,
`joinTokens`, `nodes`, `commands`, `usage`, `events` (the server's own), `inventory` and the
`pools`, `capacity`, `reservations` and `quotas` groups of the capacity module. See
[docs/api-reference.md](../../docs/api-reference.md).

```ts
import { betterCompute } from 'better-compute';
import { pkiJoinCrypto } from 'better-compute/server';
import { postgres } from 'better-compute/postgres';

const compute = betterCompute({
  database: postgres({ url: process.env.BETTER_COMPUTE_DATABASE_URL! }),
  secret: process.env.BETTER_COMPUTE_SECRET!, // at least 32 characters
  baseURL: 'https://compute.example.com',
  iam: bridge.embedded(iam, { rootTenantId }), // rootTenantId comes from the port (or pass it)
  modules: [...bridge.modules], // metal(), vps(), provisionModule() as they land
  plugins: [], // definePlugin(...) values, mounted under plugins/{id}
  pki: { join: pkiJoinCrypto({ trustDomain, nodeCa, signingKey, encryptionKey }) },
  notifier, // optional: gateway pokes (gatewayNotifier from the gateway package)
});
await compute.initialize(); // registry checks, migrations, module start()
app.all('/api/compute/*', (c) => compute.handler(c.req.raw)); // or createServer(compute.nodeHandler)
await compute.start(); // worker roles: controllers, sinks, iam
```

A gateway process consumes the api through dependency inversion:
`createGateway({ services: compute.gatewayServices, work: compute.context.work, events:
compute.context.events, reports: gatewayReportHandlers })`. The IAM bridge's inbox drops cached
authentications and decisions with `compute.caches.dropIdentity/dropSession/dropDecisions`.

`betterCompute()` is synchronous and side-effect free. It validates the options and registers
`system` and the server's groups, the built-in `node-controllers`, `inventory` and `capacity`
modules, then `modules` and `plugins`. Configuration errors throw `INVALID_CONFIG`:

- a duplicate module name or plugin id (a second `capacity` too), or a reserved name (`core`,
  `server`, `plugins`);
- a duplicate `group/method` route, or a malformed method definition (an `admission` only on
  mutations);
- a plugin action outside `compute:<plugin-id>:*`;
- a migration not named `<module>/<nnnn>_<slug>`;
- a duplicate extension `kind:id@version`, or a command kind registered twice (the protocol's
  built-in v0.1 kinds are the server's own), or an unmet `requires`;
- `rootTenantId` missing from both the options and `iam.rootTenantId`, or the two disagreeing.

## The envelope (PLAN.md §3.4, §9.2)

`compute.api.<group>.<method>(credential, input)` and HTTP take the same path:

1. **Public methods** skip authentication. `system.whoami` authenticates only when a credential
   came with the call.
2. **No credential:** `UNAUTHENTICATED` before any IAM call. Then the input is validated.
3. **Authenticate** with `IamPort.authenticate`, cached 30 s by sha256 of the credential.
4. **Tenant pre-check.** A caller outside the input's `tenantId` and the root tenant gets
   `ACCESS_DENIED`, identical to an IAM denial, before any database access or decision.
   Fleet-scoped methods (`compute-fleet/global`) are decided in the root tenant.
5. **Admission** (methods with `admission`: request-as-resource creates, `extend`): transaction 1
   runs `prepare` (idempotency lookup scoped to tenant + identity, draft and projection rows); a
   replay returns the stored result without a decision; otherwise one `require` on the resource
   `prepare` returned, after `IamPort.refreshResource` reloaded that row into the IAM resolver's
   memory (§12.4: never a stale copy; `extend` decides on the pending total). A refusal of a
   delegated session asks IAM for a confirmation:
   `CONFIRMATION_REQUIRED` (403, `details.confirmationId`) when the delegation holds the action
   back, `ACCESS_DENIED` otherwise (fail closed); `denied` runs with that error.
6. **Other methods:** one decision, `require` for mutations (never cached), `authorize` for reads
   (allows cached 10 s per session).
7. **The handler** runs in one transaction, read-only for reads. An allowed mutation also writes
   an `audit_events` row with its admission context in that transaction.
8. **Lists** (§9.2 "+ items"): the server's own run outside a wrapping transaction
   (`defineListMethod`); a module's list method runs in a read-only transaction and the envelope
   then decides the page's items with `authorizeMany` (≤ 50 per call, never inside a compute
   transaction). A failed batch fails the request; a resolver `NOT_FOUND` retries the page once.
   Owner-scoped kinds listing the caller's own (`scope` absent or `mine`) keep the SQL filter.
9. **Composite mutations** (`transaction: 'manual'`, e.g. `fleet.apply`; mutations without an
   `admission` only): after their own decision the handler runs with no transaction open.
   `ctx.check(path, input)` (outside any transaction, else `INVALID_STATE`) decides another
   method's call for the same caller as steps 4-6 would: tenant pre-check, validation, one
   decision. A replay-only admission runs `prepare` in a short transaction of its own (`decide`:
   one `require`; `replay`: allowed). Admissions with a `denied` hook, list-recipe reads and other
   composites are `UNSUPPORTED`. `ctx.invoke(tx, path, input)` then runs an allowed call inside
   `tx`, under a savepoint, with its own audit row and no IAM call. Calls match by path plus
   canonical JSON of the raw input, one `invoke` per `check` (else `ACCESS_DENIED`), and grants
   end with the call. The composite's own audit row is written after the handler succeeds.
   Every other method's `ctx.check`/`ctx.invoke` refuse with `INVALID_STATE`.

## HTTP (PLAN.md §9.1)

- `POST {basePath}/{group}/{method}` and `POST {basePath}/plugins/{id}/{group}/{method}`. The
  default `basePath` is `/api/compute`.
- Requests need `content-type: application/json` and `X-Better-Compute: 1`, else
  `CSRF_REJECTED`. The body must be a JSON object of at most 64 KiB (`PAYLOAD_TOO_LARGE`).
- The IAM cookie is ignored unless `acceptIamCookie` is set. Even then a cookie request needs an
  `Origin` exactly equal to `baseURL`'s origin: a missing one is `CSRF_REJECTED`, another one
  `UNTRUSTED_ORIGIN`.
- Answers are `{ data }` or `{ error: { code, message, retryAfterMs?, details? } }` with the
  error's status. `RATE_LIMITED` adds `Retry-After`. Unexpected errors, including
  `INTERNAL_ERROR`, answer `500 Internal server error` and go to `log.error`.
- `X-Request-Id` is echoed when it matches `^[A-Za-z0-9._:-]{1,128}$`; otherwise the server
  assigns one. IAM sees the same id.
- A valid W3C `traceparent` (version `00`, non-zero ids) becomes `ctx.traceparent`, and the
  commands the method enqueues carry it (`CommandBody.traceparent`) unless they set their own;
  an invalid one is dropped.
- `GET` serves only `{basePath}/health` (one store round trip; `503` when it fails),
  `{basePath}/.well-known/better-compute` (version, base path, agent protocol range) and, with
  `downloads: { dir?, blob? }`, `{basePath}/downloads/bcd/{version}/linux-{amd64|arm64}`:
  goreleaser's bare binary `bcd_{version}_{os}_{arch}` from the blob store (key
  `bcd/{version}/{file}`) or the directory, public and immutable-cached (the install script
  checks the verified manifest's sha256). Other methods answer `METHOD_NOT_ALLOWED`. Unknown
  routes answer `NOT_FOUND`.
- When `pki.join` offers `publicKeys()` (`pkiJoinCrypto` does when its signing key carries its
  certificate), the well-known document adds a `join` section: `encryptionJwk` (public members
  only), `encryptionKeyPin`, `signingCertificate` (base64 DER) and `signingKeyPin` (`sha256/`
  SPKI pins). It is the join-key fallback of PLAN.md §6 Install: a daemon uses the keys only
  when they match its pins. The keys are read once; a failing or malformed answer omits `join`
  and is retried a minute later. `wellKnownJoinKeys()` builds the same section for hosts that
  serve their own document.

## Registry, initialize and selfCheck

- **`compute.registry`** holds the modules, plugins, routable methods (each with its §9.2 row),
  the merged catalog actions, migrations, extensions and command kinds.
  - `registry.problems()` lists methods that are:
    - `uncatalogued`: the action is missing from the merged catalog;
    - `mismatch`: the method disagrees with its §9.2 row on action, kind or resource;
    - `undeclared`: a non-plugin method outside §9.2.
- **`initialize()`** fails with `INVALID_CONFIG` on `uncatalogued` or `mismatch` problems,
  before touching the store. It then migrates, anchors the default clock and awaits each
  module's `start()`. It is idempotent, and a failed attempt can be retried.
  `scripts/authz-matrix.mjs` also fails on `undeclared` methods and generates one test per
  registered v0.1 row (`tests/generated/authz-matrix.test.ts`).
- **`selfCheck()`** (also `system.selfCheck`, `compute:fleet:admin`) only reads. It reports
  registry problems, unapplied migrations, a missing `btree_gist`, `compute_now()` differing from
  the database clock (`info` under the sim clock), ClockSkew, and every module's `selfCheck`.

## Worker runtime (`src/runtime/`)

- **Ports** (`compute.context`, every module context): `leases` (table leases with fencing
  epochs, §8.5), `work` (the coalescing work queue, §8.4; a key a reconciler re-enqueues with
  `notBefore` during its run is due then), `desired.invalidate` (enqueues `nodespec`), `commands`
  (seq from `nodes.next_cmd_seq`, idempotency per node, protobuf `CommandBody`; `cancel` sets
  `cancel_requested_at` on in-flight commands), `events` (outbox rows `{id, type, tenantId,
subject, data, time}`, topic = type), `authz` (`authz_projection` plus the `authz_changes`
  feed), `capacity` (the capacity module's quota + inline placer) and `inventory` (the latest
  snapshot). All write in the caller's transaction. New commands and new node specs poke
  `gw:<gatewayId>` with `{"nodeIds": [...]}` after commit (`options.notifier`, best effort).
- `work.enqueueMany` and `events.publishMany` are the set-based forms: one statement per batch
  (`INSERT … SELECT FROM unnest`), leaving exactly the rows the single calls would (a key named
  n times is inserted at `gen = n` or bumped by n; `seq` follows the event order). Every item is
  checked before anything is written. The CommandSweeper uses them.
- `afterCommit(hook)` runs best-effort side effects once the outermost transaction commits;
  `caches` is the envelope's cache object (`compute.caches`). Reconcilers also get `lease`
  (`shard:<n>` or `singleton:<name>`).
- **Clock**: without `options.clock`, business time is the process clock anchored to
  `compute_now()`, sampled at `initialize()` and at every lease renewal; a difference beyond 1 s
  logs ClockSkew and adds a `clock.skew` selfCheck warning.
- **`jobs`**: one deterministic pass per `tick()` (tests, simulator): each reconciler by name
  (claims from the `shard:<n>` leases this worker holds by rendezvous hashing over `workers`, or
  under `singleton:<name>` for `shardBy: 'none'`; DONE, SYNC_AGAIN after 1 s, failures back off
  1 s → 5 min; periodic keys due `every` after their last run; owned keys re-enqueued every
  5-10 min), `command-sweeper`, `outbox-dispatch` (event sinks, at least once),
  `event-subscribers` (`compute.events.subscribe`) and `iam:<name>` (`options.iamJobs`).
- **Sink cursors**: each event sink's position is saved in `outbox_cursors` (`sink:<id>`, stream
  `outbox`, forward only) after every delivered batch and reloaded whenever this process takes
  the outbox-dispatch lease, so a new holder resumes where the last one saved. Sink ids must be
  unique. Without the table (before `core/0009_runtime`) cursors stay in memory.
- **Sinks from modules**: event sinks and scheduler plugins a module or plugin lists in
  `extensions` run like `sinks.events` and `scheduler.plugins`.
- **Audit sinks** (`sinks.audit`, and `AuditSink`s in module `extensions`): the built-in
  `audit-sinks` module (registered only when there are some) ticks every 5 s and gives each sink
  the committed `audit_events` after its own cursor (`audit_sink_cursors`, module migration
  `audit-sinks/0001_cursors`), in commit order, at least once, with per-sink back-off.
- **Usage sinks** are refused (`INVALID_CONFIG`): usage windows go to IAM billing through the
  IAM bridge's flush (§12.7), which owns `usage_windows.recorded_at`.
- **`start({ roles })`** runs the same passes on timers: `controllers` (reconcilers, sweeper),
  `sinks` (outbox dispatch), `iam` (IAM jobs); `stop()` releases every lease and leaves `workers`.

## Node controllers and JoinService (`src/controllers/`, `src/join/`)

- **JoinService** (`gatewayServices.join`/`renew`, keys from `pki.join`): opens the sealed join
  token, runs the attestor chain (`join-token`, plus `options.attestors`), enforces `expect` and
  the reclaim rules on inventory's `hardware_key`, enrolls the node (`adopting`, session epoch 0,
  its authz row), signs a 24 h SPIFFE certificate and the `JoinResponse`. Renew checks the
  presented certificate against `node_certs` and the proof of possession (±60 s, replay cache).
- **`node`**: NodeLifecycle runs the pool's acceptance checks (`diag.nvml`) once the node is
  connected; on pass the node is `adopted` and NodeSpec writes generation 1; on failure it keeps
  `AcceptanceFailed` until `nodes.adopt` asks again. Then the event side of Liveness and the
  node's authz row.
- **`nodespec`**: modules' `nodeSpec()` contributions as the wire `NodeSpec`; the generation moves
  only when the spec changes.
- **`drain`**: after `nodes.drain`, waits until the node holds no live allocation (v0.1 releases
  nothing itself), then ends the drain (`node.drained`; the node stays cordoned).
- **`liveness`** (every 5 s): connected → disconnected on a lapsed gateway lease, → unreachable
  after 40 s (+120 s after a gateway loss, 5 min after an outage), → lost only for provider and
  vps-host pools with `lostAfter` (never metal). Nothing is released (P6).
- The node reconciler runs lifecycle, liveness, the node's authz row and the schedulable-edge
  wake-up in one transaction per pass.
- **Gateway reports** (`gatewayReportHandlers`): a node reports only its own allocations. With
  `pki.commandSigning`, capacity's `attestedBindings` defaults to `pkiAllocationBindingCheck()`:
  a reservation goes active only on the node's own signed `AllocationBound` for exactly that
  allocation (P14); the signed CDI devices are the ones that count.

## Not yet

- Reconciler back-off counts live in memory (`work_queue.attempts` is not used yet).
- The server itself prunes nothing: `@better-compute/postgres`'s `retentionModule()` (which the
  CLI adds to every deployment) prunes the outbox behind the stored cursors; in-process
  subscribers and SSE watch keep no stored cursor and rely on retention's minimum age.
- `logs.collect` has no upload destination until the downloads BlobStore presigns one.
