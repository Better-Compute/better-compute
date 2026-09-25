// Golden vectors for the agent wire protocol (PLAN.md §15 "protocol golden frames shared with Go").
// packages/protocol/golden holds, per vector, the proto3 JSON (<name>.json) and the binary encoding
// as lowercase hex (<name>.hex); index.json lists them with their message type, and signing.json
// fixes the signing-input layout. The Go tests check the same files: protojson.Unmarshal(json) must
// proto.Equal the decoded hex, and proto.MarshalOptions{Deterministic: true} must reproduce the hex.
//
// Regenerate after an intentional change: UPDATE_GOLDEN=1 vitest run tests/protocol-golden.test.ts
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { create, equals, fromBinary, fromJson, toBinary, toJson } from '@bufbuild/protobuf';
import type { DescMessage, JsonValue, MessageShape } from '@bufbuild/protobuf';
import { TimestampSchema, timestampFromDate } from '@bufbuild/protobuf/wkt';
import { format, resolveConfig } from 'prettier';
import { describe, expect, it } from 'vitest';
import {
  AgentFrameSchema,
  AgentRole,
  AttestedReportBodySchema,
  Binding,
  CommandBodySchema,
  CommandState,
  CommandUpdateSchema,
  DesiredStateBodySchema,
  DiagNvmlRequestSchema,
  DiagNvmlResultSchema,
  Lane,
  RunsOn,
  ServerFrameSchema,
  TrustBundleSchema,
  commandUpdateSigningInput,
  encodeCommandResult,
  packCommandPayload,
  protocolRegistry,
  renewPopSigningInput,
  secretRequestSigningInput,
  signingInput,
  wrapAttestedReport,
  wrapCommand,
  wrapDesiredState,
  workloadTokenRequestSigningInput,
  batchApprovalSigningInput,
  batchLeafInput,
  batchNodeInput,
  approverSetInput,
  approverSetSigningInput,
} from '@better-compute/protocol';
import type { SigningPurpose } from '@better-compute/protocol';

const goldenDir = fileURLToPath(new URL('../packages/protocol/golden/', import.meta.url));
const updating = process.env.UPDATE_GOLDEN === '1';

const digest = (value: string | Uint8Array) =>
  new Uint8Array(createHash('sha256').update(value).digest());
const filled = (length: number, value: number) => new Uint8Array(length).fill(value);
const hex = (value: Uint8Array) => Buffer.from(value).toString('hex');
const fromHex = (value: string) => new Uint8Array(Buffer.from(value, 'hex'));
const at = (iso: string) => timestampFromDate(new Date(iso));
const utf8 = (value: string) => new TextEncoder().encode(value);
function be(width: 4 | 8, value: bigint): Uint8Array {
  const out = new Uint8Array(width);
  const view = new DataView(out.buffer);
  if (width === 4) view.setUint32(0, Number(value));
  else view.setBigInt64(0, value);
  return out;
}

// Fixed ids and bytes, so every vector is reproducible. Signatures are placeholders: the vectors
// pin encodings, not cryptography.
const nodeId = 'node_01J8Z3Q4X5Y6Z7A8B9C0D1E2F3';
const bootId = '3f1c2a9e-5b7d-4e8f-9a0b-1c2d3e4f5a6b';
const journalId = 'jrn_01J8Z3Q4X5Y6Z7A8B9C0D1E2F4';
const commandId = 'cmd_01J8Z3R0000000000000000001';
const allocationId = 'alc_01J8Z3S0000000000000000001';
const nodeKid = 'lJ3xk0kS2k3m5n6p7q8r9s0t1u2v3w4x5y6z7a8b9c0';
const gpuA = 'GPU-4c1f2e3d-0a1b-4c5d-8e9f-0a1b2c3d4e5f';
const gpuB = 'GPU-9e8d7c6b-5a4f-4e3d-2c1b-0a9f8e7d6c5b';

const diagResult = create(DiagNvmlResultSchema, {
  passed: true,
  gpuCount: 2,
  driverVersion: '580.65.06',
  checks: [
    { name: 'nvml.init', passed: true },
    { name: 'gpu.count', passed: true },
  ],
  gpus: [
    { uuid: gpuA, passed: true, checks: [{ name: 'ecc.uncorrectable', passed: true }] },
    { uuid: gpuB, passed: true, checks: [{ name: 'ecc.uncorrectable', passed: true }] },
  ],
});
const diagResultBytes = encodeCommandResult('diag.nvml', diagResult);

