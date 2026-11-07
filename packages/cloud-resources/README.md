# @better-compute/cloud-resources

Managed data and platform services on provider accounts for better-compute: managed databases, vector databases,
apps, functions, add-ons and the rest of a provider's long tail, through one governed, audited and metered API
(`cloudResources.*`) instead of a module per service.

A provider serves the long tail through one optional, provider-neutral contract in `@better-compute/core`:

```ts
interface ProviderResources {
  kinds(): readonly ProviderResourceKind[]; // do.database.pg, do.app, … with a manifest per kind
  ensure(request: ProviderResourceRequest, ctx: CallContext): Promise<ProviderResourceState>;
  get(kind: string, id: string, ctx: CallContext): Promise<ProviderResourceState | undefined>;
  delete(kind: string, id: string, ctx: CallContext): Promise<ProviderResourceState>;
  discover?(kind: string, ctx: CallContext): AsyncIterable<ProviderDiscoveredResource>;
  adopt?(
    kind: string,
    id: string,
    labels: Record<string, string>,
    ctx: CallContext,
  ): Promise<ProviderResourceState>;
  release?(kind: string, id: string, ctx: CallContext): Promise<void>;
  catalog?(ctx: CallContext): Promise<readonly ProviderCatalogEntry[]>;
  signals?(ctx: CallContext): Promise<readonly ProviderResourceSignal[]>; // read-only
}
```

`ensure` and `delete` are idempotent and non-blocking. Secret outputs (database passwords, access keys) are
handed back once and sealed into the SecretStore by this module in the run that received them; only `SecretRef`s
are stored or returned.

## The module

```ts
import { cloudResources } from '@better-compute/cloud-resources';
import { digitalocean } from '@better-compute/provider-digitalocean';
import { vps } from '@better-compute/vps';

const providers = [digitalocean];
betterCompute({
  modules: [
    vps({ providers }),
    cloudResources({ providers, maxPerKind: 20, kindMeters: ['do.database.pg.node.hours'] }),
  ],
});
```

- **API:** `cloudResources.kinds`, `catalog`, `signals`, `create`, `list`, `get`, `update`, `delete`, `discover`,
  `adopt` and `release`, on a provider pool the tenant owns or is offered. Discover, adopt and release work only on
  the tenant's own account.
