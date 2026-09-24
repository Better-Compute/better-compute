# @better-compute/testing

The testing kit for better-compute: a control-plane fixture, the sim clock and a scripted IAM
port, plus the daemon side of the agent protocol in TypeScript and a deterministic fleet
simulator. Tests run against PGlite, so no database server is needed.

**Status: v0.1 in progress.** `computeFixture()`, `closeFixtures()` and `fakeIam()` work (P0).
`FakeDaemon`, `FrameConn` links with fault injection, fake hardware, `createFleetSim()` with the
in-memory `GatewayStub`, and the invariant checkers I1, I2, I5 and I8 work (W5b). Embedded
better-iam in the fixture and the real-time harness come next (PLAN.md §15).

It needs the optional peer `@electric-sql/pglite` as a devDependency. Without it,
`computeFixture()` fails with `MISSING_DEPENDENCY`.

```ts
import { afterEach, expect, it } from 'vitest';
import { closeFixtures, computeFixture } from 'better-compute/testing';

afterEach(closeFixtures);

it('asks IAM before reading a node', async () => {
  const { request, iam, tenants, advance } = await computeFixture();
  iam.allow({ token: tenants.acme.token, action: 'compute:nodes:read' });
  const input = { tenantId: tenants.acme.id, nodeId: 'node_01jz0000000000000000000000' };
  const answer = await request('inventory', 'get', input, { token: tenants.acme.token });
  expect(answer).toMatchObject({ ok: false, error: { code: 'NOT_IMPLEMENTED' } }); // until v0.1
  expect(iam.count('authorize')).toBe(1);
  await advance(60_000); // compute's Clock and compute_now() both move one minute
});
```

## `computeFixture(options?)`

It builds `betterCompute()` on an in-memory PGlite store, runs `compute.initialize()` (the
registry check, then the base schema and every module's and plugin's migrations) and returns:

| Field                                      | What it is                                                             |
| ------------------------------------------ | ---------------------------------------------------------------------- |
| `compute`                                  | The initialized control plane, typed by `modules` and `plugins`        |
| `database`                                 | The migrated PGlite `SqlExecutor` behind it                            |
| `clock`, `advance(ms)`                     | The fixture clock (below)                                              |
| `iam`                                      | The `fakeIam()` port compute calls (below)                             |
| `tenants`                                  | `root`, `acme` and `other`: each `{ id, token, caller }`               |
| `request(group, method, input?, options?)` | A `POST {basePath}/{group}/{method}` through `compute.handler` (below) |
| `close()`                                  | Stops compute and closes the store; idempotent                         |

Options:

- `clock`: `'sim'` (the default) or `'system'`;
- `start`: where the sim clock starts, in whole milliseconds since the epoch (default
  2026-01-01T00:00:00Z);
- `iam`: `fakeIam()` options, added to the three tenants' callers;
- `modules`, `plugins` and `log`: passed to `betterCompute()`.

**The tenants.** The fixture mirrors better-iam's `organizationFixture`: a platform (root) tenant
and two organizations, `acme` and `other`, each with one signed-in person. The root caller has
MFA, like a root administrator. `tenants.root.id` is the server's `rootTenantId`. The IAM allows
nothing until a test adds a rule.

**The sim clock.** Under `clock: 'sim'`, compute's `Clock` and SQL's `compute_now()` read the
same time, P9 in PLAN.md. The fixture points `compute_now()` at `compute_sim_clock` with
`useSimClock` from `@better-compute/postgres`. Then:

- `advance(ms)` and `clock.set(ms)` move the table first and the TypeScript clock second. Leases,
  `not_before`, column defaults and admission contexts all move together.
- Moves run one at a time, and time never moves backwards: a refused move changes neither clock.
- Under `clock: 'system'`, compute uses the wall clock, `compute_now()` is the database's `now()`,
  and `advance` rejects with `INVALID_STATE`.

**`request()`** sends `input` as JSON with the CSRF headers the server requires. The options are:

