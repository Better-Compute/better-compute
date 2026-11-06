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
betterCompute({ modules: [vps({ providers }), cloudResources({ providers, maxPerKind: 20 })] });
```

- **API:** `cloudResources.kinds`, `create`, `list`, `get`, `update`, `delete`, `discover`, `adopt` and
  `release`, on a provider pool the tenant owns or is offered. Discover, adopt and release work only on the tenant's
  own account.
- **IAM** on `cloud-resource/{id}` (`compute:cloud-resources:create|read|update|delete`) with the attributes `kind`,
  `family`, `provider`, `providerAccountId`, `poolId`, `region` and `projectId`: `resource.family == 'data'`
  allows databases without allowing apps.
- **Desired state.** `update` changes a kind's `updatable` fields in place and refuses any other change
  (`replaceRequired`). `delete` removes the resources living in one (database users, pools) first.
- **Quota** per tenant and kind: `maxPerKind` (default 20) and `quotas: { 'do.database.pg': 5 }`.
- **Events** `cloud.resource.*` (`created`, `ready`, `updating`, `updated`, `failed`, `deleting`, `deleted`,
  `adopted`, `releasing`, `released`), never carrying a secret value.
- **Migration** `cloud-resources/0001_resources` (one `cloud_resources` table).

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
