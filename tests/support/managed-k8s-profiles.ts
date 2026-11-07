import { systemClock, type ProviderDefinition } from '@better-compute/core';
import { awsProvider } from '@better-compute/provider-aws';
import { digitaloceanProvider, resetBudgets } from '@better-compute/provider-digitalocean';
import { gcpProvider } from '@better-compute/provider-gcp';
import { AwsEmulator, platformKeys } from './aws-emulator/index.js';
import { Ec2Emulator } from './aws-emulator/ec2.js';
import { DoEmulator } from './do-emulator/index.js';
import { DoksEmulator } from './doks-emulator.js';
import { adminPolicy, EksEmulator } from './eks-emulator.js';
import type { FakeKubeNode } from './fake-kube-api.js';
import { emulatedCaData, emulatedCaPem, GkeEmulator } from './gke-emulator.js';
import { TokenRequestApi } from './managed-kube.js';

// One managed Kubernetes provider as the multicloud fleet pool tests see it: the real driver over its emulator, the
// account's config and vocabulary (region, an 8-GPU H100 machine type and its accelerator name), the Kubernetes Nodes
// each cluster runs now (derived from the emulator's node pools, as the cloud's node controller would), whether a
// token is one the driver minted (so the substrate's cluster API trusts exactly those), and the provider-side view the
// no-orphans checks read. Everything else in the tests is the same for every provider.

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface ManagedKubernetesProfile {
  /** `GKE`, `EKS`, `DOKS`. */
  label: string;
  /** The provider id (`gcp`, `aws`, `digitalocean`). */
  provider: string;
  providers: ProviderDefinition[];
  /** The site's region and the cluster location. */
  region: string;
  /**
   * Zones a node pool spans with this account: a flavor's `nodes` are per zone (GKE: the pool's zones, here the
   * account's one; EKS: the Availability Zones of the account's subnets; DOKS: none, so 1).
   */
  zones: number;
  /** An 8 x H100 node, as this provider names it. */
  flavor: { machineType: string; gpus: { type: string; count: number } };
  /** The FleetConfig providerAccount config; `putSecret` stores a secret and returns its `secret://` ref. */
  accountConfig(putSecret: (name: string, value: string) => Promise<string>): Promise<Record<string, unknown>>;
  /** The Kubernetes Nodes of the cluster whose API is at this origin, now. */
  nodes(server: string): FakeKubeNode[];
  /** A bearer token the driver minted through the cluster's TokenRequest API. */
  accepts(token: string): boolean;
  /** Provider ids of the clusters that exist (any state). */
  clusters(): string[];
  /** Node pool names of a cluster, by provider id. */
  nodePools(cluster: string): string[];
  /** A running cluster the tenant made itself (one node pool of its own); returns its provider id. */
  seedCluster(): string;
  /** Secrets the provider side holds (account tokens): never in a row, an event or a log line. */
  secrets(): string[];
  /**
   * The access objects credentials left in the cluster whose API is at this origin: subject namespaces, service
   * accounts and the bindings that name them (`Kind/name`, kube-access.ts subjectObjects).
   */
  accessObjects(server: string): string[];
}

const origin = (url: string) => new URL(url).origin;

