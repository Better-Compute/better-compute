# DigitalOcean P1: Droplets, GPU Droplets, VPCs, firewalls and attach — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new `@better-compute/provider-digitalocean` package implements `ProviderImpl` and `ProviderNetworks`
against DigitalOcean API v2. A DO account then backs provider pools whose instances are Droplets or GPU Droplets.
Running Droplets are discovered and attached to tenants, and tenant networks map onto DO VPCs and Cloud Firewalls.
All of this goes through the vps workers and APIs that exist today.

**Architecture:** The package copies `provider-gcp`'s layout: plain `fetch`, a client, ids and a fetch-level emulator.
It uses `provider-hetzner/src/cloud.ts`'s idea for an API without request ids: the key travels as a tag, and the
provider looks it up before a create. It adds two things neither has:

- **Oldest-wins reaping.** DO Droplet names are not unique, so a racing duplicate is deleted after the fact.
- **A per-token rate-limit budget.** All of an account's reconcilers share DO's 5,000-per-hour limit.

Tags encode the `better-compute-*` labels as `<key>:<value>`. They decode back into `ExternalMachine.labels`, so
`vps.discovery` and auto-attach work unchanged.

No core, vps or migration changes are needed in this phase.

**Tech Stack:** TypeScript (ESM, Node ≥ 22.12), vitest, `manifest`/`field` from `@better-compute/core`, and
`defineProvider` and the conformance cases from `@better-compute/vps`. DigitalOcean API v2. No new npm dependencies.

**Spec:** [`2026-10-18-digitalocean-program.md`](2026-10-18-digitalocean-program.md). That plan provides:

- the requirements R1, R2 and R3, and the offer part of R4;
- decisions DO-D1, D2, D4–D11, D13–D16 and D24;
- the program's Global Constraints;
- the facts in `docs/research/digitalocean.md`, which P0 produces.

Read both before starting.

## Global Constraints

- **Runtime and dependencies.** Node ≥ 22.12, ESM only. No new npm dependencies, and no `pnpm install` while other
  agents are active. Run pnpm as `node node_modules/pnpm/bin/pnpm.mjs`.
- **Dependency rules.** The package depends only on `@better-compute/core` and `@better-compute/vps`
  (`workspace:*`). It is not in the umbrella. Nothing imports it except `tests/`.
- **Package metadata.** Package version `0.1.0`. Provider id `'digitalocean'`, `provides: ['vps']`.
  `capabilities: ['power', 'reinstall', 'list', 'discover', 'claim', 'networks']`.
- **Endpoint.** The default is `https://api.digitalocean.com/v2`. It is a code-level option (`DoProviderOptions`) and
  never comes from tenant config. A `links.pages.next` URL is followed only when its origin equals the endpoint's;
  otherwise the call fails with `PROVIDER_ERROR`, `reason 'foreignLink'`.
- **Token.** `token` is `field.secret()`. It is resolved through `context.secrets.resolve` on first use and kept only
  in the client closure. It never appears in logs, in `ComputeError.message` or in `details`.
- **Error details.** Every `ComputeError` the package throws carries
  `details: { provider: 'digitalocean', status?, id?, requestId?, reason? }`.
- **Calls stay short.** No call blocks longer than `inCallWaitMs`, which defaults to 0 and may not exceed 20 000.
  Actions are reported as `pending` and re-read on later calls.
- **Deletion safety (DO-D16).**
  - `delete`, `reinstall`, `power` and the duplicate reaper act only on Droplets that carry
    `better-compute-managed:true` **and** `better-compute-deployment:<this deployment>`.
  - Tag-scoped bulk endpoints (`?tag_name=` on `DELETE /droplets` or `POST /droplets/actions`) are never called.
- **Tags are lowercase**, made of `[a-z0-9:_-]` and at most 255 characters. Droplet names are `bc-<id>`, made of
  `[a-z0-9-]` and at most 63 characters.
- **Pagination.** `per_page=200` on every list.
- **Out of scope.** No reservations: `listReservations` stays absent.
- **Shared registries** (root `tsconfig.json`, `vitest.config.ts`) take one-line inserts only.
- **Commits.**
  - Claim first in `.claude/coordination.md`.
  - Commit with `node scripts/private-commit.mjs -F <msgfile> -- <paths>`.
  - Every message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  - Format only touched files; never commit `pnpm-lock.yaml`.
- **Emulator fidelity.** Every response body the emulator returns has the shape of a fixture under
  `tests/fixtures/digitalocean/` (from P0). Every 422 message pattern in `client/errors.ts` has one of those fixtures.

## Review Focus

1. **Duplicate Droplets after a claim expiry.** Two creates with the same idempotency key race. Expected: one
   survivor (the oldest `created_at`, then the smallest id); the other is deleted per id; both calls return the
   survivor. *Test: Task 5, `two racing creates with one key converge on the oldest droplet`.*
2. **A delete reaching a Droplet better-compute does not own.** This covers a hand-made Droplet, one tagged by another
   deployment, and one whose managed tag was removed. Expected: `INVALID_STATE` with `reason 'notManaged'`, and no
   `DELETE` request recorded. *Test: Task 5, `delete refuses an unmanaged or foreign-deployment droplet; no DELETE is
   sent`.*
3. **DO's firewall defaults differ from GCP's.** A Droplet with *any* DO firewall loses all outbound traffic unless a
   rule allows it. A Droplet with *no* firewall accepts all inbound traffic. Expected: a network's Droplets get the
   contract's implied rules (deny ingress, allow egress) the moment they join, before any tenant rule exists.
   *Test: Task 8, `a network's base firewall denies ingress and allows egress before any rule`.*
4. **Sweeps starve mutations.** Discovery pages through 2,000 Droplets with only 250 requests left this minute.
   Expected: discovery defers with `RATE_LIMITED` (`retryAfterMs` > 0) once the sweep share is spent, while a
   following `create` still goes out. *Test: Task 1, `sweep calls defer before mutate calls are refused`.*
5. **Create without SSH keys.** DO emails a root password, and password SSH stays on until cloud-init runs. Expected:
   create always sends at least one `ssh_keys` id. With no instance keys and no `defaultSshKey`, create fails
   `INVALID_CONFIG` (`reason 'noSshKey'`) before anything is posted. *Test: Task 4, `create without any SSH key is
   refused before a droplet is posted`.*

