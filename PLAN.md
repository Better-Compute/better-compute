# better-compute — plan

- **Date:** 2026-09-23
- **Status:** Proposed
- **Derived from:** better-iam at `C:\Users\Sean Filimon\Desktop\better-iam` (read-only for this plan)

Repo: `C:\Users\Sean Filimon\Desktop\better-compute` (only this plan and `docs/research/` today). better-iam is read-only for this plan; a better-compute session edits it only for an upstream item the user approves in chat (§12.12, D12).

**Evidence.** Research notes are in [`docs/research/`](docs/research/). Tags: [CONV] iam-conventions.md, [ID] iam-identity.md, [EXT] iam-extension.md, [DAY] daytona.md, [PA] prior-art.md. `path:line` citations point into `better-iam/packages/` unless they start with `apps/`. They were re-checked in source for this revision. **(verify)** marks an unconfirmed claim; check it before building on it. **(proposed upstream)** marks a better-iam change that does not exist yet. Every other better-iam API named here exists.

**Implementation sessions:** find your phase and workstream in §16, your package in §4.2, then the contracts you touch: §5 extension, §7 wire, §8.3 schema, §9.2 method → action table, §12 IAM. Contracts frozen at the end of P0 change only by additive, reviewed edits.

---

## 0. Summary

**What it is.** better-compute tracks GPU and bare-metal capacity: what exists, what is free, and who holds it, with double-booking impossible. It also makes machines useful: adopt a running server, deploy an image over PXE, or run a VPS on our hosts or a provider's. It has three runtime parts:
- **`bcd`**, one Go binary with modes `node` (every server), `site` (per datacenter: DHCP proxy, iPXE, image cache, BMC) and `ramdisk` (during PXE commissioning).
- **The control plane**, `betterCompute(options)`. Like `betterIam()`, it returns `{ api, handler, nodeHandler, initialize, start, … }`, and it can run as a server in modes `api | gateway | worker | all`.
- **The API**, `POST /api/compute/{group}/{method}`, with an inferred typed client, a CLI and MCP.

better-iam is the only IdP, policy decision point and billing ledger. Compute owns only machine PKI.

**Five better-iam facts that shape the design** (checked in source):
1. **Every IAM call takes a turn on one serialized lane.** The Postgres adapter takes `pg_advisory_xact_lock(1647206759, 1)` in every transaction (`adapter-postgres/src/index.ts:148-154`). Calls that take the lock:
   - Authentication runs in its own locked transaction and may write `sessions.lastSeenAt` (`server/src/principals.ts:95-121`, `auth/src/service/base.ts:1219-1283`).
   - `authorize*`, `require` and `listAccessible` authenticate again internally, then open the decision transaction (`server/src/operations.ts:222-236,267-268,292-293,322-325`).
   - `sts.getCallerIdentity` takes the lock twice (`api/sts.ts:240-246`).
   - `sessionTokens.verify` (`server/src/index.ts:617`), `features.isEnabled` (`api/features.ts:129-148`) and `billing.recordMany`/`check` (`api/billing.ts:3580-3595`) each take it.

   The resolver runs inside the decision transaction (`decisions.ts:408`). Access-usage recording is only buffered (`usage.ts:122-143`). ⇒ **P7:** fleet paths never call IAM. Each admission makes one decision, which costs ≥2 lock acquisitions. A resolver hit does no I/O.
2. **Subscribers and the action catalog are process-local.**
   - `fanOut` queues `auditHooks` only when the *recording* process has `afterAudit`, `onEvent` or subscribers (`events.ts:101-113`).
   - `dispatch()` runs the *dispatching* process's handlers in one loop with no guard, then marks rows delivered (`events.ts:222-238`).
   - Actions come from the constructing process's plugins (`catalog.ts:448-453`). A host without compute's plugin therefore rejects `compute:*` policies with `INVALID_ACTION` (`catalog.ts:507-512`) and denies `compute:*` decisions as `UNKNOWN_ACTION` (`decisions.ts:683-684`).

   ⇒ Every IAM host installs compute's plugin, and `afterAudit` never throws. U0 must land before the better-iam console may share compute's IAM database (§12.1).
3. **Denials are opaque; approvals are exact.** Every denial surfaces as `ACCESS_DENIED` (`operations.ts:216-220`). Confirmations are keyed by `(action, resourceType, resourceId)` (`agents.ts:368-374`). `requestConfirmation` throws `INVALID_INPUT` for actions that are not held back (`api/delegations.ts:1463-1467`). ⇒ Request-as-resource drafts with idempotency-derived ids; delegated confirmation arrives in v0.3.
4. **`iam/{tenantId}` resolves internally only for `iam:*` actions, and the resolver runs before the tenant check** (`decisions.ts:685-690` vs `419-425`). ⇒ Scope types `compute-fleet`, `compute-tenant` and `compute-project`. Compute rejects cross-tenant callers itself before touching its database (§3.4).
5. **Billing batches are all-or-nothing:** `recordMany` records every event in one transaction (`api/billing.ts:3580-3588`). An event for a deleted identity throws `NOT_FOUND` (`billing.ts:795-801`). ⇒ The usage sink isolates poison events (§12.7).

