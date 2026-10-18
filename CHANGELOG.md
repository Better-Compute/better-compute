# Changelog

All notable changes to the better-compute packages are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Every package in `packages/` shares one version.

## Unreleased

### Security

- **A tenant could build a provider pool on another tenant's or the platform's provider account (0.1.x).**
  `pools.create` is tenant-callable (`compute:pools:create` on the tenant) and checked that the site was the
  caller's, but not who owns `providerAccountId`. A tenant that learned an account id (an offered pool's
  `pools.get` showed it) could create a pool on it, set its own `ownerQuota` and flavors, and have vps create
  machines with that account's credentials in its owner's cloud project: no offer, quota or flavor of the owner
  applied. This affects every provider, not only the new Google Compute Engine one. Now `pools.create` refuses an
  account that is not the pool owner's with `NOT_FOUND`, worded as for an unknown account; vps uses a pool's account
  only when the pool's owner owns it (instance creates and the provider reconciler, flavors, networks, attach,
  reservation bindings); and `pools.get`/`list` no longer show `providerAccountId` to tenants a pool is offered to.

  **Upgrading from 0.1.x.** Find pools that point at another tenant's account:

  ```sql
  SELECT p.id AS pool_id, p.owner_tenant_id, a.id AS account_id, a.tenant_id AS account_tenant_id
    FROM pools p JOIN provider_accounts a ON a.id = p.provider_account_id
   WHERE a.tenant_id <> p.owner_tenant_id;
  ```

  Instances of those pools stop reconciling after the upgrade: the provider reconciler never uses the account, so
  they are neither created, polled nor powered (it retries with an `INVALID_STATE` "has no provider account").
  To clean up, delete each instance (`instances.delete`, or `instances.detach` for an attached one): deletion now
  finishes without a provider call and refunds the tenant's quota. Then archive the pools (`pools.archive`, by their
  owner or a root caller). Finally, check the account owner's cloud project for the machines those instances
  created and remove them there: they are named after the instance id (Hetzner Cloud: the id as host name, with
  `-` for `_`; Google Compute Engine: `bc-` and the same, labelled `better-compute-instance=<instance id>`).
- **Provider-account secret references were not scoped to the account's tenant (0.1.x, every provider).** A
  tenant's account could name `env://` (the control plane's own environment), any `vault://` path, or the
  platform's or another tenant's `secret://` references, and its client resolved them. Now an account of a tenant
  other than the root may name only `secret://<its tenant>/…` and the `vault://` paths `vps({ tenantVaultPaths })`
  allows it: `providerAccounts.create` and `update` refuse anything else with `INVALID_CONFIG`
  (`details.reason: 'secretRefScope'`), the client refuses such a reference again when it resolves it
  (`ACCESS_DENIED`, for rows stored before the upgrade or around the API), and a tenant's references are resolved
  with its tenant as the context, so the sealed store refuses a row of another tenant. Platform accounts are
  unchanged. Check existing tenant accounts before upgrading: one that names such a reference stops working.
- **The Google Cloud key's `token_uri` is pinned.** The key JSON of a tenant's account is the tenant's, and the
  control plane POSTs the signed JWT to its `token_uri`. It must be absent, `https://oauth2.googleapis.com/token`
  or `https://accounts.google.com/o/oauth2/token` (exact match); anything else is `INVALID_CONFIG`
  (`details.reason: 'tokenUri'`) before anything is fetched. (`provider-gcp` is new in this release and never
  shipped without it.)
- **Tenant Google Cloud accounts cannot use the platform's ambient credentials.** Only an account of the root tenant
  may leave out `credentials` and run on the host's identity (the host `tokenSource` or the metadata server); a
  tenant's account without its own key, or with `impersonate` but no key, is `INVALID_CONFIG` at create and update
  and on every use. (Also new with `provider-gcp`.)

### Added

- **Google Compute Engine provider** (`@better-compute/provider-gcp`, new, outside the umbrella). Compute Engine VMs
  as VPS instances and offers, GPU machine types included, over plain `fetch` against the REST v1 API. Accounts take
  `{ projectId, zones, credentials?, impersonate?, … }`; credentials are a service-account key reference, or for
  root-tenant (platform) accounts only, the host's own `tokenSource` or the metadata server (see Security). Create
  is idempotent through GCE's `requestId`, and the VMs it owns carry `better-compute-managed` and
  `better-compute-instance` labels; it never deletes or powers a VM without them. It implements discovery,
  ownership labels, reservations and networks.
- **Discovery and attach** (`@better-compute/vps`). The `vps.discovery` worker lists every machine of accounts whose
  provider can `discover` (`vps({ discovery: { every } })`, default 5 minutes) and publishes `provider.machine.*`.
  `providerAccounts.machines` reads what it saw (another tenant's instance on a tenant's own account is shown
  without its id and tenant, except to the platform) and `providerAccounts.discover` runs a pass now (`wait` holds
  the answer for at most 30 s). `instances.attach` turns a running VM into an instance of a customer tenant without
  recreating it, with `onDelete: 'detach'` (default) or `'delete'`; `instances.detach` releases one, and
  `instances.reboot` restarts a provider instance (graceful, or `hard`). Ownership is re-checked on every read: a
  VM whose label is lost or foreign fails its instance (`OwnershipLost`, `AttachConflict`) and is never acted on
  again. Opt-in label-driven auto-attach (`discovery.autoAttach`): on a tenant's own account the
  `better-compute-owner` label is ignored (`AUTO_ATTACH_OWNER_IGNORED`, the configured owner gets the instance); on a
  platform account a label owner must be a member of the labelled tenant (`AUTO_ATTACH_OWNER_REFUSED` otherwise).
