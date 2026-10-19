# GCP WS1 — Keyless tenant accounts (Workload Identity Federation) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A tenant connects a GCP project to better-compute **without any service-account key**. better-compute is an
OIDC issuer. The tenant's workload identity pool provider trusts it for exactly one subject, the account's.
better-compute exchanges a short-lived JWT for a Google access token at STS, and optionally impersonates the tenant's
service account. No tenant can ever obtain another tenant's access, even when that tenant misconfigures their
provider.

**Architecture:**

- **pki** gets `workloadIssuer()`: ES256 JWTs, a JWKS, OIDC discovery, and key rollover with next and previous
  keys.
- **server** serves the issuer's discovery document and JWKS publicly, and exposes the issuer on the module-facing
  `PkiPort`.
- **vps** gives each provider client a `ProviderContext.identity` whose subject is fixed by vps from the account
  (`compute-account:<tenantId>/<provider>/<name>`). It runs a provider's `checkAccount` (network probes) outside any
  transaction in admission, and stores a provider-declared exclusive key (the federation audience) under a unique
  index.
- **gcp-common** gets `federatedTokenSource` (STS token exchange).
- **provider-gcp** gains `federationAudience`, and its `checkAccount` proves three things before the account is
  stored:
  - the real subject is accepted;
  - two canary subjects are refused;
  - the token can read the project.

**Tech Stack:** TypeScript ESM, `node:crypto` (ES256 / P-256), plain `fetch`, vitest on PGlite. No new npm
dependencies.

**Spec:** `docs/superpowers/plans/2026-10-18-gcp-program.md` (§5 C1, C2; §6 WS1; §8 rows 1–2; §10 GD1–GD3).
Prerequisite: WS0 (`2026-10-18-gcp-ws0-foundation.md`) has landed.

## Global Constraints

- **Core is additive only.** Every new member is optional. The core edit goes in one commit that touches only
  `packages/core/src/extension.ts`, after the orchestrator's OK (`.claude/coordination.md`).
- **The subject is chosen by vps, never by a provider.** `ProviderContext.identity` can mint only:
  - the account's own subject, `compute-account:<tenantId>/<provider>/<name>`, where `<name>` is the account
    name, immutable after create;
  - and the two probe subjects:
    - `compute-account:<tenantId>/<provider>/<random>`;
    - `compute-account:<random tenant>/<provider>/<name>`.
- **Token claims and lifetime.**
  - Issuer tokens are ES256 with claims `iss`, `sub`, `aud`, `iat`, `exp`, `jti`.
  - The lifetime is ≤ 600 s (default 300).
  - The issuer URL is `https://` (also `http://localhost` and `http://127.0.0.1` in dev).
- **Network calls.** No STS, IAM Credentials or Compute call inside a database transaction. Probes run in
  `admission.check` (no transaction open).
- **A federated account never falls back on ambient credentials.** No issuer configured means `INVALID_CONFIG`
  `reason: 'noWorkloadIssuer'`.
- **Audiences are exclusive.** One audience belongs to at most one account per provider, across all tenants. The
  conflict message never names the other tenant or account.
- **Migrations.** The new migration takes the next free `vps/00NN` number at execution time (`vps/0027` today), and
  is additive.
- **Secrets.** Never log a JWT, an access token or a private key.
- **Docs and API surface.** A new API method gets an `apiSurface` row (phase `'v1.0'`, module `'vps'`) and
  `apps/docs/descriptions/api/providerAccounts.md` prose. Then regenerate with
  `node scripts/head-check.mjs --run apps/docs/scripts/sync-from-head.mjs .`.
