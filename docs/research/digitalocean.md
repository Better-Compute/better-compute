# DigitalOcean API: verified facts for the provider (P0 spike)

**What this is.** These are the facts that program plan
[`2026-10-18-digitalocean-program.md`](../superpowers/plans/2026-10-18-digitalocean-program.md) and the P1 plan
depend on. They were gathered on 2026-10-18.

**Sources.** DigitalOcean's published OpenAPI specification (`github.com/digitalocean/openapi`, `specification/`,
shallow clone of `main` on 2026-10-18), the API reference, and the release notes. No live account was used (the
user chose a docs-only spike).

**Status labels**

- **spec:** stated in the OpenAPI spec or the docs.
- **unverified:** not documented. The provider handles both outcomes, and P1's opt-in live suite
  (`tests/live/digitalocean.live.test.ts`) settles it.

The fixtures built from these facts live in `tests/fixtures/digitalocean/`. Each file's `_provenance` says which
of the two labels it carries.

## S1 — Account, limits, errors

| Fact | Status | Source / value |
|---|---|---|
| Base URL `https://api.digitalocean.com/v2`, `Authorization: Bearer <token>` | spec | `DigitalOcean-public.v2.yaml` `servers`, `bearer_auth` |
| Rate limits: **5,000 requests per hour and 250 per minute** per token | spec | `shared/headers.yml` `ratelimit-limit` |
| `ratelimit-reset` is when the **oldest** request in the window expires (Unix epoch seconds). A sliding window, not a fixed reset | spec | `shared/headers.yml` |
| `ratelimit-remaining` counts the **hourly** quota | spec | `shared/headers.yml` |
| 429 body `{ "id": "too_many_requests", "message": "API rate limit exceeded." }` with the three headers | spec | `shared/responses/too_many_requests.yml` |
| Error body `{ id, message, request_id? }`. `id` is a short name for the status (`not_found`, `unprocessable_entity`, `unauthorized`, `forbidden`). `request_id` is optional | spec | `shared/models/error.yml` |
| Some endpoints send an `x-request-id` header | spec | `shared/headers.yml` |
| Pagination: `page`, `per_page` default 20, **max 200**; `links.pages.{first,prev,next,last}` hold absolute URLs; `meta.total` | spec | `shared/parameters.yml`, `shared/pages.yml`, `shared/meta.yml` |
| `links.pages` can be `{}` on the last or only page | spec | droplets examples |
| Account droplet limit field `droplet_limit` on `GET /v2/account` | spec | `resources/account` |
| Token scopes: `droplet:{read,create,update,delete,admin}`, `ssh_key:*`, `tag:{read,create,delete}`, `vpc:*`, `firewall:*`, `regions:read`, `sizes:read`, `actions:read`, `account:read`, `image:read` | spec | `/reference/api/scopes/` |

## S2 — Droplet create, state, list

