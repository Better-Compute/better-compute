# @better-compute/vps

VPS for better-compute (PLAN.md §3.6). The package holds:

- `vps()`, the module behind the `instances`, `flavors` and `providerAccounts` API groups;
- `defineProvider`;
- the `runtime` driver kind;
- pool IPAM;
- the seams the gateway and node specs use.

It depends on `@better-compute/core`, `protocol`, `provision` and `capacity`. The application
injects it, and the server never imports it.

**Status: v0.3 control plane.** Hosted instances, provider instances, flavors, provider accounts
and IPAM work, and so do the daemon report and node-spec seams. The Hetzner provider ships
separately.

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
- **Node spec.** `nodeSpec` gives the host `NodeSpec.instances`: image, flavor, cloud-init with the
  tenant's keys, GPU atoms, and `desiredState: 'deleted'` while the instance is deleting.
- **Reports.** The gateway calls `reportInstances(tx, work, nodeId, reports, { complete })`. Only
  instances placed on that node are touched. A complete list marks missing instances `absent`.
  Instances the runtime holds that no row places there come back as `orphans`, which are leaks.
- **The `vps.instances` reconciler** turns reports into transitions:
  provisioning → starting → running ⇄ stopped, `error` on a runtime error, and deleted once the
  runtime drops the instance. Deletion releases the booking, the IP and the quota.
- **Lost hosts.** An instance on a `lost` node becomes `lost`. It recovers if the node comes back
  and reports it. With `policy.recreateOnHostLoss` it is re-placed on another node.

### Provider pools (`class: 'provider'`, `agent: 'none'`)

There is no `nodes` row. The reconciler drives the account's `ProviderImpl`:

- `create`, with `idempotencyKey` = the instance id, so a retry never makes a second machine;
- polling `get`, then `power`, then `delete`;
- network calls always run outside database transactions, between a planning transaction and a
  version-guarded apply.

Provider errors become a `ProviderError` condition and are retried. A machine that vanishes marks
the instance `lost`. User data carries only the tenant's keys or the tenant's own cloud-init. No
join token ever goes into tenant-readable user data.

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
