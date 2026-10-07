# @better-compute/protocol

Wire contracts between the `bcd` node daemon and the better-compute control plane: the protobuf-es code generated from `proto/bettercompute`, plus small framing, signing-input and command-kind helpers.

## Install

```sh
npm install @better-compute/protocol
```

It is also included in the umbrella package as `better-compute/protocol`:

```sh
npm install better-compute
```

`create` and the other message functions come from `@bufbuild/protobuf`, the package's only dependency; install it next to this package to call them directly.

## Usage

```ts
import { create } from '@bufbuild/protobuf';
import {
  CommandBodySchema,
  InventoryRefreshRequestSchema,
  Lane,
  ServerFrameSchema,
  encodeServerFrame,
  packCommandPayload,
  wrapCommand,
} from '@better-compute/protocol';

const request = create(InventoryRefreshRequestSchema, { sections: ['gpus'] });
const body = create(CommandBodySchema, {
  id,
  nodeId,
  seq,
  kind: 'inventory.refresh',
  payload: packCommandPayload('inventory.refresh', request),
  lane: Lane.CONTROL,
  notAfter,
  retrySafe: true,
});
const bytes = encodeServerFrame(
  create(ServerFrameSchema, { msg: { case: 'command', value: wrapCommand(body) } }),
);
```

The package is browser-safe. `bcd`, the Go side of these contracts, is built and tested against simulated and fake hardware but is not released as a binary yet.

## Packages

| Proto package             | Export                   | Stability                                           |
| ------------------------- | ------------------------ | --------------------------------------------------- |
| `bettercompute.common.v1` | top level                | stable; additive changes only                       |
| `bettercompute.agent.v1`  | top level                | stable; additive changes only                       |
| `bettercompute.site.v1`   | `site` namespace         | draft, may change; excluded from `buf breaking`     |
| `bettercompute.driver.v1` | `driver` namespace (bcx) | draft, may change; excluded from `buf breaking`     |

`agent/v1` holds the `AgentGateway` service (`Join`, `Renew`, the bidi `Session`, `Tunnel`), every session frame, `NodeSpec` desired state (`inventory.proto` for NodeInventory v1, `commands.proto` for the built-in command payloads). The proto comments are the reference for semantics: epoch fencing, `not_after`, `min_generation`, `retry_safe`, `self_terminating`, `attested`, the journal-lost rule.

## Helpers

- `encodeAgentFrame` / `decodeAgentFrame`, `encodeServerFrame` / `decodeServerFrame`, `encodeMessage` / `decodeMessage`: `toBinary` / `fromBinary` with size bounds (`MAX_FRAME_BYTES`, `MAX_COMMAND_BODY_BYTES`, `MAX_SPEC_BODY_BYTES`). Unknown fields survive a decode and re-encode, so relays forward newer peers losslessly.
- `encodeMessageJson(typeName, json)`: the binary encoding of a message given as proto3 JSON, resolved in `protocolRegistry`, for control-plane code that builds payloads as plain JSON.
- `wrapCommand` / `unwrapCommand`, `wrapDesiredState` / `unwrapDesiredState`, `wrapAttestedReport` / `unwrapAttestedReport`, `unwrapJoinResponse`: signed envelopes carry their body as bytes, and signatures cover exactly those bytes.
- `commandKinds`, `CommandKind`, `isCommandKind`, `packCommandPayload` / `unpackCommandPayload`, `encodeCommandResult` / `decodeCommandResult`: the built-in typed kinds (`diag.nvml`, `inventory.refresh`, `logs.collect`, `node.reboot`, `gpu.reset`) with their lane and flags.
- `INVENTORY_SECTIONS`, `inventorySectionSchemas`, `decodeInventorySection`, `NODE_SPEC_SECTIONS`. Canonicalizing and hashing sections belongs to `@better-compute/inventory`.
- `PROTOCOL_VERSION` and `negotiateProtocolVersion`.
- `signingInput(purpose, parts)`, `commandUpdateSigningInput`, `secretRequestSigningInput`, `renewPopSigningInput`, `workloadTokenRequestSigningInput` and the batch-approval inputs: the bytes an ES256 signature covers, `"bettercompute.v1/" ‖ purpose ‖ 0x00 ‖ (uint32_be(len) ‖ part)*`. Signing and verifying live in the caller.
- `protocolRegistry` for `google.protobuf.Any` payloads and JSON.
- `ProtocolError` (`FRAME_TOO_LARGE`, `INVALID_FRAME`, `UNKNOWN_KIND`, `PAYLOAD_MISMATCH`, `UNKNOWN_SECTION`, `INVALID_SIGNING_INPUT`).

## Changing the protos

In the [better-compute repository](https://github.com/better-compute/better-compute/tree/main/proto/bettercompute):

```sh
node scripts/proto-gen.mjs              # buf lint + buf generate into src/gen (committed)
node scripts/proto-gen.mjs --check      # lint, format and fail if src/gen is stale
node scripts/proto-gen.mjs --breaking   # buf breaking against proto/baseline.binpb
node scripts/proto-gen.mjs --baseline   # refresh the baseline when a release freezes protos
```

Only add fields, messages, enum values and oneof members; never renumber, retype or rename. `buf breaking` (FILE rules) enforces it for `common` and `agent`. Generation uses local plugins only; a remote BSR plugin would upload the protos. The daemon's Go code is generated separately, by `node scripts/daemon-proto-gen.mjs`.

## Golden vectors

The repository's [`packages/protocol/golden/`](https://github.com/better-compute/better-compute/tree/main/packages/protocol/golden) directory (not part of the npm package) holds frames shared with the Go daemon's tests: `<name>.json` (proto3 JSON), `<name>.hex` (binary), `index.json` (name, message type, description) and `signing.json` (signing-input parts and bytes). Both languages must decode the hex and the JSON to equal messages and re-encode the hex exactly (Go: `proto.MarshalOptions{Deterministic: true}`). The vectors are written by the protocol golden test with `UPDATE_GOLDEN=1`; changing one is a wire change.

## Documentation

- [Protocol reference](https://better-compute.com/docs/reference/protocol)
- [Daemon protocol](https://better-compute.com/docs/daemon/protocol)
- [Command kinds](https://better-compute.com/docs/reference/command-kinds)

## License

[Apache License 2.0](https://github.com/better-compute/better-compute/blob/main/LICENSE)
