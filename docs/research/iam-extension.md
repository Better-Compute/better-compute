# better-iam integration surfaces for better-compute (checked against source)

All paths below are relative to `C:\Users\Sean Filimon\Desktop\better-iam\`. Absolute paths for the files that matter most are listed at the end. Line numbers match the current checkout.

---

## 0. Constraints that shape the design

1. **A plugin mostly adds to the permission catalog. Its HTTP endpoints are not a place to proxy the control plane.**
   - Plugin endpoints always authorize `endpoint.action` on `iam/{tenantId}`, never on a specific node.
   - They are audited with `resourceId = tenantId` and no metadata.
   - The handler runs inside the IAM database transaction (`packages/server/src/operations.ts:326-358`), so it must never make network calls.
   - So the better-compute control plane should be its own service. It uses better-iam as identity provider, as decision point (`authorize` / `authorizeMany` / `listAccessible`), and as the billing ledger.
2. **Decisions are local to one tenant.**
   - `prepareDecision` refuses with `TENANT_MISMATCH` when `principal.session.tenantId !== target.id` (`packages/server/src/decisions.ts:424`).
   - Root override applies only to a root-tenant human with a `user` session and MFA (`packages/server/src/context.ts:232-241`). **A service account can never act across tenants.**
   - So a compute resource must be authorized, and registered if it is managed, in the tenant where the user acts.
   - A platform service account in the root tenant cannot register managed resources in organization tenants.
3. **Attribute types are `string | number | boolean` only.** No arrays, at most 64 per type (`packages/core/src/index.ts:449`, `packages/server/src/catalog.ts:211-225`).
   - At most 32 relations per type.
   - Parent relations reach one level only (`resource.parentRelations`).
4. **There is one `resolveResource` callback per deployment** (`packages/server/src/options.ts:271`).
   - There is no resolver per plugin.
   - The resolver is called inside the IAM transaction (`decisions.ts:408`).
5. **Batch and scan limits:**
   - `authorizeMany`: 1–50 checks (`operations.ts:253`).
   - `listAccessible`: managed types only, `limit` ≤1000, evaluates every registration of the type in memory (`operations.ts:286-320`).
   - **Every decision loads all relationship tuples of the tenant** (`decisions.ts:624`).
6. **`authorize` takes no caller-supplied request context.** "At most 8 GPUs" or "at most 24 hours" can only be expressed through resource attributes.
7. **Which tokens IAM accepts:**
   - IAM does not accept OAuth access tokens from `createOAuthProvider` as credentials (`docs/protocols.md:92,187`).
   - It does accept its own session JWTs, when their audience includes the IAM issuer (`docs/temporary-credentials.md:115-121`).
   - Cookies are host-only: `__Host-better-iam.session` with `Path=/` (`packages/server/src/http.ts:280`).
8. **Billing limits:**
   - HTTP `billing.recordMany`: at most 100 events, one audit event per batch. A root-tenant service account may record for the whole subtree.
   - In-process `iam.billing.recordMany`: at most 1000 events, audit-free.
   - At most 10 tags per event. An idempotency key makes retries safe.

---

## 1. Plugin contract

### 1.1 Types (`packages/core/src/index.ts:449-527`)

```ts
type AttributeType = 'string' | 'number' | 'boolean';
interface ResourceTypeDefinition {
  description?: string;
  actions?: string[];                        // fully qualified; join the catalog
  attributes?: Record<string, AttributeType>; // policy: resource.{name}
  parent?: string;
  managed?: boolean;                          // resolved from IAM registry, not resolveResource
  relations?: string[];                       // resource.relations / resource.parentRelations
}
interface PluginEndpointContext {
  store: IamStore;                            // the operation's transaction
  principal: AuthenticatedPrincipal;
  tenantId: string;
  deliver(d: PluginDelivery): Promise<string>;
}
interface PluginEndpoint {
  method: 'POST'; path: string; action: string;
  validate(input: unknown): Record<string, unknown>;
  handler(ctx: PluginEndpointContext, input: Record<string, unknown>): Promise<unknown>;
}
interface OperationHookInput { store; principal; tenantId; action: string; resourceId: string }
interface PluginHooks {
  beforeOperation?(i: OperationHookInput): Promise<void>;                 // in tx, after authz, before mutation
  afterOperation?(i: OperationHookInput & { result: unknown }): Promise<void>; // in tx, before audit
}
interface IamPlugin {
  id: string; actions?: string[];
  resourceTypes?: Record<string, ResourceTypeDefinition>;
  endpoints?: PluginEndpoint[]; hooks?: PluginHooks;
  validateConfig?(): void;
  migrate?(store: IamStore): Promise<void>;
  resolveContext?(principal: AuthenticatedPrincipal): Promise<Record<string, unknown>>;
  afterAudit?(event: AuditEvent): Promise<void>;
  purge?(store: IamStore, tenantIds: string[]): Promise<void>;
}
```

- **Composition** (`packages/server/src/index.ts:514`): `plugins = [...options.plugins, ...inferencePlugins(options)]`.
- **Built-in precedent:** inference is itself a plugin, `id: 'better-iam:inference'`, which adds `model` and `model-tool` (`packages/server/src/inference.ts:285-325`).
- **Reference plugin:** `packages/projects/src/index.ts` (`createProjectsPlugin()`), re-exported by the umbrella as `better-iam/projects` (`packages/better-iam/src/projects.ts` is `export * from '@better-iam/projects'`).

### 1.2 Validation rules

**Catalog constructor** (`catalog.ts:316-385`):

- **Action names:**
  - May not start with `iam:` or `tenant/`, and may not contain `*`, `?` or whitespace (`catalog.ts:387-393`).
  - Plugin action namespaces become catalog `namespaces`, so tenant-defined types can never register `compute:*`.
- **Resource type names:**
  - Must match `/^[a-z][a-z0-9-]{0,63}$/`.
  - Reserved names: `iam, oauth-client, scim, saml, ssf, role, tenant, identity, session`.
  - Must be unique across the host's `permissions.resourceTypes` and all plugins; a duplicate is `INVALID_CONFIG`. Watch for collisions, for example the console's `workspace`.
- **Attribute names:**
  - Must match `/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/` and may not be `tenantId`.
  - Values are checked only for managed types: strings ≤2048 characters with no control characters, finite numbers.
- **Relations:** at most 32, each matching `/^[a-z][a-z0-9_-]{0,63}$/`.
- **Parent chain:** must exist and be acyclic. **A managed type needs a managed parent chain.**

**Endpoints** (`packages/server/src/plugins.ts`):

- POST only.
- Path must match `^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$` and be unique within the plugin.
- `action` must already be in the catalog.
- Duplicate plugin IDs are `INVALID_CONFIG`.

### 1.3 Runtime behaviour

- **Endpoint route:** `POST {basePath}/plugins/{id}/{path}` (`http.ts:374-382`).
  - Requires JSON, the `X-Better-IAM: 1` header, a body ≤64 KiB (`http.ts:580-587`), and an `Origin` header for cookie requests.
  - Client: `client.$request('plugins/compute/...')`.
- **`callPlugin`** (`operations.ts:326-358`):
  - Checks that `raw.tenantId === tenantId`, then calls `validate`.
  - Then calls `operation(credential, tenantId, endpoint.action, /*resourceId*/ tenantId, ...)`.
  - The operation authorizes on `iam/{tenantId}`, runs `beforeOperation` for every plugin, takes SoD and invariant snapshots, runs the handler, re-verifies SoD and invariants, runs `afterOperation`, and writes the audit event.
- **Hooks are global.** They fire for **every** operation, built-in IAM ones included (`operations.ts:166-174`).
- **`resolveContext`** (`decisions.ts:446-459`):
  - Merge order: host `options.resolveContext`, then each plugin's `resolveContext`.
  - Server-owned keys are then removed (`isServerOwnedKey`, `packages/server/src/context-keys.ts:144`).
  - Identity attributes are applied next, then the server's own keys.
  - It receives only the principal: no transaction and no target tenant.
- **`afterAudit`** runs from `iam.events.dispatch()` (`events.ts:222-230`): at-least-once, in sequence, for all events. It queues only if some plugin defines `afterAudit`.
- **`migrate`** runs per plugin in its own transaction inside `iam.initialize()` (`lifecycle.ts:202`).
- **`purge`** runs inside the tenant-purge transaction (`lifecycle.ts:854`).

### 1.4 What a decision sees (`decisions.ts:372-691`)

- **Resolve order:**
  1. Internal `iam/...` types.
  2. `model` (inference).
  3. The managed registry.
  4. `options.resolveResource`, which must echo `{tenantId, type, id}` or the call fails with `RESOURCE_MISMATCH`.
- **Resource context:**
  - `resource.{attr}` and `resource.tenantId`.
  - `resource.relations`: relations held on `{type}/{id}`.
  - `resource.parentRelations`: relations on `attributes.parentType` / `attributes.parentId`.
  - Managed records add `ownerId`, `parentId` and `parentType` (`catalog.ts:265-273`). An app-owned resolver can return the same keys itself.
- **Relationships:** `tx.find('relationships', { tenantId })` runs on **every** decision. Relations never apply to role sessions (`decisions.ts:624-634`).
- **Lazy keys** (read only when a policy names them):
  - `tenant.features`.
  - `principal.teams`, `principal.departments`, `principal.departmentId`.
  - `principal.onboarding`.
  - `principal.spendExceeded`, `principal.budgetsExceeded`.
- **Server principal keys** (`context-keys.ts:17-70`): `principal.id`, `tenantId`, `mfa`, `kind` (`user|service|agent`), `owner`, `rootAdmin`, `sessionKind`, `authMethod`, `groups`, `roles`, `teams`, `departments`, `departmentId`, `spendExceeded`, `budgetsExceeded`, `delegated`, `agentId`, `agentSponsorId`, `agentModel`, `mfaTime`, `authTime`, `sessionTags.*`, `request.time`, `request.sourceIp`.
- **There is no `tenant.region`.**
- **Auditing** (`operations.ts:198-221`):
  - `authorize` writes an audit event only for denials and root overrides.
  - Allowed decisions feed `accessUsage`, which drives role mining.
  - Denials come back as `ACCESS_DENIED` with empty `matched`.

### 1.5 Policy language (`packages/core/src/policy.ts`)

- **Operators:**
  - `StringEquals/NotEquals/EqualsIgnoreCase/NotEqualsIgnoreCase/Like/NotLike/LikeIgnoreCase`
  - `Bool`
  - `NumericEquals/NotEquals/LessThan/LessThanEquals/GreaterThan/GreaterThanEquals`
  - `DateBefore/After`
  - `IpAddress/NotIpAddress`
  - `ArrayContains/ArrayContainsAll`
  - `Exists`
- **Semantics:** keys inside an operator are ANDed. A list of values means any-of; negated operators and `ArrayContainsAll` mean all-of. A missing or wrongly typed value fails every operator except `Exists`.
- **Variables:** `${principal.id}` may appear in resource patterns (after the type segment only) and in string condition values. Never in actions. Substituted values match literally.
- **Limits:** ≤128 statements; ≤128 actions or resources per statement; ≤64 keys per operator; ≤64 values per key.

**The policy asked for works today**, provided `pool` (or `node`) exposes these attributes:

```json
{ "sid": "ReserveH100InRegions", "effect": "allow",
  "actions": ["compute:gpus:reserve"], "resources": ["pool/*"],
  "conditions": {
    "StringEquals": { "resource.gpuModel": "H100", "resource.region": ["us-east-1", "eu-west-1"] },
    "ArrayContains": { "resource.relations": "user", "tenant.features": "compute.h100" },
    "Bool": { "principal.mfa": true } } }
