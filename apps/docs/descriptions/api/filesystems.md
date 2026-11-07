Filesystems are shared filesystems on a tenant [network](/docs/reference/api/networks) that the network's instances mount at boot: `nfs`, an elastic NFS filesystem across every zone of the network (Amazon EFS on AWS), or `lustre`, a Lustre filesystem in one zone for training scratch and checkpoints (Amazon FSx for Lustre). Like [firewall rules](/docs/reference/api/firewall-rules) they belong to a network and are decided on it: reading them takes `compute:networks:read`, changing them `compute:networks:update`. The provider must support filesystems (AWS does; another provider is `UNSUPPORTED`). The calls record what the tenant wants and return at once. The `vps.filesystems` reconciler then makes the filesystem at the provider once its network has been ready, behind its own security group that admits only the network's machines, and always encrypted at rest. `state` shows where it is: `pending`, `ready`, `deleting`, `deleted` or `error` (with a `message`); an `error` is retried every five minutes. Once ready, `mount` says how a machine mounts it (`fstype`, `source`, `options`): DNS names and mount names, never a secret.

Instances mount filesystems with `instances.create({ networkId, filesystems: [{ filesystem, path }] })`: ready filesystems of the instance's own network, at most 16, each at an absolute path of plain segments outside the system directories (`/etc`, `/usr`, `/var` and the like). The provider renders the mounts into the machine's user data, before the tenant's own part, with `nofail`, so a missing filesystem never blocks a boot.

The provider-side name of a filesystem is `bc-` and its id, lower-cased. A filesystem the provider holds under that name that better-compute did not make is never adopted or deleted (`error`). Events are published on the network: `network.filesystem.created`, `ready`, `error`, `deleting` and `deleted`, with `networkId` and `filesystemId`.

## create

Records a filesystem `pending` on the network and returns it.

- `kind` is `nfs` or `lustre`. An `nfs` filesystem is elastic and spans every zone of the network (a mount target in each zone that has a subnet): it takes no `sizeGiB`, `deployment` or `zone` (`INVALID_INPUT`).
- A `lustre` filesystem takes `sizeGiB` (AWS: 1200, or a multiple of 2400; default 1200), `deployment` (`scratch`, the default, or `persistent`) and `zone` (one of the account's zones with a subnet of the network; default the account's first). A size or zone the provider can never make is `INVALID_INPUT` and nothing is recorded.
- The name is unique in the network (`CONFLICT`); the name of a deleted filesystem is free again. A network has at most 8 filesystems that are not deleted (`QUOTA_EXCEEDED`, with the cap in `details.limit`).
- A network being deleted is `INVALID_STATE`; an adopted network (`networks.adopt`) is `INVALID_INPUT`: mount targets need subnets better-compute made.
- Idempotent: the same request under the same `idempotencyKey` returns the filesystem; another request under the key is `CONFLICT`.

## list

Returns the network's filesystems that are not deleted, sorted by name.

## get

Returns one filesystem of the network.

## delete

Marks the filesystem for deletion and returns it `deleting` with `version` bumped; the reconciler removes the mount targets or file servers, the filesystem and its security group, without a final backup. A filesystem that an instance (not deleted) mounts is `INVALID_STATE` with `details.instanceIds`. Deleting one that is being deleted returns it unchanged. A network with filesystems that are not deleted cannot be deleted (`networks.delete` is `INVALID_STATE` with `details.filesystemIds`).
