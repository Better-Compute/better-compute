# @better-compute/provider-digitalocean

A DigitalOcean provider for better-compute: Droplets as VPS instances and offers (GPU Droplets included), with attach, tenant networks (with NAT gateways, peerings and, as a preview, routes), Block Storage volumes and snapshots, reserved IPs (BYOIP as a preview), load balancers, DNS zones and records, certificates, managed Kubernetes on DOKS and managed services, plus storage: a Spaces `BlobStore`, Spaces buckets and keys, CDN endpoints and Container Registry as resource kinds, and a DOCR image source. It talks to the DigitalOcean API v2 over plain `fetch` and has no npm dependencies beyond `@better-compute/core` and `@better-compute/vps`.

It is not part of the `better-compute` umbrella: install it next to `better-compute`.

```sh
npm install @better-compute/provider-digitalocean
```

## Configuration

An account is data, validated by the provider's manifest:

| Field               | Meaning                                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `token`             | A secret reference to a personal access token with the scopes below. An account holds exactly one of `token` and `refreshToken`.              |
| `refreshToken`      | A secret reference to an OAuth refresh token ("Connect a DigitalOcean account"); see [Operations](#operations).                               |
| `regions`           | At least one region slug. Offers and discovery are limited to these, and so is every create, claim and subnet.                                                                       |
| `vpc`               | A VPC name or uuid that `create` uses when it gets no tenant network (default: the region's default VPC).                                                                            |
| `sshKeyFingerprint` | The MD5 fingerprint of an account SSH key that is added to every Droplet (a fingerprint, not a secret; see below).                                                                   |
| `monitoring`        | Install DigitalOcean's metrics agent on new Droplets (default `true`).                                                                                                               |
| `ipv6`              | Give new Droplets an IPv6 address (default `false`).                                                                                                                                 |
| `allowSpot`         | Offer and create Spot GPU capacity where DigitalOcean reports a Spot price (default `false`; see [Spot](#spot)).                                                                     |
| `discoverTag`       | A tag: discovery yields only Droplets that carry it. Lower-case `[a-z0-9:_-]`, at most 255 characters (else `INVALID_CONFIG`, `discoverTag`).                                        |
| `previews`          | Default `false`. `true` offers what DigitalOcean still marks as previews: BYOIP addresses, VPC routes, and the Managed Agents kinds and Signals (see [AI platform](#ai-platform)). |
| `spacesAccessKey`   | A secret reference to a Spaces access key id. With `spacesSecretKey`, it is the S3 key pair that manages tenant buckets (see [Storage](#storage-spaces-cdn-and-container-registry)). |
| `spacesSecretKey`   | A secret reference to the Spaces secret key that goes with `spacesAccessKey`. Set both or neither.                                                                                   |
| `networkModel`      | Default `vpc-per-subnet` (a VPC per subnet). `vpc-subnets` is reserved for DO's VPC Subnets preview and refused (`INVALID_CONFIG`) for now.   |
| `costs`             | Read the invoices into provider costs (`vps.costs`), default `false`; needs `billing:read`. See [Operations](#operations).                    |
| `projectPerTenant`  | Assign each new Droplet to the project `bc-<tenant>`, default `false`; needs `project:read,create,update`.                                    |

## Usage

```ts
import { vps } from 'better-compute/vps';
import { digitalocean } from '@better-compute/provider-digitalocean';

vps({
  providers: [digitalocean],
  discovery: { every: '5m' }, // the vps.discovery worker (attach)
});

// An account is data. The token is a SecretRef, never a value.
await client.providerAccounts.create({
  tenantId,
  provider: 'digitalocean',
  name: 'main',
  // A tenant's account names its own secret: secret://<tenantId>/… (see Authentication).
  config: {
    token: `secret://${tenantId}/do-token`,
    regions: ['nyc3'],
    sshKeyFingerprint: '3b:16:e4:bf:8b:00:8b:b8:59:8c:a9:d9:f4:61:21:ec',
  },
});
```

`digitaloceanProvider({ fetch, endpoint, deployment, inCallWaitMs, budget })` swaps the transport, the API endpoint (default `https://api.digitalocean.com/v2`; never taken from tenant config), the deployment name hashed into the deployment tag (default `default`), `inCallWaitMs` (accepted and checked, default 0, at most 20 000, but with no effect yet: every call starts its action and returns without waiting) and the request budget (see [Rate budget](#rate-budget)). `probeAccount(config, context, options?)` is a read-only check of what a token may do (the optional third argument is the same `DoProviderOptions`, for `fetch`, `endpoint` and `budget`): it reads `GET /account` and then one page of each list the provider reads (Droplets, regions, sizes, VPCs, firewalls, account SSH keys, tags, volumes, reserved IPs, and NFS shares in the account's first region), reports the read scopes the token lacks by family (`missing`), and lists the write scopes it cannot check without writing (`unverified`). NFS is optional and its own family, `nfs`: a 403 is `denied` (with `nfs:read` in `missing`), an answer that says the region has no NFS (400, 404, 422) or an account with no region is `unavailable`, and neither fails the probe or touches `storage` (block storage alone).

## Token scopes

Create the token as a custom-scope token with at least:

| Scopes                                                                                                                | For                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `account:read`, `regions:read`, `sizes:read`, `image:read`, `actions:read`                                            | The account check, the offer catalog and the state of a Droplet's create action.                                                      |
| `droplet:read,create,update,delete`                                                                                   | Creating, reading, powering, rebuilding and deleting Droplets. Autoscale pool membership is read for discovery, with `droplet:read`.  |
| `ssh_key:read,create`                                                                                                 | Finding the account key for a fingerprint and registering the keys an instance brings. The provider never deletes a key.              |
| `tag:read,create,delete`                                                                                              | Making tags, putting them on one Droplet at a time and taking them off again.                                                         |
| `vpc:read,create,update,delete`                                                                                       | The VPC behind each tenant subnet.                                                                                                    |
| `block_storage:read,create,update,delete`, `block_storage_action:create`, `block_storage_snapshot:read,create,delete` | Volumes, their attach/detach/resize actions and their snapshots.                                                                      |
| `nfs:read,create,update,delete` (name unverified)                                                                     | Network File Storage shares, their actions (resize, snapshot, VPC attach and detach) and their snapshots.                             |
| `reserved_ip:read,create,update,delete`                                                                               | Reserving, assigning, unassigning and releasing reserved IPv4 and IPv6 addresses.                                                     |
| `firewall:read,create,update,delete`                                                                                  | The base firewall and the firewall behind each tenant rule.                                                                           |
| `spaces_key:read,create,update,delete`, `cdn:read,create,update,delete`, `registry:read,create,update,delete`         | The storage kinds and DOCR credentials, only if they are used. These scope names are **unverified** until the live suite checks them. |
| `load_balancer:read,create,update,delete`                                                                             | Regional and global load balancers.                                                                                                   |
| `domain:read,create,update,delete`                                                                                    | DNS zones (DO domains), their records and the ownership marker.                                                                       |
| `certificate:read,create,delete`                                                                                      | Let's Encrypt and custom certificates for load balancers.                                                                             |
| `vpc:read,create,update,delete` (NAT, peering, routes)                                                                | NAT gateways, VPC peerings and (preview) routes; DO may name separate NAT gateway scopes (unverified).                                |
| `byoip_prefix:read` (preview, unverified name)                                                                        | Reading BYOIP prefixes; the provider never changes one.                                                                               |

Managed Kubernetes (below) also needs `kubernetes:read,create,update,delete` and `kubernetes:access_cluster` (the short-lived cluster credential the mint uses).

The operations surfaces need more, only when they are used: `billing:read` (costs and the billing summary), `project:read,create,update` (`projectPerTenant`), `monitoring:read` (Droplet metrics) and `security:read` (security findings).

A token without a scope fails the call that needs it with `ACCESS_DENIED` (`details.reason` `scope`); `probeAccount` names the missing read scopes up front, and `probeAccount(config, context, options, { operations: true })` the operations ones too. It never writes (a trial create could bill), so a token with the read scopes but without `block_storage:create` or `reserved_ip:create` passes it and fails the first create; its `unverified` list names those scopes for the operator to check. Its report names the account (uuid, status, Droplet limit) and, read-only, the team the token belongs to (`team`: uuid and name, never its members), which `providerAccounts.check` answers in `details.account` and the console shows beside the check.

## Tag scheme

DigitalOcean has no labels, only flat tags, so better-compute writes a label as the tag `<key>:<value>`, in lower case. Tags match `[a-z0-9:_-]`, at most 255 characters. A value that is not `[a-z0-9_-]` or is longer than 200 characters becomes `x` plus 26 base32 characters of its SHA-256, so the tag stays decodable and `Ann@x.com` stays apart from `ann@x.com`. The label keys `k8s` and `k8s-worker` are DOKS's own and are `INVALID_INPUT` (`label`): they would make the Droplet read as a cluster worker.

| Tag                                        | Written by                                                             | Means                                                                                                                                                                                        |
| ------------------------------------------ | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `better-compute-managed:true`              | `create`, and `claim` with `managed` (an `onDelete: 'delete'`)         | better-compute may delete and rebuild the Droplet.                                                                                                                                           |
| `better-compute-instance:<id>`             | `create`, and `claim` when an instance is attached                     | The instance this Droplet belongs to. `power` and `setTags` need it.                                                                                                                         |
| `better-compute-deployment:<12 hex>`       | `create`, and `claim`                                                  | The deployment (the `deployment` option, hashed) that owns the Droplet. Every delete, rebuild, power and `setTags` needs it; `release` takes it off once no instance tag is left.            |
| `better-compute-key:<24 hex>`              | `create`                                                               | The hashed idempotency key of the create that made the Droplet (see Machines).                                                                                                               |
| `better-compute-tenant`, `-pool`, `-owner` | you, on Droplets to auto-attach (`vps({ discovery: { autoAttach } })`) | The tenant, pool and owner an auto-attach uses. Other labels a create is given also become tags; a label key with a colon is `INVALID_INPUT` (`label`), since it could forge a reserved tag. |
| `bc-net-<16 hex>`                          | `create` on a tenant network, and `setTags`                            | Membership of a tenant network: the tag its base firewall targets.                                                                                                                           |
| `bc-<16 hex>`                              | `create` on a tenant network, and `setTags`                            | The per-instance tags tenant firewall rules target. `setTags` replaces only `bc-<16 hex>` and `bc-net-<16 hex>` tags and keeps every other tag, a hand-made `bc-web` included.               |

- **`delete`, `reinstall` and the duplicate reaper** act only on a Droplet that carries `better-compute-managed:true` **and** this deployment's tag. Any other is `INVALID_STATE` (`details.reason` `notManaged`).
- **`power` and `setTags`** act on a Droplet that carries this deployment's tag and a `better-compute-instance:*` tag (with `setTags(…, instanceId)`, the tag must name that instance). A claimed Droplet is powerable without being deletable.
- **The bulk endpoints are never called.** DigitalOcean can delete or act on every Droplet with a tag in one request (`DELETE /droplets?tag_name=`, `POST /droplets/actions?tag_name=`). The provider never calls them: every delete, action and tag write names one Droplet by id.
- **Tags are written one Droplet at a time**, tag object first (`POST /tags`, a 409 for an existing one is fine), then `POST /tags/{name}/resources`.

## Machines

A Droplet's id is its decimal Droplet id. An offer's id is `region/size` (`nyc3/s-1vcpu-1gb`); a Droplet is named `bc-` plus the lower-cased instance id, `[a-z0-9-]`, at most 63 characters.

- **Offers** come from `/sizes` and `/regions`, one per size and configured region, with the hourly price in USD and `available` from both catalogs. The catalogs are kept for ten minutes per client. A `gpuModel`/`minGpus` query keeps GPU sizes; their `gpu_info.model` maps to the pool strings (`nvidia_h100` is `H100`, `nvidia_rtx_6000_ada` is `RTX-6000-ADA`). A `metal` query returns nothing.
- **GPU Droplets are listed separately.** DigitalOcean's default `GET /droplets` omits them, and `type=gpus` lists only them and can't be combined with `tag_name`. The provider handles that: `list` and `discover` page both lists and yield each Droplet once, and the idempotency lookup of a GPU size scans the GPU list and filters by tag itself.
- **Spot offers** are `region/size@spot`, only with `allowSpot` (see [Spot](#spot)); without it a create for one is `UNSUPPORTED` (`spot`).
- **`create` is idempotent through a tag.** DigitalOcean has no idempotency key, so the create carries `better-compute-key:<hash of the key>`, looks for it before it posts, and looks again after. Two creates that race on one key both post; each then sees both Droplets, keeps the oldest and deletes the others (only managed Droplets of this deployment, one by one), so every caller converges on one Droplet. An answer that never arrived (`UNAVAILABLE`) is followed by the same lookup.
- **It always sends an SSH key.** A Droplet created without a key may make DigitalOcean email a root password, which better-compute must never cause. So a create sends the instance's keys, each registered in the account as `bc-<fingerprint prefix>` if the account lacks it, and the account's `sshKeyFingerprint`. That is why `sshKeyFingerprint` exists: an instance with no key of its own still gets one. With neither, the create is `INVALID_CONFIG` (`details.reason` `noSshKey`); a fingerprint that is not in the account is `INVALID_CONFIG` too. Keys are shared by the whole account, so the provider never deletes one. (vps reads config fields that end in `key` as secrets, which a fingerprint is not, hence the name.)
- **Other create rules.** User data is at most 64 KiB. An image is a slug, a numeric id or a catalog image (see [Images](#images)); anything else is `INVALID_INPUT` (`image`) before a request. An offer in a region outside `regions` is `INVALID_INPUT`.
- **`get` of a Droplet that is still `new`** reads its create action: an action that ended `errored` throws `CAPACITY_UNAVAILABLE` (`createActionErrored`), which vps turns into `ProvisionFailed`. Nothing is kept between calls.
- **`power`:** `on` is `power_on`, `off` is `power_off`, `graceful-off` is `shutdown`, `graceful-restart` is `reboot`, `cycle` and `reset` are `power_cycle`; `nmi` is `UNSUPPORTED`. The action is started, not awaited: a later `get` shows it. `reinstall` is `rebuild` and, like a delete, needs a managed Droplet.
- **`list`** yields this deployment's managed Droplets (the deployment-tag list plus the GPU list).

## Images

An `ImageRef` is tried in this order:

1. **A DigitalOcean slug** (`ubuntu-24-04-x64`, the AI/ML image `gpu-h100x1-base`): passed through. A slug has a letter in it.
2. **A numeric image id** (a snapshot or custom image): passed through as a number.
3. **A catalog image** `name@version`: imported as a DigitalOcean custom image. This needs `digitaloceanProvider({ catalogImages })`, a host-side source whose `locate(ref, { tenantId, sha256, expiresInSeconds })` returns the image's digest, format and a short-lived HTTPS URL DigitalOcean can fetch (provision's catalog plus a BlobStore that presigns a GET). Without it a catalog image is `UNSUPPORTED` (`catalogImage`).

**Catalog refs are per tenant.** A `name@version` is unique only within a tenant's catalog, and an image may be private. vps resolves the ref for the instance's tenant when the instance is created (`vps({ images })`) and refuses one the tenant can't see (`NOT_FOUND`), so a provider pool never gets an unresolved catalog ref. The create then carries the resolution (`catalogImage: { tenantId, sha256 }`), which the provider hands to the source: the source must look the image up in that tenant's catalog, and a location whose digest is not the resolved one is refused (`INVALID_CONFIG`, `catalogImageDigest`). A catalog ref without a resolution is `INVALID_INPUT` (`catalogImageUnresolved`) before the source is asked.

How an import works:

- **The image is its own record.** An import carries `better-compute-managed:true`, the deployment tag and `better-compute-image:<24 hex of the digest>`, is named `bc-img-<ref>-<12 hex>`, and is found by that tag. Like a Droplet create, two racing imports converge on the oldest; the others are deleted one by one. Failed imports are deleted first, so an available duplicate survives a failed older one (the survivor is the oldest that has not failed, not the first available, so racing creates agree). An image with the tag but without the managed and deployment tags is never used or deleted.
- **Nothing blocks.** While the import (or a copy into another region, a `transfer` image action) runs, `create` and `reinstall` throw `UNAVAILABLE` (`imageImporting` / `imageTransferring`, `retryAfterMs` 30 s), and vps calls the create again. A retry never starts a second import or a second transfer to the same region; after a transfer completes, the image is re-read (the list can lag behind the action) rather than transferred again.
- **A failed import** (DO reports it `deleted` with an `error_message`) is deleted and fails the create `INVALID_STATE` (`imageImportFailed`), and so is one still not available a day after it started (its URL expired long ago); the next create imports afresh. A copy into a region that errors three times, is still running a day after it started, or completed a day ago without the image listing the region fails the create `INVALID_STATE` (`imageTransferFailed`) instead of retrying forever.
- **What DigitalOcean can't import is refused before any request:** `iso` images, `zstd` compression (`UNSUPPORTED`, `imageFormat`), an unknown ref, a digest that is not SHA-256 and a URL that is not HTTPS (`INVALID_CONFIG`).
- **The presigned URL is a credential.** It goes into the import body only; it never reaches a log line or an error: a refused import is rethrown with the provider's own message (code and details kept), whatever DigitalOcean's message quotes.

**GPU images.** An AI/ML image (`gpu-…`) on a size without GPUs, or one built for the other vendor (an NVIDIA image on an MI300X size), is `INVALID_INPUT` (`gpuImage`) before any request, in `create` and `reinstall`. Plain OS images boot GPU sizes: DigitalOcean's docs say GPU Droplets work with them once drivers are installed.

Imports need `image:create` (and `image:update` for transfers, `image:delete` for reaping) on top of `image:read`.

## Spot

With `allowSpot`, a size whose catalog entry reports a Spot price gets a second offer `region/size@spot` at that price (DigitalOcean changes it daily). A create for it sends the Spot request member and tags the Droplet `better-compute-capacity:spot`, so it reads back with its `@spot` offer id; a tenant label can't forge that tag. A Spot create loads the size catalog when the client holds none, and one for a size without a Spot price is `INVALID_INPUT` (`spot`) before any create is sent: DigitalOcean is never left to decide, since a Spot member it ignored would make an on-demand GPU Droplet that better-compute reads back, and treats, as Spot.

**Spot needs `previews` too, for now.** Spot is a DigitalOcean preview and the wire shape below is a guess, so while `spotShape.verified` is false an account needs `previews: true` as well as `allowSpot`: without it there are no `@spot` offers and a Spot create is `UNSUPPORTED` (`spotPreview`).

**The wire shape is not verified.** DigitalOcean's public OpenAPI has no Spot member on sizes or on the Droplet create (checked 2026-11-05). The provider's assumptions are data in one place, `spotShape` in `compute/spot.ts` (`verified: false`): the size member `spot_price_hourly` and the create member `capacity_type: 'spot'`. A catalog without the size member yields no Spot offer at all, so a wrong guess offers nothing rather than something else. The live suite settles it.

**Preemption.** DigitalOcean warns of a reclaim, at least two hours ahead, by email only. vps treats a Spot instance whose machine vanishes as preempted: it is `lost` with a `Preempted` condition and `instance.preempted`, and a pool whose policy sets `replacePreempted: true` recreates it on a new machine.

## Bare Metal GPUs

DigitalOcean's API has no Bare Metal resource, so `digitaloceanMetalProvider({ machines, ssh, deployment })` (provider id `digitalocean-metal`, `provides: ['metal']`) works over SSH with machines the operator lists in code, never in tenant config. Its accounts belong to the platform tenant only (`INVALID_CONFIG`, `platformOnly` otherwise); the account config is `sshKey` (a secret reference to the private key), `sshUser` (default `root`; any other login runs every command through passwordless `sudo -n`, which fails rather than prompts) and `regions`.

- **Claims are compare-and-set.** A claim is the file `/var/lib/better-compute/claim`, created with O_EXCL, naming the deployment and the idempotency key: a retried create finds its own claim, any other gets `CONFLICT`. Offers are the unclaimed machines (one that can't be reached is offered unavailable); `list` sees this deployment's claims. `get`, `delete`, `power`, `identify` and `bootstrap` act only on the caller's own claim (the one its idempotency key wrote): another instance's claim of the same deployment reads as absent to `get` and `delete`, and is refused (`INVALID_STATE`, `notManaged`) by the others. So a machine is bootstrapped under the key that claimed it (`providerAccounts.bootstrap` with the `offerId`).
- **`delete`** stops bcd, removes its binary, units, `/etc/bcd` and `/var/lib/bcd` (its node identity and state), then the caller's claim, last; the machine and its OS stay (DigitalOcean has no API to reinstall one, so anything outside bcd's paths is not wiped). A retried delete that finds another instance's claim of this deployment is done and leaves it, and its bcd, alone; a claim outside this deployment is `INVALID_STATE` (`notManaged`).
- **`bootstrap`** writes the single-use `provisioned` join token over SSH stdin into a root-only file, installs bcd pinned by sha256, and starts `bcd-join.service` and `bcd.service`. `identify` reads the SMBIOS UUID.
- **Power** is a reboot over SSH only (`graceful-restart`), scheduled two seconds out with `systemd-run` so its exit status returns before the session drops. A non-zero exit is `PROVIDER_ERROR` (`reboot`); a connection lost during the call is `PROVIDER_ERROR` (`rebootUnconfirmed`), not a retryable `UNAVAILABLE`, since the machine may already be rebooting. With no API or BMC, every other action is `UNSUPPORTED` (`noBmc`).
- **Every machine pins its host key** (`hostKeySha256`, passed to the executor, which must refuse any other key): a listed machine without one is `INVALID_CONFIG` (`hostKey`) when the provider is defined, since bootstrap sends the join token over that connection. An SSH failure is `UNAVAILABLE` and carries neither the key nor the executor's message.

MicroVMs (preview) are not supported: vps sandboxes run on hosted pools through bcd, and a provider-backed sandbox backend is a follow-up (see `docs/research/digitalocean.md`).

## Droplet metadata in inventory

On a Droplet (DMI system vendor `DigitalOcean`), bcd reads the metadata service (`169.254.169.254/metadata/v1.json`) into the inventory system section's `cloud`: the Droplet id, region, tags and interfaces. It never keeps user data, vendor data, SSH keys or the auth key, and nothing uses the value as an identity: the service is unsigned, so Droplets join with tokens. The control plane reads it with `cloudInstanceOf` from `@better-compute/inventory`.

## Attach

`discover` yields every Droplet of the configured regions (optionally only those with `discoverTag`), GPU Droplets too, with shape, GPUs, labels, networks and creation time. A Droplet that belongs to a DigitalOcean autoscale pool carries the pool's id in the label `better-compute-autoscale-pool`: autoscale pool membership is read for discovery, and a `claim` of such a Droplet is `INVALID_STATE` (`autoscalePool`), since DigitalOcean scales it itself. DOKS worker nodes (a Droplet with `k8s-worker`, a `k8s:<cluster uuid>` tag or `better-compute-kubernetes:true`) are left out of `discover`; a `claim` of one is `INVALID_STATE` (`kubernetesNode`), it is never deleted or rebuilt, and `release` never takes the deployment tag off it (there it is its node pool's tag).

`claim` writes `better-compute-instance:<instance id>` and the deployment tag, reads the Droplet again, and gives its own tag back if another instance's tag appeared in between (tag-then-verify, since DigitalOcean has no compare-and-set on tags): `CONFLICT` (`claimedByAnother`). With `{ managed: true }`, and only once the claim has held, it also writes `better-compute-managed:true`. A managed claim of a Droplet that carries another deployment's tag is `INVALID_STATE` (`otherDeployment`), checked before any write and again before the managed tag is written: the managed tag is not scoped to a deployment, so it would hand deletion to both. `release` removes the managed tag first (kept while another instance tag is on the Droplet), its own instance tag second, and this deployment's tag last once no instance tag is left, so a failure in between leaves the Droplet still the instance's and a retry finishes the job. Release keeps no record of what its claim wrote: a managed tag that was already on the Droplet before the claim is removed too.

## Networks

DigitalOcean has no network object, so a tenant network is built from a VPC per subnet and Cloud Firewalls:

- **A subnet is a VPC** named by its provider-side name (vps hands the provider `bc-` and the lower-cased subnet id, not the tenant's display name), in the subnet's region, with the subnet's range and the description `bc:network=<network>` (the network's provider-side name). The range must be RFC 1918 with a prefix from /16 to /28 and not overlap another VPC of the account (`INVALID_INPUT`). A VPC that exists with another range, region or network is `INVALID_STATE` (`subnetDrift`). A VPC that still has members is `pending` on delete.
- **A network is its base firewall** `bc-base-<net16>`, where `net16` is 16 hex digits of the SHA-256 of the network's provider-side name. It targets the network's member tag `bc-net-<net16>`, has no inbound rules and allows all outbound traffic, which reproduces "deny ingress, allow egress". An `mtu` other than 1500 is `UNSUPPORTED`.
- **A firewall rule is a Cloud Firewall** named `<rule>.n<net16>.p<priority>`, so a rule, its network and its priority are found by name. Without explicit targets the rule targets the network's member tag; `targetTags` replace that.
- **No priorities.** DigitalOcean applies every firewall that matches a Droplet, and a deny always wins. A ruleset in which an allow has a lower priority number than an overlapping deny of the same network and direction can't be expressed. Only an allow is checked, against the denies DigitalOcean already holds: a deny always applies, and the outranking allow is refused with `UNSUPPORTED` (`details.reason` `firewallPriority`), in whichever order the two are reconciled. So the inversion fails closed. An allow applied before the deny arrived stays applied but is no longer updated; the deny wins for the traffic they share. Addresses on the wrong side of a rule (destinations on an ingress rule) are `UNSUPPORTED` too.
- **Firewalls are applied in the background.** `ensureNetwork` is `ready` once the base firewall exists (not once DigitalOcean has applied it; see [what is not yet verified](#tests-and-what-is-not-yet-verified)); a rule is `pending` until DigitalOcean reports it `succeeded`, and `error` (then applied again) if it `failed`. Firewall names are not unique at DigitalOcean, so after a race the next call keeps the oldest and deletes the others.
- **Names are managed by prefix.** The provider replaces and deletes only firewalls whose names have exactly this shape, and only VPCs whose description names a network; a hand-made `bc-r1.prod` or VPC is never touched.
- **A Droplet joins a network by tag.** `create` on a tenant network puts `bc-net-<net16>` and the tags its rules target on the Droplet from the first boot; `setTags` adds the new tags before it removes old ones and never removes a member tag unless the Droplet's VPC belongs to another network.
- **An attached Droplet outside the network's VPCs** that a rule targets loses egress: DigitalOcean denies what a firewall doesn't allow, and the rule's firewall allows only what the rule says.

## Volumes and snapshots

`impl.volumes` is the provider-neutral `ProviderVolumes` contract over DigitalOcean Block Storage. Every call is idempotent and non-blocking: it returns `pending`, `updating` or `deleting` while DigitalOcean works, and the reconciler calls again.

- **A volume is found by its name**, which DigitalOcean keeps unique per region. vps derives the name (a lower-case letter, then `[a-z0-9-]`, at most 64 characters), so a retried `ensureVolume` finds what its first attempt made, and a create that races another on the same name reads the winner. A volume is 1 to 16 384 whole GiB, formatted `ext4`, `xfs` or left raw; `snapshotId` restores a snapshot into it. `kind: 'shared'` is a Network File Storage share (below). A region outside `regions` is `INVALID_INPUT`.
- **Ours means tagged.** A volume the provider makes carries `better-compute-managed:true` and this deployment's tag, plus the spec's labels as tags (reserved keys skipped). Attach, detach, resize, snapshot and delete refuse any other volume with `INVALID_STATE` (`notManaged`); an `ensureVolume` whose name a volume without those tags holds is `CONFLICT` (`nameTaken`), and one formatted otherwise is `INVALID_STATE` (`filesystem`).
- **Attach** goes only to a Droplet in the volume's region (`INVALID_INPUT`, `region`, before any write) that carries this deployment's tag and an instance tag (with an `instanceId`, that instance's; else `INVALID_STATE`, `notInstance`). A Block Storage volume attaches to one Droplet at a time: one attached elsewhere is `CONFLICT` (`attachedElsewhere`), never moved; DigitalOcean's own 422 for it maps the same way, and a Droplet with seven volumes is `QUOTA_EXCEEDED` (`volumesPerDroplet`). The guest sees the volume as `/dev/disk/by-id/scsi-0DO_Volume_<name>` (`outputs.device`).
- **Actions run in the background.** Attach, detach and resize are volume actions: each call reads the volume and, before it starts one, the volume's action list, so a call that finds an action still running reports it and starts nothing. An action that ends `errored` is reported as `error` with a message, and the next call starts it again. A detach while an attach still runs is `deleting`, not `deleted`.
- **Resize only grows** (`INVALID_INPUT`, `shrink`). **Delete** refuses an attached volume (`INVALID_STATE`, `attached`); a volume attached between the read and the delete is DigitalOcean's 409, `CONFLICT`. Deleting a Droplet detaches its volumes; it does not delete them, except the ones its `delete` names (`ProviderDeleteOptions.volumes`, an instance's `deleteWithInstance` volumes): then it is one `DELETE /droplets/{id}/destroy_with_associated_resources/selective` naming only those that are ours and attached to that Droplet. A tenant's own volume attached by hand is never named and survives; with none of ours named it is a plain `DELETE /droplets/{id}`.
- **Snapshots** are found by name among the volume's snapshots and carry the same two tags. DigitalOcean keeps no snapshot name unique, so after two racing calls the next keeps the oldest of ours and deletes the others; a name a snapshot without our tags holds is `CONFLICT`. A snapshot outlives its volume. Outputs: `volume`, `region`, `sizeGiB` (the smallest volume it restores to) and `storedGiB` (what DigitalOcean bills for).

## NFS shares

`kind: 'shared'` provider volumes are DigitalOcean Network File Storage shares (`impl.volumes.shares`, P6). The share API's shapes come from DigitalOcean's API reference and are **unverified** (`tests/fixtures/digitalocean/nfs.json`); the provider reads only the fields it needs.

- **Ids and names.** Every share call names the share's region, so a share's id is `nfs:<region>:<uuid>` and a share snapshot's `nfssnap:<region>:<uuid>`. Shares carry no tags, so a share of ours is named `<vps name>-<12 hex>`, the hash the deployment tag carries: `ensureVolume` finds it by that name, and resize, attach, snapshot and delete refuse any other share (`INVALID_STATE`, `notManaged`). Share snapshots are named the same way. A vps name longer than the 51 characters a share name leaves for it (vps names a volume `bc-<id>`, 60 characters) keeps its first 38 and gains 12 hex of its own hash (`shareName`).
- **Reachability is the VPC.** NFS has no access control but VPC membership, so a share needs `spec.network` (`INVALID_INPUT`, `network`, without it) and is created in that network's VPC in the region, never in a default VPC. A share is 50 to 16 384 whole GiB (the minimum is unverified), grows only, takes no `filesystem` and no `snapshotId` (`UNSUPPORTED`, `sharedRestore`); labels are not written.
- **Attach** goes to an instance Droplet of this deployment in the share's region whose VPC is a better-compute network's (`INVALID_STATE`, `vpcNotManaged`, for a default or hand-made VPC) of the same network as the share (`otherNetwork`). The Droplet gets the tag `bc-nfs-<16 hex>` (`shareTag`), the record of who has the share, and the share gets the Droplet's VPC through an attach action when it lacks it. Many Droplets may have a share at once; `attachVolume` names the machine in `attachedTo`, `getVolume` names none.
- **Detach** untags the Droplet and takes its VPC off the share once no tagged Droplet is left in it; the share's last VPC stays. Detaching a Droplet that is gone (deleted with its tag, its VPC still on the share) takes off every VPC of a better-compute network that no tagged Droplet is in, one VPC action per call (`deleting` until the last), never the share's first VPC. **Delete** refuses a share that any Droplet carries the tag of (`INVALID_STATE`, `attached`), and then removes the share's `bc-nfs-*` tag (best effort).
- **Actions** (resize, snapshot, attach, detach) have no id and no list: a call reads the share and acts on what it sees, and DigitalOcean's refusal while another action runs (`pending event`) reports the call still busy. A snapshot the action has not made yet is `UNAVAILABLE` (`snapshotUnconfirmed`); the reconciler looks again.
- **Outputs:** `kind` (`shared`), `region`, `sizeGiB`, `filesystem` (`nfs`), `host`, `mountPath`, `device` (`<host>:<mountPath>`, the source the guest mounts with `mount -t nfs4`) and `vpcs`. The mount source is passed on only when it is plainly an address and an absolute path.

## Reserved IPs

`impl.addresses` is the `ProviderAddresses` contract over reserved IPv4 (`/v2/reserved_ips`) and IPv6 (`/v2/reserved_ipv6`) addresses. The address is its own id.

- **No tags, so the control plane is the record.** DigitalOcean gives a reserved IP no name and no tags. `ensureAddress` finds an address only by the `id` an earlier ensure returned (one that is gone is `NOT_FOUND`, `addressGone`, never replaced silently), and without an `id` it reserves a new one. A reserve whose answer never arrives is not retried: the error stands and the call is logged (`digitalocean.reserveUnconfirmed`), so at worst one address is left for the operator rather than two tenants sharing one.
- **BYOIP (preview).** With `source: 'byoip'` and a `prefix` (its CIDR or uuid), an IPv4 address is drawn from one of the account's own prefixes. It needs `previews: true` (else `UNSUPPORTED`, `preview`). The prefix is only read (`GET /v2/byoip_prefixes`) and must be the account's (`INVALID_INPUT`, `prefix`), active (`INVALID_STATE`, `prefixNotActive`) and in the spec's region, all before the reserve. The reserve request (`POST /v2/reserved_ips` with `byoip_prefix_uuid`) is unverified; an answer outside the prefix is `PROVIDER_ERROR` and never handed out. A drawn address is then a reserved IP like any other.
- **Assign** goes only to a Droplet of an instance of this deployment in the address's region (checked before any write), and an address assigned to another Droplet is `CONFLICT` (`assignedElsewhere`): DigitalOcean's assign would move it. **Unassign** never touches an address on a Droplet that is not this deployment's (`INVALID_STATE`, `notInstance`), and an assigned address is never deleted (`INVALID_STATE`, `assigned`). Deleting a Droplet unassigns its addresses.
- **Non-blocking.** Assign and unassign are actions. A v4 address is `locked` while one runs; v6 answers a second action with the 422 `has a pending event` (`CONFLICT`, `actionPending`), which a call reads as still running. Either way a call starts at most one action.

## Managed Kubernetes (DOKS)

The account's provider also implements core `ProviderKubernetes` (capability `kubernetes`) on DigitalOcean Kubernetes, for the `@better-compute/kubernetes` module and for pools on a Kubernetes substrate. better-compute never runs the control plane; DOKS does. Every `ensure*` and `delete*` call is non-blocking: it reads the resource, starts at most one change and answers `pending`, `updating` or `deleting` while DOKS works.

- **Ids.** A cluster's id is its DOKS uuid; a node pool's is `<cluster uuid>/<pool name>`. `ensureCluster` finds the cluster by its name in the spec's region (whether DOKS names are unique per account or per region is not verified, so neither is assumed).
- **Ownership.** The clusters and node pools it creates carry `better-compute-kubernetes:true` and the deployment tag. They never carry `better-compute-managed:true` or the auto-attach keys (`better-compute-tenant`, `-pool`, `-owner`): DOKS can put those tags on its worker Droplets, which must never look like vps instances. The worker Droplets do carry the deployment tag, so the Droplet code refuses any Droplet DOKS tags as a worker (`kubernetesNode`, see [Attach](#attach)). A cluster of that name that is not this deployment's is `CONFLICT` (`notOwned`) and is never changed. One of its own of that name only in another region is `INVALID_STATE` (`immutable` location) and is never deleted. Duplicates of its own in the region (two creates raced) keep the oldest; the others are deleted one by one, unless one runs nodes: a cluster with workloads is never reaped, the refusal is logged and the call is `CONFLICT` (`duplicate`) until an operator removes the extra one.
- **Clusters.** A create takes the newest version DOKS offers or the one the spec pins (a minor such as `1.33` takes its newest patch), the spec network's VPC in the region or the account's `vpc`, the initial node pools, a control-plane firewall from `authorizedNetworks`, and surge upgrades. DOKS has no release channels: `extended` turns auto-upgrade off, the other channels turn it on, and `versions()` lists no channels. Auto-upgrade, the firewall, the device plugins and the labels change in place; the region or the network differing is `INVALID_STATE`. Autopilot and `privateNodes` are `UNSUPPORTED` (private worker nodes need a VPC NAT gateway). Labels become tags `<key>:<value>`; the keys `k8s` and `k8s-worker` are DOKS's own and are `INVALID_INPUT`. A label change on an existing cluster changes its tags in place (in the same update as the firewall); a tag no label names is kept, since it may be someone else's, so a label taken out of the spec stays on the cluster.
- **GPUs (DO-D18).** DOKS's NVIDIA and AMD device plugins and AMD's metrics exporter are created off and turned off again if someone enables them: the bcd DaemonSet's own device plugin advertises the GPUs, so compute books them. A GPU pool is added only once the parent's NVIDIA and AMD device plugins are off: on a cluster of its own they are turned off first (the pool answers `pending`); on any other (adopt mode) the call is `INVALID_STATE` (`devicePluginOn`, `details.field` names the plugins to turn off) and nothing is changed.
- **Node pools.** CPU and GPU sizes; `accelerators` must match what the size carries (`nvidia-h100` or `H100`, and the count). Spot pools need the account's `allowSpot` and `previews` (Spot GPU is a DigitalOcean preview) and a GPU size. A Spot pool must come back with `spot: true`: one DigitalOcean made on-demand (the field is not in its published spec) is deleted by its id at once, and so is a new cluster whose initial Spot pool came back on-demand. A pool asked for as Spot carries `better-compute-spot:true`, so one found later on-demand (the create's answer was lost, or another creator raced) is deleted the same way, while an on-demand pool made as one that a spec later asks to be Spot is only `INVALID_STATE`; the call is `UNSUPPORTED` (`spotUnverified`), the delete is retried until it holds, and the process creates no Spot pool again until it restarts, so an unhonoured field never leaves an on-demand GPU pool billing. `nodeCount` and `autoscaling` change in place; with autoscaling the DigitalOcean autoscaler owns the count, and a scale-down is never fought. Size, Spot, labels and taints differing are `INVALID_STATE`; disks and zones are `UNSUPPORTED`. A pool is `ready` when all of its nodes run. Pools may be added to a cluster this deployment does not own (adopt mode), but a pool that is not its own is never changed or deleted.
- **Upgrades.** Raising `version` upgrades the control plane in place, a step at a time: to the newest version the cluster's `/upgrades` offers that does not pass the wanted one. A newer patch of the pinned minor satisfies a full-version or slug pin (DOKS's auto-upgrade moves the patch on every channel but `extended`), so a later firewall or auto-upgrade change still applies. A downgrade of the minor, or a version DOKS offers no way towards, is `INVALID_STATE`.
- **Deletes.** Only a cluster with both ownership tags is deleted (an adopted cluster never is). The delete is DOKS's plain one, never `/dangerous`: the load balancers, volumes and snapshots the cluster's workloads made are kept, and the answer's message counts them (a listing that fails counts none and is logged by its error code; the delete goes on).
- **Credentials.** `credentials()` creates (or reuses) the service account of the subject and role in the `bc-access` namespace (`<subject>-v`, `-e` or `-a`; a subject longer than 60 characters is shortened with a hash), binds it to the built-in `view`, `edit` or `cluster-admin` role and mints a bound token through the TokenRequest API. Each role has its own account and binding, so a token always acts with the role it was minted for: an `admin` mint for the same subject, concurrent or later, never re-scopes a `view` token. The mint authenticates with DOKS's cluster-admin credential, fetched for 300 seconds and held in memory for that one call; it must name the cluster's own endpoint, and the connection trusts only the cluster's CA. No token is stored, logged or put in an error. `digitaloceanProvider({ kubeTransport })` replaces the HTTPS transport in tests.

## Managed services (cloud resources)

`resources` serves DigitalOcean's long tail through the provider-neutral `ProviderResources` contract, which the
`@better-compute/cloud-resources` module drives (`cloudResources({ providers: [digitalocean] })`, next to
`vps({ providers })`). Pass the same provider definition to both.

- **Managed Databases:** a cluster kind per engine, `do.database.{pg,mysql,valkey,mongodb,kafka,opensearch}` (spec:
  `region`, `version`, `size`, `nodes`, `storageMiB`), and what lives in a cluster: `.user` (PostgreSQL, MySQL,
  MongoDB, Kafka, OpenSearch), `do.database.pg.pool` (PgBouncer), `.replica` (PostgreSQL, MySQL) and `.firewall`
  (trusted addresses, Droplet tags and Droplet ids). Size, nodes and storage resize in place; PostgreSQL and MySQL
  upgrade in place; a downgrade, a region change or a storage shrink is `INVALID_STATE` (`replaceRequired`).
  Droplet tags and Droplet ids are account-wide (`accountWide`): on a shared (hosted) account they would reach other
  tenants' Droplets, so only addresses and `instances` are trusted there. `instances` names better-compute instances
  of the tenant (the module checks they are its own, on the same account) and trusts each by its Droplet's
  `better-compute-instance:<id>` tag, which only that Droplet carries. A `.user` is never bound to the cluster's admin user (role
  `primary`, `doadmin`): that is `INVALID_INPUT` (`primaryUser`), and a delete of it answers `deleted` without a call,
  since it goes with the cluster.
- **Private networking.** A cluster's `vpc` (a VPC uuid) is account-wide: the tenant's own account only. On any
  account a cluster may instead name `network`, a better-compute network of the tenant (`net_…`): the module checks it
  is the tenant's and passes its provider-side name, and the cluster joins that network's subnet VPC in the cluster's
  region (`noSubnetInRegion` when it has none). `vpc` and `network` together are `INVALID_INPUT` (`vpcAndNetwork`);
  either changes only by a new cluster (`replaceRequired`).
- **User options by engine.** Kafka `acl` (`<admin|consume|produce|produceconsume>:<topic pattern>`) and OpenSearch
  `acl` (`<deny|admin|read|readwrite|write>:<index pattern>`) and PostgreSQL `replication` change in place
  (`PUT …/users/{name}`, settings only). A MySQL `authPlugin` (`caching_sha2_password`, `mysql_native_password`)
  change goes through `reset_auth`: DigitalOcean issues a new password, sealed in the same run. A MongoDB user's
  `readonly` is fixed at create. A Kafka user's client certificate and key are secret outputs (`accessCert`,
  `accessKey`) next to its password. These bodies follow the API reference, not a recording; MongoDB's newer
  `settings.mongo_user_settings` (role, databases) is not mapped yet.
- **Ownership.** A cluster carries `better-compute-managed:true`, this deployment's tag, the idempotency key's tag and
  the module's `better-compute-resource:<id>` and `better-compute-tenant:<t>` tags. A create first looks the key's tag
  up (only among clusters this deployment manages: another deployment's cluster with the same key tag is never
  changed), and the account-unique name settles a race. `delete` and `release` refuse (`notManaged`, nothing sent) a
  cluster without the managed and deployment tags, and so does anything living in such a cluster. Users, pools and
  firewalls have no tags: they are owned through their cluster.
- **Secrets.** Passwords and connection URIs (which embed the password) are only ever `secretOutputs`; the module
  seals them in the run that received them. They never reach `outputs`, a log line or an error.
- **Discover, adopt, release** by engine: adopt tags a cluster no deployment manages (`managedByAnother` otherwise);
  release takes every `better-compute-*` tag off and leaves it running.

- **App Platform:** `do.app` takes the App spec without its `name` (the provider name) as the manifest. A SECRET
  env's value, registry credentials and log-destination keys must be SecretRefs; they are resolved just before the
  call, and DO's ciphertext is never copied into a spec better-compute reports. Apps have no tags: ownership is a set
  of build-time `BETTER_COMPUTE_*` envs (tenants cannot set those) plus `BETTER_COMPUTE_SPEC`, the fingerprint of
  the spec last applied, so a converged app is never redeployed. Deployments are read-only status: the latest one
  decides `pending`, `updating`, `ready` or `error`. On a shared (hosted) account a spec may not reach
  account-wide objects: linked GitHub/GitLab/Bitbucket repositories, DOCR, a database cluster by name, a VPC or a DNS
  zone; on the tenant's own account it may. Discover, adopt (rewrites the envs once, keeping DO's ciphertext) and
  release.
- **Functions:** `do.functions-namespace` (owned through its label `<name>-bc<deployment hash>`; its key is a secret
  output; not adoptable) and `do.functions-trigger` (a scheduled trigger in a namespace; cron, body and enabled
  change in place, the function and name do not).
- **Add-Ons:** `do.addon`, a Marketplace SaaS add-on on a plan, owned through the name suffix
  `-bc<deployment hash>` (adopt renames it, release renames it back); only the plan changes in place. The vendor SSO
  link is never an output.
- **1-Click catalog:** `resources.catalog` lists `GET /v2/1-clicks` (one `sweep` call): Droplet 1-Clicks as
  `installsOn: 'instance'` (the slug is the Droplet image), Kubernetes ones as `'kubernetes'` (a DOKS add-on, P5).
- **Partner Network Connect:** `do.partner-attachment` joins VPCs of the account to a NaaS partner, so it exists only
  on the tenant's own account (refused with `accountWide` on a shared one). Owned through the name suffix; the
  service key and the BGP auth key are secret outputs, a BGP key the tenant chooses is a SecretRef; only the attached
  VPCs change in place.

Meters (`ProviderResourceState.usage`, the rate per hour the module samples): a cluster and each read-only replica
report `do.database.<engine>.node.hours` (its node count; a replica is one node); an app reports
`do.app.instance.hours` (its services' and workers' instances, an autoscaled one at its minimum; static sites and
jobs none); an add-on `do.addon.hours` and a Partner Network Connect attachment `do.partner-attachment.hours` (one
while it exists). A Functions namespace declares `do.functions.gib.seconds` but reports no rate: it bills by use,
which only DigitalOcean's billing knows (P9 reconciles it).

Token scopes: `database:read`, `database:create`, `database:update` and `database:delete`, plus `tag:create` for
adopt and release; the App Platform, Functions and Add-Ons scopes for those kinds. The App, Functions and Add-Ons
bodies follow the API reference and are not yet checked against recorded responses. A cluster's `vpc` (a VPC uuid)
is accepted only on the tenant's own account and cannot change in place. A cluster's `network` (a tenant network,
`net_…`) is accepted on any account: only the tenant's own networks, checked at the API and again before every
ensure; `vpc` and `network` together are refused (`vpcAndNetwork`), and a change is `replaceRequired`. Every kind
serves `find` (read-only), as its `ensure` finds its resource: the key tag (clusters, inference endpoints, knowledge
bases), the key env (apps), the label (namespaces), the name suffix (add-ons, attachments, guardrails, Managed
Agents objects), the base name whatever rotation it carries (model access keys) or the child of an owned cluster or
namespace, so a create whose answer was lost is deleted rather than forgotten (a preview kind is found even after
the account turns previews off). Not modelled yet: Standard and Advanced editions and Vector
Databases. The 1-Click body follows the API reference too.

## Storage: Spaces, CDN and Container Registry

### The operator's BlobStore on Spaces

`spacesBlobStore({ region, bucket, accessKey, secretKey, secrets, prefix?, partSizeBytes? })` implements core `BlobStore` on an existing Spaces bucket, for daemon downloads, log bundles and images. The host builds it and passes it to `betterCompute({ blobStore })`.

```ts
import { spacesBlobStore } from '@better-compute/provider-digitalocean';

const blobStore = spacesBlobStore({
  region: 'nyc3',
  bucket: 'acme-bc-ops',
  accessKey: 'vault://platform/spaces/access-key',
  secretKey: 'vault://platform/spaces/secret-key',
  secrets, // the host's SecretResolver
  prefix: 'better-compute/',
});
```

- `get` answers `undefined` for a missing object. A missing bucket throws `NOT_FOUND`.
- `put` sends a `Uint8Array`, or a stream of at most one part (default 16 MiB, at least 5 MiB), as one `PUT`. A longer stream goes as a multipart upload, which is aborted if anything fails (a part stored without an ETag included: `PROVIDER_ERROR`, `noEtag`), so at most one part is held in memory.
- `delete` succeeds for a blob that is already gone. A missing bucket throws `NOT_FOUND` (`noSuchBucket`), as for `get`: only `NoSuchKey` means the blob is gone.
- `presign` signs a `GET` or `PUT` for 1 second to 7 days.

Requests are path-style (`https://<region>.digitaloceanspaces.com/<bucket>/<key>`) and signed with SigV4 (`spaces/sigv4.ts`). The signer is hand-written on `node:crypto` (DO-D19) and tested against AWS's published vectors. `@better-compute/aws-core` is reserved for the AWS packages (`scripts/check-deps.mjs` rule 5), so this package does not use it.

A key with a `.` or `..` segment, a control character, a leading `/` or more than 1024 bytes is refused before any request, because URL parsing would turn it into another key. The key pair is resolved on first use, and again after Spaces refuses it (`spacesKeys`: `InvalidAccessKeyId`, `SignatureDoesNotMatch`), so a pair rotated in the SecretStore takes effect without a restart. The secret key never appears in a URL, a header that is returned, a log line or an error.

The client never follows a redirect, because a request carries signed headers and only the configured endpoint may be reached. A 3xx (`PermanentRedirect`, `TemporaryRedirect`, or one without a body) is `INVALID_CONFIG` with `reason` `bucketRegion`: the bucket is behind another endpoint, usually another region's. The error does not carry the redirect's location.

### Storage kinds

The provider serves the storage kinds itself: `digitaloceanProvider(options)` appends them to its long-tail kinds, so the one `resources` of an account (`DoResources`) answers `do.spaces-key`, `do.spaces-bucket`, `do.cdn-endpoint`, `do.container-registry` and `do.registry-garbage-collection` next to the databases, and `cloudResources.kinds` lists them. They share the provider's API client and request budget. The Spaces options are provider options: `spacesFetch`, `spacesEndpoint`, `spacesKeyFullAccess` and `spacesTenantBucketAdopt`. The Spaces kinds need the account's key pair (`spacesAccessKey`, `spacesSecretKey`); without it their calls fail closed (`INVALID_CONFIG`, `spacesKeys`).

Their contract types are core's own (`ProviderResourceRequest`, `ProviderResourceState`, `ProviderResourceKind`); the `Do…` names are aliases. So a request's `accountScope` and `secretOutputs` reach each kind, and every kind implements `find` (the resource a create whose answer was lost made: the bucket, registry or key under the derived name, the endpoint of the origin, the collection still running), so a delete never strands such a row. A CDN endpoint's `certificateId` and `customDomain` are account-wide (`accountWide`): on a shared account they are refused (`INVALID_INPUT`, `accountWide`), on the tenant's own account they are allowed. A Spaces key whose secret the caller never sealed answers `error` (DigitalOcean shows a secret once), not `ready`. Of the storage kinds only a bucket is `releasable` (an adopted one: its marker is taken off).

`doStorageResources(config, context, options?)` serves an account's storage resources on their own, in the shape of core's cloud-resources `ProviderResources` contract: `kinds()`, `ensure({ kind, name, spec, id?, parent?, labels? })`, `find`, `get`, `delete`, `discover`, `adopt` and `release`. Each kind's metadata (`description`, `spec` manifest, `outputs`, `secretOutputs`, `regional`, `updatable`, `parent`) is a `ProviderResourceKind`. The `cloud-resources` module can therefore take it as a provider's `resources` without an adapter. `storageDispatcher` is the dispatcher, and it validates each spec before any call. Every `ensure` and `delete` is idempotent.

`doStorageKinds(config, context, options?, client?)` returns the same kinds as entries of the provider-wide DigitalOcean dispatcher (`DoKind`): a `definition` plus calls that take the dispatcher's env first. This is what the provider appends: `new DoResources(client, config, deployment, [...doResourceKinds(), ...doStorageKinds(config, context, options, client)])`. Each entry validates and defaults its spec as well. The storage kinds carry their own API client and Spaces clients, so they ignore the env.

- When `ensure` gets an `id` (one an earlier `ensure` or an `adopt` answered), that resource wins over `name`. An adopted bucket is therefore converged in place, and no bucket is created under the derived name. A spec that would move a resource (a bucket's `region`, an endpoint's `origin`) is refused with `replaceRequired`.
- `get` and `adopt` also return `spec`, the spec as DigitalOcean reports it. Discovery returns `region`, `outputs` and `spec`, plus `managedBy: 'this'` or `'other'`.

| Kind                                                              | Spec (updatable in **bold**)                                                                                                                              | Outputs                                                                                                                                                      | Ownership                                                                                                                                                                      |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `do.spaces-key`                                                   | **`grants`**: `<region>/<bucket>:read` or `<region>/<bucket>:readwrite` (a bucket id); `*:fullaccess` only with the operator option `spacesKeyFullAccess` | `accessKeyId`, `name`, `grants` (bucket names, as DigitalOcean records them). Secret output: `secretKey`, returned only by the `ensure` that creates the key | The name is `bc-<deployment hash>-…`                                                                                                                                           |
| `do.spaces-bucket`                                                | `region`, **`acl`** (`private` or `public-read`), **`versioning`**                                                                                        | `bucket`, `region`, `endpoint`, `origin`, `acl`, `versioning`                                                                                                | A created bucket's name is `bc-<deployment hash>-…`; an adopted bucket's proof is the marker object `.better-compute/owner`. The marker also names the tenant and the resource |
| `do.cdn-endpoint` (parent `do.spaces-bucket`)                     | `origin` (`<bucket>.<region>.digitaloceanspaces.com`), **`ttl`** (60, 600, 3600, 86400 or 604800), **`customDomain`** with **`certificateId`**            | `origin`, `endpoint`, `url`, `ttl`, `customDomain`                                                                                                           | The origin is a managed bucket (by its name or its marker); for `ensure` and `adopt`, its marker names the same tenant, and the origin is the request's parent                 |
| `do.container-registry`                                           | `region`                                                                                                                                                  | `name`, `region`, `endpoint` (`registry.digitalocean.com/<name>`), `storageUsageBytes`                                                                       | The name is `bc-<deployment hash>-…`                                                                                                                                           |
| `do.registry-garbage-collection` (parent `do.container-registry`) | `registry` (the parent's id), **`type`**, **`intervalHours`** (default 24)                                                                                | `registry`, `uuid`, `status`, `blobsDeleted`, `freedBytes`                                                                                                   | The registry is this deployment's, and the request's parent                                                                                                                    |

Buckets, keys, CDN endpoints and registries carry no tags, so each kind proves ownership another way. The last column says how. A resource without that proof is never changed or deleted. It is refused with `INVALID_STATE` and one of these reasons, as the contract names them:

- `notManaged`: no better-compute deployment manages it (an unmarked bucket whose name is not this deployment's, a key or registry without a `bc-` name, an endpoint whose origin is not a managed bucket).
- `managedByAnother`: another deployment's marker is on the bucket, or a bucket's, key's or registry's name carries another deployment's prefix (or none: a bare `bc-` name).
- `unmanagedOrigin`: an `ensure` names a CDN origin that is not a managed bucket.

Tenants are kept apart too, with `ACCESS_DENIED` before anything is sent:

- A bucket's marker records the request's `better-compute-tenant` label. An `ensure` or `adopt` that reaches another tenant's bucket (or one marked for another resource) is refused with `otherTenant`.
- A Spaces key grants only buckets this deployment manages for the request's own tenant: `grantBucket` for an unmarked, missing or other deployment's bucket, `otherTenant` for another tenant's (a bucket without a tenant is the operator's). `*:fullaccess` is refused with `fullAccess` unless the operator sets `spacesKeyFullAccess`.
- A CDN endpoint and a garbage collection live in their parent (the bucket, the registry). `ensure` requires `parent`, the dispatcher's own tenant-scoped row, and it must be the bucket the origin names, or the registry the spec names (`INVALID_INPUT`, `parent`). A CDN origin's marker must also name the request's tenant.

Adopting and releasing:

- `adopt` on a bucket writes the marker, with the cloud resource id from the `better-compute-resource` label. A bucket another deployment marked is refused. An unmarked bucket is the operator's (the `spacesBlobStore` bucket, which holds every tenant's downloads, is one), so an `adopt` that carries a `better-compute-tenant` label and would claim one is refused with `ACCESS_DENIED` (`tenantAdopt`) unless the operator sets the code option `spacesTenantBucketAdopt`. Re-adopting a bucket already marked for the same tenant is allowed.
- `release` removes the marker of an adopted bucket and leaves the bucket and its data in place. A bucket named for this deployment is owned by its name, so its `release` is `UNSUPPORTED` (`adopt`).
- `adopt` on a CDN endpoint writes nothing (an endpoint has nothing to label). Its origin must be a managed bucket whose marker names the caller's tenant, or no tenant for an operator call, as for `ensure`: the row adopt makes serves `delete` and `purge`, so another tenant's endpoint is refused with `otherTenant`.
- Keys and registries are owned by their names, so `adopt` and `release` are `UNSUPPORTED` with `reason` `adopt`. The provider-side name is `bc-<deployment hash>-<rest>` (`managedNamePrefix(deployment)`, the 12 hex characters of the deployment tag), derived from the requested `bc-` name and hashed down to 63 characters when needed. Discovery reports `managedBy: 'this'` for this deployment's prefix and `'other'` for any other `bc-` name.
- A key is created whenever the request carries no `id`: a key found by name alone is a create whose answer, and secret, was lost. After every create, every older key with that name (by `created_at`, then access key) is deleted, so the secret always comes back and no duplicate credential stays live. A newer one is never deleted: two racing creates of one name (a claim that expired) leave the newest key, and the run whose key was reaped makes a fresh one on its next pass, when its recorded id reads as gone. An `id` is honoured only for the key of the request's own name; another key of this deployment is refused with `idMismatch`. A key records bucket names but not regions, so `get` and discovery return no `spec` for it. This makes `do.spaces-key` the one storage kind whose retried `ensure` without an `id` does not return the same resource, as the ProviderResources conformance case for idempotency expects. DigitalOcean returns a key's secret only from the create, so a key found again would have no secret. The cloud-resources reconciler records whatever id the retry answers, so a lost reply still ends with one working key.

Tenant data is never deleted to delete a resource:

- A bucket is deleted only when it holds nothing but its marker. Otherwise the delete is refused with `bucketNotEmpty`. If the bucket delete fails (an object arrived meanwhile, or any other error), the same marker is put back. The marker sits inside the bucket, where the tenant's `readwrite` key can delete or rewrite it, so it is never what keeps a bucket deletable: a bucket whose name is this deployment's is deleted (when empty) whatever its marker says, and the endpoint in front of it stays deletable and purgeable. A tenant that breaks its marker loses only its own access, since every tenant check needs the marker and fails closed. A delete cut off between the marker delete and the bucket delete (a crash) converges on the next delete the same way. No marker is made up for a bucket whose marker was lost. An adopted bucket, whose name is not ours, still depends on its marker: `adopt` it again (as the operator) and then `delete` it.
- Only a 404 means a bucket is gone. A 403 (a rotated or narrowed account key) is `ACCESS_DENIED` (`spacesAccess`) and a 301 is `INVALID_STATE` (`region`), from `get`, `delete` and an `ensure` that carries the bucket's `id` alike, so a row is never dropped while its bucket stays up. Only an `ensure` without an `id` (a first create) reads a 403 as a name another account holds (`CONFLICT`, `bucketNameTaken`).
- A bucket is not deleted while a CDN endpoint has it as its origin (`cdnEndpointAttached`): the endpoint is managed only through its origin bucket, so it would be left with nothing able to delete it. Delete the endpoint first.
- A registry is deleted only when it holds no repositories. Otherwise the delete is refused with `registryNotEmpty`.

Creating a bucket never leaves it unmarked and never takes another deployment's. After the create, the marker is read: another deployment's marker (a create can answer 200 for a bucket the account already holds) is refused with `managedByAnother`, and the marker is written only where there is none. If that check or write fails, the bucket that was just made, which is empty, is removed, so the next pass starts over rather than finding an unmarked bucket it must refuse. A marker over 4 KiB is not read; it counts as another's. A marker sent without a length is read only up to that cap.

`ensure` names a new bucket `bc-<deployment hash>-<rest>` from the requested `bc-` name, as for keys and registries (any other name is `INVALID_INPUT`). Spaces bucket names are global, and the prefix makes a collision with another account unlikely.

A bucket needs the account's Spaces key pair (the `spacesAccessKey` and `spacesSecretKey` config fields, both secret references). Without it, every bucket call fails closed with `INVALID_CONFIG` and `reason` `spacesKeys`. A bucket name that another account holds is `CONFLICT` with `bucketNameTaken`.

There is one CDN endpoint per origin, as DigitalOcean enforces. The kind's `purge(id, files)` method clears cached paths.

A garbage collection means "the registry was collected within the last `intervalHours`". `ensure` adopts the newest collection inside that window, or a running one, and starts a collection only when there is none. A reconciler that calls it again therefore never starts a second one. `delete` cancels a running collection. `repositories(name)` on the registry kind lists a registry's repositories. They are created by pushes, so they are read-only here.

### DOCR images

`docrImageSource({ token, secrets, registries })` is an OCI `ImageSource` (scheme `oci`) for `oci://registry.digitalocean.com/<registry>/<repository>:<tag>` or `@sha256:<digest>`. A tag or a digest is required.

The token and its registry credentials read every registry in the account, and registries are tenant resources, so `registries` (a list of registry names, or a predicate) says which ones resolutions may read. It defaults to none. `resolve(ref, { registries })` narrows one resolution further, to a tenant's own registries for example. A reference to any other registry is `ACCESS_DENIED` (`registry`) before any credential is fetched or request sent.

It resolves a reference this way:

1. It gets read-only registry credentials from `GET /v2/registry/docker-credentials`. They last 120 to 3600 seconds (default 600), are kept only in memory, and are renewed a minute before they expire.
2. It runs the registry's bearer-token flow with them.
3. It reads the manifest. A manifest referenced by digest is checked against that digest.
4. It picks the one disk layer, found by media type `application/vnd.better-compute.disk.<raw|qcow2|iso>[+zstd|gzip]` or by an `org.opencontainers.image.title` ending in `.raw`, `.img`, `.qcow2` or `.iso`, optionally followed by `.zst` or `.gz`.

It returns that layer's sha256, size, format and compression, together with the registry's own short-lived presigned blob URL. Nodes get only that URL, and they verify the digest.

The source fails closed in these cases:

- A registry that would serve the bytes itself is refused with `blobRedirect`, because a node would need the control plane's credentials to fetch them.
- Credentials are never sent to a token realm outside DigitalOcean's hosts. Such a realm is refused with `realm`.
- The layer URL goes to nodes only when it is on the registry itself or on an allowed storage host on the default port, without credentials in it. Otherwise the resolution fails with `blobHost` (a mirror's falls back to the source). The `blobHosts` option lists the allowed hosts, exact or `*.<domain>`; the default is `*.digitaloceanspaces.com`. It is a code-level option.

An image index is `UNSUPPORTED`; reference one platform's manifest by digest.

#### Regional mirrors

`resolve(ref, { region })` uses a mirror in that region when one exists. So does `forRegion(region)`, an `ImageSource` whose `resolve(ref)` is bound to one region. A mirror is a registry in the same account that holds a copy of the source registry's repositories, such as AI images (CUDA bases, inference servers) pushed to every region with GPUs. It works like this:

- The manifest is always read from the source registry. The source decides what a tag means, and the disk layer's digest comes from there.
- Only the layer, by digest, is fetched from the mirror. A node verifies that digest, so a stale or tampered mirror cannot substitute content.
- A mirror that lacks the layer, answers an error, would serve the bytes itself, or redirects off the allowed hosts is skipped. The source's presigned URL is used instead.
- A mirror is a registry like any other: it is read only when the `registries` allowlist, and the resolution's own `registries` when given, include it, whether it was discovered or named in `mirrors`. One that is not allowed is skipped for the source, so list the mirrors next to their source.

The `mirrors` option sets them:

- By default mirrors are discovered from `GET /v2/registries`, cached for 5 minutes. The mirror of `<source>` in region `R` is the registry named `<source>-R` whose storage region is `R`. If the listing fails, resolution goes to the source and the listing is retried a minute later.
- `{ <source>: { <region>: <mirror> } }` names them explicitly. A map with an invalid registry name or region slug is refused with `INVALID_CONFIG` (`mirrors`).
- `false` turns mirrors off.

A plain `resolve(ref)` never looks for a mirror.

Nothing consumes `ImageSource` extensions yet: wiring them into provision's image resolution is a follow-up.

## Edge: load balancers, DNS and certificates

`impl.loadBalancers`, `impl.dns` and `impl.certificates` are the provider-neutral edge contracts (P4). None of these DigitalOcean objects carries tags, so ownership is in the name or a marker, and anything that is not ours is never changed or deleted.

- **Load balancers** are named `<name>-<hash12>` (vps's name plus this deployment's hash); an ensure finds one by the id it returned, else by that exact name, and two of ours with one name converge on the oldest. Targets are explicit Droplet ids, never a tag: each must be an instance of this deployment in the load balancer's region (checked before any write), so a load balancer can't reach another tenant's Droplets. Each must also be in the load balancer's VPC (DO balances only to its own VPC; `INVALID_INPUT`, reason `vpc`): the subnet's VPC when the spec names a `network`, else the account's `vpc`, else the region's default VPC. A change is one `PUT` of the whole configuration, not sent while the load balancer is still `new`; type, region, VPC and network don't change in place. A global load balancer fronts regional ones of ours and serves domains it does not manage: the record pointing a name at it is published through `impl.dns`.
- **DNS zones** carry a marker, the TXT record `_better-compute.<zone>` = `deployment=<hash12>`. A zone without it is someone else's: `ensureZone` refuses it (`CONFLICT`, `zoneExists`) unless asked to `adopt` it, and an adopted zone is never deleted. A new zone is never made inside or above a domain of the account that does not carry this deployment's marker (`CONFLICT`, `zoneNested`): DO serves every zone of the account, so a tenant's zone nested in the operator's own domain would publish records under it. A zone of ours that still holds records other than the apex NS and SOA and the marker is not deleted (`CONFLICT`, `zoneNotEmpty`). The create and the marker are two writes: when the marker write fails (a 429, a 5xx), the empty domain just made is deleted again, so a retry starts over; if that delete fails too, the same client still marks or deletes the zone later, as long as it holds only DO's apex NS and SOA records. Another client (after a restart) fails closed on it like on any unmarked zone. Records are found by id, else by identical name, type and data, and change in place.
- **Certificates** are named `<name>-<hash12>` (DigitalOcean keeps names unique). `managed` (Let's Encrypt) is issued only for names in a zone the account hosts at DigitalOcean (`INVALID_INPUT` before any request); `custom` uploads PEMs resolved from secret references in the call and never kept, logged or returned. A certificate never changes in place (`INVALID_STATE`, `replace`).

## NAT gateways, peerings and routes

These are optional members of `impl.networks`. A subnet is a VPC, so each serves one subnet's VPC, and each name carries this deployment's hash.

- **NAT gateways** (`ensureNatGateway`) carry a subnet's egress, so its Droplets need no public address (isolated pools). One per subnet; `pending` until DigitalOcean makes it, then `ready` with its egress `address`.
- **Peerings** (`ensurePeering`) join two subnets of this deployment's networks; a VPC that is not one is never peered. A delete is `deleting`, then `deleted`.
- **Routes** (`ensureRoute`, preview: offered only with `previews: true`) add a static route to a subnet's VPC. The next hop is a NAT gateway of ours that serves the VPC, a Droplet of this deployment in it, or an address in its range, all checked before any write. A route never changes in place (`INVALID_STATE`, `replace`). The VPC Routes request shapes are unverified.
- **Ordered teardown.** `deleteSubnet` first deletes the subnet's NAT gateways, peerings and routes of ours and stays `pending` while any is left; one that is not ours keeps the subnet and is never touched.
- **Network model.** `networkModel: 'vpc-subnets'` (subnets inside one VPC per network and region, DigitalOcean's VPC Subnets preview) is reserved and refused for now. When it lands, moving an account to it will be an operator step, not automatic: the account's existing VPCs stay as they are.

## AI platform

The AI kinds (family `ai`) ride the same `resources` dispatcher. Ownership is by tags where DigitalOcean has them
(dedicated inference, knowledge bases) and by the name suffix `-bc<deployment hash>` where it does not (model access
keys, guardrails, the Managed Agents objects; `resources/kinds/named.ts`).

- **Dedicated Inference:** `do.dedicated-inference` serves a model slug on one GPU size, between `replicas` (always
  running) and `maxReplicas`; only those two change in place. The kind declares `quota`: GPUs per replica times
  `max(replicas, maxReplicas)`, which the cloud-resources module books against the tenant's GPU quota on the pool
  (`QUOTA_EXCEEDED` refuses a create or a scale-up; delete returns it; adopt is refused with `quotaBooked`). It
  reports `gpu.<model>.hours` (`gpu.h100.hours`, …), which bill once the host names them in
  `cloudResources({ kindMeters })`. A `vpc` is account-wide. On a shared pool the tenant reaches its endpoint through
  the inference proxy (`endpoint`, with an operator key), since it may hold no model access key there.
- **Model access keys:** `do.inference-key`, the bearer for serverless and dedicated inference. The key is a secret
  output only (sealed by the module); raising `rotation` regenerates it, and a create whose answer was lost
  regenerates the key it finds, so an unsealed secret is never live. Name: `<name>-r<rotation>-bc<hash>`. When the
  rename after a regenerate fails, the new secret is still returned and the following runs retry the rename alone
  (remembered in memory; a restart regenerates once more), so the key the tenant holds is not replaced on every poll. A key
  reaches the whole account, so it is accepted only on the tenant's own account (`accountWide` on a shared one).
- **Inference proxy:** `inferenceProxy({ record, endpoint?, fetch?, log? })` forwards `/v1/chat/completions`,
  `/v1/completions` and `/v1/embeddings` to `https://inference.do-ai.run` with the tenant's resolved key and hands each
  answer's token counts (and the caller's `meta`) to `record`, which the host writes as `ai.inference.tokens`.
  A streamed answer is counted even when the client cancels before its final usage chunk: the proxy reads the rest
  (at most 16 MiB). A `stream` that is not a boolean is refused (`reason 'stream'`); the counting path follows the
  upstream content type; a whole answer without usage is withheld (502) and recorded `uncounted`, as is a stream
  without a usage chunk. `endpoint` (a Dedicated Inference `outputs.endpoint`, only `https://<one label>.<dedicatedDomain>`)
  sends the call to that endpoint instead, and its usage carries `endpoint`. Wiring it to a route is the host's: the
  server does not import providers.
- **Knowledge bases:** `do.knowledge-base`, an embedding model (uuid) over `webSources` and `spacesSources`,
  indexed into an OpenSearch database DigitalOcean makes (or `database`). Sources change in place (added and removed,
  then one indexing job, owed until it starts: a failed start is retried); Spaces sources, `database` and `vpc`
  are account-wide. A job that ended failed reports `error`, and does not lock the knowledge base: the next source
  change is still applied and starts a new job (nothing is changed while a job runs or the database is not online). Delete also removes the OpenSearch database DigitalOcean made for it (never a named one, one
  another resource manages, or one another knowledge base uses).
- **Guardrails:** `do.guardrail` (`type` jailbreak, sensitive-data or content-moderation; `defaultResponse` and
  `description` change in place). No agents are deployed through the deprecated ADK (DO-D21).
- **Managed Agents (previews):** `do.agent-harness` (a model, `instructions`, knowledge bases, guardrails and an
  action gateway, on `runtime` `container` or `microvm`; the attachments are account-wide) and `do.action-gateway`
  (https `upstreams`). Both are `preview: true`: without `previews: true` on the account, `ensure`, `adopt`,
  `discover` and `release` are `UNSUPPORTED` (`preview`) and nothing is sent; `get` and `delete` still work, so one made
  while previews were on can be torn down. A delete of one DigitalOcean is already deleting sends nothing. Meters `do.agent-harness.hours` and `do.action-gateway.hours`.
- **Signals (preview):** `resources.signals` reads `GET /v2/managed-agents/signals` (read-only, the `sweep` budget)
  into provider-neutral `ProviderResourceSignal`s for harness agents and gateways: every page (at most 10 000
  signals) and the newest 500 kept; anything else, or a
  signal without a valid id or time, is dropped. `cloudResources.signals` shows them per tenant.

Token scopes: read, create, update and delete on the GenAI (Agent Platform) and Dedicated Inference resources, and on
the Managed Agents ones for the previews; the exact scope names are not confirmed yet. The bodies follow the API reference; the guardrail,
Managed Agents and Signals paths are assumed. None of them is checked against recorded responses yet: the live suite
must capture them before release.

## Operations

Billing, projects, monitoring, security and OAuth (program phase P9). Every read here is a GET with the account's own token, on the `sweep` budget unless noted, and none of them puts a token in a log or an error. Response shapes beyond the research notes are parsed tolerantly: a row it cannot read is left out, never guessed (costs fail the read instead, so a pass is retried rather than wrong).

- **List prices** (`listPrices`). DigitalOcean prices a size as a whole, so each (size, account region) is one `instance` price naming its offer (`nyc3/s-2vcpu-4gb`), in micros of USD per hour, from the offers catalog. No vCPU, memory or GPU part is derived from a size price, and Spot, volume and address prices are not listed. vps proposes a flavor meter whose flavors share an offer at that offer's price plus the margin.
- **Provider costs** (`costs: true`). The invoices whose month overlaps the window (a closed month from its final invoice, the current one from the month-to-date `invoice_preview`), one record per month, product, resource and cost type (items sharing one are summed). An item is a month aggregate, so it is read by every window it overlaps, and its id leaves out what grows (amount, duration, end) and what the final invoice may word differently from the preview (descriptions, project, category, start): later reads correct the stored row, and the final invoice replaces the preview's. Usage end is clamped to the read. Items carry no tags: a Droplet item is labelled with the instance and tenant tags of this deployment's Droplet of that id, so vps attributes it; a Droplet already deleted labels nothing. `billing.computeSku` names `Droplets` and `GPU Droplets`; `meteredSku` names volumes and reserved IPs. `periodRows` and `billsStopped` tell the vps leak check to compare an item's hours with the instance's running and stopped hours over its span, not hour slots.
- **Billing summary** (`billingSummary(config, context)`): balance, final invoices, the month to date and the newest 50 history entries, in micros of USD. The definition answers it as `ProviderInput.billingSummary`, so `providerAccounts.billing` (decided as `compute:providers:manage` on the account) and the MCP `provider_account_billing` tool read it.
- **Projects** (`projectPerTenant`). Each Droplet a create returns is assigned to `bc-<tenantId>` (vps passes the instance's tenant as the create request's `tenantId`), made on first use. It is grouping, never authority, and best effort: a failure is logged (`digitalocean.projectAssignFailed`) and never fails a create that has its Droplet.
- **Droplet metrics** (`doMetricsSource(config, context)`). An `externalMetrics` source (`@better-compute/observability`) for attached Droplets that run no bcd: CPU utilisation, memory and load by default, the root filesystem and public bandwidth opt-in (`metrics`), over the last ten minutes. Bandwidth is read as megabits per second, which is **unverified**. Droplets are read four at a time (`concurrency`). When the budget runs out, or the caller's signal aborts (its deadline), it answers what it read, and the next pull starts at the first Droplet it read nothing for.
- **Security findings** (`readSecurityFindings`, `observe` budget): the latest posture scan's findings, most severe first, and `securityAttention` maps them onto the admin panel's attention items. The provider's `findings` hook (`providerAccounts.findings`) answers them as `security:<rule>` findings, and a token without `security:read` as one `security:unreadable` finding. Read-only. The Security API shapes are **unverified** against a live account.
- **OAuth** (`refreshToken`). The provider exchanges the refresh token at `https://cloud.digitalocean.com/v1/oauth/token` for a 30-day access token. The refresh token rotates on every exchange, so the host must pass `digitaloceanProvider({ oauth: { clientId, clientSecret, redirectUris, rotate: rotateInto(store) } })`: `rotate` writes the new refresh token over the account's secret (`SecretStore.put(tenantId, value, { ref })`). A host without it refuses OAuth accounts. Every client of the account in one process shares one access token until a minute before it expires (or a 401), so the refresh token rotates about once a month, not per client. Every exchange reads the store, and an `invalid_grant` re-reads it for about two seconds (`raceWaitMs`), so a token another process rotated is used; still unchanged, it is `UNAVAILABLE` (`oauthRace`) the first time and a dead grant, `INVALID_CONFIG` (`oauthGrant`), the next. The token request is form-encoded in the body, never in the URL (`tokenParams: 'query'` falls back to DO's documented query form). With at least one `redirectUris` entry the definition carries a connect flow (`ProviderInput.connect`): `providerAccounts.connectSetup` answers the authorization URL for a registered redirect URI, and `providerAccounts.connect` trades the code (`exchangeAuthorizationCode`), seals the refresh token and stores the account with it as `refreshToken`. The console's Provider accounts page drives it.

`providerAccounts.check` runs `probeAccount` with the operations scopes on a stored account (`ProviderInput.probeAccount`): the Droplet scopes it lacks are `missing`, the operations ones `optional`, and it is `ok` only when the account is `active` with nothing missing. The CLI has `better-compute digitalocean check|offers|discover <account>` (alias `do`), and the MCP server opt-in `list_provider_accounts` and `check_provider_account` tools (`createComputeMcp({ providers: true })`).

Not here yet: alert policies, Insights rules and uptime checks (they are `cloudResources` kinds, program phase P7), and the admin panel surfaces.

## Rate budget

DigitalOcean allows 250 requests a minute and 5 000 an hour per token, over sliding windows, and the limits are shared by everything that uses the token: every reconciler of every account that names it, in every process. The provider keeps each token's requests (found by a hash of the token, which is never kept) under both limits, and re-seeds from the `ratelimit-*` headers of each response, so traffic from other processes counts. Requests have a class: a `mutate` (create, delete, action, tag write) may spend whatever is left, an `observe` (a read of one Droplet, an action, a firewall list) at most 30 % of a window (network reconciles reuse the firewall list for ten seconds, and drop it on each firewall write of their own; deletes read it afresh), and a `sweep` (discovery, `list`, the catalogs) at most 20 %. So discovery defers first, and at least half of every window stays free for the calls that change something. A request over its share is `RATE_LIMITED` with `retryAfterMs` (`details.reason` `budget`); a 429 from DigitalOcean is `RATE_LIMITED` with `retryAfterMs` from `ratelimit-reset`. `digitaloceanProvider({ budget: { perMinute, perHour } })` lowers the limits of an account that shares its token with other tools.

## Authentication

The token is a `SecretRef` and is resolved through `context.secrets.resolve` on the first request of a client. It lives only in that client's closure and never appears in a log, an error message or `details`. A tenant's account names its own secret (`secret://<its tenant>/…`); `env://`, another tenant's and the platform's secrets are `INVALID_CONFIG`, as for every provider (see `providerAccounts.create` in the API reference).

The endpoint is a code-level option. A `links.pages.next` URL is followed only when its origin equals the endpoint's; otherwise the call fails with `PROVIDER_ERROR` (`details.reason` `foreignLink`), so the bearer token is never sent anywhere else.

## Errors

DigitalOcean errors map to `ComputeError` codes: 401 `INVALID_CONFIG` (`token`), 403 `ACCESS_DENIED` (`scope`), 404 `NOT_FOUND`, 409 `CONFLICT`, 429 `RATE_LIMITED` with `retryAfterMs`, 5xx and an unreachable API `UNAVAILABLE`. A 422, which DigitalOcean uses for everything it validates, maps by its message: a size or region that is not available or insufficient capacity `CAPACITY_UNAVAILABLE`, the Droplet, volume and reserved IP limits and a Droplet full of volumes `QUOTA_EXCEEDED`, a volume attached to another Droplet or an address action still pending `CONFLICT`, a name, key or resource that already exists or is in use `CONFLICT`, and any other `INVALID_INPUT`. Each carries `details: { provider: 'digitalocean', status?, id?, requestId?, reason? }`.

## Tests, and what is not yet verified

The tests run against an in-memory emulator of the endpoints the provider uses (`tests/support/do-emulator/`), plugged in through the `fetch` option. `tests/provider-digitalocean.test.ts`, `tests/provider-digitalocean-networks.test.ts`, `tests/provider-digitalocean-volumes.test.ts`, `tests/provider-digitalocean-nfs.test.ts`, `tests/provider-digitalocean-addresses.test.ts` and the edge suites (`-load-balancers`, `-dns`, `-certificates`, `-nat`, `-peering`, `-routes`) run the conformance cases (volumes, snapshots, addresses and the edge members included; the conformance run uses `previews: true`) and the DigitalOcean specifics, and `tests/do-end-to-end.test.ts` runs the provider and the emulator through vps: create, stop and delete; discover, attach and detach; auto-attach; a tenant network with its base firewall and a rule; and a create DigitalOcean refuses for capacity.

The storage tests cover the signer (`tests/provider-digitalocean-sigv4.test.ts`, on AWS's published vectors), the S3 client and the BlobStore (`-spaces-s3`, `-spaces-blob-store`), the kinds (`-spaces-keys`, `-spaces-buckets`, `-cdn`, `-registry-kinds`) and the DOCR image source (`-docr-image-source`). They run against `tests/support/spaces-emulator.ts`, which checks every SigV4 signature with its own canonicalization, and against the Spaces Keys, CDN and registry modules in `tests/support/do-emulator/` (`spaces-keys.ts`, `cdn.ts`, `registry.ts`, which the tests register). How Spaces answers a `HEAD` on another account's bucket (403) and on a bucket in another region (301), the CDN's one-endpoint-per-origin rule, and the registry's redirect of blobs to presigned storage (and its host, which `blobHosts` defaults to `*.digitaloceanspaces.com`) are **unverified** until the storage live suite checks them.

`tests/live/digitalocean-storage.live.test.ts` is that suite. It is off unless `BC_DO_LIVE`, `BC_DO_TOKEN`, `BC_DO_SPACES_ACCESS_KEY` and `BC_DO_SPACES_SECRET_KEY` are all set. It creates a bucket, a Spaces key and a CDN endpoint, all named `bc-live-<hex>-…`, and sweeps them afterwards. On an account without Spaces, the first bucket starts the Spaces subscription, which is billed monthly. It checks:

- the 403 and 301 `HEAD` answers;
- that a key's `<bucket>:readwrite` grant reaches the bucket, through `spacesBlobStore` with the new key;
- that DigitalOcean refuses a second endpoint for one origin;
- with `BC_DO_LIVE_REGISTRY=1`, a registry create, discover and delete;
- with `BC_DO_LIVE_IMAGE=oci://…` (a disk image already pushed), that the presigned layer URL is fetchable without credentials.

A pass also confirms the storage token scopes in the table above. **It has not been run yet.**

The emulator's bodies are shaped like the fixtures in `tests/fixtures/digitalocean/`, which come from DigitalOcean's published OpenAPI specification. Some behaviours are not in the specification (`docs/research/digitalocean.md` marks them **unverified**): whether a `tag_name` list includes GPU Droplets, the exact text of the 422 messages for capacity and the Droplet limit, whether Droplet names may repeat, the limits on firewall rules, the MTU of a VPC, the text of the Block Storage and reserved IP 422s, the volume action type names (`attach_volume`, …), and the token scope names for Block Storage and reserved IPs. The provider handles both outcomes of each, and an opt-in live suite settles them. DOKS is emulated by `tests/support/doks-emulator.ts` (each node is also a worker Droplet in the account, so the Droplet code meets cluster nodes) and tested in `tests/provider-digitalocean-doks.test.ts`, the HTTPS transport against a local server on a throwaway CA; not yet checked against the live API are the device-plugin field names, the node pool `spot` field, the shortest `expiry_seconds` DOKS accepts, and whether cluster and pool tags reach the worker Droplets (the Droplet code refuses a worker by DOKS's own tags as well as by ours, so either way it is never claimed). **The live suite has not been run yet.**

Three more facts are neither in the specification nor asserted by the live suite yet, and the provider relies on them without a guard: that DigitalOcean honours a firewall rule's `action: deny` (the OpenAPI schema has the field), that a firewall targeting a tag covers a new Droplet with that tag before the Droplet serves traffic (a network is `ready` once its base firewall exists, not once it is applied), and that a `PUT` renames a firewall (a priority change renames the rule's firewall in place). Check them against a real account before the first production use.

`tests/live/digitalocean.live.test.ts` runs the account probe, the provider conformance cases (with claim and discover, when an attachable Droplet is given) and a tenant network (VPC, base firewall and a rule) against a real account; the conformance cases include a 1 GiB volume, a snapshot and a reserved IPv4 address, which the sweep also removes (reserved IPs by the addresses the run reserved, since DigitalOcean gives them no tag), and the edge cases a load balancer, a NAT gateway and a peering, which the sweep finds by the run deployment's name suffix (DNS zones by their marker). It is off unless both `BC_DO_LIVE` and `BC_DO_TOKEN` are set, because it creates billable Droplets (it always sweeps them, and deletes only resources that carry the run's own tag or name prefix):

```sh
BC_DO_LIVE=1 BC_DO_TOKEN=<token> BC_DO_SSH_KEY_FINGERPRINT=<md5 fingerprint of an account key> \
  node node_modules/vitest/vitest.mjs run tests/live/digitalocean.live.test.ts
```

| Variable                    | Meaning                                                                                                         |
| --------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `BC_DO_LIVE`, `BC_DO_TOKEN` | Both are required: the switch and the token.                                                                    |
| `BC_DO_SSH_KEY_FINGERPRINT` | The MD5 fingerprint of a key in the account (required).                                                         |
| `BC_DO_REGION`              | The region to run in (default `nyc3`).                                                                          |
| `BC_DO_SIZE`                | The Droplet size (default `s-1vcpu-512mb-10gb`).                                                                |
| `BC_DO_IMAGE`               | The image slug (default `ubuntu-24-04-x64`).                                                                    |
| `BC_DO_ATTACHABLE`          | The id of a hand-made Droplet that the claim and discover cases may tag and untag; without it they are skipped. |
