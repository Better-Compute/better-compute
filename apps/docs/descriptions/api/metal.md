The metal group enrolls machines by their BMCs and moves them through the provision state machine: inspect, commission, deploy, rescue, release and retire. Each verb checks the move against the provision state table, records it in one transaction and queues the metal reconciler, which runs the workflow of the new state; no verb touches the machine itself. Every method returns the node's metal view, which reports whether BMC credentials are set but never returns them. See [Bare metal](/docs/guides/bare-metal) and [BMC drivers and credentials](/docs/guides/bare-metal/bmc).

## enroll

Creates a metal node from a BMC address, driver and credentials in the given pool, in provision state `enrolling`, and queues the reconciler to verify BMC access and inspect the machine out of band.

- Decided as `compute:nodes:provision` on the pool, since the node does not exist yet.
- `bmc.credentials` is a `secret://` reference or an inline username and password. Inline credentials go to the secret broker before anything is written, and only the reference is stored; without a secret broker they are `INVALID_CONFIG`.
- The node's driver bindings come from the BMC (power, management, virtual media), then the hardware profile (`hardwareProfile`, else the pool's `policy.hardwareProfile`). An unknown hardware profile is `INVALID_INPUT`.
- `NOT_FOUND` when the pool does not exist or the tenant does not own it; `INVALID_INPUT` when the pool is not in `siteId`.

Each call creates a new node; there is no idempotency key. Publishes `node.enrolled`.

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
