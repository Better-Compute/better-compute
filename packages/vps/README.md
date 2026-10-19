# @better-compute/vps

VPS for better-compute (PLAN.md §3.6). The package holds:

- `vps()`, the module behind the `instances`, `flavors`, `providerAccounts`, `sandboxes`,
  `sandboxTemplates` and `sandboxSnapshots` API groups;
- `defineProvider`;
- the `runtime` driver kind;
- pool IPAM;
- the seams the gateway and node specs use.

It depends on `@better-compute/core`, `protocol`, `provision` and `capacity`. The application
injects it, and the server never imports it.

**Status: v0.3 control plane, plus v0.5 sandboxes.** Hosted instances, provider instances, flavors,
provider accounts and IPAM work, and so do the daemon report and node-spec seams. Sandboxes are
on the control plane side: templates, TTL, warm pools, snapshots, exec trust, env and network. bcd's
enforcement of `networkPolicy` and its `instance.snapshot` kind are still to come. The Hetzner
provider ships separately.

```ts
import { vps } from 'better-compute/vps';
import { hetznerCloud } from '@better-compute/provider-hetzner';

betterCompute({
  modules: [vps({ runtimes: ['libvirt-kvm'], providers: [hetznerCloud], images })],
});
```

## Instances

`instances.create({ tenantId, poolId, flavor, imageId, sshKeys, userData?, desiredState?, idempotencyKey })`
follows the reservation admission pattern:

- **Transaction 1** looks up the idempotency key per tenant and caller identity. The same request
  replays. A different request under the same key is `CONFLICT`.
- It checks that the pool is visible, the flavor exists and the image resolves. Compute checks
  image visibility itself.
- It then writes the deterministic draft (`draftId('inst', …)`) and its authz row, with
  attributes `vcpu`, `memoryGiB`, `gpus`, `imageId`, `imageVerified` and `projectId`.
- **After a refusal**, the draft is deleted, so a retry is decided afresh.
- **Transaction 2** admits the draft and schedules it.
  - A hosted pool places at once through `ctx.capacity` and returns `QUOTA_EXCEEDED` to the
    caller when quota runs out.
  - A provider pool charges quota now and creates the machine from the reconciler.

Later operations change only `desiredState`: `start`, `stop` and `delete`. The API never calls a
runtime. `resize` works on stopped hosted instances whose GPU count stays the same. It moves the
scalar claims in place on the node, quota first. `list` defaults to `scope: 'mine'`.

### Hosted pools (`class: 'vps-host'`, `agent: 'bcd'`)

- **Placement.** The instance claims vCPU (× overcommit), memory, disk and whole GPUs for VFIO
  through capacity. It then leases an IPv4 address from the pool's range (`setIpPool`).
- **Node spec.** `nodeSpec` gives the host `NodeSpec.instances`: image, flavor, the user-data ref,
  allocation, NIC, GPU atoms, and `desiredState: 'deleted'` while the instance is deleting.
- **Reports.** The gateway calls `reportInstances(tx, work, nodeId, reports, { complete })`. Only
  instances placed on that node are touched. A complete list marks missing instances `absent`.
  Instances the runtime holds that no row places there come back as `orphans`, which are leaks.
- **The `vps.instances` reconciler** turns reports into transitions:
  provisioning → starting → running ⇄ stopped, `error` on a runtime error, and deleted once the
  runtime drops the instance. Deletion releases the booking, the IP and the quota.
- **Lost hosts.** An instance on a `lost` node becomes `lost` (the periodic `vps.hosts` reconciler
  wakes instances on hosts Liveness declared lost; a vps-host node turns lost only when its pool
  sets `policy.lostAfter`). It recovers if the node comes back and reports it. With
  `policy.recreateOnHostLoss` it is re-placed on another node, and the old host's spec drops it, so a
  host that returns removes the stale domain.
- **Host capacity.** `vps.hosts` (every `hostSyncEvery`, default 30 s) derives each vps-host node's
  `vcpu` (logical CPUs), `memoryGiB` and `diskGiB` (non-removable disks) `node_resources` rows from
  its applied inventory, minus `vps({ hostReserve })` (default 2 vCPU, 8 GiB, 100 GiB), with the
  pool's `policy.overcommit[resource]` as the ratio (0.1 to 100). Rows change only when the
  inventory or policy does, never below what is allocated. Tenant-controlled nodes add nothing.