```

```json
{ "effect": "deny", "actions": ["compute:gpus:reserve", "compute:nodes:provision"],
  "resources": ["*"], "conditions": { "Bool": { "principal.spendExceeded": true } } }
```

What it cannot express without changes:

- Limits on request parameters such as GPU count or duration. The only route is to model the pending reservation as a resource whose resolver returns `gpuCount` and `durationHours`, then use `NumericLessThanEquals`.
- Data residency by the tenant's home region, because `tenant.region` does not exist.

### 1.6 Managed resources versus application-owned resources

| | Managed (`iam.api.resources.register`) | Application-owned (`resolveResource`) |
|---|---|---|
| Storage | `resources` collection, uniqueKey `{type}/{id}` per tenant (`api/resources.ts`) | Compute database |
| Writes | Each `register` / `update` / `delete` is an audited, hash-chained operation. `registerMany` handles ≤100 items and authorizes and audits each one on `iam/{type}/{id}` (`api/resources.ts:107-180`) | None |
| `listAccessible` / `useAccessible` | Yes | **No**: `managedDefinition` throws (`catalog.ts:429-446`) |
| Relations | Checked against the registration | Allowed on any ID (`api/relationships.ts:50-54`) |
| Parent | Must be registered, of the declared parent type, one parent only | Resolver sets `parentType` / `parentId` |
| Moves between tenants | Delete, then register again (two audit events) | Resolver checks the current allocation |
| Who may set attributes | Anyone holding `iam:resources:create/update` in that tenant, **so authorization attributes can be forged unless only compute's identity holds those rights** | Only the trusted resolver |
| Limit | `TenantLimits.resources` | None |

**Recommendation for thousands of GPUs** (for example 1,000 nodes × 8 GPUs):

- **Never register individual GPUs.** Authorize at pool or node level; the GPU identity is state inside compute.
- **Managed** (low count, shareable, needs pickers):
  - `pool`: one GPU model per pool, so policies can condition on `resource.gpuModel`.
  - `provisioning-profile`.
  - Private `image` records per organization, if needed.
  - Registered in the **organization tenant**.
- **Application-owned** (resolver or proposed evaluate API):
  - `region` and public `image`: platform catalogs referenced from every tenant. Registering them per organization would be wasteful.
  - `node`: allocations move, and state churns.
  - `reservation`: high churn, short-lived.
  - `gpu`: declared only so policies can name it.
- The resolver returns `parentType: 'pool'` so that pool relations reach nodes and GPUs through `resource.parentRelations`. That requires GPU → pool directly, not GPU → node → pool, because parent relations reach one level only.
- **Keep volatile state out of IAM** (health, utilization, allocation). Only lifecycle-grade attributes belong there.

### 1.7 Sharing a pool with a team

- **Team → group:** every team owns a backing group, `Team.groupId` (`packages/server/src/teams.ts:44-45`). Its members include the members of descendant teams.
- **Call:**
  ```ts
  iam.api.relationships.create(cred, {
    tenantId, type: 'pool', id: poolId, relation: 'user',
    subjectType: 'group', subjectId: team.groupId, expiresAt?,
  })
  ```
  - Requires `iam:relationships:create` on `iam/pool/{poolId}`.
  - uniqueKey is `pool/{id}#user@group:{groupId}` (`api/relationships.ts:24-79`).
