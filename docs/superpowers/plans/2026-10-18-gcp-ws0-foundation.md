# GCP WS0 — `@better-compute/gcp-common` foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A dependency-free shared package for every Google Cloud integration: the token sources (moved from
`provider-gcp` unchanged), a generic Google REST client with google.rpc.Status error mapping, pagination,
long-running operations and universe-domain endpoints. `provider-gcp`'s public API and behavior stay identical.

**Architecture:**

- **The move.** `packages/provider-gcp/src/auth.ts` moves verbatim to `packages/gcp-common/src/auth.ts`.
  `provider-gcp` re-exports the same bindings, so the token-source objects are identical and the security pins are
  the same code.
- **New code, alongside.** The new client (`http.ts`), paging and LROs (`paging.ts`, `operations.ts`) and
  endpoints (`endpoints.ts`) sit beside it.
- **What stays put.** `provider-gcp`'s `gceClient`/`mapGceError` are **not** migrated in WS0, because
  `compute.ts` has another session's uncommitted edits. A parity test pins `mapGoogleError` to `mapGceError` on
  every legacy GCE case, so the later migration is mechanical.

**Tech Stack:** TypeScript ESM, `node:crypto`, plain `fetch`, vitest. No new npm dependencies.

**Spec:** `docs/superpowers/plans/2026-10-18-gcp-program.md` (§2 G2, G10; §4; §6 WS0; §7.1, §7.4). Read it first.

## Global Constraints

- Node ≥ 22.12, ESM only, `.js` import suffixes.
- **Dependencies.**
  - `gcp-common` depends on `@better-compute/core` only.
  - It is not added to `packages/better-compute/umbrella.json`.
  - `provider-gcp` adds `@better-compute/gcp-common` (dependency + tsconfig reference).
- **Shared registries are one-line inserts.** That means the root `tsconfig.json` references and the
  `vitest.config.ts` `scoped` map. `pnpm install` (via `node node_modules/pnpm/bin/pnpm.mjs install`) is run by
  the orchestrating session only. Ask it.
- **Tokens and keys.**
  - A token or key is never logged and never put in an error message.
  - Every `ComputeError` from this package carries `details: { provider: 'gcp', status, reason }`.
  - The `token_uri` allow-list (`https://oauth2.googleapis.com/token`,
    `https://accounts.google.com/o/oauth2/token`) is unchanged for the default universe.
- **Universe domain** comes only from host configuration (options), never from a key or a response.
- Format only the files you touched (`node node_modules/pnpm/bin/pnpm.mjs exec prettier --write <files>`).
- **Commits.** Commit with `node scripts/private-commit.mjs -F <msgfile> -- <paths>`. Messages end with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Precondition.** The session holding uncommitted edits to `packages/provider-gcp/src/compute.ts` has committed
  (check `git status`). WS0 never edits `compute.ts`, `client.ts` or `tests/support/gce-emulator.ts`.

## Review Focus

1. **The move silently changes the token pin.** A key whose `token_uri` is `https://evil.internal/token` must
   still fail `INVALID_CONFIG` (`reason: 'tokenUri'`) with zero fetches, through *both* import paths.
   *Task 1: `the token_uri pin holds through both packages`.*
2. **`RESOURCE_EXHAUSTED` means two things.** Google uses it for rate limits and for quota. A quota `ErrorInfo`
   reason must become `QUOTA_EXCEEDED`, never a retried `RATE_LIMITED`.
   *Task 2: `RESOURCE_EXHAUSTED with a quota reason is QUOTA_EXCEEDED`.*
3. **A non-JSON error body** (an HTML 502 from the Google front end) must map by status to `UNAVAILABLE`, not
   throw a `SyntaxError`. *Task 2: `an HTML 502 is UNAVAILABLE`.*
4. **Abort mid-pagination** must stop issuing page requests at once.
   *Task 3: `an aborted signal stops paging after the current page`.*
5. **A key claiming another universe** (`universe_domain: "evil.example"` and a matching `token_uri`) must be
   refused unless the host configured that universe.
   *Task 4: `a key's universe_domain never selects the universe`.*

---

## File structure