const commandBody = create(CommandBodySchema, {
  id: commandId,
  nodeId,
  seq: 12n,
  kind: 'diag.nvml',
  payload: packCommandPayload(
    'diag.nvml',
    create(DiagNvmlRequestSchema, { gpuUuids: [gpuA, gpuB], expectedGpuCount: 2 }),
  ),
  lane: Lane.CONTROL,
  notAfter: at('2026-09-23T12:05:00Z'),
  minGeneration: 3n,
  retrySafe: true,
  idempotencyKey: `acceptance:${nodeId}:1`,
  traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
  attested: true,
});
const command = wrapCommand(commandBody);

const desiredBody = create(DesiredStateBodySchema, {
  nodeId,
  generation: 4n,
  baseGeneration: 0n,
  specHash: digest('spec:4'),
  spec: {
    case: 'full',
    value: {
      host: {},
      devices: {
        assignments: [
          {
            allocationId,
            reservationId: 'rsv_7w3k2m9q4x5y6z7a8b9c0d1e2f',
            binding: Binding.HOLD,
            devices: [
              { id: gpuA, deviceClass: 'gpu' },
              { id: gpuB, deviceClass: 'gpu' },
            ],
            env: [`BCD_ALLOCATION_ID=${allocationId}`],
          },
        ],
      },
      telemetry: {
        otlpEndpoint: 'https://otel.example.internal:4318',
        exportIntervalMs: 15000,
        resourceAttributes: ['site=fsn1-dc1'],
      },
    },
  },
  traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-a3ce929d0e0e4736-01',
});

const attestedBody = create(AttestedReportBodySchema, {
  nodeId,
  bootId,
  report: {
    case: 'allocationBound',
    value: {
      allocationId,
      generation: 4n,
      deviceIds: [gpuA, gpuB],
      cdiDevices: [`bcd.dev/gpu=${gpuA}`, `bcd.dev/gpu=${gpuB}`],
      cdiSpecPath: `/etc/cdi/bcd-${allocationId}.json`,
      envFile: `/run/bcd/allocations/${allocationId}.env`,
    },
  },
});

const commandUpdate = create(CommandUpdateSchema, {
  commandId,
  state: CommandState.SUCCEEDED,
  result: diagResultBytes,
  bootId,
  nodeSig: { kid: nodeKid, sig: filled(64, 0x5a) },
});

interface Vector {
  name: string;
  description: string;
  schema: DescMessage;
  message: MessageShape<DescMessage>;
}

