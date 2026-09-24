# daemon/gen

Go code generated from `proto/bettercompute/{common,agent,site,driver}/v1`, committed so that
building `bcd` never needs a code generator (PLAN.md §4.1, D1).

It is empty in P0. `scripts/proto-gen.mjs` will fill it with `protoc-gen-go` (messages) and
`protoc-gen-connect-go` (the `AgentGateway` client) once both plugins are installed locally, the
same way it generates `packages/protocol/src/gen` with `protoc-gen-es`:

- plugins run **locally**, pinned by version; never a remote BSR plugin, so generation works
  offline and cannot change under us;
- `node scripts/proto-gen.mjs --check` (in `pnpm check`) fails when the committed code differs
  from a fresh generation;
- the Go package path is `github.com/better-compute/better-compute/daemon/gen/...`, set with
  `go_package` options in the `.proto` files or `buf.gen.yaml` managed mode.

Until then the daemon mirrors the messages it needs, each marked `TODO(v0.1)`:

- `internal/inventory/types.go` and `encode.go`, generated from `inventory.proto` by
  `internal/inventory/mirror.mjs` (structs named as protoc-gen-go names them, plus a proto3 binary
  encoder pinned to protobuf-es output by golden tests);
- hand-written `dispatch.Command` (CommandBody), `session.Hello`, `session.Welcome` and
  `session.Ack`.

When `gen/` lands, those files go away and the golden section bytes must come out of
`proto.Marshal` unchanged.
