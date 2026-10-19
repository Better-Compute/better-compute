# AWS integration program — master plan

> **For agentic workers:** This is a **program plan**: it fixes the requirements, the design decisions, the package
> boundaries, the contracts and the phase order for the whole AWS integration. Executable TDD plans exist for the
> first lanes, and each later phase gets its own plan, written from its section here when it starts:
>
> | Plan | Phases | Status |
> |---|---|---|
> | [`2026-10-18-aws-a0-a1-foundation-ec2.md`](2026-10-18-aws-a0-a1-foundation-ec2.md) | A0 `aws-core`, A1 EC2 provider | Ready to execute |
> | [`2026-10-18-aws-a8-platform-services.md`](2026-10-18-aws-a8-platform-services.md) | A8 KMS, Secrets Manager, S3, EventBridge… | Ready to execute (after A0) |
> | *(to write at phase start)* | A2–A7, A9–A12 | Outlined below, with contracts and test names |
>
> REQUIRED SUB-SKILL for the executable plans: superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** better-compute treats Amazon Web Services as a first-class place to run capacity and to run itself:
- EC2 capacity (on-demand, Spot, On-Demand Capacity Reservations, Capacity Blocks for ML) as provider pools that
  tenants spin up, attach to and control.
- AWS networking (VPC, subnets, security groups) and block storage (EBS) as tenant resources.
- EC2 instances and EC2 bare metal joining as bcd hosts, with cloud instance identity.
- Every AWS platform service that fits an existing extension seam behind that seam: KMS, Secrets Manager, S3,
  EventBridge, SNS, SQS, Kinesis, Firehose, ACM Private CA, RDS IAM auth, CloudWatch.
- A reference deployment of the control plane on AWS, plus an opt-in live test suite.

**Architecture:** Three new packages, all leaves of the dependency graph:
- `@better-compute/aws-core` is zero-dependency AWS plumbing: SigV4, credential sources, partitions and endpoints,
  the five AWS wire protocols, a safe XML reader, and error mapping.
- `@better-compute/provider-aws` is the EC2 `ProviderDefinition`, modelled on `provider-gcp`, plus its CLI commands
  (IAM policy, trust policy and EventBridge rule generators).
- `@better-compute/aws` holds the host-level extensions for AWS platform services (secret stores, blob stores, sinks,
  CAs, the RDS IAM pool, EMF metrics, deployment templates).

Generic behavior goes upstream into `vps` and `core` through **additive** contract members: zone-scoped subnets,
provider events, provider volumes, placement. GCP and later providers then inherit the same features. AWS-specific
code never leaks into `vps`, `capacity` or `server`.

**Tech Stack:** TypeScript (ESM, Node ≥ 22.12), pnpm workspace, vitest on PGlite, Standard-Schema manifests,
`node:crypto` (HMAC-SHA256, SHA-256, gzip via `node:zlib`), Go 1.27 (bcd) for host-side pieces. **No new npm
dependencies** (AQ1).

**Spec:** No separate spec file. The requirements are the user's request of 2026-10-18 ("expand to AWS with an
integration … integrate all services of AWS"), restated under Requirements, plus the codebase findings under Current
state. The GCP plan ([`2026-10-17-gcp-attach-reservations-networks.md`](2026-10-17-gcp-attach-reservations-networks.md))
is the precedent: its decisions D1–D13 carry over unless a decision below overrides one.

---

## 0. What "integrate all services of AWS" means here