- **Commands and commits.** Tests run with `node node_modules/pnpm/bin/pnpm.mjs exec vitest run <files>`. Commit
  with `node scripts/private-commit.mjs -F <msgfile> -- <paths>`. Messages end with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A provider condition that admits a prefix** (`assertion.sub.startsWith("compute-account:")`, or the
   tenant's own prefix). The canaries must be accepted by such a provider, so the account is refused
   (`federationTrustsAnySubject`).
   *Task 6: `refuses a provider that trusts any account subject` and `refuses a provider that trusts every
   account of the tenant`.*
2. **Tenant B registers tenant A's audience.** The second registration is `CONFLICT`, in any order of creation,
   and the message names neither A nor A's account.
   *Task 4: `two accounts with the same exclusive key conflict across tenants without naming the other`.*
3. **STS is down during create.** The account is not stored. The error is `UNAVAILABLE`, not `INVALID_CONFIG`,
   so a retry with the same idempotency key works.
   *Task 6: `an unreachable STS refuses create with UNAVAILABLE; a retry succeeds`.*
4. **The issuer key rolls over.** Tokens signed by the previous key still verify while it is listed, and the
   JWKS publishes the next key before it signs. *Task 1: `rollover publishes next, signs with current, keeps
   previous`.*
5. **A config with both `credentials` and `federationAudience`** is ambiguous about which identity acts. It is
   refused at create (`reason: 'credentialsAndFederation'`).
   *Task 5: `refuses credentials together with federation`.*

---

## File structure

| File | Responsibility |
|---|---|
| `packages/core/src/extension.ts` | Add `WorkloadIssuerPort`, `PkiPort.workload?`, `ProviderContext.identity?`, `ProviderInput.checkAccount?`, `ProviderInput.accountKey?` (Tasks 1 and 4). |
| `packages/pki/src/workload-issuer.ts` (new), `packages/pki/src/index.ts` | `workloadIssuer()`. |
| `packages/server/src/options.ts`, `ports.ts`, `http.ts` | `pki.workloadIssuer` option, `PkiPort.workload`, two GET routes, a `workload` entry in `/.well-known/better-compute`. |
| `packages/gcp-common/src/federation.ts` (new) | `federatedTokenSource`, `stsExchange`. |
| `packages/vps/src/accounts.ts`, `module.ts`, `migrations.ts` (or a new `federation.ts`) | Identity per account, `checkAccount` in admission, `exclusive_key`. |
| `packages/provider-gcp/src/config.ts`, `provider.ts`, `federation.ts` (new) | `federationAudience`, token chain, `checkAccount`, `accountKey`. |
| `tests/support/gcp/sts.ts` (new) | `FakeSts`: a workload identity provider simulator. |
| Tests | `tests/pki-workload-issuer.test.ts`, `tests/server-workload-issuer.test.ts`, `tests/gcp-common-federation.test.ts`, `tests/vps-account-federation.test.ts`, `tests/gcp-federation.test.ts`. |

---

### Task 1: The pki `workloadIssuer`

**Files:**
- Modify: `packages/core/src/extension.ts`: add `WorkloadIssuerPort`, next to `PkiPort`.
- Create: `packages/pki/src/workload-issuer.ts`.
- Modify: `packages/pki/src/index.ts`: one export line.
- Modify: `.claude/coordination.md`: the claim line for this WS's files and symbols.
- Test: `tests/pki-workload-issuer.test.ts`.

**Interfaces:**
- Produces in core:

```ts
/** The control plane as an OIDC issuer for workload identity federation (GCP WIF, AWS web identity, …). */
export interface WorkloadIssuerPort {
  readonly issuer: string;
  mint(input: { subject: string; audience: string; ttlSeconds?: number }): Promise<{ token: string; expiresAt: number }>;
  /** Public keys only: { keys: [{ kty:'EC', crv:'P-256', x, y, kid, alg:'ES256', use:'sig' }, …] }. */
  jwks(): Promise<{ keys: readonly Record<string, unknown>[] }>;
}
```

- Produces in pki:

```ts
export interface WorkloadIssuerOptions {
  issuer: string;                       // https URL (http only for localhost/127.0.0.1)
  signingKey: KeyObject;                // EC P-256 private key: signs
  nextKey?: KeyObject;                  // published, never signs (rollover)
  previousKeys?: readonly KeyObject[];  // published, never sign (in-flight tokens)
  clock?: Clock;
}
export function workloadIssuer(options: WorkloadIssuerOptions): WorkloadIssuerPort & {
  discovery(): { issuer: string; jwks_uri: string; response_types_supported: ['id_token'];
    subject_types_supported: ['public']; id_token_signing_alg_values_supported: ['ES256'] };
};
```

  - `kid` = base64url(sha256(SPKI DER)).
  - `jwks_uri` = `${issuer}/jwks.json`.
  - `jti` = a random UUID.
  - `ttlSeconds` must be an integer in 60–600, else `INVALID_INPUT`.
  - A non-P-256 key, or a non-https issuer, is `INVALID_CONFIG`.

- [ ] **Step 1: Write the failing tests:**
  - **`a minted token verifies against the JWKS with the claims asked for`:** verify with pki's own
    `verifyJwt(token, staticJwks(await issuer.jwks()))` (`packages/pki/src/attestors/cloud-iid.ts:209,238`).
    Assert:
    - `iss === issuer`, `sub`, `aud`;
    - `exp - iat === 300`, where `iat` is the manual clock's seconds;
    - the header `alg` is `ES256` and `kid` is the current key's.
  - **`ttl outside 60..600 is INVALID_INPUT`** (cases 59, 601, 1.5).
  - **`rollover publishes next, signs with current, keeps previous`:**
    - the JWKS has 3 keys;
    - a token minted by an issuer built with key A verifies against a later issuer's JWKS (current B, previous
      [A]);
    - nothing is ever signed with `nextKey`.
  - **`refuses an RSA key and an http issuer`** (`http://localhost:3000` is allowed).
  - **`the JWKS never carries private material`:** no `d` member in any key.
