import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { create } from '@bufbuild/protobuf';
import { anyPack } from '@bufbuild/protobuf/wkt';
import {
  CommandBodySchema,
  decodeMessage,
  InstanceSnapshotRequestSchema,
  InstanceSnapshotResultSchema,
  NodeRebootRequestSchema,
} from '@better-compute/protocol';
import {
  fakeHardware,
  fakeInstanceSnapshot,
  type FakeKindContext,
  type FakeSnapshot,
} from '@better-compute/testing';

// The FakeDaemon's `instance.snapshot` (sandboxes, PLAN.md §3.7): captures the instance on the
// host's fake hypervisor, uploads it to the presigned URL and reports InstanceSnapshotResult.

const hardware = fakeHardware({ seed: 'node_snap' });
const bytes = new TextEncoder().encode('snapshot-bytes');
const captured: FakeSnapshot = {
  bytes,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  runtime: 'cloud-hypervisor',
  includeMemory: true,
};

function context(
  payload: ReturnType<typeof anyPack> | undefined,
  snapshot?: FakeKindContext['snapshot'],
): { ctx: FakeKindContext; uploads: Map<string, Uint8Array> } {
  const uploads = new Map<string, Uint8Array>();
  const ctx: FakeKindContext = {
    nodeId: 'node_snap',
    bootId: 'boot',
    daemonVersion: '0.5.0',
    hardware,
    knobs: { diag: {}, logs: {}, cdiWriteFailures: 0 },
    body: create(CommandBodySchema, {
      id: 'cmd_1',
      kind: 'instance.snapshot',
      ...(payload ? { payload } : {}),
    }),
    now: () => 0,
    collectInventory: () => [],
    sendInventory: () => {},
    assignedDevices: () => new Set(),
    upload: (url, data) => uploads.set(url, data),
    ...(snapshot ? { snapshot } : {}),
  };
  return { ctx, uploads };
}

const request = (includeMemory: boolean, uploadUrl = 'https://store.example/put/snap_1') =>
  anyPack(
    InstanceSnapshotRequestSchema,
    create(InstanceSnapshotRequestSchema, {
      instanceId: 'inst_1',
      uploadUrl,
      imageId: 'snap_1',
      includeMemory,
    }),
  );

describe('fake instance.snapshot', () => {
  it('uploads the capture and reports its size, sha256, runtime and the host CPU model', async () => {
    const calls: [string, boolean][] = [];
    const { ctx, uploads } = context(request(true), (instanceId, includeMemory) => {
      calls.push([instanceId, includeMemory]);
      return captured;
    });
    const outcome = await fakeInstanceSnapshot.run!(ctx);
    expect(outcome.outcome).toBe('succeeded');
    expect(calls).toEqual([['inst_1', true]]);
    expect(uploads.get('https://store.example/put/snap_1')).toEqual(bytes);
    const result = decodeMessage(InstanceSnapshotResultSchema, outcome.result!);
    expect(result.uploadedBytes).toBe(BigInt(bytes.byteLength));
    expect(Buffer.from(result.sha256).toString('hex')).toBe(captured.sha256);
    expect(result.runtime).toBe('cloud-hypervisor');
    expect(result.cpuModel).toBe(hardware.inventory.cpu!.model);
    expect(fakeInstanceSnapshot).toMatchObject({ roles: [expect.anything()] });

    // Disk only: no CPU model to match on restore.
    const disk = await fakeInstanceSnapshot.run!(context(request(false), () => captured).ctx);
    expect(decodeMessage(InstanceSnapshotResultSchema, disk.result!).cpuModel).toBe('');
  });

  it('fails without a hypervisor, for a missing instance, and on a bad payload or URL', async () => {
    expect(await fakeInstanceSnapshot.run!(context(request(true)).ctx)).toMatchObject({
      outcome: 'failed',
      code: 'unsupported',
    });
    expect(
      await fakeInstanceSnapshot.run!(
        context(request(true), () => {
          throw new Error('no instance inst_1 on this host');
        }).ctx,
      ),
    ).toMatchObject({ outcome: 'failed', code: 'instance-missing' });
    expect(
      await fakeInstanceSnapshot.run!(
        context(request(true, 'http://store.example/x'), () => captured).ctx,
      ),
    ).toMatchObject({ outcome: 'failed', code: 'invalid-payload' });
    expect(
      await fakeInstanceSnapshot.run!(
        context(
          anyPack(NodeRebootRequestSchema, create(NodeRebootRequestSchema, {})),
          () => captured,
        ).ctx,
      ),
    ).toMatchObject({ outcome: 'failed', code: 'invalid-payload' });
  });
});