| Fact | Status | Source / value |
|---|---|---|
| `POST /v2/droplets` returns **202 Accepted**. That does not mean success; `links.actions[]` carries the create action | spec | `droplets_create.yml` |
| The body (single) has `name` (pattern `^[a-zA-Z0-9]?[a-z0-9A-Z.\-]*[a-z0-9A-Z]$`, ≤ 255), `region`, `size`*, `image`* (slug or id), `ssh_keys` (ids or fingerprints), `backups`, `ipv6`, `monitoring`, `tags`, `user_data`, `vpc_uuid`, `subnet_uuid`, `with_droplet_agent`, `public_networking`, `volumes` | spec | `droplet_create.yml`, `droplet_single_create.yml` |
| A `region` prefix such as `nyc` deploys in any matching datacenter; **an omitted region deploys anywhere**. The provider always sends an exact slug | spec | `droplet_create.yml` |
| `user_data` is plain text, **≤ 64 KiB** | spec | `droplet_create.yml` |
| The tags in a create may name new or existing tags (needs `tag:create`) | spec | `shared/attributes/tags_array.yml` |
| SSH keys must already be in the account (team) before a create can embed them | spec | `droplet_create.yml` |
| Droplet `status` ∈ `new`, `active`, `off`, `archive` | spec | `droplet.yml` |
| A Droplet carries `id` (int), `created_at` (ISO 8601), `size_slug`, `region.slug`, `tags[]`, `vpc_uuid`, `subnet_uuid`, `networks.v4[]` (`ip_address`, `type: public/private`; private `gateway` may be the string `"nil"`), `networks.v6[]`, `gpu_info` | spec | `droplet.yml`, examples |
| **`GET /v2/droplets` returns only non-GPU Droplets by default.** `type=gpus` returns only GPU Droplets. `type` **can't be combined with `tag_name`** | spec | `droplets/parameters.yml#droplet_type` |
| `tag_name` and `name` are list filters | spec | `droplets_list.yml` |
| `DELETE /v2/droplets?tag_name=` and `POST /v2/droplets/actions?tag_name=` exist; **the provider never calls them** (DO-D16) | spec | `droplets_destroy_byTag.yml`, `dropletActions_post_byTag.yml` |
| Selective destroy with associated resources: `DELETE /v2/droplets/{id}/destroy_with_associated_resources/selective` (P2) | spec | `droplets_destroy_withAssociatedResourcesSelective.yml` |
| Action types: `power_on`, `power_off`, `shutdown`, `reboot`, `power_cycle`, `rebuild` (`image`), `resize`, `rename`, `snapshot`, `restore`, `password_reset`, `enable_ipv6`, `enable_backups`, `disable_backups`, `change_kernel` | spec | `droplet_actions.yml` |
| Action `status` ∈ `in-progress`, `completed`, `errored`. Actions are kept and can always be queried (`GET /v2/actions/{id}`) | spec | `actions/models/action.yml` |
| GPU size slugs look like `gpu-h100x1-80gb`, `gpu-h100x8-640gb`, `gpu-mi300x1-192gb`, `gpu-mi300x8-1536gb`. AI/ML images look like `gpu-h100x1-base` | spec / docs | droplets examples; AMD create docs |
| `gpu_info = { count, model ("nvidia_h100"), vram: { amount, unit: "gib" } }` on sizes and Droplets | spec | `sizes/models/gpu_info.yml` |
| Whether a `tag_name` list includes GPU Droplets | **unverified** | The provider assumes it may not. It also scans `type=gpus` and filters by tag on the client side, whenever the lookup can concern a GPU Droplet (the offer is a GPU size, or the call is list or discover) |
| The 422 messages for size-not-in-region, capacity, droplet limit and invalid image | **unverified** | Not in the spec. `tests/fixtures/digitalocean/errors.json` holds the messages that DO clients report in practice (`"You specified an invalid size for Droplet creation."`, `"Size is not available in this region."`, `"creating this/these droplet(s) will exceed your droplet limit"`, `"You specified an invalid image for Droplet creation."`), marked `verified: false`. An unknown 422 maps to `INVALID_INPUT` and is never retried |
| Whether a create without `ssh_keys` emails a root password | **unverified** (long-standing documented behaviour of the control panel) | It doesn't matter: DO-D7 always sends a key |
| Duplicate Droplet names are accepted | **unverified** (the name is described as "human-readable", with no uniqueness) | DO-D4 doesn't rely on names |

## S3 — Networks

