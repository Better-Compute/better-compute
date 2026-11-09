import { beforeEach, describe, expect, it } from 'vitest';
import type { CallContext, ProviderKubernetes } from '@better-compute/core';
import { runConformance } from '@better-compute/core/conformance';
import { awsProvider } from '@better-compute/provider-aws';
import { digitaloceanProvider, resetBudgets } from '@better-compute/provider-digitalocean';
import { gcpProvider } from '@better-compute/provider-gcp';
import {
  kubernetesProviderConformanceCases,
  type KubernetesProviderConformanceSubject,
} from '@better-compute/testing';
import { AwsEmulator } from './support/aws-emulator/index.js';
import { Ec2Emulator } from './support/aws-emulator/ec2.js';
import { DoEmulator } from './support/do-emulator/index.js';
import { DoksEmulator } from './support/doks-emulator.js';
import { adminPolicy, EksEmulator } from './support/eks-emulator.js';
import { emulatedCaData, emulatedCaPem, GkeEmulator } from './support/gke-emulator.js';
import { TokenRequestApi } from './support/managed-kube.js';

// The ProviderKubernetes contract the kubernetes module (clusters and pool substrates) relies on, run against the
// three managed Kubernetes drivers over their emulators: GKE (provider-gcp), EKS (provider-aws) and DOKS
// (provider-digitalocean). The cases are provider-neutral; each subject only says what its provider calls a region,
// a CPU machine and a GPU machine.

const platform = { id: 'pacct_platform', tenantId: 'root', platform: true };
type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

function gkeSubject(gke = new GkeEmulator()): KubernetesProviderConformanceSubject {
  gke.operationDelayTicks = 1;
  const kube = new TokenRequestApi({
    authorize: (token) => gke.gce.mintedTokens.includes(token),
    caPem: emulatedCaPem,
    now: Date.now,
  });
  // A cluster the tenant made in its own project: running, with one pool of its own.
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
  } satisfies Json);
  return {
    provider: gcpProvider({ fetch: gke.fetch, kubeTransport: kube.transport }),
    config: { projectId: 'p', zones: ['us-central1-a', 'us-central1-b'] },
    context: {
      account: platform,
      secrets: { resolve: async () => { throw new Error('no secrets'); } },
    },
    location: 'us-central1',
    nodePool: { machineType: 'e2-standard-4', nodeCount: 1 },
    gpuNodePool: { machineType: 'g2-standard-8', nodeCount: 1, accelerators: { type: 'nvidia-l4', count: 1 } },
    missingCluster: 'us-central1/bc-k-none',
    adoptable: 'us-central1/tenant-own',
    accepts: (credentials) => kube.issued.includes(credentials.token),
    can: (credentials, check) => kube.can(credentials.server, credentials.token, check),
    revoke: true,
  };
}

function eksSubject(): KubernetesProviderConformanceSubject {
  const emu = new AwsEmulator();
  const ec2 = new Ec2Emulator(emu);
  for (const [id, zone] of [
    ['subnet-0000000000000000a', 'us-east-1a'],
    ['subnet-0000000000000000b', 'us-east-1b'],
  ] as const)
    ec2.subnets.set(id, { vpcId: 'vpc-0000000000000000a', zone, mapPublicIpOnLaunch: false });
  const eks = new EksEmulator(emu);
  const kube = eks.kubeApi();
  // A cluster the tenant made itself, with an admin access entry for the account's principal.
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
  eks.accessEntries.set('tenant-own|arn:aws:iam::111111111111:role/bc-control-plane', {
    principalArn: 'arn:aws:iam::111111111111:role/bc-control-plane',
    policies: [{ policyArn: adminPolicy, accessScope: { type: 'cluster' } }],
  } as Json);
  return {
    provider: awsProvider({ fetch: emu.fetch, credentials: emu.ambient, kubeTransport: kube.transport }),
    config: {
      region: 'us-east-1',
      zones: ['us-east-1a', 'us-east-1b'],
      eksClusterRoleArn: 'arn:aws:iam::111111111111:role/eks-cluster',
      eksNodeRoleArn: 'arn:aws:iam::111111111111:role/eks-node',
      eksSubnetIds: ['subnet-0000000000000000a', 'subnet-0000000000000000b'],
    },
    context: { account: platform, clock: emu.clock, secrets: { resolve: async () => '' } },
    location: 'us-east-1',
    nodePool: { machineType: 'm7i.large', nodeCount: 1 },
    gpuNodePool: { machineType: 'g6.xlarge', nodeCount: 1, accelerators: { type: 'nvidia-l4', count: 1 } },
    missingCluster: 'us-east-1/bc-k-none',
    adoptable: 'us-east-1/tenant-own',
    accepts: (credentials) => kube.issued.includes(credentials.token),
    can: (credentials, check) => kube.can(credentials.server, credentials.token, check),
    revoke: true,
  };
}

