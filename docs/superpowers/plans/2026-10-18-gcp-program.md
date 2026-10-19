# Google Cloud: full-platform integration — Program Plan

> **For agentic workers:** this is a **program** plan: it fixes scope, architecture, contracts, order and exit
> criteria for every Google Cloud workstream. Each workstream is executed from **its own task-level plan**
> (`docs/superpowers/plans/2026-10-18-gcp-ws<N>-<slug>.md`), written just before the workstream starts so that it
> argues from the code as it is then. WS0 and WS1 already have task-level plans. Use
> superpowers:subagent-driven-development or superpowers:executing-plans on those, never on this file.

**Goal:** Every Google Cloud service that can be a **capacity source**, a **provisioning or network primitive for that
capacity**, an **implementation of a port better-compute already defines**, or a **signal that sharpens capacity
truth** is integrated. Every other service gets an explicit, reasoned "out" (§3). The result: a tenant can onboard a
GCP project with no service-account keys and run GPU, TPU, spot, flex-start and bare-metal capacity on it, with
volumes, images, private networking and console access, priced and quota-aware. The platform itself can also run on
Google Cloud end to end (GKE, Cloud SQL, Secret Manager, Cloud KMS, CA Service, Pub/Sub, Cloud Logging, Cloud
Monitoring).

**Architecture:** One shared, dependency-free foundation package (`@better-compute/gcp-common`: token sources,
workload-identity federation, REST client, error mapping, pagination, long-running operations, universe domains).
Two consumers build on it: `provider-gcp`, which grows from Compute Engine VMs into the full capacity surface, and a
new `@better-compute/gcp-platform`, which holds the port adapters. bcd gains a GCE cloud module (identity and
maintenance or preemption notices). `deploy/gcp/` holds the reference deployment. Every new seam in core is an
**additive optional member** (§5), and nothing in `packages/` imports a provider.

**Tech Stack:** TypeScript (ESM, Node ≥ 22.12), plain `fetch` against Google REST APIs (no `googleapis` or
`@google-cloud/*` SDKs), `node:crypto` for JWT/JWS, Go 1.27 for bcd, vitest on PGlite with in-memory Google API fakes,
Terraform for `deploy/gcp`.

**Spec:** No separate spec. The requirements are the user's request of 2026-10-18 ("integrate all services of GCP",
plan only), plus the GCE plan already executed (`2026-10-17-gcp-attach-reservations-networks.md`) and
PLAN.md §1 (goals, non-goals, principles P1–P15), which this program must not violate.

---

## 1. Starting point (verified 2026-10-18 against the tree)

**Already in place:**

- **`@better-compute/provider-gcp` 0.2.0** (2,601 lines, capabilities `power list discover claim reservations
  networks`):
  - Compute Engine VMs as offers and instances, GPU machine types, Hyperdisk or PD boot-disk selection, and gVNIC.
  - Attach and detach with ownership labels, discovery, and on-demand plus future reservations as bindable
    capacity.
  - Tenant VPCs, subnets and firewall rules, and `ssh-keys` metadata.
  - Token sources: an SA key with a pinned `token_uri`, the metadata server, impersonation, or a host-supplied
    source. Ambient credentials serve platform accounts only (ruling F1).
- **`cloud-iid` attestor** in `packages/pki/src/attestors/cloud-iid.ts`, with a `gcpInstanceIdentity` verifier
  (audience bound to the CSR hash). There is **no Go producer and no production `resolve`** yet (follow-up from
  the GCE plan).
- **`provider-kubernetes`** (hosted mode: bcd as a DaemonSet in an existing cluster). It is not GKE-aware.
- **Ports with no GCP implementation:** `SecretStore` (only `localSealedSecretStore`), `BlobStore`,
  `CertificateAuthority` (only local CAs), `ImageSource`, `Notifier`, event, audit and usage sinks, and OTLP
  export (observability).
- **`postgres({ pool })`** already accepts an app-owned `pg.Pool`. Cloud SQL IAM authentication therefore needs
  no code, only documentation (§6, WS11).
- **Work in flight:** `packages/provider-gcp/src/compute.ts`, `tests/provider-gcp.test.ts` and
  `tests/support/gce-emulator.ts` have uncommitted edits from another session. Every workstream that touches
  them starts only after that session's commit lands (§9, one writer per file).

**Missing for "all services":** keyless tenant onboarding, spot and flex-start, TPUs, bare-metal shapes, bcd on
GCE, volumes, snapshots and images, NAT, static IPs and DNS, console access, prices, quotas, org-scale discovery
and change feeds, and every platform port.

## 2. Integration principles (apply to every workstream)