| Decision | Choice | Runner-up | Why |
|---|---|---|---|
| Daemon language | **Go** `bcd` (modes `node`, `site`, `ramdisk`, `sim`; privilege-separated `helper` in v0.4) | Rust | go-nvml XID events, bmclib, netlink/DHCP/TPM libraries, a small root supply chain; Daytona and Tinkerbell precedent [PA §8]. Rust has thin BMC/DHCP libraries; TS/Bun has no NVML events and would run an npm tree as root |
| Wire contracts | **protobuf + buf**, `buf breaking` in CI; TS and Go gen committed | JSON Schema | two languages on one wire need codegen and enforced additive evolution |
| API types / user docs | API types **inferred from the server**; profiles and driver config via a TS **`manifest` builder** (Standard Schema, exports JSON Schema) | JSON Schema-first | TS-to-TS needs no codegen, as in better-iam |
| Transport | **gRPC bidi `Session`** over HTTP/2 mTLS, dial-out 443, plus `Tunnel` streams; WebSocket fallback from v0.4 (signed frames only) | Daytona long-poll jobs | push, cancel and tunnels on one connection; 10k idle 30 s pollers ≈ 333 req/s [DAY §2] |
| Gateway tier | **Yes**, behind an L4 TLS-passthrough LB. Routing is a join on `node_sessions`. `Join`, `Renew` and `SecretRequest` are forwarded to `api`, which verifies node proofs itself (gateways hold no CA keys). The Node gateway must pass a v0.1 benchmark gate (D20) | streams on API replicas | isolates long-lived connections from API deploys [PA §1] |
| Storage | **Typed Postgres** (Kysely) with invariants in the DB and one clock, `compute_now()`; **PGlite** for dev/unit | better-iam records table | needs `EXCLUDE`, `SKIP LOCKED`, row concurrency; IAM's global lock is on the don't-copy list [CONV] |
| Queues | Postgres `commands` (+ CommandSweeper), coalescing `work_queue`, xmin-ordered `outbox`; optional notifier | NATS JetStream | transactional, no dual writes, no LISTEN/NOTIFY [PA §7] |
| No double-booking | `EXCLUDE` bookings + **atom rule** + guarded counters + `FOR SHARE` on node and atom rows | scheduler logic | the DB referees (§10.4) |
| Placement | v0.1 **inline placer** under a pool-row lock; v0.4 **pool-lease batching scheduler**; one `Placer` contract; API is async-with-wait from day one | Nomad plan queue | smallest correct v0.1; the swap needs no API change |
| Packaging | `inventory` and `capacity` are always-on built-in modules of `server`. `provision`, `metal()` and `vps()` are injected modules. `betterCompute<M,P>()` types the API. `server` never imports injected modules (`check-deps.mjs`) | monolithic server | user requirement; Daytona-grade modularity [DAY §9] |
| IAM mode | **Embedded** by default. **Remote** from v0.4 (the IAM host installs compute's plugin, an in-memory projection replica and an inbox). No upstream change for v0.1 in the supported topology (compute is the only IAM host). **U0 is required to co-host the better-iam console** | remote-first | library-first; audit-free billing; no `requireRecent` wall [ID §0] |
| IAM resources | **All app-owned**, prefix `compute-`; per-tenant projection; request-as-resource drafts; scope types; normative method → action table (§9.2) | managed pools in org tenants | `TENANT_MISMATCH` on cross-tenant registration; forgeable managed attributes [EXT §1.6] |
| Node identity | compute PKI: join token + CSR → 24 h SPIFFE cert; `Renew` with proof of possession; node-signed attested results (v0.2); attestor plugins; **no IAM identity** | IAM web identity per node | per-trust limits; root audit-chain serialization [ID §2] |
| v0.1 scope | adopt (join token) → inventory → reserve whole GPUs under an IAM policy → CDI `hold` → IAM billing → release; 1k-node deterministic sim; gateway and IAM-lane benchmark gates | include PXE or agent confirmation | every plane, least code |

**Package map** (details §4.2):
- `core` (contracts) and `protocol` (buf gen).
- `inventory` and `capacity`: built-in modules.
- `provision`, `metal` and `vps`: injected modules, stubs from P0.
- `server` (factory, router, controllers), `gateway`, `postgres` (+`./pglite`), `pki`, `iam` (bridge, `./plugin`), `client`, `cli`, `mcp`, `testing`.

The umbrella **`better-compute`** re-exports all of these (`better-compute/{inventory,provision,metal,vps,…}`, bin `better-compute`). Outside the umbrella: `provider-hetzner`, `provider-proxmox`, `driver-sdk`, `console-kit`, and `daemon/` (Go).

| Phase | Theme | Headline exit test |
|---|---|---|
| P0 | Scaffold | `pnpm check` green on ubuntu+windows × Node 22/24; `buf breaking` wired; packed smoke with vendored better-iam; all four named subpaths resolve (stubs); contracts frozen |
| v0.1 | Adopt & reserve | real `bcd` + 1k simulated nodes; GPUs reserved under an IAM policy, bound, metered and released; 1,000 concurrent reservations never double-book; zero IAM calls on fleet paths; gateway ≥5k sessions and IAM-lane gates met |
| v0.2 | Metal | QEMU VMs PXE through `bcd site` + sushy-tools to `deployed`, 20 unattended loops; destructive commands signed; gateway-forged results rejected; site-agent failover <30 s |
| v0.3 | VPS & access | libvirt-kvm instances; Hetzner provider; daemon-verified exec tickets; MCP; delegated confirmation |
| v0.4 | Scale & HA | 10k real daemons on 3+ gateways; pool-lease scheduler; WS fallback; self-update; remote IAM |
| v0.5 | GPU depth & ecosystem | MIG/timeslice/MPS atoms, calendar and gang reservations; tenant-root metal; bcx; TPM; console-kit |
| v1.0 | Freeze | proto/API freeze, skew guarantee, security review, publish |

---

## 1. Goals, non-goals, design principles

**Goals.**
- **G1** Fleet truth: sites, pools, nodes, devices, health and holders.
- **G2** Exact capacity now and over a horizon, with double-booking impossible by construction.
- **G3** Many provisioning paths, built as driver compositions (Ironic): adopt; PXE, iPXE, UEFI-HTTP or virtual media plus image stream or kexec; provider reinstall; VPS on libvirt/KVM or Cloud Hypervisor; provider VMs.
- **G4** A daemon per server, a horizontally scalable control plane, and an API, SDK, CLI and MCP surface.
- **G5** Per region on one Postgres primary: 10k nodes, 100k GPUs, ≥200 placements/s, command p99 <1.5 s. These are targets, to be proven in v0.4.
- **G6** Daytona-grade modularity: versioned contracts with conformance suites. New provisioning methods and providers need zero core edits (§5.6).
- **G7** better-iam as IdP, PDP, ledger, flag store and event source.
- **G8** Agent-ready: typed SDK, MCP, delegated sessions with human confirmation.

**Non-goals (v1):** a workload orchestrator (capacity goes to Kubernetes or Slurm through config drivers); our own users, roles, keys or invoices; telemetry storage; active-active multi-region; volumes and SDN beyond bridges, VLANs and IPAM; live migration; Windows or macOS nodes; Equinix Metal (EOL 2026-06-30 [PA §1]).

**Principles.**
- **P1** Postgres is the truth. Gateway memory, caches, projections and pokes are rebuildable.
- **P2** Desired state plus generations, reconciled level-triggered. Commands only for one-shot actions.
- **P3** At-least-once delivery, made safe by idempotency keys and fencing (session epoch, lease epoch, generation, journal id).
- **P4** Invariants live in the database (`EXCLUDE`, `CHECK`, guarded updates, partial unique indexes).
- **P5** Nodes only dial out.
- **P6** Disconnected is not dead. Nothing is released because a node is unreachable, and metal is never automatically declared lost.
- **P7** Fleet hot paths (heartbeats, inventory, commands, reconcilers) never call IAM. An admission makes one IAM decision, which costs ≥2 lock acquisitions: `require` = authenticate + decide. It costs 3 on an authentication-cache miss, plus 1 for `billing.check`. Flags come from a cache (§12.5).
- **P8** Telemetry never goes through Postgres or the control stream.
- **P9** One clock. SQL uses `compute_now()`, and TS business time comes from a `Clock` port anchored to it. Gateways report ages, not timestamps (§8.4).
- **P10** Core never imports an implementation; implementations are passed in, following better-iam's `ProtocolMount` pattern [CONV §3]. The two always-on built-in modules are the one exception (§4.3).
- **P11** Fail closed:
  - an unknown command kind is `UNSUPPORTED`;
  - a resolver miss is `NOT_FOUND` (unaudited), and a resolver timeout is a deny;
  - a failed `authorizeMany` batch is an error, never "all false" [EXT §1.9];
  - a method whose action is missing from the catalog fails `initialize()`.
- **P12** Everything is bounded: lanes, queues, payloads, journal, spill buffers, metric cardinality.
- **P13** The daemon is dumb but capable; policy stays in TypeScript.
- **P14** Relays cannot forge. From v0.2, gateways and site agents relay signed intent downward and node-signed attested results upward. Tokens and secrets cross them only sealed.
- **P15** Mirror better-iam unless §4.5 says otherwise.

---

## 2. Domain model & glossary

IAM types carry the configurable prefix `compute-`. All are app-owned: compute resolves them, and they are never registered in IAM.

| Term | Definition | IAM mapping |
|---|---|---|
| **Region / Site** | Region: a geographic label in IAM's region-name grammar, stored as `iamRegion` (not IAM's `regions` option [EXT §4]). Site: a boot and failure domain served by ≥1 `bcd site` agent, which is a `nodes` row with `role='site'`. Kind `shared`, `dedicated` or `custom` (tenant hardware [DAY §6]). | `compute-site` |
| **Pool** | A scheduling and policy domain in one site. It has an owner tenant; a class (`metal-host`, `metal-dedicated`, `vps-host`, `provider`); **one `gpuModel`**; a sharing mode (`exclusive`, `mig`, `timeslice`, `mps`); overcommit; `lostAfter`; a disruption budget; a backend (`fleet` or a provider account); `agent: 'bcd' \| 'none'`; and an acceptance list. | `compute-pool`; relations `viewer`, `user`, `operator`, `admin` |
| **Offering** | A `pool_offers` row that makes a platform pool exist in a tenant's view, with quota and priority. | resolver input |
| **Node** | A server running `bcd`, or a provider machine with `agent:'bcd'`. Orthogonal axes (Ironic): `provisionState` × `maintenance` × `cordoned` × `power` × `connectivity` × `conditions[]`. Also: `role` (`unassigned`, `host`, `dedicated`, `site`); `generation`/`observedGeneration`; `adapter`; per-concern `drivers`; `trust` (`platform`, `tenant-owned`, `tenant-controlled`); `hardwareKey`. | `compute-node`, parent pool |
| **Device / atom** | A DRA-style unit with typed attributes: `gpu`, `gpu.mig` (`<gpuUuid>/gi<g>/ci<c>`), `gpu.slot` (timeslice/MPS), `nic.vf`, `disk`, `node`. Only **atoms** (`bookable=true`) are booked (§10.4). | never in IAM |
| **Inventory / Capacity** | Inventory: `NodeInventory v1`, sectioned, hashed, append-only [PA §4]. GPUs carry `gpuProduct` (normalized NVML name, e.g. `H100-SXM5-80GB`) and `gpuModel` (family, e.g. `H100`, mapped by `gpu-models.json`). Capacity: allocatable, allocated, reserved and available (§10.2). | — |
| **Reservation** | A tenant claim `{pool, devices[], topology, start?, duration, binding: hold\|instance\|node}`. It starts as a **draft** whose id derives from `(tenant, identity, idempotencyKey)` (§3.4). | `compute-reservation`, parent pool |
| **Allocation / Booking** | Allocation: placement on one node (one per node for gangs). Booking: `(device_id, allocation_id, during)`, guarded by `EXCLUDE`. | — |
| **Lease** | Always qualified: *allocation lease* (a renewable hold), *liveness lease* (40 s TTL), or *shard/pool/site lease* (worker or agent ownership with a fencing epoch). | — |
| **Instance (VPS)** | A VM, microVM or single-tenant container on an allocation, with `desiredState` vs `state` [DAY §3]. | `compute-instance`, parent pool |
| **Image / Profile** | Image: a signed, content-addressed artifact. Profile: a versioned template, immutable once used, with driver bindings, image, user-data, steps, `hostConfig` and acceptance. | `compute-image`, `compute-profile` |
| **Workflow / Step** | A profile expanded for one target: persisted steps with `runsOn ∈ {control-plane, site, node, ramdisk}` and optional `await: 'rejoin'`. | — |
| **Driver / Provider** | Driver: one or more Ironic concerns (`power`, `management`, `boot`, `deploy`, `inspect`, `console`, `virtual-media`, `bios`, `raid`, `firmware`, `config`, `runtime`) [PA §6]. Provider: an external capacity API with configured accounts. | `compute-provider-account` |
| **Node adapter** | How the control plane reaches a node: `bcd/v1`, `provider-api/v1` (pools with `agent:'none'`), later `agentless-ssh/v1` (Daytona `RunnerAdapter` [DAY §2]). | — |
| **Command / NodeSpec** | Command: a durable, idempotent one-shot message with `seq`, `not_before`, `not_after`, `min_generation` and kind flags `retry_safe`, `self_terminating`, `attested` (Daytona's Job). NodeSpec: generation-numbered desired state. | — |
| **Admission context** | The IAM decision context recorded for each allowed mutation (identity, session, kind, agent, delegation, request id), because IAM doesn't audit allows [ID §0]. Async work acts on it, never on stored tokens. | compute `audit_events` |
| **Tenant / Project** | Tenant: the IAM `tenantId` (root = platform, organization = customer). Project: an app-owned grouping (`projects` table). An IAM child tenant is used only for billing isolation [ID §4]. | `compute-tenant`, `compute-project` |

```
Region 1─* Site 1─* Node 1─* Device ─(atoms)─* Booking *─1 Allocation *─1 Reservation | Instance
Site 1─* Pool *─* Node        Pool 1─* Offering(tenant, quota)       Provider 1─* Account ─→ Node (agent:'bcd')
Profile 1─* Workflow 1─* Step 0..1─1 Command *─1 Node 1─1 NodeSpec(generation)       Tenant 1─* Project
```

---

## 3. Architecture

### 3.1 Components and planes

| Plane | Component | Trust |
|---|---|---|
| Interface | SDK, CLI, MCP, console-kit, webhook receivers | untrusted callers holding IAM credentials |
| Identity | better-iam (embedded in `api`/`worker`, or remote) + the `better-compute` IAM plugin | trusted |
| Control | `api`: stateless HTTP, admission, `JoinService`, secret broker. `gateway`: sessions, tunnels. `worker`: controllers, placer, workflows, sinks, usage, IAM inbox, CommandSweeper | trusted; the gateway is relay-only (P14) |
| Data | Postgres + PgBouncer (transaction mode), object store, TSDB, KMS/Vault | trusted |
| Site | `bcd site`: DHCP proxy, TFTP/iPXE/HTTP boot, image cache, BMC via bmclib; one active boot server per site (lease) | high value; secrets sealed per request |
| Node / ramdisk | `bcd node` (+`helper` from v0.4), runtimes, CDI / `bcd ramdisk` | trusted while the platform holds root (§13) / restricted cert, ≤2 h |

### 3.2 Diagram

```
  SDK · CLI · MCP · console ── POST /api/compute/{group}/{method} ──┐          better-iam (embedded | remote)
                                                                    ▼                ▲ admission only (P7)
 ┌─ L7 LB ─ api ×N: authn/z · draft+projection · admission tx · JoinService ┘  plugin: catalog · resolver · afterAudit
 │            │ SQL (PgBouncer)           └─ internal mTLS: tunnels → gw; Join/Renew/Secret ← gw ──────────┐
 │  ┌─────────▼──────────────────────────────────────────────────────────────────────┐                     │
 │  │ Postgres: nodes · node_sessions · devices · device_bookings(EXCLUDE) ·         │◄─ epoch-fenced ─┐   │
 │  │ reservations · commands · work_queue · outbox · leases · authz_projection · …  │                 │   │
 │  └───▲──────────────────────────────────────────────▲─────────────────────────────┘                 │   │
 │      │ SKIP LOCKED · shard/pool leases              │ afterAudit → iam_inbox                        │   │
 │  worker ×K: controllers (256 shards) · placer · workflows · sinks · inbox                           │   │
 │              └── optional pokes (NATS/Redis) ──►  ┌─ L4 LB (TLS passthrough) ─ gateway ×M ─────────┴───┘
 │                                                   │  sessions + liveness in memory, batched to DB
 │                          gRPC bidi Session (+Tunnel), mTLS, outbound :443 only
 │            ┌─────────────────┬────────────────────┴────┬───────────────────────────┐
 │       bcd node (GPU)    bcd node (VPS host)     bcd site (DHCP proxy, iPXE,     bcd ramdisk
 │       NVML·XID·CDI      libvirt/CH · IMDS       HTTP cache, bmclib) ─ BMC VLAN  (restricted cert)
 └ telemetry: bcd / dcgm-exporter ── OTLP / remote-write ──► TSDB   (never Postgres or Session: P8)
```

### 3.3 Flow (a): a daemon joins (v0.1, brownfield adopt)

1. **Token.** `joinTokens.create({ tenantId, poolId, maxUses (default 1), ttlSeconds ≤ 86400, expect?: {productUuid|serial|mac|gpuUuid}, allowReclaim })` requires `compute:join-tokens:create` on `compute-pool/{id}`. It returns `bcjt_<id>.<secret>` once and stores `sha256(secret)`.
2. **Install.** `better-compute daemon install-script --pool <id>` emits a POSIX sh script (§6 *Install*). The script:
   - reads the token only from `BCD_JOIN_TOKEN` or stdin;
   - downloads the pinned `bcd` version and verifies its sha256;
   - installs the binary, `bcd.service` and `/etc/bcd/config.toml` (0600: gateway URL, site, gateway serving-CA SPKI pin, JoinService key pins);
   - runs `bcd join`.
3. **Join.** bcd generates a P-256 key (TPM-resident if present) and calls `Join{sealed_token, csr, hardware claims}` over server-authenticated TLS, pinned to the serving CA. `sealed_token` is a JWE to the pinned JoinService encryption key. The gateway forwards the call to `JoinService` in `api` over internal mTLS, so it cannot harvest the token.
4. **Admit.** In one transaction JoinService:
   - runs the attestor chain (v0.1: `join-token` only);
   - computes `hardware_key` (§8.3) and enforces `expect` and the reclaim rules. Reclaiming a trusted key with a new node key needs `allowReclaim` and ≥2 matching independent identifiers. A key built from placeholder DMI values needs `expect` in v0.1, or operator approval via `joinRequests.approve` from v0.2;
   - inserts `nodes(provision_state='adopting', role from the pool class)` and `node_sessions(node_id, session_epoch=0)`;
   - decrements the token;
   - signs a 24 h cert (URI SAN `spiffe://<td>/site/<site>/node/<nodeId>`, role `node` in the Subject OU `bc-role:node`, no tenant).

   It returns `JoinResponse{body, sig}`, where `body` carries the chain and the command-signing trust bundle and `sig` is made with the pinned join-signing key.
5. **Session.** bcd opens `Session` with `Hello`. The gateway checks the chain, revocation, the role, and that the SAN equals `Hello.node_id`. It bumps `session_epoch` and replies `Welcome{epoch, heartbeat 10s, leaseTTL 40s, credits, request_sections, server_time}`.
6. **Inventory.** The gateway stores a snapshot and enqueues `work_queue('inventory', nodeId)`. The Inventory controller derives devices (`gpuProduct`, `gpuModel`), labels and conditions (v0.1: `GpuCountMismatch`, `GpuModelUnknown`).
7. **Acceptance.** NodeLifecycle runs the pool's `policy.acceptance`: `[{kind:'diag.nvml'}]` in v0.1, `diag.dcgm{level:1}` from v0.2. On pass the node becomes `adopted` and NodeSpec writes generation 1; at `observedGeneration=1` the node is schedulable. On failure it gets a condition plus `NoSchedule`. No step in this flow calls IAM, which the v0.1 IamPort spy test asserts.

### 3.4 Flow (b): a user or agent reserves GPUs (v0.1; normative admission sequence for every `create`)

1. **Request.** `client.reservations.create({ tenantId, poolId, devices:[{class:'gpu', count:4, topology:'nvlink-all'}], duration:'8h', binding:'hold', idempotencyKey, wait:{timeoutMs:20000} })`. The credential is an IAM bearer (`biam_ses_|key_|sts_|rol_|dlg_`) or a session JWT whose audience includes both the IAM issuer and compute [ID §1].
2. **Authenticate.** Embedded: `iam.authenticate({headers})`. Remote: `sts.getCallerIdentity`. The result is cached 30 s by `sha256(token)` and dropped on inbox revocation events. A cache miss costs 1 IAM lock acquisition (2 in remote mode) and may write `sessions.lastSeenAt`.
3. **Tenant pre-check.** If `caller.tenantId ∉ {input.tenantId, rootTenantId}`, return `ACCESS_DENIED` without reading or writing compute's DB. The response is identical whether or not anything exists, it mirrors IAM's masked `TENANT_MISMATCH`, and it puts no outsider traffic on the victim tenant's audit chain. Root-tenant callers continue to IAM, which grants `ROOT_OVERRIDE` only to a root realm + `rootAdmin` + user session + MFA (`context.ts:232-241`) and audits it.
4. **Idempotency.** Look up `(tenant_id, owner_identity_id = caller.identityId, idempotency_key)`:
   - same request hash on a non-draft row: return the row (only its owner can reach it);
   - same hash on a draft: re-decide under the same id;
   - different hash: `CONFLICT` with no body.

   The same key from a second identity gets its own row, so there is no collision and no squatting.
5. **Draft (tx 1).** Insert `reservations(state='draft', id='rsv_'+base32(sha256(tenantId‖identityId‖key)))` and its `authz_projection` row: type `compute-reservation`; attributes `gpuModel, gpuCount, durationHours, region, binding, spot, projectId`; parent `compute-pool/poolId`; `ownerId`. This happens only if the pool is owned by or offered to the tenant; otherwise return `NOT_FOUND` (the caller is inside the tenant, so this reveals nothing beyond it). The API process also puts the row in its in-memory projection (§12.4).
6. **Decide, exactly once.** Call `iam.require({ headers, tenantId, action:'compute:reservations:create', resource:{type:'compute-reservation', id} })`. This costs 2 lock acquisitions, because `require` authenticates again and then decides (`operations.ts:222-236,322-325`).
   - The resolver returns the request attributes plus `parentType/parentId`, so `resource.parentRelations` carries the pool relations. Pool access and request limits are one decision.
   - Budgets ride along through the `principal.spendExceeded` deny in the recommended tenant policy (§12.6). Pools with `admission.budgetCheck:'meter'` also call `iam.billing.check` (+1 acquisition).
   - Feature-flag conditions come from the flag cache (§12.5). `isEnabled` is never called per admission.
7. **Delegated confirmation (v0.3).** On a denial with `session.kind==='delegated'`, call `delegations.requestConfirmation(<caller's credential>, {tenantId, action, resource, reason, validSeconds: 900})`.
   - `INVALID_INPUT` ⇒ plain `ACCESS_DENIED`.
   - Otherwise the draft becomes `awaiting-confirmation` (≤30 min) and the API returns `403 CONFIRMATION_REQUIRED {confirmationId}`. The agent polls `getConfirmation` and retries with the **same key**, which hits the approved triple.
   - IAM hides deny reasons, so a policy-denied request for a confirm-listed action also creates a futile confirmation request (U8 fixes this).

   In v0.1 a delegated denial is a plain `ACCESS_DENIED`.
8. **Admit + place (tx 2).** The `Placer` (§10.3):
   - fences the pool;
   - takes quota through a guarded update;
   - locks candidate nodes and atoms `FOR SHARE`;
   - inserts `EXCLUDE`d bookings;
   - updates counters;
   - moves `draft → placed`;
   - writes the allocation, `work_queue('nodespec')`, outbox, and an `audit_events` row with the admission context.

   A conflict replans ≤3 times inside the transaction (savepoints). After that the reservation goes to `pending` + `Unschedulable` and is retried every 30 s.
9. **Bind.** NodeSpec adds `deviceAssignments` and bumps `generation`. The daemon rejects overlaps; writes the CDI spec `/etc/cdi/bcd-<alloc>.json`, an env file and device ownership; and reports a node-signed `AllocationBound`. A 5 min timeout sends the reservation back to `pending`. `reservations.get` returns `binding: {nodeId, cdiDevices: ['bcd.dev/gpu=<uuid>', …], envFile}`. In v0.1 a `hold` is consumed by an operator-run workload manager on the node (Slurm, Kubernetes or containerd with CDI); tenant access paths arrive in v0.3.
10. **Active → end.** `active` opens a usage period, and `wait` returns. On `ends_at`, `release` or a lease lapse, the assignment is dropped, the GPU is reset and the bookings are truncated to `compute_now()`. Hourly windows go to the usage sink, keyed `cmp:<allocId>:<windowStart>` (§12.7).

IAM cost per admission: 2 lock acquisitions with a warm authentication cache, 3 on a miss, +1 with `budgetCheck:'meter'`.

### 3.5 Flow (c): bare metal from PXE to ready (v0.2)

0. **Site agents** enroll with `siteTokens.create({siteId, ttlSeconds, maxUses})`, which requires `compute:sites:manage` on `compute-site/{id}` and mints role-`site` tokens. The agent holding the site lease `site:<id>:boot` is the only proxyDHCP/iPXE server and discovery voucher (§8.5).
1. **Enroll.** Either `secrets.put({tenantId: root, value})` returns a `secret://…` ref, or `metal.enroll` takes inline credentials, stores them at once and never echoes them. The call is `metal.enroll({ tenantId: root, siteId, poolId, bmc:{address, driver:'redfish', credentials: 'secret://…' | {username, password}} })`, authorized as `compute:nodes:provision` on `compute-pool/{poolId}`, and moves the node to `enrolling`. BMC password rotation **(verify per vendor)**:
   1. the worker generates the new password, stores it as a new secret version and seals it to the site agent;
   2. the step applies it via Redfish, verifies a login with it, and returns only `{ok, version}`;
   3. the worker promotes the version only on `ok`.
2. **Inspect and boot.** The boot-lease holder probes Redfish `Systems/*` (→ `inspecting`), adds a proxy-DHCP entry and an HTTPS iPXE script carrying a single-use **discovery** credential bound to `productUuid` and the workflow, sets one-time PXE and power-cycles the machine. Every BMC step fetches its secret with `SecretRequest`, and the answer is a JWE to that request's ephemeral key (§6).
3. **Commission.** `bcd ramdisk` joins via the `discovery` attestor, vouched for by the site agent's MAC/IP assertion. It gets a 2 h cert limited to `inventory`, `diag.*`, `wipe`, `deploy.*` and `boot.kexec`. Commissioning runs inspect → `diag.dcgm{level:2}` → `wipe{quick}` → off → `ready`. Wipe and diag results are node-signed (`attested`), and the worker verifies them before moving to `ready`.
4. **Deploy.** `metal.deploy({ nodeId, profile })`:
   - streams the image (range reads from the site cache → zstd → disk, sha256 checked inline);
   - writes cloud-init with a single-use **`provisioned`** token;
   - sets boot-from-disk;
   - runs `boot.kexec`, which is self-terminating with `await:'rejoin'`. The fallback reset fires only on rejoin timeout.
5. **Rejoin.** The installed `bcd node` rejoins as the same `nodeId` with a new boot, a new journal and role `node`; the ramdisk cert is revoked. The rejoin completes the kexec step. Host config converges as desired state, and DCGM r1 moves the node to `deployed`. Exhausted retries → `failed(failedFrom)` with maintenance on and cleanup. Destructive kinds are signed (§13).

### 3.6 Flow (d): a VPS instance (v0.3)

`instances.create({ tenantId, poolId, flavor, imageId, sshKeys, idempotencyKey })` uses the same pre-check, draft and single decision on `compute-instance/{draftId}` (attributes `vcpu, memoryGiB, gpus, imageId, imageVerified, projectId`). Compute checks image visibility itself.
- **Hosted pool** (`class:'vps-host'`, `agent:'bcd'`). The placer claims vCPU (× overcommit), memory, disk and optionally a GPU atom for VFIO (never overcommitted). `NodeSpec.instances[]` gains the entry. The daemon caches the base qcow2, builds an overlay and a NoCloud seed, starts the VM and reports its IPs.
- **Provider pool** (`class:'provider'`, `agent:'none'`, adapter `provider-api/v1`). There is no `nodes` row. A workflow calls `ProviderImpl.create(…, {idempotencyKey: instanceId})` and polls `get`. State comes from `ProviderImpl.get`; capacity comes from `listOffers` plus account quotas. **No platform agent ever runs inside a tenant VM**, and no join token is placed in tenant-readable user-data.
- **Platform-owned provider machines** that become `vps-host` or `metal-host` nodes (Hetzner Robot servers, cloud VMs used as hypervisors) use `agent:'bcd'`. Either `ProviderImpl.bootstrap?(machine, {joinToken, bcdUrl, sha256})` delivers a single-use `provisioned` token through rescue/installimage, or bcd joins via `cloud-iid` (v0.3).

Later operations change only `desiredState`; the API never calls a runtime directly.

### 3.7 Flow (e): a sandbox (v0.5; D24)

A sandbox is a VPS instance with a template, a lifetime and a fast start, and it has no placement or tenancy path of its own. `sandboxes.create({ tenantId, templateId, ttlSeconds?, fromSnapshot?, wait?, idempotencyKey })` writes a `sandboxes` row plus the `instances` row it drives (`instances.sandbox_id`). Admission (§3.4, one decision on `compute-sandbox/{draftId}`), quota, IPAM, tunnels, IMDS, usage and the leak diff are therefore the instance's. Instance item methods on a sandbox's instance are refused (`INVALID_STATE`, "managed by sandbox …"); only `get` and `list` work.
- **Templates** (`sandbox_templates`, per tenant) hold:
  - `poolId`, `flavor`, `imageId` and `runtime`. The runtime is per pool today, so a template's `runtime` must equal its pool's (`policy.runtime` or the vps default). A microVM template therefore points at a `cloud-hypervisor` pool. Containers are allowed only on `singleTenant` pools, as for instances;
  - `userData`;
  - (with exec, step 6) `env` as `secret://` references, resolved by the secret broker for the sandbox's own tenant only;
  - (with exec, step 6) `network`: `egress` by default, or `none` or `private`;
  - `defaultTtl` and `maxTtl`;
  - `warm: {min, max}`.

  The template's pool must be offered to the tenant, and creating a template checks flavor and runtime against the pool once.
- **Lifetime.** `expires_at` is set when the row is created. `sandboxes.extend` moves it within `maxTtl` and the pool policy's bound, as reservation `extend` does. The `vps.sandboxes` reconciler deletes expired sandboxes through the instance lifecycle (`desiredState: 'deleted'`), so expiry is an ordinary delete: bookings refunded, overlay removed, IP released. `sandbox.expired` is emitted first.
- **Warm pools.** For each template with `warm.min > 0`, the reconciler keeps `min` instances created, booted and then `paused` (when the runtime's `RuntimeTraits.pause` is set, otherwise `stopped`), owned by the template's tenant. Warm instances are hidden from `instances.list`. `sandboxes.create` still takes its own admission decision. Only after an allow does it claim a warm instance in the same transaction: `FOR UPDATE SKIP LOCKED` on the oldest one, which changes owner, starts the TTL and sets `desiredState: 'running'`. On a miss it falls back to a cold create. Warm instances count against the tenant's quota when created, so a claim charges nothing new. They are metered as `vps.sandbox.warm` so operators can price idle capacity. Refills are rate-limited per template (at most 4 per reconciler pass).
- **Snapshots.** `sandboxes.snapshot` sends the host the `instance.snapshot` command, keyed `vps.sandboxes:<snapshotId>:snapshot` so the command's settlement wakes the reconciler. The runtime writes disk and memory state, and the daemon uploads it to a URL presigned by `vps({ snapshots: SnapshotStore })`. Without a store, `snapshot` is `INVALID_CONFIG`. Snapshots live in vps's own `sandbox_snapshots` table, not in provision's images: tenant-scoped, never promotable, with the upload's sha256. `create({ fromSnapshot })` restores (`InstanceSpec.restore_from`) on a host with the same runtime and `cpu.model` (an inventory label, used as a placement `nodeLabels` constraint), because memory state needs matching CPU features. Snapshots are tenant data that include memory: they are deleted with the sandbox unless `keep: true`, and another tenant's snapshot is `NOT_FOUND`.
- **Exec and files without an in-guest agent.** The §3.6 rule holds: no platform agent runs inside a tenant VM. `sandboxes.exec` returns a tunnel ticket (§7.6) and a short-lived SSH certificate. The certificate is signed by the tenant's sandbox CA, and templates trust that CA via `TrustedUserCAKeys` in the user data they render. The CLI's `sandbox exec <id> [-- cmd]` rides that SSH session through the tunnel with the user's OpenSSH client. SDK helpers (`sandbox.exec(cmd)`, `files.put`/`get`) come later: they need an SSH client in the SDK, which is a new dependency decision. That needs a daemon advertising `tunnel.instance-dial`: bcd must dial the instance's own address, never host loopback, and `tunnels.open` refuses instance `ssh`/`tcp` until the node's session advertises it. The serial console remains as the fallback.
- **Tenancy.** `vps().tenantDeleted` deletes the tenant's templates and sandboxes and sets every live instance to `desiredState: 'deleted'`. Until then, and while a tenant is suspended, the workload-token broker refuses its instances.
- **Runtime contract additions** (optional, additive):
  - `RuntimeDriver.pause?`, `resume?` and `snapshot?(instanceId, {uploadUrl})`;
  - `InstanceSpec.desiredState` gains `paused`;
  - `InstanceSpec.restoreFrom` (image reference + sha256);
  - the command kind `instance.snapshot`.

  A runtime without `pause` warms to `stopped`. A runtime without `snapshot` makes `sandboxes.snapshot` fail with `UNSUPPORTED`.
- **Events:** `sandbox.created`, `ready`, `expired`, `deleted`, and `sandbox.snapshot.ready`.

---

## 4. Repository & package layout

### 4.1 Tree

```
better-compute/
├─ package.json  pnpm-workspace.yaml  tsconfig.base.json (verbatim from better-iam)  tsconfig.json  vitest*.config.ts
├─ buf.yaml  buf.gen.yaml  proto/bettercompute/{common,agent,site,driver}/v1/*.proto  proto/baseline.binpb
├─ daemon/     Go: cmd/bcd; internal/{session,journal,converge,dispatch,inventory,health,nvml,cdi,runtime,site,ramdisk,
│              secrets,update,tunnel,fakehw,sim}; pkg/bcx (v0.5); gen/ (committed); .goreleaser.yaml
├─ packages/   core protocol inventory capacity provision metal vps server gateway postgres pki iam client cli mcp
│              testing better-compute | provider-hetzner provider-proxmox driver-sdk console-kit (not in umbrella)
├─ apps/{docs, console (v0.5)}   examples/{shared, dev, postgres, emulated-site}   hack/emulation/   docs/research/
├─ tests/      *.test.ts support/ sim/ realtime/ protocol/ e2e/ extensions/ tsconfig.{client,extensions}.json
├─ bench/      REFERENCE.md (reference hardware) gateway-streams iam-lane placements
├─ scripts/    tooling validate-packages pack check-packed-types packed-smoke release-version api-reference
│              check-deps check-sql-now umbrella sync-better-iam proto-gen authz-matrix  (.mjs)
├─ vendor/better-iam/{*.tgz, SOURCE.json}   .claude/coordination.md   .github/workflows/{ci,daemon,emulation,sim,release}.yml
```

The root is `better-compute-workspace`: private, ESM, Apache-2.0, `packageManager: pnpm@11.19.0`, `engines.node >=22.12.0`. Every package uses better-iam's `package.json` block [CONV §2]: `files`; exports with only `{types, import}`; `sideEffects:false`; `publishConfig.access public`; `repository.directory`; `tsc -b`; `workspace:*` mirrored in tsconfig `references`.

### 4.2 Package table

| Package | Responsibility | Depends on | Umbrella subpath | Runs where | Lands |
|---|---|---|---|---|---|
| `core` | browser-safe contracts: IDs, `ComputeError`, domain types, state tables; every `define*` helper except `defineStep`/`defineProfile` (provision) and `defineProvider` (vps); `manifest`, `ComputeModule`, `IamPort`, `SqlExecutor`, `Clock`, sinks; `./conformance` | — | `./core` | anywhere | P0 |
| `protocol` | buf-generated agent/site/driver v1; golden vectors | — (only `@bufbuild/protobuf`) | `./protocol` | anywhere | P0 |
| `inventory` | hashing, diffs, labels, `gpu-models.json`, health → conditions; `inventoryModule` (always-on built-in) | core, protocol | **`./inventory`** | control plane | P0 stub; v0.1 |
| `capacity` | atoms, bookings, quotas, rollups, `Placer`s, filters/scorers; `capacityModule` (always-on built-in) | core, inventory | `./capacity` | api, worker | v0.1 |
| `provision` | workflow engine, `defineStep`, `defineProfile`, config units, renderers, images; `provisionModule` | core, protocol, inventory | **`./provision`** | worker | P0 stub; v0.2 |
| `metal` | metal verbs, driver kinds `power…firmware`, driver composition; `metal()` | core, protocol, inventory, provision | **`./metal`** | worker | P0 stub; v0.2 |
| `vps` | instance lifecycle, flavors, `runtime` kind, `defineProvider`, IPAM; `vps()` | core, protocol, capacity, provision | **`./vps`** | api, worker | P0 stub; v0.3 |
| `pki` | CA signers (node client CA, gateway serving CA, internal CA), join/site tokens, attestor verifiers, proof-of-possession, JWE sealing, revocation; later signing keys, tickets, workload issuer | core | `./pki` | api, worker, cli | v0.1 |
| `server` | `betterCompute()`, `operation()` envelope, method → action registry, router, core groups, controller/queue/lease runtimes, module host, `JoinService`, secret broker, `selfCheck`. Imports and registers `inventoryModule` and `capacityModule` first. **Never imports provision, metal, vps, gateway, iam, postgres** | core, protocol, inventory, capacity, pki | `./server` | api, worker | P0 shell |
| `gateway` | `createGateway(compute, {tls})`: mTLS sessions, liveness, dispatch, forwarding of Join/Renew/Secret; tunnels (v0.3); WS (v0.4) | core, protocol, pki, server | `./gateway` | gateway | v0.1 |
| `postgres` | `postgres({url})` (PgBouncer-safe), Kysely dialect, migrations including `compute_now()`; `./pglite` (single connection, transactions serialized by an async mutex); `./conformance` | core; optional peer `@electric-sql/pglite` | `./postgres`, `./pglite` | control plane | P0 |
| `iam` | `createComputeIamBridge()` (catalog, plugin, resolver, `embedded()`, usage sink, inbox, flag cache); `./plugin` `computeIamHost()`; `./remote` (v0.4) | core; peers `@better-iam/{core,server,client}` | `./iam`, `./iam/plugin` | compute + IAM hosts | v0.1 |
| `client` | typed client | core | `./client` | anywhere | P0 |
| `cli` | CLI + `computeCommands(defineCommand)`; `dev`, `serve`, `sim`, `pki`, `daemon install-script`, `iam setup`, `doctor` | core, server, client, gateway, postgres, iam, pki; optional peers loaded by dynamic `import()` with a `MISSING_DEPENDENCY` hint: `testing`, `@electric-sql/pglite`, `@better-iam/{server,cli,adapter-sqlite}` | `./cli` + bin | operators | P0 |
| `mcp` | MCP tools + `gateTools()` | core, client; optional peer `@better-iam/mcp` | `./mcp` | agent hosts | v0.3 |
| `testing` | `computeFixture()`, simulator + `FakeDaemon`, sim clock, invariant checker, conformance runners | core, protocol, server, gateway, postgres, iam; optional peers `@better-iam/{server,adapter-sqlite}` (dynamic import) | `./testing` | tests | P0 |
| `better-compute` | umbrella (§4.4) | all of the above | — | — | P0 |
| `provider-*`, `driver-sdk`, `console-kit` | Hetzner/Proxmox providers; bcx `serveDriver`; React views | core, vps, metal / protocol / client | — install directly | worker / nodes / browser | v0.3–v0.5 |
| `daemon/` | `bcd` (Go) | committed Go gen | — release artifacts (§6) | servers, sites, ramdisk | P0 skeleton |

`inventory`, `provision`, `metal` and `vps` exist from P0 as **stubs**. They export frozen contract types and module-factory shells; calling an unimplemented factory throws `NOT_IMPLEMENTED` naming its phase. So all four named subpaths resolve from day one. The other packages are created when their phase starts. The root devDependencies include `@better-iam/adapter-sqlite` for tests.

### 4.3 Dependency graph and enforced rules

```
core ─┬─ protocol ─┬─ inventory ─┬─ capacity ─────┐
      │            │             │                ├─ built-in modules: imported and registered first by server
      │            ├─ provision ─┼─ metal         ┐
      │            │             └─ vps ◄─ capacity┴─ injected modules: never imported by server
      ├─ pki ──────┴──────── server ── gateway;  testing ← server, gateway, postgres, iam
      ├─ postgres (SqlExecutor)  ├─ iam (IamPort)  ├─ client ── mcp   └─ cli ← server, client, gateway, postgres, iam, pki
better-compute → all of the above;   provider-* → vps, metal;   driver-sdk → core, protocol
```

`scripts/check-deps.mjs` fails CI if:
- `server` depends on `provision`, `metal`, `vps`, `gateway`, `iam`, `postgres`, `provider-*` or `driver-*`;
- `core`'s root entry imports `node:*`;
- `dependencies` differ from tsconfig `references`;
- anything imports a `provider-*`.

`scripts/umbrella.mjs --check` fails CI on umbrella drift, and `scripts/check-sql-now.mjs` fails it on a bare `now()` in `packages/*/src` outside the migration that defines `compute_now()` (§8.4).

### 4.4 The central package `better-compute`, exactly

- `name: "better-compute"`, `bin: { "better-compute": "./dist/cli-bin.js" }`.
- Every umbrella package is a `workspace:*` dependency.
- Optional peers (`peerDependenciesMeta.optional`): the scoped `@better-iam/{core,server,client,cli,mcp,adapter-sqlite}` (not the `better-iam` umbrella) and `@electric-sql/pglite`.
- Exports are `{types, import}` only. Nested subpaths flatten (`./iam/plugin` → `dist/iam-plugin.js`) [CONV §3].
- `scripts/umbrella.mjs` generates `src/<subpath>.ts`, `exports`, `dependencies` and tsconfig `references` from `packages/better-compute/umbrella.json`. `pnpm check` runs it with `--check`.

| Subpath | File | Content |
|---|---|---|
| `.` | `src/index.ts` | curated from `server` + `core` only: `betterCompute`, `defineConfig`, `ComputeError`, `defineModule`, `definePlugin`, `defineDriver`, `defineSchedulerPlugin`, `defineAttestor`, `defineSink`, `manifest`, `field`, plus types |
| **`./inventory` `./provision` `./metal` `./vps`** | `<name>.ts` | `export * from '@better-compute/<name>';`. `provision` carries `defineStep`/`defineProfile`; `metal` carries its `DriverKinds` augmentation; `vps` carries `defineProvider` and the `runtime` augmentation. Stubs from P0 |
| `./core` `./protocol` `./capacity` `./server` `./gateway` `./pki` `./client` `./cli` `./mcp` `./testing` | one file each | one-line re-export |
| `./postgres` `./pglite` `./iam` `./iam/plugin` | `postgres.ts`, `pglite.ts`, `iam.ts`, `iam-plugin.ts` | one line each (`./iam/remote` added in v0.4) |
| bin | `cli-bin.ts` | `#!/usr/bin/env node` · `import { runBinary } from '@better-compute/cli'; runBinary();` |

Lazy loading comes from ESM subpath isolation plus dependency inversion, as in better-iam. `index.ts` loads only `server` and `core`. The app passes modules, store and IAM port in: `import { metal } from 'better-compute/metal'`, `import { postgres } from 'better-compute/postgres'`, `import { createComputeIamBridge } from 'better-compute/iam'`.

### 4.5 better-iam conventions: mirrored and deliberately not

**Mirrored** ([CONV] mirror checklist):
- pinned pnpm, Node ≥22.12, ESM-only, one synchronized version;
- the same scripts: `check`, `validate:packages`, `pack:all`, `check:packed-types`, `test:packed`, `test:postgres`, `bench:scale`, `docs:api`;
- root `tests/` against source aliases (subpaths first), fixtures, type-test tsconfigs, published conformance subpaths;
- `createApi(ctx)` + `api/<group>.ts`, `operation()`, `routeGroups`/`publicApiMethods`;
- the POST convention with `X-Better-Compute: 1`, the envelope, the 64 KiB cap, `X-Request-Id`;
- the Proxy client with credential stripping (`IsCredential` [CONV §8]);
- the `defineCommand` CLI: config discovery, 0600 profiles, `api GROUP.METHOD`, exit codes 0/2/1, `help --json`;
- append-only migrations; `selfCheck`/`doctor`; bounded metrics; CHANGELOG;
- CI on ubuntu+windows × Node 22/24, plus a Postgres job and packed smoke; `.claude/coordination.md`.

**Deliberately not mirrored:**
- **The generic records table and SQLite/libSQL adapters for compute's own store.** Compute needs `EXCLUDE`, `SKIP LOCKED` and `tstzrange`. Embedded better-iam in dev and tests still runs on better-iam's SQLite adapter.
- **The DB-wide advisory write lock.** Compute uses row and optimistic concurrency, plus table leases.
- **Host-run `setInterval` jobs.** Compute uses lease-coordinated `compute.start({roles})`, and `compute.jobs.*.tick()` in tests.
- **A monolithic server, and an umbrella that depends on everything.** Compute has domain packages; providers, drivers, console-kit and the daemon stay outside the umbrella.
- **Cookie issuance and `auth` special cases.** Compute takes bearer tokens and JWTs, and the IAM cookie only via `acceptIamCookie`.
- **Items on [CONV]'s "Things NOT to copy" list:** working without git, nvm paths in `launch.json`, boilerplate READMEs, and a duplicated `allowBuilds` list. Compute keeps one source in `scripts/tooling.mjs`, which feeds `pnpm-workspace.yaml` and packed smoke with `argon2` (via `@better-iam/auth`), `better-sqlite3` (via `@better-iam/adapter-sqlite`) and `esbuild`.
- **Packing inside a sibling tree.** `sync-better-iam` copies artifacts instead.

---

## 5. Extension model (Daytona-grade modularity)

### 5.1 Principles

- **Every seam is a typed contract with a published conformance suite** (`{name, run}` cases, like better-iam's `adapterConformanceCases()`). Modularity comes from contracts, not from a plugin loader [DAY §9].
- **Code registers kinds; data configures instances.** `defineProvider` is code. A `ProviderAccount` is a row validated by the provider's manifest (Daytona `TargetConfig` + `TargetConfigManifest` [DAY §8]).
- **Explicit registration** through options arrays. A duplicate `kind:id@version` is `INVALID_CONFIG`. So is any API method whose declared action is missing from the merged IAM catalog.
- **Placement by `runsOn`** (`control-plane | site | node | ramdisk`). From v0.2 the workflow engine routes each non-control-plane step as exactly one command. Location-transparent direct calls from TS driver code to a remote agent (`ctx.drivers.for(node).power.setPower()`) arrive in v0.5, only for `retrySafe` operations, so crash and idempotency semantics stay explicit.
- **Versioning.** Proto only adds fields (`buf breaking`). TS contracts add only optional members in minor versions. A breaking change gets a new interface selected by version (Daytona `RunnerAdapterV0/V2` [DAY §2]). `define*` stays experimental until v1.0.

### 5.2 Contract catalog

All contract types and `define*` helpers live in `core`, except `defineStep`/`defineProfile` (provision) and `defineProvider` (vps). The Package column says where the built-ins live.

| Contract | Package | Runs in | Built-ins (phase) |
|---|---|---|---|
| `ComputeModule` (groups, reconcilers, command kinds, migrations, catalog, NodeSpec sections, CLI, profiles) | core | control plane | `inventoryModule`, `capacityModule` (always-on, v0.1); `provisionModule`, `metal()` (v0.2); `vps()` (v0.3) |
| Driver kinds `power` … `firmware` | metal | site, ramdisk, control plane | redfish, ipmi (bmclib); ipxe, uefi-http; image-stream, kexec (v0.2) |
| `config` units / `runtime` | provision / vps | node | nvidia-driver, CDI, mig-layout, fabric-manager / libvirt-kvm, cloud-hypervisor (v0.3) |
| `ProviderDefinition`, `StepDefinition` | vps, provision | control plane / any | hetzner (v0.3), proxmox (v0.5); `power.*`, `boot.*`, `deploy.*`, `wait.*`, `diag.*` |
| `NodeAdapter` | core | control plane | `bcd/v1`, `provider-api/v1`, later `agentless-ssh/v1` |
| `SchedulerPlugin`, `Placer` | capacity | api, worker | filters (taints, selector, fits, topology), scorers (binpack, spread, topology, image-cached, fragmentation); inline, pool-lease |
| `NodeAttestor` | pki (+ Go producer) | api, daemon | join-token (v0.1); x509pop, provisioned, discovery (v0.2); cloud-iid (v0.3); tpm (v0.5) |
| `CertificateAuthority`, `SecretStore`, `BlobStore`, `ImageSource` | pki, core, provision | control plane, site | local-sealed, vault, kms; s3, local dir; https, oci |
| sinks, `Notifier`, `LeaseProvider`, `SqlExecutor`, `IamPort`, `Clock` | core | control plane | iam-usage, store-audit, webhooks; polling, nats; table leases; postgres, pglite; embedded, remote; db-anchored, sim |
| `DevicePlugin` | proto `driver/v1` | node (Go) | nvidia, fake |

### 5.3 Config manifests

```ts
import { manifest, field } from '@better-compute/core';
export const hetznerCloudConfig = manifest({
  token:    field.secret().describe('API token'),                              // SecretRef; masked; never returned
  location: field.option(['fsn1', 'nbg1', 'hel1', 'ash', 'hil']).default('fsn1'),
  network:  field.string().optional().suggest(async (ctx) => listNetworks(ctx)),   // live suggestions for CLI/console/MCP
  firewall: field.int().optional().disabledWhen({ location: ['ash', 'hil'] }),
  timeout:  field.duration().default('10m'),
});
export type HetznerCloudConfig = manifest.Infer<typeof hetznerCloudConfig>;
// ['~standard'] → Standard Schema v1 (zod/valibot accepted wherever a manifest is); .jsonSchema() → JSON Schema 2020-12 + "x-bc" hints
```

Field types cover Daytona's manifest options (`InputMasked`, `DisabledPredicate`, `DefaultValue`, `Suggestions`). Secrets are `SecretRef`s (`secret://…`, `vault://…`, `env://…`), resolved just in time. The JSON Schema form crosses languages and drives `drivers describe`, forms and MCP.

### 5.4 Contracts (sketches)

```ts
export type RunsOn = 'control-plane' | 'site' | 'node' | 'ramdisk';
export interface DriverKinds {}                                    // open via declaration merging
export function defineDriver<C, K extends keyof DriverKinds>(def: {
  id: string; version: string; runsOn: RunsOn; config: Manifest<C>; capabilities?: readonly string[];
  implements: { [P in K]: (config: C, ctx: DriverContext) => DriverKinds[P] | Promise<DriverKinds[P]> };  // several kinds = Ironic hardware type
  retrySafe?: Partial<Record<K, readonly string[]>>; validate?(config: C, ctx: DriverContext): Promise<void>;
}): DriverDefinition<C, K>;
declare module '@better-compute/core' { interface DriverKinds {        // augmented by metal (vps adds `runtime` the same way)
  power:      { getPower(): Promise<'on' | 'off' | 'unknown'>; setPower(a: PowerAction): Promise<void> };
  management: { setBootDevice(d: 'pxe' | 'http' | 'disk' | 'cd', o: { persistent: boolean; uefi: boolean }): Promise<void> };
  boot:       { prepareRamdisk(r: RamdiskSpec): Promise<void>; prepareInstance(i: InstanceBoot): Promise<void>; cleanUp(): Promise<void> };
  deploy:     { deploy(s: DeploySpec): AsyncIterable<Progress>; tearDown(o: { wipe: WipeMode }): AsyncIterable<Progress> };
  inspect:    { inspect(): Promise<NodeInventory> };  'virtual-media': { insert(iso: string): Promise<void>; eject(): Promise<void> };
} }
export interface ProviderImpl {                                      // from defineProvider({ id, version, provides, config, capabilities, create })
  listOffers(q: OfferQuery): Promise<Offer[]>;                       // SkyPilot-style catalog
  create(r: { offerId: string; image: ImageRef; userData: string; name: string }, ctx: CallContext /* idempotencyKey */): Promise<ExternalMachine>;
  get(id: string, ctx: CallContext): Promise<ExternalMachine | undefined>;
  delete(id: string, ctx: CallContext): Promise<void>;              // NOT_FOUND ⇒ success
  bootstrap?(m: ExternalMachine, b: { joinToken: string; bcdUrl: string; sha256: string }, ctx: CallContext): Promise<void>;  // agent:'bcd' pools only; never via tenant-readable user-data
  power?(…): Promise<void>; rescue?(…): Promise<RescueAccess>; reinstall?(…): Promise<void>; list?(…): AsyncIterable<ExternalMachine>;
}
export interface NodeAdapter { id: string; supports(n: NodeRecord): boolean;          // Daytona RunnerAdapter
  send(n: NodeRecord, cmd: CommandEnvelope, tx: Tx): Promise<void>; openTunnel?(n: NodeRecord, t: TunnelTarget): Promise<DuplexStream> }
export interface SchedulerPlugin { id: string; admit?(req: PlacementRequest, ctx: AdmissionContext): Promise<void>;
  filters?: { id: string; filter(req: PlacementRequest, n: NodeView): true | { reason: string } }[];
  scorers?: { id: string; weight?: number; score(req: PlacementRequest, n: NodeView): number }[];
  preferAllocation?: { class: string; pick(req: DeviceRequest, free: Atom[], n: NodeView): Atom[] | undefined }[] }
export interface ComputeModule<Name extends string = string, A extends ApiGroups = {}> {
  name: Name; requires?: string[]; migrations?: Migration[];        // ledger '<name>/0001_…'; plugin tables 'plg_<id>_*'
  extensions?: Extension[];                                         // drivers, steps, scheduler plugins, attestors, sinks
  api?(ctx: ModuleContext): A;                                      // each method declares { action, resource(input) } (§9.2)
  reconcilers?: { name: string; shardBy: 'node' | 'pool' | 'none'; run(ctx: ReconcileCtx, key: string): Promise<'DONE' | 'SYNC_AGAIN'> }[];
  commandKinds?: { kind: string; lane: Lane; retrySafe: boolean; selfTerminating?: boolean; attested?: boolean;
                   destructive?: boolean; timeout: Duration; roles: AgentRole[]; payload: DescMessage }[];
  nodeSpec?(ctx: ModuleContext, n: NodeRecord): Promise<Partial<NodeSpec>>;
  catalog?: { actions?: string[]; resourceTypes?: Record<string, ComputeResourceType> };   // merged into the IAM plugin
  commands?: CommandSpec[]; profiles?: ProfileDocument[]; selfCheck?(ctx: ModuleContext): Promise<Finding[]>;
}
export const defineModule = <const N extends string, A extends ApiGroups>(m: ComputeModule<N, A>) => m;   // definePlugin adds { id }
```

Daemon-side drivers (built into `bcd` or bcx) advertise `DriverManifest{id, version, kinds[], runsOn, configSchema}` in `Hello.drivers`. They are merged as remote drivers scoped to those agents, so `ipmi` or `libvirt-kvm` need no TS package. Per-node bindings (`node.drivers = { power:{driver:'redfish', config}, boot:'ipxe' }`) inherit from the pool's `hardwareProfile` and are validated against the registry.

Steps are declared as `defineStep({ id, runsOn, timeout, retries, retrySafe, await?: 'rejoin', input: manifest(…), command:'driver.invoke' | run(input, ctx), cleanup })`. Plugins mount under `plugins/{id}` with actions `compute:<plugin-id>:*`.

`ModuleContext` exposes `sql`, `clock`, `leases`, `iam`, `registry`, `commands`, `desired`, `workflows`, `capacity`, `inventory`, `events`, `usage`, `secrets` and `pki`. `capacity` and `inventory` are backed by the built-in modules. Modules never import each other's internals; for example, `vps` books host capacity through `ctx.capacity.reserve`.

```ts
const compute = betterCompute({ modules: [metal({ hardwareProfiles }), vps({ runtimes: ['libvirt-kvm'] })], plugins: [acmeAutoinstall()],
  providers: [hetznerCloud, hetznerRobot], attestors: [joinToken(), x509pop(), provisioned(), discovery()],
  scheduler: { plugins: [rackSpread()], weights: { binpack: 1, topology: 3 }, topN: 5 },
  external: [externalDriver({ command: ['/opt/bc/plugins/acme-bmc'], sha256: '…' })],   // bcx, v0.5
  sinks: { usage: [bridge.usageSink()], events: [webhooks()] }, /* database, iam, pki, clock … §8.2 */ });
```

### 5.5 Out-of-process drivers: bcx (v0.5)

One protocol, `bettercompute.driver.v1.DriverPlugin`, serves both `bcd` and the control plane (`externalDriver`, `remoteDriver`). It has `Describe`, `Validate`, streaming `Invoke`, duplex `Stream` and `Health`.

The handshake is go-plugin style [PA §1]: the host execs the plugin with a magic cookie and a socket dir; the plugin prints `bcx|1|unix|<socket>|grpc|<cert>`; the host dials with auto-mTLS. `InvokeRequest` carries the driver id, kind, operation, config, args, per-call secrets (declared secret fields only), idempotency key, deadline and `traceparent`.

SDKs: Go `daemon/pkg/bcx.Serve`, and TS `@better-compute/driver-sdk` `serveDriver(def)`, which runs **the same `defineDriver` object** under Node or Bun. Plugins are sha256-pinned in `/etc/bcd/plugins.d/` and run under their own uid with seccomp and cgroup limits.

### 5.6 Acceptance walkthroughs (zero edits to `@better-compute/*`)

Tests live in `tests/extensions/`, starting in the noted phase:
1. **Ubuntu autoinstall via Redfish virtual media (v0.2).** A third-party package `@acme/bc-autoinstall` exports `definePlugin({ id:'acme-autoinstall', extensions:[renderAutoinstallIso], profiles:[ubuntuAutoinstall] })`.
   - `renderAutoinstallIso` is a control-plane `defineStep`.
   - The profile uses the built-in `virtual-media.insert` on the site agent and puts a single-use `provisioned` token in the autoinstall config, so `bcd` joins.

   Pass criteria: the IAM bridge picks up the plugin's actions (§12.1); `profiles validate` resolves every `use:`; a sushy-tools VM reaches `deployed`.
2. **VPS provider "acme-cloud" (v0.3).** `defineProvider(…)`, `providerConformance(acmeCloud, { recordReplay })`, a provider account and a `class:'provider'` pool with `agent:'none'`. Instances run through the generic provider steps.
3. **Talos (v0.3).** This is an `agent:'none'` metal profile. A new built-in `site.httpProxy` command kind lets a control-plane `wait.talosReady` step reach the Talos API through the site agent (P5 holds), and inventory comes from Redfish inspect. Such nodes are never `connected`, so they are never schedulable for holds; they serve `binding:'node'` from v0.5.
4. **Kata runtime in Go (v0.5).** A bcx `runtime` plugin listed in `plugins.d`, advertised in `Hello.drivers`, and selected by pools via `vps.runtimes`.

---

## 6. Daemon

**Language and build.** Go (see §0; evidence [PA §8]), for linux/amd64 and arm64 (Grace/GB200).
- go-nvml dlopens `libnvidia-ml` via cgo, so release builds run in Docker buildx or `zig cc`.
- On the Windows workstation, logic tests run natively with `-tags nonvml,fakehw`; full builds go through Docker or WSL2.
- go-nvml is believed to ship `pkg/nvml/mock` with a `dgxa100` mock **(verify P0)**. If it does, `fakehw` wraps it.
- Minimal `go.mod`, `govulncheck`, `-trimpath`, SBOM.

**Release artifacts (v0.1).** goreleaser produces `bcd_<ver>_linux_{amd64,arm64}.tar.gz` plus `.sha256` for people, and the **bare binaries** `bcd_<ver>_linux_{amd64,arm64}` for machines. An offline-signed release manifest (`@better-compute/pki` `signReleaseManifest`, SigningPurpose `release-manifest`, `better-compute release sign`) lists every artifact with platform, size and sha256. The `api` serves the bare binary at `GET {basePath}/downloads/bcd/{version}/{os}-{arch}` from `BlobStore` or a local directory. The install script bakes in the digests of a manifest verified against the release pins (`daemon install-script --release-manifest --release-pins`), and v0.4 self-update verifies the manifest itself (signatures/threshold → product → sequence ≥ floor → not expired → size + sha256).

| Mode | Where | Does | Cert role |
|---|---|---|---|
| `node` | every server | session, journal, inventory (sysfs, netlink, NVML), health (NVML events, kmsg XIDs, EDAC, SMART; from v0.2), NodeSpec convergence (CDI, MIG layout, host config, runtimes), commands, tunnels (v0.3), OTLP telemetry, self-update (v0.4) | `node`, 24 h |
| `site` | 1–2 per site; a `nodes` row with `role='site'` | DHCP **proxy**, TFTP + iPXE over HTTPS, discovery vouching (these three only while holding the site boot lease); range-capable image cache and BMC via bmclib (always) | `site`, 24 h |
| `ramdisk` | PXE initramfs | inspect, DCGM diag, wipe (`quick`, `secure-erase`, `crypto-erase`), image stream, `boot.kexec` | `ramdisk`, ≤2 h |
| `sim` | test hosts | N daemons on `fakehw` with real TLS/gRPC (§15) | test CA |
| `helper` (v0.4) | beside `node`, as root | typed ops on a SO_PEERCRED-checked socket (`runtime.*`, `gpu.reset`, `mig.apply`, `cdi.write`, `reboot`, `update.swap`); parsing never runs as root. Until v0.4, `node` runs as root under systemd hardening | — |

**Install (v0.1).** `better-compute daemon install-script --pool <id>` emits a POSIX sh script. It:
- reads the join token only from `BCD_JOIN_TOKEN` or stdin, never from argv or a URL;
- downloads the pinned version from the download route and verifies its sha256;
- installs `/usr/local/bin/bcd`, `bcd.service` (with the hardening below) and `/etc/bcd/config.toml` (mode 0600);
- runs `bcd join`.

`config.toml` holds only the gateway URL, the site, the gateway serving-CA SPKI pin, and the JoinService signing and encryption key pins. The token is consumed at join and never written to disk.

The pins alone cannot seal a token, so the install script also writes the JoinService encryption public key to `/etc/bcd/join-encryption.jwk` (0644, public). `bcd join` loads it and refuses to use it unless its SPKI hash equals `join_encryption_key_pin`. As a fallback (a missing or rotated file), `GET {basePath}/.well-known/better-compute` also serves `joinEncryptionJwk` and the join signing certificate; bcd accepts them only when they match the pins, so the fetch needs no trust in the transport.

**Internals.** Each lane has a fixed worker pool (`control:4, provision:2, bulk:1`) with per-resource mutexes, not Daytona's unbounded goroutine per job [DAY §2].

The converger runs sections `host · devices · instances · access · telemetry · daemon`, each an idempotent `plan(desired, observed)` + `apply`. `access` is empty in v0.1; from v0.3 it holds the SSH CA principals and the exec-ticket JWKS. `observedGeneration` advances only when every section has converged or failed terminally.

`node` mode opens no TCP listeners. A root-only unix socket serves `bcd status|doctor|support-bundle`.

**Journal** (bbolt, capped at 64 MiB / 10k events):
- `meta`: node id, `journal_id`, event seq, last epoch, applied generation.
- `commands`: id → `accepted | running{boot_id} | done` + result, with a 7-day TTL. **`accepted` is fsynced before any side effect.** Self-terminating kinds also fsync `running{boot_id}` immediately before the side effect.
- Unacked `events`: metric-like events are dropped oldest-first when full; results and transitions never are.
- The last full `spec` + hash + signature, enforced while offline.
- `certs`, and the exec-ticket `jti` set.

A lost journal (ramdisk reboot, reinstall, bbolt corruption) starts a new `journal_id`; the identity stays with the key. The server then fails in-flight non-retry-safe commands instead of replaying them (§7.2).

**Command semantics.**
- **Duplicate delivery:**
  - `done` → resend the stored result;
  - `running` → re-attach;
  - `accepted` but not running (after a crash) → re-execute if `retry_safe`, else report `FAILED{interrupted}` for the controller to decide. `wipe`, `deploy.*`, `firmware.*` and `gpu.reset` are not retry-safe.
- **Self-terminating kinds** (`node.reboot`, `boot.kexec`, `daemon.upgrade`): on restart, a `running` entry whose `boot_id` differs from the current boot reports `succeeded{rebooted:true}`. The server also completes these commands on rejoin (§7.2), so they are never replayed.
- **Checks before accepting**, in this order (the Go dispatcher and the TS `FakeDaemon` agree on it):
  1. `UNSUPPORTED` when the body names another node, or for an unknown or role-disallowed kind;
  2. `min_generation` > applied → request the spec, defer until `not_after`, then `STALE_GENERATION`;
  3. `EXPIRED` past `not_after` (using the server-time offset from `Welcome`). `not_after` is mandatory: a command
     without one is `EXPIRED`, so the control plane always sets it;
  4. `BUSY` without credits (the server re-queues the command, §7.4);
  5. `BAD_SIGNATURE` for unsigned destructive kinds (v0.2).

  Terminal rejections are journaled, so a duplicate delivery or a `Hello` resend returns the same answer; `BUSY` is
  not journaled.
- **Attested kinds** (`wipe`, `deploy.*`, `gpu.reset`, `firmware.*`, `diag.*`) and allocation reports (`AllocationBound`, `AllocationReleased`) are signed with the node key from v0.2. Workers verify them against `node_certs` before any state transition.

**Secrets.** Commands carry `secretRef`s, never values. The agent fetches each ref with `SecretRequest{ref, workflow_id, step_id | allocation_id, epk, node_sig}`, where `epk` is a fresh P-256 key and `node_sig` covers the whole request. The gateway forwards it to `api`, which:
- verifies `node_sig` against `node_certs`;
- checks that the agent's current step or allocation is bound to the ref;
- returns `SecretResponse{ref, jwe}`, a compact JWE (ECDH-ES+A256KW / A256GCM) to `epk`.

Plaintext never appears in a frame, so gateways see only ciphertext. Values live only in memory and are zeroed after use.

**Hardening and offline.**
- systemd sandboxing (`ProtectSystem=strict`, narrow write paths, `NoNewPrivileges`, per-mode capabilities).
- Keys live in the TPM if present, else in 0600 files, and are never exported.
- Per-role command allowlists; 1 MiB per command, 4 MiB per spec.
- Support bundles are scanned for `bcjt_`/`biam_` tokens [ID §2].
- Certs renew at ~60% of their lifetime via `Renew` with proof of possession (§7.7).
- Offline, the daemon enforces its last spec, journals events, and backs off 1 s → 60 s with full jitter. From v0.2, a cert that expired while offline re-joins via `x509pop` within 7 days unless revoked.

**Self-update (v0.4).** NodeSpec carries `daemon = {version, url, sha256, signature}`. The Rollout controller moves 1% → 10% → 50% → 100% within the pool's disruption budget, gated on reconnect and error rates.
- A/B slots with a `current` symlink: verify, write `upgrade.json{deadline: now+120s}`, swap, `exec`.
- No `Welcome` by the deadline → swap back.
- Crash loops trip `StartLimitBurst` → `OnFailure=bcd-rollback.service`.
- `daemon.upgrade` is self-terminating. Workloads are unaffected.

Before v0.4, upgrades rerun the install script.

## 7. Daemon ↔ control-plane protocol

### 7.1 Transport

**Connection.** The daemon dials `gw.<region>:443`, behind an L4 LB with TLS passthrough. mTLS terminates in the gateway (Node `http2.createSecureServer({requestCert:true})` + `@connectrpc/connect-node`; the daemon uses connect-go). One HTTP/2 connection carries `Session` and on-demand `Tunnel` streams (v0.3).

**Certificates.** Gateway serving certs come from a separate **gateway serving CA** via `better-compute pki issue-gateway --san gw.<region>`: 30-day certs, hot-reloaded. In dev, `initialize()` seeds a local CA. Daemons pin that CA's SPKI hash. The per-region **node CA signs client certificates only**.

**WebSocket fallback (v0.4, only once all commands and specs are signed).** Endpoint `wss://gw…/v1/session`, subprotocol `bc.agent.v1`, with identical length-prefixed frames. It is meant for networks whose TLS-inspecting proxy strips client certs. In WS mode the daemon:
- accepts only signed `Command`/`DesiredState` frames and JWE-sealed secrets;
- trusts the configured proxy CA for transport only;
- authenticates the gateway in-band: the gateway signs the daemon's nonce with a key that chains to the pinned serving CA;
- authenticates itself with a cert-bound proof JWT (±60 s, single-use `jti`, `x5c` chain, signed by the node key).

Frame metadata (kinds, sizes, timing) stays visible to the proxy. There is no long-poll or unary-sync path before v1.

**The Node gateway's stream capacity is the main unverified technology bet.** v0.1 gates it on reference hardware (`bench/REFERENCE.md`): one gateway process must hold ≥5,000 mTLS sessions at 10 s heartbeats for 30 min, with dispatch p99 <500 ms and RSS <2 GiB. If it fails, D20 (a Go gateway on the same proto) is taken before v0.2 starts.

### 7.2 Session lifecycle and fencing

```
TLS (mTLS) → nodeId + role from SAN · revocation set · handshake token bucket (200/s/process)
Hello  → one tx:
         UPDATE node_sessions SET gateway_id=$gw, session_id=$s, session_epoch=session_epoch+1, boot_id=$b, journal_id=$j,
                role=$role, connected_at=compute_now() WHERE node_id=$n RETURNING session_epoch, previous boot_id/journal_id/role
         1. boot_id or role changed → in-flight self-terminating commands → succeeded{rebooted:true}; enqueue owners
         2. journal_id changed (non-NULL before) → dispatched|acked|running commands with retry_safe=false
            → failed('journal-lost'); enqueue owners
       ◄ Welcome{epoch, heartbeat, lease_ttl, credits, acked_event_seq, request_sections, server_time, trust}
       ◄ DesiredState (if applied_generation < generation) + replay of the remaining non-terminal commands in seq order
       → unacked results + events > acked_event_seq      (server dedupes; Ack)
```

- **Epoch-fenced:** routing and liveness writes (`last_seen`, disconnect) carry `AND session_epoch = $myEpoch`. Dispatch locks the session row `FOR SHARE` (§8.5), so a dispatch mark and a `Hello` epoch bump serialize. A zombie gateway fails these writes and drops its streams. As a backstop, `Hello` replays every non-terminal row.
- **Not fenced:** results and events are facts and are accepted from any epoch. They are deduplicated by `command_id` while the command is non-terminal, and by `(node_id, journal_id, seq)`. Status reports set `observed_generation = GREATEST(observed_generation, $g)`. The daemon replays unacked results anyway.
- **Duplicate identity:** a second live `Hello` with another `boot_id` wins and raises `DuplicateIdentity`. More than 3 alternations in 10 min quarantine the cert.

### 7.3 Desired state vs commands

Desired state holds standing facts: assignments, instances, host config, `access`, telemetry, daemon version. Patches apply against `base_generation`; a mismatch triggers `SpecRequest` and a full spec.

Commands are one-shot: `node.reboot`, `diag.*`, `inventory.refresh`, `logs.collect` (to a presigned URL), `gpu.reset`, `driver.invoke`.

**Rule:** if losing it leaves the wrong steady state, it is desired state. If running it late could do harm, it is a command with `not_after`, plus `min_generation` when it presupposes a spec.

### 7.4 Delivery, idempotency, resume

| Mechanism | Rule |
|---|---|
| Identity | ULID `id`; `seq` from `nodes.next_cmd_seq` in the enqueue tx; `UNIQUE(node_id, idempotency_key)`; workflow steps use `wf:<id>:<stepId>` and bump `attempt` on retry |
| Kind registry | `lane`, `retry_safe`, `self_terminating`, `attested`, `destructive`, `timeout`, allowed agent roles; `CommandBody` carries `retry_safe` and `self_terminating` |
| States | `pending → dispatched(epoch) → acked → running → succeeded \| failed \| rejected`, plus `expired` and `cancelled`. `BUSY` → back to `pending` with `not_before = compute_now() + backoff` (1 s → 30 s). Only `UNSUPPORTED`, `BAD_SIGNATURE`, `EXPIRED` and `STALE_GENERATION` become `rejected` |
| Resume | `Hello` first applies the self-terminating and journal-lost rules (§7.2), then re-sends the remaining non-terminal commands in `seq` order not reported terminal (`Hello.unacked_results`, `running_command_ids`); the journal dedupes |
| Events | `seq` per `journal_id`; cumulative ack stored in `node_sessions.acked_event_seq`; dedupe on `(node_id, journal_id, seq)` |
| Sweeper | **CommandSweeper** (singleton): `pending` past `not_after` → `expired`; `dispatched\|acked\|running` past `not_after + kind.timeout` → `failed('timeout')` (for self-terminating kinds the timeout covers the rejoin window). Both transitions enqueue the owning controller via `work_queue` |
| Cancel | `Cancel{id}` stops between actions and never hides a completed side effect |
| Tracing | `traceparent` on commands and specs: api → worker → gateway → daemon → driver [DAY] |

### 7.5 Liveness and backpressure

**Heartbeats.** HTTP/2 PING every 20 s; `Heartbeat` every 10 s; lease TTL 40 s [PA §1]. Three misses close the session.

**No DB write per heartbeat.** Gateways keep `lastSeen` in memory and flush **ages** (not wall-clock timestamps, so gateway clock skew cannot fake liveness) every 15 s with HOT updates:

```sql
UPDATE node_sessions s SET last_seen = compute_now() - make_interval(secs => v.age_ms / 1000.0)
  FROM unnest($ids, $ages, $epochs) v(id, age_ms, ep) WHERE s.node_id = v.id AND s.session_epoch = v.ep
```

Each gateway renews its own lease every 5 s (TTL 20 s).

**Transitions only:**
- `connected → disconnected` when the session closes or the gateway lease expires;
- `→ unreachable` after 40 s + grace. This adds the `unreachable` reason to `no_schedule_reasons` and raises `NodeUnreachable`, and **releases nothing**;
- `→ lost` after the pool's `lostAfter`. This is **never automatic for metal**.

Grace (Nomad `failover_heartbeat_ttl` [PA §1]): 120 s after a gateway loss; 5 min after the DB or the Liveness controller was down for >20 s.

**Backpressure:**
- per-lane credits (control 8, provision 4, bulk 2), refreshed by heartbeats;
- commands stay `pending` in the DB until sent;
- HTTP/2 flow control; bulk payloads go by URL;
- status events coalesce latest-wins, results never do;
- a handshake token bucket and `maxStreams` bound admission;
- rolling deploys send `Drain{reconnect_after_ms = rand(0, 60s)}`.

### 7.6 Version skew and tunnels

- **Versioning:** `proto_min/max` + `capabilities[]`; additive fields only. Unknown kinds → `UNSUPPORTED`; unknown spec sections → `SectionUnsupported`. A daemon below `proto_min` gets `UPGRADE_REQUIRED` and only `daemon.upgrade` is accepted.
- **Skew:** N−1 minors before 1.0, **N−2** from v1.0. Kubernetes has allowed kubelets three minors behind since v1.28, so N−3 is a later option; we start stricter to keep the skew matrix small. Upgrade order: expand migrations → workers/api → gateways → daemons; contract migrations one release later.
- **Tunnels (v0.3):**
  - The API authorizes (`compute:instances:exec`, `compute:nodes:console`) and issues an exec ticket (ES256, 60 s, single-use `jti`, `aud=node:<id>`, `sid`, `op`).
  - It calls the owning gateway's internal `OpenTunnel` (Teleport proxy peering [PA §1]).
  - The daemon **re-verifies the ticket** against its pinned JWKS (from the `access` section) and its `jti` set before opening the `Tunnel` stream.
  - Callers are re-authenticated every 60 s and on inbox revocation events. Hard max 12 h. IAM unreachable for >2 min closes interactive streams.

### 7.7 Message sketch (`proto/bettercompute/agent/v1/session.proto`)

```proto
service AgentGateway {
  rpc Join(JoinRequest) returns (JoinResponse);                  // server-auth TLS (serving CA pinned); forwarded to api JoinService
  rpc Renew(RenewRequest) returns (RenewResponse);               // mTLS; ~60% of lifetime; verified by api JoinService, not the gateway
  rpc Session(stream AgentFrame) returns (stream ServerFrame);   // mTLS; one live session per node
  rpc Tunnel(stream TunnelFrame) returns (stream TunnelFrame);   // v0.3
}
message JoinRequest  { bytes sealed_token = 1; /* JWE to the pinned JoinService encryption key */ bytes csr = 2; HardwareClaims claims = 3; }
message JoinResponse { bytes body = 1; /* node_id, cert chain, command-signing trust bundle */ Signature sig = 2; /* pinned join-signing key */ }
message RenewRequest { bytes csr = 1; repeated bytes chain = 2; google.protobuf.Timestamp client_time = 3;
  bytes pop_sig = 4; }  // current node key over sha256(csr) ‖ node_id ‖ client_time; accepted within ±60 s; 120 s replay cache
message AgentFrame  { oneof msg { Hello hello = 1; Heartbeat heartbeat = 2; CommandUpdate update = 3; EventBatch events = 4;
  StatusReport status = 5; InventorySection inventory = 6; SpecRequest spec_request = 7; SecretRequest secret_request = 8; } }
message ServerFrame { oneof msg { Welcome welcome = 1; Command command = 2; Cancel cancel = 3; DesiredState desired = 4;
  Ack ack = 5; OpenTunnel open_tunnel = 6; Drain drain = 7; RevocationNotice revoked = 8; SecretResponse secret = 9; } }
message Hello { string node_id = 1; string boot_id = 2; string journal_id = 3; Role role = 4; string daemon_version = 5;
  uint32 proto_min = 6; uint32 proto_max = 7; repeated string capabilities = 8; repeated DriverManifest drivers = 9;
  uint64 last_epoch = 10; uint64 applied_generation = 11; repeated CommandUpdate unacked_results = 12;
  repeated string running_command_ids = 13; uint64 last_event_seq = 14; map<string, bytes> inventory_hashes = 15; }
message Command     { bytes body = 1; Signature signature = 2; uint32 attempt = 3; }   // signature required for destructive kinds from v0.2
message CommandBody { string id = 1; string node_id = 2; uint64 seq = 3; string kind = 4; google.protobuf.Any payload = 5; Lane lane = 6;
  google.protobuf.Timestamp not_after = 7; uint64 min_generation = 8; bool retry_safe = 9; string idempotency_key = 10;
  string traceparent = 11; bool self_terminating = 12; bool attested = 13; }
message CommandUpdate { string command_id = 1; CommandState state = 2; bytes result = 3; string boot_id = 4;
  Signature node_sig = 5; }  // attested kinds (v0.2): node key over command_id ‖ state ‖ sha256(result)
message AttestedReport { bytes body = 1; /* AllocationBound | AllocationReleased */ Signature node_sig = 2; }   // inside EventBatch
message SecretRequest  { string ref = 1; string workflow_id = 2; string step_id = 3; string allocation_id = 4; bytes epk = 5; Signature node_sig = 6; }
message SecretResponse { string ref = 1; string jwe = 2; }       // compact JWE, ECDH-ES+A256KW / A256GCM to epk
message DesiredState { bytes body = 1; /* generation, base_generation, spec_hash, full | patch */ Signature signature = 2; }
message Signature   { string kid = 1; bytes sig = 2; repeated bytes chain = 3; }       // ES256 over body bytes
```

The signed envelopes (`Command.signature`, `DesiredState.signature`, `node_sig`) exist from v0.1 with signatures optional, so enabling them in v0.2 is additive. The node key signs only "this node says" statements: mTLS handshakes, CSR proofs of possession, attested results and secret requests.

### 7.8 Failure-mode matrix

| Failure | Behaviour | Invariant kept |
|---|---|---|
| Gateway crash | jittered reconnect elsewhere, epoch+1, replay, 120 s grace | no double execution; no false unreachable |
| Gateway ↔ DB partition (zombie) | lease renewal fails → self-fence after TTL/2; stale routing and dispatch writes fail on epoch or block on the session row | one router per node |
| Compromised gateway | can delay, drop or read frames; cannot mint certs (Renew needs PoP, verified by `api`), harvest join tokens or secrets (JWE), forge attested results (`node_sig`) or forge intent (signed commands/specs) | P14 |
| Daemon isolated / half-open TCP | disconnected → unreachable; workloads keep running; the next session supersedes by epoch | P6 |
| Journal lost (ramdisk reboot, reinstall, corruption) | new `journal_id` → in-flight non-retry-safe commands fail `journal-lost`; controllers re-decide | I2 |
| Self-terminating command (reboot, kexec, upgrade) | completed on rejoin by `boot_id`/role change; never replayed | I2 |
| No credits (`BUSY`) | back to `pending` with backoff | nothing dropped |
| DB failover (~30 s) | gateways buffer liveness and results; commands pause; 5 min grace | no mass unreachable |
| Reconnect storm (10k) | token bucket, jitter, hash-only `Hello`; 99% back in <60 s on 3 gateways | bounded load |
| Stale command after an outage | swept to `expired`, or rejected on `not_after`/`min_generation` | no stale side effects |

## 8. Control plane

### 8.1 Process modes

| Mode | Role | Scales by |
|---|---|---|
| `api` | stateless authN/Z, drafts, admission tx (v0.1 inline placement), outbox; `JoinService` and the secret broker on an internal mTLS port; downloads; tunnels to gateways | requests |
| `gateway` | sessions in memory, liveness, dispatch, result and event ingestion, forwarding of Join/Renew/Secret, tunnels | streams (≥3 per region) |
| `worker` | roles: `controllers` (reconcilers, workflows, CommandSweeper, SiteBoot, GC, rollups); `scheduler` (v0.4); `sinks` (outbox, usage, webhooks); `iam` (IamInbox, IamReconcile, flag cache feed). When compute's processes are the IAM host family (§12.1), `iam` also runs better-iam's jobs under a singleton lease: `iam.dispatchAuditHooks()`, `iam.auth.dispatchOutbox()`, `iam.billing.checkBudgets`, `iam.billing.closePeriod`, `iam.sweepExpired` | 256 shards over K processes |
| `all` | dev: `better-compute dev` runs PGlite (one connection, transactions serialized behind an async mutex), embedded IAM on better-iam's SQLite adapter, a local CA and optionally `--sim N`. Dev asserts that no `IamPort` call is awaited inside a compute transaction | — |

In v0.1 one worker holds all 256 shard leases. The lease, epoch and `work_queue` schema is final from day one, so v0.4 only adds rebalancing.

### 8.2 Factory sketch

```ts
export interface ComputeOptions<M extends readonly ComputeModule[] = [], P extends readonly ComputeModule[] = []> {
  database: SqlExecutor; secret: string; baseURL: string; basePath?: string; iam: IamPort; modules?: M; plugins?: P;
  drivers?: DriverDefinition[]; providers?: ProviderDefinition[]; scheduler?: SchedulerOptions; attestors?: AttestorVerifier[];
  pki?: { nodeCa?: CertificateAuthority; servingCa?: CertificateAuthority; internalCa?: CertificateAuthority };
  secrets?: SecretStore[]; notifier?: Notifier; sinks?: SinkOptions; downloads?: { dir?: string; blob?: BlobStore };
  gateway?: { url?: string; serverName?: string; publicUrls?: Record<string, string>; maxStreams?: number };  // url → well-known gateway (bcd join --server)
  clock?: Clock;                    // default: db-anchored (§8.4); tests pass the sim clock
  acceptIamCookie?: boolean;        // same-origin IAM cookie (console); default false
}
export function betterCompute<const M extends readonly ComputeModule[], const P extends readonly ComputeModule[]>(o: ComputeOptions<M, P>): {
  api: CoreApi & ModuleApis<M> & { plugins: PluginApis<P> };        // CoreApi includes the inventory + capacity groups; drives client inference
  handler(req: Request): Promise<Response>; nodeHandler(req: IncomingMessage, res: ServerResponse): Promise<void>;
  gatewayServices: GatewayServices;                                 // consumed by createGateway (dependency inversion)
  initialize(): Promise<void>;       // migrations (core + built-ins + modules + plugins), CA seed, IAM binding, method → action catalog check
  start(o?: { roles?: WorkerRole[] }): Promise<void>; stop(): Promise<void>;
  jobs: Record<string, { tick(): Promise<number> }>;                // deterministic stepping in tests
  registry: Registry; authz: AuthzProjection; selfCheck(): Promise<SelfCheckReport>;
};
```

`betterCompute()` is synchronous and side-effect-free, like `betterIam()`. Host it with `app.all('/api/compute/*', (c) => compute.handler(c.req.raw))`, or run `better-compute serve --mode=…` with `better-compute.config.ts` (`defineConfig(({ env }) => ({ … }))`).

### 8.3 Storage schema (key tables)

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;   -- ledger: compute_migrations(name PK, applied_at)
CREATE FUNCTION compute_now() RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT now() $$;
  -- computeFixture({ clock: 'sim' }) replaces the body with: SELECT ts FROM compute_sim_clock WHERE id = 1
CREATE TABLE compute_sim_clock (id int PRIMARY KEY CHECK (id = 1), ts timestamptz NOT NULL);           -- tests only
CREATE TABLE sites (id text PRIMARY KEY, owner_tenant_id text NOT NULL, kind text NOT NULL CHECK (kind IN ('shared','dedicated','custom')),
  region text NOT NULL, iam_region text, version bigint NOT NULL);
CREATE TABLE pools (id text PRIMARY KEY, owner_tenant_id text NOT NULL, site_id text NOT NULL REFERENCES sites, class text NOT NULL,
  gpu_model text, sharing text NOT NULL, agent text NOT NULL CHECK (agent IN ('bcd','none')), policy jsonb NOT NULL, version bigint NOT NULL);
CREATE TABLE pool_offers (pool_id text REFERENCES pools, tenant_id text, include_descendants bool NOT NULL DEFAULT false,
  PRIMARY KEY (pool_id, tenant_id));
CREATE TABLE projects (id text PRIMARY KEY, tenant_id text NOT NULL, name text NOT NULL, state text NOT NULL, version bigint NOT NULL,
  UNIQUE (tenant_id, name));
CREATE TABLE nodes (id text PRIMARY KEY, site_id text NOT NULL REFERENCES sites, pool_id text REFERENCES pools, owner_tenant_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('unassigned','host','dedicated','site')), provision_state text NOT NULL,
  maintenance bool NOT NULL, cordoned bool NOT NULL, connectivity text NOT NULL,
  trust text NOT NULL CHECK (trust IN ('platform','tenant-owned','tenant-controlled')),
  no_schedule_reasons text[] NOT NULL DEFAULT '{}',        -- NoSchedule taints + conditions; written by Health, Liveness, nodes.taint
  hardware_key bytea, hardware_key_trusted bool NOT NULL DEFAULT false, spec jsonb, generation bigint NOT NULL,
  observed_generation bigint NOT NULL, next_cmd_seq bigint NOT NULL, identity_gen int NOT NULL, shard smallint NOT NULL,
  version bigint NOT NULL, CHECK (role <> 'site' OR pool_id IS NULL));
CREATE UNIQUE INDEX nodes_hardware_key ON nodes (hardware_key) WHERE hardware_key_trusted;
CREATE TABLE node_labels (node_id text REFERENCES nodes, key text, value text NOT NULL, source text NOT NULL, PRIMARY KEY (node_id, key));
CREATE TABLE node_conditions (node_id text REFERENCES nodes, type text, status text NOT NULL, reason text,
  since timestamptz NOT NULL, PRIMARY KEY (node_id, type));
CREATE TABLE node_sessions (node_id text PRIMARY KEY REFERENCES nodes, gateway_id text, session_id text, session_epoch bigint NOT NULL,
  boot_id text, journal_id text, role text, acked_event_seq bigint NOT NULL DEFAULT 0, last_seen timestamptz,
  connected_at timestamptz, disconnected_at timestamptz);                    -- JoinService inserts (node_id, session_epoch=0)
CREATE TABLE devices (id text PRIMARY KEY, node_id text NOT NULL REFERENCES nodes, parent_id text REFERENCES devices,
  class text NOT NULL, bookable bool NOT NULL, healthy bool NOT NULL, attributes jsonb NOT NULL);   -- gpuProduct, gpuModel, …
CREATE TABLE device_bookings (device_id text NOT NULL REFERENCES devices, allocation_id text NOT NULL,
  during tstzrange NOT NULL CHECK (NOT isempty(during)), EXCLUDE USING gist (device_id WITH =, during WITH &&));
CREATE TABLE node_resources (node_id text, resource text, allocatable bigint NOT NULL, ratio numeric NOT NULL, allocated bigint NOT NULL,
  PRIMARY KEY (node_id, resource), CHECK (allocated BETWEEN 0 AND floor(allocatable * ratio)));
CREATE TABLE quota_usage (tenant_id text, pool_id text, resource text, max bigint NOT NULL, used bigint NOT NULL,
  PRIMARY KEY (tenant_id, pool_id, resource), CHECK (used BETWEEN 0 AND max));        -- rows created by pools.offer
CREATE TABLE reservations (id text PRIMARY KEY, tenant_id text NOT NULL, pool_id text NOT NULL, project_id text, state text NOT NULL,
  request jsonb NOT NULL, request_hash bytea NOT NULL, during tstzrange, owner_identity_id text NOT NULL, agent_id text,
  delegation_id text, idempotency_key text NOT NULL, version bigint NOT NULL,
  UNIQUE (tenant_id, owner_identity_id, idempotency_key));                              -- instances: the same UNIQUE
CREATE TABLE commands (id text PRIMARY KEY, node_id text NOT NULL, seq bigint NOT NULL, kind text NOT NULL, body bytea NOT NULL,
  signature bytea, state text NOT NULL, reason text, session_epoch bigint, not_before timestamptz NOT NULL DEFAULT compute_now(),
  not_after timestamptz NOT NULL, min_generation bigint, retry_safe bool NOT NULL, self_terminating bool NOT NULL,
  attested bool NOT NULL, idempotency_key text NOT NULL, UNIQUE (node_id, seq), UNIQUE (node_id, idempotency_key));
CREATE TABLE work_queue (kind text, key text, shard smallint NOT NULL, gen bigint NOT NULL, not_before timestamptz NOT NULL,
  claimed_until timestamptz, PRIMARY KEY (kind, key));
CREATE TABLE leases (name text PRIMARY KEY, owner text, epoch bigint NOT NULL, expires_at timestamptz NOT NULL);
  -- names: shard:<n>, pool:<id>, site:<id>:boot, singleton:<job>, gateway:<id>
CREATE TABLE workers (id text PRIMARY KEY, started_at timestamptz NOT NULL, heartbeat_at timestamptz NOT NULL);   -- rendezvous hashing
CREATE TABLE outbox (seq bigserial PRIMARY KEY, txid xid8 NOT NULL DEFAULT pg_current_xact_id(), topic text NOT NULL, payload jsonb);
CREATE TABLE authz_projection (type text, id text, tenant_id text, attributes jsonb NOT NULL, parent_type text, parent_id text,
  owner_id text, pending jsonb, PRIMARY KEY (type, id, tenant_id));   -- change feed authz_changes has the outbox (txid, seq) shape
CREATE TABLE iam_inbox (event_id text PRIMARY KEY, tenant_id text NOT NULL, sequence bigint NOT NULL, occurred_at timestamptz NOT NULL,
  action text NOT NULL, body jsonb NOT NULL, received_at timestamptz NOT NULL, processed_at timestamptz);
CREATE INDEX iam_inbox_pending ON iam_inbox (tenant_id, sequence) WHERE processed_at IS NULL;
CREATE TABLE join_tokens (id text PRIMARY KEY, tenant_id text NOT NULL, role text NOT NULL CHECK (role IN ('node','site','provisioned','discovery')),
  pool_id text, site_id text, secret_hash bytea NOT NULL, uses_left int NOT NULL, expect jsonb, allow_reclaim bool NOT NULL,
  expires_at timestamptz NOT NULL, revoked_at timestamptz);
-- also: gateways, allocations, instances, usage_windows, usage_dead_letters, node_certs, join_requests (v0.2), inventory_snapshots,
-- workflows, workflow_steps, images, image_locations, profiles, provider_accounts, sealed_secrets, pool_capacity_rollup, webhooks, audit_events
```

- **Tenant scoping:** tenant-scoped repository functions take `tenantId` as a required parameter; there is no ambient tenant.
- **Optimistic concurrency:** aggregates carry `version`. Transitions are `UPDATE … WHERE id=$id AND version=$v` (0 rows ⇒ `CONFLICT`), with legality taken from `core`'s state tables.
- **Queries and history:** queries are Kysely, typed per module. History tables are partitioned.
- **Sharding:** `nodes.shard = fnv1a(id) % 256`.
- **`hardware_key`** = sha256(normalized `product_uuid` ‖ `serial` ‖ sorted permanent MACs ‖ sorted GPU UUIDs), after dropping values on a shipped placeholder blocklist ("To Be Filled By O.E.M.", all-zero or duplicated UUIDs). The key is *trusted* only when ≥2 independent identifiers survive **(verify against lab hardware)**.

### 8.4 Clock, work queue, outbox, reconcilers

- **One clock (P9).** All compute SQL uses `compute_now()`, never `now()`; `scripts/check-sql-now.mjs` fails CI on a bare `now()` in `packages/*/src`, except in the one migration that defines `compute_now()`. TS business time comes from the `Clock` port:
  - In production it is anchored to `compute_now()`: it samples the offset at each lease renewal and raises a `ClockSkew` condition when a process drifts by >1 s.
  - The sim clock advances `compute_sim_clock` on every tick, so leases, `not_before`, `not_after` and liveness all expire in simulated time.
- **Work queue.** Enqueue in the state-change tx with `ON CONFLICT (kind,key) DO UPDATE SET gen = work_queue.gen + 1, not_before = LEAST(…)`. Claim with `… shard = ANY($mine) AND not_before <= compute_now() AND (claimed_until IS NULL OR claimed_until < compute_now()) … FOR UPDATE SKIP LOCKED`, then set `claimed_until`. Success deletes `WHERE … AND gen = $claimedGen`, so a key re-dirtied mid-processing survives and **no wake-up is lost**. Controllers also re-enqueue everything they own every 5–10 min (level trigger).
- **Outbox.** Commit order ≠ `seq` order, so readers take `WHERE txid < pg_snapshot_xmin(pg_current_snapshot()) AND (txid, seq) > ($cTx, $cSeq) ORDER BY txid, seq`, and nothing can appear behind the cursor. The same cursor serves SSE `Last-Event-ID` and `authz_changes`. One lease per sink; at-least-once.
- **Reconcilers** return `DONE | SYNC_AGAIN` [DAY §3].
  - Sharded: NodeLifecycle, NodeSpec (bumps `generation` only when the spec hash changes), Liveness, Inventory/Health (maintains `no_schedule_reasons`), Allocation, Drain, Workflow, Instance, BookingRepair.
  - Singletons: CommandSweeper, SiteBoot, Usage, IamInbox, IamReconcile, OutboxDispatch, Rollup, Rollout, CertRotation, GC.

### 8.5 Sharding, leases, command routing

```sql
UPDATE leases SET owner=$me, epoch = CASE WHEN owner=$me THEN epoch ELSE epoch+1 END,
       expires_at = compute_now() + make_interval(secs => $ttl)          -- 15 s shard/pool/site leases, 20 s gateway leases
 WHERE name=$name AND (owner=$me OR expires_at < compute_now()) RETURNING epoch;                     -- renew every 5 s
SELECT 1 FROM leases WHERE name=$name AND owner=$me AND epoch=$e AND expires_at > compute_now() FOR SHARE;   -- first stmt of each fenced tx
```

A zombie either sees its lease as valid or aborts, and a takeover blocks until the zombie's `FOR SHARE` tx ends (a bare `EXISTS` is not a fence under READ COMMITTED). Rendezvous hashing over the `workers` table spreads the 256 shards across K workers. We use table leases rather than advisory locks: session-level `pg_advisory_lock` breaks under PgBouncer transaction pooling, and tables give TTL and epoch fencing.

**Command routing.** Enqueue inserts `commands(state='pending')` with `seq = next_cmd_seq++` and pokes `gw:<id>` after commit (best effort). Each gateway dispatches on a poke or every 1 s:

```sql
SELECT c.*, s.session_epoch FROM commands c JOIN node_sessions s USING (node_id)
 WHERE s.gateway_id = $me AND c.state = 'pending' AND c.not_before <= compute_now() AND c.not_after > compute_now()
 ORDER BY c.node_id, c.seq LIMIT 1000
 FOR UPDATE OF c SKIP LOCKED FOR SHARE OF s;       -- the session row lock serializes with Hello's epoch bump
```

The gateway marks a row `dispatched, session_epoch = s.session_epoch` only when that epoch equals its in-memory epoch for the node and the command is sent within credits. **Routing is a join at dispatch time, never a copied column.** A reconnect therefore needs no rewrite, and an enqueue racing a reconnect cannot strand a command.

**Site routing.** The SiteBoot controller assigns `site:<id>:boot` (15 s TTL) to exactly one connected site agent (`owner = nodeId`, epoch+1) and publishes `site.boot = {active, epoch}` in that agent's NodeSpec.
- An agent that loses its session self-fences after 15 s: it stops answering proxyDHCP, iPXE and discovery.
- When the lease expires, the standby is promoted.
- Boot steps route to the lease holder. BMC and image-cache steps route to any connected site agent that advertises the driver (MAAS rack controllers [PA §1]).

### 8.6 Scale budget and what breaks first

At 10k nodes / 100k GPUs (estimates, validated in v0.4): liveness 10k HOT rows per 15 s; ~170 opens/s in a storm; commands ~50/s, ~2k/s in mass provisioning; node events ~170/s; resync ~33 reconciles/s; placements ≥200/s.

What breaks first, with the mitigation already built in:
1. liveness writes → memory-first, batched, transition-only;
2. telemetry → the TSDB;
3. reconnect storms → admission control, jitter, `Drain`, grace;
4. hot pools → one writer per pool, sub-pool split above ~20k atoms;
5. capacity reads → rollups;
6. inventory payloads → section hashes;
7. connections → PgBouncer;
8. history → partitions;
9. gateway TLS CPU → admission control, optional Envoy offload **(verify)**;
10. **the IAM lane.** Every IAM call is ≥1 global-lock acquisition, and `iam.authenticate` may write `sessions.lastSeenAt` (confirmed: `principals.ts:116-118`, `base.ts:1280-1283`).
    - Cost of an admission: ≥2 acquisitions (`require` = authenticate + decide), 3 on an authentication-cache miss, +1 for `billing.check`, +1 for each uncached `features.isEnabled` (avoided by the flag cache). In remote mode, `sts.getCallerIdentity` costs 2.
    - Cost of a list page: 1–2 acquisitions, plus one audit-chain append for every denied item.
    - Mitigations: one decision per mutation, a 30 s authentication cache, a 10 s read-decision cache, SQL-scoped lists, `recordMany` batches ≤200.
    - The lane is sized in acquisitions/s from v0.1 (§16). R1 is proposed only if the lane saturates (§12.11).

## 9. Public API, SDK, CLI

### 9.1 HTTP convention

- **Routes.** `POST {basePath}/{group}/{method}` (default `/api/compute`). JSON bodies ≤64 KiB (1 MiB for `profiles.*` and `fleet.*`). Requests need `content-type: application/json` **and** `X-Better-Compute: 1`, else `CSRF_REJECTED`. Cookie requests need an exact trusted `Origin`. Plugins live under `plugins/{id}/…`. Unknown routes are `NOT_FOUND` (`Object.hasOwn` guards).
- **Credentials.** IAM bearers, and session JWTs with compute in the audience. The IAM cookie is accepted only with `acceptIamCookie`, same-origin. OAuth `at+jwt` (`createResourceGuard`) works for **read methods only**, by scopes plus compute's tenant checks, until gap 11. Compute never issues sessions.
- **Responses.** `{data}` or `{error:{code, message, retryAfterMs?, details?}}`. `X-Request-Id` is echoed and passed to IAM [EXT §7].
- **GET routes**, only these: `/health`, `/metrics`, `/.well-known/better-compute`, `/watch` (SSE), `/downloads/bcd/{version}/{os}-{arch}`, `/tunnels/{ticket}` (v0.3).
- **Async-with-wait from day one.** Long calls return `{…record, operation:{id, state}}`. `wait:{timeoutMs ≤ 30000}` blocks until the operation is terminal or the timeout passes, so swapping the v0.1 inline placer for the v0.4 scheduler changes no client. Every `create` requires `idempotencyKey`, scoped to `(tenant, caller identity)`.
- **Errors:**

  | Code | HTTP |
  |---|---|
  | `UNAUTHENTICATED` | 401 |
  | `ACCESS_DENIED`, `CONFIRMATION_REQUIRED` (`details.confirmationId`) | 403 |
  | `NOT_FOUND` | 404 |
  | `INVALID_INPUT` | 400 |
  | `INVALID_STATE`, `CONFLICT`, `CAPACITY_UNAVAILABLE`, `QUOTA_EXCEEDED` | 409 |
  | `SPEND_LIMIT_REACHED` | 402 |
  | `UNSUPPORTED` | 422 |
  | `UPGRADE_REQUIRED` | 426 |
  | `RATE_LIMITED` | 429 |
  | `DRIVER_ERROR`, `PROVIDER_ERROR` | 502 |

### 9.2 Groups, methods and their IAM actions (normative)

**How authorization works.**
- Each method declares `(action, resource(input))`, and the envelope runs the §3.4 pre-check and the decision before the handler.
- `initialize()` fails with `INVALID_CONFIG` when a declared action is missing from the merged catalog (§12.3).
- `scripts/authz-matrix.mjs` generates one test per row of this table.
- Because callers cannot tell `UNKNOWN_ACTION` from `ACCESS_DENIED`, `doctor` also runs one `authorize` per resource type against every IAM host.

**Scope types.** `compute-fleet/global` resolves only in root. `compute-tenant/{t}` resolves only in that tenant. `compute-project/{id}` resolves in its owner tenant.

**Notation.** Actions omit `compute:` and resources omit the `compute-` prefix. `@` separates action and resource. **Bold** marks v0.1. "+ items" means the list recipe below.

| Group (module) | Method → action @ resource |
|---|---|
| `system` (server) | **`whoami`, `version`**: public · **`selfCheck`** → `fleet:admin` @ `fleet/global` |
| `projects` (server) | **`create`** → `projects:manage` @ `tenant/{t}` · **`get`** → `projects:read` @ `project/{id}` · **`list`** → `projects:read` @ `tenant/{t}` + items · `archive` → `projects:manage` @ `project/{id}` (membership: IAM relationships on `project/{id}`) |
| `sites` (server) | **`list`** → `sites:read` @ `tenant/{t}` + items · **`get`** → `sites:read` @ `site/{id}` · **`create`** → `sites:manage` @ `fleet/global` (kind `shared`/`dedicated`) or @ `tenant/{t}` (kind `custom`, D11) · `update`, `delete` → `sites:manage` @ `site/{id}` |
| `siteTokens` (server, v0.2) | `create`, `revoke` → `sites:manage` @ `site/{id}` |
| `pools` (capacity) | **`list`** → `pools:read` @ `tenant/{t}` + items · **`get`** → `pools:read` @ `pool/{id}` · **`create`** → `pools:create` @ `fleet/global` (platform) or @ `tenant/{t}` (BYO pool on the tenant's `custom` site) · **`capacity`** → `capacity:read` @ `pool/{id}` · **`offer`, `unoffer`** → `pools:share` @ `pool/{id}` · `update`, `archive` → `pools:manage` @ `pool/{id}` |
| `joinTokens` (server) | **`create`** → `join-tokens:create` · **`list`** → `join-tokens:read` · **`revoke`** → `join-tokens:revoke`; all @ `pool/{id}` |
| `joinRequests` (server, v0.2) | `list` → `join-tokens:read` · `approve`, `reject` → `join-tokens:create`; @ `pool/{id}` |
| `nodes` (server) | **`list`** → `nodes:read` @ `tenant/{t}` + items · **`get`, `events`** → `nodes:read` · **`cordon`, `uncordon`** → `nodes:cordon` · **`drain`** → `nodes:drain` · **`label`, `taint`** → `nodes:update` · **`adopt`** (re-run acceptance) → `nodes:provision` · **`revokeIdentity`** → `nodes:revoke-identity` · `delete` → `nodes:delete` · `issueSshCert`, `revokeSshCert` (v0.3, module `tunnels`) → `nodes:ssh-root`; all @ `node/{id}` |
| `inventory` (inventory) | **`get`**, `history`, `diff` → `nodes:read` @ `node/{id}` |
| `capacity` (capacity) | **`summary`** → `capacity:read` @ `tenant/{t}` (visible pools only, from the projection) · `byPool`, `preview`, `timeline` → `capacity:read` @ `pool/{id}` |
| `reservations` (capacity) | **`create`** → `reservations:create` @ `reservation/{draftId}` · **`get`** → `reservations:read` · **`list`** → `reservations:read` @ `tenant/{t}` (+ owner filter or items) · **`release`**, `cancel` → `reservations:release` · **`extend`, `renew`** → `reservations:extend` (admitted like `create`, §10.5); item methods @ `reservation/{id}` |
| `quotas` (capacity) | **`get`** → `quotas:read` @ `tenant/{t}` · `set` → `quotas:manage` @ `fleet/global` |
| `commands` (server) | **`run`** (allowlist `diag.nvml`, `inventory.refresh`, `logs.collect`, `node.reboot`; `diag.dcgm` from v0.2) → `nodes:exec` · **`get`, `list`** → `nodes:read` · `cancel` → `nodes:exec`; all @ `node/{id}` |
| `usage`, `events`, `webhooks`, `drivers` (server) | **`usage.list`**, `usage.export` → `usage:read` @ `tenant/{t}` or `project/{id}` · **`events.list`** → `events:read` @ `tenant/{t}` · `webhooks.*` → `webhooks:manage` @ `tenant/{t}` · `drivers.list` → `drivers:read` @ `tenant/{t}` |
| `secrets` (server, v0.2) | `put` (returns `secret://…`), `delete` → `secrets:manage` @ `tenant/{t}` or `fleet/global` (platform secrets). Write-only: no `get` |
| `metal` (metal, v0.2) | `enroll` → `nodes:provision` @ `pool/{poolId}` (inline BMC credentials are stored at once and never echoed) · `manage`, `inspect`, `provide`, `deploy`, `undeploy`, `rescue`, `unrescue`, `abort`, `recover`, `retire` → `nodes:provision` @ `node/{id}` · `power` → `nodes:power` @ `node/{id}` |
| `profiles`, `images`, `workflows` (provision, v0.2) | `profiles.create` → `profiles:manage` @ `tenant/{t}` · `profiles.get`, `validate`, `render` → `profiles:read` @ `profile/{id}` · `profiles.list` → `profiles:read` @ `tenant/{t}` + items · `profiles.update`, `delete` → `profiles:manage` @ `profile/{id}` · `images.register` → `images:publish` @ `tenant/{t}` (public: @ `fleet/global`) · `images.get` → `images:read` @ `image/{id}` · `images.list` → `images:read` @ `tenant/{t}` + items · `images.promote` → `images:publish` @ `image/{id}` · `workflows.get`, `list` → `workflows:read` @ `node/{id}` · `workflows.abort`, `retry`, `pause`, `resume` → `workflows:manage` @ `node/{id}` |
| `instances`, `flavors`, `providerAccounts` (vps, v0.3) | `instances.create` → `instances:create` @ `instance/{draftId}` · `instances.list` → `instances:read` @ `tenant/{t}` (+ owner filter or items) · `get` → `instances:read` · `start`, `stop`, `resize` → `instances:update` · `delete` → `instances:delete` (item methods @ `instance/{id}`) · `flavors.list` → `flavors:read` @ `pool/{id}` · `flavors.create`, `update`, `delete` → `flavors:manage` @ `pool/{id}` · `providerAccounts.create` → `providers:manage` @ `fleet/global` or `tenant/{t}` · `providerAccounts.list` → `providers:read` @ `tenant/{t}` + items · `get`, `offers` → `providers:read` · `update`, `delete`, `bootstrap` (platform-owned machines → bcd nodes) → `providers:manage` (item methods @ `provider-account/{id}`) |
| `sandboxes`, `sandboxTemplates` (vps, v0.5; §3.7) | `sandboxes.create` → `sandboxes:create` @ `sandbox/{draftId}` (attributes `templateId, vcpu, memoryGiB, gpus, ttlSeconds, fromSnapshot, warm`) · `sandboxes.list` → `sandboxes:read` @ `tenant/{t}` (owner-scoped like instances) · `get` → `sandboxes:read` · `extend`, `snapshot` → `sandboxes:update` · `delete` → `sandboxes:delete` · `exec` → `sandboxes:exec` (item methods @ `sandbox/{id}`) · `sandboxTemplates.create` → `sandboxes:manage` @ `tenant/{t}` · `sandboxTemplates.list` → `sandboxes:read` @ `tenant/{t}` + items · `get` → `sandboxes:read` · `update`, `delete` → `sandboxes:manage` (item methods @ `sandbox-template/{id}`) |
| `tunnels` (server, v0.3) | `open` → `instances:exec` @ `instance/{id}`, or `nodes:console` @ `node/{id}` |
| `fleet` (server, v0.2) | `export`, `plan`, `apply` (`FleetConfig v1`, mirroring IAM `config.*` [EXT §5]) → `fleet:admin` @ `fleet/global` |

**List recipe** (P7, P11):
1. **Coarse gate:** one `authorize` for `compute:<kind>:read` on the input scope (`compute-tenant/{t}` or `compute-project/{id}`).
2. **SQL pre-filter:** SQL scopes rows to the caller's tenant and keeps only rows the caller can plausibly read (owner, project member, pool offer or relation, via the projection). This keeps per-item checks mostly allows.
3. **Owner-scoped kinds** (reservations, instances, sandboxes) with `scope:'mine'`, the default: the coarse decision plus `owner_identity_id = caller` in SQL, with no per-item checks.
4. **Everything else** (`scope:'tenant'`, pools, nodes, sites, …): one `authorizeMany` per page (≤50 items), built only from rows the local projection already holds.
   - A resolver `NOT_FOUND` aborts the whole batch, because resolution precedes the decision. The page is retried once after the projection catches up.
   - Any other batch error fails the request.
5. **Cost:** every denied item appends a deny event to the tenant's audit chain plus an `auditHooks` row, and every check reloads all of the tenant's relationship tuples, all under the global lock (`operations.ts:206-215,268-275`, `events.ts:101-113`, `decisions.ts:624`). The v0.1 IAM-lane benchmark counts list denials as audit-chain writes and budgets lane time per page.

Reads use a 10 s decision cache keyed `(sessionId, action, type, id)`, invalidated by policy, role, binding and relationship events. Mutations are never cached.

### 9.3 Typed client, events, CLI, MCP

```ts
import type { compute } from './compute.server';                  // type-only import
const client = createComputeClient<typeof compute>({ baseURL, token: () => session.getToken(), requestId: true, retryRateLimited: true });
await client.reservations.create({ tenantId, poolId, duration: '8h', idempotencyKey, wait: { timeoutMs: 20_000 },
  devices: [{ class: 'gpu', count: 4, selector: { matchExpressions: [{ key: 'gpuProduct', op: 'In', values: ['H100-SXM5-80GB'] }] } }] });
client.instances.create;                                          // type error unless vps() is in `modules`
await client.plugins['acme-autoinstall'].isos.render({ tenantId, nodeId });
```

**Client.** A Proxy client with better-iam's reserved-segment rules, `IsCredential` stripping, `$request`, `$watch` and `ComputeClientError`. `tests/tsconfig.client.json` asserts inference through modules and plugins.

**Events.** CloudEvents-style `{id, type, tenantId, subject, time, sequence, data}`: `node.*`, `gpu.*`, `reservation.{placed,active,releasing,released,failed}`, `instance.*`, `workflow.*`, `security.*`. They are delivered from the outbox to:
- `compute.events.subscribe`;
- SSE `/watch` (`Last-Event-ID` is the xmin cursor);
- per-tenant webhooks, signed like better-iam's (`X-Better-Compute-Signature: v1=<hmac>` over `${timestamp}.${body}`, 5 min tolerance).

**CLI.** A port of better-iam's `defineCommand`/`createCliProgram` framework (`@better-iam/cli` exports `defineCommand` and `createCli`, not `createCliProgram`).
- `target:'config'` runs in-process via config discovery or `configFromEnv` (`BETTER_COMPUTE_DATABASE_URL` = `postgres://…` | `pglite:…`). `target:'token'` calls the API.
- Auth comes from `BETTER_COMPUTE_TOKEN`; else better-iam's profile store (`createProfileStore`, `credentialsPath`, from the optional `@better-iam/cli` peer); else compute's own 0600 file.
- `computeCommands(defineCommand)` builds specs with the caller's `defineCommand`, so an embedding host can ship one binary via better-iam's `createCli({ commands })`.
- Commands mirror the API groups (`reserve --pool h100-eu --gpus 4 --for 8h`, `api GROUP.METHOD k=v`, `fleet plan|apply --fail-on-drift`), plus `init`, `migrate`, `dev`, `serve`, `doctor`, `iam setup`, `pki issue-gateway`, `daemon install-script` and `sim`.
- Nodes run `bcd join|status|doctor|support-bundle`.

**MCP (v0.3).** `createComputeMcp({ client })` exposes tools (`list_pools`, `capacity_summary`, `preview_reservation`, `reserve_gpus`, `release_reservation`, `node_status`, `run_diagnostic`, `create_instance`, …) behind better-iam's `createMcpGate({ iam, tenantId, tools: gateTools(), unlisted:'deny' })`.
- **The gate checks visibility only** (`compute:pools:read` on `compute-pool/{poolId}`). Confirm-listed actions are not gate actions, so nobody is asked twice about different resources.
- Tools surface `CONFIRMATION_REQUIRED`, poll `getConfirmation` and retry with the same `idempotencyKey`.
- `exec_command` is off by default.
- Remote-IAM MCP (v0.4) uses compute's own `McpIam` adapter over `sts.getCallerIdentity`.

## 10. Inventory & capacity

### 10.1 Inventory and health

**Schema.** `NodeInventory v1` (`agent/v1/inventory.proto`) [PA §4] covers system, CPU/NUMA, memory, disks, NICs (SR-IOV, RDMA), BMC, OS and `gpus[]` (uuid, PCI, NVML name, VRAM, driver, MIG, NVLink, topology matrix, fabric clique, ECC, row-remap).

**GPU naming.**
- `gpuProduct` is the normalized NVML name; for example, "NVIDIA H100 80GB HBM3" becomes `H100-SXM5-80GB`.
- `gpuModel` is the family (`H100`), mapped through a versioned `gpu-models.json` shipped by `inventory`. An unknown name maps to `other` and raises `GpuModelUnknown`.
- Pools, policies and meters use `gpuModel`. Selectors may use either field.

**Collection.** Inventory is collected from sysfs, netlink and NVML on a `boot_id` change, uevents, step ends, XID events, a jittered 12 h rescan and `inventory.refresh`. Sections are canonicalized and sha256'd; `Hello` and every 10th heartbeat carry the hashes, and the server pulls only changed sections. Snapshots are append-only.

**Diffs** emit `gpu.missing|added`, `disk.replaced`, `driver.changed` and `mig.layout.changed`. Device IDs are stable (GPU UUID, disk WWN, MAC). A vanished device with live bookings turns `healthy=false` and is deleted only after its bookings end.

**Trust.** Inventory from a `tenant-owned` node counts only toward its owner's `custom` pools (§10.2). Inventory from a `tenant-controlled` node (a dedicated-root lease) is advisory and never adds capacity.

| Condition (phase) | Default policy |
|---|---|
| `GpuCountMismatch`, `GpuModelUnknown` (v0.1) | `NoSchedule`, alert |
| `Xid48` / `Xid79`, `Xid95` (v0.2) | quarantine the atom (`healthy=false`) / cordon, drain + reboot within budget |
| `RowRemapPending` (63) / `RowRemapFailed` (64) (v0.2) | drain + GPU reset / RMA |
| `EccUncorrectable`, `NvlinkDegraded`, `PcieReplayHigh` (v0.2) | taint the device |
| `Disk/Memory/CpuPressure` (PSI, steal) (v0.3) | `NoSchedule` on VPS hosts |
| `DriverMismatch`, `DaemonOutdated`, `CertExpiring`, `ClockSkew`, `DuplicateIdentity` | alert, taint |

`NoSchedule` taints and conditions are mirrored into `nodes.no_schedule_reasons` in the same transaction, so the placer can lock and read them (§10.3).

Remediation (`gpu-reset`, `reboot`, `diag-r3`) runs as workflows that share the pool's **disruption budget** (default 5%) with drains and rollouts. A **circuit breaker** pauses auto-remediation for a pool when >10% of its nodes turn unhealthy within 10 min.

### 10.2 Capacity math

```
allocatable = capacity − systemReserved − evictionReserve      (devices: bookable ∧ healthy atoms)
allocated   = bookings with during ∋ compute_now()  |  node_resources.allocated
reserved    = bookings with lower(during) > compute_now(), within the horizon
available   = allocatable × ratio(pool, resource) − allocated − reserved(overlapping the query window)
```

**Schedulable** ⇔ all of the following hold:
- `provisionState ∈ {adopted, deployed}`;
- `role='host'`;
- not in maintenance and not cordoned;
- `connectivity='connected'`;
- `no_schedule_reasons` is empty;
- `trust='platform'`, or `trust='tenant-owned'` and the pool's owner tenant is the node's owner tenant.

Everything else is reported in buckets: provisioning, unhealthy, maintenance, unreachable. GPUs are never overcommitted. The offering validator refuses to offer a pool that contains `tenant-owned` nodes to any other tenant.

### 10.3 Placement

**Pipeline:**
1. admission plugins;
2. candidates from rollups;
3. filters: fits, selector, taints, health, topology;
4. atom pick via `preferAllocation`. The default prefers NVLink-complete sets with CPU and NIC on the same NUMA node;
5. scorers: `binpack` (default; keeps 8-GPU boards whole), `topology` (NV > PIX > PXB > PHB > NODE > SYS), `image-cached` [DAY], `fragmentation`, `spread`;
6. a random pick among the top 5;
7. commit.

Gangs are all-or-nothing on one topology key in one transaction. Selectors are structured `matchExpressions` (CLI shorthand: `gpuProduct in (H100-SXM5-80GB), vramGiB >= 80`); CEL is deferred.

**v0.1 `InlinePlacer`** runs in the admission tx, fenced by `SELECT 1 FROM pools WHERE id=$pool FOR UPDATE`. That gives one writer per pool at a time, which is enough for tens of placements/s per pool.

**v0.4 `PoolLeasePlacer`** runs in the worker holding `pool:<id>` (fenced by the lease `FOR SHARE`). It keeps an in-memory index rebuilt when the lease is acquired, and batches ≤64 requests.

```sql
SAVEPOINT place_1;                                  -- one savepoint per attempt; ROLLBACK TO it on conflict and replan (≤3)
SELECT n.id FROM nodes n JOIN pools p ON p.id = n.pool_id
 WHERE n.id = ANY($nodeIds) AND n.role = 'host' AND NOT n.maintenance AND NOT n.cordoned AND n.connectivity = 'connected'
   AND n.provision_state IN ('adopted','deployed') AND cardinality(n.no_schedule_reasons) = 0
   AND (n.trust = 'platform' OR (n.trust = 'tenant-owned' AND p.owner_tenant_id = n.owner_tenant_id))
 FOR SHARE OF n;                                    -- linearizes with cordon, taint and liveness writes
SELECT id FROM devices WHERE id = ANY($atoms) AND healthy AND bookable FOR SHARE;       -- linearizes with quarantine
UPDATE quota_usage SET used = used + $n
 WHERE tenant_id=$t AND pool_id=$pool AND resource='gpu' AND used + $n <= max RETURNING used;
                                                    -- 0 rows ⇒ QUOTA_EXCEEDED (a missing row means the offering grants 0)
INSERT INTO device_bookings (device_id, allocation_id, during)
  SELECT unnest($atoms), $alloc, tstzrange($s, $e) ON CONFLICT DO NOTHING RETURNING device_id;  -- fewer rows than atoms ⇒ conflict
UPDATE node_resources SET allocated = allocated + $x
 WHERE node_id=$n AND resource=$r AND allocated + $x <= floor(allocatable * ratio) RETURNING allocated;  -- 0 rows ⇒ conflict
UPDATE reservations SET state='placed', version=version+1 WHERE id=$id AND version=$v;  -- + allocations, work_queue, outbox, audit
```

Guarded statements return 0 rows instead of raising SQLSTATE 23514 or 23P01, so a conflict doesn't abort the admission transaction. `ON CONFLICT DO NOTHING` without a conflict target honours exclusion constraints.
- A node, atom or scalar conflict rolls back to the savepoint and replans without the conflicting node, ≤3 times; after that the reservation goes to `pending` + `Unschedulable` and is retried every 30 s.
- A quota failure is terminal for the request (`QUOTA_EXCEEDED`).
- `pools.offer` creates the tenant's quota rows, and `pools.create` creates the owner's.

### 10.4 Why double-booking cannot happen

1. **Device-time exclusivity:** every claim is a booking row, and `EXCLUDE (device_id =, during &&)` allows one live booking per atom per instant, whatever the scheduler or API does.
2. **Atom rule:** MIG GPUs expose only `gi/ci` atoms, and timeslice/MPS GPUs only slot atoms `<uuid>/s<k>`. The parent is `bookable=false` while partitioned. A mode or layout change books **every atom including the parent** for the change window, so it commits only when nothing is booked. A flat `EXCLUDE` cannot see parent/child overlap; the atom rule removes it.
3. **Scalars:** guarded `allocated + x <= floor(allocatable*ratio)` under row locks, with the `CHECK` as a backstop.
4. **Eligibility is linearizable.** `FOR SHARE` on node rows conflicts with the `UPDATE`s that cordon, taint or mark a node unreachable, because `cordoned`, `no_schedule_reasons` and `connectivity` are columns of `nodes`. `FOR SHARE` on the chosen atoms conflicts with the `healthy=false` quarantine update; a booking FK's `FOR KEY SHARE` alone would not. Whichever commits second sees the first.
5. **Quota:** a guarded `used + n <= max` in the same tx, counting all non-terminal reservations (D9).
6. **Defence in depth:** the daemon rejects overlapping assignments. The torture test (§15) attacks 1–5 with lock-ignoring placers, concurrent `healthy=false` flips and taint writes.

### 10.5 Reservations and leases

```
draft ─allow─► placed ─starts_at─► binding ─bound─► active ─(ends_at | release | lease lapse)─► releasing ─► released
  ├ deny ─► denied (GC 24 h)     ├ conflict ×3 ─► pending(Unschedulable, retry 30 s) ─maxPending─► failed
  └ delegated deny (v0.3) ─► awaiting-confirmation (≤30 min) ─retry, same key─► re-decide | expired
bind timeout ─► pending (≤2) ─► failed;  cancel ─► cancelled;  node unreachable ⇒ condition only (P6);  atom unhealthy ⇒ Degraded
```

**`extend` and `renew` are admissions.** Both follow the §3.4 sequence against the existing reservation:
1. **tx 1** writes a pending change into the reservation's `authz_projection.pending`: `durationHours` = the total after the change, `gpuCount`, and the `idempotencyKey`. The in-memory projection resolves the pending values.
2. `iam.require(compute:reservations:extend, compute-reservation/{id})`.
3. **tx 2** either commits or reverts:
   - On allow it raises `upper(during)`. The `EXCLUDE` decides, and a conflict returns the next free time. It then folds `pending` into `attributes`.
   - On deny it clears `pending`.

So the 72 h cap that `ReserveBoundedH100` sets at create also holds for extensions, via `BoundedExtend` (§12.6). `renew` applies to renewable reservations (suited to agents): it moves the lease deadline every `leaseSeconds`, not `during`, so its `durationHours` is unchanged, and it is authorized with the same action. If the lease lapses, the reaper releases the reservation. Early release truncates `during`.

Future bookings give calendar reservations (BookingRepair re-places at T−15 min, v0.5).

Bindings:
- `hold`: CDI, for a higher-level scheduler. In v0.1 an operator-run workload manager on the node consumes it via the `binding` returned by `reservations.get`.
- `instance`: VPS.
- `node`: tenant deploy, v0.5.

### 10.6 Fractional GPUs, labels, rollups

- **Sharing modes (v0.5)** [PA §5]:
  - `exclusive` (default);
  - `mig` (`single`/`mixed`);
  - `timeslice` (replicas, no isolation);
  - `mps` (100 units per GPU).

  **`timeslice` and `mps` pools are single-tenant**: the offering validator rejects multi-tenant offers.
- **MIG and reset.** MIG changes apply only when all of the GPU's atoms are free. Released GPUs are reset. Memory clearing between tenants relies on the driver **(verify NVIDIA's guarantees; add a zeroing pass if unclear)**.
- **Labels** are derived GFD-style: `gpu.product` (= `gpuProduct`), `gpu.model` (= `gpuModel`), `cuda.driver.major`, `mig.capable`, `fabric.domain`. Taints include `unhealthy.gpu/<uuid>` and `dedicated=<tenant>`.
- **Rollups.** `pool_capacity_rollup` is updated in the booking tx (v0.1) or from the placer's index every 5 s (v0.4). Reads never aggregate devices.

## 11. Provisioning

### 11.1 Lifecycles

| Metal state (Ironic semantics, MAAS names in docs) | Exits |
|---|---|
| `adopting` → `adopted` (Metal3 `externallyProvisioned`; v0.1, no deploy) | acceptance fail → condition; `release` (needs a BMC) → `releasing`; `retire` |
| `enrolling` → `inspecting` → `commissioning` → `ready` | `deploy` → `deploying` → `deployed` (role `host` or `dedicated`); `retire` |
| `deployed` | `release` → `releasing` (wipe `quick`/`secure-erase`/`crypto-erase`) → `ready`; `rescue` ⇄ `unrescue` |
| `failed` (`failedFrom`, maintenance on) | `recover` → last stable state; `retire` |
| `retiring` → `retired` | terminal: identity revoked, BMC credentials destroyed |

`maintenance`, `cordoned`, power and connectivity are separate axes. The state table lives in `core`, so v0.1's adopt path needs no metal package.

**Tested invariant:** `ready` follows `releasing` only through a workflow whose wipe succeeded, as shown by a node-signed `attested` result verified by the worker (v0.2).

VPS states: `pending → scheduling → provisioning → starting → running ⇄ stopped`, plus `rebooting`, `resizing`, `deleting → deleted`, `error` and `lost`. The Instance controller converges `state` toward `desiredState ∈ {running, stopped, deleted}` [DAY §3].

### 11.2 Workflow engine (v0.2)

**Persistence.** `workflows` and `workflow_steps` (driver, action, runs_on, args, state, attempt, idempotency_key, command_id, deadline, result) persist every transition. Partial unique indexes allow one active workflow and one in-flight step per node, so the next shard owner resumes a crashed workflow.

**Step options.** `timeout`, `retries`, `onFailure: fail | rescue | continue | <step>`, `when`, `cleanup[]`, and `await: 'rejoin'`. Workflows can pause, resume, cancel, or retry from a step.

**Execution.**
- `control-plane` steps run in the worker owning the target's shard, with `idempotencyKey = wf:<id>:<stepId>`.
- Every other step is exactly one command.
- A step whose command kind is self-terminating (`boot.kexec`, `node.reboot`, `daemon.upgrade`) completes when the agent rejoins with a new `boot_id` or role, within the step's timeout (`await:'rejoin'`). Its `onFailure` fires only on rejoin timeout, never on command expiry.

**Profiles** are pinned by version. `hostConfig` becomes desired state after join, so drift is corrected continuously.

### 11.3 Driver taxonomy mapped to packages

| Concern | Contract | Built-ins (where) |
|---|---|---|
| power, management, virtual-media, console | metal | redfish, ipmi, vendor via bmclib (`bcd site`); provider power (provider packages) |
| boot / deploy | metal | pxe, ipxe, uefi-http (`bcd site`) / image-stream, kexec (`bcd ramdisk`); Hetzner Robot rescue + installimage; plugins (autoinstall v0.2, Talos v0.3 via `site.httpProxy`; §5.6) |
| inspect; bios, raid, firmware | metal | agent (ramdisk/node), redfish OOB; redfish or vendor tools via bcx (v0.5) |
| config | provision | nvidia-driver, container-toolkit + CDI, mig-layout, fabric-manager, sysctl; k8s-join, slurm-join later |
| runtime | vps | libvirt-kvm, cloud-hypervisor (v0.3); firecracker, containerd (single-tenant), incus later |
| provider | vps, metal | hetzner-cloud, hetzner-robot (v0.3); proxmox (v0.5) |

Third parties add any row via `defineDriver`/`defineProvider` or bcx (§5).

### 11.4 Example profiles

```ts
// v0.1 has no profiles: adopt acceptance is pool policy, e.g. pools.create({ …, policy: { acceptance: [{ kind: 'diag.nvml' }] } }).
// 1. v0.2 brownfield adopt with host config: no workflow, no BMC, no reimage; NodeLifecycle runs acceptance, then hostConfig is desired state
defineProfile({ id: 'adopt-existing', version: 1, target: 'metal', entry: 'adopt',
  acceptance: [{ use: 'diag.dcgm', with: { level: 1 }, fallback: 'diag.nvml' }], hostConfig: { 'container-toolkit': { cdi: true } } });
// 2. v0.2 PXE commission + GPU host deploy
defineProfile({ id: 'ubuntu-24.04-gpu-host', version: 1, target: 'metal', role: 'host',
  drivers: { power: 'redfish', management: 'redfish', boot: 'ipxe', deploy: 'image-stream', inspect: 'agent' },
  image: { ref: 'ubuntu-24.04-server@2026.09', format: 'raw', compression: 'zstd' },       // sha256 pinned by the catalog
  userData: { kind: 'cloud-init', template: 'bcd-host.yaml.hbs' },                          // embeds a single-use `provisioned` token
  hostConfig: { 'nvidia-driver': { branch: '580' }, 'fabric-manager': { when: 'nvswitch' }, 'mig-layout': { from: 'pool' } },
  steps: [ { use: 'boot.prepareRamdisk', on: 'site' }, { use: 'management.setBootDevice', on: 'site', with: { device: 'pxe' } },
    { use: 'power.setPower', on: 'site', with: { action: 'cycle' } }, { use: 'wait.agentJoined', with: { role: 'ramdisk' } },
    { use: 'inspect.inspect', on: 'ramdisk' }, { use: 'diag.dcgm', on: 'ramdisk', with: { level: 2 } },
    { use: 'deploy.deploy', on: 'ramdisk', timeout: '30m' }, { use: 'management.setBootDevice', on: 'site', with: { device: 'disk' } },
    { use: 'boot.kexec', on: 'ramdisk', await: 'rejoin', timeout: '15m',                  // self-terminating; completes on rejoin as `node`
      onFailure: { use: 'power.setPower', on: 'site', with: { action: 'reset' } } },       // fires only on rejoin timeout
    { use: 'wait.generationObserved' } ],
  acceptance: [{ use: 'diag.dcgm', with: { level: 1 } }], cleanup: [{ use: 'boot.cleanUp', on: 'site' }] });
// 3. v0.3 VPS
defineProfile({ id: 'vps-ubuntu-24.04', version: 1, target: 'vps', runtime: 'libvirt-kvm', image: { ref: 'ubuntu-24.04-cloud@2026.09', format: 'qcow2' },
  flavors: { 'g1.small': { vcpu: 2, memoryGiB: 4, diskGiB: 40 }, 'gpu1.l40s': { vcpu: 16, memoryGiB: 96, diskGiB: 200, gpus: 1 } },
  userData: { kind: 'cloud-init', template: 'vps-default.yaml.hbs' }, network: { mode: 'bridge', ipam: 'pool' } });
```

The GPU ramdisk carries NVIDIA modules and DCGM, so it is large. Its size and build are validated in v0.2.

### 11.5 Image pipeline

- **Build.** Images are built outside the control plane (mkosi, Packer) as `raw.zst` or `qcow2`, with a manifest, a cosign signature and an SBOM.
- **Register.** `images.register` (`compute:images:publish`) verifies digest and signature against a per-tenant signer allowlist. Unsigned images stay tenant-only. Ramdisks are platform-signed only.
- **Cache.** Site caches pull on demand, pre-warm per pool policy and re-verify before serving. `image_locations` tracks placement (Daytona `SnapshotRunner` [DAY §4]) for the `image-cached` scorer. LRU eviction pins in-use images.

---

## 12. better-iam integration

### 12.1 Modes, wiring, multi-process rules

| | Embedded (default) | Remote (v0.4) |
|---|---|---|
| Wiring | each compute process that constructs `betterIam()` passes `bridge.plugin({inbox})` and `bridge.resolveResource(hostFallback?)`; compute gets `bridge.embedded(iam)` | the IAM operator installs `computeIamHost({ projection: replicaProjection({url: <read-only role>}), inbox: postgresInbox({url: <IAM database>}) \| httpInbox({url, secret}) })` from `better-compute/iam/plugin`. `postgresInbox` is the default: it writes a `compute_inbox` table in the IAM database (same availability as IAM), which compute's IamInbox worker drains. Compute uses `remoteIam({ baseURL, serviceToken })`. If the IAM deployment is the better-iam console, this needs U0 |
| AuthN | `iam.authenticate({headers})` (1 lock acquisition; may write `lastSeenAt`); `iam.sessionTokens.verify(t, {audience})` for JWTs (checks the session is live; 1 acquisition) | `sts.getCallerIdentity` (2 acquisitions; 30 s cache); offline `createSessionTokenVerifier` for reads |
| AuthZ | `iam.require` / `authorize` / `authorizeMany` (each authenticates again internally) | bearer-less `createIamClient`, with the caller's `authorization` forwarded per call [ID §1] |
| Resolver | in process, memory-resident projection (§12.4) | in the IAM host, a memory-resident replica of `authz_projection` |
| Billing | `iam.billing.recordMany` (audit-free; batches ≤200 to bound lock hold; poison isolation §12.7); optional `iam.billing.check` | HTTP `billing/recordMany` (≤100) as the root SA with `iam:billing:record`; `billing/check` with the caller's header |
| Events | plugin `afterAudit` → `iam_inbox` (never throws, §12.3) | the same plugin in the IAM host → `postgresInbox`; fallback: root subtree webhook |
| Flags | flag cache: one `iam.features.isEnabled(tenantId, key)` per `(tenant, key)` on a miss, invalidated by `feature:*` inbox events, 5 min TTL backstop | the same cache over HTTP reads as the root SA **(verify endpoint)** |

```ts
const bridge = createComputeIamBridge({ typePrefix: 'compute-', modules: [metal(), vps()], plugins: [acmeAutoinstall()] });  // built-in catalogs always included
const iam = betterIam({ database: iamDb, secret, baseURL,
  plugins: [bridge.plugin({ inbox: bridge.localInbox(), timeoutMs: 2000, spill: 10_000 })],   // catalog + afterAudit → iam_inbox
  resolveResource: bridge.resolveResource(hostResolver /* optional: the host's own app types */),
  sts: { jwt: { signingKeys, audiences: ['https://compute.example.com'] } } });
