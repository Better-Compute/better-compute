# @better-compute/testing

The testing kit for better-compute: a control-plane fixture on PGlite with a sim clock and a scripted IAM, the daemon side of the agent protocol in TypeScript, faulty in-memory links and a deterministic fleet simulator.

## Install

```sh
npm install --save-dev @better-compute/testing @electric-sql/pglite
```

It is also included in the umbrella package as `better-compute/testing`:

```sh
npm install better-compute
```

`@electric-sql/pglite` is an optional peer: the fixtures run on an in-memory PGlite, so no database server is needed. Without it, `computeFixture()` fails with `MISSING_DEPENDENCY`.

Better IAM (`npm install better-iam`) provides the optional `@better-iam/*` peers (`@better-iam/core`, `@better-iam/server`, `@better-iam/adapter-sqlite`). `computeFixture()` itself uses the scripted `fakeIam()`; install Better IAM when your tests run compute against a real Better IAM with `createEmbeddedTestIam()` from `@better-compute/iam/testing`.

## Usage

```ts
import { afterEach, expect, it } from 'vitest';
import { closeFixtures, computeFixture } from '@better-compute/testing';

afterEach(closeFixtures);

it('asks IAM before listing nodes', async () => {
  const { request, iam, tenants, advance } = await computeFixture();
  iam.allow({ token: tenants.acme.token, action: 'compute:nodes:read' });
  const answer = await request(
    'nodes',
    'list',
    { tenantId: tenants.acme.id },
    { token: tenants.acme.token },
  );
  expect(answer.ok).toBe(true);
  expect(iam.count('authenticate')).toBe(1);
  await advance(60_000); // compute's Clock and compute_now() both move one minute
});
```

## `computeFixture(options?)`

It builds `betterCompute()` on an in-memory PGlite store, runs `compute.initialize()` (the registry check, then the base schema and every module's and plugin's migrations) and returns:

| Field                                      | What it is                                                             |
| ------------------------------------------ | ---------------------------------------------------------------------- |
| `compute`                                  | The initialized control plane, typed by `modules` and `plugins`        |
| `database`                                 | The migrated PGlite `SqlExecutor` behind it                            |
| `clock`, `advance(ms)`                     | The fixture clock (below)                                              |
| `iam`                                      | The `fakeIam()` port compute calls (below)                             |
| `tenants`                                  | `root`, `acme` and `other`: each `{ id, token, caller }`               |
| `request(group, method, input?, options?)` | A `POST {basePath}/{group}/{method}` through `compute.handler` (below) |
| `close()`                                  | Stops compute and closes the store; idempotent                         |

It does not start the workers: a test drives reconcilers one pass at a time with `compute.jobs[name].tick()`.

Options:

- `clock`: `'sim'` (the default) or `'system'`;
- `start`: where the sim clock starts, in whole milliseconds since the epoch (default 2026-01-01T00:00:00Z);
- `iam`: `fakeIam()` options, added to the three tenants' callers;
- `modules`, `plugins` and `log`: passed to `betterCompute()`.

**The tenants.** The fixture mirrors Better IAM's `organizationFixture`: a platform (root) tenant and two organizations, `acme` and `other`, each with one signed-in person. The root caller has MFA, like a root administrator. `tenants.root.id` is the server's `rootTenantId`. The IAM allows nothing until a test adds a rule.

**The sim clock.** Under `clock: 'sim'`, compute's `Clock` and SQL's `compute_now()` read the same time. The fixture points `compute_now()` at `compute_sim_clock` with `useSimClock` from `@better-compute/postgres`. Then:

- `advance(ms)` and `clock.set(ms)` move the table first and the TypeScript clock second. Leases, `not_before`, column defaults and admission contexts all move together.
- Moves run one at a time, and time never moves backwards: a refused move changes neither clock.
- Under `clock: 'system'`, compute uses the wall clock, `compute_now()` is the database's `now()`, and `advance` rejects with `INVALID_STATE`.

**`request()`** sends `input` as JSON with the CSRF headers the server requires. The options are:

- `token`, sent as `Authorization: Bearer <token>`;
- `plugin`, which routes to `plugins/{plugin}/{group}/{method}`;
- `headers`, which replace the defaults they name, for example to test `CSRF_REJECTED`.