| File | Responsibility |
|---|---|
| `packages/gcp-common/package.json`, `tsconfig.json`, `LICENSE`, `README.md` | Package shell. Copy `packages/provider-gcp`'s `package.json`, `tsconfig.json` and `LICENSE`, rename, and drop the `vps` dependency and reference. |
| `packages/gcp-common/src/index.ts` | `export *` from `auth`, `endpoints`, `http`, `paging`, `operations`. |
| `packages/gcp-common/src/auth.ts` | The token sources, moved verbatim, then extended in Task 4 for universes. |
| `packages/gcp-common/src/endpoints.ts` | `googleEndpoint`, `tokenEndpoint`, `defaultUniverse`. |
| `packages/gcp-common/src/http.ts` | `googleClient`, `mapGoogleError`, `rpcStatus` helpers. |
| `packages/gcp-common/src/paging.ts` | `paginate`. |
| `packages/gcp-common/src/operations.ts` | `LongRunningOperation`, `settledOperation`, `rpcCodeToHttp`. |
| `packages/provider-gcp/src/auth.ts` | Becomes a re-export of the moved names. |
| `packages/provider-gcp/src/config.ts`, `provider.ts` | Task 4 only: the `universeDomain` option. |
| `tests/support/gcp/fake-google.ts` | `FakeGoogle`: a route-table fake behind `fetch` (used by every later workstream). |
| `tests/gcp-common-auth.test.ts`, `gcp-common-http.test.ts`, `gcp-common-paging.test.ts`, `gcp-common-endpoints.test.ts` | Tests. |

---

### Task 1: The package, and the token sources moved into it

**Files:**
- Create: `packages/gcp-common/{package.json,tsconfig.json,LICENSE,README.md}`, `packages/gcp-common/src/{index.ts,auth.ts}`
- Modify: `packages/provider-gcp/src/auth.ts` (whole file → re-export), `packages/provider-gcp/package.json` (add dependency), `packages/provider-gcp/tsconfig.json` (add reference `../gcp-common`)
- Modify (one-line inserts): root `tsconfig.json` references (`{ "path": "./packages/gcp-common" }` before provider-gcp), `vitest.config.ts` `scoped` (`'@better-compute/gcp-common': 'gcp-common/src/index.ts'` before `provider-gcp`)
- Modify: `.claude/coordination.md` (claim line), `apps/docs/content/docs/reference/packages.mdx` (one row), `CHANGELOG.md` (Unreleased: "gcp-common")
- Test: `tests/gcp-common-auth.test.ts`

**Interfaces:**
- Produces (unchanged signatures, now exported by `@better-compute/gcp-common`):
  - `TokenSource { token(context: { signal: AbortSignal; clock: Clock }): Promise<string> }`;
  - `serviceAccountTokenSource(keyJson: string, options?: { fetch?; scopes? }): TokenSource`;
  - `metadataTokenSource(options?: { fetch? }): TokenSource`;
  - `impersonatedTokenSource(base, targetEmail, options?: { fetch? }): TokenSource`;
  - `cachedTokenSource(inner, skewMs = 60_000): TokenSource`.
- `@better-compute/provider-gcp` keeps exporting exactly those names, as the *same bindings*.

- [ ] **Step 1: Claim the area.** Append to `.claude/coordination.md`:
  `(Claude session, gcp WS0, 2026-10-18, plan 2026-10-18-gcp-ws0-foundation) claims new packages/gcp-common/**,
  tests/support/gcp/**, tests/gcp-common-*.test.ts; edits packages/provider-gcp/src/{auth,config,provider}.ts,
  provider-gcp package.json/tsconfig.json; one-line inserts in tsconfig.json and vitest.config.ts.`
  Ask the orchestrating session for `pnpm install` after Step 5.

- [ ] **Step 2: Write the failing test.** In `tests/gcp-common-auth.test.ts`:

