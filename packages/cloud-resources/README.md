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
