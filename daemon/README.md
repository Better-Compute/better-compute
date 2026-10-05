# bcd

`bcd` is the Better Compute daemon: one Go binary for the servers you manage (`node`), the site
agents that boot bare metal (`site`), the PXE ramdisk (`ramdisk`) and simulated fleets (`sim`). It
dials out to a regional gateway over the `agent/v1` protocol (`proto/bettercompute/agent/v1`). It
reports what the machine is, runs the typed commands the control plane sends, and converges the
machine toward its NodeSpec. Policy stays in the control plane (PLAN.md §6, §7).

This file is for people working on the daemon. For running it, start with the docs:

- [Overview](../apps/docs/content/docs/daemon/index.mdx) and
  [Installing bcd](../apps/docs/content/docs/daemon/install.mdx)
- [Protocol](../apps/docs/content/docs/daemon/protocol.mdx),
  [Sessions](../apps/docs/content/docs/daemon/sessions.mdx),
  [Delivery](../apps/docs/content/docs/daemon/delivery.mdx),
  [Gateway](../apps/docs/content/docs/daemon/gateway.mdx),
  [Failure modes](../apps/docs/content/docs/daemon/failure-modes.mdx)
- [Joining](../apps/docs/content/docs/guides/nodes/joining.mdx),
  [Commands](../apps/docs/content/docs/guides/nodes/commands.mdx),
  [Inventory and health](../apps/docs/content/docs/guides/nodes/inventory-and-health.mdx),
  [Break-glass SSH](../apps/docs/content/docs/guides/access/ssh.mdx),
  [Tunnels](../apps/docs/content/docs/guides/access/tunnels.mdx)
