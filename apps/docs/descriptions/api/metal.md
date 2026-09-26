The metal group enrolls machines by their BMCs and moves them through the provision state machine: inspect, commission, deploy, rescue, release and retire. Each verb checks the move against the provision state table, records it in one transaction and queues the metal reconciler, which runs the workflow of the new state; no verb touches the machine itself. Every method returns the node's metal view, which reports whether BMC credentials are set but never returns them. See [Bare metal](/docs/guides/bare-metal) and [BMC drivers and credentials](/docs/guides/bare-metal/bmc).

## enroll

Creates a metal node from a BMC address, driver and credentials in the given pool, in provision state `enrolling`, and queues the reconciler to verify BMC access and inspect the machine out of band.

- Decided as `compute:nodes:provision` on the pool, since the node does not exist yet.
- `bmc.credentials` is a `secret://` reference or an inline username and password. Inline credentials go to the secret broker before anything is written, and only the reference is stored; without a secret broker they are `INVALID_CONFIG`.
- The node's driver bindings come from the BMC (power, management, virtual media), then the hardware profile (`hardwareProfile`, else the pool's `policy.hardwareProfile`). An unknown hardware profile is `INVALID_INPUT`.
- `bmc.driverOptions` is a JSON object of at most 1 KiB for the BMC driver (e.g. `{ "cipherSuite": 3 }` for older IPMI BMCs), sent on every BMC request and validated by the driver. Keys that look like credentials are `INVALID_INPUT`: credentials travel only as `bmc.credentials`.
- `addresses` are the machine's own IP literals (at most 16). In an agentless pool the site's agents can reach the machine through them at once; out-of-band inspection replaces them only when it reports some (IPMI reports none).
- A driver that cannot report MACs (IPMI) needs `macs`, or `productUuid` (the SMBIOS UUID its BMC reports). With the UUID alone, PXE discovery fills the MAC: the first boot PXE-boots the machine once with no boot entry, and its site agent lists it (see `discovered`). A firmware placeholder UUID (all zeros, all ones, `03000200-0400-0500-0006-000700080009`) cannot stand in for the MACs.
- `NOT_FOUND` when the pool does not exist or the tenant does not own it; `INVALID_INPUT` when the pool is not in `siteId`.

Each call creates a new node; there is no idempotency key. Publishes `node.enrolled`, and `node.pxe-mac.discovered` when a site agent had already seen the machine.

## manage

Moves a `ready` node back to `enrolling` to re-verify BMC access; the reconciler then chains re-inspection and re-commissioning back to `ready`.

`INVALID_STATE` from any state but `ready`, `NOT_FOUND` when the tenant has no such metal node, and `CONFLICT` when the node changed concurrently. Publishes `node.provision.enrolling`.

## inspect

Moves a `ready` node to `inspecting`, where the machine boots the ramdisk and reports its inventory; commissioning follows, and the node returns to `ready`.

`INVALID_STATE` from any state but `ready`; `CONFLICT` when the node changed concurrently. Publishes `node.provision.inspecting`.

## provide

Moves a `ready` node to `commissioning`, which runs DCGM diagnostics, a quick wipe and a power-off before the node returns to `ready`.

`INVALID_STATE` from any state but `ready`; `CONFLICT` when the node changed concurrently. Publishes `node.provision.commissioning`.

## deploy

Moves a `ready` node to `deploying` with the given profile version recorded on it; the metal reconciler then starts a workflow of that profile.

The call records `profileId` and `profileVersion` without running the profile; run `profiles.validate` first to catch problems before the workflow starts. When the workflow succeeds the node becomes `deployed` and takes the profile's `role`. `INVALID_STATE` from any state but `ready`; `CONFLICT` when the node changed concurrently. Publishes `node.provision.deploying`.

## undeploy

Moves a `deployed` or `rescue` node to `releasing`, which wipes its disks with the chosen mode and powers it off before it returns to `ready`.

`wipe` is `none`, `quick` (the default), `secure-erase` or `crypto-erase`. Unless the mode is `none`, the node reaches `ready` only when the wipe result is attested; otherwise it fails with `UNVERIFIED_WIPE`. `INVALID_STATE` from other states. Publishes `node.provision.releasing`.

## rescue

Moves a `deployed` node to `rescue`, whose workflow boots the rescue ramdisk for repairs from outside the installed OS.

