# @better-compute/metal

Bare metal for better-compute: enroll, inspect, commission, deploy, release and rescue machines
through their BMCs and network boot (PLAN.md §3.5, §11). It depends on `@better-compute/core`,
`@better-compute/protocol`, `@better-compute/inventory` and `@better-compute/provision`.

**Status: v0.2 control plane.**

- Implemented: the `metal` API group, the metal reconciler, the steps and profiles of every
  provision state, and the site and ramdisk command kinds.
- Still to come: the agent-side drivers (redfish, ipmi, ipxe, image-stream, kexec). They run in
  `bcd site` and `bcd ramdisk`, which are Go.

## How a machine moves (PLAN.md §3.5, §11.1)

```ts
const bareMetal = metal({ hardwareProfiles: { 'gpu-redfish': { drivers: { boot: 'ipxe', deploy: 'image-stream' } } } });
const compute = betterCompute({ modules: [provisionModule({ modules: [bareMetal] }), bareMetal], ... });
```

- **Verbs.** Every verb checks the move against core's provision state table, records it, and
  queues the `metal` reconciler (sharded by node) in the same transaction.
  - `metal.enroll` stores inline BMC credentials through `ctx.secrets` at once and keeps only the
    `secret://` reference; they are never echoed. It creates the node in `enrolling`, with driver
    bindings from the pool's `policy.hardwareProfile` and the BMC binding for `power`,
    `management` and `virtual-media`.
- **Reconciler.** For each workflow-driven state it starts that state's workflow with
  `owner: 'metal'` (the engine wakes the reconciler when it ends). It then applies `complete`, or
  `fail` (setting `failedFrom`, with maintenance on). So
  `enrolling → inspecting → commissioning → ready` chains on its own.

| State         | Workflow (profile)        | Steps                                                                   |
| ------------- | ------------------------- | ----------------------------------------------------------------------- |
| enrolling     | `metal-enroll`            | `power.getPower`, `inspect.oob` (finds the PXE MACs)                    |
| inspecting    | `metal-inspect`           | `metal.ensureRamdisk`, `inventory.refresh`                              |
| commissioning | `metal-commission`        | ensure ramdisk, `diag.dcgm{2}`, `disk.wipe{quick}`, power off; cleanup |
| deploying     | the tenant's profile      | e.g. §11.4 profile 2, ending in `boot.kexec` (`await: 'rejoin'`)       |
| releasing     | `metal-release`           | ensure ramdisk, `disk.wipe{undeploy's mode}`, power off; cleanup        |
| retiring      | `metal-retire`            | crypto-erase, power off, `metal.revokeIdentity`; cleanup                |
| rescue        | `metal-rescue`            | ensure ramdisk                                                          |

- **Steps.** Control-plane steps build the command only the control plane can build (BMC address
  and credential reference, catalog image, boot entry) and relay it with `awaitCommand`: BMC and
  boot work goes to the site agent (the boot-lease holder first), and disk and diagnostics work to
  the machine's ramdisk. Profiles may still write them as `{ use: 'power.setPower', on: 'site' }`.
- **Verified wipe.** `releasing` completes only when the wipe step's result is attested
  (`verifyAttestation`, where pki's `node_sig` check plugs in). Otherwise the node fails with
  `UNVERIFIED_WIPE`; `recover` releases it again.
- **`metal.power`** sends `bmc.power` to the site agent directly. It is refused while a
  workflow controls the node.
- **Recovery.** `recover` follows `metalRecoverTargets`: a failed deploy recovers into
  `releasing`, which wipes before `ready`.
- **Command kinds** (`metalCommandKinds`):
  - site agent: `bmc.query`, `bmc.boot`, `bmc.power` (destructive), `boot.prepareRamdisk`,
    `boot.cleanUp`;
  - ramdisk: `diag.dcgm` (attested), `disk.wipe` (attested, destructive), `deploy.image`
    (destructive), `boot.kexec` (self-terminating).

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
const modules = [metal({ hardwareProfiles: { 'gpu-host': gpuHost } })];
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