export function gkeProfile(): ManagedKubernetesProfile {
  const gke = new GkeEmulator();
  gke.operationDelayTicks = 0;
  const api = new TokenRequestApi({
    authorize: (token) => gke.gce.mintedTokens.includes(token),
    caPem: emulatedCaPem,
    now: Date.now,
  });
  return {
    label: 'GKE',
    provider: 'gcp',
    providers: [gcpProvider({ fetch: gke.fetch, kubeTransport: api.transport })],
    region: 'us-central1',
    zones: 1,
    flavor: { machineType: 'a3-highgpu-8g', gpus: { type: 'nvidia-h100-80gb', count: 8 } },
    accountConfig: async () => ({ projectId: 'p', zones: ['us-central1-a'] }),
    nodes(server) {
      const nodes: FakeKubeNode[] = [];
      for (const cluster of gke.clusters.values() as Iterable<Json>) {
        if (!cluster.endpoint || origin(`https://${cluster.endpoint}`) !== server) continue;
        for (const pool of cluster.nodePools ?? []) {
          if (pool.status !== 'RUNNING' && pool.status !== 'RECONCILING') continue;
          for (const url of (pool.instanceGroupUrls as string[] | undefined) ?? []) {
            const [, zone, group] = /\/zones\/([^/]+)\/instanceGroupManagers\/([^/]+)$/.exec(url)!;
            const size = gke.instanceGroupSizes.get(`${zone}/${group}`) ?? 0;
            for (let i = 0; i < size; i++)
              nodes.push({ name: `gke-${cluster.name}-${pool.name}-${zone!.slice(-1)}${i}`, labels: { ...(pool.config?.labels ?? {}) } });
          }
        }
      }
      return nodes;
    },
    accepts: (token) => api.issued.includes(token),
    clusters: () => [...gke.clusters.keys()],
    nodePools: (cluster) => ((gke.clusters.get(cluster)?.nodePools ?? []) as Json[]).map((pool) => pool.name as string),
    seedCluster() {
      gke.clusters.set('us-central1/tenant-own', {
        name: 'tenant-own',
        location: 'us-central1',
        status: 'RUNNING',
        endpoint: '34.118.0.99',
        masterAuth: { clusterCaCertificate: emulatedCaData },
        currentMasterVersion: '1.33.5-gke.1000',
        currentNodeVersion: '1.33.5-gke.1000',
        releaseChannel: { channel: 'REGULAR' },
        network: 'default',
        subnetwork: 'default',
        nodePools: [{ name: 'default', status: 'RUNNING', initialNodeCount: 1, config: { machineType: 'e2-standard-4' } }],
      });
      return 'us-central1/tenant-own';
    },
    secrets: () => [...gke.gce.mintedTokens],
    accessObjects: (server) => api.clusters.find(server)?.subjectObjects() ?? [],
  };
}

export function eksProfile(): ManagedKubernetesProfile {
  const emu = new AwsEmulator();
  // The control plane signs with the wall clock (a dev stack): the emulator checks SigV4 and token ages by it too.
  emu.follow(systemClock);
  const ec2 = new Ec2Emulator(emu);
  for (const [id, zone] of [
    ['subnet-0000000000000000a', 'us-east-1a'],
    ['subnet-0000000000000000b', 'us-east-1b'],
  ] as const)
    ec2.subnets.set(id, { vpcId: 'vpc-0000000000000000a', zone, mapPublicIpOnLaunch: false });
  const eks = new EksEmulator(emu);
  eks.delayTicks = 0;
  const kube = eks.kubeApi();
  const providerId = (name: string) => `us-east-1/${name}`;
  return {
    label: 'EKS',
    provider: 'aws',
    providers: [awsProvider({ fetch: emu.fetch, credentials: emu.ambient, kubeTransport: kube.transport })],
    region: 'us-east-1',
    zones: 2,
    flavor: { machineType: 'p5.48xlarge', gpus: { type: 'nvidia-h100', count: 8 } },
    accountConfig: async () => ({
      region: 'us-east-1',
      zones: ['us-east-1a', 'us-east-1b'],
      eksClusterRoleArn: 'arn:aws:iam::111111111111:role/eks-cluster',
      eksNodeRoleArn: 'arn:aws:iam::111111111111:role/eks-node',
      eksSubnetIds: ['subnet-0000000000000000a', 'subnet-0000000000000000b'],
    }),
    nodes(server) {
      const nodes: FakeKubeNode[] = [];
      const groups = [...eks.nodegroups.values()];
      for (const cluster of eks.clusters.values()) {
        if (cluster.status === 'CREATING' || origin(cluster.endpoint) !== server) continue;
        for (const group of groups) {
          if (group.cluster !== cluster.name || !['ACTIVE', 'UPDATING'].includes(group.status)) continue;
          // EKS Node names are the instances' private DNS names.
          const subnet = groups.indexOf(group) + 1;
          for (let i = 0; i < group.scalingConfig.desiredSize; i++)
            nodes.push({ name: `ip-10-0-${subnet}-${i + 10}.ec2.internal`, labels: { ...group.labels } });
        }
      }
      return nodes;
    },
    accepts: (token) => kube.issued.includes(token),
    clusters: () => [...eks.clusters.keys()].map(providerId),
    nodePools: (cluster) =>
      [...eks.nodegroups.values()]
        .filter((group) => providerId(group.cluster) === cluster)
        .map((group) => group.nodegroupName),
    seedCluster() {
      eks.clusters.set('tenant-own', {
        name: 'tenant-own',
        arn: `arn:aws:eks:us-east-1:${eks.account}:cluster/tenant-own`,
        version: '1.33',
        platformVersion: 'eks.1',
        status: 'ACTIVE',
        endpoint: 'https://tenantown.gr7.us-east-1.eks.amazonaws.com',
        roleArn: 'arn:aws:iam::111111111111:role/eks-cluster',
        subnetIds: ['subnet-0000000000000000a', 'subnet-0000000000000000b'],
        vpcId: 'vpc-0000000000000000a',
        publicAccessCidrs: ['0.0.0.0/0'],
        endpointPublicAccess: true,
        endpointPrivateAccess: true,
        serviceIpv4Cidr: '172.20.0.0/16',
        authenticationMode: 'API',
        supportType: 'STANDARD',
        tags: {},
        remaining: 0,
      });
      // The tenant granted the account's principal cluster admin (an adopted cluster is never changed for it).
      eks.accessEntries.set('tenant-own|arn:aws:iam::111111111111:role/bc-control-plane', {
        principalArn: 'arn:aws:iam::111111111111:role/bc-control-plane',
        type: 'STANDARD',
        policies: [{ policyArn: adminPolicy, accessScope: { type: 'cluster' } }],
      });
      return providerId('tenant-own');
    },
    // The ambient secret key, any STS-minted keys, and the eksTokens (the account principal's cluster-admin bearers).
    secrets: () => [
      platformKeys.secretAccessKey,
      ...[...emu.sts.identities.values()].flatMap((identity) =>
        identity.sessionToken === undefined ? [identity.secret] : [identity.secret, identity.sessionToken],
      ),
      ...kube.bearers,
    ],
    accessObjects: (server) => kube.clusters.find(server)?.subjectObjects() ?? [],
  };
}

