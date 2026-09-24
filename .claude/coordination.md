# Session coordination (better-compute)

Several Claude sessions and workflow agents may edit this tree at once. Rules:

- Claim an area below before editing; name exact files and symbols. Re-read shared files right before each edit and
  insert your own lines instead of rewriting blocks.
- Shared registries (root `tsconfig.json`, `vitest.config.ts`, `packages/better-compute/umbrella.json`,
  `pnpm-workspace.yaml`, root `package.json`) change by one-line inserts, and only by the session that owns the
  package being added. `pnpm-workspace.yaml` is generated: run `node scripts/sync-better-iam.mjs --write`.
- Never run `prettier --write .` on the whole tree; format only your own files. Announce full `vitest run`s.
- Do not run `pnpm install` or add dependencies while other agents are working; ask the orchestrating session.
- better-iam (`../better-iam`) is read-only unless the user approves an upstream item in chat (PLAN.md §12.12).
- The contracts frozen at the end of P0 (`proto/bettercompute/agent/v1`, `@better-compute/core`, the v0.1 schema,
  the v0.1 rows of PLAN.md §9.2) change only by additive, reviewed edits.

## Toolchain on this machine

- git is not on PATH; use GitHub Desktop's bundled git:
  `& "$env:LOCALAPPDATA\GitHubDesktop\app-3.6.5\resources\app\git\cmd\git.exe" <args>`.
- The global pnpm is 12.x and refuses workspaces pinned to `pnpm@11.19.0`. Run the pinned copy:
  `node node_modules/pnpm/bin/pnpm.mjs <args>` (scripts use `runPnpm` from `scripts/tooling.mjs`).
- Go is not installed yet (PLAN.md D1); `daemon/` is written but unbuilt until it is.
- Docker is not running; PGlite (PostgreSQL 18, `btree_gist` verified) is the local database. Postgres-only
  suites skip unless `BETTER_COMPUTE_POSTGRES_URL` is set.

## v0.1 allocation (set by the orchestrator, Better-compute architecture plan [56cfd7], 2026-09-24)

P0 is committed (3a70aa0, `pnpm check` green). v0.1 = PLAN.md §16 "Adopt & reserve". One owner per unit; message the
owner before touching their files. Ask [56cfd7] for anything marked "orchestrator".

| Unit | Owner | Files |
|---|---|---|
| W2a PKI | [9ec62d] | `packages/pki/**`, `tests/pki-*.test.ts` |
| W3a Capacity (§10.2-10.6, `InlinePlacer`, `capacityModule` groups pools/capacity/reservations/quotas) | [38c2f9] | `packages/capacity/**`, `tests/capacity-*.test.ts` |
| W3b Inventory + store (§10.1 hashing/diffs/labels/devices/conditions; ALL new postgres migrations `core/0003+`; store conformance + torture on Postgres) | [060790] | `packages/inventory/**`, `packages/postgres/**`, `tests/{inventory,postgres,pglite}-*.test.ts` |
| W2b Gateway (§7: gRPC `Session` over HTTP/2 mTLS, liveness batching, dispatch-by-join, resume rules, BUSY, forwarding Join/Renew/Secret to `GatewayServices`) | [17cfb9] (offered) | new `packages/gateway/**`, `tests/gateway-*.test.ts` |
| W4 IAM bridge (§12: plugin + inbox, projection + resolver, `embedded()` IamPort, usage sink, flag cache, IamReconcile) | [1f44fd] (offered) | new `packages/iam/**`, `tests/iam-bridge-*.test.ts` (`tests/iam-contract.test.ts` is the reference, read-only) |
| W5a Server runtime + envelope + API groups + JoinService (§3.3-3.4, §8, §9.2 v0.1 rows) and additive `core` contract changes | orchestrator [56cfd7] | `packages/server/**`, `packages/core/**`, `tests/{server,core}-*.test.ts` |
| W5b Testing kit: `FakeDaemon`, deterministic fleet-sim, real-time harness, `computeFixture` with embedded IAM | orchestrator [56cfd7] ([82e975] declined: it works on better-iam) | `packages/testing/**`, `tests/{testing,sim,realtime}*` |
| W5c CLI (`pki init/issue-gateway/show`, `daemon install-script`, `iam setup`, then `dev`, `serve` after W5a) | [9ec62d] (after PKI, committed 4fe85b7) | `packages/cli/**`, `tests/cli-*.test.ts` |
| W1 Go daemon | blocked: Go is not installed (user decision pending) | `daemon/**` |

