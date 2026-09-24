# @better-compute/server

The better-compute control plane: `betterCompute()`, the operation envelope every method runs
through, the method → action registry, the module host and the HTTP transports. It never imports
the store, the IAM bridge or the injected modules (`provision`, `metal`, `vps`); they arrive
through options. The one exception is the always-on built-in `inventory` module.

**Status: P0 shell.** The factory, the envelope, the registry, `initialize()`, `selfCheck()` and
both transports work. The groups served today are `system` (`whoami`, `version`, `selfCheck`) and
the `inventory` stubs. Everything else in PLAN.md §9.2 arrives in its phase; see
[docs/api-reference.md](../../docs/api-reference.md).

```ts
import { betterCompute } from 'better-compute';
import { postgres } from 'better-compute/postgres';

const compute = betterCompute({
  database: postgres({ url: process.env.BETTER_COMPUTE_DATABASE_URL! }),
  secret: process.env.BETTER_COMPUTE_SECRET!, // at least 32 characters
  baseURL: 'https://compute.example.com',
  rootTenantId, // the IAM root (platform) tenant
  iam, // an IamPort, e.g. the IAM bridge's embedded(iam) (v0.1)
  modules: [], // metal(), vps(), provisionModule() as they land
  plugins: [], // definePlugin(...) values, mounted under plugins/{id}
});
await compute.initialize(); // registry checks, then migrations
app.all('/api/compute/*', (c) => compute.handler(c.req.raw)); // or createServer(compute.nodeHandler)
```

`betterCompute()` is synchronous and side-effect free. It validates the options and registers
`system`, then `inventory`, then `modules` and `plugins`. Configuration errors throw
`INVALID_CONFIG`:

- a duplicate module name or plugin id, or a reserved name (`core`, `server`, `capacity`);
- a duplicate `group/method` route, or a malformed method definition;
- a plugin action outside `compute:<plugin-id>:*`;
- a migration not named `<module>/<nnnn>_<slug>`;
- a duplicate extension `kind:id@version` or command kind, or an unmet `requires`.

## The envelope (PLAN.md §3.4)

`compute.api.<group>.<method>(credential, input)` and HTTP take the same path:

1. **Public methods** skip authentication. `system.whoami` authenticates only when a credential
   came with the call.
2. **No credential:** `UNAUTHENTICATED` before any IAM call. Then the input is validated.
3. **Authenticate** once with `IamPort.authenticate`.
4. **Tenant pre-check.** A caller outside the input's `tenantId` and the root tenant gets
   `ACCESS_DENIED`, identical to an IAM denial, before any database access or decision.
   Fleet-scoped methods (`compute-fleet/global`) are decided in `rootTenantId`.
5. **One decision:** `require` for mutations, `authorize` for reads, on `typePrefix` + the
   method's resource (`compute-node/<id>`).
6. **The handler** runs in one transaction, read-only for reads. An allowed mutation also writes
   an `audit_events` row with its admission context (identity, session, agent, delegation,
   request id, action, resource) in that transaction.

Idempotency keys and request-as-resource drafts (§3.4 steps 4 and 5) arrive with the first
`create` methods in v0.1.

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
- `GET` serves only `{basePath}/health` (one store round trip; `503` when it fails) and
  `{basePath}/.well-known/better-compute` (version, base path, agent protocol range). Other
  methods answer `METHOD_NOT_ALLOWED`. Unknown routes answer `NOT_FOUND`.

## Registry, initialize and selfCheck

- **`compute.registry`** holds the modules, plugins, routable methods (each with its §9.2 row),
  the merged catalog actions, migrations, extensions and command kinds.
  - `registry.problems()` lists methods that are:
    - `uncatalogued`: the action is missing from the merged catalog;
    - `mismatch`: the method disagrees with its §9.2 row on action, kind or resource;
    - `undeclared`: a non-plugin method outside §9.2.
- **`initialize()`** fails with `INVALID_CONFIG` on `uncatalogued` or `mismatch` problems,
  before touching the store. It then calls `database.migrate(registry.migrations)`. It is
  idempotent, and a failed attempt can be retried. `scripts/authz-matrix.mjs` also fails on
  `undeclared` methods.
- **`selfCheck()`** (also `system.selfCheck`, `compute:fleet:admin`) only reads. It reports:
  - registry problems;
  - unapplied migrations and a missing `btree_gist`;
  - `compute_now()` differing from the database clock (`info` under the sim clock);
  - every module's own `selfCheck`.

## Not yet

- `start()` validates roles and requires `initialize()`, but P0 has no worker runtimes and
  `jobs` is empty.
- `gatewayServices` and `authz` answer `NOT_IMPLEMENTED`.
- The module context's leases, commands, desired state, capacity, inventory storage and events
  answer `NOT_IMPLEMENTED` until v0.1.