- **Subjects** can only be `identity` or `group`.
- **Restricting who may share:** administrative decisions on `iam/pool/{id}` see the managed attributes. For example, allow `iam:relationships:create` on `iam/pool/*` only with `StringEquals: {'resource.ownerId': '${principal.id}'}`.

### 1.8 Identity attributes

- Declared only by the host in `permissions.identityAttributes`. The console declares `{ department, title }` (`apps/console/better-iam.config.mjs`).
- Names in `reservedPrincipalKeys` are refused (`catalog.ts:283-306`).
- Plugins cannot declare them. They can only add unvalidated `resolveContext` keys, which policy lint flags unless those keys are passed as `contextKeys`.

### 1.9 Limits

| Call | Limit | Source |
|---|---|---|
| `authorizeMany` | 1–50 checks, one transaction, advisory | `operations.ts:248-277` |
| `listAccessible` | managed only; `limit` 1–1000 (default 100); `offset` ≤1e6; returns `{resources, total}` | `operations.ts:286-320` |
| `resources.registerMany` | 1–100 | `api/resources.ts:112-117` |
| `resources.list` | `limit` ≤1000; full scan, then sort | `api/resources.ts:226-254` |
| HTTP body | 64 KiB | `http.ts:587` |
| React | `useAuthorize({tenantId, checks})`, `<Can tenantId action resource fallback loading>`, `useAccessible({tenantId, action, type, limit, offset})` | `packages/react/src/index.tsx:179,263,294` |

**Existing console bug to avoid copying:** the Workspaces page issues 1 + 2N checks through `can()` (`apps/console/src/lib/org.ts:23-53`, `apps/console/src/app/cloud/[org]/workspaces/page.tsx:15-23`). With more than 24 workspaces the request fails with `INVALID_INPUT`, which is caught, and **every check silently reads as false**. Node lists must use `listAccessible`, or chunk requests at 50.

---

## 2. Billing (`docs/billing.md`, `packages/server/src/billing.ts`, `billing-service.ts`, `api/billing.ts`)

### Meters

- **Record:** `BillingMeter { key, name, unit, aggregation: 'sum'|'unique', pricing: 'rate-card'|'reported', archived }` (`billing.ts:296-313`).
- **Key format:** `/^[a-z][a-z0-9_.-]{0,63}$/`.
- **Ownership:** meters defined on the root tenant are platform meters. Organizations can define chargeback meters for their own subtree.
- **API:**
  - `iam.api.billing.createMeter(root, { tenantId: rootId, key, name, unit, ... })`
  - `setPrice(root, { tenantId, meter, price: { model: 'per-unit'|'graduated'|'volume'|'package', unitAmount | tiers | packageSize/packageAmount, includedQuantity?, ...}, targetTenantId?, effectiveFrom?: 'YYYY-MM', note? })`
- **Pricing is per meter.** Tags do not change price, so each GPU model needs its own meter.
- **Reported meters** take a `cost` (currency units) on each event.

### Recording usage

**Input:** `UsageInput` (`billing.ts:697-714`):

```ts
{
  tenantId, meter,
  quantity?,        // 0..1e15, default 1
  cost?,            // reported meters only
  identityId?,
  teamId?,          // overrides the person's own teams
  tags?,            // ≤10; key ^[A-Za-z][A-Za-z0-9_.:-]{0,63}$; value ≤128
  occurredAt?,      // ≤5 min ahead, ≤366 days back
  idempotencyKey?,  // ≤200 characters
}
```

**Result:** `UsageReceipt { id, tenantId, meter, quantity, costMicros?, period, occurredAt, identityId?, teamIds, departmentId?, duplicate }`.

**Three entry points:**

1. **In-process, trusted.** `iam.billing.record(input & { enforceBudgets? })` and `iam.billing.recordMany(events ≤1000)`: audit-free, `recordedBy: 'deployment'` (`api/billing.ts:3567-3595`).
2. **HTTP.** `POST {basePath}/billing/record` authorizes `iam:billing:record` on `iam/billing/meters/{key}` (`api/billing.ts:1353-1368`). `POST {basePath}/billing/recordMany` takes `{ tenantId, events: [...] }` with 1–100 events, all or nothing; each event's `tenantId` may be that tenant or **any tenant below it**; the batch authorizes on `iam/billing` and writes one audit event (`api/billing.ts:1374-1404`). **A root-tenant service account can therefore meter every organization.**
3. **Module hook.** `ctx.billing.recordPriced(tx, PricedUsageInput)`, which never throws. Only in-process modules can use it (`billing-service.ts:255-277`).

**Attribution:**

- Usage is attributed to the identity, the person's teams (or `teamId`) and their department.
- Agents' usage counts toward the sponsor's teams and department.
- Usage is rolled up daily per `(tenant, day, meter, identity, agent, teams, department, tags)` (`billing.ts:750-768`).
- **High-cardinality tags such as reservation or node IDs multiply rollup rows.** Keep reservation IDs in `idempotencyKey` only.

**Errors:**

- `BILLING_PERIOD_CLOSED` (409): the month is already invoiced. `closePeriod` runs daily, so the compute outbox must flush before it.
- `METER_ARCHIVED` (409).
- `SPEND_LIMIT_REACHED` (402).
- `CONFLICT`: an idempotency key reused on a different meter.

### Spend reports

`iam.api.billing.spend(cred, { tenantId, period?, groupBy, meter?, identityId?, teamId?, departmentId?, subTenantId?, rollUp?, billableOnly?, shareUnattributed? })`

- `groupBy` is one of `meter | identity | agent | team | department | tenant | day | tag:{name}`.
- Related calls: `trend`, `teamSpend` (team maintainers), `departmentSpend` (department heads), `mySpend` (anyone), `exportSpend` (CSV).
- Returns `SpendReport { rows: SpendRow[], total, forecast? }` (`billing-service.ts:112-169`).

### Budgets

- **Record:** `BillingBudget { subjectType: 'tenant'|'team'|'department'|'identity', subjectId, amountMicros, period: 'month'|'quarter'|'year', meters?, thresholds, forecastAlerts, notify, enforce }` (`billing.ts:1242-1263`).
- `meters` is a list of **exact** keys, 1–20 (`api/billing.ts:818`).

