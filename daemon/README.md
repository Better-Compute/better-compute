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
| `internal/runtime` | instance runtimes: `Libvirt` (virsh, qemu-img, NoCloud seeds, snapshots, serial consoles) and `Fake` |
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
| `[update] release_pins`, `release_threshold`, `release_sequence`, `entrypoint` | no pins (self-update refused), 1, 0, `/usr/local/bin/bcd` |
| `[site] bmc_networks` | unset; CIDRs `site.httpProxy` never reaches |
| `[websocket] url`, `proxy_ca_file`, `audience` | unset (gRPC only); a `wss://` URL moves the session and renewals to the WebSocket fallback |
| `[plugins] dir`, `user`, `privileged`, `sandbox`, `cgroup`, `memory_max`, `pids_max` | no plugins; per-plugin uids, none, `true` |
| `[imds] listen` | unset (VPS hosts: the metadata service's address) |
| `[boot] listen`, `url`, `kernel`, `initrd`, `cmdline`, `server_ip`, `proxy_dhcp`, `tftp`, `tftp_root`, `cache_max_bytes` | site agents only |

Files the daemon owns:

| Path | |
|---|---|
| `<data_dir>/node.key` | the node's P-256 key, PKCS#8, 0600 |
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
needs no manifest.

**WebSocket fallback** (`transport/ws.go`, `cmd/bcd/websocket.go`). For proxies that strip client
certificates: the Session runs over `wss://…/v1/session` (subprotocol `bc.agent.v1`, the same
length-prefixed frames). bcd proves itself with an ES256 proof JWT (`x5c` = its chain, single-use
`jti`, the connection nonce) and accepts only a gateway whose `x-bc-gateway-proof` chains to the
pinned serving CA; `proxy_ca_file` is trusted for TLS only. Renewals go to `POST /v1/renew` on the
same listener. WS mode needs command-signing roots (the gateway sends it signed intent only) and has
no tunnels.

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

**Devices** (`agent/devices.go`). The devices converger writes one CDI spec and one env file per
`hold` binding of GPUs. It releases holds that are no longer desired and reports
`allocation.bound`, `allocation.released` and `allocation.failed` as signed events. It never drops
a hold on its own.

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
| `gpu.reset` | resets a GPU that has no live hold (destructive) |
| `node.reboot` | reboots; self-terminating, so it completes after the restart (destructive) |
| `daemon.upgrade` | self-update; self-terminating, it completes after the new binary is welcomed |
| `instance.snapshot` | snapshots a VPS instance and uploads it to a presigned https URL |
| `driver.invoke` | one operation of a bcx plugin's driver (destructive) |
| `disk.wipe`, `deploy.image`, `boot.kexec`, `diag.dcgm` | ramdisk kinds; images and boot files are written and read in userspace for ext and FAT |
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
