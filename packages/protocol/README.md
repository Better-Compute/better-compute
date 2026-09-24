# @better-compute/protocol

Wire contracts between the `bcd` daemon and the better-compute control plane: the protobuf-es code
generated from `proto/bettercompute`, plus small helpers. Browser-safe; the only dependency is
`@bufbuild/protobuf`.

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

## Packages

| Proto package             | Export                   | Stability                                      |
| ------------------------- | ------------------------ | ---------------------------------------------- |
| `bettercompute.common.v1` | top level                | frozen at the end of P0; additive only         |
| `bettercompute.agent.v1`  | top level                | frozen at the end of P0; additive only         |
| `bettercompute.site.v1`   | `site` namespace         | draft until v0.2, excluded from `buf breaking` |
| `bettercompute.driver.v1` | `driver` namespace (bcx) | draft until v0.5, excluded from `buf breaking` |

`agent/v1` holds the `AgentGateway` service (`Join`, `Renew`, the bidi `Session`, `Tunnel`), every
session frame, `NodeSpec` desired state (`inventory.proto` for NodeInventory v1, `commands.proto`
for the v0.1 command payloads). The proto comments are the reference for semantics: epoch fencing,
`not_after`, `min_generation`, `retry_safe`, `self_terminating`, `attested`, the journal-lost rule.

## Helpers

- `encodeAgentFrame` / `decodeAgentFrame`, `encodeServerFrame` / `decodeServerFrame`,
  `encodeMessage` / `decodeMessage`: `toBinary` / `fromBinary` with size bounds
  (`MAX_FRAME_BYTES`, `MAX_COMMAND_BODY_BYTES`, `MAX_SPEC_BODY_BYTES`). Unknown fields survive a
  decode and re-encode, so relays forward newer peers losslessly.
- `wrapCommand` / `unwrapCommand`, `wrapDesiredState` / `unwrapDesiredState`,
  `wrapAttestedReport` / `unwrapAttestedReport`, `unwrapJoinResponse`: signed envelopes carry their
  body as bytes, and signatures cover exactly those bytes.
- `commandKinds`, `CommandKind`, `packCommandPayload` / `unpackCommandPayload`,
  `encodeCommandResult` / `decodeCommandResult`: the v0.1 kinds (`diag.nvml`,
  `inventory.refresh`, `logs.collect`, `node.reboot`, `gpu.reset`) with their lane and flags.
- `INVENTORY_SECTIONS`, `inventorySectionSchemas`, `decodeInventorySection`,
  `NODE_SPEC_SECTIONS`. Canonicalizing and hashing sections belongs to `@better-compute/inventory`.
- `PROTOCOL_VERSION` and `negotiateProtocolVersion`.
- `signingInput(purpose, parts)`, `commandUpdateSigningInput`, `secretRequestSigningInput`,
  `renewPopSigningInput`: the bytes an ES256 signature covers,
  `"bettercompute.v1/" ‖ purpose ‖ 0x00 ‖ (uint32_be(len) ‖ part)*`. Signing and verifying live in
  the caller.
- `protocolRegistry` for `google.protobuf.Any` payloads and JSON.
- `ProtocolError` (`FRAME_TOO_LARGE`, `INVALID_FRAME`, `UNKNOWN_KIND`, `PAYLOAD_MISMATCH`,
  `UNKNOWN_SECTION`, `INVALID_SIGNING_INPUT`).

## Changing the protos

```sh
node scripts/proto-gen.mjs              # buf lint + buf generate into src/gen (committed)
node scripts/proto-gen.mjs --check      # lint, format and fail if src/gen is stale
node scripts/proto-gen.mjs --breaking   # buf breaking against proto/baseline.binpb
node scripts/proto-gen.mjs --baseline   # refresh the baseline when a release freezes protos
```

Only add fields, messages, enum values and oneof members; never renumber, retype or rename.
`buf breaking` (FILE rules) enforces it for `common` and `agent`. Generation uses local plugins
only; a remote BSR plugin would upload the protos. The Go plugins in `buf.gen.yaml` are commented
out until Go is installed.

## Golden vectors

`golden/` holds frames shared with the Go daemon's tests: `<name>.json` (proto3 JSON),
`<name>.hex` (binary), `index.json` (name, message type, description) and `signing.json`
(signing-input parts and bytes). Both languages must decode the hex and the JSON to equal messages
and re-encode the hex exactly (Go: `proto.MarshalOptions{Deterministic: true}`). The vectors are
written by `tests/protocol-golden.test.ts` with `UPDATE_GOLDEN=1`; changing one is a wire change.