const vectors: Vector[] = [
  {
    name: 'hello',
    description: 'AgentFrame.hello after a reconnect, with a replayed result and inventory hashes',
    schema: AgentFrameSchema,
    message: create(AgentFrameSchema, {
      msg: {
        case: 'hello',
        value: {
          nodeId,
          bootId,
          journalId,
          role: AgentRole.NODE,
          daemonVersion: '0.1.0',
          protoMin: 1,
          protoMax: 1,
          capabilities: ['cdi', 'nvml'],
          drivers: [
            {
              id: 'nvidia',
              version: '0.1.0',
              kinds: ['config'],
              runsOn: RunsOn.NODE,
              configSchemaJson: '{"type":"object"}',
            },
          ],
          lastEpoch: 6n,
          appliedGeneration: 3n,
          unackedResults: [commandUpdate],
          lastEventSeq: 42n,
          // Sorted keys: Go's deterministic marshalling writes map entries in key order.
          inventoryHashes: {
            cpu: digest('section:cpu'),
            gpus: digest('section:gpus'),
            system: digest('section:system'),
          },
          appliedSpecHash: digest('spec:3'),
        },
      },
    }),
  },
  {
    name: 'welcome',
    description: 'ServerFrame.welcome with default liveness settings and a signed trust bundle',
    schema: ServerFrameSchema,
    message: create(ServerFrameSchema, {
      msg: {
        case: 'welcome',
        value: {
          epoch: 7n,
          sessionId: 'ses_01J8Z3T0000000000000000001',
          gatewayId: 'gw-fsn1-a',
          protocolVersion: 1,
          heartbeatIntervalMs: 10000,
          leaseTtlMs: 40000,
          credits: [
            { lane: Lane.CONTROL, credits: 8 },
            { lane: Lane.PROVISION, credits: 4 },
            { lane: Lane.BULK, credits: 2 },
          ],
          ackedEventSeq: 40n,
          requestSections: ['gpus'],
          serverTime: at('2026-09-23T12:00:00Z'),
          trust: {
            body: toBinary(TrustBundleSchema, create(TrustBundleSchema, { version: 1n })),
            signature: { kid: 'join-signing-1', sig: filled(64, 0x11) },
          },
        },
      },
    }),
  },
  {
    name: 'command-body',
    description: 'CommandBody for diag.nvml (the signed bytes inside Command.body)',
    schema: CommandBodySchema,
    message: commandBody,
  },
  {
    name: 'command',
    description: 'ServerFrame.command carrying the command-body vector, unsigned (v0.1)',
    schema: ServerFrameSchema,
    message: create(ServerFrameSchema, { msg: { case: 'command', value: command } }),
  },
  {
    name: 'desired-state-body',
    description: 'DesiredStateBody: a full NodeSpec with one CDI hold of two GPUs',
    schema: DesiredStateBodySchema,
    message: desiredBody,
  },
  {
    name: 'desired-state',
    description: 'ServerFrame.desired carrying the desired-state-body vector, signed',
    schema: ServerFrameSchema,
    message: create(ServerFrameSchema, {
      msg: {
        case: 'desired',
        value: wrapDesiredState(desiredBody, {
          signature: {
            kid: 'worker-2026-09-23',
            sig: filled(64, 0x22),
            chain: [filled(16, 0x33)],
          },
        }),
      },
    }),
  },
  {
    name: 'diag-nvml-result',
    description: 'DiagNvmlResult (the bytes inside CommandUpdate.result)',
    schema: DiagNvmlResultSchema,
    message: diagResult,
  },
  {
    name: 'command-update',
    description: 'AgentFrame.update: diag.nvml succeeded, node-signed',
    schema: AgentFrameSchema,
    message: create(AgentFrameSchema, { msg: { case: 'update', value: commandUpdate } }),
  },
  {
    name: 'attested-report-body',
    description: 'AttestedReportBody: AllocationBound for the two-GPU hold',
    schema: AttestedReportBodySchema,
    message: attestedBody,
  },
  {
    name: 'event-batch',
    description: 'AgentFrame.events: an attested AllocationBound and an AllocationFailed',
    schema: AgentFrameSchema,
    message: create(AgentFrameSchema, {
      msg: {
        case: 'events',
        value: {
          journalId,
          events: [
            {
              seq: 41n,
              observedAt: at('2026-09-23T12:00:05Z'),
              body: {
                case: 'attested',
                value: wrapAttestedReport(attestedBody, {
                  nodeSig: { kid: nodeKid, sig: filled(64, 0x44) },
                }),
              },
            },
            {
              seq: 42n,
              observedAt: at('2026-09-23T12:00:06Z'),
              body: {
                case: 'allocationFailed',
                value: {
                  allocationId: 'alc_01J8Z3S0000000000000000002',
                  generation: 4n,
                  reason: 'overlap',
                  message: `${gpuA} is assigned to ${allocationId}`,
                },
              },
            },
          ],
        },
      },
    }),
  },
];