- **Provider reservations.** The `vps.reservations` worker detects provider capacity reservations, on-demand and
  future (`vps({ reservations: { every } })`, default 5 minutes), and publishes `provider.reservation.*`.
  `providerAccounts.reservations` lists them with `free` and `pending`; `bindReservation` turns a `ready` one into
  a flavor of a provider pool, and `unbindReservation` removes it. `instances.create` on a bound flavor takes a free
  slot under a database lock, so concurrent creates never over-commit it (`CAPACITY_UNAVAILABLE` otherwise).
- **Tenant networks.** The `networks` and `firewallRules` groups let a tenant build VPCs, subnets and firewall rules
  on a provider account that supports them; the `vps.networks` reconciler converges the provider and publishes
  `network.*`. `instances.create` takes `networkId` and `subnetId` (the network must have been provisioned, the
  subnet `ready`; `INVALID_STATE` until then), rules target instances by a per-instance network tag, and attached VMs
  are linked to the tenant network their NIC is on. Network names are unique among live networks. Every tenant's
  networks on one account share its provider project, so a tenant has at most 10 live networks, and a network at
  most 16 subnets and 100 firewall rules (`QUOTA_EXCEEDED` with `details.limit`).
- **Platform-issued compute.** The root (platform) tenant adds a provider account, offers a provider pool on it to
  customer tenants, and issues machines to them: `instances.attach` of a running VM, or `instances.create` with
  `ownerIdentityId` (new) for a new one. Only a root caller acting in another tenant names an owner other than
  itself, on `create` and `attach` alike (`ACCESS_DENIED` otherwise, before any decision), so the instance is the
  customer's: in its owner's `scope: 'mine'` list, under owner-conditioned policies, on the customer's quota. See
  the providers guide, "Platform-issued compute", for what each side can and cannot do.
- **Owner membership** (`@better-compute/core`, additive). Optional `IamPort.isMember(tenantId, identityId)`; the
  embedded better-iam bridge implements it from IAM's store (an active identity of that tenant). `instances.create`
  and `attach` ask it for an owner other than the caller, outside any transaction, and refuse a non-member with
  `INVALID_INPUT` (a refused create leaves no draft). Ports without it, the remote bridge included, check the
  identity's shape only.
- **Tenant vault paths.** `vps({ tenantVaultPaths: { [tenantId]: paths } })` lists the `vault://` paths a tenant's
  provider accounts may name (an entry ending in `/` allows every path under it).
- **Provider contract** (`@better-compute/core`, additive). Optional `ProviderImpl` members `discover`, `claim`,
  `release`, `listReservations` and `networks`; optional `ExternalMachine` detail (`zone`, shape, `labels`,
  `networks`, `reservation`, `claimedBy`, …); `create` takes an optional `network` and `labels`;
  `ProviderContext.account` (`{ id, tenantId, platform }`) tells a provider whose account it builds a client for;
  `SecretResolver.resolve` takes an optional `{ tenantId }` context; `Instance` gains `origin`, `onDelete`,
  `networkId` and `subnetId`; the `network` resource kind (a child of `compute-tenant`, with `providerAccountId`,
  `poolId` and `projectId` attributes) and IAM actions `compute:instances:attach` and `compute:networks:*`.

### Changed

- **Modules see the resolved root tenant.** `betterCompute()` resolves the root tenant from its own `rootTenantId`
  or the port's, and now hands modules a port whose `context.iam.rootTenantId` is that root, even when only
  `betterCompute({ rootTenantId })` names it. Before, such a host's root accounts were treated as a tenant's by vps
  (secret-reference scope, GCP host identity, discovery).
- **Pools hide their provider account from tenants they are offered to** (`pools.get`, `pools.list` and the view
  `pools.offer` returns). The owner still sees `providerAccountId`.
- **A provider create refused for capacity or quota ends the instance.** `CAPACITY_UNAVAILABLE` or `QUOTA_EXCEEDED`
  from `create`, or from `get` while the instance is `scheduling` or `provisioning`, now moves it to `error` with a
  `ProvisionFailed` condition and publishes `instance.failed` with that `reason`, instead of retrying forever. The
  provider is asked nothing more about it until it is deleted, `instances.start` on it is `INVALID_STATE`, and
  deleting it refunds its quota.

## 0.1.1 (2026-10-07)

Better IAM 0.3 support. Every package now accepts Better IAM `>=0.2.0 <0.4.0` (dependencies and peers), so
`npm install better-compute better-iam` resolves one Better IAM, the current 0.3.x, instead of a 0.3 umbrella beside
the 0.2 packages 0.1.0 asked for.

### Changed

- **Better IAM range.** `^0.2.0` becomes `>=0.2.0 <0.4.0` on every `@better-iam/*` and `better-iam` dependency and
  peer. The workspace builds and tests against 0.3.0 (its full suite and the IAM contract tests pass); 0.2.x keeps
  working. Better IAM 0.3's breaking changes do not touch Better Compute: it declares none of the newly reserved
  principal or resource attribute names, and its resource resolver returns no `classification`.

## 0.1.0 (2026-10-07)

The first release on npm: the umbrella package `better-compute` and 26 `@better-compute/*` packages, all at 0.1.0.
It needs Node.js 22.12 or later, PostgreSQL 16 or later (PGlite for development and tests) and Better IAM `^0.2.0`.

### Added

- **Control plane.** `betterCompute()` runs the API, gateway and worker in one process or separately. PostgreSQL is
  the source of truth: bookings are guarded by `EXCLUDE` constraints and all SQL reads one clock, `compute_now()`.
  Every mutation makes one Better IAM decision; fleet paths (heartbeats, inventory, commands) make none. Stores for
  PostgreSQL and PGlite ship in `@better-compute/postgres`.
