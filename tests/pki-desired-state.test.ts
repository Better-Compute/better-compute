import { describe, expect, it } from 'vitest';
import { toBinary } from '@bufbuild/protobuf';
import { nodeSpecColumn } from '@better-compute/gateway';
import {
  createCommandSigningAuthority,
  desiredStateBodyFromJson,
  desiredStateFromStored,
  storedDesiredState,
  verifyDesiredState,
} from '@better-compute/pki';
import { DesiredStateBodySchema } from '@better-compute/protocol';

// Signed NodeSpecs (PLAN.md §7.7, §13, v0.4 "signing of all commands and specs"): the spec writer signs the
// DesiredStateBody it stores; the gateway relays those bytes verbatim. One encoder serves both, so a signature
// always covers exactly what an unsigned gateway rendering would have sent.

const spec = {
  devices: {
    assignments: [
      {
        allocationId: 'alloc_1',
        reservationId: 'rsv_1',
        devices: [
          { id: 'GPU-1', deviceClass: 'gpu' },
          { id: 'GPU-2', deviceClass: 'gpu' },
        ],
      },
    ],
  },
  access: { sshPrincipals: ['root@node_1'] },
};

describe('desired state encoding and signatures', () => {
  it("encodes the same bytes as the gateway's unsigned rendering", async () => {
    const tx = { query: async () => ({ rows: [{ generation: 7, spec }], rowCount: 1 }) } as any;
    const rendered = await nodeSpecColumn.load(tx, 'node_1');
    const body = toBinary(DesiredStateBodySchema, desiredStateBodyFromJson({ nodeId: 'node_1', generation: 7, spec }));
    expect(Buffer.from(body).equals(Buffer.from(rendered!.body))).toBe(true);
  });

  it('signs what it stores, and the daemon verifies it under the command-signing root only', () => {
    const authority = createCommandSigningAuthority();
    const key = authority.issueWorkerKey({ workerId: 'worker-1' });
    const stored = storedDesiredState({ nodeId: 'node_1', generation: 3, spec }, key);
    expect(stored.signature).not.toBeNull();
    const state = desiredStateFromStored(stored.body, stored.signature);
    const options = { roots: [authority.certificate], now: Date.now(), nodeId: 'node_1', required: true };
    const body = verifyDesiredState(state, options);
    expect(body).toMatchObject({ nodeId: 'node_1', generation: 3n });
    expect(body.spec.case).toBe('full');

    // Another root, another node, a changed body, or no signature at all: refused.
    const rogue = createCommandSigningAuthority();
    expect(() => verifyDesiredState(state, { ...options, roots: [rogue.certificate] })).toThrow();
    expect(() => verifyDesiredState(state, { ...options, nodeId: 'node_2' })).toThrow();
    const other = storedDesiredState({ nodeId: 'node_1', generation: 4, spec }).body;
    expect(() => verifyDesiredState(desiredStateFromStored(other, stored.signature), options)).toThrow();
    expect(() => verifyDesiredState(desiredStateFromStored(stored.body, null), options)).toThrow();
    // Unsigned is fine only where the daemon does not require it.
    expect(
      verifyDesiredState(desiredStateFromStored(stored.body, null), { ...options, required: false }).generation,
    ).toBe(3n);
  });

  it('stores no signature without a key', () => {
    expect(storedDesiredState({ nodeId: 'node_1', generation: 1, spec: {} }).signature).toBeNull();
  });
});