Rules for v0.1:
- New packages: the owner adds its manifest, tsconfig, README, LICENSE copy, and one-line inserts in root
  `tsconfig.json`, `vitest.config.ts`, `packages/better-compute/umbrella.json` (then `node scripts/umbrella.mjs`).
- Dependencies, root `package.json`, `pnpm-workspace.yaml`, the lockfile and `pnpm install`: orchestrator only.
  Message [56cfd7] with the exact package@range you need.
- `@better-compute/core` changes are additive and go through the orchestrator (message the type/field you need).
- Schema columns go through [060790] (sole writer of `packages/postgres/src/migrations/`); module-owned tables use
  `ComputeModule.migrations` named `<module>/<nnnn>_<slug>`.
- Cross-unit seams, owned by W5a: `ModuleContext` runtime (leases, work queue, commands.enqueue, desired.bump,
  events.publish, clock), the admission hook for request-as-resource drafts (`MethodDefinition.admission`),
  `GatewayServices`, `IamPort`. Build against the types in `packages/core`; ask if something is missing.
- Commit only your own files (`git add <paths>`), small commits, message prefixed `v0.1 <unit>:`. Run
  `node node_modules/pnpm/bin/pnpm.mjs check` before committing and do not commit a red tree.
- Never commit `pnpm-lock.yaml` or the generated umbrella files (`packages/better-compute/{package.json,
  tsconfig.json,src/<subpath>.ts}`): they mix several owners' packages. The orchestrator commits them once every
  package they reference is committed. Your one-line `umbrella.json`/`tsconfig.json`/`vitest.config.ts` inserts are
  yours to commit with your package.
- SHARED INDEX RACE (hit 2026-09-24): all sessions share one `.git/index`, so `git add` then `git commit` can
  sweep another session's staged files into your commit (6a8bfca "W4 iam-lane gate bench" also carries all of
  W2b gateway). Commit through a private index instead:
  `$env:GIT_INDEX_FILE="$env:TEMP\idx-<you>"; git read-tree HEAD; git add <your paths>; git commit -F msg;
  Remove-Item Env:GIT_INDEX_FILE`, then ALWAYS `git reset -q -- <your paths>` on the shared index (orchestrator
  correction): after HEAD moves, the shared index still holds the OLD blobs for your paths, so a later plain
  `git commit` by anyone would silently revert your commit. Never run a bare `git commit` / `git commit -a` on the
  shared index; always use a private index. ENFORCED: `.git/hooks/pre-commit` (local, installed by [56cfd7]) refuses
  any commit whose `GIT_INDEX_FILE` is the shared `.git/index`. The orchestrator reset the shared index to HEAD after
  finding stale entries that would have reverted fffbb97/c0a25fc; if you had files staged there, re-stage them in
  your private index.

## Sessions

- (orchestrator, P0) Root workspace, scripts/tooling.mjs, scripts/sync-better-iam.mjs, vendor/better-iam,
  package manifests, vitest configs. P0 package work is fanned out by workflow; see the git log.