```ts
import * as common from '@better-compute/gcp-common';
import * as gcp from '@better-compute/provider-gcp';

it('provider-gcp re-exports the same token sources', () => {
  for (const name of ['serviceAccountTokenSource', 'metadataTokenSource',
    'impersonatedTokenSource', 'cachedTokenSource'] as const)
    expect(gcp[name]).toBe(common[name]);
});

it('the token_uri pin holds through both packages', async () => {
  // key: a freshly generated RSA key (generateKeyPairSync, as tests/provider-gcp.test.ts does) with
  // token_uri 'https://evil.internal/token'
  const fetch = vi.fn();
  for (const make of [common.serviceAccountTokenSource, gcp.serviceAccountTokenSource]) {
    let caught: unknown;
    try { make(evilKeyJson, { fetch }); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ code: 'INVALID_CONFIG', details: { reason: 'tokenUri' } });
  }
  expect(fetch).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Run it to verify it fails.**
  Run: `node node_modules/pnpm/bin/pnpm.mjs exec vitest run tests/gcp-common-auth.test.ts`
  Expected: FAIL, failed to resolve `@better-compute/gcp-common`.

- [ ] **Step 4: Create the package and move the file.**
  - **Package shell.** Copy `package.json`, `tsconfig.json` and `LICENSE` from `packages/provider-gcp`. Set:
    - `name` `@better-compute/gcp-common`, `version` `0.1.0`;
    - `description` "Shared Google Cloud plumbing for better-compute: token sources, workload identity, REST
      client, errors, paging, operations";
    - `keywords` `[better-compute, gcp, google-cloud]`;
    - `dependencies` `{ "@better-compute/core": "workspace:*" }`, and tsconfig `references` `[../core]`.
  - **The move.** Copy `provider-gcp/src/auth.ts` byte for byte to `gcp-common/src/auth.ts`.
  - **The re-export.** Replace `provider-gcp/src/auth.ts` with:

```ts
/** Moved to @better-compute/gcp-common; re-exported so existing imports keep working. */
export {
  cachedTokenSource,
  impersonatedTokenSource,
  metadataTokenSource,
  serviceAccountTokenSource,
  type TokenSource,
} from '@better-compute/gcp-common';
```

  - **Registration.** Add the registry one-liners. Write `README.md`: what it is, "not in the umbrella", the
    token-source table copied from the provider README's Authentication section, and "never logs tokens".

- [ ] **Step 5: Run the new test and every existing GCP suite.**
  Run: `node node_modules/pnpm/bin/pnpm.mjs exec vitest run tests/gcp-common-auth.test.ts tests/provider-gcp.test.ts tests/provider-gcp-reservations.test.ts tests/provider-gcp-networks.test.ts tests/gcp-tenant-credentials.test.ts tests/gcp-end-to-end.test.ts`
  Expected: all PASS. The `auth & client` block of `provider-gcp.test.ts` passes unchanged.

- [ ] **Step 6: Typecheck and run the dependency rules** (after the orchestrator's `pnpm install` has linked the
  package).
  Run: `node node_modules/pnpm/bin/pnpm.mjs exec tsc -b packages/gcp-common packages/provider-gcp`, then
  `node scripts/check-deps.mjs`, then `node scripts/validate-packages.mjs`.
  Expected: no errors and no violations.

- [ ] **Step 7: Commit** `gcp-common: new package; the GCP token sources move into it (provider-gcp re-exports)`,
  with every path above.

---

### Task 2: `googleClient` and `mapGoogleError`, with the `FakeGoogle` fake

**Files:**
- Create: `packages/gcp-common/src/http.ts`, `tests/support/gcp/fake-google.ts`
- Modify: `packages/gcp-common/src/index.ts` (export `http`)
- Test: `tests/gcp-common-http.test.ts`

**Interfaces:**
- Consumes: `TokenSource` (Task 1).
- Produces:

```ts
export interface GoogleRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  url: string;                                   // absolute
  query?: Record<string, string | readonly string[]>;
  body?: unknown;                                 // JSON-encoded when present
  signal: AbortSignal;
  what?: string;                                  // error-message prefix; default `${method} ${pathname}`
}
export interface GoogleClientOptions {
  fetch: typeof fetch; tokens: TokenSource; clock?: Clock; log?: Logger;
  quotaProject?: string;                          // sent as x-goog-user-project
}
export interface GoogleClient { request<T>(request: GoogleRequest): Promise<T> }
export function googleClient(options: GoogleClientOptions): GoogleClient;
export function mapGoogleError(status: number, body: unknown, headers: Pick<Headers, 'get'>, what: string): ComputeError;
export const defaultRetryAfterMs = 10_000;
```

- `tests/support/gcp/fake-google.ts`:

```ts
export interface FakeRequest { method: string; url: URL; headers: Headers; body: unknown }
export type FakeReply = { status?: number; body?: unknown; headers?: Record<string, string>; raw?: string };
export class FakeGoogle {
  constructor(options?: { token?: string });             // accepted bearer, default 'fake-token'
  readonly requests: FakeRequest[];
  readonly fetch: typeof fetch;
  route(method: string, path: string | RegExp, reply: (request: FakeRequest, params: Record<string, string>) => FakeReply | Promise<FakeReply>): this;
  /** Answers the next matching request with `reply` once, before routes run. */
  failNext(reply: FakeReply, match?: { method?: string; path?: RegExp }): this;
  static rpcError(code: number, status: string, message: string, details?: unknown[]): FakeReply; // google.rpc.Status body
  tokens(): TokenSource;                                  // a source that returns the accepted bearer
}
```

  A string `path` is a template, where `{name}` matches one segment and `{name=**}` matches the rest. A wrong or
  missing bearer gets `rpcError(401, 'UNAUTHENTICATED', …)`. No route gets `rpcError(404, 'NOT_FOUND', …)`.

- [ ] **Step 1: Write the failing tests.** In `tests/gcp-common-http.test.ts`, a `describe('mapGoogleError')`
  table. Each row is `[name, status, body, headers, code, detailsSubset]`, and the test asserts
  `mapGoogleError(...)` has that `code` and `details` ⊇ `detailsSubset`. Abbreviations used below:
  `S` = `{ error: { code, status, message, details } }`; `EI` = `{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, domain, metadata }`;
  `RI` = `{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay }`; `LEGACY` = `{ error: { code, message, errors: [{ reason }] } }`.

| Name | Input | Expected `code` | Expected `details` ⊇ |
|---|---|---|---|
| `NOT_FOUND` | 404, S | `NOT_FOUND` | — |
| `ALREADY_EXISTS` | 409, S | `CONFLICT` | — |
| `ABORTED` | 409, S | `CONFLICT` | — |
| `FAILED_PRECONDITION` | 400, S | `INVALID_STATE` | — |
| `INVALID_ARGUMENT` | 400, S | `INVALID_INPUT` | — |
| `UNAUTHENTICATED` | 401 | `UNAUTHENTICATED` | — |
| `RESOURCE_EXHAUSTED rate` | 429, S + RI `'12s'` | `RATE_LIMITED` | `{ retryAfterMs: 12000 }` |
| `RESOURCE_EXHAUSTED with a quota reason is QUOTA_EXCEEDED` | 429, S + EI reason `RESOURCE_QUOTA_EXCEEDED` (and again with `QUOTA_EXCEEDED`) | `QUOTA_EXCEEDED` | — |
| `Retry-After header` | 429 with `retry-after: 7`, no RI | `RATE_LIMITED` | `{ retryAfterMs: 7000 }` |
| `no hint` | 429 | `RATE_LIMITED` | `{ retryAfterMs: 10000 }` |
| `SERVICE_DISABLED` | 403, S + EI `{ reason: 'SERVICE_DISABLED', metadata: { activationUrl: 'https://console.developers.google.com/apis/api/x/overview?project=1' } }` | `INVALID_CONFIG` | `{ reason: 'SERVICE_DISABLED', activationUrl }` |
| `VPC Service Controls` | 403, S + EI reason `SECURITY_POLICY_VIOLATED` | `ACCESS_DENIED` | `{ reason: 'SECURITY_POLICY_VIOLATED' }` |
| `PERMISSION_DENIED` | 403, S | `ACCESS_DENIED` | — |
| `UNIMPLEMENTED` | 501 | `UNSUPPORTED` | — |
| `UNAVAILABLE` / `INTERNAL` / `DEADLINE_EXCEEDED` | 503 / 500 / 504 | `UNAVAILABLE` | — |
| `an HTML 502 is UNAVAILABLE` | 502, body `undefined` (the client passes `undefined` for non-JSON) | `UNAVAILABLE` | `{ reason: 'unknown' }` |
| `418` | 418 | `PROVIDER_ERROR` | — |

  Rules for `details`:
  - `details.reason` is the `ErrorInfo.reason`, else `errors[0].reason`, else `error.status`, else `'unknown'`.
  - `details.provider` is always `'gcp'`, and `details.status` is the HTTP status.

  **Parity block** (`describe('agrees with mapGceError on every legacy GCE case')`). It imports `mapGceError`
  from `@better-compute/provider-gcp` and checks these LEGACY cases:
  - 404;
  - 409 `alreadyExists`;
  - 409 and 400 `resourceInUseByAnotherResource`;
  - 429;
  - 403 `rateLimitExceeded` and `userRateLimitExceeded`;
  - 400 `resourceNotReady`;
  - 403 `quotaExceeded`;
  - 403 `forbidden`;
  - 400 `invalid`;
  - 500.

  For each, it asserts `mapGoogleError(...).code === mapGceError(...).code` and equal `details.retryAfterMs`.

  **Client cases** (against `FakeGoogle`):
  - `sends the bearer, accept and JSON content type, and the quota project`;
  - `encodes repeated query values` (`{ fields: ['a', 'b'] }` → `fields=a&fields=b`);
  - `an unreachable host is UNAVAILABLE with reason network`;
  - `an aborted signal rethrows the abort, not UNAVAILABLE`;
  - `an empty 200 body is {}`;
  - `never logs the bearer`: with a spy logger, run a success, a 403 and a network failure; then
    `JSON.stringify(spy.mock.calls)` does not contain the token.

- [ ] **Step 2: Run them to verify they fail.**
  Run: `node node_modules/pnpm/bin/pnpm.mjs exec vitest run tests/gcp-common-http.test.ts`
  Expected: FAIL (`mapGoogleError` is not exported).

- [ ] **Step 3: Implement `http.ts` and `fake-google.ts`.**
  - **`mapGoogleError`.** First read the google.rpc.Status form (`body.error.status`, `body.error.details[]`,
    matched by `@type` suffix `ErrorInfo` or `RetryInfo`), then the legacy form (`body.error.errors[0].reason`),
    then the status. The legacy branches mirror `mapGceError`'s order exactly, so the parity block holds.
  - **`retryDelay`** is a protobuf `Duration` string (`"12s"`, `"0.5s"`). Parse it as seconds × 1000, rounded up.
  - **`googleClient.request`:**
    - Mirror `gceClient.request` (`provider-gcp/src/client.ts:123-164`), with an absolute `url` and array query
      values (`searchParams.append`).
    - Add `x-goog-user-project` when `quotaProject` is set.
    - Log `{ method, host, path, status }` at debug, and warn as `google.unreachable` with no query string.

- [ ] **Step 4: Run them to verify they pass.**
  Run: `node node_modules/pnpm/bin/pnpm.mjs exec vitest run tests/gcp-common-http.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit** `gcp-common: googleClient and mapGoogleError (google.rpc.Status + legacy GCE parity); FakeGoogle test fake`.