**Budgets can gate actions, in three ways:**

- **Before reserving.** Forward the caller's credential to `POST billing/check { tenantId, meter? }`. It is not audited and returns `SpendCheck { allowed, budgets, blockedBy? }` (`api/billing.ts:1929-1950`). The trusted equivalent is `iam.billing.check({ tenantId, identityId, meter })`.
- **In policies.** Deny on `principal.spendExceeded` (enforced budgets only) or `principal.budgetsExceeded` (a list of names). Both are cached up to 30 s (`billing-service.ts:353`).
- **During a run.** GPU-hours are metered after use, so `record({ enforceBudgets: true })` comes too late, and `recordMany` has no such flag. Subscribe to the `billing:budget-alert` webhook, or poll `billing.check` for running reservations, and drain or stop them.

### Scheduler jobs

| Job | Cadence |
|---|---|
| `checkBudgets` | hourly |
| `recordSeats` | daily |
| `closePeriod` | daily |
| `detectAnomalies` | daily |
| `sendPaymentReminders` | daily |

Reserved-capacity contracts map to plans (`kind: 'fee'`) and `setTerms({ minimumCommitment })`.

### Suggested meters (root tenant)

| Meter | Unit | Notes |
|---|---|---|
| `gpu.h100.hours`, `gpu.a100.hours`, … | `gpu-hour` | `sum`, rate card |
| `node.metal.hours` | `node-hour` | |
| `vps.vcpu.hours` | `vcpu-hour` | |
| `storage.gb.days` | `GB-day` | |
| `net.egress.gb` | `GB` | |
| `compute.spot` | — | Reported meter, for market-priced capacity |

- **Tags:** `region`, `pool`, `gpuModel`, `project`.
- **Idempotency key:** `cmp:{reservationId}:{windowStart}`.

---

## 3. Inference (`docs/inference.md`, `packages/server/src/inference.ts`, `inference-gateway.ts`)

**What it provides:**

- **Providers:** `kind: 'anthropic' | 'openai' | 'openai-compatible'`. Keys are sealed; administrators see the last four characters.
- **Models:** published per tenant and inherited down the tree, as resource `model/{name}` with action `inference:invoke`.
  - Attributes: `provider`, `providerKind`, `upstreamModel`, `family`, `tier`, `contextWindow`, `inputPricePerMTok`, `outputPricePerMTok`, `enabled`.
  - `fallbacks`: up to 5, same wire format.
  - `providerTools`: `allow | deny | policy`.
- **Budgets:** tokens, cost or requests per `minute | hour | day | month`, for `tenant | group | identity`, `shared` or `each`.
- **Gateway:** `iam.inference.gateway({ basePath })` exposes `/v1/messages`, `/v1/chat/completions`, `/v1/responses`, `/v1/embeddings` and `/v1/models`.
- **External gateways:** `inference.check` returns a ticket, then `inference.record` meters it (needs `iam:inference:record`).
- **Billing:** every metered call feeds the built-in reported meter `inference`.

**Self-hosted models on better-compute GPUs as a provider: yes, today.**

- Register a model deployment (for example vLLM or SGLang) as `createProvider({ kind: 'openai-compatible', baseUrl, apiKey })` plus `createModel({ name, providerId, upstreamModel, tier, inputPricePerMTok, ... })`.
- `baseUrl` must be `https`, with no credentials or query (`inference.ts:376-400`).
- A custom `baseUrl` is **root-only** unless the deployment sets `inference.allowCustomBaseUrls`.
- The gateway uses plain `fetch` with no private-network guard (`inference-gateway.ts:463`), so an internal HTTPS load balancer works.

**Design notes:**

- **One `baseUrl` per provider.** Put the replicas behind a load balancer the control plane manages.
- **Health:** have the control plane flip `enabled` (or `updateModel`) on health changes, and use `fallbacks` to fall back to a hosted API.
- **Automation:** better-compute can publish or retire providers and models when a model deployment goes live. That needs a credential with `iam:inference:manage`, and root for the base URL.
- **Avoid double billing:** bill consumers per token (`inference` meter), and book the serving GPU-hours as chargeback to the platform or serving team, not to the consumer.
- **Two kinds of budget:** inference budgets are hard per-call caps; billing budgets watch money across all meters.

---

## 4. Hosts and regions (`docs/hosts-and-regions.md`, `packages/server/src/hosts.ts`)

**What "region" means in better-iam:**

- An IAM region is the **home region of a tenant's identity data and sign-in** (`Tenant.region`, inherited from ancestors).
- Configuration: `regions: { current, regions: Record<name, {baseURL?, label?}>, locate? }`, 1–64 regions.
- Region names match `/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/` (`hosts.ts:40-50,130,161-189`).
- Only sign-in entry points answer `WRONG_REGION` (421, with `region` and `location`). Authenticated calls are not refused by region.
- `hosts.patterns` (`{tenant}.signin.example.com`, `{region}`) and custom hostnames only pin requests to an organization.

**Recommendation:**

- **Do not reuse** the IAM `regions` option as the compute region registry. It describes IAM deployments, is capped at 64 and is tied to base URLs.
- **Align names:** use the same grammar and identical IDs for the same geography, and store `iamRegion` on the compute region.
- **Separate databases per region** (`locate`): a tenant's data exists only in its home region. The compute control plane must send `authorize` and `billing` calls for a tenant to that region's IAM `baseURL`.
- **Residency policies** such as "EU organizations only in EU compute regions" need the new `tenant.region` context key (gap 6).

---

## 5. Features, limits, configuration as code, JIT access

**Feature flags** (`docs/feature-flags.md`):

- Platform or tenant flags, with kill switch, targets (optionally `locked` or expiring), overrides, rollout percentage, and `internal` flags.
- Server-side reads: `iam.features.isEnabled(tenantId, key)`, `values`, `evaluate`.
- In policies: `ArrayContains: {'tenant.features': 'compute.h100'}`.
- In React: `useFeatureFlag(s)`.
- Keys are ≤64 characters; at most 200 flags per tenant.
- **Use for:** gating product lines such as `compute.baremetal`, `compute.spot` and `compute.h100` per organization.

**Tenant limits** (`TenantLimits`, `packages/core/src/index.ts:192-204`):

- A closed set: `identities, serviceAccounts, agents, groups, roles, policies, resources, webhooks`.
- Set per tenant with `tenants.setLimits(cred, { tenantId, limits | null })` (`api/tenants.ts:353`); `tenantDefaults: { limits, authPolicy }` applies on `tenants.create`.
- Enforced by `enforceLimit`, which fails with `LIMIT_EXCEEDED` (409) (`context.ts:406-415`); validated in `tenant-policy.ts:130-151`.
- **Plugins cannot add keys** such as `compute.gpus`. Until gap 8, keep GPU and node quotas in compute, keyed by IAM `tenantId`.

**Configuration as code** (`packages/server/src/sync.ts`):