- **Runtimes.** A pool runs `policy.runtime`, else `vps({ runtimes })[0]`; the deployment must list
  it. `builtinRuntimeTraits` covers `libvirt-kvm`, `cloud-hypervisor`, `firecracker` and
  `containerd`; bcx runtimes pass `vps({ runtimeTraits })`. `instances.create` refuses image formats
  the runtime cannot boot and GPUs it cannot pass through.
- **Single-tenant containers (§13).** A container runtime (`containerd`) needs
  `policy.singleTenant`; capacity then offers the pool to one tenant besides its owner, and
  `instances.create` serves only that tenant (else the owner), never while the pool is offered to
  two tenants or still runs another tenant's instances.
- **User data.** The spec never carries it. At admission vps seals the rendered cloud-config through
  `ModuleContext.secrets` and keeps only its `secret://` ref (`instances.user_data_sealed`); the
  host fetches it with a node-signed `SecretRequest` for the instance's allocation, and vps deletes
  it with the instance. A tenant may pass its own `secret://<tenant>/<id>` ref as `userData`; refs of
  other tenants, `vault://` and `env://` are refused.
- **NICs.** Each spec carries `allocationId` and one NIC on `vps({ hostNetwork })` (default `br0`)
  with the IPAM address in CIDR form and a stable locally administered MAC. A leased NIC also gets the range's gateway and `setIpPool({ dns })` nameservers; bcd writes them into the guest's NoCloud network-config.
- **Host placement (§3.8, v1.1).** A flavor's `placement` is `{ numaAffine, pinned, hugepages }`, and sandbox templates inherit it.
  - Hugepage flavors book `hugepages1Gi`/`hugepages2Mi` rather than `memoryGiB` (quota still counts `memoryGiB`). `vps.hosts` leaves hugepage pools out of `memoryGiB`.
  - After placement, `chooseHostPlacement` picks the GPUs' NUMA node, or the least-loaded one that holds the memory. For pinned flavors it picks CPUs no other pinned guest has: isolated CPUs first, never the host's reserved ones. It stores the result in `instances.host_placement`, which becomes `InstanceSpec.placement`.
  - A host that can't honour it runs the guest floating, with `PlacementDegraded { reason }`.
  - Guests of pools that overcommit memory get a balloon, except hugepage and GPU guests.
- **Capability gates.** A placement needs the bcd capability label for what the host must enforce:
  - `bc.dev/cap.instance.ssh-host-only` for sandboxes;
  - `bc.dev/cap.instance.placement` for placed flavors;
  - `bc.dev/cap.instance.network-policy` for private/none networks;
  - `bc.dev/cap.instance.volumes` for volumes.

  An older bcd would silently drop the field.
- **Admission hooks.** `instances.create` passes its decision to `CapacityPort.reserve`, so scheduler
  plugins' `admit` hooks run once; the reconciler's scheduling retries do not pass it.

### Provider pools (`class: 'provider'`, `agent: 'none'`)

There is no `nodes` row. The reconciler drives the account's `ProviderImpl`:

- `create`, with `idempotencyKey` = the instance id, so a retry never makes a second machine;
- polling `get`, then `power`, then `delete`;
- network calls always run outside database transactions, between a planning transaction and a
  version-guarded apply.

Provider errors become a `ProviderError` condition and are retried. A machine that vanishes marks
the instance `lost`. User data carries only the tenant's keys or the tenant's own cloud-init. No
join token ever goes into tenant-readable user data.

## Sandboxes (§3.7, v0.5)

A sandbox is a hosted instance with a template, a lifetime and a fast start. It has no placement or
tenancy path of its own. Admission, placement, quota, IPAM, user-data sealing, metering and deletion
all go through the instance it drives (`instances.sandbox_id`). Instance item methods (`start`,
`stop`, `resize`, `delete`) refuse that instance with `INVALID_STATE`, while `get` and `list` still
show it.

