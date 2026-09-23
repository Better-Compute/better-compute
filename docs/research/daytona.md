# Daytona architecture teardown, with modularity patterns for better-compute

**Sources and how reliable they are**
- Web access worked. Most facts below come from source files at git tag **`v0.190.0`**, pulled through the GitHub contents API and raw files. Links use `https://github.com/daytonaio/daytona/blob/v0.190.0/<path>`, shortened to `…/<path>`.
- **Main is now empty.** The `main` branch of `daytonaio/daytona` holds only `README.md` and `assets/`. The README says the repo stopped being maintained in June 2026 and development moved to a private codebase (https://github.com/daytonaio/daytona). The last public tag is v0.190.0 (https://api.github.com/repos/daytonaio/daytona/tags).
- **Licences differ by generation.** The current code is AGPL-3.0 (file headers). The legacy dev-environment code (≤ v0.53, Feb 2025) is Apache-2.0 (https://pkg.go.dev/github.com/daytonaio/daytona/pkg/provider).
- **The pivot date is 2025-04-17:** Daytona moved from dev environments for humans to runtimes for AI agents (https://www.daytona.io/dotfiles/from-dev-environments-to-ai-runtimes).
- **Caveat:** file contents were read through a summarizing fetcher. Exact literals are quoted where it returned them. Anything I couldn't confirm is marked **unverified**.

---

## 1. Component map (current sandbox platform, v0.190.0)

**Monorepo tooling** (root listing https://api.github.com/repos/daytonaio/daytona/contents/?ref=v0.190.0, and `…/package.json`):
- Build: Nx 21.4.1 with Yarn 4.13.0. Nx plugins: `@nx/nest`, `@nx/react`, `@nx/vite`, `@nx/node`, `@nx/webpack`, `@nx-go/nx-go`, `@nx-tools/nx-container`.
- Multi-language: `go.work`, `pyproject.toml`/`poetry.lock`, `Gemfile`, `flake.nix`.
- Client generation: `openapitools.json`. Protobuf via `buf` in `libs/runner-proto`.
- Other top-level dirs: `apps/`, `libs/`, `charts/`, `docker/`, `examples/`, `guides/`, `functions/`, `images/`, `hack/`, `scripts/`.

| App (`apps/*`) | Stack | Role |
|---|---|---|
| `api` | TypeScript, NestJS, TypeORM on Postgres, ioredis | Control plane. REST under `/api`, Swagger, crons, schedulers, reconciler. Runs in **api** or **worker** mode (`isApiEnabled()` / `isWorkerEnabled()`); OTel service name is `daytona-{api\|worker}`. Worker mode can also consume from Kafka (`connectMicroservice`, group `daytona`). Sources: `…/apps/api/src/main.ts`, `…/apps/api/src/tracing.ts` |
| `runner` | Go | The per-node agent (a Docker host). Has its own HTTP API (controllers `sandbox`, `snapshot`, `info`, `health`, `proxy`, `command_logs`). v2 runners also run a job **poller**, **executor** and **healthcheck** reporter. It embeds an SSH gateway, network rules (`netrules`), a metrics collector and S3 storage. Sources: `…/apps/runner/cmd/runner/main.go`, `…/apps/runner/pkg` |
| `daemon` | Go, Gin | Runs **inside each sandbox**. The runner injects it as a static binary (`daemon.WriteStaticBinary`). It serves the "Toolbox API": `/files`, `/process` (sessions, PTY), `/git`, `/lsp`, `/computeruse`, `/port`, `/proxy`, `/version`, `/init`. Instrumented with OTel. Source: `…/apps/daemon/pkg/toolbox/server.go` |
| `proxy` | Go | Host-routed HTTP/WebSocket proxy for preview URLs and the toolbox path (see §5). Source: `…/apps/proxy/pkg/proxy/proxy.go` |
| `ssh-gateway` | Go | SSH front door on port 2222. The SSH username is the access token. Source: `…/apps/ssh-gateway/README.md` |
| `snapshot-manager` | Go | Snapshot storage and retrieval service, deployable per region. Its internals (e.g. whether it wraps `distribution`) are **unverified**. Source: `…/apps/snapshot-manager/cmd/main.go` |
| `otel-collector` | Custom OTel Collector build (`builder-config.yaml`) | OTLP receiver on :4318. A custom **Daytona exporter** routes telemetry per organization using the `sandbox-auth-token` header and a 5-minute config cache. A **ClickHouse** exporter keeps 72h. Source: `…/apps/otel-collector/config.yaml` |
| `dashboard` | React, Vite, Storybook | Web UI (`vite.config.mts`) |
| `cli` | Go, Cobra, bubbletea, `mcp-go`, `x/oauth2` | CLI with a built-in MCP server. Source: `…/apps/cli/go.mod` |
| `docs`, `daytona-e2e` | — | Documentation and end-to-end tests |

**`libs/*`** (26 packages):
- Hand-written SDKs: `sdk-{typescript,python,go,ruby,java}`.
- Generated clients, one per audience and language:
  - Control plane: `api-client*`
  - Toolbox (the in-sandbox daemon): `toolbox-api-client*`
  - Runner (API→runner): `runner-api-client`
  - Other: `billing-api-client`, `analytics-api-client`
- Also: `runner-proto` (job payloads), `common-go`, `computer-use` (plugin binary), `opencode-plugin`, `pi-extension`.
- The TS SDK modules are `Daytona`, `Sandbox`, `FileSystem`, `Git`, `Process`, `PtyHandle`, `LspServer`, `ComputerUse`, `CodeInterpreter`, `Image` (declarative image builder), `Snapshot`, `Volume`, `ObjectStorage` (`…/libs/sdk-typescript/src`).

**Documented planes** (https://www.daytona.io/docs/en/architecture):
- *Interface*: SDKs, CLI, dashboard, MCP, SSH.
- *Control*: the NestJS API with Postgres ("primary persistent store"), Redis ("caching, session management, and distributed locking"), Auth0/OIDC, SMTP, PostHog. It hosts a **Snapshot Builder** and a **Sandbox Manager** internally, plus the proxy.
- *Compute*: runners, the sandbox daemon, a snapshot store (an OCI registry on S3), and volumes.

**API NestJS modules** (`…/apps/api/src/app.module.ts`):
- Infrastructure: `TypeOrmModule`, `RedisModule` (×2), `ThrottlerModule` (Redis storage), `EventEmitterModule`, `ScheduleModule`, `ClickHouseModule`, `OpenFeatureModule` (PostHog provider), `LoggerModule` (pino), `EmailModule`.
- Features: `ApiKey`, `Auth`, `User`, `Sandbox`, `DockerRegistry`, `Usage`, `Analytics`, `Organization`, `Region`, `Admin`, `Notification`, `Webhook`, `ObjectStorage`, `Audit`, `Health`, `SandboxTelemetry`.
- Global guards: `GlobalAuthGuard`, `SystemActionGuard`.
- Middleware: `VersionHeaderMiddleware`, `FailedAuthRateLimitMiddleware`, `MaintenanceMiddleware`.

---

## 2. Runners: registration, dispatch, health, scheduling

### Runner entity
Source: `…/apps/api/src/sandbox/entities/runner.entity.ts`

| Group | Fields |
|---|---|
| Endpoints and credentials | `domain`, `apiUrl`, `proxyUrl`, `apiKey` |
| Capacity | `cpu`, `memoryGiB`, `diskGiB`, `gpu`, `gpuType` (enum `H100`, `RTX-PRO-6000`), `sandboxClass` (default `container`) |
| Live usage | `currentCpuLoadAverage`, `current{Cpu,Memory,Disk}UsagePercentage`, `currentAllocated{Cpu,MemoryGiB,DiskGiB}`, `currentSnapshotCount`, `currentStartedSandboxes`, `availabilityScore` |
| Placement and version | `region`, `name`, `state`, `appVersion`, `apiVersion` (`'0'` or `'2'`) |
| Scheduling | `lastChecked`, `unschedulable`, `draining`, `tags[]` (GIN index), `serviceHealth` (JSON) |

Constraints: unique `(region, name)`, index `(state, unschedulable, region)`.

### Registration
- `POST /runners` is gated three ways: permission `write:runners`, feature flag `ORGANIZATION_INFRASTRUCTURE`, and a **custom region** the organization owns. The body is `{regionId, name, tags}`. It returns the runner with a generated API key that is shown once (`…/controllers/runner.controller.ts`; https://www.daytona.io/docs/en/runners/).
- The runner is then started with `DAYTONA_API_URL` and `DAYTONA_RUNNER_TOKEN`. `API_VERSION` defaults to `2` (`…/apps/runner/cmd/runner/config/config.go`).

### Two dispatch protocols behind one adapter interface
Source: `…/apps/api/src/sandbox/runner-adapter/runnerAdapter.ts`

The `RunnerAdapter` interface has these methods: `init`, `healthCheck`, `runnerInfo`, `sandboxInfo`, `createSandbox`, `startSandbox`, `stopSandbox`, `destroySandbox`, `createBackup`, `removeSnapshot`, `buildSnapshot`, `pullSnapshot`, `snapshotExists`, `getSnapshotInfo`, `inspectSnapshotInRegistry`, `updateNetworkSettings`, `forkSandbox`, `pauseSandbox`, `createSnapshotFromSandbox`, `recoverSandbox`, `resizeSandbox`.

`RunnerAdapterFactory.create(runner)` switches on `runner.apiVersion`: `'0'` → `RunnerAdapterV0`, `'2'` → `RunnerAdapterV2`. Any other value throws.

**v0 (push):**
- The API calls the runner's HTTP API with the generated `@daytona/runner-api-client` over axios.
- Base URL is `runner.apiUrl`, auth is `Bearer runner.apiKey`, timeout is 15 minutes, and `axios-retry` makes 3 attempts with exponential backoff (`…/runnerAdapter.v0.ts`).
- Health: an API cron every 10 seconds calls the runner, and uses `runnerHealthTimeout`.

**v2 (pull, "job-based runners"):**
- Introduced in v0.132.0, together with custom regions, per-region proxy and SSH gateway, and a region snapshot manager (https://www.daytona.io/changelog/job-based-runners-custom-regions).
- `RunnerAdapterV2` never calls the runner. It writes `Job` rows through `JobService.createJob(null, JobType.X, runnerId, ResourceType.SANDBOX, id, payload)`. `healthCheck` and `runnerInfo` throw "not supported for V2 runners" (`…/runnerAdapter.v2.ts`).

**`Job` entity** (`…/entities/job.entity.ts`):
- Columns: `id`, `version` (`@VersionColumn`), `type`, `status` (default `PENDING`), `runnerId`, `resourceType`, `resourceId`, `payload`, `resultMetadata`, `traceContext` (jsonb), `errorMessage`, `startedAt`, `completedAt`.
- Indexes: `(runnerId, status)`, `(status, createdAt)`, `(resourceType, resourceId)`.
- **Partial unique index `IDX_UNIQUE_INCOMPLETE_JOB`** on `(resourceType, resourceId, runnerId) WHERE completedAt IS NULL`, with a separate one for `CREATE_BACKUP`. This allows only one in-flight job per resource per runner.

**`JobType` values:** `CREATE_SANDBOX`, `START_SANDBOX`, `STOP_SANDBOX`, `DESTROY_SANDBOX`, `RESIZE_SANDBOX`, `CREATE_BACKUP`, `BUILD_SNAPSHOT`, `PULL_SNAPSHOT`, `RECOVER_SANDBOX`, `INSPECT_SNAPSHOT_IN_REGISTRY`, `REMOVE_SNAPSHOT`, `UPDATE_SANDBOX_NETWORK_SETTINGS`, `SNAPSHOT_SANDBOX`, `FORK_SANDBOX`, `PAUSE_SANDBOX`.

**Job endpoints** (`…/controllers/job.controller.ts`, guards `RunnerAuthContextGuard` and `AuthenticatedRateLimitGuard`):
- `GET /jobs/poll?timeout=30&limit=10` (maximums 60 and 100) is a long poll.
- `GET /jobs?status&limit&offset`
- `GET /jobs/:jobId`
- `POST /jobs/:jobId/status` with body `{status, errorMessage, resultMetadata}`.

**Wake-up and claim mechanics** (`…/services/job.service.ts`):
1. `notifyRunner()` does `LPUSH runner:jobs:{runnerId} <jobId>`.
2. `pollJobs()` first tries `claimPendingJobs()`. If nothing is pending, it runs `BRPOP` on a *duplicated* Redis client, and falls back to DB polling if Redis fails.
3. A claim sets `IN_PROGRESS` and saves under the optimistic `@VersionColumn`. On `OptimisticLockVersionMismatchError` the job is skipped. There is no `SELECT … FOR UPDATE`.
4. Completion calls `JobStateHandlerService.handleJobCompletion()`, fire-and-forget.
5. `handleStaleJobs()` runs every minute. It fails `IN_PROGRESS` jobs with no update for 10 minutes by default (`BUILD_SNAPSHOT`: 120). It processes at most 500 per group.
6. `captureTraceContext()` stores W3C `traceparent`/`tracestate` on the job, so a trace crosses the API→runner boundary.

**Job payload encoding:**
- Payloads are protobuf messages in `libs/runner-proto/proto/runner/v1alpha1/job.proto` (e.g. `SnapshotSandboxPayload`, `ForkSandboxPayload`, `PauseSandboxPayload`, `Registry`), serialized with `toJson()`.
- **There is no gRPC service.** The transport is REST+JSON.

**Runner poller side** (`…/apps/runner/pkg/runner/v2/poller/poller.go`):
- On start it calls `ListJobs` for `IN_PROGRESS` jobs and resumes them.
- It then loops `PollJobs(timeout, limit)`. HTTP 408 means "no work". Errors sleep 5 seconds.
- Each job runs as `go executor.Execute(ctx, &job)`, with **no concurrency bound**. That is a flaw not to copy.
- Config: `POLL_TIMEOUT=30s`, `POLL_LIMIT=10`.

### Heartbeat and health
- The v2 runner sends `POST /runners/healthcheck` every `HEALTHCHECK_INTERVAL=30s` (timeout 10s).
- Payload: CPU load and usage, memory and disk usage, allocated and total CPU/RAM/disk, GPU count and type, snapshot count, started sandboxes, `appVersion`, `domain`, `apiUrl`, `proxyUrl`, and `serviceHealth` (Docker health plus reason). Sources: `…/pkg/runner/v2/healthcheck/healthcheck.go`, `runner.controller.ts`.
- The API cron `handleCheckRunners()` runs `EVERY_10_SECONDS` under Redis lock `check-runners` (60s TTL). It marks a v2 runner `UNRESPONSIVE` when `lastChecked` is older than 60s, with a 60s grace period at API startup (`…/services/runner.service.ts`).
- `RunnerState` values: `initializing`, `ready`, `disabled`, `decommissioned`, `unresponsive`.

### Cordon, drain and decommission
- `PATCH /runners/:id/scheduling {unschedulable}` and `PATCH /runners/:id/draining {draining}`, both permission `write:runners`.
- `handleCheckDecommissionRunners()` (lock `check-decommission-runners`) needs **3 consecutive** successful drain checks, tracked in Redis `runner:draining-check:{runnerId}` (10-minute TTL), before it decommissions a runner.
- Other routes: `DELETE /runners/:id`, `GET /runners/me` (runner self-info), and lookups used by proxy and gateway: `GET /runners/by-sandbox/:sandboxId`, `GET /runners/:id/full`, `GET /runners/by-snapshot-ref?ref=`.

### Scheduling
`RunnerService.getRandomAvailableRunner(params)` → `findAvailableRunners()` (`…/services/runner.service.ts`):
- **Filters:** `regions`, `state=READY`, `!unschedulable`, `!draining`, `availabilityScore >= threshold`, `sandboxClass` match, GPU capacity (`getRunnersAtGpuCapacity()`), `gpu`/`gpuType`, `excludedRunnerIds`, and snapshot affinity (`SnapshotRunnerState.READY` for `snapshotRef`).
- **Scoring:** the results are sorted by `availabilityScore`, cut to the **top 10**, and one is chosen **at random**.
- **Score formula (TOPSIS):** the inputs are cpu/mem/disk usage, allocated/total ratios, and started sandboxes. Score = `d_critical / (d_optimal + d_critical)`. Exponential penalties apply above thresholds.
- **Config keys:** `runnerScore.weights.*`, `runnerScore.targetValues.{optimal,critical}.*`, `runnerScore.penalty.{exponents,thresholds}.{cpu,cpuLoadAvg,memory,disk}`.
- **Start path:** `SandboxStartAction` prefers runners that already hold the snapshot. If a stopped or archived sandbox's runner is unschedulable, `restoreSandboxOnNewRunner()` moves it from its backup to a new runner (`…/sandbox-actions/sandbox-start.action.ts`).

---

## 3. Sandbox lifecycle

- **`SandboxState`** (`…/enums/sandbox-state.enum.ts`): `creating`, `restoring`, `destroyed`, `destroying`, `started`, `stopped`, `starting`, `stopping`, `error`, `build_failed`, `pending_build`, `building_snapshot`, `unknown`, `pulling_snapshot`, `archived`, `archiving`, `resizing`, `snapshotting`, `forking`, `pausing`, `paused`, `resuming`.
- **`SandboxDesiredState`:** `destroyed`, `started`, `stopped`, `resized`, `archived`, `paused`.
- **Sandbox entity fields** (`…/entities/sandbox.entity.ts`): `organizationId`, `region`, `runnerId`, `prevRunnerId`, `sandboxClass`, `state`, `desiredState`, `snapshot`, `osUser`, `env`, `labels`, `public`, `networkBlockAll`, `networkAllowList`, `domainAllowList`, `backup*`, `cpu`/`gpu`/`gpuType`/`mem`/`disk`, `volumes`, `autoStopInterval` (15), `autoArchiveInterval` (7 days; the summarizer returned the literal `1008000` alongside "(7 days)", so the exact literal is unverified), `autoDeleteInterval` (-1 means disabled, 0 means ephemeral), `pending`, `authToken` (nanoid 32), `daemonVersion`, `linkedSandboxId`, `recoverable`.
- **Classes** (`SandboxClass`): `container`, `linux-vm`, `android`, `windows`. The docs also list macOS and GPU. A GPU sandbox can have up to 8 GPUs, and each GPU allows up to 16 vCPU, 192GB RAM and 512GB disk (https://www.daytona.io/docs/en/sandboxes). Runners for the VM, Windows and Android classes are **not in the public repo (unverified)**.
- **Reconciler** (`…/managers/sandbox.manager.ts`):
  - `syncInstanceState(id)` takes a Redis lock `getStateChangeLockKey` (30s) and loops for up to 10s while `state !== desiredState`.
  - It dispatches to `SandboxStartAction`, `SandboxStopAction`, `SandboxDestroyAction` or `SandboxArchiveAction`. Each `run()` returns `SYNC_AGAIN` or `DONT_SYNC_AGAIN`. v2 runners exit the loop immediately, because job completion re-triggers it.
  - Crons (all `EVERY_10_SECONDS` unless noted): `autostopCheck`, `autoArchiveCheck`, `autoDeleteCheck`, `syncStates` (per-runner lock `sync-states:{runnerId}`, 300s), `syncRestoringStates` (5s), `syncArchivedDesiredStates`, `syncArchivedCompletedStates`.
  - Leader-style "worker-selected" locks: `auto-stop-check-worker-selected` and others, 60s.
  - It also reacts to `SandboxEvents.{CREATED,STARTED,STOPPED,ARCHIVED,DESTROYED}` through `@OnAsyncEvent`.
- **Activity tracking:** the proxy and SSH gateway call `POST /sandbox/:id/last-activity`. The header `X-Daytona-Skip-Last-Activity-Update` opts out.
- **Archive:** a backup is pushed to a `BACKUP` registry, which lets a restore land on a different runner.
- **Warm pool** (`…/services/sandbox-warm-pool.service.ts`):
  - `warmPoolCheck()` runs every 10s and emits `TOPUP_REQUESTED` for missing sandboxes, under lock `warm-pool-lock-{id}` (720s).
  - `fetchWarmPoolSandbox()` claims a `STARTED` sandbox owned by `SANDBOX_WARM_POOL_UNASSIGNED_ORGANIZATION` that exactly matches snapshot, cpu, mem, disk, gpu, osUser and env. The claim lock is `sandbox-warm-pool-{id}` (10s).
- **Public sandbox API** (`…/controllers/sandbox.controller.ts`):
  - `POST /sandbox`
  - `POST /sandbox/:id/{start,stop,pause,archive,recover,resize,fork,snapshot,backup,network-settings}`
  - `POST /sandbox/:id/{autostop,autoarchive,autodelete}/:interval`
  - `PUT /sandbox/:id/labels`, `POST /sandbox/:id/public/:isPublic`, `DELETE /sandbox/:id`
  - Preview: `GET …/ports/:port/{preview-url,signed-preview-url}`
  - SSH: `POST|DELETE …/ssh-access`
  - Runner-facing: `GET /sandbox/for-runner` and `PUT /sandbox/:id/state` (runner auth).
  - Throttler scopes: `sandbox-create`, `sandbox-lifecycle`.

## 4. Snapshots, registries, volumes

- **`SnapshotState`:** `building`, `pending`, `pulling`, `active`, `inactive`, `error`, `build_failed`, `removing`. Each snapshot also has a per-runner `SnapshotRunnerState`: `pulling_snapshot`, `building_snapshot`, `ready`, `error`, `removing`.
- **Snapshot manager crons** (`…/managers/snapshot.manager.ts`):
  - `check-snapshot-state` every 10s.
  - `sync-runner-snapshot-states` every 5s.
  - `deactivate-old-snapshots` every 10 minutes. The cutoff is 14 days, `DEFAULT_SNAPSHOT_DEACTIVATION_TIMEOUT_MINUTES`, overridable per organization with `snapshotDeactivationTimeoutMinutes`.
  - `cleanup-inactive-snapshots-from-runners`.
- **Propagation:** `propagateSnapshotToRunners()` sends a snapshot to every runner an organization owns, and to `BASE_PROPAGATION_FACTOR = 1/3` of the shared runners (shuffled).
- **`RegistryType`:** `internal`, `organization`, `transient`, `backup`. A pull lands in the transient registry and is then promoted to internal.
- **Builds run on runners:** `BUILD_ENGINE=buildkit`, `BUILD_TIMEOUT_MIN=120`, `BUILD_CPU_CORES=4`, `BUILD_MEMORY_GB=8`.
- **Snapshot sources:** a registry image, a Dockerfile, the SDK's declarative `Image` builder, or a running sandbox. A VM snapshot can include memory (`includeMemory`). Source: https://www.daytona.io/docs/en/snapshots.
- **Volumes:** FUSE mounts over S3-compatible storage, with subpath isolation (subpath = S3 key prefix). Writes are last-write-wins. Limit 100 per organization. States `ready`, `pending_delete`, `deleting`, `error`. Source: https://www.daytona.io/docs/en/volumes. The runner reclaims unused volumes (`VOLUME_CLEANUP_*`).

## 5. Networking, proxy, SSH, isolation

- **Preview URLs:** `https://{port}-{sandboxId}.{proxyDomain}`, and the signed form `https://{port}-{token}.{proxyDomain}`. Signed tokens are bound to one port, expire after 60s by default (up to 86,400s), and can be revoked. Private previews need the `x-daytona-preview-token` header (https://www.daytona.io/docs/en/preview-and-authentication).
- **Proxy internals:**
  - `parseHost()`, and `parseToolboxSubpath()` for `/toolbox/{sandboxId}/…`.
  - Resolves a sandbox to its runner through the API, with `runnerCache` and `sandboxRunnerCache` (Redis or in-memory, with TTL).
  - Auth modes: the header, an OIDC `/callback` cookie (max age 3600s), or public access.
  - Other features: a `ToolboxOnlyMode` switch, a `ConnectionMonitor` for WebSockets, and a metrics port.
  - The API pushes cache invalidations through `ProxyCacheInvalidationService`.
- **SSH gateway:**
  - The client runs `ssh -p 2222 <token>@host`.
  - The gateway calls `GET /sandbox/ssh-access/validate?token=` and then `GET /runners/{id}/ssh-keypair`.
  - It forwards to the SSH gateway embedded in the runner (port 2222).
- **Egress controls:** `networkBlockAll`; `networkAllowList` (at most 10 IPv4 CIDRs); `domainAllowList` (at most 100, wildcards allowed); an allowlist of essential services that depends on the org's tier (https://www.daytona.io/docs/en/network-limits). The runner enforces these through `pkg/netrules`; the iptables mechanism is **unverified**. `INTER_SANDBOX_NETWORK_ENABLED` defaults to true.
- **Isolation:**
  - The docs say only "dedicated namespaces and enforced resource limits" via cgroups for containers, and a "full virtual machine with its own kernel" for VMs (https://www.daytona.io/docs/en/isolation/).
  - Which runtime (Sysbox or Kata) and which hypervisor are **unverified**. The runner does have a `CONTAINER_RUNTIME` setting.
  - `RESOURCE_LIMITS_DISABLED` exists; it is set to true in the dev compose file.

## 6. Auth, tenancy, quotas, metering

**Bearer resolution order** (`ApiKeyStrategy`, `…/apps/api/src/auth/api-key.strategy.ts`):
1. Static system keys → `ssh-gateway`, `proxy`, `otel-collector`, `health-check`.
2. JWT-shaped tokens → handed to the JWT strategy.
3. User API key → hash lookup, Redis-cached (`apiKey.validationCacheTtlSeconds`, `apiKey.userCacheTtlSeconds`), expiry checked.
4. Runner key → `runner`.
5. Region proxy key hash → `region-proxy`.
6. Region SSH gateway key hash → `region-ssh-gateway`.

These map to distinct context types: `UserAuthContext`, `RunnerAuthContext`, `ProxyAuthContext`, `RegionProxyAuthContext` and so on. Guards compose through `or.guard.ts`.

**JWT:**
- JWKS (`passportJwtSecret`, RS256) from the OIDC issuer: Auth0 in the cloud, Dex (`dexidp/dex`) in compose.
- A user and a personal organization are provisioned automatically on first login.
- The organization comes from the `X-Daytona-Organization-ID` header (`…/auth/jwt.strategy.ts`).

**Roles and permissions:**
- `OrganizationMemberRole` has two values: `owner` and `member`.
- `OrganizationRole` entities (global or org-scoped) carry an array of `OrganizationResourcePermission` values and are assigned to users and invitations.
- Permission strings: `write:registries`, `delete:registries`, `write:snapshots`, `delete:snapshots`, `write:sandboxes`, `delete:sandboxes`, `read|write|delete:volumes`, `write|delete:regions`, `read|write|delete:runners`, `read:audit_logs`.
- API keys carry scopes and an expiry. `manage:api_keys` lets a key mint restricted child keys. Read access to sandboxes, snapshots, registries and regions is always granted (https://www.daytona.io/docs/en/api-keys/).

**Regions** (`RegionType`):
- `shared`, `dedicated`, `custom`.
- The `Region` entity has `proxyUrl`, `toolboxProxyUrl`, `sshGatewayUrl`, `snapshotManagerUrl`, `proxyApiKeyHash`, `sshGatewayApiKeyHash` and `enforceQuotas`.
- Shared-region GPU usage is pooled into a logical region called "Earth" (https://www.daytona.io/docs/en/regions/).

**Quotas:**
- **`RegionQuota`**, keyed by (org, region, sandboxClass): `totalCpuQuota`, `totalMemoryQuota`, `totalDiskQuota`, `totalGpuQuota`, `allowedGpuTypes[]`, `maxCpu|Memory|DiskPerSandbox`, `maxDiskPerNonEphemeralSandbox`, `maxCpu|Memory|DiskPerGpuSandbox`.
- **`Organization`** holds `maxSnapshotSize`, `snapshotQuota`, `volumeQuota`; three rate-limit families (`authenticated`, `sandboxCreate`, `sandboxLifecycle`, each with a TTL); `suspended*`; `sandboxLimitedNetworkEgress`; `otelConfig`.
- Tiers range from 10 vCPU / 10GiB / 30GiB up to 500 / 1000 / 5000. Stopped, paused and archived sandboxes release CPU and RAM (https://www.daytona.io/docs/en/limits).

**Metering** (`…/apps/api/src/usage/services/usage.service.ts`):
- A `SandboxUsagePeriod` opens on `STARTED`. It closes on stop, pause or destroy; a stopped sandbox is metered for disk only.
- `closeAndReopenUsagePeriods()` runs every minute and splits periods into daily chunks.
- `archiveUsagePeriods()` runs every 5s and moves batches of 5,000 to `SandboxUsagePeriodArchive`.
- Billing and analytics are separate services (`billing-api-client`, `analytics-api-client`); their implementations are **private / unverified**.

**Audit:**
- Interceptors and decorators feed pluggable **adapters** (`audit-typeorm`, `audit-opensearch`) and **publishers** (`audit-direct-publisher`, `kafka`) (`…/apps/api/src/audit/*`).

**Webhooks:**
- Delivered through **Svix**, with one Svix app per organization. Sandbox, snapshot and volume events come from the event emitter (`…/apps/api/src/webhook/README.md`).

## 7. Observability, autoscaling, deployment

- **Observability:**
  - API: OTel `NodeSDK` exporting traces, metrics (every 30s) and logs over OTLP HTTP with gzip. Instrumentations: http, express, nest, pg, ioredis, kafkajs, pino, runtime.
  - Runner: optional OTel (`OTEL_LOGGING_ENABLED`, `OTEL_TRACING_ENABLED`, `OTEL_EXPORTER_OTLP_ENDPOINT`).
  - Daemon: OTel, controlled by `INITIALIZE_DAEMON_TELEMETRY`.
  - The per-organization collector exports to the org's own endpoint and to ClickHouse.
  - `/health` module.
  - Compose runs Jaeger.
- **Autoscaling:**
  - No runner autoscaler exists in the public code (unverified).
  - The capacity levers are warm pools, the score threshold, draining and decommissioning, and snapshot pre-propagation.
  - The API scales horizontally: stateless replicas, api/worker process split, every cron behind a Redis lock, and optimistic-lock job claims.
- **Deployment:**
  - `docker/docker-compose.yaml` runs `api`, `proxy`, `runner`, `ssh-gateway`, `postgres:18`, `redis`, `dex`, `registry:2.8.2`, `registry-ui`, `minio`, `maildev`, `pgadmin`, `jaeger` and `otel-collector`. It is labelled "not safe to use in production".
  - `charts/daytona-preview` bundles Postgres and Redis subcharts.
  - For BYOC, the `daytonaio/helm-charts` `daytona-region` chart deploys the region proxy, an optional snapshot manager, and a registration job. Connectivity is outbound-only through a "Reverse Proxy Tunnel" (https://www.daytona.io/docs/en/bring-your-own-compute/). Terraform modules are **unverified**: a search snippet mentions them, but the fetched page does not.

## 8. Legacy dev-environment manager (≤ v0.53, Apache-2.0)

- **Server** (Go, `pkg/server`):
  - Services: `ApiKeyService`, `TargetService`, `TargetConfigService`, `WorkspaceService`, `WorkspaceTemplateService`, `BuildService`, `GitProviderService`, `EnvironmentVariableService`, `JobService`, `RunnerService`, `LocalContainerRegistry`.
  - Networking: a **Headscale/Tailscale** mesh to targets, and **FRP** (frps) tunnels for NAT traversal (https://pkg.go.dev/github.com/daytonaio/daytona/pkg/server).
- **Provider plugin model** (https://pkg.go.dev/github.com/daytonaio/daytona/pkg/provider):
  - The `Provider` interface: `Initialize(InitializeProviderRequest)`, `GetInfo()`, `CheckRequirements()`, `GetPresetTargetConfigs()`, `Create|Start|Stop|DestroyTarget(*TargetRequest)`, `GetTargetProviderMetadata`, `Create|Start|Stop|DestroyWorkspace(*WorkspaceRequest)`, `GetWorkspaceProviderMetadata`.
  - Served as a **HashiCorp go-plugin** over net/rpc (`ProviderPlugin{Impl}`, `ProviderRPCClient`, `ProviderRPCServer`).
  - Handshake: `ProtocolVersion: 1`, `MagicCookieKey: "DAYTONA_PROVIDER_PLUGIN"`, `MagicCookieValue: "daytona_provider"`.
- **Provider manager** (https://pkg.go.dev/github.com/daytonaio/daytona/pkg/provider/manager):
  - `IProviderManager` methods: `DownloadProvider`, `GetProvider`, `GetProviders`, `GetProvidersManifest`, `RegisterProvider(pluginPath, manualInstall)`, `TerminateProviderProcesses`, `UninstallProvider`, `Purge`.
  - Manifest shape: `ProvidersManifest` maps a name to `ProviderManifest{Default, Label, Versions}`, and each `Version` has `DownloadUrls` keyed by OS/arch.
  - Manifest URL: `https://download.daytona.io/daytona/providers/manifest.json` (search result; unverified).
  - Installation was `daytona provider install`, or runner jobs with actions `install-provider`, `update-provider`, `uninstall-provider`.
  - The on-disk layout (`baseDir/<name>/<version>`) is **unverified**.
- **Targets:**
  - `TargetConfig{Name, ProviderInfo, Options(JSON)}`.
  - Providers declare a typed **`TargetConfigManifest`**. Property types: `string`, `option`, `boolean`, `int`, `float`, `file-path`. Property options: `InputMasked`, `DisabledPredicate`, `DefaultValue`, `Suggestions`.
  - `ProviderInfo` has `RunnerId`, `Version` and `AgentlessTarget` (https://pkg.go.dev/github.com/daytonaio/daytona/pkg/models).
- **Runners (legacy):**
  - `IRunner.CheckAndRunJobs` polls `ListPendingJobs` and reports with `UpdateJobState`. `SetRunnerMetadata` is a heartbeat every **2s**.
  - Jobs have `ResourceType` workspace, target, build or runner; `JobState` pending, running, error or success; and a unified `ResourceState` with `pending-*`, `unresponsive`, etc. (https://pkg.go.dev/github.com/daytonaio/daytona/pkg/runner).
- **Agent** (inside the workspace or target): SSH server, Tailscale, toolbox (fs, git, process, LSP), git clone (https://pkg.go.dev/github.com/daytonaio/daytona/pkg/agent).
- **Known providers:** docker (default, MIT), hetzner, gcp, macos, windows (pkg.go.dev). The repos were later renamed `legacy-daytona-provider-*` (github.com/daytonaio/legacy-daytona-provider-docker).
- **Current equivalent:**
  - Out-of-process provider binaries were **dropped**. Backend variety now comes from:
    - `RunnerAdapter` implementations versioned by protocol,
    - `SandboxClass` and GPU fields that route work to capable runners,
    - runner-side settings (`CONTAINER_RUNTIME`, `BUILD_ENGINE`),
    - regions plus BYOC runners.
  - Any node that speaks the job protocol can act as a "provider".

## 9. What makes Daytona modular

Daytona's modularity comes from contracts, not plugins:
1. **Every process boundary has its own generated client:** control API, runner API, toolbox, billing and analytics each get one, in 5 languages.
2. **Work is expressed as typed, versioned jobs.**
3. **A versioned adapter separates the control plane from node implementations.**
4. **Planes are split:** interface, control and compute, with edge services (proxy, SSH, snapshot manager) deployable per region.
5. **Each machine type authenticates as its own principal.**
6. **Cross-cutting sinks are pluggable:** audit adapters and publishers, webhook provider, OTel exporters, feature flags, registry types.
7. **Each domain is a NestJS module** with a fixed internal layout: controllers, services, managers, actions, entities, enums, events, subscribers, guards.

## 10. Patterns better-compute should copy (18)

| # | Pattern (Daytona source) | Why copy it | How it maps to better-compute |
|---|---|---|---|
| 1 | Pull-based job protocol: `GET /jobs/poll` long poll plus `POST /jobs/:id/status` | Nodes only make outbound connections, so they work behind NAT, in colos and on customer sites, with no inbound ports | The daemon long-polls `/v1/nodes/me/jobs/poll`. Lives in `@better-compute/protocol` and the daemon |
| 2 | Adapter chosen by node protocol version (`RunnerAdapterFactory` on `apiVersion`) | Lets the protocol evolve and supports agentless push backends (the old `AgentlessTarget`) | A `NodeAdapter` registry keyed by `daemonProtocol` plus `driver`: `pull-daemon`, `ssh-push`, `redfish`, `hetzner-api` |
| 3 | Jobs table as source of truth: `@VersionColumn` claims, partial unique index for one in-flight job per resource, stale-job sweeper with per-type timeouts | Idempotent, crash-safe, auditable provisioning | `JobType` values such as `REIMAGE`, `PXE_BOOT`, `INSTALL_DRIVER`, `CREATE_VM`, `ATTACH_GPU`, `WIPE_DISK`. Long timeouts for imaging, as Daytona does for `BUILD_SNAPSHOT` |
| 4 | Redis `LPUSH`/`BRPOP` wake-up with DB fallback | Low latency without a message bus, and it degrades gracefully | Keep the DB as truth and treat the wake-up channel as a pluggable `Notifier`. Suggested implementations (my recommendation, not something Daytona does): Postgres `LISTEN/NOTIFY` or Redis. This avoids one blocking Redis connection per waiting poll, which gets expensive at scale |
| 5 | `desiredState` vs `state` reconciler with Action classes returning `SYNC_AGAIN` | Declarative, resumable, testable transitions | `Allocation` and `Node` reconcilers in `@better-compute/provision`. `ProvisionAction`, `ReleaseAction`, `DrainAction` |
| 6 | API and worker are one codebase in two modes; every cron behind a named distributed lock | A control plane that scales horizontally with no singleton | `better-compute serve --mode=api\|worker`, with a `LockProvider` interface backed by Redis or Postgres advisory locks |
| 7 | Heartbeat carries capacity and health (`POST /runners/healthcheck`); staleness marks the node unresponsive | Inventory stays current without polling nodes | Daemon heartbeat includes GPU inventory (model, VRAM, MIG/NVLink topology, ECC/Xid errors, temperature), which I'd suggest collecting via NVML/DCGM. Feeds `@better-compute/inventory` |
| 8 | `unschedulable` and `draining` flags separate from `state`; decommission after N clean checks | Safe maintenance and hardware retirement | `cordon`, `drain` and `decommission` endpoints; drain waits for allocations to finish or migrate |
| 9 | Filter, score, then random top-N (TOPSIS, weights in config) | Avoids hot-spotting and makes scheduling policy tunable | A `Scheduler` plugin interface with `filters[]` and `scorers[]`, e.g. bin-pack vs spread, and GPU topology affinity |
| 10 | Capacity class and type as first-class columns (`sandboxClass`, `gpu`, `gpuType`) plus `RegionQuota(org, region, class)` | Quotas and scheduling share one vocabulary | `NodeClass` = `metal` \| `vps` \| `gpu-metal` \| `vm`; `GpuSku`; quotas per (tenant, site, class) |
| 11 | Region types `shared`, `dedicated`, `custom`, with per-region proxy, SSH and snapshot services and region-scoped keys | Multi-site operation and bring-your-own-hardware | `Site` / `Pool` entities. Tenants register their own nodes into `custom` sites; the edge gateway runs per site |
| 12 | Artifact propagation with per-node state (`SnapshotRunner`) and affinity to nodes that already hold the artifact | Fast starts, and bandwidth-aware placement | OS images, driver bundles, container images and model weights cached per node; the scheduler prefers nodes that already have them |
| 13 | Registry roles (`internal`, `transient`, `backup`, `organization`) | Separates where artifacts come from from how they are used | An `ImageSource` abstraction: OCI, S3, HTTP, PXE/iPXE |
| 14 | Contract-first: OpenAPI-generated clients per boundary, protobuf payloads via `buf` | Many languages and independently versioned components | `@better-compute/protocol` holds the job payloads and daemon API schema; typed clients for API, daemon and edge |
| 15 | Small static daemon on the node with a local HTTP API (toolbox) and OTel | A uniform node surface: exec, files, logs, metrics | A per-node daemon with `/exec`, `/logs`, `/metrics`, `/firmware`, `/gpu`. For VPS and metal nodes it runs on the host rather than inside a container as Daytona's does. Signed binary with self-update |
| 16 | Separate principal type per machine role (`runner`, `proxy`, `ssh-gateway`, `region-proxy`, `otel-collector`), plus a resource-permission vocabulary, roles holding permission arrays, and scoped, expiring API keys with managed child keys | Least privilege and multi-tenant delegation | **better-iam integration:** register permissions such as `compute:nodes:read\|write\|delete`, `compute:jobs:*`, `compute:quotas:*` with better-iam (its `core`, `auth`, `middleware`, `nestjs`, `projects` packages exist under `C:\Users\Sean Filimon\Desktop\better-iam\packages\`). Nodes and gateways become better-iam service principals. Tenancy comes from better-iam orgs/projects instead of Daytona's `X-…-Organization-ID` header. Recommendation: keep the principal type in the auth context, as Daytona's `ApiKeyStrategy` union does |
| 17 | Pluggable sinks: audit adapters (TypeORM / OpenSearch), audit publishers (direct / Kafka), Svix webhooks, EventEmitter domain events, usage periods split daily and archived | Billing and compliance without coupling to the core | GPU-hour and node-hour `UsagePeriod`s; `AuditSink`, `WebhookSink` and `UsageSink` interfaces; events like `node.state_changed` and `allocation.started` |
| 18 | Warm pools, feature-flag gating (`OpenFeature`, `ORGANIZATION_INFRASTRUCTURE`), and W3C trace context stored on jobs | Faster start, safe rollout, end-to-end debugging | Pre-imaged idle metal and pre-created VPS pools per class; flags gate bring-your-own-node; `traceparent` carried on every job so one trace spans API → worker → daemon |

**Don't copy:**
- **Unbounded job goroutines in the runner poller.** Use a per-node semaphore and per-job-type concurrency limits.
- **go-plugin subprocess providers from a TS monorepo.** For better-compute I'd use in-process drivers built with something like `defineProvider()`, with typed config manifests modelled on legacy `TargetConfigManifest` (types plus `InputMasked`, `DisabledPredicate`, `Suggestions`). Keep an optional out-of-process driver protocol for Go or Python drivers.
- **No autoscaler in the public code.** better-compute should add an `Autoscaler`/`CapacityProvider` interface: VPS providers can create nodes on demand, bare metal can't.

**Mapping to the requested subpaths:**
- `better-compute/inventory`: Runner entity, heartbeat and scoring (patterns 7, 10).
- `better-compute/provision`: jobs, reconciler, images and warm pools (3, 5, 12, 13, 18).
- `better-compute/metal`: agentless and daemon adapters for IPMI, Redfish and PXE (2, 15).
- `better-compute/vps`: VPS provider drivers, the successors to legacy Hetzner, GCP and AWS providers (2, 9).
- The central `better-compute` package: server with api/worker modes (6), protocol (14), and the better-iam bridge (16).