- [ ] **Step 2: Run them to verify they fail.**
  Run: `node node_modules/pnpm/bin/pnpm.mjs exec vitest run tests/pki-workload-issuer.test.ts`
  Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Use `crypto.sign('sha256', data, { key, dsaEncoding: 'ieee-p1363' })` for the raw R‖S signature that JWS
    needs.
  - Use `key.export({ format: 'jwk' })` for the public JWK, keeping only `kty`, `crv`, `x` and `y`.
- [ ] **Step 4: Run them to verify they pass.**
- [ ] **Step 5: Commit** `core: WorkloadIssuerPort (additive); pki: workloadIssuer (ES256, JWKS, rollover)`.

---

### Task 2: The server publishes the issuer, and exposes it to modules

**Files:**
- Modify:
  - `packages/server/src/options.ts`: `pki.workloadIssuer?: WorkloadIssuerPort & { discovery(): object }`.
  - `packages/server/src/ports.ts`: `PkiPort.workload`.
  - `packages/server/src/http.ts:142,223`: the routes, and the GET doc comment.
  - `packages/core/src/extension.ts`: `PkiPort.workload?: WorkloadIssuerPort`.
- Test: `tests/server-workload-issuer.test.ts` (setup copied from `tests/server-wellknown.test.ts:31-50`, with the
  `noStore` executor).

**Interfaces:**
- Consumes: `workloadIssuer` (Task 1).
- Produces:
  - `GET {basePath}/workload/.well-known/openid-configuration` returns `discovery()`.
  - `GET {basePath}/workload/jwks.json` returns `jwks()`.
  - Both carry `cache-control: public, max-age=300` and the existing hardened headers, and are served without
    authentication.
  - `/.well-known/better-compute` gains `workload: { issuer }` when configured.
  - Modules read the issuer as `context.pki.workload`.
- The issuer string must equal `${publicUrl}${basePath}/workload`. Otherwise `betterCompute()` throws
  `INVALID_CONFIG` (`reason: 'workloadIssuerUrl'`), because Google fetches discovery from `<issuer>/.well-known/…`.