- `TenantConfig v1` has fixed kinds: `resourceTypes, policies, roles, groups, bindings, accessPolicy, packages, invariants, agreements, teams, departments, agents, inferenceModels, inferenceBudgets`.
- **API:** `config.export(cred, {tenantId})`, `config.plan(cred, {tenantId, config, prune?})` (needs `iam:config:read`) and `config.apply(...)` (needs `iam:config:apply`).
  - Changes are keyed by name, run in one transaction, and each is authorized like the direct call.
  - `ConfigPlan { tenantId, prune, changes: ConfigChange{kind,name,action,fields?,before?,after?}[], summary }`.
  - The apply is audited as `config:apply`.
- **CLI:** `config-export`, `config-plan --prune --fail-on-drift` (exits with `CONFIG_DRIFT`), `config-apply`.
- **Mirror this exactly** for a compute `FleetConfig { version: 1, regions, pools, provisioningProfiles, images, quotas }`.
- Compute roles and policies can already live in IAM `TenantConfig`, because the catalog knows plugin actions.

**Just-in-time elevation and break-glass for node root** (`docs/privileged-access.md`):

- **Eligible binding:** create a "Node root (break glass)" role with an eligible binding (`eligible: true`), a `maxActivationMs` cap (7 days maximum), `requireJustification`, `requireMfa`, `requireApproval` and a named approver group. Tenant-wide floors come from `tenants.setAccessPolicy`.
- **Policy:** allow `compute:nodes:ssh-root` on `node/*` with `Bool principal.mfa: true`.
- **Issuing access:** compute calls `authorize` at SSH certificate issuance and caps the certificate TTL at the activation's `expiresAt`, which the member can read through `bindings.listMine`.
- **Revocation signals:** `binding:activate` and `binding:deactivate` events.
- **Standing GPU access:** access packages with birthright rules, for example `department = ML`.

**Daemons:**

- Do not give each node an IAM identity; that is thousands of service accounts.
- Use compute's own node PKI: a bootstrap token exchanged for an mTLS certificate.
- Verify operator tokens on the daemon offline with `createSessionTokenVerifier({ issuer, audience: 'https://compute…', jwks })` from `better-iam/session-tokens` (runtime-neutral, `jose` only).

---

## 6. Console (`apps/console`)

**Stack and wiring:**

- **Stack:** Next 15.5 App Router, React 19, TypeScript, `server-only`. No UI library: its own `components/ui.tsx` and `app/globals.css`. `better-iam` runs in-process; `serverExternalPackages` is set in `next.config.ts`.
- **`src/lib/iam.ts`:**
  - Keeps one `betterIam` instance per process on `globalThis`, with options from `better-iam.config.mjs` (`createOptions`).
  - Mounts SCIM with `useProtocol`.
  - Runs background `setInterval` jobs: outbox and audit hooks every 1 s; sweep, invariants and team reviews hourly; `billing.checkBudgets` hourly; seats, `closePeriod` and anomalies daily.
- **Routes:**
  - `/api/iam/[...path]/route.ts` is `iam.handler` (plus "view as" cookie handling).
  - `/api/ai/[...path]` is the inference gateway.

**Two roots:**

| Root | Guard | Navigation |
|---|---|---|
| `/admin` | `requireRootSession()` (`src/lib/session.ts:32`): `identity.rootAdmin` | `adminAreas()`: Overview, Platform, Governance, Security, Operations |
| `/cloud/[org]` | `requireOrgSession(org)`: session tenant must equal the organization | `orgAreas(base)`: Home, Directory, Access, Governance, AI, Developers, Organization |

- Navigation is **static data** in `src/lib/navigation.ts`, with no extension point.
- `components/shell.tsx` renders the tabs and sidebar.
- **Page helpers:** `orgPage(org)` returns `{session, tenant, iam, auth: {headers}, tenantId, base}`. `can(page, checks)` wraps `authorizeMany` and returns a map keyed `action@type/id` (`src/lib/org.ts`).
- **`ApiForm`** (`components/api-form.tsx:110-270`): typed `FieldSpec[]`, submits with `iamClient().$request(path, body)`, **IAM base path only**. `src/lib/client.ts` sets `requestId: true` and `retryRateLimited: true`.
- **Analog to copy:** the `workspace` managed type with relations `viewer/editor/owner` (`better-iam.config.mjs`) and its pages.

**Framework packages:**

- `packages/next` (`createIamNext(iam)`) needs an **in-process** IAM instance (`handler`, `require`, `authorizeMany`).
- `packages/react`: `IamProvider`, `useSession`, `useAuthorize`, `Can`, `useAccessible`, `useFeatureFlag(s)`, `useModels`, `useTeams`, `useMySpend`, `useSpendCheck`.

**How better-compute plugs in:**

- **A. A Compute section in `apps/console` (recommended for v1).**
  - Add an `area(base, 'compute', ...)` to `orgAreas`: Pools, Nodes, Reservations, Images, Profiles, Usage.
  - Add a Fleet area to `adminAreas`: Regions, Inventory, Providers, Capacity, Daemons.
  - Server components call the compute API with a session JWT: `iam.api.sts.getSessionToken(page.auth, { format: 'jwt', audience: [iamIssuer, COMPUTE_AUD], durationSeconds: 900, policy: computeOnly })`. This requires `sts.jwt`.
  - **Cache that JWT per IAM session ID.** `maxSessionTokensPerIdentity` defaults to 50 live tokens.
  - `getSessionToken` refuses impersonation (`IMPERSONATION_RESTRICTED`), so "view as" pages fall back to server-side bearer forwarding.
  - Pool pickers can use `useAccessible({ type: 'pool', action: 'compute:gpus:reserve' })`.
  - `ApiForm` needs a transport prop (gap 10).
- **B. A standalone better-compute console.**
  - It must be same-site: path-proxied under the IAM origin so the host-only cookie flows. Or it embeds `better-iam` in-process against the same database.
  - OIDC sign-in through `createOAuthProvider` works for login, **but the resulting access tokens cannot call IAM `authorize`** (gap 11).
  - Ship the UI as `@better-compute/console-kit` React components so both routes reuse it.

---

## 7. Observability and self-check patterns to mirror

- **Spans** (`packages/server/src/observe.ts`):
  - Shape: `IamSpan { kind, name, tenantId?, outcome: 'ok'|'denied'|'error', code?, status?, requestId?, durationMs }`.
  - `denied` means HTTP 401, 403 or 429.
  - `onSpan` must never throw; failures are swallowed.
- **Metrics** (`packages/server/src/metrics.ts`):
  - Series: `better_iam_spans_total{kind,name,outcome,code}`, `better_iam_span_duration_seconds` (histogram by kind), `better_iam_http_requests_total{path,status}`.
  - **No tenant labels.** Caller-controlled names collapse to `(invalid)` or `(unknown)`.
  - `maxSeries` defaults to 2000, after which new series become `(other)`.
  - Optional storage gauges (`gauges: true`): outbox and live sessions.
- **HTTP endpoints** (`packages/server/src/http.ts:457-506`):
  - `GET {basePath}/health`: one primary-key read, reveals only up or down plus latency, 503 on failure.
  - `GET {basePath}/metrics`: bearer token compared as SHA-256 digests with `timingSafeEqual`.