---

### Task 3: Pagination and long-running operations

**Files:**
- Create: `packages/gcp-common/src/paging.ts`, `packages/gcp-common/src/operations.ts`
- Modify: `packages/gcp-common/src/index.ts`
- Test: `tests/gcp-common-paging.test.ts`

**Interfaces:**
- Consumes: `GoogleClient`, `GoogleRequest`, `mapGoogleError` (Task 2).
- Produces:

```ts
export function paginate<T>(client: GoogleClient,
  request: Omit<GoogleRequest, 'method' | 'body'> & { field: string; pageSize?: number }): AsyncIterable<T>;
export interface LongRunningOperation<R = unknown> {
  name: string; done?: boolean; metadata?: unknown; response?: R;
  error?: { code: number; message?: string; details?: unknown[] };
}
/** The response when done; undefined while running; throws the mapped ComputeError when done with an error. */
export function settledOperation<R>(operation: LongRunningOperation<R>, what: string): R | undefined;
/** google.rpc.Code → [HTTP status, canonical status name]. Unknown codes map to [500, 'UNKNOWN']. */
export function rpcCodeToHttp(code: number): [number, string];
```

`paginate` sends GET requests and follows `nextPageToken`, sending it as `pageToken`. It sends `pageSize` when
given, and yields each element of `page[field]`.