- (orchestrator [56cfd7], v0.1 W5a + W5b) core seams landed: 1b8df8f (`MethodDefinition.admission`, `AuthzWriter`,
  `WorkQueue`, `IamPort.rootTenantId`), bf42ee1 (`shardOf`/`SHARD_COUNT`, `ComputeModule.start/stop`,
  `Reconciler.periodic`). The W5a server runtime MUST: use core `shardOf` (gateway's copy is identical and will be
  removed), await module `start()` in `initialize()` after migrations (all modes) and `stop()` in reverse order, and
  schedule `Reconciler.periodic` keys as `work_queue` rows with `not_before = last run + every`; accept
  `createGateway({ work, events })` by passing the runtime's ports; outbox payload `{id, type, tenantId, subject, data,
  time}` with topic = type (gateway emits node.connected/disconnected/status/event, command.settled, security.*).
  W5b: transport-agnostic `FakeDaemon` + `FrameConn` + fleet-sim in `packages/testing/src/**` (workflow running).
- PKI API for W5a JoinService (committed 4fe85b7): `createNodeCa/createServingCa/createInternalCa`, `issueJoinToken`,
  `joinTokenAttestor()` (core AttestorVerifier; locks + decrements `join_tokens`), `openSealedToken(sealed, key,
  {csr})` (header binds sha256(csr)+iat), `createSigningKey`/`signJoinResponse`, `verifyRenewPop` +
  `createReplayCache`, `createRevocationSet`, `claimsFromWire`. hardware_key is NOT in pki: use inventory's
  `hardwareKeyFromClaims(claimsFromWire(req.claims))` ([060790]) so join and the inventory controller agree.
- IAM bridge seams for W5a (committed 7f69033): `bridge.modules[0]` (start/stop/reconcilers/selfCheck),
  `bridge.setHandlers({ identity, sessions, agent, binding, tenant, authz, budget, onError })` — `sessions` calls
  `compute.caches.dropIdentity(identityId)`; `bridge.embedded(iam, { rootTenantId })` is the IamPort. W5a owns
  `scripts/authz-matrix.mjs` → `tests/generated/authz-matrix.test.ts`; [1f44fd]'s IAM-side matrix is
  `tests/iam-bridge-matrix.test.ts`.
- [060790] 19fd9ba: `inventory.get` is real; `inventoryModule.reconcilers = [inventoryReconciler]` (kind `inventory`,
  shardBy node) — the W5a runtime must run module reconcilers. It also changed expectations in tests/server-http,
  server-operation, client, stubs-factories, testing-fixture, umbrella-subpaths (NOT_IMPLEMENTED cases now use
  `inventory.history`; `inventory.get` → 404 before a snapshot). The W5a integrator reconciles with its own edits.
  0003 added commands.attempt/result/updated_at, nodes adapter/drivers/power/failed_from/created_at, reservations
  lease_expires_at/conditions/created_at, pool_offers priority/allowed_regions/on_budget_exceeded,
  pools.provider_account_id, tables node_inventory + node_inventory_sections.
- Capacity for W5a (committed 7bff451, 91df2c4): server now depends on `@better-compute/capacity` and `pki`
  (orchestrator edited the manifest + tsconfig). Register `capacityModule(options?)` as the always-on built-in after
  `inventoryModule` (groups pools/capacity/reservations/quotas; migrations `capacity/0001_device_links`; reconcilers
  `capacity.reservations` (key = reservation id) and `capacity.rollup` (periodic 'all', 5m); `nodeSpec` →
  `{ devices: { assignments } }`). Back `ModuleContext.capacity` with `createCapacityPort({ clock }, options)`. Pass a
  seeded `random` in the sim. reservations.create's static `resource(input)` is `{type:'reservation', id:'draft:<key>'}`;
  the envelope decides on the resource returned by `admission.prepare`. Gateway calls
  `markAllocationBound(tx, ctx.work, allocationId, { cdiDevices, envFile })` on AllocationBound.
- Gateway report hooks for W5a ([17cfb9]): `createGateway({ reports: { allocationBound, allocationReleased,
  allocationFailed } })`, each `(tx, ctx, report)` with ctx `{nodeId, tenantId, journalId, seq, bootId, signed, work}`,
  run under a SAVEPOINT in the ingest tx. Wire `allocationBound: (tx, c, r) => markAllocationBound(tx, c.work,
  r.allocationId, { cdiDevices: r.cdiDevices, envFile: r.envFile })`. Also `certificateAuthenticate` (pki),
  `RevocationFeed`, tenant-controlled gating.
- JOIN KEY DISTRIBUTION (decided, PLAN §6 Install): install script writes `/etc/bcd/join-encryption.jwk` (public);
  bcd checks it against `join_encryption_key_pin`. Fallback: W5a's `/.well-known/better-compute` serves
  `joinEncryptionJwk` + the join signing certificate (from the PKI bundle: `loadPkiBundle`/`importPkiBundle` in
  @better-compute/cli returns `{ nodeCa, servingCa, internalCa, joinSigning, joinEncryption, revocations, trustDomain }`);
  bcd accepts them only if they match its pins. W1 implements both.
- DELEGATED CONFIRMATION in the W5a envelope (cae5ffc): server must not import `@better-compute/iam`. On
  ACCESS_DENIED for a method with `admission`, if `caller.sessionKind === 'delegated'`, call
  `ctx.iam.requestConfirmation(credential, { ...decision, reason: admission.describe?.(input) ?? <method summary> })`;
  a `{confirmationId, expiresAt}` → throw `CONFIRMATION_REQUIRED` (403, details `{confirmationId, expiresAt, action,
  resource}`); `'not-held-back'` or any error → `ACCESS_DENIED` (fail closed). Pass the thrown error to
  `admission.denied`. Capacity ([38c2f9]) keeps the draft `awaiting-confirmation` and handles retry/expiry.
- FakeDaemon/fleet-sim (W5b) join through pki's agent half: `startAgentJoin`, `finishAgentJoin`, `prepareAgentRenew`
  (bbd30ce; see tests/pki-flow.test.ts for the full round trip JoinService should mirror).
- Gateway control API (bb494de, accelerator only): wire `notifier: gatewayNotifier({ sql, tls })` (core Notifier)
  in hosts; after an enqueue / `desired.invalidate` commits, the runtime publishes `gw:<node_sessions.gateway_id>`
  (payload JSON `{nodeIds}`). `createGateway({ internalUrl })` = the URL the api dials. The server never imports the
  gateway; `gatewayControlClient` is for host wiring (tunnels, revoke).
- v0.2 crypto in pki ([9ec62d]: 9e02640, 604938f, d57f5fc) for the server to wire: `localSealedSecretStore({ sql,
  keys })` + module migration `sealedSecretsMigration` (pki/0001_sealed_secrets, add to the hosting module);
  broker `openSecretRequest`/`sealSecretResponse`/`refuseSecretRequest`; `createCommandSigningAuthority` +
  `signCommand`/`signDesiredState` (verify on daemon); `verifyAttestedUpdate`/`verifyAttestedReport` in workers.
  Next for [9ec62d]: v0.3 access crypto (exec tickets, SSH user-cert CA) in pki, then new `packages/mcp`.
- LOCK ORDER (all units, set by [38c2f9]'s capacity torture test): any transaction that locks several of these takes
  them in this order: `quota_usage` → `pools` → `nodes` → `devices` → `node_resources` → `pool_capacity_rollup`.
  Releases refund quota FIRST (as reserve charges it first). W5a node verbs (cordon/taint/drain/liveness) that also
  touch capacity rows must follow it.
- PITFALL (found by [1f44fd]): in cursor queries over `outbox`/`authz_changes`, never alias a cast column with its
  own name (`txid::text AS txid`): a bare `ORDER BY txid, seq` then sorts the TEXT alias ("1000" < "999", "10" < "2").
  Order by qualified columns (`ORDER BY o.txid, o.seq`) or alias as `txid_text`. Tests must page across a digit
  boundary.
- (Feature expansion [38c2f9], v0.1 W3 capacity core, 2026-09-24) new package `packages/capacity/**`
  (`@better-compute/capacity`: capacity math §10.2, selectors/filters/scorers + `InlinePlacer` §10.3, reservation
  booking/release/extend §10.5, rollups §10.6), new `tests/capacity-*.test.ts`. One-line inserts for `capacity` in root
  `tsconfig.json`, `vitest.config.ts`, `umbrella.json`. Not touching inventory, server, proto/, migrations, daemon,
  better-iam.
- (Feature expansion [38c2f9], v0.3 VPS control plane, 2026-09-24, offered by [56cfd7]) `packages/vps/**` (`vps()`:
  instances/flavors/providerAccounts groups, Instance reconciler for hosted + provider pools, IPAM, module
  migrations `vps/0001_*`), new `tests/vps-*.test.ts`; then new package `packages/provider-hetzner/**`. Adds
  `resizeAllocation` to `packages/capacity`. Dependency vps → capacity requested from [56cfd7].
- (Feature expansion [9ec62d], v0.1 W2 PKI, 2026-09-24) new package `packages/pki/**` (`@better-compute/pki`: DER/X.509
  writer, CSR parse+verify, local CAs, SPIFFE node certs, sealed join tokens, signed JoinResponse, Renew PoP), new
  `tests/pki-*.test.ts`. One-line inserts for `pki` in root `tsconfig.json`, `vitest.config.ts`, `umbrella.json`.
  Not touching gateway, server, proto/, migrations, daemon, better-iam.
- (Feature expansion [17cfb9], v0.1 W2b Gateway, 2026-09-24) accepts the offer. New package `packages/gateway/**`
  (`@better-compute/gateway`: session state machine over AgentFrame/ServerFrame, Hello tx with self-terminating +
  journal-lost rules, epoch fencing, age-based liveness batching, dispatch-by-join with the session-row lock, BUSY
  back-off, credits per lane, gateway lease, result/event ingestion with dedupe, Join/Renew/Secret forwarding to
  `GatewayServices`; HTTP/2 gRPC transport), new `tests/gateway-*.test.ts`. One-line inserts for `gateway` in root
  `tsconfig.json`, `vitest.config.ts`, `umbrella.json`. Dropped my earlier server-runtime claim (W5a owns it).
  Landed inside 6a8bfca (index race). Next: the §16 gateway gate bench, `tests/bench/gateway-streams.bench.ts` +
  `bench/gateway-streams/**`.
- (Feature expansion [060790], v0.1 W3b inventory + store, 2026-09-24) accepts. `packages/inventory/**` (section
  verification + snapshot digest, diffs, labels, devices/atoms from inventory, hardware_key, v0.1 conditions,
  Inventory/Health reconcile logic), `packages/postgres/**` (sole writer of `migrations/0003+`; send column requests
  to me), `tests/{inventory,postgres,pglite}-*.test.ts`. First migration `core/0003_v01_columns` takes the P0 gap list.
- (Feature expansion [1f44fd], v0.1 W4 IAM bridge, 2026-09-24) accepts. New package `packages/iam/**`
  (`@better-compute/iam` + `./plugin`: `createComputeIamBridge`, IamPlugin with never-throw `afterAudit` → `iam_inbox`
  spill, memory-resident authz projection + resolver, `embedded(iam)` IamPort, usage sink with poison isolation, flag
  cache, IamInbox/IamReconcile module), new `tests/iam-bridge-*.test.ts`. One-line inserts for `iam` in root
  `tsconfig.json`, `vitest.config.ts`, `umbrella.json`. Read-only: `tests/iam-contract.test.ts`, `tests/support/**`,
  core, server, postgres, better-iam. [1f44fd] full `pnpm check` run 2026-09-24 ~08:40 before the first W4 commit.
  Committed 7f69033 (bridge) and 036d3e1 (jobs/setup/doctor/matrix). For W5c `iam setup`/`doctor` ([9ec62d]): use
  `computeMeters(gpuModels)` + `setupIamMeters(iam.api, { credential, tenantId: root }, meters)`,
  `examplePolicies({ audience })` (print for org admins), `checkIamHost(host, { catalog: bridge.catalog, credential,
  rootTenantId, expectSessionJwts })` → `Finding[]`. For W5a: `bridge.modules[0]`, `bridge.setHandlers(...)`,
  `bridge.embedded(iam, { rootTenantId, runIamJobs: true })`. Also owns `tests/bench/iam-lane.bench.ts` and
  `bench/iam-lane/**` (the §16 IAM-lane gate; committed 6a8bfca; needs root devDep `@better-iam/adapter-postgres`).
- (Feature expansion [060790], v0.2 provision workflow engine, 2026-09-24, offered by [56cfd7]) `packages/provision/**`
  (workflow engine §11.2, profiles §11.4, `provisionModule()` with the Workflow reconciler, core `WorkflowEngine`,
  profiles/workflows API groups), `tests/provision-*.test.ts`, and the workflows/workflow_steps migration. Builds on
  core `ctx.commands/work/events/authz`; not touching server, core, metal, gateway.
