import { create, toBinary } from '@bufbuild/protobuf';
import type { DescMessage } from '@bufbuild/protobuf';
import { anyPack, timestampFromDate } from '@bufbuild/protobuf/wkt';
import { describe, expect, it } from 'vitest';
import {
  AgentFrameSchema,
  AgentRole,
  CommandBodySchema,
  CommandState,
  CommandUpdateSchema,
  DiagNvmlRequestSchema,
  DiagNvmlResultSchema,
  GpuResetRequestSchema,
  GpusSectionSchema,
  HelloSchema,
  INVENTORY_SECTIONS,
  JoinRequestSchema,
  Lane,
  MAX_COMMAND_BODY_BYTES,
  MAX_FRAME_BYTES,
  NODE_SPEC_SECTIONS,
  NodeInventorySchema,
  NodeSpecSchema,
  PROTOCOL_VERSION,
  ProtocolError,
  RenewRequestSchema,
  SecretRequestSchema,
  ServerFrameSchema,
  SignatureSchema,
  commandKinds,
  commandUpdateSigningInput,
  decodeAgentFrame,
  decodeCommandResult,
  decodeInventorySection,
  decodeServerFrame,
  encodeAgentFrame,
  encodeCommandResult,
  encodeServerFrame,
  inventorySectionSchemas,
  isCommandKind,
  isInventorySectionName,
  negotiateProtocolVersion,
  packCommandPayload,
  protocolRegistry,
  signingInput,
  site,
  driver,
  unpackCommandPayload,
  unwrapCommand,
  wrapCommand,
} from '@better-compute/protocol';
import type { CommandKind } from '@better-compute/protocol';

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof ProtocolError) return error.code;
    throw error;
  }
  throw new Error('expected a ProtocolError');
};

/** `name = number` for every field, in declaration order. */
const fieldsOf = (schema: DescMessage) => schema.fields.map((f) => `${f.name} = ${f.number}`);

describe('protocol frames', () => {
  const hello = create(AgentFrameSchema, {
    msg: {
      case: 'hello',
      value: { nodeId: 'node_1', bootId: 'boot_1', journalId: 'jrn_1', role: AgentRole.NODE },
    },
  });

  it('round-trips agent and server frames', () => {
    const decoded = decodeAgentFrame(encodeAgentFrame(hello));
    expect(decoded.msg.case).toBe('hello');
    expect(decoded.msg.case === 'hello' && decoded.msg.value.nodeId).toBe('node_1');
    const drain = create(ServerFrameSchema, {
      msg: { case: 'drain', value: { reconnectAfterMs: 1500, reason: 'deploy' } },
    });
    expect(decodeServerFrame(encodeServerFrame(drain))).toEqual(drain);
  });

  it('keeps unknown fields, so a relay forwards a newer peer losslessly', () => {
    // Field 99, varint 1: something a newer daemon sends that this schema does not know.
    const newer = new Uint8Array([...encodeAgentFrame(hello), 0x98, 0x06, 0x01]);
    expect(encodeAgentFrame(decodeAgentFrame(newer))).toEqual(newer);
  });

  it('bounds frame sizes before parsing and rejects garbage', () => {
    expect(code(() => decodeAgentFrame(new Uint8Array(MAX_FRAME_BYTES + 1)))).toBe(
      'FRAME_TOO_LARGE',
    );
    expect(code(() => decodeServerFrame(new Uint8Array([0xff, 0xff, 0xff])))).toBe('INVALID_FRAME');
  });

  it('wraps and unwraps command bodies, bounded to 1 MiB', () => {
    const body = create(CommandBodySchema, {
      id: 'cmd_1',
      nodeId: 'node_1',
      seq: 1n,
      kind: 'inventory.refresh',
      lane: Lane.CONTROL,
      notAfter: timestampFromDate(new Date('2026-09-23T12:00:00Z')),
    });
    const command = wrapCommand(body);
    expect(command.attempt).toBe(1);
    expect(command.body).toEqual(toBinary(CommandBodySchema, body));
    expect(unwrapCommand(command)).toEqual(body);
    const huge = create(CommandBodySchema, { id: 'x'.repeat(MAX_COMMAND_BODY_BYTES) });
    expect(code(() => wrapCommand(huge))).toBe('FRAME_TOO_LARGE');
  });
});