function doksSubject(): KubernetesProviderConformanceSubject {
  // DigitalOcean request budgets are per process: every case starts with a fresh one.
  resetBudgets();
  const doks = new DoksEmulator(new DoEmulator());
  // An adoptable DOKS cluster has DigitalOcean's own GPU device plugins off (DO-D18: the tenant turns them off).
  const own = doks.seedCluster({
    name: 'tenant-own',
    region: 'tor1',
    extra: { nvidia_gpu_device_plugin: { enabled: false }, amd_gpu_device_plugin: { enabled: false } },
  });
  return {
    provider: digitaloceanProvider({ fetch: doks.fetch, kubeTransport: doks.kube.transport }),
    // Spot GPU node pools are a DigitalOcean preview: the account opts in to both.
    config: { token: 'secret://do/t', regions: ['tor1'], allowSpot: true, previews: true },
    context: {
      account: platform,
      secrets: {
        resolve: async (ref: string) => {
          if (ref === 'secret://do/t') return 'do-token';
          throw new Error('no such secret');
        },
      },
    },
    location: 'tor1',
    nodePool: { machineType: 's-2vcpu-4gb', nodeCount: 1 },
    gpuNodePool: { machineType: 'gpu-h100x1-80gb', nodeCount: 1, accelerators: { type: 'nvidia-h100', count: 1 } },
    // A DOKS node pool without autoscaling has at least one node.
    zeroNodes: false,
    missingCluster: '0d0c5000-0000-4000-8000-999999999999',
    adoptable: own.id as string,
    accepts: (credentials) => doks.kube.issued.includes(credentials.token),
    can: (credentials, check) => doks.kube.can(credentials.server, credentials.token, check),
    revoke: true,
  };
}