- [ ] **Step 1: Write the failing tests.** In `tests/gcp-common-paging.test.ts`, using `FakeGoogle`:
  - **`follows nextPageToken across three pages and sends pageSize`:** yields 7 items in order, makes exactly 3
    requests, and the 2nd and 3rd carry `pageToken`.
  - **`an empty page with a token continues; a page without the field yields nothing`.**
  - **`an aborted signal stops paging after the current page`:** abort inside the `for await` after the first
    item; `fake.requests.length === 1`, and the loop rejects with the abort reason.
  - **`settledOperation`:**
    - `{ done: false }` → `undefined`;
    - `{ done: true, response: { x: 1 } }` → `{ x: 1 }`;
    - error code `8` → `RATE_LIMITED`;
    - code `9` → `INVALID_STATE`;
    - code `6` → `CONFLICT`;
    - code `5` → `NOT_FOUND`;
    - code `3` → `INVALID_INPUT`;
    - code `14` → `UNAVAILABLE`;
    - code `99` → `PROVIDER_ERROR`.
  - **`an operation error's ErrorInfo reason is kept`:** code 8, details `[EI reason RESOURCE_QUOTA_EXCEEDED]` →
    `QUOTA_EXCEEDED` with `details.reason` `RESOURCE_QUOTA_EXCEEDED`.