It answers `{ ok, status, headers, requestId }`, plus `data` when `ok` or `error` (`{ code, message, … }`) when not.

**`closeFixtures()`** closes every fixture that is still open, even when one of them fails; use it with `afterEach`. A fixture that fails to initialize closes its store before it rethrows.

## `fakeIam(options?)`

This is a scripted `IamPort`: the tool for tests that count IAM calls, such as checking that fleet paths make zero IAM calls.

- **Callers.** Bearer tokens map to callers: `options.callers`, or `addCaller(token, caller)` later. An unknown token is `UNAUTHENTICATED`. `tokenOf(credential)` reads a credential's token, bearer header or IAM cookie.
- **Decisions.** A decision is allowed only when an `allow` rule matches and no `deny` rule does. A rule matches on any of `token`, `tenantId`, `action`, `type` and `id`, and `{}` matches everything. A denied `require` is `ACCESS_DENIED`.
- **Recording.** Every call is recorded in order in `calls`, with its method, token, credential and decision. `count(method)` counts them and `reset()` forgets them.
- **The rest.** `billingCheck` allows, `recordUsage` records every event, `featureEnabled` is false, and `requestConfirmation` answers `'not-held-back'`.

## Deterministic plumbing

- `createSimScheduler({ start })`: a manual clock plus a timer heap. Tasks run in (time, insertion) order, one at a time; a task that returns a promise is awaited before the next one, so an async (DB-backed) participant stays deterministic if it uses the scheduler for its timers. `onTime(hook)` moves another clock along (for example `fixture.clock.set`, which moves `compute_now()`). `createRealtimeScheduler()` is the `setTimeout` version for the real-time harness.
- `createRng(seed)`: seeded `sfc32`; `fork(label)` derives an independent stream without consuming the parent's, so adding a node never shifts another node's draws.
- `EventLog`: every notable action as `<t> <source> <event> k=v…` lines, with a running SHA-256 (`digest()`) for reproducibility checks.

## `FrameConn` and links

`FrameConn<Out, In>` is the transport-agnostic shape of one Session stream end: `send`, `onFrame` (buffered until set; async handlers are awaited in order), `onClose`, `close` (graceful: frames in flight still arrive), `abort` (reset) and `ping` (HTTP/2 PING). `createAgentLink()` builds a daemon end (`FrameConn<AgentFrame, ServerFrame>`) and a gateway end over an in-memory link whose frames cross as protobuf bytes (`encodeAgentFrame` / `encodeServerFrame`, bounded by `MAX_FRAME_BYTES`). `createFramePair()` is the generic version (structured clones).

Faults, per direction and drawn from the link's seeded RNG: latency and jitter (whole milliseconds, order kept: head-of-line blocking), `drop` (`silent`, or `reset`, which breaks the stream as gRPC would), `duplicate`, `reorder` within a window. Controls: `stall(dir, ms)`, `partition(ms?)` / `heal()` (like TCP over a broken network: nothing crosses, pings time out, held frames arrive after the heal unless an end closed), `halfOpen(deadSide)` (the dead end sees a close, the live end never learns), `reset()`, `dropNext`, `duplicateNext` and `intercept(dir, fn)` for targeted faults.

## `FakeDaemon`

The daemon side of the agent protocol, mirroring bcd, the Go node agent (its `daemon/internal/{journal,dispatch,session,converge,fakehw}` packages). bcd itself is built and tested against simulated and fake hardware but is not released as a binary yet; the FakeDaemon lets you test against the protocol without it.