- **Catalog.** `cloudResources.catalog` lists the installable applications the pool's provider offers
  (`ProviderResources.catalog`; DigitalOcean's 1-Click apps), optionally by `installsOn`: `instance` (the slug is
  an instance create's image) or `kubernetes` (an add-on of a managed cluster). Read-only: they are installed
  through those surfaces, never through `create`.
- **Signals.** `cloudResources.signals` lists the read-only signals the pool's provider raises about its resources
  (`ProviderResources.signals`; DigitalOcean's Managed Agents Signals), newest first, at most 500, for an attention
  list. A tenant of a shared pool sees the signals about its own resources only; the pool's owner sees every one,
  recorded or not. The provider is asked with no transaction open and sends no mutation; malformed signals are
  dropped, and titles and details are one bounded line. One answer of a provider account is reused for 30 seconds,
  whichever tenant asked, so no tenant can spend the account's request budget by asking again and again.
- **IAM** on `cloud-resource/{id}` (`compute:cloud-resources:create|read|update|delete`) with the attributes `kind`,
  `family`, `provider`, `providerAccountId`, `poolId`, `region` and `projectId`: `resource.family == 'data'`
  allows databases without allowing apps.
- **Desired state.** `update` changes a kind's `updatable` fields in place and refuses any other change
  (`replaceRequired`). `delete` removes the resources living in one (database users, pools) first; a child whose
  create raced the parent's delete is deleted too, so a parent never waits on one forever.
- **One provider resource, one cloud resource.** A kind with a parent may declare a pure `identity(spec)` (a
  database user's name; `firewall` for a cluster's single firewall): a second live resource of the kind with the
  same identity in one parent is `CONFLICT` (`reason 'identity'`). A row the provider answers an id for that another
  live row already records goes to `error` instead.
- **Nothing the provider made is forgotten.** The provider id an `ensure` answers is recorded whatever state it
  reports (an app whose first deployment failed still has to be deleted). A resource deleted before the provider
  was ever asked is finished with no provider call; one whose `ensure` was sent (`ensure_sent_at`) but never
  answered (a timeout after the provider accepted the create) is looked up first through the optional
  `ProviderResources.find`, and deleted when found; a provider without `find` keeps it in `error` rather than guess.
  A create answered after another run finished the row brings the row back to be deleted (`deleting`, reason
  `late-create`). vps refuses to delete a provider account or a network a live resource uses
  (`liveCloudResources`; the networks a spec names are kept in `network_ids`).
- **Adoption** takes the resource over in its first run, whatever its version (a description change before it
  does not count); its spec stays the provider's (observed) until the tenant changes it. A spec change before the
  takeover is `INVALID_STATE` (`adopting`). One deleted or released before the takeover completed (or after it
  failed) is let go here (`released`) with no provider call. An adopted resource bills from its first `ready`.
- **Whose account.** Every `ensure` says `accountScope: 'tenant'` on the tenant's own (BYO) account and
  `'shared'` on a hosted pool. A kind names the spec fields that reach account-wide objects (a VPC, a registry,
  linked repositories, another resource by name) through its pure `accountWide(spec)`: on a shared account
  `create` and `update` refuse such a spec (`INVALID_INPUT`, `reason 'accountWide'`) before anything is
  recorded, and `ensure` refuses it again. A spec may instead name better-compute instances (a database's trusted
  instances), through the kind's pure `instances(spec)`: each must be a live instance of the tenant on the same
  provider account (`INVALID_INPUT`, `reason 'instance'`), and the provider maps it to its own handle (DigitalOcean:
  the Droplet's instance tag), so it is safe on a hosted pool.
  Likewise a spec may name tenant networks (a database joining a private network) through the kind's pure
  `networks(spec)`: each must be a live network of the tenant on the same provider account, and not an adopted VPC
  shared with other tenants' machines unless the account is the tenant's own (`INVALID_INPUT`, `reason 'network'`).
  The reconciler checks them again before every `ensure` and hands the provider each one's provider-side name
  (`networks` on the request); a provider never trusts a bare network id.
- **Secrets in a spec** are SecretRefs, resolved only within the resource's tenant, just before the provider call.
- **Quota** per tenant and kind: `maxPerKind` (default 20) and `quotas: { 'do.database.pg': 5 }`.
- **Capacity quota bookings.** A kind may declare a pure `quota(spec)`: what the spec books against the tenant's
  quota on the pool (`{ gpu: 2 }` for a DigitalOcean Dedicated Inference endpoint), with no node to place it on.
  `create` books it in the transaction that records the resource and `update` re-books the difference (growth is
  charged, `QUOTA_EXCEEDED` refuses and leaves nothing behind; a shrink is kept until the provider reports the new spec
  `ready`, then the reconciler returns it, so what still runs stays booked). The whole booking is returned
  once, when the resource is deleted or released. The bookings live in vps (`vps/0108_quota_bookings`, over
  capacity's quota charges). A kind that books quota cannot be adopted (`UNSUPPORTED`, `reason 'quotaBooked'`).
- **Events** `cloud.resource.*` (`created`, `ready`, `updating`, `updated`, `failed`, `deleting`, `deleted`,
  `adopted`, `releasing`, `released`), never carrying a secret value.
- **Metering** (`cloud.resources.usage`, every 5 minutes): `cloud.resource.hours`, one per resource per hour from
  the provider's first acceptance until it is deleted or released, billed to the resource's tenant as
  `cloud-resource` usage windows (tags `pool`, `provider`, `region`, `project` and `source` = the kind). It is
  the managed-resource fee, recorded on hosted and BYO pools alike; a pool whose billing mode is `none` records
  none. A resource living in another (a database user, pool, firewall or replica) bills no fee of its own. A
  kind's own meters (`do.database.pg.node.hours`, …) bill at the rate the provider last reported
  (`ProviderResourceState.usage`, kept in `meter_rates`), but only those named in `kindMeters`: better-iam prices
  only meters it defines (100 per tenant), so define them there first. What the provider charges reaches a hosted
  tenant through the account's cost pass-through rules.
- **Migrations** `cloud-resources/0001_resources` (one `cloud_resources` table), `0002_metering` (the
  watermark, the rates, and `cloud-resource` appended to the usage source CHECK; selfCheck
  `cloud-resources.usage-source` reports a later migration that dropped it) and `0003_identity` (`identity`, its
  unique index under a parent, and `spec_changed`), `0004_ensure_sent` (`ensure_sent_at`) and `0005_network_ids`
  (`network_ids`, GIN-indexed).

## Conformance

Every implementation runs the same cases. They live in `@better-compute/vps` (next to `providerConformance`), so a
provider package runs them from its own tests without depending on this module, which re-exports them:

```ts
import { providerResourcesConformanceCases } from '@better-compute/vps';

for (const test of providerResourcesConformanceCases())
  it(test.name, () =>
    test.run({ provider, config, kind: 'do.database.pg', spec, updatedSpec, replaceSpec }),
  );
```

A provider with `signals` also runs `providerResourcesSignalsConformanceCases()` (`@better-compute/vps`): listing
sends only reads (given the emulator's `requests`), every signal is well formed and about a kind the provider lists,
and with `withoutPreviews` a provider that holds signals behind previews refuses with `UNSUPPORTED` (`preview`) and
sends nothing.

## License

Apache-2.0
