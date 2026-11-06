import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Logger } from '@better-compute/core';
import { kubernetes } from '@better-compute/kubernetes';
import { awsProvider } from '@better-compute/provider-aws';
import { closeFixtures, computeFixture, type ComputeFixture } from '@better-compute/testing';
import { vps } from '@better-compute/vps';
import { AwsEmulator } from './support/aws-emulator/index.js';
import { Ec2Emulator } from './support/aws-emulator/ec2.js';
import { EksEmulator, type EksKubeApi } from './support/eks-emulator.js';

// The kubernetes module on an AWS account, exactly as on GKE: a root (platform) AWS account in
// us-east-1 backs a provider pool offered to acme; acme creates an EKS cluster (managed node groups,
// a GPU Spot pool), connects with a short-lived kubeconfig, resizes and deletes it, and an
// autopilot cluster is EKS Auto Mode. The real provider-aws against the AWS and EKS emulators.

type Api = any; // eslint-disable-line @typescript-eslint/no-explicit-any

let emu: AwsEmulator;
let eks: EksEmulator;
let kube: EksKubeApi;
let fixture: ComputeFixture;
let api: Api;
let acme: { token: string };
let acmeTenant: string;
let poolId: string;
let accountId: string;
let rootTenant: string;
let rootCaller: { token: string };
const logs: string[] = [];

const tick = async (rounds = 1) => {
  for (let round = 0; round < rounds; round++) {
    await fixture.advance(10_000);
    await fixture.compute.jobs['kubernetes.clusters']!.tick();
  }
};
const until = async (done: () => Promise<boolean>, limit = 16) => {
  for (let round = 1; round <= limit; round++) {
    await tick();
    if (await done()) return round;
  }
  throw new Error(`not settled after ${limit} rounds`);
};
const get = (clusterId: string) => api.kubernetesClusters.get(acme, { tenantId: acmeTenant, clusterId });

beforeAll(async () => {
  emu = new AwsEmulator();
  const ec2 = new Ec2Emulator(emu);
  for (const [id, zone] of [
    ['subnet-0000000000000000a', 'us-east-1a'],
    ['subnet-0000000000000000b', 'us-east-1b'],
  ] as const)
    ec2.subnets.set(id, { vpcId: 'vpc-0000000000000000a', zone, mapPublicIpOnLaunch: false });
  eks = new EksEmulator(emu);
  kube = eks.kubeApi();
  const aws = awsProvider({ fetch: emu.fetch, credentials: emu.ambient, kubeTransport: kube.transport });
  const log: Logger = {
    debug: (message, fields) => void logs.push(JSON.stringify({ message, fields })),
    info: (message, fields) => void logs.push(JSON.stringify({ message, fields })),
    warn: (message, fields) => void logs.push(JSON.stringify({ message, fields })),
    error: (message, fields) => void logs.push(JSON.stringify({ message, fields })),
  };
  fixture = await computeFixture({
    clock: 'sim',
    log,
    modules: [vps({ providers: [aws] }), kubernetes({ providers: [aws] })],
  });
  emu.follow(fixture.clock);
  const { compute, tenants, iam } = fixture;
  (iam as { rootTenantId?: string }).rootTenantId = tenants.root.id;
  iam.allow({ token: tenants.root.token });
  iam.allow({ token: tenants.acme.token });
  api = compute.api as Api;
  const root = { token: tenants.root.token };
  acme = { token: tenants.acme.token };
  acmeTenant = tenants.acme.id;
  const account = await api.providerAccounts.create(root, {
    tenantId: tenants.root.id,
    provider: 'aws',
    name: 'aws-use1',
    config: {
      region: 'us-east-1',
      zones: ['us-east-1a', 'us-east-1b'],
      eksClusterRoleArn: 'arn:aws:iam::111111111111:role/eks-cluster',
      eksNodeRoleArn: 'arn:aws:iam::111111111111:role/eks-node',
      eksSubnetIds: ['subnet-0000000000000000a', 'subnet-0000000000000000b'],
    },
  });
  const site = await api.sites.create(root, {
    tenantId: tenants.root.id,
    kind: 'shared',
    region: 'us-east-1',
    idempotencyKey: 'aws-site',
  });
  const pool = await api.pools.create(root, {
    tenantId: tenants.root.id,
    siteId: site.id,
    class: 'provider',
    providerAccountId: account.id,
    idempotencyKey: 'aws-pool',
  });
  poolId = pool.id;
  accountId = account.id;
  rootTenant = tenants.root.id;
  rootCaller = root;
  await api.pools.offer(root, {
    tenantId: tenants.root.id,
    poolId,
    toTenantId: acmeTenant,
    quota: { vcpu: 64, memoryGiB: 256, diskGiB: 1000, gpu: 4 },
  });
});
afterAll(closeFixtures);