- `token`, sent as `Authorization: Bearer <token>`;
- `plugin`, which routes to `plugins/{plugin}/{group}/{method}`;
- `headers`, which replace the defaults they name, for example to test `CSRF_REJECTED`.

It answers `{ ok, status, headers, requestId }`, plus `data` when `ok` or `error` (`{ code,
message, … }`) when not.

**`closeFixtures()`** closes every fixture that is still open, even when one of them fails; use
it with `afterEach`. A fixture that fails to initialize closes its store before it rethrows.

## `fakeIam(options?)`

This is a scripted `IamPort`. It stands in for the IAM bridge's `embedded()` until v0.1. After
that it remains the tool for tests that count IAM calls, such as the P7 "zero IAM calls on fleet
paths" spy.

- **Callers.** Bearer tokens map to callers: `options.callers`, or `addCaller(token, caller)`
  later. An unknown token is `UNAUTHENTICATED`. `tokenOf(credential)` reads a credential's token,
  bearer header or IAM cookie.
- **Decisions.** A decision is allowed only when an `allow` rule matches and no `deny` rule does.
  A rule matches on any of `token`, `tenantId`, `action`, `type` and `id`, and `{}` matches
  everything. A denied `require` is `ACCESS_DENIED`.
- **Recording.** Every call is recorded in order in `calls`, with its method, token, credential
  and decision. `count(method)` counts them and `reset()` forgets them.
- **The rest.** `billingCheck` allows, `recordUsage` records every event, `featureEnabled` is
  false, and `requestConfirmation` answers `'not-held-back'`.

## Deterministic plumbing

- `createSimScheduler({ start })`: a manual clock plus a timer heap. Tasks run in (time,
  insertion) order, one at a time; a task that returns a promise is awaited before the next one,
  so an async (DB-backed) participant stays deterministic if it uses the scheduler for its timers.
  `onTime(hook)` moves another clock along (for example `fixture.clock.set`, which moves
  `compute_now()`). `createRealtimeScheduler()` is the `setTimeout` version for the real-time
  harness.
- `createRng(seed)`: seeded `sfc32`; `fork(label)` derives an independent stream without consuming
  the parent's, so adding a node never shifts another node's draws.
- `EventLog`: every notable action as `<t> <source> <event> k=v…` lines, with a running SHA-256
  (`digest()`) for reproducibility checks.

## `FrameConn` and links

`FrameConn<Out, In>` is the transport-agnostic shape of one Session stream end: `send`, `onFrame`
(buffered until set; async handlers are awaited in order), `onClose`, `close` (graceful: frames in
flight still arrive), `abort` (reset) and `ping` (HTTP/2 PING). `createAgentLink()` builds a daemon
end (`FrameConn<AgentFrame, ServerFrame>`) and a gateway end over an in-memory link whose frames
cross as protobuf bytes (`encodeAgentFrame` / `encodeServerFrame`, bounded by `MAX_FRAME_BYTES`).
`createFramePair()` is the generic version (structured clones).

Faults, per direction and drawn from the link's seeded RNG: latency and jitter (whole milliseconds,
order kept: head-of-line blocking), `drop` (`silent`, or `reset`, which breaks the stream as gRPC
would), `duplicate`, `reorder` within a window. Controls: `stall(dir, ms)`, `partition(ms?)` /
`heal()` (like TCP over a broken network: nothing crosses, pings time out, held frames arrive after
the heal unless an end closed), `halfOpen(deadSide)` (the dead end sees a close, the live end never
learns), `reset()`, `dropNext`, `duplicateNext` and `intercept(dir, fn)` for targeted faults.

## `FakeDaemon`

The daemon side of PLAN.md §6–§7, mirroring the Go skeleton in `daemon/internal/{journal,dispatch,
session,converge,fakehw}`:

- **Journal** (`MemoryJournal` and the rules `resolve`, `accept`, `markRunning`, `complete`,
  `ackResult`, `recover`, `sweep`): `accepted` before any side effect; `running{boot_id}` right
  before a self-terminating side effect; done + result with a 7-day TTL; unacked events with the
  metric-drop policy and the 64 MiB / 10k caps. A crash keeps the journal and the files; a reboot
  also changes `boot_id` and clears `/run`; `loseJournal()` starts a new `journal_id`.