- [ ] **Step 1: Write the failing tests:**
  - **`serves discovery and JWKS without a store or credentials`:** both 200 with the headers above;
    `jwks_uri` ends with `/workload/jwks.json`.
  - **`the well-known document names the issuer`.**
  - **`an issuer URL that is not under the API base path fails construction`.**
  - **`without an issuer both routes are 404`.**
- [ ] **Step 2: Run them to verify they fail.**
  Run: `node node_modules/pnpm/bin/pnpm.mjs exec vitest run tests/server-workload-issuer.test.ts`
  Expected: FAIL.
- [ ] **Step 3: Implement.** The routes go beside `.well-known/better-compute` in `operational(path)`. Look up
  how the public URL option is named in `options.ts` (the one `wellKnownGateway()` uses) and compare against it.
- [ ] **Step 4: Run them to verify they pass, and re-run `tests/server-wellknown.test.ts`.** Expected: PASS.
- [ ] **Step 5: Commit** `server: publish the workload issuer (OIDC discovery + JWKS); PkiPort.workload (additive core)`.

---

### Task 3: `federatedTokenSource` in gcp-common, and the `FakeSts` simulator

**Files:**
- Create: `packages/gcp-common/src/federation.ts`, `tests/support/gcp/sts.ts`.
- Modify: `packages/gcp-common/src/index.ts`.
- Test: `tests/gcp-common-federation.test.ts`.

**Interfaces:**
- Consumes from WS0:
  - `TokenSource`, `TokenContext`, `googleEndpoint`, `resolveUniverse`;
  - the internal token helpers in `packages/gcp-common/src/internal/` (`call`, `cacheMinted`, `authError`,
    `lifetimeMs`), added by WS0's final fix wave. These are not part of the public API.
- **Error mapping (amended 2026-10-18, WS0 final review).** STS answers OAuth-style
  `{ error, error_description }` bodies, not google.rpc.Status. So STS errors go through the internal `call`
  helper (4xx → `UNAUTHENTICATED` with `details.reason` = the OAuth `error`; 5xx or network → `UNAVAILABLE`),
  never through `mapGoogleError`, which would give `INVALID_INPUT`/`unknown` for `invalid_grant`.
  `federatedTokenSource` uses `cacheMinted`, so it reports its own expiry (`cachedTokenSource` over it does not
  fall back to the 5-minute trust).
- Produces:

```ts
/** STS token exchange: a third-party JWT for a federated Google access token (cached until 60 s before expiry). */
export function federatedTokenSource(options: {
  audience: string;                 // //iam.<universe>/projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>
  subjectToken: (context: { signal: AbortSignal; clock: Clock }) => Promise<string>;
  fetch?: typeof fetch;
  universeDomain?: string;
}): TokenSource;
/** One exchange, uncached (probes). Refusal → UNAUTHENTICATED with details.reason = STS `error` (e.g. 'invalid_grant'). */
export function stsExchange(options: { audience: string; subjectToken: string; fetch?: typeof fetch;
  universeDomain?: string; signal: AbortSignal }): Promise<{ accessToken: string; expiresInSeconds: number }>;
```

  - The POST goes to `${googleEndpoint('sts', u)}/v1/token` with form fields:
    - `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`;
    - `audience`;
    - `scope=https://www.googleapis.com/auth/cloud-platform`;
    - `requested_token_type=urn:ietf:params:oauth:token-type:access_token`;
    - `subject_token`;
    - `subject_token_type=urn:ietf:params:oauth:token-type:jwt`.
  - The `audience` must match
    `^//iam\.[a-z0-9.-]+/projects/\d+/locations/global/workloadIdentityPools/[a-z0-9-]{4,32}/providers/[a-z0-9-]{4,32}$`,
    else `INVALID_CONFIG` (`reason: 'federationAudience'`).
  - **The audience's host must be the configured universe's** (amended 2026-10-18). The text between `//` and the
    next `/` must equal `iam.${resolveUniverse(universeDomain)}`, else `INVALID_CONFIG` (`reason:
    'federationAudience'`). Otherwise a tenant could route its federation through another universe's IAM, around
    the universe pin.
  - 5xx or a network error → `UNAVAILABLE`.
  - Add the test `an audience from another universe is INVALID_CONFIG before any fetch`.