const compute = betterCompute({ database: postgres({ url }), secret, baseURL, modules: bridge.modules, plugins: bridge.plugins,
  iam: bridge.embedded(iam, { rootTenantId, runIamJobs: true /* compute is the IAM host family (supported topology) */ }) });
await compute.initialize();   // binds projection + inbox; checks every method's action is in the catalog; until then the resolver denies
```

**Supported topology until U0 lands (v0.1–v0.3; D19):**
- compute's processes are the only IAM hosts on that IAM database. Every process that constructs `betterIam()` on it is a compute `api` or `worker` process with the plugin and resolver installed;
- compute's worker role `iam` runs better-iam's jobs under a singleton lease: `iam.dispatchAuditHooks()`, `iam.auth.dispatchOutbox()`, `iam.billing.checkBudgets`, `iam.billing.closePeriod`, `iam.sweepExpired`;
- administrators author policies with a better-iam CLI whose `better-iam.config.mjs` includes `computeIamHost`, so `compute:*` actions validate. The better-iam console is pointed at this database only after U0. Its `createOptions` merges only `http` and `authentication` overrides (`apps/console/better-iam.config.mjs:78-119`), and it dispatches audit hooks every second (`apps/console/src/lib/iam.ts`), so today it would reject `compute:*` policies and swallow compute's events.

**Rules** (fact 2):
- Every process that constructs `betterIam()` on the IAM database installs compute's plugin and resolver.
- **Failure mode (a), no plugin.** The host's catalog has no `compute:*` actions, so:
  - decisions return `UNKNOWN_ACTION`, which callers see as `ACCESS_DENIED` (`decisions.ts:683-684`, `operations.ts:216-219`);
  - `policies.create` and `config.apply` reject `compute:*` actions with `INVALID_ACTION` (`catalog.ts:507-512`);
  - `relationships.create` on `compute-pool` fails with `INVALID_RESOURCE_TYPE` (`api/relationships.ts:42-43`);
  - events that host records are never queued for `afterAudit`, and its `dispatch()` marks rows delivered that compute never saw.
- **Failure mode (b), plugin but no `resolveResource`.** Compute decisions fail with `RESOURCE_RESOLVER_REQUIRED` (`decisions.ts:403-407`).
- `dispatch()` is at-least-once, so the inbox dedupes on `event_id`.
- **`doctor` checks on every IAM host:**
  - the catalog is present: `actions.list`/`resourceTypes.list` include `compute:*`;
  - a synthetic decision on `compute-fleet/global` (detects a missing resolver) and one `authorize` per compute resource type;
  - inbox heartbeat age and the undelivered `auditHooks` backlog;
  - `sts.jwt.audiences` contains compute; with `doctor --token`, a synthetic `sts.getSessionToken({format:'jwt', audience:[iamIssuer, computeAud]})` confirms the §12.6 grants;
  - meters;
  - flags static-`jwks` OIDC providers that point at compute.

`IamPort` (core) is all the rest of compute sees:

```ts
export interface IamPort {
  authenticate(c: Credential): Promise<Caller>;                     // {identityId, identityKind, tenantId, sessionId, sessionKind, mfa, agentId?, delegationId?}
  require(c: Credential, q: Decision): Promise<void>;               // ACCESS_DENIED; mutations; never cached; = authenticate + decide (2 acquisitions)
  authorize(c: Credential, q: Decision): Promise<boolean>;          // reads; 10 s cache
  authorizeMany(c: Credential, tenantId: string, checks: Check[]): Promise<boolean[]>;          // chunks of 50; batch error throws
  requestConfirmation(c: Credential, q: Decision & { reason: string }): Promise<{ confirmationId: string } | 'not-held-back'>;   // used from v0.3
  billingCheck(q: SpendCheckInput): Promise<SpendCheck>; recordUsage(e: UsageEvent[]): Promise<UsageResult[]>;   // poison-isolating
  featureEnabled(tenantId: string, key: string): Promise<boolean>;  // flag cache; never one isEnabled per admission
  capabilities(): { pluginResolver: boolean; eventDetail: boolean; evaluate: boolean; readOnlyDecisions: boolean };   // upstream feature detection
}
```

### 12.2 Identity per actor

| Actor | Credential into compute | Authorization / notes |
|---|---|---|
| Human | `biam_ses_`/`biam_key_`; or a session JWT from `sts.getSessionToken({format:'jwt', audience:[iamIssuer, computeAud]})` (the console caches it per IAM session); the IAM cookie only same-origin | minting that JWT needs `iam:session-tokens:create` on `iam/{identityId}` (`api/sts.ts:248-251`) and `iam:assertions:create` on `iam/<computeAud>` (`temporary-credentials.ts:318-372`), both granted by the §12.6 tenant policy; then `iam.require` per mutation and the list recipe. The CLI reuses better-iam profiles |
| Agent, own identity | agent `biam_key_` (`agents.create` + `credentials.create({scopes})`) | `principal.kind='agent'`; `agents.suspend`/`suspendAll` arrive via the inbox |
| Agent acting for a person | `biam_dlg_` (`delegations.assume`) | decided as the person, bounded by the delegation, boundary and key scopes; `principal.delegated`, `principal.agentId`; `confirm[]` ⇒ §3.4 step 7 (v0.3) |
| A2A agent / OAuth app | delegation token (`verifyDelegationToken`) / `at+jwt` (`createResourceGuard`) | scope-only and read-only (these are not IAM bearers; gap 11) |
| Org CI | org service-account key, or GitHub OIDC web identity in the org | org policy; never a platform account (SAs can't act cross-tenant [ID §0]) |
| Control plane → IAM | embedded: trusted in-process calls with the root SA's credential; remote: root SA → hourly `sts.getSessionToken` | `iam:billing:record`, `iam:billing:read`, `iam:identities:read`, `iam:agents:read`, `iam:tenants:read`, `iam:bindings:read`, and `iam:session-tokens:create` on `iam/<its own id>` |
| Daemon, site, ramdisk, gateway | compute mTLS cert | compute allowlists; **never an IAM credential** |
| Workload (v0.5, optional) | per-instance IMDS → compute OIDC JWT `sub="t:<tenantId>:instance:<id>"`, ≤15 min | `sts/assumeRoleWithWebIdentity` via a trust **created by the workload's tenant admin** (`StringLike token.sub "t:<tenant>:*"`); `jwksUri` on a public https:443 host, never static `jwks` before U6 [ID §2] |

### 12.3 Catalog and plugin

```ts
// packages/iam/src/catalog.ts (browser-safe; attributes string|number|boolean; ≤64 attributes, ≤32 relations per type)
// Normative: every action named in §9.2 appears here; initialize() fails with INVALID_CONFIG otherwise.
const a = (area: string, ...verbs: string[]) => verbs.map((v) => `compute:${area}:${v}`);
export const computeResourceTypes = (p = 'compute-') => ({
  [`${p}fleet`]:   { actions: [...a('fleet', 'admin'), ...a('sites', 'manage'), ...a('pools', 'create'), ...a('quotas', 'manage'),
                      ...a('secrets', 'manage'), ...a('images', 'publish'), ...a('providers', 'manage'), ...a('drivers', 'read')] },
  [`${p}tenant`]:  { actions: [...a('sites', 'read', 'manage'), ...a('pools', 'read', 'create'), ...a('capacity', 'read'), ...a('nodes', 'read'),
                      ...a('reservations', 'read'), ...a('instances', 'read'), ...a('projects', 'read', 'manage'), ...a('quotas', 'read'),
                      ...a('usage', 'read'), ...a('events', 'read'), ...a('webhooks', 'manage'), ...a('drivers', 'read'),
                      ...a('secrets', 'manage'), ...a('profiles', 'read', 'manage'), ...a('images', 'read', 'publish'),
                      ...a('providers', 'read', 'manage'), ...a('sandboxes', 'read', 'manage')] },
  [`${p}project`]: { actions: [...a('projects', 'read', 'manage'), ...a('usage', 'read')], relations: ['member', 'admin'] },
  [`${p}site`]:    { actions: a('sites', 'read', 'manage'), attributes: { region: 'string', iamRegion: 'string', kind: 'string' } },
  [`${p}pool`]:    { actions: [...a('pools', 'read', 'manage', 'share'), ...a('capacity', 'read'), ...a('join-tokens', 'create', 'read', 'revoke'),
                      ...a('flavors', 'read', 'manage'), ...a('nodes', 'provision')], relations: ['viewer', 'user', 'operator', 'admin'],
                     attributes: { region: 'string', class: 'string', gpuModel: 'string', gpuMemoryGb: 'number', sharing: 'string' } },
  [`${p}node`]:    { parent: `${p}pool`, relations: ['operator'], actions: [...a('nodes', 'read', 'update', 'cordon', 'drain', 'provision',
                      'power', 'exec', 'console', 'ssh-root', 'delete', 'revoke-identity'), ...a('workflows', 'read', 'manage')],
                     attributes: { region: 'string', gpuModel: 'string', gpuCount: 'number', lifecycle: 'string', trust: 'string', dedicatedTo: 'string' } },
  [`${p}reservation`]: { parent: `${p}pool`, actions: a('reservations', 'create', 'read', 'extend', 'release'),
                     attributes: { region: 'string', gpuModel: 'string', gpuCount: 'number', durationHours: 'number', binding: 'string', projectId: 'string', spot: 'boolean' } },
  [`${p}instance`]: { parent: `${p}pool`, actions: a('instances', 'create', 'read', 'update', 'exec', 'delete'),
                     attributes: { vcpu: 'number', memoryGiB: 'number', gpus: 'number', imageId: 'string', imageVerified: 'boolean', projectId: 'string' } },
  [`${p}image`]: { actions: a('images', 'read', 'publish'), attributes: { visibility: 'string', verified: 'boolean' } },
  [`${p}profile`]: { actions: a('profiles', 'read', 'manage') }, [`${p}provider-account`]: { actions: a('providers', 'read', 'manage') },
  // v0.5 sandboxes (§3.7): `warm` = the template keeps a warm pool (the claim happens after the decision).
  [`${p}sandbox`]: { parent: `${p}pool`, actions: a('sandboxes', 'create', 'read', 'update', 'exec', 'delete'),
                     attributes: { templateId: 'string', vcpu: 'number', memoryGiB: 'number', gpus: 'number', ttlSeconds: 'number', fromSnapshot: 'string', warm: 'boolean' } },
  [`${p}sandbox-template`]: { actions: a('sandboxes', 'read', 'manage') },
}) satisfies Record<string, ResourceTypeDefinition>;

