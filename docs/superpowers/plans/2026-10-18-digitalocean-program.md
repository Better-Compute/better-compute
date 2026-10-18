# DigitalOcean: full-platform integration — Program Plan

> **For agentic workers:** this is the **program** plan: architecture, decisions, and one section per phase. Each
> phase is executed from its own task-level plan. Phase 1's is written:
> [`2026-10-18-digitalocean-p1-compute.md`](2026-10-18-digitalocean-p1-compute.md). Each later phase's plan is
> written with superpowers:writing-plans when the phase starts, and uses that phase's section below as its spec.
> REQUIRED SUB-SKILL for execution: superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** better-compute can run on DigitalOcean, and use it, as fully as it runs on GCP and Hetzner today. That means
three things:

- **Compute.** Droplets, GPU Droplets (on-demand and Spot), Bare Metal GPUs, MicroVMs and DOKS clusters serve as
  provider pools and instances.
- **Instance-adjacent resources.** Block Storage, snapshots, Reserved IPs, VPCs, Cloud Firewalls, NAT Gateways, Load
  Balancers, DNS and certificates are first-class resources that tenants attach to their instances.
- **Everything else.** Spaces, NFS, Container Registry, Managed and Vector Databases, App Platform, Functions, the AI
  platform (Dedicated and Serverless Inference, Managed Agents), Monitoring, Insights, Uptime, Billing, Projects and
  Security are reachable through one governed, audited, metered resource API. That API seals any credentials these
  services return.

**Architecture:** One new package, `@better-compute/provider-digitalocean`. It talks to DigitalOcean API v2 with plain
`fetch`, as `provider-gcp` does, and is built from four layers:

1. **Shared client.** One per-token `DoClient` handles auth, pagination, the rate-limit budget, error mapping and
   polling of actions.
2. **Existing contract.** `ProviderImpl` and `ProviderNetworks`: Droplets, VPCs and firewalls (P1).
3. **New typed contracts.** Added to core as optional members: `volumes`, `addresses`, `loadBalancers`, `dns` and
   `kubernetes`. These are for the resources whose meaning better-compute's own domain depends on: attach to an
   instance, front a pool, book quota (P2, P4, P5).
4. **One generic contract for the long tail.** `ProviderResources`, a desired-state `ensure`/`get`/`delete` interface
   with a manifest per resource kind. It is served by a new `@better-compute/cloud-resources` module, so thirty managed
   services do not each need a core change (P7–P9).

The design is provider-neutral: the typed contracts are written so that `provider-gcp`, and a later AWS provider,
can implement them.

**Tech Stack:** TypeScript (ESM, Node ≥ 22.12), pnpm workspace, vitest on PGlite, `manifest`/`field` from
`@better-compute/core`, DigitalOcean API v2 (`https://api.digitalocean.com/v2`), and the Spaces S3-compatible API.
The only Go change is in bcd (P3, P5). No new npm dependencies; the one candidate exception, an S3 signer for Spaces,
is decision DO-D19.

**Spec:** No separate spec file. The requirement is the user's request of 2026-10-18, "plan to integrate all services
of DigitalOcean", restated as R1–R10 below. The DigitalOcean surface was taken from the live API reference and the
release notes on 2026-10-18 (§3). Codebase facts were verified on `main` at `f0b97acb` (§2).

---

## Requirements

1. **R1 Compute.** A tenant or the platform registers a DigitalOcean account; provider pools on it create, run, power,
   rebuild and delete Droplets and GPU Droplets.
2. **R2 Attach.** Droplets that already run in an account are discovered, then attached to tenants and released, as
   GCP VMs are today. Label-driven auto-attach works.
3. **R3 Networks.** Tenant networks, subnets and firewall rules (`networks.*`, `firewallRules.*`) map onto DO VPCs and
   Cloud Firewalls.
4. **R4 GPU depth.** GPU sizes and models appear in offers. Spot GPU Droplets are offered when the operator allows it,
   and a preemption is visible to the tenant. Bare Metal GPUs join as metal hosts.
5. **R5 Instance-adjacent resources.** Block volumes, volume snapshots, Reserved IPv4 and IPv6, Load Balancers, DNS
   records and TLS certificates are tenant resources: created, attached to instances or pools, metered and
   quota-bounded.
6. **R6 Kubernetes.** A DOKS cluster can back a pool: better-compute creates it (or adopts it), its node pools, and the
   bcd DaemonSet, and books its GPUs.
7. **R7 Storage and registry.** Spaces buckets and keys, the CDN, NFS shares and Container Registry are tenant
   resources. The operator may also use Spaces as the control plane's `BlobStore`, and DOCR as an OCI image source.
8. **R8 Managed services.** Managed Databases (every engine and edition), Vector Databases, App Platform, Functions,
   Uptime checks, Add-Ons and 1-Click apps are reachable through `cloudResources.*`. Every call goes through IAM, is
   audited, and is metered; credentials are sealed.
9. **R9 AI platform.** Dedicated Inference endpoints count against GPU quota. Serverless, Batch and Agent inference
   usage is metered. Managed Agents, the Harness Runtime, Action Gateway and Signals are reachable in preview, behind
   a flag.
10. **R10 Operations.** DO Monitoring and Insights metrics and alerts reach the observability module. DO billing is
    reconciled against better-compute's meters. Projects mirror tenants. Security findings appear in the admin panel's
    attention list. An account can be connected through DO OAuth. The CLI, the MCP tools, the console, the admin
    panel and the docs cover each phase.

## Current state (verified)

**The provider contract** (`packages/core/src/extension.ts:609-877`)

- **Required:** `listOffers`, `create`, `get` and `delete`.
- **Optional:** `power`, `list`, `discover`, `claim`, `release`, `listReservations`, `networks`
  (`ProviderNetworks`, `:744-762`), `bootstrap`, `identify`, `rescue` and `reinstall`.
- vps detects optional members with `typeof client.x === 'function'`. `capabilities` is a label only.
- **No provider-side volumes, addresses, load balancers, DNS, Kubernetes or managed services exist anywhere.**
  - vps volumes (`vps/src/volumes.ts`, `volume-storage.ts`) are sparse files on bcd hosts.
  - `SnapshotStore` (`vps/src/snapshots.ts:30`) is for sandboxes only.

**Errors** (`core/src/errors.ts:4`)

- vps treats `CAPACITY_UNAVAILABLE` and `QUOTA_EXCEEDED` as terminal for a create (`lifecycle.ts:198,611`).
- `UNSUPPORTED`, `INVALID_STATE` and `INVALID_CONFIG` are hard failures (`:642`).
- `NOT_FOUND` means the resource is gone (`:367`).
- Anything else is retried, honouring `details.retryAfterMs`.

**Idempotency:** `CallContext.idempotencyKey` is the instance id. The conformance case "create is idempotent by
idempotencyKey" is at `vps/src/conformance.ts:167`.

**Patterns to copy**

- `provider-gcp`: client, ids and emulator.
- `provider-hetzner/src/cloud.ts`: an API with no request ids, where the key goes into a label and a lookup happens
  before create.
- `provider-hetzner/src/robot.ts`: metal, claim-by-rename and bootstrap.
- `provider-kubernetes`: bcd as a DaemonSet on an existing cluster, with no provisioning.

**Auto-attach** reads the labels `better-compute-tenant`, `better-compute-pool` and `better-compute-owner` from
`ExternalMachine.labels` (`vps/src/discovery.ts:369-372`). A DO provider has to map its tags onto these keys.

**Dependency rules** (PLAN.md:378-385; enforced by `scripts/check-deps.mjs`): a provider depends only on core and
vps, and nothing imports a provider. Hosts register it with `vps({ providers: [...] })`.

**Credentials:** always `field.secret()` holding a `SecretRef`. `assertNoInlineSecrets` is at
`vps/src/accounts.ts:116`, `accountRefRefusal` at `:180`. Ambient credentials are allowed only for platform accounts.

**Node identity:** `pki/src/attestors/cloud-iid.ts` verifies AWS and GCP identity documents. DigitalOcean's metadata
service has **no signed instance identity**, so DO nodes join with tokens (DO-D12).

**Migrations:** the newest vps migration is `vps/0026_networks`.

**Phases:** `ApiPhase` is the closed union `'v0.1'…'v1.0'` (`core/src/catalog.ts:288`).

**Repo state:** the repo has no DigitalOcean code ("digitalocean" and "droplet" have no hits outside node_modules).

## DigitalOcean surface → integration map (as of 2026-10-18)