/** The subject's provider, offering only the newest minor version of each location. */
function singleMinor(subject: KubernetesProviderConformanceSubject): KubernetesProviderConformanceSubject {
  const { provider } = subject;
  return {
    ...subject,
    provider: {
      ...provider,
      async create(config, context) {
        const impl = await provider.create(config, context);
        const k8s = impl.kubernetes!;
        const kubernetes = new Proxy(k8s, {
          get(target, property) {
            if (property === 'versions')
              return async (location: string, call: Parameters<typeof k8s.versions>[1]) => {
                const versions = await target.versions(location, call);
                const minor = /^(\d+\.\d+)/.exec(versions.defaultVersion)![1]!;
                const valid = versions.validVersions.filter((version) => version.startsWith(minor));
                return { ...versions, validVersions: valid };
              };
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        return { ...impl, kubernetes };
      },
    },
  };
}

/** The subject's provider with its kubernetes driver's members replaced by `override` (undefined removes one). */
function withDriver(
  subject: KubernetesProviderConformanceSubject,
  override: (k8s: ProviderKubernetes) => Partial<Record<keyof ProviderKubernetes, unknown>>,
): KubernetesProviderConformanceSubject {
  const { provider } = subject;
  return {
    ...subject,
    provider: {
      ...provider,
      async create(config, context) {
        const impl = await provider.create(config, context);
        const k8s = impl.kubernetes!;
        const replaced = override(k8s);
        const kubernetes = new Proxy(k8s, {
          get(target, property) {
            if (property in replaced) return replaced[property as keyof ProviderKubernetes];
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
          has: (target, property) => (property in replaced ? replaced[property as keyof ProviderKubernetes] !== undefined : property in target),
        });
        return { ...impl, kubernetes };
      },
    },
  };
}

beforeEach(() => resetBudgets());

describe('kubernetesProviderConformanceCases', () => {
  it.each([
    ['GKE (provider-gcp)', gkeSubject],
    ['EKS (provider-aws)', eksSubject],
    ['DOKS (provider-digitalocean)', doksSubject],
  ])('%s passes every case', async (_name, subject) => {
    const report = await runConformance(kubernetesProviderConformanceCases(), subject);
    expect(report.failed.map(({ name, error }) => `${name}: ${String(error)}`)).toEqual([]);
    // Every subject here gives what every case needs: none is skipped.
    expect(report.skipped).toEqual([]);
    expect(report.passed).toHaveLength(kubernetesProviderConformanceCases().length);
  });

  it('reports the cases a subject cannot run as skipped with a reason, never as passed', async () => {
    const roles = 'a credential carries its role: view only reads, edit never reaches bc-access or kube-system';
    const revoke = 'revokeCredentials removes the access of a subject only, and is idempotent';
    const report = await runConformance(kubernetesProviderConformanceCases(), () => {
      const { can: _can, revoke: _revoke, missingCluster: _missing, adoptable: _adoptable, ...bare } = gkeSubject();
      return bare;
    });
    expect(report.failed).toEqual([]);
    expect(report.skipped).toEqual([
      { name: roles, reason: 'the subject gives no `can` to check what a credential may do' },
      { name: revoke, reason: 'the subject gives no `can` to check what a credential may do' },
      { name: 'node pool calls on an unknown cluster are NOT_FOUND', reason: 'the subject names no missingCluster' },
      {
        name: 'getCluster reads a cluster better-compute did not create (adopt), and a node pool can be added to it',
        reason: 'the subject names no adoptable cluster',
      },
    ]);
    expect(report.passed).toHaveLength(kubernetesProviderConformanceCases().length - 4);
    for (const { name } of report.skipped) expect(report.passed).not.toContain(name);

    // A driver without revokeCredentials, where the subject does not require it.
    const without = await runConformance(
      kubernetesProviderConformanceCases().filter((test) => test.name === revoke),
      () => ({ ...withDriver(gkeSubject(), () => ({ revokeCredentials: undefined })), revoke: false }),
    );
    expect(without).toEqual({
      passed: [],
      failed: [],
      skipped: [{ name: revoke, reason: 'the driver has no revokeCredentials' }],
    });
  });

  it('fails the revoke case of a subject that requires revoke but cannot check access', async () => {
    const report = await runConformance(kubernetesProviderConformanceCases(), () => {
      const { can: _can, ...blind } = gkeSubject();
      return blind;
    });
    expect(report.failed.map(({ name, error }) => [name, String(error)])).toEqual([
      [
        'revokeCredentials removes the access of a subject only, and is idempotent',
        'ConformanceFailure: a subject with revoke: true gives `can`, or the revoke case checks nothing',
      ],
    ]);
    expect(report.skipped.map(({ name }) => name)).toEqual([
      'a credential carries its role: view only reads, edit never reaches bc-access or kube-system',
    ]);
  });

  it('deletes the cluster of a case that fails before the cluster is ready', async () => {
    const gke = new GkeEmulator();
    // Every cluster the driver makes goes to error: no case ever sees one ready.
    const report = await runConformance(kubernetesProviderConformanceCases(), () => ({
      ...withDriver(gkeSubject(gke), (k8s) => ({
        ensureCluster: async (...args: Parameters<ProviderKubernetes['ensureCluster']>) => ({
          ...(await k8s.ensureCluster(...args)),
          state: 'error' as const,
          message: 'the control plane failed to start',
        }),
      })),
      // GKE refuses a delete while the create runs: time passes between two polls.
      advance: () => gke.finishOperations(),
    }));
    expect(report.failed.length).toBeGreaterThanOrEqual(8);
    for (const { error } of report.failed) expect(String(error)).toMatch(/went error|is pending, not error/);
    // Nothing the cases made is left running (and billed): only the tenant's own cluster remains.
    expect([...gke.clusters.keys()]).toEqual(['us-central1/tenant-own']);
  });

  it('fails a provider whose credentials can do anything (the role cases), and nothing else', async () => {
    const report = await runConformance(kubernetesProviderConformanceCases(), () => ({ ...gkeSubject(), can: () => true }));
    expect(report.failed.map(({ name, error }) => [name, String(error)])).toEqual([
      [
        'a credential carries its role: view only reads, edit never reaches bc-access or kube-system',
        'ConformanceFailure: a view credential cannot create pods',
      ],
      [
        'revokeCredentials removes the access of a subject only, and is idempotent',
        'ConformanceFailure: the credential stops working once its subject is revoked',
      ],
    ]);
  });

  it('fails a driver without revokeCredentials when the subject requires it, and nothing else', async () => {
    const report = await runConformance(kubernetesProviderConformanceCases(), () =>
      withDriver(gkeSubject(), () => ({ revokeCredentials: undefined })),
    );
    expect(report.failed.map(({ name, error }) => [name, String(error)])).toEqual([
      [
        'revokeCredentials removes the access of a subject only, and is idempotent',
        'ConformanceFailure: the driver implements revokeCredentials',
      ],
    ]);
  });

  it("fails a driver whose revokeCredentials takes every subject's access, and nothing else", async () => {
    const report = await runConformance(kubernetesProviderConformanceCases(), () =>
      withDriver(gkeSubject(), (k8s) => ({
        // As if it deleted the whole bc-access namespace.
        revokeCredentials: async (cluster: string, subjectName: string, call: CallContext) => {
          await k8s.revokeCredentials!(cluster, subjectName, call);
          await k8s.revokeCredentials!(cluster, 'bc-conf-keep', call);
        },
      })),
    );
    expect(report.failed.map(({ name, error }) => [name, String(error)])).toEqual([
      [
        'revokeCredentials removes the access of a subject only, and is idempotent',
        "ConformanceFailure: another subject's credential still works once one subject is revoked",
      ],
    ]);
  });

  it('fails the upgrade case of a location with one minor version unless the subject opts out', async () => {
    const one = await runConformance(
      kubernetesProviderConformanceCases().filter((test) => test.name.startsWith('raising the version')),
      () => singleMinor(gkeSubject()),
    );
    expect(one.failed.map(({ error }) => String(error))).toEqual([
      expect.stringMatching(/offers 1 minor version\(s\): an upgrade needs two/),
    ]);
    const skipped = await runConformance(
      kubernetesProviderConformanceCases().filter((test) => test.name.startsWith('raising the version')),
      () => ({ ...singleMinor(gkeSubject()), upgrade: false }),
    );
    expect(skipped.failed).toEqual([]);
    expect(skipped.passed).toEqual([]);
    expect(skipped.skipped).toEqual([
      {
        name: 'raising the version upgrades the control plane in place (outputs.version runs it)',
        reason: 'us-central1 offers one minor version and the subject sets upgrade: false',
      },
    ]);
  });

  it('fails a provider whose cluster refuses the credential it minted, and nothing else', async () => {
    const report = await runConformance(kubernetesProviderConformanceCases(), () => ({
      ...gkeSubject(),
      accepts: () => false,
    }));
    expect(report.failed.map(({ name, error }) => [name, String(error)])).toEqual([
      [
        "credentials mint a bound token for the cluster's endpoint, and outputs never carry one",
        "ConformanceFailure: the cluster's API accepts the credential",
      ],
    ]);
  });
});
