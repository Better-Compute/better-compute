import { describe, expect, it } from 'vitest';
import { bcdDaemonSetManifests, type BcdDaemonSetOptions } from '@better-compute/provider-kubernetes';

// provider-kubernetes hosted mode on Amazon EKS (AWS A9): bcd as a DaemonSet adopts the nodes of one
// managed node group. EKS labels each node with its node group (`eks.amazonaws.com/nodegroup`), and
// better-compute's GPU node groups carry the taint `nvidia.com/gpu=:NoSchedule` (as GKE's do).

const pin = (n: number) => `sha256/${Buffer.alloc(32, n).toString('base64')}`;
const options: BcdDaemonSetOptions = {
  image: `123456789012.dkr.ecr.us-west-2.amazonaws.com/bcd:0.6.0@sha256:${'ab'.repeat(32)}`,
  gatewayUrl: 'https://gw.example.com:8443',
  siteId: 'site_eks',
  pins: { servingCaPin: pin(1), joinSigningPin: pin(2), joinEncryptionPin: pin(3) },
  controlPlaneUrl: 'https://compute.example.com/api/compute',
  joinTokenSecret: { name: 'bcd-join' },
  nodeSelector: { 'eks.amazonaws.com/nodegroup': 'gpu' },
  tolerations: [{ key: 'nvidia.com/gpu', operator: 'Exists', effect: 'NoSchedule' }],
};

const daemonSetOf = (objects: ReturnType<typeof bcdDaemonSetManifests>) =>
  objects.find((object) => object.kind === 'DaemonSet') as unknown as {
    spec: {
      template: {
        spec: {
          nodeSelector?: Record<string, string>;
          tolerations: Record<string, string>[];
          hostNetwork: boolean;
          automountServiceAccountToken: boolean;
        };
      };
    };
  };

describe('provider-kubernetes hosted mode on EKS', () => {
  it('renders the DaemonSet for EKS-shaped nodes: the node group selector and the GPU taint', () => {
    const pod = daemonSetOf(bcdDaemonSetManifests(options)).spec.template.spec;
    expect(pod.nodeSelector).toEqual({ 'eks.amazonaws.com/nodegroup': 'gpu' });
    expect(pod.tolerations).toEqual([
      { key: 'nvidia.com/gpu', operator: 'Exists', effect: 'NoSchedule' },
    ]);
    // Host network (IMDS and the node's own address), and no service account token in bcd.
    expect(pod.hostNetwork).toBe(true);
    expect(pod.automountServiceAccountToken).toBe(false);
  });

  it('selects EKS capacity types and refuses a malformed node group selector', () => {
    const spot = daemonSetOf(
      bcdDaemonSetManifests({
        ...options,
        nodeSelector: { 'eks.amazonaws.com/nodegroup': 'gpu', 'eks.amazonaws.com/capacityType': 'SPOT' },
      }),
    ).spec.template.spec;
    expect(spot.nodeSelector).toMatchObject({ 'eks.amazonaws.com/capacityType': 'SPOT' });
    expect(() =>
      bcdDaemonSetManifests({ ...options, nodeSelector: { 'eks.amazonaws.com/nodegroup': 'gpu pool' } }),
    ).toThrow(/nodeSelector/);
  });
});