- `tests/support/gcp/sts.ts`:

```ts
export class FakeSts {
  constructor(options: { jwks: () => Promise<unknown>; issuer: string; audience: string;
    condition: (sub: string) => boolean; grant: (sub: string) => string /* access token to hand out */ });
  readonly exchanges: { sub?: string; accepted: boolean }[];
  readonly fetch: typeof fetch;        // answers sts.googleapis.com/v1/token only
  down: boolean;                       // true → 503
}
```

  The fake verifies the JWT with pki `verifyJwt`, and checks `iss`, then that `aud` equals
  `https://iam.googleapis.com/` + `audience.slice('//iam.googleapis.com/'.length)`, then `exp`. It applies
  `condition(sub)`. A refusal answers 400
  `{ error: 'invalid_grant', error_description: 'The given credential is rejected by the attribute condition.' }`.

- [ ] **Step 1: Write the failing tests:**
  - `exchanges the subject token for an access token and caches it`;
  - `an attribute-condition refusal is UNAUTHENTICATED invalid_grant`;
  - `a malformed audience is INVALID_CONFIG before any fetch`;
  - `STS 503 is UNAVAILABLE`;
  - `the subject token never appears in logs or error messages`.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to verify they pass.**
- [ ] **Step 5: Commit** `gcp-common: federatedTokenSource and stsExchange (STS token exchange); FakeSts`.

---

### Task 4: vps — account identity, `checkAccount` in admission, exclusive keys

**Files:**
- Modify:
  - `packages/core/src/extension.ts`: `ProviderContext.identity?`, `ProviderInput.checkAccount?`,
    `ProviderInput.accountKey?`.
  - `packages/vps/src/accounts.ts`: `accountContext`, `checkClient`, `ProviderClients.client`, `createAccount`,
    `updateAccount`.
  - `packages/vps/src/module.ts:986-1081`: the `providerAccounts.create` and `update` admission.
  - `packages/vps/src/migrations.ts`: register the new migration.
- Create: migration `vps/0027_account_exclusive_key` (next free number).
- Test: `tests/vps-account-federation.test.ts`, which uses a tiny in-test provider, not GCP.

**Interfaces:**
- Consumes: `context.pki.workload` (Task 2).
- Produces in core:

```ts
// ProviderContext
identity?: {
  /** compute-account:<tenantId>/<provider>/<name> — fixed by vps. */
  readonly subject: string;
  mint(input: { audience: string; ttlSeconds?: number }): Promise<{ token: string; expiresAt: number }>;
  /** Mints for a subject this account is not: 'sibling' = same tenant, random name; 'stranger' = random tenant, same name. */
  mintProbe(kind: 'sibling' | 'stranger', input: { audience: string }): Promise<{ token: string; subject: string }>;
};
// ProviderInput<C>
/** Network checks of an account about to be stored; runs with no transaction open. Throw INVALID_CONFIG to refuse. */
checkAccount?(config: C, context: ProviderContext & { signal: AbortSignal }): Promise<void>;
/** A key no two accounts of this provider may share (e.g. a federation audience). Pure; no I/O. */
accountKey?(config: C): string | undefined;
```

- Migration:
  - `ALTER TABLE provider_accounts ADD COLUMN exclusive_key text;`
  - `CREATE UNIQUE INDEX provider_accounts_exclusive_key ON provider_accounts (provider, exclusive_key) WHERE exclusive_key IS NOT NULL;`
- **`createAccount` and `updateAccount`** write `exclusive_key = provider.accountKey?.(config) ?? NULL`. A
  unique-violation becomes `CONFLICT` with the message `"Another provider account already uses this <provider>
  identity"` and no other detail.