- **Request IDs:** `X-Request-Id` must match `/^[A-Za-z0-9._:-]{1,128}$/` (`http.ts:185-188`). It is echoed on every answer, exposed through CORS, and recorded on `http` spans. The client option `requestId: true | () => string` sets it.
  - Compute should propagate its own request ID into IAM calls so the two sides' spans join.
- **Self-check and doctor:**
  - `iam.selfCheck({ cap })` returns `{ ok, findings: {check, severity: 'error'|'warning'|'info', message, fix, count?}[], storage }` (`packages/server/src/self-check.ts`).
  - `better-iam doctor [--strict]` exits with `DOCTOR_FINDINGS` under `--strict`.
  - The admin "Metrics and health" page renders both.
- **Compute doctor checks worth adding:**
  - IAM reachable.
  - Plugin installed: `actions.list` / `resourceTypes.list` contain the `compute:*` catalog.
  - `sts.jwt` audience includes compute.
  - Root meters exist.
  - Root subtree webhook is active.
  - Usage outbox backlog versus `closePeriod`.
  - Daemon heartbeat staleness and certificate expiry.
  - Clock skew.

---

## 8. Integration contract proposal

Package `@better-compute/iam` has two entry points:

- `./plugin`: installed in the IAM server.
- `./client`: used by the control plane.

It is exposed by the umbrella as `better-compute/iam`.

### 8.1 Catalog (shared constants)

```ts
// packages/iam/src/catalog.ts
import type { ResourceTypeDefinition } from 'better-iam';

export const computeActions = [
  'compute:regions:read', 'compute:regions:use',
  'compute:pools:read', 'compute:pools:manage', 'compute:pools:share',
  'compute:nodes:read', 'compute:nodes:provision', 'compute:nodes:drain',
  'compute:nodes:reboot', 'compute:nodes:ssh', 'compute:nodes:ssh-root',
  'compute:gpus:read', 'compute:gpus:reserve',
  'compute:reservations:read', 'compute:reservations:create', 'compute:reservations:cancel',
  'compute:images:read', 'compute:images:publish',
  'compute:profiles:read', 'compute:profiles:manage', 'compute:profiles:apply',
] as const;
export type ComputeAction = (typeof computeActions)[number];

export const computeResourceTypes = {
  region: {                                   // app-owned: platform catalog, resolved per tenant
    description: 'A compute region (datacenter / provider zone)',
    actions: ['compute:regions:read', 'compute:regions:use'],
    attributes: { provider: 'string', country: 'string', iamRegion: 'string', sovereign: 'boolean' },
  },
  pool: {                                     // managed in the org tenant; homogeneous GPU model
    description: 'A capacity pool allocated to an organization',
    managed: true,
    actions: ['compute:pools:read', 'compute:pools:manage', 'compute:pools:share',
              'compute:gpus:read', 'compute:gpus:reserve', 'compute:nodes:read'],
    attributes: { region: 'string', provisioner: 'string' /* metal|vps|k8s */,
                  capacityClass: 'string' /* dedicated|shared|spot */, gpuModel: 'string',
                  gpuMemoryGb: 'number', gpuCount: 'number', projectId: 'string', archived: 'boolean' },
    relations: ['viewer', 'user', 'operator', 'admin'],
  },
  node: {                                     // app-owned; resolver returns parentType:'pool'
    description: 'A bare-metal server or VPS', parent: 'pool',
    actions: ['compute:nodes:read', 'compute:nodes:provision', 'compute:nodes:drain',
              'compute:nodes:reboot', 'compute:nodes:ssh', 'compute:nodes:ssh-root'],
    attributes: { region: 'string', kind: 'string', gpuModel: 'string', gpuCount: 'number',
                  cpuCores: 'number', memoryGb: 'number', lifecycle: 'string', dedicated: 'boolean' },
    relations: ['operator'],
  },
  gpu: {                                      // declared for policies; never registered
    description: 'One accelerator', parent: 'pool',
    actions: ['compute:gpus:read'],
    attributes: { model: 'string', memoryGb: 'number', region: 'string', migCapable: 'boolean' },
  },
  reservation: {                              // app-owned; resolver supplies request-shaped attrs
    description: 'A GPU / node reservation', parent: 'pool',
    actions: ['compute:reservations:read', 'compute:reservations:create', 'compute:reservations:cancel'],
    attributes: { region: 'string', gpuModel: 'string', gpuCount: 'number', durationHours: 'number',
                  priority: 'string', spot: 'boolean' },
  },
  image: {
    description: 'An OS / runtime image',
    actions: ['compute:images:read', 'compute:images:publish'],
    attributes: { os: 'string', visibility: 'string', verified: 'boolean' },
    relations: ['user', 'publisher'],
  },
  'provisioning-profile': {                   // managed in the org tenant
    description: 'How nodes are provisioned (pxe, cloud-init, redfish, kexec, vps-api)',
    managed: true,
    actions: ['compute:profiles:read', 'compute:profiles:manage', 'compute:profiles:apply'],
    attributes: { provisioner: 'string', method: 'string', imageId: 'string', region: 'string' },
    relations: ['user', 'editor'],
  },
} satisfies Record<string, ResourceTypeDefinition>;
```

Constraints the catalog is designed around:

- Managed `pool` and `provisioning-profile` have no parent, which the managed-parent rule requires.
- App-owned types may declare `parent` for documentation; parent relations come from the resolver's `parentType` / `parentId`.
- Add a `typePrefix` option (`compute-node`, ...) in case a host already declares `node` or `pool`.

### 8.2 Plugin object (IAM side)

```ts
// packages/iam/src/plugin.ts   ->  better-compute/iam/plugin
import type { IamPlugin } from 'better-iam';
import { computeResourceTypes } from './catalog.js';

export interface ComputeIamPluginOptions { typePrefix?: string }

export function computeIamPlugin(options: ComputeIamPluginOptions = {}): IamPlugin {
  return {
    id: 'better-compute',
    // Actions not tied to a type (quota/usage views, fleet admin on the root tenant).
    actions: ['compute:quotas:read', 'compute:usage:read', 'compute:fleet:admin'],
    resourceTypes: prefixTypes(computeResourceTypes, options.typePrefix),
    // v1: no endpoints (handlers run inside the IAM tx and can only target iam/{tenantId}; see gaps 2-3).
    // v1: no resolveContext (receives no tx/tenant; see gap 7).
    // purge: no-op; compute data lives in the compute DB and reacts to tenant deletion via webhook.
  };
}
```

Host wiring:

```ts
betterIam({
  // ...
  plugins: [computeIamPlugin()],
  resolveResource: composeResolvers({ ...computeResolvers(localAuthzProjection) }), // must NOT do network I/O (runs in tx)
  sts: { jwt: { signingKeys, audiences: ['https://compute.example.com'] } },
  webhooks: /* created at runtime, see 8.5 */ undefined,
});
```

### 8.3 PEP client (control-plane side)

