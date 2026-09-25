import { describe, expect, it } from 'vitest';
import { fromJson } from '@bufbuild/protobuf';
import type { InstanceSpec, SqlTx } from '@better-compute/core';
import { InstanceNetworkPolicy, NodeSpecSchema } from '@better-compute/protocol';
import { specHash, wireNodeSpec } from '../packages/server/src/controllers/nodespec.js';

// The instances section on the wire (v0.5 sandboxes §3.7): restore_from and network_policy decode
// as the daemon reads them, and a spec that sets neither hashes as before.

const tx = {
  query: async () => ({ rows: [], rowCount: 0 }),
} as unknown as SqlTx;

const instance = (extra: Partial<InstanceSpec> = {}): InstanceSpec => ({
  id: 'inst_a',
  desiredState: 'running',
  runtime: 'cloud-hypervisor',
  flavor: { vcpu: 2, memoryGiB: 4, diskGiB: 40 },
  image: { url: 'https://images.example/u.raw', sha256: 'ab'.repeat(32), format: 'raw' },
  ...extra,
});

describe('NodeSpec instances section (v0.5)', () => {
  it('carries restore_from and a non-default network policy; egress is the wire default', async () => {
    const wire = await wireNodeSpec(tx, {
      instances: [
        instance({
          desiredState: 'paused',
          restoreFrom: {
            url: 'https://objects.example/snap',
            sha256: 'cd'.repeat(32),
            imageId: 'snap_1',
          },
          networkPolicy: 'none',
        }),
      ],
    });
    const spec = fromJson(NodeSpecSchema, wire as never);
    const decoded = spec.instances!.instances[0]!;
    expect(decoded.networkPolicy).toBe(InstanceNetworkPolicy.NONE);
    expect(decoded.restoreFrom).toMatchObject({
      ref: 'snap_1',
      url: 'https://objects.example/snap',
    });
    expect(Buffer.from(decoded.restoreFrom!.sha256).toString('hex')).toBe('cd'.repeat(32));

    const plain = await wireNodeSpec(tx, { instances: [instance()] });
    const egress = await wireNodeSpec(tx, { instances: [instance({ networkPolicy: 'egress' })] });
    expect(specHash(egress)).toBe(specHash(plain));
    expect(fromJson(NodeSpecSchema, plain as never).instances!.instances[0]!.networkPolicy).toBe(
      InstanceNetworkPolicy.UNSPECIFIED,
    );
  });
});

describe('NodeSpec site section: proxy targets (review 7 HIGH-1)', () => {
  it('lists the machines site.httpProxy may reach, sorted, and none when nothing contributes', async () => {
    const wire = await wireNodeSpec(tx, {
      site: {
        boot: { active: true, epoch: 2 },
        proxyTargets: [
          { nodeId: 'node_b', addresses: ['10.1.0.9', 'talos-b.site.internal', '10.1.0.9'] },
          { nodeId: 'node_a', addresses: ['10.1.0.7'] },
        ],
      },
    });
    const site = fromJson(NodeSpecSchema, wire as never).site!;
    expect(site.proxyTargets.map((target) => [target.nodeId, target.addresses])).toEqual([
      ['node_a', ['10.1.0.7']],
      ['node_b', ['10.1.0.9', 'talos-b.site.internal']],
    ]);
    const bare = await wireNodeSpec(tx, { site: { boot: { active: true, epoch: 2 } } });
    expect(fromJson(NodeSpecSchema, bare as never).site!.proxyTargets).toEqual([]);
    expect((bare.site as Record<string, unknown>).proxyTargets).toBeUndefined();
  });
});