| Fact | Status | Source / value |
|---|---|---|
| VPC `name`: pattern `^[a-zA-Z0-9\-\.]+$`, **unique in the account** | spec | `vpcs/models/vpc.yml` |
| VPC `description` ≤ 255 characters | spec | `vpc.yml` |
| VPC `ip_range` **can't overlap other networks in the same account**, must be RFC 1918, between **/28 and /16**. Omitted, DO picks a non-conflicting /20 | spec | `vpc.yml` (answers program Q3) |
| Each region has a `default` VPC. Default can only move to another VPC, never be unset | spec | `vpc.yml` |
| Firewall `name`: pattern `^[a-zA-Z0-9][a-zA-Z0-9\.-]+$` (uniqueness not stated) | spec | `firewalls/models/firewall.yml` |
| Firewall `status` ∈ `waiting`, `succeeded`, `failed`. `pending_changes[]` lists the Droplets still being updated | spec | `firewall.yml` |
| A rule is `{ protocol: tcp/udp/icmp, ports: "22" / "8000-9000" / **"0" = all**, action: allow/deny (default allow) }`. ICMP ports are always `"0"` | spec | `firewall_rule.yml` (the deny field shape settles the open item) |
| Inbound rules have `sources`, outbound rules `destinations`. Each is `{ addresses[], droplet_ids[], load_balancer_uids[], kubernetes_ids[], tags[] }` | spec | `firewall_rule.yml` |
| A firewall targets `droplet_ids[]` and `tags[]` | spec | `firewall.yml` |
| A Droplet with no firewall accepts everything. A firewall denies whatever its rules don't allow, in both directions | docs (Cloud Firewalls overview) | Basis of DO-D10's base firewall |
| Rule limits per firewall and firewalls per Droplet | **unverified** | A 422 maps to `QUOTA_EXCEEDED` only if its message says "limit"; otherwise `INVALID_INPUT` |
| VPC MTU | **unverified** | `ensureNetwork` refuses any `mtu` except 1500 |
| VPC Subnets (preview): Droplets carry `subnet_uuid`, and create accepts `subnet_uuid` | spec | `droplet_create.yml`; P4 |

## Tags

| Fact | Status | Source / value |
|---|---|---|
| Pattern `^[a-zA-Z0-9_\-\:]+$`, ≤ 255 characters | spec | `tags/models/tags.yml` |
| **Case stable:** the capitalization used on first creation is canonical, and API URLs must use it | spec | `tags.yml` (the codec writes lowercase only, so a tag the provider creates is lowercase-canonical) |
| Taggable: Droplets, images, volumes, volume snapshots, database clusters | spec | `tags.yml` |
| Assign with `POST /v2/tags/{name}/resources { resources: [{ resource_id: "<string>", resource_type: "droplet" }] }`; unassign with `DELETE` on the same path | spec | `tags_resource.yml` |

## SSH keys

| Fact | Status | Source / value |
|---|---|---|
| `POST /v2/account/keys { name, public_key }` | spec | `ssh_keys/models/sshKeys.yml` |
| `GET` / `DELETE /v2/account/keys/{id or fingerprint}` | spec | `ssh_keys` |
| The fingerprint is MD5, colon-separated hex (`3b:16:e4:…`) | spec | `droplet_create.yml` example |

## S4 — GPU, Spot, metal, MicroVMs

| Fact | Status | Source / value |
|---|---|---|
| Autoscale pool members: `GET /v2/droplets/autoscale/{id}/members` → `{ droplet_id, status (provisioning/active/deleting/off), health_status }` | spec | `autoscale_pools/models/member.yml` |
| Spot GPU Droplets (preview since 2026-08-10, daily variable pricing), and the field that signals a preemption | **unverified** | P3 |
| Bare Metal GPU API visibility | **unverified** (no `bare_metal` resource in the spec) | Program Q1. P3 assumes manual enrolment (DO-D17's fallback) |
| MicroVMs API (preview): `specification/resources/microvms` | spec, preview | P3 |
| The spec's resource folders match the 60 API groups in the program map | spec | `specification/resources/*` |

## Consequences for the plans (applied 2026-10-18)

1. **Lists and lookups cover GPU Droplets explicitly.**
   - `list` and `discover` page through the default list and `type=gpus`, and dedupe by id.
   - The idempotency lookup uses `tag_name`. For a GPU offer, it also scans `type=gpus` and filters by the key tag on
     the client side. GPU Droplets are few, so this is cheap.
   - P1 Tasks 5–7 carry a test for each.
2. **The firewall compiler emits `ports: "0"` for "all", never `"all"`.** ICMP rules always carry `"0"`.
3. **Firewall state:** `waiting` → `pending`, `succeeded` → `ready`, `failed` → `error` (with the message).
4. **`ensureSubnet` refuses a CIDR outside RFC 1918 or outside /16–/28 with `INVALID_INPUT`**, before any call. An
   overlap is reported by DO as a 422; it maps to `INVALID_INPUT`, `reason 'cidrOverlap'`.
5. **The budget's hourly bucket is a sliding window**, seeded from `ratelimit-remaining`. `retryAfterMs` comes from
   `ratelimit-reset`, the expiry of the oldest request.