- [Command kinds](../apps/docs/content/docs/reference/command-kinds.mdx),
  [PKI](../apps/docs/content/docs/operations/pki.mdx),
  [Testing: the Go daemon](../apps/docs/content/docs/operations/testing.mdx#the-go-daemon)

## Status

Every mode works: `node`, `site`, `ramdisk`, `sim` (fakehw builds), `join`, `status`, `doctor`,
`update` and `version`. Self-update (A/B slots, v0.4) and the destructive-batch quorum (v1.0) are
enforced by the daemon. NVML is not wired yet: `internal/nvml` answers `ErrNotBuilt` in every build
(go-nvml needs cgo and a cross compiler), and GPU inventory comes from procfs and sysfs.

## Layout

The module is `github.com/better-compute/better-compute/daemon` (Go 1.26). Its direct
dependencies are connect-go, bbolt and protobuf.

| Path | What |
|---|---|
| `cmd/bcd` | subcommands and flags; the hardware backend picked by build tag (`hardware_host.go`, `hardware_fakehw.go`); restart-in-place for reboots under fakehw (`reexec_*.go`) |
| `cmd/bcx-ipmi` | the IPMI BMC driver plugin (bcx): power, boot device and inspection (FRU, BMC identity and LAN, sensors) through `ipmitool` (lanplus, cipher suite 17), the password through a pipe; a site agent runs it for `bmc.*` operations whose driver is `ipmi` |
| `internal/agent` | the node agent: session loop, command admission and kinds, the devices and access convergers, renewal, health watch, tunnels, secret and workload-token requests, the status socket |
| `internal/journal` | durable memory (meta, commands, unacked events, last spec, certificates, exec-ticket `jti`s) and the command rules (`rules.go`); `Memory` for tests, `Bolt` (bbolt) in production |
| `internal/dispatch` | the kind registry with role allowlists, `Precheck`, lanes with credits and worker pools, per-resource locks |
| `internal/converge` | NodeSpec section order, the `Converger` interface, `Run` and the `observedGeneration` rule |
| `internal/session` | protocol versions, Welcome and Ack handling, jittered reconnect backoff |
| `internal/pki` | byte-compatible with `@better-compute/pki`: purpose-framed ES256 signatures (`sign.go`), P-256 keys and SPKI pins (`keys.go`), compact JWE (`jwe.go`), join tokens and responses (`join.go`), signed intent and trust bundles (`intent.go`), exec tickets (`tickets.go`), secret and workload-token requests (`secrets.go`) |
| `internal/transport` | the connect-go client for `AgentGateway` (Join, Renew, Session, Tunnel): TLS 1.3 pinned to the serving CA, mTLS with the node certificate |
| `internal/inventory` | NodeInventory v1 types, canonical section encoding and hashes, and the `Collector` (procfs and sysfs, no cgo) |
| `internal/health` | PSI pressure, CPU steal, and the Xid parser for `/dev/kmsg` |
| `internal/fakehw` | a deterministic 8× H100 SXM HGX node (NVSwitch, 2 NUMA nodes, NVMe, 2 NICs), seeded |
| `internal/nvml` | the NVML boundary; a stub for now |
| `internal/selfupdate` | the A/B binary slots, `upgrade.json`, the release floor and the crash-loop rollback units |
| `internal/bcx` | bcx driver plugins: the sandbox shim (`bcd __bcx-exec`: no-new-privs, seccomp, per-plugin uid), cgroups |
| `internal/runtime` | instance runtimes: `Libvirt` (virsh, qemu-img, NoCloud seeds, snapshots, serial consoles), `CloudHypervisor` (a VMM per instance in a confined `bcd-ch-<id>.service` unit, driven over its REST socket: its own uid, no capabilities, no network, only KVM and VFIO devices, only its own instance and base image visible, /run and /var hidden, bounded by its flavor; persistent taps created and bridged by bcd, handed to it as fds; every disk's qcow2 header checked in Go before use; VFIO GPUs, memory snapshots bound to the CPU model and flavor. Needs systemd ≥ 247 and a cloud-hypervisor whose API takes net fds: `vm.add-net`, `vm.restore` `net_fds`) and `Fake` |
| `internal/redfish` | the Redfish client of the site agent's `bmc.*` kinds (power, boot, BIOS, RAID, firmware, accounts) |
| `internal/bootparams`, `internal/pxe` | the ramdisk's `bc.*` kernel command line; the site agent's proxyDHCP and TFTP |
| `internal/imds` | the instance metadata service of VPS hosts |
| `internal/config` | `/etc/bcd/config.toml` in a strict TOML subset |
| `internal/support` | redaction of keys, tokens, JWTs and URL passwords in logs and support bundles |
| `gen/` | Go code generated from `proto/` (see [`gen/README.md`](gen/README.md)) |

`internal/inventory/types.go` and `encode.go` are still generated from `inventory.proto` by
`internal/inventory/mirror.mjs`. They are used next to `gen/`, and the golden tests in
`hash_test.go` pin their section bytes to protobuf-es output.

### Build tags

| Tag | Effect |
|---|---|
| `fakehw` | reports the `internal/fakehw` node instead of reading the host, keeps its host root under `<data_dir>/fakehw-root` and its boot id in `<data_dir>/fakehw-boot-id`, and makes `node.reboot` restart the process in place. Also the only build that accepts `dev_insecure_h2c` |
| `nonvml` | `internal/nvml` builds without cgo and never loads `libnvidia-ml` |

The default build (`!fakehw`) reads the host with `inventory.Collector` and reboots with
`systemctl reboot`.

**Development transport.** `dev_insecure_h2c = true` lets `gateway_url` be `http://` (h2c). Only
fakehw builds accept it, and `bcd node` logs a warning when it is on. Over h2c a joined node sends
its id in `x-bc-test-node`, which only a gateway started with `insecureHeaderAuth` honours. Over
`https` the header is refused. Production is always TLS 1.3 with mTLS.

## Toolchain and tests

You need Go 1.26. Tests always run with `-tags nonvml,fakehw`:

```sh
node scripts/daemon-test.mjs                       # every package
node scripts/daemon-test.mjs ./internal/journal -v --run TestResolve
node scripts/daemon-test.mjs --build-bcd           # also writes daemon/bin/bcd-linux-amd64
```

On Linux and macOS the script runs `go test`. On Windows it cross-compiles each package's test
binary for linux/amd64 (`daemon/bin/tests/`) and runs it in WSL from the package directory
(`--distro`, default `$BCD_WSL_DISTRO` or `Ubuntu`).

Generated code and fixtures:

```sh
node scripts/daemon-proto-gen.mjs            # regenerate gen/ with the pinned buf (daemon/buf.gen.yaml)
node scripts/daemon-proto-gen.mjs --check    # fail on missing, stale or extra files
node --import ./tests/fixtures/bcx-loader.mjs scripts/daemon-fixtures.mjs
```

The last command writes `internal/pki/testdata/interop.json` from the TypeScript implementation:
certificates, a JoinResponse and JWE, signed commands, DesiredState and TrustBundle, an exec ticket,
and secret and workload-token exchanges, all on a fixed clock. `interop_test.go` checks the Go side
against it, so run it again whenever `@better-compute/pki` changes a format.

The end-to-end test `tests/e2e/bcd.test.ts` runs the real binary against a dev stack:

- join and adoption;
- `bcd status --json`;
- `inventory.refresh`;
- a reservation's CDI bind and release;
- a console tunnel;
- `node.reboot`;
- `bcd join --server` bootstrapping from the well-known document;
- `bcd sim`;
- self-update: `daemon.upgrade` to a signed second build, exec'd and confirmed by its Welcome.

`tests/e2e/bcd-vps.test.ts` runs a VPS host. Both run on Linux when Go is present. On Windows it needs `BCD_E2E=1` and WSL; `BCD_E2E_LOG=1`
streams bcd's log.

CI (`.github/workflows/daemon.yml`, Ubuntu and Windows) runs `go vet`, `go test -tags nonvml,fakehw
./...` and `goreleaser check`. Releases are built by `.goreleaser.yaml` for linux amd64 and arm64,
with cgo through `zig cc`. `daemon/bin/` and `daemon/dist/` are gitignored.

## Commands

| Command | Flags | |
|---|---|---|
| `bcd join` | `-config`, `-token-file`, `-server`, `-node-id`, `-attestor`, `-serving-ca-pin`, `-join-signing-pin`, `-join-encryption-pin`, `-data-dir` | reads the `bcjt_…` token from `BCD_JOIN_TOKEN` (unset once read), `-token-file` or the first line of stdin, never from arguments. Without config.toml, `-server` plus the three pins bootstrap it from the control plane's well-known document. Re-running on a joined node succeeds |
| `bcd node` | `-config` | runs the agent until SIGINT or SIGTERM |
| `bcd site` | `-config` | the site agent: `bmc.*` over Redfish, `site.httpProxy`, and with `[boot]` the iPXE boot server, image cache, proxyDHCP and TFTP |
| `bcd ramdisk` | `-cmdline`, `-data-dir` | inside the PXE ramdisk: joins from the `bc.*` boot parameters; inspect, diag, wipe, image stream, kexec |
| `bcd sim` | `-nodes`, `-seed`, `-config` | fakehw builds only: N simulated daemons in one process |
| `bcd helper` | `-config` | as root beside an unprivileged `bcd node`: typed privileged operations on `[helper] socket` |
| `bcd update` | `-config`, `-clear-failed` | shows the self-update slots, release floor, a pending update and failed versions; `-clear-failed` lets a failed version be tried again |
| `bcd status` | `-socket`, `-json` | asks the running agent over its unix socket |
| `bcd doctor` | `-config` | checks the config (and its file mode), NVML and hardware collection |
| `bcd version` | | `bcd <version> <os>/<arch> <go>` plus build tags; set the version with `-ldflags "-X main.version=…"` |

Exit codes: 0 for success, 1 for failure, 2 for a usage error or a command that is not
implemented yet. An unknown command is echoed only if it looks like a command name, so a token
pasted in the wrong place is never printed.

## Configuration and files

`/etc/bcd/config.toml` (at most 64 KiB) uses a strict TOML subset: comments, `[section]`,
strings, integers and booleans. Unknown keys, duplicate keys and wrong types are errors.

| Key | Default |
|---|---|
| `gateway_url` | required; `https://`, or `http://` only with `dev_insecure_h2c` |
| `site` | required |
| `serving_ca_spki_pin`, `join_signing_key_pin`, `join_encryption_key_pin` | required, `sha256/<base64>` |
| `gateway_server_name` | the URL's host (TLS name when you dial an address) |
| `data_dir` | `/var/lib/bcd` |
| `socket_path` | `/run/bcd/bcd.sock` |
| `dev_insecure_h2c` | `false` (fakehw builds only) |
| `[journal] max_bytes`, `max_events` | 64 MiB, 10 000 (the file may lower these caps, never raise them) |
| `[log] level`, `json` | `info`, `true` |
| `approver_set_sha256` | unset; the hex SHA-256 of the approver set a keyless daemon may take first (review 7 M2) |
| `[update] release_pins`, `release_threshold`, `release_sequence`, `entrypoint`, `slots_dir` | no pins (self-update refused), 1, 0, `/usr/local/bin/bcd`, `<data_dir>/bin` (under bcd helper `/usr/local/lib/bcd`) |
| `[helper] socket`, `user` | unset; with both, `bcd node` runs as `user` and `bcd helper` (root) does its privileged work |
| `[site] bmc_networks` | unset; CIDRs `site.httpProxy` never reaches |
| `[websocket] url`, `proxy_ca_file`, `audience` | unset (gRPC only); a `wss://` URL moves the session and renewals to the WebSocket fallback |
| `[plugins] dir`, `user`, `privileged`, `sandbox`, `cgroup`, `memory_max`, `pids_max` | no plugins; per-plugin uids, none, `true` |
| `[imds] listen` | unset (VPS hosts: the metadata service's address) |
| `[instances] balloon_floor_percent` | 50 (10–100): the share of its memory a ballooned guest always keeps; bcd inflates balloons only while the host is short of memory or stalls on it (PSI), idle guests first, and never below the floor or the guest's use plus 10% |
| `[kubernetes] allowed_clusters`, `gpu_api` | none (k8s-join refused under bcd helper), `device-plugin` |
| `[host] units` | `true`; `false` when the GPU operator (or another tool) owns the host's configuration |
| `[boot] listen`, `url`, `kernel`, `initrd`, `cmdline`, `server_ip`, `proxy_dhcp`, `tftp`, `tftp_root`, `cache_max_bytes` | site agents only |

Files the daemon owns:

| Path | |
|---|---|
| `<data_dir>/node.key` | the node's P-256 key (0600). On a host with a TPM (`/dev/tpmrm0`), the key is made in the TPM and this file holds only its record (PEM `BCD TPM NODE KEY`: the 32-byte unique its owner-hierarchy primary is derived from again at each load). Such a key cannot be copied off the machine, but anyone with the owner hierarchy's authorization on that TPM (root on the node) can derive and use it: it is non-exportable, not root-proof. Under `[helper]` the unprivileged `bcd node` never opens the TPM (the kernel's resource manager filters no command: the `tss` group could lock or clear the hierarchies): `bcd helper` derives, signs with and certifies its node keys (`tpm.*` ops, keys named by their unique), and the install script keeps the `bcd` user out of `tss`. A certificate whose key the TPM's AK certified names that AK (URI SAN `urn:bc:tpm-ak:`), and every renewal must have that AK certify the next key. Without a TPM, or when the TPM cannot hold it, it is a PKCS#8 file, and the next renewal moves it into the TPM once one is usable. `bcd doctor` and `bcd status` say which |
| `<data_dir>/node.key.next` | the key a renewal is certifying; promoted at start if the certificate matches it, otherwise deleted |
| `<data_dir>/identity.json` | node, site, role, certificate chain, trust roots and version, and the server-time high-water mark (0600) |
| `<data_dir>/journal.db` | the bbolt journal (0600). A journal that will not open is kept as `journal.db.corrupt-<unix>`; re-joining as another node keeps the old one as `journal.db.<oldNodeId>-<unix>` |
| `<data_dir>/fakehw-root/`, `fakehw-boot-id` | fakehw builds only |
| `/etc/bcd/join-encryption.jwk` | the JoinService encryption key, read from the config file's directory and checked against its pin |
| `/run/bcd/bcd.sock` | the status socket, 0600 in a 0700 directory |
| `<data_dir>/bin/bcd-{a,b}`, `current`, `previous`, `slots.json` | self-update slots; the entrypoint links to `current` after the first update |
| `<data_dir>/upgrade.json` | an update between its swap and its Welcome (or its rollback) |
| `<data_dir>/update.json` | the highest release sequence run, and versions that failed to start |
| `<data_dir>/batch-leaves.json`, `unbatched-destructive.json` | quorum: batch leaves that ran, and the last hour's unbatched destructive commands |
| `<data_dir>/bmc-hosts.json` | site agents: the BMC names and addresses driven (`site.httpProxy` refuses them) |
| `/etc/systemd/system/bcd-rollback.service`, `bcd.service.d/50-bcd-rollback.conf` | written by the first update under systemd |
| `/etc/cdi/bcd-<allocationId>.json` | CDI spec per GPU hold |
| `/run/bcd/allocations/<allocationId>.env` | the hold's environment (`BCD_ALLOCATION_ID`, `BCD_RESERVATION_ID`, `NVIDIA_VISIBLE_DEVICES`, …) |
| `<data_dir>/libvirt/…` | libvirt-kvm instances and base images. QEMU runs as its own user, so bcd gives "others" search (x, never read) on the way from `<data_dir>` to each file a domain names; the files stay root's until libvirt relabels them. Under `[helper]` it's group search and group-shared files instead (see Privilege separation) |
| `<data_dir>/volumes/<id>.raw`, `<id>.json` | persistent host volumes and their serials (0600; a CH VMM's user holds a read-write one while it runs) |
| `bcd-alloc-<allocationId>.slice` | a hold's runtime slice when it has limits (`/sys/fs/cgroup/bcd.slice/bcd-alloc.slice/…`); under a fake root, `/run/bcd/slices/<name>.json` |
| `/etc/ssh/sshd_config.d/10-better-compute.conf`, `/etc/ssh/bc_ca.pub`, `/etc/ssh/bc_principals/<account>`, `/etc/ssh/bc_krl` | break-glass SSH, written by the access converger |

## Behaviour

The docs pages above explain these for operators. What follows is where each rule lives in the
code.

**Commands and the journal** (`internal/journal/rules.go`). A command is journaled with `Accept`
before any side effect. A redelivered command is handled by the state stored at acceptance:

- done: its stored result is resent;
- still running in this process: the new delivery reattaches to it;
- interrupted by a crash (each process start is a new incarnation):
  - retry-safe kinds run again;
  - a self-terminating kind whose boot id changed has succeeded (`rebooted`);
  - anything else fails with `interrupted`.

`Recover` runs at start. `Sweep` removes finished entries after 7 days, at start and then hourly.
BUSY refusals are never journaled.

**Acceptance order** (`dispatch.Precheck`, `agent/commands.go`). The checks run in this order:

1. the journal (duplicate or resume);
2. the node id;
3. `upgrade_required`;
4. the kind and the node's role;
5. `min_generation`: the command is deferred until the spec arrives, asking for it with `SpecRequest`;
6. `not_after`, against server time (the local clock plus the Welcome offset);
7. the signature;
8. lane credit: otherwise the answer is BUSY, which is also the answer while the journal is full;
9. `Accept`, then `ACKED`, `RUNNING` and the result.

A command cancelled before its side effect ends `CANCELLED`. After the side effect has started,
the real outcome is reported.

**Signed intent** (`pki/intent.go`, `agent/commands.go`, `agent/spec.go`). Once the node holds
trust roots, from `JoinResponse.trust` and newer versions in `Welcome.trust` signed by the pinned
JoinService key:

- every command must carry a signature that verifies (review 7 HIGH-1);
- every DesiredState must verify.

Attested results and allocation reports carry the node's own signature.

**Quorum** (`agent/quorum.go`, `pki/batch.go`). With approver keys in the trust bundle, a destructive
command runs only with a batch approval of enough approver signatures for this node's trust domain
and a Merkle proof of its leaf (subject, kind, payload digest or unbound), each leaf once. A
`site.httpProxy` other than GET needs a payload-bound leaf. Unbatched destructive commands are
capped per hour. Approver sets change only at a higher epoch with k-of-current signatures; a
refused set keeps the held quorum while roots and version still apply.

**Self-update** (`agent/update.go`, `selfupdate/`). `NodeSpec.daemon` and `daemon.upgrade` carry a
`DaemonSection` whose `signature` is the signed release manifest. The manifest must verify under
`[update] release_pins`, be bcd's, for that version, at or above the release floor, unexpired on
both clocks, and list the bare binary `bcd_<version>_<os>_<arch>` with the section's digest. The
binary is staged in the other slot, `upgrade.json` gets a 120 s deadline, `current` swaps and bcd
execs the entrypoint. The new binary is confirmed by its first Welcome; without one it swaps back,
and the old binary records the version as failed. Going back to the version in the other slot
needs no manifest only while that slot's recorded release sequence is still at or above the floor,
so a confirmed upgrade (which raises the floor) is never undone that way: rollouts roll forward.

**WebSocket fallback** (`transport/ws.go`, `cmd/bcd/websocket.go`). For proxies that strip client
certificates: the Session runs over `wss://…/v1/session` (subprotocol `bc.agent.v1`, the same
length-prefixed frames). bcd proves itself with an ES256 proof JWT (`x5c` = its chain, single-use
`jti`, the connection nonce) and accepts only a gateway whose `x-bc-gateway-proof` chains to the
pinned serving CA; `proxy_ca_file` is trusted for TLS only. Renewals go to `POST /v1/renew` on the
same listener. WS mode needs command-signing roots (the gateway sends it signed intent only) and has
no tunnels.

**Privilege separation** (`internal/helper`, `cmd/bcd/helper.go`). With `[helper]`, `bcd node` runs
unprivileged and asks `bcd helper` (root) over a unix socket for: files named by kind and id
(CDI specs, allocation env files, the SSH drop-in, CA, principals and KRL), reboots, resets of the
host's own GPUs, bcd's nftables table, sshd reloads, hold slices (`slice.apply`, `slice.remove`:
only `bcd-alloc-*.slice`, emptied before removal), the root-only DMI values (`dmi.read`: no
arguments; product UUID, serials and asset tags from a fixed list under `/sys/class/dmi/id`, no
symlinks, 128 printable bytes each), the root-only hardware details (`hw.read`: no arguments;
DIMMs parsed from the SMBIOS type 17 entries and each NVMe controller's SMART / Health log page,
both enumerated by the helper, parsed values only, at most 64 of each), and self-update (`update.*`: the node
downloads; the helper verifies the manifest with its own pins and floor, re-hashes the staged
binary into root's slots, swaps, and swaps back on its own deadline). Peers are checked by
SO_PEERCRED and `/proc/<pid>/exe`; requests are versioned, strictly decoded JSON; every operation
is logged. Every directory on the way to the socket, the slots and the entrypoint must be root's
and closed to others (`bcd doctor` checks it), neither the slots nor the entrypoint may live in
`data_dir`, and the helper adopts into a slot only a root-owned entrypoint no one else can write.
Instance runtimes under the helper: libvirt-kvm's privileged operations (`define`, `start`,
`shutdown`, `destroy`, `suspend`, `resume`, `undefine`, `blockresize`, the balloon's `setmem`, the rebind disk's
`attach-disk`/`detach-disk`, memory `save`/`restore`, and the console pty) go through the helper's
`libvirt.*` ops (`runtime.Hypervisor`). Root validates every domain definition against an allowlist:
- disks only under bcd's instance, image and volume directories, with the overlays re-checked;
- taps named `runtime.TapName`, on bridges from `[helper] instance_bridges`;
- hostdevs only for this host's GPUs.

The node reads libvirt's read-only socket (`virsh -r`) and must not be in the root-equivalent
`libvirt` group. libvirt runs with `dynamic_ownership = 0`, and QEMU reaches the node's files
through the node's group: disks are 0660 and read-only ones 0640, and directories get group
search.

cloud-hypervisor under the helper (`runtime.CHPrivileged`, the helper's `ch.*`) keeps each VMM as its
own uid, but the node owns every file and grants that uid access with POSIX ACLs (inherited by what
the VMM creates, under `UMask=0007` and its own private group). Root does only what needs root:
- the taps, named `runtime.TapName`, owned by the node, on `[helper] instance_bridges`;
- VFIO, only for this host's GPUs whose whole IOMMU group is theirs and that root sees idle;
- the VMM's unit, which root builds from the record it checks itself (`runtime.CHLaunch`), with
  root's binary and never another running unit's uid.

The node reads live usage (`bcd.instance.*`: the unit's cgroup, the taps' counters) as itself, with
no `ch.*` call. `node scripts/helper-e2e.mjs` drives `ch.*` through a real helper as root, with real
taps in a private network namespace and a stubbed `systemd-run` (b9667d5). No VMM has run under it yet.

`bcd doctor` checks all of this.

**Identity rebind** (`agent/rebind.go`, `runtime/rebind.go`; review 13 H2). A memory-restored guest
resumes with its source's sshd principals and host key. When its spec carries
`identity_rebind_ref`, bcd fetches that sealed bundle once the instance runs:
`{"v":1,"account","principals","hostKey"?,"hostCertificate"?}`. It hands the bundle to the guest on a
raw 1 MiB disk, hot-added with virtio serial `bc-rebind`:
- the disk is cloud-hypervisor `vm.add-disk`, or libvirt `attach-disk … vdz --live`;
- it holds a tar at offset 0 with the members `nonce`, `account`, `principals` and, with a host
  key, `host_key` and `host_key-cert.pub`;
- its last 4 KiB are reserved for the guest's acknowledgement.

bcd waits up to 2 minutes for `BCREBOUND <nonce>\n` at the start of that region. It then removes
the disk, zeroes and deletes its file, and reports the ref as `InstanceStatus.identity_rebound_ref`
(kept in `<data_dir>/instances-rebound.json`). A guest that never acknowledges is tried at most
3 times, 5 minutes apart, and nothing is reported, so the control plane keeps refusing exec into it.

The guest half, which vps installs at first boot (memory restores inherit it):

```
# /etc/udev/rules.d/90-bc-rebind.rules
ACTION=="add", SUBSYSTEM=="block", ENV{ID_SERIAL}=="bc-rebind", TAG+="systemd", ENV{SYSTEMD_WANTS}+="bc-rebind@%k.service"

# /etc/systemd/system/bc-rebind@.service
[Unit]
Description=better-compute identity rebind (%I)
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/bc-rebind %I

# /usr/local/sbin/bc-rebind (0755)
#!/bin/sh
set -eu
dev="/dev/$1"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
tar -xf "$dev" -C "$work" --no-same-owner --no-same-permissions
account=$(cat "$work/account")
case "$account" in ''|*[!a-z0-9_-]*) exit 1 ;; esac
install -d -m 0755 /etc/ssh/bc_sandbox_principals
install -m 0644 "$work/principals" "/etc/ssh/bc_sandbox_principals/$account"
if [ -f "$work/host_key" ]; then
  install -m 0600 "$work/host_key" /etc/ssh/bc_sandbox_host_key
  install -m 0644 "$work/host_key-cert.pub" /etc/ssh/bc_sandbox_host_key-cert.pub
fi
systemctl reload ssh 2>/dev/null || systemctl reload sshd
size=$(blockdev --getsize64 "$dev")
printf 'BCREBOUND %s\n' "$(cat "$work/nonce")" |
  dd of="$dev" bs=4096 seek=$((size / 4096 - 1)) conv=notrunc,sync oflag=direct,sync status=none
```

**Server time** (`agent/conn.go`). The daemon keeps a high-water mark of server time, advanced by
every Welcome and heartbeat and mirrored in `identity.json`. A Welcome more than 5 minutes behind it
is refused.

**Renewal** (`agent/renew.go`). Renewal starts at 60% of the certificate's lifetime and backs off
from 30 s to 10 min on failure. It is crash-safe:

1. write `node.key.next`;
2. call `Renew` with proof of possession;
3. check that the identity is unchanged;
4. save `identity.json`;
5. rename the new key into place;
6. rebuild the mTLS client.

**Convergence** (`converge/`, `agent/spec.go`). Sections apply in the order `host`, `devices`,
`instances`, `access`, `telemetry`, `daemon`.

- A section without a converger is converged when empty. Otherwise it reports `SectionUnsupported`.
- Transient errors retry after 30 s. `Terminal` ones fail the section.
- `observedGeneration` advances only when no section is still progressing.
- Specs apply only at a higher generation. A patch must be based on the applied generation, and
  the stored spec is enforced while offline.

**Devices** (`agent/devices.go`, `agent/holds.go`, `internal/slice`). The devices converger writes one
CDI spec and one env file per `hold` or `kubernetes` binding. It releases holds that are no longer
desired and reports `allocation.bound`, `allocation.released` and `allocation.failed` as signed
events. It never drops a hold on its own.

- It holds whole GPUs, MIG instances (`gpu.mig`, `<gpu>/gi<g>/ci<c>`, resolved to the MIG UUID from
  inventory) and slots (`gpu.slot`, `<gpu>/s<k>`).
- Conflicts are parent-aware. A GPU held whole excludes its parts, and a GPU a VM has passed
  through excludes every hold on it.
- A hold with `DeviceAssignment.limits` runs in its own systemd slice
  `bcd.slice/bcd-alloc.slice/bcd-alloc-<id>.slice`:
  - AllowedCPUs and AllowedMemoryNodes;
  - CPUQuota from cpu_millis;
  - MemoryMax, with MemoryHigh at 90% of it;
  - hugetlb limits.
- The slice is created before the CDI spec (`bcd.dev/cgroup-parent`, `BCD_CGROUP_PARENT`) and
  restored when it is missing. It is removed on release only once it is empty. Every pass,
  including the 10-minute drift pass, tries again to stop a slice whose workload outlived its
  release.
- A `kubernetes` binding gets no slice. Its pods live in the kubelet's cgroups (`kubepods.slice`),
  where the kubelet enforces their requests and limits. The booked limits still count in bcd's
  host admission.
- Slots get `CUDA_MPS_PIPE_DIRECTORY` when the MPS daemon runs.
- A `bcd node` running as an ordinary user without `[helper]` cannot write `/etc/cdi` or create slices.
  Its Hello claims no `cdi`, `devices.limits` or `binding.kubernetes`, so capacity places no GPU
  reservation there. A hold that arrives anyway fails at once as `node-unprivileged`, and
  `bcd doctor` warns (`gpu-binding`).
- A `hold`'s spec copies, from NVIDIA's JSON CDI spec (`/etc/cdi/nvidia.json`, which the
  `container-toolkit` unit generates with UUID names), the device nodes of exactly its devices and
  the driver's common mounts and hooks. So `bcd.dev/gpu=<id>` alone gives a container its GPUs,
  even with the toolkit in CDI mode, where `NVIDIA_VISIBLE_DEVICES` grants nothing. On WSL 2 the
  spec's one device, `all` (`/dev/dxg`), stands for each GPU. Without a JSON spec (none generated,
  or the GPU operator's YAML) a hold carries only `NVIDIA_VISIBLE_DEVICES`.
- A `kubernetes` binding is marked `bcd.dev/binding` for the device plugin and has no
  `NVIDIA_VISIBLE_DEVICES` of its own.

**Instances** (`agent/instances.go`, `agent/admission.go`, `runtime/`).

- *Admission.* bcd admits a start only when the host has memory for it:
  - MemTotal minus the hugetlb pool and 1 GiB, less what running and paused domains hold (their
    memory plus VMM overhead);
  - free hugepages of the right size, per NUMA node for a placed instance.
  
  A refused start reports `ResourcesExhausted`, stays stopped and is tried again on the next pass.
  A new hold with a memory limit or hugepages is admitted the same way. What doesn't fit becomes
  `AllocationFailed{reason: resources-exhausted}`, which the control plane re-places. Each side
  counts the other, so VMs and holds never take what the other was promised.
- *Volumes* (`runtime/volumes.go`; `InstancesSection.volumes`):
  - persistent disks under `<data_dir>/volumes`, one sparse raw file each;
  - created and grown (never shrunk) before any instance is defined;
  - attached in spec order as `vdb`… and found by serial;
  - one writer: an instance beside a running or paused writer, or a writer beside readers, is
    refused and stopped;
  - once unlisted and unattached, a volume's blocks are punched out and the file is unlinked;
  - a memory snapshot of an instance with a read-write volume is refused;
  - sparse, but never overcommitted: a new volume or a growth must fit in the filesystem's
    available space, less a reserve (5%, at least 2 GiB), less every volume's unwritten space.
    `StatusReport.volume_storage` reports these numbers;
  - a cloud-hypervisor read-only volume is readable by exactly the VMM users that have it open (a
    POSIX ACL entry each). Under the helper, a libvirt domain's volumes go back to 0600 when it stops.
- *Placement* (`runtime/placement.go`). `InstanceSpec.placement` pins the vCPUs one to one when
  `cpus` has exactly `vcpu` entries; with more entries the vCPUs float within them. Placement also
  sets memory binding (`mems`, strict), hugepage backing (2 MiB or 1 GiB, locked) and the balloon,
  which is off unless asked for and never allowed with hugepages.
- *VFIO* (`runtime/vfio.go`). A GPU instance's IOMMU group is moved onto `vfio-pci` at start and
  given back to its driver at stop and delete. GPU instances are never memory-snapshotted.
  nvidia-persistenced holds every GPU open, so the GPU's persistence mode goes off before it leaves
  nvidia (`nvidia-smi -pm 0`) and on again once nvidia has it back. libvirt's managed hostdevs get the
  same around `start`/`restore` and `destroy`, done by root (bcd itself, or `bcd helper`).
- *NoCloud seed* (`runtime/netconfig.go`). It carries network-config v2 for leased NICs:
  - each NIC is matched by MAC and gets its CIDR addresses;
  - the gateway becomes the default route, and the NIC's nameservers are set;
  - NICs without addresses keep DHCP.
- *bcx runtimes* (`agent/pluginruntime.go`). A plugin runtime is told each NIC's tap name, the
  guest's gateway and nameservers, the rebind ref, host-only SSH and placement. When bcd's tap rules
  guard an instance and a running instance's taps are missing, the instance is stopped (fail closed).

**Site boot server** (`agent/bootserver.go`, `agent/discovery.go`, `agent/sanboot.go`). While a site
agent holds the `site:<id>:boot` lease, it answers PXE only for machines metal prepared
(`boot.prepareRamdisk`). Their iPXE script boots the site ramdisk with a single-use discovery token
and a discovery assertion the agent signs.

- An unknown machine that PXE-boots is never answered. It is listed in `StatusReport.discovered`:
  MAC, SMBIOS UUID (DHCP option 97), arch, first and last seen, count, and relay (giaddr).
  - The list holds at most 256 machines and forgets one 24 hours after it was last seen.
  - A new machine asks for a status report, at most one per 30 seconds.
  - Metal matches machines enrolled without MACs (IPMI) by UUID.
- An entry with `sanboot_sha256` boots that ISO with `sanboot` from the agent's verified cache, for
  BMCs without virtual media.
  - The ISO must be a cache image the site spec names as `iso`.
  - Until it is cached, the machine waits; it never falls back to the ramdisk.
  - If the site spec doesn't name the digest as an iso, the site section fails.
- The image cache serves only under grants, at `/cache/t/<grant>/<sha256>`:
  - a boot's grant (its ramdisk's `bc.cache`, its sanboot URL) lasts until its entry lapses, and
    only while the lease is held;
  - a BMC firmware URL's grant covers that one image for 2 hours.
- Discovery takes only well-formed fields: canonical UUIDs and short arch names.
- Request headers are capped at 8 KiB, and TFTP runs at most 64 transfers, 4 per source.

**Access** (`agent/access.go`). The access converger writes the sshd drop-in, CA, principals
(`<account>@<nodeId>` only) and KRL. It reloads sshd only when the drop-in changed, and it removes
everything it wrote when the section is empty. It also keeps the JWKS that tunnel tickets are
checked against.

**Kinds** (`agent/kinds.go`; the [command kinds reference](../apps/docs/content/docs/reference/command-kinds.mdx)
is the full list):

| Kind | What it does |
|---|---|
| `inventory.refresh` | resends inventory sections, optionally re-collecting them |
| `diag.nvml` | per-GPU health checks (ECC, row remapping, PCIe link, recent Xids) |
| `logs.collect` | collects `journalctl` output, redacts it and uploads it to a presigned https URL |
| `gpu.reset` | resets a GPU with no live hold on it or its MIG instances and slots, and no VM passthrough; otherwise `gpu-busy` (destructive) |
| `node.reboot` | reboots; self-terminating, so it completes after the restart (destructive) |
| `daemon.upgrade` | self-update; self-terminating, it completes after the new binary is welcomed |
| `instance.snapshot` | snapshots a VPS instance and uploads it to a presigned https URL |
| `driver.invoke` | one operation of a bcx plugin's driver (destructive) |
| `disk.wipe`, `deploy.image`, `boot.kexec`, `diag.dcgm` | ramdisk kinds; images and boot files are written and read in userspace for ext and FAT. `diag.dcgm` from level 2 refuses GPUs in use, as `gpu.reset` does |
| `bmc.*`, `site.httpProxy`, `boot.*`, `site.proxyDhcp` | site agent kinds |

Tunnels (`agent/tunnels.go`, at most 16) are session frames, not kinds. They open only for an exec
ticket that verifies against the pinned JWKS, whose `jti` is new and whose `sid` matches the tunnel.
Secret and workload-token requests (`agent/requests.go`) are session frames too.

**Health** (`agent/healthwatch.go`). Every 30 s the daemon samples PSI pressure and CPU steal.
Xid lines on `/dev/kmsg` become conditions on the matching GPU.

**Sessions** (`agent/conn.go`, `session/`).

- The Hello resumes from the last epoch, generation and event sequence, and replays unacked events
  after the Welcome.
- Heartbeats default to every 10 s and carry free lane credits.
- A full outbox (4096 frames) drops the session instead of blocking.
- Reconnects use full-jitter backoff up to 60 s. A `Drain` frame sets the delay, and `Revoked`
  stops the agent.

Lanes: `control` has 8 credits and 4 workers, `provision` 4 and 2, `bulk` 2 and 1.
