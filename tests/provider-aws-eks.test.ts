import { describe, expect, it } from 'vitest';
import {
  isComputeError,
  type CallContext,
  type KubernetesClusterSpec,
  type KubernetesNodePoolSpec,
  type Logger,
  type ProviderImpl,
  type ProviderKubernetes,
} from '@better-compute/core';
import {
  awsProvider,
  iamPolicy,
  principalArnOf,
  type AwsConfig,
  type AwsProviderOptions,
} from '@better-compute/provider-aws';
import { AwsEmulator, platformAccount } from './support/aws-emulator/index.js';
import { Ec2Emulator } from './support/aws-emulator/ec2.js';
import { emulatedEksCaData, EksEmulator, type EksKubeApi } from './support/eks-emulator.js';

// provider-aws managed Kubernetes on Amazon EKS against the EKS emulator: clusters (managed node
// groups and Auto Mode), in-place updates, node groups (CPU, GPU, Spot, scaling), versions, and
// per-subject credentials through access entries, an eksToken and the TokenRequest API.

const region = 'us-east-1';
const clusterRoleArn = 'arn:aws:iam::111111111111:role/eks-cluster';
const nodeRoleArn = 'arn:aws:iam::111111111111:role/eks-node';
const subnets = {
  a: 'subnet-0000000000000000a',
  b: 'subnet-0000000000000000b',
  c: 'subnet-0000000000000000c',
  open: 'subnet-000000000000000ff',
};

interface Setup {
  emu: AwsEmulator;
  ec2: Ec2Emulator;
  eks: EksEmulator;
  kube: EksKubeApi;
  impl: ProviderImpl;
  k8s: ProviderKubernetes;
  logs: string[];
  ctx: () => CallContext;
}

async function setup(
  config: Partial<AwsConfig> = {},
  options: AwsProviderOptions = {},
  account: { id: string; tenantId: string; platform: boolean } = {
    id: 'pa_platform',
    tenantId: 'root',
    platform: true,
  },
): Promise<Setup> {
  const emu = new AwsEmulator();
  const ec2 = new Ec2Emulator(emu);
  ec2.subnets.set(subnets.a, { vpcId: 'vpc-0000000000000000a', zone: 'us-east-1a', mapPublicIpOnLaunch: false });
  ec2.subnets.set(subnets.b, { vpcId: 'vpc-0000000000000000a', zone: 'us-east-1b', mapPublicIpOnLaunch: false });
  ec2.subnets.set(subnets.c, { vpcId: 'vpc-0000000000000000a', zone: 'us-east-1c', mapPublicIpOnLaunch: false });
  ec2.subnets.set(subnets.open, { vpcId: 'vpc-0000000000000000a', zone: 'us-east-1c', mapPublicIpOnLaunch: true });
  const eks = new EksEmulator(emu);
  const kube = eks.kubeApi();
  const logs: string[] = [];
  const log: Logger = {
    debug: (message, fields) => void logs.push(JSON.stringify({ message, fields })),
    info: (message, fields) => void logs.push(JSON.stringify({ message, fields })),
    warn: (message, fields) => void logs.push(JSON.stringify({ message, fields })),
    error: (message, fields) => void logs.push(JSON.stringify({ message, fields })),
  };
  const provider = awsProvider({
    fetch: emu.fetch,
    credentials: emu.ambient,
    kubeTransport: kube.transport,
    ...options,
  });
  const parsed = await provider.config['~standard'].validate({
    region,
    zones: ['us-east-1a', 'us-east-1b', 'us-east-1c'],
    eksClusterRoleArn: clusterRoleArn,
    eksNodeRoleArn: nodeRoleArn,
    eksSubnetIds: [subnets.a, subnets.b],
    ...config,
  });
  if ('issues' in parsed && parsed.issues) throw new Error(parsed.issues[0]!.message);
  const impl = await provider.create((parsed as { value: AwsConfig }).value, {
    clock: emu.clock,
    secrets: { resolve: async () => '' },
    log,
    account,
  });
  const ctx = (): CallContext => ({
    idempotencyKey: 'k1',
    signal: new AbortController().signal,
    clock: emu.clock,
    secrets: { resolve: async () => '' },
    log,
  });
  return { emu, ec2, eks, kube, impl, k8s: impl.kubernetes!, logs, ctx };
}

const pool: KubernetesNodePoolSpec = {
  name: 'general',
  machineType: 'm7i.large',
  nodeCount: 1,
  diskGiB: 100,
  labels: { workload: 'general' },
  taints: [{ key: 'dedicated', value: 'bc', effect: 'NoSchedule' }],
};

const standard: KubernetesClusterSpec = {
  name: 'bc-k-one',
  location: region,
  mode: 'standard',
  releaseChannel: 'regular',
  authorizedNetworks: ['203.0.113.0/24'],
  privateNodes: true,
  initialNodePools: [pool],
  labels: { 'better-compute-cluster': 'kc_one' },
  description: 'tenant cluster',
};

const auto: KubernetesClusterSpec = {
  name: 'bc-k-auto',
  location: region,
  mode: 'autopilot',
  releaseChannel: 'extended',
  authorizedNetworks: [],
  privateNodes: false,
};