AWS sells more than 200 services. Most are not about compute capacity: think Rekognition, Connect, Ground Station
or QuickSight. Writing adapters for them would add code with no better-compute behavior behind it. So every AWS
service is given exactly one **disposition**, and [Appendix A](#appendix-a--aws-service-catalog) lists them all:

| Disposition | Meaning | Count of services (approx.) |
|---|---|---|
| **Integrate** | Bespoke code behind a better-compute seam, with tests and an emulator. | ~35 |
| **Interoperate** | Works through a generic seam with configuration and docs only. Typical cases: anything that consumes EventBridge events, S3 objects, OTLP or OIDC tokens. | ~30 |
| **Deploy-on** | Used by the reference control-plane deployment (A12). | ~15 |
| **Defer** | Needs a generic better-compute feature first, which is named (e.g. a `loadBalancers` group, a DNS seam). | ~10 |
| **Out of scope** | Not a compute-capacity concern; the reason is stated. Still reachable through EventBridge and S3 interop. | the rest |

Through the interop layer, *every* AWS service can still react to better-compute: events go out to EventBridge,
audit goes to S3 and Firehose, metrics go out as CloudWatch EMF or OTLP, and workloads use IAM roles via OIDC. That
is how "all services" is met without a few hundred adapters.

---

## 1. Requirements

| # | Requirement |
|---|---|
| R1 | **EC2 provider.** An operator registers an AWS account (platform-owned or a tenant's own account) as a provider account. Tenants create, list, start, stop, reboot, reinstall and delete EC2 instances through provider pools, exactly as with GCP and Hetzner. |
| R2 | **Attach.** Running EC2 instances can be discovered and attached to a tenant without being recreated. Detach leaves them running (GCP D5/D6 semantics). |
| R3 | **Capacity markets.** On-demand, Spot, ODCR (targeted and open, including ones shared via RAM) and Capacity Blocks for ML are offers. A bound reservation is admission-checked so it is never over-committed. Spot interruptions are visible and handled. |
| R4 | **Networks.** Tenants build VPCs, AZ-scoped subnets and firewall rules (security groups and NACLs) through the existing `networks`/`firewallRules` API. |
| R5 | **Block storage.** Tenants create, attach, resize, snapshot and delete EBS volumes through a new generic `disks` API. |
| R6 | **Hosts on AWS.** EC2 instances (including `*.metal`) join as bcd nodes using cloud instance identity, so they can host GPUs, VMs and sandboxes. |
| R7 | **Identity.** Tenants onboard their own AWS accounts safely (cross-account role + platform-assigned ExternalId). Workloads in better-compute instances can assume AWS IAM roles with no static keys. |
| R8 | **Platform services.** The control plane can use KMS, Secrets Manager / SSM Parameter Store, S3, EventBridge, SNS, SQS, Kinesis, Firehose, ACM Private CA, RDS/Aurora with IAM auth and CloudWatch, each through an existing seam. |
| R9 | **Event-driven reconciliation.** EC2 state changes, Spot interruption warnings, rebalance recommendations, scheduled maintenance and Health events reach better-compute within seconds, without polling every instance. |
| R10 | **Kubernetes on AWS.** bcd runs on EKS GPU nodes (hosted DaemonSet), and EC2 instances that provider-aws creates can join an EKS cluster. |
| R11 | **ML fabric and FinOps.** Cluster placement groups, EFA, Trainium/Inferentia, Graviton; plus provider cost reporting, quotas, Organizations import, and (if unblocked) Marketplace metering. |
| R12 | **Run on AWS.** A reference deployment (ECS Fargate + Aurora PostgreSQL + NLB/ALB + KMS + S3), plus an opt-in live test suite against a real sandbox AWS account. |

## 2. Current state (verified 2026-10-18)

- **Provider contract** is in `packages/core/src/extension.ts:609-877`:
  - `ProviderImpl` (783-848) requires `listOffers`/`create`/`get`/`delete`. Everything else is optional and
    **gated by method presence**; `capabilities` is never read at runtime.
  - `defineProvider` (`packages/vps/src/provider.ts:25`) allows only the keys `id, version, provides, config,
    capabilities, create`.
  - `ProviderContext.account` carries `{ id, tenantId, platform }`. `CallContext.idempotencyKey` is the instance row
    id.
- **provider-gcp** (`packages/provider-gcp/src/*`, 2601 lines) is the template:
  - It uses REST with plain `fetch` (no SDK) behind a `TokenSource`.
  - Ambient credentials are allowed only for platform accounts (ruling F1, `provider.ts:27-57`).
  - Ownership labels guard `delete`, `power` and `setTags`. Long operations are polled across reconciler runs.
  - It is tested against an in-process emulator (`tests/support/gce-emulator.ts`) and `providerConformanceCases()`
    (`packages/vps/src/conformance.ts:123`).
- **vps** already owns:
  - provider accounts (`accounts.ts`, which checks for inline secrets);
  - discovery (`vps/0023`), attach (`vps/0024`), provider reservations (`vps/0025`) and tenant networks (`vps/0026`);
  - the reconcilers `vps.discovery`, `vps.reservations` and `vps.networks`.

  The next free migration is `vps/0027`.
- **vps networks are GCP-shaped:**
  - `zoneRegion()` (`vps/src/networks.ts:884`) strips `-[a-z]$`. That leaves `us-east-1a` unchanged, while the
    region should be `us-east-1`.
  - `networkProvider` reads `account.config.zones` (`networks.ts:877`).
  - Subnets are regional and firewall rules target tags with allow/deny + priority.
- **AWS code today:**
  - `packages/pki/src/attestors/cloud-iid.ts:389` `awsInstanceIdentity()` verifies the IID document plus its
    `/signature` (RSA-SHA256, host-supplied certificates, a 30-minute `pendingTime` window, single use).
  - Nothing produces that evidence: bcd only supports join-token, provisioned and tpm (`daemon/cmd/bcd/main.go:90`).
  - No resolver maps an AWS instance to a pool.
  - The repo has no other AWS code, and PLAN.md's roadmap has no AWS entry (§16, L1922-1927 lists only GCP provider
    depth).
- **Seams that are ready as-is:**
  - `EventSink` / `AuditSink` (`extension.ts:445-456`), with durable per-sink cursors and bisecting retries.
  - `BlobStore` (502).
  - `SnapshotStore` (`vps/src/snapshots.ts:30`).
  - `CertificateAuthority` (549).
  - `postgres({ pool })`, which accepts an async password (an RDS IAM token).
  - `TelemetrySpec.otlpEndpoint` (`core/src/domain.ts:769`).
  - The workload OIDC issuer (`pki/src/workload.ts:91`, https only).
- **Seams with gaps:**
  - `SecretRef` is the closed union `secret|vault|env` (`core/src/manifest.ts:51`).
  - `localSealedSecretStore` has no KMS hook, though it accepts `keys`.
  - Usage sinks are refused at startup (`server/src/options.ts:416-419`).
  - Providers have no volumes, events, placement or spot interruption.
  - bcd's guest IMDS uses `x-bc-metadata-token`, not AWS's header.
  - `k8s-join` is kubeadm-only.
- **Dependency rules** (`scripts/check-deps.mjs`):
  - No package may import a `provider-*` (rule 4), and the server never depends on one (rule 1).
  - Workspace dependencies must equal the tsconfig references (rule 3).
  - Provider CLI commands ship as structural `CommandSpec`s from the provider package, as
    `provider-kubernetes/src/cli.ts` does.

## 3. Design decisions

| # | Decision | Why |
|---|---|---|
| AD1 | **Three leaf packages.** `aws-core` (plumbing), `provider-aws` (EC2 `ProviderDefinition` + CLI commands) and `aws` (platform-service extensions). A new check-deps rule 5: only `provider-aws` and `aws` may depend on `aws-core`, and nothing in `packages/` may depend on `aws` or `provider-aws`. | It mirrors the provider isolation rule. A host that never uses AWS ships no AWS code, and `server` stays cloud-neutral. |
| AD2 | **No AWS SDK.** `aws-core` implements SigV4 (header and presigned query), plus the protocols `ec2`, `query`, `json` (1.0/1.1), `rest-json` and `rest-xml`. It does not implement SigV4a, event streams, CBOR or the S3 Express session auth. | Precedent: GCP D2 and the no-new-deps coordination rule. The ~50 operations we call fit in roughly 2.5k lines, and dependency-free code keeps supply-chain review small. AQ1 records the SDK alternative. |
| AD3 | **One provider account = one AWS account × one region.** A multi-region fleet is several accounts with the same credentials. Config keeps a `zones` key (AZ *names* as this account sees them) because vps reads it. | Quotas, AMIs, VPCs and reservations are all regional, and every reconciler run stays bounded. AZ names differ between AWS accounts, so `zoneId` is recorded too (AD5). |
| AD4 | **Credentials.** Ambient credentials (container, web identity, IMDS, environment) are for **platform accounts only** (F1). A tenant account uses `assumeRoleArn`, optionally hopping from the platform identity; a static key `SecretRef` is allowed but discouraged. The **ExternalId is platform-assigned**: `<externalIdPrefix>:<providerAccountId>`, never supplied by the tenant. `assumeRoleArn` must name a different AWS account than the platform's own accounts. After AssumeRole, `GetCallerIdentity` must return the role's account. | This closes the confused-deputy hole: tenant A naming tenant B's role, or a platform role, gets nothing. It follows AWS's third-party-access guidance. |
| AD5 | **Ids.** The machine id is the EC2 instance id `i-…`. The offer id grammar is `<az>/<instanceType>[@<cr-id>][:spot]`. The idempotency `ClientToken` is `hex(sha256(idempotencyKey))[0:64]`. `ExternalMachine.labels` carries `topology.aws/zone-id`. | `create` gets everything it needs from the offer alone (GCP D3). The ClientToken makes retried creates safe, and `get` can find a pending create through the `client-token` filter. |
| AD6 | **Ownership tags.** `better-compute:managed`, `:instance`, `:tenant`, `:pool` and `:network`. The provider refuses `delete`, `power`, `reinstall` and `setTags` without the right tag (GCP D4). In addition, `aws iam-policy` generates an **ABAC** IAM policy (`ec2:ResourceTag/better-compute:managed`, `aws:RequestTag`), so AWS refuses those calls even if the control plane has a bug. | Defense in depth: the guard does not rest only on our code. |
| AD7 | **Images.** An `ImageRef` (a string) may be: `ami-…`; `resolve:ssm:<parameter>` (EC2 resolves it at launch); or one of the aliases `ubuntu-24.04`, `ubuntu-22.04`, `al2023`, `dlami-gpu`, `eks-al2023-<k8s>`, expanded **per instance architecture** to the public SSM parameter. | No `DescribeImages` scans and no AMI-id tables to maintain. Graviton gets arm64 images automatically. |
| AD8 | **Hardened defaults.** IMDSv2 required (`HttpTokens=required`), hop limit 1 (2 when the pool runs containers), instance-metadata tags off, encrypted root EBS (account default key or `kmsKeyId`), `InstanceInitiatedShutdownBehavior=stop`. | These are the CIS / AWS Foundational Security controls (EC2.8, EC2.7) by default. |
| AD9 | **User data.** A MIME multipart is built only when `sshKeys` are given: the vps payload plus a `text/cloud-config` part with `ssh_authorized_keys`. It is gzipped when the raw size exceeds 16 384 bytes, and refused (`INVALID_INPUT`, reason `user-data-too-large`) if still too big. | EC2's hard limit is 16 KiB before base64, and the bootstrap payload carries pins and sealed refs. |
| AD10 | **Networks.** A tenant network is a VPC. Subnets are **AZ-scoped** (additive core: `ProviderNetworks.subnetScope`, `ProviderSubnetSpec.zone`). Firewall rules compile onto one security group per targeted instance (`bc-<sha256(instanceId)[0:16]>`, the existing tag) plus one network-wide SG. Each SG rule is tagged with its firewall name. `deny` is supported only network-wide, as NACL entries; a targeted deny is `UNSUPPORTED` (reason `aws-targeted-deny`). | Every ENI carries at most 2 better-compute SGs (the default limit is 5). Rules stay attributable, and AWS's allow-only SG model is respected instead of faked. |
| AD11 | **Reservations.** ODCR and Capacity Blocks are both `ExternalReservation`s. `specificOnly` means targeted. A Capacity Block launch sets `MarketType=capacity-block`. **Purchasing** (Capacity Blocks, new ODCRs) uses separate optional methods, **off by default**, root-only, with `CONFIRMATION_REQUIRED` and idempotency. | Reading capacity is safe; spending money needs an explicit, auditable operator act (AQ5). |
| AD12 | **Event intake.** A customer-owned EventBridge rule set feeds an SQS queue. A generic `vps.providerEvents` reconciler polls each account through the additive `ProviderImpl.pollEvents?`. Each event is authenticated by AWS account id, a `source` allow-list and a queue policy pinned to the rule ARNs. Polling stays the **source of truth**; events only wake reconcilers early. | P1 ("never a source of truth" for wake-ups). A forged message can at worst cause an early, harmless re-read, never a state change. |
| AD13 | **EBS** goes through an additive `ProviderVolumes` contract and a new generic vps `disks` group, not the host-local `sandboxVolumes`. | GCP persistent disks can implement the same contract later. Sandbox volumes are host-local qcow2 and a different thing. |
| AD14 | **EC2 hosts join with cloud-iid** (the signature variant first, PKCS7 `rsa2048` later). The resolver admits only instances that this control plane created or attached into a pool with `agent:'bcd'`. Admitting any instance in an AWS account is opt-in (pool policy `cloudJoin: 'account'`). | An AWS account often contains instances we must never adopt. |
| AD15 | **Platform services need zero core changes.** Secrets Manager serves the existing `secret` scheme under the sub-namespace `secret://aws-sm/…` (AQ3). KMS wraps local-sealed's sealing keys. S3, EventBridge and the rest implement the existing interfaces. | Core is frozen except for additive edits, and none are needed here. |
| AD16 | New API rows use `ApiPhase` `'v1.0'` and module `'vps'` (GCP D12). New event families go in `packages/events/src/catalog.ts`. | `ApiPhase` is a closed union (`catalog.ts:288`). |
| AD17 | **Verification.** An in-process AWS emulator per service, injected through `fetch` (as `gce-emulator.ts` is). SigV4 is pinned with the official AWS SigV4 test-suite vectors (Apache-2.0). An opt-in **live suite** runs in a dedicated sandbox account, with an instance-type allow-list, a spend cap and a tag-based sweeper. | The emulator proves behavior, the vectors prove signing, and the live suite catches AWS drift. |
| AD18 | **Partition-aware from day one** (`aws`, `aws-cn`, `aws-us-gov`): ARNs, endpoint DNS suffixes and FIPS endpoints. Only `aws` is live-tested (AQ8). | Retrofitting partitions later touches every ARN and endpoint. |

## 4. Architecture

```
                          ┌──────────────── host application (examples/, legionedge, cli serve) ────────────────┐
                          │ betterCompute({ modules: [vps({ providers: [aws, gcp, …] }), …],                      │
                          │                 secrets: [awsSecretsManagerStore(…)], sinks: { events: [eventBridgeSink]}, │
                          │                 audit: [s3AuditSink], blob: s3BlobStore(…) })                         │
                          └───────────────┬─────────────────────────────────┬───────────────────────────────────────┘
                                          │                                 │
                     ┌────────────────────▼─────────┐        ┌──────────────▼───────────────┐
                     │ @better-compute/provider-aws │        │ @better-compute/aws          │
                     │  EC2 compute, offers, attach │        │  secrets / kms / s3 / events │
                     │  reservations, spot, networks│        │  acm-pca / rds / emf / deploy│
                     │  volumes, events, CLI cmds   │        └──────────────┬───────────────┘
                     └───────┬───────────────┬──────┘                       │
                             │               │                              │
                ┌────────────▼───┐   ┌───────▼────────────────────────────▼─┐
                │ core, vps      │   │ @better-compute/aws-core (zero deps)  │
                │ (additive only)│   │  sigv4 · credentials · endpoints      │
                └────────────────┘   │  protocols · xml · errors · paginate  │
                                     └───────────────────────────────────────┘
   Go daemon (bcd): daemon/internal/cloud/aws (IMDSv2 client, IID evidence, spot notices, EC2 inventory labels),
                    daemon/internal/imds (AWS-compatible credential endpoints for guests, A7)
```

**Data flow for an EC2 instance** (A1):
1. A `instances.create` call on a provider pool backed by an `aws` provider account writes a `scheduling` row.
2. `reconcileProvider` calls `ProviderImpl.create` outside any transaction. That is a `RunInstances` call with the
   ClientToken, tags, IMDSv2, encrypted EBS and the resolved image.
3. The `i-…` id is stored, and `get` polls (`DescribeInstances`) every 10 s while the machine is changing state and
   every 60 s when steady.
4. A4 adds an early wake: an EventBridge state-change event lands in SQS, `vps.providerEvents` reads it and enqueues
   the instance at once.

## 5. Security model

| Threat | Control | Phase / test |
|---|---|---|
| A tenant config names another tenant's or the platform's IAM role (confused deputy) | AD4: platform-assigned ExternalId, refusal when the role is in a platform account, post-assume identity check | A1 Task 8 `refuses an assumeRoleArn in the platform account` |
| A control-plane bug deletes an instance better-compute does not own | AD6 tag guard, plus the ABAC IAM policy | A1 Task 10/14 |
| Forged SQS message forces drains or deletes | AD12: account + source allow-list + queue policy; events only enqueue reads | A4 `drops an event from a foreign account` |
| Accidental spend (Capacity Block purchase, large instance) | AD11 purchases off by default, root-only, `CONFIRMATION_REQUIRED`, ClientToken idempotency; flavors/quotas cap instance types | A3 `purchase requires confirmation and is idempotent` |
| Credentials leak through logs, errors, config or API reads | Secrets are refs only (`assertNoInlineSecrets`); `aws-core` redacts `Authorization`, `X-Amz-Security-Token`, `X-Amz-Signature` and credential JSON; a test sweeps every log line and error | A0 Task 5 `never logs credentials` |
| SSRF through region strings, endpoints, container-credential URIs or IID cert URLs | A strict region regex (A0 Task 3 `assertRegion`, the only path from config text to an endpoint host); endpoint overrides are host options only, never account config; the container-credential full URI is restricted to loopback, `169.254.170.2` and `169.254.170.23` | A0 Task 3 (regions), Task 5 (container URI) |
| XML entity expansion / billion laughs from a malicious endpoint | The XML reader refuses `<!DOCTYPE` and `<!ENTITY`, caps depth at 64 and the document at 16 MiB | A0 Task 1 |
| A guest steals another tenant's AWS role (A7) | Pool policy allow-list of role ARNs, **and** a generated trust policy that pins `sub` to `t:<tenantId>:instance:*` and `aud` to `sts.amazonaws.com` | A7 `refuses a role ARN outside the pool allow-list` |
| An EC2 instance in the account joins as a node uninvited (A6) | AD14: admit only recorded instances; single-use IID; 30-minute window | A6 `refuses an unrecorded instance` |
| Clock skew makes requests fail or replayable | One retry with the offset from the server `Date` header; never more | A0 Task 5 |

## 6. Phases

Dependency graph (→ means "needs"):

```
A0 aws-core ──► A1 EC2 provider ──► A2 networks ─────────┐
   │                 ├──► A3 capacity markets ──────────┼──► A10 ML fabric
   │                 ├──► A4 event intake + spot ───────┘
   │                 ├──► A5 EBS disks
   │                 ├──► A7 identity (TS half) ◄── A6 hosts (Go half can start at once)
   │                 ├──► A9 EKS ◄── A6
   │                 └──► A11 FinOps & governance
   └──► A8 platform services ──► A12 deploy on AWS + live suite
```

Parallel lanes once A0 lands:
- **L1:** A1, then A2/A3/A4/A5.
- **L2:** A8.
- **L3:** the Go half of A6. It needs no TypeScript because the evidence format is already fixed by `cloud-iid.ts`,
  so it can start on day one.

Lanes never edit the same files. All additive core edits go through one session at a time
(`.claude/coordination.md`).

### A0 — `aws-core` foundation · *executable plan:* [`2026-10-18-aws-a0-a1-foundation-ec2.md`](2026-10-18-aws-a0-a1-foundation-ec2.md) Tasks 1–6

SigV4 (headers and presigned), credential sources and their cache, partitions, endpoints and region validation,
the five protocols, the safe XML reader, error mapping, the clock-skew retry, pagination. Part of the emulator
(STS, IMDS, container credentials) is built here too. **Exit:** the SigV4 vectors pass, and the credential-chain and
protocol suites pass against the emulator.

### A1 — EC2 provider · *executable plan:* same file, Tasks 7–15

`provider-aws` with `listOffers`, `create`, `get`, `delete`, `power`, `reinstall` (replace-root-volume), `list`,
`discover`, `claim` and `release`. It also covers the F1/AD4 credential rules, the conformance suite, a vps
end-to-end test (create, attach, detach, delete through a provider pool), the CLI `aws iam-policy` and
`aws trust-policy`, and docs. **Exit:** `providerConformanceCases()` is green; `tests/aws-end-to-end.test.ts` is
green.

### A2 — Networks (VPC, subnets, security groups, NACLs)

**Contract changes (additive, core):**
```ts
// extension.ts
export interface ProviderSubnetSpec { /* existing */ zone?: string }             // AZ for zone-scoped providers
export interface ProviderNetworkSpec { /* existing */ cidr?: string }            // VPC primary CIDR
export interface ProviderNetworks {
  /* existing */
  /** 'zone': subnets live in one zone and `ensureSubnet` gets `zone`. Default 'region'. */
  readonly subnetScope?: 'region' | 'zone';
  /** How `deny` rules are honored: natively (GCP), network-wide only (AWS NACL) or not at all. Default 'native'. */
  readonly denyRules?: 'native' | 'network-wide' | 'none';
}
export interface ProviderImpl { /* existing */ zoneRegion?(zone: string): string }
```
**vps:**
- `networks.ts` call sites use `client.zoneRegion?.(z) ?? zoneRegion(z)`.
- `networks.addSubnet` takes `zone` (required when `subnetScope==='zone'`, and it must be one of the account's
  `zones`).
- `networks.create` takes an optional `cidr` (default `10.64.0.0/16`).
- `firewallRules.create` refuses a targeted deny up front with `UNSUPPORTED` when `denyRules!=='native'`, so the
  tenant learns at the API, not in a reconciler error.

**provider-aws `src/networks.ts` (`AwsNetworks implements ProviderNetworks`):**
- **`ensureNetwork`:** `CreateVpc` (tag `better-compute:network=<name>`), `CreateInternetGateway` +
  `AttachInternetGateway`, a main route table with `0.0.0.0/0 → igw`, `ModifyVpcAttribute` DNS
  support/hostnames. All idempotent by looking up the tag first.
- **`ensureSubnet`:** `AssociateVpcCidrBlock` when the CIDR falls outside the VPC CIDRs (RFC 1918 or `100.64/10`
  only; otherwise `INVALID_INPUT`). Then `CreateSubnet` with `AvailabilityZone`, and `MapPublicIpOnLaunch` from
  config. `privateGoogleAccess` maps to S3 + DynamoDB gateway endpoints (renamed in docs as "private service
  access").
- **`ensureFirewall`:**
  - Targeted rules get the per-instance SGs `bc-<hash>` (created on demand). Untargeted rules go to `bc-net-<name>`.
  - `AuthorizeSecurityGroupIngress`/`Egress` takes `TagSpecifications` `better-compute:firewall=<name>`.
  - Each SG's rule set is diffed by rule tag, then `RevokeSecurityGroup*` by `SecurityGroupRuleId`.
  - Network-wide deny becomes NACL entries, with rule numbers = `100 + priority/10` (collisions shift up; `INVALID_INPUT`
    past 32766).
- **`setTags`:** `ModifyInstanceAttribute Groups=[…non-bc SGs, bc SGs]` on the primary ENI (`ModifyNetworkInterfaceAttribute`
  for multi-ENI). It refuses `QUOTA_EXCEEDED` past the account's SGs-per-ENI.
- **Deletes:**
  - Order: rules → SGs (`DependencyViolation` → `pending`) → subnets → IGW detach/delete → route tables → VPC.
  - Gateway endpoints are removed before the VPC.
- **Optional:** an `ipamPoolId` config allocates VPC CIDRs from AWS IPAM.

**Tests:**
- `tests/provider-aws-networks.test.ts`:
  - `creates a VPC with an internet gateway and a default route`
  - `zone-scoped subnet lands in its AZ and adds a secondary CIDR when needed`
  - `targeted allow rules land on the per-instance security group, tagged by firewall`
  - `network-wide deny compiles to NACL entries in priority order`
  - `targeted deny is UNSUPPORTED`
  - `setTags keeps foreign security groups`
  - `delete survives DependencyViolation and finishes in order`
- `tests/vps-networks-zone-scope.test.ts`:
  - `addSubnet requires a zone for zone-scoped providers`
  - `zoneRegion uses the provider's mapping`
  - `GCP behavior is unchanged`

**Exit:** a tenant creates a VPC, a subnet and rules, and a VM lands in them, end to end on the emulator.

### A3 — Capacity markets (ODCR, Capacity Blocks, Spot, quotas, pricing)

**Contract changes (additive):**
```ts
export interface Offer { /* existing */ market?: 'on-demand' | 'spot' | 'reserved' | 'capacity-block'; arch?: 'x86_64' | 'arm64';
  /** Free slots when known (reservations; quota headroom in instances). */ count?: number }
export interface ExternalMachine { /* existing */ market?: Offer['market'];
  interruption?: { kind: 'spot' | 'capacity-block-end' | 'maintenance'; at: number; action?: 'terminate' | 'stop' | 'hibernate' } }
export interface ReservationOfferingQuery { instanceType: string; count: number; durationHours: number; earliestStart?: number; latestStart?: number }
export interface ReservationOffering { id: string; instanceType: string; zone: string; count: number; startsAt: number; endsAt: number; upfrontPrice: number; currency: string }
export interface ProviderImpl { /* existing */
  listReservationOfferings?(query: ReservationOfferingQuery, context: CallContext): Promise<ReservationOffering[]>;
  /** Spends money. vps calls it only for a root caller, after confirmation, with a stable idempotencyKey. */
  purchaseReservation?(offeringId: string, context: CallContext): Promise<ExternalReservation>;
}
```
**provider-aws:**
- **`listReservations`:** `DescribeCapacityReservations` (own and RAM-shared ones, `OwnerId`≠account ⇒
  `shared:true`). State map:

  | ODCR state | `ExternalReservation.state` |
  |---|---|
  | `active` | `ready` |
  | `scheduled`, `payment-pending`, `assessing`, `delayed` | `scheduled` |
  | `pending` | `creating` |
  | `expired`, `cancelled`, `failed` | omitted |

  Capacity Blocks (`ReservationType=capacity-block`) are prefixed `cb:`. `total=TotalInstanceCount`,
  `inUse=Total−AvailableInstanceCount`, `startsAt/endsAt` from `StartDate/EndDate`.
- **Create** with `@cr-…` sets `CapacityReservationSpecification.CapacityReservationTarget`. For a block it adds
  `InstanceMarketOptions.MarketType=capacity-block`.
- **Spot:**
  - Offers `:spot` are emitted when `spot: true` in config. Create sets `MarketType=spot`, one-time,
    `InstanceInterruptionBehavior=terminate`.
  - `get` maps `StateReason.Code=Server.SpotInstanceTermination` to `state:'deleted'` with
    `interruption.kind='spot'`.
- **Quotas:**
  - Service Quotas `GetServiceQuota` for the vCPU families (standard `L-1216C47A`, G/VT `L-DB2E81BA`, P `L-417A185B`,
    plus Spot equivalents; **(verify)** the codes).
  - Usage = the sum of `VCpuInfo.DefaultVCpus` over non-terminated instances, cached 5 min.
  - `Offer.count = floor(headroom / vcpu)`; `available = count > 0`.
- **Pricing** (`pricing: 'off' | 'on-demand' | 'all'`):
  - Price List `GetProducts` (JSON 1.1, endpoint `api.pricing.us-east-1.amazonaws.com`), filtered by `regionCode`,
    `instanceType`, `operatingSystem=Linux`, `tenancy=Shared`, `preInstalledSw=NA`, `capacitystatus=Used`, cached
    24 h.
  - `DescribeSpotPriceHistory` (latest per AZ and type) for `:spot`.
  - Failures leave `pricePerHour` unset; they never fail `listOffers`.
- **Purchase:**
  - `DescribeCapacityBlockOfferings` / `PurchaseCapacityBlock` (and `CreateCapacityReservation` for ODCRs), gated by
    config `allowPurchases` (default false).
  - The ClientToken comes from the idempotencyKey.

**vps:**
- `providerAccounts.reservationOfferings` and `providerAccounts.purchaseReservation`:
  - root-only, new action `compute:providerAccounts:purchase`;
  - IAM confirmation (`CONFIRMATION_REQUIRED`);
  - the `vps/0027_provider_purchases` table (request id, offering, state, provider reservation id) gives
    exactly-once purchases across retries.
- Spot instances carry `instances.market`. Usage meters get `.spot` variants (`vps.vcpu.spot.hours`), following
  capacity's `gpu.<model>.spot.hours` convention.

**Tests:**
- `tests/provider-aws-capacity.test.ts`:
  - `maps ODCRs and capacity blocks to ExternalReservation`
  - `shared ODCRs are marked shared`
  - `reservation offers set the capacity reservation target`
  - `capacity block launches set the market type`
  - `spot termination surfaces as an interruption`
  - `quota headroom limits offer count`
  - `pricing failure leaves price unset`
- `tests/vps-provider-purchases.test.ts`:
  - `purchase requires confirmation and is idempotent`
  - `non-root purchase is ACCESS_DENIED`
  - `allowPurchases=false refuses`

**Exit:** the GCP plan's reservation admission (`claimReservationSlot`) covers ODCRs and blocks unchanged:
`admits only the free slots between polls`, re-run for AWS.

### A4 — Event intake, Spot interruptions, maintenance

**Contract changes (additive):**
```ts
export interface ProviderEvent {
  id: string;                                   // provider event id (dedupe)
  kind: 'machine-changed' | 'interruption-warning' | 'rebalance-recommended' | 'maintenance-scheduled'
      | 'reservation-changed' | 'health' | 'api-call';
  machineId?: string; reservationId?: string; at: number;
  deadline?: number;                            // interruption / maintenance time
  details?: Readonly<Record<string, string>>;
}
export interface ProviderEventBatch { events: readonly ProviderEvent[]; ack(): Promise<void> }
export interface ProviderImpl { /* existing */
  /** Long-polls for at most `waitMs` (≤ 10 000); vps acks after its transaction commits. */
  pollEvents?(context: CallContext, options: { waitMs: number; max: number }): Promise<ProviderEventBatch>;
}
```
**vps:**
- A new reconciler `vps.providerEvents` runs `periodic every: 15s`, shards per account, and gives each run ≤ 20 s.
- **Event handling:**

  | Event | Effect |
  |---|---|
  | `machine-changed` | Enqueue `reconcileProvider` for the instance (no state written from the event). |
  | `interruption-warning` | Instance condition `interruption-pending{deadline}`; event `instance.interruption`. If the instance backs a bcd node (A6), the node gets a `NoSchedule` taint `aws.spot/interruption` and capacity drains its reservations through the existing spot preemption path (`capacity/src/spot.ts`). |
  | `maintenance-scheduled` | Condition + `instance.maintenance` event. |
  | `reservation-changed` | Enqueue `vps.reservations` for the account. |
  | `api-call` | CloudTrail, e.g. an out-of-band `TerminateInstances` on a managed instance: enqueue the reconcile. |

- Unknown machines are ignored, and duplicate ids are dropped (`provider_event_seen`, `vps/0028`, pruned after 24 h).

**provider-aws:**
- **`pollEvents`:** SQS `ReceiveMessage` (`WaitTimeSeconds=min(waitMs/1000,10)`, `MaxNumberOfMessages=10`). It parses
  the EventBridge envelopes and drops any whose `account` ≠ the account's AWS id or whose `source` is not in
  {`aws.ec2`, `aws.health`, `aws.cloudtrail`?, `aws.guardduty`?}.
- **Detail-type map:**

  | `detail-type` | `ProviderEvent.kind` |
  |---|---|
  | `EC2 Instance State-change Notification` | `machine-changed` |
  | `EC2 Spot Instance Interruption Warning` | `interruption-warning` |
  | `EC2 Instance Rebalance Recommendation` | `rebalance-recommended` |
  | `AWS Health Event` (service `EC2`) | `maintenance-scheduled` |

  Capacity Reservation events are `reservation-changed`; **(verify)** their detail-types.
- **`ack`:** `DeleteMessageBatch`.
- **Without a queue,** `discover`/`list` passes add `DescribeInstanceStatus` scheduled events every 5 min.

**CLI:** `aws event-rules --queue-name … --account …` renders a CloudFormation JSON stack: the SQS queue (SSE-SQS,
14-day retention, DLQ), the EventBridge rules, and a queue policy allowing only `events.amazonaws.com` with
`aws:SourceArn` equal to the rule ARNs.

**Tests:**
- `tests/provider-aws-events.test.ts`:
  - `maps EventBridge detail types`
  - `drops an event from a foreign account`
  - `drops an unknown source`
  - `acks only after ack()`
- `tests/vps-provider-events.test.ts`:
  - `state change enqueues a reconcile without writing state`
  - `interruption taints the backing node and drains reservations`
  - `duplicate event ids are processed once`
  - `polling alone still converges with intake disabled`

**Exit:** an interruption warning taints the node and drains it within one reconciler pass on the sim; forged events
change nothing.

### A5 — EBS block storage (generic `disks`)

**Contract changes (additive, core):**
```ts
export interface ProviderVolumeSpec { name: string; zone: string; sizeGiB: number; type?: string; iops?: number;
  throughputMiBps?: number; encrypted?: boolean; kmsKeyId?: string; fromSnapshot?: string; labels?: Readonly<Record<string, string>> }
export interface ProviderVolumeState { id: string; state: 'pending' | 'available' | 'in-use' | 'deleting' | 'deleted' | 'error';
  sizeGiB?: number; attachedTo?: string; device?: string; serial?: string; message?: string }
export interface ProviderVolumes {
  ensureVolume(spec: ProviderVolumeSpec, context: CallContext): Promise<ProviderVolumeState>;
  attachVolume(volumeId: string, machineId: string, context: CallContext): Promise<ProviderVolumeState>;
  detachVolume(volumeId: string, machineId: string, context: CallContext, options?: { force?: boolean }): Promise<ProviderVolumeState>;
  resizeVolume(volumeId: string, sizeGiB: number, context: CallContext): Promise<ProviderVolumeState>;
  deleteVolume(volumeId: string, context: CallContext): Promise<ProviderVolumeState>;
  snapshotVolume?(volumeId: string, name: string, context: CallContext): Promise<{ id: string; state: 'pending' | 'completed' | 'error' }>;
  readonly types?: readonly string[];          // e.g. ['gp3','io2','st1','sc1']
}
export interface ProviderImpl { /* existing */ volumes?: ProviderVolumes }
```
**vps:**
- New group `disks` (resource kind `disk`) with `create`, `list`, `get`, `attach`, `detach`, `resize`, `snapshot`
  and `delete`.
- Table `vps/0029_provider_disks`; reconciler `vps.disks`; quota `diskGiB`; meter `vps.disk.gib.hours`.
- **Refusals:**
  - attach across zones → `INVALID_INPUT` (`zone-mismatch`);
  - delete while attached → `INVALID_STATE`;
  - shrinking → `INVALID_INPUT`.
- Tenant teardown detaches, then deletes (or keeps, per pool policy `disks.onTenantDelete`).

**provider-aws:**
- `CreateVolume` (with `TagSpecifications`, encrypted by default, ClientToken); `AttachVolume` with the next free
  `/dev/sd[f-p]`.
- The guest-visible NVMe serial is reported as `serial = volumeId.replace('-', '')` for udev mapping.
- `ModifyVolume` (resize; respecting the 6-hour modification cooldown → `RATE_LIMITED` with `retryAfterMs`);
  `DeleteVolume`; `CreateSnapshot`.
- The tag guard applies to every mutation.

**Tests:**
- `tests/provider-aws-volumes.test.ts`:
  - `create is idempotent by client token`
  - `attach picks the next free device`
  - `resize cooldown is RATE_LIMITED`
  - `refuses mutating an untagged volume`
- `tests/vps-disks.test.ts`:
  - `zone mismatch refused`
  - `delete while attached refused`
  - `meters GiB-hours`
  - `tenant deletion cleans up`

**Follow-up card:** GCP `ProviderVolumes` (persistent disks).

### A6 — EC2 and EC2 bare metal as bcd hosts

**Go (`daemon/`), lane L3, can start immediately:**
- **`internal/cloud/aws/imds.go`:** an IMDSv2 client (`PUT /latest/api/token` with `X-aws-ec2-metadata-token-ttl-seconds:
  21600`; 1 s timeouts; detection by DMI `sys_vendor == "Amazon EC2"` before any network call).
- **`bcd join --attestor cloud-iid`:** builds evidence
  `{"provider":"aws","document":<instance-identity/document>,"signature":<instance-identity/signature>}`, the exact
  format `cloud-iid.ts:27` verifies.
- **Inventory labels:** `cloud.provider=aws`, `cloud.instance-type`, `cloud.zone`, `cloud.zone-id`,
  `cloud.lifecycle` (`spot|on-demand|capacity-block`), plus EFA device counts (`/sys/class/infiniband/*`, driver
  `efa`).
- **Spot notice watcher:** polls `/latest/meta-data/spot/instance-action` every 5 s on spot instances. It reports a
  node condition through the existing StatusReport conditions path (**(verify)** the proto field; additive if absent).

**TypeScript:**
- **Contract changes:** additive core `ProviderImpl.cloudIdentity?: { provider: 'aws' | 'gcp'; accountId(context: CallContext): Promise<string> }`.
- **vps:**
  - `vps/0030_cloud_identity` adds `provider_accounts.cloud_account_id`, filled on account create/update through
    `cloudIdentity.accountId` (AWS: `GetCallerIdentity`).
  - A generic resolver `vpsCloudIidResolver(): CloudIidResolver` maps
    `(provider, accountId, instanceId)` → provider account → `instances.external_id` in a pool with `agent:'bcd'` →
    `AttestationResult` for that pool. Unrecorded instances are refused unless pool policy `cloudJoin:'account'`.
- **provider-aws:**
  - `offers` for `*.metal` types use `kind:'metal'` (`provides:['vps','metal']`).
  - `bootstrap?` for *attached* instances goes through SSM `SendCommand` (`AWS-RunShellScript`, only on instances
    tagged `better-compute:instance`).
- **AWS IID certificates:** vendored in `provider-aws/src/iid-certificates.ts`, with source URL and retrieval date,
  only for the regions in use (AQ4). The doctor finding `aws.iid-certificate-missing` fires when a pool's region has
  none.

**Tests:**
- `daemon/internal/cloud/aws/imds_test.go`: `token then document`, `no network call off EC2`, `spot notice parsed`.
- `tests/vps-cloud-iid-resolver.test.ts`:
  - `admits a recorded instance into its pool`
  - `refuses an unrecorded instance`
  - `refuses a second use`
  - `account mode admits any instance of the account`
- `tests/e2e/aws-host-join.test.ts` (FakeDaemon with IID evidence + emulator): end to end, from create through join
  to schedulable.

### A7 — Identity: tenant onboarding and workload roles

- **Onboarding** (A1 adds the config; A7 adds the flow):
  - The CLI `aws onboarding-template --account <providerAccountId>` renders CloudFormation JSON for the tenant's
    role: trust policy = the platform principal + `sts:ExternalId` (AD4), and the policy = the ABAC policy from A1
    Task 14.
  - `providerAccounts.get` returns `externalId` and the expected platform principal ARN, so a console can show the
    tenant what to paste.
- **Workload identity to AWS IAM:**
  - **InstanceSpec:** the additive core field `InstanceSpec.awsRole?: string`, set by vps from the instance's
    `workloadIdentity.awsRoleArn`, which must match pool policy `workloadIdentity.aws.roleArns` (ARN glob list).
  - **bcd IMDS** (`daemon/internal/imds`) gains AWS-compatible endpoints:
    - `PUT /latest/api/token`: accepts `X-aws-ec2-metadata-token-ttl-seconds`; the session token is valid under
      `X-aws-ec2-metadata-token` as well as `x-bc-metadata-token`.
    - `GET /latest/meta-data/iam/security-credentials/` returns the role name.
    - `GET /latest/meta-data/iam/security-credentials/<role>` returns
      `{Code,Type:"AWS-HMAC",AccessKeyId,SecretAccessKey,Token,Expiration,LastUpdated}`.
  - **Token exchange:** bcd fetches an OIDC token from the existing workload broker (audience `sts.amazonaws.com`)
    and calls STS `AssumeRoleWithWebIdentity` (unsigned) with `RoleSessionName=bc-<instanceId>`. It caches until
    5 min before expiry.
  - **CLI:** `aws workload-role --tenant <id> --issuer <url>` renders the IAM OIDC provider plus a role trust policy
    (`<issuer>:aud = sts.amazonaws.com`, `<issuer>:sub StringLike t:<tenantId>:instance:*`).
- **Optional:** **IAM Roles Anywhere** for non-AWS bcd nodes. The node CA becomes the trust anchor, and bcd signs
  `CreateSession` with its node key (`AWS4-X509-ECDSA-SHA256`). It is deferred behind AQ9.

**Tests:**
- `tests/vps-workload-aws-role.test.ts`:
  - `refuses a role ARN outside the pool allow-list`
  - `passes the role to the instance spec`
- `daemon/internal/imds/aws_test.go`:
  - `serves AWS-shaped credentials`
  - `accepts the AWS token header`
  - `refuses without a session token`
  - `refreshes before expiry`

### A8 — Platform services · *executable plan:* [`2026-10-18-aws-a8-platform-services.md`](2026-10-18-aws-a8-platform-services.md)

These are all implementations of seams that already exist; no core changes:
- `awsSecretsManagerStore`, `awsParameterStore`
- `kmsSealingKeys` (for `localSealedSecretStore`)
- `s3BlobStore`, `s3SnapshotStore`, `s3AuditSink`
- `eventBridgeSink`, `snsSink`, `sqsSink`, `kinesisSink`, `firehoseSink` / `firehoseAuditSink`
- `acmPcaCertificateAuthority`, `kmsCertificateAuthority`
- `rdsIamPool`
- `emfMetricsExporter`
- the ADOT collector docs

### A9 — Kubernetes on AWS (EKS)

- **Hosted mode:** provider-kubernetes hosted mode works on EKS today. A9 adds docs plus a test that renders the
  DaemonSet for EKS-shaped nodes: the `eks.amazonaws.com/nodegroup` selector and the GPU taint
  `nvidia.com/gpu=:NoSchedule`.
- **`aws-core` `eksToken`:** `eksToken({ cluster, credentials, region }): Promise<string>`, a presigned STS
  `GetCallerIdentity` URL with the `x-k8s-aws-id` header, giving `k8s-aws-v1.<base64url>` for hosts that drive the
  cluster API.
- **provision `k8s-join` `mode: 'eks'`:**
  - It renders a nodeadm `NodeConfig` (`apiVersion: node.eks.aws/v1alpha1`, `spec.cluster{name,apiServerEndpoint,
    certificateAuthority,cidr}`) as a MIME part of the user data, for AL2023 EKS AMIs (alias `eks-al2023-<k8s>`).
  - The existing kubeadm mode is unchanged.
- **provider-aws config:** `instanceProfile?: string`, the ARN passed as `IamInstanceProfile` (the IAM policy scopes
  `iam:PassRole` to it).
- **`providerAccounts.clusters`** (optional): `ListClusters`/`DescribeCluster`, to fill `k8s-join`.

**Tests:**
- `tests/provision-k8s-join-eks.test.ts`: `renders a nodeadm NodeConfig`, `refuses missing CA`.
- `tests/aws-core-eks-token.test.ts`: `token is a presigned GetCallerIdentity with the cluster header`.

### A10 — ML fabric: placement groups, EFA, Neuron, Graviton, shared filesystems

- **Placement:**
  - The create request gains an additive `placement?: { group: string; strategy: 'cluster' | 'spread' | 'partition'; partition?: number }`.
  - When a capacity gang lands on a provider pool, vps passes `bc-gang-<gangId>`, and provider-aws runs
    `CreatePlacementGroup` (idempotent) first.
  - `DescribeInstanceTopology` populates labels `topology.aws/network-node-{1,2,3}`, so later gang placement prefers
    co-located machines.
- **EFA:**
  - With config `efa: 'off' | 'auto'` set to auto, a type with `NetworkInfo.EfaSupported` launches with
    `NetworkInterfaces[]` of `InterfaceType=efa`, one per network card up to `MaximumEfaInterfaces`.
  - A2 gives the network's SG a self-referencing all-traffic rule.
- **Neuron:**
  - The `trn1`/`trn2`/`inf2` accelerators map to the `gpus` model strings `TRN1`/`TRN2`/`INF2`.
  - bcd inventory adds `/dev/neuron*` devices (**(verify)** whether the inventory device model is free-form).
- **Graviton:** `Offer.arch` (A3) plus per-arch images (AD7) plus the bcd `linux-arm64` downloads that rollout
  already serves.
- **Shared filesystems:** an additive `ProviderFilesystems` (EFS, FSx for Lustre) and a vps `filesystems` group, with
  mount targets per subnet and mounts through a cloud-config part. This is its own sub-plan.
- **Calendar → Capacity Blocks:**
  - A capacity calendar reservation on an AWS pool can propose a Capacity Block (A3 `listReservationOfferings`)
    T−48 h before it starts.
  - Purchase still needs operator confirmation.

### A11 — FinOps and governance

- **Cost reporting:**
  - The additive `ProviderImpl.costs?(range: { from: number; to: number }, context: CallContext): Promise<ProviderCostLine[]>`
    with `ProviderCostLine { day: string; service: string; amount: number; currency: string; tags: Readonly<Record<string,string>> }`.
  - provider-aws calls Cost Explorer `GetCostAndUsage`, grouped by the tags `better-compute:tenant` and
    `better-compute:instance`, once a day (Cost Explorer charges per request).
  - The vps reconciler `vps.providerCosts` writes `vps/0031_provider_costs`. `providerAccounts.costs` is root-only.
    A console margin view (cost vs. billed usage) comes later.
- **Docs:** activating cost-allocation tags in the payer account.
- **CLI:**
  - `aws organization-accounts` (`ListAccounts`) renders FleetConfig `providerAccounts` entries with
    `assumeRoleArn=arn:<partition>:iam::<acct>:role/<role>`. It only renders; it never mutates.
  - `aws quota-request` (`RequestServiceQuotaIncrease`) asks for interactive confirmation.
- **Marketplace metering** (`BatchMeterUsage`) is blocked until usage sinks are allowed (AQ6). The design sketch:
  `marketplaceUsageSink` in `aws`, mapping meters to dimensions, idempotent by usage-window key.
- **Optional:** an `aws-lightsail` `ProviderDefinition` for low-cost VPS bundles.

### A12 — Deploy on AWS and the live suite

**Deployment templates:**
- `packages/aws/src/deploy/*.ts` renders **CloudFormation JSON** (AQ7; JSON avoids a YAML dependency and is unit
  testable). The CLI `aws deploy-templates --out <dir>` writes it.
- **`network`:** a VPC across 3 AZs with private and public subnets, NAT, and endpoints (S3 gateway; interface
  endpoints for Secrets Manager, KMS, ECR, Logs, STS).
- **`data`:** Aurora PostgreSQL ≥ 16 Serverless v2 with IAM auth, `btree_gist` allowed, and a KMS-encrypted cluster.
- **`control-plane`:**
  - ECS Fargate services `api`, `worker` and `gateway` (`serve --mode …`).
  - An ALB (HTTPS with an ACM certificate, plus WAF) for the API and console, and an **NLB in TCP passthrough** for
    the gateway's mTLS.
  - Task roles (least privilege), the deployment secret in Secrets Manager, and the KMS key.
  - S3 buckets: downloads (behind CloudFront), snapshots, and audit (Object Lock, compliance mode).
  - An EventBridge bus, log groups, and alarms.
- **Live suite:**
  - **Gate and layout:** `tests/live/aws/*.live.test.ts`, excluded from the default and nightly configs, behind
    `vitest.aws-live.config.ts`. It requires `BETTER_COMPUTE_AWS_LIVE=1` and a sandbox profile.
  - **Guards:** an instance-type allow-list (`t4g.nano`, `t3.micro`); every resource tagged
    `better-compute:test-run=<id>`; `afterAll` cleanup plus `scripts/aws-live-sweep.mjs` (deletes everything tagged
    with a test-run older than 2 h); the spend guard refuses to start when Cost Explorer month-to-date for the
    sandbox account is over `BETTER_COMPUTE_AWS_LIVE_BUDGET_USD`.
  - **Coverage:** the A1 conformance suite, A2 networks, A4 intake via a real EventBridge rule, and a Spot
    interruption via AWS Fault Injection Service (`aws:ec2:send-spot-instance-interruptions`).

## 7. Global constraints (every AWS plan inherits these)

- Node ≥ 22.12, ESM only, `.js` import paths. **No new npm dependencies** (AQ1).
- **Core is frozen:** additive optional members only, coordinated through the orchestrating session
  (`.claude/coordination.md`).
- **Dependency rules:** check-deps rules 1–4 plus the new rule 5 (AD1). Not in `packages/better-compute/umbrella.json`.
  New packages use one-line inserts only in the root `tsconfig.json` references and the `vitest.config.ts` `scoped`
  map. `pnpm install` runs only through the orchestrator while other agents are active.
- **Provider calls:** never inside a transaction. A reconciler run stays under `claimTtlMs` (60 s). Long AWS
  operations are polled across runs with `enqueue(…, { notBefore })`.
- **SQL:** `compute_now()`, never `now()`. Migrations `vps/00NN_<slug>` are strictly increasing; the next free one
  is `vps/0027`. The numbers in the phase sections (`0027`–`0031`) are **indicative**. A phase claims its real
  numbers in coordination.md before writing, because phases may land out of order.
- **Secrets:** refs only (`field.secret()`, `assertNoInlineSecrets`). Never log or echo access keys, secret keys,
  session tokens, signatures or presigned URLs. Presigned URLs are secrets until they expire.
- **API surface:** for every new method, an `apiSurface` row (`'v1.0'`), a description in
  `apps/docs/descriptions/api/<group>.md`, `describedBy(strictObject(…))` validators, and new actions in
  `tests/support/iam.ts` and `tests/core-catalog.test.ts`. Regenerate with
  `node scripts/head-check.mjs --run apps/docs/scripts/sync-from-head.mjs .`.
- **Events:** `area.name` types, with each family listed in `packages/events/src/catalog.ts`.
- **Tests inject a clock.** No fixed `Date.UTC` with the wall clock (the "time bomb" lesson).
- **Commits:** `node scripts/private-commit.mjs -F <msgfile> -- <paths>` (or `--use` for shared files). Messages end
  with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Security review:** after every phase, run a security-review subagent over the phase's commits. Findings must be
  fixed before the next phase starts.

## 8. Program-level review focus

The five failure modes most likely to bite, and the phase whose tests pin each:
1. **Confused deputy through `assumeRoleArn`.** A1 Task 8: `refuses an assumeRoleArn in the platform account`,
   `uses the platform-assigned external id, never one from config`, `refuses when the assumed identity is another
   account`.
2. **EC2 eventual consistency read as "gone".** `DescribeInstances` returns `InvalidInstanceID.NotFound` for seconds
   after `RunInstances`. The instance must stay `pending`, never become `lost`, and must never be recreated. A1
   Task 10: `get finds a just-created instance through its client token`.
3. **Forged or replayed events.** A4: `drops an event from a foreign account`, `duplicate event ids are processed
   once`.
4. **Spending without consent.** A3: `purchase requires confirmation and is idempotent`.
5. **Credentials in logs or errors.** A0 Task 5: `never logs credentials` scans every log record and error message
   from the full credential and protocol suites for key, secret, token and signature material.

## 9. Testing strategy

| Layer | What | Where |
|---|---|---|
| Vectors | SigV4 official test-suite cases (`get-vanilla`, `get-vanilla-query-order-key-case`, `get-header-value-trim`, `get-utf8`, `normalize-path/*`, `post-x-www-form-urlencoded`, `post-sts-token/*`), presign | `tests/fixtures/aws-sigv4/` (vendored, Apache-2.0, with NOTICE line), `tests/aws-core-sigv4.test.ts` |
| Emulator | In-process `fetch` fakes: STS, IMDSv2, container credentials, EC2 (instances, types, offerings, tags, VPC, SG, NACL, EBS, ODCR, spot), SQS, Service Quotas, Pricing, SSM, Secrets Manager, KMS, S3, EventBridge, SNS, Kinesis, Firehose, ACM PCA, Cost Explorer. Each one checks the SigV4 header shape and credential scope, deduplicates ClientTokens, paginates with a small page size, injects errors (`failNext(op, code)`), and simulates eventual consistency (`notFoundReads`). | `tests/support/aws-emulator/{index,ec2,sts,imds,sqs,…}.ts` |
| Conformance | `providerConformanceCases()` with `attachable` | `tests/provider-aws.test.ts` |
| Module | vps reconcilers on PGlite with `manualClock` + `useSimClock` | `tests/vps-*.test.ts` |
| Sim / e2e | ControlPlaneSim + FakeDaemon (IID evidence, spot notices) | `tests/e2e/aws-*.test.ts`, `tests/sim/aws-*.test.ts` |
| Go | `go test` in WSL (`node scripts/daemon-test.mjs`) | `daemon/internal/cloud/aws/*_test.go` |
| Live | Opt-in, sandbox account, tag sweeper, spend guard | `tests/live/aws/` |

## 10. Risks

| Risk | Mitigation |
|---|---|
| A hand-rolled protocol misses an edge case: XML namespaces, an empty list vs. a missing one, timestamp formats | Protocol tests use captured response shapes from the AWS API reference for every operation we call; the live suite runs the same operations for real. |
| AWS API drift (new ODCR states, new instance families) | Unknown states map to `unknown`/omitted, never throw. Shapes come from `DescribeInstanceTypes`, never from tables. The live suite runs weekly. |
| EC2 API throttling (`RequestLimitExceeded`) at fleet scale | Discovery and list are batched (`DescribeInstances` with `MaxResults=1000`). A4 events replace per-instance polling. `RATE_LIMITED` gives a reconciler backoff. Per-account token bucket in `aws-core` (default 20 req/s, configurable). |
| AZ name skew across accounts (ODCR shared via RAM) | Zone ids are recorded alongside names. Reservation offers use the account's own AZ name, resolved from the zone id with `DescribeAvailabilityZones`. |
| Live suite cost or leaks | Allow-listed tiny instance types, the spend guard, the 2 h tag sweeper, and a dedicated sandbox account with an AWS Budget action that denies `RunInstances`. |
| Region expansion (opt-in regions such as `me-central-1`) | `OptInRequired` maps to `ACCESS_DENIED` with reason `region-opt-in`. The account check reports it. |

## 11. Decisions needed from the user (defaults apply if unanswered, as with D1–D20)

| # | Question | Default (recommended) | Alternative |
|---|---|---|---|
| AQ1 | AWS SDK or hand-rolled? | **Hand-rolled `aws-core`** (zero deps, matches GCP D2) | `@aws-sdk/client-*` v3: less code, ~15 packages plus transitive dependencies, larger supply-chain review |
| AQ2 | Tenant isolation model | **Platform account + per-tenant VPCs, plus BYO tenant accounts through cross-account roles.** Account vending (Organizations `CreateAccount`) stays in the embedding app (GCP D1). | better-compute vends one AWS account per tenant |
| AQ3 | How Secrets Manager refs look | **`secret://aws-sm/<path>` under the existing scheme** (no core change) | Widen `SecretRef` with `aws-sm://` (core type change) |
| AQ4 | AWS IID verification certificates | **Vendored, reviewed file per region, plus a doctor finding** | Operator-supplied only |
| AQ5 | Allow buying capacity (Capacity Blocks, ODCR creation) at all? | **Built, off by default, root + confirmation** | Not built |
| AQ6 | AWS Marketplace metering | **Deferred** (usage stays with better-iam billing, §12.7) | Allow `UsageSink`s (server change) and build `marketplaceUsageSink` |
| AQ7 | Deployment template format | **CloudFormation JSON rendered from TypeScript** | Terraform module, or CDK (adds dependencies) |
| AQ8 | Partitions | **Commercial `aws` live-tested; `aws-cn`/`aws-us-gov` designed in, not live-tested** | Include GovCloud in the live suite |
| AQ9 | IAM Roles Anywhere for non-AWS nodes | **Deferred** | Build it in A7 |

## 12. Integration notes (legionedge and other embedders)

- legionedge embeds `betterCompute()`, so it gets the `aws` provider by adding `vps({ providers: [aws] })`, and the
  platform services by passing the `aws` package's extensions. Its own landing-zone or account-vending logic stays
  in legionedge (AQ2).
- A host running the control plane on EKS passes the IRSA / Pod Identity credentials as
  `awsProvider({ credentials: ambientCredentials() })`. Only platform accounts use them (AD4).

---

## Appendix A — AWS service catalog

Columns: disposition (Integrate / Interop / Deploy-on / Defer / Out), phase, and the better-compute seam. "Out"
services remain reachable through the interop layer (EventBridge events, S3 audit, OIDC workload roles).

### Compute
| Service | Disp. | Phase | Seam / notes |
|---|---|---|---|
| Amazon EC2 (instances, AMIs, key pairs not used) | Integrate | A1 | `ProviderImpl` (`provider-aws`) |
| EC2 Spot Instances | Integrate | A3 | Offers `:spot`, `ExternalMachine.interruption` |
| On-Demand Capacity Reservations (incl. future-dated, RAM-shared) | Integrate | A3 | `listReservations` → `vps.reservations` admission |
| EC2 Capacity Blocks for ML | Integrate | A3/A10 | `listReservations`, `listReservationOfferings`, `purchaseReservation` |
| EC2 bare metal (`*.metal`) | Integrate | A6 | `kind:'metal'` offers, cloud-iid join |
| EC2 placement groups / instance topology | Integrate | A10 | `create.placement`, topology labels |
| EC2 Fleet / Spot Fleet | Defer | A3+ | Multi-type instant fleets for a fallback list; needs a generic "offer alternatives" create field |
| EC2 Auto Scaling | Out | — | better-compute is the scheduler; ASG instances can still be *attached* by tag (R2) |
| EC2 Image Builder | Interop | — | Produces AMIs consumed as `ami-…`/`resolve:ssm:` ImageRefs |
| VM Import/Export | Defer | A10+ | Export the better-compute image pipeline to AMIs; needs an `image-source` consumer (kind declared, unused) |
| Dedicated Hosts / Dedicated Instances | Defer | A10+ | Host affinity in `create`; tenancy in offers |
| AWS Outposts | Interop | A2 | Outpost subnets are ordinary zone-scoped subnets |
| Local Zones / Wavelength Zones | Interop | A1 | Listed in `zones` after zone-group opt-in |
| Amazon Lightsail | Defer | A11 (optional) | Second `ProviderDefinition` `aws-lightsail` |
| AWS Batch, ParallelCluster, Elastic Beanstalk | Out | — | Competing schedulers / PaaS |
| AWS Lambda | Interop | — | EventBridge target for better-compute events |
| AWS App Runner | Deploy-on (alt) | A12 | Alternative to ECS for the API process |
| EC2 Mac | Out | — | macOS is not a bcd target |
| Nitro Enclaves | Out | — | Not a capacity concern |
| Compute Optimizer, SimSpace Weaver, Serverless Application Repository | Out | — | — |
| Savings Plans / Reserved Instances | Interop | A11 | Cost reporting only (billing constructs) |

### Containers
| Service | Disp. | Phase | Seam / notes |
|---|---|---|---|
| Amazon EKS | Integrate | A9 | provider-kubernetes hosted DaemonSet; `k8s-join mode:'eks'`; `eksToken` |
| EKS Hybrid Nodes / EKS Anywhere | Interop | A9 | provider-kubernetes hosted mode |
| Amazon ECS / AWS Fargate | Deploy-on | A12 | Control-plane services |
| Amazon ECR | Deploy-on / Interop | A12 | bcd and console images; registry pulls |
| Red Hat OpenShift Service on AWS | Interop | — | provider-kubernetes |
| App Mesh, Copilot | Out | — | — |

### Storage
| Service | Disp. | Phase | Seam / notes |
|---|---|---|---|
| Amazon EBS (volumes, snapshots) | Integrate | A5 | `ProviderVolumes`, vps `disks` |
| Amazon S3 | Integrate | A8 | `BlobStore`, `SnapshotStore`, `AuditSink`, rollout downloads |
| S3 Glacier storage classes | Interop | A8 | Lifecycle rules on the audit bucket (template) |
| Amazon EFS | Integrate | A10 | `ProviderFilesystems`, vps `filesystems` |
| Amazon FSx for Lustre | Integrate | A10 | Same seam; ML training scratch |
| FSx for ONTAP / OpenZFS / Windows | Defer | A10+ | Same seam, later |
| AWS Backup | Interop | A5 | Tag-based backup plans on `better-compute:*` volumes |
| Storage Gateway, DataSync, Snow Family, File Cache, Elastic Disaster Recovery | Out | — | — |

### Database
| Service | Disp. | Phase | Seam / notes |
|---|---|---|---|
| Amazon Aurora / RDS for PostgreSQL | Integrate + Deploy-on | A8/A12 | `rdsIamPool` (IAM auth token as the async password); Aurora in templates |
| RDS Proxy | Interop | A12 | Compatible (no LISTEN/NOTIFY, transaction-level advisory locks) |
| ElastiCache / MemoryDB | Interop | — | Only if a Redis `Notifier` is configured |
| DynamoDB, DocumentDB, Neptune, Keyspaces, Timestream, Redshift | Out | — | Postgres is the single source of truth |

### Networking and content delivery
| Service | Disp. | Phase | Seam / notes |
|---|---|---|---|
| Amazon VPC (VPCs, subnets, route tables, IGW) | Integrate | A2 | `ProviderNetworks` |
| Security groups / network ACLs | Integrate | A2 | `ensureFirewall`, `setTags` |
| NAT Gateway | Integrate (optional) | A2 | `ensureSubnet` private subnets with `natGateway: true` |
| VPC endpoints (gateway) | Integrate | A2 | "private service access" |
| VPC endpoints (interface) / PrivateLink | Deploy-on | A12 | Control-plane VPC |
| Amazon VPC IPAM | Interop | A2 | `ipamPoolId` config |
| Elastic IP addresses | Defer | — | Needs a generic `addresses` group |
| Transit Gateway / VPC peering / Cloud WAN | Defer | — | Needs a generic network-peering feature |
| Elastic Fabric Adapter | Integrate | A10 | EFA interfaces at create |
| Elastic Load Balancing (ALB/NLB) | Deploy-on | A12 | NLB passthrough for the gateway; ALB for the API |
| Tenant load balancers | Defer | — | Needs a generic `loadBalancers` group |
| Amazon Route 53 | Deploy-on / Defer | A12 | Control-plane DNS; instance DNS needs a generic DNS seam |
| Amazon CloudFront | Deploy-on | A12 | bcd downloads CDN |
| AWS Global Accelerator | Deploy-on (optional) | A12 | Anycast in front of gateways |
| Direct Connect / Site-to-Site VPN / Client VPN | Interop | — | Connectivity for metal sites (docs) |
| API Gateway, VPC Lattice, Cloud Map, Network Firewall, Verified Access, Reachability Analyzer, Traffic Mirroring | Out | — | — |

### Security, identity and compliance
| Service | Disp. | Phase | Seam / notes |
|---|---|---|---|
| AWS IAM | Integrate | A1/A7 | ABAC policy and trust policy generators; instance profiles |
| AWS STS | Integrate | A0 | AssumeRole, AssumeRoleWithWebIdentity, GetCallerIdentity |
| IAM Roles Anywhere | Defer | A7 (AQ9) | Node CA as the trust anchor |
| AWS Organizations | Integrate | A11 | `aws organization-accounts` |
| AWS RAM | Interop | A3 | Shared ODCRs appear `shared:true` |
| AWS KMS | Integrate | A8 | `kmsSealingKeys`, `kmsCertificateAuthority`, EBS/S3 encryption |
| AWS CloudHSM | Interop | — | Through a KMS custom key store |
| AWS Secrets Manager | Integrate | A8 | `awsSecretsManagerStore` |
| AWS Private CA | Integrate | A8 | `acmPcaCertificateAuthority` |
| AWS Certificate Manager (public) | Deploy-on | A12 | ALB certificates |
| Amazon GuardDuty | Interop | A4 | Findings via the EventBridge intake (`aws.guardduty`) can taint a node (optional rule) |
| AWS Security Hub, Inspector, Macie, Detective, Audit Manager, Artifact | Interop / Out | — | Inspector scans EC2 hosts unchanged; the rest are out |
| AWS WAF / Shield / Firewall Manager | Deploy-on | A12 | WAF on the ALB |
| Amazon Security Lake | Defer | A8+ | OCSF export from the audit sink |
| Amazon Cognito, Verified Permissions, IAM Identity Center | Out | — | better-iam owns human identity and policy |

### Management and governance
| Service | Disp. | Phase | Seam / notes |
|---|---|---|---|
| Amazon CloudWatch (metrics, EMF, logs, alarms) | Integrate | A8/A12 | `emfMetricsExporter`; log groups and alarms in templates |
| AWS Distro for OpenTelemetry / X-Ray | Interop | A8 | bcd OTLP → ADOT collector; control-plane `onSpan` → ADOT |
| Amazon Managed Service for Prometheus / Managed Grafana | Interop | A8 | ADOT scrapes `/metrics` and remote-writes |
| AWS CloudTrail | Interop | A4 | Management events via EventBridge → `api-call` events |
| AWS Config | Interop | — | Rules on `better-compute:*` tags |
| AWS Systems Manager: Run Command | Integrate | A6 | `bootstrap?` for attached instances |
| AWS Systems Manager: Parameter Store | Integrate | A8 | `awsParameterStore`; public AMI parameters (AD7) |
| SSM Session Manager / Patch Manager / Fleet Manager | Out | — | better-compute tunnels and rollout cover these |
| Service Quotas | Integrate | A3/A11 | Offer headroom; `aws quota-request` |
| AWS Health | Interop | A4 | `aws.health` events via EventBridge (the Health API needs a Business support plan) |
| AWS CloudFormation | Integrate (render) + Deploy-on | A4/A7/A12 | Rendered templates (event rules, onboarding role, deployment) |
| Resource Groups Tagging API | Integrate | A12 | Live-suite sweeper; cost tag checks |
| AWS Control Tower | Interop | A11 | Account vending feeds `organization-accounts` |
| AWS Fault Injection Service | Integrate (tests) | A12 | Live Spot interruption tests |
| Trusted Advisor, License Manager, Service Catalog, Proton, Resilience Hub, AppConfig, Launch Wizard, User Notifications, Chatbot | Out / Interop | — | Chatbot via SNS sink |

### Cloud financial management
| Service | Disp. | Phase | Seam / notes |
|---|---|---|---|
| AWS Price List API | Integrate | A3 | `Offer.pricePerHour` |
| AWS Cost Explorer | Integrate | A11 | `ProviderImpl.costs` |
| Data Exports (CUR 2.0) | Defer | A11+ | Parquet ingestion needs a dependency |
| AWS Budgets | Interop | A12 | Live-suite budget action; tenant budgets stay in better-iam |
| AWS Marketplace Metering Service | Defer | A11 (AQ6) | Blocked: usage sinks refused |
| Billing Conductor | Out | — | — |

### Application integration
| Service | Disp. | Phase | Seam / notes |
|---|---|---|---|
| Amazon EventBridge | Integrate | A4/A8 | Intake source (A4); `eventBridgeSink` (A8) |
| Amazon SQS | Integrate | A4/A8 | Intake transport; `sqsSink` (FIFO dedupe by event id) |
| Amazon SNS | Integrate | A8 | `snsSink` |
| AWS Step Functions, Amazon MQ, AppFlow, MWAA | Out / Interop | — | Can consume EventBridge events |

### Analytics
| Service | Disp. | Phase | Seam / notes |
|---|---|---|---|
| Amazon Kinesis Data Streams | Integrate | A8 | `kinesisSink` |
| Amazon Data Firehose | Integrate | A8 | `firehoseSink`, `firehoseAuditSink` |
| Amazon Athena / AWS Glue | Interop | A8 | Table DDL for the S3 audit archive (docs) |
| Amazon OpenSearch Service | Interop | A8 | Firehose → OpenSearch for audit search |
| Amazon MSK | Interop | — | Only if a Kafka sink exists |
| EMR, Redshift, QuickSight, Lake Formation, DataZone, Clean Rooms, Data Exchange | Out | — | — |

### Machine learning and AI
| Service | Disp. | Phase | Seam / notes |
|---|---|---|---|
| Trainium / Inferentia (`trn*`, `inf*`) | Integrate | A10 | Accelerator models + Neuron inventory |
| AWS Deep Learning AMIs | Integrate | A1 | Image alias `dlami-gpu` |
| SageMaker (incl. HyperPod) | Defer | — | HyperPod cluster discovery could feed attach, later |
| Bedrock, Q, Rekognition, Comprehend, Polly, Transcribe, Translate, Textract, Kendra, Lex, Personalize, Forecast, others | Out | — | Not capacity concerns |

### Developer tools
| Service | Disp. | Phase | Seam / notes |
|---|---|---|---|
| CodeBuild / CodePipeline / CodeDeploy / CodeArtifact / CodeCatalyst | Interop | — | CI calls the better-compute API and CLI |
| AWS CDK, SAM, Amplify, CloudShell, Cloud9 | Out | — | Templates are CloudFormation JSON (AQ7) |
| AWS SDKs / CLI | Out | — | AD2: not used |

### Migration, end-user computing, business apps, IoT, media, games, quantum, satellite, robotics, blockchain, AR/VR, contact center, front-end
| Service family | Disp. | Notes |
|---|---|---|
| Application Migration Service, DMS, Migration Hub, Transfer Family | Out | Not capacity concerns |
| WorkSpaces, AppStream 2.0 | Out | — |
| Connect, Chime SDK, SES, Pinpoint, WorkMail | Out | SES could back a future `Notifier`; not needed |
| IoT Core / Greengrass / SiteWise / others | Out | — |
| Elemental Media*, IVS, Nimble/Deadline Cloud | Out | — |
| GameLift | Out | — |
| Braket (quantum) | Out | — |
| Ground Station | Out | — |
| Managed Blockchain | Out | — |
| Amplify, AppSync, Device Farm, Location Service | Out | — |

## Appendix B — IAM permissions per phase (what `aws iam-policy --phases …` emits)

| Phase | Actions (all ABAC-scoped to `better-compute:*` tags where AWS supports it) |
|---|---|
| A1 | `ec2:RunInstances` (`aws:RequestTag/better-compute:managed=true`, `ec2:CreateAction=RunInstances` for `ec2:CreateTags`), `ec2:DescribeInstances`, `ec2:DescribeInstanceTypes`, `ec2:DescribeInstanceTypeOfferings`, `ec2:DescribeAvailabilityZones`, `ec2:DescribeImages`, `ec2:Start/Stop/Reboot/TerminateInstances` + `ec2:SendDiagnosticInterrupt` + `ec2:CreateReplaceRootVolumeTask` (`ec2:ResourceTag/better-compute:managed=true`), `ec2:CreateTags`/`DeleteTags` (condition on the `better-compute:instance` key for attach), `ssm:GetParameters` on `arn:<p>:ssm:*::parameter/aws/service/*`, `sts:GetCallerIdentity`, `iam:PassRole` (only `instanceProfile`, A9) |
| A2 | VPC/subnet/IGW/route-table/SG/NACL/endpoint create and delete, scoped to `better-compute:network` tags |
| A3 | `ec2:DescribeCapacityReservations`, `ec2:DescribeSpotPriceHistory`, `servicequotas:GetServiceQuota`, `pricing:GetProducts`; purchases (`ec2:PurchaseCapacityBlock`, `ec2:CreateCapacityReservation`, `ec2:DescribeCapacityBlockOfferings`) in a separate opt-in statement |
| A4 | `sqs:ReceiveMessage`, `sqs:DeleteMessage` on the intake queue; `ec2:DescribeInstanceStatus` |
| A5 | `ec2:CreateVolume`/`AttachVolume`/`DetachVolume`/`ModifyVolume`/`DeleteVolume`/`CreateSnapshot` (tag-scoped), `kms:CreateGrant` (with `kms:GrantIsForAWSResource`) when `kmsKeyId` is set |
| A6 | `ssm:SendCommand` (document `AWS-RunShellScript`, instances tagged `better-compute:instance`), `ssm:GetCommandInvocation` |
| A9 | `eks:ListClusters`, `eks:DescribeCluster` |
| A10 | `ec2:CreatePlacementGroup`, `ec2:DescribeInstanceTopology` |
| A11 | `ce:GetCostAndUsage`, `organizations:ListAccounts`, `servicequotas:RequestServiceQuotaIncrease` (opt-in) |

## Appendix C — AWS facts to verify before building on them

Each is marked **(verify)** where it is used. Check it against the current AWS documentation, or in the live suite,
before writing code that depends on it.
- Service Quotas codes: `L-1216C47A` (standard on-demand vCPU), `L-DB2E81BA` (G and VT), `L-417A185B` (P), and the
  Spot equivalents.
- The Capacity Reservation EventBridge detail-types.
- The SSM public parameter paths for Ubuntu 24.04/22.04 (`/aws/service/canonical/ubuntu/server/<ver>/stable/current/<arch>/hvm/ebs-gp3/ami-id`),
  AL2023 (`/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-<arch>`), the DLAMI GPU base, and the
  EKS AL2023 AMIs (`/aws/service/eks/optimized-ami/<k8s>/amazon-linux-2023/<arch>/standard/recommended/image_id`).
- The SQS maximum message size and the Firehose/Kinesis batch limits used for chunking in A8.
- Whether bcd's StatusReport already carries node conditions (A6 spot notices).
- Whether inventory GPU model strings are free-form (A10 Neuron).