// Signing inputs: `parts` are built here independently of the helpers, and `input` must equal both
// signingInput(purpose, parts) and the typed builder's output.
const resultSha256 = digest(diagResultBytes);
const csrSha256 = digest('csr');
const clientTime = create(TimestampSchema, { seconds: 1790164800n, nanos: 500 });
const epk = filled(65, 0x04);
const secretRequest = {
  requestId: 'req-1',
  ref: `secret://bmc/${nodeId}`,
  workflowId: 'wf_01J8Z3U0000000000000000001',
  stepId: 'power',
  allocationId: '',
  epk,
};
// The quorum fields of a trust bundle, deliberately out of kid order (the canonical bytes sort them).
const approverSet = {
  approverKeys: [
    { kid: 'zz-second', spkiDer: filled(91, 0x22) },
    { kid: 'aa-first', spkiDer: filled(91, 0x11) },
  ],
  approverThreshold: 2,
  quorumTiers: [
    { maxScopeSize: 5, threshold: 1 },
    { maxScopeSize: 100, threshold: 2 },
  ],
  unbatchedDestructivePerHour: 0,
};
const signingVectors: {
  name: string;
  purpose: SigningPurpose;
  parts: Uint8Array[];
  built: Uint8Array;
}[] = [
  {
    name: 'command',
    purpose: 'command',
    parts: [command.body],
    built: signingInput('command', [command.body]),
  },
  {
    name: 'command-update',
    purpose: 'command-update',
    parts: [utf8(commandId), be(4, BigInt(CommandState.SUCCEEDED)), resultSha256],
    built: commandUpdateSigningInput({ commandId, state: CommandState.SUCCEEDED, resultSha256 }),
  },
  {
    name: 'secret-request',
    purpose: 'secret-request',
    parts: [
      utf8(secretRequest.requestId),
      utf8(secretRequest.ref),
      utf8(secretRequest.workflowId),
      utf8(secretRequest.stepId),
      utf8(secretRequest.allocationId),
      epk,
    ],
    built: secretRequestSigningInput(secretRequest),
  },
  {
    name: 'workload-token',
    purpose: 'workload-token',
    parts: [
      utf8('wtr-1'),
      utf8('inst_01k5w000000000000000000001'),
      utf8('https://vault.acme.test'),
      epk,
    ],
    built: workloadTokenRequestSigningInput({
      requestId: 'wtr-1',
      instanceId: 'inst_01k5w000000000000000000001',
      audience: 'https://vault.acme.test',
      epk,
    }),
  },
  {
    name: 'batch-approval',
    purpose: 'batch-approval',
    parts: [
      utf8('batch_01k5w000000000000000000001'),
      filled(32, 0xab),
      be(4, 412n),
      new Uint8Array([...be(8, clientTime.seconds), ...be(4, BigInt(clientTime.nanos))]),
      utf8('compute.acme.test'),
    ],
    built: batchApprovalSigningInput({
      batchId: 'batch_01k5w000000000000000000001',
      scopeRoot: filled(32, 0xab),
      scopeSize: 412,
      notAfter: clientTime,
      trustDomain: 'compute.acme.test',
    }),
  },
  {
    name: 'approver-set',
    purpose: 'approver-set',
    parts: [be(8, 7n), digest(approverSetInput(approverSet))],
    built: approverSetSigningInput({ version: 7n, setSha256: digest(approverSetInput(approverSet)) }),
  },
  {
    name: 'renew-pop',
    purpose: 'renew-pop',
    parts: [
      csrSha256,
      utf8(nodeId),
      new Uint8Array([...be(8, clientTime.seconds), ...be(4, BigInt(clientTime.nanos))]),
    ],
    built: renewPopSigningInput({ csrSha256, nodeId, clientTime }),
  },
];
// The batch scope tree (v1.0 quorum, BatchApproval in session.proto), computed here with node's
// SHA-256 from the documented layouts: leaves ordered by hash, an odd node promoted unchanged, and
// each leaf's proof as sibling hashes from the bottom. pki and bcd must reproduce batch-scope.json.
const sha256 = (bytes: Uint8Array) => new Uint8Array(createHash('sha256').update(bytes).digest());
const batchId = 'batch_01k5w000000000000000000001';
// Subjects: a node's own id, a BMC behind a site agent (site-qualified), and a payload-bound leaf.
const scopeEntries = [
  { subject: 'node_01k5w000000000000000000003', kind: 'disk.wipe', payloadSha256: '' },
  {
    subject: 'bmc:node_01k5w0000000000000000000s1/10.0.0.5',
    kind: 'bmc.power',
    payloadSha256: '',
  },
  {
    subject: 'node_01k5w000000000000000000002',
    kind: 'deploy.image',
    payloadSha256: hex(digest('deploy image payload')),
  },
];
function batchScope() {
  const leaves = scopeEntries
    .map((entry) => ({
      ...entry,
      hash: sha256(
        batchLeafInput(batchId, entry.subject, entry.kind, fromHex(entry.payloadSha256)),
      ),
    }))
    .sort((a, b) => Buffer.compare(a.hash, b.hash));
  const proofs = leaves.map(() => [] as Uint8Array[]);
  let level = leaves.map((leaf, index) => ({ hash: leaf.hash, members: [index] }));
  while (level.length > 1) {
    const next: typeof level = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1];
      if (!right) {
        next.push(left); // promoted unchanged, no sibling at this level
        continue;
      }
      for (const member of left.members) proofs[member]!.push(right.hash);
      for (const member of right.members) proofs[member]!.push(left.hash);
      next.push({
        hash: sha256(batchNodeInput(left.hash, right.hash)),
        members: [...left.members, ...right.members],
      });
    }
    level = next;
  }
  return {
    batchId,
    root: hex(level[0]!.hash),
    leaves: leaves.map((leaf, index) => ({
      index,
      subject: leaf.subject,
      kind: leaf.kind,
      payloadSha256: leaf.payloadSha256,
      leafInput: hex(
        batchLeafInput(batchId, leaf.subject, leaf.kind, fromHex(leaf.payloadSha256)),
      ),
      hash: hex(leaf.hash),
      siblings: proofs[index]!.map(hex),
    })),
  };
}
const signingJson = () =>
  signingVectors.map(({ name, purpose, parts, built }) => ({
    name,
    purpose,
    parts: parts.map(hex),
    input: hex(built),
  }));
const indexJson = () =>
  vectors.map(({ name, description, schema }) => ({ name, type: schema.typeName, description }));