async function settle<T extends { state: string }>(
  call: () => Promise<T>,
  until: string,
  max = 10,
): Promise<{ last: T; states: string[] }> {
  const states: string[] = [];
  for (let i = 0; i < max; i++) {
    const last = await call();
    states.push(last.state);
    if (last.state === until) return { last, states };
  }
  throw new Error(`never ${until}: ${states.join(', ')}`);
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

const bodyOf = (s: Setup, operation: string, index = -1) =>
  JSON.parse(s.eks.calls(operation).at(index)!.body) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function readyCluster(s: Setup, spec: KubernetesClusterSpec = standard): Promise<string> {
  const { last } = await settle(() => s.k8s.ensureCluster(spec, s.ctx()), 'ready');
  return last.id;
}

describe('eks clusters', () => {
  it('is offered with the kubernetes capability', async () => {
    expect(awsProvider().capabilities).toContain('kubernetes');
    const s = await setup();
    expect(s.k8s).toBeDefined();
  });

  it('creates a standard cluster on access entries only, and reports it ready', async () => {
    const s = await setup();
    const first = await s.k8s.ensureCluster(standard, s.ctx());
    expect(first).toEqual({ id: 'us-east-1/bc-k-one', state: 'pending' });
    const body = bodyOf(s, 'CreateCluster');
    expect(body).toMatchObject({
      name: 'bc-k-one',
      roleArn: clusterRoleArn,
      resourcesVpcConfig: {
        subnetIds: [subnets.a, subnets.b],
        endpointPublicAccess: true,
        endpointPrivateAccess: true,
        publicAccessCidrs: ['203.0.113.0/24'],
      },
      accessConfig: { authenticationMode: 'API', bootstrapClusterCreatorAdminPermissions: true },
      upgradePolicy: { supportType: 'STANDARD' },
      tags: {
        'better-compute-cluster': 'kc_one',
        'better-compute:managed': 'true',
        'better-compute:private-nodes': 'true',
        'better-compute:description': 'tenant cluster',
      },
    });
    expect(body.clientRequestToken).toMatch(/^[0-9a-f]{64}$/);
    // EKS creates no node groups with the cluster: they come through ensureNodePool.
    expect(body).not.toHaveProperty('computeConfig');
    const { last } = await settle(() => s.k8s.ensureCluster(standard, s.ctx()), 'ready');
    const cluster = s.eks.clusters.get('bc-k-one')!;
    expect(last).toEqual({
      id: 'us-east-1/bc-k-one',
      state: 'ready',
      outputs: {
        endpoint: cluster.endpoint,
        location: region,
        version: '1.33',
        nodeVersion: '1.33',
        platformVersion: 'eks.1',
        arn: cluster.arn,
      },
    });
    // As wanted: nothing more is started.
    await s.k8s.ensureCluster(standard, s.ctx());
    expect(s.eks.calls('CreateCluster')).toHaveLength(1);
    expect(s.eks.calls('UpdateClusterConfig')).toHaveLength(0);
    expect(s.eks.calls('UpdateClusterVersion')).toHaveLength(0);
    expect(await s.k8s.getCluster('us-east-1/bc-k-one', s.ctx())).toMatchObject({ state: 'ready' });
    expect(await s.k8s.getCluster('us-east-1/bc-k-none', s.ctx())).toBeUndefined();
    // The creator (the account principal) holds the cluster-admin access entry.
    expect([...s.eks.accessEntries.keys()]).toEqual([
      'bc-k-one|arn:aws:iam::111111111111:role/bc-control-plane',
    ]);
  });

  it('creates an EKS Auto Mode cluster for autopilot, without node pools', async () => {
    const s = await setup();
    await readyCluster(s, auto);
    expect(bodyOf(s, 'CreateCluster')).toMatchObject({
      computeConfig: { enabled: true, nodePools: ['general-purpose', 'system'], nodeRoleArn },
      kubernetesNetworkConfig: { elasticLoadBalancing: { enabled: true } },
      storageConfig: { blockStorage: { enabled: true } },
      bootstrapSelfManagedAddons: false,
      upgradePolicy: { supportType: 'EXTENDED' },
      resourcesVpcConfig: { publicAccessCidrs: ['0.0.0.0/0'] },
    });
    const error = await rejection(s.k8s.ensureNodePool('us-east-1/bc-k-auto', pool, s.ctx()));
    expect(isComputeError(error, 'UNSUPPORTED')).toBe(true);
    // Mode cannot change in place.
    const changed = await rejection(s.k8s.ensureCluster({ ...auto, mode: 'standard' }, s.ctx()));
    expect(isComputeError(changed, 'INVALID_STATE')).toBe(true);
  });

  it('refuses what EKS or the account cannot do', async () => {
    const s = await setup();
    for (const spec of [
      { ...standard, location: 'us-west-2' },
      { ...standard, location: 'us-east-1a' },
      { ...standard, name: 'bad name' },
      { ...standard, version: '1.33.2-gke.1000' },
      { ...standard, authorizedNetworks: ['10.0.0.0/33'] },
      { ...standard, network: { network: 'default' } },
      { ...standard, initialNodePools: [{ ...pool, machineType: 'e2-standard-4' }] },
    ]) {
      const error = await rejection(s.k8s.ensureCluster(spec, s.ctx()));
      expect(isComputeError(error, 'INVALID_INPUT')).toBe(true);
    }
    // Private nodes on a subnet that hands out public addresses.
    const open = await rejection(
      s.k8s.ensureCluster(
        { ...standard, network: { network: 'vpc-0000000000000000a', subnet: `${subnets.a},${subnets.open}` } },
        s.ctx(),
      ),
    );
    expect(isComputeError(open, 'INVALID_INPUT')).toBe(true);
    expect((open as Error).message).toMatch(/MapPublicIpOnLaunch/);
    // One Availability Zone.
    const oneZone = await rejection(
      s.k8s.ensureCluster({ ...standard, network: { network: 'vpc-0000000000000000a', subnet: subnets.a } }, s.ctx()),
    );
    expect(isComputeError(oneZone, 'INVALID_INPUT')).toBe(true);
    expect(s.eks.calls('CreateCluster')).toHaveLength(0);
    // Without the cluster role or two subnets, the account cannot create clusters.
    const noRole = await setup({ eksClusterRoleArn: undefined });
    expect(isComputeError(await rejection(noRole.k8s.ensureCluster(standard, noRole.ctx())), 'INVALID_CONFIG')).toBe(true);
    const noSubnets = await setup({ eksSubnetIds: undefined });
    expect(isComputeError(await rejection(noSubnets.k8s.ensureCluster(standard, noSubnets.ctx())), 'INVALID_CONFIG')).toBe(true);
    // A malformed role ARN is refused at create.
    await expect(setup({ eksNodeRoleArn: 'arn:aws:iam::111111111111:user/x' })).rejects.toThrow(/eksNodeRoleArn/);
  });

  it('a cluster that failed to create is error with EKS words', async () => {
    const s = await setup();
    s.eks.failNextCreate = 'not enough free IP addresses';
    const { last } = await settle(() => s.k8s.ensureCluster(standard, s.ctx()), 'error');
    expect(last.message).toMatch(/InsufficientFreeAddresses: not enough free IP addresses/);
  });

  it('changes the support policy, the version one minor at a time, and the public CIDRs in place', async () => {
    const s = await setup();
    const spec = { ...standard, version: '1.32' };
    await readyCluster(s, spec);
    expect(bodyOf(s, 'CreateCluster').version).toBe('1.32');

    // extended → upgradePolicy EXTENDED.
    expect(await s.k8s.ensureCluster({ ...spec, releaseChannel: 'extended' }, s.ctx())).toMatchObject({ state: 'updating' });
    expect(bodyOf(s, 'UpdateClusterConfig')).toMatchObject({ upgradePolicy: { supportType: 'EXTENDED' } });
    await readyCluster(s, { ...spec, releaseChannel: 'extended' });

    // 1.32 → 1.34 takes two upgrades: EKS moves one minor at a time.
    const target = { ...spec, releaseChannel: 'extended' as const, version: '1.34' };
    const { states } = await settle(() => s.k8s.ensureCluster(target, s.ctx()), 'ready', 20);
    expect(states[0]).toBe('updating');
    expect(s.eks.calls('UpdateClusterVersion').map((call) => JSON.parse(call.body).version)).toEqual(['1.33', '1.34']);
    expect(s.eks.clusters.get('bc-k-one')!.version).toBe('1.34');

    // A downgrade is refused.
    const down = await rejection(s.k8s.ensureCluster({ ...target, version: '1.33' }, s.ctx()));
    expect(isComputeError(down, 'INVALID_STATE')).toBe(true);

    // Authorized networks.
    await settle(() => s.k8s.ensureCluster({ ...target, authorizedNetworks: [] }, s.ctx()), 'ready');
    expect(bodyOf(s, 'UpdateClusterConfig')).toMatchObject({
      resourcesVpcConfig: { publicAccessCidrs: ['0.0.0.0/0'] },
    });
    // privateNodes and the subnets cannot change in place.
    const flipped = await rejection(s.k8s.ensureCluster({ ...target, authorizedNetworks: [], privateNodes: false }, s.ctx()));
    expect(isComputeError(flipped, 'INVALID_STATE')).toBe(true);
  });

  it('changes the public CIDRs A→B→A→B and the support policy back and forth', async () => {
    const s = await setup();
    await readyCluster(s);
    for (const cidr of ['198.51.100.0/24', '203.0.113.0/24', '198.51.100.0/24']) {
      await settle(() => s.k8s.ensureCluster({ ...standard, authorizedNetworks: [cidr] }, s.ctx()), 'ready');
      expect(s.eks.clusters.get('bc-k-one')!.publicAccessCidrs).toEqual([cidr]);
    }
    for (const releaseChannel of ['extended', 'regular', 'extended'] as const) {
      await settle(() => s.k8s.ensureCluster({ ...standard, releaseChannel }, s.ctx()), 'ready');
      expect(s.eks.clusters.get('bc-k-one')!.supportType).toBe(releaseChannel === 'extended' ? 'EXTENDED' : 'STANDARD');
    }
    // Every transition had its own token (EKS answers a repeated one with the earlier update).
    const tokens = s.eks.calls('UpdateClusterConfig').map((call) => JSON.parse(call.body).clientRequestToken);
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  it('answers updating while an update runs, and error when it failed', async () => {
    const s = await setup();
    await readyCluster(s);
    s.eks.delayTicks = 3;
    s.eks.failNextUpdate = 'the control plane refused the change';
    const wanted = { ...standard, authorizedNetworks: ['198.51.100.0/24'] };
    const { last, states } = await settle(() => s.k8s.ensureCluster(wanted, s.ctx()), 'error');
    expect(states.every((state) => state === 'updating' || state === 'error')).toBe(true);
    expect(last.message).toMatch(/the control plane refused the change/);
    expect(s.eks.calls('UpdateClusterConfig')).toHaveLength(1);
    // The next call starts it again.
    await settle(() => s.k8s.ensureCluster(wanted, s.ctx()), 'ready');
    expect(s.eks.clusters.get('bc-k-one')!.publicAccessCidrs).toEqual(['198.51.100.0/24']);
  });

  it('deletes the node groups first, then the cluster', async () => {
    const s = await setup();
    const id = await readyCluster(s);
    await settle(() => s.k8s.ensureNodePool(id, pool, s.ctx()), 'ready');
    await settle(() => s.k8s.ensureNodePool(id, { ...pool, name: 'second' }, s.ctx()), 'ready');
    s.eks.pageSize = 1; // ListNodegroups pages
    const { states } = await settle(() => s.k8s.deleteCluster(id, s.ctx()), 'deleted', 12);
    expect(states[0]).toBe('deleting');
    expect(s.eks.calls('DeleteNodegroup')).toHaveLength(2);
    expect(s.eks.calls('DeleteCluster')).toHaveLength(1);
    expect(s.eks.clusters.size).toBe(0);
    expect(await s.k8s.deleteCluster(id, s.ctx())).toEqual({ id, state: 'deleted' });
  });
});

describe('eks node groups', () => {
  it('creates a CPU node group on the cluster subnets, per-zone counts as totals', async () => {
    const s = await setup();
    const id = await readyCluster(s);
    const { last } = await settle(() => s.k8s.ensureNodePool(id, { ...pool, nodeCount: 2 }, s.ctx()), 'ready');
    expect(last).toMatchObject({ id: `${id}/general`, state: 'ready', outputs: { version: '1.33' } });
    expect(bodyOf(s, 'CreateNodegroup')).toMatchObject({
      nodegroupName: 'general',
      instanceTypes: ['m7i.large'],
      amiType: 'AL2023_x86_64_STANDARD',
      capacityType: 'ON_DEMAND',
      subnets: [subnets.a, subnets.b],
      nodeRole: nodeRoleArn,
      diskSize: 100,
      // Two nodes in each of two zones.
      scalingConfig: { minSize: 4, maxSize: 4, desiredSize: 4 },
      labels: { workload: 'general' },
      taints: [{ key: 'dedicated', value: 'bc', effect: 'NO_SCHEDULE' }],
      tags: { 'better-compute:managed': 'true', 'better-compute:zones': '2' },
    });
    // Zones pick subnets.
    await settle(() => s.k8s.ensureNodePool(id, { ...pool, name: 'zonal', zones: ['us-east-1b'] }, s.ctx()), 'ready');
    expect(bodyOf(s, 'CreateNodegroup')).toMatchObject({
      subnets: [subnets.b],
      scalingConfig: { desiredSize: 1 },
      tags: { 'better-compute:zones': '1' },
    });
    const noSubnet = await rejection(s.k8s.ensureNodePool(id, { ...pool, name: 'far', zones: ['us-east-1c'] }, s.ctx()));
    expect(isComputeError(noSubnet, 'INVALID_INPUT')).toBe(true);
  });

  it('gives GPU types the NVIDIA AMI and the GPU taint; Spot and Graviton too', async () => {
    const s = await setup();
    const id = await readyCluster(s);
    const gpu: KubernetesNodePoolSpec = {
      name: 'gpu',
      machineType: 'g6.xlarge',
      nodeCount: 1,
      spot: true,
      accelerators: { type: 'nvidia-l4', count: 1 },
    };
    await settle(() => s.k8s.ensureNodePool(id, gpu, s.ctx()), 'ready');
    expect(bodyOf(s, 'CreateNodegroup')).toMatchObject({
      amiType: 'AL2023_x86_64_NVIDIA',
      capacityType: 'SPOT',
      taints: [{ key: 'nvidia.com/gpu', effect: 'NO_SCHEDULE' }],
      tags: { 'better-compute:accelerators': 'nvidia-l4x1' },
    });
    // A GPU type without accelerators still gets the NVIDIA AMI and taint.
    await settle(() => s.k8s.ensureNodePool(id, { name: 'h100', machineType: 'p5.48xlarge', nodeCount: 0 }, s.ctx()), 'ready');
    expect(bodyOf(s, 'CreateNodegroup')).toMatchObject({
      amiType: 'AL2023_x86_64_NVIDIA',
      scalingConfig: { minSize: 0, maxSize: 1, desiredSize: 0 },
    });
    await settle(() => s.k8s.ensureNodePool(id, { name: 'arm', machineType: 'm7g.large', nodeCount: 1 }, s.ctx()), 'ready');
    expect(bodyOf(s, 'CreateNodegroup').amiType).toBe('AL2023_ARM_64_STANDARD');
    // EKS cannot attach accelerators: the type decides.
    for (const accelerators of [
      { type: 'nvidia-l4', count: 2 },
      { type: 'nvidia-h100', count: 1 },
    ]) {
      const error = await rejection(s.k8s.ensureNodePool(id, { ...gpu, name: 'bad', accelerators }, s.ctx()));
      expect(isComputeError(error, 'INVALID_INPUT')).toBe(true);
    }
    const cpu = await rejection(
      s.k8s.ensureNodePool(id, { ...pool, name: 'bad', accelerators: { type: 'nvidia-l4', count: 1 } }, s.ctx()),
    );
    expect(isComputeError(cpu, 'INVALID_INPUT')).toBe(true);
    // Spot cannot change in place.
    const flipped = await rejection(s.k8s.ensureNodePool(id, { ...gpu, spot: false }, s.ctx()));
    expect(isComputeError(flipped, 'INVALID_STATE')).toBe(true);
  });

  it('resizes and re-bounds in place; anything else is INVALID_STATE', async () => {
    const s = await setup();
    const id = await readyCluster(s);
    await settle(() => s.k8s.ensureNodePool(id, pool, s.ctx()), 'ready');
    expect(await s.k8s.ensureNodePool(id, { ...pool, nodeCount: 3 }, s.ctx())).toMatchObject({ state: 'updating' });
    expect(bodyOf(s, 'UpdateNodegroupConfig')).toMatchObject({
      scalingConfig: { minSize: 6, maxSize: 6, desiredSize: 6 },
    });
    await settle(() => s.k8s.ensureNodePool(id, { ...pool, nodeCount: 3 }, s.ctx()), 'ready');
    // Autoscaling: the bounds; the desired size stays (clamped), the autoscaler owns it.
    const scaled = { ...pool, nodeCount: 3, autoscaling: { minNodes: 1, maxNodes: 5 } };
    await settle(() => s.k8s.ensureNodePool(id, scaled, s.ctx()), 'ready');
    expect(bodyOf(s, 'UpdateNodegroupConfig')).toMatchObject({
      scalingConfig: { minSize: 2, maxSize: 10, desiredSize: 6 },
    });
    s.eks.nodegroups.get('bc-k-one/general')!.scalingConfig.desiredSize = 9; // the autoscaler moved it
    const calls = s.eks.calls('UpdateNodegroupConfig').length;
    await s.k8s.ensureNodePool(id, { ...scaled, nodeCount: 1 }, s.ctx());
    expect(s.eks.calls('UpdateNodegroupConfig')).toHaveLength(calls);
    for (const change of [
      { machineType: 'm7i.xlarge' },
      { diskGiB: 200 },
      { labels: { workload: 'batch' } },
      { taints: [{ key: 'other', effect: 'NoExecute' as const }] },
      { accelerators: { type: 'nvidia-l4', count: 1 } },
    ]) {
      const error = await rejection(s.k8s.ensureNodePool(id, { ...scaled, ...change }, s.ctx()));
      expect(isComputeError(error, 'INVALID_STATE')).toBe(true);
    }
    const disk = await rejection(s.k8s.ensureNodePool(id, { ...pool, name: 'disk', diskType: 'gp3' }, s.ctx()));
    expect(isComputeError(disk, 'INVALID_INPUT')).toBe(true);
  });

  it('scales 1→2→1→2 and ends at 2 (a repeated size is a new update, not a retry)', async () => {
    const s = await setup();
    const id = await readyCluster(s);
    await settle(() => s.k8s.ensureNodePool(id, pool, s.ctx()), 'ready');
    for (const nodeCount of [2, 1, 2]) {
      await settle(() => s.k8s.ensureNodePool(id, { ...pool, nodeCount }, s.ctx()), 'ready');
      expect(s.eks.nodegroups.get('bc-k-one/general')!.scalingConfig.desiredSize).toBe(nodeCount * 2);
    }
    const tokens = s.eks.calls('UpdateNodegroupConfig').map((call) => JSON.parse(call.body).clientRequestToken);
    expect(tokens).toHaveLength(3);
    expect(new Set(tokens).size).toBe(3);
  });

  it('deletes a node group; an absent one is deleted', async () => {
    const s = await setup();
    const id = await readyCluster(s);
    await settle(() => s.k8s.ensureNodePool(id, pool, s.ctx()), 'ready');
    const { states } = await settle(() => s.k8s.deleteNodePool(id, 'general', s.ctx()), 'deleted');
    expect(states[0]).toBe('deleting');
    expect(await s.k8s.deleteNodePool(id, 'general', s.ctx())).toMatchObject({ state: 'deleted' });
    expect(await s.k8s.deleteNodePool('us-east-1/bc-k-none', 'gpu', s.ctx())).toMatchObject({ state: 'deleted' });
    const missing = await rejection(s.k8s.ensureNodePool('us-east-1/bc-k-none', pool, s.ctx()));
    expect(isComputeError(missing, 'NOT_FOUND')).toBe(true);
  });
});

describe('eks credentials', () => {
  it('mints a per-subject token through the access entry and an eksToken; nothing is logged', async () => {
    const s = await setup();
    const id = await readyCluster(s);
    const credentials = await s.k8s.credentials(id, { subject: 'bc-u-alice', role: 'edit', ttlSeconds: 3600 }, s.ctx());
    const cluster = s.eks.clusters.get('bc-k-one')!;
    expect(credentials).toEqual({
      server: cluster.endpoint,
      certificateAuthorityData: emulatedEksCaData,
      token: 'eks-sa-token-1',
      expiresAt: s.emu.now() + 3600 * 1000,
    });
    expect(s.kube.routes()).toEqual([
      'POST /api/v1/namespaces',
      'POST /api/v1/namespaces/bc-access/serviceaccounts',
      'GET /apis/rbac.authorization.k8s.io/v1/clusterrolebindings/bc-access:bc-u-alice',
      'POST /apis/rbac.authorization.k8s.io/v1/clusterrolebindings',
      'POST /api/v1/namespaces/bc-access/serviceaccounts/bc-u-alice/token',
    ]);
    // Every call is the account principal, proven by an eksToken for this cluster.
    expect(new Set(s.kube.principals)).toEqual(new Set(['arn:aws:iam::111111111111:role/bc-control-plane']));
    for (const call of s.kube.calls) expect(call.token.startsWith('k8s-aws-v1.')).toBe(true);
    expect(s.kube.bindings.get('bc-access:bc-u-alice')).toMatchObject({
      roleRef: { kind: 'ClusterRole', name: 'edit' },
      subjects: [{ kind: 'ServiceAccount', name: 'bc-u-alice', namespace: 'bc-access' }],
    });
    // The account principal already had its entry (the creator's): nothing was created.
    expect(s.eks.calls('CreateAccessEntry')).toHaveLength(0);
    // An eksToken for another cluster is refused by this one.
    const other = s.kube.calls[0]!.token;
    expect(s.kube.verify(other, 'bc-k-two')).toMatchObject({ refused: expect.stringMatching(/signature/) });
    // No token is logged.
    const logged = s.logs.join('\n');
    expect(logged).not.toContain('eks-sa-token');
    expect(logged).not.toContain('k8s-aws-v1.');
    expect(logged).toContain('eks.credentials');
    // A role change recreates the binding.
    await s.k8s.credentials(id, { subject: 'bc-u-alice', role: 'admin', ttlSeconds: 600 }, s.ctx());
    expect(s.kube.bindings.get('bc-access:bc-u-alice')!.roleRef.name).toBe('cluster-admin');
  });

  it('creates the account principal its access entry on a cluster another principal created', async () => {
    const s = await setup();
    const id = await readyCluster(s);
    s.eks.accessEntries.clear();
    const credentials = await s.k8s.credentials(id, { subject: 'bc-u-bob', role: 'view', ttlSeconds: 600 }, s.ctx());
    expect(credentials.token).toBe('eks-sa-token-1');
    expect(bodyOf(s, 'CreateAccessEntry')).toEqual({
      principalArn: 'arn:aws:iam::111111111111:role/bc-control-plane',
      type: 'STANDARD',
    });
    expect(bodyOf(s, 'AssociateAccessPolicy')).toEqual({
      policyArn: 'arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy',
      accessScope: { type: 'cluster' },
    });
    // Once seen, the entry is not read again by this client.
    const reads = s.eks.calls('DescribeAccessEntry').length;
    await s.k8s.credentials(id, { subject: 'bc-u-bob', role: 'view', ttlSeconds: 600 }, s.ctx());
    expect(s.eks.calls('DescribeAccessEntry')).toHaveLength(reads);
    expect(s.eks.calls('CreateAccessEntry')).toHaveLength(1);
  });

  it('associates the admin policy when the entry lacks it, and retries a fresh entry as UNAVAILABLE', async () => {
    const s = await setup();
    const id = await readyCluster(s);
    const entry = [...s.eks.accessEntries.values()][0]!;
    entry.policies = [];
    await s.k8s.credentials(id, { subject: 'bc-u-carol', role: 'view', ttlSeconds: 600 }, s.ctx());
    expect(s.eks.calls('CreateAccessEntry')).toHaveLength(0);
    expect(s.eks.calls('AssociateAccessPolicy')).toHaveLength(1);

    // A new entry the API server does not honour yet: UNAVAILABLE (try again), not ACCESS_DENIED.
    const t = await setup();
    const tid = await readyCluster(t);
    t.eks.accessEntries.clear();
    t.emu.afterAction('AssociateAccessPolicy', () => {
      for (const value of t.eks.accessEntries.values()) value.policies = [];
    });
    const error = await rejection(t.k8s.credentials(tid, { subject: 'bc-u-dan', role: 'view', ttlSeconds: 600 }, t.ctx()));
    expect(isComputeError(error, 'UNAVAILABLE')).toBe(true);
  });

  it('refuses an aws-auth-only cluster, a cluster not ready, and malformed requests', async () => {
    const s = await setup();
    const id = await readyCluster(s);
    for (const request of [
      { subject: 'Bob', role: 'view', ttlSeconds: 3600 },
      { subject: 'bc-u-bob', role: 'owner', ttlSeconds: 3600 },
      { subject: 'bc-u-bob', role: 'view', ttlSeconds: 599 },
      { subject: 'bc-u-bob', role: 'view', ttlSeconds: 86_401 },
    ]) {
      const error = await rejection(s.k8s.credentials(id, request as never, s.ctx()));
      expect(isComputeError(error, 'INVALID_INPUT')).toBe(true);
    }
    s.eks.clusters.get('bc-k-one')!.authenticationMode = 'CONFIG_MAP';
    const configMap = await rejection(s.k8s.credentials(id, { subject: 'bc-u-bob', role: 'view', ttlSeconds: 600 }, s.ctx()));
    expect(isComputeError(configMap, 'INVALID_STATE')).toBe(true);
    expect((configMap as Error).message).toMatch(/aws-auth/);
    const missing = await rejection(
      s.k8s.credentials('us-east-1/bc-k-none', { subject: 'bc-u-bob', role: 'view', ttlSeconds: 600 }, s.ctx()),
    );
    expect(isComputeError(missing, 'NOT_FOUND')).toBe(true);
    expect(s.kube.calls).toHaveLength(0);
    // Kubernetes API failures map.
    s.eks.clusters.get('bc-k-one')!.authenticationMode = 'API';
    s.kube.failWith = 403;
    const denied = await rejection(s.k8s.credentials(id, { subject: 'bc-u-bob', role: 'view', ttlSeconds: 600 }, s.ctx()));
    expect(isComputeError(denied, 'ACCESS_DENIED')).toBe(true);
    s.kube.failWith = undefined;
    s.kube.unreachable = true;
    const down = await rejection(s.k8s.credentials(id, { subject: 'bc-u-bob', role: 'view', ttlSeconds: 600 }, s.ctx()));
    expect(isComputeError(down, 'UNAVAILABLE')).toBe(true);
  });
});

describe('eks versions', () => {
  it('lists standard-support versions per channel, extended adds extended support', async () => {
    const s = await setup();
    s.eks.pageSize = 2;
    expect(await s.k8s.versions(region, s.ctx())).toEqual({
      defaultVersion: '1.33',
      validVersions: ['1.34', '1.33', '1.32', '1.31'],
      channels: {
        rapid: { defaultVersion: '1.33', validVersions: ['1.34', '1.33', '1.32'] },
        regular: { defaultVersion: '1.33', validVersions: ['1.34', '1.33', '1.32'] },
        stable: { defaultVersion: '1.33', validVersions: ['1.34', '1.33', '1.32'] },
        extended: { defaultVersion: '1.33', validVersions: ['1.34', '1.33', '1.32', '1.31'] },
      },
    });
    const error = await rejection(s.k8s.versions('us-west-2', s.ctx()));
    expect(isComputeError(error, 'INVALID_INPUT')).toBe(true);
  });
});

describe('eks IAM policy', () => {
  it('adds the EKS statements only with the EKS roles, scoped to tagged resources and the own access entry', () => {
    expect(iamPolicy().Statement.some((statement) => statement.Sid.startsWith('Eks'))).toBe(false);
    const policy = iamPolicy({
      region,
      account: '111111111111',
      eksClusterRoleArn: clusterRoleArn,
      eksNodeRoleArn: nodeRoleArn,
    });
    const by = (sid: string) => policy.Statement.find((statement) => statement.Sid === sid)!;
    expect(by('EksCreateTagged')).toMatchObject({
      Action: ['eks:CreateCluster', 'eks:CreateNodegroup', 'eks:TagResource'],
      Condition: { StringEquals: { 'aws:RequestTag/better-compute:managed': 'true' } },
    });
    expect(by('EksManageOwned').Condition).toEqual({
      StringEquals: { 'aws:ResourceTag/better-compute:managed': 'true' },
    });
    expect(by('EksManageOwned').Resource).toContain('arn:aws:eks:us-east-1:111111111111:cluster/*');
    expect(by('EksOwnAccessEntry').Condition).toEqual({
      StringEquals: { 'eks:principalArn': '${aws:PrincipalArn}' },
    });
    expect(by('EksAdminPolicyOnly')).toMatchObject({ Effect: 'Deny', Action: 'eks:AssociateAccessPolicy' });
    expect(by('EksClusterScopeOnly')).toMatchObject({ Effect: 'Deny' });
    expect(by('PassEksRoles')).toEqual({
      Sid: 'PassEksRoles',
      Effect: 'Allow',
      Action: 'iam:PassRole',
      Resource: [clusterRoleArn, nodeRoleArn],
      Condition: { StringEquals: { 'iam:PassedToService': 'eks.amazonaws.com' } },
    });
    // No aws-auth: nothing edits ConfigMaps or reads cluster secrets.
    expect(JSON.stringify(policy)).not.toMatch(/ConfigMap|eks:AccessKubernetesApi/);
    expect(() => iamPolicy({ eksClusterRoleArn: 'arn:aws:iam::111111111111:user/x' })).toThrow(/--eks-cluster-role/);
    expect(() => iamPolicy({ partition: 'aws-cn', eksNodeRoleArn: nodeRoleArn })).toThrow(/partition/);
  });
});

describe('eks node instance profile', () => {
  const eksNodes = 'arn:aws:iam::111111111111:instance-profile/eks-nodes';
  it('is its own account field, never the account-wide instanceProfile', async () => {
    await expect(setup({ eksNodeInstanceProfile: eksNodes })).resolves.toBeDefined();
    for (const config of [
      { eksNodeInstanceProfile: 'arn:aws:iam::111111111111:role/eks-node' },
      { instanceProfile: eksNodes, eksNodeInstanceProfile: eksNodes },
    ]) {
      const error = await rejection(setup(config));
      expect(isComputeError(error, 'INVALID_CONFIG'), String(error)).toBe(true);
    }
  });

  it('the IAM policy passes its role to EC2', () => {
    const policy = iamPolicy({ account: '111111111111', eksNodeInstanceProfileArn: eksNodes });
    expect(policy.Statement.find((statement) => statement.Sid === 'PassEksNodeProfile')).toEqual({
      Sid: 'PassEksNodeProfile',
      Effect: 'Allow',
      Action: 'iam:PassRole',
      Resource: 'arn:aws:iam::111111111111:role/eks-nodes',
      Condition: { StringEquals: { 'iam:PassedToService': 'ec2.amazonaws.com' } },
    });
    expect(() => iamPolicy({ eksNodeInstanceProfileArn: 'arn:aws:iam::111111111111:role/x' })).toThrow(
      /--eks-node-instance-profile/,
    );
  });
});

describe('eks cluster discovery (providerAccounts.clusters)', () => {
  it('lists every cluster with the nodeadm settings k8s-join mode eks takes', async () => {
    const s = await setup();
    await readyCluster(s);
    // A cluster better-compute did not create.
    await readyCluster(s, { ...standard, name: 'foreign', labels: {} });
    delete s.eks.clusters.get('foreign')!.tags['better-compute:managed'];
    s.eks.delayTicks = 5;
    await s.k8s.ensureCluster({ ...standard, name: 'bc-k-two' }, s.ctx()); // still creating
    s.eks.pageSize = 1;
    const listed = await s.k8s.listClusters!(s.ctx());
    const one = s.eks.clusters.get('bc-k-one')!;
    expect(listed).toEqual([
      {
        name: 'bc-k-one',
        id: 'us-east-1/bc-k-one',
        location: region,
        state: 'ready',
        version: '1.33',
        endpoint: one.endpoint,
        managed: true,
        eks: {
          name: 'bc-k-one',
          apiServerEndpoint: one.endpoint,
          certificateAuthority: emulatedEksCaData,
          cidr: '172.20.0.0/16',
        },
      },
      { name: 'bc-k-two', id: 'us-east-1/bc-k-two', location: region, state: 'pending', version: '1.33', managed: true },
      expect.objectContaining({ name: 'foreign', managed: false, state: 'ready', eks: expect.any(Object) }),
    ]);
    // What it lists is what provision accepts.
    const { resolveHostConfig, poolHostConfig } = await import('@better-compute/provision');
    await expect(
      resolveHostConfig(poolHostConfig({ kubernetes: { eks: listed[0]!.eks } }), { labels: {} }),
    ).resolves.toMatchObject({ config: { 'k8s-join': { mode: 'eks' } } });
    expect(s.eks.calls('ListClusters').length).toBeGreaterThan(1);
  });
});

describe('eks access entry principal', () => {
  it('is the IAM role of an assumed-role session, with its path when the account names the role', () => {
    const session = 'arn:aws:sts::111111111111:assumed-role/bc-control/bc-session';
    // Without a known role ARN: the role without a path (STS session ARNs drop it).
    expect(principalArnOf(session)).toBe('arn:aws:iam::111111111111:role/bc-control');
    // Access entries take the role ARN with its path: the account's assumeRoleArn names it.
    const pathed = 'arn:aws:iam::111111111111:role/platform/compute/bc-control';
    expect(principalArnOf(session, [pathed])).toBe(pathed);
    // Only a role of the same account, partition and name.
    for (const other of [
      'arn:aws:iam::222222222222:role/platform/bc-control',
      'arn:aws-cn:iam::111111111111:role/platform/bc-control',
      'arn:aws:iam::111111111111:role/platform/bc-control-2',
      'arn:aws:iam::111111111111:user/platform/bc-control',
      'not an arn',
    ])
      expect(principalArnOf(session, [other])).toBe('arn:aws:iam::111111111111:role/bc-control');
    expect(principalArnOf('arn:aws:iam::111111111111:user/ops/alice', [pathed])).toBe(
      'arn:aws:iam::111111111111:user/ops/alice',
    );
    expect(() => principalArnOf('arn:aws:sts::111111111111:federated-user/bob')).toThrow(/IAM role or user/);
  });
});

describe('eks account guards (confused deputy)', () => {
  const tenant = { id: 'pa_tenant', tenantId: 't_acme', platform: false };
  const every = (s: Setup) => [
    () => s.k8s.ensureCluster(standard, s.ctx()),
    () => s.k8s.getCluster('us-east-1/bc-k-one', s.ctx()),
    () => s.k8s.deleteCluster('us-east-1/bc-k-one', s.ctx()),
    () => s.k8s.ensureNodePool('us-east-1/bc-k-one', pool, s.ctx()),
    () => s.k8s.deleteNodePool('us-east-1/bc-k-one', 'general', s.ctx()),
    () => s.k8s.listClusters!(s.ctx()),
    () => s.k8s.versions(region, s.ctx()),
    () =>
      s.k8s.credentials('us-east-1/bc-k-one', { subject: 'alice', role: 'admin', ttlSeconds: 3600 }, s.ctx()),
  ];
  const eksCalls = (s: Setup) =>
    s.emu.requests.filter((request) => request.service === 'eks').length;

  it('refuses an assumeRoleArn in the platform account before any EKS call', async () => {
    const platformRole = `arn:aws:iam::${platformAccount}:role/admin`;
    const s = await setup({ assumeRoleArn: platformRole }, {}, tenant);
    s.emu.sts.roles.set(platformRole, { externalId: 'better-compute:pa_tenant' });
    // The platform account's clusters: the tenant must not see or touch them.
    const platform = await setup();
    await readyCluster(platform);
    s.eks.clusters.set('bc-k-one', platform.eks.clusters.get('bc-k-one')!);
    for (const call of every(s)) {
      const error = await rejection(call());
      expect(isComputeError(error, 'ACCESS_DENIED'), String(error)).toBe(true);
      expect((error as { details?: { reason?: string } }).details?.reason).toBe('platform-account-role');
    }
    expect(eksCalls(s)).toBe(0);
  });

  it('refuses when the assumed identity is another account, before any EKS call', async () => {
    const role = 'arn:aws:iam::333333333333:role/better-compute';
    const s = await setup({ assumeRoleArn: role }, {}, tenant);
    s.emu.sts.roles.set(role, { externalId: 'better-compute:pa_tenant', identityAccount: '444444444444' });
    for (const call of every(s)) {
      const error = await rejection(call());
      expect(isComputeError(error, 'ACCESS_DENIED'), String(error)).toBe(true);
      expect((error as { details?: { reason?: string } }).details?.reason).toBe('assumed-identity-mismatch');
    }
    expect(eksCalls(s)).toBe(0);
  });

  it('a tenant role in its own account reaches EKS', async () => {
    const role = 'arn:aws:iam::333333333333:role/better-compute';
    const s = await setup({ assumeRoleArn: role }, {}, tenant);
    s.emu.sts.roles.set(role, { externalId: 'better-compute:pa_tenant' });
    await expect(s.k8s.listClusters!(s.ctx())).resolves.toEqual([]);
    expect(eksCalls(s)).toBeGreaterThan(0);
  });
});