## File structure

| File | Responsibility |
|---|---|
| `packages/provider-digitalocean/{package.json,tsconfig.json,LICENSE,README.md}` | Package shell (copied from provider-gcp, renamed) |
| `src/index.ts` | Public exports |
| `src/config.ts` | `doConfig` manifest, `DoConfig`, `DoProviderOptions` |
| `src/client/http.ts` | `doClient`: request, pages, actions |
| `src/client/errors.ts` | `mapDoError`, the 422 pattern table |
| `src/client/budget.ts` | `RateBudget` per token hash |
| `src/ids.ts` | Machine and offer ids, names, the tag codec, `deploymentTag` |
| `src/compute/types.ts` | DO resource shapes (`DoDroplet`, `DoSize`, `DoRegion`, `DoAction`, `DoVpc`, `DoFirewall`, `DoSshKey`) |
| `src/compute/offers.ts` | `listOffers`, `gpuModelOf` |
| `src/compute/keys.ts` | `ensureSshKeys` |
| `src/compute/droplets.ts` | `DoCompute implements ProviderImpl` |
| `src/networks/vpcs.ts`, `src/networks/firewalls.ts`, `src/networks/index.ts` | `DoNetworks implements ProviderNetworks` |
| `src/provider.ts` | `digitaloceanProvider(options)`, `digitalocean` |
| `src/probe.ts` | `probeAccount`: the scope probe |
| `tests/support/do-emulator/{index,state,droplets,actions,tags,keys,catalog,vpcs,firewalls,autoscale}.ts` | In-memory DO API as a `fetch` |
| `tests/support/do-harness.ts` | `secrets`, `ctx()`, `build()`, `platformAccount`, `doAccount` |
| `tests/provider-digitalocean.test.ts` | Client, ids, offers, keys, compute, discover/claim |
| `tests/provider-digitalocean-networks.test.ts` | VPCs, firewalls, `setTags` |
| `tests/do-end-to-end.test.ts` | Through `betterCompute()` + vps |
| `tests/live/digitalocean.live.test.ts` | Opt-in live suite (DO-D24) |

---

### Task 0: Branch, claim, baseline

**Files:** Modify `.claude/coordination.md` (one claim line).

- [ ] **Step 1:** Confirm `docs/research/digitalocean.md` exists and is reviewed (P0). If it is missing, stop and run
  P0 first. Copy its 422 messages and size and GPU fixtures into `tests/fixtures/digitalocean/` if P0 has not.
- [ ] **Step 2:** Create branch `feat/provider-digitalocean` from `main`.
- [ ] **Step 3:** Add a claim line under `## Sessions` for `packages/provider-digitalocean/**`,
  `tests/support/do-emulator/**`, `tests/support/do-harness.ts`, `tests/provider-digitalocean*.test.ts`,
  `tests/do-end-to-end.test.ts`, `tests/live/digitalocean.live.test.ts`, `tests/fixtures/digitalocean/**`, and the
  one-line inserts in root `tsconfig.json` and `vitest.config.ts`.
- [ ] **Step 4:** Run the baseline:
  `node node_modules/pnpm/bin/pnpm.mjs vitest run tests/provider-gcp.test.ts tests/provider-hetzner.test.ts tests/gcp-end-to-end.test.ts`.
  Expected: PASS. Record any pre-existing failure.
- [ ] **Step 5: Commit:** `chore: claim the DigitalOcean provider area`.

---

### Task 1: Package scaffold, config, REST client, rate budget, emulator core

**Files:**

- Create:
  - `packages/provider-digitalocean/{package.json,tsconfig.json,LICENSE,README.md}`
  - `src/{index,config}.ts` and `src/client/{http,errors,budget}.ts`
  - `tests/support/do-emulator/{index,state}.ts` and `tests/support/do-harness.ts`
- Modify (one-line inserts):
  - root `tsconfig.json`: `{ "path": "./packages/provider-digitalocean" }` after provider-gcp
  - `vitest.config.ts` `scoped`: `'@better-compute/provider-digitalocean': 'provider-digitalocean/src/index.ts'`
- Test: `tests/provider-digitalocean.test.ts`, section `describe('client')`

**Interfaces — Produces:**

```ts
// config.ts
export interface DoConfig {
  token: SecretRef;                 // field.secret() — a PAT with the scopes in the README
  regions: string[];                // field.list(field.string(), { min: 1 }) — offers and discovery are limited to these
  vpc?: string;                     // field.string().optional() — VPC name or uuid used when create gets no NetworkRef; absent ⇒ the region's default VPC
  defaultSshKey?: string;           // field.string().optional() — fingerprint of an account key added to every Droplet
  monitoring?: boolean;             // field.bool().default(true) — DO metrics agent (needed by P9)
  ipv6?: boolean;                   // field.bool().default(false)
  allowSpot?: boolean;              // field.bool().default(false) — P3 consumes it; P1 only validates it
  discoverTag?: string;             // field.string().optional() — discovery yields only Droplets carrying this tag
  previews?: boolean;               // field.bool().default(false)
}
export interface DoProviderOptions {
  fetch?: typeof fetch;
  endpoint?: string;                // default 'https://api.digitalocean.com/v2'
  deployment?: string;              // trust-domain string; hashed into the deployment tag. Default 'default'
  inCallWaitMs?: number;            // default 0, max 20_000
  budget?: { perMinute?: number; perHour?: number };  // defaults 250 / 5000
}

// client/http.ts
export type BudgetClass = 'mutate' | 'observe' | 'sweep';
export interface DoClient {
  request<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string,
    options: { body?: unknown; query?: Record<string, string>; signal: AbortSignal; budget: BudgetClass }): Promise<T>;
  pages<T>(path: string, field: string,
    options: { query?: Record<string, string>; signal: AbortSignal; budget: BudgetClass }): AsyncIterable<T>;
  action(id: number, signal: AbortSignal): Promise<DoAction>;      // GET /actions/{id}, budget 'observe'
}
export function doClient(options: { fetch: typeof fetch; endpoint: string; token: () => Promise<string>;
  budget: RateBudget; clock: Clock; log: Logger }): DoClient;

// client/errors.ts
export function mapDoError(status: number, body: unknown, headers: Headers, nowMs: number): ComputeError;
export const unprocessablePatterns: readonly { pattern: RegExp; code: 'CAPACITY_UNAVAILABLE' | 'QUOTA_EXCEEDED' | 'CONFLICT'; reason: string }[];

// client/budget.ts
export class RateBudget {
  constructor(options: { perMinute: number; perHour: number; clock: Clock });
  /** Throws RATE_LIMITED (retryAfterMs) when `cls` may not spend now. Shares: mutate ≥ 50%, observe 30%, sweep ≤ 20% of each window. */
  take(cls: BudgetClass): void;
  /** Re-seeds from ratelimit-limit / ratelimit-remaining / ratelimit-reset (epoch seconds). */
  observe(headers: Headers): void;
}
export function budgetFor(tokenHash: string, options: ConstructorParameters<typeof RateBudget>[0]): RateBudget; // process-wide map
```

