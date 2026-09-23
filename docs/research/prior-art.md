# better-compute: prior-art survey and design decisions

The daemon, control plane and API design below comes from surveying bare-metal, GPU and VPS management tools, plus a read of better-iam's integration points. Nothing was written to disk. Facts marked **(unverified)** are from memory and were not confirmed against a source during this pass.

## 0. Decisions at a glance

| Topic | Decision |
|---|---|
| Daemon language | **Go**. One static binary, `bcd`, with three modes: `node` (on every server), `site` (DHCP, iPXE, BMC and image cache for each datacenter or rack) and `ramdisk` (commissioning, deploy and wipe). Everything else is TypeScript. |
| Contract between daemon and TypeScript | Protobuf as the single source of truth, built with `buf`. It generates TypeScript through `@bufbuild/protobuf` and `@connectrpc/connect`, and Go through `connectrpc.com/connect`. `buf breaking` runs in CI to enforce version-skew compatibility. |
| Transport | The daemon only dials out, on 443, to a gateway tier. It opens one long-lived **gRPC bidirectional stream over HTTP/2 with mTLS**; WebSocket carrying the same protobuf frames is the fallback. Delivery is at-least-once, with idempotent command IDs, per-node sequence numbers, generation fencing and resume. |
| Identity | One-time join token plus a CSR, signed by the control plane's CA into a 24h SPIFFE-style certificate with automatic rotation. TPM and cloud-IID attestors are optional plugins. For access to other services, the node exchanges a control-plane-issued OIDC token through better-iam `sts.assumeRoleWithWebIdentity`. |
| Source of truth and queue | Postgres. Work is queued in outbox and job tables drained with `FOR UPDATE SKIP LOCKED`. LISTEN/NOTIFY is **not** on the hot path. NATS core or Redis is used only for payload-free wake-ups. Telemetry goes to a time-series database, never to Postgres. |
| Node model | Kept as separate dimensions, as Ironic does: `provisionState` × `maintenance` flag × `powerState` × `connectivity` × `conditions[]`. Brownfield servers enter through `adopt` (Ironic `adopt`, Metal3 `externallyProvisioned`), which will be the most common way in. |
| Capacity | Allocatable = capacity − reserved for the system. Devices are first-class and carry attributes, modelled on Kubernetes DRA (`ResourceSlice`/`ResourceClaim`), not opaque counts. Postgres exclusion constraints make device double-booking impossible. |

---

## 1. Prior art and what to borrow