| # | Rule | Why |
|---|---|---|
| G1 | **The scope filter.** A service is integrated only when it is (a) a capacity source, (b) a provisioning or network primitive *for that capacity*, (c) an implementation of an existing better-compute port, or (d) a signal that makes capacity truth fresher or cheaper. Everything else is "out" with a written reason. | PLAN.md non-goals: no workload orchestrator, no telemetry storage, no own invoices. "All of GCP" must not turn into a cloud console clone. |
| G2 | **REST over `fetch`, no Google SDKs.** Every call goes through `gcp-common`'s client. | Matches D2 of the GCE plan and `provider-hetzner`. The coordination rules forbid new dependencies without the orchestrator, and the SDKs pull in gRPC and protobuf trees. |
| G3 | **Pin what we use.** Each service's request and response fields are pinned in `tests/support/gcp/discovery/<service>.json` (the used subset of its discovery document). A nightly test diffs the pins against the live discovery documents. | Google's APIs evolve weekly. Drift should fail a nightly run, not production. |
| G4 | **Pokes, never truth.** Pub/Sub, Eventarc and audit-log feeds only `enqueue` a reconcile. Polling stays and keeps converging if every feed is dropped. | P1, P2. |
| G5 | **The database referees.** Every new scarce GCP resource (quota, reservation slot, TPU queued resource, static IP) is admitted under a row lock or an `EXCLUDE`/unique constraint, never by "GCP will refuse". GCP's refusal is the second line of defence. | P4. Already the pattern for reservation admission. |
| G6 | **Ownership by label, refusal by default.** Anything better-compute creates carries `better-compute-*` labels (or name prefix `bc-` where labels don't exist). Destructive calls refuse resources without the right label (`INVALID_STATE`). | Extends GCE plan D4 to disks, images, addresses, routers, DNS records and TPUs. |
| G7 | **Tenant isolation first.** A tenant account never acts with platform identity (F1), never names another tenant's secret, and never reaches a project it did not prove control of (WS1's negative probe). Each workstream ends with a security review against §8. | The three security findings on the GCE branch (C1, I3, I5) were all isolation bugs. |
| G8 | **No provider calls in transactions. Long operations are polled across reconciler runs** (`enqueue … { notBefore }`), never awaited past `claimTtlMs`. | Existing reconciler contract. |
| G9 | **Least privilege, documented per capability.** Every workstream adds its exact predefined roles (or custom-role permission lists) to the provider README's IAM table, and `doctor` checks them with `testIamPermissions`. | Operators can't grant what isn't written down. Org security teams demand permission lists, not `roles/editor`. |
| G10 | **Universe-domain clean.** No hard-coded `googleapis.com`. Endpoints come from `googleEndpoint(service, universe)`. | Sovereign clouds (Google's Trusted Partner Cloud universes) differ only by domain. It is cheap to get right on day one and expensive to retrofit. |

## 3. Service catalog and disposition

Legend:

| Code | Meaning |
|---|---|
| **P** | `provider-gcp` capability |
| **A** | port adapter in `gcp-platform` |
| **D** | bcd (Go) |
| **S** | signal or feed |
| **H** | the platform runs on it (`deploy/gcp`) |
| **X** | out of scope (reason given) |
| ✓ | done today |

### Compute

| Service | Disp. | WS | What exactly |
|---|---|---|---|
| Compute Engine VMs (general, compute-, memory-optimized) | P ✓ | WS2 | Done. Adds confidential, shielded and local-SSD options, and placement policies. |
| GPU machine types (A2, A3, A3 Mega, Edge and Ultra, A4, A4X, G2, G4) | P ✓ | WS4 | Done for shapes. Adds multi-NIC GPUDirect networking, compact placement and topology hints. |
| Spot VMs / preemptible | P | WS2 | `provisioningModel: SPOT` and `instanceTerminationAction`. The preemption notice flows into an `ExternalMachine.upcoming` condition. |
| Flex-start VMs (Dynamic Workload Scheduler) | P | WS2 | `provisioningModel: FLEX_START`, `maxRunDuration`, and queued until capacity. Maps to a `pending` machine with a reason. |
| On-demand reservations | P ✓ | WS2 | Detection and binding are done. Adds operator-driven create, resize and delete of reservations. |
| Future reservations (incl. calendar mode) | P ✓ | WS2 | Detection is done. Adds requesting calendar-mode blocks (`reservationMode: CALENDAR`) as a horizon reservation. |
| Sole-tenant nodes | P | WS2 | Node groups as a dedicated-host pool option (`nodeAffinities`). Lower priority. |
| Bare-metal instances (C3, C4, X4, Z3 `-metal`) | P+D | WS2/WS3 | Machine shapes plus `agent:'bcd'` join. No nested virt is needed: bcd owns the machine as metal. |
| Confidential VMs (SEV-SNP, TDX), Shielded VM | P+D | WS2/WS3 | Create options. bcd adds a vTPM / shielded-identity attestor path (reuses the `tpm` attestor). |
| Cloud TPU (TPU VMs, queued resources, multislice) | P | WS4 | TPU v5e, v5p, v6e and later as offers. A `QueuedResource` is a pending machine. Accelerator kind `tpu`. |
| Managed instance groups, instance templates | X | — | better-compute's reconciler *is* the group manager. Two controllers fighting over size is a bug factory. Exception: DWS resize requests are reachable through flex-start VMs, so MIG resize requests are not needed. Revisit if Google gates a GPU family behind MIGs only. |
| Batch | X | — | A workload orchestrator (PLAN.md non-goal). |
| VM Manager / OS Config | X | — | Host configuration is provision's job (config units). |
| Custom images, machine images | P | WS5 | Image import (`gs://` → image), image families, and vps snapshots → images. Machine images: export and backup only. |
| Persistent Disk, Hyperdisk (balanced, throughput, extreme, ML), Hyperdisk storage pools | P | WS5 | Volumes for provider instances. Hyperdisk ML read-only multi-attach for model weights. Storage pools are later. |
| Local SSD | P | WS2 | A shape option, and an `ephemeral` disk in inventory. |
| Snapshots, snapshot schedules | P | WS5 | `volumes.snapshot` on provider pools. Schedules: X (the operator's own policy). |
| Recommender (idle VM, rightsizing) | S | WS7 | Read-only advisories on instances (`conditions`). |
| Migrate to VMs, VMware Engine, Bare Metal Solution | X | — | Separate hybrid products with their own contracts. Bare Metal Solution may become a `metal` provider later; that needs its own spec. |

### Containers and serverless

| Service | Disp. | WS | What exactly |
|---|---|---|---|
| GKE Standard | P+D | WS12 | Clusters and node pools as hosted-mode capacity (bcd DaemonSet via `provider-kubernetes`). GKE's own GPU device plugin must be disabled (GPU isolation). |
| GKE Autopilot | H / X | WS11 | Hosts the control plane's `api` and `worker`. Not a capacity source, because it forbids privileged DaemonSets. |
| Cloud Run | H (partial) / X | WS11 | It can host `api` (stateless HTTP). It cannot host `gateway` (long-lived gRPC bidi streams, L4 TLS passthrough). Not a capacity source. |
| Artifact Registry | A+H | WS9 | OCI image-source auth (access tokens for `oci://…-docker.pkg.dev`), and hosts bcd images. |
| Cloud Build, Cloud Deploy, Binary Authorization | X | — | CI/CD is the operator's. |
| Cloud Functions, App Engine, Workflows, Cloud Scheduler, Cloud Tasks | X | — | The control plane has its own work queue, leases and reconcilers (P1). |

### Storage and databases

| Service | Disp. | WS | What exactly |
|---|---|---|---|
| Cloud Storage | A+P | WS9/WS5 | `BlobStore` (V4 signed URLs, also keyless via `signBlob`), the `gs://` `ImageSource`, and the image-import staging bucket. |
| Filestore, Parallelstore, Managed Lustre | X (later) | — | Shared filesystems for GPU clusters are a real ask, but better-compute has no shared-volume model yet (PLAN.md non-goal "volumes … beyond"). Candidate for a future spec. |
| Backup and DR, Storage Transfer | X | — | Operator tooling. |
| Cloud SQL for PostgreSQL | H | WS11 | Primary store, with IAM database auth through `postgres({ pool })`. HA and PITR are documented. |
| AlloyDB | H | WS11 | Supported store after the `btree_gist` / `EXCLUDE` check runs in CI. |
| Spanner, Firestore, Bigtable, Memorystore | X | — | Postgres is the truth (P1) and needs `EXCLUDE` and `SKIP LOCKED`. Memorystore as a `Notifier` loses to Pub/Sub (fewer moving parts). |

### Networking

| Service | Disp. | WS | What exactly |
|---|---|---|---|
| VPC networks, subnets, VPC firewall rules | P ✓ | — | Done. |
| Network firewall policies (global and regional) | P | WS6 | An alternative backend for `firewallRules`, for orgs whose hierarchical policies forbid legacy rules. |
| Cloud Router + Cloud NAT | P | WS6 | Egress for VMs without external IPs, per tenant network and region. |
| Static external and internal IP addresses | P | WS6 | An `addresses` resource bound to instances. |
| Cloud DNS | P | WS6 | A private or public zone per tenant network, and A records per instance. |
| Cloud Load Balancing (passthrough NLB) | P (later) / H | WS6/WS11 | Exposes instance ports (later). The **gateway tier needs an L4 TLS-passthrough LB** (H). |
| VPC peering, Shared VPC | P | WS6 | Attach tenant VMs into a tenant-owned host project (Shared VPC service project), and peer with the tenant's VPC. |
| Private Service Connect | H | WS11 | Private access to the control plane API from tenant VPCs. |
| Identity-Aware Proxy TCP forwarding | P | WS6 | Console and SSH for `agent:'none'` VMs without public IPs (`ProviderImpl.access.openTunnel`). |
| Serial console | P | WS6 | `getSerialPortOutput` for boot logs, and interactive serial behind exec tickets. |
| OS Login | P | WS6 | When the org enforces `compute.requireOsLogin`, `ssh-keys` metadata is ignored. Keys go through OS Login POSIX accounts for the instance's SA instead. |
| Cloud Armor, Cloud CDN, Network Intelligence Center, Service Directory, Cloud VPN, Interconnect, Network Connectivity Center | X | — | Edge and hybrid connectivity are the operator's. Hybrid site connectivity is documented in WS11 as a deployment topology. |

### Security and identity

| Service | Disp. | WS | What exactly |
|---|---|---|---|
| IAM (roles, `testIamPermissions`) | P | WS1/WS11 | Permission preflight for each account's capabilities, and `doctor` findings. |
| IAM Credentials (impersonation, `signBlob`, `signJwt`) | P ✓ | WS1/WS9 | Done for impersonation. Delegation chains and keyless signing are added. |
| Workload Identity Federation + STS | P | **WS1** | Keyless tenant accounts with better-compute as an OIDC issuer. |
| Secret Manager | A | WS9 | `SecretStore` on scheme `gsm://`. Tenant scoping is enforced as for `secret://`. |
| Cloud KMS / Cloud HSM | A | WS9 | KEK for `localSealedSecretStore`'s sealing key, and signing keys (`asymmetricSign`) for the CAs and the workload issuer. |
| Certificate Authority Service | A | WS9 | A `CertificateAuthority` for the node client CA and the gateway serving CA (`certificates.create` from a CSR). |
| Organization Policy | S | WS11 | Preflight reads effective constraints (`disableServiceAccountKeyCreation`, `requireOsLogin`, `vmExternalIpAccess`, `resourceLocations`, `restrictNonCmekServices`, `requireShieldedVm`) and adapts or warns. |
| VPC Service Controls | H | WS11 | A documented perimeter for the control plane's project. Providers surface `VPC_SERVICE_CONTROLS` errors distinctly. |
| CMEK on disks and images | P | WS5 | `diskEncryptionKey.kmsKeyName` per account or flavor. Required under `restrictNonCmekServices`. |
| Security Command Center, Access Context Manager, Confidential Space, Identity Platform, reCAPTCHA | X | — | better-iam is the IdP. Security posture tooling is the operator's. |
| Certificate Manager | H | WS11 | TLS for the API load balancer (not the gateways, which pin their own serving CA). |

### Operations

| Service | Disp. | WS | What exactly |
|---|---|---|---|
| Cloud Monitoring, Cloud Trace (OTLP) | A+H | WS10 | OTLP export to `telemetry.googleapis.com` with a token-source auth header. No new storage (P8). |
| Managed Service for Prometheus | H | WS10 | Scrapes the control plane and bcd metrics on GKE (`PodMonitoring`). |
| Cloud Logging | A+H | WS9/WS10 | `AuditSink` (`entries:write`, log `better-compute-audit`), structured stdout format (`severity`, `logging.googleapis.com/trace`), and Error Reporting through it. |
| Cloud Audit Logs (GCE admin activity) | S | WS8 | Out-of-band changes to managed VMs, via a log sink to Pub/Sub, become pokes. |
| Ops Agent, Cloud Profiler | X | — | bcd does node telemetry (P8). |

### Management, billing and events

| Service | Disp. | WS | What exactly |
|---|---|---|---|
| Resource Manager (projects, folders, org) | S | WS8 | Discovery scope across folders. **Project factory: X**: landing zones and per-tenant projects stay in the host app (GCE plan D1). |
| Cloud Asset Inventory | S | WS8 | `searchAllResources` for org-scale discovery, plus asset feeds (Pub/Sub) as pokes. |
| Service Usage | P | WS11 | Preflight checks that the needed APIs are enabled. A `SERVICE_DISABLED` error carries the activation URL. |
| Cloud Quotas API | P | WS7 | Quota per region and family becomes `Offer.availableCount` and an admission preflight. Quota increase *requests* are an operator method. |
| Cloud Billing Catalog API / Pricing API | P | WS7 | List prices (on-demand, spot, CUD) become `Offer.pricePerHour`. Account-specific prices are optional. |
| Billing export (BigQuery) | S (opt.) | WS7 | A reconciliation report: what GCP charged vs. what better-compute metered, per instance label. Read-only. |
| Budgets | X | — | Spend limits live in better-iam (`SPEND_LIMIT_REACHED`). |
| Pub/Sub | A+S | WS9/WS8 | `Notifier`, `EventSink`, and the transport for feeds. |
| Eventarc | X | — | Pub/Sub directly is one fewer hop. Eventarc adds nothing for a fetch-based consumer. |
| Infrastructure Manager / Terraform | H | WS11 | `deploy/gcp/terraform` module. Deployment Manager: X (deprecated). |
| Marketplace | X (later) | — | Distribution, not integration. |

### Data, AI and the rest

| Service | Disp. | Reason |
|---|---|---|
| BigQuery | S (opt.) | Only as the billing-export source (WS7). Audit export goes through Cloud Logging sinks, operator-configured. |
| Vertex AI (training, prediction, Workbench), Gemini API, Agent Builder | X | Workload orchestrators and model APIs. better-compute books the capacity they would run on. Vertex reservations are GCE reservations and are covered by WS2. |
| Dataflow, Dataproc, Composer, Datastream, Data Fusion, Looker, Dataplex, Pub/Sub Lite | X | Not capacity. |
| Google Distributed Cloud, Anthos, Workstations, Cloud Shell, Source Repositories, Apigee, Maps, Workspace | X | Not capacity, or deprecated. |

## 4. Target architecture

```
                                   @better-compute/core   (additive optional members only, §5)
                                           ▲
                 ┌─────────────────────────┴───────────────────────────┐
     @better-compute/gcp-common  (NEW, WS0)                             │
     auth: SA key · metadata · impersonation (+delegates) · STS/WIF     │
     http: googleClient · mapGoogleError · paginate · longRunning       │
     endpoints: googleEndpoint(service, universe) · tokenEndpoint pin   │
           ▲                                     ▲                      │
           │                                     │                      │
 @better-compute/provider-gcp            @better-compute/gcp-platform (NEW, WS9)
  compute.ts (VMs, spot, flex)            ./secrets   gsmSecretStore
  tpu.ts (WS4)  volumes.ts images.ts      ./kms       kmsSealingKey, kmsSigningKey
  (WS5)  networks*.ts access.ts (WS6)     ./cas       casCertificateAuthority
  pricing.ts quotas.ts (WS7)              ./storage   gcsBlobStore, gcsImageSource
  feeds.ts (WS8)  gke.ts (WS12)           ./pubsub    pubsubNotifier, pubsubEventSink
  federation account checks (WS1)         ./logging   cloudLoggingAuditSink
           │                              ./registry  artifactRegistryImageSource
           ▼ (installed by apps; never imported in packages/)
     vps (accounts, reconcilers, admission, tables)        pki: workloadIssuer (WS1), cloud-iid resolve (WS3)
     server: /.well-known/better-compute/workload/{openid-configuration,jwks} (WS1)
     bcd (Go): internal/cloud/gcp — identity token producer, maintenance/preemption watch (WS3)
     deploy/gcp: terraform module, GKE manifests, Cloud SQL, LB, PSC (WS11)
```

**Dependency rules (enforced by `scripts/check-deps.mjs` as it stands):**

- `gcp-common` depends on `core` only.
- `provider-gcp` depends on `core`, `vps` and `gcp-common`.
- `gcp-platform` depends on `core`, `gcp-common` and (for the KMS signer) `pki`.
- None of the three is in the umbrella.
- Nothing in `packages/` imports `provider-gcp`. `gcp-common` is not a `provider-*`, so sharing it is legal.

**Why a shared foundation and not "copy auth into each package":**

- The token-source code is security-critical: the `token_uri` pin (7243aef6) and the F1 ambient refusal.
- WS1 adds a fourth path (STS federation).
- Three copies would drift on exactly the lines a review hardened.

## 5. Core additions (all additive, optional; each needs the orchestrator's OK per `.claude/coordination.md`)

| # | Member | Shape | WS |
|---|---|---|---|
| C1 | `WorkloadIssuerPort`, `PkiPort.workload?`, `ProviderContext.identity?` | The issuer port (`issuer`, `mint`, `jwks`), which pki implements and server publishes. Each provider client gets `identity: { subject, mint({ audience, ttlSeconds? }), mintProbe('sibling' \| 'stranger', { audience }) }`. vps fixes `subject = compute-account:<tenantId>/<provider>/<name>`, so a provider can never choose it. Present only when the host configures an issuer. | WS1 |
| C2 | `ProviderInput.checkAccount?`, `ProviderInput.accountKey?` | `checkAccount(config, context)`: network checks run in `admission.check` (no transaction open) at `providerAccounts.create`/`update`. It throws `INVALID_CONFIG` with `details.reason`. `accountKey(config)` is a pure exclusive key (the federation audience), unique per provider across all tenants. | WS1 |
| C3 | `Offer` fields | `provisioning?: 'standard' \| 'spot' \| 'flex-start'`; `accelerator?: { kind: 'gpu' \| 'tpu'; model: string; count: number; topology?: string }`; `availableCount?: number`; `maxRunSeconds?: number`. | WS2/4/7 |
| C4 | `ExternalMachine` fields | `provisioning?` (as C3); `upcoming?: { kind: 'maintenance' \| 'preemption' \| 'termination'; at?: number }`; `pendingReason?: string`. | WS2/3 |
| C5 | `ProviderImpl.volumes?` | `ProviderVolumes { ensureDisk, deleteDisk, attach, detach, snapshot, deleteSnapshot }`. Non-blocking `ensure*`, like `ProviderNetworks`. | WS5 |
| C6 | `ProviderImpl.images?` | `ProviderImages { importImage, getImage, deleteImage }`. Non-blocking. | WS5 |
| C7 | `ProviderImpl.access?` | `ProviderAccess { setSshKeys?, serialOutput?, openTunnel?(id, target: TunnelTarget): Promise<DuplexStream> }`. | WS6 |
| C8 | `ProviderNetworks` extras | `ensureRouterNat?`, `deleteRouterNat?`, `ensureAddress?`, `deleteAddress?`, `ensureDnsRecord?`, `deleteDnsRecord?`, `ensurePeering?`. All optional. | WS6 |
| C9 | `ProviderImpl.quotas?` | `(context) => Promise<{ region: string; metric: string; limit: number; usage: number }[]>`. | WS7 |
| C10 | `ProviderImpl.decodeChange?` | `(body: unknown, context) => { machineIds: string[] } \| undefined`. vps's feed endpoint turns a verified push into reconcile pokes. | WS8 |

Each is landed by the first workstream that needs it, in one commit that touches only
`packages/core/src/extension.ts` (plus `vps` conformance cases for it).

## 6. Workstreams

Each entry gives: the outcome, the GCP APIs, the IAM roles, the better-compute seams, new state, the tests that
prove it (exit criteria), dependencies and a size. Sizes count task-level-plan tasks.

### WS0 — Foundation: `@better-compute/gcp-common` — *task plan written*

- **Outcome:** shared auth, an HTTP client, error mapping, pagination, LROs and universe domains. `provider-gcp`
  re-exports its moved token sources unchanged, so no public API changes.
- **APIs:** OAuth token, metadata server, IAM Credentials (moved). The google.rpc.Status error model
  (`ErrorInfo`, `RetryInfo`, `Help`).
- **Exit:**
  - `tests/gcp-common-http.test.ts` and `tests/gcp-common-auth.test.ts` pass.
  - The existing `tests/provider-gcp*.test.ts`, `gcp-*.test.ts` and `vps-*` GCP suites pass unchanged.
  - `check-deps` is green.
- **Depends:** the in-flight `provider-gcp` session commits first. **Size:** 4 tasks.
- **Plan:** `2026-10-18-gcp-ws0-foundation.md`.

### WS1 — Keyless tenant accounts (Workload Identity Federation) — *task plan written*

- **Outcome:** a tenant onboards a GCP project with **no service-account key**. better-compute is an OIDC issuer.
  The tenant creates a workload identity pool provider that trusts it, with the attribute condition
  `assertion.sub == "compute-account:<tenantId>/gcp/<name>"`, and optionally lets the federated principal
  impersonate an SA. The tenant knows the subject *before* creating the account (`providerAccounts.federationSetup`),
  which avoids the chicken-and-egg of an id-based subject.
- **Confused-deputy defences (all three required):**
  1. A per-account `sub`, fixed by vps.
  2. A unique index on the federation audience across all accounts (`accountKey`).
  3. **Two negative probes** at create and update, which must both be refused by STS before the account is
     stored. The `stranger` probe uses another tenant with the same name. The `sibling` probe uses the same
     tenant with another name. Each looks like a real account subject, so any prefix condition is caught. A
     provider that accepts either is `INVALID_CONFIG` (`reason: 'federationTrustsAnySubject'`).
- **APIs:** STS `v1/token` (token exchange), IAM Credentials `generateAccessToken`.
- **Tenant-side setup (documented):**
  - `iam.workloadIdentityPools.create` and `providers.create`, with the issuer URL or an uploaded `jwksJson`.
  - `roles/iam.workloadIdentityUser` for the federated principal on the SA, or direct resource access for the
    `principal://` identity.
- **Seams:** C1, C2; `pki` `workloadIssuer`; two `GET` routes in `server/src/http.ts`; the `federation` field in
  `gcpConfig`.
- **Exit:** `tests/gcp-federation.test.ts` and `tests/vps-account-federation.test.ts` pass, including:
  - `a tenant account with federation and no key creates a VM`;
  - `refuses a provider that trusts any account subject`;
  - `refuses a provider that trusts every account of the tenant`;
  - `refuses a second account with the same audience`;
  - `identity mints only the account's subject`.
- **Depends:** WS0. **Size:** 7 tasks. **Security review gate:** yes (identity).
- **Doctor.** A periodic re-probe in `doctor` is a WS11 preflight item, not WS1.
- **Plan:** `2026-10-18-gcp-ws1-keyless-federation.md`.

### WS2 — Compute depth: spot, flex-start, reservations as a product, VM options

- **Outcome:**
  - **Spot and flex-start offers.** Separate offers (`zone/type~spot`, `zone/type~flex`) carry
    `provisioning`.
  - **Preemption.** A preempted spot VM moves the instance to `stopped` (termination action `STOP`) or `lost`
    (`DELETE`). The condition is `Preempted`, the event is `instance.preempted`, and the instance is never
    silently recreated.
  - **Flex-start.** A flex-start VM is `pending` with `pendingReason: 'queued'` until GCE provisions it, and ends
    at `maxRunDuration` with the condition `RunDurationReached`.
  - **Reservation operator methods.** `providerAccounts.createReservation | resizeReservation |
    deleteReservation` (operator only), and calendar-mode future-reservation requests.
  - **Create options on flavors:**
    - confidential computing type, shielded VM and secure boot;
    - local SSD count;
    - placement policy (compact, for GPU gangs);
    - sole-tenant node affinity;
    - CMEK key (with WS5).
  - **Bare-metal shapes.** `-metal` machine types as offers with `kind: 'metal'`, only on `agent:'bcd'` pools
    (WS3).
- **APIs:**
  - `instances.insert` (`scheduling.provisioningModel`, `instanceTerminationAction`, `maxRunDuration`,
    `onHostMaintenance`);
  - `reservations.insert`, `resize` and `delete`; `futureReservations.insert`;
  - `resourcePolicies.insert` (group placement); `nodeGroups` (read, affinity only).
- **Roles:** `compute.instanceAdmin.v1`. Reservation methods add `compute.admin`, or a custom role with
  `compute.reservations.*` and `compute.futureReservations.*`.
- **Seams:** C3, C4; vps flavors gain an `options` object validated by the provider (`checkFlavor?`, landed with
  C3 if needed); events `instance.preempted`; migration `vps/00NN_flavor_options`.
- **Exit tests:**
  - `a spot offer creates a SPOT VM with the flavor's termination action`;
  - `a preempted spot VM stops the instance with Preempted, never recreated`;
  - `a flex-start VM is pending queued, then running`;
  - `compact placement is created once per gang and reused`;
  - `an operator creates, resizes and deletes a reservation; a tenant cannot`;
  - `a metal shape is offered only to agent:'bcd' pools`.
- **Depends:** WS0. **Size:** ~9 tasks.

### WS3 — bcd on GCE: full nodes, elastic capacity, maintenance signals

- **Outcome:** GCE VMs on `agent:'bcd'` provider pools join as real nodes (NVML inventory, MIG, gang placement):
  - **Join.** bcd fetches a metadata identity token with
    `audience=<cloudIidAudience(aud, sha256(csr))>&format=full` and joins via `cloud-iid`. The production
    `resolve` maps `(project, instanceId)` to the account, the pool and the instance row that created it, and
    admits each instance once.
  - **Elastic capacity.** A GPU `reservations.create` on a GCP-backed pool with `elastic: true` spins up a VM
    (from a bound reservation, spot or flex-start), waits for the join, then books it. This is the GCE plan's
    deferred "elastic capacity".
  - **Maintenance and preemption notices.** bcd long-polls `instance/maintenance-event` and `instance/preempted`
    (metadata `?wait_for_change=true`) and reports node conditions `UpcomingMaintenance` and `Preempting`. The
    placer filters such nodes for new bookings, and holders get an event with the notice time (P6: a notice
    never releases a booking by itself).
  - **Shielded and confidential VMs.** The vTPM endorsement key from `getShieldedInstanceIdentity` feeds the
    `tpm` attestor for re-joins.
- **APIs:** the metadata server, `instances.getShieldedInstanceIdentity`, and GCE APIs already in use.
- **Seams:**
  - `daemon/internal/cloud/gcp` (new);
  - the `cloudIid.resolve` host wiring (pki + vps);
  - `ProviderImpl.bootstrap` for GCE: a startup script that fetches bcd by sha256. The join token is never in
    metadata, because cloud-iid replaces it;
  - capacity `elastic` reservations (capacity owner's sign-off).
- **Exit tests:**
  - Go `TestGcpIdentityTokenAudienceBindsCsr` and `TestMaintenanceEventBecomesCondition`;
  - TS `a GCE VM created for an elastic reservation joins via cloud-iid and is booked`;
  - `a second join with the same instance identity is refused`;
  - `UpcomingMaintenance nodes are filtered for new placements, existing bookings kept`;
  - a WSL e2e recipe as in `daemon-w1-status`.
- **Depends:** WS0, WS2 (provisioning models). **Size:** ~10 tasks (Go 4, TS 6). **Security review gate:** yes
  (join path).

### WS4 — Accelerators: TPU and GPU-cluster networking

- **Outcome:**
  - **TPUs.**
    - TPU offers come from `acceleratorTypes` per zone and are listed with `accelerator.kind: 'tpu'` and a
      topology.
    - `create` on a TPU offer makes a TPU VM (`nodes.create`), or a `QueuedResource` for spot, flex-start or
      reserved capacity. A queued resource is `pending` with `pendingReason` until `ACTIVE`.
    - A multi-host TPU slice is one instance with N addresses.
    - On `agent:'bcd'` pools, bcd inventories TPU chips as device class `tpu` (`/dev/accel*`, `/dev/vfio`), so
      capacity atoms work unchanged.
  - **GPU clusters.**
    - **Multi-NIC networking.** A3 Mega, Ultra and A4 get the GPUDirect-TCPX(O)/RDMA networks: N extra VPCs with
      MTU 8244. These are created once per tenant network as "accelerator networks" through `networks` extras.
    - **Gangs.** Compact placement (from WS2) is applied to every member of a gang reservation.
    - **Shape normalization.** H100, H200, B200 and GB200 shapes are normalized into `gpu-models.json`.
- **APIs:** Cloud TPU `v2` (`nodes`, `queuedResources`, `acceleratorTypes`, `runtimeVersions`), and Compute
  networks with `networkProfile` (RDMA).
- **Roles:** `roles/tpu.admin` (or `tpu.nodes.*` and `tpu.queuedResources.*`), `compute.networkAdmin`.
- **Seams:** C3 `accelerator`; new `tpu.ts` in `provider-gcp`; inventory device class `tpu` (inventory and bcd
  owners); `gpu-models.json`.
- **Exit tests:**
  - `TPU offers list v5e/v6e types with topology`;
  - `a spot TPU create goes through a queued resource and is pending until ACTIVE`;
  - `deleting a TPU instance deletes its queued resource`;
  - `an A3 Ultra gang gets RDMA networks and one compact placement`;
  - bcd `TestTpuInventoryReportsChips`.
- **Depends:** WS0, WS2. **Size:** ~9 tasks.

### WS5 — Storage: volumes, snapshots, images, CMEK

- **Outcome:**
  - **Volumes.** The existing `volumes.*` API works on provider pools. A volume is a PD or Hyperdisk created in
    the instance's zone. `attach` and `detach` are non-blocking. Hyperdisk ML volumes can attach read-only to
    many instances.
  - **Snapshots.** `snapshots.*` on provider instances makes a GCE snapshot.
  - **Images.**
    - `images.import` (`gs://` tarball or raw → GCE image) and image families.
    - A provider instance can boot from a better-compute catalog image: the image is imported once per account
      and cached by sha256 label.
  - **CMEK.** Each account or flavor names a `kmsKeyName`, used on boot disks, volumes, snapshots and images.
- **APIs:** `disks.*`, `instances.attachDisk` and `detachDisk`, `snapshots.*`, `images.insert` (from
  `rawDisk.source` in GCS), Cloud Storage object read for staging.
- **Roles:** `compute.storageAdmin`. For CMEK, the Compute Engine service agent needs
  `roles/cloudkms.cryptoKeyEncrypterDecrypter`.
- **Seams:** C5, C6; vps volume and snapshot reconcilers get a provider branch (vps owner); a provider image
  cache table `provider_images(account_id, sha256, image, state)`.
- **Exit tests:**
  - `a volume on a provider instance becomes an attached GCE disk`;
  - `detach then delete is ordered and survives resourceInUseByAnotherResource`;
  - `a catalog image is imported once per account and reused`;
  - `CMEK names the key on every disk`;
  - `volume quota is admitted in the database before the disk exists`.
- **Depends:** WS0. **Size:** ~10 tasks.

### WS6 — Networking depth and access

- **Outcome:**
  - **Egress and addressing.** A Cloud Router + NAT per tenant network and region (`networks.update { nat: true
    }`), and static addresses (`addresses.*`: reserve, attach, detach, release).
  - **DNS.** A Cloud DNS private zone per tenant network, and records per instance (`<instance>.<network>.internal`
    or a tenant-supplied domain).
  - **Firewall backend.** Network firewall policies as an alternate backend (an account option).
  - **Shared VPC and peering.** Shared VPC service-project attach: instances on a tenant's host-project subnet,
    with the subnet-level `compute.networkUser` checked up front. VPC peering to a tenant VPC.
  - **Access:**
    - `instances.console` for provider instances: serial output (read) and interactive serial (exec tickets).
    - SSH through IAP TCP forwarding for VMs without public IPs (`openTunnel`).
    - OS Login when the org enforces it.
- **APIs:**
  - Compute `routers`, `addresses`, `networkFirewallPolicies`, `networks.addPeering`, `getSerialPortOutput`;
  - Cloud DNS `v1`;
  - IAP TCP tunnel (WebSocket `tunnel.cloudproxy.app`, `relay.tunnel.cloudproxy.app` subprotocol);
  - OS Login `v1`.
- **Roles:** `compute.networkAdmin`, `compute.securityAdmin`, `dns.admin`,
  `iap.tunnelResourceAccessor`, `compute.osAdminLogin`.
- **Seams:** C7, C8; new vps groups `addresses` (resource kind `network`, under the existing network authz
  parent); tunnel plumbing through the existing tunnel tickets (gateway owner).
- **Exit tests:**
  - `NAT is created once per network and region and deleted last`;
  - `an address is reserved, attached and released, never double-bound`;
  - `instance A records follow the instance's address`;
  - `a serial console session needs an exec ticket`;
  - `an IAP tunnel carries SSH bytes both ways in the fake`;
  - `with requireOsLogin enforced, keys go through OS Login`.
- **Depends:** WS0. **Size:** ~11 tasks. **Security review gate:** yes (access).

### WS7 — Commercials: prices, quotas, recommendations, reconciliation

- **Outcome:**
  - **Prices.** `Offer.pricePerHour` and `currency` come from the Cloud Billing Catalog for Compute Engine (CPU,
    RAM, GPU and local-SSD SKUs by region, with on-demand and spot usage types).
    - Optional account-specific prices (Pricing API with a billing account) reflect CUDs and negotiated rates.
    - The cache refreshes daily (a `vps.pricing` periodic reconciler).
  - **Quotas.**
    - Per-region quotas (CPUs, per-family CPUs, per-model GPUs, preemptible GPUs, TPU cores) set
      `Offer.availableCount`.
    - Admission takes a quota row lock, like reservations (G5), and refuses with `QUOTA_EXCEEDED` before calling
      GCE.
    - Operator method `providerAccounts.requestQuota` (Cloud Quotas `QuotaPreference`).
  - **Advisories.** Recommender idle-VM and rightsizing recommendations become instance advisories.
  - **Reconciliation (optional).** A reconciliation job reads the billing export from BigQuery and reports drift
    per `better-compute-instance` label.
- **APIs:**
  - `cloudbilling.googleapis.com/v1/services/{compute service id}/skus` (and the Pricing API `v1beta`);
  - `cloudquotas.googleapis.com/v1` (`quotaInfos`, `quotaPreferences`), plus Compute `regions.get` quotas as a
    fallback;
  - `recommender.googleapis.com/v1`;
  - BigQuery `jobs.query`.
- **Roles:**
  - `cloudquotas.viewer`, `cloudquotas.admin` (requests only);
  - `recommender.computeViewer`;
  - `billing.viewer` on the billing account (account prices);
  - `bigquery.dataViewer` + `bigquery.jobUser` (reconciliation).
- **Seams:** C3 `availableCount`, C9; tables `provider_prices`, `provider_quotas`; capacity offers show prices
  (admin panel capacity module, owner [f906ff]).
- **Exit tests:**
  - `an A3 offer is priced from GPU + CPU + RAM SKUs of its region`;
  - `a spot offer uses the spot usage type`;
  - `admission refuses past the quota's free count without calling GCE`;
  - `quota usage refreshes after a create`;
  - `an unpriceable shape has no price, never a wrong one`.
- **Depends:** WS0, WS2 (spot). **Size:** ~8 tasks.

### WS8 — Org-scale discovery and change feeds

- **Outcome:**
  - **Discovery at org scale.** Platform accounts can scope discovery to a folder or the whole organization
    through Cloud Asset Inventory (`searchAllResources`, type `compute.googleapis.com/Instance`, label filter)
    instead of per-zone list calls. That is one paginated stream for thousands of projects.
  - **Change feeds.** An optional push feed (`vps.feeds` endpoint, a verified Pub/Sub push with an OIDC token)
    turns GCE audit-log entries and asset feed events into reconcile pokes for the named machines. Polling
    intervals can then be lengthened safely (G4).
- **APIs:** `cloudasset.googleapis.com/v1` (`searchAllResources`, `feeds`), Logging sinks (documented, set up by
  the operator or Terraform), Pub/Sub push with OIDC.
- **Roles:** `cloudasset.viewer` at org or folder, plus Pub/Sub push auth.
- **Seams:**
  - C10;
  - one public `POST` route (verified push JWT, `aud` pinned), which needs the server owner's sign-off;
  - `discover` gains a scope (`config.discoveryScope: { folder? | organization? }`), **platform accounts only**
    (G7).
- **Exit tests:**
  - `org-scope discovery pages 10k instances across projects`;
  - `a tenant account cannot set an org scope`;
  - `a push with a bad or foreign OIDC token is refused`;
  - `a verified push for a managed VM enqueues exactly that instance`;
  - `dropping every push still converges by polling`.
- **Depends:** WS0. **Size:** ~7 tasks.

### WS9 — Platform ports on Google Cloud: `@better-compute/gcp-platform`

- **Outcome:** each port gets a GCP implementation, behind its own subpath export:
  - **`gsmSecretStore`** (`gsm://<tenant>/<id>`):
    - Secrets are named `bc-<tenant>-<id>` with labels `better-compute-tenant`.
    - `resolve` accesses `versions/latest`.
    - Tenant scoping is exactly as for `secret://`.
    - Write-only API semantics are kept.
  - **`kmsSealingKey`:** KEK-wraps `localSealedSecretStore`'s data key through `encrypt` and `decrypt`.
  - **`kmsSigningKey`:** a `SigningKey` whose `sign` calls `asymmetricSign` (EC_SIGN_P256_SHA256, optionally HSM).
    It is used for the command-signing root, the audit checkpoint key and the WS1 workload issuer.
  - **`casCertificateAuthority`:** `sign(csr, profile)` → `certificates.create` with a pool-specific template that
    pins the URI SANs and usages. `revoke` → `certificates.revoke`.
  - **`gcsBlobStore`:** JSON API with V4 `presign`, signed with an SA key or keyless via `iamcredentials.signBlob`.
  - **`gcsImageSource`** (`gs://`) and **`artifactRegistryImageSource`** (OCI with an access token).
  - **`pubsubNotifier`:** publish, plus a subscription pull loop, best effort (P1).
  - **`pubsubEventSink`:** ordering key = tenant, message attributes = event type, at-least-once with event ids.
  - **`cloudLoggingAuditSink`:** `entries:write` batches, `logName better-compute-audit`, with the audit record's
    Merkle leaf hash as a label so the chain stays verifiable.
- **Roles (per adapter, in the README):**
  - `secretmanager.admin` (scoped by IAM condition on the name prefix);
  - `cloudkms.signerVerifier`, `cloudkms.cryptoKeyEncrypterDecrypter`;
  - `privateca.certificateRequester`;
  - `storage.objectAdmin` on the bucket;
  - `pubsub.publisher` and `pubsub.subscriber`;
  - `logging.logWriter`.
- **Exit:** each adapter passes the port's conformance cases where they exist (`SecretStore`, `BlobStore`, `CertificateAuthority`; add `notifierConformanceCases` and `sinkConformanceCases` to `core/conformance` if missing) against `tests/support/gcp/*` fakes, plus `a tenant cannot resolve another tenant's gsm ref`, `a KMS-signed command verifies with the published root`, `CAS issues a node cert whose SANs the template pins`.
- **Depends:** WS0 (and WS1 for keyless `signBlob`). **Size:** ~10 tasks. **Security review gate:** yes (keys).

### WS10 — Observability on Google Cloud

- **Outcome:**
  - **Export.** The observability package's OTLP exporter can target `telemetry.googleapis.com` with
    `Authorization` from a `TokenSource` and the `x-goog-user-project` header. Metrics and traces land in Cloud
    Monitoring and Cloud Trace.
  - **Logs.** A `googleCloudLogFormat` logger emits `severity`, `message`, `logging.googleapis.com/trace` and
    `spanId` from `traceparent`.
  - **Metrics on GKE.** `PodMonitoring` manifests for Managed Prometheus scrape the control plane and bcd.
  - **Dashboards.** Dashboards and alert policies as JSON in `deploy/gcp/monitoring/`, built from
    `packages/observability/src/catalog.ts`.
- **Seams:** an exporter auth hook in observability (owner sign-off); bounded cardinality (P12) is unchanged.
- **Exit tests:**
  - `OTLP export to the Google endpoint carries a bearer and the quota project`;
  - `the GCL formatter maps levels and trace ids`;
  - `dashboards reference only catalogued metrics` (a lint test).
- **Depends:** WS0. **Size:** ~5 tasks.

### WS11 — Running better-compute on Google Cloud (`deploy/gcp`)

- **Outcome:** a reference architecture plus a Terraform module.
- **GKE Standard regional cluster:**
  - Deployments `api` and `worker`, and `gateway` behind a **passthrough Network Load Balancer** (L4, TLS
    passthrough, as the gateway tier requires).
  - Workload Identity for pods.
  - The `api` HTTP behind an external Application LB with Certificate Manager, and optionally Cloud Armor (the
    operator's).
- **Data and dependencies:**
  - Cloud SQL Postgres (HA, PITR, private IP) with **IAM database auth** through `postgres({ pool })` and an async
    `password` that returns an access token. PgBouncer as a sidecar or Managed Connection Pooling.
  - Secret Manager, KMS and CAS from WS9; Pub/Sub; Private Service Connect for tenant access.
  - A bcd binary bucket.
- **Preflight (`doctor` / `selfCheck` findings, a `gcp-platform` export used by the CLI):**
  - APIs are enabled (Service Usage).
  - Permissions are present (`testIamPermissions`).
  - Org-policy constraints: SA keys disabled ⇒ require WS1 federation; `requireOsLogin` ⇒ WS6 OS Login;
    `vmExternalIpAccess` ⇒ NAT required; `resourceLocations` ⇒ zone filtering; `restrictNonCmekServices` ⇒ CMEK
    required.
- **AlloyDB.** A CI job runs the Postgres conformance suite against AlloyDB Omni (container) to certify `EXCLUDE`
  and `btree_gist`.
- **Exit:**
  - `terraform validate` and `tflint` in CI;
  - `tests/gcp-preflight.test.ts` (each org-policy constraint gives the documented finding);
  - a live smoke `tests/live/gcp-deploy.smoke.ts` (gated, §7).
- **Depends:** WS9, WS10. **Size:** ~8 tasks.

### WS12 — GKE as a capacity source

- **Outcome:**
  - **Listing.** Platform and tenant accounts list GKE clusters and node pools (`container.googleapis.com/v1`).
  - **Enrollment.** An operator enrolls a cluster: better-compute creates the pool, the hosted-mode join token
    and the Kubernetes Secret, and renders `bcdDaemonSetManifests`. A `kubectl apply` equivalent runs over the
    cluster endpoint with a short-lived token, never a stored kubeconfig.
  - **GPU isolation preflight.** GPU node pools must be created with `gpuDriverInstallationConfig` set to
    install drivers while GKE's device plugin is disabled, or enrollment refuses with the documented reason.
  - **Elastic node pools (later).** A node pool resize could serve elastic reservations (the same pattern as
    WS3).
- **APIs:** GKE `v1` (`clusters`, `nodePools`), and the Kubernetes API with a GKE-issued token.
- **Roles:** `container.clusterViewer`, plus `container.developer` for the namespace apply.
- **Seams:** `provider-kubernetes` (render) plus a new `gke.ts` in `provider-gcp`; no core change.
- **Exit tests:**
  - `enrolling a cluster creates a pool, a token secret and the DaemonSet`;
  - `a GPU node pool with GKE's device plugin enabled is refused`;
  - `the join token is revoked after every node joined`.
- **Depends:** WS0, WS3 (node pool join is the hosted-mode path). **Size:** ~6 tasks.

### Cross-cutting (folded into each workstream, never a separate "docs WS")

Every workstream also delivers:

- **Reference docs.** `apps/docs/descriptions/api/<group>.md` for each method it changes, and a regenerate via
  `node scripts/head-check.mjs --run apps/docs/scripts/sync-from-head.mjs .`.
- **README.** The `provider-gcp` README's IAM table, plus each `gcp-platform` subpath's section.
- **Guides.** `apps/docs/content/docs/guides/vps/providers.mdx` (a GCP section per capability).
- **Changelog.** A `CHANGELOG.md` entry.
- **Catalog rows.** `apiSurface` rows and events-catalog rows.
- **Clients.** The CLI and MCP get new methods for free from the typed API. An admin panel view is done only when
  the admin owners ([71c0e4] / [f906ff] / [561b07]) accept it.

## 7. Testing strategy

1. **Fakes, not mocks.**
   - `tests/support/gcp/fake-google.ts` (WS0) is a route-table fake behind `fetch`. It checks bearer tokens,
     speaks the google.rpc.Status error model, simulates LROs with a clock, and records requests.
   - Each service gets a fake module (`sts.ts`, `secretmanager.ts`, `kms.ts`, `storage.ts`, `pubsub.ts`,
     `logging.ts`, `billing.ts`, `quotas.ts`, `asset.ts`, `tpu.ts`, `gke.ts`).
   - The existing `gce-emulator.ts` stays as is. It is migrated onto `fake-google` only after its in-flight edits
     land.
2. **Pinned discovery subsets (G3).**
   - Each fake validates request bodies against `tests/support/gcp/discovery/<service>.json`.
   - `tests/nightly/gcp-discovery-drift.test.ts` (runs under `vitest.nightly.config.ts`) fetches
     `https://<service>.googleapis.com/$discovery/rest?version=<v>` and fails if any pinned method, path or field
     is gone or changed type.
3. **Conformance.**
   - `providerConformanceCases()` must stay green on every `provider-gcp` change.
   - The `SecretStore`, `BlobStore` and `CertificateAuthority` conformance suites run against each WS9 adapter.
4. **Failure injection.** Each fake can inject:
   - 429 with `RetryInfo`;
   - 503;
   - `resourceNotReady`;
   - an LRO that fails after acceptance;
   - `SERVICE_DISABLED` with an activation URL;
   - `VPC_SERVICE_CONTROLS`;
   - an STS `invalid_grant`.

   Tests assert the exact `ComputeError` code and `details.reason`.
5. **Scale.** Discovery, asset search, quotas and prices are tested at 10k items across pages, with an assertion
   on the request count (G8 budget).
6. **Live smoke (gated).**
   - `tests/live/gcp-*.smoke.ts` run only with `BETTER_COMPUTE_GCP_LIVE_PROJECT` and
     `BETTER_COMPUTE_GCP_LIVE_BUDGET_USD`.
   - Every resource gets the label `better-compute-test-run=<runId>`.
   - A `finally` sweeper deletes by label, and the run aborts if the Billing Catalog estimate of its plan exceeds
     the budget.
   - These never run in default CI.
7. **Security tests are named after the threat.** Each §8 row has at least one test whose name states the attack
   and the refusal.

## 8. Security model (threats this program adds, and the refusal for each)

| Threat | Refusal | WS |
|---|---|---|
| Tenant B names tenant A's federation audience and acts in A's project | A per-account `sub` fixed by vps, a unique audience index, and the stranger and sibling probes | WS1 |
| A tenant names the platform's project with ambient credentials | F1 (done). Federation never falls back to ambient | WS0/WS1 |
| A tenant key's `token_uri` steers the signed JWT (SSRF) | The pin (done). WS0 keeps it bit-for-bit, and extends it per *host-configured* universe only, never from the key | WS0 |
| A tenant widens discovery to the org or folder scope | `discoveryScope` is accepted on platform accounts only | WS8 |
| A forged Pub/Sub push triggers reconciles or leaks timing | OIDC token verified (Google JWKS, `aud` pinned, `email` = configured push SA). A push only *pokes* | WS8 |
| Volume or image cross-tenant reuse through the image cache | The cache is keyed by `(account_id, sha256)`, never shared across accounts. Images carry the account label | WS5 |
| An address or DNS record hijacked by another tenant's instance | Each resource is owned by a network that is owned by a tenant. Record targets resolve through instance ownership (like I3) | WS6 |
| Serial or IAP access without an exec ticket | Tunnels only through daemon-style exec tickets. IAP permission sits on the platform SA, never the tenant | WS6 |
| A KMS or CAS key used for two jobs | One key per purpose (PLAN.md "no key does two jobs"). A config refuses a reused key name | WS9 |
| Secret Manager names leak tenant ids | Names use `bc-<sha256(tenant)[0:16]>-<id>`, not raw tenant ids. Labels too | WS9 |
| Billing export reveals other tenants' costs | The reconciliation report is operator-only (`compute:providerAccounts:read` on platform accounts) | WS7 |

## 9. Sequencing, lanes and milestones

```
WS0 ──┬── WS1 ─────────────────────────────────────────────┐ M1 Keyless
      ├── WS2 ──┬── WS4 ─────────────┐                     │
      │         └── WS7 ──────────── M2 Priced & elastic-ready
      │         └── WS3 ──┬── WS12 ── M3 Full nodes (GCE, TPU, GKE)
      ├── WS5 ──────────── M4 Stateful & reachable
      ├── WS6 ────────────┘
      ├── WS8 ──────────── M6 Org scale
      └── WS9 ── WS10 ── WS11 ── M5 Runs on Google Cloud
```

**One writer per file.** `provider-gcp/src/compute.ts` is touched by WS2, WS4, WS5, WS6 and WS7. Each of them
puts new behavior in its own file (`spot.ts`, `tpu.ts`, `volumes.ts`, `access.ts`, `pricing.ts`) and edits
`compute.ts` only for a small dispatch hook, in strict order: WS2 → WS7 → WS4 → WS5 → WS6. Lanes that never
touch it run in parallel: WS1, WS8, WS9 → WS10 → WS11, and WS3's Go half.

| Milestone | Workstreams | Demo that proves it |
|---|---|---|
| **M1 Keyless** | WS0, WS1 | A tenant in an org with `iam.disableServiceAccountKeyCreation` onboards a project and creates and attaches VMs. The negative probe refuses a misconfigured provider. |
| **M2 Priced** | WS2, WS7 | Offers list on-demand, spot and flex-start prices. Admission refuses past quota without a GCE call. A preempted spot VM shows `Preempted`. |
| **M3 Full nodes** | WS3, WS4, WS12 | An elastic GPU reservation spins up an A3 VM that joins over cloud-iid, gets booked, and shows `UpcomingMaintenance`. A TPU v6e queued resource goes `ACTIVE`. A GKE GPU pool is enrolled. |
| **M4 Stateful & reachable** | WS5, WS6 | A volume and snapshot on a provider instance. A catalog image is imported once. A NAT-only VM is reached over IAP SSH. Serial console works behind a ticket. |
| **M5 Runs on GCP** | WS9, WS10, WS11 | `terraform apply` brings the control plane up on GKE + Cloud SQL (IAM auth) + Secret Manager + KMS + CAS + Pub/Sub, with telemetry in Cloud Monitoring. `doctor` is clean. |
| **M6 Org scale** | WS8 | Org-scope discovery over thousands of projects within the poll budget. Audit-log pushes poke reconciles in seconds. |

## 10. Decisions needed (defaults apply if unanswered, as for D1–D20)

| # | Question | Default |
|---|---|---|
| GD1 | Keyless mechanism: WIF with better-compute as OIDC issuer, **or** per-tenant broker SAs that tenants grant `serviceAccountTokenCreator` to? | **WIF.** Confused-deputy-safe by construction, and no SA-per-tenant quota (100 SAs per project by default) to manage. Broker SAs stay a documented fallback. |
| GD2 | Issuer publication: a public `/.well-known/…/jwks` URL, or tenants upload `jwksJson` to their provider? | **Both.** Public URL by default. Inline JWKS for control planes not reachable from Google, with key rotation announced 30 days ahead (the next key published beside the current one). |
| GD3 | Keep SA-key accounts? | **Yes.** `doctor` warns, and orgs that disable keys use WIF. |
| GD4 | Spot termination action default | **`STOP`** (the disk survives and a restart is cheap). A flavor can choose `DELETE`. |
| GD5 | TPU representation | A new `Offer.accelerator` (C3) and device class `tpu`. `gpus` is not overloaded. |
| GD6 | Pub/Sub feeds | Optional pokes. Polling remains the truth. |
| GD7 | Price source | Public list prices by default, with an optional billing account for account prices. Currency as the API returns it (no FX). |
| GD8 | Project factory | Stays in the host app (legionedge), per GCE plan D1. |
| GD9 | `gcp-platform` packaging | One package with subpath exports per adapter. |
| GD10 | MIG support | Out (§3). Revisit only if a GPU or TPU family becomes MIG-only. |

## 11. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Google API drift (fields renamed, versions retired) | High over a year | G3 pins plus the nightly drift test. Versions are named in one place per service. |
| Rate limits at org scale (per-project read quotas, Asset API quotas) | Medium | Asset search instead of fan-out (WS8). A per-project token bucket in `googleClient` (option `rate`). Reconciler backoff on `RATE_LIMITED`. |
| GPU and TPU stockouts make demos flaky | High | Live smoke uses CPU shapes and spot. GPU and TPU paths are proven against fakes plus one scheduled manual run. |
| Concurrent sessions editing `provider-gcp` | High | §9 file order. Coordination claims before each WS. Commits via `scripts/private-commit.mjs`. |
| Live-test cost runaway | Medium | Budget gate, label sweeper, CPU-only default. |
| An IAP tunnel protocol change (undocumented WebSocket) | Medium | Behind `ProviderImpl.access.openTunnel`, with a fallback to public-IP SSH. Covered by the nightly live smoke. |
| A security regression in identity paths | Medium, high impact | A review gate on WS1, WS3, WS6 and WS9. Threat-named tests (§7.7). |

## 12. Coordination

Before each workstream:

1. **Claim the area.** Add a claim line to `.claude/coordination.md` naming the files, symbols, migrations and
   `apiSurface` rows.
2. **Core changes.** Ask the orchestrator for the §5 core members that workstream lands.
3. **New package.** For a new package (WS0 `gcp-common`, WS9 `gcp-platform`), ask the orchestrator to run
   `node node_modules/pnpm/bin/pnpm.mjs install` while no other agent is installing.
4. **Task plan.** Write that workstream's task-level plan from the code as it is then.

Commit with `node scripts/private-commit.mjs -F <msg> -- <paths>`, and end messages with
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
