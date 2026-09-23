# How better-iam covers identity and authorization for better-compute

I read the docs and checked them against the source. The source is at `C:\Users\Sean Filimon\Desktop\better-iam\packages\`. Short file names in the text refer to the Source map in section 8.

## 0. Constraints that shape the design

1. **An organization can't act in another organization's space.** Outside the root admin override, a session only gets decisions in its own tenant. Any other tenant returns `TENANT_MISMATCH` (`decisions.ts:424`), and a parent tenant's members get nothing in child tenants. The root override needs a root-tenant person with `rootAdmin` and an MFA user session. A service account never gets it (`context.ts:232`).
   - So a root-tenant control-plane service account cannot call `resources.register` into an org tenant.
   - `billing.recordMany` is the only built-in API that writes into child tenants, and it has an explicit subtree check (`api/billing.ts:1374`).
2. **IAM only answers "may *I* do X".** `authorize`, `authorizeMany`, `listAccessible` and `getCallerIdentity` decide for the credential presented. A remote service has to forward the caller's bearer to IAM. There is no call like `authorize(asIdentity=X)`; `policies.simulate` exists but is admin-only and advisory.
3. **Resource lookup for authorization.**
   - Managed types need registration first, or `authorize` throws `NOT_FOUND` "Resource is not registered".
   - Application-owned types need the top-level `options.resolveResource`, or you get `RESOURCE_RESOLVER_REQUIRED` (`decisions.ts:372-417`). Plugins can't supply a resolver.
   - `listAccessible` works only for managed types. It loads every registration of that type in the tenant, so it is O(n) per call.
4. **Setup steps need a person.** `requireRecent` accepts only `user` or `api-key` sessions authenticated within 5 minutes (`auth/src/service/base.ts:1358`). An API key's `authenticatedAt` is its creation time. That puts these out of reach of automation: `credentials.create`, `trust.create`, `oidcProviders.create/update`, `webhooks.create`, every `*.revokeSessions`, `tenants.create`, `identities.setStatus`, and `delegations.grant/approve`. The control plane can't mint per-node API keys or subscribe webhooks by itself.
5. **Allowed `authorize` decisions write no audit event.** Only denials and root overrides are chained. `iam.billing.record` has no audit either. Both scale.
   - Web-identity exchanges, API operations and plugin endpoints each append to the tenant's hash chain, and each append updates that tenant's single `auditChains` head row. That is a serialization point, so don't put per-node IAM traffic on it.

## 1. Authorizing a request

| Surface | Import / route | Signature (verified) | Use in better-compute |
|---|---|---|---|
| `iam.require` | `betterIam()` instance (`index.ts:650` → `operations.requireAccess`) | `({ token?\|headers?, tenantId, action, resource:{type,id} }) → Promise<void>`, throws `IamError('ACCESS_DENIED',…,403)` | **Embedded**: the API server and gateway call it right before any mutation. |
| `iam.authorize` | same; HTTP `POST {basePath}/authorize` | → `{ allowed, reason, matched: [] }` (reason becomes `ACCESS_DENIED` on deny). Records denials and root overrides; allowed decisions feed `accessUsage`. | Both modes. Remote: forward the caller's bearer. |
| `iam.authorizeMany` | HTTP `POST /authorizeMany` | `({cred, tenantId, checks:[{action,resource}] 1..50}) → { results:[{action,resource,allowed,reason}] }`, one transaction | Console button state and list filtering of application-owned types. Advisory only. |
| `iam.listAccessible` | HTTP `POST /listAccessible` | `({cred, tenantId, action, type, limit≤1000 (100), offset}) → { resources: ResourceRecord[], total }` | Only for managed types, such as registered pools and nodes. |
| `iam.authenticate` | instance only | `(CredentialInput) → { identity, session }` | Embedded authentication. `session.kind` can be `user`, `api-key`, `role`, `session-token` or `delegated` (with `agentId` and `delegationId`). |
| `createIamClient<BetterIam>` | `better-iam/client` (`client/src/index.ts:189`) | `({ baseURL, basePath='/api/iam', token?, headers?, fetch?, retryRateLimited?, requestId?, onUnauthenticated? })`. Every method takes `(input, { headers, signal })`; per-call `headers.authorization` wins **when the client has no `token` set**. Top-level `authorize`, `authorizeMany`, `listAccessible`; `$request('plugins/…')`. | **Remote.** Keep one bearer-less client and pass `{ headers:{ authorization } }` per call to forward the caller. Keep a second client with the control-plane token for system calls. |
| `sts.getCallerIdentity` | `client.sts.getCallerIdentity({headers})`, HTTP `POST /sts/getCallerIdentity` | → `CallerIdentity { identityId, identityTenantId, identityKind, tenantId, sessionId, sessionKind, format, mfa, authenticatedAt, issuedAt, expiresAt, method?, roleId?, trustId?, sourceTenantId?, sessionName?, sourceIdentity?, sessionTags?, audience?, webIdentity?, impersonatorId?, agentId?, delegationId? }`. No permission needed, no audit. | **Remote authentication plus online revocation check.** Also the periodic recheck for long-lived gateway streams. |
| `createSessionTokenVerifier` | `better-iam/session-tokens` (imports only `jose`; edge-safe) | `({ issuer, audience, jwks: JWKS \| url, algorithms?, kinds?, clockToleranceSeconds=5, maxLifetimeSeconds=43200, cacheMaxAgeSeconds=600, cooldownSeconds=30, timeoutMs=5000 }) → { verify(t), verifyRequest({headers}) }`. Claims: `iss aud sub tid sid jti iat nbf exp auth_time kind('role'\|'session-token') mfa role? trust? src_tid? session_name? source_identity? idp? idp_sub?`. Error: `SessionTokenError{ code:'INVALID_SESSION_TOKEN', status:401, reason }`. | Offline fast-path **authentication** (not authorization) for API-server reads and the gateway. The JWT must be issued with `audience:[iamIssuer, computeAud]` so IAM still accepts it for `authorize`; IAM refuses JWTs whose audience lacks its issuer. `computeAud` must be in `sts.jwt.audiences`, and the issuer needs `iam:assertions:create` on `iam/{aud}`. Revocation shows up only at `exp`, so use 5–15 minute tokens. Delegated (`dlg`) sessions are never JWTs. JWKS is at `GET {basePath}/.well-known/jwks.json` (max-age 300). Embedded: `iam.sessionTokens.verify(token,{audience})` also checks that the session is still live. |
| Assertions | `api.assertions.issue(cred,{tenantId, audience, ttlSeconds 10..3600 (300), claims? ≤4KiB})` → `{token, expiresAt, claims}`; `verifyAssertion(token,{ key: iam.assertionKey()\|iam.assertionKeys(), audience, issuer?, toleranceSeconds=30 })` from `better-iam` (node:crypto) | HS256. The key is `sha256("better-iam:assertion:"+secret)`. Claims `{iss(origin), sub, aud, iat, exp, jti, tid, kind, mfa, method?, impersonatorId?, name, email?, roles[], groups[], ext?}`. Authorized as `iam:assertions:create` on `iam/{aud}`. Refused for delegated sessions and scoped session tokens. Cannot be revoked. | Only for **embedded or same-trust-domain** internal hops that need role and group IDs without a database hit. It shares a secret derived from IAM's deployment secret, so don't use it across trust domains; use session JWTs there. |
| OAuth resource server | `better-iam/oauth`: `createAccessTokenVerifier({ issuer, audience, jwks?, jwksUri?, clockTolerance=30, dpopMaxAge=300, algorithms? })` → `verifyRequest({authorization,dpop,method,url},{scopes})` → `{ subject?, clientId, tenantId?, identityId?, scopes, audience, expiresAt, actor?, boundKey? }`. `createResourceGuard({ resource, authorizationServers, scopes?, requiredScopes?, requireDpop?, … })` → `check(req,{scopes}) → {response?, token?}`, `.verifier`, serves RFC 9728 `/.well-known/oauth-protected-resource{path}`. | On the IAM side: `createOAuthProvider({…, resourceServers:{ 'https://compute…': { scopes, accessTokenTtl } }, registration? })`, `registerClient(cred,{…grantTypes:['client_credentials'], serviceAccountId, resources, requireDpop})`. Device flow is supported. | Third-party apps, MCP hosts, and optionally CLI device login. **IAM does not accept `at+jwt` tokens as credentials.** OAuth callers are decided by scopes only, plus compute's own ownership checks. |

**When to embed and when to go remote.** Build a port interface in `@better-compute/iam` with two adapters.

- **Embedded:** `better-compute` constructs or receives `betterIam()`.
  - Use `iam.require`, `iam.authenticate`, `iam.events.subscribe`, `iam.billing.record` (no credential needed) and `iam.sessionTokens.verify`.
  - Contribute the catalog through an `IamPlugin`.
  - Put `resolveResource` in the host options.
  - A worker must run `iam.events.dispatch()`.
- **Remote:** IAM runs as a separate deployment.
  - Use the bearer-less `createIamClient` with the caller's header forwarded for `authorize*`, `listAccessible` and `sts.getCallerIdentity`.
  - Use the control-plane client for system calls.
  - Verify session JWTs offline for authentication.
  - Receive events through a root subtree webhook.
  - IAM's operator must configure the compute catalog and `resolveResource` in IAM's options.
  - Multi-region IAM with `regions.locate` (separate databases): call the tenant's home region.

## 2. Machine identity for daemons and nodes

**Service accounts and API keys** (`api/service-accounts.ts`):
- `serviceAccounts.create(cred,{tenantId,name,description?,expiresAt?})` needs `iam:identities:create` and is limited by `limits.serviceAccounts`.
- `credentials.create(cred,{tenantId, identityId, expiresInSeconds 60..31536000 (90d), scopes? | policy?, name≤128, description≤512})` → `{token:'biam_key_…', credentialId, expiresAt, name}`. It **requires recent authentication** and is bounded by the issuer's grant authority. `scopes` compiles to an allow on `*`.
- Also available: `credentials.list({tenantId, identityId?, unusedForMs?})` (reports `lastUsedAt` and `scopes`), `update`, `rotate` (keeps the label, resets usage), and `revoke` (API keys only).
- Token format: `biam_<ses|key|rol|sts|dlg>_` + 43 characters + a 6-character CRC32, 58 characters total. The scan pattern is `credentialTokenScanPattern` in `auth/src/crypto.ts:30`. `dlg` is in the source, but the docs still list only 4 types.

**STS** (`api/sts.ts`, `api/roles.ts`):
- `sts.getSessionToken(cred,{durationSeconds (3600 default; ≤ sts.maxSessionTokenSeconds 43200), policy?, sessionName?, mfaCode?, format?:'jwt', audience?})` needs `iam:session-tokens:create` and is capped at 50 per identity.
- `roles.assume(cred,{tenantId, trustId, externalId?, durationSeconds (900 default), policy?, sessionName?, sourceIdentity?, tags?, format?, audience?})` → `RoleCredential`.
- `sts.getCallerIdentity(cred)`.
- Temporary credentials never pass `requireRecent`, never act as owner or root, and can't chain.

**Can the control plane be an OIDC issuer for node identity?** Yes. Setup (`sts.webIdentity.enabled:true`, `api/oidc-providers.ts`, `api/trust.ts`, `web-identity*.ts`):
- `oidcProviders.create({tenantId:root, name, issuer, audiences 1..10, jwks? | jwksUri?, algorithms? (default RS256, ES256; EdDSA allowed), maxTokenLifetimeSeconds 60..86400 (3600), clockToleranceSeconds 0..120 (30), replayProtection 'single-use'|'off'})`.
- `trust.create({tenantId, kind:'web-identity', providerId, serviceAccountId, roleId, conditions, tagClaims?, sourceIdentityClaim?, maxSessionSeconds?, ceiling?, passSourceAttributes?})` needs `iam:trust:create`, is tenant-managed rather than root-only, and needs recent authentication.
- The daemon calls `POST {basePath}/sts/assumeRoleWithWebIdentity` with `{tenantId, trustId, webIdentityToken ≤8192, sessionName (required), durationSeconds?, policy?, format?, audience?}` and the header `X-Better-IAM: 1`, no credential. It gets back a `biam_rol_` credential or a JWT, plus `webIdentity`.

What the node token must contain:
- `iss`, `sub`, `aud`, `exp` and `iat`.
- `typ` absent, `JWT` or `application/jwt`. `biam-session+jwt` and `at+jwt` are refused.
- A lifetime of at most `maxTokenLifetimeSeconds`.
- A unique `jti` per exchange when replay protection is `single-use`.
- The issuer can't be IAM's own issuer.

Claims become `token.<claim>` condition keys. Nested objects flatten to depth 3, strings up to 1024 characters, arrays up to 64 items, 128 keys at most.

Conditions allow at most 20 entries and must pin `token.sub` with `StringEquals` or `StringLike`, not starting with `*` or `?`. `node:*` is valid. Otherwise you get `WEAK_TRUST_CONDITIONS`.

- `tagClaims` (up to 10) map to `principal.sessionTags.<k>`. Example: `{nodeId:'token.node_id', pool:'token.pool', region:'token.region'}`.
- `sourceIdentityClaim` maps to `principal.sourceIdentity`, which must match `/^[\w+=,.@-]{2,64}$/`.
- Policies can then scope a node to itself with `resources:['compute-node/${principal.sessionTags.nodeId}']`.
- Each trust maps to **one** service account, so every node shares it. Per-node attribution comes from `sessionName` and `sourceIdentity` in the audit `sessionContext`.

Does the network guard block a private control-plane issuer? `safe-fetch.ts:105-153` enforces https on port 443 only, no redirects, and every resolved address public (RFC1918, CGNAT, loopback, link-local, ULA and more are refused).
- **Discovery and `jwksUri` are blocked** for a private issuer.
- **Static `jwks`** is never fetched, and the issuer string only has to be `https:` (`web-identity.ts:208`), so a private issuer works. The catch: *any* change to static `jwks`, even adding a key, moves the provider watermark and kills every live session through it. Each key rotation forces the whole fleet to re-exchange.
- Other options:
  - Publish the discovery document and JWKS on a public https:443 host. The keys are public anyway; this is the S3-style approach EKS uses.
  - Set the deployment-wide `sts.webIdentity.fetchJson` transport, which skips the guard and leaves safety to you.
  - `allowPrivateNetworks` is for development only.
- If `allowedIssuers` is set, the issuer must be on it.

Limits per trust:
- `maxExchangesPerWindow` defaults to 600 per 15-minute window (range 1..100000).
- `maxSessionsPerTrust` defaults to 1000 (range 1..100000).
- Sessions default to 900 s, up to the trust's max, capped by `sts.maxRoleSessionSeconds` (default 3600, max 43200).
- Every exchange writes a rate-limit row, a replay row, a session row and a `role:assumed-with-web-identity` audit event in the tenant's chain.

**Recommendation:**
- Don't give daemons IAM credentials. Authenticate daemons to the control plane natively: a join token, then mTLS certificates or JWTs from a control-plane CA.
- With 5,000 nodes on 15-minute sessions you'd need to raise both limits past about 7.5k exchanges per window and about 10k live sessions, and root's audit chain would serialize on every exchange.
- Use web identity for **workload identity** instead: a sandbox or instance gets IAM credentials for its tenant, the way EKS IRSA works. Put the tenant in the `sub` prefix, e.g. `sub = "t:<tenantId>:reservation:<id>"`. The tenant's own admins then create the trust in *their* tenant and pin `token.sub` with `StringLike "t:<theirId>:*"`, which also pins the tenant.

**Revocation and expiry:**
- Watermark calls: `roles.revokeSessions({tenantId,roleId,before?})`, `trust.revokeSessions({tenantId,trustId,before?})` and `oidcProviders.revokeSessions({tenantId,providerId,before?})`. Each needs recent authentication and emits `role:sessions-revoked`.
- Also `identities.revokeSessions({…, keepApiKeys?})` and `tenants.revokeSessions`.
- A policy watermark works too: deny with `DateBefore principal.tokenIssueTime`.
- There is **no per-subject revocation** for web-identity sessions. The workaround is a deny on `principal.sessionTags.nodeId` plus `tokenIssueTime`, then stop issuing tokens to that node.
- `Identity.expiresAt` (on service accounts and contractors) refuses credentials immediately. The purge worker then emits `identity:expire`, and `sendExpiryReminders` emits `identity:expiry-reminder`.

## 3. AI agents

These matter because agents will drive the compute API (see `docs/agents.md`, `api/agents.ts`, `api/delegations.ts`).

**Agent accounts:**
- `agents.create(cred,{tenantId,name,purpose,model,provider,protocols,sponsorId,boundary,delegable?,maxDelegatedSessionSeconds?,tokenAudiences?})` needs `iam:agents:create` and is limited by `limits.agents`.
- Keys work as for service accounts, via `credentials.create({identityId:agent.id, scopes:['compute:reservations:create',…]})`.
- `agents.standing` returns `ok`, `suspended`, `expired`, `deleted`, `sponsor-missing` or `sponsor-inactive`; anything but `ok` makes all of the agent's credentials fail.
- Kill switches: `agents.suspend`, `agents.suspendAll({provider?,model?,sponsorId?})` (no recent authentication needed), and `resume`.
- Policy keys: `principal.kind='agent'`, `principal.agentId`, `principal.agentSponsorId`, `principal.agentModel`, `principal.agentProvider`, `principal.delegated`, `principal.delegationId`, `principal.delegationChain`.

**Delegation** (the agent acts for a person):
- `delegations.grant(personSession,{tenantId,agentId,scopes|policy,confirm?,expiresInSeconds,maxSessionSeconds?,handoff?})`, or `request` (with the agent's key) followed by `approve`.
- `delegations.assume(agentKey,{tenantId,delegationId,durationSeconds,sessionName})` returns a `biam_dlg_` token. `iam.authorize` with it decides as the person, bounded by the delegation scope, the agent's boundary and the key's scopes.
- For human-in-the-loop GPU reservations, set `confirm:['compute:reservations:create']`. The internal deny reason is `CONFIRMATION_REQUIRED` (callers see `ACCESS_DENIED`).
  - A REST API has to call `delegations.requestConfirmation(delegatedCred,{tenantId,action,resource,reason,validSeconds})` itself, return the `confirmationId`, and let the agent poll `getConfirmation` and retry.
  - The MCP and A2A gates do this automatically.
- **`spend` caps only count inference calls.** Control GPU cost with billing budgets instead: an enforced budget plus a deny on `principal.spendExceeded`, or `iam.billing.check`.

**MCP** (`better-iam/mcp`, `mcp/src/index.ts`):
- `createMcpGate({ iam, tenantId: string|(c)=>string|undefined, tools:{ reserve_gpus:{ action, resource:(args)=>({type,id}), listAs?, scopes? }, …}, unlisted:'deny', toolResourceType?, oauth?: guard.verifier, confirmations?, metadata:{resource, authorizationServers} })`, used as `gate(req,(fwd,caller)=>…)`.
- `createMcpAuthorizer` provides `authenticate`, `canCall` and `visibleTools`.
- `McpIam` needs `authenticate()`, which the typed client lacks. A remote setup needs an adapter: `authenticate` via `sts.getCallerIdentity` plus per-call header forwarding. See gap U1.
- `tenantId`: org-owned reservations can be decided in the caller's own tenant. Capacity and quota must still be enforced by compute, since an org can grant itself any `compute:*` permission.

**A2A** (`better-iam/a2a`):
- Gate and authorizer: `createA2aGate({iam, tenantId, card, message, skills, taskAdminAction, tasks?, oauth?})`, `createA2aAuthorizer`.
- Hand-offs: `withHandoff` and `handoffOf`.
- Delegation tokens (`delegations.issueToken({audience, scopes?, lifetimeSeconds})`, which needs the `a2a` option) are verified outside IAM with `verifyDelegationToken(bearer,{audience, trustedIssuers, tenantId?, replay?})` → `{personId, agentId, chain, scopes, delegationId}`. The live check is `iam.a2a.verifyDelegationToken(t,{audience, live:true})`.
- Delegation tokens aren't IAM bearers, so compute can only authorize them by scopes.

## 4. Tenancy

- **Tree:** the default hierarchy is `root→organization→project` with `maxDepth` 8 (`options.ts:302`). `tenants.create({parentId,type,name,ownerEmail,slug?,boundary?,region?})` needs recent authentication and an email transport.
- **Parents don't reach children.** Suspension cascades down to descendant sessions, but access doesn't. Cross-tenant access means identity trusts (`trust.create` with `kind:'identity'`, **root-only**) followed by `roles.assume`.
- **Limits:** `TenantLimits` has fixed keys (identities, serviceAccounts, agents, groups, roles, policies, resources, webhooks). There are no custom keys, so GPU and node quotas belong in better-compute. `limits.resources` caps registrations.
- **Projects plugin:** `@better-iam/projects` stores records inside a tenant. Its endpoints authorize on `iam/{tenantId}`, which is coarse.

**Proposed mapping:**
- **Root tenant (platform):**
  - Physical inventory as **managed** types, registered by the control-plane service account: `compute-region`, `compute-pool` (parent `compute-region`), `compute-node` (parent `compute-pool`; attributes `gpuModel`, `gpuCount`, `kind` (`metal`/`vps`), `region`, `state`), and `compute-profile`.
  - Fleet roles, with privileged console access as eligible just-in-time bindings: `bindings.create({eligible:true, requireMfa, requireJustification})` and `bindings.activate`.
  - The control-plane service account.
  - Platform billing meters (`gpu-hours`, `node-hours`, `vps-hours`).
  - A root subtree webhook.
- **Organization tenant:**
  - Customer objects: `compute-reservation` or lease (attributes pool, region, gpuModel, gpuCount, projectId), `compute-instance`/`compute-sandbox` (parent reservation), and `compute-project`.
  - **Make these application-owned types resolved by `resolveResource`** reading compute's database. That avoids cross-tenant registration and lets a platform pool be evaluated *as offered to that org*: authorize `compute:reservations:create` on `compute-pool/{id}` in the org tenant, with the resolver returning `{tenantId: org, attributes}` only when the pool is offered.
  - Use `relationships.create` for sharing, and `authorizeMany` for lists.
- **Projects:** model them as resources in the org tenant by default. Use child `project` tenants only when you need billing-account isolation, since users would need identities there.
- **Also useful:**
  - `iam.billing.record` or `billing.recordMany` with a per-event `tenantId` in the subtree, `tags`, `idempotencyKey` and `enforceBudgets`.
  - `iam.features.isEnabled(tenantId,'compute.baremetal')`.
  - `tenants.get().region`, which is IAM's sign-in home region, can default placement.

## 5. Events and audit

**Consuming events:**
- **In-process:** `iam.events.subscribe(patterns, handler) → unsubscribe`. Delivery is at-least-once, so be idempotent by `event.id`, and something must call `iam.events.dispatch()`. Other options are `options.events.onEvent` and plugin `afterAudit`.
- **Webhooks:** `webhooks.create({tenantId, url(https), events≤50, outcomes?, resources?, scope:'subtree'(root only), description?})` returns the secret once. Deliveries carry the `X-Better-IAM-*` headers; check them with `verifyWebhookSignature({secret,timestamp,body,signature})` (5-minute tolerance) and dedupe on `X-Better-IAM-Delivery`. The body is `WebhookEvent {id,type,tenantId,actorId,resourceId,outcome,metadata?,sessionContext?,sequence?,hash?}`. Also available: `redeliver` and `listDeliveries`.
- **Shared Signals** (`oauth/src/ssf.ts`):
  - `createSharedSignalsTransmitter` streams are per exact tenant, with no subtree option.
  - They carry only 5 user-level event types, e.g. `identity:offboard`/`expire` → `account-disabled` and `*:revoke-sessions` → `session-revoked`.
  - Use them for orgs' own receivers, not for the compute platform.

**Events to subscribe to, and what compute should do:**

| Events | Compute action |
|---|---|
| `identity:offboard` (metadata `successorId`), `identity:expire`, `identity:delete`, `iam:identities:update` (status isn't in the payload, so re-read) | End consoles and exec, revoke compute-issued tickets, then reassign or tear down reservations |
| `auth:session:revoke*` (resourceId is the identity; the session id is **not** recorded), `identity:revoke-sessions`, `tenant:revoke-sessions` | Recheck that identity's streams with `getCallerIdentity` |
| `agent:suspend`, `agent:suspend-all`, `delegation:revoke` | Halt that agent's in-flight provisioning |
| `binding:deactivate` | Close privileged node shells |
| `iam:tenants:update` / `iam:tenants:delete` | Suspend or schedule teardown |
| `role:sessions-revoked` | Workload federation, if used |
| `billing:budget-alert` | Budget signal |

**Writing events:** there is no public append-and-fan-out API.
- `appendAuditEvent` is exported from `better-iam` but skips webhooks and subscribers.
- Plugin endpoints audit only `action` on `iam/{tenantId}`, with no metadata.
- `authorize` denials are chained automatically.
- Keep compute's own audit log, keyed by IAM `sessionId`, `agentId` and `delegationId`.

## 6. What already exists for compute (grep of docs and source)

There is no compute, GPU, sandbox, fleet, daemon or VPS concept anywhere.
- `cloud-compute` appears only as a billing meter example (`tests/billing.test.ts:606`, the console placeholder `apps/console/src/app/cloud/[org]/billing/page.tsx:822`).
- "capacity" appears only as "capacity planning" for `instrumentStore`.
- "workload" appears only in web-identity docs (CI and Kubernetes).
- `machineIdentity()` (service or agent) is in `agents.ts:148`.
- **`docs/hosts-and-regions.md` covers organization sign-in addresses, not compute hosts.**
  - `hosts.patterns` (`{tenant}.signin…`), custom hostnames verified by TXT record, and `iam.hosts.resolve`, `signInUrl` and `allowed` (an on-demand TLS check).
  - `regions` with `WRONG_REGION` (421) on sign-in entry points only, a tenant's home region inherited from its parent, and root-only `tenants.setRegion`.
  - Use different vocabulary in compute (`compute-region`, `node`). The `hosts.allowed` pattern is reusable for sandbox preview domains.

## 7. Integration contract proposal

| Component | Inbound credential | better-iam calls | Credential used for IAM |
|---|---|---|---|
| **API server** | IAM bearer (`biam_ses/key/rol/sts/dlg`, session JWT) or the `__Host-better-iam.session` cookie (console same-site, in IAM `trustedOrigins`); OAuth `at+jwt` for third parties | Authentication: `iam.authenticate` (embedded) or `sts.getCallerIdentity` (remote); optional offline `createSessionTokenVerifier` for reads. Authorization: `require`/`authorize` per mutation, `authorizeMany`/`listAccessible` for lists. `delegations.get`/`requestConfirmation` on agent denials. `createResourceGuard`/`createAccessTokenVerifier` for OAuth. `iam.features` | Caller's credential forwarded, never persisted |
| **Control plane / reconcilers** | internal | `resources.registerMany`/`update`/`delete` (root inventory); `iam.billing.record`, or `billing.recordMany` with subtree `tenantId`; `billing.check`; `identities.get`, `agents.standing`, `tenants.get` on events; event intake (in-process `subscribe` or root subtree webhook). Authorization happens at admission; async work runs as the service account and never stores user tokens | Root-tenant service account `compute-control-plane` API key (`scopes:['iam:resources:*','iam:billing:record','iam:billing:read','iam:identities:read','iam:agents:read','iam:tenants:read']`), rolled into hourly `sts.getSessionToken` tokens |
| **Gateway** (daemon connections) | Daemons: compute-native mTLS or node JWT (not IAM). Users: IAM bearer for exec, console and port-forward | `authorize(compute:nodes:exec \| compute:instances:exec)` at open, with MFA or `principal.mfaTime` conditions; `sts.getCallerIdentity` every ~60 s per stream (or `iam.sessionTokens.verify`); kill on the events above | Caller's credential held in memory for the stream's lifetime |
| **Node daemon** | control plane only | None by default. Optionally relays `POST /sts/assumeRoleWithWebIdentity` for **workload** credentials | Control-plane-issued OIDC JWT |
| **CLI** | — | Reuse `@better-iam/cli`: `createProfileStore(process.env)`, `credentialsPath`, `BETTER_IAM_TOKEN`, or extend it with `createCli({commands:[defineCommand(…)]})`; `sts.getCallerIdentity` for whoami; `sts.getSessionToken({format:'jwt',audience:[iamIss,computeAud]})` for scripts; OAuth device flow optional | User session from the profile; CI uses an API key or GitHub OIDC web identity |
| **Console** | cookie | `@better-iam/react`/`next` session hooks; `authorizeMany` and `listAccessible` for UI state; `useDelegations`/`useConfirmations` for agent reservation approvals; `billing.spend`/`mySpend` | Cookie session |
| **SDK** | — | Pass-through `token: string \| ()=>Promise<string>` like `ClientOptions.token`; re-export `createSessionTokenVerifier` helpers | Caller-supplied IAM bearer |
| **MCP / A2A surface** | IAM bearer or OAuth | `createMcpGate` / `createA2aGate` (tool → `compute:*` action and resource); `verifyDelegationToken` for out-of-domain agents | Caller's credential |

Catalog to contribute, through an `IamPlugin` or IAM's `permissions.resourceTypes`:
- Type names must match `/^[a-z][a-z0-9-]{0,63}$/`.
- Actions: `compute:pools:read|manage`, `compute:nodes:read|register|cordon|drain|provision|exec|console|delete`, `compute:reservations:create|read|extend|release`, `compute:instances:create|read|exec|delete`, `compute:profiles:read|manage`.

## 8. Upstream gaps

Only the ones that genuinely block or complicate the integration:

1. **U1 – A remote authorizer with per-call credentials.** Add something like `createRemoteIam({baseURL,basePath})` implementing `authenticate` (via `getCallerIdentity`), `authorize`, `authorizeMany` and `listAccessible` with a per-call `CredentialInput`, so it satisfies `McpIam` and `A2aIam`. Files: `client\src\index.ts` (new export), `mcp\src\index.ts` (document it).
2. **U2 – Subtree registration of managed resources.** Let `resources.registerMany`, `update` and `delete` take a per-item `tenantId` within the caller's subtree, matching `billing.recordMany`. File: `server\src\api\resources.ts`.
3. **U3 – Plugin-provided `resolveResource` per contributed type**, so `@better-compute/iam-plugin` can ship its resolver. Files: `core\src\index.ts` (`IamPlugin`), `server\src\decisions.ts` (`resolve`, ~372-417).
4. **U4 – Event detail.**
   - `identities.setStatus` and `tenants.setStatus` should emit `identity:status` / `tenant:status` with `{status}`. Files: `server\src\api\identities.ts:1424`, `server\src\api\tenants.ts:552`.
   - `auth:session:revoke` should carry the revoked `sessionId`. Files: `auth\src\service\sessions.ts:247`, `auth\src\service\base.ts:606`.
5. **U5 – A trusted audit append that fans out.** Expose `iam.events.record(event)` in-process, and optionally an HTTP `audit.record` gated by `iam:audit:write`, so compute actions land in the tenant chain and reach webhooks. Files: `server\src\events.ts`, `server\src\index.ts:610`, `server\src\api\webhooks.ts` (`createAuditApi`).
6. **U6 (only if node or workload federation is used).**
   - Per-subject revocation: `oidcProviders.revokeSessions({subject})` or `trust.revokeSessions({sourceIdentity})`.
   - Adding a static `jwks` key should not move the watermark; only removing one should.
   - File: `server\src\api\oidc-providers.ts`.
7. **U7 (optional).** Generalize delegation `spend` caps to billing meters. Files: `server\src\delegations.ts`, `server\src\billing-service.ts`.

## Source map

All under `C:\Users\Sean Filimon\Desktop\better-iam\packages\`:
- `server\src\`: `index.ts`, `options.ts`, `operations.ts`, `decisions.ts`, `context.ts`, `session-tokens.ts`, `assertions.ts`, `events.ts`, `http.ts`, `web-identity.ts`, `web-identity-exchange.ts`, `safe-fetch.ts`, `catalog.ts`, `agents.ts`, `delegations.ts`, `temporary-credentials.ts`
- `server\src\api\`: `resources.ts`, `service-accounts.ts`, `trust.ts`, `oidc-providers.ts`, `tenants.ts`, `identities.ts`, `billing.ts`, `sts.ts`, `roles.ts`
- `core\src\`: `index.ts`, `audit.ts`
- `auth\src\`: `crypto.ts`, `service\base.ts`, `service\sessions.ts`
- `client\src\index.ts`
- `oauth\src\`: `resource-server.ts`, `ssf.ts`
- `mcp\src\index.ts`
- `a2a\src\index.ts`
- `projects\src\index.ts`
- `cli\src\`: `index.ts`, `profiles.ts`
- `better-iam\package.json` (umbrella subpath exports to mirror)