- **Journal** (`MemoryJournal` and the rules `resolve`, `accept`, `markRunning`, `complete`, `ackResult`, `recover`, `sweep`): `accepted` before any side effect; `running{boot_id}` right before a self-terminating side effect; done + result with a 7-day TTL; unacked events with the metric-drop policy and the 64 MiB / 10k caps. A crash keeps the journal and the files; a reboot also changes `boot_id` and clears `/run`; `loseJournal()` starts a new `journal_id`.
- **Duplicate delivery:** done → resend the stored result; running → re-attach; accepted but not running after a crash → re-execute if `retry_safe`, else `FAILED{interrupted}`; self-terminating and running across a reboot → `SUCCEEDED{rebooted}` with `NodeRebootResult.previous_boot_id`.
- **Acceptance checks** in Go's `dispatch.Precheck` order: another node's command or an unknown or role-disallowed kind → `UNSUPPORTED`; `min_generation` above the applied spec → `SpecRequest` and defer until `not_after`, then `STALE_GENERATION`; past `not_after` (server time via the Welcome offset; a missing one counts as past) → `EXPIRED`; no free lane credit, or a journal full of unacked transitions → `BUSY` (not journaled). Terminal rejections are journaled.
- **Session:** Hello from the journal; Welcome (epoch, offset, credits, requested sections, unacked events); heartbeats with free credits (hashes on every 10th); PING liveness; full-jitter reconnect (1 s → 60 s); `Drain`; `RevocationNotice`; `Cancel`.
- **Desired state:** full specs and section patches against `base_generation` (`SpecRequest` on a mismatch). The devices converger writes `/etc/cdi/bcd-<alloc>.json` and `/run/bcd/allocations/<alloc>.env` in an in-memory file map, reports `AllocationBound` / `AllocationReleased` and `AllocationFailed{overlap | device-missing | …}`, never drops a hold on its own, and enforces the journaled spec offline. Sections without a converger converge when empty and are `UNSUPPORTED` (with a `SectionUnsupported` condition) otherwise, as are unknown fields.
- **VPS host:** with `instances: FakeHypervisorOptions | FakeHypervisor`, the `instances` section converges on a fake hypervisor (`daemon.hypervisor`: domains, overlay disks, NoCloud seeds, taps, the base-image cache; `overlayPath`, `seedPath`, `tapName`). DELETED specs and managed domains no spec names are removed with everything they own; domains bcd did not create are reported, never touched. User data is fetched with a node-signed `SecretRequest` for the instance's allocation before the domain is defined. Every StatusReport lists the runtimes' whole inventory (`instances_complete`). Domains outlive daemon crashes; a reboot stops them and the converger starts the ones that should run. Faults: `leakDomain`, `failInstance`, `powerLoss`, `wipe`.
- **Kinds:** `diag.nvml`, `inventory.refresh`, `logs.collect`, `node.reboot` (knobs in `daemon.knobs`), and the opt-in `fakeGpuReset` (not retry-safe), `fakeInstanceSnapshot` and `fakeDriverInvoke({ drivers })` (`driver.invoke`: one operation of a hosted driver, in-process `defineDriver`s or bcx plugins from `@better-compute/driver-sdk`; `invokeDriver` is the host logic). A kind's `run` may return a Promise; its outcome is reported when it settles.
- **Fake hardware:** `fakeHardware({ seed, variant })`: `hgx-h100` (field for field the Go `fakehw`, same seed → same section hashes), `hgx-h100-gpu-missing`, `l40s`, `cpu`. `encodeInventorySections()` reproduces the Go goldens byte for byte. This is simulated hardware: nothing in this kit, or in bcd, has run on real GPU hardware yet.

`createDaemonHarness()` wires one daemon to scripted servers (`ScriptedServer`) on a sim scheduler, with builders for command bodies and specs.

## `createFleetSim()`

N FakeDaemons, one fresh link per dial with the configured faults, a seeded chaos schedule (crashes, reboots, journal loss, partitions, isolation, half-open links, resets, stalls, gateway kills) and a pluggable `GatewayPort` (`accept(conn, peer)`, `tick(now)`, `kill()`, `facts()`). The default port is `GatewayStub`, a minimal in-memory control plane: the Hello transaction (epoch bump, self-terminating and journal-lost rules), Welcome, desired state, dispatch with credits and BUSY back-off, result and event ingestion with dedupe and Acks, liveness (unreachable releases nothing), the command sweeper, bookings under an exclusion check and usage flushes. **The gateway session core of `@better-compute/gateway` replaces the stub** through the same port; the stub is not a reference for the server.

`sim.invariants()` runs the pure invariant checkers over the collected facts, and the same seed always yields the same event log (`sim.digest()`). The checkers are exported on their own too, each returning `InvariantViolation[]` (`assertInvariants` throws on any):