**Emulator** (`tests/support/do-emulator/index.ts`):

```ts
export class DoEmulator {
  readonly fetch: typeof fetch;
  validTokens: Set<string>;                   // default {'do-token'}
  requests: { method: string; url: URL; body?: unknown }[];
  rate: { limit: number; remaining: number; resetAt: number };   // emitted as ratelimit-* headers
  failNext(match: { method?: string; path: RegExp }, status: number, body: object): void;
}
```

The `state.ts` module holds an id counter and maps. The service modules register routes in later tasks.

- [ ] **Step 1: Write the failing tests**:

```ts
it('sends the bearer token and json, and never logs it', ...)
  // build() with secrets resolving 'secret://do/t' → 'do-token'; captured log lines and every thrown
  // error's message+details contain no 'do-token'; request has authorization 'Bearer do-token'.
it('maps DO errors to ComputeError codes', ...)  // table:
  // 401 {id:'unauthorized'} → INVALID_CONFIG reason 'token'
  // 403 {id:'forbidden'} → ACCESS_DENIED reason 'scope'
  // 404 → NOT_FOUND; 429 + ratelimit-reset=now+30 → RATE_LIMITED retryAfterMs 30_000
  // 500/503 → UNAVAILABLE; fetch rejects → UNAVAILABLE reason 'network'
  // each 422 fixture in tests/fixtures/digitalocean/422-*.json → its table code; an unknown 422 → INVALID_INPUT
  // details.requestId === body.request_id in every case
it('pages follow links.pages.next until absent, with per_page=200', ...)
it("refuses a next link on another origin", ...)  // PROVIDER_ERROR reason 'foreignLink'; no request to it
it('sweep calls defer before mutate calls are refused', ...)
  // RateBudget {perMinute:10}: 2 sweep takes pass, the 3rd throws RATE_LIMITED with retryAfterMs > 0;
  // mutate takes 3..10 still pass; the 11th mutate throws.
it('re-seeds the budget from ratelimit headers', ...)  // emulator remaining=1 → next sweep take throws
```

- [ ] **Step 2:** Run `node node_modules/pnpm/bin/pnpm.mjs vitest run tests/provider-digitalocean.test.ts -t client`.
  Expected: FAIL (module not found).
- [ ] **Step 3:** Implement the package files and the interfaces above. The token is resolved once, lazily, behind
  a shared in-flight promise. The budget is keyed by `sha256(token).hex.slice(0,16)`.
- [ ] **Step 4:** Run the same command. Expected: PASS. Also run `node node_modules/pnpm/bin/pnpm.mjs -r build` and
  `node scripts/check-deps.mjs`. Expected: exit 0.
- [ ] **Step 5: Commit:** `provider-digitalocean: package, config, API client, rate budget, emulator`.

---

### Task 2: Ids and the tag codec

**Files:** Create `src/ids.ts`. Test: section `describe('ids')`.

**Interfaces — Produces:**

```ts
export const labels = { managed: 'better-compute-managed', instance: 'better-compute-instance',
  tenant: 'better-compute-tenant', pool: 'better-compute-pool', owner: 'better-compute-owner',
  deployment: 'better-compute-deployment', key: 'better-compute-key' } as const;  // first five match vps/src/discovery.ts:369-372 and provider-gcp
export function machineId(dropletId: number): string;          // decimal string
export function parseMachineId(id: string): number;            // INVALID_INPUT unless /^[1-9][0-9]{0,18}$/
export function offerId(region: string, size: string, spot?: boolean): string;     // "nyc3/s-2vcpu-4gb" | "...@spot"
export function parseOfferId(id: string): { region: string; size: string; spot: boolean };  // INVALID_INPUT otherwise
export function dropletName(instanceId: string): string;       // "bc-" + lowercase, [^a-z0-9-]→'-', ≤ 63
export function tagFor(key: string, value: string): string;    // "<key>:<value>"; value outside [a-z0-9_-] or > 200 chars ⇒ "x" + base32lower(sha256(value))[0:26]
export function labelsFromTags(tags: readonly string[]): Record<string, string>;  // only better-compute-* keys; last wins; case-folded
export function deploymentTag(deployment: string): string;     // tagFor(labels.deployment, sha256(deployment).hex.slice(0,12))
export function keyTag(idempotencyKey: string): string;        // tagFor(labels.key, sha256(key).hex.slice(0,24))
export function networkMemberTag(network: string): string;     // "bc-net-" + sha256(network).hex.slice(0,16)
export function isManagedTag(tag: string): boolean;            // starts with 'better-compute-' or 'bc-'
```

- [ ] **Step 1: Write the failing tests:**

```ts
it('ids round-trip and refuse malformed input', ...)
  // parseMachineId('123') === 123; '0', '-1', 'abc', '1e3' → INVALID_INPUT
  // parseOfferId(offerId('nyc3','gpu-h100x1-80gb',true)) → {region:'nyc3', size:'gpu-h100x1-80gb', spot:true}
it('droplet names are bc- + a hostname-safe id', ...)   // dropletName('inst_AB/cd') === 'bc-inst-ab-cd'; length ≤ 63
it('tags encode labels and decode back', ...)
  // labelsFromTags([tagFor(labels.tenant,'acme'), tagFor(labels.pool,'pool_1'), 'web'])
  //   → { 'better-compute-tenant': 'acme', 'better-compute-pool': 'pool_1' }
  // tagFor(labels.owner, 'Ann@Example.com') matches /^better-compute-owner:x[a-z2-7]{26}$/
  // every produced tag matches /^[a-z0-9:_-]{1,255}$/
it('decoding is case-insensitive, as DO tag matching is', ...)  // 'Better-Compute-Tenant:ACME' → tenant 'acme'
```

