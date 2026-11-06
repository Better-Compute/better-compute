import { describe, expect, it } from 'vitest';
import { validateFleetConfig, type FleetConfig } from '@better-compute/fleet';

// FleetConfig's Kubernetes sections (PLAN §3.8, D25): managed clusters with their node pools, checked
// strictly by validateFleetConfig before anything is planned. The kubernetes module checks the calls
// again; these are the document's own rules (shape, names, references, standard vs autopilot).

const cluster = (extra: Record<string, unknown> = {}) => ({
  name: 'training',
  pool: 'gke',
  location: 'us-central1',
  nodePools: [{ name: 'system', machineType: 'e2-standard-4', nodeCount: 1 }],
  ...extra,
});
const document = (clusters: unknown[]): unknown => ({ version: 1, kubernetesClusters: clusters });
const message = (value: unknown) => {
  try {
    validateFleetConfig(value);
    return 'valid';
  } catch (error) {
    return (error as Error).message;
  }
};

describe('kubernetesClusters in the document', () => {
  it('accepts standard and autopilot clusters and keeps what they say, normalized', () => {
    const config = validateFleetConfig(
      document([
        cluster({
          mode: 'standard',
          releaseChannel: 'stable',
          version: '1.33',
          description: 'GPU training',
          authorizedNetworks: ['203.0.113.0/24', '203.0.113.0/24'],
          networkId: 'net_01k5w000000000000000000000',
          nodePools: [
            { name: 'system', machineType: 'e2-standard-4', nodeCount: 1 },
            {
              name: 'gpu',
              machineType: 'g2-standard-8',
              nodeCount: 0,
              autoscaling: { minNodes: 0, maxNodes: 4 },
              diskGiB: 200,
              diskType: 'pd-ssd',
              spot: false,
              accelerators: { type: 'nvidia-l4', count: 1 },
              zones: ['us-central1-a', 'us-central1-a'],
              labels: { 'example.com/gpu': 'l4' },
              taints: [{ key: 'nvidia.com/gpu', value: 'present', effect: 'NoSchedule' }],
            },
          ],
        }),
        {
          name: 'serve',
          pool: 'pool_01k5w000000000000000000000',
          mode: 'autopilot',
          location: 'us-central1-b',
        },
      ]),
    );
    expect(config.kubernetesClusters).toEqual([
      {
        name: 'training',
        pool: 'gke',
        mode: 'standard',
        location: 'us-central1',
        releaseChannel: 'stable',
        version: '1.33',
        description: 'GPU training',
        authorizedNetworks: ['203.0.113.0/24'],
        networkId: 'net_01k5w000000000000000000000',
        nodePools: [
          { name: 'system', machineType: 'e2-standard-4', nodeCount: 1 },
          {
            name: 'gpu',
            machineType: 'g2-standard-8',
            nodeCount: 0,
            autoscaling: { minNodes: 0, maxNodes: 4 },
            diskGiB: 200,
            diskType: 'pd-ssd',
            accelerators: { type: 'nvidia-l4', count: 1 },
            zones: ['us-central1-a'],
            labels: { 'example.com/gpu': 'l4' },
            taints: [{ key: 'nvidia.com/gpu', value: 'present', effect: 'NoSchedule' }],
          },
        ],
      },
      {
        name: 'serve',
        pool: 'pool_01k5w000000000000000000000',
        mode: 'autopilot',
        location: 'us-central1-b',
      },
    ]);
    // An empty section is left out, as every other section is.
    expect(validateFleetConfig(document([]))).toEqual({ version: 1 });
  });

  it('refuses unknown fields, bad names and duplicates, naming the path', () => {
    expect(message(document([cluster({ kubeconfig: 'x' })]))).toMatch(
      /kubernetesClusters\[0\]\.kubeconfig is not a known field/,
    );
    expect(message(document([cluster({ name: 'Training' })]))).toMatch(
      /kubernetesClusters\[0\]\.name/,
    );
    expect(message(document([cluster({ name: 'a'.repeat(41) })]))).toMatch(/\.name/);
    expect(message(document([cluster(), cluster()]))).toMatch(
      /kubernetesClusters\[1\] repeats "training"/,
    );
    expect(message(document([cluster({ mode: 'serverless' })]))).toMatch(
      /\.mode must be standard or autopilot/,
    );
    expect(message(document([cluster({ releaseChannel: 'beta' })]))).toMatch(/\.releaseChannel/);
    expect(message(document([cluster({ location: 'US' })]))).toMatch(/\.location/);
    expect(message(document([cluster({ version: 'latest' })]))).toMatch(/\.version/);
    expect(message(document([cluster({ networkId: 'vpc-1' })]))).toMatch(/\.networkId/);
    expect(message(document([cluster({ projectId: 'p' })]))).toMatch(/\.projectId/);
    expect(message(document([cluster({ authorizedNetworks: ['10.0.0.1/8'] })]))).toMatch(
      /authorizedNetworks\[0\]/,
    );
    expect(message(document([cluster({ privateNodes: 'yes' })]))).toMatch(/\.privateNodes/);
    expect(message(document([cluster({ description: 'a\nb' })]))).toMatch(/\.description/);
  });

  it('checks node pools: standard needs one, autopilot takes none; fields and duplicates', () => {
    expect(message(document([cluster({ nodePools: [] })]))).toMatch(
      /kubernetesClusters\[0\]\.nodePools must list at least one node pool for a standard cluster/,
    );
    expect(message(document([cluster({ mode: 'autopilot' })]))).toMatch(
      /nodePools must be empty for an autopilot cluster/,
    );
    const pool = (extra: Record<string, unknown>) =>
      document([
        cluster({
          nodePools: [{ name: 'p', machineType: 'e2-standard-4', nodeCount: 1, ...extra }],
        }),
      ]);
    expect(message(pool({ nodeCount: -1 }))).toMatch(/nodePools\[0\]\.nodeCount/);
    expect(message(pool({ machineType: 'E2 Standard' }))).toMatch(/nodePools\[0\]\.machineType/);
    expect(message(pool({ autoscaling: { minNodes: 3, maxNodes: 1 } }))).toMatch(
      /autoscaling\.minNodes must not exceed/,
    );
    expect(message(pool({ diskGiB: 5 }))).toMatch(/nodePools\[0\]\.diskGiB/);
    expect(message(pool({ accelerators: { type: 'nvidia-l4', count: 0 } }))).toMatch(
      /accelerators\.count/,
    );
    expect(message(pool({ taints: [{ key: 'a', effect: 'Evict' }] }))).toMatch(
      /taints\[0\]\.effect/,
    );
    expect(message(pool({ labels: { 'a b': 'c' } }))).toMatch(/labels/);
    expect(message(pool({ token: 'x' }))).toMatch(/nodePools\[0\]\.token is not a known field/);
    expect(
      message(
        document([
          cluster({
            nodePools: [
              { name: 'p', machineType: 'e2-standard-4', nodeCount: 1 },
              { name: 'p', machineType: 'e2-standard-4', nodeCount: 2 },
            ],
          }),
        ]),
      ),
    ).toMatch(/nodePools\[1\] repeats "p"/);
    expect(
      message(
        document([
          cluster({
            nodePools: Array.from({ length: 11 }, (_, index) => ({
              name: `p${index}`,
              machineType: 'e2-standard-4',
              nodeCount: 1,
            })),
          }),
        ]),
      ),
    ).toMatch(/at most 10/);
  });

  it('takes every provider machine type the kubernetes module may take: GKE, DOKS and EKS (dotted)', () => {
    const pool = (machineType: string, extra: Record<string, unknown> = {}) =>
      document([cluster({ nodePools: [{ name: 'p', machineType, nodeCount: 1, ...extra }] })]);
    for (const machineType of [
      'e2-standard-4',
      's-2vcpu-4gb',
      'm5.large',
      'g5.xlarge',
      'm7i.48xlarge',
    ])
      expect(message(pool(machineType))).toBe('valid');
    expect(message(pool('g5.xlarge', { accelerators: { type: 'nvidia-a10g', count: 1 } }))).toBe(
      'valid',
    );
    // Still a provider-style name: no upper case, spaces or a leading dot.
    expect(message(pool('.large'))).toMatch(/nodePools\[0\]\.machineType/);
    expect(message(pool('M5.Large'))).toMatch(/nodePools\[0\]\.machineType/);
  });

  it('round-trips through JSON as a document a person can commit', () => {
    const config: FleetConfig = validateFleetConfig(document([cluster()]));
    expect(validateFleetConfig(JSON.parse(JSON.stringify(config)))).toEqual(config);
  });
});