- [ ] **Step 2: Run them to verify they fail.**
  Run: `node node_modules/pnpm/bin/pnpm.mjs exec vitest run tests/gcp-common-paging.test.ts`
  Expected: FAIL (not exported).

- [ ] **Step 3: Implement.**
  - **`settledOperation`** maps through
    `mapGoogleError(http, { error: { code, status: name, message, details } }, emptyHeaders, what)`, so
    operation errors and HTTP errors share one table.
  - **`rpcCodeToHttp` table:**

    | Code | HTTP | Name |
    |---|---|---|
    | 1 | 499 | CANCELLED |
    | 2 | 500 | UNKNOWN |
    | 3 | 400 | INVALID_ARGUMENT |
    | 4 | 504 | DEADLINE_EXCEEDED |
    | 5 | 404 | NOT_FOUND |
    | 6 | 409 | ALREADY_EXISTS |
    | 7 | 403 | PERMISSION_DENIED |
    | 8 | 429 | RESOURCE_EXHAUSTED |
    | 9 | 400 | FAILED_PRECONDITION |
    | 10 | 409 | ABORTED |
    | 11 | 400 | OUT_OF_RANGE |
    | 12 | 501 | UNIMPLEMENTED |
    | 13 | 500 | INTERNAL |
    | 14 | 503 | UNAVAILABLE |
    | 15 | 500 | DATA_LOSS |
    | 16 | 401 | UNAUTHENTICATED |

  - **Extend `mapGoogleError`** so that `OUT_OF_RANGE` → `INVALID_INPUT` and `CANCELLED` → `UNAVAILABLE`. Add those
    two rows to the Task 2 table.
  - **No in-call waiting helper.** Callers poll across reconciler runs (program G8).

- [ ] **Step 4: Run them to verify they pass, together with `tests/gcp-common-http.test.ts`.** Expected: PASS.

- [ ] **Step 5: Commit** `gcp-common: paginate and long-running operations`.

---

### Task 4: Universe domains and endpoints

**Files:**
- Create: `packages/gcp-common/src/endpoints.ts`
- Modify:
  - `packages/gcp-common/src/auth.ts`: `serviceAccountTokenSource` and `impersonatedTokenSource` take
    `universeDomain`.
  - `packages/gcp-common/src/index.ts`.
  - `packages/provider-gcp/src/config.ts`: `GcpProviderOptions.universeDomain?: string`.
  - `packages/provider-gcp/src/provider.ts`: the endpoint default and the token sources use it.
  - `packages/provider-gcp/README.md`: one paragraph under Usage.
- Test: `tests/gcp-common-endpoints.test.ts`

**Interfaces:**
- Produces:

```ts
export const defaultUniverse = 'googleapis.com';
/** `https://<service>.<universe>`; INVALID_CONFIG (reason 'endpoint') unless service matches /^[a-z][a-z0-9-]*$/ and the universe /^[a-z0-9-]+(\.[a-z0-9-]+)+$/. */
export function googleEndpoint(service: string, options?: { universeDomain?: string }): string;
/** The default universe: https://oauth2.googleapis.com/token. Another: `https://oauth2.<universe>/token`. */
export function tokenEndpoint(universeDomain?: string): string;
```

- `serviceAccountTokenSource(keyJson, { fetch?, scopes?, universeDomain? })`:
  - **Default universe:** the allowed `token_uri`s are exactly today's two.
  - **Another universe:** exactly `{ tokenEndpoint(universe) }`.
  - **A key whose `universe_domain` differs from the configured universe** (absent counts as the default) is
    `INVALID_CONFIG` with `reason: 'universeDomain'`.
- `impersonatedTokenSource(base, email, { fetch?, universeDomain? })` posts to
  `${googleEndpoint('iamcredentials', …)}/v1/projects/-/serviceAccounts/<email>:generateAccessToken`.
- `gcpProvider({ universeDomain })`: the default `endpoint` becomes
  `${googleEndpoint('compute', { universeDomain })}/compute/v1`. An explicit `endpoint` still wins.

- [ ] **Step 1: Write the failing tests** in `tests/gcp-common-endpoints.test.ts`:
  - **`googleEndpoint builds and validates`:**
    - `('compute')` → `https://compute.googleapis.com`;
    - `('sts', { universeDomain: 'example-tpc.goog' })` → `https://sts.example-tpc.goog`;
    - `('evil.com/x')` and universe `'.com'` → `INVALID_CONFIG`.
  - **`the default universe keeps the old alias`:** a key with `token_uri`
    `https://accounts.google.com/o/oauth2/token` is accepted, and the POST goes there.
  - **`a key whose token_uri is the configured universe's endpoint is accepted`:** universe `example-tpc.goog`,
    key `token_uri` `https://oauth2.example-tpc.goog/token`, `universe_domain` `example-tpc.goog`. The POST
    goes to that URL.
  - **`a key's universe_domain never selects the universe`:** no universe configured, key `universe_domain`
    `evil.example`, `token_uri` `https://oauth2.evil.example/token` → `INVALID_CONFIG` (`reason` is
    `universeDomain` or `tokenUri`), with zero fetches.
  - **`impersonation uses the configured universe's IAM Credentials host`.**
  - **`a provider in another universe calls compute.<universe>`:** `gcpProvider({ fetch: recording,
    universeDomain: 'example-tpc.goog', tokenSource: fakeTokens })`, built for a platform account. A `get` call
    records a request whose host is `compute.example-tpc.goog`. The fake answers 404, so `get` → `undefined`.

- [ ] **Step 2: Run them to verify they fail.**
  Run: `node node_modules/pnpm/bin/pnpm.mjs exec vitest run tests/gcp-common-endpoints.test.ts`
  Expected: FAIL.

- [ ] **Step 3: Implement** as the Interfaces block says. The default-universe path of `parseKey` must keep
  today's exact error message and `reason: 'tokenUri'`, because `tests/provider-gcp.test.ts:101-167` pins them.

- [ ] **Step 4: Run every GCP suite.**
  Run: `node node_modules/pnpm/bin/pnpm.mjs exec vitest run tests/gcp-common-*.test.ts tests/provider-gcp*.test.ts tests/gcp-*.test.ts tests/vps-attach.test.ts tests/vps-discovery.test.ts tests/vps-networks.test.ts tests/vps-provider-reservations.test.ts`
  Expected: all PASS.

- [ ] **Step 5: Typecheck and lint the repo.**
  Run: `node node_modules/pnpm/bin/pnpm.mjs exec tsc -b packages/gcp-common packages/provider-gcp`, then
  `node scripts/check-deps.mjs`.
  Expected: clean.

- [ ] **Step 6: Commit** `gcp-common: universe domains (endpoints, token endpoint pin per configured universe); provider-gcp universeDomain option`,
  together with the README and CHANGELOG lines.