```ts
// packages/iam/src/client.ts   ->  better-compute/iam/client
import { createIamClient, type IamClient } from 'better-iam/client';
import type { BetterIam, Decision, SpendCheck } from 'better-iam';

export interface ComputePdp {
  authorize(caller: string, c: { tenantId: string; action: ComputeAction;
    resource: { type: string; id: string } }): Promise<Decision>;
  authorizeMany(caller: string, tenantId: string,
    checks: { action: ComputeAction; resource: { type: string; id: string } }[]): Promise<boolean[]>; // chunks of 50
  listAccessible(caller: string, q: { tenantId: string; action: ComputeAction; type: 'pool' | 'provisioning-profile';
    limit?: number; offset?: number }): Promise<{ ids: string[]; total: number }>;
  spendCheck(caller: string, q: { tenantId: string; meter?: string }): Promise<SpendCheck>;
  whoami(caller: string): Promise<unknown>;          // sts.getCallerIdentity, cached by sha256(token) 30s
}
export function createComputePdp(o: { iamBaseURL: string; basePath?: string;
  requestId: () => string; regionBaseURL?: (tenantId: string) => string }): ComputePdp {
  const iam: IamClient<BetterIam> = createIamClient<BetterIam>({ baseURL: o.iamBaseURL, requestId: o.requestId });
  const as = (caller: string) => ({ headers: { authorization: `Bearer ${caller}` } });
  return {
    authorize: (caller, c) => iam.authorize(c, as(caller)),
    async authorizeMany(caller, tenantId, checks) { /* split into 50s, map results */ },
    async listAccessible(caller, q) { /* iam.listAccessible(q, as(caller)) */ },
    spendCheck: (caller, q) => iam.billing.check(q, as(caller)),
    whoami: (caller) => iam.sts.getCallerIdentity(as(caller)),
  } as ComputePdp;
}
```

**Caller credentials accepted by the compute API:** any Better IAM credential, forwarded unchanged. That is `biam_key_`, `biam_ses_`, `biam_sts_`, or a session JWT whose audience includes the IAM issuer. This is the same model as the inference gateway.

**Reservation flow:**

1. `authorize(compute:gpus:reserve, pool/{id})`
2. `spendCheck({ meter: 'gpu.h100.hours' })`
3. Compute's own quota check.
4. Commit.

### 8.4 Usage reporter

```ts
export interface GpuUsageWindow { tenantId: string; reservationId: string; identityId?: string; teamId?: string;
  gpuModel: string; gpuCount: number; region: string; poolId: string; projectId?: string; from: number; to: number }

export const toUsage = (w: GpuUsageWindow) => ({
  tenantId: w.tenantId,
  meter: `gpu.${w.gpuModel.toLowerCase()}.hours`,            // ^[a-z][a-z0-9_.-]{0,63}$
  quantity: (w.gpuCount * (w.to - w.from)) / 3_600_000,
  identityId: w.identityId, teamId: w.teamId,
  tags: { region: w.region, pool: w.poolId, gpuModel: w.gpuModel, ...(w.projectId ? { project: w.projectId } : {}) },
  occurredAt: w.to,
  idempotencyKey: `cmp:${w.reservationId}:${w.from}`,       // <=200 chars; keep ids out of tags
});
// Durable outbox in the compute DB -> POST {basePath}/billing/recordMany
//   { tenantId: ROOT_TENANT_ID, events: toUsage[] (<=100) } as a root-tenant service account with iam:billing:record.
// Flush before the daily closePeriod; on BILLING_PERIOD_CLOSED fall back to billing.createInvoiceItem (root).
```

### 8.5 Events compute consumes

Create a webhook on the root tenant with `scope: 'subtree'` (root administrator), and verify deliveries with `verifyWebhookSignature` from `better-iam`. Events:

- `iam:tenants:delete`, `iam:tenants:update`
- `iam:identities:delete`, `identity:expire`
- `iam:relationships:*`
- `binding:*`
- `billing:budget-alert`
- `feature:*`

Reactions:

- Revoke SSH certificates and node access.
- Stop or drain reservations when an enforced budget is spent.
- Purge compute data for deleted tenants.

### 8.6 Default roles (TenantConfig v1 fragment)

`GPU user`:

```json
{ "effect": "allow", "actions": ["compute:gpus:reserve", "compute:reservations:*", "compute:pools:read"],
  "resources": ["pool/*", "reservation/*"],
  "conditions": { "ArrayContains": { "resource.relations": "user" } } }
```

- Add a reservation-owner statement: `StringEquals: {'resource.ownerId': '${principal.id}'}` on `reservation/*`.
- Add the spend deny from §1.5.

`Fleet operator`: `compute:nodes:*` on `node/*` where `ArrayContains resource.parentRelations: "operator"`.

`Node break-glass`: `compute:nodes:ssh-root` with `Bool principal.mfa: true`. Bind as **eligible** with `requireApproval`.

---

## 9. Upstream gaps (small better-iam changes)