export function computeIamPlugin(o: { typePrefix?: string; inbox: InboxWriter; extra?: CatalogFragment[]; timeoutMs?: number; spill?: number }): IamPlugin {
  const spill = boundedSpill<AuditEvent>(o.spill ?? 10_000);        // in-process ring, drained after the next successful put
  return { id: 'better-compute', resourceTypes: merge(computeResourceTypes(o.typePrefix), ...(o.extra ?? [])),   // + module/plugin catalogs
    async afterAudit(e) {                                            // MUST NOT throw (see below)
      if (!inboxPatterns.test(e.action)) return;
      try { await withTimeout(o.inbox.put(e), o.timeoutMs ?? 2000); await spill.flushTo(o.inbox); }
      catch { spill.push(e); metrics.inc('better_compute_iam_inbox_spill_total'); }   // doctor warns; IamReconcile covers losses
    } };
}   // no endpoints (they authorize only on iam/{tenantId}, inside IAM's locked tx [EXT §0]); no resolveContext (gap 7); no purge
```

**Why `afterAudit` never throws.** `dispatch()` awaits every plugin's `afterAudit` in one loop with no try/catch, and marks a row delivered only after all handlers have run (`events.ts:222-238`). One throw would abort the pass before `options.events.onEvent`, in-process subscribers, other plugins and every later row, and the same row would come first again next time. A compute outage (compute DB down, or the inbox unreachable) would therefore stall the IAM host's whole event pipeline. With the timeout and spill, a compute outage only fills the spill. A spilled event is lost only if the process also dies before the next successful put, and IamReconcile (§12.8) turns that into a delay, not a miss.

**Sharing.** All types are app-owned. Sharing uses `relationships.create({ tenantId, type:'compute-pool', id, relation:'user', subjectType:'group', subjectId: team.groupId })`, which works on app-owned ids [EXT §1.7]. **Never create one relationship per reservation or instance**, because every decision loads all of the tenant's tuples [EXT §0]. Managed pools and profiles (for `listAccessible` pickers) wait for U2.

### 12.4 Resolver and authz projection

**Projection rows.** `authz_projection` is written in the same transaction as domain changes, one row per `(type, id, tenant in whose view it exists)`:
- platform pools: a root row plus one per offered tenant (`include_descendants` expands via a tenant tree cached from `iam:tenants:*` events);
- BYO pools: their owner only;
- nodes: their owner, plus the lessee (with `dedicatedTo`) during a dedicated lease;
- reservations, instances, projects and drafts: their owner tenant only;
- public images: a wildcard row.

`pending` holds in-flight `extend` changes (§10.5). `compute-fleet/global` resolves only in root, and `compute-tenant/{t}` only when `id === ref.tenantId`.

```ts
export const computeResolver = (projection: AuthzProjection, o: { prefix?: string; hostFallback?: ResolveResource } = {}): ResolveResource =>
  async (ref) => {                                                   // options.resolveResource must return a Promise (options.ts:271-273)
    if (!ref.type.startsWith(o.prefix ?? 'compute-'))                // compute's own fallback chain (better-iam has no resolver composition)
      return o.hostFallback ? o.hostFallback(ref)
        : Promise.reject(new IamError('RESOURCE_RESOLVER_REQUIRED', 'No resolver for this resource type'));
    const row = await projection.get(ref.type, ref.id, ref.tenantId);   // memory; a miss does one PK read with a 20 ms timeout
    if (!row) throw new IamError('NOT_FOUND', 'Resource not visible in this tenant', 404);   // unaudited; aborts an authorizeMany batch
    return { tenantId: ref.tenantId, type: ref.type, id: ref.id,        // must echo, else RESOURCE_MISMATCH (decisions.ts:409-415)
      attributes: { ...row.attributes, ...row.pending, ownerId: row.ownerId, parentType: row.parentType, parentId: row.parentId } };
  };
