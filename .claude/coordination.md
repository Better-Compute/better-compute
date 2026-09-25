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
- Go go1.27.1 is installed at `C:\Program Files\Go\bin\go.exe` (not on PATH for every shell; call it by full
  path). `node scripts/daemon-proto-gen.mjs` regenerates `daemon/gen`.
- Docker is not running; PGlite (PostgreSQL 18, `btree_gist` verified) is the local database. Postgres-only
  suites skip unless `BETTER_COMPUTE_POSTGRES_URL` is set.

## Round 2 allocation (orchestrator is now [37c0ab], formerly [56cfd7]; 2026-09-24 after W5a landed at 8180bf8)

Sessions resume their former areas. Open items are assigned to the natural owner. Message [37c0ab] for installs,
core/protocol changes, and anything unassigned. All earlier rules below still apply (private-index commits,
orchestrator-only lockfile/umbrella/installs, [9e83b6] sole writer of core migrations).

| Area | Owner (resumed) | Open items this round |
|---|---|---|
| inventory, postgres migrations, provision, metal | [9e83b6] (ex-060790) | Talos walkthrough (§5.6 #3, httpViaSite with SSRF checks); W5a schema asks: `outbox_cursors(name PK, txid xid8, seq bigint, updated_at)`, `work_queue.attempts`, `commands.owner`, indexes `outbox((payload->>'tenantId'), txid, seq)`, `usage_windows(tenant_id, window_start, idempotency_key)`, `join_tokens(tenant_id, pool_id, id)`; retention GC for `outbox`/`authz_changes` |
| gateway | ex-[17cfb9] | v0.4 WS fallback (signed frames only); re-send `Cancel` for `cancel_requested_at` rows; pass `{ peerNodeId, gatewayId }` to `services.join/renew`; Hello writes `node_sessions.daemon_version/proto_max` (core/0008); drive dispatch + `store.cancels()` from partial indexes (2k steady saturation) |
| capacity, vps, providers | ex-[38c2f9] | v0.5 calendar reservations + BookingRepair (T−15 min), gang scheduling on topology keys, MIG/slot atoms (capacity side, atom rule with [9e83b6]'s `gpuAtomFamily`); fix `quotas.set` fleet id → `fleetResourceId` ('global'); decide the `observed_generation >= 1` schedulability gate (§3.3 step 7) |
| pki, cli, fleet, rollout | ex-[9ec62d] | CLI `dev` (all-in-one: PGlite + embedded better-iam + local CAs + `--sim N`) and `serve --mode api\|gateway\|worker\|all` composing EVERY module (capacity built in, inventory, provision+metal, vps, events, fleet, rollout, audit, observability, iam bridge, gateway with `gatewayReportHandlers`, `gatewayNotifier`, PKI bundle → `pki.join`); `better-compute sim`; `cloud-iid` attestor in pki |
| iam bridge, observability, audit, real-time harness | ex-[1f44fd] | the §16 v0.1 security negative: 10-min simulated run with `spyIamPort` recording zero IAM calls on heartbeat/inventory/command paths; realtime join-to-adopted and place-to-active benches; fleet-sim capacity facts for I1/I8 |
| server follow-ups | orchestrator [37c0ab] (may delegate) | `/.well-known/better-compute` join-key fallback (`joinEncryptionJwk` + join signing cert); `MethodContext.check/invoke` + `transaction:'manual'` (verify/implement for fleet.apply); runtime `publishMany/enqueueMany`; outbox cursors on `outbox_cursors`; `ModuleContext.afterCommit`/`caches`; `ReconcileContext.lease` |
| docs site `apps/docs`, console-kit + `apps/console` | unassigned (new sessions: ask [37c0ab]) | generated API/CLI/error reference from the live registry (mirror better-iam apps/docs), guides per module; console-kit React views (v0.5) |
| W1 Go daemon | blocked on Go install (user) | — |

Round 2 reassignments ([37c0ab], later on 2026-09-24): [9e83b6] → `inventory.history/diff`, walkthrough 1 (Ubuntu
autoinstall) + 20-loop sim acceptance, `metal-chaos`, then (on the orchestrator's go) server v0.2 groups `siteTokens`,
`joinRequests` (with [df4a91]'s discovery attestor), `secrets`, `drivers.list`, `sites.update/delete`, `nodes.delete` as
new files in `packages/server/src/api/`. [7fe4f7] → owns `packages/cli/**` now (`dev --sim N` on `createDevStack`,
serve composition audit), then docs site. [0b2be8] (= former [9ec62d]) → tunnels API half, new
`packages/server/src/tunnels/**`; options/index one-liners go through [37c0ab]. [df4a91] → pki attestors incl.
`cloud-iid` (seams in bb7106b). [18810e] → gateway. [90a507] is a better-iam session: never assign it better-compute
work. console-kit + `apps/console` still unassigned.

Round 3 status ([37c0ab], evening 2026-09-24). DONE: the whole Round 2 table above (server follow-ups be0048e;
per-input actions + tunnels hosted f1bf979; module-context ports + v0.2 groups 11a798b; SiteBoot 650116f), console-kit +
apps/console ([0b2be8]), driver-sdk (145ce12), examples/ ([7fe4f7]), secret broker + revocation feed ([df4a91]),
multi-gateway 10k + nightly sim ([3afca2]), spot/node leases/pool-lease placer ([13084d]), BMC rotation + tenant-root
([9e83b6]). Current owners:
- [18810e]: server runtime work-queue/reconcilers/leases/workers (join-storm perf, lease renewal timer, shard takeover)
  + gateway; docs generator (`apps/docs/scripts`).
- [ebe83b]: `apps/docs` shell + hand-written content.
- [df4a91]: worker command signing + trust bundle (v0.2 exit); security reviews.
- [9e83b6]: protocol `encodeMessageJson` + runtime `encodePayload` (proto3 JSON payloads), postgres `retentionModule()`,
  metal on FakeDaemon, firmware reflash.
- [0b2be8]: SSH principal binding (node-bound certs), agt/dlg ticket claims, console review fixes, console.
- [13084d]: set-based batch commits in the pool-lease worker, image-cached scorer, VPS on pool-lease.
- [3afca2]: FakeDaemon vps-host profile, instances + allowed_kinds in the nightly, v0.3 no-leak acceptance in sim.
- [7fe4f7]: CLI (serve/dev/examples wiring: retentionModule, pool-lease, tunnels relay).
- Orchestrator [37c0ab]: installs/lockfile, core/protocol additive changes, server index/options/api/context.
Open, unassigned: W1 Go daemon (needs Go installed), real-Postgres runs (no Postgres here), D15 hardware gates.

## Round 4 allocation (proposed by [f85da7], 2026-09-24 late; all round-3 sessions are gone)

Six "Feature building continuation" sessions started at once. If two proposals collide, this one stands (it was written
first); reply to [f85da7] to swap. The uncommitted WIP in the tree when round 4 started is ORPHANED work of round-3
owners: each area's new owner finishes (or discards) the orphan files in its area and commits them via a private index.

| Area (round-3 owner) | Round 4 owner | Orphan WIP to finish first |
|---|---|---|
| orchestrator: installs, lockfile, umbrella, core/protocol, server index/options/api/context, `nodes-module.ts`, `controllers/**` ([37c0ab]) | [f85da7] | `pnpm-lock.yaml` (docs installs), `packages/server/src/{nodes-module.ts,controllers/lifecycle.ts,controllers/liveness.ts}` |
| capacity ([13084d]) | [097b34] | `packages/capacity/src/{placer,pool-index,reservations,shortlist}.ts`, `tests/bench/placements.bench.ts`, `bench/placements/results/*` |
| vps, provider-hetzner, driver-sdk, cross-module e2e (`tests/e2e-*`) ([13084d], orchestrator) | [016b7b] | — |
| inventory, postgres migrations (sole writer), provision, metal ([9e83b6]) | [f02367] | image cache: `packages/inventory/src/{image-cache.ts,index.ts,store.ts}`, `packages/postgres/src/migrations/{0015_inventory_images.ts,index.ts}`, `packages/protocol/src/sections.ts` (delegated), `tests/{inventory-image-cache,postgres-executor,postgres-schema}.test.ts`, `packages/testing/src/fake-hw.ts` |
| gateway + server runtime (work queue/reconcilers/leases/workers) + docs generator ([18810e]) | [c321a3] | `packages/gateway/src/store.ts` |
| iam, events, audit, observability, realtime/sim ([3afca2]) | [31c64a] | `packages/iam/src/{streams.ts,index.ts}`, `bench/realtime-*/results/*` |
| CLI, examples, testing dev stack ([7fe4f7]) + pki, tunnels, console-kit, apps/console, security reviews ([df4a91], [0b2be8]) | [402c97] | `packages/cli/src/{config,index}.ts`, `examples/shared/compose.ts`, `tests/cli-serve-compose.test.ts`, `packages/testing/src/dev/stack.ts` |
| mcp, fleet, rollout ([9ec62d]; unlisted until now) | [f85da7] | — |
| apps/docs shell + hand-written pages ([ebe83b]) | "Docs app with better-iam styling" [731f14] | `apps/docs/**` untracked files |

TEST COMMITTED CODE with `node scripts/head-check.mjs [--no-build] [vitest filters]` (52ac77b): a worktree at
HEAD with junctioned node_modules, so other sessions' uncommitted work never shows up as your failure.
COMMIT WITH `node scripts/private-commit.mjs -F <msgfile> -- <paths>` (fe7f27e). The old private-index recipe
(read-tree HEAD; add; commit) silently REVERTS a commit that lands between its read-tree and its commit (f069c84
reverted core/0019-0021; fixed in 96b8812). The script builds the tree from HEAD + your paths in a throwaway index,
commits with HEAD as parent and moves the branch by compare-and-swap (retrying on a moved HEAD), then resets the
shared index for your paths. It commits WHOLE files: before committing a file others also edit (server index/
options, core, coordination.md), run `git diff -- <file>` and make sure every hunk is yours (f5e1886 carried
[402c97]'s uncommitted signer line). If you must commit by hand: record HEAD first and verify `git rev-parse HEAD~1` equals
it afterwards; if not, `git diff --stat HEAD~1 HEAD` and restore every foreign path at once.

All earlier rules apply: private-index commits (the pre-commit hook enforces it), orchestrator-only installs/lockfile/
umbrella files, the migration writer is the only one adding `core/00NN`, message the owner before touching their files.

Round 4 exit-test gaps ([f85da7]'s audit of PLAN §16 against tests/**; only gaps buildable in TS without Go, real
hardware or Postgres). Owners pick these up after their orphan WIP:
- [31c64a]: `tests/sim/faults-1k.test.ts` (fleet-stub fault scenarios at 1k, I1/I2/I5/I8); sim invariants I3
  (convergence within T), I4 (no false unreachable, gateway clock skew), I7 (nothing pending an offline solver could
  place); sim scenarios "identity deleted before usage flush" and "compute inbox down, other IAM subscribers still
  served, spill metrics rise"; resolver timeout → decision denied end to end; usage flush across a worker restart with
  no duplicates + `iam.billing.spend` read-back; `delegation:revoke` closes tunnels/SSE/MCP within 5 s sim time;
  v0.4 sim scenarios (XID storm trips the breaker, a bad daemon build halts its canary, 10-min site partitions, DB
  outage release nothing); server/iam suites in both IAM modes (vitest project over `remoteIam`).
- [016b7b]: `tests/e2e/spine.test.ts` (org user bound by policy, not root, reserves 4 GPUs; FakeDaemon CDI UUIDs ==
  `reservations.get` exactly); `tests/e2e/vps.test.ts`; multi-tenant container offer rejected; "no tenant VM runs
  bcd" (instance user-data carries no join token/bcd; join tokens refused for instance identities); churn diff
  extended to overlays and taps.
- [097b34]: the §15 torture shape on PGlite (8 placers, 2 lock-ignoring, MIG repartitions, constraint-free shadow
  recheck) = also the v0.5 MIG torture test; placements bench checks I1 after the run + a 200/s gate flag.
- [c321a3]: a ramdisk-role certificate refused for a `node` Hello; a gateway-forged AllocationBound rejected through
  the gateway report hook into capacity (not only pki-intent).
- [f02367]: deploy-time refusal of an unsigned/unverified image; site-agent failover mid-PXE (standby continues the
  boot step within 30 s, sim clock).
- [402c97]: DONE: support-bundle token scan for TS-produced bundles (2daaa64); a packed-smoke vitest wrapper under
  `tests/` (packed-smoke.test.ts). Later:
  - CLI `console`/`exec`/`forward` (9f5272d, 89d3032); `sandbox *` incl. `sandbox exec` over ssh tunnels (e01394e).
  - trust_version switch gate (b4551ff).
  - Security reviews #2/#3, all fixed: c8295a9, 482dea8, ab99642, dc75f63, f438dbe, f1fbbf2, 7b9e9af (HIGH:
    multi-line SSH CA line via legacy seal), 3238a5a.
  - nodes.listSshCerts (f0bdc81) + console-kit createSshAccessView (ba442cb).
  - pki sandboxSshCa + tunnelsOptions (b9debd5).
  - console-kit sandboxes view + page (a545208); commandOwner in hosts (8b31b44).
- [f85da7]: DONE: MCP → IAM confirmation → same-key retry as one flow (39b3eda); known-key replay matrix step
  (542885d); §12.6 policies incl. DelegatedSmall extend on real drafts (cc62e03, which also fixed stale-projection
  admissions); node-scoped gateway reports (6725423). Later: remote-IAM MCP remoteMcpIam (3afe9c1) + reservation
  tools (ed03816); audit sinks + module-extension sinks/scheduler plugins (b365357); attested bindings server half
  (3ebbc0a); traceparent (fe7f27e); downloads route (f5e1886); walkthrough 2 acme-cloud (f2ddea3); join-storm
  statements (ff90b8a); supportBundles (fb4a7e2); projects.archive/commands.cancel/usage.export (a567c87); core/proto
  asks: d4a11b9, 7ed9a9b, 0e37c3e, 2e041c2, da404a8, b20a3a1; decision ae3134f (cert role in Subject OU, no private
  OIDs: Go cannot parse the 2.25 arc) → [402c97] implements. Tools: scripts/private-commit.mjs, scripts/head-check.mjs.
- W1 Go daemon: [6a20b8] (= ex-[016b7b]); Go go1.27.1 is installed. Landed: c739e54, 91d2491 (node agent, bcd
  join/node), 485d95b (real bcd e2e tests/e2e/bcd.test.ts on externalTls, BCD_E2E=1 on Windows/WSL; host
  inventory.Collector; server-time high-water mark per [402c97]), e3dd05b (logs.collect + redaction), a4c305b (bcd
  status socket), 20e6a84 (access converger: sshd CA/principals/native KRL), bd9eaf4 (tunnels: ticket re-verify,
  PTY console, ssh/tcp; e2e through the real gateway), 1a7f0b7 (SecretRequest/WorkloadTokenRequest), 86c582d (XIDs
  from kmsg → Xid<n> conditions; PSI/steal pressure), ab3e493 (gpu.reset). README → [097b34]. Then 21a4647 ramdisk
  kinds, a302223 bcd ramdisk (bootparams cmdline), a06899b security, 48cb975 site kinds (Redfish, httpProxy, boot
  entries), 0c35daf bcd site boot server. Next: site image cache, proxyDHCP/TFTP, instances runtime.
- OPEN cross-owner items ([f85da7], keep current):
  - nightly sim I8 ("billed 0 atom-ms but booked") red at clean HEAD: [31c64a], with [f02367] helping.
  - Sandboxes (D24, user said yes): PLAN §3.7 (e645a4d); the `sandboxes` group on vps() is [097b34]'s. They ping
    [f85da7] before the step 5 proto seams (desired_state PAUSED, restore_from, instance.snapshot).
  - trust_version (c85e68d proto): node_sessions column [f02367] → gateway writes it [c321a3] → bcd/FakeDaemon
    report + `pki rotate-command-root --stage switch` check [402c97].
  - Input schemas: core `describedBy` + the jsonSchema of server/fleet/rollout/vps validators ([c321a3]).
  - vps tenantDeleted hook ([6a20b8]/[097b34]).
  - iamGuard (§8.1): `BETTER_COMPUTE_IAM_GUARD=warn|throw`, or `iamGuard` in options ([f85da7]); a full guarded run
    is in progress.
  - Security review #2 of d5b3df2..HEAD ([f85da7], 2026-09-25):
    - instance tcp/ssh tunnels dialled host loopback: fixed in bcd a06899b ([6a20b8]); server refusal asked
      of [402c97];
    - Welcome clock rewind re-opening ticket replay: fixed in a06899b;
    - tenancy handler reads IAM inside the inbox tx and is fail-open: [31c64a];
    - vps has no tenantDeleted: [097b34]; workload tokens now refused for suspended/deleted tenants
      (d143ead);
    - binding:deactivate revokes the actor's certs: [402c97];
    - metal BMC rotation stores a bare password: fixed in 6abfa79 ([f02367]).
    - Also found by [f02367]: inventory from tenant-controlled nodes was applied as trusted (a lessee could
      hide GPUs from node-lease billing and rewrite labels): now advisory, a5af436. The docs "Trust" line in
      guides/nodes/inventory-and-health.mdx is still to be written (docs session).
  - FleetConfig sandboxTemplates (5f2067e); MCP sandbox tools (54da7a8); iamGuard (54facfc).
  - [402c97] security review #3 fixed:
    - HIGH: a multi-line CA injected into TrustedUserCAKeys via legacy/unsealed bundles (7b9e9af, bcd 512ca6a);
    - pins read unauthenticated (7b9e9af);
    - no cap on forward connections, and SSH re-authorization failing open (3238a5a);
    - tenancy delete trusted subjectId (392cb86).
  - v0.5/v1.0 exit-gap audit ([f85da7], 2026-09-25):
    - [097b34]:
      - sandboxes.exec: DONE (dd352d3);
      - tests: a denied create claims nothing; concurrent SKIP LOCKED claims; the snapshot memory round trip:
        DONE (9b83bda, 6b3dfb2);
      - template env and network: DONE (a8c8020; 7c73072 on [f85da7]'s seam 5a946c9). Also: readyAt at first run,
        fresh-only warm claims (template instance_version), selfCheck findings (7d03d6d), vps.sandbox.warm meter
        (83d0ebd). bcd still owes network_policy nftables + instance.snapshot ([6a20b8] told).
    - [31c64a]:
      - tests/e2e/sandboxes.test.ts: v0.5 sandboxes EXIT MET (a8f3dfc): 500 TTL expiries with a zero-leak diff,
        the warm claim, the memory round trip, the drain;
      - both IAM modes: DONE (d5816ac). The server/capacity/vps suites run on fakeIam and have no mode;
        the §9.2 matrix through IamPort covers the contract in both.
      - nightly I8: fixed (aa5faeb, 5/5 green).
    - [6a20b8]:
      - bcd instance-address dial + advertise `tunnel.instance-dial`: DONE (13aa5cf), plus converger PAUSED (fab94d4)
        and a real bcd vps e2e (0fc0405);
      - a bcx host in bcd;
      - walkthrough 4 as a Go runtime plugin;
      - PAUSED/restore_from/instance.snapshot in the converger.
    - [f02367], v1.0:
      - "upgrade from v0.5 disturbs no running allocation": DONE for reservations (24824c9, tests/sim/upgrade.test.ts,
        0 disturbances, exact billing); VPS instances next (ControlPlaneSim vps pool);
      - N−2 skew harness: DONE (24824c9, tests/skew-matrix.test.ts; v1.0 adds rows);
      - API surface freeze: DONE (0aad40a, in lint:repo 4e99fc6);
      - renderer join flags: DONE (e6b3b14, plus bcd.service).
    - [f85da7]:
      - nightly.yml (sim + 10k cold start, IAM-guarded suite, Postgres full suite, green-night streak): 6e723b1 (see its git note);
      - release.yml (goreleaser + syft SBOM + keyless cosign + SLSA3 provenance): 30ed477.
    - §16 gateway gate: met on the workstation (bc596e5: 5k mTLS sessions in a split process, 0 drops,
      dispatch p99 26 ms, storm back in 39 s; listen backlog 4096 in 03dc281, [c321a3]); only the 30-min
      reference-Postgres run is left. The 30-min PGlite run (14ff010): 0 drops, p99 24 ms, storm OK, but gateway
      RSS grew 1.24 → 2.02 GiB with a flat 235 MiB heap. The RSS criterion is OPEN (likely PGlite WASM in-process;
      [c321a3] to confirm with the store out of process).
    - Docs session [75b663] (ex-[731f14]) findings at be1e7d9:
      - HIGH: provision renderers and Robot bootstrap run `bcd join --server/--node-id/--token-file` and
        `bcd node --join-token-file`, which bcd rejects (exit 2), so deployed machines never join. bcd adopts
        those flags plus a Go contract test fed from scripts/daemon-fixtures.mjs ([6a20b8]); renderers
        emit exactly that ([f02367]).
      - Redfish system path, ramdisk/iPXE image build + site/ramdisk e2e, BIOS/RAID/firmware BMC ops: [6a20b8].
      - Join chain status:
        - bcd flags (797915d, c98dd68) and renderers (e6b3b14): done;
        - the well-known `gateway` section (670d586, [f85da7]): done;
        - hosts passing gateway.url + pki.servingCa: DONE (8127271: compose env vars, dev stack externalTls);
        - the user-data pins that replace trust on first use: pki bootstrapPins (afdaeb6), provision flags
          ([f02367]), bcd preferring the user-data pins ([6a20b8]).
    - [31c64a] security review #5 (routed by them):
      - HIGH: tenancy read a bare IAM 404 as "tenant missing" and could tear down root: [31c64a] fixing;
      - MED-HIGH: the well-known join trusts web PKI only; the fix is user-data pins
        ([f02367] renderers + [6a20b8] bcd + [402c97] host pins);
      - MED: IMDS matches by source IP only; bcx plugins run as root without seccomp; >5 min snapshot
        uploads fail ([6a20b8]);
      - MED: template env can read any tenant secret via sandboxes:manage ([097b34]);
      - the secret broker lacked a tenant-state check: fixed (6a3248a, [f85da7]).
    - Sandbox snapshots can be deleted (46d0a29); owner-scoped lists, PLAN rows and MCP tools (935e150).
    - Docs-session sandbox gaps:
      - MCP gate rules: fixed (e2ead0e);
      - console snapshot button (0b9495c), CLI list limit and pki reseal --accept-unauthenticated (2a62d85):
        DONE ([402c97]); the vps.sandbox.warm meter in iam setup: [31c64a];
      - sandbox exec host-key pinning: pki.issueHostCertificate (a9c3662), vps half [097b34], then the CLI
        switches to @cert-authority ([402c97]);
      - bcd network_policy nftables: DONE (6db49c8, fails closed); Redfish system paths + an @odata.id guard
        (4e4c1d7);
      - deleting a kept snapshot: [097b34];
      - the sandbox-templates reference regen: [c321a3];
      - SDK exec/files helpers: deferred (PLAN §3.7).
    - Open, no owner:
      - the real-hardware nightly (needs hardware);
      - a Postgres CPU <50% bench and the 30-min gateway run (need reference Postgres);
      - the v1.0 external security review (a process item).
  - Sandboxes step 5 seams (paused, restore_from, instance.snapshot, runtime pause/resume/snapshot): b78045b.
  - DONE this round: tenancy §12.8 (ae9a7bb); vps instances.create wait + budget check (32c25ae); wake edge on
    dedicated nodes (9093323); ramdisk allowed kinds (464788a); capacity jsonSchema (45e9685); PoolIndex lazy load
    (7e52552).

- [31c64a] round 4: orphan iam streams done (09e6514: agentStreamCloser/gatewayStreamCloser), bench results (e06ec34);
  v0.4 sim scenarios gateway-kill/zombie/DB failover/10-min partition (8878e99, ControlPlaneSim.failDatabase/
  cutGatewayDatabase), XID-storm breaker (6e71654, FakeDaemon.injectXid), canary halt (99f9f1f, FakeDaemon
  selfUpdate); observability databaseCollector (b569f05); events.prune retention (f069c84); remote admission
  refresh + projection page/refresh race (3371cb0); audit archived months (103068f); faults-1k (0486a1b); SSE
  /watch revocation + watch registry (7d616be; host wiring asked of [402c97]); resolver-timeout e2e (13b6a7d);
  usage-restart acceptance with spend read-back (d82cf37); inbox-down scenario (1908f79); sim invariants I4
  (c11554d), I3 (a2c7011), I7 (bcdf2c7, capacity's placeablePending); collector lease + placementObserver
  (90503ef); metricCatalog (2d856dd); both IAM modes: createEmbeddedTestIam({ mode }) + vitest.iam-remote.config.ts
  (3c8a74e, 30/30 green; root script asked of [f85da7]); events catalog rows (b41ebe6). The whole exit-gap list
  for [31c64a] is DONE. Then: budget-alert handler (9cfe709), subtree-webhook intake (22cceaa), capacity IAM
  reactions drafted for [097b34] (c820fdf: withdrawAgentReservations/reassignReservations/applyBudgetPolicy; index
  export + stop-new admission are [097b34]'s; host wiring [402c97]'s), runtimeObserver (5e6f8b1), writers for
  gateway_sessions/security_events_total/resolver_lookups_total (423b180).
  Tenancy §12.8 DONE (ae9a7bb; hooks: capacity 2e91167, provision/metal f7df0ec; host default handler 7790748;
  iamTenantReader a6485c8; security fix, IAM reads moved out of the inbox tx: 6670778). 10k cold start DONE (033cb78,
  8af096c workerPasses; 1cc354b: 10k ready in 80 s simulated, back in 40 s after a power cycle, 0 violations).
  Nightly I8 fixed (aa5faeb, [f02367]'s triage). Tenancy follow-ups: deletions wait for IAM (392cb86), events purge
  (4d1f489), tenant gauges (c647307), sim e2e (4ee6e47). Both IAM modes: matrix through the port + wider remote
  config (d5816ac). Sandboxes (harness + metrics; group is [097b34]'s): catalog abc38ac, metrics 823a309, exec
  re-auth d7557a0; NOW tests/e2e/sandboxes.test.ts (green at 20, 500 running).
- [c321a3] round 4 (gateway, server runtime, docs generator): orphan store.ts (d430815); tunnel filters tenantId/anyAgent +
  reauthorizeTunnels (6aeb5c4); generator MDX escaping + MDX compile check (bd57184), events page (c563de7); ramdisk
  exit test + ReportContext.attested (56f8cc1); FakeDaemon signs attested reports (f7fbba7); v0.4 scheduler worker role
  (6b5e189; shard rebalancing itself already existed); duplicate-identity quarantine §7.2 (c583263); sink poison
  isolation + outbox_dead_letters (1a3156d); workflow wakes on settle (e482db1); v0.2 exit "gateway-forged
  AllocationBound rejected" e2e + signed-spec relay (fac16e4); both exit gaps above DONE. Later: UPGRADE_REQUIRED gets
  daemon.upgrade (a42400f); IMDS workload-token relay (8e16349); set-based section ingest (9475e75) and heartbeat hashes
  (0ab7c11), join 168→~100 statements/join (1k realtime-spine 73.8 s: CPU-bound in one process); serving-cert hot
  reload + WS proof key rotation (0b80e6f, d5b3df2); one lease per event sink (aadfaf1); Hello drivers → labels
  (447023b); TunnelInfo.sessionId/action (6b4b72d); xidStatusHandler records host pressure (6b080de); input JSON Schema
  (6cf1bc0) → API Input tables (df398c2); metrics page (19e38fb); worker.observe (f39b1d4) + gateway onHandshake
  (181bf84); WS-fallback tunnels refused at once (c297246). HEAD green at ffedabd (gateway/runtime/docs/e2e, 265).
- [f02367] round 4 (inventory, migrations, provision, metal): image-cache orphan (c7cd2ec); migrations core/0016
  duplicate_identity, 0017 allocation_evidence, 0019 outbox_dead_letters, 0020 commands.created_at, 0021 signed specs;
  core/0018 PARTITIONED HISTORY (4efd977): audit_events / inventory_snapshots / usage_windows are monthly range
  partitions + a default one, PKs gained the time column; retentionModule keeps months ahead and prunes superseded
  inventory (180 d), opt-in usage, settled commands (30 d) and uncursored authz_changes (1 d) (7e33342); exit gaps DONE:
  deploy-time image signature re-check (58c737f), standby takes over boot mid-PXE (0ff3f37: awaitCommand `reroutable`
  for site-relayed BMC commands); `driver.invoke` kind registered in provisionModule (5043442). Later: set-based
  inventory ingest/apply + recordInventoryHashesMany (7d3c343, 154b176, 7effda6, eceb07a: ≤1 inventory statement per
  join); hygiene sweep DriverMismatch/CertExpiring/DaemonOutdated + host pressure (0cf7c80); MIG layout gate
  provision/0004 + workflows.pause/resume (037608b); site cache pre-warm `site.cacheImages` (a0d7b73); metal.unrescue
  (23cbc24); "ready only after a trusted wipe" property (7368ac9); history conformance (835f4e0); doctor findings for
  retention/provision/metal (e0f802b, b333462); health edges wake capacity reservations (6f19d5d). HEAD green for my
  suites at eceb07a (420 tests).

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
| W1 Go daemon | [6a20b8] (Go installed; see round 4) | `daemon/**` |

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
- Provision engine for W5a ([060790]: 86061c0; `core/0004_command_cancel` 1d9d5bf): `ModuleContext.workflows =
  provision.workflowEngine({ work, events, commands })`; reconciler `workflow` (shardBy node; key nodeId or
  workflowId). Runtime wake-ups: when a command whose `idempotency_key` starts with `wf:` settles →
  `work.enqueue(tx, 'workflow', node_id)`; on Hello with a new boot_id/role → same (await 'rejoin'). Module migrations
  `provision/0001_workflows` (profiles, workflows, workflow_steps are module-owned). Next for [060790]: metal()
  control plane (§11.1 verbs, `metal` group) on the engine.
- VPS for W5a ([38c2f9]: 8cdeffb, 4246008 delegated confirmation in capacity): gateway instance status reports call
  `reportInstances(tx, ctx.work, nodeId, reports, { complete })` from @better-compute/vps (returns `{updated, orphans}`
  for leak alerts); `vps()` nodeSpec contributes `instances`. New package `provider-hetzner` (outside the umbrella,
  injectable `fetch`, in-memory Hetzner emulator; `providerConformanceCases()` exported from vps).
- More W5a wiring from [38c2f9] (74cb0ce, 9ee6889): periodic reconcilers `capacity.rollup` (5m), `capacity.usage`
  (5m, writes usage_windows for the IAM usage sink), `vps.usage` (5m); edge-enqueued kinds `capacity.reservations`,
  `vps.instances`; gateway report hooks `markAllocationBound/Failed/Released` (capacity) and `reportInstances` (vps).
  A lost binding keeps `bound_at` (billing = reserved time) and shows as Degraded/BindingLost.
- W5b committed (dd99f10): `createFleetSim` (+ `GatewayPort` in packages/testing/src/sim/port.ts: `accept(conn,
  {nodeId, role})`, `tick(now)`, `kill(reason)`, `facts()`), `FrameConn` (structural: send, onFrame (async ok),
  onClose, close, abort, ping), `FakeDaemon`, invariant checkers. [17cfb9]'s `attachFrameConn` plugs in as a
  GatewayPort; gateway timers must use the sim scheduler. CPU-only fake nodes send no `gpus` section ([060790]:
  treat as never reported).
- W1 (Go daemon) TODO list from W5b's parity review — the TS FakeDaemon already behaves this way; bcd must match:
  acceptance order per PLAN §6 (node/kind → min_generation → EXPIRED → BUSY → BAD_SIGNATURE; missing not_after =
  EXPIRED); SUCCEEDED{rebooted} fills `NodeRebootResult.previous_boot_id`; journal outcome `cancelled` (CANCELLED
  when nothing ran); results record the producing `boot_id`; terminal rejections journaled; journal-full → BUSY
  (never drop results); `Sweep` must also expire accepted/running entries never redelivered (TTL); `site` section
  reported only when set; Hello advertises drivers (e.g. `nvidia`).
  v0.3 access ([0b2be8]): from `AccessSection.ssh_ca_public_keys` write sshd `TrustedUserCAKeys`, and from
  `ssh_principals` (`<account>@<nodeId>`, only this node's) an `AuthorizedPrincipalsFile /etc/ssh/bc_principals/%u`
  per account listing exactly those lines (never bare account names: a certificate names its node); on OpenTunnel
  re-verify the exec ticket against `exec_ticket_jwks_json` + own jti set (fail closed when full), require
  `sid` == tunnel_id, then open the Tunnel rpc with `opened` first (FakeDaemon 23dfe67 is the reference).
  SSH KRL (d057cbf): from `AccessSection.ssh_revoked_serials` write the KRL (`ssh-keygen -k -f /etc/ssh/bc_krl -s
  <ca.pub> -z <generation> <file of serials>`) and `RevokedKeys /etc/ssh/bc_krl` in sshd_config, rewritten on every
  access-section change (an empty list still writes an empty KRL).
- 25fcd9c: webhooks rows in core apiSurface are module 'events' (injected `@better-compute/events`, 812ed34:
  eventsModule, handleWatch SSE). W5a: server's `events.list` copies the outbox reader (txid_text alias, qualified
  ORDER BY), never imports events; mount `handleWatch` from the host (GET /watch), not from server.
- AUDIT CHECKPOINTS split (orchestrator, resolving a double claim): [1f44fd] owns `packages/audit` (module, table
  `audit/0001_checkpoints`, hourly reconciler, xmin/txid cursor over `audit_events` — needs an additive
  `audit_events.txid`/`seq` column from [060790]); [9ec62d] owns the pure crypto in `pki/src/audit.ts` (RFC 6962,
  proofs, checkpoint sign/verify under SigningPurpose 'audit-checkpoint', 5862fb4) and CLI `audit verify|prove|
  checkpoint`; no `pki/0002` migration. One Merkle implementation (pki), one table (audit).
- Metal for W5a ([060790] e64b4fc; migrations core/0005_audit_commit_order, core/0006_pool_archive): register
  `provisionModule({ modules: [bareMetal] })` + `metal()`; `ctx.workflows = provision.workflowEngine(ctx)`;
  `ctx.secrets` (pki `localSealedSecretStore`) for inline BMC creds; run reconcilers `metal` and `workflow`.
  COMMAND PAYLOAD RULE (orchestrator decision): `CommandQueue.enqueue({ payload })` takes the proto3 JSON form of the
  kind's declared payload message (`CommandKindSpec.payload` descriptor); the runtime encodes it with protobuf-es
  `fromJson` + `Any.pack` into `CommandBody.payload` and rejects invalid JSON with INVALID_CONFIG. Routing data
  (target node) goes in `EnqueueCommand.nodeId`, never in the payload.
- COMPOSITE METHODS (33170fd, for [9ec62d]'s fleet.apply): W5a envelope must implement `MethodDefinition.transaction:
  'manual'` (handler runs with no tx; envelope writes the audit row after success) and `MethodContext.check(path,
  input)` (tenant pre-check + validate + one iam.require, refused inside an open tx and for admission methods →
  UNSUPPORTED) / `invoke(tx, path, input)` (runs validate + handler in `tx` only for calls `check` allowed in the same
  method call, keyed by path + canonical input hash; else ACCESS_DENIED).
- Gateway sim (b3bfa30) + storm fixes (41c88fc): W5a must swap the fleet-gateway port's raw SQL enqueue for
  `ctx.commands.enqueue` and add bookings/allocations to the sim facts (I1/I8). `poke(nodeIds?)` = dispatch + targeted
  spec check only — never a full spec sweep per poke. [17cfb9] next: v0.3 tunnels (may additively extend
  `packages/testing/src/daemon/**` for tunnel handling; journal rules untouched).
- Observability for W5a ([1f44fd] cbed794): `createMetrics({maxSeries})`, `standardMetrics(registry)`,
  `metricsHandler({registry, bearerToken, timingSafeEqual})` (GET /metrics), `meteredIamPort(port, metrics)` (wrap the
  IamPort once), `createObserver({onSpan, metrics}).span(...)`, traceparent helpers. check/invoke matching = path +
  canonical JSON of the raw input (sorted keys), multiset (one invoke per check), grants expire with the call.
  [1f44fd] next: real-time harness (`packages/testing/src/realtime/**`, `tests/realtime/**` — exception to W5b).
- Real-time harness ([1f44fd] df8ff63): `createRealtimeHarness({nodes, postgresUrl?, sharedConnection?, services?})`
  → `connectAll()`, `dispatch({kind, perNode})` (p50/p90/p99 ack + terminal); `createH2cClient` (Session/Join over
  h2c, `x-bc-test-node`). 1k run: `tests/bench/realtime-fleet.bench.ts` (bench:scale). Needs a fresh gateway dist
  (`tsc -b packages/gateway`). W5a: pass your GatewayServices as `services` for join-to-adopted/place-to-active.
- Tunnels (v0.3, [17cfb9]) api half for W5a: `tunnels.open` authorizes (`instances:exec` / `nodes:console`), issues an
  exec ticket (pki `createExecTicketIssuer`, sid = tunnel id), returns the ticket; host GET `/tunnels/{ticket}`
  relays to `gatewayControlClient.openTunnel({ ticket, nodeId, target })` → `{ send, frames, close }` on the owning
  gateway (`node_sessions.gateway_id`). `createGateway({ tunnels: { jwks, issuer?, jtiCache?, reauthorize? } })` gets the issuer's
  JWKS; host supplies `reauthorize(tunnel)` (60 s) and calls POST `/v1/tunnels/close {subject|tunnelId|nodeId}` on
  revocation events. The daemon ALWAYS re-verifies the ticket (P14); the gateway check is defence in depth.
- Health for W5a ([060790] 0e70a77, c0f2a59, 08f1a15): gateway `node.event` XIDs → `recordXid(tx, nodeId, {gpuUuid,
  xid})` then `work.enqueue(tx, 'health', nodeId)`; pass `work` to `applyInventory`; run the provision `health`
  reconciler. W5a's final commit also swaps the NOT_IMPLEMENTED probes (server-operation, server-http, client,
  umbrella-subpaths use `inventory.history`) for an `acme.notYet` plugin method in tests/support/server.ts, so
  [060790] can land inventory.history/diff right after.
- 44ed79e (for W5a check/invoke): methods with a replay-only `admission` (no `denied` hook: sites/pools/
  providerAccounts create) ARE allowed — `check` runs `admission.prepare` in its own short tx (`decide` → one
  iam.require on the returned resource; `replay` → grant); `invoke` re-runs `prepare` in the caller's tx (replay →
  return stored result) and sets `ctx.admission`. Methods whose admission has `denied` stay UNSUPPORTED. New core
  error code `CONFIG_DRIFT` (409). [9ec62d] fleet committed 9ccff66; next: CLI `fleet export|plan|apply`.
- Fleet wiring for W5a ([9ec62d] 9ccff66, 1b89b67, 6c55dea): register `fleetModule({ driftEvery? })` (migrations
  fleet/0001_names, fleet/0002_applied; reconciler `fleet.drift`, shardBy none, periodic key 'all' every 15m which
  enqueues 'tenant:<id>'); events `fleet.drifted` / `fleet.converged` (subject fleet/<tenant>). core apiSurface has
  `fleet.status` (read).
- Provision renderers for W5a ([060790] 9b29615, 7716e93): `provisionModule({ userData: { controlPlaneUrl, bcdUrl,
  bcdSha256 } })`; step context needs `ctx.pki` (PkiPort.issueJoinToken) and `ctx.secrets`. provision's nodeSpec
  returns `{ host: { config } }`; the engine calls `ctx.desired.invalidate` on hostConfig workflow success.
- 9cadaa9: optional `EventPublisher.publishMany` / `WorkQueue.enqueueMany` (set-based, same coalescing). W5a runtime
  must implement both (INSERT … SELECT FROM unnest). Gateway group commit (24544d7): 1k ack p99 2.0 s → 0.65 s.
- LOCK ORDER (all units, set by [38c2f9]'s capacity torture test): any transaction that locks several of these takes
  them in this order: `quota_usage` → `pools` → `nodes` → `devices` → `node_resources` → `pool_capacity_rollup`.
  Releases refund quota FIRST (as reserve charges it first). W5a node verbs (cordon/taint/drain/liveness) that also
  touch capacity rows must follow it. ([097b34], round 4) `capacity_device_counts` (capacity/0003) is locked by a row
  trigger on `devices` right after its `devices` row: the order is … → `devices` → `capacity_device_counts` →
  `node_resources` → …; never lock a counts row before the devices row that feeds it.
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
- ([17cfb9], v0.3 tunnels gateway side §7.6, assigned by [56cfd7] 2026-09-24) `packages/gateway/src/tunnels.ts`
  + gateway/http2/internal edits (Tunnel RPC, OpenTunnel, POST /v1/tunnels h2 duplex + /v1/tunnels/close,
  `gatewayControlClient.openTunnel`), `tests/gateway-tunnels.test.ts`. May add tunnel handling to
  `packages/testing/src/daemon/**` additively (journal untouched).
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
- (Feature expansion [1f44fd], v0.3 events, assigned by [56cfd7] 2026-09-24) new package `packages/events/**`
  (`@better-compute/events`: `eventsModule()` with the §9.2 `webhooks` group, the webhook EventSink with signed
  delivery/retries/dead letters/redeliver, the SSE `handleWatch`), new `tests/events-*.test.ts`. Module-owned tables
  via `events/0001_*`. One-line inserts for `events` in root `tsconfig.json`, `vitest.config.ts`, `umbrella.json`.
  Committed 812ed34.
- (Feature expansion [1f44fd], v0.4 Merkle audit checkpoints §13, 2026-09-24) new package `packages/audit/**`
  (`@better-compute/audit`: `auditModule()` with hourly signed per-tenant Merkle checkpoints over `audit_events`
  (read-only), migration `audit/0001_checkpoints`, inclusion proofs, `verifyAuditCheckpoints` for `better-compute
  audit verify`), new `tests/audit-*.test.ts`. One-line inserts for `audit` in root `tsconfig.json`,
  `vitest.config.ts`, `umbrella.json`. Committed 7efc6f2 (crypto from pki c355faf).
- (Feature expansion [1f44fd], §14 metrics, 2026-09-24) new package `packages/observability/**`
  (`@better-compute/observability`: bounded Prometheus registry (maxSeries, no tenant labels), the §14 standard
  `better_compute_*` series, `meteredIamPort`, DB backlog gauges, `/metrics` handler), new
  `tests/observability-*.test.ts`. No core changes; registry inserts for `observability`.
- (Feature expansion [060790], v0.2 provision workflow engine, 2026-09-24, offered by [56cfd7]) `packages/provision/**`
  (workflow engine §11.2, profiles §11.4, `provisionModule()` with the Workflow reconciler, core `WorkflowEngine`,
  profiles/workflows API groups), `tests/provision-*.test.ts`, and the workflows/workflow_steps migration. Builds on
  core `ctx.commands/work/events/authz`; not touching server, core, metal, gateway. Committed 86061c0 (engine),
  4c4fb37 (image catalog + images group, `provision/0002_images`).
- (Feature expansion [060790], v0.2 metal control plane, 2026-09-24, assigned by [56cfd7]) `packages/metal/**`,
  `tests/metal-*.test.ts`: the metal group (§9.2 v0.2 rows), verbs validated against core's metal state table and
  run as workflows via `ctx.workflows`, built-in commission/deploy/release/retire profiles + steps, site/ramdisk
  command kinds, driver bindings inherited from the pool hardware profile. Proto additions go to [56cfd7].
- (Feature expansion [13084d] = former [38c2f9], v0.5 gang scheduling + BookingRepair, 2026-09-24)
  `packages/capacity/**`, `tests/capacity-*.test.ts`: all-or-nothing multi-node reservations on one topology key
  (§10.3), then BookingRepair re-placing calendar reservations at T−15 min (§10.5). Core ask to the orchestrator:
  additive `gang?: { size; topologyKey? }` on `ReservationRequest`/`PlacementRequest`.
  Next (asked by [37c0ab]): shrink the inline placer's pool-lock critical section; new suite
  `tests/bench/placements.bench.ts` + `bench/placements/**` (PLAN §16 placements/s). Then spot preemption.
  Done: 744e233 (shortlist, 35.7/s), ef9d32c+03d8e10 (spot), c7c7c4d (binding 'node' leases, with [9e83b6]).
- (Feature expansion [9ec62d], v0.2 FleetConfig, 2026-09-24, asked by [56cfd7]) new package `packages/fleet/**`
  (`fleetModule()`: fleet.export/plan/apply, composite apply via check/invoke, `fleet/0001_names`), CLI
  `packages/cli/src/commands/fleet.ts`, `tests/{fleet-config,cli-fleet}.test.ts`. Committed 9ccff66, 05e6265.
  Hosts register `fleetModule()` next to capacity + vps; apply needs W5a check/invoke with replay-only admissions.
- (Feature expansion [9ec62d], v0.4 Rollout controller, 2026-09-24, offered by [56cfd7]) new package
  `packages/rollout/**` (`rolloutModule()`: releases + rollouts groups, rollout/0001 tables, `rollout` reconciler,
  NodeSpec.daemon via nodeSpec(), daemon.upgrade kind), `tests/rollout-*.test.ts`. Also pki `release.ts` (b226081).
- (Feature expansion [9e83b6] = former [060790], resumed) owns again `packages/{inventory,provision,metal}/**`,
  `packages/postgres/src/migrations/` (core/0009+; column requests to me), `tests/{inventory,postgres,pglite,provision,
  metal}-*`. Done: Talos walkthrough 66a494d, core/0009_runtime + retention f2e761b, walkthrough 1 + 20-loop
  acceptance + metal-chaos, core/0010_v02_server (join_requests, node_certs.allowed_kinds, nodes.deleted_at,
  secret_refs) 15903ff, PGlite ANALYZE, core/0011_v02_security (sites.deleted_at, attestation_uses) ef279fa, v0.2
  server groups as NEW files packages/server/src/api/{join-requests,site-tokens,secrets,drivers,sites-manage,
  nodes-delete,v02}.ts + controllers/site-boot.ts (ef279fa, tests eb82f90; registration lines sent to [37c0ab]).
  Also own `tests/server-groups-{join-requests,site-tokens,secrets-drivers,sites-nodes-delete}.test.ts`,
  `tests/support/server-v02.ts`. Then: node-signed results fail-closed + core/0012_v02_evidence (result_sig,
  node_bindings) 88780ec/338e895, provision join resolvers 3db0a56, v0.5 dedicated-root metal (metal/0003,
  contract with [13084d]) b36fe7e, BMC rotation (metal/0004) 516064c, discovery tokens as refs b1e82ec, firmware
  reflash fb05a3c, capacity+metal lease E2E 5f2f289, FakeDaemon attest 6979115 + dev fleet `joinSite()` 7bdcaef
  (delegated edits in packages/testing), `tests/support/metal-fake-site.ts`. Waiting on: [37c0ab]'s runtime
  encodePayload accepting proto3 JSON (metal on the real server; `tests/metal-fakedaemon.test.ts`), [df4a91]'s
  broker (ramdisk joins on the dev stack).
- (Feature expansion [3afca2] = former [1f44fd], resumed) owns again `packages/{iam,events,audit,observability,
  provider-proxmox}/**`, `packages/testing/src/realtime/**`, `tests/{realtime/**,bench/realtime-fleet*,iam-bridge-*,
  events-*,audit-*,observability-*,provider-proxmox*}`. Now: `createRealtimeFleet` (join-to-adopted, place-to-active)
  in `packages/testing/src/realtime/fleet.ts`; then the 10-min zero-IAM sim (`tests/sim/iam-negative.test.ts`).
- (Feature expansion [df4a91], v0.2/v0.3 attestors §3.3/§15, 2026-09-24) NEW files only in pki:
  `packages/pki/src/attestors/{x509pop,provisioned,discovery,cloud-iid,index}.ts` + one export line in
  `packages/pki/src/index.ts`; `tests/pki-attestors-*.test.ts`. Verifier halves (control plane) + TS NodeAttestor
  producers for FakeDaemon. Not touching server JoinService (W5a wires `attestors: [...]`), migrations, or existing pki files.
  COMMITTED 27418ec (on [37c0ab]'s bb7106b seams: `evidence.token`, `context.csrSha256`, purpose 'x509pop').
  JoinService wiring for hosts: `createJoinService({ attestors: [x509popAttestor(), provisionedAttestor({ resolveTarget }),
  discoveryAttestor({ resolveWorkflowNode }), cloudIidAttestor({ providers, resolve })] })`. Host-supplied pieces:
  `provisioned.resolveTarget(tx, {id, tenantId, poolId?, siteId?}) → {nodeId?, productUuid?}` (provision: the
  `userdata.render` result `joinTokenId` → `workflows.node_id`; provider bootstrap: the server's SMBIOS UUID) — without
  a target the token must carry `expect.productUuid`; `discovery.resolveWorkflowNode(tx, workflowId)` →
  `workflows.node_id`; `cloudIid.resolve(tx, identity) → AttestationResult | undefined` (map accountId/instanceId to
  the provider account's pool; admit an AWS instance once). Providers: `gcpInstanceIdentity({ audience, fetch })`
  (agent requests aud = `cloudIidAudience(audience, sha256(csr))`, format=full), `awsInstanceIdentity({ certificates:
  { region: PEM } })` (AWS certs NOT bundled: copy them from AWS docs into config), `oidcInstanceIdentity` (generic).
  Discovery checks `leases` row `site:<id>:boot` (owner = signer, live, epoch == assertion epoch). Ramdisk result
  carries `certTtlSeconds: 7200` + `allowedKinds` — JoinService/gateway must enforce allowedKinds (not yet done).
  Agent side: `createX509popEvidence`/`x509popProducer`, `signDiscoveryAssertion` (site agent), `createCloudIidEvidence`.
  Next for [df4a91]: join_requests approval in discoveryAttestor once [9e83b6]'s table + a core `pending` result land.
  allowedKinds (orchestrator decision (a)): `node_certs.allowed_kinds text[]` (NULL = all; asked [9e83b6]); gateway
  dispatch rejects out-of-set kinds as 'kind-not-allowed' (agreeing with [18810e]); after [37c0ab]'s go, [df4a91]
  makes JoinService persist allowedKinds + min(attestor ttl, role cap) and CommandQueue.enqueue refuse up front.
  W1 daemon TODO (b): encode allowed kinds as a cert extension next to the role OID so bcd self-enforces.
  Later commits: b1de42a discovery approvals (`approval: 'never'|'unknown-machines'|'always'`, `hardwareKey`),
  e673802 pki `openJoinResponse` + testing `runAgentJoin` (two-round agent loop; dev/stack + realtime/fleet may
  switch to it), 4abbc82 single-use cloud instances/assertions (`attestation_uses`), f6653df/674b725 `tpm`
  attestor (`tpmAttestor({ challengeKey, ekRoots, pcrPolicy?, resolve })`, `tpmProducer(SoftwareTpm)`).
  W1 daemon TODO: bcd must use `openJoinResponse` semantics (never take a deferral for a join), answer
  challenges with the SAME CSR, pass sha256(csr) as the tpm quote binding, and implement the tpm agent side
  via go-attestation (ActivateCredential + Quote over the challenge's pcrSelection).
- (Feature expansion [9ec62d], W5c resumed after W5a landed) CLI `serve` / `dev` (7ba486a), `sim` (5826c1f). The CLI
  now belongs to [7fe4f7].
- (Feature expansion [0b2be8] = former [9ec62d], v0.3 tunnels API half, assigned by [37c0ab]) NEW files
  `packages/server/src/tunnels/**`, `tests/server-tunnels*.test.ts`: `tunnels.open` (exec ticket from pki's issuer),
  nodeSpec access.execTicketJwks, host-supplied `TunnelRelay`, exported `handleTunnel`, gateway `reauthorize` hook.
  options.ts/index.ts one-liners go through [37c0ab].
- (Feature expansion [0b2be8], v0.5 console-kit, assigned by [37c0ab]) NEW package `packages/console-kit/**`
  (framework-free stores over @better-compute/client, SSE watch, permission-aware actions; outside the umbrella),
  `tests/console-kit*.test.ts`, root tsconfig + vitest inserts.
- (Feature expansion [0b2be8], v0.5 apps/console, assigned by [37c0ab]) NEW `apps/console/**` (private Next 16 app:
  better-compute + better-iam on one origin, console-kit/react hooks, @better-iam/react; dev config on PGlite +
  embedded IAM). `typecheck` script only; `next build` stays out of `pnpm check`. DONE 694f3b7 (Next 15.5; IAM on
  libSQL; stack starts in instrumentation.ts). server.mjs (tunnels) c758efd, /api/compute/watch 93ac1c8 DONE.
- (Feature expansion [0b2be8], v0.3 tunnels in the testing kit, 2026-09-24; the tunnels exception above) FakeDaemon
  answers `OpenTunnel`: NEW `packages/testing/src/daemon/tunnels.ts` (ticket check against the spec's pinned JWKS +
  own jti set, `opened`, an echo shell program) + an additive `openTunnel` case and a `tunnels` option in
  fake-daemon.ts + one export line; `tests/testing-daemon-tunnels.test.ts`. Journal untouched.
- (Feature expansion [9ec62d], v0.4 audit primitives, 2026-09-24; split with [1f44fd] per [56cfd7]) pure crypto only in `packages/pki/src/audit.ts`: RFC 6962 hashing, inclusion + consistency proofs, `signCheckpoint`/`verifyCheckpoint` ('audit-checkpoint'), the bundle's audit signing key; CLI `audit verify|prove|checkpoint` calling `@better-compute/audit`. No table in pki (`packages/audit` owns it).

- ([7fe4f7], dev stack, 2026-09-24) NEW files only: `packages/testing/src/dev/stack.ts` (`createDevStack()`: PGlite +
  server runtime + local CAs/JoinService + real gateway on h2c + FakeDaemons that JOIN via sealed tokens over the
  gateway's Join RPC, then Session; adopted in ~1 s/node) + 2 export lines in `packages/testing/src/index.ts`;
  `tests/testing-dev-stack.test.ts`. Committed 43bb7de; split into `createDevJoinKeys`/`devFleetNotifier`/
  `attachDevFleet` (needs `insecureHeaderAuth: true`) in c084bb2. Not touching `realtime/**` ([3afca2]).
- ([7fe4f7], owns `packages/cli/**` + `tests/cli-*.test.ts` since 2026-09-24, from [9ec62d]) `dev --sim N` landed
  c084bb2 (`packages/cli/src/dev-sim.ts`; runServer hooks afterMigrate/started/stopping). Now: `serve` composition
  audit — `--roles gateway` (mTLS gateway via `spiffeAuthenticate`, report handlers, gatewayNotifier) and config-module
  wiring of every module; new files `packages/cli/src/host/**` (landed 268d0be, 18432ca; gateway auth fail-closed
  e35e4a5; doctor host findings 77e077c; root /.well-known = server's document 710cec1). apps/docs generator phase 1
  landed aaeb817 and moved to [18810e]. examples/ landed 560f295; revocation feed + host.metrics 43019d9; tunnels
  auto-mount dcadb48 (host/tunnels.ts; swap in [0b2be8]'s gatewayTunnelRelay when it lands). Free for the next unit.
- ([18810e], continuing [17cfb9]'s W2b gateway, 2026-09-24) `packages/gateway/**`, `tests/gateway-*.test.ts`,
  `tests/bench/gateway-streams.bench.ts`: Hello writes `node_sessions.daemon_version/proto_max` (core/0008); a
  `reports.status(tx, ctx, StatusReport)` hook for health (XID conditions → inventory `recordXid`); dispatch/cancel
  queries driven from the commands partial indexes (2k saturation); then the v0.4 WS fallback.
- (orchestrator [37c0ab] subagent, v0.5 bcx driver-sdk, 2026-09-24) packages/driver-sdk/**, tests/driver-sdk-*.test.ts, tests/fixtures/bcx-*
  ([18810e] addendum) FakeDaemon WS mode approved by [37c0ab] under the W5b exception: new
  `packages/testing/src/daemon/ws-dial.ts` (createWsDialer) + one export line in `packages/testing/src/index.ts`.
  ([18810e], assigned by [37c0ab]) (1) join-storm throughput: `packages/server/src/join/service.ts` (JoinService.join)
  + gateway forwarding, target 1k joins < 30 s on PGlite; (2) then docs site phase 1: `apps/docs/**`,
  `tests/docs-generate.test.ts`.
- ([ebe83b] "Docs app with better-iam styling", approved by [37c0ab] 2026-09-24, at the user's request) docs site
  phase 2: the Next 16 + Fumadocs app mirroring ../better-iam/apps/docs with its BoardUI styling. Owns
  `apps/docs/{package.json,tsconfig.json,next.config.mjs,postcss.config.mjs,source.config.ts,proxy.ts,Dockerfile,
  README.md,THIRD-PARTY-NOTICES.md,.gitignore}`, `apps/docs/{app,components,lib,styles,utils,public}/**`,
  `apps/docs/scripts/generate-icons.mjs` and the hand-written pages under `apps/docs/content/docs/**` (everything
  except the generated reference pages). [18810e] keeps `scripts/{generate,check-content}.mjs`, `generated/*.json`,
  the `descriptions/**` format (the prose in `descriptions/api/*.md` and `errors.md` is [ebe83b]'s, agreed), the
  generated reference pages and `tests/docs-generate.test.ts`. Installs by [37c0ab] (done 2026-09-24);
  `next build` stays out of `pnpm check`.
- ([731f14] "Docs app with better-iam styling" = continuation of [ebe83b], 2026-09-24/25) apps/docs shell + hand-written content, same file set as
  [ebe83b] above plus `apps/docs/data/**`. Writing the ~41 missing pages other pages link to: daemon/{install,
  protocol,sessions,delivery,gateway,failure-modes}, extending/**, operations/**, guides/clients/**,
  guides/events/{webhooks,watch,audit}, reference/{index,meta.json,glossary,ai,roadmap,changelog} + glossary data.
  The generator stays [c321a3]'s; lockfile commit by [f85da7] with apps/docs/package.json. DONE 1d9d403 (226
  files: shell + 123 pages, check-content clean, tsc clean, all routes 200 in next dev). Run the dev server with
  cwd apps/docs (`.claude/launch.json` "docs"): fumadocs-mdx resolves source.config.ts from the cwd, and from the
  repo root every page 500s with "getText('processed') requires includeProcessedMarkdown".