The live API reference lists 60 control-plane groups, plus separate inference, Spaces, OAuth and Metadata APIs. Every
one is placed below.

- **Tier A:** native compute, through `ProviderImpl`.
- **Tier B:** typed provider resources.
- **Tier C:** platform and operator integration.
- **Tier D:** generic `cloudResources`.
- **R/O:** read-only, for inventory and attention.
- **—:** out of scope, with the reason given.

| DO API group (endpoint count) | Tier | Phase | better-compute home |
|---|---|---|---|
| Droplets (19), Droplet Actions (4) | A | P1 | `ProviderImpl` create/get/delete/power/reinstall/list/discover/claim/release |
| Sizes (1), Regions (1) | A | P1 | `listOffers` (price, GPU, availability per region) |
| SSH Keys (5) | A | P1 | Created on demand per fingerprint by `create` (DO-D7) |
| Tags (6) | A | P1 | Ownership and auto-attach labels, firewall targeting (DO-D5) |
| Actions (2) | A | P1 | Non-blocking action polling in the client |
| VPCs (10) | A | P1 | `ProviderNetworks.ensureSubnet` → one VPC per (network, region) (DO-D9) |
| VPC Subnets [preview] (6), VPC Routes [preview] (5) | A | P4 | `ensureSubnet` v2 once GA; routes as `networkRoutes` (flagged) |
| Firewalls (11) | A | P1 | `ensureFirewall`, `setTags` (DO-D10) |
| Images (9), Image Actions (3) | A | P3 | `ImageRef` resolution, custom-image import from the signed catalog, per-region transfer |
| Snapshots (3) | A/B | P2 | Volume snapshots (typed) and Droplet snapshots as images |
| Droplet Autoscale Pools (8) | R/O | P1 | Discover only: their Droplets are refused for claim (DO-D15) |
| MicroVMs [preview] (13) | A | P3 | Experimental sandbox backend (`provider: 'digitalocean-microvm'`), flagged |
| Block Storage (9), Block Storage Actions (4) | B | P2 | `ProviderVolumes`: tenant volumes attached to instances |
| Reserved IPs (4), Reserved IP Actions (3), Reserved IPv6 (4), Reserved IPv6 Actions (1) | B | P2 | `ProviderAddresses`: tenant addresses assigned to instances |
| Floating IPs (4), Floating IP Actions (3) | — | — | Legacy alias of Reserved IPs; never called |
| BYOIP Prefixes (6) | B | P4 | `ProviderAddresses` with `source: 'byoip'` (allocate from a prefix); prefix management R/O |
| Load Balancers (10) | B | P4 | `ProviderLoadBalancers`: regional and global, targets = pool instances by tag |
| VPC NAT Gateways (5) | B | P4 | `ProviderNetworks.ensureNatGateway` (additive) |
| VPC Peerings (5) | B | P4 | `networkPeerings.*` (typed, additive to networks) |
| Partner Network Connect (9) | D | P7 | `cloudResources` kind `do.partner-attachment` (credentials sealed) |
| Domains (4), Domain Records (6) | B | P4 | `ProviderDns`: zones and records; instance hostnames |
| Certificates (4) | B | P4 | `ProviderCertificates` (Let's Encrypt and custom, for load balancers) |
| CDN Endpoints (6) | D | P6 | `cloudResources` kind `do.cdn-endpoint` (origin = a tenant Spaces bucket) |
| Spaces API (S3), Spaces Keys (6) | B/C | P6 | Buckets and keys as resources; `spacesBlobStore` for the operator |
| NFS (11), NFS Actions (1) | B | P6 | `ProviderVolumes` with `kind: 'shared'`; mounted into pool instances |
| Kubernetes (28) | A/B | P5 | `ProviderKubernetes`: DOKS clusters and node pools as pool backends + bcd DaemonSet |
| Container Registry (18), Container Registries (19) | C/D | P6 | OCI `ImageSource` auth for DOCR; registries/repos as `cloudResources` |
| 1-Click Applications (2) | D | P7 | `cloudResources` catalog listing; installs through Droplet create or a DOKS add-on |
| Add-Ons (8) | D | P7 | `cloudResources` kind `do.addon` |
| Databases (71) | D | P7 | `cloudResources` kinds `do.database.{pg,mysql,valkey,mongodb,kafka,opensearch}`, plus users, pools, firewalls, replicas |
| Vector Databases (11) | D | P7 | `cloudResources` kind `do.vector-database` |
| Apps (38) | D | P7 | `cloudResources` kind `do.app` (App Platform spec as the manifest) |
| Functions (13) | D | P7 | `cloudResources` kinds `do.functions-namespace`, `do.functions-trigger` |
| Uptime (11) | C/D | P9 | `cloudResources` kind `do.uptime-check`; the operator's gateway checks |
| Dedicated Inference (13) | D + quota | P8 | `cloudResources` kind `do.dedicated-inference`, with GPU-hours booked to quota |
| Inference APIs (Serverless, Batch, Embeddings, Agent Inference) | C | P8 | Metered passthrough (`ai.inference.tokens`); keys sealed |
| Agent Platform API (142) | D, flagged | P8 | Knowledge bases, agents and guardrails as `cloudResources` (ADK is deprecated: no new agent deploys, DO-D21) |
| Harness Runtime (54), Action Gateway (43), Action Gateway Data Plane (6), Signals (14) | D, flagged | P8 | Managed Agents in preview: `cloudResources` + R/O signals |
| Monitoring (72) | C | P9 | Metrics → observability; alert policies as `cloudResources` |
| Insights (25) [preview] | C | P9 | Metric, log and trace query bridge; alert rules and notification channels |
| Billing (10) | C | P9 | Balance, history and invoices → `usage` reconciliation and budget alerts |
| Projects (9), Project Resources (4) | C | P9 | One DO project per tenant (opt-in); new resources assigned on create |
| Account (1), Organizations (2) | C | P1/P9 | `checkClient` probe (P1); team listing (R/O) |
| Security (10) | R/O | P9 | Findings → the admin panel's `attention` |
| OAuth API | C | P9 | "Connect a DigitalOcean account" flow → a sealed refresh token |
| Metadata API (inside a Droplet) | C | P3 | bcd inventory: droplet id, region and tags (Go), never used as an identity |
| vendor_portal scope | — | — | Marketplace vendor tooling; not a consumer feature |

## Architecture

### Package layout

`packages/provider-digitalocean/src/`. One package with one internal folder per domain. Every folder shares one
client.

| Path | Responsibility | Phase |
|---|---|---|
| `index.ts` | Exports `digitaloceanProvider(options)`, `digitalocean`, and later `digitaloceanMetal`, `spacesBlobStore` | P1+ |
| `config.ts` | `DoConfig` manifest and `DoProviderOptions` | P1 |
| `client/http.ts` | `DoClient`: request, pages, actions, error mapping | P1 |
| `client/budget.ts` | Per-token rate-limit budget (DO-D11) | P1 |
| `client/errors.ts` | `mapDoError`, plus the table of 422 message patterns | P1 |
| `ids.ts` | Machine, offer and name ids; the tag codec (DO-D5) | P1 |
| `compute/offers.ts`, `compute/droplets.ts`, `compute/keys.ts`, `compute/userdata.ts` | Tier A compute | P1 |
| `networks/vpcs.ts`, `networks/firewalls.ts` | `ProviderNetworks` | P1 |
| `networks/nat.ts`, `networks/peering.ts`, `networks/routes.ts` | P4 network extensions | P4 |
| `storage/volumes.ts`, `storage/snapshots.ts`, `storage/nfs.ts` | `ProviderVolumes` | P2, P6 |
| `edge/addresses.ts`, `edge/load-balancers.ts`, `edge/dns.ts`, `edge/certificates.ts` | Tier B edge | P2, P4 |
| `kubernetes/doks.ts` | `ProviderKubernetes` | P5 |
| `spaces/s3.ts`, `spaces/blob-store.ts` | Spaces signer (SigV4) and the operator `BlobStore` | P6 |
| `metal/bare-metal.ts` | `digitaloceanMetal` provider (`provides: ['metal']`) | P3 |
| `microvm/sandbox.ts` | Experimental MicroVM backend | P3 |
| `resources/registry.ts` | `ProviderResources` dispatcher | P7 |
| `resources/kinds/*.ts` | One file per DO resource kind (manifest, mapping, outputs) | P7–P9 |
| `ops/monitoring.ts`, `ops/insights.ts`, `ops/billing.ts`, `ops/projects.ts`, `ops/security.ts`, `ops/oauth.ts` | Tier C | P9 |

The tests mirror this layout in `tests/support/do-emulator/` (one module per service, composed into one `fetch`) and
`tests/provider-digitalocean-*.test.ts`.

### Where control-plane behavior lives

| Concern | Module | Why |
|---|---|---|
| Accounts, offers, instances, discovery, attach, networks (P1) | `vps` (existing) | Unchanged contract; the existing reconcilers `vps.discovery` and `vps.networks` serve DO without changes |
| Provider volumes, addresses, LBs, DNS, certificates (P2/P4) | `vps` | They attach to vps instances and pools, use vps quotas (`vps.volume.gib.hours` already exists), and are reconciled next to instances |
| DOKS-backed pools (P5) | `vps` + `provision` (`k8s-join` unit) + `provider-kubernetes` manifests | A cluster is a pool's substrate |
| Long-tail managed services (P7–P9) | **new `@better-compute/cloud-resources` module** | Keeps vps focused. One generic table, reconciler and API group; IAM per kind |
| Operator BlobStore on Spaces (P6) | `provider-digitalocean/spaces` (the host passes it to `betterCompute({ blobStore })`) | `BlobStore` is a core interface; no module changes |
| Monitoring/Insights bridge (P9) | `observability` (new `externalMetrics` source contract) | Nodes export OTLP; this is the pull side for unmanaged and attached machines |
| Billing reconciliation (P9) | `iam` usage + `capacity/usage.ts` | Meters exist; this adds an invoice source and a drift report |

Dependency check for `cloud-resources`: it depends on core and vps, and is imported by nothing. Before P7 starts, its
plan's Task 0 confirms that module→vps imports are allowed by PLAN.md:378-385 and `scripts/check-deps.mjs`. If they
are not, the module reads provider accounts through a core-level `ProviderAccountResolver` port instead (DO-D3).

### New core contracts (additive, optional, provider-neutral)

All of these are optional members on `ProviderImpl`, so existing providers are untouched. Like `ProviderNetworks`,
every `ensure*`/`delete*` call is **idempotent and non-blocking**: it returns `pending` or `deleting`, and the
reconciler calls again later. Every state type reuses `ProviderNetworkState`'s shape
`{ id, state, message? }`, extended with `outputs`.

```ts
// P2
interface ProviderVolumes {
  ensureVolume(spec: { name: string; region: string; sizeGiB: number; kind: 'block' | 'shared';
    filesystem?: 'ext4' | 'xfs' | 'none'; snapshotId?: string; tags?: readonly string[] }, ctx: CallContext): Promise<ProviderResourceState>;
  attachVolume(volumeId: string, machineId: string, ctx: CallContext, instanceId?: string): Promise<ProviderResourceState>;
  detachVolume(volumeId: string, machineId: string, ctx: CallContext): Promise<ProviderResourceState>;
  resizeVolume(volumeId: string, sizeGiB: number, ctx: CallContext): Promise<ProviderResourceState>;   // grow only
  snapshotVolume(volumeId: string, name: string, ctx: CallContext): Promise<ProviderResourceState>;
  deleteVolume(volumeId: string, ctx: CallContext): Promise<ProviderResourceState>;
  deleteSnapshot(snapshotId: string, ctx: CallContext): Promise<ProviderResourceState>;
}
interface ProviderAddresses {
  ensureAddress(spec: { name: string; region: string; family: 'ipv4' | 'ipv6'; source?: 'pool' | 'byoip'; prefix?: string }, ctx): Promise<ProviderResourceState>; // outputs.address
  assignAddress(addressId: string, machineId: string, ctx, instanceId?: string): Promise<ProviderResourceState>;
  unassignAddress(addressId: string, ctx): Promise<ProviderResourceState>;
  deleteAddress(addressId: string, ctx): Promise<ProviderResourceState>;
}
// P4
interface ProviderLoadBalancers { ensureLoadBalancer(spec: LoadBalancerSpec, ctx): Promise<ProviderResourceState>; deleteLoadBalancer(id, ctx) }
interface ProviderDns { ensureZone(name, ctx); ensureRecord(zone, spec: DnsRecordSpec, ctx); deleteRecord(zone, id, ctx); deleteZone(name, ctx) }
interface ProviderCertificates { ensureCertificate(spec: { name; kind: 'managed' | 'custom'; domains?; certificate?: SecretRef; privateKey?: SecretRef }, ctx); deleteCertificate(id, ctx) }
// P5
interface ProviderKubernetes {
  ensureCluster(spec: KubernetesClusterSpec, ctx): Promise<ProviderResourceState>;          // outputs: endpoint, version, vpc
  ensureNodePool(cluster: string, spec: KubernetesNodePoolSpec, ctx): Promise<ProviderResourceState>;
  kubeconfig(cluster: string, ctx): Promise<SecretValue>;                                      // short-lived; sealed by the caller, never stored plain
  deleteNodePool(cluster: string, id: string, ctx): Promise<ProviderResourceState>;
  deleteCluster(cluster: string, ctx): Promise<ProviderResourceState>;
}
// P7 — the long tail
interface ProviderResourceKind {
  kind: string;                                  // "do.database.pg" — provider-prefixed, [a-z0-9.-]
  family: 'storage' | 'network' | 'edge' | 'data' | 'platform' | 'ai' | 'observability';
  spec: Manifest<unknown>;                       // validated before any provider call
  outputs: readonly string[];                    // plain outputs (host, port, urn)
  secretOutputs?: readonly string[];             // sealed into SecretStore by cloud-resources, returned as SecretRefs only
  regional: boolean;
  updatable: readonly string[];                  // spec fields `ensure` may change in place; others ⇒ INVALID_STATE (replace)
  meters?: readonly { meter: string; unit: string }[];
  preview?: boolean;                             // refused unless the account enables previews
}
interface ProviderResourceState { id: string; state: 'pending' | 'ready' | 'updating' | 'deleting' | 'deleted' | 'error';
  outputs?: Readonly<Record<string, string>>; secretOutputs?: Readonly<Record<string, string>>; message?: string }
interface ProviderResources {
  kinds(): readonly ProviderResourceKind[];
  ensure(kind: string, name: string, spec: unknown, ctx: CallContext): Promise<ProviderResourceState>;
  get(kind: string, id: string, ctx: CallContext): Promise<ProviderResourceState | undefined>;
  delete(kind: string, id: string, ctx: CallContext): Promise<ProviderResourceState>;
  discover?(kind: string, ctx: CallContext): AsyncIterable<{ id: string; name: string; managedBy?: string }>;
}
```

The P2 plan's first task lands `ProviderResourceState` together with `volumes` and `addresses`, and the conformance
cases for each contract (`vps/src/conformance.ts`). Every later contract adds its own conformance cases in the task
that defines it. A GCP implementation of `volumes` and `addresses` is a named follow-up for the GCP owner. It is not
part of this program, but the contracts are reviewed with it in mind: Persistent Disk and static addresses map 1:1.

### Ownership, identity and tagging (DO-D5)

DO tags are flat strings. They may contain letters, digits, `:`, `-` and `_`, up to 255 characters, and tag objects
live account-wide. The provider encodes the `better-compute-*` label keys as `<key>:<value>` tags and decodes them
back into `ExternalMachine.labels`. That way `vps.discovery`, auto-attach and every label-based rule work unchanged:

| Label | Tag | Notes |
|---|---|---|
| `better-compute-managed=true` | `better-compute-managed:true` | Hands deletion to better-compute |
| `better-compute-instance=<id>` | `better-compute-instance:<id>` | Ownership; at most one per resource |
| `better-compute-tenant=<t>`, `-pool=<p>`, `-owner=<o>` | same pattern | Auto-attach inputs |
| *(new)* `better-compute-deployment=<h>` | `better-compute-deployment:<h>` | `h` = first 12 hex chars of sha256(trust domain): two control planes on one DO account never touch each other's resources |
| *(new)* `better-compute-key=<h>` | `better-compute-key:<h>` | Idempotency key hash (DO-D4) |
| network membership | `bc-net-<sha256(network).hex[0:16]>` | Firewall targeting (DO-D10) |

A value with characters outside the tag alphabet is encoded as `x<base32-lower(sha256(value))[0:26]>`. Decoding
can't recover it; such a value then compares by hash. Tag names are case-insensitive in DO's matching, so the codec
writes lowercase only and compares case-folded.

The control plane is the arbiter of claims (DO-D6). DO tags have no compare-and-set, so a claim works as follows:

1. Write the tag.
2. Re-read the resource.
3. If two `better-compute-instance:*` tags are present, the claimer whose tag is **not** in the database's
   `provider_machines.claimed_by` removes its own tag and returns `CONFLICT` with `reason 'claimedByAnother'`.

A sweeper deletes empty `better-compute-*` tag objects. They accumulate because every instance id makes a tag.

### Idempotency without request ids (DO-D4)

DO has no idempotency keys, and **Droplet names are not unique**. That is unlike Hetzner, where the unique name
settles races. The protocol, specified in P1 Task 5:

1. List by tag `better-compute-key:<h>`. If there is a match, return the oldest one (smallest `created_at`, then the
   smallest id).
2. Otherwise `POST /v2/droplets` with that tag (and the managed, instance, deployment, tenant and pool tags).
3. After the create, list by the key tag again. If more than one Droplet carries it, keep the oldest and delete the
   others (they are ours, and a duplicate never ran a workload), then return the survivor. The reaping uses
   `DELETE /v2/droplets/{id}` per id, **never** `DELETE /v2/droplets?tag_name=` (DO-D16).

vps claims rows with a TTL, so a duplicate can only happen when a claim expires while a create is in flight. The
reaper makes that case converge.

The same key-tag protocol applies to every taggable resource: volumes, LBs, DOKS clusters, databases. Resources that
can't be tagged (VPCs, SSH keys, certificates, domains) use a deterministic name instead: unique per account at DO,
so the unique name settles races, as on Hetzner.

### Asynchrony, rate limits and errors

**Actions.** A mutation returns the resource, or an `action`, at once. The client never blocks a reconciler for longer
than `inCallWaitMs`, which defaults to 0 and is capped at 20 s like GCP. The client reports `pending`, and `get` maps
the status:

| Droplet status | State |
|---|---|
| `new` | `pending` |
| `active` | `running` |
| `off` | `stopped` |
| `archive` | `deleted` |

A failed create action (`action.status = 'errored'`) is recorded in the client's per-process action cache, which is
keyed by Droplet id. `get` reads it and fails as `PROVIDER_ERROR`, or as `CAPACITY_UNAVAILABLE` when the 422 table
matches.

**Rate-limit budget (DO-D11).** DO allows 5,000 requests per hour and 250 per minute **per token**. Every reconciler
of one account shares that. `client/budget.ts` keeps a process-local token bucket per token hash, seeded from the
`ratelimit-limit` / `ratelimit-remaining` / `ratelimit-reset` headers. Budget classes:

| Class | Share | Behavior when exhausted |
|---|---|---|
| `mutate` | ≥ 50% | Never starved |
| `observe` (`get`, actions) | 30% | — |
| `sweep` (discovery, billing, monitoring pulls) | ≤ 20% | Defers with `RATE_LIMITED` + `retryAfterMs` instead of spending the mutate share |

Discovery uses `per_page=200` and tag-filtered lists. A multi-process deployment shares the budget only by spending
less. P9 adds a Postgres-backed budget, if measurements show it is needed (open question Q6).

**Error mapping** (`client/errors.ts`). The DO error body is `{ id, message, request_id }`. Every `ComputeError` carries
`details: { provider: 'digitalocean', status, id, requestId }` and never the token.

| HTTP / DO `id` | Code | Retry |
|---|---|---|
| 401 `unauthorized` | `INVALID_CONFIG` (`reason 'token'`) | No |
| 403 `forbidden` | `ACCESS_DENIED` (`reason 'scope'`, plus the scope from the method table when known) | No |
| 404 `not_found` | `NOT_FOUND` | — |
| 409 / 422 name or tag already in use | `CONFLICT` | — |
| 422 with a capacity pattern ("not available in this region", "insufficient capacity", "currently unavailable") | `CAPACITY_UNAVAILABLE` | No |
| 422 with a limit pattern ("exceed your droplet limit", "limit reached", "quota") | `QUOTA_EXCEEDED` | No |
| 422, other | `INVALID_INPUT` | No |
| 429 | `RATE_LIMITED`, `retryAfterMs` from `ratelimit-reset` (default 60 s) | Yes |
| 5xx, network | `UNAVAILABLE` | Yes |

The 422 pattern table is data in `client/errors.ts`, and every pattern has a fixture. P0 Task S2 captures the real
messages; unknown 422s fall through to `INVALID_INPUT`, so they never retry forever.

### Credentials and scopes (DO-D2, DO-D13)

**Credentials.** An account's `token` is a `field.secret()` holding a DO personal access token. DO has no ambient
credentials (its metadata service issues none), so `context.account.platform` grants nothing extra.

**Scope probe.** vps's `checkClient` builds a client without making any provider call (`vps/src/accounts.ts:455`),
so the probe is a separate export, `probeAccount()` (P1 Task 9). The CLI (`bc providers digitalocean check`, P9)
and the account pages call it. It runs one read per capability family:

- `GET /v2/account` (`account:read`)
- `GET /v2/regions` (`regions:read`)
- `GET /v2/sizes` (`sizes:read`)
- `GET /v2/droplets?per_page=1` (`droplet:read`)
- and `vpcs`, `firewalls`, `account/keys` and `tags`

It reports which families the token can serve, from the 403s. Mutating scopes can't be probed safely, so a missing
write scope surfaces on first use as `ACCESS_DENIED` with the scope name.

The minimum custom scopes per phase are part of each phase's docs (P1: `droplet:*`, `ssh_key:read,create`,
`tag:read,create,delete`, `vpc:*`, `firewall:*`, `regions:read`, `sizes:read`, `actions:read`, `account:read`,
`image:read`).

