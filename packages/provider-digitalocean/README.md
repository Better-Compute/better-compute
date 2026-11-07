# @better-compute/provider-digitalocean

A DigitalOcean provider for better-compute: Droplets as VPS instances and offers (GPU Droplets included), with attach and tenant networks, plus storage: a Spaces `BlobStore`, Spaces buckets and keys, CDN endpoints and Container Registry as resource kinds, and a DOCR image source. It talks to the DigitalOcean API v2 over plain `fetch` and has no npm dependencies beyond `@better-compute/core` and `@better-compute/vps`.

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
| `allowSpot`         | Accepted, default `false`; reserved for Spot capacity, which P1 does not create (see [Machines](#machines)).                                  |
| `discoverTag`       | A tag: discovery yields only Droplets that carry it. Lower-case `[a-z0-9:_-]`, at most 255 characters (else `INVALID_CONFIG`, `discoverTag`). |
| `previews`          | Accepted, default `false`; reserved for products that DigitalOcean still marks as previews. It has no effect yet.                             |
| `spacesAccessKey`   | A secret reference to a Spaces access key id. With `spacesSecretKey`, it is the S3 key pair that manages tenant buckets (see [Storage](#storage-spaces-cdn-and-container-registry)). |
| `spacesSecretKey`   | A secret reference to the Spaces secret key that goes with `spacesAccessKey`. Set both or neither.                                           |

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
| `spaces_key:read,create,update,delete`, `cdn:read,create,update,delete`, `registry:read,create,update,delete` | The storage kinds and DOCR credentials, only if they are used. These scope names are **unverified** until the live suite checks them. |

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
- **Spot offers are not created in P1.** `listOffers` offers no Spot capacity, and a create for an offer id ending in `@spot` is `UNSUPPORTED` (`details.reason` `spot`). `allowSpot` has no effect yet.
- **`create` is idempotent through a tag.** DigitalOcean has no idempotency key, so the create carries `better-compute-key:<hash of the key>`, looks for it before it posts, and looks again after. Two creates that race on one key both post; each then sees both Droplets, keeps the oldest and deletes the others (only managed Droplets of this deployment, one by one), so every caller converges on one Droplet. An answer that never arrived (`UNAVAILABLE`) is followed by the same lookup.
- **It always sends an SSH key.** A Droplet created without a key may make DigitalOcean email a root password, which better-compute must never cause. So a create sends the instance's keys, each registered in the account as `bc-<fingerprint prefix>` if the account lacks it, and the account's `sshKeyFingerprint`. That is why `sshKeyFingerprint` exists: an instance with no key of its own still gets one. With neither, the create is `INVALID_CONFIG` (`details.reason` `noSshKey`); a fingerprint that is not in the account is `INVALID_CONFIG` too. Keys are shared by the whole account, so the provider never deletes one. (vps reads config fields that end in `key` as secrets, which a fingerprint is not, hence the name.)
- **Other create rules.** User data is at most 64 KiB. An image is a slug or a numeric id; a catalog image (`…@…`) is `UNSUPPORTED` (`catalogImage`). An offer in a region outside `regions` is `INVALID_INPUT`.
- **`get` of a Droplet that is still `new`** reads its create action: an action that ended `errored` throws `CAPACITY_UNAVAILABLE` (`createActionErrored`), which vps turns into `ProvisionFailed`. Nothing is kept between calls.
- **`power`:** `on` is `power_on`, `off` is `power_off`, `graceful-off` is `shutdown`, `graceful-restart` is `reboot`, `cycle` and `reset` are `power_cycle`; `nmi` is `UNSUPPORTED`. The action is started, not awaited: a later `get` shows it. `reinstall` is `rebuild` and, like a delete, needs a managed Droplet.
- **`list`** yields this deployment's managed Droplets (the deployment-tag list plus the GPU list).

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
- `delete` succeeds for a blob that is already gone.
- `presign` signs a `GET` or `PUT` for 1 second to 7 days.

Requests are path-style (`https://<region>.digitaloceanspaces.com/<bucket>/<key>`) and signed with SigV4 (`spaces/sigv4.ts`). The signer is hand-written on `node:crypto` (DO-D19) and tested against AWS's published vectors. `@better-compute/aws-core` is reserved for the AWS packages (`scripts/check-deps.mjs` rule 5), so this package does not use it.

A key with a `.` or `..` segment, a control character, a leading `/` or more than 1024 bytes is refused before any request, because URL parsing would turn it into another key. The key pair is resolved on first use, and again after Spaces refuses it (`spacesKeys`: `InvalidAccessKeyId`, `SignatureDoesNotMatch`), so a pair rotated in the SecretStore takes effect without a restart. The secret key never appears in a URL, a header that is returned, a log line or an error.

The client never follows a redirect, because a request carries signed headers and only the configured endpoint may be reached. A 3xx (`PermanentRedirect`, `TemporaryRedirect`, or one without a body) is `INVALID_CONFIG` with `reason` `bucketRegion`: the bucket is behind another endpoint, usually another region's. The error does not carry the redirect's location.

### Storage kinds

`doStorageResources(config, context, options?)` serves an account's storage resources in the shape of core's cloud-resources `ProviderResources` contract: `kinds()`, `ensure({ kind, name, spec, id?, parent?, labels? })`, `get`, `delete`, `discover`, `adopt` and `release`. Each kind's metadata (`description`, `spec` manifest, `outputs`, `secretOutputs`, `regional`, `updatable`, `parent`) is a `ProviderResourceKind`. The `cloud-resources` module can therefore take it as a provider's `resources` without an adapter. `storageDispatcher` is the dispatcher, and it validates each spec before any call. Every `ensure` and `delete` is idempotent.

`doStorageKinds(config, context, options?)` returns the same kinds as entries of the provider-wide DigitalOcean dispatcher: a `definition` plus calls that take the dispatcher's env first. That dispatcher is `DoResources`, from the cloud-resources lane, so one `resources` can serve databases and storage together: `new DoResources(client, config, deployment, [...doResourceKinds(), ...doStorageKinds(config, context, options)])`. Each entry validates and defaults its spec as well. The storage kinds carry their own API client and Spaces clients, so they ignore the env.

- When `ensure` gets an `id` (one an earlier `ensure` or an `adopt` answered), that resource wins over `name`. An adopted bucket is therefore converged in place, and no bucket is created under the derived name. A spec that would move a resource (a bucket's `region`, an endpoint's `origin`) is refused with `replaceRequired`.
- `get` and `adopt` also return `spec`, the spec as DigitalOcean reports it. Discovery returns `region`, `outputs` and `spec`, plus `managedBy: 'this'` or `'other'`.

| Kind | Spec (updatable in **bold**) | Outputs | Ownership |
| --- | --- | --- | --- |
| `do.spaces-key` | **`grants`**: `<region>/<bucket>:read` or `<region>/<bucket>:readwrite` (a bucket id); `*:fullaccess` only with the operator option `spacesKeyFullAccess` | `accessKeyId`, `name`, `grants` (bucket names, as DigitalOcean records them). Secret output: `secretKey`, returned only by the `ensure` that creates the key | The name is `bc-<deployment hash>-…` |
| `do.spaces-bucket` | `region`, **`acl`** (`private` or `public-read`), **`versioning`** | `bucket`, `region`, `endpoint`, `origin`, `acl`, `versioning` | A created bucket's name is `bc-<deployment hash>-…`; an adopted bucket's proof is the marker object `.better-compute/owner`. The marker also names the tenant and the resource |
| `do.cdn-endpoint` (parent `do.spaces-bucket`) | `origin` (`<bucket>.<region>.digitaloceanspaces.com`), **`ttl`** (60, 600, 3600, 86400 or 604800), **`customDomain`** with **`certificateId`** | `origin`, `endpoint`, `url`, `ttl`, `customDomain` | The origin is a managed bucket (by its name or its marker); for `ensure` and `adopt`, its marker names the same tenant, and the origin is the request's parent |
| `do.container-registry` | `region` | `name`, `region`, `endpoint` (`registry.digitalocean.com/<name>`), `storageUsageBytes` | The name is `bc-<deployment hash>-…` |
| `do.registry-garbage-collection` (parent `do.container-registry`) | `registry` (the parent's id), **`type`**, **`intervalHours`** (default 24) | `registry`, `uuid`, `status`, `blobsDeleted`, `freedBytes` | The registry is this deployment's, and the request's parent |

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

The `mirrors` option sets them:

- By default mirrors are discovered from `GET /v2/registries`, cached for 5 minutes. The mirror of `<source>` in region `R` is the registry named `<source>-R` whose storage region is `R`. If the listing fails, resolution goes to the source and the listing is retried a minute later.
- `{ <source>: { <region>: <mirror> } }` names them explicitly. A map with an invalid registry name or region slug is refused with `INVALID_CONFIG` (`mirrors`).
- `false` turns mirrors off.

A plain `resolve(ref)` never looks for a mirror.

Nothing consumes `ImageSource` extensions yet: wiring them into provision's image resolution is a follow-up.

## Rate budget

DigitalOcean allows 250 requests a minute and 5 000 an hour per token, over sliding windows, and the limits are shared by everything that uses the token: every reconciler of every account that names it, in every process. The provider keeps each token's requests (found by a hash of the token, which is never kept) under both limits, and re-seeds from the `ratelimit-*` headers of each response, so traffic from other processes counts. Requests have a class: a `mutate` (create, delete, action, tag write) may spend whatever is left, an `observe` (a read of one Droplet, an action, a firewall list) at most 30 % of a window (network reconciles reuse the firewall list for ten seconds, and drop it on each firewall write of their own; deletes read it afresh), and a `sweep` (discovery, `list`, the catalogs) at most 20 %. So discovery defers first, and at least half of every window stays free for the calls that change something. A request over its share is `RATE_LIMITED` with `retryAfterMs` (`details.reason` `budget`); a 429 from DigitalOcean is `RATE_LIMITED` with `retryAfterMs` from `ratelimit-reset`. `digitaloceanProvider({ budget: { perMinute, perHour } })` lowers the limits of an account that shares its token with other tools.

## Authentication

The token is a `SecretRef` and is resolved through `context.secrets.resolve` on the first request of a client. It lives only in that client's closure and never appears in a log, an error message or `details`. A tenant's account names its own secret (`secret://<its tenant>/…`); `env://`, another tenant's and the platform's secrets are `INVALID_CONFIG`, as for every provider (see `providerAccounts.create` in the API reference).

The endpoint is a code-level option. A `links.pages.next` URL is followed only when its origin equals the endpoint's; otherwise the call fails with `PROVIDER_ERROR` (`details.reason` `foreignLink`), so the bearer token is never sent anywhere else.

## Errors

DigitalOcean errors map to `ComputeError` codes: 401 `INVALID_CONFIG` (`token`), 403 `ACCESS_DENIED` (`scope`), 404 `NOT_FOUND`, 409 `CONFLICT`, 429 `RATE_LIMITED` with `retryAfterMs`, 5xx and an unreachable API `UNAVAILABLE`. A 422, which DigitalOcean uses for everything it validates, maps by its message: a size or region that is not available or insufficient capacity `CAPACITY_UNAVAILABLE`, the Droplet limit `QUOTA_EXCEEDED`, a name, key or resource that already exists or is in use `CONFLICT`, and any other `INVALID_INPUT`. Each carries `details: { provider: 'digitalocean', status?, id?, requestId?, reason? }`.

## Tests, and what is not yet verified

The tests run against an in-memory emulator of the endpoints the provider uses (`tests/support/do-emulator/`), plugged in through the `fetch` option. `tests/provider-digitalocean.test.ts` and `tests/provider-digitalocean-networks.test.ts` run the conformance cases and the DigitalOcean specifics, and `tests/do-end-to-end.test.ts` runs the provider and the emulator through vps: create, stop and delete; discover, attach and detach; auto-attach; a tenant network with its base firewall and a rule; and a create DigitalOcean refuses for capacity.

The storage tests cover the signer (`tests/provider-digitalocean-sigv4.test.ts`, on AWS's published vectors), the S3 client and the BlobStore (`-spaces-s3`, `-spaces-blob-store`), the kinds (`-spaces-keys`, `-spaces-buckets`, `-cdn`, `-registry-kinds`) and the DOCR image source (`-docr-image-source`). They run against `tests/support/spaces-emulator.ts`, which checks every SigV4 signature with its own canonicalization, and against the Spaces Keys, CDN and registry modules in `tests/support/do-emulator/` (`spaces-keys.ts`, `cdn.ts`, `registry.ts`, which the tests register). How Spaces answers a `HEAD` on another account's bucket (403) and on a bucket in another region (301), the CDN's one-endpoint-per-origin rule, and the registry's redirect of blobs to presigned storage (and its host, which `blobHosts` defaults to `*.digitaloceanspaces.com`) are **unverified** until the storage live suite checks them.

`tests/live/digitalocean-storage.live.test.ts` is that suite. It is off unless `BC_DO_LIVE`, `BC_DO_TOKEN`, `BC_DO_SPACES_ACCESS_KEY` and `BC_DO_SPACES_SECRET_KEY` are all set. It creates a bucket, a Spaces key and a CDN endpoint, all named `bc-live-<hex>-…`, and sweeps them afterwards. On an account without Spaces, the first bucket starts the Spaces subscription, which is billed monthly. It checks:

- the 403 and 301 `HEAD` answers;
- that a key's `<bucket>:readwrite` grant reaches the bucket, through `spacesBlobStore` with the new key;
- that DigitalOcean refuses a second endpoint for one origin;
- with `BC_DO_LIVE_REGISTRY=1`, a registry create, discover and delete;
- with `BC_DO_LIVE_IMAGE=oci://…` (a disk image already pushed), that the presigned layer URL is fetchable without credentials.

A pass also confirms the storage token scopes in the table above. **It has not been run yet.**

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
