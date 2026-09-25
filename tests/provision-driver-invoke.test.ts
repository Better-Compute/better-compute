import { fromBinary } from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';
import { DriverInvokeRequestSchema, encodeMessageJson } from '@better-compute/protocol';
import { driverInvokeCommandKind, driverInvokeKind, provisionModule } from '@better-compute/provision';

// `driver.invoke` (§5.1, §5.5): provision registers the kind its engine sends for driver-operation
// steps, so the runtime's CommandQueue accepts and encodes it.

describe('the driver.invoke command kind', () => {
  it('is registered by provisionModule as a destructive, signed, non-retry-safe kind', () => {
    const kinds = provisionModule().commandKinds ?? [];
    expect(kinds).toContain(driverInvokeCommandKind);
    expect(driverInvokeCommandKind).toMatchObject({
      kind: driverInvokeKind,
      lane: 'provision',
      retrySafe: false,
      destructive: true,
      roles: ['node', 'site', 'ramdisk'],
      payload: { kind: 'message', typeName: 'bettercompute.agent.v1.DriverInvokeRequest' },
    });
  });

  it('carries the engine envelope as a DriverInvokeRequest', () => {
    // What engine.ts sends for a driver step run by a site agent for another node.
    const envelope = {
      workflowId: 'wf_1',
      stepId: 'wfs_1',
      attempt: 2,
      targetNodeId: 'node_x',
      args: { concern: 'power', operation: 'setPower', args: { action: 'cycle' }, config: { credentials: 'secret://root/bmc' } },
    };
    const bytes = encodeMessageJson(driverInvokeCommandKind.payload!.typeName, envelope);
    const decoded = fromBinary(DriverInvokeRequestSchema, bytes);
    expect(decoded).toMatchObject({ workflowId: 'wf_1', stepId: 'wfs_1', attempt: 2, targetNodeId: 'node_x' });
    expect(decoded.args).toEqual(envelope.args);
  });
});
