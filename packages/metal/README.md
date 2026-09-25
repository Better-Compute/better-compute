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
| rescue → deployed | `metal-unrescue` (`metal.unrescue`) | boot device disk, power cycle, wait for the OS as `node`; cleanup |

- **Steps.** Control-plane steps build the command only the control plane can build (BMC address
  and credential reference, catalog image, boot entry) and relay it with `awaitCommand`: BMC and
  boot work goes to the site agent (the boot-lease holder first), and disk and diagnostics work to
  the machine's ramdisk. Profiles may still write them as `{ use: 'power.setPower', on: 'site' }`.
- **Site agent failover.** BMC commands are re-routable across the site's agents (`awaitCommand`
  `reroutable`). What the old agent ran stands, so a power cycle is never sent twice, and commands
  it never received move to the new agent. Boot entries go to the new boot-lease holder, which
  serves the machine still waiting in PXE once the old lease expires (the §16 v0.2 exit: within
  30 s).
- **Images.** `deploy.deploy` writes only catalog images whose signature still verifies (unsigned,
  revoked-signer or tampered images are refused); `metal({ images })` passes the verifier.
- **Unrescue.** The node stays in `rescue` while `metal-unrescue` runs, and becomes `deployed` only
  once the installed OS rejoined; a failure fails the node with maintenance on.
- **Doctor findings** (`selfCheck`): failed machines waiting in maintenance, with their codes; and
  machines in a workflow-driven state without an active workflow.
- **Verified wipe.** `releasing` completes only when the wipe step's result is attested: the node
  signed it (`CommandUpdate.node_sig`, stored as `commands.result_sig*`), and every disk's read-back
  passed. Otherwise the node fails with `UNVERIFIED_WIPE`, and `recover` releases it again. The
  default verifier, `nodeSignedResults()`, rebuilds the signing input from the stored row and
  checks it with pki's `verifyNodeStatement` against `node_certs` (`pkiNodeSignatureCheck`), so a
  gateway can neither forge nor alter a wipe result. `acceptIngestedAttestation` is for tests only.
- **Dedicated-root leases** (v0.5, `binding: 'node'`). This is level-triggered with capacity
  through rows. A due node-binding allocation on a ready node of a `policy.tenantRoot` pool starts
  the lease: trust becomes `tenant-controlled`, the platform identity is revoked, and the lessee's
  profile (`reservations.request.node`) deploys in the lessee's tenant. When it completes, metal
  marks the allocation bound and wakes `capacity.reservations`. When capacity releases the
  allocation, `metal-tenant-root-release` runs:
  1. power off, then revoke the tenant's identity;
  2. boot the platform ramdisk and run an attested secure erase;
  3. DCGM level 1;
  4. check firmware against `policy.firmwareBaseline` (drift fails with maintenance on);
  5. start a new identity generation and return to `platform` trust;
  6. power off, then `ready`.

  A lessee's `node-tenant` certificate can never attest a result.
- **BMC password rotation** (`metal.rotateBmcCredential`) is two-phase (`bmc_credential_versions`).
  1. A generated password is sealed in the SecretStore, and a pending version refers to it.
  2. `bmc.rotate` sends only refs. The site agent fetches the value as a JWE, applies it through the
     driver's `management.rotateCredential`, logs in with it, and signs the result.
  3. Only a site-signed `verified: true` makes the version current. That also rewrites the node's
     credential refs, and superseded secrets are deleted once no open command names them.
  4. On failure the old credential stays current, the failed version keeps its secret, and the node
     gets `BmcCredentialRotated=False`.

  The tenant-root teardown rotates after fencing the tenant, and a failed rotation quarantines the machine.
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

## Destructive-command batches (PLAN.md §13, the v1.0 quorum)

Wipes, image writes, kexec and the BMC's power, boot, storage, firmware and credential operations
(and `site.httpProxy`) are destructive. With approvers set, the command queue sends them only under
an approved batch, whose scope lists every (subject, kind) leaf before anything runs:

- **Subjects.** A leaf's subject is the node for work it runs on itself (`disk.wipe`,
  `deploy.image`, `boot.kexec`). A BMC operation is `bmc:<site agent>/<BMC address>`, with one leaf
  per site agent of the site, because a site agent failover reroutes the command. `site.httpProxy`
  is `node:<target>`. See `batchSubject` and `metalBatchScope`.
- **Kinds.** The kinds come from the workflow's profile: agent steps' `command`, and every relaying
  step's `sends` (the engine refuses anything else), recorded as `workflows.command_kinds`.
- **One node.** When the metal reconciler starts a workflow and the node is not under a bulk batch,
  the workflow gets a one-node batch of its own before any step sends anything.
- **Many nodes.** `metal.bulk({ tenantId, poolId, verb, nodeIds, wipe?, reason })` applies
  `manage`, `inspect`, `provide`, `undeploy`, `rescue` or `retire` to up to 10,000 nodes of one
  pool as one batch, so operators approve "retire these 412 machines" once.
  - It is decided on the pool, and each node as its own `metal/<verb>` call.
  - The scope covers the verb's whole chain of workflows (`verbChain`, e.g. inspecting →
    commissioning).
  - The batch is parked on the nodes (`metal_nodes.batch_id`) until each rests.
  - The answer is `{ batch: { batchId, held, required, size }, nodes }`.
- **Plugin steps.** A plugin step that relays commands (`httpViaSite`) must declare them, for
  example `sends: ['site.httpProxy']`. Otherwise its commands fall outside the batch and are
  refused.

License: Apache-2.0.