- **Templates** (`sandboxTemplates.*`, per tenant) hold:
  - `poolId`, `flavor` and `imageId`, checked against a hosted pool once. `runtime`, when given,
    must be the pool's runtime;
  - `userData`, and `env` (`{ NAME: 'secret://<tenant>/<id>' }`);
  - `network`: `egress`, `private` or `none`;
  - `defaultTtlSeconds` and `maxTtlSeconds` (default 1 h and 24 h);
  - `warm: { min, max }`.

  Pool and runtime are fixed once a template exists. Changes to flavor, image, user data, env or
  network bump the template's `instance_version`.

- **`sandboxes.create({ tenantId, templateId, ttlSeconds?, fromSnapshot?, idempotencyKey, wait? })`**
  takes a decision on `compute-sandbox/{draftId}`, with attributes `templateId`, `vcpu`,
  `memoryGiB`, `gpus`, `ttlSeconds`, `warm` and `fromSnapshot`. The budget check runs outside any
  transaction. After an allow it either:
  - claims the template's oldest settled warm instance of the current `instance_version`
    (`FOR UPDATE SKIP LOCKED`). The instance changes owner and resumes, with no new placement;
  - or creates and schedules one with the decision's admission context.

  The TTL starts at admission. `wait` holds the answer until the sandbox leaves `starting`.

- **Lifetime.** `extend({ until | by })` is decided with the new lifetime as the pending
  `ttlSeconds`, and is bounded by `maxTtlSeconds`. Like `create`, it runs capacity's budget check
  where the pool asks for one (`budgetCheck: 'meter'`, or an offer's `stop-new`/`drain`): a spent
  budget is `SPEND_LIMIT_REACHED` and clears the pending lifetime, as does a handler that throws after
  the allow (`admission.abandoned`). One extend at a time is decided per sandbox
  (`sandboxes.extending_request`): the projection holds one pending value, so a concurrent extend is
  `CONFLICT` (`extend-in-flight`) instead of replacing the lifetime being decided, and a stalled one
  is taken over after 60 s. `delete` and expiry are both an ordinary instance delete.

  Events: `sandbox.created`, `ready` (stamped when the instance first runs), `extended`, `expiring`,
  `expired`, `deleted`. `expiring` is published once, 5 minutes (or a quarter of the lifetime, if
  shorter, but at least two passes: 30 s) before `expiresAt`, so an agent can extend in time; an
  extend re-arms it.
- **Warm pools.** The `vps.sandboxes` reconciler runs every 15 s. It keeps `warm.min` instances per
  template:
  - they are `paused` when `RuntimeTraits.pause` is set, otherwise `stopped`;
  - it creates at most 4 per template per pass, each in its own transaction, best effort;
  - it drains instances beyond `warm.max`, of stale versions, and of deleted templates.

  Warm instances count against the tenant's quota and are metered as `vps.sandbox.warm` (warm
  vCPU-hours, tenant-billed) until claimed (`instances.claimed_at`). From the claim on they bill as
  the owner's ordinary usage. Where the pool checks budgets (`budgetCheck: 'meter'`, or an offer's
  `stop-new`/`drain`), a spent budget stops refills, and a `drain` offer also empties the pool. The
  check is `IamPort.billingCheck({ tenantId })`, asked at most once a minute per tenant and only
  when a refill or a drain depends on it. A warm instance records the `secret_refs.version` of every
  secret its guest was given. When one is rotated (or deleted), claims skip and retire it, and the
  pass replaces it.