**Token handling.** The token is resolved through `context.secrets.resolve` on first use and kept in memory only.
`never logs tokens` is a test in every phase.

**OAuth (P9).** "Connect a DigitalOcean account" stores a refresh token as a secret. The provider exchanges it for
access tokens, and the refresh token rotates on every exchange. This is an alternative to pasting a PAT, not a
replacement.

### Node join and identity (DO-D12)

There is no `cloud-iid` for DO. A signed DO instance identity does not exist, and a weaker "corroborate through the
API" attestor would let anyone with the account's token join a node. Nodes join the way Hetzner hosts do:

- **vps-hosted pools:** the single-use join token in `user_data` (the existing vps path; `user_data` ≤ 64 KiB).
- **`agent: 'bcd'` metal pools:** a `provisioned` token delivered by `bootstrap` over SSH, never in tenant-readable
  user data (P3).

bcd reads the metadata service (`169.254.169.254/metadata/v1.json`: droplet id, region, tags, interfaces) for
**inventory only** (P3, Go).

### Deletion safety (DO-D16)

These rules hold in every phase:

- Never call a tag-scoped bulk endpoint: `DELETE /v2/droplets?tag_name=`, `POST /v2/droplets/actions?tag_name=`.
- `delete` refuses any resource without both `better-compute-managed:true` and this deployment's tag.
- Droplet deletion uses `DELETE /v2/droplets/{id}/destroy_with_associated_resources/selective` **only** from P2 on, and
  only names associated resources that carry this deployment's managed tag. A tenant's own volume that was attached
  by hand survives.