`INVALID_STATE` from any state but `deployed`. On a pool with `agent: 'none'` the node fails with `UNSUPPORTED`, since such a machine cannot boot the ramdisk. Publishes `node.provision.rescue`.

## unrescue

Starts the `metal-unrescue` workflow, which boots a rescued node back into its installed OS; the node stays in `rescue` until that workflow succeeds, then becomes `deployed`.

- `INVALID_STATE` outside `rescue`.
- A second call while the unrescue workflow runs returns the node unchanged.
- `CONFLICT` while the rescue ramdisk is still booting.
- `INVALID_CONFIG` when the provision module is not registered.

Publishes `node.provision.unrescuing` with the `workflowId`. If the workflow fails, the node goes to `failed`, and `recover` returns it to `deployed`.

## abort

Stops the node's running workflow and moves the node to `failed`, recording where it failed, an `ABORTED` error with the optional `reason`, and maintenance on.

Legal from `enrolling`, `inspecting`, `commissioning`, `deploying` and `releasing`; `INVALID_STATE` otherwise. The aborted workflow still runs its cleanup steps. Publishes `node.provision.failed`.

## recover

Moves a `failed` node to the last stable point for the state it failed in: `enrolling` after enrolling, inspecting or commissioning, `releasing` after deploying or releasing, `deployed` after rescue, and `retiring` after retiring.

It clears `failedFrom` and `lastError` but leaves maintenance on. `INVALID_STATE` when the node is not `failed`. Publishes `node.provision.enrolling`, `node.provision.releasing`, `node.provision.deployed` or `node.provision.retiring`.

## retire

Moves a node to `retiring`, whose workflow crypto-erases the disks (on pools whose machines run `bcd`), powers the machine off and revokes its identity before the node becomes `retired`, which is terminal.

Legal from `adopting`, `adopted`, `enrolling`, `ready` and `failed`; `INVALID_STATE` otherwise, so undeploy a deployed machine first. Publishes `node.provision.retiring`.

## power

Queues a `bmc.power` command to the site agent of the node's site and returns its `commandId`; the provision state does not change.

- Decided as `compute:nodes:power` on the node.
- `action` is `on`, `off`, `graceful-off`, `reset`, `graceful-restart`, `cycle` or `nmi`.
- `INVALID_STATE` when the node has no BMC credentials, while it is `inspecting`, `commissioning`, `deploying` or `releasing` (a workflow controls its power then), or when no site agent serves its site.

The command expires five minutes after it is queued. Its idempotency key derives from the request id, so a retry with the same `X-Request-Id` header returns the same command.

## bulk

Runs one lifecycle verb on many nodes of a pool at once (`manage`, `inspect`, `provide`, `undeploy`, `rescue` or `retire`), as one batch; returns every node and, when the verb sends destructive commands, the batch.

- Each node is decided on its own, exactly as if the verb were called for it (`metal.<verb>`); one refusal refuses the whole call before anything changes. Every node must be in `poolId` (`INVALID_INPUT` otherwise), listed once, 1 to 10,000 of them.
- When the verb's steps send destructive commands, a quorum batch (`commandBatches`) is created over them with `reason`, and each node's commands carry it: with approver keys they wait for its approval; without, it is recorded for audit.
- `wipe` applies to `undeploy` only.

Decided as `compute:nodes:provision` on the pool, then per node.

## discovered

Lists the machines the site's agents saw PXE-booting from a MAC with no boot entry in the last 24 hours, newest first. The agents never answer or enroll them.

- Decided as `compute:sites:read` on the site, and only the tenant that owns the site sees it (`NOT_FOUND` otherwise): the list describes the site's network.
- Each machine has its `mac`, the `productUuid` its DHCP request carried (as sent: SMBIOS stores the first three fields byte-swapped), its `arch`, when it was first and last seen, a request `count` summed over agents, the DHCP `relays` it came through, and the `agentNodeIds` that saw it.
- `nodeId` names the enrolled machine with that MAC, or the one whose MAC it filled. An enrolled machine without MACs gets one only when its product UUID, in any byte order, was seen from exactly one MAC, no other machine of the site shares the UUID, and the MAC is not already enrolled. It then publishes `node.pxe-mac.discovered`.
- At most 256 machines per agent, as each agent's last status report lists them.