export function doksProfile(): ManagedKubernetesProfile {
  resetBudgets();
  const doks = new DoksEmulator(new DoEmulator());
  doks.transitionReads = 0;
  return {
    label: 'DOKS',
    provider: 'digitalocean',
    providers: [digitaloceanProvider({ fetch: doks.fetch, kubeTransport: doks.kube.transport })],
    region: 'tor1',
    zones: 1,
    flavor: { machineType: 'gpu-h100x8-640gb', gpus: { type: 'nvidia-h100', count: 8 } },
    accountConfig: async (putSecret) => ({ token: await putSecret('doks-account', 'do-token'), regions: ['tor1'] }),
    nodes(server) {
      const nodes: FakeKubeNode[] = [];
      for (const cluster of doks.clusters.values() as Iterable<Json>) {
        if (!cluster.endpoint || origin(cluster.endpoint) !== server) continue;
        for (const pool of cluster.node_pools as Json[])
          for (const node of pool.nodes as Json[])
            if (node.status.state === 'running')
              nodes.push({
                name: node.name,
                labels: { ...(pool.labels ?? {}), 'doks.digitalocean.com/node-pool': pool.name },
              });
      }
      return nodes;
    },
    accepts: (token) => doks.kube.issued.includes(token),
    clusters: () => [...doks.clusters.keys()],
    nodePools: (cluster) => ((doks.clusters.get(cluster)?.node_pools ?? []) as Json[]).map((pool) => pool.name as string),
    // The tenant turned DigitalOcean's own GPU device plugins off (DO-D18), as adopting for a GPU pool needs.
    seedCluster: () =>
      doks.seedCluster({
        name: 'tenant-own',
        region: 'tor1',
        extra: { nvidia_gpu_device_plugin: { enabled: false }, amd_gpu_device_plugin: { enabled: false } },
      }).id as string,
    secrets: () => ['do-token', ...doks.adminTokens.keys()],
    accessObjects: (server) => doks.kube.clusters.find(server)?.subjectObjects() ?? [],
  };
}