- [ ] **Step 2:** Run with `-t ids`. Expected: FAIL.
- [ ] **Step 3:** Implement `src/ids.ts` with the signatures above.
- [ ] **Step 4:** Run with `-t ids`. Expected: PASS.
- [ ] **Step 5: Commit:** `provider-digitalocean: ids and the label/tag codec`.

---

### Task 3: Offers from sizes × regions

**Files:**

- Create: `src/compute/{types,offers}.ts`
- Create: `tests/support/do-emulator/catalog.ts` (seeded from `tests/fixtures/digitalocean/sizes.json` and
  `regions.json`)
- Test: section `describe('offers')`

**Interfaces — Produces:**

```ts
export async function listOffers(client: DoClient, config: DoConfig, query: OfferQuery, signal: AbortSignal): Promise<Offer[]>;
export function gpuModelOf(size: DoSize): string | undefined;
// 'nvidia_h100'→'H100', 'nvidia_h200'→'H200', 'nvidia_l40s'→'L40S', 'nvidia_rtx_6000_ada'→'RTX-6000-ADA'
// (canonical names from packages/inventory/src/gpu-models.ts); models absent there map to an upper-case,
// hyphenated form: 'amd_mi300x'→'MI300X', 'nvidia_b300'→'B300', 'nvidia_rtx_4000_ada'→'RTX-4000-ADA'.
```

**Mapping:**

- One offer per (size, region) with `region ∈ config.regions ∩ size.regions`.
- `available = size.available && region.available && region.sizes.includes(size.slug)`.
- `memoryGiB = memory / 1024`; `diskGiB = disk`; `pricePerHour = price_hourly`; `currency = 'USD'`.
- `gpus` from `gpu_info.count` and `gpuModelOf`.
- `kind = 'vps'`.
- Spot offers are omitted unless `config.allowSpot` (P3 fills them).
- Sizes and regions are cached for 10 minutes per client, under the `sweep` budget.

- [ ] **Step 1: Write the failing tests:**

```ts
it('lists one offer per size and configured region with price and GPUs', ...)
  // fixture size gpu-h100x1-80gb in tor1 → { id:'tor1/gpu-h100x1-80gb', vcpu:20, memoryGiB:240,
  //   gpus:{model:'H100',count:1}, pricePerHour:<fixture>, currency:'USD', available:true }
it('filters by the query and by configured regions', ...)
  // {gpuModel:'H100', minGpus:8} → only *x8* sizes; a region outside config.regions never appears
it('an unavailable size in a region is offered with available:false', ...)
it('caches the catalog for ten minutes', ...)  // two calls → 2 requests total (sizes, regions); after +10 min → 4
```

- [ ] **Step 2:** Run with `-t offers`. Expected: FAIL.
- [ ] **Step 3:** Implement `listOffers` and `gpuModelOf`. File a note for the inventory owner listing the GPU models
  that are missing from `gpu-models.ts` (`MI300X`, `MI325X`, `MI350X`, `MI355X`, `B300`, `RTX-4000-ADA`). Do not
  edit that file here.
- [ ] **Step 4:** Run with `-t offers`. Expected: PASS.
- [ ] **Step 5: Commit:** `provider-digitalocean: offers from sizes and regions`.

---

### Task 4: SSH keys and user data

**Files:**

- Create: `src/compute/keys.ts` and `tests/support/do-emulator/keys.ts`
- Test: section `describe('ssh keys')`

**Interfaces — Produces:**

```ts
/** OpenSSH public keys → DO key ids, creating `bc-<fp16>` keys that are missing. Fingerprint = MD5 colon-hex of the key blob (DO's format). */
export async function ensureSshKeys(client: DoClient, publicKeys: readonly string[], defaultFingerprint: string | undefined,
  signal: AbortSignal): Promise<number[]>;
export function md5Fingerprint(openSshPublicKey: string): string;  // INVALID_INPUT for a malformed key
```

**Behavior:**

- Lookup is `GET /account/keys/{fingerprint}`. A 404 leads to `POST /account/keys {name:'bc-'+fp.replace(/:/g,'').slice(0,16), public_key}`.
- A 422 "already in use" on that POST is treated as a race: the provider re-reads.
- Keys are never deleted by the provider: they are account-shared.
- `userData` passes through unchanged. vps already renders `sshKeys` into it when it has none.

- [ ] **Step 1: Write the failing tests:**

```ts
it('registers a missing key once and reuses it by fingerprint', ...)
  // two creates with the same key → one POST /account/keys; both droplets carry the same ssh_keys id
it('a racing registration re-reads instead of failing', ...)   // emulator failNext POST /account/keys 422 "SSH Key is already in use"
it('create without any SSH key is refused before a droplet is posted', ...)
  // no sshKeys, no defaultSshKey → INVALID_CONFIG reason 'noSshKey'; emulator.requests has no POST /droplets
it('rejects a malformed public key as INVALID_INPUT', ...)
```

The third test needs `create` (Task 5). Write it now as `it.todo`, then turn it into a real test in Task 5, Step 1.

- [ ] **Step 2:** Run with `-t "ssh keys"`. Expected: FAIL.
- [ ] **Step 3:** Implement `ensureSshKeys` and `md5Fingerprint` with `node:crypto`.
- [ ] **Step 4:** Run with `-t "ssh keys"`. Expected: PASS (the todo is reported as todo).
- [ ] **Step 5: Commit:** `provider-digitalocean: SSH keys by fingerprint`.

---

### Task 5: create, get and delete — idempotency, reaping, deletion safety

**Files:**

- Create: `src/compute/droplets.ts` and `src/provider.ts`
- Create: `tests/support/do-emulator/{droplets,actions,tags}.ts`
- Test: section `describe('compute')`

**Interfaces — Produces:**

