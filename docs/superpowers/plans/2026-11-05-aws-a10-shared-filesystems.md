# AWS A10: shared filesystems (EFS, FSx for Lustre) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A tenant makes a shared filesystem on one of its networks and mounts it on the machines it creates there:
an NFS filesystem (Amazon EFS) for home directories, datasets and checkpoints, or a Lustre scratch filesystem (Amazon
FSx for Lustre) for training. The seam is provider neutral, so Filestore (GCP) or a DigitalOcean NFS share can implement
it later.

**Spec:** [`2026-10-18-aws-integration-program.md`](2026-10-18-aws-integration-program.md) §6 A10 ("Shared
filesystems … This is its own sub-plan") and the service table rows for EFS and FSx for Lustre. It builds on A2
(networks: the VPC, its zone subnets and the network's `bc-net-<network>` security group).

**Tech Stack:** TypeScript (ESM), `aws-core` clients (`restClient` rest-json for EFS, `jsonClient` JSON 1.1
`AWSSimbaAPIService_v20180301` for FSx), the in-process AWS emulator, vitest. No new dependencies.

---

## Decisions (defaults; the user was not available)

- **FD1 Kinds.** `nfs` (EFS, elastic throughput, general purpose, encrypted) and `lustre` (FSx for Lustre). ONTAP,
  OpenZFS and Windows stay deferred (program table, A10+).
- **FD2 Always encrypted.** EFS `Encrypted: true` and FSx's default encryption at rest; the account's `kmsKeyId`
  (when set) is the key for both. No unencrypted option exists.
- **FD3 Network scoped.** A filesystem belongs to one better-compute network. Only machines in that network reach it.
  Adopted VPCs are refused (mount targets need subnets better-compute made).
- **FD4 Its own security group.** The mount targets (EFS) or file servers (FSx) get a group `bc-fs:<name>` in the
  network's VPC. It allows NFS (tcp 2049) or Lustre (tcp 988 and 1018–1023) **from the network's group** only, plus
  Lustre from itself (FSx servers talk to each other). A colon never appears in a network name or a network tag, so
  the name cannot collide with `bc-net-…` or a tag group; the tag-group sweeper never sees it (it carries no
  `better-compute:tag`). Its rules carry `better-compute:filesystem` and no firewall key, so firewall diffing never
  touches them. The group's reference to `bc-net-<network>` keeps the network from being deleted while the filesystem
  exists (`DependencyViolation` → `pending`), which is the order wanted.
- **FD5 Mount targets per subnet.** EFS gets one mount target per zone: the network's subnet in each zone that has one
  (the first by name when a zone has several). A zone that gains a subnet later gets its mount target on the next
  ensure. FSx for Lustre is single-AZ: the spec names a zone (default: the account's first zone) and the network's
  subnet there.
- **FD6 Lustre sizes.** `SCRATCH_2` (default) or `PERSISTENT_2` (`deployment: 'persistent'`, 125 MB/s/TiB). Capacity
  is 1200 GiB or a multiple of 2400 GiB; anything else is `INVALID_INPUT` (reason `filesystem-size`) before any call.
  EFS ignores `sizeGiB` (elastic).
- **FD7 Found by name.** EFS: `CreationToken = <name>` (EFS refuses a second file system with the same token, and
  `FileSystemAlreadyExists` carries the id). FSx: `ClientRequestToken = <name>` and the tag
  `better-compute:filesystem=<name>`; `DescribeFileSystems` is read and filtered by that tag. A filesystem without
  `better-compute:managed=true` is never adopted or deleted (`INVALID_STATE`, reason `filesystem-foreign`).
- **FD8 Mounts through a user-data part.** `ProviderImpl.create` takes an additive `mounts?: ProviderMount[]`
  (`fstype`, `source`, `path`, `options`). provider-aws packs them into its own part of the MIME user data: a
  `text/x-shellscript` part (install the client with whichever package manager the image has, `mkdir`, an fstab line
  with `nofail`, `mount`), placed before the tenant's part. Not a `text/cloud-config` part as first sketched:
  cloud-config parts merge with replace by default, so a tenant's own `runcmd` or `mounts` would silently drop ours.
  The tenant's own user data stays a separate part, unchanged. (verify) The Ubuntu Lustre client needs the FSx apt
  repository; Amazon Linux 2023 has `lustre-client`.
- **FD9 Deletion.** `deleteFilesystem` deletes the mount targets, then the filesystem (`FileSystemInUse` while they
  go → `deleting`), then the group (`DependencyViolation` while ENIs linger → `deleting`). FSx scratch deletes skip
  the final backup; persistent ones skip it too (D: the tenant snapshots its own data; no backup bills behind its back).
- **FD10 vps.** A `filesystems` group (`filesystems.create|get|list|delete`), tenant scoped, one network each,
  `vps/0112_filesystems` (table) and `vps/0113_instance_filesystems` (an instance's mounts). `instances.create`
  takes `filesystems: [{ filesystem, path }]` on the filesystem's network only; vps resolves them to `ProviderMount`s
  from the provider state's mount (never secrets: these are DNS names and mount names).
- **FD11 metering (F10).** `filesystem.nfs.gib.hours` and `filesystem.lustre.gib.hours` in the core catalog;
  `vps.ancillary-usage` bills each filesystem from its first `ready` until it is deleted, by the size the provider
  last reported (`ProviderFilesystemState.sizeGiB`: EFS's metered size, refreshed by the 5-minute pass; FSx's
  provisioned capacity), else the size asked for. Columns in `vps/0112` (unreleased, so no new migration; `core/0062`
  stays unused). Windows are `network` sources keyed by the filesystem id, tagged `source: filesystem` (the
  usage source-kind CHECK is redefined by other modules' migrations, so a new kind would race them).

## Contract (core, additive)

```ts
export interface ProviderFilesystemSpec {
  name: string;               // provider-side, vps derives `bc-fs-<hash>`
  kind: 'nfs' | 'lustre';
  network: string;            // a better-compute network on this account
  zone?: string;              // lustre: the one zone (default the account's first)
  sizeGiB?: number;           // lustre only
  deployment?: 'scratch' | 'persistent';
  labels?: Readonly<Record<string, string>>;
}
export interface ProviderMount { fstype: 'nfs4' | 'lustre'; source: string; path: string; options: string }
export interface ProviderFilesystemState extends ProviderResourceState {
  mount?: Omit<ProviderMount, 'path'>; // once ready
}
export interface ProviderFilesystems {
  readonly kinds: readonly ('nfs' | 'lustre')[];
  ensureFilesystem(spec, context): Promise<ProviderFilesystemState>;
  deleteFilesystem(name, context): Promise<ProviderFilesystemState>;
}
// ProviderImpl.filesystems?: ProviderFilesystems; create(request.mounts?: readonly ProviderMount[])
```

## Tasks

- [ ] **F1 core.** The types above; `ProviderImpl.filesystems?` and `create({ mounts? })`. Test: a provider without
  them still type-checks (contract-extensions test).
- [ ] **F2 aws-core.** Services `elasticfilesystem` and `fsx` in `AwsService` (regional hosts, signing names equal).
- [ ] **F3 emulators.** `tests/support/aws-emulator/efs.ts` (CreateFileSystem with CreationToken conflicts,
  DescribeFileSystems by token or id, CreateMountTarget one per AZ with `MountTargetConflict`, DescribeMountTargets,
  DeleteMountTarget, DeleteFileSystem refusing `FileSystemInUse`, lifecycle `creating → available` after N reads) and
  `fsx.ts` (CreateFileSystem LUSTRE with ClientRequestToken idempotency and capacity checks, DescribeFileSystems,
  DeleteFileSystem, lifecycle `CREATING → AVAILABLE`).
- [ ] **F4 provider-aws networks.** `AwsNetworks.filesystemGroup(network, name, kind)` and
  `releaseFilesystemGroup(network, name)` (FD4), and `subnetsOf(network)` → one subnet per zone (FD5).
- [ ] **F5 provider-aws filesystems.** `AwsFilesystems` (EFS, FSx for Lustre) on `AwsCompute.filesystems`; mount
  descriptions: EFS `<fs>.efs.<region>.<suffix>:/` with `nfsvers=4.1,rsize=1048576,wsize=1048576,hard,timeo=600,
  retrans=2,noresvport,_netdev`; Lustre `<dns>@tcp:/<mountName>` with `relatime,flock,_netdev`.
- [ ] **F6 provider-aws mounts.** `create({ mounts })` → a `text/cloud-config` part (FD8); validation of paths
  (absolute, no `..`, no whitespace or control characters) and sources (only what F5 renders: refused otherwise).
- [ ] **F7 IAM.** `aws iam-policy --phases A10` adds EFS (`CreateFileSystem` with request tag managed,
  `CreateMountTarget`/`DeleteMountTarget`/`DeleteFileSystem`/`TagResource` on managed resources, `Describe*`) and FSx
  (`CreateFileSystem` request-tagged, `DeleteFileSystem` on managed, `DescribeFileSystems`, `TagResource` on create),
  plus `ec2:CreateNetworkInterface`/`DescribeNetworkInterfaces` that both services need through their service-linked
  roles (documented, not granted: the service-linked roles do that).
- [ ] **F8 vps filesystems group** (FD10) with migrations vps/0112–0113, the `vps.filesystems` reconciler, the API
  rows and descriptions, and instances.create `filesystems`.
- [ ] **F9 end to end.** A tenant makes a network, an `nfs` filesystem, and an instance mounting it: the RunInstances
  user data carries the mount part; deleting the filesystem while an instance mounts it is refused (`INVALID_STATE`).
- [x] **F10 metering** (FD11): `filesystem.<kind>.gib.hours` from the first `ready` until deleted, by the
  provider's reported size (tests/aws-ml-filesystems.test.ts "filesystem metering").

## Out of scope

Access points and per-tenant POSIX identities, EFS replication and backups, FSx data repository associations (S3
import/export), Filestore/DigitalOcean implementations.
