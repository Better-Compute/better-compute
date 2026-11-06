# @better-compute/provider-digitalocean

A DigitalOcean provider for better-compute: Droplets as VPS instances and offers (GPU Droplets included), with attach and tenant networks. It talks to the DigitalOcean API v2 over plain `fetch` and has no npm dependencies beyond `@better-compute/core` and `@better-compute/vps`.

It is not part of the `better-compute` umbrella: install it next to `better-compute`.

```sh
npm install @better-compute/provider-digitalocean
```

## Configuration

An account is data, validated by the provider's manifest:

| Field               | Meaning                                                                                                                                       |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `token`             | A secret reference to a personal access token with the scopes below.                                                                          |
| `regions`           | At least one region slug. Offers and discovery are limited to these, and so is every create, claim and subnet.                                |
| `vpc`               | A VPC name or uuid that `create` uses when it gets no tenant network (default: the region's default VPC).                                     |
| `sshKeyFingerprint` | The MD5 fingerprint of an account SSH key that is added to every Droplet (a fingerprint, not a secret; see below).                            |
| `monitoring`        | Install DigitalOcean's metrics agent on new Droplets (default `true`).                                                                        |
| `ipv6`              | Give new Droplets an IPv6 address (default `false`).                                                                                          |
| `allowSpot`         | Offer and create Spot GPU capacity where DigitalOcean reports a Spot price (default `false`; see [Spot](#spot)).                              |
| `discoverTag`       | A tag: discovery yields only Droplets that carry it. Lower-case `[a-z0-9:_-]`, at most 255 characters (else `INVALID_CONFIG`, `discoverTag`). |
| `previews`          | Accepted, default `false`; reserved for products that DigitalOcean still marks as previews. It has no effect yet.                             |

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

`digitaloceanProvider({ fetch, endpoint, deployment, inCallWaitMs, budget })` swaps the transport, the API endpoint (default `https://api.digitalocean.com/v2`; never taken from tenant config), the deployment name hashed into the deployment tag (default `default`), `inCallWaitMs` (accepted and checked, default 0, at most 20 000, but with no effect yet: every call starts its action and returns without waiting) and the request budget (see [Rate budget](#rate-budget)). `probeAccount(config, context, options?)` is a read-only check of what a token may do (the optional third argument is the same `DoProviderOptions`, for `fetch`, `endpoint` and `budget`): it reads `GET /account` and then one page of each of seven lists (Droplets, regions, sizes, VPCs, firewalls, account SSH keys and tags), and reports the read scopes the token lacks.

## Token scopes

Create the token as a custom-scope token with at least:

| Scopes                                                                     | For                                                                                                                                  |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `account:read`, `regions:read`, `sizes:read`, `image:read`, `actions:read` | The account check, the offer catalog and the state of a Droplet's create action.                                                     |
| `droplet:read,create,update,delete`                                        | Creating, reading, powering, rebuilding and deleting Droplets. Autoscale pool membership is read for discovery, with `droplet:read`. |
| `ssh_key:read,create`                                                      | Finding the account key for a fingerprint and registering the keys an instance brings. The provider never deletes a key.             |
| `tag:read,create,delete`                                                   | Making tags, putting them on one Droplet at a time and taking them off again.                                                        |
| `vpc:read,create,update,delete`                                            | The VPC behind each tenant subnet.                                                                                                   |
| `firewall:read,create,update,delete`                                       | The base firewall and the firewall behind each tenant rule.                                                                          |

A token without a scope fails the call that needs it with `ACCESS_DENIED` (`details.reason` `scope`); `probeAccount` names the missing read scopes up front.

## Tag scheme

DigitalOcean has no labels, only flat tags, so better-compute writes a label as the tag `<key>:<value>`, in lower case. Tags match `[a-z0-9:_-]`, at most 255 characters. A value that is not `[a-z0-9_-]` or is longer than 200 characters becomes `x` plus 26 base32 characters of its SHA-256, so the tag stays decodable and `Ann@x.com` stays apart from `ann@x.com`.

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
3. **A catalog image** `name@version`: imported as a DigitalOcean custom image. This needs `digitaloceanProvider({ catalogImages })`, a host-side source whose `locate(ref, { expiresInSeconds })` returns the image's digest, format and a short-lived HTTPS URL DigitalOcean can fetch (provision's catalog plus a BlobStore that presigns a GET). Without it a catalog image is `UNSUPPORTED` (`catalogImage`).

How an import works:

- **The image is its own record.** An import carries `better-compute-managed:true`, the deployment tag and `better-compute-image:<24 hex of the digest>`, is named `bc-img-<ref>-<12 hex>`, and is found by that tag. Like a Droplet create, two racing imports converge on the oldest; the others are deleted one by one. An image with the tag but without the managed and deployment tags is never used or deleted.
- **Nothing blocks.** While the import (or a copy into another region, a `transfer` image action) runs, `create` and `reinstall` throw `UNAVAILABLE` (`imageImporting` / `imageTransferring`, `retryAfterMs` 30 s), and vps calls the create again. A retry never starts a second import or a second transfer to the same region.
- **A failed import** (DO reports it `deleted` with an `error_message`) is deleted and fails the create `INVALID_STATE` (`imageImportFailed`); the next create imports afresh.
- **What DigitalOcean can't import is refused before any request:** `iso` images, `zstd` compression (`UNSUPPORTED`, `imageFormat`), an unknown ref, a digest that is not SHA-256 and a URL that is not HTTPS (`INVALID_CONFIG`).
- **The presigned URL is a credential.** It goes into the import body only; it never reaches a log line or an error, even when DigitalOcean quotes it back in a 422.

**GPU images.** An AI/ML image (`gpu-…`) on a size without GPUs, or one built for the other vendor (an NVIDIA image on an MI300X size), is `INVALID_INPUT` (`gpuImage`) before any request, in `create` and `reinstall`. Plain OS images boot GPU sizes: DigitalOcean's docs say GPU Droplets work with them once drivers are installed.

Imports need `image:create` (and `image:update` for transfers, `image:delete` for reaping) on top of `image:read`.

## Spot

With `allowSpot`, a size whose catalog entry reports a Spot price gets a second offer `region/size@spot` at that price (DigitalOcean changes it daily). A create for it sends the Spot request member and tags the Droplet `better-compute-capacity:spot`, so it reads back with its `@spot` offer id; a tenant label can't forge that tag. A Spot create for a size the cached catalog shows without Spot is `INVALID_INPUT` (`spot`).

**The wire shape is not verified.** DigitalOcean's public OpenAPI has no Spot member on sizes or on the Droplet create (checked 2026-11-05). The provider's assumptions are data in one place, `spotShape` in `compute/spot.ts` (`verified: false`): the size member `spot_price_hourly` and the create member `capacity_type: 'spot'`. A catalog without the size member yields no Spot offer at all, so a wrong guess offers nothing rather than something else. The live suite settles it.

**Preemption.** DigitalOcean warns of a reclaim, at least two hours ahead, by email only. vps treats a Spot instance whose machine vanishes as preempted: it is `lost` with a `Preempted` condition and `instance.preempted`, and a pool whose policy sets `replacePreempted: true` recreates it on a new machine.

## Bare Metal GPUs

DigitalOcean's API has no Bare Metal resource, so `digitaloceanMetalProvider({ machines, ssh, deployment })` (provider id `digitalocean-metal`, `provides: ['metal']`) works over SSH with machines the operator lists in code, never in tenant config. Its accounts belong to the platform tenant only (`INVALID_CONFIG`, `platformOnly` otherwise); the account config is `sshKey` (a secret reference to the private key), `sshUser` (default `root`) and `regions`.

- **Claims are compare-and-set.** A claim is the file `/var/lib/better-compute/claim`, created with O_EXCL, naming the deployment and the idempotency key: a retried create finds its own claim, any other gets `CONFLICT`. Offers are the unclaimed machines (one that can't be reached is offered unavailable); `get` and `list` see only this deployment's claims.
- **`delete`** stops bcd and removes this deployment's claim; the machine stays. Another claim is `INVALID_STATE` (`notManaged`).
- **`bootstrap`** writes the single-use `provisioned` join token over SSH stdin into a root-only file, installs bcd pinned by sha256, and starts `bcd-join.service` and `bcd.service`. `identify` reads the SMBIOS UUID.
- **Power** is a reboot over SSH only (`graceful-restart`); with no API or BMC, every other action is `UNSUPPORTED` (`noBmc`).
- A machine may pin its host key (`hostKeySha256`, passed to the executor). An SSH failure is `UNAVAILABLE` and carries neither the key nor the executor's message.

MicroVMs (preview) are not supported: vps sandboxes run on hosted pools through bcd, and a provider-backed sandbox backend is a follow-up (see `docs/research/digitalocean.md`).

## Droplet metadata in inventory

On a Droplet (DMI system vendor `DigitalOcean`), bcd reads the metadata service (`169.254.169.254/metadata/v1.json`) into the inventory system section's `cloud`: the Droplet id, region, tags and interfaces. It never keeps user data, vendor data, SSH keys or the auth key, and nothing uses the value as an identity: the service is unsigned, so Droplets join with tokens. The control plane reads it with `cloudInstanceOf` from `@better-compute/inventory`.

## Attach

`discover` yields every Droplet of the configured regions (optionally only those with `discoverTag`), GPU Droplets too, with shape, GPUs, labels, networks and creation time. A Droplet that belongs to a DigitalOcean autoscale pool carries the pool's id in the label `better-compute-autoscale-pool`: autoscale pool membership is read for discovery, and a `claim` of such a Droplet is `INVALID_STATE` (`autoscalePool`), since DigitalOcean scales it itself.

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

## Rate budget

DigitalOcean allows 250 requests a minute and 5 000 an hour per token, over sliding windows, and the limits are shared by everything that uses the token: every reconciler of every account that names it, in every process. The provider keeps each token's requests (found by a hash of the token, which is never kept) under both limits, and re-seeds from the `ratelimit-*` headers of each response, so traffic from other processes counts. Requests have a class: a `mutate` (create, delete, action, tag write) may spend whatever is left, an `observe` (a read of one Droplet, an action, a firewall list) at most 30 % of a window (network reconciles reuse the firewall list for ten seconds, and drop it on each firewall write of their own; deletes read it afresh), and a `sweep` (discovery, `list`, the catalogs) at most 20 %. So discovery defers first, and at least half of every window stays free for the calls that change something. A request over its share is `RATE_LIMITED` with `retryAfterMs` (`details.reason` `budget`); a 429 from DigitalOcean is `RATE_LIMITED` with `retryAfterMs` from `ratelimit-reset`. `digitaloceanProvider({ budget: { perMinute, perHour } })` lowers the limits of an account that shares its token with other tools.

## Authentication

The token is a `SecretRef` and is resolved through `context.secrets.resolve` on the first request of a client. It lives only in that client's closure and never appears in a log, an error message or `details`. A tenant's account names its own secret (`secret://<its tenant>/…`); `env://`, another tenant's and the platform's secrets are `INVALID_CONFIG`, as for every provider (see `providerAccounts.create` in the API reference).

The endpoint is a code-level option. A `links.pages.next` URL is followed only when its origin equals the endpoint's; otherwise the call fails with `PROVIDER_ERROR` (`details.reason` `foreignLink`), so the bearer token is never sent anywhere else.

## Errors

DigitalOcean errors map to `ComputeError` codes: 401 `INVALID_CONFIG` (`token`), 403 `ACCESS_DENIED` (`scope`), 404 `NOT_FOUND`, 409 `CONFLICT`, 429 `RATE_LIMITED` with `retryAfterMs`, 5xx and an unreachable API `UNAVAILABLE`. A 422, which DigitalOcean uses for everything it validates, maps by its message: a size or region that is not available or insufficient capacity `CAPACITY_UNAVAILABLE`, the Droplet limit `QUOTA_EXCEEDED`, a name, key or resource that already exists or is in use `CONFLICT`, and any other `INVALID_INPUT`. Each carries `details: { provider: 'digitalocean', status?, id?, requestId?, reason? }`.

## Tests, and what is not yet verified

The tests run against an in-memory emulator of the endpoints the provider uses (`tests/support/do-emulator/`), plugged in through the `fetch` option. `tests/provider-digitalocean.test.ts` and `tests/provider-digitalocean-networks.test.ts` run the conformance cases and the DigitalOcean specifics, and `tests/do-end-to-end.test.ts` runs the provider and the emulator through vps: create, stop and delete; discover, attach and detach; auto-attach; a tenant network with its base firewall and a rule; and a create DigitalOcean refuses for capacity.

The emulator's bodies are shaped like the fixtures in `tests/fixtures/digitalocean/`, which come from DigitalOcean's published OpenAPI specification. Some behaviours are not in the specification (`docs/research/digitalocean.md` marks them **unverified**): whether a `tag_name` list includes GPU Droplets, the exact text of the 422 messages for capacity and the Droplet limit, whether Droplet names may repeat, the limits on firewall rules, and the MTU of a VPC. The provider handles both outcomes of each, and an opt-in live suite settles them. **The live suite has not been run yet.**

Three more facts are neither in the specification nor asserted by the live suite yet, and the provider relies on them without a guard: that DigitalOcean honours a firewall rule's `action: deny` (the OpenAPI schema has the field), that a firewall targeting a tag covers a new Droplet with that tag before the Droplet serves traffic (a network is `ready` once its base firewall exists, not once it is applied), and that a `PUT` renames a firewall (a priority change renames the rule's firewall in place). Check them against a real account before the first production use.

`tests/live/digitalocean.live.test.ts` runs the account probe, the provider conformance cases (with claim and discover, when an attachable Droplet is given) and a tenant network (VPC, base firewall and a rule) against a real account. It is off unless both `BC_DO_LIVE` and `BC_DO_TOKEN` are set, because it creates billable Droplets (it always sweeps them, and deletes only resources that carry the run's own tag or name prefix):

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