```ts
export class DoCompute implements ProviderImpl {
  constructor(config: DoConfig, context: ProviderContext, options: Required<Pick<DoProviderOptions, 'deployment' | 'inCallWaitMs'>>, client: DoClient);
  listOffers(query: OfferQuery): Promise<Offer[]>;
  create(request: Parameters<ProviderImpl['create']>[0], ctx: CallContext): Promise<ExternalMachine>;
  get(id: string, ctx: CallContext): Promise<ExternalMachine | undefined>;
  delete(id: string, ctx: CallContext): Promise<void>;
}
export function toMachine(droplet: DoDroplet): ExternalMachine;
// state: new→pending, active→running, off→stopped, archive→deleted, else unknown
// addresses: public v4, private v4, v6 (that order); offerId = offerId(region.slug, size_slug)
// labels = labelsFromTags(tags); claimedBy = labels[labels.instance]; createdAt = Date.parse(created_at)
// networks: [{ network: vpc name, address: private v4, publicAddress: public v4, tags: tags.filter(isManagedTag) }]
export function digitaloceanProvider(options?: DoProviderOptions): ProviderDefinition<DoConfig>;
export const digitalocean: ProviderDefinition<DoConfig>;
```

**`create` protocol (DO-D4):**

1. `parseOfferId`. A region outside `config.regions` is `INVALID_INPUT`. A spot offer is `UNSUPPORTED` with
   `reason 'spot'` in P1, whatever `allowSpot` says; P3 implements Spot.
2. `GET /droplets?tag_name=<keyTag(ctx.idempotencyKey)>` (`observe`). For a GPU offer, the provider also pages
   `GET /droplets?type=gpus` and filters by the key tag on the client side. `type` can't be combined with
   `tag_name`, and the default list excludes GPU Droplets (research S2). If any Droplets come back, return
   `toMachine(oldest)`.
3. Resolve `ensureSshKeys` and the VPC: the `NetworkRef` (Task 8), else `config.vpc`, else none (DO uses the region
   default).
4. `POST /droplets` (`mutate`) with:
   - `{ name: dropletName(request.name), region, size, image, ssh_keys, user_data, vpc_uuid?, monitoring, ipv6, tags }`
   - where `tags` = `managed:true`, `deployment`, `key`, plus every `request.labels` entry through `tagFor`.
   - `image` is a slug or a numeric id. A value containing `@` is `UNSUPPORTED` with `reason 'catalogImage'`, until
     P3.
   - User data over 65,536 bytes is `INVALID_INPUT` before anything is posted.
5. Repeat the lookup in step 2, including the GPU scan for a GPU offer. If there is more than one, keep the oldest
   and `DELETE /droplets/{id}` each other one. Return the oldest.

**`get`:**

- `GET /droplets/{id}`. A 404 is `undefined`.
- If the create action the client recorded for that Droplet is `errored`, throw: `CAPACITY_UNAVAILABLE` when its
  fixture says so, otherwise `PROVIDER_ERROR` with the action's message.

**`delete`:**

1. `GET`. A 404 means done.
2. Require both the managed tag and this deployment's tag, otherwise `INVALID_STATE` with `reason 'notManaged'`.
3. `DELETE /droplets/{id}`. A 404 on it counts as success.

- [ ] **Step 1: Write the failing tests.** Also turn Task 4's todo into a real test.

```ts
it('create posts the droplet with tags, keys, vpc and user data', ...)
  // emulator.requests POST /droplets body: name 'bc-inst-1', region 'nyc3', size 's-2vcpu-4gb', image 'ubuntu-24-04-x64',
  // tags ⊇ ['better-compute-managed:true', deploymentTag('default'), keyTag('inst_1'), 'better-compute-tenant:acme']
it('create retries with one key return the same droplet without a second POST', ...)
it('a retried GPU create finds its droplet through the gpus list, not only by tag', ...)
  // emulator mirrors the spec: ?tag_name= omits GPU droplets, ?type=gpus lists them → second create posts nothing
it('two racing creates with one key converge on the oldest droplet', ...)
  // emulator.beforeAction('POST /droplets', () => insert a second droplet with the same key tag, created 1 s later)
  // both create() results have the same id (the older); emulator has exactly one droplet with that key tag;
  // exactly one DELETE /droplets/{newer id}
it('create maps capacity, quota and invalid-size 422s', ...)   // per fixture → CAPACITY_UNAVAILABLE / QUOTA_EXCEEDED / INVALID_INPUT
it('a create action that errors surfaces from get as CAPACITY_UNAVAILABLE', ...)
it('get maps states and answers undefined for a missing or malformed id', ...)
  // new→pending, active→running, off→stopped, archive→deleted; '999' (404) → undefined; 'abc' → undefined
it('oversized user data is refused before anything is posted', ...)
it('a catalog image ref is UNSUPPORTED until P3', ...)
it('a spot offer is UNSUPPORTED until P3, even with allowSpot', ...)   // reason 'spot'; no POST /droplets
it('delete refuses an unmanaged or foreign-deployment droplet; no DELETE is sent', ...)
  // three droplets: no tags; managed but deploymentTag('other'); managed+ours → first two INVALID_STATE
  // reason 'notManaged' and no DELETE recorded for them; third deleted
it('delete of a droplet that is already gone succeeds', ...)
it('never calls a tag-scoped bulk endpoint', ...)  // after the whole describe: no request has method DELETE|POST with tag_name on /droplets or /droplets/actions
```