- **Capacity and reservations** (`@better-compute/capacity`). Pools, selectors, NVLink- and NUMA-aware placement,
  quotas, previews and reservations for whole GPUs, MIG partitions and shared GPU slots. Reservations also book host
  resources (`vcpu`, `memoryGiB`, hugepages) and hand cgroup limits and a NUMA-local cpuset to the node. Usage is metered
  in hourly windows.
- **Bare metal** (`@better-compute/metal`, `@better-compute/provision`). Enroll, inspect, commission, deploy,
  release, retire and rescue workflows over BMC and PXE, driven by a workflow engine with profiles and a signed image
  catalog. A machine returns to `ready` only after an attested wipe. Also dedicated-root leases, two-phase BMC
  password rotation, and GPU health remediation within a pool's disruption budget.
- **VPS, sandboxes and volumes** (`@better-compute/vps`). Instances on your own hosts (IPAM, flavors with NUMA,
  pinning and hugepage placement) or on providers (`@better-compute/provider-hetzner`,
  `@better-compute/provider-proxmox`). Sandboxes add templates, TTLs, warm pools, snapshots and SSH exec with
  short-lived certificates. Sandbox volumes and persistent host volumes attach to instances.
- **Kubernetes workers** (`@better-compute/provider-kubernetes`). bcd runs as a DaemonSet and adopts a cluster's
  nodes and GPUs into a pool; reservations with `binding: 'kubernetes'` hand devices to the kubelet through device
  plugins or a DRA driver.
- **Gateway and protocol** (`@better-compute/gateway`, `@better-compute/protocol`). Daemon sessions over gRPC with
  mutual TLS, liveness, command dispatch, and join, renew and secret forwarding. The generated
  `bettercompute.agent.v1` wire contracts are frozen.
- **PKI and the destructive-batch quorum** (`@better-compute/pki`). Local CAs, SPIFFE node certificates, sealed join
  tokens, attestors (join token, TPM, cloud instance identity, x509 proof of possession), command signing, a sealed
  secret store and broker, and trust-root rotation. Destructive command batches can require a quorum of approvers
  (`commandBatches`, `pki.approvers`). `@better-compute/audit` adds signed Merkle checkpoints over the audit log.
- **Better IAM integration** (`@better-compute/iam`). The IAM plugin and catalog, the authorization projection, an
  embedded or remote `IamPort`, and the usage sink, on Better IAM `^0.2.0` from npm.
- **CLI** (`@better-compute/cli`, the `better-compute` command). PKI setup and certificate issuance, the bcd install
  script, capacity shortcuts, `iam setup` and release signing.
- **MCP** (`@better-compute/mcp`). Model Context Protocol tools for pools, capacity, GPU reservations, instances and
  sandboxes, gated by Better IAM with confirmations for risky actions.
- **Clients and consoles.** `@better-compute/client` is a typed, browser-safe API client with live `$watch`.
  `@better-compute/console-kit` provides framework-free view models for consoles.
- **Testing kit** (`@better-compute/testing`). Fixtures, the simulated `FakeDaemon`, a sim clock, the fleet
  simulation and conformance runners.
- **More packages.** `@better-compute/events` (signed webhooks and an SSE stream), `@better-compute/fleet` (fleet
  configuration as code), `@better-compute/observability` (Prometheus metrics), `@better-compute/rollout` (signed bcd
  releases and wave rollouts) and `@better-compute/driver-sdk` (out-of-process drivers).
- **The Go daemon bcd** (`daemon/`). The node agent is built and tested end to end against a real gateway on the
  fake-hardware build; the site and ramdisk modes are covered by Go unit tests. The release pipeline (goreleaser,
  SBOMs, cosign signatures, SLSA3 provenance) is in place, but this release publishes no bcd binaries.

### Known limitations

- **No real-hardware runs.** Everything is tested against fakes and simulations: no real server has run bcd, and the
  hardware gates (a GPU host, a KVM host, the reference benchmark machines) have not run. Local test runs and the
  benchmark numbers use PGlite rather than a PostgreSQL server.
- **bcd binaries are not released.** The install script and self-update need a published bcd, so until a release
  carries binaries, build bcd from `daemon/` with Go.
