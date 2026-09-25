import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { create, type MessageInitShape } from '@bufbuild/protobuf';
import { anyPack } from '@bufbuild/protobuf/wkt';
import {
  CommandBodySchema,
  InstanceDesiredState,
  InstancesSectionSchema,
  type InstanceSpecSchema,
  decodeMessage,
  InstanceSnapshotRequestSchema,
  InstanceSnapshotResultSchema,
  NodeRebootRequestSchema,
} from '@better-compute/protocol';
import {
  FakeHypervisor,
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

describe('FakeHypervisor snapshot round trip', () => {
  const section = (specs: MessageInitShape<typeof InstanceSpecSchema>[]) =>
    create(InstancesSectionSchema, { instances: specs });
  const spec = (
    instanceId: string,
    extra: Partial<MessageInitShape<typeof InstanceSpecSchema>> = {},
  ): MessageInitShape<typeof InstanceSpecSchema> => ({
    instanceId,
    desiredState: InstanceDesiredState.RUNNING,
    runtime: 'cloud-hypervisor',
    allocationId: `alloc_${instanceId}`,
    vcpu: 2,
    memoryBytes: 4n << 30n,
    diskBytes: 20n << 30n,
    image: {
      url: 'https://images.example/base.raw',
      sha256: new Uint8Array(32).fill(1),
      format: 'raw',
    },
    nics: [],
    ...extra,
  });

  it('brings guest memory back on another host sharing the store; disk-only snapshots do not', () => {
    const store = new Map<string, Uint8Array>();
    const source = new FakeHypervisor({ runtimes: ['cloud-hypervisor'], snapshotStore: store });
    const target = new FakeHypervisor({ runtimes: ['cloud-hypervisor'], snapshotStore: store });
    source.converge(section([spec('inst_src')]));
    source.domains.get('inst_src')!.memory = 'python> x = 42';
    const withMemory = source.snapshot('inst_src', true);
    const diskOnly = source.snapshot('inst_src', false);
    expect(store.has(withMemory.sha256)).toBe(true);

    const restoreFrom = (sha256: string) => ({
      url: `https://store.example/${sha256}`,
      sha256: Uint8Array.from(Buffer.from(sha256, 'hex')),
      ref: 'snap_1',
    });
    target.converge(
      section([
        spec('inst_warm', { restoreFrom: restoreFrom(withMemory.sha256) }),
        spec('inst_cold', { restoreFrom: restoreFrom(diskOnly.sha256) }),
      ]),
    );
    expect(target.domains.get('inst_warm')).toMatchObject({
      memory: 'python> x = 42',
      restoredFrom: withMemory.sha256,
      state: 'running',
    });
    expect(target.domains.get('inst_cold')?.memory).toBeUndefined();
  });
});

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