- [ ] **Step 2:** Run with `-t compute`. Expected: FAIL.
- [ ] **Step 3:** Implement `DoCompute.create`, `get` and `delete`, plus `digitaloceanProvider`:
  - It builds the client lazily from `context.secrets`.
  - `create` (the definition's) makes **no** provider call, because vps `checkClient` builds clients for validation.
  - `INVALID_CONFIG` only when `regions` is empty or `inCallWaitMs` is out of range.
- [ ] **Step 4:** Run with `-t compute`. Expected: PASS.
- [ ] **Step 5: Commit:** `provider-digitalocean: create, get, delete with tag idempotency and oldest-wins reaping`.

---

### Task 6: power, reinstall, list

**Files:** Modify `src/compute/droplets.ts`. Test: section `describe('compute')`.

**Interfaces — Produces** (added to `DoCompute`):

- `power(id, action, ctx)`: `POST /droplets/{id}/actions {type}` with this mapping:

  | Action | DO type |
  |---|---|
  | `on` | `power_on` |
  | `off` | `power_off` |
  | `graceful-off` | `shutdown` |
  | `graceful-restart` | `reboot` |
  | `cycle` | `power_cycle` |
  | `reset` | `power_cycle` |
  | `nmi` | `UNSUPPORTED` |

  A Droplet without the managed tag, or carrying another instance's tag, is `INVALID_STATE`. The client records the
  returned action id.
- `reinstall(id, image, ctx)`: `{type:'rebuild', image}`. It has the same ownership checks, and the same image rules
  as `create`.
- `list(ctx)`: `GET /droplets?tag_name=<deploymentTag>` plus `GET /droplets?type=gpus`, the latter filtered by the
  deployment tag on the client side (`sweep`, deduped by id). It yields only Droplets that also carry the managed
  tag.

- [ ] **Step 1: Write the failing tests:**

```ts
it('power maps actions; nmi is UNSUPPORTED', ...)   // recorded bodies' type per action, in order
it('power and reinstall refuse a droplet that is not this instance's', ...)
it('reinstall rebuilds with the image', ...)
it('list yields only this deployment's managed droplets, across pages', ...)  // 450 seeded, 3 pages of 200
it('list includes managed GPU droplets', ...)
```

- [ ] **Step 2:** Run with `-t compute`. Expected: FAIL (new cases).
- [ ] **Step 3:** Implement the three methods.
- [ ] **Step 4:** Run with `-t compute`. Expected: PASS.
- [ ] **Step 5: Commit:** `provider-digitalocean: power, rebuild and list`.

---

### Task 7: discover, claim, release

**Files:**

- Modify: `src/compute/droplets.ts`
- Create: `tests/support/do-emulator/autoscale.ts`
- Test: section `describe('attach')`

**Interfaces — Produces** (added to `DoCompute`):

- `discover(ctx)`:
  - Every Droplet in `config.regions`: `GET /droplets` plus `GET /droplets?type=gpus` (`sweep`, deduped). With
    `discoverTag`, the first query is `?tag_name=<discoverTag>` and the GPU list is filtered by that tag on the
    client side.
  - Droplets that are members of a DO autoscale pool are yielded with
    `labels['better-compute-autoscale-pool'] = <pool id>`. Membership comes from
    `GET /droplets/autoscale` + `/members`, once per pass.
- `claim(id, instanceId, ctx, { managed })`. **Tag-then-verify (DO-D6):**
  1. `GET`. A Droplet whose `labels[instance]` names another id is `CONFLICT` with `reason 'claimedByAnother'`. An
     autoscale-pool member is `INVALID_STATE` with `reason 'autoscalePool'`.
  2. `POST /tags {name}` (a 422 "already exists" is fine), then `POST /tags/{name}/resources` for
     `tagFor(instance, instanceId)`, the deployment tag, and (with `managed`) `managed:true`.
  3. Re-`GET`. If another instance tag is now present too, remove ours and throw `CONFLICT` with
     `reason 'claimedByAnother'`.
  4. Return `toMachine`.
- `release(id, instanceId, ctx)`: removes the instance tag and the managed tag, only if the instance tag names
  `instanceId`. Otherwise it is a no-op. The deployment tag stays.

- [ ] **Step 1: Write the failing tests:**

```ts
it('discover yields unmanaged droplets with labels decoded from tags', ...)
  // a hand-made droplet tagged 'better-compute-tenant:acme','better-compute-pool:pool_1' → labels match vps autoAttachLabels
it('discover honours discoverTag and configured regions', ...)
it('discover includes GPU droplets, which the default list omits', ...)
it('claim tags the droplet; managed also hands deletion over', ...)
it('a droplet claimed by another instance is CONFLICT', ...)
it('a claim that races another claim backs out its own tag', ...)
  // emulator.beforeAction('POST /tags/*/resources', add 'better-compute-instance:other') → CONFLICT; our tag removed
it('autoscale pool members are discovered but refused for claim', ...)
it('release removes only this instance's tags', ...)
```

- [ ] **Step 2:** Run with `-t attach`. Expected: FAIL.
- [ ] **Step 3:** Implement the methods.
- [ ] **Step 4:** Run with `-t attach`. Expected: PASS.
- [ ] **Step 5: Commit:** `provider-digitalocean: discover, claim and release with tag-then-verify`.

---

### Task 8: Networks — VPCs, base firewall, tenant firewalls, setTags

**Files:**

- Create: `src/networks/{index,vpcs,firewalls}.ts` and `tests/support/do-emulator/{vpcs,firewalls}.ts`
- Modify: `src/compute/droplets.ts` (`create` with a `NetworkRef`)
- Test: `tests/provider-digitalocean-networks.test.ts`

**Interfaces — Produces:**

```ts
export class DoNetworks implements ProviderNetworks { constructor(client: DoClient, config: DoConfig, deployment: string); /* contract methods */ }
export function baseFirewallName(network: string): string;     // "bc-base-" + sha256(network).hex.slice(0,16)
export function compileDoFirewall(spec: ProviderFirewallSpec, network: string): DoFirewallBody;  // pure
export function refusePriorityInversion(rules: readonly ProviderFirewallSpec[]): void;           // UNSUPPORTED reason 'firewallPriority'
```

**Mapping (DO-D9, DO-D10):**

- **`ensureNetwork(spec)`.** Ensures the base firewall `baseFirewallName(spec.name)`, targeting the tag
  `networkMemberTag(spec.name)`:
  - no inbound rules, so DO denies all ingress;
  - outbound: tcp `all`, udp `all` and icmp to `0.0.0.0/0` and `::/0`.

  It reports `ready` once the firewall exists. A `spec.mtu` other than 1500 is `UNSUPPORTED` (verify the DO VPC MTU
  in P0 S3).
- **`ensureSubnet(spec)`.**
  - One VPC per subnet: `POST /vpcs {name: spec.name, region: spec.region, ip_range: spec.cidr, description: 'bc:network=' + spec.network}`.
  - A CIDR outside RFC 1918, or outside /16–/28, is refused `INVALID_INPUT` before any call (research S3). A DO
    overlap 422 becomes `INVALID_INPUT` with `reason 'cidrOverlap'`.
  - If the VPC exists by name (422 "name already in use"), the provider re-reads and compares; a different
    `ip_range` or region is `INVALID_STATE` with `reason 'subnetDrift'`.
  - `privateGoogleAccess` is ignored.
- **`ensureFirewall(spec)`.**
  - It first checks `refusePriorityInversion` against the network's other rules, which the provider has listed.
  - Then it creates or `PUT`s one DO firewall named `spec.name`, with:
    - `inbound_rules` / `outbound_rules`: one per (protocol, port). `all` expands to tcp, udp and icmp. Ports are
      `a-b` or `n`. Absent ports, and every ICMP rule, use DO's `"0"`, which means all ports (research S3; never
      `"all"`).
    - The DO firewall `status` maps `waiting` → `pending`, `succeeded` → `ready`, `failed` → `error` (with the
      message).
    - `sources.addresses` / `destinations.addresses` from the spec.
    - `tags = spec.targetTags ?? [networkMemberTag(spec.network)]`.
    - `deny` rules use the DO deny field from the P0 S3 fixture.
  - `disabled: true` deletes the DO firewall and reports `ready`.
  - A second DO firewall with the same name (no uniqueness) is reaped, oldest wins.