- **Duplicate delivery:** done → resend the stored result; running → re-attach; accepted but not
  running after a crash → re-execute if `retry_safe`, else `FAILED{interrupted}`; self-terminating
  and running across a reboot → `SUCCEEDED{rebooted}` with `NodeRebootResult.previous_boot_id`.
- **Acceptance checks** in Go's `dispatch.Precheck` order: another node's command or an unknown or
  role-disallowed kind → `UNSUPPORTED`; `min_generation` above the applied spec → `SpecRequest`
  and defer until `not_after`, then `STALE_GENERATION`; past `not_after` (server time via the
  Welcome offset; a missing one counts as past) → `EXPIRED`; no free lane credit, or a journal
  full of unacked transitions → `BUSY` (not journaled). Terminal rejections are journaled.
- **Session:** Hello from the journal; Welcome (epoch, offset, credits, requested sections,
  unacked events); heartbeats with free credits (hashes on every 10th); PING liveness; full-jitter
  reconnect (1 s → 60 s); `Drain`; `RevocationNotice`; `Cancel`.
- **Desired state:** full specs and section patches against `base_generation` (`SpecRequest` on a
  mismatch). The devices converger writes `/etc/cdi/bcd-<alloc>.json` and
  `/run/bcd/allocations/<alloc>.env` in an in-memory file map, reports `AllocationBound` /
  `AllocationReleased` (attested reports, unsigned in v0.1) and `AllocationFailed{overlap |
device-missing | …}`, never drops a hold on its own, and enforces the journaled spec offline.
  Sections without a converger converge when empty and are `UNSUPPORTED` (with a
  `SectionUnsupported` condition) otherwise, as are unknown fields.
- **Kinds:** `diag.nvml`, `inventory.refresh`, `logs.collect`, `node.reboot` (knobs in
  `daemon.knobs`), and the opt-in `fakeGpuReset` (not retry-safe).
- **Fake hardware:** `fakeHardware({ seed, variant })` — `hgx-h100` (field for field the Go
  `fakehw`, same seed → same section hashes), `hgx-h100-gpu-missing`, `l40s`, `cpu`.
  `encodeInventorySections()` reproduces the Go goldens byte for byte.

`createDaemonHarness()` wires one daemon to scripted servers (`ScriptedServer`) on a sim
scheduler, with builders for command bodies and specs.

## `createFleetSim()`

N FakeDaemons, one fresh link per dial with the configured faults, a seeded chaos schedule
(crashes, reboots, journal loss, partitions, isolation, half-open links, resets, stalls, gateway
kills) and a pluggable `GatewayPort` (`accept(conn, peer)`, `tick(now)`, `kill()`, `facts()`).
The default port is `GatewayStub`, a minimal in-memory control plane: the §7.2 Hello transaction
(epoch bump, self-terminating and journal-lost rules), Welcome, desired state, dispatch with
credits and BUSY back-off, result and event ingestion with dedupe and Acks, liveness (unreachable
releases nothing), the command sweeper, bookings under an exclusion check and usage flushes.
**The gateway session core of `@better-compute/gateway` replaces the stub** through the same
port; the stub is not a reference for the server.

`sim.invariants()` runs the pure checkers over the collected facts: **I1** (bookings and
node-reported CDI holds never overlap), **I2** (at most one execution per command; after a
journal loss, in-flight non-retry-safe commands fail instead of replaying), **I5** (no release
caused by connectivity) and **I8** (usage windows tile booking duration × atoms, no duplicate
keys). The same seed always yields the same event log (`sim.digest()`).

## Later

- **v0.1:** embedded better-iam on its in-memory SQLite adapter (through the IAM bridge) as the
  fixture's IAM, loaded by dynamic import like PGlite; the fleet sim on the real gateway core,
  PGlite and `compute.jobs.*.tick()`; the real-time harness (`tests/realtime/`); conformance
  runners.
- **v0.4:** the scale scenarios of PLAN.md §15.
