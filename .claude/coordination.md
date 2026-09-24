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
| W5c CLI (`dev`, `serve`, `iam setup`, `pki issue-gateway`, `daemon install-script`) | unassigned; starts after W5a lands `ModuleContext` runtime | `packages/cli/**`, `tests/cli-*.test.ts` |
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

## Sessions

- (orchestrator, P0) Root workspace, scripts/tooling.mjs, scripts/sync-better-iam.mjs, vendor/better-iam,
  package manifests, vitest configs. P0 package work is fanned out by workflow; see the git log.
- (Feature expansion [38c2f9], v0.1 W3 capacity core, 2026-09-24) new package `packages/capacity/**`
  (`@better-compute/capacity`: capacity math §10.2, selectors/filters/scorers + `InlinePlacer` §10.3, reservation
  booking/release/extend §10.5, rollups §10.6), new `tests/capacity-*.test.ts`. One-line inserts for `capacity` in root
  `tsconfig.json`, `vitest.config.ts`, `umbrella.json`. Not touching inventory, server, proto/, migrations, daemon,
  better-iam.
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
- (Feature expansion [060790], v0.1 W3b inventory + store, 2026-09-24) accepts. `packages/inventory/**` (section
  verification + snapshot digest, diffs, labels, devices/atoms from inventory, hardware_key, v0.1 conditions,
  Inventory/Health reconcile logic), `packages/postgres/**` (sole writer of `migrations/0003+`; send column requests
  to me), `tests/{inventory,postgres,pglite}-*.test.ts`. First migration `core/0003_v01_columns` takes the P0 gap list.
- (Feature expansion [1f44fd], v0.1 W4 IAM bridge, 2026-09-24) accepts. New package `packages/iam/**`
  (`@better-compute/iam` + `./plugin`: `createComputeIamBridge`, IamPlugin with never-throw `afterAudit` → `iam_inbox`
  spill, memory-resident authz projection + resolver, `embedded(iam)` IamPort, usage sink with poison isolation, flag
  cache, IamInbox/IamReconcile module), new `tests/iam-bridge-*.test.ts`. One-line inserts for `iam` in root
  `tsconfig.json`, `vitest.config.ts`, `umbrella.json`. Read-only: `tests/iam-contract.test.ts`, `tests/support/**`,
  core, server, postgres, better-iam.
