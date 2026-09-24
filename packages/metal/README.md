# @better-compute/metal

Bare metal for better-compute: enroll, inspect, commission, deploy, release and rescue machines
through their BMCs and network boot (PLAN.md §3.5, §11). It depends on `@better-compute/core`,
`@better-compute/protocol`, `@better-compute/inventory` and `@better-compute/provision`.

**Status: P0 stub.**

- The driver kinds and verbs are frozen contract types.
- `metal()` throws `NOT_IMPLEMENTED` ("bare-metal provisioning arrives in v0.2").
- Arriving in v0.2: the `metal` API group, the built-in drivers (redfish, ipmi, ipxe,
  image-stream, kexec) and driver composition.

```ts
import { defineDriver, field, manifest } from 'better-compute/core';
import { metal } from 'better-compute/metal'; // also merges the metal driver kinds

export const acmeBmc = defineDriver({
  id: 'acme-bmc',
  version: '1.0.0',
  runsOn: 'site',
  config: manifest({ address: field.url(), credentials: field.secret() }),
  implements: {
    power: (config) => ({ getPower: async () => 'on', setPower: async (action) => {} }),
  },
});

const gpuHost = { drivers: { power: 'redfish', management: 'redfish', boot: 'ipxe' } };
const modules = [metal({ hardwareProfiles: { 'gpu-host': gpuHost } })]; // NOT_IMPLEMENTED until v0.2
```

## Driver kinds

Importing this package merges these kinds into `DriverKinds` of `@better-compute/core` by
declaration merging. After that, `defineDriver({ implements: { power: … } })` type-checks.

| Kind            | Operations                                                   | Status           |
| --------------- | ------------------------------------------------------------ | ---------------- |
| `power`         | `getPower()`, `setPower(action)`                             | v0.2             |
| `management`    | `setBootDevice(device, { persistent, uefi })`                | v0.2             |
| `boot`          | `prepareRamdisk(spec)`, `prepareInstance(boot)`, `cleanUp()` | v0.2             |
| `deploy`        | `deploy(spec)`, `tearDown({ wipe })` (progress streams)      | v0.2             |
| `inspect`       | `inspect()` → `NodeInventory`                                | v0.2             |
| `virtual-media` | `insert(iso)`, `eject()`                                     | v0.2             |
| `console`       | `open()` → byte stream                                       | draft until v0.3 |
| `bios`          | `getSettings()`, `applySettings(settings)`                   | draft until v0.5 |
| `raid`          | `applyLayout(layout)`, `clear()`                             | draft until v0.5 |
| `firmware`      | `components()`, `update(component, image)`                   | draft until v0.5 |

`metalDriverKinds` holds the same table as data. The package also exports the supporting types:
`RamdiskSpec`, `InstanceBoot`, `DeploySpec`, `BootArtifact`, `BootDevice`, `PowerDriver`, …

## Verbs and options

- **`metalVerbs`** lists the `metal` methods of §9.2.
- **`metalVerbTransitions`** maps each method to the core `provisionStateTable` verb it applies:
  - `undeploy` applies `release`;
  - `enroll` creates a node in `enrolling`;
  - `power` changes only the power axis.
- **`MetalOptions`** takes `hardwareProfiles`: per-concern driver bindings that a pool's nodes
  inherit.

License: Apache-2.0.