- **Admission:**
  - `create` gains `admission.check`: validate the config (as `createAccount` does), then
    `provider.checkAccount?.(config, ctx)`.
  - `update` gains `admission: { prepare: () => ({ status: 'decide', resource: accountResource(input) }), check }`.
    For `update`, the account `name` comes from the stored row.
- **Building the identity.** `identity` is built only when `context.pki.workload` exists. Its subject comes from
  `(account.tenantId, provider.id, account.name)`, so `accountContext` needs `name`. Pass `name` through every
  caller.

- [ ] **Step 1: Write the failing tests** (the fixture uses a test provider whose `checkAccount` and
  `accountKey` are vi.fn, and a `workloadIssuer` wired through `computeFixture`). **Note:** `computeFixture` has no
  `pki` passthrough today (`packages/testing/src/fixture.ts:23-60`). Add `pki?: { workloadIssuer? }` to
  `ComputeFixtureOptions` as a one-line additive option, and forward it to `betterCompute`. That is the testing
  package owner's file, so add it to the coordination claim.
  - **`identity mints only the account's subject`:** inside `create(config, ctx)`, record `ctx.identity.subject`.
    It equals `compute-account:<acme>/test/<name>`. A minted token's `sub` equals it.
  - **`probe subjects differ from the account's in the documented way`:** `sibling` keeps the tenant, `stranger`
    keeps the name.
  - **`checkAccount runs outside the transaction and its INVALID_CONFIG refuses create`:** the spy asserts no open
    transaction, which the fake executor reports. Nothing is stored afterwards (`providerAccounts.list` is empty).
  - **`checkAccount UNAVAILABLE refuses create; a retry with the same key succeeds`.**
  - **`two accounts with the same exclusive key conflict across tenants without naming the other`:** acme then
    globex with the same key gives `CONFLICT`. The message contains neither `acme` nor the first account's id.
  - **`update re-runs checkAccount and moves the exclusive key`.**
  - **`no issuer configured → identity is undefined`.**
- [ ] **Step 2: Run them to verify they fail.**
  Run: `node node_modules/pnpm/bin/pnpm.mjs exec vitest run tests/vps-account-federation.test.ts`
  Expected: FAIL.
- [ ] **Step 3: Implement**, in a separate commit for the core lines first, then vps.
- [ ] **Step 4: Run the new test, `tests/vps-account-secret-scope.test.ts`, `tests/gcp-tenant-credentials.test.ts` and `tests/vps-attach.test.ts`.**
  Expected: PASS.
- [ ] **Step 5: Commit** `core: ProviderContext.identity, ProviderInput.checkAccount/accountKey (additive)`, then
  `vps: per-account workload identity, checkAccount in admission, exclusive account keys`.

---

### Task 5: provider-gcp — `federationAudience` and the token chain

**Files:**
- Modify:
  - `packages/provider-gcp/src/config.ts`: `federationAudience`.
  - `packages/provider-gcp/src/provider.ts:318-348`: `accountTokens`, plus `accountKey`.
- Create: `packages/provider-gcp/src/federation.ts`: `checkGcpAccount`, used in Task 6.
- Test: `tests/gcp-federation.test.ts` (part 1).

**Interfaces:**
- Consumes: `federatedTokenSource` (Task 3), `ProviderContext.identity` (Task 4).
- Produces:
  - **`gcpConfig.federationAudience`:** `field.string().optional().describe('Workload identity pool provider (//iam.googleapis.com/projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>): better-compute signs in as this account with no key')`.
  - **`accountTokens` order:**
    1. `credentials` and `federationAudience` together → `INVALID_CONFIG` `credentialsAndFederation`.
    2. `federationAudience` without `context.identity` → `INVALID_CONFIG` `noWorkloadIssuer`.
    3. `federationAudience` → `federatedTokenSource({ audience, subjectToken: () => identity.mint({ audience: 'https://iam.' + universe + '/' + audience.slice(('//iam.' + universe + '/').length) }).then((m) => m.token) })`,
       then `impersonate` on top if set.
    4. Otherwise today's paths (key, or ambient for platform only).
  - **Platform accounts.** A federated account is *not* ambient. F1 is satisfied for tenants, and a platform
    account may federate too.
  - **`accountKey`:** `(config) => config.federationAudience`.

