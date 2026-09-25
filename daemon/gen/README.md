# daemon/gen

This directory holds Go code generated from `proto/bettercompute/{common,agent,site,driver}/v1`.
It is committed, so building `bcd` never needs a code generator (PLAN.md §4.1, D1).

- **Messages:** `protoc-gen-go` v1.36.12.
- **Connect clients:** `protoc-gen-connect-go` v1.21.0, which generates `agentv1connect` (`AgentGateway`) and `driverv1connect`.
- **Generation:** `node scripts/daemon-proto-gen.mjs` runs the pinned buf from `node_modules` with
  `daemon/buf.gen.yaml`. That config is v2 with `paths=source_relative` and local plugins only. It
  never uses remote BSR plugins, so generation works offline and cannot drift. `clean: false` keeps
  this README.
- **Check:** `node scripts/daemon-proto-gen.mjs --check` generates into a temporary directory. It
  fails on missing, stale or extra `.go` files.

Do not edit these files by hand. Change the `.proto` and regenerate. The TypeScript side
(`packages/protocol/src/gen`) is generated from the same files.

`internal/inventory/types.go` and `encode.go` are older mirrors of `inventory.proto`, written by
`internal/inventory/mirror.mjs`. Golden tests pin their section bytes to protobuf-es output. They
go away once inventory encoding moves to `gen/` and `proto.Marshal` produces the same golden bytes.