| System | Ideas to borrow | Where it lands in better-compute |
|---|---|---|
| **Canonical MAAS** | (1) Lifecycle New → Commissioning → Ready → Allocated → Deploying → Deployed → Releasing, plus Rescue, Broken and Failed. "Allocated" locks the record without touching the machine. [docs](https://canonical.com/maas/docs/3.7/explanation/the-machine-life-cycle/) (2) Region controller (API and Postgres) plus **rack controller** (DHCP, TFTP, HTTP images, power), close to the hardware. The region picks the rack controller that can reach a machine's BMC. [controllers](https://canonical.com/maas/docs/latest/explanation/controllers/) | Provision state machine; `bcd --mode=site` is the rack controller. |
| **Tinkerbell** | (1) Now a **single binary** with toggleable services: Smee (DHCP, TFTP, HTTP, syslog), Tootles (metadata compatible with cloud-init), Rufio (BMC through `bmclib`), Tink Server (gRPC) and Controller. Second Star bridges SSH to serial. (2) Workflows are Templates of **actions that are OCI images**, run in order by `tink-agent` in HookOS. The agent pulls work with gRPC `GetAction` and `ReportActionStatus`. (3) Pluggable storage backend: Kubernetes, file, or embedded. [deepwiki](https://deepwiki.com/tinkerbell/tinkerbell), [Rufio](https://tinkerbell.org/docs/services/rufio/) | Site-agent composition; the workflow and step model; the pull model for agents. |
| **OpenStack Ironic** | (1) Provision states `enroll`, `manageable`, `available`, `active`, `rescue`, `error`, with wait and failed transients. Verbs are `manage`, `provide`, `clean`, `inspect`, `deploy`, `rebuild`, `rescue`, `unrescue`, `undeploy`, `service`, `adopt`, `abort`. [states](https://docs.openstack.org/ironic/latest/user/states.html) (2) A node is a **composition of per-concern interfaces**: bios, boot (pxe, ipxe, http, http-ipxe, redfish-virtual-media), console, deploy (direct, anaconda, ramdisk), firmware, inspect, management, network, power (redfish, ipmitool, snmp), raid, rescue, storage, vendor. [boot](https://docs.openstack.org/ironic/latest/admin/interfaces/boot.html), [drivers](https://docs.openstack.org/ironic/2025.2/install/enabling-drivers.html) | The driver taxonomy in §6 copies this composition. `maintenance` is a flag, not a state. |
| **Metal3** | BareMetalHost states: registering, inspecting, available, provisioning, provisioned, deprovisioning, and `externallyProvisioned` (only power is managed). `status.operationHistory` records phase timings. [states](https://github.com/metal3-io/baremetal-operator/blob/main/docs/baremetalhost-states.md) | The `adopted` entry path; per-phase history on the node record. |
| **Sidero Omni / Talos** | SideroLink: every machine opens a **WireGuard point-to-point tunnel** to Omni (IPv6 ULA overlay, `fdae::/16`), enrolled with a **join token** in the SideroLink URL (`?jointoken=…&grpc_tunnel=true`). The ephemeral WireGuard key is generated on the node. [SideroLink](https://docs.siderolabs.com/talos/v1.8/networking/siderolink), [Omni security](https://www.siderolabs.com/blog/how-talos-omni-makes-talos-linux-more-secure). I read `grpc_tunnel` as tunnelling WireGuard over gRPC when UDP is blocked **(unverified)**. | The join token is injected into installed images by kernel argument or cloud-init. An L3 overlay is a later add-on, not the control channel. |
| **Foreman Smart Proxy** | A standalone REST proxy in front of DHCP, DNS, TFTP and BMC, with a **provider-pattern plugin** for each feature (ISC or MS DHCP, Infoblox or PowerDNS). [smart-proxy](https://github.com/theforeman/smart-proxy) | Each feature in site mode is a provider plugin. |
| **LXD / Incus** | REST API over a unix socket (the admin group gets full access) or HTTPS with **TLS client certificates plus trust tokens**, or OIDC. Load balancers that terminate TLS only work with OIDC. [auth](https://linuxcontainers.org/incus/docs/main/authentication/) | This confirms that the daemon gateway needs **TLS passthrough at layer 4**. Incus becomes a runtime driver. |
| **Proxmox VE** | Cluster-level REST at `/api2/json`, authenticated with the `Authorization: PVEAPIToken=USER@REALM!TOKENID=UUID` header. [API](https://pve.proxmox.com/wiki/Proxmox_VE_API) | Modelled as a **provider** (it manages a cluster), not as a per-node runtime. |
| **libvirt / Firecracker / Cloud Hypervisor** | Firecracker: REST over a unix socket (`PUT /machine-config`, `/boot-source`, then `/actions {InstanceStart}`). Configuration freezes after start. The jailer is used in production. [getting-started](https://github.com/firecracker-microvm/firecracker/blob/main/docs/getting-started.md). Cloud Hypervisor: `vm.create` then `vm.boot`, plus pause, resume, shutdown and delete. [api.md](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/main/docs/api.md) | `RuntimeDriver`, which separates `create` from `start`. |
| **kubelet, device plugins, DRA** | (1) Heartbeats are a `Lease` in `kube-node-lease`: 40s duration, renewed about every 10s (0.25×). [leases](https://kubernetes.io/docs/concepts/architecture/leases/) (2) TLS bootstrap uses a bootstrap token, a CSR and `rotateCertificates`. [TLS bootstrap](https://kubernetes.io/docs/reference/access-authn-authz/kubelet-tls-bootstrapping/) (3) Device plugin RPCs are `GetDevicePluginOptions`, `ListAndWatch`, `GetPreferredAllocation`, `Allocate` and `PreStartContainer`. (4) **DRA is GA in 1.34** (`resource.k8s.io/v1`: `DeviceClass`, `ResourceSlice`, `ResourceClaim[Template]`), with devices described by typed attributes and CEL selectors. [v1.34](https://kubernetes.io/blog/2025/08/27/kubernetes-v1-34-release) | Leases for liveness; the CSR flow; a device model shaped like DRA; a `preferAllocation` hook. |
| **NVIDIA GPU Operator** | MIG strategies `single` (all partitions the same size) and `mixed` (profile-qualified resources such as `nvidia.com/mig-3g.40gb`). Time-slicing uses a replica count and can apply on top of MIG instances. It gives no memory or fault isolation, and DCGM-exporter cannot attribute metrics per container under time-slicing. [time-slicing](https://docs.nvidia.com/datacenter/cloud-native/gpu-operator/latest/gpu-sharing.html). The DRA driver's **ComputeDomains** manage IMEX domains for multi-node NVLink (GB200 NVL72). [DRA/CD](https://docs.nvidia.com/datacenter/cloud-native/gpu-operator/latest/dra-cds.html) | GPU sharing modes as pool policy; the NVLink fabric domain as a topology key. |
| **DCGM** | `dcgmi diag -r 1/2/3/4` takes roughly seconds, about 2 minutes, about 15 minutes, and longer. XID is exposed as `DCGM_FI_DEV_XID_ERRORS` (field 230). [diag](https://docs.nvidia.com/datacenter/dcgm/latest/reference/command-line-reference/dcgmi/dcgmi-diag.html), [dcgm-exporter](https://github.com/NVIDIA/dcgm-exporter) | Diagnostic tiers for commissioning and testing; health classification. |
| **Nomad** | (1) Device plugin interface is `Fingerprint`, `Reserve` and `Stats`, plus a base `PluginInfo`, `SetConfig` and `ConfigSchema`, run out of process through go-plugin. [devices](https://developer.hashicorp.com/nomad/docs/concepts/plugins/devices) (2) Scheduling: evaluation broker, parallel scheduler workers, then a **plan queue on the leader with optimistic concurrency** that accepts, partly rejects or rejects plans. [scheduling](https://developer.hashicorp.com/nomad/docs/concepts/scheduling/scheduling) (3) **Heartbeat TTL scales with cluster size**: `TTL ≈ clients / max_heartbeats_per_second` (default 50/s), with up to 2× jitter, `min_heartbeat_ttl` 10s, `heartbeat_grace` 10s and `failover_heartbeat_ttl` 5m after a leader change. [server](https://developer.hashicorp.com/nomad/docs/configuration/server) (4) `disconnect.lost_after`: a client that stops heartbeating becomes "disconnected" and its allocations "unknown", not immediately lost. [disconnect](https://developer.hashicorp.com/nomad/docs/job-specification/disconnect) | Plugin trio; optimistic plan commit; heartbeat-rate budget; grace after failover; disconnected versus lost. |
| **hashicorp/go-plugin** | Plugins run as subprocesses. A magic-cookie handshake is followed by a stdout line `CORE-PROTO\|APP-PROTO\|tcp\|addr\|grpc\|cert`, then gRPC with AutoMTLS. [go-plugin](https://github.com/hashicorp/go-plugin) | Out-of-process daemon drivers in any language. |
| **Slurm GRES** | `AutoDetect=nvml` fills in Type, File, Cores (CPU affinity) and Links (NVLink). `gres/shard` and `gres/mps` split one GPU into counted units (MPS usually 100 per GPU). [gres](https://slurm.schedmd.com/gres.html), [gres.conf](https://slurm.schedmd.com/gres.conf.html) | Fractional units; NVML-derived CPU affinity and NVLink links. |
| **SkyPilot** | An optimizer chooses the cheapest *available* option across infrastructure. `any_of` gives candidate resources with **automatic failover** across regions, clouds and Kubernetes clusters. [failover](https://docs.skypilot.co/en/stable/examples/auto-failover.html) | An `Offer` catalog in the provider layer; a failover placement policy. |
| **vast.ai / RunPod hosts** | vast.ai hosts run daemon software. `vastai self-test machine <id>` checks the driver, network, PCIe bandwidth and VRAM, and verification is **continuous**. [hosting](https://docs.vast.ai/host/hosting-overview). RunPod Community Cloud hosts are invite-only and vetted, while Secure Cloud runs on T3/T4 partners. [partners](https://docs.runpod.io/hosting/partner-requirements). How either host agent works internally is **(unverified)**. | Continuous verification becomes a node condition. The self-test is the `testing` phase. |
| **Teleport** | Agents open **reverse tunnels** to the proxies. Join methods include token and `tpm` (no shared secret). **Proxy peering**: an agent's heartbeat carries `ProxyID`, peer proxies forward over gRPC with mTLS, and `tunnel_strategy: proxy_peering` with `agent_connection_count` (default 1) sets how many tunnels each agent opens. [agents](https://goteleport.com/docs/reference/architecture/agents/), [join methods](https://goteleport.com/docs/reference/deployment/join-methods/), [RFD 69](https://github.com/gravitational/teleport/blob/master/rfd/0069-proxy-peering.md) | Routing node → gateway, and forwarding between gateways. |
| **Tailscale DERP** | Relay over TLS on 443 that is always available, because nearly every network allows outbound HTTPS. Connections start on the relay and upgrade to direct when possible. [DERP](https://tailscale.com/docs/reference/derp-servers) | The WebSocket fallback exists for the same reason. |
| **SPIRE** | Node attestor plugins (`join_token`, `tpm_devid`, `x509pop`, cloud IIDs). The SVID auto-rotates while the agent stays connected, and `availability_target` sets when it rotates. [agent](https://github.com/spiffe/spire/blob/main/doc/spire_agent.md) | `NodeAttestor` plugin interface; SPIFFE-style certificate SANs. |
| **Daytona** | TypeScript (NestJS) API; **runners, the in-sandbox daemon and the proxy are written in Go**. Runner v2 is job-based: runners **poll the API for jobs** through `poller.Poller`. There is a runner-adapter pattern, and state changes are serialized with per-sandbox Redis locks (`sandbox:${id}:state-change`). [architecture](https://www.daytona.io/docs/en/architecture/), [runner API](https://deepwiki.com/daytonaio/daytona/13.6-runner-api-reference), [changelog](https://www.daytona.io/changelog/job-based-runners-custom-regions) | The closest precedent for a TypeScript control plane with a Go agent. The adapter pattern is how we version the daemon protocol. |

Two market facts for the provider layer:

- **Equinix Metal reached end of life on 2026-06-30** ([FAQ](https://docs.equinix.com/metal/eos-faq/)). Do not design around its API.
- Hetzner Robot has `POST /boot/{server-number}/rescue` and `POST /reset/{server-number}` ([Robot API](https://robot.hetzner.com/doc/webservice/en.html)).

---

## 2. (a) Transport between daemon and control plane

**Topology.** The daemon dials out on 443 to `gw.<region>` behind a **layer-4 load balancer with TLS passthrough**. mTLS terminates on the gateway itself, as the Incus load-balancer caveat requires.

- **Primary:** one HTTP/2 connection carrying a gRPC bidirectional `Session` stream.
- **Tunnels:** additional HTTP/2 streams on the same connection, opened on demand for console, exec, log tail and port-forward, in the style of Teleport's reverse tunnel.
- **Fallback:** `wss://…/v1/session` carrying the same protobuf frames, length-prefixed. The daemon uses it when HTTP/2 or gRPC is blocked by TLS-inspecting proxies or layer-7 middleboxes.
- **Not used:** long-poll. Daytona-style polling is simpler, but at 10k nodes it costs thousands of requests per second for idle nodes. Keep a unary `Sync` RPC only as a last-resort degraded mode.
- **Libraries:** the Go daemon uses `connect-go` speaking the gRPC protocol. The Node gateway uses `@connectrpc/connect-node` (or `@grpc/grpc-js`), which serves gRPC, Connect and gRPC-Web. **Bidirectional streaming needs HTTP/2** ([Connect docs](https://connectrpc.com/docs/node/server-plugins/)).

**Protocol sketch (`proto/bettercompute/agent/v1/session.proto`)**
```proto
service AgentGateway {
  rpc Session(stream AgentMsg) returns (stream ServerMsg);     // control
  rpc Tunnel(stream TunnelFrame) returns (stream TunnelFrame); // interactive, opened on OpenTunnel
  rpc Join(JoinRequest) returns (JoinResponse);                // server-auth TLS only
  rpc RenewCertificate(RenewRequest) returns (RenewResponse);  // over mTLS
}
message Hello   { string node_id=1; string daemon_version=2; uint32 proto_min=3; uint32 proto_max=4;
                  repeated string capabilities=5; uint64 last_applied_cmd_seq=6; uint64 last_acked_event_seq=7;
                  map<string,string> inventory_section_hashes=8; string boot_id=9; uint64 applied_generation=10; }
message Welcome { string session_id=1; uint64 session_epoch=2; uint32 proto=3; string gateway_id=4;
                  uint32 heartbeat_ms=5; uint32 max_inflight_cmds=6; repeated string request_sections=7; }
message Command { string command_id=1 /*ULID*/; uint64 seq=2 /*per-node monotonic*/; string kind=3;
                  bytes payload=4; google.protobuf.Timestamp deadline=5; uint32 attempt=6;
                  uint64 min_generation=7 /*fencing*/; Priority priority=8; }
// AgentMsg oneof: Hello | Heartbeat{credits, load} | CommandAck{id, accepted|rejected(UNSUPPORTED|STALE_GEN)}
//                 | CommandProgress | CommandResult{id, status, outputs, error} | Event{seq, type, key, payload} | Ack{cmd_seq}
// ServerMsg oneof: Welcome | Command | Cancel{id} | DesiredState{generation, spec} | Ack{event_seq} | OpenTunnel{id, target} | Drain{reconnect_after_ms}
```

**Semantics**

- **Desired state first.** Most work is `DesiredState{generation N}`: the host config, the runtime instances and the device partitioning. The daemon converges and reports `observedGeneration`. Imperative `Command`s are only for one-shot actions such as reboot, diagnostics, collecting logs or self-update.
- **At-least-once with deduplication.** The durable record of every command is a Postgres row carrying `command_id` and a per-node `seq`. The daemon keeps a local journal (bbolt or SQLite) mapping `command_id` to its result, and returns the stored result when a duplicate arrives. `UNIQUE(node_id, idempotency_key)` on the server stops duplicate enqueues. Handlers must be idempotent. `min_generation` fencing rejects stale commands with `STALE_GEN`.
- **Resume.** `Hello.last_applied_cmd_seq` makes the gateway replay commands above that sequence number that have not reached a terminal state. The daemon resends events from its journal that have not been acknowledged. `session_epoch` is increased on every connect, and a stale gateway's writes are rejected with `WHERE session_epoch = $e`.
- **Heartbeats and leases.**
  - HTTP/2 PING keepalive runs every 30s. The application sends `Heartbeat` about every 10–15s, like the kubelet lease renewal.
  - Liveness is held **in gateway memory**. Gateways batch-write `node_sessions.last_seen` every 30–60s with a single `UPDATE … FROM unnest()`. Nothing is written per heartbeat.
  - Lease TTL is 40s. After TTL plus grace, `connectivity` becomes `unreachable`. After a per-pool `lostAfter`, it becomes `lost`: minutes for VPS, and for bare metal never automatic.
  - After a control-plane or gateway failover, apply Nomad's `failover_heartbeat_ttl` idea: a global grace window (for example 5m) during which no node is marked unreachable.
- **Backpressure.** HTTP/2 flow control plus application credits: `Welcome.max_inflight_cmds` (for example 16) and `Heartbeat.credits`.
  - Priority lanes are `control` > `provision` > `bulk`.
  - Daemon events are coalesced latest-wins by `(type, key)` for status and health. Command results are never dropped.
  - Large payloads such as logs, full `nvidia-smi -q` output and support bundles never travel on the control stream. They go to pre-signed object-store URLs, and the stream carries references.
- **Offline buffering.** The journal is capped (for example 64 MiB or 10k events). Metric-like events are dropped oldest-first; results and state transitions are never dropped.
  - While offline, the daemon **keeps enforcing the last desired generation** and never tears workloads down because it is disconnected, as the kubelet and Nomad do.
  - All lease and expiry arithmetic uses the server's `now()`, because client clocks can drift.
- **Version skew.**
  - `proto_min`/`proto_max` negotiation, plus `capabilities[]` to gate features.
  - Protobuf changes may only add fields; `buf breaking` enforces this.
  - An unknown `kind` produces `rejected: UNSUPPORTED`, never a crash.
  - Policy: the control plane supports daemon versions up to N−3 minors, modelled on the kubelet skew policy **(n−3 figure unverified)**. The control plane is upgraded first.
  - Self-update is a `Command{kind:"daemon.upgrade"}` pointing at a cosign-signed artifact. The daemon keeps two binaries (A/B) and rolls back automatically if it does not reconnect within T.

---

## 3. (b) Node identity bootstrap and handoff to better-iam

**Join flow**

1. An admin calls `POST /v1/join-tokens` with `{tenantId, poolId, labels, maxUses, ttl (≤24h), expect?: {productUuid|serial|mac|bmcMac}, allowReclaim}`.
   - The token has the form `bcjt_<id>.<secret>`, following the Kubernetes bootstrap-token split between a public ID and a secret.
   - The server stores only `sha256(secret)`, the same approach as better-iam's `Trust.externalIdHash`.
2. The daemon generates an **ECDSA P-256** key. P-256 because TPMs support it and Ed25519 generally not. If a TPM is present, the key is created as a non-exportable TPM key.
3. The daemon calls `Join` over server-authenticated TLS. The CA is pinned with `--ca-hash sha256:…` **(pattern borrowed from kubeadm; unverified)**. The request carries `{token, csr, hardwareClaims{productUuid, serial, macs[], bmcMac?}, attestation?}`.
4. The server allocates a `nodeId` (ULID). The regional **issuing CA** signs a certificate with `URI SAN spiffe://<trust-domain>/tenant/<t>/node/<nodeId>` and a 24h lifetime.
   - The root CA is kept offline. The issuing CA's key lives in a cloud KMS or Vault PKI.
5. The daemon renews with `RenewCertificate(CSR)` over its existing mTLS session once about 50–66% of the lifetime has passed. This is SPIRE's `availability_target` idea.

**Attestors (`NodeAttestor` plugin interface, following SPIRE)**
- `join-token`: the default.
- `tpm`: EK certificate chain plus AK credential activation, optionally with a PCR 7/secure-boot quote. This follows Teleport's `tpm` join and SPIRE's `tpm_devid`. Implement it with Go `google/go-attestation` **(library choice unverified)**. Keylime-style periodic re-attestation can come later **(unverified)**.
- `x509pop`: for fleets that already have certificates.
- `cloud-iid`: VPS providers' signed instance identity.
- `provisioned`: when better-compute itself installs the OS, the workflow mints a **single-use token bound to productUuid**. The token is injected through cloud-init, Ignition or the kernel command line, the way Omni puts the join token in the SideroLink URL.
- **Ramdisk commissioning:** the PXE-booted ramdisk daemon gets a **discovery credential** that only allows `RegisterDiscovered`, `ReportInventory` and `GetWorkflow`. The site agent that issued the DHCP lease vouches for it with a signed MAC/IP assertion.

**Rotation and revocation**
- Certificates are short-lived, so there is no CRL or OCSP.
- Revocation is keyed on `nodeId` and pushed to every gateway through a change feed. A gateway kills the session immediately, and `RenewCertificate` refuses.
- Reinstalling the same hardware creates a new key. The server matches `productUuid`+`serial` and requires either `allowReclaim` or an admin's approval, which blocks identity theft through re-enrollment.

**better-iam integration (read-only survey of `C:\Users\Sean Filimon\Desktop\better-iam`)**

1. **Humans and API clients reaching the control plane:** the control plane is an OAuth resource server.
   - Use `createAccessTokenVerifier` and `createResourceGuard` from `packages/oauth/src/resource-server.ts`, which verify RFC 9068 JWT access tokens and **DPoP (RFC 9449)**.
   - Also accept better-iam session JWTs through `createSessionTokenVerifier` in `packages/server/src/session-tokens.ts` (`typ: 'biam-session+jwt'`, EdDSA or ES256).
   - Authorization uses `createRequestHelpers(...).can(action, resource)` and `.authorize(checks)` from `packages/middleware/src/index.ts`.
2. **Permission catalog:** ship `@better-compute/iam` exporting a better-iam `IamPlugin` (`packages/core/src/index.ts`: `{id, actions, resourceTypes, endpoints, hooks}`).
   - Actions: `compute:nodes:read|update|drain|cordon|delete`, `compute:pools:*`, `compute:allocations:create|release`, `compute:provision:run`, `compute:join-tokens:create`, `compute:console:open`.
   - Resource types: `compute:node` and `compute:pool`. Attributes are `pool`, `region`, `gpuModel` and `labels`, so policies can use conditions such as "team X may drain nodes only in pool `research`".
   - better-compute's tenant is better-iam's `tenantId`.
3. **Nodes and their workloads calling other services (recommended path, with no static secret on disk):**
   - The control plane runs a **minimal OIDC issuer** for node identity: `/.well-known/openid-configuration` plus JWKS. Tokens carry `sub=node:<id>` and the claims `tenant`, `pool`, `region`, `labels`, `gpu_models`.
   - The daemon fetches a 5–10 minute token over its mTLS session with `IssueIdentityToken(audience)`.
   - Register the issuer in better-iam with `oidcProviders.create`. Create a `serviceAccounts.create` identity and a **web-identity trust** with `trust.create`, whose model is `Trust{kind:'web-identity', providerId, conditions` (they must pin `token.sub`, or a claim pattern such as `token.pool`), `tagClaims: {pool:'pool', node:'node_id'}, sourceIdentityClaim:'node_id', maxSessionSeconds, ceiling}`. The model is in `packages/server/src/models.ts`.
   - The daemon calls `sts.assumeRoleWithWebIdentity({tenantId, trustId, webIdentityToken, sessionName:'node-<id>', durationSeconds, policy?, format:'jwt', audience})` (`packages/server/src/web-identity-exchange.ts`) and gets a scoped `RoleCredential`.
   - Decommissioning calls `trust.revokeSessions`, which uses `sessionsRevokedBefore`. `better-compute doctor` uses `trust.evaluateWebIdentity` as a dry run.
   - Alternative: if the target is an OAuth resource server, exchange at the token endpoint with the RFC 8693 `urn:ietf:params:oauth:grant-type:token-exchange` grant. `packages/oauth/src/provider.ts` supports it.
4. **Fallback for dev or air-gapped setups:** a scoped API key per node or pool through `credentials.create({tenantId, identityId, scopes:[…], expiresInSeconds})` with `credentials.rotate` and `revoke` (`packages/server/src/api/service-accounts.ts`). This is documented as less secure because a long-lived secret sits on disk.
5. **The control plane's own calls to better-iam** (for example creating a trust for each tenant): a confidential OAuth client with `client_credentials`, `private_key_jwt` and `requireDpop: true`, all supported in `provider.ts`.

---

## 4. (c) Inventory model

**Schema (`@better-compute/inventory`; the Go daemon emits the same types from protobuf)**
```ts
interface NodeInventory {
  schemaVersion: 1; collectedAt: string; sectionHashes: Record<Section, string>; // 'system'|'cpu'|'memory'|'disks'|'nics'|'gpus'|'bmc'|'os'
  system: { vendor; product; serial; productUuid; biosVersion; bootMode: 'uefi'|'bios'; secureBoot?: boolean; tpm?: { version: '2.0'; ekCertIssuer?: string } };
  cpu: { model; vendor; sockets; cores; threads; flags: string[] /* avx512f, amx_tile, … */; numa: { id; cpus: string; memBytes }[] };
  memory: { totalBytes; hugepages: Record<'2Mi'|'1Gi', number>; dimms?: { slot; sizeBytes; speedMTs; type; ecc: boolean }[]; edac?: { ce: number; ue: number } };
  disks: { name; model; serial; wwn?; sizeBytes; rotational; transport: 'nvme'|'sata'|'sas'|'virtio'; smart?: { healthy: boolean; wearPct?: number; mediaErrors?: number } }[];
  nics: { name; mac; driver; firmware?; speedMbps?; pciAddress?; numaNode?; sriovTotalVfs?; rdma?: 'ib'|'roce'; link: 'up'|'down' }[];
  gpus: GpuInventory[];
  bmc?: { ip?; mac?; vendor?; firmware?; redfish: boolean; ipmi: boolean };
  os?: { distro; kernel; cgroup: 'v1'|'v2'; kvm: boolean; iommu: boolean; runtimes: string[] /* containerd, docker, incus, libvirt */ };
}
interface GpuInventory {
  index; uuid; pciBusId; model; arch; vramBytes; serial?; vbios; driverVersion; cudaDriverVersion; numaNode;
  powerLimitW; persistenceMode: boolean; computeMode: string;
  mig: { capable: boolean; current: 'enabled'|'disabled'; pending?: 'enabled'|'disabled'; profiles: { name: string /* 1g.10gb */; maxInstances: number }[]; instances?: { giId; ciId; profile; uuid }[] };
  nvlink: { link: number; state: 'up'|'down'; peer?: string /* uuid or NVSwitch */ }[];
  topology: Record<string /*peer uuid*/, 'NV'|'PIX'|'PXB'|'PHB'|'NODE'|'SYS'>;   // from nvidia-smi topo -m / NVML
  fabric?: { clusterUuid?: string; cliqueId?: number };                          // MNNVL/IMEX domain (GB200)
  ecc: { enabled: boolean; volatile: { sbe: number; dbe: number }; aggregate: { sbe: number; dbe: number } };
  rowRemap?: { correctable: number; uncorrectable: number; pending: boolean; failure: boolean };
}
```

**Collecting it on Linux.** In Go, prefer reading `/sys` and native libraries; shelling out is the fallback.

| Section | Primary source | Fallback or CLI |
|---|---|---|
| System | `/sys/class/dmi/id/{product_uuid,product_serial,sys_vendor,product_name,bios_version}` | `dmidecode -t system,bios,baseboard,17` (DIMMs, needs root) |
| CPU and NUMA | `/proc/cpuinfo`, `/sys/devices/system/node/node*/cpulist` | `lscpu -J` |
| Memory | `/proc/meminfo`, `/sys/kernel/mm/hugepages`, `/sys/devices/system/edac/mc/mc*/{ce,ue}_count` | `dmidecode -t 17` |
| Disks | `/sys/block/*`, udev properties | `lsblk -J -b -O`, `nvme list -o json`, `smartctl -j -a` |
| NICs | netlink (`vishvananda/netlink`), `/sys/class/net/*/device/{numa_node,sriov_totalvfs}`, `/sys/class/infiniband` | `ip -j link`, `ip -j addr`, `ethtool -i` |
| PCI | `/sys/bus/pci/devices/*` | `lspci -vmm -nn -D` |
| GPU | **NVML through `NVIDIA/go-nvml`** ([repo](https://github.com/NVIDIA/go-nvml)): identity, MIG, NVLink state, topology common ancestor, ECC, remapped rows, and XID events | `nvidia-smi --query-gpu=index,uuid,pci.bus_id,name,memory.total,driver_version,vbios_version,serial,mig.mode.current,ecc.mode.current,temperature.gpu,power.draw,power.limit,clocks_throttle_reasons.active --format=csv,noheader,nounits`; `nvidia-smi topo -m`; `nvidia-smi nvlink -s`; `nvidia-smi mig -lgip`; `nvidia-smi -q -d ROW_REMAPPER`; `nvidia-smi -q -x` (full XML) |
| GPU diagnostics | DCGM (`dcgmi discovery -l`, `dcgmi health -s a`, `dcgmi diag -r N`) | none |
| BMC, from the host | `ipmitool lan print 1` in-band through `/dev/ipmi0`, or the Redfish host interface | out-of-band discovery by the site agent |
| Everything else | none | `lshw -json`, slow, so at commissioning only |

**Detecting changes**
- Canonicalize each section: sort arrays and strip volatile fields such as temperatures and power. Then compute `sha256` per section.
- `Hello` and a periodic `Heartbeat` carry the section hashes. The server asks for full sections only when a hash differs (`Welcome.request_sections`).
- Collection is triggered by boot (a `boot_id` change), udev and netlink uevents, the end of each provisioning step, and a jittered full rescan every 6–24h.
- Storage: `inventory_snapshots` is an append-only compressed JSONB table (or object store). `nodes.inventory_hash` points at the latest snapshot.
- A diff engine emits typed events: `gpu.missing`, `gpu.added`, `disk.replaced`, `driver.changed`, `mig.layout.changed`. Pool policy reacts to them. For example, if the GPU count falls below expected, the node is cordoned and marked `condition GpuCountMismatch`.

**Health signals, as conditions shaped like Kubernetes NodeConditions: `{type, status, reason, since}`**

| Tier | What it covers | Cadence |
|---|---|---|
| Fast | NVML temperature, power, throttle reasons, volatile ECC, row-remap pending or failure, PCIe replay counter, NVLink CRC and replay errors, EDAC, SMART | 10–30s |
| Event-driven | XID through NVML `nvmlDeviceRegisterEvents(nvmlEventTypeXidCriticalError)` and `/dev/kmsg` `NVRM: Xid` | as they happen |
| Active | `dcgmi diag -r 2` at commissioning and after each reboot into service; `-r 3` when a problem is suspected | per event |

XID classification ([XID guide](https://docs.nvidia.com/deploy/xid-errors/archive/index.html)):

| XID | Meaning | Action |
|---|---|---|
| 48 | uncorrectable (DBE) ECC | quarantine the GPU |
| 63 | row remap recorded | reset required: drain, then GPU reset |
| 64 | row remap failed | RMA |
| 79 | GPU fell off the bus | PCIe, riser or power: node-level issue |
| 94 | contained memory error | kill the job |
| 95 | uncontained memory error | restart the node |

Conditions feed taints automatically, for example `unhealthy.gpu/<uuid>:NoSchedule`.

---

## 5. (d) Capacity model

**Per node and resource**
```
capacity    = physical (inventory)
allocatable = capacity − systemReserved (OS, bcd, hypervisor overhead) − evictionReserve
allocated   = Σ active allocations (bound leases)
reserved    = Σ future or pending reservations overlapping `now` (not yet bound)
available   = allocatable × overcommitRatio(pool, resource) − allocated − reserved
```
Only nodes where `provisionState ∈ {ready, deployed, adopted}`, `maintenance=false` and `connectivity=connected` add to schedulable capacity. Other nodes are reported in their own buckets: `provisioning`, `unhealthy`, `maintenance` and `unreachable`.

**Two kinds of resources**
1. **Scalar:** `cpu` in millicores, `memory`, `ephemeralDisk` and `hugepages`.
2. **Devices, modelled like DRA:** each GPU, MIG instance, SR-IOV VF or NVMe disk is a row carrying attributes. Requests use selectors, not counts:
```ts
interface ResourceRequest {
  cpu?: number; memoryBytes?: number;
  devices?: { name: string; class: 'gpu'|'gpu.mig'|'gpu.shared'|'nic.vf'|'disk';
              count: number; selector?: string /* CEL-like: device.model == "H100-SXM5" && device.vramGiB >= 80 */;
              topology?: 'nvlink-all'|'same-pcie-switch'|'same-numa'|'same-fabric-domain'|'none';
              sharing?: 'exclusive'|'mig'|'timeslice'|'mps' }[];
  colocate?: { gangSize: number; topologyKey: 'rack'|'fabric.clusterUuid'|'ib.rail' };
}
```

**Fractional GPUs.** The sharing mode is **pool or node policy**, not something each request chooses, because changing it requires the GPU to be drained or reset.

| Mode | How it works | Limits |
|---|---|---|
| `mig` | Hardware partitions. Device ID is `<gpuUuid>/gi<id>/ci<id>`. The pool picks a layout, like the Operator's `single` or `mixed` strategies. | Reconfiguring is a node desired-state change that requires the GPU to be idle |
| `timeslice` | N replica slots per GPU (or per MIG instance), marked `isolation: none` | No memory or fault isolation, and no metrics per consumer |
| `mps` | Units of `CUDA_MPS_ACTIVE_THREAD_PERCENTAGE` plus `CUDA_MPS_PINNED_DEVICE_MEM_LIMIT`, like Slurm `gres/mps` (100 units per GPU) and `gres/shard` | none noted |

**Topology-aware placement**
- Score candidates with the topology matrix NV > PIX > PXB > PHB > NODE > SYS.
- An 8-GPU HGX board behind NVSwitch counts as all-to-all, so any subset of it is equivalent.
- Pin CPUs and memory to the GPU's `numa_node`. Prefer NICs under the same PCIe switch for GPUDirect RDMA.
- Multi-node gangs place on `fabric.clusterUuid`/`cliqueId`, the equivalent of NVL72 IMEX domains, and on rack or rail labels.
- Each device driver can supply a `preferAllocation(available, mustInclude, size)` hook, like Kubernetes `GetPreferredAllocation`.

**Reservations and leases.** A two-phase allocation, with Postgres guaranteeing no overlap:
```sql
CREATE EXTENSION btree_gist;
CREATE TABLE device_bookings (
  device_id text NOT NULL, allocation_id text NOT NULL, during tstzrange NOT NULL,
  EXCLUDE USING gist (device_id WITH =, during WITH &&));
```
- The allocation moves `pending → reserved`: the scheduler's transaction inserts the bookings, and a conflict means retry, like Nomad's optimistic plan.
- It then moves `→ binding`: a command is sent and the daemon materializes the allocation (MIG, VM, container).
- Then `→ active`, with a lease `expires_at` renewed by the owner. It ends in `→ releasing → released`.
- A timeout during binding rolls back. A reaper releases expired leases.
- Future reservations are just bookings with a later `during`, which gives calendar-style GPU reservations for free.

**Overcommit (VPS pools only)**
- Per-pool `overcommit: { cpu: 4.0, memory: 1.0, disk: 1.5 }`. GPUs are **never** overcommitted.
- Guardrails come from observed pressure: CPU steal and PSI. A node over threshold gets `condition Pressure` and a `NoSchedule` taint.
- For reference, Nova-style allocation ratios (cpu 16.0 historically, with lower `initial_*` defaults later) **(values unverified)**.

**Pools, labels, taints**
- A pool is a scheduling domain plus policy: owner tenant, sharing mode, overcommit, default provisioning profile and `lostAfter`.
- Labels are **derived automatically from inventory**, like GPU Feature Discovery: `gpu.product`, `gpu.memory`, `gpu.count`, `gpu.arch`, `cuda.driver.major`, `mig.capable`, `fabric.domain`, `cpu.amx`, `region`, `rack`. Users can add their own.
- Taints: `maintenance`, `unhealthy.*`, `dedicated=<tenant>`, `provisioning`. Requests carry tolerations. Cordon and drain are verbs.

**Capacity views.** `pool_capacity_rollups` holds `(pool, resourceClass, model) → total, allocatable, allocated, reserved, available, unhealthy`. It is updated in the same transaction as allocation changes, or by a 10s incremental rollup. API reads never aggregate over 100k device rows.

---

## 6. (e) Provisioning driver taxonomy

**Composition.** Following Ironic, a machine picks one driver for each concern:
`{ power, management, boot, deploy, inspect, console?, raid?, bios?, firmware?, config[], runtimes[] }`.

Every driver declares **where it runs**:
- `control-plane`: TypeScript, in process. Cloud and provider APIs.
- `site`: the Go `bcd --mode=site`, which holds BMC, DHCP and TFTP reach.
- `node`: the Go daemon on the host.
- `ramdisk`: the Go daemon booted into an ephemeral OS.

Control-plane drivers are TypeScript packages. Daemon-side drivers are built into the Go binary, or loaded as **go-plugin subprocesses** so third parties can write them in any language, including Bun-compiled TypeScript.

```ts
// @better-compute/provision — driver contracts (TS side mirrors proto for daemon-executed drivers)
type RunsOn = 'control-plane' | 'site' | 'node' | 'ramdisk';
interface DriverContext { node: NodeRef; idempotencyKey: string; signal: AbortSignal; secrets: SecretResolver; log: Logger; emit(p: Progress): void }
interface Driver<C = unknown> { readonly kind: DriverKind; readonly id: string /* 'redfish' */; readonly runsOn: RunsOn;
  configSchema: StandardSchema<C>; capabilities(ctx: DriverContext): Promise<string[]>; validate?(ctx: DriverContext, cfg: C): Promise<void> }

// Out-of-band (BMC)
type PowerAction = 'on'|'off'|'graceful-off'|'reset'|'graceful-restart'|'cycle'|'nmi';          // Redfish ResetType: On, ForceOff, GracefulShutdown, ForceRestart, GracefulRestart, PowerCycle, Nmi
interface PowerDriver extends Driver { getPower(ctx): Promise<'on'|'off'|'unknown'>; setPower(ctx, a: PowerAction): Promise<void> }         // redfish | ipmi | provider-api | pdu-snmp
interface ManagementDriver extends Driver { setBootDevice(ctx, d: 'pxe'|'http'|'disk'|'cd'|'bios', o: { persistent: boolean; uefi: boolean }): Promise<void>;
  getSensors?(ctx): Promise<Sensor[]>; getSystemInfo?(ctx): Promise<BmcSystemInfo> }
interface VirtualMediaDriver extends Driver { insert(ctx, isoUrl: string): Promise<void>; eject(ctx): Promise<void> }                         // Redfish VirtualMedia.InsertMedia
interface ConsoleDriver extends Driver { open(ctx): Promise<DuplexStream> }                                                                     // IPMI SOL | Redfish serial | SSH-to-serial (Tinkerbell Second Star)
interface BiosDriver/RaidDriver/FirmwareDriver extends Driver { get(ctx); apply(ctx, desired): AsyncIterable<Progress> }

// Boot & install
interface BootDriver extends Driver { prepareRamdisk(ctx, r: { kernel: Url; initrd: Url; cmdline: string }): Promise<void>;                     // pxe | ipxe | uefi-http | virtual-media
  prepareInstance(ctx, i: { localBoot: true } | { kernel: Url; initrd: Url; cmdline: string }): Promise<void>; cleanUp(ctx): Promise<void> }
interface DeployDriver extends Driver {                                                                                                         // image-stream | kexec | autoinstall/kickstart | talos | provider-reinstall
  deploy(ctx, s: { image: { url: Url; format: 'raw'|'qcow2'; compression?: 'zstd'|'gz'; sha256: string }; rootDevice: DiskHint;
                   userData?: { kind: 'cloud-init'|'ignition'|'talos'; content: string }; partitioning?: Layout }): AsyncIterable<Progress>;
  tearDown(ctx, o: { wipe: 'none'|'quick'|'secure-erase'|'crypto-erase' }): AsyncIterable<Progress> }
interface InspectDriver extends Driver { inspect(ctx): Promise<NodeInventory> }                                                                  // agent (ramdisk/node) | redfish (OOB)

// In-place configuration (desired-state, idempotent)
interface ConfigDriver extends Driver { plan(ctx, desired: HostConfig, facts: HostFacts): Promise<ConfigPlan>; apply(ctx, p: ConfigPlan): AsyncIterable<Progress> }
// HostConfig units: packages, nvidia-driver(branch), cuda-toolkit, nvidia-container-toolkit + CDI, fabric-manager/IMEX, mig-layout, sysctl, hugepages, container-runtime, k8s-join{kubeadm|k3s|talos}, slurm-join

// Host runtimes (VPS / sandboxes / containers)
interface RuntimeDriver extends Driver {                                                                                                        // libvirt-kvm | firecracker | cloud-hypervisor | incus (ct+vm) | containerd | docker
  traits: { isolation: 'vm'|'microvm'|'system-container'|'container'; gpu: ('vfio'|'mig'|'cdi'|'none')[]; snapshot: boolean; liveMigrate: boolean; resize: boolean };
  create(ctx, spec: InstanceSpec): Promise<InstanceRef>; start(ctx, id); stop(ctx, id, o?: { force?: boolean }); delete(ctx, id);
  status(ctx, id): Promise<InstanceStatus>; resize?(ctx, id, r); snapshot?(ctx, id): Promise<SnapshotRef>; restore?(ctx, ref); exec?(ctx, id, cmd): Promise<DuplexStream> }

// Device plugins (Nomad Fingerprint/Reserve/Stats + K8s GetPreferredAllocation)
interface DevicePlugin extends Driver { fingerprint(ctx): AsyncIterable<DeviceGroup[]>; preferAllocation?(ctx, avail: string[], must: string[], n: number): Promise<string[]>;
  reserve(ctx, ids: string[]): Promise<{ env: Record<string,string>; cdiDevices?: string[]; mounts?: Mount[]; devices?: string[] }>; stats(ctx, every: number): AsyncIterable<DeviceStats[]> }

// External capacity (metal or VPS) — SkyPilot-style offers + failover
interface ProviderDriver extends Driver {                                                                                                       // hetzner-robot | hetzner-cloud | ovhcloud | latitude | proxmox | generic-cloud
  listOffers(ctx, f: OfferFilter): Promise<Offer[]>; provision(ctx, r: { offerId: string; image: string; userData: string /* includes join token */ }): Promise<ExternalMachine>;
  status(ctx, id); power?(ctx, id, a: PowerAction); rescue?(ctx, id); reinstall?(ctx, id, image); release(ctx, id): Promise<void> }
```

**Workflow engine.** A provisioning profile is a template of `Step{ driver: 'deploy.image-stream', action: 'deploy', args, timeout, retries, runsOn }`. It combines Tinkerbell templates with Ironic deploy steps. The control plane expands the profile into a `Workflow` bound to the node and dispatches each step to the agent that should run it. Step status is persisted, so a workflow resumes after a crash of any component.

Example: `ubuntu-24.04-cuda-12.x-k8s-worker`:
1. `power.cycle` → `boot.ipxe(ramdisk)`
2. `inspect` → `diag.dcgm(r2)`
3. `deploy.image-stream`, with cloud-init that includes the join token
4. `boot.local`
5. `config.nvidia-driver` → `config.container-toolkit` → `config.k8s-join`

**Notes on specific mechanisms**
- **Image streaming.** Pipe HTTP range reads through zstd decompression straight to the block device, verifying sha256 on the way. Tinkerbell's `image2disk` and Ironic's `direct` deploy do this. Images are served from the site agent's cache.
- **kexec** skips firmware POST, which takes minutes on big servers, both for fast reinstall and for handing from ramdisk to the installed kernel.
- **cloud-init NoCloud or config-drive vs Ignition:** choose per OS family.
- **Providers:** Proxmox is a provider, not a runtime, because it is a clustered API. Do not target Equinix Metal (end of life). Hetzner Robot uses rescue plus installimage.
- **VPS providers:** they produce nodes whose user-data installs `bcd` with a `provisioned` token, so they join like any other node.

---

## 7. (f) A horizontally scalable control plane in TypeScript and Node

**Tiers**

| Tier | State | Role |
|---|---|---|
| `api` | stateless | REST/OpenAPI plus Connect. better-iam auth. Writes desired state and outbox rows **in one transaction**. Never talks to daemons directly. |
| `gateway` | disposable per-connection state | Holds daemon streams. Upserts `node_sessions(node_id PK, gateway_id, session_epoch, connected_at, last_seen)`. Relays commands and events. Target roughly 5–10k streams per process **(unverified; load test)**. Several processes per host with `reusePort`. |
| `controller` | stateless workers | Reconcile loops for nodes, workflows, allocations and pools. Sharded (below). |
| `scheduler` | stateless workers | Placement. Plans are computed in parallel and committed optimistically; exclusion constraints are the final guard, following Nomad's plan queue. Partitioned per pool to limit contention. |
| `site` (Go) | per datacenter or rack | DHCP/TFTP/iPXE/HTTP boot, image cache, BMC (`bmclib`). Connects outbound to the gateways like a node, with extra capabilities. |
| Postgres | source of truth | Tables: nodes, devices, bookings, allocations, workflows, commands, jobs, audit. Partitioned by time where it grows. |
| Object store | blobs | Images, logs, inventory snapshots, support bundles. |
| Time-series DB | telemetry | Prometheus remote-write, OTLP or VictoriaMetrics, written directly from `bcd` or dcgm-exporter. **Never Postgres.** |
| NATS core or Redis pub/sub (optional) | none | Payload-free pokes only, such as `gw.<id>.wake` or `node.<id>.dirty`. Correctness never depends on it. |

**Queue choice.** Use Postgres jobs and outbox with `SELECT … FOR UPDATE SKIP LOCKED LIMIT n` (the graphile-worker or pg-boss pattern).
- It is transactional with state changes, so there are no dual writes.
- It is simple to operate, and the working set here is small (commands and state transitions, not telemetry).
- **Do not put LISTEN/NOTIFY on the hot path.** NOTIFY takes a global lock at commit that serializes commits ([Recall.ai](https://www.recall.ai/blog/postgres-listen-notify-does-not-scale)). It also does not survive PgBouncer transaction pooling.
- Reach for NATS JetStream only if event fan-out outgrows Postgres, which is unlikely when telemetry is kept out.

**Desired state and reconcile.**
- `nodes.generation` is bumped whenever the specification changes, and the daemon reports `observed_generation`.
- Controllers are **level-triggered**: every node is resynced every 5–10 minutes with jitter. They are also **edge-triggered** by a `dirty_nodes` queue that is enqueued in the same transaction as the change.

**Sharding reconcilers.** Use a fixed set of shards, for example 256.
```sql
CREATE TABLE shard_leases (shard int PRIMARY KEY, owner text, epoch bigint NOT NULL DEFAULT 0, expires_at timestamptz);
-- acquire/renew (fencing):
UPDATE shard_leases SET owner=$me, epoch = CASE WHEN owner=$me THEN epoch ELSE epoch+1 END, expires_at=now()+'15s'
 WHERE shard=$s AND (owner=$me OR expires_at < now()) RETURNING epoch;
-- nodes.shard = hashtext(node_id) & 255 (generated column); writes carry `AND shard_epoch_ok($s,$epoch)`
```
- Workers balance shards with rendezvous hashing over a membership table.
- Singletons (GC, CA rotation, rollups) use the same lease table. Use **table leases, not `pg_try_advisory_lock`**, which PgBouncer transaction mode breaks.

**Getting a command to the right gateway**
1. When a reconciler enqueues a command, it copies the node's current `gateway_id` from `node_sessions`.
2. It sends a best-effort poke to `gw.<id>`.
3. Each gateway drains `WHERE gateway_id=$me AND state='pending' ORDER BY node_id, seq FOR UPDATE SKIP LOCKED`, on a poke or every 500ms–1s as a fallback.
4. On reconnect elsewhere, `session_epoch` is increased and pending rows move to the new gateway (`UPDATE … SET gateway_id=$new WHERE node_id=$n AND state='pending'`). Resume then covers anything that was in flight.
5. **Interactive traffic** (console, exec, logs, port-forward) goes api → the owning gateway directly, over internal gRPC with mTLS. This is Teleport proxy peering, keyed off `node_sessions.gateway_id`. Nodes connect to 1 gateway, or 2 for high availability, as with `agent_connection_count`.

**What breaks first at 10k nodes and 100k GPUs**, in roughly the order it will hurt:
1. **Liveness writes.** 10k nodes heartbeating every 10s means about 1k UPDATEs per second, causing WAL churn, vacuum load and bloat. Fix: memory-first liveness with batched `last_seen` and writes only on transitions, following Kubernetes Leases and Nomad's `max_heartbeats_per_second` budget.
2. **Telemetry.** 100k GPUs × about 50 fields every 10s is roughly 500k samples per second. It must bypass both the control stream and Postgres.
3. **Reconnect storms** after a gateway deploy or a control-plane blip: 10k TLS handshakes, Hellos and replays. Fixes:
   - Jittered exponential backoff.
   - `Drain{reconnect_after_ms}` with staggered rollouts.
   - Resume based on hashes only.
   - A handshake admission rate per gateway.
   - Global failover grace, so nodes are not all marked unreachable at once.
4. **Scheduler contention** on popular pools such as H100s. Optimistic conflicts pile up. Fix: plan partitions per pool and batched claims.
5. **Capacity reads** that scan device tables. Fix: the rollups in §5.
6. **Inventory payloads.** `nvidia-smi -q -x` output is large. Fix: hash first, send only changed sections, compress, and store in the object store.
7. **Postgres connections.** Many replicas × pool size. Use PgBouncer in transaction mode, which is why leases live in tables and nothing relies on LISTEN.
8. **Growth of the commands, audit and event tables.** Partition by time and set retention.
9. **Node gateway CPU** during TLS storms. Keep gateways CPU-light and consider moving mTLS termination into a sidecar such as Envoy if needed **(unverified necessity; benchmark)**.

---

## 8. (g) Daemon language: **Go, with a TypeScript control plane**

| | Node SEA | Bun `--compile` | **Go** | Rust |
|---|---|---|---|---|
| Maturity | `--build-sea` arrived in 25.5 and is still *Experimental 1.1* ([docs](https://nodejs.org/api/single-executable-applications.html), [25.5](https://nodejs.org/en/blog/release/v25.5.0)) | Stable compile; cross-targets such as `bun-linux-arm64` ([docs](https://bun.com/docs/bundler/executables)) | Mature | Mature |
| Binary size and idle memory | About 100 MB, 50–80 MB RSS **(unverified)** | About 50–100 MB | About 15–30 MB, 15–30 MB RSS **(typical, unverified)** | About 5–15 MB, under 10 MB RSS **(typical, unverified)** |
| NVML and DCGM | No maintained binding, so shell out to `nvidia-smi` (fork cost, brittle parsing, no XID event subscription) | `bun:ffi` could `dlopen` NVML, but is experimental | **Official `NVIDIA/go-nvml`** ([repo](https://github.com/NVIDIA/go-nvml)); go-dcgm **(unverified)** | `nvml-wrapper` (libloading) ([repo](https://github.com/rust-nvml/nvml-wrapper)) |
| BMC (Redfish, IPMI) | Hand-rolled Redfish; IPMI means shelling out | Same | **`bmc-toolbox/bmclib`** (Redfish, IPMI, vendor drivers; used by Tinkerbell Rufio) ([repo](https://github.com/bmc-toolbox/bmclib)) | Thin |
| TPM, netlink, DHCP/TFTP, containerd, libvirt, Firecracker, Incus clients | Weak or none | Weak | All first-class | Partial |
| Runs in a ramdisk | Heavy | Heavy | Good; u-root style | Best |
| Cross-compiling linux/amd64 and arm64 (Grace/GB200 are arm64) | Needs a target Node binary per architecture | Easy | Easy. go-nvml uses cgo with dlopen, so build with `zig cc` or per-architecture buildx | `cargo-zigbuild` |
| Supply chain for a root agent | Large npm tree | Large npm tree | Small `go.mod`; `govulncheck`, SBOM, cosign | Small; `cargo-audit` |
| Precedent | none | none | Daytona runner and daemon, Tinkerbell agent, kubelet, Nomad, Teleport, Tailscale, Talos, SPIRE | Firecracker, Cloud Hypervisor |

**Recommendation: Go for `bcd`**, as one binary with `node`, `site` and `ramdisk` modes. The control plane, API, SDK, CLI, drivers that run in the control plane, and the better-iam glue stay in TypeScript. This is the same split Daytona uses.

**Shared types**
- `proto/` is the source of truth. `buf generate` produces:
  - `@better-compute/proto`, TypeScript through protobuf-es v2 and Connect.
  - `daemon/gen`, Go through protoc-gen-go and connect-go.
- `buf breaking` gates PRs.
- User-facing documents (profiles, templates, pool policy) are validated with JSON Schema generated from the same messages, or from TypeScript Standard Schema and then exported.
- The daemon is kept "dumb but capable": policy lives in TypeScript, and the daemon executes typed commands and converges typed desired state.
- The go-plugin boundary lets the community write daemon drivers, including in Bun-compiled TypeScript, without forking.

**Fallback if the team must stay single-language:** a Bun-compiled TypeScript node daemon that shells out to `nvidia-smi` and `ipmitool`, still with a Go site agent. This is not recommended: it means two agents to maintain and no event-driven XID watch.

---

## 9. Package and umbrella layout these decisions imply (short)

**Scoped packages:**
- `@better-compute/core`: domain types, state machines, errors.
- `@better-compute/proto`
- `@better-compute/inventory`: schema, diff, label derivation, health classification.
- `@better-compute/metal`: bare-metal lifecycle plus the power, management, boot, deploy and inspect contracts.
- `@better-compute/vps`: `RuntimeDriver` and `ProviderDriver` for VPS, and overcommit.
- `@better-compute/provision`: workflows, profiles, cloud-init and Ignition renderers, driver registry.
- `@better-compute/capacity`: claims, bookings, scheduler.
- `@better-compute/server`: api, gateway and controller entrypoints.
- `@better-compute/adapter-postgres`
- `@better-compute/client`
- `@better-compute/cli`
- `@better-compute/iam`: the `IamPlugin`, resource-server guard, OIDC issuer for node tokens, and STS helper.
- `@better-compute/provider-hetzner` and similar provider packages.

**Other pieces:**
- The Go module lives in `daemon/`. It ships signed release binaries and, optionally, an npm wrapper `@better-compute/daemon-bin`.
- The umbrella `better-compute` package exposes the subpaths `./metal`, `./vps`, `./provision`, `./inventory`, `./capacity`, `./client`, `./server`, `./iam` and `./cli`, the same way `better-iam/package.json` exports `./oauth` and the rest.

## 10. Items not verified in this pass
- Kubernetes n−3 kubelet skew.
- kubeadm CA-hash pinning pattern.
- Binary sizes and memory use for Node SEA, Go and Rust.
- How Node SEA handles native addons.
- The go-dcgm and go-attestation library choices.
- Streams per Node gateway process.
- Nova allocation ratios.
- The exact semantics of Omni's `grpc_tunnel`.
- Keylime.
- Internals of the RunPod and vast.ai host agents.
- Whether Envoy is needed to offload TLS.

The Container Device Interface (`nvidia-ctk cdi generate`) is also **(unverified)** here, but it is the right abstraction for injecting GPUs into containers.