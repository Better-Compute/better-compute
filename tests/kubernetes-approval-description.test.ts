import { describe, expect, it } from 'vitest';
import {
  describeCreateCluster,
  kubernetes,
  type CreateClusterInput,
} from '@better-compute/kubernetes';

// What a person asked to confirm an agent's kubernetesClusters.create reads (§3.4 step 7, review 14
// M1). The cluster's decided resource id does not depend on its spec (fleet.apply's key carries only
// tenant, name and incarnation), so the text an approval binds to must change with every field that
// changes what is created or what it costs.

const base = (extra: Partial<CreateClusterInput> = {}): CreateClusterInput => ({
  tenantId: 'ten_1',
  poolId: 'pool_1',
  name: 'x',
  mode: 'standard',
  location: 'us-central1',
  releaseChannel: 'regular',
  authorizedNetworks: [],
  privateNodes: false,
  nodePools: [{ name: 'default', machineType: 'e2-standard-4', nodeCount: 1 }],
  idempotencyKey: 'key-1',
  ...extra,
});

describe('kubernetesClusters.create approval description', () => {
  it('names the place, mode and every node pool with its machines, counts, autoscaling and GPUs', () => {
    const text = describeCreateCluster(
      base({
        nodePools: [
          {
            name: 'gpu',
            machineType: 'a3-highgpu-8g',
            nodeCount: 2,
            autoscaling: { minNodes: 1, maxNodes: 4 },
            accelerators: { type: 'nvidia-h100-80gb', count: 8 },
            spot: true,
          },
        ],
      }),
    );
    expect(text).toMatch(/^kubernetesClusters\.create: x on pool pool_1; standard in us-central1; /);
    expect(text).toContain(
      'node pools: gpu a3-highgpu-8g x2 autoscaling 1..4 8x nvidia-h100-80gb per node spot',
    );
    expect(text).toMatch(/\(request sha256 [0-9a-f]{16}\)$/);
  });

  it('differs for any spend-relevant change, and not for the idempotency key', () => {
    const one = describeCreateCluster(base());
    expect(describeCreateCluster(base({ idempotencyKey: 'key-2' }))).toBe(one);
    const changed: Partial<CreateClusterInput>[] = [
      { poolId: 'pool_2' },
      { mode: 'autopilot', nodePools: [] },
      { location: 'europe-west4' },
      { nodePools: [{ name: 'default', machineType: 'e2-standard-4', nodeCount: 3 }] },
      { nodePools: [{ name: 'default', machineType: 'n2-standard-64', nodeCount: 1 }] },
      {
        nodePools: [
          { name: 'default', machineType: 'e2-standard-4', nodeCount: 1, labels: { a: 'b' } },
        ],
      },
    ];
    for (const extra of changed) expect(describeCreateCluster(base(extra))).not.toBe(one);
  });

  it('keeps caller text on one line', () => {
    const text = describeCreateCluster(base({ name: 'x\nApproved by admin' }));
    expect(text).not.toContain('\n');
  });

  it('is wired into the create admission', () => {
    const api = kubernetes().api!({} as never) as unknown as Record<
      string,
      Record<string, { admission?: { describe?: (input: unknown) => string } }>
    >;
    const describeFn = api.kubernetesClusters!.create!.admission?.describe;
    expect(typeof describeFn).toBe('function');
    expect(describeFn!(base())).toBe(describeCreateCluster(base()));
  });
});