const jsonOptions = { registry: protocolRegistry };
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as JsonValue;
const readHex = (path: string) => readFileSync(path, 'utf8').trim();

if (updating) {
  const prettier = await resolveConfig(fileURLToPath(new URL('../package.json', import.meta.url)));
  const writeJson = async (path: string, value: unknown) =>
    writeFileSync(path, await format(JSON.stringify(value), { ...prettier, parser: 'json' }));
  mkdirSync(goldenDir, { recursive: true });
  await writeJson(`${goldenDir}index.json`, indexJson());
  for (const { name, schema, message } of vectors) {
    await writeJson(`${goldenDir}${name}.json`, toJson(schema, message, jsonOptions));
    writeFileSync(`${goldenDir}${name}.hex`, `${hex(toBinary(schema, message))}\n`);
  }
  await writeJson(`${goldenDir}signing.json`, signingJson());
  await writeJson(`${goldenDir}batch-scope.json`, batchScope());
}

describe('protocol golden vectors', () => {
  it('index.json lists every vector with its message type', () => {
    expect(existsSync(`${goldenDir}index.json`), 'run with UPDATE_GOLDEN=1 to create').toBe(true);
    expect(readJson(`${goldenDir}index.json`)).toEqual(indexJson());
  });

  for (const { name, schema, message } of vectors) {
    it(`${name}: the binary encoding matches ${name}.hex`, () => {
      expect(hex(toBinary(schema, message))).toBe(readHex(`${goldenDir}${name}.hex`));
    });

    it(`${name}: the JSON encoding matches ${name}.json`, () => {
      expect(toJson(schema, message, jsonOptions)).toEqual(readJson(`${goldenDir}${name}.json`));
    });

    it(`${name}: the golden hex and JSON decode to the same message`, () => {
      const decoded = fromBinary(schema, fromHex(readHex(`${goldenDir}${name}.hex`)));
      const parsed = fromJson(schema, readJson(`${goldenDir}${name}.json`), jsonOptions);
      expect(equals(schema, decoded, message)).toBe(true);
      expect(equals(schema, parsed, message)).toBe(true);
      expect(hex(toBinary(schema, parsed))).toBe(readHex(`${goldenDir}${name}.hex`));
    });
  }

  it('signing inputs follow the documented layout and match signing.json', () => {
    for (const { purpose, parts, built } of signingVectors)
      expect(hex(built)).toBe(hex(signingInput(purpose, parts)));
    expect(readJson(`${goldenDir}signing.json`)).toEqual(signingJson());
  });

  it('the batch scope tree matches batch-scope.json, and every proof reaches the root', () => {
    const scope = batchScope();
    expect(readJson(`${goldenDir}batch-scope.json`)).toEqual(scope);
    // A verifier's walk: the index's bit at each level says which side the node is on; a level
    // where the node was promoted (last odd node) consumes no sibling.
    for (const leaf of scope.leaves) {
      let hash = fromHex(leaf.hash);
      let index = leaf.index;
      let width = scope.leaves.length;
      const siblings = leaf.siblings.map(fromHex);
      while (width > 1) {
        if (index % 2 === 1) hash = sha256(batchNodeInput(siblings.shift()!, hash));
        else if (index + 1 < width) hash = sha256(batchNodeInput(hash, siblings.shift()!));
        index = Math.floor(index / 2);
        width = Math.ceil(width / 2);
      }
      expect(siblings).toEqual([]);
      expect(hex(hash)).toBe(scope.root);
    }
    // Layout checks: tags, length prefixes (an unbound payload is lp(empty)), 32-byte digests only.
    expect(batchLeafInput('b', 'n', 'k')).toEqual(
      new Uint8Array([0, 0, 0, 0, 1, 98, 0, 0, 0, 1, 110, 0, 0, 0, 1, 107, 0, 0, 0, 0]),
    );
    expect(() => batchLeafInput('b', 'n', 'k', filled(31, 1))).toThrow(/32 bytes or empty/);
    // The approver set's canonical bytes sort keys by kid: order in the bundle does not matter.
    expect(hex(approverSetInput(approverSet))).toBe(
      hex(
        approverSetInput({
          ...approverSet,
          approverKeys: [...approverSet.approverKeys].reverse(),
        }),
      ),
    );
    expect(approverSetInput(approverSet).slice(0, 4)).toEqual(new Uint8Array([0, 0, 0, 2]));
    expect(batchNodeInput(filled(32, 1), filled(32, 2))[0]).toBe(1);
    expect(() => batchNodeInput(filled(31, 1), filled(32, 2))).toThrow(/32-byte/);
  });
});
