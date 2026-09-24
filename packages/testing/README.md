# @better-compute/testing

The testing kit for better-compute: a control-plane fixture, the sim clock and a scripted IAM
port. Tests run against PGlite, so no database server is needed.

**Status: P0 shell.** `computeFixture()`, `closeFixtures()` and `fakeIam()` work. The fleet
simulator (`@better-compute/testing/fleet-sim`), `FakeDaemon`, the invariant checker and the
conformance runners arrive in v0.1 (PLAN.md §15).

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

## Later

- **v0.1:** embedded better-iam on its in-memory SQLite adapter (through the IAM bridge) as the
  fixture's IAM, loaded by dynamic import like PGlite. Also the deterministic fleet simulator
  with seeded RNG and `compute.jobs.*.tick()`, `FakeDaemon` over an in-memory `FrameConn`, the
  invariant checker (I1–I8) and conformance runners.
- **v0.4:** the scale scenarios of PLAN.md §15.