```

`bridge.resolveResource(hostFallback?)` returns this resolver. Returning `undefined` is never an option: better-iam turns it into `RESOURCE_MISMATCH` (403).

**Memory-resident by design.** The resolver runs inside IAM's locked transaction, so a hit must do no I/O.
- Each process loads active rows at start; terminal ones fall to the miss path.
- It then tails `authz_changes` with the xmin cursor (≤1 s staleness).
- The API inserts its own draft into memory before `require`, so admissions always hit.
- Staleness can cause a spurious deny, never a wrong mutation, because compute re-validates in its own transaction.
- A remote IAM host's `replicaProjection` may miss a fresh draft and pay one bounded PK read under IAM's lock. Gap 2 (`evaluate`) removes that.

Admissions follow §3.4. Non-creating mutations authorize on the existing resource.

**Compute rejects cross-tenant callers before IAM** (§3.4 step 3). IAM resolves the resource before its tenant check (`decisions.ts:685-690` vs `419-425`). Without the pre-check, an outsider would get 404 for absent ids and 403 for present ones, which is an existence oracle, and every such denial would land on the victim tenant's serialized audit chain. Root callers still go to IAM, which evaluates `ROOT_OVERRIDE` and audits it.

### 12.5 Tenancy mapping

- **Root tenant (platform):** platform sites, pools and nodes; public images and profiles; provider accounts; meters; fleet roles; offerings.
- **Organization tenant:** reservations, instances, projects; private images and profiles; BYO (`custom`) sites, pools and `tenant-owned` nodes; webhooks; tenant secrets.
- **Child `project` tenants:** only for billing isolation. Each needs its own offering unless `include_descendants` is set, because parents don't reach children [ID §4].
- **Sharing:** teams share via groups.
- **Flags** such as `compute.baremetal`, `compute.h100` and `compute.byo-nodes` gate features in two ways:
  - inside decisions, via `ArrayContains tenant.features`, at no extra cost;
  - in compute code, via `IamPort.featureEnabled`, backed by the flag cache (§12.1).
- **Quotas** live in compute, because IAM `TenantLimits` is a closed set [EXT §5].
- **Residency** waits for `tenant.region` (gap 6). Until then, offerings carry the allowed IAM regions and compute enforces them. With per-region IAM databases (`regions.locate`), calls go to the tenant's home region.
- **Platform support** on customer objects happens only through IAM root override, which IAM audits.

### 12.6 Example policies

```json
{ "name": "gpu-user", "document": { "version": 1, "statements": [
  { "sid": "ListInTenant", "effect": "allow", "actions": ["compute:pools:read", "compute:capacity:read", "compute:reservations:read"],
    "resources": ["compute-tenant/*"] },
  { "sid": "SeeSharedPools", "effect": "allow", "actions": ["compute:pools:read", "compute:capacity:read"], "resources": ["compute-pool/*"],
    "conditions": { "ArrayContains": { "resource.relations": "user" } } },
  { "sid": "ReserveBoundedH100", "effect": "allow", "actions": ["compute:reservations:create"], "resources": ["compute-reservation/*"],
    "conditions": { "StringEquals": { "resource.gpuModel": "H100", "resource.region": ["eu-west-1", "eu-central-1"] },
                    "NumericLessThanEquals": { "resource.gpuCount": 8, "resource.durationHours": 72 },
                    "ArrayContains": { "resource.parentRelations": "user", "tenant.features": "compute.h100" } } },
  { "sid": "OwnReservations", "effect": "allow", "actions": ["compute:reservations:read", "compute:reservations:release"],
    "resources": ["compute-reservation/*"], "conditions": { "StringEquals": { "resource.ownerId": "${principal.id}" } } },
  { "sid": "BoundedExtend", "effect": "allow", "actions": ["compute:reservations:extend"], "resources": ["compute-reservation/*"],
    "conditions": { "StringEquals": { "resource.ownerId": "${principal.id}" }, "NumericLessThanEquals": { "resource.durationHours": 72 } } },
  { "sid": "StopWhenOverBudget", "effect": "deny", "actions": ["compute:reservations:create", "compute:reservations:extend", "compute:instances:create"],
    "resources": ["*"], "conditions": { "Bool": { "principal.spendExceeded": true } } },
  { "sid": "SessionJwtForCompute", "effect": "allow", "actions": ["iam:session-tokens:create"], "resources": ["iam/${principal.id}"] },
  { "sid": "AssertToCompute", "effect": "allow", "actions": ["iam:assertions:create"], "resources": ["iam/https://compute.example.com"] } ] } }
{ "name": "agent-guardrails", "document": { "version": 1, "statements": [
  { "sid": "AgentKeys", "effect": "deny", "actions": ["compute:nodes:ssh-root", "compute:nodes:provision", "compute:images:publish"],
    "resources": ["*"], "conditions": { "StringEquals": { "principal.kind": "agent" } } },
  { "sid": "DelegatedSessions", "effect": "deny", "actions": ["compute:nodes:ssh-root", "compute:nodes:provision", "compute:images:publish"],
    "resources": ["*"], "conditions": { "Bool": { "principal.delegated": true } } },
  { "sid": "DelegatedSmall", "effect": "deny", "actions": ["compute:reservations:create", "compute:reservations:extend"],
    "resources": ["compute-reservation/*"],
    "conditions": { "Bool": { "principal.delegated": true }, "NumericGreaterThan": { "resource.gpuCount": 4 } } } ] } }
