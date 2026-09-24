# @better-compute/vps

VPS instances for better-compute: VMs on platform hosts through runtime drivers, and machines from
external providers (PLAN.md §3.6). It depends on `@better-compute/core`,
`@better-compute/protocol` and `@better-compute/provision`.

**Status: P0 stub.**

- `defineProvider` is implemented.
- The `runtime` driver kind is a frozen contract type.
- `vps()` throws `NOT_IMPLEMENTED` ("VPS arrives in v0.3").
- Arriving in v0.3: instance lifecycle, flavors, IPAM, the `instances`, `flavors` and
  `providerAccounts` API groups, and `providerConformance`.

```ts
import { field, manifest } from 'better-compute/core';
import { defineProvider, vps } from 'better-compute/vps'; // also merges the runtime driver kind

export const acmeCloud = defineProvider({
  id: 'acme-cloud',
  version: '1.0.0',
  provides: ['vps'],
  config: manifest({ token: field.secret().describe('API token') }),
  create: (config, context) => createAcmeClient(config, context), // returns a ProviderImpl
});

const modules = [vps({ runtimes: ['libvirt-kvm'] })]; // NOT_IMPLEMENTED until v0.3
```

## `defineProvider`

`defineProvider(provider)` returns a frozen `ProviderDefinition` stamped with
`extension: 'provider'`.

- The definition is code. Each provider account is data, validated by `config`.
- The definition is checked up front:
  - the id and version must be well formed;
  - `provides` is `metal`, `vps` or both;
  - `config` must be a Standard Schema;
  - `create` must be a function;
  - unknown fields are rejected.
- Errors are `ComputeError('INVALID_CONFIG')`, with `details.path` naming the field.

## The `runtime` driver kind

Importing this package merges the `runtime` kind into `DriverKinds` of `@better-compute/core`.

A `RuntimeDriver` has these members:

- `traits`: isolation `vm`, `microvm` or `container`; whether it is multi-tenant; GPU passthrough;
  and the image formats it boots.
- `list()`, `apply(spec)`, `reboot(id)`, `remove(id)`, and an optional `console(id)`.

The daemon's `instances` converger calls them. The API only changes `desiredState`.

## Re-exports

These contracts are declared in `@better-compute/core` and re-exported here as types:
`ProviderDefinition`, `ProviderInput`, `ProviderImpl`, `ProviderContext`, `CallContext`, `Offer`,
`OfferQuery`, `ExternalMachine`, `RescueAccess`, `ImageRef`, `Flavor`, `Instance`, `InstanceSpec`,
`InstanceState` and `InstanceDesiredState`.

License: Apache-2.0.
