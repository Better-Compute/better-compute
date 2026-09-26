import { describe, expect, it } from 'vitest';
import { checkHostResources, checkKubeAdvertisements } from '@better-compute/testing';

describe('I1 for Kubernetes offers and host resources', () => {
  it('flags a kubelet offer that outlives its booking into another allocation', () => {
    const bookings = [
      { allocationId: 'a', deviceId: 'GPU-1', start: 0, end: 100 },
      { allocationId: 'b', deviceId: 'GPU-1', start: 100, end: 200 },
    ];
    // Withdrawn exactly when a's booking ended: fine.
    expect(
      checkKubeAdvertisements({
        bookings,
        advertisements: [
          { nodeId: 'n', allocationId: 'a', deviceIds: ['GPU-1'], from: 5, to: 100 },
        ],
      }),
    ).toEqual([]);
    // Withdrawn after b's booking began (the release reached the node late).
    const late = checkKubeAdvertisements({
      bookings,
      advertisements: [{ nodeId: 'n', allocationId: 'a', deviceIds: ['GPU-1'], from: 5, to: 101 }],
    });
    expect(late).toHaveLength(1);
    expect(late[0]).toMatchObject({ invariant: 'I1', subject: 'a' });
    expect(late[0]!.message).toContain('while b books it');
    // Still offered (no withdrawal yet).
    expect(
      checkKubeAdvertisements({
        bookings,
        advertisements: [{ nodeId: 'n', allocationId: 'a', deviceIds: ['GPU-1'], from: 5 }],
      }),
    ).toHaveLength(1);
  });

  it('flags a host over allocatable × ratio, or whose allocated drifts from its live claims', () => {
    const ok = {
      at: 1,
      nodeId: 'n',
      resource: 'vcpu',
      allocatable: 100,
      ratio: 1.5,
      allocated: 150,
      claimed: 150,
    };
    expect(checkHostResources([ok])).toEqual([]);
    expect(checkHostResources([{ ...ok, allocated: 151, claimed: 151 }])[0]!.message).toContain(
      'over 100 × 1.5',
    );
    expect(checkHostResources([{ ...ok, allocated: 140 }])[0]!.message).toContain('claim 150');
  });
});