- [ ] **Step 1: Write the failing tests.** The world is `GceEmulator`, plus `FakeSts` whose
  `grant(sub)` returns a token added to `emu.validTokens`, plus a `workloadIssuer`. The fetch router sends
  `sts.googleapis.com` to `FakeSts.fetch` and everything else to `emu.fetch`.
  - **`a tenant account with federation and no key creates a VM`:** acme creates the account and a pool, then
    `instances.create` runs until the VM is visible in `emu`. `emu`'s compute requests carry the STS-granted
    bearer.
  - **`federation with impersonate exchanges then impersonates`:** the emulator's iamcredentials call receives
    the STS token as its bearer.
  - **`refuses credentials together with federation`.**
  - **`a federated account without an issuer is INVALID_CONFIG noWorkloadIssuer`.**
  - **`refuses a second account with the same audience`.**
- [ ] **Step 2: Run them to verify they fail.**
  Run: `node node_modules/pnpm/bin/pnpm.mjs exec vitest run tests/gcp-federation.test.ts`
  Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to verify they pass, plus every existing GCP suite** (the list in WS0 Task 4 Step 4).
- [ ] **Step 5: Commit** `provider-gcp: keyless accounts through workload identity federation`.

---

### Task 6: provider-gcp `checkAccount` — the probes

**Files:**
- Modify: `packages/provider-gcp/src/federation.ts`, `provider.ts` (`checkAccount: checkGcpAccount`).
- Test: `tests/gcp-federation.test.ts` (part 2).