```

**Shape.** Both policies use `{name, document:{version:1, statements}}`, as `policies.create` and `TenantConfig` require (`core/src/policy.ts:414-418`, `api/policies.ts:24-26`, `sync.ts:160-164`). `better-compute iam setup` prints them for the org admin to apply, because compute cannot write organization policies.
- `SessionJwtForCompute` and `AssertToCompute` are what IAM checks before it mints a session JWT whose audience includes compute.
- `extend` is decided on the *total* `durationHours` after the change (§10.5), so the 72 h cap cannot be bypassed by extending.

**Delegated sessions.** `principal.kind` is the identity kind (`decisions.ts:472`), so a delegated session is `user`; hence the separate `principal.delegated` statements.

**Break-glass.** A policy allows `compute:nodes:console|ssh-root` on `compute-node/*` with `Bool principal.mfa` and `resource.trust = platform`. It is bound as an **eligible** binding: `bindings.create({ eligible:true, requireMfa, requireJustification, requireApproval })`.
- The cert or tunnel TTL is ≤ the activation's `expiresAt` (`bindings.listMine`).
- `binding:deactivate` kills the sessions [EXT §5].

MFA on join tokens is an example per-pool policy, not a default, because CI can't carry MFA.

### 12.7 Billing and usage

**Meters.** `better-compute iam setup` creates the root meters once, with a root session, via `billing.createMeter` + `billing.setPrice`:
- `gpu.<gpuModel>.hours`, lower-cased (`gpu.h100.hours`). Pricing is per meter, so there is one meter per model;
- `node.metal.hours`, `vps.vcpu.hours`, `vps.memory.gib.hours`.

The basis is reserved time from `active` to `released` (D14).

**Events.** Hourly windows per allocation go to the `UsageSink` as `{ tenantId, meter, quantity, identityId, occurredAt, tags:{region, pool, gpuModel, project, agent?}, idempotencyKey:'cmp:<allocId>:<windowStartMs>' }`.
- **Tags:** no per-reservation, per-allocation or per-node ids in tags. Pool, project and agent ids are allowed, because their cardinality is bounded [EXT §2].
- **Attribution:** `identityId` is the person for delegated work, or the agent for agent keys. `UsageInput` has no `agentId` (`billing.ts:697-714`); `agentId` is set only when `identityId` is itself an agent (`billing.ts:803-804`). So agent-key usage appears under `groupBy 'agent'`, while delegated usage carries tag `agent=<agentId>` and appears only under `groupBy 'tag:agent'`. U9 (optional upstream) would close the gap.

**Poison isolation.** `recordMany` records the whole batch in one transaction (`api/billing.ts:3580-3588`), so one bad event fails the batch on every retry. On a batch error the sink bisects the batch, then falls back to per-event `iam.billing.record`:
- `NOT_FOUND 'Identity not found'`, for an identity deleted or moved before the flush (`billing.ts:795-801`; the §12.8 offboarding case): re-record with the offboard `successorId` if the inbox saw one, else without `identityId` (tenant-attributed, tag `attribution=orphaned`);
- `CONFLICT`, for a key reused on another meter (`billing-service.ts:494-497`): dead-letter it, since it indicates a compute bug;
- `BILLING_PERIOD_CLOSED` (`billing-service.ts:503-508`): dead-letter it and alert; the fix is a root `billing.createInvoiceItem`.

Only the event that still fails goes to `usage_dead_letters`. Retries are safe because of the idempotency keys. The sink flushes hourly, before the daily `closePeriod`.

**Budgets:**
- the in-decision `principal.spendExceeded` deny (tenant policy);
- per-pool `iam.billing.check`;
- `billing:budget-alert` → the offering's `onBudgetExceeded: notify | stop-new | drain`.

### 12.8 Event intake

`afterAudit` → `iam_inbox` (`ON CONFLICT (event_id) DO NOTHING`), storing `tenant_id`, `sequence` and `occurred_at` from `event.tenantId`, `event.sequence` and `event.timestamp`.

Delivery order is effectively random: `dispatch()` reads undelivered rows in id order (`events.ts:224`, `core/src/storage.ts:447`), and ids are random UUIDs (`server/src/utils.ts:4`). So:
- the IamInbox worker processes events **per tenant, ordered by `sequence`** (the per-tenant chain counter, `core/src/audit.ts:66`), without waiting for gaps;
- **handlers are level-triggered**: each re-reads current IAM state (identity and tenant status, agent and delegation status, bindings via `bindings.list`) instead of trusting event order. A `binding:activate`/`binding:deactivate` pair arriving reversed therefore still yields the right result.

**IamReconcile** runs every 5 min. It re-reads the same state for every identity that holds streams, tickets or non-terminal reservations, so a spilled or lost event only delays the reaction.

Remote fallback: a root subtree webhook, verified with `verifyWebhookSignature` and deduped on `X-Better-IAM-Delivery`.

| Event | Compute reaction (after re-reading state) |
|---|---|
| `identity:offboard` (`successorId`), `identity:expire`, `identity:delete`, `iam:identities:delete\|update` | close streams; revoke break-glass certs; reassign reservations to `successorId` or apply tenant policy; remember `successorId` for the usage sink |
| `auth:session:revoke*`, `identity:revoke-sessions`, `tenant:revoke-sessions` | recheck that identity's streams (no `sessionId` until U4); drop cached authentications |
| `agent:suspend`, `agent:suspend-all`, `delegation:revoke` | close the agent's streams; cancel its unplaced reservations; handle active ones per tenant policy |
| `binding:activate\|deactivate` | cap or close break-glass sessions |
| `iam:tenants:update\|delete` | suspend admissions; schedule teardown and purge |
| policy, role, binding, `iam:relationships:*`, `feature:*` | invalidate the read-decision and flag caches |
| `billing:budget-alert` | apply the offering's budget policy |

### 12.9 Console integration

- **Until v0.5:** CLI and API only.
- **v0.5** adds `@better-compute/console-kit` (React, using `@better-iam/react`'s `useAuthorize`, `Can`, `useFeatureFlag`, `useMySpend`) and a private `apps/console`.
  - `apps/console` depends on `better-compute` + `better-iam` and mounts `/api/iam` and `/api/compute` on one origin, so the host-only IAM cookie flows.
  - Server components use cached session JWTs, which need the §12.6 session-token grants.
  - "View as" falls back to server-side bearer forwarding, because `getSessionToken` refuses impersonation [EXT §6].
- **A Compute area inside better-iam's console** needs U0 and gap 10, and stays optional.

### 12.10 Depending on unpublished better-iam

- **Vendored tarballs.** Commit `vendor/better-iam/*.tgz` (all 23, ~1.9 MB) plus `SOURCE.json` (source, pack time, sha256s).
  - `pnpm-workspace.yaml` `overrides` map **every** `better-iam` and `@better-iam/*` package to its tarball, because transitive `0.1.0` specs 404 otherwise [CONV §11].
  - better-iam's `packed-smoke.mjs` proves the absolute forward-slash form. The relative form needs a P0 check **(verify)**.
- **Sync.** `scripts/sync-better-iam.mjs` **copies the existing `../better-iam/artifacts/*.tgz` by default** (23 present, packed 2026-09-23), regenerates the overrides and runs `pnpm install --force`.
  - `--pack` runs `pnpm pack:all` inside better-iam **only with the user's approval in chat** (D13).
  - Resync only when better-iam is green.
- **Peers.** `@better-compute/iam` peers `@better-iam/{core,server,client}` `^0.1.0`, optional in the umbrella. `@better-iam/adapter-sqlite` is a root devDependency and an optional peer of the umbrella, `cli` and `testing`.
  - `link:` is an opt-in local loop, never used in CI.
  - The overrides go away once better-iam publishes.
- **`tests/iam-contract.test.ts`** pins every surface compute uses:
  - deny → `ACCESS_DENIED`; `UNKNOWN_ACTION` masking;
  - resolver echo and `RESOURCE_MISMATCH`;
  - the `authorizeMany` cap of 50;
  - `recordMany` idempotency and all-or-nothing behaviour;
  - `afterAudit` delivery with two IAM instances on one store, and that a throwing plugin blocks dispatch (which is why ours never throws);
  - `requestConfirmation` `INVALID_INPUT`;
  - session-JWT audience grants;
  - type shapes.

  `IamPort.capabilities()` feature-detects upstream changes.

### 12.11 Upstream better-iam changes (all proposed upstream; paths under `better-iam/`, `packages/` unless noted)

| ID | Class | Change | Needed for | Files |
|---|---|---|---|---|
| U0 | **required for co-hosting** | the console's `createOptions` merges `plugins` and `resolveResource` from an optional ESM module named by `BETTER_IAM_EXTENSIONS` (dynamic `import()` of an absolute path: no package dependency, no workspace cycle); `src/lib/iam.ts` passes the result through | pointing the better-iam console at compute's IAM database, including v0.4 remote mode when the IAM deployment is the console; v0.1–v0.3 avoid it with the §12.1 topology | `apps/console/better-iam.config.mjs:78-119`, `apps/console/src/lib/iam.ts` |
| R1 | conditional | **(a)** authentication runs under `pg_advisory_xact_lock_shared`, and the `sessions.lastSeenAt` touches move to a separate best-effort exclusive transaction, the way `refusable()` records its deny audit (`operations.ts:128-148`). **(b)** Decisions (`authorize*`, `listAccessible`, `sessionTokens.verify`, the second transaction of `sts.getCallerIdentity`) take the shared lock; the deny/root-override audit that `recordedDecision` appends inside the decision tx (`operations.ts:206-215`) moves to a second exclusive tx, batched per `authorizeMany`. Known writers: `currentPrincipal` does not write; `ctx.usage.record` is buffered (`usage.ts:122-143`); authentication does write (`principals.ts:116-118`, `auth/src/service/base.ts:1280-1283`). Maintainers confirm nothing else writes | only if the v0.1 IAM-lane benchmark shows lock wait >50% below the G5 admission rate (§16) | `adapter-postgres/src/index.ts:128-170`, `core/src/index.ts` (`IamStore.transaction`), `server/src/operations.ts:198-293`, `server/src/principals.ts:95-165,344-358`, `auth/src/service/base.ts:1195-1285`, `server/src/api/sts.ts:240-246`, `server/src/index.ts:614-634` |
| U3 | recommended | `IamPlugin.resolveResource` for a plugin's own types, consulted before `options.resolveResource` | removes the resolver half of the every-host footgun | `core/src/index.ts:513-527`, `server/src/decisions.ts:372-417`, `server/src/catalog.ts` |
| U4 | recommended | `identity:status`/`tenant:status` events; `sessionId` on `auth:session:revoke` | precise stream kills | `server/src/api/identities.ts:1424`, `server/src/api/tenants.ts:552`, `auth/src/service/sessions.ts:247`, `auth/src/service/base.ts:606` |
| Gap 2 | optional | `evaluate` with caller-supplied attributes for plugin-owned types | drops drafts and remote resolver I/O | `server/src/{operations,http,catalog,context-keys}.ts` |
| U8 | optional | trusted in-process callers can read the internal deny reason | no futile confirmation requests | `server/src/operations.ts:198-221` |
| U9 | optional | `agentId?` on `UsageInput` for trusted in-process callers | delegated usage under `groupBy 'agent'` (the tag fallback exists) | `server/src/billing.ts:697-714`, `server/src/api/billing.ts:3571-3588` |
| U6 | optional | adding a static `jwks` key doesn't move the watermark; per-subject `oidcProviders.revokeSessions` | workload identity (v0.5) only | `server/src/api/oidc-providers.ts`, `server/src/web-identity.ts` |
| U1 | optional | `createRemoteIam` satisfying `McpIam`/`A2aIam` | DX only | `client/src/index.ts`, `mcp/src/index.ts`, `a2a/src/gate.ts` |
| U5 / gap 16 | optional | `iam.events.record` + HTTP `audit.record` | compute security events in tenant chains | `server/src/{events,index}.ts`, `server/src/api/webhooks.ts` |
| Gap 6 | optional | `tenant.region` | residency | `server/src/context-keys.ts` |
| Gap 10 | optional | console extension points: extra nav areas, `ApiForm` transport/baseURL, `can()` chunked at 50 | a Compute area in the better-iam console (with U0) | `apps/console/src/lib/navigation.ts`, `apps/console/src/components/api-form.tsx`, `apps/console/src/lib/org.ts` |
| Gap 11 | optional | OAuth access token → session JWT | OAuth mutations | `oauth/src`, `server/src/api/sts.ts` |
| Gap 13 | optional | `enforceBudgets` on `recordMany` | `gpu.*` budgets enforced at record time | `server/src/api/billing.ts` |
| U2 | optional | subtree / plugin-writer managed registration | managed pickers via `listAccessible` | `server/src/api/resources.ts` |

### 12.12 Coordination with other sessions editing better-iam

1. **No better-compute session edits better-iam without the user's explicit go-ahead in chat** (D12). This plan only proposes.
2. When approved, re-read `better-iam/.claude/coordination.md`, check that nobody holds the files, then claim them there: `## Session <6hex> ("better-compute upstream: <ID>")`, with `Claimed:` listing exact files, symbols and tests.
3. **One upstream item per claim**, minimal and additive. Shared registries change by one-line inserts. Re-read shared files right before each edit, format only your own files, and announce full `vitest run`s.
4. Finish with a CHANGELOG `## Unreleased` bullet, docs, and a `SHIPPED (green at N files / M)` line. Then, with approval, pack, run `pnpm sync:iam` here and run the contract test; `capabilities()` turns the feature on.
5. Landing order:
   1. U0 (before any console co-hosting, and before v0.4 remote mode on the console);
   2. U3;
   3. U4;
   4. R1, if the benchmark justifies it;
   5. U6, only with workload identity;
   6. the optional items U8, U9, U1, gap 6.

## 13. Security model

**Boundaries.** client ↔ api; api ↔ IAM; api/worker ↔ gateway (internal mTLS); gateway ↔ daemon (compute PKI); site ↔ BMC VLAN; tenant ↔ tenant; tenant-owned or tenant-root node ↔ platform.

**Keys. No key does two jobs:**
- an offline root → per-region **node CA** (client certs only; KMS/Vault);
- the **gateway serving CA**;
- the internal control-plane CA;
- the **JoinService signing key** (`JoinResponse`) and **encryption key** (sealed join tokens), both pinned by install scripts;
- command/spec signing: a KMS root certifying 24 h worker keys (v0.2), rotated via the `Welcome` trust bundle (new key first, switch after 100% ack);
- exec tickets (v0.3); the workload issuer (v0.5); offline release signing.

Node keys sign only "this node says" statements: mTLS, CSR proof of possession, attested results, secret requests.

**Certs and attestors.** Certs are 24 h P-256 with a SPIFFE SAN and the role in the Subject OU (`bc-role:<role>`; no private OIDs, which Go's crypto/x509 cannot parse under a 2.25 UUID arc). `Renew` is verified by `api` with proof of possession. Revocation streams to gateways, which close sessions at once. Attestors: `join-token` (v0.1); `x509pop`, `provisioned`, `discovery` (v0.2); `cloud-iid` (v0.3); `tpm` via go-attestation **(verify fit)** (v0.5).

| Threat | Mitigation |
|---|---|
| Cross-tenant use; forged attributes | tenant pre-check before any DB access (no existence oracle, no outsider traffic on victim audit chains); tenant-view resolver; SQL tenant scoping; idempotency keys scoped to `(tenant, identity)`; authz-matrix negatives; attributes come only from compute's projection |
| Stolen join token / re-enrollment theft | short TTL, `maxUses` (default 1), `expect` binding; tokens hashed, revocable, and sealed to JoinService in transit; single-use `provisioned`/`discovery` tokens; reclaim needs `allowReclaim` + ≥2 identifiers; placeholder DMI keys need `expect` or approval; `DuplicateIdentity` quarantine |
| Compromised node | `nodeId` comes from the SAN only; secrets are bound to current work and sealed to per-request keys; 24 h certs + pushed revocation; its attested results speak only for itself |
| Compromised gateway | holds no CA or signing keys. **Can delay, drop or read; cannot forge intent** (commands/specs signed: destructive and access-changing from v0.2, all from v0.4), **identity** (Renew PoP and `JoinResponse` verified end-to-end; join tokens sealed), **attested results** (`node_sig`) **or secrets** (JWE). The daemon re-verifies tickets. v0.2 exit test: a forged wipe result is rejected |
| Compromised api / worker | admissions still need IAM decisions; tickets audited; worker keys 24 h, revocable by `kid`; quorum for fleet-wide destructive batches (v1.0) |
| Malicious BYO (`tenant-owned`) node | schedulable only in its owner's `custom` pools; the offering validator refuses to offer such pools to other tenants; never receives platform secrets or signed destructive platform commands; `dedicated` taints |
| Cross-tenant residue | GPU reset, memory clear **(verify)**, secure/crypto erase; idle-only MIG changes; VMs for multi-tenant hosts |
| PXE/DHCP spoofing | one lease-holding boot server per site, on isolated VLANs; HTTPS iPXE with a pinned CA where firmware allows **(verify)**; signed images verified by the cache |
| Agent overspend | delegation scope, `confirm[]` (v0.3), guardrails that also cover `extend` (§12.6), per-agent quotas by `agentId`, budgets, `agents.suspendAll` |
| Replay | command-id journal, `not_after`, `min_generation`, epoch fencing, the journal-lost rule, ticket `jti` sets, a Renew PoP replay cache |
| TLS-inspecting proxy (WS mode, v0.4) | WS only once all frames are signed; secrets as JWE; in-band gateway authentication; frame metadata stays visible (accepted) |

**Interactive access.** Instances use tickets (§7.6). Nodes get two paths:
- allowlisted command kinds via `commands.run`, audited;
- break-glass shells via `nodes.issueSshCert` (v0.3): short SSH certs from a compute SSH CA (TTL ≤ the activation and ≤1 h, recorded), issued only after `iam.require(compute:nodes:ssh-root)` with MFA.

**Tenant-root bare metal (v0.5).** A `dedicated-root` lease:
- sets `trust → tenant-controlled`;
- reissues the cert as `node-tenant` (telemetry and `leave` only; no secrets);
- makes inventory advisory;
- disables in-band BMC access where supported **(verify per vendor)**.

**Teardown is always BMC-driven from the site agent:**
1. power off;
2. boot the platform-signed ramdisk;
3. erase disks (attested);
4. GPU reset + ECC check;
5. verify firmware against the pool baseline (drift → reflash or quarantine);
6. rotate the BMC password;
7. reimage;
8. issue a **new identity generation** (the old cert is revoked);
9. run DCGM;
10. → `ready`.

Until TPM measured boot exists, it is offered only on vetted SKUs.

**Secrets, BMCs, workloads.**
- Postgres holds only `secret://` refs; the `local-sealed` store keeps ciphertext in `sealed_secrets`.
- `secrets.put` is write-only, and API replicas never read secrets back.
- Agents receive values only as JWEs to a per-request ephemeral key, after `api` checks the binding to the current step or allocation (§6). BMC rotation never returns a password through a relay (§3.5).
- BMC passwords are random per node and rotated at enrollment, at each tenant handoff and every 90 days. Vendor defaults and IPMI cipher 0 are disabled **(verify per vendor)**. The management VLAN is reachable only from site agents.
- Containers (v0.3) run only in single-tenant pools. IMDS (v0.5) is bound per instance with an IMDSv2-style token header.

**Supply chain and audit.**
- **Go:** vendored minimal deps, `govulncheck`, reproducible goreleaser builds, SBOM, cosign + Rekor, SLSA provenance (L3 by v1.0), and an offline-signed release manifest (`go-tuf` **(verify fit)**).
- **npm:** one `allowBuilds` source, frozen lockfile, `--provenance`, no install scripts.
- **Audit:** `audit_events` records every mutation with its admission context, plus commands, steps, tickets and security events. Signed hourly per-tenant Merkle checkpoints (v0.4) avoid better-iam's per-tenant chain-head serialization [ID §0], and `better-compute audit verify` checks them.

## 14. Observability & operations

**Metrics** (`better_compute_*`, no tenant labels, `maxSeries` 2000 [EXT §7]):
- gateway sessions and handshakes; `command_latency_seconds{kind,lane}`; `commands_swept_total{to}`;
- `work_queue_depth`, `reconcile_duration_seconds`, `generation_lag_nodes`;
- placements, `booking_conflicts_total`, `pool_gpus{state}`; `node_connectivity{state}`;
- outbox, usage and inbox backlogs; `usage_dead_letters_total`; `iam_inbox_spill_total`;
- **`iam_calls_total{op,outcome}`, `iam_call_duration_seconds{op}`** (lock acquisitions are derived per op, §8.6); `resolver_lookups_total{result}`;
- cert and serving-cert expiry; `clock_offset_seconds`; security events.

**Traces and logs:**
- `ComputeSpan`, shaped like better-iam's `IamSpan`;
- OTel `traceparent` stored on commands and steps;
- `X-Request-Id` forwarded to IAM;
- JSON logs;
- GPU telemetry straight to the operator's TSDB (P8).

**`selfCheck()` / `doctor [--strict] [--token]`:**
- **database:** migrations, `btree_gist`, PgBouncer mode, `compute_now()` is `now()` in production;
- **workers:** lease health, stuck queues, CommandSweeper lag, clock skew;
- **IAM:** the checks of §12.1, including the undelivered `auditHooks` backlog and the inbox spill;
- **usage:** backlog vs `closePeriod`, dead letters;
- **fleet:** gateway headroom, serving-cert expiry, daemon skew, cert expiry, stale heartbeats.

`bcd doctor` checks NVML, IOMMU, KVM, clock and reachability.

**Topologies.**
- **Dev:** `better-compute dev [--sim 50]` is one `all` process:
  - PGlite with serialized transactions;
  - embedded better-iam on better-iam's in-memory SQLite adapter (needs the optional `@better-iam/adapter-sqlite` peer and native `better-sqlite3`/`argon2` builds);
  - local CAs;
  - simulated daemons.
- **HA region:**
  - api ×3 (L7), gateway ×3+ (L4 passthrough), worker ×2+;
  - Postgres HA + PgBouncer, object store, OTLP/TSDB, KMS/Vault;
  - embedded IAM in api + worker. Compute is the IAM host family, and worker role `iam` runs IAM jobs. The better-iam console joins only after U0 (D19); the alternative is remote IAM (v0.4);
  - 2 site agents per site, one holding the boot lease.
- **Multi-site:** regional gateways; sites need only outbound 443.
- **Air-gapped:** local object store, image mirror, `bcd` downloads served from `downloads.dir`, local CAs, embedded IAM.

**Upgrades:**
1. expand migrations;
2. workers and api;
3. gateways, one at a time with `Drain`;
4. daemon waves within the disruption budget;
5. contract migrations in the next release.

## 15. Testing strategy

- **Unit** (root `tests/`, run against source):
  - exhaustive `(state, verb)` tables plus fast-check properties for every state machine (`ready` only after a verified wipe);
  - capacity math, scorers, seeded planning;
  - inventory hashing, `gpu-models.json` mapping, XID classification;
  - protocol golden frames shared with Go;
  - the method → action registry vs the catalog.

  Type tests cover client inference through modules and plugins, `DriverKinds` merging and `manifest.Infer`.
- **Store conformance + torture.** These run on real Postgres only (`BETTER_COMPUTE_POSTGRES_URL`, fresh schema per case), and every locking or fencing test is Postgres-only. Cases:
  - exclusion and extend conflicts via `ON CONFLICT DO NOTHING`; atom-rule overlap;
  - guarded counters and quota;
  - lease takeover with `FOR SHARE`; the work-queue `gen` race;
  - outbox xmin ordering under a long concurrent tx;
  - `SKIP LOCKED` dispatch across 3 fake gateways; dispatch vs `Hello` on the session-row lock;
  - stale-epoch routing writes rejected; late results accepted; `observed_generation` never regresses.

  **The 5-minute torture test** runs 8 placers (2 of which ignore locks and leases) plus extends, releases, cordons, taint writes, concurrent `healthy=false` flips and MIG repartitions. Afterwards it recomputes overlaps in a constraint-free shadow copy, checks quota sums, and checks that every booking's node and atoms were schedulable at commit.

  PGlite (one serialized connection) runs the non-concurrent subset. Its `btree_gist` is believed available as `@electric-sql/pglite/contrib/btree_gist` **(verify P0)**; if not, a trigger fallback is used and flagged by `doctor`.
- **Protocol + skew.** A real `bcd -tags fakehw` runs against an in-process gateway. Cases:
  - duplicate delivery;
  - resume after a gateway kill with commands in every state;
  - daemon kill between side effect and ack;
  - **journal loss** (non-retry-safe in-flight commands fail, not replay);
  - `node.reboot` completing on rejoin;
  - `BUSY` re-queue;
  - rejections; wrong patch base;
  - Renew without PoP rejected;
  - (v0.2) tampered or unknown-`kid` commands, gateway-forged `CommandUpdate`/`AllocationBound`, and a `SecretResponse` that the gateway cannot open.

  Go fuzzing covers the decoders. The skew matrix comes from release artifacts.
- **Fleet simulator.**
  - *TS deterministic* (`@better-compute/testing/fleet-sim`). It runs on PGlite, with `compute_now()` bound to `compute_sim_clock`, which the sim clock advances on every tick. The in-process control plane runs with **seeded RNG**, stepped by `compute.jobs.*.tick()`. `FakeDaemon` speaks the protocol, and an in-memory `FrameConn` injects drops, stalls, half-open links and partitions. 1k–5k nodes per PR, with every failure reproducible from its seed.
  - *Real-time harness* (`tests/realtime/`, v0.1): Postgres + FakeDaemons over real gRPC, on the wall clock. It measures latency p99s, which the fake-clock sim never does.
  - *Real daemons* (`bcd sim --nodes 10000`, v0.4): real TLS/gRPC to real gateways and Postgres through Toxiproxy, nightly.
- **Invariants:**
  - **I1** no overlapping bookings or node-reported assignments;
  - **I2** at most one execution per command; after a journal loss, non-retry-safe in-flight commands fail rather than replay;
  - **I3** convergence within T;
  - **I4** no liveness false positives, including under gateway clock skew;
  - **I5** no allocation released only because a node disconnected;
  - **I6** latency SLOs (real-time harness only);
  - **I7** nothing pending that an offline solver can place;
  - **I8** billing conservation: Σ usage = Σ booking duration × atoms, with no duplicate keys, including when an identity is deleted before the usage flush.
- **Sim scenarios:**
  - v0.1: gateway kill mid-command; journal loss; identity deleted before the usage flush; the compute inbox down, where IAM dispatch still reaches other subscribers while spill and backlog metrics rise.
  - v0.4: 10k cold start ≤3 min; kill 1 of 3 gateways → reconnect in <60 s with 0 unreachable marks and 0 duplicate executions; a zombie gateway self-fences in <20 s; DB failover and 10 min site partitions release nothing; 200 placements/s for 30 min with I1 intact; an XID storm trips the breaker; a bad daemon build halts its canary.
- **Hardware emulation** (v0.2+, `hack/emulation`):
  - Redfish via **sushy-tools** (libvirt driver) over QEMU VMs; IPMI via **virtualbmc**;
  - PXE on an isolated libvirt network served by `bcd site`;
  - a matrix of OVMF UEFI, legacy BIOS, UEFI HTTP boot, virtio and NVMe disks.

  GPUs aren't emulated. The NVML mock covers logic, a self-hosted real-hardware nightly covers VFIO/CDI/XID, and rented A100/H100 cover MIG before the v0.5 exit. Providers use undici `MockAgent` record/replay. KVM on GitHub-hosted runners is **(verify)**; plan for self-hosted.
- **IAM and security.**
  - `computeFixture()`, built after `organizationFixture`: PGlite, embedded better-iam on its in-memory SQLite adapter, root + two orgs, sim clock.
  - `tests/iam-contract.test.ts`.
  - **`scripts/authz-matrix.mjs`** generates one test per §9.2 row: the declared action/resource, cross-tenant denial, guardrail denial and list fail-closed. It fails CI on undeclared or uncatalogued methods. Its negatives:
    - cross-tenant replay of a known idempotency key returns no data and creates no draft;
    - the same key from a second identity in the same tenant does not collide;
    - 72 h + extend 1 h is denied;
    - a delegated extend above 4 GPUs is denied.
  - Token-leak scanners, `govulncheck`, `pnpm audit`.
- **Extensions, e2e, benchmarks, packaging.**
  - Per-contract conformance suites and the §5.6 walkthroughs.
  - Nightly `examples/emulated-site` runs flows (a)–(d) in both IAM modes.
  - `pnpm bench:scale` on `bench/REFERENCE.md` hardware from v0.1 measures gateway streams per process, **the embedded IAM lane on adapter-postgres in lock acquisitions/s** (counting list denials as audit-chain writes; the R1 evidence) and placements/s.
  - Packed smoke of the umbrella with vendored better-iam.

## 16. Roadmap

A phase closes only when its exit tests are green in CI. `bench/REFERENCE.md` defines the reference hardware: gateway 8 vCPU / 32 GiB; Postgres 17 on 16 vCPU / 64 GiB NVMe.

**P0: Scaffold.**
- *Deliverables:*
  - git installed and `git init` (D6);
  - a workspace mirroring better-iam (`docs/research/` already exists);
  - scripts, including `check-deps`, `check-sql-now`, `umbrella`, `sync-better-iam`, `proto-gen`, `authz-matrix`;
  - vendored better-iam;
  - packages: `core`; `protocol` (TS + Go gen committed); `postgres` (+`./pglite`, `compute_now()`); shells of `server`, `client`, `cli`, `testing`; **stubs of `inventory`, `provision`, `metal`, `vps`**; the umbrella with all four named subpaths;
  - a `daemon/` skeleton + goreleaser config, building with `-tags nonvml,fakehw` on Windows;
  - CI (ubuntu+windows × Node 22/24, Postgres, Go); the IAM contract test; `bench/REFERENCE.md`.
- *Day-one verifications:* PGlite `btree_gist`, the go-nvml mock, relative overrides, the KVM runner, CDI on target hosts.
- *Exit:*
  - `pnpm check` green on the matrix, including `umbrella --check`;
  - `buf breaking` against git history or the committed `proto/baseline.binpb`;
  - packed smoke importing `better-compute/{inventory,provision,metal,vps}`;
  - **freeze** `agent/v1`, the `core` contracts, the v0.1 schema and the v0.1 rows of §9.2.

**v0.1: Adopt & reserve.** Parallel sessions work on the frozen contracts; `proto/` has one writer at a time.
- *Workstreams:*
  - **W1, Go daemon:** join (sealed token, `JoinResponse` verification), session, journal (`journal_id`, `running{boot_id}`), Renew with PoP, NVML/fakehw inventory, `devices`/`access` convergence, CDI `hold`, `diag.nvml`, self-terminating `node.reboot`; release artifacts and the install script.
  - **W2, gateway + PKI:** mTLS sessions; the serving CA + `pki issue-gateway`; epoch fencing; age-based liveness batching; dispatch by join with the session-row lock; resume with the journal-lost and self-terminating rules; `BUSY` re-queue; local CAs; the `join-token` attestor; `JoinService` (sealed tokens, signed `JoinResponse`, `hardware_key`, `node_sessions` insert); the downloads route.
  - **W3, store + capacity + inventory:** schema, `compute_now()`, work queue, outbox, leases, `workers`, CommandSweeper, `InlinePlacer` with guarded statements and savepoints, atoms, rollups, `gpu-models.json`, conformance + torture.
  - **W4, IAM bridge:** the normative catalog, plugin + inbox (never-throw spill), projection + resolver, `embedded()`, IAM jobs under worker role `iam`, flag cache, usage sink with poison isolation, IamReconcile, contract test, authz matrix.
  - **W5, server + client + CLI + sim:** `operation()` with the tenant pre-check and owner-scoped idempotency, the method → action registry, the bold groups of §9.2, async-with-wait, the typed client, the CLI (`dev`, `iam setup`, `daemon install-script`, `pki issue-gateway`), the deterministic simulator with sim clock, the real-time harness.
- *Acceptance:*
  - a real `bcd` installed by the install script (NVML mock 8×H100, or one GPU box) and 3 FakeDaemons join and match the golden inventory;
  - an org user reserves 4 GPUs from an offered pool; the CDI spec lists exactly the booked UUIDs, which `reservations.get` returns;
  - `ReserveBoundedH100` allows 8 GPUs and denies 9, and `BoundedExtend` denies 72 h + 1 h;
  - `gpu.h100.hours` shows in `iam.billing.spend` without duplicates across worker restarts, even with a deleted identity in a batch;
  - place-to-active p99 <2 s with 1k FakeDaemons in the real-time harness;
  - no upstream better-iam change (the §12.1 supported topology).
- *Exit tests:*
  - `tests/e2e/spine.test.ts`;
  - `tests/capacity-concurrency.test.ts` (1,000 concurrent reservations + cordons + taints + `healthy` flips + releases, never double-booked) and the torture test;
  - `tests/sim/faults-1k.test.ts`: gateway kill mid-command → no duplicate execution; journal loss → failed, not replayed; reboot completes on rejoin; I1, I2, I5, I8.
- *Security negatives:*
  - cross-tenant requests never return data or create drafts, including a known-key replay;
  - **an IamPort spy records zero IAM calls on heartbeat, inventory and command paths over a 10-minute simulated run**;
  - the authz matrix is at 100%; a resolver timeout denies; a failed `authorizeMany` fails the list;
  - join tokens honour `maxUses` (default 1) and TTL;
  - node A's cert can't get node B's spec; Renew without a valid PoP is rejected;
  - support bundles hold no tokens.
- *Gates:*
  - **Gateway:** one Node gateway holds ≥5,000 mTLS sessions at 10 s heartbeats for 30 min, with dispatch p99 <500 ms and RSS <2 GiB. Otherwise D20 is taken before v0.2.
  - **IAM lane:** embedded IAM on adapter-postgres sustains ≥50 admissions/s (authenticate + require, ≈150 lock acquisitions/s) with lock wait <50%, and the measured ceiling is recorded in acquisitions/s. If the ceiling is below G5's 200 admissions/s (≈600 acquisitions/s), R1 is proposed (D18).
  - Placements/s recorded; packed smoke.

**v0.2: Metal.**
- *Deliverables:*
  - `bcd site` + `bcd ramdisk`; `provision` + `metal()`;
  - `siteTokens` + the SiteBoot lease; `discovery`/`provisioned`/`x509pop` attestors; `joinRequests`;
  - signed destructive commands + the trust bundle; node-signed attested results;
  - `SecretRequest`/JWE, the `secrets` API and BMC rotation;
  - image catalog + site caches; FleetConfig plan/apply;
  - XID/health classification and `diag.dcgm` acceptance; the revocation-push SLA;
  - emulation CI; walkthrough 1 (Ubuntu autoinstall).
- *Acceptance:*
  - 20 consecutive unattended enroll → ready → deployed → released → ready loops on UEFI and BIOS VMs;
  - killing the site agent or the worker mid-deploy resumes cleanly;
  - every `ready` follows a verified wipe.
- *Exit:*
  - `metal-lifecycle`, `metal-chaos`;
  - killing the active site agent mid-PXE → the standby takes over boot within 30 s;
  - site agents refuse other sites' steps;
  - a gateway-forged wipe result or `AllocationBound` is rejected;
  - a `SecretResponse` can't be opened with another key or after its TTL;
  - unsigned images are rejected; the ramdisk cert can't open a `node` session; unsigned destructive commands are rejected;
  - a revoked node disconnects within 5 s.

**v0.3: VPS & access.**
- *Deliverables:*
  - `vps()` (libvirt-kvm, cloud-hypervisor, overcommit, IPAM);
  - `provider-hetzner` (`agent:'none'` pools; `bootstrap` for Robot);
  - single-tenant containers;
  - tunnels with daemon-verified tickets, `nodes.issueSshCert`, the `access` section;
  - webhooks + SSE; `mcp`; **delegated confirmation** (§3.4 step 7); `cloud-iid`;
  - walkthroughs 2 and 3 (Talos).
- *Acceptance:*
  - 200-instance churn on 3 emulated hosts **with no leaks**: zero orphan libvirt domains, overlays, taps, IP leases or bookings, checked by diffing daemon-reported inventory against the DB;
  - host loss recreates instances per policy;
  - an agent reserves via MCP with human confirmation, retrying with the same key.
- *Exit:*
  - `tests/e2e/vps.test.ts`;
  - a replayed ticket is rejected by gateway and daemon;
  - `delegation:revoke` closes the agent's stream within 5 s;
  - multi-tenant container offers are rejected;
  - no tenant VM runs `bcd`.

**v0.4: Scale & HA.**
- *Deliverables:*
  - `PoolLeasePlacer`; shard rebalancing; multi-gateway peering;
  - WS fallback (signed frames only); A/B self-update + Rollout; `bcd helper`;
  - signing of all commands and specs;
  - remote IAM (`remoteIam`, `computeIamHost`, `replicaProjection`, `postgresInbox`), with U0 landed if the IAM deployment is the better-iam console;
  - partitioned history; Merkle audit checkpoints; `bcd sim`; R1 if the benchmark demands it.
- *Acceptance at 10k nodes / 100k GPUs:*
  - cold start <3 min; gateway-kill recovery <60 s; 0 false unreachable;
  - ≥200 placements/s; command p99 <1.5 s with polling only;
  - Postgres CPU <50% on the reference Postgres;
  - suites green in both IAM modes.
- *Exit:* all §15 v0.4 scenarios green on 3 consecutive nights.

**v0.5: GPU depth & ecosystem.**
- *Deliverables:* MIG/timeslice/MPS atoms; calendar reservations + BookingRepair; gang scheduling; spot; `dedicated-root` metal and `binding:'node'`; TPM attestor; optional workload identity; bcx + `driver-sdk`; `provider-proxmox`; console-kit + `apps/console`; walkthrough 4; **sandboxes** (§3.7: templates, TTL, warm pools, snapshots, exec over SSH certificates).
- *Exit:*
  - `tests/e2e/sandboxes.test.ts`:
    - 500 sandboxes expire on emulated hosts with the same zero-leak diff as v0.3;
    - a warm claim reaches `ready` without a placement;
    - a snapshot round trip restores memory state;
    - another tenant's snapshot is refused;
    - instance methods on a sandbox's instance are refused;
  - the MIG torture test and the real-hardware nightly;
  - a `dedicated-root` lease and release yield a new identity generation;
  - a third-party TS driver runs on a node via bcx;
  - IMDS cross-instance access fails.

**v1.0: Freeze.**
- *Deliverables:* API/proto freeze; the N−2 skew guarantee; generated docs; an external security review; SLSA L3; npm publish with provenance after better-iam publishes.
- *Acceptance:* upgrading from v0.5 disturbs no running allocation; no open critical or high findings.

## 17. Decisions needed from the user

| # | Decision | Recommended default |
|---|---|---|
| D1 | Go daemon (a second language in the repo) | **Yes**, `daemon/` in this repo |
| D2 | Default IAM mode | **Embedded**; remote in v0.4 |
| D3 | Storage | **compute's store is Postgres/PGlite only** (Postgres ≥16, CI on 17); the embedded IAM dev/test store is better-iam's SQLite adapter |
| D4 | gRPC bidi + gateway tier | **Yes**; WebSocket fallback in v0.4, signed frames only |
| D5 | v0.1 excludes PXE, VPS, containers and agent confirmation | **Yes** (confirmation v0.3; x509pop, XID, DCGM v0.2) |
| D6 | git (not on PATH), `git init`; GitHub org/repo | **Done in P0** with GitHub Desktop's bundled git (no system install); `better-compute/better-compute` (confirm availability) |
| D7 | npm scope, license | `@better-compute/*`, **Apache-2.0** including Go, matching better-iam (which moved from MIT to Apache-2.0); Daytona (AGPL) for patterns only |
| D8 | First provider | **Hetzner** (Cloud + Robot), then Proxmox |
| D9 | Quota semantics for future reservations | **Conservative**: count all non-terminal |
| D10 | Default GPU binding | **`hold`** (CDI), consumed by an operator-run workload manager in v0.1 |
| D11 | Tenant BYO nodes in v1 | **Yes**, behind `compute.byo-nodes`, as `trust='tenant-owned'` in `custom` pools only |
| D12 | May better-compute sessions land upstream items via `coordination.md`? | **Yes after v0.1**, one item per claim, each approved in chat; U0 first |
| D13 | May `sync-better-iam` run `pack:all` inside better-iam? | **No by default**; copy existing artifacts |
| D14 | Billing basis | **Reserved time**, not utilization |
| D15 | Lab hardware and CI | one NVIDIA box + a self-hosted KVM runner + the `bench/REFERENCE.md` machines; rented A100/H100 before the v0.5 exit |
| D16 | Console location | own `apps/console` + console-kit (v0.5) |
| D17 | Production CA/KMS | **Vault PKI + transit**, then AWS KMS |
| D18 | Propose R1 upstream | **Only if the v0.1 IAM-lane ceiling is below G5 with lock wait >50%** |
| D19 | Co-host the better-iam console on compute's IAM database | **Only after U0**; until then compute is the only IAM host family (§12.1) |
| D20 | Rewrite the gateway in Go | **Only if the v0.1 Node gateway gate fails**; decided before v0.2 starts |
| D21 | Billing of whole-node leases (`binding: 'node'`, v0.5) | **`node.metal.hours` plus `gpu.<model>.hours` for the GPUs healthy at each window's start**; unhealthy atoms are booked only to exclude others and show as the `UnhealthyAtoms` condition. Spot + `binding: 'node'` is refused. One pricing function (`billableLines`) |
| D22 | Default placer | **Inline** (synchronous admission); the batched `pool-lease` placer is opt-in and recommended for production (`capacityModule({ placer: 'pool-lease' })`), revisited at the v0.4 exit after a real Postgres run |
| D23 | Next.js major for `apps/console` | **15.x** (better-iam's `@better-iam/next` peers `next ^15`); `apps/docs` follows better-iam's docs on 16.x |
| D24 | Sandboxes: §1 lists "a sandbox product" as a v1 non-goal, but the product direction relayed from the user (2026-09-24, via the docs session) is "GPU, CPU and sandbox capacity" | **Decided (user, 2026-09-24, relayed by the docs session): yes.** The §1 non-goal is dropped; sandboxes are a `sandboxes` group on `vps()` (§3.7, §9.2, v0.5): templates, TTL auto-delete through the instance lifecycle, warm pools of paused instances claimed after admission, snapshots via the runtime driver, exec over tunnel + short-lived SSH certificates (no in-guest agent), microVM runtime by default; no new placement or tenancy path. Owner: [097b34] |

Implementation notes (2026-09-24), recorded where the code settled a question the plan left open:
- **Two-round joins.** An attestor may return an `AttestationDeferral` (`approval` for discovery → `joinRequests`, `challenge` for tpm credential activation). JoinService commits the attestor's rows, issues nothing, and answers with a signed, CSR-bound `JoinResponseBody.deferral` (agent/v1 field 9). Attestors consume tokens and single-use evidence only on the final round.
- **Per-input actions.** A method may name an alternative's own action on its resource (`MethodResource.action`, e.g. `tunnels.open` on a node decides `compute:nodes:console`). The envelope refuses any `(action, resource)` pair its §9.2 row does not list.
- **Default secret store.** Without `ComputeOptions.secrets`, `ctx.secrets`, the `secrets` group and the secret broker use `sealed_secrets` in the compute database, sealed under the deployment secret (pki `localSealedSecretStore`).
- **Revocation push.** Each gateway runs pki's `createRevocationFeed`, which polls `node_certs.revoked_at` with a look-back window; every revocation path is covered without events, and a revoked node disconnects in about 1 s.

## 18. Risks & mitigations

| Risk | L / I | Mitigation |
|---|---|---|
| IAM's serialized lane throttles admissions or reads | Med / High | P7; ≥2 acquisitions per admission, accounted for; auth and read caches; flag cache; SQL pre-filtered lists; `recordMany` ≤200; `iam_call_duration` alerts; v0.1 gate in acquisitions/s; R1 (auth + decisions on the shared lock) |
| A compute outage stalls the IAM host's whole event pipeline (`afterAudit` head-of-line blocking) | Med / High | `afterAudit` never throws (2 s timeout, bounded spill); `postgresInbox` in the IAM DB for remote mode; doctor/alert on the undelivered `auditHooks` backlog; IamReconcile; contract test |
| The better-iam console shares the IAM DB before U0 (rejects `compute:*` policies, swallows events) | Med / High | supported topology (§12.1), D19, doctor catalog check, U0 first in the landing order |
| Slow resolver stalls all IAM operations | Med / High | memory-resident projection; 20 ms fail-closed miss; gap 2 later |
| An IAM host lacking plugin/resolver denies or loses events | High / Med | required plugin + inbox; `computeIamHost`; doctor probes per host; U3 |
| better-iam changes while unpublished | High / Med | vendored snapshots, contract test, `capabilities()`, resync only when green |
| Node gateway holds fewer streams than planned | Med / Med | v0.1 gate; more gateways; Envoy offload; Go gateway on the same proto (D20) |
| Compromised gateway forges node identity or results | Low / Critical | Renew PoP verified by `api`; signed `JoinResponse`; sealed join tokens; `node_sig` on attested results; signed commands; JWE secrets |
| Duplicated or lost commands (BUSY, journal loss, reboots) | Med / High | `BUSY` → pending; journal-lost rule; self-terminating completion on rejoin; CommandSweeper; I2 in the sim |
| Clock skew or fake-clock drift breaks expiry | Low / Med | `compute_now()`; `check-sql-now` lint; age-based liveness; `ClockSkew` condition |
| DMI placeholder values collide on brownfield boards | Med / Low | `hardware_key` with a blocklist; partial unique index on trusted keys; `expect` or approval **(verify on lab hardware)** |
| PGlite lacks `btree_gist` | Med / Low | verify in P0; trigger fallback; concurrency tests only on Postgres |
| Two languages; cgo on Windows | High / Med | proto-first, committed gen, golden vectors, dumb daemon; Docker/WSL2; `nonvml,fakehw` |
| MIG/fractional semantics wrong on hardware | Med / Med | atom rule; idle-only repartition; real-hardware gate |
| A bad rollout drains the fleet | Med / High | disruption budgets, circuit breaker, canaries, A/B rollback |
| Firmware persistence after tenant-root leases | Med / Critical | BMC-driven teardown, firmware verify, BMC isolation, TPM, vetted SKUs |
| Emulators miss BMC quirks | High / Med | bmclib vendor drivers, quirks registry, staging rack before GA |
| Billing drift, poison events or closed periods | Low / Med | idempotency keys; bisect/per-event fallback; successor or tenant attribution; I8; hourly flush; dead letters + alert; `createInvoiceItem` |
| Scope creep into orchestration or framework | Med / Med | non-goals; packages per phase; trimmed v0.1; bcx deferred to v0.5 |

## Appendix — references

**better-iam** (local, read-only), under `C:\Users\Sean Filimon\Desktop\better-iam\packages\` unless noted:
- `adapter-postgres/src/index.ts:128-170`; `adapter-sqlite/src/index.ts:346`
- `server/src/operations.ts:120-330`, `decisions.ts:372-692`, `events.ts:98-250`, `principals.ts:87-165`, `usage.ts:55-150`, `temporary-credentials.ts:315-375`, `context.ts:232-241`, `catalog.ts:445-525`, `billing.ts:697-714,785-809`, `billing-service.ts:490-540`, `agents.ts:307-378`, `index.ts:605-715`, `options.ts:271-273`, `sync.ts:160-164`, `utils.ts:4`
- `server/src/api/billing.ts:3567-3599`, `api/sts.ts:232-261`, `api/features.ts:90-150`, `api/policies.ts:24-57`, `api/relationships.ts:42-45`, `api/catalog.ts`, `api/bindings.ts`, `api/delegations.ts:1418-1467`, `api/resources.ts`, `api/oidc-providers.ts`
- `auth/src/service/base.ts:1195-1285`
- `core/src/index.ts:449-527`, `core/src/policy.ts:112-116,414-447`, `core/src/audit.ts:66`, `core/src/storage.ts:447`
- `a2a/src/gate.ts:35`; `cli/src/index.ts:18-60`, `cli/src/profiles.ts:46-78`
- `apps/console/better-iam.config.mjs:78-158`, `apps/console/src/lib/iam.ts`, `apps/console/package.json`
- `docs/{extensions,billing,events,agents,temporary-credentials,privileged-access,hosts-and-regions,protocols}.md`; `.claude/coordination.md`

**Daytona** (v0.190.0; archived June 2026):
- https://github.com/daytonaio/daytona
- https://github.com/daytonaio/daytona/blob/v0.190.0/apps/api/src/sandbox/runner-adapter/runnerAdapter.ts
- https://github.com/daytonaio/daytona/blob/v0.190.0/apps/api/src/sandbox/entities/job.entity.ts
- https://github.com/daytonaio/daytona/blob/v0.190.0/apps/runner/pkg/runner/v2/poller/poller.go
- https://www.daytona.io/docs/en/architecture
- https://www.daytona.io/docs/en/runners/
- https://www.daytona.io/docs/en/regions/
- https://www.daytona.io/docs/en/limits
- https://www.daytona.io/docs/en/bring-your-own-compute/
- https://www.daytona.io/changelog/job-based-runners-custom-regions
- https://pkg.go.dev/github.com/daytonaio/daytona/pkg/provider
- https://deepwiki.com/daytonaio/daytona/13.6-runner-api-reference

**Bare metal:**
- https://canonical.com/maas/docs/3.7/explanation/the-machine-life-cycle/
- https://canonical.com/maas/docs/latest/explanation/controllers/
- https://deepwiki.com/tinkerbell/tinkerbell
- https://tinkerbell.org/docs/services/rufio/
- https://docs.openstack.org/ironic/latest/user/states.html
- https://docs.openstack.org/ironic/latest/admin/interfaces/boot.html
- https://docs.openstack.org/ironic/2025.2/install/enabling-drivers.html
- https://github.com/metal3-io/baremetal-operator/blob/main/docs/baremetalhost-states.md
- https://docs.siderolabs.com/talos/v1.8/networking/siderolink
- https://github.com/theforeman/smart-proxy
- https://github.com/bmc-toolbox/bmclib
- https://robot.hetzner.com/doc/webservice/en.html
- https://docs.equinix.com/metal/eos-faq/

**Virtualization:**
- https://linuxcontainers.org/incus/docs/main/authentication/
- https://pve.proxmox.com/wiki/Proxmox_VE_API
- https://github.com/firecracker-microvm/firecracker/blob/main/docs/getting-started.md
- https://github.com/cloud-hypervisor/cloud-hypervisor/blob/main/docs/api.md

**GPU:**
- https://kubernetes.io/blog/2025/08/27/kubernetes-v1-34-release
- https://docs.nvidia.com/datacenter/cloud-native/gpu-operator/latest/gpu-sharing.html
- https://docs.nvidia.com/datacenter/cloud-native/gpu-operator/latest/dra-cds.html
- https://docs.nvidia.com/datacenter/dcgm/latest/reference/command-line-reference/dcgmi/dcgmi-diag.html
- https://github.com/NVIDIA/dcgm-exporter
- https://docs.nvidia.com/deploy/xid-errors/archive/index.html
- https://github.com/NVIDIA/go-nvml
- https://github.com/rust-nvml/nvml-wrapper
- https://slurm.schedmd.com/gres.html

**Schedulers and agents:**
- https://kubernetes.io/docs/concepts/architecture/leases/
- https://kubernetes.io/docs/reference/access-authn-authz/kubelet-tls-bootstrapping/
- https://developer.hashicorp.com/nomad/docs/concepts/plugins/devices
- https://developer.hashicorp.com/nomad/docs/concepts/scheduling/scheduling
- https://developer.hashicorp.com/nomad/docs/configuration/server
- https://developer.hashicorp.com/nomad/docs/job-specification/disconnect
- https://github.com/hashicorp/go-plugin
- https://docs.skypilot.co/en/stable/examples/auto-failover.html
- https://docs.vast.ai/host/hosting-overview

**Transport and identity:**
- https://goteleport.com/docs/reference/architecture/agents/
- https://goteleport.com/docs/reference/deployment/join-methods/
- https://github.com/gravitational/teleport/blob/master/rfd/0069-proxy-peering.md
- https://tailscale.com/docs/reference/derp-servers
- https://github.com/spiffe/spire/blob/main/doc/spire_agent.md
- https://connectrpc.com/docs/node/server-plugins/
- https://www.recall.ai/blog/postgres-listen-notify-does-not-scale

**Daemon runtimes:**
- https://nodejs.org/api/single-executable-applications.html
- https://bun.com/docs/bundler/executables