describe('protocol command kinds', () => {
  it('describes each v0.1 kind with its request and result messages', () => {
    expect(Object.keys(commandKinds).sort()).toEqual([
      'diag.nvml',
      'gpu.reset',
      'inventory.refresh',
      'logs.collect',
      'node.reboot',
    ]);
    for (const [kind, spec] of Object.entries(commandKinds)) {
      expect(spec.payload.typeName, kind).toMatch(/^bettercompute\.agent\.v1\.\w+Request$/);
      expect(spec.result.typeName, kind).toMatch(/^bettercompute\.agent\.v1\.\w+Result$/);
      expect(spec.lane, kind).not.toBe(Lane.UNSPECIFIED);
      expect(spec.roles.length, kind).toBeGreaterThan(0);
    }
    // PLAN.md §6: gpu.reset is not retry-safe; reboot is self-terminating; diag.* is attested.
    expect(commandKinds['gpu.reset'].retrySafe).toBe(false);
    expect(commandKinds['node.reboot'].selfTerminating).toBe(true);
    expect(commandKinds['diag.nvml'].attested).toBe(true);
    expect(commandKinds['logs.collect'].lane).toBe(Lane.BULK);
  });

  it('packs and unpacks payloads and results by kind', () => {
    const request = create(DiagNvmlRequestSchema, { gpuUuids: ['GPU-1'], expectedGpuCount: 1 });
    const any = packCommandPayload('diag.nvml', request);
    expect(any.typeUrl).toBe('type.googleapis.com/bettercompute.agent.v1.DiagNvmlRequest');
    expect(unpackCommandPayload('diag.nvml', any)).toEqual(request);
    const result = create(DiagNvmlResultSchema, { passed: true, gpuCount: 1 });
    expect(decodeCommandResult('diag.nvml', encodeCommandResult('diag.nvml', result))).toEqual(
      result,
    );
  });

  it('fails closed on unknown kinds and mismatched payloads', () => {
    expect(isCommandKind('diag.nvml')).toBe(true);
    expect(isCommandKind('toString')).toBe(false);
    expect(isCommandKind('wipe')).toBe(false);
    const reset = create(GpuResetRequestSchema, { gpuUuids: ['GPU-1'] });
    expect(code(() => packCommandPayload('diag.nvml', reset as never))).toBe('PAYLOAD_MISMATCH');
    expect(
      code(() => unpackCommandPayload('diag.nvml', anyPack(GpuResetRequestSchema, reset))),
    ).toBe('PAYLOAD_MISMATCH');
    expect(code(() => unpackCommandPayload('diag.nvml', undefined))).toBe('PAYLOAD_MISMATCH');
    expect(code(() => decodeCommandResult('wipe' as CommandKind, new Uint8Array()))).toBe(
      'UNKNOWN_KIND',
    );
  });
});

describe('protocol sections', () => {
  it('names NodeInventory sections after its fields, with matching schemas', () => {
    const sectionFields = NodeInventorySchema.fields.filter((f) => f.number >= 10);
    expect(sectionFields.map((f) => f.name)).toEqual([...INVENTORY_SECTIONS]);
    for (const field of sectionFields)
      expect(field.message?.typeName).toBe(
        inventorySectionSchemas[field.name as keyof typeof inventorySectionSchemas].typeName,
      );
  });

  it('names NodeSpec sections after its fields, in converger order', () => {
    expect(NodeSpecSchema.fields.map((f) => f.name)).toEqual([...NODE_SPEC_SECTIONS]);
  });

  it('decodes section content by name and rejects unknown names', () => {
    const gpus = create(GpusSectionSchema, {
      driverVersion: '580.65.06',
      gpus: [{ uuid: 'GPU-1' }],
    });
    expect(decodeInventorySection('gpus', toBinary(GpusSectionSchema, gpus))).toEqual(gpus);
    expect(isInventorySectionName('constructor')).toBe(false);
    expect(code(() => decodeInventorySection('pci', new Uint8Array()))).toBe('UNKNOWN_SECTION');
  });
});

describe('protocol versions', () => {
  it('negotiates the highest common version', () => {
    expect(PROTOCOL_VERSION).toEqual({ min: 1, max: 1 });
    expect(negotiateProtocolVersion({ min: 1, max: 3 }, { min: 2, max: 4 })).toBe(3);
    expect(negotiateProtocolVersion({ min: 1, max: 1 })).toBe(1);
    expect(negotiateProtocolVersion({ min: 2, max: 2 }, { min: 1, max: 1 })).toBeUndefined();
  });
});