**Interfaces:**
- Consumes: `stsExchange` (Task 3), `ProviderContext.identity.mintProbe` (Task 4).
- Produces: `checkGcpAccount(config: GcpConfig, context): Promise<void>`. It does nothing for an account without
  `federationAudience` (key accounts keep today's lazy check). For a federated account it runs these steps in
  order and stops at the first failure:

| Step | Call | Failure → |
|---|---|---|
| 1 | `stsExchange` with `mintProbe('stranger')` | Accepted → `INVALID_CONFIG` `federationTrustsAnySubject`. `UNAVAILABLE` passes through. |
| 2 | `stsExchange` with `mintProbe('sibling')` | Accepted → `INVALID_CONFIG` `federationTrustsAnySubject`. |
| 3 | `stsExchange` with `mint` (the account's subject) | Refused → `INVALID_CONFIG` `federationRefused`, with `details.stsError` (STS's `error`, never the token). |
| 4 | With `impersonate`: `impersonatedTokenSource(…).token()` | `UNAUTHENTICATED` / `ACCESS_DENIED` → `INVALID_CONFIG` `impersonationRefused`. |
| 5 | `GET compute/v1/projects/<projectId>` with the resulting token | 403/404 → `INVALID_CONFIG` `projectAccess`. |

  Every message tells the tenant what to fix. The exact attribute condition to set is:
  `assertion.sub == "<subject>"`.

- [ ] **Step 1: Write the failing tests** (the `FakeSts` `condition` varies per test):
  - **`refuses a provider that trusts any account subject`:** condition
    `sub => sub.startsWith('compute-account:')`. Create gives `INVALID_CONFIG` `federationTrustsAnySubject`,
    nothing is stored, and `emu` sees no compute call.
  - **`refuses a provider that trusts every account of the tenant`:** condition
    `sub => sub.startsWith('compute-account:<acme>/')`.
  - **`accepts exactly the account's subject`:** condition `sub => sub === subject`, and
    `FakeSts.exchanges` shows 2 refusals then 1 accept.
  - **`a refused real subject explains the condition to set`:** `federationRefused`, whose message contains
    `assertion.sub == "compute-account:`.
  - **`a project the federated identity cannot read is projectAccess`.**
  - **`an unreachable STS refuses create with UNAVAILABLE; a retry succeeds`:** `FakeSts.down = true`, then
    false, with the same idempotency key.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to verify they pass.**
- [ ] **Step 5: Commit** `provider-gcp: federated accounts prove exact-subject trust and project access before they are stored`.

---

### Task 7: The `providerAccounts.federationSetup` method, docs, and the security review

**Files:**
- Modify:
  - `packages/vps/src/module.ts`: a new read method.
  - `packages/vps/src/schemas.ts`.
  - `packages/core/src/catalog.ts`: an `apiSurface` row `providerAccounts.federationSetup`, `'v1.0'`, `'vps'`,
    action `compute:providers:read`.
  - `apps/docs/descriptions/api/providerAccounts.md`.
  - `apps/docs/content/docs/guides/vps/providers.mdx`: a "Keyless GCP accounts" section.
  - `packages/provider-gcp/README.md`: Authentication, and an IAM-roles row for `roles/iam.workloadIdentityUser`.
  - `CHANGELOG.md`.
  - The generated docs (regenerate).
- Test: `tests/vps-account-federation.test.ts` (one more case), plus the guide's commands checked by hand
  against Google's docs.

**Interfaces:**
- Produces: `providerAccounts.federationSetup({ tenantId, provider, name }) → { issuer, jwksUri, subject,
  attributeCondition, allowedAudienceHint }`.
  - **`attributeCondition`** is the exact CEL string `assertion.sub == "<subject>"`.
  - **`allowedAudienceHint`** is `https://iam.googleapis.com/projects/<PROJECT_NUMBER>/locations/global/workloadIdentityPools/<POOL>/providers/<PROVIDER>`.
  - It is a read method with no provider call. Without an issuer it is `INVALID_CONFIG` (`noWorkloadIssuer`).
- **The guide section, in order:**
  1. Call `federationSetup`.
  2. Run `gcloud iam workload-identity-pools create`.
  3. Run `gcloud iam workload-identity-pools providers create-oidc` with:
     - `--issuer-uri=<issuer>`;
     - `--attribute-mapping=google.subject=assertion.sub`;
     - `--attribute-condition='<attributeCondition>'`;
     - optionally `--jwk-json-path` for an issuer Google cannot reach (GD2).
  4. Grant `roles/iam.workloadIdentityUser` to
     `principal://iam.googleapis.com/projects/<n>/locations/global/workloadIdentityPools/<pool>/subject/<subject>`
     on the SA, or grant compute roles to that principal directly.
  5. Call `providerAccounts.create` with `federationAudience` (and `impersonate`).

- [ ] **Step 1: Write the failing test:** `federationSetup returns the subject create will use, and the exact
  condition`. Create the account afterwards, and the `identity.subject` the provider saw equals the returned
  `subject`.
- [ ] **Step 2: Run it to verify it fails.**
- [ ] **Step 3: Implement it, write the docs, then regenerate.**
  Run: `node scripts/head-check.mjs --run apps/docs/scripts/sync-from-head.mjs .`, then
  `node scripts/api-surface.mjs`.
  Expected: the generator is clean, and api-surface lists the new row.
- [ ] **Step 4: Run the WS1 suite end to end.**
  Run: `node node_modules/pnpm/bin/pnpm.mjs exec vitest run tests/pki-workload-issuer.test.ts tests/server-workload-issuer.test.ts tests/gcp-common-federation.test.ts tests/vps-account-federation.test.ts tests/gcp-federation.test.ts tests/gcp-tenant-credentials.test.ts tests/provider-gcp.test.ts`
  Expected: all PASS.
- [ ] **Step 5: Security review.** Run the `security-review` skill on the WS1 commits. Then check each §8 row 1–2
  of the program plan, and each Review Focus line above, against a named test. Fix the findings, or write down
  why each is not one.
- [ ] **Step 6: Commit** `vps: providerAccounts.federationSetup; docs: keyless GCP accounts`, with the
  regenerated docs.