Root: `C:\Users\Sean Filimon\Desktop\better-iam\`.

1. **A resolver per plugin.**
   - Add `IamPlugin.resolveResource?(ref, { tx }): Promise<ResolvedResource | undefined>` for the types that plugin declares.
   - Dispatch before `options.resolveResource`.
   - Files: `packages\core\src\index.ts:513-527`, `packages\server\src\decisions.ts:390-417`, `packages\server\src\catalog.ts` (record which plugin owns each type).
2. **A trusted decision API for external services (AuthZEN-style).**
   - `POST {basePath}/evaluate { subjectToken | subject, action, resource: { type, id, attributes }, context }`.
   - The call authenticates as the service. The service needs a new `iam:decisions:evaluate` on `iam/decisions/{type}`.
   - Supplied attributes and `request.param.*` keys are accepted only for plugin-owned types that declare them.
   - This removes the resolver-inside-transaction problem and enables "≤8 GPUs".
   - Files: `packages\server\src\operations.ts`, `packages\server\src\http.ts:341-392`, `packages\server\src\catalog.ts:18-169`, `packages\server\src\context-keys.ts`.
3. **Resource-targeted plugin endpoints.**
   - `PluginEndpoint.resource?(input) => { type, id }`, authorized on that resource instead of `iam/{tenantId}`.
   - `PluginEndpointContext.authorize(action, resource)` and `audit(metadata)`.
   - Files: `packages\core\src\index.ts:485-499`, `packages\server\src\operations.ts:326-358`.
4. **Trusted registration of managed resources across the subtree.**
   - `resources.sync` / `registerMany` for a root-tenant service account holding a new `iam:resources:sync`, the same subtree rule as billing `recordMany`.
   - Alternatively `ResourceTypeDefinition.writers: 'plugin'` plus in-process `iam.resources.sync()`, so users cannot forge authorization attributes.
   - Files: `packages\server\src\api\resources.ts`, `packages\core\src\index.ts:450-465`.
5. **Relationship scale and depth.**
   - Load tuples by subject (`subjectType: 'identity', subjectId`, plus each group ID) instead of the whole tenant.
   - Add `resource.ancestorRelations` for more than one level.
   - Files: `packages\server\src\decisions.ts:622-653`, index on `subjectId` in `packages\core\src\sql.ts`.
6. **`tenant.region` context key.** Also `tenant.id` and `tenant.type` for residency policies.
   - Files: `packages\server\src\context-keys.ts:76-79`, `packages\server\src\decisions.ts:556-563`, `packages\server\src\policy-lint.ts`.
7. **`resolveContext` gets `{ tx, tenant }`.**
   - Files: `packages\core\src\index.ts:523`, `packages\server\src\decisions.ts:446-448`.
8. **Plugin-declared identity attributes and tenant limits.**
   - `IamPlugin.identityAttributes`, and `IamPlugin.limits`, which makes `TenantLimits` open with namespaced keys such as `compute.gpus`.
   - Files: `packages\server\src\catalog.ts:326-333`, `packages\server\src\tenant-policy.ts:130-151`, `packages\server\src\context.ts:178-187,406-415`, `packages\core\src\index.ts:192-204`.
9. **Plugin kinds in configuration as code.**
   - `IamPlugin.config?: { kind, read, plan, apply, export }`.
   - Files: `packages\server\src\sync.ts:73-100,213-244,305,1385-2027`.
10. **Console extension points.**
    - Let `orgAreas` and `adminAreas` accept extra areas (`apps\console\src\lib\navigation.ts:38,205`).
    - Add `transport` / `baseURL` to `ApiForm` (`apps\console\src\components\api-form.tsx:110`).
    - Chunk `can()` at 50 (`apps\console\src\lib\org.ts:23-53`). This fixes the silent all-false result past 24 workspaces.
11. **Exchange an OAuth access token for a session JWT for first-party resource servers.**
    - For example `sts.exchangeAccessToken`, so a separately hosted compute console using OIDC can still call `authorize`.
    - Files: `packages\oauth\src`, `packages\server\src\api\sts.ts`.
12. **Batch and list ergonomics.**
    - Make the 50-check limit configurable (`operations.ts:253`).
    - Add `parentId` and attribute filters plus a keyset cursor to `listAccessible` (`operations.ts:286-320`, `options.ts:118-124`).
13. **Billing.**
    - `enforceBudgets` on `recordMany`.
    - Glob patterns for budget `meters` (such as `gpu.*`).
    - A configurable 100-event HTTP cap.
    - A warning in `selfCheck` about tag cardinality.
    - Files: `packages\server\src\api\billing.ts:818,1374-1404`, `packages\server\src\billing-service.ts:1012,1129`.
14. **Inference.**
    - Multiple base URLs or health checks, and an allowed private CA / mTLS for `openai-compatible` self-hosted providers.
    - Files: `packages\server\src\inference.ts:27-37,376-400`, `packages\server\src\inference-gateway.ts:46-59`.
15. **Plugin observability.**
    - `IamPlugin.selfCheck?(): Promise<SelfCheckFinding[]>` and plugin counters in `iam.metrics`.
    - Files: `packages\server\src\self-check.ts`, `packages\server\src\metrics.ts`.
16. **Audit append for external services.**
    - `audit.record` with a new `iam:audit:write` permission and an action namespace owned by the plugin, so compute actions land in the tenant's hash chain and on webhooks.
    - Files: `packages\server\src\events.ts:72-150`, `packages\server\src\api\webhooks.ts` (the `audit` group).

---

**Main files (absolute paths):**

- `C:\Users\Sean Filimon\Desktop\better-iam\packages\core\src\index.ts`
- `C:\Users\Sean Filimon\Desktop\better-iam\packages\core\src\policy.ts`
- `C:\Users\Sean Filimon\Desktop\better-iam\packages\server\src\plugins.ts`
- `C:\Users\Sean Filimon\Desktop\better-iam\packages\server\src\catalog.ts`
- `C:\Users\Sean Filimon\Desktop\better-iam\packages\server\src\decisions.ts`
- `C:\Users\Sean Filimon\Desktop\better-iam\packages\server\src\operations.ts`
- `C:\Users\Sean Filimon\Desktop\better-iam\packages\server\src\options.ts`
- `C:\Users\Sean Filimon\Desktop\better-iam\packages\server\src\context.ts`
- `C:\Users\Sean Filimon\Desktop\better-iam\packages\server\src\context-keys.ts`
- `C:\Users\Sean Filimon\Desktop\better-iam\packages\server\src\http.ts`
- `C:\Users\Sean Filimon\Desktop\better-iam\packages\server\src\api\resources.ts`
- `C:\Users\Sean Filimon\Desktop\better-iam\packages\server\src\api\relationships.ts`
- `C:\Users\Sean Filimon\Desktop\better-iam\packages\server\src\billing.ts`
- `C:\Users\Sean Filimon\Desktop\better-iam\packages\server\src\billing-service.ts`
- `C:\Users\Sean Filimon\Desktop\better-iam\packages\server\src\api\billing.ts`
- `C:\Users\Sean Filimon\Desktop\better-iam\packages\server\src\inference.ts`
- `C:\Users\Sean Filimon\Desktop\better-iam\packages\server\src\inference-gateway.ts`
- `C:\Users\Sean Filimon\Desktop\better-iam\packages\server\src\hosts.ts`
- `C:\Users\Sean Filimon\Desktop\better-iam\packages\server\src\sync.ts`
- `C:\Users\Sean Filimon\Desktop\better-iam\packages\server\src\tenant-policy.ts`
- `C:\Users\Sean Filimon\Desktop\better-iam\packages\server\src\teams.ts`
- `C:\Users\Sean Filimon\Desktop\better-iam\packages\server\src\observe.ts`
- `C:\Users\Sean Filimon\Desktop\better-iam\packages\server\src\metrics.ts`
- `C:\Users\Sean Filimon\Desktop\better-iam\packages\server\src\self-check.ts`
- `C:\Users\Sean Filimon\Desktop\better-iam\packages\projects\src\index.ts`
- `C:\Users\Sean Filimon\Desktop\better-iam\packages\react\src\index.tsx`
- `C:\Users\Sean Filimon\Desktop\better-iam\packages\client\src\index.ts`
- `C:\Users\Sean Filimon\Desktop\better-iam\apps\console\better-iam.config.mjs`
- `C:\Users\Sean Filimon\Desktop\better-iam\apps\console\src\lib\iam.ts`
- `C:\Users\Sean Filimon\Desktop\better-iam\apps\console\src\lib\navigation.ts`
- `C:\Users\Sean Filimon\Desktop\better-iam\apps\console\src\lib\org.ts`
- `C:\Users\Sean Filimon\Desktop\better-iam\apps\console\src\components\api-form.tsx`
- `C:\Users\Sean Filimon\Desktop\better-iam\docs\extensions.md`
- `C:\Users\Sean Filimon\Desktop\better-iam\docs\billing.md`
- `C:\Users\Sean Filimon\Desktop\better-iam\docs\inference.md`
- `C:\Users\Sean Filimon\Desktop\better-iam\docs\hosts-and-regions.md`

Note: several MCP connectors (github, datadog, linear, notion, slack and others) need authorization before they can be used. This research did not need them.