describe('protocol signing inputs', () => {
  it('is prefix ‖ purpose ‖ NUL ‖ length-prefixed parts', () => {
    const input = signingInput('command', [new Uint8Array([1, 2]), new Uint8Array()]);
    const prefix = new TextEncoder().encode('bettercompute.v1/command\0');
    expect([...input]).toEqual([...prefix, 0, 0, 0, 2, 1, 2, 0, 0, 0, 0]);
  });

  it('separates purposes and splits parts unambiguously', () => {
    const parts = [new Uint8Array([7])];
    expect(signingInput('command', parts)).not.toEqual(signingInput('desired-state', parts));
    expect(signingInput('command', [new Uint8Array([1, 2])])).not.toEqual(
      signingInput('command', [new Uint8Array([1]), new Uint8Array([2])]),
    );
  });

  it('requires 32-byte digests', () => {
    expect(
      code(() =>
        commandUpdateSigningInput({
          commandId: 'cmd_1',
          state: CommandState.SUCCEEDED,
          resultSha256: new Uint8Array(31),
        }),
      ),
    ).toBe('INVALID_SIGNING_INPUT');
  });
});

describe('protocol contract shape (PLAN.md §7.7)', () => {
  it('keeps the planned frame numbering', () => {
    expect(fieldsOf(AgentFrameSchema)).toEqual([
      'hello = 1',
      'heartbeat = 2',
      'update = 3',
      'events = 4',
      'status = 5',
      'inventory = 6',
      'spec_request = 7',
      'secret_request = 8',
    ]);
    expect(fieldsOf(ServerFrameSchema)).toEqual([
      'welcome = 1',
      'command = 2',
      'cancel = 3',
      'desired = 4',
      'ack = 5',
      'open_tunnel = 6',
      'drain = 7',
      'revoked = 8',
      'secret = 9',
    ]);
  });

  it('keeps the planned fields of the sketched messages', () => {
    expect(fieldsOf(HelloSchema).slice(0, 15)).toEqual([
      'node_id = 1',
      'boot_id = 2',
      'journal_id = 3',
      'role = 4',
      'daemon_version = 5',
      'proto_min = 6',
      'proto_max = 7',
      'capabilities = 8',
      'drivers = 9',
      'last_epoch = 10',
      'applied_generation = 11',
      'unacked_results = 12',
      'running_command_ids = 13',
      'last_event_seq = 14',
      'inventory_hashes = 15',
    ]);
    expect(fieldsOf(CommandBodySchema).slice(0, 13)).toEqual([
      'id = 1',
      'node_id = 2',
      'seq = 3',
      'kind = 4',
      'payload = 5',
      'lane = 6',
      'not_after = 7',
      'min_generation = 8',
      'retry_safe = 9',
      'idempotency_key = 10',
      'traceparent = 11',
      'self_terminating = 12',
      'attested = 13',
    ]);
    expect(fieldsOf(CommandUpdateSchema).slice(0, 5)).toEqual([
      'command_id = 1',
      'state = 2',
      'result = 3',
      'boot_id = 4',
      'node_sig = 5',
    ]);
    expect(fieldsOf(JoinRequestSchema).slice(0, 3)).toEqual([
      'sealed_token = 1',
      'csr = 2',
      'claims = 3',
    ]);
    expect(fieldsOf(RenewRequestSchema)).toEqual([
      'csr = 1',
      'chain = 2',
      'client_time = 3',
      'pop_sig = 4',
    ]);
    expect(fieldsOf(SecretRequestSchema).slice(0, 6)).toEqual([
      'ref = 1',
      'workflow_id = 2',
      'step_id = 3',
      'allocation_id = 4',
      'epk = 5',
      'node_sig = 6',
    ]);
    expect(fieldsOf(SignatureSchema)).toEqual(['kid = 1', 'sig = 2', 'chain = 3']);
  });

  it('registers every package for Any and JSON, with drafts namespaced', () => {
    expect(protocolRegistry.getMessage('bettercompute.agent.v1.DiagNvmlRequest')).toBeDefined();
    expect(protocolRegistry.getMessage('bettercompute.site.v1.DiscoveryAssertion')).toBeDefined();
    expect(protocolRegistry.getService('bettercompute.driver.v1.DriverPlugin')).toBeDefined();
    expect(site.BootLeaseStateSchema.typeName).toBe('bettercompute.site.v1.BootLeaseState');
    expect(driver.DriverPlugin.typeName).toBe('bettercompute.driver.v1.DriverPlugin');
  });
});