- **Snapshots.** `sandboxes.snapshot({ includeMemory = true, keep = false })` needs
  `vps({ snapshots: SnapshotStore })` (`presign`, optional `delete`). It sends the host
  `instance.snapshot` (registered through `commandKinds`), keyed `vps.sandboxes:<snapshotId>:snapshot`.
  - A runtime without `RuntimeTraits.snapshot` (containerd, and bcx runtimes that don't declare it)
    is refused up front with `UNSUPPORTED`, before any command reaches the host.
  - The snapshot is `pending` until the command settles, then `ready` or `failed`
    (`sandbox.snapshot.ready` and `.failed`).
  - Snapshots live in vps's `sandbox_snapshots` table as their own IAM resource
    (`compute-sandbox-snapshot`), owned by the sandbox's owner whoever took them. They cannot be
    promoted.
  - `sandboxSnapshots.list/get/delete` manage them, including kept ones whose sandbox is gone.
  - Snapshots are deleted with their sandbox unless kept, and all of them go at tenant teardown.
  - Objects are deleted by the reconciler, outside request transactions, once no live restore still
    needs them. A pending upload's object
    waits until its command settles.
  - `create({ fromSnapshot })` restores the caller's own ready snapshot, taken on the same runtime,
    under the snapshot's own template (its network and env decide the guest's isolation). Another
    identity's or tenant's snapshot is `NOT_FOUND`. So is, for an agent, a snapshot of a sandbox it
    did not create: its person's other sandboxes' memory is not its to boot.
  - A memory snapshot places only on nodes labelled with the same `cpu.model`. Its guest resumes
    without cloud-init, so it keeps the source instance's exec principal
    (`restore_from.principalInstanceId`), and `sandboxes.exec` signs for it.
- **Exec without an in-guest agent.** `vps({ sandboxExec: { caPublicKey, account = 'sandbox' } })`
  makes every sandbox instance's user data a multipart whose vps cloud-config part:
  - creates the account;
  - trusts the tunnels module's `sandboxSsh` CA for `<account>@<instanceId>` only.

  `sandboxes.exec` is contributed by the tunnels module. It returns an `ssh` tunnel ticket plus a
  certificate that lives at most 15 minutes. Template `env` values are resolved for the tenant into
  `/etc/sandbox/env` (0600) inside user data that the broker seals. Without a broker, env is
  `INVALID_CONFIG`.

  With `sandboxExec.certifyHostKey`, which the host wires to the sandbox CA's
  `issueHostCertificate`, every guest also gets a P-256 host key certified for its instance id:
  - sshd presents it through `HostKey` and `HostCertificate`;
  - `sandboxes.exec` answers `hostPrincipal` and `hostCertified`, so clients pin guests with
    `@cert-authority` and `StrictHostKeyChecking=yes`;
  - a memory restore keeps its source guest's key and principal;
  - `hostCertified` is reported only while the certificate is still valid (30 days);
    `hostCertificate` says `valid`, `expired` or `none`.

  Nothing renews a host certificate, so a sandbox never outlives its guest's:
  - a claim takes only warm instances whose certificate covers the new TTL;
  - the reconciler recycles warm instances whose certificate no longer covers the template's default
    TTL (at most 15 days);
  - a fresh sandbox's expiry is capped at its certificate, a minute short at 30 days;
  - a memory restore or an extend past the certificate is refused, naming how long is left.

- **Network.** A template's `network` becomes the instance's `InstanceSpec.networkPolicy`. bcd
  enforces it on the instance's taps with nftables and fails closed without NIC addresses, so
  `private` and `none` need the pool's IP range. They place only on hosts labelled
  `bc.dev/cap.instance.network-policy` (the bcd capability), never on an older bcd that would drop the
  policy. A warm instance whose host loses that label (a downgraded bcd) is never claimed and is
  replaced. `private` means the pool's whole IPAM subnet, so on a pool offered to several tenants it
  includes theirs.
- **Secrets.** Secrets are write-only, but a sandbox reads whatever its template names. A template's
  env and `secret://` user data must therefore be secrets the tenant wrote with `secrets.put` (a
  `secret_refs` row), so platform-minted ones are refused, and so are fleet-scoped ones
  (`secret_refs.scope`). Writing such a template also decides `compute:secrets:manage` on the tenant,
  outside any transaction. In the root tenant, where rows from before the scope column read
  `tenant`, it also decides it on `fleet/global`.

  Sandbox user data is rendered and then sealed through the broker before the instance row is
  written. Without a broker, env and a `secret://` user data that vps would have to render are
  `INVALID_CONFIG`.

