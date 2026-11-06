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

- **API:** `cloudResources.kinds`, `catalog`, `create`, `list`, `get`, `update`, `delete`, `discover`,
  `adopt` and `release`, on a provider pool the tenant owns or is offered. Discover, adopt and release work only on
  the tenant's own account.
- **Catalog.** `cloudResources.catalog` lists the installable applications the pool's provider offers
  (`ProviderResources.catalog`; DigitalOcean's 1-Click apps), optionally by `installsOn`: `instance` (the slug is
  an instance create's image) or `kubernetes` (an add-on of a managed cluster). Read-only: they are installed
  through those surfaces, never through `create`.
- **IAM** on `cloud-resource/{id}` (`compute:cloud-resources:create|read|update|delete`) with the attributes `kind`,
  `family`, `provider`, `providerAccountId`, `poolId`, `region` and `projectId`: `resource.family == 'data'`
  allows databases without allowing apps.
- **Desired state.** `update` changes a kind's `updatable` fields in place and refuses any other change
  (`replaceRequired`). `delete` removes the resources living in one (database users, pools) first.
- **Whose account.** Every `ensure` says `accountScope: 'tenant'` on the tenant's own (BYO) account and
  `'shared'` on a hosted pool. A kind names the spec fields that reach account-wide objects (a VPC, a registry,
  linked repositories, another resource by name) through its pure `accountWide(spec)`: on a shared account
  `create` and `update` refuse such a spec (`INVALID_INPUT`, `reason 'accountWide'`) before anything is
  recorded, and `ensure` refuses it again.
- **Secrets in a spec** are SecretRefs, resolved only within the resource's tenant, just before the provider call.
- **Quota** per tenant and kind: `maxPerKind` (default 20) and `quotas: { 'do.database.pg': 5 }`.
- **Events** `cloud.resource.*` (`created`, `ready`, `updating`, `updated`, `failed`, `deleting`, `deleted`,
  `adopted`, `releasing`, `released`), never carrying a secret value.
- **Metering** (`cloud.resources.usage`, every 5 minutes): `cloud.resource.hours`, one per resource per hour from
  the provider's first acceptance until it is deleted or released, billed to the resource's tenant as
  `cloud-resource` usage windows (tags `pool`, `provider`, `region`, `project` and `source` = the kind). It is
  the managed-resource fee, recorded on hosted and BYO pools alike; a pool whose billing mode is `none` records
  none. A kind's own meters (`do.database.pg.node.hours`, …) bill at the rate the provider last reported
  (`ProviderResourceState.usage`, kept in `meter_rates`), but only those named in `kindMeters`: better-iam prices
  only meters it defines (100 per tenant), so define them there first. What the provider charges reaches a hosted
  tenant through the account's cost pass-through rules.
- **Migrations** `cloud-resources/0001_resources` (one `cloud_resources` table) and `0002_metering` (the
  watermark, the rates, and `cloud-resource` appended to the usage source CHECK; selfCheck
  `cloud-resources.usage-source` reports a later migration that dropped it).

## Conformance

Every implementation runs the same cases:

```ts
import { providerResourcesConformanceCases } from '@better-compute/cloud-resources';

for (const test of providerResourcesConformanceCases())
  it(test.name, () =>
    test.run({ provider, config, kind: 'do.database.pg', spec, updatedSpec, replaceSpec }),
  );
```

## License

Apache-2.0
