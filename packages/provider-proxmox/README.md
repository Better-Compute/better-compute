# @better-compute/provider-proxmox

The Proxmox VE provider for better-compute: it creates QEMU VMs on an operator's own cluster, each cloned from a template, as the VPS instances of `class: 'provider'` pools.

## Install

```sh
npm install @better-compute/provider-proxmox
```

It is not part of the `better-compute` umbrella: install it next to `better-compute` (or the `@better-compute/*` packages it works with).

## Usage

```ts
import { vps } from '@better-compute/vps';
import { proxmox, proxmoxProvider } from '@better-compute/provider-proxmox';

// The default provider: no user data beyond an empty `#cloud-config`.
vps({ providers: [proxmox] });

// With a way to deliver cloud-init user data (see "User data" below).
vps({
  providers: [
    proxmoxProvider({
      writeSnippet: async (name, content) => {
        // Write `content` to the snippets storage of the cluster (SFTP, a shared mount, ...).
        return `local:snippets/${name}`;
      },
    }),
  ],
});
```

An account's config:

| field                | default                               |                                                                                                      |
| -------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `url`                | (required)                            | The API endpoint, such as `https://pve.example.com:8006`.                                            |
| `token`              | (required)                            | A secret reference (`env://`, `secret://`, `vault://`) to an API token `user@realm!tokenid=secret`.  |
| `region`             | `pve`                                 | The region that offers and machines report.                                                          |
| `node`               | the template's node                   | The node to clone onto.                                                                              |
| `pool`, `storage`    | none                                  | The resource pool for new VMs, and the target storage for full clones.                               |
| `fullClone`          | `true`                                | Set to `false` for linked clones, which need the template on the same node and storage that supports them. |
| `disk`               | `scsi0`                               | The boot disk that an offer's `d` grows.                                                             |
| `vmidMin`, `vmidMax` | 100000000–999999999                   | The VMIDs this account may use.                                                                      |
| `offers`             | `1c-2g`, `2c-4g`, `4c-8g`, `8c-32g`   | The sizes offered, written `<vcpu>c-<GiB>g[-<GiB>d]`.                                                |

The image is a template's VMID or name. The token needs `VM.Clone` on the templates, plus `VM.Allocate`, `VM.Config.*`, `VM.PowerMgmt`, `VM.Audit` and `Datastore.AllocateSpace` where VMs are created, and `Sys.Audit` for the node headroom that offers report.

`proxmoxProvider(options)` takes:

- `writeSnippet(name, content, context)`: writes a cloud-init snippet and returns its volume id (`local:snippets/<name>.yaml`);
- `fetch`: the fetch implementation, for example one bound to a dispatcher that pins a self-signed cluster CA;
- `taskPollMs` (default 1 s) and `taskTimeoutMs` (default 10 min): how often a PVE task is polled and how long to wait for it.

## How it behaves

- **Idempotent create.** PVE has no idempotency keys, but VMIDs are unique. A key hashes to a VMID slot in `[vmidMin, vmidMax]`, and the clone records the key in its description. When another key holds the slot, create probes the next one. Retried and concurrent creates under one key therefore target the same VMID, and PVE lets only one clone through. A clone interrupted before it was configured is finished by the next create.
- **Configuration.** After cloning, create sets cores, memory and `ipconfig0=ip=dhcp`, grows the boot disk when the offer has a `d` (it never shrinks one), tags the VM `better-compute` last, and starts it. It does not wait for the start: the machine reports `pending` until `get` sees it running.
- **User data.** The PVE API cannot upload cloud-init snippets. Pass `proxmoxProvider({ writeSnippet })`, for example over SFTP or a shared mount, to deliver it through `cicustom`. Without it, create refuses user data other than an empty `#cloud-config`.
- **Safety on shared clusters.** `delete` and `power` act only on VMs tagged `better-compute`, and refuse others with `ACCESS_DENIED`. `list` yields only tagged VMs. Templates are never machines.
- **Tasks.** Clone, stop, delete and power actions wait for their task (UPID). A failed task becomes a `PROVIDER_ERROR`. `taskPollMs` and `taskTimeoutMs` tune the wait.
- **Addresses.** `get` reads them from the QEMU guest agent when the VM runs; with no agent, the list is empty.
- **Offers.** An offer is `available` when an online node, or the pinned `node`, has at least as many CPUs and enough free memory.
- **Self-signed clusters.** Pass a `fetch` bound to a dispatcher that pins the cluster CA.

Capabilities: `power` (`on`, `off`, `graceful-off`, `reset`, `graceful-restart`, and `cycle` as stop and start; `nmi` is unsupported), `reinstall` and `list`. PVE cannot rebuild a VM in place, so `reinstall` destroys the VM and clones the new template into the same VMID. The machine keeps its id, idempotency key, name, cores, memory, boot disk size and cloud-init volume.

The repository's tests run `providerConformanceCases()` from `@better-compute/vps` and the PVE specifics against an in-memory API emulator.

## Documentation

- [VPS providers](https://better-compute.com/docs/guides/vps/providers)
- [Writing a provider](https://better-compute.com/docs/extending/providers)

## License

[Apache License 2.0](https://github.com/better-compute/better-compute/blob/main/LICENSE)