- **IAM reactions (§12.8).** The host calls these from the iam bridge's inbox handlers, in the
  inbox transaction, next to capacity's reservation reactions. Both are level-triggered, and
  `sandboxIamReactions` is `{ agent, identity, budget }` for the host's `iamReactions`. `budget` (`suspendBudgetInstances`)
  is an accelerator for the `vps.suspension` reconciler, which stops every suspended offer's running instances each
  minute whether or not the host wired it. Stopping: it sets the tenant's instances in those pools to `stopped` with
  the `BudgetSuspended` condition when a budget with `onBudgetExceeded: 'suspend'` is spent; `instances.start` is
  refused (`SPEND_LIMIT_REACHED`) while the offer is suspended.
  - `withdrawAgentSandboxes(tx, context, { tenantId, agentId | delegationId | allAgents, reason })`
    handles an agent suspended or a delegation revoked. It deletes the open sandboxes they created,
    after `sandbox.withdrawn { reason }`. A sandbox is the agent's own workspace, so unlike a started
    reservation it does not run on. Kept snapshots stay.
  - `reassignSandboxes(tx, context, { tenantId, identityId, successorId?, reason })` handles an owner
    who is gone. With a successor, it moves the owner's open sandboxes and their instances, their
    snapshots, and the templates they wrote (with their warm instances) to the successor, authz rows
    included (`sandbox.reassigned`), and clears their agent attribution, so the departed owner's
    agent being suspended later withdraws nothing. Without one, it deletes the owner's open sandboxes; their
    templates and kept snapshots stay for the tenant's administrators.

## Tenant teardown (§12.8)

`tenantDeleted` removes the tenant's vps state:

- deletes its sandbox templates;
- marks its sandboxes deleting and deletes their snapshots;
- drops drafts;
- sets every live instance to `desiredState: 'deleted'`, through the ordinary lifecycle.

It answers `SYNC_AGAIN` until all of them are `deleted`. Hosted instances hold inline allocations,
which capacity's teardown never reaches.

## Flavors and provider accounts

- **Flavors** are per pool. The pool's owner manages them, and offered tenants can list them.
  - A provider pool's flavor names its provider `offerId`.
  - Deleting a flavor still in use archives it instead.
- **Provider accounts** are rows validated by their provider's manifest.
  - Credentials must be `SecretRef`s (`secret://`, `vault://` or `env://`), never raw values.
  - Clients are built on demand and cached per account version.
  - `offers` lists the provider's offers.
  - An account that a pool or a live instance uses cannot be deleted.

## Providers

`defineProvider({ id, version, provides, config, create })` declares an external capacity
provider. Its shapes are checked up front (`INVALID_CONFIG`), and the definition is returned
frozen, with `extension: 'provider'`.

## Platform-owned provider machines (§3.6)

`providerAccounts.bootstrap({ tenantId, accountId, poolId, machineId | offerId, idempotencyKey })`
turns a provider machine (a Hetzner Robot server) into a node of a vps-host or metal-host pool that
runs bcd. It needs `vps({ bootstrap: { bcdUrl, sha256, controlPlaneUrl, pins } })`, the host PKI,
and a provider with `identify` and `bootstrap`. `controlPlaneUrl` is what the installed OS passes to
`bcd join --server`: it must serve `/.well-known/better-compute` with the gateway. `pins`
(`{ servingCa, joinSigning, joinEncryption }`, `sha256/<base64>` SPKI pins from the PKI bundle) go
on the same command line, and bcd refuses a well-known document that disagrees with them.
The `vps.bootstraps` reconciler drives it:

1. **claiming**: `ProviderImpl.create`, keyed by the bootstrap id (with `offerId`);
2. **identifying**: `ProviderImpl.identify` reads the SMBIOS UUID (Robot: in rescue);
3. **installing**: a single-use `provisioned` join token bound to that UUID (`expect.productUuid`,
   TTL 2 h, at most 6 h) goes only to `ProviderImpl.bootstrap` (rescue/installimage), never to user
   data. Its secret is never stored; a retry revokes it and mints another;
4. **joining**: a node of the pool reporting that UUID in inventory collected after the install;
5. **joined** or **failed** (provider errors retry with backoff up to `maxAttempts`; `JOIN_TIMEOUT`
   after an hour revokes the token).

A retry of the call under the same key returns the current status, never the token. Events:
`provider.bootstrap.{started,installed,joined,failed}`.