- `checkI1`: bookings and node-reported CDI holds never overlap (with `checkKubeAdvertisements` for devices offered to a kubelet, and `checkHostResources` for vCPU, memory and hugepages);
- `checkI2`: at most one execution per command; after a journal loss, in-flight non-retry-safe commands fail instead of replaying;
- `checkI3`: a node that stays reachable reports a delivered spec as observed within `CONVERGENCE_MS`;
- `checkI4`: no node is marked unreachable or lost while a gateway heard from it within `LIVENESS_WINDOW_MS`;
- `checkI5`: no release is caused by connectivity (`ALLOWED_RELEASE_REASONS`);
- `checkI7`: nothing stays pending that an offline solver could place;
- `checkI8`: usage windows tile booking duration × atoms, with no duplicate keys.

## `createControlPlaneSim(options)`

`createControlPlaneSim` runs the fleet simulator with the real control plane behind it:

- `betterCompute` on the sim clock, with `compute_now()` pinned to simulated time;
- `gateways` real gateways on manual jobs (default 1);
- nodes that joined through JoinService with sealed tokens bound to their CSRs.

The control plane's reconcilers and the gateways' jobs run on the simulator's ticks. The API sets up the deployment: a site, and an H100 pool with `diag.nvml` acceptance offered to `acme`.

- `run(ms)` advances everything together.
- `api(fn)` runs an operator or tenant call.
- `killGateway(i)` and `stallGateway(i, stalled)` crash or pause one gateway process. `homeOf(nodeId)` answers from the newest session epoch, so a zombie's stale session doesn't count.
- `trace(path, fn)` names each part of the loop (`join`, `fleet`, `gateway`, `reconcilers`, `api`), so an IAM spy can attribute every call.
- `controlPlaneFacts(sql)` reads the invariant facts from compute's own tables: bookings (`checkI1`), billed allocations and usage windows (`checkI8`), command outcomes (`checkI2`) and connectivity (`checkI5`). `invariants()` refreshes them and checks.

`runNightly`, `runColdStart` and `upgradeInPlace` build longer scenarios on the same simulator: seeded chaos runs, a cold start of a whole fleet, and in-place upgrades.

## Real-time harness

The real-time harness runs on the wall clock over cleartext HTTP/2 through `createH2cClient`. The repository's benchmark suites run it at scale.

- **`createRealtimeHarness({ nodes })`**: a real gateway and database, with FakeDaemons on pre-registered nodes.
  - `connectAll()`
  - `dispatch({ kind, perNode })`: a burst, timed to ack and to terminal.
  - `load({ ratePerSecond, durationMs })`: steady state.
  - `storm({ fraction, mode })`: a reconnect storm.
- **`createRealtimeFleet()`**: the whole control-plane spine. That's a started `betterCompute` with JoinService on real PKI, and a gateway wired to its services, report handlers, work queue, outbox and pokes.
  - `join(n)` times each node from its Join call to adopted.
  - `place(n, { ratePerSecond })` times reservations from placed to active.
- **`probeLeases(sql)`** samples the `leases` table: renewal gaps, the least headroom before expiry, lapses while owned, and takeovers.

## Local stack

`createDevStack(options?)` is a control plane on PGlite with a real gateway on cleartext HTTP/2 and simulated machines (FakeDaemons) that join the way `bcd join` does, all in this process on the wall clock. Its default IAM is a `fakeIam()` that authenticates `DEV_ROOT_TOKEN` as a root administrator and allows everything. `createDevJoinKeys()`, `devFleetNotifier()` and `attachDevFleet()` add the same fleet to a host's own `betterCompute()`. It is for local development only: sessions authenticate by a header over h2c, without TLS.

```ts
const dev = await createDevStack();
const { poolId } = await dev.createPool();
const nodes = await dev.join({ poolId, count: 3 });
await dev.waitFor(nodes); // adopted, generation ≥ 1 applied
await dev.close();
```

## Documentation

- [Testing](https://better-compute.com/docs/operations/testing)
- [Local development](https://better-compute.com/docs/operations/local-development)

## License

[Apache License 2.0](https://github.com/better-compute/better-compute/blob/main/LICENSE)