describe('the kubernetes module on EKS', () => {
  it('creates, connects to, resizes and deletes a cluster with managed node groups', async () => {
    const created = await api.kubernetesClusters.create(acme, {
      tenantId: acmeTenant,
      poolId,
      name: 'training',
      mode: 'standard',
      location: 'us-east-1',
      authorizedNetworks: ['203.0.113.0/24'],
      nodePools: [
        { name: 'system', machineType: 'm7i.large', nodeCount: 1 },
        {
          name: 'gpu',
          machineType: 'g6.xlarge',
          nodeCount: 0,
          autoscaling: { minNodes: 0, maxNodes: 2 },
          accelerators: { type: 'nvidia-l4', count: 1 },
          spot: true,
          zones: ['us-east-1a'],
        },
      ],
      idempotencyKey: 'training-1',
    });
    expect(created).toMatchObject({ location: 'us-east-1', region: 'us-east-1', state: 'pending' });
    await until(async () => (await get(created.id)).state === 'ready');
    const cluster = eks.clusters.get(created.providerName)!;
    expect(cluster).toMatchObject({ status: 'ACTIVE', authenticationMode: 'API', publicAccessCidrs: ['203.0.113.0/24'] });
    expect(cluster.tags['better-compute:managed']).toBe('true');
    const view = await get(created.id);
    expect(view).toMatchObject({ endpoint: cluster.endpoint, state: 'ready' });
    expect(view.nodePools.map((pool: { state: string }) => pool.state)).toEqual(['ready', 'ready']);
    const gpu = eks.nodegroups.get(`${created.providerName}/gpu`)!;
    expect(gpu).toMatchObject({
      amiType: 'AL2023_x86_64_NVIDIA',
      capacityType: 'SPOT',
      subnets: ['subnet-0000000000000000a'],
      scalingConfig: { minSize: 0, maxSize: 2, desiredSize: 0 },
    });
    expect(gpu.taints).toContainEqual({ key: 'nvidia.com/gpu', effect: 'NO_SCHEDULE' });

    // A short-lived kubeconfig for acme's caller, minted through the access entry and an eksToken.
    const issued = await api.kubernetesClusters.credentials(acme, {
      tenantId: acmeTenant,
      clusterId: created.id,
    });
    expect(issued.kubeconfig).toContain(JSON.stringify(cluster.endpoint));
    expect(issued.kubeconfig).toMatch(/token: "eks-sa-token-\d+"/);
    expect(kube.principals.length).toBeGreaterThan(0);
    expect([...kube.bindings.values()][0]).toMatchObject({ roleRef: { name: 'view' } });
    // No token reached a log line.
    const logged = logs.join('\n');
    expect(logged).not.toMatch(/eks-sa-token|k8s-aws-v1\./);

    // Resize the CPU pool: per zone, so two zones make four nodes.
    const system = view.nodePools.find((pool: { name: string }) => pool.name === 'system');
    await api.kubernetesNodePools.update(acme, {
      tenantId: acmeTenant,
      clusterId: created.id,
      nodePoolId: system.id,
      nodeCount: 2,
    });
    await until(async () => eks.nodegroups.get(`${created.providerName}/system`)!.scalingConfig.desiredSize === 4);

    // Delete: the node groups go first, then the cluster.
    await api.kubernetesClusters.delete(acme, { tenantId: acmeTenant, clusterId: created.id });
    await until(async () => !eks.clusters.has(created.providerName), 24);
    expect(eks.calls('DeleteNodegroup').length).toBe(2);
  });

  it('runs autopilot as EKS Auto Mode', async () => {
    const created = await api.kubernetesClusters.create(acme, {
      tenantId: acmeTenant,
      poolId,
      name: 'auto',
      mode: 'autopilot',
      location: 'us-east-1',
      idempotencyKey: 'auto-1',
    });
    await until(async () => (await get(created.id)).state === 'ready');
    expect(eks.clusters.get(created.providerName)!.computeConfig).toMatchObject({ enabled: true });
    const versions = await api.kubernetesClusters.versions(acme, {
      tenantId: acmeTenant,
      poolId,
      location: 'us-east-1',
    });
    expect(versions.defaultVersion).toBe('1.33');
  });
});

describe('providerAccounts.clusters on an AWS account', () => {
  it('lists the account clusters with the nodeadm settings k8s-join mode eks takes', async () => {
    const before = eks.calls('ListClusters').length;
    const { items } = await api.providerAccounts.clusters(rootCaller, { tenantId: rootTenant, accountId });
    expect(eks.calls('ListClusters').length).toBeGreaterThan(before);
    // The autopilot cluster of the test above (EKS Auto Mode) is still there.
    const auto = items.find(
      (item: { name: string }) => eks.clusters.get(item.name)?.computeConfig?.enabled === true,
    );
    expect(auto).toBeDefined();
    const cluster = eks.clusters.get(auto.name)!;
    expect(auto).toMatchObject({
      managed: true,
      state: 'ready',
      location: 'us-east-1',
      eks: { name: auto.name, apiServerEndpoint: cluster.endpoint, cidr: expect.any(String) },
    });
    // Plain values only: no token, kubeconfig or secret in what it returns.
    expect(JSON.stringify(items)).not.toMatch(/k8s-aws-v1|token|secret/i);
  });

  it('is the account owner read: another tenant cannot list them', async () => {
    await expect(
      api.providerAccounts.clusters(acme, { tenantId: rootTenant, accountId }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/ACCESS_DENIED|NOT_FOUND|UNAUTHENTICATED/) });
    await expect(
      api.providerAccounts.clusters(rootCaller, { tenantId: rootTenant, accountId, extra: 1 }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