- **Deletes.**
  - `deleteFirewall`: by name. Gone means `deleted`.
  - `deleteSubnet`: deletes the VPC. A 409/422 "in use" is reported as `pending`, not as an error.
  - `deleteNetwork`: deletes the base firewall, then reports `deleted` when no VPC with `bc:network=<name>` remains.
    Otherwise it reports `deleting`.
- **`setTags(machineId, tags, ctx, instanceId?)`.**
  - The ownership check is the same as `power`'s, giving `INVALID_STATE`.
  - It replaces the Droplet's `bc-*` tags with `tags`, plus `networkMemberTag(<network of its VPC>)` when its VPC's
    description names a network. It keeps every other tag, `better-compute-*` included.
  - It creates missing tag objects first.
- **`create` with `NetworkRef {network, subnet?}`.**
  - The VPC is `subnet` by name, which must be in the offer's region (`INVALID_INPUT` otherwise). Without `subnet`, it
    is the network's VPC in the offer's region; none gives `INVALID_STATE` with `reason 'noSubnetInRegion'`.
  - The Droplet gets `networkMemberTag(network)` and `ref.tags` at create time, so the base firewall covers it from
    first boot.

- [ ] **Step 1: Write the failing tests:**

```ts
it("a network's base firewall denies ingress and allows egress before any rule", ...)
  // ensureNetwork → emulator firewall 'bc-base-…' has inbound_rules [] and outbound tcp/udp/icmp ports "0"; tags [networkMemberTag]
it('ensureSubnet creates a VPC once and reports drift', ...)
it('ensureSubnet refuses a public or out-of-range CIDR before any call', ...)   // 8.8.8.0/24, 10.0.0.0/8, 10.0.0.0/29
it('ensureFirewall is pending while DO applies it and error when it fails', ...)
it('ensureFirewall compiles allow and deny rules, expands all, and targets the network by default', ...)
it('ensureFirewall updates in place on change and is idempotent', ...)   // second identical ensure → no PUT
it('an allow outranking an overlapping deny is refused', ...)  // allow prio 100 tcp/22 0.0.0.0/0 + deny prio 200 tcp/22 → UNSUPPORTED reason 'firewallPriority'
it('a disabled rule removes the DO firewall', ...)
it('deleteSubnet in use is pending; delete of what is gone is deleted', ...)
it('deleteNetwork waits for its VPCs, then removes the base firewall', ...)
it('setTags keeps foreign tags, replaces bc- tags and adds the network member tag', ...)
it("setTags with an instance id touches only that instance's droplet", ...)
it('create on a network subnet attaches the vpc and member tag; a subnet in another region is refused', ...)
```

- [ ] **Step 2:** Run `node node_modules/pnpm/bin/pnpm.mjs vitest run tests/provider-digitalocean-networks.test.ts`.
  Expected: FAIL.
- [ ] **Step 3:** Implement `DoNetworks` and wire it as `networks` on `DoCompute`.
- [ ] **Step 4:** Run the same command, plus `tests/provider-digitalocean.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit:** `provider-digitalocean: VPCs, base and tenant firewalls, tags`.

---

### Task 9: Definition, conformance and the scope probe

**Files:**

- Create: `src/probe.ts`
- Modify: `src/index.ts`
- Test: section `describe('definition')`

**Interfaces — Produces:**

```ts
export interface DoAccountReport { account: { uuid: string; status: string; dropletLimit: number }; families: Record<'compute' | 'networks' | 'keys' | 'tags', 'ok' | 'denied'>; missing: string[] }
/** Read-only probe (GET account, regions, sizes, droplets?per_page=1, vpcs?per_page=1, firewalls?per_page=1, account/keys?per_page=1, tags?per_page=1). */
export async function probeAccount(config: DoConfig, context: ProviderContext, options?: DoProviderOptions): Promise<DoAccountReport>;
```

`index.ts` exports `digitaloceanProvider`, `digitalocean`, `probeAccount` and the types `DoConfig`,
`DoProviderOptions` and `DoAccountReport`. The CLI command that calls the probe is P9's.

- [ ] **Step 1: Write the failing tests:**

```ts
it('passes every case of the ProviderImpl contract', ...)
  // runConformance(providerConformanceCases(), () => ({ provider: digitaloceanProvider({ fetch: emu.fetch }),
  //   config: doAccount, attachable: <seeded droplet id>, offerId: 'nyc3/s-1vcpu-1gb', image: 'ubuntu-24-04-x64',
  //   context: { secrets, account: platformAccount } }))  → report.failed == []
it('is a well-formed definition with the documented capabilities', ...)
  // id 'digitalocean', provides ['vps'], capabilities ['power','reinstall','list','discover','claim','networks'];
  // defaults: monitoring true, ipv6 false, allowSpot false, previews false
it('building a client makes no request', ...)       // emulator.requests.length === 0 after definition.create()
it('an inline token is refused; a SecretRef resolves on first use', ...)
it('probeAccount reports denied families from 403s and lists the missing scopes', ...)
  // failNext GET /firewalls 403 → families.networks 'denied', missing ⊇ ['firewall:read']