- See the [roadmap](https://better-compute.com/docs/reference/roadmap) for the state of every phase.

## Development history (pre-0.1.0)

The internal notes kept while the packages were built, before the first release. They cite sections of `PLAN.md`
and commit hashes, and are kept for reference; the 0.1.0 entry above summarizes them.

- Round 5, the complete node daemon (PLAN §3.8, v1.1):
  - Host resources on every host: `vcpu`, `memoryGiB`, `hugepages2Mi`, `hugepages1Gi` rows from inventory (`capacity.hosts`, `policy.hostReserve`). VPS hosts' memory now excludes hugepage pools.
  - Reservations take `resources` (`vcpu`, `memoryGiB`, `hugepages1Gi`) and default to the pool's per-GPU share (`policy.perGpu`, else the smallest host share). Host resources are not charged to quota. `capacity.preview` books the same.
  - `DeviceAssignment.limits` carry cgroup limits and a NUMA-local cpuset (without the host's reserved CPUs) to bcd.
  - `binding: 'kubernetes'` works on pools with `policy.kubernetes`. bcd hands those devices to the kubelet: device plugins or the DRA driver `gpu.bcd.dev` (`gpuApi`). Releasing a bound one keeps its GPUs and host share booked, and billed, until the node reports `AllocationReleased` (pods let go), a lost node, or the booking's end. The placer used to re-book them under running pods: 55/240 failed bindings in the 12-node sim. Meanwhile the reservation carries the `DevicesHeld` condition. A booking that pods still hold at its end is extended in 5-minute steps while the devices are free.
  - bcd advertises the Hello capabilities `devices.limits` and `binding.kubernetes`. Reservations that book host resources, or bind to Kubernetes, place only on nodes that advertise them. An older bcd would drop the limits or the binding.
  - Flavors take `placement` (`numaAffine`, `pinned`, `hugepages`). Hugepage guests book hugepages and are charged as `memoryGiB`. Pinned guests take isolated CPUs first. Guests that don't get their placement carry `PlacementDegraded`. Guests of pools that overcommit memory get a balloon.
  - Guests get their IPAM gateway and DNS (`setIpPool({ dns })`, `InstanceNic.gateway/nameservers`).
  - Agent memory: `sandboxVolumes`, persistent host volumes (`InstancesSection.volumes`, `InstanceSpec.volumes`). Placement takes `onlyNodes`.
  - Extension kind `pool-policy`: provision refuses host policies nodes can't take, at `pools.create`/`update`.
  - Telemetry specs carry `headersRef` and `resourceAttributes` (`nodeTelemetryModule`, `PoolPolicy.telemetry`).
  - Security:
    - `trustedProxies`: behind a load balancer, IAM sees the caller, and fails closed.
    - Hello capabilities `instance.ssh-host-only`, `instance.placement` and `instance.volumes` gate where sandboxes, placed flavors and volumes land.
    - Hosted-Kubernetes join tokens land nodes `tenant-controlled`.
    - Slots per shared GPU are capped at 48.
  - MCP `reserve_gpus` takes `vcpu`, `memoryGiB` and `kubernetes`.
  - **Breaking (IAM):** `sandboxVolumes.create` is decided on `compute-sandbox-volume/<draft id>`, whose projection carries the requested `sizeGiB`, instead of the tenant (6cb30e9). Policies that granted it on `compute-tenant` still reach it through the pool parent; policies that bound volume size now see it. `sandboxVolumes.resize` stages the new size the same way.
  - **Breaking (API):** `sandboxVolumes.list` defaults to the caller's own volumes; pass `scope: 'all'` for everyone's (77bf9f5).
  - **Breaking (metrics):** bcd's `bcd.instance.memory.balloon` is now `bcd.instance.memory.balloon.reclaimed` (9bdd43a). It reports flavor memory minus current guest memory, only for guests with a balloon. Dashboards and alerts on the old name need updating.
  - Hosted-Kubernetes bcd uses the kubelet's credentials (e7d0765; NodeRestriction confines it to its own Node), never a service account.
  - CI builds the DaemonSet image (daemon/Containerfile) and server-side dry-runs the rendered manifests on a kind cluster.

- Round 4, server/core/mcp/client:
  - Security: admissions decide on the committed row (`IamPort.refreshResource`; §12.4 "draft in memory before require" was unimplemented, so `extend` decided on stale projection rows: BoundedExtend allowed 72 h + 1 h). A node reports only its own allocations. With `pki.commandSigning`, a reservation goes active only on the node's own signed `AllocationBound` (`pkiAllocationBindingCheck`). The secret broker releases an instance's user data only when it names a secret of the instance's own tenant. Certificate roles live in the Subject OU `bc-role:<role>` (no private OIDs; Go cannot parse the 2.25 arc).
  - Envelope: async-with-wait (`MethodDefinition.poll`, `wait: { timeoutMs }`), `MethodAdmission.check` (budget checks outside transactions, no `denied`), W3C `traceparent` onto enqueued commands.
  - Server: audit sinks (`sinks.audit`, module extensions), module-listed event sinks and scheduler plugins; `sinks.usage` refused. `GET {basePath}/downloads/bcd/{version}/linux-{arch}`; `supportBundles` presigned `logs.collect` uploads; `projects.archive`, `commands.cancel`, `usage.export`; selfCheck §14 operations findings; fewer statements per join; the node pass wakes started reservations on connectivity/schedulability changes; `site` NodeSpec sections merge per field (`NodeSpecPart`); `vps-host` nodes may be declared lost.
  - Core/proto (additive): PoolPolicy runtime/singleTenant/workloadIdentity, InstanceSpec allocationId/nics, CapacityPort.reserve admission, ProviderImpl.identify, Reconciler.role, PlacementRequest.nodeLabels, SiteSpec.cacheImages; `driver.invoke` payloads, WorkloadToken frames (sealed JWE, purpose `workload-token`), StatusReport.pressure; catalog rows providerAccounts.bootstrap, workflows.pause/resume, metal.unrescue.
  - MCP: `iamConfirmations` (per-request polling), `remoteMcpIam` (the gate over HTTP IAM), reservation and instance tools. Client: `$watch`.
  - Later:
    - Sandboxes are a product feature (D24, user decision); the design is PLAN §3.7.
    - vps `instances.create` waits (`wait: { timeoutMs }`) and applies the pool's budget policy (`SPEND_LIMIT_REACHED`).
    - A node dedicated to one tenant wakes pending work (`mayBeSchedulableSql`).
    - Ramdisk certificates allow the commissioning kinds under their real names (`inventory.refresh`, `disk.wipe`, `logs.collect`); before this, commissioning could not inspect or wipe.
    - Proto `Hello.trust_version` / `StatusReport.trust_version` for the command-root switch gate.
    - `iamGuard` / `BETTER_COMPUTE_IAM_GUARD=warn|throw` reports or refuses an IamPort call made inside a compute transaction (§8.1); `computeFixture` defaults to `throw`.
    - Sandboxes seams: paused instances, `restore_from`, `instance.snapshot` messages, runtime `pause`/`resume`/`snapshot`.
    - Workload tokens are refused for suspended or deleted tenants.
    - MCP `create_instance` waits for the instance to start; MCP sandbox tools; FleetConfig `sandboxTemplates`.
    - Sandbox seams: `InstanceSpec.network_policy` (egress/private/none).
    - CI:
      - nightly workflow: simulation plus 10k cold start, the IAM-guarded suite, the whole suite on Postgres,
        and a green-night streak;
      - the bcd release pipeline: SBOMs, keyless cosign, SLSA3 provenance;
      - the API surface freeze check in `lint:repo`.
    - The §16 gateway gate is met on a workstation: 5k mTLS sessions, 0 drops, dispatch p99 26 ms.
    - v1.0 destructive-batch quorum, server side: the `quorum` module (`commandBatches` get/list/scope/approve/cancel,
      batch expiry) and `pki.approvers` in the trust bundle.
    - Quorum security review #6:
      - Leaves bind a payload digest, and BMC subjects are site-qualified.
      - Approvals sign the trust domain.
      - Tiers must be ordered.
      - The trust bundle version follows its content; `pki.trustVersion` is now a floor.
      - `pki.approvers.setSignatures` are published for the version they sign, and an unsigned quorum change is
        logged.
    - Envelope: `MethodAdmission.abandoned` cleans up after any failure following transaction 1 (not the IAM
      refusal, which runs `denied`).
    - Quorum API:
      - `commandBatches.create` (`batches:create`, idempotent), and `commands.run({ batchId })`; CommandInfo gains
        `batchId` and `awaitingApproval`.
      - Leaves may carry their payload, which approvers see in `scope`; its type must be the kind's, at most
        8 MiB per batch.
      - Batch subjects must be the tenant's own nodes.
      - MCP `propose_command_batch` (there is no approve tool).
    - The approver set has its own epoch (`pki.approvers.epoch`, TrustBundle field 8). A stale replica refuses to
      start rather than republish an old trust bundle.
    - `SiteSpec.proxy_targets` bounds `site.httpProxy` to the listed machines.
    - Rollout sends the signed release manifest with `NodeSpec.daemon` and `daemon.upgrade`, for bcd's self-update.
    - `lint:repo` checks the generated docs reference before the API freeze.
  - Tests: the §16 v0.3 MCP confirmation acceptance and §12.6 example policies end to end, §5.6 walkthrough 2 (acme-cloud), the authz matrix known-key replay step; `pnpm check` runs the remote-IAM suites, `proto-gen --check` and `buf breaking`. Tools: `scripts/private-commit.mjs` (compare-and-swap commits), `scripts/head-check.mjs` (tests the committed tree in a worktree).

- Round 4, capacity and sandboxes:
  - Capacity:
    - The pool-lease placer reads a lazy `PoolIndex`: per-class counts from `capacity_device_counts` (trigger-kept), booked devices only, and full devices and links per node on first view. It loads the index before taking the pool lock. At 10k nodes on PGlite, `placeQueued` goes from ~500 to ~1,000 placements/s and lock hold p90 from 875 to 60 ms.
    - Also: single-tenant offers, `dedicated=<tenant>` taints, node label constraints (`nodeLabels`, `'*'` any value), the MIG layout gate, attested `AllocationBound`, admit hooks for node leases, the budget admission check, reservation `operation`/`poll`, active conditions, `onPlacement` metrics, the I7 solver, fast-check planning properties, `capacityTenantDeleted`, and JSON Schemas for every method.
  - Sandboxes (§3.7, D24), a `sandboxes` + `sandboxTemplates` group on `vps()`:
    - Each sandbox drives one hosted instance: admission, placement, quota, IPAM, sealed user data, metering and deletion are the instance's. Instance item methods refuse a sandbox's instance.
    - Templates are checked against a hosted pool once. They carry TTL bounds, `warm: { min, max }`, `env` (tenant `secret://` refs written to `/etc/sandbox/env` inside broker-sealed user data) and `network` (`egress`/`private`/`none` → `InstanceSpec.networkPolicy`).
    - TTL expiry is an ordinary instance delete (`sandbox.expired`, then `deleted`). `extend` is decided with the new lifetime.
    - Warm pools: `paused` when the runtime can pause, otherwise `stopped`. A warm instance is claimed with `FOR UPDATE SKIP LOCKED` only after the create's own allow, and never from an older template shape. Warm capacity is metered as `vps.sandbox.warm` until claimed.
    - Snapshots: `sandboxes.snapshot` sends `instance.snapshot` through `vps({ snapshots: SnapshotStore })` into a tenant-private `sandbox_snapshots` table. `create({ fromSnapshot })` restores on the same runtime and `cpu.model`, and FakeHypervisor carries guest memory across.
    - Exec without an in-guest agent: tunnels' `sandboxes.exec` returns an `ssh` ticket (`act`, `inst`, `sbx`) plus a ≤15 min certificate from the `sandboxSsh` CA for `<account>@<instanceId>`, which vps renders into the guest's trust.
    - Also: `readyAt` stamped at first run, selfCheck findings, and `vps().tenantDeleted`, which deletes every instance of a deleted tenant (hosted instances' inline allocations were never released before).
    - Later the same day:
      - Guest host keys certified by the sandbox CA (exec pins guests). A sandbox never outlives its certificate: claims take only covering warm instances, warm pools recycle short ones, a fresh sandbox's expiry is capped, and restores or extends past it are refused. `sandboxes.exec` answers `hostCertificate: valid|expired|none`.
      - Secrets: templates use only secrets the tenant put, never fleet-scoped ones, and writing one decides `compute:secrets:manage`.
      - `private`/`none` networks place only on hosts whose bcd enforces them. Warm instances on a host that stops doing so are replaced, and running ones are a doctor error (`vps.sandboxes.network`).
      - §12.8 IAM reactions: `withdrawAgentSandboxes`, `reassignSandboxes` (`sandboxIamReactions` for the host) and `sandboxHolders` for the IamReconcile sweep.
      - Budgets: `extend` runs the budget check. Warm pools stop refilling on a spent budget, and a `drain` offer empties them.
      - `sandbox.expiring` (vps/0013), and `sandboxes.snapshot` is `UNSUPPORTED` up front without `RuntimeTraits.snapshot`.
  - `daemon/README.md` rewritten for the v0.1 daemon.

- Metal attestation and dedicated-root leases:
  - Security fix: a wipe or diagnostics result counts as attested only when the node signed it. The gateway stores `CommandUpdate.node_sig` (`commands.result_sig*`, `core/0012_v02_evidence`), and metal's default `nodeSignedResults()` verifies it with pki against `node_certs`. Before this, the kind's `attested` flag was trusted, so a gateway could forge a wipe. A lessee's `node-tenant` certificate never attests.
  - v0.5 `binding: 'node'` (metal side): a dedicated-root lease deploys the lessee's profile under `tenant-controlled` trust with a revoked platform identity, and marks the allocation bound. Its release runs the §13 teardown (fence, attested secure erase, DCGM, firmware baseline check with quarantine on drift, new identity generation).
  - `core/0012` also adds `node_bindings`, which `nodes.delete` and retirement clear. Provision exports `provisionedTargetResolver()` and `discoveryWorkflowNodeResolver()` for pki's attestors.
  - Two-phase BMC password rotation (`metal.rotateBmcCredential`, `bmc_credential_versions`): the password is generated and sealed, sent as refs only, and becomes current only on a site-signed login check. The old password stays current on failure. The tenant-root teardown rotates, and a failed rotation quarantines the machine.
  - The ramdisk's discovery token is single-use and MAC-bound. It reaches the site agent only as `ProxyDhcpEntry.discovery_token_ref`, and `boot.cleanUp` deletes it.
  - Firmware drift can be reflashed from the pool's baseline images (`policy.firmwareRemediation: 'reflash'`) before quarantine.
  - `tests/metal-capacity-lease.test.ts` runs capacity and metal together for `binding: 'node'`. The dev fleet gains `joinSite()` for site agents, and FakeDaemon signs attested results.
- v0.2 server groups and schema:
  - `joinRequests` list/approve/reject: the approval queue behind deferred joins (`discovery`, placeholder DMI). Decisions are idempotent, and an approval admits one join (the retry with the recorded CSR consumes it in the join transaction).
  - `siteTokens` create/revoke (role `site`), and the SiteBoot lease `site:<id>:boot`: one connected site agent holds it, and the standby is promoted only after it expires, under a new epoch.
  - `secrets` put/delete: write-only and sealed in the SecretStore, with a version per put. Events and audit rows carry only ref, name and version.
  - Also: `drivers.list`; `sites.update`/`sites.delete` (tombstoned once referenced); `nodes.delete` (retired or never-adopted nodes only; capacity rows released in lock order, certs revoked, hardware key freed, tombstone).
  - `core/0010_v02_server`: `join_requests`, `node_certs.allowed_kinds`, `nodes.deleted_at`, `secret_refs`.
  - `core/0011_v02_security`: `sites.deleted_at`, `attestation_uses` + `pruneAttestationUses`.
  - PGlite now runs `ANALYZE` after migrations and periodically, so dev and sim plans match Postgres.
- v0.2/v0.3 metal walkthroughs, chaos and runtime schema:
  - Talos (§5.6 #3): agentless `agent: 'none'` pools run out-of-band profiles. `httpViaSite` reaches a machine's API through its site agent (`site.httpProxy`), and it refuses before sending any command: other hosts, names, plain http off the provisioning network, redirects, oversize responses, and secret headers passed as values.
  - Ubuntu autoinstall (§5.6 #1): a third-party plugin renders a per-node ISO with a single-use `provisioned` token, and `media.insert` takes `fromStep`. The §16 v0.2 acceptance runs in sim form: 20 unattended enroll → ready → deployed → released → ready loops, and every `ready` follows a verified wipe.
  - `tests/metal-chaos.test.ts`: a worker or site agent dies mid-deploy, and no destructive command is sent twice.
  - `core/0009_runtime`: `outbox_cursors`, `work_queue.attempts`, `commands.owner`, tenant indexes, and retention via `pruneBehindCursors`, which deletes only rows every cursor has passed.
- v0.1 W5a server runtime: `betterCompute()` now runs the control plane. Table leases with epoch fencing (§8.5), the coalescing work queue, 256 sharded reconcilers with rendezvous assignment plus `Reconciler.periodic` keys and deterministic `compute.jobs.*.tick()`, module `start`/`stop`, the command queue (protobuf `CommandBody`, per-node `seq`, idempotency keys, cancel), `CommandSweeper`, the xmin-ordered outbox with sinks and `compute.events.subscribe`, the authz projection writer, and a DB-anchored clock with `ClockSkew`. The envelope runs request-as-resource admission (drafts, idempotent replay, delegated `CONFIRMATION_REQUIRED`), 30 s authentication and 10 s read-decision caches (`compute.caches`), and the list recipe. v0.1 groups: projects, sites, joinTokens, nodes, commands, usage, events. JoinService admits nodes through `@better-compute/pki` (sealed tokens, `hardware_key` from inventory, signed `JoinResponse`, Renew with proof of possession) behind `gatewayServices`; the NodeLifecycle, NodeSpec, Liveness and drain controllers; `capacityModule` is built in and backs `ctx.capacity`; `gatewayReportHandlers` for `createGateway({ reports })`. `tests/server-spine-v01.test.ts` runs join → adopt → reserve → bind → liveness end to end with zero IAM calls on fleet paths; the generated authz matrix covers all 42 v0.1 rows.
- v0.1 W3a capacity: `@better-compute/capacity`. Selectors (`matchExpressions` + CLI shorthand), schedulability with its SQL twin, the placement pipeline (filters, NVLink/NUMA-aware atom pick, `binpack`/`topology`/`fragmentation`/`spread` scorers, top-N pick) and the savepoint-guarded `inlinePlacer` (≤3 replans, then `pending`); all-or-nothing quotas; release/extend decided by the `EXCLUDE` constraint; rollups (deltas + rebuild); `capacity/0001_device_links` + `syncDeviceLinks`. `capacityModule` serves `pools`, `capacity` (summary, byPool, preview, timeline), `reservations` (admission drafts, placement in tx 2, lifecycle reconciler with bind-timeout retries, leases, `maxPending`, delegated confirmation) and `quotas`; `markAllocationBound/Failed/Released` for the gateway; `capacity.usage` writes hourly `usage_windows` (`gpu.<model>.hours`, reserved time from active, D14). The torture exit test (1,000 ops, every §10.4 invariant) fixed a quota/rollup lock-order deadlock.
- v0.3 VPS: `vps()` serves `instances` (admission drafts; hosted pools placed through capacity with IPAM leases and converged from `reportInstances`; provider pools driven through `ProviderImpl` outside transactions; lost-host recreate), `flavors` and `providerAccounts` (manifest-validated, SecretRef-only credentials); `NodeSpec.instances`; `vps.usage` meters vCPU/memory/GPU hours; `providerConformanceCases()`; a 200-instance churn test proves no leaks.
- v0.3 `@better-compute/provider-hetzner` (outside the umbrella): `hetznerCloud` (label-idempotent create, paginated offers with prices and availability, power/rebuild/list, rate-limit mapping) and `hetznerRobotProvider` (claims unnamed servers instead of ordering, resets, rescue, installimage bootstrap delivering the join token over SSH stdin only); both pass provider conformance against API emulators.
- v0.2 Health and remediation: `device_health` quarantines (`core/0007_device_health`) take one GPU out of placement without blocking its node. XID policies (48 quarantine, 63 drain+reset, 64 RMA, 79/95 drain+reboot) and inventory health findings (row remap, uncorrectable ECC, degraded NVLink) feed `recordXid`/`applyInventory`. The provision `health` reconciler runs `remediate-reboot`/`remediate-gpu-reset` after the node drains, within the pool's disruption budget (`policy.disruptionBudget`, default 5%), and stops for a pool with >10% unhealthy nodes in 10 min (circuit breaker); a failed, cancelled or exhausted remediation escalates to maintenance. v0.5 fractional GPUs (inventory side): `gpu.slot` atoms `<uuid>/s<k>` for timeslice/MPS pools, `partitionPending` freezes a GPU during a MIG mode change, and `gpuAtomFamily` feeds the atom rule. `userdata.render` renders cloud-init with a single-use `provisioned` token into a secret, which metal's deploy sends as `userDataRef`. Metal command payloads are now the proto3 JSON of each kind's message.
- v0.2 metal: `metal()` serves the `metal` group. `enroll` keeps inline BMC credentials only as a secret reference, and driver bindings are inherited from the pool's hardware profile. The `metal` reconciler runs each provision state's workflow (`metal-enroll`, `metal-inspect`, `metal-commission`, the tenant's deploy profile, `metal-release`, `metal-retire`, `metal-rescue`) and applies `complete`/`fail`. A release returns to `ready` only after an attested wipe. Control-plane steps relay BMC and boot work to the site agent and disk, diagnostics and image work to the ramdisk; `boot.kexec` completes on rejoin. There are site and ramdisk command kinds, and `metal/0001_nodes`.
- v0.2 provision additions: the image catalog and `images` group (`provision/0002_images`: digest plus Ed25519/P-256 signatures against signer allowlists, unsigned images private, platform-signed ramdisks, promotion with a wildcard authz row, site caches with LRU eviction). Also site-step routing to the boot-lease holder, workflow `owner` wake-ups and profile snapshots (`provision/0003_workflow_owner`), `awaitCommand` for relaying steps, `defineStep({ relays })` and `provisionModule({ modules })`. Migrations `core/0005_audit_commit_order` and `core/0006_pool_archive`.
- v0.2 provision: the workflow engine. `provisionModule({ steps, profiles })` owns `provision/0001_workflows` (`profiles`, `workflows`, `workflow_steps`, with one active workflow and one in-flight step per node), the `workflow` reconciler (sharded by node) and `workflowEngine(ctx)` for `ctx.workflows`. Profiles expand into persisted steps: registered steps, or driver operations sent as one `driver.invoke` command, plus `fallback:`, acceptance, on-failure and cleanup steps. Control-plane steps run between transactions (`stepNotReady` polls), agent steps are exactly one command (`wf:<id>:<step>`, `#<attempt>` on retry), and `await: 'rejoin'` completes on a new boot or role and fails only on timeout. Also `timeout`, `retries`, `onFailure`, `when:`, abort (cleanup still runs), pause/resume and retry-from-step, the built-in `wait.agentJoined` / `wait.generationObserved`, and the `profiles` and `workflows` API groups.
- v0.1 W3b inventory and store: section verification over received bytes, snapshot digests, diffs, devices and MIG atoms, `gpuLinks`, GFD labels, `GpuCountMismatch` / `GpuModelUnknown` / `DuplicateIdentity`, `hardware_key` (with `hardwareKeyFromClaims` for join), `recordInventoryHashes` / `ingestInventorySection` for the gateway, `applyInventory` + `inventoryReconciler`, and `inventory.get`. Migrations `core/0003_v01` (v0.1 columns, `node_inventory`, `node_inventory_sections`) and `core/0004_command_cancel`. The outbox conformance reader orders by `outbox.txid`, not its text alias.
- v0.2 PKI (ready for the server to wire): `localSealedSecretStore` over `sealed_secrets` (`pki/0001_sealed_secrets`, AES-256-GCM with ref+tenant AAD, key rotation via `reseal`), the `SecretRequest`/`SecretResponse` broker crypto with node signatures checked against `node_certs`, a command-signing root with 24 h worker keys and `signCommand`/`verifyCommand`/`signDesiredState`/`verifyDesiredState`, trust-root rotation, and `verifyAttestedUpdate`/`verifyAttestedReport`. Also: PKI bundles sealed under the deployment secret, `agentIdentityFromChain`, the agent-side join/renew helpers, `doctor` PKI findings, the capacity CLI shortcuts and `iam setup`.
- v0.1 W5c CLI: `pki init` (root + node/serving/internal CAs + JoinService keys, sealed under `BETTER_COMPUTE_SECRET`, optional `--offline-root`), `pki show` (bcd pins from the public half), `pki issue-gateway` (30-day serving certs, atomic replace), and `daemon install-script` (POSIX sh: token from `BCD_JOIN_TOKEN`/stdin only, pinned sha256 download, 0600 `config.toml` in bcd's TOML subset, hardened `bcd.service`, in-place upgrade without a token). The CLI framework routes two-word commands and `help <group>`.
- v0.1 W2 PKI: `@better-compute/pki`. Local root, node, serving and internal CAs with per-kind issuance policy (SPIFFE URI SAN + role extension, ≤ 24 h node certs, ≤ 2 h ramdisk), a strict DER/X.509/PKCS#10 layer on `node:crypto`, chain verification, join tokens (`issueJoinToken`, `verifyJoinToken`, `joinTokenAttestor` on `join_tokens` at `compute_now()`), sealed tokens bound to the join CSR (JWE `ECDH-ES+A256KW`/`A256GCM`), signed `JoinResponse` and `SignedTrustBundle`, `verifyRenewPop` with a malleability-proof replay cache, and a `RevocationSet`. `hardware_key` stays in `inventory`, the single source. Tests include a mutual-TLS handshake and the RFC 7518/3394 vectors.
- P0 scaffold: a pnpm workspace mirroring better-iam's, with the packages, contracts, repository rules and CI that v0.1 builds on. Plan `PLAN.md`; guide `docs/development.md`.
  - Packages `@better-compute/core`, `protocol`, `inventory`, `provision`, `metal`, `vps`, `postgres`, `server`, `client`, `cli` and `testing`, and the umbrella `better-compute` with subpaths `./core`, `./protocol`, `./inventory`, `./provision`, `./metal`, `./vps`, `./server`, `./postgres`, `./pglite`, `./client`, `./cli`, `./testing` and bin `better-compute`. `inventory`, `provision`, `metal` and `vps` are stubs: they export the frozen contract types, and their factories throw `NOT_IMPLEMENTED` naming the phase that implements them.
  - better-iam 0.1.0 is vendored as 23 tarballs in `vendor/better-iam` and pinned through `pnpm-workspace.yaml` `overrides` (`scripts/sync-better-iam.mjs`, `pnpm sync:iam`).
  - Repository rules under `pnpm lint:repo` (part of `pnpm check`): `scripts/check-deps.mjs` (server never imports injected modules, `gateway`, `iam`, `postgres`, providers or drivers; core's root entry imports no Node.js built-in; workspace dependencies match tsconfig references; nothing imports a `provider-*`), `scripts/check-sql-now.mjs` (SQL reads time only through `compute_now()`) and `scripts/umbrella.mjs --check` (the umbrella is generated from `packages/better-compute/umbrella.json`; `pnpm umbrella` rewrites it).
  - Packaging, ported from better-iam: `validate:packages` (Apache-2.0, `publishConfig.access`, `repository.directory`, `{ types, import }` exports whose files exist, publint, one version), `pack:all`, `check:packed-types` (`attw --profile esm-only`), `test:packed` (a fresh consumer installs every tarball with the vendored better-iam, imports `better-compute`, `/inventory`, `/provision`, `/metal`, `/vps`, `/pglite` and `/client`, and runs `better-compute --help`) and `scripts/release-version.mjs`.
  - CI: `.github/workflows/ci.yml` (Ubuntu and Windows × Node 22 and 24: `pnpm check`, `pnpm proto:check`, `buf breaking`, pack, attw, packed smoke; a `postgres:17` job for `pnpm test:postgres`; npm publishing that waits until better-iam is on npm) and `.github/workflows/daemon.yml` (`go vet`, `go test -tags nonvml,fakehw ./...`, `goreleaser check`).
  - `bench/REFERENCE.md` defines the reference hardware for the v0.1 gateway, IAM-lane and placement benchmarks.