## Decisions

These are recommendations. Each is the default unless the user overrides it. PLAN.md's D1–D20 are untouched.

| # | Decision | Recommendation | Alternatives (rejected) |
|---|---|---|---|
| DO-D1 | One package or many | One `provider-digitalocean` package with folders per domain; extra provider definitions (`digitaloceanMetal`, MicroVM) are exported from it | A package per service (repo churn, a shared client duplicated) |
| DO-D2 | SDK or plain fetch | Plain `fetch` + a hand-written typed subset, as GCP does; no `@digitalocean/*` dependency | `dots-wrapper` / OpenAPI codegen (a dependency, large surface, no rate budget) |
| DO-D3 | Home of the long tail | New `@better-compute/cloud-resources` module (core + vps), one generic reconciler | Everything in vps (bloat); per-service modules (30 packages) |
| DO-D4 | Idempotency | Key tag + oldest-wins reaping (§ above); deterministic names for untaggable resources | Name-based lookup only (DO names aren't unique) |
| DO-D5 | Label encoding | `better-compute-<key>:<value>` tags, decoded back to labels; hashed values when needed | A JSON blob in a tag (not filterable) |
| DO-D6 | Claim arbitration | Postgres `provider_machines` is the arbiter; tags mirror it; tag-then-verify | Tag-only claims (no CAS at DO) |
| DO-D7 | SSH keys | Ensure each OpenSSH key in the account by fingerprint (`bc-<fp16>`), pass its id to `ssh_keys`, and **always** pass at least one key (else DO emails a root password); also render keys into cloud-init | Cloud-init only (triggers the root-password email; password SSH stays on until cloud-init runs) |
| DO-D8 | Offer ids | `<region>/<sizeSlug>`; Spot as `<region>/<sizeSlug>@spot`; machine id = Droplet id (decimal string) | `<sizeSlug>` alone (region is part of availability) |
| DO-D9 | Network mapping | `ensureNetwork` creates no VPC; it ensures the network's base firewall (DO-D10). `ensureSubnet` creates one VPC per subnet, named as the subnet (`bc-<subnet id>`), with `ip_range = cidr` and `description = 'bc:network=<network>'`, which ties the VPC to its network. Once VPC Subnets go GA, P4 moves to VPC + subnets behind `networkModel: 'vpc-subnets'` | A VPC per network (DO VPCs are regional; the contract's network is global) |
| DO-D10 | Firewalls | **Base firewall** per network (`bc-base-<net16>`, target `bc-net-<net16>`): no inbound rules and all outbound allowed. It reproduces the contract's implied "deny ingress, allow egress". On DO, a Droplet with no firewall accepts everything, and a Droplet with any firewall loses all outbound traffic not allowed. **Tenant rules:** one DO firewall per spec, targeting vps's per-instance `bc-*` tags, or the network member tag when the rule names no targets. Deny rules map to DO deny rules. A ruleset where an `allow` outranks an overlapping `deny` by priority is refused `UNSUPPORTED` (`reason 'firewallPriority'`): DO has no priorities, and deny always wins | Silently flattening priorities (changes semantics); no base firewall (open ingress, broken egress) |
| DO-D11 | Rate limits | Per-token, process-local budget with classes; Postgres-shared budget only if measured necessary | No budget (one sweep exhausts the hour) |
| DO-D12 | Node identity | Join tokens (user data / `provisioned`); no DO attestor | An API-corroborated attestor (token holder = any node) |
| DO-D13 | Account auth | PAT with custom scopes now; OAuth connect in P9; scope probe at account creation | OAuth only (blocks P1 on a console flow) |
| DO-D14 | Spot GPU | Off by default (`allowSpot: false`). Spot offers carry `pricePerHour` from today's daily price. Preemption = the Droplet disappears → `get` → `undefined` with `details.reason 'preempted'` when the action log says so → vps condition `Preempted`, not `ProvisionFailed` | Spot on by default (surprise interruptions) |
| DO-D15 | DO Autoscale Pools | Discover-only; their Droplets are refused for claim (`INVALID_STATE`, `reason 'autoscalePool'`); better-compute pools do their own scaling | Mapping DO autoscale pools to better-compute pools (two scalers fight) |
| DO-D16 | Bulk operations | Never call tag-scoped bulk endpoints; deletes are per-id and tag-verified | — |
| DO-D17 | Bare Metal GPU | `digitaloceanMetal` (`provides: ['metal']`) on the `hetzner-robot` pattern: claim by tag, `bootstrap` over SSH, `power` through the API if exposed. P0 Task S4 determines what the API exposes; if machines aren't API-visible, enrolment is manual (`metal.enroll` + a bcd install script) and the provider only adds inventory tagging | Waiting for an API |
| DO-D18 | DOKS GPU drivers | DOKS ≥ 1.37 no longer enables device plugins by default. The bcd DaemonSet's own device plugin is the default (compute books the devices, as on any k8s); DRA stays an opt-in and a follow-up | DO's DRA drivers (bypass compute's booking) |
| DO-D19 | Spaces signing | Hand-written SigV4 (one file, tested against AWS's published vectors), no dependency; the `BlobStore` uses the existing s3 implementation if it accepts an endpoint override (P6 Task 0 checks) | `@aws-sdk/client-s3` (a large dependency) |
| DO-D20 | ApiPhase of new methods | `'v1.0'`, as the GCP work did. If the orchestrator opens `'v1.1'` in `ApiPhase` first, use that | Adding `'v1.1'` here (a core-union change belongs to the orchestrator) |
| DO-D21 | Agent Platform scope | Knowledge bases, guardrails and inference keys as resources; **no new agent deployments** (ADK and `doctl gradient` are deprecated as of 2026-10-01); Managed Agents in preview only, behind `previews: true` | Full agent lifecycle (a deprecated surface) |
| DO-D22 | Projects | Opt-in `projectPerTenant`: create `bc-<tenant>` projects and assign each new resource; off by default (tenants on their own accounts keep their own projects) | Always on (clutters a tenant's account) |
| DO-D23 | Previews in general | Every `[Public Preview]` API (VPC Subnets/Routes, MicroVMs, Insights, Managed Agents) ships behind the account flag `previews: true`, and its kinds report `preview: true` | Waiting for GA (loses months) |
| DO-D24 | Live tests | Emulator-first; an opt-in live suite (`BC_DO_LIVE=1`, a dedicated account with a hard spend cap, a tag sweeper in `afterAll`) runs per phase before its release, never in CI by default | Live in CI (cost, flakiness, secrets in CI) |

## Global Constraints (every phase)

- **Runtime:** Node ≥ 22.12, ESM only. No new npm dependencies without the orchestrator's approval
  (coordination.md:11). Install with `node node_modules/pnpm/bin/pnpm.mjs`.
- **Core is frozen.** Edits are additive optional members only, reviewed before they land (coordination.md:13-14).
  Each new contract lands in its own commit with conformance cases.
- **Dependency rules.** `provider-digitalocean` depends only on `@better-compute/core` and `@better-compute/vps`. It is
  not in the umbrella, and nothing imports it (`scripts/check-deps.mjs`). vps tests use a stand-in, never the
  provider (ruling P2).
- **Shared registries.** Root `tsconfig.json`, `vitest.config.ts`, `pnpm-workspace.yaml`, `umbrella.json` and the root
  `package.json` change only by one-line inserts.
- **Migrations.**
  - Additive only, named `<module>/<nnnn>_<slug>`.
  - vps starts at `vps/0027`; the phase plan reconfirms the next free number at Task 0.
  - The `cloud-resources` module owns `cloud-resources/0001…`.
  - SQL uses `compute_now()`.
- **No provider call inside a transaction.** A reconciler run stays under `claimTtlMs` (60 s). Long DO actions are
  polled with `notBefore`, never awaited.
- **Secrets.** Only `SecretRef`s live in configs, specs and tables. Values a DO API returns (database passwords,
  kubeconfigs, Spaces secrets, inference keys) are sealed through `SecretStore` within the reconciler run that
  received them. Only the ref is stored and returned. Logs and `ComputeError.details` never carry tokens or secret
  outputs.
- **Egress.** The endpoints (`api.digitalocean.com`, `*.digitaloceanspaces.com`, `inference.do-ai.run`, the OAuth host)
  are code-level options, never tenant config. Any URL a DO response hands back (`links.*`, a presigned URL) is
  followed only if its origin equals the configured endpoint's.
- **Deletion safety.** DO-D16 holds in every phase. Every delete path has a test that a resource without
  `better-compute-managed:true` and this deployment's tag is refused.
- **API surface.**
  - Every new API method gets an `apiSurface` row (phase per DO-D20).
  - Every changed method updates `apps/docs/descriptions/api/<group>.md`, and the reference is regenerated with
    `node scripts/head-check.mjs --run apps/docs/scripts/sync-from-head.mjs <root>`.
  - Every event family gets a row in `events/src/catalog.ts`.
- **Workflow.** Claim files in `.claude/coordination.md` first, and commit with
  `node scripts/private-commit.mjs -F <msgfile> -- <paths>`. Format only touched files. Never commit
  `pnpm-lock.yaml` or the generated umbrella files. Every commit ends with the `Co-Authored-By` trailer.
- **Security review.** After each phase lands, a security review runs over its commit range. HIGH and MED findings
  are closed before the next phase's first commit.

## Review Focus (program-wide)

Each of these failure modes spans phases; the owning phase's plan pins each one with a test.

1. **Duplicate Droplets from a retried create** after a claim expiry. Expected: exactly one survivor (the oldest),
   every duplicate deleted, and the instance bound to the survivor.
   *Test: P1 Task 5, `two racing creates with one key converge on the oldest droplet`.*
2. **A delete reaching a resource better-compute doesn't own:** a tenant's hand-made Droplet or volume, another
   deployment's Droplet, a bulk tag endpoint. Expected: `INVALID_STATE` (`reason 'notManaged'`), with no
   `DELETE` sent. *Test: P1 Task 5, `delete refuses an unmanaged or foreign-deployment droplet; no DELETE is sent`;
   one per typed contract in P2/P4/P5.*
3. **Rate-limit exhaustion by sweeps** starving creates and deletes. Expected: a sweep defers with `RATE_LIMITED`
   while a create still goes out. *Test: P1 Task 1, `sweep calls defer before mutate calls are refused`.*
4. **Leaked secret outputs:** a database password or kubeconfig persisted in plain text, logged, or returned in an
   error. Expected: only `SecretRef`s in rows and responses.
   *Test: P5 `kubeconfig is sealed and never stored`, P7 `secret outputs are sealed in the run that received them`.*
5. **Firewall semantics drift.** A tenant ruleset whose meaning depends on priority being flattened silently.
   Expected: `UNSUPPORTED` (`reason 'firewallPriority'`) at `firewallRules.create`, not a weaker rule at DO.
   *Test: P1 Task 8, `an allow outranking an overlapping deny is refused`.*

---

## Phases

Dependency graph:

```
P0 spike ─┬─> P1 compute ─┬─> P2 volumes/addresses ─┬─> P4 edge (LB, DNS, certs, NAT, peering)
          │               ├─> P3 images/metal/spot/microvm
          │               └─> P5 DOKS ──────────────┘
          └───────────────────────────> P6 storage (Spaces, NFS, DOCR) — needs P2's ProviderVolumes for NFS
P7 cloud-resources module + managed data/platform ── needs P1's client; independent of P2–P6
P8 AI platform ── needs P7
P9 operations (monitoring, insights, billing, projects, security, OAuth, surfaces) ── needs P1; parts need P7
```

**What can run in parallel** (each in its own session and worktree, after P1 lands):

- P2 and P3.
- P5, once P2's `ProviderResourceState` commit is in.
- P7, which only touches the new module and `resources/`.
- P9's billing and monitoring halves.

P4 needs P2. P6's NFS half needs P2; its Spaces and DOCR halves don't.

Rough size, in tasks, by phase:

| Phase | P0 | P1 | P2 | P3 | P4 | P5 | P6 | P7 | P8 | P9 |
|---|---|---|---|---|---|---|---|---|---|---|
| Tasks | 4 | 13 | 10 | 9 | 11 | 9 | 9 | 12 | 7 | 12 |

That is about 95 in total.

### P0 — Verification spike (no product code)

**Goal:** settle the facts the design assumes, before code depends on them. The output is
`docs/research/digitalocean.md`, with fixtures saved under `tests/fixtures/digitalocean/` as redacted JSON.

**Tasks**

- **S1. Account and limits.** Rate-limit headers and their reset semantics, `per_page` max, error body shape, the
  token-scope 403 body, and the Droplet limit per account.
- **S2. Create semantics.**
  - **Capture:** the real 422 messages for size-not-in-region, capacity, limit and invalid image. Whether create
    without `ssh_keys` sends the root-password email. Tag case behavior. Whether duplicate names are accepted.
    `user_data` max size. Action `errored` shapes. GPU-size image requirements (`gpu-*-base` AI/ML images).
  - **Output:** the 422 pattern table and the state-mapping fixtures.
- **S3. Network semantics.**
  - VPC: `ip_range` overlap rules within an account, the reserved ranges, and whether a VPC can be deleted while it
    has members.
  - Firewalls: the deny-rule field shape, per-firewall rule limits, firewalls per Droplet, and tag-targeting latency.
  - The VPC Subnets preview shape.
- **S4. GPU and metal.** Spot GPU Droplet API shape (size slugs, pricing field, the preemption signal in actions).
  Whether Bare Metal GPUs are visible in any public API. MicroVM API shape (MKC1).

**Exit:** the research doc is reviewed, and every "verify" in the P1 plan is resolved or turned into a test fixture.
Spending stays under the test account's cap; the sweeper leaves no `better-compute-*` resources behind.

### P1 — Compute provider: Droplets, GPU Droplets, VPCs, firewalls, attach

**Task-level plan:** [`2026-10-18-digitalocean-p1-compute.md`](2026-10-18-digitalocean-p1-compute.md).

**Scope:** R1, R2, R3, and the offer half of R4.

- `ProviderImpl`: `listOffers`, `create`, `get`, `delete`, `power`, `reinstall`, `list`, `discover`, `claim`, `release`
- `networks: ProviderNetworks`
- No `listReservations`: DO has no capacity reservations, so vps detects the member as absent.
- The existing vps workers (`vps.discovery`, `vps.networks`) and APIs (`instances.attach`, `networks.*`,
  `firewallRules.*`) work unchanged.

**Exit**

- Provider conformance passes on the emulator.
- `tests/do-end-to-end.test.ts` passes: create, attach, networks and delete through `betterCompute()`.
- The live suite has passed once.
- Docs, README and CHANGELOG are updated.
- The security review is closed.

### P2 — Block Storage, snapshots and Reserved IPs (typed provider resources)

**Scope:** R5 for volumes, snapshots and addresses.

**Design**

- **Core contract.** Core gains `ProviderResourceState`, `ProviderImpl.volumes?` and `ProviderImpl.addresses?`, plus
  their conformance cases.
- **Tables and reconciler.** vps gains `provider_volumes`, `provider_volume_attachments`, `provider_snapshots` and
  `provider_addresses` (`vps/0027…0030`), and one `vps.providerResources` reconciler that converges desired against
  observed state, with non-blocking actions.
- **API groups.**
  - `providerVolumes`: `create`, `get`, `list`, `attach`, `detach`, `resize` (grow only), `snapshot`, `delete`.
  - `providerSnapshots`: `list`, `delete`, `restore` (= a volume created from a snapshot).
  - `providerAddresses`: `create`, `get`, `list`, `assign`, `unassign`, `delete`.
  - IAM actions follow the `sandboxVolumes` pattern: `volumes:manage`/`volumes:read` at `provider-volume/{id}`.
- **Quota and metering.** Quota is booked in GiB, reusing the `vps.volume.gib.hours` meter. Two new meters:
  `vps.address.hours` and `vps.snapshot.gib.hours`.
- **Detach on delete.** Deleting an instance detaches its provider volumes. It deletes them only if they were created
  with `deleteWithInstance: true`; the switch to selective destroy happens here (DO-D16).
- **Attach without a reboot.** The guest sees the device as `/dev/disk/by-id/scsi-0DO_Volume_<name>`. On an attach
  after boot, bcd mounts it if the instance has an agent; otherwise the cloud-init snippet that `create` renders
  mounts volumes attached at create time.

**Task titles**

1. Core contracts and conformance.
2. DO volumes and volume actions.
3. DO snapshots.
4. DO reserved IPv4 and IPv6.
5. vps tables and migrations.
6. The `vps.providerResources` reconciler.
7. API groups, IAM, quota and meters.
8. Instance-delete semantics and selective destroy.
9. Event families: `providerVolume.*`, `providerAddress.*`.
10. Docs and verification.

**Review Focus seeds**

- A volume attached to a Droplet in another region: `INVALID_INPUT` before any call.
- Resizing to a smaller size: refused.
- Deleting an attached volume: `INVALID_STATE` until it is detached.
- An address assigned to an instance of another tenant: `ACCESS_DENIED`.
- A DO 422 "volume is attached to another droplet": `CONFLICT`.

### P3 — Images, Spot GPU, Bare Metal GPU, MicroVMs, bcd metadata

**Scope:** the rest of R4, plus image parity.

**Design**

- **Images.** `ImageRef` resolution order:
  1. A DO slug (`ubuntu-24-04-x64`, `gpu-h100x1-base`).
  2. A numeric image id (a snapshot or custom image).
  3. A catalog `name@version` (`provision/src/images.ts`), imported as a DO custom image from a short-lived
     presigned BlobStore URL. DO requires a URL it can fetch. The import is recorded in a per-region table
     `provider_images` (`vps/00NN_provider_images`) and transferred to other regions on demand (Image Actions
     `transfer`).
  - GPU sizes refuse non-GPU images with `INVALID_INPUT` before the create.
- **Spot.** Spot offers exist only with `allowSpot: true` (DO-D14). The vps `Preempted` condition is added to the
  condition catalog, with an instance event `instance.preempted`. Pools may set `replacePreempted: true` to recreate
  the instance in place.
- **Bare Metal GPU.** `digitaloceanMetal` (DO-D17): `provides: ['metal']`, with capabilities decided by S4, following
  `hetzner-robot`'s `bootstrap` (the `provisioned` token over SSH stdin, never user data).
- **MicroVMs.** An experimental sandbox backend, behind `previews: true`. It maps sandbox create, pause, resume and
  delete onto MicroVM APIs. It lives in this package but is wired in by the host. The task-level plan must first
  confirm the vps sandbox backend contract can take a provider-backed runtime (a design gate: if it can't, MicroVMs
  move to a follow-up).
- **bcd (Go).** `hardware/capture` reads DO metadata (droplet id, region, tags, interfaces) into inventory sections
  when `169.254.169.254` answers with `DigitalOcean` headers. It never uses metadata for identity. Owners: the bcd
  hardware owner.

**Task titles**

1. Image resolver.
2. Custom image import.
3. Region transfer and the cache table.
4. GPU image guard.
5. Spot offers and preemption detection.
6. `Preempted` condition and replace policy.
7. `digitaloceanMetal`.
8. MicroVM backend (gated).
9. bcd DO metadata capture; docs and verification.

### P4 — Edge: Load Balancers, DNS, certificates, NAT, peering, BYOIP, VPC subnets and routes

**Scope:** the rest of R5.

**Design**

- **Core contracts:** `loadBalancers`, `dns`, `certificates`, plus additive `ProviderNetworks.ensureNatGateway?`,
  `ensurePeering?` and `ensureRoute?`.
- **Load balancers.** `LoadBalancerSpec`:
  - `{ name, region | global, forwarding: [{entry, target, tls?: certificateId}], healthCheck, targetTag, stickySessions?, ipRules? }`
  - Targets are the instances of a pool, by a `bc-pool-<hash>` tag that vps already writes, so scaling never edits
    the LB.
  - Global LBs front regional pools.
- **DNS.** Zones are tenant-owned. vps can publish `<instance>.<zone>` A/AAAA records (`instances.create({ dns })`),
  removed on delete.
- **Certificates.** `managed` certificates (Let's Encrypt, which DO issues only for zones hosted in DO DNS) and
  `custom` ones (PEM in secrets).
- **NAT.** A NAT gateway per VPC enables isolated pools (no public IPv4), matching DOKS isolated worker nodes in P5.
- **BYOIP.** Prefixes are read-only; addresses are allocated from them.
- **VPC subnets and routes (preview).** `networkModel: 'vpc-subnets'` per account. A migration of an existing
  account's networks is **not** automatic: it is a documented operator step.

**API groups:** `loadBalancers.*`, `dnsZones.*` and `dnsRecords.*`, `certificates.*`, plus `networks.natGateway`,
`networks.peer` and `networks.routes`.

**Task titles**

1. Core contracts.
2. DO load balancers (regional).
3. Global load balancers.
4. DNS zones and records.
5. Certificates.
6. NAT gateways.
7. VPC peering.
8. BYOIP addresses.
9. VPC subnets and routes v2 (flagged).
10. vps tables, reconciler extension and APIs.
11. Docs and verification.

**Review Focus seeds**

- An LB whose target tag matches another tenant's Droplets: tags are deployment- and tenant-scoped, so the plan
  tests that cross-tenant matching is impossible.
- A managed certificate for a zone not in DO DNS: refused with `INVALID_INPUT`.
- Deleting a VPC with a NAT gateway: ordered teardown.

### P5 — DOKS as a pool substrate

**Scope:** R6.

**Design**

- **Core contract:** `ProviderImpl.kubernetes?` (`ProviderKubernetes`).
- **Pools.** A vps pool with `substrate: { kind: 'kubernetes', provider: <account>, cluster: { create | adopt } }`.
  1. On create, the pool reconciler runs `ensureCluster`, then `ensureNodePool` per flavor (GPU node pools included,
     and Spot GPU node pools when `allowSpot` is set).
  2. It fetches a short-lived kubeconfig (sealed, never stored plain; refetched on each run).
  3. It applies `provider-kubernetes`'s `bcdDaemonSetManifests` with a `hosted: 'kubernetes'` join token, through the
     server-side apply API.
  4. bcd on each node joins, and compute books the GPUs (DO-D18: bcd's device plugin; DO's default device plugins
     stay off).
- **Isolated worker nodes.** Supported with P4's NAT gateway.
- **Adopt mode.** Takes an existing cluster: no create; deletion never deletes the cluster.
- **Upgrades.** DOKS version upgrades are an operator action (`kubernetesClusters.upgrade`); surge upgrades restart
  bcd pods, and the existing drain semantics hold.

**Task titles**

1. Core contract and conformance.
2. DOKS clusters.
3. Node pools (CPU, GPU, Spot GPU).
4. Kubeconfig sealing and the apply client.
5. Pool substrate reconciler (create and adopt).
6. Join and booking end-to-end on a `FakeDaemon` cluster.
7. Upgrade and delete semantics.
8. Isolated worker nodes.
9. Docs and verification.

**Review Focus seeds**

- A cluster-admin kubeconfig never appears in a row, a log or an event.
- Deleting an adopted cluster's pool leaves the cluster.
- A node pool scaled down by DO's autoscaler: the instances go away cleanly, with no orphaned bookings.

### P6 — Spaces, CDN, NFS, Container Registry

**Scope:** R7.

**Design**

- **Spaces for tenants.** Tenant buckets are `cloudResources` kinds `do.spaces-bucket` and `do.spaces-key` (secret
  outputs: the access key and secret), plus `do.cdn-endpoint` (P7's module is needed only for these kinds; until it
  lands they wait).
- **Spaces for the operator.** `spacesBlobStore({ region, bucket, accessKey: SecretRef, secretKey: SecretRef })`
  implements core `BlobStore` (DO-D19) for daemon downloads, logs and images. It is the presign source for P3's
  custom image import.
- **NFS.** `ProviderVolumes` with `kind: 'shared'`: one share per pool or tenant, mounted by cloud-init / bcd on each
  member, and access points per tenant. Quota is in GiB.
- **DOCR.**
  - An OCI `ImageSource` auth helper: a registry token from `GET /v2/registry/docker-credentials`, sealed and
    short-lived.
  - `provision` resolves `oci://registry.digitalocean.com/...` images with it.
  - Registries, repositories and garbage collection are `cloudResources` kinds.
  - Regional AI image mirrors are used automatically when the region has one.

**Task titles**

1. SigV4 signer and test vectors.
2. `spacesBlobStore`.
3. Bucket and key kinds.
4. CDN kind.
5. NFS shares through `ProviderVolumes`.
6. NFS mounts in pools.
7. DOCR image-source auth.
8. Registry kinds.
9. Docs and verification.

### P7 — `cloud-resources` module and managed data/platform services

**Scope:** R8.

**Module design (`packages/cloud-resources`)**

- **Table** `cloud_resources` (`cloud-resources/0001`): tenant, account, kind, name, spec (JSON), desired_state,
  observed state, outputs, secret output refs, version, conditions, timestamps.
- **Reconciler** `cloud.resources`. Per row:
  1. Calls `ensure`, `get` or `delete`.
  2. Seals any `secretOutputs` in the same run.
  3. Applies updatable-field diffs in place. A non-updatable change is refused at the API with `INVALID_STATE`
     (`reason 'replaceRequired'`).
- **API group `cloudResources`:** `kinds` (catalog with JSON Schemas from each manifest), `create`, `get`, `list`,
  `update`, `delete`, `discover` (unmanaged resources in the account), `adopt`, `release`.
- **IAM.** The resource is `cloud-resource/{id}`, with an attribute `kind`. The actions are per family, for example
  `cloud:data:manage` and `cloud:data:read`, so a policy can allow databases without allowing App Platform.
- **Quota.** A count per kind per tenant, configurable.
- **Events:** `cloudResource.{created,ready,updated,failed,deleted}`.
- **Metering.** Each kind declares meters; a sweep samples DO's own billing units into the usage sink (P9 reconciles
  them).

**DO kinds** (`resources/kinds/*.ts`, each a manifest plus a mapping):

| Area | Kinds |
|---|---|
| Databases, one per engine (Postgres, MySQL, Valkey, MongoDB, Kafka, OpenSearch) | `do.database.<engine>`, each with Standard or Advanced edition (the 2026-10-15 / 11-30 plan changes are encoded in validation), plus `do.database-user`, `do.database-pool`, `do.database-replica`, `do.database-firewall` (trusted sources = instances by tag) |
| Vector Databases | `do.vector-database` |
| App Platform | `do.app`: the App Platform spec is the manifest; deployments are read-only status |
| Functions | `do.functions-namespace`, `do.functions-trigger` |
| Add-Ons, 1-Click | `do.addon`, plus a 1-Click catalog listing |
| Partner Network Connect | `do.partner-attachment` |

**Task titles**

1. Module scaffold and dependency check (DO-D3 gate).
2. Core `ProviderResources` contract and conformance.
3. Table, migration and reconciler.
4. API, IAM, quota and events.
5. Secret sealing.
6. DO registry and dispatcher.
7. Database kinds.
8. Vector DB kind.
9. App Platform kind.
10. Functions kinds.
11. Add-ons, 1-Click and PNC.
12. Docs and verification.

**Review Focus seeds**

- A database password appears only as a `SecretRef`.
- A spec change to a non-updatable field (engine version downgrade, region): `replaceRequired`.
- Deleting a database that still has trusted-source instances: allowed, firewall rules removed first.
- Discover/adopt of a resource another deployment manages: refused.

### P8 — AI platform

**Scope:** R9 (DO-D21).

**Design**

- **Dedicated Inference.** Kind `do.dedicated-inference`. Its GPU count and model are booked against the tenant's GPU
  quota through `capacity`'s quota API, as a non-node booking (an additive `external` booking kind). Its metering uses
  `gpuMeter`.
- **Inference APIs.** Serverless, Batch, Embeddings and Agent inference are metered passthrough. Keys are
  `do.inference-key` resources (sealed). An optional operator proxy route counts tokens into
  `ai.inference.tokens{model}`. A tenant may also call DO directly with its sealed key, in which case usage comes from
  DO billing (P9).
- **Agent Platform.** Knowledge bases, guardrails and model access keys are resources; no agent deploys (ADK is
  deprecated).
- **Managed Agents (preview).** The Harness Runtime, Action Gateway, Signals and MicroVM-backed agents are behind
  `previews: true`; Signals is read-only into attention.

**Task titles**

1. External GPU bookings in capacity (core-adjacent, additive).
2. Dedicated Inference kind.
3. Inference keys and the proxy meter.
4. Agent Platform kinds.
5. Managed Agents kinds (preview).
6. Signals → attention.
7. Docs and verification.

### P9 — Operations and surfaces

**Scope:** R10.

**Design**

- **Monitoring and Insights.** An observability `externalMetrics` source contract (additive). The DO implementation
  pulls Droplet metrics (CPU, memory, disk, bandwidth) for **attached** machines that run no bcd, into the existing
  Prometheus registry with an `instance` label. Alert policies and Insights alert rules are `cloudResources` kinds;
  notification channels can target better-compute webhooks.
- **Uptime.** A `do.uptime-check` kind. The operator's own gateway health checks are an optional platform resource.
- **Billing.** A sweep of balance, billing history and invoices into `iam` usage reconciliation. A per-account drift
  report compares metered better-compute usage with DO's invoice line items, surfaced as an admin attention item when
  drift is over a threshold. Budget alerts can include DO spend.
- **Projects.** `projectPerTenant` (DO-D22).
- **Security.** Findings go to the admin panel's `attention` list, as read-only data.
- **OAuth.** The connect flow (DO-D13): a console page, a callback in server and a sealed refresh token.
- **Organizations.** Read-only team listing on the account page.
- **Surfaces.**
  - CLI: `bc providers digitalocean check|offers|discover`.
  - MCP tools: one per new API route.
  - Console: provider-account pages, network, volume and address pages, and the cloud-resources catalog.
  - Admin panel: a provider-account module descriptor (one line in `lib/modules.ts`), rate-limit budget gauges and
    billing drift.
  - Docs: `guides/vps/providers.mdx` DigitalOcean section, `guides/cloud-resources/*` and `operations/digitalocean.mdx`
    (scopes, budgets, live-test recipe).

**Task titles**

1. `externalMetrics` contract and DO metrics.
2. Alert policies and Insights rules.
3. Uptime.
4. Billing sweep and drift report.
5. Projects per tenant.
6. Security findings.
7. OAuth connect.
8. CLI.
9. MCP.
10. Console pages.
11. Admin module.
12. Docs and final program verification.

---

## Testing strategy

- **Emulator.** `tests/support/do-emulator/` is an in-memory `fetch`, like `GceEmulator`.
  - **Composition:** `index.ts` composes per-service modules (droplets, actions, tags, keys, vpcs, firewalls,
    volumes, …) around shared state: id counters, the tag index, a rate-limit simulator with
    `ratelimit-*` headers, and an action queue whose `remaining` count moves an action to `completed` or `errored`.
  - **Recording:** every request is recorded (`requests`).
  - **Fault hooks:** `failNext(match, status, body)`, `failAction(match, body)`, `beforeAction(hook)`,
    `exhaustBudget()`.
  - **Fixtures:** the 422 bodies and shapes come from P0's fixtures, so the emulator speaks DO's real errors.
- **Contract conformance.** `runConformance(providerConformanceCases(), subject)` for `ProviderImpl`, plus each new
  contract's cases (P2, P4, P5, P7) run against the DO emulator **and** a minimal second fake. That proves the
  contracts are provider-neutral.
- **End-to-end.** One `tests/do-*-end-to-end.test.ts` per phase, through `betterCompute()` on PGlite, with the
  provider wired as a host would wire it.
- **Live suite (DO-D24).** `tests/live/digitalocean.live.test.ts`, skipped unless `BC_DO_LIVE=1` and a token are
  present. It tags everything with a run prefix, sweeps in `afterAll` and asserts zero leftovers. It runs once per
  phase before release, on the cheapest sizes; one GPU run per GPU phase, gated on approval.
- **Security tests that recur in every phase:**
  - `never logs tokens`.
  - A tenant's account refusing `env://` refs.
  - The deletion-safety refusal.
  - Secret outputs sealed.
  - Origin pinning of followed links.

## Out of scope / non-goals

- **Marketplace vendor tooling:** the `vendor_portal` scope.
- **Floating IP endpoints:** the legacy alias of Reserved IPs.
- **New Gradient ADK agent deployments:** deprecated by DO.
- **A DO `cloud-iid` attestor:** no signed identity exists (DO-D12).
- **Mapping DO Droplet Autoscale Pools onto better-compute pools** (DO-D15).
- **DRA GPU drivers on DOKS:** a follow-up after P5 (DO-D18).
- **Automatic migration of existing VPC-model networks to the subnets model.**
- **Terraform-style plan/apply for cloud resources:** the reconciler converges desired state; a dry-run `plan` is
  a follow-up.

## Open questions (resolved by P0 or by the user)

1. **Q1 (P0 S4).** Are Bare Metal GPUs visible or controllable through any public API? This decides whether
   DO-D17 is a provider or a manual enrolment.
2. **Q2 (P0 S2).** Does create without `ssh_keys` still email a root password? DO-D7 assumes yes and always sends a
   key either way.
3. **Q3 (P0 S3).** Can VPC `ip_range`s overlap within one account? If they can't, `networks.create` validates CIDRs
   across a tenant's networks on the same account.
4. **Q4 (user).** Should tenant-owned DO accounts be allowed in P1, or only platform accounts at first? The default
   is both, as GCP allows (ruling F1 does not apply: DO has no ambient credentials).
5. **Q5 (user).** Who owns the bcd Go changes in P3 and P5? The default is the bcd hardware owner and the §3.8
   Kubernetes owner, via the orchestrator.
6. **Q6 (measured in P1's live run).** Is a process-local rate budget enough for a two-process deployment, or does
   P9 need the Postgres-shared budget?

## Sources

- DigitalOcean API reference (60 groups):
  [docs.digitalocean.com/reference/api/reference](https://docs.digitalocean.com/reference/api/reference/)
- Token scopes: [docs.digitalocean.com/reference/api/scopes](https://docs.digitalocean.com/reference/api/scopes/)
- Release notes, Jul–Oct 2026: [docs.digitalocean.com/release-notes/recent](https://docs.digitalocean.com/release-notes/recent/)
- GPU availability: [docs.digitalocean.com/products/droplets/details/gpu-availability](https://docs.digitalocean.com/products/droplets/details/gpu-availability/)
- Managed Agents launch (2026-09):
  [investors.digitalocean.com](https://investors.digitalocean.com/news/news-details/2026/DigitalOcean-Launches-Managed-Agents-Bringing-Agent-Execution-Tool-Access-and-Inference-Together-on-One-Cloud/default.aspx)
- Inference Engine launch (2026-04-28):
  [businesswire.com](https://www.businesswire.com/news/home/20260428279648/en/DigitalOcean-Launches-Inference-Engine-with-New-Capabilities-for-Production-AI-Including-Inference-Router-for-Efficient-Scaling-of-Agentic-Workloads)
