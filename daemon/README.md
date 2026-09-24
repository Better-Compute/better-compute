# bcd

`bcd` is the better-compute daemon: one Go binary whose modes run on every server (`node`), per
datacenter (`site`), inside the PXE ramdisk (`ramdisk`) and on test hosts (`sim`). It dials out to
the control plane's gateway over the `agent/v1` protocol (`proto/bettercompute/agent/v1`) and keeps
policy out of the node: the daemon executes typed commands and converges typed desired state
(PLAN.md §6, §7).

This directory is its own Go module, `github.com/better-compute/better-compute/daemon`, with no
dependencies yet. It is the **P0 skeleton**: `bcd version` and `bcd doctor` work, every other
command parses its flags and exits 2 naming the phase it arrives in, and the contracts the v0.1
daemon builds on are in place with unit tests.

## Build and test

Requires Go 1.24 or later. From `daemon/`:

```sh
go test -tags nonvml,fakehw ./...   # logic tests: no cgo, no NVIDIA driver, fake HGX H100 hardware
go test ./...                       # default tags: the NVML and host-inventory stubs
go vet -tags nonvml,fakehw ./...
gofmt -l .                          # must print nothing
go build -tags nonvml,fakehw -o bin/bcd ./cmd/bcd
go build -ldflags "-X main.version=0.1.0" -o bin/bcd ./cmd/bcd
```

`daemon/bin/` and `daemon/dist/` are gitignored. Release archives come from goreleaser
(`.goreleaser.yaml`): `goreleaser release --snapshot --clean` writes
`dist/bcd_<version>_linux_{amd64,arm64}.tar.gz`, each with a `.sha256`.

Build tags:

| Tag | Effect |
|---|---|
| `nonvml` | `internal/nvml` builds without cgo and never loads `libnvidia-ml` |
| `fakehw` | `bcd` reports the deterministic fake HGX H100 node of `internal/fakehw` instead of reading the host |

### Windows

`bcd` targets Linux only (amd64, and arm64 for Grace/GB200), but its logic runs anywhere: on the
Windows workstation run the tests natively with `-tags nonvml,fakehw`. Full builds with NVML need
cgo and a Linux C toolchain, so they go through WSL2 or Docker (`zig cc` in goreleaser). Paths in
`config.toml` are Linux paths and are validated as such on every OS.

## Layout

| Path | What | State |
|---|---|---|
| `cmd/bcd` | subcommands and flags: `node`, `site`, `ramdisk`, `sim`, `join`, `status`, `doctor`, `version` | skeleton |
| `internal/config` | `/etc/bcd/config.toml` in a documented TOML subset: gateway URL, site, SPKI and key pins | done |
| `internal/journal` | the journal contract and the command rules (duplicate delivery, crash recovery, self-terminating kinds); an in-memory store | contract + memory |
| `internal/dispatch` | lanes with credits and worker pools, per-resource locks, the kind registry, acceptance checks | contract + primitives |
| `internal/session` | Hello/Welcome, epoch, resume, reconnect backoff | contract |
| `internal/converge` | NodeSpec sections `host · devices · instances · access · telemetry · daemon` and the observedGeneration rule | contract + runner |
| `internal/inventory` | NodeInventory v1 mirrored from `inventory.proto`, canonicalization, section encoding and hashes | done |
| `internal/fakehw` | deterministic 8× H100 SXM5 80GB HGX node (NVSwitch, 2 NUMA nodes, NVMe, 2 NICs) | done |
| `internal/nvml` | NVML boundary; `ErrNotBuilt` in every build for now | stub |
| `gen/` | Go code generated from `proto/` | empty, see `gen/README.md` |

Inventory sections follow `inventory.proto`: a section's content is the protobuf binary encoding
of its canonicalized message (repeated fields sorted by stable key) and its hash is the SHA-256 of
that content; the control plane verifies content against hash and never re-encodes.
`internal/inventory/types.go` and `encode.go` are generated from the proto by
`node daemon/internal/inventory/mirror.mjs` until `gen/` exists, and the golden tests in
`hash_test.go` pin the encoder to protobuf-es output.

## Arrives in v0.1

- `go.sum` and the first dependencies, once a Go toolchain is installed: connect-go, protobuf,
  `NVIDIA/go-nvml`, `go.etcd.io/bbolt`; generated code in `gen/`.
- `bcd join` (sealed join token, signed `JoinResponse`), `Renew` with proof of possession, the
  `Session` stream, the bbolt journal, `bcd status` over the root-only unix socket.
- Host inventory from sysfs, netlink and NVML; the `devices` converger writing CDI specs for
  `hold` bindings; the empty `access` section; `inventory.refresh`, `diag.nvml` and the
  self-terminating `node.reboot`.
- Release artifacts from CI (`.github/workflows/daemon.yml`, `release.yml`) and the install script.

`site` and `ramdisk` arrive in v0.2, `sim` with real TLS in v0.4 (PLAN.md §16).