```

- [ ] **Step 2:** Run with `-t definition`. Expected: FAIL.
- [ ] **Step 3:** Implement `probe.ts` and the exports. Fix any conformance gaps in earlier tasks' code, and re-run
  their sections.
- [ ] **Step 4:** Run the whole file: `node node_modules/pnpm/bin/pnpm.mjs vitest run tests/provider-digitalocean*.test.ts`.
  Expected: PASS.
- [ ] **Step 5: Commit:** `provider-digitalocean: conformance and account probe`.

---

### Task 10: End-to-end through vps

**Files:** Create `tests/do-end-to-end.test.ts` and `tests/do-tenant-credentials.test.ts`.

These copy the world setup of `tests/gcp-end-to-end.test.ts`:

- `computeFixture({ clock: 'sim', modules: [vps({ providers: [digitaloceanProvider({ fetch: emu.fetch })], discovery: { every: '1m', autoAttach: { ownerIdentityId } } })] })`
- A root DO account `{ token: 'secret://<root>/do', regions: ['nyc3'], defaultSshKey }` with the secret stored in
  the fixture's secret store.
- A provider pool offered to acme.

- [ ] **Step 1: Write the failing tests:**

```ts
it('creates an instance on a droplet, runs it, stops it and deletes it', ...)
  // instances.create → tick('vps.instances') until running; emulator droplet has key/managed/deployment tags; instance
  // stop → power_off recorded; delete → DELETE recorded, instance deleted
it('discovers a droplet, attaches it, and detaches it on delete', ...)
it('auto-attaches a droplet tagged for acme and its pool', ...)
it('converges a tenant network, its subnet, the base firewall and a rule targeting an instance', ...)
it('a create DO refuses for capacity ends the instance in error with ProvisionFailed', ...)
it('a tenant account cannot use env:// refs or another tenant\'s secret', ...)   // in do-tenant-credentials.test.ts
```

- [ ] **Step 2:** Run `node node_modules/pnpm/bin/pnpm.mjs vitest run tests/do-end-to-end.test.ts tests/do-tenant-credentials.test.ts`.
  Expected: FAIL first (if it passes at once, check that the test actually exercises the provider).
- [ ] **Step 3:** Fix whatever provider behavior the vps workers expose. Any vps change is out of claim: stop and
  message the vps owner instead of editing vps.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5: Commit:** `test: DigitalOcean provider end-to-end through vps`.

---

### Task 11: Live suite (opt-in)

**Files:** Create `tests/live/digitalocean.live.test.ts`.

The suite has these properties:

- **Opt-in.** `describe.skipIf(!process.env.BC_DO_LIVE || !process.env.BC_DO_TOKEN)`.
- **Run prefix.** Every resource carries the tag `better-compute-deployment:<live-run hash>`.
- **Coverage.** It runs conformance on `s-1vcpu-512mb-10gb` (or the cheapest size in the fixture), plus one network
  round-trip.
- **Cleanup.** `afterAll` sweeps every Droplet, firewall, VPC and empty tag carrying the run's deployment tag (or the
  `bc-` names it created), then asserts that none remain.

- [ ] **Step 1:** Write the suite.
- [ ] **Step 2:** Run without env: `node node_modules/pnpm/bin/pnpm.mjs vitest run tests/live/digitalocean.live.test.ts`.
  Expected: skipped.
- [ ] **Step 3:** With the user's approval and a capped test account, run with `BC_DO_LIVE=1 BC_DO_TOKEN=…`.
  Expected: PASS, with zero leftovers. Record the request count and the `ratelimit-remaining` low-water mark in
  `docs/research/digitalocean.md` (answers program Q6).
- [ ] **Step 4: Commit:** `test: opt-in live DigitalOcean suite`.

---

### Task 12: Docs, README, CHANGELOG, final verification

**Files:**

- Create or finalize `packages/provider-digitalocean/README.md`.
- Modify:
  - `apps/docs/content/docs/guides/vps/providers.mdx` (a DigitalOcean section beside GCP's)
  - `apps/docs/content/docs/guides/vps/networking.mdx` (DO mapping: a VPC per subnet, the base firewall, no
    priorities)
  - `apps/docs/content/docs/extending/providers.mdx` (the tag-idempotency pattern as a worked example)
  - `apps/docs/content/docs/guides/installation.mdx` and `apps/docs/content/docs/reference/packages.mdx`
  - `README.md` and `packages/better-compute/README.md` (the provider list)
  - `CHANGELOG.md` (Unreleased)
  - `PLAN.md` §16 (one line)
- Regenerate: `node apps/docs/scripts/generate.mjs` (`generated/packages.json`).

The README must state:

- **Minimum custom scopes:**
  - `account:read`, `regions:read`, `sizes:read`, `image:read`, `actions:read`
  - `droplet:read,create,update,delete`
  - `ssh_key:read,create`
  - `tag:read,create,delete`
  - `vpc:read,create,update,delete`
  - `firewall:read,create,update,delete`
- **The tag scheme:** the managed, instance, deployment and key tags, plus `bc-*`.
- **Never call bulk endpoints:** the provider never calls DO's tag-scoped bulk endpoints.
- **SSH key behavior:** the provider always sends a key, which is why `defaultSshKey` exists.
- **Rate budget:** DO's per-token limits are shared by every reconciler of an account; discovery defers first.
- **Firewall mapping:** the base firewall reproduces "deny ingress, allow egress", and priority inversions are
  refused.
- **Example config:**
  `{ provider: 'digitalocean', config: { token: 'secret://<tenant>/do-token', regions: ['nyc3'], defaultSshKey: '<fp>' } }`

- [ ] **Step 1:** Write the docs.
- [ ] **Step 2:** Run `node node_modules/pnpm/bin/pnpm.mjs lint:repo`. Expected: exit 0.
- [ ] **Step 3:** Announce in the coordination file, then run
  `node node_modules/pnpm/bin/pnpm.mjs vitest run`. Expected: PASS, with no new skips beyond the Postgres-only suites
  and the live suite.
- [ ] **Step 4:** Run `node node_modules/pnpm/bin/pnpm.mjs -r build`. Expected: exit 0.
- [ ] **Step 5:** Request the phase security review over the branch's commit range (program Global Constraints).
  Close HIGH and MED findings before P2 starts.
- [ ] **Step 6: Commit:** `docs: DigitalOcean provider`.

---

## Follow-ups (not tasks here)

- **Inventory.** Add the DO GPU models missing from `packages/inventory/src/gpu-models.ts` (Task 3's note) — owner:
  inventory.
- **Phase plans.** P2 (volumes, snapshots, addresses) and P3 (images, Spot, metal, MicroVMs) can start in parallel
  once this lands. Each gets its task-level plan from its section of the program plan.
