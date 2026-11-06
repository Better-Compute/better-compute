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
| `allowSpot`         | Accepted, default `false`; reserved for Spot capacity, which P1 does not create (see [Machines](#machines)).                                  |
| `discoverTag`       | A tag: discovery yields only Droplets that carry it. Lower-case `[a-z0-9:_-]`, at most 255 characters (else `INVALID_CONFIG`, `discoverTag`). |
| `previews`          | Default `false`. Offer products DigitalOcean still marks as previews: the Managed Agents kinds and Signals (see [AI platform](#ai-platform)). |

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
is accepted only on the tenant's own account and cannot change in place. Not modelled yet: Standard and Advanced
editions, a tenant network (`net_…`) as a cluster's VPC and Vector Databases. The 1-Click body follows the API
reference too.

## AI platform

The AI kinds (family `ai`) ride the same `resources` dispatcher. Ownership is by tags where DigitalOcean has them
(dedicated inference, knowledge bases) and by the name suffix `-bc<deployment hash>` where it does not (model access
keys, guardrails, the Managed Agents objects; `resources/kinds/named.ts`).

- **Dedicated Inference:** `do.dedicated-inference` serves a model slug on one GPU size, between `replicas` (always
  running) and `maxReplicas`; only those two change in place. The kind declares `quota`: GPUs per replica times
  `max(replicas, maxReplicas)`, which the cloud-resources module books against the tenant's GPU quota on the pool
  (`QUOTA_EXCEEDED` refuses a create or a scale-up; delete returns it; adopt is refused with `quotaBooked`). It
  reports `gpu.<model>.hours` (`gpu.h100.hours`, …), which bill once the host names them in
  `cloudResources({ kindMeters })`. A `vpc` is account-wide.
- **Model access keys:** `do.inference-key`, the bearer for serverless and dedicated inference. The key is a secret
  output only (sealed by the module); raising `rotation` regenerates it, and a create whose answer was lost
  regenerates the key it finds, so an unsealed secret is never live. Name: `<name>-r<rotation>-bc<hash>`. A key
  reaches the whole account, so it is accepted only on the tenant's own account (`accountWide` on a shared one).
- **Inference proxy:** `inferenceProxy({ record, endpoint?, fetch?, log? })` forwards `/v1/chat/completions`,
  `/v1/completions` and `/v1/embeddings` to `https://inference.do-ai.run` with the tenant's resolved key and hands each
  answer's token counts (and the caller's `meta`) to `record`, which the host writes as `ai.inference.tokens`.
  Wiring it to a route is the host's: the server does not import providers.
- **Knowledge bases:** `do.knowledge-base`, an embedding model (uuid) over `webSources` and `spacesSources`,
  indexed into an OpenSearch database DigitalOcean makes (or `database`). Sources change in place (added and removed,
  then one indexing job); Spaces sources, `database` and `vpc` are account-wide. Delete leaves the database.
- **Guardrails:** `do.guardrail` (`type` jailbreak, sensitive-data or content-moderation; `defaultResponse` and
  `description` change in place). No agents are deployed through the deprecated ADK (DO-D21).
- **Managed Agents (previews):** `do.agent-harness` (a model, `instructions`, knowledge bases, guardrails and an
  action gateway, on `runtime` `container` or `microvm`; the attachments are account-wide) and `do.action-gateway`
  (https `upstreams`). Both are `preview: true`: without `previews: true` on the account every call is
  `UNSUPPORTED` (`preview`) and nothing is sent. Meters `do.agent-harness.hours` and `do.action-gateway.hours`.
- **Signals (preview):** `resources.signals` reads `GET /v2/managed-agents/signals` (read-only, the `observe` budget)
  into provider-neutral `ProviderResourceSignal`s for harness agents and gateways, at most 500; anything else, or a
  signal without a valid id or time, is dropped. `cloudResources.signals` shows them per tenant.

Token scopes: read, create, update and delete on the GenAI (Agent Platform) and Dedicated Inference resources, and on
the Managed Agents ones for the previews; the exact scope names are not confirmed yet. The bodies follow the API reference; the guardrail,
Managed Agents and Signals paths are assumed. None of them is checked against recorded responses yet: the live suite
must capture them before release.

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
